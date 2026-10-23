-- CAPITAL-MOVEMENT WORKFLOW: manual MEXC balance check, deposit admission, withdrawal and payout lifecycle, queueing while trades are open.
-- Run after 20261105000000_hwm_arrival_lockup.sql (it relies on arrived-only waiting money). NOT applied to any database yet. Safe to run twice.
--
-- What this adds (all additive; no accounting formula is changed or re-implemented here):
--   1. balance_verifications: the manager TYPES the MEXC total (entered), then separately CONFIRMS it (confirmed). Nothing is overwritten:
--      a wrong entry is superseded or rejected and stays in the table. Confirming records a fact; it never moves the unit price, never issues
--      units and never labels the difference as trading profit. Anything the app cannot explain is a "residual" the manager must explain
--      (adjustments) or explicitly classify before money moves.
--   2. Deposit admission is its own action (admin_admit_deposit). Withdrawal is request -> approved -> redeemed -> payout awaiting / sent /
--      completed (or failed, retried). Quarter close is admin_settle_quarter. All three need a fresh, confirmed, flat, reconciled balance check.
--   3. A guard trigger (workflow_gate = 'on') stops the old direct paths from writing deposits, withdrawals or closes without that check.
--   4. Every step writes capital_events (append-only) and the activity log. position_snapshots keep the last authoritative per-investor values
--      at each verified event, so the investor page can tell a verified estimate from a finalized settlement.
--
-- Contract with the accounting engine (Agent 1). Only these are called; none is reimplemented:
--   _price_from(balance), _net_equity(balance), _convert_pending(id, price, at, actor), _check_move(net, confirm), _check_books(),
--   _price_now(), _total_units(), _units_of(p), _holder_summary(p), _pending_total(), _check_min_withdrawal(...), _at(ts), _last_php_rate(),
--   admin_withdraw(...), admin_withdraw_to_manager(...), admin_close_quarter(...), admin_post_equity(...), _ledger_lock(), _idem_get/_idem_put,
--   _audit(...), and the settings lock_enforced, settlement_gate, recon_tolerance_abs, recon_tolerance_pct, snapshot_max_age_hours.
--   The "adapter" functions (_acct_*) below are the only place that touches them in more than one line: repoint those if the engine changes.

-- ---------------------------------------------------------------- 0. preflight
do $$
begin
  if to_regclass('public.investor_hwm') is null then
    raise exception 'preflight: run 20261105000000_hwm_arrival_lockup.sql first (this workflow relies on arrived-only waiting money). Nothing was changed.';
  end if;
  if to_regprocedure('public._convert_pending(bigint,numeric,timestamptz,uuid)') is null or to_regprocedure('public._price_from(numeric)') is null
     or to_regprocedure('public._holder_summary(uuid)') is null then
    raise exception 'preflight: the accounting functions this workflow calls are missing. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. settings
insert into public.ledger_settings(key, value) values
  ('workflow_gate', 'off'),            -- 'on' = deposits, withdrawals and closes are only possible through this workflow
  ('verify_max_age_hours', '12'),      -- a confirmed balance check may be used for this many hours
  ('queue_escalate_hours', '72'),      -- a queued request older than this is flagged for escalation
  ('estimate_basis', 'verified')       -- 'verified' = investors see their value as the main figure only after a verified valuation; 'any' = always
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 2. tables
create table if not exists public.balance_verifications (
  id                bigserial primary key,
  entered_at        timestamptz not null default now(),
  entered_by        uuid not null references public.profiles(id),
  mexc_total        numeric not null check (mexc_total > 0),               -- what the manager read on MEXC
  open_positions    int not null check (open_positions between 0 and 2),   -- the bot can hold two coins at once
  open_orders       int not null default 0 check (open_orders >= 0),
  flat              boolean not null,                                      -- no open position or order, by the manager AND any fresh bot snapshot
  note              text,
  -- the reconciliation context, frozen at entry
  prev_id           bigint references public.balance_verifications(id),
  prev_total        numeric,
  prev_source       text check (prev_source in ('verification', 'ledger')),
  cum_in            numeric not null,           -- all money marked as arrived in MEXC so far
  cum_out           numeric not null,           -- all payouts marked as sent from MEXC so far
  prev_cum_in       numeric,
  prev_cum_out      numeric,
  known_in          numeric not null default 0, -- arrived since the previous check
  known_out         numeric not null default 0, -- sent since the previous check
  waiting_arrived   numeric,                    -- deposits in MEXC, not yet units
  waiting_not_arrived numeric,                  -- deposits reported but not in MEXC (not in this balance)
  open_requests_units numeric,
  snapshot_id       bigint references public.exchange_snapshots(id),
  expected_total    numeric,
  variance          numeric,                    -- entered - expected, before any explanation
  status            text not null default 'entered' check (status in ('entered', 'confirmed', 'superseded', 'rejected')),
  confirmed_at      timestamptz,
  confirmed_by      uuid references public.profiles(id),
  status_note       text,
  status_changed_at timestamptz,
  first_used_at     timestamptz,                -- once a deposit, payout or settlement used it, it can no longer be adjusted
  spent_at          timestamptz                 -- a payout used it: the MEXC balance changed, so a new check is needed
);
create table if not exists public.verification_adjustments (
  id              bigserial primary key,
  verification_id bigint not null references public.balance_verifications(id),
  ts              timestamptz not null default now(),
  created_by      uuid not null references public.profiles(id),
  kind            text not null check (kind in ('trading_pnl', 'fees', 'funding', 'transfer', 'timing', 'other')),
  amount          numeric not null check (amount <> 0),
  note            text not null check (length(trim(note)) >= 10),
  classified      boolean not null default false     -- true = the manager used "classify the rest" instead of typing the figure
);
create table if not exists public.capital_events (
  id              bigserial primary key,
  ts              timestamptz not null default now(),
  actor           uuid,
  subject_type    text not null check (subject_type in ('verification', 'deposit', 'withdrawal', 'payout', 'valuation', 'settlement')),
  subject_id      bigint,
  event           text not null,
  detail          jsonb not null default '{}'::jsonb,
  equity_id       bigint,
  verification_id bigint
);
create index if not exists capital_events_equity_idx on public.capital_events(equity_id);
create index if not exists capital_events_subject_idx on public.capital_events(subject_type, subject_id);
create table if not exists public.payout_records (
  id             bigserial primary key,
  request_id     bigint not null unique references public.withdrawal_requests(id),
  profile_id     uuid not null references public.profiles(id),
  ledger_id      bigint,
  equity_id      bigint,
  amount_usdt    numeric not null,
  php_rate       numeric,
  leaves_mexc    boolean not null,              -- false = the manager pays from their own pocket (withdraw_to_manager): nothing leaves MEXC
  status         text not null default 'awaiting' check (status in ('awaiting', 'sent', 'completed', 'failed', 'voided')),
  reference      text,
  failure_reason text,
  attempts       int not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  sent_at        timestamptz,
  completed_at   timestamptz,
  failed_at      timestamptz,
  status_note    text
);
create table if not exists public.position_snapshots (
  id              bigserial primary key,
  ts              timestamptz not null default now(),
  equity_id       bigint not null,
  verification_id bigint,
  event           text not null,
  profile_id      uuid not null references public.profiles(id),
  units           numeric,
  unit_price      numeric,
  value_usdt      numeric,
  value_after_fee_usdt numeric,
  accrued_fee_usdt numeric,
  summary         jsonb not null               -- the engine's own summary for that person at that moment, stored as is
);
create index if not exists position_snapshots_profile_idx on public.position_snapshots(profile_id, id desc);

alter table public.pending_deposits add column if not exists arrival_confirmed_by uuid;
alter table public.pending_deposits add column if not exists arrival_note text;
alter table public.pending_deposits add column if not exists admitted_at timestamptz;
alter table public.pending_deposits add column if not exists admitted_by uuid;
alter table public.pending_deposits add column if not exists admit_verification_id bigint;
alter table public.pending_deposits add column if not exists escalated_at timestamptz;
alter table public.pending_deposits add column if not exists escalation_note text;

alter table public.withdrawal_requests add column if not exists stage text;
update public.withdrawal_requests set stage = case status when 'paid' then 'redeemed' when 'cancelled' then 'cancelled' else 'requested' end where stage is null;
alter table public.withdrawal_requests alter column stage set default 'requested';
alter table public.withdrawal_requests alter column stage set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'withdrawal_requests_stage_check') then
    alter table public.withdrawal_requests add constraint withdrawal_requests_stage_check check (stage in ('requested', 'approved', 'redeemed', 'rejected', 'cancelled'));
  end if;
end $$;
alter table public.withdrawal_requests add column if not exists approved_by uuid;
alter table public.withdrawal_requests add column if not exists approved_at timestamptz;
alter table public.withdrawal_requests add column if not exists approval_note text;
alter table public.withdrawal_requests add column if not exists lock_exception boolean not null default false;
alter table public.withdrawal_requests add column if not exists lock_exception_reason text;
alter table public.withdrawal_requests add column if not exists lock_exception_by uuid;
alter table public.withdrawal_requests add column if not exists lock_exception_at timestamptz;
alter table public.withdrawal_requests add column if not exists rejected_reason text;
alter table public.withdrawal_requests add column if not exists redemption_verification_id bigint;
alter table public.withdrawal_requests add column if not exists escalated_at timestamptz;
alter table public.withdrawal_requests add column if not exists escalation_note text;

do $$
declare t text;
begin
  foreach t in array array['balance_verifications', 'verification_adjustments', 'capital_events', 'payout_records', 'position_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
  foreach t in array array['verification_adjustments', 'capital_events', 'position_snapshots'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._no_change()', t || '_append_only', t);
  end loop;
end $$;
revoke all on sequence public.balance_verifications_id_seq, public.verification_adjustments_id_seq, public.capital_events_id_seq,
  public.payout_records_id_seq, public.position_snapshots_id_seq from public, anon, authenticated;

-- a balance check is history: only its status fields may change, and only forward
create or replace function public._wf_verification_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'balance checks are history and cannot be deleted'; end if;
  if (to_jsonb(new) - 'status' - 'confirmed_at' - 'confirmed_by' - 'status_note' - 'status_changed_at' - 'first_used_at' - 'spent_at')
     is distinct from (to_jsonb(old) - 'status' - 'confirmed_at' - 'confirmed_by' - 'status_note' - 'status_changed_at' - 'first_used_at' - 'spent_at') then
    raise exception 'a recorded balance check cannot be edited; enter a new one';
  end if;
  if new.status is distinct from old.status and not (old.status = 'entered' and new.status in ('confirmed', 'superseded', 'rejected')) then
    raise exception 'a balance check that is % cannot become %', old.status, new.status;
  end if;
  if old.first_used_at is not null and new.first_used_at is distinct from old.first_used_at then raise exception 'first use is already recorded'; end if;
  return new;
end $$;
drop trigger if exists balance_verifications_guard on public.balance_verifications;
create trigger balance_verifications_guard before update or delete on public.balance_verifications for each row execute function public._wf_verification_guard();

-- ---------------------------------------------------------------- 3. small helpers
create or replace function public._wf_setnum(k text, d numeric) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(nullif(_setting(k), '')::numeric, d)
$$;
create or replace function public._wf_tol(p_total numeric) returns numeric language sql stable security definer set search_path = public as $$
  select greatest(_wf_setnum('recon_tolerance_abs', 0.5), coalesce(p_total, 0) * _wf_setnum('recon_tolerance_pct', 0.0005))
$$;
create or replace function public._wf_cum_in() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(usdt), 0) from pending_deposits where arrived_at is not null and status <> 'cancelled'
$$;
create or replace function public._wf_cum_out() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_usdt), 0) from payout_records where leaves_mexc and status in ('sent', 'completed')
$$;
create or replace function public._wf_residual(p_vid bigint) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(v.variance, 0) - coalesce((select sum(amount) from verification_adjustments where verification_id = v.id), 0)
    from balance_verifications v where v.id = p_vid
$$;
create or replace function public._wf_name(p uuid) returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(name, ''), username) from profiles where id = p
$$;

create or replace function public._wf_event(p_actor uuid, p_type text, p_id bigint, p_event text, p_detail jsonb, p_equity bigint default null,
    p_vid bigint default null, p_subject uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into capital_events(actor, subject_type, subject_id, event, detail, equity_id, verification_id)
  values (p_actor, p_type, p_id, p_event, coalesce(p_detail, '{}'::jsonb), p_equity, p_vid);
  perform _audit(p_actor, 'wf_' || p_event, p_subject, coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('ref', p_type || ':' || coalesce(p_id::text, '-')));
end $$;

-- the engine's own per-person summary, stored at the moment of a verified event (never recomputed here)
create or replace function public._wf_snapshot(p_equity bigint, p_vid bigint, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare r record; s jsonb;
begin
  for r in select p.id from profiles p where p.role = 'investor' and exists (select 1 from ledger l where l.profile_id = p.id) loop
    s := _holder_summary(r.id);
    insert into position_snapshots(equity_id, verification_id, event, profile_id, units, unit_price, value_usdt, value_after_fee_usdt, accrued_fee_usdt, summary)
    values (p_equity, p_vid, p_event, r.id, (s->>'units')::numeric, (s->>'unit_price')::numeric, (s->>'value_usdt')::numeric,
            (s->>'net_value_usdt')::numeric, (s->>'accrued_fee_usdt')::numeric, s);
  end loop;
end $$;

create or replace function public._wf_msg(p_code text, p_investor boolean) returns text language sql immutable as $$
  select case p_code
    when 'no_verification'      then case when p_investor then 'Waiting for the fund manager to check the account balance.' else 'No confirmed balance check yet. Enter the MEXC total and confirm it.' end
    when 'not_confirmed'        then case when p_investor then 'Waiting for the fund manager to check the account balance.' else 'The balance you entered has not been confirmed yet.' end
    when 'superseded'           then case when p_investor then 'Waiting for the fund manager to check the account balance.' else 'A newer balance check exists; use the newest confirmed one.' end
    when 'stale'                then case when p_investor then 'Waiting for the fund manager to check the account balance.' else 'The confirmed balance is too old. Enter and confirm the MEXC total again.' end
    when 'already_used'         then case when p_investor then 'Waiting for the fund manager to check the account balance.' else 'A payout already used this balance check, so the MEXC balance has changed. Enter and confirm it again.' end
    when 'open_positions'       then case when p_investor then 'Waiting for the open trades to close, so your money can be valued fairly.' else 'A trade is still open. Capital movements wait until both positions are closed and the balance is confirmed.' end
    when 'unresolved_difference' then case when p_investor then 'Waiting for the fund manager to check the account balance.' else 'The balance has a difference that is not explained yet. Explain it (adjustments) or classify it.' end
    when 'arrived_deposits'     then 'Admit or hand back the deposits that are already in MEXC first (they must not join silently).'
    when 'deposit_not_arrived'  then case when p_investor then 'The money has not been seen arriving in the trading account yet.' else 'The money is not confirmed as received in MEXC yet. Confirm its arrival when you see it.' end
    when 'awaiting_approval'    then case when p_investor then 'Waiting for the fund manager to review your request.' else 'Approve or reject this request.' end
    else p_code end
$$;

-- ---------------------------------------------------------------- 4. adapter to the accounting engine (the only multi-line contact point)
-- Admit ONE arrived deposit at the unit price implied by a confirmed balance. Price, units, high-water mark and lock-up come from the engine.
create or replace function public._acct_admit_deposit(p_pending bigint, p_balance numeric, p_confirm boolean, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_price numeric; v_units numeric; v_at timestamptz; v_eq bigint; v_led bigint; v_flag text;
begin
  v_at := _at(null);
  if _total_units() = 0 then
    if abs(p_balance - _pending_total()) > _wf_tol(p_balance) then
      raise exception 'the first deposit starts the pool, so the MEXC balance (%) must equal the money waiting (%)', round(p_balance, 4), round(_pending_total(), 4);
    end if;
    v_price := 1;
  else
    v_flag := _check_move(_net_equity(p_balance), p_confirm);
    v_price := _price_from(p_balance);
  end if;
  v_units := _convert_pending(p_pending, v_price, v_at, p_actor);
  perform _check_books();
  select ledger_id into v_led from pending_deposits where id = p_pending;
  select equity_id into v_eq from ledger where id = v_led;
  return jsonb_build_object('units', v_units, 'unit_price', v_price, 'equity_id', v_eq, 'ledger_id', v_led, 'flag', v_flag);
end $$;

-- One redemption through the engine: used by BOTH the quote (rolled back) and the real thing, so they cannot differ.
create or replace function public._acct_withdraw(p_token text, p_req withdrawal_requests, p_balance numeric, p_to_manager boolean, p_rate numeric,
    p_note text, p_force boolean, p_confirm boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_to_manager then
    return admin_withdraw_to_manager(p_token, p_req.profile_id, p_req.units, p_balance, p_rate, p_note, p_force, p_req.id, null, null, p_confirm);
  end if;
  return admin_withdraw(p_token, p_req.profile_id, p_req.units, p_balance, p_rate, p_note, p_force, p_req.id, null, null, p_confirm);
end $$;

-- ---------------------------------------------------------------- 5. readiness: may capital move on this balance check?
create or replace function public._wf_ready(p_vid bigint) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v balance_verifications%rowtype; s exchange_snapshots%rowtype; r jsonb := '[]'::jsonb; res numeric;
  hrs numeric := _wf_setnum('verify_max_age_hours', 12);
begin
  if p_vid is null then
    select * into v from balance_verifications where status = 'confirmed' order by id desc limit 1;
    if not found then
      r := jsonb_build_array(jsonb_build_object('code', case when exists (select 1 from balance_verifications where status = 'entered') then 'not_confirmed' else 'no_verification' end));
      return jsonb_build_object('ok', false, 'verification_id', null,
        'reasons', (select jsonb_agg(x || jsonb_build_object('text', _wf_msg(x->>'code', false))) from jsonb_array_elements(r) x));
    end if;
  else
    select * into v from balance_verifications where id = p_vid;
    if not found then raise exception 'unknown balance check'; end if;
  end if;
  if v.status <> 'confirmed' then r := r || jsonb_build_object('code', 'not_confirmed');
  elsif v.id <> (select max(id) from balance_verifications where status = 'confirmed') then r := r || jsonb_build_object('code', 'superseded'); end if;
  if v.entered_at < now() - make_interval(secs => hrs * 3600) then r := r || jsonb_build_object('code', 'stale'); end if;
  if v.spent_at is not null then r := r || jsonb_build_object('code', 'already_used'); end if;
  select * into s from exchange_snapshots where ts > v.entered_at order by id desc limit 1;
  if not v.flat or (found and (s.open_positions > 0 or s.open_orders > 0)) then
    r := r || jsonb_build_object('code', 'open_positions', 'positions', greatest(v.open_positions, coalesce(s.open_positions, 0)));
  end if;
  res := _wf_residual(v.id);
  if abs(res) > _wf_tol(v.mexc_total) then r := r || jsonb_build_object('code', 'unresolved_difference', 'residual', res); end if;
  return jsonb_build_object('ok', jsonb_array_length(r) = 0, 'verification_id', v.id, 'balance', v.mexc_total, 'entered_at', v.entered_at,
    'reasons', coalesce((select jsonb_agg(x || jsonb_build_object('text', _wf_msg(x->>'code', false))) from jsonb_array_elements(r) x), '[]'::jsonb));
end $$;

create or replace function public._wf_require_ready(p_vid bigint) returns numeric language plpgsql stable security definer set search_path = public as $$
declare rd jsonb := _wf_ready(p_vid);
begin
  if p_vid is null then raise exception 'choose the confirmed balance check to use'; end if;
  if not (rd->>'ok')::boolean then
    raise exception 'blocked: %', (select string_agg(x->>'text', ' ') from jsonb_array_elements(rd->'reasons') x);
  end if;
  return (rd->>'balance')::numeric;
end $$;

create or replace function public._wf_use(p_vid bigint, p_spend boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  update balance_verifications set first_used_at = coalesce(first_used_at, now()), spent_at = case when p_spend then coalesce(spent_at, now()) else spent_at end where id = p_vid;
end $$;

-- the same information for the screen
create or replace function public._wf_view(p_vid bigint) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v balance_verifications%rowtype;
begin
  select * into v from balance_verifications where id = p_vid;
  if not found then return null; end if;
  return to_jsonb(v) || jsonb_build_object(
    'entered_by_name', _wf_name(v.entered_by), 'confirmed_by_name', _wf_name(v.confirmed_by),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object('by_name', _wf_name(a.created_by)) order by a.id) from verification_adjustments a where a.verification_id = v.id), '[]'::jsonb),
    'adjusted_total', coalesce((select sum(amount) from verification_adjustments where verification_id = v.id), 0),
    'residual', _wf_residual(v.id), 'tolerance', _wf_tol(v.mexc_total),
    'balance_change', v.mexc_total - v.prev_total,
    'ready', _wf_ready(v.id),
    'snapshot', (select jsonb_build_object('ts', s.ts, 'unrealized_usdt', s.unrealized_usdt, 'realized_since', s.realized_since, 'open_positions', s.open_positions, 'open_orders', s.open_orders)
                   from exchange_snapshots s where s.id = v.snapshot_id));
end $$;

-- ---------------------------------------------------------------- 6. the balance check: enter, explain, confirm
create or replace function public.admin_enter_balance(p_token text, p_total numeric, p_positions int, p_orders int default 0, p_note text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; prev balance_verifications%rowtype; s exchange_snapshots%rowtype; v_id bigint;
  v_cum_in numeric; v_cum_out numeric; v_prev_total numeric; v_src text; v_pci numeric; v_pco numeric; v_flat boolean; v_exp numeric;
  v_wa numeric; v_wn numeric; v_price numeric; v_old record;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_enter_balance'); if v_res is not null then return v_res; end if;
  if p_total is null or p_total <= 0 then raise exception 'enter the MEXC total (USDT, more than 0)'; end if;
  if p_positions is null or p_positions < 0 or p_positions > 2 then raise exception 'say how many positions are open on MEXC (0, 1 or 2)'; end if;
  if p_orders is null or p_orders < 0 then raise exception 'open orders cannot be negative'; end if;
  select * into prev from balance_verifications where status = 'confirmed' order by id desc limit 1;
  v_cum_in := _wf_cum_in(); v_cum_out := _wf_cum_out();
  if prev.id is not null then
    v_prev_total := prev.mexc_total; v_src := 'verification'; v_pci := prev.cum_in; v_pco := prev.cum_out;
  else
    -- no confirmed check yet: start from what the books say is in the pool plus money already in MEXC, waiting to join
    v_prev_total := coalesce((select equity_usdt from pool_equity order by id desc limit 1), 0) + _pending_total(); v_src := 'ledger'; v_pci := v_cum_in; v_pco := v_cum_out;
  end if;
  v_exp := v_prev_total + (v_cum_in - v_pci) - (v_cum_out - v_pco);
  select * into s from exchange_snapshots where ts > now() - make_interval(secs => _wf_setnum('snapshot_max_age_hours', 12) * 3600) order by id desc limit 1;
  v_flat := p_positions = 0 and p_orders = 0 and (s.id is null or (s.open_positions = 0 and s.open_orders = 0));
  v_wa := _pending_total();
  v_wn := coalesce((select sum(usdt) from pending_deposits where status = 'pending' and arrived_at is null), 0);
  -- a newer entry replaces an unconfirmed older one; the older one stays on record
  for v_old in select id from balance_verifications where status = 'entered' loop
    update balance_verifications set status = 'superseded', status_changed_at = now(), status_note = 'replaced by a newer entry' where id = v_old.id;
    perform _wf_event(v_actor, 'verification', v_old.id, 'balance_superseded', jsonb_build_object('reason', 'a newer entry was made'), null, v_old.id);
  end loop;
  insert into balance_verifications(entered_by, mexc_total, open_positions, open_orders, flat, note, prev_id, prev_total, prev_source, cum_in, cum_out, prev_cum_in, prev_cum_out,
      known_in, known_out, waiting_arrived, waiting_not_arrived, open_requests_units, snapshot_id, expected_total, variance)
  values (v_actor, p_total, p_positions, p_orders, v_flat, p_note, prev.id, v_prev_total, v_src, v_cum_in, v_cum_out, v_pci, v_pco,
      v_cum_in - v_pci, v_cum_out - v_pco, v_wa, v_wn,
      coalesce((select sum(units) from withdrawal_requests where status = 'pending'), 0), s.id, v_exp, p_total - v_exp)
  returning id into v_id;
  perform _wf_event(v_actor, 'verification', v_id, 'balance_entered',
    jsonb_build_object('total', p_total, 'open_positions', p_positions, 'open_orders', p_orders, 'previous', v_prev_total, 'expected', v_exp, 'variance', p_total - v_exp), null, v_id);
  return _idem_put(p_idem, 'admin_enter_balance', _wf_view(v_id), v_actor);
end $$;

create or replace function public.admin_add_adjustment(p_token text, p_vid bigint, p_kind text, p_amount numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v balance_verifications%rowtype;
begin
  perform _ledger_lock();
  select * into v from balance_verifications where id = p_vid for update;
  if not found then raise exception 'unknown balance check'; end if;
  if v.status not in ('entered', 'confirmed') then raise exception 'this balance check is % and cannot be explained any more', v.status; end if;
  if v.first_used_at is not null then raise exception 'this balance check was already used by a deposit, payout or settlement: enter a new one'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'write what this is (at least 10 characters), for example the MEXC statement line'; end if;
  insert into verification_adjustments(verification_id, created_by, kind, amount, note) values (p_vid, v_actor, p_kind, p_amount, trim(p_note));
  perform _wf_event(v_actor, 'verification', p_vid, 'balance_adjusted', jsonb_build_object('kind', p_kind, 'amount', p_amount, 'note', p_note), null, p_vid);
  return _wf_view(p_vid);
end $$;

-- "the rest is trading result": an explicit act with a written reason, never done by confirming
create or replace function public.admin_classify_difference(p_token text, p_vid bigint, p_kind text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v balance_verifications%rowtype; r numeric;
begin
  perform _ledger_lock();
  select * into v from balance_verifications where id = p_vid for update;
  if not found then raise exception 'unknown balance check'; end if;
  if v.status not in ('entered', 'confirmed') then raise exception 'this balance check is % and cannot be explained any more', v.status; end if;
  if v.first_used_at is not null then raise exception 'this balance check was already used: enter a new one'; end if;
  if p_kind not in ('trading_pnl', 'fees', 'funding', 'transfer', 'timing', 'other') then raise exception 'choose what the difference is'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'write why (at least 10 characters)'; end if;
  r := _wf_residual(p_vid);
  if r = 0 then raise exception 'there is no difference left to classify'; end if;
  insert into verification_adjustments(verification_id, created_by, kind, amount, note, classified) values (p_vid, v_actor, p_kind, r, trim(p_note), true);
  perform _wf_event(v_actor, 'verification', p_vid, 'difference_classified', jsonb_build_object('kind', p_kind, 'amount', r, 'note', p_note), null, p_vid);
  return _wf_view(p_vid);
end $$;

create or replace function public.admin_confirm_balance(p_token text, p_vid bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v balance_verifications%rowtype; v_res jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_confirm_balance'); if v_res is not null then return v_res; end if;
  select * into v from balance_verifications where id = p_vid for update;
  if not found then raise exception 'unknown balance check'; end if;
  if v.status = 'confirmed' then raise exception 'this balance check is already confirmed (confirmed %)', v.confirmed_at; end if;
  if v.status <> 'entered' then raise exception 'this balance check is % and cannot be confirmed; enter the balance again', v.status; end if;
  -- confirming records a fact only: no pool entry, no price, no units, no label on the difference
  update balance_verifications set status = 'confirmed', confirmed_at = now(), confirmed_by = v_actor, status_changed_at = now() where id = p_vid;
  perform _wf_event(v_actor, 'verification', p_vid, 'balance_confirmed',
    jsonb_build_object('total', v.mexc_total, 'variance', v.variance, 'residual', _wf_residual(p_vid), 'open_positions', v.open_positions), null, p_vid);
  return _idem_put(p_idem, 'admin_confirm_balance', _wf_view(p_vid), v_actor);
end $$;

create or replace function public.admin_reject_balance(p_token text, p_vid bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v balance_verifications%rowtype;
begin
  perform _ledger_lock();
  select * into v from balance_verifications where id = p_vid for update;
  if not found then raise exception 'unknown balance check'; end if;
  if v.status <> 'entered' then raise exception 'only an entry that is not confirmed yet can be rejected (this one is %)', v.status; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'write why it is being rejected'; end if;
  update balance_verifications set status = 'rejected', status_note = trim(p_reason), status_changed_at = now() where id = p_vid;
  perform _wf_event(v_actor, 'verification', p_vid, 'balance_rejected', jsonb_build_object('reason', p_reason), null, p_vid);
  return _wf_view(p_vid);
end $$;

create or replace function public.admin_balance_checks(p_token text, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return jsonb_build_object(
    'ready', _wf_ready(null),
    'gate', coalesce(_setting('workflow_gate'), 'off'),
    'max_age_hours', _wf_setnum('verify_max_age_hours', 12),
    'checks', coalesce((select jsonb_agg(_wf_view(x.id) order by x.id desc) from (select id from balance_verifications order by id desc limit least(greatest(coalesce(p_limit, 20), 1), 200)) x), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- 7. deposits: arrival, then a separate admission
create or replace function public.admin_confirm_arrival(p_token text, p_pending bigint, p_note text default null, p_transfer_id text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); pd pending_deposits%rowtype;
begin
  perform _ledger_lock();
  select * into pd from pending_deposits where id = p_pending for update;
  if not found then raise exception 'unknown deposit'; end if;
  if pd.status <> 'pending' then raise exception 'this deposit is already %', pd.status; end if;
  if pd.arrived_at is not null then raise exception 'this deposit is already confirmed as received in MEXC (%)', pd.arrived_at; end if;
  if p_note is null or length(trim(p_note)) < 5 then raise exception 'write how you saw it arrive (for example the MEXC deposit record)'; end if;
  update pending_deposits set arrived_at = now(), arrival_confirmed_by = v_actor, arrival_note = trim(p_note), mexc_transfer_id = coalesce(mexc_transfer_id, nullif(trim(p_transfer_id), ''))
   where id = p_pending;
  perform _wf_event(v_actor, 'deposit', p_pending, 'deposit_arrival_confirmed', jsonb_build_object('usdt', pd.usdt, 'note', p_note, 'transfer', p_transfer_id), null, null, pd.profile_id);
  return jsonb_build_object('id', p_pending, 'arrived_at', now());
end $$;

create or replace function public.admin_admit_deposit(p_token text, p_pending bigint, p_vid bigint, p_idem text default null, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; pd pending_deposits%rowtype; v_bal numeric; a jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_admit_deposit'); if v_res is not null then return v_res; end if;
  select * into pd from pending_deposits where id = p_pending for update;
  if not found then raise exception 'unknown deposit'; end if;
  if pd.status = 'converted' then raise exception 'duplicate refused: this deposit was already admitted (%)', pd.admitted_at; end if;
  if pd.status = 'cancelled' then raise exception 'this deposit was handed back and cannot be admitted'; end if;
  if pd.arrived_at is null then raise exception 'queued: this money is not confirmed as received in MEXC yet, so it stays outside the pool'; end if;
  v_bal := _wf_require_ready(p_vid);
  perform set_config('ledger.wf_ctx', 'deposit:' || p_vid, true);
  a := _acct_admit_deposit(p_pending, v_bal, p_confirm, v_actor);
  perform set_config('ledger.wf_ctx', '', true);
  update pending_deposits set admitted_at = now(), admitted_by = v_actor, admit_verification_id = p_vid where id = p_pending;
  perform _wf_use(p_vid, false);
  perform _wf_snapshot((a->>'equity_id')::bigint, p_vid, 'deposit_admitted');
  perform _wf_event(v_actor, 'deposit', p_pending, 'deposit_admitted', jsonb_build_object('usdt', pd.usdt, 'units', a->'units', 'unit_price', a->'unit_price'),
    (a->>'equity_id')::bigint, p_vid, pd.profile_id);
  return _idem_put(p_idem, 'admin_admit_deposit', a - 'flag', v_actor);
end $$;

-- ---------------------------------------------------------------- 8. withdrawal requests
create or replace function public._wf_in_lockup(p uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((_holder_summary(p)->>'lock_until')::date, date '1900-01-01') > current_date
$$;

-- an investor may ask at any time; the lock-up is wording, so a request inside it is accepted and the manager decides
create or replace function public.request_withdrawal(p_token text, p_units numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid := _me_rw(p_token); pr profiles%rowtype; v_by date; v_open numeric; v_id bigint;
begin
  perform _ledger_lock();
  select * into pr from profiles where id = v;
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if pr.role = 'investor' and not exists (select 1 from payout_details where profile_id = v) then
    raise exception 'add where you want to be paid (GCash or bank) before requesting a withdrawal';
  end if;
  v_open := coalesce((select sum(units) from withdrawal_requests where profile_id = v and status = 'pending'), 0);
  if p_units + v_open > _units_of(v) + 0.00000001 then raise exception 'you only hold % units (% already in pending requests)', _units_of(v), v_open; end if;
  if pr.role = 'investor' and p_units + v_open > _unlocked_units(v) + 0.00000001 then
    raise exception 'locked: % units are past lock-up and % are already in pending requests. Next unlock: %', _unlocked_units(v), v_open,
      (select min(lock_until) filter (where lock_until > current_date) from ledger where profile_id = v and kind = 'deposit');
  end if;
  if pr.role = 'investor' then
    perform _check_min_withdrawal(v, p_units, (select unit_price from pool_equity order by id desc limit 1), _last_php_rate());
  end if;
  v_by := add_business_days(current_date, (_setting('withdrawal_business_days'))::int);
  insert into withdrawal_requests(profile_id, units, note, pay_by) values (v, p_units, p_note, v_by) returning id into v_id;
  perform _wf_event(v, 'withdrawal', v_id, 'withdrawal_requested', jsonb_build_object('units', p_units, 'pay_by', v_by, 'inside_lockup', _wf_in_lockup(v)), null, null, v);
  return jsonb_build_object('pay_by', v_by);
end $$;

-- keeps the stage honest when the older paths change the request's status
create or replace function public._wf_sync_stage() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'cancelled' and new.stage in ('requested', 'approved') then new.stage := 'cancelled';
    elsif new.status = 'paid' and new.stage in ('requested', 'approved') then new.stage := 'redeemed';
    elsif new.status = 'pending' and old.status = 'paid' then
      if exists (select 1 from payout_records where request_id = new.id and status in ('sent', 'completed')) then
        raise exception 'this payout is already sent or completed, so the redemption cannot be reversed here; record the return of the money first';
      end if;
      update payout_records set status = 'voided', status_note = 'redemption was corrected' where request_id = new.id and status in ('awaiting', 'failed');
      new.stage := case when new.approved_at is not null then 'approved' else 'requested' end;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists wf_sync_stage on public.withdrawal_requests;
create trigger wf_sync_stage before update on public.withdrawal_requests for each row execute function public._wf_sync_stage();

create or replace function public.admin_approve_withdrawal(p_token text, p_request bigint, p_note text default null, p_lock_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); r withdrawal_requests%rowtype; v_in boolean;
begin
  perform _ledger_lock();
  select * into r from withdrawal_requests where id = p_request for update;
  if not found then raise exception 'unknown withdrawal request'; end if;
  if r.status <> 'pending' then raise exception 'this request is already %', r.status; end if;
  if r.stage = 'approved' then raise exception 'this request is already approved'; end if;
  if r.stage <> 'requested' then raise exception 'this request is %', r.stage; end if;
  v_in := _wf_in_lockup(r.profile_id);
  if v_in and (p_lock_reason is null or length(trim(p_lock_reason)) < 10) then
    raise exception 'this person is inside the lock-up shown to investors. Approving is your decision; write the reason for the exception (at least 10 characters)';
  end if;
  update withdrawal_requests set stage = 'approved', approved_by = v_actor, approved_at = now(), approval_note = nullif(trim(coalesce(p_note, '')), ''),
      lock_exception = v_in, lock_exception_reason = case when v_in then trim(p_lock_reason) end,
      lock_exception_by = case when v_in then v_actor end, lock_exception_at = case when v_in then now() end
   where id = p_request;
  perform _wf_event(v_actor, 'withdrawal', p_request, case when v_in then 'withdrawal_approved_lockup_exception' else 'withdrawal_approved' end,
    jsonb_build_object('units', r.units, 'note', p_note, 'lock_exception_reason', p_lock_reason), null, null, r.profile_id);
  return jsonb_build_object('id', p_request, 'stage', 'approved', 'lock_exception', v_in);
end $$;

create or replace function public.admin_reject_withdrawal(p_token text, p_request bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); r withdrawal_requests%rowtype;
begin
  perform _ledger_lock();
  select * into r from withdrawal_requests where id = p_request for update;
  if not found then raise exception 'unknown withdrawal request'; end if;
  if r.status <> 'pending' or r.stage not in ('requested', 'approved') then raise exception 'only a request that is still waiting can be rejected (this one is %)', r.stage; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'write the reason; the investor is told'; end if;
  update withdrawal_requests set status = 'cancelled', stage = 'rejected', rejected_reason = trim(p_reason) where id = p_request;
  perform _wf_event(v_actor, 'withdrawal', p_request, 'withdrawal_rejected', jsonb_build_object('reason', p_reason), null, null, r.profile_id);
  return jsonb_build_object('id', p_request, 'stage', 'rejected');
end $$;

-- what the redemption would be, worked out by the engine itself (the real call, then rolled back): no second copy of the maths
create or replace function public.admin_quote_withdrawal(p_token text, p_request bigint, p_vid bigint, p_to_manager boolean default false, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r withdrawal_requests%rowtype; v_bal numeric; v_res jsonb; v_force boolean;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  select * into r from withdrawal_requests where id = p_request;
  if not found then raise exception 'unknown withdrawal request'; end if;
  if r.status <> 'pending' then raise exception 'this request is already %', r.status; end if;
  v_bal := _wf_require_ready(p_vid);
  v_force := coalesce(_setting('lock_enforced'), '0') = '1' and r.lock_exception;
  perform set_config('ledger.wf_ctx', 'quote', true);
  begin
    v_res := _acct_withdraw(p_token, r, v_bal, p_to_manager, null, 'quote', v_force, p_confirm);
    raise exception 'quote rolled back' using errcode = 'WQ001';
  exception when sqlstate 'WQ001' then null;
  end;
  perform set_config('ledger.wf_ctx', '', true);
  return v_res || jsonb_build_object('quote', true, 'balance', v_bal, 'units', r.units);
end $$;

create or replace function public.admin_execute_withdrawal(p_token text, p_request bigint, p_vid bigint, p_to_manager boolean default false,
    p_php_rate numeric default null, p_note text default null, p_idem text default null, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; r withdrawal_requests%rowtype; v_bal numeric; v_force boolean; v_out jsonb; v_eq bigint; v_led bigint; v_pay_id bigint;
  v_rate numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_execute_withdrawal'); if v_res is not null then return v_res; end if;
  select * into r from withdrawal_requests where id = p_request for update;
  if not found then raise exception 'unknown withdrawal request'; end if;
  if r.stage = 'redeemed' or r.status = 'paid' then raise exception 'duplicate refused: this request was already redeemed'; end if;
  if r.status <> 'pending' then raise exception 'this request is %', r.stage; end if;
  if r.stage <> 'approved' then raise exception 'approve the request first (it is %)', r.stage; end if;
  if _wf_in_lockup(r.profile_id) and not r.lock_exception then
    raise exception 'this person is inside the lock-up shown to investors: approve the request again with a written reason for the exception';
  end if;
  v_bal := _wf_require_ready(p_vid);
  v_force := coalesce(_setting('lock_enforced'), '0') = '1' and r.lock_exception;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  -- the engine skips the minimum-withdrawal rule when forced; an exception is about the lock-up only, so the minimum is checked here
  if v_force then perform _check_min_withdrawal(r.profile_id, r.units, _price_from(v_bal), v_rate); end if;
  perform set_config('ledger.wf_ctx', 'withdrawal:' || p_vid, true);
  v_out := _acct_withdraw(p_token, r, v_bal, p_to_manager, v_rate, p_note, v_force, p_confirm);
  perform set_config('ledger.wf_ctx', '', true);
  select ledger_id into v_led from withdrawal_requests where id = p_request;
  select equity_id into v_eq from ledger where id = v_led;
  insert into payout_records(request_id, profile_id, ledger_id, equity_id, amount_usdt, php_rate, leaves_mexc, created_by)
  values (p_request, r.profile_id, v_led, v_eq, (v_out->>'pay_usdt')::numeric, v_rate, not p_to_manager, v_actor) returning id into v_pay_id;
  update withdrawal_requests set redemption_verification_id = p_vid where id = p_request;
  perform _wf_use(p_vid, not p_to_manager);
  perform _wf_snapshot(v_eq, p_vid, 'withdrawal_executed');
  perform _wf_event(v_actor, 'withdrawal', p_request, 'withdrawal_executed',
    jsonb_build_object('units', r.units, 'pay_usdt', v_out->'pay_usdt', 'fee_units', v_out->'fee_units', 'unit_price', v_out->'unit_price', 'to_manager', p_to_manager,
      'lock_exception', r.lock_exception, 'lock_exception_reason', r.lock_exception_reason), v_eq, p_vid, r.profile_id);
  return _idem_put(p_idem, 'admin_execute_withdrawal', v_out || jsonb_build_object('payout_id', v_pay_id, 'equity_id', v_eq), v_actor);
end $$;

-- ---------------------------------------------------------------- 9. payouts: awaiting -> sent -> completed (or failed, then retried)
create or replace function public._wf_payout_for_update(p_request bigint) returns payout_records language plpgsql security definer set search_path = public as $$
declare po payout_records%rowtype;
begin
  select * into po from payout_records where request_id = p_request for update;
  if not found then raise exception 'this request has no payout yet: redeem it first'; end if;
  return po;
end $$;

create or replace function public.admin_payout_sent(p_token text, p_request bigint, p_reference text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); po payout_records%rowtype;
begin
  perform _ledger_lock();
  po := _wf_payout_for_update(p_request);
  if po.status <> 'awaiting' then raise exception 'this payout is %, not awaiting', po.status; end if;
  if not po.leaves_mexc then raise exception 'this one is paid from your own money; nothing leaves MEXC. Mark it completed instead'; end if;
  if p_reference is null or length(trim(p_reference)) < 3 then raise exception 'enter the MEXC withdrawal reference'; end if;
  update payout_records set status = 'sent', sent_at = now(), reference = trim(p_reference), status_note = p_note where id = po.id;
  perform _wf_event(v_actor, 'payout', po.id, 'payout_sent', jsonb_build_object('reference', p_reference, 'amount_usdt', po.amount_usdt, 'note', p_note), po.equity_id, null, po.profile_id);
  return jsonb_build_object('payout_id', po.id, 'status', 'sent');
end $$;

create or replace function public.admin_payout_complete(p_token text, p_request bigint, p_reference text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); po payout_records%rowtype;
begin
  perform _ledger_lock();
  po := _wf_payout_for_update(p_request);
  if po.status = 'completed' then raise exception 'duplicate refused: this payout is already completed (%)', po.completed_at; end if;
  if po.leaves_mexc and po.status <> 'sent' then raise exception 'mark it as sent from MEXC first (it is %)', po.status; end if;
  if not po.leaves_mexc and po.status <> 'awaiting' then raise exception 'this payout is %', po.status; end if;
  if p_reference is null or length(trim(p_reference)) < 3 then raise exception 'enter the proof of payment (GCash or bank reference)'; end if;
  update payout_records set status = 'completed', completed_at = now(), reference = trim(p_reference), status_note = p_note where id = po.id;
  perform _wf_event(v_actor, 'payout', po.id, 'payout_completed', jsonb_build_object('reference', p_reference, 'amount_usdt', po.amount_usdt, 'note', p_note), po.equity_id, null, po.profile_id);
  return jsonb_build_object('payout_id', po.id, 'status', 'completed');
end $$;

create or replace function public.admin_payout_fail(p_token text, p_request bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); po payout_records%rowtype;
begin
  perform _ledger_lock();
  po := _wf_payout_for_update(p_request);
  if po.status not in ('awaiting', 'sent') then raise exception 'only a payout that is awaiting or sent can fail (this one is %)', po.status; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'write what went wrong'; end if;
  update payout_records set status = 'failed', failed_at = now(), failure_reason = trim(p_reason), status_note = p_reason where id = po.id;
  perform _wf_event(v_actor, 'payout', po.id, 'payout_failed', jsonb_build_object('reason', p_reason, 'was', po.status), po.equity_id, null, po.profile_id);
  return jsonb_build_object('payout_id', po.id, 'status', 'failed');
end $$;

create or replace function public.admin_payout_retry(p_token text, p_request bigint, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); po payout_records%rowtype;
begin
  perform _ledger_lock();
  po := _wf_payout_for_update(p_request);
  if po.status <> 'failed' then raise exception 'only a failed payout can be retried (this one is %)', po.status; end if;
  update payout_records set status = 'awaiting', attempts = attempts + 1, reference = null, sent_at = null, status_note = p_note where id = po.id;
  perform _wf_event(v_actor, 'payout', po.id, 'payout_retry', jsonb_build_object('attempt', po.attempts + 1, 'note', p_note), po.equity_id, null, po.profile_id);
  return jsonb_build_object('payout_id', po.id, 'status', 'awaiting');
end $$;

-- ---------------------------------------------------------------- 10. valuation and settlement through the same check
create or replace function public.admin_apply_balance(p_token text, p_vid bigint, p_note text default null, p_idem text default null, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; v_bal numeric; v_out jsonb; v_eq bigint;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_apply_balance'); if v_res is not null then return v_res; end if;
  v_bal := _wf_require_ready(p_vid);
  if exists (select 1 from pending_deposits where status = 'pending' and arrived_at is not null) then
    raise exception 'blocked: %', _wf_msg('arrived_deposits', false);
  end if;
  v_out := admin_post_equity(p_token, v_bal, null, coalesce(p_note, 'verified balance #' || p_vid), null, null, p_confirm);
  select id into v_eq from pool_equity order by id desc limit 1;
  perform _wf_use(p_vid, false);
  perform _wf_snapshot(v_eq, p_vid, 'valuation_applied');
  perform _wf_event(v_actor, 'valuation', p_vid, 'valuation_applied', jsonb_build_object('balance', v_bal, 'unit_price', v_out->'unit_price'), v_eq, p_vid);
  return _idem_put(p_idem, 'admin_apply_balance', v_out || jsonb_build_object('equity_id', v_eq), v_actor);
end $$;

create or replace function public.admin_quote_close(p_token text, p_vid bigint, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_bal numeric; v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  v_bal := _wf_require_ready(p_vid);
  if exists (select 1 from pending_deposits where status = 'pending' and arrived_at is not null) then raise exception 'blocked: %', _wf_msg('arrived_deposits', false); end if;
  perform set_config('ledger.wf_ctx', 'quote', true);
  begin
    v_res := admin_close_quarter(p_token, v_bal, null, 'quote', null, null, p_confirm);
    raise exception 'quote rolled back' using errcode = 'WQ001';
  exception when sqlstate 'WQ001' then null;
  end;
  perform set_config('ledger.wf_ctx', '', true);
  return v_res || jsonb_build_object('quote', true, 'balance', v_bal);
end $$;

create or replace function public.admin_settle_quarter(p_token text, p_vid bigint, p_php_rate numeric default null, p_note text default null, p_idem text default null, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; v_bal numeric; v_out jsonb; v_eq bigint;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_settle_quarter'); if v_res is not null then return v_res; end if;
  v_bal := _wf_require_ready(p_vid);
  if exists (select 1 from pending_deposits where status = 'pending' and arrived_at is not null) then raise exception 'blocked: %', _wf_msg('arrived_deposits', false); end if;
  perform set_config('ledger.wf_ctx', 'settlement:' || p_vid, true);
  v_out := admin_close_quarter(p_token, v_bal, p_php_rate, p_note, null, null, p_confirm);
  perform set_config('ledger.wf_ctx', '', true);
  select id into v_eq from pool_equity order by id desc limit 1;
  perform _wf_use(p_vid, false);
  perform _wf_snapshot(v_eq, p_vid, 'quarter_settled');
  perform _wf_event(v_actor, 'settlement', v_eq, 'quarter_settled', jsonb_build_object('balance', v_bal, 'unit_price', v_out->'unit_price', 'fee_units', v_out->'fee_units'), v_eq, p_vid);
  return _idem_put(p_idem, 'admin_settle_quarter', v_out || jsonb_build_object('equity_id', v_eq), v_actor);
end $$;

-- ---------------------------------------------------------------- 11. the guard: no deposit, withdrawal or close outside the workflow once the gate is on
create or replace function public._wf_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(_setting('workflow_gate'), 'off') <> 'on' then return new; end if;
  if new.reversed_of is not null or new.kind not in ('deposit', 'withdrawal', 'close') then return new; end if;
  if coalesce(current_setting('ledger.wf_ctx', true), '') = '' then
    raise exception 'blocked: deposits, withdrawals and quarter closes go through the Capital desk (a confirmed balance check) while workflow_gate is on';
  end if;
  return new;
end $$;
drop trigger if exists wf_guard on public.pool_equity;
create trigger wf_guard before insert on public.pool_equity for each row execute function public._wf_guard();

-- ---------------------------------------------------------------- 12. the queue: what is waiting, why, and what to do
create or replace function public._wf_dep_info(p_id bigint, rd jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d pending_deposits%rowtype; v_ok boolean := coalesce((rd->>'ok')::boolean, false); v_codes jsonb; v_age numeric; v_state text;
begin
  select * into d from pending_deposits where id = p_id;
  v_age := round(extract(epoch from now() - d.received_at) / 3600);
  v_codes := case when d.status = 'converted' then '[]'::jsonb when d.status = 'cancelled' then '[]'::jsonb when d.arrived_at is null then jsonb_build_array('deposit_not_arrived')
                  when v_ok then '[]'::jsonb else coalesce((select jsonb_agg(x->>'code') from jsonb_array_elements(rd->'reasons') x), '[]'::jsonb) end;
  v_state := case d.status when 'converted' then 'admitted' when 'cancelled' then 'handed_back'
                  else case when d.arrived_at is null then 'awaiting_arrival' when v_ok then 'ready' else 'queued' end end;
  return jsonb_build_object('id', d.id, 'profile_id', d.profile_id, 'usdt', d.usdt, 'php_amount', d.php_amount, 'received_at', d.received_at, 'arrived_at', d.arrived_at,
    'admitted_at', d.admitted_at, 'state', v_state, 'blocked_by', v_codes, 'age_hours', v_age,
    'escalate', d.status = 'pending' and v_state <> 'ready' and v_age > _wf_setnum('queue_escalate_hours', 72), 'escalated_at', d.escalated_at);
end $$;

create or replace function public._wf_wd_info(p_id bigint, rd jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r withdrawal_requests%rowtype; po payout_records%rowtype; v_ok boolean := coalesce((rd->>'ok')::boolean, false); v_codes jsonb := '[]'::jsonb;
  v_state text; v_age numeric; v_delayed boolean;
begin
  select * into r from withdrawal_requests where id = p_id;
  select * into po from payout_records where request_id = p_id;
  v_age := round(extract(epoch from now() - r.requested_at) / 3600);
  if r.stage = 'requested' then v_state := 'awaiting_approval'; v_codes := jsonb_build_array('awaiting_approval');
  elsif r.stage = 'approved' then
    if v_ok then v_state := 'ready'; else v_state := 'queued'; v_codes := coalesce((select jsonb_agg(x->>'code') from jsonb_array_elements(rd->'reasons') x), '[]'::jsonb); end if;
  elsif r.stage = 'redeemed' then
    v_state := case when po.id is null then 'completed_legacy' else case po.status when 'awaiting' then 'payout_awaiting' when 'sent' then 'payout_sent'
                  when 'failed' then 'payout_failed' when 'completed' then 'completed' else 'voided' end end;
  else v_state := r.stage; end if;
  v_delayed := r.pay_by < current_date and v_state not in ('completed', 'completed_legacy', 'rejected', 'cancelled', 'voided');
  return jsonb_build_object('id', r.id, 'profile_id', r.profile_id, 'units', r.units, 'requested_at', r.requested_at, 'pay_by', r.pay_by, 'stage', r.stage, 'state', v_state,
    'blocked_by', v_codes, 'delayed', v_delayed, 'age_hours', v_age, 'approved_at', r.approved_at, 'lock_exception', r.lock_exception, 'rejected_reason', r.rejected_reason,
    'escalate', (v_state in ('queued', 'payout_failed') or v_delayed) and (v_age > _wf_setnum('queue_escalate_hours', 72) or v_delayed), 'escalated_at', r.escalated_at,
    'payout', case when po.id is null then null else jsonb_build_object('id', po.id, 'status', po.status, 'amount_usdt', po.amount_usdt, 'leaves_mexc', po.leaves_mexc,
        'reference', po.reference, 'failure_reason', po.failure_reason, 'attempts', po.attempts, 'sent_at', po.sent_at, 'completed_at', po.completed_at) end);
end $$;

create or replace function public.admin_capital_queue(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rd jsonb; v_pos int;
begin
  perform _admin(p_token);
  rd := _wf_ready(null);
  select greatest(coalesce(v.open_positions, 0), coalesce((select open_positions from exchange_snapshots where ts > v.entered_at order by id desc limit 1), 0))
    into v_pos from balance_verifications v where v.id = nullif(rd->>'verification_id', '')::bigint;
  return jsonb_build_object('gate', coalesce(_setting('workflow_gate'), 'off'), 'ready', rd, 'open_positions', v_pos,
    'escalate_after_hours', _wf_setnum('queue_escalate_hours', 72),
    'deposits', coalesce((select jsonb_agg(_wf_dep_info(d.id, rd) || jsonb_build_object('name', _wf_name(d.profile_id),
          'reason', (select string_agg(_wf_msg(c, false), ' ') from jsonb_array_elements_text(_wf_dep_info(d.id, rd)->'blocked_by') c)) order by d.received_at, d.id)
        from pending_deposits d where d.status = 'pending'), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg(_wf_wd_info(r.id, rd) || jsonb_build_object('name', _wf_name(r.profile_id), 'in_lockup', _wf_in_lockup(r.profile_id),
          'lock_exception_reason', r.lock_exception_reason, 'approval_note', r.approval_note,
          'reason', (select string_agg(_wf_msg(c, false), ' ') from jsonb_array_elements_text(_wf_wd_info(r.id, rd)->'blocked_by') c)) order by r.id)
        from withdrawal_requests r
        where r.status = 'pending' or exists (select 1 from payout_records po where po.request_id = r.id and po.status in ('awaiting', 'sent', 'failed'))), '[]'::jsonb));
end $$;

create or replace function public.admin_escalate(p_token text, p_kind text, p_id bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_profile uuid;
begin
  perform _ledger_lock();
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'write what you will do about it (at least 10 characters)'; end if;
  if p_kind = 'deposit' then
    update pending_deposits set escalated_at = now(), escalation_note = trim(p_note) where id = p_id and status = 'pending' returning profile_id into v_profile;
  elsif p_kind = 'withdrawal' then
    update withdrawal_requests set escalated_at = now(), escalation_note = trim(p_note) where id = p_id and stage in ('requested', 'approved', 'redeemed') returning profile_id into v_profile;
  else raise exception 'escalate a deposit or a withdrawal'; end if;
  if v_profile is null then raise exception 'nothing to escalate: that item is not waiting'; end if;
  perform _wf_event(v_actor, p_kind, p_id, p_kind || '_escalated', jsonb_build_object('note', p_note), null, null, v_profile);
  return jsonb_build_object('escalated', true);
end $$;

create or replace function public.admin_capital_events(p_token text, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ts', ts, 'actor', _wf_name(actor), 'subject_type', subject_type, 'subject_id', subject_id, 'event', event, 'detail', detail) order by id desc)
                     from (select * from capital_events order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- 13. what an investor sees
-- Own requests only. Internal notes (lock-up exception reason, approval note) are not shown; the reason a request waits is.
create or replace function public.my_requests(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token); rd jsonb := _wf_ready(null);
begin
  return coalesce((select jsonb_agg(to_jsonb(r) - 'approval_note' - 'lock_exception' - 'lock_exception_reason' - 'lock_exception_by' - 'lock_exception_at' - 'escalation_note' - 'approved_by'
                     || jsonb_build_object('wf', _wf_wd_info(r.id, rd) - 'escalate' - 'escalated_at' - 'lock_exception')
                     || jsonb_build_object('reason', (select string_agg(_wf_msg(c, true), ' ') from jsonb_array_elements_text(_wf_wd_info(r.id, rd)->'blocked_by') c))
                     order by r.id desc)
                     from withdrawal_requests r where r.profile_id = v), '[]'::jsonb);
end $$;

create or replace function public.my_position(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v uuid := _me(p_token); h jsonb; rd jsonb := _wf_ready(null); v_last pool_equity%rowtype; v_gate text := coalesce(_setting('workflow_gate'), 'off');
  v_basis text; v_reliable boolean; v_reason text; v_lv jsonb; v_open boolean := false; vv balance_verifications%rowtype;
begin
  h := _holder_summary(v);
  select * into v_last from pool_equity order by id desc limit 1;
  if v_gate <> 'on' then v_basis := 'not_enforced'; v_reliable := true;
  elsif coalesce(_setting('estimate_basis'), 'verified') = 'any' then v_basis := 'unverified_allowed'; v_reliable := true;
  elsif v_last.id is not null and v_last.reversed_of is null and exists (select 1 from capital_events e where e.equity_id = v_last.id
        and e.event in ('valuation_applied', 'deposit_admitted', 'withdrawal_executed', 'quarter_settled')) then v_basis := 'verified'; v_reliable := true;
  else v_basis := 'unverified'; v_reliable := false;
        v_reason := 'The latest balance has not been verified by the fund manager yet, so your value is not shown as final-looking. It will update after the next verification.'; end if;
  select * into vv from balance_verifications where status = 'confirmed' order by id desc limit 1;
  if found then v_open := not vv.flat; end if;
  select jsonb_build_object('as_of', s.ts, 'event', s.event, 'value_usdt', s.value_usdt, 'value_after_fee_usdt', s.value_after_fee_usdt, 'accrued_fee_usdt', s.accrued_fee_usdt)
    into v_lv from position_snapshots s where s.profile_id = v order by s.id desc limit 1;
  return jsonb_build_object(
    'as_of', v_last.ts, 'role', h->>'role',
    'estimate', jsonb_build_object('value_after_fee_usdt', h->'net_value_usdt', 'value_before_fee_usdt', h->'value_usdt', 'accrued_fee_usdt', h->'accrued_fee_usdt',
        'reliable', v_reliable, 'basis', v_basis, 'reason', v_reason, 'includes_open_trades', v_open, 'last_verified', v_lv),
    'capital', jsonb_build_object('contributed_usdt', h->'deposited_usdt', 'withdrawn_usdt', h->'withdrawn_usdt', 'net_contributed_usdt', h->'net_in_usdt',
        'trading_result_before_fees_usdt', h->'gross_profit_usdt', 'fees_paid_usdt', h->'fee_paid_usdt', 'fees_accrued_usdt', h->'accrued_fee_usdt',
        'net_performance_usdt', h->'net_profit_usdt', 'net_performance_pct', h->'net_return_pct'),
    'settlements', coalesce((select jsonb_agg(jsonb_build_object('ts', l.ts, 'kind', case e.kind when 'close' then 'quarter_close' else 'withdrawal' end,
          'fee_units', -l.units, 'fee_usdt', -l.usdt, 'unit_price', l.unit_price, 'note', l.note) order by l.id desc)
        from ledger l join pool_equity e on e.id = l.equity_id where l.profile_id = v and l.kind = 'fee_out' and l.reversed_of is null
         and not exists (select 1 from ledger r where r.reversed_of = l.id)), '[]'::jsonb),
    'deposits', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'usdt', d.usdt, 'php_amount', d.php_amount, 'received_at', d.received_at, 'arrived_at', d.arrived_at,
          'state', _wf_dep_info(d.id, rd)->>'state',
          'reason', (select string_agg(_wf_msg(c, true), ' ') from jsonb_array_elements_text(_wf_dep_info(d.id, rd)->'blocked_by') c)) order by d.received_at desc, d.id desc)
        from pending_deposits d where d.profile_id = v and d.status = 'pending'), '[]'::jsonb),
    'withdrawals', coalesce((select jsonb_agg((_wf_wd_info(r.id, rd) - 'escalate' - 'escalated_at' - 'lock_exception' - 'approved_at')
          || jsonb_build_object('reason', (select string_agg(_wf_msg(c, true), ' ') from jsonb_array_elements_text(_wf_wd_info(r.id, rd)->'blocked_by') c)) order by r.id desc)
        from withdrawal_requests r where r.profile_id = v), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- 14. backups include the new tables
create or replace function public._wf_export() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balance_verifications', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from balance_verifications x),
    'verification_adjustments', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from verification_adjustments x),
    'capital_events', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from capital_events x),
    'payout_records', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from payout_records x),
    'position_snapshots', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from position_snapshots x))
$$;
do $$
declare v_def text;
begin
  -- wrap the existing export so the new tables travel with every backup (idempotent)
  if to_regprocedure('public._export_all_core()') is null then
    alter function public._export_all() rename to _export_all_core;
  end if;
end $$;
create or replace function public._export_all() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_all_core() || _wf_export()
$$;

-- ---------------------------------------------------------------- 15. access
revoke all on function public._wf_verification_guard(), public._wf_setnum(text, numeric), public._wf_tol(numeric), public._wf_cum_in(), public._wf_cum_out(),
  public._wf_residual(bigint), public._wf_name(uuid), public._wf_event(uuid, text, bigint, text, jsonb, bigint, bigint, uuid), public._wf_snapshot(bigint, bigint, text),
  public._wf_msg(text, boolean), public._acct_admit_deposit(bigint, numeric, boolean, uuid), public._acct_withdraw(text, withdrawal_requests, numeric, boolean, numeric, text, boolean, boolean),
  public._wf_ready(bigint), public._wf_require_ready(bigint), public._wf_use(bigint, boolean), public._wf_view(bigint), public._wf_in_lockup(uuid),
  public._wf_sync_stage(), public._wf_payout_for_update(bigint), public._wf_guard(), public._wf_dep_info(bigint, jsonb), public._wf_wd_info(bigint, jsonb),
  public._wf_export(), public._export_all_core() from public, anon, authenticated;
grant execute on function
  public.admin_enter_balance(text, numeric, int, int, text, text), public.admin_add_adjustment(text, bigint, text, numeric, text),
  public.admin_classify_difference(text, bigint, text, text), public.admin_confirm_balance(text, bigint, text), public.admin_reject_balance(text, bigint, text),
  public.admin_balance_checks(text, int), public.admin_confirm_arrival(text, bigint, text, text), public.admin_admit_deposit(text, bigint, bigint, text, boolean),
  public.request_withdrawal(text, numeric, text), public.admin_approve_withdrawal(text, bigint, text, text), public.admin_reject_withdrawal(text, bigint, text),
  public.admin_quote_withdrawal(text, bigint, bigint, boolean, boolean), public.admin_execute_withdrawal(text, bigint, bigint, boolean, numeric, text, text, boolean),
  public.admin_payout_sent(text, bigint, text, text), public.admin_payout_complete(text, bigint, text, text), public.admin_payout_fail(text, bigint, text),
  public.admin_payout_retry(text, bigint, text), public.admin_apply_balance(text, bigint, text, text, boolean), public.admin_quote_close(text, bigint, boolean),
  public.admin_settle_quarter(text, bigint, numeric, text, text, boolean), public.admin_capital_queue(text), public.admin_escalate(text, text, bigint, text),
  public.admin_capital_events(text, int), public.my_requests(text), public.my_position(text)
to anon, authenticated;

-- True-value pricing for deposits and withdrawals, book corrections, checkpoints. OFF by default: ledger_settings.flow_pricing = 'book'.
-- Design and the maths: docs/true-value-pricing.md; reference model lib/truevalue.js (the database tests compare against it).
--
-- With flow_pricing = 'book' (the default) nothing that exists behaves differently:
--   - every existing function keeps its body, except two that gain a branch which only acts on rows this file's NEW functions write
--     (_auto_pool_value_trades: correction and true-value entries are not "exchange valuations"; _pool_guard_pending: skipped inside a true-value flow only);
--   - the new admin functions refuse to move money unless flow_pricing = 'true_value'; the status functions only read.
--
-- A true-value deposit or payout:
--   1. reads the newest report of every wallet (_wallet_nav: all fresh, none suspect or outdated, within 10 minutes of each other, the expected number of wallets),
--   2. refuses while a closed trade is waiting to be booked or a bot exit has no booked MEXC trade yet, or while the exchange and the books (+ open P&L) differ
--      by more than the tolerance, or when something was booked after the reports were taken,
--   3. prices at V / units, V = Σ wallet equity − money waiting in the exchange − money redeemed but not sent (equity already includes the open P&L),
--   4. writes the flow at that price (entry A, through the existing deposit / payout code, so lots, fees, lock-up and payout records stay the same),
--   5. then writes a book entry B = A − open P&L: the open P&L is never left in the book, so when those trades close and the trades mode adds their realized
--      result the price lands exactly where V said (the Oct 28, 2026 double count cannot happen),
--   6. keeps a checkpoint (append-only) with every number and every wallet report used.
-- Rollback: supabase/rollback/20261207000000_rollback_true_value_pricing.sql

insert into public.ledger_settings(key, value) values ('flow_pricing', 'book'), ('tv_exit_match_hours', '12') on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table if not exists public.flow_checkpoints (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('deposit', 'withdrawal')),
  actor uuid not null,
  subject_id bigint not null,                    -- pending_deposits.id or withdrawal_requests.id
  profile_id uuid not null,
  equity_id bigint not null,                     -- entry A (the flow at the true price)
  book_equity_id bigint,                         -- entry B (open P&L taken back out); null when the open P&L was 0
  measured_at timestamptz not null,              -- newest wallet report used
  book_before numeric not null, units_before numeric not null, open_pnl numeric not null, combined_equity numeric not null,
  not_in_pool numeric not null, redeemed_not_sent numeric not null, true_value numeric not null, gap numeric not null, tolerance numeric not null,
  unit_price numeric not null, amount_usdt numeric not null, units numeric not null,
  wallets jsonb not null                          -- every wallet report used: id, received_at, equity, open P&L, withdrawable, positions
);
create table if not exists public.book_corrections (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  amount_usdt numeric not null check (amount_usdt <> 0),
  reason text not null check (length(trim(reason)) >= 20),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'prepared' check (status in ('prepared', 'applied', 'cancelled')),
  applied_at timestamptz, applied_by uuid, equity_id bigint
);
alter table public.flow_checkpoints enable row level security;
alter table public.book_corrections enable row level security;
revoke all on public.flow_checkpoints, public.book_corrections from public, anon, authenticated;
revoke all on sequence public.flow_checkpoints_id_seq, public.book_corrections_id_seq from public, anon, authenticated;

create or replace function public._tv_append_only() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'flow_checkpoints' then raise exception 'checkpoints cannot be changed or deleted'; end if;
  if tg_op = 'DELETE' then raise exception 'book corrections cannot be deleted (cancel a prepared one instead)'; end if;
  if (new.amount_usdt, new.reason, new.evidence, new.created_at) is distinct from (old.amount_usdt, old.reason, old.evidence, old.created_at) then
    raise exception 'a book correction cannot be edited';
  end if;
  if old.status <> 'prepared' then raise exception 'this correction is % and cannot change any more', old.status; end if;
  return new;
end $$;
drop trigger if exists flow_checkpoints_guard on public.flow_checkpoints;
create trigger flow_checkpoints_guard before update or delete on public.flow_checkpoints for each row execute function public._tv_append_only();
drop trigger if exists book_corrections_guard on public.book_corrections;
create trigger book_corrections_guard before update or delete on public.book_corrections for each row execute function public._tv_append_only();

-- ---------------------------------------------------------------- reading the pool at its true value
-- which bot wallet a dashboard exit belongs to (the event id prefix the ledger requires: "ic|" I-Core, "tcore|" T-CORE, none BB-Core)
create or replace function public._tv_wallet_of_event(p_event text) returns text language sql immutable as $$
  select case when p_event like 'ic|%' then 'icore' when p_event like 'tcore|%' then 'tcore' when p_event like '%|%' then null else 'bbcore' end
$$;

-- bot exits (live) for which no MEXC closed trade of the same wallet, coin and side is booked within tv_exit_match_hours before the exit (+15 min after):
-- their money may already be in the wallets but not in the books, so a flow must wait for them
create or replace function public._tv_unmatched_exits() returns int language sql stable security definer set search_path = public as $$
  with h as (select coalesce(_setting('tv_exit_match_hours'), '12')::numeric as hrs),
  ex as (select e.event_id, _tv_wallet_of_event(e.event_id) as wallet, e.symbol, e.side, to_timestamp(e.ts_ms / 1000.0) as at,
                row_number() over (partition by _tv_wallet_of_event(e.event_id), e.symbol, e.side order by e.ts_ms) as k
         from pending_live_exits e where _tv_wallet_of_event(e.event_id) is not null),
  ct as (select c.wallet, c.symbol, c.side, c.closed_at, row_number() over (partition by c.wallet, c.symbol, c.side order by c.closed_at) as k
         from closed_trades c where c.equity_id is not null)
  select count(*)::int from ex
  where not exists (select 1 from ct, h where ct.wallet = ex.wallet and ct.symbol = ex.symbol and ct.side = ex.side and ct.k = ex.k
                    and ct.closed_at <= ex.at + interval '15 minutes' and ct.closed_at >= ex.at - make_interval(hours => h.hrs::int))
$$;

create or replace function public._true_value() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  n jsonb := _wallet_nav(); v_last pool_equity%rowtype; v_units numeric := _total_units(); v_pend numeric := _pending_total(); v_out numeric := _outbound_unsent();
  v_reasons jsonb := '[]'::jsonb; v_eq numeric; v_unr numeric; v_wd numeric; v_V numeric; v_gap numeric; v_tol numeric; v_meas timestamptz; v_unbooked int; v_unm int;
  v_mode text := coalesce(_setting('flow_pricing'), 'book'); v_ok boolean;
begin
  select * into v_last from pool_equity order by id desc limit 1;
  if v_last.id is null or v_units <= 0 then
    v_reasons := v_reasons || jsonb_build_object('code', 'no_units', 'text', 'the pool has no units yet: the first deposit is made the normal way');
  end if;
  v_reasons := v_reasons || coalesce(n->'reasons', '[]'::jsonb);
  select count(*) into v_unbooked from closed_trades where equity_id is null;
  if v_unbooked > 0 then
    v_reasons := v_reasons || jsonb_build_object('code', 'unbooked_trades', 'text', format('%s closed trade(s) are not in the pool value yet: wait for them to be booked', v_unbooked));
  end if;
  v_unm := _tv_unmatched_exits();
  if v_unm > 0 then
    v_reasons := v_reasons || jsonb_build_object('code', 'exits_without_trade', 'text',
      format('%s bot exit(s) have no booked MEXC result yet: their money may already be in the wallets but not in the books', v_unm));
  end if;
  if (n->>'ok')::boolean then
    v_eq := (n->>'combined_equity_usdt')::numeric; v_unr := (n->>'combined_unrealized_usdt')::numeric; v_wd := (n->>'combined_withdrawable_usdt')::numeric;
    select max((w->>'received_at')::timestamptz) into v_meas from jsonb_array_elements(n->'wallets') w;
    v_V := v_eq - v_pend - v_out;
    if v_last.id is not null then
      v_gap := v_V - (v_last.equity_usdt + v_unr);
      v_tol := greatest(coalesce(_setting('pool_recon_tol_abs'), '0.5')::numeric, abs(v_V) * coalesce(_setting('pool_recon_tol_pct'), '0.0005')::numeric);
      if abs(v_gap) > v_tol then
        v_reasons := v_reasons || jsonb_build_object('code', 'gap', 'text', format('the exchange (%s) and the books + open P&L (%s) differ by %s (tolerance %s): money not recorded, a trade not booked, or fees; explain it first',
          round(v_V, 2), round(v_last.equity_usdt + v_unr, 2), round(v_gap, 2), round(v_tol, 2)));
      end if;
      if v_last.ts > v_meas then
        v_reasons := v_reasons || jsonb_build_object('code', 'booked_after_reading', 'text', 'something was booked after the newest wallet report: wait for the next report (every 5 minutes)');
      end if;
    end if;
    if v_V <= 0 then v_reasons := v_reasons || jsonb_build_object('code', 'not_positive', 'text', 'the pool value is not positive'); end if;
  end if;
  v_ok := jsonb_array_length(v_reasons) = 0;
  return jsonb_build_object('mode', v_mode, 'enabled', v_mode = 'true_value', 'ok', v_ok, 'allowed', v_ok and v_mode = 'true_value', 'reasons', v_reasons,
    'as_of', _clock(), 'measured_at', v_meas, 'wallets', n->'wallets',
    'book_usdt', v_last.equity_usdt, 'units', v_units, 'book_price', case when v_units > 0 then v_last.equity_usdt / v_units end,
    'combined_equity_usdt', v_eq, 'open_pnl_usdt', v_unr, 'not_in_pool_usdt', v_pend, 'redeemed_not_sent_usdt', v_out,
    'true_value_usdt', v_V, 'gap_usdt', v_gap, 'tolerance_usdt', v_tol,
    'unit_price', case when v_ok and v_units > 0 then v_V / v_units end,
    'withdrawable_usdt', v_wd, 'pool_cash_usdt', case when v_wd is not null then greatest(0, v_wd - v_pend - v_out) end);
end $$;

-- entry B: the same units, the open P&L taken back out of the value (the price drops back to the book price; it rises again as those trades close)
create or replace function public._tv_book_entry(p_open numeric, p_at timestamptz, p_actor uuid, p_note text) returns bigint language plpgsql security definer set search_path = public as $$
declare l pool_equity%rowtype; v_id bigint;
begin
  if p_open = 0 then return null; end if;
  select * into l from pool_equity order by id desc limit 1;
  if l.equity_usdt - p_open <= 0 then raise exception 'the open P&L (%) is larger than the pool value: refused', p_open; end if;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (p_at, 'update', l.equity_usdt - p_open, l.total_units, (l.equity_usdt - p_open) / l.total_units, l.php_rate,
          format('Book value: open trades (%s USDT) stay out of the book until they close (%s)', round(p_open, 4), p_note), p_actor) returning id into v_id;
  return v_id;
end $$;

create or replace function public._tv_wallets_used(t jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('wallet', w->>'wallet', 'snapshot_id', w->'snapshot_id', 'received_at', w->'received_at', 'equity_usdt', w->'equity_usdt',
    'unrealized_usdt', w->'unrealized_usdt', 'withdrawable_usdt', w->'withdrawable_usdt', 'open_positions', w->'open_positions')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(t->'wallets', '[]'::jsonb)) w
$$;

create or replace function public._tv_require() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t jsonb := _true_value();
begin
  if not (t->>'enabled')::boolean then raise exception 'true-value pricing is off (flow_pricing = %): use the normal deposit / payout steps', t->>'mode'; end if;
  if not (t->>'ok')::boolean then
    raise exception 'blocked: %', (select string_agg(x->>'text', '; ') from jsonb_array_elements(t->'reasons') x);
  end if;
  return t;
end $$;

-- ---------------------------------------------------------------- deposit at true value
create or replace function public.admin_admit_deposit_tv(p_token text, p_pending bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; pd pending_deposits%rowtype; t jsonb; v_at timestamptz; v_price numeric; v_units numeric; v_open numeric;
  v_led bigint; v_eq bigint; v_book bigint; v_cp bigint; v_u0 numeric; v_b0 numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_admit_deposit_tv'); if v_res is not null then return v_res; end if;
  select * into pd from pending_deposits where id = p_pending for update;
  if not found then raise exception 'unknown deposit'; end if;
  if pd.status = 'converted' then raise exception 'duplicate refused: this deposit was already admitted (%)', pd.admitted_at; end if;
  if pd.status = 'cancelled' then raise exception 'this deposit was handed back and cannot be admitted'; end if;
  if pd.arrived_at is null then raise exception 'queued: this money is not confirmed as received in MEXC yet, so it stays outside the pool'; end if;
  t := _tv_require();
  v_open := (t->>'open_pnl_usdt')::numeric; v_price := (t->>'unit_price')::numeric; v_u0 := (t->>'units')::numeric; v_b0 := (t->>'book_usdt')::numeric;
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)));
  perform set_config('ledger.tv_ctx', 'on', true);
  v_units := _convert_pending(p_pending, v_price, v_at, v_actor);                  -- entry A: units, lot, lock-up, exactly as the normal path
  perform set_config('ledger.tv_ctx', '', true);
  select ledger_id into v_led from pending_deposits where id = p_pending;
  select equity_id into v_eq from ledger where id = v_led;
  v_book := _tv_book_entry(v_open, v_at, v_actor, 'deposit #' || p_pending);        -- entry B
  update pending_deposits set admitted_at = now(), admitted_by = v_actor where id = p_pending;
  insert into flow_checkpoints(kind, actor, subject_id, profile_id, equity_id, book_equity_id, measured_at, book_before, units_before, open_pnl, combined_equity,
    not_in_pool, redeemed_not_sent, true_value, gap, tolerance, unit_price, amount_usdt, units, wallets)
  values ('deposit', v_actor, p_pending, pd.profile_id, v_eq, v_book, (t->>'measured_at')::timestamptz, v_b0, v_u0, v_open, (t->>'combined_equity_usdt')::numeric,
    (t->>'not_in_pool_usdt')::numeric, (t->>'redeemed_not_sent_usdt')::numeric, (t->>'true_value_usdt')::numeric, (t->>'gap_usdt')::numeric, (t->>'tolerance_usdt')::numeric,
    v_price, pd.usdt, v_units, _tv_wallets_used(t)) returning id into v_cp;
  perform _check_books();
  perform _wf_snapshot(coalesce(v_book, v_eq), null, 'deposit_admitted');
  perform _wf_event(v_actor, 'deposit', p_pending, 'deposit_admitted_true_value',
    jsonb_build_object('usdt', pd.usdt, 'units', v_units, 'unit_price', v_price, 'open_pnl', v_open, 'checkpoint_id', v_cp), v_eq, null, pd.profile_id);
  return _idem_put(p_idem, 'admin_admit_deposit_tv', jsonb_build_object('units', v_units, 'unit_price', v_price, 'equity_id', v_eq, 'book_equity_id', v_book,
    'ledger_id', v_led, 'checkpoint_id', v_cp, 'open_pnl', v_open), v_actor);
end $$;

-- ---------------------------------------------------------------- payout at true value (normal payout out of the exchange; a sale to the manager stays on the normal path)
create or replace function public.admin_execute_withdrawal_tv(p_token text, p_request bigint, p_php_rate numeric default null, p_note text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; r withdrawal_requests%rowtype; t jsonb; v_at timestamptz; v_force boolean; v_rate numeric; v_out jsonb;
  v_open numeric; v_led bigint; v_eq bigint; v_book bigint; v_pay_id bigint; v_cp bigint; v_u0 numeric; v_b0 numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_execute_withdrawal_tv'); if v_res is not null then return v_res; end if;
  select * into r from withdrawal_requests where id = p_request for update;
  if not found then raise exception 'unknown withdrawal request'; end if;
  if r.stage = 'redeemed' or r.status = 'paid' then raise exception 'duplicate refused: this request was already redeemed'; end if;
  if r.status <> 'pending' then raise exception 'this request is %', r.stage; end if;
  if r.stage <> 'approved' then raise exception 'approve the request first (it is %)', r.stage; end if;
  if _wf_in_lockup(r.profile_id) and not r.lock_exception then
    raise exception 'this person is inside the lock-up shown to investors: approve the request again with a written reason for the exception';
  end if;
  t := _tv_require();
  v_open := (t->>'open_pnl_usdt')::numeric; v_u0 := (t->>'units')::numeric; v_b0 := (t->>'book_usdt')::numeric;
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)));
  v_force := coalesce(_setting('lock_enforced'), '0') = '1' and r.lock_exception;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  if v_force then perform _check_min_withdrawal(r.profile_id, r.units, (t->>'unit_price')::numeric, v_rate); end if;
  perform set_config('ledger.tv_ctx', 'on', true);
  -- the existing payout engine, given the verified exchange total: it prices at (total − waiting − unsent) / units = the true price, takes the fee on the lot's
  -- gain at that price, the lock-up and minimum rules, and writes entry A
  v_out := _admin_withdraw_core(p_token, r.profile_id, r.units, (t->>'combined_equity_usdt')::numeric, v_rate, p_note, v_force, r.id, v_at, null, true);
  perform set_config('ledger.tv_ctx', '', true);
  select ledger_id into v_led from withdrawal_requests where id = p_request;
  select equity_id into v_eq from ledger where id = v_led;
  v_book := _tv_book_entry(v_open, v_at, v_actor, 'payout request #' || p_request);
  insert into payout_records(request_id, profile_id, ledger_id, equity_id, amount_usdt, php_rate, leaves_mexc, created_by)
  values (p_request, r.profile_id, v_led, v_eq, (v_out->>'pay_usdt')::numeric, v_rate, true, v_actor) returning id into v_pay_id;
  insert into flow_checkpoints(kind, actor, subject_id, profile_id, equity_id, book_equity_id, measured_at, book_before, units_before, open_pnl, combined_equity,
    not_in_pool, redeemed_not_sent, true_value, gap, tolerance, unit_price, amount_usdt, units, wallets)
  values ('withdrawal', v_actor, p_request, r.profile_id, v_eq, v_book, (t->>'measured_at')::timestamptz, v_b0, v_u0, v_open, (t->>'combined_equity_usdt')::numeric,
    (t->>'not_in_pool_usdt')::numeric, (t->>'redeemed_not_sent_usdt')::numeric, (t->>'true_value_usdt')::numeric, (t->>'gap_usdt')::numeric, (t->>'tolerance_usdt')::numeric,
    (v_out->>'unit_price')::numeric, (v_out->>'pay_usdt')::numeric, r.units, _tv_wallets_used(t)) returning id into v_cp;
  perform _check_books();
  perform _wf_snapshot(coalesce(v_book, v_eq), null, 'withdrawal_executed');
  perform _wf_event(v_actor, 'withdrawal', p_request, 'withdrawal_executed_true_value',
    jsonb_build_object('units', r.units, 'pay_usdt', v_out->'pay_usdt', 'fee_units', v_out->'fee_units', 'unit_price', v_out->'unit_price', 'open_pnl', v_open, 'checkpoint_id', v_cp),
    v_eq, null, r.profile_id);
  return _idem_put(p_idem, 'admin_execute_withdrawal_tv', v_out || jsonb_build_object('payout_id', v_pay_id, 'equity_id', v_eq, 'book_equity_id', v_book, 'checkpoint_id', v_cp), v_actor);
end $$;

-- ---------------------------------------------------------------- book corrections (prepared rows; applying one needs the manager and a person's decision)
create or replace function public.admin_book_corrections(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from book_corrections c), '[]'::jsonb);
end $$;

create or replace function public.admin_apply_book_correction(p_token text, p_id bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; c book_corrections%rowtype; l pool_equity%rowtype; v_at timestamptz; v_eq bigint; v_new numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_apply_book_correction'); if v_res is not null then return v_res; end if;
  select * into c from book_corrections where id = p_id for update;
  if not found then raise exception 'unknown correction'; end if;
  if c.status <> 'prepared' then raise exception 'duplicate refused: this correction is already %', c.status; end if;
  if exists (select 1 from closed_trades where equity_id is null) then raise exception 'a closed trade is waiting to be booked: let it be booked first'; end if;
  select * into l from pool_equity order by id desc limit 1;
  if l.id is null or l.total_units <= 0 then raise exception 'the pool has no units'; end if;
  v_new := l.equity_usdt + c.amount_usdt;
  if v_new <= 0 then raise exception 'the correction would take the pool to zero or below'; end if;
  v_at := _at(null);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'update', v_new, l.total_units, v_new / l.total_units, l.php_rate, format('Correction #%s (%s USDT): %s', c.id, c.amount_usdt, c.reason), v_actor)
  returning id into v_eq;
  update book_corrections set status = 'applied', applied_at = now(), applied_by = v_actor, equity_id = v_eq where id = p_id;
  perform _check_books();
  perform _audit(v_actor, 'book_correction_applied', null, jsonb_build_object('correction_id', p_id, 'amount', c.amount_usdt, 'reason', c.reason, 'evidence', c.evidence, 'equity_id', v_eq));
  return _idem_put(p_idem, 'admin_apply_book_correction', jsonb_build_object('equity_id', v_eq, 'equity_before', l.equity_usdt, 'equity_after', v_new,
    'price_before', l.unit_price, 'price_after', v_new / l.total_units), v_actor);
end $$;

-- ---------------------------------------------------------------- what the pages show
-- manager: the whole reading, the reasons, the checkpoints
create or replace function public.admin_true_value(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return _true_value() || jsonb_build_object('checkpoints', coalesce((select jsonb_agg(to_jsonb(c) order by c.id desc) from (select * from flow_checkpoints order by id desc limit 50) c), '[]'::jsonb),
    'corrections', coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from book_corrections b), '[]'::jsonb));
end $$;

-- any signed-in person: their own value at the true price, what can leave the exchange now (their share of the withdrawable cash after money waiting and payouts
-- promised), the part locked in open trades, and whether money can join or leave now (with the reason when not). Nobody else's numbers.
create or replace function public.my_true_value(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := _me(p_token); t jsonb := _true_value(); v_u numeric := _units_of(v_me); v_tot numeric; v_price numeric; v_val numeric; v_cash numeric; v_wd numeric;
begin
  v_tot := (t->>'units')::numeric; v_price := (t->>'unit_price')::numeric;
  v_val := case when v_price is not null then v_u * v_price end;
  v_cash := (t->>'pool_cash_usdt')::numeric;
  v_wd := case when v_val is not null and v_cash is not null and v_tot > 0 then least(v_val, v_u / v_tot * v_cash) end;
  return jsonb_build_object('enabled', t->'enabled', 'allowed', t->'allowed', 'reasons', (select coalesce(jsonb_agg(x->>'text'), '[]'::jsonb) from jsonb_array_elements(t->'reasons') x),
    'as_of', t->'as_of', 'units', v_u, 'unit_price', v_price, 'book_price', t->'book_price', 'value_usdt', v_val, 'withdrawable_now_usdt', v_wd,
    'locked_in_trades_usdt', case when v_val is not null and v_wd is not null then v_val - v_wd end);
end $$;

-- ---------------------------------------------------------------- the two existing functions that learn about the new entries
-- inside a true-value flow the pending-exit guard is replaced by the stricter true-value checks (booked MEXC result per exit); everywhere else it is unchanged
create or replace function public._pool_guard_pending() returns void language plpgsql stable security definer set search_path = public as $$
declare p jsonb;
begin
  if coalesce(current_setting('ledger.tv_ctx', true), '') = 'on' then return; end if;
  if _wallet_mode() = 'require' then return; end if;
  if coalesce(_setting('pool_update_gate'), 'on') <> 'on' then return; end if;
  p := _pool_pending();
  if (p->>'count')::int > 0 then
    raise exception 'pending P/L: % closed live trade(s) (%) are not applied to the pool yet. Click Update Pool first, then accept joiners or pay out.',
      p->>'count', case when (p->>'missing_usd')::int > 0 then 'dollar amount not shared' else round((p->>'usd')::numeric, 2)::text || ' USDT' end;
  end if;
end $$;

-- trades mode: a correction is not an exchange valuation (it never "contains" a late trade); a true-value flow contains exactly the trades its wallet reports
-- had seen, per wallet (a trade of wallet W that closed before W's report is inside V, so it is not added again)
create or replace function public._auto_pool_value_trades(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := _clock(); v_last pool_equity%rowtype; v_u numeric; v_n int; v_real numeric; v_run numeric; v_eq bigint; v_first bigint; v_cnt int := 0; r record;
  v_jump numeric := coalesce(_setting('bot_max_jump'), '0.15')::numeric; v_old int; v_manual pool_equity%rowtype; v_tv int;
begin
  perform _ledger_lock();
  if coalesce(_setting('bot_sync_paused'), '0') = '1' then return _auto_skip(p_source, 'paused', 'automatic valuation is paused (bot_sync_paused)'); end if;
  v_u := _total_units();
  if v_u = 0 then return jsonb_build_object('ok', false, 'skipped', 'no_units'); end if;
  if coalesce(_setting('auto_pool_pause_on_payout'), '1') = '1' and exists (select 1 from withdrawal_requests where status = 'pending' and stage = 'approved') then
    return _auto_skip(p_source, 'payout_in_progress', 'a withdrawal is approved and not paid yet: it is recorded first, then the trades are added');
  end if;
  select * into v_last from pool_equity order by id desc limit 1;
  if v_last.id is null then return _auto_skip(p_source, 'no_baseline', 'there is no booked pool value to roll forward from'); end if;

  -- the newest value a PERSON took from the exchange: not this routine's own entries, not a correction, not a true-value flow (handled per wallet below)
  select * into v_manual from pool_equity p where not exists (select 1 from auto_pool_runs a where a.equity_id = p.id)
    and not exists (select 1 from book_corrections b where b.equity_id = p.id)
    and not exists (select 1 from flow_checkpoints f where f.equity_id = p.id or f.book_equity_id = p.id)
    order by id desc limit 1;
  if v_manual.id is not null then
    with x as (update closed_trades set equity_id = v_manual.id, reflected_at = v_now where equity_id is null and closed_at <= v_manual.ts returning 1)
    select count(*) into v_old from x;
    if v_old > 0 then
      perform _pool_log('auto_pool', 'trades_already_in_value', jsonb_build_object('mismatch', v_old, 'equity_id', v_manual.id,
        'text', format('%s closed trade(s) closed before the exchange valuation #%s: they are treated as already included, not added again', v_old, v_manual.id)));
    end if;
  end if;
  with cp as (select f.id, f.equity_id, w->>'wallet' as wallet, (w->>'received_at')::timestamptz as seen from flow_checkpoints f, jsonb_array_elements(f.wallets) w),
  x as (update closed_trades c set equity_id = (select cp.equity_id from cp where cp.wallet = c.wallet and c.closed_at <= cp.seen order by cp.id desc limit 1), reflected_at = v_now
        where c.equity_id is null and exists (select 1 from cp where cp.wallet = c.wallet and c.closed_at <= cp.seen) returning 1)
  select count(*) into v_tv from x;
  if v_tv > 0 then
    perform _pool_log('auto_pool', 'trades_already_in_value', jsonb_build_object('mismatch', v_tv,
      'text', format('%s closed trade(s) were already in a wallet report used by a true-value deposit or payout: not added again', v_tv)));
  end if;

  select count(*), coalesce(sum(realized_usd), 0) into v_n, v_real from closed_trades where equity_id is null;
  if v_n = 0 then return jsonb_build_object('ok', false, 'skipped', 'nothing_new'); end if;
  if v_last.equity_usdt + v_real <= 0 then return _auto_skip(p_source, 'not_positive', 'the closed trades would take the pool to zero or below: check them by hand'); end if;
  if v_last.equity_usdt > 0 and abs(v_real) / v_last.equity_usdt > v_jump then
    return _auto_skip(p_source, 'jump', format('the %s waiting trade(s) move the pool by %s%% (limit %s%%): check them, then value by hand.',
      v_n, round(v_real / v_last.equity_usdt * 100, 2), round(v_jump * 100)));
  end if;

  v_run := v_last.equity_usdt;
  for r in select id, symbol, side, closed_at, realized_usd from closed_trades where equity_id is null order by closed_at, id loop
    v_run := v_run + r.realized_usd;
    if v_run <= 0 then raise exception 'the closed trades would take the pool to zero or below at trade %', r.id; end if;
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
    values (_at(greatest(least(r.closed_at, now()), v_last.ts)), 'update', v_run, v_u, v_run / v_u, _last_php_rate(),
            format('Auto (%s): %s %s closed%s, realized %s USDT', p_source, regexp_replace(r.symbol, '_USDT$', ''), r.side,
                   case when r.closed_at < v_last.ts then ' ' || to_char(r.closed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC (reported late)' else '' end,
                   round(r.realized_usd, 2)), null)
    returning id into v_eq;
    v_last.ts := greatest(least(r.closed_at, now()), v_last.ts);
    v_first := coalesce(v_first, v_eq); v_cnt := v_cnt + 1;
    insert into auto_pool_runs(equity_id, nav_before, nav_after, unit_price, unrealized_after, trades, realized_usd, residual, residual_flag)
    values (v_eq, v_run - r.realized_usd, v_run, v_run / v_u, null, 1, r.realized_usd, null, false);
    update closed_trades set equity_id = v_eq, reflected_at = v_now where id = r.id;
  end loop;
  perform _check_books();
  return jsonb_build_object('ok', true, 'equity_id', v_eq, 'first_equity_id', v_first, 'unit_price', v_run / v_u, 'nav_before', v_last.equity_usdt, 'nav_after', v_run, 'trades', v_cnt, 'realized_usd', v_real);
end $$;

-- ---------------------------------------------------------------- backup coverage (the nightly backup and the manager's export carry both new tables)
do $$
begin
  if to_regprocedure('public._export_extra_pre_tv()') is null then
    alter function public._export_extra() rename to _export_extra_pre_tv;
  end if;
end $$;
revoke all on function public._export_extra_pre_tv() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_tv() || jsonb_build_object('flow_checkpoints', _dump_table('flow_checkpoints'), 'book_corrections', _dump_table('book_corrections'))
$$;
revoke all on function public._export_extra() from public, anon, authenticated;

-- ---------------------------------------------------------------- permissions
revoke all on function public._tv_append_only(), public._tv_wallet_of_event(text), public._tv_unmatched_exits(), public._true_value(), public._tv_book_entry(numeric, timestamptz, uuid, text),
  public._tv_wallets_used(jsonb), public._tv_require(), public._pool_guard_pending(), public._auto_pool_value_trades(text) from public, anon, authenticated;
revoke all on function public.admin_admit_deposit_tv(text, bigint, text), public.admin_execute_withdrawal_tv(text, bigint, numeric, text, text),
  public.admin_book_corrections(text), public.admin_apply_book_correction(text, bigint, text), public.admin_true_value(text), public.my_true_value(text) from public;
grant execute on function public.admin_admit_deposit_tv(text, bigint, text), public.admin_execute_withdrawal_tv(text, bigint, numeric, text, text),
  public.admin_book_corrections(text), public.admin_apply_book_correction(text, bigint, text), public.admin_true_value(text), public.my_true_value(text) to anon, authenticated;
notify pgrst, 'reload schema';

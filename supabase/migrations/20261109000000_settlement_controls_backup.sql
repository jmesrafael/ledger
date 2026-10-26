-- SETTLEMENT CONTROLS + COMPLETE BACKUP. Run after 20261108000000_settlement_workflow_integration.sql. NOT applied to any database. Safe to run twice.
-- No accounting formula changes: units, prices, the high-water mark, the 10% fee and Fund M's split are exactly as before.
-- It changes WHEN a settlement is allowed and WHAT is recorded and audited.
--
-- 1. SETTLEMENT WINDOW (Manila time). A period's settlement must be made within settlement_window_days (7) after the period ends. After that it
--    is LATE: it is refused unless a 'late' exception was approved (written reason, logged). Otherwise wait for the next window: that
--    settlement covers everything since the last one (nothing is skipped, the high-water mark carries on), and no settlement can follow
--    one a day later. Each settlement now saves the dates it actually covers, how many days after the period end it was valued, whether
--    it was late, and the exceptions it used.
-- 1b. NO BACKDATING. The window is judged on the LATER of the valuation date and the real recording time, so a settlement recorded after the
--    window cannot be dated into it. A settlement dated more than settlement_backdate_minutes (60) before the moment it is recorded is refused
--    unless a 'backdated' exception was approved (written reason, logged). Each settlement saves both times (valued_at, recorded_at) and
--    whether it was backdated; existing rows are not changed.
-- 2. RECONCILIATION OR AN AUDITED EXCEPTION. A settlement needs (a) a verified bot snapshot, or (b) the newest confirmed balance check for the
--    same Exchange total. A typed note alone is no longer a verification: it is an EXCEPTION ('unreconciled'), approved with
--    admin_approve_settlement_exception (or the older admin_attest_settlement, now a wrapper), with the open positions declared, written
--    to the activity log, and saved on the settlement. An internal mismatch or an unmatched Exchange transfer can never be excepted.
-- 3. NO FEES ON OPEN-TRADE GAINS by default. If any position or order is open (balance check, bot snapshot or the declaration), the
--    settlement is refused unless an 'open_positions' exception was approved (written reason, logged).
-- 4. A direct insert of a quarter close into pool_equity is refused unless it comes from admin_close_quarter (settle_guard).
-- 4b. CLOSES A LIVE EXPOSURE. On Supabase every new function is callable by the public website role (anon) unless it is revoked. Four internal helpers
--    that take no token were left that way by earlier migrations: _export_all() (the WHOLE ledger export), _account_since, _check_min_withdrawal and
--    _exit_fee_rate. This migration revokes all four (the app's own functions run as the owner and are not affected).
-- 5. BACKUP COVERS EVERY TABLE: payout_details, idempotency_keys, holder_state, the draft archives and settlement_exceptions join the export.
--    admin_backup_coverage lists any table that is neither exported nor deliberately excluded (sessions, backup_keys: secrets;
--    app_settings, backtest_runs: the backtester, not the ledger). scripts/restore-ledger.mjs turns a backup into a restore script.

do $$
begin
  if to_regclass('public.settlements') is null or to_regprocedure('public._verified_balance_check(numeric)') is null
     or to_regprocedure('public._fund_m_period(jsonb,jsonb,numeric,numeric)') is null or to_regprocedure('public._wf_ready(bigint)') is null then
    raise exception 'preflight: run 20261108000000_settlement_workflow_integration.sql first. Nothing was changed.';
  end if;
end $$;

insert into public.ledger_settings(key, value) values ('settlement_window_days', '7'), ('settlement_backdate_minutes', '60') on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables and columns
create table if not exists public.settlement_exceptions (
  id             bigserial primary key,
  kind           text not null,
  period_end     timestamptz not null,
  mexc_total     numeric not null check (mexc_total > 0),
  open_positions int check (open_positions between 0 and 50),     -- positions + orders the manager declares are open (unreconciled / open_positions)
  note           text not null check (length(trim(note)) >= 20),
  recon          jsonb,
  attestation_id bigint references public.settlement_attestations(id),
  created_by     uuid not null references public.profiles(id),
  ts             timestamptz not null default now()
);
alter table public.settlement_exceptions drop constraint if exists settlement_exceptions_kind_check;
alter table public.settlement_exceptions add constraint settlement_exceptions_kind_check check (kind in ('unreconciled', 'late', 'open_positions', 'backdated'));
alter table public.settlement_exceptions enable row level security;
revoke all on public.settlement_exceptions from public, anon, authenticated;
revoke all on sequence public.settlement_exceptions_id_seq from public, anon, authenticated;
drop trigger if exists settlement_exceptions_append_only on public.settlement_exceptions;
create trigger settlement_exceptions_append_only before update or delete on public.settlement_exceptions for each row execute function public._no_change();

alter table public.settlements add column if not exists covered_from timestamptz;
alter table public.settlements add column if not exists covered_to timestamptz;
alter table public.settlements add column if not exists days_after_period_end numeric;
alter table public.settlements add column if not exists late boolean not null default false;
alter table public.settlements add column if not exists backdated_days numeric;
alter table public.settlements add column if not exists exception_ids bigint[] not null default '{}';
alter table public.settlements add column if not exists open_positions_at_settlement int;
alter table public.settlements add column if not exists recorded_at timestamptz;                        -- when the settlement was actually recorded (valued_at is the date it carries)
alter table public.settlements add column if not exists backdated boolean not null default false;

-- the moment a settlement is being recorded. It is now(); it sits behind one function only so that the tests can set the time.
create or replace function public._clock() returns timestamptz language sql stable security definer set search_path = public as $$ select now() $$;

-- ---------------------------------------------------------------- helpers
-- the newest approved exception of this kind for this period and Exchange total that no settlement has used yet
create or replace function public._settlement_exception(p_kind text, p_period_end timestamptz, p_total numeric) returns bigint
language sql stable security definer set search_path = public as $$
  select x.id from settlement_exceptions x
   where x.kind = p_kind and x.period_end = p_period_end and abs(x.mexc_total - p_total) <= _wf_tol(p_total)
     and not exists (select 1 from settlements s where x.id = any(s.exception_ids))
   order by x.id desc limit 1
$$;

-- the newest confirmed balance check, if it is for this exchange total and every difference is explained (open positions are judged separately)
create or replace function public._settlement_check(p_total numeric, out o_id bigint, out o_open int)
language plpgsql stable security definer set search_path = public as $$
declare v balance_verifications%rowtype; rd jsonb; s exchange_snapshots%rowtype; v_bad boolean;
begin
  select * into v from balance_verifications where status = 'confirmed' order by id desc limit 1;
  if not found or abs(v.mexc_total - p_total) > _wf_tol(p_total) then return; end if;
  rd := _wf_ready(v.id);
  select exists (select 1 from jsonb_array_elements(rd->'reasons') x where x->>'code' <> 'open_positions') into v_bad;
  if v_bad then return; end if;
  select * into s from exchange_snapshots where ts > v.entered_at order by id desc limit 1;
  o_id := v.id;
  o_open := greatest(v.open_positions + v.open_orders, case when not v.flat then 1 else 0 end, coalesce(s.open_positions + s.open_orders, 0));
end $$;

-- everything that stands between this request and a final settlement: window, reconciliation, open trades. One place, used by the
-- preview and by the settlement itself, so they cannot disagree.
create or replace function public._settlement_requirements(p_equity numeric, p_at timestamptz, p_rec jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_per record; v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_sched text := coalesce(_setting('settlement_schedule'), 'bimonthly');
  v_win int := coalesce(nullif(_setting('settlement_window_days'), '')::int, 7); v_tz text := coalesce(_setting('settlement_tz'), 'Asia/Manila');
  v_block jsonb := '[]'::jsonb; v_ids bigint[] := '{}'; v_rec jsonb := p_rec; v_win_end timestamptz; v_late boolean := false; v_x bigint;
  v_chk record; v_bv bigint; v_att bigint; v_open int; v_now timestamptz := _clock(); v_back boolean := false;
begin
  select * into v_per from _settlement_period(p_at);
  if v_sched = 'bimonthly' then
    -- a settlement dated before the moment it is recorded must say so: it needs its own audited exception
    v_back := p_at < v_now - make_interval(mins => coalesce(nullif(_setting('settlement_backdate_minutes'), '')::int, 60));
    if v_back then
      v_x := _settlement_exception('backdated', v_per.o_end, p_equity);
      if v_x is null then
        v_block := v_block || to_jsonb(format('BACKDATED: this settlement is dated %s but is being recorded %s hours later. A settlement carries the date it is recorded, so a late settlement cannot be dated into the window. Record it now (leave the date empty), or approve a backdated exception with a written reason.',
          to_char(p_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'), round(extract(epoch from v_now - p_at) / 3600, 1)));
      else v_ids := v_ids || v_x; end if;
    end if;
    -- the window is judged on the later of the valuation date and the recording time
    v_win_end := v_per.o_end + make_interval(days => v_win);
    v_late := greatest(p_at, v_now) >= v_win_end;
    if v_late then
      v_x := _settlement_exception('late', v_per.o_end, p_equity);
      if v_x is null then
        v_block := v_block || to_jsonb(format('LATE: the settlement window for the period ending %s closed on %s. Settle in the next window (from %s): it covers everything since the last settlement. Or approve a late exception with a written reason.',
          (v_per.o_end at time zone v_tz)::date - 1, (v_win_end at time zone v_tz)::date - 1, (v_per.o_next at time zone v_tz)::date));
      else v_ids := v_ids || v_x; end if;
    end if;
  end if;
  if v_mode <> 'off' then
    if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then
      v_block := v_block || to_jsonb('settlement refused, nothing was saved: ' || coalesce(v_rec->'reasons'->>0, v_rec->>'status'));
    else
      select * into v_chk from _settlement_check(p_equity);
      if v_rec->>'status' = 'unverified' and v_chk.o_id is not null then
        v_rec := v_rec || jsonb_build_object('status', 'verified_manual', 'balance_verification_id', v_chk.o_id, 'reasons_before', v_rec->'reasons', 'reasons', '[]'::jsonb);
      end if;
      if v_rec->>'status' = 'verified_manual' then
        v_bv := v_chk.o_id; v_open := v_chk.o_open;
      elsif v_rec->>'status' = 'verified' then
        v_open := coalesce((v_rec->'last_snapshot'->>'open_positions')::int, 0) + coalesce((v_rec->'last_snapshot'->>'open_orders')::int, 0);
      else
        v_x := _settlement_exception('unreconciled', v_per.o_end, p_equity);
        if v_x is null then
          v_block := v_block || to_jsonb('RECONCILE: this period is not reconciled with the exchange (' || coalesce((select string_agg(r, '; ') from jsonb_array_elements_text(v_rec->'reasons') r), 'no verification')
            || '). Enter and confirm this exchange balance (balance check), or approve an exception for this exchange total (admin_approve_settlement_exception) with a written reason and the open positions declared.');
        else
          select open_positions, attestation_id into v_open, v_att from settlement_exceptions where id = v_x;
          v_ids := v_ids || v_x;
          if v_open is null then
            v_block := v_block || to_jsonb('OPEN TRADES: say how many positions and orders are open on the exchange (declare them in the exception: admin_approve_settlement_exception).'::text);
          end if;
        end if;
      end if;
      if coalesce(v_open, 0) > 0 then
        v_x := _settlement_exception('open_positions', v_per.o_end, p_equity);
        if v_x is null then
          v_block := v_block || to_jsonb(format('OPEN TRADES: %s position(s)/order(s) are open on the exchange, so the balance includes gains that are not realized yet. Close them and settle, or approve an open_positions exception with a written reason.', v_open));
        else v_ids := v_ids || v_x; end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('blocked', v_block, 'late', v_late, 'backdated', v_back, 'recorded_at', v_now, 'window_end', v_win_end, 'period_end', v_per.o_end, 'bv', v_bv, 'att', v_att,
                            'open_positions', v_open, 'exception_ids', to_jsonb(v_ids), 'rec', v_rec);
end $$;

-- ---------------------------------------------------------------- approving an exception
create or replace function public.admin_approve_settlement_exception(p_token text, p_kind text, p_equity numeric, p_note text,
    p_at timestamptz default null, p_open int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_at timestamptz := coalesce(p_at, now()); v_per record; v_rec jsonb; v_att bigint; v_id bigint;
begin
  perform _ledger_lock();
  if p_kind not in ('unreconciled', 'late', 'open_positions', 'backdated') then raise exception 'the exception is unreconciled, late, backdated or open_positions'; end if;
  if p_equity is null or p_equity <= 0 then raise exception 'enter the exchange total this exception is for'; end if;
  if p_note is null or length(trim(p_note)) < 20 then raise exception 'write the reason for the exception (at least 20 characters)'; end if;
  if p_kind in ('unreconciled', 'open_positions') and (p_open is null or p_open < 0) then
    raise exception 'say how many positions and orders are open on the exchange right now (0 if none)';
  end if;
  if p_kind = 'open_positions' and p_open = 0 then raise exception 'an open_positions exception is for open trades: declare how many are open'; end if;
  select * into v_per from _settlement_period(v_at);
  v_rec := _settlement_recon((select max(id) from pool_equity), p_equity, _price_from(p_equity), v_at);
  if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then
    raise exception 'this cannot be explained away: % (fix it first)', v_rec->'reasons'->>0;
  end if;
  if p_kind = 'unreconciled' then
    insert into settlement_attestations(period_end, mexc_total, recon, note, created_by) values (v_per.o_end, p_equity, v_rec, trim(p_note), v_actor) returning id into v_att;
  end if;
  insert into settlement_exceptions(kind, period_end, mexc_total, open_positions, note, recon, attestation_id, created_by)
  values (p_kind, v_per.o_end, p_equity, p_open, trim(p_note), v_rec, v_att, v_actor) returning id into v_id;
  perform _audit(v_actor, 'settlement_exception_' || p_kind, null,
    jsonb_build_object('exception_id', v_id, 'period_end', v_per.o_end, 'mexc_total', p_equity, 'open_positions', p_open, 'note', trim(p_note), 'recon_status', v_rec->>'status'));
  return jsonb_build_object('id', v_id, 'kind', p_kind, 'period_end', v_per.o_end, 'recon_status', v_rec->>'status');
end $$;

-- the older call: a written explanation for an unreconciled period. It is an 'unreconciled' exception now, so it must also say how many
-- positions are open (new last argument); without that the settlement is refused.
drop function if exists public.admin_attest_settlement(text, numeric, text, timestamptz);
create or replace function public.admin_attest_settlement(p_token text, p_equity numeric, p_note text, p_at timestamptz default null, p_open int default null) returns jsonb
language sql security definer set search_path = public as $$
  select public.admin_approve_settlement_exception(p_token, 'unreconciled', p_equity, p_note, p_at, p_open)
$$;

-- a close can only come from admin_close_quarter
create or replace function public._settle_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'close' and new.reversed_of is null and coalesce(current_setting('ledger.settle_ctx', true), '') <> '1' then
    raise exception 'blocked: a settlement can only be made through admin_close_quarter';
  end if;
  return new;
end $$;
drop trigger if exists settle_guard on public.pool_equity;
create trigger settle_guard before insert on public.pool_equity for each row execute function public._settle_guard();

-- ---------------------------------------------------------------- the settlement (1108's body + the controls)
create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record;
  v_lastc timestamptz; v_fee numeric; v_total numeric := 0; v_total_usd numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb;
  v_gap int := coalesce(_setting('min_days_between_closes'), '0')::int; v_res jsonb; v_flag text; v_per record; v_rec jsonb;
  v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_att bigint; v_u numeric; v_h numeric; v_e numeric; v_late int; v_fm jsonb;
  v_from bigint; v_bv bigint; v_pp numeric; v_fm0 jsonb; v_period jsonb; v_req jsonb; v_cfrom timestamptz; v_ids bigint[]; v_open int; v_now timestamptz := _clock();
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_close_quarter'); if v_res is not null then return v_res; end if;
  v_at := _at(p_at); u := _total_units();
  if u = 0 then raise exception 'no units yet'; end if;
  select max(ts) into v_lastc from pool_equity where kind = 'close';
  if v_gap > 0 and v_lastc is not null and v_at < v_lastc + make_interval(days => v_gap) then
    raise exception 'the last settlement was on %; the next one is allowed from %', v_lastc::date, (v_lastc + make_interval(days => v_gap))::date;
  end if;
  select * into v_per from _settlement_period(v_at);
  if v_per.o_end <= (select min(ts) from pool_equity) then
    raise exception 'no settlement period has ended yet: the first one can be settled from %', (v_per.o_next at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date;
  end if;
  if coalesce(_setting('settlement_schedule'), 'bimonthly') = 'bimonthly' and v_lastc is not null and v_lastc >= v_per.o_end then
    raise exception 'the period ending % is already settled; the next settlement is allowed from %',
      (v_per.o_end at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date - 1, (v_per.o_next at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date;
  end if;
  perform _settlement_gate(p_equity);
  v_nav := _net_equity(p_equity);
  v_flag := _check_move(v_nav, p_confirm);
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  select count(*) into v_late from pool_equity where ts >= v_per.o_end and kind in ('deposit', 'withdrawal');
  perform set_config('ledger.settle_ctx', '1', true);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', v_nav, u, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform set_config('ledger.settle_ctx', '', true);

  -- never finalize fees on an unexplained difference, a late period or open trades without a reconciliation or an audited exception
  v_rec := _settlement_recon(v_eq_id, p_equity, null, v_at);
  v_req := _settlement_requirements(p_equity, v_at, v_rec);
  if jsonb_array_length(v_req->'blocked') > 0 then raise exception '%', v_req->'blocked'->>0; end if;
  v_rec := v_req->'rec';
  v_bv := nullif(v_req->>'bv', '')::bigint; v_att := nullif(v_req->>'att', '')::bigint; v_open := nullif(v_req->>'open_positions', '')::int;
  v_ids := coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(v_req->'exception_ids') x), '{}');

  v_from := _last_close(v_eq_id);
  v_cfrom := case when v_from > 0 then (select ts from pool_equity where id = v_from) else (select min(ts) from pool_equity) end;
  v_fm0 := _fund_m_state(v_from + 1);
  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_eq_id);
    v_u := _units_of(r.id); v_h := _hwm_value(r.id);
    v_e := v_u * v_price;
    v_fee := _hwm_close(r.id, v_price, r.fee_rate, v_eq_id);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)');
      v_total := v_total + v_fee; v_total_usd := v_total_usd + round(v_fee * v_price, 6); v_n := v_n + 1;
    end if;
    insert into settlement_lines(equity_id, profile_id, units_before, unit_price, value_before, hwm_before, eligible_profit, fee_rate, fee_units, fee_usdt, hwm_after, period_profit_usdt)
    values (v_eq_id, r.id, v_u, v_price, v_e, v_h, v_e - v_h, r.fee_rate, v_fee, round(v_fee * v_price, 6), _hwm_value(r.id), v_pp);
  end loop;
  v_fm := _fund_m_state(v_eq_id + 1);
  v_period := _fund_m_period(v_fm0, v_fm, v_total_usd, (v_rec->>'fees_at_withdrawals_usdt')::numeric);
  v_fm := v_fm || jsonb_build_object('period', v_period);
  insert into settlements(equity_id, period_start, period_end, valued_at, mexc_total, nav, total_units, unit_price, opening_nav, deposits_usdt,
      withdrawals_usdt, trading_pnl_usdt, entries_after_period_end, fee_basis, investors_charged, fee_units, fee_usdt, fund_m, recon, recon_status, attestation_id, created_by,
      balance_verification_id, covered_from, covered_to, days_after_period_end, late, backdated_days, exception_ids, open_positions_at_settlement, recorded_at, backdated)
  values (v_eq_id, v_per.o_start, v_per.o_end, v_at, p_equity, v_nav, u, v_price, (v_rec->>'opening_nav')::numeric, (v_rec->>'deposits_usdt')::numeric,
      (v_rec->>'withdrawals_usdt')::numeric, (v_rec->>'trading_pnl_usdt')::numeric, v_late, coalesce(_setting('fee_basis'), 'external_investors'), v_n, v_total, v_total_usd,
      v_fm, v_rec, v_rec->>'status', v_att, v_actor,
      v_bv, v_cfrom, v_at, round(extract(epoch from v_at - v_per.o_end) / 86400, 3), (v_req->>'late')::boolean,
      round(greatest(0, extract(epoch from v_now - v_at) / 86400)::numeric, 3), v_ids, v_open, v_now, coalesce((v_req->>'backdated')::boolean, false));
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);
  perform _check_books();
  perform _audit(v_actor, 'settlement_closed', null, jsonb_build_object('settlement_id', currval('settlements_id_seq'), 'equity_id', v_eq_id, 'period_end', v_per.o_end,
    'covered_from', v_cfrom, 'covered_to', v_at, 'recorded_at', v_now, 'late', (v_req->>'late')::boolean, 'backdated', coalesce((v_req->>'backdated')::boolean, false), 'recon_status', v_rec->>'status', 'balance_verification_id', v_bv,
    'exception_ids', v_ids, 'open_positions', v_open, 'investors_charged', v_n, 'fee_usdt', v_total_usd, 'mexc_total', p_equity));
  return _idem_put(p_idem, 'admin_close_quarter', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'fee_usdt', v_total_usd,
    'converted', v_conv->'converted', 'settlement_id', currval('settlements_id_seq'), 'period_start', v_per.o_start, 'period_end', v_per.o_end,
    'covered_from', v_cfrom, 'covered_to', v_at, 'recorded_at', v_now, 'late', (v_req->>'late')::boolean, 'backdated', coalesce((v_req->>'backdated')::boolean, false), 'exception_ids', to_jsonb(v_ids),
    'recon_status', v_rec->>'status', 'attestation_id', v_att, 'balance_verification_id', v_bv, 'fund_m_period', v_period), v_actor);
end $$;

create or replace function public.admin_settlement_preview(p_token text, p_equity numeric, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_at timestamptz := coalesce(p_at, now()); v_per record; v_price numeric; v_nav numeric; v_rec jsonb; v_lines jsonb := '[]'::jsonb; r record; v_u numeric; v_h numeric;
  v_e numeric; v_fee numeric; v_tot numeric := 0; v_totu numeric := 0; v_block jsonb := '[]'::jsonb; v_lastc timestamptz; v_last pool_equity%rowtype;
  v_from bigint; v_fm0 jsonb; v_fm jsonb; v_pp numeric; v_req jsonb;
begin
  perform _admin(p_token);
  if _total_units() = 0 then raise exception 'no units yet'; end if;
  v_nav := _net_equity(p_equity); v_price := _price_from(p_equity);
  select * into v_per from _settlement_period(v_at);
  select * into v_last from pool_equity order by id desc limit 1;
  select max(ts) into v_lastc from pool_equity where kind = 'close';
  if v_per.o_end <= (select min(ts) from pool_equity) then v_block := v_block || to_jsonb('no settlement period has ended yet'::text); end if;
  if v_at < v_last.ts then v_block := v_block || to_jsonb(format('the date must be after the last entry (%s)', v_last.ts)); end if;
  if coalesce(_setting('settlement_schedule'), 'bimonthly') = 'bimonthly' and v_lastc is not null and v_lastc >= v_per.o_end then
    v_block := v_block || to_jsonb(format('the period ending %s is already settled; next from %s', (v_per.o_end at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date - 1,
      (v_per.o_next at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date));
  end if;
  v_rec := _settlement_recon(v_last.id, p_equity, v_price, v_at);
  v_req := _settlement_requirements(p_equity, v_at, v_rec);
  v_rec := v_req->'rec';
  v_block := v_block || (v_req->'blocked');
  v_from := _last_close(v_last.id + 1);
  for r in select p.id, p.name, p.username, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_last.id, v_price);
    v_u := _units_of(r.id); v_h := _hwm_value(r.id);
    v_e := v_u * v_price;
    v_fee := _fee_units(r.fee_rate, v_e - v_h, 1, 1, v_price);
    v_tot := v_tot + round(v_fee * v_price, 6); v_totu := v_totu + v_fee;
    v_lines := v_lines || jsonb_build_object('profile_id', r.id, 'name', r.name, 'username', r.username, 'units', v_u, 'value_usdt', v_e, 'period_profit_usdt', v_pp,
      'hwm_usdt', v_h, 'eligible_profit_usdt', v_e - v_h, 'fee_rate', r.fee_rate, 'fee_units', v_fee, 'fee_usdt', round(v_fee * v_price, 6),
      'value_after_usdt', v_e - v_fee * v_price, 'hwm_after_usdt', case when v_e > v_h then v_e - v_fee * v_price else v_h end);
  end loop;
  v_fm0 := _fund_m_state(v_from + 1);
  v_fm := _fund_m_state(null);
  v_fm := jsonb_set(jsonb_set(v_fm, '{capital,value_usdt}', to_jsonb((v_fm->'capital'->>'units')::numeric * v_price)),
                    '{capital,profit_usdt}', to_jsonb((v_fm->'capital'->>'units')::numeric * v_price + (v_fm->'capital'->>'withdrawn_usdt')::numeric - (v_fm->'capital'->>'contributed_usdt')::numeric));
  return jsonb_build_object('balance_verification_id', nullif(v_req->>'bv', '')::bigint, 'can_settle', jsonb_array_length(v_block) = 0, 'blocked_reasons', v_block,
    'period_start', v_per.o_start, 'period_end', v_per.o_end, 'next_period_end', v_per.o_next, 'valued_at', v_at,
    'window_end', v_req->'window_end', 'late', v_req->'late', 'backdated', v_req->'backdated', 'recorded_at', v_req->'recorded_at', 'open_positions', v_req->'open_positions', 'exception_ids', v_req->'exception_ids',
    'covered_from', case when v_from > 0 then (select ts from pool_equity where id = v_from) else (select min(ts) from pool_equity) end,
    'mexc_total', p_equity, 'nav', v_nav, 'unit_price', v_price, 'total_units', _total_units(),
    'fee_basis', coalesce(_setting('fee_basis'), 'external_investors'), 'fee_usdt', v_tot, 'fee_units', v_totu, 'lines', v_lines,
    'recon', v_rec, 'fund_m', v_fm || jsonb_build_object('period', _fund_m_period(v_fm0, v_fm, v_tot, (v_rec->>'fees_at_withdrawals_usdt')::numeric)),
    'waiting_deposits_admitted_after', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profile_id', profile_id, 'usdt', usdt))
       from pending_deposits where status = 'pending' and (arrived_at is not null or coalesce(_setting('settlement_gate'), 'off') <> 'on')), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- complete backups
create or replace function public._dump_table(p_table text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if to_regclass('public.' || quote_ident(p_table)) is null then return '[]'::jsonb; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', p_table) into v;
  return v;
end $$;

create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payout_details', _dump_table('payout_details'),
    'idempotency_keys', _dump_table('idempotency_keys'),
    'holder_state', _dump_table('holder_state'),
    'investor_perf_draft_archive', _dump_table('investor_perf_draft_archive'),
    'perf_log_draft_archive', _dump_table('perf_log_draft_archive'),
    'settlement_exceptions', _dump_table('settlement_exceptions'))
$$;

create or replace function public._export_all() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_all_core() || _wf_export() || _export_extra()
$$;

-- any ledger table that is neither in the backup nor deliberately left out
create or replace function public.admin_backup_coverage(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_keys text[]; v_excl text[] := array['sessions', 'backup_keys', 'app_settings', 'backtest_runs'];
begin
  perform _admin(p_token);
  select array_agg(k) into v_keys from jsonb_object_keys(_export_all()) k;
  return jsonb_build_object(
    'missing', coalesce((select jsonb_agg(t.table_name order by t.table_name) from information_schema.tables t
                          where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> all (v_excl)
                            and coalesce(case t.table_name when 'profiles' then 'people' when 'ledger_settings' then 'settings' end, t.table_name) <> all (v_keys)), '[]'::jsonb),
    'excluded', to_jsonb(v_excl),
    'excluded_why', 'sessions and backup_keys hold secrets; app_settings and backtest_runs belong to the backtester, not the ledger');
end $$;

-- ---------------------------------------------------------------- access
revoke all on function public._account_since(uuid), public._check_min_withdrawal(uuid, numeric, numeric, numeric), public._exit_fee_rate(uuid),
  public._clock(), public._settlement_exception(text, timestamptz, numeric), public._settlement_check(numeric), public._settlement_requirements(numeric, timestamptz, jsonb),
  public._settle_guard(), public._dump_table(text), public._export_extra(), public._export_all() from public, anon, authenticated;
revoke all on function public.admin_approve_settlement_exception(text, text, numeric, text, timestamptz, int), public.admin_attest_settlement(text, numeric, text, timestamptz, int),
  public.admin_backup_coverage(text), public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_settlement_preview(text, numeric, timestamptz) from public;
grant execute on function public.admin_approve_settlement_exception(text, text, numeric, text, timestamptz, int), public.admin_attest_settlement(text, numeric, text, timestamptz, int),
  public.admin_backup_coverage(text), public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_settlement_preview(text, numeric, timestamptz) to anon, authenticated;

-- the API layer reads the function list at start-up; tell it the functions changed
notify pgrst, 'reload schema';

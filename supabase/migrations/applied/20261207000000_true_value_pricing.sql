-- True-value pricing for deposits, payouts and the period-end settlement; book corrections; checkpoints. OFF by default: ledger_settings.flow_pricing = 'book'.
-- Design and the maths: docs/true-value-pricing.md; reference model lib/truevalue.js (the database tests compare against it).
--
-- With flow_pricing = 'book' (the default) nothing that exists behaves differently:
--   - every existing function keeps its body, except two that gain a branch which only acts on rows this file's NEW functions write
--     (_auto_pool_value_trades: correction and true-value entries are not "exchange valuations"; _pool_guard_pending: skipped inside a true-value flow only);
--   - a new trigger on pool entries does nothing unless flow_pricing = 'true_value' (then the old typed-total steps are refused: see _tv_guard_pool_entry);
--   - the new admin functions refuse to move money unless flow_pricing = 'true_value'; the status and preview functions only read.
--
-- A true-value deposit, payout or settlement:
--   1. reads the newest report of every wallet (_wallet_nav: all fresh, none suspect or outdated, within 10 minutes of each other, the expected number of wallets),
--      or, for a deposit that arrived earlier, the complete set of reports as of a given moment (_wallet_nav_at),
--   2. refuses while a closed trade is waiting to be booked, a bot exit has no booked MEXC result yet, the exchange and the books (+ open P&L) differ by more than
--      the tolerance, or something other than an automatic trade booking or a correction was written after the reports,
--   3. prices at V / units, V = Σ wallet equity − money waiting in the exchange − money redeemed but not sent (equity already includes the open P&L),
--   4. writes the flow at that price through the existing engines (entry A: lots, fees, lock-up, payout records, settlement lines stay the existing code),
--   5. then writes a book entry B = books + gap ± the flow: the open P&L is never left in the book, so when those trades close and the trades mode adds their
--      realized result the price lands exactly where V said (the Oct 28, 2026 double count cannot happen),
--   6. keeps a checkpoint (append-only) with every number and every wallet report used.
-- Every function runs in one transaction (all or nothing) and takes an idempotency key: a retry with the same key returns the first answer; the same deposit, payout
-- or correction can never be applied twice.
-- Rollback: supabase/rollback/20261207000000_rollback_true_value_pricing.sql

insert into public.ledger_settings(key, value) values ('flow_pricing', 'book'), ('tv_exit_match_hours', '12') on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table if not exists public.flow_checkpoints (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('deposit', 'withdrawal', 'settlement')),
  actor uuid not null,
  subject_id bigint,                             -- pending_deposits.id, withdrawal_requests.id or settlements.id
  profile_id uuid,                               -- the person (null for a settlement)
  equity_id bigint not null,                     -- entry A (the flow at the true price)
  book_equity_id bigint,                         -- entry B (books + gap ± flow); null when it equals entry A
  priced_as_of timestamptz not null,             -- the moment the reading describes (now, or the as-of time of an earlier arrival)
  measured_at timestamptz not null,              -- newest wallet report used
  book_before numeric not null, units_before numeric not null, open_pnl numeric not null, combined_equity numeric not null,
  not_in_pool numeric not null, redeemed_not_sent numeric not null, true_value numeric not null, gap numeric not null, tolerance numeric not null,
  realized_since numeric not null default 0,     -- closed-trade results booked between priced_as_of and the flow (as-of deposits only)
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

-- while true-value pricing is on, a person can write a pool entry only through the true-value functions (or a correction): the old steps value the pool from a
-- typed exchange total with the open trades inside it, which the trades mode would then add a second time. Automatic trade bookings (no person) are unaffected,
-- and so is the very first deposit (no units yet). With flow_pricing = 'book' this does nothing.
create or replace function public._tv_guard_pool_entry() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(_setting('flow_pricing'), 'book') = 'true_value' and new.created_by is not null
     and coalesce(current_setting('ledger.tv_ctx', true), '') <> 'on' and (select coalesce(sum(units), 0) from ledger) > 0 then
    raise exception 'true-value pricing is on: a % entry must go through the true-value deposit, payout or settlement (the old step would put the open trades into the book)', new.kind;
  end if;
  return new;
end $$;
drop trigger if exists tv_guard_pool_entry on public.pool_equity;
create trigger tv_guard_pool_entry before insert on public.pool_equity for each row execute function public._tv_guard_pool_entry();

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

-- the same reading as _wallet_nav, but as of a past moment: each wallet's newest report received at or before p_as_of, judged on that moment's clock
create or replace function public._wallet_nav_at(p_as_of timestamptz) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_exp int := _wf_setnum('wallet_expected_count', 2)::int; v_age numeric := _wf_setnum('wallet_max_age_minutes', 30) * 60;
  v_skew numeric := _wf_setnum('wallet_max_skew_minutes', 10) * 60; r record; s wallet_snapshots%rowtype; v_wallets jsonb := '[]'::jsonb; v_reasons jsonb := '[]'::jsonb;
  v_active int := 0; v_ok int := 0; v_eq numeric := 0; v_unr numeric := 0; v_wd numeric := 0; v_min timestamptz; v_max timestamptz; v_sent timestamptz; v_status text; v_all boolean;
begin
  select max(sent_at) into v_sent from payout_records where leaves_mexc and sent_at is not null and sent_at <= p_as_of;
  for r in select * from bot_wallets where active order by wallet loop
    v_active := v_active + 1;
    select * into s from wallet_snapshots where wallet = r.wallet and received_at <= p_as_of order by seq desc limit 1;
    if not found then v_status := 'missing';
    elsif extract(epoch from p_as_of - s.received_at) > v_age then v_status := 'stale';
    elsif s.suspect and s.accepted_at is null then v_status := 'suspect';
    elsif v_sent is not null and s.received_at < v_sent then v_status := 'outdated';
    else v_status := 'ok'; end if;
    v_wallets := v_wallets || jsonb_build_object('wallet', r.wallet, 'label', r.label, 'status', v_status, 'snapshot_id', s.id, 'received_at', s.received_at,
      'age_seconds', case when s.id is null then null else round(extract(epoch from p_as_of - s.received_at)) end,
      'equity_usdt', s.equity_usdt, 'unrealized_usdt', s.unrealized_usdt, 'withdrawable_usdt', s.withdrawable_usdt, 'available_usdt', s.available_usdt,
      'open_positions', s.open_positions, 'open_orders', s.open_orders, 'suspect', coalesce(s.suspect and s.accepted_at is null, false));
    if v_status = 'ok' then
      v_ok := v_ok + 1; v_eq := v_eq + s.equity_usdt; v_unr := v_unr + coalesce(s.unrealized_usdt, 0); v_wd := v_wd + s.withdrawable_usdt;
      v_min := least(coalesce(v_min, s.received_at), s.received_at); v_max := greatest(coalesce(v_max, s.received_at), s.received_at);
    else
      v_reasons := v_reasons || jsonb_build_object('wallet', r.wallet, 'code', v_status, 'text', case v_status
        when 'missing' then format('wallet %s had not reported by %s', r.wallet, p_as_of)
        when 'stale' then format('wallet %s had last reported %s minutes before %s (limit %s)', r.wallet, round(extract(epoch from p_as_of - s.received_at) / 60), p_as_of, round(v_age / 60))
        when 'suspect' then format('wallet %s report at that time is marked suspect and not accepted', r.wallet)
        else format('a payout left the exchange after wallet %s last reported before %s', r.wallet, p_as_of) end);
    end if;
  end loop;
  if v_active < v_exp then v_reasons := v_reasons || jsonb_build_object('wallet', null, 'code', 'wallet_count', 'text', format('only %s of the %s expected wallets are registered and active', v_active, v_exp)); end if;
  if v_ok = v_active and v_active >= 2 and (extract(epoch from v_max - v_min)) > v_skew then
    v_reasons := v_reasons || jsonb_build_object('wallet', null, 'code', 'skewed', 'text', format('the wallets reported %s minutes apart (limit %s)', round(extract(epoch from v_max - v_min) / 60), round(v_skew / 60)));
  end if;
  v_all := jsonb_array_length(v_reasons) = 0 and v_active >= v_exp and v_active > 0;
  return jsonb_build_object('ok', v_all, 'reasons', v_reasons, 'wallets', v_wallets, 'as_of', p_as_of,
    'combined_equity_usdt', case when v_all then v_eq end, 'combined_unrealized_usdt', case when v_all then v_unr end, 'combined_withdrawable_usdt', case when v_all then v_wd end);
end $$;

-- p_as_of null: now. p_as_of given: the pool as of that moment (books then + corrections applied since; only automatic trade bookings and corrections may follow it).
-- p_book_adjust: a hypothetical change of the books, for the correction preview only.
create or replace function public._true_value(p_as_of timestamptz default null, p_book_adjust numeric default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_hist boolean := p_as_of is not null; n jsonb; v_last pool_equity%rowtype; v_hrow pool_equity%rowtype; v_units numeric := _total_units();
  v_pend numeric := _pending_total(); v_out numeric := _outbound_unsent(); v_reasons jsonb := '[]'::jsonb; v_book numeric; v_book_now numeric; v_corr numeric := 0;
  v_eq numeric; v_unr numeric; v_wd numeric; v_V numeric; v_gap numeric; v_tol numeric; v_meas timestamptz; v_unbooked int; v_unm int; v_after int;
  v_mode text := coalesce(_setting('flow_pricing'), 'book'); v_ok boolean;
begin
  n := case when v_hist then _wallet_nav_at(p_as_of) else _wallet_nav() end;
  select * into v_last from pool_equity order by id desc limit 1;
  if v_last.id is null or v_units <= 0 then
    v_reasons := v_reasons || jsonb_build_object('code', 'no_units', 'text', 'the pool has no units yet: the first deposit is made the normal way');
  end if;
  v_book_now := v_last.equity_usdt + p_book_adjust;
  if v_hist and v_last.id is not null then
    if p_as_of > _clock() then v_reasons := v_reasons || jsonb_build_object('code', 'future', 'text', 'the as-of time is in the future'); end if;
    select * into v_hrow from pool_equity where ts <= p_as_of order by id desc limit 1;
    if v_hrow.id is null then
      v_reasons := v_reasons || jsonb_build_object('code', 'before_pool', 'text', 'the pool did not exist at that time');
    else
      select coalesce(sum(c.amount_usdt), 0) into v_corr from book_corrections c where c.status = 'applied' and c.equity_id > v_hrow.id;
      v_book := v_hrow.equity_usdt + v_corr + p_book_adjust;
      select count(*) into v_after from pool_equity e where e.id > v_hrow.id
        and not exists (select 1 from auto_pool_runs a where a.equity_id = e.id) and not exists (select 1 from book_corrections b where b.equity_id = e.id);
      if v_after > 0 then
        v_reasons := v_reasons || jsonb_build_object('code', 'flows_after_reading', 'text',
          format('%s deposit, payout, valuation or settlement entr%s came after that time: the pool cannot be priced as of then any more', v_after, case when v_after = 1 then 'y' else 'ies' end));
      end if;
    end if;
  else
    v_book := v_book_now;
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
    if v_book is not null then
      v_gap := v_V - (v_book + v_unr);
      v_tol := greatest(coalesce(_setting('pool_recon_tol_abs'), '0.5')::numeric, abs(v_V) * coalesce(_setting('pool_recon_tol_pct'), '0.0005')::numeric);
      if abs(v_gap) > v_tol then
        v_reasons := v_reasons || jsonb_build_object('code', 'gap', 'text', format('the exchange (%s) and the books + open P&L (%s) differ by %s (tolerance %s): money not recorded, a trade not booked, or fees; explain it first',
          round(v_V, 2), round(v_book + v_unr, 2), round(v_gap, 2), round(v_tol, 2)));
      end if;
      if not v_hist and v_last.ts > v_meas then
        v_reasons := v_reasons || jsonb_build_object('code', 'booked_after_reading', 'text', 'something was booked after the newest wallet report: wait for the next report (every 5 minutes)');
      end if;
    end if;
    if v_V <= 0 then v_reasons := v_reasons || jsonb_build_object('code', 'not_positive', 'text', 'the pool value is not positive'); end if;
  end if;
  v_ok := jsonb_array_length(v_reasons) = 0;
  return jsonb_build_object('mode', v_mode, 'enabled', v_mode = 'true_value', 'ok', v_ok, 'allowed', v_ok and v_mode = 'true_value', 'reasons', v_reasons,
    'as_of', _clock(), 'priced_as_of', coalesce(p_as_of, v_meas), 'measured_at', v_meas, 'wallets', n->'wallets',
    'book_usdt', v_book, 'book_now_usdt', v_book_now, 'realized_since_usdt', case when v_hist then v_book_now - v_book else 0 end,
    'units', v_units, 'book_price', case when v_units > 0 then v_book_now / v_units end,
    'combined_equity_usdt', v_eq, 'open_pnl_usdt', v_unr, 'not_in_pool_usdt', v_pend, 'redeemed_not_sent_usdt', v_out,
    'true_value_usdt', v_V, 'gap_usdt', v_gap, 'tolerance_usdt', v_tol,
    'unit_price', case when v_ok and v_units > 0 then v_V / v_units end,
    'withdrawable_usdt', v_wd, 'pool_cash_usdt', case when v_wd is not null then greatest(0, v_wd - v_pend - v_out) end);
end $$;

create or replace function public._tv_require(p_as_of timestamptz default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t jsonb := _true_value(p_as_of);
begin
  if not (t->>'enabled')::boolean then raise exception 'true-value pricing is off (flow_pricing = %): use the normal deposit / payout / settlement steps', t->>'mode'; end if;
  if not (t->>'ok')::boolean then
    raise exception 'blocked: %', (select string_agg(x->>'text', '; ') from jsonb_array_elements(t->'reasons') x);
  end if;
  return t;
end $$;

-- entry B: the same units, the book set to p_target (books + gap ± the flow). Nothing is written when entry A already equals it (no open P&L, no realized since).
create or replace function public._tv_set_book(p_target numeric, p_at timestamptz, p_actor uuid, p_note text) returns bigint language plpgsql security definer set search_path = public as $$
declare l pool_equity%rowtype; v_id bigint;
begin
  select * into l from pool_equity order by id desc limit 1;
  if abs(l.equity_usdt - p_target) < 0.000001 then return null; end if;
  if p_target <= 0 then raise exception 'the book value would be zero or below (%): refused', p_target; end if;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (p_at, 'update', p_target, l.total_units, p_target / l.total_units, l.php_rate,
          format('Book value: open trades (%s USDT) stay out of the book until they close (%s)', round(l.equity_usdt - p_target, 4), p_note), p_actor) returning id into v_id;
  return v_id;
end $$;

create or replace function public._tv_wallets_used(t jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('wallet', w->>'wallet', 'snapshot_id', w->'snapshot_id', 'received_at', w->'received_at', 'equity_usdt', w->'equity_usdt',
    'unrealized_usdt', w->'unrealized_usdt', 'withdrawable_usdt', w->'withdrawable_usdt', 'open_positions', w->'open_positions')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(t->'wallets', '[]'::jsonb)) w
$$;

create or replace function public._tv_checkpoint(p_kind text, p_actor uuid, p_subject bigint, p_profile uuid, p_eq bigint, p_book bigint, t jsonb, p_price numeric, p_amount numeric, p_units numeric)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into flow_checkpoints(kind, actor, subject_id, profile_id, equity_id, book_equity_id, priced_as_of, measured_at, book_before, units_before, open_pnl, combined_equity,
    not_in_pool, redeemed_not_sent, true_value, gap, tolerance, realized_since, unit_price, amount_usdt, units, wallets)
  values (p_kind, p_actor, p_subject, p_profile, p_eq, p_book, (t->>'priced_as_of')::timestamptz, (t->>'measured_at')::timestamptz, (t->>'book_usdt')::numeric, (t->>'units')::numeric,
    (t->>'open_pnl_usdt')::numeric, (t->>'combined_equity_usdt')::numeric, (t->>'not_in_pool_usdt')::numeric, (t->>'redeemed_not_sent_usdt')::numeric,
    (t->>'true_value_usdt')::numeric, (t->>'gap_usdt')::numeric, (t->>'tolerance_usdt')::numeric, (t->>'realized_since_usdt')::numeric, p_price, p_amount, p_units, _tv_wallets_used(t))
  returning id into v;
  return v;
end $$;

-- ---------------------------------------------------------------- deposits at true value (one or several, now or as of an earlier complete reading)
create or replace function public.admin_admit_deposits_tv(p_token text, p_pending bigint[], p_as_of timestamptz default null, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; pd pending_deposits%rowtype; t jsonb; v_at timestamptz; v_price numeric; v_units numeric; v_sum numeric := 0;
  v_led bigint; v_eq bigint; v_book bigint; v_out jsonb := '[]'::jsonb; v_id bigint; v_target numeric; v_cps bigint[] := '{}'; v_rows jsonb := '[]'::jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_admit_deposits_tv'); if v_res is not null then return v_res; end if;
  if p_pending is null or cardinality(p_pending) = 0 then raise exception 'choose the deposit(s) to admit'; end if;
  if cardinality(p_pending) <> (select count(distinct x) from unnest(p_pending) x) then raise exception 'the same deposit is listed twice'; end if;
  foreach v_id in array p_pending loop
    select * into pd from pending_deposits where id = v_id for update;
    if not found then raise exception 'unknown deposit %', v_id; end if;
    if pd.status = 'converted' then raise exception 'duplicate refused: deposit % was already admitted (%)', v_id, pd.admitted_at; end if;
    if pd.status = 'cancelled' then raise exception 'deposit % was handed back and cannot be admitted', v_id; end if;
    if pd.arrived_at is null then raise exception 'queued: deposit % is not confirmed as received in MEXC yet, so it stays outside the pool', v_id; end if;
  end loop;
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(p_as_of);
  v_price := (t->>'unit_price')::numeric;
  v_at := _at(case when p_as_of is null then greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)) end);
  foreach v_id in array p_pending loop
    select * into pd from pending_deposits where id = v_id;
    v_units := _convert_pending(v_id, v_price, v_at, v_actor);                        -- entry A: units, lot, lock-up, exactly as the normal path
    select ledger_id into v_led from pending_deposits where id = v_id;
    select equity_id into v_eq from ledger where id = v_led;
    update pending_deposits set admitted_at = now(), admitted_by = v_actor where id = v_id;
    v_sum := v_sum + pd.usdt;
    v_rows := v_rows || jsonb_build_object('pending', v_id, 'profile', pd.profile_id, 'usdt', pd.usdt, 'units', v_units, 'equity_id', v_eq, 'ledger_id', v_led);
  end loop;
  -- entry B: books (now, so including any trade booked since an as-of time) + the gap of the reading + the money in
  v_target := (t->>'book_now_usdt')::numeric + (t->>'gap_usdt')::numeric + v_sum;
  v_book := _tv_set_book(v_target, v_at, v_actor, 'deposits ' || array_to_string(p_pending, ', ') || case when p_as_of is not null then ' priced as of ' || p_as_of::text else '' end);
  for v_res in select * from jsonb_array_elements(v_rows) loop
    v_id := _tv_checkpoint('deposit', v_actor, (v_res->>'pending')::bigint, (v_res->>'profile')::uuid, (v_res->>'equity_id')::bigint, v_book, t, v_price,
      (v_res->>'usdt')::numeric, (v_res->>'units')::numeric);
    v_cps := v_cps || v_id;
    perform _wf_event(v_actor, 'deposit', (v_res->>'pending')::bigint, 'deposit_admitted_true_value', jsonb_build_object('usdt', v_res->'usdt', 'units', v_res->'units',
      'unit_price', v_price, 'open_pnl', t->'open_pnl_usdt', 'priced_as_of', t->'priced_as_of', 'checkpoint_id', v_id), (v_res->>'equity_id')::bigint, null, (v_res->>'profile')::uuid);
  end loop;
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  perform _wf_snapshot(coalesce(v_book, v_eq), null, 'deposit_admitted');
  return _idem_put(p_idem, 'admin_admit_deposits_tv', jsonb_build_object('unit_price', v_price, 'priced_as_of', t->'priced_as_of', 'deposits', v_rows,
    'book_equity_id', v_book, 'checkpoint_ids', to_jsonb(v_cps), 'open_pnl', t->'open_pnl_usdt', 'realized_since', t->'realized_since_usdt'), v_actor);
end $$;

-- one deposit, now (the common case)
create or replace function public.admin_admit_deposit_tv(p_token text, p_pending bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  r := admin_admit_deposits_tv(p_token, array[p_pending], null, p_idem);
  return r || jsonb_build_object('units', r->'deposits'->0->'units', 'equity_id', r->'deposits'->0->'equity_id', 'ledger_id', r->'deposits'->0->'ledger_id', 'checkpoint_id', r->'checkpoint_ids'->0);
end $$;

-- ---------------------------------------------------------------- payout at true value (normal payout out of the exchange; a sale to the manager stays on the normal path)
create or replace function public.admin_execute_withdrawal_tv(p_token text, p_request bigint, p_php_rate numeric default null, p_note text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; r withdrawal_requests%rowtype; t jsonb; v_at timestamptz; v_force boolean; v_rate numeric; v_out jsonb;
  v_led bigint; v_eq bigint; v_book bigint; v_pay_id bigint; v_cp bigint;
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
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(null);
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)));
  v_force := coalesce(_setting('lock_enforced'), '0') = '1' and r.lock_exception;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  if v_force then perform _check_min_withdrawal(r.profile_id, r.units, (t->>'unit_price')::numeric, v_rate); end if;
  -- the existing payout engine, given the verified exchange total: it prices at (total − waiting − unsent) / units = the true price, takes the fee on the lot's
  -- gain at that price, the lock-up and minimum rules, and writes entry A
  v_out := _admin_withdraw_core(p_token, r.profile_id, r.units, (t->>'combined_equity_usdt')::numeric, v_rate, p_note, v_force, r.id, v_at, null, true);
  select ledger_id into v_led from withdrawal_requests where id = p_request;
  select equity_id into v_eq from ledger where id = v_led;
  v_book := _tv_set_book((t->>'book_now_usdt')::numeric + (t->>'gap_usdt')::numeric - (v_out->>'pay_usdt')::numeric, v_at, v_actor, 'payout request #' || p_request);
  insert into payout_records(request_id, profile_id, ledger_id, equity_id, amount_usdt, php_rate, leaves_mexc, created_by)
  values (p_request, r.profile_id, v_led, v_eq, (v_out->>'pay_usdt')::numeric, v_rate, true, v_actor) returning id into v_pay_id;
  v_cp := _tv_checkpoint('withdrawal', v_actor, p_request, r.profile_id, v_eq, v_book, t, (v_out->>'unit_price')::numeric, (v_out->>'pay_usdt')::numeric, r.units);
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  perform _wf_snapshot(coalesce(v_book, v_eq), null, 'withdrawal_executed');
  perform _wf_event(v_actor, 'withdrawal', p_request, 'withdrawal_executed_true_value',
    jsonb_build_object('units', r.units, 'pay_usdt', v_out->'pay_usdt', 'fee_units', v_out->'fee_units', 'unit_price', v_out->'unit_price', 'open_pnl', t->'open_pnl_usdt', 'checkpoint_id', v_cp),
    v_eq, null, r.profile_id);
  return _idem_put(p_idem, 'admin_execute_withdrawal_tv', v_out || jsonb_build_object('payout_id', v_pay_id, 'equity_id', v_eq, 'book_equity_id', v_book, 'checkpoint_id', v_cp), v_actor);
end $$;

-- ---------------------------------------------------------------- period-end settlement at true value
-- The same settlement as admin_close_quarter (period rules, per-investor fee above the high-water mark, settlement lines, the fund manager's figures, pending money joining
-- after the fees), but the exchange total is the verified wallet reports instead of a typed number, the ledger's internal consistency check must pass, and the open P&L
-- is taken back out of the book afterwards. The fee is charged on the true price (open P&L included, once); the mark moves to that price, so the later realization
-- of the same profit is never charged again.
create or replace function public.admin_close_quarter_tv(p_token text, p_php_rate numeric default null, p_note text default null, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); t jsonb; v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record; c record;
  v_lastc timestamptz; v_fee numeric; v_total numeric := 0; v_total_usd numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb; v_total_eq numeric;
  v_gap int := coalesce(_setting('min_days_between_closes'), '0')::int; v_res jsonb; v_per record; v_rec jsonb; v_req jsonb; v_late int; v_fm jsonb; v_open int; v_ids bigint[];
  v_from bigint; v_cfrom timestamptz; v_pp numeric; v_fm0 jsonb; v_period jsonb; v_book bigint; v_set bigint; v_cp bigint; v_dep numeric; v_now timestamptz := _clock();
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_close_quarter_tv'); if v_res is not null then return v_res; end if;
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(null);
  v_total_eq := (t->>'combined_equity_usdt')::numeric;
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity))); u := _total_units();
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
  v_nav := (t->>'true_value_usdt')::numeric; v_price := (t->>'unit_price')::numeric;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  select count(*) into v_late from pool_equity where ts >= v_per.o_end and kind in ('deposit', 'withdrawal');
  perform set_config('ledger.settle_ctx', '1', true);              -- the settlement guard recognises a settlement function, as for admin_close_quarter
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', v_nav, u, v_price, v_rate, coalesce(p_note, 'settlement at true value (wallet reports)'), v_actor) returning id into v_eq_id;
  perform set_config('ledger.settle_ctx', '', true);
  -- the ledger's own consistency over the period and the matching of every exchange transfer stay required; the exchange evidence is the verified wallet reports
  -- (passed as 'verified' with their open positions), so the existing rules for late / backdated settlements and for open trades apply unchanged
  v_rec := _settlement_recon(v_eq_id, v_total_eq, null, v_at);
  if v_rec->>'status' not in ('internal_mismatch', 'unmatched_transfers') then
    v_rec := v_rec || jsonb_build_object('status', 'verified', 'reasons_before', v_rec->'reasons', 'reasons', '[]'::jsonb,
      'last_snapshot', jsonb_build_object('source', 'wallet reports', 'equity_usdt', v_total_eq,
        'open_positions', (select coalesce(sum((w->>'open_positions')::int), 0) from jsonb_array_elements(t->'wallets') w), 'open_orders', 0));
  end if;
  v_req := _settlement_requirements(v_total_eq, v_at, v_rec);
  if jsonb_array_length(v_req->'blocked') > 0 then raise exception '%', v_req->'blocked'->>0; end if;
  v_rec := (v_req->'rec') || jsonb_build_object('status', 'verified_true_value', 'true_value', t - 'wallets' - 'reasons', 'wallets', _tv_wallets_used(t));
  v_open := nullif(v_req->>'open_positions', '')::int;
  v_ids := coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(v_req->'exception_ids') x), '{}');
  v_from := _last_close(v_eq_id);
  v_cfrom := case when v_from > 0 then (select ts from pool_equity where id = v_from) else (select min(ts) from pool_equity) end;
  v_fm0 := _fund_m_state(v_from + 1);
  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_eq_id);
    select * into c from _hwm_settle_calc(r.id, v_price, r.fee_rate);
    v_fee := _hwm_close(r.id, v_price, r.fee_rate, v_eq_id);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement, true value)'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement, true value)');
      v_total := v_total + v_fee; v_total_usd := v_total_usd + round(v_fee * v_price, 6); v_n := v_n + 1;
    end if;
    insert into settlement_lines(equity_id, profile_id, units_before, unit_price, value_before, hwm_before, eligible_profit, fee_rate, fee_units, fee_usdt, hwm_after, period_profit_usdt,
        fee_timing, last_value_before, confirmed_profit, pending_profit, rate_applied, last_value_after)
    values (v_eq_id, r.id, c.o_units, v_price, c.o_value, c.o_hwm, c.o_value - c.o_hwm, r.fee_rate, v_fee, round(v_fee * v_price, 6), _hwm_value(r.id), v_pp,
        _fee_timing(), c.o_last, c.o_confirmed, c.o_pending, c.o_rate, c.o_last_after);
  end loop;
  v_fm := _fund_m_state(v_eq_id + 1);
  v_period := _fund_m_period(v_fm0, v_fm, v_total_usd, (v_rec->>'fees_at_withdrawals_usdt')::numeric);
  v_fm := v_fm || jsonb_build_object('period', v_period);
  insert into settlements(equity_id, period_start, period_end, valued_at, mexc_total, nav, total_units, unit_price, opening_nav, deposits_usdt,
      withdrawals_usdt, trading_pnl_usdt, entries_after_period_end, fee_basis, investors_charged, fee_units, fee_usdt, fund_m, recon, recon_status, attestation_id, created_by,
      balance_verification_id, covered_from, covered_to, days_after_period_end, late, backdated_days, exception_ids, open_positions_at_settlement, recorded_at, backdated)
  values (v_eq_id, v_per.o_start, v_per.o_end, v_at, v_total_eq, v_nav, u, v_price, (v_rec->>'opening_nav')::numeric, (v_rec->>'deposits_usdt')::numeric,
      (v_rec->>'withdrawals_usdt')::numeric, (v_rec->>'trading_pnl_usdt')::numeric, v_late, coalesce(_setting('fee_basis'), 'external_investors'), v_n, v_total, v_total_usd,
      v_fm, v_rec, 'verified_true_value', nullif(v_req->>'att', '')::bigint, v_actor,
      null, v_cfrom, v_at, round(extract(epoch from v_at - v_per.o_end) / 86400, 3), (v_req->>'late')::boolean,
      round(greatest(0, extract(epoch from v_now - v_at) / 86400)::numeric, 3), v_ids, v_open, v_now, coalesce((v_req->>'backdated')::boolean, false)) returning id into v_set;
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);       -- waiting money joins after the fees, at the settlement price
  select coalesce(sum(usdt), 0) into v_dep from ledger where kind = 'deposit' and equity_id > v_eq_id;
  v_book := _tv_set_book((t->>'book_now_usdt')::numeric + (t->>'gap_usdt')::numeric + v_dep, v_at, v_actor, 'settlement #' || v_set);
  v_cp := _tv_checkpoint('settlement', v_actor, v_set, null, v_eq_id, v_book, t, v_price, v_total_usd, v_total);
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  perform _audit(v_actor, 'settlement_closed', null, jsonb_build_object('settlement_id', v_set, 'equity_id', v_eq_id, 'period_end', v_per.o_end, 'covered_from', v_cfrom, 'covered_to', v_at,
    'recorded_at', v_now, 'late', (v_req->>'late')::boolean, 'recon_status', 'verified_true_value', 'exception_ids', v_ids, 'open_positions', v_open, 'investors_charged', v_n,
    'fee_usdt', v_total_usd, 'mexc_total', v_total_eq, 'fee_timing', _fee_timing(), 'warnings', v_req->'warnings', 'true_value', true, 'open_pnl', t->'open_pnl_usdt', 'checkpoint_id', v_cp));
  return _idem_put(p_idem, 'admin_close_quarter_tv', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'fee_usdt', v_total_usd,
    'converted', v_conv->'converted', 'settlement_id', v_set, 'period_start', v_per.o_start, 'period_end', v_per.o_end, 'covered_from', v_cfrom, 'covered_to', v_at,
    'late', (v_req->>'late')::boolean, 'exception_ids', to_jsonb(v_ids), 'recon_status', 'verified_true_value', 'equity_id', v_eq_id, 'book_equity_id', v_book,
    'checkpoint_id', v_cp, 'open_positions', v_open, 'fund_m_period', v_period, 'fee_timing', _fee_timing(), 'warnings', v_req->'warnings'), v_actor);
end $$;

-- what the settlement would charge now, at the true price (reads only)
create or replace function public.admin_settlement_preview_tv(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t jsonb; p jsonb;
begin
  perform _admin(p_token);
  t := _true_value(null);
  if (t->>'ok')::boolean then
    begin p := admin_settlement_preview(p_token, (t->>'combined_equity_usdt')::numeric, null);
    exception when others then p := jsonb_build_object('error', sqlerrm); end;
  end if;
  return jsonb_build_object('true_value', t, 'preview', p);
end $$;

-- ---------------------------------------------------------------- book corrections (prepared rows; applying one needs the manager and a person's decision)
create or replace function public.admin_book_corrections(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from book_corrections c), '[]'::jsonb);
end $$;

-- each prepared correction, in order, as if applied one after the other: the book and price after it, and the reconciliation against the exchange at that point
create or replace function public.admin_preview_book_corrections(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l pool_equity%rowtype; c record; v_adj numeric := 0; v_steps jsonb := '[]'::jsonb; t jsonb;
begin
  perform _admin(p_token);
  select * into l from pool_equity order by id desc limit 1;
  t := _true_value(null, 0);
  v_steps := v_steps || jsonb_build_object('step', 'now', 'book_usdt', l.equity_usdt, 'unit_price', l.unit_price, 'gap_usdt', t->'gap_usdt', 'reasons', t->'reasons');
  for c in select * from book_corrections where status = 'prepared' order by id loop
    v_adj := v_adj + c.amount_usdt;
    t := _true_value(null, v_adj);
    v_steps := v_steps || jsonb_build_object('step', 'after correction #' || c.id, 'correction_id', c.id, 'amount_usdt', c.amount_usdt, 'book_usdt', l.equity_usdt + v_adj,
      'unit_price', (l.equity_usdt + v_adj) / l.total_units, 'gap_usdt', t->'gap_usdt', 'tolerance_usdt', t->'tolerance_usdt', 'reasons', t->'reasons');
  end loop;
  return jsonb_build_object('units', l.total_units, 'steps', v_steps);
end $$;

create or replace function public.admin_apply_book_correction(p_token text, p_id bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; c book_corrections%rowtype; l pool_equity%rowtype; v_at timestamptz; v_eq bigint; v_new numeric; t jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_apply_book_correction'); if v_res is not null then return v_res; end if;
  select * into c from book_corrections where id = p_id for update;
  if not found then raise exception 'unknown correction'; end if;
  if c.status <> 'prepared' then raise exception 'duplicate refused: this correction is already %', c.status; end if;
  if exists (select 1 from book_corrections where status = 'prepared' and id < p_id) then raise exception 'apply the corrections in order: an earlier one is still prepared'; end if;
  if exists (select 1 from closed_trades where equity_id is null) then raise exception 'a closed trade is waiting to be booked: let it be booked first'; end if;
  select * into l from pool_equity order by id desc limit 1;
  if l.id is null or l.total_units <= 0 then raise exception 'the pool has no units'; end if;
  v_new := l.equity_usdt + c.amount_usdt;
  if v_new <= 0 then raise exception 'the correction would take the pool to zero or below'; end if;
  perform set_config('ledger.tv_ctx', 'on', true);
  v_at := _at(null);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'update', v_new, l.total_units, v_new / l.total_units, l.php_rate, format('Correction #%s (%s USDT): %s', c.id, c.amount_usdt, c.reason), v_actor)
  returning id into v_eq;
  update book_corrections set status = 'applied', applied_at = now(), applied_by = v_actor, equity_id = v_eq where id = p_id;
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  t := _true_value(null);
  perform _audit(v_actor, 'book_correction_applied', null, jsonb_build_object('correction_id', p_id, 'amount', c.amount_usdt, 'reason', c.reason, 'evidence', c.evidence, 'equity_id', v_eq));
  return _idem_put(p_idem, 'admin_apply_book_correction', jsonb_build_object('equity_id', v_eq, 'equity_before', l.equity_usdt, 'equity_after', v_new,
    'price_before', l.unit_price, 'price_after', v_new / l.total_units, 'gap_after_usdt', t->'gap_usdt', 'reasons_after', t->'reasons'), v_actor);
end $$;

-- ---------------------------------------------------------------- what the pages show
-- manager: the whole reading, the reasons, the checkpoints, the corrections
create or replace function public.admin_true_value(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return _true_value(null) || jsonb_build_object('checkpoints', coalesce((select jsonb_agg(to_jsonb(c) order by c.id desc) from (select * from flow_checkpoints order by id desc limit 50) c), '[]'::jsonb),
    'corrections', coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from book_corrections b), '[]'::jsonb));
end $$;

-- the reading as of a past moment (manager): what an earlier arrival would be priced at, and why not when it cannot be
create or replace function public.admin_true_value_at(p_token text, p_as_of timestamptz) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return _true_value(p_as_of);
end $$;

-- any signed-in person: their own value at the true price, what can leave the exchange now (their share of the withdrawable cash after money waiting and payouts
-- promised), the part locked in open trades, and whether money can join or leave now (with the reason when not). Nobody else's numbers.
create or replace function public.my_true_value(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := _me(p_token); t jsonb := _true_value(null); v_u numeric := _units_of(v_me); v_tot numeric; v_price numeric; v_val numeric; v_cash numeric; v_wd numeric;
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
    and not exists (select 1 from flow_checkpoints f where p.id between f.equity_id and coalesce(f.book_equity_id, f.equity_id))   -- every entry a true-value flow wrote
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
      'text', format('%s closed trade(s) were already in a wallet report used by a true-value deposit, payout or settlement: not added again', v_tv)));
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
revoke all on function public._tv_append_only(), public._tv_guard_pool_entry(), public._tv_wallet_of_event(text), public._tv_unmatched_exits(), public._wallet_nav_at(timestamptz),
  public._true_value(timestamptz, numeric), public._tv_require(timestamptz), public._tv_set_book(numeric, timestamptz, uuid, text), public._tv_wallets_used(jsonb),
  public._tv_checkpoint(text, uuid, bigint, uuid, bigint, bigint, jsonb, numeric, numeric, numeric), public._pool_guard_pending(), public._auto_pool_value_trades(text)
  from public, anon, authenticated;
revoke all on function public.admin_admit_deposits_tv(text, bigint[], timestamptz, text), public.admin_admit_deposit_tv(text, bigint, text),
  public.admin_execute_withdrawal_tv(text, bigint, numeric, text, text), public.admin_close_quarter_tv(text, numeric, text, text), public.admin_settlement_preview_tv(text),
  public.admin_book_corrections(text), public.admin_preview_book_corrections(text), public.admin_apply_book_correction(text, bigint, text),
  public.admin_true_value(text), public.admin_true_value_at(text, timestamptz), public.my_true_value(text) from public;
grant execute on function public.admin_admit_deposits_tv(text, bigint[], timestamptz, text), public.admin_admit_deposit_tv(text, bigint, text),
  public.admin_execute_withdrawal_tv(text, bigint, numeric, text, text), public.admin_close_quarter_tv(text, numeric, text, text), public.admin_settlement_preview_tv(text),
  public.admin_book_corrections(text), public.admin_preview_book_corrections(text), public.admin_apply_book_correction(text, bigint, text),
  public.admin_true_value(text), public.admin_true_value_at(text, timestamptz), public.my_true_value(text) to anon, authenticated;
notify pgrst, 'reload schema';

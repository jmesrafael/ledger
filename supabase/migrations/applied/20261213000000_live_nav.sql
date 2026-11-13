-- LIVE NAV: the unit price follows the verified MEXC wallet reports, and the fund manager's routine is four steps: ADD INVESTOR, CASH IN, WITHDRAW, TRANSFER.
-- Docs: docs/live-nav.md. Tests: tests/live-nav.test.mjs. Rollback: supabase/rollback/20261213000000_rollback_live_nav.sql
--
-- Nothing new is computed here: the price is the existing true value (_true_value: Σ wallet equity − money waiting − money redeemed but not sent, checked against
-- the books + open P&L, every wallet fresh, none suspect, all within 10 minutes, no closed trade or bot exit waiting). What is new is that it is now RECORDED and USED:
--
--   1. nav_snapshots (append-only): every complete new set of wallet reports writes one row, verified (with its unit price) or blocked (with the reasons and NO price:
--      an unverified NAV is never published). Every deposit, payout, transfer or settlement writes one more row at the price it used (from its checkpoint), so each
--      investor's curve has a point at every flow and the time-weighted return stays exact.
--   2. _price_now() is the newest verified NAV price while flow_pricing = 'true_value' (else the booked price, as before). Every screen that shows values (my_summary,
--      admin_overview, pool_summary, the queue estimate) therefore moves with MEXC without anybody valuing the pool. Money is never priced by _price_now: every
--      deposit, payout and transfer still takes its own fresh true-value reading under the ledger lock.
--   3. _history / price_history / fund_returns: the booked entries up to the first verified NAV, then the NAV points (one per hour + one per flow). The book-only
--      entries a true-value flow writes (its entry B) and the automatic trade bookings after that start are not prices anyone was valued at, so they are not points.
--   4. CASH IN (admin_cash_in): pesos + USDT received + the recorded PHP/USD rate. The investor is credited pesos ÷ rate (rounded down). Less USDT than that arrived:
--      the gap comes from the fund manager's units (the peso top-up rule). More arrived: the rest is the fund manager's own deposit. It joins at the first verified
--      reading once it is confirmed as received in MEXC: at once if the wallets already show it, else automatically at the next report (_nav_tick).
--   5. TRANSFER (admin_transfer): units of one holder to another at the true price. Pool value and total units do not move. The sender is treated as selling that
--      share (performance fee on its gain above the sender's mark, as at a withdrawal); the recipient's mark rises by what they receive. So no fee is skipped and
--      none is charged twice.
--   6. WITHDRAW (admin_withdraw_now): the existing request → approve → redeem at true value → payout record, in one transaction, after a liquidity check (what can
--      leave MEXC now, less the payout buffer). It refuses, with nothing saved, when it does not fit. "Sent" is still marked when the money really left.
--   7. ADD INVESTOR (admin_add_investor): the account and its first cash-in in one transaction.
--
-- The book is untouched: it still rolls forward from MEXC's realized results only (auto_pool_mode = 'trades'), so an open trade's P&L is in the NAV (via wallet
-- equity) and lands in the book only once, when it closes. bot_equity_sync stays off: it would write a typed/bot total INTO the book, open P&L included, which the
-- trades mode would then add again (the Oct 28, 2026 double count). The live NAV replaces what it was for. wallet_nav_mode is not needed for any of this (the NAV
-- runs on the same wallet checks); it still only governs the older typed-total paths.
-- Safe to run twice. Works with or without 20261209000000_admission_spread.sql.

insert into public.ledger_settings(key, value) values
  ('nav_auto', 'on'),                    -- 'off' stops writing NAV rows from wallet reports (the price then stays at the last verified reading)
  ('nav_auto_admit', 'on'),              -- 'off': cash-ins confirmed as received wait for the manager's "Admit now"
  ('nav_blocked_log_minutes', '30'),     -- a blocked reading with the same reasons is written at most this often (discrepancy log)
  ('nav_history_bucket_minutes', '60')   -- curve resolution: one NAV point per this many minutes (plus every flow)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table if not exists public.nav_snapshots (
  id                bigserial primary key,
  ts                timestamptz not null,            -- the ledger's clock when written
  source            text not null check (source in ('wallet_report', 'flow', 'backfill')),
  status            text not null check (status in ('verified', 'blocked')),
  measured_at       timestamptz,                     -- newest wallet report in the reading
  equity_id         bigint,                          -- newest pool entry at that moment: units, ownership and money in / out are read as of it
  units             numeric not null,
  unit_price        numeric,                         -- NULL when blocked: an unverified NAV is never published
  true_value        numeric, book_usdt numeric, open_pnl numeric, combined_equity numeric, not_in_pool numeric, redeemed_not_sent numeric,
  gap               numeric, tolerance numeric, withdrawable numeric,
  reasons           jsonb not null default '[]'::jsonb,
  wallets           jsonb not null default '{}'::jsonb,   -- { wallet: snapshot id } of the reports used
  checkpoint_id     bigint,                          -- source 'flow': the flow checkpoint it mirrors
  admitted          jsonb,                           -- cash-ins admitted on this reading
  check (status = 'blocked' or (unit_price is not null and unit_price > 0))
);
create index if not exists nav_snapshots_ts_idx on public.nav_snapshots(ts desc);
create index if not exists nav_snapshots_verified_idx on public.nav_snapshots(id desc) where status = 'verified';
create unique index if not exists nav_snapshots_checkpoint_uidx on public.nav_snapshots(checkpoint_id) where checkpoint_id is not null;

create table if not exists public.cash_ins (
  id                  bigserial primary key,
  created_at          timestamptz not null default now(),
  created_by          uuid not null,
  profile_id          uuid not null references public.profiles(id),
  php_amount          numeric check (php_amount is null or php_amount > 0),
  fx_rate             numeric check (fx_rate is null or (fx_rate >= 20 and fx_rate <= 200)),
  fx_source           text,
  received_usdt       numeric not null check (received_usdt > 0),
  credited_usdt       numeric not null check (credited_usdt > 0),
  topup_usdt          numeric not null default 0 check (topup_usdt >= 0),     -- credited > received: from the fund manager's units, at admission
  surplus_usdt        numeric not null default 0 check (surplus_usdt >= 0),   -- received > credited: the fund manager's own deposit
  investor_pending_id bigint not null,
  manager_pending_id  bigint,
  note                text,
  status              text not null default 'waiting' check (status in ('waiting', 'admitted', 'cancelled')),
  admitted_at         timestamptz, admitted_by uuid, admitted_how text, unit_price numeric, units numeric, topup jsonb,
  check (topup_usdt = 0 or surplus_usdt = 0)
);
alter table public.nav_snapshots enable row level security;
alter table public.cash_ins enable row level security;
revoke all on public.nav_snapshots, public.cash_ins from public, anon, authenticated;
revoke all on sequence public.nav_snapshots_id_seq, public.cash_ins_id_seq from public, anon, authenticated;

create or replace function public._nav_append_only() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'nav_snapshots' then raise exception 'NAV snapshots cannot be changed or deleted'; end if;
  if tg_op = 'DELETE' then raise exception 'cash-ins cannot be deleted (cancel a waiting one instead)'; end if;
  if old.status <> 'waiting' then raise exception 'this cash-in is % and cannot change any more', old.status; end if;
  if (new.profile_id, new.php_amount, new.fx_rate, new.received_usdt, new.credited_usdt, new.topup_usdt, new.surplus_usdt, new.investor_pending_id, new.manager_pending_id, new.created_at)
     is distinct from (old.profile_id, old.php_amount, old.fx_rate, old.received_usdt, old.credited_usdt, old.topup_usdt, old.surplus_usdt, old.investor_pending_id, old.manager_pending_id, old.created_at) then
    raise exception 'a cash-in cannot be edited (cancel it and record it again)';
  end if;
  return new;
end $$;
drop trigger if exists nav_snapshots_guard on public.nav_snapshots;
create trigger nav_snapshots_guard before update or delete on public.nav_snapshots for each row execute function public._nav_append_only();
drop trigger if exists cash_ins_guard on public.cash_ins;
create trigger cash_ins_guard before update or delete on public.cash_ins for each row execute function public._nav_append_only();

-- ---------------------------------------------------------------- recording a reading
create or replace function public._nav_wallet_ids(t jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(w->>'wallet', w->'snapshot_id'), '{}'::jsonb) from jsonb_array_elements(coalesce(t->'wallets', '[]'::jsonb)) w where w->>'snapshot_id' is not null
$$;

create or replace function public._nav_insert(p_source text, t jsonb, p_extra jsonb default '{}'::jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint; v_ok boolean := coalesce((t->>'ok')::boolean, false);
begin
  insert into nav_snapshots(ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool, redeemed_not_sent,
      gap, tolerance, withdrawable, reasons, wallets, admitted)
  values (_clock(), p_source, case when v_ok then 'verified' else 'blocked' end, (t->>'measured_at')::timestamptz, (select max(id) from pool_equity), _total_units(),
      case when v_ok then (t->>'unit_price')::numeric end, (t->>'true_value_usdt')::numeric, (t->>'book_now_usdt')::numeric, (t->>'open_pnl_usdt')::numeric,
      (t->>'combined_equity_usdt')::numeric, (t->>'not_in_pool_usdt')::numeric, (t->>'redeemed_not_sent_usdt')::numeric, (t->>'gap_usdt')::numeric,
      (t->>'tolerance_usdt')::numeric, (t->>'withdrawable_usdt')::numeric, coalesce(t->'reasons', '[]'::jsonb), _nav_wallet_ids(t), p_extra->'admitted')
  returning id into v;
  return v;
end $$;

-- a flow (deposit, payout, transfer, settlement) adds a point at the price it was made at, with the units after it
create or replace function public._nav_from_checkpoint() returns trigger language plpgsql security definer set search_path = public as $$
declare u numeric := _total_units();
begin
  if u <= 0 then return new; end if;
  insert into nav_snapshots(ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool, redeemed_not_sent,
      gap, tolerance, wallets, checkpoint_id)
  values (_clock(), 'flow', 'verified', new.measured_at, (select max(id) from pool_equity), u, new.unit_price, u * new.unit_price,
      (select equity_usdt from pool_equity order by id desc limit 1), new.open_pnl, new.combined_equity, new.not_in_pool, new.redeemed_not_sent, new.gap, new.tolerance,
      (select coalesce(jsonb_object_agg(w->>'wallet', w->'snapshot_id'), '{}'::jsonb) from jsonb_array_elements(new.wallets) w), new.id)
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists flow_checkpoints_nav on public.flow_checkpoints;
create trigger flow_checkpoints_nav after insert on public.flow_checkpoints for each row execute function public._nav_from_checkpoint();

-- a hint when the gap is exactly money recorded as received that the wallets do not show yet (normally gone at the next report)
create or replace function public._nav_hints(t jsonb) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_pend numeric := coalesce((t->>'not_in_pool_usdt')::numeric, 0); v_gap numeric := (t->>'gap_usdt')::numeric; v_tol numeric := (t->>'tolerance_usdt')::numeric;
begin
  if v_gap is not null and v_pend > 0 and abs(v_gap + v_pend) <= coalesce(v_tol, 0.5) then
    return coalesce(t->'reasons', '[]'::jsonb) || jsonb_build_object('code', 'deposit_not_visible', 'text',
      format('%s USDT recorded as received in MEXC is not in the wallet reports yet: it must be in a bot''s Futures account. It joins automatically once a report shows it.', round(v_pend, 2)));
  end if;
  return coalesce(t->'reasons', '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- deposits at true value, without a session (the reading's engine for automatic admission)
-- the body of admin_admit_deposits_tv (20261207), unchanged, with the actor passed in; admin_admit_deposits_tv now calls it
create or replace function public._tv_admit(p_pending bigint[], p_as_of timestamptz, v_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pd pending_deposits%rowtype; t jsonb; v_at timestamptz; v_price numeric; v_units numeric; v_sum numeric := 0; v_res jsonb;
  v_led bigint; v_eq bigint; v_book bigint; v_id bigint; v_target numeric; v_cps bigint[] := '{}'; v_rows jsonb := '[]'::jsonb;
begin
  perform _ledger_lock();
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
    v_units := _convert_pending(v_id, v_price, v_at, v_actor);
    select ledger_id into v_led from pending_deposits where id = v_id;
    select equity_id into v_eq from ledger where id = v_led;
    update pending_deposits set admitted_at = now(), admitted_by = v_actor where id = v_id;
    v_sum := v_sum + pd.usdt;
    v_rows := v_rows || jsonb_build_object('pending', v_id, 'profile', pd.profile_id, 'usdt', pd.usdt, 'units', v_units, 'equity_id', v_eq, 'ledger_id', v_led);
  end loop;
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
  return jsonb_build_object('unit_price', v_price, 'priced_as_of', t->'priced_as_of', 'deposits', v_rows,
    'book_equity_id', v_book, 'checkpoint_ids', to_jsonb(v_cps), 'open_pnl', t->'open_pnl_usdt', 'realized_since', t->'realized_since_usdt');
end $$;

create or replace function public.admin_admit_deposits_tv(p_token text, p_pending bigint[], p_as_of timestamptz default null, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_admit_deposits_tv'); if v_res is not null then return v_res; end if;
  return _idem_put(p_idem, 'admin_admit_deposits_tv', _tv_admit(p_pending, p_as_of, v_actor), v_actor);
end $$;

-- ---------------------------------------------------------------- moving units between two holders at the true price (TRANSFER, and a cash-in's top-up)
-- No money moves and the pool does not change: one pool entry with the same equity and total units. The sender sells the share: the performance fee on its gain
-- above the sender's mark is charged now (fee units to the fund manager, exactly as at a withdrawal; never for the fund manager, who has no mark). The recipient
-- gets the rest: their mark rises by its value, so a gain made before the transfer is never charged to them, and a gain after it is charged once.
create or replace function public._unit_transfer(p_actor uuid, p_from uuid, p_to uuid, p_usdt numeric, p_all boolean, p_php numeric, p_rate numeric, p_note text, p_what text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  fr profiles%rowtype; tr profiles%rowtype; t jsonb; v_price numeric; v_have numeric; v_gross numeric; v_perf numeric; v_net numeric; v_pay numeric; v_feer numeric;
  v_at timestamptz; l pool_equity%rowtype; v_eq bigint; v_ls bigint; v_lr bigint; v_cp bigint; v_admin uuid; v_rate numeric := coalesce(p_rate, _last_php_rate());
begin
  perform _ledger_lock();
  select * into fr from profiles where id = p_from; if not found then raise exception 'unknown sender'; end if;
  select * into tr from profiles where id = p_to; if not found then raise exception 'unknown recipient'; end if;
  if p_from = p_to then raise exception 'the sender and the recipient are the same person'; end if;
  if not fr.active then raise exception '% is deactivated', coalesce(nullif(fr.name, ''), fr.username); end if;
  if not tr.active then raise exception '% is deactivated', coalesce(nullif(tr.name, ''), tr.username); end if;
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' then raise exception 'a transfer is priced at true value: flow_pricing must be true_value'; end if;
  if not coalesce(p_all, false) and (p_usdt is null or p_usdt <= 0) then raise exception 'the amount must be more than 0 USDT'; end if;
  if p_usdt is not null and round(p_usdt, 6) <> p_usdt then raise exception 'the amount may have at most 6 decimals (USDT)'; end if;
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(null);
  v_price := (t->>'unit_price')::numeric;
  v_have := _units_of(p_from);
  if exists (select 1 from withdrawal_requests where profile_id = p_from and status = 'pending') then
    v_have := v_have - coalesce((select sum(units) from withdrawal_requests where profile_id = p_from and status = 'pending'), 0);
    if v_have <= 0 then raise exception 'everything % holds is in a pending withdrawal request', coalesce(nullif(fr.name, ''), fr.username); end if;
  end if;
  v_gross := case when coalesce(p_all, false) then v_have else round(p_usdt / v_price, 8) end;
  if not coalesce(p_all, false) and v_gross > v_have and (v_gross - v_have) * v_price <= 0.01 then v_gross := v_have; end if;   -- within a cent of everything: everything
  if v_gross <= 0 then raise exception 'the amount is too small to move any units at this price'; end if;
  if v_gross > v_have + 0.00000001 then
    raise exception '% holds % units (worth % USDT) free to move; % USDT needs % units', coalesce(nullif(fr.name, ''), fr.username), round(v_have, 8), round(v_have * v_price, 6), p_usdt, v_gross;
  end if;
  if fr.role = 'investor' and coalesce(_setting('lock_enforced'), '0') = '1' and v_gross > _unlocked_units(p_from) + 0.00000001 then
    raise exception 'locked: only % units of the sender are past lock-up', round(_unlocked_units(p_from), 8);
  end if;
  v_feer := case when fr.role = 'investor' then fr.fee_rate else 0 end;
  v_perf := least(v_gross, _hwm_take(p_from, v_gross, v_price, v_feer, null));
  v_net := v_gross - v_perf;
  v_pay := round(v_net * v_price, 6);
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)));
  select * into l from pool_equity order by id desc limit 1;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', l.equity_usdt, l.total_units, l.equity_usdt / l.total_units, v_rate,
    format('%s: units moved from %s to %s (no money in or out, the pool is unchanged)', p_what, coalesce(nullif(fr.name, ''), fr.username), coalesce(nullif(tr.name, ''), tr.username)), p_actor)
  returning id into v_eq;
  perform _hwm_take(p_from, v_gross, v_price, v_feer, v_eq);
  select id into v_admin from profiles where role = 'admin' limit 1;
  if v_perf > 0 then
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_from,  'fee_out', -v_perf, -round(v_perf * v_price, 6), v_price, v_rate, v_eq, 'performance fee at transfer'),
           (v_at, v_admin, 'fee_in',   v_perf,  round(v_perf * v_price, 6), v_price, v_rate, v_eq, 'performance fee at transfer');
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, equity_id, note)
  values (v_at, p_from, 'withdrawal', -v_net, -v_pay, v_price, v_rate, null, v_eq, coalesce(p_note, p_what) || ' → ' || coalesce(nullif(tr.name, ''), tr.username)) returning id into v_ls;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_to, 'deposit', v_net, v_pay, v_price, v_rate, p_php, case when tr.role = 'investor' then _lock_for(p_to, v_at) end, v_eq,
          coalesce(p_note, p_what) || ' ← ' || coalesce(nullif(fr.name, ''), fr.username)) returning id into v_lr;
  perform _hwm_deposit(p_to, v_pay, v_eq);
  v_cp := _tv_checkpoint('reallocation', p_actor, v_lr, p_to, v_eq, null, t, v_price, v_pay, v_net);
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  return jsonb_build_object('unit_price', v_price, 'gross_units', v_gross, 'fee_units', v_perf, 'fee_usdt', round(v_perf * v_price, 6), 'net_units', v_net, 'usdt', v_pay,
    'sender_value_moved_usdt', round(v_gross * v_price, 6), 'equity_id', v_eq, 'sender_ledger_id', v_ls, 'recipient_ledger_id', v_lr, 'checkpoint_id', v_cp,
    'sender_units_after', _units_of(p_from), 'recipient_units_after', _units_of(p_to), 'priced_as_of', t->'priced_as_of', 'php_amount', p_php, 'rate', v_rate);
end $$;

-- the recorded PHP/USD rate for a peso amount: the given rate must be within 2% of the fund's stored reference when there is one (20261208)
create or replace function public._cash_rate(p_rate numeric) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_ref numeric := _fx_reference_rate(); v_src text;
begin
  if p_rate is null then
    if v_ref is null then raise exception 'enter the PHP/USD rate (the fund has no stored reference rate in the last 7 days)'; end if;
    p_rate := v_ref;
  end if;
  if p_rate < 20 or p_rate > 200 then raise exception 'the PHP/USD rate must be between 20 and 200'; end if;
  if v_ref is not null and abs(p_rate / v_ref - 1) > 0.02 then
    raise exception 'the rate % is more than 2%% from the fund''s stored PHP/USD reference %: reload the app for a fresh live rate', p_rate, round(v_ref, 4);
  end if;
  select source into v_src from fx_reference_rates order by fetched_at desc limit 1;
  return jsonb_build_object('rate', p_rate, 'source', case when v_ref is not null and p_rate = v_ref then v_src when v_ref is not null then 'entered, checked against ' || v_src else 'entered' end);
end $$;

-- ---------------------------------------------------------------- CASH IN
create or replace function public._cash_in_admit(p_id bigint, p_actor uuid, p_how text) returns jsonb language plpgsql security definer set search_path = public as $$
declare c cash_ins%rowtype; v_ids bigint[]; r jsonb; v_top jsonb; v_mgr uuid; v_units numeric;
begin
  perform _ledger_lock();
  select * into c from cash_ins where id = p_id for update;
  if not found then raise exception 'unknown cash-in'; end if;
  if c.status <> 'waiting' then raise exception 'duplicate refused: cash-in #% is already %', p_id, c.status; end if;
  v_ids := array[c.investor_pending_id] || case when c.manager_pending_id is not null then array[c.manager_pending_id] else '{}'::bigint[] end;
  if exists (select 1 from pending_deposits where id = any(v_ids) and arrived_at is null) then
    raise exception 'queued: cash-in #% is not confirmed as received in MEXC yet', p_id;
  end if;
  r := _tv_admit(v_ids, null, p_actor);
  select (d->>'units')::numeric into v_units from jsonb_array_elements(r->'deposits') d where (d->>'pending')::bigint = c.investor_pending_id;
  if c.topup_usdt > 0 then
    select id into v_mgr from profiles where role = 'admin' limit 1;
    v_top := _unit_transfer(p_actor, v_mgr, c.profile_id, c.topup_usdt, false, null, c.fx_rate,
      format('peso top-up for cash-in #%s: %s pesos at ₱%s = %s USDT credited, %s USDT arrived', c.id, c.php_amount, round(c.fx_rate, 4), c.credited_usdt, c.received_usdt), 'peso top-up');
    v_units := v_units + (v_top->>'net_units')::numeric;
  end if;
  update cash_ins set status = 'admitted', admitted_at = now(), admitted_by = p_actor, admitted_how = p_how, unit_price = (r->>'unit_price')::numeric, units = v_units, topup = v_top
   where id = p_id;
  perform _audit(p_actor, 'cash_in_admitted', c.profile_id, jsonb_build_object('cash_in_id', p_id, 'how', p_how, 'unit_price', r->'unit_price', 'units', v_units,
    'credited_usdt', c.credited_usdt, 'topup_usdt', c.topup_usdt, 'surplus_usdt', c.surplus_usdt));
  return jsonb_build_object('cash_in_id', p_id, 'status', 'admitted', 'unit_price', r->'unit_price', 'units', v_units, 'credited_usdt', c.credited_usdt,
    'topup', v_top, 'deposits', r->'deposits', 'checkpoint_ids', r->'checkpoint_ids');
end $$;

-- pesos (or USDT only) + what arrived. p_in_mexc = the manager confirms it is in a bot's Futures account. Joins at once when the reading allows, else at the next report.
create or replace function public.admin_cash_in(p_token text, p_profile uuid, p_php_amount numeric, p_usdt_received numeric, p_rate numeric default null,
    p_in_mexc boolean default true, p_note text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; pr profiles%rowtype; fx jsonb; v_rate numeric; v_cred numeric; v_top numeric := 0; v_sur numeric := 0; v_inv bigint; v_mgr_p bigint;
  v_id bigint; v_mgr uuid; v_who text; v_now timestamptz := now(); v_out jsonb; v_try jsonb; v_price numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_cash_in'); if v_res is not null then return v_res; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' then raise exception 'cash-in joins at true value: flow_pricing must be true_value'; end if;
  if _total_units() <= 0 then raise exception 'the pool has no units yet: the first deposit is made the normal way (Money in, then Balance)'; end if;
  if p_usdt_received is null or p_usdt_received <= 0 then raise exception 'enter the USDT that arrived in MEXC (more than 0)'; end if;
  if round(p_usdt_received, 6) <> p_usdt_received then raise exception 'the USDT received may have at most 6 decimals'; end if;
  if p_php_amount is not null and p_php_amount <= 0 then raise exception 'the pesos must be more than 0'; end if;
  v_who := coalesce(nullif(pr.name, ''), pr.username);
  select id into v_mgr from profiles where role = 'admin' limit 1;
  if p_php_amount is not null then fx := _cash_rate(p_rate); v_rate := (fx->>'rate')::numeric; end if;
  -- the investor is credited pesos ÷ the recorded rate; the fund manager's own cash-in is simply what arrived
  v_cred := case when p_php_amount is null or pr.role = 'admin' then p_usdt_received else floor(p_php_amount / v_rate * 1000000) / 1000000 end;
  if v_cred <= 0 then raise exception 'the pesos are too few to credit any USDT at this rate'; end if;
  if v_cred > p_usdt_received then v_top := v_cred - p_usdt_received;
  elsif v_cred < p_usdt_received then v_sur := p_usdt_received - v_cred; end if;
  if v_top > 0 then
    v_price := _price_now();
    if _units_of(v_mgr) * v_price < v_top then
      raise exception 'the top-up is % USDT but your own units are worth about % USDT: nothing is taken from anyone else, so it is refused', v_top, round(_units_of(v_mgr) * v_price, 2);
    end if;
  end if;
  insert into pending_deposits(profile_id, usdt, php_rate, php_amount, note, received_at, created_by, arrived_at, arrival_confirmed_by)
  values (p_profile, least(v_cred, p_usdt_received), coalesce(v_rate, _last_php_rate()), p_php_amount,
          coalesce(p_note, case when p_php_amount is not null then format('cash-in: %s pesos at ₱%s', p_php_amount, round(v_rate, 4)) else 'cash-in' end),
          v_now, v_actor, case when coalesce(p_in_mexc, false) then v_now end, case when coalesce(p_in_mexc, false) then v_actor end)
  returning id into v_inv;
  if v_sur > 0 then
    insert into pending_deposits(profile_id, usdt, php_rate, php_amount, note, received_at, created_by, arrived_at, arrival_confirmed_by)
    values (v_mgr, v_sur, v_rate, null, format('cash-in for %s: the USDT that arrived beyond %s pesos at ₱%s (yours)', v_who, p_php_amount, round(v_rate, 4)),
            v_now, v_actor, case when coalesce(p_in_mexc, false) then v_now end, case when coalesce(p_in_mexc, false) then v_actor end)
    returning id into v_mgr_p;
  end if;
  insert into cash_ins(created_by, profile_id, php_amount, fx_rate, fx_source, received_usdt, credited_usdt, topup_usdt, surplus_usdt, investor_pending_id, manager_pending_id, note)
  values (v_actor, p_profile, p_php_amount, v_rate, fx->>'source', p_usdt_received, v_cred, v_top, v_sur, v_inv, v_mgr_p, p_note) returning id into v_id;
  perform _audit(v_actor, 'cash_in_recorded', p_profile, jsonb_build_object('cash_in_id', v_id, 'php_amount', p_php_amount, 'rate', v_rate, 'rate_source', fx->>'source',
    'received_usdt', p_usdt_received, 'credited_usdt', v_cred, 'topup_usdt', v_top, 'surplus_usdt', v_sur, 'in_mexc', coalesce(p_in_mexc, false)));
  v_out := jsonb_build_object('cash_in_id', v_id, 'php_amount', p_php_amount, 'credited_usdt', v_cred, 'received_usdt', p_usdt_received, 'topup_usdt', v_top, 'surplus_usdt', v_sur,
    'rate', v_rate, 'rate_source', fx->>'source', 'status', 'waiting');
  if coalesce(p_in_mexc, false) then
    begin
      v_try := _cash_in_admit(v_id, v_actor, 'at once');
      v_out := v_out || v_try;
    exception when others then
      v_out := v_out || jsonb_build_object('status', 'waiting', 'waiting_reason', sqlerrm,
        'next', 'it joins automatically at the first verified wallet reading that shows the money (reports come every 5 minutes)');
    end;
  else
    v_out := v_out || jsonb_build_object('next', 'confirm it as received once it is in MEXC (a bot''s Futures account); it then joins automatically');
  end if;
  return _idem_put(p_idem, 'admin_cash_in', v_out, v_actor);
end $$;

-- the same, rolled back: what the screen shows before saving
create or replace function public.admin_quote_cash_in(p_token text, p_profile uuid, p_php_amount numeric, p_usdt_received numeric, p_rate numeric default null, p_in_mexc boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    v_res := admin_cash_in(p_token, p_profile, p_php_amount, p_usdt_received, p_rate, p_in_mexc, null, null);
    raise exception 'quote rolled back' using errcode = 'WQ003';
  exception when sqlstate 'WQ003' then null;
  end;
  return v_res || jsonb_build_object('quote', true);
end $$;

-- the manager confirms that a waiting cash-in is in MEXC; it joins at once if the reading allows, else at the next report
create or replace function public.admin_cash_in_received(p_token text, p_cash_in bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; c cash_ins%rowtype; v_out jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_cash_in_received'); if v_res is not null then return v_res; end if;
  select * into c from cash_ins where id = p_cash_in for update;
  if not found then raise exception 'unknown cash-in'; end if;
  if c.status <> 'waiting' then raise exception 'cash-in #% is already %', p_cash_in, c.status; end if;
  update pending_deposits set arrived_at = coalesce(arrived_at, now()), arrival_confirmed_by = coalesce(arrival_confirmed_by, v_actor)
   where id in (c.investor_pending_id, c.manager_pending_id) and status = 'pending';
  begin
    v_out := _cash_in_admit(p_cash_in, v_actor, 'manager');
  exception when others then
    v_out := jsonb_build_object('cash_in_id', p_cash_in, 'status', 'waiting', 'waiting_reason', sqlerrm);
  end;
  return _idem_put(p_idem, 'admin_cash_in_received', v_out, v_actor);
end $$;

-- hand a waiting cash-in back (typed wrong, money returned): both legs, nothing in the books changes
create or replace function public.admin_cancel_cash_in(p_token text, p_cash_in bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); c cash_ins%rowtype;
begin
  perform _ledger_lock();
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'write why it is handed back'; end if;
  select * into c from cash_ins where id = p_cash_in for update;
  if not found then raise exception 'unknown cash-in'; end if;
  if c.status <> 'waiting' then raise exception 'cash-in #% is %: only a waiting one can be handed back', p_cash_in, c.status; end if;
  update pending_deposits set status = 'cancelled' where id in (c.investor_pending_id, c.manager_pending_id) and status = 'pending';
  update cash_ins set status = 'cancelled', admitted_how = 'cancelled: ' || trim(p_reason) where id = p_cash_in;
  perform _audit(v_actor, 'cash_in_cancelled', c.profile_id, jsonb_build_object('cash_in_id', p_cash_in, 'reason', p_reason));
  return jsonb_build_object('cash_in_id', p_cash_in, 'status', 'cancelled');
end $$;

-- the manager's "admit now" (when nav_auto_admit is off, or to retry at once)
create or replace function public.admin_cash_in_admit(p_token text, p_cash_in bigint, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_cash_in_admit'); if v_res is not null then return v_res; end if;
  return _idem_put(p_idem, 'admin_cash_in_admit', _cash_in_admit(p_cash_in, v_actor, 'manager'), v_actor);
end $$;

create or replace function public.admin_cash_ins(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('name', coalesce(nullif(p.name, ''), p.username),
      'arrived', not exists (select 1 from pending_deposits d where d.id in (c.investor_pending_id, c.manager_pending_id) and d.arrived_at is null)) order by c.id desc)
    from (select * from cash_ins order by id desc limit 100) c join profiles p on p.id = c.profile_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- ADD INVESTOR (the account and the first cash-in in one transaction)
create or replace function public.admin_add_investor(p_token text, p_username text, p_name text, p_password text, p_fee_rate numeric default null,
    p_php_amount numeric default null, p_usdt_received numeric default null, p_rate numeric default null, p_in_mexc boolean default true, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; v_id uuid; v_ci jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_add_investor'); if v_res is not null then return v_res; end if;
  v_id := admin_create_user(p_token, p_username, p_name, p_password, p_fee_rate);
  perform _audit(v_actor, 'investor_added', v_id, jsonb_build_object('username', lower(trim(p_username)), 'fee_rate', (select fee_rate from profiles where id = v_id)));
  if p_usdt_received is not null then
    v_ci := admin_cash_in(p_token, v_id, p_php_amount, p_usdt_received, p_rate, p_in_mexc, null, null);
  end if;
  return _idem_put(p_idem, 'admin_add_investor', jsonb_build_object('profile_id', v_id, 'cash_in', v_ci), v_actor);
end $$;

-- ---------------------------------------------------------------- TRANSFER
create or replace function public.admin_transfer(p_token text, p_from uuid, p_to uuid, p_php_amount numeric default null, p_usdt numeric default null, p_rate numeric default null,
    p_all boolean default false, p_note text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; fx jsonb; v_usdt numeric := p_usdt; v_rate numeric; v_out jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_transfer'); if v_res is not null then return v_res; end if;
  if p_php_amount is not null and p_php_amount <= 0 then raise exception 'the pesos must be more than 0'; end if;
  if p_php_amount is not null then fx := _cash_rate(p_rate); v_rate := (fx->>'rate')::numeric; end if;
  if v_usdt is null and p_php_amount is not null and not coalesce(p_all, false) then v_usdt := floor(p_php_amount / v_rate * 1000000) / 1000000; end if;
  if v_usdt is null and not coalesce(p_all, false) then raise exception 'enter the amount in pesos or in USDT'; end if;
  v_out := _unit_transfer(v_actor, p_from, p_to, v_usdt, p_all, p_php_amount, v_rate, nullif(trim(coalesce(p_note, '')), ''), 'transfer');
  v_out := v_out || jsonb_build_object('rate_source', fx->>'source');
  perform _audit(v_actor, 'unit_transfer', p_to, v_out || jsonb_build_object('from', p_from, 'to', p_to, 'note', p_note));
  return _idem_put(p_idem, 'admin_transfer', v_out, v_actor);
end $$;

create or replace function public.admin_quote_transfer(p_token text, p_from uuid, p_to uuid, p_php_amount numeric default null, p_usdt numeric default null, p_rate numeric default null,
    p_all boolean default false) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    v_res := admin_transfer(p_token, p_from, p_to, p_php_amount, p_usdt, p_rate, p_all, null, null);
    raise exception 'quote rolled back' using errcode = 'WQ003';
  exception when sqlstate 'WQ003' then null;
  end;
  return v_res || jsonb_build_object('quote', true);
end $$;

-- ---------------------------------------------------------------- WITHDRAW (request → approve → redeem at true value → payout record, in one transaction)
-- p_request: an investor's own request; else one is made for p_profile (p_usdt, or p_all). Inside the lock-up shown to investors a written reason is needed, as for
-- admin_approve_withdrawal. The payout must fit what can leave MEXC now (_payout_capacity: transferable less the buffer and payouts not sent yet), else nothing is
-- saved. The money is then sent from MEXC and marked "sent" with its reference (admin_payout_sent), as before.
create or replace function public.admin_withdraw_now(p_token text, p_profile uuid default null, p_usdt numeric default null, p_all boolean default false,
    p_request bigint default null, p_lock_reason text default null, p_note text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; r withdrawal_requests%rowtype; pr profiles%rowtype; t jsonb; v_price numeric; v_units numeric; v_have numeric;
  v_cap jsonb; v_est numeric; v_in boolean; v_out jsonb; v_rid bigint;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_withdraw_now'); if v_res is not null then return v_res; end if;
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' then raise exception 'withdrawals are priced at true value: flow_pricing must be true_value'; end if;
  t := _tv_require(null);
  v_price := (t->>'unit_price')::numeric;
  if p_request is not null then
    select * into r from withdrawal_requests where id = p_request for update;
    if not found then raise exception 'unknown withdrawal request'; end if;
    if r.status <> 'pending' then raise exception 'this request is already %', r.status; end if;
    v_rid := r.id;
  else
    select * into pr from profiles where id = p_profile;
    if not found then raise exception 'choose who is withdrawing'; end if;
    if not pr.active then raise exception 'this person is deactivated'; end if;
    if exists (select 1 from withdrawal_requests where profile_id = p_profile and status = 'pending') then
      raise exception '% already has a pending withdrawal request: process that one', coalesce(nullif(pr.name, ''), pr.username);
    end if;
    if pr.role = 'investor' and not exists (select 1 from payout_details where profile_id = p_profile) then
      raise exception 'add where % is paid (GCash or bank) first: menu → investor → payout details', coalesce(nullif(pr.name, ''), pr.username);
    end if;
    v_have := _units_of(p_profile);
    if v_have <= 0 then raise exception 'this person holds no units'; end if;
    if coalesce(p_all, false) then v_units := v_have;
    else
      if p_usdt is null or p_usdt <= 0 then raise exception 'enter the amount in USDT (or choose everything)'; end if;
      v_units := round(p_usdt / v_price, 8);
      if v_units > v_have and (v_units - v_have) * v_price <= 0.01 then v_units := v_have; end if;
      if v_units > v_have + 0.00000001 then raise exception 'this person holds % units, worth % USDT now', round(v_have, 8), round(v_have * v_price, 6); end if;
      if pr.role = 'investor' and v_units < v_have then perform _check_min_withdrawal(p_profile, v_units, v_price, _last_php_rate()); end if;
    end if;
    insert into withdrawal_requests(profile_id, units, note, pay_by) values (p_profile, v_units, coalesce(p_note, 'recorded by the fund manager'), current_date) returning * into r;
    v_rid := r.id;
    perform _wf_event(v_actor, 'withdrawal', v_rid, 'withdrawal_requested', jsonb_build_object('units', v_units, 'by_manager', true), null, null, p_profile);
  end if;
  if r.stage = 'requested' then
    v_in := _wf_in_lockup(r.profile_id);
    perform admin_approve_withdrawal(p_token, v_rid, p_note, case when v_in then p_lock_reason end);
  elsif r.stage <> 'approved' then raise exception 'this request is %', r.stage;
  end if;
  -- liquidity: what can leave MEXC now (the gross value is checked: the fee can only make the payout smaller)
  v_cap := _payout_capacity();
  v_est := round((select units from withdrawal_requests where id = v_rid) * v_price, 6);
  if not (v_cap->>'ok')::boolean then
    raise exception 'PAYOUT BLOCKED: the wallet reports are not usable (%). Nothing was saved.', (select string_agg(x->>'text', '; ') from jsonb_array_elements(v_cap->'reasons') x);
  end if;
  if v_est > (v_cap->>'payable_now_usdt')::numeric + 0.0000005 then
    raise exception 'PAYOUT QUEUED: about % USDT is asked but only % USDT can leave MEXC now (open trades hold margin; buffer % %% + % USDT). Nothing was saved; try again when trades close or pay part now.',
      v_est, v_cap->>'payable_now_usdt', round((v_cap->>'buffer_pct')::numeric * 100, 2), v_cap->>'buffer_usdt';
  end if;
  v_out := admin_execute_withdrawal_tv(p_token, v_rid, _last_php_rate(), p_note, null);
  v_out := v_out || jsonb_build_object('request_id', v_rid, 'payable_now_before_usdt', v_cap->'payable_now_usdt', 'next', 'send it from MEXC, then mark it sent with the reference');
  perform _audit(v_actor, 'withdrawal_processed', r.profile_id, v_out);
  return _idem_put(p_idem, 'admin_withdraw_now', v_out, v_actor);
end $$;

create or replace function public.admin_quote_withdraw_now(p_token text, p_profile uuid default null, p_usdt numeric default null, p_all boolean default false,
    p_request bigint default null, p_lock_reason text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    v_res := admin_withdraw_now(p_token, p_profile, p_usdt, p_all, p_request, coalesce(p_lock_reason, 'quote only, nothing is saved'), null, null);
    raise exception 'quote rolled back' using errcode = 'WQ003';
  exception when sqlstate 'WQ003' then null;
  end;
  return v_res || jsonb_build_object('quote', true);
end $$;

-- ---------------------------------------------------------------- the automatic reading (every wallet report)
create or replace function public._nav_tick(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t jsonb; last nav_snapshots%rowtype; lastv nav_snapshots%rowtype; v_fresh boolean := true; w jsonb; v_ok boolean; v_adm jsonb := '[]'::jsonb; v_actor uuid; c record; r jsonb;
  v_codes text; v_lcodes text; v_id bigint; v_reasons jsonb;
begin
  if coalesce(_setting('nav_auto'), 'on') <> 'on' then return jsonb_build_object('ok', false, 'skipped', 'nav_auto_off'); end if;
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' or _total_units() <= 0 then return jsonb_build_object('ok', false, 'skipped', 'not_true_value'); end if;
  perform _ledger_lock();
  t := _true_value(null);
  select * into last from nav_snapshots where source = 'wallet_report' order by ts desc, id desc limit 1;
  select * into lastv from nav_snapshots where source = 'wallet_report' and status = 'verified' order by ts desc, id desc limit 1;
  -- a NEW complete set: every usable wallet has a newer report than the last VERIFIED reading used (so the three reports of a cycle make one row, and the first
  -- good set after a blocked spell is written at once)
  if lastv.id is not null then
    for w in select * from jsonb_array_elements(coalesce(t->'wallets', '[]'::jsonb)) loop
      if w->>'status' = 'ok' and coalesce((w->>'snapshot_id')::bigint, 0) <= coalesce((lastv.wallets->>(w->>'wallet'))::bigint, 0) then v_fresh := false; end if;
    end loop;
  end if;
  v_ok := coalesce((t->>'ok')::boolean, false);
  if v_ok then
    if not v_fresh then return jsonb_build_object('ok', true, 'skipped', 'same_set'); end if;
    if coalesce(_setting('nav_auto_admit'), 'on') = 'on' then
      select id into v_actor from profiles where role = 'admin' limit 1;
      for c in select ci.id from cash_ins ci where ci.status = 'waiting'
                 and not exists (select 1 from pending_deposits d where d.id in (ci.investor_pending_id, ci.manager_pending_id) and (d.arrived_at is null or d.status <> 'pending'))
               order by ci.id loop
        begin
          r := _cash_in_admit(c.id, v_actor, 'automatic');
          v_adm := v_adm || jsonb_build_object('cash_in_id', c.id, 'units', r->'units', 'unit_price', r->'unit_price');
        exception when others then
          v_adm := v_adm || jsonb_build_object('cash_in_id', c.id, 'waiting', sqlerrm);
        end;
      end loop;
      if jsonb_array_length(v_adm) > 0 then t := _true_value(null); end if;
    end if;
    v_id := _nav_insert(p_source, t, jsonb_build_object('admitted', case when jsonb_array_length(v_adm) > 0 then v_adm end));
    return jsonb_build_object('ok', true, 'nav_id', v_id, 'status', case when (t->>'ok')::boolean then 'verified' else 'blocked' end, 'unit_price', t->'unit_price', 'admitted', v_adm);
  end if;
  -- blocked: the reasons are kept (discrepancy log), but never a price; the same reasons at most every nav_blocked_log_minutes
  v_reasons := _nav_hints(t);
  t := t || jsonb_build_object('reasons', v_reasons);
  select string_agg(x->>'code', ',' order by x->>'code') into v_codes from jsonb_array_elements(v_reasons) x;
  select string_agg(x->>'code', ',' order by x->>'code') into v_lcodes from jsonb_array_elements(coalesce(last.reasons, '[]'::jsonb)) x;
  if last.id is not null and last.status = 'blocked' and coalesce(v_codes, '') = coalesce(v_lcodes, '')
     and last.ts > _clock() - make_interval(mins => _wf_setnum('nav_blocked_log_minutes', 30)::int) then
    return jsonb_build_object('ok', false, 'skipped', 'same_block', 'reasons', v_reasons);
  end if;
  v_id := _nav_insert(p_source, t);
  return jsonb_build_object('ok', false, 'nav_id', v_id, 'status', 'blocked', 'reasons', v_reasons);
end $$;

-- the wallet report: store it (core), book any closed trade (20261203), then the NAV reading. Each later step is protected: a failure there never loses the report.
create or replace function public.bot_post_wallet_snapshot(p_key text, p_wallet text, p_seq bigint, p_reported_at timestamptz, p_equity numeric, p_unrealized numeric,
    p_withdrawable numeric, p_available numeric, p_open_positions int, p_open_orders int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; v_pool jsonb; v_nav jsonb;
begin
  r := _bot_post_wallet_snapshot_core(p_key, p_wallet, p_seq, p_reported_at, p_equity, p_unrealized, p_withdrawable, p_available, p_open_positions, p_open_orders);
  if coalesce((r->>'replayed')::boolean, false) then return r; end if;
  begin v_pool := _auto_pool_value('wallet_report'); exception when others then v_pool := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  begin v_nav := _nav_tick('wallet_report'); exception when others then v_nav := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  return r || jsonb_build_object('pool', v_pool, 'nav', v_nav);
end $$;

-- ---------------------------------------------------------------- the price every screen shows
create or replace function public._nav_latest() returns nav_snapshots language sql stable security definer set search_path = public as $$
  select * from nav_snapshots where status = 'verified' order by ts desc, id desc limit 1
$$;
create or replace function public._price_now() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(case when coalesce(_setting('flow_pricing'), 'book') = 'true_value' then (select unit_price from nav_snapshots where status = 'verified' order by ts desc, id desc limit 1) end,
                  (select unit_price from pool_equity order by id desc limit 1), 1)
$$;

-- the points of a curve after the live NAV started: one verified row per bucket (the newest in it), every flow row, and the newest row
create or replace function public._nav_points() returns setof nav_snapshots language sql stable security definer set search_path = public as $$
  with b as (select greatest(1, _wf_setnum('nav_history_bucket_minutes', 60)) * 60 as s),
  v as (select n.*, row_number() over (partition by floor(extract(epoch from n.ts) / b.s) order by n.ts desc, n.id desc) as k,
               first_value(n.id) over (order by n.ts desc, n.id desc) as top
          from nav_snapshots n, b where n.status = 'verified')
  select id, ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool, redeemed_not_sent,
         gap, tolerance, withdrawable, reasons, wallets, checkpoint_id, admitted
    from v where k = 1 or source = 'flow' or id = top
   order by ts, id
$$;
create or replace function public._nav_start() returns timestamptz language sql stable security definer set search_path = public as $$
  select case when coalesce(_setting('flow_pricing'), 'book') = 'true_value' then (select min(ts) from nav_snapshots where status = 'verified') end
$$;
-- booked entries that are not prices anyone was valued at: a true-value flow's book entry (B)
create or replace function public._is_book_only(p_id bigint) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from flow_checkpoints f where f.book_equity_id = p_id)
$$;

create or replace function public._history(p uuid) returns jsonb language sql stable security definer set search_path = public as $$
  with s as (select _nav_start() as t, (select min(equity_id) from ledger where profile_id = p) as e0),
  ev as (
    select e.id as eq, e.ts, e.unit_price as price, false as nav
      from pool_equity e, s
     where s.e0 is not null and e.id >= s.e0 and (s.t is null or e.ts < s.t) and not _is_book_only(e.id)
    union all
    select n.equity_id, n.ts, n.unit_price, true from _nav_points() n, s where s.t is not null and s.e0 is not null and n.equity_id >= s.e0),
  pts as (
    select ev.*, (select coalesce(sum(l.units), 0) from ledger l where l.profile_id = p and l.equity_id <= ev.eq) as units,
           (select coalesce(sum(l.usdt), 0) from ledger l where l.profile_id = p and l.equity_id <= ev.eq and l.kind in ('deposit', 'withdrawal')) as net_in
      from ev)
  select coalesce(jsonb_agg(jsonb_build_object('id', eq, 'ts', ts, 'value', units * price, 'net_in', net_in, 'units', units, 'price', price, 'nav', nav)
                            order by ts, eq), '[]'::jsonb) from pts
$$;

create or replace function public.price_history(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t timestamptz := _nav_start();
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(x order by (x->>'ts')::timestamptz, (x->>'id')::bigint) from (
      select jsonb_build_object('id', id, 'ts', ts, 'unit_price', unit_price, 'equity_usdt', equity_usdt, 'total_units', total_units, 'kind', kind) x
        from pool_equity where (v_t is null or ts < v_t) and not _is_book_only(id)
      union all
      select jsonb_build_object('id', equity_id, 'ts', ts, 'unit_price', unit_price, 'equity_usdt', unit_price * units, 'total_units', units, 'kind', 'nav', 'source', source)
        from _nav_points() where v_t is not null) q), '[]'::jsonb);
end $$;

create or replace function public.fund_returns(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t timestamptz := _nav_start();
begin
  perform _me(p_token);
  return coalesce((select jsonb_agg(x order by (x->>'ts')::timestamptz, (x->>'id')::bigint) from (
      select jsonb_build_object('id', e.id, 'ts', e.ts, 'price', e.unit_price,
               'mgr', (select coalesce(sum(l.units), 0) from ledger l join profiles p on p.id = l.profile_id where p.role = 'admin' and l.equity_id <= e.id) > 0.000000001) x
        from pool_equity e where (v_t is null or e.ts < v_t) and not _is_book_only(e.id)
      union all
      select jsonb_build_object('id', n.equity_id, 'ts', n.ts, 'price', n.unit_price, 'nav', true,
               'mgr', (select coalesce(sum(l.units), 0) from ledger l join profiles p on p.id = l.profile_id where p.role = 'admin' and l.equity_id <= n.equity_id) > 0.000000001)
        from _nav_points() n where v_t is not null) q), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- what the pages read
-- everyone: the official price, when it was measured, and whether it is current (no pool size for an investor)
create or replace function public.my_nav(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := _me(p_token); n nav_snapshots%rowtype := _nav_latest(); l nav_snapshots%rowtype;
begin
  select * into l from nav_snapshots order by ts desc, id desc limit 1;
  return jsonb_build_object('live', n.id is not null and coalesce(_setting('flow_pricing'), 'book') = 'true_value', 'unit_price', _price_now(), 'measured_at', n.measured_at, 'ts', n.ts,
    'age_minutes', case when n.id is not null then round(extract(epoch from _clock() - n.ts) / 60) end,
    'current', n.id is not null and l.id = n.id and n.ts > _clock() - interval '20 minutes',
    'units', _units_of(v_me), 'value_usdt', _units_of(v_me) * _price_now());
end $$;

-- the fund manager: the newest reading and why it is blocked, the reconciliation of everybody's value with the exchange, the discrepancy log
create or replace function public.admin_nav(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n nav_snapshots%rowtype := _nav_latest(); l nav_snapshots%rowtype; v_price numeric := _price_now(); v_units numeric := _total_units(); v_hold jsonb; v_sum numeric;
  v_fm jsonb; t jsonb := _true_value(null); v_blocked int; v_since timestamptz; v_wait numeric; v_cap jsonb := _payout_capacity();
begin
  perform _admin(p_token);
  select * into l from nav_snapshots order by ts desc, id desc limit 1;
  select count(*), min(ts) into v_blocked, v_since from nav_snapshots where status = 'blocked' and ts > coalesce(n.ts, '-infinity');
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(p.name, ''), p.username), 'role', p.role, 'units', u.units, 'share', case when v_units > 0 then u.units / v_units end,
           'value_usdt', u.units * v_price) order by u.units desc), '[]'::jsonb), coalesce(sum(u.units * v_price), 0)
    into v_hold, v_sum from (select profile_id, sum(units) units from ledger group by profile_id having abs(sum(units)) > 0.00000001) u join profiles p on p.id = u.profile_id;
  select coalesce(sum(usdt), 0) into v_wait from pending_deposits where status = 'pending' and arrived_at is null;
  v_fm := _fund_m_state(null);
  return jsonb_build_object(
    'latest', to_jsonb(l), 'latest_verified', to_jsonb(n), 'unit_price', v_price, 'units', v_units,
    'current', n.id is not null and l.id = n.id and n.ts > _clock() - interval '20 minutes',
    'blocked_since', v_since, 'blocked_rows', v_blocked, 'reasons_now', _nav_hints(t), 'reading_now', t - 'wallets', 'wallets', t->'wallets',
    'reconciliation', jsonb_build_object(
      'holders', v_hold, 'sum_of_holders_usdt', v_sum, 'nav_usdt', v_price * v_units,
      'waiting_in_mexc_usdt', coalesce((t->>'not_in_pool_usdt')::numeric, _pending_total()), 'waiting_not_in_mexc_usdt', v_wait,
      'redeemed_not_sent_usdt', _outbound_unsent(), 'mexc_equity_usdt', t->'combined_equity_usdt',
      'explained_usdt', v_price * v_units + coalesce((t->>'not_in_pool_usdt')::numeric, 0) + coalesce((t->>'redeemed_not_sent_usdt')::numeric, 0),
      'unexplained_usdt', case when t->>'combined_equity_usdt' is not null and (t->>'ok')::boolean then
        (t->>'combined_equity_usdt')::numeric - (v_price * v_units + (t->>'not_in_pool_usdt')::numeric + (t->>'redeemed_not_sent_usdt')::numeric) end,
      'book_usdt', t->'book_now_usdt', 'open_pnl_usdt', t->'open_pnl_usdt', 'gap_usdt', t->'gap_usdt', 'tolerance_usdt', t->'tolerance_usdt',
      'manager_capital_units', v_fm->'capital'->'units', 'manager_fee_units', v_fm->'fee_entitlement'->'units'),
    'payable_now_usdt', v_cap->'payable_now_usdt',
    'waiting_cash_ins', (select count(*) from cash_ins where status = 'waiting'),
    'payouts_to_send', coalesce((select jsonb_agg(jsonb_build_object('payout_id', r.id, 'request_id', r.request_id, 'name', coalesce(nullif(p.name, ''), p.username), 'amount_usdt', r.amount_usdt,
        'status', r.status, 'failure_reason', r.failure_reason, 'created_at', r.created_at) order by r.id)
      from payout_records r join profiles p on p.id = r.profile_id where r.leaves_mexc and r.status in ('awaiting', 'failed')), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ts', ts, 'source', source, 'status', status, 'unit_price', unit_price, 'true_value', true_value,
        'gap', gap, 'reasons', reasons) order by ts desc, id desc) from (select * from nav_snapshots order by ts desc, id desc limit 30) r), '[]'::jsonb),
    'settings', jsonb_build_object('nav_auto', coalesce(_setting('nav_auto'), 'on'), 'nav_auto_admit', coalesce(_setting('nav_auto_admit'), 'on'),
        'flow_pricing', _setting('flow_pricing'), 'auto_pool_mode', _setting('auto_pool_mode'), 'bot_equity_sync', coalesce(_setting('bot_equity_sync'), 'off'),
        'wallet_nav_mode', coalesce(_setting('wallet_nav_mode'), 'off')));
end $$;

-- ---------------------------------------------------------------- filling the curve from the wallet reports already kept (run once, after any missing trade is booked)
-- For each moment from p_from to p_to every p_step_minutes: the same checks as _true_value, as of that moment, against the books as they stood then. Only moments that
-- pass are written (source 'backfill', verified); the others are skipped and counted. A flow in the range adds its point at the price it used. Never before an existing row.
create or replace function public._nav_backfill(p_from timestamptz, p_to timestamptz, p_step_minutes int default 60) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_t timestamptz := p_from; n jsonb; e pool_equity%rowtype; v_pend numeric; v_out numeric; v_V numeric; v_gap numeric; v_tol numeric; v_n int := 0; v_skip jsonb := '{}'::jsonb;
  v_first timestamptz := (select min(ts) from nav_snapshots); v_code text; f record;
begin
  perform _ledger_lock();
  if p_step_minutes < 5 then raise exception 'the step must be at least 5 minutes'; end if;
  if v_first is not null and p_to >= v_first then p_to := v_first - interval '1 second'; end if;
  while v_t <= p_to loop
    v_code := null;
    n := _wallet_nav_at(v_t);
    select * into e from pool_equity where ts <= v_t order by ts desc, id desc limit 1;
    if e.id is null or e.total_units <= 0 then v_code := 'no_pool';
    elsif not (n->>'ok')::boolean then v_code := 'wallets';
    else
      select coalesce(sum(usdt), 0) into v_pend from pending_deposits where arrived_at is not null and arrived_at <= v_t and coalesce(admitted_at, 'infinity') > v_t
        and status <> 'cancelled';
      select coalesce(sum(amount_usdt), 0) into v_out from payout_records where leaves_mexc and created_at <= v_t and coalesce(sent_at, 'infinity') > v_t;
      v_V := (n->>'combined_equity_usdt')::numeric - v_pend - v_out;
      v_gap := v_V - (e.equity_usdt + (n->>'combined_unrealized_usdt')::numeric);
      v_tol := greatest(coalesce(_setting('pool_recon_tol_abs'), '0.5')::numeric, abs(v_V) * coalesce(_setting('pool_recon_tol_pct'), '0.0005')::numeric);
      if abs(v_gap) > v_tol then v_code := 'gap';
      elsif exists (select 1 from closed_trades c where c.closed_at <= v_t and (c.equity_id is null or (select ts from pool_equity where id = c.equity_id) > v_t + interval '15 minutes')) then v_code := 'unbooked_trade';
      else
        insert into nav_snapshots(ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool, redeemed_not_sent, gap, tolerance,
            withdrawable, wallets)
        values (v_t, 'backfill', 'verified', (select max((w->>'received_at')::timestamptz) from jsonb_array_elements(n->'wallets') w), e.id, e.total_units, v_V / e.total_units, v_V,
            e.equity_usdt, (n->>'combined_unrealized_usdt')::numeric, (n->>'combined_equity_usdt')::numeric, v_pend, v_out, v_gap, v_tol, (n->>'combined_withdrawable_usdt')::numeric,
            (select coalesce(jsonb_object_agg(w->>'wallet', w->'snapshot_id'), '{}'::jsonb) from jsonb_array_elements(n->'wallets') w));
        v_n := v_n + 1;
      end if;
    end if;
    if v_code is not null then v_skip := v_skip || jsonb_build_object(v_code, coalesce((v_skip->>v_code)::int, 0) + 1); end if;
    v_t := v_t + make_interval(mins => p_step_minutes);
  end loop;
  for f in select * from flow_checkpoints where created_at between p_from and p_to and not exists (select 1 from nav_snapshots s where s.checkpoint_id = flow_checkpoints.id) order by id loop
    insert into nav_snapshots(ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool, redeemed_not_sent, gap, tolerance,
        wallets, checkpoint_id)
    values (f.created_at, 'flow', 'verified', f.measured_at, coalesce(f.book_equity_id, f.equity_id), (select total_units from pool_equity where id = coalesce(f.book_equity_id, f.equity_id)),
        f.unit_price, f.unit_price * (select total_units from pool_equity where id = coalesce(f.book_equity_id, f.equity_id)), (select equity_usdt from pool_equity where id = coalesce(f.book_equity_id, f.equity_id)),
        f.open_pnl, f.combined_equity, f.not_in_pool, f.redeemed_not_sent, f.gap, f.tolerance,
        (select coalesce(jsonb_object_agg(w->>'wallet', w->'snapshot_id'), '{}'::jsonb) from jsonb_array_elements(f.wallets) w), f.id);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('written', v_n, 'skipped', v_skip, 'from', p_from, 'to', p_to);
end $$;

-- ---------------------------------------------------------------- the pool card: live NAV next to the book
create or replace function public.pool_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_price numeric := _price_now(); v_tu numeric := _total_units(); v_fm jsonb; b pool_equity%rowtype; n nav_snapshots%rowtype := _nav_latest();
begin
  perform _admin(p_token);
  v_fm := _fund_m_state(null);
  select * into b from pool_equity order by id desc limit 1;
  return jsonb_build_object(
    'unit_price', v_price, 'total_units', v_tu, 'equity_usdt', v_price * v_tu,
    'asof', coalesce(case when coalesce(_setting('flow_pricing'), 'book') = 'true_value' then n.ts end, b.ts),
    'php_rate', _last_php_rate(), 'since_start_pct', v_price - 1,
    'live', n.id is not null and coalesce(_setting('flow_pricing'), 'book') = 'true_value', 'nav_measured_at', n.measured_at, 'open_pnl_usdt', n.open_pnl,
    'book_usdt', b.equity_usdt, 'book_price', b.unit_price, 'book_asof', b.ts,
    'admin_capital_units', (v_fm->'capital'->>'units')::numeric,
    'admin_fee_units', (v_fm->'fee_entitlement'->>'units')::numeric,
    'investor_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id where p.role = 'investor'), 0),
    'investor_count', (select count(*) from (select l.profile_id from ledger l join profiles p on p.id = l.profile_id
                                               where p.role = 'investor' group by l.profile_id having sum(l.units) > 0) x),
    'pending_requests', (select count(*) from withdrawal_requests where status = 'pending'));
end $$;

-- ---------------------------------------------------------------- backup coverage
do $$
begin
  if to_regprocedure('public._export_extra_pre_nav()') is null then
    alter function public._export_extra() rename to _export_extra_pre_nav;
  end if;
end $$;
revoke all on function public._export_extra_pre_nav() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_nav() || jsonb_build_object('nav_snapshots', _dump_table('nav_snapshots'), 'cash_ins', _dump_table('cash_ins'))
$$;
revoke all on function public._export_extra() from public, anon, authenticated;

-- ---------------------------------------------------------------- permissions
revoke all on function public._nav_append_only(), public._nav_wallet_ids(jsonb), public._nav_insert(text, jsonb, jsonb), public._nav_from_checkpoint(), public._nav_hints(jsonb),
  public._tv_admit(bigint[], timestamptz, uuid), public._unit_transfer(uuid, uuid, uuid, numeric, boolean, numeric, numeric, text, text), public._cash_rate(numeric),
  public._cash_in_admit(bigint, uuid, text), public._nav_tick(text), public._nav_latest(), public._price_now(), public._nav_points(), public._nav_start(), public._is_book_only(bigint),
  public._history(uuid), public._nav_backfill(timestamptz, timestamptz, int)
  from public, anon, authenticated;
revoke all on function public.admin_admit_deposits_tv(text, bigint[], timestamptz, text),
  public.admin_cash_in(text, uuid, numeric, numeric, numeric, boolean, text, text), public.admin_quote_cash_in(text, uuid, numeric, numeric, numeric, boolean),
  public.admin_cash_in_received(text, bigint, text), public.admin_cancel_cash_in(text, bigint, text), public.admin_cash_in_admit(text, bigint, text), public.admin_cash_ins(text),
  public.admin_add_investor(text, text, text, text, numeric, numeric, numeric, numeric, boolean, text),
  public.admin_transfer(text, uuid, uuid, numeric, numeric, numeric, boolean, text, text), public.admin_quote_transfer(text, uuid, uuid, numeric, numeric, numeric, boolean),
  public.admin_withdraw_now(text, uuid, numeric, boolean, bigint, text, text, text), public.admin_quote_withdraw_now(text, uuid, numeric, boolean, bigint, text),
  public.my_nav(text), public.admin_nav(text), public.price_history(text), public.fund_returns(text), public.pool_summary(text),
  public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) from public;
grant execute on function public.admin_admit_deposits_tv(text, bigint[], timestamptz, text),
  public.admin_cash_in(text, uuid, numeric, numeric, numeric, boolean, text, text), public.admin_quote_cash_in(text, uuid, numeric, numeric, numeric, boolean),
  public.admin_cash_in_received(text, bigint, text), public.admin_cancel_cash_in(text, bigint, text), public.admin_cash_in_admit(text, bigint, text), public.admin_cash_ins(text),
  public.admin_add_investor(text, text, text, text, numeric, numeric, numeric, numeric, boolean, text),
  public.admin_transfer(text, uuid, uuid, numeric, numeric, numeric, boolean, text, text), public.admin_quote_transfer(text, uuid, uuid, numeric, numeric, numeric, boolean),
  public.admin_withdraw_now(text, uuid, numeric, boolean, bigint, text, text, text), public.admin_quote_withdraw_now(text, uuid, numeric, boolean, bigint, text),
  public.my_nav(text), public.admin_nav(text), public.price_history(text), public.fund_returns(text), public.pool_summary(text),
  public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) to anon, authenticated;
notify pgrst, 'reload schema';

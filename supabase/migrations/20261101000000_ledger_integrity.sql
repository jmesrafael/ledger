-- LEDGER INTEGRITY: one correction per entry, one writer at a time, retry-safe writes, a FLAT performance fee on each period's net
-- trading profit, MEXC snapshot / transfer reconciliation, and a read-only integrity report.
-- Run after 20261031000001_bot_equity_sync.sql. NOT yet run on any database. Read docs/accounting-model.md first.
--
-- WHAT IT FIXES (each has a regression test in tests/integrity.test.mjs)
--  C1  Deleting a correction re-added a deposit and left it waiting too (500 USDT became 1,250 units).
--      Now: a correction can never be corrected; each entry can be reversed once (unique index + corrections table).
--  M1  Nothing serialised money writes. Now every money write takes one transaction-level advisory lock first.
--      Retried writes carry an idempotency key (optional p_idem) and replay the stored result instead of repeating.
--  M2  Typed valuations were never sanity-checked. Now a move of more than `valuation_max_move` (25%) since the last
--      entry, or any unmatched MEXC transfer, needs an explicit p_confirm = true (recorded in the entry's note).
--  H1  MEXC transfers are now recorded (bot_post_snapshot), matched to deposits/withdrawals or classified by the manager
--      with a written reason. Unmatched transfers block automatic readings. With settlement_gate = 'on' a fee
--      settlement also needs a fresh snapshot, no open positions or orders, and a clean (or attested) reconciliation.
--  L1  A withdrawal request for "everything" is now paid as everything that is left.
--  L2  Unlocked units no longer shrink when a fee is charged on a still-locked deposit.
--  L3  Every write ends with _check_books(): units, fee transfers, price x units = equity.
--  Q1  THE PERFORMANCE FEE IS A FLAT RATE ON EACH PERIOD'S NET TRADING PROFIT (fee_engine = 'flat_period_v1'). Formulas below.
--
-- FLAT FEE ON PERIOD PROFIT. A "period" runs from one quarter close to the next (or from the start of the ledger to the first close).
-- The unit price changes ONLY with trading (deposits, withdrawals and fee transfers happen at the current price and never move it), so
-- an investor's net trading profit in a period is exact, from data the ledger already keeps:
--     profit_i = SUM over every pool entry e in the period of   units_i(just before e) x ( price(e) - price(previous entry) )
--   units_i(just before e) = sum of i's ledger units with equity_id < e.id.   A newcomer holds 0 units before they join, so they earn
--   nothing from earlier price moves; a leaver keeps the profit earned while they held units.
--   fee = rate x max(0, profit_i - credit_i)            rate = the person's fee_rate (10% by default); a loss or zero profit = no fee
--   fee_units = floor8( fee / price at the settlement )  rounded DOWN to 8 decimals: rounding never overcharges
--   Nothing is carried between periods: no high-water mark, no recovery of earlier losses.
--   A withdrawal of share s (= units sold / units held) settles s of the period profit so far:
--        fee = rate x max(0, profit_i - credit_i) x s ;  credit_i := profit_i - (1 - s) x (profit_i - credit_i)
--   so the units that stay keep (1 - s) of the profit or loss so far, and it is settled at the quarter close. A full exit (s = 1)
--   settles all of it. credit_i is reset to 0 at every quarter close.
-- The old per-deposit lots (holder_lots / lot_log / holder_state) stop being updated. They are kept as history.
--
-- UPGRADING FROM THE EARLIER DRAFT. An earlier draft of this file (investor-level high-water mark, fee_engine = 'investor_hwm_v1') was applied
-- to at least one database. This file recognises that state and upgrades it: the draft's two tables are RENAMED to investor_perf_draft_archive
-- and perf_log_draft_archive (nothing is deleted), its unused _perf_* functions are dropped, and fee_engine becomes 'flat_period_v1'. Every
-- function and table this file defines is replaced or created idempotently. If the draft tables exist but fee_engine is not
-- 'investor_hwm_v1' the state is unclear and the file stops.
--
-- STAGED ROLLOUT SETTINGS (ledger_settings): fee_engine, books_check ('enforce' | 'warn' | 'off'), settlement_gate ('off' | 'on'),
--   valuation_max_move, snapshot_max_age_hours, recon_tolerance_abs, recon_tolerance_pct.
-- ROLLBACK: see docs/accounting-model.md section 9. After the first settlement under the new engine, going back is a
--   manual, reviewed correction, not a switch.

-- ---------------------------------------------------------------- 0. preflight: refuse to build on damaged books
do $$
declare v_n int; v_bad text; v_draft boolean; v_engine text;
begin
  v_draft := to_regclass('public.investor_perf') is not null or to_regclass('public.perf_log') is not null;
  select value into v_engine from public.ledger_settings where key = 'fee_engine';
  if v_draft and coalesce(v_engine, '') <> 'investor_hwm_v1' then
    raise exception 'preflight: tables of the earlier draft exist (investor_perf / perf_log) but fee_engine is "%" instead of investor_hwm_v1, so the state is unclear. Nothing was changed. Stop and send the result of the check query in docs/accounting-model.md section 9.', coalesce(v_engine, 'missing');
  end if;
  if v_draft then
    raise notice 'upgrading from the EARLIER DRAFT (investor-level high-water mark): its tables are kept as investor_perf_draft_archive and perf_log_draft_archive';
  end if;
  if exists (select 1 from public.ledger where reversed_of is not null group by reversed_of having count(*) > 1)
     or exists (select 1 from public.pool_equity where reversed_of is not null group by reversed_of having count(*) > 1) then
    raise exception 'preflight: an entry has been reversed more than once. Run supabase/diagnostics/pre-migration-integrity.sql and review before applying.';
  end if;
  if exists (select 1 from public.pool_equity) and abs((select coalesce(sum(units), 0) from public.ledger) - (select total_units from public.pool_equity order by id desc limit 1)) > 0.000001 then
    raise exception 'preflight: everyone''s units differ from the last pool entry. Run supabase/diagnostics/pre-migration-integrity.sql and review before applying.';
  end if;
  if not v_draft then   -- the draft's engine froze the per-deposit lines, so they only mean something on a ledger the draft never touched
    select count(*), string_agg(x.id::text, ', ') into v_n, v_bad
      from (select p.id from public.profiles p
             left join (select profile_id, sum(units) u from public.ledger group by profile_id) l on l.profile_id = p.id
             left join (select profile_id, sum(units) u from public.holder_lots group by profile_id) h on h.profile_id = p.id
            where abs(coalesce(l.u, 0) - coalesce(h.u, 0)) > 0.000001 limit 5) x;
    if v_n > 0 then
      raise exception 'preflight: ledger units and per-deposit lines disagree for % account(s) (ids: %). Reconcile before switching the fee engine.', v_n, v_bad;
    end if;
  end if;
  select count(*) into v_n from public.profiles where role = 'investor' and fee_rate <> 0.10;
  if v_n > 0 then raise notice '% investor account(s) have a fee rate other than 10%%: the flat fee uses each person''s own rate. Check Users before the first settlement.', v_n; end if;
end $$;

-- ---------------------------------------------------------------- 1. settings
insert into public.ledger_settings(key, value) values
  ('fee_engine', 'flat_period_v1'),
  ('books_check', 'enforce'),
  ('settlement_gate', 'off'),
  ('valuation_max_move', '0.25'),
  ('snapshot_max_age_hours', '12'),
  ('recon_tolerance_abs', '0.5'),
  ('recon_tolerance_pct', '0.0005')
on conflict (key) do nothing;
update public.ledger_settings set value = 'flat_period_v1' where key = 'fee_engine';

-- keep the earlier draft's history under new names; its functions are unused by this engine
do $$
begin
  if to_regclass('public.investor_perf') is not null then alter table public.investor_perf rename to investor_perf_draft_archive; end if;
  if to_regclass('public.perf_log') is not null then alter table public.perf_log rename to perf_log_draft_archive; end if;
end $$;
drop function if exists public._perf_log(bigint, uuid);
drop function if exists public._perf_deposit(uuid, numeric, numeric, bigint);
drop function if exists public._perf_take(uuid, numeric, numeric, numeric, bigint);
drop function if exists public._perf_close(uuid, numeric, numeric, bigint);
drop function if exists public._perf_revert(bigint);

-- ---------------------------------------------------------------- 2. tables
-- profit of the CURRENT period that a withdrawal has already settled (or forgiven) for an investor; reset to 0 at every quarter close
create table if not exists public.investor_period (
  profile_id uuid primary key references public.profiles(id),
  credit     numeric not null default 0,
  updated_at timestamptz not null default now()
);
-- what each withdrawal did to a credit, so the newest entry can be reversed exactly; rows are kept (reverted_at is set)
create table if not exists public.period_log (
  id            bigserial primary key,
  equity_id     bigint not null references public.pool_equity(id),
  profile_id    uuid not null references public.profiles(id),
  existed       boolean not null,
  credit_before numeric,
  reverted_at   timestamptz
);
create index if not exists period_log_equity_idx on public.period_log(equity_id);
create table if not exists public.idempotency_keys (
  key        text primary key,
  fn         text not null,
  result     jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists public.corrections (
  id                   bigserial primary key,
  original_equity_id   bigint not null unique references public.pool_equity(id),
  correction_equity_id bigint not null unique references public.pool_equity(id),
  reason               text,
  created_by           uuid,
  ts                   timestamptz not null default now()
);
create table if not exists public.exchange_snapshots (
  id                 bigserial primary key,
  ts                 timestamptz not null default now(),
  equity_usdt        numeric not null check (equity_usdt >= 0),
  unrealized_usdt    numeric,
  open_positions     int not null check (open_positions >= 0),
  open_orders        int not null check (open_orders >= 0),
  realized_since     numeric,
  transfers_complete boolean not null default false,
  expected_usdt      numeric,
  diff_usdt          numeric,
  recon_status       text not null check (recon_status in ('ok', 'blocked', 'baseline')),
  recon_detail       text
);
create table if not exists public.exchange_transfers (
  id         bigserial primary key,
  ext_id     text not null unique,                 -- the exchange's own id: one transfer can only ever be recorded once
  ts         timestamptz not null,
  direction  text not null check (direction in ('in', 'out')),
  usdt       numeric not null check (usdt > 0),
  first_seen timestamptz not null default now()
);
create table if not exists public.transfer_matches (
  transfer_id        bigint primary key references public.exchange_transfers(id),
  kind               text not null check (kind in ('auto_deposit', 'auto_withdrawal', 'classified')),
  pending_deposit_id bigint,
  ledger_id          bigint,
  classification     text check (classification in ('deposit_recorded', 'withdrawal_recorded', 'internal_transfer', 'exchange_credit', 'other')),
  note               text,
  created_by         uuid,
  ts                 timestamptz not null default now()
);
create table if not exists public.snapshot_attestations (
  id          bigserial primary key,
  snapshot_id bigint not null unique references public.exchange_snapshots(id),
  note        text not null check (length(trim(note)) >= 10),
  created_by  uuid,
  ts          timestamptz not null default now()
);
alter table public.pending_deposits add column if not exists arrived_at timestamptz;
alter table public.pending_deposits add column if not exists mexc_transfer_id text;

create unique index if not exists pending_transfer_uq on public.pending_deposits(mexc_transfer_id) where mexc_transfer_id is not null;
create unique index if not exists pending_ledger_uq   on public.pending_deposits(ledger_id) where ledger_id is not null;
create unique index if not exists request_ledger_uq   on public.withdrawal_requests(ledger_id) where ledger_id is not null;
create unique index if not exists ledger_reversed_uq  on public.ledger(reversed_of) where reversed_of is not null;
create unique index if not exists equity_reversed_uq  on public.pool_equity(reversed_of) where reversed_of is not null;

do $$
declare t text;
begin
  foreach t in array array['investor_period', 'period_log', 'idempotency_keys', 'corrections', 'exchange_snapshots', 'exchange_transfers', 'transfer_matches', 'snapshot_attestations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
  foreach t in array array['corrections', 'exchange_snapshots', 'exchange_transfers', 'transfer_matches', 'snapshot_attestations', 'idempotency_keys'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._no_change()', t || '_append_only', t);
  end loop;
end $$;
revoke all on sequence public.period_log_id_seq, public.corrections_id_seq, public.exchange_snapshots_id_seq, public.exchange_transfers_id_seq,
  public.snapshot_attestations_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. locking, idempotency, sanity checks
-- ONE lock for all money writes: two phones, a double tap or a retry cannot interleave. Held until the transaction ends.
create or replace function public._ledger_lock() returns void language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(7461001)
$$;

create or replace function public._idem_get(p_key text, p_fn text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r idempotency_keys%rowtype;
begin
  if p_key is null or length(p_key) = 0 then return null; end if;
  select * into r from idempotency_keys where key = p_key;
  if not found then return null; end if;
  if r.fn <> p_fn then raise exception 'that request id was already used for another operation (%)', r.fn; end if;
  return coalesce(r.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
end $$;

create or replace function public._idem_put(p_key text, p_fn text, p_result jsonb, p_actor uuid) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_key is not null and length(p_key) > 0 then
    insert into idempotency_keys(key, fn, result, created_by) values (p_key, p_fn, p_result, p_actor);
  end if;
  return p_result;
end $$;

-- the books must prove themselves at the end of every money write; a failure rolls the whole write back
create or replace function public._check_books() returns void language plpgsql security definer set search_path = public as $$
declare mode text := coalesce(_setting('books_check'), 'enforce'); u numeric; l pool_equity%rowtype; msg text := '';
begin
  if mode = 'off' then return; end if;
  select coalesce(sum(units), 0) into u from ledger;
  select * into l from pool_equity order by id desc limit 1;
  if found then
    if abs(u - l.total_units) > 0.000001 then msg := msg || format('everyone''s units (%s) differ from the last entry (%s); ', u, l.total_units); end if;
    if abs(l.equity_usdt - l.unit_price * l.total_units) > 0.0001 + l.equity_usdt * 0.000000001 then
      msg := msg || format('equity (%s) is not price x units (%s); ', l.equity_usdt, l.unit_price * l.total_units);
    end if;
  elsif u <> 0 then msg := msg || 'units exist without any pool entry; ';
  end if;
  if exists (select 1 from ledger group by profile_id having sum(units) < -0.000000001) then msg := msg || 'a negative unit balance; '; end if;
  if abs(coalesce((select sum(units) from ledger where kind in ('fee_in', 'fee_out')), 0)) > 0.00000001 then msg := msg || 'fee transfers do not net to zero; '; end if;
  if msg <> '' then
    if mode = 'warn' then raise notice 'books check: %', msg; else raise exception 'books check failed, nothing was saved: %', msg; end if;
  end if;
end $$;

-- big moves and unmatched MEXC transfers need an explicit yes
create or replace function public._check_move(p_net numeric, p_confirm boolean) returns text language plpgsql security definer set search_path = public as $$
declare v_last numeric; v_mv numeric := coalesce(_setting('valuation_max_move'), '0.25')::numeric; v_unm int; v_note text := '';
begin
  select equity_usdt into v_last from pool_equity order by id desc limit 1;
  select count(*) into v_unm from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id);
  if v_last is not null and v_last > 0 and abs(p_net / v_last - 1) > v_mv then
    if not coalesce(p_confirm, false) then
      raise exception 'CONFIRM: this is a % move from the last entry (% to %). If the number is right, confirm to continue.',
        to_char((p_net / v_last - 1) * 100, 'FM999990.0') || '%', round(v_last, 2), round(p_net, 2);
    end if;
    v_note := v_note || ' [confirmed ' || to_char((p_net / v_last - 1) * 100, 'FM999990.0') || '% move]';
  end if;
  if v_unm > 0 then
    if not coalesce(p_confirm, false) then
      raise exception 'CONFIRM: % MEXC transfer(s) are not matched to a deposit or withdrawal yet, so this number may include money that is not trading profit. Match or classify them first, or confirm to continue.', v_unm;
    end if;
    v_note := v_note || ' [confirmed with ' || v_unm || ' unmatched MEXC transfer(s)]';
  end if;
  return v_note;
end $$;

-- fee settlement gate (only when settlement_gate = 'on')
create or replace function public._settlement_gate(p_equity numeric) returns void language plpgsql security definer set search_path = public as $$
declare s exchange_snapshots%rowtype; v_hrs numeric := coalesce(_setting('snapshot_max_age_hours'), '12')::numeric;
  v_tol numeric := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, p_equity * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
begin
  if coalesce(_setting('settlement_gate'), 'off') <> 'on' then return; end if;
  select * into s from exchange_snapshots order by id desc limit 1;
  if not found then raise exception 'no MEXC snapshot yet: the bot must send one before a fee settlement'; end if;
  if s.ts < now() - make_interval(secs => v_hrs * 3600) then raise exception 'the last MEXC snapshot is stale (taken %)', s.ts; end if;
  if s.open_positions > 0 or s.open_orders > 0 then raise exception 'trades or orders are still open on MEXC: a fee settlement waits until the pool is flat'; end if;
  if exists (select 1 from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id)) then
    raise exception 'there are MEXC transfers that are not matched to a deposit or withdrawal';
  end if;
  if s.recon_status <> 'ok' and not exists (select 1 from snapshot_attestations a where a.snapshot_id = s.id) then
    raise exception 'the last MEXC reconciliation is not clean (%): fix it, or attest it with a written reason', coalesce(s.recon_detail, s.recon_status);
  end if;
  if abs(s.equity_usdt - p_equity) > v_tol then
    raise exception 'the typed equity (%) differs from the MEXC snapshot (%) by more than the tolerance', p_equity, s.equity_usdt;
  end if;
end $$;

-- ---------------------------------------------------------------- 4. flat fee on period profit
-- fee in units, rounded DOWN to 8 decimals (never in the manager's favour). Multiply before dividing and clear repeating-decimal noise at
-- 12 decimals first, so an exact 1 unit stays 1 (not 0.99999999). Worst case in the manager's favour: under 5e-13 units.
create or replace function public._fee_units(p_rate numeric, p_profit numeric, p_share_num numeric, p_share_den numeric, p_price numeric) returns numeric
language sql immutable as $$
  select floor(round(p_rate * greatest(0, p_profit) * p_share_num / (p_share_den * p_price), 12) * 100000000) / 100000000
$$;

-- id of the newest quarter close (strictly before p_before when given); 0 = none yet. A period is everything after it.
create or replace function public._last_close(p_before bigint) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(max(id), 0) from pool_equity where kind = 'close' and (p_before is null or id < p_before)
$$;

-- net trading profit of one person over the pool entries with p_from < id <= p_to, in USDT:
--   sum of  units held just before the entry  x  (price of the entry - price of the entry before it).
-- p_extra_price = the price of an entry that is about to be written (a withdrawal being previewed); its price move is added on top.
create or replace function public._period_profit(p uuid, p_from bigint, p_to bigint, p_extra_price numeric default null) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v numeric; v_last numeric;
begin
  select coalesce(sum(coalesce(ev.dp, 0) * (select coalesce(sum(l.units), 0) from ledger l where l.profile_id = p and coalesce(l.equity_id, 0) < ev.id)), 0) into v
    from (select e.id, e.unit_price - lag(e.unit_price) over (order by e.id) as dp from pool_equity e where e.id >= p_from and e.id <= p_to) ev
   where ev.id > p_from;
  if p_extra_price is not null then
    select unit_price into v_last from pool_equity where id = p_to;
    v := v + _units_of(p) * (p_extra_price - coalesce(v_last, p_extra_price));
  end if;
  return v;
end $$;

create or replace function public._period_credit(p uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select credit from investor_period where profile_id = p), 0)
$$;

-- taking n units out: the fee on the same share (n / units held) of the period profit so far; that share is settled, the rest stays
-- for the quarter close. p_eq null = preview (the withdrawal's own entry is not written yet, p_price is its price).
create or replace function public._period_take(p uuid, p_units numeric, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_u numeric := _units_of(p); v_share numeric; v_a numeric; v_cr numeric := _period_credit(p); v_net numeric; v_fee numeric;
begin
  if v_u <= 0 then return 0; end if;
  if p_units > v_u + 0.000001 then raise exception 'internal: holdings are short by % units', p_units - v_u; end if;
  v_share := least(1, p_units / v_u);
  if p_eq is null then v_a := _period_profit(p, _last_close(null), (select max(id) from pool_equity), p_price);
  else v_a := _period_profit(p, _last_close(p_eq), p_eq); end if;
  v_net := v_a - v_cr;
  v_fee := _fee_units(p_rate, v_net, least(p_units, v_u), v_u, p_price);
  if p_eq is not null then
    insert into period_log(equity_id, profile_id, existed, credit_before)
    select p_eq, p, exists (select 1 from investor_period where profile_id = p), (select credit from investor_period where profile_id = p);
    insert into investor_period(profile_id, credit) values (p, v_a - (1 - v_share) * v_net)
    on conflict (profile_id) do update set credit = excluded.credit, updated_at = now();
  end if;
  return v_fee;
end $$;

-- quarter close for one person: the fee on the whole period profit (less what withdrawals already settled), at the settlement price.
create or replace function public._period_close(p uuid, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_u numeric := _units_of(p); v_net numeric;
begin
  if v_u <= 0 then return 0; end if;
  v_net := _period_profit(p, _last_close(p_eq), p_eq) - _period_credit(p);
  return _fee_units(p_rate, v_net, 1, 1, p_price);
end $$;

create or replace function public._period_revert(p_eq bigint) returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select * from period_log where equity_id = p_eq and reverted_at is null order by id desc loop
    if r.existed then update investor_period set credit = r.credit_before, updated_at = now() where profile_id = r.profile_id;
    else delete from investor_period where profile_id = r.profile_id; end if;
    update period_log set reverted_at = now() where id = r.id;
  end loop;
end $$;

-- Start of the new engine for an existing ledger. The current period's profit is already in the history (units x price moves), so nothing
-- needs converting. One exception: an investor who withdrew during the current period had the fee on the withdrawn share charged by the OLD
-- rule at the time. To avoid charging that share again, the profit counted so far for them is forgiven (credit = profit so far).
insert into public.investor_period(profile_id, credit)
select p.id, public._period_profit(p.id, public._last_close(null), (select max(id) from public.pool_equity))
  from public.profiles p
 where p.role = 'investor'
   and exists (select 1 from public.ledger l where l.profile_id = p.id and l.kind = 'withdrawal' and l.reversed_of is null and l.equity_id > public._last_close(null))
   and not exists (select 1 from public.investor_period);

-- ---------------------------------------------------------------- 5. units, waiting money
-- unlocked units: a fee on a locked deposit no longer eats into the unlocked ones (fees and withdrawals are spread pro rata)
create or replace function public._unlocked_units(p uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(greatest(0, least(held,
           case when remaining > 0 then greatest(0, unl + wd) * held / remaining else 0 end)), 0)
  from (select _units_of(p) as held,
               coalesce(sum(units) filter (where kind = 'deposit' and lock_until <= current_date), 0) as unl,
               coalesce(sum(units) filter (where kind = 'withdrawal'), 0) as wd,
               coalesce(sum(units) filter (where kind = 'deposit'), 0) + coalesce(sum(units) filter (where kind = 'withdrawal'), 0) as remaining
          from ledger where profile_id = p) t
$$;

-- money received counts toward the pool only once it has arrived in MEXC (when settlement_gate is on; off = as before)
create or replace function public._pending_total() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(usdt), 0) from pending_deposits
   where status = 'pending' and (arrived_at is not null or coalesce(_setting('settlement_gate'), 'off') <> 'on')
$$;

create or replace function public._convert_pending(p_id bigint, p_price numeric, p_at timestamptz, p_actor uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  pd pending_deposits%rowtype; pr profiles%rowtype; u numeric := _total_units();
  v_units numeric; v_rate numeric; v_lock date; v_eq_id bigint; v_led bigint;
begin
  select * into pd from pending_deposits where id = p_id and status = 'pending' for update;
  if not found then return 0; end if;
  select * into pr from profiles where id = pd.profile_id;
  v_units := round(pd.usdt / p_price, 8);
  v_rate := coalesce(pd.php_rate, _last_php_rate());
  v_lock := case when pr.role = 'admin' then null else (p_at::date + make_interval(months => (_setting('lock_months'))::int))::date end;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (p_at, 'deposit', u * p_price + pd.usdt, u + v_units, p_price, v_rate,
          coalesce(pd.note, 'deposit received ' || to_char(pd.received_at, 'YYYY-MM-DD')), p_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (p_at, pd.profile_id, 'deposit', v_units, pd.usdt, p_price, v_rate, pd.php_amount, v_lock, v_eq_id, pd.note) returning id into v_led;
  update pending_deposits set status = 'converted', ledger_id = v_led where id = p_id;
  return v_units;
end $$;

create or replace function public._convert_all_pending(p_price numeric, p_at timestamptz, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_n int := 0; v_units numeric := 0;
begin
  if exists (select 1 from pending_deposits where status = 'pending' and received_at > p_at + interval '5 minutes') then
    raise exception 'a waiting deposit arrived after this reading''s date: record the reading at or after it';
  end if;
  for r in select id from pending_deposits
            where status = 'pending' and (arrived_at is not null or coalesce(_setting('settlement_gate'), 'off') <> 'on')
            order by received_at, id loop
    v_units := v_units + _convert_pending(r.id, p_price, p_at, p_actor); v_n := v_n + 1;
  end loop;
  return jsonb_build_object('converted', v_n, 'units', v_units);
end $$;

drop function if exists public.admin_receive_deposit(text, uuid, numeric, numeric, numeric, text, timestamptz);
drop function if exists public.admin_post_equity(text, numeric, numeric, text, timestamptz);
drop function if exists public.admin_close_quarter(text, numeric, numeric, text, timestamptz);
drop function if exists public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz);

create or replace function public.admin_receive_deposit(p_token text, p_profile uuid, p_usdt numeric, p_php_rate numeric default null,
    p_php_amount numeric default null, p_note text default null, p_at timestamptz default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); pr profiles%rowtype; v_at timestamptz; v_id bigint; v_res jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_receive_deposit'); if v_res is not null then return v_res; end if;
  v_at := coalesce(p_at, now());
  if p_usdt is null or p_usdt <= 0 then raise exception 'deposit must be > 0 USDT'; end if;
  if v_at > now() + interval '5 minutes' then raise exception 'the date cannot be in the future'; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  insert into pending_deposits(profile_id, usdt, php_rate, php_amount, note, received_at, created_by)
  values (p_profile, p_usdt, coalesce(p_php_rate, _last_php_rate()), p_php_amount, p_note, v_at, v_actor) returning id into v_id;
  return _idem_put(p_idem, 'admin_receive_deposit', jsonb_build_object('id', v_id, 'pending_usdt', _pending_total()), v_actor);
end $$;

create or replace function public.admin_cancel_pending(p_token text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  perform _ledger_lock();
  update pending_deposits set status = 'cancelled' where id = p_id and status = 'pending';
  if not found then raise exception 'that deposit is not waiting any more'; end if;
end $$;

-- manager: this waiting deposit's money has reached MEXC (optionally with the MEXC transfer id)
create or replace function public.admin_mark_arrived(p_token text, p_pending bigint, p_transfer_id text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  perform _ledger_lock();
  update pending_deposits set arrived_at = coalesce(arrived_at, now()), mexc_transfer_id = coalesce(mexc_transfer_id, nullif(trim(p_transfer_id), ''))
   where id = p_pending and status = 'pending';
  if not found then raise exception 'that deposit is not waiting any more'; end if;
end $$;

-- ---------------------------------------------------------------- 6. valuation points
create or replace function public.admin_post_equity(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); u numeric; v_at timestamptz; v_pend numeric; v_price numeric; v_conv jsonb; v_rate numeric;
  v_res jsonb; v_note text := p_note; v_flag text;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_post_equity'); if v_res is not null then return v_res; end if;
  u := _total_units(); v_at := _at(p_at); v_pend := _pending_total(); v_rate := coalesce(p_php_rate, _last_php_rate());
  if u = 0 and v_pend = 0 then raise exception 'no units yet: record the first deposit first'; end if;
  if u > 0 then
    v_flag := _check_move(_net_equity(p_equity), p_confirm);
    v_note := coalesce(p_note, '') || v_flag;
    v_price := _price_from(p_equity);
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
    values (v_at, 'update', _net_equity(p_equity), u, v_price, v_rate, nullif(v_note, ''), v_actor);
  else
    if p_equity is null or p_equity <= 0 then raise exception 'enter the current pool equity in USDT (must be > 0)'; end if;
    v_price := 1;
  end if;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);
  if u = 0 and abs(p_equity - v_pend) > 0.000001 then
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
    values (v_at, 'update', p_equity, _total_units(), p_equity / _total_units(), v_rate, p_note, v_actor);
  end if;
  perform _check_books();
  return _idem_put(p_idem, 'admin_post_equity', jsonb_build_object('unit_price', _price_now(), 'total_units', _total_units(), 'equity_usdt', p_equity,
                            'converted', v_conv->'converted', 'converted_units', v_conv->'units'), v_actor);
end $$;

create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; v_price numeric; v_eq_id bigint; v_admin uuid; r record; v_lastc timestamptz;
  v_fee numeric; v_total numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb; v_gap int := coalesce(_setting('min_days_between_closes'), '80')::int;
  v_res jsonb; v_flag text;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_close_quarter'); if v_res is not null then return v_res; end if;
  v_at := _at(p_at); u := _total_units();
  if u = 0 then raise exception 'no units yet'; end if;
  select max(ts) into v_lastc from pool_equity where kind = 'close';
  if v_lastc is not null and v_at < v_lastc + make_interval(days => v_gap) then
    raise exception 'the last quarter close was on %; the next quarter close is allowed from %', v_lastc::date, (v_lastc + make_interval(days => v_gap))::date;
  end if;
  perform _settlement_gate(p_equity);
  v_flag := _check_move(_net_equity(p_equity), p_confirm);
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', _net_equity(p_equity), u, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_fee := _period_close(r.id, v_price, r.fee_rate, v_eq_id);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee');
      v_total := v_total + v_fee; v_n := v_n + 1;
    end if;
  end loop;
  update investor_period set credit = 0, updated_at = now() where credit <> 0;       -- a new period starts: nothing is carried over
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);
  perform _check_books();
  return _idem_put(p_idem, 'admin_close_quarter', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'converted', v_conv->'converted'), v_actor);
end $$;

create or replace function public.admin_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; pr profiles%rowtype; hu numeric; v_price numeric; v_net_eq numeric; v_rate_fee numeric;
  v_fee numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric; v_res jsonb; v_flag text;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_withdraw'); if v_res is not null then return v_res; end if;
  v_at := _at(p_at); u := _total_units();
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if u <= 0 then raise exception 'the pool has no units'; end if;
  if p_request_id is not null and not exists (select 1 from withdrawal_requests where id = p_request_id and profile_id = p_profile and status = 'pending' for update) then
    raise exception 'that withdrawal request is not waiting any more (already paid or cancelled)';
  end if;
  hu := _units_of(p_profile);
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_request_id is not null then p_units := least(p_units, hu); end if;      -- a request for "everything" pays what is left
  if p_units > hu + 0.00000001 then raise exception 'person only holds % units', hu; end if;
  p_units := least(p_units, hu);
  if pr.role = 'investor' and not p_force and p_units > _unlocked_units(p_profile) + 0.00000001 then
    raise exception 'locked: only % units are past lock-up (use force to override)', _unlocked_units(p_profile);
  end if;
  v_net_eq := _net_equity(p_equity_before);
  v_flag := _check_move(v_net_eq, p_confirm);
  v_price := v_net_eq / u;
  v_rate_fee := case when pr.role = 'investor' then pr.fee_rate else 0 end;
  v_fee := _period_take(p_profile, p_units, v_price, v_rate_fee, null);
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if v_net_eq - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq - v_pay, u - v_net, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform _period_take(p_profile, p_units, v_price, v_rate_fee, v_eq_id);
  if v_fee > 0 then
    select id into v_admin from profiles where role = 'admin' limit 1;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_at, v_admin,   'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, p_note) returning id into v_led;
  if p_request_id is not null then update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id; end if;
  perform _check_books();
  return _idem_put(p_idem, 'admin_withdraw', jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'net_units', v_net, 'pay_usdt', v_pay), v_actor);
end $$;

-- the instant deposit (database owner / scripts only): same rules, locked and checked
create or replace function public.admin_deposit(p_token text, p_profile uuid, p_usdt numeric, p_equity_before numeric default null,
    p_php_rate numeric default null, p_php_amount numeric default null, p_note text default null, p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; pr profiles%rowtype; v_price numeric; v_units numeric;
  v_eq_id bigint; v_rate numeric; v_lock date; v_eq_after numeric;
begin
  perform _ledger_lock();
  v_at := _at(p_at); u := _total_units();
  if p_usdt is null or p_usdt <= 0 then raise exception 'deposit must be > 0 USDT'; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  v_price := case when u = 0 then 1 else _price_from(p_equity_before) end;
  v_units := round(p_usdt / v_price, 8);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  v_lock := case when pr.role = 'admin' then null else (v_at::date + make_interval(months => (_setting('lock_months'))::int))::date end;
  v_eq_after := case when u = 0 then 0 else _net_equity(p_equity_before) end + p_usdt;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'deposit', v_eq_after, u + v_units, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, p_usdt, v_price, v_rate, p_php_amount, v_lock, v_eq_id, p_note);
  perform _check_books();
  return jsonb_build_object('units', v_units, 'unit_price', v_price, 'lock_until', v_lock);
end $$;

-- ---------------------------------------------------------------- 7. withdrawal requests (locked, so units cannot be promised twice)
create or replace function public.request_withdrawal(p_token text, p_units numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid := _me_rw(p_token); pr profiles%rowtype; v_by date; v_open numeric;
begin
  perform _ledger_lock();
  select * into pr from profiles where id = v;
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  v_open := coalesce((select sum(units) from withdrawal_requests where profile_id = v and status = 'pending'), 0);
  if p_units + v_open > _units_of(v) + 0.00000001 then raise exception 'you only hold % units (% already in pending requests)', _units_of(v), v_open; end if;
  if pr.role = 'investor' and p_units + v_open > _unlocked_units(v) + 0.00000001 then
    raise exception 'locked: % units are past lock-up and % are already in pending requests. Next unlock: %', _unlocked_units(v), v_open,
      (select min(lock_until) filter (where lock_until > current_date) from ledger where profile_id = v and kind = 'deposit');
  end if;
  v_by := add_business_days(current_date, (_setting('withdrawal_business_days'))::int);
  insert into withdrawal_requests(profile_id, units, note, pay_by) values (v, p_units, p_note, v_by);
  return jsonb_build_object('pay_by', v_by);
end $$;

create or replace function public.cancel_withdrawal_request(p_token text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid := _me_rw(p_token);
begin
  perform _ledger_lock();
  update withdrawal_requests set status = 'cancelled'
   where id = p_id and status = 'pending'
     and (profile_id = v or exists (select 1 from profiles where id = v and role = 'admin'));
end $$;

-- ---------------------------------------------------------------- 8. corrections: each entry once, never a correction of a correction
create or replace function public.admin_undo_last(p_token text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_last pool_equity%rowtype; v_prev pool_equity%rowtype; v_note text := coalesce(p_note, 'correction');
  v_new_eq bigint; r record; v_profile uuid; v_back boolean := false; v_out jsonb;
begin
  perform _ledger_lock();
  select * into v_last from pool_equity order by id desc limit 1;
  if not found then raise exception 'nothing to undo'; end if;
  if v_last.reversed_of is not null then
    raise exception 'that entry is itself a correction and cannot be undone. Enter the right entry again instead.';
  end if;
  if exists (select 1 from corrections where original_equity_id = v_last.id) then raise exception 'that entry was already reversed'; end if;
  if v_last.kind = 'close' then raise exception 'a quarter close is final and cannot be undone here'; end if;
  select * into v_prev from pool_equity where id < v_last.id order by id desc limit 1;

  if v_last.kind = 'update' then
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'update', v_prev.equity_usdt, v_prev.total_units, v_prev.unit_price, v_prev.php_rate, v_note, v_actor, v_last.id) returning id into v_new_eq;
    v_out := jsonb_build_object('kind', 'update');

  elsif v_last.kind = 'deposit' then
    select * into r from ledger where equity_id = v_last.id and kind = 'deposit';
    if not found then raise exception 'could not find the matching entry'; end if;
    v_profile := r.profile_id;
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'withdrawal', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), coalesce(v_prev.unit_price, v_last.unit_price), v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
    values (now(), v_profile, 'deposit', -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    perform _period_revert(v_last.id);
    update pending_deposits set status = 'pending', ledger_id = null where ledger_id = r.id;
    v_back := found;
    v_out := jsonb_build_object('kind', 'deposit', 'profile_id', v_profile, 'back_to_pending', v_back);

  else   -- withdrawal
    v_profile := (select profile_id from ledger where equity_id = v_last.id and kind = 'withdrawal' limit 1);
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'deposit', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), coalesce(v_prev.unit_price, v_last.unit_price), v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    for r in select * from ledger where equity_id = v_last.id loop
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
      values (now(), r.profile_id, r.kind, -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    end loop;
    perform _period_revert(v_last.id);
    update withdrawal_requests set status = 'pending', ledger_id = null
     where ledger_id in (select id from ledger where equity_id = v_last.id and kind = 'withdrawal');
    v_out := jsonb_build_object('kind', 'withdrawal', 'profile_id', v_profile);
  end if;
  insert into corrections(original_equity_id, correction_equity_id, reason, created_by) values (v_last.id, v_new_eq, v_note, v_actor);
  perform _check_books();
  return v_out;
end $$;

-- ---------------------------------------------------------------- 9. what the app shows
-- hwm / lots keep their names so the app's withdrawal and quarter-close previews work unchanged: they describe ONE line per person at
-- price - (period profit so far) / units, so  rate x max(0, price - line) x units  equals  rate x max(0, the period profit so far),
-- and a typed price p gives  max(0, p - line) x units = max(0, profit so far + units x (p - price)).
create or replace function public._holder_summary(p uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pr profiles%rowtype; v_price numeric := _price_now(); v_tu numeric := _total_units();
  v_units numeric; v_dep numeric; v_wd numeric; v_feein numeric; v_hwm numeric; v_gain numeric; v_lots jsonb; v_pp numeric;
  v_val numeric; v_profit numeric; v_acc numeric; v_unl numeric; v_next date; v_last date;
  v_feeu numeric; v_feeusd numeric; v_gross numeric; v_net numeric; v_share numeric;
begin
  select * into pr from profiles where id = p;
  if not found then return null; end if;
  v_units := _units_of(p);
  select coalesce(sum(usdt) filter (where kind = 'deposit'), 0),
         coalesce(-sum(usdt) filter (where kind = 'withdrawal'), 0),
         coalesce(sum(units) filter (where kind = 'fee_in'), 0),
         coalesce(-sum(units) filter (where kind = 'fee_out'), 0),
         coalesce(-sum(usdt) filter (where kind = 'fee_out'), 0)
    into v_dep, v_wd, v_feein, v_feeu, v_feeusd from ledger where profile_id = p;
  v_val := v_units * v_price;
  v_pp := case when v_units > 0 and pr.role = 'investor' then _period_profit(p, _last_close(null), (select max(id) from pool_equity)) - _period_credit(p) else 0 end;
  v_gain := greatest(0, v_pp);                             -- profit of this period still to be charged, USDT
  v_hwm := case when v_units > 0 then v_price - v_pp / v_units else v_price end;   -- above the price when the period is a loss so far: the app adds the typed price move to it
  v_lots := case when v_units > 0 then jsonb_build_array(jsonb_build_array(v_units, v_hwm)) else '[]'::jsonb end;
  v_profit := v_val + v_wd - v_dep;
  v_acc := case when pr.role = 'investor' then pr.fee_rate * v_gain else 0 end;
  v_unl := case when pr.role = 'admin' then v_units else _unlocked_units(p) end;
  v_gross := (v_units + v_feeu) * v_price;
  v_net := v_val - v_acc;
  v_share := v_feeu * v_price + v_acc;
  select min(lock_until) filter (where lock_until > current_date), max(lock_until)
    into v_next, v_last from ledger where profile_id = p and kind = 'deposit';
  return jsonb_build_object(
    'id', pr.id, 'username', pr.username, 'name', pr.name, 'role', pr.role, 'active', pr.active,
    'fee_rate', pr.fee_rate, 'fee_rate_next', pr.fee_rate_next,
    'units', v_units, 'unit_price', v_price, 'value_usdt', v_val,
    'deposited_usdt', v_dep, 'withdrawn_usdt', v_wd, 'net_in_usdt', v_dep - v_wd,
    'profit_usdt', v_profit, 'return_pct', case when v_dep > 0 then v_profit / v_dep end,
    'period_profit_usdt', v_pp,
    'hwm', v_hwm, 'lots', v_lots, 'accrued_fee_usdt', v_acc, 'value_after_fee_usdt', v_net,
    'fee_paid_units', v_feeu, 'fee_paid_usdt', v_feeusd, 'profit_share_usdt', v_share,
    'gross_value_usdt', v_gross, 'gross_profit_usdt', v_gross + v_wd - v_dep,
    'gross_return_pct', case when v_dep > 0 then (v_gross + v_wd - v_dep) / v_dep end,
    'net_value_usdt', v_net, 'net_profit_usdt', v_net + v_wd - v_dep,
    'net_return_pct', case when v_dep > 0 then (v_net + v_wd - v_dep) / v_dep end,
    'profit_share_pct_points', case when v_dep > 0 then v_share / v_dep end,
    'share_pct', case when v_tu > 0 then v_units / v_tu end,
    'fee_units_earned', v_feein, 'fee_units_value_usdt', v_feein * v_price,
    'unlocked_units', v_unl, 'next_unlock', v_next, 'lock_until', v_last,
    'php_rate', _last_php_rate());
end $$;

-- ---------------------------------------------------------------- 10. bot: valuation (locked, unmatched transfers block it) and snapshot
create or replace function public.bot_post_equity(p_key text, p_equity numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := _setting('bot_key_hash'); u numeric; v_last pool_equity%rowtype; v_price numeric; v_at timestamptz;
  v_jump numeric := coalesce(_setting('bot_max_jump'), '0.15')::numeric;
begin
  if v_hash is null or v_hash = '' or encode(digest(coalesce(p_key, ''), 'sha256'), 'hex') <> v_hash then raise exception 'not allowed'; end if;
  if p_equity is null or p_equity <= 0 then raise exception 'equity must be more than 0'; end if;
  perform _ledger_lock();
  u := _total_units();
  if coalesce(_setting('bot_sync_paused'), '0') = '1' then return jsonb_build_object('ok', false, 'skipped', 'paused'); end if;
  if u = 0 then return jsonb_build_object('ok', false, 'skipped', 'no units yet: record the first deposit first'); end if;
  if _pending_total() > 0 then
    return jsonb_build_object('ok', false, 'skipped', 'a deposit is waiting to join: post the next reading by hand (Update equity)');
  end if;
  if exists (select 1 from withdrawal_requests where status = 'pending') then
    return jsonb_build_object('ok', false, 'skipped', 'a withdrawal request is open: the payout may already have left MEXC');
  end if;
  if exists (select 1 from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id)) then
    return jsonb_build_object('ok', false, 'skipped', 'a MEXC transfer is not matched to a deposit or withdrawal yet: classify it first');
  end if;
  select * into v_last from pool_equity order by ts desc, id desc limit 1;
  if v_last.id is not null then
    if v_last.ts > now() - make_interval(mins => coalesce(_setting('bot_min_minutes'), '10')::int) then
      return jsonb_build_object('ok', false, 'skipped', 'too soon after the last reading');
    end if;
    if v_last.equity_usdt > 0 and abs(p_equity / v_last.equity_usdt - 1) > v_jump then
      return jsonb_build_object('ok', false, 'skipped', 'jump', 'last_usdt', v_last.equity_usdt, 'new_usdt', p_equity,
                                'detail', 'balance moved more than ' || round(v_jump * 100) || '% since the last reading: record the transfer, then post by hand');
    end if;
  end if;
  v_at := _at(null);
  v_price := _price_from(p_equity);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'update', p_equity, u, v_price, _last_php_rate(), coalesce(p_note, 'MEXC balance (bot)'), null);
  perform _check_books();
  return jsonb_build_object('ok', true, 'unit_price', v_price, 'equity_usdt', p_equity, 'total_units', u);
end $$;

-- The bot reports what MEXC says: balance, open positions and orders, realised PnL since its last snapshot, and the transfer
-- history. Inbound transfers are matched to a waiting deposit (same amount), outbound ones to a recorded withdrawal. Anything
-- unmatched, or a balance that does not follow from the previous snapshot, is reported as 'blocked'. Nothing here changes the books.
create or replace function public.bot_post_snapshot(p_key text, p_equity numeric, p_open_positions int, p_open_orders int,
    p_unrealized numeric default null, p_realized_since numeric default null, p_transfers jsonb default '[]'::jsonb, p_transfers_complete boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := _setting('bot_key_hash'); prev exchange_snapshots%rowtype; t jsonb; v_tid bigint; v_new int := 0; v_dup int := 0;
  v_in numeric := 0; v_out numeric := 0; v_exp numeric; v_diff numeric; v_status text; v_detail text := ''; v_id bigint; v_unm int;
  v_tol numeric; pd bigint; lg bigint;
begin
  if v_hash is null or v_hash = '' or encode(digest(coalesce(p_key, ''), 'sha256'), 'hex') <> v_hash then raise exception 'not allowed'; end if;
  if p_equity is null or p_equity < 0 or p_open_positions is null or p_open_orders is null then raise exception 'incomplete snapshot: nothing was saved'; end if;
  perform _ledger_lock();
  select * into prev from exchange_snapshots order by id desc limit 1;
  for t in select * from jsonb_array_elements(coalesce(p_transfers, '[]'::jsonb)) loop
    insert into exchange_transfers(ext_id, ts, direction, usdt)
    values (t->>'id', (t->>'ts')::timestamptz, t->>'dir', (t->>'usdt')::numeric) on conflict (ext_id) do nothing returning id into v_tid;
    if v_tid is null then v_dup := v_dup + 1; else v_new := v_new + 1; end if;
    v_tid := null;
  end loop;
  -- auto-match: inbound -> a waiting deposit of the same amount; outbound -> a recorded withdrawal of the same amount
  for t in select to_jsonb(x) from (select * from exchange_transfers e where not exists (select 1 from transfer_matches m where m.transfer_id = e.id) order by e.ts, e.id) x loop
    if t->>'direction' = 'in' then
      select id into pd from pending_deposits where status = 'pending' and arrived_at is null and abs(usdt - (t->>'usdt')::numeric) <= 0.01 order by received_at, id limit 1;
      if pd is not null then
        update pending_deposits set arrived_at = now(), mexc_transfer_id = t->>'ext_id' where id = pd;
        insert into transfer_matches(transfer_id, kind, pending_deposit_id) values ((t->>'id')::bigint, 'auto_deposit', pd);
      end if;
      pd := null;
    else
      select l.id into lg from ledger l where l.kind = 'withdrawal' and l.reversed_of is null and abs(-l.usdt - (t->>'usdt')::numeric) <= 0.01
         and not exists (select 1 from transfer_matches m where m.ledger_id = l.id) order by l.id limit 1;
      if lg is not null then insert into transfer_matches(transfer_id, kind, ledger_id) values ((t->>'id')::bigint, 'auto_withdrawal', lg); end if;
      lg := null;
    end if;
  end loop;
  select count(*) into v_unm from exchange_transfers e where not exists (select 1 from transfer_matches m where m.transfer_id = e.id);
  v_tol := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, p_equity * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
  if prev.id is null then
    v_status := 'baseline'; v_detail := 'first snapshot: nothing to compare with yet';
  else
    select coalesce(sum(usdt) filter (where direction = 'in'), 0), coalesce(sum(usdt) filter (where direction = 'out'), 0)
      into v_in, v_out from exchange_transfers where ts > prev.ts;
    if p_realized_since is not null then
      v_exp := prev.equity_usdt + v_in - v_out + p_realized_since + (coalesce(p_unrealized, 0) - coalesce(prev.unrealized_usdt, 0));
      v_diff := p_equity - v_exp;
    end if;
    if not p_transfers_complete then v_status := 'blocked'; v_detail := 'transfer history was not verified by the bot';
    elsif p_realized_since is null then v_status := 'blocked'; v_detail := 'realised PnL was not reported';
    elsif v_unm > 0 then v_status := 'blocked'; v_detail := v_unm || ' unmatched MEXC transfer(s)';
    elsif abs(v_diff) > v_tol then v_status := 'blocked'; v_detail := format('balance differs from the expected %s by %s', round(v_exp, 4), round(v_diff, 4));
    else v_status := 'ok'; v_detail := null; end if;
  end if;
  insert into exchange_snapshots(equity_usdt, unrealized_usdt, open_positions, open_orders, realized_since, transfers_complete, expected_usdt, diff_usdt, recon_status, recon_detail)
  values (p_equity, p_unrealized, p_open_positions, p_open_orders, p_realized_since, coalesce(p_transfers_complete, false), v_exp, v_diff, v_status, v_detail) returning id into v_id;
  return jsonb_build_object('ok', true, 'snapshot_id', v_id, 'recon_status', v_status, 'recon_detail', v_detail, 'new_transfers', v_new, 'duplicate_transfers', v_dup,
                            'unmatched_transfers', v_unm, 'open_positions', p_open_positions);
end $$;

-- manager: written reason for a snapshot that did not reconcile on its own
create or replace function public.admin_attest_snapshot(p_token text, p_snapshot bigint, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token);
begin
  perform _ledger_lock();
  if not exists (select 1 from exchange_snapshots where id = p_snapshot) then raise exception 'unknown snapshot'; end if;
  insert into snapshot_attestations(snapshot_id, note, created_by) values (p_snapshot, p_note, v_actor);
end $$;

-- manager: say what an unmatched MEXC transfer was (a reason of at least 10 characters is required and kept forever)
create or replace function public.admin_classify_transfer(p_token text, p_ext_id text, p_classification text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_id bigint;
begin
  perform _ledger_lock();
  select id into v_id from exchange_transfers where ext_id = p_ext_id;
  if v_id is null then raise exception 'unknown MEXC transfer'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'write the reason (at least 10 characters)'; end if;
  insert into transfer_matches(transfer_id, kind, classification, note, created_by) values (v_id, 'classified', p_classification, p_note, v_actor);
end $$;

-- ---------------------------------------------------------------- 11. read-only integrity report (changes nothing)
create or replace function public.admin_integrity_report(p_token text) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  rep jsonb := '[]'::jsonb; v jsonb; l pool_equity%rowtype;
begin
  perform _admin(p_token);
  select * into l from pool_equity order by id desc limit 1;
  v := coalesce((select jsonb_agg(jsonb_build_object('profile_id', profile_id, 'units', tot)) from (select profile_id, sum(units) tot from ledger group by profile_id having sum(units) < -0.000000001) x), '[]');
  rep := rep || jsonb_build_object('id', 'negative_unit_balance', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);
  v := jsonb_build_array(jsonb_build_object('ledger_units', (select coalesce(sum(units), 0) from ledger), 'last_entry_units', l.total_units));
  rep := rep || jsonb_build_object('id', 'total_units_vs_last_entry', 'severity', 'critical',
           'count', case when l.id is not null and abs((select coalesce(sum(units), 0) from ledger) - l.total_units) > 0.000001 then 1 else 0 end, 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('equity_id', equity_id, 'net_units', tot)) from (select equity_id, sum(units) tot from ledger where kind in ('fee_in', 'fee_out') group by equity_id having abs(sum(units)) > 0.00000001) x), '[]');
  rep := rep || jsonb_build_object('id', 'fee_transfer_not_netting_to_zero', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('profile_id', i.profile_id, 'credit', i.credit)) from investor_period i join profiles p on p.id = i.profile_id where p.role <> 'investor'), '[]');
  rep := rep || jsonb_build_object('id', 'period_credit_on_a_non_investor', 'severity', 'medium', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('correction_id', c.id, 'reverses', c.reversed_of, 'is_reversed_by', o.id))
                   from pool_equity c join pool_equity o on o.reversed_of = c.id where c.reversed_of is not null), '[]');
  rep := rep || jsonb_build_object('id', 'correction_that_was_itself_reversed', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('ledger_id', c.id, 'reverses', c.reversed_of, 'is_reversed_by', o.id)) from ledger c join ledger o on o.reversed_of = c.id where c.reversed_of is not null), '[]');
  rep := rep || jsonb_build_object('id', 'ledger_row_reversal_chain', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('reversed_of', reversed_of, 'times', n)) from (select reversed_of, count(*) n from pool_equity where reversed_of is not null group by reversed_of having count(*) > 1) x), '[]');
  rep := rep || jsonb_build_object('id', 'entry_reversed_more_than_once', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('close_ids', ids, 'ts', ts)) from (select ts::date ts, array_agg(id) ids from pool_equity where kind = 'close' group by ts::date having count(*) > 1) x), '[]');
  rep := rep || jsonb_build_object('id', 'several_settlements_on_one_day', 'severity', 'high', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'equity', e.equity_usdt, 'price_x_units', e.unit_price * e.total_units))
                   from pool_equity e where abs(e.equity_usdt - e.unit_price * e.total_units) > 0.0001 + e.equity_usdt * 0.000000001), '[]');
  rep := rep || jsonb_build_object('id', 'entry_where_equity_is_not_price_times_units', 'severity', 'high', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('transfer', ext_id, 'direction', direction, 'usdt', usdt, 'ts', ts)) from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id)), '[]');
  rep := rep || jsonb_build_object('id', 'unmatched_mexc_transfers', 'severity', 'high', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('pending_id', id, 'usdt', usdt, 'received_at', received_at)) from pending_deposits where status = 'pending' and arrived_at is null and received_at < now() - interval '7 days'), '[]');
  rep := rep || jsonb_build_object('id', 'deposit_waiting_over_7_days_not_arrived', 'severity', 'medium', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('request_id', r2.id)) from withdrawal_requests r2 where r2.status = 'paid' and r2.ledger_id is null), '[]');
  rep := rep || jsonb_build_object('id', 'paid_request_without_ledger_entry', 'severity', 'high', 'count', jsonb_array_length(v), 'rows', v);

  return jsonb_build_object('generated_at', now(), 'fee_engine', _setting('fee_engine'), 'checks', rep,
                            'worst', (select coalesce(max(case c->>'severity' when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end) filter (where (c->>'count')::int > 0), -1)
                                        from jsonb_array_elements(rep) c));
end $$;

-- ---------------------------------------------------------------- 12. backups include the new tables; the per-deposit check is replaced
create or replace function public._export_all() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'format', 'lucidyo-ledger-backup-1',
    'exported_at', now(),
    'people', (select coalesce(jsonb_agg(to_jsonb(p) - 'pass_hash' - 'failed_attempts' - 'locked_until' order by p.created_at, p.id), '[]'::jsonb) from profiles p),
    'pool_equity', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb) from pool_equity e),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) from ledger l),
    'pending_deposits', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) from pending_deposits d),
    'withdrawal_requests', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) from withdrawal_requests r),
    'holder_lots', (select coalesce(jsonb_agg(to_jsonb(h) order by h.id), '[]'::jsonb) from holder_lots h),
    'lot_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from lot_log g),
    'investor_period', (select coalesce(jsonb_agg(to_jsonb(f) order by f.profile_id), '[]'::jsonb) from investor_period f),
    'period_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from period_log g),
    'corrections', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb) from corrections c),
    'exchange_snapshots', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from exchange_snapshots s),
    'exchange_transfers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from exchange_transfers t),
    'transfer_matches', (select coalesce(jsonb_agg(to_jsonb(m) order by m.transfer_id), '[]'::jsonb) from transfer_matches m),
    'snapshot_attestations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from snapshot_attestations a),
    'terms_acceptances', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from terms_acceptances t),
    'settings', (select coalesce(jsonb_agg(to_jsonb(s) order by s.key), '[]'::jsonb) from ledger_settings s where s.key not in ('bot_key_hash')),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from audit_log a),
    'checks', jsonb_build_object(
      'people', (select count(*) from profiles), 'ledger_rows', (select count(*) from ledger), 'equity_rows', (select count(*) from pool_equity),
      'total_units_ledger', (select coalesce(sum(units), 0) from ledger),
      'total_units_last_reading', (select total_units from pool_equity order by id desc limit 1),
      -- the per-deposit lines stopped being updated with the flat fee engine; kept so old backups still read the same
      'lots_units', (select coalesce(sum(units), 0) from ledger),
      'fee_engine', (select value from ledger_settings where key = 'fee_engine'),
      'last_equity_usdt', (select equity_usdt from pool_equity order by id desc limit 1),
      'waiting_usdt', (select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending')))
$$;

-- ---------------------------------------------------------------- 13. access
revoke all on function public._ledger_lock(), public._idem_get(text, text), public._idem_put(text, text, jsonb, uuid), public._check_books(),
  public._check_move(numeric, boolean), public._settlement_gate(numeric), public._last_close(bigint), public._period_profit(uuid, bigint, bigint, numeric), public._period_credit(uuid),
  public._period_take(uuid, numeric, numeric, numeric, bigint), public._period_close(uuid, numeric, numeric, bigint), public._period_revert(bigint),
  public._fee_units(numeric, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke execute on function public.admin_deposit(text, uuid, numeric, numeric, numeric, numeric, text, timestamptz) from public, anon, authenticated;
revoke all on function public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean) from public;
revoke all on function public.admin_mark_arrived(text, bigint, text), public.admin_attest_snapshot(text, bigint, text),
  public.admin_classify_transfer(text, text, text, text), public.admin_integrity_report(text) from public;
grant execute on function
  public.admin_post_equity(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean),
  public.admin_receive_deposit(text, uuid, numeric, numeric, numeric, text, timestamptz, text),
  public.admin_cancel_pending(text, bigint), public.admin_mark_arrived(text, bigint, text),
  public.admin_attest_snapshot(text, bigint, text), public.admin_classify_transfer(text, text, text, text), public.admin_integrity_report(text),
  public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean)
to anon, authenticated;

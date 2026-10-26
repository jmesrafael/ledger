-- TWO-MONTH SETTLEMENT on top of the stored high-water mark of 20261105000000_hwm_arrival_lockup.sql (investor_hwm). Read docs/hwm-settlement.md.
-- Run after 20261105000000_hwm_arrival_lockup.sql (and before or after 20261106000000_capital_workflow.sql). NOT yet run on any database. No existing row is changed: this adds tables
-- and functions, replaces function bodies and changes settings.
--
-- WHAT IT FIXES
--  1  (The high-water mark itself is 1105's stored investor_hwm; this file only calls _hwm_value / _hwm_close.)
--  2  Settlements follow two-month calendar periods (settlement_anchor, settlement_period_months, settlement_tz), one per period.
--  3  A settlement reconciles the period (ledger identity vs an independent price-move recomputation, unmatched Exchange transfers,
--     snapshot evidence) and refuses to finalize an unexplained difference.
--  4  Fund M's own capital and its fee entitlement are split by replay; pool_summary uses the split.
--  5  Every settlement is recorded (settlements, settlement_lines; append-only).

-- ---------------------------------------------------------------- 0. preflight
do $$
begin
  if to_regclass('public.investor_hwm') is null or coalesce((select value from public.ledger_settings where key = 'fee_engine'), '') <> 'investor_hwm_v2' then
    raise exception 'preflight: run 20261105000000_hwm_arrival_lockup.sql first (stored high-water mark). Nothing was changed.';
  end if;
  if exists (select 1 from public.ledger where equity_id is null) then
    raise exception 'preflight: ledger rows without a pool entry exist; the high-water mark cannot be replayed. Review before applying.';
  end if;
  if exists (select 1 from public.pool_equity) and abs((select coalesce(sum(units), 0) from public.ledger) - (select total_units from public.pool_equity order by id desc limit 1)) > 0.000001 then
    raise exception 'preflight: everyone''s units differ from the last pool entry. Run admin_integrity_report and review before applying.';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. settings
insert into public.ledger_settings(key, value) values
  ('fee_basis', 'external_investors'),
  ('settlement_schedule', 'bimonthly'),
  ('settlement_period_months', '2'),
  ('settlement_anchor', '2026-01-01'),
  ('settlement_tz', 'Asia/Manila'),
  ('settlement_recon', 'require'),
  ('recon_internal_tolerance', '0.01'),
  ('fund_m_withdrawal_order', 'pro_rata')
on conflict (key) do nothing;
insert into public.ledger_settings(key, value)
select 'fund_m_own_fee_rate', coalesce((select value from public.ledger_settings where key = 'default_fee_rate'), '0.10')
on conflict (key) do nothing;
do $$
begin
  if (select value from public.ledger_settings where key = 'min_days_between_closes') = '80' then
    update public.ledger_settings set value = '0' where key = 'min_days_between_closes';
    raise notice 'min_days_between_closes was 80 (quarterly); set to 0: the two-month period rule replaces it';
  end if;
end $$;

-- ---------------------------------------------------------------- 2. tables (append-only)
create table if not exists public.settlement_attestations (
  id          bigserial primary key,
  period_end  timestamptz not null,
  mexc_total  numeric not null check (mexc_total > 0),
  recon       jsonb,
  note        text not null check (length(trim(note)) >= 20),
  created_by  uuid,
  ts          timestamptz not null default now()
);
create table if not exists public.settlements (
  id                       bigserial primary key,
  equity_id                bigint not null unique references public.pool_equity(id),
  period_start             timestamptz not null,
  period_end               timestamptz not null unique,
  valued_at                timestamptz not null,
  mexc_total               numeric not null,
  nav                      numeric not null,
  total_units              numeric not null,
  unit_price               numeric not null,
  opening_nav              numeric not null,
  deposits_usdt            numeric not null,
  withdrawals_usdt         numeric not null,
  trading_pnl_usdt         numeric not null,
  entries_after_period_end int not null default 0,
  fee_basis                text not null,
  investors_charged        int not null,
  fee_units                numeric not null,
  fee_usdt                 numeric not null,
  fund_m                   jsonb,
  recon                    jsonb not null,
  recon_status             text not null,
  attestation_id           bigint references public.settlement_attestations(id),
  created_by               uuid,
  ts                       timestamptz not null default now()
);
create table if not exists public.settlement_lines (
  equity_id       bigint not null references public.pool_equity(id),
  profile_id      uuid not null references public.profiles(id),
  units_before    numeric not null,
  unit_price      numeric not null,
  value_before    numeric not null,
  hwm_before      numeric not null,
  eligible_profit numeric not null,
  fee_rate        numeric not null,
  fee_units       numeric not null,
  fee_usdt        numeric not null,
  hwm_after       numeric not null,
  primary key (equity_id, profile_id)
);
do $$
declare t text;
begin
  foreach t in array array['settlement_attestations', 'settlements', 'settlement_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._no_change()', t || '_append_only', t);
  end loop;
end $$;
revoke all on sequence public.settlement_attestations_id_seq, public.settlements_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------- 3. Fund M's units split (investors' marks are investor_hwm, untouched here)
-- Fund M's units split into its own capital and its fee entitlement (a replay of Fund M's own ledger rows). With fee_basis = 'all_pool' the
-- capital's own profit above its mark is moved, at each settlement, into the fee entitlement (inside Fund M; nobody else is affected).
create or replace function public._fund_m_state(p_before bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_admin uuid; r record; v_e numeric; v_x numeric; v_c numeric; v_s numeric; v_tot numeric; v_price numeric;
  cu numeric := 0; fu numeric := 0; ch numeric := 0; cc numeric := 0; cw numeric := 0; fe numeric := 0; fw numeric := 0; nf numeric := 0;
  v_basis text := coalesce(_setting('fee_basis'), 'external_investors');
  v_order text := coalesce(_setting('fund_m_withdrawal_order'), 'pro_rata');
  v_rate numeric := coalesce(_setting('fund_m_own_fee_rate'), _setting('default_fee_rate'), '0.10')::numeric;
begin
  select id into v_admin from profiles where role = 'admin' limit 1;
  for r in
    select e.id, e.kind, e.unit_price,
           coalesce(sum(l.units)  filter (where l.kind = 'deposit' and l.units > 0), 0) as dep_u,
           coalesce(sum(l.usdt)   filter (where l.kind = 'deposit' and l.units > 0), 0) as dep_c,
           coalesce(sum(l.units)  filter (where l.kind = 'fee_in'), 0)                  as fee_u,
           coalesce(sum(l.usdt)   filter (where l.kind = 'fee_in'), 0)                  as fee_c,
           coalesce(-sum(l.units) filter (where l.kind not in ('fee_in') and l.units < 0), 0) as out_u,
           coalesce(-sum(l.usdt)  filter (where l.kind not in ('fee_in') and l.units < 0), 0) as out_c
      from pool_equity e
      left join ledger l on l.equity_id = e.id and l.profile_id = v_admin
     where (p_before is null or e.id < p_before)
       and e.reversed_of is null
       and not exists (select 1 from pool_equity c where c.reversed_of = e.id)
     group by e.id, e.kind, e.unit_price
    having e.kind = 'close' or count(l.id) > 0
     order by e.id
  loop
    v_e := cu * r.unit_price;
    if r.kind = 'close' and v_basis = 'all_pool' and cu > 0 then
      v_x := _fee_units(v_rate, v_e - ch, 1, 1, r.unit_price);
      cu := cu - v_x; fu := fu + v_x; nf := nf + v_x * r.unit_price; fe := fe + v_x * r.unit_price;
      ch := greatest(ch, v_e - v_x * r.unit_price);
    end if;
    if r.out_u > 0 then
      v_tot := cu + fu;
      v_c := case v_order when 'capital_first' then least(r.out_u, cu)
                          when 'fee_first' then r.out_u - least(r.out_u, fu)
                          else case when v_tot > 0 then r.out_u * cu / v_tot else 0 end end;
      if cu > 0 then
        v_s := least(1, v_c / cu);
        if v_e > ch then ch := ch * (1 - v_s); else ch := ch - v_s * v_e; end if;
      end if;
      cw := cw + r.out_c * v_c / r.out_u; fw := fw + r.out_c * (r.out_u - v_c) / r.out_u;
      cu := cu - v_c; fu := fu - (r.out_u - v_c);
    end if;
    fu := fu + r.fee_u; fe := fe + r.fee_c;
    cu := cu + r.dep_u; cc := cc + r.dep_c; ch := ch + r.dep_c;
  end loop;
  select unit_price into v_price from pool_equity where (p_before is null or id < p_before) order by id desc limit 1;
  v_price := coalesce(v_price, 1);
  return jsonb_build_object('profile_id', v_admin, 'fee_basis', v_basis, 'withdrawal_order', v_order, 'unit_price', v_price,
    'capital', jsonb_build_object('units', cu, 'value_usdt', cu * v_price, 'contributed_usdt', cc, 'withdrawn_usdt', cw,
                                  'profit_usdt', cu * v_price + cw - cc, 'hwm_usdt', case when v_basis = 'all_pool' then ch end),
    'fee_entitlement', jsonb_build_object('units', fu, 'value_usdt', fu * v_price, 'earned_usdt', fe, 'withdrawn_usdt', fw,
                                          'growth_usdt', fu * v_price + fw - fe, 'own_capital_fee_usdt', nf),
    'total_units', cu + fu);
end $$;

-- ---------------------------------------------------------------- 4. periods and reconciliation
-- The period boundary at or before p_ts (p_offset 0), or that many periods later/earlier. Boundaries are 00:00 on the 1st of a month in
-- settlement_tz, every settlement_period_months months counted from settlement_anchor.
create or replace function public._settlement_boundary(p_ts timestamptz, p_offset int default 0) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := coalesce(_setting('settlement_tz'), 'Asia/Manila');
  v_a timestamp := date_trunc('month', coalesce(_setting('settlement_anchor'), '2026-01-01')::date::timestamp);
  v_m int := greatest(1, coalesce(_setting('settlement_period_months'), '2')::int);
  v_l timestamp := p_ts at time zone v_tz; v_n int;
begin
  v_n := (extract(year from v_l)::int * 12 + extract(month from v_l)::int) - (extract(year from v_a)::int * 12 + extract(month from v_a)::int);
  return (v_a + make_interval(months => (floor(v_n::numeric / v_m)::int + p_offset) * v_m)) at time zone v_tz;
end $$;

-- the period a settlement dated p_at settles: [o_start, o_end). With settlement_schedule = 'free' it is simply "since the last settlement".
create or replace function public._settlement_period(p_at timestamptz, out o_start timestamptz, out o_end timestamptz, out o_next timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(_setting('settlement_schedule'), 'bimonthly') = 'bimonthly' then
    o_end := _settlement_boundary(p_at, 0); o_start := _settlement_boundary(p_at, -1); o_next := _settlement_boundary(p_at, 1);
  else
    o_end := p_at; o_next := p_at;
    o_start := coalesce((select max(ts) from pool_equity where kind = 'close'), (select min(ts) from pool_equity), p_at);
  end if;
end $$;

-- Reconcile everything since the last settlement up to entry p_to. p_extra_price: a settlement being previewed at that price (not written).
--   ledger trading P&L = closing NAV - opening NAV - deposits admitted + withdrawals paid
--   price trading P&L  = sum over entries of (units outstanding before the entry x its price move)      (must agree)
create or replace function public._settlement_recon(p_to bigint, p_mexc_total numeric, p_extra_price numeric default null, p_at timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from bigint := case when p_extra_price is null then _last_close(p_to) else _last_close(p_to + 1) end;
  v_open numeric; v_open_ts timestamptz; v_close numeric; v_dep numeric; v_wd numeric; v_fees numeric; v_ppnl numeric; v_lpnl numeric; v_diff numeric;
  v_unm int; s exchange_snapshots%rowtype; v_bad int; v_n int; v_status text; v_reasons jsonb := '[]'::jsonb; v_at timestamptz := coalesce(p_at, now());
  v_itol numeric := coalesce(_setting('recon_internal_tolerance'), '0.01')::numeric; v_tol numeric; v_pend numeric;
  v_hrs numeric := coalesce(_setting('snapshot_max_age_hours'), '12')::numeric;
begin
  select equity_usdt, ts into v_open, v_open_ts from pool_equity where id = v_from;
  v_open := coalesce(v_open, 0);
  if p_extra_price is null then select equity_usdt into v_close from pool_equity where id = p_to;
  else v_close := _total_units() * p_extra_price; end if;
  select coalesce(sum(usdt) filter (where kind = 'deposit'), 0), coalesce(-sum(usdt) filter (where kind = 'withdrawal'), 0),
         coalesce(sum(usdt) filter (where kind = 'fee_in'), 0)
    into v_dep, v_wd, v_fees from ledger where equity_id > v_from and equity_id <= p_to;
  with u as (select equity_id, sum(units) du from ledger group by equity_id),
       e as (select e.id, e.unit_price, coalesce(u.du, 0) du from pool_equity e left join u on u.equity_id = e.id where e.id <= p_to),
       c as (select id, unit_price - lag(unit_price) over (order by id) dp,
                    coalesce(sum(du) over (order by id rows between unbounded preceding and 1 preceding), 0) ub from e)
  select coalesce(sum(coalesce(dp, 0) * ub), 0) into v_ppnl from c where id > v_from;
  if p_extra_price is not null then
    v_ppnl := v_ppnl + _total_units() * (p_extra_price - coalesce((select unit_price from pool_equity where id = p_to), p_extra_price));
  end if;
  v_lpnl := v_close - v_open - v_dep + v_wd;
  v_diff := v_lpnl - v_ppnl;
  v_pend := case when p_mexc_total is not null then p_mexc_total - v_close end;
  v_tol := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, coalesce(p_mexc_total, 0) * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
  -- Exchange-side evidence
  select count(*) into v_unm from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id);
  select * into s from exchange_snapshots order by id desc limit 1;
  select count(*), count(*) filter (where x.recon_status = 'blocked' and not exists (select 1 from snapshot_attestations a where a.snapshot_id = x.id))
    into v_n, v_bad from exchange_snapshots x where x.ts > coalesce(v_open_ts, '-infinity'::timestamptz);
  if abs(v_diff) > v_itol then
    v_status := 'internal_mismatch';
    v_reasons := v_reasons || to_jsonb(format('ledger trading P&L %s differs from the price-move recomputation %s by %s USDT', round(v_lpnl, 6), round(v_ppnl, 6), round(v_diff, 6)));
  elsif v_unm > 0 then
    v_status := 'unmatched_transfers';
    v_reasons := v_reasons || to_jsonb(v_unm || ' Exchange transfer(s) are not matched to a deposit or withdrawal');
  else
    if s.id is null then v_reasons := v_reasons || to_jsonb('no Exchange snapshot from the bot'::text);
    else
      if s.ts < v_at - make_interval(secs => v_hrs * 3600) then v_reasons := v_reasons || to_jsonb(format('the last Exchange snapshot is older than %s hours', v_hrs)); end if;
      if s.recon_status = 'blocked' and not exists (select 1 from snapshot_attestations a where a.snapshot_id = s.id) then
        v_reasons := v_reasons || to_jsonb('the last Exchange snapshot did not reconcile: ' || coalesce(s.recon_detail, 'blocked'));
      elsif v_bad > 0 then v_reasons := v_reasons || to_jsonb(v_bad || ' Exchange snapshot(s) in this period did not reconcile and are not attested');
      end if;
      if p_mexc_total is not null and abs(s.equity_usdt - p_mexc_total) > v_tol then
        v_reasons := v_reasons || to_jsonb(format('the typed Exchange total %s differs from the last snapshot %s', round(p_mexc_total, 2), round(s.equity_usdt, 2)));
      end if;
    end if;
    v_status := case when jsonb_array_length(v_reasons) = 0 then 'verified' else 'unverified' end;
  end if;
  return jsonb_build_object('status', v_status, 'reasons', v_reasons,
    'from_equity_id', v_from, 'to_equity_id', p_to, 'opening_nav', v_open, 'opening_ts', v_open_ts, 'closing_nav', v_close,
    'deposits_usdt', v_dep, 'withdrawals_usdt', v_wd, 'fees_at_withdrawals_usdt', v_fees,
    'trading_pnl_usdt', v_lpnl, 'trading_pnl_by_price_usdt', v_ppnl, 'internal_diff_usdt', v_diff,
    'mexc_total', p_mexc_total, 'waiting_deposits_liability_usdt', v_pend,
    'snapshots_in_period', v_n, 'last_snapshot', case when s.id is not null then jsonb_build_object('id', s.id, 'ts', s.ts, 'equity_usdt', s.equity_usdt,
      'recon_status', s.recon_status, 'open_positions', s.open_positions, 'open_orders', s.open_orders) end,
    'unmatched_transfers', v_unm,
    'not_separated', 'realized vs unrealized P&L, trading fees and funding are inside the exchange total; the bot does not report them separately yet');
end $$;

-- ---------------------------------------------------------------- 5. settlement
create or replace function public.admin_attest_settlement(p_token text, p_equity numeric, p_note text, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_per record; v_id bigint; v_rec jsonb;
begin
  perform _ledger_lock();
  if p_equity is null or p_equity <= 0 then raise exception 'enter the exchange total this explanation is for'; end if;
  if p_note is null or length(trim(p_note)) < 20 then raise exception 'write what explains the difference (at least 20 characters)'; end if;
  select * into v_per from _settlement_period(coalesce(p_at, now()));
  v_rec := _settlement_recon((select max(id) from pool_equity), p_equity, _price_from(p_equity), coalesce(p_at, now()));
  if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then
    raise exception 'this cannot be explained away: % (fix it first)', v_rec->'reasons'->>0;
  end if;
  insert into settlement_attestations(period_end, mexc_total, recon, note, created_by) values (v_per.o_end, p_equity, v_rec, trim(p_note), v_actor) returning id into v_id;
  return jsonb_build_object('id', v_id, 'period_end', v_per.o_end, 'recon_status', v_rec->>'status');
end $$;

drop function if exists public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean);
create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record;
  v_lastc timestamptz; v_fee numeric; v_total numeric := 0; v_total_usd numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb;
  v_gap int := coalesce(_setting('min_days_between_closes'), '0')::int; v_res jsonb; v_flag text; v_per record; v_rec jsonb;
  v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_att bigint; v_tol numeric; v_u numeric; v_h numeric; v_e numeric; v_late int; v_fm jsonb;
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
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', v_nav, u, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;

  -- never finalize fees on an unexplained difference
  v_rec := _settlement_recon(v_eq_id, p_equity, null, v_at);
  if v_mode <> 'off' then
    if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then
      raise exception 'settlement refused, nothing was saved: %', v_rec->'reasons'->>0;
    end if;
    if v_rec->>'status' = 'unverified' then
      v_tol := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, p_equity * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
      select id into v_att from settlement_attestations where period_end = v_per.o_end and abs(mexc_total - p_equity) <= v_tol order by id desc limit 1;
      if v_att is null and v_mode = 'require' then
        raise exception 'RECONCILE: this period is not reconciled with the exchange (%). Explain it with admin_attest_settlement for this exchange total, then settle.',
          (select string_agg(x, '; ') from jsonb_array_elements_text(v_rec->'reasons') x);
      end if;
    end if;
  end if;

  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_u := _units_of(r.id); v_h := _hwm_value(r.id);
    v_e := v_u * v_price;
    v_fee := _hwm_close(r.id, v_price, r.fee_rate, v_eq_id);          -- the live engine: fee above the mark; the mark moves up
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)');
      v_total := v_total + v_fee; v_total_usd := v_total_usd + round(v_fee * v_price, 6); v_n := v_n + 1;
    end if;
    insert into settlement_lines(equity_id, profile_id, units_before, unit_price, value_before, hwm_before, eligible_profit, fee_rate, fee_units, fee_usdt, hwm_after)
    values (v_eq_id, r.id, v_u, v_price, v_e, v_h, v_e - v_h, r.fee_rate, v_fee, round(v_fee * v_price, 6), _hwm_value(r.id));
  end loop;
  v_fm := _fund_m_state(v_eq_id + 1);
  insert into settlements(equity_id, period_start, period_end, valued_at, mexc_total, nav, total_units, unit_price, opening_nav, deposits_usdt,
      withdrawals_usdt, trading_pnl_usdt, entries_after_period_end, fee_basis, investors_charged, fee_units, fee_usdt, fund_m, recon, recon_status, attestation_id, created_by)
  values (v_eq_id, v_per.o_start, v_per.o_end, v_at, p_equity, v_nav, u, v_price, (v_rec->>'opening_nav')::numeric, (v_rec->>'deposits_usdt')::numeric,
      (v_rec->>'withdrawals_usdt')::numeric, (v_rec->>'trading_pnl_usdt')::numeric, v_late, coalesce(_setting('fee_basis'), 'external_investors'), v_n, v_total, v_total_usd,
      v_fm, v_rec, v_rec->>'status', v_att, v_actor);
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);       -- waiting money joins after the fees, at the settlement price
  perform _check_books();
  return _idem_put(p_idem, 'admin_close_quarter', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'fee_usdt', v_total_usd,
    'converted', v_conv->'converted', 'settlement_id', currval('settlements_id_seq'), 'period_start', v_per.o_start, 'period_end', v_per.o_end,
    'recon_status', v_rec->>'status', 'attestation_id', v_att), v_actor);
end $$;

-- read-only: everything the settlement would do at this exchange total, and whether it is allowed now
create or replace function public.admin_settlement_preview(p_token text, p_equity numeric, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_at timestamptz := coalesce(p_at, now()); v_per record; v_price numeric; v_nav numeric; v_rec jsonb; v_lines jsonb := '[]'::jsonb; r record; v_u numeric; v_h numeric;
  v_e numeric; v_fee numeric; v_tot numeric := 0; v_totu numeric := 0; v_block jsonb := '[]'::jsonb; v_lastc timestamptz; v_tol numeric;
  v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_last pool_equity%rowtype;
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
  if v_mode <> 'off' then
    if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then v_block := v_block || (v_rec->'reasons');
    elsif v_rec->>'status' = 'unverified' and v_mode = 'require' then
      v_tol := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, p_equity * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
      if not exists (select 1 from settlement_attestations where period_end = v_per.o_end and abs(mexc_total - p_equity) <= v_tol) then
        v_block := v_block || to_jsonb('needs a written explanation (admin_attest_settlement): '::text || (select string_agg(x, '; ') from jsonb_array_elements_text(v_rec->'reasons') x));
      end if;
    end if;
  end if;
  for r in select p.id, p.name, p.username, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_u := _units_of(r.id); v_h := _hwm_value(r.id);
    v_e := v_u * v_price;
    v_fee := _fee_units(r.fee_rate, v_e - v_h, 1, 1, v_price);
    v_tot := v_tot + round(v_fee * v_price, 6); v_totu := v_totu + v_fee;
    v_lines := v_lines || jsonb_build_object('profile_id', r.id, 'name', r.name, 'username', r.username, 'units', v_u, 'value_usdt', v_e,
      'hwm_usdt', v_h, 'eligible_profit_usdt', v_e - v_h, 'fee_rate', r.fee_rate, 'fee_units', v_fee, 'fee_usdt', round(v_fee * v_price, 6),
      'value_after_usdt', v_e - v_fee * v_price, 'hwm_after_usdt', case when v_e > v_h then v_e - v_fee * v_price else v_h end);
  end loop;
  return jsonb_build_object('can_settle', jsonb_array_length(v_block) = 0, 'blocked_reasons', v_block,
    'period_start', v_per.o_start, 'period_end', v_per.o_end, 'next_period_end', v_per.o_next, 'valued_at', v_at,
    'mexc_total', p_equity, 'nav', v_nav, 'unit_price', v_price, 'total_units', _total_units(),
    'fee_basis', coalesce(_setting('fee_basis'), 'external_investors'), 'fee_usdt', v_tot, 'fee_units', v_totu, 'lines', v_lines,
    'recon', v_rec, 'fund_m', _fund_m_state(null),
    'waiting_deposits_admitted_after', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profile_id', profile_id, 'usdt', usdt))
       from pending_deposits where status = 'pending' and (arrived_at is not null or coalesce(_setting('settlement_gate'), 'off') <> 'on')), '[]'::jsonb));
end $$;

create or replace function public.admin_settlements(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object('lines',
            coalesce((select jsonb_agg(to_jsonb(l) order by l.profile_id) from settlement_lines l where l.equity_id = s.equity_id), '[]'::jsonb)) order by s.id)
           from settlements s), '[]'::jsonb);
end $$;

create or replace function public.my_settlements(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('period_start', s.period_start, 'period_end', s.period_end, 'valued_at', s.valued_at,
            'unit_price', l.unit_price, 'units_before', l.units_before, 'value_before_usdt', l.value_before, 'hwm_before_usdt', l.hwm_before,
            'eligible_profit_usdt', l.eligible_profit, 'fee_rate', l.fee_rate, 'fee_units', l.fee_units, 'fee_usdt', l.fee_usdt, 'hwm_after_usdt', l.hwm_after) order by s.id)
           from settlement_lines l join settlements s on s.equity_id = l.equity_id where l.profile_id = v), '[]'::jsonb);
end $$;

create or replace function public.fund_manager_accounts(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return _fund_m_state(null);
end $$;

-- ---------------------------------------------------------------- 6. what the app shows
-- Fund M capital vs fee entitlement now come from the replay (they always add up to Fund M's units and neither goes negative)
create or replace function public.pool_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_price numeric := _price_now(); v_tu numeric := _total_units(); v_fm jsonb;
begin
  perform _admin(p_token);
  v_fm := _fund_m_state(null);
  return jsonb_build_object(
    'unit_price', v_price, 'total_units', v_tu, 'equity_usdt', v_price * v_tu,
    'asof', (select ts from pool_equity order by id desc limit 1),
    'php_rate', _last_php_rate(), 'since_start_pct', v_price - 1,
    'admin_capital_units', (v_fm->'capital'->>'units')::numeric,
    'admin_fee_units', (v_fm->'fee_entitlement'->>'units')::numeric,
    'investor_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                 where p.role = 'investor'), 0),
    'investor_count', (select count(*) from (select l.profile_id from ledger l join profiles p on p.id = l.profile_id
                                               where p.role = 'investor' group by l.profile_id having sum(l.units) > 0) x),
    'pending_requests', (select count(*) from withdrawal_requests where status = 'pending'));
end $$;

-- ---------------------------------------------------------------- 7. integrity report: the earlier checks plus the settlement records
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
  -- new: every settlement's fee rows agree with its lines
  v := coalesce((select jsonb_agg(jsonb_build_object('equity_id', s.equity_id, 'lines_fee_units', lf, 'ledger_fee_units', ll))
                   from settlements s
                   cross join lateral (select coalesce(sum(fee_units), 0) lf from settlement_lines where equity_id = s.equity_id) a
                   cross join lateral (select coalesce(sum(units), 0) ll from ledger where equity_id = s.equity_id and kind = 'fee_in') b
                  where abs(lf - ll) > 0.00000001), '[]');
  rep := rep || jsonb_build_object('id', 'settlement_lines_vs_ledger_fees', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('equity_id', s.equity_id, 'recon_status', s.recon_status)) from settlements s
                  where s.recon_status in ('internal_mismatch', 'unmatched_transfers') or (s.recon_status = 'unverified' and s.attestation_id is null)), '[]');
  rep := rep || jsonb_build_object('id', 'settlement_without_reconciliation', 'severity', 'high', 'count', jsonb_array_length(v), 'rows', v);
  v := coalesce((select jsonb_agg(jsonb_build_object('fund_m_units', (f->>'total_units')::numeric, 'ledger_units', public._units_of((f->>'profile_id')::uuid)))
                   from (select public._fund_m_state(null) f) x
                  where abs((f->>'total_units')::numeric - public._units_of((f->>'profile_id')::uuid)) > 0.00000001), '[]');
  rep := rep || jsonb_build_object('id', 'fund_m_split_does_not_add_up', 'severity', 'critical', 'count', jsonb_array_length(v), 'rows', v);

  return jsonb_build_object('generated_at', now(), 'fee_engine', _setting('fee_engine'), 'checks', rep,
                            'worst', (select coalesce(max(case c->>'severity' when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else 0 end) filter (where (c->>'count')::int > 0), -1)
                                        from jsonb_array_elements(rep) c));
end $$;

-- ---------------------------------------------------------------- 8. backups include the settlement records
create or replace function public._export_all() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'format', 'lucid-io-ledger-backup-1',
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
    'investor_hwm', (select coalesce(jsonb_agg(to_jsonb(h) order by h.profile_id), '[]'::jsonb) from investor_hwm h),
    'hwm_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from hwm_log g),
    'settlements', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from settlements s),
    'settlement_lines', (select coalesce(jsonb_agg(to_jsonb(l) order by l.equity_id, l.profile_id), '[]'::jsonb) from settlement_lines l),
    'settlement_attestations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from settlement_attestations a),
    'terms_acceptances', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from terms_acceptances t),
    'settings', (select coalesce(jsonb_agg(to_jsonb(s) order by s.key), '[]'::jsonb) from ledger_settings s where s.key not in ('bot_key_hash')),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from audit_log a),
    'checks', jsonb_build_object(
      'people', (select count(*) from profiles), 'ledger_rows', (select count(*) from ledger), 'equity_rows', (select count(*) from pool_equity),
      'total_units_ledger', (select coalesce(sum(units), 0) from ledger),
      'total_units_last_reading', (select total_units from pool_equity order by id desc limit 1),
      'lots_units', (select coalesce(sum(units), 0) from ledger),
      'fee_engine', (select value from ledger_settings where key = 'fee_engine'),
      'last_equity_usdt', (select equity_usdt from pool_equity order by id desc limit 1),
      'waiting_usdt', (select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending'),
      'settlements', (select count(*) from settlements)))
$$;

-- ---------------------------------------------------------------- 9. access
revoke all on function public._fund_m_state(bigint), public._settlement_boundary(timestamptz, int),
  public._settlement_period(timestamptz), public._settlement_recon(bigint, numeric, numeric, timestamptz)
  from public, anon, authenticated;
revoke all on function public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_settlement_preview(text, numeric, timestamptz), public.admin_attest_settlement(text, numeric, text, timestamptz),
  public.admin_settlements(text), public.my_settlements(text), public.fund_manager_accounts(text) from public;
grant execute on function
  public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_settlement_preview(text, numeric, timestamptz), public.admin_attest_settlement(text, numeric, text, timestamptz),
  public.admin_settlements(text), public.my_settlements(text), public.fund_manager_accounts(text), public.pool_summary(text),
  public.admin_integrity_report(text)
to anon, authenticated;

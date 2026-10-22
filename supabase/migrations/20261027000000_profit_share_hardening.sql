-- Profit-share hardening: closes the ways the profit share could be gamed (by an investor or by the manager).
--
-- 1. Per-deposit high-water marks ("lots"). Before, each person had ONE line (a unit-weighted blend of every deposit's
--    price). Blending let a top-up move the line: topping up at a high, then a dip, could wipe out the profit share
--    already earned on the old money; and an old loss could shield new money's gains. Now every deposit is its own lot
--    with its own line. The share is worked out lot by lot, withdrawals take the oldest lots first (same order as the
--    lock-up), and nothing one deposit does can change another deposit's line.
-- 2. A higher profit-share rate only starts after the next quarter close (it cannot be applied to gains already made).
--    A lower rate applies at once.
-- 3. Quarter closes must be at least `min_days_between_closes` (80) days apart, so closing early and often cannot
--    crystallise extra profit share on temporary highs.
-- 4. Withdrawal requests cannot add up to more than the unlocked units, and a request can be paid only once.
-- 5. The instant deposit (admin_deposit, which skips the waiting step) is no longer callable from the website; the app
--    only uses "money received" + the next reading. Scripts run as the database owner can still use it.
-- Run after 20261026000000_pending_deposits.sql. Safe on live data: existing holdings become one lot per person at the
-- line they have now, so nobody's numbers change on the day it is run.

insert into public.ledger_settings(key, value) values ('min_days_between_closes', '80') on conflict (key) do nothing;
alter table public.profiles add column if not exists fee_rate_next numeric check (fee_rate_next >= 0 and fee_rate_next <= 1);

create table if not exists public.holder_lots (
  id         bigserial primary key,
  profile_id uuid not null references public.profiles(id),
  units      numeric not null check (units >= -0.000000001),
  hwm        numeric not null check (hwm > 0)
);
create index if not exists holder_lots_profile_idx on public.holder_lots(profile_id, id);
-- what each pool event did to the lots, so "undo last entry" can put them back exactly
create table if not exists public.lot_log (
  id           bigserial primary key,
  equity_id    bigint not null references public.pool_equity(id),
  lot_id       bigint not null,
  units_before numeric,            -- null: the lot was created by this event
  hwm_before   numeric
);
alter table public.holder_lots enable row level security;
alter table public.lot_log enable row level security;
revoke all on public.holder_lots, public.lot_log from public, anon, authenticated;
revoke all on sequence public.holder_lots_id_seq, public.lot_log_id_seq from public, anon, authenticated;

-- existing holdings: one lot per person at their current line
insert into public.holder_lots(profile_id, units, hwm)
select p.id, u.units, coalesce(hs.hwm, (select unit_price from public.pool_equity order by id desc limit 1), 1)
  from public.profiles p
  join (select profile_id, sum(units) as units from public.ledger group by profile_id) u on u.profile_id = p.id
  left join public.holder_state hs on hs.profile_id = p.id
 where u.units > 0 and not exists (select 1 from public.holder_lots);

-- ---------------------------------------------------------------- lot helpers (not callable from the website)
create or replace function public._lot_touch(p_eq bigint, p_lot bigint) returns void language sql security definer set search_path = public as $$
  insert into lot_log(equity_id, lot_id, units_before, hwm_before) select p_eq, id, units, hwm from holder_lots where id = p_lot
$$;

create or replace function public._lot_add(p uuid, p_units numeric, p_price numeric, p_eq bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  insert into holder_lots(profile_id, units, hwm) values (p, p_units, p_price) returning id into v;
  insert into lot_log(equity_id, lot_id, units_before, hwm_before) values (p_eq, v, null, null);
end $$;

-- take p_units from the oldest lots first; returns the profit share (in units) on what was taken. p_eq null = preview only.
create or replace function public._lots_take(p uuid, p_units numeric, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare r record; v_left numeric := p_units; v_take numeric; v_fee numeric := 0;
begin
  for r in select * from holder_lots where profile_id = p and units > 0 order by id loop
    exit when v_left <= 0;
    v_take := least(v_left, r.units);
    v_fee := v_fee + round(p_rate * greatest(0, p_price - r.hwm) / p_price * v_take, 8);
    if p_eq is not null then
      perform _lot_touch(p_eq, r.id);
      update holder_lots set units = units - v_take where id = r.id;
    end if;
    v_left := v_left - v_take;
  end loop;
  if v_left > 0.000001 then raise exception 'internal: holdings are short by % units', v_left; end if;
  return v_fee;
end $$;

-- quarter close for one person: profit share on every lot above its line, then each line moves up to the price
create or replace function public._lots_close(p uuid, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare r record; v_f numeric; v_fee numeric := 0;
begin
  for r in select * from holder_lots where profile_id = p and units > 0 order by id loop
    v_f := round(p_rate * greatest(0, p_price - r.hwm) / p_price * r.units, 8);
    if p_price > r.hwm then
      perform _lot_touch(p_eq, r.id);
      update holder_lots set units = units - v_f, hwm = p_price where id = r.id;
    end if;
    v_fee := v_fee + v_f;
  end loop;
  return v_fee;
end $$;

-- undo what one pool event did to the lots
create or replace function public._lots_revert(p_eq bigint) returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select * from lot_log where equity_id = p_eq order by id desc loop
    if r.units_before is null then delete from holder_lots where id = r.lot_id;
    else update holder_lots set units = r.units_before, hwm = r.hwm_before where id = r.lot_id; end if;
  end loop;
  delete from lot_log where equity_id = p_eq;
end $$;

-- ---------------------------------------------------------------- read side
create or replace function public._holder_summary(p uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pr profiles%rowtype;
  v_price numeric := _price_now();
  v_tu numeric := _total_units();
  v_units numeric; v_dep numeric; v_wd numeric; v_feein numeric; v_hwm numeric; v_gain numeric; v_lots jsonb;
  v_val numeric; v_profit numeric; v_acc numeric; v_unl numeric; v_next date; v_last date;
begin
  select * into pr from profiles where id = p;
  if not found then return null; end if;
  v_units := _units_of(p);
  select coalesce(sum(usdt) filter (where kind = 'deposit'), 0),
         coalesce(-sum(usdt) filter (where kind = 'withdrawal'), 0),
         coalesce(sum(units) filter (where kind = 'fee_in'), 0)
    into v_dep, v_wd, v_feein from ledger where profile_id = p;
  select case when sum(units) > 0 then sum(units * hwm) / sum(units) end, coalesce(sum(greatest(0, v_price - hwm) * units), 0),
         coalesce(jsonb_agg(jsonb_build_array(units, hwm) order by id), '[]'::jsonb)
    into v_hwm, v_gain, v_lots from holder_lots where profile_id = p and units > 0;
  v_hwm := coalesce(v_hwm, v_price);
  v_val := v_units * v_price;
  v_profit := v_val + v_wd - v_dep;
  v_acc := case when pr.role = 'investor' then pr.fee_rate * v_gain else 0 end;   -- USDT, lot by lot
  v_unl := case when pr.role = 'admin' then v_units else _unlocked_units(p) end;
  select min(lock_until) filter (where lock_until > current_date), max(lock_until)
    into v_next, v_last from ledger where profile_id = p and kind = 'deposit';
  return jsonb_build_object(
    'id', pr.id, 'username', pr.username, 'name', pr.name, 'role', pr.role, 'active', pr.active,
    'fee_rate', pr.fee_rate, 'fee_rate_next', pr.fee_rate_next,
    'units', v_units, 'unit_price', v_price, 'value_usdt', v_val,
    'deposited_usdt', v_dep, 'withdrawn_usdt', v_wd, 'net_in_usdt', v_dep - v_wd,
    'profit_usdt', v_profit, 'return_pct', case when v_dep > 0 then v_profit / v_dep end,
    'hwm', v_hwm, 'lots', v_lots, 'accrued_fee_usdt', v_acc, 'value_after_fee_usdt', v_val - v_acc,
    'share_pct', case when v_tu > 0 then v_units / v_tu end,
    'fee_units_earned', v_feein, 'fee_units_value_usdt', v_feein * v_price,
    'unlocked_units', v_unl, 'next_unlock', v_next, 'lock_until', v_last,
    'php_rate', _last_php_rate());
end $$;

-- ---------------------------------------------------------------- profile: a higher rate waits for the next close
create or replace function public.admin_set_profile(p_token text, p_profile uuid, p_name text, p_active boolean, p_fee_rate numeric)
returns void language plpgsql security definer set search_path = public as $$
declare pr profiles%rowtype;
begin
  perform _admin(p_token);
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if p_active is false and pr.role = 'admin' then raise exception 'the manager account cannot be deactivated'; end if;
  update profiles set name = coalesce(p_name, name), active = coalesce(p_active, active) where id = p_profile;
  if pr.role = 'investor' and p_fee_rate is not null then
    if p_fee_rate < 0 or p_fee_rate > 1 then raise exception 'profit share must be between 0 and 100%%'; end if;
    if p_fee_rate > pr.fee_rate and (_units_of(p_profile) > 0 or exists (select 1 from pending_deposits where profile_id = p_profile and status = 'pending')) then
      update profiles set fee_rate_next = p_fee_rate where id = p_profile;          -- starts after the next quarter close
    else
      update profiles set fee_rate = p_fee_rate, fee_rate_next = null where id = p_profile;
    end if;
  end if;
  if p_active is false then delete from sessions where profile_id = p_profile; end if;
end $$;

-- ---------------------------------------------------------------- withdrawals
create or replace function public.request_withdrawal(p_token text, p_units numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid := _me_rw(p_token); pr profiles%rowtype; v_by date; v_open numeric;
begin
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

create or replace function public.admin_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  u numeric := _total_units(); pr profiles%rowtype; hu numeric; v_price numeric; v_net_eq numeric; v_rate_fee numeric;
  v_fee numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric;
begin
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if p_request_id is not null and not exists (select 1 from withdrawal_requests where id = p_request_id and profile_id = p_profile and status = 'pending') then
    raise exception 'that withdrawal request is not waiting any more (already paid or cancelled)';
  end if;
  hu := _units_of(p_profile);
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_units > hu + 0.00000001 then raise exception 'person only holds % units', hu; end if;
  p_units := least(p_units, hu);
  if pr.role = 'investor' and not p_force and p_units > _unlocked_units(p_profile) + 0.00000001 then
    raise exception 'locked: only % units are past lock-up (use force to override)', _unlocked_units(p_profile);
  end if;
  v_net_eq := _net_equity(p_equity_before);
  v_price := v_net_eq / u;
  v_rate_fee := case when pr.role = 'investor' then pr.fee_rate else 0 end;
  v_fee := _lots_take(p_profile, p_units, v_price, v_rate_fee, null);   -- preview: oldest lots first, each against its own line
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if v_net_eq - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq - v_pay, u - v_net, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  perform _lots_take(p_profile, p_units, v_price, v_rate_fee, v_eq_id);
  if v_fee > 0 then
    select id into v_admin from profiles where role = 'admin' limit 1;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_at, v_admin,   'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
    perform _lot_add(v_admin, v_fee, v_price, v_eq_id);
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, p_note) returning id into v_led;
  if p_request_id is not null then
    update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id;
  end if;
  return jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'net_units', v_net, 'pay_usdt', v_pay);
end $$;

-- ---------------------------------------------------------------- quarter close
create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  u numeric := _total_units(); v_price numeric; v_eq_id bigint; v_admin uuid; r record; v_lastc timestamptz;
  v_fee numeric; v_total numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb; v_gap int := coalesce(_setting('min_days_between_closes'), '80')::int;
begin
  if u = 0 then raise exception 'no units yet'; end if;
  select max(ts) into v_lastc from pool_equity where kind = 'close';
  if v_lastc is not null and v_at < v_lastc + make_interval(days => v_gap) then
    raise exception 'the last quarter close was on %; the next quarter close is allowed from %', v_lastc::date, (v_lastc + make_interval(days => v_gap))::date;
  end if;
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', _net_equity(p_equity), u, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at loop
    v_fee := _lots_close(r.id, v_price, r.fee_rate, v_eq_id);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee');
      perform _lot_add(v_admin, v_fee, v_price, v_eq_id);
      v_total := v_total + v_fee; v_n := v_n + 1;
    end if;
  end loop;
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;   -- raised rates start now
  v_conv := _convert_all_pending(v_price, v_at, v_actor);   -- waiting money starts fresh at the close price
  return jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'converted', v_conv->'converted');
end $$;

-- ---------------------------------------------------------------- deposits create a lot
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
  v_lock := case when pr.role = 'admin' then null
                 else (p_at::date + make_interval(months => (_setting('lock_months'))::int))::date end;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (p_at, 'deposit', u * p_price + pd.usdt, u + v_units, p_price, v_rate,
          coalesce(pd.note, 'deposit received ' || to_char(pd.received_at, 'YYYY-MM-DD')), p_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (p_at, pd.profile_id, 'deposit', v_units, pd.usdt, p_price, v_rate, pd.php_amount, v_lock, v_eq_id, pd.note) returning id into v_led;
  perform _lot_add(pd.profile_id, v_units, p_price, v_eq_id);
  update pending_deposits set status = 'converted', ledger_id = v_led where id = p_id;
  return v_units;
end $$;

create or replace function public.admin_deposit(p_token text, p_profile uuid, p_usdt numeric, p_equity_before numeric default null,
    p_php_rate numeric default null, p_php_amount numeric default null, p_note text default null, p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  u numeric := _total_units(); pr profiles%rowtype; v_price numeric; v_units numeric;
  v_eq_id bigint; v_rate numeric; v_lock date; v_eq_after numeric;
begin
  if p_usdt is null or p_usdt <= 0 then raise exception 'deposit must be > 0 USDT'; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  v_price := case when u = 0 then 1 else _price_from(p_equity_before) end;
  v_units := round(p_usdt / v_price, 8);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  v_lock := case when pr.role = 'admin' then null
                 else (v_at::date + make_interval(months => (_setting('lock_months'))::int))::date end;
  v_eq_after := case when u = 0 then 0 else _net_equity(p_equity_before) end + p_usdt;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'deposit', v_eq_after, u + v_units, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, p_usdt, v_price, v_rate, p_php_amount, v_lock, v_eq_id, p_note);
  perform _lot_add(p_profile, v_units, v_price, v_eq_id);
  return jsonb_build_object('units', v_units, 'unit_price', v_price, 'lock_until', v_lock);
end $$;

-- ---------------------------------------------------------------- undo: put the lots back exactly as they were
create or replace function public.admin_undo_last(p_token text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token);
  v_last  pool_equity%rowtype;
  v_prev  pool_equity%rowtype;
  v_note  text := coalesce(p_note, 'correction');
  v_new_eq bigint;
  r record;
  v_profile uuid; v_back boolean := false;
begin
  select * into v_last from pool_equity order by id desc limit 1;
  if not found then raise exception 'nothing to undo'; end if;
  if v_last.kind = 'close' then raise exception 'a quarter close is final and cannot be undone here'; end if;
  select * into v_prev from pool_equity where id < v_last.id order by id desc limit 1;

  if v_last.kind = 'update' then
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'update', v_prev.equity_usdt, v_prev.total_units, v_prev.unit_price, v_prev.php_rate, v_note, v_actor, v_last.id);
    return jsonb_build_object('kind', 'update');

  elsif v_last.kind = 'deposit' then
    select * into r from ledger where equity_id = v_last.id and kind = 'deposit';
    if not found then raise exception 'could not find the matching entry'; end if;
    v_profile := r.profile_id;
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'withdrawal', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), v_last.unit_price, v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
    values (now(), v_profile, 'deposit', -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    perform _lots_revert(v_last.id);
    update pending_deposits set status = 'pending', ledger_id = null where ledger_id = r.id;
    v_back := found;
    return jsonb_build_object('kind', 'deposit', 'profile_id', v_profile, 'back_to_pending', v_back);

  else   -- withdrawal
    v_profile := (select profile_id from ledger where equity_id = v_last.id and kind = 'withdrawal' limit 1);
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'deposit', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), v_last.unit_price, v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    for r in select * from ledger where equity_id = v_last.id loop
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
      values (now(), r.profile_id, r.kind, -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    end loop;
    perform _lots_revert(v_last.id);
    update withdrawal_requests set status = 'pending', ledger_id = null
     where ledger_id in (select id from ledger where equity_id = v_last.id and kind = 'withdrawal');
    return jsonb_build_object('kind', 'withdrawal', 'profile_id', v_profile);
  end if;
end $$;

-- ---------------------------------------------------------------- access
revoke all on function public._lot_touch(bigint, bigint), public._lot_add(uuid, numeric, numeric, bigint),
  public._lots_take(uuid, numeric, numeric, numeric, bigint), public._lots_close(uuid, numeric, numeric, bigint),
  public._lots_revert(bigint) from public, anon, authenticated;
revoke execute on function public.admin_deposit(text, uuid, numeric, numeric, numeric, numeric, text, timestamptz) from public, anon, authenticated;

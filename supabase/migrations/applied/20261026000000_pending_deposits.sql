-- Forward pricing for new money ("dealing"), so a newcomer never shares in profit made before their money was in the pool.
--
-- Before: a deposit bought units straight away at a price worked out from an equity number typed at that moment. If that
-- number was stale (say last week's reading, after a winning week) the newcomer bought cheap units and took part of the
-- existing holders' profit.
--
-- Now: Record -> Deposit only RECEIVES the money. It waits in pending_deposits and owns no units, so it gets no gains and
-- no losses. At the next equity reading (Update equity, or a quarter close) the manager types the exchange total as usual,
-- the waiting money is taken out of it first, the unit price is set from what the existing holders own, and only then
-- does the waiting money buy units at that price. Its lock-up starts then and its high-water mark is that price, so the
-- profit share is only ever charged on gains made after it joined.
--
-- Every equity the manager types is now "the exchange total, including money that is still waiting"; withdrawals and quarter
-- closes subtract the waiting money too, so cash sitting in the account never inflates the price.
-- admin_deposit (instant buy) is kept for the seed/simulation scripts and old flows; it also subtracts waiting money.
-- Run after 20261025000000_profit_share_10.sql. Safe on live data.

create table if not exists public.pending_deposits (
  id          bigserial primary key,
  profile_id  uuid not null references public.profiles(id),
  usdt        numeric not null check (usdt > 0),
  php_rate    numeric,
  php_amount  numeric,
  note        text,
  received_at timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending', 'converted', 'cancelled')),
  ledger_id   bigint references public.ledger(id),
  created_by  uuid
);
alter table public.pending_deposits enable row level security;
revoke all on public.pending_deposits from public, anon, authenticated;
revoke all on sequence public.pending_deposits_id_seq from public, anon, authenticated;

-- money received but not yet in units
create or replace function public._pending_total() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending'
$$;

-- the pool's value that belongs to unit holders: the exchange total minus money still waiting to buy units
create or replace function public._net_equity(p_equity numeric) returns numeric language plpgsql stable security definer set search_path = public as $$
declare v numeric;
begin
  if p_equity is null or p_equity <= 0 then raise exception 'enter the current pool equity in USDT (must be > 0)'; end if;
  v := p_equity - _pending_total();
  if v <= 0 then raise exception 'equity (%) must be more than the deposits still waiting (%): enter the full Exchange total', p_equity, _pending_total(); end if;
  return v;
end $$;

create or replace function public._price_from(p_equity numeric) returns numeric language plpgsql stable security definer set search_path = public as $$
declare u numeric := _total_units();
begin
  if u = 0 then return 1; end if;
  return _net_equity(p_equity) / u;
end $$;

-- buy units for one waiting deposit at p_price (same bookkeeping as admin_deposit)
create or replace function public._convert_pending(p_id bigint, p_price numeric, p_at timestamptz, p_actor uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  pd pending_deposits%rowtype; pr profiles%rowtype; u numeric := _total_units();
  v_units numeric; v_rate numeric; v_lock date; v_eq_id bigint; v_old numeric; v_hwm numeric; v_led bigint;
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
  v_old := _units_of(pd.profile_id);
  select hwm into v_hwm from holder_state where profile_id = pd.profile_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (p_at, pd.profile_id, 'deposit', v_units, pd.usdt, p_price, v_rate, pd.php_amount, v_lock, v_eq_id, pd.note) returning id into v_led;
  insert into holder_state(profile_id, hwm) values (pd.profile_id, p_price)
  on conflict (profile_id) do update set hwm =
    case when v_old <= 0 then p_price else (v_old * coalesce(v_hwm, p_price) + v_units * p_price) / (v_old + v_units) end;
  update pending_deposits set status = 'converted', ledger_id = v_led where id = p_id;
  return v_units;
end $$;

-- convert every waiting deposit at p_price; refuses if a deposit arrived after the reading's date
create or replace function public._convert_all_pending(p_price numeric, p_at timestamptz, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_n int := 0; v_units numeric := 0;
begin
  if exists (select 1 from pending_deposits where status = 'pending' and received_at > p_at + interval '5 minutes') then
    raise exception 'a waiting deposit arrived after this reading''s date: record the reading at or after it';
  end if;
  for r in select id from pending_deposits where status = 'pending' order by received_at, id loop
    v_units := v_units + _convert_pending(r.id, p_price, p_at, p_actor); v_n := v_n + 1;
  end loop;
  return jsonb_build_object('converted', v_n, 'units', v_units);
end $$;

-- ---------------------------------------------------------------- manager: receive / cancel
create or replace function public.admin_receive_deposit(p_token text, p_profile uuid, p_usdt numeric, p_php_rate numeric default null,
    p_php_amount numeric default null, p_note text default null, p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); pr profiles%rowtype; v_at timestamptz := coalesce(p_at, now()); v_id bigint;
begin
  if p_usdt is null or p_usdt <= 0 then raise exception 'deposit must be > 0 USDT'; end if;
  if v_at > now() + interval '5 minutes' then raise exception 'the date cannot be in the future'; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  insert into pending_deposits(profile_id, usdt, php_rate, php_amount, note, received_at, created_by)
  values (p_profile, p_usdt, coalesce(p_php_rate, _last_php_rate()), p_php_amount, p_note, v_at, v_actor) returning id into v_id;
  return jsonb_build_object('id', v_id, 'pending_usdt', _pending_total());
end $$;

-- money handed back before it bought units (nothing in the books changes)
create or replace function public.admin_cancel_pending(p_token text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  update pending_deposits set status = 'cancelled' where id = p_id and status = 'pending';
  if not found then raise exception 'that deposit is not waiting any more'; end if;
end $$;

create or replace function public.admin_pending(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object('name', p.name) order by d.received_at, d.id)
                     from pending_deposits d join profiles p on p.id = d.profile_id where d.status = 'pending'), '[]'::jsonb);
end $$;

create or replace function public.my_pending(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'usdt', usdt, 'php_amount', php_amount, 'received_at', received_at) order by received_at, id)
                     from pending_deposits where profile_id = v and status = 'pending'), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- the valuation points (all take the exchange total incl. waiting money)
create or replace function public.admin_post_equity(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u numeric := _total_units(); v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  v_pend numeric := _pending_total(); v_price numeric; v_conv jsonb; v_rate numeric := coalesce(p_php_rate, _last_php_rate());
begin
  if u = 0 and v_pend = 0 then raise exception 'no units yet: record the first deposit first'; end if;
  if u > 0 then
    v_price := _price_from(p_equity);
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
    values (v_at, 'update', _net_equity(p_equity), u, v_price, v_rate, p_note, v_actor);
  else
    if p_equity is null or p_equity <= 0 then raise exception 'enter the current pool equity in USDT (must be > 0)'; end if;
    v_price := 1;   -- very first money in: everyone starts at 1.00
  end if;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);
  if u = 0 and abs(p_equity - v_pend) > 0.000001 then   -- first reading differs from the cash put in (fees, a first trade): reprice
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
    values (v_at, 'update', p_equity, _total_units(), p_equity / _total_units(), v_rate, p_note, v_actor);
  end if;
  return jsonb_build_object('unit_price', _price_now(), 'total_units', _total_units(), 'equity_usdt', p_equity,
                            'converted', v_conv->'converted', 'converted_units', v_conv->'units');
end $$;

create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  u numeric := _total_units(); v_price numeric; v_eq_id bigint; v_admin uuid; r record;
  v_fee numeric; v_total numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb;
begin
  if u = 0 then raise exception 'no units yet'; end if;
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', _net_equity(p_equity), u, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  for r in select p.id, p.fee_rate, hs.hwm, _units_of(p.id) as hu
             from profiles p join holder_state hs on hs.profile_id = p.id
            where p.role = 'investor' and _units_of(p.id) > 0 loop
    v_fee := round(r.fee_rate * greatest(0, v_price - r.hwm) / v_price * r.hu, 8);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee');
      v_total := v_total + v_fee; v_n := v_n + 1;
    end if;
    if v_price > r.hwm then update holder_state set hwm = v_price where profile_id = r.id; end if;
  end loop;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);   -- AFTER the fees: waiting money starts fresh at the close price
  return jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'converted', v_conv->'converted');
end $$;

-- p_equity_before = the exchange total just before the payout (waiting deposits included; they are subtracted here)
create or replace function public.admin_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  u numeric := _total_units(); pr profiles%rowtype; hu numeric; v_price numeric; v_hwm numeric; v_net_eq numeric;
  v_fee numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric;
begin
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  hu := _units_of(p_profile);
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_units > hu + 0.00000001 then raise exception 'person only holds % units', hu; end if;
  p_units := least(p_units, hu);
  if pr.role = 'investor' and not p_force and p_units > _unlocked_units(p_profile) + 0.00000001 then
    raise exception 'locked: only % units are past lock-up (use force to override)', _unlocked_units(p_profile);
  end if;
  v_net_eq := _net_equity(p_equity_before);
  v_price := v_net_eq / u;
  select hwm into v_hwm from holder_state where profile_id = p_profile;
  v_hwm := coalesce(v_hwm, v_price);
  v_fee := case when pr.role = 'investor' then round(pr.fee_rate * greatest(0, v_price - v_hwm) / v_price * p_units, 8) else 0 end;
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if v_net_eq - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq - v_pay, u - v_net, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  if v_fee > 0 then
    select id into v_admin from profiles where role = 'admin' limit 1;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_at, v_admin,   'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, p_note) returning id into v_led;
  if p_request_id is not null then
    update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id and profile_id = p_profile;
  end if;
  return jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'net_units', v_net, 'pay_usdt', v_pay);
end $$;

-- instant deposit (kept for scripts): p_equity_before = Exchange total just before this money landed, waiting deposits included
create or replace function public.admin_deposit(p_token text, p_profile uuid, p_usdt numeric, p_equity_before numeric default null,
    p_php_rate numeric default null, p_php_amount numeric default null, p_note text default null, p_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz := _at(p_at);
  u numeric := _total_units(); pr profiles%rowtype; v_price numeric; v_units numeric; v_old numeric; v_hwm numeric;
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
  v_old := _units_of(p_profile);
  select hwm into v_hwm from holder_state where profile_id = p_profile;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, p_usdt, v_price, v_rate, p_php_amount, v_lock, v_eq_id, p_note);
  insert into holder_state(profile_id, hwm) values (p_profile, v_price)
  on conflict (profile_id) do update set hwm =
    case when v_old <= 0 then v_price else (v_old * coalesce(v_hwm, v_price) + v_units * v_price) / (v_old + v_units) end;
  return jsonb_build_object('units', v_units, 'unit_price', v_price, 'lock_until', v_lock);
end $$;

-- undo: same as before, plus a deposit that came from the waiting list goes back to waiting (not lost, not doubled)
create or replace function public.admin_undo_last(p_token text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token);
  v_last  pool_equity%rowtype;
  v_prev  pool_equity%rowtype;
  v_note  text := coalesce(p_note, 'correction');
  v_new_eq bigint;
  r record;
  v_profile uuid;
  v_old numeric; v_hwm numeric; v_old_hwm numeric; v_back boolean := false;
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
    v_old := _units_of(v_profile) - r.units;
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'withdrawal', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), v_last.unit_price, v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
    values (now(), v_profile, 'deposit', -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    if v_old <= 0 then
      delete from holder_state where profile_id = v_profile;
    else
      select hwm into v_hwm from holder_state where profile_id = v_profile;
      v_old_hwm := (v_hwm * (v_old + r.units) - r.units * r.unit_price) / v_old;
      update holder_state set hwm = v_old_hwm where profile_id = v_profile;
    end if;
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
    update withdrawal_requests set status = 'pending', ledger_id = null
     where ledger_id in (select id from ledger where equity_id = v_last.id and kind = 'withdrawal');
    return jsonb_build_object('kind', 'withdrawal', 'profile_id', v_profile);
  end if;
end $$;

revoke all on function public._pending_total(), public._net_equity(numeric), public._convert_pending(bigint, numeric, timestamptz, uuid),
  public._convert_all_pending(numeric, timestamptz, uuid) from public, anon, authenticated;
grant execute on function
  public.admin_receive_deposit(text, uuid, numeric, numeric, numeric, text, timestamptz),
  public.admin_cancel_pending(text, bigint), public.admin_pending(text), public.my_pending(text)
to anon, authenticated;

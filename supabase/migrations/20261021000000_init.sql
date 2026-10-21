-- LEDGER: unit-based pool tracker (USDT-valued). Paper records only: no money moves here.
-- Pool value is in USDT. Unit price = pool equity (USDT) / total units. Everyone's value = units * unit price.
-- All writes go through admin-only functions; investors can only read their own data + pool aggregates.

create table public.ledger_settings (
  key   text primary key,
  value text not null
);
insert into public.ledger_settings(key, value) values
  ('lock_months', '3'),
  ('default_fee_rate', '0.20'),
  ('withdrawal_business_days', '7');

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  email      text,
  role       text not null default 'investor' check (role in ('admin', 'investor')),
  approved   boolean not null default false,
  fee_rate   numeric not null default 0.20 check (fee_rate >= 0 and fee_rate <= 1),
  created_at timestamptz not null default now()
);

-- One row per equity observation. total_units/unit_price describe the pool right after the event.
create table public.pool_equity (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  kind        text not null check (kind in ('update', 'deposit', 'withdrawal', 'close')),
  equity_usdt numeric not null check (equity_usdt >= 0),
  total_units numeric not null check (total_units >= 0),
  unit_price  numeric not null check (unit_price > 0),
  php_rate    numeric,
  note        text,
  created_by  uuid
);

create table public.ledger (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  profile_id uuid not null references public.profiles(id),
  kind       text not null check (kind in ('deposit', 'withdrawal', 'fee_out', 'fee_in')),
  units      numeric not null,              -- signed
  usdt       numeric not null,              -- signed, value at unit_price
  unit_price numeric not null,
  php_rate   numeric,
  php_amount numeric,                       -- pesos the person handed over / received (reference only)
  lock_until date,                          -- deposits only
  equity_id  bigint references public.pool_equity(id),
  note       text
);
create index ledger_profile_idx on public.ledger(profile_id, id);

-- High-water mark (unit price already charged a fee at) per holder.
create table public.holder_state (
  profile_id uuid primary key references public.profiles(id),
  hwm        numeric not null
);

create table public.withdrawal_requests (
  id           bigserial primary key,
  profile_id   uuid not null references public.profiles(id),
  units        numeric not null check (units > 0),
  note         text,
  requested_at timestamptz not null default now(),
  pay_by       date not null,
  status       text not null default 'pending' check (status in ('pending', 'paid', 'cancelled')),
  ledger_id    bigint
);

-- The books are append-only: no edits or deletes, even by mistake.
create function public._no_change() returns trigger language plpgsql as $$
begin
  raise exception 'ledger is append-only';
end $$;
create trigger ledger_append_only before update or delete on public.ledger
  for each row execute function public._no_change();
create trigger equity_append_only before update or delete on public.pool_equity
  for each row execute function public._no_change();

-- ---------------------------------------------------------------- helpers
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

create function public.is_member() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and (role = 'admin' or approved))
$$;

create function public._require_admin() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
end $$;

create function public._setting(k text) returns text language sql stable security definer set search_path = public as $$
  select value from ledger_settings where key = k
$$;

create function public._total_units() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(units), 0) from ledger
$$;

create function public._units_of(p uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(units), 0) from ledger where profile_id = p
$$;

create function public._price_now() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select unit_price from pool_equity order by id desc limit 1), 1)
$$;

create function public._last_php_rate() returns numeric language sql stable security definer set search_path = public as $$
  select php_rate from pool_equity where php_rate is not null order by id desc limit 1
$$;

-- price implied by an equity reading taken BEFORE a deposit/withdrawal
create function public._price_from(p_equity numeric) returns numeric language plpgsql stable security definer set search_path = public as $$
declare u numeric := _total_units();
begin
  if u = 0 then return 1; end if;
  if p_equity is null or p_equity <= 0 then raise exception 'enter the current pool equity in USDT (must be > 0)'; end if;
  return p_equity / u;
end $$;

create function public.add_business_days(d date, n int) returns date language plpgsql immutable as $$
declare r date := d; c int := 0;
begin
  while c < n loop
    r := r + 1;
    if extract(isodow from r) < 6 then c := c + 1; end if;
  end loop;
  return r;
end $$;

-- units a holder may withdraw today (deposits past their lock-up, minus what already left)
create function public._unlocked_units(p uuid) returns numeric language sql stable security definer set search_path = public as $$
  select greatest(0, least(
    _units_of(p),
    coalesce(sum(units) filter (where kind = 'deposit' and lock_until <= current_date), 0)
      + coalesce(sum(units) filter (where kind in ('withdrawal', 'fee_out')), 0)
  )) from ledger where profile_id = p
$$;

-- ---------------------------------------------------------------- new users
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare v_first boolean;
begin
  select not exists (select 1 from profiles where role = 'admin') into v_first;  -- first sign-up becomes the admin
  insert into profiles(id, name, email, role, approved, fee_rate)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''), new.email,
          case when v_first then 'admin' else 'investor' end, v_first,
          case when v_first then 0 else (_setting('default_fee_rate'))::numeric end);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- read side
create function public._holder_summary(p uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pr profiles%rowtype;
  v_price numeric := _price_now();
  v_tu numeric := _total_units();
  v_units numeric; v_dep numeric; v_wd numeric; v_feein numeric; v_hwm numeric;
  v_val numeric; v_profit numeric; v_acc numeric; v_unl numeric; v_next date; v_last date;
begin
  select * into pr from profiles where id = p;
  if not found then return null; end if;
  v_units := _units_of(p);
  select coalesce(sum(usdt) filter (where kind = 'deposit'), 0),
         coalesce(-sum(usdt) filter (where kind = 'withdrawal'), 0),
         coalesce(sum(units) filter (where kind = 'fee_in'), 0)
    into v_dep, v_wd, v_feein from ledger where profile_id = p;
  select hs.hwm into v_hwm from holder_state hs where hs.profile_id = p;
  v_hwm := coalesce(v_hwm, v_price);
  v_val := v_units * v_price;
  v_profit := v_val + v_wd - v_dep;
  v_acc := case when pr.role = 'investor' then pr.fee_rate * greatest(0, v_price - v_hwm) * v_units else 0 end; -- USDT
  v_unl := case when pr.role = 'admin' then v_units else _unlocked_units(p) end;
  select min(lock_until) filter (where lock_until > current_date), max(lock_until)
    into v_next, v_last from ledger where profile_id = p and kind = 'deposit';
  return jsonb_build_object(
    'id', pr.id, 'name', pr.name, 'email', pr.email, 'role', pr.role, 'approved', pr.approved, 'fee_rate', pr.fee_rate,
    'units', v_units, 'unit_price', v_price, 'value_usdt', v_val,
    'deposited_usdt', v_dep, 'withdrawn_usdt', v_wd, 'net_in_usdt', v_dep - v_wd,
    'profit_usdt', v_profit, 'return_pct', case when v_dep > 0 then v_profit / v_dep end,
    'hwm', v_hwm, 'accrued_fee_usdt', v_acc, 'value_after_fee_usdt', v_val - v_acc,
    'share_pct', case when v_tu > 0 then v_units / v_tu end,
    'fee_units_earned', v_feein, 'fee_units_value_usdt', v_feein * v_price,
    'unlocked_units', v_unl, 'next_unlock', v_next, 'lock_until', v_last,
    'php_rate', _last_php_rate());
end $$;

create function public.my_summary() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member() then return null; end if;
  return _holder_summary(auth.uid());
end $$;

create function public.admin_overview() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return coalesce((select jsonb_agg(_holder_summary(id) order by role, created_at) from profiles), '[]'::jsonb);
end $$;

create function public.pool_summary() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_price numeric := _price_now(); v_tu numeric := _total_units();
begin
  if not is_member() then return null; end if;
  return jsonb_build_object(
    'unit_price', v_price, 'total_units', v_tu, 'equity_usdt', v_price * v_tu,
    'asof', (select ts from pool_equity order by id desc limit 1),
    'php_rate', _last_php_rate(), 'since_start_pct', v_price - 1,
    'admin_capital_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                      where p.role = 'admin' and l.kind in ('deposit', 'withdrawal')), 0),
    'admin_fee_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                  where p.role = 'admin' and l.kind in ('fee_in', 'fee_out')), 0),
    'investor_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                 where p.role = 'investor'), 0),
    'investor_count', (select count(*) from (select profile_id from ledger l join profiles p on p.id = l.profile_id
                                               where p.role = 'investor' group by profile_id having sum(units) > 0) x));
end $$;

create function public.price_history() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_member() then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('ts', ts, 'unit_price', unit_price, 'equity_usdt', equity_usdt,
                                                       'total_units', total_units, 'kind', kind) order by id) from pool_equity), '[]'::jsonb);
end $$;

create function public.admin_equity_log() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return coalesce((select jsonb_agg(to_jsonb(e) order by id desc) from pool_equity e), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- admin writes
create function public.admin_set_profile(p_profile uuid, p_name text, p_approved boolean, p_fee_rate numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update profiles set name = coalesce(p_name, name), approved = coalesce(p_approved, approved),
                      fee_rate = case when role = 'admin' then 0 else coalesce(p_fee_rate, fee_rate) end
   where id = p_profile;
end $$;

-- Record the pool's current MEXC equity (USDT). Moves the unit price; changes no one's units.
create function public.admin_post_equity(p_equity numeric, p_php_rate numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u numeric := _total_units(); v_price numeric;
begin
  perform _require_admin();
  if u = 0 then raise exception 'no units yet: record the first deposit first'; end if;
  v_price := _price_from(p_equity);
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('update', p_equity, u, v_price, coalesce(p_php_rate, _last_php_rate()), p_note, auth.uid());
  return jsonb_build_object('unit_price', v_price, 'total_units', u, 'equity_usdt', p_equity);
end $$;

-- p_equity_before = pool equity in USDT read from MEXC just BEFORE this deposit lands.
create function public.admin_deposit(p_profile uuid, p_usdt numeric, p_equity_before numeric default null,
    p_php_rate numeric default null, p_php_amount numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u numeric := _total_units(); pr profiles%rowtype; v_price numeric; v_units numeric; v_old numeric; v_hwm numeric;
  v_eq_id bigint; v_rate numeric; v_lock date; v_eq_after numeric;
begin
  perform _require_admin();
  if p_usdt is null or p_usdt <= 0 then raise exception 'deposit must be > 0 USDT'; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if not (pr.approved or pr.role = 'admin') then raise exception 'approve this person first'; end if;
  v_price := case when u = 0 then 1 else _price_from(p_equity_before) end;
  v_units := round(p_usdt / v_price, 8);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  v_lock := case when pr.role = 'admin' then null
                 else (current_date + make_interval(months => (_setting('lock_months'))::int))::date end;
  v_eq_after := case when u = 0 then 0 else p_equity_before end + p_usdt;
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('deposit', v_eq_after, u + v_units, v_price, v_rate, p_note, auth.uid()) returning id into v_eq_id;
  v_old := _units_of(p_profile);
  select hwm into v_hwm from holder_state where profile_id = p_profile;
  insert into ledger(profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (p_profile, 'deposit', v_units, p_usdt, v_price, v_rate, p_php_amount, v_lock, v_eq_id, p_note);
  insert into holder_state(profile_id, hwm) values (p_profile, v_price)
  on conflict (profile_id) do update set hwm =
    case when v_old <= 0 then v_price else (v_old * coalesce(v_hwm, v_price) + v_units * v_price) / (v_old + v_units) end;
  return jsonb_build_object('units', v_units, 'unit_price', v_price, 'lock_until', v_lock);
end $$;

-- Redeem p_units (gross). Fee on the gain above the holder's HWM is taken in units first; the rest is paid out.
create function public.admin_withdraw(p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u numeric := _total_units(); pr profiles%rowtype; hu numeric; v_price numeric; v_hwm numeric;
  v_fee numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric;
begin
  perform _require_admin();
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  hu := _units_of(p_profile);
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_units > hu + 0.00000001 then raise exception 'person only holds % units', hu; end if;
  p_units := least(p_units, hu);
  if pr.role = 'investor' and not p_force and p_units > _unlocked_units(p_profile) + 0.00000001 then
    raise exception 'locked: only % units are past lock-up (use force to override)', _unlocked_units(p_profile);
  end if;
  v_price := _price_from(p_equity_before);
  select hwm into v_hwm from holder_state where profile_id = p_profile;
  v_hwm := coalesce(v_hwm, v_price);
  v_fee := case when pr.role = 'investor' then round(pr.fee_rate * greatest(0, v_price - v_hwm) / v_price * p_units, 8) else 0 end;
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if p_equity_before - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('withdrawal', p_equity_before - v_pay, u - v_net, v_price, v_rate, p_note, auth.uid()) returning id into v_eq_id;
  if v_fee > 0 then
    select id into v_admin from profiles where role = 'admin' limit 1;
    insert into ledger(profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (p_profile, 'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_admin,   'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
  end if;
  insert into ledger(profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, p_note) returning id into v_led;
  if p_request_id is not null then
    update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id and profile_id = p_profile;
  end if;
  return jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'net_units', v_net, 'pay_usdt', v_pay);
end $$;

-- Quarter end: crystallize fees (units move from each investor to the admin) and reset HWMs.
create function public.admin_close_quarter(p_equity numeric, p_php_rate numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u numeric := _total_units(); v_price numeric; v_eq_id bigint; v_admin uuid; r record;
  v_fee numeric; v_total numeric := 0; v_n int := 0; v_rate numeric;
begin
  perform _require_admin();
  if u = 0 then raise exception 'no units yet'; end if;
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('close', p_equity, u, v_price, v_rate, p_note, auth.uid()) returning id into v_eq_id;
  for r in select p.id, p.fee_rate, hs.hwm, _units_of(p.id) as hu
             from profiles p join holder_state hs on hs.profile_id = p.id
            where p.role = 'investor' and _units_of(p.id) > 0 loop
    v_fee := round(r.fee_rate * greatest(0, v_price - r.hwm) / v_price * r.hu, 8);
    if v_fee > 0 then
      insert into ledger(profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee'),
             (v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee');
      v_total := v_total + v_fee; v_n := v_n + 1;
    end if;
    if v_price > r.hwm then update holder_state set hwm = v_price where profile_id = r.id; end if;
  end loop;
  return jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total);
end $$;

-- ---------------------------------------------------------------- investor writes
create function public.request_withdrawal(p_units numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr profiles%rowtype; v_by date;
begin
  select * into pr from profiles where id = auth.uid();
  if not found or not (pr.approved or pr.role = 'admin') then raise exception 'not approved'; end if;
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_units > _units_of(auth.uid()) + 0.00000001 then raise exception 'you only hold % units', _units_of(auth.uid()); end if;
  if pr.role = 'investor' and p_units > _unlocked_units(auth.uid()) + 0.00000001 then
    raise exception 'locked: % units are past lock-up. Next unlock: %', _unlocked_units(auth.uid()),
      (select min(lock_until) filter (where lock_until > current_date) from ledger where profile_id = auth.uid() and kind = 'deposit');
  end if;
  v_by := add_business_days(current_date, (_setting('withdrawal_business_days'))::int);
  insert into withdrawal_requests(profile_id, units, note, pay_by) values (auth.uid(), p_units, p_note, v_by);
  return jsonb_build_object('pay_by', v_by);
end $$;

create function public.cancel_withdrawal_request(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  update withdrawal_requests set status = 'cancelled'
   where id = p_id and status = 'pending' and (profile_id = auth.uid() or is_admin());
end $$;

-- ---------------------------------------------------------------- access control
alter table public.ledger_settings        enable row level security;
alter table public.profiles            enable row level security;
alter table public.pool_equity         enable row level security;
alter table public.ledger              enable row level security;
alter table public.holder_state        enable row level security;
alter table public.withdrawal_requests enable row level security;

create policy profiles_read  on public.profiles            for select to authenticated using (id = auth.uid() or is_admin());
create policy ledger_read    on public.ledger              for select to authenticated using (profile_id = auth.uid() or is_admin());
create policy requests_read  on public.withdrawal_requests for select to authenticated using (profile_id = auth.uid() or is_admin());
-- pool_equity, holder_state, ledger_settings: no direct access; only through the functions below.

revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant select on public.profiles, public.ledger, public.withdrawal_requests to authenticated;
grant execute on function
  public.is_admin(), public.is_member(),
  public.my_summary(), public.pool_summary(), public.price_history(),
  public.request_withdrawal(numeric, text), public.cancel_withdrawal_request(bigint),
  public.admin_overview(), public.admin_equity_log(),
  public.admin_set_profile(uuid, text, boolean, numeric),
  public.admin_post_equity(numeric, numeric, text),
  public.admin_deposit(uuid, numeric, numeric, numeric, numeric, text),
  public.admin_withdraw(uuid, numeric, numeric, numeric, text, boolean, bigint),
  public.admin_close_quarter(numeric, numeric, text)
to authenticated;

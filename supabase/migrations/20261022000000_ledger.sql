-- LEDGER: unit-based pool tracker (USDT-valued). Paper records only: no money moves here.
-- Pool value is in USDT. Unit price = pool equity (USDT) / total units. Everyone's value = units * unit price.
--
-- Login is username + password handled here (bcrypt hashes, random session tokens); Supabase Auth is not used.
-- The browser only holds the public "anon" key. Every table is locked: ALL access goes through the functions below,
-- and each one needs a valid session token, so the database (not the web page) decides who can see or do what.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- clean slate (an earlier version used Supabase Auth)
do $$ begin
  if to_regclass('auth.users') is not null then execute 'drop trigger if exists on_auth_user_created on auth.users'; end if;
end $$;
drop table if exists public.withdrawal_requests, public.holder_state, public.ledger, public.pool_equity,
                     public.sessions, public.profiles, public.ledger_settings cascade;
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (array[
              '_no_change','is_admin','is_member','_require_admin','_setting','_total_units','_units_of','_price_now',
              '_last_php_rate','_price_from','add_business_days','_unlocked_units','handle_new_user','_holder_summary',
              'my_summary','admin_overview','pool_summary','price_history','admin_equity_log','admin_set_profile',
              'admin_post_equity','admin_deposit','admin_withdraw','admin_close_quarter','request_withdrawal',
              'cancel_withdrawal_request','login','logout','_me','_admin','_hash','my_ledger','admin_ledger','my_requests',
              'admin_requests','change_my_password','admin_set_password','admin_create_user','create_first_admin'])
  loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
end $$;

-- ---------------------------------------------------------------- tables
create table public.ledger_settings (
  key   text primary key,
  value text not null
);
insert into public.ledger_settings(key, value) values
  ('lock_months', '3'),
  ('default_fee_rate', '0.20'),
  ('withdrawal_business_days', '7'),
  ('bcrypt_cost', '10'),
  ('session_days', '30');

create table public.profiles (
  id              uuid primary key default gen_random_uuid(),
  username        text not null unique check (username ~ '^[a-z0-9_.-]{3,30}$'),
  name            text not null default '',
  role            text not null default 'investor' check (role in ('admin', 'investor')),
  active          boolean not null default true,
  pass_hash       text not null,
  fee_rate        numeric not null default 0.20 check (fee_rate >= 0 and fee_rate <= 1),
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);
create unique index one_admin on public.profiles(role) where role = 'admin';

create table public.sessions (
  token_hash text primary key,                -- sha256 of the token; the token itself is never stored
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
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
create function public._setting(k text) returns text language sql stable security definer set search_path = public as $$
  select value from ledger_settings where key = k
$$;

-- who is calling? (raises if the token is missing, wrong, expired, or the person is deactivated)
create function public._me(p_token text) returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid;
begin
  select s.profile_id into v from sessions s join profiles p on p.id = s.profile_id
   where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires_at > now() and p.active;
  if v is null then raise exception 'not signed in'; end if;
  return v;
end $$;

create function public._admin(p_token text) returns uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token);
begin
  if not exists (select 1 from profiles where id = v and role = 'admin') then raise exception 'admin only'; end if;
  return v;
end $$;

create function public._hash(p_password text) returns text language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if p_password is null or length(p_password) < 8 then raise exception 'password must be at least 8 characters'; end if;
  return crypt(p_password, gen_salt('bf', (_setting('bcrypt_cost'))::int));
end $$;

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

-- ---------------------------------------------------------------- accounts & login
-- Run ONCE from the SQL editor (not callable from the website): select public.create_first_admin('raf', 'Raf', 'a-long-password');
create function public.create_first_admin(p_username text, p_name text, p_password text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  if exists (select 1 from profiles where role = 'admin') then raise exception 'an admin already exists'; end if;
  insert into profiles(username, name, role, pass_hash, fee_rate)
  values (lower(trim(p_username)), coalesce(p_name, ''), 'admin', _hash(p_password), 0) returning id into v;
  return v;
end $$;

-- Returns {ok:true, token,...} or {ok:false, error}. (Failures are returned, not raised, so the attempt counter is saved.)
create function public.login(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare pr profiles%rowtype; v_token text; v_ok boolean; v_bad constant jsonb := jsonb_build_object('ok', false, 'error', 'Wrong username or password');
begin
  select * into pr from profiles where username = lower(trim(coalesce(p_username, '')));
  if not found then
    perform crypt(coalesce(p_password, ''), gen_salt('bf', (_setting('bcrypt_cost'))::int));   -- same work as a real check
    return v_bad;
  end if;
  if pr.locked_until is not null and pr.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong attempts. Try again in 15 minutes.');
  end if;
  v_ok := pr.active and pr.pass_hash = crypt(coalesce(p_password, ''), pr.pass_hash);
  if not v_ok then
    update profiles set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
                        locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where id = pr.id;
    return v_bad;
  end if;
  update profiles set failed_attempts = 0, locked_until = null where id = pr.id;
  delete from sessions where expires_at < now();
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into sessions(token_hash, profile_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), pr.id, now() + make_interval(days => (_setting('session_days'))::int));
  return jsonb_build_object('ok', true, 'token', v_token, 'role', pr.role, 'name', pr.name);
end $$;

create function public.logout(p_token text) returns void language sql security definer set search_path = public, extensions as $$
  delete from sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create function public.change_my_password(p_token text, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token); v_hash text;
begin
  select pass_hash into v_hash from profiles where id = v;
  if v_hash <> crypt(coalesce(p_old, ''), v_hash) then raise exception 'current password is wrong'; end if;
  update profiles set pass_hash = _hash(p_new) where id = v;
  delete from sessions where profile_id = v and token_hash <> encode(digest(p_token, 'sha256'), 'hex');   -- sign out other devices
end $$;

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
    'id', pr.id, 'username', pr.username, 'name', pr.name, 'role', pr.role, 'active', pr.active, 'fee_rate', pr.fee_rate,
    'units', v_units, 'unit_price', v_price, 'value_usdt', v_val,
    'deposited_usdt', v_dep, 'withdrawn_usdt', v_wd, 'net_in_usdt', v_dep - v_wd,
    'profit_usdt', v_profit, 'return_pct', case when v_dep > 0 then v_profit / v_dep end,
    'hwm', v_hwm, 'accrued_fee_usdt', v_acc, 'value_after_fee_usdt', v_val - v_acc,
    'share_pct', case when v_tu > 0 then v_units / v_tu end,
    'fee_units_earned', v_feein, 'fee_units_value_usdt', v_feein * v_price,
    'unlocked_units', v_unl, 'next_unlock', v_next, 'lock_until', v_last,
    'php_rate', _last_php_rate());
end $$;

create function public.my_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  return _holder_summary(_me(p_token));
end $$;

create function public.admin_overview(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(_holder_summary(id) order by role, created_at) from profiles), '[]'::jsonb);
end $$;

create function public.pool_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_price numeric := _price_now(); v_tu numeric := _total_units();
begin
  perform _me(p_token);
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
    'investor_count', (select count(*) from (select l.profile_id from ledger l join profiles p on p.id = l.profile_id
                                               where p.role = 'investor' group by l.profile_id having sum(l.units) > 0) x));
end $$;

create function public.price_history(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _me(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('ts', ts, 'unit_price', unit_price, 'equity_usdt', equity_usdt,
                                                       'total_units', total_units, 'kind', kind) order by id) from pool_equity), '[]'::jsonb);
end $$;

create function public.my_ledger(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ts', ts, 'profile_id', profile_id, 'kind', kind, 'units', units,
           'usdt', usdt, 'unit_price', unit_price, 'lock_until', lock_until, 'note', note) order by id desc)
         from ledger where profile_id = v), '[]'::jsonb);
end $$;

create function public.admin_ledger(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'ts', l.ts, 'profile_id', l.profile_id, 'name', p.name, 'kind', l.kind,
           'units', l.units, 'usdt', l.usdt, 'unit_price', l.unit_price, 'php_amount', l.php_amount, 'lock_until', l.lock_until, 'note', l.note)
           order by l.id desc) from ledger l join profiles p on p.id = l.profile_id), '[]'::jsonb);
end $$;

create function public.my_requests(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(to_jsonb(r) order by id desc) from withdrawal_requests r where profile_id = v), '[]'::jsonb);
end $$;

create function public.admin_requests(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('name', p.name) order by r.id desc)
                     from withdrawal_requests r join profiles p on p.id = r.profile_id), '[]'::jsonb);
end $$;

create function public.admin_equity_log(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(to_jsonb(e) order by id desc) from pool_equity e), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- admin writes
create function public.admin_create_user(p_token text, p_username text, p_name text, p_password text, p_fee_rate numeric default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v uuid;
begin
  perform _admin(p_token);
  insert into profiles(username, name, role, pass_hash, fee_rate)
  values (lower(trim(p_username)), coalesce(p_name, ''), 'investor', _hash(p_password),
          coalesce(p_fee_rate, (_setting('default_fee_rate'))::numeric)) returning id into v;
  return v;
exception
  when unique_violation then raise exception 'that username is already taken';
  when check_violation then raise exception 'username: 3-30 characters, letters/numbers/._- only; fee between 0 and 100%%';
end $$;

create function public.admin_set_profile(p_token text, p_profile uuid, p_name text, p_active boolean, p_fee_rate numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  if p_active is false and exists (select 1 from profiles where id = p_profile and role = 'admin') then
    raise exception 'the manager account cannot be deactivated';
  end if;
  update profiles set name = coalesce(p_name, name), active = coalesce(p_active, active),
                      fee_rate = case when role = 'admin' then 0 else coalesce(p_fee_rate, fee_rate) end
   where id = p_profile;
  if p_active is false then delete from sessions where profile_id = p_profile; end if;
end $$;

-- the manager can set a new password for anyone (including themselves); the person is signed out everywhere
create function public.admin_set_password(p_token text, p_profile uuid, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _admin(p_token);
  update profiles set pass_hash = _hash(p_new), failed_attempts = 0, locked_until = null where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  delete from sessions where profile_id = p_profile and token_hash <> encode(digest(p_token, 'sha256'), 'hex');
end $$;

-- Record the pool's current MEXC equity (USDT). Moves the unit price; changes no one's units.
create function public.admin_post_equity(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u numeric := _total_units(); v_price numeric; v_actor uuid := _admin(p_token);
begin
  if u = 0 then raise exception 'no units yet: record the first deposit first'; end if;
  v_price := _price_from(p_equity);
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('update', p_equity, u, v_price, coalesce(p_php_rate, _last_php_rate()), p_note, v_actor);
  return jsonb_build_object('unit_price', v_price, 'total_units', u, 'equity_usdt', p_equity);
end $$;

-- p_equity_before = pool equity in USDT read from MEXC just BEFORE this deposit lands.
create function public.admin_deposit(p_token text, p_profile uuid, p_usdt numeric, p_equity_before numeric default null,
    p_php_rate numeric default null, p_php_amount numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token);
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
                 else (current_date + make_interval(months => (_setting('lock_months'))::int))::date end;
  v_eq_after := case when u = 0 then 0 else p_equity_before end + p_usdt;
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('deposit', v_eq_after, u + v_units, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
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
create function public.admin_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token);
  u numeric := _total_units(); pr profiles%rowtype; hu numeric; v_price numeric; v_hwm numeric;
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
  v_price := _price_from(p_equity_before);
  select hwm into v_hwm from holder_state where profile_id = p_profile;
  v_hwm := coalesce(v_hwm, v_price);
  v_fee := case when pr.role = 'investor' then round(pr.fee_rate * greatest(0, v_price - v_hwm) / v_price * p_units, 8) else 0 end;
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if p_equity_before - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('withdrawal', p_equity_before - v_pay, u - v_net, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
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
create function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token);
  u numeric := _total_units(); v_price numeric; v_eq_id bigint; v_admin uuid; r record;
  v_fee numeric; v_total numeric := 0; v_n int := 0; v_rate numeric;
begin
  if u = 0 then raise exception 'no units yet'; end if;
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  insert into pool_equity(kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values ('close', p_equity, u, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
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
create function public.request_withdrawal(p_token text, p_units numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid := _me(p_token); pr profiles%rowtype; v_by date;
begin
  select * into pr from profiles where id = v;
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_units > _units_of(v) + 0.00000001 then raise exception 'you only hold % units', _units_of(v); end if;
  if pr.role = 'investor' and p_units > _unlocked_units(v) + 0.00000001 then
    raise exception 'locked: % units are past lock-up. Next unlock: %', _unlocked_units(v),
      (select min(lock_until) filter (where lock_until > current_date) from ledger where profile_id = v and kind = 'deposit');
  end if;
  v_by := add_business_days(current_date, (_setting('withdrawal_business_days'))::int);
  insert into withdrawal_requests(profile_id, units, note, pay_by) values (v, p_units, p_note, v_by);
  return jsonb_build_object('pay_by', v_by);
end $$;

create function public.cancel_withdrawal_request(p_token text, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  update withdrawal_requests set status = 'cancelled'
   where id = p_id and status = 'pending'
     and (profile_id = v or exists (select 1 from profiles where id = v and role = 'admin'));
end $$;

-- ---------------------------------------------------------------- access control
-- No table is readable or writable from the website. Only the functions listed below are, and each checks the session token.
alter table public.ledger_settings     enable row level security;
alter table public.profiles            enable row level security;
alter table public.sessions            enable row level security;
alter table public.pool_equity         enable row level security;
alter table public.ledger              enable row level security;
alter table public.holder_state        enable row level security;
alter table public.withdrawal_requests enable row level security;

revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.login(text, text), public.logout(text), public.change_my_password(text, text, text),
  public.my_summary(text), public.pool_summary(text), public.price_history(text),
  public.my_ledger(text), public.my_requests(text),
  public.request_withdrawal(text, numeric, text), public.cancel_withdrawal_request(text, bigint),
  public.admin_overview(text), public.admin_ledger(text), public.admin_requests(text), public.admin_equity_log(text),
  public.admin_create_user(text, text, text, text, numeric),
  public.admin_set_profile(text, uuid, text, boolean, numeric),
  public.admin_set_password(text, uuid, text),
  public.admin_post_equity(text, numeric, numeric, text),
  public.admin_deposit(text, uuid, numeric, numeric, numeric, numeric, text),
  public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint),
  public.admin_close_quarter(text, numeric, numeric, text)
to anon, authenticated;

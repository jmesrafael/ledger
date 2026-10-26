-- HIGH-WATER MARK FEE, DEPOSITS JOIN ONLY ONCE IN Exchange, LOCK-UP AS GUIDANCE ONLY.
-- Run after 20261104000000_payout_details_no_exit_fee.sql. Read docs/accounting-model.md section 3 first. Safe to run twice.
--
-- 1) THE PERFORMANCE FEE USES A HIGH-WATER MARK PER INVESTOR (fee_engine = 'investor_hwm_v2'; replaces flat_period_v1).
--    E = units x unit price (the investor's value);  H = investor_hwm.hwm_value (USDT, their high-water mark);  G = E - H.
--      deposit D             : H := H + D                       (a deposit is never profit; an old shortfall stays)
--      quarter close, G > 0  : fee = rate x G ;  H := value after the fee                (G <= 0: no fee, H unchanged)
--      withdrawal, share s   : fee = rate x max(0, G) x s ;  H := H - s x min(E, H)
--                              in profit the uncharged gain keeps (1 - s) of itself; in a loss the WHOLE shortfall stays,
--                              so taking money out never shrinks a loss that has to be earned back first.
--      full exit (s = 1)     : H := the shortfall (0 when in profit). Money that comes back later adds to it (H := shortfall + D),
--                              so leaving and rejoining gives the same result as staying in and topping up.
--    So G (uncharged gain, or shortfall when negative) changes ONLY with the unit price and with fees. Deposits and withdrawals never
--    move it, and the fee is never charged twice on the same gain, nor before an earlier loss is made back.
--    Cutover: H starts where the last quarter close left each investor (value now minus profit made since that close).
--
-- 2) A DEPOSIT JOINS ONLY ONCE ITS MONEY IS IN Exchange. Before, every waiting deposit was taken out of the typed Exchange total even when its
--    money had not reached the exchange yet, which lowered the price: the newcomer bought units too cheaply and everyone else lost the
--    difference. Now only deposits marked "in the exchange" (admin_mark_arrived, or p_in_mexc at Money received) are taken out and join.
--    Any other waiting deposit needs an explicit yes on a reading, and stops the bot from posting readings.
--
-- 3) THE LOCK-UP IS GUIDANCE, NOT A RULE IN THE DATABASE. Withdrawals are no longer refused inside a lock-up (setting lock_enforced = '1'
--    turns the old check back on). Only an investor's FIRST deposit gets a lock-up date, which the app shows as wording.

-- ---------------------------------------------------------------- 0. preflight
do $$
declare v_engine text;
begin
  select value into v_engine from public.ledger_settings where key = 'fee_engine';
  if coalesce(v_engine, '') not in ('flat_period_v1', 'investor_hwm_v2') then
    raise exception 'preflight: fee_engine is "%" (expected flat_period_v1). Run 20261101000000_ledger_integrity.sql first. Nothing was changed.', coalesce(v_engine, 'missing');
  end if;
  if exists (select 1 from public.pool_equity) and abs((select coalesce(sum(units), 0) from public.ledger) - (select total_units from public.pool_equity order by id desc limit 1)) > 0.000001 then
    raise exception 'preflight: everyone''s units differ from the last pool entry. Run admin_integrity_report and fix that first. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. settings and tables
insert into public.ledger_settings(key, value) values ('lock_enforced', '0') on conflict (key) do nothing;

create table if not exists public.investor_hwm (
  profile_id uuid primary key references public.profiles(id),
  hwm_value  numeric not null default 0 check (hwm_value >= 0),    -- USDT: value the investor must be above before a fee is due
  updated_at timestamptz not null default now()
);
-- what each pool entry did to a high-water mark, so the newest entry can be undone exactly; rows are kept (reverted_at is set)
create table if not exists public.hwm_log (
  id          bigserial primary key,
  equity_id   bigint not null references public.pool_equity(id),
  profile_id  uuid not null references public.profiles(id),
  existed     boolean not null,
  hwm_before  numeric,
  reverted_at timestamptz
);
create index if not exists hwm_log_equity_idx on public.hwm_log(equity_id);
alter table public.investor_hwm enable row level security;
alter table public.hwm_log enable row level security;
revoke all on public.investor_hwm, public.hwm_log from public, anon, authenticated;
revoke all on sequence public.hwm_log_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. high-water mark
create or replace function public._hwm_log(p_eq bigint, p uuid) returns void language plpgsql security definer set search_path = public as $$
declare v numeric;
begin
  select hwm_value into v from investor_hwm where profile_id = p;
  insert into hwm_log(equity_id, profile_id, existed, hwm_before) values (p_eq, p, found, v);
end $$;

create or replace function public._hwm_value(p uuid) returns numeric language plpgsql stable security definer set search_path = public as $$
declare v numeric;
begin
  select hwm_value into v from investor_hwm where profile_id = p;
  if found then return v; end if;
  if _units_of(p) > 0.00000001 then raise exception 'internal: an investor holds units but has no high-water mark; nothing was saved'; end if;
  return 0;
end $$;

-- a deposit is not profit: the mark rises by the deposit
create or replace function public._hwm_deposit(p uuid, p_usdt numeric, p_eq bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = p and role = 'investor') then return; end if;
  perform _hwm_log(p_eq, p);
  insert into investor_hwm(profile_id, hwm_value) values (p, p_usdt)
  on conflict (profile_id) do update set hwm_value = investor_hwm.hwm_value + p_usdt, updated_at = now();
end $$;

-- taking p_units out: fee on the same share of the gain above the mark. p_eq null = preview (nothing is written).
create or replace function public._hwm_take(p uuid, p_units numeric, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_u numeric := _units_of(p); v_h numeric; v_e numeric; v_share numeric; v_fee numeric;
begin
  if v_u <= 0 or not exists (select 1 from profiles where id = p and role = 'investor') then return 0; end if;
  if p_units > v_u + 0.000001 then raise exception 'internal: holdings are short by % units', p_units - v_u; end if;
  v_h := _hwm_value(p); v_e := v_u * p_price; v_share := least(1, p_units / v_u);
  v_fee := _fee_units(p_rate, v_e - v_h, least(p_units, v_u), v_u, p_price);
  if p_eq is not null then
    perform _hwm_log(p_eq, p);
    update investor_hwm set hwm_value = greatest(0, v_h - v_share * least(v_e, v_h)), updated_at = now() where profile_id = p;
  end if;
  return v_fee;
end $$;

-- quarter close for one investor: fee on the gain above the mark; the mark moves up to the value after the fee
create or replace function public._hwm_close(p uuid, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_u numeric := _units_of(p); v_h numeric; v_e numeric; v_fee numeric := 0;
begin
  if v_u <= 0 then return 0; end if;
  v_h := _hwm_value(p); v_e := v_u * p_price;
  if v_e > v_h then
    v_fee := _fee_units(p_rate, v_e - v_h, 1, 1, p_price);
    perform _hwm_log(p_eq, p);
    update investor_hwm set hwm_value = (v_u - v_fee) * p_price, updated_at = now() where profile_id = p;
  end if;
  return v_fee;
end $$;

create or replace function public._hwm_revert(p_eq bigint) returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select * from hwm_log where equity_id = p_eq and reverted_at is null order by id desc loop
    if r.existed then update investor_hwm set hwm_value = r.hwm_before, updated_at = now() where profile_id = r.profile_id;
    else delete from investor_hwm where profile_id = r.profile_id; end if;
    update hwm_log set reverted_at = now() where id = r.id;
  end loop;
end $$;

-- cutover, once: each investor's mark is where the last quarter close left them (value now minus the profit made since that close,
-- less what withdrawals already settled). A loss since the close therefore has to be made back before the next fee.
insert into public.investor_hwm(profile_id, hwm_value)
select p.id, greatest(0, public._units_of(p.id) * public._price_now()
         - (public._period_profit(p.id, public._last_close(null), (select max(id) from public.pool_equity)) - public._period_credit(p.id)))
  from public.profiles p
 where p.role = 'investor' and public._units_of(p.id) > 0
   and exists (select 1 from public.pool_equity)
   and not exists (select 1 from public.investor_hwm);
update public.ledger_settings set value = 'investor_hwm_v2' where key = 'fee_engine';

-- ---------------------------------------------------------------- 3. lock-up: guidance only (unless lock_enforced = '1')
create or replace function public._unlocked_units(p uuid) returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(_setting('lock_enforced'), '0') <> '1' then return _units_of(p); end if;
  return (select coalesce(greatest(0, least(held, case when remaining > 0 then greatest(0, unl + wd) * held / remaining else 0 end)), 0)
            from (select _units_of(p) as held,
                         coalesce(sum(units) filter (where kind = 'deposit' and lock_until <= current_date), 0) as unl,
                         coalesce(sum(units) filter (where kind = 'withdrawal'), 0) as wd,
                         coalesce(sum(units) filter (where kind = 'deposit'), 0) + coalesce(sum(units) filter (where kind = 'withdrawal'), 0) as remaining
                    from ledger where profile_id = p) t);
end $$;

-- the lock-up date for a new deposit: investors' first deposit only
create or replace function public._lock_for(p uuid, p_at timestamptz) returns date language sql stable security definer set search_path = public as $$
  select case when (select role from profiles where id = p) <> 'investor' then null
              when exists (select 1 from ledger l where l.profile_id = p and l.kind = 'deposit' and l.units > 0
                             and not exists (select 1 from ledger r where r.reversed_of = l.id)) then null
              else (p_at::date + make_interval(months => (_setting('lock_months'))::int))::date end
$$;

-- ---------------------------------------------------------------- 4. waiting money: only money that is in the exchange counts and joins
create or replace function public._pending_total() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending' and arrived_at is not null
$$;

create or replace function public._convert_pending(p_id bigint, p_price numeric, p_at timestamptz, p_actor uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  pd pending_deposits%rowtype; u numeric := _total_units();
  v_units numeric; v_rate numeric; v_lock date; v_eq_id bigint; v_led bigint;
begin
  select * into pd from pending_deposits where id = p_id and status = 'pending' for update;
  if not found then return 0; end if;
  v_units := round(pd.usdt / p_price, 8);
  v_rate := coalesce(pd.php_rate, _last_php_rate());
  v_lock := _lock_for(pd.profile_id, p_at);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (p_at, 'deposit', u * p_price + pd.usdt, u + v_units, p_price, v_rate,
          coalesce(pd.note, 'deposit received ' || to_char(pd.received_at, 'YYYY-MM-DD')), p_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (p_at, pd.profile_id, 'deposit', v_units, pd.usdt, p_price, v_rate, pd.php_amount, v_lock, v_eq_id, pd.note) returning id into v_led;
  perform _hwm_deposit(pd.profile_id, pd.usdt, v_eq_id);
  update pending_deposits set status = 'converted', ledger_id = v_led where id = p_id;
  return v_units;
end $$;

create or replace function public._convert_all_pending(p_price numeric, p_at timestamptz, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_n int := 0; v_units numeric := 0;
begin
  if exists (select 1 from pending_deposits where status = 'pending' and arrived_at is not null and received_at > p_at + interval '5 minutes') then
    raise exception 'a waiting deposit arrived after this reading''s date: record the reading at or after it';
  end if;
  for r in select id from pending_deposits where status = 'pending' and arrived_at is not null order by received_at, id loop
    v_units := v_units + _convert_pending(r.id, p_price, p_at, p_actor); v_n := v_n + 1;
  end loop;
  return jsonb_build_object('converted', v_n, 'units', v_units);
end $$;

-- big moves, unmatched Exchange transfers and deposits not yet in the exchange need an explicit yes
create or replace function public._check_move(p_net numeric, p_confirm boolean) returns text language plpgsql security definer set search_path = public as $$
declare v_last numeric; v_mv numeric := coalesce(_setting('valuation_max_move'), '0.25')::numeric; v_unm int; v_note text := ''; v_out int; v_out_usdt numeric;
begin
  select equity_usdt into v_last from pool_equity order by id desc limit 1;
  select count(*) into v_unm from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id);
  select count(*), coalesce(sum(usdt), 0) into v_out, v_out_usdt from pending_deposits where status = 'pending' and arrived_at is null;
  if v_last is not null and v_last > 0 and abs(p_net / v_last - 1) > v_mv then
    if not coalesce(p_confirm, false) then
      raise exception 'CONFIRM: this is a % move from the last entry (% to %). If the number is right, confirm to continue.',
        to_char((p_net / v_last - 1) * 100, 'FM999990.0') || '%', round(v_last, 2), round(p_net, 2);
    end if;
    v_note := v_note || ' [confirmed ' || to_char((p_net / v_last - 1) * 100, 'FM999990.0') || '% move]';
  end if;
  if v_unm > 0 then
    if not coalesce(p_confirm, false) then
      raise exception 'CONFIRM: % Exchange transfer(s) are not matched to a deposit or withdrawal yet, so this number may include money that is not trading profit. Match or classify them first, or confirm to continue.', v_unm;
    end if;
    v_note := v_note || ' [confirmed with ' || v_unm || ' unmatched Exchange transfer(s)]';
  end if;
  if v_out > 0 then
    if not coalesce(p_confirm, false) then
      raise exception 'CONFIRM: % waiting deposit(s) (% USDT) are not marked as in the exchange, so they stay waiting and are NOT taken out of this total. If that money is already in the exchange, cancel and mark it "In the exchange" first; otherwise it would count as trading profit.', v_out, round(v_out_usdt, 2);
    end if;
    v_note := v_note || ' [confirmed: ' || v_out || ' deposit(s) not in the exchange yet]';
  end if;
  return v_note;
end $$;

drop function if exists public.admin_receive_deposit(text, uuid, numeric, numeric, numeric, text, timestamptz, text);
create or replace function public.admin_receive_deposit(p_token text, p_profile uuid, p_usdt numeric, p_php_rate numeric default null,
    p_php_amount numeric default null, p_note text default null, p_at timestamptz default null, p_idem text default null, p_in_mexc boolean default false)
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
  insert into pending_deposits(profile_id, usdt, php_rate, php_amount, note, received_at, created_by, arrived_at)
  values (p_profile, p_usdt, coalesce(p_php_rate, _last_php_rate()), p_php_amount, p_note, v_at, v_actor, case when coalesce(p_in_mexc, false) then now() end)
  returning id into v_id;
  return _idem_put(p_idem, 'admin_receive_deposit', jsonb_build_object('id', v_id, 'in_mexc', coalesce(p_in_mexc, false), 'pending_usdt', _pending_total()), v_actor);
end $$;

create or replace function public.my_pending(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'usdt', usdt, 'php_amount', php_amount, 'received_at', received_at, 'arrived_at', arrived_at) order by received_at, id)
                     from pending_deposits where profile_id = v and status = 'pending'), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- 5. valuation points
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
  if u = 0 and v_pend = 0 then
    if exists (select 1 from pending_deposits where status = 'pending') then raise exception 'mark the first deposit as "In the exchange" first: it joins once its money is in the exchange'; end if;
    raise exception 'no units yet: record the first deposit first';
  end if;
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
    v_fee := _hwm_close(r.id, v_price, r.fee_rate, v_eq_id);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'quarterly performance fee');
      v_total := v_total + v_fee; v_n := v_n + 1;
    end if;
  end loop;
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);
  perform _check_books();
  return _idem_put(p_idem, 'admin_close_quarter', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'converted', v_conv->'converted'), v_actor);
end $$;

-- ---------------------------------------------------------------- 6. withdrawals: fee on the share of the gain above the mark
create or replace function public.admin_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; pr profiles%rowtype; hu numeric; v_price numeric; v_net_eq numeric; v_rate_fee numeric;
  v_fee numeric; v_perf numeric; v_exit numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric; v_res jsonb; v_flag text;
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
  v_rate := coalesce(p_php_rate, _last_php_rate());
  if pr.role = 'investor' and not p_force then perform _check_min_withdrawal(p_profile, p_units, v_price, v_rate); end if;
  v_rate_fee := case when pr.role = 'investor' then pr.fee_rate else 0 end;
  v_perf := _hwm_take(p_profile, p_units, v_price, v_rate_fee, null);
  v_exit := round(p_units * _exit_fee_rate(p_profile), 8);
  v_fee := least(p_units, v_perf + v_exit);
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if v_net_eq - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq - v_pay, u - v_net, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform _hwm_take(p_profile, p_units, v_price, v_rate_fee, v_eq_id);
  select id into v_admin from profiles where role = 'admin' limit 1;
  if v_perf > 0 then
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -least(v_perf, v_fee), -round(least(v_perf, v_fee) * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_at, v_admin,   'fee_in',   least(v_perf, v_fee),  round(least(v_perf, v_fee) * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
  end if;
  if v_fee - least(v_perf, v_fee) > 0 then
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -(v_fee - least(v_perf, v_fee)), -round((v_fee - least(v_perf, v_fee)) * v_price, 6), v_price, v_rate, v_eq_id, 'withdrawal fee'),
           (v_at, v_admin,   'fee_in',   (v_fee - least(v_perf, v_fee)),  round((v_fee - least(v_perf, v_fee)) * v_price, 6), v_price, v_rate, v_eq_id, 'withdrawal fee');
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, p_note) returning id into v_led;
  if p_request_id is not null then update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id; end if;
  perform _check_books();
  return _idem_put(p_idem, 'admin_withdraw', jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'withdrawal_fee_units', v_fee - least(v_perf, v_fee), 'net_units', v_net, 'pay_usdt', v_pay), v_actor);
end $$;

create or replace function public.admin_withdraw_to_manager(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; pr profiles%rowtype; hu numeric; v_price numeric; v_net_eq numeric;
  v_fee numeric; v_perf numeric; v_exit numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric; v_res jsonb; v_flag text;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_withdraw_to_manager'); if v_res is not null then return v_res; end if;
  v_at := _at(p_at); u := _total_units();
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if pr.role <> 'investor' then raise exception 'only an investor''s money can be moved to the fund manager'; end if;
  select id into v_admin from profiles where role = 'admin' limit 1;
  if u <= 0 then raise exception 'the pool has no units'; end if;
  if p_request_id is not null and not exists (select 1 from withdrawal_requests where id = p_request_id and profile_id = p_profile and status = 'pending' for update) then
    raise exception 'that withdrawal request is not waiting any more (already paid or cancelled)';
  end if;
  hu := _units_of(p_profile);
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if p_request_id is not null then p_units := least(p_units, hu); end if;
  if p_units > hu + 0.00000001 then raise exception 'person only holds % units', hu; end if;
  p_units := least(p_units, hu);
  if not p_force and p_units > _unlocked_units(p_profile) + 0.00000001 then
    raise exception 'locked: only % units are past lock-up (use force to override)', _unlocked_units(p_profile);
  end if;
  v_net_eq := _net_equity(p_equity_before);
  v_flag := _check_move(v_net_eq, p_confirm);
  v_price := v_net_eq / u;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  if not p_force then perform _check_min_withdrawal(p_profile, p_units, v_price, v_rate); end if;
  v_perf := _hwm_take(p_profile, p_units, v_price, pr.fee_rate, null);
  v_exit := round(p_units * _exit_fee_rate(p_profile), 8);
  v_fee := least(p_units, v_perf + v_exit);
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  -- equity and total units stay exactly as they are
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq, u, v_price, v_rate,
          nullif('moved to fund manager' || coalesce(' · ' || p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform _hwm_take(p_profile, p_units, v_price, pr.fee_rate, v_eq_id);
  if v_perf > 0 then
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -least(v_perf, v_fee), -round(least(v_perf, v_fee) * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_at, v_admin,   'fee_in',   least(v_perf, v_fee),  round(least(v_perf, v_fee) * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
  end if;
  if v_fee - least(v_perf, v_fee) > 0 then
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -(v_fee - least(v_perf, v_fee)), -round((v_fee - least(v_perf, v_fee)) * v_price, 6), v_price, v_rate, v_eq_id, 'withdrawal fee'),
           (v_at, v_admin,   'fee_in',   (v_fee - least(v_perf, v_fee)),  round((v_fee - least(v_perf, v_fee)) * v_price, 6), v_price, v_rate, v_eq_id, 'withdrawal fee');
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, coalesce(p_note, 'paid by the fund manager')) returning id into v_led;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, v_admin, 'deposit', v_net, v_pay, v_price, v_rate, v_eq_id, 'moved from ' || coalesce(pr.name, pr.username));
  if p_request_id is not null then update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id; end if;
  perform _check_books();
  return _idem_put(p_idem, 'admin_withdraw_to_manager', jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'withdrawal_fee_units', v_fee - least(v_perf, v_fee), 'net_units', v_net, 'pay_usdt', v_pay), v_actor);
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
  v_lock := _lock_for(p_profile, v_at);
  v_eq_after := case when u = 0 then 0 else _net_equity(p_equity_before) end + p_usdt;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'deposit', v_eq_after, u + v_units, v_price, v_rate, p_note, v_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, p_usdt, v_price, v_rate, p_php_amount, v_lock, v_eq_id, p_note);
  perform _hwm_deposit(p_profile, p_usdt, v_eq_id);
  perform _check_books();
  return jsonb_build_object('units', v_units, 'unit_price', v_price, 'lock_until', v_lock);
end $$;

-- ---------------------------------------------------------------- 7. corrections restore the high-water mark
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
    perform _hwm_revert(v_last.id);
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
    perform _hwm_revert(v_last.id);
    update withdrawal_requests set status = 'pending', ledger_id = null
     where ledger_id in (select id from ledger where equity_id = v_last.id and kind = 'withdrawal');
    v_out := jsonb_build_object('kind', 'withdrawal', 'profile_id', v_profile);
  end if;
  insert into corrections(original_equity_id, correction_equity_id, reason, created_by) values (v_last.id, v_new_eq, v_note, v_actor);
  perform _check_books();
  return v_out;
end $$;

-- ---------------------------------------------------------------- 8. bot: no automatic reading while ANY deposit is waiting
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
  if exists (select 1 from pending_deposits where status = 'pending') then
    return jsonb_build_object('ok', false, 'skipped', 'a deposit is waiting to join: post the next reading by hand (Update equity)');
  end if;
  if exists (select 1 from withdrawal_requests where status = 'pending') then
    return jsonb_build_object('ok', false, 'skipped', 'a withdrawal request is open: the payout may already have left Exchange');
  end if;
  if exists (select 1 from exchange_transfers t where not exists (select 1 from transfer_matches m where m.transfer_id = t.id)) then
    return jsonb_build_object('ok', false, 'skipped', 'a Exchange transfer is not matched to a deposit or withdrawal yet: classify it first');
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
  values (v_at, 'update', p_equity, u, v_price, _last_php_rate(), coalesce(p_note, 'Exchange balance (bot)'), null);
  perform _check_books();
  return jsonb_build_object('ok', true, 'unit_price', v_price, 'equity_usdt', p_equity, 'total_units', u);
end $$;

-- ---------------------------------------------------------------- 9. what the app shows
-- 'hwm' / 'lots' keep their shape so the app's withdrawal and quarter-close previews work unchanged: ONE line per investor at H / units,
-- so  rate x max(0, price - line) x units = rate x max(0, E - H).
create or replace function public._holder_summary(p uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pr profiles%rowtype; v_price numeric := _price_now(); v_tu numeric := _total_units();
  v_units numeric; v_dep numeric; v_wd numeric; v_feein numeric; v_hwm numeric; v_hv numeric; v_gain numeric; v_lots jsonb;
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
  v_hv := case when pr.role = 'investor' then coalesce((select hwm_value from investor_hwm where profile_id = p), v_val) else v_val end;
  v_gain := greatest(0, v_val - v_hv);                                         -- gain above the mark, not charged yet (USDT)
  v_hwm := case when v_units > 0 then v_hv / v_units else v_price end;         -- the mark as a unit price
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
    'period_profit_usdt', v_val - v_hv,
    'hwm', v_hwm, 'hwm_value', v_hv, 'below_hwm_usdt', greatest(0, v_hv - v_val), 'lots', v_lots,
    'accrued_fee_usdt', v_acc, 'value_after_fee_usdt', v_net,
    'fee_paid_units', v_feeu, 'fee_paid_usdt', v_feeusd, 'profit_share_usdt', v_share,
    'gross_value_usdt', v_gross, 'gross_profit_usdt', v_gross + v_wd - v_dep,
    'gross_return_pct', case when v_dep > 0 then (v_gross + v_wd - v_dep) / v_dep end,
    'net_value_usdt', v_net, 'net_profit_usdt', v_net + v_wd - v_dep,
    'net_return_pct', case when v_dep > 0 then (v_net + v_wd - v_dep) / v_dep end,
    'profit_share_pct_points', case when v_dep > 0 then v_share / v_dep end,
    'share_pct', case when v_tu > 0 then v_units / v_tu end,
    'fee_units_earned', v_feein, 'fee_units_value_usdt', v_feein * v_price,
    'unlocked_units', v_unl, 'next_unlock', v_next, 'lock_until', v_last, 'lock_enforced', coalesce(_setting('lock_enforced'), '0') = '1',
    'php_rate', _last_php_rate());
end $$;

-- ---------------------------------------------------------------- 10. backups include the high-water marks
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
    'investor_hwm', (select coalesce(jsonb_agg(to_jsonb(h) order by h.profile_id), '[]'::jsonb) from investor_hwm h),
    'hwm_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from hwm_log g),
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
      'lots_units', (select coalesce(sum(units), 0) from ledger),
      'fee_engine', (select value from ledger_settings where key = 'fee_engine'),
      'last_equity_usdt', (select equity_usdt from pool_equity order by id desc limit 1),
      'waiting_usdt', (select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending')))
$$;

-- ---------------------------------------------------------------- 11. access
revoke all on function public._hwm_log(bigint, uuid), public._hwm_value(uuid), public._hwm_deposit(uuid, numeric, bigint),
  public._hwm_take(uuid, numeric, numeric, numeric, bigint), public._hwm_close(uuid, numeric, numeric, bigint), public._hwm_revert(bigint),
  public._lock_for(uuid, timestamptz), public._unlocked_units(uuid), public._pending_total(), public._convert_pending(bigint, numeric, timestamptz, uuid),
  public._convert_all_pending(numeric, timestamptz, uuid), public._check_move(numeric, boolean), public._holder_summary(uuid), public._export_all()
  from public, anon, authenticated;
revoke execute on function public.admin_deposit(text, uuid, numeric, numeric, numeric, numeric, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_receive_deposit(text, uuid, numeric, numeric, numeric, text, timestamptz, text, boolean) from public;
grant execute on function
  public.admin_receive_deposit(text, uuid, numeric, numeric, numeric, text, timestamptz, text, boolean),
  public.my_pending(text),
  public.admin_post_equity(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean),
  public.admin_withdraw_to_manager(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean),
  public.admin_undo_last(text, text)
to anon, authenticated;

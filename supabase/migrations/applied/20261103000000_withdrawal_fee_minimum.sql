-- Withdrawal fee and minimum withdrawal.
--   * Withdrawal fee: 5% of the units withdrawn while the investor's account is less than 1 year old, 2% after that.
--     "Account age" counts from the earlier of the profile's creation and their first deposit. It is taken in units, on top of any
--     quarter-profit fee, and goes to the fund manager exactly like that fee (fee_out / fee_in rows), so undo and the books check work unchanged.
--     The fund manager's own withdrawals carry no fee.
--   * Minimum withdrawal: 500 pesos (setting min_withdrawal_php). Taking out everything you hold is always allowed.
-- Run after 20261102000000_withdraw_to_manager.sql.

insert into public.ledger_settings(key, value) values
  ('exit_fee_young', '0.05'), ('exit_fee_mature', '0.02'), ('exit_fee_after_days', '365'), ('min_withdrawal_php', '500')
on conflict (key) do nothing;

create or replace function public._account_since(p uuid) returns timestamptz language sql stable security definer set search_path = public as $$
  select least((select created_at from profiles where id = p),
               coalesce((select min(ts) from ledger where profile_id = p and kind = 'deposit' and reversed_of is null), 'infinity'::timestamptz))
$$;

create or replace function public._exit_fee_rate(p uuid) returns numeric language sql stable security definer set search_path = public as $$
  select case when (select role from profiles where id = p) <> 'investor' then 0
              when _account_since(p) > now() - make_interval(days => coalesce(_setting('exit_fee_after_days'), '365')::int)
                then coalesce(_setting('exit_fee_young'), '0.05')::numeric
              else coalesce(_setting('exit_fee_mature'), '0.02')::numeric end
$$;

-- what the app shows: the caller's own row, or (fund manager) every investor's
create or replace function public.exit_fee_info(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token); v_admin boolean := exists (select 1 from profiles where id = v and role = 'admin');
begin
  return jsonb_build_object('min_php', coalesce(_setting('min_withdrawal_php'), '500')::numeric,
    'young_rate', coalesce(_setting('exit_fee_young'), '0.05')::numeric, 'mature_rate', coalesce(_setting('exit_fee_mature'), '0.02')::numeric, 'after_days', coalesce(_setting('exit_fee_after_days'), '365')::int,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'since', _account_since(p.id), 'rate', _exit_fee_rate(p.id)))
                          from profiles p where p.role = 'investor' and (v_admin or p.id = v)), '[]'::jsonb));
end $$;
grant execute on function public.exit_fee_info(text) to anon, authenticated;

create or replace function public._check_min_withdrawal(p uuid, p_units numeric, p_price numeric, p_php_rate numeric) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_min numeric := coalesce(_setting('min_withdrawal_php'), '500')::numeric;
begin
  if p_php_rate is null or p_php_rate <= 0 or p_units >= _units_of(p) - 0.00000001 then return; end if;
  if p_units * p_price * p_php_rate < v_min then
    raise exception 'the minimum withdrawal is % pesos (taking everything you hold is always allowed)', v_min;
  end if;
end $$;

-- ---------------------------------------------------------------- investor request: minimum applies at the last recorded peso rate
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
  if pr.role = 'investor' then
    perform _check_min_withdrawal(v, p_units, (select unit_price from pool_equity order by id desc limit 1), _last_php_rate());
  end if;
  v_by := add_business_days(current_date, (_setting('withdrawal_business_days'))::int);
  insert into withdrawal_requests(profile_id, units, note, pay_by) values (v, p_units, p_note, v_by);
  return jsonb_build_object('pay_by', v_by);
end $$;

-- ---------------------------------------------------------------- payouts: fee = quarter-profit fee + withdrawal fee, settled in units
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
  v_perf := _period_take(p_profile, p_units, v_price, v_rate_fee, null);
  v_exit := round(p_units * _exit_fee_rate(p_profile), 8);
  v_fee := least(p_units, v_perf + v_exit);
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  if v_net_eq - v_pay < 0 then raise exception 'payout exceeds pool equity'; end if;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq - v_pay, u - v_net, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform _period_take(p_profile, p_units, v_price, v_rate_fee, v_eq_id);
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
  v_perf := _period_take(p_profile, p_units, v_price, pr.fee_rate, null);
  v_exit := round(p_units * _exit_fee_rate(p_profile), 8);
  v_fee := least(p_units, v_perf + v_exit);
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  -- equity and total units stay exactly as they are
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq, u, v_price, v_rate,
          nullif('moved to fund manager' || coalesce(' · ' || p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform _period_take(p_profile, p_units, v_price, pr.fee_rate, v_eq_id);
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

grant execute on function public.request_withdrawal(text, numeric, text) to anon, authenticated;
grant execute on function public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) to anon, authenticated;
grant execute on function public.admin_withdraw_to_manager(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) to anon, authenticated;

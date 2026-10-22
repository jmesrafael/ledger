-- Withdrawal paid by the fund manager out of their own pocket: nothing leaves MEXC.
-- The investor's units are redeemed at the current price (fee settled exactly as in admin_withdraw), and the same net units land on the
-- fund manager's account in the same entry. Pool equity and total units do not change; only who owns them.
-- Undo works unchanged: admin_undo_last reverses every ledger row that shares the entry's equity_id.

create or replace function public.admin_withdraw_to_manager(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; pr profiles%rowtype; hu numeric; v_price numeric; v_net_eq numeric;
  v_fee numeric; v_net numeric; v_pay numeric; v_eq_id bigint; v_admin uuid; v_led bigint; v_rate numeric; v_res jsonb; v_flag text;
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
  v_fee := _period_take(p_profile, p_units, v_price, pr.fee_rate, null);
  v_net := p_units - v_fee;
  v_pay := round(v_net * v_price, 6);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  -- equity and total units stay exactly as they are
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq, u, v_price, v_rate,
          nullif('moved to fund manager' || coalesce(' · ' || p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform _period_take(p_profile, p_units, v_price, pr.fee_rate, v_eq_id);
  if v_fee > 0 then
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
    values (v_at, p_profile, 'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal'),
           (v_at, v_admin,   'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee at withdrawal');
  end if;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, p_profile, 'withdrawal', -v_net, -v_pay, v_price, v_rate, v_eq_id, coalesce(p_note, 'paid by the fund manager')) returning id into v_led;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, v_admin, 'deposit', v_net, v_pay, v_price, v_rate, v_eq_id, 'moved from ' || coalesce(pr.name, pr.username));
  if p_request_id is not null then update withdrawal_requests set status = 'paid', ledger_id = v_led where id = p_request_id; end if;
  perform _check_books();
  return _idem_put(p_idem, 'admin_withdraw_to_manager', jsonb_build_object('unit_price', v_price, 'fee_units', v_fee, 'net_units', v_net, 'pay_usdt', v_pay), v_actor);
end $$;

grant execute on function public.admin_withdraw_to_manager(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) to anon, authenticated;

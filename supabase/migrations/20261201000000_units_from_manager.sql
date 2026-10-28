-- UNITS FROM THE FUND MANAGER: an investor pays the fund manager directly (cash, GCash, bank) and receives some of the manager's units, so no money has to go into the
-- exchange. The mirror of admin_withdraw_to_manager (1102/1105), where an investor's units move to the manager and the manager pays them out of pocket.
-- Run after 20261105000000_hwm_arrival_lockup.sql. NOT applied to any database yet. Safe to run twice. No table or column changes; no existing function is changed.
--
--  * One pool entry that leaves the pool's equity and total units EXACTLY as they are, so the unit price and every other person's value do not move.
--  * The investor: units = round8(amount / price), recorded as a 'deposit' (their invested capital); their high-water mark rises by the amount (so the fee is only on
--    gain made after this), a first-deposit lock-up date like any deposit, and the fee-rule state of 1127 (L, rate) like any deposit.
--  * The fund manager: the same units as a 'withdrawal' (cashed out). Fund M's own capital and fee entitlement are reduced by fund_m_withdrawal_order (pro_rata by
--    default), like any Fund M withdrawal. The manager pays no fee on it (fee_basis external_investors).
--  * Valued at the exchange total entered NOW, through _net_equity, exactly like a withdrawal: the 25% jump check, and in wallet mode the wallets must agree.
--  * Refused if: the person is not an active investor, the amount is not > 0, the pool is empty, the manager holds fewer units than needed, or (1112's ledger guard) while
--    closed live trades are not applied to the pool yet, or (1106's guard) while workflow_gate is 'on', exactly like admin_withdraw_to_manager.
--  * The pool entry is a 'withdrawal' entry (as admin_withdraw_to_manager's is) because undo reverses EVERY ledger row of a withdrawal entry and restores the mark;
--    undo of a 'deposit' entry only reverses the investor's row and would leave the manager's side unbalanced.
--  * admin_quote_units_from_manager: the same call, rolled back (nothing saved), for the screen's preview.

create or replace function public.admin_units_from_manager(p_token text, p_profile uuid, p_usdt numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_php_amount numeric default null, p_note text default null, p_at timestamptz default null,
    p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; pr profiles%rowtype; v_admin uuid; v_net_eq numeric; v_price numeric; v_units numeric;
  v_mu numeric; v_rate numeric; v_lock date; v_eq_id bigint; v_res jsonb; v_flag text;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_units_from_manager'); if v_res is not null then return v_res; end if;
  v_at := _at(p_at); u := _total_units();
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if pr.role <> 'investor' then raise exception 'only an investor can receive the fund manager''s units'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  if p_usdt is null or p_usdt <= 0 then raise exception 'enter what the investor paid you (more than 0 USDT)'; end if;
  if round(p_usdt, 6) <> p_usdt then raise exception 'the amount may have at most 6 decimals (USDT)'; end if;
  if u <= 0 then raise exception 'the pool has no units yet: the first money has to go into the exchange'; end if;
  select id into v_admin from profiles where role = 'admin' limit 1;
  v_net_eq := _net_equity(p_equity_before);
  v_flag := _check_move(v_net_eq, p_confirm);
  v_price := v_net_eq / u;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  v_units := round(p_usdt / v_price, 8);
  v_mu := _units_of(v_admin);
  if v_units <= 0 then raise exception 'the amount is too small to buy any units at this price'; end if;
  if v_units > v_mu + 0.00000001 then
    raise exception 'you hold % units (worth % USDT at this price), but % USDT needs % units. Put the rest into the exchange as a normal deposit.',
      round(v_mu, 8), round(v_mu * v_price, 2), p_usdt, v_units;
  end if;
  v_units := least(v_units, v_mu);
  v_lock := _lock_for(p_profile, v_at);
  -- equity and total units stay exactly as they are
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', v_net_eq, u, v_price, v_rate,
          nullif('units moved from the fund manager to ' || coalesce(pr.name, pr.username) || coalesce(' · ' || p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, p_usdt, v_price, v_rate, p_php_amount, v_lock, v_eq_id, coalesce(p_note, 'paid to the fund manager directly'));
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, v_admin, 'withdrawal', -v_units, -p_usdt, v_price, v_rate, v_eq_id, 'units given to ' || coalesce(pr.name, pr.username) || ' (they paid you directly)');
  perform _hwm_deposit(p_profile, p_usdt, v_eq_id);
  perform _check_books();
  return _idem_put(p_idem, 'admin_units_from_manager', jsonb_build_object('unit_price', v_price, 'units', v_units, 'usdt', p_usdt, 'lock_until', v_lock,
    'manager_units_before', v_mu, 'manager_units_after', v_mu - v_units, 'equity_id', v_eq_id), v_actor);
end $$;

-- the same, rolled back: what the screen shows before you save (units the investor gets, price, your units after, or the refusal)
create or replace function public.admin_quote_units_from_manager(p_token text, p_profile uuid, p_usdt numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_at timestamptz default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    v_res := admin_units_from_manager(p_token, p_profile, p_usdt, p_equity_before, p_php_rate, null, null, p_at, null, p_confirm);
    raise exception 'quote rolled back' using errcode = 'WQ003';
  exception when sqlstate 'WQ003' then null;
  end;
  return v_res || jsonb_build_object('quote', true);
end $$;

revoke all on function public.admin_units_from_manager(text, uuid, numeric, numeric, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_quote_units_from_manager(text, uuid, numeric, numeric, numeric, timestamptz, boolean) from public;
grant execute on function public.admin_units_from_manager(text, uuid, numeric, numeric, numeric, numeric, text, timestamptz, text, boolean),
  public.admin_quote_units_from_manager(text, uuid, numeric, numeric, numeric, timestamptz, boolean) to anon, authenticated;

notify pgrst, 'reload schema';

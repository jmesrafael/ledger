-- Investor growth shown AFTER the manager's profit share, with the maths behind it, so nobody wonders why their % is
-- lower than what the trading made.
--
-- _holder_summary: unchanged, plus these fields (all USDT at today's unit price unless noted):
--   fee_paid_units / fee_paid_usdt   profit share already charged (units moved to the manager / USDT when charged)
--   gross_value_usdt                 what they would hold if no profit share had ever been taken: (units + fee_paid_units) x price
--   gross_profit_usdt, gross_return_pct   growth from the trading alone, on the money they put in
--   profit_share_usdt                the whole cut, worth today: charged units at today's price + the share owed so far
--   net_value_usdt                   what is theirs after the cut = value_usdt - accrued_fee_usdt (same as value_after_fee_usdt)
--   net_profit_usdt, net_return_pct  their own growth after the cut, on the money they put in
--   profit_share_pct_points          gross_return_pct - net_return_pct (the % the cut cost them)
-- For the manager the cut is 0, so gross = net = value.
-- Run after 20261029000000_fund_returns.sql. Safe on live data (functions only; no tables touched).

create or replace function public._holder_summary(p uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pr profiles%rowtype;
  v_price numeric := _price_now();
  v_tu numeric := _total_units();
  v_units numeric; v_dep numeric; v_wd numeric; v_feein numeric; v_hwm numeric; v_gain numeric; v_lots jsonb;
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
  select case when sum(units) > 0 then sum(units * hwm) / sum(units) end, coalesce(sum(greatest(0, v_price - hwm) * units), 0),
         coalesce(jsonb_agg(jsonb_build_array(units, hwm) order by id), '[]'::jsonb)
    into v_hwm, v_gain, v_lots from holder_lots where profile_id = p and units > 0;
  v_hwm := coalesce(v_hwm, v_price);
  v_val := v_units * v_price;
  v_profit := v_val + v_wd - v_dep;
  v_acc := case when pr.role = 'investor' then pr.fee_rate * v_gain else 0 end;   -- USDT, lot by lot
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

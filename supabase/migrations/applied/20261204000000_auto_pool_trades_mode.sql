-- Automatic pool valuation, second mode: 'trades' = ROLL FORWARD FROM THE LAST BOOKED POOL VALUE BY THE CLOSED TRADES.
--
-- auto_pool_mode = 'off'     nothing happens (default)
-- auto_pool_mode = 'trades'  pool value = last pool value + realized P&L (MEXC history, as in Telegram) of the live trades closed since that value was booked.
--                            No wallet snapshot is needed and unrealized P&L of open trades is NOT counted: the pool only moves when a trade closes.
-- auto_pool_mode = 'on'      value the pool from the combined wallet equity (needs wallet_nav_mode = 'require'); unchanged from 20261203000000.
--
-- Fairness is the unit price model, unchanged: a closed trade moves the unit price, never the units, so it is shared by the units that existed when it closed and a
-- later joiner or leaver is never touched by earlier results. A trade that closed BEFORE the last booked pool value (a deposit, a withdrawal or a manual update is also
-- a pool value) is already inside that value: it is linked to it and never added a second time. Every closed trade is added exactly once (closed_trades.equity_id).
--
-- Gates (each skip is logged in pool_recon_log and returned, never raised): ledger not paused (bot_sync_paused), units exist, a baseline pool value exists, a trade is
-- waiting, and one batch moves the pool by less than bot_max_jump. A withdrawal approved but not paid yet pauses it (auto_pool_pause_on_payout), like the wallet mode.
-- Rollback: supabase/rollback/20261204000000_rollback_auto_pool_trades_mode.sql

do $$
begin
  if to_regprocedure('public._auto_pool_value_wallet(text)') is null then
    alter function public._auto_pool_value(text) rename to _auto_pool_value_wallet;
  end if;
end $$;

create or replace function public._auto_pool_value_trades(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := _clock(); v_last pool_equity%rowtype; v_u numeric; v_ids bigint[]; v_n int; v_real numeric; v_net numeric; v_price numeric; v_eq bigint;
  v_jump numeric := coalesce(_setting('bot_max_jump'), '0.15')::numeric; v_old int;
begin
  perform _ledger_lock();
  if coalesce(_setting('bot_sync_paused'), '0') = '1' then return _auto_skip(p_source, 'paused', 'automatic valuation is paused (bot_sync_paused)'); end if;
  v_u := _total_units();
  if v_u = 0 then return jsonb_build_object('ok', false, 'skipped', 'no_units'); end if;
  if coalesce(_setting('auto_pool_pause_on_payout'), '1') = '1' and exists (select 1 from withdrawal_requests where status = 'pending' and stage = 'approved') then
    return _auto_skip(p_source, 'payout_in_progress', 'a withdrawal is approved and not paid yet: it is recorded first, then the trades are added');
  end if;
  select * into v_last from pool_equity order by id desc limit 1;
  if v_last.id is null then return _auto_skip(p_source, 'no_baseline', 'there is no booked pool value to roll forward from'); end if;

  -- trades that closed before the last booked value are already part of it
  with x as (update closed_trades set equity_id = v_last.id, reflected_at = v_now where equity_id is null and closed_at <= v_last.ts returning 1)
  select count(*) into v_old from x;
  if v_old > 0 then
    perform _pool_log('auto_pool', 'trades_already_in_value', jsonb_build_object('mismatch', v_old, 'equity_id', v_last.id,
      'text', format('%s closed trade(s) closed before the pool value #%s was booked: they are treated as already included, not added again', v_old, v_last.id)));
  end if;

  select array_agg(id), count(*), coalesce(sum(realized_usd), 0) into v_ids, v_n, v_real from closed_trades where equity_id is null;
  if coalesce(v_n, 0) = 0 then return jsonb_build_object('ok', false, 'skipped', 'nothing_new'); end if;

  v_net := v_last.equity_usdt + v_real;
  if v_net <= 0 then return _auto_skip(p_source, 'not_positive', 'the closed trades would take the pool to zero or below: check them by hand'); end if;
  if v_last.equity_usdt > 0 and abs(v_real) / v_last.equity_usdt > v_jump then
    return _auto_skip(p_source, 'jump', format('the %s waiting trade(s) move the pool by %s%% (limit %s%%): check them, then value by hand.',
      v_n, round(v_real / v_last.equity_usdt * 100, 2), round(v_jump * 100)));
  end if;

  v_price := v_net / v_u;
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (_at(null), 'update', v_net, v_u, v_price, _last_php_rate(),
          format('Auto (%s): %s closed trade(s), realized %s USDT, from %s', p_source, v_n, round(v_real, 2), round(v_last.equity_usdt, 2)), null)
  returning id into v_eq;
  insert into auto_pool_runs(equity_id, nav_before, nav_after, unit_price, unrealized_after, trades, realized_usd, residual, residual_flag)
  values (v_eq, v_last.equity_usdt, v_net, v_price, null, v_n, v_real, null, false);
  update closed_trades set equity_id = v_eq, reflected_at = v_now where id = any(v_ids);
  perform _check_books();
  return jsonb_build_object('ok', true, 'equity_id', v_eq, 'unit_price', v_price, 'nav_before', v_last.equity_usdt, 'nav_after', v_net, 'trades', v_n, 'realized_usd', v_real);
end $$;

-- the single entry point the bots' calls already use
create or replace function public._auto_pool_value(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare m text := coalesce(_setting('auto_pool_mode'), 'off');
begin
  if m = 'trades' then return _auto_pool_value_trades(p_source); end if;
  if m = 'on' then return _auto_pool_value_wallet(p_source); end if;
  return jsonb_build_object('ok', false, 'skipped', 'off');
end $$;

revoke all on function public._auto_pool_value(text), public._auto_pool_value_wallet(text), public._auto_pool_value_trades(text) from public, anon, authenticated;
notify pgrst, 'reload schema';

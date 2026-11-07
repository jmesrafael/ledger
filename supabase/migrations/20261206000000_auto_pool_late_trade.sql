-- Trades mode: a closed trade that reaches the ledger AFTER a later-closed trade of another wallet is added, not skipped.
--
-- The bug (found Nov 7, 2026 on the live ledger): the "already in the value" rule compared a trade's close time with the newest pool entry of ANY kind. With two wallets the
-- reports can arrive out of close order: on Nov 4 I-Core's GALA (closed 15:05:57) was booked 2 s before BB-Core's SOL (closed 14:48:03); SOL then looked older than the
-- newest entry (which was GALA's own automatic entry), was marked "already included" and its -4.9258 USDT never reached the pool value.
--
-- The rule now: a trade is already inside a value only if that value was taken from the exchange by a person (a manual valuation, deposit or payout entry), i.e. a pool entry
-- that this automatic routine did NOT write (it writes one auto_pool_runs row per entry). Automatic entries only ever contain the trades they name.
-- A late trade gets its own entry dated no earlier than the newest entry, so the entries stay in date order; its note keeps the real close time.
-- The existing entries are not changed here: the missed SOL trade is corrected separately by the manager (admin_add_adjustment), with a reason, in the activity log.
-- Rollback: re-apply the _auto_pool_value_trades() body from 20261205000000_auto_pool_trades_dated.sql.

create or replace function public._auto_pool_value_trades(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := _clock(); v_last pool_equity%rowtype; v_u numeric; v_n int; v_real numeric; v_run numeric; v_eq bigint; v_first bigint; v_cnt int := 0; r record;
  v_jump numeric := coalesce(_setting('bot_max_jump'), '0.15')::numeric; v_old int; v_manual pool_equity%rowtype;
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

  -- the newest value a PERSON took from the exchange (not one of this routine's own entries): only it can already contain a trade that closed before it
  select * into v_manual from pool_equity p where not exists (select 1 from auto_pool_runs a where a.equity_id = p.id) order by id desc limit 1;
  if v_manual.id is not null then
    with x as (update closed_trades set equity_id = v_manual.id, reflected_at = v_now where equity_id is null and closed_at <= v_manual.ts returning 1)
    select count(*) into v_old from x;
    if v_old > 0 then
      perform _pool_log('auto_pool', 'trades_already_in_value', jsonb_build_object('mismatch', v_old, 'equity_id', v_manual.id,
        'text', format('%s closed trade(s) closed before the exchange valuation #%s: they are treated as already included, not added again', v_old, v_manual.id)));
    end if;
  end if;

  select count(*), coalesce(sum(realized_usd), 0) into v_n, v_real from closed_trades where equity_id is null;
  if v_n = 0 then return jsonb_build_object('ok', false, 'skipped', 'nothing_new'); end if;
  if v_last.equity_usdt + v_real <= 0 then return _auto_skip(p_source, 'not_positive', 'the closed trades would take the pool to zero or below: check them by hand'); end if;
  if v_last.equity_usdt > 0 and abs(v_real) / v_last.equity_usdt > v_jump then
    return _auto_skip(p_source, 'jump', format('the %s waiting trade(s) move the pool by %s%% (limit %s%%): check them, then value by hand.',
      v_n, round(v_real / v_last.equity_usdt * 100, 2), round(v_jump * 100)));
  end if;

  v_run := v_last.equity_usdt;
  for r in select id, symbol, side, closed_at, realized_usd from closed_trades where equity_id is null order by closed_at, id loop
    v_run := v_run + r.realized_usd;
    if v_run <= 0 then raise exception 'the closed trades would take the pool to zero or below at trade %', r.id; end if;
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
    values (_at(greatest(least(r.closed_at, now()), v_last.ts)), 'update', v_run, v_u, v_run / v_u, _last_php_rate(),
            format('Auto (%s): %s %s closed%s, realized %s USDT', p_source, regexp_replace(r.symbol, '_USDT$', ''), r.side,
                   case when r.closed_at < v_last.ts then ' ' || to_char(r.closed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC (reported late)' else '' end,
                   round(r.realized_usd, 2)), null)
    returning id into v_eq;
    v_last.ts := greatest(least(r.closed_at, now()), v_last.ts);
    v_first := coalesce(v_first, v_eq); v_cnt := v_cnt + 1;
    insert into auto_pool_runs(equity_id, nav_before, nav_after, unit_price, unrealized_after, trades, realized_usd, residual, residual_flag)
    values (v_eq, v_run - r.realized_usd, v_run, v_run / v_u, null, 1, r.realized_usd, null, false);
    update closed_trades set equity_id = v_eq, reflected_at = v_now where id = r.id;
  end loop;
  perform _check_books();
  return jsonb_build_object('ok', true, 'equity_id', v_eq, 'first_equity_id', v_first, 'unit_price', v_run / v_u, 'nav_before', v_last.equity_usdt, 'nav_after', v_run, 'trades', v_cnt, 'realized_usd', v_real);
end $$;

revoke all on function public._auto_pool_value_trades(text) from public, anon, authenticated;
notify pgrst, 'reload schema';

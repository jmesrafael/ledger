-- Rollback of 20261207000000_true_value_pricing.sql. Allowed while no true-value deposit, payout or settlement has been recorded (flow_checkpoints is empty);
-- refused otherwise (their pool entries depend on it). Run it with flow_pricing = 'book'.
-- Book corrections are NOT true-value transactions: the book_corrections table, its rows (reason, evidence, who applied it and when) and its append-only guard are
-- KEPT, and stay in the backup export, so an applied correction remains fully traceable. Everything else the migration added is removed, and the two existing
-- functions it changed get their previous bodies back (the late-trade rule keeps knowing that a correction entry is not an exchange valuation).
do $$ begin
  if exists (select 1 from public.flow_checkpoints) then
    raise exception 'true-value deposits, payouts or settlements are recorded: not rolled back';
  end if;
end $$;
update public.ledger_settings set value = 'book' where key = 'flow_pricing';
create or replace function public._pool_guard_pending() returns void language plpgsql stable security definer set search_path = public as $$
declare p jsonb;
begin
  if _wallet_mode() = 'require' then return; end if;
  if coalesce(_setting('pool_update_gate'), 'on') <> 'on' then return; end if;
  p := _pool_pending();
  if (p->>'count')::int > 0 then
    raise exception 'pending P/L: % closed live trade(s) (%) are not applied to the pool yet. Click Update Pool first, then accept joiners or pay out.',
      p->>'count', case when (p->>'missing_usd')::int > 0 then 'dollar amount not shared' else round((p->>'usd')::numeric, 2)::text || ' USDT' end;
  end if;
end $$;
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

  -- the newest value a PERSON entered (valuation, deposit, payout or quarter close: every pool entry kind except this routine's own): only it can already contain a
  -- trade that closed before it
  select * into v_manual from pool_equity p where not exists (select 1 from auto_pool_runs a where a.equity_id = p.id)
    and not exists (select 1 from book_corrections b where b.equity_id = p.id) order by id desc limit 1;   -- a correction (kept after the rollback) is not an exchange valuation
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

revoke all on function public._pool_guard_pending(), public._auto_pool_value_trades(text) from public, anon, authenticated;
drop trigger if exists tv_guard_pool_entry on public.pool_equity;
drop function if exists public._tv_guard_pool_entry();
drop function if exists public.admin_admit_deposit_tv(text, bigint, text);
drop function if exists public.admin_admit_deposits_tv(text, bigint[], timestamptz, text);
drop function if exists public.admin_execute_withdrawal_tv(text, bigint, numeric, text, text);
drop function if exists public.admin_close_quarter_tv(text, numeric, text, text);
drop function if exists public.admin_settlement_preview_tv(text);
drop function if exists public.admin_apply_book_correction(text, bigint, text);
drop function if exists public.admin_preview_book_corrections(text);
drop function if exists public.admin_book_corrections(text);
drop function if exists public.admin_true_value(text);
drop function if exists public.admin_true_value_at(text, timestamptz);
drop function if exists public.my_true_value(text);
drop function if exists public._tv_require(timestamptz);
drop function if exists public._tv_checkpoint(text, uuid, bigint, uuid, bigint, bigint, jsonb, numeric, numeric, numeric);
drop function if exists public._tv_wallets_used(jsonb);
drop function if exists public._tv_set_book(numeric, timestamptz, uuid, text);
drop function if exists public._true_value(timestamptz, numeric);
drop function if exists public._wallet_nav_at(timestamptz);
drop function if exists public._tv_unmatched_exits();
drop function if exists public._tv_wallet_of_event(text);
-- the backup export: back to the previous definition plus the kept book_corrections table
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_tv() || jsonb_build_object('book_corrections', _dump_table('book_corrections'))
$$;
revoke all on function public._export_extra() from public, anon, authenticated;
drop table if exists public.flow_checkpoints;
delete from public.ledger_settings where key in ('flow_pricing', 'tv_exit_match_hours');
notify pgrst, 'reload schema';


create or replace function public.admin_close_quarter_tv(p_token text, p_php_rate numeric default null, p_note text default null, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token);
begin
  return _close_quarter_tv_core(v_actor, p_php_rate, p_note, p_idem);
end $$;

-- ---------------------------------------------------------------- 2. where the settlement calendar stands (reads only)
-- state: 'no_period' (nothing has ended since the pool began) | 'settled' (the last ended period is settled) | 'due' (inside the window, not settled) |
--        'missed' (the window closed without a settlement: covered by the next one)
create or replace function public._settlement_calendar(out o_state text, out o_start timestamptz, out o_end timestamptz, out o_window_end timestamptz, out o_next timestamptz,
    out o_last_close timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_now timestamptz := _clock(); v_win int := coalesce(nullif(_setting('settlement_window_days'), '')::int, 7); v_first timestamptz;
begin
  select o.o_start, o.o_end, o.o_next into o_start, o_end, o_next from _settlement_period(v_now) o;
  o_window_end := o_end + make_interval(days => v_win);
  select max(ts) into o_last_close from pool_equity where kind = 'close';
  select min(ts) into v_first from pool_equity;
  o_state := case when v_first is null or o_end <= v_first then 'no_period'
                  when o_last_close is not null and o_last_close >= o_end then 'settled'
                  when v_now < o_window_end then 'due' else 'missed' end;
end $$;

-- ---------------------------------------------------------------- 3. the automatic run
create or replace function public._settle_auto(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cal record; t jsonb; v_actor uuid; v_open int := 0; v_rule text := coalesce(_setting('settlement_auto_open_trades'), 'allow'); v_res jsonb; v_reason text; v_code text;
  v_tz text := coalesce(_setting('settlement_tz'), 'Asia/Manila'); v_key text; v_total numeric;
begin
  if coalesce(_setting('settlement_auto'), 'off') <> 'on' then return jsonb_build_object('ok', false, 'skipped', 'settlement_auto_off'); end if;
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' or coalesce(_setting('settlement_schedule'), 'bimonthly') <> 'bimonthly' or _total_units() <= 0 then
    return jsonb_build_object('ok', false, 'skipped', 'not_applicable');
  end if;
  select * into cal from _settlement_calendar();
  if cal.o_state <> 'due' then return jsonb_build_object('ok', false, 'skipped', cal.o_state); end if;
  perform _ledger_lock();
  select * into cal from _settlement_calendar();               -- again under the lock: another session may have settled meanwhile
  if cal.o_state <> 'due' then return jsonb_build_object('ok', false, 'skipped', cal.o_state); end if;
  select id into v_actor from profiles where role = 'admin' order by created_at, id limit 1;
  t := _true_value(null);
  if not coalesce((t->>'ok')::boolean, false) then
    v_code := 'price_paused';
    v_reason := 'the MEXC reading is not verified: ' || coalesce((select string_agg(x->>'text', '; ') from jsonb_array_elements(t->'reasons') x), 'no complete set of wallet reports');
  elsif (t->>'measured_at')::timestamptz < cal.o_end then
    return jsonb_build_object('ok', false, 'skipped', 'reading_before_period_end');     -- the next report is after the boundary
  else
    select coalesce(sum((w->>'open_positions')::int), 0) into v_open from jsonb_array_elements(t->'wallets') w;
    if v_open > 0 and v_rule <> 'allow' then
      v_code := 'open_trades'; v_reason := v_open || ' position(s) are open and settlement_auto_open_trades = ' || v_rule || ': waiting for a reading with none';
    end if;
  end if;
  if v_code is null then
    v_key := 'auto-settlement-' || to_char(cal.o_end at time zone v_tz, 'YYYY-MM-DD');
    v_total := (t->>'combined_equity_usdt')::numeric;
    begin
      perform set_config('ledger.actor', v_actor::text, true);
      if v_open > 0 and _fee_timing() <> 'confirmed' and _settlement_exception('open_positions', cal.o_end, v_total) is null then
        insert into settlement_exceptions(kind, period_end, mexc_total, open_positions, note, created_by, ts)
        values ('open_positions', cal.o_end, v_total, least(v_open, 50),
          'automatic settlement at true value: the fee is taken at the verified MEXC price with open trades included once, and each mark moves to that price', v_actor, _clock());
      end if;
      v_res := _close_quarter_tv_core(v_actor, null, 'Two-month settlement (automatic, true value)', v_key);
      perform _audit(v_actor, 'settlement_auto', null, jsonb_build_object('automatic', true, 'source', p_source, 'settlement_id', v_res->'settlement_id',
        'period_end', cal.o_end, 'fee_usdt', v_res->'fee_usdt', 'fee_units', v_res->'fee_units', 'investors_charged', v_res->'investors_charged', 'open_positions', v_open));
      return jsonb_build_object('ok', true, 'settled', true) || v_res;
    exception when others then
      v_code := 'refused'; v_reason := sqlerrm;                 -- everything inside the block is rolled back, the exception row included
    end;
  end if;
  -- not settled: one audit line per reason per day (the Settle screen shows the newest)
  if not exists (select 1 from audit_log a where a.action = 'settlement_auto_waiting' and a.detail->>'code' = v_code and (a.detail->>'period_end')::timestamptz = cal.o_end
                   and a.ts > now() - interval '24 hours') then
    perform _audit(v_actor, 'settlement_auto_waiting', null, jsonb_build_object('code', v_code, 'reason', v_reason, 'period_end', cal.o_end, 'window_end', cal.o_window_end, 'source', p_source));
  end if;
  return jsonb_build_object('ok', false, 'waiting', v_code, 'reason', v_reason);
end $$;

-- the wallet report: store it, book any closed trade, the NAV reading (20261213), then the automatic settlement. Each later step is protected.
create or replace function public.bot_post_wallet_snapshot(p_key text, p_wallet text, p_seq bigint, p_reported_at timestamptz, p_equity numeric, p_unrealized numeric,
    p_withdrawable numeric, p_available numeric, p_open_positions int, p_open_orders int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; v_pool jsonb; v_nav jsonb; v_set jsonb;
begin
  r := _bot_post_wallet_snapshot_core(p_key, p_wallet, p_seq, p_reported_at, p_equity, p_unrealized, p_withdrawable, p_available, p_open_positions, p_open_orders);
  if coalesce((r->>'replayed')::boolean, false) then return r; end if;
  begin v_pool := _auto_pool_value('wallet_report'); exception when others then v_pool := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  begin v_nav := _nav_tick('wallet_report'); exception when others then v_nav := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  begin v_set := _settle_auto('wallet_report'); exception when others then v_set := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  return r || jsonb_build_object('pool', v_pool, 'nav', v_nav, 'settlement', v_set);
end $$;

-- ---------------------------------------------------------------- 4. the Settle screen (reads only)
create or replace function public.admin_settlement_status(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare cal record; t jsonb; v_price numeric; v_lines jsonb := '[]'::jsonb; r record; c record; v_fee numeric := 0; v_open int; v_last jsonb; v_wait jsonb;
begin
  perform _admin(p_token);
  select * into cal from _settlement_calendar();
  t := _true_value(null);
  if coalesce((t->>'ok')::boolean, false) then
    v_price := (t->>'unit_price')::numeric;
    select coalesce(sum((w->>'open_positions')::int), 0) into v_open from jsonb_array_elements(t->'wallets') w;
    for r in select p.id, p.name, p.username, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
      select * into c from _hwm_settle_calc(r.id, v_price, r.fee_rate);
      v_lines := v_lines || jsonb_build_object('profile_id', r.id, 'name', coalesce(nullif(r.name, ''), r.username), 'units', c.o_units, 'value_usdt', round(c.o_value, 6),
        'mark_usdt', round(c.o_hwm, 6), 'profit_above_mark_usdt', round(greatest(0, c.o_value - c.o_hwm), 6), 'fee_rate', c.o_rate, 'fee_units', c.o_fee,
        'fee_usdt', round(c.o_fee * v_price, 6), 'mark_after_usdt', round(c.o_hwm_after, 6));
      v_fee := v_fee + round(c.o_fee * v_price, 6);
    end loop;
  end if;
  select to_jsonb(x) into v_last from (select s.id, s.valued_at, s.period_end, s.unit_price, s.fee_usdt, s.fee_units, s.investors_charged, s.recon_status,
      exists (select 1 from audit_log a where a.action = 'settlement_auto' and (a.detail->>'settlement_id')::bigint = s.id) as automatic
    from settlements s order by s.id desc limit 1) x;
  select to_jsonb(x) into v_wait from (select a.ts, a.detail->>'code' as code, a.detail->>'reason' as reason from audit_log a
    where a.action = 'settlement_auto_waiting' and (a.detail->>'period_end')::timestamptz = cal.o_end order by a.id desc limit 1) x;
  return jsonb_build_object(
    'auto', coalesce(_setting('settlement_auto'), 'off'), 'open_trades_rule', coalesce(_setting('settlement_auto_open_trades'), 'allow'), 'fee_timing', _fee_timing(),
    'state', cal.o_state, 'period_start', cal.o_start, 'period_end', cal.o_end, 'window_end', cal.o_window_end, 'next_period_end', cal.o_next, 'now', _clock(),
    'timezone', coalesce(_setting('settlement_tz'), 'Asia/Manila'),
    'price_ok', coalesce((t->>'ok')::boolean, false), 'price_reasons', coalesce(t->'reasons', '[]'::jsonb), 'unit_price', v_price, 'open_positions', v_open,
    'lines', v_lines, 'fee_usdt_now', v_fee, 'last_settlement', v_last, 'last_waiting', case when cal.o_state = 'due' then v_wait end);
end $$;

-- ---------------------------------------------------------------- access
revoke all on function public._close_quarter_tv_core(uuid, numeric, text, text), public._settlement_calendar(), public._settle_auto(text) from public, anon, authenticated;
revoke all on function public.admin_settlement_status(text), public.admin_close_quarter_tv(text, numeric, text, text) from public;
grant execute on function public.admin_settlement_status(text), public.admin_close_quarter_tv(text, numeric, text, text) to anon, authenticated;
revoke all on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) from public;
grant execute on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) to anon, authenticated;

notify pgrst, 'reload schema';

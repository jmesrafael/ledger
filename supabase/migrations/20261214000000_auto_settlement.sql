-- AUTOMATIC TWO-MONTH SETTLEMENT. Docs: docs/auto-settlement.md. Tests: tests/auto-settlement.test.mjs. Rollback: supabase/rollback/20261214000000_rollback_auto_settlement.sql
-- Built by scripts/build-auto-settlement.mjs (edit supabase/parts/auto-settlement/*, not this file).
-- NOT applied to the live database (owner step). Safe to run twice. It rewrites no ledger row and makes no settlement when it is run.
--
-- What it adds: the existing true-value settlement (admin_close_quarter_tv, 20261207) runs BY ITSELF at the first verified MEXC wallet reading after a
-- two-month period ends (Jan 1, Mar 1, May 1, Jul 1, Sep 1, Nov 1, Manila time), inside the 7-day window. Nothing about the fee changes:
--   fee = the investor's rate x (their value - their high-water mark), only when that is positive (profit only; a deposit raises the mark, so their own money is
--   never charged). The fee moves as UNITS from the investor to the fund manager (ledger rows fee_out / fee_in at the same price), so total units, pool value and
--   the unit price do not move, and the books check (units sum = pool total, fee units net to zero) runs after it as after every write.
--
--   1. _close_quarter_tv_core(p_actor, ...): the body of admin_close_quarter_tv, unchanged, with the acting person passed in instead of a session token.
--      admin_close_quarter_tv(p_token, ...) is now the same core behind the manager's token ("Settle now" in the app).
--   2. _settle_auto(p_source): called after every wallet report (after the NAV reading). It does nothing unless ALL of these hold:
--        settlement_auto = 'on'; flow_pricing = 'true_value'; a period has ended that is not settled; now is inside its window;
--        the wallet reading is verified (complete, fresh, reconciled with the books) and was measured after the period ended;
--        open trades are allowed by settlement_auto_open_trades (below).
--      A failure inside it never loses the wallet report (it is a protected step, like the NAV reading), saves nothing, and is written to the audit log
--      (settlement_auto_waiting, once per reason per day). A settlement it makes is audited as settlement_closed plus settlement_auto.
--   3. settlement_auto_open_trades:
--        'allow' (default): settle with trades open. The fee is taken at the true price (open P&L included, once) and the mark moves to that price, so the same
--                 profit is never charged again when the trade closes. Under fee_timing = 'immediate' this needs an open_positions exception: the automatic run
--                 writes it itself (kind open_positions, the reading's exchange total, the number of open positions, a fixed note), so it is on record.
--        'wait':  settle only at a reading with no open position on any wallet. If none comes inside the window, nothing is settled and the manager decides.
--   4. admin_settlement_status(p_token): what the Settle screen shows (period, window, state, each investor's fee at the current true price, the last settlement,
--      the last automatic attempt). Reads only.
--
-- A period whose window passed without a settlement is NOT settled late by the automatic run. Nothing is lost: the mark is per investor, so the next
-- settlement charges everything above it (this is how the unsettled Sep-Oct 2026 period is covered by the Jan 1-7, 2027 settlement).

insert into public.ledger_settings(key, value) values
  ('settlement_auto', 'on'),                 -- 'off': no automatic settlement (the manager presses Settle now inside the window)
  ('settlement_auto_open_trades', 'allow')   -- 'allow' | 'wait' (see above)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 1. the settlement core (body of 20261207's admin_close_quarter_tv; only the actor's source differs)

create or replace function public._close_quarter_tv_core(p_actor uuid, p_php_rate numeric default null, p_note text default null, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := p_actor; t jsonb; v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record; c record;
  v_lastc timestamptz; v_fee numeric; v_total numeric := 0; v_total_usd numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb; v_total_eq numeric;
  v_gap int := coalesce(_setting('min_days_between_closes'), '0')::int; v_res jsonb; v_per record; v_rec jsonb; v_req jsonb; v_late int; v_fm jsonb; v_open int; v_ids bigint[];
  v_from bigint; v_cfrom timestamptz; v_pp numeric; v_fm0 jsonb; v_period jsonb; v_book bigint; v_set bigint; v_cp bigint; v_dep numeric; v_now timestamptz := _clock();
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_close_quarter_tv'); if v_res is not null then return v_res; end if;
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(null);
  v_total_eq := (t->>'combined_equity_usdt')::numeric;
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity))); u := _total_units();
  select max(ts) into v_lastc from pool_equity where kind = 'close';
  if v_gap > 0 and v_lastc is not null and v_at < v_lastc + make_interval(days => v_gap) then
    raise exception 'the last settlement was on %; the next one is allowed from %', v_lastc::date, (v_lastc + make_interval(days => v_gap))::date;
  end if;
  select * into v_per from _settlement_period(v_at);
  if v_per.o_end <= (select min(ts) from pool_equity) then
    raise exception 'no settlement period has ended yet: the first one can be settled from %', (v_per.o_next at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date;
  end if;
  if coalesce(_setting('settlement_schedule'), 'bimonthly') = 'bimonthly' and v_lastc is not null and v_lastc >= v_per.o_end then
    raise exception 'the period ending % is already settled; the next settlement is allowed from %',
      (v_per.o_end at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date - 1, (v_per.o_next at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date;
  end if;
  v_nav := (t->>'true_value_usdt')::numeric; v_price := (t->>'unit_price')::numeric;
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  select count(*) into v_late from pool_equity where ts >= v_per.o_end and kind in ('deposit', 'withdrawal');
  perform set_config('ledger.settle_ctx', '1', true);              -- the settlement guard recognises a settlement function, as for admin_close_quarter
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', v_nav, u, v_price, v_rate, coalesce(p_note, 'settlement at true value (wallet reports)'), v_actor) returning id into v_eq_id;
  perform set_config('ledger.settle_ctx', '', true);
  -- the ledger's own consistency over the period and the matching of every exchange transfer stay required; the exchange evidence is the verified wallet reports
  -- (passed as 'verified' with their open positions), so the existing rules for late / backdated settlements and for open trades apply unchanged
  v_rec := _settlement_recon(v_eq_id, v_total_eq, null, v_at);
  if v_rec->>'status' not in ('internal_mismatch', 'unmatched_transfers') then
    v_rec := v_rec || jsonb_build_object('status', 'verified', 'reasons_before', v_rec->'reasons', 'reasons', '[]'::jsonb,
      'last_snapshot', jsonb_build_object('source', 'wallet reports', 'equity_usdt', v_total_eq,
        'open_positions', (select coalesce(sum((w->>'open_positions')::int), 0) from jsonb_array_elements(t->'wallets') w), 'open_orders', 0));
  end if;
  v_req := _settlement_requirements(v_total_eq, v_at, v_rec);
  if jsonb_array_length(v_req->'blocked') > 0 then raise exception '%', v_req->'blocked'->>0; end if;
  v_rec := (v_req->'rec') || jsonb_build_object('status', 'verified_true_value', 'true_value', t - 'wallets' - 'reasons', 'wallets', _tv_wallets_used(t));
  v_open := nullif(v_req->>'open_positions', '')::int;
  v_ids := coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(v_req->'exception_ids') x), '{}');
  v_from := _last_close(v_eq_id);
  v_cfrom := case when v_from > 0 then (select ts from pool_equity where id = v_from) else (select min(ts) from pool_equity) end;
  v_fm0 := _fund_m_state(v_from + 1);
  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_eq_id);
    select * into c from _hwm_settle_calc(r.id, v_price, r.fee_rate);
    v_fee := _hwm_close(r.id, v_price, r.fee_rate, v_eq_id);
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement, true value)'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement, true value)');
      v_total := v_total + v_fee; v_total_usd := v_total_usd + round(v_fee * v_price, 6); v_n := v_n + 1;
    end if;
    insert into settlement_lines(equity_id, profile_id, units_before, unit_price, value_before, hwm_before, eligible_profit, fee_rate, fee_units, fee_usdt, hwm_after, period_profit_usdt,
        fee_timing, last_value_before, confirmed_profit, pending_profit, rate_applied, last_value_after)
    values (v_eq_id, r.id, c.o_units, v_price, c.o_value, c.o_hwm, c.o_value - c.o_hwm, r.fee_rate, v_fee, round(v_fee * v_price, 6), _hwm_value(r.id), v_pp,
        _fee_timing(), c.o_last, c.o_confirmed, c.o_pending, c.o_rate, c.o_last_after);
  end loop;
  v_fm := _fund_m_state(v_eq_id + 1);
  v_period := _fund_m_period(v_fm0, v_fm, v_total_usd, (v_rec->>'fees_at_withdrawals_usdt')::numeric);
  v_fm := v_fm || jsonb_build_object('period', v_period);
  insert into settlements(equity_id, period_start, period_end, valued_at, mexc_total, nav, total_units, unit_price, opening_nav, deposits_usdt,
      withdrawals_usdt, trading_pnl_usdt, entries_after_period_end, fee_basis, investors_charged, fee_units, fee_usdt, fund_m, recon, recon_status, attestation_id, created_by,
      balance_verification_id, covered_from, covered_to, days_after_period_end, late, backdated_days, exception_ids, open_positions_at_settlement, recorded_at, backdated)
  values (v_eq_id, v_per.o_start, v_per.o_end, v_at, v_total_eq, v_nav, u, v_price, (v_rec->>'opening_nav')::numeric, (v_rec->>'deposits_usdt')::numeric,
      (v_rec->>'withdrawals_usdt')::numeric, (v_rec->>'trading_pnl_usdt')::numeric, v_late, coalesce(_setting('fee_basis'), 'external_investors'), v_n, v_total, v_total_usd,
      v_fm, v_rec, 'verified_true_value', nullif(v_req->>'att', '')::bigint, v_actor,
      null, v_cfrom, v_at, round(extract(epoch from v_at - v_per.o_end) / 86400, 3), (v_req->>'late')::boolean,
      round(greatest(0, extract(epoch from v_now - v_at) / 86400)::numeric, 3), v_ids, v_open, v_now, coalesce((v_req->>'backdated')::boolean, false)) returning id into v_set;
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);       -- waiting money joins after the fees, at the settlement price
  select coalesce(sum(usdt), 0) into v_dep from ledger where kind = 'deposit' and equity_id > v_eq_id;
  v_book := _tv_set_book((t->>'book_now_usdt')::numeric + (t->>'gap_usdt')::numeric + v_dep, v_at, v_actor, 'settlement #' || v_set);
  v_cp := _tv_checkpoint('settlement', v_actor, v_set, null, v_eq_id, v_book, t, v_price, v_total_usd, v_total);
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  perform _audit(v_actor, 'settlement_closed', null, jsonb_build_object('settlement_id', v_set, 'equity_id', v_eq_id, 'period_end', v_per.o_end, 'covered_from', v_cfrom, 'covered_to', v_at,
    'recorded_at', v_now, 'late', (v_req->>'late')::boolean, 'recon_status', 'verified_true_value', 'exception_ids', v_ids, 'open_positions', v_open, 'investors_charged', v_n,
    'fee_usdt', v_total_usd, 'mexc_total', v_total_eq, 'fee_timing', _fee_timing(), 'warnings', v_req->'warnings', 'true_value', true, 'open_pnl', t->'open_pnl_usdt', 'checkpoint_id', v_cp));
  return _idem_put(p_idem, 'admin_close_quarter_tv', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'fee_usdt', v_total_usd,
    'converted', v_conv->'converted', 'settlement_id', v_set, 'period_start', v_per.o_start, 'period_end', v_per.o_end, 'covered_from', v_cfrom, 'covered_to', v_at,
    'late', (v_req->>'late')::boolean, 'exception_ids', to_jsonb(v_ids), 'recon_status', 'verified_true_value', 'equity_id', v_eq_id, 'book_equity_id', v_book,
    'checkpoint_id', v_cp, 'open_positions', v_open, 'fund_m_period', v_period, 'fee_timing', _fee_timing(), 'warnings', v_req->'warnings'), v_actor);
end $$;

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

-- ROLLBACK of 20261214000000_auto_settlement.sql: puts back admin_close_quarter_tv (20261207) and bot_post_wallet_snapshot (20261213) exactly, and removes the
-- automatic run. Built by scripts/build-auto-settlement.mjs. Settlements already made (automatic or not), their exceptions and audit rows are ordinary
-- append-only records and stay.
do $$ begin
  if to_regprocedure('public._settle_auto(text)') is null then raise exception 'rollback refused: 20261214000000_auto_settlement.sql is not applied'; end if;
end $$;

create or replace function public.admin_close_quarter_tv(p_token text, p_php_rate numeric default null, p_note text default null, p_idem text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); t jsonb; v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record; c record;
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

create or replace function public.bot_post_wallet_snapshot(p_key text, p_wallet text, p_seq bigint, p_reported_at timestamptz, p_equity numeric, p_unrealized numeric,
    p_withdrawable numeric, p_available numeric, p_open_positions int, p_open_orders int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; v_pool jsonb; v_nav jsonb;
begin
  r := _bot_post_wallet_snapshot_core(p_key, p_wallet, p_seq, p_reported_at, p_equity, p_unrealized, p_withdrawable, p_available, p_open_positions, p_open_orders);
  if coalesce((r->>'replayed')::boolean, false) then return r; end if;
  begin v_pool := _auto_pool_value('wallet_report'); exception when others then v_pool := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  begin v_nav := _nav_tick('wallet_report'); exception when others then v_nav := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  return r || jsonb_build_object('pool', v_pool, 'nav', v_nav);
end $$;

drop function if exists public.admin_settlement_status(text);
drop function if exists public._settle_auto(text);
drop function if exists public._settlement_calendar();
drop function if exists public._close_quarter_tv_core(uuid, numeric, text, text);
delete from public.ledger_settings where key in ('settlement_auto', 'settlement_auto_open_trades');
revoke all on function public.admin_close_quarter_tv(text, numeric, text, text) from public;
grant execute on function public.admin_close_quarter_tv(text, numeric, text, text) to anon, authenticated;
revoke all on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) from public;
grant execute on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) to anon, authenticated;
notify pgrst, 'reload schema';

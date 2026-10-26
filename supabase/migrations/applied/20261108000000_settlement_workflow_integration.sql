-- SETTLEMENT x CAPITAL WORKFLOW INTEGRATION. Run after 20261107000000_hwm_bimonthly_settlement.sql. NOT applied to any database yet.
-- Safe to run twice. No row is changed: it adds two nullable columns and replaces function bodies.
--
-- 1. A CONFIRMED MANUAL BALANCE CHECK IS THE SETTLEMENT'S VERIFICATION. Every two months the manager types the exchange total
--    (admin_enter_balance) and confirms it as a separate step (admin_confirm_balance). If that check is the newest confirmed one, still
--    ready (fresh, flat, every difference explained or classified, not used by a payout) and its total equals the total being settled, the
--    period counts as reconciled ('verified_manual') and the check's id is saved on the settlement. Before, 1107 accepted only a bot snapshot
--    or a separate written note, so the manual two-month flow (admin_settle_quarter) was refused every time.
--    An internal mismatch or an unmatched Exchange transfer is still refused whatever was confirmed.
-- 2. EACH SETTLEMENT SAVES THE PERIOD'S RESULTS:
--      settlement_lines.period_profit_usdt   each investor's trading profit this period (units held x price moves), before the fee
--      settlements.fund_m->'period'          Fund M's own-investment profit this period, kept apart from the 10% fee it earned
--                                            (fee at this settlement + fees taken at withdrawals during the period) and the growth of fee units
--    admin_settlement_preview returns the same figures before anything is saved.
-- 3. BACKUPS: 1107 replaced 1106's _export_all wrapper, so backups lost the workflow tables (balance_verifications, verification_adjustments,
--    capital_events, payout_records, position_snapshots). The full export is _export_all_core() again and _export_all() = core || _wf_export().

do $$
begin
  if to_regclass('public.settlements') is null or to_regclass('public.balance_verifications') is null or to_regprocedure('public._wf_ready(bigint)') is null then
    raise exception 'preflight: run 20261106000000_capital_workflow.sql and 20261107000000_hwm_bimonthly_settlement.sql first. Nothing was changed.';
  end if;
end $$;

alter table public.settlements add column if not exists balance_verification_id bigint references public.balance_verifications(id);
alter table public.settlement_lines add column if not exists period_profit_usdt numeric;

-- the confirmed manual balance check that verifies a settlement at this exchange total, or null
create or replace function public._verified_balance_check(p_total numeric) returns bigint language plpgsql stable security definer set search_path = public as $$
declare v balance_verifications%rowtype;
begin
  select * into v from balance_verifications where status = 'confirmed' order by id desc limit 1;
  if not found or abs(v.mexc_total - p_total) > _wf_tol(p_total) or not coalesce((_wf_ready(v.id)->>'ok')::boolean, false) then return null; end if;
  return v.id;
end $$;

-- Fund M this period: its own investment's profit (capital account), apart from the fee it earned and the growth of fee units already held
create or replace function public._fund_m_period(p_before jsonb, p_after jsonb, p_fee_settlement numeric, p_fee_withdrawals numeric) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'own_investment_profit_usdt', (p_after->'capital'->>'profit_usdt')::numeric - coalesce((p_before->'capital'->>'profit_usdt')::numeric, 0),
    'fee_at_settlement_usdt', coalesce(p_fee_settlement, 0),
    'fee_at_withdrawals_usdt', coalesce(p_fee_withdrawals, 0),
    'fee_earned_usdt', coalesce(p_fee_settlement, 0) + coalesce(p_fee_withdrawals, 0),
    'own_capital_fee_usdt', (p_after->'fee_entitlement'->>'own_capital_fee_usdt')::numeric - coalesce((p_before->'fee_entitlement'->>'own_capital_fee_usdt')::numeric, 0),
    'fee_units_growth_usdt', (p_after->'fee_entitlement'->>'growth_usdt')::numeric - coalesce((p_before->'fee_entitlement'->>'growth_usdt')::numeric, 0))
$$;

create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record;
  v_lastc timestamptz; v_fee numeric; v_total numeric := 0; v_total_usd numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb;
  v_gap int := coalesce(_setting('min_days_between_closes'), '0')::int; v_res jsonb; v_flag text; v_per record; v_rec jsonb;
  v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_att bigint; v_tol numeric; v_u numeric; v_h numeric; v_e numeric; v_late int; v_fm jsonb;
  v_from bigint; v_bv bigint; v_pp numeric; v_fm0 jsonb; v_period jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_close_quarter'); if v_res is not null then return v_res; end if;
  v_at := _at(p_at); u := _total_units();
  if u = 0 then raise exception 'no units yet'; end if;
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
  perform _settlement_gate(p_equity);
  v_nav := _net_equity(p_equity);
  v_flag := _check_move(v_nav, p_confirm);
  v_price := _price_from(p_equity);
  v_rate := coalesce(p_php_rate, _last_php_rate());
  select id into v_admin from profiles where role = 'admin' limit 1;
  select count(*) into v_late from pool_equity where ts >= v_per.o_end and kind in ('deposit', 'withdrawal');
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', v_nav, u, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;

  -- never finalize fees on an unexplained difference
  v_rec := _settlement_recon(v_eq_id, p_equity, null, v_at);
  if v_mode <> 'off' then
    if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then
      raise exception 'settlement refused, nothing was saved: %', v_rec->'reasons'->>0;
    end if;
    v_bv := _verified_balance_check(p_equity);
    if v_rec->>'status' = 'unverified' and v_bv is not null then
      -- the manager typed this exchange total and then confirmed it as a separate step (balance check), flat and with every difference explained
      v_rec := v_rec || jsonb_build_object('status', 'verified_manual', 'balance_verification_id', v_bv, 'reasons_before', v_rec->'reasons', 'reasons', '[]'::jsonb);
    end if;
    if v_rec->>'status' = 'unverified' then
      v_tol := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, p_equity * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
      select id into v_att from settlement_attestations where period_end = v_per.o_end and abs(mexc_total - p_equity) <= v_tol order by id desc limit 1;
      if v_att is null and v_mode = 'require' then
        raise exception 'RECONCILE: this period is not reconciled with the exchange (%). Enter and confirm this exchange balance (balance check), or explain it with admin_attest_settlement for this exchange total, then settle.',
          (select string_agg(x, '; ') from jsonb_array_elements_text(v_rec->'reasons') x);
      end if;
    end if;
  end if;

  v_from := _last_close(v_eq_id);
  v_fm0 := _fund_m_state(v_from + 1);                               -- Fund M as the previous settlement left it
  for r in select p.id, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_eq_id);                   -- this period's trading profit on the units held, before the fee
    v_u := _units_of(r.id); v_h := _hwm_value(r.id);
    v_e := v_u * v_price;
    v_fee := _hwm_close(r.id, v_price, r.fee_rate, v_eq_id);          -- the live engine: fee above the mark; the mark moves up
    if v_fee > 0 then
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)');
      v_total := v_total + v_fee; v_total_usd := v_total_usd + round(v_fee * v_price, 6); v_n := v_n + 1;
    end if;
    insert into settlement_lines(equity_id, profile_id, units_before, unit_price, value_before, hwm_before, eligible_profit, fee_rate, fee_units, fee_usdt, hwm_after, period_profit_usdt)
    values (v_eq_id, r.id, v_u, v_price, v_e, v_h, v_e - v_h, r.fee_rate, v_fee, round(v_fee * v_price, 6), _hwm_value(r.id), v_pp);
  end loop;
  v_fm := _fund_m_state(v_eq_id + 1);
  v_period := _fund_m_period(v_fm0, v_fm, v_total_usd, (v_rec->>'fees_at_withdrawals_usdt')::numeric);
  v_fm := v_fm || jsonb_build_object('period', v_period);
  insert into settlements(equity_id, period_start, period_end, valued_at, mexc_total, nav, total_units, unit_price, opening_nav, deposits_usdt,
      withdrawals_usdt, trading_pnl_usdt, entries_after_period_end, fee_basis, investors_charged, fee_units, fee_usdt, fund_m, recon, recon_status, attestation_id, created_by, balance_verification_id)
  values (v_eq_id, v_per.o_start, v_per.o_end, v_at, p_equity, v_nav, u, v_price, (v_rec->>'opening_nav')::numeric, (v_rec->>'deposits_usdt')::numeric,
      (v_rec->>'withdrawals_usdt')::numeric, (v_rec->>'trading_pnl_usdt')::numeric, v_late, coalesce(_setting('fee_basis'), 'external_investors'), v_n, v_total, v_total_usd,
      v_fm, v_rec, v_rec->>'status', v_att, v_actor, v_bv);
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);       -- waiting money joins after the fees, at the settlement price
  perform _check_books();
  return _idem_put(p_idem, 'admin_close_quarter', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'fee_usdt', v_total_usd,
    'converted', v_conv->'converted', 'settlement_id', currval('settlements_id_seq'), 'period_start', v_per.o_start, 'period_end', v_per.o_end,
    'recon_status', v_rec->>'status', 'attestation_id', v_att, 'balance_verification_id', v_bv, 'fund_m_period', v_period), v_actor);
end $$;

create or replace function public.admin_settlement_preview(p_token text, p_equity numeric, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_at timestamptz := coalesce(p_at, now()); v_per record; v_price numeric; v_nav numeric; v_rec jsonb; v_lines jsonb := '[]'::jsonb; r record; v_u numeric; v_h numeric;
  v_e numeric; v_fee numeric; v_tot numeric := 0; v_totu numeric := 0; v_block jsonb := '[]'::jsonb; v_lastc timestamptz; v_tol numeric;
  v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_last pool_equity%rowtype;
  v_bv bigint; v_from bigint; v_fm0 jsonb; v_fm jsonb; v_pp numeric;
begin
  perform _admin(p_token);
  if _total_units() = 0 then raise exception 'no units yet'; end if;
  v_nav := _net_equity(p_equity); v_price := _price_from(p_equity);
  select * into v_per from _settlement_period(v_at);
  select * into v_last from pool_equity order by id desc limit 1;
  select max(ts) into v_lastc from pool_equity where kind = 'close';
  if v_per.o_end <= (select min(ts) from pool_equity) then v_block := v_block || to_jsonb('no settlement period has ended yet'::text); end if;
  if v_at < v_last.ts then v_block := v_block || to_jsonb(format('the date must be after the last entry (%s)', v_last.ts)); end if;
  if coalesce(_setting('settlement_schedule'), 'bimonthly') = 'bimonthly' and v_lastc is not null and v_lastc >= v_per.o_end then
    v_block := v_block || to_jsonb(format('the period ending %s is already settled; next from %s', (v_per.o_end at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date - 1,
      (v_per.o_next at time zone coalesce(_setting('settlement_tz'), 'Asia/Manila'))::date));
  end if;
  v_rec := _settlement_recon(v_last.id, p_equity, v_price, v_at);
  v_bv := _verified_balance_check(p_equity);
  if v_rec->>'status' = 'unverified' and v_bv is not null then
    v_rec := v_rec || jsonb_build_object('status', 'verified_manual', 'balance_verification_id', v_bv, 'reasons_before', v_rec->'reasons', 'reasons', '[]'::jsonb);
  end if;
  if v_mode <> 'off' then
    if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then v_block := v_block || (v_rec->'reasons');
    elsif v_rec->>'status' = 'unverified' and v_mode = 'require' then
      v_tol := greatest(coalesce(_setting('recon_tolerance_abs'), '0.5')::numeric, p_equity * coalesce(_setting('recon_tolerance_pct'), '0.0005')::numeric);
      if not exists (select 1 from settlement_attestations where period_end = v_per.o_end and abs(mexc_total - p_equity) <= v_tol) then
        v_block := v_block || to_jsonb('needs a written explanation (admin_attest_settlement): '::text || (select string_agg(x, '; ') from jsonb_array_elements_text(v_rec->'reasons') x));
      end if;
    end if;
  end if;
  v_from := _last_close(v_last.id + 1);
  for r in select p.id, p.name, p.username, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_last.id, v_price);
    v_u := _units_of(r.id); v_h := _hwm_value(r.id);
    v_e := v_u * v_price;
    v_fee := _fee_units(r.fee_rate, v_e - v_h, 1, 1, v_price);
    v_tot := v_tot + round(v_fee * v_price, 6); v_totu := v_totu + v_fee;
    v_lines := v_lines || jsonb_build_object('profile_id', r.id, 'name', r.name, 'username', r.username, 'units', v_u, 'value_usdt', v_e, 'period_profit_usdt', v_pp,
      'hwm_usdt', v_h, 'eligible_profit_usdt', v_e - v_h, 'fee_rate', r.fee_rate, 'fee_units', v_fee, 'fee_usdt', round(v_fee * v_price, 6),
      'value_after_usdt', v_e - v_fee * v_price, 'hwm_after_usdt', case when v_e > v_h then v_e - v_fee * v_price else v_h end);
  end loop;
  v_fm0 := _fund_m_state(v_from + 1);
  v_fm := _fund_m_state(null);
  v_fm := jsonb_set(jsonb_set(v_fm, '{capital,value_usdt}', to_jsonb((v_fm->'capital'->>'units')::numeric * v_price)),   -- at the price being previewed
                    '{capital,profit_usdt}', to_jsonb((v_fm->'capital'->>'units')::numeric * v_price + (v_fm->'capital'->>'withdrawn_usdt')::numeric - (v_fm->'capital'->>'contributed_usdt')::numeric));
  return jsonb_build_object('balance_verification_id', v_bv, 'can_settle', jsonb_array_length(v_block) = 0, 'blocked_reasons', v_block,
    'period_start', v_per.o_start, 'period_end', v_per.o_end, 'next_period_end', v_per.o_next, 'valued_at', v_at,
    'mexc_total', p_equity, 'nav', v_nav, 'unit_price', v_price, 'total_units', _total_units(),
    'fee_basis', coalesce(_setting('fee_basis'), 'external_investors'), 'fee_usdt', v_tot, 'fee_units', v_totu, 'lines', v_lines,
    'recon', v_rec, 'fund_m', v_fm || jsonb_build_object('period', _fund_m_period(v_fm0, v_fm, v_tot, (v_rec->>'fees_at_withdrawals_usdt')::numeric)),
    'waiting_deposits_admitted_after', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profile_id', profile_id, 'usdt', usdt))
       from pending_deposits where status = 'pending' and (arrived_at is not null or coalesce(_setting('settlement_gate'), 'off') <> 'on')), '[]'::jsonb));
end $$;

create or replace function public._export_all_core() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'format', 'lucid-io-ledger-backup-1',
    'exported_at', now(),
    'people', (select coalesce(jsonb_agg(to_jsonb(p) - 'pass_hash' - 'failed_attempts' - 'locked_until' order by p.created_at, p.id), '[]'::jsonb) from profiles p),
    'pool_equity', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id), '[]'::jsonb) from pool_equity e),
    'ledger', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) from ledger l),
    'pending_deposits', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) from pending_deposits d),
    'withdrawal_requests', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) from withdrawal_requests r),
    'holder_lots', (select coalesce(jsonb_agg(to_jsonb(h) order by h.id), '[]'::jsonb) from holder_lots h),
    'lot_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from lot_log g),
    'investor_period', (select coalesce(jsonb_agg(to_jsonb(f) order by f.profile_id), '[]'::jsonb) from investor_period f),
    'period_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from period_log g),
    'corrections', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]'::jsonb) from corrections c),
    'exchange_snapshots', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from exchange_snapshots s),
    'exchange_transfers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from exchange_transfers t),
    'transfer_matches', (select coalesce(jsonb_agg(to_jsonb(m) order by m.transfer_id), '[]'::jsonb) from transfer_matches m),
    'snapshot_attestations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from snapshot_attestations a),
    'investor_hwm', (select coalesce(jsonb_agg(to_jsonb(h) order by h.profile_id), '[]'::jsonb) from investor_hwm h),
    'hwm_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.id), '[]'::jsonb) from hwm_log g),
    'settlements', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from settlements s),
    'settlement_lines', (select coalesce(jsonb_agg(to_jsonb(l) order by l.equity_id, l.profile_id), '[]'::jsonb) from settlement_lines l),
    'settlement_attestations', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from settlement_attestations a),
    'terms_acceptances', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from terms_acceptances t),
    'settings', (select coalesce(jsonb_agg(to_jsonb(s) order by s.key), '[]'::jsonb) from ledger_settings s where s.key not in ('bot_key_hash')),
    'audit_log', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb) from audit_log a),
    'checks', jsonb_build_object(
      'people', (select count(*) from profiles), 'ledger_rows', (select count(*) from ledger), 'equity_rows', (select count(*) from pool_equity),
      'total_units_ledger', (select coalesce(sum(units), 0) from ledger),
      'total_units_last_reading', (select total_units from pool_equity order by id desc limit 1),
      'lots_units', (select coalesce(sum(units), 0) from ledger),
      'fee_engine', (select value from ledger_settings where key = 'fee_engine'),
      'last_equity_usdt', (select equity_usdt from pool_equity order by id desc limit 1),
      'waiting_usdt', (select coalesce(sum(usdt), 0) from pending_deposits where status = 'pending'),
      'settlements', (select count(*) from settlements)))
$$;

create or replace function public._export_all() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_all_core() || _wf_export()
$$;

revoke all on function public._verified_balance_check(numeric), public._fund_m_period(jsonb, jsonb, numeric, numeric), public._export_all_core()
  from public, anon, authenticated;
revoke all on function public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean), public.admin_settlement_preview(text, numeric, timestamptz) from public;
grant execute on function public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean), public.admin_settlement_preview(text, numeric, timestamptz)
  to anon, authenticated;

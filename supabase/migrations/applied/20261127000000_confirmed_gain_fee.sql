-- CONFIRMED-GAIN PERFORMANCE FEE (fees one settlement late, on the lower reading) + settling while trades are open.
-- Run after 20261109000000_settlement_controls_backup.sql. NOT applied to any database yet. Safe to run twice. Read docs/confirmed-gain-fee.md.
--
--  1  A settlement charges only the gain that is still there at the NEXT settlement: fee = rate × max(0, min(E, L) − H), where
--     E = value now, L = value right after the previous settlement, H = the mark. A gain that reverses before then is never charged.
--  2  Money that leaves pays at once: a withdrawal of share s pays s × (rate_confirmed × confirmed gain + rate_now × pending gain).
--  3  The mark: H := min(E, L) − fee when that is higher (USDT, like 1105's H := value − fee). Deposits: H += D and L += D.
--     A 0% rate still moves the mark up, so gains made at 0% are never charged later (same as 1105).
--  4  Rate changes: a confirmed gain was earned before the previous settlement, so it is charged at min(rate then, rate now).
--  5  Open trades no longer block a settlement (a warning instead): the fee only reaches gains that held through a whole period.
--  fee_timing = 'confirmed' (this file) or 'immediate' (1105's rule, kept selectable). Both keep L up to date, so switching is safe.
--  Cutover: L := H. Nobody is charged at the first settlement after this file (no gain is confirmed yet); the manager's fee for
--  the current period arrives one settlement later. No ledger row, unit or mark is changed.

do $$
begin
  if coalesce((select value from public.ledger_settings where key = 'fee_engine'), '') <> 'investor_hwm_v2' then
    raise exception 'preflight: fee_engine must be investor_hwm_v2 (run 20261105000000_hwm_arrival_lockup.sql). Nothing was changed.';
  end if;
  if to_regprocedure('public._settlement_requirements(numeric,timestamptz,jsonb)') is null then
    raise exception 'preflight: run 20261109000000_settlement_controls_backup.sql first. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. settings and columns
insert into public.ledger_settings(key, value) values ('fee_timing', 'confirmed') on conflict (key) do nothing;
-- 'require': admin_close_quarter / admin_settle_quarter refuse unless the caller passes the hash of a preview of the CURRENT books (see _settlement_fingerprint).
-- 'off' (default): no preview is needed, exactly as before. Turn it on once the app that sends the hash is live.
insert into public.ledger_settings(key, value) values ('settlement_preview_mode', 'off') on conflict (key) do nothing;

alter table public.investor_hwm add column if not exists last_value numeric check (last_value >= 0);         -- L (USDT)
alter table public.investor_hwm add column if not exists rate_last numeric check (rate_last >= 0 and rate_last <= 1);   -- rate in force up to the last settlement
alter table public.hwm_log add column if not exists last_before numeric;
alter table public.hwm_log add column if not exists rate_before numeric;
alter table public.settlement_lines add column if not exists fee_timing text;
alter table public.settlement_lines add column if not exists last_value_before numeric;
alter table public.settlement_lines add column if not exists confirmed_profit numeric;
alter table public.settlement_lines add column if not exists pending_profit numeric;
alter table public.settlement_lines add column if not exists rate_applied numeric;
alter table public.settlement_lines add column if not exists last_value_after numeric;

-- cutover: the last settlement level is the mark (fee-equivalent to the true level, which is never above the mark right after a close)
update public.investor_hwm h set last_value = h.hwm_value, rate_last = p.fee_rate
  from public.profiles p where p.id = h.profile_id and h.last_value is null;

create or replace function public._fee_timing() returns text language sql stable security definer set search_path = public as $$
  select case when _setting('fee_timing') = 'confirmed' then 'confirmed' else 'immediate' end
$$;

-- ---------------------------------------------------------------- 2. the mark, with L and the rate
create or replace function public._hwm_log(p_eq bigint, p uuid) returns void language plpgsql security definer set search_path = public as $$
declare v investor_hwm%rowtype;
begin
  select * into v from investor_hwm where profile_id = p;
  insert into hwm_log(equity_id, profile_id, existed, hwm_before, last_before, rate_before) values (p_eq, p, found, v.hwm_value, v.last_value, v.rate_last);
end $$;

-- a deposit is not profit: the mark and the last settlement level both rise by it. Coming in with no units: the current rate applies.
create or replace function public._hwm_deposit(p uuid, p_usdt numeric, p_eq bigint) returns void language plpgsql security definer set search_path = public as $$
declare v_rate numeric; v_fresh boolean;
begin
  if not exists (select 1 from profiles where id = p and role = 'investor') then return; end if;
  select fee_rate into v_rate from profiles where id = p;
  v_fresh := _units_of(p) - (select coalesce(sum(units), 0) from ledger where equity_id = p_eq and profile_id = p) <= 0.00000001;
  perform _hwm_log(p_eq, p);
  insert into investor_hwm(profile_id, hwm_value, last_value, rate_last) values (p, p_usdt, p_usdt, v_rate)
  on conflict (profile_id) do update set hwm_value = investor_hwm.hwm_value + p_usdt,
    last_value = coalesce(investor_hwm.last_value, investor_hwm.hwm_value) + p_usdt,
    rate_last = case when v_fresh then v_rate else coalesce(investor_hwm.rate_last, v_rate) end, updated_at = now();
end $$;

-- taking p_units out: the redeemed share pays on its confirmed AND pending gain now. p_eq null = preview (nothing is written).
create or replace function public._hwm_take(p uuid, p_units numeric, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_u numeric := _units_of(p); v investor_hwm%rowtype; v_h numeric; v_l numeric; v_e numeric; v_share numeric; v_fee numeric;
  v_conf numeric; v_pend numeric;
begin
  if v_u <= 0 or not exists (select 1 from profiles where id = p and role = 'investor') then return 0; end if;
  if p_units > v_u + 0.000001 then raise exception 'internal: holdings are short by % units', p_units - v_u; end if;
  select * into v from investor_hwm where profile_id = p;
  v_h := _hwm_value(p); v_l := coalesce(v.last_value, v_h); v_e := v_u * p_price; v_share := least(1, p_units / v_u);
  if _fee_timing() = 'confirmed' then
    v_conf := greatest(0, least(v_e, v_l) - v_h);                 -- held through the last settlement: charged at the lower rate
    v_pend := greatest(0, v_e - greatest(v_l, v_h));              -- made since: charged at today's rate
    v_fee := _fee_units(1, least(coalesce(v.rate_last, p_rate), p_rate) * v_conf + p_rate * v_pend, least(p_units, v_u), v_u, p_price);
  else
    v_fee := _fee_units(p_rate, v_e - v_h, least(p_units, v_u), v_u, p_price);
  end if;
  if p_eq is not null then
    perform _hwm_log(p_eq, p);
    update investor_hwm set hwm_value = greatest(0, v_h - v_share * least(v_e, v_h)),
      last_value = greatest(0, case when v_e > v_h then v_l * (1 - v_share) else v_l - v_share * least(v_e, v_l) end),
      updated_at = now() where profile_id = p;
  end if;
  return v_fee;
end $$;

-- what a settlement at p_price does to one investor; writes nothing (used by the settlement and by its preview, so they agree)
create or replace function public._hwm_settle_calc(p uuid, p_price numeric, p_rate numeric,
    out o_units numeric, out o_value numeric, out o_hwm numeric, out o_last numeric, out o_rate numeric,
    out o_confirmed numeric, out o_pending numeric, out o_fee numeric, out o_hwm_after numeric, out o_last_after numeric)
language plpgsql stable security definer set search_path = public as $$
declare v investor_hwm%rowtype; v_base numeric;
begin
  o_units := _units_of(p); o_value := o_units * p_price; o_fee := 0;
  select * into v from investor_hwm where profile_id = p;
  o_hwm := _hwm_value(p); o_last := coalesce(v.last_value, o_hwm);
  if _fee_timing() = 'confirmed' then
    v_base := least(o_value, o_last);
    o_rate := least(coalesce(v.rate_last, p_rate), p_rate);
    o_confirmed := greatest(0, v_base - o_hwm); o_pending := greatest(0, o_value - greatest(o_last, o_hwm));
    o_fee := case when o_units > 0 then _fee_units(o_rate, o_confirmed, 1, 1, p_price) else 0 end;
    o_hwm_after := case when v_base > o_hwm then v_base - o_fee * p_price else o_hwm end;
  else
    o_rate := p_rate; o_confirmed := greatest(0, o_value - o_hwm); o_pending := 0;
    o_fee := case when o_units > 0 then _fee_units(p_rate, o_value - o_hwm, 1, 1, p_price) else 0 end;
    o_hwm_after := case when o_value > o_hwm then (o_units - o_fee) * p_price else o_hwm end;
  end if;
  o_last_after := o_value - o_fee * p_price;
end $$;

-- settlement for one investor: fee on the confirmed gain; the mark, L and the rate move on (always logged, so L is exact after an undo)
create or replace function public._hwm_close(p uuid, p_price numeric, p_rate numeric, p_eq bigint) returns numeric
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from _hwm_settle_calc(p, p_price, p_rate);
  if c.o_units <= 0 then return 0; end if;
  perform _hwm_log(p_eq, p);
  update investor_hwm set hwm_value = greatest(0, c.o_hwm_after), last_value = greatest(0, c.o_last_after), rate_last = p_rate, updated_at = now()
   where profile_id = p;
  return c.o_fee;
end $$;

create or replace function public._hwm_revert(p_eq bigint) returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select * from hwm_log where equity_id = p_eq and reverted_at is null order by id desc loop
    if r.existed then
      update investor_hwm set hwm_value = r.hwm_before, last_value = coalesce(r.last_before, r.hwm_before), rate_last = coalesce(r.rate_before, rate_last), updated_at = now()
       where profile_id = r.profile_id;
    else delete from investor_hwm where profile_id = r.profile_id; end if;
    update hwm_log set reverted_at = now() where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------- 2b. what the app shows: the accrued fee is the authoritative calculation
-- Before: accrued_fee_usdt = rate x (value - mark), the old rule. It ignored the confirmed-gain rule and the rate-change rule, so it could disagree with what a
-- withdrawal or settlement then charges. Now it is _hwm_take(...) in preview mode (nothing written): the fee a FULL EXIT would charge right now, by the very
-- function the real withdrawal calls. Under fee_timing 'immediate' that equals the old figure. (Body = 1105's _holder_summary; only v_acc changed.)
create or replace function public._holder_summary(p uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pr profiles%rowtype; v_price numeric := _price_now(); v_tu numeric := _total_units();
  v_units numeric; v_dep numeric; v_wd numeric; v_feein numeric; v_hwm numeric; v_hv numeric; v_lots jsonb;
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
  v_val := v_units * v_price;
  v_hv := case when pr.role = 'investor' then coalesce((select hwm_value from investor_hwm where profile_id = p), v_val) else v_val end;
  v_hwm := case when v_units > 0 then v_hv / v_units else v_price end;         -- the mark as a unit price
  v_lots := case when v_units > 0 then jsonb_build_array(jsonb_build_array(v_units, v_hwm)) else '[]'::jsonb end;
  v_profit := v_val + v_wd - v_dep;
  v_acc := case when pr.role = 'investor' then _hwm_take(p, v_units, v_price, pr.fee_rate, null) * v_price else 0 end;   -- what leaving now would charge (units x price)
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
    'period_profit_usdt', v_val - v_hv,
    'hwm', v_hwm, 'hwm_value', v_hv, 'below_hwm_usdt', greatest(0, v_hv - v_val), 'lots', v_lots,
    'accrued_fee_usdt', v_acc, 'accrued_fee_rule', _fee_timing(), 'value_after_fee_usdt', v_net,
    'fee_paid_units', v_feeu, 'fee_paid_usdt', v_feeusd, 'profit_share_usdt', v_share,
    'gross_value_usdt', v_gross, 'gross_profit_usdt', v_gross + v_wd - v_dep,
    'gross_return_pct', case when v_dep > 0 then (v_gross + v_wd - v_dep) / v_dep end,
    'net_value_usdt', v_net, 'net_profit_usdt', v_net + v_wd - v_dep,
    'net_return_pct', case when v_dep > 0 then (v_net + v_wd - v_dep) / v_dep end,
    'profit_share_pct_points', case when v_dep > 0 then v_share / v_dep end,
    'share_pct', case when v_tu > 0 then v_units / v_tu end,
    'fee_units_earned', v_feein, 'fee_units_value_usdt', v_feein * v_price,
    'unlocked_units', v_unl, 'next_unlock', v_next, 'lock_until', v_last, 'lock_enforced', coalesce(_setting('lock_enforced'), '0') = '1',
    'php_rate', _last_php_rate());
end $$;

-- ---------------------------------------------------------------- 2c. a settlement may only act on a preview of the books as they are NOW
-- The fingerprint is a hash of everything a settlement's fees depend on: the newest pool entry, total units, every investor's units / mark / last value / rates,
-- the waiting deposits, the fee rule, the exchange total and the settlement period. admin_settlement_preview returns it; admin_close_quarter (and the workflow's
-- admin_settle_quarter) recompute it INSIDE the settlement's own transaction, under the ledger lock, and refuse if it differs. So a deposit, a payout, a rate change
-- or a different balance between the preview and the click makes the old preview useless: no browser check is needed, and none can be skipped.
-- It is state binding, not authentication (the manager's session already authenticates). It does not expire by time: it expires when the books change.
create or replace function public._settlement_fingerprint(p_equity numeric, p_at timestamptz) returns text language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(concat_ws('|',
    coalesce((select max(id) from pool_equity), 0)::text, _total_units()::text, trim_scale(p_equity)::text,
    (select o_end from _settlement_period(coalesce(p_at, now())))::text, _fee_timing(),
    coalesce((select string_agg(concat_ws(',', p.id, _units_of(p.id), coalesce(h.hwm_value, -1), coalesce(h.last_value, -1), coalesce(h.rate_last, -1), p.fee_rate, coalesce(p.fee_rate_next, -1)), ';' order by p.id)
                from profiles p left join investor_hwm h on h.profile_id = p.id where p.role = 'investor'), ''),
    coalesce((select string_agg(concat_ws(',', d.id, d.usdt, coalesce(d.arrived_at::text, '-')), ';' order by d.id) from pending_deposits d where d.status = 'pending'), ''),
    coalesce(_setting('settlement_gate'), 'off'), coalesce(_setting('settlement_schedule'), 'bimonthly')), 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------- 3. open trades: a warning, not a block, when fees are confirmed-only
-- (1109's body; only the open-trades step changed, and the result carries 'warnings')
create or replace function public._settlement_requirements(p_equity numeric, p_at timestamptz, p_rec jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_per record; v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_sched text := coalesce(_setting('settlement_schedule'), 'bimonthly');
  v_win int := coalesce(nullif(_setting('settlement_window_days'), '')::int, 7); v_tz text := coalesce(_setting('settlement_tz'), 'Asia/Manila');
  v_block jsonb := '[]'::jsonb; v_warn jsonb := '[]'::jsonb; v_ids bigint[] := '{}'; v_rec jsonb := p_rec; v_win_end timestamptz; v_late boolean := false; v_x bigint;
  v_chk record; v_bv bigint; v_att bigint; v_open int; v_now timestamptz := _clock(); v_back boolean := false;
begin
  select * into v_per from _settlement_period(p_at);
  if v_sched = 'bimonthly' then
    v_back := p_at < v_now - make_interval(mins => coalesce(nullif(_setting('settlement_backdate_minutes'), '')::int, 60));
    if v_back then
      v_x := _settlement_exception('backdated', v_per.o_end, p_equity);
      if v_x is null then
        v_block := v_block || to_jsonb(format('BACKDATED: this settlement is dated %s but is being recorded %s hours later. A settlement carries the date it is recorded, so a late settlement cannot be dated into the window. Record it now (leave the date empty), or approve a backdated exception with a written reason.',
          to_char(p_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'), round(extract(epoch from v_now - p_at) / 3600, 1)));
      else v_ids := v_ids || v_x; end if;
    end if;
    v_win_end := v_per.o_end + make_interval(days => v_win);
    v_late := greatest(p_at, v_now) >= v_win_end;
    if v_late then
      v_x := _settlement_exception('late', v_per.o_end, p_equity);
      if v_x is null then
        v_block := v_block || to_jsonb(format('LATE: the settlement window for the period ending %s closed on %s. Settle in the next window (from %s): it covers everything since the last settlement. Or approve a late exception with a written reason.',
          (v_per.o_end at time zone v_tz)::date - 1, (v_win_end at time zone v_tz)::date - 1, (v_per.o_next at time zone v_tz)::date));
      else v_ids := v_ids || v_x; end if;
    end if;
  end if;
  if v_mode <> 'off' then
    if v_rec->>'status' in ('internal_mismatch', 'unmatched_transfers') then
      v_block := v_block || to_jsonb('settlement refused, nothing was saved: ' || coalesce(v_rec->'reasons'->>0, v_rec->>'status'));
    else
      select * into v_chk from _settlement_check(p_equity);
      if v_rec->>'status' = 'unverified' and v_chk.o_id is not null then
        v_rec := v_rec || jsonb_build_object('status', 'verified_manual', 'balance_verification_id', v_chk.o_id, 'reasons_before', v_rec->'reasons', 'reasons', '[]'::jsonb);
      end if;
      if v_rec->>'status' = 'verified_manual' then
        v_bv := v_chk.o_id; v_open := v_chk.o_open;
      elsif v_rec->>'status' = 'verified' then
        v_open := coalesce((v_rec->'last_snapshot'->>'open_positions')::int, 0) + coalesce((v_rec->'last_snapshot'->>'open_orders')::int, 0);
      else
        v_x := _settlement_exception('unreconciled', v_per.o_end, p_equity);
        if v_x is null then
          v_block := v_block || to_jsonb('RECONCILE: this period is not reconciled with the exchange (' || coalesce((select string_agg(r, '; ') from jsonb_array_elements_text(v_rec->'reasons') r), 'no verification')
            || '). Enter and confirm this exchange balance (balance check), or approve an exception for this exchange total (admin_approve_settlement_exception) with a written reason and the open positions declared.');
        else
          select open_positions, attestation_id into v_open, v_att from settlement_exceptions where id = v_x;
          v_ids := v_ids || v_x;
          if v_open is null then
            v_block := v_block || to_jsonb('OPEN TRADES: say how many positions and orders are open on the exchange (declare them in the exception: admin_approve_settlement_exception).'::text);
          end if;
        end if;
      end if;
      if coalesce(v_open, 0) > 0 then
        if _fee_timing() = 'confirmed' then
          v_warn := v_warn || to_jsonb(format('OPEN TRADES: %s position(s)/order(s) are open, so the balance includes gains that are not realized yet. That is allowed: this settlement only charges gains that were already there at the previous settlement and are still there now.', v_open));
        else
          v_x := _settlement_exception('open_positions', v_per.o_end, p_equity);
          if v_x is null then
            v_block := v_block || to_jsonb(format('OPEN TRADES: %s position(s)/order(s) are open on the exchange, so the balance includes gains that are not realized yet. Close them and settle, or approve an open_positions exception with a written reason.', v_open));
          else v_ids := v_ids || v_x; end if;
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('blocked', v_block, 'warnings', v_warn, 'late', v_late, 'backdated', v_back, 'recorded_at', v_now, 'window_end', v_win_end, 'period_end', v_per.o_end, 'bv', v_bv, 'att', v_att,
                            'open_positions', v_open, 'exception_ids', to_jsonb(v_ids), 'rec', v_rec);
end $$;

-- ---------------------------------------------------------------- 4. the settlement (1109's body; the investor loop records the confirmed gain)
-- The signature gains one trailing optional argument (p_preview), so the old 7-argument signature is dropped first (two overloads would make named calls ambiguous).
-- Positional calls with 7 arguments (the workflow's admin_settle_quarter / admin_quote_close) keep working: p_preview defaults to null.
drop function if exists public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean);
create or replace function public.admin_close_quarter(p_token text, p_equity numeric, p_php_rate numeric default null, p_note text default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false, p_preview text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_at timestamptz; u numeric; v_price numeric; v_nav numeric; v_eq_id bigint; v_admin uuid; r record;
  v_lastc timestamptz; v_fee numeric; v_total numeric := 0; v_total_usd numeric := 0; v_n int := 0; v_rate numeric; v_conv jsonb;
  v_gap int := coalesce(_setting('min_days_between_closes'), '0')::int; v_res jsonb; v_flag text; v_per record; v_rec jsonb;
  v_mode text := coalesce(_setting('settlement_recon'), 'require'); v_att bigint; v_late int; v_fm jsonb; c record;
  v_from bigint; v_bv bigint; v_pp numeric; v_fm0 jsonb; v_period jsonb; v_req jsonb; v_cfrom timestamptz; v_ids bigint[]; v_open int; v_now timestamptz := _clock();
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_close_quarter'); if v_res is not null then return v_res; end if;
  -- the fresh-preview rule, enforced here, atomically: nothing below has written anything yet, and the ledger lock is held, so the books cannot change
  -- between this comparison and the settlement. (A quote inside the workflow's rolled-back sub-transaction is exempt: it saves nothing.)
  if coalesce(_setting('settlement_preview_mode'), 'off') = 'require' and coalesce(current_setting('ledger.wf_ctx', true), '') <> 'quote' then
    if p_preview is null or length(p_preview) = 0 then
      raise exception 'PREVIEW REQUIRED: a settlement is only allowed on a preview of the current books. Press Preview settlement, check the figures, then settle.';
    end if;
    if p_preview <> _settlement_fingerprint(p_equity, p_at) then
      raise exception 'STALE PREVIEW: the books, the balance or the date changed since that preview (a deposit, a payout, a rate change, another settlement). Nothing was saved. Preview again and check the new figures.';
    end if;
  end if;
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
  perform set_config('ledger.settle_ctx', '1', true);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'close', v_nav, u, v_price, v_rate, nullif(coalesce(p_note, '') || v_flag, ''), v_actor) returning id into v_eq_id;
  perform set_config('ledger.settle_ctx', '', true);

  v_rec := _settlement_recon(v_eq_id, p_equity, null, v_at);
  v_req := _settlement_requirements(p_equity, v_at, v_rec);
  if jsonb_array_length(v_req->'blocked') > 0 then raise exception '%', v_req->'blocked'->>0; end if;
  v_rec := v_req->'rec';
  v_bv := nullif(v_req->>'bv', '')::bigint; v_att := nullif(v_req->>'att', '')::bigint; v_open := nullif(v_req->>'open_positions', '')::int;
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
      values (v_at, r.id,    'fee_out', -v_fee, -round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)'),
             (v_at, v_admin, 'fee_in',   v_fee,  round(v_fee * v_price, 6), v_price, v_rate, v_eq_id, 'performance fee (settlement)');
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
  values (v_eq_id, v_per.o_start, v_per.o_end, v_at, p_equity, v_nav, u, v_price, (v_rec->>'opening_nav')::numeric, (v_rec->>'deposits_usdt')::numeric,
      (v_rec->>'withdrawals_usdt')::numeric, (v_rec->>'trading_pnl_usdt')::numeric, v_late, coalesce(_setting('fee_basis'), 'external_investors'), v_n, v_total, v_total_usd,
      v_fm, v_rec, v_rec->>'status', v_att, v_actor,
      v_bv, v_cfrom, v_at, round(extract(epoch from v_at - v_per.o_end) / 86400, 3), (v_req->>'late')::boolean,
      round(greatest(0, extract(epoch from v_now - v_at) / 86400)::numeric, 3), v_ids, v_open, v_now, coalesce((v_req->>'backdated')::boolean, false));
  update profiles set fee_rate = fee_rate_next, fee_rate_next = null where fee_rate_next is not null;
  v_conv := _convert_all_pending(v_price, v_at, v_actor);
  perform _check_books();
  perform _audit(v_actor, 'settlement_closed', null, jsonb_build_object('settlement_id', currval('settlements_id_seq'), 'equity_id', v_eq_id, 'period_end', v_per.o_end,
    'covered_from', v_cfrom, 'covered_to', v_at, 'recorded_at', v_now, 'late', (v_req->>'late')::boolean, 'backdated', coalesce((v_req->>'backdated')::boolean, false), 'recon_status', v_rec->>'status', 'balance_verification_id', v_bv,
    'exception_ids', v_ids, 'open_positions', v_open, 'investors_charged', v_n, 'fee_usdt', v_total_usd, 'mexc_total', p_equity, 'fee_timing', _fee_timing(), 'warnings', v_req->'warnings'));
  return _idem_put(p_idem, 'admin_close_quarter', jsonb_build_object('unit_price', v_price, 'investors_charged', v_n, 'fee_units', v_total, 'fee_usdt', v_total_usd,
    'converted', v_conv->'converted', 'settlement_id', currval('settlements_id_seq'), 'period_start', v_per.o_start, 'period_end', v_per.o_end,
    'covered_from', v_cfrom, 'covered_to', v_at, 'recorded_at', v_now, 'late', (v_req->>'late')::boolean, 'backdated', coalesce((v_req->>'backdated')::boolean, false), 'exception_ids', to_jsonb(v_ids),
    'recon_status', v_rec->>'status', 'attestation_id', v_att, 'balance_verification_id', v_bv, 'fund_m_period', v_period,
    'fee_timing', _fee_timing(), 'warnings', v_req->'warnings'), v_actor);
end $$;

create or replace function public.admin_settlement_preview(p_token text, p_equity numeric, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_at timestamptz := coalesce(p_at, now()); v_per record; v_price numeric; v_nav numeric; v_rec jsonb; v_lines jsonb := '[]'::jsonb; r record; c record;
  v_fee numeric; v_tot numeric := 0; v_totu numeric := 0; v_block jsonb := '[]'::jsonb; v_lastc timestamptz; v_last pool_equity%rowtype;
  v_from bigint; v_fm0 jsonb; v_fm jsonb; v_pp numeric; v_req jsonb;
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
  v_req := _settlement_requirements(p_equity, v_at, v_rec);
  v_rec := v_req->'rec';
  v_block := v_block || (v_req->'blocked');
  v_from := _last_close(v_last.id + 1);
  for r in select p.id, p.name, p.username, p.fee_rate from profiles p where p.role = 'investor' and _units_of(p.id) > 0 order by p.created_at, p.id loop
    v_pp := _period_profit(r.id, v_from, v_last.id, v_price);
    select * into c from _hwm_settle_calc(r.id, v_price, r.fee_rate);
    v_fee := c.o_fee;
    v_tot := v_tot + round(v_fee * v_price, 6); v_totu := v_totu + v_fee;
    v_lines := v_lines || jsonb_build_object('profile_id', r.id, 'name', r.name, 'username', r.username, 'units', c.o_units, 'value_usdt', c.o_value, 'period_profit_usdt', v_pp,
      'hwm_usdt', c.o_hwm, 'eligible_profit_usdt', c.o_value - c.o_hwm, 'fee_rate', r.fee_rate, 'fee_units', v_fee, 'fee_usdt', round(v_fee * v_price, 6),
      'value_after_usdt', c.o_value - v_fee * v_price, 'hwm_after_usdt', c.o_hwm_after,
      'last_value_usdt', c.o_last, 'confirmed_profit_usdt', c.o_confirmed, 'pending_profit_usdt', c.o_pending, 'rate_applied', c.o_rate, 'last_value_after_usdt', c.o_last_after);
  end loop;
  v_fm0 := _fund_m_state(v_from + 1);
  v_fm := _fund_m_state(null);
  v_fm := jsonb_set(jsonb_set(v_fm, '{capital,value_usdt}', to_jsonb((v_fm->'capital'->>'units')::numeric * v_price)),
                    '{capital,profit_usdt}', to_jsonb((v_fm->'capital'->>'units')::numeric * v_price + (v_fm->'capital'->>'withdrawn_usdt')::numeric - (v_fm->'capital'->>'contributed_usdt')::numeric));
  return jsonb_build_object('balance_verification_id', nullif(v_req->>'bv', '')::bigint, 'can_settle', jsonb_array_length(v_block) = 0, 'blocked_reasons', v_block,
    'warnings', v_req->'warnings', 'fee_timing', _fee_timing(), 'preview_hash', _settlement_fingerprint(p_equity, p_at), 'preview_enforced', coalesce(_setting('settlement_preview_mode'), 'off') = 'require',
    'period_start', v_per.o_start, 'period_end', v_per.o_end, 'next_period_end', v_per.o_next, 'valued_at', v_at,
    'window_end', v_req->'window_end', 'late', v_req->'late', 'backdated', v_req->'backdated', 'recorded_at', v_req->'recorded_at', 'open_positions', v_req->'open_positions', 'exception_ids', v_req->'exception_ids',
    'covered_from', case when v_from > 0 then (select ts from pool_equity where id = v_from) else (select min(ts) from pool_equity) end,
    'mexc_total', p_equity, 'nav', v_nav, 'unit_price', v_price, 'total_units', _total_units(),
    'fee_basis', coalesce(_setting('fee_basis'), 'external_investors'), 'fee_usdt', v_tot, 'fee_units', v_totu, 'lines', v_lines,
    'recon', v_rec, 'fund_m', v_fm || jsonb_build_object('period', _fund_m_period(v_fm0, v_fm, v_tot, (v_rec->>'fees_at_withdrawals_usdt')::numeric)),
    'waiting_deposits_admitted_after', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profile_id', profile_id, 'usdt', usdt))
       from pending_deposits where status = 'pending' and (arrived_at is not null or coalesce(_setting('settlement_gate'), 'off') <> 'on')), '[]'::jsonb));
end $$;

-- the workflow's settlement (Record -> Balance desk) forwards the preview hash to the same check
drop function if exists public.admin_settle_quarter(text, bigint, numeric, text, text, boolean);
create or replace function public.admin_settle_quarter(p_token text, p_vid bigint, p_php_rate numeric default null, p_note text default null, p_idem text default null,
    p_confirm boolean default false, p_preview text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; v_bal numeric; v_out jsonb; v_eq bigint;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_settle_quarter'); if v_res is not null then return v_res; end if;
  v_bal := _wf_require_ready(p_vid);
  if exists (select 1 from pending_deposits where status = 'pending' and arrived_at is not null) then raise exception 'blocked: %', _wf_msg('arrived_deposits', false); end if;
  perform set_config('ledger.wf_ctx', 'settlement:' || p_vid, true);
  v_out := admin_close_quarter(p_token, v_bal, p_php_rate, p_note, null, null, p_confirm, p_preview);
  perform set_config('ledger.wf_ctx', '', true);
  select id into v_eq from pool_equity order by id desc limit 1;
  perform _wf_use(p_vid, false);
  perform _wf_snapshot(v_eq, p_vid, 'quarter_settled');
  perform _wf_event(v_actor, 'settlement', v_eq, 'quarter_settled', jsonb_build_object('balance', v_bal, 'unit_price', v_out->'unit_price', 'fee_units', v_out->'fee_units'), v_eq, p_vid);
  return _idem_put(p_idem, 'admin_settle_quarter', v_out || jsonb_build_object('equity_id', v_eq), v_actor);
end $$;

------------------------------------------------------------------ access
revoke all on function public._fee_timing(), public._hwm_log(bigint, uuid), public._hwm_deposit(uuid, numeric, bigint), public._hwm_take(uuid, numeric, numeric, numeric, bigint),
  public._hwm_settle_calc(uuid, numeric, numeric), public._hwm_close(uuid, numeric, numeric, bigint), public._hwm_revert(bigint),
  public._settlement_requirements(numeric, timestamptz, jsonb), public._settlement_fingerprint(numeric, timestamptz), public._holder_summary(uuid) from public, anon, authenticated;
revoke all on function public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean, text), public.admin_settlement_preview(text, numeric, timestamptz),
  public.admin_settle_quarter(text, bigint, numeric, text, text, boolean, text) from public;
grant execute on function public.admin_close_quarter(text, numeric, numeric, text, timestamptz, text, boolean, text), public.admin_settlement_preview(text, numeric, timestamptz),
  public.admin_settle_quarter(text, bigint, numeric, text, text, boolean, text) to anon, authenticated;

notify pgrst, 'reload schema';

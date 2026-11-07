-- PESO TOP-UP: an investor's pesos are credited at the LIVE PHP/USD reference rate, not at what the exchange delivered. When less USDT arrived than pesos / live rate,
-- the difference is given to the investor from the FUND MANAGER'S OWN units. Docs: docs/php-contributions.md, section 9.
--
--   example   ₱5,000 · live rate ₱63.083992 · 66.40 USDT arrived
--             credited at the live rate   5,000 / 63.083992 = 79.259410 (rounded down to 6 decimals, worked out in the app: Contribution.topupDue)
--             top-up                      79.259410 - 66.40  = 12.859410 USDT of the manager's units, at the true-value unit price
--
-- The same transfer as the admission spread's manager_reallocation (20261209), with no admission_spreads row: priced at true value, one pool entry that leaves the pool's
-- equity and total units EXACTLY as they are, the investor's row a 'deposit' (php_amount null, so the pesos are never counted twice; the note names the peso deposits it
-- tops up), the manager's row a 'withdrawal'. Nobody else's units or value move. The investor's high-water mark rises by the top-up, so no fee is ever charged on it.
-- admin_units_from_manager is refused under true-value pricing (it would put the open trades into the book), hence this function.
-- Refused: not an investor or deactivated; amount <= 0 or more than 6 decimals; a rate outside ₱20–₱200, or more than 2% from the fund's stored PHP/USD reference
-- (fx_reference_rates, 20261208) when there is one; a note that does not start with "peso top-up"; true-value pricing off or blocked; the manager's holding too small.
-- Run after 20261208000000_fx_reference_rate.sql (and before or after 20261209000000_admission_spread.sql). Safe to run twice.
-- Rollback: supabase/rollback/20261210000000_rollback_peso_topup.sql

-- a checkpoint can record a reallocation (the same change 20261209 makes; whichever runs first, the result is identical)
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.flow_checkpoints'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.flow_checkpoints drop constraint %I', c);
  end loop;
  alter table public.flow_checkpoints add constraint flow_checkpoints_kind_check check (kind in ('deposit', 'withdrawal', 'settlement', 'reallocation'));
end $$;

create or replace function public.admin_peso_topup(p_token text, p_profile uuid, p_usdt numeric, p_rate numeric, p_note text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; pr profiles%rowtype; v_who text; v_ref numeric; t jsonb; v_price numeric; v_mu numeric; v_units numeric;
  v_at timestamptz; v_lock date; l pool_equity%rowtype; v_eq bigint; v_li bigint; v_lm bigint; v_cp bigint; v_out jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_peso_topup'); if v_res is not null then return v_res; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if pr.role <> 'investor' then raise exception 'a peso top-up is for an investor'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  if p_usdt is null or p_usdt <= 0 then raise exception 'the top-up must be more than 0 USDT'; end if;
  if round(p_usdt, 6) <> p_usdt then raise exception 'the top-up may have at most 6 decimals (USDT)'; end if;
  if p_rate is null or p_rate < 20 or p_rate > 200 then raise exception 'the live PHP/USD rate must be between 20 and 200'; end if;
  v_ref := _fx_reference_rate();
  if v_ref is not null and abs(p_rate / v_ref - 1) > 0.02 then
    raise exception 'the rate % is more than 2%% from the fund''s stored PHP/USD reference %: reload the app for a fresh live rate', p_rate, round(v_ref, 4);
  end if;
  if p_note is null or lower(p_note) not like 'peso top-up%' then raise exception 'the note must start with "peso top-up" and name the deposits it tops up'; end if;
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' then
    raise exception 'a peso top-up is priced at true value: with book pricing use "They paid me directly" (admin_units_from_manager)';
  end if;
  v_who := coalesce(nullif(pr.name, ''), pr.username);
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(null);
  v_price := (t->>'unit_price')::numeric;
  v_mu := _units_of(v_actor);
  v_units := round(p_usdt / v_price, 8);
  if v_units <= 0 then raise exception 'the top-up is too small to buy any units at this price'; end if;
  if v_units > v_mu + 0.00000001 then
    raise exception 'you hold % units (worth % USDT), but the % USDT top-up needs % units: nothing is taken from anyone else, so it is refused',
      round(v_mu, 8), round(v_mu * v_price, 6), p_usdt, v_units;
  end if;
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)));
  v_lock := _lock_for(p_profile, v_at);
  select * into l from pool_equity order by id desc limit 1;
  -- one pool entry that leaves the pool's equity and total units EXACTLY as they are (a transfer, not a deposit): nobody's value moves
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', l.equity_usdt, l.total_units, l.equity_usdt / l.total_units, p_rate,
    format('peso top-up: units moved from the fund manager to %s (no new money, no pool deposit)', v_who), v_actor) returning id into v_eq;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, p_usdt, v_price, p_rate, null, v_lock, v_eq, p_note) returning id into v_li;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, v_actor, 'withdrawal', -v_units, -p_usdt, v_price, p_rate, v_eq,
    format('peso top-up to %s: your units, so their pesos count at the live rate %s', v_who, round(p_rate, 4))) returning id into v_lm;
  perform _hwm_deposit(p_profile, p_usdt, v_eq);
  v_cp := _tv_checkpoint('reallocation', v_actor, v_li, p_profile, v_eq, null, t, v_price, p_usdt, v_units);
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  v_out := jsonb_build_object('unit_price', v_price, 'units', v_units, 'usdt', p_usdt, 'rate', p_rate, 'equity_id', v_eq, 'investor_ledger_id', v_li, 'manager_ledger_id', v_lm,
    'checkpoint_id', v_cp, 'manager_units_before', v_mu, 'manager_units_after', v_mu - v_units, 'lock_until', v_lock, 'priced_as_of', t->'priced_as_of');
  perform _audit(v_actor, 'peso_topup', p_profile, v_out || jsonb_build_object('note', p_note));
  return _idem_put(p_idem, 'admin_peso_topup', v_out, v_actor);
end $$;

-- the same, rolled back: what the screen shows before you save (the units, the price, your units after, or the refusal)
create or replace function public.admin_quote_peso_topup(p_token text, p_profile uuid, p_usdt numeric, p_rate numeric, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    v_res := admin_peso_topup(p_token, p_profile, p_usdt, p_rate, p_note, null);
    raise exception 'quote rolled back' using errcode = 'WQ003';
  exception when sqlstate 'WQ003' then null;
  end;
  return v_res || jsonb_build_object('quote', true);
end $$;

revoke all on function public.admin_peso_topup(text, uuid, numeric, numeric, text, text), public.admin_quote_peso_topup(text, uuid, numeric, numeric, text) from public;
grant execute on function public.admin_peso_topup(text, uuid, numeric, numeric, text, text), public.admin_quote_peso_topup(text, uuid, numeric, numeric, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- ADMISSION SPREAD: an investor's pesos are credited at an ADMISSION rate a little higher than the real (actual / reference) rate; the USDT the pesos really
-- bought (or the manager's capital really allocated) that the investor is NOT credited stays the fund manager's. Docs: docs/admission-spread.md.
--
--   example   ₱5,000 · actual / reference rate ₱62 · admission rate ₱63
--             actual USDT allocated   5,000 / 62 = 80.645161
--             credited to the investor 5,000 / 63 = 79.365079   (rounded DOWN to 6 decimals: never more than the pesos buy)
--             manager-owned surplus    80.645161 - 79.365079 = 1.280082
--
-- The investor gets units for the CREDITED USDT only, at the admission price (true value, as every other flow). The surplus is never shared pool equity:
--   p2p_purchase          the pesos bought USDT on the exchange. Two linked waiting deposits are recorded: the investor's (credited USDT, their pesos, the admission rate) and
--                         the manager's (the surplus). They are admitted together at the SAME price, so the pool value rises by the actual USDT and the total units by the
--                         actual USDT / price: the unit price, every other person's units and their value do not move, and the surplus is the manager's OWN units. It is a
--                         deposit entry, never a trading result, and the investor's high-water mark is the credited amount, so no fee is ever charged on the spread.
--   manager_reallocation  no new money: only the credited units move from the manager's holding to the investor (the existing "units from the fund manager" idea, priced at
--                         true value). No pool deposit, no pending deposit, pool equity and total units stay exactly as they are; the surplus stays in the manager's units
--                         because only the credited units are moved. Refused unless the manager's holding covers the whole actual allocation.
-- Refused (nothing is taken from anywhere else): actual allocation below the credited amount; admission rate below the actual / reference rate or more than the agreed
-- spread above it (setting admission_spread_php, default 1); pesos and actual USDT that do not match the stated rate (setting admission_rate_tolerance, default 1%).
-- The two legs of a p2p spread can only be admitted or handed back TOGETHER (a deferred check at commit), so the surplus can never be left out or admitted alone.
--
-- Nothing existing changes: no row of any existing table is read-modified; flow_checkpoints.kind also accepts 'reallocation'; _export_extra() also carries the new table.
-- Run after 20261208000000_fx_reference_rate.sql. Safe to run twice. Rollback: supabase/rollback/20261209000000_rollback_admission_spread.sql

insert into public.ledger_settings(key, value) values ('admission_spread_php', '1'), ('admission_rate_tolerance', '0.01') on conflict (key) do nothing;

-- ---------------------------------------------------------------- the record (append-only evidence)
create table if not exists public.admission_spreads (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  profile_id uuid not null references public.profiles(id),            -- the investor
  manager_id uuid not null references public.profiles(id),            -- whose capital holds the surplus
  funding_source text not null check (funding_source in ('p2p_purchase', 'manager_reallocation')),
  php_amount numeric not null check (php_amount > 0),                 -- the investor's original pesos
  reference_rate numeric not null check (reference_rate >= 20 and reference_rate <= 200),     -- actual / reference pesos per USDT
  admission_rate numeric not null check (admission_rate >= 20 and admission_rate <= 200),     -- pesos per USDT the investor is credited at
  credited_usdt numeric not null check (credited_usdt > 0),           -- php_amount / admission_rate, rounded down to 6 decimals: what buys the investor's units
  actual_usdt numeric not null check (actual_usdt > 0),               -- USDT actually allocated (received, or earmarked from the manager's capital)
  surplus_usdt numeric not null check (surplus_usdt >= 0),            -- actual - credited: the fund manager's
  investor_pending_id bigint references public.pending_deposits(id),  -- p2p_purchase: the investor's waiting deposit
  manager_pending_id bigint references public.pending_deposits(id),   -- p2p_purchase: the manager's waiting deposit for the surplus (none when the surplus is 0)
  realloc jsonb,                                                      -- manager_reallocation: price, units, pool entry, ledger rows, checkpoint
  note text,
  check (abs(actual_usdt - credited_usdt - surplus_usdt) < 0.000000001),
  check (admission_rate >= reference_rate),
  check ((funding_source = 'p2p_purchase' and investor_pending_id is not null and (manager_pending_id is not null or surplus_usdt = 0) and realloc is null)
      or (funding_source = 'manager_reallocation' and investor_pending_id is null and manager_pending_id is null and realloc is not null))
);
alter table public.admission_spreads enable row level security;
revoke all on table public.admission_spreads from public, anon, authenticated;
revoke all on sequence public.admission_spreads_id_seq from public, anon, authenticated;

create or replace function public._spread_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'admission_spreads is append-only: a spread is never changed or deleted (what happened to its money is in the ledger)';
end $$;
drop trigger if exists spread_append_only on public.admission_spreads;
create trigger spread_append_only before update or delete on public.admission_spreads for each row execute function public._spread_append_only();

-- the two waiting deposits of a p2p spread end in the SAME state: both admitted or both handed back (checked at commit, after the whole operation)
create or replace function public._spread_legs_together() returns trigger language plpgsql security definer set search_path = public as $$
declare s admission_spreads%rowtype; a text; b text;
begin
  select * into s from admission_spreads where investor_pending_id = new.id or manager_pending_id = new.id;
  if not found or s.manager_pending_id is null then return null; end if;
  select status into a from pending_deposits where id = s.investor_pending_id;
  select status into b from pending_deposits where id = s.manager_pending_id;
  if a is distinct from b then
    raise exception 'admission spread #%: the investor''s deposit (%) and the manager''s surplus deposit (%) must be admitted or handed back together',
      s.id, coalesce(a, '?'), coalesce(b, '?');
  end if;
  return null;
end $$;
drop trigger if exists spread_legs_together on public.pending_deposits;
create constraint trigger spread_legs_together after update of status on public.pending_deposits
  deferrable initially deferred for each row execute function public._spread_legs_together();

-- a checkpoint can also record a reallocation (it keeps the true-value reading the price came from)
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.flow_checkpoints'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.flow_checkpoints drop constraint %I', c);
  end loop;
  alter table public.flow_checkpoints add constraint flow_checkpoints_kind_check check (kind in ('deposit', 'withdrawal', 'settlement', 'reallocation'));
end $$;

-- ---------------------------------------------------------------- the figures and every refusal (pure: no data is read except the two settings)
create or replace function public._spread_check(p_php numeric, p_ref numeric, p_adm numeric, p_actual numeric) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_cap numeric := coalesce(nullif(_setting('admission_spread_php'), '')::numeric, 1); v_tol numeric := coalesce(nullif(_setting('admission_rate_tolerance'), '')::numeric, 0.01);
  v_cred numeric; v_impl numeric;
begin
  if p_php is null or p_php <= 0 then raise exception 'enter the pesos the investor paid'; end if;
  if p_ref is null or p_ref < 20 or p_ref > 200 then raise exception 'the actual / reference rate must be between 20 and 200 pesos per USDT'; end if;
  if p_adm is null or p_adm < 20 or p_adm > 200 then raise exception 'the admission rate must be between 20 and 200 pesos per USDT'; end if;
  if p_adm < p_ref then
    raise exception 'the admission rate (%) is below the actual / reference rate (%): that would credit more USDT than the pesos bought', trim_scale(round(p_adm, 6)), trim_scale(round(p_ref, 6));
  end if;
  if p_adm - p_ref > v_cap + 0.000001 then
    raise exception 'the admission spread is % pesos per USDT; the agreed spread is at most % (setting admission_spread_php)', trim_scale(round(p_adm - p_ref, 6)), trim_scale(v_cap);
  end if;
  if p_actual is null or p_actual <= 0 then raise exception 'enter the USDT actually allocated (more than 0)'; end if;
  if round(p_actual, 6) <> p_actual then raise exception 'the USDT allocated may have at most 6 decimals'; end if;
  v_cred := round(floor(p_php / p_adm * 1000000) / 1000000, 6);
  if v_cred <= 0 then raise exception 'the pesos are too small to credit any USDT at this rate'; end if;
  if p_actual < v_cred then
    raise exception 'the actual allocation (% USDT) does not cover the credited amount (% USDT): nothing is taken from anywhere else, so the admission is refused', trim_scale(round(p_actual, 6)), trim_scale(v_cred);
  end if;
  v_impl := p_php / p_actual;
  if abs(v_impl - p_ref) / p_ref > v_tol then
    raise exception 'the pesos and the actual USDT imply % pesos per USDT, not the stated % (more than % apart): check the numbers', trim_scale(round(v_impl, 4)), trim_scale(round(p_ref, 4)), trim_scale(round(v_tol * 100, 2)) || '%';
  end if;
  return jsonb_build_object('credited_usdt', v_cred, 'surplus_usdt', p_actual - v_cred, 'implied_rate', v_impl);
end $$;

-- ---------------------------------------------------------------- record an admission spread (fund manager only)
create or replace function public.admin_admission_spread(p_token text, p_profile uuid, p_php_amount numeric, p_reference_rate numeric, p_admission_rate numeric,
    p_actual_usdt numeric, p_source text, p_note text default null, p_in_mexc boolean default false, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; pr profiles%rowtype; f jsonb; v_cred numeric; v_sur numeric; v_id bigint; v_inv jsonb; v_mgr jsonb; v_who text;
  t jsonb; v_price numeric; v_at timestamptz; v_mu numeric; v_units numeric; l pool_equity%rowtype; v_eq bigint; v_li bigint; v_lm bigint; v_cp bigint; v_rate numeric;
  v_lock date; v_real jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_admission_spread'); if v_res is not null then return v_res; end if;
  select * into pr from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if pr.role <> 'investor' then raise exception 'the admission spread is for an investor''s contribution'; end if;
  if not pr.active then raise exception 'this person is deactivated'; end if;
  if p_source is null or p_source not in ('p2p_purchase', 'manager_reallocation') then raise exception 'choose how it is funded: p2p_purchase or manager_reallocation'; end if;
  f := _spread_check(p_php_amount, p_reference_rate, p_admission_rate, p_actual_usdt);
  v_cred := (f->>'credited_usdt')::numeric; v_sur := (f->>'surplus_usdt')::numeric; v_who := coalesce(nullif(pr.name, ''), pr.username);
  -- a quote must not use up a number (a sequence is not rolled back): inside a quote the id is a placeholder that is rolled back with everything else
  v_id := case when coalesce(current_setting('ledger.spread_quote', true), '') = 'on' then 0 else nextval('public.admission_spreads_id_seq') end;

  if p_source = 'p2p_purchase' then
    -- two waiting deposits that stay linked; both count as money in the exchange only once confirmed there; they are admitted (or handed back) together
    v_inv := admin_receive_deposit(p_token, p_profile, v_cred, p_admission_rate, p_php_amount,
      coalesce(p_note, '') || case when p_note is null then '' else ' · ' end || format('admission spread #%s: PHP %s credited at %s per USDT (actual rate %s)', v_id, p_php_amount, p_admission_rate, p_reference_rate),
      null, case when p_idem is null then null else p_idem || ':investor' end, p_in_mexc);
    if v_sur > 0 then
      v_mgr := admin_receive_deposit(p_token, v_actor, v_sur, null, null,
        format('conversion surplus of admission spread #%s (%s): the fund manager''s own units, never the pool''s', v_id, v_who),
        null, case when p_idem is null then null else p_idem || ':manager' end, p_in_mexc);
    end if;
    insert into admission_spreads(id, created_by, profile_id, manager_id, funding_source, php_amount, reference_rate, admission_rate, credited_usdt, actual_usdt, surplus_usdt,
      investor_pending_id, manager_pending_id, note)
    values (v_id, v_actor, p_profile, v_actor, p_source, p_php_amount, p_reference_rate, p_admission_rate, v_cred, p_actual_usdt, v_sur,
      (v_inv->>'id')::bigint, (v_mgr->>'id')::bigint, p_note);
    perform _audit(v_actor, 'admission_spread_recorded', p_profile, jsonb_build_object('spread_id', v_id, 'funding_source', p_source, 'php_amount', p_php_amount,
      'reference_rate', p_reference_rate, 'admission_rate', p_admission_rate, 'credited_usdt', v_cred, 'actual_usdt', p_actual_usdt, 'surplus_usdt', v_sur,
      'investor_pending_id', v_inv->'id', 'manager_pending_id', v_mgr->'id'));
    return _idem_put(p_idem, 'admin_admission_spread', jsonb_build_object('spread_id', v_id, 'funding_source', p_source, 'credited_usdt', v_cred, 'actual_usdt', p_actual_usdt,
      'surplus_usdt', v_sur, 'investor_pending_id', v_inv->'id', 'manager_pending_id', v_mgr->'id', 'status', 'waiting'), v_actor);
  end if;

  -- manager_reallocation: priced at true value like every flow; only the CREDITED units move, from the manager's holding to the investor
  if coalesce(_setting('flow_pricing'), 'book') <> 'true_value' then
    raise exception 'a reallocation from the manager''s capital is priced at true value: switch true-value pricing on first (flow_pricing = true_value)';
  end if;
  perform set_config('ledger.tv_ctx', 'on', true);
  t := _tv_require(null);
  v_price := (t->>'unit_price')::numeric;
  v_mu := _units_of(v_actor);
  if p_actual_usdt > v_mu * v_price + 0.000001 then
    raise exception 'your holding (% units, worth % USDT) does not cover the % USDT allocation: nothing is taken from anywhere else, so the admission is refused',
      round(v_mu, 8), round(v_mu * v_price, 6), p_actual_usdt;
  end if;
  v_units := round(v_cred / v_price, 8);
  if v_units <= 0 then raise exception 'the credited amount is too small to buy any units at this price'; end if;
  if v_units > v_mu + 0.00000001 then raise exception 'you hold % units but the credited amount needs %', round(v_mu, 8), v_units; end if;
  v_at := _at(greatest((t->>'measured_at')::timestamptz, (select max(ts) from pool_equity)));
  v_lock := _lock_for(p_profile, v_at); v_rate := _last_php_rate();
  select * into l from pool_equity order by id desc limit 1;
  -- one pool entry that leaves the pool's equity and total units EXACTLY as they are (a transfer, not a deposit): nobody's value moves
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (v_at, 'withdrawal', l.equity_usdt, l.total_units, l.equity_usdt / l.total_units, v_rate,
    format('admission spread #%s: units moved from the fund manager to %s (no new money, no pool deposit)', v_id, v_who), v_actor) returning id into v_eq;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, php_amount, lock_until, equity_id, note)
  values (v_at, p_profile, 'deposit', v_units, v_cred, v_price, p_admission_rate, p_php_amount, v_lock, v_eq,
    coalesce(p_note, format('PHP %s credited at %s per USDT, from the fund manager''s units', p_php_amount, p_admission_rate))) returning id into v_li;
  insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note)
  values (v_at, v_actor, 'withdrawal', -v_units, -v_cred, v_price, v_rate, v_eq, format('units given to %s (admission spread #%s; the surplus %s USDT stays yours)', v_who, v_id, v_sur)) returning id into v_lm;
  perform _hwm_deposit(p_profile, v_cred, v_eq);
  v_cp := _tv_checkpoint('reallocation', v_actor, v_id, p_profile, v_eq, null, t, v_price, v_cred, v_units);
  v_real := jsonb_build_object('unit_price', v_price, 'units', v_units, 'equity_id', v_eq, 'investor_ledger_id', v_li, 'manager_ledger_id', v_lm, 'checkpoint_id', v_cp,
    'manager_units_before', v_mu, 'manager_units_after', v_mu - v_units, 'lock_until', v_lock, 'priced_as_of', t->'priced_as_of');
  insert into admission_spreads(id, created_by, profile_id, manager_id, funding_source, php_amount, reference_rate, admission_rate, credited_usdt, actual_usdt, surplus_usdt, realloc, note)
  values (v_id, v_actor, p_profile, v_actor, p_source, p_php_amount, p_reference_rate, p_admission_rate, v_cred, p_actual_usdt, v_sur, v_real, p_note);
  perform set_config('ledger.tv_ctx', '', true);
  perform _check_books();
  perform _audit(v_actor, 'admission_spread_reallocated', p_profile, jsonb_build_object('spread_id', v_id, 'php_amount', p_php_amount, 'reference_rate', p_reference_rate,
    'admission_rate', p_admission_rate, 'credited_usdt', v_cred, 'actual_usdt', p_actual_usdt, 'surplus_usdt', v_sur, 'units', v_units, 'unit_price', v_price, 'checkpoint_id', v_cp));
  return _idem_put(p_idem, 'admin_admission_spread', v_real || jsonb_build_object('spread_id', v_id, 'funding_source', p_source, 'credited_usdt', v_cred, 'actual_usdt', p_actual_usdt,
    'surplus_usdt', v_sur, 'status', 'done'), v_actor);
end $$;

-- the same, rolled back: what the screen shows before you save (the figures, or the refusal)
create or replace function public.admin_quote_admission_spread(p_token text, p_profile uuid, p_php_amount numeric, p_reference_rate numeric, p_admission_rate numeric,
    p_actual_usdt numeric, p_source text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    perform set_config('ledger.spread_quote', 'on', true);
    v_res := admin_admission_spread(p_token, p_profile, p_php_amount, p_reference_rate, p_admission_rate, p_actual_usdt, p_source, null, false, null);
    raise exception 'quote rolled back' using errcode = 'WQ003';
  exception when sqlstate 'WQ003' then null;
  end;
  return v_res || jsonb_build_object('quote', true);
end $$;

-- admit a p2p spread: its two waiting deposits, together, at true value (the investor's units and the manager's surplus units at the same price)
create or replace function public.admin_admit_admission_spread_tv(p_token text, p_spread bigint, p_as_of timestamptz default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s admission_spreads%rowtype;
begin
  perform _admin(p_token);
  select * into s from admission_spreads where id = p_spread;
  if not found then raise exception 'unknown admission spread'; end if;
  if s.funding_source <> 'p2p_purchase' then raise exception 'a reallocation is done when it is recorded: there is nothing to admit'; end if;
  return admin_admit_deposits_tv(p_token, array_remove(array[s.investor_pending_id, s.manager_pending_id], null), p_as_of, p_idem);
end $$;

-- hand back a p2p spread that has not been admitted: both waiting deposits, together
create or replace function public.admin_cancel_admission_spread(p_token text, p_spread bigint) returns void
language plpgsql security definer set search_path = public as $$
declare s admission_spreads%rowtype;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  select * into s from admission_spreads where id = p_spread;
  if not found then raise exception 'unknown admission spread'; end if;
  if s.funding_source <> 'p2p_purchase' then raise exception 'a reallocation has already moved the units: it cannot be handed back here'; end if;
  perform admin_cancel_pending(p_token, s.investor_pending_id);
  if s.manager_pending_id is not null then perform admin_cancel_pending(p_token, s.manager_pending_id); end if;
end $$;

-- ---------------------------------------------------------------- reading them (fund manager only): every figure, and what became of it
create or replace function public.admin_admission_spreads(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((
    select jsonb_agg(x order by (x->>'id')::bigint desc) from (
      select jsonb_build_object('id', s.id, 'created_at', s.created_at, 'profile_id', s.profile_id, 'investor', coalesce(nullif(p.name, ''), p.username),
        'funding_source', s.funding_source, 'php_amount', s.php_amount, 'reference_rate', s.reference_rate, 'admission_rate', s.admission_rate,
        'credited_usdt', s.credited_usdt, 'actual_usdt', s.actual_usdt, 'surplus_usdt', s.surplus_usdt,
        'investor_pending_id', s.investor_pending_id, 'manager_pending_id', s.manager_pending_id, 'note', s.note,
        'status', case when s.funding_source = 'manager_reallocation' then 'done'
                       when ip.status = 'converted' then 'admitted' when ip.status = 'cancelled' then 'handed_back'
                       when ip.arrived_at is null then 'waiting_for_exchange' else 'waiting' end,
        'investor_units', case when s.funding_source = 'manager_reallocation' then (s.realloc->>'units')::numeric else il.units end,
        'manager_units', case when s.funding_source = 'manager_reallocation' then null else ml.units end,
        'unit_price', case when s.funding_source = 'manager_reallocation' then (s.realloc->>'unit_price')::numeric else il.unit_price end) as x
      from admission_spreads s join profiles p on p.id = s.profile_id
      left join pending_deposits ip on ip.id = s.investor_pending_id left join ledger il on il.id = ip.ledger_id
      left join pending_deposits mp on mp.id = s.manager_pending_id left join ledger ml on ml.id = mp.ledger_id
    ) q), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- the backup carries the table
do $$ begin
  if to_regprocedure('public._export_extra_pre_spread()') is null then
    alter function public._export_extra() rename to _export_extra_pre_spread;
  end if;
end $$;
revoke all on function public._export_extra_pre_spread() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_spread() || jsonb_build_object('admission_spreads', _dump_table('admission_spreads'))
$$;

-- ---------------------------------------------------------------- permissions
revoke all on function public._spread_append_only(), public._spread_legs_together(), public._spread_check(numeric, numeric, numeric, numeric), public._export_extra() from public, anon, authenticated;
revoke all on function public.admin_admission_spread(text, uuid, numeric, numeric, numeric, numeric, text, text, boolean, text),
  public.admin_quote_admission_spread(text, uuid, numeric, numeric, numeric, numeric, text), public.admin_admit_admission_spread_tv(text, bigint, timestamptz, text),
  public.admin_cancel_admission_spread(text, bigint), public.admin_admission_spreads(text) from public;
grant execute on function public.admin_admission_spread(text, uuid, numeric, numeric, numeric, numeric, text, text, boolean, text),
  public.admin_quote_admission_spread(text, uuid, numeric, numeric, numeric, numeric, text), public.admin_admit_admission_spread_tv(text, bigint, timestamptz, text),
  public.admin_cancel_admission_spread(text, bigint), public.admin_admission_spreads(text) to anon, authenticated;
notify pgrst, 'reload schema';

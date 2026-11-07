-- The current PHP/USD reference rate, kept apart from every cash-in rate. Docs: docs/php-contributions.md (section 6).
--
-- Before this file, "the current peso rate" in the database was _last_php_rate(): the php_rate of the newest pool entry. A deposit's admission copies the deposit's
-- own rate onto its pool entry, so after the 2026-11-07 deposits it returned ₱75.27191529, Raf's CASH-IN rate (₱6,897 / 91.6278 USDT), not a market rate. It was
--   - the rate at which the ₱500 minimum withdrawal was checked for investor requests and Balance-desk payouts, and
--   - the default php_rate written on new entries when none was given.
--
-- After this file:
--   - fx_reference_rates (append-only) holds PHP-per-USD readings from an independent live source (open.er-api.com / frankfurter.dev, read by the fund manager's
--     browser and validated there and here: ₱20–₱200, fetched within the last hour, at most one stored per hour), or typed by the fund manager (source 'manual');
--   - _fx_reference_rate() = the newest reading fetched within fx_reference_max_age_hours (default 168 = 7 days), else NULL;
--   - _last_php_rate() returns _fx_reference_rate(). Its name is kept so every existing caller changes at once; it NEVER reads a pool entry or a deposit again;
--   - _check_min_withdrawal() also ignores a rate outside ₱20–₱200. With no usable rate the minimum is not checked (the behaviour it always had without a rate):
--     a missing rate can only let a small request through, never block one.
-- Nothing else changes. No row of any existing table is read, written or rewritten. Units, prices, pool values, fees, payouts and settlements never used a peso rate
-- (tests/withdraw-denomination.test.mjs proves it for each), so they are unchanged; only the ₱500 eligibility check and the descriptive php_rate on NEW entries move
-- from "last cash-in rate" to "current reference rate or none".
-- Rollback: supabase/rollback/20261208000000_rollback_fx_reference_rate.sql

insert into public.ledger_settings(key, value) values ('fx_reference_max_age_hours', '168') on conflict (key) do nothing;

-- ---------------------------------------------------------------- the readings
create table if not exists public.fx_reference_rates (
  id bigserial primary key,
  recorded_at timestamptz not null default now(),
  usd_php numeric not null check (usd_php >= 20 and usd_php <= 200),
  source text not null check (length(btrim(source)) between 1 and 100),
  fetched_at timestamptz not null,
  recorded_by uuid references public.profiles(id)
);
alter table public.fx_reference_rates enable row level security;
revoke all on table public.fx_reference_rates from public, anon, authenticated;

create or replace function public._fx_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'fx_reference_rates is append-only';
end $$;
drop trigger if exists fx_append_only on public.fx_reference_rates;
create trigger fx_append_only before update or delete on public.fx_reference_rates for each row execute function public._fx_append_only();

-- ---------------------------------------------------------------- the current reference rate
create or replace function public._fx_reference_hours() returns int language sql stable security definer set search_path = public as $$
  select greatest(1, coalesce(nullif(_setting('fx_reference_max_age_hours'), '')::int, 168))
$$;

create or replace function public._fx_reference_rate() returns numeric language sql stable security definer set search_path = public as $$
  select usd_php from fx_reference_rates
  where fetched_at >= now() - make_interval(hours => _fx_reference_hours()) and fetched_at <= now() + interval '1 minute'
  order by fetched_at desc, id desc limit 1
$$;

-- kept for its many callers; now the current reference rate (or NULL), never the rate stored on a pool entry or deposit
create or replace function public._last_php_rate() returns numeric language sql stable security definer set search_path = public as $$
  select _fx_reference_rate()
$$;

-- the ₱500 minimum: unchanged rule, but a rate outside ₱20–₱200 counts as no rate
create or replace function public._check_min_withdrawal(p uuid, p_units numeric, p_price numeric, p_php_rate numeric) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_min numeric := coalesce(_setting('min_withdrawal_php'), '500')::numeric;
begin
  if p_php_rate is null or p_php_rate < 20 or p_php_rate > 200 or p_units >= _units_of(p) - 0.00000001 then return; end if;
  if p_units * p_price * p_php_rate < v_min then
    raise exception 'the minimum withdrawal is % pesos (taking everything you hold is always allowed)', v_min;
  end if;
end $$;

-- ---------------------------------------------------------------- recording a reading (fund manager only)
-- p_fetched_at: when the source answered. A reading is stored only if it is fresh (fetched within the last hour) and no reading was stored in the last hour;
-- otherwise nothing is written and the newest one is returned. Every stored reading is in the activity log.
create or replace function public.admin_record_fx_reference(p_token text, p_rate numeric, p_source text, p_fetched_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_at timestamptz := coalesce(p_fetched_at, now()); v_src text := btrim(coalesce(p_source, '')); v_last fx_reference_rates%rowtype; v_id bigint;
begin
  if p_rate is null or p_rate < 20 or p_rate > 200 then raise exception 'a PHP/USD reference rate must be between 20 and 200 pesos per USD'; end if;
  if length(v_src) not between 1 and 100 then raise exception 'name the source of the reference rate'; end if;
  if v_at > now() + interval '1 minute' or v_at < now() - interval '1 hour' then raise exception 'a reference rate must have been fetched within the last hour'; end if;
  select * into v_last from fx_reference_rates order by id desc limit 1;
  if found and v_last.recorded_at > now() - interval '1 hour' then
    return jsonb_build_object('recorded', false, 'reason', 'a reading was stored less than an hour ago', 'id', v_last.id, 'usd_php', v_last.usd_php,
      'source', v_last.source, 'fetched_at', v_last.fetched_at);
  end if;
  insert into fx_reference_rates(usd_php, source, fetched_at, recorded_by) values (p_rate, v_src, v_at, v_actor) returning id into v_id;
  perform _audit(v_actor, 'fx_reference_recorded', null, jsonb_build_object('id', v_id, 'usd_php', p_rate, 'source', v_src, 'fetched_at', v_at));
  return jsonb_build_object('recorded', true, 'id', v_id, 'usd_php', p_rate, 'source', v_src, 'fetched_at', v_at);
end $$;

-- ---------------------------------------------------------------- reading it (anyone signed in): the rate the minimum is checked at, and the minimum in USDT
create or replace function public.fx_reference(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token); r fx_reference_rates%rowtype; v_min numeric := coalesce(_setting('min_withdrawal_php'), '500')::numeric;
begin
  select * into r from fx_reference_rates
  where fetched_at >= now() - make_interval(hours => _fx_reference_hours()) and fetched_at <= now() + interval '1 minute'
  order by fetched_at desc, id desc limit 1;
  return jsonb_build_object('usd_php', r.usd_php, 'source', r.source, 'fetched_at', r.fetched_at, 'recorded_at', r.recorded_at,
    'max_age_hours', _fx_reference_hours(), 'min_withdrawal_php', v_min, 'min_withdrawal_usdt', case when r.usd_php > 0 then round(v_min / r.usd_php, 2) end);
end $$;

-- ---------------------------------------------------------------- backups carry the readings
do $$ begin
  if to_regprocedure('public._export_extra_pre_fx()') is null then
    alter function public._export_extra() rename to _export_extra_pre_fx;
  end if;
end $$;
revoke all on function public._export_extra_pre_fx() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_fx() || jsonb_build_object('fx_reference_rates', _dump_table('fx_reference_rates'))
$$;

-- ---------------------------------------------------------------- permissions
revoke all on function public._fx_append_only(), public._fx_reference_hours(), public._fx_reference_rate(), public._last_php_rate(),
  public._check_min_withdrawal(uuid, numeric, numeric, numeric), public._export_extra() from public, anon, authenticated;
revoke all on function public.admin_record_fx_reference(text, numeric, text, timestamptz), public.fx_reference(text) from public;
grant execute on function public.admin_record_fx_reference(text, numeric, text, timestamptz), public.fx_reference(text) to anon, authenticated;
notify pgrst, 'reload schema';

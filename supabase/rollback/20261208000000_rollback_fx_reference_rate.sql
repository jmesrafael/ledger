-- Rollback of 20261208000000_fx_reference_rate.sql. Safe at any time: no other table depends on the readings.
-- Puts back the exact previous bodies of _last_php_rate() (the newest pool entry's php_rate, which today is a CASH-IN rate) and _check_min_withdrawal(),
-- removes the two new functions and the backup wrapper, and KEEPS the fx_reference_rates table and its rows (append-only evidence, like book_corrections),
-- so the readings stay traceable and the migration can be applied again.

create or replace function public._last_php_rate() returns numeric language sql stable security definer set search_path = public as $$
  select php_rate from pool_equity where php_rate is not null order by id desc limit 1
$$;

create or replace function public._check_min_withdrawal(p uuid, p_units numeric, p_price numeric, p_php_rate numeric) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_min numeric := coalesce(_setting('min_withdrawal_php'), '500')::numeric;
begin
  if p_php_rate is null or p_php_rate <= 0 or p_units >= _units_of(p) - 0.00000001 then return; end if;
  if p_units * p_price * p_php_rate < v_min then
    raise exception 'the minimum withdrawal is % pesos (taking everything you hold is always allowed)', v_min;
  end if;
end $$;

drop function if exists public.admin_record_fx_reference(text, numeric, text, timestamptz);
drop function if exists public.fx_reference(text);
drop function if exists public._fx_reference_rate();
drop function if exists public._fx_reference_hours();

-- the backup export: back to the previous definition plus the kept readings
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_fx() || jsonb_build_object('fx_reference_rates', _dump_table('fx_reference_rates'))
$$;
revoke all on function public._last_php_rate(), public._check_min_withdrawal(uuid, numeric, numeric, numeric), public._export_extra() from public, anon, authenticated;
delete from public.ledger_settings where key = 'fx_reference_max_age_hours';
notify pgrst, 'reload schema';

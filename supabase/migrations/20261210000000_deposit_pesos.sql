-- PESOS PAID FOR AN OLDER DEPOSIT: a deposit is shown as the pesos that were put in (₱3,323, ₱12,830, ₱6,897 ...), and "Put in" is their plain total.
-- Deposits recorded before the pesos were saved (php_amount empty, e.g. Raf's #1 and #2 in Oct 2026) can get the pesos actually paid attached here, once.
-- Display only: the deposit's USDT, units, unit price, the pool, fees and payouts are never read or changed; ledger rows stay append-only. Docs: docs/php-contributions.md.
-- Run after 20261209000000_admission_spread.sql (any order works: nothing here depends on it). Safe to run twice.
-- Rollback: supabase/rollback/20261210000000_rollback_deposit_pesos.sql (keeps the recorded amounts as evidence).

create table if not exists public.deposit_pesos (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  ledger_id bigint not null unique references public.ledger(id),   -- the deposit; once only
  php_amount numeric not null check (php_amount > 0),
  note text not null check (length(btrim(note)) >= 5)               -- where the amount comes from (GCash, bank, receipt ...)
);
alter table public.deposit_pesos enable row level security;
revoke all on table public.deposit_pesos from public, anon, authenticated;
revoke all on sequence public.deposit_pesos_id_seq from public, anon, authenticated;

create or replace function public._deposit_pesos_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'deposit_pesos is append-only: the pesos recorded for a deposit are never changed or deleted';
end $$;
drop trigger if exists deposit_pesos_append_only on public.deposit_pesos;
create trigger deposit_pesos_append_only before update or delete on public.deposit_pesos for each row execute function public._deposit_pesos_append_only();

-- the fund manager records the pesos actually paid for one older deposit that has none
create or replace function public.admin_record_deposit_pesos(p_token text, p_ledger bigint, p_php_amount numeric, p_note text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; l ledger%rowtype; v_id bigint; v_rate numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_record_deposit_pesos'); if v_res is not null then return v_res; end if;
  select * into l from ledger where id = p_ledger;
  if not found then raise exception 'unknown entry'; end if;
  if l.kind <> 'deposit' or l.usdt <= 0 then raise exception 'pesos can only be added to a deposit'; end if;
  if l.reversed_of is not null or exists (select 1 from ledger r where r.reversed_of = l.id) then raise exception 'this deposit was undone'; end if;
  if lower(coalesce(l.note, '')) like 'peso top-up%' then raise exception 'a peso top-up is part of the deposit it tops up: add the pesos to that deposit'; end if;
  if l.php_amount is not null then raise exception 'this deposit already has its pesos recorded (₱%)', trim_scale(l.php_amount); end if;
  if exists (select 1 from deposit_pesos where ledger_id = l.id) then
    raise exception 'pesos were already recorded for this deposit (₱%); they cannot be changed', (select trim_scale(php_amount) from deposit_pesos where ledger_id = l.id);
  end if;
  if p_php_amount is null or p_php_amount <= 0 then raise exception 'enter the pesos that were paid'; end if;
  if round(p_php_amount, 2) <> p_php_amount then raise exception 'pesos have at most 2 decimals'; end if;
  if length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'say where the amount comes from (for example the GCash or bank record)'; end if;
  v_rate := p_php_amount / l.usdt;
  if v_rate < 20 or v_rate > 200 then
    raise exception '₱% for % USDT is ₱% per USDT: that cannot be right, check the amount', trim_scale(p_php_amount), trim_scale(l.usdt), round(v_rate, 2);
  end if;
  insert into deposit_pesos(created_by, ledger_id, php_amount, note) values (v_actor, l.id, p_php_amount, btrim(p_note)) returning id into v_id;
  perform _audit(v_actor, 'deposit_pesos_recorded', l.profile_id, jsonb_build_object('ledger_id', l.id, 'php_amount', p_php_amount, 'usdt', l.usdt, 'note', btrim(p_note)));
  return _idem_put(p_idem, 'admin_record_deposit_pesos', jsonb_build_object('id', v_id, 'ledger_id', l.id, 'php_amount', p_php_amount), v_actor);
end $$;

-- reading them: the manager sees all, a person sees their own (the app shows them as the deposit's pesos)
create or replace function public.admin_deposit_pesos(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('ledger_id', d.ledger_id, 'php_amount', d.php_amount, 'note', d.note, 'created_at', d.created_at) order by d.ledger_id)
    from deposit_pesos d), '[]'::jsonb);
end $$;
create or replace function public.my_deposit_pesos(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('ledger_id', d.ledger_id, 'php_amount', d.php_amount) order by d.ledger_id)
    from deposit_pesos d join ledger l on l.id = d.ledger_id where l.profile_id = v), '[]'::jsonb);
end $$;

-- the backup carries the table
do $$ begin
  if to_regprocedure('public._export_extra_pre_dpesos()') is null then
    alter function public._export_extra() rename to _export_extra_pre_dpesos;
  end if;
end $$;
revoke all on function public._export_extra_pre_dpesos() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_dpesos() || jsonb_build_object('deposit_pesos', _dump_table('deposit_pesos'))
$$;

revoke all on function public._deposit_pesos_append_only(), public._export_extra() from public, anon, authenticated;
revoke all on function public.admin_record_deposit_pesos(text, bigint, numeric, text, text), public.admin_deposit_pesos(text), public.my_deposit_pesos(text) from public;
grant execute on function public.admin_record_deposit_pesos(text, bigint, numeric, text, text), public.admin_deposit_pesos(text), public.my_deposit_pesos(text) to anon, authenticated;
notify pgrst, 'reload schema';

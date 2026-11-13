-- THE PESOS OF A DEPOSIT, AS PUT IN: a deposit is shown as the pesos that were put in (₱3,323, ₱12,830, ₱5,000 ...), with the USDT those pesos bought when that is known,
-- and "Put in" is the plain peso total. The fund manager records them for a deposit that has none (Raf's #1, #2 of Oct 2026), or CORRECTS a recorded amount
-- (the Nov 7 bulk cash-in: ₱10,000 bought 158.0278 USDT, split in half: James ₱5,000 = 79.0139 USDT, Raf ₱5,000 = 79.0139 USDT).
-- Append-only history: every entry is kept with who, when and the source; the newest entry of a deposit is the one shown. Display only: the deposit's ledger row,
-- USDT credited, units, unit price, the pool, fees and payouts are never read or changed. Docs: docs/php-contributions.md.
-- Run after 20261209000000_admission_spread.sql (any order works: nothing here depends on it). Safe to run twice.
-- Rollback: supabase/rollback/20261210000000_rollback_deposit_pesos.sql (keeps the recorded entries as evidence).

create table if not exists public.deposit_pesos (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  ledger_id bigint not null references public.ledger(id),           -- the deposit
  php_amount numeric not null check (php_amount > 0),                -- the pesos put in
  usdt_bought numeric check (usdt_bought is null or usdt_bought > 0),   -- the USDT those pesos bought, when known (not what was credited)
  note text not null check (length(btrim(note)) >= 5)               -- where the amount comes from (GCash, bank, receipt ...)
);
-- an earlier draft of this file (run on the live database on 2026-11-08) made the table without usdt_bought and with one entry per deposit:
-- bring that table up to date in place, keeping its rows (adding a column and dropping a constraint touch no row)
alter table public.deposit_pesos add column if not exists usdt_bought numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deposit_pesos'::regclass and conname = 'deposit_pesos_usdt_bought_check') then
    alter table public.deposit_pesos add constraint deposit_pesos_usdt_bought_check check (usdt_bought is null or usdt_bought > 0);
  end if;
end $$;
alter table public.deposit_pesos drop constraint if exists deposit_pesos_ledger_id_key;   -- corrections are new entries of the same deposit
drop function if exists public.admin_record_deposit_pesos(text, bigint, numeric, text, text);   -- the draft's version (no USDT bought)
create index if not exists deposit_pesos_ledger on public.deposit_pesos(ledger_id, id);
alter table public.deposit_pesos enable row level security;
revoke all on table public.deposit_pesos from public, anon, authenticated;
revoke all on sequence public.deposit_pesos_id_seq from public, anon, authenticated;

create or replace function public._deposit_pesos_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'deposit_pesos is append-only: a correction is a new entry, the earlier ones are kept';
end $$;
drop trigger if exists deposit_pesos_append_only on public.deposit_pesos;
create trigger deposit_pesos_append_only before update or delete on public.deposit_pesos for each row execute function public._deposit_pesos_append_only();

-- the fund manager records (or corrects) the pesos put in for one deposit, and optionally the USDT they bought
create or replace function public.admin_record_deposit_pesos(p_token text, p_ledger bigint, p_php_amount numeric, p_usdt_bought numeric, p_note text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; l ledger%rowtype; v_id bigint; v_rate numeric; p deposit_pesos%rowtype; v_from numeric; v_from_usdt numeric;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_record_deposit_pesos'); if v_res is not null then return v_res; end if;
  select * into l from ledger where id = p_ledger;
  if not found then raise exception 'unknown entry'; end if;
  if l.kind <> 'deposit' or l.usdt <= 0 then raise exception 'pesos can only be recorded for a deposit'; end if;
  if l.reversed_of is not null or exists (select 1 from ledger r where r.reversed_of = l.id) then raise exception 'this deposit was undone'; end if;
  if lower(coalesce(l.note, '')) like 'peso top-up%' then raise exception 'a peso top-up is part of the deposit it tops up: record the pesos on that deposit'; end if;
  if p_php_amount is null or p_php_amount <= 0 then raise exception 'enter the pesos that were put in'; end if;
  if round(p_php_amount, 2) <> p_php_amount then raise exception 'pesos have at most 2 decimals'; end if;
  if p_usdt_bought is not null and (p_usdt_bought <= 0 or round(p_usdt_bought, 8) <> p_usdt_bought) then raise exception 'the USDT bought must be more than 0, at most 8 decimals'; end if;
  if length(btrim(coalesce(p_note, ''))) < 5 then raise exception 'say where the amount comes from (for example the GCash or bank record)'; end if;
  v_rate := p_php_amount / coalesce(p_usdt_bought, l.usdt);
  if v_rate < 20 or v_rate > 200 then
    raise exception '₱% for % USDT is ₱% per USDT: that cannot be right, check the amounts', trim_scale(p_php_amount), trim_scale(coalesce(p_usdt_bought, l.usdt)), round(v_rate, 2);
  end if;
  select * into p from deposit_pesos where ledger_id = l.id order by id desc limit 1;
  v_from := coalesce(p.php_amount, l.php_amount); v_from_usdt := p.usdt_bought;
  if v_from = p_php_amount and v_from_usdt is not distinct from p_usdt_bought then raise exception 'nothing to change: that is what is recorded'; end if;
  insert into deposit_pesos(created_by, ledger_id, php_amount, usdt_bought, note) values (v_actor, l.id, p_php_amount, p_usdt_bought, btrim(p_note)) returning id into v_id;
  perform _audit(v_actor, case when v_from is null then 'deposit_pesos_recorded' else 'deposit_pesos_corrected' end, l.profile_id,
    jsonb_build_object('ledger_id', l.id, 'php_amount', p_php_amount, 'usdt_bought', p_usdt_bought, 'from_php', v_from, 'from_usdt_bought', v_from_usdt, 'usdt', l.usdt, 'note', btrim(p_note)));
  return _idem_put(p_idem, 'admin_record_deposit_pesos', jsonb_build_object('id', v_id, 'ledger_id', l.id, 'php_amount', p_php_amount, 'usdt_bought', p_usdt_bought, 'from_php', v_from), v_actor);
end $$;

-- reading them (the whole history, oldest first; the app shows the newest of each deposit): the manager sees all, a person sees their own
create or replace function public.admin_deposit_pesos(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'ledger_id', d.ledger_id, 'php_amount', d.php_amount, 'usdt_bought', d.usdt_bought, 'note', d.note, 'created_at', d.created_at) order by d.id)
    from deposit_pesos d), '[]'::jsonb);
end $$;
create or replace function public.my_deposit_pesos(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v uuid := _me(p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'ledger_id', d.ledger_id, 'php_amount', d.php_amount, 'usdt_bought', d.usdt_bought) order by d.id)
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
revoke all on function public.admin_record_deposit_pesos(text, bigint, numeric, numeric, text, text), public.admin_deposit_pesos(text), public.my_deposit_pesos(text) from public;
grant execute on function public.admin_record_deposit_pesos(text, bigint, numeric, numeric, text, text), public.admin_deposit_pesos(text), public.my_deposit_pesos(text) to anon, authenticated;
notify pgrst, 'reload schema';

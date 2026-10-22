-- 1) The withdrawal (exit) fee is switched OFF for now. The original rule is kept below, commented out, to switch back on later:
--    restore the body of _exit_fee_rate and tell investors (the app has EXIT_FEE_ON in js/app.js).
-- 2) Where each person wants to be paid (GCash or bank transfer), with the receiving QR in Supabase Storage.
-- Run after 20261103000000_withdrawal_fee_minimum.sql.

create or replace function public._exit_fee_rate(p uuid) returns numeric language sql stable security definer set search_path = public as $$
  select 0::numeric
  /* the withdrawal fee, to be switched back on later:
  select case when (select role from profiles where id = p) <> 'investor' then 0
              when _account_since(p) > now() - make_interval(days => coalesce(_setting('exit_fee_after_days'), '365')::int)
                then coalesce(_setting('exit_fee_young'), '0.05')::numeric
              else coalesce(_setting('exit_fee_mature'), '0.02')::numeric end
  */
$$;

-- ---------------------------------------------------------------- payout details
create table if not exists public.payout_details (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,
  method         text not null check (method in ('gcash', 'bank')),
  account_name   text not null,
  account_number text not null,
  bank_name      text,
  qr_path        text,
  updated_at     timestamptz not null default now()
);
alter table public.payout_details enable row level security;
revoke all on public.payout_details from public, anon, authenticated;

-- QR images: a public bucket (so the fund manager's page can show them by link), but the file names are random 128-bit ids that only
-- the owner and the fund manager are ever given, nobody can list the bucket, and anonymous visitors may only ADD small images.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('payout-qr', 'payout-qr', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

drop policy if exists payout_qr_insert on storage.objects;
create policy payout_qr_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'payout-qr' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$');

create or replace function public.my_payout(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token);
begin
  return (select to_jsonb(d) - 'updated_at' from payout_details d where d.profile_id = v);
end $$;

create or replace function public.set_my_payout(p_token text, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token); v_old text;
begin
  if p_method not in ('gcash', 'bank') then raise exception 'choose GCash or bank transfer'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'enter the account name'; end if;
  if length(trim(coalesce(p_number, ''))) < 4 then raise exception 'enter the % number', case when p_method = 'gcash' then 'GCash' else 'account' end; end if;
  if p_method = 'bank' and length(trim(coalesce(p_bank, ''))) < 2 then raise exception 'enter the bank name'; end if;
  if p_qr is not null and p_qr !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then raise exception 'invalid QR image'; end if;
  insert into payout_details(profile_id, method, account_name, account_number, bank_name, qr_path)
  values (v, p_method, trim(p_name), trim(p_number), case when p_method = 'bank' then trim(p_bank) end, p_qr)
  on conflict (profile_id) do update set method = excluded.method, account_name = excluded.account_name, account_number = excluded.account_number,
    bank_name = excluded.bank_name, qr_path = excluded.qr_path, updated_at = now();
end $$;

create or replace function public.admin_payouts(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _admin(p_token);
begin
  return coalesce((select jsonb_agg(to_jsonb(d)) from payout_details d), '[]'::jsonb);
end $$;

-- a withdrawal request needs somewhere to send the money
create or replace function public.request_withdrawal(p_token text, p_units numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v uuid := _me_rw(p_token); pr profiles%rowtype; v_by date; v_open numeric;
begin
  perform _ledger_lock();
  select * into pr from profiles where id = v;
  if p_units is null or p_units <= 0 then raise exception 'units must be > 0'; end if;
  if pr.role = 'investor' and not exists (select 1 from payout_details where profile_id = v) then
    raise exception 'add where you want to be paid (GCash or bank) before requesting a withdrawal';
  end if;
  v_open := coalesce((select sum(units) from withdrawal_requests where profile_id = v and status = 'pending'), 0);
  if p_units + v_open > _units_of(v) + 0.00000001 then raise exception 'you only hold % units (% already in pending requests)', _units_of(v), v_open; end if;
  if pr.role = 'investor' and p_units + v_open > _unlocked_units(v) + 0.00000001 then
    raise exception 'locked: % units are past lock-up and % are already in pending requests. Next unlock: %', _unlocked_units(v), v_open,
      (select min(lock_until) filter (where lock_until > current_date) from ledger where profile_id = v and kind = 'deposit');
  end if;
  if pr.role = 'investor' then
    perform _check_min_withdrawal(v, p_units, (select unit_price from pool_equity order by id desc limit 1), _last_php_rate());
  end if;
  v_by := add_business_days(current_date, (_setting('withdrawal_business_days'))::int);
  insert into withdrawal_requests(profile_id, units, note, pay_by) values (v, p_units, p_note, v_by);
  return jsonb_build_object('pay_by', v_by);
end $$;

revoke all on function public.my_payout(text), public.set_my_payout(text, text, text, text, text, text), public.admin_payouts(text) from public;
grant execute on function public.my_payout(text), public.set_my_payout(text, text, text, text, text, text), public.admin_payouts(text),
  public.request_withdrawal(text, numeric, text) to anon, authenticated;

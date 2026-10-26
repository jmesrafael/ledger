-- Payout details: not just GCash or a bank. An investor can now choose how to be paid from: bank transfer, GCash, Maya, GoTyme, or "other"
-- (any other bank or e-wallet). NOT applied to any database. Safe to run twice. Run after 20261104000000_payout_details_no_exit_fee.sql.
--   * payout_details.method accepts 'bank', 'gcash', 'maya', 'gotyme', 'other' (existing 'gcash' and 'bank' rows are unchanged).
--   * 'bank' and 'other' also need a name (the bank, or the e-wallet) in bank_name; the others do not.
--   * GCash and Maya take a mobile number; bank, GoTyme and other take an account number. The optional QR image (GCash, Maya, GoTyme, InstaPay, QR Ph)
--     works exactly as before: PNG, JPG or WebP, up to 2 MB, stored in the payout-qr bucket.
-- Only this check and set_my_payout change. Nothing about money, units or fees is touched.

do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.payout_details'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%method%' loop
    execute format('alter table public.payout_details drop constraint %I', c);
  end loop;
end $$;
alter table public.payout_details add constraint payout_details_method_check check (method in ('bank', 'gcash', 'maya', 'gotyme', 'other'));

create or replace function public.set_my_payout(p_token text, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token);
begin
  if p_method is null or p_method not in ('bank', 'gcash', 'maya', 'gotyme', 'other') then raise exception 'choose how you want to be paid'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'enter the account name'; end if;
  if length(trim(coalesce(p_number, ''))) < 4 then
    raise exception 'enter the % number', case when p_method in ('gcash', 'maya') then 'mobile' else 'account' end;
  end if;
  if p_method in ('bank', 'other') and length(trim(coalesce(p_bank, ''))) < 2 then raise exception 'enter the name of the bank or e-wallet'; end if;
  if p_qr is not null and p_qr !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then raise exception 'invalid QR image'; end if;
  insert into payout_details(profile_id, method, account_name, account_number, bank_name, qr_path)
  values (v, p_method, trim(p_name), trim(p_number), case when p_method in ('bank', 'other') then trim(p_bank) end, p_qr)
  on conflict (profile_id) do update set method = excluded.method, account_name = excluded.account_name, account_number = excluded.account_number,
    bank_name = excluded.bank_name, qr_path = excluded.qr_path, updated_at = now();
end $$;

revoke all on function public.set_my_payout(text, text, text, text, text, text) from public;
grant execute on function public.set_my_payout(text, text, text, text, text, text) to anon, authenticated;

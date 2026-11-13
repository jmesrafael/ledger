-- Payout details: the investor types their own label (for example GCash, Bank transfer, GoTyme, Maya, "BDO bank transfer") instead of choosing
-- GCash or bank from a fixed pair. NOT applied to any database. Safe to run twice. Run after 20261104000000_payout_details_no_exit_fee.sql.
--   * payout_details.method becomes free text, 2 to 40 characters (existing 'gcash' and 'bank' rows are unchanged and still shown as GCash / Bank transfer).
--   * The number is one field: a mobile number (GCash, Maya) or a bank / e-wallet account number.
--   * The optional QR image (GCash, Maya, GoTyme, InstaPay, QR Ph) works exactly as before: PNG, JPG or WebP, up to 2 MB, stored in the payout-qr bucket.
-- Only this check and set_my_payout change. Nothing about money, units or fees is touched.

do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.payout_details'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%method%' loop
    execute format('alter table public.payout_details drop constraint %I', c);
  end loop;
end $$;
alter table public.payout_details add constraint payout_details_method_check check (length(btrim(method)) between 2 and 40);

create or replace function public.set_my_payout(p_token text, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token);
begin
  if length(trim(coalesce(p_method, ''))) < 2 then raise exception 'enter how you want to be paid (for example GCash, bank transfer, GoTyme or Maya)'; end if;
  if length(trim(p_method)) > 40 then raise exception 'that label is too long (40 characters at most)'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'enter the account name'; end if;
  if length(trim(coalesce(p_number, ''))) < 4 then raise exception 'enter the mobile number or account number'; end if;
  if p_qr is not null and p_qr !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then raise exception 'invalid QR image'; end if;
  insert into payout_details(profile_id, method, account_name, account_number, bank_name, qr_path)
  values (v, trim(p_method), trim(p_name), trim(p_number), nullif(trim(coalesce(p_bank, '')), ''), p_qr)
  on conflict (profile_id) do update set method = excluded.method, account_name = excluded.account_name, account_number = excluded.account_number,
    bank_name = excluded.bank_name, qr_path = excluded.qr_path, updated_at = now();
end $$;

revoke all on function public.set_my_payout(text, text, text, text, text, text) from public;
grant execute on function public.set_my_payout(text, text, text, text, text, text) to anon, authenticated;

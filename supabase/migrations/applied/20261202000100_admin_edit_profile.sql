-- The fund manager edits ANYTHING in a person's profile, so a complaint is one visit to their sheet: the name, fee rate, active flag, password and contact details
-- already had admin functions; this adds the two that were missing, the username and the payout details (the investor's own versions are set_my_* / change_my_username).
-- Nothing about money, units or fees is touched. Safe to run twice. Run after 20261202000000_profile_self_edit.sql and 20261115000000_payout_methods.sql.
--   * admin_set_username: no password needed (the manager is fixing it for them), same rule as the table (3 to 30 of a-z 0-9 . _ -, lower case), refused when taken,
--     audit entry username_changed with the manager as the actor. The person's open sessions stay valid; they sign in with the new name next time.
--   * admin_set_payout: the same checks as set_my_payout (free-text label, account name, number, optional QR path of this form). The audit entry names the fields that
--     changed, never the account number.

create or replace function public.admin_set_username(p_token text, p_profile uuid, p_username text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_actor uuid := _admin(p_token); u text := lower(btrim(coalesce(p_username, ''))); old text;
begin
  select username into old from profiles where id = p_profile;
  if not found then raise exception 'unknown person'; end if;
  if u !~ '^[a-z0-9_.-]{3,30}$' then raise exception 'the username must be 3 to 30 characters: lower case letters, numbers, dot, dash or underscore'; end if;
  if u = old then return u; end if;
  if exists (select 1 from profiles where username = u) then raise exception 'that username is already taken'; end if;
  perform set_config('ledger.actor', v_actor::text, true);
  update profiles set username = u where id = p_profile;
  perform _audit(v_actor, 'username_changed', p_profile, jsonb_build_object('from', old, 'to', u));
  return u;
end $$;

create or replace function public.admin_set_payout(p_token text, p_profile uuid, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_actor uuid := _admin(p_token); old payout_details%rowtype; v_fields text[] := '{}';
begin
  if not exists (select 1 from profiles where id = p_profile) then raise exception 'unknown person'; end if;
  if length(trim(coalesce(p_method, ''))) < 2 then raise exception 'enter how they want to be paid (for example GCash, bank transfer, GoTyme or Maya)'; end if;
  if length(trim(p_method)) > 40 then raise exception 'that label is too long (40 characters at most)'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'enter the account name'; end if;
  if length(trim(coalesce(p_number, ''))) < 4 then raise exception 'enter the mobile number or account number'; end if;
  if p_qr is not null and p_qr !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then raise exception 'invalid QR image'; end if;
  select * into old from payout_details where profile_id = p_profile;
  if found then
    if old.method is distinct from trim(p_method) then v_fields := array_append(v_fields, 'label'::text); end if;
    if old.account_name is distinct from trim(p_name) then v_fields := array_append(v_fields, 'account name'::text); end if;
    if old.account_number is distinct from trim(p_number) then v_fields := array_append(v_fields, 'account number'::text); end if;
    if old.qr_path is distinct from p_qr then v_fields := array_append(v_fields, 'QR'::text); end if;
    if cardinality(v_fields) = 0 then return; end if;                 -- nothing changed
  else v_fields := array['label', 'account name', 'account number', 'QR']; end if;
  insert into payout_details(profile_id, method, account_name, account_number, bank_name, qr_path)
  values (p_profile, trim(p_method), trim(p_name), trim(p_number), nullif(trim(coalesce(p_bank, '')), ''), p_qr)
  on conflict (profile_id) do update set method = excluded.method, account_name = excluded.account_name, account_number = excluded.account_number,
    bank_name = excluded.bank_name, qr_path = excluded.qr_path, updated_at = now();
  perform _audit(v_actor, 'payout_details_changed', p_profile, jsonb_build_object('fields', to_jsonb(v_fields)));
end $$;

revoke all on function public.admin_set_username(text, uuid, text), public.admin_set_payout(text, uuid, text, text, text, text, text) from public;
grant execute on function public.admin_set_username(text, uuid, text), public.admin_set_payout(text, uuid, text, text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

-- "View as": the fund manager can now ADD AND EDIT an investor's own name, contact details and withdrawal details while viewing as them, like the signed-in person.
-- Everything else stays refused in a view-as session (_me_rw): changing the password or username (they need the person's own password; the manager has the admin forms),
-- agreeing to the terms, and requesting a withdrawal. Nothing about money, units or fees is touched. Safe to run twice.
-- Run after 20261202000000_profile_self_edit.sql and 20261202000100_admin_edit_profile.sql.
--   * _me_edit(token): like _me, and when the session is a view-as session the audit actor becomes the MANAGER (sessions.impersonated_by), so the audit log says who really did it.
--   * set_my_contact, set_my_name, set_my_payout use it. set_my_payout and admin_set_payout share _payout_save, which writes the audit entry
--     payout_details_changed (the fields that changed, never the account number).

create or replace function public._me_edit(p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token); a uuid;
begin
  select s.impersonated_by into a from sessions s where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if a is not null then perform set_config('ledger.actor', a::text, true); end if;     -- this transaction only
  return v;
end $$;

create or replace function public._actor_of(p_token text)
returns uuid language sql stable security definer set search_path = public, extensions as $$
  select coalesce(s.impersonated_by, s.profile_id) from sessions s where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function public._payout_save(p_profile uuid, p_actor uuid, p_method text, p_name text, p_number text, p_bank text, p_qr text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare old payout_details%rowtype; v_fields text[] := '{}';
begin
  if not exists (select 1 from profiles where id = p_profile) then raise exception 'unknown person'; end if;
  if length(trim(coalesce(p_method, ''))) < 2 then raise exception 'enter how you want to be paid (for example GCash, bank transfer, GoTyme or Maya)'; end if;
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
  perform _audit(p_actor, 'payout_details_changed', p_profile, jsonb_build_object('fields', to_jsonb(v_fields)));
end $$;

create or replace function public.admin_set_payout(p_token text, p_profile uuid, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_actor uuid := _admin(p_token);
begin
  perform _payout_save(p_profile, v_actor, p_method, p_name, p_number, p_bank, p_qr);
end $$;

create or replace function public.set_my_payout(p_token text, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_edit(p_token);
begin
  perform _payout_save(v, _actor_of(p_token), p_method, p_name, p_number, p_bank, p_qr);
end $$;

create or replace function public.set_my_contact(p_token text, p_phone text, p_email text default null, p_emergency_name text default null, p_emergency_phone text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_edit(p_token);
begin
  perform _contact_save(v, p_phone, p_email, p_emergency_name, p_emergency_phone, _actor_of(p_token));
end $$;

create or replace function public.set_my_name(p_token text, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_edit(p_token); n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if char_length(n) < 2 or char_length(n) > 80 then raise exception 'your name must be 2 to 80 characters'; end if;
  update profiles set name = n where id = v;
end $$;

-- internal helpers: NOT callable from the website (Supabase grants new functions to anon by default, so it is revoked by name, like _me_rw and _audit)
revoke all on function public._me_edit(text), public._actor_of(text), public._payout_save(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_set_payout(text, uuid, text, text, text, text, text), public.set_my_payout(text, text, text, text, text, text),
  public.set_my_contact(text, text, text, text, text), public.set_my_name(text, text) from public;
grant execute on function public.admin_set_payout(text, uuid, text, text, text, text, text), public.set_my_payout(text, text, text, text, text, text),
  public.set_my_contact(text, text, text, text, text), public.set_my_name(text, text) to anon, authenticated;

notify pgrst, 'reload schema';

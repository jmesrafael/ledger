-- Undo 20261202000200_view_as_edit_profile.sql: view-as sessions are read-only again, and set_my_payout / set_my_contact / set_my_name go back to _me_rw.
-- admin_set_payout keeps working (its own copy of the checks is restored below). Nothing already saved changes.
create or replace function public.set_my_contact(p_token text, p_phone text, p_email text default null, p_emergency_name text default null, p_emergency_phone text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token);
begin
  perform _contact_save(v, p_phone, p_email, p_emergency_name, p_emergency_phone, v);
end $$;

create or replace function public.set_my_name(p_token text, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token); n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if char_length(n) < 2 or char_length(n) > 80 then raise exception 'your name must be 2 to 80 characters'; end if;
  perform set_config('ledger.actor', v::text, true);
  update profiles set name = n where id = v;
end $$;

create or replace function public.set_my_payout(p_token text, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token);
begin
  perform _payout_save(v, v, p_method, p_name, p_number, p_bank, p_qr);
end $$;

notify pgrst, 'reload schema';

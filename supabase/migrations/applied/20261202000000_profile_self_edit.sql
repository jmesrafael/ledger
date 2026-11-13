-- Profile page: a signed-in person changes their own display name and their own username. Password, contact details and payout details already had
-- their own functions (change_my_password, set_my_contact, set_my_payout). Nothing about money, units or fees is touched. Safe to run twice.
--   * set_my_name: 2 to 80 characters, spaces tidied. The existing audit trigger records it as name_changed.
--   * change_my_username: needs the CURRENT password (a stolen open session cannot take over the login), the same rule the table enforces
--     (3 to 30 of a-z 0-9 . _ -, stored lower case), refused when taken, written to the audit log as username_changed.
-- Both are refused while the fund manager is "viewing as" someone (_me_rw).

create or replace function public.set_my_name(p_token text, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token); n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if char_length(n) < 2 or char_length(n) > 80 then raise exception 'your name must be 2 to 80 characters'; end if;
  perform set_config('ledger.actor', v::text, true);
  update profiles set name = n where id = v;
end $$;

create or replace function public.change_my_username(p_token text, p_password text, p_username text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v uuid := _me_rw(p_token); u text := lower(btrim(coalesce(p_username, ''))); h text; old text;
begin
  select pass_hash, username into h, old from profiles where id = v;
  if h is null or h <> crypt(coalesce(p_password, ''), h) then raise exception 'current password is wrong'; end if;
  if u !~ '^[a-z0-9_.-]{3,30}$' then raise exception 'the username must be 3 to 30 characters: lower case letters, numbers, dot, dash or underscore'; end if;
  if u = old then return u; end if;
  if exists (select 1 from profiles where username = u) then raise exception 'that username is already taken'; end if;
  perform set_config('ledger.actor', v::text, true);
  update profiles set username = u where id = v;
  perform _audit(v, 'username_changed', v, jsonb_build_object('from', old, 'to', u));
  return u;
end $$;

revoke all on function public.set_my_name(text, text), public.change_my_username(text, text, text) from public;
grant execute on function public.set_my_name(text, text), public.change_my_username(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

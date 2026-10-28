-- Undo 20261202000100_admin_edit_profile.sql. Usernames and payout details already changed stay as they are.
drop function if exists public.admin_set_username(text, uuid, text);
drop function if exists public.admin_set_payout(text, uuid, text, text, text, text, text);
notify pgrst, 'reload schema';

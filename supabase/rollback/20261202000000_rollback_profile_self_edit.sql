-- Undo 20261202000000_profile_self_edit.sql. Names and usernames already changed stay as they are.
drop function if exists public.set_my_name(text, text);
drop function if exists public.change_my_username(text, text, text);
notify pgrst, 'reload schema';

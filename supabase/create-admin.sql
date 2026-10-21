-- ONE-TIME: create the manager login. Run in the Supabase SQL Editor after the migration.
-- 1) Change the three values below (username: lowercase letters/numbers; password: at least 8 characters).
-- 2) Run it. 3) Do NOT save or commit this file with your real password in it.
select public.create_first_admin('raf', 'Your Name', 'CHANGE-THIS-PASSWORD');

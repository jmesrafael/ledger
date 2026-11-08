-- Rollback of 20261210000000_deposit_pesos.sql: removes the three functions. KEEPS deposit_pesos and its rows (the pesos recorded, who recorded them and why),
-- its append-only trigger, and the backup export that carries it. Nothing else is touched. Safe to run twice; the migration can be applied again.
drop function if exists public.admin_record_deposit_pesos(text, bigint, numeric, text, text);
drop function if exists public.admin_deposit_pesos(text);
drop function if exists public.my_deposit_pesos(text);
notify pgrst, 'reload schema';

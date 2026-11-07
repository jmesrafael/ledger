-- Rollback of 20261210000000_peso_topup.sql: removes the two functions. Top-ups already recorded stay in the ledger (records are never rewritten); undo one with the
-- normal "Delete" on its pool entry if needed. The flow_checkpoints kind 'reallocation' is kept (20261209 needs it too, and existing checkpoints may use it).
drop function if exists public.admin_quote_peso_topup(text, uuid, numeric, numeric, text);
drop function if exists public.admin_peso_topup(text, uuid, numeric, numeric, text, text);
notify pgrst, 'reload schema';

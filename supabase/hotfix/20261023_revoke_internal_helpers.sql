-- HOTFIX (independent of every migration): close a live exposure. NOT applied to any database.
--
-- Supabase gives every new function in the public schema to the public website role (anon) and to signed-in users (authenticated) unless it is
-- revoked. Four internal helpers were left that way by earlier migrations. They take no token, so anyone holding the public key (it is in the page
-- source of the app) can call them through the REST API:
--   _export_all()                       the WHOLE ledger export: people (no passwords), every pool entry, ledger row, deposit, withdrawal request,
--                                       settlement, balance check, payout record and the activity log
--   _account_since(uuid)                a person's account start date
--   _check_min_withdrawal(...)          the minimum-withdrawal rule for a person
--   _exit_fee_rate(uuid)                the withdrawal-fee rate for a person
-- The app's own functions (admin_export_all, backup_export, exit_fee_info, request_withdrawal, ...) run as the database owner, so they keep working.
--
-- Safe to run twice. Takes effect immediately. UNDO (only if something unexpected breaks; it re-opens the exposure):
--   grant execute on function public._export_all(), public._account_since(uuid), public._check_min_withdrawal(uuid, numeric, numeric, numeric),
--     public._exit_fee_rate(uuid) to anon, authenticated;
-- Migration 20261109000000_settlement_controls_backup.sql contains the same four revokes, so applying it also closes the exposure.

revoke all on function public._export_all() from public, anon, authenticated;
revoke all on function public._account_since(uuid) from public, anon, authenticated;
revoke all on function public._check_min_withdrawal(uuid, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public._exit_fee_rate(uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';

-- Check afterwards (expect: none):
--   select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_%' and has_function_privilege('anon', p.oid, 'execute');

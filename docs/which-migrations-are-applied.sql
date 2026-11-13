-- READ-ONLY. Paste into the Supabase SQL Editor and Run. It changes nothing: it only asks the database whether each migration's own objects exist.
-- Updated Nov 13 2026. Every file in supabase/migrations/applied/ (up to 20261213000000_live_nav.sql) is already on the live database.
-- This check covers only the migrations that are NOT applied yet or were written most recently.
-- applied = true means that migration (or what it creates) is already in this database. applied = false means it has not been run (it waits for the owner).
select * from (values
  (1, '20261114000000_fee_20 (default fee 20%, owner decision N6)',            coalesce((select value::numeric from public.ledger_settings where key = 'default_fee_rate'), 0) >= 0.2),
  (2, '20261209000000_admission_spread (owner decision N8)',                    to_regclass('public.admission_spreads') is not null),
  (3, '20261213000000_live_nav (applied on live since Nov 12 2026)',            to_regclass('public.nav_snapshots') is not null),
  (4, '20261214000000_auto_settlement (automatic two-month settlement)',        to_regprocedure('public._settle_auto(text)') is not null),
  (5, '20261215000000_retire_unused_functions (closes retired functions)',      to_regprocedure('public._retired_functions()') is not null)
) as t(step, migration, applied) order by step;

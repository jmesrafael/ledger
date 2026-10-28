-- Undo 20261201000100_wallet_snapshot_cleanup.sql: stops the daily cleanup. Deleted rows are not restored. pg_cron is left installed.
select cron.unschedule('purge-wallet-snapshots') where exists (select 1 from cron.job where jobname = 'purge-wallet-snapshots');
drop function if exists public.purge_old_wallet_snapshots(integer);

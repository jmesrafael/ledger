-- Wallet snapshot cleanup: the bots report every 5 minutes (about 17,000 rows a month), so rows older than 30 days are deleted once a day.
-- Never deleted: the newest report of each wallet (bot_post_wallet_snapshot uses it for replay protection and the jump check) and any suspect report
-- (kept as the audit trail of a big jump and of who accepted it). Safe to run twice. Undo: supabase/rollback/20261201000100_rollback_wallet_snapshot_cleanup.sql.
-- The daily schedule needs the pg_cron extension (Supabase has it). Where it is not available (the local test database) only the function is created.

create or replace function public.purge_old_wallet_snapshots(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if p_days is null or p_days < 7 then raise exception 'keep at least 7 days of wallet snapshots'; end if;
  delete from wallet_snapshots w
   where w.received_at < now() - make_interval(days => p_days)
     and not w.suspect
     and w.id <> (select l.id from wallet_snapshots l where l.wallet = w.wallet order by l.seq desc limit 1);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.purge_old_wallet_snapshots(integer) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule('purge-wallet-snapshots') where exists (select 1 from cron.job where jobname = 'purge-wallet-snapshots');
    perform cron.schedule('purge-wallet-snapshots', '15 3 * * *', 'select public.purge_old_wallet_snapshots(30)');
  else
    raise notice 'pg_cron is not available: the cleanup function exists but is not scheduled';
  end if;
end $$;

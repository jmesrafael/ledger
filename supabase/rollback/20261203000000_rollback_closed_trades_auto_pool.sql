-- Undo 20261203000000_closed_trades_auto_pool.sql. Valuations already written to pool_equity stay (they are ordinary entries); the closed_trades records are DROPPED:
-- take a backup first (scripts/backup-ledger.mjs) if you want to keep them. Safe to run twice.
update public.ledger_settings set value = 'off' where key = 'auto_pool_mode';
do $$
begin
  if to_regprocedure('public._bot_post_wallet_snapshot_core(text,text,bigint,timestamptz,numeric,numeric,numeric,numeric,int,int)') is not null then
    drop function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int);
    alter function public._bot_post_wallet_snapshot_core(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) rename to bot_post_wallet_snapshot;
    grant execute on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) to anon, authenticated;
  end if;
  if to_regprocedure('public._export_extra_pre_trades()') is not null then
    drop function public._export_extra();
    alter function public._export_extra_pre_trades() rename to _export_extra;
  end if;
end $$;
drop function if exists public.admin_closed_trades(text, int);
drop function if exists public.bot_post_closed_trade(text, text, text, text, text, timestamptz, numeric, numeric, numeric, numeric);
drop function if exists public._auto_pool_value(text);
drop function if exists public._auto_skip(text, text, text);
drop table if exists public.auto_pool_runs;
drop table if exists public.closed_trades;
drop function if exists public._closed_trade_guard();
delete from public.ledger_settings where key in ('auto_pool_mode', 'auto_pool_min_minutes', 'auto_pool_heartbeat_minutes', 'auto_pool_pause_on_payout');
notify pgrst, 'reload schema';

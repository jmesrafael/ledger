-- Lucid'io bot dashboard: ETH_USDT replaces ZEC_USDT as the bots' fifth coin (ZEC is being delisted; study: StrategyBacktester research/zec-replacement).
-- ZEC_USDT stays allowed: the bots finish the ZEC trades still open and the history keeps its ZEC rows.
-- Only the symbol check on bot_events changes: no data is touched, no LEDGER table or function is touched, and no table is added. Safe to run twice.
-- Applied to the production database on Nov 12, 2026 (before the bots started trading ETH).
-- ORDER MATTERS: run this and deploy the website (lib/schema.js) BEFORE the VPS bots trade ETH. The website rejects any event or
-- heartbeat that names a symbol it does not know.
do $$ begin
  if to_regclass('public.bot_events') is null then raise exception 'preflight: run 20261111000000_bot_events.sql first. Nothing was changed.'; end if;
end $$;

alter table public.bot_events drop constraint if exists bot_events_symbol_check;
alter table public.bot_events add constraint bot_events_symbol_check
  check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT','NEAR_USDT','ADA_USDT','GALA_USDT','ETH_USDT'));

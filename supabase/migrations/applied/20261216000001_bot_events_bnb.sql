-- Lucid'io bot dashboard: BNB_USDT for T-CORE (live), added Nov 14, 2026 with the rules v3 upgrade.
-- Study: StrategyBacktester research/tweak-lab-nov13 (T-CORE rules v3 + BNB: +271R more profit over 2020-2026, worst drop 34R -> 40R; ledger report bot-improvements).
-- Only the symbol check on bot_events changes: no data is touched, no LEDGER table or function is touched, and no table is added. Safe to run twice.
-- ORDER MATTERS: run this and deploy the website (lib/schema.js) BEFORE T-CORE trades BNB on the VPS. The website rejects any event or
-- heartbeat that names a symbol it does not know.
do $$ begin
  if to_regclass('public.bot_events') is null then raise exception 'preflight: run 20261111000000_bot_events.sql first. Nothing was changed.'; end if;
end $$;

alter table public.bot_events drop constraint if exists bot_events_symbol_check;
alter table public.bot_events add constraint bot_events_symbol_check
  check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT','NEAR_USDT','ADA_USDT','GALA_USDT','ETH_USDT','SUI_USDT','ARB_USDT','BNB_USDT'));

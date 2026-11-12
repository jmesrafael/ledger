-- Undo 20261212000000_bot_events_sui_arb.sql: put the six-coin symbol check back (no SUI_USDT, ARB_USDT). Nothing else is touched.
-- This FAILS on purpose while any SUI_USDT or ARB_USDT row is stored (a check cannot be added over rows that break it), so no data is lost silently.
-- To go back anyway, first remove those rows (run the delete below on purpose), then run the rest:
--   delete from public.bot_events where symbol in ('SUI_USDT','ARB_USDT');
alter table public.bot_events drop constraint if exists bot_events_symbol_check;
alter table public.bot_events add constraint bot_events_symbol_check
  check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT','NEAR_USDT','ADA_USDT','GALA_USDT','ETH_USDT'));

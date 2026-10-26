-- Undo 20261116000000_bot_events_more_symbols.sql: put the two-coin symbol check back. Nothing else is touched.
-- This FAILS on purpose while any NEAR_USDT or ADA_USDT row is stored (a check cannot be added over rows that break it), so no data is lost silently.
-- To go back anyway, first remove those rows (run the delete below on purpose), then run the rest:
--   delete from public.bot_events where symbol in ('NEAR_USDT','ADA_USDT');
alter table public.bot_events drop constraint if exists bot_events_symbol_check;
alter table public.bot_events add constraint bot_events_symbol_check
  check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT'));

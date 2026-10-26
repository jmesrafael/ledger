-- Undo 20261126000000_bot_events_gala.sql: put the four-coin symbol check back. Nothing else is touched.
-- This FAILS on purpose while any GALA_USDT row is stored (a check cannot be added over rows that break it), so no data is lost silently.
-- To go back anyway, first remove those rows (run the delete below on purpose), then run the rest:
--   delete from public.bot_events where symbol = 'GALA_USDT';
alter table public.bot_events drop constraint if exists bot_events_symbol_check;
alter table public.bot_events add constraint bot_events_symbol_check
  check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT','NEAR_USDT','ADA_USDT'));

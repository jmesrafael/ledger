-- Lucid'io bot dashboard: the bot now also trades GALA_USDT, so bot_events must accept it alongside SOL_USDT, ZEC_USDT, NEAR_USDT and ADA_USDT.
-- Only the symbol check on bot_events changes: no data is touched, no LEDGER table or function is touched, and no table is added. Safe to run twice.
-- NOT applied to any database. Run 20261111000000_bot_events.sql and 20261116000000_bot_events_more_symbols.sql first.
-- ORDER MATTERS: run this and deploy the website (lib/schema.js) BEFORE the VPS bot starts trading GALA. The website rejects any event or
-- heartbeat that names a symbol it does not know, so a five-coin bot talking to an old website would lose its dashboard updates.
do $$ begin
  if to_regclass('public.bot_events') is null then raise exception 'preflight: run 20261111000000_bot_events.sql first. Nothing was changed.'; end if;
end $$;

alter table public.bot_events drop constraint if exists bot_events_symbol_check;
alter table public.bot_events add constraint bot_events_symbol_check
  check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT','NEAR_USDT','ADA_USDT','GALA_USDT'));

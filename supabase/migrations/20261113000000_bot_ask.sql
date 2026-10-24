-- Lucid'io bot dashboard: the "Ask bot now" button. A click stores one small row (type 'ask') in bot_events; the bot, which polls outbound, claims it
-- (type becomes 'ask_done') and answers with an immediate heartbeat. Only bot_events changes: it does NOT touch any LEDGER table or function, and it adds no new
-- table, so the ledger backup-coverage check is unaffected. NOT applied to any database. Safe to run twice. Run 20261111000000_bot_events.sql first.
do $$ begin
  if to_regclass('public.bot_events') is null then raise exception 'preflight: run 20261111000000_bot_events.sql first. Nothing was changed.'; end if;
end $$;

alter table public.bot_events drop constraint if exists bot_events_type_check;
alter table public.bot_events add constraint bot_events_type_check
  check (type in ('heartbeat','signal','entry','exit','equity','compare','ask','ask_done'));

-- optional housekeeping (ask rows are tiny; heartbeats now arrive about 6 times a day, plus one per click):
--   delete from public.bot_events where type in ('ask','ask_done') and ts_ms < (extract(epoch from now() - interval '7 days') * 1000)::bigint;
--   delete from public.bot_events where type = 'heartbeat' and ts_ms < (extract(epoch from now() - interval '14 days') * 1000)::bigint;

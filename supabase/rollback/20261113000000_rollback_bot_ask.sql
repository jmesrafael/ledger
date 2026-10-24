-- Undo 20261113000000_bot_ask.sql: remove the ask rows and put the original type list back. Nothing else is touched.
delete from public.bot_events where type in ('ask','ask_done');
alter table public.bot_events drop constraint if exists bot_events_type_check;
alter table public.bot_events add constraint bot_events_type_check
  check (type in ('heartbeat','signal','entry','exit','equity','compare'));

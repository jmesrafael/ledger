-- Lucid'io hosted dashboard: the table the bot's signed events are stored in (written ONLY by /api/ingest with the service-role key).
-- Run once in the Supabase SQL editor (or `supabase db push`). It does not touch any LEDGER table.
create table if not exists public.bot_events (
  event_id    text primary key,                     -- unique per event: a repeated push is ignored (on conflict do nothing)
  type        text not null check (type in ('heartbeat','signal','entry','exit','equity','compare')),
  ts_ms       bigint not null,
  mode        text not null check (mode in ('paper','live')),
  symbol      text check (symbol is null or symbol in ('SOL_USDT','ZEC_USDT')),
  side        text check (side is null or side in ('LONG','SHORT')),
  data        jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
create index if not exists bot_events_ts_idx   on public.bot_events (ts_ms desc);
create index if not exists bot_events_type_idx on public.bot_events (type, ts_ms desc);

-- locked down: RLS on and NO policy, so the public (anon / publishable) key can neither read nor write. Only the service-role key (Vercel env) can.
alter table public.bot_events enable row level security;
revoke all on public.bot_events from anon, authenticated;

-- optional housekeeping: heartbeats arrive every 5 minutes (about 288 a day); keep 14 days
--   delete from public.bot_events where type = 'heartbeat' and ts_ms < (extract(epoch from now() - interval '14 days') * 1000)::bigint;

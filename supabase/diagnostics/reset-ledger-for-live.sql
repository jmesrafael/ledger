-- Lucid'io LEDGER: reset to a clean slate for live. Run ONCE in the Supabase SQL editor (project vkfetsmnlylcsbwxcord).
-- DESTRUCTIVE and not undoable. A JSON backup of the rows was taken on 2026-10-23 (ledger-backup-2026-10-23.json).
--
-- EMPTIES: ledger, lot_log, holder_lots, pending_deposits, pool_equity, audit_log, the draft archives, investor_hwm, hwm_log,
--          holder_state, terms_acceptances, withdrawal_requests, corrections, capital_events, period_log, settlements,
--          settlement_lines, payout_records.
-- DELETES: every profile whose role is not 'admin' (investor1..3) and their sessions.
-- KEEPS:   the manager account (role 'admin', raf) and its sessions, ledger_settings (the rules), the schema, RLS, functions,
--          and bot_events (live bot data from the bot dashboard).
--
-- TRUNCATE is used because ledger, pool_equity and audit_log have append-only triggers that block DELETE.
-- The audit_log is wiped too (the old history is only in the JSON backup).

begin;

-- safety stop: abort the whole thing if there is no admin account to keep
do $$
begin
  if not exists (select 1 from public.profiles where role = 'admin' and active) then
    raise exception 'no active admin profile found, nothing was changed';
  end if;
end $$;

truncate table
  public.ledger, public.lot_log, public.holder_lots, public.pending_deposits, public.pool_equity, public.audit_log,
  public.investor_perf_draft_archive, public.perf_log_draft_archive, public.investor_hwm, public.hwm_log,
  public.holder_state, public.terms_acceptances, public.withdrawal_requests, public.corrections, public.capital_events,
  -- tables with a foreign key to the ones above (all empty today, but Postgres needs them in the same TRUNCATE)
  public.period_log, public.settlements, public.settlement_lines, public.payout_records
  restart identity;

delete from public.sessions where profile_id in (select id from public.profiles where role <> 'admin');
delete from public.profiles where role <> 'admin';

commit;

-- check: expect 1 profile (the admin), 0 in every data table, ledger_settings unchanged (34), bot_events untouched
select
  (select string_agg(username || ':' || role, ', ') from public.profiles) as profiles_left,
  (select count(*) from public.ledger)            as ledger,
  (select count(*) from public.pool_equity)       as pool_equity,
  (select count(*) from public.holder_lots)       as holder_lots,
  (select count(*) from public.pending_deposits)  as pending_deposits,
  (select count(*) from public.audit_log)         as audit_log,
  (select count(*) from public.sessions)          as sessions_left,
  (select count(*) from public.ledger_settings)   as ledger_settings,
  (select count(*) from public.bot_events)        as bot_events;

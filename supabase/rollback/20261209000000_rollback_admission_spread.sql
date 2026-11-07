-- Rollback of 20261209000000_admission_spread.sql.
-- Refused while a p2p spread still has a deposit waiting (admit both, or hand both back, first): without the commit-time check its two parts could be separated.
-- Removes the functions, the together-check and the two settings. KEEPS admission_spreads and its rows (append-only evidence of every credited amount, rate and surplus,
-- like book_corrections and fx_reference_rates), keeps its append-only trigger, and leaves the backup export carrying it. flow_checkpoints keeps accepting the kind
-- 'reallocation' (harmless; the checkpoints already written stay readable). No ledger, pool, deposit or setting other than the two below is touched.
-- Safe to run twice; the migration can be applied again afterwards.
do $$ begin
  if to_regclass('public.admission_spreads') is not null and exists (
    select 1 from public.admission_spreads s join public.pending_deposits p on p.id in (s.investor_pending_id, s.manager_pending_id) where p.status = 'pending') then
    raise exception 'an admission spread still has a waiting deposit: admit or hand back both parts first';
  end if;
end $$;

drop trigger if exists spread_legs_together on public.pending_deposits;
drop function if exists public._spread_legs_together();
drop function if exists public.admin_admission_spread(text, uuid, numeric, numeric, numeric, numeric, text, text, boolean, text);
drop function if exists public.admin_quote_admission_spread(text, uuid, numeric, numeric, numeric, numeric, text);
drop function if exists public.admin_admit_admission_spread_tv(text, bigint, timestamptz, text);
drop function if exists public.admin_cancel_admission_spread(text, bigint);
drop function if exists public.admin_admission_spreads(text);
drop function if exists public._spread_check(numeric, numeric, numeric, numeric);
delete from public.ledger_settings where key in ('admission_spread_php', 'admission_rate_tolerance');
notify pgrst, 'reload schema';

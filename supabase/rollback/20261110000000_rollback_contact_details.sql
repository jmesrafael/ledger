-- ROLLBACK of 20261110000000_contact_details.sql. NOT applied to any database. Roll this back BEFORE rolling back 20261109 (1109's rollback drops
-- _export_extra, which this file puts back to its 1109 form).
--
-- WHAT IT DOES: removes the contact tables, functions, the withdrawal gate trigger and the setting; puts _export_extra back to what 1109 defined.
-- WHEN IT REFUSES: as soon as one person's contact details have been saved. Those are people's personal details and their change history; dropping the
-- tables would destroy them. Export them first (the backup contains both tables), then drop by hand if you really want them gone.
-- It keeps the revoke on _export_all / _export_all_core on purpose: rolling back must never re-open that exposure.

do $$
begin
  if to_regclass('public.contact_details') is null then
    raise exception 'nothing to roll back: 20261110 is not applied here. Nothing was changed.';
  end if;
  if exists (select 1 from public.contact_details) or exists (select 1 from public.contact_history) then
    raise exception 'rollback refused: contact details have been saved. Take a backup, then decide by hand what to keep. Nothing was changed.';
  end if;
end $$;

drop trigger if exists contact_gate on public.withdrawal_requests;
drop function if exists public._contact_gate();
drop function if exists public.my_contact(text);
drop function if exists public.set_my_contact(text, text, text, text, text);
drop function if exists public.admin_set_contact(text, uuid, text, text, text, text);
drop function if exists public.admin_contacts(text);
drop function if exists public.admin_contact_history(text, uuid);
drop function if exists public._contact_save(uuid, text, text, text, text, uuid);
drop function if exists public._contact_clean(text, text, text, text);

create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payout_details', _dump_table('payout_details'),
    'idempotency_keys', _dump_table('idempotency_keys'),
    'holder_state', _dump_table('holder_state'),
    'investor_perf_draft_archive', _dump_table('investor_perf_draft_archive'),
    'perf_log_draft_archive', _dump_table('perf_log_draft_archive'),
    'settlement_exceptions', _dump_table('settlement_exceptions'))
$$;
revoke all on function public._export_extra() from public, anon, authenticated;

drop table if exists public.contact_history;
drop table if exists public.contact_details;
delete from public.ledger_settings where key = 'contact_required_for_withdrawal';
notify pgrst, 'reload schema';

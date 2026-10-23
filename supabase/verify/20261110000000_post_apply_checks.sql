-- READ-ONLY verification for 20261110000000_contact_details.sql. Changes nothing. Run after applying; every row must say PASS.
with checks(name, ok) as (values
  ('contact_details table exists', to_regclass('public.contact_details') is not null),
  ('contact_history table exists', to_regclass('public.contact_history') is not null),
  ('contact tables are closed to the website', not has_table_privilege('anon', 'public.contact_details', 'select') and not has_table_privilege('anon', 'public.contact_history', 'select')
                                                and not has_table_privilege('authenticated', 'public.contact_details', 'select')),
  ('row level security is on for both', (select bool_and(relrowsecurity) from pg_class where oid in ('public.contact_details'::regclass, 'public.contact_history'::regclass))),
  ('the history is append-only (trigger present)', exists (select 1 from pg_trigger where tgname = 'contact_history_append_only' and not tgisinternal)),
  ('the withdrawal gate trigger is present', exists (select 1 from pg_trigger where tgname = 'contact_gate' and not tgisinternal)),
  ('the gate setting exists (off until everyone has added theirs)', exists (select 1 from public.ledger_settings where key = 'contact_required_for_withdrawal')),
  ('the website can call the five contact functions', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('my_contact', 'set_my_contact', 'admin_set_contact', 'admin_contacts', 'admin_contact_history') and has_function_privilege('anon', oid, 'execute')) = 5),
  ('internal helpers are NOT callable from the website', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('_contact_clean', '_contact_save', '_contact_gate', '_export_extra', '_export_all', '_export_all_core') and has_function_privilege('anon', oid, 'execute')) = 0),
  ('the backup export includes both contact tables', (public._export_all() ->> 'contact_details') is not null and (public._export_all() ->> 'contact_history') is not null))
select name, case when ok then 'PASS' else 'FAIL' end as result from checks order by 2 desc, 1;

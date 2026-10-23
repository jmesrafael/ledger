-- READ-ONLY verification for 20261109000000_settlement_controls_backup.sql. Changes nothing. Run it in the SQL editor as the database owner.
--
-- PART A: the snapshot. Run it BEFORE applying the migration and again AFTER. The two results must be identical, character for character
--         (the migration moves no unit, no price, no mark and no balance).
-- PART B: the checks. Run it AFTER applying. Every row must say PASS.

-- ---------------------------------------------------------------- PART A: snapshot (keep the output)
select jsonb_build_object(
  'last_entry', (select jsonb_build_object('id', id, 'ts', ts, 'equity', equity_usdt, 'units', total_units, 'price', unit_price) from public.pool_equity order by id desc limit 1),
  'people', (select jsonb_agg(jsonb_build_object('user', p.username, 'role', p.role,
                'units', coalesce((select sum(units) from public.ledger where profile_id = p.id), 0),
                'value', coalesce((select sum(units) from public.ledger where profile_id = p.id), 0) * public._price_now(),
                'hwm', case when p.role = 'investor' then (select hwm_value from public.investor_hwm where profile_id = p.id) end,
                'accrued_fee', (public._holder_summary(p.id)->>'accrued_fee_usdt')::numeric) order by p.username) from public.profiles p),
  'fund_manager', public._fund_m_state(null) - 'profile_id',
  'counts', jsonb_build_object('pool_equity', (select count(*) from public.pool_equity), 'ledger', (select count(*) from public.ledger),
                               'settlements', (select count(*) from public.settlements), 'pending_deposits', (select count(*) from public.pending_deposits)),
  'totals', jsonb_build_object('ledger_units', (select sum(units) from public.ledger), 'fee_transfers_net', (select coalesce(sum(units), 0) from public.ledger where kind in ('fee_in', 'fee_out')))
)::text as snapshot;

-- ---------------------------------------------------------------- PART B: checks (after applying)
with
  fn(name) as (values ('_clock'), ('_settlement_exception'), ('_settlement_check'), ('_settlement_requirements'), ('_settle_guard'), ('_dump_table'), ('_export_extra'),
                      ('admin_approve_settlement_exception'), ('admin_backup_coverage')),
  cols(name) as (values ('covered_from'), ('covered_to'), ('days_after_period_end'), ('late'), ('backdated_days'), ('exception_ids'), ('open_positions_at_settlement'), ('recorded_at'), ('backdated')),
  exported as (select k from jsonb_object_keys(public._export_all()) k),
  checks(n, name, ok, detail) as (
    select 1, 'new functions exist', (select count(*) from fn f where to_regprocedure('public.' || f.name || '(' ||
             case f.name when '_clock' then '' when '_settlement_exception' then 'text,timestamptz,numeric' when '_settlement_check' then 'numeric'
                         when '_settlement_requirements' then 'numeric,timestamptz,jsonb' when '_settle_guard' then '' when '_dump_table' then 'text' when '_export_extra' then ''
                         when 'admin_approve_settlement_exception' then 'text,text,numeric,text,timestamptz,integer' else 'text' end || ')') is not null) = 9, null
    union all select 2, 'settlement_exceptions table exists, row level security on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.settlement_exceptions')), false), null
    union all select 3, 'settlements has the new columns', (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'settlements' and c.column_name in (select name from cols)) = 9, null
    union all select 4, 'settle_guard trigger is on pool_equity', exists (select 1 from pg_trigger where tgname = 'settle_guard' and tgrelid = 'public.pool_equity'::regclass and not tgisinternal), null
    union all select 5, 'settlement_window_days = 7 and settlement_backdate_minutes = 60', (select count(*) from public.ledger_settings where (key = 'settlement_window_days' and value = '7') or (key = 'settlement_backdate_minutes' and value = '60')) = 2, null
    union all select 6, 'fee engine is investor_hwm_v2 and workflow_gate is unchanged', (select value from public.ledger_settings where key = 'fee_engine') = 'investor_hwm_v2', (select 'workflow_gate = ' || coalesce(value, '?') from public.ledger_settings where key = 'workflow_gate')
    union all select 7, 'everyone''s units equal the last pool entry', abs((select coalesce(sum(units), 0) from public.ledger) - coalesce((select total_units from public.pool_equity order by id desc limit 1), 0)) < 0.000001, null
    union all select 8, 'fee transfers net to zero', abs((select coalesce(sum(units), 0) from public.ledger where kind in ('fee_in', 'fee_out'))) < 0.00000001, null
    union all select 9, 'every investor holding units has a high-water mark', not exists (select 1 from public.profiles p where p.role = 'investor' and public._units_of(p.id) > 0 and not exists (select 1 from public.investor_hwm h where h.profile_id = p.id)), null
    union all select 10, 'NO internal helper (name starts with _) can be called by the website role or by signed-in users',
             not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
             (select coalesce(string_agg(p.proname, ', '), 'none callable') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
    union all select 11, 'the website role cannot read or write any table directly',
             not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete')
                                                                                                                       or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert'))), null
    union all select 12, 'every table has row level security on', not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity), null
    union all select 13, 'the backup export covers every ledger table (sessions, backup_keys, app_settings, backtest_runs are left out on purpose)',
             not exists (select 1 from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> all (array['sessions', 'backup_keys', 'app_settings', 'backtest_runs'])
                           and coalesce(case t.table_name when 'profiles' then 'people' when 'ledger_settings' then 'settings' end, t.table_name) not in (select k from exported)),
             (select coalesce(string_agg(t.table_name, ', '), 'none missing') from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> all (array['sessions', 'backup_keys', 'app_settings', 'backtest_runs'])
                           and coalesce(case t.table_name when 'profiles' then 'people' when 'ledger_settings' then 'settings' end, t.table_name) not in (select k from exported))
    union all select 14, 'the backup export has no password hashes', not (public._export_all()::text like '%pass_hash%'), null
    union all select 15, 'the clock function returns the real time', abs(extract(epoch from public._clock() - now())) < 2, null
    union all select 16, 'a direct insert of a settlement is refused by settle_guard (checked from the definition)', (select prosrc from pg_proc where proname = '_settle_guard' and pronamespace = 'public'::regnamespace) like '%admin_close_quarter%', null
  )
select n as "#", name as "check", case when ok then 'PASS' else 'FAIL' end as result, detail from checks order by n;

// Rehearses the whole upgrade on a COPY of your data, in a throwaway PostgreSQL 17 container (needs Docker). Touches no real database.
//
//   node scripts/rehearse-migration.mjs <backup ledger.json> [--expect-snapshot <file>]
//
// <backup>            the app's Backup, or admin_export_all, saved as ledger.json
// --expect-snapshot   optional: the PART A snapshot that supabase/verify/20261109000000_post_apply_checks.sql prints on the REAL database at
//                     the same moment as the backup. The restored copy must produce the identical text (units, values, marks, fund-manager split).
//
// The container is built like Supabase: the same default privileges (new functions and tables are given to anon / authenticated / service_role),
// so a function that was forgotten in a revoke shows up here. It then:
//   1. builds the schema from supabase/migrations/applied/* (= production today) and restores the backup with scripts/restore-ledger.mjs
//   2. checks every table against the backup, row for row, to the last digit
//   3. for every PENDING migration: proves a failed run leaves nothing behind, applies it twice, checks that no existing row changed,
//      runs the verification script, proves the rollback script returns the schema to the earlier state, and applies it again
//   4. makes a real settlement on the copy and proves the rollback then REFUSES (the audit trail must not be dropped)
// It prints PASS or FAIL for each step and throws the container away.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { buildRestoreSql } from './restore-ledger.mjs';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--expect-snapshot');
const snapIdx = args.indexOf('--expect-snapshot');
const expectSnapshot = snapIdx >= 0 ? readFileSync(args[snapIdx + 1], 'utf8').trim() : null;
if (!src) { console.error('usage: node scripts/rehearse-migration.mjs <backup ledger.json> [--expect-snapshot <file>]'); process.exit(2); }
const NAME = 'lucid-rehearsal-' + process.pid;
const sb = new URL('../supabase/', import.meta.url), root = new URL('migrations/', sb), appl = new URL('applied/', root);
const list = (u) => readdirSync(u).filter((f) => f.endsWith('.sql')).sort().map((f) => [f, new URL(f, u)]);

const docker = (a, input) => spawnSync('docker', a, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const psql = (sql, db = 'rehearsal') => { const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtX'], sql); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && (!ok || detail.startsWith('(')) ? '  ' + detail : ''}`); return ok; };
const first = (s) => String(s || '').split('\n')[0];
const stop = () => { docker(['rm', '-f', NAME]); };

if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('Docker is not running. Start Docker Desktop and try again.'); process.exit(2); }
const text = readFileSync(src, 'utf8');
const restoreSql = buildRestoreSql(text);

// ---- the verification script: PART A (snapshot) and PART B (checks)
const verifyText = readFileSync(new URL('verify/20261109000000_post_apply_checks.sql', sb), 'utf8');
const iA = verifyText.indexOf('-- ---------------------------------------------------------------- PART A'), iB = verifyText.indexOf('-- ---------------------------------------------------------------- PART B');
const partA = verifyText.slice(iA, iB), partB = verifyText.slice(iB);
const snapshot = () => psql(partA).out;

// ---- a fingerprint of everything a rollback must restore (function logic, columns, triggers, setting names; not data, not privileges)
const FINGERPRINT = `select md5(string_agg(x, E'\\n' order by x)) from (
  select 'f:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g')) x from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
  union all select 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') from information_schema.columns where table_schema = 'public'
  union all select 't:' || event_object_table || '.' || trigger_name || ':' || event_manipulation || ':' || action_timing from information_schema.triggers where trigger_schema = 'public'
  union all select 's:' || key from public.ledger_settings) z`;
const helpersOpen = () => psql(`select coalesce(string_agg(p.proname, ', ' order by p.proname), 'none') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`).out;

try {
  let r = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=pw', 'postgres:17-alpine']);
  if (r.status !== 0) throw new Error('could not start the container: ' + r.stderr);
  for (let i = 0; i < 40; i++) { if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres']).status === 0) break; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); }
  psql('create database rehearsal', 'postgres');
  // Supabase: roles anon / authenticated / service_role, and default privileges that hand every NEW table, function and sequence to all three
  r = psql(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema extensions; create extension pgcrypto with schema extensions; create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
  if (!check('fresh PostgreSQL 17 ready, with Supabase\'s default privileges', r.ok, first(r.err))) process.exit(1);

  let bad = null;
  for (const [f, u] of list(appl)) { r = psql(readFileSync(u, 'utf8')); if (!r.ok) { bad = f + ': ' + first(r.err); break; } }
  if (!check(`schema built from the ${list(appl).length} applied migrations (production today)`, !bad, bad || '')) process.exit(1);
  const before = helpersOpen();
  console.log(`INFO  internal helper functions the website role can call TODAY (the live exposure; expect it to be fixed below): ${before}`);

  r = psql(restoreSql);
  if (!check('backup restored (its own row-count and unit checks passed)', r.ok, first(r.err))) process.exit(1);
  r = psql(restoreSql);
  check('a second restore is refused', !r.ok && /restore refused/.test(r.err));

  const tag = '$orig$';
  r = psql(`create schema rh; create table rh.orig(k text primary key, v jsonb not null); insert into rh.orig select key, value from jsonb_each(${tag}${text}${tag}::jsonb);`);
  if (!check('backup loaded for comparison', r.ok, first(r.err))) process.exit(1);
  const compare = (skip) => psql(`select o.k from rh.orig o where jsonb_typeof(o.v) = 'array' and o.k <> all (array[${skip.map((k) => `'${k}'`).join(',') || "''"}])
      and (select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb) from jsonb_array_elements(o.v) e)
          is distinct from (select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb) from jsonb_array_elements(coalesce(public._export_all() -> o.k, '[]'::jsonb)) e) order by 1`);
  const n = psql(`select count(*) from rh.orig where jsonb_typeof(v) = 'array'`).out;
  r = compare(['settings']);
  check(`all ${n} backup tables equal the restored tables, row for row, to the last digit`, r.ok && r.out === '', r.out ? 'DIFFERENT: ' + r.out.replace(/\n/g, ', ') : first(r.err));
  const units = () => psql(`select round((select coalesce(sum(units),0) from ledger) - (select coalesce(total_units,0) from (select total_units from pool_equity order by id desc limit 1) x), 8)`).out;
  check('everyone\'s units equal the last pool entry', Number(units()) === 0, 'difference ' + units());

  const snap0 = snapshot();
  if (expectSnapshot) check('investor values, marks, manager capital/fee split and totals equal the real database\'s snapshot (taken with the backup)', snap0 === expectSnapshot, snap0 === expectSnapshot ? '' : 'DIFFERENT');
  else console.log('INFO  no --expect-snapshot given: the snapshot below is only compared before and after the migration');

  // ---- every pending migration
  const pending = list(root);
  if (!pending.length) console.log('(no pending migrations in supabase/migrations/)');
  for (const [f, u] of pending) {
    const sql = readFileSync(u, 'utf8');
    const f0 = psql(FINGERPRINT).out;
    r = psql(`begin;\n${sql}\nselect 1/0;\ncommit;`);
    check(`${f}: a run that fails half-way leaves nothing behind`, !r.ok && psql(FINGERPRINT).out === f0 && snapshot() === snap0, r.ok ? 'the failing run did not fail' : '');
    const a = psql(sql), b = psql(sql);
    check(`${f}: applies, and applies again`, a.ok && b.ok, first(a.err || b.err));
    r = compare(['settings']);
    check(`${f}: no existing row changed`, r.ok && r.out === '', r.out ? 'CHANGED: ' + r.out.replace(/\n/g, ', ') : first(r.err));
    check(`${f}: investor values, marks, manager split and totals are identical before and after`, snapshot() === snap0);
    check(`${f}: everyone's units still equal the last pool entry`, Number(units()) === 0);
    const afterHelpers = helpersOpen();
    check(`${f}: no internal helper function can be called by the website role`, afterHelpers === 'none', afterHelpers === 'none' ? '' : 'STILL OPEN: ' + afterHelpers);
    r = psql(partB);
    const rows = r.out.split('\n').filter(Boolean).map((l) => l.split('|'));
    const failed = rows.filter((x) => x[2] !== 'PASS');
    check(`${f}: the verification script passes (${rows.length} checks)`, r.ok && rows.length > 0 && !failed.length, failed.map((x) => `#${x[0]} ${x[1]}`).join('; ') || first(r.err));

    const rb = new URL(`rollback/${f.replace('_settlement_controls_backup', '_rollback_settlement_controls')}`, sb);
    if (existsSync(rb)) {
      const f1 = psql(FINGERPRINT).out;
      r = psql(readFileSync(rb, 'utf8'));
      check(`${f}: the rollback script runs`, r.ok, first(r.err));
      check(`${f}: after the rollback the functions, columns, triggers and settings are exactly what they were before`, psql(FINGERPRINT).out === f0);
      check(`${f}: after the rollback no ledger row, mark or balance moved`, snapshot() === snap0 && Number(units()) === 0);
      const h = helpersOpen();
      check(`${f}: the rollback keeps the helper-function revokes (it does not re-open the exposure)`, h === 'none', h === 'none' ? '' : 'OPEN: ' + h);
      check(`${f}: a second rollback is refused cleanly`, !psql(readFileSync(rb, 'utf8')).ok);
      const again = psql(sql);
      check(`${f}: applies again after a rollback`, again.ok && psql(FINGERPRINT).out === f1, first(again.err));
    } else console.log(`INFO  no rollback script for ${f}`);
  }

  // ---- the system on the copy: the real flow, then the rollback must refuse
  r = psql(`select (public.admin_integrity_report((public.login((select username from public.profiles where role = 'admin' limit 1), 'rehearsal-password-1'))->>'token'))->>'worst'`);
  psql(`update public.profiles set pass_hash = public._hash('rehearsal-password-1') where id = (select id from public.profiles where role = 'admin' limit 1)`);
  const tok = `(public.login((select username from public.profiles where role = 'admin' limit 1), 'rehearsal-password-1'))->>'token'`;
  r = psql(`select (public.admin_integrity_report(${tok}))->>'worst'`);
  check('integrity report is clean', r.ok && r.out === '-1', 'worst severity ' + r.out);
  r = psql(`select jsonb_array_length(public.admin_backup_coverage(${tok})->'missing')`);
  check('the backup covers every ledger table', r.ok && r.out === '0', 'tables missing: ' + r.out);
  r = psql(`select (public.admin_export_all(${tok})) is not null, (select count(*) from jsonb_object_keys(public.admin_export_all(${tok})))`);
  check('the manager\'s Backup button still works (admin_export_all as the website role, with a token)', r.ok && /^t\|\d+$/.test(r.out), r.out || first(r.err));
  r = psql(`set role anon; select public._export_all()`);
  check('the website role can no longer call _export_all()', !r.ok && /permission denied/.test(r.err), first(r.err));
  r = psql(`select (public.admin_settlement_preview(${tok}, (select equity_usdt from public.pool_equity order by id desc limit 1)))->>'can_settle'`);
  check('settlement preview runs on the copy', r.ok, r.out === 'false' ? '(blocked today, as expected outside the window)' : first(r.err));

  // a settlement on the copy (monthly periods, so that a past period exists to settle), then the rollback must refuse
  r = psql(`do $do$ declare t text := ${tok}; tot numeric := (select round(equity_usdt * 1.6, 2) from public.pool_equity order by id desc limit 1);
      note text := 'rehearsal on a copy: total chosen to produce a fee';
    begin
      update public.ledger_settings set value = '1' where key = 'settlement_period_months';
      perform public.admin_approve_settlement_exception(t, 'late', tot, note, null, null);
      perform public.admin_approve_settlement_exception(t, 'unreconciled', tot, note, null, 0);
      perform public.admin_close_quarter(t, tot, 58, 'rehearsal', null, null, true);
    end $do$; select (select count(*) from public.settlements) || '|' || (select coalesce(sum(fee_usdt), 0) from public.settlements) || '|' || (select count(*) from public.settlement_exceptions)`);
  const parts = (r.out || '').split('|');
  check('a real settlement (late + reconciliation exceptions) is made on the copy and saved', r.ok && parts[0] === '1' && Number(parts[1]) > 0 && parts[2] === '2', r.ok ? `(fee ${parts[1]} USDT, ${parts[2]} exceptions)` : first(r.err));
  r = psql(`select (public.admin_integrity_report(${tok}))->>'worst'`);
  check('integrity report is still clean after the settlement', r.ok && r.out === '-1', 'worst severity ' + r.out);
  const rb2 = new URL('rollback/20261109000000_rollback_settlement_controls.sql', sb);
  if (existsSync(rb2)) {
    const f2 = psql(FINGERPRINT).out;
    r = psql(readFileSync(rb2, 'utf8'));
    check('the rollback REFUSES once a settlement exists, and changes nothing', !r.ok && /rollback refused/.test(r.err) && psql(FINGERPRINT).out === f2, first(r.err));
  }
} catch (e) { check('rehearsal ran to the end', false, e.message); } finally { stop(); }

const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAILED: ${failed} check(s). Do not apply the migration.` : `\nALL ${results.length} CHECKS PASSED on a copy of your data. Nothing real was touched.`);
process.exit(failed ? 1 : 0);

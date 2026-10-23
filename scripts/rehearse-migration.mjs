// Rehearses the whole upgrade on a COPY of your data, in a throwaway PostgreSQL 17 container (needs Docker). Touches no real database.
//
//   node scripts/rehearse-migration.mjs <backup ledger.json>          (export one first: the app's Backup, or admin_export_all)
//
// It builds a fresh database from supabase/migrations/applied/* (= production today), restores the backup with scripts/restore-ledger.mjs,
// checks every table against the backup, applies every PENDING migration in supabase/migrations/ twice, checks that no existing row changed,
// runs the integrity report and a settlement preview, then throws the container away. It prints PASS or FAIL for each step.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { buildRestoreSql } from './restore-ledger.mjs';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/rehearse-migration.mjs <backup ledger.json>'); process.exit(2); }
const NAME = 'lucid-rehearsal-' + process.pid;
const root = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', root);
const list = (u) => readdirSync(u).filter((f) => f.endsWith('.sql')).sort().map((f) => [f, new URL(f, u)]);

const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const psql = (sql, db = 'rehearsal') => { const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtX'], sql); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && (!ok || detail.startsWith('(')) ? '  ' + detail : ''}`); return ok; };
const stop = () => { docker(['rm', '-f', NAME]); };

if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) { console.error('Docker is not running. Start Docker Desktop and try again.'); process.exit(2); }
const text = readFileSync(src, 'utf8');
const restoreSql = buildRestoreSql(text);

try {
  let r = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=pw', 'postgres:17-alpine']);
  if (r.status !== 0) throw new Error('could not start the container: ' + r.stderr);
  for (let i = 0; i < 40; i++) { if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres']).status === 0) break; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); }
  psql('create database rehearsal', 'postgres');
  r = psql(`create role anon nologin; create role authenticated nologin; create schema extensions; create extension pgcrypto with schema extensions; create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text);
    alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  if (!check('fresh PostgreSQL 17 ready', r.ok, r.err)) process.exit(1);

  let bad = null;
  for (const [f, u] of list(appl)) { r = psql(readFileSync(u, 'utf8')); if (!r.ok) { bad = f + ': ' + r.err.split('\n')[0]; break; } }
  if (!check(`schema built from the ${list(appl).length} applied migrations (production today)`, !bad, bad || '')) process.exit(1);

  r = psql(restoreSql);
  if (!check('backup restored (its own row-count and unit checks passed)', r.ok, r.err.split('\n')[0])) process.exit(1);
  r = psql(restoreSql);
  check('a second restore is refused', !r.ok && /restore refused/.test(r.err));

  // keep the original tables inside the database so PostgreSQL itself compares them (no number is ever parsed in JavaScript)
  const tag = '$orig$';
  const loadOrig = `create schema rh; create table rh.orig(k text primary key, v jsonb not null); insert into rh.orig select key, value from jsonb_each(${tag}${text}${tag}::jsonb);`;
  r = psql(loadOrig); if (!check('backup loaded for comparison', r.ok, r.err.split('\n')[0])) process.exit(1);
  const compare = (skip) => psql(`select o.k from rh.orig o where jsonb_typeof(o.v) = 'array' and o.k <> all (array[${skip.map((k) => `'${k}'`).join(',') || "''"}])
      and (select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb) from jsonb_array_elements(o.v) e)
          is distinct from (select coalesce(jsonb_agg(e order by e::text), '[]'::jsonb) from jsonb_array_elements(coalesce(public._export_all() -> o.k, '[]'::jsonb)) e)
      order by 1`);
  const n = psql(`select count(*) from rh.orig where jsonb_typeof(v) = 'array'`).out;
  r = compare(['settings']);
  check(`all ${n} backup tables equal the restored tables, row for row`, r.ok && r.out === '', r.out ? 'DIFFERENT: ' + r.out.replace(/\n/g, ', ') : r.err);
  const units = () => psql(`select round((select coalesce(sum(units),0) from ledger) - (select coalesce(total_units,0) from (select total_units from pool_equity order by id desc limit 1) x), 8)`).out;
  check('everyone\'s units equal the last pool entry', Number(units()) === 0, 'difference ' + units());

  const pending = list(root);
  for (const [f, u] of pending) {
    const sql = readFileSync(u, 'utf8');
    const a = psql(sql), b = psql(sql);
    check(`pending migration ${f} applies, and applies again`, a.ok && b.ok, (a.err || b.err).split('\n')[0]);
  }
  if (!pending.length) console.log('(no pending migrations in supabase/migrations/)');
  r = compare(['settings']);
  check('after the migrations no existing row changed', r.ok && r.out === '', r.out ? 'CHANGED: ' + r.out.replace(/\n/g, ', ') : r.err);
  check('everyone\'s units still equal the last pool entry', Number(units()) === 0);

  r = psql(`update public.profiles set pass_hash = public._hash('rehearsal-password-1') where id = (select id from public.profiles where role = 'admin' limit 1);
    select (public.admin_integrity_report((public.login((select username from public.profiles where role = 'admin' limit 1), 'rehearsal-password-1'))->>'token'))->>'worst'`);
  check('integrity report is clean', r.ok && r.out.split('\n').pop() === '-1', 'worst severity ' + r.out.split('\n').pop());
  r = psql(`select jsonb_array_length(public.admin_backup_coverage((public.login((select username from public.profiles where role = 'admin' limit 1), 'rehearsal-password-1'))->>'token')->'missing')`);
  check('the new backup covers every ledger table', r.ok && r.out.split('\n').pop() === '0', 'tables missing: ' + r.out.split('\n').pop());
  r = psql(`select (public.admin_settlement_preview((public.login((select username from public.profiles where role = 'admin' limit 1), 'rehearsal-password-1'))->>'token',
      (select equity_usdt from public.pool_equity order by id desc limit 1)))->>'can_settle'`);
  check('settlement preview runs on the copy', r.ok, r.out.split('\n').pop() === 'false' ? '(blocked today, as expected outside the window)' : r.err.split('\n')[0]);
} catch (e) { check('rehearsal ran to the end', false, e.message); } finally { stop(); }

const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAILED: ${failed} check(s). Do not apply the migration.` : `\nALL ${results.length} CHECKS PASSED on a copy of your data. Nothing real was touched.`);
process.exit(failed ? 1 : 0);

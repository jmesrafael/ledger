// Rehearses the cleanup on an exact COPY of the live database, in a throwaway PostgreSQL 17 container (needs Docker). It never connects to a real database.
//
//   node scripts/rehearse-cleanup.mjs <schema.sql> <data.sql>
//
// <schema.sql> / <data.sql>: read-only dumps of the live "public" schema (supabase db dump --linked --schema public / --data-only --schema public).
// Keep them OUTSIDE the repository: they hold everyone's data.
//
// It: 1. restores the copy and checks the books; 2. applies 20261214 (automatic settlement) and 20261215 (retirement), each twice, and proves that no ledger
// row changed, that the rollbacks restore the earlier functions and rights, and that the retired functions are closed; 3. moves the copy's clock to the
// settlement window so that the period that ended Nov 1, 2026 (never settled) is due today (a date cannot be in the future, so Jan 1, 2027 itself cannot be played) and lets the wallet reports arrive, in three variants (profit, open trades with the 'wait' rule, loss), checking after
// each: units sum = pool total, fee units net to zero, every mark, and the integrity report. Prints PASS / FAIL per step and the settlement numbers by profile id.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [schemaFile, dataFile] = process.argv.slice(2);
if (!schemaFile || !dataFile) { console.error('usage: node scripts/rehearse-cleanup.mjs <schema.sql> <data.sql>'); process.exit(2); }
const NAME = 'lucid-cleanup-' + process.pid, sb = new URL('../supabase/', import.meta.url);
const file = (p) => readFileSync(new URL(p, sb), 'utf8');
const docker = (a, input) => spawnSync('docker', a, { input, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
const psql = (sql, db = 'live') => { const r = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtX'], sql); return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const results = [];
const first = (s) => String(s || '').split('\n').find((l) => /ERROR|error/.test(l)) || String(s || '').split('\n')[0];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); return ok; };
const info = (s) => console.log('INFO  ' + s);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const KEYS = { bbcore: 'a'.repeat(64), icore: 'b'.repeat(64), tcore: 'c'.repeat(64) };

// every accounting row that must not change when a migration is applied
const ROWS = `select md5(string_agg(t || ':' || n, ',' order by t)) from (
  select 'ledger' t, count(*)::text || md5(coalesce(string_agg(l::text, ',' order by id), '')) n from public.ledger l
  union all select 'pool_equity', count(*)::text || md5(coalesce(string_agg(l::text, ',' order by id), '')) from public.pool_equity l
  union all select 'investor_hwm', md5(coalesce(string_agg(l::text, ',' order by profile_id), '')) from public.investor_hwm l
  union all select 'pending_deposits', md5(coalesce(string_agg(l::text, ',' order by id), '')) from public.pending_deposits l
  union all select 'closed_trades', md5(coalesce(string_agg(l::text, ',' order by id), '')) from public.closed_trades l
  union all select 'flow_checkpoints', md5(coalesce(string_agg(l::text, ',' order by id), '')) from public.flow_checkpoints l
  union all select 'settlements', count(*)::text from public.settlements
  union all select 'profiles', md5(coalesce(string_agg(l.id::text || l.role || l.fee_rate || l.active, ',' order by id), '')) from public.profiles l) z`;
const FUNCS = `select md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)), ',' order by 1)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'`;
const GRANTS = `select md5(string_agg(p.oid::regprocedure::text || '=' || has_function_privilege('anon', p.oid, 'execute') || has_function_privilege('authenticated', p.oid, 'execute'), ',' order by 1))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> '_retired_functions'`;
const BOOKS = `select round((select coalesce(sum(units), 0) from public.ledger) - (select total_units from public.pool_equity order by id desc limit 1), 8) || '|' ||
  (select coalesce(sum(units), 0) from public.ledger where kind in ('fee_in', 'fee_out')) || '|' || ((select count(*) from public.ledger group by profile_id having sum(units) < 0 limit 1) is null)`;
const HOLDERS = `select string_agg(p.id || ' ' || p.role || ' rate ' || p.fee_rate || ' units ' || coalesce((select sum(units) from public.ledger l where l.profile_id = p.id), 0)
  || ' mark ' || coalesce((select round(hwm_value, 6)::text from public.investor_hwm h where h.profile_id = p.id), '-'), E'\\n' order by p.created_at) from public.profiles p`;

const stop = () => docker(['rm', '-f', NAME]);
try {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) throw new Error('Docker is not running');
  let r = docker(['run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=pw', 'postgres:17-alpine']);
  if (r.status !== 0) throw new Error('could not start the container: ' + r.stderr);
  for (let i = 0; i < 60; i++) { if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres']).status === 0 && psql('select 1', 'postgres').ok) break; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); }
  psql('create database live', 'postgres');
  r = psql(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create role supabase_admin nologin;
    create schema extensions; create extension pgcrypto with schema extensions; create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text);
    alter table storage.objects enable row level security;`);
  if (!check('fresh PostgreSQL 17 with Supabase\'s roles and default privileges', r.ok, first(r.err))) throw new Error('setup');
  // the dump creates the public schema's objects; "create schema public" already exists in a fresh database
  const schema = readFileSync(schemaFile, 'utf8').replace(/^CREATE SCHEMA IF NOT EXISTS "public";$/m, '').replace(/^\\(un)?restrict .*$/gm, '');
  r = psql(schema);
  if (!check('live schema restored from the dump', r.ok, first(r.err))) throw new Error('schema');
  r = psql(readFileSync(dataFile, 'utf8').replace(/^\\(un)?restrict .*$/gm, ''));
  if (!check('live data restored from the dump', r.ok, first(r.err))) throw new Error('data');
  // from here on new objects get Supabase's default privileges (a forgotten revoke in a migration then shows up); the dump itself carried live's exact rights
  psql(`grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);

  // ---- 1. the copy is the live books
  const b0 = psql(BOOKS).out.split('|');
  check('copy: everyone\'s units = the last pool entry; fee units net to zero; nobody negative', Number(b0[0]) === 0 && Number(b0[1]) === 0 && b0[2] === 'true', `(difference ${b0[0]}, fee net ${b0[1]})`);
  info('holders on the copy (profile id, role, fee rate, units, mark):\n' + psql(HOLDERS).out.replace(/^/gm, '        '));
  info('last pool entry: ' + psql(`select 'id ' || id || ' value ' || equity_usdt || ' units ' || total_units || ' price ' || round(unit_price, 8) from public.pool_equity order by id desc limit 1`).out);
  info('switches: ' + psql(`select string_agg(key || '=' || value, ', ' order by key) from public.ledger_settings where key in ('flow_pricing','auto_pool_mode','workflow_gate','bot_equity_sync','wallet_nav_mode','nav_auto','fee_timing','settlement_recon','settlement_schedule','default_fee_rate')`).out);
  const rows0 = psql(ROWS).out, f0 = psql(FUNCS).out, g0 = psql(GRANTS).out;

  // ---- 2. the two migrations
  const M14 = file('migrations/20261214000000_auto_settlement.sql'), R14 = file('rollback/20261214000000_rollback_auto_settlement.sql');
  const M15 = file('migrations/20261215000000_retire_unused_functions.sql'), R15 = file('rollback/20261215000000_rollback_retire_unused_functions.sql');
  r = psql(`begin;\n${M14}\nselect 1/0;\ncommit;`);
  check('1214 auto settlement: a run that fails half-way leaves nothing behind', !r.ok && psql(FUNCS).out === f0 && psql(ROWS).out === rows0);
  let a = psql(M14), b = psql(M14);
  check('1214: applies, and applies again', a.ok && b.ok, first(a.err || b.err));
  check('1214: no accounting row changed; no settlement was made by applying it', psql(ROWS).out === rows0);
  r = psql(`select public._settle_auto('rehearsal')`);
  check('1214: today (Nov 2026) the automatic run does nothing', r.ok && /missed|price_paused|settled|no_period/.test(r.out) && psql(ROWS).out === rows0, '(' + r.out.slice(0, 90) + ')');
  r = psql(R14);
  check('1214: the rollback restores every function exactly', r.ok && psql(FUNCS).out === f0 && psql(GRANTS).out === g0, first(r.err));
  check('1214: applies again after the rollback', psql(M14).ok);
  const f14 = psql(FUNCS).out, g14 = psql(GRANTS).out;
  r = psql(`begin;\n${M15}\nselect 1/0;\ncommit;`);
  check('1215 retirement: a run that fails half-way leaves nothing behind', !r.ok && psql(GRANTS).out === g14);
  a = psql(M15); b = psql(M15);
  check('1215: applies, and applies again', a.ok && b.ok, first(a.err || b.err));
  check('1215: no accounting row changed and no function body changed', psql(ROWS).out === rows0 && psql(`select md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)), ',' order by 1)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname <> '_retired_functions'`).out === f14);
  r = psql(`select count(*) || '|' || count(*) filter (where website_can_call) from public._retired_functions()`);
  check('1215: every retired function is closed to the website role', r.ok && /^\d+\|0$/.test(r.out), `(${r.out.split('|')[0]} functions)`);
  r = psql(`set role anon; select public.admin_post_equity('x', 1)`);
  check('1215: the website role is refused (permission denied), e.g. the typed balance', !r.ok && /permission denied/.test(r.err));
  r = psql(`select coalesce(string_agg(p.proname, ', ' order by 1), 'none') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
  check('no internal helper function is open to the website role', r.out === 'none', r.out === 'none' ? '' : 'OPEN: ' + r.out);
  r = psql(R15);
  check('1215: the rollback restores exactly the earlier rights', r.ok && psql(GRANTS).out === g14 && psql(FUNCS).out === f14, first(r.err));
  check('1215: applies again after the rollback', psql(M15).ok);

  // ---- 3. the settlement, on copies of the copy. The copy gets a clock that can be set, and known wallet keys (the real ones are not in any dump).
  r = psql(`update public.ledger_settings set value = '60' where key = 'settlement_window_days';   -- copy only: the Sep-Oct 2026 period (ended Nov 1, never settled) counts as inside its window today
    ${Object.entries(KEYS).map(([w, k]) => `update public.bot_wallets set key_hash = '${sha(k)}' where wallet = '${w}';`).join('\n')}
    update public.profiles set pass_hash = public._hash('rehearsal-password-1') where role = 'admin';`);
  if (!check('copy prepared for the dry run (its settlement window widened so that the unsettled Sep-Oct period is due today; rehearsal wallet keys)', r.ok, first(r.err))) throw new Error('prepare');
  const TOKQ = `select (public.login((select username from public.profiles where role = 'admin' limit 1), 'rehearsal-password-1'))->>'token'`;
  let tok = `'${psql(TOKQ).out}'`;
  const book = Number(psql(`select equity_usdt from public.pool_equity order by id desc limit 1`).out);
  const seq0 = Number(psql(`select coalesce(max(seq), 0) from public.wallet_snapshots`).out) + 1000;
  // each wallet reports its equity and open P&L (shares as on Nov 13: 52% / 23% / 25% of the cash)
  const report = (db, clock, cash, open, n) => {
    let last;
    for (const [i, [w, s, o]] of [['bbcore', 0.52, 0.53], ['icore', 0.23, 0.17], ['tcore', 0.25, 0.30]].entries()) {
      const unr = +(open * o).toFixed(6), eq = +(cash * s + unr).toFixed(6);
      last = psql(`select public.bot_post_wallet_snapshot('${KEYS[w]}', '${w}', ${seq0 + n * 10 + i}, now(), ${eq}, ${unr}, ${+(eq - unr).toFixed(6)}, ${+(eq - unr).toFixed(6)}, ${unr !== 0 ? 4 : 0}, 0)`, db);
    }
    return last;
  };
  const lines = (db) => psql(`select string_agg(l.profile_id || ': units ' || l.units_before || ' x ' || round(l.unit_price, 8) || ' = ' || round(l.value_before, 6) || ', mark ' || round(l.hwm_before, 6) ||
      ', profit above mark ' || round(greatest(0, l.eligible_profit), 6) || ', rate ' || l.fee_rate || ', fee ' || l.fee_usdt || ' USDT = ' || l.fee_units || ' units, mark after ' || round(l.hwm_after, 6), E'\\n')
    from public.settlement_lines l`, db).out;
  const after = (label, db, expectSettled) => {
    tok = `'${psql(TOKQ, db).out}'`;
    const n = psql(`select count(*) from public.settlements`, db).out, bk = psql(BOOKS, db).out.split('|');
    check(`${label}: ${expectSettled ? 'one settlement was made' : 'no settlement was made'}`, n === (expectSettled ? '1' : '0'), `(settlements: ${n})`);
    check(`${label}: units sum = pool total; fee units net to zero; nobody negative`, Number(bk[0]) === 0 && Number(bk[1]) === 0 && bk[2] === 'true', `(difference ${bk[0]}, fee net ${bk[1]})`);
    const ir = psql(`select (public.admin_integrity_report(${tok}))->>'worst'`, db);
    check(`${label}: the integrity report is clean`, ir.ok && ir.out === '-1', 'worst ' + (ir.out || first(ir.err)));
  };
  const CLOCK = null, wait = () => spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)']);
  psql(`select pg_terminate_backend(pid) from pg_stat_activity where datname = 'live' and pid <> pg_backend_pid()`, 'postgres');
  for (const d of ['run_profit', 'run_wait', 'run_loss', 'run_manual']) { r = psql(`create database ${d} template live`, 'postgres'); if (!r.ok) throw new Error('copy ' + d + ': ' + r.err); }

  // A. profit: the books as they are, plus open trades worth +80 (the level of the last verified live reading, Nov 13): automatic, open trades allowed
  r = report('run_profit', CLOCK, book, 80, 1);
  check('A (profit, open trades allowed): the third wallet report settles by itself', r.ok && /"settled": ?true/.test(r.out), first(r.err) || r.out.match(/"settlement": ?\{[^}]{0,200}/)?.[0] || '');
  after('A', 'run_profit', true);
  info('A settlement: ' + psql(`select 'price ' || round(unit_price, 8) || ', NAV ' || nav || ', exchange total ' || mexc_total || ', fee ' || fee_usdt || ' USDT = ' || fee_units || ' units, investors charged ' || investors_charged || ', status ' || recon_status || ', exceptions ' || array_length(exception_ids, 1) || ', period ' || period_start || ' to ' || period_end || ', covered from ' || covered_from from public.settlements`, 'run_profit').out);
  info('A lines:\n' + lines('run_profit').replace(/^/gm, '        '));
  info('A holders after:\n' + psql(HOLDERS, 'run_profit').out.replace(/^/gm, '        '));
  r = psql(`select round(l.fee_usdt - l.fee_rate * greatest(0, l.value_before - l.hwm_before), 4) || '|' || round(l.hwm_after - (l.value_before - l.fee_units * l.unit_price), 4) from public.settlement_lines l where l.fee_units > 0`, 'run_profit');
  check('A: fee = rate x (value - mark), and the new mark = value after the fee', r.ok && r.out.split('\n').every((x) => x.split('|').every((v) => Math.abs(Number(v)) <= 0.0001)), '(' + r.out + ')');
  r = psql(`select ((select sum(units) from public.ledger where kind = 'fee_in' and profile_id = (select id from public.profiles where role = 'admin')) = (select fee_units from public.settlements)) || '|' ||
    (select abs(equity_usdt - ${book}) < 0.00001 from public.pool_equity order by id desc limit 1) || '|' || (select count(distinct total_units) = 1 from public.pool_equity where id >= (select equity_id from public.settlements) - 1)`, 'run_profit');
  check('A: the fee units arrived in the fund manager account; the book is back to closed trades only; total units never moved', r.out === 'true|true|true', '(' + (r.out || first(r.err)) + ')');
  wait(); r = report('run_profit', null, book, 80, 2);
  check('A: the next reports do nothing more', psql(`select count(*) from public.settlements`, 'run_profit').out === '1');
  r = psql(R14, 'run_profit');
  check('A: after a settlement the 1214 rollback still runs and keeps the settlement', r.ok && psql(`select count(*) from public.settlements`, 'run_profit').out === '1', first(r.err));

  // B. the same reading with settlement_auto_open_trades = 'wait'
  psql(`update public.ledger_settings set value = 'wait' where key = 'settlement_auto_open_trades'`, 'run_wait');
  const rowsB = psql(ROWS, 'run_wait').out;
  r = report('run_wait', CLOCK, book, 80, 1);
  check('B (rule "wait", trades open): it waits and saves nothing', r.ok && /open_trades/.test(r.out) && psql(ROWS, 'run_wait').out === rowsB);
  after('B', 'run_wait', false);
  wait(); r = report('run_wait', null, book, 0, 2);
  check('B: the first reading with no open trade settles', /"settled": ?true/.test(r.out));

  // C. loss: no open P&L, so the price is the book price and the investor is below the mark
  r = report('run_loss', CLOCK, book, 0, 1);
  check('C (investor below the mark): settled with no fee', r.ok && /"settled": ?true/.test(r.out) && psql(`select fee_usdt::numeric = 0 and fee_units::numeric = 0 from public.settlements`, 'run_loss').out === 't');
  after('C', 'run_loss', true);
  info('C lines:\n' + lines('run_loss').replace(/^/gm, '        '));
  check('C: no fee row was written and the mark did not move', psql(`select (select count(*) from public.ledger where kind in ('fee_in','fee_out')) = 0 and (select bool_and(hwm_after = hwm_before) from public.settlement_lines)`, 'run_loss').out === 't');

  // D. automatic off: the status the Settle screen shows, then "Settle now" with the manager's token, as the website role
  psql(`update public.ledger_settings set value = 'off' where key = 'settlement_auto'`, 'run_manual');
  tok = `'${psql(TOKQ, 'run_manual').out}'`;
  report('run_manual', CLOCK, book, 80, 1);
  r = psql(`set role anon; select s->>'state' || '|' || (s->>'fee_usdt_now') || '|' || jsonb_array_length(s->'lines') from public.admin_settlement_status(${tok}) s`, 'run_manual');
  check('D (automatic off): the Settle screen says due and shows the fee', r.ok && /^due\|/.test(r.out), '(' + (r.out || first(r.err)) + ')');
  const shown = (r.out || '').split('|')[1];
  r = psql(`set role anon; select public.admin_close_quarter_tv(${tok}, null, 'rehearsal', 'rehearsal-1')->>'fee_usdt'`, 'run_manual');
  check('D: Settle now without an exception is refused while trades are open (the existing rule for a manual settlement)', !r.ok && /OPEN TRADES/.test(r.err), first(r.err).slice(0, 120));
  r = psql(`set role anon; select public.admin_approve_settlement_exception(${tok}, 'open_positions', (select (public.admin_true_value(${tok})->>'combined_equity_usdt')::numeric), 'rehearsal: settle with trades open at the true price', null, 12) is not null;
    select public.admin_close_quarter_tv(${tok}, null, 'rehearsal', 'rehearsal-1')->>'fee_usdt'`, 'run_manual');
  check('D: with the written exception Settle now charges exactly what the screen showed', r.ok && Math.abs(Number(r.out.split('\n').pop()) - Number(shown)) < 1e-6, `(shown ${shown}, charged ${r.out.split('\n').pop() || first(r.err)})`);
  after('D', 'run_manual', true);
} catch (e) { check('rehearsal ran to the end', false, e.message); } finally { stop(); }

const failed = results.filter((x) => !x).length;
console.log(failed ? `\nFAILED: ${failed} check(s).` : `\nALL ${results.length} CHECKS PASSED on a copy of the live database. Nothing real was touched.`);
process.exit(failed ? 1 : 0);

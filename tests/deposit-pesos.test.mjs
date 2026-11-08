// 20261210000000_deposit_pesos.sql: a deposit is shown as the pesos put in, with the USDT those pesos bought when known; "Put in" is the plain peso total.
// Raf's #1 (52.3082 USDT) and #2 (200 USDT) get their pesos (₱3,323, ₱12,830); the Nov 7 bulk cash-in (₱10,000 = 158.0278 USDT, split in half) is recorded as
// ₱5,000 = 79.0139 USDT on Raf's #4 (a CORRECTION of ₱6,897) and on James's deposit. Append-only history; display only: no ledger row, unit or pool figure changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { world, near } from './_tvworld.mjs';
const C = createRequire(import.meta.url)('../js/contribution.js');
const MIG = readFileSync(new URL('../supabase/migrations/20261210000000_deposit_pesos.sql', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../supabase/rollback/20261210000000_rollback_deposit_pesos.sql', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const HALF = 79.0139, NOTE = 'bulk cash-in ₱10,000 = 158.0278 USDT, split in half';

// as live: Raf two USDT-only deposits, then James ₱5,000 = 66.40 and Raf ₱6,897 = 91.6278 (the Nov 7 cash-in as first recorded)
async function live() {
  const w = await world();
  w.J = await w.call('admin_create_user', w.A, 'jamesrafael', 'James', 'james-password-1', 0.2);
  const r = (who, u, php) => w.call('admin_receive_deposit', w.A, who, u, null, php, null, w.d(), null, true);
  await r(w.ids.raf, 52.3082, null); await w.call('admin_post_equity', w.A, 52.3082, null, null, w.d());
  await r(w.ids.raf, 200, null); await w.call('admin_post_equity', w.A, 252.3082, null, null, w.d());
  await r(w.J, 66.4, 5000); await r(w.ids.raf, 91.6278, 6897); await w.call('admin_post_equity', w.A, 252.3082 + 158.0278, null, null, w.d());
  w.raf = await w.q(`select id from public.ledger where profile_id = $1 order by id`, [w.ids.raf]); w.james = (await w.q(`select id from public.ledger where profile_id = $1`, [w.J]))[0].id;
  return w;
}
const hashes = async (w) => {
  const o = {};
  for (const t of ['ledger', 'pool_equity', 'pending_deposits']) o[t] = (await w.q(`select count(*)::int n, md5(string_agg(to_jsonb(x)::text, '|' order by id)) h from public.${t} x`))[0];
  o.raf = await w.units('raf');
  return o;
};
const rec = (w, id, php, usdt, note, idem = null) => w.call('admin_record_deposit_pesos', w.A, id, php, usdt, note, idem);

test('DP1 the old deposits get their pesos, the Nov 7 deposits are recorded as ₱5,000 = 79.0139 USDT each; Raf\'s Put in is ₱21,153; nothing else changes', async () => {
  const w = await live();
  const before = await hashes(w);
  await rec(w, w.raf[0].id, 3323, null, 'GCash cash-in, Oct 23', 'dp-1');
  await rec(w, w.raf[1].id, 12830, null, 'GCash cash-in, Oct 28', 'dp-2');
  await rec(w, w.raf[2].id, 5000, HALF, NOTE, 'dp-3');            // a correction of the recorded ₱6,897
  await rec(w, w.james, 5000, HALF, NOTE, 'dp-4');                // James's pesos stay ₱5,000; the USDT bought is now on record
  assert.deepEqual(await hashes(w), before, 'ledger, pool, waiting deposits and units untouched');
  const all = await w.call('admin_deposit_pesos', w.A);
  const rows = C.withDepositPesos(await w.call('admin_ledger', w.A), all);
  const raf = rows.filter((l) => l.profile_id === w.ids.raf), james = rows.filter((l) => l.profile_id === w.J);
  assert.deepEqual(raf.filter((l) => l.kind === 'deposit').sort((a, b) => a.id - b.id).map((l) => l.php_amount), [3323, 12830, 5000]);
  const r4 = raf.find((l) => Number(l.id) === Number(w.raf[2].id)); assert.equal(r4.usdt_bought, HALF); assert.equal(r4.php_original, 6897, 'the original amount is still known');
  assert.equal(james[0].php_amount, 5000); assert.equal(james[0].usdt_bought, HALF); assert.equal(james[0].php_original, undefined, 'same pesos: not a change');
  assert.equal(C.putIn(C.summary(raf, null, null), null).put.main, '₱21,153'); assert.equal(C.putIn(C.summary(james, null, null), null).put.main, '₱5,000');
  const log = await w.q(`select action, detail from public.audit_log where action like 'deposit_pesos_%' order by id`);
  assert.deepEqual(log.map((x) => x.action), ['deposit_pesos_recorded', 'deposit_pesos_recorded', 'deposit_pesos_corrected', 'deposit_pesos_corrected']);
  near(log[2].detail.from_php, 6897); near(log[2].detail.php_amount, 5000); near(log[2].detail.usdt_bought, HALF);
  const R = (await w.call('login', 'raf', 'admin-password-1')).token, Jt = (await w.call('login', 'jamesrafael', 'james-password-1')).token;
  assert.equal((await w.call('my_deposit_pesos', R)).length, 3); assert.equal((await w.call('my_deposit_pesos', Jt)).length, 1, 'a person sees only their own');
  assert.equal((await rec(w, w.raf[0].id, 3323, null, 'GCash cash-in, Oct 23', 'dp-1')).replayed, true, 'a retry returns the first answer');
});

test('DP2 a correction is a new entry; the newest one is shown and every earlier one is kept', async () => {
  const w = await live();
  await rec(w, w.raf[0].id, 3300, null, 'first guess from memory');
  await rec(w, w.raf[0].id, 3323, null, 'GCash record, Oct 23');
  const all = await w.call('admin_deposit_pesos', w.A);
  assert.deepEqual(all.map((d) => Number(d.php_amount)), [3300, 3323], 'both kept, oldest first');
  assert.equal(C.withDepositPesos([{ id: w.raf[0].id, kind: 'deposit', usdt: 52.3082, php_amount: null }], all)[0].php_amount, 3323, 'the newest is shown');
  await assert.rejects(rec(w, w.raf[0].id, 3323, null, 'same again'), /nothing to change/);
});

test('DP3 refused: an impossible rate, no source, not a deposit, a top-up, not the manager; the record is append-only and closed to the website role', async () => {
  const w = await live();
  const rej = (re, id, php, usdt, note) => assert.rejects(rec(w, id, php, usdt, note), re);
  await rej(/₱100 for 200 USDT is ₱0.50 per USDT/, w.raf[1].id, 100, null, 'typo check');
  await rej(/₱5000 for 5000 USDT is ₱1.00 per USDT/, w.raf[2].id, 5000, 5000, 'typo check');
  await rej(/say where the amount comes from/, w.raf[1].id, 12830, null, 'x');
  await rej(/enter the pesos/, w.raf[1].id, 0, null, 'GCash record');
  await rej(/at most 2 decimals/, w.raf[1].id, 12830.123, null, 'GCash record');
  await rej(/USDT bought must be more than 0/, w.raf[1].id, 12830, -1, 'GCash record');
  await rej(/unknown entry/, 999999, 100, null, 'GCash record');
  const top = await w.q(`insert into public.ledger(ts, profile_id, kind, units, usdt, unit_price, equity_id, note) select now(), $1, 'deposit', 0.0001, 0.0001, 1, max(id), 'peso top-up for deposit #3: test' from public.pool_equity returning id`, [w.J]).catch(() => null);
  if (top) await rej(/a peso top-up is part of the deposit it tops up/, top[0].id, 1, null, 'GCash record');
  const Jt = (await w.call('login', 'jamesrafael', 'james-password-1')).token;
  await assert.rejects(w.call('admin_record_deposit_pesos', Jt, w.raf[1].id, 12830, null, 'GCash record', null), /admin only/);
  await rec(w, w.raf[0].id, 3323, null, 'GCash cash-in, Oct 23');
  await assert.rejects(w.q(`update public.deposit_pesos set php_amount = 1`), /append-only/);
  await assert.rejects(w.q(`delete from public.deposit_pesos`), /append-only/);
  await w.db.exec('set role anon');
  try { await assert.rejects(w.q(`select * from public.deposit_pesos`), /permission denied/); } finally { await w.db.exec('reset role'); }
});

test('DP4 the migration changes no existing row, runs twice; the rollback keeps the entries and it can be applied again', async () => {
  const w = await live();
  const before = await hashes(w);
  await w.db.exec(MIG); await w.db.exec(MIG);
  assert.deepEqual(await hashes(w), before);
  await rec(w, w.raf[0].id, 3323, null, 'GCash cash-in, Oct 23');
  assert.ok(!(await w.call('admin_backup_coverage', w.A)).missing.includes('deposit_pesos'), 'the backup carries it');
  await w.db.exec(RB); await w.db.exec(RB);
  assert.equal((await w.q(`select to_regprocedure('public.admin_record_deposit_pesos(text,bigint,numeric,numeric,text,text)') f`))[0].f, null);
  assert.equal((await w.q(`select count(*)::int n from public.deposit_pesos`))[0].n, 1, 'kept');
  await w.db.exec(MIG); assert.equal((await w.call('admin_deposit_pesos', w.A)).length, 1);
});

test('DP5 the screens: a deposit shows its pesos and the USDT they bought; the passed-on top-up is not "Withdrawn"; the manager adds or corrects each deposit', () => {
  const rows = [{ id: 1, kind: 'deposit', usdt: '52.3082', units: '52.3', php_amount: null, ts: '2026-10-23' }, { id: 2, kind: 'deposit', usdt: '200', units: '203', php_amount: null, ts: '2026-10-28' },
    { id: 4, kind: 'deposit', usdt: '91.6278', units: '101', php_amount: '6897', ts: '2026-11-07' },
    { id: 10, kind: 'withdrawal', usdt: '-12.85941', units: '-14', php_amount: null, ts: '2026-11-07', note: 'peso top-up to James Rafael Boroy: your units, so their pesos count at the live rate' },
    { id: 11, kind: 'deposit', usdt: '5', units: '5', php_amount: null, note: 'peso top-up for deposit #9: x', ts: '2026-11-07' }];
  assert.deepEqual(C.depositList(rows).map((l) => l.id), [1, 2, 4], 'oldest first, not a payout, not a top-up');
  assert.deepEqual(C.missingPesos(rows).map((l) => l.id), [1, 2]);
  const m = C.withDepositPesos(rows, [{ id: 1, ledger_id: 1, php_amount: 3323 }, { id: 2, ledger_id: 2, php_amount: '12830' }, { id: 3, ledger_id: 4, php_amount: 5000, usdt_bought: HALF }]);
  assert.deepEqual(m.slice(0, 3).map((l) => [l.php_amount, l.usdt_bought ?? null]), [[3323, null], [12830, null], [5000, HALF]]);
  assert.equal(rows[2].php_amount, '6897', 'the rows themselves are not changed'); assert.deepEqual(C.missingPesos(m), []);
  assert.deepEqual(C.withDepositPesos(rows, null), rows, 'before the migration nothing changes');
  const s = C.summary(m, null, null);
  assert.equal(C.putIn(s, null).put.main, '₱21,153'); assert.equal(s.withdrawnUsdt, 0, 'passing units to an investor as a top-up is not money taken out'); assert.equal(C.putIn(s, null).out, null);
  const real = C.summary([...m, { id: 12, kind: 'withdrawal', usdt: -10, units: -10, php_amount: null, ts: '2026-11-09', note: 'payout' }], null, null);
  assert.equal(real.withdrawnUsdt, 10, 'a real payout still counts');
  assert.match(app, /group\(async \(\) => \{ S\.dpesos = await call\(admin \? 'admin_deposit_pesos' : 'my_deposit_pesos'\); \}, \(\) => \{ S\.dpesos = null; \}\)/);
  assert.match(app, /: paid \? \(l\.usdt_bought != null \? `= \$\{f\(l\.usdt_bought, 4\)\} USDT` : ''\)/, 'the deposit row: +₱5,000, = 79.0139 USDT underneath');
  assert.match(app, /data-action="addpesos" data-id="\$\{l\.id\}">\$\{l\.php_amount != null \? 'Correct' : 'Add pesos'\}<\/button>/);
  assert.match(app, /call\('admin_record_deposit_pesos', \{ p_ledger: Number\(id\), p_php_amount: Number\(r\.php\), p_usdt_bought: /);
  assert.match(app, /\$\{putInCards\(putInOf\(m\)\)\}\$\{depositRecords\(m\.id\)\}/); assert.match(app, /\$\{putInCards\(putInOf\(h\)\)\}\$\{depositRecords\(h\.id\)\}/);
  assert.match(app, /if \(!isAdmin\(\) \|\| S\.me\.impersonated \|\| S\.dpesos == null\) return '';/, 'only the fund manager, and only once the migration is run');
  assert.match(app, /case 'deposit_pesos_recorded':/); assert.match(app, /case 'deposit_pesos_corrected':/);
});

test('DP6 the load still sets everything: no assignment of the loaded data sits inside a comment (a regression found in the browser check)', () => {
  assert.match(app, /\n {4}S\.pool = pool; S\.hist = hist; S\.history = history; S\.ledger = Contribution\.withDepositPesos\(led, S\.dpesos\); S\.reqs = reqs; S\.all = all \|\| \[\]; S\.elog = elog \|\| \[\]; S\.pend = pend \|\| \[\];/);
  for (const line of app.split('\n')) {
    const c = line.indexOf('//');
    if (c >= 0 && !line.slice(0, c).includes("'") && !line.slice(0, c).includes('`')) assert.ok(!/S\.(all|reqs|elog|pend|ledger|pool) = /.test(line.slice(c)), 'commented-out assignment: ' + line.trim().slice(0, 120));
  }
});

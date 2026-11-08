// 20261210000000_deposit_pesos.sql: a deposit is shown as the pesos put in. An older deposit saved before the pesos were (php_amount empty) gets the pesos actually paid
// attached once (Raf: #1 ₱3,323, #2 ₱12,830); "Put in" is the plain peso total. Display only: USDT, units, the pool and every other figure are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { world, near } from './_tvworld.mjs';
const C = createRequire(import.meta.url)('../js/contribution.js');
const MIG = readFileSync(new URL('../supabase/migrations/20261210000000_deposit_pesos.sql', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../supabase/rollback/20261210000000_rollback_deposit_pesos.sql', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

// Raf as live: two deposits saved in USDT only (52.3082, 200), then ₱6,897 = 91.6278 USDT with its pesos
async function live() {
  const w = await world();
  await w.call('admin_receive_deposit', w.A, w.ids.raf, 52.3082, 63.53, null, null, w.d(), null, true); await w.call('admin_post_equity', w.A, 52.3082, null, null, w.d());
  await w.call('admin_receive_deposit', w.A, w.ids.raf, 200, 64.01, null, null, w.d(), null, true); await w.call('admin_post_equity', w.A, 252.3082, null, null, w.d());
  await w.call('admin_receive_deposit', w.A, w.ids.raf, 91.6278, 75.27191529, 6897, null, w.d(), null, true); await w.call('admin_post_equity', w.A, 343.936, null, null, w.d());
  w.led = await w.q(`select id, usdt::float u, php_amount from public.ledger where profile_id = $1 order by id`, [w.ids.raf]);
  return w;
}
const hashes = async (w) => {
  const o = {};
  for (const t of ['ledger', 'pool_equity', 'pending_deposits']) o[t] = (await w.q(`select count(*)::int n, md5(string_agg(to_jsonb(x)::text, '|' order by id)) h from public.${t} x`))[0];
  o.units = await w.units('raf');
  return o;
};

test('DP1 the pesos actually paid are recorded for the two old deposits; Put in becomes the plain total ₱3,323 + ₱12,830 + ₱6,897 = ₱23,050; nothing else changes', async () => {
  const w = await live();
  const before = await hashes(w);
  await w.call('admin_record_deposit_pesos', w.A, w.led[0].id, 3323, 'GCash cash-in, Oct 23', 'dp-1');
  await w.call('admin_record_deposit_pesos', w.A, w.led[1].id, 12830, 'GCash cash-in, Oct 28', 'dp-2');
  assert.deepEqual(await hashes(w), before, 'ledger, pool, waiting deposits and units untouched');
  const rec = await w.call('admin_deposit_pesos', w.A);
  assert.deepEqual(rec.map((r) => [Number(r.ledger_id), Number(r.php_amount)]), [[Number(w.led[0].id), 3323], [Number(w.led[1].id), 12830]]);
  const rows = C.withDepositPesos(await w.call('admin_ledger', w.A), rec).filter((l) => l.profile_id === w.ids.raf);
  const s = C.summary(rows, null, null);
  assert.equal(s.php, 3323 + 12830 + 6897); assert.equal(s.usdtOnlyCount, 0);
  assert.deepEqual(C.putIn(s, null).put, { main: '₱23,050', note: '' }, 'one peso total, no USDT note');
  const log = await w.q(`select detail from public.audit_log where action = 'deposit_pesos_recorded' order by id`);
  assert.equal(log.length, 2); near(log[1].detail.php_amount, 12830); assert.equal(log[1].detail.note, 'GCash cash-in, Oct 28');
  const R = (await w.call('login', 'raf', 'admin-password-1')).token;
  assert.equal((await w.call('my_deposit_pesos', R)).length, 2);
  const J = (await w.call('login', 'john', 'john-password')).token;
  assert.equal((await w.call('my_deposit_pesos', J)).length, 0, 'a person sees only their own');
  assert.equal((await w.call('admin_record_deposit_pesos', w.A, w.led[0].id, 3323, 'GCash cash-in, Oct 23', 'dp-1')).replayed, true, 'a retry returns the first answer');
});

test('DP2 refused: a deposit that already has its pesos, a second time, a non-deposit, an impossible rate, no source, not the manager; the record is append-only', async () => {
  const w = await live();
  const rej = (re, ...a) => assert.rejects(w.call('admin_record_deposit_pesos', w.A, ...a), re);
  await rej(/already has its pesos recorded \(₱6897\)/, w.led[2].id, 7000, 'retyped amount', null);
  await w.call('admin_record_deposit_pesos', w.A, w.led[0].id, 3323, 'GCash cash-in, Oct 23', null);
  await rej(/already recorded for this deposit \(₱3323\); they cannot be changed/, w.led[0].id, 3400, 'second try', null);
  await rej(/₱100 for 200 USDT is ₱0.50 per USDT/, w.led[1].id, 100, 'typo check', null);
  await rej(/₱128300 for 200 USDT is ₱641.50 per USDT/, w.led[1].id, 128300, 'typo check', null);
  await rej(/say where the amount comes from/, w.led[1].id, 12830, 'x', null);
  await rej(/enter the pesos/, w.led[1].id, 0, 'GCash record', null);
  await rej(/at most 2 decimals/, w.led[1].id, 12830.123, 'GCash record', null);
  await rej(/unknown entry/, 999999, 100, 'GCash record', null);
  const J = (await w.call('login', 'john', 'john-password')).token;
  await assert.rejects(w.call('admin_record_deposit_pesos', J, w.led[1].id, 12830, 'GCash record', null), /admin only/);
  await assert.rejects(w.q(`update public.deposit_pesos set php_amount = 1`), /append-only/);
  await assert.rejects(w.q(`delete from public.deposit_pesos`), /append-only/);
  await w.db.exec('set role anon');
  try { await assert.rejects(w.q(`select * from public.deposit_pesos`), /permission denied/); } finally { await w.db.exec('reset role'); }
});

test('DP3 the migration changes no existing row, runs twice; the rollback keeps the recorded pesos and it can be applied again', async () => {
  const w = await live();
  const before = await hashes(w);
  await w.db.exec(MIG); await w.db.exec(MIG);
  assert.deepEqual(await hashes(w), before);
  await w.call('admin_record_deposit_pesos', w.A, w.led[0].id, 3323, 'GCash cash-in, Oct 23', null);
  assert.ok(!(await w.call('admin_backup_coverage', w.A)).missing.includes('deposit_pesos'), 'the backup carries it');
  await w.db.exec(RB); await w.db.exec(RB);
  assert.equal((await w.q(`select to_regprocedure('public.admin_record_deposit_pesos(text,bigint,numeric,text,text)') f`))[0].f, null);
  assert.equal((await w.q(`select count(*)::int n from public.deposit_pesos`))[0].n, 1, 'kept');
  await w.db.exec(MIG); assert.equal((await w.call('admin_deposit_pesos', w.A)).length, 1);
});

test('DP4 the screens: deposits show plain pesos, Put in is the total, the manager can add the pesos of an older deposit; withDepositPesos and missingPesos', () => {
  const rows = [{ id: 1, kind: 'deposit', usdt: '52.3082', units: '52.3', php_amount: null, ts: '2026-10-23' }, { id: 2, kind: 'deposit', usdt: '200', units: '203', php_amount: null, ts: '2026-10-28' },
    { id: 4, kind: 'deposit', usdt: '91.6278', units: '101', php_amount: '6897', ts: '2026-11-07' }, { id: 10, kind: 'withdrawal', usdt: '-12.85941', units: '-14', php_amount: null, ts: '2026-11-07' },
    { id: 11, kind: 'deposit', usdt: '5', units: '5', php_amount: null, note: 'peso top-up for deposit #9: x', ts: '2026-11-07' }];
  assert.deepEqual(C.missingPesos(rows).map((l) => l.id), [1, 2], 'not the peso deposit, not the payout, not a top-up');
  const m = C.withDepositPesos(rows, [{ ledger_id: 1, php_amount: 3323 }, { ledger_id: 2, php_amount: '12830' }]);
  assert.equal(m[0].php_amount, 3323); assert.equal(m[0].php_later, true); assert.equal(m[1].php_amount, 12830); assert.equal(m[2].php_amount, '6897', 'a recorded amount is never replaced');
  assert.equal(rows[0].php_amount, null, 'the rows themselves are not changed'); assert.deepEqual(C.missingPesos(m), []);
  assert.deepEqual(C.withDepositPesos(rows, null), rows, 'before the migration nothing changes');
  assert.equal(C.putIn(C.summary(m, null, null), null).put.main, '₱23,050');
  assert.match(app, /group\(async \(\) => \{ S\.dpesos = await call\(admin \? 'admin_deposit_pesos' : 'my_deposit_pesos'\); \}, \(\) => \{ S\.dpesos = null; \}\)/);
  assert.match(app, /data-action="addpesos" data-id="\$\{l\.id\}">Add pesos<\/button>/);
  assert.match(app, /call\('admin_record_deposit_pesos', \{ p_ledger: Number\(id\), p_php_amount: Number\(r\.php\), p_note: r\.note, p_idem: 'deposit-pesos-' \+ id \}\)/);
  assert.match(app, /\$\{putInCards\(putInOf\(m\)\)\}\$\{missingPesosRows\(m\.id\)\}/); assert.match(app, /\$\{putInCards\(putInOf\(h\)\)\}\$\{missingPesosRows\(h\.id\)\}/);
  assert.match(app, /if \(!isAdmin\(\) \|\| S\.me\.impersonated \|\| S\.dpesos == null\) return '';/, 'only the fund manager, and only once the migration is run');
  assert.match(app, /case 'deposit_pesos_recorded':/);
});

test('DP5 the load still sets everything: no assignment of the loaded data sits inside a comment (a regression found in the browser check)', () => {
  assert.match(app, /\n {4}S\.pool = pool; S\.hist = hist; S\.history = history; S\.ledger = Contribution\.withDepositPesos\(led, S\.dpesos\); S\.reqs = reqs; S\.all = all \|\| \[\]; S\.elog = elog \|\| \[\]; S\.pend = pend \|\| \[\];/);
  for (const line of app.split('\n')) {
    const c = line.indexOf('//');
    if (c >= 0 && !line.slice(0, c).includes("'") && !line.slice(0, c).includes('`')) assert.ok(!/S\.(all|reqs|elog|pend|ledger|pool) = /.test(line.slice(c)), 'commented-out assignment: ' + line.trim().slice(0, 120));
  }
});

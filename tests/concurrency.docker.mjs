// Real two-connection race tests on PostgreSQL 16 (the Supabase engine), in a throwaway Docker container.
//   node --test tests/concurrency.docker.mjs        (needs Docker; pulls postgres:16-alpine once; touches nothing else)
// Each race runs twice: on the ORIGINAL schema (to show the defect) and with the integrity migration (to show the fix).
// The first transaction holds its work open for a moment (pg_sleep before commit) so the second really overlaps it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { OLD_CHAIN, INTEGRITY } from './_world.mjs';

const NAME = 'lucidyo-ledger-race-' + process.pid;
const mig = (f) => { const a = new URL('../supabase/migrations/applied/' + f, import.meta.url); return existsSync(a) ? a : new URL('../supabase/migrations/' + f, import.meta.url); };
const hasDocker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;

function psql(db, sql, input = null) {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtX', ...(input ? ['-f', '-'] : ['-c', sql])]);
    let out = '', errs = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (errs += d));
    p.on('close', (code) => resolve({ code, out: out.trim(), err: errs.trim() }));
    if (input) { p.stdin.write(input); p.stdin.end(); }
  });
}
const one = async (db, sql) => { const r = await psql(db, sql); if (r.code) throw new Error(r.err); return r.out; };

let seq = 0;
async function freshDb(withIntegrity) {
  const db = `race_${++seq}_${withIntegrity ? 'new' : 'old'}`;
  await one('postgres', `create database ${db}`);
  await one(db, `create role anon; create role authenticated;`).catch(() => {});
  await one(db, `create schema extensions; create extension pgcrypto with schema extensions; grant usage on schema public to anon, authenticated;`);
  for (const f of [...OLD_CHAIN, ...(withIntegrity ? [INTEGRITY] : [])]) {
    const r = await psql(db, null, readFileSync(mig(f), 'utf8'));
    if (r.code) throw new Error(`${f}: ${r.err}`);
  }
  await one(db, `update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; select public.create_first_admin('raf', 'Raf', 'admin-password-1');`);
  const A = await one(db, `select (public.login('raf', 'admin-password-1'))->>'token'`);
  const john = await one(db, `select public.admin_create_user('${A}', 'john', 'John', 'john-password', 0.1)`);
  await one(db, `select public.admin_receive_deposit('${A}', '${john}', 1000, 58, 58000, null)`);
  await one(db, `select public.admin_post_equity('${A}', 1000)`);
  await one(db, `alter table public.ledger disable trigger ledger_append_only; update public.ledger set lock_until = current_date - 1 where lock_until is not null; alter table public.ledger enable trigger ledger_append_only;`);
  return { db, A, john };
}
// run several transactions at once; the first one sleeps before committing so the others overlap it
const race = (db, sqls, hold = 1.5) => Promise.all(sqls.map((s, i) => psql(db, `begin; ${s}; ${i === 0 ? `select pg_sleep(${hold});` : ''} commit;`)));
const num = async (db, sql) => Number(await one(db, sql));

before(async () => {
  if (!hasDocker) return;
  spawnSync('docker', ['run', '-d', '--rm', '--name', NAME, '-e', 'POSTGRES_PASSWORD=race-test-only', 'postgres:16-alpine'], { encoding: 'utf8' });
  for (let i = 0; i < 60; i++) { if ((await psql('postgres', 'select 1')).code === 0) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('postgres container did not start');
});
after(() => { if (hasDocker) spawnSync('docker', ['rm', '-f', NAME]); });

test('34 two settlements at the same moment', { skip: !hasDocker && 'Docker not available' }, async () => {
  for (const withIntegrity of [false, true]) {
    const { db, A } = await freshDb(withIntegrity);
    const res = await race(db, [`select public.admin_close_quarter('${A}', 1100)`, `select public.admin_close_quarter('${A}', 1100)`]);
    const closes = await num(db, `select count(*) from public.pool_equity where kind = 'close'`);
    const fee = await num(db, `select coalesce(sum(units), 0) from public.ledger where kind = 'fee_in'`);
    if (!withIntegrity) {
      assert.equal(closes, 2, 'ORIGINAL: both settlements went through');
      assert.ok(fee > 18, `ORIGINAL: the same 100 of profit was charged twice (${fee} fee units, should be 9.09)`);
    } else {
      assert.equal(closes, 1, 'FIXED: only one settlement');
      assert.ok(Math.abs(fee - 9.09090909) < 1e-6, `FIXED: charged once (${fee})`);
      assert.match(res[1].err, /last quarter close was on/, 'the second one waited for the lock, then saw the first');
    }
  }
});

test('36 the same withdrawal request paid twice at once', { skip: !hasDocker && 'Docker not available' }, async () => {
  for (const withIntegrity of [false, true]) {
    const { db, A, john } = await freshDb(withIntegrity);
    const jt = await one(db, `select (public.login('john', 'john-password'))->>'token'`);
    await one(db, `select public.request_withdrawal('${jt}', 400, null)`);
    const rid = await one(db, `select id from public.withdrawal_requests limit 1`);
    const call = `select public.admin_withdraw('${A}', '${john}', 400, 1000, null, null, false, ${rid}, null)`;
    await race(db, [call, call]);
    const paidOut = await num(db, `select coalesce(-sum(usdt), 0) from public.ledger where kind = 'withdrawal'`);
    const units = await num(db, `select sum(units) from public.ledger where profile_id = '${john}'`);
    if (!withIntegrity) assert.ok(paidOut > 799, `ORIGINAL: one request was paid twice (${paidOut} USDT out, john left with ${units} units)`);
    else { assert.ok(Math.abs(paidOut - 400) < 1e-6 && Math.abs(units - 600) < 1e-6, `FIXED: paid once (${paidOut} out, ${units} left)`); }
  }
});

test('35/37 a valuation that converts a deposit, raced by a second valuation and a second deposit', { skip: !hasDocker && 'Docker not available' }, async () => {
  for (const withIntegrity of [false, true]) {
    const { db, A } = await freshDb(withIntegrity);
    const dino = await one(db, `select public.admin_create_user('${A}', 'dino', 'Dino', 'dino-password', 0.1)`);
    await one(db, `select public.admin_receive_deposit('${A}', '${dino}', 500, 58, 0, null)`);
    await race(db, [`select public.admin_post_equity('${A}', 1500)`, `select public.admin_post_equity('${A}', 1500)`, `select public.admin_post_equity('${A}', 1500)`]);
    const dinoUnits = await num(db, `select coalesce(sum(units), 0) from public.ledger where profile_id = '${dino}'`);
    const tu = await num(db, `select sum(units) from public.ledger`), last = await num(db, `select total_units from public.pool_equity order by id desc limit 1`);
    assert.ok(Math.abs(dinoUnits - 500) < 1e-6, `${withIntegrity ? 'FIXED' : 'ORIGINAL'}: one deposit, units issued once (${dinoUnits})`);
    if (withIntegrity) assert.ok(Math.abs(tu - last) < 1e-6, `FIXED: the last entry agrees with the ledger (${tu} vs ${last})`);
    else if (Math.abs(tu - last) > 1e-6) console.log(`  ORIGINAL: the last entry says ${last} units while the ledger holds ${tu}`);
  }
});

test('38 a correction raced by a settlement, and five retries of the same settlement at once', { skip: !hasDocker && 'Docker not available' }, async () => {
  const { db, A } = await freshDb(true);
  await one(db, `select public.admin_post_equity('${A}', 1100)`);
  await race(db, [`select public.admin_undo_last('${A}', 'fix')`, `select public.admin_close_quarter('${A}', 1100)`]);
  assert.equal(await one(db, `select count(*) from (select public._check_books()) x`), '1', 'books still balance after the race');
  const db2 = (await freshDb(true));
  const call = `select public.admin_close_quarter('${db2.A}', 1100, null, null, null, 'same-request-id')`;
  const res = await race(db2.db, [call, call, call, call, call]);
  assert.equal(res.filter((r) => r.code === 0).length, 5, 'every retry gets an answer');
  assert.equal(await num(db2.db, `select count(*) from public.pool_equity where kind = 'close'`), 1, 'but only one settlement exists');
  assert.ok(Math.abs(await num(db2.db, `select sum(units) from public.ledger where kind = 'fee_in'`) - 9.09090909) < 1e-6, 'and one fee');
});

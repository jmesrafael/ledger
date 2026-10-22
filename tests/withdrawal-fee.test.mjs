// Withdrawal fee (5% under a year, 2% after) and the 500-peso minimum (20261103000000_withdrawal_fee_minimum.sql).
// Real migrations in an in-memory Postgres; every call goes in as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).map((f) => new URL(f, appl)), ...readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => new URL(f, dir))]
  .sort((a, b) => a.pathname.split('/').pop().localeCompare(b.pathname.split('/').pop()));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '0' where key in ('min_days_between_closes', 'lock_months');
                 update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  return db;
}
const call = async (db, fn, ...args) => {
  await db.exec('set role anon');
  try { return (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const token = async (db, u, p) => { const r = await call(db, 'login', u, p); assert.equal(r.ok, true, JSON.stringify(r)); return r.token; };
async function world() {
  const db = await setup();
  const A = await token(db, 'raf', 'admin-password-1');
  const ids = { raf: (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id };
  for (const [u, n] of [['john', 'John'], ['dino', 'Dino']]) ids[u] = await call(db, 'admin_create_user', A, u, n, u + '-password', 0.1);
  return { db, A, ids, J: await token(db, 'john', 'john-password'), D: await token(db, 'dino', 'dino-password') };
}
const reading = async (db, A, factor = 1) => {
  const pool = await call(db, 'pool_summary', A), w = (await call(db, 'admin_pending', A)).reduce((t, d) => t + Number(d.usdt), 0);
  return call(db, 'admin_post_equity', A, Number(pool.total_units) * Number(pool.unit_price) * factor + w);
};
const log = async (db, A, n = 500) => (await call(db, 'admin_audit_log', A, n)).reverse();   // oldest first
const actions = (rows) => rows.map((r) => r.action);


const deposit = async (db, A, ids) => {
  await call(db, 'admin_receive_deposit', A, ids.raf, 100, 56, 5600);
  await call(db, 'admin_receive_deposit', A, ids.john, 100, 56, 5600);
  await reading(db, A);
  await call(db, 'admin_post_equity', A, 200, 56);                          // records the peso rate
};

test('young account pays 5% on what it withdraws, paid to the fund manager', async () => {
  const { db, A, ids, J } = await world();
  await deposit(db, A, ids);
  const info = await call(db, 'exit_fee_info', J);
  near(info.min_php, 500); near(info.people[0].rate, 0.05); assert.equal(info.people.length, 1);
  const w = await call(db, 'admin_withdraw', A, ids.john, 20, 200, 56, null, true);
  near(w.fee_units, 1); near(w.net_units, 19);                              // 5% of 20 units, no profit so no quarter fee
  const rows = (await call(db, 'admin_ledger', A)).filter((l) => l.note === 'withdrawal fee');
  assert.equal(rows.length, 2);
});

test('after a year the withdrawal fee is 2%', async () => {
  const { db, A, ids } = await world();
  await deposit(db, A, ids);
  await db.query(`update public.profiles set created_at = now() - interval '400 days' where username = 'john'`);
  const w = await call(db, 'admin_withdraw', A, ids.john, 20, 200, 56, null, true);
  near(w.fee_units, 0.4);
});

test('minimum withdrawal is 500 pesos, but everything can always be taken out', async () => {
  const { db, A, ids, J } = await world();
  await deposit(db, A, ids);
  await assert.rejects(() => call(db, 'request_withdrawal', J, 5), /minimum withdrawal/);   // 5 units x 56 = 280 pesos
  await call(db, 'request_withdrawal', J, 10);                                              // 560 pesos
  await assert.rejects(() => call(db, 'admin_withdraw', A, ids.john, 5, 200, 56, null, false), /minimum withdrawal/);
  const w = await call(db, 'admin_withdraw', A, ids.john, 100, 200, 56, null, false);       // all of it
  near(w.net_units, 95);
});

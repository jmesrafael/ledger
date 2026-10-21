// Runs the real migration on an in-memory Postgres (PGlite) with a stub of Supabase's auth schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = new URL('../supabase/migrations/20261021000000_init.sql', import.meta.url);
const ADMIN = '00000000-0000-0000-0000-00000000000a';
const JOHN = '00000000-0000-0000-0000-0000000000b1';
const DINO = '00000000-0000-0000-0000-0000000000b2';
const MARIA = '00000000-0000-0000-0000-0000000000b3';
const STRANGER = '00000000-0000-0000-0000-0000000000f0';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}
const as = async (db, uid) => { await db.exec(`reset role; select set_config('test.uid', '${uid}', false);`); };
const asAuth = async (db, uid) => { await db.exec(`select set_config('test.uid', '${uid}', false); set role authenticated;`); };
const signup = (db, id, name) =>
  db.query(`insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, name + '@x.com', JSON.stringify({ name })]);
const rpc = async (db, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(',');
  return (await db.query(`select public.${fn}(${ph}) as r`, args)).rows[0].r;
};
const summary = async (db, id) => { await as(db, ADMIN); return (await rpc(db, 'admin_overview')).find((h) => h.id === id); };

test('full lifecycle in USDT: deposits, +9% quarter, fees, drawdown, recovery, new joiner, withdrawal', async () => {
  const db = await setup();
  await signup(db, ADMIN, 'Raf'); await signup(db, JOHN, 'John'); await signup(db, DINO, 'Dino');
  await as(db, ADMIN);
  assert.equal((await db.query(`select role, approved, fee_rate from profiles where id = $1`, [ADMIN])).rows[0].role, 'admin');
  await rpc(db, 'admin_set_profile', JOHN, 'John', true, 0.2);
  await rpc(db, 'admin_set_profile', DINO, 'Dino', true, 0.2);

  // 50 / 30 / 20 USDT, like the ₱5,000 / 3,000 / 2,000 example
  await rpc(db, 'admin_deposit', ADMIN, 50, null, 56, 2800, 'own capital');
  await rpc(db, 'admin_deposit', JOHN, 30, 50, 56, 1680, null);
  await rpc(db, 'admin_deposit', DINO, 20, 80, 56, 1120, null);
  let john = await summary(db, JOHN);
  near(john.units, 30); near(john.unit_price, 1); near(john.share_pct, 0.3);

  // +9% quarter. Peso rate is irrelevant: only USDT equity moves the price.
  await rpc(db, 'admin_post_equity', 109, 61, 'q1');
  john = await summary(db, JOHN);
  near(john.unit_price, 1.09); near(john.value_usdt, 32.7); near(john.profit_usdt, 2.7);
  near(john.accrued_fee_usdt, 0.54); near(john.value_after_fee_usdt, 32.16);

  // quarter close: fee paid in units, nobody's cash moves, total units unchanged
  const close = await rpc(db, 'admin_close_quarter', 109, null, 'Q1');
  near(close.investors_charged, 2);
  john = await summary(db, JOHN);
  const dino = await summary(db, DINO);
  near(john.units, 30 - (0.2 * 0.09 / 1.09) * 30, 1e-6);
  near(john.value_usdt, 32.16, 1e-4);
  near(dino.value_usdt, 21.44, 1e-4);
  const admin = await summary(db, ADMIN);
  near(admin.fee_units_earned, (0.2 * 0.09 / 1.09) * 50, 1e-6);   // 30 + 20 units
  near((await rpc(db, 'pool_summary')).total_units, 100);
  near(john.hwm, 1.09);

  // drawdown: price falls below the HWM, closing again charges nothing
  await rpc(db, 'admin_post_equity', 102.46);
  const again = await rpc(db, 'admin_close_quarter', 102.46);
  near(again.investors_charged, 0);

  // recovery to 1.12: fee only on the part above the old HWM (1.09 -> 1.12)
  const johnUnitsBefore = (await summary(db, JOHN)).units;
  await rpc(db, 'admin_post_equity', 112);
  await rpc(db, 'admin_close_quarter', 112);
  near((await summary(db, JOHN)).units, johnUnitsBefore - (0.2 * 0.03 / 1.12) * johnUnitsBefore, 1e-6);

  // everything adds up: sum of everyone's value == pool equity
  const all = await rpc(db, 'admin_overview');
  near(all.reduce((s, h) => s + Number(h.value_usdt), 0), Number((await rpc(db, 'pool_summary')).equity_usdt), 1e-4);

  // new joiner at 1.12 does not change anyone else's units
  await signup(db, MARIA, 'Maria'); await as(db, ADMIN);
  await rpc(db, 'admin_set_profile', MARIA, 'Maria', true, 0.2);
  const johnBefore = (await summary(db, JOHN)).units;
  const dep = await rpc(db, 'admin_deposit', MARIA, 4, 112, null, null, null);
  near(dep.units, 4 / 1.12); near((await summary(db, JOHN)).units, johnBefore, 1e-9);

  // lock-up: John cannot withdraw inside 3 months; admin can force it. Fee at withdrawal is on the gain above his HWM.
  const jU = (await summary(db, JOHN)).units;
  await assert.rejects(() => rpc(db, 'admin_withdraw', JOHN, jU, 116), /locked/);
  await db.exec(`select set_config('test.uid', '${ADMIN}', false)`);
  await rpc(db, 'admin_post_equity', 120);   // price 120/103.571... moves above John's HWM again
  const price = (await rpc(db, 'pool_summary')).unit_price;
  const hwm = (await summary(db, JOHN)).hwm;
  const w = await rpc(db, 'admin_withdraw', JOHN, jU, 120, null, 'cash out', true, null);
  const expFee = (0.2 * Math.max(0, price - hwm) / price) * jU;
  near(w.fee_units, expFee, 1e-6); near(w.net_units, jU - expFee, 1e-6); near(w.pay_usdt, (jU - expFee) * price, 1e-4);
  const after = await summary(db, JOHN);
  near(after.units, 0, 1e-6);
  // pool still adds up after the payout; remaining holders keep the same unit price
  near((await rpc(db, 'pool_summary')).unit_price, price, 1e-8);
  const ps = await rpc(db, 'pool_summary');
  const rest = await rpc(db, 'admin_overview');
  near(rest.reduce((s, h) => s + Number(h.value_usdt), 0), Number(ps.equity_usdt), 1e-4);
});

test('same percentage return in every currency: peso rate never changes the numbers', async () => {
  const db = await setup();
  await signup(db, ADMIN, 'Raf'); await signup(db, JOHN, 'John'); await as(db, ADMIN);
  await rpc(db, 'admin_set_profile', JOHN, 'John', true, 0.2);
  await rpc(db, 'admin_deposit', ADMIN, 100, null, 56);
  await rpc(db, 'admin_deposit', JOHN, 12.5, 100, 56);      // ~ ₱700 at 56
  await rpc(db, 'admin_post_equity', 100 * 1.05 + 12.5 * 1.05, 70);   // pool +5%, peso weakened a lot
  const john = await summary(db, JOHN);
  near(john.return_pct, 0.05, 1e-9);
  near(john.value_usdt, 12.5 * 1.05, 1e-9);
});

test('security: investors see only their own rows; pool aggregates only; strangers see nothing', async () => {
  const db = await setup();
  await signup(db, ADMIN, 'Raf'); await signup(db, JOHN, 'John'); await signup(db, DINO, 'Dino'); await signup(db, STRANGER, 'Stranger');
  await as(db, ADMIN);
  await rpc(db, 'admin_set_profile', JOHN, 'John', true, 0.2);
  await rpc(db, 'admin_set_profile', DINO, 'Dino', true, 0.2);
  await rpc(db, 'admin_deposit', ADMIN, 50); await rpc(db, 'admin_deposit', JOHN, 30, 50); await rpc(db, 'admin_deposit', DINO, 20, 80);

  await asAuth(db, JOHN);
  const rows = (await db.query(`select profile_id from public.ledger`)).rows;
  assert.ok(rows.length > 0 && rows.every((r) => r.profile_id === JOHN), 'John sees only his own ledger rows');
  assert.equal((await db.query(`select id from public.profiles`)).rows.length, 1, 'John sees only his own profile');
  await assert.rejects(() => db.query(`select * from public.pool_equity`), /permission denied/);
  await assert.rejects(() => db.query(`insert into public.ledger(profile_id, kind, units, usdt, unit_price) values ($1,'deposit',1,1,1)`, [JOHN]), /permission denied/);
  await assert.rejects(() => rpc(db, 'admin_overview'), /admin only/);
  await assert.rejects(() => rpc(db, 'admin_deposit', JOHN, 1000, 100), /admin only/);
  await assert.rejects(() => rpc(db, 'admin_post_equity', 1), /admin only/);
  const pool = await rpc(db, 'pool_summary');
  near(pool.investor_count, 2); assert.equal(pool.email, undefined);
  assert.equal((await rpc(db, 'price_history')).length >= 3, true);

  await asAuth(db, STRANGER);   // signed up but not approved
  assert.equal(await rpc(db, 'my_summary'), null);
  assert.equal(await rpc(db, 'pool_summary'), null);
  assert.deepEqual(await rpc(db, 'price_history'), []);

  await as(db, ADMIN);          // the books cannot be edited
  await assert.rejects(() => db.query(`update public.ledger set units = 999`), /append-only/);
  await assert.rejects(() => db.query(`delete from public.pool_equity`), /append-only/);
});

test('withdrawal requests: locked units are refused, pay-by date is 7 business days out', async () => {
  const db = await setup();
  await signup(db, ADMIN, 'Raf'); await signup(db, JOHN, 'John'); await as(db, ADMIN);
  await rpc(db, 'admin_set_profile', JOHN, 'John', true, 0.2);
  await rpc(db, 'admin_deposit', ADMIN, 50); await rpc(db, 'admin_deposit', JOHN, 30, 50);
  await asAuth(db, JOHN);
  await assert.rejects(() => rpc(db, 'request_withdrawal', 10), /locked/);
  await as(db, ADMIN);
  await db.exec(`reset role`);
  const d = (await db.query(`select public.add_business_days('2026-10-23'::date, 7) as d`)).rows[0].d;   // Fri -> Tue two weeks later
  assert.equal(new Date(d).toISOString().slice(0, 10), '2026-11-03');
});

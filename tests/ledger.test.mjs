// Runs the real migration on an in-memory Postgres (PGlite + pgcrypto). Every call goes in as the public "anon" role,
// exactly like the website does, so the permission checks here are the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const MIGRATION = new URL('../supabase/migrations/20261022000000_ledger.sql', import.meta.url);
const HIDE_POOL = new URL('../supabase/migrations/20261023000000_hide_pool_from_investors.sql', import.meta.url);
const CORRECTIONS = new URL('../supabase/migrations/20261024000001_ledger_corrections.sql', import.meta.url);
const FEE_10 = new URL('../supabase/migrations/20261025000000_profit_share_10.sql', import.meta.url);
const near =(a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions;
    grant usage on schema public to anon, authenticated;`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(HIDE_POOL, 'utf8'));
  await db.exec(readFileSync(CORRECTIONS, 'utf8'));
  await db.exec(readFileSync(FEE_10, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);   // fast hashing for tests
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  return db;
}
const call = async (db, fn, ...args) => {
  await db.exec('set role anon');
  try { return (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const login = (db, u, p) => call(db, 'login', u, p);
const token = async (db, u, p) => { const r = await login(db, u, p); assert.equal(r.ok, true, JSON.stringify(r)); return r.token; };
async function world() {   // admin + John + Dino
  const db = await setup();
  const A = await token(db, 'raf', 'admin-password-1');
  const ids = {};
  for (const [u, n] of [['john', 'John'], ['dino', 'Dino']]) ids[u] = await call(db, 'admin_create_user', A, u, n, u + '-password', 0.2);
  ids.raf = (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id;
  return { db, A, ids };
}
const holder = async (db, A, id) => (await call(db, 'admin_overview', A)).find((h) => h.id === id);

test('full lifecycle in USDT: deposits, +9% quarter, fees, drawdown, recovery, new joiner, withdrawal', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 50, null, 56, 2800, 'own capital');
  await call(db, 'admin_deposit', A, ids.john, 30, 50, 56, 1680, null);
  await call(db, 'admin_deposit', A, ids.dino, 20, 80, 56, 1120, null);
  let john = await holder(db, A, ids.john);
  near(john.units, 30); near(john.unit_price, 1); near(john.share_pct, 0.3);

  await call(db, 'admin_post_equity', A, 109, 61, 'q1');   // +9%; the peso rate is irrelevant to the price
  john = await holder(db, A, ids.john);
  near(john.unit_price, 1.09); near(john.value_usdt, 32.7); near(john.profit_usdt, 2.7);
  near(john.accrued_fee_usdt, 0.54); near(john.value_after_fee_usdt, 32.16);

  const close = await call(db, 'admin_close_quarter', A, 109, null, 'Q1');
  near(close.investors_charged, 2);
  john = await holder(db, A, ids.john);
  const dino = await holder(db, A, ids.dino), admin = await holder(db, A, ids.raf);
  near(john.units, 30 - (0.2 * 0.09 / 1.09) * 30, 1e-6); near(john.value_usdt, 32.16, 1e-4); near(dino.value_usdt, 21.44, 1e-4);
  near(admin.fee_units_earned, (0.2 * 0.09 / 1.09) * 50, 1e-6);
  near((await call(db, 'pool_summary', A)).total_units, 100); near(john.hwm, 1.09);

  await call(db, 'admin_post_equity', A, 102.46);   // drawdown: below HWM, nothing to charge
  near((await call(db, 'admin_close_quarter', A, 102.46)).investors_charged, 0);

  const before = (await holder(db, A, ids.john)).units;   // recovery to 1.12: fee only on the part above the old HWM
  await call(db, 'admin_post_equity', A, 112); await call(db, 'admin_close_quarter', A, 112);
  near((await holder(db, A, ids.john)).units, before - (0.2 * 0.03 / 1.12) * before, 1e-6);
  const all = await call(db, 'admin_overview', A);
  near(all.reduce((s, h) => s + Number(h.value_usdt), 0), Number((await call(db, 'pool_summary', A)).equity_usdt), 1e-4);

  const maria = await call(db, 'admin_create_user', A, 'maria', 'Maria', 'maria-password', 0.2);   // new joiner changes nobody else's units
  const jb = (await holder(db, A, ids.john)).units;
  const dep = await call(db, 'admin_deposit', A, maria, 4, 112);
  near(dep.units, 4 / 1.12); near((await holder(db, A, ids.john)).units, jb, 1e-9);

  const jT = await token(db, 'john', 'john-password');   // lock-up, then a forced withdrawal pays the fee on the gain above HWM
  await assert.rejects(() => call(db, 'admin_withdraw', A, ids.john, jb, 116), /locked/);
  await assert.rejects(() => call(db, 'request_withdrawal', jT, 1), /locked/);
  await call(db, 'admin_post_equity', A, 120);
  const price = (await call(db, 'pool_summary', A)).unit_price, hwm = (await holder(db, A, ids.john)).hwm;
  const w = await call(db, 'admin_withdraw', A, ids.john, jb, 120, null, 'cash out', true, null);
  const fee = (0.2 * Math.max(0, price - hwm) / price) * jb;
  near(w.fee_units, fee, 1e-6); near(w.net_units, jb - fee, 1e-6); near(w.pay_usdt, (jb - fee) * price, 1e-4);
  near((await holder(db, A, ids.john)).units, 0, 1e-6); near((await call(db, 'pool_summary', A)).unit_price, price, 1e-8);
  const rest = await call(db, 'admin_overview', A);
  near(rest.reduce((s, h) => s + Number(h.value_usdt), 0), Number((await call(db, 'pool_summary', A)).equity_usdt), 1e-4);
});

test('same percentage return whatever the peso rate does', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 100, null, 56); await call(db, 'admin_deposit', A, ids.john, 12.5, 100, 56);   // ~ ₱700
  await call(db, 'admin_post_equity', A, 112.5 * 1.05, 70);   // pool +5% while the peso moved 25%
  const john = await holder(db, A, ids.john);
  near(john.return_pct, 0.05, 1e-9); near(john.value_usdt, 12.5 * 1.05, 1e-9);
});

test('security: everything needs a token; investors see only their own data; hashes never leave', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 50); await call(db, 'admin_deposit', A, ids.john, 30, 50); await call(db, 'admin_deposit', A, ids.dino, 20, 80);
  const J = await token(db, 'john', 'john-password');

  for (const t of ['profiles', 'ledger', 'sessions', 'pool_equity', 'ledger_settings', 'holder_state', 'withdrawal_requests']) {
    await db.exec('set role anon');
    try { await assert.rejects(() => db.query(`select * from public.${t}`), /permission denied/, t); } finally { await db.exec('reset role'); }
  }
  await db.exec('set role anon');
  try {
    await assert.rejects(() => db.query(`insert into public.ledger(profile_id, kind, units, usdt, unit_price) values ($1,'deposit',1,1,1)`, [ids.john]), /permission denied/);
    await assert.rejects(() => db.query(`select public.create_first_admin('evil','Evil','evil-password-1')`), /permission denied/);
    await assert.rejects(() => db.query(`select public._me('x')`), /permission denied/);
  } finally { await db.exec('reset role'); }

  for (const fn of ['my_summary', 'pool_summary', 'price_history', 'my_ledger', 'my_requests'])
    await assert.rejects(() => call(db, fn, 'not-a-token'), /not signed in/, fn);
  await assert.rejects(() => call(db, 'my_summary', null), /not signed in/);
  await assert.rejects(() => call(db, 'admin_overview', J), /admin only/);
  await assert.rejects(() => call(db, 'admin_ledger', J), /admin only/);
  await assert.rejects(() => call(db, 'admin_deposit', J, ids.john, 1000, 100), /admin only/);
  await assert.rejects(() => call(db, 'admin_post_equity', J, 1), /admin only/);
  await assert.rejects(() => call(db, 'admin_create_user', J, 'x1234', 'X', 'password-123', 0), /admin only/);
  await assert.rejects(() => call(db, 'admin_set_password', J, ids.raf, 'hacked-password'), /admin only/);

  const mine = await call(db, 'my_ledger', J);
  assert.ok(mine.length > 0 && mine.every((r) => r.profile_id === ids.john), 'John sees only his own entries');
  await assert.rejects(() => call(db, 'pool_summary', J), /admin only/);      // the pool's size is the manager's business
  await assert.rejects(() => call(db, 'price_history', J), /admin only/);
  const pool = await call(db, 'pool_summary', A); near(pool.investor_count, 2);
  assert.ok(!/john|dino|raf/i.test(JSON.stringify(pool)), 'pool view has no names');
  const johnView = await call(db, 'my_summary', J);
  assert.ok(!('share_pct' in johnView), 'investor cannot work out the pool size from their share');
  assert.ok('share_pct' in (await call(db, 'my_summary', A)), 'manager still sees their share');
  const dump = JSON.stringify([await call(db, 'admin_overview', A), await call(db, 'admin_ledger', A), await call(db, 'my_summary', J)]);
  assert.ok(!/pass_hash|\$2[aby]\$/.test(dump), 'no password hashes in any response');
  await assert.rejects(() => db.query(`select public.create_first_admin('raf2','X','another-password')`), /already exists/);
  await assert.rejects(() => db.query(`update public.ledger set units = 999`), /append-only/);
  await assert.rejects(() => db.query(`delete from public.pool_equity`), /append-only/);
});

test('login: bcrypt hashes, lockout after 5 misses, logout, deactivate, input rules', async () => {
  const { db, A, ids } = await world();
  const hash = (await db.query(`select pass_hash from public.profiles where username = 'john'`)).rows[0].pass_hash;
  assert.ok(hash.startsWith('$2') && !hash.includes('john-password'), 'stored as a bcrypt hash');

  assert.equal((await login(db, 'nobody', 'whatever-123')).ok, false);
  assert.equal((await login(db, 'JOHN', 'john-password')).ok, true, 'username is case-insensitive');
  assert.equal((await login(db, 'john', 'wrong-password')).error, 'Wrong username or password');
  for (let i = 0; i < 4; i++) await login(db, 'john', 'nope-nope-' + i);   // 5th wrong attempt in a row -> locked
  const locked = await login(db, 'john', 'john-password');
  assert.equal(locked.ok, false); assert.match(locked.error, /Too many/);
  await db.exec(`update public.profiles set locked_until = now() - interval '1 minute' where username = 'john'`);
  assert.equal((await login(db, 'john', 'john-password')).ok, true, 'works again once the lock has passed');

  const T = await token(db, 'john', 'john-password');
  await call(db, 'my_summary', T); await call(db, 'logout', T);
  await assert.rejects(() => call(db, 'my_summary', T), /not signed in/);

  await assert.rejects(() => call(db, 'admin_create_user', A, 'short1', 'S', 'short', 0.2), /at least 8/);
  await assert.rejects(() => call(db, 'admin_create_user', A, 'john', 'Dup', 'duplicate-pass', 0.2), /already taken/);
  await assert.rejects(() => call(db, 'admin_create_user', A, 'Bad Name!', 'X', 'password-123', 0.2), /username/);

  const T2 = await token(db, 'dino', 'dino-password');   // deactivated people are signed out and cannot sign in
  await call(db, 'admin_set_profile', A, ids.dino, null, false, null);
  await assert.rejects(() => call(db, 'my_summary', T2), /not signed in/);
  assert.equal((await login(db, 'dino', 'dino-password')).ok, false);
  await call(db, 'admin_set_profile', A, ids.dino, null, true, null);
  assert.equal((await login(db, 'dino', 'dino-password')).ok, true);
  await assert.rejects(() => call(db, 'admin_set_profile', A, ids.raf, null, false, null), /cannot be deactivated/);
});

test('passwords: each person can change their own; the manager can reset anyone', async () => {
  const { db, A, ids } = await world();
  const J1 = await token(db, 'john', 'john-password'), J2 = await token(db, 'john', 'john-password');   // two devices
  await assert.rejects(() => call(db, 'change_my_password', J1, 'wrong-old-pass', 'brand-new-pass'), /current password is wrong/);
  await assert.rejects(() => call(db, 'change_my_password', J1, 'john-password', 'short'), /at least 8/);
  await call(db, 'change_my_password', J1, 'john-password', 'brand-new-pass');
  assert.equal((await login(db, 'john', 'john-password')).ok, false, 'old password stops working');
  assert.equal((await login(db, 'john', 'brand-new-pass')).ok, true);
  await call(db, 'my_summary', J1);                                            // this device stays signed in
  await assert.rejects(() => call(db, 'my_summary', J2), /not signed in/);   // other devices are signed out

  const D = await token(db, 'dino', 'dino-password');   // manager resets Dino's forgotten password
  await call(db, 'admin_set_password', A, ids.dino, 'reset-by-manager');
  await assert.rejects(() => call(db, 'my_summary', D), /not signed in/);
  assert.equal((await login(db, 'dino', 'dino-password')).ok, false);
  assert.equal((await login(db, 'dino', 'reset-by-manager')).ok, true);

  await call(db, 'admin_set_password', A, ids.raf, 'new-manager-pass');      // manager changes their own and stays signed in
  await call(db, 'admin_overview', A);
  assert.equal((await login(db, 'raf', 'admin-password-1')).ok, false);
  assert.equal((await login(db, 'raf', 'new-manager-pass')).ok, true);
  await db.exec(`update public.profiles set locked_until = now() + interval '10 minutes', failed_attempts = 3 where username = 'john'`);
  await call(db, 'admin_set_password', A, ids.john, 'unlocked-by-admin');     // a reset also clears a lockout
  assert.equal((await login(db, 'john', 'unlocked-by-admin')).ok, true);
});

test('withdrawal requests: locked units are refused, pay-by date is 7 business days out', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 50); await call(db, 'admin_deposit', A, ids.john, 30, 50);
  const J = await token(db, 'john', 'john-password');
  await assert.rejects(() => call(db, 'request_withdrawal', J, 10), /locked/);
  const d = (await db.query(`select public.add_business_days('2026-10-23'::date, 7) as d`)).rows[0].d;   // Fri -> Tue, two weeks later
  assert.equal(new Date(d).toISOString().slice(0, 10), '2026-11-03');
});

test('view as: the manager sees exactly what a person sees, but cannot act as them', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 50); await call(db, 'admin_deposit', A, ids.john, 30, 50);
  const J = await token(db, 'john', 'john-password');
  const V = (await call(db, 'admin_view_as', A, ids.john)).token;
  const seen = await call(db, 'my_summary', V), real = await call(db, 'my_summary', J);
  assert.equal(seen.impersonated, true); assert.equal(real.impersonated, false);
  assert.equal(seen.id, ids.john); near(seen.value_usdt, Number(real.value_usdt));
  assert.deepEqual(await call(db, 'my_ledger', V), await call(db, 'my_ledger', J));
  await assert.rejects(() => call(db, 'change_my_password', V, 'john-password', 'taken-over-123'), /view-only/);
  await assert.rejects(() => call(db, 'request_withdrawal', V, 1), /view-only/);
  await assert.rejects(() => call(db, 'cancel_withdrawal_request', V, 1), /view-only/);
  await assert.rejects(() => call(db, 'admin_overview', V), /admin only/);
  await assert.rejects(() => call(db, 'admin_view_as', J, ids.dino), /admin only/);
  await assert.rejects(() => call(db, 'admin_view_as', A, ids.raf), /that is you/);
  assert.equal((await login(db, 'john', 'john-password')).ok, true, "john's own login is untouched");
});

test('history: one point per pool event, worth = units x price; backdated entries keep their dates', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 50, null, 58, 2900, null, '2026-01-01T00:00:00Z');
  await call(db, 'admin_post_equity', A, 55, null, null, '2026-01-10T00:00:00Z');
  await call(db, 'admin_deposit', A, ids.john, 33, 55, 58, 1914, null, '2026-02-01T00:00:00Z');   // price 1.1 -> 30 units
  await call(db, 'admin_post_equity', A, 96, null, null, '2026-03-01T00:00:00Z');                  // 80 units -> 1.2
  await assert.rejects(() => call(db, 'admin_post_equity', A, 96, null, null, '2026-02-15T00:00:00Z'), /after the last entry/);
  await assert.rejects(() => call(db, 'admin_post_equity', A, 96, null, null, '2099-01-01T00:00:00Z'), /future/);
  const jT = await token(db, 'john', 'john-password');
  const h = await call(db, 'my_history', jT);
  assert.equal(h.length, 2, 'starts at his first deposit');
  assert.equal(new Date(h[0].ts).toISOString(), '2026-02-01T00:00:00.000Z');
  near(h[0].value, 33); near(h[0].net_in, 33); near(h[1].value, 36); near(h[1].price, 1.2);
  const mine = await call(db, 'my_ledger', jT);
  assert.equal(String(mine[0].lock_until).slice(0, 10), '2026-05-01', 'lock-up counts from the recorded date');
  near((await call(db, 'my_summary', jT)).unlocked_units, 30, 1e-9);   // May 1 has passed, so he can withdraw
  const r = await call(db, 'request_withdrawal', jT, 10); assert.ok(r.pay_by);
  const ah = await call(db, 'my_history', A);
  assert.equal(ah.length, 4); near(ah[3].value, 50 / 1.0 * 1.2);
});

test('corrections: undo only reaches the single most recent entry, by appending a reversal', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_deposit', A, ids.raf, 50);                 // first deposit: 50 units @ 1
  await call(db, 'admin_deposit', A, ids.john, 30, 50);             // 30 units @ 1 -> total 80

  // undo a deposit that was NOT the person's first: hwm must unwind to what it was before it
  await call(db, 'admin_post_equity', A, 160);                      // price 2
  await call(db, 'admin_deposit', A, ids.john, 20, 160);             // +10 units; hwm (30@1, 10@2) -> 1.25
  near((await holder(db, A, ids.john)).hwm, 1.25, 1e-9);
  await call(db, 'admin_undo_last', A);
  let john = await holder(db, A, ids.john);
  near(john.units, 30); near(john.hwm, 1); near((await call(db, 'pool_summary', A)).total_units, 80);
  near((await call(db, 'pool_summary', A)).unit_price, 2);

  // undo a person's very FIRST deposit: their holder_state row should disappear entirely, not just zero out
  const dino = await call(db, 'admin_create_user', A, 'dino2', 'Dino2', 'dino2-password', 0.2);
  await call(db, 'admin_deposit', A, dino, 20, 160);
  assert.equal((await db.query(`select * from public.holder_state where profile_id = $1`, [dino])).rows.length, 1);
  await call(db, 'admin_undo_last', A);
  assert.equal((await db.query(`select * from public.holder_state where profile_id = $1`, [dino])).rows.length, 0);
  near((await call(db, 'pool_summary', A)).total_units, 80);

  // undo an equity reading: price falls back to what it was right before that reading
  await call(db, 'admin_post_equity', A, 100);                      // price 1.25 (wrong entry, e.g. a typo)
  near((await call(db, 'pool_summary', A)).unit_price, 1.25);
  await call(db, 'admin_undo_last', A);
  near((await call(db, 'pool_summary', A)).unit_price, 2); near((await call(db, 'pool_summary', A)).equity_usdt, 160);

  // undo a withdrawal, including its profit-share fee pair: units, pay, and the manager's earned fee all unwind
  const w = await call(db, 'admin_withdraw', A, ids.john, 10, 160, null, null, true); // price 2, hwm 1 -> fee 1 unit, pay 18 (force: still inside lock-up)
  near(w.fee_units, 1, 1e-9);
  near((await holder(db, A, ids.raf)).fee_units_earned, 1, 1e-9);
  await call(db, 'admin_undo_last', A);
  john = await holder(db, A, ids.john);
  near(john.units, 30); near(john.hwm, 1);
  near((await holder(db, A, ids.raf)).fee_units_earned, 0, 1e-9);
  near((await call(db, 'pool_summary', A)).total_units, 80); near((await call(db, 'pool_summary', A)).equity_usdt, 160);

  // a quarter close is final: never offered as something to undo
  await call(db, 'admin_close_quarter', A, 160);
  await assert.rejects(() => call(db, 'admin_undo_last', A), /final/);

  // only an admin can call this, and there must be something to undo
  const jT2 = await token(db, 'john', 'john-password');
  await assert.rejects(() => call(db, 'admin_undo_last', jT2), /admin only/);
});

test('10% profit share: each quarter only the NEW profit is charged, never profit already settled', async () => {
  const { db, A, ids } = await world();
  await db.exec(`update public.profiles set fee_rate = 0.10 where role = 'investor'`);
  const fresh = await call(db, 'admin_create_user', A, 'newbie', 'New', 'newbie-password', null);
  near((await holder(db, A, fresh)).fee_rate, 0.10);                                  // new accounts default to 10%
  await call(db, 'admin_deposit', A, ids.raf, 1000, null, 58, null, null);
  await call(db, 'admin_deposit', A, ids.john, 1000, 1000, 58, null, null);          // John: 1000 units at 1.00
  const fees = async () => Number((await db.query(`select coalesce(sum(usdt),0) as v from public.ledger where kind = 'fee_in'`)).rows[0].v);

  await call(db, 'admin_close_quarter', A, 2200, 58, 'q1');                           // price 1.10: John gained $100
  near(await fees(), 10, 1e-4);                                                       // 10% of $100
  near((await holder(db, A, ids.john)).value_usdt, 1090, 1e-3);
  near((await holder(db, A, ids.john)).hwm, 1.1);

  await call(db, 'admin_close_quarter', A, 2200, 58, 'q2 flat');                      // nothing new: nothing charged
  near(await fees(), 10, 1e-4);

  await call(db, 'admin_close_quarter', A, 2000, 58, 'q3 down');                      // below the line: nothing charged
  near(await fees(), 10, 1e-4);
  await call(db, 'admin_close_quarter', A, 2200, 58, 'q4 back to the old line');      // only back to 1.10: still nothing
  near(await fees(), 10, 1e-4);

  const john = await holder(db, A, ids.john);                                         // 990.909 units
  await call(db, 'admin_close_quarter', A, 2420, 58, 'q5 +10%');                      // price 1.21: only the 0.11/unit above 1.10 counts
  near(await fees() - 10, 0.1 * 0.11 * Number(john.units), 1e-3);
});

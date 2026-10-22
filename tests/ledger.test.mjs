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
const PENDING = new URL('../supabase/migrations/20261026000000_pending_deposits.sql', import.meta.url);
const HARDEN = new URL('../supabase/migrations/20261027000000_profit_share_hardening.sql', import.meta.url);
const TERMS = new URL('../supabase/migrations/20261028000000_terms_acceptance.sql', import.meta.url);
const NET = new URL('../supabase/migrations/20261030000000_net_of_fee_returns.sql', import.meta.url);
const near =(a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions;
    grant usage on schema public to anon, authenticated;`);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(HIDE_POOL, 'utf8'));
  await db.exec(readFileSync(CORRECTIONS, 'utf8'));
  await db.exec(readFileSync(FEE_10, 'utf8'));
  await db.exec(readFileSync(PENDING, 'utf8'));
  await db.exec(readFileSync(HARDEN, 'utf8'));
  await db.exec(readFileSync(TERMS, 'utf8'));
  await db.exec(readFileSync(NET, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '0' where key = 'min_days_between_closes'`);   // tests close quarters back to back
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);   // fast hashing for tests
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  return db;
}
const call = async (db, fn, ...args) => {
  await db.exec('set role anon');
  try { return (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r; }
  finally { await db.exec('reset role'); }
};
// as the database owner (like the seed script): for admin_deposit, which the website may no longer call
const own = async (db, fn, ...args) => (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
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
  await own(db, 'admin_deposit', A, ids.raf, 50, null, 56, 2800, 'own capital');
  await own(db, 'admin_deposit', A, ids.john, 30, 50, 56, 1680, null);
  await own(db, 'admin_deposit', A, ids.dino, 20, 80, 56, 1120, null);
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
  const dep = await own(db, 'admin_deposit', A, maria, 4, 112);
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
  await own(db, 'admin_deposit', A, ids.raf, 100, null, 56); await own(db, 'admin_deposit', A, ids.john, 12.5, 100, 56);   // ~ ₱700
  await call(db, 'admin_post_equity', A, 112.5 * 1.05, 70);   // pool +5% while the peso moved 25%
  const john = await holder(db, A, ids.john);
  near(john.return_pct, 0.05, 1e-9); near(john.value_usdt, 12.5 * 1.05, 1e-9);
});

test('security: everything needs a token; investors see only their own data; hashes never leave', async () => {
  const { db, A, ids } = await world();
  await own(db, 'admin_deposit', A, ids.raf, 50); await own(db, 'admin_deposit', A, ids.john, 30, 50); await own(db, 'admin_deposit', A, ids.dino, 20, 80);
  const J = await token(db, 'john', 'john-password');

  for (const t of ['profiles', 'ledger', 'sessions', 'pool_equity', 'ledger_settings', 'holder_state', 'withdrawal_requests', 'pending_deposits', 'holder_lots', 'lot_log', 'terms_acceptances']) {
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
  await assert.rejects(() => own(db, 'admin_deposit', J, ids.john, 1000, 100), /admin only/);
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
  await own(db, 'admin_deposit', A, ids.raf, 50); await own(db, 'admin_deposit', A, ids.john, 30, 50);
  const J = await token(db, 'john', 'john-password');
  await assert.rejects(() => call(db, 'request_withdrawal', J, 10), /locked/);
  const d = (await db.query(`select public.add_business_days('2026-10-23'::date, 7) as d`)).rows[0].d;   // Fri -> Tue, two weeks later
  assert.equal(new Date(d).toISOString().slice(0, 10), '2026-11-03');
});

test('view as: the manager sees exactly what a person sees, but cannot act as them', async () => {
  const { db, A, ids } = await world();
  await own(db, 'admin_deposit', A, ids.raf, 50); await own(db, 'admin_deposit', A, ids.john, 30, 50);
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
  await own(db, 'admin_deposit', A, ids.raf, 50, null, 58, 2900, null, '2026-01-01T00:00:00Z');
  await call(db, 'admin_post_equity', A, 55, null, null, '2026-01-10T00:00:00Z');
  await own(db, 'admin_deposit', A, ids.john, 33, 55, 58, 1914, null, '2026-02-01T00:00:00Z');   // price 1.1 -> 30 units
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
  await own(db, 'admin_deposit', A, ids.raf, 50);                 // first deposit: 50 units @ 1
  await own(db, 'admin_deposit', A, ids.john, 30, 50);             // 30 units @ 1 -> total 80

  // undo a deposit that was NOT the person's first: hwm must unwind to what it was before it
  await call(db, 'admin_post_equity', A, 160);                      // price 2
  await own(db, 'admin_deposit', A, ids.john, 20, 160);             // +10 units; hwm (30@1, 10@2) -> 1.25
  near((await holder(db, A, ids.john)).hwm, 1.25, 1e-9);
  await call(db, 'admin_undo_last', A);
  let john = await holder(db, A, ids.john);
  near(john.units, 30); near(john.hwm, 1); near((await call(db, 'pool_summary', A)).total_units, 80);
  near((await call(db, 'pool_summary', A)).unit_price, 2);

  // undo a person's very FIRST deposit: their lot should disappear entirely, not just zero out
  const dino = await call(db, 'admin_create_user', A, 'dino2', 'Dino2', 'dino2-password', 0.2);
  await own(db, 'admin_deposit', A, dino, 20, 160);
  assert.equal((await db.query(`select * from public.holder_lots where profile_id = $1`, [dino])).rows.length, 1);
  await call(db, 'admin_undo_last', A);
  assert.equal((await db.query(`select * from public.holder_lots where profile_id = $1`, [dino])).rows.length, 0);
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
  await own(db, 'admin_deposit', A, ids.raf, 1000, null, 58, null, null);
  await own(db, 'admin_deposit', A, ids.john, 1000, 1000, 58, null, null);          // John: 1000 units at 1.00
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

test('newcomer: money waits, then buys units at the next reading; profit made before stays with the old holders', async () => {
  const { db, A, ids } = await world();
  await own(db, 'admin_deposit', A, ids.raf, 50, null);
  await own(db, 'admin_deposit', A, ids.john, 50, 50);   // 100 units at 1.00
  // the trading makes +20 (not recorded yet) and Dino sends 30: it only waits, it owns nothing
  const r = await call(db, 'admin_receive_deposit', A, ids.dino, 30, 56, 1680);
  near(r.pending_usdt, 30); near((await holder(db, A, ids.dino)).units, 0);
  const dT = await token(db, 'dino', 'dino-password');
  near((await call(db, 'my_pending', dT))[0].usdt, 30);
  // next reading: MEXC shows 150 = 120 for the old holders + Dino's 30 still waiting
  const up = await call(db, 'admin_post_equity', A, 150);
  near(up.converted, 1);
  let dino = await holder(db, A, ids.dino), john = await holder(db, A, ids.john);
  near(dino.unit_price, 1.2); near(dino.units, 25); near(dino.value_usdt, 30); near(dino.hwm, 1.2);
  near(john.value_usdt, 60);   // John keeps all of his +10
  assert.equal((await call(db, 'my_pending', dT)).length, 0);
  // from now on everyone gets the same %
  await call(db, 'admin_post_equity', A, 165);
  near((await holder(db, A, ids.dino)).value_usdt, 33); near((await holder(db, A, ids.john)).value_usdt, 66);
  // quarter close: each pays 20% only on profit made while THEY were in (Dino +3, John +16)
  await call(db, 'admin_close_quarter', A, 165);
  near((await holder(db, A, ids.dino)).value_usdt, 33 - 0.2 * 3, 1e-4);
  near((await holder(db, A, ids.john)).value_usdt, 66 - 0.2 * 16, 1e-4);
});

test('waiting money never moves the price: withdrawals and closes subtract it; undo puts it back to waiting; cancel', async () => {
  const { db, A, ids } = await world();
  await own(db, 'admin_deposit', A, ids.raf, 50, null);
  await own(db, 'admin_deposit', A, ids.john, 50, 50);
  await call(db, 'admin_receive_deposit', A, ids.dino, 40);
  const w = await call(db, 'admin_withdraw', A, ids.raf, 10, 140);   // MEXC 140 = 100 + 40 waiting: price stays 1.00
  near(w.unit_price, 1); near(w.pay_usdt, 10);
  await assert.rejects(() => call(db, 'admin_post_equity', A, 30), /more than the deposits still waiting/);
  const c = await call(db, 'admin_close_quarter', A, 130);   // 90 + 40 waiting: no profit, no fee; Dino joins after the close
  near(c.investors_charged, 0); near(c.converted, 1); near((await holder(db, A, ids.dino)).units, 40);
  const u = await call(db, 'admin_undo_last', A);
  assert.equal(u.back_to_pending, true);
  near((await holder(db, A, ids.dino)).units, 0);
  const pend = await call(db, 'admin_pending', A);
  assert.equal(pend.length, 1); assert.equal(pend[0].name, 'Dino');
  await call(db, 'admin_cancel_pending', A, pend[0].id);   // handed back: nothing left waiting
  assert.equal((await call(db, 'admin_pending', A)).length, 0);
  const jT = await token(db, 'john', 'john-password');
  await assert.rejects(() => call(db, 'admin_receive_deposit', jT, ids.john, 5), /admin only/);
  await assert.rejects(() => call(db, 'admin_pending', jT), /admin only/);
  await assert.rejects(() => call(db, '_convert_all_pending', 1, new Date().toISOString(), ids.raf), /permission denied/);
});

test('the very first money can also wait: it converts at 1.00, and a different first reading reprices', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_receive_deposit', A, ids.raf, 60);
  await call(db, 'admin_receive_deposit', A, ids.john, 40);
  const r = await call(db, 'admin_post_equity', A, 99);
  near(r.converted, 2); near((await holder(db, A, ids.john)).units, 40); near((await call(db, 'pool_summary', A)).unit_price, 0.99);
});

// ---------------------------------------------------------------- loophole audit: each test is one way someone could try to game the books
const setting = (db, k, v) => db.query(`update public.ledger_settings set value = $1 where key = $2`, [String(v), k]);
const feeValue = async (db, A, id) => -(await call(db, 'admin_ledger', A)).filter((l) => l.profile_id === id && l.kind === 'fee_out').reduce((t, l) => t + Number(l.usdt), 0);
async function twoHolders() {   // Raf 100 + John 100 at 1.00, 20% for John, no lock-up, closes allowed any time
  const w = await world();
  await setting(w.db, 'lock_months', 0); await setting(w.db, 'min_days_between_closes', 0);
  await call(w.db, 'admin_receive_deposit', w.A, w.ids.raf, 100); await call(w.db, 'admin_receive_deposit', w.A, w.ids.john, 100);
  await call(w.db, 'admin_post_equity', w.A, 200);
  return w;
}

test('loophole: topping up at a high cannot wipe out the profit share already earned on the old money', async () => {
  const { db, A, ids } = await twoHolders();
  await call(db, 'admin_post_equity', A, 300);                                   // price 1.50: John's 100 units are +50
  await call(db, 'admin_receive_deposit', A, ids.john, 1350); await call(db, 'admin_post_equity', A, 1650);   // tops up 900 units at 1.50
  await call(db, 'admin_close_quarter', A, 1100 * 1.2);                          // 1,100 units; price dips to 1.20 before the close
  near(await feeValue(db, A, ids.john), 0.2 * 0.2 * 100, 1e-4);                   // the old 100 units still owe 20% of their +0.20 each = 4
});

test('loophole: an old loss cannot shield new money from the profit share', async () => {
  const { db, A, ids } = await twoHolders();
  await call(db, 'admin_close_quarter', A, 300);                                 // 1.50, settled: John's line is 1.50
  const after = Number((await call(db, 'pool_summary', A)).total_units);
  await call(db, 'admin_post_equity', A, after * 1.0);                           // back to 1.00: John's old units are 0.50 under their line
  await call(db, 'admin_receive_deposit', A, ids.john, 1000); await call(db, 'admin_post_equity', A, after + 1000);   // 1000 new units at 1.00
  const fee0 = await feeValue(db, A, ids.john);
  await call(db, 'admin_close_quarter', A, (after + 1000) * 1.2);                // +0.20 on the new 1000 units
  near((await feeValue(db, A, ids.john)) - fee0, 0.2 * 0.2 * 1000, 1e-4);        // = 40; the old units owe nothing until they pass 1.50
});

test('loophole: a higher profit-share rate only starts after the next quarter close', async () => {
  const { db, A, ids } = await twoHolders();
  await call(db, 'admin_post_equity', A, 300);
  await call(db, 'admin_set_profile', A, ids.john, null, null, 0.5);            // raised mid-quarter, after the gains
  near((await holder(db, A, ids.john)).fee_rate, 0.2); near((await holder(db, A, ids.john)).fee_rate_next, 0.5);
  await call(db, 'admin_close_quarter', A, 300);
  near(await feeValue(db, A, ids.john), 0.2 * 0.5 * 100, 1e-4);                   // charged at the old 20%
  near((await holder(db, A, ids.john)).fee_rate, 0.5);                            // the new rate applies from now on
  await call(db, 'admin_set_profile', A, ids.john, null, null, 0.1);            // a lower rate applies at once
  near((await holder(db, A, ids.john)).fee_rate, 0.1);
});

test('loophole: quarter closes cannot be repeated to crystallise more profit share', async () => {
  const { db, A } = await twoHolders();
  await setting(db, 'min_days_between_closes', 80);
  await call(db, 'admin_close_quarter', A, 300);
  await assert.rejects(() => call(db, 'admin_close_quarter', A, 320), /quarter close/);
});

test('loophole: withdrawal requests cannot add up to more than what is unlocked, and a request is paid once', async () => {
  const { db, A, ids } = await twoHolders();
  const jT = await token(db, 'john', 'john-password');
  await call(db, 'request_withdrawal', jT, 60);
  await assert.rejects(() => call(db, 'request_withdrawal', jT, 60), /pending/);
  const req = (await call(db, 'admin_requests', A))[0];
  await call(db, 'admin_withdraw', A, ids.john, 60, 200, null, null, false, req.id);
  await assert.rejects(() => call(db, 'admin_withdraw', A, ids.john, 40, 140, null, null, false, req.id), /not waiting/);
});

test('loophole: the instant deposit (bypasses waiting) cannot be called from the website', async () => {
  const { db, A, ids } = await twoHolders();
  await assert.rejects(() => call(db, 'admin_deposit', A, ids.john, 10, 200), /permission denied/);
});

test('stress: 150 random actions (money in, readings, withdrawals, closes, undos) never break the books', async () => {
  const { db, A, ids } = await world();
  await setting(db, 'lock_months', 0);
  const people = [ids.raf, ids.john, ids.dino];
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  await call(db, 'admin_receive_deposit', A, ids.raf, 100); await call(db, 'admin_post_equity', A, 100);
  let ok = 0;
  for (let i = 0; i < 150; i++) {
    const pool = await call(db, 'pool_summary', A), price = Number(pool.unit_price), units = Number(pool.total_units);
    const waiting = (await call(db, 'admin_pending', A)).reduce((t, d) => t + Number(d.usdt), 0);
    const total = (p) => units * p + waiting;   // what MEXC would show at unit price p
    const who = people[Math.floor(rnd() * 3)], x = rnd();
    try {
      if (x < 0.25) await call(db, 'admin_receive_deposit', A, who, 5 + Math.round(rnd() * 200));
      else if (x < 0.55) await call(db, 'admin_post_equity', A, total(price * (0.85 + rnd() * 0.35)));
      else if (x < 0.75) { const h = await holder(db, A, who); if (Number(h.units) > 0) await call(db, 'admin_withdraw', A, who, Number(h.units) * rnd(), total(price)); }
      else if (x < 0.88) await call(db, 'admin_close_quarter', A, total(price * (0.9 + rnd() * 0.25)));
      else if (x < 0.96) await call(db, 'admin_undo_last', A);
      else { const pend = await call(db, 'admin_pending', A); if (pend.length) await call(db, 'admin_cancel_pending', A, pend[0].id); }
      ok++;
    } catch (e) { if (!/final|nothing to undo|must be more than/.test(e.message)) throw e; }
    // invariants after every step
    const lots = (await db.query(`select profile_id, sum(units) u from public.holder_lots group by profile_id`)).rows;
    for (const p of people) {
      const h = await holder(db, A, p), l = lots.find((r) => r.profile_id === p);
      near(Number(l ? l.u : 0), Number(h.units), 1e-6);                     // lots always add up to the person's units
      assert.ok(Number(h.accrued_fee_usdt) >= -1e-9 && Number(h.accrued_fee_usdt) <= Number(h.value_usdt) + 1e-9);
    }
    const all = await call(db, 'admin_overview', A), sumVal = all.reduce((t, h) => t + Number(h.value_usdt), 0);
    near(sumVal, Number((await call(db, 'pool_summary', A)).equity_usdt), 1e-4);   // everyone's money adds up to the fund
  }
  assert.ok(ok > 120, `only ${ok} actions ran`);
});

test('terms: nobody has agreed at first; agreeing is saved with version + time, once per version, and can never be edited or faked', async () => {
  const { db, A, ids } = await world();
  const jT = await token(db, 'john', 'john-password');
  let me = await call(db, 'my_summary', jT);
  assert.equal(me.terms_version, null); assert.equal(me.terms_accepted_at, null);
  assert.equal((await holder(db, A, ids.john)).terms_version, null);            // the manager sees "not yet"
  const r = await call(db, 'accept_terms', jT, '2026-10-22');
  assert.equal(r.version, '2026-10-22');
  me = await call(db, 'my_summary', jT);
  assert.equal(me.terms_version, '2026-10-22'); assert.ok(me.terms_accepted_at);
  const seen = await holder(db, A, ids.john);
  assert.equal(seen.terms_version, '2026-10-22'); assert.ok(seen.terms_accepted_at);   // ...and "accepted <date>"
  assert.equal((await holder(db, A, ids.dino)).terms_version, null);            // only John agreed
  const again = await call(db, 'accept_terms', jT, '2026-10-22');                // same version again: no second row, same time
  assert.equal(again.accepted_at, r.accepted_at);
  assert.equal((await db.query(`select count(*)::int n from public.terms_acceptances`)).rows[0].n, 1);
  await call(db, 'accept_terms', jT, '2027-01-01');                              // new wording: asked again, newest version wins
  assert.equal((await call(db, 'my_summary', jT)).terms_version, '2027-01-01');
  await assert.rejects(() => db.query(`update public.terms_acceptances set version = 'x'`), /append-only/);
  await assert.rejects(() => db.query(`delete from public.terms_acceptances`), /append-only/);
  await assert.rejects(() => call(db, 'accept_terms', jT, '   '), /version missing/);
  await assert.rejects(() => call(db, 'accept_terms', jT, 'x'.repeat(41)), /version missing/);
  await assert.rejects(() => call(db, 'accept_terms', 'not-a-token', '2026-10-22'), /not signed in/);
});

test('terms: the manager cannot agree on someone else\'s behalf while viewing as them', async () => {
  const { db, A, ids } = await world();
  const v = await call(db, 'admin_view_as', A, ids.john);
  await assert.rejects(() => call(db, 'accept_terms', v.token, '2026-10-22'), /view-only/);
  assert.equal((await db.query(`select count(*)::int n from public.terms_acceptances`)).rows[0].n, 0);
  assert.equal((await call(db, 'my_summary', v.token)).terms_version, null);     // the app skips the gate for "view as" sessions
});

test('net of fee: balance and % shown after the profit share (taken + owed); gross - cut = net, also after a drop', async () => {
  const { db, A, ids } = await world();   // John pays 20%
  await own(db, 'admin_deposit', A, ids.raf, 50, null, 58, 2900, null);
  await own(db, 'admin_deposit', A, ids.john, 50, 50, 58, 2900, null);
  await call(db, 'admin_post_equity', A, 120);   // price 1.20, nothing charged yet: the cut is only owed
  let j = await holder(db, A, ids.john);
  near(j.gross_return_pct, 0.2); near(j.accrued_fee_usdt, 2); near(j.profit_share_usdt, 2);
  near(j.net_value_usdt, 58); near(j.net_profit_usdt, 8); near(j.net_return_pct, 0.16); near(j.profit_share_pct_points, 0.04);

  await call(db, 'admin_close_quarter', A, 120);   // charged: same numbers, now as units moved
  j = await holder(db, A, ids.john);
  near(j.fee_paid_units, 2 / 1.2); near(j.fee_paid_usdt, 2); near(j.accrued_fee_usdt, 0); near(j.net_value_usdt, 58); near(j.net_return_pct, 0.16);

  await call(db, 'admin_post_equity', A, 108);   // -10%: the cut already taken stays taken, nothing new owed
  j = await holder(db, A, ids.john);
  near(j.gross_value_usdt, 54); near(j.gross_return_pct, 0.08); near(j.accrued_fee_usdt, 0);
  near(j.profit_share_usdt, 1.8); near(j.net_value_usdt, 52.2); near(j.net_return_pct, 0.044);
  near(j.gross_return_pct - j.profit_share_pct_points, j.net_return_pct);
  const me = await holder(db, A, ids.raf);   // the manager pays no cut: gross = net = value
  near(me.profit_share_usdt, 0); near(me.net_value_usdt, me.value_usdt); near(me.gross_value_usdt, me.value_usdt);
});

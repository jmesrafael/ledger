// Units from the fund manager (supabase/migrations/20261201000000_units_from_manager.sql): an investor pays the manager directly and receives the manager's units,
// so nothing goes into the exchange. Every migration on an in-memory Postgres (PGlite); every call as "anon". Rate 20%, fee_timing 'immediate' (as in production now).
//   U1  units move, equity / total units / price do not; nobody else's value moves; the investor's mark rises by what they paid
//   U2  the investor is charged only on gain AFTER the transfer; the manager pays nothing
//   U3  refusals: not enough manager units, a non-investor, a deactivated account, a bad amount, an empty pool; nothing is saved
//   U4  the quote is the real call's result and saves nothing
//   U5  undo restores everything exactly and does not invent a waiting deposit
//   U6  a retried request is a replay
//   U7  the round trip with the existing "paid by the fund manager" withdrawal conserves units and value
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(Number(a) - b) <= eps, `${msg} ${a} != ${b}`);
const NOTE = 'checked against the exchange app by hand for this test';

async function world({ settings = {} } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', settlement_schedule: 'free', fee_timing: 'immediate', ...settings };
  for (const [k, v] of Object.entries(set)) await db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', 0.2);
  let day = 0;
  const w = { db, call, q, A, ids, d: () => new Date(Date.UTC(2026, 2, 1 + day++, 4)).toISOString() };
  w.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[who]]))[0].u);
  w.pool = async () => (await q(`select equity_usdt::float e, total_units::float u, unit_price::float p from public.pool_equity order by id desc limit 1`))[0];
  w.mark = async (who) => Number((await q(`select hwm_value v from public.investor_hwm where profile_id=$1`, [ids[who]]))[0]?.v ?? 0);
  w.join = async (who, usdt) => {
    await call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, w.d(), null, true);
    const p = (await q(`select 1 from public.pool_equity limit 1`)).length ? await w.pool() : null;
    const pend = Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
    return call('admin_post_equity', A, p ? p.e + pend : usdt, 58, null, w.d());
  };
  w.value = async (price) => { const p = await w.pool(); return call('admin_post_equity', A, p.u * price, 58, null, w.d()); };   // the exchange total that gives this price
  w.give = (who, usdt, eq, o = {}) => call('admin_units_from_manager', A, ids[who], usdt, eq, 58, usdt * 58, o.note ?? null, w.d(), o.idem ?? null, false);
  w.trace = async () => (await q(`select (select count(*)::int from public.pool_equity) e, (select count(*)::int from public.ledger) l, (select count(*)::int from public.pending_deposits) d,
    (select coalesce(sum(hwm_value), 0)::float from public.investor_hwm) h`))[0];
  return w;
}
// the pool: the manager 1000, dino 500, at price 1.25 after a gain
async function seeded() {
  const w = await world();
  await w.join('raf', 1000); await w.join('dino', 500);
  await w.value(1.25);                                                    // 1500 units, equity 1875
  return w;
}

test('U1 units move from the manager to the investor; equity, total units and price do not move; nobody else changes', async () => {
  const w = await seeded();
  const before = await w.pool(), dino0 = await w.units('dino'), raf0 = await w.units('raf');
  const r = await w.give('john', 100, before.e);                          // john paid the manager 100 USDT in cash
  near(r.unit_price, 1.25, 1e-12); near(r.units, 80, 1e-12, 'hand: 100 / 1.25 = 80 units');
  near(await w.units('john'), 80, 1e-12); near(await w.units('raf'), raf0 - 80, 1e-12, "the manager's units go down by the same 80");
  const after = await w.pool();
  near(after.e, before.e, 0, 'the pool equity is unchanged (nothing went into the exchange)'); near(after.u, before.u, 0, 'total units unchanged'); near(after.p, 1.25, 1e-12, 'price unchanged');
  near(await w.units('dino'), dino0, 0, "dino's units are untouched");
  near(await w.mark('john'), 100, 1e-12, "john's mark = what he paid, so he is only charged on gain after this");
  const rows = await w.q(`select kind, units::float u, usdt::float usdt from public.ledger where equity_id = $1 order by id`, [r.equity_id]);
  assert.deepEqual(rows.map((x) => x.kind), ['deposit', 'withdrawal'], 'john: deposit (his invested capital); manager: withdrawal (cashed out)');
  near(rows[0].usdt, 100); near(rows[1].usdt, -100);
  const rep = await w.call('admin_integrity_report', w.A);
  assert.deepEqual(rep.checks.filter((c) => c.count > 0 && c.severity === 'critical').map((c) => c.id), []);
});

test('U2 the investor pays a fee only on gain after the transfer; the manager pays none', async () => {
  const w = await seeded();
  await w.give('john', 100, (await w.pool()).e);
  await w.value(1.5);                                                     // john: 80 units x 1.5 = 120, gain 20 above his 100
  const t = (await w.pool()).e, at = w.d();                              // the exception and the settlement carry the same date (as in every settlement test)
  await w.call('admin_attest_settlement', w.A, t, NOTE, at, 0);
  await w.call('admin_close_quarter', w.A, t, 58, null, at, null, false, null);
  const line = (await w.q(`select fee_usdt::float f from public.settlement_lines where profile_id = $1`, [w.ids.john]))[0];
  near(line.f, 4, 1e-5, 'hand: 20% x (120 - 100) = 4: nothing on the 1.00 -> 1.25 move before he joined');
  const raf = await w.q(`select count(*)::int n from public.settlement_lines where profile_id = $1`, [w.ids.raf]);
  assert.equal(raf[0].n, 0, 'the manager has no settlement line: no fee on own capital');
});

test('U3 refusals save nothing: not enough manager units, the manager himself, a deactivated account, a bad amount, an empty pool', async () => {
  const w = await seeded();
  const eq = (await w.pool()).e, t0 = await w.trace();
  await assert.rejects(() => w.give('john', 1300, eq), /you hold 1000\.00000000 units \(worth 1250\.00 USDT/, 'the manager holds 1000 units = 1250 USDT');
  await assert.rejects(() => w.call('admin_units_from_manager', w.A, w.ids.raf, 10, eq, 58, null, null, w.d(), null, false), /only an investor/);
  await assert.rejects(() => w.give('john', 0, eq), /more than 0/);
  await assert.rejects(() => w.give('john', 10.1234567, eq), /at most 6 decimals/);
  await w.call('admin_set_profile', w.A, w.ids.john, null, false, null);
  await assert.rejects(() => w.give('john', 10, eq), /deactivated/);
  assert.deepEqual(await w.trace(), t0, 'nothing was saved by any refusal');
  const e = await world();
  await assert.rejects(() => e.give('john', 10, 100), /no units yet/);
});

test('U4 the quote is the real call\'s result and saves nothing', async () => {
  const w = await seeded();
  const eq = (await w.pool()).e, t0 = await w.trace();
  const qt = await w.call('admin_quote_units_from_manager', w.A, w.ids.john, 100, eq, 58, w.d(), false);
  assert.deepEqual(await w.trace(), t0, 'a quote writes nothing');
  assert.equal(qt.quote, true);
  const real = await w.give('john', 100, eq);
  for (const k of ['unit_price', 'units', 'manager_units_after']) near(qt[k], Number(real[k]), 0, k);
  await assert.rejects(() => w.call('admin_quote_units_from_manager', w.A, w.ids.john, 99999, eq, 58, w.d(), false), /you hold/, 'the quote shows the same refusal');
});

test('U5 undo restores units, the mark and the books exactly, and does not invent a waiting deposit', async () => {
  const w = await seeded();
  const t0 = await w.trace(), raf0 = await w.units('raf');
  await w.give('john', 100, (await w.pool()).e);
  await w.call('admin_undo_last', w.A, 'typo');
  near(await w.units('john'), 0, 0); near(await w.units('raf'), raf0, 0);
  near(await w.mark('john'), 0, 0, 'his mark is back');
  const t1 = await w.trace();
  assert.equal(t1.d, t0.d, 'no waiting deposit was created by the undo');
  near(t1.h, t0.h, 1e-9);
  const rep = await w.call('admin_integrity_report', w.A);
  assert.deepEqual(rep.checks.filter((c) => c.count > 0 && c.severity === 'critical').map((c) => c.id), []);
});

test('U6 a retried request with the same id is a replay: units move once', async () => {
  const w = await seeded();
  const eq = (await w.pool()).e;
  const a = await w.give('john', 100, eq, { idem: 'give-1' }), b = await w.give('john', 100, eq, { idem: 'give-1' });
  assert.equal(b.replayed, true); near(b.units, Number(a.units), 0);
  near(await w.units('john'), 80, 1e-12, 'only once');
});

test('U7 round trip with the existing "paid by the fund manager" withdrawal: units and value are conserved', async () => {
  const w = await seeded();
  const total0 = (await w.pool()).u;
  await w.give('john', 100, (await w.pool()).e);                          // john pays the manager, gets 80 units
  const back = await w.call('admin_withdraw_to_manager', w.A, w.ids.john, 80, (await w.pool()).e, 58, null, true, null, w.d(), null, false);   // and leaves the same way, at the same price
  near(back.pay_usdt, 100, 1e-6, 'no gain, no fee: the manager owes him back exactly 100');
  near(await w.units('john'), 0, 1e-12); near(await w.units('raf'), 1000, 1e-9, 'the manager has his 1000 units again');
  near((await w.pool()).u, total0, 0, 'total units never changed');
  const fm = await w.call('fund_manager_accounts', w.A);
  near(Number(fm.capital.units) + Number(fm.fee_entitlement.units), await w.units('raf'), 1e-9, "Fund M's own capital + fee units still add up to the manager's units");
});

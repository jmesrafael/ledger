// Withdrawal safety: the read-only quote (supabase/migrations/20261128000000_withdraw_quote.sql) and the full-exit rounding edge (NOT changed: docs/full-exit-rounding.md).
// Every migration, applied and pending, on an in-memory Postgres (PGlite); every call as "anon".
//   W1  the quote is the real withdrawal's result for the same inputs (fee, withdrawal fee, units, price, payout), under both fee timings, and leaves no trace
//   W2  the quote raises the same refusals as the real call
//   W3  full-exit rounding edge: with a pool total of more than 6 decimals the last holder's exit is REFUSED and saves nothing; at a 6-decimal total the same exit pays exactly the pool
//   W4  every payout is round(net units x price, 6), to the last digit, including zero-fee and pending-fee withdrawals
//   W5  a retried withdrawal (same request id) is a replay: one payout, one fee
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(Number(a) - b) <= eps, `${msg} ${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`;
const NOTE = 'bot has no realized PnL yet; checked against the exchange app by hand';
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function world({ settings = {}, rate = 0.2 } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(CLOCK_SQL);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', settlement_schedule: 'free', ...settings };
  for (const [k, v] of Object.entries(set)) await db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino', 'eve']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', rate);
  const pend = async () => Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
  const nav = async () => Number((await q(`select equity_usdt e from public.pool_equity order by id desc limit 1`))[0]?.e ?? 0);
  const price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  const ctx = { db, call, q, A, ids, price, nav };
  ctx.units = async (w) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[w]]))[0].u);
  ctx.total = async (p) => (await nav()) / (await price()) * p + (await pend());
  ctx.join = async (w, usdt, at) => { await call('admin_receive_deposit', A, ids[w], usdt, 58, usdt * 58, null, at, null, true);
    return (await q(`select 1 from public.pool_equity limit 1`)).length ? call('admin_post_equity', A, await ctx.total(await price()), 58, null, at) : call('admin_post_equity', A, usdt, 58, null, at); };
  ctx.settle = async (p, at) => { const t = await ctx.total(p); await call('admin_attest_settlement', A, t, NOTE, at, 0); return call('admin_close_quarter', A, t, 58, null, at, null); };
  // the same arguments the Money out form sends, to the quote and to the real call
  ctx.quote = (w, u, eq, at, o = {}) => call('admin_quote_withdraw', A, ids[w], u, eq, 58, o.force ?? true, o.mgr ?? false, at, false);
  ctx.withdraw = (w, u, eq, at, o = {}) => (o.mgr ? call('admin_withdraw_to_manager', A, ids[w], u, eq, 58, null, o.force ?? true, null, at, o.idem ?? null, false)
    : call('admin_withdraw', A, ids[w], u, eq, 58, null, o.force ?? true, null, at, o.idem ?? null, false));
  ctx.trace = async () => (await q(`select (select count(*) from public.pool_equity) e, (select count(*) from public.ledger) l, (select count(*) from public.hwm_log) h,
      (select count(*) from public.audit_log) a, (select coalesce(sum(hwm_value), 0) + coalesce(sum(last_value), 0) from public.investor_hwm) m`))[0];
  return ctx;
}
const day = (n) => new Date(Date.UTC(2026, 2, 2, 4) + n * 86400000).toISOString();

for (const timing of ['confirmed', 'immediate']) {
  test(`W1 (${timing}) the quote equals the real withdrawal for the same inputs and leaves no trace`, async () => {
    const rand = rng(timing === 'confirmed' ? 31 : 32), w = await world({ settings: { fee_timing: timing } });
    await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z'); await w.join('dino', 700, '2026-02-21T04:00:00Z');
    let n = 0;
    for (let i = 0; i < 14; i++) {
      const p = (await w.price()) * (0.85 + rand() * 0.35);
      if (rand() < 0.35) await w.settle(p, day(n++));
      const who = ['john', 'dino'][i % 2], held = await w.units(who);
      if (held < 1e-6) { await w.join(who, 400, day(n++)); continue; }
      const units = rand() < 0.25 ? held : Math.round(held * (0.05 + rand() * 0.6) * 1e8) / 1e8, eq = await w.total(p), at = day(n++), mgr = rand() < 0.2;
      const before = await w.trace();
      const qt = await w.quote(who, units, eq, at, { mgr });
      assert.deepEqual(await w.trace(), before, 'a quote writes nothing');
      const real = await w.withdraw(who, units, eq, at, { mgr });
      for (const k of ['unit_price', 'fee_units', 'withdrawal_fee_units', 'net_units', 'pay_usdt']) near(qt[k], Number(real[k]), 0, `step ${i} ${k}`);
      assert.equal(qt.quote, true);
    }
  });
}

test('W2 the quote raises the same refusals as the real call', async () => {
  const w = await world();
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  const eq = await w.total(1.1);
  for (const [units, re] of [[5000, /only holds/], [-1, /units must be > 0/]]) {
    await assert.rejects(() => w.quote('john', units, eq, day(1)), re);
    await assert.rejects(() => w.withdraw('john', units, eq, day(1)), re);
  }
  await assert.rejects(() => w.call('admin_quote_withdraw', 'not-a-token', w.ids.john, 10, eq, 58, true, false, day(1), false));
});

test('W3 full exit with a pool total of more than 6 decimals is refused and saves nothing; at a 6-decimal total the same exit pays exactly the pool', async () => {
  const w = await world({ rate: 0 });                                       // 0%: no fee units go to Fund M, so John holds every unit
  await w.join('john', 1000, '2026-02-20T04:00:00Z');
  const before = await w.trace(), u0 = await w.units('john');
  const eq7 = 1234.5678916;                                                 // 7 decimals: round(1000 x 1.2345678916, 6) = 1234.567892 is MORE than the pool holds
  assert.equal((await w.q('select round($1::numeric, 6) > $1::numeric as over', [eq7]))[0].over, true, 'this total really makes the rounded payout exceed the pool');
  await assert.rejects(() => w.withdraw('john', 1000, eq7, day(1)), /payout exceeds pool equity/);
  assert.deepEqual(await w.trace(), before, 'a refused full exit writes nothing');
  near(await w.units('john'), u0, 0);
  const eq6 = 1234.567891;                                                  // 6 decimals: the payout is exactly the pool, nothing is left over
  const r = await w.withdraw('john', 1000, eq6, day(1));
  near(r.pay_usdt, eq6, 0, 'paid exactly the pool');
  near(await w.units('john'), 0, 0); near(await w.nav(), 0, 0);
});

test('W4 every payout is round(net units x price, 6) to the last digit: partial, zero fee, pending fee, Fund M holding dust', async () => {
  const rand = rng(41);
  for (const rate of [0, 0.2]) {
    const w = await world({ rate });
    await w.join('raf', 0.000002, '2026-02-19T04:00:00Z');                // Fund M holds dust: the cap must not bind for John
    await w.join('john', 1000, '2026-02-20T04:00:00Z'); await w.join('dino', 333.33, '2026-02-21T04:00:00Z');
    await w.settle(1.1, day(0));                                            // under the confirmed rule John's gain is now pending
    for (let i = 0; i < 10; i++) {
      const who = i % 2 ? 'dino' : 'john', held = await w.units(who); if (held < 1e-6) break;
      const units = i >= 8 ? held : Math.round(held * (0.1 + rand() * 0.4) * 1e8) / 1e8;
      const eq = (await w.total((await w.price()) * (0.97 + rand() * 0.1))) + rand() * 1e-7;   // more than 6 decimals on purpose
      const r = await w.withdraw(who, units, eq, day(i + 1));
      near(r.pay_usdt, Math.round(Number(r.net_units) * Number(r.unit_price) * 1e6) / 1e6, 1e-6, `rate ${rate} step ${i}`);
      const exact = (await w.q(`select round($1::numeric * $2::numeric, 6) = $3::numeric ok`, [r.net_units, r.unit_price, r.pay_usdt]))[0].ok;
      assert.equal(exact, true, 'same digits as round(net x price, 6) in the database');
      if (rate === 0) near(r.fee_units, 0, 0);
    }
  }
});

test('W5 a retried withdrawal with the same request id is a replay: one payout, one fee, units taken once', async () => {
  const w = await world();
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  const eq = await w.total(1.3), at = day(1);
  const a = await w.withdraw('john', 400, eq, at, { idem: 'req-1' }), b = await w.withdraw('john', 400, eq, at, { idem: 'req-1' });
  assert.equal(b.replayed, true);
  near(b.pay_usdt, Number(a.pay_usdt), 0);
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind = 'withdrawal'`))[0].n, 1);
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind = 'fee_out'`))[0].n, 1);
  near(await w.units('john'), 600, 1e-9);
});

test('W6 the Money out preview asks the database: no fee is estimated in the browser any more', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.ok(!/function lotFee|lotFee\(/.test(app), 'lotFee is gone');
  assert.match(app, /admin_quote_withdraw/);
});

// Confirmed-gain fee (supabase/migrations/20261127000000_confirmed_gain_fee.sql): a settlement charges only the gain that is still there at
// the NEXT settlement; money that leaves pays at once. Every migration, applied and pending, on an in-memory Postgres (PGlite); every call
// goes in as the public "anon" role. Fee rate 20% throughout, so the hand tables can be checked with a calculator.
//   Part 1  hand-checked cases A-H, the open-trades rule, preview = settlement, undo, and switching back to the immediate rule
//   Part 2  a JS model of the rule (written apart from the SQL) equals the database after every step of random sequences:
//           units, mark H, last settlement value L, the rates, fees, cash paid, price
//   Part 3  an independent specification with no marks at all: fees paid so far = 20% x (highest confirmed gross level − capital)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(Number(a) - b) < eps, `${msg} ${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`;
const NOTE = 'bot has no realized PnL yet; checked against the exchange app by hand';
const R8 = (x) => Math.round(x * 1e8) / 1e8, F8 = (x) => Math.floor(Math.round(x * 1e12) / 1e4) / 1e8, R6 = (x) => Math.round(x * 1e6) / 1e6;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function world({ settings = {}, rate = 0.2 } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(CLOCK_SQL);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', ...settings };
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
  const at = (d) => (d.length > 5 ? d : `2026-${d}T04:00:00Z`);
  const ctx = { db, call, q, A, ids, price, at, pend };
  ctx.units = async (w) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[w]]))[0].u);
  ctx.mark = async (w) => { const r = (await q(`select hwm_value h, last_value l, rate_last r from public.investor_hwm where profile_id=$1`, [ids[w]]))[0];
    return r ? { H: Number(r.h), L: Number(r.l), rL: Number(r.r) } : { H: 0, L: 0, rL: null }; };
  ctx.fees = async (w) => -Number((await q(`select coalesce(sum(usdt),0) s from public.ledger where profile_id=$1 and kind='fee_out'`, [ids[w]]))[0].s);
  ctx.receive = (w, usdt, d) => call('admin_receive_deposit', A, ids[w], usdt, 58, usdt * 58, null, at(d), null, true);
  ctx.total = async (p) => (await nav()) / (await price()) * p + (await pend());
  ctx.reading = async (p, d) => call('admin_post_equity', A, await ctx.total(p), 58, null, at(d));
  ctx.join = async (w, usdt, d, p = null) => { await ctx.receive(w, usdt, d); return (await q(`select 1 from public.pool_equity limit 1`)).length ? ctx.reading(p ?? await price(), d) : call('admin_post_equity', A, usdt, 58, null, at(d)); };
  ctx.settle = async (p, d, { open = 0 } = {}) => {
    const t = await ctx.total(p);
    await call('admin_attest_settlement', A, t, NOTE, at(d), open);
    return call('admin_close_quarter', A, t, 58, null, at(d), null);
  };
  ctx.withdraw = async (w, u, p, d) => call('admin_withdraw', A, ids[w], u, (await ctx.total(p)) - (await pend()), 58, null, true, null, at(d));
  ctx.rate = (w, r) => call('admin_set_profile', A, ids[w], null, null, r);
  return ctx;
}
const feeUsd = (res, p) => Number(res.fee_usdt ?? Number(res.fee_units) * p);

// ---------------------------------------------------------------- Part 1: hand-checked cases (same numbers as the policy tables)
test('A three gaining settlements: each confirmed gain is charged once, one settlement late (20 + 20 on 1.00 -> 1.20)', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  near(feeUsd(await w.settle(1.1, '03-02'), 1.1), 0);                    // 1.00 -> 1.10 not confirmed yet
  assert.deepEqual(await w.mark('john'), { H: 1000, L: 1100, rL: 0.2 });
  near(feeUsd(await w.settle(1.2, '05-02'), 1.2), 20, 1e-6);             // 1.00 -> 1.10 held: 20% of 100
  near(await w.units('john'), 1000 - 20 / 1.2, 1e-7);                    // 16.6667 units redeemed at 1.20 -> 983.3333
  let m = await w.mark('john'); near(m.H, 1080, 1e-6); near(m.L, 1180, 1e-6);
  near(feeUsd(await w.settle(1.3, '07-02'), 1.3), 20, 1e-6);             // 1.10 -> 1.20 held: 20% of the 100 (in post-fee terms 1080 -> 1180)
  m = await w.mark('john'); near(m.H, 1160, 1e-6);
  const line = (await w.q(`select * from public.settlement_lines order by equity_id desc limit 1`))[0];
  assert.equal(line.fee_timing, 'confirmed');
  near(line.confirmed_profit, 100, 1e-6); near(line.last_value_before, 1180, 1e-6);
  near(line.pending_profit, Number(line.value_before) - 1180, 1e-6);     // 1.20 -> 1.30 waits for the next settlement
});

test('B and C a gain that reverses is never charged; half a reversal pays on the half that stayed', async () => {
  const b = await world();
  await b.join('john', 1000, '01-05');
  for (const [p, d] of [[1.1, '03-02'], [1.0, '05-02'], [1.1, '07-02']]) near(feeUsd(await b.settle(p, d), p), 0);
  near(feeUsd(await b.settle(1.1, '09-02'), 1.1), 20, 1e-6);             // 1.10 held through two settlements: charged once
  near((await b.mark('john')).H, 1080, 1e-6);

  const c = await world();
  await c.join('john', 1000, '01-05');
  await c.settle(1.1, '03-02');
  near(feeUsd(await c.settle(1.05, '05-02'), 1.05), 10, 1e-6);           // 20% of the 50 that stayed
  near((await c.mark('john')).H, 1040, 1e-6);
});

test('D a withdrawal while a gain is pending pays on it at once; the rest settles later', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.settle(1.1, '03-02');
  const x = await w.withdraw('john', 500, 1.2, '04-10');
  near(Number(x.fee_units) * 1.2, 20, 1e-6);                              // half of 1.00 -> 1.20 = 100, 20%
  near(x.pay_usdt, 580, 1e-5);
  let m = await w.mark('john'); near(m.H, 500, 1e-9); near(m.L, 550, 1e-9);
  near(feeUsd(await w.settle(1.2, '05-02'), 1.2), 10, 1e-6);             // the remaining half's confirmed 1.00 -> 1.10
  m = await w.mark('john'); near(m.H, 540, 1e-6);
});

test('E a deposit between settlements changes nothing for the gain already made', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.settle(1.1, '03-02');
  await w.join('john', 550, '03-10');                                    // 500 units at 1.10
  let m = await w.mark('john'); near(m.H, 1550, 1e-9); near(m.L, 1650, 1e-9);
  near(feeUsd(await w.settle(1.1, '05-02'), 1.1), 20, 1e-6);
  near((await w.mark('john')).H, 1630, 1e-6);
});

test('F and G 0%: the mark still moves up, so a later raise never reaches back to gains made at 0%', async () => {
  const f = await world({ rate: 0 });
  await f.join('john', 1000, '01-05');
  await f.settle(1.5, '03-02'); await f.settle(1.2, '05-02');
  near((await f.mark('john')).H, 1200, 1e-9);                             // advanced at 0%
  const x = await f.withdraw('john', await f.units('john'), 1.3, '05-10');
  near(x.fee_units, 0); near(x.pay_usdt, 1300, 1e-5);

  const g = await world({ rate: 0 });
  await g.join('john', 1000, '01-05');
  await g.settle(1.1, '03-02');
  await g.rate('john', 0.2);                                              // a raise: starts after the next settlement
  near(feeUsd(await g.settle(1.1, '05-02'), 1.1), 0);                     // the gain made at 0% is confirmed at 0%
  near(feeUsd(await g.settle(1.2, '07-02'), 1.2), 0);                     // nothing confirmed above the mark yet
  near(feeUsd(await g.settle(1.2, '09-02'), 1.2), 20, 1e-6);             // 1.10 -> 1.20, made at 20%, now confirmed
});

test('H repeated partial withdrawals, a deposit, two settlements and a full exit: 40 in total on the 200 gain, nothing twice', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.settle(1.1, '03-02');
  const x1 = await w.withdraw('john', 500, 1.2, '04-10'), x2 = await w.withdraw('john', 250, 1.2, '04-11');
  near(Number(x1.fee_units) * 1.2, 20, 1e-6); near(Number(x2.fee_units) * 1.2, 10, 1e-6);
  await w.join('john', 600, '04-12');
  near(feeUsd(await w.settle(1.2, '05-02'), 1.2), 5, 1e-6);
  near(feeUsd(await w.settle(1.2, '07-02'), 1.2), 5, 1e-6);
  const x3 = await w.withdraw('john', await w.units('john'), 1.2, '07-03');
  near(x3.fee_units, 0, 1e-8);
  near(await w.fees('john'), 40, 1e-4);                                  // withdrawal fees are fee_out rows too
  near(Number(x1.pay_usdt) + Number(x2.pay_usdt) + Number(x3.pay_usdt), 1760, 1e-4);   // paid 1,760 − put in 1,600 = 160 = 200 − 40
});

test('open trades: a warning (not a block) under the confirmed rule; still a block under the immediate rule', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  const r = await w.settle(1.1, '03-02', { open: 3 });
  assert.match(r.warnings[0], /OPEN TRADES: 3/);
  const v = await world({ settings: { fee_timing: 'immediate' } });
  await v.join('john', 1000, '01-05');
  await assert.rejects(() => v.settle(1.1, '03-02', { open: 3 }), /OPEN TRADES/);
});

test('the preview shows exactly what the settlement then does', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05'); await w.join('dino', 500, '01-06');
  await w.settle(1.25, '03-02');
  await w.withdraw('dino', 100, 1.3, '04-01');
  const t = await w.total(1.15);
  await w.call('admin_attest_settlement', w.A, t, NOTE, w.at('05-02'), 0);
  const pv = await w.call('admin_settlement_preview', w.A, t, w.at('05-02'));
  const res = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('05-02'), null);
  near(pv.fee_usdt, res.fee_usdt, 1e-9);
  const lines = await w.q(`select * from public.settlement_lines where equity_id = (select max(equity_id) from public.settlement_lines)`);
  for (const l of pv.lines) {
    const db = lines.find((x) => x.profile_id === l.profile_id);
    near(db.fee_units, l.fee_units, 1e-12); near(db.hwm_after, l.hwm_after_usdt, 1e-9); near(db.confirmed_profit, l.confirmed_profit_usdt, 1e-9);
  }
});

test('undo of a withdrawal or deposit restores the mark, L and the rate exactly', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.settle(1.1, '03-02');
  const before = await w.mark('john');
  await w.withdraw('john', 300, 1.3, '03-10');
  assert.notDeepEqual(await w.mark('john'), before);
  await w.call('admin_undo_last', w.A, 'typo');                         // undo is stamped now(), so it comes last
  assert.deepEqual(await w.mark('john'), before);
});

test('switching fee_timing back to immediate (the rollback) charges everything not yet charged, once', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.settle(1.1, '03-02');                                           // confirmed rule: 0 now, 100 pending
  await w.db.query(`update public.ledger_settings set value = 'immediate' where key = 'fee_timing'`);
  near(feeUsd(await w.settle(1.2, '05-02'), 1.2), 40, 1e-6);             // 1105's rule: 20% of everything above the mark (1.00 -> 1.20)
  near((await w.mark('john')).H, 1160, 1e-6);
  near(feeUsd(await w.settle(1.2, '07-02'), 1.2), 0);                    // and never again
});

// ---------------------------------------------------------------- Part 2: database = model after every step
const INV = ['john', 'dino', 'eve'], SEEN = {};
class Model {                                                              // the policy, written without looking at the SQL
  constructor(rate) { this.P = 1; this.raf = 0; this.a = {}; for (const k of INV) this.a[k] = { u: 0, H: 0, L: 0, rL: null, rate, next: null, fees: 0, paid: 0 }; }
  get U() { return this.raf + INV.reduce((s, k) => s + this.a[k].u, 0); }
  deposit(k, D) {
    if (this.U <= 0) this.P = 1;                                           // an empty pool starts again at 1.00 (ledger rule, not the fee rule)
    const a = this.a[k], fresh = a.u <= 1e-8; a.u = R8(a.u + R8(D / this.P)); a.H += D; a.L += D; if (fresh || a.rL === null) a.rL = a.rate;
  }
  settle(P) {
    this.P = P;
    for (const k of INV) {
      const a = this.a[k]; if (a.u <= 0) continue;
      const E = a.u * P, base = Math.min(E, a.L), fu = F8(Math.min(a.rL, a.rate) * Math.max(0, base - a.H) / P);
      if (base > a.H) a.H = base - fu * P;
      a.L = E - fu * P; a.rL = a.rate; a.u = R8(a.u - fu); this.raf = R8(this.raf + fu); a.fees += fu * P;
    }
    for (const k of INV) { const a = this.a[k]; if (a.next !== null) { a.rate = a.next; a.next = null; } }
  }
  withdraw(k, n) {
    const a = this.a[k], E = a.u * this.P, s = Math.min(1, n / a.u);
    const conf = Math.max(0, Math.min(E, a.L) - a.H), pend = Math.max(0, E - Math.max(a.L, a.H));
    const fu = F8((Math.min(a.rL, a.rate) * conf + a.rate * pend) * Math.min(n, a.u) / (a.u * this.P));
    const H0 = a.H;
    a.H = Math.max(0, a.H - s * Math.min(E, a.H));
    a.L = Math.max(0, E > H0 ? a.L * (1 - s) : a.L - s * Math.min(E, a.L));
    a.u = R8(a.u - n); this.raf = R8(this.raf + fu); a.fees += fu * this.P;
    const pay = R6((n - fu) * this.P); a.paid += pay; return pay;
  }
  setRate(k, r) { const a = this.a[k]; if (r > a.rate && a.u > 0) a.next = r; else { a.rate = r; a.next = null; } }
}

async function compare(w, m, where) {
  for (const k of INV) {
    const a = m.a[k], mk = await w.mark(k), u = await w.units(k);
    near(u, a.u, 1e-6, `${where}: ${k} units`);
    near(mk.H, a.H, 1e-5 + 1e-8 * a.H, `${where}: ${k} mark H`);
    near(mk.L, a.L, 1e-5 + 1e-8 * a.L, `${where}: ${k} last value L`);
    if (a.rL !== null) near(mk.rL, a.rL, 1e-12, `${where}: ${k} rate_last`);
    near(await w.fees(k), a.fees, 1e-5, `${where}: ${k} fees`);
    const pr = (await w.q(`select fee_rate r, fee_rate_next n from public.profiles where id=$1`, [w.ids[k]]))[0];
    near(pr.r, a.rate, 1e-12, `${where}: ${k} rate`); near(pr.n ?? -1, a.next ?? -1, 1e-12, `${where}: ${k} next rate`);
  }
  near(await w.units('raf'), m.raf, 1e-6, `${where}: Fund M units`);
  near(await w.price(), m.P, 1e-9 * Math.max(1, m.P), `${where}: price`);
}

for (const seed of [11, 12, 13, 14, 15, 16]) {
  test(`random sequence seed ${seed}: database = model after every step (units, H, L, rates, fees, cash, price)`, async () => {
    const rand = rng(seed), pick = (a) => a[Math.floor(rand() * a.length)];
    const w = await world({ settings: { settlement_schedule: 'free' } }), m = new Model(0.2);
    let day = Date.UTC(2026, 2, 2, 4), log = [];
    const d = () => { day += 86400000; return new Date(day).toISOString(); };
    await w.join('raf', 300, '2026-02-19T04:00:00Z'); m.raf = 300;          // Fund M's own capital: the pool is never empty
    await w.join('john', 1000, '2026-02-20T04:00:00Z'); m.deposit('john', 1000);
    for (let step = 0; step < 30; step++) {
      const r = rand(), held = INV.filter((k) => m.a[k].u > 1e-4), rafBefore = m.raf;
      const nextP = () => { let f = 0.75 + rand() * 0.55; if (m.P * f < 0.1 || m.P * f > 20) f = 1 / f; return m.P * f; };
      // the valuation price is an input: the model takes the price the database recorded for it (it differs from P in the 9th digit)
      if (r < 0.2) { const k = pick(INV), D = Math.round((50 + rand() * 1500) * 100) / 100; await w.join(k, D, d());
        if (m.U > 0) m.P = await w.price(); m.deposit(k, D); log.push(`join ${k} ${D}`); }
      else if (r < 0.4) { const P = nextP(); await w.reading(P, d()); m.P = await w.price(); log.push(`trade ${P.toFixed(4)}`); }
      else if (r < 0.65) { const P = nextP(); const res = await w.settle(P, d()); const before = m.raf; m.settle(Number(res.unit_price));
        near(res.fee_units, m.raf - before, 1e-7, `seed ${seed} step ${step} settlement fee units`); log.push(`settle ${P.toFixed(4)}`); }
      else if (r < 0.88 && held.length) { const k = pick(held), full = rand() < 0.3, n = full ? m.a[k].u : R8(m.a[k].u * (0.05 + rand() * 0.9));
        const res = await w.withdraw(k, n, m.P, d()); m.P = Number(res.unit_price); const pay = m.withdraw(k, n);
        near(res.pay_usdt, pay, 1e-5, `seed ${seed} step ${step} payout`); log.push(`withdraw ${k} ${full ? 'all' : n}`); }
      else { const k = pick(INV), r2 = pick([0, 0.1, 0.2, 0.3]); await w.rate(k, r2); m.setRate(k, r2); log.push(`rate ${k} ${r2}`); }
      const kind = log.at(-1).split(' ')[0]; SEEN[kind] = (SEEN[kind] || 0) + 1;
      if (kind === 'withdraw' && log.at(-1).endsWith('all')) SEEN['full exit'] = (SEEN['full exit'] || 0) + 1;
      if (kind === 'settle' && m.raf > rafBefore + 1e-9) SEEN['settle with a fee'] = (SEEN['settle with a fee'] || 0) + 1;
      if (kind === 'withdraw' && m.raf > rafBefore + 1e-9) SEEN['withdraw with a fee'] = (SEEN['withdraw with a fee'] || 0) + 1;
      try { await compare(w, m, `seed ${seed} step ${step} (${log.at(-1)})`); } catch (e) { e.message += `\n  sequence: ${log.join(' | ')}`; throw e; }
    }
    const rep = await w.call('admin_integrity_report', w.A);
    const bad = rep.checks.filter((c) => c.count > 0 && !['several_settlements_on_one_day', 'deposit_waiting_over_7_days_not_arrived'].includes(c.id));
    assert.deepEqual(bad.map((c) => c.id), [], 'the integrity report is clean after the whole sequence');
  });
}

test('coverage: the random sequences exercised every kind of step', () => {
  for (const k of ['join', 'trade', 'settle', 'settle with a fee', 'withdraw', 'withdraw with a fee', 'full exit', 'rate']) assert.ok((SEEN[k] || 0) >= 3, `${k} ran ${SEEN[k] || 0} times: ${JSON.stringify(SEEN)}`);
  console.log('steps run:', JSON.stringify(SEEN));
});

// ---------------------------------------------------------------- Part 3: an independent specification (no H, no L)
// One investor, capital 1,000, random settlements, then a full exit. Gross level = value + every fee already paid. A settlement's
// confirmed level is the lower of its gross level and the previous settlement's. After every event:
//     fees paid so far == 20% x max(0, highest confirmed gross level so far − 1,000)          (the exit counts as confirmed)
for (const seed of [21, 22, 23, 24]) {
  test(`specification seed ${seed}: fees = 20% of the highest confirmed gross gain, after every settlement and at the exit`, async () => {
    const rand = rng(seed), w = await world({ settings: { settlement_schedule: 'free' } });
    await w.join('raf', 300, '2026-02-19T04:00:00Z');                       // Fund M's own capital (a sole holder's exit is a separate rounding edge)
    await w.join('john', 1000, '2026-02-20T04:00:00Z');
    let day = Date.UTC(2026, 2, 2, 4), P = 1, peak = 1000, prevG = 1000;
    for (let i = 0; i < 12; i++) {
      P *= 0.8 + rand() * 0.45; day += 86400000 * 3;
      const u0 = await w.units('john'), f0 = await w.fees('john');
      const res = await w.settle(P, new Date(day).toISOString());
      const G = u0 * Number(res.unit_price) + f0;                          // gross level at the price the settlement recorded
      peak = Math.max(peak, Math.min(G, prevG)); prevG = G;
      near(await w.fees('john'), 0.2 * Math.max(0, peak - 1000), 1e-5, `settlement ${i}`);
    }
    P *= 0.8 + rand() * 0.45;
    const u0 = await w.units('john'), f0 = await w.fees('john');
    const x = await w.withdraw('john', u0, P, new Date(day + 86400000).toISOString());
    peak = Math.max(peak, u0 * Number(x.unit_price) + f0);
    near(await w.fees('john'), 0.2 * Math.max(0, peak - 1000), 1e-5, 'exit');
  });
}

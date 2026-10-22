// Return maths (js/returns.js) against the real database functions on an in-memory Postgres, using the same migrations,
// in the same order, as tests/ledger.test.mjs. The point of every test: money added or taken out must never show up as
// a gain or a loss in anyone's %, the manager's own money must earn exactly the fund's trading return, and the profit
// share must show up as the only difference between an investor's % and the manager's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const R = createRequire(import.meta.url)('../js/returns.js');
const MIGRATIONS = ['20261022000000_ledger.sql', '20261023000000_hide_pool_from_investors.sql', '20261024000001_ledger_corrections.sql',
  '20261025000000_profit_share_10.sql', '20261026000000_pending_deposits.sql', '20261027000000_profit_share_hardening.sql',
  '20261028000000_terms_acceptance.sql', '20261029000000_fund_returns.sql'];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions;
    grant usage on schema public to anon, authenticated;`);
  for (const m of MIGRATIONS) await db.exec(readFileSync(new URL('../supabase/migrations/' + m, import.meta.url), 'utf8'));
  await db.exec(`update public.ledger_settings set value = '0' where key = 'min_days_between_closes'`);
  await db.exec(`update public.ledger_settings set value = '0' where key = 'lock_months'`);
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  return db;
}
const call = async (db, fn, ...args) => {
  await db.exec('set role anon');
  try { return (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const token = async (db, u, p) => { const r = await call(db, 'login', u, p); assert.equal(r.ok, true, JSON.stringify(r)); return r.token; };
async function world() {   // manager Raf + investors John and Dino, 20% profit share
  const db = await setup();
  const A = await token(db, 'raf', 'admin-password-1');
  const ids = { raf: (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id };
  for (const [u, n] of [['john', 'John'], ['dino', 'Dino']]) ids[u] = await call(db, 'admin_create_user', A, u, n, u + '-password', 0.2);
  const T = { john: await token(db, 'john', 'john-password'), dino: await token(db, 'dino', 'dino-password') };
  return { db, A, ids, T };
}

// what MEXC shows = the pool (units x price) + money still waiting to join
async function mexcTotal(db, A, priceFactor = 1) {
  const pool = await call(db, 'pool_summary', A);
  const waiting = (await call(db, 'admin_pending', A)).reduce((t, d) => t + Number(d.usdt), 0);
  return Number(pool.total_units) * Number(pool.unit_price) * priceFactor + waiting;
}
const reading = async (db, A, factor) => call(db, 'admin_post_equity', A, await mexcTotal(db, A, factor));   // trading moved the pool by `factor`
const addMoney = async (db, A, who, usdt) => { await call(db, 'admin_receive_deposit', A, who, usdt); await reading(db, A, 1); };   // joins at today's price
const takeMoney = async (db, A, who, units) => call(db, 'admin_withdraw', A, who, units, await mexcTotal(db, A), null, null, true);
const holder = async (db, A, id) => (await call(db, 'admin_overview', A)).find((h) => h.id === id);

// the same numbers the app computes, from what the app receives
async function returnsOf(db, A, id) {
  const hist = (await db.query(`select public._history($1) as r`, [id])).rows[0].r;
  const pts = hist.map((p) => ({ v: Number(p.value), n: Number(p.net_in), u: Number(p.units), price: Number(p.price) }));
  return { hist, trading: R.total(R.tradingGrowth(pts)), yours: R.total(R.yourGrowth(pts)) };
}
const fundRows = (db, tok) => call(db, 'fund_returns', tok);

test('scenario: manager tops up and takes out, investors join, withdraw and pay profit share; every % is what it should be', async () => {
  const { db, A, ids, T } = await world();
  await addMoney(db, A, ids.raf, 1000);                         // fund starts: Raf 1000 at 1.00
  await reading(db, A, 1.10);                                    // trading +10%  -> price 1.10
  await addMoney(db, A, ids.john, 500);                          // John joins at 1.10
  await reading(db, A, 1.05);                                    // +5%           -> 1.155
  await addMoney(db, A, ids.raf, 1000);                          // Raf tops up 1000 at 1.155 (must NOT count as profit)
  let raf = await holder(db, A, ids.raf);
  near(raf.return_pct, (1000 * 1.155 + 1000 - 2000) / 2000);     // the old "gain / put in" % is diluted by the top-up: 7.75%
  near((await returnsOf(db, A, ids.raf)).trading, 0.155);       // the trading % is not: 15.5%
  await reading(db, A, 0.90);                                    // -10%          -> 1.0395
  await addMoney(db, A, ids.dino, 300);                          // Dino joins at 1.0395
  raf = await holder(db, A, ids.raf);
  await takeMoney(db, A, ids.raf, 500 / Number(raf.unit_price)); // Raf takes 500 out (no profit share on the manager's own money)
  await reading(db, A, 1.20);                                    // +20%          -> 1.2474
  const P1 = 1.155 * 0.9 * 1.2;
  near((await call(db, 'pool_summary', A)).unit_price, P1);
  const john0 = await holder(db, A, ids.john);
  await takeMoney(db, A, ids.john, Number(john0.units) / 2);    // John takes half out: profit share on that half
  await reading(db, A, 1.05);                                    // +5%           -> 1.30977
  const P2 = P1 * 1.05;
  await call(db, 'admin_close_quarter', A, await mexcTotal(db, A));   // quarter close: profit share on what John and Dino still hold

  // 1. the fund's trading return = the unit price, start to now
  const rows = await fundRows(db, T.john);
  near(R.total(R.managerGrowth(rows)), P2 - 1);                  // +30.98%: what the manager's own money made
  // 2. Raf: his own trading % equals the fund's, despite +1000 and -500; with the profit share he received it is higher
  const rr = await returnsOf(db, A, ids.raf);
  near(rr.trading, P2 - 1);
  assert.ok(rr.yours > rr.trading + 1e-6, `manager with profit share ${rr.yours} should beat trading ${rr.trading}`);
  // 3. John: trading % since he joined at 1.10; after profit share = trading x (what the two charges left him), worked out by hand
  const jr = await returnsOf(db, A, ids.john);
  near(jr.trading, P2 / 1.10 - 1);
  const keep1 = 1 - 0.2 * (P1 - 1.10) / P1 * 0.5;               // half his units were charged at the withdrawal
  const keep2 = 1 - 0.2 * (P2 - 1.10) / P2;                       // the rest at the close (its line was still 1.10)
  near(jr.yours, (P2 / 1.10) * keep1 * keep2 - 1);
  // 4. Dino: joined at 1.0395, so +26% trading (1.20 x 1.05); after profit share lower by exactly the close
  const dr = await returnsOf(db, A, ids.dino);
  near(dr.trading, 1.2 * 1.05 - 1);
  near(dr.yours, 1.26 * (1 - 0.2 * (P2 - 1.155 * 0.9) / P2) - 1);
  // 5. the manager's money over John's own time in the fund made exactly John's trading return
  const jStart = rows.findIndex((r) => r.id === jr.hist[0].id), g = R.managerGrowth(rows);
  near(R.between(g, jStart, g.length - 1), jr.trading);
  // 6. the books still add up: everyone's value = the fund, shares = 100%
  const all = await call(db, 'admin_overview', A), pool = await call(db, 'pool_summary', A);
  near(all.reduce((t, h) => t + Number(h.value_usdt), 0), Number(pool.equity_usdt), 1e-4);
  near(all.reduce((t, h) => t + Number(h.share_pct || 0), 0), 1, 1e-9);
});

test('twin worlds: the same trading, with and without the manager adding and taking out money: every % is identical', async () => {
  const run = async (managerMoves) => {
    const { db, A, ids } = await world();
    await addMoney(db, A, ids.raf, 1000); await addMoney(db, A, ids.john, 400);
    await reading(db, A, 1.08);
    if (managerMoves) await addMoney(db, A, ids.raf, 5000);       // a big top-up at a high
    await reading(db, A, 0.93);
    await addMoney(db, A, ids.dino, 250);
    if (managerMoves) { const h = await holder(db, A, ids.raf); await takeMoney(db, A, ids.raf, Number(h.units) * 0.6); }
    await reading(db, A, 1.15);
    await call(db, 'admin_close_quarter', A, await mexcTotal(db, A));
    await reading(db, A, 0.97);
    if (managerMoves) await addMoney(db, A, ids.raf, 777);
    await reading(db, A, 1.04);
    const out = {};
    for (const k of ['raf', 'john', 'dino']) { const r = await returnsOf(db, A, ids[k]); out[k] = [r.trading, r.yours]; }
    return out;
  };
  const quiet = await run(false), busy = await run(true);
  for (const k of ['raf', 'john', 'dino']) near(busy[k][0], quiet[k][0]);   // trading %: identical for everyone
  for (const k of ['john', 'dino']) near(busy[k][1], quiet[k][1]);         // investors' % after profit share: identical too
  near(quiet.raf[0], 1.08 * 0.93 * 1.15 * 0.97 * 1.04 - 1);         // and the manager's trading % is just the price path
  // The manager's % WITH the profit share received is the one figure that rightly differs: the same fee income is a
  // smaller % of a bigger balance. That is why the app shows the manager's trading % separately.
  assert.ok(busy.raf[1] < quiet.raf[1] && busy.raf[1] > busy.raf[0]);
});

test('investors can see the trading returns but nothing about the pool size; a token is required', async () => {
  const { db, A, ids, T } = await world();
  await addMoney(db, A, ids.raf, 1000); await addMoney(db, A, ids.john, 300); await reading(db, A, 1.1);
  const rows = await fundRows(db, T.john);
  assert.ok(rows.length >= 3);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['id', 'mgr', 'price', 'ts']);
  await assert.rejects(() => fundRows(db, 'not-a-token'), /sign/i);
  const mine = await call(db, 'my_history', T.john);
  assert.ok(mine.every((p) => rows.some((r) => r.id === p.id)));      // every point of a person lines up with a fund row
});

test('stress: 120 random actions; trading % = price since joining for everyone, never moved by money in or out', async () => {
  const { db, A, ids } = await world();
  const people = [ids.raf, ids.john, ids.dino];
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const p of people) await addMoney(db, A, p, 100 + Math.round(rnd() * 900));
  for (let i = 0; i < 120; i++) {
    const who = people[Math.floor(rnd() * 3)], x = rnd();
    if (x < 0.3) await addMoney(db, A, who, 10 + Math.round(rnd() * 500));
    else if (x < 0.6) await reading(db, A, 0.85 + rnd() * 0.35);
    else if (x < 0.85) { const h = await holder(db, A, who); await takeMoney(db, A, who, Number(h.units) * rnd() * 0.7); }   // never everything
    else await call(db, 'admin_close_quarter', A, await mexcTotal(db, A, 0.95 + rnd() * 0.15));
  }
  const price = Number((await call(db, 'pool_summary', A)).unit_price);
  for (const p of people) {
    const { hist, trading, yours } = await returnsOf(db, A, p);
    near(trading, price / Number(hist[0].price) - 1);                  // held all along, so trading % = price now / price at joining
    if (p === ids.raf) assert.ok(yours >= trading - 1e-9);              // the manager only ever receives profit share
    else assert.ok(yours <= trading + 1e-9);                            // investors only ever pay it
  }
});

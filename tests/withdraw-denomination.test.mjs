// Withdrawals are in USDT (or units), never pesos, and no peso rate (the live PHP/USD reference rate or any stored one) changes an amount:
// the investor request form (js/app.js reqForm, Contribution.withdrawUnits), the manager's Money out form, and the database's own figures.
// Also: the peso rate passed with a pool reading, a deposit or a settlement changes no units, price, pool value, ownership or fee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { world, near } from './_tvworld.mjs';
const C = createRequire(import.meta.url)('../js/contribution.js');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const RATES = [null, 40, 63.11, 75.27191529, 150];

test('WD1 withdrawUnits: USDT / unit price, "everything" within a cent, invalid input refused; no rate goes in', () => {
  assert.equal(C.withdrawUnits.length, 3, 'amount, unit price, unlocked units: no rate parameter');
  near(C.withdrawUnits(100, 0.8779497383813229, 1000), 100 / 0.8779497383813229, 1e-12);
  // James today: 73.31635568 units at 0.87794974: everything = 64.367..., the Max button fills 64.36 (rounded down to the cent)
  assert.equal(C.withdrawUnits(64.36, 0.8779497383813229, 73.31635568), 73.31635568);
  assert.ok(C.withdrawUnits(64.0, 0.8779497383813229, 73.31635568) < 73.31635568);
  near(C.withdrawUnits(200, 1, 100), 200, 1e-12, 'more than unlocked stays as asked: the database refuses it');
  for (const bad of [0, -5, null, '', 'abc', NaN]) assert.equal(C.withdrawUnits(bad, 0.9, 10), null, String(bad));
  assert.equal(C.withdrawUnits(10, 0, 10), null); assert.equal(C.withdrawUnits(10, null, 10), null);
  near(C.withdrawUnits('25.5', '0.85', '100'), 30, 1e-12);
});

test('WD2 the investor request is typed in USDT and sent as units; pesos are only a labelled estimate; the manager form has no peso amount', () => {
  assert.match(app, /<label for="rq-u">Amount to withdraw \(USDT\)<\/label>/);
  assert.ok(!/inPeso\(\) \? rate\(\)/.test(app), 'no amount is divided or multiplied by the rate depending on the view');
  assert.match(app, /const units = Contribution\.withdrawUnits\(num\(fv\(fm, 'amount'\)\), S\.me\.unit_price, S\.me\.unlocked_units\);\r?\n\s+if \(units == null\) throw new Error\('Enter the amount to withdraw in USDT\.'\);\r?\n\s+const r = await call\('request_withdrawal', \{ p_units: units, p_note: null \}\);/);
  const req = app.slice(app.indexOf("} else if (id === 'reqForm') {"), app.indexOf("} else if (id === 'wfBal') {"));
  assert.ok(req.length > 0 && !/rate\(\)|minPhp\(\)/.test(req), 'the request submit uses no peso rate and no peso pre-check (the database checks the minimum)');
  assert.match(app, /≈ \$\{php\(a \* rate\(\)\)\} at today's PHP\/USD reference rate: an estimate only\./);
  assert.match(app, /'Peso estimate: rate unavailable\.'/);
  assert.match(app, /\$\{f\(units, 4\)\} of your units at today's unit price/);
  assert.match(app, /else if \(a === 'maxunits'\) \{ const v = Number\(S\.me\.units\) \* Number\(S\.me\.unit_price\); \$f\('rq-u'\)\.value = Math\.floor\(v \* 100\) \/ 100;/);
  const wd = app.slice(app.indexOf('<form id="wdForm">'), app.indexOf('<div class="preview" id="wdPrev">'));
  assert.ok(wd.includes('<label>Amount (USDT)</label>') && !wd.includes('name="ccy"') && !wd.includes('Pesos'), 'Money out: USDT amount only');
  assert.match(app, /fm\.elements\.units\.value = Math\.round\(\(num\(fv\(fm, 'amt'\)\) \/ price\) \* 1e8\) \/ 1e8;/);
  assert.match(app, /at today's rate, an estimate\)/);
  assert.ok(!/fm\.elements\.rate\.value = (e|wd|dep)\.php_rate/.test(app), 'an Edit refill never copies an old entry\'s rate into the form');
});

// a pool where raf (1000) and john (500) joined at 1.00 and the pool then made 10%; fee 20%
async function pool(rate) {
  const w = await world();
  await w.join('raf', 1000); await w.join('john', 500);
  await w.call('admin_post_equity', w.A, 1650, rate, 'gain', w.d());
  return w;
}

test('WD3 the database quote and the real payout do not depend on the peso rate passed with them', async () => {
  const quotes = [], paid = [];
  const w = await pool(58);
  for (const r of RATES) quotes.push(await w.call('admin_quote_withdraw', w.A, w.ids.john, 200, 1650, r, true, false, null, true));
  for (const q of quotes.slice(1)) for (const k of ['unit_price', 'fee_units', 'net_units', 'pay_usdt']) near(q[k], Number(quotes[0][k]), 1e-12, k);
  assert.ok(Number(quotes[0].pay_usdt) > 0 && Number(quotes[0].fee_units) > 0, 'a real fee and payout were quoted');
  for (const r of [40, 75.27191529]) {
    const x = await pool(58);
    const res = await x.call('admin_withdraw', x.A, x.ids.john, 200, 1650, r, 'out', true, null, x.d(), null, true);
    paid.push({ pay: Number(res.pay_usdt), john: await x.units('john'), raf: await x.units('raf'), p: await x.pool(),
      fee: Number((await x.q(`select coalesce(sum(units),0) u from public.ledger where kind = 'fee_in'`))[0].u) });
  }
  near(paid[0].pay, paid[1].pay, 1e-12); near(paid[0].john, paid[1].john, 1e-12); near(paid[0].raf, paid[1].raf, 1e-12); near(paid[0].fee, paid[1].fee, 1e-12);
  near(paid[0].p.e, paid[1].p.e, 1e-9); near(paid[0].p.u, paid[1].p.u, 1e-12); near(paid[0].p.p, paid[1].p.p, 1e-15);
  near(paid[0].pay, Number(quotes[0].pay_usdt), 1e-9, 'the payout is what the quote said');
});

test('WD4 an investor request stores exactly the units asked for; the peso rate cannot reach it', async () => {
  const w = await pool(58);
  const J = (await w.call('login', 'john', 'john-password')).token;
  await w.call('set_my_payout', J, 'gcash', 'John', '09170000000', null, null);
  const price = (await w.pool()).p;
  const asked = C.withdrawUnits(110, price, 500);   // what the form sends for 110 USDT (WD1: the function takes no rate at all)
  await w.call('request_withdrawal', J, asked, null);
  const rq = (await w.call('my_requests', J))[0];
  near(rq.units, asked, 1e-8); near(Number(rq.units) * price, 110, 1e-6);
});

test('WD5 the peso rate with a pool reading, a deposit or a settlement changes no units, price, pool value, ownership or fee', async () => {
  const out = [];
  for (const r of RATES) {
    const w = await pool(r);
    await w.mode('settlement_recon', 'off'); await w.mode('fee_timing', 'immediate');   // as live: the profit share is charged at the close
    await w.call('admin_receive_deposit', w.A, w.ids.dino, 100, r, r == null ? null : 100 * r, null, w.d(), null, true);
    await w.call('admin_post_equity', w.A, 1750, r, 'dino joins', w.d());
    let settled = null;
    try { settled = await w.call('admin_close_quarter', w.A, 1800, r, 'close', w.d()); } catch (e) { settled = { error: e.message }; }
    const units = {}; for (const who of ['raf', 'john', 'dino']) units[who] = await w.units(who);
    const tot = units.raf + units.john + units.dino;
    out.push({ p: await w.pool(), units, share: { john: units.john / tot, dino: units.dino / tot }, settled: settled && settled.error ? 'refused: ' + settled.error : 'done',
      fee: Number((await w.q(`select coalesce(sum(units),0) u from public.ledger where kind = 'fee_in'`))[0].u) });
  }
  assert.equal(out[0].settled, 'done'); assert.ok(out[0].fee > 0, 'a real profit share was charged at the close');
  for (const x of out.slice(1)) {
    assert.equal(x.settled, out[0].settled);
    near(x.p.e, out[0].p.e, 1e-9); near(x.p.u, out[0].p.u, 1e-12); near(x.p.p, out[0].p.p, 1e-15); near(x.fee, out[0].fee, 1e-12);
    for (const who of ['raf', 'john', 'dino']) near(x.units[who], out[0].units[who], 1e-12, who);
    near(x.share.john, out[0].share.john, 1e-15); near(x.share.dino, out[0].share.dino, 1e-15);
  }
});

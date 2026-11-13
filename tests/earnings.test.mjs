// js/earnings.js: what the fund manager earned from each investor, and where the app shows it.
//   EA1 sums the fee rows per investor (USDT and units, how many, last date), ignores other kinds, other people and the manager; accrued fee never negative
//   EA2 the card and the sheet lines word the figures, escape names, and the app only builds them for the manager
//   EA3 on the real migrations: a settlement's fee, the total on the card and the units the manager received are the same number
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { world, adv, near } from './_tvworld.mjs';

const E = createRequire(import.meta.url)('../js/earnings.js');
const APP = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const fmt = (v) => Number(v).toFixed(2) + ' USDT', day = (t) => String(t).slice(0, 10);

test('EA1 per-investor totals come only from fee_out rows of that investor', () => {
  const holders = [{ id: 'm', role: 'admin', name: 'Manager' }, { id: 'a', role: 'investor', name: 'Ann', fee_rate: 0.2, accrued_fee_usdt: 3 }, { id: 'b', role: 'investor', username: 'bob', fee_rate: 0.1, accrued_fee_usdt: -1 }];
  const ledger = [
    { profile_id: 'a', kind: 'fee_out', usdt: -10, units: -9.5, ts: '2027-01-01T00:00:00Z' }, { profile_id: 'a', kind: 'fee_out', usdt: -2.5, units: -2.4, ts: '2027-03-01T00:00:00Z' },
    { profile_id: 'a', kind: 'deposit', usdt: 500, units: 480 }, { profile_id: 'm', kind: 'fee_in', usdt: 12.5, units: 11.9 }, { profile_id: 'b', kind: 'withdrawal', usdt: -5, units: -5 }];
  const e = E.byInvestor(ledger, holders);
  assert.equal(e.rows.length, 2, 'the manager has no row');
  const a = e.rows.find((r) => r.id === 'a'), b = e.rows.find((r) => r.id === 'b');
  near(a.fee_usdt, 12.5, 1e-12); near(a.fee_units, 11.9, 1e-12); assert.equal(a.count, 2); assert.equal(a.last, '2027-03-01T00:00:00Z'); near(a.accrued_usdt, 3, 1e-12);
  assert.equal(b.fee_usdt, 0); assert.equal(b.count, 0); assert.equal(b.accrued_usdt, 0, 'never negative'); assert.equal(b.name, 'bob');
  near(e.total_usdt, 12.5, 1e-12); near(e.total_accrued, 3, 1e-12);
  assert.deepEqual(E.byInvestor(null, null).rows, []);
});

test('EA2 wording, escaping, and manager-only wiring', () => {
  const e = E.byInvestor([{ profile_id: 'a', kind: 'fee_out', usdt: -10, units: -9, ts: '2027-01-01T00:00:00Z' }], [{ id: 'a', role: 'investor', name: 'A <b>', fee_rate: 0.2, accrued_fee_usdt: 4 }, { id: 'c', role: 'investor', name: 'Cy', fee_rate: 0.2 }]);
  const c = E.card(e, fmt, day);
  assert.ok(c.includes('Earned from investors') && c.includes('10.00 USDT') && c.includes('+ 4.00 USDT building up') && c.includes('1 fee taken, last 2027-01-01') && c.includes('no fee taken yet'));
  assert.ok(c.includes('A &lt;b&gt;') && !c.includes('A <b>'));
  assert.ok(E.card(E.byInvestor([], []), fmt, day).includes('No investors yet'));
  assert.ok(E.lines(e.rows[0], fmt).includes('Fees you earned from them') && E.lines(undefined, fmt) === '');
  assert.match(APP, /isAdmin\(\) \? Earnings\.card\(/, 'the Users card is built for the manager only');
  assert.match(APP, /inv && isAdmin\(\) \? Earnings\.lines\(/, 'the person sheet lines too');
  assert.match(readFileSync(new URL('../login.html', import.meta.url), 'utf8'), /js\/earnings\.js/);
});

test('EA3 real settlement: the card total equals the fee the settlement charged and the units the manager received', async () => {
  const w = await world({ exclude: ['admission_spread'] });
  await w.clock(Date.UTC(2026, 9, 20, 4));
  await w.join('raf', 1000); await adv(w, 5);
  for (const [k, v] of Object.entries({ flow_pricing: 'true_value', settlement_schedule: 'bimonthly', fee_timing: 'immediate' })) await w.db.query(`insert into public.ledger_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v]);
  const pid = await w.receive('john', 500); await w.report(1500, 0);
  await w.call('admin_admit_deposit_tv', w.A, pid, null);
  await adv(w, 20); await w.trade({ pos: 'e1', pnl: 150 }); await adv(w, 5); await w.report(1650, 0);
  await w.clock(Date.UTC(2026, 9, 31, 16) + 5 * 60000); await w.report(1650, 0);          // the automatic settlement runs
  const led = await w.call('admin_ledger', w.A), all = await w.call('admin_overview', w.A);
  const e = E.byInvestor(led, all), john = e.rows.find((r) => r.id === w.ids.john);
  const s = (await w.q(`select fee_usdt::float f, fee_units::float u from public.settlements`))[0];
  near(john.fee_usdt, s.f, 1e-5, 'USDT'); near(john.fee_units, s.u, 1e-8, 'units'); near(e.total_usdt, 10, 1e-5);
  near(Number((await w.q(`select coalesce(sum(units), 0) n from public.ledger where kind = 'fee_in' and profile_id = $1`, [w.ids.raf]))[0].n), e.total_units, 1e-8, 'the manager received exactly those units');
  assert.equal(john.count, 1); near(john.accrued_usdt, 0, 1e-6, 'right after a settlement nothing is building up');
});

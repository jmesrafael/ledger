// The investor's calendar (js/returns.js daily, js/app.js calendarCard): each Philippine day's gain or loss on the balance from the trading only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../js/returns.js');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('CAL1 James: the Nov 7 reading is −2.03 USDT (−3.06%); the peso top-up the same day is money in, never a result', () => {
  const H = [{ ts: '2026-11-07T03:31:06Z', units: 73.31635568, price: 0.905664218917359 }, { ts: '2026-11-07T10:21:10Z', units: 73.31635568, price: 0.8779497383813229 },
    { ts: '2026-11-07T16:15:05Z', units: 87.39141012, price: 0.8779497383813229 }];
  const d = R.daily(H);
  assert.deepEqual(Object.keys(d), ['2026-11-07']);
  near(d['2026-11-07'].pnl, 73.31635568 * (0.8779497383813229 - 0.905664218917359)); near(d['2026-11-07'].pct, 0.8779497383813229 / 0.905664218917359 - 1);
});

test('CAL2 days are Philippine days; several readings in a day add up; a deposit never shows as a gain; a day with no price move has no entry', () => {
  const H = [{ ts: '2026-11-09T15:00:00Z', units: 100, price: 1 },          // Nov 9, 23:00 PH
    { ts: '2026-11-09T17:00:00Z', units: 100, price: 1.01 },                  // Nov 10, 01:00 PH: +1
    { ts: '2026-11-10T03:00:00Z', units: 200, price: 1.01 },                  // a deposit doubles the units: no result
    { ts: '2026-11-10T05:00:00Z', units: 200, price: 1.00 },                  // −2 (200 units × −0.01)
    { ts: '2026-11-11T05:00:00Z', units: 200, price: 1.02 }];                 // Nov 11: +4
  const d = R.daily(H);
  assert.deepEqual(Object.keys(d), ['2026-11-10', '2026-11-11']);
  near(d['2026-11-10'].pnl, 1 - 2); near(d['2026-11-10'].pct, 0); near(d['2026-11-11'].pnl, 4); near(d['2026-11-11'].pct, 0.02);
  assert.deepEqual(R.daily([]), {}); assert.deepEqual(R.daily(null), {});
});

test('CAL3 the calendar is its own investor page (not on the home), with month navigation that cannot go before the first deposit or past this month', () => {
  assert.match(app, /investor: \[\['home', 'Home'\], \['calendar', 'Calendar'\]/);
  assert.match(app, /const viewCalendar = \(\) => `<div class="sechead"><h2>Calendar<\/h2><\/div>\$\{calendarCard\(\)\}`;/);
  assert.ok(!/\$\{glanceCard\(m\)\}\$\{calendarCard\(\)\}/.test(app), 'the home stays simple');
  assert.match(app, /const D = Returns\.daily\(S\.history\)/);
  assert.match(app, /else if \(a === 'calmonth'\) \{ S\.calM = \(S\.calM \|\| 0\) \+ Number\(id\); render\(\); \}/);
  assert.match(app, /const off = Math\.min\(0, Math\.max\(firstM, S\.calM \|\| 0\)\)/);
  assert.match(app, /Money you put in or take out is not counted\./);
});

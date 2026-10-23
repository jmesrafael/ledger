// The investor page only formats what the database sends: estimate vs final, flows kept apart, no recalculation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const Position = createRequire(import.meta.url)('../js/position.js');
const f = { money: (v) => '$' + v, day: (d) => 'D' + d };
// deliberately inconsistent numbers: a page that recomputed anything would not echo them back
const pos = (over = {}) => ({ estimate: { value_after_fee_usdt: 111.11, accrued_fee_usdt: 7.77, reliable: true, includes_open_trades: false, last_verified: { as_of: 1, value_after_fee_usdt: 99.9 }, reason: 'because' },
  capital: { contributed_usdt: 1, withdrawn_usdt: 2, trading_result_before_fees_usdt: 3, fees_paid_usdt: 4, fees_accrued_usdt: 5, net_performance_usdt: 6 },
  settlements: [{ ts: 9, kind: 'quarter_close', fee_usdt: 8.88 }], deposits: [], withdrawals: [], ...over });
test('reliable estimate is labelled an estimate and echoes the database value', () => {
  const h = Position.render(pos(), f);
  assert.match(h, /Estimate/); assert.match(h, /\$111\.11/); assert.match(h, /not a payout promise/);
});
test('unreliable estimate hides the primary value and shows the last verified one', () => {
  const h = Position.render(pos({ estimate: { ...pos().estimate, reliable: false } }), f);
  assert.match(h, /Waiting for verification/); assert.ok(!/data-k="estimate"/.test(h)); assert.match(h, /\$99\.9/);
});
test('contributions, withdrawals, performance and final records are separate lines with the given numbers', () => {
  const h = Position.render(pos(), f);
  for (const [k, v] of [['contributed', 1], ['withdrawn', 2], ['gross', 3], ['feespaid', 4], ['feesaccrued', 5], ['net', 6], ['settlement', 8.88]]) assert.ok(h.includes('data-k="' + k + '">$' + v + '<'), k);
  assert.match(h, /Final/);
});
test('request states and reasons are shown; paid only when completed', () => {
  const h = Position.render(pos({ withdrawals: [{ state: 'queued', units: 1, requested_at: 1, reason: 'Waiting for the open trades to close', delayed: true }] }), f);
  assert.match(h, /Waiting/); assert.match(h, /open trades to close/); assert.match(h, /later than planned/); assert.ok(!/>Paid</.test(h));
});
test('position.js does arithmetic on no accounting values', () => {
  const src = readFileSync(new URL('../js/position.js', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/[a-z_]+_usdt\s*[-+*\/]|[-+*\/]\s*[a-z]+\.[a-z_]*usdt/.test(src));
});

// The dashboard's Trades table shows the P&L MEXC booked (ledger closed_trades) for live exits that carry no dollar figure: matched by coin and close time, each booked trade used once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { aggregate } = createRequire(import.meta.url)('../lib/aggregate.js');

const T = 1.8e12;
const pair = (id, t, ex, symbol = 'SOL_USDT', extra = {}) => [
  { event_id: 'e' + id, type: 'entry', ts_ms: t, mode: 'live', symbol, side: 'LONG', data: { trade_id: id, entry: 100, sl: 95, tp: null, risk_pct: 0.02 } },
  { event_id: 'x' + id, type: 'exit', ts_ms: ex, mode: 'live', symbol, side: 'LONG', data: { trade_id: id, exit: 96, reason: 'stop', r: -1, hold_sec: 3600, ...extra } }];

test('booked P&L fills live exits by coin and time, each booked trade once', () => {
  const events = [...pair('a', T, T + 3.6e6), ...pair('b', T + 1e7, T + 1.36e7), ...pair('c', T + 2e7, T + 2.36e7, 'ZEC_USDT')];
  const closedTrades = [{ symbol: 'SOL_USDT', closed_ms: T + 3.6e6 + 60000, usd: -4.123 }, { symbol: 'SOL_USDT', closed_ms: T + 1.36e7, usd: -3.5 }, { symbol: 'ADA_USDT', closed_ms: T + 2.36e7, usd: 50 }];
  const d = aggregate({ events, closedTrades, now: T + 3e7, mode: 'live' });
  assert.deepEqual(d.trades.map((t) => t.usd), [-4.12, -3.5, null], 'the unmatched trade stays without a dollar figure; another coin is never used');
  const once = aggregate({ events: pair('a', T, T + 3.6e6).concat(pair('b', T + 1e6, T + 3.7e6)), closedTrades: [closedTrades[0]], now: T + 3e7, mode: 'live' });
  assert.equal(once.trades.filter((t) => t.usd != null).length, 1, 'one booked trade can fill only one exit');
});

test('a dollar figure the bot already shared is never overwritten, and paper trades are never filled', () => {
  const live = pair('a', T, T + 3.6e6, 'SOL_USDT', { usd: -9.99 });
  const d = aggregate({ events: live, closedTrades: [{ symbol: 'SOL_USDT', closed_ms: T + 3.6e6, usd: -4 }], now: T + 3e7, mode: 'live' });
  assert.equal(d.trades[0].usd, -9.99);
  const paper = pair('p', T, T + 3.6e6).map((e) => ({ ...e, mode: 'paper' }));
  assert.equal(aggregate({ events: paper, closedTrades: [{ symbol: 'SOL_USDT', closed_ms: T + 3.6e6, usd: -4 }], now: T + 3e7, mode: 'paper' }).trades[0].usd, null);
});

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

test('a stop MEXC filled inside the candle is matched although the bot books the exit at the candle close, hours later', () => {
  // real case, Oct 29 2026: ADA SHORT stop filled on MEXC 14:36 UTC, the bot booked the exit at the 16:00 close; before the fix every such stop got another trade's figure
  const short = (id, t, ex, symbol) => pair(id, t, ex, symbol).map((e) => ({ ...e, side: 'SHORT' }));
  const events = [...short('ada', T, T + 12 * 3.6e6, 'ADA_USDT'), ...short('near', T, T + 12 * 3.6e6, 'NEAR_USDT')];
  const closedTrades = [
    { wallet: 'bbcore', symbol: 'ADA_USDT', side: 'SHORT', closed_ms: T + 12 * 3.6e6 - 84 * 60000, usd: -5.3419 },
    { wallet: 'bbcore', symbol: 'NEAR_USDT', side: 'SHORT', closed_ms: T + 12 * 3.6e6 - 51 * 60000, usd: -5.122 },
    { wallet: 'bbcore', symbol: 'ADA_USDT', side: 'SHORT', closed_ms: T - 3.6e6, usd: -99 },   // closed before this trade was opened: never used
  ];
  const d = aggregate({ events, closedTrades, now: T + 3e7, mode: 'live' });
  assert.deepEqual(d.trades.map((t) => [t.symbol, t.usd]), [['ADA_USDT', -5.34], ['NEAR_USDT', -5.12]]);
});

test('booked P&L of one bot account is never shown on the other bot, and the side must agree', () => {
  const events = pair('a', T, T + 3.6e6);
  const icoreOnly = [{ wallet: 'icore', symbol: 'SOL_USDT', side: 'LONG', closed_ms: T + 3.6e6, usd: -1.11 }];
  assert.equal(aggregate({ events, closedTrades: icoreOnly, now: T + 3e7, mode: 'live' }).trades[0].usd, null, 'BB-Core does not take I-Core\'s booked trade');
  const wrongSide = [{ wallet: 'bbcore', symbol: 'SOL_USDT', side: 'SHORT', closed_ms: T + 3.6e6, usd: -2 }];
  assert.equal(aggregate({ events, closedTrades: wrongSide, now: T + 3e7, mode: 'live' }).trades[0].usd, null, 'a SHORT booked close does not fill a LONG trade');
});

// The T-CORE LIVE bot (bot "tcore"): real orders on its own MEXC account (ledger wallet tcore). It runs the same strategy as the T-CORE paper lab (bbtr),
// so the two must never mix: the live bot is a live bot next to BB-Core and I-Core (its booked MEXC P&L, its capital in the total), the lab stays a lab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregate } = require('../lib/aggregate.js');
const schema = require('../lib/schema.js');

const ts = 1793000000000, H = 3600e3;
const ev = (bot, type, id, at, mode, data, extra = {}) => ({ event_id: `${bot === 'icore' ? 'ic' : bot}|${id}`, type, ts_ms: at, mode, ...extra, data: { bot, ...data } });
const trade = (bot, mode, id, symbol, side, t0, t1, r, more = {}) => [
  ev(bot, 'entry', id + '-e', t0, mode, { trade_id: id, entry: 100, sl: 95, risk_pct: 0.025 }, { symbol, side }),
  ev(bot, 'exit', id + '-x', t1, mode, { trade_id: id, reason: 'stop', exit: 95, r, hold_sec: (t1 - t0) / 1000, ...more }, { symbol, side })];
const hb = (bot, at, mode, data = {}) => ev(bot, 'heartbeat', `hb:${at}`, at, mode, { drawdown_r: 0, halt_r: -45, ...data });

test('a tcore event needs the tcore| id and the tcore tag; the paper lab prefix is not accepted for it', () => {
  assert.equal(schema.validateEvent({ event_id: 'tcore|hb:live:1', type: 'heartbeat', ts_ms: ts, mode: 'live', bot: 'tcore', data: {} }).ok, true);
  assert.equal(schema.validateEvent({ event_id: 'bbtr|hb:live:1', type: 'heartbeat', ts_ms: ts, mode: 'live', bot: 'tcore', data: {} }).ok, false);
  assert.equal(schema.validateEvent({ event_id: 'tcore|hb:live:1', type: 'heartbeat', ts_ms: ts, mode: 'live', bot: 'bbtr', data: {} }).ok, false);
  assert.equal(schema.validateEvent({ event_id: 'tcore|hb:live:1', type: 'heartbeat', ts_ms: ts, mode: 'live', data: {} }).ok, false);
});

test('live T-CORE is its own bot: MEXC booked P&L from its own wallet, in the total capital, never mixed with the lab or BB-Core', () => {
  const events = [
    ...trade(null, 'live', 'bb1', 'SOL_USDT', 'SHORT', ts, ts + 8 * H, -1),            // BB-Core (untagged rows are BB-Core's)
    ...trade('icore', 'live', 'ic1', 'ADA_USDT', 'SHORT', ts, ts + 8 * H, -1),
    ...trade('tcore', 'live', 'tc1', 'SOL_USDT', 'SHORT', ts, ts + 12 * H, -1.05),        // stop filled on MEXC 2h before the bot booked it
    ...trade('bbtr', 'paper', 'lab1', 'SOL_USDT', 'SHORT', ts, ts + 12 * H, -1.02),
    hb(null, ts + 13 * H, 'live'), hb('icore', ts + 13 * H, 'live'), hb('tcore', ts + 13 * H, 'live'), hb('bbtr', ts + 13 * H, 'paper'),
  ];
  const closedTrades = [
    { wallet: 'bbcore', symbol: 'SOL_USDT', side: 'SHORT', closed_ms: ts + 6 * H, usd: -4.9 },
    { wallet: 'icore', symbol: 'ADA_USDT', side: 'SHORT', closed_ms: ts + 7 * H, usd: -1.1 },
    { wallet: 'tcore', symbol: 'SOL_USDT', side: 'SHORT', closed_ms: ts + 10 * H, usd: -1.04 },
  ];
  const d = aggregate({ events, closedTrades, now: ts + 13.5 * H, mode: 'live' });
  assert.ok(d.bots && d.bots.tcore, 'the live bot has its own view');
  assert.equal(d.bots.tcore.mode, 'live');
  assert.deepEqual(d.bots.tcore.trades.map((t) => [t.symbol, t.r, t.usd]), [['SOL_USDT', -1.05, -1.04]], 'its own trade, with the dollars MEXC booked on ITS wallet');
  assert.deepEqual(d.trades.map((t) => t.usd), [-4.9], 'BB-Core keeps its own booked trade (same coin and side, other wallet)');
  assert.deepEqual(d.bots.icore.trades.map((t) => t.usd), [-1.1]);
  assert.equal(d.labs.bbtr.trades.length, 1); assert.equal(d.labs.bbtr.trades[0].usd, null, 'the paper lab never takes booked money');
  assert.equal(d.perf.tcore.bot === undefined || d.perf.tcore.bot === 'tcore', true);
  assert.ok(d.perf.tcore, 'its own performance analysis'); assert.equal(d.perf.tcore.overall.trades, 1);
  assert.ok(d.bots.tcore.trend, 'trend capture against the backtest, as the lab');
});

test('without any tcore event the page is exactly as before (no empty T-CORE view)', () => {
  const events = [...trade(null, 'live', 'bb1', 'SOL_USDT', 'SHORT', ts, ts + 8 * H, -1), ...trade('icore', 'live', 'ic1', 'ADA_USDT', 'SHORT', ts, ts + 8 * H, -1), hb(null, ts + 9 * H, 'live'), hb('icore', ts + 9 * H, 'live')];
  const d = aggregate({ events, now: ts + 9.5 * H, mode: 'live' });
  assert.equal(d.bots.tcore, undefined); assert.equal(d.perf.tcore, null);
});

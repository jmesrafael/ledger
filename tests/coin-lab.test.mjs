// The COIN LAB paper bots (cbb = BB-CORE on ARB, ctc = T-CORE on SUI + ARB; Nov 12, 2026): accepted under their own tags and prefixes only,
// SUI_USDT / ARB_USDT accepted, routed to their own place (coin_labs) without mixing into any other bot, and judged against their own
// backtest on those coins (StrategyBacktester research/coin-walkforward/SUI-ARB.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { aggregate, COIN_LABS } = require('../lib/aggregate.js');
const { PROFILES } = require('../lib/perf.js');
const schema = require('../lib/schema.js');

const ts = 1793000000000, H = 3600e3, D = 86400e3;
const COIN = ['cbb', 'ctc'];
const tagOf = (bot) => (bot ? { bot } : {});
const pre = (bot) => (bot ? bot + '|' : '');
const entry = (bot, symbol, id, at, side = 'LONG') => ({ event_id: `${pre(bot)}${id}-e`, type: 'entry', ts_ms: at, symbol, side, mode: 'paper', data: { trade_id: id, entry: 100, sl: 95, risk_pct: 0.025, ...tagOf(bot) } });
const exit = (bot, symbol, id, at, r, side = 'LONG') => ({ event_id: `${pre(bot)}${id}-x`, type: 'exit', ts_ms: at, symbol, side, mode: 'paper', data: { trade_id: id, reason: 'stop', exit: 100 + r * 5, r, hold_sec: 86400, ...tagOf(bot) } });
const hb = (bot, at) => ({ event_id: `${pre(bot)}hb:${at}`, type: 'heartbeat', ts_ms: at, mode: 'paper', data: { ...tagOf(bot), drawdown_r: 1, halt_r: -39 } });

test('each coin lab is accepted only with its own tag and id prefix; nobody else may use those prefixes', () => {
  for (const b of COIN) {
    const ok = schema.validateEvent({ event_id: `${b}|hb:paper:1793000000`, type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: b, data: {} });
    assert.equal(ok.ok, true, b); assert.equal(ok.event.data.bot, b);
    assert.equal(schema.validateEvent({ event_id: 'hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: b, data: {} }).ok, false);         // wrong prefix
    assert.equal(schema.validateEvent({ event_id: `${b}|hb:paper:1793000000`, type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'bbtr', data: {} }).ok, false);  // another bot posing
    assert.equal(schema.validateEvent({ event_id: `${b}|hb:paper:1793000000`, type: 'heartbeat', ts_ms: ts, mode: 'paper', data: {} }).ok, false);              // BB-Core posing
  }
});

test('SUI_USDT and ARB_USDT are accepted (entries, exits, heartbeat prices); BTC still is not', () => {
  for (const s of ['SUI_USDT', 'ARB_USDT']) {
    assert.ok(schema.validateEvent({ event_id: `ctc|${s}|LONG|1-x`, type: 'exit', ts_ms: ts, mode: 'paper', bot: 'ctc', symbol: s, side: 'LONG', data: { r: 1 } }).ok, s);
  }
  assert.ok(schema.validateEvent({ event_id: 'cbb|hb:paper:1793000001', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'cbb', data: { prices: { ARB_USDT: { px: 0.3, candle_ms: ts } }, enabled_coins: ['ARB_USDT'] } }).ok);
  assert.equal(schema.validateEvent({ event_id: 'ctc|BTC_USDT|LONG|1-x', type: 'exit', ts_ms: ts, mode: 'paper', bot: 'ctc', symbol: 'BTC_USDT', side: 'LONG', data: {} }).ok, false);
});

test('coin lab trades stay in coin_labs and never reach BB-Core, the labs, the news labs or the live bots', () => {
  const events = [entry(null, 'SOL_USDT', 'SOL|LONG|1', ts), exit(null, 'SOL_USDT', 'SOL|LONG|1', ts + D, 2),
    entry('bbtr', 'ZEC_USDT', 'ZEC|LONG|1', ts), exit('bbtr', 'ZEC_USDT', 'ZEC|LONG|1', ts + 2 * D, 5),
    entry('tcn', 'NEAR_USDT', 'NEAR|LONG|1', ts), exit('tcn', 'NEAR_USDT', 'NEAR|LONG|1', ts + D, -1),
    entry('cbb', 'ARB_USDT', 'ARB|LONG|1', ts), exit('cbb', 'ARB_USDT', 'ARB|LONG|1', ts + D, 3),
    entry('ctc', 'SUI_USDT', 'SUI|LONG|1', ts), exit('ctc', 'SUI_USDT', 'SUI|LONG|1', ts + 2 * D, 6), entry('ctc', 'ARB_USDT', 'ARB|SHORT|2', ts + D, 'SHORT'), exit('ctc', 'ARB_USDT', 'ARB|SHORT|2', ts + 3 * D, -1, 'SHORT')];
  const now = ts + 4 * D;
  const d = aggregate({ events, heartbeat: hb(null, now - H), bbtrHeartbeat: hb('bbtr', now - H), newsHeartbeats: { tcn: hb('tcn', now - H) }, coinHeartbeats: { cbb: hb('cbb', now - H), ctc: hb('ctc', now - H) }, now, mode: 'paper' });
  assert.equal(d.trades.length, 1); assert.equal(d.overall.total_r, 2);                        // BB-Core keeps only its own
  assert.equal(d.labs.bbtr.trades.length, 1); assert.equal(d.news_labs.tcn.trades.length, 1);
  assert.equal(d.coin_labs.cbb.trades.length, 1); assert.equal(d.coin_labs.cbb.overall.total_r, 3);
  assert.equal(d.coin_labs.ctc.trades.length, 2); assert.equal(d.coin_labs.ctc.overall.total_r, 5);
  assert.equal(d.coin_labs.cbb.alive, true); assert.ok(d.coin_labs.ctc.trend);                 // T-CORE coin lab gets the trend-capture view
  assert.equal(d.perf.cbb.overall.trades, 1); assert.equal(d.perf.ctc.overall.trades, 2);
  assert.equal(d.news_labs.cbb, undefined); assert.equal(d.labs.cbb, undefined);
});

test('no coin lab block until a coin lab reports; each is judged against its own SUI / ARB backtest', () => {
  assert.equal(aggregate({ events: [], now: ts }).coin_labs, null);
  assert.deepEqual(Object.keys(COIN_LABS), COIN);
  assert.equal(PROFILES.cbb.expect.avg_r, 0.23); assert.equal(PROFILES.cbb.expect.trades_per_month, 3.8);
  assert.equal(PROFILES.ctc.expect.avg_r, 0.648); assert.equal(PROFILES.ctc.expect.win_rate, 0.227);
});

test('the page lists the coin labs with their own labels and colours, and reads them from coin_labs', () => {
  const app = fs.readFileSync(new URL('../bot-dashboard/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../bot-dashboard/style.css', import.meta.url), 'utf8');
  assert.match(app, /LABS = \['bb1h', 'bbn', 'icn', 'tcn', 'cbb', 'ctc'\]/);
  assert.match(app, /cbb: \{ label: 'BB-CORE ARB', live: false, role: 'Coin lab' \}, ctc: \{ label: 'T-CORE SUI\+ARB', live: false, role: 'Coin lab' \}/);
  assert.match(app, /\(d\.coin_labs && d\.coin_labs\[k\]\)/);
  for (const b of COIN) { assert.match(css, new RegExp(`\\[data-bot="${b}"\\] \\{ --bot:`)); assert.match(css, new RegExp(`\\.bot-block\\.${b} \\.bot-block-h`)); }
});

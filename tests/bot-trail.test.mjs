// The T-CORE paper lab bot (bot "bbtr"): its own place on the dashboard, its own backtest profile, its trend-capture numbers and its open trades' trailing stops.
// It shares bb-core's entry rule but never takes the same trades, so it must never mix into BB-Core's, I-Core's or the 1h lab's numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregate } = require('../lib/aggregate.js');
const schema = require('../lib/schema.js');
const { createMemoryStore } = require('../lib/store.js');

const ts = 1793000000000, H = 3600e3, D = 86400e3;
const tagOf = (bot) => (bot ? { bot } : {});
const pre = (bot) => (bot ? bot + '|' : '');
const entry = (bot, symbol, id, at, side = 'LONG') => ({ event_id: `${pre(bot)}${id}-e`, type: 'entry', ts_ms: at, symbol, side, mode: 'paper', data: { trade_id: id, entry: 100, sl: 95, risk_pct: 0.025, ...tagOf(bot) } });
const exit = (bot, symbol, id, at, r, extra = {}, side = 'LONG') => ({ event_id: `${pre(bot)}${id}-x`, type: 'exit', ts_ms: at, symbol, side, mode: 'paper',
  data: { trade_id: id, reason: 'stop', exit: 100 + r * 5, r, hold_sec: 3 * 86400, costs_kind: 'modelled (paper)', fees_r: 0.005, ...tagOf(bot), ...extra } });
const hb = (bot, at, extra = {}) => ({ event_id: `${pre(bot)}hb:${at}`, type: 'heartbeat', ts_ms: at, mode: 'paper', data: { ...tagOf(bot), drawdown_r: 2, halt_r: -45, ...extra } });

test('a bbtr event needs the bbtr| id and the bbtr tag; nobody else may use that prefix', () => {
  const ok = schema.validateEvent({ event_id: 'bbtr|hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'bbtr', data: {} });
  assert.equal(ok.ok, true); assert.equal(ok.event.data.bot, 'bbtr');
  assert.equal(schema.validateEvent({ event_id: 'hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'bbtr', data: {} }).ok, false);
  assert.equal(schema.validateEvent({ event_id: 'bbtr|hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'icore', data: {} }).ok, false);
  assert.equal(schema.validateEvent({ event_id: 'bbtr|hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', data: {} }).ok, false);   // BB-Core cannot pose as it either
});

test('the exit keeps the trend-capture numbers and the heartbeat keeps the open trades\' trailing stops', () => {
  const r = schema.validateBody({ events: [
    { event_id: 'bbtr|x1-xxxxxxxx', type: 'exit', ts_ms: ts, mode: 'paper', symbol: 'SOL_USDT', side: 'LONG', bot: 'bbtr', data: { trade_id: 'SOL_USDT|LONG|1', r: 7.8, mfe_r: 33.1, mae_r: -0.5, gave_back_r: 25.3, stop_at_exit_r: 8, trail_moves: 18, bars: 320, funding_r: -0.2, slip_bp: 3.1, junk: 'dropped' } },
    { event_id: 'bbtr|hb:paper:1793000001', type: 'heartbeat', ts_ms: ts + 1, mode: 'paper', bot: 'bbtr', data: { trail: { SOL_USDT: { entry: 100, stop0: 95, stop: 120, best: 150, locked_r: 4, best_r: 10, moves: 6 } } } },
    { event_id: 'bbtr|hb:paper:1793000002', type: 'heartbeat', ts_ms: ts + 2, mode: 'paper', bot: 'bbtr', data: { trail: { DOGE_USDT: { stop: 1 } } } },
  ] });
  assert.equal(r.ok, false);                                          // a coin outside the allowlist is refused, as everywhere
  const r2 = schema.validateBody({ events: [
    { event_id: 'bbtr|x1-xxxxxxxx', type: 'exit', ts_ms: ts, mode: 'paper', symbol: 'SOL_USDT', side: 'LONG', bot: 'bbtr', data: { trade_id: 'SOL_USDT|LONG|1', r: 7.8, mfe_r: 33.1, mae_r: -0.5, gave_back_r: 25.3, stop_at_exit_r: 8, trail_moves: 18, bars: 320, funding_r: -0.2, slip_bp: 3.1, junk: 'dropped' } },
    { event_id: 'bbtr|hb:paper:1793000001', type: 'heartbeat', ts_ms: ts + 1, mode: 'paper', bot: 'bbtr', data: { trail: { SOL_USDT: { entry: 100, stop0: 95, stop: 120, best: 150, locked_r: 4, best_r: 10, moves: 6 } } } },
  ] });
  assert.equal(r2.ok, true);
  const x = r2.events[0].data, h = r2.events[1].data;
  assert.equal(x.mfe_r, 33.1); assert.equal(x.gave_back_r, 25.3); assert.equal(x.trail_moves, 18); assert.equal(x.bars, 320); assert.equal(x.slip_bp, 3.1); assert.equal(x.junk, undefined);
  assert.equal(h.trail.SOL_USDT.stop, 120); assert.equal(h.trail.SOL_USDT.locked_r, 4);
});

test('T-CORE trades, heartbeats and balances never reach the other bots, and theirs never reach it', () => {
  const events = [entry(null, 'SOL_USDT', 'SOL|LONG|1', ts), exit(null, 'SOL_USDT', 'SOL|LONG|1', ts + 2 * D, 2),
    entry('bbtr', 'ZEC_USDT', 'ZEC|LONG|1', ts), exit('bbtr', 'ZEC_USDT', 'ZEC|LONG|1', ts + 3 * D, -1), entry('bbtr', 'ADA_USDT', 'ADA|LONG|1', ts + D), exit('bbtr', 'ADA_USDT', 'ADA|LONG|1', ts + 9 * D, 12)];
  const d = aggregate({ events, heartbeat: hb(null, ts + 10 * D), bbtrHeartbeat: hb('bbtr', ts + 10 * D), now: ts + 10 * D + H, mode: 'paper' });
  assert.equal(d.trades.length, 1); assert.equal(d.overall.total_r, 2);
  assert.equal(d.labs.bbtr.trades.length, 2); assert.deepEqual(d.labs.bbtr.trades.map((t) => t.symbol).sort(), ['ADA_USDT', 'ZEC_USDT']); assert.equal(d.labs.bbtr.overall.total_r, 11);
  assert.equal(d.perf.bbcore.overall.trades, 1); assert.equal(d.perf.bbtr.overall.trades, 2);
  assert.equal(d.labs.bb1h, undefined);                              // the 1h lab is not there, and the page asks for it by name
  assert.equal(d.bots, null);
});

test('it is judged against its own 4h trailing-stop backtest, not bb-core\'s', () => {
  const d = aggregate({ events: [entry('bbtr', 'SOL_USDT', 'SOL|LONG|1', ts), exit('bbtr', 'SOL_USDT', 'SOL|LONG|1', ts + D, 1)], bbtrHeartbeat: hb('bbtr', ts + 2 * D), now: ts + 2 * D + H, mode: 'paper' });
  const p = d.perf.bbtr;
  assert.equal(p.label, 'T-CORE lab'); assert.equal(p.expect.avg_r, 1.286); assert.equal(p.expect.win_rate, 0.21); assert.equal(p.expect.trades_per_month, 7.7); assert.equal(p.expect.longest_losing, 26);
  assert.equal(d.perf.bbcore.expect.avg_r, 0.35);                     // BB-Core's own profile is untouched
  assert.ok(p.checks.some((c) => c.id === 'drawdown' && /45R/.test(c.limit)));
});

test('trend capture: reach rates, medians and the backtest numbers to compare with', () => {
  const x = (n, r, mfe, mae, gave, bars, moves) => [entry('bbtr', 'SOL_USDT', `SOL|LONG|${n}`, ts + n * D), exit('bbtr', 'SOL_USDT', `SOL|LONG|${n}`, ts + n * D + H, r, { mfe_r: mfe, mae_r: mae, gave_back_r: gave, bars, trail_moves: moves, funding_r: -0.1, slip_bp: 4 })];
  const events = [...x(1, -1, 0.4, -1.05, 1.4, 5, 0), ...x(2, -1, 0.9, -1.1, 1.9, 8, 0), ...x(3, 2.2, 4.1, -0.3, 1.9, 40, 9), ...x(4, 30, 36, -0.6, 6, 400, 60)];
  const t = aggregate({ events, bbtrHeartbeat: hb('bbtr', ts + 10 * D), now: ts + 10 * D + H, mode: 'paper' }).labs.bbtr.trend;
  assert.equal(t.trades, 4); assert.equal(t.reached_1r, 0.5); assert.equal(t.reached_3r, 0.5); assert.equal(t.reached_5r, 0.25); assert.equal(t.reached_10r, 0.25);
  assert.equal(t.mfe_median, 2.5); assert.equal(t.gave_back_median, 1.9); assert.equal(t.bars_median, 24); assert.equal(t.funding_r_avg, -0.1); assert.equal(t.slip_bp_avg, 4);
  assert.equal(t.expect.reached_3r, 0.31); assert.equal(t.expect.bars_median, 32);
  const none = aggregate({ events: [entry('bbtr', 'SOL_USDT', 'SOL|LONG|9', ts)], bbtrHeartbeat: hb('bbtr', ts + D), now: ts + D + H, mode: 'paper' }).labs.bbtr.trend;
  assert.equal(none.trades, 0);                                       // no closed trade yet: no rates, but the backtest numbers are still there
});

test('an open trade shows the stop it has right now, from the heartbeat', () => {
  const d = aggregate({ events: [entry('bbtr', 'SOL_USDT', 'SOL|LONG|1', ts)], bbtrHeartbeat: hb('bbtr', ts + 3 * D, { trail: { SOL_USDT: { entry: 100, stop0: 95, stop: 118.4, best: 140, locked_r: 3.68, best_r: 8, moves: 7 } } }), now: ts + 3 * D + H, mode: 'paper' });
  const o = d.labs.bbtr.open_list[0];
  assert.equal(o.symbol, 'SOL_USDT'); assert.equal(o.trail_stop, 118.4); assert.equal(o.locked_r, 3.68); assert.equal(o.best_r, 8); assert.equal(o.trail_moves, 7);
});

test('the closed trade carries its research numbers to the page', () => {
  const d = aggregate({ events: [entry('bbtr', 'SOL_USDT', 'SOL|LONG|1', ts), exit('bbtr', 'SOL_USDT', 'SOL|LONG|1', ts + 5 * D, 7.8, { mfe_r: 33.1, mae_r: -0.5, gave_back_r: 25.3, stop_at_exit_r: 8, trail_moves: 18, bars: 320, funding_r: -0.2, slip_bp: 3.1 })], bbtrHeartbeat: hb('bbtr', ts + 6 * D), now: ts + 6 * D + H, mode: 'paper' });
  const t = d.labs.bbtr.trades[0];
  assert.equal(t.mfe_r, 33.1); assert.equal(t.mae_r, -0.5); assert.equal(t.gave_back_r, 25.3); assert.equal(t.stop_at_exit_r, 8); assert.equal(t.trail_moves, 18); assert.equal(t.bars, 320); assert.equal(t.funding_r, -0.2); assert.equal(t.slip_bp, 3.1);
});

test('the store keeps bbtr events apart from the other bots (heartbeat and equity)', async () => {
  const st = createMemoryStore();
  await st.insert([hb(null, ts), hb('bbtr', ts + 1), hb('icore', ts + 2),
    { event_id: 'bbtr|eq:paper:1', type: 'equity', ts_ms: ts, mode: 'paper', data: { bot: 'bbtr', total_r: 3, paper_balance: 110 } },
    { event_id: 'eq:paper:1', type: 'equity', ts_ms: ts, mode: 'paper', data: { total_r: 1, paper_balance: 101 } }]);
  assert.equal((await st.latestHeartbeat({ bot: 'bbtr' })).event_id, `bbtr|hb:${ts + 1}`);
  assert.equal((await st.latestHeartbeat()).event_id, `hb:${ts}`);
  const eq = await st.equityEvents();
  assert.ok(eq.some((e) => e.data.bot === 'bbtr') && eq.some((e) => !e.data.bot));
});

test('with no T-CORE events the page gets nothing for it', () => {
  const d = aggregate({ events: [], now: ts });
  assert.equal(d.labs, null); assert.equal(d.perf.bbtr, null);
  const e = aggregate({ events: [entry('bb1h', 'SOL_USDT', 'SOL|LONG|1', ts)], now: ts + H });
  assert.ok(e.labs && e.labs.bb1h && !e.labs.bbtr);
});

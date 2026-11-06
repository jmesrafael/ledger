// The bot dashboard's Calendar and Research numbers (bot-dashboard/research.js) and the trade detail that lib/aggregate.js now passes through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../bot-dashboard/research.js');
const { aggregate } = require('../lib/aggregate.js');

const T = (iso, r, extra = {}) => ({ symbol: 'SOL_USDT', side: 'LONG', r, usd: null, reason: r > 0 ? 'target' : 'stop', entry_ts: Date.parse(iso) - 3600e3, exit_ts: Date.parse(iso), hold_sec: 3600, ...extra });

test('a trade counts on the day it closed, in the chosen zone', () => {
  const t = T('2026-11-03T23:30:00Z', 1.5);
  assert.equal(R.dayKey(t.exit_ts, 'utc'), '2026-11-03');
  const days = R.dailyMap([t, T('2026-11-03T01:00:00Z', -1)], 'utc');
  assert.equal(days.size, 1);
  const d = days.get('2026-11-03');
  assert.equal(d.n, 2); assert.equal(d.r, 0.5); assert.equal(d.wins, 1); assert.equal(d.losses, 1); assert.equal(d.usd, null);
});

test('money is summed only when trades carry it', () => {
  const days = R.dailyMap([T('2026-11-03T10:00:00Z', 1, { usd: 5 }), T('2026-11-03T12:00:00Z', -0.5, { usd: -2.5 })], 'utc');
  assert.equal(days.get('2026-11-03').usd, 2.5);
});

test('month grid: Monday first, whole weeks, only days of the month carry results, totals add up', () => {
  const days = R.dailyMap([T('2026-11-02T10:00:00Z', 2), T('2026-11-05T10:00:00Z', -1), T('2026-11-30T10:00:00Z', 0.5), T('2026-10-31T10:00:00Z', 9)], 'utc');
  const g = R.monthGrid(days, 2026, 10);                       // November 2026 starts on a Sunday
  assert.equal(g.weeks[0].cells[0].day, 26);                   // Mon Oct 26 pads the first row
  assert.equal(g.weeks[0].cells[0].inMonth, false);
  assert.equal(g.weeks[0].cells[6].day, 1); assert.equal(g.weeks[0].cells[6].inMonth, true);
  assert.ok(g.weeks.every((w) => w.cells.length === 7));
  assert.equal(g.weeks.flatMap((w) => w.cells).filter((c) => c.stat).length, 3);   // Oct 31 is not shown in November
  assert.equal(g.total.r, 1.5); assert.equal(g.total.n, 3); assert.equal(g.total.win_days, 2); assert.equal(g.total.loss_days, 1);
  assert.equal(g.total.best.key, '2026-11-02'); assert.equal(g.total.worst.key, '2026-11-05');
  assert.equal(g.weeks.reduce((a, w) => a + w.total.r, 0), 1.5);                  // week totals add up to the month
});

test('a month that starts on the week start has no padding', () => {
  const j = R.monthGrid(new Map(), 2026, 5);                   // June 2026 starts on a Monday
  assert.equal(j.weeks[0].cells[0].day, 1); assert.equal(j.weeks[0].cells[0].inMonth, true);
});

test('year strip and months with data', () => {
  const days = R.dailyMap([T('2026-10-05T10:00:00Z', 1), T('2026-11-05T10:00:00Z', -2), T('2025-12-05T10:00:00Z', 4)], 'utc');
  assert.deepEqual(R.monthsWithData(days), ['2025-12', '2026-10', '2026-11']);
  const y = R.yearMonths(days, 2026);
  assert.equal(y.length, 12); assert.equal(y[9].r, 1); assert.equal(y[10].r, -2); assert.equal(y[0].n, 0);
});

test('summary: win rate, profit factor, drawdown, losing streak', () => {
  const s = R.summarize([T('2026-11-01T10:00:00Z', 2), T('2026-11-02T10:00:00Z', -1), T('2026-11-03T10:00:00Z', -1), T('2026-11-04T10:00:00Z', 1)]);
  assert.equal(s.n, 4); assert.equal(s.wins, 2); assert.equal(s.total_r, 1); assert.equal(s.win_rate, 0.5);
  assert.equal(s.profit_factor, 1.5); assert.equal(s.max_dd_r, 2); assert.equal(s.longest_losing_streak, 2);
  assert.equal(s.best_r, 2); assert.equal(s.worst_r, -1);
  assert.equal(R.summarize([]).win_rate, null);
  assert.equal(R.summarize([T('2026-11-01T10:00:00Z', 1)]).profit_factor, Infinity);
});

test('groupings keep their order and skip trades without the field', () => {
  const tr = [T('2026-11-02T10:00:00Z', 1), T('2026-11-03T10:00:00Z', -1, { side: 'SHORT' }), T('2026-11-04T10:00:00Z', 1, { hold_sec: null })];
  assert.deepEqual(R.groupBy(tr, (t) => t.side, ['LONG', 'SHORT']).map((g) => [g.key, g.n]), [['LONG', 2], ['SHORT', 1]]);
  assert.equal(R.byHold(tr).reduce((a, g) => a + g.n, 0), 2);                       // the trade with no hold time is left out
  assert.equal(R.byHourBlock(tr, 'utc').reduce((a, g) => a + g.n, 0), 3);
});

test('histogram puts every trade in exactly one band', () => {
  const tr = [-3, -1, -0.2, 0, 0.7, 1.4, 5].map((r, i) => T(`2026-11-0${i + 1}T10:00:00Z`, r));
  const h = R.histogram(tr);
  assert.equal(h.reduce((a, b) => a + b.n, 0), 7);
  assert.equal(h[0].n, 1); assert.equal(h[h.length - 1].n, 1);
});

test('edge: the 95% range is wide with few trades and says whether it excludes zero', () => {
  const small = R.edge([T('2026-11-01T10:00:00Z', 2), T('2026-11-02T10:00:00Z', -1), T('2026-11-03T10:00:00Z', 0.5)]);
  assert.equal(small.excludes_zero, false); assert.ok(small.lo < 0 && small.hi > 0);
  const big = R.edge(Array.from({ length: 100 }, (_, i) => T('2026-11-01T10:00:00Z', 0.5 + (i % 2 ? 0.1 : -0.1))));
  assert.equal(big.excludes_zero, true);
  assert.equal(R.edge([]).mean, null);
});

test('readiness: waits with no data, passes good execution, fails late entries and costs', () => {
  const none = R.readiness([]);
  assert.ok(none.every((c) => c.status === 'wait'));
  const good = Array.from({ length: 25 }, () => T('2026-11-01T10:00:00Z', 1, { delay_sec: 3, slippage_r: 0.01, fees_r: 0.02 }));
  const ok = Object.fromEntries(R.readiness(good, { compare: { match: true, matched: 25 }, drawdownR: 3, haltR: -26 }).map((c) => [c.id, c.status]));
  assert.deepEqual(ok, { sample: 'pass', timing: 'pass', costs: 'pass', compare: 'pass', dd: 'pass' });
  const bad = Object.fromEntries(R.readiness(good.map((t) => ({ ...t, delay_sec: 1200, fees_r: 0.2 })), { compare: { match: false }, drawdownR: 30, haltR: -26 }).map((c) => [c.id, c.status]));
  assert.deepEqual(bad, { sample: 'pass', timing: 'fail', costs: 'fail', compare: 'fail', dd: 'fail' });
});

test('aggregate passes the entry and exit detail through to each trade, for both bots, with the skip counts', () => {
  const ts = 1793000000000;
  const mk = (bot, symbol) => {
    const base = { symbol, side: 'LONG', mode: 'paper' }, tag = bot ? { bot } : {}, id = `${symbol}|LONG|${ts}`;
    return [
      { event_id: `${symbol}-e1`, type: 'entry', ts_ms: ts, ...base, data: { trade_id: id, entry: 100, intended_price: 99.9, sl: 95, tp: null, slippage_r: 0.02, delay_sec: 4, nearest_threshold_pct: 0.31, one_r: 5, qty: 2, risk_usd: 10, balance_used: 250, risk_pct: 0.04, costs_kind: 'estimate (paper)', ...tag } },
      { event_id: `${symbol}-x1`, type: 'exit', ts_ms: ts + 7200e3, ...base, data: { trade_id: id, reason: 'stop', exit: 95, r: -1, usd: -10, hold_sec: 7200, fees_pct_est: 0.1, fees_r: 0.03, balance_after: 240, costs_kind: 'estimate (paper)', ...tag } },
      { event_id: `${symbol}-s1`, type: 'signal', ts_ms: ts + 1, ...base, data: { decision: 'skipped', reason: 'late_entry', ...tag } },
      { event_id: `${symbol}-s2`, type: 'signal', ts_ms: ts + 2, ...base, data: { decision: 'skipped', reason: 'late_entry', ...tag } },
    ];
  };
  const events = [...mk(null, 'SOL_USDT'), ...mk('icore', 'ZEC_USDT')];
  const hb = (bot) => ({ ts_ms: ts + 8000e3, mode: 'paper', data: { ...(bot ? { bot } : {}), drawdown_r: 1, halt_r: -26 } });
  const d = aggregate({ events, heartbeat: hb(null), icoreHeartbeat: hb('icore'), now: ts + 8100e3, mode: 'paper' });
  for (const [label, t] of [['BB-Core', d.trades[0]], ['I-Core', d.bots.icore.trades[0]]]) {
    assert.equal(t.intended, 99.9, label); assert.equal(t.slippage_r, 0.02, label); assert.equal(t.delay_sec, 4, label); assert.equal(t.near_thr_pct, 0.31, label);
    assert.equal(t.qty, 2, label); assert.equal(t.risk_usd, 10, label); assert.equal(t.balance_used, 250, label); assert.equal(t.fees_r, 0.03, label); assert.equal(t.balance_after, 240, label); assert.equal(t.costs_kind, 'estimate (paper)', label);
    assert.equal(t.one_r, 5, label); assert.equal(t.signal_candle_open_ms, null, label);
    assert.equal(t.trade_id, undefined, label);                                       // the page still never gets the internal id
  }
  assert.deepEqual(d.skip_counts, { late_entry: 2 }); assert.deepEqual(d.bots.icore.skip_counts, { late_entry: 2 });
  assert.equal(d.first_event_ms, ts); assert.equal(d.bots.icore.first_event_ms, ts);
  assert.equal(d.overall.total_r, -1);                                              // existing numbers are unchanged
});

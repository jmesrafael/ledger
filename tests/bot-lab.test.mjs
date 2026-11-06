// The 1h paper lab bot (bot "bb1h") and the VPS data recorder (bot "recorder") on the dashboard: they have their own place and can never mix into BB-Core's numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregate } = require('../lib/aggregate.js');
const schema = require('../lib/schema.js');
const { createMemoryStore, createSupabaseStore } = require('../lib/store.js');
const R = require('../bot-dashboard/research.js');

const ts = 1793000000000, H = 3600e3;
const trade = (bot, symbol, id, r, at) => {
  const tag = bot ? { bot } : {}, base = { symbol, side: 'LONG', mode: 'paper' };
  return [
    { event_id: `${bot ? bot + '|' : ''}${id}-e`, type: 'entry', ts_ms: at, ...base, data: { trade_id: id, entry: 100, sl: 95, risk_pct: 0.025, ...tag } },
    { event_id: `${bot ? bot + '|' : ''}${id}-x`, type: 'exit', ts_ms: at + 5 * H, ...base, data: { trade_id: id, reason: r > 0 ? 'time' : 'stop', exit: 100 + r * 5, r, hold_sec: 5 * 3600, costs_kind: 'modelled (paper)', fees_pct_est: 0.04, slippage_pct_est: 0.01, funding_est: -0.02, fees_r: 0.008, ...tag } },
  ];
};
const hb = (bot, at, extra = {}) => ({ event_id: `${bot ? bot + '|' : ''}hb:${at}`, type: 'heartbeat', ts_ms: at, mode: 'paper', data: { ...(bot ? { bot } : {}), drawdown_r: 1, halt_r: -39, ...extra } });

test('lab trades, balances and heartbeats never reach BB-Core, and BB-Core never reaches the lab', () => {
  const events = [...trade(null, 'SOL_USDT', 'SOL|LONG|1', 2, ts), ...trade('bb1h', 'ZEC_USDT', 'ZEC|LONG|1', -1, ts), ...trade('bb1h', 'ADA_USDT', 'ADA|LONG|1', 3, ts + H)];
  const d = aggregate({ events, heartbeat: hb(null, ts + 9 * H), bb1hHeartbeat: hb('bb1h', ts + 9 * H), now: ts + 10 * H, mode: 'paper' });
  assert.equal(d.trades.length, 1); assert.equal(d.trades[0].symbol, 'SOL_USDT'); assert.equal(d.overall.total_r, 2);
  assert.equal(d.labs.bb1h.trades.length, 2); assert.deepEqual(d.labs.bb1h.trades.map((t) => t.symbol).sort(), ['ADA_USDT', 'ZEC_USDT']); assert.equal(d.labs.bb1h.overall.total_r, 2);
  assert.equal(d.perf.bbcore.overall.trades, 1); assert.equal(d.perf.bb1h.overall.trades, 2);
  assert.equal(d.bots, null);                                        // the lab alone does not turn on the two-bot cards
  assert.equal(d.labs.bb1h.alive, true); assert.equal(d.labs.bb1h.mode, 'paper');
});

test('the lab is judged against the 1h backtest, not the 4h one', () => {
  const d = aggregate({ events: trade('bb1h', 'SOL_USDT', 'SOL|LONG|1', 1, ts), bb1hHeartbeat: hb('bb1h', ts + 6 * H), now: ts + 7 * H, mode: 'paper' });
  const p = d.perf.bb1h;
  assert.equal(p.label, 'BB-1h lab'); assert.equal(p.expect.avg_r, 0.457); assert.equal(p.expect.trades_per_month, 19.8); assert.equal(p.expect.longest_losing, 21);
  assert.equal(d.perf.bbcore.expect.avg_r, 0.35);                     // BB-Core's own profile is untouched
  assert.ok(p.checks.some((c) => c.id === 'drawdown' && /39R/.test(c.limit)));
});

test('the trade card gets the modelled costs of the lab trade', () => {
  const d = aggregate({ events: trade('bb1h', 'SOL_USDT', 'SOL|LONG|1', 1, ts), bb1hHeartbeat: hb('bb1h', ts + 6 * H), now: ts + 7 * H, mode: 'paper' });
  const t = d.labs.bb1h.trades[0];
  assert.equal(t.costs_kind, 'modelled (paper)'); assert.equal(t.fees_pct, 0.04); assert.equal(t.slip_pct, 0.01); assert.equal(t.funding, -0.02); assert.equal(t.fees_r, 0.008);
});

test('with no lab or recorder events the page gets null for both', () => {
  const d = aggregate({ events: [], now: ts });
  assert.equal(d.labs, null); assert.equal(d.recorder, null); assert.equal(d.perf.bb1h, null);
});

test('recorder view: regime, slippage and health come through; stale after 30 minutes', () => {
  const data = { bot: 'recorder', regime: { SOL_USDT: { atr_pct: 1.5, er48: 0.2 } }, regime_state: { SOL_USDT: 'ranging' }, market: { avg_corr_7d: 0.7 }, market_state: 'choppy', slippage: { SOL_USDT: { sp: 1.1, b1000: 0.6 } }, recorder: { version: 1, errors_1h: 0 } };
  const fresh = aggregate({ events: [], recorderHeartbeat: { ts_ms: ts, mode: 'paper', data }, now: ts + 10 * 60e3 }).recorder;
  assert.equal(fresh.alive, true); assert.equal(fresh.market_state, 'choppy'); assert.equal(fresh.regime_state.SOL_USDT, 'ranging'); assert.equal(fresh.slippage.SOL_USDT.b1000, 0.6); assert.equal(fresh.health.version, 1);
  assert.equal(aggregate({ events: [], recorderHeartbeat: { ts_ms: ts, mode: 'paper', data }, now: ts + 40 * 60e3 }).recorder.alive, false);
});

test('schema: the recorder heartbeat accepts the regime and slippage maps and refuses a bad one', () => {
  const ev = (data, extra = {}) => ({ event_id: 'rec|hb:1', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'recorder', data, ...extra });
  const ok = schema.validateEvent(ev({ regime: { SOL_USDT: { atr_pct: 1.2 } }, regime_state: { SOL_USDT: 'ranging' }, market: { avg_corr_7d: 0.5 }, market_state: 'choppy', slippage: { SOL_USDT: { sp: 1 } }, recorder: { version: 1 } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors)); assert.equal(ok.event.data.bot, 'recorder'); assert.equal(ok.event.data.regime.SOL_USDT.atr_pct, 1.2);
  assert.equal(schema.validateEvent(ev({ regime: { BTC_USDT: { atr_pct: 1 } } })).ok, false);                       // only the allowed coins
  assert.equal(schema.validateEvent(ev({ regime: { SOL_USDT: { 'Bad Key': 1 } } })).ok, false);                      // short lower-case names only
  assert.equal(schema.validateEvent(ev({ regime: { SOL_USDT: { atr_pct: 'x' } } })).ok, false);                      // numbers only
  assert.equal(schema.validateEvent(ev({ recorder: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })).ok, false);   // at most 20 keys
  assert.equal(schema.validateEvent(ev({}, { bot: 'nobody' })).ok, false);
});

test('schema: each sender needs its own event_id prefix and no other sender may use it', () => {
  const base = { type: 'heartbeat', ts_ms: ts, mode: 'paper', data: {} };
  for (const [bot, pre] of [['icore', 'ic|'], ['bb1h', 'bb1h|'], ['recorder', 'rec|']]) {
    assert.equal(schema.validateEvent({ ...base, bot, event_id: `${pre}hb:12345` }).ok, true, bot);
    assert.equal(schema.validateEvent({ ...base, bot, event_id: 'hb:12345678' }).ok, false, bot);
    assert.equal(schema.validateEvent({ ...base, event_id: `${pre}hb:12345` }).ok, false, `untagged with ${pre}`);
  }
  assert.equal(schema.validateEvent({ ...base, bot: 'bb1h', event_id: 'ic|hb:12345' }).ok, false);
  assert.equal(schema.validateEvent({ ...base, event_id: 'hb:12345678' }).ok, true);                                    // BB-Core: as always
});

test('store: the heartbeat of each sender is its own, and a sender name can never become part of a query', async () => {
  const s = createMemoryStore();
  await s.insert([{ event_id: 'hb:1', type: 'heartbeat', ts_ms: ts, mode: 'paper', symbol: null, side: null, data: { v: 'bbcore' } },
    { event_id: 'bb1h|hb:1', type: 'heartbeat', ts_ms: ts + 5, mode: 'paper', symbol: null, side: null, data: { bot: 'bb1h', v: 'lab' } },
    { event_id: 'rec|hb:1', type: 'heartbeat', ts_ms: ts + 9, mode: 'paper', symbol: null, side: null, data: { bot: 'recorder', v: 'rec' } }]);
  assert.equal((await s.latestHeartbeat()).data.v, 'bbcore'); assert.equal((await s.latestHeartbeat({ bot: 'bb1h' })).data.v, 'lab'); assert.equal((await s.latestHeartbeat({ bot: 'recorder' })).data.v, 'rec');
  const urls = [];
  const sb = createSupabaseStore({ url: 'https://x.supabase.co', key: 'k', fetchImpl: async (u) => { urls.push(String(u)); return { ok: true, json: async () => [] }; } });
  await sb.latestHeartbeat({ bot: 'bb1h' }); await sb.latestHeartbeat({ bot: 'bb1h&select=*' }); await sb.latestHeartbeat();
  assert.match(urls[0], /data->>bot=eq\.bb1h/); assert.match(urls[1], /data->>bot=is\.null/); assert.match(urls[2], /data->>bot=is\.null/);       // an unknown name falls back, it is never pasted into the URL
});

test('store: a chatty bot does not push another bot out of the equity window', async () => {
  const s = createMemoryStore(), rows = [];
  for (let i = 0; i < 50; i++) rows.push({ event_id: `eq-a-${i}`, type: 'equity', ts_ms: ts + i, mode: 'paper', symbol: null, side: null, data: { paper_balance: 100 } });
  for (let i = 0; i < 2000; i++) rows.push({ event_id: `bb1h|eq-${i}`, type: 'equity', ts_ms: ts + 100000 + i, mode: 'paper', symbol: null, side: null, data: { bot: 'bb1h', paper_balance: 250 } });
  await s.insert(rows);
  const out = await s.equityEvents({ recent: 100 });
  assert.equal(out.filter((r) => !r.data.bot).length, 50);                                         // every BB-Core reading is still there
  assert.ok(out.filter((r) => r.data.bot === 'bb1h').length <= 601);
});

test('readiness: the lab has no live-vs-backtest check, a live bot does', () => {
  assert.ok(!R.readiness([], { skipCompare: true }).some((c) => c.id === 'compare'));
  assert.ok(R.readiness([], {}).some((c) => c.id === 'compare'));
});

// ---- the real 1h bot's events against this dashboard's validator (the bot lives next to this repo in StrategyBacktester) ----
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const botDir = new URL('../../bb-core-1h/', import.meta.url);
test('the 1h bot\'s own entry, exit, equity and heartbeat events pass the dashboard validator as bb1h', { skip: !existsSync(new URL('dashboard-push.js', botDir)) }, () => {
  process.env.DASHBOARD_BOT = 'bb1h'; process.env.DASHBOARD_URL = 'https://example.invalid'; process.env.DASHBOARD_PUSH_SECRET = 'x'.repeat(24);
  process.env.LUCIDIO_STATE_DIR = mkdtempSync(join(tmpdir(), 'lab-'));
  const push = require(new URL('dashboard-push.js', botDir).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const journal = require(new URL('journal.js', botDir).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const { DEFAULTS } = require(new URL('lucidio-core.js', botDir).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const candle = { open: 100, high: 105, low: 99, close: 104 };
  const entry = journal.entryEvent({ symbol: 'SOL_USDT', dir: 1, sigTime: 1792996400, decisionSec: 1793000002, sigCandle: candle, indicators: { nearest_threshold_pct: 0.42 }, intended: 104, fill: 104.01, nextOpenSec: 1793000000, nextOpen: 104, delaySec: 2, slipR: 0.002,
    stop: 100, tp: null, qty: 1.4, vol: 14, lev: 9, riskUsd: 5.6, balance: 250, oneR: 4.01, live: false,
    costs: { kind: 'modelled (paper)', entry_fee_pct: 0.02, entry_slippage_pct: 0.0056, entry_slip_source: 'live book walk', book: { mid: 104, spread_bp: 1.1, slip_bp: 0.56 }, contracts: 14 } }, DEFAULTS, 'paper', 1793000002000);
  const exit = journal.exitEvent({ symbol: 'SOL_USDT', dir: 1, sigTime: 1792996400, why: 'stop', exit: 99.96, entry: 104.01, stop: 100, tp: null, t0: 1793000000, R: -1.012, usd: -5.67, balanceAfter: 244.33, exitSec: 1793090000, exitCandleOpenSec: 1793086400, holdSec: 90000,
    costs: { kind: 'modelled (paper)', fees_pct: 0.04, fees_r: 0.01, slippage_pct: 0.011, funding_r: -0.012, funding_events: 3, funding_source: 'MEXC settled history' } }, DEFAULTS, 'paper', 1793090000000);
  const out = [...push.fromJournal(entry), ...push.fromJournal(exit), push.equityEvent({ mode: 'paper', totalR: -1, peakR: 0, drawdownR: 1, trades: 1, candleMs: 1793090000, balance: 244.33 }),
    push.heartbeatEvent({ mode: 'paper', status: 'running', lastCandleMs: {}, kill: false, drawdownR: 1, haltR: -39, commit: 'abc', version: '1.1.0', uptimeSec: 100, nextWakeMs: null, coins: ['SOL_USDT'] })];
  assert.ok(out.length >= 4);
  for (const ev of out) {
    assert.equal(ev.bot, 'bb1h'); assert.ok(ev.event_id.startsWith('bb1h|'), ev.event_id);
    const r = schema.validateEvent(ev); assert.equal(r.ok, true, `${ev.type}: ${JSON.stringify(r.errors)}`); assert.equal(r.event.data.bot, 'bb1h');
  }
  const ex = out.find((e) => e.type === 'exit'); assert.equal(ex.data.funding_est, -0.012); assert.equal(ex.data.fees_pct_est, 0.04); assert.equal(ex.data.slippage_pct_est, 0.011); assert.equal(ex.data.costs_kind, 'modelled (paper)');
  delete process.env.DASHBOARD_BOT;
});

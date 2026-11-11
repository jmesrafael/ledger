// The NEWS LAB paper bots (bbn = BB-CORE + news gate, icn = I-CORE + news gate, tcn = T-CORE + news gate): accepted under their own tags and prefixes only,
// routed to their own place (news_labs) without mixing into any other bot, judged against their strategy's own backtest, news-gate skips counted;
// and the dashboard's browser copy of the news gate gives the same verdicts as the module the bots and the backtest use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { aggregate } = require('../lib/aggregate.js');
const schema = require('../lib/schema.js');
const browserGate = require('../bot-dashboard/news-gate.js');

const ts = 1793000000000, H = 3600e3, D = 86400e3;
const NEWS = ['bbn', 'icn', 'tcn'];
const tagOf = (bot) => (bot ? { bot } : {});
const pre = (bot) => (bot ? bot + '|' : '');
const entry = (bot, symbol, id, at, side = 'LONG') => ({ event_id: `${pre(bot)}${id}-e`, type: 'entry', ts_ms: at, symbol, side, mode: 'paper', data: { trade_id: id, entry: 100, sl: 95, risk_pct: 0.025, ...tagOf(bot) } });
const exit = (bot, symbol, id, at, r, side = 'LONG') => ({ event_id: `${pre(bot)}${id}-x`, type: 'exit', ts_ms: at, symbol, side, mode: 'paper', data: { trade_id: id, reason: 'stop', exit: 100 + r * 5, r, hold_sec: 86400, ...tagOf(bot) } });
const skip = (bot, symbol, at, reason, detail = '') => ({ event_id: `${pre(bot)}sk:${symbol}:${at}`, type: 'signal', ts_ms: at, symbol, side: 'LONG', mode: 'paper', data: { decision: 'skipped', reason, detail, signal_candle_open_ms: at - 4 * H, ...tagOf(bot) } });
const hb = (bot, at) => ({ event_id: `${pre(bot)}hb:${at}`, type: 'heartbeat', ts_ms: at, mode: 'paper', data: { ...tagOf(bot), drawdown_r: 1, halt_r: -45 } });

test('each news lab is accepted only with its own tag and its own id prefix; nobody else may use those prefixes', () => {
  for (const b of NEWS) {
    const ok = schema.validateEvent({ event_id: `${b}|hb:paper:1793000000`, type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: b, data: {} });
    assert.equal(ok.ok, true, b); assert.equal(ok.event.data.bot, b);
    assert.equal(schema.validateEvent({ event_id: 'hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: b, data: {} }).ok, false);        // wrong prefix
    assert.equal(schema.validateEvent({ event_id: `${b}|hb:paper:1793000000`, type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'bbtr', data: {} }).ok, false); // another bot posing
    assert.equal(schema.validateEvent({ event_id: `${b}|hb:paper:1793000000`, type: 'heartbeat', ts_ms: ts, mode: 'paper', data: {} }).ok, false);             // BB-Core posing
  }
  // the old tags keep working, and bb1h| is not mistaken for bbn|
  assert.equal(schema.validateEvent({ event_id: 'bb1h|hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'bb1h', data: {} }).ok, true);
  assert.equal(schema.validateEvent({ event_id: 'bbtr|hb:paper:1793000000', type: 'heartbeat', ts_ms: ts, mode: 'paper', bot: 'bbtr', data: {} }).ok, true);
});

test('news lab trades stay in news_labs and never reach BB-Core, the labs or the live bots, and theirs never reach the news labs', () => {
  const events = [entry(null, 'SOL_USDT', 'SOL|LONG|1', ts), exit(null, 'SOL_USDT', 'SOL|LONG|1', ts + D, 2),
    entry('bbtr', 'ZEC_USDT', 'ZEC|LONG|1', ts), exit('bbtr', 'ZEC_USDT', 'ZEC|LONG|1', ts + 2 * D, 5),
    entry('bbn', 'SOL_USDT', 'SOL|LONG|1', ts), exit('bbn', 'SOL_USDT', 'SOL|LONG|1', ts + D, 2),
    entry('icn', 'ADA_USDT', 'ADA|LONG|1', ts), exit('icn', 'ADA_USDT', 'ADA|LONG|1', ts + D, -1),
    entry('tcn', 'ZEC_USDT', 'ZEC|LONG|1', ts), exit('tcn', 'ZEC_USDT', 'ZEC|LONG|1', ts + 2 * D, 5), entry('tcn', 'NEAR_USDT', 'NEAR|LONG|2', ts + D), exit('tcn', 'NEAR_USDT', 'NEAR|LONG|2', ts + 3 * D, -1)];
  const now = ts + 4 * D;
  const d = aggregate({ events, heartbeat: hb(null, now - H), bbtrHeartbeat: hb('bbtr', now - H), newsHeartbeats: { bbn: hb('bbn', now - H), icn: hb('icn', now - H), tcn: hb('tcn', now - H) }, now, mode: 'paper' });
  assert.equal(d.trades.length, 1); assert.equal(d.overall.total_r, 2);                      // BB-Core: only its own trade
  assert.equal(d.labs.bbtr.overall.total_r, 5); assert.equal(d.labs.bbtr.trades.length, 1);   // the T-CORE lab: only its own
  assert.equal(d.news_labs.bbn.overall.total_r, 2); assert.equal(d.news_labs.icn.overall.total_r, -1);
  assert.equal(d.news_labs.tcn.trades.length, 2); assert.equal(d.news_labs.tcn.overall.total_r, 4);
  assert.equal(d.news_labs.tcn.label, 'T-CORE news lab'); assert.equal(d.news_labs.bbn.alive, true);
  assert.ok(d.news_labs.tcn.trend);                                                            // T-CORE news gets the trend-capture view, like the T-CORE lab
  assert.equal(d.bots, null);                                                                  // paper news labs never create the live side-by-side block
  assert.equal(d.perf.tcn.overall.trades, 2); assert.equal(d.perf.bbn.overall.trades, 1); assert.equal(d.perf.icn.overall.trades, 1);
});

test('no news lab reported yet: news_labs is null and perf has empty slots (the page shows "waiting for first heartbeat")', () => {
  const d = aggregate({ events: [entry(null, 'SOL_USDT', 'SOL|LONG|1', ts)], heartbeat: hb(null, ts + H), now: ts + 2 * H, mode: 'paper' });
  assert.equal(d.news_labs, null);
  for (const b of NEWS) assert.equal(d.perf[b], null);
});

test('each news lab is judged against its own strategy\'s backtest', () => {
  const now = ts + 3 * D, nh = { bbn: hb('bbn', now - H), icn: hb('icn', now - H), tcn: hb('tcn', now - H) };
  const events = NEWS.flatMap((b) => [entry(b, 'SOL_USDT', 'SOL|LONG|1', ts), exit(b, 'SOL_USDT', 'SOL|LONG|1', ts + D, 1)]);
  const d = aggregate({ events, newsHeartbeats: nh, now, mode: 'paper' });
  assert.equal(d.perf.bbn.label, 'BB-CORE news lab'); assert.equal(d.perf.bbn.expect.avg_r, 0.35);     // BB-Core 4h expectations
  assert.equal(d.perf.icn.label, 'I-CORE news lab'); assert.equal(d.perf.icn.expect.avg_r, 0.87);      // I-Core expectations
  assert.equal(d.perf.tcn.label, 'T-CORE news lab'); assert.equal(d.perf.tcn.expect.avg_r, 1.286);     // T-CORE lab expectations
  assert.equal(d.perf.bbcore.expect.avg_r, 0.35);                                                      // nobody else's profile changed
});

test('skips by the news gate are counted separately from the other skip reasons', () => {
  const now = ts + 2 * D;
  const events = [skip('tcn', 'SOL_USDT', ts, 'news_gate', 'blackout: CPI m/m in 2h'), skip('tcn', 'ZEC_USDT', ts + H, 'news_gate', 'hack on ZEC: x'), skip('tcn', 'ADA_USDT', ts + 2 * H, 'late_entry', '')];
  const d = aggregate({ events, newsHeartbeats: { tcn: hb('tcn', now - H) }, now, mode: 'paper' });
  const t = d.news_labs.tcn;
  assert.equal(t.skip_counts.news_gate, 2); assert.equal(t.skip_counts.late_entry, 1);
  assert.equal(t.news_skips.total, 2); assert.equal(t.news_skips.recent.length, 2);
  assert.ok(t.news_skips.recent.every((s) => s.reason === 'news_gate'));
});

test('the page lists the news labs, compares tcn with the T-CORE paper lab, and has a News Lab tab', () => {
  const app = fs.readFileSync(new URL('../bot-dashboard/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../bot-dashboard/index.html', import.meta.url), 'utf8');
  assert.match(app, /LABS = \['bb1h', 'bbn', 'icn', 'tcn'\]/);
  assert.match(app, /NEWS = \{ bbn: 'bbcore', icn: 'icore', tcn: 'bbtr' \}/);
  assert.match(app, /\['news', 'News Lab'\]/);
  assert.match(app, /'lab:news': \(\) => renderNewsLab\(\)/);
  assert.equal((html.match(/data-v="lab:news"/g) || []).length, 3);
  assert.match(html, /<script src="news-gate\.js"><\/script>\s*<script src="research\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  const bt = JSON.parse(fs.readFileSync(new URL('../bot-dashboard/news-lab-backtest.json', import.meta.url), 'utf8'));
  assert.equal(typeof bt.bots, 'object');                                                      // the placeholder (or the real result) has the shape the page reads
});

// ---------- the browser copy of the gate vs the module the bots and the backtest use
const NODE_GATE = new URL('../../StrategyBacktester/news-gate/news-gate.js', import.meta.url);
const haveNode = fs.existsSync(NODE_GATE);
const t0 = 1793000000;   // unix seconds
const FIXTURES = [
  { t: t0, coin: 'SOL', dir: 1, events: [{ name: 'CPI m/m', t: t0 + 2 * 3600 }], hacks: [] },                                      // CPI in 2h: blackout
  { t: t0, coin: 'SOL', dir: -1, events: [{ name: 'Non-Farm Employment Change', t: t0 - 3 * 3600 }], hacks: [] },                  // NFP 3h ago: blackout
  { t: t0, coin: 'ZEC', dir: 1, events: [{ name: 'ISM Services PMI', t: t0 + 3600 }], hacks: [] },                                 // not a blackout event
  { t: t0, coin: 'SOL', dir: 1, events: [{ name: 'FOMC Statement', t: t0 + 9 * 3600 }], hacks: [] },                               // too far ahead
  { t: t0, coin: 'SOL', dir: 1, events: [], hacks: [{ t: t0 - 10 * 3600, amount: 5e6, chains: ['Solana'], name: 'X' }] },          // hack on the coin's chain
  { t: t0, coin: 'SOL', dir: -1, events: [], hacks: [{ t: t0 - 10 * 3600, amount: 5e6, chains: ['Solana'], name: 'X' }] },         // shorts are not blocked by hacks
  { t: t0, coin: 'ADA', dir: 1, events: [], hacks: [{ t: t0 - 30 * 3600, amount: 2e8, chains: ['Ethereum'], name: 'Big' }] },      // $200M hack anywhere
  { t: t0, coin: 'ADA', dir: 1, events: [], hacks: [{ t: t0 - 60 * 3600, amount: 2e8, chains: ['Ethereum'], name: 'Old' }] },      // too old for a market-wide block
  { t: t0, coin: 'GALA', dir: 1, events: [], hacks: [{ t: t0 - 3600, amount: 2e6, chains: ['Ethereum'], name: 'Gala Games' }] },  // GALA by name
  { t: t0, coin: 'NEAR', dir: 1, events: [], hacks: [], fng: 90, btc: -7 },                                                        // F&G / crash rules on (cfg below)
  { t: t0, coin: 'NEAR', dir: -1, events: [], hacks: [], fng: 10, btc: 7 },
];
const CFGS = [null, { blackout: { on: true, preH: 2, postH: 2 }, fng: { on: true, mode: 'contrarian', lo: 20, hi: 80 }, crash: { on: true, pct: 5, action: 'skip' }, hack: { on: true, coinHours: 72, coinMinUsd: 1e6, marketHours: 48, marketMinUsd: 1e8 } },
  { blackout: { on: false }, fng: { on: true, mode: 'trend', lo: 20, hi: 80 }, crash: { on: true, pct: 5, action: 'half' }, hack: { on: false } }];

test('the dashboard\'s browser copy of the news gate gives the same verdicts as the bots\' module', { skip: !haveNode && 'StrategyBacktester is not next to this repo' }, () => {
  const nodeGate = require(NODE_GATE.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.deepEqual(browserGate.DEFAULTS, nodeGate.DEFAULTS);
  for (const cfg of CFGS) for (const f of FIXTURES) {
    const ctx = { t: f.t, coin: f.coin, dir: f.dir, events: f.events, hacks: f.hacks, fngAt: () => (f.fng ?? null), btcChange24h: f.btc ?? null };
    const a = cfg ? browserGate.gate(ctx, cfg) : browserGate.gate(ctx), b = cfg ? nodeGate.gate(ctx, cfg) : nodeGate.gate(ctx);
    assert.deepEqual(a, b, `${f.coin} ${f.dir} ${JSON.stringify(cfg)}`);
  }
});

test('the gate itself (chosen settings): no entry in the 8h before CPI / NFP / FOMC, none after a hack on the coin\'s chain (longs only), nothing else by default', () => {
  const g = (f) => browserGate.gate({ t: f.t, coin: f.coin, dir: f.dir, events: f.events, hacks: f.hacks, fngAt: () => (f.fng ?? null), btcChange24h: f.btc ?? null });
  assert.equal(g(FIXTURES[0]).allow, false); assert.match(g(FIXTURES[0]).reasons[0], /^blackout: CPI m\/m/);
  assert.equal(g(FIXTURES[1]).allow, true);                           // after the release: allowed (the blackout is only BEFORE)
  assert.equal(g(FIXTURES[2]).allow, true); assert.equal(g(FIXTURES[3]).allow, true);   // not a blackout event; FOMC 9h away is outside the 8h window
  assert.equal(g(FIXTURES[4]).allow, false); assert.equal(g(FIXTURES[5]).allow, true);
  assert.equal(g(FIXTURES[6]).allow, true); assert.equal(g(FIXTURES[7]).allow, true);   // the market-wide $100M hack rule is off in the chosen settings
  assert.equal(g(FIXTURES[8]).allow, false);
});

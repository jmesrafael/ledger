// The revamped bot dashboard: five pages (Overview, Live Bots, Research Lab, System Monitor, Settings), one workspace per live bot, paper bots kept apart,
// and every bot reporting its own status, log, skipped signals and uptime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregate } = require('../lib/aggregate.js');
const { createMemoryStore } = require('../lib/store.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const html = read('bot-dashboard/index.html'), app = read('bot-dashboard/app.js'), css = read('bot-dashboard/style.css');

const ts = 1793000000000, H = 3600e3;
const ev = (bot, type, id, at, mode, data, extra = {}) => ({ event_id: `${bot || 'bbcore'}|${id}`, type, ts_ms: at, mode, symbol: null, side: null, ...extra, data: { ...(bot ? { bot } : {}), ...data } });
const trade = (bot, mode, id, r) => [ev(bot, 'entry', id + 'e', ts, mode, { trade_id: id, entry: 100, sl: 95, risk_pct: 0.02 }, { symbol: 'SOL_USDT', side: 'LONG' }), ev(bot, 'exit', id + 'x', ts + 6 * H, mode, { trade_id: id, reason: 'stop', exit: 95, r, hold_sec: 6 * 3600 }, { symbol: 'SOL_USDT', side: 'LONG' }),
  ev(bot, 'signal', id + 's', ts + H, mode, { decision: 'skipped', reason: 'too late', detail: 'x', signal_candle_open_ms: ts }, { symbol: 'ADA_USDT', side: 'LONG' })];
const hb = (bot, at, mode, data = {}) => ev(bot, 'heartbeat', `hb${at}`, at, mode, { drawdown_r: 1, halt_r: -20, commit: 'abc', version: '1.0', uptime_sec: 99, next_wake_ms: at + 4 * H, last_candle_ms: { SOL_USDT: at - 4 * H }, enabled_coins: ['SOL'], ...data });
const beats = (mode) => [{ ts_ms: ts, mode, uptime: 10 }, { ts_ms: ts + 4 * H, mode, uptime: 14 * 3600 }, { ts_ms: ts + 12 * H, mode, uptime: 22 * 3600 }];
const now = ts + 13 * H;

test('BD1 five pages, no old seven tabs; every panel says where it lives and only in places that exist', () => {
  for (const p of ['overview', 'bots', 'lab', 'system', 'settings']) assert.ok(html.includes(`data-page="${p}"`), p);
  assert.ok(!/data-tab="/.test(html), 'the seven old tabs are gone');
  const valid = new Set(['overview', 'system', 'settings']);
  for (const k of ['dashboard', 'performance', 'trades', 'positions', 'verification', 'health']) valid.add(`bots:${k}`);
  for (const k of ['overview', 'performance', 'trades', 'research', 'market']) valid.add(`lab:${k}`);
  const where = [...html.matchAll(/data-v="([^"]+)"/g)].flatMap((m) => m[1].split(' '));
  assert.ok(where.length > 40);
  for (const w of where) assert.ok(valid.has(w), w);
  for (const v of valid) assert.ok(where.includes(v), `a panel for ${v}`);
});

test('BD2 no duplicated panels (the old Verify tab had two of each), and every element the script looks up exists', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(!ids.includes('checks2') && !ids.includes('compare2') && !ids.includes('pCheckList2') && !ids.includes('pCompare2'));
  const used = new Set([...app.matchAll(/\$\$?\('#([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  for (const id of used) assert.ok(ids.includes(id), `#${id} is in the page`);
});

test('BD3 a live bot is never a lab and a lab is never live: separate lists, live money only from live-mode bots', () => {
  assert.match(app, /const LIVE = \['bbcore', 'icore', 'tcore'\], LABS = \['bb1h'\];/);
  assert.ok(!/bbtr|T-CORE lab/.test(app.replace(/\/\/.*$/gm, '')), 'the T-CORE paper lab is gone from the page');
  assert.match(app, /const livePresent = \(\) => LIVE\.map\(bd\)\.filter\(\(b\) => b\.present && b\.mode === 'live'\);/);
  assert.match(app, /const live = tc\.parts\.filter\(\(p\) => p\.mode === 'live'\)/);
  for (const fn of ['renderOpenAll', 'renderLatest']) assert.ok(/LIVE\.map\(bd\)|livePresent\(\)/.test(app.slice(app.indexOf(`function ${fn}`), app.indexOf(`function ${fn}`) + 900)), fn);
  // a missing bot is said to be missing, a missing figure is "Unavailable", never zero
  assert.match(app, /state: 'missing', label: 'MISSING'/); assert.match(app, /const na = \(why\) => el\('span', \{ class: 'na'/); assert.match(app, /'Unavailable'/);
  for (const s of ['healthy', 'stale', 'offline', 'missing']) assert.ok(css.includes(`.hchip.${s}`), s);
});

test('BD4 every bot reports its own status, log, skipped signals and uptime; BB-Core, I-Core and T-CORE are treated the same', () => {
  const events = [...trade(null, 'live', 'b1', -1), ...trade('icore', 'live', 'i1', -1), ...trade('tcore', 'live', 't1', 2), ...trade('bb1h', 'paper', 'h1', 1), ...trade('bbtr', 'paper', 'r1', 1),
    hb(null, now - H, 'live'), hb('icore', now - H, 'live'), hb('tcore', now - H, 'live'), hb('bb1h', now - H, 'paper'), hb('bbtr', now - H, 'paper')];
  const pick = (bot) => events.find((e) => e.event_id === `${bot || 'bbcore'}|hb${now - H}`);
  const d = aggregate({ events, heartbeat: pick(null), icoreHeartbeat: pick('icore'), tcoreHeartbeat: pick('tcore'), bb1hHeartbeat: pick('bb1h'), bbtrHeartbeat: pick('bbtr'), now, mode: 'live',
    beats: beats('live'), beatsBy: { icore: beats('live'), tcore: beats('live'), bb1h: beats('paper'), bbtr: beats('paper') } });
  for (const k of ['icore', 'tcore']) {
    const b = d.bots[k];
    assert.equal(b.status.commit, 'abc'); assert.deepEqual(Object.keys(b.status.last_candle_ms), ['SOL_USDT']); assert.equal(b.status.next_wake_ms, now - H + 4 * H);
    assert.ok(b.activity.some((a) => a.kind === 'exit'), k + ' log'); assert.equal(b.skipped.length, 1, k + ' skipped'); assert.ok(b.uptime && b.uptime.beats === 3, k + ' uptime');
    assert.equal(b.last_exit_ms, ts + 6 * H); assert.ok(Array.isArray(b.compares));
    assert.ok(d.perf[k] && d.perf[k].checks.length, k + ' has stop-and-review checks');
  }
  for (const k of ['bb1h', 'bbtr']) { assert.ok(d.labs[k].uptime && d.labs[k].uptime.beats === 3, k); assert.ok(d.labs[k].activity.length); }
  assert.ok(d.bots.bbcore.last_exit_ms && d.bots.bbcore.kill_switch === false && d.bots.bbcore.drawdown_r === 1, 'BB-Core has the same fields on its card');
  assert.ok(Array.isArray(d.compares), 'BB-Core recent comparison runs');
  assert.deepEqual(d.total_capital ? d.total_capital.parts.map((p) => p.label).filter((l) => /lab/i.test(l)) : [], [], 'paper bots never enter the live capital');
  assert.ok(d.bots.tcore.trend && d.labs.bbtr.trend, 'trend capture for T-CORE and its lab');
});

test('BD5 without T-CORE (it has never reported) the page still has its three live slots and says it is missing', () => {
  const events = [...trade(null, 'live', 'b1', -1), ...trade('icore', 'live', 'i1', -1), hb(null, now - H, 'live'), hb('icore', now - H, 'live')];
  const d = aggregate({ events, heartbeat: events[events.length - 2], icoreHeartbeat: events[events.length - 1], now, mode: 'live' });
  assert.equal(d.bots.tcore, undefined); assert.equal(d.perf.tcore, null);
  assert.match(app, /if \(!b\) return \{ key: k, \.\.\.meta, present: false/);
  assert.match(app, /LIVE\.map\(\(k\) => botCard\(bd\(k\), \{ open: true \}\)\)/, 'a card for each of the three, missing or not');
  const only = aggregate({ events: [...trade('tcore', 'live', 't1', 1), hb('tcore', now - H, 'live')], tcoreHeartbeat: hb('tcore', now - H, 'live'), now, mode: 'live' });
  assert.ok(only.bots && only.bots.tcore && only.bots.bbcore, 'T-CORE alone still builds the bot block (it used to need I-Core)');
});

test("BD6 the memory store answers each bot's own heartbeat history; the live store asks for the bot's tag", async () => {
  const s = createMemoryStore();
  await s.insert([hb(null, ts, 'live'), hb('tcore', ts + 1, 'live'), hb('tcore', ts + 2, 'live'), hb('icore', ts + 3, 'live')]);
  assert.equal((await s.heartbeats({ sinceMs: 0 })).length, 1); assert.equal((await s.heartbeats({ sinceMs: 0, bot: 'tcore' })).length, 2); assert.equal((await s.heartbeats({ sinceMs: 0, bot: 'icore' })).length, 1);
  assert.match(read('lib/store.js'), /type=eq\.heartbeat\$\{botQuery\(bot\)\}&ts_ms/);
  const api = read('api/data.js');
  assert.match(api, /\['icore', 'tcore', 'bb1h', 'bbtr'\]\.map\(\(b\) => cached\(`beats:\$\{b\}`/); assert.match(api, /const VERSION = 'perf-8'/);
});

test('BD7 settings keep every preference and its saved key; the System Monitor never invents server figures', () => {
  for (const k of ['bot.tz', 'bot.mode', 'bot.range', 'bot.chart', 'bot.period', 'bot.view', 'bot.calmetric', 'bot.theme', 'bot.lastCapital']) assert.ok(app.includes(`'${k}'`), k);
  for (const id of ['modeSeg', 'refreshBtn', 'logoutBtn', 'resetPrefs']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('data-tz="utc"') && html.includes('data-theme-set="dark"'));
  for (const what of ['CPU load now', 'Memory in use now', 'Running services', 'Disk free', 'Exchange API errors']) assert.ok(app.split('\n').some((ln) => ln.includes(`kv('${what}', `) && ln.includes('na(')), what + ' is Unavailable when the recorder did not report it, never a number');
  assert.ok(app.includes("kv('Server logs', na("), 'logs are never sent');
  assert.match(app, /fetch\('\/api\/vps'/); assert.match(read('api/vps.js'), /as_of: '2026-10-23'/);   // the specs are a dated snapshot, shown as such
  assert.match(html, /<h1>Bot dashboard<\/h1>/); assert.match(html, /id="backBtn"/);
});

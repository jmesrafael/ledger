// Bot dashboard, Total capital: it comes from the bots' wallet reports (the real MEXC balances, every 5 minutes) and is never left blank. The server side is tested for
// real (aggregate + memory store); the browser page is a script with no test runner, so its wiring is checked in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { aggregate } = require('../lib/aggregate.js');
const { createMemoryStore } = require('../lib/store.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const now = Date.UTC(2026, 9, 28, 14, 0, 0);
const wal = (o) => ({ wallet: 'bbcore', label: 'BB-Core', equity_usdt: 201.35, open_positions: 2, received_ms: now - 120000, suspect: false, ...o });

test('D1 two wallets reported: Total capital is their sum, oldest and newest report times, open trades counted', () => {
  const d = aggregate({ now, wallets: [wal({}), wal({ wallet: 'icore', label: 'I-Core', equity_usdt: 49.983, open_positions: 0, received_ms: now - 30000 })] });
  const wc = d.wallet_capital;
  assert.equal(wc.usd, 251.33); assert.equal(wc.parts.length, 2); assert.deepEqual(wc.missing, []);
  assert.equal(wc.as_of, now - 120000); assert.equal(wc.newest_ms, now - 30000); assert.equal(wc.open, 2);
  assert.equal(wc.parts[1].usd, 49.98); assert.equal(wc.parts[0].age_ms, 120000);
});

test('D2 a wallet that never reported is listed as missing and not counted; nothing reported means no figure, never a zero', () => {
  const d = aggregate({ now, wallets: [wal({}), wal({ wallet: 'icore', label: 'I-Core', equity_usdt: null, received_ms: null, open_positions: null })] });
  assert.equal(d.wallet_capital.usd, 201.35); assert.deepEqual(d.wallet_capital.missing, ['I-Core']);
  assert.equal(aggregate({ now, wallets: [wal({ equity_usdt: null, received_ms: null })] }).wallet_capital, null);
  assert.equal(aggregate({ now, wallets: [] }).wallet_capital, null);
  assert.equal(aggregate({ now }).wallet_capital, null);
  assert.equal(aggregate({ now, wallets: [{ wallet: 'x', label: 'X', equity_usdt: 'abc', received_ms: now }] }).wallet_capital, null);
});

test('D3 the rest of the report is unchanged by wallets (a bot with no balance events still has capital null; the wallets fill the gap)', () => {
  const a = aggregate({ now }), b = aggregate({ now, wallets: [wal({})] });
  assert.equal(a.capital, null); assert.equal(b.capital, null); assert.equal(b.wallet_capital.usd, 201.35);
  for (const k of ['open', 'trades', 'overall', 'status', 'total_capital']) assert.deepEqual(a[k], b[k], k);
});

test('D4 the memory store returns what it was given, as copies', async () => {
  const s = createMemoryStore(); assert.deepEqual(await s.wallets(), []);
  s.setWallets([wal({})]); const got = await s.wallets(); got[0].equity_usdt = 1;
  assert.equal((await s.wallets())[0].equity_usdt, 201.35);
});

test('D5 the API asks the store for the wallets, tolerates a failure, and passes them on', () => {
  const api = read('api/data.js');
  assert.match(api, /store\.wallets \? store\.wallets\(\) : Promise\.resolve\(null\)\)\.catch\(\(\) => null\)/);
  assert.match(api, /aggregate\(\{ events, heartbeat, icoreHeartbeat, beats, flows, wallets, walletHist, now,/);
  const st = read('lib/store.js');
  assert.match(st, /wallet_snapshots\?select=wallet,received_at,equity_usdt,open_positions,suspect,accepted_at&order=id\.desc/);
  assert.match(st, /bot_wallets\?select=wallet,label,active/);
});

test('D6 the page prefers the wallet reports, remembers the last good total and keeps it when a report has none or a refresh fails', () => {
  const app = read('bot-dashboard/app.js');
  assert.match(app, /wc = d\.wallet_capital/); assert.match(app, /if \(wc\) \{/);
  assert.match(app, /MEXC reports/); assert.match(app, /has not reported, not counted/); assert.match(app, /the VPS has not reported for a while/);
  assert.match(app, /const LAST_CAP = 'bot\.lastCapital'/); assert.match(app, /rememberCapital\(wc\.usd/); assert.match(app, /else if \(lastCapital\(\)\)/); assert.match(app, /last known, /);
  // a partial or paper total is never remembered as if it were the whole
  assert.match(app, /if \(!wc\.missing\.length\) rememberCapital/); assert.match(app, /if \(!tc\.missing\.length && !tc\.paper\.length\) rememberCapital/);
  // a failed refresh keeps the page; only a first load with no data falls back to the login screen
  assert.match(app, /if \(data\) \{ kept = true;/); assert.match(app, /else showLogin\(`Could not load data:/);
  assert.match(app, /if \(!kept\) \$\('#promptCmd'\)/);
});

test('D7 the bot dashboard has a back button to the ledger (its sign-in is kept by the ledger, so it opens signed in)', () => {
  const html = read('bot-dashboard/index.html'), css = read('bot-dashboard/style.css');
  assert.match(html, /<a class="icon-btn back-btn" id="backBtn" href="\/login" title="Back to the ledger" aria-label="Back to the ledger">/);
  assert.ok(html.indexOf('id="backBtn"') < html.indexOf('<h1>Bot dashboard</h1>'), 'it sits before the title');
  assert.ok(css.includes('.back-btn {'));
  assert.match(read('vercel.json'), /"source": "\/login",\s*"destination": "\/login\.html"/);
  assert.match(read('js/app.js'), /const TOKEN_KEY = 'ledger\.token'/);
});

test('D8 the page can render: every list of elements it loops over is looked up with $$ (a single $ returns one element and broke the whole render after the chart)', () => {
  const app = read('bot-dashboard/app.js');
  assert.equal((app.match(/of \$\(/g) || []).length, 0, 'no "for (... of $(...))"');
  assert.match(app, /for \(const b of \$\$\('#chartTabs button'\)\)/); assert.match(app, /for \(const b of \$\$\('#rangeTabs button'\)\)/);
  assert.match(app, /console\.error\('bot dashboard: refresh failed', e\)/, 'a failed render is never silent');
});

test('D9 every visit opens on Overview; candle times are shown at the close; restarts are grouped per day and never styled by the loading screen', () => {
  const app = read('bot-dashboard/app.js'), css = read('bot-dashboard/style.css');
  assert.match(app, /const h = location\.hash\.slice\(1\), r = TABS\.includes\(h\) \? h : 'overview';/);
  assert.match(app, /const closeOf = \(v\) => v \+ CANDLE_MS;/); assert.match(app, /`closed \$\{fmtHm\(Math\.max\(\.\.\.candles\.map\(\(\[, v\]\) => closeOf\(v\)\)\)\)\}`/);
  assert.match(app, /restarts that day/); assert.ok(!/tag: 'boot'/.test(app));
  assert.match(css, /#boot\.boot \{/); assert.ok(!/^\.boot \{/m.test(css), 'the loading-screen style is scoped to its own element');
  assert.match(css, /\.log\.short \.ln \{ grid-template-columns: auto auto 1fr;/);
});

test('D10 live capital chart: both wallets added over time, only once every wallet has reported, thinned to at most 600 points', async () => {
  const { walletHistory } = require('../lib/aggregate.js');
  assert.deepEqual(walletHistory([]), []);
  const h = walletHistory([{ wallet: 'a', ts: 1, usd: 10 }, { wallet: 'b', ts: 2, usd: 5 }, { wallet: 'a', ts: 3, usd: 12 }]);
  assert.deepEqual(h, [{ ts: 2, usd: 15 }, { ts: 3, usd: 17 }], 'no point with one account alone');
  const many = []; for (let i = 0; i < 2000; i++) many.push({ wallet: i % 2 ? 'a' : 'b', ts: i, usd: 1 });
  const t = walletHistory(many); assert.ok(t.length <= 600); assert.equal(t[t.length - 1].ts, 1999);
  const d = aggregate({ now, walletHist: [{ wallet: 'a', ts: 1, usd: 10 }], flows: [{ flow_id: 'd:1', kind: 'deposit', ts_ms: 5, usdt: 200 }], mode: 'live' });
  assert.equal(d.wallet_history.length, 1); assert.deepEqual(d.capital_flows, [{ ts: 5, usd: 200, kind: 'deposit' }]);
  assert.match(read('api/data.js'), /store\.walletHistory\(\{ sinceMs: now - 7 \* 86400000 \}\)/);
});

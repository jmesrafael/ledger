// The public live track record: /api/track-record keeps only percent growth and activity counts, and the page /track-record shows only those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { makeHandler, clean } = require('../api/track-record.js');

const RAW = {
  daily: [['2026-10-28', '0.98257464682667441582', 'live', '0.96285980018', 0.98337], ['2026-10-24', 1, 'book', 0.5, 2], ['bad', 1, 'live'], ['2026-10-29', -1, 'live']],
  live: { price: '1.0020772167872090', at: '2026-11-13T07:15:03.892835+00:00' },
  open_positions: 14, bots_total: 3, bots_reporting: 3, trades: { closed: 17, wins: 3, losses: 14, realized_usd: -9.99 },
  generated_at: '2026-11-13T07:16:25Z',
  // things that must never reach the public, even if the database function starts sending them
  equity_usdt: 394.2, units: 393.4, investors: [{ name: 'x', usdt: 100 }], wallets: [{ wallet: 'bbcore', equity_usdt: 201 }],
};

test('clean keeps only the whitelisted fields, sorted and rounded', () => {
  const c = clean(RAW, Date.UTC(2026, 10, 13));
  assert.deepEqual(Object.keys(c).sort(), ['daily', 'generated_at', 'live', 'open_positions', 'trades']);
  assert.deepEqual(c.daily, [['2026-10-24', 1, 'book', null, null], ['2026-10-28', 0.982575, 'live', 0.96286, 0.98337]], 'bad rows dropped, sorted by day, 6 decimals, day range only on live days');
  assert.deepEqual(c.live, { price: 1.002077, at: '2026-11-13T07:15:03.892Z' });
  assert.deepEqual(c.trades, { closed: 17, wins: 3, losses: 14 }, 'no money in the trade counts');
  assert.equal(c.open_positions, 14);
  const s = JSON.stringify(c);
  for (const bad of ['equity', 'usdt', 'units', 'investor', 'wallet', 'bbcore', 'realized', 'bot']) assert.ok(!s.includes(bad), bad + ' must not leak');
});

test('clean survives an empty or broken answer', () => {
  const c = clean(null);
  assert.deepEqual(c.daily, []);
  assert.equal(c.live, null);
  assert.equal(c.open_positions, null);
  assert.deepEqual(c.trades, { closed: null, wins: null, losses: null });
});

function fakeRes() {
  return { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } };
}

test('handler: GET only, cached for a minute, keeps the last good answer when the read fails', async () => {
  let t = 0, reads = 0, fail = false;
  const h = makeHandler({ clock: () => t, read: async () => { reads++; if (fail) throw new Error('down'); return RAW; } });
  const req = (method = 'GET') => ({ method, headers: {}, socket: { remoteAddress: '1.2.3.' + method.length } });

  let res = fakeRes(); await h(req('POST'), res); assert.equal(res.statusCode, 405);
  res = fakeRes(); await h(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.open_positions, 14);
  assert.match(res.headers['Cache-Control'], /s-maxage=60/);
  res = fakeRes(); await h(req(), res); assert.equal(reads, 1, 'second call inside a minute uses the memo');
  t = 61000; fail = true;
  res = fakeRes(); await h(req(), res);
  assert.equal(res.statusCode, 200, 'a failed read keeps the last good answer');
  assert.equal(reads, 2);
});

test('handler: 502 when the very first read fails', async () => {
  const h = makeHandler({ read: async () => { throw new Error('down'); } });
  const res = fakeRes(); await h({ method: 'GET', headers: {}, socket: { remoteAddress: '9.9.9.9' } }, res);
  assert.equal(res.statusCode, 502);
});

// the live section of the landing page (section 2): its HTML and its script
const landing = readFileSync(new URL('../reports/how-lucid-io-works-v2.html', import.meta.url), 'utf8');
const sec2 = landing.slice(landing.indexOf('<!-- 2. LIVE EXAMPLES'), landing.indexOf('<!-- 3. BACKTESTING DATA -->'));
const js2 = landing.slice(landing.indexOf('// ---------- 2. LIVE examples'), landing.indexOf('// ---------- 3. the test on past prices'));

test('landing, live section: says it is live, not a backtest, and shows the live counts', () => {
  assert.ok(sec2.length > 1000 && js2.length > 1000, 'section 2 found');
  assert.ok(/LIVE trading, not a backtest/.test(sec2));
  assert.ok(/actual percentage growth/.test(sec2) && /updates live/.test(sec2), 'says the growth is the pool\'s real, live percent');
  assert.ok(!sec2.includes('neg-lead') && !/went below|below what they put in/.test(sec2 + js2), 'no per-investor below-zero story: the facts come from the curve');
  for (const id of ['pc-facts', 'lv-growth', 'lv-total', 'lv-closed', 'lv-open', 'pchart', 'ftable', 'y-amt', 'y-date']) assert.ok(sec2.includes(`id="${id}"`), id);
  assert.ok(js2.includes("fetch('/api/track-record'"));
});

test('landing, live section: no fees, no bots, no private numbers', () => {
  assert.ok(!/\bfees?\b/i.test(sec2 + js2), 'the live examples say nothing about fees');
  assert.ok(!/\bbots?\b|BB-Core|I-Core|T-CORE/i.test(sec2), 'the live section never mentions bots');
  const saved = js2.slice(js2.indexOf('const LIVE_SAVED'), js2.indexOf('const FRIENDS'));
  for (const bad of ['equity', 'usdt', 'units', 'investor', 'wallet']) assert.ok(!saved.toLowerCase().includes(bad), bad + ' must not be in the saved copy');
});

test('landing: the hero button goes to the live section; no separate page any more', () => {
  assert.ok(/<a class="btn" href="#friends">[^<]*<span class="cta-dot"[^>]*><\/span>See how your money moves/.test(landing));
  assert.ok(!landing.includes('href="/track-record"'));
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(!v.rewrites.some((r) => r.source === '/track-record'));
  const sql = readFileSync(new URL('../supabase/migrations/20261216000000_public_track_record.sql', import.meta.url), 'utf8');
  assert.ok(/revoke all on function public\.public_track_record\(\) from public, anon, authenticated/.test(sql), 'the browser cannot call the function directly');
});

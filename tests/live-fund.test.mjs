// The Fund dashboard's live capital card: js/livefund.js maths (the same as the bot dashboard's "Live capital" chart) and /api/fund-live (fund manager only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const LF = require('../js/livefund.js');
const { makeHandler, build } = require('../api/fund-live.js');

const H = 36e5, now = Date.UTC(2026, 10, 12, 12);
// $215 for a week, a $171 deposit lands 5 days ago (recorded 30 min before the balances show it), then trading adds $50
const wh = [];
for (let t = now - 8 * 24 * H; t <= now; t += H) wh.push({ ts: t, usd: t < now - 5 * 24 * H ? 215 : t < now - 2 * 24 * H ? 386 : 436 });
const flows = [{ ts: now - 5 * 24 * H - 0.5 * H, usd: 171, kind: 'deposit' }];
const live = { wallet_capital: { usd: 436, parts: [], missing: [], newest_ms: now }, wallet_history: wh, capital_flows: flows };

test('capital view: the deposit is a step, not trading gain', () => {
  const v = LF.view(live, '1W', 'capital', now);
  assert.equal(v.pts[0].ts, now - 7 * 24 * H);
  assert.equal(v.pts[0].y, 215);
  assert.equal(v.flowSum, 171);
  assert.equal(v.marks.length, 1);
  assert.equal(Math.round(v.change * 100) / 100, 50);
  assert.equal(Math.round(LF.changePct(v) * 1e4) / 1e4, Math.round((50 / 215) * 1e4) / 1e4);
  assert.equal(v.now, 436);
});

test('trading-only view: starts at 0, the deposit taken out at the jump it made', () => {
  const v = LF.view(live, '1W', 'trading', now);
  assert.equal(v.pts[0].y, 0);
  assert.ok(v.pts.every((p) => p.y === 0 || p.y === 50), 'only the trading gain moves the line');
  assert.equal(v.change, 50);
  assert.equal(v.marks.length, 0);
});

test('a range with no flow inside it and the 1D range', () => {
  const v = LF.view(live, '1D', 'capital', now);
  assert.equal(v.flowSum, 0);
  assert.equal(v.change, 0);
  assert.equal(LF.view({ wallet_history: wh.slice(0, 1) }, '1W', 'capital', now), null, 'one report is not a chart');
});

test('the chart html carries the capital step label', () => {
  const v = LF.view(live, '1W', 'capital', now);
  const g = LF.svg(v, { axis: (n) => `$${n}`, when: () => 'd' });
  assert.match(g.html, /\+\$171 capital/);
  assert.match(g.html, /id="lfc"/);
});

test('the app loads livefund.js before app.js', () => {
  const html = readFileSync(new URL('../login.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/livefund.js') > 0 && html.indexOf('js/livefund.js') < html.indexOf('js/app.js'));
});

// a fake request / response for the Vercel handler
function call(handler, body, headers = {}) {
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: { host: 'x', ...headers }, socket: { remoteAddress: '1.2.3.4' }, on(ev, fn) { if (ev === 'data') fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); return req; } };
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null }); } };
    handler(req, res);
  });
}
const store = { wallets: async () => [{ wallet: 'bbcore', label: 'BB-CORE', equity_usdt: 200, received_ms: now }, { wallet: 'icore', label: 'I-CORE', equity_usdt: 236, received_ms: now }],
  walletHistory: async () => [{ wallet: 'bbcore', ts: now - H, usd: 190 }, { wallet: 'icore', ts: now - H + 5000, usd: 230 }, { wallet: 'bbcore', ts: now, usd: 200 }, { wallet: 'icore', ts: now + 5000, usd: 236 }],
  flows: async () => [{ flow_id: 1, kind: 'deposit', ts_ms: now - 2 * H, usdt: 79.01 }] };

test('/api/fund-live: fund manager only', async () => {
  const roles = { admin: { role: 'admin' }, inv: { role: 'investor' }, view: { role: 'admin', impersonated: true } };
  const h = makeHandler({ check: async (t) => roles[t.slice(0, -8)] || null, storeOf: () => store });
  assert.equal((await call(h, { token: 'inv' + 'x'.repeat(8) })).status, 403);
  assert.equal((await call(h, { token: 'view' + 'x'.repeat(8) })).status, 403);
  assert.equal((await call(h, { token: 'nobody' + 'x'.repeat(8) })).status, 403);
  assert.equal((await call(h, { token: 'short' })).status, 400);
  assert.equal((await call(h, { token: 'admin' + 'x'.repeat(8) }, { origin: 'https://evil.example' })).status, 403);
  const ok = await call(h, { token: 'admin' + 'x'.repeat(8) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.wallet_capital.usd, 436);
  assert.deepEqual(ok.body.wallet_history.map((p) => p.usd), [420, 436]);
  assert.deepEqual(ok.body.capital_flows, [{ ts: now - 2 * H, usd: 79.01, kind: 'deposit' }]);
});

test('build() drops zero and broken flows', () => {
  const b = build({ wallets: [], walletHist: [], flows: [{ ts_ms: 1, usdt: 0 }, { ts_ms: 'x', usdt: 5 }, { ts_ms: 2, usdt: -10.004, kind: 'payout' }], now });
  assert.equal(b.wallet_capital, null);
  assert.deepEqual(b.capital_flows, [{ ts: 2, usd: -10, kind: 'payout' }]);
});

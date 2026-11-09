// The monthly Telegram report: live bots only, per-bot Trades / Result / Drawdown, a summary of all the accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { monthlyReport, monthlyText, viewsFrom, previousMonth } = require('../lib/monthly.js');
const { aggregate } = require('../lib/aggregate.js');
const handler = require('../api/monthly-report.js');

const D = (day, h = 12) => Date.UTC(2026, 9, day, h);   // October 2026
const t = (day, r, usd) => ({ exit_ts: D(day), r, usd });
const view = (key, label, mode, trades, start) => ({ key, label, mode, trades, capital: start == null ? null : { points: [{ ts: D(1, 0) - 1000, usd: start }] } });

test('previous month, and only closed trades inside the month count', () => {
  assert.equal(previousMonth(Date.UTC(2026, 10, 1, 7)), '2026-10');
  assert.equal(previousMonth(Date.UTC(2027, 0, 1, 7)), '2026-12');
  const rep = monthlyReport([view('bbcore', 'BB-CORE', 'live', [{ exit_ts: Date.UTC(2026, 8, 30, 23), r: 9, usd: 90 }, t(2, 1, 10), { exit_ts: Date.UTC(2026, 10, 1, 0), r: 9, usd: 90 }], 500)], '2026-10');
  assert.equal(rep.bots[0].trades, 1);
  assert.equal(rep.bots[0].r, 1);
});

test('paper bots are left out', () => {
  const rep = monthlyReport([view('bbcore', 'BB-CORE', 'live', [t(2, 1, 10)], 500), view('tcore', 'T-CORE', 'paper', [t(3, 5, 50)], 500)], '2026-10');
  assert.deepEqual(rep.bots.map((b) => b.label), ['BB-CORE']);
  assert.ok(!monthlyText(rep).includes('T-CORE'));
});

test('the message shows the three lines per bot and the summary with R, % and dollars', () => {
  const bb = [t(2, 2, 20), t(5, -1, -10), t(8, 3.8, 38.2), t(12, -1.2, -12)];            // drawdown 1.2R / $12 after the peak
  const ic = [t(3, -1, -10), t(9, -1.4, -14), t(15, 1.8, 17.9)];                          // worst fall 2.4R / $24
  const rep = monthlyReport([view('bbcore', 'BB-CORE', 'live', bb, 500), view('icore', 'I-CORE', 'live', ic, 500)], '2026-10');
  const text = monthlyText(rep);
  assert.match(text, /MONTHLY REPORT · October 2026/);
  assert.match(text, /BB-CORE/); assert.match(text, /I-CORE/);
  assert.match(text, /Trades\s+4/);
  assert.match(text, /Result\s+\+3\.6R {2}\(\+\$36\.20\)/);
  assert.match(text, /Drawdown\s+-1\.2R {2}\(-\$12\.00\)/);
  assert.match(text, /Drawdown\s+-2\.4R {2}\(-\$24\.00\)/);
  assert.match(text, /7 trades · win 43%/);
  assert.match(text, /Result\s+\+3\.0R {2}\(\+3\.0%\) {2}\+\$30\.10/);   // 30.10 / 1000
  assert.match(text, /Worst DD\s+-2\.6R {2}\(-2\.6%\) {2}-\$26\.00/);
  assert.match(text, /Best\s+BB-CORE\s+\+3\.6R/);
  assert.match(text, /Worst\s+I-CORE\s+-0\.6R/);
});

test('a negative bot and a bot with no trades are written clearly; no balance means no % (never a guess)', () => {
  const rep = monthlyReport([view('bbcore', 'BB-CORE', 'live', [], null), view('icore', 'I-CORE', 'live', [t(4, -0.6, -6.1)], null)], '2026-10');
  const text = monthlyText(rep);
  assert.match(text, /Trades\s+0/); assert.match(text, /Result\s+0\.0R {2}\(\$0\.00\)/); assert.match(text, /Drawdown\s+0\.0R/);
  assert.match(text, /Result\s+-0\.6R {2}\(-\$6\.10\)/);
  assert.ok(!/%\)/.test(text.split('SUMMARY')[1]), 'no % without every start balance');
});

test('trades without a dollar figure show the R only', () => {
  const rep = monthlyReport([view('bbcore', 'BB-CORE', 'live', [t(2, 1, null)], 500)], '2026-10');
  assert.match(monthlyText(rep), /Result\s+\+1\.0R\n/);
});

test('it reads the live bots out of aggregate()', () => {
  const ev = (bot, type, id, at, data, extra = {}) => ({ event_id: `${bot}|${id}`, type, ts_ms: at, mode: 'live', ...extra, data: { bot, ...data } });
  const trade = (bot, id, t0, t1, r) => [ev(bot, 'entry', id + 'e', t0, { trade_id: id, entry: 100, sl: 95, risk_pct: 0.025 }, { symbol: 'SOL_USDT', side: 'SHORT' }),
    ev(bot, 'exit', id + 'x', t1, { trade_id: id, reason: 'stop', exit: 95, r, hold_sec: 3600 }, { symbol: 'SOL_USDT', side: 'SHORT' })];
  const events = [...trade('icore', 'a', D(2), D(3), -1), ...trade('tcore', 'b', D(4), D(5), 2),
    { ...ev(undefined, 'heartbeat', 'hb', D(20), { drawdown_r: 0, halt_r: -45 }), data: { drawdown_r: 0, halt_r: -45 } },
    ev('icore', 'heartbeat', 'hbi', D(20), {}), ev('tcore', 'heartbeat', 'hbt', D(20), {})];
  const hb = (bot) => events.find((e) => e.type === 'heartbeat' && (e.data.bot || undefined) === bot);
  const agg = aggregate({ events, heartbeat: hb(undefined), icoreHeartbeat: hb('icore'), tcoreHeartbeat: hb('tcore'), now: D(25) });
  const rep = monthlyReport(viewsFrom(agg), '2026-10');
  const by = Object.fromEntries(rep.bots.map((b) => [b.key, b]));
  assert.equal(by.icore.r, -1); assert.equal(by.tcore.r, 2);
  assert.equal(rep.total.trades, 2);
});

test('the endpoint refuses without the cron secret and sends nothing on a dry run', async () => {
  const res = () => { const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } }; return r; };
  delete process.env.CRON_SECRET;
  let r = res(); await handler({ headers: {}, url: '/api/monthly-report' }, r); assert.equal(r.statusCode, 503);
  process.env.CRON_SECRET = 'cron-secret-for-test';
  r = res(); await handler({ headers: { authorization: 'Bearer wrong' }, url: '/api/monthly-report' }, r); assert.equal(r.statusCode, 401);
  const posts = [];
  const ok = await handler.sendTelegram('hi <b>x</b>', { token: 'TOKEN', chatId: '1', fetchImpl: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { ok: true }; } });
  assert.equal(ok, true); assert.match(posts[0][0], /\/botTOKEN\/sendMessage$/); assert.equal(posts[0][1].parse_mode, 'HTML');
  delete process.env.CRON_SECRET;
});

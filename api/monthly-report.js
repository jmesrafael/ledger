// GET /api/monthly-report - sends the monthly Telegram report (one message: BB-CORE, I-CORE, T-CORE and a summary of the live accounts). Called by Vercel Cron on the
// 1st of each month (vercel.json "crons"), which sends  Authorization: Bearer <CRON_SECRET>.  ?month=YYYY-MM picks another month (default: the month that just ended),
// ?dry=1 returns the text and sends nothing.
// Env: CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. The token is never put in a reply or an error.
'use strict';
const crypto = require('crypto');
const { createSupabaseStore } = require('../lib/store.js');
const { aggregate } = require('../lib/aggregate.js');
const { monthlyReport, monthlyText, viewsFrom, previousMonth } = require('../lib/monthly.js');
const { send } = require('../lib/http.js');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function sendTelegram(text, { token, chatId, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) });
  return res.ok;
}

async function build(store, month, now) {
  const [tradeEvs, equity, heartbeat, icoreHeartbeat, tcoreHeartbeat, closedTrades] = await Promise.all([
    store.tradeEvents(), store.equityEvents ? store.equityEvents() : [],
    store.latestHeartbeat(), store.latestHeartbeat({ bot: 'icore' }).catch(() => null), store.latestHeartbeat({ bot: 'tcore' }).catch(() => null),
    store.closedTrades ? store.closedTrades().catch(() => []) : []]);
  const agg = aggregate({ events: tradeEvs.concat(equity), heartbeat, icoreHeartbeat, tcoreHeartbeat, closedTrades, now });
  return monthlyReport(viewsFrom(agg), month);
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return send(res, 503, { error: 'CRON_SECRET is not set' });
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!same(given, secret)) return send(res, 401, { error: 'unauthorized' });
  try {
    const now = Date.now(), u = new URL(req.url, 'http://x'), q = u.searchParams.get('month');
    const month = q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : previousMonth(now), dry = u.searchParams.get('dry') === '1';
    const store = createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const text = monthlyText(await build(store, month, now));
    if (dry) return send(res, 200, { month, sent: false, text });
    const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return send(res, 503, { error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set', month });
    const ok = await sendTelegram(text, { token, chatId }).catch(() => false);
    return send(res, ok ? 200 : 502, { month, sent: ok });
  } catch { return send(res, 502, { error: 'report failed' }); }
};

module.exports.sendTelegram = sendTelegram;
module.exports.build = build;

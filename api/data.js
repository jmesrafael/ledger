// GET /api/data[?mode=paper|live] - everything the page shows. Needs the session cookie from /api/login (401 otherwise).
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Light on the database as well: one answer is reused for 10 s (several tabs or devices share it), the slow-moving parts are remembered (equity 60 s, uptime history 5 min,
// wallet history 3 min), and the trade events are read in full only once; after that only what arrived since (a few rows). ?fresh=1 skips the 10 s reuse (Refresh, Ask bot now).
// A failed read keeps the last good value instead of failing the page.
// ETag: a short fingerprint of what the answer is built from (newest event, heartbeats, flows, alive/stale). The page sends it back as If-None-Match and gets
// 304 with no body when nothing changed, so a page left open re-downloads and redraws nothing between the bot's reports.
'use strict';
const crypto = require('crypto');
const { makeAuth } = require('../lib/auth.js');
const { createSupabaseStore } = require('../lib/store.js');
const { aggregate, STALE_MS } = require('../lib/aggregate.js');
const { send } = require('../lib/http.js');

const VERSION = 'perf-2';   // change it when aggregate() output changes shape, so every open page reloads once
let store = null;

function fingerprint({ mode, events, equity, heartbeat, icoreHeartbeat, beats, flows, wallets, walletHist, now }) {
  const newest = (list) => (list || []).reduce((m, e) => Math.max(m, +e.ts_ms || 0), 0);
  const alive = (hb) => (hb ? (now - hb.ts_ms <= STALE_MS ? 'a' : `s${Math.floor(now / 60000)}`) : '-');   // a stale bot's "no heartbeat for x" grows each minute
  const key = [VERSION, mode || '', events.length, newest(events), (equity || []).length, newest(equity), heartbeat ? heartbeat.ts_ms : 0, alive(heartbeat),
    icoreHeartbeat ? icoreHeartbeat.ts_ms : 0, alive(icoreHeartbeat), (beats || []).length, (flows || []).length, newest((flows || []).map((f) => ({ ts_ms: f.ts_ms }))),
    (wallets || []).map((w) => `${w.wallet}:${w.received_ms}:${w.equity_usdt}`).join(','), (walletHist || []).length, (walletHist || []).reduce((m, w) => Math.max(m, +w.ts || 0), 0)].join('|');
  return `"${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}"`;
}

const TTL = { response: 10000, equity: 60000, flows: 60000, wallets: 15000, beats: 300000, walletHist: 180000, fullEvents: 1800000 };
const OVERLAP_MS = 120000;
const memo = new Map(), respCache = new Map(), trades = { rows: new Map(), hw: 0, fullAt: 0 };

// remember fn()'s answer for ttl ms; one read at a time per key (concurrent requests share it); on an error the last good value is kept
function cached(key, ttl, fn) {
  let m = memo.get(key); if (!m) memo.set(key, (m = { at: 0, has: false, value: null, p: null }));
  if (m.has && Date.now() - m.at < ttl) return Promise.resolve(m.value);
  if (m.p) return m.p;
  m.p = fn().then((v) => { m.value = v; m.has = true; m.at = Date.now(); return v; }, (e) => { if (m.has) return m.value; throw e; }).finally(() => { m.p = null; });
  return m.p;
}

// every entry / exit / skipped signal / comparison: all of it once (and again every 30 minutes as a safety net), then only the rows the database received since the last read
async function tradeEvents() {
  const now = Date.now();
  if (!store.tradeEvents) return store.recent({ limit: 5000 });
  if (!trades.hw || now - trades.fullAt > TTL.fullEvents) {
    const rows = await store.tradeEvents();
    trades.rows = new Map(rows.map((r) => [r.event_id, r])); trades.fullAt = now;
    trades.hw = rows.reduce((m, r) => Math.max(m, +r.received_ms || 0), 0);
  } else {
    const fresh = await store.tradeEvents({ sinceMs: trades.hw - OVERLAP_MS });
    for (const r of fresh) { trades.rows.set(r.event_id, r); trades.hw = Math.max(trades.hw, +r.received_ms || 0); }
  }
  return [...trades.rows.values()].sort((a, b) => a.ts_ms - b.ts_ms);
}

function reply(req, res, etag, body) {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
  res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(body);
}

module.exports = async (req, res) => {
  const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
  if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!auth.verifyToken(auth.fromCookie(req.headers.cookie))) return send(res, 401, { error: 'login required' });
  try {
    store = store || createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const u = new URL(req.url, 'http://x'), q = u.searchParams.get('mode'), mode = q === 'paper' || q === 'live' ? q : null, fresh = u.searchParams.get('fresh') === '1';
    const hit = respCache.get(mode || 'auto');
    if (!fresh && hit && Date.now() - hit.at < TTL.response) return reply(req, res, hit.etag, hit.body);
    const now = Date.now();
    // heartbeat history only feeds the uptime panel: if it fails, the rest of the page still loads
    // capital movements come from the ledger's capital_flows view; before that migration exists they are simply absent
    const [tradeEvs, equity, heartbeat, icoreHeartbeat, beats, flows, wallets, walletHist] = await Promise.all([
      tradeEvents(), cached('equity', TTL.equity, () => (store.equityEvents ? store.equityEvents() : Promise.resolve([]))),
      store.latestHeartbeat(), store.latestHeartbeat({ bot: 'icore' }).catch(() => null),
      cached('beats', TTL.beats, () => store.heartbeats({ sinceMs: now - 7 * 86400000 })).catch(() => null),
      cached('flows', TTL.flows, () => (store.flows ? store.flows() : Promise.resolve([]))).catch(() => []),
      // the bots' 5-minute wallet reports: the real balance of each trading account (absent before the wallet tables exist)
      cached('wallets', TTL.wallets, () => (store.wallets ? store.wallets() : Promise.resolve(null))).catch(() => null),
      cached('walletHist', TTL.walletHist, () => (store.walletHistory ? store.walletHistory({ sinceMs: now - 7 * 86400000 }) : Promise.resolve(null))).catch(() => null)]);
    const events = tradeEvs.concat(equity);
    const etag = fingerprint({ mode, events: tradeEvs, equity, heartbeat, icoreHeartbeat, beats, flows, wallets, walletHist, now });
    const body = req.headers['if-none-match'] === etag ? '' : JSON.stringify(aggregate({ events, heartbeat, icoreHeartbeat, beats, flows, wallets, walletHist, now, mode }));
    if (body) respCache.set(mode || 'auto', { at: Date.now(), etag, body });
    else { const h = respCache.get(mode || 'auto'); if (h && h.etag === etag) h.at = Date.now(); }
    reply(req, res, etag, body);
  } catch { send(res, 502, { error: 'store unavailable' }); }
};

module.exports.fingerprint = fingerprint;
module.exports._cached = cached;
module.exports._reset = () => { memo.clear(); respCache.clear(); trades.rows = new Map(); trades.hw = 0; trades.fullAt = 0; store = null; };

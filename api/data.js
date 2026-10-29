// GET /api/data[?mode=paper|live] - everything the page shows. Needs the session cookie from /api/login (401 otherwise).
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ETag: a short fingerprint of what the answer is built from (newest event, heartbeats, flows, alive/stale). The page sends it back as If-None-Match and gets
// 304 with no body when nothing changed, so a page left open re-downloads and redraws nothing between the bot's reports.
'use strict';
const crypto = require('crypto');
const { makeAuth } = require('../lib/auth.js');
const { createSupabaseStore } = require('../lib/store.js');
const { aggregate, STALE_MS } = require('../lib/aggregate.js');
const { send } = require('../lib/http.js');

const VERSION = 'perf-1';   // change it when aggregate() output changes shape, so every open page reloads once
let store = null;

function fingerprint({ mode, events, equity, heartbeat, icoreHeartbeat, beats, flows, now }) {
  const newest = (list) => (list || []).reduce((m, e) => Math.max(m, +e.ts_ms || 0), 0);
  const alive = (hb) => (hb ? (now - hb.ts_ms <= STALE_MS ? 'a' : `s${Math.floor(now / 60000)}`) : '-');   // a stale bot's "no heartbeat for x" grows each minute
  const key = [VERSION, mode || '', events.length, newest(events), (equity || []).length, newest(equity), heartbeat ? heartbeat.ts_ms : 0, alive(heartbeat),
    icoreHeartbeat ? icoreHeartbeat.ts_ms : 0, alive(icoreHeartbeat), (beats || []).length, (flows || []).length, newest((flows || []).map((f) => ({ ts_ms: f.ts_ms })))].join('|');
  return `"${crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)}"`;
}

module.exports = async (req, res) => {
  const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
  if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!auth.verifyToken(auth.fromCookie(req.headers.cookie))) return send(res, 401, { error: 'login required' });
  try {
    store = store || createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const q = new URL(req.url, 'http://x').searchParams.get('mode'), mode = q === 'paper' || q === 'live' ? q : null;
    const now = Date.now();
    // heartbeat history only feeds the uptime panel: if it fails, the rest of the page still loads
    // capital movements come from the ledger's capital_flows view; before that migration exists they are simply absent
    const [tradeEvs, equity, heartbeat, icoreHeartbeat, beats, flows] = await Promise.all([
      store.tradeEvents ? store.tradeEvents() : store.recent({ limit: 5000 }), store.equityEvents ? store.equityEvents() : Promise.resolve([]),
      store.latestHeartbeat(), store.latestHeartbeat({ bot: 'icore' }).catch(() => null), store.heartbeats({ sinceMs: now - 7 * 86400000 }).catch(() => null),
      (store.flows ? store.flows() : Promise.resolve([])).catch(() => [])]);
    const events = tradeEvs.concat(equity);
    const etag = fingerprint({ mode, events: tradeEvs, equity, heartbeat, icoreHeartbeat, beats, flows, now });
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
    send(res, 200, aggregate({ events, heartbeat, icoreHeartbeat, beats, flows, now, mode }));
  } catch { send(res, 502, { error: 'store unavailable' }); }
};

module.exports.fingerprint = fingerprint;

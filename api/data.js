// GET /api/data[?mode=paper|live] - everything the page shows. Needs the session cookie from /api/login (401 otherwise).
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
'use strict';
const { makeAuth } = require('../lib/auth.js');
const { createSupabaseStore } = require('../lib/store.js');
const { aggregate } = require('../lib/aggregate.js');
const { send } = require('../lib/http.js');

let store = null;

module.exports = async (req, res) => {
  const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
  if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!auth.verifyToken(auth.fromCookie(req.headers.cookie))) return send(res, 401, { error: 'login required' });
  try {
    store = store || createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const mode = new URL(req.url, 'http://x').searchParams.get('mode');
    const now = Date.now();
    // heartbeat history only feeds the uptime panel: if it fails, the rest of the page still loads
    // capital movements come from the ledger's capital_flows view; before that migration exists they are simply absent
    const [events, heartbeat, icoreHeartbeat, beats, flows, wallets] = await Promise.all([store.recent({ limit: 5000 }), store.latestHeartbeat(), store.latestHeartbeat({ bot: 'icore' }).catch(() => null), store.heartbeats({ sinceMs: now - 7 * 86400000 }).catch(() => null), (store.flows ? store.flows() : Promise.resolve([])).catch(() => []), (store.wallets ? store.wallets() : Promise.resolve(null)).catch(() => null)]);
    send(res, 200, aggregate({ events, heartbeat, icoreHeartbeat, beats, flows, wallets, now, mode: mode === 'paper' || mode === 'live' ? mode : null }));
  } catch { send(res, 502, { error: 'store unavailable' }); }
};

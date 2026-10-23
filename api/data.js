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
    const [events, heartbeat] = await Promise.all([store.recent({ limit: 5000 }), store.latestHeartbeat()]);
    send(res, 200, aggregate({ events, heartbeat, now: Date.now(), mode: mode === 'paper' || mode === 'live' ? mode : null }));
  } catch { send(res, 502, { error: 'store unavailable' }); }
};

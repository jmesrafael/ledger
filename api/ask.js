// POST /api/ask {mode?} - the "Ask bot now" button. Needs the session cookie from /api/login. Logic: lib/commands.js.
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
'use strict';
const { makeAuth } = require('../lib/auth.js');
const { createSupabaseStore } = require('../lib/store.js');
const { createLimiter } = require('../lib/ratelimit.js');
const { handleAsk } = require('../lib/commands.js');
const { readRaw, send, clientIp } = require('../lib/http.js');

const limiter = createLimiter({ max: 6, windowMs: 60 * 1000 });
let store = null;

module.exports = async (req, res) => {
  const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
  if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
  try {
    store = store || createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    let mode = 'paper'; if (req.method === 'POST') { try { mode = JSON.parse(await readRaw(req, 1024)).mode; } catch {} }
    const out = await handleAsk({ method: req.method, authOk: auth.verifyToken(auth.fromCookie(req.headers.cookie)), store, limiter, ip: clientIp(req), mode });
    send(res, out.status, out.body);
  } catch { send(res, 500, { error: 'server error' }); }
};

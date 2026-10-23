// POST /api/admin-enter {token} -> the dashboard session cookie, WITHOUT the dashboard password, but only for a signed-in fund manager.
// `token` is the Ledger session token of the person who clicked "Bot dashboard" on the Ledger's admin side. It is checked by the Ledger's own
// database function my_summary(): it must be a live session of an active profile with role 'admin' and not a "view as" session.
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET (same as /api/login), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
'use strict';
const { makeAuth } = require('../lib/auth.js');
const { createLimiter } = require('../lib/ratelimit.js');
const { readRaw, send, clientIp } = require('../lib/http.js');

const limiter = createLimiter({ max: 20, windowMs: 5 * 60 * 1000 });

// null = not a valid session (the database refuses with a 4xx); throws when the database itself cannot be reached
async function summaryOf(token, fetchImpl = fetch) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('supabase not configured');
  const r = await fetchImpl(`${base}/rest/v1/rpc/my_summary`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }), signal: AbortSignal.timeout(8000),
  });
  if (r.status >= 500) throw new Error(`supabase ${r.status}`);
  return r.ok ? r.json() : null;
}

function makeHandler(fetchImpl = fetch) {
  return async (req, res) => {
    const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
    if (!limiter.take(`enter:${clientIp(req)}`)) return send(res, 429, { error: 'too many attempts, wait a few minutes' });
    const origin = req.headers.origin;
    try { if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'same-origin only' }); } catch { return send(res, 403, { error: 'same-origin only' }); }
    let body = {};
    try { body = JSON.parse(await readRaw(req, 2048)); } catch { return send(res, 400, { error: 'send {"token": "..."}' }); }
    const token = body && typeof body.token === 'string' ? body.token : '';
    if (token.length < 8 || token.length > 512) return send(res, 400, { error: 'send {"token": "..."}' });
    let me;
    try { me = await summaryOf(token, fetchImpl); } catch { return send(res, 502, { error: 'could not check the session' }); }
    if (!me || me.role !== 'admin' || me.impersonated === true) return send(res, 403, { error: 'fund manager only' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.issue()) });
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;

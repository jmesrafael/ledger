// POST /api/login {password} -> signed session cookie.   DELETE /api/login -> log out.
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET (16+ random characters). Without them the dashboard stays locked (503), never open.
'use strict';
const { makeAuth } = require('../lib/auth.js');
const { createLimiter } = require('../lib/ratelimit.js');
const { readRaw, send, clientIp } = require('../lib/http.js');

const limiter = createLimiter({ max: 8, windowMs: 5 * 60 * 1000 });   // 8 password tries per 5 minutes per IP (per serverless instance)

module.exports = async (req, res) => {
  const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
  if (req.method === 'DELETE') return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
  if (!limiter.take(`login:${clientIp(req)}`)) return send(res, 429, { error: 'too many attempts, wait a few minutes' });
  let body = {};
  try { body = JSON.parse(await readRaw(req, 2048)); } catch { return send(res, 400, { error: 'send {"password": "..."}' }); }
  if (!auth.checkPassword(body && body.password)) return send(res, 401, { error: 'wrong password' });
  return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.issue()) });
};

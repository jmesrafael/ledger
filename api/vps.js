// GET /api/vps - the specs of the server the bot runs on (a one-time record, edit the numbers below if you resize the plan).
// Needs the session cookie from /api/login (401 otherwise). Deliberately no IP address, hostname or credentials here.
// Env: DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET
'use strict';
const { makeAuth } = require('../lib/auth.js');
const { send } = require('../lib/http.js');

const SPECS = {
  as_of: '2026-10-23',
  provider: 'Webdock',
  location: 'Denmark',
  os: 'Ubuntu 24.04.5 LTS',
  kernel: '6.8.0-142-generic',
  arch: 'x86_64',
  cpu: { model: 'Intel Xeon Gold 6230R', clock: '2.10 GHz', vcpu: 1 },
  ram: { total_gb: 1.6, used_gb: 0.34 },
  disk: { total_gb: 15, used_gb: 2.4, used_pct: 17, mount: '/' },
  booted: '2026-10-23T11:14:05Z',
  bot_limits: { soft: '300 MB', hard: '450 MB' },
};

module.exports = async (req, res) => {
  const auth = makeAuth({ password: process.env.DASHBOARD_PASSWORD, sessionSecret: process.env.DASHBOARD_SESSION_SECRET });
  if (!auth.configured()) return send(res, 503, { error: 'dashboard login is not configured on the server' });
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!auth.verifyToken(auth.fromCookie(req.headers.cookie))) return send(res, 401, { error: 'login required' });
  send(res, 200, SPECS);
};

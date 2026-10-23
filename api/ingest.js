// POST /api/ingest - signed events from the bot on the VPS. All logic is in lib/ingest.js (tested); this file only wires Vercel to it.
// Env (Vercel project settings, never in the repo): DASHBOARD_PUSH_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
'use strict';
const { handleIngest, MAX_BYTES } = require('../lib/ingest.js');
const { createSupabaseStore } = require('../lib/store.js');
const { createLimiter } = require('../lib/ratelimit.js');
const { readRaw, send, clientIp } = require('../lib/http.js');

const limiter = createLimiter({ max: 120, windowMs: 60 * 1000 });
let store = null;

module.exports = async (req, res) => {
  try {
    store = store || createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    // the body is read from the stream and never through req.body: the signature covers the exact bytes the bot sent
    const rawBody = req.method === 'POST' ? await readRaw(req, MAX_BYTES) : null;
    const out = await handleIngest({ method: req.method, headers: req.headers, rawBody, secret: process.env.DASHBOARD_PUSH_SECRET, store, limiter, ip: clientIp(req) });
    send(res, out.status, out.body);
  } catch (e) { send(res, e.code === 'TOO_LARGE' ? 413 : 500, { error: e.code === 'TOO_LARGE' ? 'body too large' : 'server error' }); }
};

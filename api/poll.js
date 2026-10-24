// GET /api/poll - the bot asks "did anyone click Ask bot now?". Signed like /api/ingest (empty body). Answers {ask:true|false}, nothing else. Logic: lib/commands.js.
// Env: DASHBOARD_PUSH_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
'use strict';
const { createSupabaseStore } = require('../lib/store.js');
const { createLimiter } = require('../lib/ratelimit.js');
const { handlePoll } = require('../lib/commands.js');
const { send, clientIp } = require('../lib/http.js');

const limiter = createLimiter({ max: 120, windowMs: 60 * 1000 });
let store = null;

module.exports = async (req, res) => {
  try {
    store = store || createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const out = await handlePoll({ method: req.method, headers: req.headers, secret: process.env.DASHBOARD_PUSH_SECRET, store, limiter, ip: clientIp(req) });
    send(res, out.status, out.body);
  } catch { send(res, 500, { error: 'server error' }); }
};

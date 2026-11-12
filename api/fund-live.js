// POST /api/fund-live {token} -> the fund's live capital, for the Ledger's Fund dashboard: the same wallet reports the bot dashboard's "Live capital" chart is built from.
// `token` is the Ledger session of a signed-in fund manager (checked by my_summary(), exactly like /api/admin-enter; a "view as" session is refused). Investors never get this.
// Answer: { wallet_capital, wallet_history, capital_flows } with the shapes of lib/aggregate.js (wallet_capital / wallet_history) and capital_flows as { ts, usd, kind }.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. The reads are remembered like /api/data (wallets 15 s, history 3 min, flows 60 s); a failed read keeps the last good value.
'use strict';
const { createSupabaseStore } = require('../lib/store.js');
const { walletCapital, walletHistory } = require('../lib/aggregate.js');
const { createLimiter } = require('../lib/ratelimit.js');
const { readRaw, send, clientIp } = require('../lib/http.js');
const { summaryOf } = require('./admin-enter.js');

const limiter = createLimiter({ max: 60, windowMs: 5 * 60 * 1000 });   // the page asks once a minute while it is open
const TTL = { wallets: 15000, walletHist: 180000, flows: 60000 };
const memo = new Map();
let store = null;

function cached(key, ttl, fn) {
  let m = memo.get(key); if (!m) memo.set(key, (m = { at: 0, has: false, value: null, p: null }));
  if (m.has && Date.now() - m.at < ttl) return Promise.resolve(m.value);
  if (m.p) return m.p;
  m.p = fn().then((v) => { m.value = v; m.has = true; m.at = Date.now(); return v; }, (e) => { if (m.has) return m.value; throw e; }).finally(() => { m.p = null; });
  return m.p;
}

// what the page is sent, from the raw reads (kept apart so the tests can check it without a database)
function build({ wallets, walletHist, flows, now = Date.now() }) {
  return {
    wallet_capital: walletCapital(wallets, now), wallet_history: walletHistory(walletHist),
    capital_flows: (flows || []).filter((f) => f && Number.isFinite(+f.ts_ms) && Number.isFinite(+f.usdt) && +f.usdt !== 0).map((f) => ({ ts: +f.ts_ms, usd: Math.round(+f.usdt * 100) / 100, kind: f.kind })),
    generated_at: now,
  };
}

function makeHandler({ check = summaryOf, storeOf = () => createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }) } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!limiter.take(`fund:${clientIp(req)}`)) return send(res, 429, { error: 'too many requests, wait a few minutes' });
    const origin = req.headers.origin;
    try { if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'same-origin only' }); } catch { return send(res, 403, { error: 'same-origin only' }); }
    let body = {};
    try { body = JSON.parse(await readRaw(req, 2048)); } catch { return send(res, 400, { error: 'send {"token": "..."}' }); }
    const token = body && typeof body.token === 'string' ? body.token : '';
    if (token.length < 8 || token.length > 512) return send(res, 400, { error: 'send {"token": "..."}' });
    let me;
    try { me = await check(token); } catch { return send(res, 502, { error: 'could not check the session' }); }
    if (!me || me.role !== 'admin' || me.impersonated === true) return send(res, 403, { error: 'fund manager only' });
    try {
      store = store || storeOf();
      const now = Date.now();
      const [wallets, walletHist, flows] = await Promise.all([
        cached('wallets', TTL.wallets, () => store.wallets()),
        cached('walletHist', TTL.walletHist, () => store.walletHistory({ sinceMs: now - 30 * 86400000, now })),
        cached('flows', TTL.flows, () => store.flows()).catch(() => [])]);
      return send(res, 200, build({ wallets, walletHist, flows, now }));
    } catch { return send(res, 502, { error: 'store unavailable' }); }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.build = build;
module.exports._reset = () => { memo.clear(); store = null; };

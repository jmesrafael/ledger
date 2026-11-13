// GET /api/track-record -> the public track record for /track-record (no sign-in): percent growth of the pool and live activity counts only.
// Reads public.public_track_record() (migration 20261216000000_public_track_record.sql) with the service role, then keeps ONLY the allowed fields (clean()),
// so a USDT amount, a unit count, an investor, a wallet or bot name, or how many bots there are can never reach the page even if the database function changes.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. One database read per minute at most (memo + CDN cache); a failed read keeps the last good answer.
'use strict';
const { createLimiter } = require('../lib/ratelimit.js');
const { send, clientIp } = require('../lib/http.js');

const TTL = 60000;
const limiter = createLimiter({ max: 120, windowMs: 5 * 60 * 1000 });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
const count = (v) => { const n = num(v); return n === null || n < 0 ? null : Math.round(n); };
const price = (v) => { const n = num(v); return n === null || n <= 0 ? null : Math.round(n * 1e6) / 1e6; };

// the whitelist: everything the public may see
function clean(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const daily = (Array.isArray(r.daily) ? r.daily : [])
    .filter((d) => Array.isArray(d) && DAY_RE.test(String(d[0])) && price(d[1]) !== null)
    .map((d) => {   // [day, price at day end, source, day low, day high]; the range is kept only when it makes sense around the day-end price
      const p = price(d[1]), lo = price(d[3]), hi = price(d[4]), ok = d[2] === 'live' && lo !== null && hi !== null && lo <= p && p <= hi;
      return [String(d[0]), p, d[2] === 'live' ? 'live' : 'book', ok ? lo : null, ok ? hi : null];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const liveAt = r.live && Date.parse(r.live.at);
  const live = r.live && price(r.live.price) !== null && Number.isFinite(liveAt) ? { price: price(r.live.price), at: new Date(liveAt).toISOString() } : null;
  const t = r.trades && typeof r.trades === 'object' ? r.trades : {};
  return {
    daily, live,
    open_positions: count(r.open_positions),
    trades: { closed: count(t.closed), wins: count(t.wins), losses: count(t.losses) },
    generated_at: new Date(now).toISOString(),
  };
}

function supabaseRead({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl = fetch } = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  return async () => {
    const res = await fetchImpl(`${base}/rest/v1/rpc/public_track_record`, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(8000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`store HTTP ${res.status}`);
    return res.json();
  };
}

function makeHandler({ read = supabaseRead(), ttl = TTL, clock = () => Date.now() } = {}) {
  const m = { at: 0, value: null, p: null };
  function get() {
    const now = clock();
    if (m.value && now - m.at < ttl) return Promise.resolve(m.value);
    if (m.p) return m.p;
    m.p = read().then((raw) => { m.value = clean(raw, clock()); m.at = clock(); return m.value; }, (e) => { if (m.value) return m.value; throw e; })
      .finally(() => { m.p = null; });
    return m.p;
  }
  return async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
    if (!limiter.take(`tr:${clientIp(req)}`)) return send(res, 429, { error: 'too many requests, wait a few minutes' });
    try {
      return send(res, 200, await get(), { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' });
    } catch { return send(res, 502, { error: 'track record unavailable' }); }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.clean = clean;

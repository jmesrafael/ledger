// ratelimit.js - small in-memory sliding-window limiter. On Vercel every serverless instance has its own memory, so this is a per-instance
// brake against floods and password guessing, not a global quota (the HMAC check is the real gate for /api/ingest; /api/login also needs this).
'use strict';

function createLimiter({ max, windowMs }) {
  const hits = new Map();   // key -> [timestamps]
  return {
    // true = allowed (and counted), false = over the limit
    take(key, now = Date.now()) {
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) { hits.set(key, arr); return false; }
      arr.push(now); hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);   // keep memory bounded
      return true;
    },
    reset() { hits.clear(); },
  };
}

module.exports = { createLimiter };

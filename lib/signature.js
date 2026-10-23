// signature.js - HMAC-SHA256 request signing shared by the bot (dashboard-push.js signs) and the Vercel route (api/ingest.js verifies).
//   signature = hex HMAC-SHA256(secret, `${timestampMs}.${rawBody}`)      headers: X-Lucidio-Timestamp (ms), X-Lucidio-Signature (hex)
'use strict';
const crypto = require('crypto');

const MAX_SKEW_MS = 5 * 60 * 1000;
const sign = (secret, tsMs, rawBody) => crypto.createHmac('sha256', secret).update(`${tsMs}.${rawBody}`).digest('hex');

// constant-time comparison of two hex strings of any length (a length mismatch is just "false", without an early exit on content)
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  const len = Math.max(x.length, y.length, 1), px = Buffer.alloc(len), py = Buffer.alloc(len);
  x.copy(px); y.copy(py);
  return crypto.timingSafeEqual(px, py) && x.length === y.length;
}

// returns { ok: true } or { ok: false, status, error }
function verify({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, status: 503, error: 'server has no push secret configured' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !/^\d{10,16}$/.test(String(timestamp))) return { ok: false, status: 401, error: 'bad timestamp' };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, status: 401, error: 'stale timestamp (more than 5 minutes off; check the VPS clock)' };
  if (!safeEqualHex(sign(secret, ts, rawBody), signature)) return { ok: false, status: 401, error: 'bad signature' };
  return { ok: true };
}

module.exports = { sign, verify, safeEqualHex, MAX_SKEW_MS };

// auth.js - the password gate for the dashboard pages and /api/data. A password (env DASHBOARD_PASSWORD) is exchanged at /api/login for a signed,
// HttpOnly, Secure, SameSite=Strict cookie that expires; there is no user table and nothing sensitive in the cookie.
// (You can ALSO switch on Vercel Authentication for the project; this gate does not depend on it.)
'use strict';
const crypto = require('crypto');
const { safeEqualHex } = require('./signature.js');

const COOKIE = 'lucidio_session';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function makeAuth({ password, sessionSecret, ttlSec = 12 * 3600 }) {
  const sigOf = (payload) => crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
  return {
    configured: () => !!(password && sessionSecret && String(sessionSecret).length >= 16),
    checkPassword: (pw) => crypto.timingSafeEqual(sha(pw ?? ''), sha(password ?? '')),      // hash both: equal length, constant time
    issue(now = Date.now()) { const payload = `v1.${now + ttlSec * 1000}`; return `${payload}.${sigOf(payload)}`; },
    verifyToken(token, now = Date.now()) {
      const m = /^(v1)\.(\d{10,16})\.([0-9a-f]{64})$/.exec(String(token || ''));
      return !!m && Number(m[2]) > now && safeEqualHex(sigOf(`${m[1]}.${m[2]}`), m[3]);
    },
    fromCookie(header) { for (const part of String(header || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === COOKIE) return v.join('=') || null; } return null; },
    cookie: (token) => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ttlSec}`,
    clearCookie: () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    ttlSec,
  };
}

module.exports = { makeAuth, COOKIE };

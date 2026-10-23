// http.js - tiny helpers for the Vercel functions (no framework): raw body reading with a hard size cap, JSON replies, client IP.
'use strict';

// reads the raw request body (needed byte-for-byte for the HMAC) and refuses anything larger than `limit` bytes
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { const e = new Error('body too large'); e.code = 'TOO_LARGE'; reject(e); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
const clientIp = (req) => String((req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown')).split(',')[0].trim();

module.exports = { readRaw, send, clientIp };

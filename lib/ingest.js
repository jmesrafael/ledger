// ingest.js - the whole logic of POST /api/ingest as a pure function (api/ingest.js is a thin Vercel wrapper), so it is fully testable.
// Order of checks: method -> rate limit -> body size -> HMAC signature + 5-minute timestamp window -> JSON -> schema (symbols!) -> store (dedupe on event_id).
'use strict';
const { verify } = require('./signature.js');
const { validateBody } = require('./schema.js');

const MAX_BYTES = 64 * 1024;
const resp = (status, body) => ({ status, body });

async function handleIngest({ method, headers = {}, rawBody, now = Date.now(), secret, store, limiter = null, ip = 'unknown', maxBytes = MAX_BYTES }) {
  if (method !== 'POST') return resp(405, { error: 'POST only' });
  if (limiter && !limiter.take(`ingest:${ip}`, now)) return resp(429, { error: 'rate limited' });
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody) > maxBytes) return resp(413, { error: `body must be a string of at most ${maxBytes} bytes` });
  const v = verify({ secret, timestamp: headers['x-lucidio-timestamp'], signature: headers['x-lucidio-signature'], rawBody, now });
  if (!v.ok) return resp(v.status, { error: v.error });
  let body; try { body = JSON.parse(rawBody); } catch { return resp(400, { error: 'invalid JSON' }); }
  const r = validateBody(body);
  if (!r.ok) return resp(400, { error: 'schema', details: r.errors });
  try { const out = await store.insert(r.events); return resp(200, { ok: true, accepted: out.inserted, duplicates: out.duplicates }); }
  catch { return resp(502, { error: 'store unavailable' }); }      // the bot keeps the events queued and retries
}

module.exports = { handleIngest, MAX_BYTES };

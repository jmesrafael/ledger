// commands.js - "Ask bot now": the dashboard button (cookie-protected) leaves a request, the bot (signed GET, outbound from the VPS) collects it and answers with a heartbeat.
// Pure functions like lib/ingest.js, so they are fully testable; api/ask.js and api/poll.js are thin wrappers. The bot never receives a connection: it asks.
'use strict';
const { verify } = require('./signature.js');

const ASK_WINDOW_MS = 15 * 60 * 1000;         // a request nobody collected for 15 minutes is stale (bot offline): it is ignored and a new click starts a fresh one
const resp = (status, body) => ({ status, body });

// POST /api/ask (session cookie already checked by the wrapper -> authOk). One pending request at a time: a second click just reports the first.
async function handleAsk({ method, authOk, store, limiter = null, ip = 'unknown', now = Date.now(), mode = 'paper' }) {
  if (method !== 'POST') return resp(405, { error: 'POST only' });
  if (!authOk) return resp(401, { error: 'login required' });
  if (limiter && !limiter.take(`ask:${ip}`, now)) return resp(429, { error: 'too many requests, wait a minute' });
  try {
    const out = await store.ask({ now, mode: mode === 'live' ? 'live' : 'paper', windowMs: ASK_WINDOW_MS });
    return resp(200, { ok: true, requested_ms: out.requested_ms, already_pending: !!out.already_pending });
  } catch { return resp(502, { error: 'store unavailable' }); }
}

// GET /api/poll (signed with an empty body, same secret and headers as /api/ingest). -> { ask: true|false }. A request is handed out ONCE: claiming it marks it done.
async function handlePoll({ method, headers = {}, secret, store, limiter = null, ip = 'unknown', now = Date.now() }) {
  if (method !== 'GET') return resp(405, { error: 'GET only' });
  if (limiter && !limiter.take(`poll:${ip}`, now)) return resp(429, { error: 'rate limited' });
  const v = verify({ secret, timestamp: headers['x-lucidio-timestamp'], signature: headers['x-lucidio-signature'], rawBody: '', now });
  if (!v.ok) return resp(v.status, { error: v.error });
  try { const n = await store.claimAsk({ now, windowMs: ASK_WINDOW_MS }); return resp(200, { ask: n > 0 }); }
  catch { return resp(502, { error: 'store unavailable' }); }
}

module.exports = { handleAsk, handlePoll, ASK_WINDOW_MS };

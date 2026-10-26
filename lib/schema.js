// schema.js - validation of the events the bot pushes. Strict on the envelope (unknown keys, unknown symbols, wrong types are rejected),
// lenient on `data` (unknown keys are DROPPED, never stored). Only SOL_USDT, ZEC_USDT, NEAR_USDT and ADA_USDT exist as far as this dashboard is concerned.
'use strict';

const ALLOWED_SYMBOLS = ['SOL_USDT', 'ZEC_USDT', 'NEAR_USDT', 'ADA_USDT'];
const TYPES = ['heartbeat', 'signal', 'entry', 'exit', 'equity', 'compare'];
const MAX_EVENTS = 50, ID_RE = /^[A-Za-z0-9:_.\-|]{8,120}$/;

const num = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const str = (n) => (v) => v === null || (typeof v === 'string' && v.length <= n);
const bool = (v) => typeof v === 'boolean';
const symMap = (inner) => (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => ALLOWED_SYMBOLS.includes(k) && inner(v[k]));
const priceObj = (v) => v !== null && typeof v === 'object' && num(v.px) && num(v.candle_ms);
const arrOf = (n, each) => (v) => Array.isArray(v) && v.length <= n && v.every(each);
const mismatch = (v) => v !== null && typeof v === 'object' && (v.symbol == null || ALLOWED_SYMBOLS.includes(v.symbol)) && num(v.nearest_threshold_pct ?? null) && str(6)(v.side ?? null);

// data fields per event type: key -> validator
const DATA = {
  heartbeat: { status: str(20), last_candle_ms: symMap(num), kill_switch: bool, drawdown_r: num, halt_r: num, commit: str(12), version: str(20), uptime_sec: num, next_wake_ms: num, prices: symMap(priceObj), enabled_coins: arrOf(4, (s) => ALLOWED_SYMBOLS.includes(s)) },
  signal: { decision: (v) => v === 'entered' || v === 'skipped', reason: str(40), detail: str(200), signal_candle_open_ms: num, trade_id: str(80) },
  entry: { trade_id: str(80), signal_candle_open_ms: num, entry: num, intended_price: num, sl: num, tp: num, qty: num, contracts: num, risk_pct: num, one_r: num, slippage_r: num, delay_sec: num, nearest_threshold_pct: num, costs_kind: str(20), risk_usd: num, balance_used: num },
  exit: { trade_id: str(80), reason: str(20), exit: num, entry: num, r: num, hold_sec: num, exit_candle_open_ms: num, costs_kind: str(20), fees_pct_est: num, slippage_pct_est: num, funding_est: num, fees_r: num, usd: num, balance_after: num },
  equity: { total_r: num, peak_r: num, drawdown_r: num, trades: num, candle_ms: num, paper_balance: num, equity_usd: num },
  compare: { match: bool, window_from_ms: num, window_to_ms: num, tolerance_r: num, matched: num, live_only: num, backtest_only: num, skipped_signals: num, candle_diffs: num,
    mismatches: arrOf(20, (m) => mismatch(m) && num(m.signal_candle_open_ms) && str(160)(m.why) && str(30)(m.kind)) },
};
const NEEDS_SYMBOL = new Set(['signal', 'entry', 'exit']);
const ENVELOPE_KEYS = new Set(['event_id', 'type', 'ts_ms', 'mode', 'symbol', 'side', 'data']);

// one event -> { ok, event | errors }
function validateEvent(e) {
  const errors = [];
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return { ok: false, errors: ['event is not an object'] };
  for (const k of Object.keys(e)) if (!ENVELOPE_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  if (typeof e.event_id !== 'string' || !ID_RE.test(e.event_id)) errors.push('event_id must be 8-120 chars of [A-Za-z0-9:_.-|]');
  if (!TYPES.includes(e.type)) errors.push(`type must be one of ${TYPES.join(', ')}`);
  if (!Number.isInteger(e.ts_ms) || e.ts_ms < 1.5e12 || e.ts_ms > 4.1e12) errors.push('ts_ms must be a unix time in milliseconds');
  if (e.mode !== 'paper' && e.mode !== 'live') errors.push('mode must be paper or live');
  if (e.symbol !== undefined && !ALLOWED_SYMBOLS.includes(e.symbol)) errors.push(`symbol ${JSON.stringify(e.symbol)} is not allowed (only ${ALLOWED_SYMBOLS.join(', ')})`);
  if (NEEDS_SYMBOL.has(e.type) && e.symbol === undefined) errors.push(`${e.type} events need a symbol`);
  if (e.side !== undefined && e.side !== null && e.side !== 'LONG' && e.side !== 'SHORT') errors.push('side must be LONG or SHORT');
  if (e.data === null || typeof e.data !== 'object' || Array.isArray(e.data)) errors.push('data must be an object');
  if (errors.length) return { ok: false, errors };
  const spec = DATA[e.type], data = {};
  for (const [k, v] of Object.entries(e.data)) {
    if (!spec[k]) continue;                                   // unknown data keys are dropped, never stored
    if (!spec[k](v)) errors.push(`data.${k} has the wrong type or is too long`);
    else data[k] = v;
  }
  if (errors.length) return { ok: false, errors };
  // nested objects are rebuilt from whitelisted keys, so nothing extra can ride along inside them
  if (data.prices) { const p = {}; for (const [k, v] of Object.entries(data.prices)) p[k] = { px: v.px, candle_ms: v.candle_ms }; data.prices = p; }
  if (data.mismatches) data.mismatches = data.mismatches.map((m) => ({ kind: m.kind ?? null, symbol: m.symbol ?? null, side: m.side ?? null, signal_candle_open_ms: m.signal_candle_open_ms ?? null, why: m.why ?? null, nearest_threshold_pct: m.nearest_threshold_pct ?? null }));
  return { ok: true, event: { event_id: e.event_id, type: e.type, ts_ms: e.ts_ms, mode: e.mode, symbol: e.symbol ?? null, side: e.side ?? null, data } };
}

// the request body: { events: [...] } with 1..MAX_EVENTS events. Returns { ok, events } or { ok:false, errors }
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.events)) return { ok: false, errors: ['body must be {"events": [...]}'] };
  if (Object.keys(body).some((k) => k !== 'events')) return { ok: false, errors: ['unknown top-level field'] };
  if (!body.events.length || body.events.length > MAX_EVENTS) return { ok: false, errors: [`send 1 to ${MAX_EVENTS} events per request`] };
  const events = [], errors = [];
  body.events.forEach((e, i) => { const r = validateEvent(e); if (r.ok) events.push(r.event); else errors.push(`event ${i}: ${r.errors.join('; ')}`); });
  return errors.length ? { ok: false, errors: errors.slice(0, 5) } : { ok: true, events };
}

module.exports = { ALLOWED_SYMBOLS, TYPES, MAX_EVENTS, validateEvent, validateBody };

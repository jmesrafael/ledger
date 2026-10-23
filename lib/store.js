// store.js - where pushed events live. Two implementations with the same interface:
//   createSupabaseStore  Postgres through Supabase's REST API (the LEDGER project already uses Supabase), table bot_events, service-role key (Vercel env only)
//   createMemoryStore    for tests and local runs
// insert() de-duplicates on event_id (a repeated event is ignored, never stored twice).
'use strict';

function createMemoryStore() {
  const rows = new Map();
  return {
    async insert(events) {
      let inserted = 0;
      for (const e of events) if (!rows.has(e.event_id)) { rows.set(e.event_id, { ...e, received_at: Date.now() }); inserted++; }
      return { inserted, duplicates: events.length - inserted };
    },
    async recent({ limit = 5000 } = {}) { return [...rows.values()].filter((r) => r.type !== 'heartbeat').sort((a, b) => b.ts_ms - a.ts_ms).slice(0, limit); },
    async latestHeartbeat() { return [...rows.values()].filter((r) => r.type === 'heartbeat').sort((a, b) => b.ts_ms - a.ts_ms)[0] || null; },
    _rows: rows,
  };
}

function createSupabaseStore({ url, key, fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  const headers = (extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra });
  const COLS = 'event_id,type,ts_ms,mode,symbol,side,data';
  async function req(pathAndQuery, init) {
    const res = await fetchImpl(`${base}/rest/v1/${pathAndQuery}`, { ...init, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`store HTTP ${res.status}`);
    return res.json();
  }
  return {
    async insert(events) {
      const rows = events.map((e) => ({ event_id: e.event_id, type: e.type, ts_ms: e.ts_ms, mode: e.mode, symbol: e.symbol, side: e.side, data: e.data }));
      // on_conflict + ignore-duplicates: the response contains only the rows that were really inserted
      const out = await req('bot_events?on_conflict=event_id', { method: 'POST', headers: headers({ Prefer: 'resolution=ignore-duplicates,return=representation' }), body: JSON.stringify(rows) });
      return { inserted: out.length, duplicates: events.length - out.length };
    },
    recent: ({ limit = 5000 } = {}) => req(`bot_events?select=${COLS}&type=neq.heartbeat&order=ts_ms.desc&limit=${limit}`, { headers: headers() }),
    latestHeartbeat: async () => (await req(`bot_events?select=${COLS}&type=eq.heartbeat&order=ts_ms.desc&limit=1`, { headers: headers() }))[0] || null,
  };
}

module.exports = { createMemoryStore, createSupabaseStore };

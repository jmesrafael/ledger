// store.js - where pushed events live. Two implementations with the same interface:
//   createSupabaseStore  Postgres through Supabase's REST API (the LEDGER project already uses Supabase), table bot_events, service-role key (Vercel env only)
//   createMemoryStore    for tests and local runs
// insert() de-duplicates on event_id (a repeated event is ignored, never stored twice).
'use strict';

const botOf = (r) => (r.data && r.data.bot) || 'bbcore';                                   // rows without data.bot are BB-Core's
const botQuery = (bot) => (bot === 'icore' ? '&data->>bot=eq.icore' : '&data->>bot=is.null');   // PostgREST filter on the JSON tag

function createMemoryStore() {
  const rows = new Map(), flowRows = [], walletRows = [];
  return {
    async insert(events) {
      let inserted = 0;
      for (const e of events) if (!rows.has(e.event_id)) { rows.set(e.event_id, { ...e, received_at: Date.now() }); inserted++; }
      return { inserted, duplicates: events.length - inserted };
    },
    async ask({ now, mode, windowMs }) {
      const open = [...rows.values()].find((r) => r.type === 'ask' && now - r.ts_ms < windowMs);
      if (open) return { requested_ms: open.ts_ms, already_pending: true };
      rows.set(`ask:${now}`, { event_id: `ask:${now}`, type: 'ask', ts_ms: now, mode, symbol: null, side: null, data: {}, received_at: now });
      return { requested_ms: now, already_pending: false };
    },
    async claimAsk({ now, windowMs }) { let n = 0; for (const r of rows.values()) if (r.type === 'ask' && now - r.ts_ms < windowMs) { r.type = 'ask_done'; n++; } return n; },
    async recent({ limit = 5000 } = {}) { return [...rows.values()].filter((r) => r.type !== 'heartbeat' && r.type !== 'ask' && r.type !== 'ask_done').sort((a, b) => b.ts_ms - a.ts_ms).slice(0, limit); },
    async latestHeartbeat({ bot } = {}) { return [...rows.values()].filter((r) => r.type === 'heartbeat' && botOf(r) === (bot || 'bbcore')).sort((a, b) => b.ts_ms - a.ts_ms)[0] || null; },
    async heartbeats({ sinceMs = 0 } = {}) { return [...rows.values()].filter((r) => r.type === 'heartbeat' && botOf(r) === 'bbcore' && r.ts_ms >= sinceMs).sort((a, b) => a.ts_ms - b.ts_ms).map((r) => ({ ts_ms: r.ts_ms, mode: r.mode, uptime: r.data.uptime_sec ?? null })); },
    async flows() { return [...flowRows]; },
    setFlows(list) { flowRows.length = 0; flowRows.push(...list); },
    async wallets() { return walletRows.map((w) => ({ ...w })); },
    setWallets(list) { walletRows.length = 0; walletRows.push(...list); },
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
    // "Ask bot now": one pending request at a time; the bot claims it with a single UPDATE (type ask -> ask_done), so it is handed out once. Needs migration 20261113000000_bot_ask.sql.
    async ask({ now, mode, windowMs }) {
      const open = await req(`bot_events?select=ts_ms&type=eq.ask&ts_ms=gte.${Math.floor(now - windowMs)}&order=ts_ms.desc&limit=1`, { headers: headers() });
      if (open.length) return { requested_ms: +open[0].ts_ms, already_pending: true };
      await req('bot_events?on_conflict=event_id', { method: 'POST', headers: headers({ Prefer: 'resolution=ignore-duplicates,return=representation' }), body: JSON.stringify([{ event_id: `ask:${now}`, type: 'ask', ts_ms: now, mode, symbol: null, side: null, data: {} }]) });
      return { requested_ms: now, already_pending: false };
    },
    async claimAsk({ now, windowMs }) {
      const out = await req(`bot_events?type=eq.ask&ts_ms=gte.${Math.floor(now - windowMs)}`, { method: 'PATCH', headers: headers({ Prefer: 'return=representation' }), body: JSON.stringify({ type: 'ask_done' }) });
      return out.length;
    },
    recent: ({ limit = 5000 } = {}) => req(`bot_events?select=${COLS}&type=not.in.(heartbeat,ask,ask_done)&order=ts_ms.desc&limit=${limit}`, { headers: headers() }),
    latestHeartbeat: async ({ bot } = {}) => (await req(`bot_events?select=${COLS}&type=eq.heartbeat${botQuery(bot)}&order=ts_ms.desc&limit=1`, { headers: headers() }))[0] || null,
    // money in and out of the trading account, from the ledger's capital_flows view (no names). Empty when that view does not exist yet.
    flows: () => req('capital_flows?select=flow_id,kind,ts_ms,usdt&order=ts_ms.asc&limit=1000', { headers: headers() }),
    // the latest wallet report (equity of one trading account, sent every 5 minutes from the VPS) of every active wallet; a wallet that never reported has equity_usdt null.
    // Empty when the wallet tables do not exist yet.
    async wallets() {
      const [snaps, ws] = await Promise.all([
        req('wallet_snapshots?select=wallet,received_at,equity_usdt,open_positions,suspect,accepted_at&order=id.desc&limit=60', { headers: headers() }),
        req('bot_wallets?select=wallet,label,active&order=wallet.asc', { headers: headers() })]);
      const seen = new Set();
      return ws.filter((w) => w.active).map((w) => {
        const s = !seen.has(w.wallet) && snaps.find((x) => x.wallet === w.wallet); seen.add(w.wallet);
        return { wallet: w.wallet, label: w.label || w.wallet, equity_usdt: s ? +s.equity_usdt : null, open_positions: s ? s.open_positions : null,
          received_ms: s ? Date.parse(s.received_at) : null, suspect: !!(s && s.suspect && !s.accepted_at) };
      });
    },
    // only the time, mode and uptime counter of each heartbeat (about 288 a day); paged because the REST API returns at most 1000 rows per request
    async heartbeats({ sinceMs = 0, max = 3000 } = {}) {
      const out = [];
      for (let off = 0; off < max; off += 1000) {
        const page = await req(`bot_events?select=ts_ms,mode,uptime:data->uptime_sec&type=eq.heartbeat${botQuery()}&ts_ms=gte.${Math.floor(sinceMs)}&order=ts_ms.asc&limit=1000&offset=${off}`, { headers: headers() });
        out.push(...page);
        if (page.length < 1000) break;
      }
      return out;
    },
  };
}

module.exports = { createMemoryStore, createSupabaseStore };

// aggregate.js - turns the stored events into what the dashboard page shows. Pure: events in, plain JSON out (no clock unless `now` is given).
//   status    alive/stale banner (stale = no heartbeat for 4h20m, the same limit as the watchdog), mode, kill switch, drawdown vs the halt
//   open      positions with entry/SL/TP and the current R when a price is known (prices ride on the heartbeat: public candle closes)
//   trades    entry joined to exit (trade_id); every R total comes with its trade count
//   equity    cumulative R curve and drawdown (from closed trades, in exit order)
//   perCoin   trades, win rate, profit factor, average R, max drawdown (R), longest losing streak
//   skipped   skipped signals with reasons · compare: the latest live-vs-backtest result
//   capital   current balance (paper balance, or live equity only when the bot shares it), change since the first known balance excluding capital added or
//             removed (flows), balance curve + capital steps + a performance curve with the capital taken out, time-weighted return
//   uptime    from the heartbeat times of the last 7 days: gaps over 15 min (3 missed beats) are downtime, an uptime counter that drops is a restart
//   activity  the newest entries, exits, skips, candle checks and comparisons, newest first (the page shows them as a log)
'use strict';

const STALE_MS = (4 * 60 + 20) * 60 * 1000;
const UPTIME_WINDOW_MS = 7 * 86400000, GAP_MS = 15 * 60000;
const r2 = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r < 0);
  const gw = wins.reduce((a, t) => a + t.r, 0), gl = -losses.reduce((a, t) => a + t.r, 0), total = trades.reduce((a, t) => a + t.r, 0);
  let eq = 0, peak = 0, maxDd = 0, streak = 0, longest = 0;
  for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); if (t.r <= 0) longest = Math.max(longest, ++streak); else streak = 0; }
  return { trades: n, wins: wins.length, win_rate: n ? r2(wins.length / n) : null, profit_factor: gl > 0 ? r2(gw / gl, 2) : n && gw > 0 ? 'inf' : null, avg_r: n ? r2(total / n) : null, total_r: r2(total, 2), max_dd_r: r2(maxDd, 2), longest_losing_streak: longest };
}

// money: equity events carry the balance every 4h candle, exits carry the balance after the trade. Null when neither was shared.
// flows: money that came into or left the trading account (capital_flows from the ledger: deposits when they join, payouts when sent). It is
// capital, not performance: it is taken out of "change since start", it never shows as a gain on the performance curve, and it never enters the
// per-trade statistics. Only the balance chart shows it, as labeled steps. flows = [{ flow_id, kind, ts_ms, usdt (+ in, - out) }].
function capital(evs, trades, flows) {
  const pts = [];
  for (const e of evs) {
    const usd = e.type === 'equity' ? (e.data.paper_balance ?? e.data.equity_usd) : e.type === 'exit' ? e.data.balance_after : null;
    if (usd != null && Number.isFinite(usd)) pts.push({ ts: e.ts_ms, usd: r2(usd, 2) });
  }
  if (!pts.length) return null;
  const firstEntry = evs.find((e) => e.type === 'entry' && e.data.balance_used != null);
  const startsBefore = firstEntry && firstEntry.ts_ms <= pts[0].ts;
  const start = startsBefore ? firstEntry.data.balance_used : pts[0].usd, startTs = startsBefore ? firstEntry.ts_ms : pts[0].ts, last = pts[pts.length - 1];
  const withUsd = trades.filter((t) => t.usd != null);
  const fl = (flows || []).filter((f) => f && Number.isFinite(+f.ts_ms) && Number.isFinite(+f.usdt) && +f.usdt !== 0)
    .map((f) => ({ flow_id: String(f.flow_id), kind: f.kind, ts: +f.ts_ms, usd: +f.usdt })).sort((a, b) => a.ts - b.ts);
  // a flow is already inside a balance reading taken after it, and is not yet inside one taken before it
  const flowsIn = (from, to) => fl.filter((f) => f.ts > from && f.ts <= to).reduce((a, f) => a + f.usd, 0);
  const net = flowsIn(startTs, last.ts);
  const change = last.usd - start - net;
  // balance with the capital movements taken out: starts at the start balance and moves only with trading
  const perf = pts.filter((p) => p.ts > startTs || p === pts[0]).map((p) => ({ ts: p.ts, usd: r2(p.usd - flowsIn(startTs, p.ts), 2) }));
  // time-weighted return: each interval's growth with the flows inside it removed, chained. A deposit never counts as a gain.
  const nodes = startTs < pts[0].ts ? [{ ts: startTs, usd: start }, ...pts] : pts;
  let twr = 1;
  for (let i = 1; i < nodes.length; i++) { const prev = nodes[i - 1]; if (prev.usd > 0) twr *= (nodes[i].usd - flowsIn(prev.ts, nodes[i].ts)) / prev.usd; }
  return { usd: last.usd, as_of: last.ts, start_usd: r2(start, 2), net_flows_usd: r2(net, 2), change_usd: r2(change, 2), change_pct: start ? r2((change / start) * 100, 2) : null,
    twr_pct: nodes.length > 1 ? r2((twr - 1) * 100, 2) : null, realized_usd: withUsd.length ? r2(withUsd.reduce((a, t) => a + t.usd, 0), 2) : null,
    points: pts.slice(-500), perf_points: perf.slice(-500), flows: fl.filter((f) => f.ts > startTs).slice(-100).map((f) => ({ ts: f.ts, usd: r2(f.usd, 2), kind: f.kind })) };
}

// beats: [{ ts_ms, mode, uptime }] ascending, the last 7 days of heartbeats
function uptime(beats, now) {
  if (!beats || !beats.length) return null;
  const since = Math.max(now - UPTIME_WINDOW_MS, beats[0].ts_ms), downtimes = [], restarts = [];
  for (let i = 1; i < beats.length; i++) {
    const a = beats[i - 1], b = beats[i];
    if (b.ts_ms - a.ts_ms > GAP_MS) downtimes.push({ from: a.ts_ms, to: b.ts_ms, dur_ms: b.ts_ms - a.ts_ms });
    if (a.uptime != null && b.uptime != null && b.uptime < a.uptime) restarts.push({ ts: b.ts_ms - b.uptime * 1000 });
  }
  const last = beats[beats.length - 1].ts_ms;
  if (now - last > GAP_MS) downtimes.push({ from: last, to: null, dur_ms: now - last, ongoing: true });
  const down = downtimes.reduce((a, d) => a + d.dur_ms, 0), span = Math.max(1, now - since);
  return { since_ms: since, window_ms: UPTIME_WINDOW_MS, gap_ms: GAP_MS, beats: beats.length, uptime_pct: r2(Math.max(0, 100 * (1 - down / span)), 2), down_ms: down,
    downtimes: downtimes.reverse().slice(0, 30), restarts: restarts.reverse().slice(0, 30) };
}

function activity(evs, flows) {
  const out = [];
  for (let i = evs.length - 1; i >= 0 && out.length < 80; i--) {
    const e = evs[i], d = e.data, base = { ts: e.ts_ms, symbol: e.symbol, side: e.side };
    if (e.type === 'entry') out.push({ ...base, kind: 'entry', entry: d.entry, sl: d.sl, tp: d.tp, risk_usd: d.risk_usd ?? null });
    else if (e.type === 'exit') out.push({ ...base, kind: 'exit', reason: d.reason, exit: d.exit, r: d.r, usd: d.usd ?? null });
    else if (e.type === 'signal' && d.decision === 'skipped') out.push({ ...base, kind: 'skip', reason: d.reason, detail: d.detail });
    else if (e.type === 'equity') out.push({ ...base, kind: 'check', candle_ms: d.candle_ms, total_r: d.total_r, balance: d.paper_balance ?? d.equity_usd ?? null });
    else if (e.type === 'compare') out.push({ ...base, kind: 'compare', match: d.match, matched: d.matched, mismatches: (d.live_only || 0) + (d.backtest_only || 0) });
  }
  for (const f of flows || []) out.push({ ts: f.ts_ms, kind: 'capital', flow: f.kind, usd: +f.usdt });
  return out.sort((a, b) => b.ts - a.ts).slice(0, 80);
}

function aggregate({ events = [], heartbeat = null, now = Date.now(), mode = null, beats = null, flows = null } = {}) {
  const modesSeen = [...new Set(events.map((e) => e.mode).concat(heartbeat ? [heartbeat.mode] : []))].sort();
  const useMode = mode || (heartbeat && heartbeat.mode) || modesSeen[modesSeen.length - 1] || 'paper';
  const evs = events.filter((e) => e.mode === useMode).sort((a, b) => a.ts_ms - b.ts_ms);

  const entries = new Map(), exits = new Map();
  for (const e of evs) {
    if (e.type === 'entry' && e.data.trade_id) entries.set(e.data.trade_id, e);
    if (e.type === 'exit' && e.data.trade_id) exits.set(e.data.trade_id, e);
  }
  const trades = [], open = [];
  const hbData = (heartbeat && heartbeat.data) || {};
  for (const [id, en] of entries) {
    const d = en.data, ex = exits.get(id), dir = en.side === 'LONG' ? 1 : -1;
    const base = { trade_id: id, symbol: en.symbol, side: en.side, mode: en.mode, entry: d.entry, sl: d.sl, tp: d.tp, risk_pct: d.risk_pct, signal_candle_open_ms: d.signal_candle_open_ms, entry_ts: en.ts_ms };
    if (ex) trades.push({ ...base, exit: ex.data.exit, reason: ex.data.reason, r: ex.data.r, usd: ex.data.usd ?? null, hold_sec: ex.data.hold_sec, exit_ts: ex.ts_ms, costs_kind: ex.data.costs_kind });
    else {
      const px = hbData.prices && hbData.prices[en.symbol] ? hbData.prices[en.symbol].px : null, oneR = d.entry != null && d.sl != null ? Math.abs(d.entry - d.sl) : null;
      open.push({ ...base, price: px, current_r: px != null && oneR ? r2(dir * (px - d.entry) / oneR, 2) : null, price_note: px != null ? 'last closed 4h candle' : 'no price yet' });
    }
  }
  trades.sort((a, b) => a.exit_ts - b.exit_ts);
  let cum = 0, peak = 0;
  const curve = trades.map((t, i) => { cum += t.r; peak = Math.max(peak, cum); return { ts: t.exit_ts, n: i + 1, r_cum: r2(cum, 3), dd_r: r2(peak - cum, 3), symbol: t.symbol }; });
  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const perCoin = Object.fromEntries(symbols.map((s) => [s, stats(trades.filter((t) => t.symbol === s))]));

  const skipped = evs.filter((e) => e.type === 'signal' && e.data.decision === 'skipped').sort((a, b) => b.ts_ms - a.ts_ms).slice(0, 200)
    .map((e) => ({ ts: e.ts_ms, symbol: e.symbol, side: e.side, reason: e.data.reason, detail: e.data.detail, signal_candle_open_ms: e.data.signal_candle_open_ms }));
  const cmp = evs.filter((e) => e.type === 'compare').sort((a, b) => b.ts_ms - a.ts_ms)[0];
  const liveFlows = useMode === 'live' ? (flows || []) : [];   // capital movements belong to the real account; the paper balance has none
  const lastHb = heartbeat ? heartbeat.ts_ms : null, age = lastHb != null ? now - lastHb : null;
  const lastUpdate = Math.max(0, lastHb || 0, ...evs.map((e) => e.ts_ms)) || null;   // newest thing the bot has told us (heartbeat or any event)
  return {
    generated_at: now, last_update_ms: lastUpdate, mode: useMode, modes_seen: modesSeen,
    status: heartbeat ? { alive: age <= STALE_MS, age_ms: age, stale_after_ms: STALE_MS, last_heartbeat_ms: lastHb, mode: heartbeat.mode, kill_switch: !!hbData.kill_switch, drawdown_r: hbData.drawdown_r ?? null, halt_r: hbData.halt_r ?? null,
      last_candle_ms: hbData.last_candle_ms || {}, commit: hbData.commit || null, version: hbData.version || null, uptime_sec: hbData.uptime_sec ?? null, next_wake_ms: hbData.next_wake_ms ?? null,
      enabled_coins: hbData.enabled_coins || [] }
      : { alive: false, age_ms: null, stale_after_ms: STALE_MS, last_heartbeat_ms: null, mode: useMode, note: 'no heartbeat received yet' },
    open, trades, equity: curve, per_coin: perCoin, overall: stats(trades), skipped,
    compare: cmp ? { ts: cmp.ts_ms, ...cmp.data } : null,
    capital: capital(evs, trades, liveFlows), uptime: uptime((beats || []).filter((b) => b.mode === useMode), now), activity: activity(evs, liveFlows),
  };
}

module.exports = { aggregate, stats, STALE_MS };

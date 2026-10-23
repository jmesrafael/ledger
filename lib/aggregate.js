// aggregate.js - turns the stored events into what the dashboard page shows. Pure: events in, plain JSON out (no clock unless `now` is given).
//   status    alive/stale banner (stale = no heartbeat for 4h20m, the same limit as the watchdog), mode, kill switch, drawdown vs the halt
//   open      positions with entry/SL/TP and the current R when a price is known (prices ride on the heartbeat: public candle closes)
//   trades    entry joined to exit (trade_id); every R total comes with its trade count
//   equity    cumulative R curve and drawdown (from closed trades, in exit order)
//   perCoin   trades, win rate, profit factor, average R, max drawdown (R), longest losing streak
//   skipped   skipped signals with reasons · compare: the latest live-vs-backtest result
'use strict';

const STALE_MS = (4 * 60 + 20) * 60 * 1000;
const r2 = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r < 0);
  const gw = wins.reduce((a, t) => a + t.r, 0), gl = -losses.reduce((a, t) => a + t.r, 0), total = trades.reduce((a, t) => a + t.r, 0);
  let eq = 0, peak = 0, maxDd = 0, streak = 0, longest = 0;
  for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); if (t.r <= 0) longest = Math.max(longest, ++streak); else streak = 0; }
  return { trades: n, wins: wins.length, win_rate: n ? r2(wins.length / n) : null, profit_factor: gl > 0 ? r2(gw / gl, 2) : n && gw > 0 ? 'inf' : null, avg_r: n ? r2(total / n) : null, total_r: r2(total, 2), max_dd_r: r2(maxDd, 2), longest_losing_streak: longest };
}

function aggregate({ events = [], heartbeat = null, now = Date.now(), mode = null } = {}) {
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
    if (ex) trades.push({ ...base, exit: ex.data.exit, reason: ex.data.reason, r: ex.data.r, hold_sec: ex.data.hold_sec, exit_ts: ex.ts_ms, costs_kind: ex.data.costs_kind });
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
  const lastHb = heartbeat ? heartbeat.ts_ms : null, age = lastHb != null ? now - lastHb : null;
  return {
    generated_at: now, mode: useMode, modes_seen: modesSeen,
    status: heartbeat ? { alive: age <= STALE_MS, age_ms: age, stale_after_ms: STALE_MS, last_heartbeat_ms: lastHb, mode: heartbeat.mode, kill_switch: !!hbData.kill_switch, drawdown_r: hbData.drawdown_r ?? null, halt_r: hbData.halt_r ?? null,
      last_candle_ms: hbData.last_candle_ms || {}, commit: hbData.commit || null, version: hbData.version || null, uptime_sec: hbData.uptime_sec ?? null, next_wake_ms: hbData.next_wake_ms ?? null }
      : { alive: false, age_ms: null, stale_after_ms: STALE_MS, last_heartbeat_ms: null, mode: useMode, note: 'no heartbeat received yet' },
    open, trades, equity: curve, per_coin: perCoin, overall: stats(trades), skipped,
    compare: cmp ? { ts: cmp.ts_ms, ...cmp.data } : null,
  };
}

module.exports = { aggregate, stats, STALE_MS };

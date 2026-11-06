// research.js - the numbers behind the bot dashboard's Calendar and Research tabs. Pure functions: closed trades in, plain objects out (no DOM, no clock).
// Loaded by the page as window.BotResearch and by the tests with require(). Nothing here talks to the network.
//
// A "trade" is one entry of GET /api/data -> trades: { symbol, side, r, usd|null, reason, entry_ts, exit_ts, hold_sec, slippage_r, delay_sec, ... }.
// A trade belongs to the day it CLOSED (that is when the result became real), in the time zone the page is set to ('utc' | 'local').
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BotResearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (v) => v != null && Number.isFinite(+v);
  const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
  const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
  const pad = (n) => String(n).padStart(2, '0');

  // ---------------- days ----------------
  // calendar parts of a moment: y, m (0-11), d, h, dow (0 = Sunday)
  function dayParts(ms, tz) {
    const d = new Date(ms), u = tz !== 'local';
    return u ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), dow: d.getUTCDay() }
      : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), dow: d.getDay() };
  }
  const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const dayKey = (ms, tz) => { const p = dayParts(ms, tz); return keyOf(p.y, p.m, p.d); };
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  // ---------------- one group of trades ----------------
  function summarize(trades) {
    const n = trades.length;
    const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r < 0);
    const gw = sum(wins, (t) => t.r), gl = -sum(losses, (t) => t.r), total = sum(trades, (t) => t.r);
    const withUsd = trades.filter((t) => num(t.usd));
    const ordered = [...trades].sort((a, b) => a.exit_ts - b.exit_ts);
    let eq = 0, peak = 0, maxDd = 0, streak = 0, longest = 0;
    for (const t of ordered) { eq += t.r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); if (t.r <= 0) longest = Math.max(longest, ++streak); else streak = 0; }
    return {
      n, wins: wins.length, losses: losses.length, flat: n - wins.length - losses.length,
      win_rate: n ? wins.length / n : null,
      total_r: round(total, 2), avg_r: n ? round(total / n, 3) : null,
      avg_win_r: wins.length ? round(gw / wins.length, 2) : null, avg_loss_r: losses.length ? round(-gl / losses.length, 2) : null,
      profit_factor: gl > 0 ? round(gw / gl, 2) : n && gw > 0 ? Infinity : null,
      best_r: n ? round(Math.max(...trades.map((t) => t.r)), 2) : null, worst_r: n ? round(Math.min(...trades.map((t) => t.r)), 2) : null,
      usd: withUsd.length ? round(sum(withUsd, (t) => t.usd), 2) : null,
      max_dd_r: round(maxDd, 2), longest_losing_streak: longest,
      avg_hold_sec: trades.some((t) => num(t.hold_sec)) ? round(sum(trades.filter((t) => num(t.hold_sec)), (t) => t.hold_sec) / trades.filter((t) => num(t.hold_sec)).length, 0) : null,
    };
  }

  // ---------------- calendar ----------------
  // key 'YYYY-MM-DD' -> { key, n, wins, losses, r, usd (null when no trade that day carries money), trades }
  function dailyMap(trades, tz) {
    const days = new Map();
    for (const t of trades) {
      if (!num(t.exit_ts) || !num(t.r)) continue;
      const k = dayKey(t.exit_ts, tz);
      let d = days.get(k); if (!d) days.set(k, d = { key: k, n: 0, wins: 0, losses: 0, r: 0, usd: null, trades: [] });
      d.n++; d.r += t.r; if (t.r > 0) d.wins++; else if (t.r < 0) d.losses++;
      if (num(t.usd)) d.usd = (d.usd || 0) + t.usd;
      d.trades.push(t);
    }
    for (const d of days.values()) { d.r = round(d.r, 3); if (d.usd != null) d.usd = round(d.usd, 2); d.trades.sort((a, b) => a.exit_ts - b.exit_ts); }
    return days;
  }

  // one month as week rows. weekStart: 1 = Monday (default), 0 = Sunday. Every cell: { key, day, inMonth, stat } (stat = the day's entry from dailyMap, or null).
  function monthGrid(days, year, month, weekStart = 1) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay(), lead = (first - weekStart + 7) % 7, dim = daysInMonth(year, month);
    const total = Math.ceil((lead + dim) / 7) * 7, weeks = [];
    for (let i = 0; i < total; i += 7) {
      const cells = [];
      for (let j = i; j < i + 7; j++) {
        const dt = new Date(Date.UTC(year, month, 1 - lead + j)), inMonth = dt.getUTCMonth() === month;
        const key = keyOf(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
        cells.push({ key, day: dt.getUTCDate(), inMonth, stat: inMonth ? days.get(key) || null : null });
      }
      weeks.push({ cells, total: rollup(cells.map((c) => c.stat).filter(Boolean)) });
    }
    return { year, month, weeks, total: rollup([...days.values()].filter((d) => d.key.startsWith(`${year}-${pad(month + 1)}-`))) };
  }

  // a list of day entries -> totals, with the best and worst day, and how many days won / lost
  function rollup(list) {
    const usdDays = list.filter((d) => d.usd != null);
    return {
      days: list.length, win_days: list.filter((d) => d.r > 0).length, loss_days: list.filter((d) => d.r < 0).length,
      n: sum(list, (d) => d.n), r: round(sum(list, (d) => d.r), 2), usd: usdDays.length ? round(sum(usdDays, (d) => d.usd), 2) : null,
      best: list.length ? list.reduce((a, d) => (d.r > a.r ? d : a)) : null, worst: list.length ? list.reduce((a, d) => (d.r < a.r ? d : a)) : null,
    };
  }

  // the twelve months of a year, for the year strip: [{ month, key, ...rollup }]
  function yearMonths(days, year) {
    return Array.from({ length: 12 }, (_, m) => {
      const pre = `${year}-${pad(m + 1)}-`;
      return { month: m, key: `${year}-${pad(m + 1)}`, ...rollup([...days.values()].filter((d) => d.key.startsWith(pre))) };
    });
  }
  // 'YYYY-MM' keys that have trades, oldest first
  const monthsWithData = (days) => [...new Set([...days.keys()].map((k) => k.slice(0, 7)))].sort();

  // ---------------- breakdowns ----------------
  // [{ key, label?, ...summarize }] in the order given by `order` (or by key). keyFn returns null to leave a trade out.
  function groupBy(trades, keyFn, order) {
    const g = new Map();
    for (const t of trades) { const k = keyFn(t); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
    const keys = order ? order.filter((k) => g.has(k)).concat([...g.keys()].filter((k) => !order.includes(k))) : [...g.keys()].sort();
    return keys.map((k) => ({ key: k, ...summarize(g.get(k)) }));
  }
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byWeekday = (trades, tz) => groupBy(trades, (t) => (num(t.entry_ts) ? WEEKDAYS[dayParts(t.entry_ts, tz).dow] : null), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  // entry hour in 6-hour blocks (a 1h or 4h bot only enters on candle opens, so single hours would be mostly empty)
  const HOUR_BLOCKS = ['00-06', '06-12', '12-18', '18-24'];
  const byHourBlock = (trades, tz) => groupBy(trades, (t) => (num(t.entry_ts) ? HOUR_BLOCKS[Math.floor(dayParts(t.entry_ts, tz).h / 6)] : null), HOUR_BLOCKS);
  const HOLD_BUCKETS = [['< 4h', 4 * 3600], ['4-12h', 12 * 3600], ['12-24h', 24 * 3600], ['1-3 days', 72 * 3600], ['3+ days', Infinity]];
  const byHold = (trades) => groupBy(trades, (t) => (num(t.hold_sec) ? HOLD_BUCKETS.find(([, max]) => t.hold_sec < max)[0] : null), HOLD_BUCKETS.map(([l]) => l));

  // R histogram: counts per bucket. Edges are the bucket boundaries; the first and last buckets are open-ended.
  function histogram(trades, edges = [-2, -1, -0.5, 0, 0.5, 1, 2, 3]) {
    const labels = [`< ${edges[0]}R`, ...edges.slice(0, -1).map((e, i) => `${e} to ${edges[i + 1]}R`), `${edges[edges.length - 1]}R +`];
    const counts = new Array(labels.length).fill(0);
    for (const t of trades) { if (!num(t.r)) continue; let i = edges.findIndex((e) => t.r < e); if (i < 0) i = edges.length; counts[i]++; }
    return labels.map((label, i) => ({ label, n: counts[i], lo: i === 0 ? -Infinity : edges[i - 1], hi: i === edges.length ? Infinity : edges[i] }));
  }

  // ---------------- execution quality ----------------
  const pctile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  function stat(vals) {
    const v = vals.filter(num).map(Number).sort((a, b) => a - b), n = v.length;
    if (!n) return { n: 0, avg: null, median: null, p90: null, max: null, min: null };
    return { n, avg: round(sum(v) / n, 4), median: pctile(v, 0.5), p90: pctile(v, 0.9), max: v[n - 1], min: v[0] };
  }
  function execution(trades) {
    const slip = stat(trades.map((t) => t.slippage_r)), delay = stat(trades.map((t) => t.delay_sec)), fees = stat(trades.map((t) => t.fees_r));
    const cost = trades.filter((t) => num(t.fees_r) || num(t.slippage_r)).map((t) => (num(t.fees_r) ? t.fees_r : 0) + (num(t.slippage_r) ? Math.max(0, t.slippage_r) : 0));
    return { slippage_r: slip, delay_sec: delay, fees_r: fees, cost_r: stat(cost), near_thr_pct: stat(trades.map((t) => t.near_thr_pct)) };
  }

  // ---------------- is the paper run telling us anything yet? ----------------
  // Mean R with a 95% confidence interval from the trades' own spread. With few trades the interval is wide: that is the point of showing it.
  function edge(trades) {
    const r = trades.map((t) => t.r).filter(num), n = r.length;
    if (n < 2) return { n, mean: n ? round(r[0], 3) : null, sd: null, lo: null, hi: null, half: null, excludes_zero: false };
    const mean = sum(r) / n, sd = Math.sqrt(sum(r, (x) => (x - mean) ** 2) / (n - 1)), half = 1.96 * sd / Math.sqrt(n);
    return { n, mean: round(mean, 3), sd: round(sd, 2), lo: round(mean - half, 3), hi: round(mean + half, 3), half: round(half, 3), excludes_zero: mean - half > 0 || mean + half < 0 };
  }

  // Execution-parity checks taken from the bb-core audit (AUDIT-REPORT, section 8): sample size >= 25 trades, every entry within 15 minutes of the candle
  // open (B1), mean fees + adverse slippage <= 0.07R per trade (B3). Plus the live-vs-backtest result and the drawdown against the halt.
  // These show the bot EXECUTES as the backtest assumes. They do not prove the strategy makes money (the audit says so too: that needs hundreds of trades).
  // status: 'pass' | 'fail' | 'wait' (not enough data yet) | 'info'
  function readiness(trades, { compare = null, drawdownR = null, haltR = null, skipCompare = false } = {}) {
    const ex = execution(trades), n = trades.length, out = [];
    out.push({ id: 'sample', title: 'Enough trades to judge', need: '25 or more closed trades', have: `${n} closed`, status: n >= 25 ? 'pass' : 'wait',
      note: n >= 25 ? 'The sample is big enough for the execution checks below.' : `${25 - n} more trade${25 - n === 1 ? '' : 's'} before the checks below mean much.` });
    out.push({ id: 'timing', title: 'Entries on time', need: 'every entry within 15 minutes of the candle open', have: ex.delay_sec.n ? `slowest ${Math.round(ex.delay_sec.max)}s · median ${Math.round(ex.delay_sec.median)}s` : 'no entries yet',
      status: !ex.delay_sec.n ? 'wait' : ex.delay_sec.max <= 900 ? 'pass' : 'fail', note: 'Seconds between the candle open and the moment the bot filled.' });
    out.push({ id: 'costs', title: 'Costs inside the model', need: 'average fees + slippage 0.07R or less per trade', have: ex.cost_r.n ? `${ex.cost_r.avg.toFixed(3)}R average over ${ex.cost_r.n}` : 'no data yet',
      status: !ex.cost_r.n ? 'wait' : n < 25 ? 'wait' : ex.cost_r.avg <= 0.07 ? 'pass' : 'fail', note: 'What the run charged for fees and slippage on each trade (funding is counted separately in R).' });
    if (!skipCompare) out.push({ id: 'compare', title: 'Matches the backtest', need: 'latest live-vs-backtest check says MATCH', have: compare ? `${compare.match ? 'MATCH' : 'NOT A MATCH'} · ${compare.matched ?? 0} matched` : 'no check received yet',
      status: !compare ? 'wait' : compare.match ? 'pass' : 'fail', note: 'Same candles run through the backtest: every trade should appear in both.' });
    if (drawdownR != null && haltR != null) {
      const halt = Math.abs(haltR);
      out.push({ id: 'dd', title: 'Drawdown inside the halt', need: `below ${halt}R`, have: `${Number(drawdownR).toFixed(1)}R now`, status: Number(drawdownR) < halt ? 'pass' : 'fail', note: 'The bot stops taking entries at the halt.' });
    }
    return out;
  }

  // ---------------- one trade, in plain words (for the detail card) ----------------
  function describe(t) {
    const out = [], side = t.side === 'LONG' ? 'bought' : 'sold short', coin = String(t.symbol || '').replace('_USDT', '');
    if (t.entry != null) out.push(`${side} ${coin} at ${t.entry}${t.sl != null ? `, stop ${t.sl}` : ''}${t.tp != null ? `, target ${t.tp}` : ', no target (exits by stop or time)'}.`);
    if (num(t.delay_sec) && num(t.slippage_r)) out.push(`Filled ${Math.round(t.delay_sec)}s after the candle open, ${Math.abs(t.slippage_r).toFixed(3)}R ${t.slippage_r > 0 ? 'worse' : t.slippage_r < 0 ? 'better' : 'the same'} than the open price.`);
    if (t.reason) out.push(`Closed by ${t.reason === 'target' ? 'the target' : t.reason === 'stop' ? 'the stop' : t.reason === 'time' ? 'the time limit' : t.reason}.`);
    return out.join(' ');
  }

  return { dayParts, dayKey, daysInMonth, summarize, dailyMap, monthGrid, rollup, yearMonths, monthsWithData, groupBy, byWeekday, byHourBlock, byHold, histogram, stat, execution, edge, readiness, describe, WEEKDAYS };
});

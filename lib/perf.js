// perf.js - live performance analysis: closed trades in, plain JSON out. Pure (no clock unless `now` is given, no files, no network).
// Used by the hosted dashboard (lib/perf.js: Performance and Verify tabs) and by the bots' daily watcher (perf-watch.js: Telegram alarms + weekly digest),
// so both always judge the bot by the same numbers. IDENTICAL copies live in LEDGER lib/perf.js, bb-core perf.js + dashboard/lib/perf.js and i-core perf.js
// (bb-core test/perf-test.js fails when they drift).
//
//   trade  { symbol, side, r, reason, entry_ts, exit_ts (ms), hold_sec, usd?, entry?, intended?, slippage_r?, delay_sec?, fees_r? }
//   periods     by exit time (UTC): day (newest 120), month, year: trades, wins, R, $, best, worst
//   execution   entry slippage vs the price the decision was made at (+ = worse than intended, in % and R), entry delay, fees
//   checks      the stop-and-review rules of each bot (RUN-LOG.md, Oct 26, 2026 for BB-Core; i-core/README.md research numbers for I-Core):
//               ok | wait (not enough trades yet to judge) | info | warn | stop. A rule that is not met is a reason to LOOK, never an automatic action.
'use strict';

const PROFILES = {
  bbcore: {
    label: 'BB-Core',
    expect: { avg_r: 0.28, win_rate: 0.387, target_rate: 0.143, trades_per_month: 20, max_dd_r: 25.7, longest_losing: 20, source: 'backtest since 2022, five coins, fees + funding (RUN-LOG Oct 26, 2026)' },
    rules: { dd_warn_r: 18, dd_stop_r: 26, roll_n: 50, roll_stop_r: -14, target_after: 60, target_min: 0.10, streak_warn: 20, slip_after: 10, slip_warn_pct: 0.02, judge_after: 150 },
  },
  icore: {
    label: 'I-Core',
    expect: { avg_r: 0.87, win_rate: 0.32, target_rate: null, trades_per_month: null, max_dd_r: 30, longest_losing: 16, source: 'research 2020-2026, 760 trades (i-core README)' },
    rules: { dd_warn_r: 22, dd_stop_r: 30, roll_n: null, roll_stop_r: null, target_after: null, target_min: null, streak_warn: 16, slip_after: 10, slip_warn_pct: 0.02, judge_after: 150 },
  },
};

const r2 = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const keyOf = { day: (ms) => iso(ms).slice(0, 10), month: (ms) => iso(ms).slice(0, 7), year: (ms) => iso(ms).slice(0, 4) };

// adverse entry slippage in % of the intended price: + = filled worse than intended (higher for a LONG, lower for a SHORT)
function slipPct(t) {
  if (t.entry == null || t.intended == null || !(t.intended > 0)) return null;
  const dir = t.side === 'SHORT' ? -1 : 1;
  return (dir * (t.entry - t.intended) / t.intended) * 100;
}

function stats(ts) {
  const n = ts.length;
  let wins = 0, gw = 0, gl = 0, tot = 0, eq = 0, peak = 0, maxDd = 0, streak = 0, longest = 0, best = null, worst = null, hold = 0, holdN = 0, usd = 0, usdN = 0, tgt = 0;
  for (const t of ts) {
    tot += t.r; if (t.r > 0) { wins++; gw += t.r; } else if (t.r < 0) gl -= t.r;
    eq += t.r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq);
    if (t.r <= 0) longest = Math.max(longest, ++streak); else streak = 0;
    best = best == null ? t.r : Math.max(best, t.r); worst = worst == null ? t.r : Math.min(worst, t.r);
    if (Number.isFinite(t.hold_sec)) { hold += t.hold_sec; holdN++; }
    if (Number.isFinite(t.usd)) { usd += t.usd; usdN++; }
    if (t.reason === 'target') tgt++;
  }
  return { trades: n, wins, losses: n - wins, win_rate: n ? r2(wins / n) : null, avg_r: n ? r2(tot / n) : null, total_r: r2(tot, 2),
    profit_factor: gl > 0 ? r2(gw / gl, 2) : n && gw > 0 ? 'inf' : null, max_dd_r: r2(maxDd, 2), dd_now_r: r2(peak - eq, 2), longest_losing: longest, current_losing: streak,
    best_r: r2(best, 2), worst_r: r2(worst, 2), avg_hold_sec: holdN ? Math.round(hold / holdN) : null, usd: usdN ? r2(usd, 2) : null, target_rate: n ? r2(tgt / n) : null };
}

function periods(ts, unit) {
  const m = new Map();
  for (const t of ts) {
    const k = keyOf[unit](t.exit_ts); let b = m.get(k);
    if (!b) m.set(k, (b = { key: k, trades: 0, wins: 0, r: 0, usd: null, best: null, worst: null }));
    b.trades++; if (t.r > 0) b.wins++; b.r += t.r;
    if (Number.isFinite(t.usd)) b.usd = (b.usd || 0) + t.usd;
    b.best = b.best == null ? t.r : Math.max(b.best, t.r); b.worst = b.worst == null ? t.r : Math.min(b.worst, t.r);
  }
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((b) => ({ ...b, r: r2(b.r, 2), usd: r2(b.usd, 2), best: r2(b.best, 2), worst: r2(b.worst, 2) }));
}

function execution(ts) {
  const rows = ts.map((t) => ({ t, slip: slipPct(t) }));
  const agg = (list) => {
    const s = list.filter((x) => x.slip != null), sr = list.filter((x) => Number.isFinite(x.t.slippage_r)), d = list.filter((x) => Number.isFinite(x.t.delay_sec)), f = list.filter((x) => Number.isFinite(x.t.fees_r));
    const mean = (a, g) => (a.length ? a.reduce((x, y) => x + g(y), 0) / a.length : null);
    return { measured: s.length, avg_slip_pct: r2(mean(s, (x) => x.slip), 4), worst_slip_pct: s.length ? r2(Math.max(...s.map((x) => x.slip)), 4) : null,
      avg_slip_r: r2(mean(sr, (x) => x.t.slippage_r), 4), avg_delay_sec: r2(mean(d, (x) => x.t.delay_sec), 1), avg_fees_r: r2(mean(f, (x) => x.t.fees_r), 4) };
  };
  const coins = [...new Set(ts.map((t) => t.symbol))].sort();
  return { ...agg(rows), per_coin: Object.fromEntries(coins.map((c) => [c, agg(rows.filter((x) => x.t.symbol === c))])) };
}

// one rule -> { id, level, title, value, limit, note }
function checks(ts, s, exec, compares, p) {
  const R = p.rules, E = p.expect, out = [], n = ts.length;
  const add = (id, level, title, value, limit, note) => out.push({ id, level, title, value, limit, note });
  // 1. drawdown from the best point so far
  if (!n) add('drawdown', 'wait', 'Drawdown', null, `${R.dd_stop_r}R`, 'no closed trade yet');
  else add('drawdown', s.dd_now_r >= R.dd_stop_r ? 'stop' : s.dd_now_r >= R.dd_warn_r ? 'warn' : 'ok', 'Drawdown', `${s.dd_now_r}R now · ${s.max_dd_r}R worst`, `${R.dd_stop_r}R`,
    s.dd_now_r >= R.dd_stop_r ? `deeper than anything in the ${E.source.split(',')[0]}: stop and review` : `backtest worst ${E.max_dd_r}R`);
  // 2. rolling window of the last N trades
  if (R.roll_n) {
    if (n < R.roll_n) add('rolling', 'wait', `Last ${R.roll_n} trades`, `${n} of ${R.roll_n} trades so far`, `${R.roll_stop_r}R`, 'judged once there are enough trades');
    else { const v = r2(ts.slice(-R.roll_n).reduce((a, t) => a + t.r, 0), 2); add('rolling', v <= R.roll_stop_r ? 'stop' : v < 0 ? 'warn' : 'ok', `Last ${R.roll_n} trades`, `${v >= 0 ? '+' : ''}${v}R`, `${R.roll_stop_r}R`, v <= R.roll_stop_r ? 'worse than the stop line: review' : ''); }
  }
  // 3. how often the 4R target is reached (BB-Core only: I-Core has no target)
  if (R.target_after) {
    if (n < R.target_after) add('target', 'wait', 'Target-hit rate', n ? `${Math.round(s.target_rate * 100)}% after ${n} trades` : '—', `${Math.round(R.target_min * 100)}% after ${R.target_after}`, 'judged after enough trades');
    else add('target', s.target_rate < R.target_min ? 'stop' : 'ok', 'Target-hit rate', `${Math.round(s.target_rate * 100)}%`, `${Math.round(R.target_min * 100)}%`, `backtest ${Math.round(E.target_rate * 100)}%`);
  }
  // 4. losing streak (a trade at 0R or worse counts as a loss)
  add('streak', s.current_losing >= R.streak_warn ? 'warn' : 'ok', 'Losing streak', `${s.current_losing} now · ${s.longest_losing} longest`, `${R.streak_warn}`, `backtest longest ${E.longest_losing}`);
  // 5. entry slippage vs the model
  if (exec.measured < R.slip_after) add('slippage', 'wait', 'Entry slippage', exec.measured ? `${exec.avg_slip_pct}% avg over ${exec.measured} entries` : 'no measured entry yet', `${R.slip_warn_pct}%`, `judged after ${R.slip_after} entries`);
  else add('slippage', exec.avg_slip_pct > R.slip_warn_pct ? 'warn' : 'ok', 'Entry slippage', `${exec.avg_slip_pct}% avg · ${exec.worst_slip_pct}% worst`, `${R.slip_warn_pct}%`, 'the backtest assumes this per side');
  // 6. live vs backtest comparison: one miss is a thing to read, two in a row is a stop
  const c = (compares || []).slice(0, 2);
  if (!c.length) add('compare', 'wait', 'Live vs backtest', 'no comparison received yet', 'match', 'daily compare job');
  else add('compare', c[0].match ? 'ok' : c.length > 1 && !c[1].match ? 'stop' : 'warn', 'Live vs backtest', c[0].match ? 'match' : c.length > 1 && !c[1].match ? 'mismatch twice in a row' : 'mismatch (latest)', 'match',
    c[0].match ? '' : 'open the Verify tab: which trade differs and why');
  // 7. the edge itself: shown, never judged on a small sample
  add('edge', 'info', 'Average R per trade', n ? `${s.avg_r >= 0 ? '+' : ''}${s.avg_r}R over ${n} trades` : '—', `${E.avg_r >= 0 ? '+' : ''}${E.avg_r}R expected`,
    n < R.judge_after ? `about ${R.judge_after}+ trades are needed before this says anything (now ${n})` : 'enough trades to compare with the backtest');
  return out;
}
const RANK = { ok: 0, info: 0, wait: 0, warn: 1, stop: 2 };
const verdict = (list) => list.reduce((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), 'ok');

// trades: closed, any order. opt: { bot: 'bbcore'|'icore', compares: [{ match, ts }] newest first, now }
function analyze(trades, { bot = 'bbcore', compares = [], now = null } = {}) {
  const p = PROFILES[bot] || PROFILES.bbcore;
  const ts = (trades || []).filter((t) => t && Number.isFinite(t.r) && Number.isFinite(t.exit_ts)).slice().sort((a, b) => a.exit_ts - b.exit_ts);
  const s = stats(ts), exec = execution(ts), list = checks(ts, s, exec, compares, p);
  const first = ts.length ? Math.min(...ts.map((t) => (Number.isFinite(t.entry_ts) ? t.entry_ts : t.exit_ts))) : null, last = ts.length ? ts[ts.length - 1].exit_ts : null;
  const span = first != null ? Math.max(1, ((now != null ? now : last) - first) / DAY) : null;
  const coins = [...new Set(ts.map((t) => t.symbol))].sort();
  const reasons = {}; for (const t of ts) { const k = t.reason || 'other'; (reasons[k] = reasons[k] || { trades: 0, r: 0 }); reasons[k].trades++; reasons[k].r += t.r; }
  for (const k of Object.keys(reasons)) reasons[k].r = r2(reasons[k].r, 2);
  let roll = null;
  if (p.rules.roll_n && ts.length >= p.rules.roll_n) {   // the rolling sum after each trade (newest 300 points)
    roll = []; let sum = 0;
    ts.forEach((t, i) => { sum += t.r; if (i >= p.rules.roll_n) sum -= ts[i - p.rules.roll_n].r; if (i >= p.rules.roll_n - 1) roll.push({ ts: t.exit_ts, y: r2(sum, 2) }); });
    roll = roll.slice(-300);
  }
  return {
    bot, label: p.label, overall: s, first_ts: first, last_ts: last, days: span != null ? r2(span, 1) : null,
    trades_per_month: span != null && span >= 7 ? r2((ts.length / span) * 30.44, 1) : null,
    periods: { day: periods(ts, 'day').slice(-120), month: periods(ts, 'month'), year: periods(ts, 'year') },
    per_coin: Object.fromEntries(coins.map((c) => [c, stats(ts.filter((t) => t.symbol === c))])),
    by_side: Object.fromEntries(['LONG', 'SHORT'].map((sd) => [sd, stats(ts.filter((t) => t.side === sd))])),
    by_reason: reasons, execution: exec, rolling: roll ? { n: p.rules.roll_n, stop_r: p.rules.roll_stop_r, points: roll } : null,
    expect: p.expect, checks: list, verdict: verdict(list),
  };
}

module.exports = { PROFILES, analyze, stats, periods, execution, slipPct, verdict };

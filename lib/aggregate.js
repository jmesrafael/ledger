// aggregate.js - turns the stored events into what the dashboard page shows. Pure: events in, plain JSON out (no clock unless `now` is given).
//   status    alive/stale banner (stale = no heartbeat for 4h20m, the same limit as the watchdog), mode, kill switch, drawdown vs the halt
//   open      positions with entry/SL/TP and the current R when a price is known (prices ride on the heartbeat: public candle closes)
//   trades    entry joined to exit (trade_id); every R total comes with its trade count
//   equity    cumulative R curve and drawdown (from closed trades, in exit order)
//   perCoin   trades, win rate, profit factor, average R, max drawdown (R), longest losing streak
//   skipped   skipped signals with reasons · compare: the latest live-vs-backtest result
//   capital   current balance (paper balance, or live equity only when the bot shares it), change since the first known balance excluding capital added or
//             removed (flows), balance curve + capital steps + a performance curve with the capital taken out, time-weighted return
//   bots / total_capital   when I-Core also reports (events tagged data.bot = 'icore'): a short view of each bot and the capital of both added together.
//             Everything else on the page is BB-Core's, exactly as before. A paper balance is labelled as such and never passed off as wallet money.
//   uptime    from the heartbeat times of the last 7 days: gaps over 4h20m (a missed candle-close beat; the bot reports at every 4h candle close and when you press Ask bot now) are downtime, an uptime counter that drops is a restart
//   activity  the newest entries, exits, skips, candle checks and comparisons, newest first (the page shows them as a log)
//   perf      per bot (lib/perf.js, the same code the bots' daily watcher runs): results by day / month / year, per coin and side, execution quality and the
//             stop-and-review checks. bots.icore also carries I-Core's own closed trades and open positions, so the page can show either bot.
'use strict';
const { analyze, splitMismatches, PROFILES } = require('./perf.js');

// The 1h BB-Core paper lab bot judges itself against ITS OWN backtest, not the 4h bot's: 1h, five coins, Binance candles, fees + slippage + real funding (research/indicator-top10/
// REPORT-4H-VS-1H.md: 1,585 trades, 19.8 a month, win 35.2%, average +0.457R, longest losing streak 21, worst drop -31.2R). Registered here so lib/perf.js stays the identical copy
// the bots and the watcher also run. Its drawdown line is the halt of the lab bot itself (39R); it is a paper run, so a rule that is not met is only ever a reason to look.
PROFILES.bb1h = {
  label: 'BB-1h lab',
  expect: { avg_r: 0.457, win_rate: 0.352, target_rate: null, trades_per_month: 19.8, max_dd_r: 31.2, longest_losing: 21, source: '1h backtest since 2020, five coins, fees + slippage + real funding (Nov 5, 2026)' },
  rules: { dd_warn_r: 26, dd_stop_r: 39, roll_n: null, roll_stop_r: null, target_after: null, target_min: null, streak_warn: 21, slip_after: 10, slip_warn_pct: 0.02, judge_after: 150 },
};
// The T-CORE paper lab bot (bb-core's entry, 2 ATR stop, 14 ATR trailing stop, 4h) judges itself against ITS OWN backtest (research/strat-hunt-nov6, bb-trail P14 4h: 613 trades
// 2020 → Nov 2026, win 21%, average +1.29R, 7.7 a month, worst drop 29.7R, longest losing streak 26). It shares bb-core's entry but holds trades for weeks, so it is never compared with
// bb-core's trades. Its drawdown line is its own halt (45R). Few winners and long runs: it needs many trades before its average says anything (judge_after 100).
PROFILES.bbtr = {
  label: 'T-CORE lab',
  expect: { avg_r: 1.286, win_rate: 0.21, target_rate: null, trades_per_month: 7.7, max_dd_r: 29.7, longest_losing: 26, source: '4h backtest since 2020, five coins, fees + slippage + real funding (Nov 6, 2026)' },
  rules: { dd_warn_r: 30, dd_stop_r: 45, roll_n: null, roll_stop_r: null, target_after: null, target_min: null, streak_warn: 26, slip_after: 10, slip_warn_pct: 0.02, judge_after: 100 },
};
// T-CORE LIVE: the same strategy as the lab, real orders on its own MEXC account (wallet tcore). Same expectations and lines as the lab.
PROFILES.tcore = { ...PROFILES.bbtr, label: 'T-CORE' };
// The NEWS LAB paper bots: the same three strategies with the news gate in front of every new entry (it can only skip or shrink an entry). Paper only, no Telegram,
// no booked money. Each is judged against its own strategy's backtest, the same expectations as its counterpart (bbn = BB-Core 4h, icn = I-Core, tcn = the T-CORE lab).
// The point is the comparison with the counterpart (fewer trades, same or better R per trade, smaller drops), shown in the dashboard's News Lab tab.
PROFILES.bbn = { ...PROFILES.bbcore, label: 'BB-CORE news lab' };
PROFILES.icn = { ...PROFILES.icore, label: 'I-CORE news lab' };
PROFILES.tcn = { ...PROFILES.bbtr, label: 'T-CORE news lab' };
const NEWS_LABS = { bbn: 'BB-CORE news lab', icn: 'I-CORE news lab', tcn: 'T-CORE news lab' };
// The COIN LAB paper bots (Nov 12, 2026): the BB-CORE and T-CORE rules on the NEW coins only, to watch SUI and ARB forward before any real money
// (study: StrategyBacktester research/coin-walkforward/SUI-ARB.md; I-CORE gets no new coin). Each is judged against its own backtest on those coins,
// May 2023 → Nov 2026, fees + slippage + real funding. Paper only: a rule that is not met is a reason to look, never an action.
PROFILES.cbb = {
  label: 'BB-CORE coin lab (ARB)',
  expect: { avg_r: 0.23, win_rate: 0.362, target_rate: null, trades_per_month: 3.8, max_dd_r: 17.5, longest_losing: 12, source: '4h backtest on ARB, May 2023 to Nov 2026, 160 trades, fees + slippage + real funding' },
  rules: { dd_warn_r: 18, dd_stop_r: 26, roll_n: null, roll_stop_r: null, target_after: null, target_min: null, streak_warn: 12, slip_after: 10, slip_warn_pct: 0.02, judge_after: 100 },
};
PROFILES.ctc = {
  label: 'T-CORE coin lab (SUI + ARB)',
  expect: { avg_r: 0.648, win_rate: 0.227, target_rate: null, trades_per_month: 3.6, max_dd_r: 13.1, longest_losing: 10, source: '4h backtest on SUI + ARB, May 2023 to Nov 2026, 150 trades, fees + slippage + real funding' },
  rules: { dd_warn_r: 14, dd_stop_r: 20, roll_n: null, roll_stop_r: null, target_after: null, target_min: null, streak_warn: 12, slip_after: 10, slip_warn_pct: 0.02, judge_after: 100 },
};
const COIN_LABS = { cbb: 'BB-CORE coin lab (ARB)', ctc: 'T-CORE coin lab (SUI + ARB)' };
// what a trend-following lab lives on: how far its trades ran (MFE), how much the trail gave back, against the backtest's own rates (the same rules on the same coins, 2020-2026)
const TREND_EXPECT = { bbtr: { reached_1r: 0.55, reached_3r: 0.31, reached_5r: 0.22, reached_10r: 0.09, mfe_median: 1.33, mae_median: -1.09, gave_back_median: 2.23, bars_median: 32 } };
function trendCapture(trades, bot) {
  const t = trades.filter((x) => x.mfe_r != null);
  if (!t.length) return { trades: 0, expect: TREND_EXPECT[bot] || null };
  const med = (a) => { const v = a.filter((x) => x != null).sort((p, q) => p - q); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
  const reach = (k) => r2(t.filter((x) => x.mfe_r >= k).length / t.length);
  return { trades: t.length, reached_1r: reach(1), reached_3r: reach(3), reached_5r: reach(5), reached_10r: reach(10), mfe_median: r2(med(t.map((x) => x.mfe_r)), 2), mae_median: r2(med(t.map((x) => x.mae_r)), 2),
    gave_back_median: r2(med(t.map((x) => x.gave_back_r)), 2), bars_median: med(t.map((x) => x.bars)), trail_moves_median: med(t.map((x) => x.trail_moves)), funding_r_avg: r2(t.reduce((a, x) => a + (x.funding_r || 0), 0) / t.length, 4),
    slip_bp_avg: r2(t.reduce((a, x) => a + (x.slip_bp || 0), 0) / t.length, 2), expect: TREND_EXPECT[bot] || null };
}

const STALE_MS = (4 * 60 + 20) * 60 * 1000;
const UPTIME_WINDOW_MS = 7 * 86400000, GAP_MS = STALE_MS;
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

// entry joined to exit by trade_id -> closed trades (oldest exit first) and the still-open ones
// The dollar result of a live trade is the realised P&L MEXC booked for the position (ledger table closed_trades, the figure the Telegram message shows). It is matched to
// the exit by bot wallet, coin, side and close time, each booked trade used once, and only fills a trade that carries no dollar figure of its own.
// MEXC closes the position the moment the exchange stop is touched, but the bot books the exit at the next candle close (up to one candle later), so the
// booked close may be anywhere between the entry and the bot's exit (+15 minutes for a slow close order); the one nearest the bot's exit wins.
const BOOKED_GRACE_MS = 15 * 60000;
function applyBooked(trades, booked, wallet = null) {
  const pool = (booked || []).map((b) => ({ ...b })).filter((b) => b && Number.isFinite(+b.closed_ms) && Number.isFinite(+b.usd) && (!wallet || !b.wallet || b.wallet === wallet));
  for (const t of trades) {
    if (t.usd != null || t.mode !== 'live') continue;
    const from = Number.isFinite(t.entry_ts) ? t.entry_ts : t.exit_ts - BOOKED_GRACE_MS, to = t.exit_ts + BOOKED_GRACE_MS;
    let best = null;
    for (const b of pool) if (!b.used && b.symbol === t.symbol && (!b.side || !t.side || b.side === t.side) && b.closed_ms > from && b.closed_ms <= to && (!best || Math.abs(b.closed_ms - t.exit_ts) < Math.abs(best.closed_ms - t.exit_ts))) best = b;
    if (best) { best.used = true; t.usd = r2(best.usd, 2); }
  }
}

function pairTrades(evs, hbData, booked, wallet = null) {
  const entries = new Map(), exits = new Map();
  for (const e of evs) {
    if (e.type === 'entry' && e.data.trade_id) entries.set(e.data.trade_id, e);
    if (e.type === 'exit' && e.data.trade_id) exits.set(e.data.trade_id, e);
  }
  const trades = [], open = [];
  for (const [id, en] of entries) {
    const d = en.data, ex = exits.get(id), dir = en.side === 'LONG' ? 1 : -1;
    const base = { trade_id: id, symbol: en.symbol, side: en.side, mode: en.mode, entry: d.entry, sl: d.sl, tp: d.tp, risk_pct: d.risk_pct, signal_candle_open_ms: d.signal_candle_open_ms, entry_ts: en.ts_ms };
    if (ex) trades.push({ ...base, exit: ex.data.exit, reason: ex.data.reason, r: ex.data.r, usd: ex.data.usd ?? null, hold_sec: ex.data.hold_sec, exit_ts: ex.ts_ms, costs_kind: ex.data.costs_kind,
      intended: d.intended_price ?? null, slippage_r: d.slippage_r ?? null, delay_sec: d.delay_sec ?? null, fees_r: ex.data.fees_r ?? null,
      // research detail (Research tab): how close the signal was to its trigger, the size and risk, the balance around the trade
      near_thr_pct: d.nearest_threshold_pct ?? null, one_r: d.one_r ?? null, qty: d.qty ?? null, risk_usd: d.risk_usd ?? null, balance_used: d.balance_used ?? null, balance_after: ex.data.balance_after ?? null,
      fees_pct: ex.data.fees_pct_est ?? null, slip_pct: ex.data.slippage_pct_est ?? null, funding: ex.data.funding_est ?? null,
      // trend capture (the T-CORE lab sends these; null for the other bots)
      mfe_r: ex.data.mfe_r ?? null, mae_r: ex.data.mae_r ?? null, gave_back_r: ex.data.gave_back_r ?? null, stop_at_exit_r: ex.data.stop_at_exit_r ?? null, trail_moves: ex.data.trail_moves ?? null, bars: ex.data.bars ?? null, funding_r: ex.data.funding_r ?? null, slip_bp: ex.data.slip_bp ?? null });
    else {
      const px = hbData.prices && hbData.prices[en.symbol] ? hbData.prices[en.symbol].px : null, oneR = d.entry != null && d.sl != null ? Math.abs(d.entry - d.sl) : null;
      const tr = hbData.trail && hbData.trail[en.symbol];   // a trailing-stop bot's CURRENT stop (heartbeat), when it sends one
      open.push({ ...base, price: px, current_r: px != null && oneR ? r2(dir * (px - d.entry) / oneR, 2) : null, price_note: px != null ? 'last closed 4h candle' : 'no price yet',
        ...(tr ? { trail_stop: tr.stop ?? null, locked_r: tr.locked_r ?? null, best_r: tr.best_r ?? null, trail_moves: tr.moves ?? null } : {}) });
    }
  }
  trades.sort((a, b) => a.exit_ts - b.exit_ts);
  applyBooked(trades, booked, wallet);
  return { trades, open };
}

// what the page needs of a closed trade. The rest (ids, mode) only feeds the analysis in perf.js, which runs before this. The research detail (fill, size, balance) is kept for
// the Research tab's trade card: it is a few small numbers per trade.
const SHOWN = ['symbol', 'side', 'entry', 'sl', 'tp', 'exit', 'reason', 'r', 'usd', 'hold_sec', 'entry_ts', 'exit_ts', 'risk_pct',
  // the Research tab's trade card
  'signal_candle_open_ms', 'intended', 'slippage_r', 'delay_sec', 'fees_r', 'costs_kind', 'near_thr_pct', 'one_r', 'qty', 'risk_usd', 'balance_used', 'balance_after', 'fees_pct', 'slip_pct', 'funding',
  // trend capture (T-CORE lab)
  'mfe_r', 'mae_r', 'gave_back_r', 'stop_at_exit_r', 'trail_moves', 'bars', 'funding_r', 'slip_bp'];
const slim = (t) => { const o = {}; for (const k of SHOWN) o[k] = t[k] === undefined ? null : t[k]; return o; };

// every skipped signal by reason (the skipped list is capped at 200; these counts are not) and when the bot first reported
const skipCountsOf = (evs) => { const c = {}; for (const e of evs) if (e.type === 'signal' && e.data.decision === 'skipped') { const k = e.data.reason || 'unknown'; c[k] = (c[k] || 0) + 1; } return c; };
const firstOf = (evs) => (evs.length ? evs.reduce((m, e) => Math.min(m, e.ts_ms), Infinity) : null);

// skips by the news gate (reason "news_gate..."): how many, and the newest few with the gate's own words
function newsSkips(skipped, counts) {
  const list = (skipped || []).filter((s) => String(s.reason || '').startsWith('news_gate'));
  const total = Object.entries(counts || {}).filter(([k]) => k.startsWith('news_gate')).reduce((a, [, n]) => a + n, 0);
  return { total, recent: list.slice(0, 20) };
}
const botOfEv = (e) => (e.data && e.data.bot) || 'bbcore';   // rows without data.bot are BB-Core's
const isIcore = (e) => botOfEv(e) === 'icore';

// a short view of one bot: its own mode (from its heartbeat, else its newest event), balance, closed trades and what is open
// The same operational detail BB-Core's own page has (status, log, skipped signals, uptime), so every bot's Health and Positions & Activity pages are fed by that bot's own
// rows: status = what its last heartbeat said, activity = its newest events (no capital flows: those belong to the ledger), skipped = its newest skipped signals,
// uptime = its own 7-day heartbeat history (beats), last_exit_ms = when it last closed a trade.
const statusOf = (hbData) => ({ last_candle_ms: hbData.last_candle_ms || {}, commit: hbData.commit || null, version: hbData.version || null, uptime_sec: hbData.uptime_sec ?? null, next_wake_ms: hbData.next_wake_ms ?? null });
const skippedOf = (evs) => evs.filter((e) => e.type === 'signal' && e.data.decision === 'skipped').sort((a, b) => b.ts_ms - a.ts_ms).slice(0, 200)
  .map((e) => ({ ts: e.ts_ms, symbol: e.symbol, side: e.side, reason: e.data.reason, detail: e.data.detail, signal_candle_open_ms: e.data.signal_candle_open_ms }));
const lastExitOf = (evs) => evs.reduce((m, e) => (e.type === 'exit' && e.ts_ms > m ? e.ts_ms : m), 0) || null;
function botView(label, events, heartbeat, now, booked, wallet = null, beats = null) {
  if (!events.length && !heartbeat) return null;
  const modes = [...new Set(events.map((e) => e.mode).concat(heartbeat ? [heartbeat.mode] : []))].sort();
  const mode = (heartbeat && heartbeat.mode) || modes[modes.length - 1] || 'paper';
  const evs = events.filter((e) => e.mode === mode).sort((a, b) => a.ts_ms - b.ts_ms), hbData = (heartbeat && heartbeat.data) || {};
  const { trades, open } = pairTrades(evs, hbData, booked, wallet);
  const age = heartbeat ? now - heartbeat.ts_ms : null;
  return { label, mode, alive: heartbeat ? age <= STALE_MS : false, last_heartbeat_ms: heartbeat ? heartbeat.ts_ms : null, kill_switch: !!hbData.kill_switch,
    drawdown_r: hbData.drawdown_r ?? null, halt_r: hbData.halt_r ?? null, enabled_coins: hbData.enabled_coins || [], status: statusOf(hbData), skipped: skippedOf(evs), activity: activity(evs, []),
    uptime: uptime((beats || []).filter((b) => b.mode === mode), now), last_exit_ms: lastExitOf(evs),
    capital: capital(evs, trades, []), overall: stats(trades), open: open.length, open_list: open, trades, compares: comparesOf(evs), compare: latestCompare(evs), last_entry_ms: lastEntryOf(evs), skip_counts: skipCountsOf(evs), first_event_ms: firstOf(evs) };
}
const comparesOf = (evs) => evs.filter((e) => e.type === 'compare').sort((a, b) => b.ts_ms - a.ts_ms).slice(0, 5).map((e) => ({ match: !!e.data.match, ts: e.ts_ms, mismatches: (Array.isArray(e.data.mismatches) ? e.data.mismatches : []).slice(0, 20).map((m) => ({ kind: m.kind, symbol: m.symbol, side: m.side, signal_candle_open_ms: m.signal_candle_open_ms ?? null, why: String(m.why || '').slice(0, 300), ...(m.explained ? { explained: true } : {}) })) }));
// the newest compare result as the Verify tab shows it, and the newest entry fill (a fill after a refused order means the cause is gone)
// compares stored before the compare script flagged refused orders are read the same way (the exchange's own words): a refused order is a missed trade, not a logic difference
const latestCompare = (evs) => {
  const e = evs.filter((x) => x.type === 'compare').sort((a, b) => b.ts_ms - a.ts_ms)[0]; if (!e) return null;
  const d = { ts: e.ts_ms, ...e.data }, mm = Array.isArray(d.mismatches) ? d.mismatches : [];
  if (!mm.length) return d;
  const sp = splitMismatches(d), mark = new Set(sp.missed.concat(sp.followers));
  return { ...d, match: sp.other.length === 0, refused: sp.missed.length, explained: mark.size, mismatches: mm.map((m) => (mark.has(m) ? { ...m, explained: true } : m)) };
};
const lastEntryOf = (evs) => evs.reduce((m, e) => (e.type === 'entry' && e.ts_ms > m ? e.ts_ms : m), 0) || null;

// the capital of the bots added together. parts without a balance are listed in `missing`, so a partial sum is never mistaken for the whole.
function totalCapital(views) {
  const have = views.filter((v) => v && v.capital && Number.isFinite(v.capital.usd)), missing = views.filter((v) => v && !(v.capital && Number.isFinite(v.capital.usd))).map((v) => v.label);
  if (!have.length) return null;
  const sum = (f) => have.reduce((a, v) => a + (f(v) || 0), 0), start = sum((v) => v.capital.start_usd), change = sum((v) => v.capital.change_usd);
  return { usd: r2(sum((v) => v.capital.usd), 2), as_of: Math.max(...have.map((v) => v.capital.as_of)), start_usd: r2(start, 2), change_usd: r2(change, 2), change_pct: start ? r2((change / start) * 100, 2) : null,
    parts: have.map((v) => ({ label: v.label, mode: v.mode, usd: v.capital.usd, as_of: v.capital.as_of })), missing, paper: have.filter((v) => v.mode !== 'live').map((v) => v.label) };
}

// the real balance of each trading account from the wallet reports the VPS sends every 5 minutes (store.wallets()). Fresher than the bots' own equity events, which only
// come with a candle close and are absent when a bot does not share its live balance. `missing` lists wallets that never reported, so a partial sum is never taken for the whole.
function walletCapital(wallets, now) {
  const all = (wallets || []).filter((w) => w && w.wallet);
  if (!all.length) return null;
  const have = all.filter((w) => w.equity_usdt != null && Number.isFinite(+w.equity_usdt) && Number.isFinite(+w.received_ms));
  if (!have.length) return null;
  const parts = have.map((w) => ({ label: w.label || w.wallet, usd: r2(+w.equity_usdt, 2), as_of: +w.received_ms, age_ms: Math.max(0, now - +w.received_ms), open: w.open_positions == null ? null : +w.open_positions, suspect: !!w.suspect }));
  return { usd: r2(parts.reduce((a, p) => a + p.usd, 0), 2), as_of: Math.min(...parts.map((p) => p.as_of)), newest_ms: Math.max(...parts.map((p) => p.as_of)), parts,
    missing: all.filter((w) => !have.includes(w)).map((w) => w.label || w.wallet), open: parts.reduce((a, p) => a + (p.open || 0), 0) };
}

// the trading accounts added together over time, from the wallet reports: a point whenever any wallet reports, once every wallet has reported at least once
// (so the line never shows one account alone). At most 600 points, evenly thinned, always keeping the newest.
// every account added together over time. The accounts that report within the first 15 minutes are waited for (one 5-minute cycle can reach the
// ledger a little apart, and a point with one account alone would look like a fall); an account that starts reporting later (a new bot) joins the total
// from its first report, and the money it started with shows on the chart as a capital step (capital_flows), not as profit.
// Thinned by age so every range has detail: the last day as reported (5 minutes), the last week every 30 minutes, older every 2 hours (the last report in each).
const WALLET_JOIN_MS = 15 * 60000;
function walletHistory(rows) {
  const r = (rows || []).filter((x) => x && x.wallet && Number.isFinite(+x.ts) && Number.isFinite(+x.usd)).sort((a, b) => a.ts - b.ts);
  if (!r.length) return [];
  const first = new Map();
  for (const x of r) if (!first.has(x.wallet)) first.set(x.wallet, +x.ts);
  const wait = [...first].filter(([, t]) => t <= r[0].ts + WALLET_JOIN_MS).map(([w]) => w), last = new Map(), pts = [];
  for (const x of r) {
    last.set(x.wallet, +x.usd);
    if (!wait.every((w) => last.has(w))) continue;
    const p = { ts: +x.ts, usd: r2([...last.values()].reduce((a, v) => a + v, 0), 2) };
    if (pts.length && p.ts - pts[pts.length - 1].ts < 60000) pts[pts.length - 1] = p; else pts.push(p);   // one point per 5-minute cycle (its reports arrive seconds apart)
  }
  if (!pts.length) return [];
  const end = pts[pts.length - 1].ts, step = (t) => (end - t <= 864e5 ? 0 : end - t <= 7 * 864e5 ? 30 * 60000 : 2 * 36e5), out = [];
  for (let i = 0; i < pts.length; i++) {
    const s = step(pts[i].ts), n = pts[i + 1];
    if (!s || !n || Math.floor(n.ts / s) !== Math.floor(pts[i].ts / s) || step(n.ts) !== s) out.push(pts[i]);
  }
  return out;
}

// the data recorder's last heartbeat as the page shows it: regime of each coin and of the market, measured slippage, and the recorder's own health
const RECORDER_STALE_MS = 30 * 60 * 1000;
function recorderView(hb, now) {
  if (!hb) return null;
  const d = hb.data || {}, age = now - hb.ts_ms;
  return { ts: hb.ts_ms, age_ms: age, alive: age <= RECORDER_STALE_MS, stale_after_ms: RECORDER_STALE_MS, regime: d.regime || {}, regime_state: d.regime_state || {}, market: d.market || {}, market_state: d.market_state || null, slippage: d.slippage || {}, health: d.recorder || {}, server: d.server || {} };
}

function aggregate({ events: allEvents = [], heartbeat = null, icoreHeartbeat = null, bb1hHeartbeat = null, bbtrHeartbeat = null, tcoreHeartbeat = null, recorderHeartbeat = null, newsHeartbeats = null, coinHeartbeats = null, now = Date.now(), mode = null, beats = null, beatsBy = null, flows = null, wallets = null, walletHist = null, closedTrades = null } = {}) {
  const events = allEvents.filter((e) => botOfEv(e) === 'bbcore'), icoreEvents = allEvents.filter(isIcore), labEvents = allEvents.filter((e) => botOfEv(e) === 'bb1h'), trailEvents = allEvents.filter((e) => botOfEv(e) === 'bbtr'), tcoreEvents = allEvents.filter((e) => botOfEv(e) === 'tcore');   // the page below is BB-Core's, as before
  const modesSeen = [...new Set(events.map((e) => e.mode).concat(heartbeat ? [heartbeat.mode] : []))].sort();
  const useMode = mode || (heartbeat && heartbeat.mode) || modesSeen[modesSeen.length - 1] || 'paper';
  const evs = events.filter((e) => e.mode === useMode).sort((a, b) => a.ts_ms - b.ts_ms);

  const hbData = (heartbeat && heartbeat.data) || {};
  const { trades, open } = pairTrades(evs, hbData, closedTrades, 'bbcore');   // each bot's own MEXC account (closed_trades.wallet)
  let cum = 0, peak = 0;
  const curve = trades.map((t, i) => { cum += t.r; peak = Math.max(peak, cum); return { ts: t.exit_ts, n: i + 1, r_cum: r2(cum, 3), dd_r: r2(peak - cum, 3), symbol: t.symbol }; });
  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const perCoin = Object.fromEntries(symbols.map((s) => [s, stats(trades.filter((t) => t.symbol === s))]));

  const skipped = evs.filter((e) => e.type === 'signal' && e.data.decision === 'skipped').sort((a, b) => b.ts_ms - a.ts_ms).slice(0, 200)
    .map((e) => ({ ts: e.ts_ms, symbol: e.symbol, side: e.side, reason: e.data.reason, detail: e.data.detail, signal_candle_open_ms: e.data.signal_candle_open_ms }));
  const liveFlows = useMode === 'live' ? (flows || []) : [];   // capital movements belong to the real account; the paper balance has none
  const mainCapital = capital(evs, trades, liveFlows);
  const bb = beatsBy || {};
  const icView = botView('I-Core', icoreEvents, icoreHeartbeat, now, closedTrades, 'icore', bb.icore);
  const labView = botView('BB-1h lab', labEvents, bb1hHeartbeat, now, null, null, bb.bb1h);   // paper only: no booked money to match
  const trailView = botView('T-CORE lab', trailEvents, bbtrHeartbeat, now, null, null, bb.bbtr);   // paper only, judged against its own backtest
  const tcView = botView('T-CORE', tcoreEvents, tcoreHeartbeat, now, closedTrades, 'tcore', bb.tcore);   // live, its own MEXC account: dollars from the P&L MEXC booked
  const newsViews = {};   // the news lab paper bots: present once they report (events or a heartbeat)
  for (const [b, label] of Object.entries(NEWS_LABS)) {
    const v = botView(label, allEvents.filter((e) => botOfEv(e) === b), (newsHeartbeats || {})[b] || null, now, null, null, bb[b]);
    if (v) newsViews[b] = { ...v, trades: v.trades.map(slim), news_skips: newsSkips(v.skipped, v.skip_counts), ...(b === 'tcn' ? { trend: trendCapture(v.trades, 'bbtr') } : {}) };
  }
  const coinViews = {};   // the coin lab paper bots (SUI / ARB): present once they report (events or a heartbeat)
  for (const [b, label] of Object.entries(COIN_LABS)) {
    const v = botView(label, allEvents.filter((e) => botOfEv(e) === b), (coinHeartbeats || {})[b] || null, now, null, null, bb[b]);
    if (v) coinViews[b] = { ...v, trades: v.trades.map(slim), ...(b === 'ctc' ? { trend: trendCapture(v.trades, 'bbtr') } : {}) };
  }
  const live = icView || tcView;   // the "bots side by side" block exists once a second live bot reports
  const bbView = live ? { label: 'BB-Core', mode: useMode, capital: mainCapital, overall: stats(trades), open: open.length, alive: heartbeat ? now - heartbeat.ts_ms <= STALE_MS : false,
    last_heartbeat_ms: heartbeat ? heartbeat.ts_ms : null, kill_switch: !!hbData.kill_switch, drawdown_r: hbData.drawdown_r ?? null, halt_r: hbData.halt_r ?? null, enabled_coins: hbData.enabled_coins || [],
    last_exit_ms: lastExitOf(evs), last_entry_ms: lastEntryOf(evs) } : null;
  const lastHb = heartbeat ? heartbeat.ts_ms : null, age = lastHb != null ? now - lastHb : null;
  const lastUpdate = Math.max(0, lastHb || 0, ...evs.map((e) => e.ts_ms)) || null;   // newest thing the bot has told us (heartbeat or any event)
  return {
    generated_at: now, last_update_ms: lastUpdate, mode: useMode, modes_seen: modesSeen,
    status: heartbeat ? { alive: age <= STALE_MS, age_ms: age, stale_after_ms: STALE_MS, last_heartbeat_ms: lastHb, mode: heartbeat.mode, kill_switch: !!hbData.kill_switch, drawdown_r: hbData.drawdown_r ?? null, halt_r: hbData.halt_r ?? null,
      last_candle_ms: hbData.last_candle_ms || {}, commit: hbData.commit || null, version: hbData.version || null, uptime_sec: hbData.uptime_sec ?? null, next_wake_ms: hbData.next_wake_ms ?? null,
      enabled_coins: hbData.enabled_coins || [] }
      : { alive: false, age_ms: null, stale_after_ms: STALE_MS, last_heartbeat_ms: null, mode: useMode, note: 'no heartbeat received yet' },
    first_event_ms: firstOf(evs), skip_counts: skipCountsOf(evs),
    open, trades: trades.map(slim), equity: curve, per_coin: perCoin, overall: stats(trades), skipped,
    compare: latestCompare(evs), compares: comparesOf(evs),   // BB-Core (the others' are bots.<bot>.compare / .compares)
    bots: live ? { bbcore: bbView, ...(icView ? { icore: { ...icView, trades: icView.trades.map(slim) } } : {}),
      ...(tcView ? { tcore: { ...tcView, trades: tcView.trades.map(slim), trend: trendCapture(tcView.trades, 'bbtr') } } : {}) } : null,
    total_capital: live ? totalCapital([bbView, icView, tcView].filter(Boolean)) : null,
    labs: labView || trailView ? { ...(labView ? { bb1h: { ...labView, trades: labView.trades.map(slim) } } : {}),
      ...(trailView ? { bbtr: { ...trailView, trades: trailView.trades.map(slim), trend: trendCapture(trailView.trades, 'bbtr') } } : {}) } : null,
    news_labs: Object.keys(newsViews).length ? newsViews : null, coin_labs: Object.keys(coinViews).length ? coinViews : null, recorder: recorderView(recorderHeartbeat, now),
    wallet_capital: walletCapital(wallets, now), wallet_history: walletHistory(walletHist),
    capital_flows: (useMode === 'live' ? (flows || []) : []).filter((f) => f && Number.isFinite(+f.ts_ms) && Number.isFinite(+f.usdt) && +f.usdt !== 0).map((f) => ({ ts: +f.ts_ms, usd: r2(+f.usdt, 2), kind: f.kind })),
    capital: mainCapital, uptime: uptime((beats || []).filter((b) => b.mode === useMode), now), activity: activity(evs, liveFlows),
    perf: { bbcore: analyze(trades, { bot: 'bbcore', compares: comparesOf(evs), lastEntryMs: lastEntryOf(evs), now }), icore: icView ? analyze(icView.trades, { bot: 'icore', compares: icView.compares, lastEntryMs: icView.last_entry_ms, now }) : null,
      bb1h: labView ? analyze(labView.trades, { bot: 'bb1h', compares: labView.compares, lastEntryMs: labView.last_entry_ms, now }) : null,
      bbtr: trailView ? analyze(trailView.trades, { bot: 'bbtr', compares: trailView.compares, lastEntryMs: trailView.last_entry_ms, now }) : null,
      tcore: tcView ? analyze(tcView.trades, { bot: 'tcore', compares: tcView.compares, lastEntryMs: tcView.last_entry_ms, now }) : null,
      ...Object.fromEntries(Object.keys(NEWS_LABS).map((b) => [b, newsViews[b] ? analyze(newsViews[b].trades, { bot: b, compares: newsViews[b].compares, lastEntryMs: newsViews[b].last_entry_ms, now }) : null])),
      ...Object.fromEntries(Object.keys(COIN_LABS).map((b) => [b, coinViews[b] ? analyze(coinViews[b].trades, { bot: b, compares: coinViews[b].compares, lastEntryMs: coinViews[b].last_entry_ms, now }) : null])) },
  };
}

module.exports = { aggregate, NEWS_LABS, COIN_LABS, stats, pairTrades, botView, totalCapital, walletHistory, STALE_MS };

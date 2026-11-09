// monthly.js - the monthly Telegram report: one message, one block per LIVE bot (BB-CORE, I-CORE, T-CORE) and a summary of all the accounts together.
// Pure: aggregate() output in, text out (no clock, no network). Paper bots and labs are never included: a bot counts only while its own mode is 'live'.
//   per bot   trades closed in the month, result in R and dollars, drawdown (peak to lowest point inside the month) in R and dollars
//   summary   all live bots together: trades, win rate, result (R, % of the balance at the start of the month, dollars), worst drawdown of the combined account,
//             best and worst bot. The % needs every live bot's balance at the start of the month; when one is not known the % is left out, never guessed.
// Months are UTC calendar months, by the time a trade closed.
'use strict';

const BOTS = [['bbcore', 'BB-CORE'], ['icore', 'I-CORE'], ['tcore', 'T-CORE']];
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
const monthRange = (key) => { const [y, m] = key.split('-').map(Number); return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) }; };
const previousMonth = (now) => { const d = new Date(now); return monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)); };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthTitle = (key) => `${MONTH_NAMES[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;

// running totals over closed trades (already in exit order): total, worst fall from the highest point so far (a positive number), win count
function walk(trades, pick) {
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += pick(t); peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { total: eq, dd };
}
function summarize(trades) {
  const byExit = [...trades].sort((a, b) => a.exit_ts - b.exit_ts);
  const r = walk(byExit, (t) => t.r);
  const dollars = byExit.length > 0 && byExit.every((t) => finite(t.usd));   // all or nothing: a half-known dollar figure would be wrong
  const u = dollars ? walk(byExit, (t) => t.usd) : null;
  return { trades: byExit.length, wins: byExit.filter((t) => t.r > 0).length, r: r.total, dd_r: r.dd, usd: u ? u.total : byExit.length ? null : 0, dd_usd: u ? u.dd : byExit.length ? null : 0 };
}

// the balance of one bot at the start of the month, from its equity / exit readings (capital.points); null when it never reported one that early
function balanceAt(capital, from) {
  const pts = capital && Array.isArray(capital.points) ? capital.points.filter((p) => finite(p.usd) && p.ts <= from) : [];
  return pts.length ? pts[pts.length - 1].usd : null;
}

// views: [{ key, label, mode, trades, capital }]  ->  the numbers of the report
function monthlyReport(views, month) {
  const { from, to } = monthRange(month);
  const bots = [];
  for (const v of views) {
    if (!v || v.mode !== 'live') continue;   // no paper, no labs
    const trades = (v.trades || []).filter((t) => finite(t.exit_ts) && t.exit_ts >= from && t.exit_ts < to && finite(t.r));
    bots.push({ key: v.key, label: v.label, ...summarize(trades), trade_list: trades, start_balance: balanceAt(v.capital, from) });
  }
  const all = bots.flatMap((b) => b.trade_list);
  const total = summarize(all);
  const bases = bots.map((b) => b.start_balance);
  const base = bots.length && bases.every((b) => finite(b) && b > 0) ? bases.reduce((a, b) => a + b, 0) : null;
  const pct = (usd) => (base && finite(usd) ? (usd / base) * 100 : null);
  return { month, bots, total: { ...total, win_rate: total.trades ? total.wins / total.trades : null, pct: pct(total.usd), dd_pct: pct(total.dd_usd == null ? null : total.dd_usd) } };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fr = (v) => { const n = Math.round(Math.abs(v) * 10) / 10; return `${n === 0 ? '' : v < 0 ? '-' : '+'}${n.toFixed(1)}R`; };
const fu = (v) => { const n = Math.round(Math.abs(v) * 100) / 100; return `${n === 0 ? '' : v < 0 ? '-' : '+'}$${n.toFixed(2)}`; };
const fp = (v) => { const n = Math.round(Math.abs(v) * 10) / 10; return `${n === 0 ? '' : v < 0 ? '-' : '+'}${n.toFixed(1)}%`; };
const dd = (r) => (Math.round(r * 10) === 0 ? '0.0R' : '-' + Math.abs(Math.round(r * 10) / 10).toFixed(1) + 'R');
const ddu = (u) => (Math.round(u * 100) === 0 ? '$0.00' : '-$' + Math.abs(Math.round(u * 100) / 100).toFixed(2));
const row = (name, text) => `${name.padEnd(10)}${text}`;

// the Telegram message (HTML: bold header, one monospace block per bot)
function monthlyText(rep) {
  const L = [`📅 <b>MONTHLY REPORT · ${esc(monthTitle(rep.month))}</b>`];
  if (!rep.bots.length) return L.concat('', 'No live bot reported this month.').join('\n');
  for (const b of rep.bots) {
    const rows = [
      row('Trades', String(b.trades)),
      row('Result', `${fr(b.r)}${b.usd == null ? '' : `  (${fu(b.usd)})`}`),
      row('Drawdown', `${dd(b.dd_r)}${b.dd_usd == null ? '' : `  (${ddu(b.dd_usd)})`}`),
    ];
    L.push('', `<b>━━ ${esc(b.label)} ━━</b>`, `<pre>${esc(rows.join('\n'))}</pre>`);
  }
  const t = rep.total;
  const money = (usd, pct) => `${pct != null ? `  (${fp(pct)})` : ''}${usd != null ? `  ${fu(usd)}` : ''}`;
  const sum = [
    `${t.trades} trade${t.trades === 1 ? '' : 's'}${t.win_rate == null ? '' : ` · win ${Math.round(t.win_rate * 100)}%`}`,
    row('Result', `${fr(t.r)}${money(t.usd, t.pct)}`),
    row('Worst DD', `${dd(t.dd_r)}${t.dd_usd == null ? '' : `${t.dd_pct != null ? `  (-${Math.abs(Math.round(t.dd_pct * 10) / 10).toFixed(1)}%)` : ''}  ${ddu(t.dd_usd)}`}`),
  ];
  if (rep.bots.length > 1) {
    const sorted = [...rep.bots].sort((a, b) => b.r - a.r), best = sorted[0], worst = sorted[sorted.length - 1], w = Math.max(...rep.bots.map((b) => b.label.length));
    sum.push(row('Best', `${best.label.padEnd(w)}  ${fr(best.r)}`), row('Worst', `${worst.label.padEnd(w)}  ${fr(worst.r)}`));
  }
  L.push('', '<b>━━ SUMMARY (all accounts) ━━</b>', `<pre>${esc(sum.join('\n'))}</pre>`);
  return L.join('\n');
}

// the three live bots out of an aggregate() answer
function viewsFrom(agg) {
  const b = agg.bots || {};
  return [
    { key: 'bbcore', label: 'BB-CORE', mode: (b.bbcore && b.bbcore.mode) || agg.mode, trades: agg.trades, capital: agg.capital },
    ...BOTS.slice(1).map(([key, label]) => (b[key] ? { key, label, mode: b[key].mode, trades: b[key].trades, capital: b[key].capital } : null)),
  ].filter(Boolean);
}

module.exports = { monthlyReport, monthlyText, viewsFrom, previousMonth, monthRange, monthTitle, summarize };

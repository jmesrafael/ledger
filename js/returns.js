// returns.js: the return maths for the ledger, shared by the app (window.Returns) and the tests (require).
// Plain numbers in, plain numbers out: no page, no database.
//
// Two different returns, on purpose:
//  * Trading return: what the trading did to money while it was in. Only the unit price moves it, so money added or
//    taken out (top-ups, withdrawals) never shows up as a gain or a loss, and neither does the profit share.
//  * Your return: the same, but counting the profit share as part of the result (an investor pays it, the manager
//    receives it). It is a time-weighted return: at every pool event, take out the money that came in or went out at that
//    event, and chain what is left. Each step's growth = (value now − money added at this step) / value before.
//
// Every function returns a cumulative growth factor per point (1 = nothing gained yet). The return between two
// points i and j is g[j] / g[i] − 1, so any date range can be read off the same series.
(function (root, factory) {
  const R = factory();
  if (typeof module === 'object' && module.exports) module.exports = R; else root.Returns = R;
})(typeof self !== 'undefined' ? self : this, function () {
  const EPS = 1e-9;

  // pts: one person's history, oldest first: { v: value after the event, n: net money put in so far }
  function yourGrowth(pts) {
    const g = []; let f = 1;
    pts.forEach((b, i) => {
      if (i > 0) { const a = pts[i - 1]; if (a.v > EPS) f *= (b.v - (b.n - a.n)) / a.v; }
      g.push(f);
    });
    return g;
  }

  // pts: { u: units held after the event, price: unit price at the event }. Only price changes count, and only over the
  // steps where units were held (someone who left and came back does not get the moves made while they were out).
  function tradingGrowth(pts) {
    const g = []; let f = 1;
    pts.forEach((b, i) => {
      if (i > 0) { const a = pts[i - 1]; if (a.u > EPS && a.price > 0) f *= b.price / a.price; }
      g.push(f);
    });
    return g;
  }

  // fund rows from fund_returns: { price, mgr }, oldest first. The manager's own money = price changes while it was in.
  const managerGrowth = (rows) => tradingGrowth(rows.map((r) => ({ u: r.mgr ? 1 : 0, price: Number(r.price) })));

  const between = (g, i, j) => (g.length ? g[j] / g[i] - 1 : 0);   // return from point i to point j
  const total = (g) => (g.length ? g[g.length - 1] / g[0] - 1 : 0);

  // ---------------------------------------------------------------- calendar months (Philippine time, UTC+8, so a month changes when people's clocks do)
  const PH = 8 * 36e5;
  const monthStart = (ms) => { const d = new Date(ms + PH); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - PH; };
  const nextMonth = (ms) => { const d = new Date(ms + PH); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - PH; };
  const monthKey = (ms) => new Date(ms + PH).toISOString().slice(0, 7);

  // One row per calendar month since the person joined.
  //   H: the person's history points, oldest first: { ts, value, net_in, units, price }  (one per pool event; value only changes at events)
  //   L: the person's own ledger rows: { ts, kind, usdt, units, php_amount, php_rate }
  // opening + deposits - withdrawals + trading + profitShare = closing   (exactly; profitShare is negative for an investor, positive for the manager)
  // tradingPct = what the trading did (unit price only); yourPct = the same after the profit share. Money in or out never counts in either.
  function monthly(H, L, now = Date.now()) {
    const pts = (H || []).map((p) => ({ t: typeof p.ts === 'number' ? p.ts : Date.parse(p.ts), v: Number(p.value), n: Number(p.net_in), u: Number(p.units), price: Number(p.price) }));
    if (!pts.length) return [];
    const gy = yourGrowth(pts), gt = tradingGrowth(pts), rows = [];
    const lg = (L || []).map((l) => ({ t: typeof l.ts === 'number' ? l.ts : Date.parse(l.ts), kind: l.kind, note: l.note || '', usdt: Number(l.usdt), pa: l.php_amount == null ? null : Number(l.php_amount), pr: l.php_rate == null ? null : Number(l.php_rate) }));
    const lastBefore = (limit) => { let k = -1; for (let i = 0; i < pts.length; i++) { if (pts[i].t < limit) k = i; else break; } return k; };
    for (let from = monthStart(pts[0].t); from <= now; from = nextMonth(from)) {
      const to = nextMonth(from), o = lastBefore(from), c = lastBefore(to);
      if (c < 0) continue;
      const base = o >= 0 ? o : 0, inM = lg.filter((l) => l.t >= from && l.t < to);
      const sum = (f) => inM.filter(f).reduce((t, l) => t + l.usdt, 0);
      const deposits = sum((l) => l.kind === 'deposit'), withdrawals = -sum((l) => l.kind === 'withdrawal'), profitShare = sum((l) => l.kind === 'fee_in' || l.kind === 'fee_out');
      const withdrawalFee = -sum((l) => l.kind === 'fee_out' && l.note === 'withdrawal fee');
      const opening = o >= 0 ? pts[o].v : 0, closing = pts[c].v;
      rows.push({ key: monthKey(from), from, to, partial: to > now, opening, deposits, withdrawals, withdrawalFee, profitShare, closing,
        trading: closing - opening - deposits + withdrawals - profitShare,
        tradingPct: gt[c] / gt[base] - 1, yourPct: gy[c] / gy[base] - 1, entries: inM.length,
        phpIn: inM.filter((l) => l.kind === 'deposit').reduce((t, l) => t + (l.pa != null ? l.pa : l.usdt * (l.pr || 0)), 0),
        phpOut: -inM.filter((l) => l.kind === 'withdrawal').reduce((t, l) => t + l.usdt * (l.pr || 0), 0) });
    }
    return rows;
  }

  // Worst fall from a previous high in a cumulative growth series g (1 = start), with the dates t. Based on the readings we have.
  function drawdown(g, t) {
    if (!g.length) return null;
    let pk = g[0], pkI = 0, worst = 0, wp = 0, wt = 0, top = g[0], topI = 0;
    g.forEach((v, i) => { if (v > pk) { pk = v; pkI = i; } const d = v / pk - 1; if (d < worst) { worst = d; wp = pkI; wt = i; } if (v > top) { top = v; topI = i; } });
    let rec = null; for (let i = wt + 1; i < g.length && worst < 0; i++) if (g[i] >= g[wp]) { rec = i; break; }
    return { worst, peakAt: worst < 0 ? t[wp] : null, troughAt: worst < 0 ? t[wt] : null, recoveredAt: rec == null ? null : t[rec],
             current: g[g.length - 1] / top - 1, highAt: t[topI] };
  }

  // Pesos the person really paid in and took out, and what the exchange rate did, vs. valuing everything at today's rate.
  //   rows: own ledger rows. rateNow: pesos per USDT today.
  //   fx = what the pesos paid in (net of pesos paid out) are worth today above or below what was paid, i.e. the part of the peso gain that is just the exchange rate.
  function pesos(rows, rateNow) {
    let inPhp = 0, outPhp = 0, dep = 0, wd = 0;
    for (const l of rows || []) {
      const usdt = Number(l.usdt), pr = l.php_rate == null ? rateNow : Number(l.php_rate);
      if (l.kind === 'deposit') { inPhp += l.php_amount != null ? Number(l.php_amount) : usdt * pr; dep += usdt; }
      else if (l.kind === 'withdrawal') { outPhp += -usdt * pr; wd += -usdt; }
    }
    return { inPhp, outPhp, net: inPhp - outPhp, netUsdt: dep - wd, fx: (dep * rateNow - inPhp) - (wd * rateNow - outPhp) };
  }

  // CSV (opens in Excel / Google Sheets): quotes only when needed; numbers are written plainly
  const csvCell = (v) => { const t = v == null ? '' : String(v); return /[,"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const toCsv = (columns, rows) => [columns.map((c) => csvCell(c[0])).join(','), ...rows.map((r) => columns.map((c) => csvCell(c[1](r))).join(','))].join('\r\n') + '\r\n';

  return { yourGrowth, tradingGrowth, managerGrowth, between, total, EPS, monthStart, nextMonth, monthKey, monthly, drawdown, pesos, toCsv };
});

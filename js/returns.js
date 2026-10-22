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

  return { yourGrowth, tradingGrowth, managerGrowth, between, total, EPS };
});

// livefund.js: the Fund dashboard's live capital card. The numbers come from /api/fund-live, the same 5-minute MEXC wallet reports (every live trading account added
// together) and capital flows that the bot dashboard's "Live capital" chart uses, so both pages show the same line and the same "from trading" figure.
// Two views: Capital (the real balance; money added or paid out shows as a labelled step) and Trading only (deposits and payouts taken out). The maths matches
// bot-dashboard/app.js walletSeries() / inRange() / renderChart(). Shared by the app (window.LiveFund) and the tests (require).
(function (root, factory) {
  const L = factory();
  if (typeof module === 'object' && module.exports) module.exports = L; else root.LiveFund = L;
})(typeof self !== 'undefined' ? self : this, function () {
  const RANGES = [['1D', 1, 'past day'], ['1W', 7, 'past week'], ['1M', 30, 'past month'], ['ALL', null, 'since the first report']];
  const KINDS = [['capital', 'Capital'], ['trading', 'Trading only']];

  // the wallet history with deposits and payouts taken out. A deposit is recorded a little before or after the balances show it, so it is taken out at the jump it
  // made: the biggest step its way within 2 hours of it (no report near it: from when it was recorded).
  function adjusted(wh, flows) {
    const at = new Array(wh.length).fill(0);
    for (const f of flows || []) {
      let best = -1, big = -Infinity;
      for (let i = 1; i < wh.length; i++) if (Math.abs(wh[i].ts - f.ts) <= 72e5) { const st = (wh[i].usd - wh[i - 1].usd) * Math.sign(f.usd); if (st > big) { big = st; best = i; } }
      if (best < 0) { best = wh.findIndex((p) => p.ts >= f.ts); if (best < 0) best = wh.length - 1; }
      at[best] += f.usd;
    }
    let cum = 0;
    return wh.map((p, i) => ({ ts: p.ts, y: p.usd - (cum += at[i]) }));
  }
  // points before the range are dropped and the line starts at the range start with the value it had then; flat until now when nothing changed since
  function inRange(pts, days, now) {
    if (!days || !pts.length) return pts;
    const start = now - days * 864e5, before = pts.filter((p) => p.ts < start).pop(), out = pts.filter((p) => p.ts >= start);
    if (before) out.unshift({ ts: start, y: before.y });
    const last = out[out.length - 1];
    if (last && last.ts < now - 36e5) out.push({ ts: now, y: last.y });
    return out;
  }
  // live = the /api/fund-live answer. Returns null without two reports; else the points to draw, the flows inside the range and the change from trading.
  function view(live, range, kind, now = Date.now()) {
    const wh = (live && live.wallet_history) || [];
    if (wh.length < 2) return null;
    const r = RANGES.find((x) => x[0] === range) || RANGES[1], flows = (live.capital_flows || []).filter((f) => Number.isFinite(f.ts) && Number.isFinite(f.usd) && f.usd !== 0);
    if (kind === 'trading') {
      const pts = inRange(adjusted(wh, flows), r[1], now), base = pts[0].y;
      return { kind, range: r, pts: pts.map((p) => ({ ts: p.ts, y: p.y - base })), marks: [], change: pts[pts.length - 1].y - base, base, now: wh[wh.length - 1].usd, flowSum: 0, firstTs: wh[0].ts };
    }
    const pts = inRange(wh.map((p) => ({ ts: p.ts, y: p.usd })), r[1], now), a = pts[0], z = pts[pts.length - 1];
    const marks = flows.filter((f) => f.ts > a.ts && f.ts <= z.ts), flowSum = marks.reduce((t, f) => t + f.usd, 0);
    return { kind, range: r, pts, marks, change: z.y - a.y - flowSum, base: a.y, now: z.y, flowSum, firstTs: wh[0].ts };
  }
  // the % the change is of where the range started (a trading-only line starts at 0, so its % is of the real balance at that time)
  const changePct = (v) => (v.base > 0 ? v.change / v.base : 0);

  // the chart: the line and its soft area, a labelled step where money was added or paid out (steps close together share one label, their sum),
  // a few dollar lines on the value axis and dates (or clock times for a day) along the bottom. fmt = { axis(n), when(ms) }
  function svg(v, fmt) {
    const W = 300, H = 150, pts = v.pts, xs = pts.map((p) => p.ts), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad = (y1 - y0) * 0.12 || Math.abs(y1) * 0.02 || 1; y0 -= pad; y1 += pad;
    const X = (t) => ((t - x0) / (x1 - x0)) * W, Y = (y) => H - ((y - y0) / (y1 - y0)) * H;
    const up = v.change >= 0, color = `var(--${up ? 'up' : 'down'})`;
    const raw = (y1 - y0) / 3, mag = 10 ** Math.floor(Math.log10(raw || 1)), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) || raw;
    const grid = [];
    for (let g = Math.ceil(y0 / step) * step; g <= y1; g += step) grid.push(`<line x1="0" x2="${W}" y1="${Y(g).toFixed(2)}" y2="${Y(g).toFixed(2)}" stroke="var(--muted)" stroke-opacity=".18" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
    const labels = [];
    for (let g = Math.ceil(y0 / step) * step; g <= y1; g += step) labels.push(`<span style="top:${((Y(g) / H) * 100).toFixed(2)}%">${fmt.axis(Math.abs(g) < step * 1e-9 ? 0 : g)}</span>`);
    const steps = [];
    for (const m of [...v.marks].sort((a, b) => a.ts - b.ts)) { const s = steps[steps.length - 1]; if (s && X(m.ts) - X(s.ts) < 18 && (s.usd >= 0) === (m.usd >= 0)) s.usd += m.usd; else steps.push({ ts: m.ts, usd: m.usd }); }
    const flowLines = steps.map((m) => `<line x1="${X(m.ts).toFixed(2)}" x2="${X(m.ts).toFixed(2)}" y1="0" y2="${H}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`).join('');
    const flowTags = steps.map((m, i) => { const x = (X(m.ts) / W) * 100; return `<span class="lf-flow ${m.usd >= 0 ? 'in' : 'out'}" style="${x > 70 ? `right:${(100 - x).toFixed(2)}%` : `left:${x.toFixed(2)}%`};top:${i % 3 * 16}px">${m.usd >= 0 ? '+' : '−'}$${Math.abs(m.usd).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${m.usd >= 0 ? 'capital' : 'payout'}</span>`; }).join('');
    const line = pts.map((p) => `${X(p.ts).toFixed(2)},${Y(p.y).toFixed(2)}`).join(' ');
    const short = x1 - x0 <= 2 * 864e5, ticks = [0, 1, 2, 3, 4].map((i) => x0 + ((x1 - x0) * i) / 4);
    return { W, H, X, Y, color, html: `<div class="lf-wrap"><div class="lf-axis">${labels.join('')}</div>${flowTags}
      <svg id="lfc" class="growth lf" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Live fund capital over time">
        <defs><linearGradient id="lffill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style="stop-color:${color};stop-opacity:.34"/><stop offset="70%" style="stop-color:${color};stop-opacity:.06"/><stop offset="100%" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
        ${grid.join('')}${flowLines}
        <polygon fill="url(#lffill)" points="0,${H} ${line} ${X(pts[pts.length - 1].ts).toFixed(2)},${H}"/>
        <polyline class="ln" fill="none" style="stroke:${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${line}"/>
        <line id="lfx" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--muted)" stroke-opacity=".6" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
      </svg><span class="dot live" id="lfdot"></span></div>
      <div class="lf-x">${ticks.map((t) => `<span>${fmt.when(t, short)}</span>`).join('')}</div>` };
  }

  return { RANGES, KINDS, adjusted, inRange, view, changePct, svg };
});

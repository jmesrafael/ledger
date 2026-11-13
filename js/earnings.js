// earnings.js: what the fund manager has earned from each investor (profit-share fees). Manager screens only. No accounting is done here: every figure is a sum of
// ledger rows the database already wrote (kind 'fee_out' = the fee leaving the investor, in units and USDT at the price of that moment) and of the fee each investor
// would be charged now (accrued_fee_usdt from admin_overview). Shared by the app (window.Earnings) and the tests (require).
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E; else root.Earnings = E;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

  // per investor: fees already taken (USDT at the time, units, how many times, last date) and the fee that would be taken now
  function byInvestor(ledger, holders) {
    const rows = (holders || []).filter((h) => h.role === 'investor').map((h) => {
      const fees = (ledger || []).filter((l) => l.kind === 'fee_out' && l.profile_id === h.id);
      return { id: h.id, name: h.name || h.username, rate: n(h.fee_rate), active: h.active !== false,
        fee_usdt: fees.reduce((t, l) => t + Math.abs(n(l.usdt)), 0), fee_units: fees.reduce((t, l) => t + Math.abs(n(l.units)), 0),
        count: fees.length, last: fees.reduce((m, l) => (!m || String(l.ts) > m ? String(l.ts) : m), null), accrued_usdt: Math.max(0, n(h.accrued_fee_usdt)) };
    });
    return { rows, total_usdt: rows.reduce((t, r) => t + r.fee_usdt, 0), total_units: rows.reduce((t, r) => t + r.fee_units, 0), total_accrued: rows.reduce((t, r) => t + r.accrued_usdt, 0) };
  }

  // the card at the top of Users. fmt = the app's money formatter; day = its date formatter
  function card(e, fmt, day) {
    const body = e.rows.map((r) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(r.name)}</b><br><span class="note">${r.count ? `${r.count} fee${r.count === 1 ? '' : 's'} taken${r.last ? ', last ' + esc(day(r.last)) : ''}` : 'no fee taken yet'} · share ${(r.rate * 100).toFixed(0)}%</span></span>
      <span class="r"><b>${fmt(r.fee_usdt)}</b>${r.accrued_usdt > 0 ? `<br><span class="note">+ ${fmt(r.accrued_usdt)} building up</span>` : ''}</span></div>`).join('');
    return `<div class="card" data-earnings><h2>Earned from investors</h2>
      <div class="grid"><div class="stat"><div class="k">Fees received</div><div class="v">${fmt(e.total_usdt)}</div></div>
        <div class="stat"><div class="k">Building up (next settlement)</div><div class="v">${fmt(e.total_accrued)}</div></div></div>
      <p class="note" style="margin:8px 0">Only profit is charged. Each fee moves as units from the investor to your account and is counted here at the price of that day. "Building up" is what would be taken if it were settled now.</p>
      ${body || '<p class="note">No investors yet.</p>'}</div>`;
  }

  // two lines for one person's sheet
  const lines = (r, fmt) => (r ? `<div class="row"><span class="l">Fees you earned from them</span><span class="r"><b>${fmt(r.fee_usdt)}</b>${r.count ? `<br><span class="note">${r.count} fee${r.count === 1 ? '' : 's'}</span>` : ''}</span></div>
    <div class="row"><span class="l">Building up now</span><span class="r">${fmt(r.accrued_usdt)}</span></div>` : '');

  return { byInvestor, card, lines };
});

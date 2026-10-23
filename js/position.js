// position.js: how an investor's money position is DISPLAYED. No accounting here: every number comes from the database (my_position, which
// passes through the engine's own summary) and is only formatted. Shared by the app (window.Position) and the tests (require).
(function (root, factory) {
  const P = factory();
  if (typeof module === 'object' && module.exports) module.exports = P; else root.Position = P;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // f = { money(usdt), day(ts) } supplied by the page
  const STATE = {
    awaiting_approval: 'Waiting for review', queued: 'Waiting', ready: 'Approved, being prepared', payout_awaiting: 'Redeemed, payout being prepared',
    payout_sent: 'Payout sent', payout_failed: 'Payout problem, being retried', completed: 'Paid', completed_legacy: 'Paid', rejected: 'Not approved', cancelled: 'Cancelled',
    awaiting_arrival: 'Money not yet seen in the trading account', queued_dep: 'Waiting to join',
  };
  const stateText = (s) => STATE[s] || s;

  function estimateCard(pos, f) {
    const e = pos.estimate, lv = e.last_verified;
    if (e.reliable) {
      return `<div class="card hero"><h2>Estimated value after fees <span class="chip">Estimate</span></h2>
        <div class="big" data-k="estimate">${f.money(e.value_after_fee_usdt)}</div>
        <p class="note">An estimate, not a payout promise: it moves with the trading${e.includes_open_trades ? ' and includes trades that are still open' : ''}. After the performance fee still to be charged: ${f.money(e.accrued_fee_usdt)}. Final amounts are fixed only when the fee is settled or a withdrawal is paid.</p></div>`;
    }
    return `<div class="card hero"><h2>Value being verified <span class="chip">Unverified</span></h2>
      <div class="big" data-k="unverified">Waiting for verification</div>
      <p class="note">${esc(e.reason)}</p>
      ${lv ? `<div class="row"><span class="l">Last verified estimate<br><span class="note">${f.day(lv.as_of)}</span></span><span class="r" data-k="lastverified">${f.money(lv.value_after_fee_usdt)}</span></div>` : ''}</div>`;
  }
  function capitalCard(pos, f) {
    const c = pos.capital, r = (l, v, k, note) => `<div class="row"><span class="l">${l}${note ? `<br><span class="note">${note}</span>` : ''}</span><span class="r" data-k="${k}">${v}</span></div>`;
    return `<div class="card"><h2>Where your money stands</h2>
      ${r('Money you put in', f.money(c.contributed_usdt), 'contributed', 'deposits only; never counted as profit')}
      ${r('Money you took out', f.money(c.withdrawn_usdt), 'withdrawn', 'withdrawals only; never counted as a loss')}
      ${r('Trading result before fees', f.money(c.trading_result_before_fees_usdt), 'gross')}
      ${r('Performance fees already charged', f.money(c.fees_paid_usdt), 'feespaid', 'final')}
      ${r('Performance fee still to be charged', f.money(c.fees_accrued_usdt), 'feesaccrued', 'estimate until the next settlement')}
      ${r('Net result after fees', f.money(c.net_performance_usdt), 'net', 'estimate')}</div>`;
  }
  function settlementsCard(pos, f) {
    const s = pos.settlements || [];
    return `<div class="card"><h2>Profit-sharing records <span class="chip">Final</span></h2>${s.length ? s.map((x) => `<div class="row"><span class="l">${f.day(x.ts)}<br><span class="note">${x.kind === 'quarter_close' ? 'Two-month settlement' : 'Taken at a withdrawal'}</span></span><span class="r" data-k="settlement">${f.money(x.fee_usdt)}</span></div>`).join('') : '<p class="note">No fee has been settled yet.</p>'}</div>`;
  }
  function requestsCard(pos, f) {
    const items = [...(pos.deposits || []).map((d) => ({ t: 'Deposit', amt: d.usdt, state: d.state === 'awaiting_arrival' ? 'awaiting_arrival' : 'queued_dep', reason: d.reason, at: d.received_at })),
      ...(pos.withdrawals || []).filter((w) => !['cancelled'].includes(w.state)).map((w) => ({ t: 'Withdrawal', amt: null, units: w.units, state: w.state, reason: w.reason, at: w.requested_at, delayed: w.delayed, ref: w.payout && w.payout.status === 'completed' ? w.payout.reference : null, pay_by: w.pay_by }))];
    if (!items.length) return '';
    return `<div class="card"><h2>Your requests</h2>${items.map((x) => `<div class="row"><span class="l"><b>${x.t}</b> · ${f.day(x.at)}<br><span class="note" data-k="state">${esc(stateText(x.state))}${x.delayed ? ' · later than planned' : ''}</span>${x.reason ? `<br><span class="note">${esc(x.reason)}</span>` : ''}</span>${x.amt != null ? `<span class="r">${f.money(x.amt)}</span>` : ''}</div>`).join('')}</div>`;
  }
  const render = (pos, f) => estimateCard(pos, f) + capitalCard(pos, f) + settlementsCard(pos, f) + requestsCard(pos, f);
  return { render, estimateCard, capitalCard, settlementsCard, requestsCard, stateText, esc };
});

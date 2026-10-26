// poolupdate.js: what the manager SEES for pending P/L, Update Pool and the reconciliation. No accounting here: every number comes from the database
// (admin_pool_status, admin_pending_pnl); this file only words it and builds the request. Shared by the app (window.PoolUpdate) and the tests (require).
(function (root, factory) {
  const P = factory();
  if (typeof module === 'object' && module.exports) module.exports = P; else root.PoolUpdate = P;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (v) => Number(v == null ? 0 : v);
  const f2 = (v) => Math.abs(num(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (v) => (num(v) > 0 ? '+' : num(v) < 0 ? '−' : '') + f2(v) + ' USDT';
  // "Oct 22, 2026" (the manager's date style); tz 'UTC' in tests
  const day = (ms, tz) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });

  const pending = (st) => (st && st.pending) || { count: 0, usd: 0, r: 0, missing_usd: 0, ids: [], exits: [] };
  const count = (st) => num(pending(st).count);

  // "3 trades, +41.20 USDT pending since Oct 22, 2026". null when nothing is pending (no banner).
  function banner(st, tz) {
    const p = pending(st), n = num(p.count);
    if (!n) return null;
    const amount = num(p.missing_usd) > 0 ? (num(p.missing_usd) === n ? 'dollar amount not shared by the bot' : signed(p.usd) + ' known, ' + num(p.missing_usd) + ' without a dollar amount') : signed(p.usd);
    return `${n} trade${n === 1 ? '' : 's'}, ${amount} pending since ${day(p.oldest_ms, tz)}`;
  }

  // The Update Pool button needs a confirmed, flat balance check. The ONE reason it may still be listed is the unexplained difference:
  // explaining it with the pending trades is what Update Pool itself does.
  function ready(rd) {
    const reasons = ((rd && rd.reasons) || []).filter((r) => r.code !== 'unresolved_difference');
    return { ok: !!(rd && rd.verification_id) && reasons.length === 0, vid: rd && rd.verification_id, reasons: reasons.map((r) => r.text || r.code) };
  }

  // Exactly what the screen displayed goes to the server: the exit ids and the total shown. The server refuses if they changed in between.
  function request(st, vid, idem, opts = {}) {
    const p = pending(st);
    return { p_vid: vid, p_event_ids: (p.ids || []).slice(), p_expected_usd: num(p.usd), p_idem: idem, ...(opts.confirm ? { p_confirm: true } : {}), ...(opts.note ? { p_note: opts.note } : {}) };
  }
  const requestAndAdmit = (st, vid, idem, depositIds, opts = {}) => ({ ...request(st, vid, idem, opts), p_pending_ids: (depositIds || []).map(Number) });

  // what a deposit/payout button should do while trades are pending: no plain "Admit"; point at Update Pool instead
  const admitMode = (st) => (count(st) > 0 ? 'update_first' : 'admit');

  // reconciliation, in words
  const STATUS = {
    ok: ['up', 'Reconciled'],
    mismatch: ['down', 'MISMATCH'],
    waiting_snapshot: ['', 'Waiting for the next bot reading (something changed after the last one)'],
    stale_snapshot: ['warn', 'The bot reading is old'],
    no_snapshot: ['warn', 'No bot reading yet'],
    incomplete: ['warn', 'Some pending trades have no dollar amount'],
  };
  function reconCard(st) {
    const r = st && st.recon; if (!r) return '';
    const [cls, label] = STATUS[r.status] || ['', r.status];
    const parts = r.parts || {};
    const rows = r.expected == null ? '' : `
      <div class="row"><span class="l">Exchange futures equity (bot reading)</span><span class="r">${f2(r.observed)} USDT</span></div>
      <div class="row"><span class="l">Pool value</span><span class="r">${f2(parts.pool_nav)} USDT</span></div>
      <div class="row"><span class="l">+ pending trades</span><span class="r">${signed(parts.pending_pnl)}</span></div>
      <div class="row"><span class="l">+ open trades (unrealized)</span><span class="r">${signed(parts.unrealized)}</span></div>
      <div class="row"><span class="l">+ redeemed, payout not sent yet</span><span class="r">${f2(parts.redeemed_not_sent)} USDT</span></div>
      ${parts.queued_location === 'futures' ? `<div class="row"><span class="l">+ queued money (in futures)</span><span class="r">${f2(parts.queued_money)} USDT</span></div>` : ''}
      <div class="row"><span class="l"><b>Expected</b></span><span class="r"><b>${f2(r.expected)} USDT</b></span></div>
      <div class="row"><span class="l"><b>Difference</b> (tolerance ${f2(r.tolerance)})</span><span class="r ${r.status === 'mismatch' ? 'down' : 'up'}"><b>${signed(r.mismatch)}</b></span></div>`;
    return `<div class="card" data-pool="recon"><h2>Reconciliation <span class="chip ${cls}">${esc(label)}</span></h2>${rows}
      ${r.status === 'mismatch' ? '<p class="note"><b class="warn">Update Pool, joins and payouts are blocked</b> until the difference is explained (a missed transfer, fees or funding, or a trade that was not reported).</p>' : ''}
      ${(st.blocks || []).length ? `<details><summary class="note">Last ${st.blocks.length} block${st.blocks.length === 1 ? '' : 's'}</summary>${st.blocks.map((b) => `<div class="row"><span class="l">${esc(b.source)} · ${esc(b.status)}</span><span class="r note">${esc(String(b.ts).slice(0, 16).replace('T', ' '))} UTC</span></div>`).join('')}</details>` : ''}</div>`;
  }

  // the Pending P/L card for the Balance desk
  function pendingCard(st, rd, tz) {
    const p = pending(st), n = num(p.count), rr = ready(rd), b = banner(st, tz);
    const list = (p.exits || []).map((e) => `<div class="row"><span class="l">${esc(String(e.symbol || '').replace('_USDT', ''))} ${esc(e.side || '')}<br><span class="note">${day(e.ts_ms, tz)}</span></span><span class="r ${num(e.usd) < 0 ? 'down' : 'up'}">${e.usd == null ? 'no $ amount' : signed(e.usd)}</span></div>`).join('');
    if (!n) return `<div class="card" data-pool="pending"><h2>Pending P/L</h2><p class="note"><b class="up">None.</b> Every closed live trade is already applied to the pool. Joins and payouts are open.</p></div>`;
    return `<div class="card" data-pool="pending"><h2>Pending P/L</h2>
      <p class="warn"><b>${esc(b)}</b></p>
      <p class="note">These closed live trades have <b>not</b> changed anyone's value. Update Pool sets the pool to the confirmed Exchange balance, and these trades must explain the change. Until then nobody can join or be paid out.</p>
      ${list}
      <div class="btns">${rr.ok ? '<button data-action="poolupdate">Update Pool</button>' : `<button disabled>Update Pool</button>`}</div>
      ${rr.ok ? '' : `<p class="note">${rr.reasons.length ? esc(rr.reasons.join(' ')) : 'Enter and confirm a fresh Exchange balance with no open trade first.'}</p>`}</div>`;
  }
  return { banner, ready, request, requestAndAdmit, admitMode, pendingCard, reconCard, count, signed, day, STATUS };
});

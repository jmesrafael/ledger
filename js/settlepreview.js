// settlepreview.js: shows what admin_settlement_preview (the database's own read-only preview) returned, in plain words. NO accounting here:
// every figure is printed exactly as the database sent it; nothing is added, multiplied or estimated. A value the database did not send is
// shown as "Not available", never as 0. Works with the preview of every migration level (fields added later are shown only when present).
// Shared by the app (window.SettlePreview) and the tests (require).
(function (root, factory) {
  const S = factory();
  if (typeof module === 'object' && module.exports) module.exports = S; else root.SettlePreview = S;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NA = '<span class="muted">Not available</span>';
  const has = (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v));
  const isNum = (v) => has(v) && Number.isFinite(Number(v));

  // fmt: { usdt(n), units(n), day(ts), pc(rate) } from the app (display formatting only)
  function render(pv, fmt) {
    if (!pv || typeof pv !== 'object') return unavailable('The database returned no preview.');
    const money = (v) => (isNum(v) ? esc(fmt.usdt(v)) : NA);
    const when = (v) => (has(v) ? esc(fmt.day(v)) : NA);
    const row = (l, r) => `<div class="row"><span class="l">${l}</span><span class="r">${r}</span></div>`;
    const reasons = Array.isArray(pv.blocked_reasons) ? pv.blocked_reasons : [];
    const warnings = Array.isArray(pv.warnings) ? pv.warnings : [];
    const verdict = pv.can_settle === true ? '<span class="chip up">The database allows this settlement</span>'
      : pv.can_settle === false ? '<span class="chip down">The database would refuse this settlement</span>' : `<span class="chip">Settlement status ${NA}</span>`;
    const lines = Array.isArray(pv.lines) ? pv.lines : null;
    const extra = lines && lines.some((l) => has(l.confirmed_profit_usdt) || has(l.pending_profit_usdt));   // the later "confirmed gain" fee shows more columns
    const lineHtml = !lines ? row('Per investor', NA) : lines.length ? lines.map((l) => `<div class="card inner" data-sp="line">
        <div class="unm">${esc(l.name || l.username || 'Investor')}</div>
        ${row('Units', has(l.units) ? esc(fmt.units(l.units)) : NA)}${row('Worth at this balance', money(l.value_usdt))}
        ${row('High-water mark now', money(l.hwm_usdt))}${row('Gain above the mark', money(l.eligible_profit_usdt))}
        ${extra ? row('Confirmed gain', money(l.confirmed_profit_usdt)) + row('Gain still pending', money(l.pending_profit_usdt)) : ''}
        ${row(`Fee at ${has(l.fee_rate) ? esc(fmt.pc(l.fee_rate)) + '%' : NA}`, `<b>${money(l.fee_usdt)}</b>${has(l.fee_units) ? `<br><span class="note">${esc(fmt.units(l.fee_units))} units</span>` : ''}`)}
        ${row('Worth after the fee', money(l.value_after_usdt))}${row('High-water mark after', money(l.hwm_after_usdt))}</div>`).join('')
      : '<p class="note">No investor holds units, so no fee would be charged.</p>';
    const rec = pv.recon && typeof pv.recon === 'object' ? pv.recon : null;
    const waiting = Array.isArray(pv.waiting_deposits_admitted_after) ? pv.waiting_deposits_admitted_after : null;
    return `<div class="card" data-sp="preview" aria-live="polite"><h2>Settlement preview</h2>
      <p class="note">Worked out by the database from the exchange total you entered. Nothing is saved by a preview.</p>
      <p>${verdict}</p>
      ${reasons.length ? `<div class="warn" data-sp="blocked"><b>Why not:</b><ul>${reasons.map((r) => `<li>${esc(typeof r === 'string' ? r : JSON.stringify(r))}</li>`).join('')}</ul></div>` : ''}
      ${warnings.length ? `<div class="note" data-sp="warnings"><b>Heads-up:</b><ul>${warnings.map((r) => `<li>${esc(typeof r === 'string' ? r : JSON.stringify(r))}</li>`).join('')}</ul></div>` : ''}
      ${row('Period', has(pv.period_start) || has(pv.period_end) ? `${when(pv.period_start)} to ${when(pv.period_end)}` : NA)}
      ${has(pv.window_end) ? row('On-time window closes', when(pv.window_end)) : ''}
      ${pv.late === true ? row('Timing', '<span class="warn">Late: needs an approved exception</span>') : ''}${pv.backdated === true ? row('Dating', '<span class="warn">Backdated: needs an approved exception</span>') : ''}
      ${has(pv.open_positions) && Number(pv.open_positions) > 0 ? row('Open trades or orders', `<span class="warn">${esc(pv.open_positions)}</span>`) : has(pv.open_positions) ? row('Open trades or orders', '0') : row('Open trades or orders', NA)}
      ${row('Exchange total entered', money(pv.mexc_total))}${row('Pool value (NAV)', money(pv.nav))}${row('Unit price', isNum(pv.unit_price) ? esc(Number(pv.unit_price).toFixed(6)) : NA)}
      ${row('Reconciliation', rec && has(rec.status) ? esc(String(rec.status).replace(/_/g, ' ')) : NA)}
      ${waiting && waiting.length ? row('Waiting deposits that join after the fees', esc(waiting.length)) : ''}
      <h2 style="margin-top:14px">Fees</h2>${lineHtml}
      ${row('<b>Total fee</b>', `<b>${money(pv.fee_usdt)}</b>${has(pv.fee_units) ? `<br><span class="note">${esc(fmt.units(pv.fee_units))} units</span>` : ''}`)}</div>`;
  }

  // a short version for the confirmation sheet: the database's total and its own verdict, nothing recomputed
  function summary(pv, fmt) {
    if (!pv || typeof pv !== 'object') return `<p class="warn">Fee: ${NA}</p>`;
    const fee = isNum(pv.fee_usdt) ? `<b>${esc(fmt.usdt(pv.fee_usdt))}</b>${has(pv.fee_units) ? ` (${esc(fmt.units(pv.fee_units))} units)` : ''}` : NA;
    const charged = Array.isArray(pv.lines) ? pv.lines.filter((l) => Number(l.fee_usdt) > 0).length : null;
    return `<p>The database's preview: total fee ${fee}${charged === null ? '' : ` from ${esc(charged)} investor${charged === 1 ? '' : 's'}`}.</p>`
      + (pv.can_settle === false ? '<p class="warn">The database says this settlement would be refused. It may ask you to approve an exception.</p>' : '');
  }
  const unavailable = (msg) => `<div class="card" data-sp="unavailable"><h2>Settlement preview</h2><p class="warn">Preview not available. ${esc(msg)}</p>
    <p class="note">No figure is shown rather than a guessed one. The database has to answer first.</p></div>`;
  const loading = () => '<div class="card" data-sp="loading" aria-live="polite"><h2>Settlement preview</h2><p class="note">Asking the database…</p></div>';
  return { render, summary, unavailable, loading };
});

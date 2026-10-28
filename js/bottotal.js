// bottotal.js: the "Read from the bots" button beside every Exchange total field. The bots on the VPS send each futures wallet's equity every 5 minutes
// (wallet_snapshots, migration 20261130000000); admin_wallet_nav returns the latest report per wallet. This adds those up, lists each wallet with its age and
// status, and says what the sum does NOT cover (money in Spot, open trades). It fills the field only; nothing is saved until the manager presses the form's button.
// Shared by the app (window.BotTotal) and the tests (require).
(function (root, factory) {
  const B = factory();
  if (typeof module === 'object' && module.exports) module.exports = B; else root.BotTotal = B;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const STATUS = { stale: 'old report', suspect: 'big jump, not accepted', outdated: 'payout sent since', missing: 'never reported' };

  // the button and the box its result is printed in; form = the form id, field = the input's name
  const button = (form, field) => `<div class="btns" style="margin-top:4px"><button type="button" class="ghost sm" data-action="bottotal" data-form="${esc(form)}" data-field="${esc(field)}">Read from the bots</button></div><div class="note" data-botbox aria-live="polite"></div>`;

  // nav = what admin_wallet_nav returned. Returns { ok, total, wallets, warnings }; ok is false when no wallet has reported (then total is null).
  function read(nav) {
    const wallets = ((nav && nav.wallets) || []).filter((w) => has(w.equity_usdt));
    if (!wallets.length) return { ok: false, total: null, wallets: [], warnings: ['No bot has reported a balance yet.'] };
    const total = Math.round(wallets.reduce((s, w) => s + Number(w.equity_usdt), 0) * 100) / 100;
    const warnings = [], open = wallets.reduce((s, w) => s + (Number(w.open_positions) || 0), 0);
    for (const w of wallets) {
      if (w.status !== 'ok') warnings.push(`${w.label || w.wallet}: ${STATUS[w.status] || w.status}. Check this wallet in the exchange before using the total.`);
    }
    if (open > 0) warnings.push(`${open} trade${open === 1 ? ' is' : 's are'} open: the total includes ${open === 1 ? 'its' : 'their'} unrealised P/L and moves until ${open === 1 ? 'it closes' : 'they close'}.`);
    return { ok: true, total, wallets, warnings };
  }

  // the result under the field. fmt = { usdt(n) }
  function html(r, fmt) {
    if (!r.ok) return `<span class="warn">${r.warnings.map(esc).join(' ')}</span>`;
    const age = (s) => (has(s) ? (Number(s) < 90 ? 'just now' : Math.round(Number(s) / 60) + ' min ago') : '');
    const rows = r.wallets.map((w) => `${esc(w.label || w.wallet)}: <b>${esc(fmt.usdt(w.equity_usdt))}</b> <span class="muted">(${esc(age(w.age_seconds))}${has(w.open_positions) && Number(w.open_positions) > 0 ? ', ' + esc(w.open_positions) + ' open' : ''})</span>`);
    return `Bots now: ${rows.join(' · ')} = <b>${esc(fmt.usdt(r.total))}</b>, filled in above.`
      + `<br>Not included: money still in <b>Spot</b> (the main account or a sub-account). Add it to the field yourself.`
      + (r.warnings.length ? `<br><span class="warn">${r.warnings.map(esc).join('<br>')}</span>` : '');
  }

  return { button, read, html };
});

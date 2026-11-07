// truevalue-ui.js: what the pages SHOW for true-value pricing (migration 20261207000000). No accounting here: every number comes from the database
// (admin_true_value for the manager, my_true_value for an investor); this file only words it. Shared by the app (window.TrueValueUI) and the tests (require).
// Before the migration is run both calls fail and the app passes null: nothing is shown.
(function (root, factory) {
  const T = factory();
  if (typeof module === 'object' && module.exports) module.exports = T; else root.TrueValueUI = T;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const usd = (v) => (num(v) == null ? '—' : `${num(v) < 0 ? '−' : ''}${Math.abs(num(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`);
  const signed = (v) => (num(v) == null ? '—' : (num(v) > 0 ? '+' : '') + usd(v));
  const price = (v) => (num(v) == null ? '—' : num(v).toFixed(4));
  const ago = (iso, now) => { if (!iso) return 'never'; const m = Math.round((Date.parse(now || new Date().toISOString()) - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : `${m} min ago`; };
  const row = (l, r, note) => `<div class="row"><span class="l">${l}${note ? `<br><span class="note">${note}</span>` : ''}</span><span class="r">${r}</span></div>`;
  const texts = (reasons) => (reasons || []).map((x) => (typeof x === 'string' ? x : x.text));

  // the one line that says whether money can join or leave now, and why not
  function state(t) {
    if (!t) return null;
    if (t.allowed) return { ok: true, text: `Money can join or leave now at ${price(t.unit_price)} per unit.` };
    const why = texts(t.reasons);
    if (!t.enabled) return { ok: false, off: true, text: why.length ? `True-value pricing is off. If it were on, money could not move now: ${why.join('; ')}.` : 'True-value pricing is off: deposits and payouts use the normal steps. This reading is a preview.' };
    return { ok: false, text: `Money cannot join or leave right now: ${why.join('; ')}.` };
  }

  // manager: price, the reading behind it, every wallet, the checkpoints and the prepared corrections
  function adminCard(t) {
    if (!t) return '';
    const s = state(t), now = t.as_of;
    const wallets = (t.wallets || []).map((w) => row(`${esc(w.label || w.wallet)} <span class="note">· ${esc(w.status)}</span>`,
      `${usd(w.equity_usdt)}<br><span class="note">open ${signed(w.unrealized_usdt)} · ${ago(w.received_at, now)}</span>`)).join('');
    const cps = (t.checkpoints || []).slice(0, 10).map((c) => row(`${esc({ deposit: 'Deposit', withdrawal: 'Payout', settlement: 'Settlement' }[c.kind] || c.kind)} #${esc(c.subject_id)} <span class="note">· ${esc(String(c.created_at).slice(0, 16).replace('T', ' '))} UTC</span>`,
      `${usd(c.amount_usdt)} at ${price(c.unit_price)}`, `book ${usd(c.book_before)} · open ${signed(c.open_pnl)} · gap ${signed(c.gap)}${Number(c.realized_since) ? ` · priced as of ${esc(String(c.priced_as_of).slice(0, 16).replace('T', ' '))} UTC` : ''} · ${(c.wallets || []).length} wallet reports kept`)).join('');
    const cor = (t.corrections || []).map((c) => row(`Correction #${esc(c.id)} <span class="note">· ${esc(c.status)}</span>`, signed(c.amount_usdt), esc(c.reason))).join('');
    return `<div class="card" data-tv="admin"><h2>True value</h2>
      <p class="${s.ok ? 'good' : s.off ? 'note' : 'warn'}">${esc(s.text)}</p>
      ${row('True unit price', price(t.unit_price), 'what a unit is worth if every open trade closed now')}
      ${row('Book unit price', price(t.book_price), 'closed trades only (what the pool value shows)')}
      ${row('Exchange value', usd(t.true_value_usdt), `wallets ${usd(t.combined_equity_usdt)} − waiting ${usd(t.not_in_pool_usdt)} − redeemed not sent ${usd(t.redeemed_not_sent_usdt)}`)}
      ${row('Open trades', signed(t.open_pnl_usdt))}
      ${row('Exchange vs books + open trades', signed(t.gap_usdt), `allowed difference ${usd(t.tolerance_usdt)}`)}
      ${row('Cash that can leave the exchange now', usd(t.pool_cash_usdt), 'withdrawable, after money waiting and payouts not sent')}
      ${wallets ? `<h3>Wallet reports</h3>${wallets}` : ''}
      ${cps ? `<h3>Checkpoints (every true-value deposit, payout and settlement)</h3>${cps}` : ''}
      ${cor ? `<h3>Book corrections</h3>${cor}<p class="note">Prepared corrections change nothing until they are applied one by one.</p>` : ''}</div>`;
  }

  // investor: only their own numbers, and only when true-value pricing is on
  function investorCard(m) {
    if (!m || !m.enabled) return '';
    const s = state(m);
    return `<div class="card" data-tv="mine"><h2>Your money right now</h2>
      ${row('Value', usd(m.value_usdt), 'if every open trade closed now')}
      ${row('Can be withdrawn now', usd(m.withdrawable_now_usdt), 'your share of the cash that can leave the exchange today')}
      ${row('Tied up in open trades', usd(m.locked_in_trades_usdt), 'becomes cash as the trades close')}
      <p class="note">${esc(s.text)}</p></div>`;
  }

  return { state, adminCard, investorCard };
});

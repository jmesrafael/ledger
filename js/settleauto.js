// settleauto.js: the Settle tab once the two-month settlement runs by itself (migration 20261214000000_auto_settlement.sql). No accounting here: every figure is
// the database's own (admin_settlement_status), this file only words it. Shared by the app (window.SettleAuto) and the tests (require).
(function (root, factory) {
  const A = factory();
  if (typeof module === 'object' && module.exports) module.exports = A; else root.SettleAuto = A;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const usd = (v, d = 2) => (v == null || v === '' ? '—' : `${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} USDT`);
  const row = (l, r, note) => `<div class="row"><span class="l">${l}${note ? `<br><span class="note">${note}</span>` : ''}</span><span class="r">${r}</span></div>`;
  // a date in the settlement's own time zone (Manila), so "Jan 1" is Jan 1 for the manager wherever the browser is
  const dayIn = (iso, tz) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: tz || 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  // the last day of a period or window: its end is the first instant of the next day
  const lastDay = (iso, tz) => (iso ? dayIn(new Date(Date.parse(iso) - 1000).toISOString(), tz) : '—');

  // one sentence: where the calendar stands
  function headline(st) {
    const tz = st.timezone, on = st.auto === 'on';
    if (st.state === 'settled') return `<p><b class="up">● Settled.</b> The period that ended ${lastDay(st.period_end, tz)} is settled. The next one ends ${lastDay(st.next_period_end, tz)}${on ? ' and settles by itself at the first verified MEXC reading after that' : ''}.</p>`;
    if (st.state === 'due') {
      const why = st.last_waiting ? ` Waiting: ${esc(st.last_waiting.reason)}.` : '';
      return `<p class="warn"><b>● Due now.</b> The period ended ${lastDay(st.period_end, tz)}; the window closes after ${lastDay(st.window_end, tz)}. ${on ? 'It settles by itself at the next verified MEXC reading.' : 'Automatic settlement is off: press Settle now.'}${why}</p>`;
    }
    if (st.state === 'missed') return `<p><b>● Not settled for the period that ended ${lastDay(st.period_end, tz)}</b> (its window closed ${lastDay(st.window_end, tz)}). Nothing is lost: each investor's mark is their own, so the settlement after ${lastDay(st.next_period_end, tz)} charges everything above it.</p>`;
    return `<p><b>● No period has ended yet.</b> The first settlement is after ${lastDay(st.next_period_end, tz)}.</p>`;
  }

  // the Settle tab. st = admin_settlement_status, or null when the database does not have it yet
  function card(st) {
    if (!st) return '<div class="card"><h2>Two-month settlement</h2><p class="note">The automatic settlement is not on this database yet (run <b>20261214000000_auto_settlement.sql</b>). Nothing is charged until it is.</p></div>';
    const tz = st.timezone, lines = st.lines || [], last = st.last_settlement;
    const rule = st.open_trades_rule === 'wait' ? 'It waits for a reading with no open trade.' : 'Open trades are included at the MEXC price, once: the mark moves to that price, so the same profit is not charged again when the trade closes.';
    const who = lines.map((l) => row(`<b style="color:var(--ink)">${esc(l.name)}</b>`, Number(l.fee_usdt) > 0 ? usd(l.fee_usdt, 4) : 'no fee',
      `worth ${usd(l.value_usdt)} · mark ${usd(l.mark_usdt)} · profit above the mark ${usd(l.profit_above_mark_usdt)} · share ${(Number(l.fee_rate) * 100).toFixed(0)}%${Number(l.fee_units) > 0 ? ` · ${Number(l.fee_units).toFixed(4)} units move to you` : ''}`)).join('');
    const now = st.price_ok
      ? `${who || '<p class="note">No investor holds units.</p>'}${row('<b style="color:var(--ink)">Total to your account</b>', usd(st.fee_usdt_now, 4), `at unit price ${Number(st.unit_price).toFixed(4)}${Number(st.open_positions) > 0 ? ` · ${st.open_positions} position(s) open` : ''}`)}`
      : `<p class="warn">The price is paused, so nothing can be worked out or charged: ${esc((st.price_reasons || []).map((x) => (typeof x === 'string' ? x : x.text)).join('; ') || 'no complete set of wallet reports')}.</p>`;
    return `<div class="card" data-settle="auto"><h2>Two-month settlement</h2>${headline(st)}
      <p class="note">Automatic settlement is <b>${st.auto === 'on' ? 'on' : 'off'}</b>. Only profit is cut: each investor's share (their own %) of what their value is <b>above their mark</b> (the mark is what they put in, raised after every fee). At or below the mark nothing is charged. The cut moves as <b>units</b> from the investor to your account, inside the pool: the pool's total and the unit price do not move. ${rule}</p>
      ${st.state === 'due' ? `<div class="btns"><button data-action="settlenow" ${st.price_ok ? '' : 'disabled'}>Settle now</button></div>` : ''}</div>
    <div class="card"><h2>If it were settled now</h2><p class="note">Worked out by the database at the live MEXC price. Nothing is saved by looking.</p>${now}</div>
    <div class="card"><h2>Last settlement</h2>${last ? row(`${dayIn(last.valued_at, tz)} · period to ${lastDay(last.period_end, tz)}`, usd(last.fee_usdt, 4),
      `${last.investors_charged} investor(s) charged · unit price ${Number(last.unit_price).toFixed(4)} · ${last.automatic ? 'automatic' : 'by the manager'}`) : '<p class="note">None yet.</p>'}</div>`;
  }

  // the confirmation before the manager settles by hand
  const confirmBody = (st) => `<p class="note">This charges <b>${esc(usd(st.fee_usdt_now, 4))}</b> in total from ${(st.lines || []).filter((l) => Number(l.fee_usdt) > 0).length} investor(s), at the live MEXC price, and ends the period. It cannot be undone.</p>`;

  return { card, headline, confirmBody, dayIn, lastDay };
});

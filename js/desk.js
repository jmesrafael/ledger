// desk.js: the fund manager's four routine steps (ADD INVESTOR, CASH IN, WITHDRAW, TRANSFER) and the live NAV status (migration 20261213000000_live_nav.sql).
// No accounting here: every figure comes from the database (admin_quote_cash_in, admin_quote_withdraw_now, admin_quote_transfer, admin_nav, my_nav); this file
// only words it and builds the forms. Shared by the app (window.Desk) and the tests (require). Before the migration is run the app passes null and shows the
// older Record screens instead.
(function (root, factory) {
  const D = factory();
  if (typeof module === 'object' && module.exports) module.exports = D; else root.Desk = D;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const usd = (v, d = 2) => (num(v) == null ? '—' : `${num(v) < 0 ? '−' : ''}${Math.abs(num(v)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} USDT`);
  const peso = (v) => (num(v) == null ? '—' : '₱' + Math.abs(num(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const price = (v) => (num(v) == null ? '—' : num(v).toFixed(4));
  const mins = (iso, now) => (iso ? Math.max(0, Math.round(((now || Date.now()) - Date.parse(iso)) / 60000)) : null);
  const ago = (iso, now) => { const m = mins(iso, now); return m == null ? 'never' : m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const row = (l, r, note) => `<div class="row"><span class="l">${l}${note ? `<br><span class="note">${note}</span>` : ''}</span><span class="r">${r}</span></div>`;
  const texts = (reasons) => (reasons || []).map((x) => (typeof x === 'string' ? x : x.text));
  const box = (name, label) => `<label style="display:flex;gap:8px;align-items:flex-start"><input name="${name}" type="checkbox" style="width:auto;min-height:0;margin-top:3px"> <span>${label}</span></label>`;
  const boxOn = (name, label) => box(name, label).replace('type="checkbox"', 'type="checkbox" checked');

  // the Record tab: the four steps first, the accounting screens after them
  const ACTIONS = [['add', 'Add investor'], ['cash', 'Cash in'], ['out', 'Withdraw'], ['move', 'Transfer']];
  const BOOKS = [['nav', 'Live NAV'], ['dep', 'Money in (by hand)'], ['wd', 'Money out (by hand)'], ['eq', 'Balance'], ['hist', 'History']];
  const isDesk = (rec) => ACTIONS.some(([k]) => k === rec) || rec === 'nav';
  const tabs = (rec) => `<div class="ranges" style="margin:12px 0 0" data-desk>${ACTIONS.map(([k, l]) => `<button class="${rec === k ? 'on' : ''}" data-rec="${k}">${l}</button>`).join('')}</div>
    <details class="desk-books" style="margin:8px 0 0" ${BOOKS.some(([k]) => k === rec) ? 'open' : ''}><summary class="note">Accounting: live NAV, by-hand entries, balance, history</summary>
      <div class="ranges" style="margin:8px 0 0">${BOOKS.map(([k, l]) => `<button class="${rec === k ? 'on' : ''}" data-rec="${k}">${l}</button>`).join('')}</div></details>`;

  // one line: is the price current, when was it measured, and why not when it is not (the manager gets the reason; an investor only the time)
  function navLine(n, now) {
    if (!n || !n.live) return '';
    const when = ago(n.ts || n.measured_at, now);
    if (n.current) return `<span class="note"><b class="up">● Live</b> · unit price ${price(n.unit_price)} · from the MEXC wallets ${when}</span>`;
    return `<span class="note"><b class="warn">● Paused</b> · last verified price ${price(n.unit_price)} ${when}${n.reasons_now && n.reasons_now.length ? `: ${esc(texts(n.reasons_now).join('; '))}` : ''}</span>`;
  }

  // ---------------------------------------------------------------- forms
  const rateField = (rate) => `<label>PHP/USD rate (₱ per USDT)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate ? Number(rate).toFixed(4) : ''}">
    <p class="note" style="margin:4px 0 0">Today's live rate, pre-filled. The database records it and refuses one more than 2% from the fund's stored reference.</p>`;
  const recvFields = (rate) => `<div class="grid form2"><div><label>Pesos paid (₱)</label><input name="php" type="number" step="any" inputmode="decimal" placeholder="5000"></div>
      <div><label>USDT that arrived in MEXC</label><input name="usdt" type="number" step="any" inputmode="decimal" placeholder="79.00" required></div></div>
    ${rateField(rate)}
    ${boxOn('inmexc', 'It is in MEXC now, in a bot\'s Futures account (it joins at the first verified reading that shows it)')}`;

  function addForm(o) {
    return `<div class="card"><h2>Add investor</h2>
      <p class="note">Creates the account and records the first cash-in in one step. The investor is credited <b>pesos ÷ rate</b>: if less USDT arrived, the gap comes from your units; if more, the rest is yours. Units are bought at the live price, so nobody else's value moves.</p>
      <form id="addForm"><div class="grid form2"><div><label>Full name</label><input name="name" required></div>
        <div><label>Username (they sign in with it)</label><input name="username" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\\-]{3,30}" required></div></div>
        <div class="grid form2"><div><label>Temporary password</label><input name="password" type="text" minlength="8" autocomplete="off" required></div>
          <div><label>Profit share (%)</label><input name="fee" type="number" step="any" min="0" max="100" value="${o.defaultFee == null ? 20 : Number(o.defaultFee) * 100}"></div></div>
        ${recvFields(o.rate)}
        <div class="preview" id="addPrev">—</div><button class="full">Add investor and cash in</button></form></div>`;
  }
  function cashForm(o) {
    return `<div class="card"><h2>Cash in</h2>
      <p class="note">Pesos (or USDT) someone put in. Leave the pesos empty for money sent in USDT. It joins at the live price as soon as the MEXC reports show it: no Update Pool, no waiting for trades to close.</p>
      <form id="cashForm"><label>Who</label><select name="who">${o.holderOpts}</select>
        ${recvFields(o.rate)}
        <details><summary>More options</summary><label>Note</label><input name="note"></details>
        <div class="preview" id="cashPrev">—</div><button class="full">Cash in</button></form></div>${waitingCard(o.cashins, o.now)}`;
  }
  function waitingCard(list, now) {
    const w = (list || []).filter((c) => c.status === 'waiting');
    if (!w.length) return '';
    return `<div class="card"><h2>Waiting to join (${w.length})</h2>
      <p class="note">Each one joins by itself at the first verified wallet reading that shows the money (reports come every 5 minutes). Nothing here earns or loses until then.</p>
      ${w.map((c) => row(`<b style="color:var(--ink)">${esc(c.name)}</b> · ${ago(c.created_at, now)}`,
        `${c.arrived ? '' : `<button class="sm" data-action="cashrecv" data-id="${c.id}">It is in MEXC</button> `}${c.arrived ? `<button class="sm ghost" data-action="cashadmit" data-id="${c.id}">Try now</button> ` : ''}<button class="ghost sm" data-action="cashcancel" data-id="${c.id}">Hand back</button>`,
        `${c.php_amount ? `${peso(c.php_amount)} at ₱${Number(c.fx_rate).toFixed(2)} = ` : ''}${usd(c.credited_usdt, 4)} credited · ${usd(c.received_usdt, 4)} arrived${num(c.topup_usdt) > 0 ? ` · ${usd(c.topup_usdt, 4)} from your units` : ''}${num(c.surplus_usdt) > 0 ? ` · ${usd(c.surplus_usdt, 4)} yours` : ''} · ${c.arrived ? 'in MEXC: waiting for a report that shows it' : '<span class="warn">not in MEXC yet</span>'}`)).join('')}</div>`;
  }
  function outForm(o) {
    const reqs = (o.requests || []).filter((q) => q.status === 'pending');
    const pays = (o.payouts || []).filter((p) => p.status === 'awaiting' || p.status === 'failed');
    return `${reqs.length ? `<div class="card"><h2>Requests from investors (${reqs.length})</h2>
        ${reqs.map((q) => row(`<b style="color:var(--ink)">${esc(q.name || '')}</b> · ${esc(String(q.requested_at || '').slice(0, 10))}`, `<button class="sm" data-action="procreq" data-id="${q.id}">Process</button>`,
          `${Number(q.units).toFixed(4)} units · about ${usd(Number(q.units) * Number(o.unitPrice))}${q.stage ? ` · ${esc(q.stage)}` : ''}`)).join('')}</div>` : ''}
      <div class="card"><h2>Withdraw</h2>
      <p class="note">Redeemed at the live price in one step (request, approval, redemption). It is refused, with nothing saved, if MEXC cannot release that much right now (open trades hold margin). Then send it from MEXC and mark it sent.</p>
      <form id="outForm"><label>Who</label><select name="who">${o.holderOpts}</select>
        <label>Amount (USDT)</label><input name="usdt" type="number" step="any" inputmode="decimal" placeholder="50">
        ${box('all', 'Everything they hold')}
        <label>Lock-up reason (only if they are inside their first-deposit lock-up)</label><input name="lock" placeholder="for example: family emergency, agreed by phone">
        <details><summary>More options</summary><label>Note</label><input name="note"></details>
        <div class="preview" id="outPrev">—</div><button class="full">Withdraw</button></form></div>
      ${pays.length ? `<div class="card"><h2>To send from MEXC (${pays.length})</h2>
        ${pays.map((p) => row(`<b style="color:var(--ink)">${esc(p.name || '')}</b>`, `<button class="sm" data-action="paysent" data-id="${p.request_id}">Mark sent</button>`,
          `${usd(p.amount_usdt, 4)} · ${esc(p.status)}${p.failure_reason ? ' · ' + esc(p.failure_reason) : ''}`)).join('')}</div>` : ''}`;
  }
  function moveForm(o) {
    return `<div class="card"><h2>Transfer</h2>
      <p class="note">Moves ownership from one holder to another at the live price. No money enters or leaves the pool, so nobody else's value moves. If the sender is in profit, their profit share on the part they give is taken first (as at a withdrawal); the recipient starts fresh from what they receive.</p>
      <form id="moveForm"><div class="grid form2"><div><label>From</label><select name="from">${o.holderOpts}</select></div><div><label>To</label><select name="to">${o.holderOpts}</select></div></div>
        <div class="grid form2"><div><label>Pesos (₱)</label><input name="php" type="number" step="any" inputmode="decimal" placeholder="5000"></div>
          <div><label>or USDT value</label><input name="usdt" type="number" step="any" inputmode="decimal" placeholder="79.00"></div></div>
        ${rateField(o.rate)}
        ${box('all', 'Everything the sender holds')}
        <details><summary>More options</summary><label>Note</label><input name="note"></details>
        <div class="preview" id="movePrev">—</div><button class="full">Transfer</button></form></div>`;
  }

  // what a form sends (null when it is not complete yet)
  const n0 = (v) => { const x = num(v); return x == null || Number.isNaN(x) ? null : x; };
  const cashArgs = (v) => (n0(v.usdt) > 0 ? { p_profile: v.who, p_php_amount: n0(v.php), p_usdt_received: n0(v.usdt), p_rate: n0(v.php) != null ? n0(v.rate) : null, p_in_mexc: !!v.inmexc } : null);
  const outArgs = (v) => (v.who && (v.all || n0(v.usdt) > 0) ? { p_profile: v.who, p_usdt: v.all ? null : n0(v.usdt), p_all: !!v.all, p_request: null, p_lock_reason: v.lock || null } : null);
  const moveArgs = (v) => (v.from && v.to && (v.all || n0(v.usdt) > 0 || n0(v.php) > 0)
    ? { p_from: v.from, p_to: v.to, p_php_amount: n0(v.php), p_usdt: n0(v.usdt), p_rate: n0(v.php) != null ? n0(v.rate) : null, p_all: !!v.all } : null);
  // the add-investor preview has no account yet: the same rule as the database (credited = pesos ÷ rate, rounded down to 6 decimals)
  function credit(php, usdt, rate) {
    if (!(num(usdt) > 0)) return null;
    if (!(num(php) > 0) || !(num(rate) > 0)) return { credited: num(usdt), topup: 0, surplus: 0 };
    const c = Math.floor((num(php) / num(rate)) * 1e6 + 1e-7) / 1e6;
    return { credited: c, topup: Math.max(0, +(c - num(usdt)).toFixed(6)), surplus: Math.max(0, +(num(usdt) - c).toFixed(6)) };
  }

  // ---------------------------------------------------------------- previews from the database's own quotes
  function cashText(r) {
    const head = `${r.rate ? `${peso(r.php_amount || null)} ` : ''}<b>${usd(r.credited_usdt, 6)}</b> credited${r.rate ? ` at ₱${Number(r.rate).toFixed(4)}` : ''}.`;
    const gap = num(r.topup_usdt) > 0 ? `<br>${usd(r.topup_usdt, 6)} less arrived: it comes from <b>your</b> units at the live price.` : num(r.surplus_usdt) > 0 ? `<br>${usd(r.surplus_usdt, 6)} more arrived: it joins as <b>your</b> own money.` : '';
    const now = r.status === 'admitted' ? `<br>Joins <b>now</b> at ${price(r.unit_price)}: <b>${Number(r.units).toFixed(4)} units</b>.`
      : `<br>Joins at the first verified reading that shows it${r.waiting_reason ? ` (now: ${esc(String(r.waiting_reason).replace(/^blocked: /, ''))})` : ''}.`;
    return `${head}${gap}${now}<br><span class="note">Quoted by the database; nothing is saved until you press the button.</span>`;
  }
  const outText = (r) => `Pays <b>${usd(r.pay_usdt, 6)}</b> at ${price(r.unit_price)}${num(r.fee_units) > 0 ? ` after the profit share (${Number(r.fee_units).toFixed(4)} units)` : ''}. MEXC can release ${usd(r.payable_now_before_usdt)} now.<br><span class="note">Quoted by the database; nothing is saved until you press the button.</span>`;
  const moveText = (r) => `${Number(r.gross_units).toFixed(4)} units leave the sender (${usd(r.sender_value_moved_usdt, 6)})${num(r.fee_usdt) > 0 ? `, ${usd(r.fee_usdt, 6)} of it is their profit share` : ''}; the recipient gets <b>${usd(r.usdt, 6)}</b> (${Number(r.net_units).toFixed(4)} units) at ${price(r.unit_price)}.<br><span class="note">The pool's value and units do not change. Quoted by the database; nothing is saved until you press the button.</span>`;
  const refused = (e) => `<span class="down">The database would refuse this: ${esc(/function|schema cache|does not exist/i.test(e) ? 'not available on this database yet (run 20261213000000_live_nav.sql).' : String(e).replace(/^blocked: /, 'the live price is paused: '))}</span>`;

  // ---------------------------------------------------------------- the accounting screen: live NAV, reconciliation, discrepancy log
  function navCard(n, now) {
    if (!n) return '<div class="card"><h2>Live NAV</h2><p class="note">Not available on this database yet (run 20261213000000_live_nav.sql).</p></div>';
    const v = n.latest_verified, rc = n.reconciliation || {}, st = n.settings || {};
    const head = n.current ? `<p><b class="up">● Live.</b> The unit price follows the MEXC wallets. Last verified ${ago(v && v.ts, now)}.</p>`
      : `<p class="warn"><b>● Paused${n.blocked_since ? ` since ${ago(n.blocked_since, now)}` : ''}.</b> No new price is published until the reading is clean again: ${esc(texts(n.reasons_now).join('; ') || 'no complete set of wallet reports yet')}.</p>`;
    const holders = (rc.holders || []).map((h) => row(esc(h.name) + (h.role === 'admin' ? ' (you)' : ''), usd(h.value_usdt), `${Number(h.units).toFixed(4)} units · ${(Number(h.share) * 100).toFixed(2)}%`)).join('');
    const recent = (n.recent || []).slice(0, 12).map((x) => row(`${esc(String(x.ts).replace('T', ' ').slice(0, 16))} · ${esc(x.source)}`,
      x.status === 'verified' ? price(x.unit_price) : '<span class="warn">blocked</span>', x.status === 'blocked' ? esc(texts(x.reasons).join('; ')) : `NAV ${usd(x.true_value)}`)).join('');
    return `<div class="card"><h2>Live NAV</h2>${head}
      <div class="grid"><div class="stat"><div class="k">Unit price</div><div class="v">${price(n.unit_price)}</div></div>
        <div class="stat"><div class="k">NAV</div><div class="v">${usd(rc.nav_usdt)}</div></div>
        <div class="stat"><div class="k">Open trades (in the NAV)</div><div class="v">${usd(rc.open_pnl_usdt)}</div></div>
        <div class="stat"><div class="k">Book (closed trades only)</div><div class="v">${usd(rc.book_usdt)}</div></div></div></div>
    <div class="card"><h2>Reconciliation</h2>
      ${row('MEXC wallets (all bots)', usd(rc.mexc_equity_usdt))}
      ${row('= Everybody\'s value (NAV)', usd(rc.nav_usdt), `sum of the holders below: ${usd(rc.sum_of_holders_usdt)}`)}
      ${row('+ money in MEXC waiting to join', usd(rc.waiting_in_mexc_usdt))}
      ${row('+ payouts redeemed, not sent yet', usd(rc.redeemed_not_sent_usdt))}
      ${row('Unexplained', rc.unexplained_usdt == null ? '—' : usd(rc.unexplained_usdt, 4), rc.unexplained_usdt == null ? 'shown when the reading is clean' : `tolerance ${usd(rc.tolerance_usdt)}`)}
      ${row('Books + open trades vs MEXC (gap)', usd(rc.gap_usdt, 4), 'a gap is money not recorded, a trade not booked yet, or fees: the price pauses until it is explained')}
      ${num(rc.waiting_not_in_mexc_usdt) > 0 ? row('Recorded, not in MEXC yet', usd(rc.waiting_not_in_mexc_usdt)) : ''}
      <h3 class="subhead">Who owns it</h3>${holders || '<p class="note">Nobody yet.</p>'}
      ${row('Your fee units (inside your holding)', `${Number(rc.manager_fee_units || 0).toFixed(4)} units`)}
      ${row('Can leave MEXC now', usd(n.payable_now_usdt), 'withdrawable less the payout buffer and payouts not sent')}</div>
    <div class="card"><h2>Readings</h2><p class="note">One row per complete set of wallet reports (every 5 minutes) and one per deposit, payout or transfer. Blocked rows have no price.</p>${recent}
      <p class="note" style="margin-top:8px">Settings: automatic reading ${esc(st.nav_auto)}, automatic joining ${esc(st.nav_auto_admit)}, pricing ${esc(st.flow_pricing)}, trades booked ${esc(st.auto_pool_mode)}.</p></div>`;
  }

  return { ACTIONS, BOOKS, isDesk, tabs, navLine, addForm, cashForm, waitingCard, outForm, moveForm, cashArgs, outArgs, moveArgs, credit, cashText, outText, moveText, refused, navCard };
});

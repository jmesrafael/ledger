// Ledger Monitor: paper record of a pooled account, valued in USDT. All numbers come from the database (RPC functions).
(() => {
  const C = window.CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY);
  const app = document.getElementById('app');
  const S = { tab: 'home', authMode: 'in', me: null, pool: null, hist: [], ledger: [], reqs: [], all: [], elog: [], booted: false };

  // ---------------------------------------------------------------- formatting
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usdt = (v, d = 2) => f(v, d) + ' USDT';
  const sgn = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v), d);
  const pct = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v) * 100, d) + '%';
  const peso = (u, rate) => (rate ? '≈ ₱' + Number(u * rate).toLocaleString('en-PH', { maximumFractionDigits: 0 }) : '');
  const day = (s) => (s ? new Date(String(s).length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const isAdmin = () => S.me && S.me.role === 'admin';

  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.innerHTML = `<div class="toast ${err ? 'err' : ''}" role="status">${esc(msg)}</div>`;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.innerHTML = ''), err ? 6000 : 3500);
  }
  async function call(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }
  const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

  // ---------------------------------------------------------------- data
  async function load() {
    S.me = await call('my_summary');
    if (!S.me) return;
    if (S.uid !== S.me.id) { S.uid = S.me.id; S.tab = null; }   // a different person signed in: start on their first tab
    const jobs =[call('pool_summary'), call('price_history'),
      sb.from('ledger').select('*').order('id', { ascending: false }),
      sb.from('withdrawal_requests').select('*').order('id', { ascending: false })];
    if (S.me.role === 'admin') jobs.push(call('admin_overview'), call('admin_equity_log'));
    const [pool, hist, led, reqs, all, elog] = await Promise.all(jobs);
    S.pool = pool; S.hist = hist; S.ledger = must(led); S.reqs = must(reqs); S.all = all || []; S.elog = elog || [];
  }
  const nameOf = (id) => (S.all.find((h) => h.id === id) || (S.me && S.me.id === id && S.me) || {}).name || 'Someone';
  const rate = () => (S.pool && S.pool.php_rate) || (S.me && S.me.php_rate) || null;

  // ---------------------------------------------------------------- shared pieces
  function chart(hist) {
    if (!hist || hist.length < 2) return '<p class="note">The chart appears after the second equity update.</p>';
    const ys = hist.map((h) => Number(h.unit_price)); const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 0.01) * 0.15;
    const a = lo - pad, b = hi + pad, W = 300, H = 100;
    const pts = ys.map((y, i) => `${(i / (ys.length - 1)) * W},${H - ((y - a) / (b - a)) * H}`).join(' ');
    const last = ys[ys.length - 1] >= ys[0];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Unit price history">
      <polyline fill="none" stroke="var(--${last ? 'up' : 'down'})" stroke-width="2.2" vector-effect="non-scaling-stroke" points="${pts}"/></svg>
      <div class="row"><span class="l">Low / High</span><span class="r">${f(lo, 4)} / ${f(hi, 4)}</span></div>`;
  }
  function poolCard() {
    const p = S.pool; if (!p) return '';
    const tot = Number(p.total_units) || 1;
    const seg = [['Investors', p.investor_units, '#38bdf8'], ['Manager capital', p.admin_capital_units, '#2dd4bf'], ['Manager fee units', p.admin_fee_units, '#f59e0b']];
    return `<div class="card"><h2>Shared pool</h2>
      <div class="row"><span class="l">Pool size</span><span class="r"><b>${usdt(p.equity_usdt)}</b><br><span class="note">${peso(p.equity_usdt, rate())}</span></span></div>
      <div class="row"><span class="l">Unit price</span><span class="r"><b>${f(p.unit_price, 4)}</b> USDT <span class="${cls(p.since_start_pct)}">(${pct(p.since_start_pct)} since start)</span></span></div>
      <div class="row"><span class="l">Last updated</span><span class="r">${p.asof ? day(p.asof) : '—'}</span></div>
      <div style="margin-top:10px">${chart(S.hist)}</div>
      <h2 style="margin-top:14px">Who owns the pool</h2>
      <div class="bar">${seg.map(([, u, c]) => `<i style="width:${(Number(u) / tot) * 100}%;background:${c}"></i>`).join('')}</div>
      <div class="legend">${seg.map(([n, u, c]) => `<span><b style="background:${c}"></b>${n} ${f((Number(u) / tot) * 100, 1)}%</span>`).join('')}</div>
      <p class="note" style="margin-top:8px">${p.investor_count} investor${p.investor_count === 1 ? '' : 's'}. Fee units are the performance fees the manager earned; they stay in the pool.</p></div>`;
  }
  const KIND = { deposit: 'Deposit', withdrawal: 'Withdrawal', fee_out: 'Performance fee', fee_in: 'Fee earned' };
  function activityRows(rows, withName) {
    if (!rows.length) return '<p class="note">Nothing yet.</p>';
    return rows.map((l) => `<div class="row"><span class="l">${day(l.ts)}<br><b style="color:var(--ink)">${KIND[l.kind] || l.kind}</b>${withName ? ' · ' + esc(nameOf(l.profile_id)) : ''}${l.note ? `<br><span class="note">${esc(l.note)}</span>` : ''}</span>
      <span class="r ${cls(l.units)}">${sgn(l.units, 4)} units<br>${sgn(l.usdt)} USDT<br><span class="note">@ ${f(l.unit_price, 4)}</span></span></div>`).join('');
  }
  const DISC = `<p class="disc">This page is a paper record of your share of a pooled trading account, valued in USDT. It is not a bank balance, not insured, and past or backtested results are not a promise of future results. You can lose some or all of the money you put in. Only invest money you can afford to lose.</p>`;

  // ---------------------------------------------------------------- investor / shared views
  function viewHome() {
    const m = S.me, r = rate(), investor = m.role === 'investor';
    const pend = S.reqs.filter((q) => q.status === 'pending');
    return `<div class="card hero"><h2>${investor ? 'Your balance' : 'Your holdings'}</h2>
      <div class="big">${usdt(m.value_usdt)}</div><div class="sub">${peso(m.value_usdt, r)} <span class="note">(estimate at today's rate)</span></div>
      <div class="${cls(m.profit_usdt)}" style="margin-top:8px;font-weight:650">${sgn(m.profit_usdt)} USDT · ${m.return_pct == null ? '—' : pct(m.return_pct)}</div></div>
      <div class="card"><div class="grid">
        <div class="stat"><div class="k">You put in</div><div class="v">${usdt(m.net_in_usdt)}</div></div>
        <div class="stat"><div class="k">Profit so far</div><div class="v ${cls(m.profit_usdt)}">${sgn(m.profit_usdt)} USDT</div></div>
        <div class="stat"><div class="k">Your units</div><div class="v">${f(m.units, 4)}</div></div>
        <div class="stat"><div class="k">Share of pool</div><div class="v">${m.share_pct == null ? '—' : f(m.share_pct * 100, 2) + '%'}</div></div></div></div>
      ${investor ? `<div class="card"><h2>Performance fee</h2>
        <div class="row"><span class="l">Fee rate</span><span class="r">${f(m.fee_rate * 100, 0)}% of gains above your high-water mark</span></div>
        <div class="row"><span class="l">High-water mark</span><span class="r">${f(m.hwm, 4)} (unit price now ${f(m.unit_price, 4)})</span></div>
        <div class="row"><span class="l">Estimated fee at quarter end</span><span class="r">${usdt(m.accrued_fee_usdt)}</span></div>
        <div class="row"><span class="l">Balance after estimated fee</span><span class="r"><b>${usdt(m.value_after_fee_usdt)}</b></span></div>
        <p class="note">No fee is charged on gains you have already paid a fee on, or while the pool is below your high-water mark. The fee is paid in units at the end of each quarter; no cash moves.</p></div>
      <div class="card"><h2>Withdrawals</h2>
        <div class="row"><span class="l">Units past ${C.LOCK_MONTHS}-month lock-up</span><span class="r">${f(m.unlocked_units, 4)}</span></div>
        <div class="row"><span class="l">Next unlock</span><span class="r">${day(m.next_unlock)}</span></div>
        <p class="note">Requests are paid within ${C.WITHDRAW_BUSINESS_DAYS} business days, at the unit price on the day of payout.</p>
        <form id="reqForm"><label for="rq-u">Units to withdraw</label>
          <input id="rq-u" name="units" type="number" step="any" min="0" inputmode="decimal" required>
          <div class="btns"><button type="button" class="ghost" data-action="maxunits">Max available</button><button>Request withdrawal</button></div></form>
        ${pend.length ? '<h2 style="margin-top:14px">Pending requests</h2>' + pend.map((q) => `<div class="row"><span class="l">${day(q.requested_at)} · ${f(q.units, 4)} units<br><span class="note">Pay by ${day(q.pay_by)}</span></span><span class="r"><button class="ghost" data-action="cancelreq" data-id="${q.id}">Cancel</button></span></div>`).join('') : ''}</div>`
      : `<div class="card"><h2>Your units</h2>
        <div class="row"><span class="l">Fee units earned</span><span class="r">${f(m.fee_units_earned, 4)} (${usdt(m.fee_units_value_usdt)})</span></div></div>`}
      ${poolCard()}${DISC}`;
  }
  const viewPool = () => poolCard() + DISC;
  const viewActivity = () => `<div class="card"><h2>Your activity</h2>${activityRows(S.ledger, false)}</div>`;

  // ---------------------------------------------------------------- admin views
  function viewPeople() {
    const pending = S.all.filter((h) => h.role === 'investor' && !h.approved);
    const members = S.all.filter((h) => h.approved || h.role === 'admin');
    return `${pending.length ? `<div class="card"><h2>Waiting for approval</h2>${pending.map((h) => `<div class="person"><div class="top"><span class="nm">${esc(h.name || '(no name)')}</span><span class="note">${esc(h.email)}</span></div>
      <div class="btns"><button data-action="approve" data-id="${h.id}">Approve</button></div></div>`).join('')}</div>` : ''}
      <div class="card"><h2>Pool</h2>
        <div class="row"><span class="l">Equity</span><span class="r"><b>${usdt(S.pool.equity_usdt)}</b></span></div>
        <div class="row"><span class="l">Unit price</span><span class="r">${f(S.pool.unit_price, 4)}</span></div>
        <div class="row"><span class="l">Total units</span><span class="r">${f(S.pool.total_units, 4)}</span></div></div>
      <div class="card"><h2>Everyone (${members.length})</h2>${members.map((h) => `<div class="person">
        <div class="top"><span class="nm">${esc(h.name || '(no name)')} <span class="chip">${h.role === 'admin' ? 'manager' : 'investor'}</span></span>
          <span><b>${usdt(h.value_usdt)}</b></span></div>
        <div class="mini">
          <div><span>Put in</span>${f(h.net_in_usdt)}</div>
          <div><span>Profit</span><i class="${cls(h.profit_usdt)}" style="font-style:normal">${sgn(h.profit_usdt)}${h.return_pct != null ? ' (' + pct(h.return_pct, 1) + ')' : ''}</i></div>
          <div><span>Share</span>${h.share_pct == null ? '—' : f(h.share_pct * 100, 1) + '%'}</div>
          <div><span>Units</span>${f(h.units, 3)}</div>
          <div><span>HWM</span>${f(h.hwm, 4)}</div>
          <div><span>${h.role === 'admin' ? 'Fee units' : 'Locked until'}</span>${h.role === 'admin' ? f(h.fee_units_earned, 3) : day(h.lock_until)}</div></div>
        ${h.role === 'investor' ? `<form class="profForm" data-id="${h.id}"><div class="grid"><div><label>Name</label><input name="name" value="${esc(h.name)}"></div>
          <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="${f(h.fee_rate * 100, 0)}"></div></div>
          <div class="btns"><button class="ghost">Save</button></div></form>` : ''}</div>`).join('')}</div>`;
  }
  const holderOpts = (sel) => S.all.filter((h) => h.approved || h.role === 'admin')
    .map((h) => `<option value="${h.id}" ${h.id === sel ? 'selected' : ''}>${esc(h.name || h.email)}${h.role === 'admin' ? ' (manager)' : ''}</option>`).join('');
  const phpField = () => `<label>Peso rate (₱ per USDT, optional, for the ₱ estimate only)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate() || ''}">`;

  function viewRecord() {
    const empty = Number(S.pool.total_units) === 0;
    return `<div class="card"><h2>1 · Update pool equity</h2>
      <p class="note">Read the pool's total equity (USDT, including open trades) from MEXC. This moves the unit price for everyone. No one's units change.</p>
      <form id="eqForm"><label>Pool equity now (USDT)</label><input name="equity" type="number" step="any" inputmode="decimal" required ${empty ? 'disabled placeholder="Record the first deposit first"' : ''}>
        ${phpField()}<label>Note (optional)</label><input name="note"><div class="preview" id="eqPrev">—</div><button class="full" ${empty ? 'disabled' : ''}>Save equity</button></form></div>
      <div class="card"><h2>2 · Record a deposit</h2>
        <p class="note">${empty ? 'This is the very first deposit (the manager\'s own capital). Leave "equity before" blank; units start at 1.00.' : 'Enter the pool equity from MEXC <b>just before</b> this money lands, so the new person buys units at the right price.'}</p>
        <form id="depForm"><label>Person</label><select name="who">${holderOpts()}</select>
        <label>Amount credited (USDT)</label><input name="usdt" type="number" step="any" inputmode="decimal" required>
        ${empty ? '' : '<label>Pool equity before this deposit (USDT)</label><input name="eq" type="number" step="any" inputmode="decimal" required>'}
        <label>Pesos they handed over (optional, reference only)</label><input name="pesos" type="number" step="any" inputmode="decimal">
        ${phpField()}<label>Note (optional)</label><input name="note"><div class="preview" id="depPrev">—</div><button class="full">Record deposit</button></form></div>
      <div class="card"><h2>3 · Record a withdrawal</h2>
        <p class="note">Enter the pool equity from MEXC just before you pay out. The fee on gains above their high-water mark is taken in units first.</p>
        <form id="wdForm"><label>Person</label><select name="who">${holderOpts()}</select>
        <label>Units to redeem</label><input name="units" type="number" step="any" inputmode="decimal" required>
        <div class="btns"><button type="button" class="ghost" data-action="allunits">All their units</button></div>
        <label>Pool equity before this payout (USDT)</label><input name="eq" type="number" step="any" inputmode="decimal" required>
        ${phpField()}<label>Note (optional)</label><input name="note"><input type="hidden" name="reqid">
        <label style="display:flex;gap:8px;align-items:center"><input name="force" type="checkbox" style="width:auto;min-height:0"> Override lock-up</label>
        <div class="preview" id="wdPrev">—</div><button class="full">Record withdrawal</button></form></div>`;
  }
  function viewQuarter() {
    return `<div class="card"><h2>Close the quarter</h2>
      <p class="note">Charges each investor's performance fee on gains above their high-water mark. The fee moves as <b>units</b> from them to you (still inside the pool, so it compounds). Then each high-water mark resets. Do this once per quarter.</p>
      <form id="qForm"><label>Pool equity now (USDT)</label><input name="equity" type="number" step="any" inputmode="decimal" required>
      ${phpField()}<label>Note (optional)</label><input name="note" value="Quarter close"><div class="preview" id="qPrev">Enter the equity to preview the fees.</div>
      <button class="full">Charge fees and close quarter</button></form></div>`;
  }
  function viewLog() {
    const pend = S.reqs.filter((q) => q.status === 'pending');
    return `<div class="card"><h2>Withdrawal requests</h2>${pend.length ? pend.map((q) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(nameOf(q.profile_id))}</b><br>${f(q.units, 4)} units · asked ${day(q.requested_at)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span>
      <span class="r"><button data-action="payreq" data-id="${q.id}" data-who="${q.profile_id}" data-units="${q.units}">Prepare payout</button></span></div>`).join('') : '<p class="note">None pending.</p>'}</div>
      <div class="card"><h2>All entries</h2>${activityRows(S.ledger, true)}</div>
      <div class="card"><h2>Equity readings</h2>${S.elog.length ? S.elog.slice(0, 60).map((e) => `<div class="row"><span class="l">${day(e.ts)} · ${esc(e.kind)}${e.note ? `<br><span class="note">${esc(e.note)}</span>` : ''}</span>
        <span class="r">${usdt(e.equity_usdt)}<br><span class="note">price ${f(e.unit_price, 4)}</span></span></div>`).join('') : '<p class="note">None yet.</p>'}</div>`;
  }

  // ---------------------------------------------------------------- shell
  const TABS = {
    investor: [['home', 'Home'], ['pool', 'Pool'], ['activity', 'Activity']],
    admin: [['people', 'People'], ['record', 'Record'], ['quarter', 'Quarter'], ['log', 'Log'], ['home', 'Mine'], ['pool', 'Pool']],
  };
  const VIEWS = { home: viewHome, pool: viewPool, activity: viewActivity, people: viewPeople, record: viewRecord, quarter: viewQuarter, log: viewLog };

  function authView() {
    const up = S.authMode === 'up';
    app.innerHTML = `<header><h1>Ledger Monitor</h1></header><div class="card"><h2>${up ? 'Create your account' : 'Sign in'}</h2>
      <form id="authForm">${up ? '<label>Your name</label><input name="name" autocomplete="name" required>' : ''}
      <label>Email</label><input name="email" type="email" autocomplete="email" required>
      <label>Password</label><input name="password" type="password" minlength="8" autocomplete="${up ? 'new-password' : 'current-password'}" required>
      <button class="full">${up ? 'Create account' : 'Sign in'}</button></form>
      <div class="btns"><button class="ghost" data-action="authmode">${up ? 'I already have an account' : 'Create an account'}</button></div>
      ${up ? '<p class="note">After you sign up, the manager has to approve your account before you can see anything.</p>' : ''}</div>${DISC}`;
  }
  function pendingView() {
    app.innerHTML = `<header><h1>Ledger Monitor</h1><button class="ghost" data-action="signout">Sign out</button></header>
      <div class="card"><h2>Waiting for approval</h2><p>Your account is created. The manager needs to approve it before you can see your balance. Check back soon.</p>
      <div class="btns"><button class="ghost" data-action="refresh">Check again</button></div></div>`;
  }
  function render() {
    if (!S.me) return;
    const tabs = TABS[S.me.role === 'admin' ? 'admin' : 'investor'];
    if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    app.innerHTML = `<header><div><h1>Ledger Monitor</h1><div class="who">${esc(S.me.name || S.me.email)}${isAdmin() ? ' · manager' : ''}</div></div>
      <button class="ghost" data-action="refresh" aria-label="Refresh">Refresh</button></header>
      ${VIEWS[S.tab]()}
      <div style="text-align:center;margin:8px 0"><button class="ghost" data-action="signout">Sign out</button></div>
      <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === S.tab ? 'on' : ''}">${l}</button>`).join('')}</nav>`;
    wirePreviews();
  }
  async function refresh(msg) {
    try { await load(); if (!S.me) pendingView(); else render(); if (msg) toast(msg); }
    catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- previews (mirror the database math)
  const $f = (id) => document.getElementById(id);
  const fv = (form, name) => (form.elements[name] ? form.elements[name].value : '');
  function wirePreviews() {
    const pairs = [['eqForm', eqPrev], ['depForm', depPrev], ['wdForm', wdPrev], ['qForm', qPrev]];
    for (const [id, fn] of pairs) { const el = $f(id); if (el) { el.addEventListener('input', () => fn(el)); fn(el); } }
  }
  const setPrev = (id, html) => { const el = $f(id); if (el) el.innerHTML = html; };
  function eqPrev(fm) {
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units);
    if (eq == null || !u) return setPrev('eqPrev', '—');
    const price = eq / u, ch = price / Number(S.pool.unit_price) - 1;
    setPrev('eqPrev', `Unit price becomes <b>${f(price, 4)}</b> (<span class="${cls(ch)}">${pct(ch)}</span> vs last reading). Since start ${pct(price - 1)}.`);
  }
  function depPrev(fm) {
    const usd = num(fv(fm, 'usdt')), u = Number(S.pool.total_units), eq = num(fv(fm, 'eq'));
    if (usd == null) return setPrev('depPrev', '—');
    if (u && eq == null) return setPrev('depPrev', 'Enter the equity before the deposit.');
    const price = u ? eq / u : 1;
    setPrev('depPrev', `Buys <b>${f(usd / price, 4)} units</b> at ${f(price, 4)}. Lock-up ${C.LOCK_MONTHS} months.`);
  }
  function holder(id) { return S.all.find((h) => h.id === id); }
  function wdPrev(fm) {
    const h = holder(fv(fm, 'who')), units = num(fv(fm, 'units')), eq = num(fv(fm, 'eq')), u = Number(S.pool.total_units);
    if (!h || units == null || eq == null || !u) return setPrev('wdPrev', '—');
    const price = eq / u, fee = h.role === 'investor' ? (h.fee_rate * Math.max(0, price - h.hwm) / price) * units : 0;
    const net = units - fee, pay = net * price;
    const warn = units > Number(h.units) + 1e-8 ? '<br><span class="down">More than they hold.</span>'
      : h.role === 'investor' && units > Number(h.unlocked_units) + 1e-8 && !fm.elements.force.checked ? '<br><span class="warn">Inside lock-up. Tick override to allow.</span>' : '';
    setPrev('wdPrev', `Price ${f(price, 4)}. Fee <b>${f(fee, 4)} units</b>. Pay out <b>${usdt(pay)}</b> ${peso(pay, num(fv(fm, 'rate')) || rate())} for ${f(net, 4)} units.${warn}`);
  }
  function qPrev(fm) {
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units);
    if (eq == null || !u) return setPrev('qPrev', 'Enter the equity to preview the fees.');
    const price = eq / u; let tot = 0;
    const rows = S.all.filter((h) => h.role === 'investor' && Number(h.units) > 0).map((h) => {
      const fee = (h.fee_rate * Math.max(0, price - h.hwm) / price) * h.units; tot += fee;
      return `<div class="row"><span class="l">${esc(h.name || h.email)}<br><span class="note">HWM ${f(h.hwm, 4)}</span></span><span class="r">${f(fee, 4)} units<br><span class="note">${usdt(fee * price)}</span></span></div>`;
    }).join('');
    setPrev('qPrev', `Price ${f(price, 4)}.${rows || '<br>No investors hold units.'}<div class="row"><span class="l"><b>Total to manager</b></span><span class="r"><b>${f(tot, 4)} units</b> (${usdt(tot * price)})</span></div>`);
  }

  // ---------------------------------------------------------------- actions
  async function act(fn, okMsg) {
    try { await fn(); await refresh(okMsg); } catch (e) { toast(e.message, true); }
  }
  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, id = b.dataset.id;
    if (a === 'authmode') { S.authMode = S.authMode === 'up' ? 'in' : 'up'; authView(); }
    else if (a === 'signout') { await sb.auth.signOut(); S.me = null; authView(); }
    else if (a === 'refresh') refresh();
    else if (a === 'maxunits') { $f('rq-u').value = S.me.unlocked_units; }
    else if (a === 'cancelreq') act(() => call('cancel_withdrawal_request', { p_id: Number(id) }), 'Request cancelled');
    else if (a === 'approve') act(() => call('admin_set_profile', { p_profile: id, p_name: null, p_approved: true, p_fee_rate: null }), 'Approved');
    else if (a === 'allunits') { const fm = $f('wdForm'), h = holder(fv(fm, 'who')); if (h) { fm.elements.units.value = h.units; wdPrev(fm); } }
    else if (a === 'payreq') {
      S.tab = 'record'; render(); const fm = $f('wdForm');
      fm.elements.who.value = b.dataset.who; fm.elements.units.value = b.dataset.units; fm.elements.reqid.value = id; wdPrev(fm); fm.scrollIntoView();
    }
  });
  document.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fm = ev.target, id = fm.id, btn = fm.querySelector('button:not([type=button])');
    if (btn) btn.disabled = true;
    try {
      if (id === 'authForm') {
        const email = fv(fm, 'email'), password = fv(fm, 'password');
        if (S.authMode === 'up') {
          const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name: fv(fm, 'name') } } });
          if (error) throw error;
          if (!data.session) { toast('Account created. Check your email to confirm, then sign in.'); S.authMode = 'in'; authView(); return; }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
        }
        await refresh();
      } else if (id === 'reqForm') {
        const r = await call('request_withdrawal', { p_units: num(fv(fm, 'units')), p_note: null });
        await refresh(`Requested. You will be paid by ${day(r.pay_by)}.`);
      } else if (id === 'eqForm') {
        await call('admin_post_equity', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null });
        await refresh('Equity saved');
      } else if (id === 'depForm') {
        const r = await call('admin_deposit', { p_profile: fv(fm, 'who'), p_usdt: num(fv(fm, 'usdt')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_php_amount: num(fv(fm, 'pesos')), p_note: fv(fm, 'note') || null });
        await refresh(`Deposit recorded: ${f(r.units, 4)} units at ${f(r.unit_price, 4)}`);
      } else if (id === 'wdForm') {
        const r = await call('admin_withdraw', { p_profile: fv(fm, 'who'), p_units: num(fv(fm, 'units')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_force: fm.elements.force.checked, p_request_id: num(fv(fm, 'reqid')) });
        await refresh(`Withdrawal recorded. Pay out ${usdt(r.pay_usdt)}`);
      } else if (id === 'qForm') {
        if (!confirm('Charge performance fees and close the quarter? This cannot be undone.')) { if (btn) btn.disabled = false; return; }
        const r = await call('admin_close_quarter', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null });
        await refresh(`Quarter closed: ${r.investors_charged} charged, ${f(r.fee_units, 4)} fee units`);
      } else if (fm.classList.contains('profForm')) {
        await call('admin_set_profile', { p_profile: fm.dataset.id, p_name: fv(fm, 'name'), p_approved: null, p_fee_rate: num(fv(fm, 'fee')) / 100 });
        await refresh('Saved');
      } else if (btn) btn.disabled = false;
    } catch (e) { toast(e.message || String(e), true); if (btn) btn.disabled = false; }
  });

  // ---------------------------------------------------------------- start
  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return authView();
    await refresh();
  }
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { S.me = null; authView(); } });
  boot();
})();

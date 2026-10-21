// Ledger Monitor: paper record of a pooled account, valued in USDT. All numbers come from database functions;
// every call carries the session token from login (username + password checked and hashed in the database).
(() => {
  const C = window.CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = document.getElementById('app');
  const TOKEN_KEY = 'ledger.token', ADMIN_KEY = 'ledger.admin_token';   // ADMIN_KEY: the manager's own session while "viewing as"
  const S = { tab: null, token: null, adminToken: null, uid: null, me: null, pool: null, hist: [], history: [], ledger: [], reqs: [], all: [], elog: [], range: 'ALL' };

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
  const store = {
    get(k = TOKEN_KEY) { try { return localStorage.getItem(k); } catch { return null; } },
    set(v, k = TOKEN_KEY) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode: stay signed in for this tab only */ } },
  };
  async function rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }
  async function call(fn, args = {}) {
    try { return await rpc(fn, { p_token: S.token, ...args }); }
    catch (e) { if (/not signed in/.test(e.message)) { signedOut('Please sign in again.'); throw new Error('Signed out'); } throw e; }
  }
  function signedOut(msg) {
    if (S.adminToken) { backToManager('The view-as session ended.'); return; }   // an expired "view as" falls back to the manager
    S.token = null; S.me = null; store.set(null); loginView(); if (msg) toast(msg, true);
  }
  async function viewAs(id) {
    const r = await call('admin_view_as', { p_profile: id });
    S.adminToken = S.token; store.set(S.token, ADMIN_KEY);
    S.token = r.token; store.set(r.token); S.range = 'ALL';
    await refresh(`Viewing as ${r.name} (read-only)`);
  }
  async function backToManager(msg) {
    const t = S.token; S.token = S.adminToken; S.adminToken = null; store.set(S.token); store.set(null, ADMIN_KEY);
    try { await rpc('logout', { p_token: t }); } catch { /* already expired */ }
    S.tab = 'people'; S.uid = null; await refresh(msg);
    S.tab = 'people'; render();
  }

  // ---------------------------------------------------------------- data
  async function load() {
    S.me = await call('my_summary');
    if (S.uid !== S.me.id) { S.uid = S.me.id; S.tab = null; }   // a different person signed in: start on their first tab
    const admin = S.me.role === 'admin';
    const [pool, hist, history, led, reqs, all, elog] = await Promise.all([call('pool_summary'), call('price_history'), call('my_history'),
      call(admin ? 'admin_ledger' : 'my_ledger'), call(admin ? 'admin_requests' : 'my_requests'),
      admin ? call('admin_overview') : null, admin ? call('admin_equity_log') : null]);
    S.pool = pool; S.hist = hist; S.history = history; S.ledger = led; S.reqs = reqs; S.all = all || []; S.elog = elog || [];
  }
  const rate = () => (S.pool && S.pool.php_rate) || (S.me && S.me.php_rate) || null;

  // ---------------------------------------------------------------- shared pieces
  function chart(hist) {
    if (!hist || hist.length < 2) return '<p class="note">The chart appears after the second equity update.</p>';
    const ys = hist.map((h) => Number(h.unit_price)); const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 0.01) * 0.15;
    const a = lo - pad, b = hi + pad, W = 300, H = 100;
    const pts = ys.map((y, i) => `${(i / (ys.length - 1)) * W},${H - ((y - a) / (b - a)) * H}`).join(' ');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Unit price history">
      <polyline fill="none" stroke="var(--${ys[ys.length - 1] >= ys[0] ? 'up' : 'down'})" stroke-width="2.2" vector-effect="non-scaling-stroke" points="${pts}"/></svg>
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
    return rows.map((l) => `<div class="row"><span class="l">${day(l.ts)}<br><b style="color:var(--ink)">${KIND[l.kind] || l.kind}</b>${withName ? ' · ' + esc(l.name) : ''}${l.note ? `<br><span class="note">${esc(l.note)}</span>` : ''}</span>
      <span class="r ${cls(l.units)}">${sgn(l.units, 4)} units<br>${sgn(l.usdt)} USDT<br><span class="note">@ ${f(l.unit_price, 4)}</span></span></div>`).join('');
  }
  const passwordCard = () => `<div class="card"><h2>Change your password</h2>
    <form id="pwForm"><label>Current password</label><input name="old" type="password" autocomplete="current-password" required>
    <label>New password (at least 8 characters)</label><input name="new" type="password" minlength="8" autocomplete="new-password" required>
    <button class="full ghost">Change password</button></form>
    <p class="note">Your other phones/browsers will be signed out.</p></div>`;
  const DISC = `<p class="disc">This page is a paper record of your share of a pooled trading account, valued in USDT. It is not a bank balance, not insured, and past or backtested results are not a promise of future results. You can lose some or all of the money you put in. Only invest money you can afford to lose.</p>`;

  // ---------------------------------------------------------------- investor / shared views
  function viewHome() {
    const m = S.me, r = rate(), investor = m.role === 'investor';
    const pend = S.reqs.filter((q) => q.status === 'pending' && q.profile_id === m.id);
    return `${growthCard(investor ? 'Your balance' : 'Your holdings')}
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
        ${m.impersonated ? '<p class="note">Read-only view: only the person can request a withdrawal.</p>' : `<form id="reqForm"><label for="rq-u">Units to withdraw</label>
          <input id="rq-u" name="units" type="number" step="any" min="0" inputmode="decimal" required>
          <div class="btns"><button type="button" class="ghost" data-action="maxunits">Max available</button><button>Request withdrawal</button></div></form>`}
        ${pend.length ? '<h2 style="margin-top:14px">Pending requests</h2>' + pend.map((q) => `<div class="row"><span class="l">${day(q.requested_at)} · ${f(q.units, 4)} units<br><span class="note">Pay by ${day(q.pay_by)}</span></span><span class="r"><button class="ghost" data-action="cancelreq" data-id="${q.id}">Cancel</button></span></div>`).join('') : ''}</div>`
      : `<div class="card"><h2>Your units</h2>
        <div class="row"><span class="l">Fee units earned</span><span class="r">${f(m.fee_units_earned, 4)} (${usdt(m.fee_units_value_usdt)})</span></div></div>`}
      ${recentCard()}${poolCard()}${m.impersonated ? '' : passwordCard()}${DISC}`;
  }
  function recentCard() {
    const mine = S.ledger.filter((l) => l.profile_id === S.me.id);
    return `<div class="card"><h2>Recent transactions</h2>${activityRows(mine.slice(0, 5), false)}
      ${mine.length > 5 ? `<div class="btns"><button class="ghost" data-tab="${isAdmin() ? 'log' : 'activity'}">See all ${mine.length}</button></div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- growth chart (Robinhood-style: drag across it to see any day)
  const RANGES = [['1W', 7, 'Past week'], ['1M', 30, 'Past month'], ['3M', 91, 'Past 3 months'], ['YTD', 'ytd', 'This year'], ['ALL', null, 'All time']];
  function series() {
    const H = S.history.map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value), n: Number(p.net_in) }));
    if (!H.length) return [];
    const now = Date.now(), r = RANGES.find((x) => x[0] === S.range)[1];
    const start = r == null ? -Infinity : r === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) : now - r * 864e5;
    let pts = H.filter((p) => p.t >= start);
    const before = H.filter((p) => p.t < start).pop();
    if (before) pts = [{ ...before, t: start }, ...pts];          // the line starts at the range start with the value it had then
    const last = pts[pts.length - 1];
    if (last && last.t < now - 36e5) pts.push({ ...last, t: now });   // flat until today
    return pts;
  }
  function growthCard(title) {
    const pts = series(), m = S.me;
    if (!pts.length) return `<div class="card hero"><h2>${title}</h2><div class="big">${usdt(m.value_usdt)}</div><p class="note">The chart starts with the first deposit.</p></div>`;
    const a = pts[0], z = pts[pts.length - 1], up = (z.v - z.n) - (a.v - a.n) >= 0;
    const t0 = a.t, t1 = Math.max(z.t, t0 + 1), lo = Math.min(...pts.map((p) => Math.min(p.v, p.n))), hi = Math.max(...pts.map((p) => Math.max(p.v, p.n)));
    const pad = (hi - lo || Math.max(hi, 1) * 0.05) * 0.12, y0 = lo - pad, y1 = hi + pad, W = 300, H = 130;
    const X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (v) => H - ((v - y0) / (y1 - y0)) * H;
    S.chart = { pts, X, Y, W };
    const line = (k) => pts.map((p) => `${X(p.t).toFixed(2)},${Y(p[k]).toFixed(2)}`).join(' ');
    return `<div class="card hero"><h2>${title}</h2>
      <div class="big" id="gv">${usdt(z.v)}</div><div class="sub" id="gp">${peso(z.v, rate())}</div>
      <div id="gd" style="margin-top:6px;font-weight:650"></div>
      <svg id="gc" class="growth" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Your balance over time">
        <polyline fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" points="${line('n')}"/>
        <polyline fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="2.4" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${line('v')}"/>
        <line id="gx" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--muted)" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
      </svg>
      <div class="ranges">${RANGES.map(([k]) => `<button class="${k === S.range ? 'on' : ''}" data-range="${k}">${k}</button>`).join('')}</div>
      <p class="note" style="margin:6px 0 0">Solid line: what your share is worth. Dashed line: what you have put in. Drag across the chart to see any day.</p></div>`;
  }
  function showPoint(i) {   // update the big number to the point under the finger (or the latest point)
    const { pts } = S.chart, p = pts[i], a = pts[0], d = (p.v - p.n) - (a.v - a.n);
    const base = a.v > 0 ? a.v + (p.n - a.n) : p.n, label = RANGES.find((x) => x[0] === S.range)[2];
    $f('gv').textContent = usdt(p.v);
    $f('gp').textContent = peso(p.v, rate());
    $f('gd').className = cls(d);
    $f('gd').textContent = `${sgn(d)} USDT (${base > 0 ? pct(d / base) : '—'}) ${i === pts.length - 1 ? label : new Date(p.t).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  function wireChart() {
    const svg = $f('gc'); if (!svg || !S.chart) return;
    const { pts, X, W } = S.chart, gx = $f('gx');
    const at = (ev) => {
      const r = svg.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * W;
      let best = 0; for (let i = 1; i < pts.length; i++) if (Math.abs(X(pts[i].t) - x) < Math.abs(X(pts[best].t) - x)) best = i;
      gx.setAttribute('x1', X(pts[best].t)); gx.setAttribute('x2', X(pts[best].t)); gx.setAttribute('visibility', 'visible'); showPoint(best);
    };
    const reset = () => { gx.setAttribute('visibility', 'hidden'); showPoint(pts.length - 1); };
    svg.addEventListener('pointermove', at); svg.addEventListener('pointerdown', at);
    svg.addEventListener('pointerleave', reset); svg.addEventListener('pointerup', (ev) => { if (ev.pointerType !== 'mouse') reset(); });
    reset();
  }
  const viewPool = () => poolCard() + DISC;
  const viewActivity = () => `<div class="card"><h2>Your activity</h2>${activityRows(S.ledger, false)}</div>`;

  // ---------------------------------------------------------------- admin views
  function viewPeople() {
    return `<div class="card"><h2>Add a person</h2>
      <p class="note">Give them the username and password yourself. They can change the password after signing in.</p>
      <form id="newUserForm"><div class="grid"><div><label>Username</label><input name="username" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\\-]{3,30}" required></div>
        <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="20" required></div></div>
        <label>Full name</label><input name="name" required>
        <label>Starting password (at least 8 characters)</label><input name="password" type="text" minlength="8" autocomplete="off" required>
        <button class="full">Create account</button></form></div>
      <div class="card"><h2>Pool</h2>
        <div class="row"><span class="l">Equity</span><span class="r"><b>${usdt(S.pool.equity_usdt)}</b></span></div>
        <div class="row"><span class="l">Unit price</span><span class="r">${f(S.pool.unit_price, 4)}</span></div>
        <div class="row"><span class="l">Total units</span><span class="r">${f(S.pool.total_units, 4)}</span></div></div>
      <div class="card"><h2>Everyone (${S.all.length})</h2>${S.all.map((h) => `<div class="person">
        <div class="top"><span class="nm">${esc(h.name || h.username)} <span class="chip">${h.role === 'admin' ? 'manager' : 'investor'}</span>${h.active ? '' : ' <span class="chip down">off</span>'}</span>
          <span><b>${usdt(h.value_usdt)}</b></span></div>
        <div class="top"><span class="note">@${esc(h.username)}</span>${h.role === 'investor' && h.active ? `<button class="ghost" style="min-height:34px" data-action="viewas" data-id="${h.id}">View as</button>` : ''}</div>
        <div class="mini">
          <div><span>Put in</span>${f(h.net_in_usdt)}</div>
          <div><span>Profit</span><i class="${cls(h.profit_usdt)}" style="font-style:normal">${sgn(h.profit_usdt)}${h.return_pct != null ? ' (' + pct(h.return_pct, 1) + ')' : ''}</i></div>
          <div><span>Share</span>${h.share_pct == null ? '—' : f(h.share_pct * 100, 1) + '%'}</div>
          <div><span>Units</span>${f(h.units, 3)}</div>
          <div><span>HWM</span>${f(h.hwm, 4)}</div>
          <div><span>${h.role === 'admin' ? 'Fee units' : 'Locked until'}</span>${h.role === 'admin' ? f(h.fee_units_earned, 3) : day(h.lock_until)}</div></div>
        <details style="margin-top:8px"><summary class="note" style="cursor:pointer">Edit / reset password</summary>
          ${h.role === 'investor' ? `<form class="profForm" data-id="${h.id}"><div class="grid"><div><label>Name</label><input name="name" value="${esc(h.name)}"></div>
            <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="${f(h.fee_rate * 100, 0)}"></div></div>
            <div class="btns"><button class="ghost">Save</button><button type="button" class="${h.active ? 'danger' : 'ghost'}" data-action="toggleactive" data-id="${h.id}" data-active="${h.active}">${h.active ? 'Deactivate' : 'Reactivate'}</button></div></form>` : ''}
          <form class="resetForm" data-id="${h.id}"><label>New password for ${esc(h.name || h.username)}</label>
            <input name="password" type="text" minlength="8" autocomplete="off" required>
            <div class="btns"><button class="ghost">Set password</button></div></form></details></div>`).join('')}</div>`;
  }
  const holderOpts = (sel) => S.all.filter((h) => h.active)
    .map((h) => `<option value="${h.id}" ${h.id === sel ? 'selected' : ''}>${esc(h.name || h.username)}${h.role === 'admin' ? ' (manager)' : ''}</option>`).join('');
  const atOf = (fm) => (fv(fm, 'at') ? new Date(fv(fm, 'at')).toISOString() : null);   // optional "when" for late entries
  const phpField = () => `<label>When (leave empty for now; only for recording something late)</label><input name="at" type="datetime-local"><label>Peso rate (₱ per USDT, optional, for the ₱ estimate only)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate() || ''}">`;

  function viewRecord() {
    const empty = Number(S.pool.total_units) === 0;
    return `<div class="card"><h2>1 · Update pool equity</h2>
      <p class="note">Read the pool's total equity (USDT, including open trades) from MEXC. This moves the unit price for everyone. No one's units change.</p>
      <form id="eqForm"><label>Pool equity now (USDT)</label><input name="equity" type="number" step="any" inputmode="decimal" required ${empty ? 'disabled placeholder="Record the first deposit first"' : ''}>
        ${phpField()}<label>Note (optional)</label><input name="note"><div class="preview" id="eqPrev">—</div><button class="full" ${empty ? 'disabled' : ''}>Save equity</button></form></div>
      <div class="card"><h2>2 · Record a deposit</h2>
        <p class="note">${empty ? 'This is the very first deposit (the manager\'s own capital). Units start at 1.00.' : 'Enter the pool equity from MEXC <b>just before</b> this money lands, so the new person buys units at the right price.'}</p>
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
    return `<div class="card"><h2>Withdrawal requests</h2>${pend.length ? pend.map((q) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(q.name)}</b><br>${f(q.units, 4)} units · asked ${day(q.requested_at)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span>
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

  function loginView() {
    app.innerHTML = `<header><h1>Ledger Monitor</h1></header><div class="card"><h2>Sign in</h2>
      <form id="loginForm"><label>Username</label><input name="username" autocapitalize="none" autocomplete="username" required>
      <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
      <button class="full">Sign in</button></form>
      <p class="note">No account? Ask the manager to create one for you.</p></div>${DISC}`;
  }
  function render() {
    if (!S.me) return loginView();
    const tabs = TABS[isAdmin() ? 'admin' : 'investor'];
    if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    const viewing = S.me.impersonated;
    app.innerHTML = `${viewing ? `<div class="viewas"><span>Viewing as <b>${esc(S.me.name || S.me.username)}</b>, exactly what they see (read-only)</span>
        <button data-action="exitview">Back to manager</button></div>` : ''}
      <header><div><h1>Ledger Monitor</h1><div class="who">${esc(S.me.name || S.me.username)}${isAdmin() ? ' · manager' : ''}</div></div>
      <button class="ghost" data-action="refresh" aria-label="Refresh">Refresh</button></header>
      ${VIEWS[S.tab]()}
      ${viewing ? '' : '<div style="text-align:center;margin:8px 0"><button class="ghost" data-action="signout">Sign out</button></div>'}
      <nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === S.tab ? 'on' : ''}">${l}</button>`).join('')}</nav>`;
    wirePreviews(); wireChart();
  }
  async function refresh(msg) {
    try { await load(); render(); if (msg) toast(msg); }
    catch (e) { if (e.message !== 'Signed out') toast(e.message, true); }
  }

  // ---------------------------------------------------------------- previews (mirror the database math)
  const $f = (id) => document.getElementById(id);
  const fv = (form, name) => (form.elements[name] ? form.elements[name].value : '');
  function wirePreviews() {
    for (const [id, fn] of [['eqForm', eqPrev], ['depForm', depPrev], ['wdForm', wdPrev], ['qForm', qPrev]]) {
      const el = $f(id); if (el) { el.addEventListener('input', () => fn(el)); fn(el); }
    }
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
  const holder = (id) => S.all.find((h) => h.id === id);
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
      return `<div class="row"><span class="l">${esc(h.name || h.username)}<br><span class="note">HWM ${f(h.hwm, 4)}</span></span><span class="r">${f(fee, 4)} units<br><span class="note">${usdt(fee * price)}</span></span></div>`;
    }).join('');
    setPrev('qPrev', `Price ${f(price, 4)}.${rows || '<br>No investors hold units.'}<div class="row"><span class="l"><b>Total to manager</b></span><span class="r"><b>${f(tot, 4)} units</b> (${usdt(tot * price)})</span></div>`);
  }

  // ---------------------------------------------------------------- actions
  async function act(fn, okMsg) {
    try { await fn(); await refresh(okMsg); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); }
  }
  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const rg = ev.target.closest('[data-range]');
    if (rg) { S.range = rg.dataset.range; render(); return; }
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, id = b.dataset.id;
    if (a === 'signout') { const t = S.token; signedOut(); try { await rpc('logout', { p_token: t }); } catch { /* already gone */ } }
    else if (a === 'refresh') refresh();
    else if (a === 'maxunits') { $f('rq-u').value = S.me.unlocked_units; }
    else if (a === 'cancelreq') act(() => call('cancel_withdrawal_request', { p_id: Number(id) }), 'Request cancelled');
    else if (a === 'toggleactive') {
      const on = b.dataset.active === 'true';
      if (on && !confirm('Deactivate this person? They are signed out and cannot sign in until you reactivate them. Their units stay in the pool.')) return;
      act(() => call('admin_set_profile', { p_profile: id, p_name: null, p_active: !on, p_fee_rate: null }), on ? 'Deactivated' : 'Reactivated');
    }
    else if (a === 'allunits') { const fm = $f('wdForm'), h = holder(fv(fm, 'who')); if (h) { fm.elements.units.value = h.units; wdPrev(fm); } }
    else if (a === 'viewas') { try { await viewAs(id); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'exitview') backToManager();
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
      if (id === 'loginForm') {
        const r = await rpc('login', { p_username: fv(fm, 'username'), p_password: fv(fm, 'password') });
        if (!r.ok) { toast(r.error, true); if (btn) btn.disabled = false; return; }
        S.token = r.token; store.set(r.token); await refresh();
      } else if (id === 'pwForm') {
        await call('change_my_password', { p_old: fv(fm, 'old'), p_new: fv(fm, 'new') });
        fm.reset(); toast('Password changed'); if (btn) btn.disabled = false;
      } else if (id === 'newUserForm') {
        await call('admin_create_user', { p_username: fv(fm, 'username'), p_name: fv(fm, 'name'), p_password: fv(fm, 'password'), p_fee_rate: num(fv(fm, 'fee')) / 100 });
        await refresh(`Account created for ${fv(fm, 'name')}. Send them the username and password.`);
      } else if (fm.classList.contains('resetForm')) {
        await call('admin_set_password', { p_profile: fm.dataset.id, p_new: fv(fm, 'password') });
        fm.reset(); toast('Password set. They were signed out on their other devices.'); if (btn) btn.disabled = false;
      } else if (fm.classList.contains('profForm')) {
        await call('admin_set_profile', { p_profile: fm.dataset.id, p_name: fv(fm, 'name'), p_active: null, p_fee_rate: num(fv(fm, 'fee')) / 100 });
        await refresh('Saved');
      } else if (id === 'reqForm') {
        const r = await call('request_withdrawal', { p_units: num(fv(fm, 'units')), p_note: null });
        await refresh(`Requested. You will be paid by ${day(r.pay_by)}.`);
      } else if (id === 'eqForm') {
        await call('admin_post_equity', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh('Equity saved');
      } else if (id === 'depForm') {
        const r = await call('admin_deposit', { p_profile: fv(fm, 'who'), p_usdt: num(fv(fm, 'usdt')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_php_amount: num(fv(fm, 'pesos')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(`Deposit recorded: ${f(r.units, 4)} units at ${f(r.unit_price, 4)}`);
      } else if (id === 'wdForm') {
        const r = await call('admin_withdraw', { p_profile: fv(fm, 'who'), p_units: num(fv(fm, 'units')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm), p_force: fm.elements.force.checked, p_request_id: num(fv(fm, 'reqid')) });
        await refresh(`Withdrawal recorded. Pay out ${usdt(r.pay_usdt)}`);
      } else if (id === 'qForm') {
        if (!confirm('Charge performance fees and close the quarter? This cannot be undone.')) { if (btn) btn.disabled = false; return; }
        const r = await call('admin_close_quarter', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(`Quarter closed: ${r.investors_charged} charged, ${f(r.fee_units, 4)} fee units`);
      } else if (btn) btn.disabled = false;
    } catch (e) { if (e.message !== 'Signed out') toast(e.message || String(e), true); if (btn && btn.isConnected) btn.disabled = false; }
  });

  // ---------------------------------------------------------------- start
  S.token = store.get(); S.adminToken = store.get(ADMIN_KEY);
  if (S.token) refresh(); else loginView();
})();

// Lucidyo Ledger: paper record of a pooled account, valued in USDT and shown in pesos at the live rate. All numbers come from database functions;
// every call carries the session token from login (username + password checked and hashed in the database).
(() => {
  const C = window.CONFIG;
  const TERMS_VERSION = '2026-10-22';   // bump when the terms wording below changes: every investor is asked to agree again at their next sign-in
  const SPLASH_MS = 5600;               // how long the quote screen stays (tap Skip to leave sooner)
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = document.getElementById('app');
  const TOKEN_KEY = 'ledger.token', ADMIN_KEY = 'ledger.admin_token';   // ADMIN_KEY: the manager's own session while "viewing as"
  const S = { tab: null, token: null, adminToken: null, uid: null, me: null, pool: null, hist: [], history: [], ledger: [], reqs: [], all: [], elog: [], reports: [], pend: [], range: 'ALL', rec: 'eq', fx: null, cur: 'PHP', addUser: false, welcome: null, welcomeDone: false, gate: null, termsRO: false, splashT: null };

  // ---------------------------------------------------------------- icons (stroke icons, inherit text colour)
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    home: svg('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
    pool: svg('<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
    activity: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
    record: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>'),
    quarter: svg('<rect x="3" y="4.5" width="18" height="16.5" rx="4"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/>'),
    log: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
    mine: svg('<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2"/>'),
    refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    auto: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
    arrowIn: svg('<path d="M12 5v14M5 12l7 7 7-7"/>'),
    arrowOut: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    share: svg('<path d="M12 3v9l7.5 4.5"/><circle cx="12" cy="12" r="9"/>'),
    fee: svg('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>'),
    dash: svg('<rect x="3" y="3" width="7.5" height="9" rx="2"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="2"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/>'),
    about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>'),
    logo: svg('<path d="M4 17l5-6 4 3 7-8"/><path d="M15 6h5v5"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2.5"/><g class="shackle"><path d="M8 11V8a4 4 0 0 1 8 0v3"/></g>'),
    reports: svg('<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.5h6M9 9.5h2"/>'),
  };

  // ---------------------------------------------------------------- theme: system -> light -> dark (same cycle as Tolits)
  const THEME_KEY = 'ledger.theme', THEMES = ['system', 'light', 'dark'];
  const themePref = () => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } };
  function applyTheme(p) {
    if (p === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', p);
    try { p === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, p); } catch { /* not saved: still applies now */ }
    const dark = p === 'dark' || (p === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', dark ? '#0A0A0A' : '#F4F4F0');
  }
  const themeBtn = () => { const p = themePref(); return `<button class="iconbtn" data-action="theme" aria-label="Theme: ${p}. Tap to change" title="Theme: ${p}">${ICON[p === 'light' ? 'sun' : p === 'dark' ? 'moon' : 'auto']}</button>`; };
  applyTheme(themePref());

  // ---------------------------------------------------------------- formatting
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usdt = (v, d = 2) => f(v, d) + ' USDT';
  const sgn = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v), d);
  const pct = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v) * 100, d) + '%';
  const php = (v) => { const a = Math.abs(v); return '₱' + a.toLocaleString('en-PH', { minimumFractionDigits: a >= 1000 ? 0 : 2, maximumFractionDigits: a >= 1000 ? 0 : 2 }); };
  const peso = (u, rate) => (rate ? '≈ ' + php(u * rate) : '');
  // display currency: pesos (live rate) by default, USDT when the rate is unavailable or the user flips the switch
  const inPeso = () => S.cur === 'PHP' && !!rate();
  const money = (u) => (inPeso() ? (u < 0 ? '−' : '') + php(u * rate()) : usdt(u));              // main figure
  const alt = (u) => (rate() ? (inPeso() ? usdt(u) : '≈ ' + php(u * rate())) : '');                // the same amount in the other currency
  const smoney = (u) => (u > 0 ? '+' : u < 0 ? '−' : '') + (inPeso() ? php(u * rate()) : usdt(Math.abs(u)));
  const day = (s) => (s ? new Date(String(s).length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const pc = (rate) => String(Number((Number(rate) * 100).toFixed(4)));
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const isAdmin = () => S.me && S.me.role === 'admin';
  // fee in units on taking `units` from a person's oldest deposits first, each measured against its own line
  function lotFee(h, units, price) {
    if (!h || h.role !== 'investor' || !(price > 0)) return 0;
    let left = units, fee = 0;
    for (const [u, line] of h.lots || []) { if (left <= 0) break; const t = Math.min(left, Number(u)); fee += Number(h.fee_rate) * Math.max(0, price - Number(line)) / price * t; left -= t; }
    return fee;
  }
  const lotGain = (h, price) => (h.lots || []).reduce((t, [u, line]) => t + Math.max(0, price - Number(line)) * Number(u), 0);   // USDT above the lines
  const rateText = (h) => pc(h.fee_rate) + '%' + (h.fee_rate_next != null ? ` → ${pc(h.fee_rate_next)}% after next close` : '');

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
    S.token = null; S.me = null; S.welcome = null; S.welcomeDone = false; S.gate = null; S.termsRO = false; clearTimeout(S.splashT); S.splashT = null; store.set(null); loginView(); if (msg) toast(msg, true);
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
    S.side = 'fund'; S.tab = 'users'; S.uid = null; await refresh(msg);
    S.tab = 'users'; render();
  }

  // ---------------------------------------------------------------- data
  async function load() {
    S.me = await call('my_summary');
    if (!S.me) { signedOut(); throw new Error('Signed out'); }
    if (S.uid !== S.me.id) { S.uid = S.me.id; S.tab = null; }   // a different person signed in: start on their first tab
    const admin = S.me.role === 'admin';   // only the manager sees the pool; investors get just their own money
    const [pool, hist, history, led, reqs, all, elog, pend] = await Promise.all([admin ? call('pool_summary') : null, admin ? call('price_history') : [], call('my_history'),
      call(admin ? 'admin_ledger' : 'my_ledger'), call(admin ? 'admin_requests' : 'my_requests'),
      admin ? call('admin_overview') : null, admin ? call('admin_equity_log') : null, call(admin ? 'admin_pending' : 'my_pending'),
      loadFx(), admin ? loadReports() : null, loadFund(), admin ? loadAdminExtras() : null]);
    S.pool = pool; S.hist = hist; S.history = history; S.ledger = led; S.reqs = reqs; S.all = all || []; S.elog = elog || []; S.pend = pend || [];
  }
  async function loadFund() { try { S.fund = (await rpc('fund_returns', { p_token: S.token })) || []; } catch { S.fund = []; } }
  // reports/index.json: a small registry of compiled HTML reports (see reports/README or the folder itself to add one).
  // Plain static files, not database rows — missing or unreadable just means an empty Reports tab, never a hard error.
  async function loadReports() {
    try { const r = await fetch('reports/index.json', { cache: 'no-store' }); S.reports = r.ok ? await r.json() : []; }
    catch { S.reports = []; }
  }
  // live USD -> PHP (USDT trades ~1:1 with USD). Two free sources, cached for an hour, falls back to the last rate the manager recorded.
  const FX_KEY = 'ledger.fx', FX_SRC = [['https://open.er-api.com/v6/latest/USD', 'open.er-api.com'], ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP', 'frankfurter.dev']];
  async function loadFx() {
    let cached = null; try { cached = JSON.parse(localStorage.getItem(FX_KEY) || 'null'); } catch { /* none */ }
    if (cached && Date.now() - cached.t < 36e5) { S.fx = cached; return; }
    for (const [url, name] of FX_SRC) {
      try {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4000);
        const v = Number((await (await fetch(url, { signal: ctl.signal })).json()).rates.PHP); clearTimeout(to);
        if (v > 0) { S.fx = { rate: v, t: Date.now(), src: name }; try { localStorage.setItem(FX_KEY, JSON.stringify(S.fx)); } catch { /* not cached */ } return; }
      } catch { /* try the next source */ }
    }
    if (!S.fx) S.fx = cached;   // stale beats nothing
  }
  const rate = () => (S.fx && S.fx.rate) || (S.pool && S.pool.php_rate) || (S.me && S.me.php_rate) || null;
  const rateNote = () => (S.fx ? `1 USDT ≈ ${php(S.fx.rate)} (live ${S.fx.src}, ${new Date(S.fx.t).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })})` : rate() ? `1 USDT ≈ ${php(rate())} (last rate the manager recorded)` : 'Peso rate unavailable');
  const curBtn = () => (rate() ? `<button class="iconbtn txt" data-action="cur" aria-label="Showing ${inPeso() ? 'pesos' : 'USDT'}. Tap to switch" title="${rateNote()}">${inPeso() ? '₱' : '$'}</button>` : '');

  // ---------------------------------------------------------------- shared pieces
  // a line + soft gradient area underneath (shared by both charts)
  function area(id, xs, ys, W, H, color, extra = '') {
    const pts = xs.map((x, i) => `${x.toFixed(2)},${ys[i].toFixed(2)}`).join(' ');
    return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" style="stop-color:${color};stop-opacity:.34"/><stop offset="70%" style="stop-color:${color};stop-opacity:.06"/><stop offset="100%" style="stop-color:${color};stop-opacity:0"/></linearGradient></defs>
      ${extra}<polygon fill="url(#${id})" points="${xs[0].toFixed(2)},${H} ${pts} ${xs[xs.length - 1].toFixed(2)},${H}"/>
      <polyline class="ln" fill="none" style="stroke:${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${pts}"/>`;
  }
  function chart(hist) {
    if (!hist || hist.length < 2) return '<p class="note">The chart appears after the second equity update.</p>';
    const ys = hist.map((h) => Number(h.unit_price)); const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo || 0.01) * 0.15;
    const a = lo - pad, b = hi + pad, W = 300, H = 110;
    const color = `var(--${ys[ys.length - 1] >= ys[0] ? 'up' : 'down'})`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Unit price history">
      ${area('pfill', ys.map((_, i) => (i / (ys.length - 1)) * W), ys.map((y) => H - ((y - a) / (b - a)) * H), W, H, color)}</svg>
      <div class="row"><span class="l">Low / High</span><span class="r">${f(lo, 4)} / ${f(hi, 4)}</span></div>`;
  }
  // ---------------------------------------------------------------- manager dashboard (the pool is for the manager's eyes only)
  function viewDashboard() {
    const p = S.pool, tot = Number(p.total_units) || 1, inv = S.all.filter((h) => h.role === 'investor');
    const sum = (a, k) => a.reduce((t, h) => t + Number(h[k]), 0);
    const invValue = sum(inv, 'value_usdt'), invIn = sum(inv, 'net_in_usdt'), due = sum(inv, 'accrued_fee_usdt');
    const pend = S.reqs.filter((q) => q.status === 'pending'), pendUsdt = pend.reduce((t, q) => t + Number(q.units) * Number(p.unit_price), 0);
    const seg = [['Investors', p.investor_units, 'var(--seg2)'], ['Manager capital', p.admin_capital_units, 'var(--seg1)'], ["Fees earned", p.admin_fee_units, 'var(--seg3)']];
    return `<div class="card hero"><h2>Fund value</h2>
        <div class="big">${money(p.equity_usdt)}</div><div class="sub">${alt(p.equity_usdt)}</div>
        <div class="delta ${cls(p.since_start_pct)}">${pct(p.since_start_pct)} since start</div>
        <p class="note" style="margin:8px 0 0">Last updated ${p.asof ? day(p.asof) : '—'} · unit price ${f(p.unit_price, 4)}</p>${lastClose()}</div>
      <div class="card"><div class="grid">
        <div class="stat"><div class="k">Investors</div><div class="v">${p.investor_count}</div></div>
        <div class="stat"><div class="k">Investors' money</div><div class="v">${money(invValue)}</div></div>
        <div class="stat"><div class="k">Put in by investors</div><div class="v">${inPeso() ? pesoText(inv.reduce((t, h) => t + pesosOf(h).net, 0)) : money(invIn)}</div></div>
        <div class="stat"><div class="k">Their fee due</div><div class="v">${money(due)}</div></div></div>
        ${S.pend.length ? `<div class="btns"><button class="ghost" data-tab="record" data-rec="dep">${S.pend.length} deposit${S.pend.length === 1 ? '' : 's'} waiting to join · ${money(pendTotal())}</button></div>` : ''}
        ${pend.length ? `<div class="btns"><button class="ghost" data-tab="log">${pend.length} withdrawal request${pend.length === 1 ? '' : 's'} · ${money(pendUsdt)}</button></div>` : '<p class="note" style="margin:12px 0 0">No withdrawal requests waiting.</p>'}</div>
      <div class="card"><h2>Fund performance</h2>${chart(S.hist)}</div>
      <div class="card"><h2>Who owns the pool</h2>
        <div class="split">${seg.map(([, u, c]) => `<i style="width:${(Number(u) / tot) * 100}%;background:${c}"></i>`).join('')}</div>
        <div class="legend">${seg.map(([n, u, c]) => `<span><b style="background:${c}"></b>${n} ${f((Number(u) / tot) * 100, 1)}%</span>`).join('')}</div>
        <p class="note" style="margin-top:8px">The fee comes only from profits and stays invested in the pool. Investors cannot see any of this page.</p></div>
      <p class="disc">${rateNote()}</p>`;
  }
  const KIND = {
    deposit: ['Deposit', 'in', 'arrowIn'], withdrawal: ['Withdrawal', 'out', 'arrowOut'],
    fee_out: ['Fee paid', 'share', 'share'], fee_in: ['Fee received', 'in', 'share'],
  };
  function activityRows(rows, withName) {
    if (!rows.length) return '<p class="note">Nothing yet.</p>';
    return rows.map((l) => {
      const [label, kind, ic] = KIND[l.kind] || [l.kind, '', 'share'];
      const sub = [day(l.ts), withName ? esc(l.name) : null, l.note ? esc(l.note) : null].filter(Boolean).join(' · ');
      return `<div class="tx"><div class="ic ${kind}">${ICON[ic]}</div>
        <div class="mid"><div class="t1">${label}</div><div class="t2">${sub}</div></div>
        <div class="amt ${l.kind === 'fee_out' ? 'share' : cls(l.usdt)}">${smoney(l.usdt)}<small>${withName ? sgn(l.units, 2) + ' units' : alt(Math.abs(l.usdt))}</small></div></div>`;
    }).join('');
  }
  const passwordCard = () => `<div class="card"><h2>Change your password</h2>
    <form id="pwForm"><label>Current password</label>${pw('old', 'current-password')}
    <label>New password (at least 8 characters)</label>${pw('new', 'new-password', 8)}
    <button class="full ghost">Change password</button></form>
    <p class="note">Your other phones/browsers will be signed out.</p></div>`;
  const DISC = `<p class="disc">This is a record of your share of a pooled trading account, shown in pesos at today's exchange rate. The balance grows or shrinks with the trading results. It is not a bank balance and is not insured. You can still lose money.</p>`;

  // ---------------------------------------------------------------- investor / shared views
  function viewHome() {
    const m = S.me, investor = m.role === 'investor';
    const pend = S.reqs.filter((q) => q.status === 'pending' && q.profile_id === m.id);
    const price = Number(m.unit_price), cut = lotFee(m, Number(m.unlocked_units), price) * price;   // fee that would come off (USDT)
    const avail = Number(m.unlocked_units) * price - cut;
    const mine = S.pend.filter((d) => !d.profile_id || d.profile_id === m.id);
    const waiting = investor && mine.length ? `<div class="card"><h2>Waiting to join the pool</h2>
      ${mine.map((d) => `<div class="row"><span class="l">Received ${day(d.received_at)}</span><span class="r">${d.php_amount ? php(d.php_amount) : money(d.usdt)}<br><span class="note">${usdt(d.usdt)}</span></span></div>`).join('')}
      <p class="note">New money joins at the next valuation, at that day's price. Until then it is set aside: it does not share in gains or losses made before it was in, and your lock-up starts when it joins.</p></div>` : '';
    return `${waiting}${growthCard(investor ? 'Your balance' : 'Your holdings')}
      ${investor ? growthMathCard(m) + sameBoatCard() + profitShareCard(m) : ''}${investor ? `<div class="card"><h2>Withdrawals</h2>
        <div class="row"><span class="l">Available to withdraw now<br><span class="note">after any fee</span></span><span class="r">${money(avail)}<br><span class="note">${alt(avail)}</span></span></div>
        <div class="row"><span class="l">Next part unlocks</span><span class="r">${day(m.next_unlock)}</span></div>
        <p class="note">Each deposit is locked for ${C.LOCK_MONTHS} months. Requests are paid within ${C.WITHDRAW_BUSINESS_DAYS} business days, at the value on the day of payout. If a fee is due, it comes off the payout.</p>
        ${m.impersonated ? '<p class="note">Read-only view: only the person can request a withdrawal.</p>' : `<form id="reqForm"><label for="rq-u">Amount to withdraw (${inPeso() ? '₱' : 'USDT'})</label>
          <input id="rq-u" name="amount" type="number" step="any" min="0" inputmode="decimal" required>
          <div class="btns"><button type="button" class="ghost" data-action="maxunits">Everything available</button><button>Request withdrawal</button></div></form>`}
        ${pend.length ? '<h2 style="margin-top:14px">Pending requests</h2>' + pend.map((q) => `<div class="row"><span class="l">${day(q.requested_at)} · about ${money(q.units * m.unit_price)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span><span class="r"><button class="ghost" data-action="cancelreq" data-id="${q.id}">Cancel</button></span></div>`).join('') : ''}</div>`
      : `<div class="card"><h2>Fee earned</h2>
        <div class="row"><span class="l">Stays invested in the pool</span><span class="r">${money(m.fee_units_value_usdt)}<br><span class="note">${f(m.fee_units_earned, 4)} units</span></span></div></div>`}
      ${recentCard()}${investor ? aboutTeaser() : ''}${m.impersonated ? '' : passwordCard()}${DISC}`;
  }
  const aboutTeaser = () => `<div class="card"><h2>Good to know</h2>
    <p class="note" style="margin:0 0 4px"><b style="color:var(--ink)">You can take your money out.</b> It grows with the fund's results, so the balance moves up and down. <b style="color:var(--ink)">You can still lose money.</b></p>
    <div class="btns"><button class="ghost" data-tab="about">Read how it works</button></div></div>`;
  // investor: the trading result, minus the manager's share, = what is theirs. Simple % on the money put in.
  function growthMathCard(m) {
    if (m.gross_return_pct == null || m.net_return_pct == null) return '';
    const paid = Number(m.fee_paid_units) * Number(m.unit_price), acc = Number(m.accrued_fee_usdt), share = Number(m.profit_share_usdt);
    return `<div class="card"><h2>How your growth is worked out</h2>
      <div class="row"><span class="l">You put in</span><span class="r">${putIn(m)}</span></div>
      ${inPeso() ? fxRow(m) : ''}
      <div class="row"><span class="l">The trading made</span><span class="r ${cls(m.gross_profit_usdt)}">${smoney(m.gross_profit_usdt)}<br><span class="note">${pct(m.gross_return_pct, 1)}</span></span></div>
      <div class="row"><span class="l">Fee (${pc(m.fee_rate)}% of new profit)<br><span class="note">${share > 0 ? `already taken ${money(paid)}${acc > 0 ? ` · owed this quarter ${money(acc)}` : ''}` : 'none so far'}</span></span><span class="r">${share > 0 ? '−' + money(share) : money(0)}<br><span class="note">${share > 0 ? '−' + f(Number(m.profit_share_pct_points) * 100, 1) + ' pts' : ''}</span></span></div>
      <div class="row"><span class="l"><b>Yours, after the fee</b></span><span class="r"><b class="${cls(m.net_profit_usdt)}">${smoney(m.net_profit_usdt)}</b><br><span class="note"><b>${pct(m.net_return_pct, 1)}</b> · balance ${money(m.net_value_usdt)}</span></span></div>
      <p class="note">Your balance and % on this page are always shown <b>after</b> the fee, so it is what is yours. The fee is ${pc(m.fee_rate)}% of new profit above your best-ever level, worked out at each quarter end. If the fund drops after a quarter end, the fee already taken stays taken, so it can be more than ${pc(m.fee_rate)}% of the profit you have left; nothing new is taken until your balance climbs back above that best level. The fee already taken is shown at today's value.</p></div>`;
  }
  function profitShareCard(m) {
    const keep = 1 - Number(m.fee_rate), paid = -S.ledger.filter((l) => l.kind === 'fee_out' && l.profile_id === m.id).reduce((a, l) => a + Number(l.usdt), 0);
    const above = Number(m.accrued_fee_usdt) > 0;
    return `<div class="card"><h2>Fee</h2>
      <div class="split"><i style="width:${keep * 100}%;background:var(--up)"></i><i style="width:${(1 - keep) * 100}%;background:var(--seg3)"></i></div>
      <div class="legend" style="margin-bottom:6px"><span><b style="background:var(--up)"></b>You keep ${pc(keep)}% of new profits</span><span><b style="background:var(--seg3)"></b>Manager ${pc(1 - keep)}%</span></div>
      ${m.fee_rate_next != null ? `<p class="note" style="margin:0 0 6px">From the next quarter close your fee becomes <b>${pc(m.fee_rate_next)}%</b>. Profit made before then is charged at ${pc(m.fee_rate)}%.</p>` : ''}
      <div class="row"><span class="l">${above ? 'Fee due at quarter end (estimate)' : 'Fee due now'}</span><span class="r">${above ? money(m.accrued_fee_usdt) : 'None: below your best'}</span></div>
      <div class="row"><span class="l">Your balance after it</span><span class="r"><b>${money(m.value_after_fee_usdt)}</b></span></div>
      <div class="row"><span class="l">Shared so far</span><span class="r">${money(paid)}</span></div>
      <p class="note">The fee is charged only on <b>new</b> profit above your best-ever level, never on the money you put in. Each deposit keeps its own best-ever level, so adding money never changes what an earlier deposit owes. While your balance is below its best, no fee is charged. It is settled once a quarter inside the pool; no cash moves.</p></div>`;
  }
  function recentCard() {
    const mine = S.ledger.filter((l) => l.profile_id === S.me.id);
    return `<div class="card"><h2>Recent transactions</h2>${activityRows(mine.slice(0, 5), false)}
      ${mine.length > 5 ? `<div class="btns"><button class="ghost" data-tab="${isAdmin() ? 'log' : 'activity'}">See all ${mine.length}</button></div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- growth chart (Robinhood-style: drag across it to see any day)
  const RANGES = [['1W', 7, 'Past week'], ['1M', 30, 'Past month'], ['3M', 91, 'Past 3 months'], ['YTD', 'ytd', 'This year'], ['1Y', 365, 'Past year'], ['ALL', null, 'All time']];
  // an investor's history with the latest point after the fee owed so far, so the balance and % are what is theirs
  function netHistory() {
    const H = (S.history || []).map((p) => ({ ...p })), acc = S.me && S.me.role === 'investor' ? Number(S.me.accrued_fee_usdt) || 0 : 0;
    if (acc > 0 && H.length) H[H.length - 1].value = Number(H[H.length - 1].value) - acc;
    return H;
  }
  function series() {
    const H = netHistory().map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value), n: Number(p.net_in) }));
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
    if (!pts.length) return `<div class="card hero"><h2>${title}</h2><div class="big">${money(m.value_usdt)}</div><div class="sub">${alt(m.value_usdt)}</div><p class="note">The chart starts with the first deposit.</p></div>`;
    const a = pts[0], z = pts[pts.length - 1], up = (z.v - z.n) - (a.v - a.n) >= 0;
    const t0 = a.t, t1 = Math.max(z.t, t0 + 1), lo = Math.min(...pts.map((p) => Math.min(p.v, p.n))), hi = Math.max(...pts.map((p) => Math.max(p.v, p.n)));
    const pad = (hi - lo || Math.max(hi, 1) * 0.05) * 0.12, y0 = lo - pad, y1 = hi + pad, W = 300, H = 130;
    const X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (v) => H - ((v - y0) / (y1 - y0)) * H;
    S.chart = { pts, X, Y, W, H, g: Returns.yourGrowth(pts) };
    const color = `var(--${up ? 'up' : 'down'})`;
    const dashed = `<polyline fill="none" stroke="var(--muted)" stroke-opacity=".7" stroke-width="1.2" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" points="${pts.map((p) => `${X(p.t).toFixed(2)},${Y(p.n).toFixed(2)}`).join(' ')}"/>`;
    return `<div class="card hero" style="--dot:${color}"><h2>${title}</h2>
      <div class="big" id="gv">${money(z.v)}</div><div class="sub" id="gp">${alt(z.v)}</div>
      <div id="gd" class="delta"></div>
      <div class="gwrap"><svg id="gc" class="growth" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Your balance over time">
        ${area('gfill', pts.map((p) => X(p.t)), pts.map((p) => Y(p.v)), W, H, color, dashed)}
        <line id="gx" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--muted)" stroke-opacity=".6" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
      </svg><span class="dot live" id="gdot"></span></div>
      <div class="ranges">${RANGES.map(([k]) => `<button class="${k === S.range ? 'on' : ''}" data-range="${k}">${k}</button>`).join('')}</div>
      <p class="note" style="margin:8px 0 0">Line: what your money is worth${m.role === 'investor' ? ', after the fee' : ''}. Dashed: what you have put in. Drag across the chart to see any day.</p>
      <p class="note" style="margin:4px 0 0">${rateNote()}. Pesos move with the exchange rate even when your USDT does not.</p></div>`;
  }
  function showPoint(i) {   // update the big number to the point under the finger (or the latest point)
    const { pts, X, Y, W, H } = S.chart, p = pts[i], a = pts[0], d = (p.v - p.n) - (a.v - a.n);
    const dot = $f('gdot'); dot.style.left = (X(p.t) / W) * 100 + '%'; dot.style.top = (Y(p.v) / H) * 100 + '%'; dot.classList.toggle('live', i === pts.length - 1);
    const g = S.chart.g, label = RANGES.find((x) => x[0] === S.range)[2];
    $f('gv').textContent = money(p.v);
    $f('gp').textContent = alt(p.v);
    $f('gd').className = 'delta ' + cls(d);
    $f('gd').textContent = `${smoney(d)} (${pct(g[i] / g[0] - 1)}) ${i === pts.length - 1 ? label : new Date(p.t).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`;
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
  const viewAbout = () => {
    const rate = S.me && S.me.role === 'investor' ? pc(S.me.fee_rate) : '10';
    return `<div class="card"><h2>Growing this together</h2>
      <p class="about">This is a small fund we are growing together. Your money goes into one trading account that the manager trades, and the manager's own money is in the same pool. Whatever the trading makes or loses is shared by how much each person has in, so everyone is on the same side.</p>
      <p class="about"><b>It is your money and you can take it out.</b> After the ${C.LOCK_MONTHS}-month lock-up on each deposit, ask for a withdrawal on the Home page. You can take part of it or all of it, and it is paid within ${C.WITHDRAW_BUSINESS_DAYS} business days at the value on the day of payout.</p>
      <p class="about"><b>Fair to everyone who joins later.</b> New money waits until the next valuation and then buys in at that day's price. So it never shares in profit made before it arrived, and never pays for losses from before either.</p>
      <p class="about">Profits stay in the pool and grow with it, so the balance moves up and down with the results instead of paying out each month. Some weeks and months will be flat or down.</p>
      <p class="about"><b>You can still lose money.</b> Nothing is guaranteed or insured, and past or backtested results are not a promise. Please put in only what you are comfortable with.</p></div>
    <div class="card"><h2>The fee</h2>
      <p class="about"><b>We only charge when you earn.</b> The fee is ${rate}% of <b>new profit</b> and nothing else: no sign-up charge, no yearly charge, and nothing on your own money.</p>
      <p class="about">If the fund is down, no fee is charged. After a dip it has to climb back above your previous best before any fee is charged again. The fee is worked out once a quarter inside the pool, so no cash moves.</p>
      <p class="about"><b>Your rate is ${rate}%</b>, as agreed with the manager. Rates are set per person and can change at any time, for example for people who join later as the fund grows.</p></div>
    <div class="card"><h2>Pesos</h2>
      <p class="about">The pool trades in USDT (a dollar-linked coin). Your pesos are worked out with the live dollar-to-peso rate, so the peso number can move a little even when the trading did not. The ₱ / $ button at the top switches the view.</p></div>
    <div class="card"><h2>Good to know</h2>
      <p class="about">This page is a record kept by the manager. It is not a bank account and is not covered by deposit insurance.</p></div>${glossCard()}${termsCard()}`;
  };
  const viewActivity = () => `<div class="card"><h2>Your activity</h2>${activityRows(S.ledger, false)}</div>`;

  // ---------------------------------------------------------------- manager: "My account" side (only the manager's own money, never the pool)
  // For the manager S.ledger holds everyone's entries, so everything here is filtered to the manager's own profile.
  const myRows = (kinds) => S.ledger.filter((l) => l.profile_id === S.me.id && (!kinds || kinds.includes(l.kind)));
  function viewMine() {
    const m = S.me, mine = myRows(), fees = myRows(['fee_in']), feeTotal = fees.reduce((t, l) => t + Number(l.usdt), 0);
    return `${growthCard('My capital')}
      <div class="card"><h2>My money in the fund</h2><div class="grid">
        <div class="stat"><div class="k">Put in</div><div class="v">${putIn(m)}</div></div>
        <div class="stat"><div class="k">Worth now</div><div class="v">${money(m.value_usdt)}</div></div>
        <div class="stat"><div class="k">Total gain</div><div class="v ${cls(m.profit_usdt)}">${smoney(m.profit_usdt)}</div></div>
        <div class="stat"><div class="k">Share of the pool</div><div class="v">${m.share_pct == null ? '—' : f(m.share_pct * 100, 2) + '%'}</div></div></div>
        <div class="row"><span class="l">Units held</span><span class="r">${f(m.units, 4)}</span></div>
        <div class="row"><span class="l">Unit price now</span><span class="r">${f(m.unit_price, 4)}</span></div>
        ${inPeso() ? fxRow(m) : ''}
        <p class="note">Total gain includes the fee below, because those units are part of what you hold. New money joins at the next equity reading, at that day's price, like everyone's.</p>
        <div class="btns"><button class="ghost" data-tab="record" data-rec="dep" data-who="me" data-goside="fund">Add money</button><button class="ghost" data-tab="record" data-rec="wd" data-who="me" data-goside="fund">Take money out</button></div></div>
      ${myReturnsCard()}
      <div class="card"><h2>Fee received</h2>
        <div class="row"><span class="l">Received so far<br><span class="note">value when each fee arrived</span></span><span class="r">${money(feeTotal)}<br><span class="note">${alt(feeTotal)}</span></span></div>
        <div class="row"><span class="l">Worth now<br><span class="note">${f(m.fee_units_earned, 4)} units, still invested in the fund</span></span><span class="r">${money(m.fee_units_value_usdt)}<br><span class="note">${alt(m.fee_units_value_usdt)}</span></span></div>
        ${fees.length ? activityRows(fees.slice(0, 5), false) : '<p class="note">None yet. It arrives at a quarter close or when an investor withdraws, and only on profit above their best level.</p>'}
        ${fees.length > 5 ? `<div class="btns"><button class="ghost" data-tab="myhistory">See all</button></div>` : ''}</div>
      <div class="card"><h2>Recent transactions</h2>${activityRows(mine.slice(0, 5), false)}
        ${mine.length > 5 ? `<div class="btns"><button class="ghost" data-tab="myhistory">See all ${mine.length}</button></div>` : ''}</div>
      ${passwordCard()}`;
  }
  const viewMyHistory = () => `<div class="card"><h2>My transactions</h2>${activityRows(myRows(), false)}</div>`;

  // ---------------------------------------------------------------- returns from trading (maths in js/returns.js)
  // S.history: the signed-in person's points (one per pool event since they joined). S.fund: the unit price at every pool
  // event and whether the manager's own money was in. Money added or taken out never counts in any % here.
  const tms = (ts) => new Date(ts).getTime();
  function pctChart(lines) {   // lines: [{ name, color, dash, pts: [[time, return], ...] }]
    if (lines.some((l) => l.pts.length < 2)) return '<p class="note">The chart starts after the next equity reading.</p>';
    const all = lines.flatMap((l) => l.pts);
    const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(t0 + 1, ...all.map((p) => p[0]));
    let lo = Math.min(0, ...all.map((p) => p[1])), hi = Math.max(0, ...all.map((p) => p[1]));
    const pad = (hi - lo || 0.01) * 0.12; lo -= pad; hi += pad;
    const W = 300, H = 120, X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (r) => H - ((r - lo) / (hi - lo)) * H;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Return from trading over time">
      <line x1="0" x2="${W}" y1="${Y(0).toFixed(2)}" y2="${Y(0).toFixed(2)}" stroke="var(--muted)" stroke-opacity=".55" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
      ${lines.map((l) => `<polyline fill="none" stroke="${l.color}" stroke-width="2.2" ${l.dash ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${l.pts.map((p) => `${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`).join(' ')}"/>`).join('')}</svg>
      <div class="legend" style="margin-top:8px">${lines.map((l) => { const r = l.pts[l.pts.length - 1][1]; return `<span><b style="background:${l.color}"></b>${l.name} <span class="${cls(r)}">${pct(r)}</span></span>`; }).join('')}</div>`;
  }
  const withNow = (pts) => (pts.length ? [...pts, [Date.now(), pts[pts.length - 1][1]]] : pts);   // flat until today
  function myGrowths() {
    const H = netHistory();
    return { H, yours: Returns.yourGrowth(H.map((p) => ({ v: Number(p.value), n: Number(p.net_in) }))),
             trading: Returns.tradingGrowth(H.map((p) => ({ u: Number(p.units), price: Number(p.price) }))) };
  }
  // investor: proof that the manager's own money made the same trading return over the same time
  function sameBoatCard() {
    const { H, yours, trading } = myGrowths(), F = S.fund || [];
    if (H.length < 2 || !F.length) return '';
    const mg = Returns.managerGrowth(F), at = new Map(F.map((r, i) => [r.id, i])), j0 = at.get(H[0].id);
    if (j0 == null || H.some((p) => !at.has(p.id))) return '';
    const mgr = H.map((p) => mg[at.get(p.id)] / mg[j0] - 1), you = yours.map((g) => g / yours[0] - 1), fundAll = Returns.total(mg);
    const lines = [{ name: "Manager's own money", color: 'var(--seg1)', pts: withNow(H.map((p, k) => [tms(p.ts), mgr[k]])) },
                   { name: 'You, after fee', color: 'var(--seg2)', dash: true, pts: withNow(H.map((p, k) => [tms(p.ts), you[k]])) }];
    return `<div class="card"><h2>Same trading as the manager</h2>
      ${pctChart(lines)}
      <div class="grid" style="margin-top:12px">
        <div class="stat"><div class="k">Your trading return</div><div class="v ${cls(Returns.total(trading))}">${pct(Returns.total(trading))}</div></div>
        <div class="stat"><div class="k">Manager's own money, same time</div><div class="v ${cls(mgr[mgr.length - 1])}">${pct(mgr[mgr.length - 1])}</div></div></div>
      <div class="row"><span class="l">You, after fee</span><span class="r ${cls(Returns.total(yours))}">${pct(Returns.total(yours))}</span></div>
      <div class="row"><span class="l">Manager's own money since the fund started</span><span class="r ${cls(fundAll)}">${pct(fundAll)}</span></div>
      <p class="note">The manager's own money is in this same pool and bought units at the same prices as yours, so the trading made the same % for both. The only difference is the fee on new profit. Money added or taken out by anyone never counts in these %.</p></div>`;
  }
  // manager: own return from trading only, and with the fee received
  function myReturnsCard() {
    const { H, yours, trading } = myGrowths();
    if (!H.length) return '';
    const tr = trading.map((g) => g / trading[0] - 1), yo = yours.map((g) => g / yours[0] - 1);
    const lines = [{ name: 'Trading only', color: 'var(--seg1)', pts: withNow(H.map((p, k) => [tms(p.ts), tr[k]])) },
                   { name: 'With fee received', color: 'var(--seg2)', dash: true, pts: withNow(H.map((p, k) => [tms(p.ts), yo[k]])) }];
    return `<div class="card"><h2>My return from trading</h2>
      ${pctChart(lines)}
      <div class="grid" style="margin-top:12px">
        <div class="stat"><div class="k">Trading only</div><div class="v ${cls(Returns.total(trading))}">${pct(Returns.total(trading))}</div></div>
        <div class="stat"><div class="k">With fee</div><div class="v ${cls(Returns.total(yours))}">${pct(Returns.total(yours))}</div></div></div>
      <p class="note"><b>Trading only</b> is what the trading did to your money, and it is exactly what investors see as "Manager's own money". Money you add or take out never counts. <b>With fee</b> adds the fees you received from investors, so it also moves with how much of your own money is in.</p></div>`;
  }

  // ---------------------------------------------------------------- pesos: "put in" is what was really paid
  // In pesos the old figure was dollars converted at TODAY's rate, so it drifted away from what the person handed over.
  // Here it is the pesos on the deposit entries (and withdrawals at the rate they were paid), plus the exchange-rate part shown on its own.
  const pesosOf = (h) => Returns.pesos(S.ledger.filter((l) => l.profile_id === h.id), rate() || 0);
  const pesoText = (n) => (n < 0 ? '−' : '') + php(n);
  const putIn = (h) => (inPeso() ? pesoText(pesosOf(h).net) : usdt(h.net_in_usdt));
  const fxRow = (h) => {
    const p = pesosOf(h);
    return Math.abs(p.fx) < 0.5 ? '' : `<div class="row"><span class="l">Peso exchange rate<br><span class="note">the peso moved since the money went in, so the ₱ balance includes this</span></span><span class="r ${cls(p.fx)}">${p.fx > 0 ? '+' : '−'}${php(p.fx)}</span></div>`;
  };

  // ---------------------------------------------------------------- statements, month by month, worst drop (maths in js/returns.js)
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = (key) => MONTH_NAMES[Number(key.slice(5)) - 1] + ' ' + key.slice(0, 4);
  const sUsdt = (v) => (Math.abs(v) < 0.005 ? '' : v > 0 ? '+' : '−') + f(Math.abs(v)) + ' USDT';
  const myMonths = () => Returns.monthly(S.history || [], myRows());
  const stmtMonth = (rows) => rows.find((m) => m.key === S.stmt) || [...rows].reverse().find((m) => !m.partial) || rows[rows.length - 1];
  const inMonth = (m) => myRows().filter((l) => { const t = Date.parse(l.ts); return t >= m.from && t < m.to; }).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const isSim = () => myRows().some((l) => /backtest simulation/i.test(l.note || ''));

  function viewStatements() {
    const rows = myMonths();
    if (!rows.length) return '<div class="card"><h2>Statements</h2><p class="note">Statements start with your first deposit.</p></div>';
    const m = stmtMonth(rows), mgr = isAdmin();
    return `${monthTableCard(rows, m, mgr)}${dropCard(mgr)}${statementCard(m, mgr)}`;
  }
  function monthTableCard(rows, sel, mgr) {
    return `<div class="card noprint"><h2>Month by month</h2>
      <div class="mtab"><div class="mh"><span>Month</span><span>Trading</span><span>${mgr ? 'With fee' : 'After fee'}</span><span>Balance</span></div>
      ${[...rows].reverse().map((m) => `<button class="mrow ${m.key === sel.key ? 'on' : ''}" data-action="stmtpick" data-id="${m.key}">
        <span>${monthName(m.key).slice(0, 3)} ${m.key.slice(0, 4)}${m.partial ? ' <i>to date</i>' : ''}</span>
        <span class="${cls(m.tradingPct)}">${pct(m.tradingPct, 1)}</span><span class="${cls(m.yourPct)}">${pct(m.yourPct, 1)}</span><span>${f(m.closing)}</span></button>`).join('')}</div>
      <p class="note" style="margin:8px 0 0"><b>Trading</b> is what the trading did that month. <b>${mgr ? 'With fee' : 'After fee'}</b> ${mgr ? 'adds the fee you received.' : 'is what was yours after the fee.'} Money you add or take out never counts in either %. Balance is in USDT at the end of the month. Tap a month to open its statement below.</p></div>`;
  }
  function dropCard(mgr) {
    const H = S.history || [];
    if (H.length < 2) return '';
    const pts = H.map((p) => ({ v: Number(p.value), n: Number(p.net_in), t: Date.parse(p.ts) })), dd = Returns.drawdown(Returns.yourGrowth(pts), pts.map((p) => p.t));
    const F = S.fund || [], fd = F.length > 1 ? Returns.drawdown(Returns.tradingGrowth(F.map((r) => ({ u: 1, price: Number(r.price) }))), F.map((r) => Date.parse(r.ts))) : null;
    const d = (t) => day(new Date(t).toISOString());
    const line = (l, note, v) => `<div class="row"><span class="l">${l}<br><span class="note">${note}</span></span><span class="r ${cls(v)}">${v < 0 ? pct(v, 1) : 'None'}</span></div>`;
    return `<div class="card noprint"><h2>Worst drop from a high</h2>
      ${line('Your worst drop', dd.worst < 0 ? `${d(dd.peakAt)} → ${d(dd.troughAt)} · ${dd.recoveredAt ? 'back at that high on ' + d(dd.recoveredAt) : 'not back at that high yet'}` : 'your balance has not fallen from a high yet', dd.worst)}
      <div class="row"><span class="l">Right now<br><span class="note">${dd.current < 0 ? 'below your highest, reached ' + d(dd.highAt) : 'at your highest'}</span></span><span class="r ${cls(dd.current)}">${dd.current < 0 ? pct(dd.current, 1) : 'At the high'}</span></div>
      ${fd ? line('Whole fund, worst drop since it started', fd.worst < 0 ? `${d(fd.peakAt)} → ${d(fd.troughAt)}` : 'no fall yet', fd.worst) : ''}
      <p class="note">Measured on your own return${mgr ? '' : ' after the fee'}, so money you add or take out does not count. It uses each equity reading, so a fall between two readings can be deeper than shown. Drops like these are normal for a fund that trades crypto, and a past drop does not limit a future one.</p></div>`;
  }
  function statementCard(m, mgr) {
    const rows = myMonths(), entries = inMonth(m), who = S.me.name || S.me.username, feeLabel = mgr ? 'Fee received' : 'Fee';
    const line = (l, v, sub, strong) => `<div class="row"><span class="l">${strong ? `<b style="color:var(--ink)">${l}</b>` : l}${sub ? `<br><span class="note">${sub}</span>` : ''}</span><span class="r">${strong ? `<b>${v}</b>` : v}</span></div>`;
    return `<div class="card stmt" id="stmt">
      <div class="print-only"><div class="pt">Lucidyo · Statement</div><div class="ps">${esc(who)} · ${monthName(m.key)}${m.partial ? ' (to date)' : ''} · generated ${day(new Date().toISOString())}</div></div>
      <div class="noprint stmt-top"><h2 style="margin:0">Statement</h2>
        <select data-stmt aria-label="Month">${[...rows].reverse().map((x) => `<option value="${x.key}" ${x.key === m.key ? 'selected' : ''}>${monthName(x.key)}${x.partial ? ' (to date)' : ''}</option>`).join('')}</select></div>
      ${line('Opening balance', usdt(m.opening))}
      ${line('Money added', sUsdt(m.deposits) || usdt(0), m.phpIn > 0 ? `${php(m.phpIn)} paid in` : '')}
      ${line('Money taken out', m.withdrawals ? '−' + usdt(m.withdrawals) : usdt(0), m.phpOut > 0 ? `${php(m.phpOut)} paid out` : '')}
      ${line('Trading result', sUsdt(m.trading) || usdt(0), `${pct(m.tradingPct, 2)} on the money in the fund`)}
      ${line(feeLabel, sUsdt(m.profitShare) || usdt(0), mgr ? 'received from investors' : 'taken from new profit')}
      ${line('Closing balance', usdt(m.closing), `${pct(m.yourPct, 2)} this month${mgr ? ', with the fee received' : ', after the fee'}`, true)}
      ${entries.length ? `<h2 style="margin-top:16px">Entries this month</h2>${activityRows(entries, false)}` : ''}
      <p class="note stmt-foot">Balances are in USDT, a dollar-linked coin, because that is what the fund is counted in. Pesos move with the exchange rate, so they are shown only where pesos were really paid in or out.${isSim() ? ' <b>This history includes simulated (backtest) entries, not real trading.</b>' : ''} Past results do not promise future ones. You can lose money.</p>
      <div class="btns noprint"><button class="ghost" data-action="stmtcsv">Download this month (CSV)</button><button class="ghost" data-action="stmtallcsv">All months (CSV)</button><button data-action="stmtprint">Save as PDF</button></div></div>`;
  }
  function download(name, text, mime = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: mime })), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const money2 = (v) => Number(v).toFixed(2);
  function stmtAllCsv() {
    const mgr = isAdmin();
    return Returns.toCsv([['Month', (m) => m.key], ['Part of month', (m) => (m.partial ? 'to date' : 'full month')], ['Opening (USDT)', (m) => money2(m.opening)],
      ['Money added (USDT)', (m) => money2(m.deposits)], ['Money taken out (USDT)', (m) => money2(m.withdrawals)], ['Trading result (USDT)', (m) => money2(m.trading)],
      [(mgr ? 'Fee received' : 'Fee') + ' (USDT)', (m) => money2(m.profitShare)], ['Closing (USDT)', (m) => money2(m.closing)],
      ['Trading return (%)', (m) => (m.tradingPct * 100).toFixed(2)], [(mgr ? 'Return with fee received' : 'Return after fee') + ' (%)', (m) => (m.yourPct * 100).toFixed(2)],
      ['Pesos paid in', (m) => money2(m.phpIn)], ['Pesos paid out', (m) => money2(m.phpOut)]], myMonths());
  }
  function stmtMonthCsv(m) {
    const mgr = isAdmin(), lines = [['Statement', monthName(m.key) + (m.partial ? ' (to date)' : '')], ['Name', S.me.name || S.me.username], ['Opening balance (USDT)', money2(m.opening)],
      ['Money added (USDT)', money2(m.deposits)], ['Money taken out (USDT)', money2(m.withdrawals)], ['Trading result (USDT)', money2(m.trading)], [(mgr ? 'Fee received' : 'Fee') + ' (USDT)', money2(m.profitShare)],
      ['Closing balance (USDT)', money2(m.closing)], ['Trading return (%)', (m.tradingPct * 100).toFixed(2)], [(mgr ? 'Return with fee received' : 'Return after fee') + ' (%)', (m.yourPct * 100).toFixed(2)],
      ['Pesos paid in', money2(m.phpIn)], ['Pesos paid out', money2(m.phpOut)]];
    const top = Returns.toCsv([['Item', (r) => r[0]], ['Value', (r) => r[1]]], lines);
    const ent = Returns.toCsv([['Date', (l) => new Date(l.ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'], ['Type', (l) => (KIND[l.kind] || [l.kind])[0]], ['USDT', (l) => money2(l.usdt)], ['Units', (l) => Number(l.units).toFixed(8)],
      ['Pesos', (l) => (l.php_amount == null ? '' : money2(l.php_amount))], ['Note', (l) => l.note || '']], inMonth(m));
    return top + '\r\n' + ent;
  }
  function printStatement() {
    const t = document.title, m = stmtMonth(myMonths());
    document.title = `Lucidyo statement ${m ? m.key : ''} ${S.me.name || S.me.username}`.trim();   // the suggested file name when saving as PDF
    window.print(); setTimeout(() => { document.title = t; }, 500);
  }
  document.addEventListener('change', (ev) => { const s = ev.target.closest && ev.target.closest('select[data-stmt]'); if (s) { S.stmt = s.value; render(); } });

  // ---------------------------------------------------------------- manager: activity log and backups
  const AUDIT_GROUPS = {
    money: ['money_received', 'money_handed_back', 'money_in', 'money_out', 'fee_charged', 'correction', 'withdrawal_requested', 'withdrawal_cancelled', 'withdrawal_paid'],
    readings: ['equity_reading', 'quarter_closed'],
    accounts: ['user_created', 'rate_changed', 'rate_scheduled', 'deactivated', 'reactivated', 'name_changed', 'terms_agreed'],
    security: ['password_changed', 'password_reset', 'viewed_as', 'setting_changed', 'backup_exported', 'backup_key_created', 'backup_keys_revoked'],
  };
  async function loadAdminExtras() {
    try { S.audit = await call('admin_audit_log', { p_limit: 200 }); S.auditMore = S.audit.length >= 200; } catch (e) { if (e.message === 'Signed out') throw e; S.audit = null; }
    try { S.backup = await call('admin_backup_status'); } catch (e) { if (e.message === 'Signed out') throw e; S.backup = null; }
  }
  const auditTime = (ts) => new Date(ts).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function auditText(r) {
    const d = r.detail || {}, self = !!r.subject_id && r.subject_id === r.actor_id, who = `<b>${esc(r.subject_name || '')}</b>`, own = self ? 'their' : `${who}'s`, u = (v) => `${usdt(Math.abs(Number(v)))}${rate() ? ' ' + peso(Math.abs(Number(v)), rate()) : ''}`;
    switch (r.action) {
      case 'user_created': return `created the account for ${who}${d.role === 'admin' ? ' (manager)' : ` (fee ${pc(d.fee_rate)}%)`}`;
      case 'rate_changed': return `changed ${who}'s fee from ${pc(d.from)}% to ${pc(d.to)}%`;
      case 'rate_scheduled': return `set ${who}'s fee to become ${pc(d.to)}% after the next quarter close`;
      case 'deactivated': return `deactivated ${who}'s account`;
      case 'reactivated': return `reactivated ${who}'s account`;
      case 'name_changed': return `renamed ${esc(d.from || '—')} to ${esc(d.to || '—')}`;
      case 'password_changed': return 'changed their own password';
      case 'password_reset': return `reset ${who}'s password`;
      case 'equity_reading': return `posted an equity reading of ${usdt(d.equity_usdt)} (unit price ${f(d.unit_price, 4)})${d.note ? ' · ' + esc(d.note) : ''}`;
      case 'quarter_closed': return `closed the quarter at ${usdt(d.equity_usdt)} (unit price ${f(d.unit_price, 4)})`;
      case 'money_received': return `recorded money received from ${who}: ${d.php_amount ? php(d.php_amount) + ' = ' : ''}${usdt(d.usdt)}, waiting to join`;
      case 'money_handed_back': return `handed back ${who}'s waiting money (${usdt(d.usdt)})`;
      case 'money_in': return `${who}'s money joined the pool: ${usdt(d.usdt)}${d.php_amount ? ' (' + php(d.php_amount) + ' paid)' : ''}`;
      case 'money_out': return `paid out ${u(d.usdt)} to ${who}`;
      case 'fee_charged': return `fee charged to ${who}: ${u(d.usdt)}`;
      case 'correction': return `recorded a correction${r.subject_name ? ' for ' + who : ''}${d.usdt != null ? ': ' + (Number(d.usdt) < 0 ? '−' : '') + usdt(Math.abs(Number(d.usdt))) : ''}${d.note ? ' · ' + esc(d.note) : ''}`;
      case 'withdrawal_requested': return `asked to withdraw ${f(d.units, 4)} units`;
      case 'withdrawal_cancelled': return `cancelled ${own} withdrawal request`;
      case 'withdrawal_paid': return `marked ${own} withdrawal request as paid`;
      case 'terms_agreed': return `agreed to the terms (${esc(d.version || '')})`;
      case 'viewed_as': return `opened the app as ${who} (read-only)`;
      case 'setting_changed': return `changed the setting ${esc(d.key)} from ${esc(d.from)} to ${esc(d.to)}`;
      case 'backup_exported': return `downloaded a backup (${esc(d.how || '')}, ${d.ledger_rows ?? '?'} entries)`;
      case 'backup_key_created': return `created a backup key "${esc(d.label || '')}"`;
      case 'backup_keys_revoked': return `revoked ${d.count ?? 'all'} backup key(s)`;
      default: return esc(r.action);
    }
  }
  function auditCard() {
    if (S.audit == null) return '<div class="card"><h2>Activity log</h2><p class="note">Not turned on yet. Run the SQL file <b>20261031000000_pesos_backup_audit.sql</b> once in the Supabase SQL Editor.</p></div>';
    const g = S.auditFilter || 'all', rows = S.audit.filter((r) => g === 'all' || (AUDIT_GROUPS[g] || []).includes(r.action));
    return `<div class="card"><h2>Activity log</h2>
      <div class="ranges" style="margin:0 0 10px">${[['all', 'All'], ['money', 'Money'], ['readings', 'Readings'], ['accounts', 'Accounts'], ['security', 'Security']].map(([k, l]) => `<button class="${k === g ? 'on' : ''}" data-action="auditfilter" data-id="${k}">${l}</button>`).join('')}</div>
      ${rows.length ? `<div class="alog">${rows.map((r) => `<div class="arow"><div class="at">${auditTime(r.ts)}</div><div class="ab"><b>${esc(r.actor_name || 'System')}</b> ${auditText(r)}</div></div>`).join('')}</div>` : '<p class="note">Nothing here yet.</p>'}
      ${S.auditMore && g === 'all' ? '<div class="btns"><button class="ghost" data-action="auditmore">Show older</button></div>' : ''}
      <p class="note" style="margin:10px 0 0">Every change to money and accounts is written here by the database itself, with who did it and when. Nobody can edit or delete a line, not even you. Sign-ins and page views are not recorded.</p></div>`;
  }
  function backupCard() {
    const b = S.backup;
    if (b == null) return '<div class="card"><h2>Backups</h2><p class="note">Not turned on yet. Run the SQL file <b>20261031000000_pesos_backup_audit.sql</b> once in the Supabase SQL Editor.</p></div>';
    const ago = (ts) => { const h = (Date.now() - new Date(ts).getTime()) / 36e5; return h < 1 ? 'less than an hour ago' : h < 48 ? Math.round(h) + ' hours ago' : Math.round(h / 24) + ' days ago'; };
    const stale = !b.last_automatic || Date.now() - new Date(b.last_automatic).getTime() > 3 * 864e5;
    return `<div class="card"><h2>Backups</h2>
      <p class="note" style="margin:0 0 8px">This ledger is the only record of who owns what. A backup saves everyone's entries, readings and the activity log (never passwords).</p>
      <div class="row"><span class="l">Last backup<br><span class="note">${b.last_export ? esc((b.last_export.detail || {}).how || '') : ''}</span></span><span class="r">${b.last_export ? ago(b.last_export.ts) : 'never'}</span></div>
      <div class="row"><span class="l">Automatic nightly backup</span><span class="r ${stale ? 'warn' : 'up'}">${b.last_automatic ? ago(b.last_automatic) : 'not set up'}</span></div>
      ${stale ? '<p class="note warn" style="margin:6px 0 0">No automatic backup in the last 3 days. Set it up below.</p>' : ''}
      <div class="btns"><button data-action="backupjson">Download backup (JSON)</button><button class="ghost" data-action="backupcsv">Entries (CSV)</button></div>
      <h2 style="margin-top:18px">Nightly backup key</h2>
      ${b.keys.length ? b.keys.map((k) => `<div class="row"><span class="l">${esc(k.label)}<br><span class="note">made ${day(k.created_at)}${k.last_used_at ? ' · used ' + ago(k.last_used_at) : ' · never used'}</span></span></div>`).join('') : '<p class="note">No key yet.</p>'}
      ${S.newKey ? `<div class="preview"><b>Copy this key now. It is shown only once.</b><br><span style="word-break:break-all;user-select:all;font-family:ui-monospace,monospace">${esc(S.newKey)}</span><br><span class="note">Put it in <b>backup.config.json</b> on the computer that runs the backup, then run <b>node scripts/backup-ledger.mjs --schedule 02:30</b> once. See the README.</span></div>` : ''}
      <div class="btns"><button class="ghost" data-action="makekey">Create nightly backup key</button>${b.keys.length ? '<button class="danger" data-action="revokekeys">Revoke all keys</button>' : ''}</div>
      <p class="note" style="margin:10px 0 0">The key can only read a backup. It cannot sign in, see the app or change anything, and revoking it stops it at once.</p></div>`;
  }
  async function backupDownload(kind) {
    const x = await call('admin_export_all'), stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'json') download(`lucidyo-ledger-backup-${stamp}.json`, JSON.stringify(x, null, 1), 'application/json');
    else download(`lucidyo-ledger-entries-${stamp}.csv`, Returns.toCsv([['id', (l) => l.id], ['date', (l) => l.ts], ['person', (l) => (x.people.find((p) => p.id === l.profile_id) || {}).username || l.profile_id], ['kind', (l) => l.kind],
      ['usdt', (l) => l.usdt], ['units', (l) => l.units], ['unit_price', (l) => l.unit_price], ['php_amount', (l) => l.php_amount], ['php_rate', (l) => l.php_rate], ['note', (l) => l.note]], x.ledger));
    await loadAdminExtras(); render(); toast(`Backup downloaded (${x.checks.ledger_rows} entries)`);
  }

  // ---------------------------------------------------------------- admin views
  function viewUsers() {
    return `<div class="sechead"><h2>Users (${S.all.length})</h2><button class="sm ${S.addUser ? 'ghost' : ''}" data-action="adduser">${S.addUser ? 'Cancel' : '+ Add user'}</button></div>
      ${S.addUser ? `<div class="card"><h2>New user</h2>
      <p class="note">Give them the username and password yourself. They can change the password after signing in.</p>
      <form id="newUserForm"><div class="grid form2"><div><label>Username</label><input name="username" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\\-]{3,30}" required></div>
        <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="10" required></div></div>
        <label>Full name</label><input name="name" required>
        <label>Starting password (at least 8 characters)</label><input name="password" type="text" minlength="8" autocomplete="off" required>
        <button class="full">Create account</button></form></div>` : ''}
      <div class="card">${S.all.map((h) => `<div class="person">
        <div class="top"><span class="nm">${esc(h.name || h.username)} <span class="chip">${h.role === 'admin' ? 'manager' : 'investor'}</span>${h.active ? '' : ' <span class="chip down">off</span>'}</span>
          <span><b>${money(h.value_usdt)}</b></span></div>
        <div class="top"><span class="note">@${esc(h.username)}</span>${h.role === 'investor' && h.active ? `<button class="ghost sm" data-action="viewas" data-id="${h.id}">View as</button>` : ''}</div>
        <div class="mini">
          <div><span>Put in</span>${putIn(h)}</div>
          ${h.role === 'investor' && h.net_profit_usdt != null
            ? `<div><span>Profit, theirs after fee</span><i class="${cls(h.net_profit_usdt)}" style="font-style:normal">${smoney(h.net_profit_usdt)}${h.net_return_pct != null ? ' (' + pct(h.net_return_pct, 1) + ')' : ''}</i></div>
          <div><span>Before fee</span><i class="${cls(h.gross_profit_usdt)}" style="font-style:normal">${smoney(h.gross_profit_usdt)}${h.gross_return_pct != null ? ' (' + pct(h.gross_return_pct, 1) + ')' : ''}</i></div>
          <div><span>Your fee (worth now)</span>${money(h.profit_share_usdt)}</div>
          <div><span>Balance after fee</span>${money(h.net_value_usdt)}</div>`
            : `<div><span>Profit</span><i class="${cls(h.profit_usdt)}" style="font-style:normal">${smoney(h.profit_usdt)}${h.return_pct != null ? ' (' + pct(h.return_pct, 1) + ')' : ''}</i></div>`}
          <div><span>Share</span>${h.share_pct == null ? '—' : f(h.share_pct * 100, 1) + '%'}</div>
          <div><span>Units</span>${f(h.units, 3)}</div>
          <div><span>Fee rate</span>${h.role === 'admin' ? '—' : rateText(h)}</div>
          <div><span>${h.role === 'admin' ? 'Fees earned' : 'Locked until'}</span>${h.role === 'admin' ? f(h.fee_units_earned, 3) : day(h.lock_until)}</div></div>
        ${termsLine(h)}<details style="margin-top:8px"><summary class="note" style="cursor:pointer">Edit / reset password</summary>
          ${h.role === 'investor' ? `<form class="profForm" data-id="${h.id}"><div class="grid form2"><div><label>Name</label><input name="name" value="${esc(h.name)}"></div>
            <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="${pc(h.fee_rate)}"></div></div>
            <p class="note" style="margin:6px 0 0">Lowering applies at once. Raising only starts after the next quarter close, so it never touches profit already made.${h.fee_rate_next != null ? ` Scheduled: ${pc(h.fee_rate_next)}%. Type the current % again to cancel it.` : ''}</p>
            <div class="btns"><button class="ghost">Save</button><button type="button" class="${h.active ? 'danger' : 'ghost'}" data-action="toggleactive" data-id="${h.id}" data-active="${h.active}">${h.active ? 'Deactivate' : 'Reactivate'}</button></div></form>` : ''}
          <form class="resetForm" data-id="${h.id}"><label>New password for ${esc(h.name || h.username)}</label>
            <input name="password" type="text" minlength="8" autocomplete="off" required>
            <div class="btns"><button class="ghost">Set password</button></div></form></details></div>`).join('')}</div>`;
  }
  const holderOpts = (sel) => S.all.filter((h) => h.active)
    .map((h) => `<option value="${h.id}" ${h.id === sel ? 'selected' : ''}>${esc(h.name || h.username)}${h.role === 'admin' ? ' (manager)' : ''}</option>`).join('');
  const atOf = (fm) => (fv(fm, 'at') ? new Date(fv(fm, 'at')).toISOString() : null);   // optional "when" for late entries
  // optional extras. The peso rate defaults to the live rate; the deposit form shows the rate up front instead
  const phpField = (withRate = true) => `<details><summary>More options: date${withRate ? ', peso rate' : ''}</summary><label>When (leave empty for now; only for recording something late)</label><input name="at" type="datetime-local">${withRate ? `<label>Peso rate (₱ per USDT, for the ₱ estimate only)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate() || ''}">` : ''}</details>`;

  // the pool_equity timeline is the single source of truth for "what happened and when"; every deposit/withdrawal
  // also has matching ledger row(s) carrying the person and amounts, joined here by equity_id.
  function recordHistoryRows() {
    if (!S.elog.length) return '<p class="note">Nothing recorded yet.</p>';
    return S.elog.slice(0, 60).map((e, i) => {
      const rows = S.ledger.filter((l) => l.equity_id === e.id);
      const who = [...new Set(rows.map((r) => r.name))].join(', ');
      const label = e.kind === 'update' ? 'Equity reading' : e.kind === 'close' ? 'Quarter close'
        : e.kind === 'deposit' ? `Deposit${who ? ' · ' + esc(who) : ''}` : `Withdrawal${who ? ' · ' + esc(who) : ''}`;
      const canFix = i === 0 && e.kind !== 'close';
      return `<div class="row" style="align-items:flex-start">
        <span class="l"><b style="color:var(--ink)">${label}</b>${e.reversed_of ? ' <span class="chip">correction</span>' : ''}<br>
          ${day(e.ts)}${e.note ? ' · ' + esc(e.note) : ''}</span>
        <span class="r">${money(e.equity_usdt)}<br><span class="note">${usdt(e.equity_usdt)} · price ${f(e.unit_price, 4)}</span>
          ${canFix ? `<div class="btns" style="margin-top:6px"><button type="button" class="ghost sm" data-action="editlast">Edit</button><button type="button" class="danger sm" data-action="undolast">Delete</button></div>` : ''}</span></div>`;
    }).join('');
  }
  // deposits received but not yet turned into units: they own nothing until the next equity reading (forward pricing)
  const pendTotal = () => S.pend.reduce((t, d) => t + Number(d.usdt), 0);
  const pendNote = () => (S.pend.length ? ` Includes <b>${usdt(pendTotal())}</b> of deposits still waiting; they are taken out first.` : '');
  function pendingCard() {
    if (!S.pend.length) return '';
    return `<div class="card"><h2>Waiting to join (${S.pend.length}) · ${money(pendTotal())}</h2>
      <p class="note">Received but not in the pool yet: no gains, no losses. They buy units at the next <b>Update equity</b> (or quarter close), at that day's price.</p>
      ${S.pend.map((d) => `<div class="row"><span class="l">${esc(d.name)} · ${day(d.received_at)}<br><span class="note">${d.php_amount ? php(d.php_amount) + ' = ' : ''}${usdt(d.usdt)}</span></span>
        <span class="r"><button class="ghost sm" data-action="cancelpend" data-id="${d.id}">Handed back</button></span></div>`).join('')}</div>`;
  }
  function viewRecord() {
    const noUnits = Number(S.pool.total_units) === 0, empty = noUnits && !S.pend.length;
    if (empty && S.rec === 'eq') S.rec = 'dep';   // nothing to value yet: start with the first deposit
    const pick = (k, html) => (S.rec === k ? html : '');
    return `<div class="ranges" style="margin:12px 0 0">${[['eq', 'Equity'], ['dep', 'Deposit'], ['wd', 'Withdrawal'], ['hist', 'History']].map(([k, l]) => `<button class="${S.rec === k ? 'on' : ''}" data-rec="${k}">${l}</button>`).join('')}</div>
      ${pick('hist', `<div class="card"><h2>History</h2>
        <p class="note">Only the most recent entry can be edited or deleted — once something new is recorded on top of it, it's locked in for good. "Delete" and "Edit" append a correction rather than erasing anything.</p>
        ${recordHistoryRows()}</div>`)}
      ${pick('eq', `<div class="card"><h2>Update pool equity</h2>
      <p class="note">Read the pool's total equity (USDT, including open trades) from MEXC. This moves the unit price for everyone; no one's units change. Deposits that are waiting buy their units now, at this price.${noUnits && !empty ? ' First reading: units start at 1.00.' : ''}</p>
      <form id="eqForm"><label>Pool equity now (USDT, the MEXC total)</label><input name="equity" type="number" step="any" inputmode="decimal" required ${empty ? 'disabled placeholder="Record the first deposit first"' : ''}>
        ${phpField()}<label>Note (optional)</label><input name="note"><div class="preview" id="eqPrev">—</div><button class="full" ${empty ? 'disabled' : ''}>Save equity</button></form></div>${pendingCard()}`)}
      ${pick('dep', `<div class="card"><h2>Money received</h2>
        <p class="note">Type what they handed over in pesos. It <b>waits</b> and owns nothing until your next <b>Update equity</b>; then it buys units at that day's price. So a newcomer never shares in profit made before their money was in, and never pays for losses from before either.${noUnits ? ' The very first money starts at 1.00 per unit.' : ''}</p>
        <form id="depForm"><label>Person</label><select name="who">${holderOpts(S.recWho)}</select>
        <div class="grid form2"><div><label>Amount</label><input name="amt" type="number" step="any" inputmode="decimal" placeholder="5000" required></div>
          <div><label>In</label><select name="ccy"><option value="PHP">₱ Pesos</option><option value="USDT">USDT</option></select></div></div>
        <label>Rate (₱ per USDT)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate() ? Number(rate()).toFixed(2) : ''}">
        <p class="note" style="margin:6px 0 0">${rateNote()}. Change it if the real rate you converted at was different.</p>
        ${phpField(false)}<label>Note (optional)</label><input name="note"><div class="preview" id="depPrev">—</div><button class="full">Record money received</button></form></div>${pendingCard()}`)}
      ${pick('wd', `<div class="card"><h2>Record a withdrawal</h2>
        <p class="note">Enter the pool equity from MEXC just before you pay out.${pendNote()} Any fee due (on gains above their best) is settled in units first.</p>
        <form id="wdForm"><label>Person</label><select name="who">${holderOpts(S.recWho)}</select>
        <label>Units to redeem</label><input name="units" type="number" step="any" inputmode="decimal" required>
        <div class="btns"><button type="button" class="ghost" data-action="allunits">All their units</button></div>
        <label>Pool equity before this payout (USDT, the MEXC total)</label><input name="eq" type="number" step="any" inputmode="decimal" required>
        ${phpField()}<label>Note (optional)</label><input name="note"><input type="hidden" name="reqid">
        <label style="display:flex;gap:8px;align-items:center"><input name="force" type="checkbox" style="width:auto;min-height:0"> Override lock-up</label>
        <div class="preview" id="wdPrev">—</div><button class="full">Record withdrawal</button></form></div>`)}`;
  }
  function viewQuarter() {
    return `<div class="card"><h2>Close the quarter</h2>
      <p class="note">Takes each investor's fee (their own %, 10% by default) from the <b>new profit since the last close</b> only. Example: they gain $100 this quarter and the 10% fee = $10. Next quarter the starting line is the price today, so that $100 is never charged again; only profit above it is. If the fund falls, nothing is charged, and it must climb back above the old line before anything is charged again.</p>
      <p class="note">The share moves as <b>units</b> from them to you, still inside the pool. Each deposit is measured against its own line, so top-ups and old losses never shift what another deposit owes. Allowed once per quarter (at least 80 days apart).</p>
      ${lastClose()}
      ${S.pend.length ? `<p class="note">${S.pend.length} deposit${S.pend.length === 1 ? '' : 's'} (${usdt(pendTotal())}) still waiting: taken out before the fee is worked out, then they buy units at the close price, so they pay nothing for this quarter.</p>` : ''}
      <form id="qForm"><label>Pool equity now (USDT, the MEXC total)</label><input name="equity" type="number" step="any" inputmode="decimal" required>
      ${phpField()}<label>Note (optional)</label><input name="note" value="Quarter close"><div class="preview" id="qPrev">Enter the equity to preview the fee.</div>
      <button class="full">Charge fees and close quarter</button></form></div>`;
  }
  function lastClose() {
    const c = S.elog.find((e) => e.kind === 'close');
    if (!c) return '<p class="note"><b>No quarter closed yet.</b></p>';
    const days = Math.floor((Date.now() - new Date(c.ts).getTime()) / 864e5);
    return `<p class="note ${days > 92 ? 'warn' : ''}"><b>Last close: ${day(c.ts)}</b> (${days} days ago)${days > 92 ? ': a quarter is due' : ''}</p>`;
  }
  function viewLog() {
    const pend = S.reqs.filter((q) => q.status === 'pending');
    return `<div class="card"><h2>Withdrawal requests</h2>${pend.length ? pend.map((q) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(q.name)}</b><br>${money(q.units * S.pool.unit_price)} (${f(q.units, 4)} units) · asked ${day(q.requested_at)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span>
      <span class="r"><button data-action="payreq" data-id="${q.id}" data-who="${q.profile_id}" data-units="${q.units}">Prepare payout</button></span></div>`).join('') : '<p class="note">None pending.</p>'}</div>
      <div class="card"><h2>All entries</h2>${activityRows(S.ledger, true)}</div>
      <div class="card"><h2>Equity readings</h2>${S.elog.length ? S.elog.slice(0, 60).map((e) => `<div class="row"><span class="l">${day(e.ts)} · ${esc(e.kind)}${e.note ? `<br><span class="note">${esc(e.note)}</span>` : ''}</span>
        <span class="r">${money(e.equity_usdt)}<br><span class="note">${usdt(e.equity_usdt)} · price ${f(e.unit_price, 4)}</span></span></div>`).join('') : '<p class="note">None yet.</p>'}</div>${auditCard()}${backupCard()}`;
  }

  function viewReports() {
    const rows = S.reports || [];
    return `<div class="sechead"><h2>Reports (${rows.length})</h2><a class="btn ghost sm" href="reports/" target="_blank" rel="noopener">Open library ↗</a></div>
      ${rows.length ? '' : '<div class="card"><p class="note">None yet. Drop a compiled HTML report in the <code>reports/</code> folder of this site and add it to <code>reports/index.json</code> — no app update needed.</p></div>'}
      ${rows.map((r) => `<div class="card">
        <div class="nm" style="font-weight:800;font-size:16px">${esc(r.title)}</div>
        <p class="note" style="margin:4px 0 10px">${esc(r.summary || '')}</p>
        <div class="mini" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          <div><span>Updated</span>${esc(r.updated || '—')}</div>
          <div><span>Type</span>${esc(r.kind || 'Report')}</div></div>
        <div class="btns" style="margin-top:12px">
          <a class="btn full" href="${esc(r.file)}" target="_blank" rel="noopener">Open report ↗</a>
          ${r.pdf ? `<a class="btn ghost sm" href="${esc(r.pdf)}" target="_blank" rel="noopener">PDF</a>` : ''}</div></div>`).join('')}
      <p class="note" style="margin:4px 2px 0">These pages are plain links, outside the sign-in area, so the address can be handed straight to someone outside Lucidyo — the "Open library" button above is the public, shareable page.</p>`;
  }
  // ---------------------------------------------------------------- shell
  const TABS = {
    investor: [['home', 'Home'], ['statements', 'Statements'], ['activity', 'Activity'], ['about', 'About']],
    admin: [['dashboard', 'Dashboard'], ['users', 'Users'], ['record', 'Record'], ['quarter', 'Quarter'], ['reports', 'Reports'], ['log', 'Log']],   // side "Fund": the pool, everyone, reports
    adminMe: [['mine', 'My account'], ['statements', 'Statements'], ['myhistory', 'History']],                                                                              // side "My account": only the manager's own money
  };
  const VIEWS = { home: viewHome, activity: viewActivity, about: viewAbout, dashboard: viewDashboard, users: viewUsers, record: viewRecord, quarter: viewQuarter, log: viewLog, reports: viewReports, mine: viewMine, myhistory: viewMyHistory, statements: viewStatements };
  const TABICON = { users: 'people', dashboard: 'dash', myhistory: 'activity', statements: 'reports' };
  const tabsFor = () => (isAdmin() ? TABS[S.side === 'me' ? 'adminMe' : 'admin'] : TABS.investor);

  // ---------------------------------------------------------------- gates after sign-in: terms -> quote screen -> tour
  // An investor must agree to the terms (saved in the database, per version) before seeing anything. Then a quote screen, then the animated
  // tour (once per device; "Welcome tour" at the bottom replays it). None of this shows while the manager is "viewing as" someone.
  const welcomeKey = (id) => 'ledger.welcomed.' + id;
  const welcomed = (id) => { try { return localStorage.getItem(welcomeKey(id)) === '1'; } catch { return false; } };
  const needsTerms = () => !!S.me && S.me.role === 'investor' && !S.me.impersonated && S.me.terms_version !== TERMS_VERSION;
  const afterTerms = () => ((welcomed(S.me.id) || S.welcomeDone) ? null : 'splash');
  const startTour = () => { clearTimeout(S.splashT); S.splashT = null; S.gate = 'tour'; S.welcome = 0; render(); window.scrollTo(0, 0); };

  const TERMS_CHECKS = [
    'I understand I can lose a large part or all of the money I put in.',
    'I understand nothing is guaranteed or insured, and that past or backtested results are not a promise.',
    'I am only using money I can afford to lose.',
    'I have read the lock-up, withdrawal, new-money and fee rules above, and I accept them.',
  ];
  function termsSections() {
    const rate = pc(S.me.fee_rate);
    return [
      ['You can lose money, and it could be a lot', `Lucidyo trades in cryptocurrency markets, which can move very fast and very far, sometimes within minutes. The account may use leverage (trading with more than the money in it), which can make losses bigger as well as gains. The pool can fall sharply, <b>you can lose a large part or all of the money you put in</b>, and there will be weeks and months when your balance is down. Only use money you can afford to lose: never money for rent, food, school, bills or emergencies, and never borrowed money.`],
      ['Nothing is guaranteed', `Nobody has promised you any return, and nobody can. Past results and backtests are simulations made with hindsight. They are not a promise, and a good stretch says nothing certain about the next one.`],
      ['Not a bank, not insured', `This app is a record, kept by the manager, of your share of a pooled trading account. It is not a bank account or a deposit, and it is not insured or guaranteed by any bank or government body. If the exchange, the account or the manager has a problem (a hack, an outage, a mistake, a freeze), <b>you may not get your money back</b>.`],
      ['Lock-up and withdrawals', `Each deposit is locked for <b>${C.LOCK_MONTHS} months</b> from the day it joins the pool. After that you can ask to withdraw some or all of it. It is paid within <b>${C.WITHDRAW_BUSINESS_DAYS} business days</b> (Monday to Friday, not counting weekends), at the value on the day it is paid, which can be lower than on the day you asked.`],
      ['How new money joins', `Money you hand over first waits. It joins the pool at the next valuation (when the manager updates the pool’s total value) and buys units at that day’s price. So the price you get can be higher or lower than on the day you handed the money over. This protects everyone: nobody shares in profit made before their money was in.`],
      ['The fee', `The fee is <b>${rate}%</b> of <b>new profit</b> above your best-ever level, settled once a quarter inside the pool (no cash moves). Nothing is charged on the money you put in, and nothing while your balance is below its best level. The rate can be lowered at any time; a higher rate only starts after the next quarter close, and your Home page tells you before it does.`],
      ['What the numbers mean', `Your balance is an estimate. It follows the pool’s value as entered by the manager from the exchange account (daily or weekly, not live), and it is shown in pesos at an exchange rate that moves on its own, so your peso balance can change even when the trading did not.`],
      ['Your login and this agreement', `Keep your password private: anything done with your login counts as done by you. We save the date you agreed to these terms. If the terms change, you will be asked to read and agree again.`],
    ];
  }
  function termsView() {
    const ro = S.termsRO;
    app.innerHTML = `<header><span class="hello">Lucidyo · before you start</span><div class="hdr-actions">${themeBtn()}</div></header>
      <div class="login-brand welcome"><span class="logo">${ICON.alert}</span><h1>Please read this first</h1>
        <p class="note">${ro ? `You agreed on ${day(S.me.terms_accepted_at)}.` : 'Your money is at risk. Read each point, tick the boxes, and only then continue.'}</p></div>
      <div class="card terms">${termsSections().map(([t, b], i) => `<div class="tsec" style="--i:${i}"><h3>${i + 1}. ${t}</h3><p class="about">${b}</p></div>`).join('')}</div>
      ${ro ? '<div class="btns"><button data-action="termsback">Back</button></div>' : `<div class="card"><h2>I confirm that</h2>
        ${TERMS_CHECKS.map((t) => `<label class="tck-row"><input type="checkbox" class="tck"><span>${t}</span></label>`).join('')}
        <div class="btns"><button class="ghost" data-action="declineterms">I don’t agree, sign out</button><button id="acceptBtn" data-action="acceptterms" disabled>I agree, continue</button></div>
        <p class="note">Your agreement is saved with today’s date. Nothing is shown until you agree.</p></div>`}`;
  }
  document.addEventListener('change', (ev) => {   // "I agree" stays off until every box is ticked
    if (!ev.target.classList || !ev.target.classList.contains('tck')) return;
    const btn = document.getElementById('acceptBtn');
    if (btn) btn.disabled = ![...document.querySelectorAll('.tck')].every((c) => c.checked);
  });
  const termsLine = (h) => (h.role !== 'investor' ? '' : `<p class="note" style="margin:8px 0 0">Terms: ${h.terms_version === TERMS_VERSION ? 'agreed ' + day(h.terms_accepted_at)
    : h.terms_version ? `<span class="warn">agreed an older version (${day(h.terms_accepted_at)}); they are asked again at the next sign-in</span>`
    : '<span class="warn">not agreed yet: they see the terms at their next sign-in</span>'}</p>`);
  const termsWarn = (id) => { const h = S.all.find((x) => x.id === id); return h && h.role === 'investor' && h.terms_version !== TERMS_VERSION
    ? `<br><span class="warn">${esc(h.name || h.username)} has not agreed to the terms yet. Ask them to sign in and agree before you take their money.</span>` : ''; };
  const termsCard = () => (S.me.role === 'investor' && !S.me.impersonated && S.me.terms_accepted_at ? `<div class="card"><h2>Your agreement</h2>
    <p class="about">You read and agreed to the terms on <b>${day(S.me.terms_accepted_at)}</b>.</p>
    <div class="btns"><button class="ghost" data-action="readterms">Read the terms again</button><button class="ghost" data-action="welcome">Replay the tour</button></div></div>` : '');

  // quote screen (shown after the terms, while the tour is "loading")
  const QUOTE = 'Compound interest is the eighth wonder of the world. He who understands it, earns it; he who doesn’t, pays it.';
  function splashView() {
    if (!S.splashT) S.splashT = setTimeout(() => { S.splashT = null; if (S.gate === 'splash') startTour(); }, SPLASH_MS);
    app.innerHTML = `<div class="splash"><div class="login-brand" style="padding:0"><span class="logo">${ICON.logo}</span></div>
      <blockquote class="quote"><span class="qm" style="--i:0">“</span>${QUOTE.split(' ').map((w, k) => `<span style="--i:${k}">${w}</span>`).join(' ')}<span class="qm" style="--i:20">”</span></blockquote>
      <p class="by">Attributed to Albert Einstein</p>
      <p class="both">It works in both directions: gains build on gains, and losses build on losses.</p>
      <div class="loadbar"><i style="animation-duration:${SPLASH_MS}ms"></i></div><p class="note">Getting your account ready…</p>
      <button class="ghost sm" data-action="splashskip">Skip</button></div>`;
  }

  // plain-words glossary (tour + About page)
  const GLOSSARY = [
    ['USDT', 'A digital coin built to stay worth about 1 US dollar. The pool is counted in USDT; the app shows it in pesos at the day’s exchange rate.'],
    ['Equity', 'The total value of the whole pool right now, including trades that are still open.'],
    ['Unit', 'A slice of the pool. You own a number of units. It only changes when you add money, take money out, or pay a fee.'],
    ['Unit price', 'What one unit is worth today. It rises when the pool gains and falls when it loses, by the same % for everyone.'],
    ['Valuation', 'When the manager updates the pool’s total value. New money joins at the price set at a valuation.'],
    ['Compounding', 'Profit staying in the pool and earning on itself. Losses compound too: they shrink what future gains build on.'],
    ['Drawdown', 'How far the balance has fallen from its highest point. A 50% fall needs a 100% gain to get back.'],
    ['Best-ever level', 'Also called the high-water mark. The highest price your deposit has already been charged a fee at. The fee applies only to profit above it.'],
    ['Lock-up', 'The time after each deposit when it cannot be withdrawn.'],
    ['Leverage', 'Trading with more exposure than the money in the account. It can magnify gains and losses.'],
  ];
  const glossHtml = () => `<dl class="gloss">${GLOSSARY.map(([t, d], i) => `<div style="--i:${i}"><dt>${t}</dt><dd>${d}</dd></div>`).join('')}</dl>`;
  const glossCard = () => `<div class="card"><h2>Words you’ll see</h2>${glossHtml()}</div>`;

  // animated scenes for the tour (CSS only; the resting state is the finished picture, so reduced-motion still reads fine)
  const LINE = 'M0 110 L40 92 L80 70 L120 44 L165 96 L205 78 L250 46 L300 22';
  const SCENE = {
    pool: () => `<div class="scene"><div class="jar" aria-hidden="true">${[[8, 4, '--accent'], [34, 4, '--seg2'], [60, 4, '--accent'], [86, 4, '--seg2'], [21, 28, '--seg2'], [47, 28, '--accent'], [73, 28, '--accent']]
        .map(([l, b, c], k) => `<i style="--l:${l}px;--b:${b}px;--i:${k};--c:var(${c})"></i>`).join('')}</div>
      <div class="legend" style="justify-content:center"><span><b style="background:var(--accent)"></b>You</span><span><b style="background:var(--seg2)"></b>Everyone else</span></div>
      <div class="calc" role="img" aria-label="Example: 100 units times 1.20 equals 120 USDT"><span style="--i:0"><b>100</b><small>your units</small></span><em style="--i:1">×</em>
        <span style="--i:2"><b>1.20</b><small>unit price</small></span><em style="--i:3">=</em><span style="--i:4"><b>120</b><small>USDT: your balance</small></span></div>
      <p class="note" style="text-align:center;margin:8px 0 0">Example numbers</p></div>`,
    ups: () => `<div class="scene"><svg viewBox="0 0 300 130" class="mini" role="img" aria-label="A balance that rises, dips, then recovers to a new high">
        <line class="dash" x1="0" y1="44" x2="300" y2="44"/><path class="area" d="${LINE} L300 130 L0 130Z"/>
        <path class="ln" pathLength="1" d="${LINE}"/>
        <text class="lab" x="4" y="38" style="--d:1.0s">previous high</text><text class="lab dn" x="140" y="118" style="--d:1.5s">dip (drawdown)</text><text class="lab hot" x="214" y="16" style="--d:2.1s">new high</text></svg></div>`,
    join: () => `<div class="scene"><div class="flow">
        <div class="chip" style="--i:0"><span>Money received</span><small>waits, owns nothing yet</small></div><em>→</em>
        <div class="chip" style="--i:1"><span>Next valuation</span><small>the price is set</small></div><em>→</em>
        <div class="chip" style="--i:2"><span>You join</span><small>units bought at that price</small></div></div></div>`,
    lock: () => `<div class="scene"><div class="lockrow"><span class="lk" aria-hidden="true">${ICON.lock}</span><div class="grow">
        <div class="split lockbar"><i></i></div><div class="lkcap"><span>Deposit joins</span><span>${C.LOCK_MONTHS} months</span><span>Can withdraw</span></div></div></div>
      <div class="flow"><div class="chip" style="--i:0"><span>You request</span></div><em>→</em><div class="chip" style="--i:1"><span>Up to ${C.WITHDRAW_BUSINESS_DAYS} business days</span></div><em>→</em><div class="chip" style="--i:2"><span>Paid</span></div></div></div>`,
    share: (keep) => `<div class="scene"><svg viewBox="0 0 300 130" class="mini" role="img" aria-label="Only the part of the line above the best-ever level is shared">
        <clipPath id="above"><rect x="0" y="0" width="300" height="80"/></clipPath>
        <line class="dash" x1="0" y1="80" x2="300" y2="80"/><text class="lab" x="4" y="95" style="--d:.8s">your best-ever level</text>
        <path class="ln faint" pathLength="1" d="M0 116 L40 100 L80 108 L120 70 L160 50 L200 78 L240 40 L300 30"/>
        <path class="ln hot" pathLength="1" clip-path="url(#above)" d="M0 116 L40 100 L80 108 L120 70 L160 50 L200 78 L240 40 L300 30"/>
        <text class="lab hot" x="4" y="14" style="--d:1.6s">Fee applies only above the line</text></svg>
      <div class="split" style="margin-top:12px"><i class="grow-x" style="width:${keep}%;background:var(--up)"></i><i class="grow-x" style="width:${100 - keep}%;background:var(--seg3)"></i></div>
      <div class="legend"><span><b style="background:var(--up)"></b>You keep ${pc(keep / 100)}% of new profit</span><span><b style="background:var(--seg3)"></b>Manager ${pc(1 - keep / 100)}%</span></div></div>`,
    tabs: () => `<div class="scene"><div class="mininav" aria-hidden="true">${[['home', 'Home'], ['activity', 'Activity'], ['about', 'About']].map(([k, l], i) => `<span style="--i:${i}">${ICON[k]}<b>${l}</b></span>`).join('')}</div>
      <div class="tabrows">${[['Home', 'your balance, a growth chart, your fee and your withdrawals.'], ['Activity', 'every deposit, withdrawal and fee, in order.'], ['About', 'how it all works, in plain words, and your agreement.']]
        .map(([t, d], i) => `<p style="--i:${i}"><b>${t}</b> · ${d}</p>`).join('')}</div></div>`,
  };
  function tourSteps() {
    const m = S.me, first = esc(String(m.name || m.username).split(' ')[0]);
    if (isAdmin()) return [
      [ICON.logo, `Welcome to Lucidyo, ${first}`, `<p class="about"><b>Clear rules. Real growth.</b></p>
        <p class="about">This is the manager side of Lucidyo Ledger, the paper record of who owns what in the pool. No money moves through this app: the real money stays in the exchange account. Investors only ever see their own balance; you see everyone.</p>
        <p class="about">Use the <b>Fund / My account</b> switch at the top: <b>Fund</b> is the pool and everyone’s records, <b>My account</b> is your own capital, the fee you have earned and your own growth.</p>`],
      [ICON.record, 'Your routine', `<p class="about"><b>Record → Update equity</b> daily or weekly: type the pool’s total from the exchange, open trades included.</p>
        <p class="about"><b>Money received:</b> a deposit waits until your next Update equity, then buys units at that day’s price, so newcomers never share profit made before they joined. Withdrawals: type the total just before you pay out.</p>
        <p class="about"><b>Quarter:</b> at least 80 days apart. Check the preview, then charge the fee. A raised % starts after the next close.</p>`],
      [ICON.people, 'Handy tools', `<p class="about"><b>Users → + Add user</b> creates a login. Send them the username and password; they must agree to the terms before they see anything, and you can see who has.</p>
        <p class="about"><b>View as</b> opens the app exactly as that person sees it (read-only).</p>
        <p class="about"><b>Log</b> keeps every entry. Nothing is erased: a mistake is fixed with a correction entry.</p>`],
    ];
    const keep = Math.round((1 - Number(m.fee_rate)) * 10000) / 100;
    return [
      [ICON.logo, `Welcome to Lucidyo, ${first}`, `<p class="about"><b>Clear rules. Real growth.</b></p>
        <p class="about">Here is a one-minute tour of what you will see, in plain words. Tap <b>Skip</b> any time; you can replay it from <b>Welcome tour</b> at the bottom of any page.</p>`],
      [ICON.pool, 'Your share of the pool', `<p class="about">Everyone’s money goes into <b>one pool</b>: a single trading account, together with the manager’s own money. When you put money in you get <b>units</b>, slices of the pool.</p>
        <p class="about"><b>Unit price</b> is what one slice is worth today. Your balance is simply your units × the unit price.</p>`, SCENE.pool()],
      [ICON.arrowOut, 'Ups and downs', `<p class="about">Trading results move the unit price: gains lift every unit, losses lower every unit, by the same % for everyone.</p>
        <p class="about">Profit stays in the pool and keeps working. That is <b>compounding</b>, and it works both ways: a loss shrinks what future gains build on. A fall from the highest point is a <b>drawdown</b>. It will happen, and climbing back takes longer than falling (a 50% fall needs a 100% gain to recover).</p>`, SCENE.ups()],
      [ICON.record, 'New money joins fairly', `<p class="about">Money you hand over does not join instantly. It waits for the next <b>valuation</b> (when the manager updates the pool’s total value) and buys units at that day’s price.</p>
        <p class="about">So nobody shares in profit made before their money was in, you included. While it waits, you will see it on Home under <b>Waiting to join</b>.</p>`, SCENE.join()],
      [ICON.lock, 'Lock-up and withdrawals', `<p class="about">Each deposit is <b>locked</b> for <b>${C.LOCK_MONTHS} months</b> from the day it joins. After that, tap <b>Request withdrawal</b> on Home. It is paid within <b>${C.WITHDRAW_BUSINESS_DAYS} business days</b>, at the value on the day it is paid.</p>`, SCENE.lock()],
      [ICON.fee, 'The fee', `<p class="about">The fee applies only when you earn: <b>${pc(m.fee_rate)}%</b> of <b>new profit</b>, above your <b>best-ever level</b>. Nothing on the money you put in, and nothing while you are below your best level.</p>
        <p class="about">It is settled once a quarter inside the pool, so no cash moves. Each deposit keeps its own best-ever level.</p>`, SCENE.share(keep)],
      [ICON.home, 'Your screens', `<p class="about">The <b>₱ / $</b> button switches between pesos and USDT. The <b>moon</b> button changes light and dark. Everything is read-only: you can look, and request a withdrawal.</p>`, SCENE.tabs()],
      [ICON.about, 'Words you’ll see', glossHtml()],
    ];
  }
  function tourView() {
    const steps = tourSteps(), i = Math.max(0, Math.min(S.welcome, steps.length - 1)), [icon, title, body, scene] = steps[i], last = i === steps.length - 1;
    app.innerHTML = `<header><span class="hello">Lucidyo · ${i + 1} of ${steps.length}</span>
      <div class="hdr-actions">${themeBtn()}${last ? '' : '<button class="ghost sm" data-action="welcomedone">Skip</button>'}</div></header>
      <div class="login-brand welcome"><span class="logo">${icon}</span><h1>${title}</h1></div>
      <div class="card enter">${scene || ''}${body}
        <div class="steps" aria-hidden="true">${steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="btns">${i ? '<button class="ghost" data-action="welcomeback">Back</button>' : ''}
          <button data-action="${last ? 'welcomedone' : 'welcomenext'}">${last ? (isAdmin() ? 'Open the dashboard' : 'Take me to my account') : 'Next'}</button></div></div>`;
  }
  const gateView = () => (S.gate === 'terms' ? termsView() : S.gate === 'splash' ? splashView() : tourView());

  function loginView() {
    app.innerHTML = `<header><span></span><div class="hdr-actions">${themeBtn()}</div></header>
      <div class="login-brand"><span class="logo">${ICON.logo}</span><h1>Lucidyo</h1><p class="note">Ledger · your share of the pool, at a glance.</p></div>
      <div class="card"><h2>Sign in</h2>
      <form id="loginForm"><label>Username</label><input name="username" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" required>
      <label>Password</label>${pw('password', 'current-password')}
      <div id="loginErr" class="alert" role="alert" hidden></div>
      <button class="full">Sign in</button></form>
      <p class="note" style="margin-bottom:0">No account? Ask the manager to create one for you.</p></div>${DISC}`;
  }
  // password field with a show/hide (eye) button
  const pw = (name, ac, min) => `<div class="pw"><input name="${name}" type="password" autocomplete="${ac}" ${min ? `minlength="${min}"` : ''} required>
    <button type="button" class="eye" data-action="eye" aria-label="Show password" aria-pressed="false">${ICON.eye}</button></div>`;
  function loginError(msg, fm) {
    const box = $f('loginErr'); if (!box) return;
    for (const el of fm.querySelectorAll('input')) el.removeAttribute('aria-invalid');
    if (!msg) { box.hidden = true; return; }
    const wrong = /Wrong username or password/.test(msg);
    box.innerHTML = `${ICON.alert}<div><b>${esc(wrong ? 'Incorrect username or password' : msg)}</b>${wrong
      ? '<br><span>Usernames are not case-sensitive; passwords are. 5 wrong tries lock the account for 15 minutes.</span>' : ''}</div>`;
    box.hidden = false; box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
    if (wrong) { fm.elements.password.setAttribute('aria-invalid', 'true'); fm.elements.password.select(); }
  }
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  function render() {
    if (!S.me) return loginView();
    const viewing = S.me.impersonated;
    if (!viewing && S.gate == null) { if (needsTerms()) S.gate = 'terms'; else if (!S.welcomeDone && !welcomed(S.me.id)) S.gate = 'splash'; }
    if (!viewing && S.gate) return gateView();
    const tabs = tabsFor();
    if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    app.innerHTML = `${viewing ? `<div class="viewas"><span>Viewing as <b>${esc(S.me.name || S.me.username)}</b>, exactly what they see (read-only)</span>
        <button data-action="exitview">Back to manager</button></div>` : ''}
      <header><div><div class="hello">${greeting()}${isAdmin() ? (S.side === 'me' ? ' · my account' : ' · manager') : ''}</div><h1>${esc(S.me.name || S.me.username)}</h1></div>
      <div class="hdr-actions">${curBtn()}${themeBtn()}<button class="iconbtn" data-action="refresh" aria-label="Refresh">${ICON.refresh}</button></div></header>
      ${isAdmin() && !viewing ? `<div class="ranges sidesw" role="tablist" aria-label="Side">${[['fund', 'Fund'], ['me', 'My account']].map(([k, l]) => `<button role="tab" aria-selected="${(S.side === 'me') === (k === 'me')}" class="${(S.side === 'me') === (k === 'me') ? 'on' : ''}" data-side="${k}">${l}</button>`).join('')}</div>` : ''}
      ${VIEWS[S.tab]()}
      ${viewing ? '' : '<div class="btns" style="justify-content:center;margin:4px 0 8px"><button class="ghost sm" style="flex:none" data-action="welcome">Welcome tour</button><button class="ghost sm" style="flex:none" data-action="signout">Sign out</button></div>'}
      <nav class="tabs" aria-label="Sections"><div class="bar">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === S.tab ? 'on' : ''}" aria-current="${k === S.tab ? 'page' : 'false'}">${ICON[k === 'home' && isAdmin() ? 'mine' : TABICON[k] || k]}<span>${l}</span></button>`).join('')}</div></nav>`;
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
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units), wait = pendTotal();
    if (eq == null || (!u && !wait)) return setPrev('eqPrev', '—');
    if (!u) return setPrev('eqPrev', `Waiting deposits buy <b>${f(wait, 4)} units</b> at 1.00.${Math.abs(eq - wait) > 1e-6 ? ` Then the price moves to <b>${f(eq / wait, 4)}</b>.` : ''}`);
    if (eq - wait <= 0) return setPrev('eqPrev', `<span class="down">Must be more than the ${usdt(wait)} still waiting: enter the full MEXC total.</span>`);
    const price = (eq - wait) / u, ch = price / Number(S.pool.unit_price) - 1;
    setPrev('eqPrev', `Unit price becomes <b>${f(price, 4)}</b> (<span class="${cls(ch)}">${pct(ch)}</span> vs last reading). Since start ${pct(price - 1)}.<br>Pool is ${money(eq)} ${alt(eq)}.${wait ? `<br>${usdt(wait)} waiting is taken out first, then buys <b>${f(wait / price, 4)} units</b> at ${f(price, 4)}.` : ''}`);
  }
  // what a deposit form means in USDT: pesos / rate, or the USDT typed directly
  function depUsdt(fm) {
    const amt = num(fv(fm, 'amt')), r = num(fv(fm, 'rate'));
    if (amt == null) return null;
    if (fv(fm, 'ccy') === 'USDT') return { usdt: amt, php: null, rate: r };
    return r > 0 ? { usdt: Math.round((amt / r) * 1e4) / 1e4, php: amt, rate: r } : { usdt: null };
  }
  function depPrev(fm) {
    const d = depUsdt(fm);
    if (!d) return setPrev('depPrev', '—');
    if (d.usdt == null) return setPrev('depPrev', 'Enter the peso rate to convert.');
    setPrev('depPrev', `${d.php != null ? `${php(d.php)} = ` : ''}<b>${usdt(d.usdt)}</b>${d.php == null && d.rate ? ` (${php(d.usdt * d.rate)})` : ''}. Waits until your next equity reading, then buys units at that price. Lock-up ${C.LOCK_MONTHS} months from then.${termsWarn(fv(fm, 'who'))}`);
  }
  // after an "Edit" undoes the last entry, refill the matching form with its old values so the manager just fixes the typo and re-saves
  function prefillEdit(e, rows) {
    if (e.kind === 'update') {
      const fm = $f('eqForm'); if (!fm) return;
      fm.elements.equity.value = e.equity_usdt; if (e.php_rate) fm.elements.rate.value = e.php_rate; fm.elements.note.value = e.note || ''; eqPrev(fm);
    } else if (e.kind === 'deposit') {
      const dep = rows.find((r) => r.kind === 'deposit'); const fm = $f('depForm'); if (!fm || !dep) return;
      fm.elements.who.value = dep.profile_id; fm.elements.ccy.value = dep.php_amount ? 'PHP' : 'USDT';
      fm.elements.amt.value = dep.php_amount || dep.usdt; if (dep.php_rate) fm.elements.rate.value = dep.php_rate;
      if (fm.elements.eq) fm.elements.eq.value = Number(e.equity_usdt) - Number(dep.usdt);
      fm.elements.note.value = dep.note || ''; depPrev(fm);
    } else if (e.kind === 'withdrawal') {
      const wd = rows.find((r) => r.kind === 'withdrawal'); const fm = $f('wdForm'); if (!fm || !wd) return;
      fm.elements.who.value = wd.profile_id; fm.elements.units.value = Math.abs(wd.units);
      fm.elements.eq.value = Number(e.equity_usdt) + Math.abs(Number(wd.usdt)); if (wd.php_rate) fm.elements.rate.value = wd.php_rate;
      fm.elements.note.value = wd.note || ''; wdPrev(fm);
    }
    toast('Entry undone — adjust the values and save again.');
  }
  const holder = (id) => S.all.find((h) => h.id === id);
  function wdPrev(fm) {
    const h = holder(fv(fm, 'who')), units = num(fv(fm, 'units')), eq = num(fv(fm, 'eq')), u = Number(S.pool.total_units);
    if (!h || units == null || eq == null || !u) return setPrev('wdPrev', '—');
    if (eq - pendTotal() <= 0) return setPrev('wdPrev', `<span class="down">Must be more than the ${usdt(pendTotal())} still waiting.</span>`);
    const price = (eq - pendTotal()) / u, fee = lotFee(h, Math.min(units, Number(h.units)), price);
    const net = units - fee, pay = net * price;
    const warn = units > Number(h.units) + 1e-8 ? '<br><span class="down">More than they hold.</span>'
      : h.role === 'investor' && units > Number(h.unlocked_units) + 1e-8 && !fm.elements.force.checked ? '<br><span class="warn">Inside lock-up. Tick override to allow.</span>' : '';
    setPrev('wdPrev', `Price ${f(price, 4)}. Fee <b>${f(fee, 4)} units</b>. Pay out <b>${usdt(pay)}</b> ${peso(pay, num(fv(fm, 'rate')) || rate())} for ${f(net, 4)} units.${warn}`);
  }
  function qPrev(fm) {
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units);
    if (eq == null || !u) return setPrev('qPrev', 'Enter the equity to preview the fee.');
    if (eq - pendTotal() <= 0) return setPrev('qPrev', `<span class="down">Must be more than the ${usdt(pendTotal())} still waiting.</span>`);
    const price = (eq - pendTotal()) / u; let tot = 0;
    const rows = S.all.filter((h) => h.role === 'investor' && Number(h.units) > 0).map((h) => {
      const gain = lotGain(h, price), fee = Number(h.fee_rate) * gain / price; tot += fee;
      return `<div class="row"><span class="l">${esc(h.name || h.username)}<br><span class="note">new profit ${money(gain)} × ${pc(h.fee_rate)}%${h.fee_rate_next != null ? ` (then ${pc(h.fee_rate_next)}%)` : ''}</span></span><span class="r">${money(fee * price)}<br><span class="note">${f(fee, 4)} units</span></span></div>`;
    }).join('');
    setPrev('qPrev', `Price ${f(price, 4)}.${rows || '<br>No investors hold units.'}<div class="row"><span class="l"><b>Total fee</b></span><span class="r"><b>${money(tot * price)}</b><br><span class="note">${f(tot, 4)} units</span></span></div>`);
  }

  // ---------------------------------------------------------------- actions
  async function act(fn, okMsg) {
    try { await fn(); await refresh(okMsg); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); }
  }
  document.addEventListener('click', async (ev) => {
    const side = ev.target.closest('[data-side]');
    if (side) { S.side = side.dataset.side === 'me' ? 'me' : 'fund'; S.tab = null; render(); window.scrollTo(0, 0); return; }
    const tab = ev.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; if (tab.dataset.rec) S.rec = tab.dataset.rec; S.recWho = tab.dataset.who === 'me' ? S.me.id : tab.dataset.who || null; if (tab.dataset.goside) S.side = tab.dataset.goside; render(); window.scrollTo(0, 0); return; }
    const rc = ev.target.closest('[data-rec]');
    if (rc) { S.rec = rc.dataset.rec; render(); return; }
    const rg = ev.target.closest('[data-range]');
    if (rg) { S.range = rg.dataset.range; render(); return; }
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, id = b.dataset.id;
    if (a === 'signout' || a === 'declineterms') { const t = S.token; signedOut(); try { await rpc('logout', { p_token: t }); } catch { /* already gone */ } }
    else if (a === 'eye') {
      const inp = b.parentElement.querySelector('input'), show = inp.type === 'password';
      inp.type = show ? 'text' : 'password'; b.innerHTML = ICON[show ? 'eyeOff' : 'eye'];
      b.setAttribute('aria-pressed', String(show)); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); inp.focus();
    }
    else if (a === 'refresh') refresh('Up to date');
    else if (a === 'welcome') startTour();
    else if (a === 'stmtpick') { S.stmt = id; render(); const el = $f('stmt'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (a === 'stmtcsv') { const m = stmtMonth(myMonths()); if (m) download(`lucidyo-statement-${m.key}.csv`, stmtMonthCsv(m)); }
    else if (a === 'stmtallcsv') download('lucidyo-statements-all-months.csv', stmtAllCsv());
    else if (a === 'stmtprint') printStatement();
    else if (a === 'auditfilter') { S.auditFilter = id; render(); }
    else if (a === 'auditmore') { try { const more = await call('admin_audit_log', { p_limit: 200, p_before: S.audit[S.audit.length - 1].id }); S.audit = S.audit.concat(more); S.auditMore = more.length >= 200; render(); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'backupjson' || a === 'backupcsv') { try { await backupDownload(a === 'backupjson' ? 'json' : 'csv'); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'makekey') { try { S.newKey = await call('admin_create_backup_key', { p_label: 'nightly backup' }); await loadAdminExtras(); render(); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'revokekeys') { if (!confirm('Revoke all backup keys? The nightly backup stops until you create a new key.')) return; try { await call('admin_revoke_backup_keys'); S.newKey = null; await loadAdminExtras(); render(); toast('Backup keys revoked'); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'splashskip') startTour();
    else if (a === 'welcomenext' || a === 'welcomeback') { S.welcome += a === 'welcomenext' ? 1 : -1; render(); window.scrollTo(0, 0); }
    else if (a === 'welcomedone') {
      try { localStorage.setItem(welcomeKey(S.me.id), '1'); } catch { /* not saved: shows again on the next visit */ }
      S.gate = null; S.welcome = null; S.welcomeDone = true; render(); window.scrollTo(0, 0);
    }
    else if (a === 'readterms') { S.gate = 'terms'; S.termsRO = true; render(); window.scrollTo(0, 0); }
    else if (a === 'termsback') { S.gate = null; S.termsRO = false; render(); window.scrollTo(0, 0); }
    else if (a === 'acceptterms') {
      if (![...document.querySelectorAll('.tck')].every((c) => c.checked)) return;
      b.disabled = true;
      try {
        const r = await call('accept_terms', { p_version: TERMS_VERSION });
        S.me.terms_version = r.version; S.me.terms_accepted_at = r.accepted_at; S.gate = afterTerms(); render(); window.scrollTo(0, 0);
      } catch (e) {
        if (e.message !== 'Signed out') toast(/function|schema cache/i.test(e.message) ? 'The database needs its latest update before your agreement can be saved. Please tell the manager.' : e.message, true);
        if (b.isConnected) b.disabled = false;
      }
    }
    else if (a === 'theme') { const p = themePref(); applyTheme(THEMES[(THEMES.indexOf(p) + 1) % THEMES.length]); if (S.me) render(); else loginView(); }
    else if (a === 'cur') { S.cur = inPeso() ? 'USDT' : 'PHP'; try { localStorage.setItem('ledger.cur', S.cur); } catch { /* not saved */ } render(); }
    else if (a === 'adduser') { S.addUser = !S.addUser; render(); }
    else if (a === 'maxunits') { const v = Number(S.me.unlocked_units) * Number(S.me.unit_price) * (inPeso() ? rate() : 1); $f('rq-u').value = Math.floor(v * 100) / 100; }
    else if (a === 'cancelpend') {
      if (!confirm('Remove this waiting deposit? Use this when you gave the money back (or typed it wrong). Nothing in the books changes.')) return;
      act(() => call('admin_cancel_pending', { p_id: Number(id) }), 'Removed from waiting');
    }
    else if (a === 'cancelreq') act(() => call('cancel_withdrawal_request', { p_id: Number(id) }), 'Request cancelled');
    else if (a === 'toggleactive') {
      const on = b.dataset.active === 'true';
      if (on && !confirm('Deactivate this person? They are signed out and cannot sign in until you reactivate them. Their units stay in the pool.')) return;
      act(() => call('admin_set_profile', { p_profile: id, p_name: null, p_active: !on, p_fee_rate: null }), on ? 'Deactivated' : 'Reactivated');
    }
    else if (a === 'allunits') { const fm = $f('wdForm'), h = holder(fv(fm, 'who')); if (h) { fm.elements.units.value = h.units; wdPrev(fm); } }
    else if (a === 'viewas') { try { await viewAs(id); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'exitview') backToManager();
    else if (a === 'undolast') {
      if (!confirm('Delete the most recent entry? This appends a correction that cancels it out — nothing is erased from the history.')) return;
      act(() => call('admin_undo_last', { p_note: 'correction: deleted' }), 'Last entry deleted (correction added)');
    }
    else if (a === 'editlast') {
      const e = S.elog[0]; if (!e) return;
      if (!confirm('This undoes the most recent entry so you can re-enter it with the fix. Continue?')) return;
      const rows = S.ledger.filter((l) => l.equity_id === e.id);
      try {
        const undone = await call('admin_undo_last', { p_note: 'correction: edit' });
        await refresh();
        if (undone && undone.back_to_pending) { S.rec = 'dep'; render(); toast('Deposit is back in "Waiting to join". Tap "Handed back" there if the amount was wrong, then record it again.'); return; }
        S.rec = e.kind === 'update' ? 'eq' : e.kind === 'deposit' ? 'dep' : 'wd';
        render();
        prefillEdit(e, rows);
      } catch (err) { if (err.message !== 'Signed out') toast(err.message, true); }
    }
    else if (a === 'payreq') {
      S.tab = 'record'; S.rec = 'wd'; render(); const fm = $f('wdForm');
      fm.elements.who.value = b.dataset.who; fm.elements.units.value = b.dataset.units; fm.elements.reqid.value = id; wdPrev(fm); fm.scrollIntoView();
    }
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.closest('#loginForm') && ev.target.getAttribute('aria-invalid')) ev.target.removeAttribute('aria-invalid');
  });
  document.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fm = ev.target, id = fm.id, btn = fm.querySelector('button:not([type=button])');
    if (btn) btn.disabled = true;
    try {
      if (id === 'loginForm') {
        loginError(null, fm);
        const r = await rpc('login', { p_username: fv(fm, 'username'), p_password: fv(fm, 'password') });
        if (!r.ok) { loginError(r.error, fm); if (btn) btn.disabled = false; return; }
        S.token = r.token; store.set(r.token); await refresh();
      } else if (id === 'pwForm') {
        await call('change_my_password', { p_old: fv(fm, 'old'), p_new: fv(fm, 'new') });
        fm.reset(); toast('Password changed'); if (btn) btn.disabled = false;
      } else if (id === 'newUserForm') {
        await call('admin_create_user', { p_username: fv(fm, 'username'), p_name: fv(fm, 'name'), p_password: fv(fm, 'password'), p_fee_rate: num(fv(fm, 'fee')) / 100 });
        S.addUser = false;
        await refresh(`Account created for ${fv(fm, 'name')}. Send them the username and password.`);
      } else if (fm.classList.contains('resetForm')) {
        await call('admin_set_password', { p_profile: fm.dataset.id, p_new: fv(fm, 'password') });
        fm.reset(); toast('Password set. They were signed out on their other devices.'); if (btn) btn.disabled = false;
      } else if (fm.classList.contains('profForm')) {
        await call('admin_set_profile', { p_profile: fm.dataset.id, p_name: fv(fm, 'name'), p_active: null, p_fee_rate: num(fv(fm, 'fee')) / 100 });
        await refresh('Saved');
      } else if (id === 'reqForm') {
        const want = num(fv(fm, 'amount')) / (inPeso() ? rate() : 1) / Number(S.me.unit_price);   // amount -> units
        const tol = 0.01 / (inPeso() ? rate() : 1) / Number(S.me.unit_price);   // within a centavo of the maximum means "everything" (the Max button rounds down)
        const units = Math.abs(want - Number(S.me.unlocked_units)) <= tol ? Number(S.me.unlocked_units) : want;   // more than that is left for the database to refuse
        const r = await call('request_withdrawal', { p_units: units, p_note: null });
        await refresh(`Requested. You will be paid by ${day(r.pay_by)}.`);
      } else if (id === 'eqForm') {
        const r = await call('admin_post_equity', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(Number(r.converted) ? `Equity saved. ${r.converted} waiting deposit${Number(r.converted) === 1 ? '' : 's'} joined at ${f(r.unit_price, 4)}.` : 'Equity saved');
      } else if (id === 'depForm') {
        const d = depUsdt(fm); if (!d || !(d.usdt > 0)) throw new Error('Enter an amount and the peso rate.');
        await call('admin_receive_deposit', { p_profile: fv(fm, 'who'), p_usdt: d.usdt, p_php_rate: d.rate, p_php_amount: d.php,
          p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(`Received ${d.php != null ? php(d.php) + ' = ' : ''}${usdt(d.usdt)}. It buys units at your next equity reading.`);
      } else if (id === 'wdForm') {
        const r = await call('admin_withdraw', { p_profile: fv(fm, 'who'), p_units: num(fv(fm, 'units')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm), p_force: fm.elements.force.checked, p_request_id: num(fv(fm, 'reqid')) });
        await refresh(`Withdrawal recorded. Pay out ${usdt(r.pay_usdt)} ${peso(r.pay_usdt, num(fv(fm, 'rate')) || rate())}`);
      } else if (id === 'qForm') {
        if (!confirm('Charge fees and close the quarter? This cannot be undone.')) { if (btn) btn.disabled = false; return; }
        const r = await call('admin_close_quarter', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(`Quarter closed: fees charged on ${r.investors_charged} investor(s), ${f(r.fee_units, 4)} units`);
      } else if (btn) btn.disabled = false;
    } catch (e) {
      if (id === 'loginForm') loginError(/fetch|network|Failed/i.test(e.message) ? 'Cannot reach the server. Check your internet connection and try again.'
        : /function|schema cache/i.test(e.message) ? 'The database is not set up yet (run the migration).' : e.message, fm);
      else if (e.message !== 'Signed out') toast(e.message || String(e), true);
      if (btn && btn.isConnected) btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- start
  try { S.cur = localStorage.getItem('ledger.cur') === 'USDT' ? 'USDT' : 'PHP'; } catch { /* default pesos */ }
  S.token = store.get(); S.adminToken = store.get(ADMIN_KEY);
  if (S.token) refresh(); else loginView();
})();

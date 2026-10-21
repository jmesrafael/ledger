// Ledger Monitor: paper record of a pooled account, valued in USDT and shown in pesos at the live rate. All numbers come from database functions;
// every call carries the session token from login (username + password checked and hashed in the database).
(() => {
  const C = window.CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = document.getElementById('app');
  const TOKEN_KEY = 'ledger.token', ADMIN_KEY = 'ledger.admin_token';   // ADMIN_KEY: the manager's own session while "viewing as"
  const S = { tab: null, token: null, adminToken: null, uid: null, me: null, pool: null, hist: [], history: [], ledger: [], reqs: [], all: [], elog: [], reports: [], range: 'ALL', rec: 'eq', fx: null, cur: 'PHP', addUser: false };

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
    S.tab = 'users'; S.uid = null; await refresh(msg);
    S.tab = 'users'; render();
  }

  // ---------------------------------------------------------------- data
  async function load() {
    S.me = await call('my_summary');
    if (!S.me) { signedOut(); throw new Error('Signed out'); }
    if (S.uid !== S.me.id) { S.uid = S.me.id; S.tab = null; }   // a different person signed in: start on their first tab
    const admin = S.me.role === 'admin';   // only the manager sees the pool; investors get just their own money
    const [pool, hist, history, led, reqs, all, elog] = await Promise.all([admin ? call('pool_summary') : null, admin ? call('price_history') : [], call('my_history'),
      call(admin ? 'admin_ledger' : 'my_ledger'), call(admin ? 'admin_requests' : 'my_requests'),
      admin ? call('admin_overview') : null, admin ? call('admin_equity_log') : null, loadFx(), admin ? loadReports() : null]);
    S.pool = pool; S.hist = hist; S.history = history; S.ledger = led; S.reqs = reqs; S.all = all || []; S.elog = elog || [];
  }
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
    const seg = [['Investors', p.investor_units, 'var(--seg2)'], ['Manager capital', p.admin_capital_units, 'var(--seg1)'], ["Manager's earned share", p.admin_fee_units, 'var(--seg3)']];
    return `<div class="card hero"><h2>Fund value</h2>
        <div class="big">${money(p.equity_usdt)}</div><div class="sub">${alt(p.equity_usdt)}</div>
        <div class="delta ${cls(p.since_start_pct)}">${pct(p.since_start_pct)} since start</div>
        <p class="note" style="margin:8px 0 0">Last updated ${p.asof ? day(p.asof) : '—'} · unit price ${f(p.unit_price, 4)}</p></div>
      <div class="card"><div class="grid">
        <div class="stat"><div class="k">Investors</div><div class="v">${p.investor_count}</div></div>
        <div class="stat"><div class="k">Investors' money</div><div class="v">${money(invValue)}</div></div>
        <div class="stat"><div class="k">Put in by investors</div><div class="v">${money(invIn)}</div></div>
        <div class="stat"><div class="k">Their profit share due</div><div class="v">${money(due)}</div></div></div>
        ${pend.length ? `<div class="btns"><button class="ghost" data-tab="log">${pend.length} withdrawal request${pend.length === 1 ? '' : 's'} · ${money(pendUsdt)}</button></div>` : '<p class="note" style="margin:12px 0 0">No withdrawal requests waiting.</p>'}</div>
      <div class="card"><h2>Fund performance</h2>${chart(S.hist)}</div>
      <div class="card"><h2>Who owns the pool</h2>
        <div class="split">${seg.map(([, u, c]) => `<i style="width:${(Number(u) / tot) * 100}%;background:${c}"></i>`).join('')}</div>
        <div class="legend">${seg.map(([n, u, c]) => `<span><b style="background:${c}"></b>${n} ${f((Number(u) / tot) * 100, 1)}%</span>`).join('')}</div>
        <p class="note" style="margin-top:8px">The manager's earned share comes only from profits and stays invested in the pool. Investors cannot see any of this page.</p></div>
      <p class="disc">${rateNote()}</p>`;
  }
  const KIND = {
    deposit: ['Deposit', 'in', 'arrowIn'], withdrawal: ['Withdrawal', 'out', 'arrowOut'],
    fee_out: ['Profit share to manager', 'share', 'share'], fee_in: ['Profit share received', 'in', 'share'],
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
  const DISC = `<p class="disc">This is a record of your share of a pooled trading account, shown in pesos at today's exchange rate. It is an investment that grows (or shrinks) with the trading results, not a savings account, not a salary or dividend, not a bank balance, and not insured. You can lose some or all of the money you put in. Only invest money you can afford to lose.</p>`;

  // ---------------------------------------------------------------- investor / shared views
  function viewHome() {
    const m = S.me, investor = m.role === 'investor';
    const pend = S.reqs.filter((q) => q.status === 'pending' && q.profile_id === m.id);
    const avail = Number(m.unlocked_units) * Number(m.unit_price);
    return `${growthCard(investor ? 'Your balance' : 'Your holdings')}
      ${investor ? profitShareCard(m) : ''}${investor ? `<div class="card"><h2>Withdrawals</h2>
        <div class="row"><span class="l">Available to withdraw now</span><span class="r">${money(avail)}<br><span class="note">${alt(avail)}</span></span></div>
        <div class="row"><span class="l">Next part unlocks</span><span class="r">${day(m.next_unlock)}</span></div>
        <p class="note">Each deposit is locked for ${C.LOCK_MONTHS} months. Requests are paid within ${C.WITHDRAW_BUSINESS_DAYS} business days, at the value on the day of payout. If a profit share is due, it comes off the payout.</p>
        ${m.impersonated ? '<p class="note">Read-only view: only the person can request a withdrawal.</p>' : `<form id="reqForm"><label for="rq-u">Amount to withdraw (${inPeso() ? '₱' : 'USDT'})</label>
          <input id="rq-u" name="amount" type="number" step="any" min="0" inputmode="decimal" required>
          <div class="btns"><button type="button" class="ghost" data-action="maxunits">Everything available</button><button>Request withdrawal</button></div></form>`}
        ${pend.length ? '<h2 style="margin-top:14px">Pending requests</h2>' + pend.map((q) => `<div class="row"><span class="l">${day(q.requested_at)} · about ${money(q.units * m.unit_price)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span><span class="r"><button class="ghost" data-action="cancelreq" data-id="${q.id}">Cancel</button></span></div>`).join('') : ''}</div>`
      : `<div class="card"><h2>Profit share earned</h2>
        <div class="row"><span class="l">Stays invested in the pool</span><span class="r">${money(m.fee_units_value_usdt)}<br><span class="note">${f(m.fee_units_earned, 4)} units</span></span></div></div>`}
      ${recentCard()}${investor ? aboutTeaser() : ''}${m.impersonated ? '' : passwordCard()}${DISC}`;
  }
  const aboutTeaser = () => `<div class="card"><h2>Good to know</h2>
    <p class="note" style="margin:0 0 4px"><b style="color:var(--ink)">This grows your money, it does not pay you monthly.</b> There are no dividends, and the balance can go down as well as up.</p>
    <div class="btns"><button class="ghost" data-tab="about">Read how it works</button></div></div>`;
  function profitShareCard(m) {
    const keep = 1 - Number(m.fee_rate), paid = -S.ledger.filter((l) => l.kind === 'fee_out' && l.profile_id === m.id).reduce((a, l) => a + Number(l.usdt), 0);
    const above = Number(m.unit_price) > Number(m.hwm);
    return `<div class="card"><h2>Profit share</h2>
      <div class="split"><i style="width:${keep * 100}%;background:var(--up)"></i><i style="width:${(1 - keep) * 100}%;background:var(--seg3)"></i></div>
      <div class="legend" style="margin-bottom:6px"><span><b style="background:var(--up)"></b>You keep ${f(keep * 100, 0)}% of new profits</span><span><b style="background:var(--seg3)"></b>Manager ${f((1 - keep) * 100, 0)}%</span></div>
      <div class="row"><span class="l">${above ? 'Profit share due at quarter end (estimate)' : 'Profit share due now'}</span><span class="r">${above ? money(m.accrued_fee_usdt) : 'None: below your best'}</span></div>
      <div class="row"><span class="l">Your balance after it</span><span class="r"><b>${money(m.value_after_fee_usdt)}</b></span></div>
      <div class="row"><span class="l">Shared so far</span><span class="r">${money(paid)}</span></div>
      <p class="note">The manager is paid only from <b>new</b> profit above your best-ever level, never from the money you put in. While your balance is below its best, nothing is shared. It is settled once a quarter inside the pool; no cash moves.</p></div>`;
  }
  function recentCard() {
    const mine = S.ledger.filter((l) => l.profile_id === S.me.id);
    return `<div class="card"><h2>Recent transactions</h2>${activityRows(mine.slice(0, 5), false)}
      ${mine.length > 5 ? `<div class="btns"><button class="ghost" data-tab="${isAdmin() ? 'log' : 'activity'}">See all ${mine.length}</button></div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- growth chart (Robinhood-style: drag across it to see any day)
  const RANGES = [['1W', 7, 'Past week'], ['1M', 30, 'Past month'], ['3M', 91, 'Past 3 months'], ['YTD', 'ytd', 'This year'], ['1Y', 365, 'Past year'], ['ALL', null, 'All time']];
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
    if (!pts.length) return `<div class="card hero"><h2>${title}</h2><div class="big">${money(m.value_usdt)}</div><div class="sub">${alt(m.value_usdt)}</div><p class="note">The chart starts with the first deposit.</p></div>`;
    const a = pts[0], z = pts[pts.length - 1], up = (z.v - z.n) - (a.v - a.n) >= 0;
    const t0 = a.t, t1 = Math.max(z.t, t0 + 1), lo = Math.min(...pts.map((p) => Math.min(p.v, p.n))), hi = Math.max(...pts.map((p) => Math.max(p.v, p.n)));
    const pad = (hi - lo || Math.max(hi, 1) * 0.05) * 0.12, y0 = lo - pad, y1 = hi + pad, W = 300, H = 130;
    const X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (v) => H - ((v - y0) / (y1 - y0)) * H;
    S.chart = { pts, X, Y, W, H };
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
      <p class="note" style="margin:8px 0 0">Line: what your money is worth. Dashed: what you have put in. Drag across the chart to see any day.</p>
      <p class="note" style="margin:4px 0 0">${rateNote()}. Pesos move with the exchange rate even when your USDT does not.</p></div>`;
  }
  function showPoint(i) {   // update the big number to the point under the finger (or the latest point)
    const { pts, X, Y, W, H } = S.chart, p = pts[i], a = pts[0], d = (p.v - p.n) - (a.v - a.n);
    const dot = $f('gdot'); dot.style.left = (X(p.t) / W) * 100 + '%'; dot.style.top = (Y(p.v) / H) * 100 + '%'; dot.classList.toggle('live', i === pts.length - 1);
    const base = a.v > 0 ? a.v + (p.n - a.n) : p.n, label = RANGES.find((x) => x[0] === S.range)[2];
    $f('gv').textContent = money(p.v);
    $f('gp').textContent = alt(p.v);
    $f('gd').className = 'delta ' + cls(d);
    $f('gd').textContent = `${smoney(d)} (${base > 0 ? pct(d / base) : '—'}) ${i === pts.length - 1 ? label : new Date(p.t).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`;
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
  const viewAbout = () => `<div class="card"><h2>How this works</h2>
      <p class="about"><b>You are investing, not earning a salary.</b> Your money is added to one trading account that is managed together. Whatever the trading makes or loses is shared out by how much each person has in. The balance you see moves up and down with the results.</p>
      <p class="about"><b>It grows, it does not pay out.</b> Profits stay in and compound. There are no dividends and no monthly or steady income, so please do not count on this to pay for bills or expenses. Some weeks and months will be flat or down.</p>
      <p class="about"><b>You can lose money.</b> The balance can fall below what you put in, and in a bad stretch you can lose a big part or all of it. Nothing is guaranteed, nothing is insured, and past or backtested results do not promise future results. Only put in money you can afford to lose.</p></div>
    <div class="card"><h2>Profit share</h2>
      <p class="about">The manager keeps a share of the <b>new profit</b> only, never of your own money. Nothing is taken while your balance is below its best-ever level, and it is settled once a quarter inside the pool.</p></div>
    <div class="card"><h2>Pesos</h2>
      <p class="about">The pool is traded in USDT (a dollar-linked coin). The pesos you see are worked out with the live dollar-to-peso rate, so your peso balance can move a little even when the trading did not. The ₱ / $ button at the top switches the view.</p></div>
    <div class="card"><h2>Putting in and taking out</h2>
      <p class="about">The manager records your deposits. Each deposit is locked for ${C.LOCK_MONTHS} months. After that, ask for a withdrawal on the Home page and it is paid within ${C.WITHDRAW_BUSINESS_DAYS} business days at the value on the day of payout.</p>
      <p class="about">This page is a record kept by the manager. It is not a bank, and money here is not covered by any deposit insurance.</p></div>${DISC}`;
  const viewActivity = () => `<div class="card"><h2>Your activity</h2>${activityRows(S.ledger, false)}</div>`;

  // ---------------------------------------------------------------- admin views
  function viewUsers() {
    return `<div class="sechead"><h2>Users (${S.all.length})</h2><button class="sm ${S.addUser ? 'ghost' : ''}" data-action="adduser">${S.addUser ? 'Cancel' : '+ Add user'}</button></div>
      ${S.addUser ? `<div class="card"><h2>New user</h2>
      <p class="note">Give them the username and password yourself. They can change the password after signing in.</p>
      <form id="newUserForm"><div class="grid form2"><div><label>Username</label><input name="username" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\\-]{3,30}" required></div>
        <div><label>Profit share %</label><input name="fee" type="number" step="any" min="0" max="100" value="20" required></div></div>
        <label>Full name</label><input name="name" required>
        <label>Starting password (at least 8 characters)</label><input name="password" type="text" minlength="8" autocomplete="off" required>
        <button class="full">Create account</button></form></div>` : ''}
      <div class="card">${S.all.map((h) => `<div class="person">
        <div class="top"><span class="nm">${esc(h.name || h.username)} <span class="chip">${h.role === 'admin' ? 'manager' : 'investor'}</span>${h.active ? '' : ' <span class="chip down">off</span>'}</span>
          <span><b>${money(h.value_usdt)}</b></span></div>
        <div class="top"><span class="note">@${esc(h.username)}</span>${h.role === 'investor' && h.active ? `<button class="ghost sm" data-action="viewas" data-id="${h.id}">View as</button>` : ''}</div>
        <div class="mini">
          <div><span>Put in</span>${money(h.net_in_usdt)}</div>
          <div><span>Profit</span><i class="${cls(h.profit_usdt)}" style="font-style:normal">${smoney(h.profit_usdt)}${h.return_pct != null ? ' (' + pct(h.return_pct, 1) + ')' : ''}</i></div>
          <div><span>Share</span>${h.share_pct == null ? '—' : f(h.share_pct * 100, 1) + '%'}</div>
          <div><span>Units</span>${f(h.units, 3)}</div>
          <div><span>HWM</span>${f(h.hwm, 4)}</div>
          <div><span>${h.role === 'admin' ? 'Earned share' : 'Locked until'}</span>${h.role === 'admin' ? f(h.fee_units_earned, 3) : day(h.lock_until)}</div></div>
        <details style="margin-top:8px"><summary class="note" style="cursor:pointer">Edit / reset password</summary>
          ${h.role === 'investor' ? `<form class="profForm" data-id="${h.id}"><div class="grid form2"><div><label>Name</label><input name="name" value="${esc(h.name)}"></div>
            <div><label>Profit share %</label><input name="fee" type="number" step="any" min="0" max="100" value="${f(h.fee_rate * 100, 0)}"></div></div>
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

  function viewRecord() {
    const empty = Number(S.pool.total_units) === 0;
    if (empty && S.rec === 'eq') S.rec = 'dep';   // nothing to value yet: start with the first deposit
    const pick = (k, html) => (S.rec === k ? html : '');
    return `<div class="ranges" style="margin:12px 0 0">${[['eq', 'Equity'], ['dep', 'Deposit'], ['wd', 'Withdrawal']].map(([k, l]) => `<button class="${S.rec === k ? 'on' : ''}" data-rec="${k}">${l}</button>`).join('')}</div>
      ${pick('eq', `<div class="card"><h2>Update pool equity</h2>
      <p class="note">Read the pool's total equity (USDT, including open trades) from MEXC. This moves the unit price for everyone. No one's units change.</p>
      <form id="eqForm"><label>Pool equity now (USDT)</label><input name="equity" type="number" step="any" inputmode="decimal" required ${empty ? 'disabled placeholder="Record the first deposit first"' : ''}>
        ${phpField()}<label>Note (optional)</label><input name="note"><div class="preview" id="eqPrev">—</div><button class="full" ${empty ? 'disabled' : ''}>Save equity</button></form></div>`)}
      ${pick('dep', `<div class="card"><h2>Record a deposit</h2>
        <p class="note">${empty ? 'This is the very first deposit (the manager\'s own capital). Units start at 1.00.' : 'Type what they handed over in pesos. It is turned into USDT and units for you. Enter the pool equity from MEXC <b>just before</b> this money lands, so the new person buys units at the right price.'}</p>
        <form id="depForm"><label>Person</label><select name="who">${holderOpts()}</select>
        <div class="grid form2"><div><label>Amount</label><input name="amt" type="number" step="any" inputmode="decimal" placeholder="5000" required></div>
          <div><label>In</label><select name="ccy"><option value="PHP">₱ Pesos</option><option value="USDT">USDT</option></select></div></div>
        <label>Rate (₱ per USDT)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate() ? Number(rate()).toFixed(2) : ''}">
        <p class="note" style="margin:6px 0 0">${rateNote()}. Change it if the real rate you converted at was different.</p>
        ${empty ? '' : '<label>Pool equity before this deposit (USDT)</label><input name="eq" type="number" step="any" inputmode="decimal" required>'}
        ${phpField(false)}<label>Note (optional)</label><input name="note"><div class="preview" id="depPrev">—</div><button class="full">Record deposit</button></form></div>`)}
      ${pick('wd', `<div class="card"><h2>Record a withdrawal</h2>
        <p class="note">Enter the pool equity from MEXC just before you pay out. Any profit share due (on gains above their best) is settled in units first.</p>
        <form id="wdForm"><label>Person</label><select name="who">${holderOpts()}</select>
        <label>Units to redeem</label><input name="units" type="number" step="any" inputmode="decimal" required>
        <div class="btns"><button type="button" class="ghost" data-action="allunits">All their units</button></div>
        <label>Pool equity before this payout (USDT)</label><input name="eq" type="number" step="any" inputmode="decimal" required>
        ${phpField()}<label>Note (optional)</label><input name="note"><input type="hidden" name="reqid">
        <label style="display:flex;gap:8px;align-items:center"><input name="force" type="checkbox" style="width:auto;min-height:0"> Override lock-up</label>
        <div class="preview" id="wdPrev">—</div><button class="full">Record withdrawal</button></form></div>`)}`;
  }
  function viewQuarter() {
    return `<div class="card"><h2>Close the quarter</h2>
      <p class="note">Settles each investor's profit share (their own %, 20% by default) of any gain above their best-ever level. It moves as <b>units</b> from them to you (still inside the pool, so it compounds). Then each high-water mark resets. Do this once per quarter.</p>
      <form id="qForm"><label>Pool equity now (USDT)</label><input name="equity" type="number" step="any" inputmode="decimal" required>
      ${phpField()}<label>Note (optional)</label><input name="note" value="Quarter close"><div class="preview" id="qPrev">Enter the equity to preview the profit share.</div>
      <button class="full">Settle profit share and close quarter</button></form></div>`;
  }
  function viewLog() {
    const pend = S.reqs.filter((q) => q.status === 'pending');
    return `<div class="card"><h2>Withdrawal requests</h2>${pend.length ? pend.map((q) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(q.name)}</b><br>${money(q.units * S.pool.unit_price)} (${f(q.units, 4)} units) · asked ${day(q.requested_at)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span>
      <span class="r"><button data-action="payreq" data-id="${q.id}" data-who="${q.profile_id}" data-units="${q.units}">Prepare payout</button></span></div>`).join('') : '<p class="note">None pending.</p>'}</div>
      <div class="card"><h2>All entries</h2>${activityRows(S.ledger, true)}</div>
      <div class="card"><h2>Equity readings</h2>${S.elog.length ? S.elog.slice(0, 60).map((e) => `<div class="row"><span class="l">${day(e.ts)} · ${esc(e.kind)}${e.note ? `<br><span class="note">${esc(e.note)}</span>` : ''}</span>
        <span class="r">${money(e.equity_usdt)}<br><span class="note">${usdt(e.equity_usdt)} · price ${f(e.unit_price, 4)}</span></span></div>`).join('') : '<p class="note">None yet.</p>'}</div>`;
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
      <p class="note" style="margin:4px 2px 0">These pages are plain links, outside the sign-in area, so the address can be handed straight to someone outside Ledger — the "Open library" button above is the public, shareable page.</p>`;
  }
  // ---------------------------------------------------------------- shell
  const TABS = {
    investor: [['home', 'Home'], ['activity', 'Activity'], ['about', 'About']],
    admin: [['dashboard', 'Dashboard'], ['users', 'Users'], ['record', 'Record'], ['quarter', 'Quarter'], ['reports', 'Reports'], ['log', 'Log'], ['home', 'Mine']],
  };
  const VIEWS = { home: viewHome, activity: viewActivity, about: viewAbout, dashboard: viewDashboard, users: viewUsers, record: viewRecord, quarter: viewQuarter, log: viewLog, reports: viewReports };
  const TABICON = { users: 'people', dashboard: 'dash' };

  function loginView() {
    app.innerHTML = `<header><span></span><div class="hdr-actions">${themeBtn()}</div></header>
      <div class="login-brand"><span class="logo">${ICON.logo}</span><h1>Ledger Monitor</h1><p class="note">Your share of the pool, at a glance.</p></div>
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
    const tabs = TABS[isAdmin() ? 'admin' : 'investor'];
    if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    const viewing = S.me.impersonated;
    app.innerHTML = `${viewing ? `<div class="viewas"><span>Viewing as <b>${esc(S.me.name || S.me.username)}</b>, exactly what they see (read-only)</span>
        <button data-action="exitview">Back to manager</button></div>` : ''}
      <header><div><div class="hello">${greeting()}${isAdmin() ? ' · manager' : ''}</div><h1>${esc(S.me.name || S.me.username)}</h1></div>
      <div class="hdr-actions">${curBtn()}${themeBtn()}<button class="iconbtn" data-action="refresh" aria-label="Refresh">${ICON.refresh}</button></div></header>
      ${VIEWS[S.tab]()}
      ${viewing ? '' : '<div class="btns" style="justify-content:center;margin:4px 0 8px"><button class="ghost sm" style="flex:none" data-action="signout">Sign out</button></div>'}
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
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units);
    if (eq == null || !u) return setPrev('eqPrev', '—');
    const price = eq / u, ch = price / Number(S.pool.unit_price) - 1;
    setPrev('eqPrev', `Unit price becomes <b>${f(price, 4)}</b> (<span class="${cls(ch)}">${pct(ch)}</span> vs last reading). Since start ${pct(price - 1)}.<br>Pool is ${money(eq)} ${alt(eq)}.`);
  }
  // what a deposit form means in USDT: pesos / rate, or the USDT typed directly
  function depUsdt(fm) {
    const amt = num(fv(fm, 'amt')), r = num(fv(fm, 'rate'));
    if (amt == null) return null;
    if (fv(fm, 'ccy') === 'USDT') return { usdt: amt, php: null, rate: r };
    return r > 0 ? { usdt: Math.round((amt / r) * 1e4) / 1e4, php: amt, rate: r } : { usdt: null };
  }
  function depPrev(fm) {
    const d = depUsdt(fm), u = Number(S.pool.total_units), eq = num(fv(fm, 'eq'));
    if (!d) return setPrev('depPrev', '—');
    if (d.usdt == null) return setPrev('depPrev', 'Enter the peso rate to convert.');
    if (u && eq == null) return setPrev('depPrev', `Counts as <b>${usdt(d.usdt)}</b>. Enter the equity before the deposit.`);
    const price = u ? eq / u : 1;
    setPrev('depPrev', `${d.php != null ? `${php(d.php)} = ` : ''}<b>${usdt(d.usdt)}</b>${d.php == null && d.rate ? ` (${php(d.usdt * d.rate)})` : ''}. Buys <b>${f(d.usdt / price, 4)} units</b> at ${f(price, 4)}. Lock-up ${C.LOCK_MONTHS} months.`);
  }
  const holder = (id) => S.all.find((h) => h.id === id);
  function wdPrev(fm) {
    const h = holder(fv(fm, 'who')), units = num(fv(fm, 'units')), eq = num(fv(fm, 'eq')), u = Number(S.pool.total_units);
    if (!h || units == null || eq == null || !u) return setPrev('wdPrev', '—');
    const price = eq / u, fee = h.role === 'investor' ? (h.fee_rate * Math.max(0, price - h.hwm) / price) * units : 0;
    const net = units - fee, pay = net * price;
    const warn = units > Number(h.units) + 1e-8 ? '<br><span class="down">More than they hold.</span>'
      : h.role === 'investor' && units > Number(h.unlocked_units) + 1e-8 && !fm.elements.force.checked ? '<br><span class="warn">Inside lock-up. Tick override to allow.</span>' : '';
    setPrev('wdPrev', `Price ${f(price, 4)}. Profit share <b>${f(fee, 4)} units</b>. Pay out <b>${usdt(pay)}</b> ${peso(pay, num(fv(fm, 'rate')) || rate())} for ${f(net, 4)} units.${warn}`);
  }
  function qPrev(fm) {
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units);
    if (eq == null || !u) return setPrev('qPrev', 'Enter the equity to preview the profit share.');
    const price = eq / u; let tot = 0;
    const rows = S.all.filter((h) => h.role === 'investor' && Number(h.units) > 0).map((h) => {
      const fee = (h.fee_rate * Math.max(0, price - h.hwm) / price) * h.units; tot += fee;
      return `<div class="row"><span class="l">${esc(h.name || h.username)}<br><span class="note">HWM ${f(h.hwm, 4)}</span></span><span class="r">${f(fee, 4)} units<br><span class="note">${usdt(fee * price)}</span></span></div>`;
    }).join('');
    setPrev('qPrev', `Price ${f(price, 4)}.${rows || '<br>No investors hold units.'}<div class="row"><span class="l"><b>Total profit share</b></span><span class="r"><b>${f(tot, 4)} units</b> (${usdt(tot * price)})</span></div>`);
  }

  // ---------------------------------------------------------------- actions
  async function act(fn, okMsg) {
    try { await fn(); await refresh(okMsg); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); }
  }
  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const rc = ev.target.closest('[data-rec]');
    if (rc) { S.rec = rc.dataset.rec; render(); return; }
    const rg = ev.target.closest('[data-range]');
    if (rg) { S.range = rg.dataset.range; render(); return; }
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, id = b.dataset.id;
    if (a === 'signout') { const t = S.token; signedOut(); try { await rpc('logout', { p_token: t }); } catch { /* already gone */ } }
    else if (a === 'eye') {
      const inp = b.parentElement.querySelector('input'), show = inp.type === 'password';
      inp.type = show ? 'text' : 'password'; b.innerHTML = ICON[show ? 'eyeOff' : 'eye'];
      b.setAttribute('aria-pressed', String(show)); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); inp.focus();
    }
    else if (a === 'refresh') refresh('Up to date');
    else if (a === 'theme') { const p = themePref(); applyTheme(THEMES[(THEMES.indexOf(p) + 1) % THEMES.length]); if (S.me) render(); else loginView(); }
    else if (a === 'cur') { S.cur = inPeso() ? 'USDT' : 'PHP'; try { localStorage.setItem('ledger.cur', S.cur); } catch { /* not saved */ } render(); }
    else if (a === 'adduser') { S.addUser = !S.addUser; render(); }
    else if (a === 'maxunits') { const v = Number(S.me.unlocked_units) * Number(S.me.unit_price) * (inPeso() ? rate() : 1); $f('rq-u').value = Math.floor(v * 100) / 100; }
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
        await call('admin_post_equity', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh('Equity saved');
      } else if (id === 'depForm') {
        const d = depUsdt(fm); if (!d || !(d.usdt > 0)) throw new Error('Enter an amount and the peso rate.');
        const r = await call('admin_deposit', { p_profile: fv(fm, 'who'), p_usdt: d.usdt, p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: d.rate, p_php_amount: d.php, p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(`Deposit recorded: ${d.php != null ? php(d.php) + ' = ' : ''}${usdt(d.usdt)}, ${f(r.units, 4)} units at ${f(r.unit_price, 4)}`);
      } else if (id === 'wdForm') {
        const r = await call('admin_withdraw', { p_profile: fv(fm, 'who'), p_units: num(fv(fm, 'units')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm), p_force: fm.elements.force.checked, p_request_id: num(fv(fm, 'reqid')) });
        await refresh(`Withdrawal recorded. Pay out ${usdt(r.pay_usdt)} ${peso(r.pay_usdt, num(fv(fm, 'rate')) || rate())}`);
      } else if (id === 'qForm') {
        if (!confirm('Settle the profit share and close the quarter? This cannot be undone.')) { if (btn) btn.disabled = false; return; }
        const r = await call('admin_close_quarter', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(`Quarter settled: profit share from ${r.investors_charged} investor(s), ${f(r.fee_units, 4)} units`);
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

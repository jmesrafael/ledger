// Lucid'io Ledger: paper record of a pooled account, valued in USDT and shown in pesos at the live rate. All numbers come from database functions;
// every call carries the session token from login (username + password checked and hashed in the database).
(() => {
  const C = window.CONFIG;
  const TERMS_VERSION = '2026-10-26';   // bump when the terms wording below changes: every investor is asked to agree again at their next sign-in
  const SPLASH_MS = 9000;               // how long the quote screen stays (tap Skip to leave sooner)
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const app = document.getElementById('app');
  const TOKEN_KEY = 'ledger.token', ADMIN_KEY = 'ledger.admin_token';   // ADMIN_KEY: the fund manager's own session while "viewing as"
  const S = { tab: null, token: null, adminToken: null, uid: null, me: null, pool: null, hist: [], history: [], ledger: [], reqs: [], all: [], elog: [], reports: [], pend: [], range: 'ALL', lrange: '1W', lkind: 'capital', live: null, rec: null, nav: null, cashins: null, fx: null, cur: 'PHP', addUser: false, welcome: null, welcomeDone: false, gate: null, termsRO: false, splashT: null };

  // ---------------------------------------------------------------- icons (stroke icons, inherit text colour)
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    home: svg('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
    calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>'),
    pool: svg('<path d="M21 12a9 9 0 1 1-9-9v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
    activity: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
    people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
    record: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8"/>'),
    quarter: svg('<rect x="3" y="4.5" width="18" height="16.5" rx="4"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/>'),
    log: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
    mine: svg('<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2"/>'),
    refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    user: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.9-3.6 3.9-5.4 7.5-5.4s6.6 1.8 7.5 5.4"/>'),
    tour: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    bot: svg('<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M9 12.5h.01M15 12.5h.01M9.5 16h5"/>'),
    signout: svg('<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M16 8l4 4-4 4M20 12H9"/>'),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    phone: svg('<path d="M6.6 3h2.6l1.5 4-2 1.3a11 11 0 0 0 7 7l1.3-2 4 1.5v2.6a2 2 0 0 1-2.2 2A17 17 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z"/>'),
    wallet: svg('<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18M16 15h2"/>'),
    withdraw: svg('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>'),
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
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
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
  // dates read "Jan 20, 2026", times "9:00pm" (12-hour, no seconds, no space), always in the viewer's own time
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock12 = (d) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`;
  const dayTime = (ts) => { const d = new Date(ts); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${clock12(d)}`; };
  const day = (s) => (s ? new Date(String(s).length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const pc = (rate) => String(Number((Number(rate) * 100).toFixed(4)));
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const isAdmin = () => S.me && S.me.role === 'admin';
  // LEGACY_SCREENS (js/config.js, off by default): the retired by-hand screens: typed balances and Update Pool, the Balance desk (workflow gate), the by-hand
  // Money in / Money out forms, "They paid me directly", the admission spread and the typed-total settlement. With it off the fund manager has the four steps
  // (Add investor, Cash in, Withdraw, Transfer), the Live NAV, History and the automatic settlement, and none of the functions below is ever requested:
  // call() refuses them here, before anything is sent. The list equals supabase/migrations/20261215000000_retire_unused_functions.sql (tests/retire.test.mjs).
  const LEGACY = !!(window.CONFIG && window.CONFIG.LEGACY_SCREENS);
  const RETIRED = new Set(['admin_post_equity', 'admin_withdraw', 'admin_withdraw_to_manager', 'admin_units_from_manager', 'admin_quote_units_from_manager', 'admin_quote_withdraw',
    'admin_close_quarter', 'admin_settlement_preview', 'admin_settlement_preview_tv', 'admin_update_pool', 'admin_update_pool_and_admit', 'admin_pending_pnl', 'admin_pool_status',
    'admin_attest_settlement', 'admin_attest_snapshot', 'admin_wallet_nav',
    'admin_enter_balance', 'admin_confirm_balance', 'admin_reject_balance', 'admin_apply_balance', 'admin_add_adjustment', 'admin_classify_difference', 'admin_classify_pool_difference',
    'admin_classify_transfer', 'admin_escalate', 'admin_balance_checks', 'admin_capital_queue', 'admin_capital_events', 'admin_admit_deposit', 'admin_execute_withdrawal',
    'admin_quote_withdrawal', 'admin_quote_close', 'admin_settle_quarter', 'admin_confirm_arrival', 'admin_split_withdrawal_request', 'admin_withdrawal_queue',
    'admin_receive_deposit', 'admin_mark_arrived', 'admin_cancel_pending', 'admin_admit_deposit_tv', 'admin_admit_deposits_tv', 'admin_peso_topup', 'admin_quote_peso_topup',
    'admin_approve_withdrawal', 'admin_execute_withdrawal_tv',
    'admin_admission_spreads', 'admin_quote_admission_spread', 'admin_admit_admission_spread_tv', 'admin_cancel_admission_spread']);
  const rateText = (h) => pc(h.fee_rate) + '%' + (h.fee_rate_next != null ? ` → ${pc(h.fee_rate_next)}% after next close` : '');

  // Toasts, top right, coloured by what happened: green = saved / recorded, blue = updated / changed, red = deleted or an error.
  // A delete that names its own target is held for a few seconds with an Undo button (holdDelete); nothing is sent until the time is up.
  const TOAST_ICON = { ok: 'check', info: 'refresh', del: 'trash', err: 'alert' };
  const toastKind = (m) => (/deleted|removed|handed back|cancel|revoked|deactivated/i.test(m) ? 'del'
    : /updated|changed|renamed|corrected|applied|marked|admitted|moved|passed|joined|reactivated|viewing as|undone|password set|up to date|reset/i.test(m) ? 'info' : 'ok');
  function toast(msg, kind, opts = {}) {
    const k = kind === true ? 'err' : kind || toastKind(String(msg)), t = document.getElementById('toast'), ms = opts.ms || (k === 'err' ? 6500 : 3800);
    toast.undo = opts.undo || null;
    t.innerHTML = `<div class="toast ${k}" role="${k === 'err' ? 'alert' : 'status'}" style="--ms:${ms}ms"><span class="ticon">${ICON[TOAST_ICON[k]]}</span><span class="tmsg">${esc(msg)}</span>`
      + `${opts.undo ? '<button type="button" class="tundo" data-toast="undo">Undo</button>' : ''}<button type="button" class="tx" data-toast="close" aria-label="Dismiss">${ICON.close}</button>${opts.undo ? '<span class="tbar"></span>' : ''}</div>`;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.innerHTML = ''; toast.undo = null; }, ms);
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('#toast [data-toast]'); if (!b) return;
    const undo = b.dataset.toast === 'undo' ? toast.undo : null;
    clearTimeout(toast.t); toast.undo = null; document.getElementById('toast').innerHTML = '';
    if (undo) undo();
  });
  // A delete is held for HOLD ms with a red toast and an Undo button; only then is it sent. The button that started it keeps its spinner meanwhile.
  // Only for deletes that name their own target (a waiting deposit, a request, a person, the keys): not for "delete the most recent entry", which a bot booking
  // in the meantime would point at a different entry.
  const HOLD = 6000;
  function holdDelete(label, run, doneMsg) {
    return new Promise((resolve) => {
      let timer = null;
      const undo = () => { clearTimeout(timer); toast('Undone: nothing was changed', 'info'); resolve(); };
      toast(label, 'del', { ms: HOLD, undo });
      timer = setTimeout(async () => { try { await run(); await refresh(doneMsg); } catch (e) { if (e.message !== 'Signed out' && !e.cancelled) toast(e.message, true); } resolve(); }, HOLD);
    });
  }
  const store = {
    get(k = TOKEN_KEY) { try { return localStorage.getItem(k); } catch { return null; } },
    set(v, k = TOKEN_KEY) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode: stay signed in for this tab only */ } },
  };
  // ---------------------------------------------------------------- confirmation sheets (js/confirmsheet.js) instead of confirm() / prompt()
  // askSheet(opts) resolves to { field: value } when confirmed, or null when cancelled (Cancel, Esc, or a tap outside). Focus moves into the sheet, stays inside
  // it, and goes back to the button that opened it.
  let csN = 0;
  function askSheet(opts) {
    return new Promise((resolve) => {
      const prev = document.activeElement, uid = 'cs' + (++csN), fields = opts.fields || [];
      const paused = [...document.querySelectorAll('button.busy')]; paused.forEach((x) => x.classList.remove('busy'));   // not spinning while it waits for your answer
      const wrap = document.createElement('div'); wrap.innerHTML = ConfirmSheet.html(opts, uid);
      const bg = wrap.firstElementChild, form = bg.querySelector('form');
      document.body.appendChild(bg); document.body.style.overflow = 'hidden';
      const finish = (v) => {
        document.removeEventListener('keydown', onKey, true); bg.remove(); document.body.style.overflow = S.modal ? 'hidden' : '';
        if (prev && prev.isConnected && prev.focus) prev.focus();
        if (v) paused.forEach((x) => { if (x.isConnected) x.classList.add('busy'); });   // confirmed: the button spins again until the action is done
        resolve(v);
      };
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); finish(null); return; }
        if (ev.key !== 'Tab') return;
        const els = [...bg.querySelectorAll('input, select, textarea, button:not([disabled])')]; if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
      document.addEventListener('keydown', onKey, true);
      bg.addEventListener('click', (ev) => { if (ev.target === bg || ev.target.closest('[data-cs="cancel"]')) finish(null); });
      form.addEventListener('submit', (ev) => {
        ev.preventDefault(); ev.stopPropagation();   // the page's own form handler must not see this form
        const raw = {}; fields.forEach((fd) => { raw[fd.name] = form.elements[fd.name].value; });
        const v = ConfirmSheet.validate(fields, raw);
        fields.forEach((fd, i) => { const el = bg.querySelector(`#${uid}-f${i}-e`); if (el) el.textContent = v.errors[fd.name] || ''; const inp = form.elements[fd.name]; if (inp) inp.setAttribute('aria-invalid', v.errors[fd.name] ? 'true' : 'false'); });
        if (!v.ok) { const bad = fields.findIndex((fd) => v.errors[fd.name]); form.elements[fields[bad].name].focus(); return; }
        finish(v.values);
      });
      const target = fields.length ? form.elements[fields[0].name] : opts.danger && bg.querySelector('[data-cs="cancel"]') ? bg.querySelector('[data-cs="cancel"]') : bg.querySelector('[data-cs="ok"]');
      if (target) target.focus();
    });
  }
  class Cancelled extends Error { constructor() { super('Cancelled'); this.cancelled = true; } }
  // a yes/no question; true = confirmed
  const confirmSheet = async (title, text, label, danger) => !!(await askSheet({ title, text, confirmLabel: label || 'Confirm', danger }));
  // one required written answer; throws Cancelled when the sheet is cancelled, so nothing is sent
  async function askText(title, label, o = {}) {
    const r = await askSheet({ title, text: o.text, fields: [{ name: 'v', label, type: o.type || 'textarea', required: true, minLength: o.min === undefined ? 5 : o.min, value: o.value, hint: o.hint, options: o.options }], confirmLabel: o.ok || 'Save', danger: o.danger });
    if (!r) throw new Cancelled();
    return r.v;
  }
  // The same request keeps the same idempotency key until it succeeds, so sending it again after a lost reply is recognised by the database (replayed)
  // instead of being done twice. A different request (another balance check, another deposit) is a new key.
  const idemKeys = new Map();
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  async function withStableKey(fn, args, send) {
    const sig = fn + '|' + JSON.stringify(args);
    if (!idemKeys.has(sig)) idemKeys.set(sig, newKey());
    const r = await send(idemKeys.get(sig));
    idemKeys.delete(sig);
    return r;
  }

  // a thin bar across the top while anything is being sent or read (shown after a short moment, so quick reads do not flicker); the form previews do not count
  let inFlight = 0, loadTimer = null;
  const loadbar = (on) => { const el = document.getElementById('loadbar'); if (el) el.hidden = !on; };
  async function rpc(fn, args = {}) {
    const counted = !/^admin_quote_/.test(fn);
    if (counted && ++inFlight === 1) { clearTimeout(loadTimer); loadTimer = setTimeout(() => loadbar(true), 150); }
    try {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    } finally { if (counted && --inFlight <= 0) { inFlight = 0; clearTimeout(loadTimer); loadbar(false); } }
  }
  async function call(fn, args = {}) {
    if (!LEGACY && RETIRED.has(fn)) throw new Error('This screen is retired (' + fn + '). Use Record: Add investor, Cash in, Withdraw or Transfer.');
    try { return await rpc(fn, { p_token: S.token, ...args }); }
    catch (e) { if (/not signed in/.test(e.message)) { signedOut('Please sign in again.'); throw new Error('Signed out'); } throw e; }
  }
  // money writes: one request id per form until it succeeds, so resending after a lost reply is recognised by the database instead of
  // being done twice; and a CONFIRM refusal (a big move, an unmatched Exchange transfer) is asked once and resent with the explicit yes.
  async function moneyCall(fm, fn, args) {
    if (!fm.dataset.idem) fm.dataset.idem = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const send = (extra) => call(fn, { ...args, p_idem: fm.dataset.idem, ...extra });
    let r;
    try { r = await send({}); }
    catch (e) {
      if (!/^CONFIRM: /.test(e.message)) throw e;
      if (!(await confirmSheet('Check this before saving', e.message.replace(/^CONFIRM: /, ''), 'Save it anyway'))) throw new Error('Not saved.');
      r = await send({ p_confirm: true });
    }
    delete fm.dataset.idem;
    return r;
  }
  // A settlement that is late, backdated, not reconciled with the exchange, or made while trades are open is refused by the database. Here the manager can
  // approve an exception: a written reason (at least 20 characters), and the open trades declared. It is written to the activity log and saved on the
  // settlement. `run` makes the settlement call; equity and at are what the exception is bound to (the exchange total and the valuation date).
  async function withSettlementExceptions(run, equity, at) {
    for (let i = 0; i < 5; i++) {
      try { return await run(); }
      catch (e) {
        const m = String(e.message), kind = /^LATE:/.test(m) ? 'late' : /^BACKDATED:/.test(m) ? 'backdated' : /^RECONCILE:/.test(m) ? 'unreconciled' : /^OPEN TRADES: [0-9]/.test(m) ? 'open_positions' : null;
        if (!kind) throw e;
        const needsOpen = kind !== 'late' && kind !== 'backdated';
        const ex = await askSheet({ title: 'Approve an exception?', text: m + '\nAn exception is written to the activity log with your reason, and saved on the settlement.',
          fields: [{ name: 'note', label: 'Why is this exception acceptable?', type: 'textarea', required: true, minLength: 20, hint: 'At least 20 characters.' },
            ...(needsOpen ? [{ name: 'open', label: 'Positions and orders open on the exchange right now (0 if none)', type: 'number', required: true, min: 0, value: kind === 'open_positions' ? '1' : '0' }] : [])],
          confirmLabel: 'Approve exception and continue', danger: true });
        if (!ex) throw new Error('Not settled.');
        const note = ex.note, open = needsOpen ? Number(ex.open) : null;
        await call('admin_approve_settlement_exception', { p_kind: kind, p_equity: equity, p_note: note, p_at: at, p_open: open });
      }
    }
    throw new Error('Not settled: more exceptions would be needed than are possible. Check the figures first.');
  }
  const settleWithExceptions = (fm, args) => withSettlementExceptions(() => moneyCall(fm, 'admin_close_quarter', args), args.p_equity, args.p_at);
  function signedOut(msg) {
    if (S.adminToken) { backToManager('The view-as session ended.'); return; }   // an expired "view as" falls back to the fund manager
    S.token = null; S.me = null; S.modal = null; S.welcome = null; S.welcomeDone = false; S.gate = null; S.termsRO = false; clearTimeout(S.splashT); S.splashT = null; store.set(null); loginView(); if (msg) toast(msg, true);
  }
  async function viewAs(id) {
    const r = await call('admin_view_as', { p_profile: id });
    S.adminToken = S.token; store.set(S.token, ADMIN_KEY);
    S.token = r.token; store.set(r.token); S.range = 'ALL'; S.modal = null; S.tab = null;
    await refresh(`Viewing as ${r.name} (read-only)`);
  }
  async function backToManager(msg) {
    const t = S.token; S.token = S.adminToken; S.adminToken = null; store.set(S.token); store.set(null, ADMIN_KEY);
    try { await rpc('logout', { p_token: t }); } catch { /* already expired */ }
    S.side = 'fund'; S.tab = 'users'; S.modal = null; S.uid = null; await refresh(msg);
    S.tab = 'users'; render();
  }

  // ---------------------------------------------------------------- data
  async function load() {
    S.me = await call('my_summary');
    if (!S.me) { signedOut(); throw new Error('Signed out'); }
    if (S.uid !== S.me.id) { S.uid = S.me.id; S.tab = null; applyHash(); }   // a different person signed in: the page in the address, else their first tab
    const admin = S.me.role === 'admin';   // only the fund manager sees the pool; investors get just their own money
    // Everything below is independent of the rest, so it all goes out at once. It used to run one after another (about nine round trips in a row for the fund manager).
    // A "group" keeps the meaning of the old try/catch: when its call fails (a migration that is not applied yet) its own fields fall back to empty; "Signed out" still stops everything.
    const group = (run, fallback) => run().catch((e) => { if (e.message === 'Signed out') throw e; fallback(); });
    const [pool, hist, history, led, reqs, all, elog, pend] = await Promise.all([admin ? call('pool_summary') : null, admin ? call('price_history') : [], call('my_history'),
      call(admin ? 'admin_ledger' : 'my_ledger'), call(admin ? 'admin_requests' : 'my_requests'),
      admin ? call('admin_overview') : null, admin ? call('admin_equity_log') : null, call(admin ? 'admin_pending' : 'my_pending'),
      loadFx(), admin ? loadReports() : null, admin ? loadLive() : null, loadFund(), admin ? loadAdminExtras() : null,
      group(async () => { const [p, ps] = await Promise.all([admin ? null : call('my_payout'), admin ? call('admin_payouts') : null]); S.payout = p; S.payouts = ps || []; }, () => { S.payout = null; S.payouts = []; }),   // empty until the payout-details migration is run
      group(async () => { const [c, cs] = await Promise.all([call('my_contact'), admin ? call('admin_contacts') : null]); S.contact = c; S.contacts = cs || []; S.contactOn = true; }, () => { S.contact = null; S.contacts = []; S.contactOn = false; }),   // hidden until the contact-details migration is run
      group(async () => { const [p, q, c] = await Promise.all([admin ? null : call('my_position'), admin ? call('admin_capital_queue') : null, admin ? call('admin_balance_checks') : null]); S.pos = p; S.queue = q; S.checks = c; }, () => { S.pos = null; S.queue = null; S.checks = null; }),   // empty until the capital-workflow migration is run
      group(async () => { S.pu = admin ? await call('admin_pool_status') : null; }, () => { S.pu = null; }),   // null until the pool-update migration is run
      group(async () => { S.dpesos = await call(admin ? 'admin_deposit_pesos' : 'my_deposit_pesos'); }, () => { S.dpesos = null; }),   // null until 20261210000000_deposit_pesos.sql is run
      group(async () => { S.exit = await call('exit_fee_info'); }, () => { S.exit = null; }),   // null until the withdrawal-fee migration is run
      group(async () => { const [n, c] = await Promise.all([call(admin ? 'admin_nav' : 'my_nav'), admin ? call('admin_cash_ins') : null]); S.nav = n; S.cashins = c || []; }, () => { S.nav = null; S.cashins = null; }),   // null until 20261213000000_live_nav.sql is run: the older Record screens are shown
      group(async () => { S.settle = admin && !LEGACY ? await call('admin_settlement_status') : null; }, () => { S.settle = null; }),   // null until 20261214000000_auto_settlement.sql is run
      group(async () => { S.tv = await call(admin ? 'admin_true_value' : 'my_true_value'); S.tvPrev = admin ? await call('admin_preview_book_corrections') : null; }, () => { S.tv = null; S.tvPrev = null; })]);   // null until the true-value migration is run   // null until the withdrawal-fee migration is run
    // a deposit is shown as the pesos put in: pesos recorded later for an older deposit are filled in (Contribution.withDepositPesos)
    // with the live NAV the closed trades are booked from MEXC's own results and every flow is priced at the verified reading, so the old "pending P/L, press
    // Update Pool" status no longer applies (it counts exits nobody presses Update Pool for any more): it is not shown
    if (S.nav) S.pu = null;
    S.pool = pool; S.hist = hist; S.history = history; S.ledger = Contribution.withDepositPesos(led, S.dpesos); S.reqs = reqs; S.all = all || []; S.elog = elog || []; S.pend = pend || [];
    await syncFxReference(admin);
  }
  // The PHP/USD reference rate the database checks the ₱500 minimum at (20261208000000_fx_reference_rate.sql). The fund manager's browser stores a fresh live
  // reading (under an hour old; the database validates it and keeps at most one an hour); everyone reads the current one. Never a cash-in rate.
  // Before that migration both calls fail quietly and S.fxDb stays null (the old wording is shown).
  async function syncFxReference(admin) {
    const r = fxRef();
    try {
      if (admin && r && !r.stale && S.fxSent !== r.t) { await call('admin_record_fx_reference', { p_rate: r.rate, p_source: r.src, p_fetched_at: new Date(r.t).toISOString() }); S.fxSent = r.t; }
    } catch (e) { if (e.message === 'Signed out') throw e; }
    try { S.fxDb = await call('fx_reference'); } catch (e) { if (e.message === 'Signed out') throw e; S.fxDb = null; }
  }
  const fxDbRate = () => (S.fxDb && Number(S.fxDb.usd_php) > 0 ? Number(S.fxDb.usd_php) : null);
  // the minimum as the database applies it: ₱500 at the fund's stored reference rate, in USDT
  const minNote = () => (!S.fxDb ? 'checked by the fund when you send a request; taking everything is always allowed'
    : fxDbRate() ? `about ${usdt(S.fxDb.min_withdrawal_usdt)} at the fund's PHP/USD reference rate ₱${f(fxDbRate(), 2)} (${esc(S.fxDb.source)}, ${day(S.fxDb.fetched_at)}); taking everything is always allowed`
    : 'not checked while the fund has no current PHP/USD reference rate; taking everything is always allowed');
  // withdrawal fee: young accounts pay more; the database decides, the app only shows it
  const exitInfo = (id) => (S.exit && (S.exit.people || []).find((x) => x.id === id)) || null;
  // The withdrawal fee is OFF for now (the database returns 0 as well). Set to true when it is switched back on: the previews, the
  // fee rows and the note in "How it works" below all follow this one switch.
  const EXIT_FEE_ON = false;
  const exitRate = (id) => { const x = EXIT_FEE_ON && exitInfo(id); return x ? Number(x.rate) : 0; };
  const FEE_SOON = 'A withdrawal fee will be introduced soon: a small percentage of what you withdraw, lower the longer your account has been open. Plan your withdrawals with this in mind.';
  const exitTurns = (x) => { const d = new Date(x.since); d.setDate(d.getDate() + Number(S.exit.after_days)); return d; };
  const exitNote = (id) => {
    const x = exitInfo(id); if (!x) return '';
    return Number(x.rate) > Number(S.exit.mature_rate) + 1e-9 ?`Account under 1 year old. Drops to ${pc(S.exit.mature_rate)}% on ${day(exitTurns(x).toISOString())}.` : 'Account over 1 year old.';
  };
  const minPhp = () => (S.exit ? Number(S.exit.min_php) : 0);
  // the fund's live capital (the bots' 5-minute MEXC wallet reports, every live account added together) from /api/fund-live; fund manager only. null when it cannot
  // be reached (a plain-file copy of the app, no reports yet): the Fund dashboard then shows the booked pool value as before. A failed read keeps the last figures.
  async function loadLive() {
    try {
      const r = await fetch('/api/fund-live', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: S.adminToken || S.token }) });
      if (r.ok) S.live = await r.json();
    } catch { /* keep the last figures; none yet = the booked pool value is shown */ }
  }
  async function loadFund() { try { S.fund = (await rpc('fund_returns', { p_token: S.token })) || []; } catch { S.fund = []; } }
  // reports/index.json: a small registry of compiled HTML reports (see reports/README or the folder itself to add one).
  // Plain static files, not database rows — missing or unreadable just means an empty Reports tab, never a hard error.
  async function loadReports() {
    try { const r = await fetch('reports/index.json', { cache: 'no-store' }); S.reports = r.ok ? await r.json() : []; }
    catch { S.reports = []; }
  }
  // live USD -> PHP (USDT trades ~1:1 with USD). Two independent sources, cached for an hour; a cached reading up to 12 hours old is used (marked as such)
  // when both fail. Never a rate stored on a deposit or a pool entry: with no usable reading the rate is unavailable and figures stay in USDT (js/contribution.js).
  const FX_KEY = 'ledger.fx', FX_SRC = [['https://open.er-api.com/v6/latest/USD', 'open.er-api.com'], ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP', 'frankfurter.dev']];
  async function loadFx() {
    let cached = null; try { cached = JSON.parse(localStorage.getItem(FX_KEY) || 'null'); } catch { /* none */ }
    const c = Contribution.referenceRate(cached);
    if (c && !c.stale) { S.fx = cached; return; }
    for (const [url, name] of FX_SRC) {
      try {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4000);
        const v = Contribution.parseFx(await (await fetch(url, { signal: ctl.signal })).json()); clearTimeout(to);
        if (v) { S.fx = { rate: v, t: Date.now(), src: name }; try { localStorage.setItem(FX_KEY, JSON.stringify(S.fx)); } catch { /* not cached */ } return; }
      } catch { /* try the next source */ }
    }
    S.fx = c ? cached : null;   // a recent reading beats nothing; an old or broken one is not used
  }
  const fxRef = () => Contribution.referenceRate(S.fx);
  const rate = () => { const r = fxRef(); return r ? r.rate : null; };
  const rateNote = () => { const r = fxRef(); return r ? `1 USDT ≈ ${php(r.rate)} (${r.stale ? 'last loaded' : 'live'} ${r.src}, ${clock12(new Date(r.t))})` : 'Peso rate unavailable'; };
  // what an investor still has to add before a withdrawal: a red dot on the menu button and on the item that is missing
  const missing = () => { const m = S.me; return m && m.role === 'investor' ? { contact: !!S.contactOn && !S.contact, payout: !S.payout } : { contact: false, payout: false }; };
  const RDOT = '<span class="rdot" aria-hidden="true"></span>';
  const settingsMenu = (account = false, viewOnly = false) => {
    const p = themePref(), tl = p === 'system' ? 'System' : p === 'light' ? 'Light' : 'Dark', need = missing(), any = need.contact || need.payout;
    return `<details class="settings"><summary class="iconbtn" aria-label="Menu${any ? ': details still missing' : ''}" title="Menu">${ICON.menu}${any ? RDOT : ''}</summary><div class="menu">
      ${account || viewOnly ? `<button data-action="profile">${ICON.user}<span>Profile</span></button>
      ${S.contactOn ? `<button data-action="contact">${ICON.phone}<span>How to reach me</span>${need.contact ? RDOT : ''}</button>` : ''}
      ${S.me.role === 'investor' ? `<button data-action="payout">${ICON.wallet}<span>Where to send my money</span>${need.payout ? RDOT : ''}</button>` : ''}
      <div class="sep" role="separator"></div>` : ''}
      <button data-action="refresh">${ICON.refresh}<span>Refresh</span></button>
      <button data-action="theme">${ICON[p === 'light' ? 'sun' : p === 'dark' ? 'moon' : 'auto']}<span>Theme</span><span class="val">${tl}</span></button>
      ${rate() ? `<button data-action="cur"><span style="width:18px;text-align:center;font-weight:800">${inPeso() ? '₱' : '$'}</span><span>Currency</span><span class="val">${inPeso() ? 'Peso' : 'USD'}</span></button>` : ''}
      ${account ? `<button data-action="welcome">${ICON.tour}<span>Welcome tour</span></button>${isAdmin() ? `<button data-action="botdash">${ICON.bot}<span>Bot dashboard</span></button>` : ''}<button class="danger" data-action="signout">${ICON.signout}<span>Sign out</span></button>` : ''}</div></details>`;
  };
  const curBtn = () =>(rate() ? `<button class="iconbtn txt" data-action="cur" aria-label="Showing ${inPeso() ? 'pesos' : 'USDT'}. Tap to switch" title="${rateNote()}">${inPeso() ? '₱' : '$'}</button>` : '');

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
  // donut chart of [name, units, color] slices, with a legend beside it showing the share and the value of each slice
  function donut(seg, tot) {
    const R = 42, C = 2 * Math.PI * R, gap = seg.filter(([, u]) => Number(u) > 0).length > 1 ? 1.2 : 0;
    let off = 0;
    const arcs = seg.map(([n, u, c]) => {
      const len = (Number(u) / tot) * C; if (!(len > 0)) return '';
      const d = Math.max(0, len - gap), el = `<circle class="arc" r="${R}" cx="60" cy="60" fill="none" stroke-width="16" stroke-linecap="butt" style="stroke:${c}" stroke-dasharray="${d.toFixed(2)} ${(C - d).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${n}</title></circle>`;
      off += len; return el;
    }).join('');
    const price = Number(S.pool.unit_price);
    return `<div class="donutwrap"><svg class="donut" viewBox="0 0 120 120" role="img" aria-label="Who owns the pool">
        <circle r="${R}" cx="60" cy="60" fill="none" stroke-width="16" style="stroke:var(--variant)"/>
        <g transform="rotate(-90 60 60)">${arcs}</g>
        <text x="60" y="57" text-anchor="middle" class="dk">Units</text><text x="60" y="73" text-anchor="middle" class="dv">${f(tot, 2)}</text></svg>
      <div class="dleg">${seg.map(([n, u, c]) => `<div><b style="background:${c}"></b><span class="dn">${n}</span><span class="dp">${f((Number(u) / tot) * 100, 1)}%<small>${money(Number(u) * price)}</small></span></div>`).join('')}</div></div>`;
  }
  // ---------------------------------------------------------------- manager dashboard (the pool is for the fund manager's eyes only)
  function viewDashboard() {
    const p = S.pool, tot = Number(p.total_units) || 1, inv = S.all.filter((h) => h.role === 'investor');
    const sum = (a, k) => a.reduce((t, h) => t + Number(h[k]), 0);
    const invValue = sum(inv, 'value_usdt'), due = sum(inv, 'accrued_fee_usdt');
    const pend = S.reqs.filter((q) => q.status === 'pending'), pendUsdt = pend.reduce((t, q) => t + Number(q.units) * Number(p.unit_price), 0);
    const seg = [['Investors', p.investor_units, 'var(--seg2)'], ['Fund manager capital', p.admin_capital_units, 'var(--seg1)'], ["Fees earned", p.admin_fee_units, 'var(--seg3)']];
    const pb = PU.banner(S.pu);
    const live = liveCard(p);
    return `${pb ? `<div class="card" data-pool="banner"><p class="warn"><b>Pending P/L: ${esc(pb)}</b></p><p class="note">Nobody can join or be paid out until you click Update Pool (Record → Balance).</p><div class="btns"><button data-tab="record" data-rec="eq">Go to Update Pool</button></div></div>` : ''}${live || `<div class="card hero"><h2>Total Fund</h2>
        <div class="big">${money(p.equity_usdt)}</div><div class="sub">${alt(p.equity_usdt)}</div>
        <div class="delta ${cls(p.since_start_pct)}">${pct(p.since_start_pct)} since start</div>
        <p class="note" style="margin:8px 0 0">Last updated ${p.asof ? day(p.asof) : '—'} · unit price ${f(p.unit_price, 4)}${fundStart() ? ' · fund started ' + day(fundStart()) : ''}</p>${lastClose()}</div>`}
      ${S.nav ? `<div class="card" data-navline><p style="margin:0">${Desk.navLine({ ...S.nav, live: true, ts: S.nav.latest_verified && S.nav.latest_verified.ts })}</p><div class="btns"><button class="ghost sm" data-tab="record" data-rec="nav">Live NAV and reconciliation</button></div></div>` : ''}
      <div class="card"><h2>${live ? 'Unit price' : 'Fund performance'}</h2>${chart(S.hist)}${live ? `<p class="note" style="margin:8px 0 0">${S.nav ? 'The unit price follows the verified MEXC wallet reports (open trades included), one point an hour.' : 'The booked unit price: it moves only when the pool is valued (Update Pool), not every 5 minutes.'}</p>` : ''}</div>
      ${TVUI.adminCard(S.tv, S.tvPrev)}
      <div class="card"><div class="grid">
        <div class="stat"><div class="k">Investors</div><div class="v">${p.investor_count}</div></div>
        <div class="stat"><div class="k">Investors' money</div><div class="v">${money(invValue)}</div></div>
        ${putTile(invPutInOf(inv), 'Put in by investors')}
        <div class="stat"><div class="k">Their fee due</div><div class="v">${money(due)}</div></div></div>
        ${S.pend.length ? `<div class="btns"><button class="ghost" data-tab="record" data-rec="dep">${S.pend.length} deposit${S.pend.length === 1 ? '' : 's'} waiting to join · ${money(pendTotal())}</button></div>` : ''}
        ${pend.length ? `<div class="btns"><button class="ghost" data-tab="log">${pend.length} withdrawal request${pend.length === 1 ? '' : 's'} · ${money(pendUsdt)}</button></div>` : '<p class="note" style="margin:12px 0 0">No withdrawal requests waiting.</p>'}</div>
      <div class="card"><h2>Who owns the pool</h2>
        ${donut(seg, tot)}
        <p class="note" style="margin-top:8px">The fee comes only from profits and stays invested in the pool. Investors cannot see any of this page.</p></div>
      <p class="disc">${rateNote()}</p>`;
  }
  const KIND = {
    deposit: ['Deposit', 'in', 'arrowIn'], withdrawal: ['Withdrawal', 'out', 'arrowOut'],
    fee_out: ['Fee paid', 'share', 'share'], fee_in: ['Fee received', 'in', 'share'],
  };
  function activityRows(rows, withName) {
    if (!withName && S.me && S.me.role === 'investor') rows = rows.filter((l) => l.kind !== 'fee_out');   // investors never see fee lines: it is already taken out of their balance
    if (!withName) rows = Contribution.foldTopups(rows);   // the person's own list: a peso top-up shows inside the deposit it tops up
    // ... and on the fund manager's own list, the units passed on as that top-up are part of how a cash-in was split (each deposit shows its pesos and the USDT they
    // bought), so they are not listed as a transaction; the full Log (withName) keeps the row
    if (!withName) rows = rows.filter((l) => !(l.kind === 'withdrawal' && /^peso top-up/i.test(l.note || '')));
    if (!rows.length) return '<p class="note">Nothing yet.</p>';
    return rows.map((l) => {
      const passed = l.kind === 'withdrawal' && /^peso top-up/i.test(l.note || '');   // the manager's units passed on as an investor's peso top-up: part of a cash-in's split, not a payout
      const [label0, kind, ic] = KIND[l.kind] || [l.kind, '', 'share'], label = passed ? 'Passed to investor' : label0;
      // the manager's notes are internal working notes (sources, transfer times): an investor sees the date only
      const investorView = !withName && S.me && S.me.role === 'investor';
      const sub = [day(l.ts), withName ? esc(l.name) : null, l.note && !investorView ? esc(l.note) : null].filter(Boolean).join(' · ');
      // a deposit is shown as the pesos put in (₱10,000), never converted; pesos recorded later for an older deposit count the same (Contribution.withDepositPesos)
      const paid = l.kind === 'deposit' && Number(l.php_amount) > 0;
      // money moved in USDT (no pesos recorded) stays in USDT, so it never reads as pesos paid or received; today's pesos are an estimate beside it
      const cash = !paid && (l.kind === 'deposit' || l.kind === 'withdrawal');
      const main = paid ? `+${php(Number(l.php_amount))}` : cash ? (Number(l.usdt) < 0 ? '−' : '+') + usdt(Math.abs(l.usdt)) : smoney(l.usdt);
      const small = withName ? sgn(l.units, 2) + ' units'
        : paid ? (l.usdt_bought != null ? `= ${f(l.usdt_bought, 4)} USDT` : '')   // "+₱5,000" and, when recorded, the USDT those pesos bought: no conversion at today's rate
        : cash ? (rate() ? `≈ ${php(Math.abs(l.usdt) * rate())} today` : '') : alt(Math.abs(l.usdt));
      return `<div class="tx"><div class="ic ${kind}">${ICON[ic]}</div>
        <div class="mid"><div class="t1">${label}</div><div class="t2">${sub}</div></div>
        <div class="amt ${l.kind === 'fee_out' ? 'share' : cls(l.usdt)}">${main}<small>${small}</small></div></div>`;
    }).join('');
  }
  const passwordCard = () => `<div class="card"><h2>Change your password</h2>
    <form id="pwForm"><label>Current password</label>${pw('old', 'current-password')}
    <label>New password (at least 8 characters)</label>${pw('new', 'new-password', 8)}
    <button class="full ghost">Change password</button></form>
    <p class="note">Your other phones/browsers will be signed out.</p></div>`;
  const DISC = `<p class="disc">This is a record of your share of a pooled trading account, counted in USDT and shown in pesos at today's exchange rate when that rate is available. The balance grows or shrinks with the trading results. It is not a bank balance and is not insured. You can still lose money.</p>`;

  // ---------------------------------------------------------------- where each person wants to be paid (the QR image lives in Supabase Storage)
  // How someone is paid is free text they type (for example GCash, Bank transfer, GoTyme, Maya). Older saved rows hold 'gcash' or 'bank'.
  const payLabel = (m) => ({ gcash: 'GCash', bank: 'Bank transfer' }[m] || m || '');
  const payUrl = (path) => sb.storage.from('payout-qr').getPublicUrl(path).data.publicUrl;
  const payOf = (id) => (S.payouts || []).find((d) => d.profile_id === id) || null;
  // read-only view of someone's receiving details (fund manager side)
  function payoutBlock(d) {
    if (!d) return '<p class="note warn">No payout details on file for this person yet.</p>';
    return `<div class="payblock"><div class="row"><span class="l">Send via</span><span class="r">${esc(payLabel(d.method))}${d.bank_name ? ' · ' + esc(d.bank_name) : ''}</span></div>
      <div class="row"><span class="l">Account name</span><span class="r">${esc(d.account_name)}</span></div>
      <div class="row"><span class="l">Mobile or account number</span><span class="r">${esc(d.account_number)}</span></div>
      ${d.qr_path ? `<a href="${payUrl(d.qr_path)}" target="_blank" rel="noopener"><img class="payqr" src="${payUrl(d.qr_path)}" alt="Receiving QR code" loading="lazy"></a>` : '<p class="note">No QR image uploaded.</p>'}</div>`;
  }
  // one line for lists: where this person is paid, or a warning when nothing is on file (the manager needs it the moment a withdrawal comes in)
  const payLine = (pid) => { const d = payOf(pid); return d ? `Withdraws to ${esc(payLabel(d.method))} · ${esc(d.account_name)} · ${esc(d.account_number)}` : '<span class="warn">No withdrawal details on file</span>'; };
  async function uploadQr(file, current) {
    if (!file) return current || null;
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type];
    if (!ext) throw new Error('The QR must be a PNG, JPG or WebP picture.');
    if (file.size > 2 * 1024 * 1024) throw new Error('That picture is over 2 MB. Choose a smaller screenshot.');
    const path = `${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from('payout-qr').upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) throw new Error('Could not upload the QR: ' + up.error.message);
    return path;
  }
  const contactOf = (id) => (S.contacts || []).find((c) => c.profile_id === id) || null;
  const contactMissing = (id) => !!S.contactOn && !!contactOf(id) && contactOf(id).missing;
  // read-only view of how to reach someone (fund manager side)
  function contactBlock(c) {
    if (!c || c.missing) return '<p class="note warn">No contact details on file for this person yet.</p>';
    const row = (l, v) => `<div class="row"><span class="l">${l}</span><span class="r">${v}</span></div>`;
    return `<div class="payblock">${row('Phone', `<a href="tel:${esc(String(c.phone).replace(/[^+0-9]/g, ''))}">${esc(c.phone)}</a>`)}
      ${row('Email', c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="note">none</span>')}
      ${c.emergency_name ? row('Emergency contact', `${esc(c.emergency_name)}<br><a href="tel:${esc(String(c.emergency_phone).replace(/[^+0-9]/g, ''))}">${esc(c.emergency_phone)}</a>`) : row('Emergency contact', '<span class="note">none</span>')}
      ${c.updated_at ? `<p class="note" style="margin:6px 0 0">Last updated ${day(c.updated_at)}</p>` : ''}</div>`;
  }
  function contactCard(m) {
    if (!S.contactOn) return '';
    const d = S.contact, head = `<div class="card"><h2>How to reach me</h2>`;
    return `${head}<p class="note" style="margin-top:0">${m.role === 'admin' ? 'Your own phone and email on file.' : d ? 'Used only to contact you about your account.' : '<b class="warn">Please add this.</b> If anything happens with your account or a withdrawal, this is how the fund manager reaches you.'}</p>
      <form id="contactForm"><label>Phone number</label><input name="phone" type="tel" value="${esc((d && d.phone) || '')}" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567" required>
        <label>Email (optional)</label><input name="email" type="email" value="${esc((d && d.email) || '')}" autocomplete="email" placeholder="you@example.com">
        <label>Someone we can call if we cannot reach you (optional)</label>
        <div class="grid form2"><div><input name="en" value="${esc((d && d.emergency_name) || '')}" placeholder="Name" autocomplete="off"></div>
          <div><input name="ep" type="tel" value="${esc((d && d.emergency_phone) || '')}" inputmode="tel" placeholder="Their number" autocomplete="off"></div></div>
        <button class="full">${d ? 'Update contact details' : 'Save contact details'}</button></form></div>`;
  }
  function payoutCard(m) {
    const d = S.payout;
    const head = `<div class="card"><h2>Where to send my money</h2>`;
    return `${head}<p class="note" style="margin-top:0">${d ? 'Your withdrawals are sent here.' : 'Add this before you request a withdrawal.'} We will contact you to confirm these details before any money is sent.</p>
      <form id="payoutForm"><label>Label</label>
        <input name="method" value="${esc(payLabel(d && d.method))}" maxlength="40" autocomplete="off" placeholder="e.g. GCash" required>
        <p class="note" style="margin:4px 0 0">Examples: GCash, Bank transfer, GoTyme, Maya. If it is a bank, add its name, like "BDO bank transfer".</p>
        <label>Account name</label><input name="pname" value="${esc((d && d.account_name) || '')}" autocomplete="off" placeholder="The name on the account" required>
        <label>Mobile number or bank account number</label><input name="pnum" value="${esc((d && d.account_number) || '')}" inputmode="numeric" autocomplete="off" placeholder="e.g. 0917 123 4567" required>
        <p class="note" style="margin:4px 0 0">This is where we send your money, so please double-check the number.</p>
        <label>QR code (optional, but it makes sending faster)</label>
        <p class="note" style="margin:0 0 6px">Attach a screenshot of your GCash, Maya, GoTyme, InstaPay or QR Ph code. We can scan it to send your money straight to you.</p>
        ${d && d.qr_path ? `<img class="payqr" src="${payUrl(d.qr_path)}" alt="Your saved QR code"><p class="note" style="margin:0">Saved. Choose a new picture only if you want to replace it.</p>` : ''}
        <input name="qr" type="file" accept="image/png,image/jpeg,image/webp">
        <button class="full">${d ? 'Update details' : 'Save details'}</button></form></div>`;
  }
  // ---------------------------------------------------------------- Profile, How to reach me, Where to send my money (the menu, top right)
  // Pages outside the tab bar, each with a Back button. A red dot on the menu marks what an investor still has to add before a withdrawal.
  const PAGES = ['profile', 'contact', 'payout'];
  const pageHead = (title) => `<div class="sechead"><h2>${title}</h2><button class="sm ghost" data-tab="${tabsFor()[0][0]}">Back</button></div>`;
  const viewContact = () => `${pageHead('How to reach me')}${contactCard(S.me) || '<div class="card"><p class="note">Not available on this database yet.</p></div>'}`;
  const viewPayout = () => `${pageHead('Where to send my money')}${S.me.role === 'investor' ? payoutCard(S.me) : '<div class="card"><p class="note">Only investors are paid out.</p></div>'}`;
  function viewProfile() {
    const m = S.me, investor = m.role === 'investor', home = tabsFor()[0][0];
    const started = startOf(m.id) ?? (S.history && S.history[0] ? new Date(S.history[0].ts).getTime() : null);
    if (m.impersonated) return `<div class="sechead"><h2>Profile</h2><button class="sm ghost" data-tab="${home}">Back</button></div>
      <div class="card"><h2>Account</h2><div class="row"><span class="l">Username</span><span class="r">@${esc(m.username)}</span></div>
        <div class="row"><span class="l">Started</span><span class="r">${startedText(started)}</span></div>
        <form id="nameForm" style="margin-top:12px"><label>Name</label><input name="name" value="${esc(m.name || '')}" maxlength="80" autocomplete="name" required>
          <button class="full ghost">Save name</button></form>
        <p class="note">You are acting as them. Their password and username are changed from Users, on their sheet.</p></div>
      ${contactCard(m)}${investor ? payoutCard(m) : ''}`;
    return `<div class="sechead"><h2>Profile</h2><button class="sm ghost" data-tab="${home}">Back</button></div>
      <div class="card"><h2>Your account</h2>
        <div class="row"><span class="l">Name</span><span class="r">${esc(m.name || '')}</span></div>
        <div class="row"><span class="l">Username</span><span class="r">@${esc(m.username)}</span></div>
        <div class="row"><span class="l">Role</span><span class="r">${investor ? 'Investor' : 'Fund manager'}</span></div>
        <div class="row"><span class="l">Started</span><span class="r">${startedText(started)}</span></div>
        <form id="nameForm" style="margin-top:12px"><label>Name</label><input name="name" value="${esc(m.name || '')}" maxlength="80" autocomplete="name" required>
          <button class="full ghost">Save name</button></form>
        <form id="usernameForm" style="margin-top:12px"><label>New username</label>
          <input name="username" placeholder="${esc(m.username)}" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\-]{3,30}" title="3 to 30 letters, numbers, dot, dash or underscore" required>
          <label>Current password (to confirm)</label>${pw('pw', 'current-password')}
          <button class="full ghost">Change username</button></form>
        <p class="note">You sign in with your username: 3 to 30 letters, numbers, dot, dash or underscore. ${investor ? 'Tell the fund manager if you change it.' : ''}</p></div>
      ${contactCard(m)}${investor ? payoutCard(m) : ''}${passwordCard()}`;
  }

  // ---------------------------------------------------------------- investor / shared views
  // Home: the balance and its chart, the key figures at a glance, the money's journey (pesos paid -> USDT that arrived -> worth now), open requests and the
  // latest entries. Withdrawals have their own tab; profile, contact and payout details are in the menu (top right); "how it works" is the About tab.
  function viewHome() {
    const m = S.me, investor = m.role === 'investor', fm = { money, day };
    if (!investor) return `${growthCard('Your holdings')}<div class="card"><h2>Fee earned</h2>
        <div class="row"><span class="l">Stays invested in the pool</span><span class="r">${money(m.fee_units_value_usdt)}<br><span class="note">${f(m.fee_units_earned, 4)} units</span></span></div></div>${recentCard()}${DISC}`;
    const mine = S.pend.filter((d) => !d.profile_id || d.profile_id === m.id);
    const waiting = mine.length ? `<div class="card"><h2>Waiting to join the pool</h2>
      ${mine.map((d) => `<div class="row"><span class="l">Received ${day(d.received_at)}</span><span class="r">${d.php_amount ? php(d.php_amount) : money(d.usdt)}<br><span class="note">${usdt(d.usdt)}</span></span></div>`).join('')}
      <p class="note">New money joins at the next valuation, at that day's price. Until then it is set aside: it does not share in gains or losses made before it was in.</p></div>` : '';
    const pos = S.pos;
    return `${waiting}${pos && !pos.estimate.reliable ? Position.estimateCard(pos, fm) : ''}${growthCard('Your balance')}${glanceCard(m)}
      ${pos ? Position.requestsCard(pos, fm) : ''}${pos && (pos.settlements || []).length ? Position.settlementsCard(pos, fm) : ''}${recentCard()}${DISC}`;
  }
  // the investor's calendar: each day's gain or loss on their balance from the trading (Returns.daily: units held × the unit price's change, Philippine days),
  // one month at a time. Money in or out (deposits, withdrawals, peso top-ups) never shows as a result.
  function calendarCard() {
    const D = Returns.daily(S.history), now = Date.now(), cur = new Date(now + 8 * 36e5);
    const first = startOf(S.me.id), firstKey = first == null ? null : Returns.dayKey(first), today = Returns.dayKey(now);
    const firstM = firstKey ? (Number(firstKey.slice(0, 4)) - cur.getUTCFullYear()) * 12 + Number(firstKey.slice(5, 7)) - 1 - cur.getUTCMonth() : 0;
    const off = Math.min(0, Math.max(firstM, S.calM || 0)), base = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + off, 1));
    const y = base.getUTCFullYear(), mo = base.getUTCMonth(), days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const key = (d) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cv = (v) => { const a = Math.abs(inPeso() ? v * rate() : v); return (v > 0 ? '+' : '−') + (inPeso() ? '₱' + f(a, a >= 100 ? 0 : 2) : f(a, 2)); };
    let tot = 0, g = 1, n = 0;
    const cells = Array.from({ length: base.getUTCDay() }, () => '<div class="cd pad"></div>');
    for (let d = 1; d <= days; d++) {
      const k = key(d), r = D[k];
      if (r) { tot += r.pnl; g *= 1 + r.pct; n++; }
      cells.push(`<div class="cd ${r ? cls(r.pnl) : ''}${k === today ? ' today' : ''}${k > today || (firstKey && k < firstKey) ? ' off' : ''}"${r ? ` title="${day(k)}: ${smoney(r.pnl)} (${pct(r.pct)})"` : ''}><span class="dn">${d}</span>${r ? `<span class="dv">${cv(r.pnl)}</span>` : ''}</div>`);
    }
    const label = base.toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `<div class="card" data-calendar><div class="calhead"><button class="iconbtn" data-action="calmonth" data-id="-1" ${off <= firstM ? 'disabled' : ''} aria-label="Previous month">‹</button>
      <h2>${label}</h2><button class="iconbtn" data-action="calmonth" data-id="1" ${off >= 0 ? 'disabled' : ''} aria-label="Next month">›</button></div>
      <div class="caltot">${n ? `This month <b class="${cls(tot)}">${smoney(tot)}</b> <span class="${cls(tot)}">(${pct(g - 1)})</span>` : '<span class="note">No results this month yet</span>'}</div>
      <div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<div class="cw">${w}</div>`).join('')}${cells.join('')}</div>
      <p class="note">Each day shows what the trading did to your balance. Money you put in or take out is not counted.</p></div>`;
  }
  // the key figures in one look: worth if every trade closed now, the result so far, what is in cash vs in open trades, and what is free to withdraw
  function glanceCard(m) {
    const tv = S.tv && S.tv.enabled && S.tv.value_usdt != null ? S.tv : null, cap = S.pos && S.pos.capital, price = Number(m.unit_price);   // true-value figures only when there are some
    const total = tv ? Number(tv.value_usdt) : Number(m.value_usdt), cash = tv ? Number(tv.withdrawable_now_usdt) : total, open = tv ? Number(tv.locked_in_trades_usdt) : 0;
    const res = cap ? Number(cap.net_performance_usdt) : Number(m.profit_usdt), put = cap ? Number(cap.contributed_usdt) : Number(m.net_in_usdt);
    const free = Number(m.unlocked_units) * price, pc0 = total > 0 ? Math.max(0, Math.min(100, (cash / total) * 100)) : 100;
    const tile = (k, v, s, c = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    return `<div class="card" data-glance><h2>At a glance</h2>
      ${putInCards(putInOf(m))}
      <div class="grid">
        ${tile(tv ? 'If every trade closed now' : 'Worth now', money(total), alt(total))}
        ${tile('Result so far', smoney(res), put > 0 ? `${pct(res / put, 2)} on what you put in · after fees` : 'after fees', cls(res))}
        ${tv ? tile('In cash', money(cash), alt(cash)) + tile('In open trades', money(open), 'becomes cash as the trades close') : ''}
      </div>
      ${tv ? `<div class="split" style="margin-top:12px" role="img" aria-label="${f(pc0, 0)}% in cash, ${f(100 - pc0, 0)}% in open trades"><i style="width:${pc0.toFixed(1)}%;background:var(--accent)"></i><i style="width:${(100 - pc0).toFixed(1)}%;background:var(--info)"></i></div>
        <div class="legend"><span><b style="background:var(--accent)"></b>In cash ${f(pc0, 0)}%</span><span><b style="background:var(--info)"></b>In open trades ${f(100 - pc0, 0)}%</span></div>` : ''}
      <div class="row"><span class="l">Free to withdraw now<br><span class="note">${m.next_unlock ? `your first deposit is locked until ${day(m.next_unlock)}` : 'no lock-up'}</span></span><span class="r"><b>${money(free)}</b><br><span class="note">${alt(free)}</span></span></div>
      ${tv ? `<p class="note">${esc(TVUI.state(tv).text)}</p>` : ''}
      <div class="btns"><button data-tab="withdraw">Withdraw</button><button class="ghost" data-tab="statements">Statements</button></div></div>`;
  }
  // Withdraw: what can be requested now, the rules as tiles, the request form (in USDT) and the pending requests
  function viewWithdraw() {
    const m = S.me, price = Number(m.unit_price), xr = exitRate(m.id), pend = S.reqs.filter((q) => q.status === 'pending' && q.profile_id === m.id);
    const avail = Number(m.unlocked_units) * price;
    const tile = (k, v, s) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    const form = m.impersonated ? '<p class="note">Read-only view: only the person can request a withdrawal.</p>'
      : !S.payout ? `<p class="note"><b class="warn">Add where to send your money first.</b> We need it before any withdrawal.</p><div class="btns"><button data-action="payout">Add payout details</button></div>`
      : `<form id="reqForm"><label for="rq-u">Amount to withdraw (USDT)</label>
          <input id="rq-u" name="amount" type="number" step="any" min="0" inputmode="decimal" required>
          <div class="preview" id="reqPrev">—</div>
          <div class="btns"><button type="button" class="ghost" data-action="maxunits">Everything available</button><button>Request withdrawal</button></div></form>`;
    return `<div class="card hero"><h2>Withdraw</h2>
        <div class="big">${money(avail)}</div><div class="sub">${alt(avail) || 'can be requested now'}${alt(avail) ? ' · can be requested now' : ''}</div>
        ${m.next_unlock ? `<p class="note" style="margin:6px 0 0">Your first deposit is locked until <b>${day(m.next_unlock)}</b>. If you need money earlier, ask the fund manager.</p>` : ''}
        <div style="margin-top:12px">${form}</div></div>
      ${pend.length ? `<div class="card"><h2>Pending requests</h2>${pend.map((q) => `<div class="row"><span class="l">${day(q.requested_at)} · about ${money(q.units * price)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span><span class="r"><button class="ghost" data-action="cancelreq" data-id="${q.id}">Cancel</button></span></div>`).join('')}</div>` : ''}
      <div class="card"><h2>How withdrawals work</h2><div class="grid">
        ${tile('Minimum', minPhp() ? php(minPhp()) : 'None', minPhp() ? (fxDbRate() ? `about ${usdt(S.fxDb.min_withdrawal_usdt)}` : S.fxDb ? 'not checked right now' : '') : '')}
        ${tile('Lock-up', m.next_unlock ? `until ${day(m.next_unlock)}` : 'None', 'first deposit only; top-ups have none')}
        ${tile('Paid within', `${C.WITHDRAW_BUSINESS_DAYS} business days`, 'at the value on the payout day')}
        ${tile('Withdrawal fee', xr ? pc(xr) + '%' : 'None for now', xr ? exitNote(m.id) : 'coming soon')}
      </div>
      ${minPhp() ? `<p class="note">Minimum: ${minNote()}.</p>` : ''}
      <p class="note">${xr ? `The withdrawal fee (${pc(xr)}%) comes off the payout. ` : `<b>Heads up:</b> ${FEE_SOON} `}You will be contacted to confirm your payout details before any money is sent.</p></div>${DISC}`;
  }
  function recentCard() {
    const mine = Contribution.foldTopups(S.ledger.filter((l) => l.profile_id === S.me.id));   // a top-up shows inside its peso deposit
    return `<div class="card"><h2>Recent transactions</h2>${activityRows(mine.slice(0, 5), false)}
      ${mine.length > 5 ? `<div class="btns"><button class="ghost" data-tab="${isAdmin() ? 'log' : 'activity'}">See all ${mine.length}</button></div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- growth chart (Robinhood-style: drag across it to see any day)
  const RANGES = [['1D', 1, 'Past day'], ['1W', 7, 'Past week'], ['1M', 30, 'Past month'], ['3M', 91, 'Past 3 months'], ['YTD', 'ytd', 'This year'], ['1Y', 365, 'Past year'], ['ALL', null, 'All time']];
  // an investor's history with the latest point after the fee owed so far, so the balance and % are what is theirs
  function netHistory() {
    const H = (S.history || []).map((p) => ({ ...p })), acc = S.me && S.me.role === 'investor' ? Number(S.me.accrued_fee_usdt) || 0 : 0;
    if (acc > 0 && H.length) H[H.length - 1].value = Number(H[H.length - 1].value) - acc;
    return H;
  }
  // when a person started = the date of their first deposit (js/returns.js firstDeposit); the fund started with the first pool reading
  const startOf = (pid) => Returns.firstDeposit(S.ledger, pid);
  const startedText = (ms) => (ms == null ? 'No deposit yet' : `${day(ms)} · ${Math.max(0, Math.floor((Date.now() - ms) / 864e5))} days ago`);
  const fundStart = () => { const h = S.hist && S.hist[0]; return h && h.ts ? new Date(h.ts).getTime() : null; };
  const rangeStart = () => { const r = RANGES.find((x) => x[0] === S.range)[1]; return r == null ? -Infinity : r === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) : Date.now() - r * 864e5; };
  function series() {
    const H = netHistory().map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value), n: Number(p.net_in) }));
    if (!H.length) return [];
    const now = Date.now(), start = rangeStart();
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
      <div class="note" id="gs" style="margin:2px 0 0">Started ${startedText(startOf(m.id) ?? new Date(netHistory()[0].ts).getTime())}</div>
      <div class="gwrap"><svg id="gc" class="growth" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Your balance over time">
        ${area('gfill', pts.map((p) => X(p.t)), pts.map((p) => Y(p.v)), W, H, color, dashed)}
        <line id="gx" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--muted)" stroke-opacity=".6" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
      </svg><span class="dot live" id="gdot"></span></div>
      <div class="ranges">${RANGES.map(([k]) => `<button class="${k === S.range ? 'on' : ''}" data-range="${k}">${k}</button>`).join('')}</div>
      <p class="note" style="margin:8px 0 0">Line: what your money is worth. Dashed: what you have put in. Drag across the chart to see any day.</p>${S.nav && S.nav.live ? `<p style="margin:4px 0 0">${Desk.navLine(S.nav)}</p>` : ''}
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
  // ---------------------------------------------------------------- the fund, live (js/livefund.js): the same 5-minute MEXC wallet reports as the bot dashboard's
  // "Live capital" chart. The big number is what every live trading account holds now; the booked pool value (what units are priced at) stays on the card below it.
  const LF = LiveFund;
  const sinceTxt = (ms) => { const m = (Date.now() - ms) / 60000; return m < 1 ? 'just now' : m < 90 ? Math.round(m) + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
  const lfAxis = (v, signed) => (signed && v ? (v > 0 ? '+' : '−') : '') + (inPeso() ? '₱' + Math.round(Math.abs(v) * rate()).toLocaleString('en-PH') : '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const lfWhen = (ms, short) => (short ? new Date(ms).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) : new Date(ms).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }));
  function liveCard(p) {
    const L = S.live, wc = L && L.wallet_capital, v = wc && wc.usd != null ? LF.view(L, S.lrange, S.lkind) : null;
    if (!v) { S.lchart = null; return ''; }
    const g = LF.svg(v, { axis: (n) => lfAxis(n, v.kind === 'trading'), when: lfWhen });
    S.lchart = { v, g };
    const rl = v.range[2], since = v.range[1] && v.firstTs > Date.now() - v.range[1] * 864e5 ? ` · reports start ${day(new Date(v.firstTs).toISOString())}` : '';
    const note = v.kind === 'capital'
      ? `<b class="${cls(v.change)}">${smoney(v.change)} (${pct(LF.changePct(v))})</b> from trading, ${rl}${v.flowSum ? `, not counting ${smoney(v.flowSum)} capital` : ''} · ${money(v.now)} now, every live trading account added together${since}.`
      : `<b class="${cls(v.change)}">${smoney(v.change)} (${pct(LF.changePct(v))})</b> from trading, ${rl}. Every live trading account added together, with deposits and payouts taken out: only trading moves this line${since}.`;
    const parts = wc.parts.map((x) => `${esc(x.label)} ${money(x.usd)}`).join(' + ');
    const warn = [wc.missing.length ? `${esc(wc.missing.join(', '))} has not reported, not counted` : '', wc.parts.some((x) => x.suspect) ? 'a wallet report is waiting for approval' : '', Date.now() - wc.newest_ms > 30 * 60000 ? 'old: the VPS has not reported for a while' : ''].filter(Boolean);
    return `<div class="card hero" style="--dot:${g.color}"><h2>Total Fund <span class="lf-tag">LIVE</span></h2>
      <div class="big" id="lfv">${money(wc.usd)}</div><div class="sub" id="lfp">${alt(wc.usd)}</div>
      <div id="lfd" class="delta ${cls(v.change)}">${smoney(v.change)} (${pct(LF.changePct(v))}) ${rl}</div>
      <div class="note" style="margin:6px 0 0">${parts} · MEXC reports ${sinceTxt(wc.newest_ms)}${warn.length ? ` · <span class="down">${warn.join(' · ')}</span>` : ''}</div>
      <div class="ranges lf-kinds" role="tablist">${LF.KINDS.map(([k, l]) => `<button role="tab" aria-selected="${k === v.kind}" class="${k === v.kind ? 'on' : ''}" data-lkind="${k}">${l}</button>`).join('')}</div>
      ${g.html}
      <div class="ranges">${LF.RANGES.map(([k]) => `<button class="${k === v.range[0] ? 'on' : ''}" data-lrange="${k}">${k}</button>`).join('')}</div>
      <p class="note" style="margin:8px 0 0">${note}</p>
      <div class="row"><span class="l">Booked pool value<br><span class="note">unit price ${f(p.unit_price, 4)} · valued ${p.asof ? day(p.asof) : '—'}${fundStart() ? ' · started ' + day(fundStart()) : ''}</span></span><span class="r">${money(p.equity_usdt)}<br><span class="note ${cls(p.since_start_pct)}">${pct(p.since_start_pct)} since start</span></span></div>${lastClose()}</div>`;
  }
  function showLive(i) {   // the point under the finger (or the latest one): the balance then and the change from trading up to it
    const { v, g } = S.lchart, pts = v.pts, p = pts[i], a = pts[0], last = i === pts.length - 1;
    const dot = $f('lfdot'); dot.style.left = (g.X(p.ts) / g.W) * 100 + '%'; dot.style.top = (g.Y(p.y) / g.H) * 100 + '%'; dot.classList.toggle('live', last);
    const d = v.kind === 'trading' ? p.y : p.y - a.y - v.marks.filter((m) => m.ts <= p.ts).reduce((t, m) => t + m.usd, 0);
    if (v.kind === 'capital') { $f('lfv').textContent = money(last ? S.live.wallet_capital.usd : p.y); $f('lfp').textContent = alt(last ? S.live.wallet_capital.usd : p.y); }
    $f('lfd').className = 'delta ' + cls(d);
    $f('lfd').textContent = `${smoney(d)} (${pct(v.base > 0 ? d / v.base : 0)}) ${last ? v.range[2] : `by ${new Date(p.ts).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}`;
  }
  function wireLive() {
    const svg = $f('lfc'); if (!svg || !S.lchart) return;
    const { v, g } = S.lchart, pts = v.pts, gx = $f('lfx');
    const at = (ev) => {
      const r = svg.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * g.W;
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (g.X(pts[m].ts) < x) lo = m + 1; else hi = m; }
      if (lo > 0 && Math.abs(g.X(pts[lo - 1].ts) - x) <= Math.abs(g.X(pts[lo].ts) - x)) lo--;
      gx.setAttribute('x1', g.X(pts[lo].ts)); gx.setAttribute('x2', g.X(pts[lo].ts)); gx.setAttribute('visibility', 'visible'); S.lhover = true; showLive(lo);
    };
    const reset = () => { gx.setAttribute('visibility', 'hidden'); S.lhover = false; showLive(pts.length - 1); };
    svg.addEventListener('pointermove', at); svg.addEventListener('pointerdown', at);
    svg.addEventListener('pointerleave', reset); svg.addEventListener('pointerup', (ev) => { if (ev.pointerType !== 'mouse') reset(); });
    reset();
  }
  // while the Fund dashboard is open, ask for the live figures once a minute and redraw only when a new wallet report has arrived (the bots send one every 5 minutes)
  setInterval(async () => {
    if (!S.me || !isAdmin() || S.me.impersonated || S.side === 'me' || S.tab !== 'dashboard' || S.modal || S.lhover || document.visibilityState !== 'visible') return;
    const stamp = (l) => (l && l.wallet_capital ? `${l.wallet_capital.newest_ms}|${(l.wallet_history || []).length}|${(l.capital_flows || []).length}` : '');
    const before = stamp(S.live); await loadLive();
    if (stamp(S.live) !== before && S.tab === 'dashboard' && !S.modal) render();
  }, 60000);
  const viewAbout = () => {
    const rate = S.me && S.me.role === 'investor' ? pc(S.me.fee_rate) : '20';
    return `<div class="card"><h2>Growing this together</h2>
      <p class="about">This is a small fund we are growing together. Your money goes into one trading account that the fund manager trades, and the fund manager's own money is in the same pool. Whatever the trading makes or loses is shared by how much each person has in, so everyone is on the same side.</p>
      <p class="about"><b>It is your money and you can take it out.</b> After the ${C.LOCK_MONTHS}-month lock-up on your first deposit (top-ups have none), ask for a withdrawal on the Withdraw tab. You can take part of it or all of it, and it is paid within ${C.WITHDRAW_BUSINESS_DAYS} business days at the value on the day of payout.</p>
      <p class="about"><b>Fair to everyone who joins later.</b> New money waits until the next valuation and then buys in at that day's price. So it never shares in profit made before it arrived, and never pays for losses from before either.</p>
      <p class="about">Profits stay in the pool and grow with it, so the balance moves up and down with the results instead of paying out each month. Some weeks and months will be flat or down.</p>
      <p class="about"><b>You can still lose money.</b> Nothing is guaranteed or insured, and past or backtested results are not a promise. Please put in only what you are comfortable with.</p></div>
    <div class="card"><h2>The fee</h2>
      <p class="about"><b>We only charge when you earn.</b> The fee is ${rate}% of <b>new profit above your best balance so far</b> (your high-water mark) and nothing else: no sign-up charge, no yearly charge, and nothing on your own money.</p>
      <p class="about">After a loss, nothing is charged until you are back above your best. The fee is worked out every two months inside the pool, so no cash moves.</p>
      <p class="about"><b>Your rate is ${rate}%</b>, as agreed with the fund manager. Rates are set per person and can change at any time, for example for people who join later as the fund grows.</p></div>
    <div class="card"><h2>Pesos</h2>
      <p class="about">The pool trades in USDT (a dollar-linked coin). Your pesos are worked out with the live dollar-to-peso rate, so the peso number can move a little even when the trading did not. Use the menu (☰, top right) to switch the view. If the live rate cannot be loaded, figures stay in USDT.</p>
      <p class="about">Your units were bought with the USDT your pesos actually bought, at the unit price on the day your money joined. The peso rate moving later never changes your units or what they are worth in USDT.</p></div>
    <div class="card"><h2>Good to know</h2>
      <p class="about">This page is a record kept by the fund manager. It is not a bank account and is not covered by deposit insurance.</p></div>${glossCard()}${termsCard()}`;
  };
  const viewActivity = () => `<div class="card"><h2>Your activity</h2>${activityRows(S.ledger, false)}</div>`;

  // ---------------------------------------------------------------- manager: "My account" side (only the fund manager's own money, never the pool)
  // For the fund manager S.ledger holds everyone's entries, so everything here is filtered to the fund manager's own profile.
  const myRows = (kinds) => S.ledger.filter((l) => l.profile_id === S.me.id && (!kinds || kinds.includes(l.kind)));
  function viewMine() {
    const m = S.me, mine = myRows(), fees = myRows(['fee_in']), feeTotal = fees.reduce((t, l) => t + Number(l.usdt), 0);
    return `${growthCard('My capital')}
      <div class="card"><h2>My money in the fund</h2>${putInCards(putInOf(m))}${depositRecords(m.id)}<div class="grid">
        <div class="stat"><div class="k">Worth now</div><div class="v">${money(m.value_usdt)}</div></div>
        <div class="stat"><div class="k">Total gain</div><div class="v ${cls(m.profit_usdt)}">${smoney(m.profit_usdt)}</div></div></div>
        <div class="row"><span class="l">Share of the pool</span><span class="r">${m.share_pct == null ? '—' : f(m.share_pct * 100, 2) + '%'}</span></div>
        <div class="row"><span class="l">Units held</span><span class="r">${f(m.units, 4)}</span></div>
        <div class="row"><span class="l">Unit price now</span><span class="r">${f(m.unit_price, 4)}</span></div>
        <p class="note">Total gain includes the fee below, because those units are part of what you hold. New money joins at the next equity reading, at that day's price, like everyone's.</p>
        <div class="btns"><button class="ghost" data-tab="record" data-rec="dep" data-who="me" data-goside="fund">Add money</button><button class="ghost" data-tab="record" data-rec="wd" data-who="me" data-goside="fund">Take money out</button></div></div>
      ${myReturnsCard()}
      <div class="card"><h2>Fee received</h2>
        <div class="row"><span class="l">Received so far<br><span class="note">value when each fee arrived</span></span><span class="r">${money(feeTotal)}<br><span class="note">${alt(feeTotal)}</span></span></div>
        <div class="row"><span class="l">Worth now<br><span class="note">${f(m.fee_units_earned, 4)} units, still invested in the fund</span></span><span class="r">${money(m.fee_units_value_usdt)}<br><span class="note">${alt(m.fee_units_value_usdt)}</span></span></div>
        ${fees.length ? activityRows(fees.slice(0, 5), false) : '<p class="note">None yet. It arrives at a two-month settlement or when an investor withdraws, and only on profit above each investor&rsquo;s high-water mark.</p>'}
        ${fees.length > 5 ? `<div class="btns"><button class="ghost" data-tab="myhistory">See all</button></div>` : ''}</div>
      <div class="card"><h2>Recent transactions</h2>${activityRows(mine.slice(0, 5), false)}
        ${mine.length > 5 ? `<div class="btns"><button class="ghost" data-tab="myhistory">See all ${mine.length}</button></div>` : ''}</div>`;
  }
  const viewMyHistory = () => `<div class="card"><h2>My transactions</h2>${activityRows(myRows(), false)}</div>`;

  // ---------------------------------------------------------------- returns from trading (maths in js/returns.js)
  // S.history: the signed-in person's points (one per pool event since they joined). S.fund: the unit price at every pool
  // event and whether the fund manager's own money was in. Money added or taken out never counts in any % here.
  const tms = (ts) => new Date(ts).getTime();
  function pctChart(lines) {   // lines: [{ name, color, dash, pts: [[time, return], ...] }]; drawn for the chosen range (1D, 1W ...), returns measured from its start
    const start = rangeStart(), label = RANGES.find((x) => x[0] === S.range)[2];
    lines = lines.map((l) => ({ ...l, pts: Returns.fromStart(l.pts, start) }));
    const rangeRow = `<div class="ranges">${RANGES.map(([k]) => `<button class="${k === S.range ? 'on' : ''}" data-range="${k}">${k}</button>`).join('')}</div>`;
    if (lines.some((l) => l.pts.length < 2)) return `<p class="note">The chart starts after the next equity reading, or has no readings in this range.</p>${rangeRow}`;
    const all = lines.flatMap((l) => l.pts);
    const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(t0 + 1, ...all.map((p) => p[0]));
    let lo = Math.min(0, ...all.map((p) => p[1])), hi = Math.max(0, ...all.map((p) => p[1]));
    const pad = (hi - lo || 0.01) * 0.12; lo -= pad; hi += pad;
    const W = 300, H = 120, X = (t) => ((t - t0) / (t1 - t0)) * W, Y = (r) => H - ((r - lo) / (hi - lo)) * H;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Return from trading over time">
      <line x1="0" x2="${W}" y1="${Y(0).toFixed(2)}" y2="${Y(0).toFixed(2)}" stroke="var(--muted)" stroke-opacity=".55" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
      ${lines.map((l) => `<polyline fill="none" stroke="${l.color}" stroke-width="2.2" ${l.dash ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${l.pts.map((p) => `${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`).join(' ')}"/>`).join('')}</svg>
      ${rangeRow}
      <div class="legend" style="margin-top:8px">${lines.map((l) => { const r = l.pts[l.pts.length - 1][1]; return `<span><b style="background:${l.color}"></b>${l.name} <span class="${cls(r)}">${pct(r)}</span></span>`; }).join('')}<span class="note">${label.toLowerCase()}</span></div>`;
  }
  const withNow = (pts) => (pts.length ? [...pts, [Date.now(), pts[pts.length - 1][1]]] : pts);   // flat until today
  function myGrowths() {
    const H = netHistory();
    return { H, yours: Returns.yourGrowth(H.map((p) => ({ v: Number(p.value), n: Number(p.net_in) }))),
             trading: Returns.tradingGrowth(H.map((p) => ({ u: Number(p.units), price: Number(p.price) }))) };
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
      <p class="note"><b>Trading only</b> is what the trading did to your money, and it is exactly what investors see as "Fund manager's own money". Money you add or take out never counts. <b>With fee</b> adds the fees you received from investors, so it also moves with how much of your own money is in.</p></div>`;
  }

  // ---------------------------------------------------------------- pesos: "put in" is what was really paid (docs/php-contributions.md)
  // pesos paid, USDT received, effective and reference rates (js/contribution.js). Display only; S.ledger is only the person's own rows for an investor.
  const contribOf = (h) => Contribution.summary(S.ledger.filter((l) => l.profile_id === h.id), fxRef(), h);
  // "Put in" and "Withdrawn": two plain cards in PESOS (js/contribution.js putIn): Put in in green, and Withdrawn in red only when something was withdrawn.
  const putInOf = (h) => Contribution.putIn(contribOf(h), fxRef());
  const invPutInOf = (inv) => Contribution.putIn(Contribution.sumPutIn(inv.map(contribOf)), fxRef());
  const noteOf = (x) => (x.note ? `<div class="s">${esc(x.note)}</div>` : '');
  const putTile = (p, k = 'Put in') => `<div class="stat"><div class="k">${k}</div><div class="v up">${esc(p.put.main)}</div>${noteOf(p.put)}</div>`;
  const outTile = (p) => (p.out ? `<div class="stat"><div class="k">Withdrawn</div><div class="v down">${esc(p.out.main)}</div>${noteOf(p.out)}</div>` : '');
  const putInCards = (p) => `<div class="grid pcards">${putTile(p)}${outTile(p)}</div>`;
  // older deposits saved before the pesos were: the fund manager adds the pesos actually paid, once each (20261210000000_deposit_pesos.sql). Units never change.
  // every deposit as recorded in pesos (and the USDT those pesos bought, when known); the fund manager adds the pesos of an older deposit, or corrects them.
  // Corrections are new entries (deposit_pesos keeps the history). Folded away unless a deposit still has no pesos. Units never change.
  const depositRecords = (pid) => {
    if (!isAdmin() || S.me.impersonated || S.dpesos == null) return '';
    const list = Contribution.depositList(S.ledger.filter((l) => l.profile_id === pid));
    if (!list.length) return '';
    const missing = list.filter((l) => l.php_amount == null).length;
    return `<details class="more" ${missing ? 'open' : ''}><summary>Deposit records (${list.length})${missing ? ` · ${missing} without pesos` : ''}</summary>
      ${list.map((l) => `<div class="row"><span class="l">${day(l.ts)}<br><span class="note">${l.usdt_bought != null ? `bought ${f(l.usdt_bought, 4)} USDT` : `booked ${usdt(l.usdt, 4)}`}</span></span>
        <span class="r">${l.php_amount != null ? php(Number(l.php_amount)) : '<span class="warn">no pesos yet</span>'}<br><button class="sm ${l.php_amount != null ? 'ghost' : ''}" data-action="addpesos" data-id="${l.id}">${l.php_amount != null ? 'Correct' : 'Add pesos'}</button></span></div>`).join('')}</details>`;
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
  // an investor's income for the month: what the money earned, with any withdrawal fee counted as money taken out
  const takenOut = (m, mgr) => m.withdrawals + (mgr ? 0 : m.withdrawalFee || 0);
  const income = (m) => m.closing - m.opening - m.deposits + takenOut(m, false);
  function monthTableCard(rows, sel, mgr) {
    return `<div class="card noprint"><h2>Month by month</h2>
      <div class="mtab"><div class="mh"><span>Month</span><span>${mgr ? 'Trading' : 'Income'}</span><span>${mgr ? 'With fee' : 'Return'}</span><span>Balance</span></div>
      ${[...rows].reverse().map((m) => `<button class="mrow ${m.key === sel.key ? 'on' : ''}" data-action="stmtpick" data-id="${m.key}">
        <span>${monthName(m.key).slice(0, 3)} ${m.key.slice(0, 4)}${m.partial ? ' <i>to date</i>' : ''}</span>
        ${mgr ? `<span class="${cls(m.tradingPct)}">${pct(m.tradingPct, 1)}</span>` : `<span class="${cls(income(m))}">${sgn(income(m))}</span>`}<span class="${cls(m.yourPct)}">${pct(m.yourPct, 1)}</span><span>${f(m.closing)}</span></button>`).join('')}</div>
      <p class="note" style="margin:8px 0 0">${mgr ? '<b>Trading</b> is what the trading did that month. <b>With fee</b> adds the fee you received.' : '<b>Income</b> is what your money earned that month, in USDT.'} Money you add or take out never counts in the %. Balance is in USDT at the end of the month. Tap a month to open its statement below.</p></div>`;
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
      <p class="note">Measured on your own return, so money you add or take out does not count. It uses each equity reading, so a fall between two readings can be deeper than shown. Drops like these are normal for a fund that trades crypto, and a past drop does not limit a future one.</p></div>`;
  }
  function statementCard(m, mgr) {
    const rows = myMonths(), entries = inMonth(m), who = S.me.name || S.me.username, feeLabel = mgr ? 'Fee received' : 'Fee';
    const line = (l, v, sub, strong) => `<div class="row"><span class="l">${strong ? `<b style="color:var(--ink)">${l}</b>` : l}${sub ? `<br><span class="note">${sub}</span>` : ''}</span><span class="r">${strong ? `<b>${v}</b>` : v}</span></div>`;
    return `<div class="card stmt" id="stmt">
      <div class="print-only"><div class="pt">Lucid'io · Statement</div><div class="ps">${esc(who)} · ${monthName(m.key)}${m.partial ? ' (to date)' : ''} · generated ${day(new Date().toISOString())}</div></div>
      <div class="noprint stmt-top"><h2 style="margin:0">Statement</h2>
        <select data-stmt aria-label="Month">${[...rows].reverse().map((x) => `<option value="${x.key}" ${x.key === m.key ? 'selected' : ''}>${monthName(x.key)}${x.partial ? ' (to date)' : ''}</option>`).join('')}</select></div>
      ${line('Opening balance', usdt(m.opening))}
      ${line('Money added', sUsdt(m.deposits) || usdt(0), m.phpIn > 0 ? `${php(m.phpIn)} paid in` : '')}
      ${line('Money taken out', takenOut(m, mgr) ? '−' + usdt(takenOut(m, mgr)) : usdt(0), m.phpOut > 0 ? `${php(m.phpOut)} paid out` : '')}
      ${mgr ? line('Trading result', sUsdt(m.trading) || usdt(0), `${pct(m.tradingPct, 2)} on the money in the fund`) + line(feeLabel, sUsdt(m.profitShare) || usdt(0), 'received from investors')
        : line('Income', sUsdt(income(m)) || usdt(0), `${pct(m.yourPct, 2)} this month`)}
      ${line('Closing balance', usdt(m.closing), mgr ? `${pct(m.yourPct, 2)} this month, with the fee received` : '', true)}
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
      ['Money added (USDT)', (m) => money2(m.deposits)], ['Money taken out (USDT)', (m) => money2(takenOut(m, mgr))],
      ...(mgr ? [['Trading result (USDT)', (m) => money2(m.trading)], ['Fee received (USDT)', (m) => money2(m.profitShare)]] : [['Income (USDT)', (m) => money2(income(m))]]),
      ['Closing (USDT)', (m) => money2(m.closing)],
      ...(mgr ? [['Trading return (%)', (m) => (m.tradingPct * 100).toFixed(2)]] : []), [(mgr ? 'Return with fee received' : 'Return') + ' (%)', (m) => (m.yourPct * 100).toFixed(2)],
      ['Pesos paid in', (m) => money2(m.phpIn)], ['Pesos paid out', (m) => money2(m.phpOut)]], myMonths());
  }
  function stmtMonthCsv(m) {
    const mgr = isAdmin(), lines = [['Statement', monthName(m.key) + (m.partial ? ' (to date)' : '')], ['Name', S.me.name || S.me.username], ['Opening balance (USDT)', money2(m.opening)],
      ['Money added (USDT)', money2(m.deposits)], ['Money taken out (USDT)', money2(takenOut(m, mgr))],
      ...(mgr ? [['Trading result (USDT)', money2(m.trading)], ['Fee received (USDT)', money2(m.profitShare)]] : [['Income (USDT)', money2(income(m))]]),
      ['Closing balance (USDT)', money2(m.closing)], ...(mgr ? [['Trading return (%)', (m.tradingPct * 100).toFixed(2)]] : []), [(mgr ? 'Return with fee received' : 'Return') + ' (%)', (m.yourPct * 100).toFixed(2)],
      ['Pesos paid in', money2(m.phpIn)], ['Pesos paid out', money2(m.phpOut)]];
    const top = Returns.toCsv([['Item', (r) => r[0]], ['Value', (r) => r[1]]], lines);
    const ent = Returns.toCsv([['Date', (l) => new Date(l.ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'], ['Type', (l) => (KIND[l.kind] || [l.kind])[0]], ['USDT', (l) => money2(l.usdt)], ['Units', (l) => Number(l.units).toFixed(8)],
      ['Pesos', (l) => (l.php_amount == null ? '' : money2(l.php_amount))], ['Note', (l) => l.note || '']], inMonth(m));
    return top + '\r\n' + ent;
  }
  function printStatement() {
    const t = document.title, m = stmtMonth(myMonths());
    document.title = `Lucid'io statement ${m ? m.key : ''} ${S.me.name || S.me.username}`.trim();   // the suggested file name when saving as PDF
    window.print(); setTimeout(() => { document.title = t; }, 500);
  }
  document.addEventListener('change', (ev) => { const s = ev.target.closest && ev.target.closest('select[data-stmt]'); if (s) { S.stmt = s.value; render(); } });

  // ---------------------------------------------------------------- manager: activity log and backups
  const AUDIT_GROUPS = {
    money: ['money_received', 'money_handed_back', 'money_in', 'money_out', 'fee_charged', 'correction', 'withdrawal_requested', 'withdrawal_cancelled', 'withdrawal_paid', 'admission_spread_recorded', 'admission_spread_reallocated', 'deposit_pesos_recorded', 'deposit_pesos_corrected'],
    readings: ['equity_reading', 'quarter_closed'],
    accounts: ['user_created', 'rate_changed', 'rate_scheduled', 'deactivated', 'reactivated', 'name_changed', 'username_changed', 'payout_details_changed', 'terms_agreed'],
    security: ['password_changed', 'password_reset', 'viewed_as', 'setting_changed', 'backup_exported', 'backup_key_created', 'backup_keys_revoked'],
  };
  async function loadAdminExtras() {
    const soft = (p) => p.catch((e) => { if (e.message === 'Signed out') throw e; return null; });   // a failed read leaves that part empty
    const [audit, backup, spreads] = await Promise.all([soft(call('admin_audit_log', { p_limit: 200 })), soft(call('admin_backup_status')), soft(call('admin_admission_spreads'))]);   // all at once
    S.audit = audit; if (audit) S.auditMore = audit.length >= 200; S.backup = backup;
    S.spreads = spreads;   // null until 20261209000000_admission_spread.sql is run: the Admission spread card stays hidden
  }
  const auditTime = (ts) => dayTime(ts);
  function auditText(r) {
    const d = r.detail || {}, self = !!r.subject_id && r.subject_id === r.actor_id, who = `<b>${esc(r.subject_name || '')}</b>`, own = self ? 'their' : `${who}'s`, u = (v) => `${usdt(Math.abs(Number(v)))}${rate() ? ' ' + peso(Math.abs(Number(v)), rate()) : ''}`;
    switch (r.action) {
      case 'user_created': return `created the account for ${who}${d.role === 'admin' ? ' (fund manager)' : ` (fee ${pc(d.fee_rate)}%)`}`;
      case 'rate_changed': return `changed ${who}'s fee from ${pc(d.from)}% to ${pc(d.to)}%`;
      case 'rate_scheduled': return `set ${who}'s fee to become ${pc(d.to)}% after the next settlement`;
      case 'deactivated': return `deactivated ${who}'s account`;
      case 'reactivated': return `reactivated ${who}'s account`;
      case 'name_changed': return `renamed ${esc(d.from || '—')} to ${esc(d.to || '—')}`;
      case 'payout_details_changed': return `updated ${own} withdrawal details (${(d.fields || []).map(esc).join(', ')})`;
      case 'username_changed': return `changed their username from ${esc(d.from || '—')} to ${esc(d.to || '—')}`;
      case 'password_changed': return 'changed their own password';
      case 'password_reset': return `reset ${who}'s password`;
      case 'equity_reading': return `posted an equity reading of ${usdt(d.equity_usdt)} (unit price ${f(d.unit_price, 4)})${d.note ? ' · ' + esc(d.note) : ''}`;
      case 'quarter_closed': return `settled the two-month period at ${usdt(d.equity_usdt)} (unit price ${f(d.unit_price, 4)})`;
      case 'money_received': return `recorded money received from ${who}: ${d.php_amount ? php(d.php_amount) + ' = ' : ''}${usdt(d.usdt)}, waiting to join`;
      case 'money_handed_back': return `handed back ${who}'s waiting money (${usdt(d.usdt)})`;
      case 'money_in': return `${who}'s money joined the pool: ${usdt(d.usdt)}${d.php_amount ? ' (' + php(d.php_amount) + ' paid)' : ''}`;
      case 'admission_spread_recorded': return `recorded an admission spread for ${who}: ${php(d.php_amount)} credited at ₱${f(d.admission_rate, 2)} (actual ₱${f(d.reference_rate, 2)}) = ${usdt(d.credited_usdt, 6)} of ${usdt(d.actual_usdt, 6)} allocated, ${usdt(d.surplus_usdt, 6)} is the manager's`;
      case 'peso_topup': return `topped up ${who}'s pesos to the live rate ₱${f(d.rate, 2)}: ${usdt(d.usdt, 6)} · ${f(d.units, 4)} of the manager's units at ${f(d.unit_price, 4)}`;
      case 'admission_spread_reallocated': return `moved units from the manager to ${who} (admission spread): ${php(d.php_amount)} credited at ₱${f(d.admission_rate, 2)} = ${usdt(d.credited_usdt, 6)} · ${f(d.units, 4)} units at ${f(d.unit_price, 4)}; the surplus ${usdt(d.surplus_usdt, 6)} stays the manager's`;
      case 'deposit_pesos_corrected': return `corrected the pesos of ${own} deposit: ${php(d.from_php)} → ${php(d.php_amount)}${d.usdt_bought ? ' = ' + f(d.usdt_bought, 4) + ' USDT' : ''} (${esc(d.note || '')})`;
      case 'deposit_pesos_recorded': return `recorded the pesos paid for ${own} ${usdt(d.usdt)} deposit: ${php(d.php_amount)} (${esc(d.note || '')})`;
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
    if (kind === 'json') download(`lucid-io-ledger-backup-${stamp}.json`, JSON.stringify(x, null, 1), 'application/json');
    else download(`lucid-io-ledger-entries-${stamp}.csv`, Returns.toCsv([['id', (l) => l.id], ['date', (l) => l.ts], ['person', (l) => (x.people.find((p) => p.id === l.profile_id) || {}).username || l.profile_id], ['kind', (l) => l.kind],
      ['usdt', (l) => l.usdt], ['units', (l) => l.units], ['unit_price', (l) => l.unit_price], ['php_amount', (l) => l.php_amount], ['php_rate', (l) => l.php_rate], ['note', (l) => l.note]], x.ledger));
    await loadAdminExtras(); render(); toast(`Backup downloaded (${x.checks.ledger_rows} entries)`);
  }

  // ---------------------------------------------------------------- admin views
  function viewUsers() {
    const card = (h) => {
      const inv = h.role === 'investor' && h.net_profit_usdt != null, val = inv ? h.net_value_usdt : h.value_usdt, gain = inv ? h.net_profit_usdt : h.profit_usdt, nm = esc(h.name || h.username);
      return `<div class="card ucard${h.active ? '' : ' off'}"><div class="ubody"><div class="unm">${nm}${h.role === 'admin' ? ' <span class="chip">fund manager</span>' : ''}${h.active ? '' : ' <span class="chip down">off</span>'}${h.role === 'investor' && contactMissing(h.id) ? ' <span class="chip down">no contact</span>' : ''}</div>
          <div class="uval"><b>${money(val)}</b> <span class="${cls(gain)}">(${smoney(gain)})</span></div>
          <div class="note">Started ${startedText(startOf(h.id))}</div>${h.role === 'investor' ? `<div class="note">${payLine(h.id)}</div>` : ''}</div>
        <button class="iconbtn" data-action="userview" data-id="${h.id}" aria-label="View ${nm}" title="View ${nm}">${ICON.eye}</button></div>`;
    };
    const earned = isAdmin() ? Earnings.card(Earnings.byInvestor(S.ledger, S.all), money, day) : '';   // js/earnings.js: fees earned from each investor (manager only)
    return `${earned}<div class="sechead"><h2>Users (${S.all.length})</h2><button class="sm ${S.addUser ? 'ghost' : ''}" data-action="adduser">${S.addUser ? 'Cancel' : '+ Add user'}</button></div>
      ${S.addUser ? `<div class="card"><h2>New user</h2>
      <p class="note">Give them the username and password yourself. They can change the password after signing in.</p>
      <form id="newUserForm"><div class="grid form2"><div><label>Username</label><input name="username" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\-]{3,30}" required></div>
        <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="20" required></div></div>
        <label>Full name</label><input name="name" required>
        <label>Starting password (at least 8 characters)</label><input name="password" type="text" minlength="8" autocomplete="off" required>
        <button class="full">Create account</button></form></div>` : ''}
      ${S.all.map(card).join('')}`;
  }
  // everything about one person, in a sheet over the Users list; "View as" is the last thing in it
  // the "? How this works" sheet of a Record tab: it lives in S.modal as 'help:<tab>', so Back, Esc and the backdrop close it like every other sheet
  const helpModal = (topic) => RH.sheet(topic, { gate: gateOn(), maxAgeHours: S.checks && S.checks.max_age_hours }, ICON.close);
  function userModal() {
    if (RH.isHelp(S.modal)) return helpModal(S.modal.slice(5));
    const h = S.modal && S.all.find((x) => x.id === S.modal); if (!h) return '';
    const inv = h.role === 'investor', net = inv && h.net_profit_usdt != null, nm = esc(h.name || h.username);
    const line = (l, v) => `<div class="row"><span class="l">${l}</span><span class="r">${v}</span></div>`;
    const gainOf = (g, p) => `<i class="${cls(g)}" style="font-style:normal">${smoney(g)}${p != null ? ' (' + pct(p, 1) + ')' : ''}</i>`;
    return `<div class="modal-bg" data-action="closemodal"><div class="sheet" role="dialog" aria-modal="true" aria-label="${nm}">
      <div class="sheet-head"><div><div class="sheet-nm">${nm}${h.active ? '' : ' <span class="chip down">off</span>'}</div><div class="note">@${esc(h.username)}${inv ? '' : ' · fund manager'}</div></div>
        <div class="sheet-btns">${inv && h.active ? `<button class="iconbtn" data-action="viewas" data-id="${h.id}" aria-label="Sign in as ${nm} (read-only)" title="Sign in as ${nm} (read-only)">${ICON.eye}</button>` : ''}<button class="iconbtn" data-action="closemodal" aria-label="Close" title="Close">${ICON.close}</button></div></div>
      ${inv && isAdmin() ? Earnings.lines(Earnings.byInvestor(S.ledger, S.all).rows.find((r) => r.id === h.id), money) : ''}
      ${line(net ? 'Balance after fee' : 'Worth now', `<b>${money(net ? h.net_value_usdt : h.value_usdt)}</b><br><span class="note">${alt(net ? h.net_value_usdt : h.value_usdt)}</span>`)}
      ${line('Started', startedText(startOf(h.id)))}
      ${putInCards(putInOf(h))}${depositRecords(h.id)}
      ${Contribution.rows(contribOf(h), { holdings: false })}
      ${net ? line('Profit, theirs after fee', gainOf(h.net_profit_usdt, h.net_return_pct)) + line('Before fee', gainOf(h.gross_profit_usdt, h.gross_return_pct)) + line('Your fee (worth now)', money(h.profit_share_usdt))
        : line('Profit', gainOf(h.profit_usdt, h.return_pct))}
      ${line('Share of the pool', h.share_pct == null ? '—' : f(h.share_pct * 100, 1) + '%')}
      ${line('Units', f(h.units, 3))}
      ${line('Fee rate', inv ? rateText(h) : '—')}
      ${EXIT_FEE_ON && inv && exitInfo(h.id) ? line(`Withdrawal fee<br><span class="note">${exitNote(h.id)}</span>`, pc(exitRate(h.id)) + '%') : ''}
      ${line(inv ? 'Locked until' : 'Fees earned (units)', inv ? day(h.lock_until) : f(h.fee_units_earned, 3))}
      ${termsLine(h)}
      ${IC.card(h, { pend: S.pend, reqs: S.reqs, queue: S.queue, pu: S.pu, fmt: icFmt })}
      ${inv ? `<h3 class="subhead">Withdrawal details</h3>${payoutBlock(payOf(h.id))}
        <details ${payOf(h.id) ? '' : 'open'}><summary class="note" style="cursor:pointer">${payOf(h.id) ? 'Edit' : 'Add'} withdrawal details</summary>
          <form class="adminPayoutForm" data-id="${h.id}"><p class="note" style="margin:8px 0 0">Record or correct where ${nm} is paid (for example taken over the phone). Same details they can edit themselves.</p>
            <label>Label</label><input name="method" value="${esc(payLabel((payOf(h.id) || {}).method))}" maxlength="40" autocomplete="off" placeholder="e.g. GCash, Bank transfer, GoTyme, Maya" required>
            <label>Account name</label><input name="pname" value="${esc((payOf(h.id) || {}).account_name || '')}" autocomplete="off" required>
            <label>Mobile number or bank account number</label><input name="pnum" value="${esc((payOf(h.id) || {}).account_number || '')}" inputmode="numeric" autocomplete="off" required>
            <label>QR code (optional)</label>${(payOf(h.id) || {}).qr_path ? `<img class="payqr" src="${payUrl(payOf(h.id).qr_path)}" alt="Saved QR code"><p class="note" style="margin:0">Saved. Choose a new picture only to replace it.</p>` : ''}
            <input name="qr" type="file" accept="image/png,image/jpeg,image/webp">
            <div class="btns"><button class="ghost">Save withdrawal details</button></div></form></details>` : ''}
      ${S.contactOn ? `<h3 class="subhead">Contact</h3>${contactBlock(contactOf(h.id))}
        <details ${contactMissing(h.id) ? 'open' : ''}><summary class="note" style="cursor:pointer">Edit contact details</summary>
        <form class="adminContactForm" data-id="${h.id}"><p class="note" style="margin:8px 0 0">Record or correct ${nm}'s contact details (for example taken over the phone). The change is kept in a history.</p>
          <label>Phone number</label><input name="phone" type="tel" value="${esc((contactOf(h.id) || {}).phone || '')}" inputmode="tel" required>
          <label>Email (optional)</label><input name="email" type="email" value="${esc((contactOf(h.id) || {}).email || '')}">
          <div class="grid form2"><div><label>Emergency contact</label><input name="en" value="${esc((contactOf(h.id) || {}).emergency_name || '')}" placeholder="Name"></div>
            <div><label>Their number</label><input name="ep" type="tel" value="${esc((contactOf(h.id) || {}).emergency_phone || '')}"></div></div>
          <div class="btns"><button class="ghost">Save contact details</button></div></form></details>` : ''}
      <h3 class="subhead">Account</h3>
      <details><summary class="note" style="cursor:pointer">Edit name, fee, username and password</summary>
        ${inv ? `<form class="profForm" data-id="${h.id}"><div class="grid form2"><div><label>Name</label><input name="name" value="${esc(h.name)}"></div>
          <div><label>Fee %</label><input name="fee" type="number" step="any" min="0" max="100" value="${pc(h.fee_rate)}"></div></div>
          <p class="note" style="margin:6px 0 0">Lowering applies at once. Raising only starts after the next settlement, so it never touches profit already made.${h.fee_rate_next != null ? ` Scheduled: ${pc(h.fee_rate_next)}%. Type the current % again to cancel it.` : ''}</p>
          <div class="btns"><button class="ghost">Save</button><button type="button" class="${h.active ? 'danger' : 'ghost'}" data-action="toggleactive" data-id="${h.id}" data-active="${h.active}">${h.active ? 'Deactivate' : 'Reactivate'}</button></div></form>` : ''}
        <form class="adminUserForm" data-id="${h.id}"><label>Username (they sign in with it)</label>
          <input name="username" value="${esc(h.username)}" autocapitalize="none" autocomplete="off" pattern="[a-zA-Z0-9_.\-]{3,30}" title="3 to 30 letters, numbers, dot, dash or underscore" required>
          <div class="btns"><button class="ghost">Save username</button></div></form>
        <form class="resetForm" data-id="${h.id}"><label>New password for ${nm}</label>
          <input name="password" type="text" minlength="8" autocomplete="off" required>
          <div class="btns"><button class="ghost">Set password</button></div></form></details>
</div></div>`;
  }
  const holderOpts = (sel) => S.all.filter((h) => h.active)
    .map((h) => `<option value="${h.id}" ${h.id === sel ? 'selected' : ''}>${esc(h.name || h.username)}${h.role === 'admin' ? ' (fund manager)' : ''}</option>`).join('');
  const atOf = (fm) => (fv(fm, 'at') ? new Date(fv(fm, 'at')).toISOString() : null);   // optional "when" for late entries
  // optional extras. The peso rate defaults to the live rate; the deposit form shows the rate up front instead
  // the manager's forms say which rate their ₱ figures use: today's PHP/USD reference rate (sent with the entry), never a deposit's cash-in rate
  const refFormNote = () => { const r = fxRef(); return `<p class="note">₱ figures here use today's PHP/USD reference rate${r ? ` ₱${f(r.rate, 2)} (${esc(r.src)})` : ': unavailable, so none are shown and the fund\'s stored reference rate is used for the ₱500 minimum'}. It is never a cash-in rate and changes no amount.</p>`; };
  const phpField = (withRate = true) => `<details><summary>More options: date${withRate ? ', reference rate' : ''}</summary><label>When (leave empty for now; only for recording something late)</label><input name="at" type="datetime-local">${withRate ? `<label>Current PHP/USD reference rate (₱ per USD: peso display and the ₱500 minimum only, never a cash-in rate)</label><input name="rate" type="number" step="any" inputmode="decimal" value="${rate() || ''}">` : ''}</details>`;

  // the pool_equity timeline is the single source of truth for "what happened and when"; every deposit/withdrawal
  // also has matching ledger row(s) carrying the person and amounts, joined here by equity_id.
  function recordHistoryRows() {
    if (!S.elog.length) return '<p class="note">Nothing recorded yet.</p>';
    return S.elog.slice(0, 60).map((e, i) => {
      const rows = S.ledger.filter((l) => l.equity_id === e.id);
      const who = [...new Set(rows.map((r) => r.name))].join(', ');
      const label = e.kind === 'update' ? 'Equity reading' : e.kind === 'close' ? 'Settlement'
        : e.kind === 'deposit' ? `Deposit${who ? ' · ' + esc(who) : ''}` : `Withdrawal${who ? ' · ' + esc(who) : ''}`;
      const canFix = i === 0 && e.kind !== 'close' && !e.reversed_of;   // a correction itself can never be undone (the database refuses too)
      return `<div class="row" style="align-items:flex-start">
        <span class="l"><b style="color:var(--ink)">${label}</b>${e.reversed_of ? ' <span class="chip">correction</span>' : ''}<br>
          ${day(e.ts)}${e.note ? ' · ' + esc(e.note) : ''}</span>
        <span class="r">${money(e.equity_usdt)}<br><span class="note">${usdt(e.equity_usdt)} · price ${f(e.unit_price, 4)}</span>
          ${canFix ? `<div class="btns" style="margin-top:6px">${LEGACY ? '<button type="button" class="ghost sm" data-action="editlast">Edit</button>' : ''}<button type="button" class="danger sm" data-action="undolast">Delete</button></div>` : ''}</span></div>`;
    }).join('');
  }
  // deposits received but not yet turned into units: they own nothing until the next equity reading (forward pricing)
  const pendTotal = () => S.pend.reduce((t, d) => t + Number(d.usdt), 0);
  const inMexc = () => S.pend.filter((d) => d.arrived_at), inMexcTotal = () => inMexc().reduce((t, d) => t + Number(d.usdt), 0);
  const pendNote = () => (inMexc().length ? ` Includes <b>${usdt(inMexcTotal())}</b> of deposits already in the exchange and still waiting; they are taken out first.` : '')
    + (S.pend.length > inMexc().length ? ` <span class="warn">${S.pend.length - inMexc().length} deposit(s) not marked "In the exchange": they are NOT taken out. If their money is already in the exchange, mark them first.</span>` : '');
  // workflow_gate = 'on': deposits, withdrawals and settlements are only possible through Record → Balance (the database refuses the old direct
  // routes). The old forms are replaced by instructions, so nobody meets an error message.
  const RH = RecordHelp;   // js/recordhelp.js: the "? How this works" instructions on the Record tabs
  const PU = PoolUpdate;   // js/poolupdate.js: the wording and the request for Update Pool
  const gateOn = () => Gate.on(S.queue);   // js/gate.js: the wording and decisions for the old forms when workflow_gate is on
  const SP = SettlePreview;   // js/settlepreview.js: prints what admin_settlement_preview returned (no maths)
  const IC = InvestorCtx;     // js/investorctx.js: the investor's position and which actions apply (no maths)
  const TVUI = TrueValueUI;   // js/truevalue-ui.js: true-value price, whether money can move now (and why not), checkpoints; investors see only their own numbers
  const BT = BotTotal;        // js/bottotal.js: "Read from the bots" fills an Exchange total field from the bots' latest wallet reports (admin_wallet_nav)
  const spFmt = { usdt: (n) => usdt(n), units: (n) => f(n, 4), day: (t) => day(t), pc: (r) => pc(r) };
  const icFmt = { money: (n) => money(n), units: (n) => f(n, 4), day: (t) => day(t) };
  // ---------------------------------------------------------------- admission spread (docs/archive/admission-spread.md)
  // Pesos credited at an ADMISSION rate a little above the real one; the investor gets units for the CREDITED USDT only and the rest of what was really allocated is the
  // fund manager's own: units of the manager (never the pool's, never a trading result). The database does every sum and refusal; the form shows its quote.
  const SPREAD_PHP = 1;   // the agreed spread, ₱ per USDT (ledger setting admission_spread_php: the database refuses more than it allows)
  const SPREAD_SRC = { p2p_purchase: 'new P2P purchase', manager_reallocation: 'from your capital' };
  const SPREAD_STATUS = { waiting_for_exchange: 'not in the exchange yet', waiting: 'in the exchange, ready to admit', admitted: 'admitted', handed_back: 'handed back', done: 'done' };
  const spreadLegs = () => { const m = new Map(); for (const s of S.spreads || []) { if (s.investor_pending_id) m.set(Number(s.investor_pending_id), s); if (s.manager_pending_id) m.set(Number(s.manager_pending_id), s); } return m; };
  const spreadRow = (s) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(s.investor)}</b> · ${day(s.created_at)}<br><span class="note">${php(s.php_amount)} at ₱${f(s.admission_rate, 2)} (actual ₱${f(s.reference_rate, 2)}) · ${SPREAD_SRC[s.funding_source] || esc(s.funding_source)} · ${SPREAD_STATUS[s.status] || esc(s.status)}</span></span>
    <span class="r">${usdt(s.credited_usdt, 6)} credited<br><span class="note">of ${usdt(s.actual_usdt, 6)} · yours ${usdt(s.surplus_usdt, 6)}${s.investor_units != null ? ` · ${f(s.investor_units, 4)} units` : ''}${s.manager_units != null ? ` + ${f(s.manager_units, 4)} yours` : ''}</span>
    ${s.status === 'waiting' || s.status === 'waiting_for_exchange' ? `<div class="btns" style="margin-top:6px">${s.status === 'waiting' ? `<button class="sm" data-action="spreadadmit" data-id="${s.id}">Admit</button>` : ''}<button class="ghost sm" data-action="spreadcancel" data-id="${s.id}">Hand back</button></div>` : ''}</span></div>`;
  // Peso top-ups (docs/php-contributions.md, section 9): a peso deposit counts at the live PHP/USD rate, not at what the exchange delivered. The difference comes
  // from the fund manager's own units (admin_peso_topup, at the true-value price), so nobody else's value moves. Only once the deposit has joined the pool.
  const topupsDue = () => S.all.filter((h) => h.active && h.role === 'investor' && !S.pend.some((d) => d.profile_id === h.id))
    .map((h) => ({ h, t: Contribution.topupDue(contribOf(h), fxRef()) })).filter((x) => x.t);
  function topupCard() {
    const due = topupsDue();
    if (!due.length) return '';
    return `<div class="card" data-topups><h2>Peso top-ups (${due.length})</h2>
      <p class="note">These pesos are credited at today's live PHP/USD rate. Less USDT arrived in the exchange, so the difference comes from <b>your</b> units at today's price. Nobody else's value changes.</p>
      ${due.map(({ h, t }) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(h.name || h.username)}</b> · ${php(t.php)} at ₱${f(t.rate, 2)} = ${usdt(t.credited)}<br><span class="note">${usdt(t.arrived)} arrived · top up <b>${usdt(t.gap)}</b> from your units</span></span>
        <span class="r"><button class="sm" data-action="topup" data-id="${h.id}">Top up</button></span></div>`).join('')}</div>`;
  }
  function spreadCard() {
    if (S.spreads == null) return '';
    const inv = S.all.filter((h) => h.active && h.role === 'investor'), r = rate() ? Math.round(rate() * 100) / 100 : '';
    return `<div class="card" data-spread><h2>Admission spread</h2>
      <p class="note">Credit an investor's pesos at an <b>admission rate</b> up to ₱${SPREAD_PHP} above the real rate. They get units only for the <b>credited</b> USDT. What was really allocated beyond that is <b>yours</b>: your own units, never shared pool value and never a trading result.</p>
      <form id="spreadForm"><label>Who</label><select name="who">${inv.length ? inv.map((h) => `<option value="${h.id}" ${h.id === S.recWho ? 'selected' : ''}>${esc(h.name || h.username)}</option>`).join('') : '<option value="">No investors</option>'}</select>
        <div class="grid form2"><div><label>Pesos paid</label><input name="php" type="number" step="any" inputmode="decimal" placeholder="5000" required></div>
          <div><label>Funded by</label><select name="src"><option value="p2p_purchase">New P2P purchase</option><option value="manager_reallocation">My own capital (no new money)</option></select></div></div>
        <div class="grid form2"><div><label>Actual / reference rate (₱ per USDT)</label><input name="ref" type="number" step="any" inputmode="decimal" value="${r}" required></div>
          <div><label>Admission rate (₱ per USDT)</label><input name="adm" type="number" step="any" inputmode="decimal" value="${r === '' ? '' : (r + SPREAD_PHP).toFixed(2)}" required></div></div>
        <label>USDT actually allocated</label><input name="act" type="number" step="any" inputmode="decimal" placeholder="pesos ÷ actual rate" aria-describedby="spreadActHint">
        <p class="note" id="spreadActHint" style="margin:4px 0 0">What the pesos really bought (or the part of your capital you set aside). Leave empty to use pesos ÷ actual rate.</p>
        <label style="display:flex;gap:8px;align-items:flex-start" data-p2p><input name="inmexc" type="checkbox" style="width:auto;min-height:0;margin-top:3px"> <span>Already seen in the exchange</span></label>
        <div class="preview" id="spreadPrev">—</div><button class="full">Save</button></form>
      ${S.spreads.length ? `<h3 class="subhead">Recorded</h3>${S.spreads.slice(0, 10).map(spreadRow).join('')}` : ''}</div>`;
  }
  const spreadArgs = (fm) => {
    const php0 = num(fv(fm, 'php')), ref = num(fv(fm, 'ref')), adm = num(fv(fm, 'adm')), F = Contribution.spreadFigures(php0, ref, adm, num(fv(fm, 'act')));
    return { fig: F, args: F && fv(fm, 'who') ? { p_profile: fv(fm, 'who'), p_php_amount: php0, p_reference_rate: ref, p_admission_rate: adm, p_actual_usdt: F.actual, p_source: fv(fm, 'src') } : null };
  };
  let spSeq = 0, spTimer = null;
  function spreadPrev(fm) {
    const p2p = fv(fm, 'src') === 'p2p_purchase', box = fm.querySelector('[data-p2p]'); if (box) box.hidden = !p2p;
    const { fig, args } = spreadArgs(fm); spSeq++; clearTimeout(spTimer);
    if (!fig || !args) return setPrev('spreadPrev', '—');
    setPrev('spreadPrev', `${php(args.p_php_amount)} at ₱${f(args.p_admission_rate, 2)} = <b>${usdt(fig.credited, 6)}</b> credited · ${usdt(fig.actual, 6)} allocated · <b>${usdt(fig.surplus, 6)}</b> yours.<br><span class="note">Asking the database…</span>`);
    const my = spSeq;
    spTimer = setTimeout(async () => {
      let r = null, err = null;
      try { r = await call('admin_quote_admission_spread', args); } catch (e) { err = e.message; }
      if (my !== spSeq || err === 'Signed out') return;
      if (err) return setPrev('spreadPrev', `<span class="down">The database would refuse this: ${esc(/function|schema cache|does not exist/i.test(err) ? 'not available on this database yet (run 20261209000000_admission_spread.sql).' : err)}</span>`);
      setPrev('spreadPrev', `${php(args.p_php_amount)} at ₱${f(args.p_admission_rate, 2)} = <b>${usdt(r.credited_usdt, 6)}</b> credited to the investor.<br>${usdt(r.actual_usdt, 6)} allocated · <b>${usdt(r.surplus_usdt, 6)} stays yours</b>${r.units != null ? `<br>They get <b>${f(r.units, 4)} units</b> at ${f(r.unit_price, 4)}; you give up the same units.` : '<br>It waits outside the pool until it is in the exchange; then the investor\'s part and your surplus are admitted together at the same price.'}
        <br><span class="note">Quoted by the database; nothing is saved until you press Save.</span>`);
    }, 350);
  }
  function pendingCard() {
    if (!S.pend.length) return '';
    const g = gateOn(), legs = spreadLegs();
    return `<div class="card"><h2>Waiting to join (${S.pend.length}) · ${money(pendTotal())}</h2>
      <p class="note">${g ? Gate.TEXT.waiting
        : 'Received but not in the pool yet: no gains, no losses. A deposit joins only once it is marked <b>In the exchange</b>, at the next <b>Update equity</b> (or settlement), at that day\'s price. Mark it as soon as the money reaches Exchange.'}</p>
      ${S.pend.map((d) => `<div class="row"><span class="l">${esc(d.name)} · ${day(d.received_at)}<br><span class="note">${d.php_amount ? php(d.php_amount) + ' = ' : ''}${usdt(d.usdt)} · ${d.arrived_at ? (g ? 'in the exchange: admit it under Record → Balance' : 'in the exchange, joins at the next reading') : '<span class="warn">not in the exchange yet</span>'}</span></span>
        <span class="r">${d.arrived_at || g ? '' : `<button class="sm" data-action="arrived" data-id="${d.id}">In the exchange</button> `}${legs.has(Number(d.id)) ? `<span class="note">part of admission spread #${legs.get(Number(d.id)).id}: admitted or handed back together</span>` : `<button class="ghost sm" data-action="cancelpend" data-id="${d.id}">Handed back</button>`}</span></div>`).join('')}${g ? '<div class="btns"><button data-tab="record" data-rec="eq">Open Record → Balance</button></div>' : ''}</div>`;
  }
  // the four routine steps (js/desk.js); the database quotes every figure. Shown once 20261213000000_live_nav.sql is run (S.nav is then set).
  function deskView() {
    const o = { holderOpts: holderOpts(S.recWho), rate: rate(), cashins: S.cashins, now: Date.now(), requests: S.reqs, payouts: S.nav.payouts_to_send, unitPrice: S.pool.unit_price, defaultFee: 0.2 };
    if (S.rec === 'add') return Desk.addForm(o);
    if (S.rec === 'cash') return Desk.cashForm(o);
    if (S.rec === 'out') return Desk.outForm(o);
    if (S.rec === 'move') return Desk.moveForm(o);
    return Desk.navCard(S.nav, Date.now());
  }
  function viewRecord() {
    const desk = !!S.nav && isAdmin();
    if (!LEGACY) {
      // the flow in use: the four steps, the Live NAV and History. Links that still name an old screen land on the step that replaced it.
      if (!desk) return '<div class="card"><h2>Record</h2><p class="note">The live NAV is not on this database (run <b>20261213000000_live_nav.sql</b>), so the four steps are not available.</p></div>';
      S.rec = ({ dep: 'cash', wd: 'out', eq: 'nav' })[S.rec] || S.rec || 'cash';
      if (S.rec === 'hist') return `${Desk.tabs('hist', false)}<div class="card"><h2>History</h2>
        <p class="note">Only the latest entry can be undone; it adds a correction and erases nothing.</p>${recordHistoryRows()}</div>`;
      if (!Desk.isDesk(S.rec)) S.rec = 'cash';
      return Desk.tabs(S.rec, false) + deskView();
    }
    if (!S.rec || (!desk && Desk.isDesk(S.rec))) S.rec = desk ? 'cash' : 'eq';
    if (desk && Desk.isDesk(S.rec)) return Desk.tabs(S.rec, true) + deskView();
    const noUnits = Number(S.pool.total_units) === 0, empty = noUnits && !S.pend.length;
    const pick = (k, html) => (S.rec === k ? html : '');
    const noBal = '<div class="card"><h2>Balance</h2><p class="note">Nothing to balance yet. Record the first deposit under <b>Money in</b>, then confirm it reached the exchange and it will show up here.</p><div class="btns"><button data-rec="dep">Go to Money in</button></div></div>';
    const gBal = Gate.oldForm('balance', S.queue, { arrived: inMexc().length, totalText: usdt(inMexcTotal()) });
    const tabs = [['dep', 'Money in'], ['wd', 'Money out'], ['eq', 'Balance'], ['hist', 'History']];
    return `${desk ? Desk.tabs(S.rec, true) : `<div class="ranges" style="margin:12px 0 0">${tabs.map(([k, l]) => `<button class="${S.rec === k ? 'on' : ''}" data-rec="${k}">${l}</button>`).join('')}</div>`}
      ${pick('dep', `${RH.button('dep')}<div class="card"><h2>Money in</h2>
        <p class="note">Someone gave you money. It waits outside the pool until you confirm it reached the exchange and admit it under <b>Balance</b>.</p>
        <form id="depForm"><label>Who</label><select name="who">${holderOpts(S.recWho)}</select>
        <div class="grid form2"><div><label data-amtlabel>Pesos paid</label><input name="amt" type="number" step="any" inputmode="decimal" placeholder="5000" required></div>
          <div><label>Currency</label><select name="ccy"><option value="PHP">₱ Pesos</option><option value="USDT">USDT</option></select></div></div>
        <div data-got><label>USDT actually received (as the exchange shows it)</label><input name="got" type="number" step="any" inputmode="decimal" placeholder="66.40"></div>
        <input type="hidden" name="rate" value="${rate() ? Number(rate()).toFixed(2) : ''}">
        ${gateOn() ? '<p class="note"><b>The workflow gate is on.</b> ' + Gate.TEXT.deposit + '</p><input type="hidden" name="inmexc">'
          : '<label style="display:flex;gap:8px;align-items:flex-start"><input name="inmexc" type="checkbox" style="width:auto;min-height:0;margin-top:3px"> <span>Already seen in the exchange</span></label>'
            + '<label style="display:flex;gap:8px;align-items:flex-start"><input name="frommgr" type="checkbox" style="width:auto;min-height:0;margin-top:3px"> <span>They paid me directly: give them my units (nothing goes into the exchange)</span></label>'
            + '<div data-frommgr hidden><label>Exchange balance now (USDT, Spot + Futures, open trades included)</label><input name="eq" type="number" step="any" inputmode="decimal"></div>'}
        <details><summary>More options</summary><label>Note</label><input name="note"><label>When (only for late entries)</label><input name="at" type="datetime-local"></details>
        <div class="preview" id="depPrev">—</div><button class="full">Save</button></form></div>${pendingCard()}${spreadCard()}${topupCard()}`)}
      ${pick('wd', RH.button('wd') + (Gate.oldForm('withdrawal', S.queue) || `<div class="card"><h2>Money out</h2>
        <p class="note">Requests from investors are handled under <b>Balance</b> (approve, redeem, pay). Use this form only for a payout you are recording by hand.${pendNote()}</p>
        <form id="wdForm"><label>Who</label><select name="who">${holderOpts(S.recWho)}</select>
        <label>Exchange balance just before paying out (USDT)</label><input name="eq" type="number" step="any" inputmode="decimal" required>${BT.button('wdForm', 'eq')}
        <label>Amount (USDT)</label><input name="amt" type="number" step="any" inputmode="decimal" placeholder="100">
        <input type="hidden" name="units"><input type="hidden" name="reqid"><input type="hidden" name="rate" value="${rate() || ''}">
        <div id="wdPay"></div>${refFormNote()}
        <div class="btns"><button type="button" class="ghost" data-action="allunits">Everything they hold</button></div>
        <details><summary>More options</summary>
          <label style="display:flex;gap:8px;align-items:flex-start"><input name="tomgr" type="checkbox" style="width:auto;min-height:0;margin-top:3px"> <span>I pay from my own money (nothing leaves the exchange)</span></label>
          <label style="display:flex;gap:8px;align-items:center"><input name="force" type="checkbox" style="width:auto;min-height:0"> Inside lock-up: allow</label>
          <label>Note</label><input name="note"><label>When (only for late entries)</label><input name="at" type="datetime-local"></details>
        <div class="preview" id="wdPrev">—</div><button class="full">Save</button></form></div>`))}
      ${pick('eq', RH.button('eq') + (empty ? noBal : `${viewCapital()}${gBal ? '' : `<div class="card"><details><summary><b>More options</b>: type a balance directly, without the checks</summary>
        <p class="note">The quick old way. The checked route above is safer.</p>
        <form id="eqForm"><label>Exchange total (USDT)</label><input name="equity" type="number" step="any" inputmode="decimal" required ${empty ? 'disabled placeholder="Record the first deposit first"' : ''}>
        ${BT.button('eqForm', 'equity')}<input type="hidden" name="rate" value="${rate() || ''}">${refFormNote()}<label>Note</label><input name="note"><label>When (only for late entries)</label><input name="at" type="datetime-local">
        <div class="preview" id="eqPrev">—</div><button class="full ghost" ${empty ? 'disabled' : ''}>Save</button></form></details></div>`}${pendingCard()}`))}
      ${pick('hist', `<div class="card"><h2>History</h2>
        <p class="note">Only the latest entry can be undone; it adds a correction and erases nothing.</p>${recordHistoryRows()}</div>`)}`;
  }
  // Review & Settle. The preview is the database's own (admin_settlement_preview); this screen only asks for it and prints it. The Settle button stays off until
  // a preview for exactly the entered balance has come back, and any change to the balance hides the old figures instead of showing them for a different number.
  const spState = (eq, at) => (S.sp && S.sp.eq === eq && (S.sp.at || null) === (at || null) ? S.sp : null);
  // the preview's hash goes to the settlement, which refuses (server-side, when settlement_preview_mode = 'require') if the books changed since. Sent only when the
  // database returned one for exactly this balance and date; an older database that returns none gets no extra argument.
  const previewArg = (eq, at) => { const st = spState(eq, at); return st && st.status === 'ok' && st.pv && st.pv.preview_hash ? { p_preview: st.pv.preview_hash } : {}; };
  const spHtml = (st) => (!st ? '' : st.status === 'loading' ? SP.loading() : st.status === 'error' ? SP.unavailable(st.err) : SP.render(st.pv, spFmt));
  function syncSettle() {
    const fm = $f('qForm'), btn = $f('qSettle'), box = $f('spBox'); if (!fm || !btn || !box) return;
    const cur = spState(num(fv(fm, 'equity')), atOf(fm)), ok = !!cur && cur.status === 'ok';
    btn.disabled = !ok;
    if (S.sp && !cur && S.sp.status !== 'loading') box.innerHTML = '<p class="note warn" role="status">The balance or date changed. Press <b>Preview settlement</b> again to see the figures.</p>';
    else if (cur) box.innerHTML = spHtml(cur);
  }
  async function loadPreview(eq, at) {
    if (!(eq > 0)) { toast('Enter the exchange total first.', true); return; }
    const put = () => { const box = $f('spBox'); if (box) box.innerHTML = spHtml(S.sp); syncSettle(); };
    S.sp = { eq, at: at || null, status: 'loading' }; put();
    try { S.sp = { eq, at: at || null, status: 'ok', pv: await call('admin_settlement_preview', { p_equity: eq, p_at: at || null }) }; }
    catch (e) {
      if (e.message === 'Signed out') return;
      S.sp = { eq, at: at || null, status: 'error', err: /function|schema cache|does not exist/i.test(e.message) ? 'The database does not have this preview yet.' : e.message };
    }
    put();
  }
  // the confirmation before a settlement: the totals are the database's preview for this balance, or "not available" when none was run
  async function settleSheet(eq, at) {
    // a fresh preview right before the decision: an entry made since the last preview (a deposit, a payout, another screen) is included.
    // Without a fresh preview from the database nothing is settled.
    await loadPreview(eq, at);
    const st = spState(eq, at), pv = st && st.status === 'ok' ? st.pv : null;
    if (!pv) {
      await askSheet({ title: 'Not settled', info: true, text: 'The database did not return a fresh preview for this balance' + (st && st.err ? ': ' + st.err : '') + '.\nNothing was saved. Check the balance and try again.' });
      return false;
    }
    return !!(await askSheet({ title: 'Charge fees and settle this period?', danger: true, confirmLabel: 'Charge fees and settle',
      body: `<p class="note">Exchange total: <b>${esc(usdt(eq))}</b>. This ends the period and cannot be undone.</p>${SP.summary(pv, spFmt)}` }));
  }
  function viewQuarter() {
    if (!LEGACY) return SettleAuto.card(S.settle);   // js/settleauto.js: the automatic settlement's status; the typed-total settlement below is retired
    const gSet = Gate.oldForm('settlement', S.queue);
    if (gSet) {
      const bal = RD().ok ? Number(RD().balance) : 0;
      return gSet + `<div class="card"><h2>Review before settling</h2>${bal > 0 ? `<p class="note">Uses your confirmed balance of <b>${esc(usdt(bal))}</b>.</p><div class="btns"><button type="button" class="ghost" data-action="spgate" data-eq="${bal}">Preview settlement</button></div>` : '<p class="warn">Preview not available: there is no usable confirmed balance. Enter and confirm one under Record → Balance.</p>'}<div id="spBox">${bal > 0 ? spHtml(spState(bal, null)) : ''}</div></div><div class="card">${lastClose()}</div>`;
    }
    const cur0 = S.sp ? S.sp.eq : '';
    return `<div class="card"><h2>Review &amp; Settle</h2>
      <p class="note">Takes each investor's fee (their own %, 20% by default) on their <b>gain above their high-water mark</b>: their best value after fees, raised by every deposit. After a loss nothing is charged until they are back above the mark. The share moves as <b>units</b> from them to you, still inside the pool. Deposits and withdrawals never count as profit or loss.</p>
      <p class="note">Once per two-month period (Jan–Feb, Mar–Apr, May–Jun, Jul–Aug, Sep–Oct, Nov–Dec, Manila time), in the first 7 days after it ends. Confirm the exchange balance under <b>Record → Balance</b> first (or approve an exception with your reason). Whether open trades are allowed depends on the fee rule: the preview says so (with the confirmed-gain fee they are, as a heads-up).</p>
      ${lastClose()}
      ${S.pend.length ? `<p class="note">${pendNote()} Deposits in the exchange buy units at the close price after the fee, so they pay nothing for this period.</p>` : ''}
      <form id="qForm"><label>Pool equity now (USDT, the exchange total)</label><input name="equity" type="number" step="any" inputmode="decimal" value="${cur0}" required>${BT.button('qForm', 'equity')}
      ${phpField()}<label>Note (optional)</label><input name="note" value="Two-month settlement">
      <div class="btns"><button type="button" class="ghost" data-action="sppreview">Preview settlement</button></div>
      <div id="spBox" aria-live="polite"><p class="note">Press <b>Preview settlement</b> to see each person's fee, worked out by the database. Nothing is saved by a preview.</p></div>
      <button class="full" id="qSettle" disabled>Charge fees and settle the period</button></form></div>`;
  }
  function lastClose() {
    const c = S.elog.find((e) => e.kind === 'close');
    if (!c) return '<p class="note"><b>No settlement yet.</b></p>';
    const days = Math.floor((Date.now() - new Date(c.ts).getTime()) / 864e5);
    return `<p class="note ${days > 62 ? 'warn' : ''}"><b>Last settlement: ${day(c.ts)}</b> (${days} days ago)${days > 62 ? ': a two-month settlement is due' : ''}</p>`;
  }
  function viewLog() {
    const pend = S.reqs.filter((q) => q.status === 'pending');
    return `<div class="card"><h2>Withdrawal requests</h2><p class="note" style="margin-top:0">You send these by hand. Their receiving details are under each request; contact them to confirm before sending.</p>${pend.length ? pend.map((q) => `<div class="row"><span class="l"><b style="color:var(--ink)">${esc(q.name)}</b><br>${money(q.units * S.pool.unit_price)} (${f(q.units, 4)} units) · asked ${day(q.requested_at)}<br><span class="note">Pay by ${day(q.pay_by)}</span></span>
      <span class="r"><button data-action="payreq" data-id="${q.id}" data-who="${q.profile_id}" data-units="${q.units}">Prepare payout</button></span></div>
      <details class="paydet" open><summary class="note">Where to send it</summary>${payoutBlock(payOf(q.profile_id))}</details>`).join('') : '<p class="note">None pending.</p>'}</div>
      <div class="card"><h2>All entries</h2>${activityRows(S.ledger, true)}</div>
      <div class="card"><h2>Equity readings</h2>${S.elog.length ? S.elog.slice(0, 60).map((e) => `<div class="row"><span class="l">${day(e.ts)} · ${esc(e.kind)}${e.note ? `<br><span class="note">${esc(e.note)}</span>` : ''}</span>
        <span class="r">${money(e.equity_usdt)}<br><span class="note">${usdt(e.equity_usdt)} · price ${f(e.unit_price, 4)}</span></span></div>`).join('') : '<p class="note">None yet.</p>'}</div>${auditCard()}${backupCard()}`;
  }

  // ---------------------------------------------------------------- Balance desk (manager, shown under Record → Balance): balance check, queue, payouts. All numbers come from the database.
  const RD = () => (S.queue && S.queue.ready) || { ok: false, reasons: [] };
  function viewCapital() {
    if (!S.queue) return '<div class="card"><p class="note">The capital workflow is not installed in the database yet (run 20261106000000_capital_workflow.sql).</p></div>';
    const q = S.queue, rd = q.ready, checks = (S.checks && S.checks.checks) || [], cur = checks[0];
    const chip = (t) => `<span class="chip">${esc(t)}</span>`;
    const bal = cur ? `<div class="row"><span class="l">Previous verified<br><span class="note">${cur.prev_source === 'verification' ? 'balance check #' + cur.prev_id : 'from the books'}</span></span><span class="r">${usdt(cur.prev_total)}</span></div>
      <div class="row"><span class="l">Entered</span><span class="r"><b>${usdt(cur.mexc_total)}</b> ${chip(cur.status)}</span></div>
      <div class="row"><span class="l">Known money in / out</span><span class="r">+${usdt(cur.known_in)} / −${usdt(cur.known_out)}</span></div>
      <div class="row"><span class="l">Deposits waiting (in the exchange / not yet)</span><span class="r">${usdt(cur.waiting_arrived)} / ${usdt(cur.waiting_not_arrived)}</span></div>
      <div class="row"><span class="l">Recorded trading result, fees, other</span><span class="r">${usdt(cur.adjusted_total)}${(cur.adjustments || []).map((a) => `<br><span class="note">${esc(a.kind)} ${smoney(a.amount)} · ${esc(a.note)}</span>`).join('')}</span></div>
      <div class="row"><span class="l">Expected from the above</span><span class="r">${usdt(cur.expected_total)}</span></div>
      <div class="row"><span class="l"><b>Unexplained difference</b></span><span class="r ${Math.abs(cur.residual) > cur.tolerance ? 'down' : 'up'}"><b>${smoney(cur.residual)}</b></span></div>
      <div class="row"><span class="l">Open positions</span><span class="r">${cur.open_positions} of 2${cur.snapshot ? ' (bot: ' + cur.snapshot.open_positions + ')' : ''}</span></div>
      <div class="btns">${cur.status === 'entered' ? `<button data-action="wfconfirm" data-id="${cur.id}">Confirm this balance</button><button class="ghost" data-action="wfreject" data-id="${cur.id}">Reject</button>` : ''}
        ${cur.status !== 'rejected' && cur.status !== 'superseded' && !cur.first_used_at ? `<button class="ghost" data-action="wfadjust" data-id="${cur.id}">Explain part</button>${PU.count(S.pu) > 0 ? `<button class="ghost" data-action="wfclassifypool" data-id="${cur.id}">Classify beyond the pending trades</button>` : ""}<button class="ghost" data-action="wfclassify" data-id="${cur.id}">Classify the rest</button>` : ''}</div>
      <p class="note">Confirming only records that this is the balance on the exchange. It does not change anyone's value or issue units. The difference stays unexplained until you explain or classify it.</p>` : '<p class="note">No balance entered yet.</p>';
    const depRows = q.deposits.map((d) => `<div class="row"><span class="l"><b>${esc(d.name)}</b> · ${usdt(d.usdt)}<br><span class="note">${chip(d.state.replace('_', ' '))} ${esc(d.reason || '')}${d.escalate ? ' <b class="warn">Escalate</b>' : ''}</span></span>
      <span class="r">${d.state === 'awaiting_arrival' ? `<button class="ghost sm" data-action="wfarrive" data-id="${d.id}">Seen in the exchange</button>` : PU.admitMode(S.pu) === 'update_first' ? `<label class="note"><input type="checkbox" class="pu-pick" value="${d.id}"> accept with Update Pool</label>` : d.state === 'ready' ? `<button class="sm" data-action="wfadmit" data-id="${d.id}">Admit</button>` : ''}
        ${d.escalate ? `<button class="ghost sm" data-action="wfescalate" data-kind="deposit" data-id="${d.id}">Escalate</button>` : ''}</span></div>`).join('') || '<p class="note">No deposits waiting.</p>';
    const wdRows = q.withdrawals.map((w) => `<div class="row"><span class="l"><b>${esc(w.name)}</b> · ${f(w.units, 4)} units · pay by ${day(w.pay_by)}<br><span class="note">${payLine(w.profile_id)}</span><br><span class="note">${chip(w.state.replace('_', ' '))} ${w.delayed ? '<b class="warn">Delayed</b> ' : ''}${w.in_lockup ? 'inside lock-up ' : ''}${w.lock_exception ? '(exception recorded) ' : ''}${esc(w.reason || '')}${w.payout && w.payout.failure_reason ? ' ' + esc(w.payout.failure_reason) : ''}</span></span>
      <span class="r">${w.state === 'awaiting_approval' ? `<button class="sm" data-action="wfapprove" data-id="${w.id}" data-lock="${w.in_lockup}">Approve</button><button class="ghost sm" data-action="wfrejectwd" data-id="${w.id}">Reject</button>`
        : w.state === 'ready' ? `<button class="ghost sm" data-action="wfquote" data-id="${w.id}">Quote</button><button class="sm" data-action="wfexec" data-id="${w.id}">Redeem</button>`
        : w.state === 'payout_awaiting' ? `<button class="sm" data-action="wfsent" data-id="${w.id}" data-leaves="${w.payout.leaves_mexc}">${w.payout.leaves_mexc ? 'Sent from the exchange' : 'Paid'}</button><button class="ghost sm" data-action="wffail" data-id="${w.id}">Failed</button>`
        : w.state === 'payout_sent' ? `<button class="sm" data-action="wfcomplete" data-id="${w.id}">Completed</button><button class="ghost sm" data-action="wffail" data-id="${w.id}">Failed</button>`
        : w.state === 'payout_failed' ? `<button class="sm" data-action="wfretry" data-id="${w.id}">Retry</button>` : ''}
        ${w.escalate ? `<button class="ghost sm" data-action="wfescalate" data-kind="withdrawal" data-id="${w.id}">Escalate</button>` : ''}</span></div>`).join('') || '<p class="note">No withdrawal requests open.</p>';
    return `${PU.pendingCard(S.pu, rd)}${PU.reconCard(S.pu)}<div class="card"><h2>Balance check</h2>
        <p class="note">${rd.ok ? '<b class="up">Ready:</b> a confirmed, flat, explained balance is available for deposits, payouts and settlement.' : '<b class="warn">Money is waiting.</b> ' + rd.reasons.map((r) => esc(r.text)).join(' ')}${q.gate === 'on' ? '' : ' (The workflow gate is off: the old direct forms still work.)'}</p>
        <form id="wfBal"><label>Exchange total balance (USDT)</label><input name="total" type="number" step="any" inputmode="decimal" required>${BT.button('wfBal', 'total')}
          <div class="grid form2"><div><label>Open positions (0, 1 or 2)</label><input name="pos" type="number" min="0" max="2" value="0" required></div><div><label>Open orders</label><input name="ord" type="number" min="0" value="0"></div></div>
          <button class="full">Enter balance (not confirmed yet)</button></form>${bal}</div>
      <div class="card"><h2>Deposits (${q.deposits.length})</h2>${depRows}${PU.admitMode(S.pu) === 'update_first' && PU.ready(rd).ok && q.deposits.some((d) => d.state !== 'awaiting_arrival') ? '<div class="btns"><button data-action="poolupdateadmit">Update Pool and accept ticked</button></div><p class="note">One step: the pool is updated to the confirmed balance first, then the ticked joiners buy in at that price. If anything fails, nothing is saved.</p>' : ''}</div>
      <div class="card"><h2>Withdrawals and payouts (${q.withdrawals.length})</h2>${wdRows}
        <p class="note">Requests wait until both positions are closed and the balance is confirmed and explained. Past ${q.escalate_after_hours} hours, or past the pay-by date, they are flagged for escalation.</p></div>
      ${rd.ok ? `<div class="card"><h2>Valuation and settlement</h2><div class="btns"><button type="button" class="ghost" data-action="spgate" data-eq="${Number(rd.balance)}">Preview settlement</button><button class="ghost" data-action="wfapply">Apply verified balance</button><button data-action="wfsettle">Settle two-month period</button></div><div id="spBox">${spHtml(spState(Number(rd.balance), null))}</div></div>` : ''}`;
  }
  const usable = () => RD().verification_id;
  // money steps through the Balance desk: the same request keeps the same key until it succeeds (a resend after a lost reply is a replay, not a second action)
  const moneyWF = (fn, args) => withStableKey(fn, args, async (key) => {
    try { return await call(fn, { ...args, p_idem: key }); }
    catch (e) {
      if (!/^CONFIRM: /.test(e.message) || !(await confirmSheet('Check this before continuing', e.message.replace(/^CONFIRM: /, ''), 'Continue anyway'))) throw e;
      return call(fn, { ...args, p_idem: key, p_confirm: true });
    }
  });
  const KINDS_ALL = [['trading_pnl', 'Trading result'], ['fees', 'Fees'], ['funding', 'Funding'], ['transfer', 'Transfer'], ['timing', 'Timing'], ['other', 'Other']];
  const askKind = async (title, text, kinds, noteLabel, o = {}) => {
    const r = await askSheet({ title, text, confirmLabel: 'Save', fields: [
      { name: 'kind', label: 'What is it?', type: 'select', options: kinds, value: o.kind },
      ...(o.amount ? [{ name: 'amount', label: 'Amount in USDT (negative for a loss or cost)', type: 'number', required: true }] : []),
      { name: 'note', label: noteLabel, type: 'textarea', required: true, minLength: 5, hint: 'Written to the record.' }] });
    if (!r) throw new Cancelled();
    return r;
  };
  const wdRow = (id) => ((S.queue && S.queue.withdrawals) || []).find((w) => Number(w.id) === Number(id));
  // Update Pool: the request carries exactly what this screen displayed; one request id per displayed state, so a double-click is a replay, not a second update
  let puSig = null, puKey = null;
  const poolUpdate = async (depositIds) => {
    const st = S.pu, vid = usable(), last = (st.updates || [])[0];
    const sig = [vid, (st.pending.ids || []).join(','), st.pending.usd, last ? last.id + last.status : '-', depositIds.join(',')].join('|');
    if (sig !== puSig) { puSig = sig; puKey = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }
    const fn = depositIds.length ? 'admin_update_pool_and_admit' : 'admin_update_pool';
    const mk = (extra) => (depositIds.length ? PU.requestAndAdmit(st, vid, puKey, depositIds, extra) : PU.request(st, vid, puKey, extra));
    let r;
    try { r = await call(fn, mk({})); }
    catch (e) { if (!/^CONFIRM: /.test(e.message) || !(await confirmSheet('Check this before continuing', e.message.replace(/^CONFIRM: /, ''), 'Continue anyway'))) throw e; r = await call(fn, mk({ confirm: true })); }
    if (r && r.blocked) throw new Error(r.text || 'Blocked by the reconciliation.');
    return r;
  };
  const WF = {
    poolupdate: () => poolUpdate([]),
    poolupdateadmit: () => { const ids = [...document.querySelectorAll('input.pu-pick:checked')].map((i) => Number(i.value)); if (!ids.length) throw new Error('Tick the joiners to accept with this update.'); return poolUpdate(ids); },
    wfclassifypool: async (id) => { const r = await askKind('Classify what the pending trades do not explain', 'The pending trades already explain their own part. Say what the rest is.', KINDS_ALL.filter((k) => k[0] !== 'trading_pnl'), 'Why?', { kind: 'fees' }); return call('admin_classify_pool_difference', { p_vid: id, p_kind: r.kind, p_note: r.note }); },
    wfconfirm: (id) => call('admin_confirm_balance', { p_vid: id }),
    wfreject: async (id) => call('admin_reject_balance', { p_vid: id, p_reason: await askText('Reject this balance entry', 'Why is this entry wrong?', { ok: 'Reject entry', danger: true }) }),
    wfadjust: async (id) => { const r = await askKind('Explain part of the difference', 'Name a piece of the difference with its source.', KINDS_ALL, 'Source (for example the exchange statement line)', { amount: true, kind: 'trading_pnl' }); return call('admin_add_adjustment', { p_vid: id, p_kind: r.kind, p_amount: Number(r.amount), p_note: r.note }); },
    wfclassify: async (id) => { const r = await askKind('Classify the unexplained rest', 'This records what the rest of the difference is. It changes nobody\'s units.', KINDS_ALL, 'Why?', { kind: 'trading_pnl' }); return call('admin_classify_difference', { p_vid: id, p_kind: r.kind, p_note: r.note }); },
    wfarrive: async (id) => call('admin_confirm_arrival', { p_pending: id, p_note: await askText('Seen in the exchange', 'How did you see it arrive in the exchange?', { ok: 'Confirm arrival', hint: 'For example the exchange deposit record.' }) }),
    wfadmit: (id) => moneyWF('admin_admit_deposit', { p_pending: id, p_vid: usable() }),
    wfapprove: async (id, b) => call('admin_approve_withdrawal', { p_request: id, p_note: null, p_lock_reason: b.dataset.lock === 'true' ? await askText('Approve inside the lock-up', 'This person is inside the lock-up shown to investors. Why do you approve it (exception)?', { min: 10, ok: 'Approve with exception' }) : null }),
    wfrejectwd: async (id) => call('admin_reject_withdrawal', { p_request: id, p_reason: await askText('Reject this request', 'Reason (the investor is told)', { ok: 'Reject request', danger: true }) }),
    wfquote: async (id) => {
      const r = await call('admin_quote_withdrawal', { p_request: id, p_vid: usable() });
      await askSheet({ title: 'Quote from the accounting engine', info: true, text: 'Nothing is saved by a quote.\nUnit price ' + (r && r.unit_price != null ? f(r.unit_price, 6) : 'not available') + '\nFee units ' + (r && r.fee_units != null ? f(r.fee_units, 6) : 'not available') + '\nPayout ' + (r && r.pay_usdt != null ? usdt(r.pay_usdt) : 'not available') });
    },
    wfexec: async (id) => {
      const w = wdRow(id);
      const r = await askSheet({ title: 'Redeem this withdrawal?', danger: true, confirmLabel: 'Redeem now',
        text: (w ? w.name + ': ' + f(w.units, 4) + ' units.\n' : '') + 'Their units are sold at the confirmed balance\'s price and a payout is created. This cannot be undone here.',
        fields: [{ name: 'src', label: 'How will you pay?', type: 'select', value: 'exchange', options: [['exchange', 'From the exchange (money leaves the account)'], ['manager', 'From my own money (nothing leaves the exchange)']] }] });
      if (!r) throw new Cancelled();
      return moneyWF('admin_execute_withdrawal', { p_request: id, p_vid: usable(), p_to_manager: r.src === 'manager' });
    },
    wfsent: async (id, b) => (b.dataset.leaves === 'true' ? call('admin_payout_sent', { p_request: id, p_reference: await askText('Sent from the exchange', 'Exchange withdrawal reference', { min: 3, type: 'text', ok: 'Mark as sent' }) })
      : call('admin_payout_complete', { p_request: id, p_reference: await askText('Mark as paid', 'Proof of payment', { min: 3, type: 'text', ok: 'Mark as paid' }) })),
    wfcomplete: async (id) => call('admin_payout_complete', { p_request: id, p_reference: await askText('Payout completed', 'Payment reference (bank, GCash, Maya, etc.)', { min: 3, type: 'text', ok: 'Mark as completed' }) }),
    wffail: async (id) => call('admin_payout_fail', { p_request: id, p_reason: await askText('Payout failed', 'What went wrong?', { ok: 'Mark as failed', danger: true }) }),
    wfretry: (id) => call('admin_payout_retry', { p_request: id }),
    wfescalate: async (id, b) => call('admin_escalate', { p_kind: b.dataset.kind, p_id: id, p_note: await askText('Escalate', 'What will you do about it?', { ok: 'Escalate' }) }),
    wfapply: () => moneyWF('admin_apply_balance', { p_vid: usable() }),
    wfsettle: () => withSettlementExceptions(() => moneyWF('admin_settle_quarter', { p_vid: usable(), ...previewArg(Number(RD().balance), null) }), Number(RD().balance), null),
  };

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
      <p class="note" style="margin:4px 2px 0">These pages are plain links, outside the sign-in area, so the address can be handed straight to someone outside Lucid'io — the "Open library" button above is the public, shareable page.</p>`;
  }
  // ---------------------------------------------------------------- shell
  const TABS = {
    investor: [['home', 'Home'], ['calendar', 'Calendar'], ['withdraw', 'Withdraw'], ['statements', 'Statements'], ['activity', 'Activity'], ['about', 'About']],
    admin: [['dashboard', 'Dashboard'], ['users', 'Users'], ['record', 'Record'], ['quarter', 'Settle'], ['reports', 'Reports'], ['log', 'Log']],   // side "Fund": the pool, everyone, reports
    adminMe: [['mine', 'My account'], ['statements', 'Statements'], ['myhistory', 'History']],                                                                              // side "My account": only the fund manager's own money
  };
  const viewCalendar = () => `<div class="sechead"><h2>Calendar</h2></div>${calendarCard()}`;
  const VIEWS = { calendar: viewCalendar, profile: viewProfile, contact: viewContact, payout: viewPayout, withdraw: viewWithdraw, home: viewHome, activity: viewActivity, about: viewAbout, dashboard: viewDashboard, users: viewUsers, capital: viewCapital, record: viewRecord, quarter: viewQuarter, log: viewLog, reports: viewReports, mine: viewMine, myhistory: viewMyHistory, statements: viewStatements };
  const TABICON = { users: 'people', capital: 'pool', dashboard: 'dash', myhistory: 'activity', statements: 'reports' };
  const tabsFor = () => (isAdmin() ? TABS[S.side === 'me' ? 'adminMe' : 'admin'] : TABS.investor);

  // ---------------------------------------------------------------- gates after sign-in: terms -> quote screen -> tour
  // An investor must agree to the terms (saved in the database, per version) before seeing anything. Then a quote screen, then the animated
  // tour (once per device; "Welcome tour" in the menu replays it). None of this shows while the fund manager is "viewing as" someone.
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
      ['You can lose money, and it could be a lot', `Lucid'io trades in cryptocurrency markets, which can move very fast and very far, sometimes within minutes. The account may use leverage (trading with more than the money in it), which can make losses bigger as well as gains. The pool can fall sharply, <b>you can lose a large part or all of the money you put in</b>, and there will be weeks and months when your balance is down. Only use money you can afford to lose: never money for rent, food, school, bills or emergencies, and never borrowed money.`],
      ['Nothing is guaranteed', `Nobody has promised you any return, and nobody can. Past results and backtests are simulations made with hindsight. They are not a promise, and a good stretch says nothing certain about the next one.`],
      ['Not a bank, not insured', `This app is a record, kept by the fund manager, of your share of a pooled trading account. It is not a bank account or a deposit, and it is not insured or guaranteed by any bank or government body. If the exchange, the account or the fund manager has a problem (a hack, an outage, a mistake, a freeze), <b>you may not get your money back</b>.`],
      ['Lock-up and withdrawals', `Your <b>first deposit</b> is locked for <b>${C.LOCK_MONTHS} months</b> from the day it joins the pool; later top-ups have no lock-up. If you need money earlier, ask the fund manager, who may agree. After that you can ask to withdraw some or all of it. It is paid within <b>${C.WITHDRAW_BUSINESS_DAYS} business days</b> (Monday to Friday, not counting weekends), at the value on the day it is paid, which can be lower than on the day you asked. ${EXIT_FEE_ON ? `<b>Withdrawal fee:</b> ${S.exit ? `${pc(S.exit.young_rate)}% of what you withdraw while your account is under 1 year old, and ${pc(S.exit.mature_rate)}% after that` : '5% of what you withdraw while your account is under 1 year old, and 2% after that'}. It comes off the payout, on top of the performance fee. ` : `<b>Withdrawal fee:</b> none for now. ${FEE_SOON} `}<b>Minimum withdrawal:</b> ${php(minPhp() || 500)} (taking everything you hold is always allowed).`],
      ['How new money joins', `Money you hand over first waits. It joins the pool at the next valuation (when the fund manager updates the pool’s total value) and buys units at that day’s price. So the price you get can be higher or lower than on the day you handed the money over. This protects everyone: nobody shares in profit made before their money was in.`],
      ['The fee', `The fee is <b>${rate}%</b> of <b>new profit above your high-water mark</b>: the best value your balance has reached after fees, raised by every amount you add. It is settled every two months inside the pool (no cash moves). Nothing is charged on the money you put in or on profit made before you joined. <b>After a loss, nothing is charged until your balance is back above your mark</b>, and taking money out or leaving and coming back does not erase a loss you still have to make back. If you withdraw while above your mark, the fee on that share of the gain is taken at the withdrawal. The rate can be lowered at any time; a higher rate only starts after the next two-month settlement, and your Home page tells you before it does.`],
      ['What the numbers mean', `Your balance is an estimate. It follows the pool’s value as entered by the fund manager from the exchange account (daily or weekly, not live), and it is shown in pesos at an exchange rate that moves on its own, so your peso balance can change even when the trading did not.`],
      ['Your login and this agreement', `Keep your password private: anything done with your login counts as done by you. We save the date you agreed to these terms. If the terms change, you will be asked to read and agree again.`],
    ];
  }
  function termsView() {
    const ro = S.termsRO;
    app.innerHTML = `<header><span class="hello">Lucid'io · before you start</span><div class="hdr-actions">${themeBtn()}</div></header>
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
  const QUOTE = ['Compound interest is the', 'eighth wonder of the world. He', 'who understands it, earns it.', 'He who doesn’t, pays it.'];
  function splashView() {
    if (!S.splashT) S.splashT = setTimeout(() => { S.splashT = null; if (S.gate === 'splash') startTour(); }, SPLASH_MS);
    app.innerHTML = `<div class="splash" style="--ms:${SPLASH_MS}ms">
      <div class="qwrap"><blockquote class="quote"><span class="qm">“</span>${QUOTE.join('<br>')}<span class="qm">”</span></blockquote>
      <p class="by">Albert Einstein</p></div>
      <div class="foot"><div class="loadbar"><i style="animation-duration:${SPLASH_MS}ms"></i></div><p class="note" style="margin:0 0 8px">Getting your account ready…</p>
      <button class="ghost sm" data-action="splashskip">Skip</button></div></div>`;
  }

  // plain-words glossary (tour + About page)
  const GLOSSARY = [
    ['USDT', 'A digital coin built to stay worth about 1 US dollar. The pool is counted in USDT; the app shows it in pesos at the day’s exchange rate.'],
    ['Equity', 'The total value of the whole pool right now, including trades that are still open.'],
    ['Unit', 'A slice of the pool. You own a number of units. It only changes when you add money, take money out, or pay a fee.'],
    ['Unit price', 'What one unit is worth today. It rises when the pool gains and falls when it loses, by the same % for everyone.'],
    ['Valuation', 'When the fund manager updates the pool’s total value. New money joins at the price set at a valuation.'],
    ['Compounding', 'Profit staying in the pool and earning on itself. Losses compound too: they shrink what future gains build on.'],
    ['Drawdown', 'How far the balance has fallen from its highest point. A 50% fall needs a 100% gain to get back.'],
    ['High-water mark', 'The best value your balance has reached after fees, plus anything you added since. The fee is only charged on profit above it, so a loss is made back before any fee.'],
    ['Lock-up', 'The time after your first deposit when it should stay in. Top-ups have none.'],
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
    share: (keep) => `<div class="scene"><svg viewBox="0 0 300 130" class="mini" role="img" aria-label="The fee is charged only on the gain above your best balance so far">
        <clipPath id="above"><rect x="0" y="0" width="300" height="80"/></clipPath>
        <line class="dash" x1="0" y1="80" x2="300" y2="80"/><text class="lab" x="4" y="95" style="--d:.8s">your high-water mark</text>
        <path class="ln faint" pathLength="1" d="M0 116 L40 100 L80 108 L120 70 L160 50 L200 78 L240 40 L300 30"/>
        <path class="ln hot" pathLength="1" clip-path="url(#above)" d="M0 116 L40 100 L80 108 L120 70 L160 50 L200 78 L240 40 L300 30"/>
        <text class="lab hot" x="4" y="14" style="--d:1.6s">Fee only on the gain above it</text></svg>
      <div class="split" style="margin-top:12px"><i class="grow-x" style="width:${keep}%;background:var(--up)"></i><i class="grow-x" style="width:${100 - keep}%;background:var(--seg3)"></i></div>
      <div class="legend"><span><b style="background:var(--up)"></b>You keep ${pc(keep / 100)}% of new profit</span><span><b style="background:var(--seg3)"></b>Fund manager ${pc(1 - keep / 100)}%</span></div></div>`,
    tabs: () => `<div class="scene"><div class="mininav" aria-hidden="true">${[['home', 'Home'], ['withdraw', 'Withdraw'], ['activity', 'Activity'], ['about', 'About']].map(([k, l], i) => `<span style="--i:${i}">${ICON[k]}<b>${l}</b></span>`).join('')}</div>
      <div class="tabrows">${[['Home', 'your balance, the key figures at a glance and how your money got there.'], ['Withdraw', 'what you can take out now and the request form.'], ['Activity', 'every deposit, withdrawal and fee, in order.'], ['About', 'how it all works, in plain words, and your agreement.']]
        .map(([t, d], i) => `<p style="--i:${i}"><b>${t}</b> · ${d}</p>`).join('')}</div></div>`,
  };
  function tourSteps() {
    const m = S.me, first = esc(String(m.name || m.username).split(' ')[0]);
    if (isAdmin()) return [
      [ICON.logo, `Welcome to Lucid'io, ${first}`, `<p class="about"><b>Clear rules. Real growth.</b></p>
        <p class="about">This is the fund manager side of Lucid'io Ledger, the paper record of who owns what in the pool. No money moves through this app: the real money stays in the exchange account. Investors only ever see their own balance; you see everyone.</p>
        <p class="about">Use the <b>Fund / My account</b> switch at the top: <b>Fund</b> is the pool and everyone’s records, <b>My account</b> is your own capital, the fee you have earned and your own growth.</p>`],
      [ICON.record, 'Your routine', `<p class="about"><b>Nothing to value by hand:</b> the unit price follows the bots’ MEXC wallet reports every 5 minutes, open trades included, and every balance and chart moves with it.</p>
        <p class="about"><b>Record</b> has your four steps: <b>Add investor</b>, <b>Cash in</b> (pesos + the USDT that arrived; it joins at the live price once MEXC shows it), <b>Withdraw</b> (redeemed at the live price, then send it from MEXC and mark it sent) and <b>Transfer</b> (ownership between two people, nobody else’s value moves).</p>
        <p class="about"><b>Settle:</b> every two months. Confirm the exchange balance under Record → Balance, check the preview, then charge the fee. A raised % starts after the next settlement.</p>`],
      [ICON.people, 'Handy tools', `<p class="about"><b>Users → + Add user</b> creates a login. Send them the username and password; they must agree to the terms before they see anything, and you can see who has.</p>
        <p class="about"><b>View as</b> opens the app exactly as that person sees it (read-only).</p>
        <p class="about"><b>Log</b> keeps every entry. Nothing is erased: a mistake is fixed with a correction entry.</p>`],
    ];
    const keep = Math.round((1 - Number(m.fee_rate)) * 10000) / 100;
    return [
      [ICON.logo, `Welcome to Lucid'io, ${first}`, `<p class="about"><b>Clear rules. Real growth.</b></p>
        <p class="about">Here is a one-minute tour of what you will see, in plain words. Tap <b>Skip</b> any time; you can replay it from <b>Welcome tour</b> in the menu (☰, top right).</p>`],
      [ICON.pool, 'Your share of the pool', `<p class="about">Everyone’s money goes into <b>one pool</b>: a single trading account, together with the fund manager’s own money. When you put money in you get <b>units</b>, slices of the pool.</p>
        <p class="about"><b>Unit price</b> is what one slice is worth today. Your balance is simply your units × the unit price.</p>`, SCENE.pool()],
      [ICON.arrowOut, 'Ups and downs', `<p class="about">Trading results move the unit price: gains lift every unit, losses lower every unit, by the same % for everyone.</p>
        <p class="about">Profit stays in the pool and keeps working. That is <b>compounding</b>, and it works both ways: a loss shrinks what future gains build on. A fall from the highest point is a <b>drawdown</b>. It will happen, and climbing back takes longer than falling (a 50% fall needs a 100% gain to recover).</p>`, SCENE.ups()],
      [ICON.record, 'New money joins fairly', `<p class="about">Money you hand over does not join instantly. It waits for the next <b>valuation</b> (when the fund manager updates the pool’s total value) and buys units at that day’s price.</p>
        <p class="about">So nobody shares in profit made before their money was in, you included. While it waits, you will see it on Home under <b>Waiting to join</b>.</p>`, SCENE.join()],
      [ICON.lock, 'Lock-up and withdrawals', `<p class="about">Your first deposit is <b>locked</b> for <b>${C.LOCK_MONTHS} months</b> from the day it joins; top-ups have no lock-up. After that, tap <b>Request withdrawal</b> on the <b>Withdraw</b> tab. It is paid within <b>${C.WITHDRAW_BUSINESS_DAYS} business days</b>, at the value on the day it is paid.</p>`, SCENE.lock()],
      [ICON.fee, 'The fee', `<p class="about">The fee applies only to new profit: <b>${pc(m.fee_rate)}%</b> of what your balance gains <b>above its best so far</b> (your high-water mark). Nothing on the money you put in, nothing on profit made before you joined.</p>
        <p class="about">It is settled every two months inside the pool, so no cash moves. After a loss, nothing is charged until you are back above your best.</p>`, SCENE.share(keep)],
      [ICON.home, 'Your screens', `<p class="about">Open the <b>menu</b> (☰, top right) for your profile, how to reach you and where to send your money, and to refresh, switch between pesos and USD, or change light or dark. A <b>red dot</b> there means something is still missing. Everything else is read-only: you can look, and request a withdrawal on the <b>Withdraw</b> tab.</p>`, SCENE.tabs()],
      [ICON.about, 'Words you’ll see', glossHtml()],
    ];
  }
  function tourView() {
    const steps = tourSteps(), i = Math.max(0, Math.min(S.welcome, steps.length - 1)), [icon, title, body, scene] = steps[i], last = i === steps.length - 1;
    app.innerHTML = `<header><span class="hello">Lucid'io · ${i + 1} of ${steps.length}</span>
      <div class="hdr-actions">${themeBtn()}${last ? '' : '<button class="ghost sm" data-action="welcomedone">Skip</button>'}</div></header>
      <div class="login-brand welcome"><span class="logo">${icon}</span><h1>${title}</h1></div>
      <div class="card enter">${scene || ''}${body}
        <div class="steps" aria-hidden="true">${steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="btns">${i ? '<button class="ghost" data-action="welcomeback">Back</button>' : ''}
          <button data-action="${last ? 'welcomedone' : 'welcomenext'}">${last ? (isAdmin() ? 'Open the dashboard' : 'Take me to my account') : 'Next'}</button></div></div>`;
  }
  const gateView = () => (S.gate === 'terms' ? termsView() : S.gate === 'splash' ? splashView() : tourView());

  function loginView() {
    syncNav();
    app.innerHTML = `<div class="login-brand login"><span class="logo">${ICON.logo}</span><h1>Lucid'io</h1><p class="tagline">Where Market Meets Compounding</p></div>
      <div class="card"><h2>Sign in</h2>
      <form id="loginForm"><label>Username</label><input name="username" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" required>
      <label>Password</label>${pw('password', 'current-password')}
      <div id="loginErr" class="alert" role="alert" hidden></div>
      <button class="full">Sign in</button></form>
      </div>${DISC}`;
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
    if (!PAGES.includes(S.tab) && !tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    app.innerHTML = `<header><div><div class="hello">${greeting()}${isAdmin() ? (S.side === 'me' ? ' · my account' : ' · fund manager') : ''}</div><h1>${esc(S.me.name || S.me.username)}</h1></div>
      <div class="hdr-actions">${isAdmin() && !viewing ? `<button class="iconbtn add" data-tab="record" data-goside="fund" aria-label="New record" title="New record">${ICON.record}</button>` : ''}${settingsMenu(!viewing, !!viewing)}</div></header>
      ${isAdmin() && !viewing ? `<div class="ranges sidesw" role="tablist" aria-label="Side">${[['fund', 'Fund'], ['me', 'My account']].map(([k, l]) => `<button role="tab" aria-selected="${(S.side === 'me') === (k === 'me')}" class="${(S.side === 'me') === (k === 'me') ? 'on' : ''}" data-side="${k}">${l}</button>`).join('')}</div>` : ''}
      ${VIEWS[S.tab]()}
      <nav class="tabs" aria-label="Sections"><div class="bar">${tabs.filter(([k]) => k !== 'record').map(([k, l]) => `<button data-tab="${k}" aria-label="${l}" title="${l}" class="${k === S.tab ? 'on' : ''}" aria-current="${k === S.tab ? 'page' : 'false'}">${ICON[k === 'home' && isAdmin() ? 'mine' : TABICON[k] || k]}</button>`).join('')}</div></nav>
      ${viewing ? `<button class="vaback" data-action="exitview" aria-label="Back to the fund manager's ledger" title="Back to the fund manager's ledger">${ICON.back}<span>Back to admin</span></button>` : ''}
      ${viewing ? '' : userModal()}`;
    app.classList.toggle('va', !!viewing);   // room under the last card for the "Back to admin" pill
    wirePreviews(); wireChart(); wireLive(); syncNav();
  }

  // ---------------------------------------------------------------- Back button (phone and browser)
  // Every screen the person moves to (tab, side, an open user sheet, "view as") is a history entry, so Back steps through the app instead of leaving it.
  // Re-rendering for fresh data changes nothing here; the sign-in and the terms/tour screens replace the entry instead of adding one.
  const NAV_KEYS = ['uid', 'tab', 'side', 'rec', 'modal', 'vw', 'gate'];
  // Every page has its own address, and /login is only the sign-in page:
  //   investor   /dashboard  /calendar  /withdraw  /statements  /activity  /about  /profile  /contact  /payout
  //   manager    /fund/dashboard  /fund/users  /fund/record/wd  /fund/quarter  /fund/reports  /fund/log   /me/mine  /me/statements  /me/myhistory   (and /profile ...)
  // It lets a page be bookmarked, shared and reloaded; it never changes what a person may see (a page that is not among their own tabs is ignored).
  // Opening a page while signed out shows /login; after signing in the person lands on the page they asked for. The first versions of these addresses
  // (/login/calendar, #/calendar) still open, then become the real one. Where the app is not served from the site root with these rewrites (a plain file,
  // another host) the same names are used after a # instead.
  const RECS = ['dep', 'wd', 'eq', 'hist', 'add', 'cash', 'out', 'move', 'nav'];
  const PATHY = /^\/(login|dashboard|calendar|withdraw|statements|activity|about|profile|contact|payout|fund|me)(\/|$)/.test(location.pathname);
  const here = () => (PATHY ? location.pathname : location.hash);
  const LOGIN = PATHY ? '/login' : null;
  let LAND = PATHY && !/^\/login\/?$/.test(location.pathname) ? { pathname: location.pathname, hash: '' } : null;   // the page asked for before sign-in; used once
  function routeOf(s) {
    const t = s.tab === 'home' && S.me && S.me.role === 'investor' ? 'dashboard' : s.tab, sd = S.me && S.me.role === 'admin' && !PAGES.includes(t) ? (s.side === 'me' ? 'me/' : 'fund/') : '';
    return (PATHY ? '/' : '#/') + sd + t + (t === 'record' && s.rec ? '/' + s.rec : '');
  }
  function fromHash(src) {
    const m = S.me; if (!m || m.impersonated) return null;
    const at = src || LAND || location;
    let rel = ''; try { rel = decodeURIComponent(at.pathname).replace(/^\/(login(\/|$))?/, ''); if (!rel) rel = decodeURIComponent(at.hash).replace(/^#\/?/, ''); } catch { return null; }
    const seg = rel.split('/').filter(Boolean), admin = m.role === 'admin';
    let side = 'fund';
    if (admin && (seg[0] === 'fund' || seg[0] === 'me')) side = seg.shift();
    let tab = seg[0] === 'dashboard' && !admin ? 'home' : seg[0];
    const tabs = admin ? TABS[side === 'me' ? 'adminMe' : 'admin'] : TABS.investor;
    if (!tab || !(PAGES.includes(tab) || tabs.some(([k]) => k === tab))) return null;
    return { tab, side: PAGES.includes(tab) ? null : side, rec: tab === 'record' && RECS.includes(seg[1]) ? seg[1] : null };   // profile, contact and payout open on whichever side the manager is on
  }
  function applyHash() {
    const r = fromHash(); LAND = null; if (!r) return false;
    S.tab = r.tab; if (S.me.role === 'admin' && r.side) S.side = r.side; if (r.rec) S.rec = r.rec;
    return true;
  }
  function syncNav() {
    try {
      document.body.style.overflow = S.modal ? 'hidden' : '';
      const p = history.state;
      if (!S.me) { const u = LOGIN && location.pathname !== LOGIN ? LOGIN : null; if (u || !(p && p.out)) history.replaceState({ app: 1, out: 1 }, '', u || location.href); return; }   // signed out: this is /login (LAND remembers the page asked for)
      const s = { app: 1, uid: S.me.id, tab: S.tab, side: S.side === 'me' ? 'me' : 'fund', rec: S.rec, modal: S.modal || null, vw: !!S.adminToken, gate: !!S.gate };
      const live = p && p.app && !p.out && !p.gate && !s.gate && !S.navReplace;
      const move = live && (p.uid === s.uid ? (p.tab !== s.tab || p.side !== s.side || p.modal !== s.modal) : p.vw !== s.vw);
      s.vd = s.vw ? (move ? (p.vw ? p.vd + 1 : 0) : (p && p.vw ? p.vd : 0)) : 0;               // entries added since "view as" opened
      s.ve = s.vw ? (move ? (p.vw ? p.ve : true) : !!(p && p.vw && p.ve)) : false;             // true when "view as" opened on its own entry
      const url = S.gate || S.adminToken ? null : routeOf(s);   // the terms / tour screens and "view as" keep the address they have
      if (p && p.app && NAV_KEYS.every((k) => p[k] === s[k])) { S.nav = p; if (url && here() !== url) history.replaceState(p, '', url); return; }
      S.nav = s; move ? history.pushState(s, '', url || location.href) : history.replaceState(s, '', url || location.href);
    } catch { /* no history access: Back simply leaves the page */ }
  }
  const stay = () => { try { history.pushState(S.nav || { app: 1, out: 1 }, ''); } catch { /* ignore */ } };   // undo a Back that must not leave the current screen
  window.addEventListener('popstate', async (ev) => {
    const st = ev.state;
    if (!S.me) return loginView();
    if (S.gate && !S.me.impersonated) return stay();                       // the terms must be agreed to; the tour has its own Back button
    if (!st && !S.adminToken) {                                              // an address typed or pasted in: open that page, or put the real address of this one back
      if (applyHash()) { S.modal = null; S.navReplace = true; try { render(); } finally { S.navReplace = false; } window.scrollTo(0, 0); }
      else if (S.nav) { try { history.replaceState(S.nav, '', routeOf(S.nav)); } catch { /* ignore */ } }
      return;
    }
    if (S.adminToken && !(st && st.vw)) {                                   // Back out of "view as": return to the fund manager where they were
      S.navReplace = true;
      try { await backToManager(); if (st && st.app && st.uid === S.me.id) { S.tab = st.tab; S.side = st.side; S.rec = st.rec; S.modal = st.modal; render(); } } finally { S.navReplace = false; }
      return;
    }
    if (!st || !st.app || st.out || st.gate || st.uid !== S.me.id || !!st.vw !== !!S.adminToken) return stay();
    S.tab = st.tab; S.side = st.side; S.rec = st.rec; S.modal = st.modal; S.navReplace = true;
    try { render(); } finally { S.navReplace = false; }
    window.scrollTo(0, 0);
  });
  function closeModal() {
    if (history.state && history.state.modal) history.back(); else { S.modal = null; render(); }
  }
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && S.modal) closeModal(); });
  async function refresh(msg) {
    try { await load(); render(); if (msg) toast(msg); }
    catch (e) { if (e.message !== 'Signed out') toast(e.message, true); }
  }

  // ---------------------------------------------------------------- previews (mirror the database math)
  const $f = (id) => document.getElementById(id);
  const fv = (form, name) => (form.elements[name] ? form.elements[name].value : '');
  function wirePreviews() {
    for (const [id, fn] of [['eqForm', eqPrev], ['depForm', depPrev], ['wdForm', wdPrev], ['qForm', syncSettle], ['reqForm', reqPrev], ['spreadForm', spreadPrev],
      ['addForm', deskPrev], ['cashForm', deskPrev], ['outForm', deskPrev], ['moveForm', deskPrev]]) {
      const el = $f(id); if (el) { el.addEventListener('input', (e) => { el.dataset.last = e.target.name || ''; fn(el); }); fn(el); }
    }
  }
  const setPrev = (id, html) => { const el = $f(id); if (el) el.innerHTML = html; };
  const formVals = (fm) => { const o = {}; for (const el of fm.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value; return o; };
  // the four routine steps: the database's own quote (the real step, rolled back), so the preview is exactly what saving does
  const DESK_Q = { cashForm: ['admin_quote_cash_in', Desk.cashArgs, Desk.cashText], outForm: ['admin_quote_withdraw_now', Desk.outArgs, Desk.outText], moveForm: ['admin_quote_transfer', Desk.moveArgs, Desk.moveText] };
  let dkSeq = 0, dkTimer = null;
  function deskPrev(fm) {
    const v = formVals(fm), pid = fm.id.replace('Form', 'Prev');
    dkSeq++; clearTimeout(dkTimer);
    if (fm.id === 'addForm') {
      const c = Desk.credit(v.php, v.usdt, v.rate);
      if (!c) return setPrev(pid, '—');
      return setPrev(pid, `${num(v.php) > 0 ? `${php(num(v.php))} at ₱${f(num(v.rate), 4)} = ` : ''}<b>${usdt(c.credited, 6)}</b> credited.${c.topup > 0 ? `<br>${usdt(c.topup, 6)} less arrived: it comes from <b>your</b> units at the live price.` : c.surplus > 0 ? `<br>${usdt(c.surplus, 6)} more arrived: it joins as <b>your</b> own money.` : ''}<br><span class="note">It joins at the live price once the MEXC reports show it.</span>`);
    }
    const [fn, argsOf, text] = DESK_Q[fm.id], args = argsOf(v);
    if (!args) return setPrev(pid, '—');
    setPrev(pid, '<span class="note">Asking the database…</span>');
    const my = dkSeq;
    dkTimer = setTimeout(async () => {
      let r = null, err = null;
      try { r = await call(fn, args); } catch (e) { err = e.message; }
      if (my !== dkSeq || err === 'Signed out') return;
      setPrev(pid, err ? Desk.refused(err) : text(r));
    }, 400);
  }
  const joinedText = (r, who) => (r && r.status === 'admitted' ? `${who}: ${usdt(r.credited_usdt, 4)} joined at ${f(r.unit_price, 4)} (${f(r.units, 4)} units).`
    : `${who}: ${usdt(r && r.credited_usdt, 4)} recorded. It joins by itself at the next wallet report that shows it.`);
  function eqPrev(fm) {
    const eq = num(fv(fm, 'equity')), u = Number(S.pool.total_units), wait = pendTotal();
    if (eq == null || (!u && !wait)) return setPrev('eqPrev', '—');
    if (!u) return setPrev('eqPrev', `Waiting deposits buy <b>${f(wait, 4)} units</b> at 1.00.${Math.abs(eq - wait) > 1e-6 ? ` Then the price moves to <b>${f(eq / wait, 4)}</b>.` : ''}`);
    if (eq - wait <= 0) return setPrev('eqPrev', `<span class="down">Must be more than the ${usdt(wait)} still waiting: enter the full Exchange total.</span>`);
    const price = (eq - wait) / u, ch = price / Number(S.pool.unit_price) - 1;
    setPrev('eqPrev', `Unit price becomes <b>${f(price, 4)}</b> (<span class="${cls(ch)}">${pct(ch)}</span> vs last reading). Since start ${pct(price - 1)}.<br>Pool is ${money(eq)} ${alt(eq)}.${wait ? `<br>${usdt(wait)} waiting is taken out first, then buys <b>${f(wait / price, 4)} units</b> at ${f(price, 4)}.` : ''}`);
  }
  // what a deposit form means: in pesos, the pesos paid and the USDT actually received, and the effective rate between them (pesos / USDT);
  // in USDT, the USDT typed (with today's reference rate kept for the ₱ estimate, as before). Units are only ever bought with the USDT.
  function depUsdt(fm) {
    const amt = num(fv(fm, 'amt'));
    if (amt == null) return null;
    if (fv(fm, 'ccy') === 'USDT') return { usdt: amt, php: null, rate: num(fv(fm, 'rate')) };
    const got = num(fv(fm, 'got')), r = Contribution.effectiveRate(amt, got);
    return r ? { usdt: got, php: amt, rate: r } : { usdt: null, php: amt };
  }
  // a typo check on the effective rate against today's reference rate (a warning only; the cost of converting pesos is often well above the market rate)
  const depRateWarn = (d) => {
    const ref = rate();
    if (d.php == null || !d.rate) return '';
    if (ref ? d.rate < ref * 0.5 || d.rate > ref * 2 : d.rate < Contribution.MIN_RATE || d.rate > Contribution.MAX_RATE)
      return `<br><span class="warn">Check the numbers: ₱${f(d.rate, 2)} per USDT is far from ${ref ? `today's reference ₱${f(ref, 2)}` : 'any normal rate'}.</span>`;
    return '';
  };
  // "They paid me directly": the investor gets the fund manager's units at today's price; the figures are the database's own quote (admin_quote_units_from_manager)
  let depSeq = 0, depTimer = null;
  function depPrev(fm) {
    const d = depUsdt(fm), mgr = !!(fm.elements.frommgr && fm.elements.frommgr.checked), box = fm.querySelector('[data-frommgr]');
    const inPhp = fv(fm, 'ccy') !== 'USDT', got = fm.querySelector('[data-got]'), lab = fm.querySelector('[data-amtlabel]');
    if (box) box.hidden = !mgr;
    if (got) got.hidden = !inPhp;
    if (lab) lab.textContent = inPhp ? 'Pesos paid' : 'USDT received';
    depSeq++; clearTimeout(depTimer);
    if (!d) return setPrev('depPrev', inPhp && num(fv(fm, 'got')) != null ? 'Enter the pesos paid.' : '—');
    if (d.usdt == null) return setPrev('depPrev', 'Enter the USDT actually received for these pesos.');
    const ref = rate(), live = d.php != null && ref ? Math.floor((d.php / ref) * 1e6 + 1e-7) / 1e6 : null;
    const eff = d.php != null ? `<br><span class="note">Effective cash-in rate ₱${f(d.rate, 2)} per USDT (pesos ÷ USDT received), kept with the deposit; not today's reference rate. Units are bought with the ${usdt(d.usdt)} plus any peso top-up.</span>${depRateWarn(d)}`
      + (live != null && live - d.usdt > 0.01 ? `<br>At today's live rate ₱${f(ref, 2)} these pesos are <b>${usdt(live)}</b>. Once it joins, <b>Peso top-ups</b> gives them the other ${usdt(live - d.usdt)} from your units.` : '') : '';
    if (mgr) {
      const eq = num(fv(fm, 'eq')), who = fv(fm, 'who');
      if (!(eq > 0)) return setPrev('depPrev', `${d.php != null ? `${php(d.php)} = ` : ''}<b>${usdt(d.usdt)}</b> paid to you. Type the exchange balance now to see how many of your units they get.${eff}`);
      const my = depSeq, args = { p_profile: who, p_usdt: d.usdt, p_equity_before: eq, p_php_rate: d.rate, p_at: atOf(fm) };
      setPrev('depPrev', '<span class="note">Asking the database how many of your units this buys…</span>');
      depTimer = setTimeout(async () => {
        let r = null, err = null, checked = false;
        try { r = await call('admin_quote_units_from_manager', { ...args, p_confirm: false }); }
        catch (e) {
          if (/^CONFIRM: /.test(e.message)) { checked = e.message.replace(/^CONFIRM: /, ''); try { r = await call('admin_quote_units_from_manager', { ...args, p_confirm: true }); } catch (e2) { err = e2.message; } }
          else err = e.message;
        }
        if (my !== depSeq || err === 'Signed out') return;
        if (err) return setPrev('depPrev', `<span class="down">The database would refuse this: ${esc(/function|schema cache|does not exist/i.test(err) ? 'unit transfers are not available on this database yet (run 20261201000000_units_from_manager.sql).' : err)}</span>`);
        setPrev('depPrev', `They get <b>${f(r.units, 4)} of your units</b> at ${f(r.unit_price, 4)} (worth ${usdt(d.usdt)}${d.php != null ? ', ' + php(d.php) : ''}). You keep ${f(r.manager_units_after, 4)} units.
          <br><span class="note">Nothing goes into the exchange and nobody else's value changes. Their fee is only on gain from today. Quoted by the database; nothing is saved until you press Save.</span>${checked ? `<br><span class="warn">Saving will ask you to confirm: ${esc(checked)}</span>` : ''}${termsWarn(who)}`);
      }, 350);
      return;
    }
    setPrev('depPrev', `${d.php != null ? `${php(d.php)} = ` : ''}<b>${usdt(d.usdt)}</b>${d.php == null && d.rate ? ` (≈ ${php(d.usdt * d.rate)} at today's rate, no pesos recorded)` : ''}. Waits until it is in the exchange and your next equity reading, then buys units at that price.${eff}${termsWarn(fv(fm, 'who'))}`);
  }
  // after an "Edit" undoes the last entry, refill the matching form with its old values so the fund manager just fixes the typo and re-saves
  function prefillEdit(e, rows) {
    if (e.kind === 'update') {
      const fm = $f('eqForm'); if (!fm) return;
      fm.elements.equity.value = e.equity_usdt; fm.elements.note.value = e.note || ''; eqPrev(fm);   // the rate field keeps today's reference rate, never an old entry's
    } else if (e.kind === 'deposit') {
      const dep = rows.find((r) => r.kind === 'deposit'); const fm = $f('depForm'); if (!fm || !dep) return;
      fm.elements.who.value = dep.profile_id; fm.elements.ccy.value = dep.php_amount ? 'PHP' : 'USDT';
      fm.elements.amt.value = dep.php_amount || dep.usdt;
      if (dep.php_amount) fm.elements.got.value = dep.usdt;   // the effective rate is worked out again from the two amounts
      if (fm.elements.eq) fm.elements.eq.value = Number(e.equity_usdt) - Number(dep.usdt);
      fm.elements.note.value = dep.note || ''; depPrev(fm);
    } else if (e.kind === 'withdrawal') {
      const wd = rows.find((r) => r.kind === 'withdrawal'); const fm = $f('wdForm'); if (!fm || !wd) return;
      fm.elements.who.value = wd.profile_id; fm.elements.units.value = Math.abs(wd.units);
      fm.elements.eq.value = Number(e.equity_usdt) + Math.abs(Number(wd.usdt));
      fm.elements.note.value = wd.note || ''; wdPrev(fm);
    }
    toast('Entry undone — adjust the values and save again.');
  }
  // investor request preview: the units the USDT asks for at today's price, and the pesos as a labelled estimate (never part of the request)
  function reqPrev(fm) {
    if (!fm) return;
    const a = num(fv(fm, 'amount')), price = Number(S.me.unit_price), units = Contribution.withdrawUnits(a, price, S.me.unlocked_units);
    const avail = Number(S.me.unlocked_units) * price;
    if (units == null) return setPrev('reqPrev', `Up to <b>${usdt(Math.floor(avail * 100) / 100)}</b> can be requested now${rate() ? ` (≈ ${php(avail * rate())} at today's rate, an estimate)` : ''}.`);
    setPrev('reqPrev', `<b>${usdt(a)}</b> = ${f(units, 4)} of your units at today's unit price ${f(price, 4)}.
      <br><span class="note">${rate() ? `≈ ${php(a * rate())} at today's PHP/USD reference rate: an estimate only.` : 'Peso estimate: rate unavailable.'} What you receive is set by these units and the unit price on the payout day, in USDT.</span>${a > avail + 0.01 ? '<br><span class="warn">More than you can withdraw right now.</span>'
        : minPhp() && fxDbRate() && units < Number(S.me.units) - 1e-8 && units * price * fxDbRate() < minPhp() ? `<br><span class="warn">Under the ${php(minPhp())} minimum (about ${usdt(S.fxDb.min_withdrawal_usdt)} at the fund's reference rate). Taking everything is always allowed.</span>` : ''}`);
  }
  const holder = (id) => S.all.find((h) => h.id === id);
  let wdSeq = 0, wdTimer = null;   // Money out preview: the newest quote request; older answers are dropped
  function wdPrev(fm) {
    const h = holder(fv(fm, 'who')), eq = num(fv(fm, 'eq')), u = Number(S.pool.total_units);
    const wp = $f('wdPay'); if (wp) wp.innerHTML = h && h.role === 'investor' ? `<details class="paydet" open><summary class="note">Where to send their money</summary>${payoutBlock(payOf(h.id))}</details>` : '';
    // a typed USDT amount becomes units at the price this payout will use (no peso rate involved); typing the units directly clears the amount
    if (fm.dataset.last === 'units') fm.elements.amt.value = '';
    else if (num(fv(fm, 'amt')) > 0 && eq != null && u && eq - pendTotal() > 0) {
      const price = (eq - pendTotal()) / u;
      fm.elements.units.value = Math.round((num(fv(fm, 'amt')) / price) * 1e8) / 1e8;
    }
    const units = num(fv(fm, 'units'));
    wdSeq++; clearTimeout(wdTimer);
    if (!h || units == null || eq == null || !u) return setPrev('wdPrev', '—');
    if (eq - pendTotal() <= 0) return setPrev('wdPrev', `<span class="down">Must be more than the ${usdt(pendTotal())} still waiting.</span>`);
    const price = (eq - pendTotal()) / u;
    // a hint only: the peso minimum is checked by the database (it refuses, with the reason, unless the lock-up/minimum override is ticked)
    const small = h.role === 'investor' && minPhp() && rate() && units < Number(h.units) - 1e-8 && units * price * rate() < minPhp() && !fm.elements.force.checked
      ? `<br><span class="warn">At today's rate this is about ${php(units * price * rate())}, possibly under the ${php(minPhp())} minimum: the database checks it.</span>` : '';
    const warn = small + (units > Number(h.units) + 1e-8 ? '<br><span class="down">More than they hold.</span>'
      : h.role === 'investor' && h.next_unlock ? `<br><span class="note">Inside their first-deposit lock-up (until ${day(h.next_unlock)}): your call.</span>` : '');
    const mgr = fm.elements.tomgr.checked, mgrWarn = mgr && h.role !== 'investor' ? '<br><span class="down">Only an investor\'s money can be moved to you.</span>' : '';
    // the fee, withdrawal fee and payout are the database's own answer (admin_quote_withdraw runs the real withdrawal and rolls it back), never a browser estimate;
    // only the answer for the inputs still on screen is shown
    const args = { p_profile: h.id, p_units: units, p_equity_before: eq, p_php_rate: num(fv(fm, 'rate')), p_force: fm.elements.force.checked, p_to_manager: mgr, p_at: atOf(fm) };
    const my = wdSeq, xr = exitRate(h.id), est = (u) => (rate() ? ` (${peso(u, rate())} at today's rate, an estimate)` : '');
    setPrev('wdPrev', `<span class="note">Asking the database for the fee and payout…</span>${mgrWarn}${warn}`);
    wdTimer = setTimeout(async () => {
      let r = null, err = null, checked = false;
      try { r = await call('admin_quote_withdraw', { ...args, p_confirm: false }); }
      catch (e) {
        if (/^CONFIRM: /.test(e.message)) { checked = e.message.replace(/^CONFIRM: /, ''); try { r = await call('admin_quote_withdraw', { ...args, p_confirm: true }); } catch (e2) { err = e2.message; } }
        else err = e.message;
      }
      if (my !== wdSeq || err === 'Signed out') return;
      if (err) return setPrev('wdPrev', `<span class="down">The database would refuse this: ${esc(/function|schema cache|does not exist/i.test(err) ? 'the quote is not available on this database yet (run 20261128000000_withdraw_quote.sql).' : err)}</span>${mgrWarn}${warn}`);
      const fee = Number(r.fee_units), net = Number(r.net_units), pay = Number(r.pay_usdt);
      setPrev('wdPrev', `Price ${f(r.unit_price, 4)}. Fee <b>${f(fee, 4)} units</b>${Number(r.withdrawal_fee_units) > 0 ? ` (includes ${pc(xr)}% withdrawal fee)` : ''}. ${mgr ? `Moves <b>${usdt(pay)}</b>${est(pay)} (${f(net, 4)} units) to your fund manager account. Nothing leaves the exchange: you pay them yourself.` : `Pay out <b>${usdt(pay)}</b>${est(pay)} for ${f(net, 4)} units.`}<br><span class="note">Quoted by the database for these exact figures; nothing is saved until you press the button.</span>${checked ? `<br><span class="warn">Saving will ask you to confirm: ${esc(checked)}</span>` : ''}${mgrWarn}${warn}`);
    }, 350);
  }

  // ---------------------------------------------------------------- actions
  async function act(fn, okMsg) {
    try { await fn(); await refresh(okMsg); } catch (e) { if (e.message !== 'Signed out' && !e.cancelled) toast(e.message, true); }
  }
  async function onClick(ev) {
    document.querySelectorAll('details.settings[open]').forEach((d) => { if (!d.contains(ev.target) || ev.target.closest('[data-action]')) d.removeAttribute('open'); });
    const side = ev.target.closest('[data-side]');
    if (side) { S.side = side.dataset.side === 'me' ? 'me' : 'fund'; S.tab = null; render(); window.scrollTo(0, 0); return; }
    const tab = ev.target.closest('[data-tab]');
    if (tab) { S.tab = tab.dataset.tab; if (tab.dataset.rec) S.rec = tab.dataset.rec; S.recWho = tab.dataset.who === 'me' ? S.me.id : tab.dataset.who || null; if (tab.dataset.goside) S.side = tab.dataset.goside; render(); window.scrollTo(0, 0); return; }
    const rc = ev.target.closest('[data-rec]');
    if (rc) { S.rec = rc.dataset.rec; render(); return; }
    const lr = ev.target.closest('[data-lrange], [data-lkind]');
    if (lr) { if (lr.dataset.lrange) S.lrange = lr.dataset.lrange; if (lr.dataset.lkind) S.lkind = lr.dataset.lkind; render(); return; }
    const rg = ev.target.closest('[data-range]');
    if (rg) { S.range = rg.dataset.range; render(); return; }
    const b = ev.target.closest('[data-action]'); if (!b) return;
    const a = b.dataset.action, id = b.dataset.id;
    if (a === 'signout' || a === 'declineterms') { const t = S.token; signedOut(); try { await rpc('logout', { p_token: t }); } catch { /* already gone */ } }
    else if (a === 'botdash') {
      // the fund manager's Ledger session is exchanged for the bot dashboard cookie, so there is no second password
      b.disabled = true; toast('Opening the bot dashboard…');
      try {
        const r = await fetch('/api/admin-enter', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: S.token }) });
        if (!r.ok) throw new Error(r.status === 403 ? 'Only the fund manager can open the bot dashboard.' : 'Could not open the bot dashboard. Try again.');
        location.href = '/bot-dashboard/';
      } catch (e) { toast(e.message, true); b.disabled = false; }
    }
    else if (a === 'eye') {
      const inp = b.parentElement.querySelector('input'), show = inp.type === 'password';
      inp.type = show ? 'text' : 'password'; b.innerHTML = ICON[show ? 'eyeOff' : 'eye'];
      b.setAttribute('aria-pressed', String(show)); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); inp.focus();
    }
    else if (a === 'refresh') await refresh('Up to date');
    else if (a === 'tvcorrect') {   // one book correction, in order, after the live preview (admin_preview_book_corrections); written once, with the reason and evidence
      const st = ((S.tvPrev && S.tvPrev.steps) || []).find((x) => String(x.correction_id) === String(id)), c = ((S.tv && S.tv.corrections) || []).find((x) => String(x.id) === String(id));
      if (!st || !c) return;
      const n = (v, d = 4) => Number(v).toFixed(d);
      if (!(await confirmSheet(`Apply correction #${id}?`, `${Number(c.amount_usdt) > 0 ? '+' : ''}${c.amount_usdt} USDT: ${c.reason}\n\nBook after: ${n(st.book_usdt)} USDT · unit price ${n(st.unit_price, 6)} · reconciliation gap after: ${st.gap_usdt == null ? 'not available' : n(st.gap_usdt)} USDT.\nThis writes one pool entry signed by you, with the reason and the evidence. It cannot be edited or applied twice.`, 'Apply correction', true))) return;
      try { const r = await call('admin_apply_book_correction', { p_id: Number(id), p_idem: 'book-correction-' + id }); await refresh(`Correction #${id} applied: book ${n(r.equity_before)} → ${n(r.equity_after)} USDT`); }
      catch (e) { if (e.message !== 'Signed out') toast(e.message, true); }
    }
    else if (PAGES.includes(a)) { S.tab = a; S.modal = null; render(); window.scrollTo(0, 0); }
    else if (a === 'welcome') startTour();
    else if (a === 'stmtpick') { S.stmt = id; render(); const el = $f('stmt'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (a === 'stmtcsv') { const m = stmtMonth(myMonths()); if (m) download(`lucid-io-statement-${m.key}.csv`, stmtMonthCsv(m)); }
    else if (a === 'stmtallcsv') download('lucid-io-statements-all-months.csv', stmtAllCsv());
    else if (a === 'stmtprint') printStatement();
    else if (a === 'auditfilter') { S.auditFilter = id; render(); }
    else if (a === 'auditmore') { try { const more = await call('admin_audit_log', { p_limit: 200, p_before: S.audit[S.audit.length - 1].id }); S.audit = S.audit.concat(more); S.auditMore = more.length >= 200; render(); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'backupjson' || a === 'backupcsv') { try { await backupDownload(a === 'backupjson' ? 'json' : 'csv'); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'makekey') { try { S.newKey = await call('admin_create_backup_key', { p_label: 'nightly backup' }); await loadAdminExtras(); render(); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'revokekeys') { if (!(await confirmSheet('Revoke all backup keys?', 'Revoke all backup keys? The nightly backup stops until you create a new key.', 'Yes, continue', true))) return; await holdDelete('Revoking all backup keys…', async () => { await call('admin_revoke_backup_keys'); S.newKey = null; }, 'Backup keys revoked'); }
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
        if (e.message !== 'Signed out') toast(/function|schema cache/i.test(e.message) ? 'The database needs its latest update before your agreement can be saved. Please tell the fund manager.' : e.message, true);
        if (b.isConnected) b.disabled = false;
      }
    }
    else if (a === 'theme') { const p = themePref(); applyTheme(THEMES[(THEMES.indexOf(p) + 1) % THEMES.length]); if (S.me) render(); else loginView(); }
    else if (a === 'cur') { S.cur = inPeso() ? 'USDT' : 'PHP'; try { localStorage.setItem('ledger.cur', S.cur); } catch { /* not saved */ } render(); }
    else if (a === 'adduser') { S.addUser = !S.addUser; render(); }
    else if (a === 'maxunits') { const v = Number(S.me.units) * Number(S.me.unit_price); $f('rq-u').value = Math.floor(v * 100) / 100; reqPrev($f('reqForm')); }
    else if (a === 'arrived') {
      if (!(await confirmSheet('Is the money in the exchange?', 'Is this money in the exchange account now? It joins the pool at your next Update equity, and that total must include it.', 'Yes, continue', true))) return;
      await act(() => call('admin_mark_arrived', { p_pending: Number(id), p_transfer_id: null }), 'Marked as in the exchange');
    }
    else if (a === 'addpesos') {
      const l = S.ledger.find((x) => String(x.id) === String(id)); if (!l) return;
      const has = l.php_amount != null;
      const r = await askSheet({ title: `${has ? 'Correct the' : 'Pesos for the'} ${day(l.ts)} deposit`,
        text: `${has ? `Recorded now: ${php(Number(l.php_amount))}${l.usdt_bought != null ? ` = ${f(l.usdt_bought, 4)} USDT` : ''}. ` : ''}Enter the pesos put in and, if you know it, the USDT they bought. The earlier entry is kept; the USDT credited and the units do not change.`,
        confirmLabel: has ? 'Save correction' : 'Record pesos', fields: [{ name: 'php', label: 'Pesos put in', type: 'number', required: true, min: 1, value: has ? String(l.php_amount) : '' },
          { name: 'usdt', label: 'USDT those pesos bought (optional)', type: 'number', min: 0, value: l.usdt_bought != null ? String(l.usdt_bought) : '' },
          { name: 'note', label: 'Where this comes from', type: 'text', required: true, minLength: 5, hint: 'For example: bulk cash-in ₱10,000 = 158.0278 USDT, split in half' }] });
      if (!r) return;
      await act(() => call('admin_record_deposit_pesos', { p_ledger: Number(id), p_php_amount: Number(r.php), p_usdt_bought: r.usdt === '' || r.usdt == null ? null : Number(r.usdt), p_note: r.note,
        p_idem: 'deposit-pesos-' + id + '-' + Date.now() }), `Recorded: ${php(Number(r.php))} for that deposit`);
    }
    else if (a === 'spreadadmit') {
      if (!(await confirmSheet('Admit this admission spread?', 'The investor\'s credited USDT and your surplus are admitted together at the true-value price: the investor gets units for the credited amount, you get units for the surplus, and nobody else\'s value changes.', 'Admit both', true))) return;
      await act(() => call('admin_admit_admission_spread_tv', { p_spread: Number(id), p_as_of: null, p_idem: 'spread-admit-' + id }), 'Admitted: the investor\'s units and your surplus units joined together');
    }
    else if (a === 'topup') {
      const x = topupsDue().find((y) => y.h.id === id); if (!x) return toast('Nothing to top up: no live rate, or already done.');
      const { h, t } = x, nm = esc(h.name || h.username);
      if (!(await confirmSheet(`Top up ${nm}?`, `${php(t.php)} at the live rate ₱${f(t.rate, 4)} = ${usdt(t.credited)}. ${usdt(t.arrived)} arrived, so ${usdt(t.gap)} of your units go to ${nm} at today's price. Nobody else's value changes. This is recorded immediately.`, 'Give the units', true))) return;
      // priced at true value in the database (admin_peso_topup); one request id per deposit set, so a resend is a replay
      await act(() => call('admin_peso_topup', { p_profile: h.id, p_usdt: t.gap, p_rate: t.rate, p_note: t.note, p_idem: 'topup-' + h.id + '-' + t.ids.join('-') }),
        `Topped up: ${usdt(t.gap)} of your units went to ${nm}`);
    }
    else if (a === 'calmonth') { S.calM = (S.calM || 0) + Number(id); render(); }
    else if (a === 'cashrecv') {
      if (!(await confirmSheet('Is the money in MEXC?', 'Is it in one of the bots\' Futures accounts now? It joins at the first verified wallet reading that shows it (at once if the latest one already does).', 'Yes, it is in MEXC', true))) return;
      await act(() => call('admin_cash_in_received', { p_cash_in: Number(id), p_idem: 'cash-in-received-' + id }), 'Marked as in MEXC');
    }
    else if (a === 'cashadmit') await act(() => call('admin_cash_in_admit', { p_cash_in: Number(id), p_idem: null }), 'Joined at the live price');
    else if (a === 'cashcancel') {
      let why; try { why = await askText('Hand back this cash-in?', 'Why (for the activity log)', { text: 'Both parts are removed from waiting. Nothing in the books changes.', ok: 'Hand back', danger: true }); } catch { return; }
      await holdDelete('Handing back this cash-in…', () => call('admin_cancel_cash_in', { p_cash_in: Number(id), p_reason: why }), 'Handed back');
    }
    else if (a === 'paysent') {
      let ref; try { ref = await askText('Mark as sent from MEXC', 'MEXC withdrawal reference (or transfer ID)', { type: 'text', min: 3, ok: 'Mark sent' }); } catch { return; }
      await act(() => call('admin_payout_sent', { p_request: Number(id), p_reference: ref, p_note: null }), 'Marked as sent');
    }
    else if (a === 'procreq') {
      const q = S.reqs.find((x) => String(x.id) === String(id)); if (!q) return;
      const r = await askSheet({ title: `Pay ${esc(q.name || 'this request')} now?`, text: `${f(q.units, 4)} units are redeemed at the live price (about ${usdt(Number(q.units) * Number(S.pool.unit_price))}) and recorded as a payout to send from MEXC.`,
        fields: [{ name: 'lock', label: 'Lock-up reason (only if they are inside their first-deposit lock-up)', type: 'text' }], confirmLabel: 'Redeem now', danger: true });
      if (!r) return;
      await act(() => call('admin_withdraw_now', { p_profile: null, p_usdt: null, p_all: false, p_request: Number(id), p_lock_reason: r.lock || null, p_note: null, p_idem: 'withdraw-request-' + id }),
        'Redeemed: send it from MEXC, then press Mark sent');
    }
    else if (a === 'spreadcancel') {
      if (!(await confirmSheet('Hand back this admission spread?', 'Both waiting deposits (the investor\'s and your surplus) are removed together. Nothing in the books changes.', 'Yes, hand back', true))) return;
      await holdDelete('Handing back this admission spread…', () => call('admin_cancel_admission_spread', { p_spread: Number(id) }), 'Handed back');
    }
    else if (a === 'cancelpend') {
      if (!(await confirmSheet('Remove this waiting deposit?', 'Remove this waiting deposit? Use this when you gave the money back (or typed it wrong). Nothing in the books changes.', 'Yes, continue', true))) return;
      await holdDelete('Removing this waiting deposit…', () => call('admin_cancel_pending', { p_id: Number(id) }), 'Removed from waiting');
    }
    else if (a === 'wfsettle' && !(await settleSheet(Number(RD().balance), null))) return;
    else if (WF[a]) await act(() => WF[a](Number(id), b), 'Saved');
    else if (a === 'cancelreq') await holdDelete('Cancelling the withdrawal request…', () => call('cancel_withdrawal_request', { p_id: Number(id) }), 'Request cancelled');
    else if (a === 'toggleactive') {
      const on = b.dataset.active === 'true';
      if (on && !(await confirmSheet('Deactivate this person?', 'Deactivate this person? They are signed out and cannot sign in until you reactivate them. Their units stay in the pool.', 'Yes, continue', true))) return;
      const run = () => call('admin_set_profile', { p_profile: id, p_name: null, p_active: !on, p_fee_rate: null });
      if (on) await holdDelete('Deactivating this person…', run, 'Deactivated'); else await act(run, 'Reactivated');
    }
    else if (a === 'bottotal') {
      const fm = $f(b.dataset.form), box = fm && fm.querySelector('[data-botbox]'), inp = fm && fm.elements[b.dataset.field]; if (!box || !inp) return;
      box.textContent = 'Reading the bots…';
      try {
        const r = BT.read(await call('admin_wallet_nav'));
        box.innerHTML = BT.html(r, { usdt });
        if (r.ok) { inp.value = r.total; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      } catch (e) { if (e.message !== 'Signed out') box.innerHTML = `<span class="warn">Could not read the bots: ${esc(/function|schema cache|does not exist/i.test(e.message) ? 'the database has no wallet reports yet.' : e.message)}</span>`; }
    }
    else if (a === 'allunits') { const fm = $f('wdForm'), h = holder(fv(fm, 'who')); if (h) { fm.elements.units.value = h.units; fm.dataset.last = 'units'; wdPrev(fm); } }
    else if (a === 'viewas') { try { await viewAs(id); } catch (e) { if (e.message !== 'Signed out') toast(e.message, true); } }
    else if (a === 'exitview') {
      const st = history.state;
      if (st && st.vw && st.ve) history.go(-(st.vd + 1)); else backToManager();   // the pop handler returns to the manager
    }
    else if (a === 'help') { S.modal = 'help:' + b.dataset.help; render(); const x = document.querySelector('.sheet [data-action="closemodal"]'); if (x) x.focus(); }
    else if (a === 'userview') { S.modal = id; render(); const x = document.querySelector('.sheet [data-action="closemodal"]'); if (x) x.focus(); }
    else if (a === 'closemodal') { if (ev.target === b || b.classList.contains('iconbtn') || ev.target.closest('.iconbtn')) closeModal(); }
    else if (a === 'undolast') {
      if (!(await confirmSheet('Delete the most recent entry?', 'Delete the most recent entry? This appends a correction that cancels it out — nothing is erased from the history.', 'Yes, continue', true))) return;
      await act(() => call('admin_undo_last', { p_note: 'correction: deleted' }), 'Last entry deleted (correction added)');
    }
    else if (a === 'editlast') {
      const e = S.elog[0]; if (!e) return;
      if (!(await confirmSheet('Undo the most recent entry?', 'This undoes the most recent entry so you can re-enter it with the fix. Continue?', 'Yes, continue', true))) return;
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
    else if (a === 'invact') {
      // Add Money / Withdraw / Full Exit: open the existing form with this person filled in. Nothing is saved here.
      const kind = b.dataset.inv, h = holder(id); if (!h) return;
      S.modal = null; S.tab = 'record'; S.recWho = id;
      if (!LEGACY) {   // the four steps: Cash in / Withdraw with this person chosen ("everything" ticked for a full exit)
        S.rec = kind === 'add' ? 'cash' : 'out'; render(); window.scrollTo(0, 0);
        const of = $f('outForm'); if (kind === 'exit' && of && of.elements.all) of.elements.all.checked = true;
        return;
      }
      if (kind === 'add') S.rec = 'dep';
      else S.rec = gateOn() ? 'eq' : 'wd';   // with the workflow gate on, payouts are handled on the Balance desk
      render(); window.scrollTo(0, 0);
      const fm = $f('wdForm');
      if (kind === 'exit' && fm) { fm.elements.units.value = h.units; fm.dataset.last = 'units'; wdPrev(fm); toast(`Full exit: all ${f(h.units, 4)} units are filled in. Enter the exchange balance to see the payout.`); }
      else if (kind !== 'add' && gateOn()) toast(`${kind === 'exit' ? 'A full exit is a withdrawal of all their units: it' : 'Withdrawals'} go${kind === 'exit' ? 'es' : ''} through Approve, Quote and Redeem on this tab.`);
    }
    else if (a === 'settlenow') {
      const st = S.settle; if (!st || st.state !== 'due') return;
      if (!(await askSheet({ title: 'Charge fees and settle this period?', danger: true, confirmLabel: 'Charge fees and settle', body: SettleAuto.confirmBody(st) }))) return;
      await act(() => call('admin_close_quarter_tv', { p_php_rate: rate() || null, p_note: 'Two-month settlement (by the manager, true value)', p_idem: 'settle-' + st.period_end }), 'Settled: the fees moved to your account as units');
    }
    else if (a === 'sppreview' || a === 'spgate') {
      const fm = $f('qForm'), eq = a === 'spgate' ? Number(b.dataset.eq) : num(fv(fm, 'equity'));
      await loadPreview(eq, a === 'sppreview' ? atOf(fm) : null);
    }
    else if (a === 'payreq') {
      if (!LEGACY) { S.tab = 'record'; S.rec = 'out'; render(); window.scrollTo(0, 0); return; }   // the request is listed there with "Process"
      S.tab = 'record'; S.rec = 'wd'; render(); const fm = $f('wdForm');
      fm.elements.who.value = b.dataset.who; fm.elements.units.value = b.dataset.units; fm.elements.reqid.value = id; wdPrev(fm); fm.scrollIntoView();
    }
  }
  // EVERY action button shows a spinner until it is done (and ignores a second tap), so it never looks like nothing happened. Only these finish at once, with nothing
  // to wait for (they open a page or a sheet, flip a setting, fill a field or save a file from what is already on screen).
  const INSTANT = new Set(['cur', 'theme', 'adduser', 'help', 'userview', 'closemodal', 'maxunits', 'allunits', 'eye', 'welcome', 'splashskip', 'welcomenext', 'welcomeback',
    'welcomedone', 'termsback', 'readterms', 'profile', 'contact', 'payout', 'auditfilter', 'stmtpick', 'calmonth', 'stmtprint', 'stmtcsv', 'stmtallcsv', 'invact', 'payreq']);
  const spin = (b) => { b.style.setProperty('--spin', getComputedStyle(b).color); b.classList.add('busy'); };
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-action]');
    if (!b || INSTANT.has(b.dataset.action)) return onClick(ev);
    if (b.classList.contains('busy')) return;
    spin(b);
    // "Back to admin" hands over to the browser history, which finishes a moment after onClick returns: its spinner stays until the page changes (or 5 seconds)
    if (b.dataset.action === 'exitview') { setTimeout(() => b.isConnected && b.classList.remove('busy'), 5000); return onClick(ev); }
    return Promise.resolve(onClick(ev)).finally(() => b.classList.remove('busy'));
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.closest('#loginForm') && ev.target.getAttribute('aria-invalid')) ev.target.removeAttribute('aria-invalid');
  });
  document.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fm = ev.target, id = fm.id, btn = fm.querySelector('button:not([type=button])');
    if (btn) { btn.disabled = true; spin(btn); }
    try {
      if (id === 'loginForm') {
        loginError(null, fm);
        const r = await rpc('login', { p_username: fv(fm, 'username'), p_password: fv(fm, 'password') });
        if (!r.ok) { loginError(r.error, fm); if (btn) btn.disabled = false; return; }
        S.token = r.token; store.set(r.token); await refresh();
      } else if (id === 'pwForm') {
        await call('change_my_password', { p_old: fv(fm, 'old'), p_new: fv(fm, 'new') });
        fm.reset(); toast('Password changed'); if (btn) btn.disabled = false;
      } else if (id === 'nameForm') {
        await call('set_my_name', { p_name: fv(fm, 'name') });
        await refresh('Name saved');
      } else if (id === 'usernameForm') {
        const u = await call('change_my_username', { p_password: fv(fm, 'pw'), p_username: fv(fm, 'username') });
        await refresh(`Username changed. You now sign in as ${u}.`);
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
      } else if (id === 'contactForm') {
        await call('set_my_contact', { p_phone: fv(fm, 'phone'), p_email: fv(fm, 'email') || null, p_emergency_name: fv(fm, 'en') || null, p_emergency_phone: fv(fm, 'ep') || null });
        await refresh('Contact details saved');
      } else if (fm.classList.contains('adminContactForm')) {
        await call('admin_set_contact', { p_profile: fm.dataset.id, p_phone: fv(fm, 'phone'), p_email: fv(fm, 'email') || null, p_emergency_name: fv(fm, 'en') || null, p_emergency_phone: fv(fm, 'ep') || null });
        await refresh('Contact details saved');
      } else if (fm.classList.contains('adminPayoutForm')) {
        const cur = payOf(fm.dataset.id), qr = await uploadQr(fm.elements.qr.files[0], cur && cur.qr_path);
        await call('admin_set_payout', { p_profile: fm.dataset.id, p_method: fv(fm, 'method'), p_name: fv(fm, 'pname'), p_number: fv(fm, 'pnum'), p_bank: null, p_qr: qr });
        await refresh('Withdrawal details saved');
      } else if (fm.classList.contains('adminUserForm')) {
        const u = await call('admin_set_username', { p_profile: fm.dataset.id, p_username: fv(fm, 'username') });
        await refresh(`Username changed to ${u}. Tell them, they sign in with it.`);
      } else if (id === 'payoutForm') {
        const qr = await uploadQr(fm.elements.qr.files[0], S.payout && S.payout.qr_path);
        await call('set_my_payout', { p_method: fv(fm, 'method'), p_name: fv(fm, 'pname'), p_number: fv(fm, 'pnum'), p_bank: null, p_qr: qr });
        await refresh('Payout details saved');
      } else if (id === 'reqForm') {
        // USDT -> units at today's unit price; no peso rate is involved. The peso minimum is the database's own check (request_withdrawal).
        const units = Contribution.withdrawUnits(num(fv(fm, 'amount')), S.me.unit_price, S.me.unlocked_units);
        if (units == null) throw new Error('Enter the amount to withdraw in USDT.');
        const r = await call('request_withdrawal', { p_units: units, p_note: null });
        await refresh(`Requested. You will be paid by ${day(r.pay_by)}.`);
      } else if (id === 'wfBal') {
        await moneyCall(fm, 'admin_enter_balance', { p_total: num(fv(fm, 'total')), p_positions: Number(fv(fm, 'pos') || 0), p_orders: Number(fv(fm, 'ord') || 0), p_note: null });
        await refresh('Balance entered. Check it, then confirm it.');
      } else if (id === 'eqForm') {
        const r = await moneyCall(fm, 'admin_post_equity', { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
        await refresh(Number(r.converted) ? `Equity saved. ${r.converted} waiting deposit${Number(r.converted) === 1 ? '' : 's'} joined at ${f(r.unit_price, 4)}.` : 'Equity saved');
      } else if (id === 'spreadForm') {
        const { fig, args } = spreadArgs(fm); if (!fig || !args) throw new Error('Enter the pesos paid, the actual rate and the admission rate.');
        if (args.p_source === 'manager_reallocation' && !(await confirmSheet('Move units from your capital?', `${usdt(fig.credited, 6)} of your units go to the investor at the true-value price. No new money joins the pool; the surplus ${usdt(fig.surplus, 6)} stays yours. This is recorded immediately.`, 'Move the units', true))) { if (btn) btn.disabled = false; return; }
        const r = await moneyCall(fm, 'admin_admission_spread', { ...args, p_note: null, p_in_mexc: !!(fm.elements.inmexc && fm.elements.inmexc.checked && args.p_source === 'p2p_purchase') });
        await refresh(r.status === 'done' ? `Done: ${f(r.units, 4)} units moved from you to the investor; the surplus ${usdt(r.surplus_usdt, 6)} stays yours.` : `Recorded: ${usdt(r.credited_usdt, 6)} credited, ${usdt(r.surplus_usdt, 6)} is yours. It waits until it is in the exchange, then admit both parts together.`);
      } else if (id === 'depForm') {
        const d = depUsdt(fm); if (!d || !(d.usdt > 0)) throw new Error(fv(fm, 'ccy') === 'USDT' ? 'Enter the USDT received.' : 'Enter the pesos paid and the USDT actually received.');
        if (fm.elements.frommgr && fm.elements.frommgr.checked) {
          if (!(num(fv(fm, 'eq')) > 0)) throw new Error('Type the exchange balance now (Spot + Futures, open trades included).');
          const r = await moneyCall(fm, 'admin_units_from_manager', { p_profile: fv(fm, 'who'), p_usdt: d.usdt, p_equity_before: num(fv(fm, 'eq')), p_php_rate: d.rate, p_php_amount: d.php,
            p_note: fv(fm, 'note') || null, p_at: atOf(fm) });
          await refresh(`Gave ${f(r.units, 4)} of your units (${usdt(d.usdt)}${d.php != null ? ', ' + php(d.php) : ''}) to them. Nothing went into the exchange.`);
          return;
        }
        await moneyCall(fm, 'admin_receive_deposit', { p_profile: fv(fm, 'who'), p_usdt: d.usdt, p_php_rate: d.rate, p_php_amount: d.php,
          p_note: fv(fm, 'note') || null, p_at: atOf(fm), p_in_mexc: fm.elements.inmexc.checked });
        await refresh(`Received ${d.php != null ? php(d.php) + ' = ' : ''}${usdt(d.usdt)}. It buys units at your next equity reading.`);
      } else if (id === 'wdForm') {
        const mgr = fm.elements.tomgr.checked;
        const r = await moneyCall(fm, mgr ? 'admin_withdraw_to_manager' : 'admin_withdraw', { p_profile: fv(fm, 'who'), p_units: num(fv(fm, 'units')), p_equity_before: num(fv(fm, 'eq')),
          p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm), p_force: fm.elements.force.checked, p_request_id: num(fv(fm, 'reqid')) });
        const est = rate() ? ` (${peso(r.pay_usdt, rate())} at today's rate, an estimate)` : '';
        await refresh(mgr ? `Moved ${usdt(r.pay_usdt)}${est} to your fund manager account. Nothing left Exchange.`
          : `Withdrawal recorded. Pay out ${usdt(r.pay_usdt)}${est}`);
      } else if (id === 'addForm') {
        const v = formVals(fm), a = Desk.cashArgs(v);
        const r = await moneyCall(fm, 'admin_add_investor', { p_username: v.username, p_name: v.name, p_password: v.password, p_fee_rate: num(v.fee) == null ? null : num(v.fee) / 100,
          p_php_amount: a ? a.p_php_amount : null, p_usdt_received: a ? a.p_usdt_received : null, p_rate: a ? a.p_rate : null, p_in_mexc: !!v.inmexc });
        await refresh((r.cash_in ? joinedText(r.cash_in, `Account created for ${v.name}`) : `Account created for ${v.name}.`) + ' Send them the username and password.');
      } else if (id === 'cashForm') {
        const v = formVals(fm), a = Desk.cashArgs(v); if (!a) throw new Error('Enter the USDT that arrived in MEXC.');
        const r = await moneyCall(fm, 'admin_cash_in', { ...a, p_note: v.note || null });
        await refresh(joinedText(r, 'Cash-in'));
      } else if (id === 'outForm') {
        const v = formVals(fm), a = Desk.outArgs(v); if (!a) throw new Error('Choose who, and the amount in USDT (or everything).');
        if (!(await confirmSheet('Withdraw now?', `${a.p_all ? 'Everything they hold' : usdt(a.p_usdt)} is redeemed at the live price and recorded as a payout to send from MEXC. Their units are sold now.`, 'Withdraw', true))) { if (btn) btn.disabled = false; return; }
        const r = await moneyCall(fm, 'admin_withdraw_now', { ...a, p_note: v.note || null });
        await refresh(`Redeemed: send ${usdt(r.pay_usdt, 6)} from MEXC, then press Mark sent.`);
      } else if (id === 'moveForm') {
        const v = formVals(fm), a = Desk.moveArgs(v); if (!a) throw new Error('Choose from and to, and the amount in pesos or USDT (or everything).');
        if (!(await confirmSheet('Transfer now?', 'Ownership moves at the live price. Nobody else\'s value changes. This is recorded immediately.', 'Transfer', true))) { if (btn) btn.disabled = false; return; }
        const r = await moneyCall(fm, 'admin_transfer', { ...a, p_note: v.note || null });
        await refresh(`Transferred ${usdt(r.usdt, 4)} (${f(r.net_units, 4)} units) at ${f(r.unit_price, 4)}${Number(r.fee_usdt) > 0 ? `; ${usdt(r.fee_usdt, 4)} profit share taken from the sender` : ''}`);
      } else if (id === 'qForm') {
        if (!(await settleSheet(num(fv(fm, 'equity')), atOf(fm)))) { if (btn) btn.disabled = false; return; }
        const r = await settleWithExceptions(fm, { p_equity: num(fv(fm, 'equity')), p_php_rate: num(fv(fm, 'rate')), p_note: fv(fm, 'note') || null, p_at: atOf(fm), ...previewArg(num(fv(fm, 'equity')), atOf(fm)) });
        await refresh(`Period settled: fees charged on ${r.investors_charged} investor(s), ${f(r.fee_units, 4)} units`);
      } else if (btn) btn.disabled = false;
    } catch (e) {
      if (id === 'loginForm') loginError(/fetch|network|Failed/i.test(e.message) ? 'Cannot reach the server. Check your internet connection and try again.'
        : /function|schema cache/i.test(e.message) ? 'The database is not set up yet (run the migration).' : e.message, fm);
      else if (e.message !== 'Signed out') toast(e.message || String(e), true);
      if (btn && btn.isConnected) btn.disabled = false;
    } finally { if (btn) btn.classList.remove('busy'); }
  });

  // ---------------------------------------------------------------- start
  try { S.cur = localStorage.getItem('ledger.cur') === 'USDT' ? 'USDT' : 'PHP'; } catch { /* default pesos */ }
  S.token = store.get(); S.adminToken = store.get(ADMIN_KEY);
  if (S.token) refresh(); else loginView();
  // coming back from the bot dashboard with the Back button restores this page as it was (Bot dashboard button still disabled): draw it fresh
  window.addEventListener('pageshow', (ev) => { if (ev.persisted && S.token && S.me) render(); });
})();

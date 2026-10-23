// app.js - the bot dashboard page. Everything shown comes from GET /api/data (password-gated). No libraries; values are put into the page with
// textContent only, never as HTML.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };

  let tz = store.get('bot.tz') === 'local' ? 'local' : 'utc', data = null, modeSel = store.get('bot.mode') || '';
  const filters = { coin: '', side: '', reason: '', from: '', to: '' };

  // ---------------- formatting ----------------
  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    if (ms == null) return '—';
    const d = new Date(ms);
    return tz === 'utc' ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const fmtPx = (v) => (v == null ? '—' : String(Number(Number(v).toPrecision(6))));
  const fmtR = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`);
  const cls = (v) => (v > 0 ? 'good' : v < 0 ? 'bad' : '');
  function fmtDur(sec) {
    if (sec == null) return '—'; sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  }
  const sym = (s) => String(s || '').replace('_USDT', '');

  // ---------------- tables ----------------
  function table(cols, rows, empty) {
    if (!rows.length) return el('div', { class: 'empty' }, empty);
    return el('table', {}, el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.left ? 'l' : '' }, c.h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, cols.map((c) => { const v = c.f(r); return el('td', { class: `${c.left ? 'l' : ''} ${c.c ? c.c(r) : ''}` }, v); })))));
  }

  // ---------------- charts (inline SVG) ----------------
  function lineChart(host, pts, key, { dd = false } = {}) {
    clear(host);
    if (!pts.length) { host.append(el('div', { class: 'empty' }, 'No closed trades yet.')); return; }
    const W = 640, H = 220, L = 44, R = 10, T = 10, B = 26;
    const xs = pts.map((p) => p.ts), ys = pts.map((p) => p[key]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    let y0 = Math.min(0, ...ys), y1 = Math.max(0.5, ...ys);
    if (dd) { y0 = 0; y1 = Math.max(1, ...ys); }
    const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), sy = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': dd ? 'drawdown chart' : 'equity curve' });
    svg.append(sv('line', { class: 'axis', x1: L, y1: T, x2: L, y2: H - B }), sv('line', { class: 'axis', x1: L, y1: H - B, x2: W - R, y2: H - B }));
    if (!dd && y0 < 0) svg.append(sv('line', { class: 'zero', x1: L, y1: sy(0), x2: W - R, y2: sy(0) }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p[key]).toFixed(1)}`).join(' ');
    const base = sy(dd ? 0 : Math.max(y0, 0)).toFixed(1);
    svg.append(sv('path', { class: dd ? 'dd' : 'area', d: `${path} L${sx(pts[pts.length - 1].ts).toFixed(1)},${base} L${sx(pts[0].ts).toFixed(1)},${base} Z` }));
    if (!dd) svg.append(sv('path', { class: 'line', d: path }));
    const t = (x, y, s, anchor) => { const n = sv('text', { x, y, 'text-anchor': anchor || 'start' }); n.textContent = s; return n; };
    svg.append(t(L - 6, T + 8, `${y1.toFixed(1)}R`, 'end'), t(L - 6, H - B, `${y0.toFixed(1)}R`, 'end'), t(L, H - 8, fmtTime(x0).slice(0, 10)), t(W - R, H - 8, fmtTime(x1).slice(0, 10), 'end'));
    host.append(svg);
  }

  // ---------------- render ----------------
  function modeTags(mode) { for (const n of document.querySelectorAll('.modeTag')) { n.textContent = mode.toUpperCase(); n.className = `modeTag ${mode}`; } }

  function render(d) {
    data = d;
    const mode = d.mode;
    modeTags(mode);
    const ms = $('#modeSelect');
    if (d.modes_seen.length > 1) { ms.hidden = false; clear(ms); for (const m of d.modes_seen) ms.append(el('option', { value: m, selected: m === mode }, m)); } else ms.hidden = true;

    // status banner
    const s = d.status, b = $('#banner'); clear(b);
    b.className = `card hero ${s.last_heartbeat_ms == null ? '' : s.alive ? '' : 'stale'}`;
    const ago = s.age_ms == null ? null : fmtDur(s.age_ms / 1000);
    const dd = s.drawdown_r, halt = s.halt_r;
    b.append(el('div', { class: 'status' }, el('span', { class: `badge ${mode}` }, mode.toUpperCase()), el('span', { class: `state ${s.last_heartbeat_ms == null ? 'muted' : s.alive ? 'good' : 'bad'}` },
      s.last_heartbeat_ms == null ? 'Waiting for the first heartbeat' : s.alive ? 'Alive' : `Stale: no heartbeat for ${ago} (limit ${fmtDur(s.stale_after_ms / 1000)})`)));
    const tiles = el('div', { class: 'kvs' });
    b.append(tiles);
    if (s.last_heartbeat_ms != null) {
      tiles.append(el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Last heartbeat'), el('div', { class: 'v' }, `${fmtTime(s.last_heartbeat_ms)} (${ago} ago)`)),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Mode'), el('div', { class: 'v' }, String(s.mode).toUpperCase())),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Kill switch'), el('div', { class: `v ${s.kill_switch ? 'bad' : 'good'}` }, s.kill_switch ? 'ON: no new entries' : 'off')),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Drawdown vs halt'), el('div', { class: 'v' }, dd == null ? '—' : `${Number(dd).toFixed(1)}R of ${halt ?? '—'}R`), (() => { const m = el('div', { class: 'meter' }); const i = el('i'); i.style.setProperty('width', `${Math.min(100, halt ? (dd / halt) * 100 : 0)}%`); m.append(i); return m; })()),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Last candle processed'), el('div', { class: 'v' }, Object.entries(s.last_candle_ms || {}).map(([k, v]) => `${sym(k)} ${fmtTime(v)}`).join(' · ') || '—')),
        el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Build'), el('div', { class: 'v' }, `${s.commit || '?'} · v${s.version || '?'} · up ${fmtDur(s.uptime_sec)}`)));
    }

    // open positions
    clear($('#open')).append(table([
      { h: 'Coin', left: true, f: (r) => `${sym(r.symbol)} ${r.side}` }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) }, { h: 'TP', f: (r) => fmtPx(r.tp) },
      { h: 'Now', f: (r) => fmtPx(r.price) }, { h: 'Current R', f: (r) => (r.current_r == null ? '—' : fmtR(r.current_r)), c: (r) => cls(r.current_r) }, { h: 'Opened', f: (r) => fmtTime(r.entry_ts) },
    ], d.open, 'No open positions.'));

    // charts
    lineChart($('#equityChart'), d.equity, 'r_cum');
    $('#equityNote').textContent = d.equity.length ? `Cumulative R over ${d.overall.trades} closed trades: ${fmtR(d.overall.total_r)}` : '';
    lineChart($('#ddChart'), d.equity, 'dd_r', { dd: true });
    $('#ddNow').textContent = d.equity.length ? `Max drawdown ${Number(d.overall.max_dd_r).toFixed(1)}R · now ${Number(d.equity[d.equity.length - 1].dd_r).toFixed(1)}R · ${d.overall.trades} trades` : '';

    // filters
    const coinSel = $('#fCoin'), have = [...coinSel.options].map((o) => o.value);
    for (const sy of Object.keys(d.per_coin)) if (!have.includes(sy)) coinSel.append(el('option', { value: sy }, sym(sy)));
    renderTrades();

    // per coin
    const rows = Object.entries(d.per_coin).map(([k, v]) => ({ coin: k, ...v })).concat(d.overall.trades ? [{ coin: 'ALL', ...d.overall }] : []);
    clear($('#perCoin')).append(table([
      { h: 'Coin', left: true, f: (r) => sym(r.coin) }, { h: 'Trades', f: (r) => r.trades }, { h: 'Win rate', f: (r) => (r.win_rate == null ? '—' : `${(r.win_rate * 100).toFixed(0)}%`) },
      { h: 'Profit factor', f: (r) => (r.profit_factor == null ? '—' : r.profit_factor) }, { h: 'Avg R', f: (r) => fmtR(r.avg_r), c: (r) => cls(r.avg_r) },
      { h: 'Total R (n)', f: (r) => `${fmtR(r.total_r)} (n=${r.trades})`, c: (r) => cls(r.total_r) }, { h: 'Max DD', f: (r) => `${r.max_dd_r}R` }, { h: 'Longest losing streak', f: (r) => r.longest_losing_streak },
    ], rows, 'No closed trades yet.'));

    // skipped signals
    clear($('#skipped')).append(table([
      { h: 'Signal candle', left: true, f: (r) => fmtTime(r.signal_candle_open_ms) }, { h: 'Coin', f: (r) => `${sym(r.symbol)} ${r.side || ''}` }, { h: 'Reason', left: true, f: (r) => el('span', { class: 'chip' }, r.reason) },
      { h: 'Detail', left: true, f: (r) => r.detail || '' },
    ], d.skipped, 'No skipped signals.'));

    // compare
    const c = $('#compare'); clear(c);
    if (!d.compare) c.append(el('div', { class: 'empty' }, 'No comparison received yet (compare-live-vs-backtest.js --push).'));
    else {
      c.append(el('p', { class: 'strong' }, el('span', { class: d.compare.match ? 'good' : 'bad' }, d.compare.match ? 'MATCH' : 'NOT A MATCH'), ` · ${fmtTime(d.compare.window_from_ms)} to ${fmtTime(d.compare.window_to_ms)} · tolerance ${d.compare.tolerance_r}R · checked ${fmtTime(d.compare.ts)}`),
        el('p', {}, `${d.compare.matched ?? 0} matched · ${d.compare.live_only ?? 0} live-only · ${d.compare.backtest_only ?? 0} backtest-only · ${d.compare.skipped_signals ?? 0} skipped signals · ${d.compare.candle_diffs ?? 0} candle differences`));
      c.append(table([
        { h: 'Kind', left: true, f: (r) => r.kind }, { h: 'Coin', f: (r) => `${sym(r.symbol)} ${r.side || ''}` }, { h: 'Signal candle', f: (r) => fmtTime(r.signal_candle_open_ms) },
        { h: 'Near threshold', f: (r) => (r.nearest_threshold_pct == null ? '—' : `${Number(r.nearest_threshold_pct).toFixed(3)}%`) }, { h: 'Why', left: true, f: (r) => r.why },
      ], d.compare.mismatches || [], 'No mismatches.'));
    }
    $('#footer').textContent = `Updated ${fmtTime(d.generated_at)} · times in ${tz === 'utc' ? 'UTC' : 'your local time'} · ${d.mode.toUpperCase()} data`;
  }

  function renderTrades() {
    if (!data) return;
    const f = filters, from = f.from ? Date.parse(f.from + 'T00:00:00Z') : null, to = f.to ? Date.parse(f.to + 'T23:59:59Z') : null;
    const rows = data.trades.filter((t) => (!f.coin || t.symbol === f.coin) && (!f.side || t.side === f.side) && (!f.reason || t.reason === f.reason) && (from == null || t.exit_ts >= from) && (to == null || t.exit_ts <= to)).sort((a, b) => b.exit_ts - a.exit_ts);
    const total = rows.reduce((a, t) => a + t.r, 0);
    $('#tradeSummary').textContent = `${rows.length} trade${rows.length === 1 ? '' : 's'} · total ${fmtR(total)} (n=${rows.length})`;
    clear($('#trades')).append(table([
      { h: 'Exit', left: true, f: (r) => fmtTime(r.exit_ts) }, { h: 'Coin', f: (r) => `${sym(r.symbol)} ${r.side}` }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) }, { h: 'TP', f: (r) => fmtPx(r.tp) },
      { h: 'Exit px', f: (r) => fmtPx(r.exit) }, { h: 'Why', f: (r) => el('span', { class: 'chip' }, r.reason) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) }, { h: 'Held', f: (r) => fmtDur(r.hold_sec) },
      { h: 'Mode', f: (r) => String(r.mode).toUpperCase() },
    ], rows, 'No trades match.'));
  }

  // ---------------- data + login ----------------
  async function load() {
    try {
      const res = await fetch('/api/data' + (modeSel ? `?mode=${encodeURIComponent(modeSel)}` : ''), { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) return showLogin('');
      if (res.status === 503) return showLogin('The dashboard login is not configured on the server (set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET in Vercel).');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $('#login').hidden = true; $('#app').hidden = false; $('#logoutBtn').hidden = false;
      render(await res.json());
    } catch (e) { showLogin(`Could not load data: ${e.message}`); }
  }
  function showLogin(msg) { $('#app').hidden = true; $('#login').hidden = false; $('#logoutBtn').hidden = true; $('#loginMsg').textContent = msg; }

  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('#loginMsg').textContent = '';
    try {
      const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
      $('#pw').value = '';
      if (res.ok) return load();
      $('#loginMsg').textContent = res.status === 429 ? 'Too many attempts. Wait a few minutes.' : res.status === 503 ? 'Login is not configured on the server.' : 'Wrong password.';
    } catch { $('#loginMsg').textContent = 'Network error.'; }
  });
  $('#logoutBtn').addEventListener('click', async () => { try { await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }); } catch {} showLogin(''); });
  $('#refreshBtn').addEventListener('click', load);
  $('#modeSelect').addEventListener('change', (e) => { modeSel = e.target.value; store.set('bot.mode', modeSel); load(); });
  $('#tzBtn').addEventListener('click', () => { tz = tz === 'utc' ? 'local' : 'utc'; store.set('bot.tz', tz); $('#tzBtn').textContent = tz === 'utc' ? 'UTC' : 'Local'; if (data) render(data); });
  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); store.set('bot.theme', next);
  });
  for (const [id, k] of [['fCoin', 'coin'], ['fSide', 'side'], ['fReason', 'reason'], ['fFrom', 'from'], ['fTo', 'to']]) $(`#${id}`).addEventListener('change', (e) => { filters[k] = e.target.value; renderTrades(); });

  const saved = store.get('bot.theme'); if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  $('#tzBtn').textContent = tz === 'utc' ? 'UTC' : 'Local';
  load();
  setInterval(() => { if (!document.hidden && !$('#app').hidden) load(); }, 60000);   // keeps the alive/stale banner honest
})();

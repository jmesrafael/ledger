// app.js - the bot dashboard page. Everything shown comes from GET /api/data (password-gated). No libraries; values are put into the page with
// textContent only, never as HTML.
// Light by design: /api/data answers 304 when nothing changed (nothing is re-downloaded or redrawn), only the open tab is drawn (the others are drawn
// when first opened after new data), and the one-second clock pauses while the page is in the background.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const clear = (n) => { n.replaceChildren(); return n; };
  // append text and elements, flattening nested lists (the native append would print an array as "[object HTMLElement]")
  const add = (parent, ...kids) => { for (const k of kids.flat(Infinity)) if (k != null && k !== false) parent.append(k.nodeType ? k : document.createTextNode(String(k))); return parent; };
  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };

  let tz = store.get('bot.tz') === 'local' ? 'local' : 'utc', data = null, etag = null, modeSel = store.get('bot.mode') || '';
  let chartDays = [0, 1, 7, 30, 91].includes(+store.get('bot.range')) ? +store.get('bot.range') : 0;   // chart range in days: 1 day, 1 week ... ; 0 = everything
  let chartKind = ['capital', 'perf', 'r', 'dd'].includes(store.get('bot.chart')) ? store.get('bot.chart') : 'capital';
  let period = ['month', 'year', 'day'].includes(store.get('bot.period')) ? store.get('bot.period') : 'month';
  let bot = store.get('bot.view') === 'icore' ? 'icore' : 'bbcore';
  const filters = { coin: '', side: '', reason: '', from: '', to: '' };

  // ---------------- formatting ----------------
  const pad = (n) => String(n).padStart(2, '0');
  const parts = (ms) => { const d = new Date(ms), u = tz === 'utc'; return { y: u ? d.getUTCFullYear() : d.getFullYear(), mo: (u ? d.getUTCMonth() : d.getMonth()) + 1, d: u ? d.getUTCDate() : d.getDate(), h: u ? d.getUTCHours() : d.getHours(), mi: u ? d.getUTCMinutes() : d.getMinutes(), s: u ? d.getUTCSeconds() : d.getSeconds() }; };
  const tzTag = () => (tz === 'utc' ? ' UTC' : '');
  // "Jan 20, 2026" and "9:00pm" (12-hour, no space), in UTC or local per the Times switch
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock12 = (p, secs) => `${p.h % 12 || 12}:${pad(p.mi)}${secs ? ':' + pad(p.s) : ''}${p.h < 12 ? 'am' : 'pm'}`;
  const fmtDay = (ms) => { const p = parts(ms); return `${MON[p.mo - 1]} ${p.d}, ${p.y}`; };
  function fmtTime(ms) { if (ms == null) return '—'; const p = parts(ms); return `${fmtDay(ms)} ${clock12(p)}${tzTag()}`; }
  function fmtShort(ms) { if (ms == null) return '—'; const p = parts(ms); return `${fmtDay(ms)} ${clock12(p)}`; }
  function fmtHm(ms) { if (ms == null) return '—'; return clock12(parts(ms)); }   // 12-hour, e.g. 3:56am (callers add the UTC tag)
  const fmtPx = (v) => (v == null ? '—' : String(Number(Number(v).toPrecision(6))));
  const fmtR = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`);
  const fmtUsd = (v, signed) => (v == null ? '—' : `${signed ? (v >= 0 ? '+' : '−') : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const fmtPct = (v, signed) => (v == null ? '—' : `${signed && v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const pct0 = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);
  const cls = (v) => (v > 0 ? 'good' : v < 0 ? 'bad' : '');
  function fmtDur(sec) {
    if (sec == null) return '—'; sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${pad(m)}m` : m ? `${m}m` : `${sec}s`;
  }
  const sym = (s) => String(s || '').replace('_USDT', '');
  const sideEl = (s) => (s ? el('span', { class: `side ${s}` }, s) : '');
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const periodLabel = (k) => (k.length === 7 ? `${MONTHS_LONG[+k.slice(5) - 1].slice(0, 3)} ${k.slice(0, 4)}` : k.length === 10 ? `${MON[+k.slice(5, 7) - 1]} ${+k.slice(8)}, ${k.slice(0, 4)}` : k);
  // live relative times: refreshed every second by tick()
  const ago = (ms) => el('small', { 'data-ago': ms }, `${fmtDur((Date.now() - ms) / 1000)} ago`);
  const until = (ms) => el('small', { 'data-until': ms }, ms > Date.now() ? `in ${fmtDur((ms - Date.now()) / 1000)}` : 'due now');
  const kv = (k, v, sub) => el('div', {}, el('dt', {}, k), el('span', { class: 'fill', 'aria-hidden': 'true' }), el('dd', {}, v, sub || null));
  const tile = (k, v, sub, c) => el('div', { class: 'tile' }, el('div', { class: 'k' }, k), el('div', { class: `v ${c || ''}` }, v), sub != null ? el('div', { class: 's' }, sub) : null);
  const LVL = { ok: 'OK', info: 'INFO', wait: 'WAIT', warn: 'WATCH', stop: 'STOP' };
  const lvlChip = (l) => el('span', { class: `lvl ${l}` }, LVL[l] || l);

  // ---------------- the selected bot (Performance and Trades) ----------------
  const hasIcore = () => !!(data && data.perf && data.perf.icore);
  const view = () => {
    const d = data, ic = bot === 'icore' && hasIcore();
    return ic ? { key: 'icore', label: 'I-Core', mode: d.bots.icore.mode, perf: d.perf.icore, trades: d.bots.icore.trades || [] }
      : { key: 'bbcore', label: 'BB-Core', mode: d.mode, perf: d.perf ? d.perf.bbcore : null, trades: d.trades };
  };

  // ---------------- tables ----------------
  function table(cols, rows, empty) {
    if (!rows.length) return el('div', { class: 'empty' }, empty);
    return el('table', {}, el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.left ? 'l' : '' }, c.h)))),
      el('tbody', {}, rows.map((r) => el('tr', { class: r._cls || null }, cols.map((c) => el('td', { class: `${c.left ? 'l' : ''} ${c.c ? c.c(r) : ''}` }, c.f(r)))))));
  }

  // ---------------- charts (inline SVG) ----------------
  function lineChart(host, pts, { dd = false, fmtY = (v) => v.toFixed(1), empty = 'No closed trades yet.', marks = [], hline = null } = {}) {
    clear(host);
    if (!pts.length) { host.append(el('div', { class: 'empty' }, empty)); return; }
    const W = 680, H = 250, L = 62, R = 14, T = 12, B = 26;
    const xs = pts.map((p) => p.ts), ys = pts.map((p) => p.y).concat(hline != null ? [hline] : []);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (dd) { y0 = 0; y1 = Math.max(1, y1); } else { const padY = (y1 - y0) * 0.12 || Math.abs(y1) * 0.02 || 1; y0 -= padY; y1 += padY; }
    const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), sy = (y) => T + (dd ? (y - y0) / (y1 - y0) : 1 - (y - y0) / (y1 - y0)) * (H - T - B);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': dd ? 'drawdown chart' : 'line chart' });
    const defs = sv('defs'), g = sv('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
    g.append(sv('stop', { offset: '0%', style: 'stop-color:var(--accent-text);stop-opacity:.28' }), sv('stop', { offset: '100%', style: 'stop-color:var(--accent-text);stop-opacity:0' }));
    defs.append(g); svg.append(defs);
    const t = (x, y, s, anchor) => { const n = sv('text', { x, y, 'text-anchor': anchor || 'start' }); n.textContent = s; return n; };
    for (let i = 0; i <= 4; i++) {
      const v = y0 + ((y1 - y0) * i) / 4, y = sy(v);
      svg.append(sv('line', { class: 'grid-l', x1: L, y1: y, x2: W - R, y2: y }), t(L - 8, y + 3.5, fmtY(v), 'end'));
    }
    if (!dd && y0 < 0 && y1 > 0) svg.append(sv('line', { class: 'zero', x1: L, y1: sy(0), x2: W - R, y2: sy(0) }));
    if (hline != null) svg.append(sv('line', { class: 'limit', x1: L, y1: sy(hline), x2: W - R, y2: sy(hline) }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const base = (dd ? sy(0) : H - B).toFixed(1), last = pts[pts.length - 1];
    svg.append(sv('path', { class: dd ? 'dd' : 'area', d: `${path} L${sx(last.ts).toFixed(1)},${base} L${sx(pts[0].ts).toFixed(1)},${base} Z` }));
    if (!dd) svg.append(sv('path', { class: 'line', d: path }), sv('circle', { class: 'dot', cx: sx(last.ts), cy: sy(last.y), r: 3.5 }));
    // capital added or removed: a labeled step, never part of the line's gain
    marks.filter((m) => m.ts >= x0 && m.ts <= x1).forEach((m, i) => {
      const x = sx(m.ts), up = m.usd >= 0, lbl = t(Math.min(x + 3, W - R - 2), T + 10 + (i % 3) * 11, `${up ? '+' : '−'}$${Math.abs(m.usd).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${m.usd >= 0 ? 'capital' : 'payout'}`, x > W - 120 ? 'end' : 'start');
      lbl.setAttribute('class', `flow-t ${up ? 'in' : 'out'}`);
      svg.append(sv('line', { class: `flow-l ${up ? 'in' : 'out'}`, x1: x, y1: T, x2: x, y2: H - B }), lbl);
    });
    svg.append(t(L, H - 7, fmtDay(x0)), t(W - R, H - 7, fmtDay(x1), 'end'));
    host.append(svg);
  }
  // one bar per period: R gained (up, green) or lost (down, red); the label under every few bars
  function barChart(host, rows, empty) {
    clear(host);
    if (!rows.length) { host.append(el('div', { class: 'empty' }, empty)); return; }
    const W = 680, H = 170, L = 46, R = 8, T = 10, B = 22, n = rows.length;
    const ys = rows.map((r) => r.r), hi = Math.max(0, ...ys), lo = Math.min(0, ...ys), span = hi - lo || 1;
    const sy = (v) => T + ((hi - v) / span) * (H - T - B), bw = Math.min(64, (W - L - R) / n), gap = Math.min(4, bw * 0.25);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'R by period' });
    const t = (x, y, s, anchor) => { const e = sv('text', { x, y, 'text-anchor': anchor || 'middle' }); e.textContent = s; return e; };
    svg.append(sv('line', { class: 'zero', x1: L, y1: sy(0), x2: W - R, y2: sy(0) }), t(L - 6, sy(hi) + 4, `${hi.toFixed(1)}R`, 'end'), t(L - 6, sy(lo) + 4, `${lo.toFixed(1)}R`, 'end'));
    const every = Math.max(1, Math.ceil(n / 8));
    rows.forEach((r, i) => {
      const x = L + i * bw + gap / 2, y = sy(Math.max(0, r.r)), h = Math.max(1, Math.abs(sy(r.r) - sy(0)));
      const b = sv('rect', { class: r.r >= 0 ? 'bar up' : 'bar down', x: x.toFixed(1), y: y.toFixed(1), width: Math.max(1, bw - gap).toFixed(1), height: h.toFixed(1), rx: 2 });
      const tt = sv('title'); tt.textContent = `${periodLabel(r.key)}: ${fmtR(r.r)} · ${r.trades} trade${r.trades === 1 ? '' : 's'}`; b.append(tt); svg.append(b);
      if (i % every === 0 || i === n - 1) svg.append(t(x + (bw - gap) / 2, H - 6, r.key.length === 7 ? periodLabel(r.key) : r.key.length === 10 ? r.key.slice(5) : r.key));
    });
    host.append(svg);
  }
  function spark(host, ys) {
    clear(host);
    if (ys.length < 2) return;
    const lo = Math.min(...ys), hi = Math.max(...ys), W = 100, H = 30;
    const d = ys.map((y, i) => `${i ? 'L' : 'M'}${((i / (ys.length - 1)) * W).toFixed(2)},${(H - 2 - ((y - lo) / (hi - lo || 1)) * (H - 4)).toFixed(2)}`).join(' ');
    const s = sv('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }); s.append(sv('path', { d })); host.append(s);
  }

  const CANDLE_MS = 4 * 3600e3;   // last_candle_ms holds each coin's candle OPEN time; the bot checks that candle when it closes, 4 hours later
  const closeOf = (v) => v + CANDLE_MS;

  // ---------------- render: the header always, the open tab now, the other tabs when they are opened ----------------
  const TABS = ['overview', 'performance', 'trades', 'verify', 'log', 'status'];
  const dirty = new Set();
  function render(d) {
    data = d;
    if (!hasIcore()) bot = 'bbcore';
    const mode = d.mode, s = d.status, waiting = s.last_heartbeat_ms == null;
    // mode switch in the settings menu (only when both paper and live data exist)
    $('#modeRow').hidden = d.modes_seen.length < 2;
    clear($('#modeSeg')).append(...d.modes_seen.map((m) => el('button', { type: 'button', 'data-mode': m, class: m === mode ? 'on' : '' }, m)));
    // status pill + alert strip
    const pill = $('#statusPill'); pill.hidden = false;
    pill.className = `pill ${waiting ? '' : s.alive ? 'ok' : 'bad'}`;
    pill.textContent = `${mode.toUpperCase()} · ${waiting ? 'WAITING' : s.alive ? 'ONLINE' : 'STALE'}`;
    const alert = $('#alert');
    if (!waiting && !s.alive) { alert.hidden = false; alert.className = 'alert'; alert.textContent = `Bot is not reporting: no heartbeat for ${fmtDur(s.age_ms / 1000)} (limit ${fmtDur(s.stale_after_ms / 1000)}). Check the VPS.`; }
    else if (s.kill_switch) { alert.hidden = false; alert.className = 'alert warn'; alert.textContent = 'Kill switch is ON: the bot takes no new entries.'; }
    else alert.hidden = true;
    const upd = $('#updated'); upd.hidden = d.last_update_ms == null; upd.dataset.ts = d.last_update_ms ?? '';
    $('#footer').textContent = `data generated ${fmtTime(d.generated_at)} · checks for news every 60s · times in ${tz === 'utc' ? 'UTC' : 'your local time'} · ${mode} mode`;
    renderBadges(d);
    for (const t of TABS) dirty.add(t);
    applyTab();
  }
  const RENDER = {
    overview: () => { renderKpis(data); renderCheckbar(data); renderBots(data); renderChart(); renderOpen(data); },
    performance: () => renderPerf(),
    trades: () => renderTrades(),
    verify: () => { renderChecks(data); renderCompare(data); },
    log: () => { renderActivity(data); renderSkipped(data); },
    status: () => { renderStatus(data); renderUptime(data); loadVpsInline(); },
  };
  function drawTab() {
    if (!data || !dirty.has(tab)) return;
    dirty.delete(tab);
    for (const n of $$('.modeTag')) { const m = n.hasAttribute('data-botmode') ? view().mode : data.mode; n.textContent = String(m).toUpperCase(); n.className = `modeTag ${m}`; }
    renderBotSeg();
    RENDER[tab]();
    tick();
  }

  // ---------------- sections (tabs) ----------------
  let tab = (() => { const h = location.hash.slice(1), r = TABS.includes(h) ? h : 'overview'; store.set('bot.tab', r); return r; })();   // every visit opens on Overview; a link like #status opens that tab
  function applyTab() {
    $('#app').dataset.tab = tab;
    for (const e of $$('[data-tabs]')) e.hidden = !e.dataset.tabs.split(' ').includes(tab);
    for (const b of $$('#mainTabs button')) { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }
    drawTab();
  }
  function setTab(t) { if (!TABS.includes(t)) return; tab = t; store.set('bot.tab', t); try { history.replaceState(null, '', '#' + t); } catch {} applyTab(); }
  let vpsInlineDone = false;
  async function loadVpsInline() {   // the server specs, read once when the Status tab is first opened
    if (vpsInlineDone) return; const host = $('#vpsInline');
    try {
      const res = await fetch('/api/vps', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderVps(await res.json(), host); vpsInlineDone = true;
    } catch (e) { clear(host).append(el('div', { class: 'empty' }, `Could not load the specs: ${e.message}`)); }
  }
  const worst = (list) => list.reduce((w, l) => ({ stop: 2, warn: 1 }[l] > ({ stop: 2, warn: 1 }[w] || 0) ? l : w), 'ok');
  const verdicts = (d) => [d.perf && d.perf.bbcore, d.perf && d.perf.icore].filter(Boolean);
  function renderBadges(d) {
    const s = d.status, waiting = s.last_heartbeat_ms == null, n = d.overall.trades + d.open.length;
    $('#tbDot').className = `tb-dot ${waiting ? '' : s.alive ? 'ok' : 'bad'}`;
    const v = worst(verdicts(d).map((p) => p.verdict));
    $('#tbCheck').className = `tb-dot ${v === 'stop' ? 'bad' : v === 'warn' ? 'warnd' : 'ok'}`;
    $('#tbTrades').textContent = n ? String(n) : ''; $('#tbLog').textContent = (d.activity || []).length ? String((d.activity || []).length) : '';
  }
  function renderBotSeg() {
    const show = hasIcore();
    for (const host of $$('.botseg')) {
      host.hidden = !show; if (!show) continue;
      clear(host).append(...[['bbcore', 'BB-Core'], ['icore', 'I-Core']].map(([k, l]) => el('button', { type: 'button', 'data-bot': k, class: k === bot ? 'on' : '' }, l)));
    }
  }

  // ---------------- Overview ----------------
  // Total capital is remembered in this browser, so a report that carries no balance (or a refresh that fails) never blanks the overview: the last known figure stays, labelled with its age.
  const LAST_CAP = 'bot.lastCapital';
  const rememberCapital = (usd, text, asOf) => { if (Number.isFinite(usd)) store.set(LAST_CAP, JSON.stringify({ usd, text, as_of: asOf || Date.now() })); };
  const lastCapital = () => { try { const c = JSON.parse(store.get(LAST_CAP)); return c && Number.isFinite(c.usd) ? c : null; } catch { return null; } };
  function renderKpis(d) {
    const cap = d.capital, o = d.overall, s = d.status, tc = d.bots && d.bots.icore ? d.total_capital : null, wc = d.wallet_capital;
    if (wc) {   // the real balances from the bots' 5-minute wallet reports: Total capital is every trading account added together
      const txt = wc.parts.map((p) => `${p.label} ${fmtUsd(p.usd)}`).join(' + ');
      $('#kCapital').textContent = fmtUsd(wc.usd);
      const sub = $('#kCapitalSub'); clear(sub).append(txt, ' · MEXC reports ', ago(wc.as_of));
      if (wc.missing.length) sub.append(el('span', { class: 'bad' }, ` · ${wc.missing.join(', ')} has not reported, not counted`));
      if (Date.now() - wc.as_of > 30 * 60000) sub.append(el('span', { class: 'bad' }, ' · old: the VPS has not reported for a while'));
      if (!wc.missing.length) rememberCapital(wc.usd, txt, wc.as_of);
      spark($('#kSpark'), cap ? cap.points.map((p) => p.usd) : d.equity.map((p) => p.r_cum));
    } else if (tc) {   // both bots report: Total capital is BB-Core + I-Core added together, with each part shown (a paper balance is labelled as such)
      $('#kCapital').textContent = fmtUsd(tc.usd);
      const sub = $('#kCapitalSub'); clear(sub).append(tc.parts.map((p) => `${p.label} ${fmtUsd(p.usd)}${p.mode === 'live' ? '' : ' (paper)'}`).join(' + '));
      if (tc.missing.length) sub.append(el('span', { class: 'bad' }, ` · ${tc.missing.join(', ')} balance not shared, not counted`));
      else if (tc.paper.length) sub.append(` · includes paper balance (${tc.paper.join(', ')})`);
      if (!tc.missing.length && !tc.paper.length) rememberCapital(tc.usd, tc.parts.map((p) => `${p.label} ${fmtUsd(p.usd)}`).join(' + '), tc.as_of);
      spark($('#kSpark'), cap ? cap.points.map((p) => p.usd) : d.equity.map((p) => p.r_cum));
    } else if (cap) {
      $('#kCapital').textContent = fmtUsd(cap.usd);
      const sub = $('#kCapitalSub'); clear(sub).append(el('span', { class: cls(cap.change_usd) }, `${fmtUsd(cap.change_usd, true)} (${fmtPct(cap.change_pct, true)})`), ` since start ${fmtUsd(cap.start_usd)}`, cap.net_flows_usd ? ` · excl. ${fmtUsd(cap.net_flows_usd, true)} capital` : '');
      if (d.mode === 'live') rememberCapital(cap.usd, 'Balance', cap.as_of);
      spark($('#kSpark'), cap.points.map((p) => p.usd));
    } else if (lastCapital()) {   // nothing came with this report: keep the last known total instead of a blank
      const c = lastCapital();
      $('#kCapital').textContent = fmtUsd(c.usd);
      const sub = $('#kCapitalSub'); clear(sub).append(c.text ? c.text + ' · ' : '', 'last known, ', ago(c.as_of));
      spark($('#kSpark'), d.equity.map((p) => p.r_cum));
    } else {
      $('#kCapital').textContent = '—';
      $('#kCapitalSub').textContent = d.mode === 'live' ? 'Live balance is not shared with the dashboard.' : 'No balance received yet (arrives with each report).';
      spark($('#kSpark'), d.equity.map((p) => p.r_cum));
    }
    const net = $('#kNet'); net.textContent = fmtR(o.total_r); net.className = `mid ${cls(o.total_r)}`;
    $('#kNetSub').textContent = `BB-Core · ${o.trades} closed trade${o.trades === 1 ? '' : 's'}${cap && cap.realized_usd != null ? ` · ${fmtUsd(cap.realized_usd, true)} realized` : ''} · ${d.open.length} open`;
    $('#kWin').textContent = o.trades ? `${(o.win_rate * 100).toFixed(0)}% · ${o.profit_factor ?? '—'}` : '—';
    $('#kWinSub').textContent = o.trades ? `${o.wins}W / ${o.trades - o.wins}L · avg ${fmtR(o.avg_r)}` : 'No closed trades yet.';
    const dd = s.drawdown_r, halt = s.halt_r != null ? Math.abs(s.halt_r) : null, pct = dd != null && halt ? Math.min(100, (dd / halt) * 100) : 0;
    $('#kDd').textContent = dd == null ? '—' : `${Number(dd).toFixed(1)}R / ${halt ?? '—'}R`;
    $('#kDdBar').style.setProperty('width', `${pct}%`);
    $('#kDdBar').parentElement.classList.toggle('hot', pct >= 60);
    $('#kDdSub').textContent = dd == null ? 'No heartbeat yet.' : `${pct.toFixed(0)}% of the halt · max ${Number(o.max_dd_r ?? 0).toFixed(1)}R`;
  }
  // one line: is everything inside the rules? (the detail is on the Verify tab)
  function renderCheckbar(d) {
    const box = clear($('#pChecks')), list = verdicts(d);
    if (!list.length) { box.className = 'checkbar off'; return; }
    box.className = `checkbar ${worst(list.map((p) => p.verdict))}`;
    box.append(el('span', { class: 'cb-k' }, 'Checks'));
    for (const p of list) {
      const bad = p.checks.filter((c) => c.level === 'warn' || c.level === 'stop');
      box.append(el('span', { class: 'cb-item' }, lvlChip(p.verdict === 'ok' ? 'ok' : p.verdict), ` ${p.label}: `, bad.length ? bad.map((c) => `${c.title} (${LVL[c.level].toLowerCase()})`).join(', ') : 'all inside the rules'));
    }
    box.append(el('span', { class: 'cb-go' }, 'Verify →'));
  }
  function renderBots(d) {
    const p = $('#pBots'), b = d.bots;
    p.classList.toggle('off', !b);
    if (!b) return;
    const rows = [b.bbcore, b.icore].filter(Boolean).map((v) => ({ ...v, hb: v.last_heartbeat_ms ?? (v === b.bbcore ? d.status.last_heartbeat_ms : null) }));
    clear($('#bots')).append(table([
      { h: 'Bot', left: true, f: (r) => el('strong', {}, r.label) }, { h: 'Mode', left: true, f: (r) => el('span', { class: `modeTag ${r.mode}` }, String(r.mode).toUpperCase()) },
      { h: 'State', left: true, f: (r) => el('span', { class: r.alive ? 'good' : 'bad' }, r.alive ? 'ONLINE' : 'STALE') }, { h: 'Capital', f: (r) => (r.capital ? fmtUsd(r.capital.usd) : '—') },
      { h: 'Closed', f: (r) => r.overall.trades }, { h: 'Total R', f: (r) => fmtR(r.overall.total_r), c: (r) => cls(r.overall.total_r) }, { h: 'Win', f: (r) => pct0(r.overall.win_rate) },
      { h: 'Open', f: (r) => r.open }, { h: 'Last report', f: (r) => (r.hb ? ago(r.hb) : '—') },
    ], rows, ''));
  }
  function renderOpen(d) {
    const ic = d.bots && d.bots.icore ? (d.bots.icore.open_list || []).map((p) => ({ ...p, bot: 'I-Core' })) : null;
    const rows = d.open.map((p) => ({ ...p, bot: 'BB-Core' })).concat(ic || []);
    $('#openCount').textContent = rows.length ? `${rows.length} open` : '';
    clear($('#open')).append(table([
      ...(ic ? [{ h: 'Bot', left: true, f: (r) => r.bot }] : []),
      { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) },
      { h: 'Now', f: (r) => fmtPx(r.price) }, { h: 'R now', f: (r) => (r.current_r == null ? '—' : fmtR(r.current_r)), c: (r) => cls(r.current_r) }, { h: 'Held', f: (r) => fmtDur((Date.now() - r.entry_ts) / 1000) },
    ], rows, 'No open positions. Flat and waiting for a signal.'));
  }
  // The chart for the chosen range: points before it are dropped and the line starts at the range start with the value it had then; flat until now when nothing changed since.
  // dd is the drawdown chart, which carries no value forward (it is zero at a new peak).
  function inRange(pts, now = Date.now()) {
    if (!chartDays || !pts.length) return pts;
    const start = now - chartDays * 864e5, before = pts.filter((p) => p.ts < start).pop(), out = pts.filter((p) => p.ts >= start);
    if (before) out.unshift({ ts: start, y: before.y });
    const last = out[out.length - 1];
    if (last && last.ts < now - 36e5) out.push({ ts: now, y: last.y });
    return out;
  }
  function renderChart() {
    if (!data) return;
    for (const b of $$('#rangeTabs button')) { const on = +b.dataset.range === chartDays; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    for (const b of $$('#chartTabs button')) { const on = b.dataset.chart === chartKind; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    const d = data, note = $('#chartNote');
    const wh = !d.capital && d.wallet_history && d.wallet_history.length ? d.wallet_history : null;   // live: the wallet reports (both accounts added) stand in for the bot's balance
    if (chartKind === 'capital' && wh) {
      lineChart($('#chart'), inRange(wh.map((p) => ({ ts: p.ts, y: p.usd }))), { marks: d.capital_flows || [], fmtY: (v) => `$${v.toFixed(v >= 1000 ? 0 : 2)}` });
      note.textContent = `Both trading accounts added together, from the bots' 5-minute wallet reports · ${fmtUsd(wh[wh.length - 1].usd)} at ${fmtTime(wh[wh.length - 1].ts)}. Deposits show as labelled steps, not as profit.`;
    } else if (chartKind === 'capital') {
      const pts = inRange(d.capital ? d.capital.points.map((p) => ({ ts: p.ts, y: p.usd })) : []);
      lineChart($('#chart'), pts, { marks: d.capital ? d.capital.flows : [], fmtY: (v) => `$${v.toFixed(v >= 1000 ? 0 : 2)}`, empty: d.mode === 'live' ? 'Live balance is not shared with the dashboard. Switch to the R tab.' : 'No balance received yet.' });
      note.textContent = d.capital ? `BB-Core balance ${fmtUsd(d.capital.usd)} as of ${fmtTime(d.capital.as_of)} · ${fmtUsd(d.capital.change_usd, true)} (${fmtPct(d.capital.change_pct, true)}) since ${fmtUsd(d.capital.start_usd)}${d.capital.net_flows_usd ? ` · capital added or paid out (${fmtUsd(d.capital.net_flows_usd, true)}) is not counted as profit` : ''}` : '';
    } else if (chartKind === 'perf') {
      const pts = inRange(d.capital ? d.capital.perf_points.map((p) => ({ ts: p.ts, y: p.usd })) : []);
      lineChart($('#chart'), pts, { fmtY: (v) => `$${v.toFixed(v >= 1000 ? 0 : 2)}`, empty: d.mode === 'live' ? 'Live balance is not shared with the dashboard. Switch to the R tab.' : 'No balance received yet.' });
      note.textContent = d.capital ? `Balance with deposits and payouts taken out: only trading moves this line · ${fmtUsd(d.capital.change_usd, true)} (${fmtPct(d.capital.change_pct, true)}) since start${d.capital.twr_pct != null ? ` · time-weighted return ${fmtPct(d.capital.twr_pct, true)}` : ''}` : '';
    } else if (chartKind === 'r') {
      lineChart($('#chart'), inRange(d.equity.map((p) => ({ ts: p.ts, y: p.r_cum }))), { fmtY: (v) => `${v.toFixed(1)}R` });
      note.textContent = d.equity.length ? `BB-Core cumulative R over ${d.overall.trades} closed trades: ${fmtR(d.overall.total_r)}` : '';
    } else {
      lineChart($('#chart'), inRange(d.equity.map((p) => ({ ts: p.ts, y: p.dd_r }))), { dd: true, fmtY: (v) => `${v.toFixed(1)}R` });
      note.textContent = d.equity.length ? `Max drawdown ${Number(d.overall.max_dd_r).toFixed(1)}R · now ${Number(d.equity[d.equity.length - 1].dd_r).toFixed(1)}R · halt at ${d.status.halt_r != null ? Math.abs(d.status.halt_r) : '—'}R` : '';
    }
  }

  // ---------------- Performance ----------------
  function renderPerf() {
    const v = view(), p = v.perf;
    if (!p) { clear($('#perfTiles')).append(el('div', { class: 'empty' }, 'No data yet.')); return; }
    const o = p.overall, e = p.expect, rule = (id) => p.checks.find((c) => c.id === id);
    const vsExp = (live, exp, fmt) => (exp == null ? null : `expected ${fmt(exp)}${o.trades && o.trades < 150 ? ' · small sample' : ''}`);
    const tiles = [
      tile('Closed trades', String(o.trades), p.first_ts ? [`since ${fmtDay(p.first_ts)}`, p.trades_per_month != null ? ` · ${p.trades_per_month}/month${e.trades_per_month ? ` (expected ~${e.trades_per_month})` : ''}` : ''] : 'none yet'),
      tile('Total result', fmtR(o.total_r), o.usd != null ? fmtUsd(o.usd, true) : `${o.wins}W / ${o.losses}L`, cls(o.total_r)),
      tile('Average R', fmtR(o.avg_r), vsExp(o.avg_r, e.avg_r, fmtR), cls(o.avg_r)),
      tile('Win rate', pct0(o.win_rate), vsExp(o.win_rate, e.win_rate, pct0)),
      tile('Profit factor', o.profit_factor == null ? '—' : String(o.profit_factor), `best ${fmtR(o.best_r)} · worst ${fmtR(o.worst_r)}`),
      ...(e.target_rate != null ? [tile('Target-hit rate', pct0(o.target_rate), vsExp(o.target_rate, e.target_rate, pct0))] : []),
      tile('Drawdown', `${Number(o.dd_now_r || 0).toFixed(1)}R`, `worst ${Number(o.max_dd_r || 0).toFixed(1)}R · stop line ${rule('drawdown') ? rule('drawdown').limit : '—'}`, { stop: 'bad', warn: 'warn' }[(rule('drawdown') || {}).level] || ''),
      tile('Losing streak', String(o.current_losing), `longest ${o.longest_losing} · backtest ${e.longest_losing}`, o.current_losing >= (e.longest_losing || 99) ? 'warn' : ''),
      tile('Average hold', fmtDur(o.avg_hold_sec), 'entry to exit'),
    ];
    clear($('#perfTiles')).append(...tiles);
    $('#perfNote').textContent = `${v.label} live results against ${e.source}. Single trades swing from −1R to several R, so about 150 or more trades are needed before the average says anything; until then this page shows whether live behaves like the backtest.`;
    renderPeriods(p);
    renderBreakdown(p);
    renderExec(p);
    const rl = p.rolling;
    if (rl) {
      lineChart($('#rolling'), rl.points, { fmtY: (x) => `${x.toFixed(0)}R`, hline: rl.stop_r });
      $('#rollingNote').textContent = `Sum of the last ${rl.n} trades after each trade. The dashed line is the stop-and-review line (${rl.stop_r}R).`;
    } else {
      clear($('#rolling')).append(el('div', { class: 'empty' }, p.bot === 'icore' ? 'I-Core is a trend follower with few, large winners: a rolling window says little, so it is judged on drawdown and streaks.' : `Shown from trade ${50} on (now ${o.trades}).`));
      $('#rollingNote').textContent = '';
    }
  }
  function renderPeriods(p) {
    for (const b of $$('#periodTabs button')) { const on = b.dataset.period === period; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    const rows = p.periods[period] || [], hasUsd = rows.some((r) => r.usd != null);
    barChart($('#periodChart'), rows.slice(period === 'day' ? -60 : period === 'month' ? -24 : -12), 'No closed trades yet.');
    const list = rows.slice().reverse();
    const tot = rows.reduce((a, r) => ({ trades: a.trades + r.trades, wins: a.wins + r.wins, r: a.r + r.r, usd: r.usd != null ? (a.usd || 0) + r.usd : a.usd }), { trades: 0, wins: 0, r: 0, usd: null });
    if (rows.length > 1) list.push({ key: 'Total', ...tot, best: null, worst: null, _cls: 'total' });
    clear($('#periods')).append(table([
      { h: period[0].toUpperCase() + period.slice(1), left: true, f: (r) => (r.key === 'Total' ? el('strong', {}, 'Total') : periodLabel(r.key)) }, { h: 'Trades', f: (r) => r.trades },
      { h: 'Win', f: (r) => pct0(r.trades ? r.wins / r.trades : null) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => fmtUsd(r.usd, true), c: (r) => cls(r.usd) }] : []), { h: 'Best', f: (r) => fmtR(r.best) }, { h: 'Worst', f: (r) => fmtR(r.worst) },
    ], list, 'No closed trades yet.'));
  }
  function renderBreakdown(p) {
    const box = clear($('#breakdown')), n = p.overall.trades;
    const coins = Object.entries(p.per_coin).map(([k, v]) => ({ coin: k, ...v }));
    box.append(el('div', { class: 'scroll' }, table([
      { h: 'Coin', left: true, f: (r) => sym(r.coin) }, { h: 'Trades', f: (r) => r.trades }, { h: 'Win', f: (r) => pct0(r.win_rate) },
      { h: 'Avg R', f: (r) => fmtR(r.avg_r), c: (r) => cls(r.avg_r) }, { h: 'Total', f: (r) => fmtR(r.total_r), c: (r) => cls(r.total_r) }, { h: 'Max DD', f: (r) => `${r.max_dd_r}R` },
    ], coins, 'No closed trades yet.')));
    if (!n) return;
    const sides = Object.entries(p.by_side).filter(([, v]) => v.trades).map(([k, v]) => ({ k, ...v }));
    box.append(el('div', { class: 'sub-h' }, 'Long vs short'), el('div', { class: 'scroll' }, table([
      { h: 'Side', left: true, f: (r) => sideEl(r.k) }, { h: 'Trades', f: (r) => r.trades }, { h: 'Win', f: (r) => pct0(r.win_rate) }, { h: 'Total', f: (r) => fmtR(r.total_r), c: (r) => cls(r.total_r) },
    ], sides, '')));
    const ex = Object.entries(p.by_reason).map(([k, v]) => ({ k, ...v })).sort((a, b) => b.trades - a.trades);
    box.append(el('div', { class: 'sub-h' }, 'How trades ended'), el('div', { class: 'scroll' }, table([
      { h: 'Exit', left: true, f: (r) => el('span', { class: `chip ${r.k}` }, r.k) }, { h: 'Trades', f: (r) => r.trades }, { h: 'Share', f: (r) => pct0(r.trades / n) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
    ], ex, '')));
  }
  function renderExec(p) {
    const x = p.execution, rows = Object.entries(x.per_coin).map(([k, v]) => ({ coin: k, ...v }));
    if (rows.length > 1) rows.push({ coin: 'ALL', ...x, _cls: 'total' });
    const sp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(3)}%`);
    clear($('#exec')).append(table([
      { h: 'Coin', left: true, f: (r) => (r.coin === 'ALL' ? el('strong', {}, 'ALL') : sym(r.coin)) }, { h: 'Entries', f: (r) => r.measured },
      { h: 'Avg slippage', f: (r) => sp(r.avg_slip_pct), c: (r) => (r.avg_slip_pct > 0.02 ? 'warn' : '') }, { h: 'Worst', f: (r) => sp(r.worst_slip_pct) },
      { h: 'In R', f: (r) => (r.avg_slip_r == null ? '—' : fmtR(r.avg_slip_r)) }, { h: 'Delay', f: (r) => (r.avg_delay_sec == null ? '—' : fmtDur(r.avg_delay_sec)) }, { h: 'Fees', f: (r) => (r.avg_fees_r == null ? '—' : fmtR(-Math.abs(r.avg_fees_r))) },
    ], rows, 'No closed trades yet.'));
    $('#execNote').textContent = `Slippage is the fill price against the price the decision used (+ = worse). The backtest assumes about 0.02% a side. Delay is the time from the candle close to the fill.${view().mode === 'live' ? '' : ' Paper fills are simulated, so these numbers only mean something in LIVE mode.'}`;
  }

  // ---------------- Trades ----------------
  function renderTrades() {
    if (!data) return;
    const all = view().trades, f = filters;
    const coinSel = $('#fCoin'), coins = [...new Set(all.map((t) => t.symbol))].sort();
    if ([...coinSel.options].slice(1).map((o) => o.value).join() !== coins.join()) { clear(coinSel).append(el('option', { value: '' }, 'All'), ...coins.map((c) => el('option', { value: c }, sym(c)))); coinSel.value = coins.includes(f.coin) ? f.coin : (f.coin = ''); }
    const rs = $('#fReason'), reasons = [...new Set(all.map((t) => t.reason).filter(Boolean))].sort();
    if ([...rs.options].slice(1).map((o) => o.value).join() !== reasons.join()) { clear(rs).append(el('option', { value: '' }, 'All'), ...reasons.map((r) => el('option', { value: r }, r))); rs.value = reasons.includes(f.reason) ? f.reason : (f.reason = ''); }
    const from = f.from ? Date.parse(f.from + 'T00:00:00Z') : null, to = f.to ? Date.parse(f.to + 'T23:59:59Z') : null;
    const rows = all.filter((t) => (!f.coin || t.symbol === f.coin) && (!f.side || t.side === f.side) && (!f.reason || t.reason === f.reason) && (from == null || t.exit_ts >= from) && (to == null || t.exit_ts <= to)).sort((a, b) => b.exit_ts - a.exit_ts);
    const total = rows.reduce((a, t) => a + t.r, 0), hasUsd = rows.some((t) => t.usd != null), usd = rows.reduce((a, t) => a + (t.usd || 0), 0), wins = rows.filter((t) => t.r > 0).length;
    clear($('#tradeSummary')).append(`${rows.length} trade${rows.length === 1 ? '' : 's'} · ${rows.length ? Math.round((wins / rows.length) * 100) : 0}% won · total `, el('span', { class: cls(total) }, fmtR(total)), hasUsd ? el('span', { class: cls(usd) }, ` (${fmtUsd(usd, true)})`) : '');
    clear($('#trades')).append(table([
      { h: 'Exit time', left: true, f: (r) => fmtShort(r.exit_ts) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) }, { h: 'TP', f: (r) => fmtPx(r.tp) },
      { h: 'Exit', f: (r) => fmtPx(r.exit) }, { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => fmtUsd(r.usd, true), c: (r) => cls(r.usd) }] : []), { h: 'Held', f: (r) => fmtDur(r.hold_sec) },
    ], rows, all.length ? 'No trades match.' : 'No closed trades yet.'));
  }

  // ---------------- Verify ----------------
  function renderChecks(d) {
    const box = clear($('#checks')), list = verdicts(d);
    if (!list.length) { box.append(el('div', { class: 'empty' }, 'No data yet.')); return; }
    for (const p of list) {
      box.append(el('div', { class: 'sub-h first' }, `${p.label} · ${p.overall.trades} closed trades · `, lvlChip(p.verdict)));
      box.append(el('div', { class: 'checklist' }, p.checks.map((c) => el('div', { class: `ck ${c.level}` }, lvlChip(c.level),
        el('div', { class: 'ck-b' }, el('div', { class: 'ck-t' }, c.title, el('span', { class: 'ck-v' }, c.value ?? '—')), el('div', { class: 'ck-n' }, `limit ${c.limit}${c.note ? ' · ' + c.note : ''}`))))));
    }
  }
  function renderCompare(d) {
    const c = clear($('#compare'));
    if (!d.compare) { c.append(el('div', { class: 'empty' }, 'No comparison received yet (compare-live-vs-backtest.js --push).')); return; }
    const k = d.compare;
    c.append(el('dl', { class: 'kvlist' },
      kv('Result', el('span', { class: k.match ? 'good' : 'bad' }, k.match ? 'MATCH' : 'NOT A MATCH')),
      kv('Window', `${fmtShort(k.window_from_ms)} → ${fmtShort(k.window_to_ms)}`),
      kv('Checked', fmtTime(k.ts), ago(k.ts)),
      kv('Trades', `${k.matched ?? 0} matched · ${k.live_only ?? 0} live-only · ${k.backtest_only ?? 0} backtest-only`),
      kv('Other', `${k.skipped_signals ?? 0} skipped · ${k.candle_diffs ?? 0} candle diffs · tol ${k.tolerance_r}R`)));
    if ((k.mismatches || []).length) c.append(el('div', { class: 'sub-h' }, 'Mismatches'), el('div', { class: 'scroll' }, table([
      { h: 'Kind', left: true, f: (r) => r.kind }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Candle', f: (r) => fmtShort(r.signal_candle_open_ms) },
      { h: 'Near thr.', f: (r) => (r.nearest_threshold_pct == null ? '—' : `${Number(r.nearest_threshold_pct).toFixed(3)}%`) }, { h: 'Why', left: true, f: (r) => r.why, c: () => 'wrap' },
    ], k.mismatches, '')));
  }

  // ---------------- Log ----------------
  const logLine = (ts, tag, ...msg) => el('div', { class: 'ln' }, el('span', { class: 't' }, fmtShort(ts)), el('span', { class: `tag ${tag}` }, tag.toUpperCase()), el('span', { class: 'msg' }, ...msg));
  function renderActivity(d) {
    const box = clear($('#activity')), s = d.status, out = [];
    if (s.last_heartbeat_ms != null) out.push(logLine(s.last_heartbeat_ms, s.alive ? 'check' : 'down', s.alive ? 'heartbeat ok' : 'last heartbeat received', s.next_wake_ms ? ` · next wake ${fmtHm(s.next_wake_ms)}` : ''));
    for (const a of d.activity || []) {
      const coin = a.symbol ? `${sym(a.symbol)} ` : '';
      if (a.kind === 'entry') out.push(logLine(a.ts, 'entry', coin, sideEl(a.side), ` filled @ ${fmtPx(a.entry)} · SL ${fmtPx(a.sl)} · TP ${fmtPx(a.tp)}${a.risk_usd != null ? ` · risk ${fmtUsd(a.risk_usd)}` : ''}`));
      else if (a.kind === 'exit') out.push(logLine(a.ts, 'exit', coin, sideEl(a.side), ` ${a.reason} @ ${fmtPx(a.exit)} → `, el('span', { class: cls(a.r) }, `${fmtR(a.r)}${a.usd != null ? ` (${fmtUsd(a.usd, true)})` : ''}`)));
      else if (a.kind === 'skip') out.push(logLine(a.ts, 'skip', coin, sideEl(a.side), ` skipped: ${a.reason}${a.detail ? ` · ${a.detail}` : ''}`));
      else if (a.kind === 'check') out.push(logLine(a.ts, 'check', `check ${a.candle_ms ? fmtShort(a.candle_ms) : ''} processed · total ${fmtR(a.total_r)}${a.balance != null ? ` · bal ${fmtUsd(a.balance)}` : ''}`));
      else if (a.kind === 'capital') out.push(logLine(a.ts, 'capital', a.flow === 'payout' ? 'payout sent ' : 'capital added ', el('span', {}, fmtUsd(a.usd, true)), ' · not profit or loss'));
      else if (a.kind === 'compare') out.push(logLine(a.ts, 'compare', 'live vs backtest ', el('span', { class: a.match ? 'good' : 'bad' }, a.match ? 'MATCH' : 'MISMATCH'), ` · ${a.matched ?? 0} matched${a.mismatches ? ` · ${a.mismatches} differ` : ''}`));
    }
    $('#actCount').textContent = `${(d.activity || []).length} events`;
    if (!out.length) box.append(el('div', { class: 'empty' }, 'Nothing logged yet.'));
    else box.append(...out);
  }
  function renderSkipped(d) {
    clear($('#skipped')).append(table([
      { h: 'Signal candle', left: true, f: (r) => fmtShort(r.signal_candle_open_ms) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) },
      { h: 'Reason', left: true, f: (r) => el('span', { class: 'chip' }, r.reason) }, { h: 'Detail', left: true, f: (r) => r.detail || '', c: () => 'wrap' },
    ], d.skipped, 'No skipped signals.'));
  }

  // ---------------- Status: one summary + one list (no repeated tiles) ----------------
  function renderStatus(d) {
    const s = d.status, o = d.overall, waiting = s.last_heartbeat_ms == null, mode = d.mode.toUpperCase(), span = (c, t) => el('span', { class: c }, t);
    $('#hbDot').className = `live-dot ${waiting ? '' : s.alive ? 'ok' : 'bad'}`;
    const coinsOpen = d.open.map((p) => `${sym(p.symbol)} ${p.side}`).join(', ');
    const text = clear($('#nowText'));
    if (waiting) add(text, 'The dashboard has not heard from the bot yet. The bot reports on a regular schedule; press Ask bot now to get a report right away.');
    else if (!s.alive) add(text, span('bad', 'The bot is not reporting. '), `Its last heartbeat was ${fmtDur(s.age_ms / 1000)} ago (the limit is ${fmtDur(s.stale_after_ms / 1000)}). Check the VPS.`);
    else add(text, 'BB-Core is ', el('b', { class: 'good' }, 'online'), ` in ${mode} mode. It last reported `, ago(s.last_heartbeat_ms),
      s.next_wake_ms ? [' and will look at the market again at ', el('b', {}, fmtShort(s.next_wake_ms) + tzTag()), ' (', until(s.next_wake_ms), ').'] : '.',
      d.open.length ? [' ', el('b', {}, `${d.open.length} position${d.open.length === 1 ? ' is' : 's are'} open`), ` (${coinsOpen}).`] : ' It is flat: no position open.',
      o.trades ? ` ${o.trades} closed trade${o.trades === 1 ? '' : 's'}, ${fmtR(o.total_r)} in total.` : ' No trade has been taken yet.',
      s.kill_switch ? span('warn', ' The kill switch is ON: no new entries.') : '');
    const sys = clear($('#sys')), u = d.uptime, ic = d.bots && d.bots.icore;
    if (!waiting) {
      const candles = Object.entries(s.last_candle_ms || {});
      sys.append(
        kv('Last heartbeat', fmtHm(s.last_heartbeat_ms) + tzTag(), ago(s.last_heartbeat_ms)),
        kv('Next check', s.next_wake_ms ? fmtHm(s.next_wake_ms) + tzTag() : '—', s.next_wake_ms ? until(s.next_wake_ms) : null),
        kv('Last candle checked', candles.length ? `closed ${fmtHm(Math.max(...candles.map(([, v]) => closeOf(v))))}` : '—', candles.length ? ago(Math.max(...candles.map(([, v]) => closeOf(v)))) : null),
        kv('Uptime (7d)', u ? el('span', { class: u.uptime_pct >= 99 ? 'good' : u.uptime_pct >= 95 ? 'warn' : 'bad' }, `${u.uptime_pct.toFixed(2)}%`) : '—', u ? el('small', {}, `process up ${fmtDur(s.uptime_sec)}`) : null),
        kv('Kill switch', el('span', { class: s.kill_switch ? 'bad' : 'good' }, s.kill_switch ? 'ON · no new entries' : 'off')),
        kv('Coins', (s.enabled_coins || []).map(sym).join(' · ') || '—'),
        kv('Build', `${s.commit || '?'} · v${s.version || '?'}`));
    }
    if (ic) sys.append(kv('I-Core', el('span', { class: ic.alive ? 'good' : 'bad' }, `${ic.alive ? 'ONLINE' : 'STALE'} · ${String(ic.mode).toUpperCase()}`), ic.last_heartbeat_ms ? ago(ic.last_heartbeat_ms) : el('small', {}, 'no heartbeat yet')));
    $('#nowNote').textContent = 'The bot reports at every 4-hour candle close, so these numbers can be hours old. Ask bot now gets a fresh report: the bot checks for a request about once a minute and answers straight away (never in the middle of a run).';
  }
  function renderUptime(d) {
    const u = d.uptime, bar = clear($('#upBar')), axis = clear($('#upAxis')), now = d.generated_at;
    bar.classList.toggle('none', !u);
    if (u) {
      const span = Math.max(1, now - u.since_ms);
      for (const g of u.downtimes) {
        const i = el('i', { title: `${fmtTime(g.from)} → ${g.to ? fmtTime(g.to) : 'now'} (${fmtDur(g.dur_ms / 1000)})` });
        i.style.setProperty('left', `${Math.max(0, ((g.from - u.since_ms) / span) * 100)}%`);
        i.style.setProperty('width', `${Math.max(0.3, (g.dur_ms / span) * 100)}%`);
        bar.append(i);
      }
      axis.append(el('span', {}, fmtShort(u.since_ms)), el('span', {}, `${u.uptime_pct.toFixed(2)}% up`), el('span', {}, 'now'));
    }
    const lines = [];
    if (u) {
      for (const g of u.downtimes) lines.push({ ts: g.from, tag: 'down', text: g.ongoing ? `no heartbeat since ${fmtShort(g.from)} · ongoing ${fmtDur(g.dur_ms / 1000)}` : `${fmtShort(g.from)} → ${fmtHm(g.to)} · ${fmtDur(g.dur_ms / 1000)} without heartbeat` });
      const byDay = new Map();
      for (const r of u.restarts) { const k = fmtDay(r.ts); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r.ts); }
      for (const ts of byDay.values()) lines.push(ts.length === 1 ? { ts: ts[0], tag: 'restart', text: 'process restarted' }
        : { ts: Math.max(...ts), tag: 'restart', text: `${ts.length} restarts that day · ${fmtHm(Math.min(...ts))} → ${fmtHm(Math.max(...ts))}` });
    }
    lines.sort((a, b) => b.ts - a.ts);
    const box = clear($('#downs'));
    if (!lines.length) box.append(el('div', { class: 'empty' }, u ? 'No downtime or restarts in the last 7 days.' : 'No heartbeat history yet.'));
    else box.append(...lines.map((l) => logLine(l.ts, l.tag, l.text)));
  }

  // every second: the clock and every "x ago" / "in x" in the open tab stays current without refetching (paused while the page is hidden)
  function tick() {
    if (document.hidden) return;
    const now = Date.now(), p = parts(now);
    $('#clock').textContent = `${fmtDay(now)} ${clock12(p, true)}${tz === 'utc' ? ' UTC' : ''}`;
    const upd = $('#updated'); if (upd.dataset.ts) upd.textContent = `Updated ${fmtShort(Number(upd.dataset.ts))}${tzTag()} · ${fmtDur((now - Number(upd.dataset.ts)) / 1000)} ago`;
    for (const n of document.querySelectorAll('#app [data-ago]')) n.textContent = `${fmtDur((now - Number(n.dataset.ago)) / 1000)} ago`;
    for (const n of document.querySelectorAll('#app [data-until]')) { const t = Number(n.dataset.until); n.textContent = t > now ? `in ${fmtDur((t - now) / 1000)}` : 'due now'; }
  }

  // ---------------- settings menu, tabs, switches ----------------
  const menu = $('#menu'), menuBtn = $('#menuBtn');
  function setMenu(open) { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', open); }
  function syncMenu() {
    for (const b of $$('[data-tz]')) b.classList.toggle('on', b.dataset.tz === tz);
    const theme = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    for (const b of $$('[data-theme-set]')) b.classList.toggle('on', b.dataset.themeSet === theme);
  }
  const typing = () => /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || $('#app').hidden;
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); syncMenu(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); }
    if (e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    if (e.key === 'r' || e.key === 'R') load(true);
    if (/^[1-6]$/.test(e.key)) setTab(TABS[+e.key - 1]);
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tz) { tz = b.dataset.tz; store.set('bot.tz', tz); if (data) render(data); }
    if (b.dataset.themeSet) { document.documentElement.setAttribute('data-theme', b.dataset.themeSet); store.set('bot.theme', b.dataset.themeSet); }
    if (b.dataset.mode) { modeSel = b.dataset.mode; store.set('bot.mode', modeSel); load(true); }
    syncMenu();
  });
  $('#mainTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('#mainTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const n = (TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length; setTab(TABS[n]); $(`#mainTabs [data-tab="${TABS[n]}"]`).focus(); e.preventDefault();
  });
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.includes(h) && h !== tab) setTab(h); });
  $('#rangeTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartDays = +b.dataset.range; store.set('bot.range', String(chartDays)); renderChart(); });
  $('#chartTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartKind = b.dataset.chart; store.set('bot.chart', chartKind); renderChart(); });
  $('#periodTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-period]'); if (!b || !data) return; period = b.dataset.period; store.set('bot.period', period); renderPeriods(view().perf); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.botseg button[data-bot]'); if (!b || !data) return;
    bot = b.dataset.bot; store.set('bot.view', bot); dirty.add('performance'); dirty.add('trades'); drawTab();
  });
  $('#pChecks').addEventListener('click', () => setTab('verify'));
  for (const [id, k] of [['fCoin', 'coin'], ['fSide', 'side'], ['fReason', 'reason'], ['fFrom', 'from'], ['fTo', 'to']]) $(`#${id}`).addEventListener('change', (e) => { filters[k] = e.target.value; renderTrades(); });

  // ---------------- VPS specs (Status tab) ----------------
  const ICON = {
    cpu: 'M9 9h6v6H9z M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 2v2 M15 2v2 M9 20v2 M15 20v2 M2 9h2 M2 15h2 M20 9h2 M20 15h2',
    ram: 'M2 7h20v9H2z M6 16v3 M10 16v3 M14 16v3 M18 16v3 M6 10h2v3H6z M11 10h2v3h-2z M16 10h2v3h-2z',
    disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
    os: 'M3 5h18v14H3z M7 10l3 2-3 2 M12 15h5',
    pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  };
  const icon = (d) => { const s = sv('svg', { viewBox: '0 0 24 24', class: 'ico', 'aria-hidden': 'true' }); s.append(sv('path', { d })); return s; };
  function ring(pct, label) {
    const r = 34, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
    const s = sv('svg', { viewBox: '0 0 84 84', class: 'ring', role: 'img', 'aria-label': `${label}: ${p}% used` });
    s.append(sv('circle', { class: 'rtrack', cx: 42, cy: 42, r }), sv('circle', { class: 'rfill', cx: 42, cy: 42, r, 'stroke-dasharray': `${(c * p / 100).toFixed(1)} ${c.toFixed(1)}`, transform: 'rotate(-90 42 42)' }));
    const t = sv('text', { x: 42, y: 47, 'text-anchor': 'middle' }); t.textContent = `${Math.round(p)}%`; s.append(t);
    return s;
  }
  const spec = (ico, title, big, sub) => el('div', { class: 'spec' },
    el('div', { class: 'spec-top' }, el('span', { class: 'spec-ico' }, icon(ico)), el('span', { class: 'k' }, title)),
    el('div', { class: 'spec-big' }, big), el('div', { class: 'spec-sub' }, sub));
  const usage = (pct, label, big, sub) => el('div', { class: 'spec withring' }, el('div', {},
    el('div', { class: 'spec-top' }, el('span', { class: 'spec-ico' }, icon(label === 'Memory' ? ICON.ram : ICON.disk)), el('span', { class: 'k' }, label)),
    el('div', { class: 'spec-big' }, big), el('div', { class: 'spec-sub' }, sub)), ring(pct, label));
  function renderVps(v, host) {
    const ramPct = (v.ram.used_gb / v.ram.total_gb) * 100, up = v.booted ? Date.parse(v.booted) : null;
    clear(host).append(
      el('div', { class: 'specgrid' },
        spec(ICON.cpu, 'Processor', `${v.cpu.vcpu} vCPU`, `${v.cpu.model} @ ${v.cpu.clock}`),
        usage(ramPct, 'Memory', `${v.ram.total_gb} GB`, `${v.ram.used_gb} GB in use at setup`),
        usage(v.disk.used_pct, 'Storage', `${v.disk.total_gb} GB`, `${v.disk.used_gb} GB used on ${v.disk.mount}`),
        spec(ICON.os, 'Operating system', v.os, `Kernel ${v.kernel} · ${v.arch}`),
        spec(ICON.pin, 'Location', v.location, `Hosted by ${v.provider}`),
        spec(ICON.clock, 'Last boot', up ? fmtTime(up) : '—', up ? `up ${fmtDur((Date.now() - up) / 1000)} (since that boot)` : ''),
        spec(ICON.shield, 'Bot memory limit', v.bot_limits.hard, `soft limit ${v.bot_limits.soft}, hard limit ${v.bot_limits.hard} (systemd)`)),
      el('p', { class: 'muted note' }, `${v.provider} VPS · snapshot taken ${v.as_of}. Usage figures are from that day; the plan itself does not change unless you resize it.`));
  }

  // ---------------- data + login ----------------
  // force = a person asked (R, Refresh, mode switch): ask without the fingerprint so the page is always redrawn
  async function load(force) {
    $('#promptCmd').textContent = 'status --refresh';
    let kept = false;
    try {
      const headers = !force && etag && data ? { 'If-None-Match': etag } : {};
      const res = await fetch('/api/data' + (modeSel ? `?mode=${encodeURIComponent(modeSel)}` : ''), { credentials: 'same-origin', cache: 'no-store', headers });
      if (res.status === 401) return showLogin('');
      if (res.status === 503) return showLogin('The dashboard login is not configured on the server (set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET in Vercel).');
      if (res.status === 304) return;                                       // nothing new: keep what is on screen
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false; $('#logoutBtn').hidden = false;
      etag = res.headers.get('ETag');
      render(await res.json());
    } catch (e) {
      console.error('bot dashboard: refresh failed', e);
      if (data) { kept = true; $('#promptCmd').textContent = 'status --retrying (showing the last data)'; }   // a failed refresh never wipes the page: the last data stays until the next one arrives
      else showLogin(`Could not load data: ${e.message}`);
    }
    finally { if (!kept) $('#promptCmd').textContent = 'status --watch'; }
  }
  function showLogin(msg) { data = null; etag = null; $('#boot').hidden = true; $('#app').hidden = true; $('#login').hidden = false; $('#logoutBtn').hidden = true; $('#statusPill').hidden = true; $('#loginMsg').textContent = msg; }

  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('#loginMsg').textContent = '';
    try {
      const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
      $('#pw').value = '';
      if (res.ok) return load(true);
      $('#loginMsg').textContent = res.status === 429 ? 'Too many attempts. Wait a few minutes.' : res.status === 503 ? 'Login is not configured on the server.' : 'Wrong password.';
    } catch { $('#loginMsg').textContent = 'Network error.'; }
  });
  $('#logoutBtn').addEventListener('click', async () => { setMenu(false); try { await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }); } catch {} showLogin(''); });
  $('#refreshBtn').addEventListener('click', () => { setMenu(false); load(true); });

  // "Ask bot now": leaves a request; the bot (which asks outbound about once a minute) answers with a heartbeat; we re-read every 5 s until it arrives (or give up after 3 minutes)
  let askWatch = null;
  async function askBot() {
    const btn = $('#askBtn'), msg = $('#askMsg'); btn.disabled = true; msg.textContent = 'Asking…';
    try {
      const res = await fetch('/api/ask', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: data && data.mode }) });
      if (res.status === 401) return showLogin('');
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 429 ? 'too many clicks, wait a minute' : j.error || `HTTP ${res.status}`);
      const since = j.requested_ms, stop = Date.now() + 180000;
      msg.textContent = j.already_pending ? 'A request is already waiting for the bot…' : 'Asked. Waiting for the bot to answer (about a minute at most)…';
      clearInterval(askWatch);
      askWatch = setInterval(async () => {
        await load();
        const hb = data && data.status && data.status.last_heartbeat_ms;
        if (hb != null && hb >= since) { clearInterval(askWatch); btn.disabled = false; msg.textContent = `The bot answered at ${fmtHm(hb)}${tzTag()}.`; }
        else if (Date.now() > stop) { clearInterval(askWatch); btn.disabled = false; msg.textContent = 'No answer yet. The bot may be busy, offline, or still on the old version (it needs the update that adds this). It answers when it next reports.'; }
      }, 5000);
    } catch (e) { btn.disabled = false; msg.textContent = `Could not ask: ${e.message}`; }
  }
  $('#askBtn').addEventListener('click', askBot);

  tick();
  load(true);
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !$('#app').hidden) load(); }, 60000);   // keeps the alive/stale status honest; 304 when nothing changed
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) { tick(); load(); } });
})();

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

  // The five pages: Overview (the three live bots), Live Bots (a workspace per bot), Research Lab (paper bots + market recorder), System Monitor, Settings.
  const LIVE = ['bbcore', 'icore', 'tcore'], LABS = ['bb1h', 'bbn', 'icn', 'tcn', 'cbb', 'ctc'];   // the paper labs: the 1h BB-Core, the three news labs (each strategy with the news gate), and the two coin labs (BB-CORE on ARB, T-CORE on SUI + ARB). (The T-CORE paper lab bbtr is not shown as a lab: T-CORE trades live; the News Lab page still compares against it.)
  const NEWS = { bbn: 'bbcore', icn: 'icore', tcn: 'bbtr' };   // news lab -> the bot it is compared with (tcn against the T-CORE paper lab: same engine, same paper costs)
  const BOTS = {
    bbcore: { label: 'BB-Core', live: true, role: 'Live' }, icore: { label: 'I-Core', live: true, role: 'Live' }, tcore: { label: 'T-CORE', live: true, role: 'Live' },
    bb1h: { label: 'BB-1h lab', live: false, role: 'Paper lab' },
    bbn: { label: 'BB-CORE news', live: false, role: 'News lab' }, icn: { label: 'I-CORE news', live: false, role: 'News lab' }, tcn: { label: 'T-CORE news', live: false, role: 'News lab' },
    bbtr: { label: 'T-CORE lab', live: false, role: 'Paper lab' },
    cbb: { label: 'BB-CORE ARB', live: false, role: 'Coin lab' }, ctc: { label: 'T-CORE SUI+ARB', live: false, role: 'Coin lab' },
  };
  const BOT_SUBS = [['dashboard', 'Dashboard'], ['performance', 'Performance'], ['trades', 'Trades & Calendar'], ['positions', 'Positions & Activity'], ['verification', 'Verification'], ['health', 'Health']];
  const LAB_SUBS = [['overview', 'Labs'], ['news', 'News Lab'], ['performance', 'Performance'], ['trades', 'Trades & Calendar'], ['research', 'Research'], ['market', 'Market & Costs']];
  const PAGES = ['overview', 'bots', 'lab', 'system', 'settings'];

  let tz = store.get('bot.tz') === 'local' ? 'local' : 'utc', data = null, etag = null, modeSel = store.get('bot.mode') || '';
  let chartDays = [0, 1, 7, 30, 91].includes(+store.get('bot.range')) ? +store.get('bot.range') : 0;   // chart range in days: 1 day, 1 week ... ; 0 = everything
  let chartKind = ['capital', 'perf', 'daily'].includes(store.get('bot.chart')) ? store.get('bot.chart') : 'capital';   // Overview chart
  let bchartKind = ['balance', 'perf', 'r', 'dd'].includes(store.get('bot.bchart')) ? store.get('bot.bchart') : 'r';   // a bot's own chart
  let period = ['month', 'year', 'day'].includes(store.get('bot.period')) ? store.get('bot.period') : 'day';
  let eqMetric = store.get('bot.eqm') === 'usd' ? 'usd' : 'r', eqDays = [0, 7, 30, 91].includes(+store.get('bot.eqr')) ? +store.get('bot.eqr') : 0;   // the strategy's equity curve: by R or by P&L, and its range
  // where we are: a page, the chosen live bot and lab, and the sub-page of each. Every visit opens on Overview; a link like #bots/tcore/health opens that page.
  const route = { page: 'overview', bot: LIVE.includes(store.get('bot.view')) ? store.get('bot.view') : 'bbcore', lab: LABS.includes(store.get('bot.lab')) ? store.get('bot.lab') : 'bb1h', bsub: 'dashboard', lsub: 'overview' };
  const LEGACY = { performance: ['bots', 'performance'], calendar: ['bots', 'trades'], verify: ['bots', 'verification'], log: ['bots', 'positions'], status: ['system'], research: ['lab', 'research'] };   // the old seven tabs
  function readHash(h) {
    const [p, a, b] = String(h || '').replace(/^#/, '').split('/');
    if (LEGACY[p]) { route.page = LEGACY[p][0]; if (LEGACY[p][1]) route[route.page === 'bots' ? 'bsub' : 'lsub'] = LEGACY[p][1]; return; }
    if (!PAGES.includes(p)) return;
    route.page = p;
    if (p === 'bots') { if (LIVE.includes(a)) route.bot = a; if (BOT_SUBS.some(([k]) => k === b)) route.bsub = b; }
    if (p === 'lab') { if (LABS.includes(a)) route.lab = a; if (LAB_SUBS.some(([k]) => k === b)) route.lsub = b; }
  }
  const hashOf = () => (route.page === 'bots' ? `bots/${route.bot}/${route.bsub}` : route.page === 'lab' ? `lab/${route.lab}/${route.lsub}` : route.page);
  const viewKey = () => (route.page === 'bots' ? `bots:${route.bsub}` : route.page === 'lab' ? `lab:${route.lsub}` : route.page);
  readHash(location.hash);
  const filters = { q: '', coin: '', side: '', reason: '', from: '', to: '' };
  const PAGE = { trades: 100, skipped: 50, journal: 100 }, shown = { trades: PAGE.trades, skipped: PAGE.skipped, journal: PAGE.journal };   // long tables show their first rows; "Show more" adds the next ones (a thousand rows at once is what makes a phone slow)
  const moreBtn = (host, key, total, rerender) => { const h = clear(host); if (total <= shown[key]) return; h.append(el('button', { type: 'button', class: 'ghost sm' }, `Show ${Math.min(PAGE[key], total - shown[key])} more · showing ${shown[key]} of ${total}`)); h.firstChild.addEventListener('click', () => { shown[key] += PAGE[key]; rerender(); }); };

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

  // ---------------- one bot's data: every page reads a bot through bd(), so each bot shows ITS OWN trades, positions, log, checks and uptime ----------------
  const lastOf = (list, k) => (list.length ? list.reduce((m, x) => Math.max(m, x[k] || 0), 0) || null : null);
  const ZERO = () => ({ trades: 0, wins: 0, losses: 0, win_rate: null, profit_factor: null, avg_r: null, total_r: 0, max_dd_r: 0, longest_losing_streak: 0 });
  function bd(k) {
    const d = data; if (!d) return null;
    const meta = BOTS[k], perf = d.perf ? d.perf[k] : null;
    if (k === 'bbcore') {
      const s = d.status, bb = (d.bots && d.bots.bbcore) || {};
      return { key: k, ...meta, present: true, mode: d.mode, hb: s.last_heartbeat_ms, alive: !!s.alive, status: s, trades: d.trades, open_list: d.open, capital: d.capital, overall: d.overall, perf, compare: d.compare, compares: d.compares || [],
        skipped: d.skipped, skip_counts: d.skip_counts || {}, activity: (d.activity || []).filter((a) => a.kind !== 'capital'), uptime: d.uptime, coins: s.enabled_coins || [], kill: !!s.kill_switch, dd: s.drawdown_r, halt: s.halt_r,
        first_ms: d.first_event_ms, last_exit_ms: bb.last_exit_ms ?? lastOf(d.trades, 'exit_ts'), last_entry_ms: bb.last_entry_ms ?? lastOf(d.trades, 'entry_ts'), trend: null };
    }
    const b = (d.bots && d.bots[k]) || (d.labs && d.labs[k]) || (d.news_labs && d.news_labs[k]) || (d.coin_labs && d.coin_labs[k]);
    if (!b) return { key: k, ...meta, present: false, mode: meta.live ? 'live' : 'paper', hb: null, alive: false, status: {}, trades: [], open_list: [], capital: null, overall: ZERO(), perf, compare: null, compares: [], skipped: [], skip_counts: {},
      activity: [], uptime: null, coins: [], kill: false, dd: null, halt: null, first_ms: null, last_exit_ms: null, last_entry_ms: null, trend: null };
    return { key: k, ...meta, present: true, mode: b.mode, hb: b.last_heartbeat_ms, alive: !!b.alive, status: b.status || {}, trades: b.trades || [], open_list: b.open_list || [], capital: b.capital, overall: b.overall, perf, compare: b.compare, compares: b.compares || [],
      skipped: b.skipped || [], skip_counts: b.skip_counts || {}, activity: b.activity || [], uptime: b.uptime || null, coins: b.enabled_coins || [], kill: !!b.kill_switch, dd: b.drawdown_r, halt: b.halt_r,
      first_ms: b.first_event_ms, last_exit_ms: b.last_exit_ms ?? null, last_entry_ms: b.last_entry_ms ?? null, trend: b.trend || null };
  }
  const curKey = () => (route.page === 'lab' ? route.lab : route.bot);
  const view = () => { const b = bd(curKey()); return { key: b.key, label: b.label, mode: b.mode, perf: b.perf, trades: b.trades, b }; };
  const livePresent = () => LIVE.map(bd).filter((b) => b.present && b.mode === 'live');   // bots whose numbers are live money: a paper bot never counts here

  // ---------------- state of a bot, said plainly: healthy / stale / offline / missing; a figure the dashboard is not sent is "Unavailable", never zero ----------------
  const OFFLINE_MS = 864e5;
  function health(b) {
    if (!b.present) return { state: 'missing', label: 'MISSING', note: 'has not reported to the dashboard yet' };
    if (b.hb == null) return { state: 'missing', label: 'MISSING', note: 'no heartbeat received yet' };
    if (b.alive) return { state: 'healthy', label: 'HEALTHY', note: '' };
    const age = Date.now() - b.hb;
    return age > OFFLINE_MS ? { state: 'offline', label: 'OFFLINE', note: `no heartbeat for ${fmtDur(age / 1000)}` } : { state: 'stale', label: 'STALE', note: `no heartbeat for ${fmtDur(age / 1000)}` };
  }
  const hchip = (h) => el('span', { class: `hchip ${h.state}`, title: h.note || null }, h.label);
  const na = (why) => el('span', { class: 'na', title: why || 'The dashboard is not sent this figure' }, 'Unavailable');
  const worstHealth = (list) => (list.some((h) => h.state === 'stale' || h.state === 'offline') ? 'bad' : list.some((h) => h.state === 'missing') ? 'warnd' : 'ok');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const walletOf = (b) => { const wc = data && data.wallet_capital; return wc ? wc.parts.find((p) => norm(p.label) === norm(b.label)) || null : null; };
  const modeTag = (m) => el('span', { class: `modeTag ${m}` }, String(m).toUpperCase());

  // Live capital: the real MEXC balances from the wallet reports, every trading account added together. Without them, only bots that are in LIVE mode count (from their own balance);
  // a paper balance is listed as excluded and never added.
  function liveCapital(d) {
    const wc = d.wallet_capital;
    if (wc) return { usd: wc.usd, parts: wc.parts, missing: wc.missing, as_of: wc.as_of, source: 'wallet', paper: [] };
    const tc = d.total_capital; if (!tc) return null;
    const live = tc.parts.filter((p) => p.mode === 'live');
    return { usd: live.length ? Math.round(live.reduce((a, p) => a + p.usd, 0) * 100) / 100 : null, parts: live, missing: tc.missing, as_of: live.length ? Math.max(...live.map((p) => p.as_of)) : null, source: 'bots', paper: tc.paper };
  }
  // The wallet-report history with deposits and payouts taken out (a deposit is recorded a little before or after the balances show it, so it is taken out at the jump it made: the biggest
  // step its way within 2 hours of it). The time-weighted return chains each interval's growth with its flow removed, exactly like lib/aggregate.js capital().
  function walletSeries(d) {
    const wh = d.wallet_history || []; if (wh.length < 2) return null;
    const at = new Array(wh.length).fill(0);
    for (const f of d.capital_flows || []) {
      let best = -1, big = -Infinity;
      for (let i = 1; i < wh.length; i++) if (Math.abs(wh[i].ts - f.ts) <= 72e5) { const st = (wh[i].usd - wh[i - 1].usd) * Math.sign(f.usd); if (st > big) { big = st; best = i; } }
      if (best < 0) { best = wh.findIndex((p) => p.ts >= f.ts); if (best < 0) best = wh.length - 1; }   // no report near it: from when it was recorded
      at[best] += f.usd;
    }
    let cum = 0, twr = 1;
    const adj = wh.map((p, i) => ({ ts: p.ts, y: p.usd - (cum += at[i]) }));
    for (let i = 1; i < wh.length; i++) if (wh[i - 1].usd > 0) twr *= (wh[i].usd - at[i]) / wh[i - 1].usd;
    return { wh, adj, twr: (twr - 1) * 100 };
  }
  // cumulative R and drawdown of closed trades in exit order (the same sums as lib/aggregate.js, for any bot)
  function rCurve(trades) {
    let cum = 0, peak = 0;
    return [...trades].sort((a, b) => a.exit_ts - b.exit_ts).map((t) => { cum += t.r; peak = Math.max(peak, cum); return { ts: t.exit_ts, r_cum: Math.round(cum * 1000) / 1000, dd_r: Math.round((peak - cum) * 1000) / 1000 }; });
  }
  const riskOf = (b) => { const l = [...b.trades, ...b.open_list].filter((t) => Number.isFinite(t.risk_pct)).sort((a, c) => c.entry_ts - a.entry_ts)[0]; return l ? l.risk_pct : null; };   // what the bot sized its newest entry at (a fraction of the balance)
  const capOf = (b) => { const w = walletOf(b); if (w) return w.usd; return b.capital && b.mode === 'live' ? b.capital.usd : null; };   // live bots: the MEXC wallet; a paper balance is never passed off as wallet money

  // ---------------- tables ----------------
  function table(cols, rows, empty, onRow) {
    if (!rows.length) return el('div', { class: 'empty' }, empty);
    return el('table', {}, el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.left ? 'l' : '' }, c.h)))),
      el('tbody', {}, rows.map((r) => {
        const tr = el('tr', { class: [r._cls, onRow ? 'click' : ''].filter(Boolean).join(' ') || null, tabindex: onRow ? 0 : null, role: onRow ? 'button' : null }, cols.map((c) => el('td', { class: `${c.left ? 'l' : ''} ${c.c ? c.c(r) : ''}` }, c.f(r))));
        if (onRow) { tr.addEventListener('click', () => onRow(r)); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRow(r); } }); }
        return tr;
      })));
  }

  // ---------------- charts (inline SVG) ----------------
  function lineChart(host, pts, { dd = false, fmtY = (v) => v.toFixed(1), fmtTip = null, tipOf = null, empty = 'No closed trades yet.', marks = [], hline = null } = {}) {
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
    // round values on the value axis (1, 2, 2.5 or 5 × a power of ten), about four lines
    const raw = (y1 - y0) / 4, mag = 10 ** Math.floor(Math.log10(raw || 1)), stepY = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) || raw;
    for (let v = Math.ceil(y0 / stepY) * stepY; v <= y1 + stepY * 1e-9; v += stepY) {
      const y = sy(v);
      svg.append(sv('line', { class: 'grid-l', x1: L, y1: y, x2: W - R, y2: y }), t(L - 8, y + 3.5, fmtY(Math.abs(v) < stepY * 1e-9 ? 0 : v), 'end'));
    }
    if (!dd && y0 < 0 && y1 > 0) svg.append(sv('line', { class: 'zero', x1: L, y1: sy(0), x2: W - R, y2: sy(0) }));
    if (hline != null) svg.append(sv('line', { class: 'limit', x1: L, y1: sy(hline), x2: W - R, y2: sy(hline) }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const base = (dd ? sy(0) : H - B).toFixed(1), last = pts[pts.length - 1];
    svg.append(sv('path', { class: dd ? 'dd' : 'area', d: `${path} L${sx(last.ts).toFixed(1)},${base} L${sx(pts[0].ts).toFixed(1)},${base} Z` }));
    if (!dd) svg.append(sv('path', { class: 'line', d: path }), sv('circle', { class: 'dot', cx: sx(last.ts), cy: sy(last.y), r: 3.5 }));
    // capital added or removed: a labeled step, never part of the line's gain. Steps close together on the chart share one label (their sum).
    const steps = [];
    for (const m of marks.filter((q) => q.ts >= x0 && q.ts <= x1).sort((a, b) => a.ts - b.ts)) {
      const s = steps[steps.length - 1];
      if (s && sx(m.ts) - sx(s.ts) < 40 && (s.usd >= 0) === (m.usd >= 0)) s.usd += m.usd; else steps.push({ ts: m.ts, usd: m.usd });
    }
    steps.forEach((m, i) => {
      const x = sx(m.ts), up = m.usd >= 0, lbl = t(Math.min(x + 3, W - R - 2), T + 10 + (i % 3) * 11, `${up ? '+' : '−'}$${Math.abs(m.usd).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${m.usd >= 0 ? 'capital' : 'payout'}`, x > W - 120 ? 'end' : 'start');
      lbl.setAttribute('class', `flow-t ${up ? 'in' : 'out'}`);
      svg.append(sv('line', { class: `flow-l ${up ? 'in' : 'out'}`, x1: x, y1: T, x2: x, y2: H - B }), lbl);
    });
    // five labels along the time axis: clock times for a day or two, dates beyond
    const short = x1 - x0 <= 2 * 864e5, xl = (ms) => (short ? fmtHm(ms) : `${MON[parts(ms).mo - 1]} ${parts(ms).d}`);
    for (let i = 0; i <= 4; i++) { const ms = x0 + ((x1 - x0) * i) / 4; svg.append(t(sx(ms), H - 7, i === 0 && short ? `${fmtDay(ms).replace(/, \d+$/, '')} ${xl(ms)}` : xl(ms), i === 0 ? 'start' : i === 4 ? 'end' : 'middle')); }
    host.append(svg);
    // hover / touch: crosshair + dot on the nearest point, tooltip with its date and value
    const cross = sv('line', { class: 'hov-l', y1: T, y2: H - B, style: 'display:none' }), hdot = sv('circle', { class: 'hov-d', r: 4.5, style: 'display:none' });
    const hit = sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', style: 'cursor:crosshair;touch-action:pan-y' });
    svg.append(cross, hdot, hit);
    const tip = el('div', { class: 'chart-tip', style: 'display:none' });
    host.style.position = 'relative'; host.append(tip);
    const tipFmt = fmtTip || fmtY;
    const off = () => { cross.style.display = hdot.style.display = tip.style.display = 'none'; };
    const move = (ev) => {
      const r = svg.getBoundingClientRect(); if (!r.width) return;
      const vx = ((ev.clientX - r.left) / r.width) * W, tx = x0 + ((vx - L) / (W - L - R)) * (x1 - x0);
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].ts < tx) lo = m + 1; else hi = m; }
      if (lo > 0 && Math.abs(pts[lo - 1].ts - tx) <= Math.abs(pts[lo].ts - tx)) lo--;
      const p = pts[lo], cx = sx(p.ts), cy = sy(p.y);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); hdot.setAttribute('cx', cx); hdot.setAttribute('cy', cy);
      cross.style.display = hdot.style.display = tip.style.display = '';
      tip.textContent = tipOf ? tipOf(p) : `${fmtTime(p.ts)} · ${tipFmt(p.y)}`;
      const px = (cx / W) * r.width, tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(r.width - tw, px - tw / 2))}px`; tip.style.top = `${Math.max(0, (cy / H) * r.height - 34)}px`;
    };
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', off); hit.addEventListener('pointercancel', off);
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
    const tip = el('div', { class: 'chart-tip', style: 'display:none' }); host.style.position = 'relative';
    rows.forEach((r, i) => {
      const x = L + i * bw + gap / 2, y = sy(Math.max(0, r.r)), h = Math.max(1, Math.abs(sy(r.r) - sy(0)));
      const b = sv('rect', { class: r.r >= 0 ? 'bar up' : 'bar down', x: x.toFixed(1), y: y.toFixed(1), width: Math.max(1, bw - gap).toFixed(1), height: h.toFixed(1), rx: 2 });
      const label = `${periodLabel(r.key)} · ${fmtR(r.r)}${r.usd != null ? ` · ${fmtUsd(r.usd, true)}` : ''} · ${r.trades} trade${r.trades === 1 ? '' : 's'}`;
      const tt = sv('title'); tt.textContent = label; b.append(tt); svg.append(b);
      b.style.cursor = 'crosshair';
      const show = () => { const sr = svg.getBoundingClientRect(); tip.textContent = label; tip.style.display = ''; const tw = tip.offsetWidth, cx = ((x + (bw - gap) / 2) / W) * sr.width; tip.style.left = `${Math.max(0, Math.min(sr.width - tw, cx - tw / 2))}px`; tip.style.top = `${Math.max(0, (Math.min(sy(r.r), sy(0)) / H) * sr.height - 32)}px`; b.style.opacity = 1; };
      b.addEventListener('pointerenter', show); b.addEventListener('pointerdown', show); b.addEventListener('pointerleave', () => { tip.style.display = 'none'; b.style.opacity = ''; });
      if (i % every === 0 || i === n - 1) svg.append(t(x + (bw - gap) / 2, H - 6, r.key.length === 7 ? periodLabel(r.key) : r.key.length === 10 ? r.key.slice(5) : r.key));
    });
    host.append(svg, tip);
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

  // ---------------- render: the header always, the open page now; a page is drawn when it is opened and again after new data ----------------
  let drawn = null;
  const RENDER = {
    overview: () => { renderKpis(data); renderCheckbar(data); renderBots(data); renderChart(); renderOpenAll(); renderLatest(); renderHealthStrip(); },
    'bots:dashboard': () => renderBotDash(),
    'bots:performance': () => renderBotPerf(),
    'bots:trades': () => { renderTrades(); renderCalendar(); },
    'bots:positions': () => renderPositions(),
    'bots:verification': () => { renderChecks(); renderCompare(); renderCompareDetail(); },
    'bots:health': () => renderHealth(),
    'lab:overview': () => renderLabOverview(),
    'lab:performance': () => renderBotPerf(),
    'lab:trades': () => { renderTrades(); renderCalendar(); },
    'lab:research': () => renderResearch(),
    'lab:market': () => renderMarket(),
    'lab:news': () => renderNewsLab(),
    system: () => renderSystem(),
    settings: () => renderSettings(),
  };
  function render(d) {
    data = d;
    const lives = LIVE.map((k) => { const b = bd(k); return { b, h: health(b) }; });
    const count = (s) => lives.filter((x) => x.h.state === s).length, bad = count('stale') + count('offline'), missing = count('missing');
    // the pill speaks for all three live bots, not for BB-Core alone
    const pill = $('#statusPill'); pill.hidden = false;
    pill.className = `pill ${bad ? 'bad' : missing ? '' : 'ok'}`;
    pill.textContent = `LIVE BOTS · ${count('healthy')}/${lives.length} ONLINE${missing ? ` · ${missing} MISSING` : ''}`;
    const probs = [], notes = [];
    for (const { b, h } of lives) {
      if (h.state === 'stale' || h.state === 'offline') probs.push(`${b.label}: ${h.note} (limit ${fmtDur(d.status.stale_after_ms / 1000)}). Check the VPS.`);
      if (b.present && b.kill) notes.push(`${b.label}: kill switch is ON, no new entries.`);
    }
    for (const p of (d.wallet_capital ? d.wallet_capital.parts : [])) if (p.suspect) notes.push(`${p.label}: a wallet report is waiting for your approval.`);
    const alert = $('#alert');
    if (probs.length) { alert.hidden = false; alert.className = 'alert'; alert.textContent = probs.join(' · '); }
    else if (notes.length) { alert.hidden = false; alert.className = 'alert warn'; alert.textContent = notes.join(' · '); }
    else alert.hidden = true;
    const seen = Math.max(d.last_update_ms || 0, ...LIVE.concat(LABS).map((k) => bd(k).hb || 0)) || null;   // the newest thing any bot has told us
    const upd = $('#updated'); upd.hidden = seen == null; upd.dataset.ts = seen ?? '';
    $('#footer').textContent = `data generated ${fmtTime(d.generated_at)} · checks for news every 60s · times in ${tz === 'utc' ? 'UTC' : 'your local time'} · BB-Core data mode: ${d.mode}`;
    const sysH = lives.map((x) => x.h).concat(LABS.map((k) => health(bd(k))).filter((h) => h.state !== 'missing'), d.recorder ? [{ state: d.recorder.alive ? 'healthy' : 'stale' }] : []);
    $('#tbBots').className = `tb-dot ${worstHealth(lives.map((x) => x.h))}`;
    $('#tbSys').className = `tb-dot ${worstHealth(sysH)}`;
    drawn = null;
    applyRoute();
  }
  function drawView() {
    if (!data) return;
    const key = viewKey(), sig = `${key}|${route.page === 'bots' ? route.bot : route.page === 'lab' ? route.lab : ''}`;
    if (sig === drawn) return;
    drawn = sig;
    const m = view().mode;
    for (const n of $$('.modeTag[data-botmode]')) { n.textContent = String(m).toUpperCase(); n.className = `modeTag ${m}`; }
    RENDER[key]();
    tick();
  }
  function applyRoute() {
    if (!data) return;
    const key = viewKey(), ws = route.page === 'bots' || route.page === 'lab';
    $('#app').dataset.page = route.page; $('#app').dataset.bot = ws ? curKey() : '';
    for (const e of $$('[data-v]')) e.hidden = !e.dataset.v.split(' ').includes(key);
    for (const b of $$('#mainTabs button')) { const on = b.dataset.page === route.page; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }
    renderSubnav();
    try { history.replaceState(null, '', '#' + hashOf()); } catch {}
    drawView();
  }
  // the bot chooser (live bots, or the two labs) and the sub-pages of the open workspace
  function renderSubnav() {
    const sub = $('#subTabs'), sel = $('#botSel'), p = route.page, subs = p === 'bots' ? BOT_SUBS : p === 'lab' ? LAB_SUBS : null;
    sub.hidden = !subs;
    if (subs) {
      const cur = p === 'bots' ? route.bsub : route.lsub, b = bd(curKey());
      clear(sub).append(...subs.map(([k, l]) => {
        let badge = null;
        if (p === 'bots' && k === 'verification' && b.perf) badge = el('span', { class: `tb-dot ${b.perf.verdict === 'stop' ? 'bad' : b.perf.verdict === 'warn' ? 'warnd' : 'ok'}`, 'aria-hidden': 'true' });
        if (p === 'bots' && k === 'positions' && b.open_list.length) badge = el('span', { class: 'tb-n' }, String(b.open_list.length));
        return el('button', { type: 'button', role: 'tab', 'data-sub': k, class: k === cur ? 'on' : '', 'aria-selected': k === cur, tabindex: k === cur ? 0 : -1 }, badge, l);
      }));
    }
    const showSel = p === 'bots' || (p === 'lab' && route.lsub !== 'overview' && route.lsub !== 'news');
    sel.hidden = !showSel;
    if (showSel) {
      const cur = curKey();
      clear(sel).append(...(p === 'bots' ? LIVE : LABS).map((k) => { const b = bd(k), h = health(b); return el('button', { type: 'button', 'data-selbot': k, 'data-bot': k, class: `bsel ${k === cur ? 'on' : ''}`, 'aria-pressed': k === cur }, el('i', { class: `dot ${h.state}` }), b.label, el('small', {}, b.present ? String(b.mode).toUpperCase() : 'MISSING')); }));
    }
  }
  function setPage(p) { if (!PAGES.includes(p)) return; route.page = p; applyRoute(); }
  function setSub(s) { route[route.page === 'bots' ? 'bsub' : 'lsub'] = s; applyRoute(); }
  function goBot(k, sub) {   // open a bot's workspace (a live bot's pages, or a lab's)
    if (LIVE.includes(k)) { route.page = 'bots'; route.bot = k; store.set('bot.view', k); if (sub) route.bsub = sub; } else { route.page = 'lab'; route.lab = k; store.set('bot.lab', k); route.lsub = sub || 'performance'; }
    shown.trades = PAGE.trades; shown.journal = PAGE.journal; drawn = null; applyRoute(); window.scrollTo(0, 0);
  }
  const selectBot = (k) => goBot(k, LIVE.includes(k) ? null : route.lsub);   // keeps the sub-page you are on

  // ---------------- Overview: the three live bots together. Paper bots and paper balances never appear here (they live in the Research Lab). ----------------
  // Live capital is remembered in this browser, so a report that carries no balance (or a refresh that fails) never blanks the overview: the last known figure stays, labelled with its age.
  const LAST_CAP = 'bot.lastCapital';
  const rememberCapital = (usd, text, asOf) => { if (Number.isFinite(usd)) store.set(LAST_CAP, JSON.stringify({ usd, text, as_of: asOf || Date.now() })); };
  const lastCapital = () => { try { const c = JSON.parse(store.get(LAST_CAP)); return c && Number.isFinite(c.usd) ? c : null; } catch { return null; } };
  const kpiCard = (label, value, sub, c) => el('div', { class: 'kpi' }, el('div', { class: 'k' }, label), el('div', { class: `mid ${c || ''}` }, value), el('div', { class: 'sub' }, sub));
  function renderKpis(d) {
    const lc = liveCapital(d), lives = livePresent(), ws = walletSeries(d), sub = clear($('#kCapitalSub'));
    if (lc && lc.usd != null) {   // the real balances from the bots' 5-minute wallet reports: every trading account added together
      const wc = lc, txt = wc.parts.map((p) => `${p.label} ${fmtUsd(p.usd)}`).join(' + ');
      $('#kCapital').textContent = fmtUsd(wc.usd);
      add(sub, txt, wc.source === 'wallet' ? [' · MEXC reports ', ago(wc.as_of)] : ' · each bot\'s own balance');
      if (wc.missing.length) sub.append(el('span', { class: 'bad' }, ` · ${wc.missing.join(', ')} has not reported, not counted`));
      if (wc.parts.some((p) => p.suspect)) sub.append(el('span', { class: 'warn' }, ' · a wallet report is waiting for approval'));
      if (wc.paper && wc.paper.length) sub.append(el('span', { class: 'muted' }, ` · paper balances excluded (${wc.paper.join(', ')})`));
      if (wc.source === 'wallet' && Date.now() - wc.as_of > 30 * 60000) sub.append(el('span', { class: 'bad' }, ' · old: the VPS has not reported for a while'));
      if (wc.source === 'wallet' && !wc.missing.length) rememberCapital(wc.usd, txt, wc.as_of);
    } else if (lastCapital()) {   // nothing came with this report: keep the last known total instead of a blank
      const c = lastCapital();
      $('#kCapital').textContent = fmtUsd(c.usd);
      sub.append(c.text ? c.text + ' · ' : '', 'last known, ', ago(c.as_of));
    } else {
      $('#kCapital').textContent = '—';
      sub.append(na('No live balance has reached the dashboard'), ' no live wallet report yet.');
    }
    spark($('#kSpark'), (d.wallet_history || []).slice(-120).map((p) => p.usd));
    // time-weighted return: trading only, deposits and payouts removed
    const tw = $('#kTwr');
    if (ws) { tw.textContent = fmtPct(ws.twr, true); tw.className = `mid ${cls(ws.twr)}`; $('#kTwrSub').textContent = `since the first wallet report, ${fmtDay(ws.wh[0].ts)}; capital added or paid out is not counted`; }
    else { clear(tw).append(na('Needs at least two wallet reports')); tw.className = 'mid'; $('#kTwrSub').textContent = 'Needs the wallet-report history.'; }
    // realized P&L: the dollars MEXC booked, live bots only
    let usd = 0, booked = 0, total = 0, w = 0;
    for (const b of lives) for (const t of b.trades) { total++; if (t.r > 0) w++; if (t.usd != null) { usd += t.usd; booked++; } }
    const net = clear($('#kNet'));
    if (booked) { net.textContent = fmtUsd(usd, true); net.className = `mid ${cls(usd)}`; $('#kNetSub').textContent = `${booked} of ${total} closed trades have a booked $ figure · ${w}W / ${total - w}L`; }
    else if (total) { net.append(na('The closed trades carry no dollar figure')); net.className = 'mid'; $('#kNetSub').textContent = `${total} closed trades, no $ figures shared`; }
    else { net.textContent = '—'; net.className = 'mid'; $('#kNetSub').textContent = 'No closed live trade yet.'; }
    // open positions across the live bots
    const openN = lives.reduce((a, b) => a + b.open_list.length, 0), miss = LIVE.map(bd).filter((b) => !b.present);
    $('#kOpenN').textContent = String(openN);
    $('#kOpenSub').textContent = LIVE.map(bd).map((b) => `${b.label} ${b.present ? (b.mode === 'live' ? b.open_list.length : 'paper') : 'missing'}`).join(' · ');
    // the bot closest to its halt
    let worst = null;
    for (const b of lives) if (b.dd != null && b.halt) { const ratio = b.dd / Math.abs(b.halt); if (!worst || ratio > worst.ratio) worst = { b, ratio }; }
    const dd = $('#kDd'), bar = $('#kDdBar');
    if (worst) {
      const pct = Math.min(100, worst.ratio * 100);
      dd.textContent = `${Number(worst.b.dd).toFixed(1)}R / ${Math.abs(worst.b.halt)}R`; bar.style.setProperty('width', `${pct}%`); bar.parentElement.classList.toggle('hot', pct >= 60);
      $('#kDdSub').textContent = `${worst.b.label} · ${pct.toFixed(0)}% of its halt${miss.length ? ` · ${miss.map((b) => b.label).join(', ')} not reporting` : ''}`;
    } else { clear(dd).append(na('No drawdown figure has been reported yet')); bar.style.setProperty('width', '0%'); $('#kDdSub').textContent = 'No heartbeat with a drawdown yet.'; }
  }
  // one line: is everything inside the rules? (the detail is on each bot's Verification page)
  function renderCheckbar(d) {
    const box = clear($('#pChecks')), bots = LIVE.map(bd), list = bots.filter((b) => b.present && b.perf);
    if (!list.length) { box.className = 'checkbar off'; return; }
    box.className = `checkbar ${worst(list.map((b) => b.perf.verdict))}`;
    box.append(el('span', { class: 'cb-k' }, 'Checks'));
    for (const b of bots) {
      if (!b.present || !b.perf) { box.append(el('span', { class: 'cb-item' }, hchip({ state: 'missing', label: 'MISSING' }), ` ${b.label}: has not reported`)); continue; }
      const p = b.perf, bad = p.checks.filter((c) => c.level === 'warn' || c.level === 'stop');
      box.append(el('span', { class: 'cb-item' }, lvlChip(p.verdict === 'ok' ? 'ok' : p.verdict), ` ${b.label}: `, bad.length ? bad.map((c) => `${c.title} (${LVL[c.level].toLowerCase()})`).join(', ') : 'all inside the rules'));
    }
    box.append(el('span', { class: 'cb-go' }, 'Verification →'));
  }
  // one card per bot (live bots on Overview, the paper labs on the lab page): the same component
  function botCard(b, o = {}) {
    const h = health(b), card = el('div', { class: `botcard ${o.open ? 'link' : ''} ${h.state}`, 'data-bot': b.key, 'data-open': o.open ? b.key : null, role: o.open ? 'button' : null, tabindex: o.open ? 0 : null });
    card.append(el('div', { class: 'bc-h' }, el('i', { class: 'bdot' }), el('strong', {}, b.label), b.present ? modeTag(b.mode) : null, el('span', { class: 'bc-state' }, hchip(h))));
    if (!b.present) { card.append(el('p', { class: 'muted' }, `${b.label} ${h.note}. Its numbers appear here as soon as it reports; nothing is shown as zero in the meantime.`)); return card; }
    const o_ = b.overall, cap = capOf(b), paperCap = !b.live && b.capital ? b.capital.usd : null, r = riskOf(b);
    const stat = (k, v, c) => el('div', { class: 'bc-s' }, el('div', { class: 'k' }, k), el('div', { class: `v ${c || ''}` }, v));
    card.append(el('div', { class: 'bc-grid' },
      stat(b.live ? 'Capital' : 'Paper balance', b.live ? (cap == null ? na('No wallet report or live balance received for this bot') : fmtUsd(cap)) : paperCap == null ? na('No paper balance received yet') : fmtUsd(paperCap)),
      stat('Total R', fmtR(o_.total_r), cls(o_.total_r)), stat('Win', pct0(o_.win_rate)),
      stat('Closed', String(o_.trades)), stat('Open', String(b.open_list.length)),
      stat('Risk / trade', r == null ? '—' : `${+(r * 100).toFixed(2)}%${cap == null ? '' : ` ≈ ${fmtUsd(r * cap)}`}`)));
    card.append(el('div', { class: 'bc-wl' }, el('div', { class: 'bc-wlt' }, el('span', { class: 'k' }, 'W / L'), el('span', { class: 'v' }, el('span', { class: 'good' }, String(o_.wins)), ' / ', el('span', { class: 'bad' }, String(o_.trades - o_.wins)))),
      el('div', { class: 'wlbar', title: `${o_.wins} won, ${o_.trades - o_.wins} lost` }, o_.trades ? [el('i', { class: 'w', style: `flex:${o_.wins}` }), el('i', { class: 'l', style: `flex:${o_.trades - o_.wins}` })] : el('i', { class: 'n', style: 'flex:1' }))));
    if (b.dd != null && b.halt) { const pct = Math.min(100, (b.dd / Math.abs(b.halt)) * 100); const bar = el('i'); bar.style.setProperty('width', `${pct}%`); card.append(el('div', { class: `bc-dd${pct >= 60 ? ' hot' : ''}` }, el('div', { class: 'bc-wlt' }, el('span', { class: 'k' }, 'Drawdown vs halt'), el('span', { class: 'v' }, `${Number(b.dd).toFixed(1)}R / ${Math.abs(b.halt)}R`)), el('div', { class: 'meter' }, bar))); }
    card.append(el('div', { class: 'bc-f' }, b.hb != null ? ['Last heartbeat ', ago(b.hb)] : 'No heartbeat yet', b.kill ? el('span', { class: 'bad' }, ' · KILL SWITCH ON') : null, o.open ? el('span', { class: 'bc-go' }, 'Open →') : null));
    return card;
  }
  function renderBots(d) {
    clear($('#bots')).append(el('div', { class: 'botcards three' }, LIVE.map((k) => botCard(bd(k), { open: true }))));
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
  const RANGE_NAME = { 1: 'day', 7: 'week', 30: 'month', 91: '3 months' };
  const usdAxis = (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, usdTip = (v) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function renderChart() {
    if (!data) return;
    for (const b of $$('#rangeTabs button')) { const on = +b.dataset.range === chartDays; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    for (const b of $$('#chartTabs button')) { const on = b.dataset.chart === chartKind; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    const d = data, note = $('#chartNote'), ws = walletSeries(d), none = 'Unavailable: the live wallet reports have not built up a history yet.';
    if (chartKind === 'capital' && ws) {
      const pts = inRange(ws.wh.map((p) => ({ ts: p.ts, y: p.usd })));
      lineChart($('#chart'), pts, { marks: d.capital_flows || [], fmtY: usdAxis, fmtTip: usdTip });
      // the change over the range from trading only: the capital added or paid out inside it is taken out
      const a = pts[0], z = pts[pts.length - 1], fl = (d.capital_flows || []).filter((f) => f.ts > a.ts && f.ts <= z.ts).reduce((t, f) => t + f.usd, 0), ch = z.y - a.y - fl;
      const since = chartDays && ws.wh[0].ts > Date.now() - chartDays * 864e5 ? ` · reports start ${fmtDay(ws.wh[0].ts)}` : '';
      clear(note).append(el('strong', { class: cls(ch) }, `${fmtUsd(ch, true)} (${fmtPct(a.y > 0 ? (ch / a.y) * 100 : 0, true)})`), ` from trading ${chartDays ? `in the last ${RANGE_NAME[chartDays]}` : 'since the first report'}${fl ? `, not counting ${fmtUsd(fl, true)} capital` : ''} · ${fmtUsd(z.y)} now, every live trading account added together${since}.`);
    } else if (chartKind === 'perf' && ws) {
      const pts = inRange(ws.adj), ch = pts[pts.length - 1].y - pts[0].y;
      lineChart($('#chart'), pts.map((p) => ({ ts: p.ts, y: p.y - pts[0].y })), { fmtY: (v) => `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, fmtTip: (v) => fmtUsd(v, true) });
      clear(note).append(el('strong', { class: cls(ch) }, `${fmtUsd(ch, true)} (${fmtPct(pts[0].y > 0 ? (ch / pts[0].y) * 100 : 0, true)})`), ` from trading ${chartDays ? `in the last ${RANGE_NAME[chartDays]}` : 'since the first report'}. Every live trading account added together, with deposits and payouts taken out: only trading moves this line.`);
    } else if (chartKind === 'daily') {
      // the result of each day, the live bots added together (dollars where every bot shares them, else R)
      const byDay = new Map();
      for (const b of livePresent()) for (const r of (b.perf && b.perf.periods && b.perf.periods.day) || []) {
        const a = byDay.get(r.key) || { key: r.key, trades: 0, wins: 0, r: 0, usd: null };
        a.trades += r.trades; a.wins += r.wins; a.r += r.r; if (r.usd != null) a.usd = (a.usd || 0) + r.usd; byDay.set(r.key, a);
      }
      const cut = chartDays ? Date.now() - chartDays * 864e5 : 0;
      const rows = [...byDay.values()].filter((r) => Date.parse(`${r.key}T00:00:00Z`) >= cut).sort((a, b) => (a.key < b.key ? -1 : 1)).map((r) => ({ ...r, r: Math.round(r.r * 100) / 100 }));
      barChart($('#chart'), rows, 'No closed live trades in this range.');
      const tot = rows.reduce((a, r) => a + r.r, 0);
      note.textContent = rows.length ? `Result of each day, the live bots added together · ${fmtR(tot)} over ${rows.reduce((a, r) => a + r.trades, 0)} trades. R is each strategy's own risk unit. Hover a bar for the day.` : '';
    } else {
      clear($('#chart')).append(el('div', { class: 'empty' }, none)); note.textContent = '';
    }
  }
  // positions of the live bots, in one table (T-CORE's show their current trailing stop)
  function openRows(bots) { return bots.flatMap((b) => b.open_list.map((p) => ({ ...p, bot: b.label, botKey: b.key }))); }
  const botName = (r) => el('span', { class: 'botname', 'data-bot': r.botKey }, el('i', { class: 'bdot' }), r.bot);
  function renderOpenAll() {
    const bots = LIVE.map(bd), rows = openRows(bots.filter((b) => b.present && b.mode === 'live'));
    $('#openCount').textContent = rows.length ? `${rows.length} open` : '';
    const host = clear($('#open'));
    host.append(table([
      { h: 'Bot', left: true, f: botName }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) },
      { h: 'Stop', f: (r) => (r.trail_stop != null ? el('span', { title: 'trailing stop, as it is now' }, fmtPx(r.trail_stop), ' ↗') : fmtPx(r.sl)) },
      { h: 'Now', f: (r) => fmtPx(r.price) }, { h: 'R now', f: (r) => (r.current_r == null ? '—' : fmtR(r.current_r)), c: (r) => cls(r.current_r) }, { h: 'Held', f: (r) => fmtDur((Date.now() - r.entry_ts) / 1000) },
    ], rows, 'No open positions on the live bots. Flat and waiting for signals.'));
    const off = bots.filter((b) => !b.present || b.mode !== 'live').map((b) => `${b.label} ${b.present ? 'is in paper mode' : 'has not reported'}`);
    if (off.length) host.append(el('p', { class: 'muted note' }, `Positions of ${off.join(', ')} are not shown.`));
  }
  function renderLatest() {
    const bots = livePresent(), rows = bots.flatMap((b) => withUsd(b.trades).map((t) => ({ ...t, bot: b.label, botKey: b.key }))).sort((a, b) => b.exit_ts - a.exit_ts).slice(0, 15), hasUsd = rows.some((t) => t.usd != null);
    $('#latestCount').textContent = rows.length ? `newest ${rows.length}` : '';
    clear($('#latest')).append(table([
      { h: 'Closed', left: true, f: (r) => fmtShort(r.exit_ts) }, { h: 'Bot', left: true, f: botName }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) },
      { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => (r.usd == null ? '—' : r.est ? el('span', { class: 'est', title: 'Estimated from the nearest booked trade with the same result' }, fmtUsd(r.usd, true)) : fmtUsd(r.usd, true)), c: (r) => cls(r.usd) }] : []), { h: 'Held', f: (r) => fmtDur(r.hold_sec) },
    ], rows, 'No closed live trades yet.', openTrade));
  }
  // combined health: each live bot, the recorder and the wallet reports
  function healthRow(name, key, h, detail) { return el('div', { class: 'hrow' }, el('i', { class: `dot ${h.state}` }), el('span', { class: 'hn', 'data-bot': key }, name), hchip(h), el('span', { class: 'hd' }, detail)); }
  function renderHealthStrip() {
    const d = data, host = clear($('#healthStrip'));
    for (const k of LIVE) {
      const b = bd(k), h = health(b), u = b.uptime;
      host.append(healthRow(b.label, k, h, b.present && b.hb != null ? [ago(b.hb), u ? ` · ${u.uptime_pct.toFixed(1)}% up (7d)` : '', b.kill ? ' · KILL SWITCH' : ''] : h.note));
    }
    const rc = d.recorder, wc = d.wallet_capital;
    host.append(healthRow('Data recorder', '', rc ? { state: rc.alive ? 'healthy' : 'stale', label: rc.alive ? 'HEALTHY' : 'STALE' } : { state: 'missing', label: 'MISSING' }, rc ? ago(rc.ts) : 'not reporting'));
    const wAge = wc ? Date.now() - wc.newest_ms : null;
    host.append(healthRow('Wallet reports', '', !wc ? { state: 'missing', label: 'MISSING' } : wAge > 30 * 60000 ? { state: 'stale', label: 'STALE' } : { state: 'healthy', label: 'HEALTHY' }, wc ? [ago(wc.newest_ms), wc.missing.length ? ` · ${wc.missing.join(', ')} missing` : ''] : 'no wallet report yet'));
  }

  // ---------------- a bot's workspace: Dashboard ----------------
  const worst = (list) => list.reduce((w, l) => ({ stop: 2, warn: 1 }[l] > ({ stop: 2, warn: 1 }[w] || 0) ? l : w), 'ok');
  // open positions of one bot: compact on the Dashboard, with target, risk and trailing-stop detail on Positions & Activity
  function openTable(b, full) {
    if (!b.present) return el('div', { class: 'empty' }, `${b.label} ${health(b).note}: its positions are unknown.`);
    const rows = b.open_list, trailing = rows.some((r) => r.trail_stop != null);
    return table([
      { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) },
      { h: trailing ? 'Stop now' : 'Stop', f: (r) => fmtPx(r.trail_stop != null ? r.trail_stop : r.sl) },
      ...(full ? [{ h: 'Target', f: (r) => (r.tp == null ? 'none' : fmtPx(r.tp)) }] : []),
      { h: 'Now', f: (r) => fmtPx(r.price) }, { h: 'R now', f: (r) => (r.current_r == null ? '—' : fmtR(r.current_r)), c: (r) => cls(r.current_r) },
      ...(trailing ? [{ h: 'Locked R', f: (r) => (r.locked_r == null ? '—' : fmtR(r.locked_r)), c: (r) => cls(r.locked_r) }, { h: 'Best R', f: (r) => (r.best_r == null ? '—' : fmtR(r.best_r)) }, ...(full ? [{ h: 'Stop moves', f: (r) => r.trail_moves ?? '—' }] : [])] : []),
      ...(full ? [{ h: 'Initial SL', f: (r) => fmtPx(r.sl) }, { h: 'Risk', f: (r) => (r.risk_pct == null ? '—' : `${+(r.risk_pct * 100).toFixed(2)}%`) }, { h: 'Opened', left: true, f: (r) => fmtShort(r.entry_ts) }] : []),
      { h: 'Held', f: (r) => fmtDur((Date.now() - r.entry_ts) / 1000) },
    ], rows, 'No open positions. Flat and waiting for a signal.');
  }
  function latestTable(b, n) {
    const rows = withUsd(b.trades).sort((a, c) => c.exit_ts - a.exit_ts).slice(0, n), hasUsd = rows.some((t) => t.usd != null);
    return table([
      { h: 'Closed', left: true, f: (r) => fmtShort(r.exit_ts) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) },
      { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => (r.usd == null ? '—' : r.est ? el('span', { class: 'est', title: 'Estimated from the nearest booked trade with the same result' }, fmtUsd(r.usd, true)) : fmtUsd(r.usd, true)), c: (r) => cls(r.usd) }] : []),
    ], rows, b.present ? 'No closed trades yet.' : `${b.label} ${health(b).note}.`, openTrade);
  }
  function renderBotDash() {
    const b = bd(route.bot), h = health(b), cap = b.capital, p = b.perf, o = p ? p.overall : b.overall, st = b.overall, k = clear($('#bKpis'));
    $('#bChartTitle').textContent = `${b.label} · performance`;
    if (!b.present) k.append(el('div', { class: 'kpi notice' }, el('div', { class: 'k' }, b.label), el('div', { class: 'mid' }, hchip(h)), el('div', { class: 'sub' }, `${b.label} ${h.note}. Its balance, results and positions appear here as soon as it reports; no figure is shown as zero in the meantime.`)));
    else {
      const bal = capOf(b), sub = [];
      if (cap) sub.push(el('span', { class: cls(cap.change_usd) }, `${fmtUsd(cap.change_usd, true)} (${fmtPct(cap.change_pct, true)})`), ` since start ${fmtUsd(cap.start_usd)}`, cap.net_flows_usd ? ` · excl. ${fmtUsd(cap.net_flows_usd, true)} capital` : '');
      else sub.push('No balance series received for this bot.');
      const spk = el('div', { class: 'spark' });
      k.append(el('div', { class: 'kpi hero-kpi' }, el('div', { class: 'k' }, b.live ? 'Balance' : 'Paper balance', ' ', modeTag(b.mode)), el('div', { class: 'big' }, bal == null ? na('No wallet report or live balance received for this bot') : fmtUsd(bal)), el('div', { class: 'sub' }, sub), spk));
      spark(spk, cap ? cap.points.map((q) => q.usd) : []);
      const twr = cap && cap.twr_pct != null ? cap.twr_pct : null;
      k.append(kpiCard('Time-weighted return', twr == null ? na('Needs at least two balance readings') : fmtPct(twr, true), twr == null ? 'Needs two balance readings.' : 'trading only, capital added or paid out is not counted', cls(twr)),
        kpiCard('Result', fmtR(st.total_r), `${o.usd != null ? fmtUsd(o.usd, true) + ' · ' : ''}${st.trades} closed · ${b.open_list.length} open`, cls(st.total_r)),
        kpiCard('Win rate · PF', st.trades ? `${pct0(st.win_rate)} · ${st.profit_factor ?? '—'}` : '—', st.trades ? `${st.wins}W / ${st.trades - st.wins}L · avg ${fmtR(st.avg_r)}` : 'No closed trades yet.'));
      const pct = b.dd != null && b.halt ? Math.min(100, (b.dd / Math.abs(b.halt)) * 100) : null, bar = el('i');
      bar.style.setProperty('width', `${pct || 0}%`);
      k.append(el('div', { class: 'kpi' }, el('div', { class: 'k' }, 'Drawdown vs halt'), el('div', { class: 'mid' }, pct == null ? na('No drawdown figure reported yet') : `${Number(b.dd).toFixed(1)}R / ${Math.abs(b.halt)}R`), el('div', { class: `meter${pct >= 60 ? ' hot' : ''}` }, bar), el('div', { class: 'sub' }, pct == null ? 'No heartbeat yet.' : `${pct.toFixed(0)}% of the halt · worst ${Number(st.max_dd_r ?? 0).toFixed(1)}R`)));
    }
    renderBotChart(); renderRisk(b);
    $('#bOpenCount').textContent = b.open_list.length ? `${b.open_list.length} open` : '';
    clear($('#bOpen')).append(openTable(b, false));
    $('#bLatestCount').textContent = b.trades.length ? `newest ${Math.min(8, b.trades.length)} of ${b.trades.length}` : '';
    clear($('#bLatest')).append(latestTable(b, 8));
    renderOperational(b, h);
  }
  // the bot's own curve: balance, balance with capital movements taken out, cumulative R, drawdown
  function renderBotChart() {
    if (!data) return;
    const b = bd(route.bot), cap = b.capital, host = $('#bChart'), note = $('#bChartNote');
    for (const x of $$('#bRangeTabs button')) { const on = +x.dataset.range === chartDays; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); }
    for (const x of $$('#bChartTabs button')) { const on = x.dataset.bchart === bchartKind; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); }
    const noBal = `Unavailable: ${b.label} has not shared a balance series${b.live ? ' (the combined live capital is on the Overview)' : ''}.`;
    const noSeries = !(cap && cap.points && cap.points.length), tr = eqTrades(b.trades);
    if ((bchartKind === 'balance' || bchartKind === 'perf') && noSeries && tr.length) {
      // this bot shares no balance series: its curve is the running total of its closed trades (by P&L where the trades carry dollars, else R)
      const usd = tr.some((t) => t.usd != null);
      drawEquity(host, note, b.trades, usd, chartDays, `No balance series from ${b.label}: its closed trades instead, ${usd ? 'by P&L' : 'by R'}. `);
    } else if (bchartKind === 'balance') {
      lineChart(host, inRange(cap ? cap.points.map((p) => ({ ts: p.ts, y: p.usd })) : []), { marks: cap ? cap.flows : [], fmtY: (v) => `$${v.toFixed(v >= 1000 ? 0 : 2)}`, fmtTip: usdTip, empty: noBal });
      note.textContent = cap ? `${b.label} balance ${fmtUsd(cap.usd)} as of ${fmtTime(cap.as_of)} · ${fmtUsd(cap.change_usd, true)} (${fmtPct(cap.change_pct, true)}) since ${fmtUsd(cap.start_usd)}${cap.net_flows_usd ? ` · capital added or paid out (${fmtUsd(cap.net_flows_usd, true)}) is not counted as profit` : ''}${b.live ? '' : ' · paper money'}` : '';
    } else if (bchartKind === 'perf') {
      lineChart(host, inRange(cap && cap.perf_points ? cap.perf_points.map((p) => ({ ts: p.ts, y: p.usd })) : []), { fmtY: (v) => `$${v.toFixed(v >= 1000 ? 0 : 2)}`, fmtTip: usdTip, empty: noBal });
      note.textContent = cap ? `Balance with deposits and payouts taken out: only trading moves this line · ${fmtUsd(cap.change_usd, true)} (${fmtPct(cap.change_pct, true)}) since start${cap.twr_pct != null ? ` · time-weighted return ${fmtPct(cap.twr_pct, true)}` : ''}` : '';
    } else if (bchartKind === 'r') {
      const cv = rCurve(b.trades);
      lineChart(host, inRange(cv.map((p) => ({ ts: p.ts, y: p.r_cum }))), { fmtY: (v) => `${v.toFixed(1)}R`, fmtTip: (v) => `${v.toFixed(2)}R` });
      note.textContent = cv.length ? `${b.label} cumulative R over ${b.overall.trades} closed trades: ${fmtR(b.overall.total_r)}` : '';
    } else {
      const cv = rCurve(b.trades);
      lineChart(host, inRange(cv.map((p) => ({ ts: p.ts, y: p.dd_r }))), { dd: true, fmtY: (v) => `${v.toFixed(1)}R`, fmtTip: (v) => `${v.toFixed(2)}R` });
      note.textContent = cv.length ? `Max drawdown ${Number(b.overall.max_dd_r).toFixed(1)}R · now ${Number(cv[cv.length - 1].dd_r).toFixed(1)}R · halt at ${b.halt != null ? Math.abs(b.halt) : '—'}R` : '';
    }
  }
  function renderRisk(b) {
    const host = clear($('#bRisk')), lvl = clear($('#bRiskLvl')), p = b.perf;
    if (!b.present) { host.append(el('div', { class: 'empty' }, `${b.label} ${health(b).note}: no risk figures yet.`)); return; }
    if (p) lvl.append(lvlChip(p.verdict === 'ok' ? 'ok' : p.verdict));
    const rule = (id) => (p ? p.checks.find((c) => c.id === id) : null), pct = b.dd != null && b.halt ? Math.min(100, (b.dd / Math.abs(b.halt)) * 100) : null, bar = el('i');
    bar.style.setProperty('width', `${pct || 0}%`);
    const r = riskOf(b), open = b.open_list.reduce((a, x) => a + (Number.isFinite(x.risk_pct) ? x.risk_pct : 0), 0), bal = capOf(b);
    host.append(el('dl', { class: 'kvlist' },
      kv('Drawdown now vs halt', pct == null ? na('No drawdown figure reported yet') : `${Number(b.dd).toFixed(1)}R / ${Math.abs(b.halt)}R`, pct == null ? null : el('small', {}, `${pct.toFixed(0)}% of the halt`)),
      kv('Worst drawdown so far', `${Number(b.overall.max_dd_r || 0).toFixed(1)}R`, p && p.expect.max_dd_r ? el('small', {}, `backtest ${p.expect.max_dd_r}R`) : null),
      kv('Review line', rule('drawdown') ? String(rule('drawdown').limit) : na('This bot has no drawdown rule')),
      kv('Losing streak', p ? `${p.overall.current_losing} now` : '—', p ? el('small', {}, `longest ${p.overall.longest_losing}${p.expect.longest_losing ? ` · backtest ${p.expect.longest_losing}` : ''}`) : null),
      kv('Risk per trade', r == null ? '—' : `${+(r * 100).toFixed(2)}%`, r != null && bal != null ? el('small', {}, `≈ ${fmtUsd(r * bal)} of ${fmtUsd(bal)}`) : null),
      kv('Open risk', b.open_list.length ? `${+(open * 100).toFixed(2)}%` : 'flat', b.open_list.length ? el('small', {}, `${b.open_list.length} position${b.open_list.length === 1 ? '' : 's'} at their first stops${b.open_list.some((x) => x.trail_stop != null) ? '; trailing stops lower it' : ''}`) : null),
      kv('Kill switch', el('span', { class: b.kill ? 'bad' : 'good' }, b.kill ? 'ON · no new entries' : 'off'))));
    host.append(el('div', { class: `meter risk${pct >= 60 ? ' hot' : ''}` }, bar));
    const bad = p ? p.checks.filter((c) => c.level === 'warn' || c.level === 'stop') : [];
    host.append(bad.length ? el('div', { class: 'checklist' }, bad.map((c) => el('div', { class: `ck ${c.level}` }, lvlChip(c.level), el('div', { class: 'ck-b' }, el('div', { class: 'ck-t' }, c.title, el('span', { class: 'ck-v' }, c.value ?? '—')), el('div', { class: 'ck-n' }, `limit ${c.limit}${c.note ? ' · ' + c.note : ''}`)))))
      : el('p', { class: 'muted note' }, p ? 'Every stop-and-review rule is inside its limit.' : 'No rule analysis yet.'));
  }
  // one summary sentence and one list: what the bot is doing right now
  function renderOperational(b, h) {
    const s = b.status, text = clear($('#bNow')), box = clear($('#bSys'));
    $('#bStateDot').className = `live-dot ${h.state === 'healthy' ? 'ok' : h.state === 'missing' ? '' : 'bad'}`;
    nowSentence(b, h, text);
    if (!b.present) return;
    const exec = Math.max(b.last_entry_ms || 0, b.last_exit_ms || 0) || null;
    box.append(kv('Last heartbeat', b.hb != null ? fmtHm(b.hb) + tzTag() : '—', b.hb != null ? ago(b.hb) : null), kv('Last execution', exec ? fmtShort(exec) + tzTag() : 'none yet', exec ? ago(exec) : null),
      kv('Enabled coins', b.coins.map(sym).join(' · ') || '—'), kv('Mode', String(b.mode).toUpperCase()), kv('Build', s.commit || s.version ? `${s.commit || '?'} · v${s.version || '?'}` : '—'));
  }
  const renderBotPerf = () => { renderPerf(); renderTrend(); renderCoins(); };

  // ---------------- Performance: coins, trend capture ----------------
  // One row per coin for the selected bot: what triggers it, trades, wins, losses, returns, and whether it is open now. Built from the trades the page already has (per_coin of lib/perf.js),
  // so it costs no extra request. A coin with no trade yet still gets its row (zeros).
  const STRATS = {
    bbcore: { name: 'BB-Core', short: 'Bollinger breakout, no target', how: 'A 4-hour candle closes outside its Bollinger band (20, 2σ) in the direction of the 200-period average. Stop at the middle band, no profit target: the trade runs until the stop or about 8 days at most.' },
    tcore: { name: 'T-CORE', short: 'Bollinger breakout, 14 ATR trail', how: 'Enters like BB-Core (a 4-hour close outside the Bollinger band, with the 200-period average). Stop 2 ATR away, then a trailing stop 14 ATR behind the best price; no profit target, so a winner runs until the trail catches it.' },
    icore: { name: 'I-Core', short: 'Ichimoku cloud', how: 'A 4-hour candle closes through the Ichimoku cloud, after not being outside it, in the direction of the 200-period average. Stop 2 ATR away, then a trailing stop 7 ATR behind the best price; no profit target.' },
    bb1h: { name: 'BB-1h lab', short: 'BB-Core rules on 1-hour candles (paper)', how: 'The BB-Core rules on 1-hour candles, five coins, paper only: a test of whether a faster version is worth trading, judged against its own backtest.' },
    bbn: { name: 'BB-CORE news lab', short: 'BB-Core 4h + news gate (paper)', how: 'The BB-Core 4h rules, paper only, with the news gate in front of every new entry: no new entry in the 8 hours before a CPI / jobs / FOMC / PCE / PPI release, and no new long within 3 days of a $1M+ hack on the coin’s own chain. The gate can only skip an entry, never open one. Compared with live BB-Core in the News Lab.' },
    icn: { name: 'I-CORE news lab', short: 'I-Core + news gate (paper)', how: 'The I-Core rules, paper only, with the news gate in front of every new entry (see BB-CORE news lab). Compared with live I-Core in the News Lab.' },
    cbb: { name: 'BB-CORE coin lab', short: 'BB-Core 4h on ARB only (paper)', how: 'The BB-Core 4h rules, unchanged, on ARB only, paper only: a forward test of ARB as a new BB-CORE coin before any real money. Judged against its own ARB backtest (May 2023 to Nov 2026: about 4 trades a month, 36% winners, +0.23R a trade).' },
    ctc: { name: 'T-CORE coin lab', short: 'T-CORE on SUI + ARB only (paper)', how: 'The T-CORE rules (2 ATR stop, 14 ATR trail), unchanged, on SUI and ARB only, paper only: a forward test of both as new T-CORE coins. Judged against its own backtest on those coins (May 2023 to Nov 2026: about 3.6 trades a month, 23% winners, +0.65R a trade). I-CORE gets no new coin: it did worse with both.' },
    tcn: { name: 'T-CORE news lab', short: 'T-CORE + news gate (paper)', how: 'The T-CORE rules, paper only, with the news gate in front of every new entry. Compared with the T-CORE paper bot: same engine, same paper costs, so any difference is the gate.' },
  };
  const full = (c) => (/_USDT$/.test(c) ? c : `${c}_USDT`);
  function renderCoins() {
    const b = bd(curKey()), p = b.perf, host = clear($('#coinRecord')), rows = [];
    if (p && b.present) {
      const coins = [...new Set([...Object.keys(p.per_coin), ...b.coins.map(full), ...b.open_list.map((o) => o.symbol)])].sort();
      const last = new Map(); for (const t of b.trades) if (!last.has(t.symbol) || t.exit_ts > last.get(t.symbol)) last.set(t.symbol, t.exit_ts);
      const zero = { trades: 0, wins: 0, losses: 0, win_rate: null, avg_r: null, total_r: 0, profit_factor: null, best_r: null, worst_r: null, max_dd_r: null, usd: null };
      for (const c of coins) rows.push({ coin: c, ...zero, ...(p.per_coin[c] || {}), last: last.get(c) || null, open: b.open_list.find((o) => o.symbol === c) || null });
      rows.push({ coin: 'ALL', ...zero, ...p.overall, last: p.last_ts, open: null, openN: b.open_list.length, _cls: 'total' });
    }
    $('#coinCount').textContent = rows.length ? `${rows.length - 1} coin rows` : '';
    const hasUsd = rows.some((r) => r.usd != null);
    const cols = [
      { h: 'Coin', left: true, f: (r) => (r.coin === 'ALL' ? el('strong', {}, 'Total') : sym(r.coin)) }, { h: 'Trades', f: (r) => r.trades }, { h: 'Wins', f: (r) => r.wins, c: (r) => (r.wins ? 'good' : '') }, { h: 'Losses', f: (r) => r.losses, c: (r) => (r.losses ? 'bad' : '') },
      { h: 'Win', f: (r) => pct0(r.win_rate) }, { h: 'Avg R', f: (r) => fmtR(r.avg_r), c: (r) => cls(r.avg_r) }, { h: 'Total R', f: (r) => fmtR(r.total_r), c: (r) => cls(r.total_r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => fmtUsd(r.usd, true), c: (r) => cls(r.usd) }] : []),
      { h: 'PF', f: (r) => (r.profit_factor == null ? '—' : r.profit_factor) }, { h: 'Best', f: (r) => fmtR(r.best_r) }, { h: 'Worst', f: (r) => fmtR(r.worst_r) }, { h: 'Max DD', f: (r) => (r.max_dd_r == null ? '—' : `${r.max_dd_r}R`) },
      { h: 'Last trade', f: (r) => (r.last ? fmtDay(r.last) : '—') },
      { h: 'Open now', f: (r) => (r.coin === 'ALL' ? (r.openN ? `${r.openN} open` : 'flat') : r.open ? el('span', {}, sideEl(r.open.side), ' ', el('span', { class: cls(r.open.current_r) }, r.open.current_r == null ? '' : fmtR(r.open.current_r))) : '—') },
    ];
    if (rows.length) host.append(el('div', { class: `bot-block ${b.key}` }, el('div', { class: 'bot-block-h' }, STRATS[b.key].name, el('small', {}, ` · ${STRATS[b.key].short}`)), el('div', { class: 'scroll' }, table(cols, rows, ''))));
    else host.append(el('div', { class: 'empty' }, b.present ? 'No coins yet.' : `${b.label} ${health(b).note}.`));
    clear($('#coinNote')).append(el('p', { class: 'muted' }, STRATS[b.key].how), el('p', { class: 'muted' }, 'Wins and losses are counted per closed trade (a trade that ends at 0R counts as a loss). R is the amount risked on one trade. Each coin trades one position at a time.'));
  }
  // trend-follower figures against the strategy's own backtest (T-CORE): how far trades ran, how much the trail gave back
  function trendTable(t, live) {
    const e = t.expect || {}, pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`), r = (x) => (x == null ? '—' : fmtR(x));
    const row = (k, a, x) => el('tr', {}, el('td', {}, k), el('td', { class: 'num' }, a), el('td', { class: 'num muted' }, x));
    return el('table', { class: 'mini' }, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'num' }, live ? 'live' : 'lab'), el('th', { class: 'num' }, 'backtest'))), el('tbody', {},
      row('Reached +1R', pc(t.reached_1r), pc(e.reached_1r)), row('Reached +3R', pc(t.reached_3r), pc(e.reached_3r)), row('Reached +5R', pc(t.reached_5r), pc(e.reached_5r)), row('Reached +10R', pc(t.reached_10r), pc(e.reached_10r)),
      row('Best price (MFE), median', r(t.mfe_median), r(e.mfe_median)), row('Worst price (MAE), median', r(t.mae_median), r(e.mae_median)), row('Given back to the trail, median', r(t.gave_back_median), r(e.gave_back_median)),
      row('Candles held, median', t.bars_median ?? '—', e.bars_median ?? '—'), row('Stop moves, median', t.trail_moves_median ?? '—', '—'), row('Funding per trade', t.funding_r_avg == null ? '—' : fmtR(t.funding_r_avg), 'flat estimate'), row('Slippage in+out', t.slip_bp_avg == null ? '—' : `${t.slip_bp_avg} bp`, '4 bp')));
  }
  function renderTrend() {
    const b = bd(curKey()), panel = $('#pTrend'), t = b.trend;
    panel.classList.toggle('off', !t);
    if (!t) return;
    $('#trendCount').textContent = `${t.trades} closed trade${t.trades === 1 ? '' : 's'} with trend data`;
    const host = clear($('#trend')), p = b.perf, avgHold = p ? p.overall.avg_hold_sec : null;
    host.append(el('div', { class: 'trendgrid' },
      el('div', {}, el('h4', {}, `Against its own backtest (2020-2026, same rules)`), t.trades ? trendTable(t, b.live) : el('div', { class: 'empty' }, 'No closed trade with trend data yet.'),
        el('p', { class: 'muted note' }, 'R here is the initial risk (entry to the first stop). With about 21% winners, totals mean little before about 100 trades; how far trades run and how much the trail gives back show earlier whether it behaves like the backtest.')),
      el('div', {}, el('h4', {}, 'Open trades and their trailing stop'),
        b.open_list.length ? table([{ h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'Initial SL', f: (r) => fmtPx(r.sl) }, { h: 'Stop now', f: (r) => (r.trail_stop == null ? '—' : fmtPx(r.trail_stop)) },
          { h: 'Locked R', f: (r) => (r.locked_r == null ? '—' : fmtR(r.locked_r)), c: (r) => cls(r.locked_r) }, { h: 'Best R', f: (r) => (r.best_r == null ? '—' : fmtR(r.best_r)) }, { h: 'Moves', f: (r) => r.trail_moves ?? '—' }, { h: 'Held', f: (r) => fmtDur((Date.now() - r.entry_ts) / 1000) }], b.open_list, '')
          : el('div', { class: 'empty' }, 'No open trade right now.'),
        el('dl', { class: 'kvlist', style: 'margin-top:12px' }, kv('Average hold, closed trades', avgHold == null ? '—' : fmtDur(avgHold), el('small', {}, 'entry to exit')), kv('Funding per trade', t.funding_r_avg == null ? '—' : fmtR(t.funding_r_avg)), kv('Slippage in + out', t.slip_bp_avg == null ? '—' : `${t.slip_bp_avg} bp`)))));
  }

  // ---------------- Positions & Activity ----------------
  function renderPositions() {
    const b = bd(route.bot);
    $('#openFullCount').textContent = b.open_list.length ? `${b.open_list.length} open` : '';
    clear($('#openFull')).append(openTable(b, true));
    $('#openFullNote').textContent = b.open_list.length ? 'Now = the close of the last 4-hour candle the bot has seen, so the R shown can be hours old. For a trailing-stop bot, Stop now is the stop as it is now and Initial SL is the first stop.' : '';
    renderActivity(b); renderSkipped(b);
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
    renderEquity(v);
    $('#perfNote').textContent = `${v.label} ${v.mode === 'live' ? 'live' : 'paper'} results against ${e.source}. Single trades swing from −1R to several R, so about 150 or more trades are needed before the average says anything; until then this page shows whether live behaves like the backtest.`;
    renderPeriods(p);
    renderBreakdown(p);
    renderExec(p);
    const rl = p.rolling;
    if (rl) {
      lineChart($('#rolling'), rl.points, { fmtY: (x) => `${x.toFixed(0)}R`, fmtTip: (x) => `${x.toFixed(2)}R`, hline: rl.stop_r });
      $('#rollingNote').textContent = `Sum of the last ${rl.n} trades after each trade. The dashed line is the stop-and-review line (${rl.stop_r}R).`;
    } else {
      clear($('#rolling')).append(el('div', { class: 'empty' }, p.bot === 'icore' ? 'I-Core is a trend follower with few, large winners: a rolling window says little, so it is judged on drawdown and streaks.' : `Shown from trade ${50} on (now ${o.trades}).`));
      $('#rollingNote').textContent = '';
    }
  }
  // The strategy's equity curve: the running total of its closed trades, one step per trade at the time it closed, by R or by P&L (dollars, where the trades carry them).
  // A range starts the curve at 0 at its first day, so the line shows what that period did. Trading results only: capital moves never enter it. The same plain line
  // as the Overview's capital curve. Used by the Performance card and, for a bot that shares no balance series, by the Dashboard chart.
  const eqTrades = (list) => (list || []).filter((t) => t && t.exit_ts != null && Number.isFinite(+t.r)).slice().sort((a, b) => a.exit_ts - b.exit_ts);
  function drawEquity(host, note, list, usd, days, lead = '') {
    const trades = eqTrades(list), val = (t) => (usd ? Number(t.usd) || 0 : Number(t.r));
    const start = days ? Date.now() - days * 864e5 : -Infinity, inside = trades.filter((t) => t.exit_ts >= start);
    if (!inside.length) { clear(host).append(el('div', { class: 'empty' }, trades.length ? 'No closed trades in this range.' : 'No closed trades yet.')); note.textContent = ''; return; }
    const first = inside[0], from = days ? Math.min(start, first.exit_ts) : (first.entry_ts != null ? Math.min(first.entry_ts, first.exit_ts) : first.exit_ts - 36e5);
    let cum = 0;
    const pts = [{ ts: from, y: 0 }, ...inside.map((t) => { cum += val(t); return { ts: t.exit_ts, y: Math.round(cum * 1e4) / 1e4, t }; })];
    const num = (x) => Math.abs(Math.round(x * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const fmtV = usd ? (x) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${num(x)}` : (x) => `${x < 0 ? '−' : x > 0 ? '+' : ''}${num(x)}R`;
    lineChart(host, pts, { fmtY: fmtV, tipOf: (p) => (p.t
      ? `${fmtTime(p.ts)} · ${sym(p.t.symbol)} ${p.t.side || ''} · ${p.t.reason || 'closed'} · ${usd ? fmtV(Number(p.t.usd) || 0) : fmtV(Number(p.t.r))} → total ${fmtV(p.y)}`
      : `${fmtTime(p.ts)} · start of the range · 0`) });
    const wins = inside.filter((t) => Number(t.r) > 0).length, peak = pts.reduce((m, p) => Math.max(m, p.y), 0);
    clear(note).append(lead, el('strong', { class: cls(cum) }, fmtV(cum)), ` over ${inside.length} closed trade${inside.length === 1 ? '' : 's'}${days ? ` in the last ${({ 1: 'day', 7: 'week', 30: 'month', 91: '3 months' })[days] || days + ' days'}` : ' since the first'} · ${wins} win${wins === 1 ? '' : 's'}, ${inside.length - wins} not · ${cum < peak - 1e-9 ? `${fmtV(cum - peak)} below its high` : 'at its high'}. Hover the line for each trade.`);
  }
  function renderEquity(v) {
    const hasUsd = eqTrades(v.trades).some((t) => t.usd != null);
    if (eqMetric === 'usd' && !hasUsd) eqMetric = 'r';
    for (const b of $$('#eqMetric button')) { const on = b.dataset.eqm === eqMetric; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.hidden = b.dataset.eqm === 'usd' && !hasUsd; }
    for (const b of $$('#eqRange button')) { const on = +b.dataset.eqr === eqDays; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    drawEquity($('#eqChart'), $('#eqNote'), v.trades, eqMetric === 'usd', eqDays);
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
  // Trades with no booked dollar result get an estimate from the nearest booked trade (in time) with the same outcome, win or loss: a stop within 0.1R of it takes its dollar figure as is, anything else is scaled by R.
  function withUsd(list) {
    const real = list.filter((t) => t.usd != null && t.r && Math.abs(t.r) > 0.2);
    return list.map((t) => {
      if (t.usd != null || t.r == null || !real.length) return t;
      const same = real.filter((x) => (x.r > 0) === (t.r > 0)), pool = same.length ? same : real;
      const n = pool.reduce((b, x) => (Math.abs(x.exit_ts - t.exit_ts) < Math.abs(b.exit_ts - t.exit_ts) ? x : b));
      return { ...t, usd: Math.abs(t.r - n.r) <= 0.1 ? n.usd : Math.round(t.r * (n.usd / n.r) * 100) / 100, est: true };
    });
  }
  function renderTrades() {
    if (!data) return;
    const b = bd(curKey()), all = withUsd(b.trades), f = filters;
    const coinSel = $('#fCoin'), coins = [...new Set(all.map((t) => t.symbol))].sort();
    if ([...coinSel.options].slice(1).map((o) => o.value).join() !== coins.join()) { clear(coinSel).append(el('option', { value: '' }, 'All'), ...coins.map((c) => el('option', { value: c }, sym(c)))); coinSel.value = coins.includes(f.coin) ? f.coin : (f.coin = ''); }
    const rs = $('#fReason'), reasons = [...new Set(all.map((t) => t.reason).filter(Boolean))].sort();
    if ([...rs.options].slice(1).map((o) => o.value).join() !== reasons.join()) { clear(rs).append(el('option', { value: '' }, 'All'), ...reasons.map((r) => el('option', { value: r }, r))); rs.value = reasons.includes(f.reason) ? f.reason : (f.reason = ''); }
    const from = f.from ? Date.parse(f.from + 'T00:00:00Z') : null, to = f.to ? Date.parse(f.to + 'T23:59:59Z') : null, q = f.q.trim().toLowerCase();
    const hay = (t) => `${sym(t.symbol)} ${t.symbol} ${t.side} ${t.reason} ${fmtDay(t.exit_ts)} ${fmtDay(t.entry_ts)} ${fmtR(t.r)}`.toLowerCase();
    const rows = all.filter((t) => (!f.coin || t.symbol === f.coin) && (!f.side || t.side === f.side) && (!f.reason || t.reason === f.reason) && (from == null || t.exit_ts >= from) && (to == null || t.exit_ts <= to) && (!q || q.split(/\s+/).every((w) => hay(t).includes(w)))).sort((a, c) => c.exit_ts - a.exit_ts);
    const total = rows.reduce((a, t) => a + t.r, 0), hasUsd = rows.some((t) => t.usd != null), usd = rows.reduce((a, t) => a + (t.usd || 0), 0), wins = rows.filter((t) => t.r > 0).length;
    clear($('#tradeSummary')).append(`${b.label} · ${rows.length} trade${rows.length === 1 ? '' : 's'} · ${rows.length ? Math.round((wins / rows.length) * 100) : 0}% won · total `, el('span', { class: cls(total) }, fmtR(total)), hasUsd ? el('span', { class: cls(usd) }, ` (${fmtUsd(usd, true)})`) : '');
    const page = rows.slice(0, shown.trades);
    clear($('#trades')).append(table([
      { h: 'Exit time', left: true, f: (r) => fmtShort(r.exit_ts) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) }, { h: 'TP', f: (r) => fmtPx(r.tp) },
      { h: 'Exit', f: (r) => fmtPx(r.exit) }, { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => (r.usd == null ? '—' : r.est ? el('span', { class: 'est', title: 'Estimated from the nearest booked trade with the same result' }, fmtUsd(r.usd, true)) : fmtUsd(r.usd, true)), c: (r) => cls(r.usd) }] : []), { h: 'Held', f: (r) => fmtDur(r.hold_sec) },
    ], page, all.length ? 'No trades match.' : b.present ? 'No closed trades yet.' : `${b.label} ${health(b).note}.`, openTrade));
    moreBtn($('#tradesMore'), 'trades', rows.length, renderTrades);
  }

  // ---------------- Calendar: the result of each day (the day a trade CLOSED) for the selected bot and mode, paper or live, in the zone chosen in the menu ----------------
  const BR = window.BotResearch;
  let calMonth = null, calDay = null, calMetric = store.get('bot.calmetric') === 'usd' ? 'usd' : 'r', calSeen = '';
  const fmtCal = (v, metric) => (v == null ? '' : metric === 'usd' ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 2)}` : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`);
  const tint = (host, v, max) => { if (!v || !max) return; const p = Math.round(14 + 52 * Math.min(1, Math.abs(v) / max)); host.style.setProperty('background', `color-mix(in srgb, var(${v > 0 ? '--up' : '--down'}) ${p}%, transparent)`); };
  const nTrades = (n) => `${n} trade${n === 1 ? '' : 's'}`;

  function renderCalendar() {
    if (!data) return;
    const v = view(), days = BR.dailyMap(v.trades, tz), months = BR.monthsWithData(days), now = BR.dayParts(Date.now(), tz);
    // a different bot, mode or time zone starts at the latest month with trades (or this month when there are none)
    const sig = `${v.key}|${v.mode}|${tz}`;
    if (!calMonth || calSeen !== sig) {
      calSeen = sig; const last = months.length ? months[months.length - 1] : null;
      calMonth = last ? { y: +last.slice(0, 4), m: +last.slice(5) - 1 } : { y: now.y, m: now.m }; calDay = null;
    }
    const grid = BR.monthGrid(days, calMonth.y, calMonth.m), tot = grid.total;
    const hasUsd = [...days.values()].some((d) => d.usd != null), metric = hasUsd ? calMetric : 'r';
    for (const b of $$('#calMetric button')) { b.classList.toggle('on', b.dataset.metric === metric); b.disabled = b.dataset.metric === 'usd' && !hasUsd; b.title = b.disabled ? 'Money amounts are not shared for this data' : ''; }
    $('#calTitle').textContent = `${MONTHS_LONG[calMonth.m]} ${calMonth.y}`;
    // a day's or total's value in the chosen metric; a day with no money figure falls back to R
    const pick = (x) => (metric === 'usd' && x.usd != null ? { v: x.usd, m: 'usd' } : { v: x.r, m: 'r' });
    const show = (x) => { const p = pick(x); return fmtCal(p.v, p.m); };
    const hasLoss = tot.worst && tot.worst.r < 0, hasWin = tot.best && tot.best.r > 0;
    clear($('#calSummary')).append(
      tile('Month result', tot.days ? show(tot) : '—', tot.days ? (pick(tot).m === 'usd' ? fmtR(tot.r) : tot.usd != null ? fmtUsd(tot.usd, true) : nTrades(tot.n)) : 'no closed trades', tot.days ? cls(tot.r) : ''),
      tile('Trades', String(tot.n), tot.days ? `on ${tot.days} day${tot.days === 1 ? '' : 's'}` : null),
      tile('Winning days', tot.days ? `${tot.win_days} of ${tot.days}` : '—', tot.days ? `${tot.loss_days} losing` : null),
      tile('Best day', hasWin ? show(tot.best) : '—', hasWin ? periodLabel(tot.best.key) : null, hasWin ? 'good' : ''),
      tile('Worst day', hasLoss ? show(tot.worst) : '—', hasLoss ? periodLabel(tot.worst.key) : null, hasLoss ? 'bad' : ''));

    const max = Math.max(0, ...grid.weeks.flatMap((w) => w.cells).filter((c) => c.stat).map((c) => Math.abs(pick(c.stat).v)));
    const todayKey = `${now.y}-${pad(now.m + 1)}-${pad(now.d)}`;
    const head = el('div', { class: 'calrow calhead' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => el('div', {}, d)), el('div', { class: 'wk' }, 'Week'));
    const body = grid.weeks.map((w) => el('div', { class: 'calrow' },
      w.cells.map((c) => {
        const sel = c.stat && calDay === c.key, val = c.stat ? pick(c.stat).v : null;
        const cell = el(c.stat ? 'button' : 'div', { class: `cal ${c.inMonth ? '' : 'out'} ${c.stat ? 'has' : ''} ${sel ? 'sel' : ''} ${c.key === todayKey ? 'today' : ''}`, type: c.stat ? 'button' : null,
          'aria-label': c.stat ? `${periodLabel(c.key)}: ${fmtR(c.stat.r)}, ${nTrades(c.stat.n)}` : null },
          el('span', { class: 'dn' }, c.day),
          c.stat ? [el('span', { class: `dv ${cls(val)}` }, show(c.stat)), el('span', { class: 'dt' }, nTrades(c.stat.n))] : null);
        if (c.stat) { tint(cell, val, max); cell.addEventListener('click', () => { calDay = c.key; renderCalendar(); }); }
        return cell;
      }),
      el('div', { class: `wk ${cls(w.total.r)}` }, w.total.n ? [el('b', {}, show(w.total)), el('small', {}, nTrades(w.total.n))] : el('span', { class: 'muted' }, '·'))));
    clear($('#calGrid')).append(head, ...body);
    $('#calNote').textContent = `Each trade counts on the day it closed (${tz === 'utc' ? 'UTC' : 'your local time'}). Green = net profit that day, red = net loss; a deeper colour means a bigger day. ${v.label} · ${v.mode === 'live' ? 'live data.' : 'paper data (simulated money).'}${!hasUsd ? ' Money amounts are not shared for this data, so the calendar shows R.' : ''}`;

    // the selected day (default: the latest day with trades in this month)
    const pre = `${calMonth.y}-${pad(calMonth.m + 1)}-`;
    const inMonth = [...days.values()].filter((d) => d.key.startsWith(pre)).sort((a, b) => a.key.localeCompare(b.key));
    if (!calDay || !days.has(calDay) || !calDay.startsWith(pre)) calDay = inMonth.length ? inMonth[inMonth.length - 1].key : null;
    const dayBox = clear($('#calDay')), dd = calDay ? days.get(calDay) : null;
    $('#calDayTitle').textContent = dd ? `day / ${periodLabel(calDay)}` : 'day / trades';
    if (!dd) dayBox.append(el('div', { class: 'empty' }, 'No closed trades this month.'));
    else dayBox.append(el('p', { class: 'summary' }, `${nTrades(dd.n)} · `, el('span', { class: cls(dd.r) }, fmtR(dd.r)), dd.usd != null ? el('span', { class: cls(dd.usd) }, ` (${fmtUsd(dd.usd, true)})`) : '', ` · ${dd.wins}W / ${dd.losses}L`),
      table([{ h: 'Closed', left: true, f: (r) => fmtHm(r.exit_ts) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) },
        { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) }, ...(dd.usd != null ? [{ h: 'P&L', f: (r) => fmtUsd(r.usd, true), c: (r) => cls(r.usd) }] : [])], dd.trades, '', openTrade),
      el('p', { class: 'muted note' }, 'Click a trade for its full card.'));

    // the year, month by month
    const ym = BR.yearMonths(days, calMonth.y), ymax = Math.max(0, ...ym.map((m) => Math.abs(m.r || 0)));
    $('#calYearTitle').textContent = `year / ${calMonth.y} by month`;
    clear($('#calYear')).append(table([
      { h: 'Month', left: true, f: (m) => (m.month === calMonth.m ? el('b', {}, MONTHS_LONG[m.month]) : MONTHS_LONG[m.month]) },
      { h: 'Trades', f: (m) => m.n || '·' }, { h: 'Win days', f: (m) => (m.days ? `${m.win_days}/${m.days}` : '·') },
      { h: 'Net R', f: (m) => (m.days ? fmtR(m.r) : '·'), c: (m) => cls(m.r) }, ...(hasUsd ? [{ h: 'Net $', f: (m) => (m.usd == null ? '·' : fmtUsd(m.usd, true)), c: (m) => cls(m.usd) }] : []),
      { h: '', f: (m) => { const b = el('i', { class: m.r < 0 ? 'neg' : '' }); b.style.setProperty('width', `${ymax && m.days ? Math.max(4, Math.round((Math.abs(m.r) / ymax) * 100)) : 0}%`); return el('span', { class: 'ytrack' }, b); } },
    ], ym, '', (m) => { calMonth = { y: calMonth.y, m: m.month }; calDay = null; renderCalendar(); }));
  }
  function stepMonth(delta) { if (!calMonth) return; const d = new Date(Date.UTC(calMonth.y, calMonth.m + delta, 1)); calMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; calDay = null; renderCalendar(); }
  $('#calPrev').addEventListener('click', () => stepMonth(-1));
  $('#calNext').addEventListener('click', () => stepMonth(1));
  $('#calToday').addEventListener('click', () => { calSeen = ''; renderCalendar(); });
  $('#calMetric').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; calMetric = b.dataset.metric; store.set('bot.calmetric', calMetric); renderCalendar(); });

  // ---------------- Research: how the run works and what it has done so far, in enough detail to decide whether the strategy is ready to go live ----------------
  // (coin / side / exit splits and the fills-vs-model table already live on the Performance page; this page adds what they do not show)
  // T-CORE: how it works, how its trades run against its own backtest (trend capture), and the open trades with their CURRENT trailing stop
  function trailHow(b, live) {
    const t = (b && b.trend) || { trades: 0 }, e = t.expect || {}, pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`), r = (x) => (x == null ? '—' : fmtR(x));
    const row = (k, a, x) => el('tr', {}, el('td', {}, k), el('td', { class: 'num' }, a), el('td', { class: 'num muted' }, x));
    const open = (b && b.open_list) || [];
    return [
      el('p', {}, el('b', {}, live ? 'A live trend-follower on its own MEXC account. ' : 'A paper trend-follower with real-world costs. '), "T-CORE enters exactly like BB-Core (a 4h close outside the Bollinger band, with the 200 average) but exits differently: a stop 2 ATR away that trails 14 ATR behind the best price, with no target and no time limit. Most trades lose about 1R; a few ride a trend for weeks. " + (live ? 'Orders are real; the stop lives on MEXC and the bot moves it.' : 'No order is ever sent.')),
      el('p', { class: 'muted' }, "It will not take the same trades as BB-Core: each bot holds one position per coin, and T-CORE stays in a trade much longer, so it skips signals BB-Core takes and the other way round. It is checked every day against its OWN backtest on the same candles (the comparison below), never against BB-Core's trades. Costs are real: whole contracts, the order book's fill, the coin's fee, MEXC's settled funding."),
      el('h4', {}, `Trend capture: ${t.trades} closed trade${t.trades === 1 ? '' : 's'} vs its backtest (2020-2026, same rules)`),
      el('table', { class: 'mini' }, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', { class: 'num' }, live ? 'live' : 'lab'), el('th', { class: 'num' }, 'backtest'))), el('tbody', {},
        row('Reached +1R', pc(t.reached_1r), pc(e.reached_1r)), row('Reached +3R', pc(t.reached_3r), pc(e.reached_3r)), row('Reached +5R', pc(t.reached_5r), pc(e.reached_5r)), row('Reached +10R', pc(t.reached_10r), pc(e.reached_10r)),
        row('Best price, median', r(t.mfe_median), r(e.mfe_median)), row('Worst price, median', r(t.mae_median), r(e.mae_median)), row('Given back to the trail, median', r(t.gave_back_median), r(e.gave_back_median)),
        row('Candles held, median', t.bars_median ?? '—', e.bars_median ?? '—'), row('Stop moves, median', t.trail_moves_median ?? '—', '—'), row('Funding per trade', t.funding_r_avg == null ? '—' : fmtR(t.funding_r_avg), 'flat estimate'), row('Slippage in+out', t.slip_bp_avg == null ? '—' : `${t.slip_bp_avg} bp`, '4 bp'))),
      el('p', { class: 'muted' }, 'R here is the initial risk (entry to the first stop). With 21% winners, totals mean little before about 100 trades; how far trades run and how much the trail gives back show earlier whether it behaves like the backtest.'),
      open.length ? el('ul', {}, ...open.map((p) => el('li', {}, el('b', {}, `${sym(p.symbol)} ${p.side}: `), p.trail_stop != null ? `stop now ${p.trail_stop} (locks ${fmtR(p.locked_r)}), best so far ${fmtR(p.best_r)}, moved ${p.trail_moves}×` : 'waiting for the first heartbeat with its stop'))) : el('p', { class: 'muted' }, 'No open trade right now.'),
    ];
  }
  function renderResearch() {
    if (!data) return;
    const d = data, v = view(), tr = v.trades, lab = v.key === 'bb1h', b = v.b.present && v.key !== 'bbcore' ? v.b : null, live = v.mode === 'live';   // b: this bot's own data
    const o = BR.summarize(tr), ex = BR.execution(tr), eg = BR.edge(tr);
    const open = v.b.open_list, skipCounts = v.b.skip_counts || {}, firstEvent = v.b.first_ms;
    const cmp = v.b.compare, ddR = v.b.dd, haltR = v.b.halt;
    $('#rHowTitle').textContent = `research / how ${v.label} ${live ? 'trades live' : 'paper trading works'}`;

    const first = tr.length ? Math.min(...tr.map((t) => t.entry_ts)) : null, skips = Object.values(skipCounts).reduce((a, x) => a + x, 0), running = firstEvent != null ? (Date.now() - firstEvent) / 1000 : null;
    clear($('#rRun')).append(
      tile('Running for', running != null ? fmtDur(running) : '—', firstEvent != null ? `since ${fmtShort(firstEvent)}${tzTag()}` : 'no events yet'),
      tile('Closed trades', String(o.n), first ? `first entry ${fmtShort(first)}` : 'none yet'),
      tile('Open now', String(open.length), open.length ? open.map((p) => `${sym(p.symbol)} ${p.side}`).join(', ') : 'flat'),
      tile('Signals skipped', String(skips), skips ? Object.entries(skipCounts).map(([k, x]) => `${k} ${x}`).join(' · ') : 'none'),
      tile('Net result', fmtR(o.total_r), o.usd != null ? fmtUsd(o.usd, true) : nTrades(o.n), cls(o.total_r)));
    clear($('#rHow')).append(...(live && v.key === 'tcore' ? trailHow(b, true) : live ? [
      el('p', {}, el('b', {}, 'This bot trades real money on MEXC. '), 'The same detail is kept as for a paper run, so the live record can be compared with what paper and the backtest showed.'),
      el('p', { class: 'muted' }, 'Fees, slippage and funding on live trades are what MEXC actually charged. Skipped signals are kept with the reason.'),
    ] : lab ? [
      el('p', {}, el('b', {}, 'A paper run with real-world costs. '), 'The 1h bot reads the real candles and takes the same decisions as the strategy, but no order is ever sent. The only simulated thing is the money; what each trade would cost is taken from MEXC itself:'),
      el('ul', {},
        el('li', {}, el('b', {}, 'Size: '), 'whole contracts, rounded exactly like the live bot. A coin whose single contract would risk too much is skipped, as live would.'),
        el('li', {}, el('b', {}, 'Entry: '), 'a market order walks the real order book at that moment, so the fill is the volume-weighted price of the levels it would eat.'),
        el('li', {}, el('b', {}, 'Fees: '), "the coin's own taker rate from MEXC's contract list (never below 0.02%, so a promotional 0% is not counted as free)."),
        el('li', {}, el('b', {}, 'Stops: '), 'a stop is a market order in a fast market: its slippage is the bad case (90th percentile) measured by the data recorder, not the average.'),
        el('li', {}, el('b', {}, 'Funding: '), "MEXC's real settled funding rate for every 8-hour settlement the trade was open through: paid by longs when positive, received by shorts."),
        el('li', {}, el('b', {}, 'Skipped signals '), 'are kept with the reason, so nothing is hidden.')),
      el('p', { class: 'muted' }, 'Any data MEXC fails to give falls back to a fixed assumption and says so on that trade. A paper run proves the bot executes the way the backtest assumes with these costs. It cannot prove the strategy makes money: that takes hundreds of trades, which is why the range around the average is shown.'),
    ] : [
      el('p', {}, el('b', {}, 'Paper means simulated money, real market. '), 'The bot reads the real candles and takes the same decisions as the live bot, but no order is ever sent. It starts with a pretend balance and sizes each trade on it.'),
      el('ul', {},
        el('li', {}, el('b', {}, 'Entry: '), 'when a candle closes with a signal, the bot fills at the price it sees when it wakes up, a couple of seconds into the next candle. If it is late, the result shows it (price vs candle open and delay below).'),
        el('li', {}, el('b', {}, 'Exit: '), 'at the stop, at the target if there is one, or at the time limit, checked against the real candles.'),
        el('li', {}, el('b', {}, 'Costs: '), 'fees and slippage are an estimate. Paper has ', el('b', {}, 'no funding charge'), ', so real results run a little lower than paper.'),
        el('li', {}, el('b', {}, 'Skipped signals '), 'are kept with the reason (too late, halted, kill switch), so nothing is hidden.')),
      el('p', { class: 'muted' }, 'A paper run proves the bot executes the way the backtest assumes. It cannot prove the strategy makes money: that takes hundreds of trades, which is why the range around the average is shown.'),
    ]));

    // ready for live?
    const mark = { pass: '✓', fail: '✗', wait: '…', info: 'i' }, label = { pass: 'OK', fail: 'FAILING', wait: 'WAITING FOR DATA', info: '' };
    const checks = BR.readiness(tr, { compare: cmp, drawdownR: ddR, haltR, skipCompare: lab });
    const rd = clear($('#rReady'));
    rd.append(...checks.map((c) => el('div', { class: `chk ${c.status}` }, el('span', { class: 'mk', 'aria-hidden': 'true' }, mark[c.status]),
      el('div', {}, el('div', { class: 'ct' }, c.title, ' ', el('span', { class: 'cs' }, label[c.status])), el('div', { class: 'cn' }, `Needs: ${c.need}. Now: ${c.have}.`), el('div', { class: 'cn' }, c.note)))));
    rd.append(el('p', { class: 'muted note' }, `${checks.filter((c) => c.status === 'pass').length} of ${checks.length} checks OK. These show the bot executes the way the backtest assumes; they do not prove the strategy makes money, and they are separate from the stop-and-review rules on a live bot's Verification page. Going live also needs its own risk review.`));

    // is there an edge yet?
    const f3 = (x) => (x == null ? '—' : Number(x).toFixed(3)), edgeBox = clear($('#rEdge'));
    edgeBox.append(el('dl', { class: 'kvlist' },
      kv('Average per trade', eg.mean == null ? '—' : el('span', { class: cls(eg.mean) }, fmtR(eg.mean)), eg.half != null ? el('small', {}, `likely between ${fmtR(eg.lo)} and ${fmtR(eg.hi)} (95%)`) : null),
      kv('Average win · loss', o.n ? `${o.avg_win_r != null ? fmtR(o.avg_win_r) : '—'} · ${o.avg_loss_r != null ? fmtR(o.avg_loss_r) : '—'}` : '—'),
      kv('Price vs candle open', ex.slippage_r.n ? `${f3(ex.slippage_r.avg)}R avg` : '—', ex.slippage_r.n ? el('small', {}, `worst ${f3(ex.slippage_r.max)}R · best ${f3(ex.slippage_r.min)}R (+ means worse)`) : null),
      kv('Delay after the open', ex.delay_sec.n ? `${Math.round(ex.delay_sec.median)}s median` : '—', ex.delay_sec.n ? el('small', {}, `90% within ${Math.round(ex.delay_sec.p90)}s · slowest ${Math.round(ex.delay_sec.max)}s`) : null),
      kv('Fees + slippage', ex.cost_r.n ? `${f3(ex.cost_r.avg)}R avg` : '—', ex.cost_r.n ? el('small', {}, 'limit used in the checks: 0.07R') : null),
      kv('Signal margin', ex.near_thr_pct.n ? `${Number(ex.near_thr_pct.median).toFixed(2)}% median` : '—', ex.near_thr_pct.n ? el('small', {}, 'how far past its trigger the price was; small = a marginal signal') : null)));
    edgeBox.append(el('p', { class: 'muted note' }, eg.half == null ? 'Too few trades to estimate a range yet.'
      : eg.excludes_zero ? `With ${eg.n} trades the range ${eg.mean > 0 ? 'stays above' : 'stays below'} zero, but trade results swing a lot: keep collecting before trusting it.`
      : `With only ${eg.n} trades the range still includes zero (it is about ±${eg.half}R wide), so the average cannot yet tell a real edge from luck. That is normal this early.`));

    // result per trade
    const h = BR.histogram(tr), hmax = Math.max(1, ...h.map((x) => x.n)), hb = clear($('#rHist'));
    if (!tr.length) hb.append(el('div', { class: 'empty' }, 'No closed trades yet.'));
    else hb.append(...h.map((x) => { const bar = el('i'); bar.style.setProperty('height', `${(x.n / hmax) * 100}%`); return el('div', { class: `hcol ${x.hi <= 0 ? 'neg' : x.lo >= 0 ? 'pos' : ''}`, title: nTrades(x.n) }, el('span', { class: 'hn' }, x.n || ''), el('div', { class: 'hbar' }, bar), el('span', { class: 'hl' }, x.label.replace(' to ', '…'))); }));
    $('#rHistNote').textContent = tr.length ? 'How many trades ended in each result band. Left of zero are losses; a few big wins usually carry a strategy like this.' : '';

    // when it trades
    const cols = (first) => [
      { h: first, left: true, f: (r) => r.key }, { h: 'Trades', f: (r) => r.n }, { h: 'Win', f: (r) => pct0(r.win_rate) },
      { h: 'Avg R', f: (r) => fmtR(r.avg_r), c: (r) => cls(r.avg_r) }, { h: 'Total R', f: (r) => fmtR(r.total_r), c: (r) => cls(r.total_r) }];
    const split = (title, rows, first) => el('div', { class: 'split' }, el('div', { class: 'sub-h first' }, title), el('div', { class: 'scroll' }, table(cols(first), rows, 'No trades yet.')));
    const skipRows = Object.entries(skipCounts).sort((a, c) => c[1] - a[1]).map(([k, x]) => ({ key: k, n: x }));
    clear($('#rSplit')).append(
      split(`Day of entry${tzTag()}`, BR.byWeekday(tr, tz), 'Day'), split(`Hour of entry${tzTag()}`, BR.byHourBlock(tr, tz), 'Hours'), split('Time in trade', BR.byHold(tr), 'Held'),
      el('div', { class: 'split' }, el('div', { class: 'sub-h first' }, 'Signals not taken'), el('div', { class: 'scroll' }, table([{ h: 'Reason', left: true, f: (r) => r.key }, { h: 'Count', f: (r) => r.n }], skipRows, 'None skipped.'))));

    // journal
    const rows = [...tr].sort((a, c) => c.exit_ts - a.exit_ts), hasUsd = rows.some((t) => t.usd != null);
    $('#rTradeCount').textContent = nTrades(rows.length);
    clear($('#rTrades')).append(table([
      { h: 'Closed', left: true, f: (r) => fmtShort(r.exit_ts) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) },
      { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'Exit', f: (r) => fmtPx(r.exit) }, { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) },
      { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) }, ...(hasUsd ? [{ h: 'P&L', f: (r) => (r.usd == null ? '—' : fmtUsd(r.usd, true)), c: (r) => cls(r.usd) }] : []),
      { h: 'Delay', f: (r) => (r.delay_sec == null ? '—' : `${Math.round(r.delay_sec)}s`) }, { h: 'Slip', f: (r) => (r.slippage_r == null ? '—' : `${r.slippage_r.toFixed(3)}R`) },
      { h: 'Held', f: (r) => fmtDur(r.hold_sec) },
    ], rows.slice(0, shown.journal), 'No closed trades yet. They appear here as the bot closes them.', openTrade));
    moreBtn($('#rTradesMore'), 'journal', rows.length, renderResearch);
  }

  // ---------------- Research: the market now (regime), what trading costs here (measured slippage), and the data recorder's health. All from the recorder's heartbeat (d.recorder) ----------------
  let regimeHist = null, regimeHistTried = false;
  async function loadRegimeHistory() {   // the strategy's backtest by regime: a small static file next to the page, read once
    if (regimeHistTried) return; regimeHistTried = true;
    try { const res = await fetch('regime-history.json', { cache: 'no-cache' }); if (res.ok) { regimeHist = await res.json(); if (data && viewKey() === 'lab:market') renderRegime(); } } catch { /* the panel just shows no history */ }
  }
  const STATE_LABEL = { trending_up: 'Trending up', trending_down: 'Trending down', volatile: 'Volatile', quiet: 'Quiet (squeeze)', ranging: 'Ranging (chop)', choppy: 'Choppy', mixed: 'Mixed' };
  const stateChip = (s) => (s ? el('span', { class: `rg ${s}` }, STATE_LABEL[s] || s) : '—');
  const histOf = (key, group) => { const h = regimeHist && regimeHist[group] && regimeHist[group][key]; return h && h.n >= (regimeHist.min_trades || 30) ? h : null; };

  function renderRegime() {
    const rc = data && data.recorder;
    // no recorder report: say so (the panels stay, a missing recorder is not a quiet page)
    if (!rc) { clear($('#rgTiles')).append(el('div', { class: 'empty' }, 'Unavailable: the data recorder is not reporting, so there is no market regime yet.')); clear($('#rgTable')); $('#rgNote').textContent = ''; clear($('#slipTable')).append(el('div', { class: 'empty' }, 'Unavailable: no order-book snapshots without the data recorder.')); $('#slipNote').textContent = ''; return; }
    const m = rc.market || {}, mh = histOf(rc.market_state, 'market_states');
    clear($('#rgTiles')).append(
      tile('The market now', stateChip(rc.market_state), mh ? `BB-Core there, historically: ${fmtR(mh.avg_r)} a trade (${mh.n} trades)` : null),
      tile('Coins moving together', m.avg_corr_7d == null ? '—' : m.avg_corr_7d.toFixed(2), m.avg_corr_7d == null ? null : m.avg_corr_7d >= 0.7 ? 'close to one bet: five trades may be one trade' : m.avg_corr_7d >= 0.4 ? 'moderately alike' : 'moving independently'),
      tile('Above their 800-hour average', m.breadth_up_pct == null ? '—' : `${m.breadth_up_pct}%`, m.n ? `of ${m.n} coins` : null),
      tile('Trending · ranging · quiet · volatile', m.n ? `${m.trending_n} · ${m.ranging_n} · ${m.quiet_n} · ${m.volatile_n}` : '—', 'coins in each state'));
    const rows = Object.entries(rc.regime || {}).map(([k, v]) => ({ coin: k, state: (rc.regime_state || {})[k], ...v }));
    clear($('#rgTable')).append(table([
      { h: 'Coin', left: true, f: (r) => sym(r.coin) }, { h: 'State', left: true, f: (r) => stateChip(r.state) },
      { h: 'vs 800 avg', f: (r) => (r.trend_pct == null ? '—' : `${r.trend_pct > 0 ? '+' : ''}${r.trend_pct}%`), c: (r) => cls(r.trend_pct) },
      { h: 'Trendiness', f: (r) => (r.er48 == null ? '—' : r.er48.toFixed(2)) }, { h: 'Band width', f: (r) => (r.bbw_pctile == null ? '—' : `${Math.round(r.bbw_pctile)}th pct`) },
      { h: 'ATR', f: (r) => (r.atr_pct == null ? '—' : `${r.atr_pct}%`) }, { h: 'Day swing', f: (r) => (r.rv24 == null ? '—' : `${r.rv24}%`) },
      { h: 'BB-Core in this state', f: (r) => { const h = histOf(r.state, 'states'); return h ? el('span', {}, el('span', { class: cls(h.avg_r) }, fmtR(h.avg_r)), el('small', { class: 'muted' }, ` · ${h.n} trades · ${pct0(h.win_rate)} won`)) : '—'; } },
    ], rows, 'No coin has enough history yet.'));
    const all = regimeHist && regimeHist.overall;
    $('#rgNote').textContent = `How to read it: "trending" = the price is going somewhere (trendiness 0.3 or more: 1 is a straight line, 0 is going nowhere); "quiet" = the band is in its narrowest fifth of 90 days, which is where breakouts start; "volatile" = the widest fifth. ${all ? `The last column is this strategy's own backtest since 2020 on MEXC candles (${regimeHist.overall.n} trades, ${fmtR(all.avg_r)} on average, fees and slippage but no funding), grouped by the state its coin was in when the signal came. ` : ''}Differences between states are small next to the swing of single trades (a few hundred trades per state at best), so this is context to read, not a rule to trade by.`;

    // what a market order costs here, measured
    const sl = rc.slippage || {}, srows = Object.entries(sl).map(([k, v]) => ({ coin: k, ...v }));
    const bp = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}`);
    clear($('#slipTable')).append(table([
      { h: 'Coin', left: true, f: (r) => sym(r.coin) }, { h: 'Spread', f: (r) => bp(r.sp) }, { h: 'Buy $100', f: (r) => bp(r.b100) }, { h: 'Buy $1,000', f: (r) => bp(r.b1000) },
      { h: 'Buy $5,000', f: (r) => bp(r.b5000) }, { h: 'Buy $20,000', f: (r) => bp(r.b20000) }, { h: 'Stop-out $1,000 (bad case)', f: (r) => bp(r.s1000p90) }, { h: 'Snapshots', f: (r) => r.n ?? '—' },
    ], srows, 'No order-book snapshots yet.'));
    $('#slipNote').textContent = 'Basis points (1 bp = 0.01% of the price) paid on top of the mid price by a market order, half the spread included; median of the last 7 days of order-book snapshots taken every 5 minutes. "Bad case" is the 90th percentile of a sell, the kind of fill a stop gets. The old paper model assumed a flat 2 bp per fill. A bigger order walks further down the book, which is how much size each coin can take.';
  }
  function renderRecorder(boxEl, noteEl) {   // the recorder's health, on the Research Lab's Market page and on the System Monitor
    const rc = data && data.recorder, box = clear(boxEl);
    if (!rc) { box.append(el('div', { class: 'empty' }, 'Missing: the data recorder is not reporting. It runs on the VPS (folder lucidio-recorder): once it is installed and has the dashboard address set, its regime, measured slippage and health appear here.')); noteEl.textContent = ''; return; }
    const h = rc.health || {}, agoOf = (ms) => (ms ? ago(ms) : el('small', {}, 'never'));
    box.append(el('dl', { class: 'kvlist' },
      kv('Recorder', el('span', { class: rc.alive ? 'good' : 'bad' }, rc.alive ? 'ONLINE' : 'STALE'), ago(rc.ts)),
      kv('Candles (1m, 1h, 4h)', agoOf(h.candles_ok_ms)), kv('Order books', agoOf(h.book_ok_ms)), kv('Funding rates', agoOf(h.funding_ok_ms)), kv('Regime', agoOf(h.regime_ok_ms)),
      kv('Data since', h.first_ms ? fmtDay(h.first_ms) : '—', h.archive_mb != null ? el('small', {}, `${h.archive_mb} MB on the server`) : null),
      kv('Gaps in the candles', el('span', { class: (h.holes_1h_7d || 0) + (h.holes_1m_24h || 0) ? 'warn' : 'good' }, `${h.holes_1h_7d ?? '?'} (1h, 7 days) · ${h.holes_1m_24h ?? '?'} (1m, 24 h)`)),
      kv('Errors in the last hour', el('span', { class: (h.errors_1h || 0) > 5 ? 'warn' : '' }, String(h.errors_1h ?? '?'))),
      kv('Server disk free', h.disk_free_gb == null ? '—' : el('span', { class: h.disk_low ? 'bad' : '' }, `${h.disk_free_gb} GB`), h.disk_low ? el('small', {}, 'recording is paused') : null),
      kv('Copy off the server', h.upload_on ? (h.upload_ok_ms ? agoOf(h.upload_ok_ms) : el('span', { class: 'warn' }, 'set up, not done yet')) : el('span', { class: 'warn' }, 'not set up'))));
    noteEl.textContent = h.upload_on ? '' : 'The recorded data is only on the VPS until a copy command is set (RECORDER_SYNC_CMD in /etc/lucidio-recorder.env): if the server were lost, so would the data.';
  }

  // one trade, every detail we have
  function openTrade(t) {
    const dlg = $('#tradeDlg'), body = clear($('#tradeBody')), none = (x, f) => (x == null ? '—' : f(x));
    $('#tradeDlgTitle').textContent = `${sym(t.symbol)} ${t.side} · ${fmtShort(t.entry_ts)}`;
    body.append(el('p', { class: 'nowtext' }, BR.describe(t)),
      el('div', { class: 'tiles' },
        tile('Result', fmtR(t.r), t.usd != null ? fmtUsd(t.usd, true) : 'money not shared', cls(t.r)),
        tile('Time in trade', fmtDur(t.hold_sec), `${fmtShort(t.entry_ts)} → ${fmtShort(t.exit_ts)}${tzTag()}`)),
      el('dl', { class: 'kvlist tradekv' },
        kv('Signal candle opened', t.signal_candle_open_ms != null ? fmtTime(t.signal_candle_open_ms) : '—'),
        kv('Price the signal wanted', none(t.intended, fmtPx)), kv('Price it filled at', fmtPx(t.entry)),
        kv('Delay after the open', none(t.delay_sec, (x) => `${Math.round(x)}s`)), kv('Price vs candle open', none(t.slippage_r, (x) => `${x.toFixed(3)}R`)),
        kv('Stop', fmtPx(t.sl)), kv('Target', t.tp == null ? 'none' : fmtPx(t.tp)), kv('Exit price', fmtPx(t.exit)), kv('Closed by', t.reason || '—'),
        kv('1R distance', none(t.one_r, fmtPx)), kv('Size', none(t.qty, (x) => `${fmtPx(x)} coins`)),
        kv('Risked', t.risk_usd != null ? `${fmtUsd(t.risk_usd)}${t.risk_pct != null ? ` (${+(t.risk_pct * 100).toFixed(2)}% of the balance)` : ''}` : t.risk_pct != null ? `${+(t.risk_pct * 100).toFixed(2)}% of the balance` : '—'),
        kv('Balance before · after', t.balance_used != null || t.balance_after != null ? `${none(t.balance_used, (x) => fmtUsd(x))} · ${none(t.balance_after, (x) => fmtUsd(x))}` : '—'),
        kv('Signal margin', none(t.near_thr_pct, (x) => `${Number(x).toFixed(3)}% past the trigger`)),
        kv('Fees (both sides)', t.fees_pct != null ? `${t.fees_pct.toFixed(3)}%${t.fees_r != null ? ` = ${t.fees_r.toFixed(3)}R` : ''}` : none(t.fees_r, (x) => `${x.toFixed(3)}R`)),
        kv('Slippage (both sides)', none(t.slip_pct, (x) => `${x.toFixed(3)}%`)),
        kv('Funding', t.costs_kind === 'estimate (paper)' ? 'not charged in this older paper model' : t.funding == null ? '—' : t.costs_kind === 'actual' ? fmtUsd(t.funding, true) : `${t.funding >= 0 ? '+' : ''}${Number(t.funding).toFixed(3)}R`),
        kv('Costs are', t.costs_kind === 'modelled (paper)' ? 'modelled from the real order book, fee list and funding' : t.costs_kind || '—')));
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  const closeTrade = () => { const dl = $('#tradeDlg'); if (dl.close) dl.close(); else dl.removeAttribute('open'); };
  $('#tradeClose').addEventListener('click', closeTrade);
  $('#tradeDlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeTrade(); });

  // ---------------- Verification: one bot's checks and its live-vs-backtest comparison (one panel each, no duplicates) ----------------
  function renderChecks() {
    const b = bd(route.bot), p = b.perf, box = clear($('#checks'));
    $('#checksTitle').textContent = `${b.label} · stop-and-review checks`;
    if (!b.present || !p) { box.append(el('div', { class: 'empty' }, b.present ? 'No data yet.' : `${b.label} ${health(b).note}.`)); return; }
    box.append(el('div', { class: 'sub-h first' }, `${b.label} · ${p.overall.trades} closed trades · `, lvlChip(p.verdict === 'ok' ? 'ok' : p.verdict)));
    box.append(el('div', { class: 'checklist' }, p.checks.map((c) => el('div', { class: `ck ${c.level}` }, lvlChip(c.level),
      el('div', { class: 'ck-b' }, el('div', { class: 'ck-t' }, c.title, el('span', { class: 'ck-v' }, c.value ?? '—')), el('div', { class: 'ck-n' }, `limit ${c.limit}${c.note ? ' · ' + c.note : ''}`))))));
    if (p.expect && p.expect.source) box.append(el('p', { class: 'muted note' }, `Expectations: ${p.expect.source}.`));
  }
  // A refused order (and the trade that follows from it) is listed as INFO: a missed trade, not a logic difference.
  const KIND = { 'exchange-refused': 'MISSED · exchange refused the order', 'follows-refused': 'FOLLOWS the refused trade', 'backtest-only': 'BACKTEST-ONLY · the backtest took it, the bot did not', 'live-only': 'LIVE-ONLY · the bot took it, the backtest did not', differs: 'DIFFERS · both took it, the result differs' };
  function renderCompare() {
    const b = bd(route.bot), c = clear($('#compare')), k = b.compare;
    if (!b.present) { c.append(el('div', { class: 'empty' }, `${b.label} ${health(b).note}.`)); return; }
    if (!k) { c.append(el('div', { class: 'empty' }, 'No comparison received yet (compare-live-vs-backtest.js --push).')); return; }
    const missed = k.refused || 0, explained = k.explained || 0;
    c.append(el('dl', { class: 'kvlist' },
      kv('Result', el('span', { class: k.match ? 'good' : 'bad' }, k.match ? 'MATCH' : 'NOT A MATCH'), missed ? ` · ${missed} missed (exchange refused)` : ''),
      kv('Window', `${fmtShort(k.window_from_ms)} → ${fmtShort(k.window_to_ms)}`),
      kv('Checked', fmtTime(k.ts), ago(k.ts)),
      kv('Trades', `${k.matched ?? 0} matched · ${k.live_only ?? 0} live-only · ${k.backtest_only ?? 0} backtest-only${explained ? ` · ${explained} explained` : ''}`),
      kv('Other', `${k.skipped_signals ?? 0} skipped · ${k.candle_diffs ?? 0} candle diffs · tol ${k.tolerance_r}R`)));
  }
  function renderCompareDetail() {
    const b = bd(route.bot), host = clear($('#compareDetail')), k = b.compare;
    if (!b.present || !k) { host.append(el('div', { class: 'empty' }, b.present ? 'No comparison run received yet.' : `${b.label} ${health(b).note}.`)); return; }
    const mm = k.mismatches || [], n = (kind) => mm.filter((m) => m.kind === kind).length;
    host.append(el('div', { class: 'tiles' },
      tile('Matched trades', String(k.matched ?? 0), 'live and backtest agree', 'good'), tile('Live-only', String(k.live_only ?? 0), 'the bot took it, the backtest did not', k.live_only ? 'warn' : ''),
      tile('Backtest-only', String(k.backtest_only ?? 0), 'the backtest took it, the bot did not', k.backtest_only ? 'warn' : ''), tile('Result differs', String(n('differs')), 'both took it, a different result', n('differs') ? 'warn' : ''),
      tile('Refused orders', String(k.refused || 0), 'missed trades: the exchange said no'), tile('Explained', String(k.explained || 0), 'refused orders and what follows from them')));
    host.append(el('div', { class: 'sub-h' }, 'Latest run · mismatches'));
    if (mm.length) host.append(el('div', { class: 'checklist' }, mm.map((m) => el('div', { class: `ck ${m.explained ? 'info' : 'warn'}` }, lvlChip(m.explained ? 'info' : 'warn'),
      el('div', { class: 'ck-b' }, el('div', { class: 'ck-t' }, el('span', {}, `${b.label} · ${sym(m.symbol)} `, sideEl(m.side), ` · candle ${fmtShort(m.signal_candle_open_ms)}`), el('span', { class: 'ck-v' }, m.nearest_threshold_pct == null ? '' : `near thr. ${Number(m.nearest_threshold_pct).toFixed(3)}%`)),
        el('div', { class: 'ck-n' }, `${KIND[m.kind] || m.kind} · ${m.why || ''}`))))));
    else host.append(el('div', { class: 'empty' }, 'No mismatches in the latest run.'));
    host.append(el('div', { class: 'sub-h' }, 'Recent comparison runs'), table([
      { h: 'Run', left: true, f: (r) => fmtShort(r.ts) }, { h: 'Result', f: (r) => el('span', { class: r.match ? 'good' : 'bad' }, r.match ? 'MATCH' : 'NOT A MATCH') },
      { h: 'Mismatches', f: (r) => r.mismatches.length }, { h: 'Of which explained', f: (r) => r.mismatches.filter((m) => m.explained).length },
      { h: 'Kinds', left: true, f: (r) => [...new Set(r.mismatches.map((m) => m.kind))].join(', ') || '—' },
    ], b.compares, 'No earlier runs.'));
  }

  // ---------------- activity and skipped signals (one bot's own) ----------------
  const logLine = (ts, tag, ...msg) => el('div', { class: 'ln' }, el('span', { class: 't' }, fmtShort(ts)), el('span', { class: `tag ${tag}` }, tag.toUpperCase()), el('span', { class: 'msg' }, ...msg));
  function actLine(a, pre) {
    const coin = a.symbol ? `${sym(a.symbol)} ` : '', p = pre ? [pre, ' '] : [];
    if (a.kind === 'entry') return logLine(a.ts, 'entry', ...p, coin, sideEl(a.side), ` filled @ ${fmtPx(a.entry)} · SL ${fmtPx(a.sl)} · TP ${fmtPx(a.tp)}${a.risk_usd != null ? ` · risk ${fmtUsd(a.risk_usd)}` : ''}`);
    if (a.kind === 'exit') return logLine(a.ts, 'exit', ...p, coin, sideEl(a.side), ` ${a.reason} @ ${fmtPx(a.exit)} → `, el('span', { class: cls(a.r) }, `${fmtR(a.r)}${a.usd != null ? ` (${fmtUsd(a.usd, true)})` : ''}`));
    if (a.kind === 'skip') return logLine(a.ts, 'skip', ...p, coin, sideEl(a.side), ` skipped: ${a.reason}${a.detail ? ` · ${a.detail}` : ''}`);
    if (a.kind === 'check') return logLine(a.ts, 'check', ...p, `check ${a.candle_ms ? fmtShort(a.candle_ms) : ''} processed · total ${fmtR(a.total_r)}${a.balance != null ? ` · bal ${fmtUsd(a.balance)}` : ''}`);
    if (a.kind === 'capital') return logLine(a.ts, 'capital', ...p, a.flow === 'payout' ? 'payout sent ' : 'capital added ', el('span', {}, fmtUsd(a.usd, true)), ' · not profit or loss');
    if (a.kind === 'compare') return logLine(a.ts, 'compare', ...p, 'live vs backtest ', el('span', { class: a.match ? 'good' : 'bad' }, a.match ? 'MATCH' : 'MISMATCH'), ` · ${a.matched ?? 0} matched${a.mismatches ? ` · ${a.mismatches} differ` : ''}`);
    return null;
  }
  function renderActivity(b) {
    const box = clear($('#activity')), out = [];
    if (b.hb != null) out.push(logLine(b.hb, b.alive ? 'check' : 'down', b.alive ? 'heartbeat ok' : 'last heartbeat received', b.status.next_wake_ms ? ` · next wake ${fmtHm(b.status.next_wake_ms)}` : ''));
    for (const a of b.activity) out.push(actLine(a));
    $('#actCount').textContent = `${b.activity.length} events`;
    if (!out.length) box.append(el('div', { class: 'empty' }, b.present ? 'Nothing logged yet.' : `${b.label} ${health(b).note}.`));
    else box.append(...out.filter(Boolean));
  }
  function renderSkipped(b) {
    const total = Object.values(b.skip_counts).reduce((a, x) => a + x, 0);
    $('#skipCount').textContent = total ? `${total} skipped in all` : '';
    clear($('#skipSummary')).append(...Object.entries(b.skip_counts).sort((a, c) => c[1] - a[1]).map(([k, x]) => el('span', { class: 'chip' }, `${reasonLabel(k)} ${x}`)));
    moreBtn($('#skippedMore'), 'skipped', b.skipped.length, () => renderSkipped(b));
    clear($('#skipped')).append(table([
      { h: 'Signal candle', left: true, f: (r) => fmtShort(r.signal_candle_open_ms) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) },
      { h: 'Reason', left: true, f: (r) => el('span', { class: 'chip' }, reasonLabel(r.reason)) }, { h: 'Detail', left: true, f: (r) => r.detail || '', c: () => 'wrap' },
    ], b.skipped.slice(0, shown.skipped), b.present ? 'No skipped signals.' : `${b.label} ${health(b).note}.`));
  }

  // ---------------- Health: one bot's heartbeat, execution, candles, uptime, connectivity ----------------
  // candle times: each coin's candle OPEN time; the bot checks it when it closes (4 hours later, 1 hour for the 1h lab)
  const candleClose = (b, v) => v + (b.key === 'bb1h' ? 36e5 : CANDLE_MS);
  function uptimeLines(u) {
    const lines = [];
    if (!u) return lines;
    for (const g of u.downtimes) lines.push({ ts: g.from, tag: 'down', text: g.ongoing ? `no heartbeat since ${fmtShort(g.from)} · ongoing ${fmtDur(g.dur_ms / 1000)}` : `${fmtShort(g.from)} → ${fmtHm(g.to)} · ${fmtDur(g.dur_ms / 1000)} without heartbeat` });
    const byDay = new Map();
    for (const r of u.restarts) { const k = fmtDay(r.ts); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r.ts); }
    for (const ts of byDay.values()) lines.push(ts.length === 1 ? { ts: ts[0], tag: 'restart', text: 'process restarted' } : { ts: Math.max(...ts), tag: 'restart', text: `${ts.length} restarts that day · ${fmtHm(Math.min(...ts))} → ${fmtHm(Math.max(...ts))}` });
    return lines.sort((a, b) => b.ts - a.ts);
  }
  function fillUp(bar, axis, u, now) {
    clear(bar); clear(axis); bar.classList.toggle('none', !u);
    if (!u) return;
    const span = Math.max(1, now - u.since_ms);
    for (const g of u.downtimes) {
      const i = el('i', { title: `${fmtTime(g.from)} → ${g.to ? fmtTime(g.to) : 'now'} (${fmtDur(g.dur_ms / 1000)})` });
      i.style.setProperty('left', `${Math.max(0, ((g.from - u.since_ms) / span) * 100)}%`); i.style.setProperty('width', `${Math.max(0.3, (g.dur_ms / span) * 100)}%`);
      bar.append(i);
    }
    axis.append(el('span', {}, fmtShort(u.since_ms)), el('span', {}, `${u.uptime_pct.toFixed(2)}% up`), el('span', {}, 'now'));
  }
  function nowSentence(b, h, text) {
    const s = b.status, span = (c, t) => el('span', { class: c }, t);
    if (!b.present) return add(text, `${b.label} ${h.note}.`);
    if (b.hb == null) return add(text, `The dashboard has not heard a heartbeat from ${b.label} yet.`);
    if (!b.alive) return add(text, span('bad', `${b.label} is ${h.label.toLowerCase()}. `), `Its last heartbeat was ${fmtDur((Date.now() - b.hb) / 1000)} ago (the limit is ${fmtDur(data.status.stale_after_ms / 1000)}). Check the VPS.`);
    return add(text, `${b.label} is `, el('b', { class: 'good' }, 'healthy'), ` in ${String(b.mode).toUpperCase()} mode. It last reported `, ago(b.hb),
      s.next_wake_ms ? [' and will look at the market again at ', el('b', {}, fmtShort(s.next_wake_ms) + tzTag()), ' (', until(s.next_wake_ms), ').'] : '.',
      b.open_list.length ? [' ', el('b', {}, `${b.open_list.length} position${b.open_list.length === 1 ? ' is' : 's are'} open`), ` (${b.open_list.map((p) => `${sym(p.symbol)} ${p.side}`).join(', ')}).`] : ' It is flat: no position open.',
      b.overall.trades ? ` ${b.overall.trades} closed trade${b.overall.trades === 1 ? '' : 's'}, ${fmtR(b.overall.total_r)} in total.` : ' No trade has been taken yet.',
      b.kill ? span('warn', ' The kill switch is ON: no new entries.') : '');
  }
  function renderHealth() {
    const b = bd(route.bot), h = health(b), s = b.status, u = b.uptime, box = clear($('#sys'));
    $('#hbDot').className = `live-dot ${h.state === 'healthy' ? 'ok' : h.state === 'missing' ? '' : 'bad'}`;
    nowSentence(b, h, clear($('#nowText')));
    if (b.present && b.hb != null) {
      const candles = Object.entries(s.last_candle_ms || {}), newest = candles.length ? Math.max(...candles.map(([, v]) => candleClose(b, v))) : null, exec = Math.max(b.last_entry_ms || 0, b.last_exit_ms || 0) || null;
      const pct = b.dd != null && b.halt ? Math.min(100, (b.dd / Math.abs(b.halt)) * 100) : null;
      box.append(
        kv('Last heartbeat', fmtHm(b.hb) + tzTag(), ago(b.hb)),
        kv('Next check', s.next_wake_ms ? fmtHm(s.next_wake_ms) + tzTag() : na('The bot did not report its next wake'), s.next_wake_ms ? until(s.next_wake_ms) : null),
        kv('Last execution', exec ? fmtShort(exec) + tzTag() : 'none yet', exec ? ago(exec) : el('small', {}, 'no entry or exit yet')),
        kv('Last candle checked', newest ? `closed ${fmtHm(newest)}` : na('The bot did not report its candles'), newest ? ago(newest) : null),
        kv('Uptime (7d)', u ? el('span', { class: u.uptime_pct >= 99 ? 'good' : u.uptime_pct >= 95 ? 'warn' : 'bad' }, `${u.uptime_pct.toFixed(2)}%`) : na('No heartbeat history yet'), s.uptime_sec != null ? el('small', {}, `process up ${fmtDur(s.uptime_sec)}`) : null),
        kv('Kill switch', el('span', { class: b.kill ? 'bad' : 'good' }, b.kill ? 'ON · no new entries' : 'off')),
        kv('Drawdown vs halt', pct == null ? na('No drawdown figure reported yet') : `${Number(b.dd).toFixed(1)}R / ${Math.abs(b.halt)}R`, pct == null ? null : el('small', {}, `${pct.toFixed(0)}% of the halt`)),
        kv('Enabled coins', b.coins.map(sym).join(' · ') || '—'),
        kv('Build', s.commit || s.version ? `${s.commit || '?'} · v${s.version || '?'}` : '—'));
      if (candles.length) box.append(kv('Candle per coin', candles.map(([c, v]) => `${sym(c)} ${fmtHm(candleClose(b, v))}`).join(' · ')));
    }
    $('#nowNote').textContent = 'The bot reports at every candle close, so these numbers can be hours old. The refresh icon at the top asks the bots for a fresh report: they check for a request about once a minute and answer straight away (never in the middle of a run).';
    fillUp($('#upBar'), $('#upAxis'), u, data.generated_at);
    const lines = uptimeLines(u), dn = clear($('#downs'));
    if (!lines.length) dn.append(el('div', { class: 'empty' }, u ? 'No downtime or restarts in the last 7 days.' : 'No heartbeat history yet.'));
    else dn.append(...lines.map((l) => logLine(l.ts, l.tag, l.text)));
    renderConn(b, h);
  }
  const WALLET_STALE_MS = 30 * 60000;
  function renderConn(b, h) {
    const host = clear($('#hConn')), w = b.live ? walletOf(b) : null, u = b.uptime;
    const row = (k, v, sub) => kv(k, v, sub);
    const items = [row('Heartbeat link', hchip(h), b.hb != null ? ago(b.hb) : null)];
    if (!b.live) items.push(row('Exchange account', 'none: a paper bot', el('small', {}, 'it sends no orders and has no wallet')));
    else if (!b.present) items.push(row('Wallet report', hchip({ state: 'missing', label: 'MISSING' })));
    else if (!w) items.push(row('Wallet report', hchip({ state: 'missing', label: 'MISSING' }), el('small', {}, `no wallet report for ${b.label} has reached the ledger`)));
    else {
      const age = Date.now() - w.as_of, wh = age > WALLET_STALE_MS ? { state: 'stale', label: 'STALE' } : { state: 'healthy', label: 'HEALTHY' };
      items.push(row('Wallet report', [hchip(wh), ' ', fmtUsd(w.usd)], ago(w.as_of)));
      const mine = b.open_list.length, theirs = w.open;
      items.push(row('Positions on the exchange', theirs == null ? na('The wallet report did not carry its open positions') : String(theirs),
        theirs == null ? null : theirs === mine ? el('small', {}, `matches the ${mine} the bot reports`) : el('small', { class: 'warn' }, `DIFFERS: the bot reports ${mine}`)));
      if (w.suspect) items.push(row('Wallet report check', el('span', { class: 'warn' }, 'waiting for your approval'), el('small', {}, 'a report that looked wrong was held back')));
    }
    items.push(row('Exchange API', na('The bots do not report exchange API errors to the dashboard'), el('small', {}, 'fresh wallet reports are the only sign that the exchange answered')));
    items.push(row('Errors', na('The bots send no error log to the dashboard')));
    items.push(row('Restarts (7d)', u ? String(u.restarts.length) : na('No heartbeat history yet'), u && u.restarts.length ? el('small', {}, `latest ${fmtShort(u.restarts[0].ts)}`) : null));
    host.append(el('dl', { class: 'kvlist kv2' }, items));
  }

  // ---------------- System Monitor: every bot, the recorder and the server ----------------
  let sysLogFilter = 'all';
  function renderSystem() {
    const d = data, now = d.generated_at, bots = LIVE.concat(LABS).map(bd), rc = d.recorder;
    const rows = bots.map((b) => {
      const h = health(b), u = b.uptime, s = b.status, w = b.live ? walletOf(b) : null, candles = Object.values(s.last_candle_ms || {}), exec = Math.max(b.last_entry_ms || 0, b.last_exit_ms || 0) || null;
      const newest = candles.length ? Math.max(...candles.map((v) => candleClose(b, v))) : null, pct = b.dd != null && b.halt ? `${Number(b.dd).toFixed(1)}R / ${Math.abs(b.halt)}R` : null;
      return { name: el('span', { class: 'botname', 'data-bot': b.key }, el('i', { class: 'bdot' }), b.label, el('small', { class: 'muted' }, ` ${b.role}`)), state: hchip(h), mode: b.present ? modeTag(b.mode) : '—', hb: b.hb != null ? ago(b.hb) : '—',
        up: u ? el('span', { class: u.uptime_pct >= 99 ? 'good' : u.uptime_pct >= 95 ? 'warn' : 'bad' }, `${u.uptime_pct.toFixed(2)}%`) : b.present ? na('No heartbeat history yet') : '—', rs: u ? String(u.restarts.length) : '—',
        exec: !b.present ? '—' : exec ? ago(exec) : 'none yet', candle: !b.present ? '—' : newest ? ago(newest) : na('The bot did not report its candles'), kill: !b.present ? '—' : b.kill ? el('span', { class: 'bad' }, 'ON') : 'off',
        dd: !b.present ? '—' : pct || na('No drawdown figure reported yet'), wallet: !b.live ? 'paper' : w ? [fmtUsd(w.usd), ' · ', ago(w.as_of)] : b.present ? na('No wallet report for this bot') : '—', build: s.commit || s.version ? `${s.commit || '?'} v${s.version || '?'}` : '—' };
    });
    rows.push({ name: el('span', { class: 'botname' }, el('i', { class: 'bdot' }), 'Data recorder', el('small', { class: 'muted' }, ' Data')), state: hchip(rc ? { state: rc.alive ? 'healthy' : 'stale', label: rc.alive ? 'HEALTHY' : 'STALE', note: rc.alive ? '' : `no report for ${fmtDur(rc.age_ms / 1000)}` } : { state: 'missing', label: 'MISSING' }),
      mode: '—', hb: rc ? ago(rc.ts) : '—', up: na('The recorder sends no heartbeat history'), rs: na('The recorder does not report restarts'), exec: '—', candle: rc && rc.health && rc.health.candles_ok_ms ? ago(rc.health.candles_ok_ms) : '—', kill: '—', dd: '—', wallet: '—', build: '—' });
    clear($('#sysBots')).append(table([
      { h: 'Bot', left: true, f: (r) => r.name }, { h: 'State', f: (r) => r.state }, { h: 'Mode', f: (r) => r.mode }, { h: 'Last heartbeat', f: (r) => r.hb }, { h: 'Uptime 7d', f: (r) => r.up }, { h: 'Restarts', f: (r) => r.rs },
      { h: 'Last execution', f: (r) => r.exec }, { h: 'Last candle', f: (r) => r.candle }, { h: 'Kill switch', f: (r) => r.kill }, { h: 'Drawdown / halt', f: (r) => r.dd }, { h: 'Wallet report', f: (r) => r.wallet }, { h: 'Build', f: (r) => r.build },
    ], rows, ''));
    // heartbeat timelines, one per bot
    const up = clear($('#sysUp'));
    for (const b of bots) {
      const bar = el('div', { class: 'upbar', role: 'img', 'aria-label': `${b.label} uptime timeline` }), axis = el('div', { class: 'upaxis' });
      fillUp(bar, axis, b.uptime, now);
      up.append(el('div', { class: 'upline' }, el('div', { class: 'upl' }, el('span', { class: 'botname', 'data-bot': b.key }, el('i', { class: 'bdot' }), b.label), b.uptime ? el('b', { class: b.uptime.uptime_pct >= 99 ? 'good' : b.uptime.uptime_pct >= 95 ? 'warn' : 'bad' }, `${b.uptime.uptime_pct.toFixed(2)}%`) : el('span', { class: 'muted' }, b.present ? 'no heartbeat history' : 'missing')), bar, b.uptime ? axis : null));
    }
    // downtime and restarts of every bot, newest first
    const lines = bots.flatMap((b) => uptimeLines(b.uptime).map((l) => ({ ...l, text: `${b.label} · ${l.text}` }))).sort((a, c) => c.ts - a.ts).slice(0, 60), dn = clear($('#sysDowns'));
    if (!lines.length) dn.append(el('div', { class: 'empty' }, 'No downtime or restarts in the last 7 days.'));
    else dn.append(...lines.map((l) => logLine(l.ts, l.tag, l.text)));
    // wallet connectivity of the live bots
    clear($('#sysConn')).append(table([
      { h: 'Account', left: true, f: (r) => r.name }, { h: 'Equity', f: (r) => r.eq }, { h: 'Report', f: (r) => r.rep }, { h: 'State', f: (r) => r.state }, { h: 'On exchange', f: (r) => r.exch }, { h: 'In the bot', f: (r) => r.mine },
    ], LIVE.map(bd).map((b) => {
      const w = walletOf(b), name = el('span', { class: 'botname', 'data-bot': b.key }, el('i', { class: 'bdot' }), b.label);
      if (!w) return { name, eq: '—', rep: '—', state: hchip({ state: 'missing', label: 'MISSING' }), exch: '—', mine: b.present ? String(b.open_list.length) : '—' };
      const age = Date.now() - w.as_of, differs = w.open != null && b.present && w.open !== b.open_list.length;
      return { name, eq: fmtUsd(w.usd), rep: ago(w.as_of), state: w.suspect ? el('span', { class: 'hchip stale' }, 'WAITING FOR APPROVAL') : hchip(age > WALLET_STALE_MS ? { state: 'stale', label: 'STALE' } : { state: 'healthy', label: 'HEALTHY' }),
        exch: w.open == null ? na('The wallet report did not carry its open positions') : el('span', { class: differs ? 'warn' : '' }, String(w.open)), mine: b.present ? el('span', { class: differs ? 'warn' : '' }, String(b.open_list.length)) : '—' };
    }), ''));
    renderRecorder($('#sysRec'), $('#sysRecNote'));
    loadVpsInline();
    // the server as the recorder reads it every 5 minutes (CPU, memory, which bot processes run, its own exchange errors); whatever it cannot read is Unavailable, never zero
    const h = rc && rc.health || {}, sv = rc && rc.server || {}, has = (k) => Number.isFinite(sv[k]), src = rc ? el('small', {}, ['reported by the recorder ', ago(rc.ts)]) : null;
    const SVC = [['svc_bbcore', 'BB-Core'], ['svc_icore', 'I-Core'], ['svc_tcore', 'T-CORE'], ['svc_bb1h', 'BB-1h lab'], ['svc_recorder', 'Recorder']].filter(([k]) => has(k));
    const perCore = has('load_1m') && sv.cpus > 0 ? sv.load_1m / sv.cpus : null, memPct = has('mem_used_mb') && sv.mem_total_mb > 0 ? (sv.mem_used_mb / sv.mem_total_mb) * 100 : null;
    clear($('#sysNA')).append(el('dl', { class: 'kvlist kv2' },
      kv('Disk free', h.disk_free_gb == null ? na('The recorder did not report it') : el('span', { class: h.disk_low ? 'bad' : '' }, `${h.disk_free_gb} GB`), src),
      kv('CPU load now', !has('load_1m') ? na('The recorder did not report it') : el('span', { class: perCore > 1.5 ? 'bad' : perCore > 0.8 ? 'warn' : '' }, `${Math.round(perCore * 100)}%`),
        has('load_1m') ? el('small', {}, `load ${sv.load_1m} · 5 min ${has('load_5m') ? sv.load_5m : '—'} · 15 min ${has('load_15m') ? sv.load_15m : '—'} on ${sv.cpus} core${sv.cpus === 1 ? '' : 's'}`) : null),
      kv('Memory in use now', memPct == null ? na('The recorder did not report it') : el('span', { class: memPct > 90 ? 'bad' : memPct > 80 ? 'warn' : '' }, `${Math.round(memPct)}% · ${sv.mem_used_mb} of ${sv.mem_total_mb} MB`),
        has('swap_used_mb') ? el('small', {}, `swap in use ${sv.swap_used_mb} MB`) : null),
      kv('Running services', SVC.length ? el('span', {}, SVC.map(([k, name], i) => el('span', { class: sv[k] === 1 ? 'good' : 'bad' }, `${i ? ' · ' : ''}${name} ${sv[k] === 1 ? '✓' : '✗'}`))) : na('The recorder did not report them'),
        SVC.length ? el('small', {}, 'a bot\'s process found running on the server') : null),
      kv('Server logs', na('Logs are never sent: they can hold keys and addresses'), el('small', {}, 'the dashboard only ever receives numbers')),
      kv('Exchange API errors', h.errors_1h == null ? na('The recorder did not report it') : el('span', { class: h.errors_1h > 0 ? 'warn' : '' }, `${h.errors_1h} in the last hour`), el('small', {}, 'the recorder\'s own MEXC requests; the bots do not report theirs'))),
    el('p', { class: 'muted note' }, 'These figures come from the recorder\'s heartbeat every 5 minutes. A figure it cannot read is shown as Unavailable, never as zero. The Server panel above holds the plan\'s specs as recorded on its date. Status of every bot is judged from its own heartbeats.'));
    renderSysLog();
  }
  function renderSysLog() {
    const bots = LIVE.concat(LABS).map(bd), seg = clear($('#sysLogSeg'));
    seg.append(...[['all', 'All'], ...bots.map((b) => [b.key, b.label])].map(([k, l]) => el('button', { type: 'button', 'data-logf': k, class: k === sysLogFilter ? 'on' : '' }, l)));
    const out = [];
    for (const b of bots) if (sysLogFilter === 'all' || sysLogFilter === b.key) for (const a of b.activity) out.push({ ts: a.ts, line: () => actLine(a, el('span', { class: 'botname', 'data-bot': b.key }, b.label)) });
    if (sysLogFilter === 'all') for (const f of data.capital_flows || []) out.push({ ts: f.ts, line: () => actLine({ ts: f.ts, kind: 'capital', flow: f.kind, usd: f.usd }, 'ledger') });
    out.sort((a, c) => c.ts - a.ts);
    const box = clear($('#sysLog'));
    if (!out.length) box.append(el('div', { class: 'empty' }, 'Nothing logged yet.'));
    else box.append(...out.slice(0, 120).map((x) => x.line()).filter(Boolean));
  }

  // ---------------- Research Lab: the paper bots and the market recorder, apart from live money ----------------
  function renderLabOverview() {
    clear($('#labCards')).append(el('div', { class: `botcards${LABS.length > 1 ? ' two' : ''}` }, LABS.map((k) => botCard(bd(k), { open: true }))));
    const rows = LABS.map(bd).map((b) => {
      const p = b.perf, e = p ? p.expect : {}, o = p ? p.overall : b.overall, rd = b.present ? BR.readiness(b.trades, { compare: b.compare, drawdownR: b.dd, haltR: b.halt, skipCompare: b.key === 'bb1h' }) : [];
      return { b, label: b.label, n: o.trades, win: o.win_rate, ewin: e.win_rate, avg: o.avg_r, eavg: e.avg_r, pm: p ? p.trades_per_month : null, epm: e.trades_per_month, dd: o.max_dd_r, edd: e.max_dd_r, ok: rd.filter((c) => c.status === 'pass').length, of: rd.length };
    });
    clear($('#labCompare')).append(table([
      { h: 'Lab', left: true, f: (r) => el('span', { class: 'botname', 'data-bot': r.b.key }, el('i', { class: 'bdot' }), r.label) }, { h: 'Closed trades', f: (r) => (r.b.present ? r.n : '—') },
      { h: 'Win rate', f: (r) => (r.b.present ? [pct0(r.win), el('small', { class: 'muted' }, ` exp ${pct0(r.ewin)}`)] : '—') }, { h: 'Average R', f: (r) => (r.b.present ? [el('span', { class: cls(r.avg) }, fmtR(r.avg)), el('small', { class: 'muted' }, ` exp ${fmtR(r.eavg)}`)] : '—') },
      { h: 'Trades / month', f: (r) => (r.b.present ? [r.pm ?? '—', el('small', { class: 'muted' }, ` exp ${r.epm ?? '—'}`)] : '—') }, { h: 'Worst drop', f: (r) => (r.b.present ? [`${Number(r.dd || 0).toFixed(1)}R`, el('small', { class: 'muted' }, ` exp ${r.edd ?? '—'}R`)] : '—') },
      { h: 'Ready for live?', f: (r) => (r.b.present ? `${r.ok} of ${r.of} checks OK` : '—') },
    ], rows, ''));
  }
  // ---------------- News Lab: the news gate's backtest, its shadow verdicts on the real bots' trades, and the news paper bots against their counterparts ----------------
  const reasonLabel = (r) => { const s = String(r || ''); if (!s.startsWith('news_gate')) return r; const rest = s.slice(9).replace(/^[:_\s]+/, ''); return rest ? `skipped by news gate (${rest})` : 'skipped by news gate'; };
  const GATE_INPUTS_URL = 'https://cryptobai.vercel.app/api/gate-inputs', SHADOW_FROM = Date.UTC(2026, 10, 1);
  const nl = { bt: null, btTried: false, inp: null, inpAt: 0, inpErr: null, loading: false };
  async function loadNewsLab() {
    if (nl.loading) return; nl.loading = true;
    try {
      if (!nl.btTried) { nl.btTried = true; try { const r = await fetch('news-lab-backtest.json', { cache: 'no-cache' }); if (r.ok) nl.bt = await r.json(); } catch { /* the panel says it is not there */ } }
      if (!nl.inp || Date.now() - nl.inpAt > 30 * 60e3) {
        try { const r = await fetch(GATE_INPUTS_URL, { cache: 'no-cache' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); nl.inp = await r.json(); nl.inpAt = Date.now(); nl.inpErr = null; } catch (e) { nl.inpErr = String(e.message || e); }
      }
    } finally { nl.loading = false; }
    if (data && viewKey() === 'lab:news') drawNewsLab();
  }
  function renderNewsLab() { drawNewsLab(); loadNewsLab(); }
  // the gate's verdict for one trade, from the inputs as they were at its entry time
  function shadowVerdict(t, inp) {
    const ts = Math.floor(t.entry_ts / 1000), fng = inp.fng || [], btc = inp.btc || [];
    const lastAt = (rows, x) => { let lo = 0, hi = rows.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= x) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
    const fngAt = (x) => { const k = lastAt(fng, x); return k >= 0 ? fng[k][1] : null; };
    const a = lastAt(btc, ts), b = lastAt(btc, ts - 86400);
    const btcChange24h = a >= 0 && b >= 0 && btc[a][0] - btc[b][0] >= 20 * 3600 ? (btc[a][1] / btc[b][1] - 1) * 100 : null;
    return window.NewsGate.gate({ t: ts, coin: sym(t.symbol), dir: t.side === 'SHORT' ? -1 : 1, events: inp.events || [], fngAt, btcChange24h, hacks: inp.hacks || [] }, inp.cfg || window.NewsGate.DEFAULTS);
  }
  const signed = (x) => `${x > 0 ? '+' : ''}${x}`;
  function drawNewsLab() {
    // a) backtest
    const bt = nl.bt, bh = clear($('#nlBacktest')), vh = clear($('#nlVariants'));
    $('#nlBtWhen').textContent = bt && bt.generated ? `run ${String(bt.generated).slice(0, 10)}${bt.chosen ? ` · rule set: ${bt.chosen.name}` : ''}` : '';
    const rows = bt && bt.bots ? Object.entries(bt.bots).filter(([, b]) => b && b.base).map(([name, b]) => ({ name, b, c: b.chosen || null })) : [];
    if (!rows.length) bh.append(el('div', { class: 'empty' }, nl.btTried ? 'No backtest result published yet.' : 'Loading…'));
    else {
      const both = (x, y, f) => [f(x), el('small', { class: 'muted' }, ' → '), y ? f(y) : '—'];
      bh.append(table([
        { h: 'Bot', left: true, f: (r) => el('b', {}, r.name) },
        { h: 'Trades', f: (r) => both(r.b.base.all, r.c && r.c.all, (s) => String(s.n)) },
        { h: 'Total R', f: (r) => both(r.b.base.all, r.c && r.c.all, (s) => el('span', { class: cls(s.R) }, `${s.R}R`)) },
        { h: 'R / trade', f: (r) => both(r.b.base.all, r.c && r.c.all, (s) => `${Number(s.avgR).toFixed(3)}R`) },
        { h: 'Worst drop', f: (r) => both(r.b.base.all, r.c && r.c.all, (s) => `${s.ddR}R`) },
        { h: 'Before 2024', f: (r) => both(r.b.base.is, r.c && r.c.is, (s) => `${s.R}R`) },
        { h: '2024 →', f: (r) => both(r.b.base.oos, r.c && r.c.oos, (s) => `${s.R}R`) },
        { h: 'Skipped', f: (r) => (r.c && r.c.skipped ? `${r.c.skipped.n} (${signed(r.c.skipped.R)}R)` : '—') },
        { h: 'p', f: (r) => (r.c && r.c.p != null ? String(r.c.p) : '—') },
      ], rows, ''));
      const vrows = rows.flatMap(({ name, b }) => (b.rows || []).map((v) => ({ name, ...v, _cls: v.helps ? 'total' : '' })));
      vh.append(table([
        { h: 'Bot', left: true, f: (r) => r.name }, { h: 'Rule', left: true, f: (r) => r.variant },
        { h: 'Skipped', f: (r) => (r.skipped ? `${r.skipped.n} (${signed(r.skipped.R)}R)` : '—') },
        { h: 'R / trade kept', f: (r) => (r.all ? Number(r.all.avgR).toFixed(3) : '—') },
        { h: 'ΔR', f: (r) => el('span', { class: cls(r.dR) }, signed(r.dR)) }, { h: 'ΔR <2024', f: (r) => el('span', { class: cls(r.dIS) }, signed(r.dIS)) },
        { h: 'ΔR 2024+', f: (r) => el('span', { class: cls(r.dOOS) }, signed(r.dOOS)) }, { h: 'Δ drop', f: (r) => el('span', { class: cls(r.dDD) }, signed(r.dDD)) },
        { h: 'p', f: (r) => (r.p != null ? String(r.p) : '—') }, { h: 'Helps', f: (r) => (r.helps ? '✓' : '') },
      ], vrows, 'No variants in the backtest file.'));
    }
    // b) shadow verdicts on the real bots' trades
    const sh = clear($('#nlShadow')), st = clear($('#nlShadowTrades')), inp = nl.inp;
    $('#nlShadowWhen').textContent = inp ? `gate inputs ${fmtShort(inp.updated)}${tzTag()}` : '';
    if (!inp || !window.NewsGate) sh.append(el('div', { class: 'empty' }, nl.inpErr ? `Gate inputs unavailable (${nl.inpErr}).` : 'Loading gate inputs…'));
    else {
      const all = [], sum = (xs) => xs.reduce((a, x) => a + x.t.r, 0);
      const per = ['bbcore', 'icore', 'tcore', 'bbtr', 'bb1h'].map((k) => {
        const b = bd(k);
        const tr = b.present ? b.trades.concat(b.open_list.map((o) => ({ ...o, r: null }))).filter((t) => t.entry_ts >= SHADOW_FROM) : [];
        const v = tr.map((t) => { const x = { bot: k, label: b.label, t, g: shadowVerdict(t, inp) }; all.push(x); return x; });
        const closed = v.filter((x) => x.t.r != null), skip = closed.filter((x) => !x.g.allow), keep = closed.filter((x) => x.g.allow);
        return { k, b, n: v.length, closed: closed.length, wouldSkip: v.filter((x) => !x.g.allow).length, skipR: sum(skip), keepR: sum(keep), allR: sum(closed) };
      });
      sh.append(table([
        { h: 'Bot', left: true, f: (r) => el('span', { class: 'botname', 'data-bot': r.k }, el('i', { class: 'bdot' }), r.b.label, el('small', { class: 'muted' }, ` ${r.b.present ? String(r.b.mode).toUpperCase() : 'MISSING'}`)) },
        { h: 'Trades since Nov 1', f: (r) => (r.b.present ? `${r.n}${r.n - r.closed ? ` (${r.n - r.closed} open)` : ''}` : '—') },
        { h: 'Gate would skip', f: (r) => (r.b.present ? String(r.wouldSkip) : '—') },
        { h: 'R of skipped', f: (r) => (r.b.present && r.wouldSkip ? el('span', { class: cls(r.skipR) }, fmtR(r.skipR)) : '—') },
        { h: 'R as traded', f: (r) => (r.b.present ? el('span', { class: cls(r.allR) }, fmtR(r.allR)) : '—') },
        { h: 'R with gate', f: (r) => (r.b.present ? el('span', { class: cls(r.keepR) }, fmtR(r.keepR)) : '—') },
        { h: 'Gate effect', f: (r) => { if (!r.b.present || !r.closed) return '—'; const d = r.keepR - r.allR; return el('span', { class: cls(d) }, Math.abs(d) < 1e-9 ? 'none' : `${d > 0 ? 'helped' : 'cost'} ${Math.abs(d).toFixed(2)}R`); } },
      ], per, ''));
      all.sort((a, b) => b.t.entry_ts - a.t.entry_ts);
      st.append(table([
        { h: 'Entry', left: true, f: (r) => fmtShort(r.t.entry_ts) }, { h: 'Bot', left: true, f: (r) => el('span', { class: 'botname', 'data-bot': r.bot }, el('i', { class: 'bdot' }), r.label) },
        { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.t.symbol)} `, sideEl(r.t.side)) }, { h: 'R', f: (r) => (r.t.r == null ? 'open' : fmtR(r.t.r)), c: (r) => cls(r.t.r) },
        { h: 'Gate', f: (r) => el('span', { class: `chip ${r.g.allow ? 'good' : 'bad'}` }, r.g.allow ? 'allow' : 'skip') },
        { h: 'Why', left: true, f: (r) => r.g.reasons.join('; '), c: () => 'wrap' },
      ], all.slice(0, 60), 'No trades since Nov 1 yet.'));
    }
    // c) the news paper bots against their counterparts
    const lrows = Object.entries(NEWS).map(([k, c]) => ({ k, n: bd(k), c: bd(c), skips: data.news_labs && data.news_labs[k] ? data.news_labs[k].news_skips : null }));
    const vs = (r, f) => el('small', { class: 'muted' }, ` vs ${r.c.present ? f(r.c) : '—'}`);
    clear($('#nlLive')).append(table([
      { h: 'News lab', left: true, f: (r) => el('span', { class: 'botname', 'data-bot': r.k }, el('i', { class: 'bdot' }), r.n.label, el('small', { class: 'muted' }, ` vs ${r.c.label}`)) },
      { h: 'Status', left: true, f: (r) => (r.n.present ? (r.n.alive ? 'running' : `stale · ${health(r.n).note}`) : 'waiting for first heartbeat') },
      { h: 'Trades', f: (r) => (r.n.present ? [String(r.n.overall.trades), vs(r, (b) => b.overall.trades)] : '—') },
      { h: 'Total R', f: (r) => (r.n.present ? [el('span', { class: cls(r.n.overall.total_r) }, fmtR(r.n.overall.total_r)), vs(r, (b) => fmtR(b.overall.total_r))] : '—') },
      { h: 'R / trade', f: (r) => (r.n.present ? [fmtR(r.n.overall.avg_r), vs(r, (b) => fmtR(b.overall.avg_r))] : '—') },
      { h: 'Worst drop', f: (r) => (r.n.present ? [`${Number(r.n.overall.max_dd_r || 0).toFixed(1)}R`, vs(r, (b) => `${Number(b.overall.max_dd_r || 0).toFixed(1)}R`)] : '—') },
      { h: 'Paper equity', f: (r) => (r.n.present && r.n.capital ? `${Number(r.n.capital.usd).toFixed(2)}` : '—') },
      { h: 'Skipped by news gate', f: (r) => (r.n.present ? String(r.skips ? r.skips.total : 0) : '—') },
    ], lrows, ''));
  }

  function renderMarket() {
    renderRegime(); renderRecorder($('#recHealth'), $('#recNote')); loadRegimeHistory();
    const p = view().perf;
    if (p) renderExec(p); else { clear($('#exec')).append(el('div', { class: 'empty' }, 'No data yet.')); $('#execNote').textContent = ''; }
  }

  // ---------------- Settings ----------------
  function renderSettings() {
    const d = data, mode = d.mode;
    $('#modeRow').hidden = d.modes_seen.length < 2;
    clear($('#modeSeg')).append(...d.modes_seen.map((m) => el('button', { type: 'button', 'data-mode': m, class: m === mode ? 'on' : '' }, m)));
    syncSettings();
    const s = d.status;
    $('#setInfo').textContent = `Data generated ${fmtTime(d.generated_at)} · BB-Core data mode ${d.mode}${s.commit || s.version ? ` · BB-Core build ${s.commit || '?'} v${s.version || '?'}` : ''}.`;
  }
  function syncSettings() {
    for (const b of $$('[data-tz]')) b.classList.toggle('on', b.dataset.tz === tz);
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    for (const b of $$('[data-theme-set]')) b.classList.toggle('on', b.dataset.themeSet === theme);
  }

  // every second: the clock and every "x ago" / "in x" in the open tab stays current without refetching (paused while the page is hidden)
  function tick() {
    if (document.hidden) return;
    const now = Date.now(), p = parts(now);
    $('#clock').textContent = `${fmtDay(now)} ${clock12(p, true)}${tz === 'utc' ? ' UTC' : ''}`;
    const upd = $('#updated'); if (upd.dataset.ts) clear(upd).append(`Updated ${fmtShort(Number(upd.dataset.ts))}${tzTag()} · `, el('b', { class: 'upd-ago' }, `${fmtDur((now - Number(upd.dataset.ts)) / 1000)} ago`));
    for (const n of document.querySelectorAll('#app [data-ago]')) n.textContent = `${fmtDur((now - Number(n.dataset.ago)) / 1000)} ago`;
    for (const n of document.querySelectorAll('#app [data-until]')) { const t = Number(n.dataset.until); n.textContent = t > now ? `in ${fmtDur((t - now) / 1000)}` : 'due now'; }
  }

  // ---------------- keys, navigation, switches ----------------
  const typing = () => /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || $('#app').hidden;
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    if (e.key === 'r' || e.key === 'R') load(true);
    if (/^[1-5]$/.test(e.key)) { setPage(PAGES[+e.key - 1]); window.scrollTo(0, 0); }
  });
  $('#mainTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-page]'); if (b) { setPage(b.dataset.page); window.scrollTo(0, 0); } });
  $('#mainTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const n = (PAGES.indexOf(route.page) + (e.key === 'ArrowRight' ? 1 : PAGES.length - 1)) % PAGES.length; setPage(PAGES[n]); $(`#mainTabs [data-page="${PAGES[n]}"]`).focus(); e.preventDefault();
  });
  $('#subTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-sub]'); if (b) setSub(b.dataset.sub); });
  $('#subTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const subs = (route.page === 'bots' ? BOT_SUBS : LAB_SUBS).map(([k]) => k), cur = route.page === 'bots' ? route.bsub : route.lsub, n = (subs.indexOf(cur) + (e.key === 'ArrowRight' ? 1 : subs.length - 1)) % subs.length;
    setSub(subs[n]); $(`#subTabs [data-sub="${subs[n]}"]`).focus(); e.preventDefault();
  });
  $('#botSel').addEventListener('click', (e) => { const b = e.target.closest('[data-selbot]'); if (b) selectBot(b.dataset.selbot); });
  // a bot card opens that bot's workspace
  const openCard = (c) => { if (data) goBot(c.dataset.open, LIVE.includes(c.dataset.open) ? 'dashboard' : 'performance'); };
  document.addEventListener('click', (e) => { const c = e.target.closest('[data-open]'); if (c) openCard(c); });
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-open]')) { e.preventDefault(); openCard(e.target); } });
  window.addEventListener('hashchange', () => { readHash(location.hash); applyRoute(); });
  $('#pChecks').addEventListener('click', () => { const bad = LIVE.map(bd).find((b) => b.perf && (b.perf.verdict === 'warn' || b.perf.verdict === 'stop')); goBot(bad ? bad.key : 'bbcore', 'verification'); });
  $('#rangeTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartDays = +b.dataset.range; store.set('bot.range', String(chartDays)); renderChart(); });
  $('#chartTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartKind = b.dataset.chart; store.set('bot.chart', chartKind); renderChart(); });
  $('#bRangeTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartDays = +b.dataset.range; store.set('bot.range', String(chartDays)); renderBotChart(); });
  $('#bChartTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; bchartKind = b.dataset.bchart; store.set('bot.bchart', bchartKind); renderBotChart(); });
  $('#eqMetric').addEventListener('click', (e) => { const b = e.target.closest('button[data-eqm]'); if (!b || !data) return; eqMetric = b.dataset.eqm; store.set('bot.eqm', eqMetric); renderEquity(view()); });
  $('#eqRange').addEventListener('click', (e) => { const b = e.target.closest('button[data-eqr]'); if (!b || !data) return; eqDays = +b.dataset.eqr; store.set('bot.eqr', String(eqDays)); renderEquity(view()); });
  $('#periodTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-period]'); if (!b || !data) return; period = b.dataset.period; store.set('bot.period', period); if (view().perf) renderPeriods(view().perf); });
  for (const [id, k] of [['fCoin', 'coin'], ['fSide', 'side'], ['fReason', 'reason'], ['fFrom', 'from'], ['fTo', 'to']]) $(`#${id}`).addEventListener('change', (e) => { filters[k] = e.target.value; shown.trades = PAGE.trades; renderTrades(); });
  $('#fSearch').addEventListener('input', (e) => { filters.q = e.target.value; shown.trades = PAGE.trades; renderTrades(); });
  // settings: times, theme, data mode, saved preferences
  for (const id of ['#pSettings', '#pSession']) $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tz) { tz = b.dataset.tz; store.set('bot.tz', tz); if (data) render(data); }
    if (b.dataset.themeSet) { document.documentElement.setAttribute('data-theme', b.dataset.themeSet); store.set('bot.theme', b.dataset.themeSet); }
    if (b.dataset.mode) { modeSel = b.dataset.mode; store.set('bot.mode', modeSel); load(true); }
    if (b.id === 'resetPrefs') { try { for (const k of Object.keys(localStorage)) if (k.startsWith('bot.')) localStorage.removeItem(k); } catch {} location.reload(); }
    syncSettings();
  });
  // system monitor: commands and the log filter
  $('#sysAsk').addEventListener('click', () => { load(true); askBot(); });
  $('#sysRefresh').addEventListener('click', () => load(true));
  $('#sysLogSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-logf]'); if (!b) return; sysLogFilter = b.dataset.logf; renderSysLog(); });

  // ---------------- VPS specs (System Monitor): a recorded snapshot of the plan, not live usage ----------------
  let vpsInlineDone = false;
  async function loadVpsInline() {   // the server specs, read once when the System Monitor is first opened
    if (vpsInlineDone) return; const host = $('#vpsInline');
    try {
      const res = await fetch('/api/vps', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderVps(await res.json(), host); vpsInlineDone = true;
    } catch (e) { clear(host).append(el('div', { class: 'empty' }, `Could not load the specs: ${e.message}`)); }
  }

  // ---------------- VPS specs (System Monitor) ----------------
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
    let kept = false;
    try {
      const headers = !force && etag && data ? { 'If-None-Match': etag } : {};
      const qs = [modeSel ? `mode=${encodeURIComponent(modeSel)}` : '', force || askWatch ? 'fresh=1' : ''].filter(Boolean).join('&');   // fresh=1: skip the server's 10 s reuse (a person asked, or the bot is being asked)
      const res = await fetch('/api/data' + (qs ? `?${qs}` : ''), { credentials: 'same-origin', cache: 'no-store', headers });
      if (res.status === 401) return showLogin('');
      if (res.status === 503) return showLogin('The dashboard login is not configured on the server (set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET in Vercel).');
      if (res.status === 304) return;                                       // nothing new: keep what is on screen
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false; $('#logoutBtn').hidden = false;
      etag = res.headers.get('ETag');
      render(await res.json());
    } catch (e) {
      console.error('bot dashboard: refresh failed', e);
      if (data) { kept = true; }   // a failed refresh never wipes the page: the last data stays until the next one arrives
      else showLogin(`Could not load data: ${e.message}`);
    }
    finally { /* nothing to reset */ }
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
  $('#logoutBtn').addEventListener('click', async () => { try { await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }); } catch {} showLogin(''); });
  $('#refreshBtn').addEventListener('click', () => load(true));

  // "Ask bot now": leaves a request; the bot (which asks outbound about once a minute) answers with a heartbeat; we re-read every 5 s until it arrives (or give up after 3 minutes)
  let askWatch = null;
  async function askBot() {
    const m1 = $('#askMsg'), m2 = $('#sysAskMsg'), msg = { set textContent(v) { m1.textContent = v; m2.textContent = v; }, set hidden(v) { m1.hidden = v; } };   // the answer shows at the top and on the System Monitor
    const btn = $('#askBtn'); btn.disabled = true; btn.classList.add('asking'); msg.hidden = false; msg.textContent = 'Asking…';
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
        if (hb != null && hb >= since) { clearInterval(askWatch); askWatch = null; btn.disabled = false; btn.classList.remove('asking'); msg.textContent = `The bot answered at ${fmtHm(hb)}${tzTag()}.`; }
        else if (Date.now() > stop) { clearInterval(askWatch); askWatch = null; btn.disabled = false; btn.classList.remove('asking'); msg.textContent = 'No answer yet. The bot may be busy, offline, or still on the old version (it needs the update that adds this). It answers when it next reports.'; }
      }, 5000);
    } catch (e) { btn.disabled = false; btn.classList.remove('asking'); msg.textContent = `Could not ask: ${e.message}`; }
  }
  $('#askBtn').addEventListener('click', () => { load(true); askBot(); });

  tick();
  load(true);
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !$('#app').hidden) load(); }, 60000);   // keeps the alive/stale status honest; 304 when nothing changed
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) { tick(); load(); } });
})();

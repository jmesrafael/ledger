// app.js - the bot dashboard page. Everything shown comes from GET /api/data (password-gated). No libraries; values are put into the page with
// textContent only, never as HTML.
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
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };

  let tz = store.get('bot.tz') === 'local' ? 'local' : 'utc', data = null, modeSel = store.get('bot.mode') || '';
  let chartKind = ['capital', 'r', 'dd'].includes(store.get('bot.chart')) ? store.get('bot.chart') : 'capital';
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
  function fmtHm(ms) { if (ms == null) return '—'; const p = parts(ms); return `${pad(p.h)}:${pad(p.mi)}`; }
  const fmtPx = (v) => (v == null ? '—' : String(Number(Number(v).toPrecision(6))));
  const fmtR = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`);
  const fmtUsd = (v, signed) => (v == null ? '—' : `${signed ? (v >= 0 ? '+' : '−') : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const fmtPct = (v, signed) => (v == null ? '—' : `${signed && v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const cls = (v) => (v > 0 ? 'good' : v < 0 ? 'bad' : '');
  function fmtDur(sec) {
    if (sec == null) return '—'; sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${pad(m)}m` : m ? `${m}m` : `${sec}s`;
  }
  const sym = (s) => String(s || '').replace('_USDT', '');
  const sideEl = (s) => (s ? el('span', { class: `side ${s}` }, s) : '');
  // live relative times: refreshed every second by tick()
  const ago = (ms) => el('small', { 'data-ago': ms }, `${fmtDur((Date.now() - ms) / 1000)} ago`);
  const until = (ms) => el('small', { 'data-until': ms }, ms > Date.now() ? `in ${fmtDur((ms - Date.now()) / 1000)}` : 'due now');

  // ---------------- tables ----------------
  function table(cols, rows, empty) {
    if (!rows.length) return el('div', { class: 'empty' }, empty);
    return el('table', {}, el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.left ? 'l' : '' }, c.h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, cols.map((c) => el('td', { class: `${c.left ? 'l' : ''} ${c.c ? c.c(r) : ''}` }, c.f(r)))))));
  }

  // ---------------- charts (inline SVG) ----------------
  function lineChart(host, pts, { dd = false, fmtY = (v) => v.toFixed(1), empty = 'No closed trades yet.' } = {}) {
    clear(host);
    if (!pts.length) { host.append(el('div', { class: 'empty' }, empty)); return; }
    const W = 680, H = 250, L = 62, R = 14, T = 12, B = 26;
    const xs = pts.map((p) => p.ts), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (dd) { y0 = 0; y1 = Math.max(1, y1); } else { const padY = (y1 - y0) * 0.12 || Math.abs(y1) * 0.02 || 1; y0 -= padY; y1 += padY; }
    const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), sy = (y) => T + (dd ? (y - y0) / (y1 - y0) : 1 - (y - y0) / (y1 - y0)) * (H - T - B);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': dd ? 'drawdown chart' : 'equity curve' });
    const defs = sv('defs'), g = sv('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
    g.append(sv('stop', { offset: '0%', style: 'stop-color:var(--accent-text);stop-opacity:.28' }), sv('stop', { offset: '100%', style: 'stop-color:var(--accent-text);stop-opacity:0' }));
    defs.append(g); svg.append(defs);
    const t = (x, y, s, anchor) => { const n = sv('text', { x, y, 'text-anchor': anchor || 'start' }); n.textContent = s; return n; };
    for (let i = 0; i <= 4; i++) {
      const v = y0 + ((y1 - y0) * i) / 4, y = sy(v);
      svg.append(sv('line', { class: 'grid-l', x1: L, y1: y, x2: W - R, y2: y }), t(L - 8, y + 3.5, fmtY(v), 'end'));
    }
    if (!dd && y0 < 0 && y1 > 0) svg.append(sv('line', { class: 'zero', x1: L, y1: sy(0), x2: W - R, y2: sy(0) }));
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const base = (dd ? sy(0) : H - B).toFixed(1), last = pts[pts.length - 1];
    svg.append(sv('path', { class: dd ? 'dd' : 'area', d: `${path} L${sx(last.ts).toFixed(1)},${base} L${sx(pts[0].ts).toFixed(1)},${base} Z` }));
    if (!dd) svg.append(sv('path', { class: 'line', d: path }), sv('circle', { class: 'dot', cx: sx(last.ts), cy: sy(last.y), r: 3.5 }));
    svg.append(t(L, H - 7, fmtDay(x0)), t(W - R, H - 7, fmtDay(x1), 'end'));
    host.append(svg);
  }
  function spark(host, ys) {
    clear(host);
    if (ys.length < 2) return;
    const lo = Math.min(...ys), hi = Math.max(...ys), W = 100, H = 30;
    const d = ys.map((y, i) => `${i ? 'L' : 'M'}${((i / (ys.length - 1)) * W).toFixed(2)},${(H - 2 - ((y - lo) / (hi - lo || 1)) * (H - 4)).toFixed(2)}`).join(' ');
    const s = sv('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }); s.append(sv('path', { d })); host.append(s);
  }

  // ---------------- render ----------------
  function render(d) {
    data = d;
    const mode = d.mode, s = d.status, waiting = s.last_heartbeat_ms == null;
    for (const n of $$('.modeTag')) { n.textContent = mode.toUpperCase(); n.className = `modeTag ${mode}`; }

    // mode switch in the settings menu (only when both paper and live data exist)
    $('#modeRow').hidden = d.modes_seen.length < 2;
    clear($('#modeSeg')).append(...d.modes_seen.map((m) => el('button', { type: 'button', 'data-mode': m, class: m === mode ? 'on' : '' }, m)));

    // status pill + alert strip
    const pill = $('#statusPill'); pill.hidden = false;
    pill.className = `pill ${waiting ? '' : s.alive ? 'ok' : 'bad'}`;
    pill.textContent = `${mode.toUpperCase()} · ${waiting ? 'WAITING' : s.alive ? 'ONLINE' : 'STALE'}`;
    $('#hbDot').className = `live-dot ${waiting ? '' : s.alive ? 'ok' : 'bad'}`;
    const alert = $('#alert');
    if (!waiting && !s.alive) { alert.hidden = false; alert.className = 'alert'; alert.textContent = `Bot is not reporting: no heartbeat for ${fmtDur(s.age_ms / 1000)} (limit ${fmtDur(s.stale_after_ms / 1000)}). Check the VPS.`; }
    else if (s.kill_switch) { alert.hidden = false; alert.className = 'alert warn'; alert.textContent = 'Kill switch is ON: the bot takes no new entries.'; }
    else alert.hidden = true;

    renderKpis(d);
    renderSystem(d);
    renderChart();
    renderActivity(d);

    // open positions
    clear($('#open')).append(table([
      { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) }, { h: 'TP', f: (r) => fmtPx(r.tp) },
      { h: 'Now', f: (r) => fmtPx(r.price) }, { h: 'Current R', f: (r) => (r.current_r == null ? '—' : fmtR(r.current_r)), c: (r) => cls(r.current_r) }, { h: 'Opened', f: (r) => fmtShort(r.entry_ts) },
    ], d.open, 'No open positions. The bot is flat and waiting for a signal.'));

    // filters
    const coinSel = $('#fCoin'), have = [...coinSel.options].map((o) => o.value);
    for (const k of Object.keys(d.per_coin)) if (!have.includes(k)) coinSel.append(el('option', { value: k }, sym(k)));
    renderTrades();

    // per coin
    const rows = Object.entries(d.per_coin).map(([k, v]) => ({ coin: k, ...v })).concat(d.overall.trades ? [{ coin: 'ALL', ...d.overall }] : []);
    clear($('#perCoin')).append(table([
      { h: 'Coin', left: true, f: (r) => (r.coin === 'ALL' ? el('strong', {}, 'ALL') : sym(r.coin)) }, { h: 'Trades', f: (r) => r.trades }, { h: 'Win rate', f: (r) => (r.win_rate == null ? '—' : `${(r.win_rate * 100).toFixed(0)}%`) },
      { h: 'Profit factor', f: (r) => (r.profit_factor == null ? '—' : r.profit_factor) }, { h: 'Avg R', f: (r) => fmtR(r.avg_r), c: (r) => cls(r.avg_r) },
      { h: 'Total R', f: (r) => fmtR(r.total_r), c: (r) => cls(r.total_r) }, { h: 'Max DD', f: (r) => `${r.max_dd_r}R` }, { h: 'Worst losing streak', f: (r) => r.longest_losing_streak },
    ], rows, 'No closed trades yet.'));

    // skipped signals
    clear($('#skipped')).append(table([
      { h: 'Signal candle', left: true, f: (r) => fmtShort(r.signal_candle_open_ms) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) },
      { h: 'Reason', left: true, f: (r) => el('span', { class: 'chip' }, r.reason) }, { h: 'Detail', left: true, f: (r) => r.detail || '', c: () => 'wrap' },
    ], d.skipped, 'No skipped signals.'));

    // compare
    const c = clear($('#compare'));
    if (!d.compare) c.append(el('div', { class: 'empty' }, 'No comparison received yet (compare-live-vs-backtest.js --push).'));
    else {
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
    $('#footer').textContent = `data generated ${fmtTime(d.generated_at)} · auto-refresh every 60s · times in ${tz === 'utc' ? 'UTC' : 'your local time'} · ${mode} mode`;
    tick();
  }

  const kv = (k, v, sub) => el('div', {}, el('dt', {}, k), el('span', { class: 'fill', 'aria-hidden': 'true' }), el('dd', {}, v, sub || null));

  function renderKpis(d) {
    const cap = d.capital, o = d.overall, s = d.status;
    if (cap) {
      $('#kCapital').textContent = fmtUsd(cap.usd);
      const sub = $('#kCapitalSub'); clear(sub).append(el('span', { class: cls(cap.change_usd) }, `${fmtUsd(cap.change_usd, true)} (${fmtPct(cap.change_pct, true)})`), ` since start ${fmtUsd(cap.start_usd)}`);
      spark($('#kSpark'), cap.points.map((p) => p.usd));
    } else {
      $('#kCapital').textContent = '—';
      $('#kCapitalSub').textContent = d.mode === 'live' ? 'Live balance is not shared with the dashboard.' : 'No balance received yet (arrives with each 4h candle).';
      spark($('#kSpark'), d.equity.map((p) => p.r_cum));
    }
    const net = $('#kNet'); net.textContent = fmtR(o.total_r); net.className = `mid ${cls(o.total_r)}`;
    $('#kNetSub').textContent = `${o.trades} closed trade${o.trades === 1 ? '' : 's'}${cap && cap.realized_usd != null ? ` · ${fmtUsd(cap.realized_usd, true)} realized` : ''} · ${d.open.length} open`;
    $('#kWin').textContent = o.trades ? `${(o.win_rate * 100).toFixed(0)}% · ${o.profit_factor ?? '—'}` : '—';
    $('#kWinSub').textContent = o.trades ? `${o.wins}W / ${o.trades - o.wins}L · avg ${fmtR(o.avg_r)}` : 'No closed trades yet.';
    const dd = s.drawdown_r, halt = s.halt_r != null ? Math.abs(s.halt_r) : null, pct = dd != null && halt ? Math.min(100, (dd / halt) * 100) : 0;
    $('#kDd').textContent = dd == null ? '—' : `${Number(dd).toFixed(1)}R / ${halt ?? '—'}R`;
    $('#kDdBar').style.setProperty('width', `${pct}%`);
    $('#kDdBar').parentElement.classList.toggle('hot', pct >= 60);
    $('#kDdSub').textContent = dd == null ? 'No heartbeat yet.' : `${pct.toFixed(0)}% of the halt · max ${Number(o.max_dd_r ?? 0).toFixed(1)}R`;
  }

  function renderSystem(d) {
    const s = d.status, u = d.uptime, sys = clear($('#sys'));
    if (s.last_heartbeat_ms == null) sys.append(kv('Status', el('span', { class: 'muted' }, 'Waiting for the first heartbeat')));
    else {
      const candles = Object.entries(s.last_candle_ms || {});
      sys.append(
        kv('Status', el('span', { class: s.alive ? 'good' : 'bad' }, s.alive ? 'ONLINE' : 'STALE')),
        kv('Last heartbeat', fmtHm(s.last_heartbeat_ms) + tzTag(), ago(s.last_heartbeat_ms)),
        kv('Last candle check', candles.length ? candles.map(([k, v]) => `${sym(k)} ${fmtShort(v)}`).join(' · ') : '—', candles.length ? ago(Math.max(...candles.map(([, v]) => v))) : null),
        kv('Next wake', s.next_wake_ms ? fmtHm(s.next_wake_ms) + tzTag() : '—', s.next_wake_ms ? until(s.next_wake_ms) : null),
        kv('Uptime (7d)', u ? el('span', { class: u.uptime_pct >= 99 ? 'good' : u.uptime_pct >= 95 ? 'warn' : 'bad' }, `${u.uptime_pct.toFixed(2)}%`) : '—',
          u ? el('small', {}, `${u.downtimes.length} outage${u.downtimes.length === 1 ? '' : 's'} · ${fmtDur(u.down_ms / 1000)} down · ${u.restarts.length} restart${u.restarts.length === 1 ? '' : 's'}`) : null),
        kv('Process up', fmtDur(s.uptime_sec)),
        kv('Kill switch', el('span', { class: s.kill_switch ? 'bad' : 'good' }, s.kill_switch ? 'ON · no new entries' : 'off')),
        kv('Coins', (s.enabled_coins || []).map(sym).join(' · ') || '—'),
        kv('Build', `${s.commit || '?'} · v${s.version || '?'}`));
    }

    // uptime timeline (red = no heartbeat for over 15 min)
    const bar = clear($('#upBar')), axis = clear($('#upAxis')), now = d.generated_at;
    bar.classList.toggle('none', !u);
    if (u) {
      const span = Math.max(1, now - u.since_ms);
      for (const g of u.downtimes) {
        const i = el('i', { title: `${fmtTime(g.from)} → ${g.to ? fmtTime(g.to) : 'now'} (${fmtDur(g.dur_ms / 1000)})` });
        i.style.setProperty('left', `${Math.max(0, ((g.from - u.since_ms) / span) * 100)}%`);
        i.style.setProperty('width', `${Math.max(0.3, (g.dur_ms / span) * 100)}%`);
        bar.append(i);
      }
      axis.append(el('span', {}, fmtShort(u.since_ms)), el('span', {}, 'now'));
    }
    const lines = [];
    if (u) {
      for (const g of u.downtimes) lines.push({ ts: g.from, tag: 'down', text: g.ongoing ? `no heartbeat since ${fmtShort(g.from)} · ongoing ${fmtDur(g.dur_ms / 1000)}` : `${fmtShort(g.from)} → ${fmtHm(g.to)} · ${fmtDur(g.dur_ms / 1000)} without heartbeat` });
      for (const r of u.restarts) lines.push({ ts: r.ts, tag: 'boot', text: 'process restarted' });
    }
    lines.sort((a, b) => b.ts - a.ts);
    const box = clear($('#downs'));
    if (!lines.length) box.append(el('div', { class: 'empty' }, u ? 'No downtime or restarts in the last 7 days.' : 'No heartbeat history yet.'));
    else box.append(...lines.map((l) => logLine(l.ts, l.tag, l.text)));
  }

  const logLine = (ts, tag, ...msg) => el('div', { class: 'ln' }, el('span', { class: 't' }, fmtShort(ts)), el('span', { class: `tag ${tag}` }, tag.toUpperCase()), el('span', { class: 'msg' }, ...msg));

  function renderActivity(d) {
    const box = clear($('#activity')), s = d.status, out = [];
    if (s.last_heartbeat_ms != null) out.push(logLine(s.last_heartbeat_ms, s.alive ? 'check' : 'down', s.alive ? 'heartbeat ok' : 'last heartbeat received', s.next_wake_ms ? ` · next wake ${fmtHm(s.next_wake_ms)}` : ''));
    for (const a of d.activity || []) {
      const coin = a.symbol ? `${sym(a.symbol)} ` : '';
      if (a.kind === 'entry') out.push(logLine(a.ts, 'entry', coin, sideEl(a.side), ` filled @ ${fmtPx(a.entry)} · SL ${fmtPx(a.sl)} · TP ${fmtPx(a.tp)}${a.risk_usd != null ? ` · risk ${fmtUsd(a.risk_usd)}` : ''}`));
      else if (a.kind === 'exit') out.push(logLine(a.ts, 'exit', coin, sideEl(a.side), ` ${a.reason} @ ${fmtPx(a.exit)} → `, el('span', { class: cls(a.r) }, `${fmtR(a.r)}${a.usd != null ? ` (${fmtUsd(a.usd, true)})` : ''}`)));
      else if (a.kind === 'skip') out.push(logLine(a.ts, 'skip', coin, sideEl(a.side), ` skipped: ${a.reason}${a.detail ? ` · ${a.detail}` : ''}`));
      else if (a.kind === 'check') out.push(logLine(a.ts, 'check', `4h candle ${a.candle_ms ? fmtShort(a.candle_ms) : ''} processed · total ${fmtR(a.total_r)}${a.balance != null ? ` · bal ${fmtUsd(a.balance)}` : ''}`));
      else if (a.kind === 'compare') out.push(logLine(a.ts, 'compare', 'live vs backtest ', el('span', { class: a.match ? 'good' : 'bad' }, a.match ? 'MATCH' : 'MISMATCH'), ` · ${a.matched ?? 0} matched${a.mismatches ? ` · ${a.mismatches} differ` : ''}`));
    }
    $('#actCount').textContent = `${(d.activity || []).length} events`;
    if (!out.length) box.append(el('div', { class: 'empty' }, 'Nothing logged yet.'));
    else box.append(...out);
  }

  function renderChart() {
    if (!data) return;
    for (const b of $$('#chartTabs button')) { const on = b.dataset.chart === chartKind; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    const d = data, note = $('#chartNote');
    if (chartKind === 'capital') {
      const pts = d.capital ? d.capital.points.map((p) => ({ ts: p.ts, y: p.usd })) : [];
      lineChart($('#chart'), pts, { fmtY: (v) => `$${v.toFixed(v >= 1000 ? 0 : 2)}`, empty: d.mode === 'live' ? 'Live balance is not shared with the dashboard. Switch to the R tab.' : 'No balance received yet.' });
      note.textContent = d.capital ? `Balance ${fmtUsd(d.capital.usd)} as of ${fmtTime(d.capital.as_of)} · ${fmtUsd(d.capital.change_usd, true)} (${fmtPct(d.capital.change_pct, true)}) since ${fmtUsd(d.capital.start_usd)}` : '';
    } else if (chartKind === 'r') {
      lineChart($('#chart'), d.equity.map((p) => ({ ts: p.ts, y: p.r_cum })), { fmtY: (v) => `${v.toFixed(1)}R` });
      note.textContent = d.equity.length ? `Cumulative R over ${d.overall.trades} closed trades: ${fmtR(d.overall.total_r)}` : '';
    } else {
      lineChart($('#chart'), d.equity.map((p) => ({ ts: p.ts, y: p.dd_r })), { dd: true, fmtY: (v) => `${v.toFixed(1)}R` });
      note.textContent = d.equity.length ? `Max drawdown ${Number(d.overall.max_dd_r).toFixed(1)}R · now ${Number(d.equity[d.equity.length - 1].dd_r).toFixed(1)}R · halt at ${d.status.halt_r != null ? Math.abs(d.status.halt_r) : '—'}R` : '';
    }
  }

  function renderTrades() {
    if (!data) return;
    const f = filters, from = f.from ? Date.parse(f.from + 'T00:00:00Z') : null, to = f.to ? Date.parse(f.to + 'T23:59:59Z') : null;
    const rows = data.trades.filter((t) => (!f.coin || t.symbol === f.coin) && (!f.side || t.side === f.side) && (!f.reason || t.reason === f.reason) && (from == null || t.exit_ts >= from) && (to == null || t.exit_ts <= to)).sort((a, b) => b.exit_ts - a.exit_ts);
    const total = rows.reduce((a, t) => a + t.r, 0), hasUsd = rows.some((t) => t.usd != null), usd = rows.reduce((a, t) => a + (t.usd || 0), 0);
    const sum = clear($('#tradeSummary'));
    sum.append(`${rows.length} trade${rows.length === 1 ? '' : 's'} · total `, el('span', { class: cls(total) }, fmtR(total)), hasUsd ? el('span', { class: cls(usd) }, ` (${fmtUsd(usd, true)})`) : '');
    clear($('#trades')).append(table([
      { h: 'Exit time', left: true, f: (r) => fmtShort(r.exit_ts) }, { h: 'Coin', left: true, f: (r) => el('span', {}, `${sym(r.symbol)} `, sideEl(r.side)) }, { h: 'Entry', f: (r) => fmtPx(r.entry) }, { h: 'SL', f: (r) => fmtPx(r.sl) }, { h: 'TP', f: (r) => fmtPx(r.tp) },
      { h: 'Exit', f: (r) => fmtPx(r.exit) }, { h: 'Why', f: (r) => el('span', { class: `chip ${r.reason}` }, r.reason) }, { h: 'R', f: (r) => fmtR(r.r), c: (r) => cls(r.r) },
      ...(hasUsd ? [{ h: 'P&L', f: (r) => fmtUsd(r.usd, true), c: (r) => cls(r.usd) }] : []), { h: 'Held', f: (r) => fmtDur(r.hold_sec) },
    ], rows, 'No trades match.'));
  }

  // every second: the clock and every "x ago" / "in x" stays current without refetching
  function tick() {
    const now = Date.now(), p = parts(now);
    $('#clock').textContent = `${fmtDay(now)} ${clock12(p, true)}${tz === 'utc' ? ' UTC' : ''}`;
    for (const n of $$('[data-ago]')) n.textContent = `${fmtDur((now - Number(n.dataset.ago)) / 1000)} ago`;
    for (const n of $$('[data-until]')) { const t = Number(n.dataset.until); n.textContent = t > now ? `in ${fmtDur((t - now) / 1000)}` : 'due now'; }
  }

  // ---------------- settings menu ----------------
  const menu = $('#menu'), menuBtn = $('#menuBtn');
  function setMenu(open) { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', open); }
  function syncMenu() {
    for (const b of $$('[data-tz]')) b.classList.toggle('on', b.dataset.tz === tz);
    const theme = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    for (const b of $$('[data-theme-set]')) b.classList.toggle('on', b.dataset.themeSet === theme);
  }
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); syncMenu(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); }
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !$('#app').hidden) load();
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tz) { tz = b.dataset.tz; store.set('bot.tz', tz); if (data) render(data); }
    if (b.dataset.themeSet) { document.documentElement.setAttribute('data-theme', b.dataset.themeSet); store.set('bot.theme', b.dataset.themeSet); }
    if (b.dataset.mode) { modeSel = b.dataset.mode; store.set('bot.mode', modeSel); load(); }
    syncMenu();
  });
  $('#chartTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; chartKind = b.dataset.chart; store.set('bot.chart', chartKind); renderChart(); });

  // ---------------- VPS specs panel ----------------
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
  function serverArt() {
    const s = sv('svg', { viewBox: '0 0 120 96', class: 'srv', 'aria-hidden': 'true' });
    [8, 36, 64].forEach((y, i) => {
      s.append(sv('rect', { class: 'unit', x: 6, y, width: 108, height: 24, rx: 6 }), sv('rect', { class: 'slot', x: 14, y: y + 9, width: 44, height: 6, rx: 3 }));
      s.append(sv('circle', { class: i === 0 ? 'led on' : 'led', cx: 94, cy: y + 12, r: 3 }), sv('circle', { class: 'led on', cx: 104, cy: y + 12, r: 3 }));
    });
    return s;
  }
  const spec = (ico, title, big, sub, extra) => el('div', { class: 'spec' },
    el('div', { class: 'spec-top' }, el('span', { class: 'spec-ico' }, icon(ico)), el('span', { class: 'k' }, title)),
    el('div', { class: 'spec-big' }, big), el('div', { class: 'spec-sub' }, sub), extra);
  const usage = (pct, label, big, sub) => el('div', { class: 'spec withring' }, el('div', {},
    el('div', { class: 'spec-top' }, el('span', { class: 'spec-ico' }, icon(label === 'Memory' ? ICON.ram : ICON.disk)), el('span', { class: 'k' }, label)),
    el('div', { class: 'spec-big' }, big), el('div', { class: 'spec-sub' }, sub)), ring(pct, label));

  function renderVps(v) {
    const ramPct = (v.ram.used_gb / v.ram.total_gb) * 100, up = v.booted ? Date.parse(v.booted) : null;
    clear($('#vpsBody')).append(
      el('div', { class: 'vpshero' }, serverArt(), el('div', {}, el('div', { class: 'spec-big' }, `${v.provider} VPS`), el('div', { class: 'spec-sub' }, `${v.os} · ${v.arch}`),
        el('div', { class: 'chips' }, el('span', { class: 'chip' }, v.location), el('span', { class: 'chip' }, `${v.cpu.vcpu} vCPU`), el('span', { class: 'chip' }, `${v.ram.total_gb} GB RAM`), el('span', { class: 'chip' }, `${v.disk.total_gb} GB disk`)))),
      el('div', { class: 'specgrid' },
        spec(ICON.cpu, 'Processor', `${v.cpu.vcpu} vCPU`, `${v.cpu.model} @ ${v.cpu.clock}`),
        usage(ramPct, 'Memory', `${v.ram.total_gb} GB`, `${v.ram.used_gb} GB in use at setup`),
        usage(v.disk.used_pct, 'Storage', `${v.disk.total_gb} GB`, `${v.disk.used_gb} GB used on ${v.disk.mount}`),
        spec(ICON.os, 'Operating system', v.os, `Kernel ${v.kernel} · ${v.arch}`),
        spec(ICON.pin, 'Location', v.location, `Hosted by ${v.provider}`),
        spec(ICON.clock, 'Last boot', up ? fmtTime(up) : '—', up ? `up ${fmtDur((Date.now() - up) / 1000)} (since that boot)` : ''),
        spec(ICON.shield, 'Bot memory limit', v.bot_limits.hard, `soft limit ${v.bot_limits.soft}, hard limit ${v.bot_limits.hard} (systemd)`)),
      el('p', { class: 'muted note' }, `Snapshot taken ${v.as_of}. Usage figures are from that day; the plan itself does not change unless you resize it.`));
  }
  async function openVps() {
    setMenu(false);
    const dlg = $('#vpsDlg'), body = clear($('#vpsBody'));
    body.append(el('div', { class: 'empty' }, 'Loading…'));
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
    try {
      const res = await fetch('/api/vps', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) { closeVps(); return showLogin(''); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderVps(await res.json());
    } catch (e) { clear(body).append(el('div', { class: 'empty' }, `Could not load the specs: ${e.message}`)); }
  }
  function closeVps() { const d = $('#vpsDlg'); if (d.close) d.close(); else d.removeAttribute('open'); }
  $('#vpsBtn').addEventListener('click', openVps);
  $('#vpsClose').addEventListener('click', closeVps);
  $('#vpsDlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeVps(); });

  // ---------------- data + login ----------------
  async function load() {
    $('#promptCmd').textContent = 'status --refresh';
    try {
      const res = await fetch('/api/data' + (modeSel ? `?mode=${encodeURIComponent(modeSel)}` : ''), { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) return showLogin('');
      if (res.status === 503) return showLogin('The dashboard login is not configured on the server (set DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET in Vercel).');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $('#boot').hidden = true; $('#login').hidden = true; $('#app').hidden = false; $('#logoutBtn').hidden = false; $('#vpsBtn').hidden = false;
      render(await res.json());
    } catch (e) { showLogin(`Could not load data: ${e.message}`); }
    finally { $('#promptCmd').textContent = 'status --watch'; }
  }
  function showLogin(msg) { $('#boot').hidden = true; $('#app').hidden = true; $('#login').hidden = false; $('#logoutBtn').hidden = true; $('#vpsBtn').hidden = true; $('#statusPill').hidden = true; $('#loginMsg').textContent = msg; }

  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('#loginMsg').textContent = '';
    try {
      const res = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
      $('#pw').value = '';
      if (res.ok) return load();
      $('#loginMsg').textContent = res.status === 429 ? 'Too many attempts. Wait a few minutes.' : res.status === 503 ? 'Login is not configured on the server.' : 'Wrong password.';
    } catch { $('#loginMsg').textContent = 'Network error.'; }
  });
  $('#logoutBtn').addEventListener('click', async () => { setMenu(false); try { await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }); } catch {} showLogin(''); });
  $('#refreshBtn').addEventListener('click', () => { setMenu(false); load(); });
  for (const [id, k] of [['fCoin', 'coin'], ['fSide', 'side'], ['fReason', 'reason'], ['fFrom', 'from'], ['fTo', 'to']]) $(`#${id}`).addEventListener('change', (e) => { filters[k] = e.target.value; renderTrades(); });

  tick();
  load();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !$('#app').hidden) load(); }, 60000);   // keeps the alive/stale status honest
})();

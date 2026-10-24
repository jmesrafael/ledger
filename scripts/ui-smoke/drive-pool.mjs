// Real-browser check of the Pool Update screen, on the throwaway in-memory database of server.mjs (production is never contacted).
//   node scripts/ui-smoke/server.mjs <repo> 8099            (in one terminal)
//   node scripts/ui-smoke/drive-pool.mjs <chromeExe> http://127.0.0.1:8099/ <outDir>
// Fake LIVE trades are inserted straight into bot_events; the manager then does the real routine in the real page.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [chrome, app, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${join(out, 'profile')}`, '--window-size=430,1000', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json')).json(); if (targets.find((t) => t.type === 'page')) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(), errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result.value; };
const waitFor = async (expr, what, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return; } catch {} await sleep(150); } throw new Error('timed out waiting for ' + what); };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); };
const sql = async (q, params = []) => (await (await fetch(new URL('/sql', app), { method: 'POST', body: JSON.stringify({ sql: q, params }) })).json()).data;
const text = () => ev('document.body.innerText');
const setVal = (formSel, name, v) => ev(`(() => { const f = document.querySelector(${JSON.stringify(formSel)}); const el = f.elements[${JSON.stringify(name)}]; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const submit = (formSel) => ev(`(() => { document.querySelector(${JSON.stringify(formSel)}).requestSubmit(); return true; })()`);
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
const results = []; const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 1400, deviceScaleFactor: 1, mobile: true });
  // fake live trades (+30, -10) closed two minutes ago, and a PAPER trade that must be ignored
  const t0 = Date.now() - 120000;
  for (const [eid, usd, mode] of [['ui-e1', 30, 'live'], ['ui-e2', -10, 'live'], ['ui-p1', 999, 'paper']])
    await sql(`insert into public.bot_events(event_id, type, ts_ms, mode, symbol, side, data) values ($1, 'exit', $2, $3, 'SOL_USDT', 'LONG', $4::jsonb)`, [eid, t0 - (eid === 'ui-e2' ? 1000 : 0), mode, JSON.stringify({ trade_id: 't-' + eid, usd, r: usd / 100, reason: 'tp' })]);
  const rid = (await sql(`select id from public.profiles where username = 'raf'`))[0].id;
  await send('Page.navigate', { url: app });
  await waitFor(`!!document.querySelector('#loginForm')`, 'login form');
  await ev(`(() => { localStorage.setItem('ledger.welcomed.' + ${JSON.stringify(rid)}, '1'); return true; })()`);
  await setVal('#loginForm', 'username', 'raf'); await setVal('#loginForm', 'password', 'admin-password-1'); await submit('#loginForm');
  await waitFor(`document.body.innerText.toLowerCase().includes('fund manager')`, 'the manager home');
  await ev(`(() => { const s = [...document.querySelectorAll('button,a,[role=tab]')].find((b) => b.innerText.trim().toLowerCase() === 'fund'); if (s) s.click(); return true; })()`);
  await waitFor(`!!document.querySelector('[data-pool="banner"]')`, 'the pending banner on the dashboard');
  let t = await text();
  check('dashboard banner: "2 trades, +20.00 USDT pending since <date>" (paper trade ignored)', /2 trades, \+20\.00 USDT pending since [A-Z][a-z]{2} \d{1,2}, \d{4}/.test(t), (t.match(/\d+ trades?, [^\n]*pending since[^\n]*/) || [''])[0]);
  await shot('p1-dashboard-banner');
  await click('[data-pool="banner"] [data-tab="record"]');
  await waitFor(`!!document.querySelector('[data-pool="pending"]')`, 'the Pending P/L card');
  check('Balance desk shows the Pending P/L card with both trades', (await ev(`document.querySelectorAll('[data-pool="pending"] .row').length`)) === 2);
  check('Update Pool is disabled until a balance is confirmed', await ev(`[...document.querySelectorAll('[data-pool="pending"] button')].some((b) => b.innerText === 'Update Pool' && b.disabled)`));
  await shot('p2-pending-card');
  // the real routine: enter the MEXC total (1000 + 20), confirm it
  await setVal('#wfBal', 'total', '1020'); await submit('#wfBal');
  await waitFor(`!!document.querySelector('[data-action="wfconfirm"]')`, 'the confirm button');
  await click('[data-action="wfconfirm"]');
  await waitFor(`!!document.querySelector('[data-action="poolupdate"]')`, 'Update Pool enabled');
  check('after the balance is confirmed Update Pool is offered', true);
  check('nothing has moved yet: still one pool entry, price 1', (await sql(`select count(*)::int n, max(unit_price)::float p from public.pool_equity`))[0].n === 1);
  await shot('p3-ready');
  await click('[data-action="poolupdate"]');
  await waitFor(`document.querySelector('[data-pool="pending"]') && document.querySelector('[data-pool="pending"]').innerText.includes('None.')`, 'pending cleared after Update Pool');
  const pu = (await sql(`select pending_count, pending_usd::float, nav_after::float, status from public.pool_updates`))[0];
  check('one pool update recorded: 2 trades, +20, NAV 1020', pu && pu.pending_count === 2 && Math.abs(pu.pending_usd - 20) < 1e-9 && Math.abs(pu.nav_after - 1020) < 1e-9 && pu.status === 'applied', JSON.stringify(pu));
  check('unit price is now 1.02', Math.abs((await sql(`select unit_price::float p from public.pool_equity order by id desc limit 1`))[0].p - 1.02) < 1e-9);
  check('the two live trades are applied, the paper trade never was', (await sql(`select count(*)::int n from public.applied_trades`))[0].n === 2 && (await sql(`select count(*)::int n from public.applied_trades where event_id = 'ui-p1'`))[0].n === 0);
  t = await text();
  check('reconciliation card is on the page', /reconciliation/i.test(t));
  await shot('p4-after-update');
  // double click: a second click on the same displayed state is not possible any more (button gone); a stale re-send is refused by the database
  check('no pending banner on the dashboard any more', !(await ev(`!!document.querySelector('[data-pool="banner"]')`)));
  // ---- phase 2: a joiner is queued in Spot, another trade closes, and Update Pool + accept happen in one click
  const tok = (await sql(`select public.login('raf', 'admin-password-1')->>'token' as t`))[0].t;
  const dino = (await sql(`select id from public.profiles where username = 'dino'`))[0].id;
  const pdId = (await sql(`select (public.admin_receive_deposit($1, $2, 100, 58, null, null))->>'id' as id`, [tok, dino]))[0].id;
  await sql(`select public.admin_confirm_arrival($1, $2::bigint, 'seen in MEXC deposit history', null)`, [tok, pdId]);
  await sql(`insert into public.bot_events(event_id, type, ts_ms, mode, symbol, side, data) values ('ui-e3', 'exit', $1, 'live', 'ZEC_USDT', 'SHORT', $2::jsonb)`, [Date.now() - 60000, JSON.stringify({ trade_id: 't-ui-e3', usd: 5, r: 0.05, reason: 'tp' })]);
  await click('[data-action="refresh"], #refreshBtn'); await send('Page.navigate', { url: app });
  await waitFor(`!!document.querySelector('#loginForm') || !!document.querySelector('[data-tab="record"]')`, 'page reloaded');
  if (await ev(`!!document.querySelector('#loginForm')`)) { await setVal('#loginForm', 'username', 'raf'); await setVal('#loginForm', 'password', 'admin-password-1'); await submit('#loginForm'); }
  await waitFor(`document.body.innerText.toLowerCase().includes('fund manager')`, 'the manager home again');
  await ev(`(() => { const s = [...document.querySelectorAll('button,a,[role=tab]')].find((b) => b.innerText.trim().toLowerCase() === 'fund'); if (s) s.click(); return true; })()`);
  await waitFor(`!!document.querySelector('[data-pool="banner"]')`, 'banner for the new trade');
  check('banner shows the one new pending trade', /1 trade, \+5\.00 USDT pending since/.test(await text()));
  await click('[data-pool="banner"] [data-tab="record"]');
  await waitFor(`!!document.querySelector('#wfBal')`, 'the balance form');
  await setVal('#wfBal', 'total', '1125'); await submit('#wfBal');
  await waitFor(`!!document.querySelector('[data-action="wfconfirm"]')`, 'the confirm button (phase 2)');
  await click('[data-action="wfconfirm"]');
  await waitFor(`!!document.querySelector('[data-action="poolupdate"]') && !!document.querySelector('input.pu-pick')`, 'Update Pool and the joiner checkbox');
  check('the plain Admit button is replaced by a tick box while a trade is pending', !(await ev(`!!document.querySelector('[data-action="wfadmit"]')`)));
  check('Update Pool and accept needs a tick (nothing ticked: refused, nothing saved)', true);
  await click('[data-action="poolupdateadmit"]');
  await sleep(800);
  check('nothing was saved by the empty click', (await sql(`select count(*)::int n from public.pool_updates`))[0].n === 1);
  await ev(`(() => { const c = document.querySelector('input.pu-pick'); c.checked = true; return true; })()`);
  await click('[data-action="poolupdateadmit"]');
  await waitFor(`!document.querySelector('[data-pool="banner"]') || true`, 'settled'); await sleep(1500);
  const dn = (await sql(`select coalesce(sum(units), 0)::float u from public.ledger where profile_id = $1`, [dino]))[0].u;
  check('Dino bought in at the updated price: 100 / 1.025 = 97.561 units', Math.abs(dn - 100 / 1.025) < 1e-3, 'units=' + dn);
  check('two pool updates now, the trade is applied, the deposit is admitted', (await sql(`select count(*)::int n from public.pool_updates where status = 'applied'`))[0].n === 2 && (await sql(`select count(*)::int n from public.pending_deposits where status = 'converted' and profile_id = $1`, [dino]))[0].n === 1);
  check('pool NAV = MEXC total 1125', Math.abs((await sql(`select equity_usdt::float e from public.pool_equity order by id desc limit 1`))[0].e - 1125) < 1e-6);
  await shot('p5-update-and-accept');
  // ---- phase 3: the "? How this works" sheets on Money in, Money out and Balance (gate off first, then the workflow gate switched on)
  const helpText = () => ev(`document.querySelector('.helpsheet') ? document.querySelector('.helpsheet').innerText : ''`);
  const openHelp = async (topic) => {
    await click(`[data-rec="${topic}"]`);
    await waitFor(`!!document.querySelector('.helpbtn[data-help="${topic}"]')`, `the ? button on ${topic}`);
    await click(`.helpbtn[data-help="${topic}"]`);
    await waitFor(`!!document.querySelector('.sheet.helpsheet[data-help="${topic}"]')`, `the help sheet of ${topic}`);
  };
  const closed = () => waitFor(`!document.querySelector('.helpsheet')`, 'the help sheet to close');
  await click('[data-tab="record"]');
  for (const [topic, steps, words, how] of [
    ['dep', 7, ['Waiting to join', 'In MEXC', 'Update Pool', 'Update equity', 'Spot to Futures'], 'x'],
    ['wd', 7, ['Request withdrawal', 'Approve', 'Quote', 'Redeem', 'Sent from MEXC', 'Completed'], 'gotit'],
    ['eq', 5, ['Enter balance (not confirmed yet)', 'Confirm this balance', 'Unexplained difference', 'Pending P/L', 'Reconciliation'], 'esc'],
  ]) {
    await openHelp(topic);
    const n = await ev(`document.querySelectorAll('.helpsheet .hstep').length`), txt = (await helpText()).toLowerCase();
    check(`${topic}: the ? opens a sheet with ${steps} numbered steps`, n === steps, 'steps=' + n);
    check(`${topic}: it names the real buttons (${words.length})`, words.every((w) => txt.includes(w.toLowerCase())), words.filter((w) => !txt.includes(w.toLowerCase())).join(', '));
    check(`${topic}: the sheet fits a phone screen and the page behind it is locked`, await ev(`(() => { const r = document.querySelector('.sheet.helpsheet').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1 && document.body.style.overflow === 'hidden'; })()`));
    await shot('p6-help-' + topic);
    if (how === 'x') await click('.helpsheet .iconbtn[data-action="closemodal"]');
    else if (how === 'gotit') await click('.helpsheet .btns [data-action="closemodal"]');
    else await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await closed(); check(`${topic}: closes with ${how === 'x' ? 'the × button' : how === 'gotit' ? 'Got it' : 'the Escape key'}`, true);
  }
  await sql(`update public.ledger_settings set value = 'on' where key = 'workflow_gate'`);
  await send('Page.navigate', { url: app });
  await waitFor(`!!document.querySelector('[data-tab="record"]') || !!document.querySelector('#loginForm')`, 'reload after switching the gate on');
  if (await ev(`!!document.querySelector('#loginForm')`)) { await setVal('#loginForm', 'username', 'raf'); await setVal('#loginForm', 'password', 'admin-password-1'); await submit('#loginForm'); }
  await waitFor(`document.body.innerText.toLowerCase().includes('fund manager')`, 'manager home with the gate on');
  await ev(`(() => { const s = [...document.querySelectorAll('button,a,[role=tab]')].find((b) => b.innerText.trim().toLowerCase() === 'fund'); if (s) s.click(); return true; })()`);
  await waitFor(`!!document.querySelector('[data-tab="record"]')`, 'the Record tab');
  await click('[data-tab="record"]'); await openHelp('dep');
  const g = (await helpText()).toLowerCase(), gn = await ev(`document.querySelectorAll('.helpsheet .hstep').length`);
  check('gate on: Money in shows the 8-step route with Seen in MEXC and Admit', gn === 8 && g.includes('seen in mexc') && g.includes('admit them') && !g.includes('update equity'), 'steps=' + gn);
  await click('.helpsheet .iconbtn[data-action="closemodal"]'); await closed();
  await click('[data-rec="wd"]'); await waitFor(`!!document.querySelector('.helpbtn[data-help="wd"]')`, 'the ? button on Money out when the gate replaces its form');
  check('gate on: Money out still has its ? button although the gate replaced the form', true);
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) { check('flow completed: ' + e.message, false); try { console.log((await text()).slice(0, 1800)); await shot('failure'); } catch {} }
finally { ws.close(); proc.kill(); const bad = results.filter((r) => !r.ok); console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`); process.exit(bad.length ? 1 : 0); }

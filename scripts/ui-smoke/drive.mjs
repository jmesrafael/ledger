// Minimal Chrome DevTools driver (Node 24 has a global WebSocket). Usage: node drive.mjs <chromeExe> <appUrl> <outDir>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [chrome, app, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${join(out, 'profile')}`, '--window-size=430,1000', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); if (targets.find((t) => t.type === 'page')) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(), errors = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' ')); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed'); return r.result.result.value; };
const waitFor = async (expr, what, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return; } catch {} await sleep(150); } throw new Error('timed out waiting for ' + what); };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); };
const sql = async (q, params = []) => (await (await fetch(new URL('/sql', app), { method: 'POST', body: JSON.stringify({ sql: q, params }) })).json()).data;
const text = () => ev('document.body.innerText.toLowerCase()');
const setVal = (formSel, name, v) => ev(`(() => { const f = document.querySelector(${JSON.stringify(formSel)}); const el = f.elements[${JSON.stringify(name)}]; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const submit = (formSel) => ev(`(() => { const f = document.querySelector(${JSON.stringify(formSel)}); f.requestSubmit(); return true; })()`);
const results = []; const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 1000, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: app });
  await waitFor(`!!document.querySelector('#loginForm')`, 'login form');
  // ---- investor (a returning one: terms already accepted, welcome tour already seen)
  const jid = (await sql(`select id from public.profiles where username = 'john'`))[0].id;
  await sql(`insert into public.terms_acceptances(profile_id, version) values ($1, '2026-10-25')`, [jid]);
  await ev(`(() => { localStorage.setItem('ledger.welcomed.' + ${JSON.stringify(jid)}, '1'); return true; })()`);
  await setVal('#loginForm', 'username', 'john'); await setVal('#loginForm', 'password', 'john-password'); await submit('#loginForm');
  await waitFor(`document.body.innerText.toLowerCase().includes('how to reach me')`, 'the contact card on Home');
  check('investor Home shows the "How to reach me" card with a prompt to add it', (await text()).includes('please add this'));
  await shot('01-investor-home');
  await setVal('#contactForm', 'phone', 'abc'); await submit('#contactForm');
  await waitFor(`document.getElementById('toast').innerText.toLowerCase().includes('contact number')`, 'validation message');
  check('a bad phone number is refused with a plain message', true, await ev(`document.getElementById('toast').innerText`));
  check('nothing was saved by the refused form', (await sql(`select count(*)::int n from public.contact_details`))[0].n === 0);
  await setVal('#contactForm', 'phone', '0917 123 4567'); await setVal('#contactForm', 'email', 'John@Example.com'); await setVal('#contactForm', 'en', 'Maria Reyes'); await setVal('#contactForm', 'ep', '0918 765 4321');
  await submit('#contactForm');
  await waitFor(`document.getElementById('toast').innerText.toLowerCase().includes('contact details saved')`, 'saved toast');
  const row = (await sql(`select phone, email, emergency_name, emergency_phone from public.contact_details`))[0];
  check('saved in the database, cleaned', row && row.phone === '0917 123 4567' && row.email === 'john@example.com' && row.emergency_name === 'Maria Reyes', JSON.stringify(row));
  await waitFor(`document.body.innerText.toLowerCase().includes('update contact details')`, 'card switches to update mode');
  check('the card now says it is used only to contact you, and the form is pre-filled', (await text()).includes('used only to contact you') && (await ev(`document.querySelector('#contactForm').elements.phone.value`)) === '0917 123 4567');
  await shot('02-investor-saved');
  // ---- manager
  const rid = (await sql(`select id from public.profiles where username = 'raf'`))[0].id;
  await ev(`(() => { localStorage.clear(); localStorage.setItem('ledger.welcomed.' + ${JSON.stringify(rid)}, '1'); return true; })()`);
  await send('Page.navigate', { url: app });
  await waitFor(`!!document.querySelector('#loginForm')`, 'login form again');
  await setVal('#loginForm', 'username', 'raf'); await setVal('#loginForm', 'password', 'admin-password-1'); await submit('#loginForm');
  await waitFor(`document.body.innerText.toLowerCase().includes('fund manager')`, 'the manager home');
  await ev(`(() => { const s = [...document.querySelectorAll('button,a,[role=tab]')].find((b) => b.innerText.trim().toLowerCase() === 'fund'); if (s) s.click(); return true; })()`);
  await waitFor(`!!document.querySelector('[data-tab="users"]')`, 'the Users tab');
  await ev(`(() => { document.querySelector('[data-tab="users"]').click(); return true; })()`);
  await waitFor(`document.body.innerText.toLowerCase().includes('dino cruz')`, 'the Users list');
  const t = await text();
  check('Users list flags the person with no contact details (and not the one who added them)', /dino cruz[\s\S]{0,40}no contact/.test(t) && !/john reyes[\s\S]{0,12}no contact/.test(t));
  await shot('03-manager-users');
  await ev(`(() => { const nm = [...document.querySelectorAll('.ucard')].find((c) => c.innerText.includes('Dino')); nm.querySelector('[data-action=userview]').click(); return true; })()`);
  await waitFor(`!!document.querySelector('.adminContactForm')`, "Dino's sheet");
  check("Dino's sheet says no contact details are on file", (await text()).includes('no contact details on file'));
  await setVal('.adminContactForm', 'phone', '+63 905 111 2222'); await setVal('.adminContactForm', 'email', 'dino@example.com'); await submit('.adminContactForm');
  await waitFor(`document.getElementById('toast').innerText.toLowerCase().includes('contact details saved')`, 'manager saved toast');
  const d = (await sql(`select p.username, c.phone, c.email from public.contact_details c join public.profiles p on p.id = c.profile_id order by 1`));
  check("manager recorded Dino's details; John's are untouched", d.length === 2 && d[0].username === 'dino' && d[0].phone === '+63 905 111 2222' && d[1].phone === '0917 123 4567', JSON.stringify(d));
  const hist = (await sql(`select count(*)::int n from public.contact_history`))[0].n;
  check('each save is in the history', hist === 2, 'rows=' + hist);
  await sleep(1200);
  for (let k = 0; k < 6; k++) {
    await ev(`(() => { const c = [...document.querySelectorAll('.ucard')].find((c) => c.innerText.includes('John')); if (c) c.querySelector('[data-action=userview]').click(); return true; })()`);
    await sleep(700);
    if (await ev(`!!document.querySelector('.sheet')`)) break;
  }
  await waitFor(`!!document.querySelector('.sheet')`, "John's sheet", 3000);
  check("John's contact section starts collapsed (his details are on file), so it does not clutter the sheet", await ev(`!document.querySelector('.sheet details').open`));
  await ev(`(() => { document.querySelector('.sheet details summary').click(); return true; })()`);
  await waitFor(`document.body.innerText.toLowerCase().includes('maria reyes')`, "John's emergency contact", 3000);
  check("manager sees John's phone link, email and emergency contact", await ev(`!!document.querySelector('a[href="tel:09171234567"]') && !!document.querySelector('a[href="mailto:john@example.com"]')`));
  await shot('04-manager-john-sheet');
  check('no script errors in the page', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('harness ran to the end', false, String(e.message || e).slice(0, 300));
  try { await shot('failure'); console.log('page text:', (await text()).slice(0, 600)); } catch {}
  console.log('errors:', errors.join(' | ').slice(0, 400));
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
  console.log(results.filter((r) => r.ok).length + '/' + results.length + ' passed');
  try { ws.close(); } catch {} proc.kill();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

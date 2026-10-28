// Stage 1 (usability): investor position + actions, the settlement preview screen, confirmation sheets. No accounting changed: these tests check that the
// screens only print what the database sent, that unavailable data reads "Not available", and (on an in-memory Postgres running the real migrations) that the
// preview the screen prints is the very figure the settlement then charges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const require = createRequire(import.meta.url);
const CS = require('../js/confirmsheet.js'), SP = require('../js/settlepreview.js'), IC = require('../js/investorctx.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js'), html = read('login.html');
const strip = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const fmt = { usdt: (n) => Number(n).toFixed(2) + ' USDT', units: (n) => Number(n).toFixed(4), day: (t) => String(t).slice(0, 10), pc: (r) => String(Number(r) * 100) };
const icFmt = { money: (n) => Number(n).toFixed(2) + ' USDT', units: (n) => Number(n).toFixed(4), day: (t) => String(t).slice(0, 10) };

// ---------------------------------------------------------------- confirmation sheets
test('S1 the sheet is a labelled, modal dialog; a danger sheet is an alertdialog; an info sheet has one button; user text is escaped', () => {
  const h = CS.html({ title: 'Redeem <b>now</b>?', text: 'Line one\nLine <i>two</i>', danger: true, confirmLabel: 'Redeem', fields: [{ name: 'why', label: 'Why?', type: 'textarea', required: true, minLength: 10, hint: 'At least 10.' }] }, 'x');
  assert.match(h, /role="alertdialog"/); assert.match(h, /aria-modal="true"/); assert.match(h, /aria-labelledby="x-t"/); assert.match(h, /for="x-f0"/);
  assert.match(h, /aria-required="true"/); assert.match(h, /role="alert"/);
  assert.ok(!h.includes('<b>now</b>') && !h.includes('<i>two</i>'), 'titles and text are escaped');
  assert.match(h, /data-cs="cancel"/);
  const info = CS.html({ title: 'Quote', text: 'ok', info: true }, 'y');
  assert.ok(!info.includes('data-cs="cancel"') && /role="dialog"/.test(info));
});

test('S2 validation: required, minimum length, numbers; values are trimmed', () => {
  const fields = [{ name: 'n', label: 'N', required: true, minLength: 20 }, { name: 'a', label: 'A', type: 'number', min: 0 }];
  let v = CS.validate(fields, { n: '', a: '' }); assert.equal(v.ok, false); assert.match(v.errors.n, /needed/);
  v = CS.validate(fields, { n: 'too short', a: 'x' }); assert.match(v.errors.n, /at least 20/); assert.match(v.errors.a, /number/);
  v = CS.validate(fields, { n: '  ' + 'x'.repeat(20) + '  ', a: '-1' }); assert.match(v.errors.a, /at least 0/);
  v = CS.validate(fields, { n: '  ' + 'x'.repeat(20) + '  ', a: '3' }); assert.equal(v.ok, true); assert.equal(v.values.n.length, 20);
});

// ---------------------------------------------------------------- investor position and actions
const john = { id: 'j1', role: 'investor', active: true, name: 'John', username: 'john', units: '10.5', value_usdt: '1200', net_value_usdt: '1180', hwm_usdt: '1100', accrued_fee_usdt: '20', below_hwm_usdt: '0' };

test('S3 an investor with units gets Add Money, Withdraw and Full Exit; every number is the database\'s', () => {
  const a = IC.actions(john); assert.ok(a.add.ok && a.withdraw.ok && a.exit.ok);
  const h = IC.card(john, { pend: [], reqs: [], queue: null, pu: null, fmt: icFmt });
  for (const t of ['Add Money', 'Withdraw', 'Full Exit']) assert.ok(h.includes(t), t);
  for (const t of ['10.5000', '1180.00 USDT', '1100.00 USDT', '20.00 USDT']) assert.ok(h.includes(t), t);
  assert.equal((h.match(/data-action="invact"/g) || []).length, 3);
  for (const k of ['add', 'withdraw', 'exit']) assert.ok(h.includes(`data-inv="${k}"`));
});

test('S4 no units: Withdraw and Full Exit are disabled with the reason; a deactivated account cannot be added to; the manager row has no actions', () => {
  const none = { ...john, units: '0' };
  let a = IC.actions(none); assert.ok(a.add.ok && !a.withdraw.ok && !a.exit.ok); assert.match(a.exit.why, /no units/i);
  let h = IC.card(none, { fmt: icFmt }); assert.equal((h.match(/data-action="invact"/g) || []).length, 1); assert.match(h, /disabled aria-disabled="true"/);
  a = IC.actions({ ...john, active: false }); assert.ok(!a.add.ok && a.withdraw.ok); assert.match(a.add.why, /deactivated/i);
  const mgr = { ...john, role: 'admin' }; a = IC.actions(mgr); assert.ok(!a.add.ok && !a.withdraw.ok && !a.exit.ok);
  h = IC.card(mgr, { fmt: icFmt }); assert.ok(!h.includes('data-action="invact"') && !h.includes('Add Money'));
  assert.ok(!IC.actions(null).add.ok);
});

test('S5 missing data reads "Not available", never 0; pending items are only the investor\'s own', () => {
  const h = IC.card({ ...john, hwm_usdt: undefined, accrued_fee_usdt: null, below_hwm_usdt: undefined, net_value_usdt: undefined, value_usdt: undefined }, { fmt: icFmt });
  assert.ok((h.match(/Not available/g) || []).length >= 4, 'several unavailable values');
  assert.ok(!/0\.00 USDT/.test(h), 'no invented zero');
  assert.match(IC.tradeStatus({}), /Not available/);
  const ctx = { fmt: icFmt,
    pend: [{ profile_id: 'j1', usdt: '500', arrived_at: null }, { profile_id: 'other', usdt: '999', arrived_at: '2026-01-01' }],
    reqs: [{ profile_id: 'j1', status: 'pending', units: '2', pay_by: '2026-11-05' }, { profile_id: 'j1', status: 'paid', units: '9', pay_by: '2026-10-01' }, { profile_id: 'other', status: 'pending', units: '7', pay_by: '2026-11-05' }],
    queue: { deposits: [], ready: { ok: false, reasons: [{ code: 'open_positions', text: 'A trade is still open.' }] } }, pu: { pending: { count: 2 } } };
  const c = IC.card(john, ctx);
  assert.ok(c.includes('500.00 USDT') && c.includes('not in the exchange yet') && !c.includes('999'));
  assert.ok(c.includes('2.0000 units') && !c.includes('9.0000') && !c.includes('7.0000'));
  assert.ok(c.includes('A trade is still open.') && c.includes('2 closed live trade(s)'));
  assert.match(IC.tradeStatus({ queue: { ready: { ok: true } } }), /confirmed balance check with no open trades/);
});

// ---------------------------------------------------------------- settlement preview rendering
const PV = { can_settle: false, blocked_reasons: ['RECONCILE: not confirmed'], period_start: '2026-01-01T00:00:00Z', period_end: '2026-03-01T00:00:00Z', mexc_total: 1100, nav: 1100, unit_price: 1.1, open_positions: 0,
  fee_usdt: 10, fee_units: 9.0909, recon: { status: 'unverified' }, waiting_deposits_admitted_after: [{ id: 1 }],
  lines: [{ name: 'John', units: 1000, value_usdt: 1100, hwm_usdt: 1000, eligible_profit_usdt: 100, fee_rate: 0.1, fee_units: 9.0909, fee_usdt: 10, value_after_usdt: 1090, hwm_after_usdt: 1090 }] };

test('S6 the preview prints the database\'s figures and reasons exactly, and says it would be refused', () => {
  const h = SP.render(PV, fmt);
  for (const t of ['10.00 USDT', '1090.00 USDT', '1000.00 USDT', '1100.00 USDT', 'John', 'RECONCILE: not confirmed', 'would refuse', '1.100000', 'unverified', 'Fee at 10%']) assert.ok(h.includes(t), t);
  assert.ok(!h.includes('Confirmed gain'), 'older preview: no extra columns');
  assert.ok(SP.render({ ...PV, can_settle: true, blocked_reasons: [] }, fmt).includes('allows this settlement'));
});

test('S7 a preview with gaps shows "Not available" instead of zeros; nothing at all is "unavailable"', () => {
  const h = SP.render({ can_settle: true, lines: [{ name: 'Eve' }] }, fmt);
  assert.ok((h.match(/Not available/g) || []).length >= 8);
  assert.ok(!/0\.00 USDT/.test(h) && !/0\.000000/.test(h));
  assert.match(SP.render(null, fmt), /Preview not available/); assert.match(SP.unavailable('The database does not have this preview yet.'), /does not have this preview/);
  assert.match(SP.render({ ...PV, lines: [] }, fmt), /No investor holds units/);
  assert.match(SP.render({ ...PV, lines: undefined }, fmt), /Per investor.*Not available/s);
  assert.ok(SP.render({ ...PV, blocked_reasons: ['<img src=x onerror=1>'] }, fmt).includes('&lt;img'), 'database text is escaped');
});

test('S8 the later "confirmed gain" fields and warnings are shown when the database sends them', () => {
  const h = SP.render({ ...PV, warnings: ['Trades are open: the fee only reaches gains that held.'], lines: [{ ...PV.lines[0], confirmed_profit_usdt: 60, pending_profit_usdt: 40 }] }, fmt);
  assert.ok(h.includes('Confirmed gain') && h.includes('60.00 USDT') && h.includes('Gain still pending') && h.includes('40.00 USDT') && h.includes('Heads-up'));
  assert.match(SP.summary(PV, fmt), /total fee <b>10\.00 USDT<\/b> \(9\.0909 units\) from 1 investor\./); assert.match(SP.summary(PV, fmt), /would be refused/);
  assert.match(SP.summary(null, fmt), /Not available/);
});

test('S9 the screen modules do no accounting', () => {
  for (const f of ['js/settlepreview.js', 'js/investorctx.js', 'js/confirmsheet.js']) {
    const src = strip(read(f));
    assert.ok(!/(_usdt|\.units|fee_rate|unit_price|hwm\w*)\)?\s*[*\/+-]\s*[\w(]/.test(src.replace(/=>/g, '')), f + ' does arithmetic on a database figure');
  }
});

// ---------------------------------------------------------------- wiring in the app
test('S10 wiring: scripts load before the app; the Settle tab asks the database for the preview and no longer computes fees in the browser', () => {
  for (const m of ['confirmsheet', 'settlepreview', 'investorctx']) assert.ok(html.indexOf(`js/${m}.js`) > 0 && html.indexOf(`js/${m}.js`) < html.indexOf('js/app.js'), m);
  assert.ok(app.includes("call('admin_settlement_preview', { p_equity: eq, p_at: at || null })"));
  assert.ok(!/\bqPrev\b|\blotGain\b/.test(app), 'the browser-side fee preview is gone');
  assert.match(app, /btn\.disabled = !ok/); assert.match(app, /id="qSettle" disabled/);
  assert.match(app, /data-action="sppreview"/); assert.match(app, /data-action="spgate"/);
  assert.match(app, /IC\.card\(h, \{ pend: S\.pend, reqs: S\.reqs, queue: S\.queue, pu: S\.pu, fmt: icFmt \}\)/);
  assert.match(app, /a === 'invact'/);
  assert.match(app, /wfsettle: \(\) => withSettlementExceptions\(/, 'the exception flow is unchanged');
  assert.match(app, /a === 'wfsettle' && !\(await settleSheet\(/, 'the Balance desk confirms before settling');
});

test('S11 no browser confirm(), prompt() or alert() is left; cancelled sheets send nothing', () => {
  const src = strip(app).replace(/\/\/.*$/gm, '');
  assert.ok(!/(^|[^.\w])(confirm|prompt|alert)\(/m.test(src), 'a browser dialog remains');
  assert.match(app, /if \(!r\) throw new Cancelled\(\)/); assert.match(app, /!e\.cancelled/);
  assert.match(app, /Escape/); assert.match(app, /aria-invalid/);
});

test('S12 state-changing money steps keep one idempotency key until they succeed', () => {
  assert.match(app, /const moneyWF = \(fn, args\) => withStableKey\(fn, args,/);
  assert.ok(!/p_idem: crypto\.randomUUID\(\)/.test(app), 'no new random key per click');
  assert.match(app, /idemKeys\.delete\(sig\)/);
  assert.match(app, /if \(!fm\.dataset\.idem\)/, 'the forms keep theirs as before');
});

// ---------------------------------------------------------------- the preview the screen prints is what the settlement charges (real migrations, in memory)
const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)), ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
async function world(settings = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`);
  for (const [k, v] of Object.entries({ lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', ...settings })) await db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => { await db.exec('set role anon'); try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); } };
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const id = await call('admin_create_user', A, 'john', 'John', 'john-password', 0.1);
  const at = (d) => `2026-${d}T04:00:00Z`;
  await call('admin_receive_deposit', A, id, 1000, 58, 58000, null, at('01-05'), null, true);
  await call('admin_post_equity', A, 1000, 58, null, at('01-05'));
  return { db, call, A, at };
}

test('S13 the figures the preview screen prints equal the fee the settlement then charges (immediate fee timing)', async () => {
  const w = await world({ fee_timing: 'immediate' });
  const t = 1100;
  await assert.rejects(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02')), /RECONCILE/);
  const pv = await w.call('admin_settlement_preview', w.A, t, w.at('03-02'));
  assert.equal(pv.can_settle, false);
  const shown = SP.render(pv, fmt);
  assert.ok(shown.includes(fmt.usdt(pv.fee_usdt)) && shown.includes(fmt.usdt(pv.lines[0].value_after_usdt)) && shown.includes('would refuse'));
  assert.ok(pv.blocked_reasons.every((r) => shown.includes(String(r).replace(/&/g, '&amp;').replace(/'/g, '&#39;')) || shown.includes(String(r))), 'every reason is shown');
  await w.call('admin_attest_settlement', w.A, t, 'checked against the exchange app by hand', w.at('03-02'), 0);
  const pv2 = await w.call('admin_settlement_preview', w.A, t, w.at('03-02'));
  assert.equal(pv2.can_settle, true); assert.ok(SP.render(pv2, fmt).includes('allows this settlement'));
  const done = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'));
  assert.ok(Math.abs(Number(done.fee_usdt) - Number(pv2.fee_usdt)) < 1e-6, `${done.fee_usdt} vs ${pv2.fee_usdt}`);
  assert.ok(Math.abs(Number(done.fee_usdt) - 10) < 1e-5);
});

test('S14 with the default (confirmed-gain) fee timing the screen still prints exactly what the database sends', async () => {
  const w = await world();
  const pv = await w.call('admin_settlement_preview', w.A, 1100, w.at('03-02'));
  const shown = SP.render(pv, fmt);
  assert.ok(shown.includes(fmt.usdt(pv.fee_usdt)), 'total fee as sent');
  if (pv.lines[0].confirmed_profit_usdt !== undefined) assert.ok(shown.includes('Confirmed gain') && shown.includes(fmt.usdt(pv.lines[0].confirmed_profit_usdt)));
  assert.equal(pv.lines.length, 1);
});

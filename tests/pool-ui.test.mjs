// What the manager sees for pending P/L, Update Pool and the reconciliation (js/poolupdate.js), and a wiring check that the app uses it.
// The decisions themselves are made by the database (tests/pool-update.test.mjs); this file is about wording, the request the button sends and the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const PU = createRequire(import.meta.url)('../js/poolupdate.js');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);   // Oct 22, 2026

const st = (o = {}) => ({ pending: { count: 3, usd: 41.2, r: 0.4, missing_usd: 0, oldest_ms: T0, newest_ms: T0 + 1e6, ids: ['b', 'a', 'c'], exits: [], ...o } });

test('U1 banner: count, signed amount, oldest date in the manager\'s style; nothing when nothing is pending', () => {
  assert.equal(PU.banner(st(), 'UTC'), '3 trades, +41.20 USDT pending since Oct 22, 2026');
  assert.equal(PU.banner(st({ count: 1, usd: -7.5 }), 'UTC'), '1 trade, −7.50 USDT pending since Oct 22, 2026');
  assert.equal(PU.banner(st({ count: 0, usd: 0 }), 'UTC'), null);
  assert.equal(PU.banner(null, 'UTC'), null);
  assert.match(PU.banner(st({ count: 2, missing_usd: 2 }), 'UTC'), /dollar amount not shared/);
  assert.match(PU.banner(st({ count: 3, missing_usd: 1 }), 'UTC'), /\+41\.20 USDT known, 1 without a dollar amount/);
});

test('U2 the request is exactly what the screen displayed (ids and total), and carries the request id', () => {
  const r = PU.request(st(), 7, 'key-1');
  assert.deepEqual(r, { p_vid: 7, p_event_ids: ['b', 'a', 'c'], p_expected_usd: 41.2, p_idem: 'key-1' });
  assert.notEqual(r.p_event_ids, st().pending.ids, 'a copy, not the live array');
  assert.equal(PU.request(st(), 7, 'k', { confirm: true }).p_confirm, true);
  const a = PU.requestAndAdmit(st(), 7, 'key-2', ['5', 6]);
  assert.deepEqual(a.p_pending_ids, [5, 6]); assert.deepEqual(a.p_event_ids, ['b', 'a', 'c']); assert.equal(a.p_expected_usd, 41.2);
});

test('U3 the button is offered only with a confirmed flat balance; an unexplained difference alone does not hide it', () => {
  assert.equal(PU.ready({ verification_id: 4, reasons: [{ code: 'unresolved_difference', text: 'x' }] }).ok, true);
  assert.equal(PU.ready({ verification_id: 4, reasons: [] }).ok, true);
  const open = PU.ready({ verification_id: 4, reasons: [{ code: 'open_positions', text: 'A trade is still open.' }, { code: 'unresolved_difference', text: 'x' }] });
  assert.equal(open.ok, false); assert.deepEqual(open.reasons, ['A trade is still open.']);
  assert.equal(PU.ready({ verification_id: null, reasons: [{ code: 'no_verification', text: 'No confirmed balance check yet.' }] }).ok, false);
  assert.equal(PU.ready(null).ok, false);
  const card = PU.pendingCard(st(), { verification_id: null, reasons: [{ code: 'stale', text: 'The confirmed balance is too old.' }] }, 'UTC');
  assert.match(card, /<button disabled>Update Pool<\/button>/); assert.match(card, /too old/);
  assert.match(PU.pendingCard(st(), { verification_id: 4, reasons: [] }, 'UTC'), /data-action="poolupdate"/);
  assert.match(PU.pendingCard(st({ count: 0, usd: 0 }), null, 'UTC'), /None\./);
});

test('U4 while trades are pending the plain Admit is replaced by "update first"; otherwise unchanged', () => {
  assert.equal(PU.admitMode(st()), 'update_first');
  assert.equal(PU.admitMode(st({ count: 0 })), 'admit');
  assert.equal(PU.admitMode(null), 'admit');
});

test('U5 reconciliation card: shows every part, flags a mismatch as blocking, and escapes text', () => {
  const recon = { status: 'mismatch', observed: 940, expected: 1000, mismatch: -60, tolerance: 0.5, parts: { pool_nav: 1000, pending_pnl: 0, unrealized: 0, redeemed_not_sent: 0, queued_money: 200, queued_location: 'spot' } };
  const h = PU.reconCard({ recon, blocks: [{ source: '<b>snapshot</b>', status: 'mismatch', ts: '2026-10-22T04:00:00Z' }] });
  assert.match(h, /MISMATCH/); assert.match(h, /−60\.00 USDT/); assert.match(h, /blocked/); assert.ok(!h.includes('<b>snapshot</b>'), 'escaped');
  assert.ok(!/queued money/.test(h), 'spot money is not part of futures equity, so it is not a line');
  assert.match(PU.reconCard({ recon: { ...recon, status: 'ok', mismatch: 0.1, parts: { ...recon.parts, queued_location: 'futures' } } }), /queued money \(in futures\)/);
  assert.match(PU.reconCard({ recon: { status: 'waiting_snapshot' } }), /Waiting for the next bot reading/);
  assert.equal(PU.reconCard(null), '');
});

test('U6 wiring: the app loads the status, shows the cards and banner, and sends Update Pool through the module', () => {
  assert.ok(html.includes('<script src="js/poolupdate.js"></script>'));
  assert.ok(html.indexOf('js/poolupdate.js') < html.indexOf('js/app.js'), 'loaded before the app');
  for (const needle of ["call('admin_pool_status')", 'PU.pendingCard(S.pu, rd)', 'PU.reconCard(S.pu)', 'PU.banner(S.pu)', "'admin_update_pool_and_admit' : 'admin_update_pool'",
    'PU.request(st, vid, puKey', 'PU.requestAndAdmit(st, vid, puKey', 'poolupdate:', 'poolupdateadmit:', "'admin_classify_pool_difference'", 'input.pu-pick:checked'])
    assert.ok(app.includes(needle), 'missing in app.js: ' + needle);
  assert.ok(!/call\('admin_update_pool'(?!_and)/.test(app), 'Update Pool is only called through poolUpdate()');
  // the request id changes when what is displayed changes (and after an undo), so a double-click replays but a new situation is a new request
  assert.match(app, /sig !== puSig/); assert.match(app, /last\.id \+ last\.status/);
});

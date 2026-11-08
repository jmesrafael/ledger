// Feedback on every action: a loading bar and spinners, coloured toasts at the top right, an Undo for deletes that can wait, and the view-as eye in the investor sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js'), html = read('login.html');
const grab = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));

test('FB1 toasts: top right, green = saved, blue = updated, red = deleted or an error; the kind is worked out from the message and can be given', () => {
  assert.match(html, /#toast \{ position: fixed; z-index: 60; top: calc\(12px \+ env\(safe-area-inset-top\)\); right: 12px;/);
  assert.match(html, /\.toast\.ok \{ background: #1B7F3B; \} \.toast\.info \{ background: #1D63C6; \} \.toast\.del, \.toast\.err \{ background: #C62828; \}/);
  assert.ok(!/bottom: calc\(96px/.test(html), 'no longer at the bottom');
  assert.match(app, /const k = kind === true \? 'err' : kind \|\| toastKind\(String\(msg\)\)/);
  // the classifier itself, run on messages the app really shows
  const body = app.match(/const toastKind = \(m\) => \((.*?)\);\r?\n  function toast/s)[1];
  const kind = new Function('m', `return (${body});`);
  for (const x of ['Saved', 'Name saved', 'Contact details saved', 'Recorded: ₱5,000 for that deposit', 'Requested. You will be paid by Nov 20', 'Received ₱5,000 = 79.01 USDT. It buys units at your next equity reading.', 'Account created for John'])
    assert.equal(kind(x), 'ok', x);
  for (const x of ['Up to date', 'Viewing as James (read-only)', 'Marked as in the exchange', 'Reactivated', 'Username changed to jim. Tell them, they sign in with it.', 'Password changed', 'Undone: nothing was changed', 'Correction #2 applied: book 218.62'])
    assert.equal(kind(x), 'info', x);
  for (const x of ['Removed from waiting', 'Handed back', 'Request cancelled', 'Deactivated', 'Backup keys revoked', 'Last entry deleted (correction added)'])
    assert.equal(kind(x), 'del', x);
  assert.match(app, /toast\(e\.message, true\)/, 'errors are red');
});

test('FB2 an Undo for deletes that name their own target: red toast, a shrinking bar, nothing is sent until the time is up; Undo sends nothing', () => {
  const h = grab('const HOLD = 6000;', '  const store = {');
  assert.match(h, /toast\(label, 'del', \{ ms: HOLD, undo \}\)/);
  assert.match(h, /const undo = \(\) => \{ clearTimeout\(timer\); toast\('Undone: nothing was changed', 'info'\); resolve\(\); \};/);
  assert.match(h, /timer = setTimeout\(async \(\) => \{ try \{ await run\(\); await refresh\(doneMsg\);/, 'the call is made only after the hold');
  assert.match(app, /opts\.undo \? '<button type="button" class="tundo" data-toast="undo">Undo<\/button>' : ''/);
  assert.match(html, /\.toast \.tbar \{[^}]*animation: tbar var\(--ms, 6s\) linear forwards;/);
  for (const [what, fn] of [['Removing this waiting deposit…', "'admin_cancel_pending'"], ['Handing back this admission spread…', "'admin_cancel_admission_spread'"], ['Cancelling the withdrawal request…', "'cancel_withdrawal_request'"],
    ['Revoking all backup keys…', "'admin_revoke_backup_keys'"]]) {
    const at = app.indexOf(`holdDelete('${what}'`);
    assert.ok(at > 0 && app.slice(at, at + 260).includes(fn), what);
  }
  assert.match(app, /const run = \(\) => call\('admin_set_profile', \{ p_profile: id, p_name: null, p_active: !on, p_fee_rate: null \}\);\r?\n\s+if \(on\) await holdDelete\('Deactivating this person…', run, 'Deactivated'\); else await act\(run, 'Reactivated'\);/, 'deactivating is held, reactivating is not');
  assert.match(app, /await act\(\(\) => call\('admin_undo_last', \{ p_note: 'correction: deleted' \}\), 'Last entry deleted \(correction added\)'\);/, '"delete the last entry" is NOT held: a booking in the meantime would make it hit another entry');
});

test('FB3 every action shows it is working: a loading bar for any request, a spinner on every action button except the instant ones, none while a confirmation waits', () => {
  assert.match(app, /const counted = !\/\^admin_quote_\/\.test\(fn\);/, 'the form previews do not flicker the bar');
  assert.match(app, /loadTimer = setTimeout\(\(\) => loadbar\(true\), 150\)/);
  assert.match(html, /<div id="loadbar" hidden role="progressbar" aria-label="Working"><\/div>/);
  assert.match(html, /#loadbar::after \{[^}]*animation: loadslide 1s ease-in-out infinite;/);
  const instant = app.match(/const INSTANT = new Set\(\[(.*?)\]\);/s)[1].match(/'[a-z]+'/g).map((x) => x.slice(1, -1));
  assert.ok(!app.includes('WAITS'), 'no list of actions that may spin: every action does unless it is on the instant list');
  assert.match(app, /if \(!b \|\| INSTANT\.has\(b\.dataset\.action\)\) return onClick\(ev\);/);
  for (const a of ['addpesos', 'spreadadmit', 'spreadcancel', 'arrived', 'cancelpend', 'cancelreq', 'toggleactive', 'viewas', 'exitview', 'undolast', 'editlast', 'refresh', 'signout', 'topup', 'tvcorrect', 'revokekeys', 'makekey', 'backupjson', 'wfsettle', 'sppreview'])
    assert.ok(!instant.includes(a), a + ' must spin');
  for (const a of ['cur', 'theme', 'closemodal', 'userview', 'maxunits']) assert.ok(instant.includes(a), a + ' is instant');
  const ask = grab('function askSheet(opts)', 'const confirmSheet');
  assert.match(ask, /const paused = \[\.\.\.document\.querySelectorAll\('button\.busy'\)\]; paused\.forEach\(\(x\) => x\.classList\.remove\('busy'\)\);/);
  assert.match(ask, /if \(v\) paused\.forEach\(\(x\) => \{ if \(x\.isConnected\) x\.classList\.add\('busy'\); \}\);/, 'confirmed: the button spins until the action is done');
  assert.match(app, /spin\(btn\)/, 'a saved form spins its own button');
});

test('FB5 no old rule fights the new look: nothing pushes the toast off the top of the screen on desktop, the pill sits at the bottom of the content there, and "Back to admin" keeps its spinner until the page changes', () => {
  const desk = read('css/desktop.css');
  assert.ok(!/\.toast \{/.test(desk), 'the old desktop rule (bottom: 28px) moved the new top-right toast up out of the screen');
  assert.match(desk, /button\.vaback \{ bottom: calc\(28px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.ok(!/(^|\n)\.toast(\.[a-z]+)? \{[^}]*\bbottom:/.test(html + read('css/features.css')), 'no toast rule anchors the toast itself to the bottom');
  assert.match(app, /if \(b\.dataset\.action === 'exitview'\) \{ setTimeout\(\(\) => b\.isConnected && b\.classList\.remove\('busy'\), 5000\); return onClick\(ev\); \}/);
});

test('FB6 while viewing as someone the page has room under the last card for the pill', () => {
  assert.match(app, /app\.classList\.toggle\('va', !!viewing\);/);
  assert.match(html, /#app\.va::after \{ content: ""; display: block; height: 64px; \}/);
});

test('FB4 the investor sheet: an eye left of the X signs in as that investor; the big "View as" button at the bottom is gone', () => {
  const m = grab('function userModal()', 'const holderOpts');
  assert.ok(!m.includes('<span>View as ${nm}</span>'), 'no button at the bottom');
  assert.match(m, /<div class="sheet-btns">\$\{inv && h\.active \? `<button class="iconbtn" data-action="viewas" data-id="\$\{h\.id\}" aria-label="Sign in as \$\{nm\} \(read-only\)" title="Sign in as \$\{nm\} \(read-only\)">\$\{ICON\.eye\}<\/button>` : ''\}<button class="iconbtn" data-action="closemodal"/);
  assert.ok(m.indexOf('data-action="viewas"') < m.indexOf('<button class="iconbtn" data-action="closemodal"'), 'left of the X');
  assert.match(html, /\.sheet-btns \{ display: flex; align-items: center; gap: 8px; flex: none; \}/);
  assert.match(app, /else if \(a === 'viewas'\) \{ try \{ await viewAs\(id\); \}/);
  assert.ok(!app.match(/const INSTANT = new Set\(\[(.*?)\]\);/s)[1].includes("'viewas'"), 'it spins while it signs in');
});

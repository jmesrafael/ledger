// The Profile page (Settings menu): where it is, what is on it, that the forms call the database functions that exist, and that Home no longer carries the forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js');
const grab = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test('PU1 Settings has Profile directly below Refresh, only for a real session (not while viewing as someone)', () => {
  assert.match(app, /<button data-action="refresh">\$\{ICON\.refresh\}<span>Refresh<\/span><\/button>\r?\n\s+\$\{account \|\| viewOnly \? `<button data-action="profile">\$\{ICON\.user\}<span>Profile<\/span><\/button>` : ''\}/);
  assert.match(app, /settingsMenu\(!viewing, !!viewing\)/);
  assert.match(app, /user: svg\(/);
});

test('PU2 the page: account (name, username with the current password), contact, payout (investors), password; it is routed outside the tab bar and has a Back button', () => {
  const v = grab('function viewProfile()', '// ---------------------------------------------------------------- investor / shared views');
  for (const t of ['id="nameForm"', 'id="usernameForm"', "pw('pw', 'current-password')", 'contactCard(m)', 'payoutCard(m)', 'passwordCard()', 'data-tab="${home}">Back']) assert.ok(v.includes(t), t);
  assert.match(v, /\$\{investor \? payoutCard\(m\) : ''\}/, 'the fund manager has no payout card');
  assert.match(app, /if \(S\.tab !== 'profile' && !tabs\.some\(\(\[k\]\) => k === S\.tab\)\) S\.tab = tabs\[0\]\[0\];/);
  assert.match(app, /const VIEWS = \{ profile: viewProfile,/);
  assert.match(app, /else if \(a === 'profile'\) \{ S\.tab = 'profile'; S\.modal = null; render\(\);/);
});

test('PU3 the forms call functions that exist with the arguments they take; the contact and payout forms are the ones already used', () => {
  assert.match(app, /call\('set_my_name', \{ p_name: fv\(fm, 'name'\) \}\)/);
  assert.match(app, /call\('change_my_username', \{ p_password: fv\(fm, 'pw'\), p_username: fv\(fm, 'username'\) \}\)/);
  assert.match(app, /call\('change_my_password', \{ p_old: fv\(fm, 'old'\), p_new: fv\(fm, 'new'\) \}\)/);
  assert.match(app, /call\('set_my_contact'/); assert.match(app, /call\('set_my_payout'/);
  const sql = read('supabase/migrations/20261202000000_profile_self_edit.sql');
  assert.match(sql, /function public\.set_my_name\(p_token text, p_name text\)/);
  assert.match(sql, /function public\.change_my_username\(p_token text, p_password text, p_username text\)/);
});

test('PU4 Home no longer carries the password form: a short card points to Profile and says what is missing, and a missing contact or payout form is right there; the manager acting as the person sees the same', () => {
  const home = grab('function viewHome()', '  const recentCard');
  assert.ok(!home.includes('passwordCard()'));
  assert.match(home, /\$\{investor \? profileNudge\(m\) \+ \(S\.contactOn && !S\.contact \? contactCard\(m\) : ''\) \+ \(S\.payout \? '' : payoutCard\(m\)\) : ''\}/);
  assert.ok(!app.includes('if (m.impersonated) return `${head}'), 'the contact and payout cards are the real forms in view-as too');
  const mine = grab('function viewMine()', 'const viewMyHistory');
  assert.ok(!mine.includes('passwordCard()') && mine.includes('profileNudge(S.me)'));
  const n = grab('function profileNudge(m)', 'function viewProfile()');
  assert.match(n, /contact number/); assert.match(n, /details of where to send your money/); assert.match(n, /data-action="profile">Open profile/);
});

test('PU8 view-as: no banner on top; a round orange button at the end of the main nav goes back to the manager\'s ledger; name, contact and withdrawal details are editable, password and username are not offered', () => {
  const r = grab('function render()', 'Back button (phone and browser)');
  assert.ok(!r.includes('class="viewas"') && !r.includes('Back to fund manager'), 'the top banner is gone');
  assert.match(r, /\$\{viewing \? `<button class="vaback" data-action="exitview" aria-label="Back to the fund manager's ledger" title="Back to the fund manager's ledger">\$\{ICON\.back\}<\/button>` : ''\}<\/div><\/nav>/);
  assert.match(app, /a === 'exitview'/); assert.match(app, /back: svg\(/);
  const css = read('login.html');
  assert.match(css, /nav\.tabs button\.vaback \{[^}]*border-radius: 50%[^}]*#FFB020/);
  const v = grab('function viewProfile()', '// ---------------------------------------------------------------- investor / shared views');
  const view = v.slice(v.indexOf('if (m.impersonated)'), v.indexOf('return `<div class="sechead"><h2>Profile</h2>', v.indexOf('if (m.impersonated)') + 60));
  assert.ok(view.includes('id="nameForm"') && view.includes('contactCard(m)') && view.includes('payoutCard(m)'));
  assert.ok(!view.includes('id="usernameForm"') && !view.includes('passwordCard()'));
  const sql = read('supabase/migrations/20261202000200_view_as_edit_profile.sql');
  assert.match(sql, /from public, anon, authenticated;/, 'the internal helpers are revoked from the website roles');
});

test('PU5 the manager\'s own contact details are loaded too, and a changed username is shown in the audit log', () => {
  assert.match(app, /Promise\.all\(\[call\('my_contact'\), admin \? call\('admin_contacts'\) : null\]\); S\.contact = c;/);   // everyone, the manager included, loads their own contact (in parallel with the rest)
  assert.match(app, /'name_changed', 'username_changed', 'payout_details_changed', 'terms_agreed'/);
  assert.match(app, /case 'username_changed': return `changed their username from/);
});

test('PU6 the manager sees an investor\'s withdrawal details up front (sheet, Users list, every withdrawal row) and can edit anything: name, fee, active, username, password, contact, payout', () => {
  const sheet = grab('function userModal()', 'const holderOpts');
  assert.ok(!sheet.includes('Contact and payout details'), 'no longer folded away under one collapsed heading');
  assert.match(sheet, /<h3 class="subhead">Withdrawal details<\/h3>\$\{payoutBlock\(payOf\(h\.id\)\)\}/);
  assert.match(sheet, /<h3 class="subhead">Contact<\/h3>\$\{contactBlock\(contactOf\(h\.id\)\)\}/);
  for (const t of ['class="adminPayoutForm"', 'class="adminContactForm"', 'class="adminUserForm"', 'class="profForm"', 'class="resetForm"', 'data-action="toggleactive"']) assert.ok(sheet.includes(t), t);
  assert.match(sheet, /<details \$\{payOf\(h\.id\) \? '' : 'open'\}>/, 'the form opens by itself when nothing is on file');
  assert.match(app, /Withdraws to \$\{esc\(payLabel\(d\.method\)\)\}/); assert.match(app, /No withdrawal details on file/);
  assert.match(grab('function viewUsers()', 'everything about one person'), /\$\{h\.role === 'investor' \? `<div class="note">\$\{payLine\(h\.id\)\}<\/div>` : ''\}/);
  assert.match(app, /<span class="note">\$\{payLine\(w\.profile_id\)\}<\/span>/);
});

test('PU7 the manager\'s forms call admin functions that exist; the QR upload is shared with the investor\'s own form; an unchanged QR is kept', () => {
  assert.match(app, /call\('admin_set_payout', \{ p_profile: fm\.dataset\.id, p_method: fv\(fm, 'method'\), p_name: fv\(fm, 'pname'\), p_number: fv\(fm, 'pnum'\), p_bank: null, p_qr: qr \}\)/);
  assert.match(app, /call\('admin_set_username', \{ p_profile: fm\.dataset\.id, p_username: fv\(fm, 'username'\) \}\)/);
  assert.match(app, /call\('admin_set_password'/); assert.match(app, /call\('admin_set_contact'/); assert.match(app, /call\('admin_set_profile'/);
  assert.equal((app.match(/async function uploadQr\(/g) || []).length, 1);
  assert.match(app, /if \(!file\) return current \|\| null;/);
  assert.match(app, /const qr = await uploadQr\(fm\.elements\.qr\.files\[0\], S\.payout && S\.payout\.qr_path\);/);
  const sql = read('supabase/migrations/20261202000100_admin_edit_profile.sql');
  assert.match(sql, /function public\.admin_set_username\(p_token text, p_profile uuid, p_username text\)/);
  assert.match(sql, /function public\.admin_set_payout\(p_token text, p_profile uuid, p_method text, p_name text, p_number text, p_bank text default null, p_qr text default null\)/);
  assert.match(app, /case 'payout_details_changed'/);
});

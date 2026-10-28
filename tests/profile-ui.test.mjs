// The Profile page (Settings menu): where it is, what is on it, that the forms call the database functions that exist, and that Home no longer carries the forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js');
const grab = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test('PU1 Settings has Profile directly below Refresh, only for a real session (not while viewing as someone)', () => {
  assert.match(app, /<button data-action="refresh">\$\{ICON\.refresh\}<span>Refresh<\/span><\/button>\r?\n\s+\$\{account \? `<button data-action="profile">\$\{ICON\.user\}<span>Profile<\/span><\/button>` : ''\}/);
  assert.match(app, /settingsMenu\(!viewing\)/);
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

test('PU4 Home no longer carries the password, contact and payout forms: a short card points to Profile and says what is still missing; "view as" still shows the read-only details', () => {
  const home = grab('function viewHome()', '  const recentCard');
  assert.ok(!home.includes('passwordCard()'));
  assert.match(home, /\$\{investor \? \(m\.impersonated \? contactCard\(m\) \+ payoutCard\(m\) : profileNudge\(m\)\) : ''\}/);
  const mine = grab('function viewMine()', 'const viewMyHistory');
  assert.ok(!mine.includes('passwordCard()') && mine.includes('profileNudge(S.me)'));
  const n = grab('function profileNudge(m)', 'function viewProfile()');
  assert.match(n, /contact number/); assert.match(n, /details of where to send your money/); assert.match(n, /data-action="profile">Open profile/);
});

test('PU5 the manager\'s own contact details are loaded too, and a changed username is shown in the audit log', () => {
  assert.match(app, /S\.contact = await call\('my_contact'\);/);
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

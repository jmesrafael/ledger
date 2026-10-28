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
  assert.match(app, /'name_changed', 'username_changed', 'terms_agreed'/);
  assert.match(app, /case 'username_changed': return `changed their username from/);
});

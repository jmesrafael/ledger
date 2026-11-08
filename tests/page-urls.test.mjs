// Every page has its own address (js/app.js routeOf / fromHash / applyHash): login#/calendar, login#/fund/users, login#/me/statements, login#/fund/record/wd.
// The real functions are cut out of app.js and run against stand-ins for the app state, so what is tested is what ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const cut = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));
const TABS = { investor: ['home', 'calendar', 'withdraw', 'statements', 'activity', 'about'], admin: ['dashboard', 'users', 'record', 'quarter', 'reports', 'log'], adminMe: ['mine', 'statements', 'myhistory'] };
const code = cut('  const RECS = ', '  function syncNav()');
const make = (me, hash, side = 'fund') => {
  const S = { me, tab: null, side, rec: 'eq' }, location = { hash };
  const mk = new Function('S', 'location', 'PAGES', 'TABS', `${code.replace(/\(\[k\]\) => k === tab/, '([k]) => k === tab')}; return { routeOf, fromHash, applyHash };`);
  // TABS in app.js hold [key, label] pairs
  const pairs = Object.fromEntries(Object.entries(TABS).map(([k, v]) => [k, v.map((x) => [x, x])]));
  return { S, ...mk(S, location, ['profile', 'contact', 'payout'], pairs) };
};
const inv = { id: 'j', role: 'investor' }, adm = { id: 'r', role: 'admin' };

test('PURL1 an investor\'s pages: Home is "dashboard", the others use their own name, and the address maps back to the page', () => {
  const { routeOf, fromHash, S } = make(inv, '');
  assert.equal(routeOf({ tab: 'home' }), '#/dashboard'); assert.equal(routeOf({ tab: 'calendar' }), '#/calendar'); assert.equal(routeOf({ tab: 'withdraw' }), '#/withdraw');
  assert.equal(routeOf({ tab: 'profile', side: 'fund' }), '#/profile');
  for (const [h, tab] of [['#/dashboard', 'home'], ['#/calendar', 'calendar'], ['#/statements', 'statements'], ['#/activity', 'activity'], ['#/profile', 'profile'], ['#calendar', 'calendar']]) {
    S.me = inv; const m = make(inv, h); assert.equal(m.fromHash().tab, tab, h);
  }
  assert.equal(make(inv, '#/home').fromHash().tab, 'home', 'the old name still works');
});

test('PURL2 the fund manager: Fund and My account pages are told apart, and the record form keeps its sub-page', () => {
  const { routeOf } = make(adm, '');
  assert.equal(routeOf({ tab: 'users', side: 'fund' }), '#/fund/users'); assert.equal(routeOf({ tab: 'dashboard', side: 'fund' }), '#/fund/dashboard');
  assert.equal(routeOf({ tab: 'statements', side: 'me' }), '#/me/statements'); assert.equal(routeOf({ tab: 'mine', side: 'me' }), '#/me/mine');
  assert.equal(routeOf({ tab: 'record', side: 'fund', rec: 'wd' }), '#/fund/record/wd'); assert.equal(routeOf({ tab: 'profile', side: 'me' }), '#/profile');
  const a = make(adm, '#/me/statements'); assert.deepEqual(a.fromHash(), { tab: 'statements', side: 'me', rec: null });
  const b = make(adm, '#/fund/record/wd'); assert.deepEqual(b.fromHash(), { tab: 'record', side: 'fund', rec: 'wd' });
  assert.equal(make(adm, '#/fund/record/nonsense').fromHash().rec, null);
  const c = make(adm, '#/profile', 'me'); c.applyHash(); assert.equal(c.S.side, 'me', 'a profile address does not move the manager to the other side');
});

test('PURL3 an address only ever opens a page the person has: wrong role, unknown page, a manager page for an investor, "view as"', () => {
  for (const h of ['#/fund/users', '#/users', '#/me/statements', '#/nonsense', '#/', '', '#/__proto__', '#/constructor']) assert.equal(make(inv, h).fromHash(), null, h);
  assert.equal(make(adm, '#/calendar').fromHash(), null, 'the investor pages are not the manager\'s');
  assert.equal(make({ ...inv, impersonated: true }, '#/calendar').fromHash(), null, 'while viewing as someone, the address is left alone');
  const m = make(inv, '#/calendar'); assert.equal(m.applyHash(), true); assert.equal(m.S.tab, 'calendar'); assert.equal(make(inv, '#/zzz').applyHash(), false);
});

test('PURL4 wiring: the address follows every page change, opening or reloading a page restores it, typing one in works, nothing else about history changed', () => {
  assert.match(app, /history\.pushState\(s, '', url \|\| location\.href\) : history\.replaceState\(s, '', url \|\| location\.href\)/);
  assert.match(app, /const url = S\.gate \|\| S\.adminToken \? null : routeOf\(s\);/);
  assert.match(app, /if \(S\.uid !== S\.me\.id\) \{ S\.uid = S\.me\.id; S\.tab = null; applyHash\(\); \}/);
  assert.match(app, /if \(!st && !S\.adminToken\) \{/); assert.match(app, /else if \(S\.nav\) \{ try \{ history\.replaceState\(S\.nav, '', routeOf\(S\.nav\)\); \}/);
  assert.match(app, /if \(!S\.me\) \{ if \(!\(p && p\.out\)\) history\.replaceState\(\{ app: 1, out: 1 \}, ''\); return; \}/, 'signed out keeps the address, so signing in lands on that page');
});

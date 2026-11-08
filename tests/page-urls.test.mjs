// Every page has its own address (js/app.js routeOf / fromHash / applyHash): /login/calendar, /login/fund/users, /login/me/statements, /login/fund/record/wd.
// The real functions are cut out of app.js and run against stand-ins for the app state, so what is tested is what ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const cut = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));
const TABS = { investor: ['home', 'calendar', 'withdraw', 'statements', 'activity', 'about'], admin: ['dashboard', 'users', 'record', 'quarter', 'reports', 'log'], adminMe: ['mine', 'statements', 'myhistory'] };
const code = cut('  const RECS = ', '  function syncNav()');
const make = (me, url, side = 'fund') => {
  const S = { me, tab: null, side, rec: 'eq' }, location = url.startsWith('#') ? { pathname: '/login', hash: url } : { pathname: url, hash: '' };
  const mk = new Function('S', 'location', 'PAGES', 'TABS', `${code}; return { routeOf, fromHash, applyHash, PATHY };`);
  // TABS in app.js hold [key, label] pairs
  const pairs = Object.fromEntries(Object.entries(TABS).map(([k, v]) => [k, v.map((x) => [x, x])]));
  return { S, ...mk(S, location, ['profile', 'contact', 'payout'], pairs) };
};
const inv = { id: 'j', role: 'investor' }, adm = { id: 'r', role: 'admin' };

test('PURL1 an investor\'s pages: Home is "dashboard", the others use their own name, and the address maps back to the page', () => {
  const { routeOf, fromHash, S } = make(inv, '/login');
  assert.equal(routeOf({ tab: 'home' }), '/login/dashboard'); assert.equal(routeOf({ tab: 'calendar' }), '/login/calendar'); assert.equal(routeOf({ tab: 'withdraw' }), '/login/withdraw');
  assert.equal(routeOf({ tab: 'profile', side: 'fund' }), '/login/profile');
  for (const [h, tab] of [['/login/dashboard', 'home'], ['/login/calendar', 'calendar'], ['/login/statements', 'statements'], ['/login/activity', 'activity'], ['/login/profile', 'profile'], ['#/calendar', 'calendar'], ['#calendar', 'calendar'], ['/login/calendar/', 'calendar']]) {
    S.me = inv; const m = make(inv, h); assert.equal(m.fromHash().tab, tab, h);
  }
  assert.equal(make(inv, '/login/home').fromHash().tab, 'home', 'the old name still works');
});

test('PURL2 the fund manager: Fund and My account pages are told apart, and the record form keeps its sub-page', () => {
  const { routeOf } = make(adm, '/login');
  assert.equal(routeOf({ tab: 'users', side: 'fund' }), '/login/fund/users'); assert.equal(routeOf({ tab: 'dashboard', side: 'fund' }), '/login/fund/dashboard');
  assert.equal(routeOf({ tab: 'statements', side: 'me' }), '/login/me/statements'); assert.equal(routeOf({ tab: 'mine', side: 'me' }), '/login/me/mine');
  assert.equal(routeOf({ tab: 'record', side: 'fund', rec: 'wd' }), '/login/fund/record/wd'); assert.equal(routeOf({ tab: 'profile', side: 'me' }), '/login/profile');
  const a = make(adm, '/login/me/statements'); assert.deepEqual(a.fromHash(), { tab: 'statements', side: 'me', rec: null });
  const b = make(adm, '/login/fund/record/wd'); assert.deepEqual(b.fromHash(), { tab: 'record', side: 'fund', rec: 'wd' });
  assert.equal(make(adm, '/login/fund/record/nonsense').fromHash().rec, null);
  const c = make(adm, '/login/profile', 'me'); c.applyHash(); assert.equal(c.S.side, 'me', 'a profile address does not move the manager to the other side');
});

test('PURL3 an address only ever opens a page the person has: wrong role, unknown page, a manager page for an investor, "view as"', () => {
  for (const h of ['/login/fund/users', '/login/users', '/login/me/statements', '/login/nonsense', '/login', '/login/', '/login/__proto__', '/login/constructor', '/login/%E0%A4%A', '#/fund/users']) assert.equal(make(inv, h).fromHash(), null, h);
  assert.equal(make(adm, '/login/calendar').fromHash(), null, 'the investor pages are not the manager\'s');
  assert.equal(make({ ...inv, impersonated: true }, '/login/calendar').fromHash(), null, 'while viewing as someone, the address is left alone');
  const m = make(inv, '/login/calendar'); assert.equal(m.applyHash(), true); assert.equal(m.S.tab, 'calendar'); assert.equal(make(inv, '/login/zzz').applyHash(), false);
});

test('PURL4 wiring: the address follows every page change, opening or reloading a page restores it, typing one in works, nothing else about history changed', () => {
  assert.match(app, /history\.pushState\(s, '', url \|\| location\.href\) : history\.replaceState\(s, '', url \|\| location\.href\)/);
  assert.match(app, /const url = S\.gate \|\| S\.adminToken \? null : routeOf\(s\);/);
  assert.match(app, /if \(S\.uid !== S\.me\.id\) \{ S\.uid = S\.me\.id; S\.tab = null; applyHash\(\); \}/);
  assert.match(app, /if \(!st && !S\.adminToken\) \{/); assert.match(app, /else if \(S\.nav\) \{ try \{ history\.replaceState\(S\.nav, '', routeOf\(S\.nav\)\); \}/);
  assert.match(app, /if \(!S\.me\) \{ if \(!\(p && p\.out\)\) history\.replaceState\(\{ app: 1, out: 1 \}, ''\); return; \}/, 'signed out keeps the address, so signing in lands on that page');
});

test('PURL5 real paths where the app is served at /login (the rewrite and base tag are there); #/ addresses anywhere else, and old #/ links still open', () => {
  const root = new URL('../', import.meta.url), vercel = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')), html = readFileSync(new URL('login.html', root), 'utf8');
  assert.ok(vercel.rewrites.some((r) => r.source === '/login/:path*' && r.destination === '/login.html'), 'every /login/... address serves the app');
  assert.ok(html.indexOf('<base href="/">') > 0 && html.indexOf('<base href="/">') < html.indexOf('rel="manifest"'), 'files are found from the site root, ahead of every link');
  assert.equal(make(inv, '/login/calendar').PATHY, true); assert.equal(make(inv, '/login').PATHY, true);
  const f = make(inv, '/index.html'); assert.equal(f.PATHY, false); assert.equal(f.routeOf({ tab: 'calendar' }), '#/calendar', 'a plain file or another host falls back to a hash');
  assert.equal(make(inv, '#/calendar').fromHash().tab, 'calendar', 'an old link opens, then the address is rewritten to /login/calendar');
  assert.equal(make(inv, '/login.html').PATHY, false, '/login.html cannot be rewritten to a path (it would 404 on reload)');
});

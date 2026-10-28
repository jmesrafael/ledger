// "Read from the bots": adds up the latest wallet report of each bot (admin_wallet_nav) into the Exchange total field. It only fills the field: these tests check the
// sum, the warnings (stale, suspect, open trades, nothing reported), that user text is escaped, and that the app wires the button to the database call and the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BT = require('../js/bottotal.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js'), html = read('login.html');
const fmt = { usdt: (n) => Number(n).toFixed(2) + ' USDT' };
const w = (o) => ({ wallet: 'bbcore', label: 'BB-Core', status: 'ok', equity_usdt: 40.41, age_seconds: 120, open_positions: 2, ...o });

test('B1 two fresh wallets: the total is their sum, rounded to cents, with each wallet listed', () => {
  const r = BT.read({ wallets: [w({}), w({ wallet: 'icore', label: 'I-Core', equity_usdt: 9.983, open_positions: 0 })] });
  assert.equal(r.ok, true); assert.equal(r.total, 50.39);
  const h = BT.html(r, fmt);
  for (const t of ['BB-Core', '40.41 USDT', 'I-Core', '9.98 USDT', '50.39 USDT', '2 min ago', '2 open', 'Spot']) assert.ok(h.includes(t), t);
});

test('B2 a wallet that is not ok still counts but is flagged; open trades are called out', () => {
  const r = BT.read({ wallets: [w({ status: 'stale', age_seconds: 4000 }), w({ wallet: 'icore', label: 'I-Core', equity_usdt: 10, open_positions: 0, status: 'suspect' })] });
  assert.equal(r.total, 50.41);
  assert.equal(r.warnings.length, 3);
  assert.ok(r.warnings.some((x) => /BB-Core: old report/.test(x)) && r.warnings.some((x) => /I-Core: big jump, not accepted/.test(x)) && r.warnings.some((x) => /2 trades are open/.test(x)));
  assert.match(BT.html(r, fmt), /class="warn"/);
});

test('B3 no wallet reported: no total, the field is left alone', () => {
  for (const nav of [null, {}, { wallets: [] }, { wallets: [{ wallet: 'bbcore', status: 'missing', equity_usdt: null }] }]) {
    const r = BT.read(nav); assert.equal(r.ok, false); assert.equal(r.total, null);
    assert.match(BT.html(r, fmt), /No bot has reported/);
  }
});

test('B4 one open trade reads in the singular; labels and the form/field names are escaped', () => {
  const r = BT.read({ wallets: [w({ label: '<img src=x onerror=1>', open_positions: 1 })] });
  assert.ok(r.warnings.some((x) => /1 trade is open: the total includes its unrealised P\/L and moves until it closes/.test(x)));
  assert.ok(!BT.html(r, fmt).includes('<img'));
  assert.ok(!BT.button('a"><script>', 'f"x').includes('<script>'));
});

test('B5 the module does not save or call anything: it has no database or storage access', () => {
  const src = read('js/bottotal.js').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/\b(fetch|rpc|call|localStorage|XMLHttpRequest)\b/.test(src));
});

test('B6 wiring: the script loads before the app; the button sits beside every Exchange total field and the click asks admin_wallet_nav and fills the field', () => {
  assert.ok(html.indexOf('js/bottotal.js') > 0 && html.indexOf('js/bottotal.js') < html.indexOf('js/app.js'));
  assert.ok(app.includes('const BT = BotTotal;'));
  for (const [form, field] of [['eqForm', 'equity'], ['wfBal', 'total'], ['qForm', 'equity'], ['wdForm', 'eq']]) {
    assert.ok(app.includes(`\${BT.button('${form}', '${field}')}`), `${form}.${field}`);
    assert.ok(new RegExp(`<form id="${form}"`).test(app), form + ' exists');
  }
  assert.ok(app.includes("a === 'bottotal'") && app.includes("call('admin_wallet_nav')"));
  assert.match(app, /inp\.value = r\.total; inp\.dispatchEvent\(new Event\('input'/);
  // the click never submits or saves: it is a type="button" and the handler writes no database function
  assert.ok(/type="button" class="ghost sm" data-action="bottotal"/.test(read('js/bottotal.js')));
  const handler = app.slice(app.indexOf("a === 'bottotal'"), app.indexOf("a === 'allunits'"));
  assert.ok(!/call\('(?!admin_wallet_nav)/.test(handler) && !/\bact\(/.test(handler));
});

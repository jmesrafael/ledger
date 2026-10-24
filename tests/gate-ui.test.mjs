// The manager's old forms when workflow_gate is on (js/gate.js): instructions instead of errors. The decision and wording live in a small module
// shared by the app and these tests; a wiring check proves the app routes each old form through it. The gate itself is enforced by the
// database (tests/risk-fixes.test.mjs, docs/settlement-controls.md); this file is about what the manager SEES.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const Gate = createRequire(import.meta.url)('../js/gate.js');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../login.html', import.meta.url), 'utf8');

const OFF = [null, undefined, {}, { gate: 'off' }, { gate: '' }];

test('G1 gate off (or unknown): every old form is shown as it always was', () => {
  for (const q of OFF) {
    assert.equal(Gate.on(q), false);
    for (const kind of ['withdrawal', 'balance', 'settlement']) assert.equal(Gate.oldForm(kind, q, { arrived: 3, totalText: '$10' }), null, `${kind} with ${JSON.stringify(q)}`);
  }
});

test('G2 gate on: the withdrawal and settlement forms become instructions with a button to the Capital tab, not forms and not errors', () => {
  const q = { gate: 'on' };
  assert.equal(Gate.on(q), true);
  for (const [kind, words] of [['withdrawal', ['Approve', 'Quote', 'Redeem', 'confirmed balance']], ['settlement', ['Valuation and settlement', 'confirm the MEXC balance', '7 days', 'exception']]]) {
    const h = Gate.oldForm(kind, q);
    assert.ok(h && h.includes('The workflow gate is on'), kind);
    assert.ok(h.includes('data-tab="record" data-rec="eq"'), kind + ' links to Record → Balance');
    assert.ok(!/<form|<input|<select/.test(h), kind + ' has no form to fill in');
    assert.ok(!/error|blocked|refused|failed|cannot/i.test(h), kind + ' does not read like an error');
    for (const w of words) assert.ok(h.includes(w), `${kind} mentions "${w}"`);
  }
});

test('G3 gate on: the balance form only steps aside while deposits already in MEXC are waiting, and says how many and how much', () => {
  const q = { gate: 'on' };
  assert.equal(Gate.oldForm('balance', q, { arrived: 0, totalText: '$0' }), null, 'nothing waiting: the valuation form stays (it moves no units)');
  assert.equal(Gate.oldForm('balance', q, {}), null);
  const one = Gate.oldForm('balance', q, { arrived: 1, totalText: '$100.00' });
  assert.match(one, /1 deposit is already in MEXC and waiting \(\$100\.00\)/); assert.match(one, /Admit it there first/);
  const two = Gate.oldForm('balance', q, { arrived: 2, totalText: '$250.50' });
  assert.match(two, /2 deposits are already in MEXC and waiting \(\$250\.50\)/); assert.match(two, /Admit them there first/);
  assert.ok(!/<form|<input/.test(one + two));
  assert.match(Gate.oldForm('balance', q, { arrived: 1, totalText: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/, 'page-supplied text is escaped');
});

test('G4 the deposit and waiting-money wording exists and points to the three steps', () => {
  assert.match(Gate.TEXT.deposit, /Seen in MEXC/); assert.match(Gate.TEXT.deposit, /admit/);
  assert.match(Gate.TEXT.waiting, /three steps/); assert.match(Gate.TEXT.waiting, /Seen in MEXC/); assert.match(Gate.TEXT.waiting, /Admit/);
});

test('G5 wiring: the app routes the withdrawal, balance and settlement forms through the module, and loads it before the app', () => {
  assert.match(app, /Gate\.oldForm\('withdrawal', S\.queue\)/);
  assert.match(app, /Gate\.oldForm\('balance', S\.queue,/);
  assert.match(app, /Gate\.oldForm\('settlement', S\.queue\)/);
  assert.match(app, /Gate\.on\(S\.queue\)/);
  const p = html.indexOf('js/gate.js'), a = html.indexOf('js/app.js');
  assert.ok(p > 0 && a > p, 'login.html loads js/gate.js before js/app.js');
  // with the gate on, the in-MEXC checkbox and the "In MEXC" button give way to the Capital tab (arrival is confirmed there, with a note)
  assert.match(app, /\$\{d\.arrived_at \|\| g \? '' :/);
  assert.match(app, /\$\{gateOn\(\) \? '<p class="note"><b>The workflow gate is on\.<\/b> ' \+ Gate\.TEXT\.deposit/);
});

test('G6 the Capital tab settles with the same exception prompts as the old form (late, backdated, unreconciled, open trades)', () => {
  assert.match(app, /wfsettle: \(\) => withSettlementExceptions\(/);
  assert.match(app, /const settleWithExceptions = \(fm, args\) => withSettlementExceptions\(/);
  for (const kind of ['late', 'backdated', 'unreconciled', 'open_positions']) assert.ok(app.includes(`'${kind}'`), kind);
  assert.match(app, /\^BACKDATED:/); assert.match(app, /\^LATE:/); assert.match(app, /\^RECONCILE:/); assert.match(app, /\^OPEN TRADES:/);
});

test('G7 gate.js does arithmetic on no accounting values', () => {
  const src = readFileSync(new URL('../js/gate.js', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/[a-z_]+_usdt|unit_price|hwm|fee_/.test(src));
});

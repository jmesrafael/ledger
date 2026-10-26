// The "? How this works" instructions on the Record tabs (js/recordhelp.js). The words are only worth something if they match the screens, so every button and
// card name the instructions mention is checked against the real app, the steps are checked for the order things really have to happen in, and the wiring is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const RH = createRequire(import.meta.url)('../js/recordhelp.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js'), html = read('login.html'), css = read('css/features.css'), pu = read('js/poolupdate.js');
const wf = read('supabase/migrations/applied/20261106000000_capital_workflow.sql');
const SCREENS = app + '\n' + pu;
const titles = (topic, ctx) => RH.topics(ctx)[topic].steps.map((s) => s.t);
const idx = (arr, re) => arr.findIndex((t) => re.test(t));
const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const inOrder = (t, res) => { const at = res.map((re) => idx(t, re)); assert.ok(at.every((i) => i >= 0), 'every step exists: ' + JSON.stringify(at)); assert.deepEqual(at, [...at].sort((a, b) => a - b), 'in order: ' + JSON.stringify(at)); };

test('H1 every button and card name the instructions mention exists on a real screen (gate on and off)', () => {
  for (const gate of [true, false]) for (const topic of RH.TOPIC_IDS) {
    for (const label of RH.labels(topic, { gate })) assert.ok(SCREENS.includes(label), `"${label}" (${topic}, gate ${gate}) is not on any screen`);
  }
  const all = new Set(RH.TOPIC_IDS.flatMap((t) => [true, false].flatMap((g) => RH.labels(t, { gate: g }))));
  for (const l of ['Save', 'Seen in the exchange', 'In the exchange', 'Admit', 'Approve', 'Quote', 'Redeem', 'Sent from the exchange', 'Completed', 'Update Pool', 'Update Pool and accept ticked', 'Enter balance (not confirmed yet)', 'Confirm this balance'])
    assert.ok(all.has(l), `the instructions never mention "${l}"`);
});

test('H2 Money in (gate on): account, Spot, record, seen in the exchange, check balance, Update Pool, Admit, Spot to Futures', () => {
  const t = titles('dep', { gate: true });
  inOrder(t, [/account/i, /Spot/, /Record it/, /seen in the exchange/i, /Check and confirm/, /Update Pool/, /Admit/, /Futures/]);
  assert.equal(RH.topics({ gate: true }).dep.glance.length, t.length, 'the at-a-glance strip has one chip per step');
});

test('H3 Money in with the workflow gate off: In the exchange, then Update equity (the older route); the pending-trades step still comes before it', () => {
  const t = titles('dep', { gate: false });
  inOrder(t, [/Record it/, /Mark it as in the exchange/, /Update Pool/, /Update equity/, /Futures/]);
  assert.equal(RH.topics({ gate: false }).dep.glance.length, t.length);
  assert.ok(!t.some((x) => /Admit them/.test(x)), 'no Admit step without the gate');
});

test('H4 Money out: ask, approve, confirm the balance, Update Pool, quote then redeem, send, mark sent; and the facts the database enforces are stated', () => {
  inOrder(titles('wd', { gate: true }), [/They ask/, /Approve/, /Check and confirm/, /Update Pool/, /Quote, then Redeem/, /Send the money/, /Mark it sent/]);
  const good = strip(RH.topics({ gate: true }).wd.good.join(' '));
  assert.match(good, /uses up the confirmed balance/); assert.match(good, /Sent from the exchange/);
  assert.ok(/_wf_use\(p_vid, not p_to_manager\)/.test(wf), 'a payout from the exchange spends the balance check (the help says so)');
  assert.ok(/raise exception 'quote rolled back' using errcode = 'WQ001'/.test(wf), 'a quote is rolled back (the help says it saves nothing)');
});

test('H5 Balance: the hours come from the page, junk never reaches the text, the default is the database default', () => {
  const body = (ctx) => strip(RH.topics(ctx).eq.steps.map((s) => s.body).join(' '));
  assert.ok(body({ gate: true, maxAgeHours: 6 }).includes('6 hours'));
  assert.ok(body({}).includes('12 hours'));
  assert.ok(body({ maxAgeHours: '<script>' }).includes('12 hours') && !body({ maxAgeHours: '<script>' }).includes('script'));
  assert.ok(wf.includes("('verify_max_age_hours', '12')"), 'the 12-hour default is the database default');
  const refused = RH.topics({}).eq.refused.flat().join(' ');
  for (const w of ['too old', 'trade is still open', 'Unexplained difference', 'Update Pool', 'MISMATCH']) assert.ok(refused.includes(w), `"${w}" is covered in "If something is refused"`);
  inOrder(RH.topics({}).eq.steps.map((s) => s.t), [/Look at the exchange/, /Enter the balance/, /Confirm it/, /Read the difference/, /Work down the cards/]);
});

test('H6 the sheet: a labelled dialog with numbered steps, a close button and Got it; the button opens it', () => {
  for (const topic of RH.TOPIC_IDS) for (const gate of [true, false]) {
    const h = RH.sheet(topic, { gate, maxAgeHours: 12 }, '<svg></svg>');
    assert.match(h, /role="dialog" aria-modal="true" aria-label="How this works: /); assert.ok(h.includes(`data-help="${topic}"`));
    assert.equal((h.match(/<li class="hstep">/g) || []).length, RH.topics({ gate })[topic].steps.length);
    for (const w of ['data-action="closemodal"', 'Got it', 'Step by step', 'Good to know', 'If something is refused']) assert.ok(h.includes(w), w);
    assert.ok(!/undefined|\[object|NaN/.test(h), `${topic}/${gate} has no undefined text`);
  }
  assert.equal(RH.sheet('nope', {}), '');
  const b = RH.button('dep'); assert.match(b, /data-action="help" data-help="dep"/); assert.match(b, /How this works/); assert.ok(b.includes('?'));
  assert.ok(RH.isHelp('help:dep') && !RH.isHelp('3f2a-user-id') && !RH.isHelp(null));
});

test('H7 wiring: script before the app; the button on all three tabs (also when the gate replaces the Money out form); closes like the other sheets; styles exist', () => {
  assert.ok(html.includes('<script src="js/recordhelp.js"></script>') && html.indexOf('js/recordhelp.js') < html.indexOf('js/app.js'));
  for (const t of ['dep', 'wd', 'eq']) assert.ok(app.includes(`RH.button('${t}')`), `button on ${t}`);
  assert.ok(app.includes("pick('wd', RH.button('wd') + (Gate.oldForm('withdrawal', S.queue) ||"), 'on Money out the button stays when the workflow gate replaces the form');
  assert.ok(app.includes('if (RH.isHelp(S.modal)) return helpModal(S.modal.slice(5));') && app.includes("a === 'help') { S.modal = 'help:' + b.dataset.help"));
  assert.ok(app.includes("ev.key === 'Escape' && S.modal) closeModal()"), 'Esc closes it');
  for (const c of ['.helpbtn', '.helpsheet .hstep', '.helpsheet .hnum', '.helpsheet .hglance']) assert.ok(css.includes(c), c);
});

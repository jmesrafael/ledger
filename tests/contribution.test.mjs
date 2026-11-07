// js/contribution.js (the PHP contribution layer: pesos paid, USDT received, effective and reference rates) and its wiring in the app.
// Display only: the tests also check that peso figures and reference rates never reach units, the pool value or the ledger rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ready, near } from './_tvworld.mjs';
const C = createRequire(import.meta.url)('../js/contribution.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const grab = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));

const NOW = Date.parse('2026-11-07T12:00:00Z');
const live = { rate: 63.11, t: NOW - 5 * 60000, src: 'open.er-api.com' };
// James's deposit as stored (ledger #3), and Raf's two USDT-only deposits with the market rate the manager typed then (#1, #2)
const james = { id: 3, ts: '2026-11-07T10:21:09Z', kind: 'deposit', usdt: '66.4', units: '73.31635568', php_amount: '5000', php_rate: '75.30120482' };
const raf1 = { id: 1, ts: '2026-10-23T16:29:11Z', kind: 'deposit', usdt: '52.3082', units: '52.3082', php_amount: null, php_rate: '63.53' };
const raf2 = { id: 2, ts: '2026-10-28T14:33:07Z', kind: 'deposit', usdt: '200', units: '203.33605442', php_amount: null, php_rate: '64.01' };

test('CB1 a peso deposit: pesos, USDT received, effective rate, reference rate, USD equivalent; units and value come from the database untouched', () => {
  const s = C.summary([james], C.referenceRate(live, NOW), { units: '73.31635568', value_usdt: '64.3677' });
  assert.equal(s.php, 5000); near(s.usdt, 66.4, 1e-12); assert.equal(s.rate, 75.30120482, 'pesos / USDT, 8 decimals, as stored');
  assert.equal(s.ref.rate, 63.11); near(s.usdEquivalent, 5000 / 63.11, 1e-9); near(s.usdEquivalent, 79.2267, 1e-4);
  assert.equal(s.units, 73.31635568); assert.equal(s.value, 64.3677);
  assert.equal(s.usdtOnlyCount, 0);
});

test('CB2 USDT-only deposits: no pesos, and a stored php_rate without php_amount is NOT treated as a cash-in rate', () => {
  const s = C.summary([raf1, raf2], C.referenceRate(live, NOW), { units: '255.64425442', value_usdt: '224.44' });
  assert.equal(s.deposits.length, 0); assert.equal(s.php, 0); assert.equal(s.rate, null); assert.equal(s.usdEquivalent, null);
  near(s.usdtOnly, 252.3082, 1e-9); assert.equal(s.usdtOnlyCount, 2);
  const h = C.card(s);
  assert.ok(h.includes('no deposit paid in pesos') && h.includes('252.31 USDT') && !h.includes('63.53') && !h.includes('64.01'));
});

test('CB3 several peso deposits: the total rate is total pesos / total USDT, not an average of the rates', () => {
  const a = { id: 10, ts: '2026-11-01T00:00:00Z', kind: 'deposit', usdt: 66.4, units: 66.4, php_amount: 5000, php_rate: 75.30120482 };
  const b = { id: 11, ts: '2026-11-02T00:00:00Z', kind: 'deposit', usdt: 170, units: 170, php_amount: 10000, php_rate: 58.82352941 };
  const s = C.summary([b, a], null, null);
  assert.equal(s.php, 15000); near(s.usdt, 236.4, 1e-12);
  assert.equal(s.rate, Math.round((15000 / 236.4) * 1e8) / 1e8); near(s.rate, 63.45177665, 1e-8);
  const avg = (75.30120482 + 58.82352941) / 2;
  assert.ok(Math.abs(s.rate - avg) > 3, 'differs from the plain average ' + avg);
  assert.deepEqual(s.deposits.map((d) => d.id), [10, 11], 'oldest first');
  assert.equal(s.deposits[1].rate, 58.82352941);
  assert.match(C.card(s), /2 peso deposits/); assert.match(C.card(s), /total pesos ÷ total USDT/);
});

test('CB4 mixed deposits and reversed ones: a deposit undone by an Edit counts nowhere (with or without reversed_of)', () => {
  const p = { id: 20, ts: '2026-11-03T00:00:00Z', kind: 'deposit', usdt: 10, units: 11, php_amount: 750, php_rate: 75 };
  const undoA = { id: 21, ts: '2026-11-03T01:00:00Z', kind: 'deposit', usdt: -10, units: -11, php_amount: null, php_rate: 75, reversed_of: 20 };
  const undoB = { ...undoA, reversed_of: undefined };   // an investor's own rows do not carry reversed_of: matched by the exact negative
  for (const undo of [undoA, undoB]) {
    const s = C.summary([james, raf1, p, undo], null, null);
    assert.equal(s.php, 5000); near(s.usdt, 66.4, 1e-12); near(s.usdtOnly, 52.3082, 1e-12); assert.equal(s.usdtOnlyCount, 1);
  }
  const withdrawal = { id: 30, ts: '2026-11-04T00:00:00Z', kind: 'withdrawal', usdt: -5, units: -5, php_amount: null, php_rate: 60 };
  const fee = { id: 31, ts: '2026-11-04T00:00:00Z', kind: 'fee_out', usdt: -1, units: -1 };
  assert.equal(C.summary([james, withdrawal, fee], null, null).php, 5000, 'only deposits are contributions');
});

test('CB5 reference rate: missing, failed and broken responses give no rate; a recent cached one is used and marked; an old one is not', () => {
  assert.equal(C.referenceRate(null, NOW), null);
  assert.equal(C.referenceRate(undefined, NOW), null);
  for (const bad of [null, {}, { rates: {} }, { rates: { PHP: 'abc' } }, { rates: { PHP: 0 } }, { rates: { PHP: -63 } }, { rates: { PHP: 5000 } }, { rates: { PHP: 3 } }, { error: 'quota' }])
    assert.equal(C.parseFx(bad), null, JSON.stringify(bad));
  assert.equal(C.parseFx({ rates: { PHP: 63.11 } }), 63.11); assert.equal(C.parseFx({ rates: { PHP: '58.9' } }), 58.9);
  const fresh = C.referenceRate(live, NOW); assert.equal(fresh.stale, false); assert.equal(fresh.src, 'open.er-api.com');
  const stale = C.referenceRate({ ...live, t: NOW - 2 * 3600e3 }, NOW); assert.equal(stale.stale, true); assert.equal(stale.rate, 63.11);
  assert.equal(C.referenceRate({ ...live, t: NOW - 12 * 3600e3 - 1 }, NOW), null, 'older than 12 hours');
  assert.equal(C.referenceRate({ ...live, t: NOW + 10 * 60000 }, NOW), null, 'from the future');
  assert.equal(C.referenceRate({ ...live, rate: NaN }, NOW), null);
  assert.equal(C.referenceRate({ ...live, rate: 0 }, NOW), null);
  // a reading with no time or source (what a stored deposit or pool-entry rate looks like) is never a reference rate
  assert.equal(C.referenceRate({ rate: 75.27191529 }, NOW), null);
  assert.equal(C.referenceRate({ rate: 75.27191529, t: NOW }, NOW), null);
  const stS = C.summary([james], stale, null); assert.match(C.rows(stS), /last loaded from open\.er-api\.com, 2026-11-07 10:00 UTC/);
  assert.match(C.rows(C.summary([james], fresh, null)), /live from open\.er-api\.com, 2026-11-07 11:55 UTC/);
});

test('CB6 with no reference rate the card says "Rate unavailable" and never falls back to a stored rate', () => {
  const s = C.summary([james], null, { units: 73.31635568, value_usdt: 64.3677 });
  assert.equal(s.ref, null); assert.equal(s.usdEquivalent, null);
  const h = C.card(s);
  assert.equal((h.match(/Rate unavailable/g) || []).length, 2, 'the reference rate line and the USD equivalent line');
  assert.ok(h.includes('₱75.30 per USDT'), 'the effective rate is still shown, as the historical cash-in rate');
  assert.ok(!/75\.30 per USD\b/.test(h) && !h.includes('79.'), 'no USD equivalent worked out from the cash-in rate');
});

test('CB7 the reference rate never changes units or value, and the USD equivalent is kept apart from them', () => {
  const hold = { units: '73.31635568', value_usdt: '64.3677', net_value_usdt: '64.3677' };
  const a = C.summary([james], C.referenceRate(live, NOW), hold);
  const b = C.summary([james], C.referenceRate({ ...live, rate: 40 }, NOW), hold);
  const c = C.summary([james], null, hold);
  for (const s of [b, c]) { assert.equal(s.units, a.units); assert.equal(s.value, a.value); assert.equal(s.netValue, a.netValue); assert.equal(s.usdt, a.usdt); assert.equal(s.rate, a.rate); }
  assert.notEqual(a.usdEquivalent, b.usdEquivalent);
  const h = C.card(a);
  assert.match(h, /Current USD equivalent of the pesos paid.*reference only.*It is not a balance and does not change any units.*79\.23 USD/s);
  assert.match(h, /Current investment value.*units × today's unit price.*64\.37 USDT/s);
  assert.match(h, /Investment units owned.*73\.31635568/s);
  assert.ok(h.indexOf('79.23 USD') < h.indexOf('Investment units owned'), 'the equivalent is not shown as part of the holding');
});

test('CB8 the card: every required line, escaped source, nothing without deposits, the investor sheet leaves out units and value', () => {
  const s = C.summary([james, raf1], C.referenceRate({ ...live, src: '<b>x</b>' }, NOW), { units: 1, value_usdt: 2 });
  const h = C.card(s);
  for (const l of ['Your contribution', 'Original PHP contribution', '₱5,000.00', 'USDT credited to you', '66.40 USDT', 'Effective conversion rate', '₱75.30 per USDT',
    'Current PHP/USD reference rate', '₱63.11 per USD', 'Current USD equivalent of the pesos paid', 'Put in directly in USDT', '52.31 USDT', 'Investment units owned', 'Current investment value'])
    assert.ok(h.includes(l), l);
  assert.ok(!h.includes('<b>x</b>') && h.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.match(C.card(s, 'My contribution'), /<h2>My contribution<\/h2>/);
  assert.equal(C.card(C.summary([], null, { units: 0, value_usdt: 0 })), '');
  const sheet = C.rows(s, { holdings: false });
  assert.ok(sheet.includes('Original PHP contribution') && !sheet.includes('Investment units owned') && !sheet.includes('Current investment value'));
});

test('CB9 effectiveRate: pesos / USDT to 8 decimals, only when both are positive', () => {
  assert.equal(C.effectiveRate(5000, 66.4), 75.30120482);
  assert.equal(C.effectiveRate('6897', '91.6278'), 75.27191529);
  for (const [p, u] of [[5000, 0], [0, 66.4], [null, 66.4], [5000, null], [-5000, 66.4], [5000, 'x'], ['', '']]) assert.equal(C.effectiveRate(p, u), null, `${p} / ${u}`);
});

test('CB10 the calculations never change the rows they are given', () => {
  const rows = [james, raf1, raf2].map((r) => ({ ...r })), before = JSON.stringify(rows);
  C.summary(rows, C.referenceRate(live, NOW), { units: 1, value_usdt: 1 }); C.card(C.summary(rows, null, null));
  assert.equal(JSON.stringify(rows), before);
});

test('CB11 app wiring: the reference rate comes only from the live sources, the deposit form takes pesos + USDT received, the figures are on the manager\'s investor sheet', () => {
  const app = read('js/app.js'), html = read('login.html');
  assert.ok(!/S\.pool && S\.pool\.php_rate|S\.me && S\.me\.php_rate/.test(app), 'no fallback to a pool entry or profile rate');
  assert.match(app, /const rate = \(\) => \{ const r = fxRef\(\); return r \? r\.rate : null; \};/);
  assert.match(app, /const fxRef = \(\) => Contribution\.referenceRate\(S\.fx\);/);
  assert.match(app, /const v = Contribution\.parseFx\(await \(await fetch\(url, \{ signal: ctl\.signal \}\)\)\.json\(\)\);/);
  assert.match(app, /S\.fx = c \? cached : null;/, 'after failed fetches only a recent cached reading is kept');
  assert.match(app, /: 'Peso rate unavailable'; \};/);
  assert.match(app, /<input name="got" type="number"/);
  assert.match(app, /const got = num\(fv\(fm, 'got'\)\), r = Contribution\.effectiveRate\(amt, got\);\r?\n    return r \? \{ usdt: got, php: amt, rate: r \} : \{ usdt: null, php: amt \};/);
  assert.match(app, /admin_receive_deposit', \{ p_profile: fv\(fm, 'who'\), p_usdt: d\.usdt, p_php_rate: d\.rate, p_php_amount: d\.php,/, 'the USDT received is what is recorded');
  assert.ok(!app.includes('Contribution.card('), 'home and My account are kept simple: no contribution card (the investor sheet keeps the rows)');
  assert.match(app, /\$\{Contribution\.rows\(contribOf\(h\), \{ holdings: false \}\)\}/);
  assert.ok(html.indexOf('js/contribution.js') > 0 && html.indexOf('js/contribution.js') < html.indexOf('js/app.js'));
  const lib = read('js/contribution.js');
  assert.ok(!/\bcall\(|fetch\(|supabase|localStorage/.test(lib), 'the module reads nothing and writes nothing');
});

test('CB13 regression on the live records (read 2026-11-07): James and Raf, exactly as stored', () => {
  const raf4 = { id: 4, ts: '2026-11-07T10:21:09Z', kind: 'deposit', usdt: '91.6278', units: '101.17193336', php_amount: '6897', php_rate: '75.27191529' };
  const ref = C.referenceRate(live, NOW);
  const j = C.summary([james], ref, { units: '73.31635568', value_usdt: String(73.31635568 * 0.8779497383813229) });
  const r = C.summary([raf4, raf2, raf1], ref, { units: '356.81618778', value_usdt: String(356.81618778 * 0.8779497383813229) });
  assert.equal(j.units, 73.31635568); assert.equal(r.units, 356.81618778); near(j.units + r.units, 430.13254346, 1e-12, 'total units');
  assert.equal(j.rate, 75.30120482); assert.equal(r.rate, 75.27191529, 'Raf: only deposit #4 was paid in pesos');
  assert.equal(r.php, 6897); near(r.usdt, 91.6278, 1e-12); near(r.usdtOnly, 252.3082, 1e-12); assert.equal(r.usdtOnlyCount, 2);
  near(j.usdEquivalent, 79.2267469, 1e-6); near(r.usdEquivalent, 6897 / 63.11, 1e-9);
  assert.equal(C.putInPesos(j), 5000, 'James: shown as the ₱5,000 he paid');
  assert.equal(C.putInPesos(r), null, 'Raf: part of it was USDT, so "Put in" stays in USDT (no pesos made up for #1, #2)');
  near(j.value, 64.36807529, 1e-6);
});

test('CB14 withdrawals in the summary, and formatting: 8-decimal rates, 2-decimal money, grouped thousands', () => {
  const w1 = { id: 40, ts: '2026-11-08T00:00:00Z', kind: 'withdrawal', usdt: -20, units: -22, php_amount: null, php_rate: 75.27 };
  const back = { id: 41, ts: '2026-11-08T01:00:00Z', kind: 'withdrawal', usdt: 20, units: 22, php_amount: null, php_rate: 75.27, reversed_of: 40 };
  const s = C.summary([james, w1], null, null);
  assert.equal(s.withdrawnUsdt, 20); assert.equal(C.putInPesos(s), null, 'money was taken out: "Put in" in USDT, the stored payout rate is not used');
  assert.equal(C.summary([james, w1, back], null, null).withdrawnUsdt, 0, 'an undone payout cancels');
  assert.equal(C.putInPesos(C.summary([james, w1, back], null, null)), 5000);
  const big = { id: 50, ts: '2026-11-09T00:00:00Z', kind: 'deposit', usdt: 1580.123456, units: 1580.123456, php_amount: 123456.78, php_rate: null };
  const b = C.summary([big], C.referenceRate(live, NOW), null);
  assert.equal(b.rate, 78.13109762); const h = C.card(b);
  assert.ok(h.includes('₱123,456.78') && h.includes('1,580.12 USDT') && h.includes('₱78.13 per USDT') && h.includes('1,956.22 USD'), h);
});

test('CB15 "Where your money stands" and the dashboard total never show USDT turned into pesos as money put in', () => {
  const P = createRequire(import.meta.url)('../js/position.js');
  const pos = { estimate: { reliable: true, value_after_fee_usdt: 59.27, accrued_fee_usdt: 0 }, capital: { contributed_usdt: 66.4, withdrawn_usdt: 0, trading_result_before_fees_usdt: -7.13, fees_paid_usdt: 0, fees_accrued_usdt: 0, net_performance_usdt: -7.13 },
    settlements: [], withdrawals: [], deposits: [] };
  const toPhp = (u) => '₱' + (u * 63.11).toFixed(2), cash = (u) => u.toFixed(2) + ' USDT';
  const h = P.render(pos, { money: toPhp, day: String, cash, paidNote: 'paid as ₱5,000' });
  for (const [k, v] of [['contributed', '66.40 USDT'], ['withdrawn', '0.00 USDT'], ['gross', '-7.13 USDT'], ['net', '-7.13 USDT']]) assert.ok(h.includes(`data-k="${k}">${v}<`), k);
  assert.ok(h.includes('deposits only; never counted as profit · paid as ₱5,000'), 'the pesos really paid, beside the USDT they bought');
  assert.ok(!h.includes('₱4190.50') && !/data-k="(contributed|gross|net)">₱/.test(h), 'no USDT amount turned into pesos in this card: the rows add up in USDT');
  assert.ok(P.render(pos, { money: toPhp, day: String }).includes('data-k="contributed">₱4190.50<'), 'without cash/paidNote the old behaviour is unchanged (other callers)');
  const app = read('js/app.js');
  // Home no longer shows "Where your money stands" (the contribution card's journey replaces it) nor the duplicate estimate hero while the value is reliable
  const home = grab(app, 'function viewHome()', '  function glanceCard(m)');
  assert.ok(!home.includes('Position.render(') && !home.includes('capitalCard'));
  assert.match(home, /\$\{pos && !pos\.estimate\.reliable \? Position\.estimateCard\(pos, fm\) : ''\}/);
  assert.match(app, /\.filter\(\(s\) => s\.deposits\.length \|\| s\.usdtOnlyCount \|\| s\.withdrawnUsdt\)\.map\(Contribution\.putInPesos\)/, 'investors with nothing in do not block the peso total');
});

test('CB16 the reference rate in the app: stored only from the manager\'s fresh live reading, the minimum shown as the database applies it, forms say which rate they use', () => {
  const app = read('js/app.js');
  assert.match(app, /if \(admin && r && !r\.stale && S\.fxSent !== r\.t\) \{ await call\('admin_record_fx_reference', \{ p_rate: r\.rate, p_source: r\.src, p_fetched_at: new Date\(r\.t\)\.toISOString\(\) \}\);/,
    'only the fund manager, only a reading under an hour old, with its own source and time');
  assert.match(app, /try \{ S\.fxDb = await call\('fx_reference'\); \} catch \(e\) \{ if \(e\.message === 'Signed out'\) throw e; S\.fxDb = null; \}/, 'fails quietly before the migration');
  assert.match(app, /'not checked while the fund has no current PHP\/USD reference rate; taking everything is always allowed'/);
  assert.match(app, /about \$\{usdt\(S\.fxDb\.min_withdrawal_usdt\)\} at the fund's PHP\/USD reference rate/);
  assert.match(app, /units \* price \* fxDbRate\(\) < minPhp\(\)/, 'the request hint uses the same rate as the database check');
  assert.match(app, /Current PHP\/USD reference rate \(₱ per USD: peso display and the ₱500 minimum only, never a cash-in rate\)/);
  assert.match(app, /Effective cash-in rate ₱\$\{f\(d\.rate, 2\)\} per USDT \(pesos ÷ USDT received\), kept with the deposit; not today's reference rate\./);
  assert.equal((app.match(/\$\{refFormNote\(\)\}/g) || []).length, 2, 'Money out and Balance forms');
  assert.ok(!/S\.(pool|me)\.php_rate/.test(app), 'no rate stored on a pool entry or profile is read as a current rate');
});

test('CB17 the card at one look: invested -> worth now, and the result so far (James, Raf, no rate, a payout)', () => {
  const ref = C.referenceRate({ rate: 63.08, t: NOW - 60000, src: 'open.er-api.com' }, NOW);
  const s = C.summary([james], ref, { units: '73.31635568', value_usdt: '64.37' }), j = C.journey(s);
  assert.equal(j.inPesos, true); assert.equal(j.paidPhp, 5000); near(j.inUsdt, 66.4, 1e-12); near(j.now, 64.37, 1e-12);
  near(j.arrivedPhp, 66.4 * 63.08, 1e-9); near(j.conversionPhp, 5000 - 66.4 * 63.08, 1e-9); near(j.resultPhp, (64.37 - 66.4) * 63.08, 1e-9); near(j.nowPhp, 64.37 * 63.08, 1e-9);
  near(j.paidPhp - j.conversionPhp + j.resultPhp, j.nowPhp, 1e-9, 'the lines add up: paid − conversion + trading = worth now');
  const h = C.card(s);
  for (const t of ['Invested', '₱5,000', '66.40 USDT at ₱75.30 per USDT', 'Worth now', '64.37 USDT', '≈ ₱4,060 today', 'Result so far', '−2.03 USDT (−3.06%)',
    'You own <b>73.31635568 units</b>', '<summary>All figures</summary>'])
    assert.ok(h.includes(t), t);
  for (const t of ['You paid', 'Lost converting', 'Trading so far', 'class="wf"']) assert.ok(!h.includes(t), 'kept simple: no ' + t);
  assert.ok(h.indexOf('class="jflow"') < h.indexOf('Result so far') && h.indexOf('Result so far') < h.indexOf('All figures'), 'invested and worth now first, the result, the full figures folded away');
  // Raf: pesos and USDT, so the journey is in USDT and nothing is turned into pesos
  const raf4 = { id: 4, ts: '2026-11-07T10:21:09Z', kind: 'deposit', usdt: '91.6278', units: '101.17193336', php_amount: '6897', php_rate: '75.27191529' };
  const r = C.card(C.summary([raf4, raf1, raf2], ref, { units: '356.81618778', value_usdt: '313.27' }));
  for (const t of ['₱6,897 + 252.31 USDT', '343.94 USDT', 'Result so far']) assert.ok(r.includes(t), t);
  // no reference rate: the same journey in USDT, and it says so
  const n = C.card(C.summary([james], null, { units: '73.31635568', value_usdt: '64.37' }));
  assert.ok(n.includes('Result so far') && !n.includes('≈ ₱'));
  // a payout: shown as taken out, and "worth now" says it is after payouts
  const w = C.card(C.summary([james, { id: 9, ts: '2026-12-01T00:00:00Z', kind: 'withdrawal', usdt: -10, units: -11 }], ref, { units: '62', value_usdt: '54.4' }));
  assert.ok(w.includes('Taken out') && w.includes('−10.00 USDT') && w.includes('Worth now (after payouts)'));
  assert.equal(C.card(C.summary([], ref, null)), '');
});

test('CB12 database: the pesos recorded with a deposit never change its units, the pool value or anyone else; the row keeps them and stays append-only', async () => {
  const runs = [];
  for (const [rate, amount] of [[75.30120482, 5000], [10, 664], [null, null]]) {
    const w = await ready();
    await w.call('admin_receive_deposit', w.A, w.ids.john, 66.4, rate, amount, null, new Date(w.now - 60000).toISOString(), null, true);
    const pid = Number((await w.q(`select max(id) i from public.pending_deposits`))[0].i);
    await w.report(1066.4, 0);
    const r = await w.call('admin_admit_deposit_tv', w.A, pid, null);
    const led = (await w.q(`select id, usdt::float u, units::float n, php_rate::float r, php_amount::float a from public.ledger where profile_id = $1`, [w.ids.john]))[0];
    assert.equal(led.a, amount, 'the pesos are kept exactly as recorded');
    // with pesos the effective rate is kept as recorded; without, the database fills in the current reference rate, and there is none here
    // (20261208000000_fx_reference_rate.sql: before it, the last pool entry's rate, 58, was inherited)
    assert.equal(led.r, amount == null ? null : rate);
    await assert.rejects(w.q(`update public.ledger set php_amount = 1 where id = $1`, [led.id]), /append-only|cannot|not allowed/i);
    runs.push({ units: r.units, price: r.unit_price, pool: await w.pool(), raf: await w.units('raf'), usdt: led.u });
  }
  for (const x of runs.slice(1)) {
    near(x.units, runs[0].units, 1e-12); near(x.price, runs[0].price, 1e-15); near(x.pool.e, runs[0].pool.e, 1e-9); near(x.pool.u, runs[0].pool.u, 1e-12);
    near(x.raf, runs[0].raf, 1e-12); near(x.usdt, 66.4, 1e-12);
  }
  near(runs[0].units, 66.4 / runs[0].price, 1e-8, 'units = USDT received / the approved unit price');
});

test('CB18 peso top-up: pesos credited at the live rate, the difference from the manager\'s units, once per deposit, never at a stale rate', () => {
  const ref = C.referenceRate(live, NOW), h = { units: '73.31635568', value_usdt: '64.3677' };
  const t = C.topupDue(C.summary([james], ref, h), ref);
  assert.deepEqual(t.ids, [3]);
  assert.equal(t.credited, 79.226746, '5,000 / 63.11 rounded down to 6 decimals');
  assert.equal(t.gap, 12.826746);
  assert.match(t.note, /^peso top-up for deposit #3: /);
  // stale or missing live rate: nothing is due (a stored or old rate is never used to credit pesos)
  assert.equal(C.topupDue(C.summary([james], C.referenceRate({ ...live, t: NOW - 2 * 36e5 }, NOW), h), C.referenceRate({ ...live, t: NOW - 2 * 36e5 }, NOW)), null);
  assert.equal(C.topupDue(C.summary([james], null, h), null), null);
  // after the top-up: credited = pesos / live rate, the conversion loss is gone, it is not a USDT-only deposit, and nothing more is due even if the rate moves
  const top = { id: 9, ts: '2026-11-07T12:10:00Z', kind: 'deposit', usdt: String(t.gap), units: '14.6', php_amount: null, php_rate: '63.11', note: t.note };
  const s = C.summary([james, top], ref, h);
  near(s.usdt, 79.226746); near(s.rate, 63.11, 1e-4); near(s.topup, 12.826746);
  assert.equal(s.usdtOnlyCount, 0);
  assert.ok(Math.abs(C.journey(s).conversionPhp) < 0.01);
  // the investor's transaction list shows one deposit: ₱5,000 = 79.226746 USDT (the top-up folded in); the rows themselves are untouched
  const list = C.foldTopups([top, james]);
  assert.equal(list.length, 1); assert.equal(list[0].id, 3); near(list[0].usdt, 79.226746); assert.equal(Number(james.usdt), 66.4);
  assert.equal(C.foldTopups([top]).length, 1, 'a top-up whose deposit is not in the list stays as its own row');
  assert.ok(C.card(s).includes('79.23 USDT at ₱63.11 per USDT'));
  const lower = C.referenceRate({ ...live, rate: 60 }, NOW);
  assert.equal(C.topupDue(C.summary([james, top], lower, h), lower), null, 'each peso deposit is topped up once');
  assert.match(C.rows(s), /Topped up by the fund manager/);
  // a USDT-only deposit is never topped up
  assert.equal(C.topupDue(C.summary([raf1, raf2], ref, h), ref), null);
});

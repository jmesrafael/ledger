// js/truevalue-ui.js (what the pages show for true-value pricing) and its wiring in the app. Words only: every number comes from the database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const T = createRequire(import.meta.url)('../js/truevalue-ui.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const base = { mode: 'true_value', enabled: true, ok: true, allowed: true, reasons: [], as_of: '2026-11-07T12:00:00Z', unit_price: 0.9049, book_price: 0.8586,
  true_value_usdt: 231.33, combined_equity_usdt: 389.36, not_in_pool_usdt: 158.03, redeemed_not_sent_usdt: 0, open_pnl_usdt: 11.78, gap_usdt: 0.07, tolerance_usdt: 0.5,
  pool_cash_usdt: 210, wallets: [{ wallet: 'bbcore', label: 'BB-Core', status: 'ok', equity_usdt: 197, unrealized_usdt: 7.18, received_at: '2026-11-07T11:58:00Z' }],
  checkpoints: [], corrections: [{ id: 1, amount_usdt: -4.9258, status: 'prepared', reason: 'BB-Core SOL short <b>skipped</b>' }] };

test('TVU1 nothing is shown before the migration (null) and the investor card stays hidden while the setting is off', () => {
  assert.equal(T.adminCard(null), ''); assert.equal(T.investorCard(null), '');
  assert.equal(T.investorCard({ enabled: false, allowed: false, reasons: [] }), '');
});

test('TVU2 the state line: allowed with the price; blocked with every reason; off says it is a preview', () => {
  assert.match(T.state(base).text, /can join or leave now at 0\.9049/);
  const blocked = { ...base, ok: false, allowed: false, reasons: [{ code: 'stale', text: 'wallet icore last reported 45 minutes ago (limit 30)' }, { code: 'gap', text: 'the exchange differs' }] };
  assert.match(T.state(blocked).text, /cannot join or leave right now: wallet icore last reported 45 minutes ago \(limit 30\); the exchange differs/);
  assert.match(T.state({ ...base, enabled: false, allowed: false }).text, /off: deposits and payouts use the normal steps\. This reading is a preview/);
  assert.match(T.state({ ...blocked, enabled: false }).text, /off\. If it were on, money could not move now: wallet icore/);
});

test('TVU3 the manager card shows the price, both prices, the reading, the wallets and the corrections, escaped', () => {
  const h = T.adminCard(base);
  for (const s of ['True unit price', '0.9049', '0.8586', '231.33 USDT', '+11.78 USDT', '+0.07 USDT', 'BB-Core', 'Correction #1', '−4.93 USDT', 'change nothing until they are applied'])
    assert.ok(h.includes(s), s);
  assert.ok(!h.includes('<b>skipped</b>') && h.includes('&lt;b&gt;skipped&lt;/b&gt;'), 'reasons and notes are escaped');
});

test('TVU4 the investor card shows value, withdrawable now and the part in open trades, nothing about the pool', () => {
  const h = T.investorCard({ enabled: true, allowed: true, reasons: [], unit_price: 0.9049, value_usdt: 66.4, withdrawable_now_usdt: 60.27, locked_in_trades_usdt: 6.13 });
  for (const s of ['Your money right now', '66.40 USDT', '60.27 USDT', '6.13 USDT']) assert.ok(h.includes(s), s);
  assert.ok(!/wallet|BB-Core|Checkpoint/i.test(h));
});

test('TVU5 the app loads the right call per role (failing quietly before the migration) and the page includes the script', () => {
  const app = read('js/app.js'), html = read('login.html');
  assert.match(app, /group\(async \(\) => \{ S\.tv = await call\(admin \? 'admin_true_value' : 'my_true_value'\); \}, \(\) => \{ S\.tv = null; \}\)/);
  assert.match(app, /\$\{TVUI\.adminCard\(S\.tv\)\}/); assert.match(app, /\$\{investor \? TVUI\.investorCard\(S\.tv\) : ''\}/);
  assert.ok(html.indexOf('js/truevalue-ui.js') > 0 && html.indexOf('js/truevalue-ui.js') < html.indexOf('js/app.js'));
});

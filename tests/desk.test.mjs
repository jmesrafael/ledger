// js/desk.js: the four routine steps' forms and the live NAV wording. No accounting is done here; these tests check what each form sends and how the
// database's answers are worded (DK1-DK6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const Desk = createRequire(import.meta.url)('../js/desk.js');

test('DK1 the Record tab: the four steps first, the accounting screens folded below', () => {
  const h = Desk.tabs('cash');
  for (const l of ['Add investor', 'Cash in', 'Withdraw', 'Transfer', 'Live NAV', 'Balance', 'History']) assert.ok(h.includes(l), l);
  assert.ok(h.indexOf('Add investor') < h.indexOf('Live NAV'));
  assert.ok(/class="on" data-rec="cash"/.test(h));
  assert.ok(Desk.isDesk('move') && Desk.isDesk('nav') && !Desk.isDesk('eq'));
});

test('DK2 what each form sends: pesos with their rate, USDT alone without one; incomplete forms send nothing', () => {
  assert.deepEqual(Desk.cashArgs({ who: 'u1', php: '5000', usdt: '79.25', rate: '63.08', inmexc: true }),
    { p_profile: 'u1', p_php_amount: 5000, p_usdt_received: 79.25, p_rate: 63.08, p_in_mexc: true });
  assert.equal(Desk.cashArgs({ who: 'u1', php: '', usdt: '50', rate: '63', inmexc: false }).p_rate, null, 'USDT only: no rate is sent');
  assert.equal(Desk.cashArgs({ who: 'u1', php: '5000', usdt: '' }), null);
  assert.deepEqual(Desk.outArgs({ who: 'u1', usdt: '', all: true, lock: '' }), { p_profile: 'u1', p_usdt: null, p_all: true, p_request: null, p_lock_reason: null });
  assert.equal(Desk.outArgs({ who: 'u1', usdt: '', all: false }), null);
  assert.deepEqual(Desk.moveArgs({ from: 'a', to: 'b', php: '1160', usdt: '', rate: '58', all: false }), { p_from: 'a', p_to: 'b', p_php_amount: 1160, p_usdt: null, p_rate: 58, p_all: false });
  assert.equal(Desk.moveArgs({ from: 'a', to: 'b', php: '', usdt: '', all: false }), null);
});

test('DK3 the add-investor preview follows the database rule: pesos ÷ rate rounded down; the gap is the manager\'s either way', () => {
  assert.deepEqual(Desk.credit(5000, 66.4, 63.083992), { credited: 79.25941, topup: 12.85941, surplus: 0 });
  assert.deepEqual(Desk.credit(5800, 103, 58), { credited: 100, topup: 0, surplus: 3 });
  assert.deepEqual(Desk.credit(null, 50, 58), { credited: 50, topup: 0, surplus: 0 });
  assert.equal(Desk.credit(5000, null, 58), null);
});

test('DK4 the quotes are worded from the database\'s figures; a refusal says why', () => {
  assert.match(Desk.cashText({ php_amount: 5800, rate: 58, credited_usdt: 100, topup_usdt: 5, surplus_usdt: 0, status: 'admitted', unit_price: 1.05, units: 95.238 }), /from <b>your<\/b> units[\s\S]*Joins <b>now<\/b> at 1\.0500/);
  assert.match(Desk.cashText({ credited_usdt: 50, topup_usdt: 0, surplus_usdt: 0, status: 'waiting', waiting_reason: 'blocked: wallet tcore last reported 40 minutes ago' }), /first verified reading[\s\S]*tcore/);
  assert.match(Desk.outText({ pay_usdt: 54, unit_price: 1.1, fee_units: 0.9, payable_now_before_usdt: 300 }), /54\.000000 USDT[\s\S]*profit share/);
  assert.match(Desk.moveText({ gross_units: 50, sender_value_moved_usdt: 55, fee_usdt: 1, usdt: 54, net_units: 49.09, unit_price: 1.1 }), /recipient gets <b>54\.000000 USDT/);
  assert.match(Desk.refused('PAYOUT QUEUED: about 50 USDT'), /refuse this: PAYOUT QUEUED/);
  assert.match(Desk.refused('Could not find the function public.admin_cash_in in the schema cache'), /run 20261213000000_live_nav\.sql/);
});

test('DK5 the live line: live with its time, paused with the reason (manager) — an investor never sees pool figures', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  assert.match(Desk.navLine({ live: true, current: true, unit_price: 1.0089, ts: '2026-11-13T09:57:00Z' }, now), /Live[\s\S]*1\.0089[\s\S]*3 min ago/);
  assert.match(Desk.navLine({ live: true, current: false, unit_price: 1.0089, ts: '2026-11-13T09:00:00Z', reasons_now: [{ text: 'wallet tcore last reported 40 minutes ago' }] }, now), /Paused[\s\S]*tcore/);
  assert.equal(Desk.navLine({ live: false }), '');
  assert.equal(Desk.navLine(null), '');
});

test('DK6 the Live NAV screen: reconciliation rows and readings; before the migration it says so', () => {
  const n = { current: false, blocked_since: '2026-11-13T09:00:00Z', reasons_now: [{ text: '1 bot exit(s) have no booked MEXC result yet' }], unit_price: 0.85, latest_verified: null,
    reconciliation: { holders: [{ name: 'Raf', role: 'admin', units: 342.7, share: 0.8, value_usdt: 291 }], nav_usdt: 365, sum_of_holders_usdt: 365, mexc_equity_usdt: 433.97, gap_usdt: 13.36, tolerance_usdt: 0.5 },
    recent: [{ ts: '2026-11-13T09:55:00Z', source: 'wallet_report', status: 'blocked', reasons: [{ text: 'gap' }] }], settings: { nav_auto: 'on' }, payable_now_usdt: 280 };
  const h = Desk.navCard(n, Date.parse('2026-11-13T10:00:00Z'));
  assert.match(h, /Paused since 60 min ago[\s\S]*no booked MEXC result/);
  assert.match(h, /Raf \(you\)/); assert.match(h, /blocked/);
  assert.match(Desk.navCard(null), /run 20261213000000_live_nav\.sql/);
});

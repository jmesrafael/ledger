// The daily books-vs-MEXC check (scripts/recon-lib.mjs). Pure logic on a synthetic export; numbers follow the Nov 10 audit
// (pool 365.76; wallets minus open-trade profit 365.57 -> gap -0.19, inside the 0.50 tolerance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, backupHealth, formatReport } from '../scripts/recon-lib.mjs';

const NOW = new Date('2026-11-11T08:00:00Z');
const mins = (m) => new Date(NOW - m * 60000).toISOString();
function world(over = {}) {
  return {
    bot_wallets: [{ wallet: 'bbcore', label: 'BB-Core', active: true }, { wallet: 'icore', label: 'I-Core', active: true }],
    wallet_snapshots: [
      { wallet: 'bbcore', seq: 1, received_at: mins(60), equity_usdt: '100', unrealized_usdt: '0' },      // old one: must be ignored
      { wallet: 'bbcore', seq: 2, received_at: mins(3), equity_usdt: '200.50', unrealized_usdt: '1.00' },
      { wallet: 'icore', seq: 5, received_at: mins(2), equity_usdt: '166.57', unrealized_usdt: '0.50' }],  // wallets 367.07, open profit 1.50 -> 365.57
    pool_equity: [{ id: 1, ts: mins(900), equity_usdt: '300', total_units: '400' }, { id: 2, ts: mins(500), equity_usdt: '365.76', total_units: '430.1325' }],
    ledger: [{ units: '430.1325' }], payout_records: [], pending_deposits: [], settings: [],
    ...over };
}

test('R1 the audit numbers -> ok, newest snapshot used, open-trade profit added back', () => {
  const r = reconcile(world(), { now: NOW });
  assert.equal(r.verdict, 'ok');
  assert.equal(r.wallet_equity, 367.07);
  assert.equal(r.expected, 367.26);          // 365.76 pool + 1.50 open-trade profit
  assert.equal(r.gap, -0.19);
  assert.equal(r.tolerance, 0.5);
});

test('R2 a missed transfer (a $5 gap, like the Oct/Nov errors) -> review', () => {
  const w = world(); w.wallet_snapshots[2].equity_usdt = '161.57';
  const r = reconcile(w, { now: NOW });
  assert.equal(r.verdict, 'review'); assert.equal(r.gap, -5.19); assert.match(r.problems[0], /gap -5.19/);
});

test('R3 the tolerance grows with the balance (0.05%) and honours the ledger settings', () => {
  const big = world({ pool_equity: [{ id: 2, ts: mins(5), equity_usdt: '10000', total_units: '430.1325' }] });
  big.wallet_snapshots = [{ wallet: 'bbcore', seq: 1, received_at: mins(1), equity_usdt: '5004', unrealized_usdt: '0' }, { wallet: 'icore', seq: 1, received_at: mins(1), equity_usdt: '5000', unrealized_usdt: '0' }];
  assert.equal(reconcile(big, { now: NOW }).tolerance, 5); assert.equal(reconcile(big, { now: NOW }).verdict, 'ok');   // gap 4 <= 5
  big.settings = [{ key: 'pool_recon_tol_abs', value: '0.5' }, { key: 'pool_recon_tol_pct', value: '0.0001' }];
  assert.equal(reconcile(big, { now: NOW }).verdict, 'review');                                                          // tolerance 1
});

test('R4 a bot that stopped reporting (stale) or never reported -> not_fresh, no number judged', () => {
  const w = world(); w.wallet_snapshots[2].received_at = mins(200);
  const r = reconcile(w, { now: NOW });
  assert.equal(r.verdict, 'not_fresh'); assert.equal(r.gap, undefined); assert.match(r.problems[0], /icore.*200 minutes/);
  const m = world(); m.wallet_snapshots = m.wallet_snapshots.filter((s) => s.wallet !== 'icore');
  assert.match(reconcile(m, { now: NOW }).problems[0], /never reported/);
});

test('R5 an unaccepted suspect snapshot blocks; an accepted one does not', () => {
  const w = world(); w.wallet_snapshots[1].suspect = true;
  assert.equal(reconcile(w, { now: NOW }).verdict, 'not_fresh');
  w.wallet_snapshots[1].accepted_at = mins(1);
  assert.equal(reconcile(w, { now: NOW }).verdict, 'ok');
});

test('R6 no wallet tables in the export -> no_data (not a false ok)', () => {
  const w = world(); delete w.bot_wallets; delete w.wallet_snapshots;
  assert.equal(reconcile(w, { now: NOW }).verdict, 'no_data');
});

test('R7 money redeemed but not yet sent is still in the wallets; queued money only when it waits in Futures', () => {
  const w = world({ payout_records: [{ leaves_mexc: true, status: 'awaiting', amount_usdt: '20' }, { leaves_mexc: false, status: 'awaiting', amount_usdt: '99' }, { leaves_mexc: true, status: 'sent', amount_usdt: '7' }] });
  w.wallet_snapshots[2].equity_usdt = '186.57';
  assert.equal(reconcile(w, { now: NOW }).verdict, 'ok');                                    // only the 20 counts
  const q = world({ pending_deposits: [{ status: 'pending', usdt: '50' }, { status: 'converted', usdt: '80' }] });
  assert.equal(reconcile(q, { now: NOW }).verdict, 'ok');                                    // queued in Spot: not in the wallets
  q.settings = [{ key: 'queued_money_location', value: 'futures' }]; q.wallet_snapshots[2].equity_usdt = '216.57';
  assert.equal(reconcile(q, { now: NOW }).verdict, 'ok');                                    // queued in Futures: expected +50
});

test('R8 units that do not match the last equity reading -> review', () => {
  const r = reconcile(world({ ledger: [{ units: '430' }] }), { now: NOW });
  assert.equal(r.verdict, 'review'); assert.match(r.problems.join(' '), /units/);
});

test('R9 a missing third wallet is shown as a note (T-CORE is not part of the total)', () => {
  const w = world({ settings: [{ key: 'wallet_expected_count', value: '3' }] });
  assert.match(reconcile(w, { now: NOW }).notes[0], /2 of the 3/);
});

test('R10 backup health and the Telegram text', () => {
  assert.equal(backupHealth(null, NOW).ok, false);
  assert.equal(backupHealth({ at: mins(60), ok: true }, NOW).ok, true);
  assert.equal(backupHealth({ at: new Date(NOW - 5 * 86400000).toISOString(), ok: true }, NOW).ok, false);
  assert.match(backupHealth({ at: mins(60), ok: false, error: 'key rejected' }, NOW).text, /FAILED.*key rejected/);
  const t = formatReport(reconcile(world(), { now: NOW }), backupHealth(null, NOW));
  assert.match(t, /^Ledger vs MEXC: OK/); assert.match(t, /gap -0.19/); assert.match(t, /backup: no automatic backup/);
  assert.ok(!/token|key=/i.test(t));
});

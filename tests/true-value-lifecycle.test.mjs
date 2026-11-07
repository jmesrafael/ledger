// True-value pricing, the whole lifecycle on the database (migration 20261207000000), every call as the website's public role.
//   L1 deposits, a payout and a period-end settlement while trades are open; trades close; a second settlement charges nothing again; every number against the model
//   L2 a wallet report goes stale between the status check and the operation: refused, nothing written
//   L3 an operation interrupted at its last write (deposit, payout, settlement, correction): nothing is left behind; the retry applies exactly once; a second retry replays
//   L4 while true-value pricing is on, the old typed-total steps are refused; automatic trade bookings and corrections still work
//   L5 a deposit priced as of an earlier complete reading (the Nov 7, 2026 case): one wallet reports late, a trade closes in between; the result equals "joined then"
//   L6 idempotency keys: the same key returns the first answer, the same deposit / payout / settlement period cannot be applied twice
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, ready, adv, near, TV } from './_tvworld.mjs';

const counts = async (w) => (await w.q(`select (select count(*)::int from public.pool_equity) e, (select count(*)::int from public.ledger) l, (select count(*)::int from public.flow_checkpoints) c,
  (select count(*)::int from public.payout_records) p, (select count(*)::int from public.settlements) s, (select count(*)::int from public.idempotency_keys) k,
  (select count(*)::int from public.pending_deposits where status = 'pending') pd`))[0];
async function request(w, who, units) {
  const t = (await w.call('login', who, who + '-password')).token;
  await w.call('set_my_payout', t, 'gcash', who, '09171234567', null, null);
  await w.call('request_withdrawal', t, units, null);
  const rid = Number((await w.q(`select max(id) i from public.withdrawal_requests`))[0].i);
  await w.call('admin_approve_withdrawal', w.A, rid, null, null);
  return rid;
}
const value = async (w, who) => (await w.units(who)) * (await w.pool()).p;

test('L1 lifecycle with open trades: deposits, payout, settlement with fees, trades close, no second fee; every flow fair at its moment', async () => {
  const w = await ready();                                   // raf 1000 units at 1.00
  await w.mode('fee_timing', 'immediate');                  // as on the live ledger (Nov 7, 2026)
  // 1. John joins while BB-Core holds +60 open
  let pid = await w.receive('john', 500); await w.report(1500, 60);
  let r = await w.call('admin_admit_deposit_tv', w.A, pid, null);
  near(r.unit_price, 1.06, 1e-9); const john1 = 500 / 1.06; near(await w.units('john'), john1, 1e-8);
  // 2. that trade closes at exactly +60; a new one opens at -30; Dino joins
  await adv(w, 20); await w.trade({ pos: 't1', pnl: 60 });
  near((await w.pool()).p, 1.06, 1e-9, 'the price is where John joined');
  await adv(w, 5); pid = await w.receive('dino', 300); await w.report(1560 + 300, -30);
  r = await w.call('admin_admit_deposit_tv', w.A, pid, null);
  const p2 = (1560 - 30) / (1000 + john1); near(r.unit_price, p2, 1e-9);
  const dino1 = 300 / p2;
  // 3. -30 closes at -30; +90 opens; John takes out half while it is open (fee on his gain above 500 at the true price)
  await adv(w, 20); await w.trade({ pos: 't2', pnl: -30 });
  await adv(w, 5); await w.report(1830, 90);
  const units3 = 1000 + john1 + dino1, p3 = 1920 / units3;
  const rid = await request(w, 'john', john1 / 2);
  const out = await w.call('admin_execute_withdrawal_tv', w.A, rid, 58, null, null);
  near(out.unit_price, p3, 1e-9);
  const johnGain = john1 * p3 - 500, feeU = Math.floor((0.2 * johnGain * 0.5 / p3) * 1e8) / 1e8;   // half his units go out: half his gain is charged now
  near(out.fee_units, feeU, 1e-6, 'payout fee = 20% of the gain on the units taken out');
  near(out.pay_usdt, (john1 / 2 - out.fee_units) * p3, 1e-4);
  const ckpt = (await w.q(`select * from public.flow_checkpoints where kind = 'withdrawal'`))[0]; near(ckpt.open_pnl, 90);
  // 4. period-end settlement with the +90 still open: fees at the true price; the open P&L leaves the book afterwards
  await adv(w, 10); await w.report(1830, 90);                // the payout is redeemed but not sent yet: the money is still in the exchange (counted as redeemed-not-sent)
  const before = { raf: await w.units('raf'), john: await w.units('john'), dino: await w.units('dino') };
  // the existing policy holds: with 'immediate' fees, settling while trades are open needs a written exception for this exchange total
  await assert.rejects(w.call('admin_close_quarter_tv', w.A, 58, null, null), /OPEN TRADES/);
  await w.call('admin_approve_settlement_exception', w.A, 'open_positions', 1920, 'test: settle with the +90 trade open, fee on the true value', new Date(w.now).toISOString(), 3);
  const s = await w.call('admin_close_quarter_tv', w.A, 58, null, null);
  assert.equal(s.exception_ids.length, 1, 'the exception is recorded on the settlement');
  near(s.unit_price, p3, 1e-6, 'the settlement price is the true price (unchanged since the payout)');
  const lines = await w.q(`select p.username u, l.* from public.settlement_lines l join public.profiles p on p.id = l.profile_id where l.equity_id = $1 order by p.username`, [s.equity_id]);
  for (const l of lines) near(Number(l.fee_usdt), Math.max(0, Number(l.value_before) - Number(l.hwm_before)) * 0.2, 1e-5, `${l.u}: fee = 20% of the value above the mark`);
  assert.ok(Number(lines.find((l) => l.u === 'dino').fee_usdt) > 0, 'Dino is charged on what he gained since joining');
  near((await w.pool()).e, 1830 - out.pay_usdt, 1e-6, 'the book holds no open P&L after the settlement');
  near((await w.units('raf')) - before.raf, s.fee_units, 1e-8, 'fee units moved to the manager, nothing else changed');
  // 5. the +90 closes exactly as marked: the price lands on the settlement price; a second settlement charges nothing
  await adv(w, 20); await w.trade({ pos: 't3', pnl: 90 });
  near((await w.pool()).p, p3, 1e-9);
  await adv(w, 5); await w.report(1830 + 90, 0);
  const s2 = await w.call('admin_close_quarter_tv', w.A, 58, null, null);
  near(s2.fee_units, 0, 1e-9, 'the realization of profit already charged is not charged again');
  // everybody's value adds up to the pool, and the pool to the money
  const total = (await value(w, 'raf')) + (await value(w, 'john')) + (await value(w, 'dino'));
  near(total, (await w.pool()).e, 1e-5);
  near((await w.pool()).e, 1000 + 500 + 300 + 60 - 30 + 90 - out.pay_usdt, 1e-5, 'pool = money in − money out + every trade once');
  const cps = await w.q(`select kind from public.flow_checkpoints order by id`);
  assert.deepEqual(cps.map((c) => c.kind), ['deposit', 'deposit', 'withdrawal', 'settlement', 'settlement']);
});

test('L2 a wallet report goes stale between the status check and the operation: refused, nothing written', async () => {
  const w = await ready();
  const pid = await w.receive('john', 200); await w.report(1200, 0);
  assert.equal((await w.status()).allowed, true);
  await adv(w, 31);
  const c0 = await counts(w);
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, pid, 'k-stale'), /blocked: wallet .* last reported 31 minutes ago/);
  assert.deepEqual(await counts(w), c0);
  await w.report(1200, 0); assert.equal((await w.call('admin_admit_deposit_tv', w.A, pid, 'k-stale')).units > 0, true, 'after a fresh report it goes through with the same key');
});

test('L3 interrupted at the last write: nothing is left behind, the retry applies exactly once, a second retry replays', async () => {
  const w = await ready();
  const fail = () => w.db.exec(`create or replace function public._test_fail() returns trigger language plpgsql as $$ begin raise exception 'simulated crash'; end $$;
    create trigger test_fail before insert on public.flow_checkpoints for each row execute function public._test_fail();`);
  const heal = () => w.db.exec(`drop trigger test_fail on public.flow_checkpoints;`);
  // deposit
  const pid = await w.receive('john', 500); await w.report(1500, 40);
  let c0 = await counts(w); await fail();
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, pid, 'dep-1'), /simulated crash/);
  assert.deepEqual(await counts(w), c0, 'no pool entry, unit, checkpoint or key survives'); near(await w.units('john'), 0);
  await heal();
  const a = await w.call('admin_admit_deposit_tv', w.A, pid, 'dep-1'), b = await w.call('admin_admit_deposit_tv', w.A, pid, 'dep-1');
  assert.equal(b.replayed, true); near(b.units, a.units); near(await w.units('john'), a.units, 1e-12, 'units only once');
  // payout
  await adv(w, 5); await w.report(1500, 40);
  const rid = await request(w, 'john', 100);
  c0 = await counts(w); await fail();
  await assert.rejects(w.call('admin_execute_withdrawal_tv', w.A, rid, 58, null, 'pay-1'), /simulated crash/);
  assert.deepEqual(await counts(w), c0, 'no payout record, entry or unit change');
  assert.equal((await w.q(`select status from public.withdrawal_requests where id = $1`, [rid]))[0].status, 'pending');
  await heal();
  const p1 = await w.call('admin_execute_withdrawal_tv', w.A, rid, 58, null, 'pay-1'), p2 = await w.call('admin_execute_withdrawal_tv', w.A, rid, 58, null, 'pay-1');
  assert.equal(p2.replayed, true); assert.equal((await w.q(`select count(*)::int n from public.payout_records where request_id = $1`, [rid]))[0].n, 1, 'one payout');
  await assert.rejects(w.call('admin_execute_withdrawal_tv', w.A, rid, 58, null, 'pay-2'), /duplicate refused/);
  // settlement
  await adv(w, 5); await w.report(1500, 40);                  // the payout money is still in the exchange until it is sent
  c0 = await counts(w); await fail();
  await assert.rejects(w.call('admin_close_quarter_tv', w.A, 58, null, 'set-1'), /simulated crash/);
  assert.deepEqual(await counts(w), c0, 'no settlement, line or fee survives');
  await heal();
  const s1 = await w.call('admin_close_quarter_tv', w.A, 58, null, 'set-1'), s2 = await w.call('admin_close_quarter_tv', w.A, 58, null, 'set-1');
  assert.equal(s2.replayed, true); assert.equal(s2.settlement_id, s1.settlement_id); assert.equal((await counts(w)).s, 1);
});

test('L4 with true-value pricing on, the old typed-total steps are refused; trade bookings and corrections still work', async () => {
  const w = await ready();
  await w.report(1000, 25);
  await assert.rejects(w.call('admin_close_quarter', w.A, 1025, 58, null, null, null, true), /true-value pricing is on: a close entry/);
  await assert.rejects(w.call('admin_post_equity', w.A, 1025, 58, null, null), /true-value pricing is on/);
  await adv(w, 10); await w.trade({ pos: 'z', pnl: 5 }); near((await w.pool()).e, 1005, 1e-9, 'automatic bookings are not affected');
  await w.db.query(`insert into public.book_corrections(amount_usdt, reason) values (-1, 'test correction with a long enough reason')`);
  const c = (await w.call('admin_book_corrections', w.A))[0];
  await w.call('admin_apply_book_correction', w.A, c.id, null); near((await w.pool()).e, 1004, 1e-9);
  await w.mode('flow_pricing', 'book');
  await w.call('admin_post_equity', w.A, 1004, 58, null, null);   // switched off again: the old step works as before
  near((await w.pool()).e, 1004, 1e-9);
});

test('L5 deposits priced as of an earlier complete reading: a wallet reported late, a trade closed in between; equal to "joined then"', async () => {
  const w = await ready();                                     // raf 1000
  const t0 = w.now;
  await w.report(1000, 30);                                    // all three wallets at t0, +30 open (bbcore 15, icore 7.5, tcore 7.5)
  await adv(w, 4);                                             // money arrives in two wallets; the third (tcore) has not reported since t0 ... and then reports
  const pj = await w.receive('john', 100), pr = await w.receive('raf', 58);
  await adv(w, 5);
  const asOf = w.now;
  await w.report(1158, 30);                                    // first complete set with the money inside (it is excluded as waiting money)
  await adv(w, 30); await w.trade({ pos: 'mid', pnl: 12 });    // a trade that was open at asOf closes at +12 (it was +15 of the +30)
  await adv(w, 5); await w.report(1158 + 12, 18);
  const as = await w.call('admin_true_value_at', w.A, new Date(asOf).toISOString());
  assert.equal(as.ok, true, JSON.stringify(as.reasons)); near(as.unit_price, 1.03, 1e-9); near(as.realized_since_usdt, 12, 1e-9);
  const before = await w.call('admin_true_value_at', w.A, new Date(t0 + 60000).toISOString());   // before the arrivals: the money was not in the wallets yet
  assert.equal(before.ok, false); assert.ok(before.reasons.some((x) => x.code === 'gap'), 'pricing before the arrival is refused: the waiting money is not there');
  const r = await w.call('admin_admit_deposits_tv', w.A, [pj, pr], new Date(asOf).toISOString(), null);
  near(r.unit_price, 1.03, 1e-9); near(r.realized_since, 12, 1e-9);
  // ground truth: both joined at asOf at 1.03; afterwards the trades end: the +15 became +12 (-3), the other +15 closes at +15
  await adv(w, 30); await w.trade({ pos: 'rest', pnl: 15 });
  const units = 1000 + 158 / 1.03, p = (await w.pool()).p;
  near((await w.pool()).e, 1000 + 158 + 12 + 15, 1e-6);
  near((await w.units('john')) * p, 100 - 3 * (100 / 1.03) / units, 1e-5, 'John: his money, minus his share of the -3 after he joined');
  near((await w.units('raf')) * p, 1030 + 58 - 3 * (1000 + 58 / 1.03) / units, 1e-5, 'Raf: 1030 at that time + his 58, minus his share of the -3');
  // an as-of reading cannot be used once anything but trade bookings / corrections came after it
  const pd = await w.receive('dino', 50); await adv(w, 5); await w.report(1185 + 50, 0);
  await assert.rejects(w.call('admin_admit_deposits_tv', w.A, [pd], new Date(asOf).toISOString(), null), /cannot be priced as of then any more/);
});

test('L6 idempotency keys and duplicates for every operation', async () => {
  const w = await ready();
  const p1 = await w.receive('john', 100), p2 = await w.receive('dino', 100); await w.report(1200, 0);
  const a = await w.call('admin_admit_deposits_tv', w.A, [p1, p2], null, 'batch');
  assert.equal((await w.call('admin_admit_deposits_tv', w.A, [p1, p2], null, 'batch')).replayed, true);
  await assert.rejects(w.call('admin_admit_deposits_tv', w.A, [p1], null, 'other'), /duplicate refused/);
  await assert.rejects(w.call('admin_admit_deposits_tv', w.A, [p1, p1], null, null), /listed twice/);
  assert.equal(a.deposits.length, 2); assert.equal((await w.q(`select count(*)::int n from public.flow_checkpoints`))[0].n, 2);
  assert.equal((await w.call('admin_admit_deposit_tv', w.A, p2, 'batch')).replayed, true, 'the same key for the same operation replays');
  await assert.rejects(w.call('admin_close_quarter_tv', w.A, 58, null, 'batch'), /already used for another operation/);
  await w.db.query(`insert into public.book_corrections(amount_usdt, reason) values (0.5, 'test correction with a long enough reason')`);
  const c = (await w.call('admin_book_corrections', w.A))[0];
  const k1 = await w.call('admin_apply_book_correction', w.A, c.id, 'corr'), k2 = await w.call('admin_apply_book_correction', w.A, c.id, 'corr');
  assert.equal(k2.replayed, true); near(k2.equity_after, k1.equity_after);
  await assert.rejects(w.call('admin_apply_book_correction', w.A, c.id, 'corr-2'), /duplicate refused/);
  const prev = await w.call('admin_preview_book_corrections', w.A);
  assert.equal(prev.steps.length, 1, 'nothing left to preview once applied');
});

test('L7 with "confirmed" fee timing a settlement may run with trades open (a warning, no exception): fees come from the same engine, each gain charged once', async () => {
  const w = await ready(); await w.mode('fee_timing', 'confirmed');
  const pid = await w.receive('john', 500); await w.report(1500, 0); await w.call('admin_admit_deposit_tv', w.A, pid, null);
  await adv(w, 10); await w.report(1500, 75);                                   // +75 open: John's gain is 25, not confirmed yet
  const s1 = await w.call('admin_close_quarter_tv', w.A, 58, null, null);
  assert.ok(s1.warnings.some((x) => /OPEN TRADES/.test(x)), 'the open trades are reported as a warning');
  const l1 = (await w.q(`select * from public.settlement_lines where equity_id = $1`, [s1.equity_id]))[0];
  near(Number(l1.fee_usdt), 0, 1e-9, 'a gain made since the last settlement waits for the next one (confirmed timing)'); near(Number(l1.pending_profit), 25, 1e-6);
  await adv(w, 20); await w.trade({ pos: 'c1', pnl: 75 });                   // closes exactly as marked
  await adv(w, 5); await w.report(1575, 0);
  const s2 = await w.call('admin_close_quarter_tv', w.A, 58, null, null);
  const l2 = (await w.q(`select * from public.settlement_lines where equity_id = $1`, [s2.equity_id]))[0];
  near(Number(l2.fee_usdt), 25 * 0.2, 1e-5, 'now confirmed: charged once, on the 25');
  await adv(w, 5); await w.report(1575, 0);
  const s3 = await w.call('admin_close_quarter_tv', w.A, 58, null, null);
  near(s3.fee_usdt, 0, 1e-9, 'never again');
});

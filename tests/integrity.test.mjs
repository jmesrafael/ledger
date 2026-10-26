// Ledger integrity remediation (20261101000000_ledger_integrity.sql). Test numbers follow the remediation brief:
// A unit accounting · B recovery · C deposits/withdrawals · D corrections + idempotency · E exchange reconciliation ·
// F locking (static; the real two-connection test is tests/concurrency.docker.mjs) · G randomized model check · H old data + migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, near, r6, BOT_KEY } from './_world.mjs';

const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
// scenario helpers confirm big moves on purpose; the M2 test checks the refusal itself
const post = (w, eq, idem = null, confirm = true) => w.call('admin_post_equity', w.A, eq, null, null, null, idem, confirm);
const close = (w, eq, idem = null, confirm = true) => w.call('admin_close_quarter', w.A, eq, null, null, null, idem, confirm);
const wd = (w, who, units, eqBefore, extra = {}) => w.call('admin_withdraw', w.A, w.ids[who], units, eqBefore, null, null, extra.force ?? false, extra.req ?? null, null, extra.idem ?? null, extra.confirm ?? true);
const john1000 = async (opts) => { const w = await build(opts); await w.join('john', 1000, 1000); return w; };

// ============================================================ A. unit accounting
test('A1-A4 deposit buys units at the recorded price; trading moves the price, not the units; withdrawal redeems at the valuation', async () => {
  const w = await john1000();
  assert.ok(near(await w.units('john'), 1000) && near(await w.price(), 1), 'A1: 1,000 USDT at 1.00 = 1,000 units');
  await post(w, 1100);
  assert.ok(near(await w.price(), 1.1) && near(await w.units('john'), 1000), 'A2: pool +10% moves the price, not the units');
  await w.join('dino', 1100, 2200);                                           // Exchange now holds 1,100 (pool) + 1,100 (waiting)
  assert.ok(near(await w.units('dino'), 1000), 'A3: a deposit at 1.10 issues 1,100 / 1.10 = 1,000 units');
  assert.ok(near(await w.units('john'), 1000), "A3: nobody else's units changed");
  await w.unlockAll();
  const r = await wd(w, 'dino', 500, 2200);                                   // dino is at his benchmark: no fee
  assert.ok(near(r.pay_usdt, 550) && near(r.fee_units, 0), `A4: 500 units at 1.10 = 550.00, got ${r.pay_usdt}`);
  assert.ok(near(await w.units('dino'), 500));
});

test('A5-A7 a fee moves units from the investor to the manager, creates none, and does not touch equity or price', async () => {
  const w = await john1000();
  await post(w, 1100);
  const before = (await w.q(`select equity_usdt::float e, total_units::float u, unit_price::float p from public.pool_equity order by id desc limit 1`))[0];
  const r = await close(w, 1100);
  const after = (await w.q(`select equity_usdt::float e, total_units::float u, unit_price::float p from public.pool_equity order by id desc limit 1`))[0];
  assert.ok(near(r.fee_units, 9.09090909, 1e-8), `fee ${r.fee_units}`);
  assert.ok(near(await w.units('john'), 1000 - r.fee_units, 1e-8) && near(await w.units('raf'), r.fee_units, 1e-8), 'A5: investor loses exactly what the manager gains');
  assert.deepEqual([after.e, after.u, after.p], [before.e, before.u, before.p], 'A6: equity, total units and price are unchanged by the fee');
  const net = (await w.q(`select coalesce(sum(units),0)::float s from public.ledger where kind in ('fee_in','fee_out')`))[0].s;
  assert.equal(net, 0, 'A7: fee transfers net to zero');
  assert.ok(near(await w.tu(), after.u), "A7: everyone's units add up to the pool's units");
});

// ============================================================ B. the flat fee: 10% of each investor's net trading profit in the settlement period
// Hand-derived expectations. Profit = units held before each price move x the move; fee = 10% x max(0, profit); units = floor8(fee / settlement price).
test('B1 a positive period pays 10% of that profit, in units, at the settlement price', async () => {
  const w = await john1000(); await post(w, 1100);
  assert.ok(near(await w.periodProfit('john'), 100, 1e-9), 'profit so far = 1,000 units x 0.10');
  const r = await close(w, 1100);
  assert.ok(near(r.fee_units, 9.09090909, 1e-8), 'fee = 10 USDT / 1.10 = 9.09090909 units, got ' + r.fee_units);
  assert.ok(near(Number(r.fee_units) * 1.1, 10, 1e-6) && Number(r.fee_units) * 1.1 <= 10, 'worth at most 10 USDT');
  assert.ok(near(await w.units('john'), 990.90909091, 1e-8) && near(await w.units('raf'), 9.09090909, 1e-8), 'units moved from the investor to the manager');
});

test('B2 zero profit: no fee', async () => {
  const w = await john1000();
  assert.equal(Number((await close(w, 1000)).fee_units), 0);
  assert.ok(near(await w.units('john'), 1000));
});

test('B3 negative profit: no fee, and the loss is not carried into the next period', async () => {
  const w = await john1000();
  assert.equal(Number((await close(w, 800)).fee_units), 0);
  assert.ok(near(await w.periodProfit('john'), 0, 1e-12) && near(await w.credit('john'), 0), 'a new period starts at zero: nothing carried');
});

test('B4 a profitable period after a loss still pays 10%: no recovery of the earlier loss is required', async () => {
  const w = await john1000();
  await close(w, 800);                                                       // period 1: -20%, no fee
  const r = await close(w, 900);                                             // period 2: 0.80 -> 0.90 on 1,000 units = +100, though John is still 100 below his deposit
  assert.ok(near(Number(r.fee_units) * 0.9, 10, 1e-6), `fee 10% x 100 = 10 USDT (${Number(r.fee_units) * 0.9}), still below the original 1,000`);
  const r3 = await close(w, 600);                                            // period 3: a loss again
  assert.equal(Number(r3.fee_units), 0);
});

test('B5 deposits are not profit: a deposit at any price starts with zero profit', async () => {
  const w = await john1000(); await post(w, 1200);
  await w.join('dino', 600, 1800);                                           // dino buys 500 units at 1.20
  assert.ok(near(await w.units('dino'), 500) && near(await w.periodProfit('dino'), 0, 1e-12), 'the 600 USDT he put in is not profit');
  assert.ok(near(await w.periodProfit('john'), 200, 1e-9), "and John's earlier +200 is his alone");
  const r = await close(w, 1800);                                            // no price move since dino joined
  assert.ok(near(Number(r.fee_units) * 1.2, 20, 1e-6), 'only John pays: 10% of 200');
  assert.ok(near(await w.units('dino'), 500), 'dino pays nothing');
});

test('B6 withdrawals are not losses: selling units at an unchanged price creates no profit and no loss', async () => {
  const w = await john1000(); await w.unlockAll();
  const r = await wd(w, 'john', 400, 1000);
  assert.equal(Number(r.fee_units), 0);
  assert.ok(near(await w.periodProfit('john'), 0, 1e-12) && near(await w.credit('john'), 0, 1e-12), 'no profit, no loss');
  await post(w, 600 * 1.1);                                                  // +10% on the 600 units that stayed
  assert.ok(near(await w.periodProfit('john'), 60, 1e-9), 'only the units that stayed earn');
});

test('B7-B8 two investors: profit follows ownership through the period; an investor who joins mid-period is not charged for earlier profit', async () => {
  const w = await john1000(); await post(w, 1200);                           // John alone: 1,000 units x +0.20
  await w.join('dino', 500, 1700);                                           // dino joins at 1.20: 416.66666667 units
  await post(w, 1.32 * (await w.tu()));                                      // price 1.20 -> 1.32
  assert.ok(near(await w.periodProfit('john'), 1000 * 0.32, 1e-6), 'John: 1,000 units x (1.32 - 1.00) = 320');
  assert.ok(near(await w.periodProfit('dino'), 416.66666667 * 0.12, 1e-6), 'Dino: 416.67 units x (1.32 - 1.20) = 50, nothing from before he joined');
  const r = await close(w, 1.32 * (await w.tu()));
  assert.ok(near(await w.units('raf'), 32 / 1.32 + 5 / 1.32, 1e-6), 'fees 32 + 5 = 37 USDT in units');
  assert.ok(near(Number(r.fee_units), 37 / 1.32, 1e-6));
});

test('B9 the fee transfer does not change NAV or the unit price (units only move)', async () => {
  const w = await john1000(); await post(w, 1100);
  const b = (await w.q('select equity_usdt::float e, unit_price::float p, total_units::float u from public.pool_equity order by id desc limit 1'))[0];
  await close(w, 1100);
  const a = (await w.q('select equity_usdt::float e, unit_price::float p, total_units::float u from public.pool_equity order by id desc limit 1'))[0];
  assert.deepEqual([a.e, a.p, a.u], [b.e, b.p, b.u]);
});

test('B10 the same profit cannot be charged twice: repeat, retry and re-settle', async () => {
  const w = await john1000(); await post(w, 1100);
  const a = await close(w, 1100, 'settle-A');
  const retry = await close(w, 1100, 'settle-A');
  assert.equal(retry.replayed, true); assert.ok(near(retry.fee_units, a.fee_units));
  const again = await close(w, 1100, 'settle-B');                            // a new request, nothing earned since
  assert.equal(Number(again.fee_units), 0);
  assert.ok(near(await w.units('raf'), a.fee_units, 1e-8), 'the manager received the fee once');
});

test('B11 a partial withdrawal settles its share of the period profit; the rest settles at the quarter close; the total is 10% of the profit', async () => {
  const w = await john1000(); await post(w, 1200); await w.unlockAll();
  const r = await wd(w, 'john', 400, 1200);                                  // 40% of +200 = 80 profit -> 8 USDT
  assert.ok(near(Number(r.fee_units) * 1.2, 8, 1e-5), 'fee at withdrawal ' + Number(r.fee_units) * 1.2);
  assert.ok(near(r.pay_usdt, (400 - r.fee_units) * 1.2, 1e-5));
  const close1 = await close(w, 1.5 * (await w.tu()));                       // the 600 units that stayed: 120 so far + 600 x 0.30 = 300
  assert.ok(near(Number(close1.fee_units) * 1.5, 30, 1e-5), 'fee at the close ' + Number(close1.fee_units) * 1.5);
  // independent total: profit 1,000 x 0.20 + 600 x 0.30 = 380 -> 10% = 38 USDT = 8 at the withdrawal + 30 at the close
  assert.ok(near(Number(r.fee_units) * 1.2 + Number(close1.fee_units) * 1.5, 38, 1e-4), 'total fee 38 USDT');
});

test('B12 a full exit settles all of the period profit; a full exit in a loss forgives it (nothing is carried) ', async () => {
  const w = await john1000(); await post(w, 1100); await w.unlockAll();
  const r = await wd(w, 'john', 1000, 1100);
  assert.ok(near(Number(r.fee_units) * 1.1, 10, 1e-5), 'all of the +100 settled: 10 USDT');
  assert.ok(near(await w.units('john'), 0));
  const l = await build({ maxMove: 1000 }); await l.join('raf', 100, 100); await l.join('john', 1000, 1100); await post(l, 880); await l.unlockAll();
  assert.equal(Number((await wd(l, 'john', 1000, 880)).fee_units), 0);
  await l.join('john', 500, (await l.equity()) + 500);                       // comes back in the same period
  assert.ok(near(await l.periodProfit('john') - (await l.credit('john')), 0, 1e-9), 'the earlier loss does not follow him back');
});

test('B13 rounding never overcharges: fee value never exceeds rate x profit, for 3,000 awkward combinations', async () => {
  const w = await build();
  const rows = (await w.q(`select r, p, pr, public._fee_units(r, p, 1, 1, pr)::float as u from (
      select (0.05 + (g % 7) * 0.025) as r, (0.00001 + (g * 7919 % 100003) / 137.0) as p, (0.3 + (g * 104729 % 9973) / 777.0) as pr from generate_series(1, 3000) g) t`));
  let worst = 0;
  for (const x of rows) { const over = x.u * x.pr - x.r * x.p; if (over > worst) worst = over; assert.ok(x.u >= 0); }
  assert.ok(worst <= 1e-9, 'largest overcharge ' + worst + ' USDT');
  assert.equal((await w.q('select public._fee_units(0.1, -5, 1, 1, 1.1)::float u'))[0].u, 0, 'a loss never produces a fee');
  assert.equal((await w.q('select public._fee_units(0.1, 100, 1, 1, 1.1)::float u'))[0].u, 9.09090909, 'floor, not nearest');
});

test('B14 fee-rate changes are prospective: a higher rate waits for the next settlement, a lower rate applies now', async () => {
  const w = await john1000(); await post(w, 1100);
  await w.call('admin_set_profile', w.A, w.ids.john, null, null, 0.2);
  const p = (await w.q('select fee_rate::float r, fee_rate_next::float n from public.profiles where id = $1', [w.ids.john]))[0];
  assert.deepEqual([p.r, p.n], [0.1, 0.2], 'higher rate is only scheduled');
  const r = await close(w, 1100);
  assert.ok(near(Number(r.fee_units) * 1.1, 10, 1e-5), 'this settlement still uses the 10% rate');
  assert.equal((await w.q('select fee_rate::float r from public.profiles where id = $1', [w.ids.john]))[0].r, 0.2, 'the new rate starts after it');
  await w.call('admin_set_profile', w.A, w.ids.john, null, null, 0.05);
  assert.equal((await w.q('select fee_rate::float r from public.profiles where id = $1', [w.ids.john]))[0].r, 0.05, 'a lower rate applies at once');
});

test('B several movements between two valuations keep the books exact', async () => {
  const w = await john1000(); await w.unlockAll();
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 300, 58, 0, null); await w.call('admin_receive_deposit', w.A, w.ids.dino, 200, 58, 0, null);
  await post(w, 1700);
  await wd(w, 'john', 100, (await w.tu()) * 1.2);
  const vals = await Promise.all(['raf', 'john', 'dino'].map((k) => w.h(k)));
  assert.ok(near(vals.reduce((s, x) => s + Number(x.value_usdt), 0), await w.equity(), 1e-4), "everyone's values add up to the pool");
});

// ============================================================ D. corrections and idempotency
test('D23 ORIGINAL DEFECT (old schema): deleting the correction row re-adds a deposit — 500 USDT becomes 1,250 units', async () => {
  const w = await build({ integrity: false });
  await w.join('john', 1000, 1000);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, 0, null); await w.call('admin_post_equity', w.A, 1500);
  await w.call('admin_undo_last', w.A, 'correction: deleted');
  await w.call('admin_undo_last', w.A, 'correction: deleted');                // the app offers Delete on the correction row; the old code accepts it
  await w.call('admin_post_equity', w.A, 1500);
  assert.ok(near(await w.units('dino'), 1250, 1e-6), `the defect is present in the old code: dino holds ${await w.units('dino')} units from one 500 USDT deposit`);
  assert.ok(near(await w.lotUnits('dino'), 750, 1e-6), 'and the fee lines (750) no longer match the ledger (1,250)');
});

test('D24 FIXED: the same sequence is refused, nothing changes, and the history keeps both rows', async () => {
  const w = await build();
  await w.join('john', 1000, 1000);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, 0, null); await post(w, 1500);
  const first = await w.call('admin_undo_last', w.A, 'correction: deleted');
  assert.equal(first.back_to_pending, true);
  const snap = async () => JSON.stringify([await w.units('dino'), await w.tu(), await w.pend(), (await w.q(`select count(*)::int n from public.pool_equity`))[0].n, (await w.q(`select count(*)::int n from public.ledger`))[0].n]);
  const before = await snap();
  const e = await err(() => w.call('admin_undo_last', w.A, 'correction: deleted'));
  assert.match(e, /itself a correction/);
  assert.equal(await snap(), before, 'balances and rows unchanged by the refused reversal');
  await post(w, 1500);                                                        // the waiting 500 is still pending: the next reading joins it ONCE
  assert.ok(near(await w.units('dino'), 500) && near(await w.tu(), 1500), 'the deposit joins exactly once: 500 units');
  assert.equal((await w.q(`select count(*)::int n from public.corrections`))[0].n, 1);
  // DB-enforced: the same entry cannot be reversed twice even by a direct insert
  const dup = await err(() => w.db.exec(`insert into public.pool_equity(kind, equity_usdt, total_units, unit_price, reversed_of)
      select 'update', equity_usdt, total_units, unit_price, reversed_of from public.pool_equity where reversed_of is not null limit 1`));
  assert.match(dup, /duplicate key|unique/i);
});

test('D edit flow still works: undo a deposit, hand the money back, enter it again', async () => {
  const w = await build();
  await w.join('john', 1000, 1000);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 400, 58, 0, null); await post(w, 1400);
  assert.ok(near(await w.units('dino'), 400));
  await w.call('admin_undo_last', w.A, 'correction: edit');
  assert.ok(near(await w.units('dino'), 0) && near(await w.periodProfit('dino'), 0, 1e-12), 'units and profit are gone');
  const pid = (await w.q(`select id from public.pending_deposits where status = 'pending'`))[0].id;
  await w.call('admin_cancel_pending', w.A, pid);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 450, 58, 0, null); await post(w, 1450);
  assert.ok(near(await w.units('dino'), 450) && near(await w.periodProfit('dino'), 0, 1e-12));
});

test('D undoing a withdrawal restores units, request and period credit; a quarter close and a correction cannot be undone', async () => {
  const w = await john1000(); await post(w, 1100); await w.unlockAll();
  const tok = await w.tok('john'); await w.call('request_withdrawal', tok, 300, 'some');
  const req = (await w.call('admin_requests', w.A)).find((x) => x.status === 'pending');
  const creditBefore = await w.credit('john'), unitsBefore = await w.units('john');
  await wd(w, 'john', 300, 1100, { req: Number(req.id) });
  await w.call('admin_undo_last', w.A, 'correction');
  assert.ok(near(await w.units('john'), unitsBefore) && near(await w.credit('john'), creditBefore, 1e-9) && near(await w.periodProfit('john'), 100, 1e-9), 'units, credit and profit are back');
  assert.equal((await w.call('admin_requests', w.A)).find((x) => x.id === req.id).status, 'pending', 'the request is waiting again');
  assert.match(await err(() => w.call('admin_undo_last', w.A, 'x')), /itself a correction/);
  const w2 = await john1000(); await close(w2, 1100);
  assert.match(await err(() => w2.call('admin_undo_last', w2.A, 'x')), /final/);
});

test('D25 a retried deposit event (same request id) is recorded once', async () => {
  const w = await john1000();
  const a = await w.call('admin_receive_deposit', w.A, w.ids.dino, 300, 58, 0, null, null, 'req-1');
  const b = await w.call('admin_receive_deposit', w.A, w.ids.dino, 300, 58, 0, null, null, 'req-1');
  assert.equal(b.replayed, true); assert.equal(a.id, b.id);
  assert.equal((await w.q(`select count(*)::int n from public.pending_deposits where profile_id = $1`, [w.ids.dino]))[0].n, 1);
  await post(w, 1300, 'req-2'); await post(w, 1300, 'req-2');
  assert.ok(near(await w.units('dino'), 300), 'a retried valuation does not issue units twice');
  assert.match(await err(() => w.call('admin_receive_deposit', w.A, w.ids.dino, 300, 58, 0, null, null, 'req-2')), /already used for another operation/);
});

test('D26 a retried fee settlement does not transfer extra units', async () => {
  const w = await john1000(); await post(w, 1100);
  const a = await close(w, 1100, 'settle-1'), b = await close(w, 1100, 'settle-1');
  assert.equal(b.replayed, true); assert.ok(near(a.fee_units, b.fee_units));
  assert.ok(near(await w.units('raf'), a.fee_units, 1e-8), 'the manager received the fee once');
  const c = await close(w, 1100, 'settle-2');                                 // a new request id, nothing new to charge
  assert.equal(Number(c.fee_units), 0);
});

test('D27 a retried withdrawal does not redeem twice', async () => {
  const w = await john1000(); await w.unlockAll();
  const a = await wd(w, 'john', 300, 1000, { idem: 'wd-1' }), b = await wd(w, 'john', 300, 1000, { idem: 'wd-1' });
  assert.equal(b.replayed, true); assert.ok(near(await w.units('john'), 700));
  const tok = await w.tok('john'); await w.call('request_withdrawal', tok, 100, null);
  const req = (await w.call('admin_requests', w.A)).find((x) => x.status === 'pending');
  await wd(w, 'john', 100, 700, { req: Number(req.id) });
  assert.match(await err(() => wd(w, 'john', 100, 600, { req: Number(req.id) })), /not waiting any more/, 'a paid request cannot be paid again');
  assert.ok(a.pay_usdt > 0);
});

// ============================================================ E. exchange reconciliation and settlement safeguards
test('E28-E30 a transfer into the exchange is not profit; transfers are matched, deduplicated, and unmatched ones block automatic readings', async () => {
  const w = await john1000();
  await w.db.exec(`update public.ledger_settings set value = 'on' where key = 'settlement_gate'`);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, 0, null);   // received, but the money has not reached the exchange yet
  const p0 = await post(w, 1000);                                             // Exchange still shows 1,000
  assert.ok(near(p0.unit_price, 1), 'E28: unarrived money is not subtracted, so the price is not diluted');
  assert.equal(await w.units('dino'), 0, 'and it does not join before it has arrived');
  const tr = { id: 'T-100', ts: new Date().toISOString(), dir: 'in', usdt: 500 };
  const s1 = await w.botSnap(1500, 0, 0, { transfers: [tr] });
  assert.equal(s1.unmatched_transfers, 0); assert.equal(s1.new_transfers, 1);
  const s2 = await w.botSnap(1500, 0, 0, { transfers: [tr] });
  assert.equal(s2.duplicate_transfers, 1, 'E30: the same exchange event is not recorded twice');
  assert.equal((await w.q(`select count(*)::int n from public.exchange_transfers`))[0].n, 1);
  const p1 = await post(w, 1500);
  assert.ok(near(p1.unit_price, 1) && near(await w.units('dino'), 500), 'the arrived deposit joins at 1.00, the 500 was not profit');
  // E29: an outbound transfer that no recorded withdrawal explains
  await w.botSnap(1500, 0, 0, { transfers: [tr, { id: 'T-200', ts: new Date().toISOString(), dir: 'out', usdt: 300 }] });
  assert.equal((await w.q(`select count(*)::int n from public.exchange_transfers t where not exists (select 1 from public.transfer_matches m where m.transfer_id = t.id)`))[0].n, 1);
  const bot = await w.call('bot_post_equity', BOT_KEY, 1200);
  assert.match(bot.skipped, /not matched/, 'E29: the bot does not turn the missing 300 into a trading loss');
  assert.match(await err(() => post(w, 1200, null, false)), /CONFIRM: 1 Exchange transfer/, 'neither does a typed reading without an explicit yes');
  await w.call('admin_classify_transfer', w.A, 'T-200', 'withdrawal_recorded', 'paid out to John, entry 12');
  await w.db.exec(`update public.ledger_settings set value = '0' where key = 'bot_min_minutes'`);
  const after = await w.call('bot_post_equity', BOT_KEY, 1200);
  assert.equal(after.skipped, 'jump', 'classified, but the bot still will not book a 20% drop itself; the manager records the withdrawal by hand');
  assert.ok(near(await w.price(), 1), 'and the price never moved: the 300 was not booked as a trading loss');
  assert.match(await err(() => w.call('admin_classify_transfer', w.A, 'T-200', 'other', 'short')), /at least 10/);
});

test('E29b an outbound transfer is auto-matched to a recorded withdrawal of the same amount', async () => {
  const w = await john1000(); await w.unlockAll();
  await wd(w, 'john', 300, 1000);                                             // pays 300 USDT
  const s = await w.botSnap(700, 0, 0, { transfers: [{ id: 'OUT-1', ts: new Date().toISOString(), dir: 'out', usdt: 300 }] });
  assert.equal(s.unmatched_transfers, 0);
  assert.equal((await w.q(`select kind from public.transfer_matches`))[0].kind, 'auto_withdrawal');
});

test('E31-E33 fee settlement is blocked by a stale snapshot, open trades, or an unexplained difference; a written attestation unblocks only the last', async () => {
  const w = await john1000();
  await w.db.exec(`update public.ledger_settings set value = 'on' where key = 'settlement_gate'`);
  await post(w, 1100);
  assert.match(await err(() => close(w, 1100)), /no Exchange snapshot yet/);
  await w.botSnap(1100, 0, 0, { realized: 0 });                               // baseline (first snapshot)
  assert.match(await err(() => close(w, 1100)), /not clean \(first snapshot/, 'a baseline needs a written attestation');
  const snaps = await w.q(`select id from public.exchange_snapshots order by id desc limit 1`);
  await w.call('admin_attest_snapshot', w.A, snaps[0].id, 'baseline checked against the exchange app by hand');
  // E32: an exchange failure is a refused call, never a zero balance
  assert.match(await err(() => w.call('bot_post_snapshot', BOT_KEY, null, 0, 0, 0, 0, '[]', true)), /incomplete snapshot/);
  assert.match(await err(() => w.call('bot_post_equity', BOT_KEY, 0)), /more than 0/);
  assert.match(await err(() => post(w, 0)), /must be > 0|must be/);
  // open trades
  await w.botSnap(1100, 1, 0, { realized: 0 });
  assert.match(await err(() => close(w, 1100)), /still open on the exchange/);
  // E33: balance moves with no realised PnL to explain it
  const s = await w.botSnap(1100 + 40, 0, 0, { realized: 0 });
  assert.equal(s.recon_status, 'blocked'); assert.match(s.recon_detail, /differs from the expected/);
  assert.match(await err(() => close(w, 1140)), /not clean/);
  await w.call('admin_attest_snapshot', w.A, s.snapshot_id, 'extra 40 USDT is an exchange rebate, checked in the exchange statement');
  const ok = await close(w, 1140);
  assert.ok(Number(ok.fee_units) > 0, 'settles after the attestation');
  // stale
  await w.botSnap(1140, 0, 0, { realized: 0 });
  await w.db.exec(`alter table public.exchange_snapshots disable trigger exchange_snapshots_append_only; update public.exchange_snapshots set ts = now() - interval '13 hours'; alter table public.exchange_snapshots enable trigger exchange_snapshots_append_only;`);
  await w.db.exec(`update public.pool_equity set ts = ts where false`);
  assert.match(await err(() => close(w, 1140)), /stale|80 days|last quarter close/);
});

test('E a clean reconciliation passes by itself (balance follows from the last snapshot, realised PnL and transfers)', async () => {
  const w = await john1000();
  await w.db.exec(`update public.ledger_settings set value = 'on' where key = 'settlement_gate'`);
  await w.botSnap(1000, 0, 0);
  const s = await w.botSnap(1060, 0, 0, { realized: 60 });
  assert.equal(s.recon_status, 'ok');
  await post(w, 1060);
  const r = await close(w, 1060);
  assert.ok(near(r.fee_units * (1060 / 1000), 6, 1e-4), '10% of the 60 realised gain');
  const x = await w.botSnap(1060, 0, 0, { realized: 0, complete: false });
  assert.equal(x.recon_status, 'blocked'); assert.match(x.recon_detail, /not verified/);
});

test('M2 a typed valuation more than 25% from the last entry needs an explicit yes, which is written into the entry', async () => {
  const w = await john1000();
  const e = await err(() => post(w, 5000, null, false));
  assert.match(e, /CONFIRM: this is a 400\.0% move/);
  assert.equal(await w.price(), 1, 'nothing saved');
  await post(w, 5000, null, true);
  assert.match((await w.q(`select note from public.pool_equity order by id desc limit 1`))[0].note, /confirmed 400\.0% move/);
});

test('L1 a request for everything is paid as everything that is left, even after a settlement took fee units', async () => {
  const w = await john1000(); await w.unlockAll();
  const tok = await w.tok('john'); await w.call('request_withdrawal', tok, 1000, 'all');
  await close(w, 1100);
  const req = (await w.call('admin_requests', w.A)).find((x) => x.status === 'pending');
  const r = await wd(w, 'john', Number(req.units), 1100, { req: Number(req.id) });
  assert.ok(near(await w.units('john'), 0, 1e-8) && r.pay_usdt > 0);
});

test('L2 a fee on a locked deposit does not reduce what is unlocked', async () => {
  const w = await john1000(); await w.unlockAll();
  await w.join('john', 1000, 2000);
  await close(w, 2200);
  const s = await w.h('john');
  assert.ok(near(s.unlocked_units, 990.90909091, 1e-5), `got ${s.unlocked_units}`);
});

// ============================================================ F. locking (static)
test('F every function that moves money or units takes the ledger lock first', async () => {
  const fns = ['admin_post_equity', 'admin_close_quarter', 'admin_withdraw', 'admin_deposit', 'admin_receive_deposit', 'admin_cancel_pending', 'admin_undo_last',
    'request_withdrawal', 'cancel_withdrawal_request', 'bot_post_equity', 'bot_post_snapshot', 'admin_mark_arrived', 'admin_attest_snapshot', 'admin_classify_transfer'];
  const w = await build();
  for (const f of fns) {
    const src = (await w.q(`select prosrc from pg_proc where proname = $1`, [f]))[0].prosrc;
    assert.match(src, /_ledger_lock\(\)/, `${f} must take the ledger lock`);
    const lockAt = src.indexOf('_ledger_lock()');
    const firstWrite = src.search(/\binsert into\b|\bupdate\b\s+\w|\bdelete from\b/);
    assert.ok(firstWrite === -1 || lockAt < firstWrite, `${f} takes the lock before its first write`);
  }
  for (const f of ['_period_take', '_period_close', '_period_profit', '_period_revert', '_fee_units', '_check_books']) {
    const acl = (await w.q('select has_function_privilege(\'anon\', p.oid, \'execute\') x from pg_proc p where proname = $1', [f]))[0].x;
    assert.equal(acl, false, f + ' is not callable from the website');
  }
});

// ============================================================ H. old data and the migration
test('H1 migrating a live-like ledger keeps every unit and every balance; accrued fees for one-deposit investors are identical', async () => {
  const w = await build({ integrity: false });
  await w.join('john', 1000, 1000); await w.call('admin_post_equity', w.A, 1100);
  await w.join('dino', 550, 1650);                                            // dino joins at 1.10
  await w.call('admin_post_equity', w.A, 1815);
  const before = {}; for (const k of ['raf', 'john', 'dino']) before[k] = await w.h(k);
  const eqRows = (await w.q(`select count(*)::int n from public.pool_equity`))[0].n, ledgerRows = (await w.q(`select count(*)::int n from public.ledger`))[0].n;
  await w.migrateIntegrity();
  for (const k of ['raf', 'john', 'dino']) {
    const a = await w.h(k);
    assert.ok(near(a.units, before[k].units, 1e-9) && near(a.value_usdt, before[k].value_usdt, 1e-6), `${k} units and value unchanged`);
    assert.ok(near(a.accrued_fee_usdt, before[k].accrued_fee_usdt, 1e-6), `${k} accrued fee unchanged for a single-deposit investor (${a.accrued_fee_usdt} vs ${before[k].accrued_fee_usdt})`);
  }
  assert.equal((await w.q(`select count(*)::int n from public.pool_equity`))[0].n, eqRows, 'no entry added, edited or removed');
  assert.equal((await w.q(`select count(*)::int n from public.ledger`))[0].n, ledgerRows);
  assert.equal((await w.q(`select count(*)::int n from public.holder_lots`))[0].n > 0, true, 'the old per-deposit lines are kept as history');
});

test('H2 the migration refuses to run on books that are already inconsistent (units vs per-deposit lines)', async () => {
  const w = await build({ integrity: false });
  await w.join('john', 1000, 1000);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, 0, null); await w.call('admin_post_equity', w.A, 1500);
  await w.call('admin_undo_last', w.A, 'x'); await w.call('admin_undo_last', w.A, 'x');         // the original defect, in the old schema
  const e = await err(() => w.migrateIntegrity());
  assert.match(e, /preflight: ledger units and per-deposit lines disagree/);
});

test('H3 cutover: profit already in the current period is charged at the next close; an investor who withdrew this period is not charged twice', async () => {
  const w = await build({ integrity: false, maxMove: 1000 });
  await w.join('john', 1000, 1000); await w.join('dino', 1000, 2000);
  await w.call('admin_post_equity', w.A, 2400);                            // +20% on both: 200 each, not yet settled
  await w.unlockAll();
  await w.call('admin_withdraw', w.A, w.ids.dino, 500, 2400);              // OLD rule: fee taken on the withdrawn half
  await w.migrateIntegrity();
  assert.ok(near(await w.periodProfit('john') - (await w.credit('john')), 200, 1e-9), "John (no withdrawal) carries his +200 into the new engine");
  assert.ok(near(await w.periodProfit('dino') - (await w.credit('dino')), 0, 1e-9), 'Dino had his withdrawn share charged by the old rule, so what he earned so far is forgiven once');
  const r = await w.call('admin_close_quarter', w.A, await w.equity(), null, null, null, null, true);
  assert.ok(Number(r.investors_charged) === 1, 'only John is charged at the first close');
});

test('H3b draft tables without the draft marker: the migration stops and changes nothing', async () => {
  const w = await build({ integrity: false });
  await w.db.exec('create table public.investor_perf(profile_id uuid primary key, hwm_value numeric)');
  assert.match(await err(() => w.migrateIntegrity()), /state is unclear/);
  assert.equal((await w.q("select to_regclass('public.investor_period') t"))[0].t, null, 'nothing was created');
});

// The exact situation of the first real database: the EARLIER DRAFT (investor-level high-water mark) was applied and used, then the flat
// fee version is run on top. The draft is kept as a fixture; it must never be applied anywhere again.
test('H6 upgrade from the earlier draft: nothing lost, draft history archived, next settlement uses the flat rule', async () => {
  const { readFileSync } = await import('node:fs');
  const draft = readFileSync(new URL('./fixtures/ledger_integrity_hwm_draft.sql', import.meta.url), 'utf8');
  const w = await build({ integrity: false });
  await w.db.exec(draft);                                                       // as on the real database
  await w.db.exec("insert into public.ledger_settings(key,value) values ('bot_key_hash', 'x') on conflict (key) do nothing");
  const C = true;
  await w.call('admin_receive_deposit', w.A, w.ids.john, 1000, 58, 0, null); await w.call('admin_post_equity', w.A, 1000);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, 0, null); await w.call('admin_post_equity', w.A, 1500);
  await w.call('admin_post_equity', w.A, 1800, null, null, null, null, C);       // +20%
  await w.call('admin_close_quarter', w.A, 1800, null, null, null, null, C);      // a settlement under the DRAFT rule (fees already taken)
  await w.call('admin_post_equity', w.A, 2000, null, null, null, null, C);       // the current period starts here
  await w.unlockAll();
  await w.call('admin_withdraw', w.A, w.ids.dino, 100, 2000, null, null, false, null, null, null, C);   // dino withdraws inside the current period (draft rule)
  const price = await w.price();
  const before = { units: { john: await w.units('john'), dino: await w.units('dino'), raf: await w.units('raf') }, price, equity: await w.equity(),
    rows: (await w.q('select (select count(*) from public.ledger) l, (select count(*) from public.pool_equity) e'))[0] };
  assert.equal((await w.q("select value from public.ledger_settings where key='fee_engine'"))[0].value, 'investor_hwm_v1', 'it really is the draft');
  assert.ok(Number((await w.q('select count(*) n from public.investor_perf'))[0].n) >= 2 && Number((await w.q('select count(*) n from public.perf_log'))[0].n) >= 1);

  await w.migrateIntegrity();                                                    // the upgrade

  assert.equal((await w.q("select value from public.ledger_settings where key='fee_engine'"))[0].value, 'flat_period_v1');
  const names = (await w.q("select relname from pg_class where relname in ('investor_perf','perf_log','investor_perf_draft_archive','perf_log_draft_archive','investor_period','period_log') and relkind='r'")).map((r) => r.relname).sort();
  assert.deepEqual(names, ['investor_perf_draft_archive', 'investor_period', 'perf_log_draft_archive', 'period_log'], 'draft tables renamed, new tables created');
  assert.ok(Number((await w.q('select count(*) n from public.investor_perf_draft_archive'))[0].n) >= 2, 'the draft benchmarks are kept as history');
  assert.equal(Number((await w.q("select count(*) n from pg_proc where proname in ('_perf_take','_perf_close','_perf_deposit','_perf_revert','_perf_log')"))[0].n), 0, 'unused draft functions dropped');
  const after = { units: { john: await w.units('john'), dino: await w.units('dino'), raf: await w.units('raf') }, price: await w.price(), equity: await w.equity(),
    rows: (await w.q('select (select count(*) from public.ledger) l, (select count(*) from public.pool_equity) e'))[0] };
  assert.deepEqual(after, before, 'every unit, the price, the equity and every row are exactly as they were');

  // current period: the close was at price 1.20 (1,800 on 1,500 units); the pool is now 2,000 on 1,500 units = 1.3333. Dino withdrew in this period,
  // so what he earned so far is forgiven once.
  const jUnits = before.units.john, gain = price - 1.2;
  assert.ok(near(price, 2000 / 1500, 1e-9));
  assert.ok(near(await w.periodProfit('john') - (await w.credit('john')), jUnits * gain, 1e-6), "john's profit since the close, counted in full");
  assert.ok(near(await w.periodProfit('dino') - (await w.credit('dino')), 0, 1e-9), 'dino: already charged on the withdrawn share by the draft rule, so forgiven, not charged twice');
  const r = await w.call('admin_close_quarter', w.A, await w.equity() * 1.0, null, null, null, null, C);
  assert.ok(near(Number(r.fee_units) * price, 0.1 * jUnits * gain, 1e-5), "the first close under the flat rule: 10% of john's gain; got " + Number(r.fee_units) * price);
  assert.equal(Number(r.investors_charged), 1);
  const rep = await w.call('admin_integrity_report', w.A);
  // (two settlements on one test day are expected here: the spacing rule is switched off in tests)
  assert.deepEqual(rep.checks.filter((c) => c.count > 0 && c.id !== 'several_settlements_on_one_day').map((c) => c.id), [], 'the integrity report is clean after the upgrade');
  // running the file again after activity is refused (the per-deposit lines are history), and changes nothing
  assert.match(await err(() => w.migrateIntegrity()), /per-deposit lines/);
});

test('H2b the pre-migration read-only diagnostic finds the Delete-twice damage on the OLD schema, and changes nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../supabase/diagnostics/pre-migration-integrity.sql', import.meta.url), 'utf8');
  const clean = await build({ integrity: false }); await clean.join('john', 1000, 1000);
  const ok = (await clean.db.query(sql)).rows;
  assert.equal(ok.reduce((s, r) => s + Number(r.count), 0), 0, 'a healthy old ledger is clean: ' + JSON.stringify(ok.filter((r) => Number(r.count))));
  const w = await build({ integrity: false });
  await w.join('john', 1000, 1000);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, 0, null); await w.call('admin_post_equity', w.A, 1500);
  await w.call('admin_undo_last', w.A, 'x'); await w.call('admin_undo_last', w.A, 'x');
  const rowsBefore = (await w.q(`select (select count(*) from public.ledger) + (select count(*) from public.pool_equity) n`))[0].n;
  const rep = Object.fromEntries((await w.db.query(sql)).rows.map((r) => [r.check_id, Number(r.count)]));
  assert.equal(rep['correction_that_was_itself_reversed (Delete pressed twice)'], 1);
  assert.equal(rep['ledger_units_vs_per_deposit_lines'], 1);
  assert.equal(rep['deposit_waiting_but_also_joined'], 1);
  assert.equal((await w.q(`select (select count(*) from public.ledger) + (select count(*) from public.pool_equity) n`))[0].n, rowsBefore, 'read-only');
});

test('H4 the report catches planted damage', async () => {
  const w = await john1000(); await close(w, 1100);
  await w.db.exec(`alter table public.ledger disable trigger ledger_append_only; update public.ledger set units = units + 5 where kind = 'fee_in'; alter table public.ledger enable trigger ledger_append_only;`);
  const rep = await w.call('admin_integrity_report', w.A);
  assert.ok(rep.checks.find((c) => c.id === 'fee_transfer_not_netting_to_zero').count >= 1);
  assert.ok(rep.checks.find((c) => c.id === 'total_units_vs_last_entry').count === 1);
  assert.equal(rep.worst, 3);
  const e = await err(() => post(w, 1100));
  assert.match(e, /books check failed/, 'and every write now refuses to build on the damage');
});

test('H5 a healthy ledger reports clean', async () => {
  const w = await john1000(); await post(w, 1100); await close(w, 1100);
  const rep = await w.call('admin_integrity_report', w.A);
  assert.equal(rep.checks.reduce((s, c) => s + c.count, 0), 0, JSON.stringify(rep.checks.filter((c) => c.count)));
  const bk = await w.call('admin_export_all', w.A);
  assert.equal(bk.checks.fee_engine, 'flat_period_v1'); assert.ok(Array.isArray(bk.investor_period) && Array.isArray(bk.period_log) && Array.isArray(bk.corrections));
});

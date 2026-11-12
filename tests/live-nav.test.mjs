// 20261213000000_live_nav.sql: the unit price follows the verified wallet reports (one NAV row per complete set), and the four manual steps (add investor, cash in,
// withdraw, transfer) price at that true value. The pool starts with raf (manager) 1000 units at 1.00; john and dino are investors at 20%. Each wallet report splits
// cash + open P&L 50/25/25 over the three bot wallets; the book is 1000, so a report with cash 1000 reconciles.
//   LN1 verified readings: one row per set, live price on every screen     LN2 a closed trade moves P&L from open to the book: never counted twice
//   LN3 add investor + cash-in, less arrived: top-up from the manager      LN4 cash-in, more arrived: the rest is the manager's own; recorded late
//   LN5 transfer: pool unchanged, the fee once (no skip, no double)        LN6 withdraw: liquidity check, nothing saved when it does not fit; paid at true value
//   LN7 duplicates are replays or refusals                                 LN8 a wallet stops reporting: blocked, no price published, money waits
//   LN9 curves: flows never look like profit; sums reconcile with MEXC      LN10 production chain (no admission spread) + wallet_nav_mode require
//   LN11 backfill from kept reports                                         LN12 rollback
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ready, adv, near } from './_tvworld.mjs';
const Returns = createRequire(import.meta.url)('../js/returns.js');
const RB = readFileSync(new URL('../supabase/rollback/20261213000000_rollback_live_nav.sql', import.meta.url), 'utf8');

const navs = (w) => w.q(`select id, source, status, unit_price::float p, reasons, units::float u from public.nav_snapshots order by ts, id`);
const lastNav = async (w) => (await w.q(`select status, unit_price::float p, reasons, source from public.nav_snapshots order by ts desc, id desc limit 1`))[0];
const price = async (w) => Number((await w.q(`select public._price_now() p`))[0].p);
const cycle = async (w, cash, open, o) => { await w.report(cash, open, o); await adv(w, 5); };
const one = (w, x, eq, unr) => w.call('bot_post_wallet_snapshot', w.keys[x], x, ++w.seq[x], new Date(w.now).toISOString(), eq, unr, eq - unr, eq - unr, unr ? 1 : 0, 0);
const value = async (w, who) => (await w.call('admin_overview', w.A)).find((h) => h.id === w.ids[who]);
const payTo = (w, who) => w.call('admin_set_payout', w.A, w.ids[who], 'gcash', who, '09171234567', null, null);

test('LN1 a complete set of verified reports writes ONE NAV row; the unit price and every holder\'s value follow it (open P&L included); a repeat report adds nothing', async () => {
  const w = await ready();
  await cycle(w, 1000, 0);
  let v = (await navs(w)).filter((n) => n.status === 'verified');
  assert.equal(v.length, 1); near(v[0].p, 1, 1e-12); assert.equal(v[0].source, 'wallet_report');
  await cycle(w, 1000, 50);                                      // an open winner: +50 in the wallets, nothing in the book
  near(await price(w), 1.05, 1e-12, 'the price follows MEXC, open P&L included');
  near((await value(w, 'raf')).value_usdt, 1050, 1e-9, 'the manager\'s value moves without anyone valuing the pool');
  const ps = await w.call('pool_summary', w.A);
  near(ps.unit_price, 1.05, 1e-12); near(ps.book_price, 1, 1e-12, 'the book still holds realized results only'); assert.equal(ps.live, true);
  const n0 = (await navs(w)).length;
  await one(w, 'bbcore', 525, 25);                               // one wallet again in the same cycle: not a new complete set
  assert.equal((await navs(w)).length, n0, 'three reports a cycle make one row, not three');
  const mine = await w.call('my_nav', w.A); assert.equal(mine.live, true); near(mine.unit_price, 1.05, 1e-12);
});

test('LN2 a trade closes: its realized result goes into the book, the open P&L leaves the wallets\' unrealized; the price does not move twice', async () => {
  const w = await ready();
  await cycle(w, 1000, 50);
  near(await price(w), 1.05, 1e-12);
  await w.trade({ pos: 'p1', pnl: 50 });                         // booked by the trades mode: book 1000 -> 1050
  near((await w.pool()).e, 1050, 1e-9, 'the realized result is in the book');
  await cycle(w, 1050, 0);                                       // the same money, now as cash
  near(await price(w), 1.05, 1e-12, 'no double count: 1.05, not 1.10');
  assert.equal((await lastNav(w)).status, 'verified');
});

test('LN3 ADD INVESTOR with ₱5,800 at ₱58 (= 100 USDT) but 95 USDT arrived: confirmed before the wallets show it, so it waits; it joins by itself at the next report; the 5 USDT gap comes from the manager\'s units', async () => {
  const w = await ready();
  await cycle(w, 1000, 50);                                      // price 1.05
  const r = await w.call('admin_add_investor', w.A, 'maria', 'Maria', 'maria-password-1', 0.2, 5800, 95, 58, true, 'add-1');
  const maria = r.profile_id; w.ids.maria = maria;
  assert.equal(r.cash_in.status, 'waiting'); assert.match(r.cash_in.waiting_reason, /differ/);
  near(r.cash_in.credited_usdt, 100, 1e-9); near(r.cash_in.topup_usdt, 5, 1e-9); near(r.cash_in.surplus_usdt, 0, 1e-12);
  await cycle(w, 1000, 50);                                      // the money is not in the reports yet
  const b = await lastNav(w);
  assert.equal(b.status, 'blocked'); assert.equal(b.p, null, 'an unverified NAV is never published');
  assert.ok(b.reasons.some((x) => x.code === 'deposit_not_visible'), 'the reason says what is missing');
  near(await price(w), 1.05, 1e-12, 'the screens keep the last verified price');
  const raf0 = await w.units('raf');
  await cycle(w, 1095, 50);                                      // now the wallets hold it
  const ci = (await w.q(`select status, admitted_how, units::float u, unit_price::float p from public.cash_ins`))[0];
  assert.equal(ci.status, 'admitted'); assert.equal(ci.admitted_how, 'automatic'); near(ci.p, 1.05, 1e-12);
  near(await w.units('maria'), 100 / 1.05, 1e-7, 'credited pesos ÷ rate, at the price of the reading');
  near(await w.units('raf'), raf0 - 5 / 1.05, 1e-7, 'the top-up came from the manager\'s units only');
  near((await w.q(`select hwm_value::float h from public.investor_hwm where profile_id=$1`, [maria]))[0].h, 100, 1e-6, 'her mark is what she was credited: no fee on her own money');
  near(await price(w), 1.05, 1e-9, 'joining never moves the price');
  near((await value(w, 'raf')).value_usdt, 1050 - 5, 1e-6, 'the manager paid the 5 USDT gap, nobody else');
  assert.equal((await w.q(`select count(*)::int n from public.audit_log where action in ('cash_in_recorded', 'cash_in_admitted', 'investor_added')`))[0].n, 3);
});

test('LN4 CASH IN where more arrived than the pesos are credited at (₱5,800 at ₱58 = 100; 103 arrived): 3 USDT is the manager\'s own deposit; recorded after the money showed up, it joins at once', async () => {
  const w = await ready();
  await cycle(w, 1000, 0);
  await cycle(w, 1103, 0);                                       // money in MEXC that nobody recorded: blocked, it would look like profit
  assert.equal((await lastNav(w)).status, 'blocked');
  const r = await w.call('admin_cash_in', w.A, w.ids.john, 5800, 103, 58, true, null, 'ci-1');
  assert.equal(r.status, 'admitted', JSON.stringify(r)); near(r.surplus_usdt, 3, 1e-9);
  near(await w.units('john'), 100, 1e-7); near(await w.units('raf'), 1003, 1e-7);
  const led = await w.q(`select profile_id, usdt::float u, php_amount::float php from public.ledger where kind='deposit' and equity_id > 1 order by id`);
  assert.equal(led.find((l) => l.profile_id === w.ids.john).php, 5800, 'the investor\'s row carries the pesos');
  assert.equal(led.find((l) => l.profile_id === w.ids.raf).php, null, 'the manager\'s surplus row carries none');
  await cycle(w, 1103, 0);
  near(await price(w), 1, 1e-12); assert.equal((await lastNav(w)).status, 'verified');
});

test('LN5 TRANSFER: units move at the true price, the pool\'s value and units do not; the sender pays the fee on that share\'s gain, the recipient starts at what they got', async () => {
  const w = await ready();
  await cycle(w, 1000, 0);
  await w.call('admin_cash_in', w.A, w.ids.john, null, 100, null, false, null, null);
  await w.call('admin_cash_in_received', w.A, (await w.q(`select max(id) i from public.cash_ins`))[0].i, null);
  await cycle(w, 1100, 0);
  near(await w.units('john'), 100, 1e-7);
  await cycle(w, 1100, 110);                                     // +10%: price 1.10, john 110 against his mark 100
  const before = await w.pool(); const fee0 = (await value(w, 'john')).accrued_fee_usdt; near(fee0, 2, 1e-6);
  const q = await w.call('admin_quote_transfer', w.A, w.ids.john, w.ids.dino, null, 55, null, false);
  assert.equal(q.quote, true); near(q.fee_usdt, 1, 1e-6, '20% of half the gain');
  const r = await w.call('admin_transfer', w.A, w.ids.john, w.ids.dino, null, 55, null, false, 'gift', 'tr-1');
  near(r.unit_price, 1.1, 1e-12); near(r.usdt, 54, 1e-5);
  const after = await w.pool();
  near(after.e, before.e, 1e-9); near(after.u, before.u, 1e-9, 'total units unchanged'); near(after.p, before.p, 1e-12);
  near((await value(w, 'dino')).accrued_fee_usdt, 0, 1e-9, 'the recipient owes nothing on gain made before he got the units');
  near((await value(w, 'john')).accrued_fee_usdt, 1, 1e-6, 'the sender still owes the other half: 2 in total, as with no transfer');
  const t2 = await w.call('admin_transfer', w.A, w.ids.raf, w.ids.dino, 1160, null, 58, false, null, null);   // ₱1,160 at ₱58 = 20 USDT, the manager pays no fee
  near(t2.fee_usdt, 0, 1e-12); near(t2.usdt, 20, 1e-6); near(t2.php_amount, 1160, 1e-9);
  near(await price(w), 1.1, 1e-12);
  await assert.rejects(w.call('admin_transfer', w.A, w.ids.dino, w.ids.dino, null, 1, null, false, null, null), /same person/);
  await assert.rejects(w.call('admin_transfer', w.A, w.ids.dino, w.ids.john, null, 5000, null, false, null, null), /free to move/);
});

test('LN6 WITHDRAW: refused with nothing saved when it does not fit what can leave MEXC; otherwise request, approval, redemption at true value and a payout record in one step', async () => {
  const w = await ready();
  await cycle(w, 1000, 0);
  await w.call('admin_cash_in', w.A, w.ids.dino, null, 200, null, true, null, null);
  await cycle(w, 1200, 0);
  near(await w.units('dino'), 200, 1e-7);
  await assert.rejects(w.call('admin_withdraw_now', w.A, w.ids.dino, 50, false, null, null, null, null), /where .* is paid/);
  await payTo(w, 'dino');
  await cycle(w, 1200, 120, { bbcore: { wd: 10 }, icore: { wd: 10 }, tcore: { wd: 10 } });   // trades hold the margin: 30 withdrawable
  const reqs0 = (await w.q(`select count(*)::int n from public.withdrawal_requests`))[0].n;
  await assert.rejects(w.call('admin_withdraw_now', w.A, w.ids.dino, 50, false, null, null, null, null), /PAYOUT QUEUED/);
  assert.equal((await w.q(`select count(*)::int n from public.withdrawal_requests`))[0].n, reqs0, 'nothing saved');
  near(await w.units('dino'), 200, 1e-7, 'he keeps his units');
  await cycle(w, 1200, 120);
  const q = await w.call('admin_quote_withdraw_now', w.A, w.ids.dino, 55, false, null, null);
  assert.equal(q.quote, true);
  const r = await w.call('admin_withdraw_now', w.A, w.ids.dino, 55, false, null, null, 'part', 'wd-1');
  near(r.unit_price, 1.1, 1e-12); near(r.pay_usdt, 55 - 0.2 * 0.25 * 20, 1e-5, 'a quarter of his units: the fee is 20% of a quarter of his 20 gain');
  const po = (await w.q(`select status, amount_usdt::float a from public.payout_records where request_id=$1`, [r.request_id]))[0];
  assert.equal(po.status, 'awaiting'); near(po.a, r.pay_usdt, 1e-9);
  near(await price(w), 1.1, 1e-12, 'paying out never moves the price');
  await w.call('admin_payout_sent', w.A, r.request_id, 'TX-123', null);
  await assert.rejects(w.call('admin_withdraw_now', w.A, w.ids.raf, 10, false, null, null, null, null), /payout was sent/, 'the next flow waits for reports taken after the money left');
  await w.clock(Date.now() + 1000);                              // "sent" is stamped with the real clock; the next reports come after it
  await cycle(w, 1200 - r.pay_usdt, 120);
  const rest = await w.call('admin_withdraw_now', w.A, w.ids.raf, 10, false, null, null, null, null);   // the manager's own money: no fee
  near(rest.fee_units, 0, 1e-12);
});

test('LN7 duplicates: the same request id is a replay; an admitted cash-in, a redeemed request, a repeated transfer are never applied twice', async () => {
  const w = await ready();
  await cycle(w, 1000, 0);
  const a = await w.call('admin_cash_in', w.A, w.ids.john, null, 100, null, false, null, 'dup-ci');
  const b = await w.call('admin_cash_in', w.A, w.ids.john, null, 100, null, false, null, 'dup-ci');
  assert.equal(b.replayed, true); assert.equal((await w.q(`select count(*)::int n from public.cash_ins`))[0].n, 1);
  await cycle(w, 1100, 0);
  await w.call('admin_cash_in_received', w.A, a.cash_in_id, null);
  await assert.rejects(w.call('admin_cash_in_admit', w.A, a.cash_in_id, null), /already admitted/);
  const t1 = await w.call('admin_transfer', w.A, w.ids.john, w.ids.dino, null, 10, null, false, null, 'dup-tr');
  const t2 = await w.call('admin_transfer', w.A, w.ids.john, w.ids.dino, null, 10, null, false, null, 'dup-tr');
  assert.equal(t2.replayed, true); near(await w.units('dino'), t1.net_units, 1e-12);
  await payTo(w, 'john');
  const r1 = await w.call('admin_withdraw_now', w.A, w.ids.john, 10, false, null, null, null, 'dup-wd');
  const r2 = await w.call('admin_withdraw_now', w.A, w.ids.john, 10, false, null, null, null, 'dup-wd');
  assert.equal(r2.replayed, true); assert.equal((await w.q(`select count(*)::int n from public.payout_records`))[0].n, 1);
  await assert.rejects(w.call('admin_withdraw_now', w.A, null, null, false, r1.request_id, null, null, null), /already paid/);
});

test('LN8 a wallet stops reporting: the reading is blocked with the reason, no price is published, money in or out waits', async () => {
  const w = await ready();
  await cycle(w, 1000, 50);
  await adv(w, 35);
  await one(w, 'bbcore', 525, 25); await one(w, 'icore', 262.5, 12.5);   // T-CORE silent for 40 minutes
  const b = await lastNav(w);
  assert.equal(b.status, 'blocked'); assert.equal(b.p, null); assert.ok(b.reasons.some((x) => x.code === 'stale'), JSON.stringify(b.reasons));
  near(await price(w), 1.05, 1e-12, 'the last verified price stays, marked as not current');
  assert.equal((await w.call('my_nav', w.A)).current, false);
  const c = await w.call('admin_cash_in', w.A, w.ids.john, null, 100, null, true, null, null);
  assert.equal(c.status, 'waiting'); assert.match(c.waiting_reason, /tcore/);
  await assert.rejects(w.call('admin_transfer', w.A, w.ids.raf, w.ids.dino, null, 10, null, false, null, null), /blocked/);
  const st = await w.call('admin_nav', w.A); assert.ok(st.blocked_rows >= 1); assert.equal(st.current, false);
});

test('LN9 equity curves: deposits, transfers and payouts never show as profit; everybody\'s value adds up to the NAV and, with what waits, to MEXC', async () => {
  const w = await ready();
  await cycle(w, 1000, 0);
  await w.call('admin_cash_in', w.A, w.ids.dino, null, 100, null, false, null, null);
  await w.call('admin_cash_in_received', w.A, 1, null);
  await cycle(w, 1100, 0);                                       // dino joins at 1.00
  await cycle(w, 1100, 55);                                      // 1.05
  await w.call('admin_transfer', w.A, w.ids.raf, w.ids.dino, null, 21, null, false, null, null);   // dino gets 21 more at 1.05
  await cycle(w, 1100, 110);                                     // 1.10
  await payTo(w, 'dino');
  const out = await w.call('admin_withdraw_now', w.A, w.ids.dino, 11, false, null, null, null, null);   // dino takes 11 out at 1.10 (less his fee)
  await w.call('admin_payout_sent', w.A, out.request_id, 'TX-9', null);
  await w.clock(Date.now() + 1000);
  const p = await w.pool();
  await cycle(w, p.e, p.u * 1.1 - p.e);                          // 1.10 still: the payout left the wallets
  await cycle(w, p.e, p.u * 1.2 - p.e);                          // 1.20
  const H = (await w.q(`select public._history($1) h`, [w.ids.dino]))[0].h;
  assert.ok(H.some((p) => p.nav), 'the curve is built from NAV points');
  const pts = H.map((p) => ({ v: p.value, n: p.net_in, u: p.units, price: p.price }));
  const tg = Returns.tradingGrowth(pts); near(tg[tg.length - 1], 1.2, 1e-9, 'trading return = the price change while he held units, flows ignored');
  const yg = Returns.yourGrowth(pts); assert.ok(yg[yg.length - 1] < 1.2 && yg[yg.length - 1] > 1.18, 'your return: the same, less the fee at the payout ' + yg[yg.length - 1]);
  const s = await w.call('admin_nav', w.A); const rc = s.reconciliation;
  near(rc.sum_of_holders_usdt, rc.nav_usdt, 1e-6, 'the holders add up to the NAV');
  assert.ok(Math.abs(rc.unexplained_usdt) <= rc.tolerance_usdt, 'MEXC = NAV + money waiting + payouts not sent ' + rc.unexplained_usdt);
  const ph = await w.call('price_history', w.A); assert.equal(ph[ph.length - 1].kind, 'nav'); near(ph[ph.length - 1].unit_price, 1.2, 1e-9);
  const fr = await w.call('fund_returns', w.A); near(fr[fr.length - 1].price, 1.2, 1e-9);
});

test('LN10 the production chain (no admission spread migration) and wallet_nav_mode = require: cash in, transfer, withdraw all work', async () => {
  const w = await ready({ exclude: ['admission_spread'] });
  assert.equal((await w.q(`select to_regclass('public.admission_spreads') r`))[0].r, null);
  await w.mode('wallet_nav_mode', 'require');
  await cycle(w, 1000, 0);
  const c = await w.call('admin_cash_in', w.A, w.ids.john, 5800, 100, 58, false, null, null);
  await w.call('admin_cash_in_received', w.A, c.cash_in_id, null);
  await cycle(w, 1100, 0);
  near(await w.units('john'), 100, 1e-7);
  await w.call('admin_transfer', w.A, w.ids.john, w.ids.dino, null, 10, null, false, null, null);
  await payTo(w, 'dino');
  const r = await w.call('admin_withdraw_now', w.A, w.ids.dino, null, true, null, null, null, null);
  near(r.pay_usdt, 10, 1e-6); near(await w.units('dino'), 0, 1e-9);
});

test('LN11 backfill: the reports already kept become curve points where they pass the same checks; never after the first live row', async () => {
  const w = await ready();
  await w.mode('nav_auto', 'off');
  const t0 = w.now;
  await cycle(w, 1000, 0); await cycle(w, 1000, 20); await cycle(w, 1000, 40);
  assert.equal((await navs(w)).length, 0);
  const r = await w.q(`select public._nav_backfill($1, $2, 5) r`, [new Date(t0).toISOString(), new Date(w.now - 60000).toISOString()]);
  assert.ok(r[0].r.written >= 2, JSON.stringify(r[0].r));
  const v = await navs(w); near(v[v.length - 1].p, 1.04, 1e-9);
  assert.ok(v.every((n) => n.status === 'verified' && n.source === 'backfill'));
});

test('LN12 rollback: the price is the booked one again, the four steps are gone, every NAV row and cash-in is kept', async () => {
  const w = await ready();
  await cycle(w, 1000, 50);
  await w.call('admin_cash_in', w.A, w.ids.john, null, 50, null, false, null, null);
  const n = (await navs(w)).length;
  await w.db.exec(RB);
  near(await price(w), 1, 1e-12, 'the booked price');
  assert.equal((await navs(w)).length, n); assert.equal((await w.q(`select count(*)::int n from public.cash_ins`))[0].n, 1);
  await assert.rejects(w.call('admin_cash_in', w.A, w.ids.john, null, 50, null, false, null, null), /does not exist|function/);
  await cycle(w, 1000, 50);                                      // reports still work, without a NAV row
  assert.equal((await navs(w)).length, n);
});

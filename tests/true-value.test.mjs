// SIMULATION tests for true-value (mark-to-market) pricing of deposits and withdrawals (lib/truevalue.js). Pure maths: no database, nothing live.
// Each scenario checks the rule that matters: existing holders keep exactly their value from before the flow, and the joiner (or leaver) gets exactly their money,
// whichever trades are open and however they end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const TV = createRequire(import.meta.url)('../lib/truevalue.js');

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const NOW = Date.parse('2026-11-07T12:00:00Z'), MIN = 60000;
// three wallets that together hold `cash` banked plus `open` open P&L (split 50/25/25), all reported 2 minutes ago
const wallets = (cash, open, o = {}) => [['bbcore', 0.5], ['icore', 0.25], ['tcore', 0.25]].map(([wallet, s]) =>
  ({ wallet, equity: (cash + open) * s, unrealized: open * s, receivedMs: NOW - 2 * MIN, suspect: false, ...(o[wallet] || {}) }));

test('TV1 open WINNER: the joiner pays for the open profit, gets exactly his money back when it is realized', () => {
  let s = { book: 200, units: 200 };                                              // Raf: 200 units, book price 1.00, +20 open
  const v = TV.value({ ...s, wallets: wallets(200, 20), nowMs: NOW });
  assert.equal(v.ok, true); near(v.price, 1.10);
  s = TV.deposit(s, 100, v); near(s.minted, 90.90909091, 1e-8);
  const rafBefore = 200 * v.price;                                                // 220: what Raf owned the moment James joined
  s = TV.close(s, 20);                                                            // the open trade closes at exactly +20
  const p = TV.priceOf(s);
  near(p, 1.10, 1e-6);
  near(200 * p, rafBefore, 1e-5, 'Raf keeps 220'); near(s.minted * p, 100, 1e-5, 'James has exactly 100');
});

test('TV2 open LOSER: the joiner pays less, does not carry the loss that happened before he joined', () => {
  let s = { book: 200, units: 200 };
  const v = TV.value({ ...s, wallets: wallets(200, -20), nowMs: NOW }); near(v.price, 0.90);
  s = TV.deposit(s, 100, v); s = TV.close(s, -20);
  const p = TV.priceOf(s);
  near(200 * p, 180, 1e-5); near(s.minted * p, 100, 1e-5);
});

test('TV3 the open trade MOVES after he joined: only that later move is shared, by units', () => {
  let s = { book: 200, units: 200 };
  const v = TV.value({ ...s, wallets: wallets(200, 20), nowMs: NOW });            // +20 open at the join
  s = TV.deposit(s, 100, v); s = TV.close(s, 5);                                   // ...but it closes at +5: -15 after the join
  const p = TV.priceOf(s), share = s.minted / s.units;
  near(s.minted * p, 100 - 15 * share, 1e-5, 'James carries his share of the -15'); near(200 * p, 220 - 15 * (1 - share), 1e-5);
  near(200 * p + s.minted * p, 305, 1e-5, 'nothing is created or lost');
});

test('TV4 PARTIAL WITHDRAWAL with a trade open: the leaver is paid his share of the open profit, the rest keep theirs', () => {
  let s = { book: 300, units: 300 };                                              // Raf 200 units, James 100 units, +30 open
  const v = TV.value({ ...s, wallets: wallets(300, 30), nowMs: NOW }); near(v.price, 1.10);
  s = TV.withdraw(s, 50, v); near(s.paid, 55);                                   // James takes 50 units = 55 USDT
  s = TV.close(s, 30);
  const p = TV.priceOf(s);
  near(200 * p, 220, 1e-5, 'Raf'); near(50 * p, 55, 1e-5, 'James\'s remaining 50 units');
});

test('TV5 several deposits while different trades are open, then all close: every flow is fair at its own moment', () => {
  let s = { book: 1000, units: 1000 }; const holders = { raf: 1000 };
  let v = TV.value({ ...s, wallets: wallets(1000, 50), nowMs: NOW });             // A: +50 open
  s = TV.deposit(s, 500, v); holders.james = s.minted; const val1 = { raf: 1000 * v.price, james: 500 };
  s = TV.close(s, 50);                                                            // A closes as marked
  v = TV.value({ ...s, wallets: wallets(s.book, -30), nowMs: NOW });              // B: -30 open
  const before2 = { raf: holders.raf * v.price, james: holders.james * v.price };
  // between the flows B went to -30: that loss belongs to Raf and James (by units), before Dino joins
  const shareRaf = holders.raf / (holders.raf + holders.james);
  near(before2.raf, val1.raf - 30 * shareRaf, 1e-5); near(before2.james, val1.james - 30 * (1 - shareRaf), 1e-5);
  s = TV.deposit(s, 300, v); holders.dino = s.minted;
  s = TV.close(s, -30);
  const p = TV.priceOf(s);
  near(holders.raf * p, before2.raf, 1e-4); near(holders.james * p, before2.james, 1e-4); near(holders.dino * p, 300, 1e-4);
});

test('TV6 blocked readings: stale, suspect, a wallet missing, wallets out of step, books vs exchange gap', () => {
  const s = { book: 200, units: 200 };
  assert.match(TV.value({ ...s, wallets: wallets(200, 0, { icore: { receivedMs: NOW - 45 * MIN } }), nowMs: NOW }).reason, /icore: report is 45 min old/);
  assert.match(TV.value({ ...s, wallets: wallets(200, 0, { tcore: { suspect: true } }), nowMs: NOW }).reason, /tcore: .*suspect/);
  assert.match(TV.value({ ...s, wallets: wallets(200, 0).slice(0, 2), nowMs: NOW }).reason, /only 2 of 3/);
  assert.match(TV.value({ ...s, wallets: wallets(200, 0, { bbcore: { receivedMs: NOW - 20 * MIN } }), nowMs: NOW }).reason, /more than 10 min apart/);
  const gap = TV.value({ ...s, wallets: wallets(196, 0), nowMs: NOW });          // the exchange holds 4 less than the books say
  assert.equal(gap.ok, false); assert.match(gap.reason, /differ by -4\.00/); assert.ok(gap.checkpoint, 'the reading is still kept for the record');
  assert.throws(() => TV.deposit(s, 10, gap), /blocked/);
});

test('TV7 a small gap inside the tolerance is booked to the holders BEFORE the flow, never to the joiner', () => {
  let s = { book: 200, units: 200 };
  const v = TV.value({ ...s, wallets: wallets(199.7, 10), nowMs: NOW });          // exchange 0.30 below the books (fees on open trades)
  assert.equal(v.ok, true); near(v.gap, -0.30, 1e-9);
  s = TV.deposit(s, 100, v); s = TV.close(s, 10);
  const p = TV.priceOf(s);
  near(200 * p, 209.7, 1e-5, 'Raf absorbs the 0.30 that happened before'); near(s.minted * p, 100, 1e-5, 'James is untouched by it');
});

test('TV8 money waiting in the exchange (recorded, not admitted) is not part of the pool value', () => {
  const s = { book: 200, units: 200 };
  const v = TV.value({ ...s, wallets: wallets(300, 0), notInPool: 100, nowMs: NOW });   // 100 sits in Futures, not admitted yet
  assert.equal(v.ok, true); near(v.price, 1.0);
  assert.equal(TV.value({ ...s, wallets: wallets(300, 0), nowMs: NOW }).ok, false, 'forgetting it shows as a +100 gap and blocks');
});

test('TV9 the Oct 28, 2026 double count cannot happen: open P&L is never written into the book', () => {
  // old way: the valuation wrote book = exchange (with -0.91 open), then the two trades closed and added their FULL result again
  const old = { book: 52.31 }; old.book = 52.31 - 0.91; old.book += 3.40 - 0.80;            // -0.91 counted in the valuation AND inside the +3.40 / -0.80
  // new way: the flow takes only the gap and the deposit; the full realized results land when the trades close
  let s = { book: 52.31, units: 52.31 };
  const v = TV.value({ ...s, wallets: wallets(52.31, -0.91), nowMs: NOW });
  s = TV.deposit(s, 200, v); s = TV.close(s, 3.40 - 0.80);
  near(s.book, 52.31 + 200 + 2.60, 1e-9, 'each trade counted once');
  near(old.book + 200, s.book - 0.91, 1e-9, 'the old way ended 0.91 lower: the open loss twice');
});

test('TV10 value vs what can be withdrawn now are shown separately', () => {
  const l = TV.liquidity({ units: 100, totalUnits: 400, V: 440, withdrawable: 300 });
  near(l.value, 110); near(l.withdrawableNow, 75); near(l.lockedInTrades, 35);
  const l2 = TV.liquidity({ units: 100, totalUnits: 400, V: 440, withdrawable: 300, pendingPayouts: 100 });
  near(l2.withdrawableNow, 50, 1e-9, 'payouts already promised come first');
});

test('TV11 fees on the true price: open profit is charged once, its later realization not again; a reversal is not charged; deposits do not move anyone\'s mark', () => {
  let lot = { units: 100, hwm: 1.00 };
  let f = TV.lotFee(lot, 1.10, 0.20);                                              // quarter end: +10% (open profit included)
  near(f.fee, 2.0); lot = f.lot; near(lot.hwm, 1.10);
  f = TV.lotFee(lot, 1.10, 0.20); assert.equal(f.fee, 0, 'the trade then closes as marked: price unchanged, no second fee');
  f = TV.lotFee(lot, 1.02, 0.20); assert.equal(f.fee, 0, 'a fall below the mark charges nothing');
  f = TV.lotFee(lot, 1.15, 0.20); near(f.fee, (1.15 - 1.10) * lot.units * 0.2, 1e-8, 'only the gain above the old best');
  const joiner = { units: 50, hwm: 1.15 };                                         // a new lot starts at the price it paid
  near(TV.lotFee(joiner, 1.15, 0.20).fee, 0); near(lot.hwm, 1.10, 1e-12, 'the older lot\'s mark is untouched by the deposit');
});

test('TV12 today\'s numbers (Nov 7, 2026), after the two corrections: Raf keeps his value, James gets exactly his 66.40', () => {
  const book = 223.5521 - 4.9258 + 0.8582, units = 255.64425442;                  // ledger value, minus the skipped SOL trade, plus the Oct 28 double count
  const ws = [
    { wallet: 'bbcore', equity: 197.00, unrealized: 7.18, receivedMs: NOW - 2 * MIN, suspect: false },
    { wallet: 'icore', equity: 94.68, unrealized: 0.78, receivedMs: NOW - 2 * MIN, suspect: false },
    { wallet: 'tcore', equity: 97.68, unrealized: 3.82, receivedMs: NOW - 2 * MIN, suspect: false }];
  const v = TV.value({ book, units, wallets: ws, notInPool: 158.0278, nowMs: NOW });   // the 158 USDT sits in Futures, not admitted
  assert.equal(v.ok, true, v.reason);
  const rafBefore = units * v.price;
  let s = TV.deposit({ book, units }, 66.40, v); const james = s.minted;
  s = TV.deposit(s, 91.6278, TV.value({ book: s.book, units: s.units, wallets: ws, notInPool: 91.6278, nowMs: NOW }));
  s = TV.close(s, 7.18 + 0.78 + 3.82);                                              // the open trades close exactly as marked
  const p = TV.priceOf(s);
  near(james * p, 66.40, 1e-4, 'James'); near((s.units - james) * p, rafBefore + 91.6278, 1e-4, 'Raf: his value before + his own top-up');
});

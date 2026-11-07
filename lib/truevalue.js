// truevalue.js — SIMULATION of "true value" (mark-to-market) pricing for deposits and withdrawals. Pure functions: no database, no network, changes nothing live.
// It is the model the ledger change will be built from and tested against (tests/true-value.test.mjs), proposed Nov 7, 2026.
//
// The idea: money joins or leaves at what the pool is worth if every open trade closed now, so nobody waits for trades to close and nobody shares results from before
// they joined (or after they left).
//
//   exchange value  V = Σ wallet equity (MEXC equity already includes open P&L)  −  money in the exchange that is not in the pool yet (recorded deposits not admitted)
//                                                                               −  money already redeemed but not yet sent
//   check           V  vs  book + Σ wallet open P&L        (book = the ledger's value from closed trades). A gap above the tolerance blocks the flow until a person explains it.
//   price           P = V / units
//   a deposit D     buys D / P units;   a payout of u units pays u × P
//
// The book keeps rolling forward from CLOSED trades only (as today). Open P&L is NEVER written into the book: at a flow the book takes the reconciliation gap (V − book − open P&L)
// and the deposit or payout, nothing else. When the open trades later close, their realized result lands in the book and the price is exactly what V said. Writing open P&L
// into the book is what double counted -0.86 USDT on Oct 28, 2026 (that valuation included two open trades that were later added again in full when they closed).
'use strict';

const r8 = (x) => Math.round(x * 1e8) / 1e8;
const DEFAULTS = { expectedWallets: 3, maxAgeMin: 30, maxSkewMin: 10, tolAbs: 0.5, tolPct: 0.0005 };

// wallets: [{ wallet, equity, unrealized, receivedMs, suspect }]  ->  { ok, reason?, V, openPnl, book, gap, price, checkpoint }
function value({ book, units, wallets, notInPool = 0, redeemedNotSent = 0, nowMs, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const fail = (reason) => ({ ok: false, reason });
  if (!(units > 0)) return fail('no units yet: the first deposit sets the price at 1');
  if (!Array.isArray(wallets) || wallets.length < o.expectedWallets) return fail(`only ${wallets ? wallets.length : 0} of ${o.expectedWallets} wallets have reported`);
  for (const w of wallets) {
    if (!Number.isFinite(w.equity) || !Number.isFinite(w.unrealized)) return fail(`${w.wallet}: no equity or open P&L in its report`);
    if (w.suspect) return fail(`${w.wallet}: its last report is marked suspect (a jump nobody has explained)`);
    if (nowMs - w.receivedMs > o.maxAgeMin * 60000) return fail(`${w.wallet}: report is ${Math.round((nowMs - w.receivedMs) / 60000)} min old (limit ${o.maxAgeMin})`);
  }
  const times = wallets.map((w) => w.receivedMs);
  if (Math.max(...times) - Math.min(...times) > o.maxSkewMin * 60000) return fail(`the wallet reports are more than ${o.maxSkewMin} min apart (a transfer between wallets could be counted twice or missed)`);
  const equity = wallets.reduce((a, w) => a + w.equity, 0), openPnl = wallets.reduce((a, w) => a + w.unrealized, 0);
  const V = equity - notInPool - redeemedNotSent, gap = V - (book + openPnl), tol = Math.max(o.tolAbs, o.tolPct * Math.abs(V));
  const checkpoint = { at: nowMs, book, openPnl, equity, notInPool, redeemedNotSent, V, gap, units,
    wallets: wallets.map((w) => ({ wallet: w.wallet, equity: w.equity, unrealized: w.unrealized, receivedMs: w.receivedMs })) };
  if (Math.abs(gap) > tol) return { ...fail(`the exchange (${V.toFixed(2)}) and the books + open P&L (${(book + openPnl).toFixed(2)}) differ by ${gap.toFixed(2)} (tolerance ${tol.toFixed(2)}): explain it first`), checkpoint };
  if (!(V > 0)) return { ...fail('the pool value is not positive'), checkpoint };
  return { ok: true, V, openPnl, book, gap, price: V / units, checkpoint };
}

// a deposit of D at true value. Returns the state after it: { book, units, minted, price }. The book takes the gap and D, never the open P&L.
function deposit(state, D, val) {
  if (!val.ok) throw new Error('blocked: ' + val.reason);
  if (!(D > 0)) throw new Error('deposit must be > 0');
  const minted = r8(D / val.price);
  return { book: state.book + val.gap + D, units: state.units + minted, minted, price: val.price };
}
// a payout of u units at true value: { book, units, paid, price }
function withdraw(state, u, val) {
  if (!val.ok) throw new Error('blocked: ' + val.reason);
  if (!(u > 0) || u > state.units + 1e-12) throw new Error('payout units out of range');
  const paid = u * val.price;
  return { book: state.book + val.gap - paid, units: state.units - u, paid, price: val.price };
}
// trades close: the book takes their realized result (exactly as the ledger does today)
const close = (state, realized) => ({ ...state, book: state.book + realized });
const priceOf = (state, openPnl = 0) => (state.book + openPnl) / state.units;

// what an investor sees: value at the true price vs what can leave the exchange now (the payout cap). They are not the same thing.
function liquidity({ units, totalUnits, V, withdrawable, pendingPayouts = 0 }) {
  const share = totalUnits > 0 ? units / totalUnits : 0, value = share * V;
  const poolCash = Math.max(0, withdrawable - pendingPayouts);
  return { value, withdrawableNow: Math.min(value, share * poolCash), lockedInTrades: Math.max(0, value - share * poolCash) };
}

// per-deposit (per-lot) high-water mark at the TRUE price: a fee only on gains above the lot's best price, measured on the true price, so
// - open P&L counts once (in the price), and a trade's later realization does not move the price again (it was already in it),
// - a deposit buys at the current price, so it never raises anyone's gain, and other lots' marks are untouched,
// - after a fee the lot's mark moves to that price, so the same gain is never charged twice; a fall below the mark charges nothing until it is recovered.
function lotFee(lot, price, rate) {
  const gainPerUnit = Math.max(0, price - lot.hwm), fee = r8(gainPerUnit * lot.units * rate);
  if (!(fee > 0)) return { fee: 0, feeUnits: 0, lot };
  const feeUnits = Math.floor((fee / price) * 1e8) / 1e8;     // rounded DOWN, as the ledger does
  return { fee, feeUnits, lot: { ...lot, units: lot.units - feeUnits, hwm: price } };
}

module.exports = { DEFAULTS, value, deposit, withdraw, close, priceOf, liquidity, lotFee };

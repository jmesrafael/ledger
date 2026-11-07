# True-value pricing for deposits and withdrawals

Status (Nov 7, 2026):
- **Late-trade fix: APPLIED to the live ledger** (`20261206000000_auto_pool_late_trade.sql`, approved). It changed no data: all 12 existing closed trades were already booked.
- **True-value pricing: built and tested, NOT applied** (`20261207000000_true_value_pricing.sql`, rollback in `supabase/rollback/`). Off by default (`flow_pricing = 'book'`).
- **Two corrections: prepared, NOT applied** (`supabase/corrections/20261107_prepare_book_corrections.sql`; each is applied separately by the manager with `admin_apply_book_correction`).
- Model `lib/truevalue.js` (TV1–TV12), database tests `tests/true-value-db.test.mjs` (TVD1–TVD11), page tests `tests/truevalue-ui.test.mjs` (TVU1–TVU5).

## The rule

Money joins or leaves at what the pool is worth **if every open trade closed now**, read from the bots' own MEXC reports (every 5 minutes, one per wallet):

```
V     = Σ wallet equity (includes open P&L) − recorded money not yet admitted − money redeemed but not sent
check = V − (book + Σ open P&L)          must be within max(0.50 USDT, 0.05%), else blocked until a person explains it
price = V / units                        deposit D → D / price units;  payout of u units → u × price
book  += gap ± the flow                  open P&L is never written into the book
```

The book keeps rolling forward from closed trades (MEXC's realized figure, fees and funding included). When the open trades close, their result lands in the book and the
price is what `V` said: existing holders keep exactly their pre-flow value, the joiner exactly his money (TV1–TV5, TV12).

## The review's points

1. **The 3.97 USDT gap** (ledger 223.55 vs exchange 219.58), explained to 0.07:
   - **−4.9258**: BB-Core SOL short closed Nov 4 14:48 was never added. I-Core's GALA (closed 15:05) reached the ledger 2 s earlier; the "already included" rule compared
     close times with the newest entry of any kind, so SOL was skipped (pool log: "1 closed trade(s) … treated as already included"). Fixed by the new migration: only a
     valuation a person took from the exchange can already contain a trade.
   - **+0.8582**: the Oct 28 valuation (52.31 → 51.45) included two open trades (SOL short 0.6 @ 99.62, ZEC long 0.01 @ 1298.8; MEXC prices at 14:30 give about −0.91);
     both later closed and their full results were added again.
   - **0.07** left: fees and funding already paid on positions still open, two small test trades. Inside the tolerance.
   - Corrections for the live books need the manager (two adjustment entries with reasons); not done.
2. **No double counting**: equity already contains open P&L, so open P&L is used only to check and price, never added to the book (TV9 reproduces Oct 28).
   MEXC's realized figure already includes trading fees and funding (checked on the Nov 4 SOL trade: gross −4.65, realized −4.93).
3. **Valuation time of a deposit**: the deposit is recorded first (amount, wallet). Its price is the complete set of wallet reports received **before** the money arrived,
   and that set must be at most 10 minutes older than the arrival (reports come every 5 minutes, so normally ≤ 5). Arrival = the first report of that wallet whose equity
   rises by the recorded amount (± tolerance). Anything else (no recorded deposit, a different amount, a stale or suspect report) is **not** accepted automatically.
   Market risk of the gap between the last report and the arrival: at most one 5-minute interval of the open trades' movement.
4. **Value vs liquidity** (TV10): investors see their value at the true price and, separately, what can leave the exchange now (their share of MEXC's withdrawable balance,
   after payouts already promised) and the part locked in open trades.
5. **Fees** (TV11): per-lot high-water mark on the true price. Open profit is charged once (it is in the price); its later realization does not move the price, so no second
   fee; a reversal charges nothing until the mark is recovered; a deposit starts its own lot at the price it paid, other lots' marks are untouched.

## What the migration adds (all inert while flow_pricing = 'book')

- `_true_value()`: the reading (built on `_wallet_nav`: every wallet fresh, none suspect or outdated, within 10 minutes, the expected count) plus three more gates: no closed
  trade waiting to be booked, no bot exit without a booked MEXC result (in trades mode exits are never "applied", so the old pending-exit guard would block every
  deposit; this replaces it inside a true-value flow only), and nothing booked after the newest report. Then the gap check against books + open P&L.
- `admin_admit_deposit_tv`, `admin_execute_withdrawal_tv`: the existing deposit and payout engines, given the verified exchange total (so units, lots, lock-up, minimum,
  fees and payout records are the existing code), then the book entry that takes the open P&L back out, then the checkpoint. A sale to the manager stays on the normal path.
- `flow_checkpoints` (append-only): every number and every wallet report used by each true-value flow. `book_corrections`: prepared / applied / cancelled, reason and evidence.
- `admin_true_value` (manager), `my_true_value` (an investor's own value, withdrawable now, locked in trades), shown by `js/truevalue-ui.js`.
- Two existing functions gain a branch that only acts on rows the new functions write: `_auto_pool_value_trades` (a correction is not an exchange valuation; a true-value
  flow contains exactly the trades each wallet's report had seen) and `_pool_guard_pending` (skipped inside a true-value flow only).
- The backup export carries both new tables.

## Not done (each needs the owner's OK)

1. Apply `20261207000000_true_value_pricing.sql` (inert until switched on).
2. Prepare the corrections (the SQL file), then apply each one (manager, signed in): −4.9258 and +0.8582.
3. Record the 158 USDT deposit (James 66.40, Raf 91.6278), then switch `flow_pricing` to `true_value` and admit both with `admin_admit_deposit_tv`.
4. Quarter-end settlement is still on the typed-total path: with trades open it writes open P&L into the book (the Oct 28 pattern). A true-value settlement is the next piece.

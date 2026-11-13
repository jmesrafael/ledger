> Note (Nov 13 2026): the screens named here as Record > Balance / Money in (by hand) / Money out (by hand) are retired; the manager now uses the four steps in docs/live-nav.md. The database rules below still apply.

# True-value pricing for deposits and withdrawals

Status (Nov 7, 2026):
- **Late-trade fix: APPLIED to the live ledger** (`20261206000000_auto_pool_late_trade.sql`, approved). It changed no data: all 12 existing closed trades were already booked.
- **True-value pricing: built and tested, NOT applied** (`20261207000000_true_value_pricing.sql`, rollback in `supabase/rollback/`). Off by default (`flow_pricing = 'book'`).
- **Two corrections: prepared, NOT applied** (`supabase/corrections/20261107_prepare_book_corrections.sql`; each is applied separately by the manager with `admin_apply_book_correction`).
- Model `lib/truevalue.js` (TV1–TV12), database tests `tests/true-value-db.test.mjs` (TVD1–TVD11), lifecycle tests `tests/true-value-lifecycle.test.mjs` (L1–L7), page tests `tests/truevalue-ui.test.mjs` (TVU1–TVU5).

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

- `_true_value(as_of)`: the reading (built on `_wallet_nav`, or `_wallet_nav_at(as_of)` for an earlier moment: every wallet fresh, none suspect or outdated, within 10
  minutes, the expected count) plus: no closed trade waiting to be booked, no bot exit without a booked MEXC result (in trades mode exits are never "applied", so the
  old pending-exit guard blocks every normal deposit today; this replaces it inside a true-value flow only), nothing booked after the newest report (or, as of an
  earlier moment, nothing but automatic trade bookings and corrections since). Then the gap check against books + open P&L.
- `admin_admit_deposits_tv(ids, as_of)` (and `admin_admit_deposit_tv` for one, now): the existing deposit engine at the true price, then the book entry
  (books now + gap + money in). With `as_of`, the price is that earlier complete reading; trades booked since are kept in the book, so the outcome equals "joined
  then" (test L5).
- `admin_execute_withdrawal_tv`: the existing payout engine (fee on the lot's gain, lock-up, minimum, payout record) at the true price, then the book entry.
- `admin_close_quarter_tv`: the newest settlement body (20261127: confirmed-gain fee timing, settlement lines, the fund manager's figures, late / backdated windows,
  the open-trades rule, pending money joining after the fees) with the verified wallet reports as the exchange evidence, the ledger's internal consistency and
  transfer matching still required, then the book entry. With fee_timing 'immediate' (live) a settlement with open trades still needs a written open_positions
  exception, as before; with 'confirmed' it runs with a warning.
- A trigger refuses every person-written pool entry outside the true-value functions while flow_pricing = 'true_value' (the old typed-total deposit, payout,
  valuation and settlement would put the open trades into the book). Automatic trade bookings, corrections and the very first deposit are not affected.
- `flow_checkpoints` (append-only): every number and every wallet report used by each true-value deposit, payout and settlement. `book_corrections`: prepared /
  applied / cancelled with reason and evidence; `admin_preview_book_corrections` shows the book and the reconciliation after each one, in order; they apply in order.
- `admin_true_value`, `admin_true_value_at`, `admin_settlement_preview_tv` (manager), `my_true_value` (an investor's own value, withdrawable now, locked in trades),
  shown by `js/truevalue-ui.js`.
- Two existing functions gain a branch that only acts on rows the new functions write: `_auto_pool_value_trades` (a correction is not an exchange valuation; a
  true-value flow contains exactly the trades each wallet's report had seen) and `_pool_guard_pending` (skipped inside a true-value flow only).
- The backup export carries both new tables. Every function is one transaction and takes an idempotency key.

## Evidence for the 158 USDT (Nov 7, 2026)

| Wallet | MEXC transfer in | Last report before it | First report with it |
|---|---|---|---|
| BB-Core | 18.35 at 03:09:32 | 03:05:05 (#5578) | 03:10:06 (#5580), withdrawable +18.3500 |
| T-CORE | 83.83 at 03:16:19 | none: this wallet first reported at 03:31:06 | 03:31:06 (#5589) |
| I-Core | 55.8478 at 03:21:47 | 03:20:03 (#5583) | 03:25:04 (#5585, suspect as a >50 % jump, not accepted yet) |

No complete set of reports exists before the arrivals (T-CORE was not reporting yet). The first complete, verified set with the money inside is 03:30:03 /
03:30:03 / 03:31:06 (63 s apart); the 158.0278 is excluded there as waiting money. No trade was opened between the arrivals and that reading (the bots act on the
04:00 candle). With both corrections: book then 217.3413, open P&L 14.0641, exchange value 231.5279, gap 0.1225, price 0.905664.

## Not done (each needs the owner's OK)

1. Apply `20261207000000_true_value_pricing.sql` (inert until switched on).
2. Run the corrections file (prepares), review `admin_preview_book_corrections`, then apply #1 and #2 in order.
3. Accept snapshot #5585 (I-Core's +55.8478 arrival) with its reason, record the two deposits as waiting, then switch `flow_pricing` to `true_value` and admit both
   with `admin_admit_deposits_tv([...], '2026-11-07T03:31:06Z')`.

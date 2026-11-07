# True-value pricing for deposits and withdrawals (proposal, simulation only)

Status (Nov 7, 2026): **simulated and tested, nothing applied to the live ledger.** Model: `lib/truevalue.js`. Tests: `tests/true-value.test.mjs` (TV1–TV12).
Separate bug fix found on the way: `supabase/migrations/20261206000000_auto_pool_late_trade.sql` (test CT12), also **not applied**.

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

## Not done yet (each needs the owner's OK)

1. Apply the late-trade fix and book the two corrections (−4.9258, +0.8582) on the live ledger.
2. Build true-value pricing into the database functions behind a setting (default off), tested on the in-memory database against this model.
3. Dashboard: price indicator ("money can join/leave now at …", or why not), checkpoint per flow, value vs withdrawable.

# Live NAV: the price follows MEXC, and your routine is four steps

Migration: `supabase/migrations/20261213000000_live_nav.sql` (rollback: `supabase/rollback/20261213000000_rollback_live_nav.sql`, built by
`scripts/build-rollback-live-nav.mjs`). Tests: `tests/live-nav.test.mjs` (LN1–LN12), `tests/desk.test.mjs` (DK1–DK6). Screens: `js/desk.js` + `js/app.js`.

## What you do by hand (only this)

| Step | Where | What happens |
|---|---|---|
| **Add investor** | Record → Add investor | Account + first cash-in in one transaction. |
| **Cash in** | Record → Cash in | Pesos, the USDT that arrived in MEXC, the rate (pre-filled live). Tick "It is in MEXC". It joins by itself at the first verified reading that shows the money. |
| **Withdraw** | Record → Withdraw | Redeemed at the live price (request, approval, redemption in one step) after a liquidity check. Then send it from MEXC and press **Mark sent**. Investor requests appear above the form with **Process**. |
| **Transfer** | Record → Transfer | Ownership from one holder to another, in pesos (at the rate) or in USDT value. |

Nothing else: no Update Pool, no typed exchange totals, no waiting for trades to close, no settlement needed for anyone's value to move.

## How the price is made (automatic)

Every 5 minutes each bot (BB-Core, I-Core, T-CORE) sends its MEXC wallet report. When a **complete new set** is in (all three fresh, none suspect,
within 10 minutes of each other), the ledger takes the existing true-value reading:

```
NAV          = Σ wallet equity (open trades included) − money waiting to join − payouts redeemed but not sent
check        = NAV − (book + open P&L)        must be within max(0.50 USDT, 0.05%)
unit price   = NAV ÷ all units
```

and writes one row to `nav_snapshots`: **verified** with its price, or **blocked** with the reasons and **no price** (an unverified NAV is never
published; screens keep the last verified price and say "Paused" with the reason). Every deposit, payout and transfer adds one more row at the price it
used, so each investor's curve has a point at every flow.

- Every screen (investor balance, ownership %, profit, ROI, equity curve, fee due, the dashboard) uses the newest verified price (`_price_now`).
- Money is never priced by that stored row: each cash-in, withdrawal and transfer takes its own fresh reading under the ledger lock.
- The **book** is unchanged: it still rolls forward from MEXC's realized results only (closed trades, booked automatically). An open trade's P&L is
  in the NAV through wallet equity, and enters the book once, when it closes. So a profit is never counted twice (test LN2).

### Why `bot_equity_sync` stays off and `wallet_nav_mode` is not needed

`bot_equity_sync` wrote a bot's total INTO the book, open trades included, which the closed-trade booking would then add again (the Oct 28, 2026 double
count). The live NAV is what it was for, without that problem. `wallet_nav_mode` only governs the older typed-total screens; the live NAV already runs on
the same wallet checks. Both flows were tested with it on (LN10).

## The rules for money

- **Cash in:** the investor is credited `pesos ÷ rate` (rounded down to 6 decimals). Less USDT arrived: the gap comes from **your** units at the live price
  (the peso top-up rule). More arrived: the rest joins as **your** own money. Your own cash-ins are simply the USDT that arrived. Their high-water mark
  is what they were credited: no fee on their own money. The rate must be within 2% of the fund's stored PHP/USD reference.
- **Withdraw:** the fee on the redeemed share's gain above their mark (as before). Refused with nothing saved when it does not fit what MEXC can release
  now (withdrawable, less 5% and 5 USDT, less payouts not sent yet). Payout details are required for investors. Inside the lock-up a written reason is needed.
- **Transfer:** pool value and total units do not move. The sender is treated as selling that share: the fee on its gain above their mark is charged now
  (to you), the recipient's mark rises by what they receive. So a transfer can neither skip a fee nor charge one twice (LN5). You pay no fee as a sender.
- Every step is one transaction with a request id: a repeated click or a lost reply is a replay, never a second payment (LN7).

## Settlements

Valuations no longer need one. The fee is still crystallized only by the two-month settlement (or at a withdrawal / transfer), exactly as the investor
terms say; no historical fee or fee rate was changed.

## Discrepancies (detected automatically)

The price pauses, with the reason on **Record → Accounting → Live NAV** and the dashboard, when:
- money is in MEXC that nobody recorded (or recorded money is not in MEXC yet: "it must be in a bot's Futures account");
- a bot exit has no MEXC result booked yet (the bots now fetch MEXC's history themselves if it was missing at the exit, read-only);
- a wallet stops reporting, jumps more than 50%, or a payout was sent and the wallets have not reported since.

The same screen shows the reconciliation: MEXC = everybody's value + money waiting + payouts not sent, and the unexplained remainder.

## History

`_nav_backfill(from, to, step_minutes)` fills the curves from the wallet reports already kept (30 days), only at moments that pass the same checks, and never
after the first live row. Run once after any missing trade is booked.

## Rollback

`supabase/rollback/20261213000000_rollback_live_nav.sql` puts back the booked price and the earlier functions. It keeps every NAV row and cash-in; units,
marks and payouts already recorded are ordinary ledger rows and stay as they are.

## Deployment (nothing here is applied to production yet)

Done already on Nov 12–13, 2026, with no change to any ledger row: a copy of the money tables in schema `backup_20261113` (22 tables), and the bot fix on the VPS
(BB-Core, I-Core, T-CORE `ledger-sync.js` + the call in `lucidio.js` / `icore.js`; backup in `/var/backups/claude-history-recover-20261112-2128`). That fix
alone brought the ledger's reconciliation gap from 13.36 to −0.26 USDT and un-paused true-value pricing (the missed BB-Core NEAR short, +13.6125).

Left for you, in this order:

1. **Database:** Supabase → SQL editor → paste `supabase/migrations/20261213000000_live_nav.sql` and run it. Safe to run twice; it rewrites no ledger row.
   Expect afterwards: `select count(*) from nav_snapshots` grows by one row every 5 minutes; `select public._price_now()` is about the true-value price
   (about 1.005 on Nov 13, against the booked 0.882, because open trades are now inside it).
2. **Check (read-only):** the counts and md5 of `ledger`, `pool_equity`, `investor_hwm`, `pending_deposits`, `flow_checkpoints`, `closed_trades` must equal what they were
   before step 1 (ledger `3ed81e90…`, pool_equity `0509bfda…` on Nov 12 before the NEAR trade was booked; re-take them just before running).
3. **Website:** the next Vercel deploy of this repo (`js/desk.js`, `js/app.js`, `login.html`). It works before step 1 (the old Record screens show) and after it (the four steps).
4. **History (optional, once):** `select public._nav_backfill('2026-11-07 10:30+00', now() - interval '1 hour', 60);` fills the curves from the kept wallet reports.
5. **Rollback:** `supabase/rollback/20261213000000_rollback_live_nav.sql`.

## History filled (Nov 13, 2026)

`supabase/maintenance/20261113_backfill_nav_history.sql` turned the kept MEXC wallet reports (Oct 28 → Nov 12) into 1,007 verified NAV points every 15 minutes, plus a
point at each Nov 7 flow, so every holder's curve moves with the real accounts (like the Total Fund chart): value = their units then × that moment's price. Same
checks as live readings; it added rows to `nav_snapshots` only (ledger, units, marks and fees unchanged, verified against `backup_20261113`). Curves now have one
point per 15 minutes (`nav_history_bucket_minutes = 15`). Nov 2 midday → Nov 7 03:30 is skipped on purpose: I-Core had moved to a new MEXC account while the
old one still held a position, so the reports did not match the books; the curve is a straight line there rather than a guess.

# Pool Update: trading results never move the pool by themselves

Status: **implemented and tested on an in-memory database, not applied to any real database.** Migration:
[`20261112000000_pool_update.sql`](../supabase/migrations/20261112000000_pool_update.sql) (rollback: `supabase/rollback/20261112000000_rollback_pool_update.sql`).
Tests: `tests/pool-update.test.mjs` (database), `tests/pool-ui.test.mjs` (screen), `test/capital-flows-test.js` in BB-Core (dashboard).
Staging run with fake live trades: `node scripts/staging-flow.mjs` (in-memory, reads no credentials, cannot reach a real project).

## The rule

1. The bot sends every closed **live** trade to the dashboard (`bot_events`, type `exit`, mode `live`). Paper trades can never count.
2. A closed live trade is **pending**. Pending means: it is shown, counted and dated, and it changes **nobody's money**: no units, no unit price, no balance.
3. The pool changes only when the manager clicks **Update Pool**. That click values the pool at the **confirmed Exchange balance** (a fresh, flat balance check)
   as an ordinary `update` entry, and marks the pending trades as applied. The pending trades only **explain** the change; they do not set it.
   (The bot's per-trade dollar figures are estimates: fees, slippage and funding differ from what Exchange really booked. The pool follows Exchange.)
4. While any live trade is pending, **nobody can join and nobody can be paid out.** The database refuses: `admin_admit_deposit`, `admin_execute_withdrawal`
   and a trigger on the ledger, so no other route works either.
5. `bot_post_equity` can no longer move the unit price (`bot_equity_sync = 'off'`). `bot_post_snapshot` keeps working and feeds the reconciliation.

## Who gets what (units, as before)

Unit price = pool value ÷ all units. A trading result changes the price, so everyone holding units at that moment shares it by their units.
A joiner buys units at the price **after** Update Pool, so they get none of the earlier profit and carry none of the earlier loss. A leaver is paid at that price.

Worked numbers (tests 1a, 1b, 1d): John holds 1,000 USDT of units; a live trade closes at -100; Dino's 500 USDT arrives in the exchange. Exchange total 1,400.
Update Pool: pool value 900 (1,400 minus Dino's waiting 500), price 0.90. Dino then buys 555.56 units for 500. John's 1,000 units are worth 900, Dino's are worth 500.

## The manager's routine

> The same steps are in the app: the **? How this works** button at the top of **Money in**, **Money out** and **Balance** opens them as a step-by-step sheet (source: `js/recordhelp.js`; a test checks that every button it names exists on a real screen).

1. A joiner's money is received and must wait in **Exchange Spot, not Futures.** Mark it **Seen in the exchange** (with a note). Queued money is not traded, because the bot
   sizes on Futures equity. This is what keeps a joiner from taking part in trades before they are in the pool.
2. **Record → Balance:** enter the exchange total (Spot + Futures) with no open position and confirm it. A banner shows `N trades, ±X USDT pending since <date>`.
3. Click **Update Pool**, then accept the joiner. Or tick the joiners and click **Update Pool and accept ticked**: one transaction, so nothing is half done.
4. **Accepting includes the Spot → Futures transfer.** In the exchange, transfer the accepted amount from Spot to Futures right after you click. The bot's next run
   (every 4 hours) sees the larger Futures equity and sizes on it. That increase is capital, not profit.
5. **Withdrawals:** Update Pool first, then Redeem. Then, in the same sitting: Futures → Spot, withdraw, and click **Sent from the exchange**. Until you click it, the
   reconciliation counts the money as still in the account, so do the transfer and the click together.
6. **Undo:** the ledger only undoes the newest entry, and a correction can never be undone. An Update Pool can be undone only while it is still the newest entry
   (before anyone is accepted on top of it). Its trades then return to pending.

## Reconciliation

On every bot snapshot, and whenever the page loads:

```
expected Exchange futures equity = pool value
                             + pending live P/L
                             + unrealized P/L of open trades
                             + money redeemed but not yet marked sent
                             (+ queued money, only if it waits in Futures: setting queued_money_location = 'futures')
difference = bot's Exchange reading - expected          tolerance = max(0.50 USDT, 0.05% of the balance)
```

- `ok`: shown in green. `mismatch`: Update Pool, accepting joiners and payouts are blocked until it is explained (a missed transfer, fees or funding, a trade the bot did not report).
- `waiting_snapshot`: something changed after the bot's last reading; the next reading decides. `stale_snapshot` / `no_snapshot`: shown, and blocking only if `pool_recon_strict = '1'`.
- Update Pool also checks the typed Exchange total against the books. If the pending trades do not explain the change within the tolerance, it does **nothing**, writes the block to
  `pool_recon_log`, and asks you to classify the rest (fees, funding, transfer, timing, other) with a written reason. Inside the tolerance it goes ahead and records the small difference.
- The tolerance is configurable: `pool_recon_tol_abs` (0.5) and `pool_recon_tol_pct` (0.0005) in `ledger_settings`. Every block is logged (one line per distinct mismatch).

## Mistakes the design makes impossible or visible

| Mistake | What happens |
|---|---|
| Double-click on Update Pool | Same request id: the stored answer comes back (`replayed`). A second click without it is refused as a stale screen. Each trade can be applied once (primary key). |
| Clicking from an old screen | The button sends the exact trade ids and total it showed; a trade that closed in between makes the database refuse. |
| A balance check older than the newest closed trade | Refused. |
| Forgetting Update Pool | Joins and payouts are refused with "pending P/L"; the banner shows on the dashboard and the Balance desk. |
| The bot moving the pool | `bot_post_equity` returns `disabled`; no pool entry is written. |
| Calling the original functions directly | The originals were renamed `_..._core` and closed to the website roles; the trigger also refuses ledger deposits and withdrawals. |

## Bot dashboard

`capital_flows` (deposits when they join the pool, payouts when marked sent; signed, no names) reaches the dashboard through the service-role key. The page:
change since start = last balance - start balance - net capital flows; capital shows as labeled steps on the Capital chart; the Performance tab is the balance with capital taken out
(plus a time-weighted return); the trade statistics (R, win rate, profit factor, drawdown) never see capital. **Live dollar figures only reach the dashboard when
`DASHBOARD_SHARE_LIVE_EQUITY=true` is set on the VPS**; without it live exits carry no dollar amount, the pending total cannot be computed, and Update Pool needs the whole difference classified.

## Settings (`ledger_settings`)

| Key | Default | Meaning |
|---|---|---|
| `bot_equity_sync` | `off` | `on` lets `bot_post_equity` move the unit price again. Leave it off. |
| `pool_update_gate` | `on` | `off` removes the "no join / payout while trades are pending" guard (emergency valve only). |
| `pool_recon_tol_abs`, `pool_recon_tol_pct` | 0.5, 0.0005 | reconciliation tolerance |
| `pool_recon_strict` | `0` | `1` also blocks on a missing or old bot reading |
| `queued_money_location` | `spot` | where money waits before acceptance |

## How long will the manager wait for a flat account?

Every capital move needs a flat account (an existing rule, unchanged). From the backtest trades (`node flat-time-report.js` in BB-Core, SOL + ZEC, Jan 10, 2025 to Oct 21, 2026): flat on both coins **18.8%** of the time;
a random moment waits **4.8 days** (median), 15.3 days (90%), up to 36 days. Pausing new entries first (the existing kill switch) shortens that to about 2.7 days (median) and 8.3 days (worst), at the cost of roughly one missed entry.
So: collect joins and payouts, announce a cut-off, then pause entries and act at the first flat window, instead of acting on demand.

## Not covered here

- The bot's Exchange transfer history and realised P/L are still not sent (see `docs/accounting-model.md` section 7), so a transfer that was not recorded shows up as a reconciliation mismatch for the manager to explain.
- `admin_post_equity` (the manual valuation) and `admin_close_quarter` / `admin_settle_quarter` still value the pool at the typed balance without marking pending trades as applied. The reconciliation then
  flags the pending trades as double counted. Use Update Pool first.
- `bot_events` is not part of the ledger backup (it is the dashboard's event store; the bot re-sends it with `dashboard-backfill`). The four pool tables are.

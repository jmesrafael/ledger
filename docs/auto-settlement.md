# Automatic two-month settlement

Migration: `supabase/migrations/20261214000000_auto_settlement.sql` (rollback: `supabase/rollback/20261214000000_rollback_auto_settlement.sql`).
Tests: `tests/auto-settlement.test.mjs` (AS1 to AS7). Screen: `js/settleauto.js` (the Settle tab).

**Status (Nov 13 2026): written and rehearsed, NOT applied to the live database.** Applying it is the owner's step. It has never run on live.
The first automatic settlement would be on Jan 1 to 7, 2027.

## What it does

The fee on profit is taken by itself. The manager does not type anything.
It uses the same settlement rule the app already had (`admin_close_quarter_tv`). Only the trigger is new.

## When it runs

- A period is two months: Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec. Time zone: Manila.
- A period ends on Jan 1, Mar 1, May 1, Jul 1, Sep 1 and Nov 1.
- After a period ends, there is a **window of 7 days**.
- Inside the window, it runs at the **first verified MEXC wallet reading** that was measured **after** the period ended.
- The check runs after every wallet report (the bots send one every 5 minutes), right after the live price is made.

## The fee rule

Only profit is cut. Nothing else.

- value = the investor's units x the unit price
- mark (high-water mark) = what the investor put in, raised after every fee
- fee = the investor's rate x (value minus mark), **only when that number is positive**
- At or below the mark: no fee. The mark stays where it is.
- A new cash-in raises the mark by the same amount, so the investor's own money is never charged.
- The fee moves as **units** from the investor to the fund manager's account. The pool total and the unit price do not move.
- After the move, the investor's mark is set to their new value.

### Worked example

| Step | Number |
|---|---|
| Investor units | 500 |
| Unit price | 1.10 |
| Value (500 x 1.10) | 550 USDT |
| Mark | 500 USDT |
| Profit above the mark (550 - 500) | 50 USDT |
| Fee rate | 20% |
| Fee (20% x 50) | 10 USDT |
| Fee in units (10 / 1.10) | 9.0909 units move to the fund manager |
| Investor units after | 490.9091 (value 540 USDT) |
| New mark | 540 USDT |

The pool still has the same total units and the same price. Only the owner of 9.0909 units changed.

## The two settings

Both are in `ledger_settings`. The migration adds them with these defaults.

| Setting | Values | Meaning |
|---|---|---|
| `settlement_auto` | `on` (default) or `off` | `off`: nothing runs by itself. The manager can still press **Settle now** inside the window. |
| `settlement_auto_open_trades` | `allow` (default) or `wait` | `allow`: settle even when trades are open. The fee uses the true price (open profit counted once) and the mark moves to that price, so the same profit is never charged again when the trade closes. The run records the needed `open_positions` exception by itself. `wait`: settle only at a reading with no open trade. If none comes in the window, nothing is settled and the manager decides. |

The old settings stay as they are: `flow_pricing = true_value`, `settlement_schedule = bimonthly`, `settlement_recon = require`, `fee_timing = immediate`.

## What makes it wait

It does nothing (and saves nothing) when any of these is true:

| Reason | What you see |
|---|---|
| The price is **paused** (MEXC and the books disagree by more than max(0.50 USDT, 0.05%), or a wallet report is missing or suspect) | The Settle tab says the price is paused and shows the reason. |
| Open trades, and the rule is `wait` | It waits for a reading with no open position. |
| The only reading is from **before** the period ended | It waits for the next one. |
| `settlement_auto` is `off`, or `flow_pricing` is not `true_value` | Nothing runs by itself. |
| The window has closed | See the next section. |

A wait never loses the wallet report. Each reason is written once per day to the audit log as `settlement_auto_waiting`.
A settlement that is made is audited as `settlement_closed` plus `settlement_auto`.

## If the window is missed

A period whose 7 days passed without a settlement is **not** settled late.
Nothing is lost. The mark belongs to each investor, so the next settlement charges everything above it.
Example: the unsettled Sep-Oct 2026 period is covered by the settlement of Jan 1 to 7, 2027.

## The Settle screen (manager)

The Settle tab shows:

- where the calendar stands (settled, due now, missed, or no period ended yet), and the window dates;
- whether automatic settlement is on or off, and the open-trades rule;
- "If it were settled now": each investor's value, mark, profit above the mark and fee at the live price, and the total to the manager's account. Looking saves nothing;
- the last settlement (date, total fee, number of investors charged, automatic or by hand);
- a **Settle now** button, shown only when a period is due and the price is not paused. It is the fallback. It asks for confirmation and cannot be undone.

Before the migration is applied the tab says the automatic settlement is not on this database yet. Nothing is charged until it is.

## How to apply it and how to roll it back (owner steps)

Do not do these without the owner's decision.

1. Take a backup (`backup-ledger.cmd` or the manager's export).
2. Rehearse on a copy first: `node scripts/rehearse-migration.mjs <backup ledger.json>` (needs Docker). It must print PASS for every step.
3. Paste `supabase/migrations/20261214000000_auto_settlement.sql` into the Supabase SQL editor and run it. It is safe to run twice. It rewrites no ledger row and settles nothing when it runs.
4. Move the file into `supabase/migrations/applied/`.
5. Rollback: `supabase/rollback/20261214000000_rollback_auto_settlement.sql`. It puts back the earlier functions exactly and **keeps** any settlement already made (the audit trail is never dropped).

`20261215000000_retire_unused_functions.sql` needs this migration first (it refuses to run without it).

## Tests

`tests/auto-settlement.test.mjs`. Run with `npm test`.

| Test | What it proves |
|---|---|
| AS1 | The first verified reading after the period ends settles by itself: profit-only fee, moved as units to the fund manager, nothing else moves. |
| AS2 | Nothing happens before the period ends, after the window, or with `settlement_auto = off`. Settle now still works. |
| AS3 | An investor below their mark pays nothing. The settlement is still recorded and the mark stays. |
| AS4 | Open trades: `allow` settles at the true price and records the exception itself. `wait` waits for a flat reading. |
| AS5 | A paused price settles nothing, saves nothing, and is logged once. |
| AS6 | The Settle screen shows exactly what the settlement then charges. |
| AS7 | The migration runs twice. The rollback restores the earlier functions and keeps a settlement that was made. |

# Settlement controls and backups

Status: **implemented and tested, not applied to production.** Migration:
[`20261109000000_settlement_controls_backup.sql`](../supabase/migrations/20261109000000_settlement_controls_backup.sql). Tests:
[`tests/risk-fixes.test.mjs`](../tests/risk-fixes.test.mjs) (R1–R9). Restore tool: [`scripts/restore-ledger.mjs`](../scripts/restore-ledger.mjs).

No accounting formula changed: units, prices, the high-water mark, the 10% fee on external investors and Fund M's split are as in
`docs/hwm-settlement.md`. This migration changes **when** a settlement is allowed and **what is recorded**.

## What a settlement needs now

| Check | Rule | If it fails |
|---|---|---|
| Period | One settlement per two-month period (Jan–Feb, Mar–Apr, …), Manila time | refused: "already settled" / "no period has ended yet" |
| Window | Made within `settlement_window_days` (7) after the period ends | refused: `LATE`. Wait for the next window (it covers everything since the last settlement) or approve a `late` exception |
| Reconciliation | A verified bot snapshot, or the newest confirmed balance check for the same MEXC total | refused: `RECONCILE`. Approve an `unreconciled` exception |
| Open trades | No open position or order | refused: `OPEN TRADES`. Close them, or approve an `open_positions` exception |
| Mismatch / unmatched transfers | The ledger must agree with itself and every MEXC transfer must be matched | refused, and **no exception can override it** |

An exception (`admin_approve_settlement_exception`) needs a written reason of at least 20 characters, the MEXC total it is for, and (for
`unreconciled` and `open_positions`) the number of open positions and orders. It is written to the activity log, saved in
`settlement_exceptions` (append-only), used by one settlement only, and listed on that settlement (`settlements.exception_ids`).
The older `admin_attest_settlement` still exists but now needs the open-positions argument too.

Each settlement saves: the dates it covers (`covered_from`, `covered_to`), days after the period end, whether it was late, the balance
check used, the exceptions used, and the open positions at settlement. A direct insert of a close into `pool_equity` is refused.

## Backups

`_export_all()` now includes every ledger table, including `payout_details`, `idempotency_keys` and `settlement_exceptions`.
`admin_backup_coverage(token)` lists any table that is neither exported nor deliberately excluded
(`sessions`, `backup_keys`: secrets; `app_settings`, `backtest_runs`: the backtester). `tests/risk-fixes.test.mjs` R1 fails if a table is missed.

Passwords and the bot key are never in a backup.

### Restoring (staging only)

1. Create a **fresh** Supabase project and apply every migration (`supabase/migrations/applied/*` and the new one).
2. `node scripts/restore-ledger.mjs backups/<folder>/ledger.json restore.sql`
3. Run `restore.sql` in the SQL Editor. It refuses to run if the project already has ledger data, restores in one transaction, and checks
   every row count and the unit total against the backup before it commits.
4. Set a password for each person (the commented line at the end of the script), run `admin_integrity_report`, and compare each person's value.

## Not covered by code

- The typed MEXC total is the manager's input. An unrecorded transfer or fee inside it is still read as trading result until the bot sends
  transfer history and realized PnL.
- A valuation date can be backdated as far as the last entry; the settlement records both the valuation date and the day it was recorded.
- Anyone with database-owner access can bypass any control. Only access control can prevent that.
- Changing `settlement_recon` to `off`, or `schedule` to `free`, turns the window and reconciliation rules off (owner-only; the setting change is in the activity log).

## Rehearsal on a copy of the production data (2026-10-23)

`node scripts/rehearse-migration.mjs <backup ledger.json>` (or `npm run rehearse -- <file>`; needs Docker) builds a throwaway PostgreSQL 17 from
`supabase/migrations/applied/*`, restores the backup, applies every pending migration twice, and compares everything. Result on the production
backup (108 pool entries, 28 ledger rows, 3 investors): **13 of 13 checks passed**.

- The schema built from the applied migrations matches production: the same 166 functions (two differ only by SQL comments that the connector
  stripped), the same columns of every ledger table, the same 47 triggers. Production also has the backtester's two tables and two draft-archive
  tables (3 rows) that a fresh project does not; the restore skips the two archives with a notice.
- All 27 tables equal production row for row, to the last digit (24-digit marks included). This found a real defect in the first version of the
  restore script (it parsed numbers in JavaScript and rounded them to 17 digits); it is fixed, and tested (R2b).
- Units, price, equity, each investor's value and mark, the fund manager's capital and fee split, and the integrity report all agree with production.
- The migration changes no existing row; it adds one setting (`settlement_window_days`) and new tables and functions.

## Which workflows use the controls

| Path | Gate off (today) | Gate on |
|---|---|---|
| Settlement (any route) | window, reconciliation or exception, open-trades rule, one per period, duplicate replay | the same, **and** only through the Capital desk (the old form is refused) |
| Update equity (valuation only) | allowed, no balance check | allowed, no balance check (it moves no units) |
| Deposit admitted (Update equity joins it) | allowed with no balance check | refused; admit it in the Capital desk |
| Withdrawal, and withdrawal paid by the manager (old form) | allowed with no balance check | refused; request, approve, redeem in the Capital desk |
| Undo the newest entry | allowed (a logged correction; a close can never be undone) | allowed |
| Bot readings | valuation only (skipped while a deposit or withdrawal is open) | the same |
| Instant deposit function | not callable from the website | the same |
| Direct insert of a close into `pool_equity` | refused | refused |
| Direct insert of a deposit or withdrawal | possible for the database owner only | refused |

The window, the exceptions and the one-per-period rule live **inside** `admin_close_quarter`, so no older function or screen can skip them.
The screens do not know about the gate: with it on, the old Record forms stay visible and answer with "go through the Capital desk".

### Should `workflow_gate` be on?

Recommended **yes, as a second step** (not together with this migration):

1. With the gate off, a deposit or a withdrawal is priced from a number you type once, with no second look. With it on, the price comes from a
   balance you entered, explained and confirmed as separate steps, no older than 12 hours, with **no open trades**. A payout also has a
   record (sent, completed, failed) that is saved.
2. What changes every day: a deposit becomes confirm arrival, then enter and confirm the balance, then admit. A withdrawal becomes request,
   approve (with a written reason inside the lock-up), quote, execute, then record the payout. If a trade is open, capital movements wait until
   the pool is flat. For a bot that is often in a trade, a withdrawal can wait days. This is the main cost.
3. Before turning it on: hide the old Record forms when the gate is on (a small app change), practise the Capital desk on the rehearsal copy, and
   switch it back off with one setting if it blocks a payout you must make.

## Consequences of the window, missed periods and backdating

- **Valuation overhang.** A settlement is valued on the day it is made, up to 7 days after the period ends (about 11% of a 61-day period). The
  gain above the mark on that day is charged. This is timing only: the mark moves up, so the same gain is never charged twice.
- **First settlement.** The last close was 2026-09-30 23:59 Manila, inside the Sep–Oct period (it was made under the old quarterly rule). The
  Sep–Oct settlement can be made from 1 to 7 November and covers only the month since that close.
- **A missed window.** Nothing is skipped or charged twice; the next window covers everything since the last settlement. But the fee is on the
  gain above the mark **on the day of the settlement**, so if the price falls back before the next window the fee is smaller, or zero. Missing
  a window shifts that risk to the manager (test R10). A withdrawal in between settles its own share at the withdrawal.
- **A `late` exception.** It allows one late settlement for one period and one MEXC total, with a written reason and an activity-log entry.
- **Backdating.** The window is judged on the valuation date, and a valuation may be dated back as far as the last pool entry. If nothing was
  recorded since the window closed, a settlement made later could be dated inside it (test R10). It is not hidden: each settlement saves
  `backdated_days` (the valuation date against the day it was recorded). While readings keep being recorded (the bot, or Update equity every
  few days), the last entry moves forward and the backdating room shrinks to those few days. **Proposed, not implemented (your decision):**
  also compare the recording time against the window, with a one-day allowance, so a settlement recorded after the window needs the late exception.

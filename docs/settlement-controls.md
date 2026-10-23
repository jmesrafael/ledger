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

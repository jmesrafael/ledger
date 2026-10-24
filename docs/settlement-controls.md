# Settlement controls and backups

Status: **implemented and tested, not applied to production.** Migration:
[`20261109000000_settlement_controls_backup.sql`](../supabase/migrations/20261109000000_settlement_controls_backup.sql). Tests:
[`tests/risk-fixes.test.mjs`](../tests/risk-fixes.test.mjs) (R1–R12), [`tests/gate-ui.test.mjs`](../tests/gate-ui.test.mjs) (G1–G7). Restore tool: [`scripts/restore-ledger.mjs`](../scripts/restore-ledger.mjs).

No accounting formula changed: units, prices, the high-water mark, the 10% fee on external investors and Fund M's split are as in
`docs/hwm-settlement.md`. This migration changes **when** a settlement is allowed and **what is recorded**.

## What a settlement needs now

| Check | Rule | If it fails |
|---|---|---|
| Period | One settlement per two-month period (Jan–Feb, Mar–Apr, …), Manila time | refused: "already settled" / "no period has ended yet" |
| Window | Made within `settlement_window_days` (7) after the period ends, judged on the **later** of the valuation date and the real recording time | refused: `LATE`. Wait for the next window (it covers everything since the last settlement) or approve a `late` exception |
| No backdating | The valuation date is the moment of recording (a difference of up to `settlement_backdate_minutes`, 60, is clock skew) | refused: `BACKDATED`. Leave the date empty to record it now, or approve a `backdated` exception |
| Reconciliation | A verified bot snapshot, or the newest confirmed balance check for the same MEXC total | refused: `RECONCILE`. Approve an `unreconciled` exception |
| Open trades | No open position or order | refused: `OPEN TRADES`. Close them, or approve an `open_positions` exception |
| Mismatch / unmatched transfers | The ledger must agree with itself and every MEXC transfer must be matched | refused, and **no exception can override it** |

An exception (`admin_approve_settlement_exception`; kinds `unreconciled`, `late`, `backdated`, `open_positions`) needs a written reason of at least 20 characters, the MEXC total it is for, and (for
`unreconciled` and `open_positions`) the number of open positions and orders. It is written to the activity log, saved in
`settlement_exceptions` (append-only), used by one settlement only, and listed on that settlement (`settlements.exception_ids`).
The older `admin_attest_settlement` still exists but now needs the open-positions argument too.

Each settlement saves: the dates it covers (`covered_from`, `covered_to`), the date it carries (`valued_at`) **and the moment it was recorded (`recorded_at`)**,
days after the period end, whether it was late or backdated, the balance check used, the exceptions used, and the open positions at settlement.
Existing rows are never changed; a settlement that is both late and backdated needs both exceptions, because lateness is judged on the recording time. A direct insert of a close into `pool_equity` is refused.

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
- Anyone who can change the database clock or the settings can bypass the window; both are owner-only.
- Anyone with database-owner access can bypass any control. Only access control can prevent that.
- `settlement_recon = off` turns the reconciliation and open-trades rules off; `settlement_schedule = free` also turns the window and the backdating rule off (both owner-only; the setting change is in the activity log).

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
With the gate on, the screens show instructions instead of the old forms (`js/gate.js`, tests G1–G7): Money out and Settle explain the Capital tab steps and link to it, Balance steps aside only while deposits already in MEXC are waiting, and Money in loses its "already seen in MEXC" box because arrival is confirmed on the Capital tab with a note. Nobody meets an error message. The gate is **off** and was not enabled.

### Should `workflow_gate` be on?

Recommended **yes, as a second step** (not together with this migration):

1. With the gate off, a deposit or a withdrawal is priced from a number you type once, with no second look. With it on, the price comes from a
   balance you entered, explained and confirmed as separate steps, no older than 12 hours, with **no open trades**. A payout also has a
   record (sent, completed, failed) that is saved.
2. What changes every day: a deposit becomes confirm arrival, then enter and confirm the balance, then admit. A withdrawal becomes request,
   approve (with a written reason inside the lock-up), quote, execute, then record the payout. If a trade is open, capital movements wait until
   the pool is flat. For a bot that is often in a trade, a withdrawal can wait days. This is the main cost.
3. Before turning it on: practise the Capital tab on the rehearsal copy. It switches back off with one setting if it ever blocks a payout you must make.

## Consequences of the window, missed periods and backdating

- **Valuation overhang.** A settlement is valued on the day it is made, up to 7 days after the period ends (about 11% of a 61-day period). The
  gain above the mark on that day is charged. This is timing only: the mark moves up, so the same gain is never charged twice.
- **First settlement.** The last close was 2026-09-30 23:59 Manila, inside the Sep–Oct period (it was made under the old quarterly rule). The
  Sep–Oct settlement can be made from 1 to 7 November and covers only the month since that close.
- **A missed window.** Nothing is skipped or charged twice; the next window covers everything since the last settlement. But the fee is on the
  gain above the mark **on the day of the settlement**, so if the price falls back before the next window the fee is smaller, or zero. Missing
  a window shifts that risk to the manager (test R10). A withdrawal in between settles its own share at the withdrawal.
- **A `late` exception.** It allows one late settlement for one period and one MEXC total, with a written reason and an activity-log entry.
- **Backdating (fixed).** The window is judged on the later of the valuation date and the recording time, and a settlement dated more than
  60 minutes before it is recorded needs its own `backdated` exception. Before, a valuation could be dated back as far as the last pool entry, so a
  settlement made after the window closed could be dated inside it. Tests: R11 (normal, 30-minute skew, backdated inside the window, recorded after the
  window and dated inside it, honestly late, exceptions bound to their period and total, audit trail, immutable rows) and R9 (existing rows unchanged).

## Security finding: internal helpers were callable by anyone (found 2026-10-23)

Supabase gives every new function in the `public` schema to the website role (`anon`) and to signed-in users unless it is revoked. Four internal
helpers that take **no token** were left that way by earlier migrations: `_export_all()` (the **whole ledger export**: people without passwords,
every pool entry, ledger row, deposit, withdrawal request, settlement, balance check, payout record and the activity log), `_account_since`,
`_check_min_withdrawal` and `_exit_fee_rate`. `_export_all()` became exposed when 1106 renamed the old function and created a new one (a new function
starts with the default grants; the revoke list named the renamed one). The public key is in the page source of the app.

- Found by auditing the production privileges: 78 functions are callable by the website role; 73 check a token or key, `logout` is harmless by design, and 4 were these.
- The API logs for the last 24 hours (the most the tool can read, and a window that covers the whole life of 1106) show **no request** for `_export_all`.
  Older logs cannot be read, so earlier access cannot be excluded for the other three, which leak only a person's start date and fee rate.
- Fix: `supabase/hotfix/20261023_revoke_internal_helpers.sql` (four revokes, nothing else, safe twice) or migration 1109, which contains the same revokes.
  Test R12a proves the public role can read the export before the fix and cannot after, and that the manager's Backup button still works. The
  rehearsal builds the container with Supabase's default privileges, so a forgotten revoke shows up. **Not applied to production.**
- `supabase/verify/20261109000000_post_apply_checks.sql` fails if any function whose name starts with `_` can be called by `anon` or `authenticated`.

## Deploying: order, checks, rollback and recovery

Nothing below has been done on production. `node scripts/rehearse-migration.mjs <backup> --expect-snapshot <file>` runs all of it on a copy first.

**Order.** (1) Take a backup and the PART A snapshot. (2) Apply the migration. (3) Run the verification. (4) Deploy `js/app.js`, `js/gate.js`,
`js/position.js` and `login.html` (was `index.html`). The migration must go first, because the new app sends the exception calls. The old app keeps working until
then, but a settlement from it would be refused with an error instead of an approval prompt, so deploy both before the next window opens on 1 November.

**Before.** (a) Back up: the app's Backup, or `select public._export_all()::text` saved as `ledger.json`. (b) Run PART A of
`supabase/verify/20261109000000_post_apply_checks.sql` and keep the output. (c) Optional safety copy inside the database:
`create schema backup_pre1109; create table backup_pre1109.ledger as table public.ledger;` and the same for `pool_equity`, `investor_hwm`, `settlements`,
`pending_deposits`, `withdrawal_requests`, `ledger_settings`, `profiles` (an earlier copy exists in schema `backup_20261023`).

**Apply.** In the SQL editor paste the migration between `begin;` and `commit;`. The rehearsal proves that a run that fails half-way leaves nothing
behind (a failure was injected at the end) and that applying twice is harmless. The statements take only brief locks: `settlements` has no rows, and no
transaction had been open for more than a minute when checked. **Unverified on Supabase itself:** that its editor or API runs a pasted script as one
transaction. That is why the script is wrapped in `begin; … commit;`.

**After.** Run PART B (16 checks, every row must say PASS) and PART A again (the output must be identical to the one from before).

**Rollback (verified on the rehearsal copy, and by tests R12b).** `supabase/rollback/20261109000000_rollback_settlement_controls.sql` puts the four replaced
functions back to the text of 1107 and 1108, removes everything 1109 added, and keeps the helper revokes. Afterwards the functions, columns, triggers and
setting names are exactly what they were, and no balance, mark or unit moved. **It refuses once one settlement or exception has been recorded under
1109**, because dropping those columns would destroy the audit trail; after that, fix forward with a new migration. If migration 1110 (contact details)
is applied, roll it back first. Regenerate the script with `node scripts/build-rollback.mjs` if 1107 or 1108 ever change (they are applied and should not).

**Recovery from a state a rollback cannot fix.** There is no automatic backup on the free plan. Restore the saved `ledger.json` into a **new**
Supabase project (never over the old one): apply `supabase/migrations/applied/*`, run `node scripts/restore-ledger.mjs ledger.json restore.sql`, run
`restore.sql`, set passwords, run `admin_integrity_report`, compare with the PART A snapshot, then point the app at the new project (the URL and key in
the app's configuration). The restore was verified exactly (all 27 tables, to the last digit) against the real data.

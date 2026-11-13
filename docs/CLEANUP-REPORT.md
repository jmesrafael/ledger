# Ledger cleanup report

Date: 2026-11-13. Task: `FABLE-LEDGER-CLEANUP.md`, plus the owner's instruction during the work:
"automate everything; I only do create user / deposit / withdrawal / transfer; the two-month settlement must be automatic; only profit is cut and it goes to the manager's account".

People are named by profile id only. `2d02f784` = fund manager (admin). `d8a6e3f4` = investor, fee 20%. `e69ef028` = investor, fee 5%, no units.

## 1. Short version

| Item | Result |
|---|---|
| Live database | Read only. Nothing was written to it. |
| What is really live | Every migration file except two (admission spread, fee 20). The live NAV and the four steps (Add investor / Cash in / Withdraw / Transfer) ARE live since Nov 12. The task file said they were not. |
| Migrations folder | 46 live files are in `supabase/migrations/applied/`. A file left in `supabase/migrations/` now really means "not run". |
| App | Old by-hand screens are behind one flag, `LEGACY_SCREENS` (off). The four steps stay. New Settle tab for the automatic settlement. |
| Database (not applied) | Two new migrations, each with a rollback: `20261214` automatic settlement, `20261215` retire 45 unused functions. |
| Rehearsal | 43 of 43 checks pass on an exact copy of the live schema and data (local, see 5). The Supabase branch was not created (see 9). |
| Tests | `npm test`: 573 tests, 573 pass, 0 fail. |
| Website | Not published. No `git push`, no commit. |
| Needs you first | The live price is **paused right now** (risk 1). No cash-in, withdrawal, transfer or settlement can be priced until that is fixed. |

One thing I changed from the task file: it listed `js/desk.js` as a dead "Capital desk". It is the four-step desk, which is the flow you said you use. I kept it. The dead "Balance desk" is inside `js/app.js` and is hidden.

## 2. What was live (read from the database, Nov 13)

### Switches

| Setting | Live value |
|---|---|
| flow_pricing | true_value |
| auto_pool_mode | trades |
| nav_auto / nav_auto_admit | on / on |
| workflow_gate | off |
| bot_equity_sync | off |
| wallet_nav_mode | off |
| payout_cap_mode / settlement_preview_mode | off / off |
| fee_timing | immediate |
| settlement_schedule / settlement_recon | bimonthly (Manila) / require |
| default_fee_rate | 0.10 |

### Books

| Item | Value |
|---|---|
| Holders | `2d02f784` 342.74113334 units; `d8a6e3f4` 87.39141012 units, mark (H) 79.259410 USDT |
| Total units | 430.13254346 |
| Last pool entry | #29, Nov 10: book 379.372354 USDT, book price 0.88198942 |
| Last verified live price | 1.06734 (Nov 13 04:40 UTC, open trades included) |
| Ledger rows | 6 (5 deposits, 1 top-up transfer) |
| Closed trades booked | 17 (last one Nov 10) |
| Settlements ever | 0 |
| Cash-ins, withdrawals, transfers through the four steps | 0, 0, 0 |
| Deposits waiting / withdrawal requests open | 0 / 0 |

### Migrations: how I checked

I built the schema from the files and compared it with live, function by function (hash of each function's text).

| Check | Result |
|---|---|
| Functions on live | 305. Same 305 names from the files (without admission spread). |
| Identical text | 285 |
| Different text | 20. All are wording only: live says "MEXC", the files say "exchange" (the files were reworded after they ran); Windows line endings; one comment line. No logic differs. |
| Website role rights | Identical for all 305. |
| Triggers, views | Identical. |
| Tables | Live has two extra archive tables (`investor_perf_draft_archive`, `perf_log_draft_archive`) and three backup schemas (`backup_20261023`, `backup_pre1109`, `backup_20261113`). Not in the files. Harmless. |

| Migration | Live? |
|---|---|
| 46 files now in `applied/` (20261022 to 20261213) | Yes |
| `20261114000000_fee_20.sql` | No (default rate is 0.10). Owner decision N6. |
| `20261209000000_admission_spread.sql` | No (table absent). Owner decision N8. |
| `20261214000000_auto_settlement.sql` (new) | No. Owner step. |
| `20261215000000_retire_unused_functions.sql` (new) | No. Owner step. |

Supabase's own migration list shows only 10 entries with other names, because most files were pasted into the SQL editor. So that list cannot be trusted, and a Supabase branch built from it would not look like live.

## 3. What I changed, file by file

### Database files (nothing applied)

| File | What |
|---|---|
| `supabase/migrations/applied/*` | 27 files moved in with `git mv`. Content unchanged. |
| `supabase/migrations/20261214000000_auto_settlement.sql` | New. The automatic two-month settlement (section 4). |
| `supabase/rollback/20261214000000_rollback_auto_settlement.sql` | New. Puts back the two functions it changed, exactly. Keeps settlements already made. |
| `supabase/parts/auto-settlement/*`, `scripts/build-auto-settlement.mjs` | The migration is built from these, so the settlement core is the applied function's text with one line changed (who the actor is). |
| `supabase/migrations/20261215000000_retire_unused_functions.sql` | New. Takes away the website's right to call 45 functions. Drops nothing, changes no row. |
| `supabase/rollback/20261215000000_rollback_retire_unused_functions.sql` | New. Gives back exactly the rights each function had. |
| `scripts/rehearse-cleanup.mjs` | New. The rehearsal in section 5. |

### App

| File | What |
|---|---|
| `js/config.js` | `LEGACY_SCREENS: false`. |
| `js/app.js` | The flag. One guard in `call()`: with the flag off, a retired function is refused before anything is sent. Record shows only the four steps, Live NAV and History. Old links (Add money, Take money out, "deposits waiting") land on Cash in / Withdraw. Settle tab shows the automatic settlement. "Edit" on the last history entry is hidden (it reopened an old form); "Delete" stays. |
| `js/desk.js` | The "by hand" and "Balance" tabs are listed only with the flag on. |
| `js/settleauto.js` | New. Words the settlement status that the database returns. No maths in the browser. |
| `login.html` | Loads `js/settleauto.js`. |

### Tests

| File | What |
|---|---|
| `tests/auto-settlement.test.mjs` | New, AS1 to AS7. |
| `tests/retire.test.mjs` | New, RT1 to RT4. |
| `tests/desk.test.mjs` | DK1 now asks for the legacy tab list explicitly. |
| 20 test files, `tests/_tvworld.mjs`, `tests/_poolworld.mjs`, 2 scripts | Paths fixed after the move. They build the database from `applied/` + pending in file-name order, and leave the retirement out (other tests still exercise the old functions). No assertion was changed. |
| `package.json` | The two new test files added to `npm test`. |

### Docs

| File | What |
|---|---|
| `README.md` | Rewritten: current flow only. |
| `docs/auto-settlement.md` | New. |
| `docs/live-nav.md`, `docs/LEDGER-HOW-IT-WORKS-NOW.txt` | Corrected: live NAV is applied; update block added on top. |
| `docs/which-migrations-are-applied.sql` | Now checks the 5 migrations that matter. Still read-only. |
| `docs/archive/` | `SCENARIOS.md`, `pool-update.md`, `admission-spread.md`, `NEXT-STEPS-GUIDE.md`, with `README.md` saying what replaced each. |
| 7 kept docs | One note line on top: the by-hand screens they mention are retired, the rules still apply. |

## 4. What I hid or revoked, and why

### Hidden in the app (flag off)

| Screen | Why |
|---|---|
| Balance / Update equity form, Update Pool | A typed pool total is refused by the database under true-value pricing. |
| Manual Money out form with a typed balance | Same. |
| "They paid me directly" | `admin_units_from_manager` is refused under true-value pricing. Use Transfer. |
| Balance desk: confirm / reject balance, classify, adjust, escalate | Needs `workflow_gate = on`. It is off and was never used. |
| By-hand Money in (record, seen in MEXC, admit) and the peso top-up card | Works today, but Cash in does the same in one step. Two ways to enter the same money is how it gets entered twice. |
| By-hand approve / quote / redeem | Same: Withdraw does it in one step. |
| Admission spread card | Its table does not exist on live. |
| Typed-total settlement screen | Refused under true-value pricing. Replaced by the automatic settlement. |

Kept for the manager: Dashboard, Users, Record (Add investor, Cash in, Withdraw, Transfer, Live NAV, History), Settle, Reports, Log. Investor screens are unchanged.

### Revoked from the website role by `20261215` (45 functions)

| Group | Functions |
|---|---|
| A. Typed totals and book pricing (16) | `admin_post_equity`, `admin_withdraw`, `admin_withdraw_to_manager`, `admin_units_from_manager`, `admin_quote_units_from_manager`, `admin_quote_withdraw`, `admin_close_quarter`, `admin_settlement_preview`, `admin_settlement_preview_tv`, `admin_update_pool`, `admin_update_pool_and_admit`, `admin_pending_pnl`, `admin_pool_status`, `admin_attest_settlement`, `admin_attest_snapshot`, `admin_wallet_nav` |
| B. Workflow gate / Balance desk (20) | `admin_enter_balance`, `admin_confirm_balance`, `admin_reject_balance`, `admin_apply_balance`, `admin_add_adjustment`, `admin_classify_difference`, `admin_classify_pool_difference`, `admin_classify_transfer`, `admin_escalate`, `admin_balance_checks`, `admin_capital_queue`, `admin_capital_events`, `admin_admit_deposit`, `admin_execute_withdrawal`, `admin_quote_withdrawal`, `admin_quote_close`, `admin_settle_quarter`, `admin_confirm_arrival`, `admin_split_withdrawal_request`, `admin_withdrawal_queue` |
| C. By-hand true-value steps (9) | `admin_receive_deposit`, `admin_mark_arrived`, `admin_cancel_pending`, `admin_admit_deposit_tv`, `admin_admit_deposits_tv`, `admin_peso_topup`, `admin_quote_peso_topup`, `admin_approve_withdrawal`, `admin_execute_withdrawal_tv` |

Not touched: the four bot functions (all four bots still call them), every investor function, payouts (sent / completed / failed / retry), book corrections, undo, profiles, contacts, backups, audit log.

The migration refuses to run if: the four steps or the automatic settlement are missing, `flow_pricing` is not `true_value`, the workflow gate is on, a by-hand deposit is still waiting, or a request is approved by hand and not redeemed.

## 5. The automatic settlement and its rehearsal

### The rule (unchanged, only automated)

| Step | What happens |
|---|---|
| When | First verified MEXC reading after a period ends (Jan 1, Mar 1, May 1, Jul 1, Sep 1, Nov 1, Manila), inside 7 days. |
| Fee | Investor's rate x (their value - their mark H), only if positive. Profit only. A deposit raises H, so their own money is never charged. |
| Where it goes | As units, from the investor to the fund manager's account (`fee_out` / `fee_in`). Total units, pool value and unit price do not move. |
| After | H = value after the fee. The same profit is never charged twice. |
| Manager | Pays no fee. |
| It waits when | The price is paused; or trades are open and the rule is `wait`. It saves nothing and writes one audit line per reason per day. |
| Window missed | Not settled late. The next settlement covers it, because H is per investor. |

### Rehearsal on a copy of live (`scripts/rehearse-cleanup.mjs`): 43 of 43 checks pass

The copy is the live schema and data, dumped read-only, loaded into a throwaway local PostgreSQL 17.
A date cannot be in the future, so Jan 1, 2027 cannot be played. I used the real period that ended Nov 1, 2026 and was never settled (on the copy the window was widened so it counts as due today). Holders and books are exactly today's.

| Check | Result |
|---|---|
| Copy equals live: units sum = pool total, fee units net 0 | Pass |
| `20261214`: failed run leaves nothing; runs twice; no row changed; makes no settlement when applied; rollback restores every function exactly | Pass |
| `20261215`: failed run leaves nothing; runs twice; no row and no function body changed; 45 functions closed; website gets "permission denied"; rollback restores the exact rights | Pass |
| No internal helper function is open to the website | Pass |

| Run | Reading | Result |
|---|---|---|
| A. Profit, open trades allowed (default) | Book 379.372354 + 80 open = 459.372353, price 1.06797860 | Settled by the third wallet report, by itself. |
| B. Rule `wait`, trades open | Same | Waited, saved nothing. Settled at the first reading with no open trade. |
| C. Investor below the mark | Book only, price 0.88198942 | Settled, fee 0, no fee row, mark not moved. |
| D. Automatic off, "Settle now" | Same as A | Screen showed 2.814549; refused without a written exception (existing rule for a manual settlement with trades open); with it, charged 2.814549. |

Run A, line for `d8a6e3f4`:

| Figure | Value |
|---|---|
| Units before | 87.39141012 |
| Value at 1.06797860 | 93.332156 USDT |
| Mark H before | 79.259410 |
| Profit above the mark | 14.072746 |
| Fee (20%) | 2.814549 USDT = 2.63539851 units |
| Units after | 84.75601161 |
| Mark H after | 90.517607 (= 93.332156 - 2.814549) |
| `2d02f784` receives | 2.63539851 units |

After every run: units sum = pool total (difference 0.00000000), fee units net to 0, nobody negative, integrity report clean, book back to closed trades only.

Run C, same investor: value 77.078299, mark 79.259410, profit above mark 0, fee 0.

### The blockers the task asked about

| Item | Finding |
|---|---|
| N5 (true-value settlement never used live) | Rehearsed on the copy; works. No code bug blocked it. |
| N7 (open trades under `immediate`) | Needs a decision (decision 1). The bots almost always have open trades (14 positions today), so without `allow` the automatic run would rarely fire. |
| Unsettled Sep-Oct period | Not a problem. Run A covered from Oct 23 (pool start) in one settlement. |
| `settlement_recon = require` without transfer history (N1) | Does not block the true-value settlement: the verified wallet reports are the exchange evidence, and the ledger's own consistency check passed. |
| Open trades | See N7. |

## 6. Risks, ranked

| # | Risk | What it can do | State |
|---|---|---|---|
| 1 | **The live price is paused now.** MEXC shows 21.99 USDT more than books + open trades (tolerance 0.50). Between 04:40 and 04:45 UTC on Nov 13 the BB-Core wallet went from 5 open positions to 4 and its open P&L fell by about 24.6 while its equity stayed the same. So a BB-Core trade closed with about +22 and **was never booked**. The last booked trade is Nov 10. | Blocks every cash-in, withdrawal, transfer and settlement until booked. Could block a payout. | Not fixed (bot side, VPS). Look at BB-Core's `ledger-sync.js` log for that close. ARB joined BB-Core on Nov 12, so check that coin first. |
| 2 | The four steps have never moved real money on live. | A bug there would show on the first real cash-in or payout. | Tested (LN1 to LN12, RT1). Do one small real cash-in and one withdrawal before applying `20261215`. Until then the by-hand functions still work as a fallback. |
| 3 | Fee on open trades (N7). With `allow`, the fee is taken on profit that is not closed yet. Under `immediate` it is not given back if the trade later loses. | An investor could pay on a gain that disappears. | Owner decision 1. `wait` avoids it but may miss windows. `fee_timing = confirmed` is the built answer; it needs new investor terms. |
| 4 | Money sent to or from MEXC and not entered (N1). | A gap above 0.50 pauses the price (safe). A gap below 0.50 is taken into the book at the next money step and is shared by everyone. | Unchanged. You said you match MEXC by hand. |
| 5 | Price paused for the whole 7-day window. | That settlement is skipped; fees wait two months. Nothing is lost unless the price then falls. | By design. The Settle tab shows why it waits. |
| 6 | Manual "Settle now" with trades open needs a written exception for that exact exchange total. The total moves every 5 minutes. | Hard to use by hand. | The automatic run writes its own exception in the same step. |
| 7 | Order of going live. | New website before `20261214`: Settle tab says "not on this database yet" (harmless). `20261215` before the new website: the old site's by-hand screens show "permission denied". | Use the order in section 8. |
| 8 | `default_fee_rate` is 0.10, but the Add investor form pre-fills 20%. Profile `e69ef028` has 5% and no units. | A new investor could get a rate you did not mean. | Owner decision 3 (N6). |
| 9 | 20 live functions differ from the files in wording. | A rollback built from the files would put back "exchange" where live says "MEXC". Text only. | Noted. |
| 10 | Three backup schemas and two archive tables on live hold copies of people's data. | Privacy, not accounting. | Owner decision 6. |

Checked and found clean: no unit mismatch, no negative holder, no double-counted trade, no unmatched bot exit, fee units net to zero.

## 7. Test results

| Run | Result |
|---|---|
| `npm test` (final) | 573 tests, 573 pass, 0 fail |
| `tests/auto-settlement.test.mjs` | 7 of 7 |
| `tests/retire.test.mjs` | 4 of 4 |
| `scripts/rehearse-cleanup.mjs` on the copy of live | 43 of 43 |

Not done: I did not open the changed screens in a browser (`scripts/ui-smoke` was not run). The screens are covered by the HTML tests only. Look at Record and Settle once before publishing.

One earlier full run showed 11 failures in `tests/hwm-settlement.test.mjs`. Cause: two edits to that file collided while the run was going. The file was repaired and the final run is clean.

## 8. Owner only (not done)

Suggested order:

| Step | What |
|---|---|
| 1 | Fix risk 1 (book the missed BB-Core trade) so the price is live again. |
| 2 | Run `supabase/migrations/20261214000000_auto_settlement.sql` on live. It makes no settlement when run (today's state is "missed" for Sep-Oct). The first automatic one is Jan 1, 2027. |
| 3 | Publish the website. |
| 4 | Do one small real cash-in and one withdrawal through the four steps. |
| 5 | Run `supabase/migrations/20261215000000_retire_unused_functions.sql` on live. |

Decisions:

| # | Decision | Options |
|---|---|---|
| 1 | Open trades at the automatic settlement (N7) | `allow` (default in the file: settles on time, charges unrealised profit once) or `wait` (only realised books, may miss a window). |
| 2 | Automatic settlement on or off | The file sets `settlement_auto = on`. Set it `off` to press Settle now yourself. |
| 3 | Default fee rate (N6) | Run `fee_20.sql`, or keep 0.10 and change the form's 20%. |
| 4 | Retire group C (by-hand true-value steps) now or later | Later is safer until step 4 above is done. |
| 5 | Admission spread (N8) and legal (N9) | Unchanged. |
| 6 | Old backup schemas and archive tables on live | Keep or remove. |
| 7 | Any settlement on the live database | Yours. |

## 9. What could not be done as written

| Asked | What happened |
|---|---|
| Rehearse on a Supabase branch | Creating the branch was declined at the cost confirmation, so I did not create one. Also, a branch is built from Supabase's migration list (10 entries), so it would not have matched live. I rehearsed on a local copy made from a read-only dump of live instead. The dump was deleted afterwards. |
| Use `scripts/rehearse-migration.mjs` | It needs the app's backup file (a backup key) and its verification step is written for one older migration. I wrote `scripts/rehearse-cleanup.mjs` with the same kinds of checks. |
| Rehearse Jan 1-7, 2027 | Dates cannot be in the future. I settled the real unsettled Sep-Oct period on the copy. The code path is the same. |
| "Every" function no longer used | Read-only functions that still back History, the Log or backups were kept. |

# High-water mark, loss carry-forward and the two-month settlement (`investor_hwm_v2`)

Status: **live in production** (2026-10-23). The high-water mark is `20261105000000_hwm_arrival_lockup.sql` (stored in `investor_hwm`,
undo via `hwm_log`). The two-month settlement is `20261107000000_hwm_bimonthly_settlement.sql`. `20261108000000_settlement_workflow_integration.sql`
makes a confirmed manual balance check count as verification, saves each period's results, and restores the complete backup export. All three are in
`supabase/migrations/applied/`. `20261109000000_settlement_controls_backup.sql` (settlement window, audited exceptions, complete backups) is
**pending, rehearsed on a restored copy of the production data, and not applied**; see [settlement-controls.md](settlement-controls.md).
Tests: `tests/hwm-settlement.test.mjs`, `tests/settlement-workflow.test.mjs`, `tests/risk-fixes.test.mjs` (full migration chain), and
`node scripts/rehearse-migration.mjs <backup>` for the rehearsal on your own data. The open business decisions are in section 9; settings
flagged **(confirm)** are defaults chosen so the code runs, not decisions.

## 1. What was wrong with the engine it replaces (`flat_period_v1`)

| # | Finding | Effect |
|---|---|---|
| 1 | No high-water mark, no loss carry-forward (doc section 3, tests B3/B4 assert it) | A period that only recovers an earlier loss is charged 10% in full. An investor at −20% since joining pays fees on the rebound. |
| 2 | Settlement every quarter, at least 80 days apart | The agreed schedule is every two months; 80 days also makes a two-month schedule impossible. |
| 3 | A settlement needs no reconciliation (`settlement_gate` defaults to `off`) | Fees can be finalized on a NAV that nobody has reconciled against MEXC. |
| 4 | Fund M capital vs fee units are split by ledger `kind` | A manager withdrawal is always taken from "capital", which can go negative while fee units stay untouched. |
| 5 | Settlements leave no per-investor record | A fee cannot be re-derived later without replaying the whole ledger by hand. |

Unit accounting (NAV, price, issue, redeem, forward-priced pending deposits, the books check, idempotency, the single writer lock) was
checked and is kept unchanged. Section 2 restates it because the HWM depends on it.

## 2. Unit accounting (unchanged, restated)

```
NAV                = MEXC total − deposits still waiting to be admitted   (waiting money is a liability, not pool equity)
unit price P       = NAV ÷ U          U = every outstanding unit, Fund M's included
admit deposit D    units = round8(D ÷ P) at the next valuation; P unchanged
redeem n units     pay = round6((n − fee units) × P); P unchanged
fee                units move investor → Fund M; NAV, U and P unchanged
trading            changes NAV and so P; never anyone's units
```

So for each investor `value E = units × P` changes through trading (units × ΔP) and through capital movements made at an unchanged P.
Deposits and withdrawals can therefore never show up as profit or loss.

## 3. The HWM algorithm: an investor-level loss-carry-forward account in USDT

Each investor has one benchmark **H** (USDT), stored in `investor_hwm.hwm_value` and changed only by `_hwm_deposit`, `_hwm_take` and `_hwm_close`.
Every change is logged in `hwm_log`, so undoing the newest entry restores H exactly. The investor summary shows it as `hwm_value`, the
shortfall as `below_hwm_usdt`, and `E − H` as `period_profit_usdt`. Fund M has no mark: its own capital is never charged under `external_investors`.

| Event (at price P) | Rule | Why |
|---|---|---|
| Deposit admitted, D USDT | `H += D` | Contributed capital is never profit. An existing shortfall `H − E` is kept as it is. |
| Settlement | `fee = r × max(0, E − H)` ; `H := max(H, E − fee)` | Fee only above the mark. The mark moves up to the value after the fee and never moves down, so a recovered loss is never charged. |
| Withdrawal of share `s = gross units ÷ units held`, in profit (E > H) | `fee = r × s × (E − H)` ; `H := H × (1 − s)` | The redeemed share's profit is crystallized now. The units that stay keep their own `(1 − s)` share of the uncharged profit. |
| Withdrawal, at or below the mark (E ≤ H) | no fee ; `H := H − s × E` | The **whole** shortfall `H − E` stays with the investor. Withdrawing cannot be used to escape a loss. |
| Full exit (s = 1) | as above: in profit `H := 0`; in a loss `H := shortfall L` | The shortfall is always carried to a later re-entry: `H = L + D`. |

**Properties (each has a test):**

- *Path independence for capital flows.* Withdraw-and-redeposit, splitting a deposit, or adding money just before a settlement leaves
  `E − H` exactly where it was. The only thing that moves `E − H` is `units × ΔP`, which is the investor's own trading result.
- *No inheritance.* H is per investor. A newcomer's H is their own deposit, so they cannot inherit another investor's gain or loss. Pending
  deposits hold no units and earn nothing until a valuation admits them.
- *Different entry dates* need no special handling: each investor's mark starts at their own admission value.
- *Total fee over a life* is `r × (final value + withdrawals − deposits − fees already paid back into H)`: 10% of the net profit above the
  best previous post-fee level, never more.

**Rejected alternatives.**
- Per-deposit lots (the 2026-10-27 engine): an old lot's loss does not shelter a new lot's gain, so an investor who is down overall can still pay a fee.
- A ratio-based carry (the earlier `investor_hwm_v1` draft): it carried the *percentage* loss into a re-deposit, so re-entering with 100× the money multiplied the shelter 100×.
- Unit-series or equalization accounting: it is exact, but it needs a separate class of units per entry date. That is disproportionate for a friends-and-family pool with one NAV.

**Known trade-off (confirm).** The carry-forward is an absolute USDT amount, so a large top-up recovers an old shortfall faster. The shelter
can never exceed the loss the investor actually suffered. The manager forgoes at most `r × shortfall`.

## 4. Two-month settlement

**Periods.** Calendar periods of `settlement_period_months` (2) months, starting from `settlement_anchor` (2026-01-01) in `settlement_tz`
(Asia/Manila): Jan–Feb, Mar–Apr, May–Jun, Jul–Aug, Sep–Oct, Nov–Dec. Each boundary is 00:00 Manila on the 1st (**confirm**).

**Cut-off rules.**
1. The settlement for the period ending at boundary B is made with a valuation dated T ≥ B. It is refused before B, and refused again once
   a settlement dated ≥ B exists (one per period; also a unique index on `settlements.period_end`). **Window (1109):** the later of T and the real recording time must be before
   B + `settlement_window_days` (7). After that the settlement is *late* and is refused unless a `late` exception was approved
   (`admin_approve_settlement_exception`, written reason, activity log). **No backdating:** a settlement dated more than `settlement_backdate_minutes` (60) before
   the moment it is recorded is refused unless a `backdated` exception was approved; a settlement that is both needs both. A missed window is not lost: the next window's settlement covers
   everything since the last one.
2. A capital movement belongs to the period of its **pool entry** (admission or payment), not the day the money was received or requested.
3. Deposits still waiting at the settlement are admitted after the fees, at the settlement price, so they never pay for or share in the period being settled.
4. A withdrawal request not yet paid keeps its units, and those units are settled. It is paid later at the price on the day it is paid.
5. Entries dated between B and T are settled with the period. The settlement record counts them (`entries_after_period_end`).
6. If a period is missed, the next settlement covers everything since the last one. The HWM makes this harmless, because fees depend on
   the mark, not on the period.

**Order inside the one transaction** (single writer lock, idempotency key): period checks → MEXC gate (if on) → valuation sanity check →
settlement entry written at P → **reconciliation** → per-investor fees (`_hwm_close` on the stored mark) → `settlement_lines` → Fund M split →
`settlements` row → scheduled fee-rate rises take effect → waiting deposits admitted at P → books check.

**Reconciliation (`_settlement_recon`).** For the period since the last settlement:

```
opening NAV + deposits admitted − withdrawals paid + trading P&L = closing NAV          (ledger identity; defines trading P&L)
trading P&L  ==  Σ over entries of (units outstanding before the entry × its price move)  (independent recomputation)
MEXC total   =  closing NAV + deposits waiting (liability)
```

| Status | Meaning | Settlement |
|---|---|---|
| `internal_mismatch` | The two trading-P&L figures differ by more than `recon_internal_tolerance` (0.01 USDT): some entry's equity does not follow from its flows | **always refused** (`settlement_recon` ≠ `off`) |
| `unmatched_transfers` | A MEXC transfer is not matched to a deposit or withdrawal, so part of the balance change is unexplained | **always refused** (`settlement_recon` ≠ `off`) |
| `unverified` | No fresh, clean MEXC snapshot that agrees with the typed total | allowed only with (a) the newest **confirmed balance check** for the same total (`verified_manual`, 1108), or (b) an approved `unreconciled` exception for this period and total: written reason, open positions declared, activity log (1109) |
| `verified` | All of the above agree | allowed |

**Open trades (1109).** If any position or order is open (balance check, bot snapshot, or the declaration in the exception), the settlement is
refused unless an `open_positions` exception was approved. This is what stops a fee being charged on a paper gain that later reverses.
Each exception is used by one settlement only and is saved on it (`settlements.exception_ids`).

Realized vs unrealized P&L, trading fees and funding are **inside** the MEXC total. The bot does not report them yet (section 8). With
`settlement_gate = 'on'` a settlement additionally needs the pool to be flat, which makes the fee realized-only.

**Profit left on MEXC** is booked internally as unit transfers (`fee_out` / `fee_in`). It never creates a deposit, a pending deposit or a transfer match.

## 5. Fund M: own capital vs performance-fee entitlement

Fund M's units are split by replay (`_fund_m_state`) into a **capital** account (its own deposits, including withdrawals it paid out of
pocket) and a **fee entitlement** account (every `fee_in`). Fund M's own withdrawals are split by `fund_m_withdrawal_order`
(`pro_rata` default, **confirm**; or `fee_first` / `capital_first`). `pool_summary.admin_capital_units` / `admin_fee_units` now come from
this split, so they always add up to Fund M's units and neither can go negative.

**Fee basis (`fee_basis`, confirm).**
- `external_investors` (default; same as today): only investors' eligible profit is charged. Fund M's own capital pays nothing.
- `all_pool`: in addition, Fund M's own capital is measured against its own HWM. 10% (`fund_m_own_fee_rate`) of its eligible profit is
  **reclassified** from Fund M capital to Fund M fee entitlement. No units move between people, and **investors pay exactly the same under
  both settings**. The setting never charges investors for profit earned on Fund M's money. If "10% of all pool profit" was meant to come
  out of investors' accounts, that rule is unfair to investors and is deliberately not implemented.

## 6. Interface for Agent 2 (UI, MEXC balance entry, queues)

All functions take the session token first, like the existing RPCs. Unchanged signatures are marked =.

| Function | Use |
|---|---|
| `admin_settlement_preview(token, mexc_total, at default now)` → jsonb | **Read-only.** Period start/end, `can_settle` + `blocked_reasons[]`, reconciliation (opening NAV, deposits, withdrawals, trading P&L both ways, waiting-deposit liability, snapshot evidence, status), per-investor lines (units, value, hwm, eligible profit, fee USDT/units), fee totals, Fund M split, waiting deposits that will be admitted after. Show this before the manager confirms. |
| `admin_approve_settlement_exception(token, kind, mexc_total, note ≥ 20 chars, at default now, open positions)` → jsonb (1109) | Approves an exception: `kind` is `unreconciled`, `late`, `backdated` or `open_positions`. Bound to the period and the MEXC total (± tolerance), used by one settlement, audited, append-only. An internal mismatch or an unmatched MEXC transfer cannot be excepted. |
| `admin_attest_settlement(token, mexc_total, note, at, open positions)` | The older name for an `unreconciled` exception. From 1109 it also needs the open-positions argument; without it the call is refused. |
| `admin_backup_coverage(token)` → jsonb (1109) | Lists any ledger table that is neither in the backup nor deliberately excluded. Must be `[]`. |
| `admin_close_quarter(token, equity, php_rate, note, at, idem, confirm)` = | Performs the settlement. It returns the old fields plus `settlement_id`, `period_start`, `period_end`, `fee_usdt`, `recon_status`. The name is kept so the app keeps working; it now settles the **two-month period**. |
| `admin_settlements(token)` → jsonb | Every settlement with its lines (statement and audit view). |
| `my_settlements(token)` → jsonb | The caller's own settlement lines (investor view; no pool size). |
| `fund_manager_accounts(token)` → jsonb | Fund M capital vs fee entitlement: units, value, contributed, withdrawn, profit, fees earned. |
| `_holder_summary` fields (via `me` / `admin_overview`) | New: `hwm_usdt`, `eligible_profit_usdt` (E − H, can be negative), `loss_carryforward_usdt`. Kept: `hwm`, `lots` (= `[[units, H ÷ units]]`), so the app's `lotFee` / `lotGain` previews compute the new rule unchanged, plus `accrued_fee_usdt` (= r × max(0, E − H)) and `period_profit_usdt` (now = E − H). |
| `admin_withdraw`, `admin_withdraw_to_manager`, deposits, undo | = signatures. The fee at a withdrawal now follows section 3. |

Errors the UI should expect from `admin_close_quarter`: `the period ending … is already settled; the next settlement is allowed from …`,
`no settlement period has ended yet`, `LATE: …` (needs a late exception, or wait for the next window), `BACKDATED: …` (record it now, or approve a backdated exception), `RECONCILE: …` (needs a confirmed balance
check or an `unreconciled` exception), `OPEN TRADES: …` (close the trades or approve an `open_positions` exception), `settlement refused: …`
(needs a fix; no exception can override it). The app (`withSettlementExceptions` in `js/app.js`, used by the old form and by the Capital tab) turns `LATE`, `BACKDATED`, `RECONCILE` and `OPEN TRADES` into an approval prompt.

**Wording the UI must change (Agent 2):** "quarter" becomes "two-month period". The investor terms (section "The fee") and
`reports/how-lucid-io-works.html` currently say *"the loss is not carried forward"*. Under this engine the loss **is** carried forward. The
terms version must be bumped so every investor agrees again (`terms_acceptances`).

## 7. Settings (all in `ledger_settings`)

| Key | Default | Values |
|---|---|---|
| `fee_engine` | `investor_hwm_v2` | marker only |
| `fee_basis` | `external_investors` | `external_investors`, `all_pool` |
| `settlement_schedule` | `bimonthly` | `bimonthly`, `free` (tests / emergencies only) |
| `settlement_period_months` / `settlement_anchor` / `settlement_tz` | `2` / `2026-01-01` / `Asia/Manila` | |
| `settlement_window_days` (1109) | `7` | days after a period ends in which its settlement is on time (judged on the recording time) |
| `settlement_backdate_minutes` (1109) | `60` | how far before the moment of recording a settlement may be dated without a `backdated` exception (clock skew) |
| `settlement_recon` | `require` | `require`, `warn`, `off` (owner-only; `off` also turns the exception checks off) |
| `workflow_gate` | `off` | `on` = deposits, withdrawals and settlements only through the Capital desk (see settlement-controls.md) |
| `lock_enforced` | `0` | `1` = the old lock-up refusal; `0` = lock-up is wording only |
| `recon_internal_tolerance` | `0.01` | USDT |
| `fund_m_withdrawal_order` | `pro_rata` | `pro_rata`, `fee_first`, `capital_first` |
| `fund_m_own_fee_rate` | = `default_fee_rate` | used only with `all_pool` |
| `min_days_between_closes` | set to `0` if it was `80` | superseded by the period rule |

## 8. Cutover and rollout

- **No data is rewritten.** The migration adds tables and functions, replaces function bodies, and changes settings. Every existing ledger row and settlement stays as it is.
- **Opening marks (done).** 1105 seeded each investor's mark from where the last quarter close left them. A copy of the tables from before
  the change is in schema `backup_20261023`.
- **Applied 2026-10-23:** 1105, 1106, 1107, then 1108 (approved by the user). The live checks afterwards: units diff 0, every holder has a mark.
  Note: at that point the backup export did not yet include `payout_details`, `idempotency_keys`, `holder_state` or the settlement exceptions;
  1109 adds them (`_export_extra`) and `admin_backup_coverage` proves nothing is missing.
- **Rehearsal (2026-10-23, before 1109).** A production backup was restored with `scripts/restore-ledger.mjs` into a throwaway PostgreSQL 17,
  built from `applied/*`: all 27 tables equal production row for row (fingerprints), units and the books tie out, 1109 applies and re-applies
  with no existing row changed, the integrity report is clean. Repeat it on a fresh backup right before any production change.
- Not yet available from the bot: transfer history, realized P&L, trading fees and funding. Until then a settlement needs the manager's
  confirmed balance check (1108) or a written attestation.

## 9. Open business decisions

1. **Fee basis**: external investors only (default) or also Fund M's own capital (internal reclassification only)?
2. **Withdrawal crystallization**: the default charges the redeemed share's profit at the withdrawal (`s × r × (E − H)`). The alternative
   is to crystallize the whole account's profit at any withdrawal. Confirm.
3. *(decided by 1105)* The shortfall is always kept after a full exit; it does not expire.
4. *(decided by 1105)* Opening marks were seeded from the last quarter close.
5. *(decided: 7 days)* **Period grid**: Jan–Feb… in Manila time, with a 7-day window after each period ends; later settlements are logged late exceptions.
6. **Fund M withdrawals**: are they taken pro rata, from fees first, or from capital first?
7. **Absolute-USDT carry-forward**: accept that a top-up recovers an old shortfall faster?
8. **Fee on a 0% rate period**: the mark resets to the post-period value when no fee is charged because the rate is 0. Gains made at 0% are never charged later.

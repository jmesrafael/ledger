# PHP contributions: pesos paid, USDT received, and the reference rate

Status: implemented and tested locally on 2026-11-07. Not deployed and not committed. The migration is NOT applied to production; deployment steps are in section 8.
Code: `js/contribution.js`, with display changes in `js/app.js`, `js/returns.js` and `js/position.js`.
Database: `supabase/migrations/20261208000000_fx_reference_rate.sql`, rollback `supabase/rollback/20261208000000_rollback_fx_reference_rate.sql`. It adds the reference-rate readings and changes only the ₱500 check and the default rate on new entries. No existing row is touched.
Tests:
- `tests/contribution.test.mjs` (CB1–CB16);
- `tests/withdraw-denomination.test.mjs` (WD1–WD5);
- `tests/fx-reference.test.mjs` (FX1–FX7);
- updated: `tests/statements.test.mjs`, `tests/activity-rows.test.mjs`, `tests/withdrawal-fee.test.mjs` and `tests/pool-update.test.mjs`.

## The rule in one line

**Units are bought only with the USDT actually received**: `units = USDT received / the unit price the database approved when the money joined`.

Pesos and peso rates are kept and shown, but they never reach any of these:
- units or ownership;
- the pool value, NAV or unit price;
- P&L;
- fees, withdrawals or settlements.

## 1. Recording a peso contribution (Record → Money in)

The manager types two amounts, both taken from what really happened:

| Field | What to enter | Stored as |
|---|---|---|
| Pesos paid | the pesos the investor handed over, e.g. 5000 | `php_amount` |
| USDT actually received | what the exchange shows arrived for those pesos, e.g. 66.40 | `usdt`; only this buys units |

- **The effective rate is worked out, never typed.** It is `pesos paid / USDT received`, to 8 decimals (₱5,000 / 66.40 = 75.30120482), and is stored as `php_rate` on that deposit.
- **Typo check.** If the effective rate is less than half or more than double today's reference rate, the preview warns "Check the numbers". With no reference rate, it warns outside ₱20–₱200. It never blocks: the real cost of converting pesos is often well above the market rate (James paid ₱75.30 per USDT when the market was about ₱63).
- **Incomplete or invalid entries.** These are refused before anything is sent: missing pesos, missing USDT, zero or negative USDT, or letters typed into a number field.
- **USDT-only deposits.** With the currency set to USDT, the amount is the USDT received. No pesos are recorded. The ₱ figure in the preview is labelled "at today's rate, no pesos recorded".
- **No database change.** The form calls the existing `admin_receive_deposit(p_usdt, p_php_rate, p_php_amount, …)` exactly as before. Admission (book or true value) then buys units from `usdt` alone. Test CB12 shows that the same 66.40 USDT recorded with ₱5,000, ₱664 or no pesos gives identical units, unit price, pool value and other investors' units.

## 2. What the investor sees ("Your contribution" card)

The card is on the investor's home screen. The same card ("My contribution") is on the manager's My account. The same lines, minus units and value, are on the manager's investor sheet.

| Line | Calculation | James (live records) |
|---|---|---|
| Original PHP contribution | Σ `php_amount` of the deposits that have one | ₱5,000.00 |
| Actual USDT received | Σ `usdt` of those deposits | 66.40 USDT |
| Effective conversion rate | total pesos / total USDT | ₱75.30 per USDT |
| Current PHP/USD reference rate | the live reference rate (section 4) | e.g. ₱63.11 per USD, with source and time |
| Current USD equivalent of the pesos paid | total pesos / reference rate | 79.23 USD, **reference only** |
| Investment units owned | from the database | 73.31635568 |
| Current investment value | units × today's unit price, from the database | ≈ 64.37 USDT at 0.87795 |

**Several peso deposits.** The rate is weighted: total pesos / total USDT, never an average of the individual rates. For example, ₱5,000 for 66.40 plus ₱10,000 for 170.00 is ₱15,000 / 236.40 = ₱63.45. The plain average would be ₱67.06.

**Currency equivalent vs. investment value.** The USD equivalent answers "what would my pesos buy today?". It is labelled "reference only … It is not a balance and does not change any units". It sits above the units and value, apart from them. The investment value is the only figure that says what the holding is worth.

**Deposits and payouts that were undone.** A deposit undone with "Edit" (its negative twin) counts nowhere. It is matched by `reversed_of`, or by the exact negative where the investor's own rows don't carry that field. A payout that was undone cancels out.

## 3. USDT-only and older deposits

Raf's deposits #1 (52.3082) and #2 (200) were entered in USDT. They have no `php_amount`.

- **They are not peso contributions.** They are listed as "Put in directly in USDT" and are never turned into pesos.
- **Stored rates on such rows are ignored.** Those rows do carry a `php_rate` (63.53, 64.01), but that's the market rate the manager typed then, not a cash-in rate.
- **"Put in" is shown in pesos only when every peso of it was really paid.** That means peso deposits only, with nothing taken out. Otherwise it's shown in USDT. James: ₱5,000. Raf: 343.94 USDT, with "₱6,897 of it paid in pesos" beside it.
- **"Where your money stands" stays in USDT.** All its rows are in USDT, so they add up (put in − taken out + result − fees = value). The pesos really paid are noted next to the USDT they bought.
- **Recent transactions.** A deposit or payout with no recorded pesos is shown in USDT, with "≈ ₱… today" as an estimate.
- **Statements and CSV.** "Pesos paid in / out" count only recorded `php_amount`.
- **Removed.** The old estimator (`Returns.pesos`: USDT × stored rate) and the "Peso exchange rate" line are gone. They produced figures like the ₱4,061 / ₱4,191 "put in" for James, which contradicted the ₱5,000 he paid.

## 4. The PHP/USD reference rate

**Where it comes from.**
- Sources: open.er-api.com, falling back to frankfurter.dev. Both are fetched by the browser.
- USDT is treated as 1 USD.
- The rate is labelled "PHP/USD reference" and shown with its source and the time it was loaded.

**How it is classified.**

| Reading | Result |
|---|---|
| Loaded less than 1 hour ago | used, shown as "live" |
| Cached 1–12 hours ago, both sources failing now | used, shown as "last loaded …" |
| Older than 12 hours | **Rate unavailable** |
| Dated in the future (more than a minute; clock wrong) | **Rate unavailable** |
| Outside ₱20–₱200, not a number, or a broken response (e.g. an HTML error page) | **Rate unavailable** |
| No time or no source (the shape of a rate stored on a deposit or pool entry) | **Rate unavailable** |

**What happens when the rate is unavailable.**
- Figures stay in USDT, and the ₱/$ switch is hidden.
- The card shows "Rate unavailable" for the reference rate and the USD equivalent.
- The effective cash-in rate is still shown, because it's history.
- Nothing falls back to a rate stored on a pool entry, a deposit or a profile. The old fallback is gone: it would have shown ₱75.27, a cash-in rate, as "today's rate".

**What uses it.**
- Display: the peso view, the ₱ estimates, and the USD equivalent of pesos paid.
- The manager's forms: it pre-fills their reference-rate field, labelled "Current PHP/USD reference rate (₱ per USD: peso display and the ₱500 minimum only, never a cash-in rate)", and a note on Money out and Balance says so.
- The database: when the fund manager's browser has a fresh live reading (under an hour old), it stores it in the database (section 6). That stored reading is the one the ₱500 minimum is checked at.

Cash-in rates (pesos ÷ USDT of a deposit) appear only on deposits and contribution lines, labelled "Effective cash-in rate … not today's reference rate".

## 5. Withdrawals are in USDT

**Investor request (home → Withdrawals).**
- "Amount to withdraw (USDT)": the request is typed in USDT and sent as units, `units = USDT / today's unit price` (`Contribution.withdrawUnits`, which takes no rate).
- Within a cent of everything unlocked counts as "everything".
- The preview shows the units and the price, and "≈ ₱… at today's PHP/USD reference rate: an estimate only", or "Peso estimate: rate unavailable".
- "What you receive is set by these units and the unit price on the payout day, in USDT."

**Manager Money out.**
- "Amount (USDT)": the peso currency option is removed.
- USDT becomes units at the payout price.
- The database quote's payout is shown in USDT, with the pesos marked "(… at today's rate, an estimate)".

**Approve / Quote / Redeem** (Balance desk): these take the request ID only, so the request's units decide everything. Nothing in that flow changed.

**Minimum withdrawal (₱500).**
- The database checks it (`_check_min_withdrawal`) at the **fund's stored PHP/USD reference rate** (section 6), never at a cash-in rate.
- Taking everything is always allowed.
- **The investor sees the minimum as the database applies it**, e.g. "about 7.92 USDT at the fund's PHP/USD reference rate ₱63.11 (open.er-api.com, Nov 7, 2026)". The request preview warns below that amount; the database refuses with its reason.
- **With no current reference** (none stored in the last 7 days), the line reads "not checked while the fund has no current PHP/USD reference rate". In that case a small request is let through rather than checked at a wrong rate.
- **Manager payouts** pass today's live reference rate from the form, or none, in which case the stored reference is used. The "Inside lock-up / minimum: allow" override still works.

**Proof.**
- WD3: the database quote and the real payout give identical unit price, fee, net units, payout, units and pool value with peso rates of none, 40, 63.11, 75.27 and 150.
- WD5: the same for a pool reading, a deposit and a settlement with a real profit share; ownership shares are identical.
- In the browser, the same 20 USDT request sent identical units (22.78034735) with the reference rate at 63.11, at 40, and unavailable.

## 6. The database's reference rate (migration 20261208000000)

**The problem it fixes.** Until this migration, the database's "current peso rate" `_last_php_rate()` was the `php_rate` of the newest pool entry. Admitting a deposit copies the deposit's own rate onto its pool entry. So since 2026-11-07 it has returned **₱75.27191529**, Raf's cash-in rate, which was then used for:
- the ₱500 minimum on investor requests and Balance-desk payouts;
- the default `php_rate` written on new entries.

**After the migration:**

| Piece | What it is |
|---|---|
| `fx_reference_rates` | append-only readings: `usd_php` (₱20–₱200), `source`, `fetched_at`, `recorded_by`. Not readable by the website role directly; included in backups. |
| `admin_record_fx_reference(token, rate, source, fetched_at)` | fund manager only. Refuses a rate outside ₱20–₱200, an empty source, or a reading not fetched within the last hour. Stores at most one reading per hour (otherwise returns the stored one). Every stored reading is in the activity log (`fx_reference_recorded`). Called automatically by the manager's browser. |
| `fx_reference(token)` | anyone signed in: the current reading, and the minimum in USDT (₱500 ÷ rate). |
| `_fx_reference_rate()` | the newest reading fetched within `fx_reference_max_age_hours` (setting, default 168 = 7 days; not dated in the future), else NULL. |
| `_last_php_rate()` | now returns `_fx_reference_rate()`. Its ~40 callers all change at once, and it never reads a pool entry or deposit again. |
| `_check_min_withdrawal()` | same rule; a rate outside ₱20–₱200 counts as no rate (no check). |

**What changes in practice:**
- **The ₱500 minimum** is checked at the latest market reading (within 7 days), not at a cash-in rate.
- **New entries recorded without a rate** store the current reference (or nothing). Peso deposits keep their own cash-in rate, as before.
- **No existing row is read, written or rewritten.** Units, unit prices, pool values, fees, payouts and settlements never depended on a peso rate. That is proven in FX6, WD3 and WD5, and FX7 shows applying and rolling back leave every financial table's hash unchanged.
- **The reference is kept fresh by the fund manager opening the app** (once an hour at most is stored). If it's not opened for 7 days, the minimum is not checked until it is.

**What stays as it was:**
- Pool entries #18–20 keep the 75.27 they were written with (records are never rewritten); nothing reads it as a current rate any more.
- The true-value book entry copies the previous entry's `php_rate` (descriptive only).

**Rollback.** Puts back the exact previous `_last_php_rate()` and `_check_min_withdrawal()`, removes the new functions, and keeps the readings table and its rows. It can be applied again.

## 7. How to test

- `npm test` runs the whole suite on an in-memory Postgres.
- `node --test tests/contribution.test.mjs tests/withdraw-denomination.test.mjs tests/fx-reference.test.mjs` runs only this feature.
- **Browser check** (used for this feature, not part of the repo). A Playwright script serves `login.html` locally and answers every Supabase call from an in-memory database built from all migrations. It mocks the two rate sources: ok, failed, broken, HTML, cached 2 h, cached 13 h, future, and the stored-rate shape. It blocks any other request. Screens covered:
  - the investor home (desktop and phone);
  - investors paying only in pesos, in two peso deposits, and only in USDT;
  - the manager dashboard, My account and investor sheets;
  - the deposit form scenarios;
  - the investor request and the manager Money out;
  - the ₱500 minimum: before any reference reading, after the manager's session stored one, and a below-minimum request refused by the database.

  Deposits and the 20 USDT request were captured at the network boundary and **not run**, even locally.
- **Live check: read-only.** Before and after any change, compare the counts and hashes of `ledger`, `pool_equity`, `pending_deposits`, `flow_checkpoints`, `book_corrections` and `ledger_settings`, plus units per person, the latest pool entry and the latest audit ID.

## 8. Deployment (for the owner's approval; nothing has been deployed)

**Files**

| Kind | Files |
|---|---|
| Website (publish the usual way) | `login.html`, `js/contribution.js` (new), `js/app.js`, `js/returns.js`, `js/position.js` |
| Database (run once, by hand) | `supabase/migrations/20261208000000_fx_reference_rate.sql` |
| Rollback (only if needed) | `supabase/rollback/20261208000000_rollback_fx_reference_rate.sql` |
| Not deployed (repo only) | `docs/php-contributions.md`, `README.md`, `package.json`, `tests/*` |

**Order.**
1. **Before:** take a backup (Settings → backup export), then run the read-only check in section 7. Expected values on 2026-11-07:
   - ledger: 4 rows, md5 `e6a26064…`;
   - pool_equity: 19 rows, `eaa606a7…`;
   - pending_deposits: 4, `935b0694…`;
   - flow_checkpoints: 2, `2a96d2b8…`;
   - book_corrections: 2, `e9ca59fd…`;
   - units: James 73.31635568, Raf 356.81618778, total 430.13254346;
   - pool #20: 377.634754 / 0.87794974;
   - last audit entry: #52.
2. **Database:** Supabase → SQL Editor → paste and run `20261208000000_fx_reference_rate.sql`. It is safe to run twice, and it writes no row of any existing table. Expected:
   - `select public._last_php_rate()` returns NULL (no reading yet);
   - `select count(*) from fx_reference_rates` returns 0.
3. **Website:** publish the five files. The website also works before step 2, with the old minimum wording.
4. **Store the first reading:** open the app once as the fund manager, with the live rate loading (the ₱ button visible). Then run `select usd_php, source, fetched_at from fx_reference_rates` (one row) and `select public._last_php_rate()` (that rate).
5. **After:** repeat the read-only check. Every value in step 1 must be identical, `ledger_settings` aside: it gains one key, `fx_reference_max_age_hours = 168`. The only other new rows are the readings in `fx_reference_rates` and their `fx_reference_recorded` entries in the activity log.

Between steps 2 and 4, the ₱500 minimum is not checked, so small requests are allowed. Keep that window short.

**Rollback.** Run `20261208000000_rollback_fx_reference_rate.sql`. To undo the website, publish the previous versions of the five files. The website rollback and the database rollback are independent.

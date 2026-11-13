# Admission spread: crediting pesos at a slightly higher rate, surplus stays the manager's

Status: built and tested locally on 2026-11-07. **Not deployed, not committed, migration not applied to production.** No ledger, pool or deposit row is touched by the migration.
Database: `supabase/migrations/20261209000000_admission_spread.sql`. Rollback: `supabase/rollback/20261209000000_rollback_admission_spread.sql`.
Code: `js/contribution.js` (wording, `spreadFigures`), `js/app.js` (Record → Money in → Admission spread), `js/truevalue-ui.js` (checkpoint label).
Tests: `tests/admission-spread.test.mjs` (AS1–AS15 plus AS3b).

## The idea, with the numbers

| | |
|---|---|
| Investor pays | ₱5,000 |
| Actual / reference rate | ₱62 per USDT |
| Admission rate (what the investor is credited at) | ₱63 per USDT |
| **Actual USDT allocated** | 5,000 ÷ 62 = **80.645161** |
| **Credited to the investor** | 5,000 ÷ 63 = **79.365079** (rounded *down* to 6 decimals) |
| **Manager-owned surplus** | 80.645161 − 79.365079 = **1.280082** |

The investor's units are `credited USDT ÷ the true-value unit price`, exactly as for any deposit. Pesos and rates never produce units.

## What is recorded (table `admission_spreads`, append-only)

| Field | Meaning |
|---|---|
| `profile_id` | the investor |
| `php_amount` | the original pesos |
| `reference_rate` | the actual / reference rate (₱ per USDT) |
| `admission_rate` | the rate the investor is credited at |
| `credited_usdt` | pesos ÷ admission rate, rounded down to 6 decimals; what buys the investor's units |
| `actual_usdt` | the USDT really allocated (received, or set aside from the manager's capital) |
| `surplus_usdt` | `actual − credited`; the manager's |
| `funding_source` | `p2p_purchase` or `manager_reallocation` |
| `manager_id` | whose capital holds the surplus |
| `investor_pending_id`, `manager_pending_id` | the two linked waiting deposits (p2p) |
| `realloc` | price, units, pool entry, ledger rows and checkpoint (reallocation) |

The investor's own ledger row keeps `usdt` = credited, `php_amount` = the pesos, `php_rate` = the admission rate. The manager sees everything through `admin_admission_spreads` (units issued to the investor and to the manager, the price, and the status). Investors cannot read the table.

## The two funding sources

### 1. New P2P purchase (`p2p_purchase`)

The investor's pesos bought USDT on MEXC. Recording it creates **two linked waiting deposits**:
- the investor's: `credited` USDT, their pesos, the admission rate;
- the manager's: the **surplus** (no pesos, no investor).

Together they add up to the USDT actually allocated. They are admitted **together** at the same true-value price (`admin_admit_admission_spread_tv`, or the existing `admin_admit_deposits_tv` with both ids). As a result:

- The pool's value rises by the USDT actually allocated, and its units by `actual ÷ price`. **The unit price does not move.**
- The investor holds `credited ÷ price` units. The manager holds `surplus ÷ price` more units: **the surplus is the manager's own units**, not pool equity shared with anyone.
- Every other investor's units, value and profit are unchanged. Their percentage share of the pool dips slightly because the pool grew, exactly as with any deposit; nothing about it increases.
- It is a **deposit** entry, not a trading result: nobody's trading profit changes. The manager's profit is unchanged, because the surplus is money in.
- The investor's high-water mark is the credited amount, so no performance fee is ever charged on the spread.
- With open trades the **true** unit price (what a unit is worth if every trade closed) is unchanged too (AS3b). The book price shifts exactly as it does for every ordinary true-value deposit, until those trades close.

### 2. Manager capital reallocation (`manager_reallocation`)

No new money. Only the **credited units** move from the manager's holding to the investor, priced at true value in one transaction:

- No pool deposit and **no pending deposit**. One pool entry of kind `withdrawal` that leaves equity and total units exactly as they were.
- The investor's units come out of the manager's holding. The surplus stays in the manager's holding, because only the credited units move.
- A checkpoint of kind `reallocation` keeps the true-value reading (wallet reports, true value, price) the transfer was priced on.
- Refused unless the manager's holding covers the **whole** actual allocation, and refused outside true-value pricing (`flow_pricing = true_value`); the older book-priced "units from the fund manager" is unchanged.

## What is refused (nothing is written, nothing is taken from anywhere else)

| Refusal | Why |
|---|---|
| actual allocation < credited | the surplus must be supported by real capital |
| admission rate < actual / reference rate | it would credit more USDT than the pesos bought |
| spread above `admission_spread_php` (default ₱1) | the agreed spread is a setting; more needs a deliberate change |
| pesos and actual USDT imply a rate more than `admission_rate_tolerance` (default 1%) from the stated one | a typo check |
| rates outside ₱20–₱200, pesos ≤ 0, more than 6 decimals | bad input |
| not an investor, deactivated, not the fund manager | |
| reallocation: manager's holding below the allocation, or true-value pricing off or blocked | |
| p2p admission: the exchange does not hold the claimed USDT | the true-value check (exchange vs books) refuses it (AS8) |
| admitting or handing back **one** leg of a p2p spread | a deferred check at commit: both together or neither (AS9) |

Every operation takes a request id: a retry returns the first answer and never duplicates. Quotes (`admin_quote_admission_spread`) are rolled back and use up no spread number.

## In the app (fund manager)

Record → Money in → **Admission spread**:
- the form: Who, Pesos paid, Funded by, Actual / reference rate, Admission rate (pre-filled with the live rate + ₱1), USDT actually allocated (empty = pesos ÷ rate), "Already seen in the exchange";
- the database's own quote before saving, or its refusal in plain words;
- a reallocation asks for confirmation first;
- the recorded list shows both legs' status with **Admit** and **Hand back** (together);
- the waiting-deposits card marks the two legs as one spread and offers no separate "Handed back";
- the activity log has `admission_spread_recorded` and `admission_spread_reallocated`.

## What investors see

Their card says **Credited to you** (USDT), the rate it was credited at (₱63.00 paid per USDT) and their units. Nothing about the surplus, the manager's units or the actual allocation (test AS14).

The card's existing "Lost converting pesos to USDT" line compares what they were credited with **today's market rate**. When the market rate is the actual rate, that line equals the spread (₱79.37, 1.28 USDT in the example). It is computed from the live market rate, not from any record of the manager's, so an investor can see what converting cost them. Whether to tell investors about the admission rate in the terms is a policy decision for you.

## Existing behaviour is unchanged

- The migration changes no row of any existing table (AS11). `flow_checkpoints.kind` also accepts `reallocation`; the backup export also carries `admission_spreads`.
- An ordinary deposit prices exactly as before (AS12). The true-value maths, the guards and every existing test are unchanged.
- Settings: `admission_spread_php` = 1, `admission_rate_tolerance` = 0.01.

## Deployment (for your approval; nothing has been deployed)

| Kind | Files |
|---|---|
| Database (run once, by hand, after `20261208000000_fx_reference_rate.sql`) | `supabase/migrations/20261209000000_admission_spread.sql` |
| Rollback (only if needed) | `supabase/rollback/20261209000000_rollback_admission_spread.sql` |
| Website | `login.html` (unchanged by this feature), `js/app.js`, `js/contribution.js`, `js/truevalue-ui.js` |

1. Back up, then run the read-only check (counts and hashes of `ledger`, `pool_equity`, `pending_deposits`, `flow_checkpoints`, `book_corrections`; units per person; latest pool entry and audit id).
2. Run the migration in the SQL Editor. Expect no change to any of those values. `select count(*) from admission_spreads` returns 0.
3. Publish the website files. The Admission spread card appears only once the migration has run.
4. Use it with a small real case first: record it, read the quote, admit, then check the investor's units, the manager's surplus units and that another investor's value did not move (`admin_admission_spreads`).

**Rollback.** Refused while a spread still has a waiting deposit (admit or hand both back first). It removes the functions and the commit-time check, and **keeps** `admission_spreads` and its rows as evidence.

## Things to know

- **The MEXC side is not automated.** Nothing here buys USDT or moves funds. For a P2P purchase you record what really arrived, and the exchange reading must hold it. For a reallocation, no exchange step is needed.
- **Admitting through the older steps.** With the true-value path, use **Admit** (both legs together). In book pricing or with the workflow gate on, an old single-deposit "admit" on one leg is refused at commit with a message that says why; use Update Pool, which admits every waiting deposit together.
- **The real market rate is yours to enter.** "Actual / reference rate" is the rate the capital actually cost or was valued at. The database checks only that it is consistent with the pesos and the actual USDT.

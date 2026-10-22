# Lucid'io Ledger

**Lucid'io**: clear rules, real growth. A phone-friendly paper ledger for a small pooled account (friends & family). **No money moves through this app.** The real money sits in one merged exchange account; this app records who owns what and shows everyone their own number.

- Pool is valued in **USDT**. Everything is **shown in pesos by default** using the live USD→PHP rate (free `open.er-api.com`, falling back to `frankfurter.dev`, cached 1 hour; USDT is treated as 1 USD). The ₱ / $ button in the header flips the view. The rate never changes anyone's USDT return. Deposits are typed in **pesos** (e.g. 5000); the app converts to USDT at the rate shown (editable) and to units for you.
- Ownership is tracked in **units**. Unit price = pool equity (USDT) ÷ total units. A person's value = their units × unit price.
- **New money waits for the next valuation (forward pricing).** A deposit is first only *received*: it owns no units, so it gets no gains and no losses. At the next equity reading (Update equity or quarter close) the waiting money is taken out of the MEXC total, the unit price is set from what the existing holders own, and then the waiting money buys units at that price. A newcomer therefore never shares in profit made before their money was in (and never pays for losses from before). Their lock-up starts and their high-water mark is set at that price, so their fee is charged only on gains made after they joined. A withdrawal redeems units at the current price.
- **Fee** (set per person when you create them, 10% by default; change it later in Users → Edit) on gains above each person's **high-water mark**, charged at quarter end. Each close moves the mark up to the current price, so profit that was already charged is never charged again. The fee is paid as *units* moving from the investor to the manager, so it stays in the pool and compounds. The manager's own capital pays no fee.
- **Investors see their balance and % after the fee** (already taken + owed so far), with a "How your growth is worked out" card: what the trading made, minus the fee, = theirs. The Users list shows the manager both, before and after the fee (`20261030000000_net_of_fee_returns.sql`).
- 3-month lock-up per deposit, withdrawals paid within 7 business days (shown to investors; enforced by the manager).
- The books are **append-only**: entries cannot be edited or deleted.

## Logins

Simple username + password. No emails, no sign-up page: the manager creates every account and hands out the password.

- Passwords are stored as **bcrypt hashes**, never in plain text. Sign-in gives the phone a random session token (30 days); the database stores only its hash.
- 5 wrong passwords in a row lock that username for 15 minutes.
- **Each person can change their own password** (Home / Mine tab). **The manager can set a new password for anyone**, including themselves (Users tab → Edit / reset password). Changing a password signs that person out on their other devices.
- The manager can deactivate a person (signed out, cannot sign in; their units stay in the pool).
- **View as** (Users tab): the manager opens the app exactly as that person sees it (balance, growth chart, transactions). It is read-only: no withdrawal requests or password changes in their name, and it ends after 2 hours or with "Back to manager".
- Every person's Home shows a **growth chart** of what their share is worth over time (1W / 1M / 3M / YTD / ALL; drag across it to see any day), with a dashed line for what they have put in, plus their recent transactions.
- **Terms, then quote, then tour.** An investor's first sign-in goes: (1) **Please read this first**: eight plain-language points (you can lose a large part or all of your money, nothing is guaranteed or insured, not a bank, lock-up and withdrawals, how new money joins, the fee, what the numbers mean, login and agreement) and four boxes that must all be ticked before "I agree, continue" works. The agreement is saved **in the database** (`terms_acceptances`: who, which version, when; append-only), so it works on every phone and the manager can see who has agreed in Users. (2) A quote screen while the tour "loads". (3) An 8-step animated tour (pool and units, ups and downs / compounding, how new money joins, lock-up, fee, the screens, a glossary of jargon). The tour is remembered per device and replays from "Welcome tour"; the About page keeps the glossary and a "Read the terms again" button. Nothing here shows while the manager is "viewing as" someone, and the manager cannot agree on a person's behalf.
- **Changing the terms:** edit `termsSections()` / `TERMS_CHECKS` in `js/app.js` and bump `TERMS_VERSION`; everyone is asked to agree again at their next sign-in. If the database update has not been run, the agreement cannot be saved and the person stays on the terms screen (it never lets anyone skip it).
- Every table is locked from the website. The page can only call database functions, and every function checks the session token, so investors cannot see each other or do manager actions even with browser tools.

| | Sees |
|---|---|
| **Manager** | everyone, all entries; records equity / deposits / withdrawals / quarter close; creates accounts, resets passwords |
| **Investor** | only their own money (balance chart, fee, withdrawals, entries) and an About page. Also the fund's trading return over time and the manager's own % (`fund_returns`: unit price per event + whether the manager's money was in, nothing else), so they can see the manager's money made the same trading return as theirs. **Never** the pool's size, units, amounts, ownership split or anyone else (enforced in the database by `20261023000000_hide_pool_from_investors.sql`) |

## Setup

1. **Database**: Supabase dashboard → SQL Editor → paste and run the SQL files in date order. Files already run on the live database are kept in `supabase/migrations/applied/`; any file still directly in `supabase/migrations/` has **not** been run yet (after running one, move it into `applied/`; the tests find it in either place). The full order: `20261022000000_ledger.sql`, then `20261023000000_hide_pool_from_investors.sql`, `20261024000001_ledger_corrections.sql`, `20261025000000_profit_share_10.sql`, `20261026000000_pending_deposits.sql`, `20261027000000_profit_share_hardening.sql`, `20261028000000_terms_acceptance.sql`, `20261029000000_fund_returns.sql`, `20261030000000_net_of_fee_returns.sql`, `20261031000000_pesos_backup_audit.sql`, `20261031000001_bot_equity_sync.sql` (all safe on live data; on an existing install run only the ones you have not run yet). **Not yet run anywhere:** `20261101000000_ledger_integrity.sql` (one correction per entry, locking, retry-safe writes, a flat 10% fee on each quarter's net trading profit with no loss recovery, MEXC reconciliation). It changes the fee rule and cannot simply be undone after the first new entry: read [docs/accounting-model.md](docs/accounting-model.md) and run [supabase/diagnostics/pre-migration-integrity.sql](supabase/diagnostics/pre-migration-integrity.sql) first. It cleans up any earlier version of this app first, so it is safe to run on the existing project. (If the project still has the old backtester tables, run `supabase/reset-backtester-tables.sql` first.)
2. **Your manager account**: edit the three values in `supabase/create-admin.sql` (username, name, password), run it in the SQL Editor, and **don't save the file with your real password**.
3. **Host the folder** as a static site. **Vercel**: import the repo, preset "Other", root `./`, no build command, no environment variables (`vercel.json` and `.vercelignore` already keep the SQL/test/script folders off the public site). GitHub Pages also works. Friends open the link and can "Add to Home Screen".
4. `js/config.js` holds the project URL and the *publishable* key, which is meant to be public. **Never** put the database password or a `service_role`/secret key in this repo.

## Statements, activity log and backups

- **Statements** (investors: Statements tab; manager: My account → Statements): a month-by-month table (trading %, % after the fee, balance), the worst drop from a high, and a statement for any month: opening balance, money added, money taken out, trading result, fee, closing balance. Download a month or all months as CSV, or **Save as PDF** (the browser's print dialog; only the statement prints). Balances are in USDT; pesos appear only where pesos were really paid in or out. The maths is in `js/returns.js` and is tested against the real database functions in `tests/statements.test.mjs`.
- **"Put in" in pesos** is the pesos actually handed over (the deposit entries keep the peso amount), not dollars converted at today's rate. The peso exchange-rate effect is shown on its own line, so ₱ balance = put in + profit + exchange rate.
- **Activity log** (manager: Fund → Log): who changed what and when, written by database triggers so no code path can skip it, and no row can be edited or deleted. Records accounts, fee rates, passwords, money received / joined / paid out, fee charged, equity readings, quarter closes, corrections, withdrawal requests, terms, "view as", setting changes and backups. Sign-ins and page views are not recorded.
- **Backups** (manager: Fund → Log → Backups): *Download backup (JSON)* any time, and a **nightly backup** that runs on a computer you control:
  1. In the app press **Create nightly backup key** and copy it (shown once). The key can only read an export; it cannot sign in or change anything, and **Revoke all keys** stops it at once.
  2. Copy `backup.config.example.json` to `backup.config.json` (gitignored) and paste the key in. Optional `copyTo` = a second folder, e.g. a Google Drive / OneDrive folder.
  3. Test it: `node scripts/backup-ledger.mjs`. Then schedule it: `node scripts/backup-ledger.mjs --schedule 02:30` (Windows Task Scheduler; on Linux use cron).
  Each run saves `backups/ledger-<date>_<time>/` (`ledger.json`, one CSV per table, `summary.json`), re-checks the numbers (units add up, row counts match, no password hashes), keeps the newest 60, and logs to `backups/backup.log` and `backups/status.json`. Backups never contain passwords, so after a restore everyone gets a new password (Users → Edit / reset password). The Backups card warns when no automatic backup has run for 3 days.

## Test data

`supabase/seed-test-data.sql` replays the full SOL+ZEC backtest (Mar 2020 → Oct 2026, 640 trades, 1% risk per trade, compounding) through the real functions: manager ₱5,000 and John ₱3,000 at the start, Dino ₱3,000 from mid-2023, weekly equity updates, every quarter settled. Backtest = hypothetical; the coins were picked with hindsight. It creates test logins `john / john-test-123` and `dino / dino-test-123`. Run it on an empty ledger; if no manager exists yet it also creates `raf / admin-test-123` (change that password in the app straight away). Entries carry the simulated 2026 dates, so charts and lock-ups look real. **Before real money: run `supabase/reset-ledger-data.sql`** (wipes all entries, keeps the accounts) and deactivate or reset the test logins.

Regenerate or try other assumptions:

```
node scripts/simulate.mjs <trades.json> --rate 58 --risk 0.01 --seed supabase/seed-test-data.sql
```

It also re-computes every number with an independent plain-JS model and reports MATCH / MISMATCH.

The manager's first tab is a **Dashboard** (fund value, investor money, withdrawal requests, performance, ownership). **Users** lists everyone; "+ Add user" opens the new-user form.

## Daily use (manager)

1. **Record → 1 Update equity**: read total pool equity (USDT, including open trades) from MEXC and enter it. Daily or weekly.
2. **Someone puts money in**: Record → Deposit ("Money received"). Type the pesos they gave you (e.g. 5000) and check the rate. It shows under *Waiting to join* until your next **Update equity**, which turns it into units at that day's price. Gave it back or typed it wrong? Tap *Handed back*.
3. **Someone takes money out**: they request it in the app (Log → Prepare payout), or record it directly: Record → 3 Withdrawal, with the pool equity just before payout. The fee on their gains comes out in units first; the rest is paid.
4. **Every quarter**: Quarter tab → enter equity → check the preview → Charge fees.

Every equity you type is simply **the MEXC total** (open trades included, waiting deposits included); the app subtracts waiting money itself, so cash sitting in the account never moves the price. For a withdrawal, enter the total *before* you pay out.

Tip: take readings when few or no trades are open. A deposit that joins mid-trade shares in the rest of that trade's result, even though the position was sized before the money arrived; for a small pool this is a minor effect, and it cuts both ways.

## Fee: rules that stop anyone gaming it

Each rule below has a test in `tests/ledger.test.mjs` that tries the trick and checks it fails.

| Trick | Why it fails |
|---|---|
| Join right after a winning stretch to share profit you were not in for | New money waits and buys units at the **next** reading's price (forward pricing). |
| Top up at a high so the blended "best level" rises and the fee already earned disappears | Every deposit is its **own lot with its own line** (per-lot high-water mark). Adding money never moves another deposit's line. |
| Let an old losing deposit shield a new deposit's gains | Same: lots are measured separately; an old lot owes nothing until it passes its own line, a new lot owes on its own gains. |
| Manager raises someone's % after the gains are made | A higher % is only **scheduled**; it starts after the next quarter close. The investor sees it on Home. Lower % applies at once. |
| Manager closes quarters often to charge on temporary highs | Quarter closes must be at least `min_days_between_closes` (80) days apart. |
| Several withdrawal requests that together exceed what is unlocked, or paying one request twice | Pending requests count against the unlocked units; a request can only be paid while it is still pending. |
| Cash already sitting in MEXC inflating the price at a payout or close | Waiting deposits are subtracted from every equity typed. |
| Using the instant deposit to skip the waiting step | `admin_deposit` is not callable from the website (only from the SQL editor/scripts). |

Withdrawals take units from the **oldest** deposits first (same order as the lock-up), each charged against its own line.

**What the software cannot police (trust in the manager):** the equity number typed from MEXC, the dates of late entries, and who gets which %. The books are append-only and every reading is logged, so it is auditable after the fact. To make it checkable by investors, share a monthly MEXC statement or screenshot of the account equity with them.

## Tests

`npm install && npm test` runs the real migration on an in-memory Postgres (PGlite + pgcrypto) with every call made as the website's public role: unit/fee maths, peso independence, lock-up, logins (hashing, lockout, logout, deactivation), password changes and resets, and the access rules.

## Disclaimer

Paper records of a share in a pooled account. Not a bank balance, not insured, no guaranteed returns; backtested results are hypothetical. Money placed here can be lost. Check with a Philippine securities lawyer before accepting other people's money (pooled-fund arrangements can count as investment contracts under SEC rules).

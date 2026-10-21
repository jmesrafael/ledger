# Ledger Monitor

A phone-friendly paper ledger for a small pooled account (friends & family). **No money moves through this app.** The real money sits in one merged exchange account; this app records who owns what and shows everyone their own number.

- Pool is valued in **USDT**. The peso rate never changes anyone's return; it is only used for the "≈ ₱" estimate.
- Ownership is tracked in **units**. Unit price = pool equity (USDT) ÷ total units. A person's value = their units × unit price.
- A deposit buys units at the current price, so it never changes anyone else's value. A withdrawal redeems units at the current price.
- **Performance fee** (default 20%, per person) on gains above each person's **high-water mark**, charged at quarter end. The fee is paid as *units* moving from the investor to the manager, so it stays in the pool and compounds. The manager's own capital pays no fee.
- 3-month lock-up per deposit, withdrawals paid within 7 business days (shown to investors; enforced by the manager).
- The books are **append-only**: entries cannot be edited or deleted.

## Logins

Simple username + password. No emails, no sign-up page: the manager creates every account and hands out the password.

- Passwords are stored as **bcrypt hashes**, never in plain text. Sign-in gives the phone a random session token (30 days); the database stores only its hash.
- 5 wrong passwords in a row lock that username for 15 minutes.
- **Each person can change their own password** (Home / Mine tab). **The manager can set a new password for anyone**, including themselves (People tab → Edit / reset password). Changing a password signs that person out on their other devices.
- The manager can deactivate a person (signed out, cannot sign in; their units stay in the pool).
- **View as** (People tab): the manager opens the app exactly as that person sees it (balance, growth chart, transactions). It is read-only: no withdrawal requests or password changes in their name, and it ends after 2 hours or with "Back to manager".
- Every person's Home shows a **growth chart** of what their share is worth over time (1W / 1M / 3M / YTD / ALL; drag across it to see any day), with a dashed line for what they have put in, plus their recent transactions.
- Every table is locked from the website. The page can only call database functions, and every function checks the session token, so investors cannot see each other or do manager actions even with browser tools.

| | Sees |
|---|---|
| **Manager** | everyone, all entries; records equity / deposits / withdrawals / quarter close; creates accounts, resets passwords |
| **Investor** | only their own numbers and entries, plus pool totals (size, unit price, chart, ownership split), never other people's names or amounts |

## Setup

1. **Database**: Supabase dashboard → SQL Editor → paste and run `supabase/migrations/20261022000000_ledger.sql`. It cleans up any earlier version of this app first, so it is safe to run on the existing project. (If the project still has the old backtester tables, run `supabase/reset-backtester-tables.sql` first.)
2. **Your manager account**: edit the three values in `supabase/create-admin.sql` (username, name, password), run it in the SQL Editor, and **don't save the file with your real password**.
3. **Host the folder** as a static site. **Vercel**: import the repo, preset "Other", root `./`, no build command, no environment variables (`vercel.json` and `.vercelignore` already keep the SQL/test/script folders off the public site). GitHub Pages also works. Friends open the link and can "Add to Home Screen".
4. `js/config.js` holds the project URL and the *publishable* key, which is meant to be public. **Never** put the database password or a `service_role`/secret key in this repo.

## Test data

`supabase/seed-test-data.sql` replays the full SOL+ZEC backtest (Mar 2020 → Oct 2026, 640 trades, 1% risk per trade, compounding) through the real functions: manager ₱5,000 and John ₱3,000 at the start, Dino ₱3,000 from mid-2023, weekly equity updates, every quarter settled. Backtest = hypothetical; the coins were picked with hindsight. It creates test logins `john / john-test-123` and `dino / dino-test-123`. Run it on an empty ledger; if no manager exists yet it also creates `raf / admin-test-123` (change that password in the app straight away). Entries carry the simulated 2026 dates, so charts and lock-ups look real. **Before real money: run `supabase/reset-ledger-data.sql`** (wipes all entries, keeps the accounts) and deactivate or reset the test logins.

Regenerate or try other assumptions:

```
node scripts/simulate.mjs <trades.json> --rate 58 --risk 0.01 --seed supabase/seed-test-data.sql
```

It also re-computes every number with an independent plain-JS model and reports MATCH / MISMATCH.

## Daily use (manager)

1. **Record → 1 Update equity**: read total pool equity (USDT, including open trades) from MEXC and enter it. Daily or weekly.
2. **Someone puts money in**: Record → 2 Deposit. Enter the USDT credited and the pool equity *just before* it landed.
3. **Someone takes money out**: they request it in the app (Log → Prepare payout), or record it directly: Record → 3 Withdrawal, with the pool equity just before payout. The fee on their gains comes out in units first; the rest is paid.
4. **Every quarter**: Quarter tab → enter equity → check the preview → Charge fees.

Always enter equity *before* a deposit or withdrawal lands. That ordering is what stops newcomers buying into profits they did not earn.

## How the high-water mark works with top-ups

If someone adds money while already invested, their high-water mark becomes the unit-weighted average of their old mark and the price they bought at. This can only ever charge them **the same or less** than tracking every top-up separately, never more. Big funds use "equalisation" or per-lot series to be exact; for a small pool the blended mark is the usual simplification.

## Tests

`npm install && npm test` runs the real migration on an in-memory Postgres (PGlite + pgcrypto) with every call made as the website's public role: unit/fee maths, peso independence, lock-up, logins (hashing, lockout, logout, deactivation), password changes and resets, and the access rules.

## Disclaimer

Paper records of a share in a pooled account. Not a bank balance, not insured, no guaranteed returns; backtested results are hypothetical. Money placed here can be lost. Check with a Philippine securities lawyer before accepting other people's money (pooled-fund arrangements can count as investment contracts under SEC rules).

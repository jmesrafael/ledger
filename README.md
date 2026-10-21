# Ledger Monitor

A phone-friendly paper ledger for a small pooled account (friends & family). **No money moves through this app.** The real money sits in one merged exchange account; this app records who owns what and shows everyone their own number.

- Pool is valued in **USDT**. The peso rate never changes anyone's return; it is only used for the "≈ ₱" estimate.
- Ownership is tracked in **units**. Unit price = pool equity (USDT) ÷ total units. A person's value = their units × unit price.
- A deposit buys units at the current price, so it never changes anyone else's value. A withdrawal redeems units at the current price.
- **Performance fee** (default 20%, per person) on gains above each person's **high-water mark**, charged at quarter end. The fee is paid as *units* moving from the investor to the manager, so it stays in the pool and compounds. The manager's own capital pays no fee.
- 3-month lock-up per deposit, withdrawals paid within 7 business days (shown to investors; enforced by the manager).
- The books are **append-only**: entries cannot be edited or deleted.

## Roles

| | Sees |
|---|---|
| **Manager** (the first account to sign up) | everyone, all entries, can record equity / deposits / withdrawals / quarter close, approves new people |
| **Investor** | only their own numbers and entries, plus pool totals (size, unit price, chart, ownership split). Not other people's names or amounts |
| **Unapproved** | nothing |

## Setup

1. **Create the tables.** Either
   - paste `supabase/migrations/20261021000000_init.sql` into the Supabase dashboard → SQL Editor → Run, or
   - with the CLI: `supabase init` (once), `supabase link --project-ref <ref>`, `supabase db push` (asks for the database password; never commit it).
2. **Auth settings** (dashboard → Authentication): optionally turn off "Confirm email" so friends can sign in right after signing up.
3. **Create the manager account first.** Open the site and *Create an account* **before sharing the link**; the first sign-up becomes the manager. Everyone after that is an investor waiting for approval.
4. **Host the folder** as a static site (e.g. GitHub Pages: repo → Settings → Pages → deploy from `main`, root). Friends open the link and can "Add to Home Screen".
5. `js/config.js` holds the project URL and the *publishable* key, which is safe in a browser because access is enforced by row-level security. **Never** put the database password or a `service_role`/secret key in this repo.

## Daily use (manager)

1. **Record tab → 1 Update equity**: read total pool equity (USDT, including open trades) from MEXC and enter it. Do this daily or weekly.
2. **Someone puts money in**: Record → 2 Deposit. Enter the USDT credited and the pool equity *just before* it landed.
3. **Someone takes money out**: they request it in the app (you see it under Log → Prepare payout), or you record it directly: Record → 3 Withdrawal, with the pool equity just before payout. The fee on their gains comes out in units, the rest is paid.
4. **Every quarter**: Quarter tab → enter equity → check the preview → Charge fees.

Always enter equity *before* a deposit/withdrawal lands. That ordering is what keeps newcomers from buying into profits they did not earn.

## Corrections

There is deliberately no edit or delete. If you recorded something wrong, fix it in the Supabase SQL editor by temporarily dropping the `*_append_only` triggers, correcting, and re-creating them, or ask for a reversal function to be added.

## Tests

`npm install && npm test` runs the real migration on an in-memory Postgres (PGlite) and checks the unit/fee maths, the peso-independence of returns, the lock-up, and the access rules (investors cannot read each other or call admin functions).

## Disclaimer

Paper records of a share in a pooled account. Not a bank balance, not insured, no guaranteed returns; backtested results are hypothetical. Money placed here can be lost. Check with a Philippine securities lawyer before accepting other people's money (pooled-fund arrangements can count as investment contracts under SEC rules).

# Lucid'io Ledger

**Lucid'io**: clear rules, real growth. A phone-friendly ledger for a small pooled account (a fund manager and investors). **No money moves through this app.** The real money sits in one exchange (MEXC); this app records who owns what and shows everyone their own number.

Last checked against the live database: **Nov 13 2026**. Where an older document disagrees with this file or with [docs/live-nav.md](docs/live-nav.md), these two win.

## What the app is

- The pool is counted in **USDT**. Ownership is counted in **units**. Unit price = pool value (USDT) divided by total units. A person's value = their units x the unit price.
- The website is `login.html` + `js/*.js` (static files). The database is **Supabase** (Postgres). All rules live in database functions; the website only calls them.
- Everything is shown in pesos by default (live USD to PHP rate, USDT treated as 1 USD). The peso / dollar button in the header flips the view. The rate never changes anyone's units or USDT return.
- The books are **append-only**: history is never deleted or rewritten. A mistake is fixed with a new correcting entry.
- Investors see only their own money, their growth chart, statements and an About page. They never see the pool size, other investors or manager screens (enforced in the database).

## The flow in use

This is the only flow the manager uses. Three bots (BB-Core, I-Core, T-CORE) trade on MEXC.

| # | Step | Where | What happens |
|---|---|---|---|
| 1 | **Add investor** | Record > Add investor | Creates the account and the first cash-in in one step. |
| 2 | **Deposit** | Record > Deposit | The manager enters the pesos paid, the USDT that arrived in MEXC and the PHP/USD rate. The investor is credited pesos divided by rate. If less USDT arrived, the gap is covered by the fund manager's own units (peso top-up rule). If more arrived, the extra is the fund manager's own money. The money joins at the live price at the first verified MEXC wallet reading that shows it. |
| 3 | **Withdrawal** | Record > Withdrawal | Request, approval and redemption in one step, at the live price, after a check that MEXC can release the money. Then the manager sends the money from MEXC and presses **Mark sent**. Investor requests show there with a **Process** button. |
| 4 | **Transfer** | Record > Transfer | Ownership moves from one holder to another at the live price. The pool total does not move. |
| 5 | Spot and Futures moves | Done by hand in MEXC | Not in the ledger. The manager matches MEXC himself when he enters a cash-in, a withdrawal or a transfer. |
| 6 | **Bots report** | Automatic | Each bot sends a wallet report every 5 minutes and every closed trade is booked automatically. |
| 7 | **Settlement** | Automatic once `20261214000000_auto_settlement.sql` is applied | See below. |

Manager screens: Dashboard, Users, Record (Add investor, Deposit, Withdrawal, Transfer, Live NAV, History), Settle, Reports, Log. Investor screens are unchanged.
Step by step details: [docs/live-nav.md](docs/live-nav.md).

## How the price is made

The unit price follows the **verified wallet reports** from MEXC (live NAV):

```
NAV        = all wallet equity (open trades included) - money waiting to join - payouts redeemed but not yet sent
check      = NAV compared with the books (closed trades + open profit)
unit price = NAV / total units
```

- If MEXC and the books differ by more than **max(0.50 USDT, 0.05%)**, the price is **paused**. Screens keep the last good price and show the reason. No money step is priced until the gap is explained.
- Each cash-in, withdrawal and transfer takes its own fresh reading when it is saved. It is never priced from an old stored row.

## Automatic settlement (two months)

Once `20261214000000_auto_settlement.sql` is applied, the fee on profit is taken by itself at the first verified MEXC reading after a period ends (Jan 1, Mar 1, May 1, Jul 1, Sep 1, Nov 1, Manila time), inside a 7-day window.

- Only profit is cut: fee = the investor's rate x (their value minus their high-water mark), only when that is positive.
- The fee moves as **units** from the investor to the fund manager. The pool total and the unit price do not move.
- A missed window is not settled late. The next settlement covers it.
- The Settle tab shows the status and has a **Settle now** fallback button.
- **Status: not applied to live yet.** The first one would be Jan 1 to 7, 2027.

Details, one worked example, the settings and the rollback: [docs/auto-settlement.md](docs/auto-settlement.md).

## Live switches (Nov 13 2026)

| Setting | Live value | Meaning |
|---|---|---|
| `flow_pricing` | `true_value` | Money is priced at the true value (open trades included). |
| `auto_pool_mode` | `trades` | Closed trades are booked automatically. |
| `nav_auto` / `nav_auto_admit` | on / on | The price follows verified wallet reports; cash-ins join by themselves. |
| `fee_timing` | `immediate` | The fee is taken on the gain above the mark at settlement. |
| `settlement_schedule` | `bimonthly` | Manila time. |
| `settlement_recon` | `require` | A settlement needs the books to match MEXC. |
| `default_fee_rate` | 0.10 | Default for new accounts. Changing it to 0.20 is `20261114000000_fee_20.sql` (owner decision N6, not applied). |
| `workflow_gate`, `bot_equity_sync`, `wallet_nav_mode`, `payout_cap_mode`, `settlement_preview_mode` | off | Old machinery, not used. |

## Retired screens and the `LEGACY_SCREENS` flag

These by-hand screens are hidden: typed balances / Update equity / Update Pool, the Balance desk and workflow gate, the by-hand Money in and Money out forms, "They paid me directly", the separate peso top-up card, the admission-spread card, and the typed-total settlement screen.

- They are hidden behind one flag: `LEGACY_SCREENS` in `js/config.js` (default `false`).
- Their database functions are closed to the website by `20261215000000_retire_unused_functions.sql` once it is applied (not applied yet). Its rollback is in `supabase/rollback/`.
- `js/desk.js` is the four-step desk and is **kept**. `js/gate.js` belongs to the retired workflow gate.

## Hard rules

1. **Books are append-only.** Never delete or rewrite history.
2. **Schema changes are rehearsed on a copy first**, never straight on live.
3. These are the **owner's decisions**: applying migrations, publishing the website, fee terms (N6), the admission spread policy (N8), legal questions (N9), and any live settlement.

## Folder map

| Folder | What is in it |
|---|---|
| `login.html`, `css/`, `fonts/` | The website shell and styles. |
| `js/` | The website code: `app.js` (main), `desk.js` (the four steps), `settleauto.js` (Settle tab), `config.js` (project URL, public key, `LEGACY_SCREENS`), and helpers. |
| `api/` | Vercel serverless functions: bot dashboard login and data, bot event intake (`ingest`, `poll`), `fund-live`, monthly Telegram report, `health`. |
| `lib/` | Code used by `api/` (auth, store, aggregate, ingest, monthly report) and the true-value model. |
| `scripts/` | Tools: backup and restore, daily MEXC check (`recon-check.mjs`), `rehearse-migration.mjs`, bot key makers, migration builders. |
| `supabase/migrations/` | A file **directly here** means **not run on live**. |
| `supabase/migrations/applied/` | Files already run on live (46 files, up to `20261213000000_live_nav.sql`). After a file is applied, move it here. |
| `supabase/rollback/` | One rollback file per migration. |
| `supabase/parts/`, `maintenance/`, `corrections/`, `hotfix/`, `verify/`, `diagnostics/` | Source parts for built migrations, one-off scripts, post-apply checks and read-only diagnostics. |
| `tests/` | The test suite (runs on an in-memory Postgres). |
| `docs/` | Documentation. Old documents are in `docs/archive/`. |
| `bot-dashboard/`, `reports/` | The bot dashboard page and static research reports. |

Not yet applied (a file directly in `supabase/migrations/`): `20261114000000_fee_20.sql`, `20261209000000_admission_spread.sql`, `20261214000000_auto_settlement.sql`, `20261215000000_retire_unused_functions.sql`.
To check what is applied, run [docs/which-migrations-are-applied.sql](docs/which-migrations-are-applied.sql) in the Supabase SQL Editor (read-only).

## Tests

```
npm install
npm test
```

This runs every test file on an in-memory Postgres (PGlite). It calls the real migrations as the website's public role. `npm run test:race` runs the concurrency test and needs Docker.

## Rehearse a migration

Never apply a migration to live without this.

1. Take a backup (`backup-ledger.cmd` or the manager's backup export) and save it as `ledger.json`.
2. Start Docker.
3. Run `node scripts/rehearse-migration.mjs <backup ledger.json>` (or `npm run rehearse -- <backup ledger.json>`).
4. It builds a throwaway Postgres from `supabase/migrations/applied/`, restores the backup, applies each pending migration twice, checks that no existing row changed, tests the rollback, and prints PASS or FAIL for each step. It touches no real database.
5. Only then does the owner apply the file in the Supabase SQL Editor.

## Setup

1. **Database**: Supabase dashboard > SQL Editor. The full order is the file names in `supabase/migrations/applied/`, in date order. Files directly in `supabase/migrations/` are not run yet and wait for the owner (see Hard rules).
2. **Manager account**: needs one admin profile. The helper SQL used for the first install is not in this folder any more (see "Older notes").
3. **Host the folder** as a static site. **Vercel**: import the repo, preset "Other", root `./`, no build command. `vercel.json` and `.vercelignore` keep the SQL, test and script folders off the public site. The `api/` functions need their environment variables in the Vercel project settings (listed at the top of each `api/*.js` file), never in the repo.
4. `js/config.js` holds the project URL and the *publishable* key, which is meant to be public. **Never** put the database password or a `service_role` / secret key in this repo.

## Logins

Simple username + password. No emails, no sign-up page: the manager creates every account (Record > Add investor) and hands out the password.

- Passwords are stored as bcrypt hashes. Sign-in gives the phone a random session token (30 days); the database stores only its hash.
- 5 wrong passwords in a row lock that username for 15 minutes.
- Each person can change their own password. The manager can set a new one for anyone (Users > Edit). Changing a password signs that person out elsewhere.
- The manager can deactivate a person (signed out; their units stay in the pool).
- **View as** (Users tab): the manager sees the app exactly as that person does. Read-only, ends after 2 hours.
- On first sign-in, an investor reads and agrees to the terms (saved in the database, append-only). To change the terms edit `termsSections()` / `TERMS_CHECKS` in `js/app.js` and raise `TERMS_VERSION`; everyone agrees again.
- Every table is locked from the website. The page can only call database functions, and every function checks the session token.

| | Sees |
|---|---|
| **Manager** | everyone, all entries; records cash-ins, withdrawals and transfers; settles; creates accounts and resets passwords |
| **Investor** | only their own money (balance chart, fee, withdrawals, entries, statements) and an About page. Also the fund's trading return over time. Never the pool size, units, amounts or anyone else. |

## Statements, activity log and backups

- **Statements** (investors: Statements tab): month-by-month table, a statement for any month, CSV download or Save as PDF. The maths is in `js/returns.js`.
- **Activity log** (manager: Log): who changed what and when, written by database triggers. No row can be edited or deleted.
- **Backups** (manager: Log > Backups): *Download backup (JSON)* any time, plus a **nightly backup** on a computer you control:
  1. In the app press **Create nightly backup key** and copy it (shown once). The key can only read an export. **Revoke all keys** stops it.
  2. Copy `backup.config.example.json` to `backup.config.json` (not committed) and paste the key in. Optional `copyTo` is a second folder.
  3. Test: `node scripts/backup-ledger.mjs`. Schedule: `node scripts/backup-ledger.mjs --schedule 02:30`.
  4. Also run the daily books-vs-MEXC check with the same key: [docs/daily-recon.md](docs/daily-recon.md).
  Backups never contain passwords, so after a restore everyone gets a new password.

## Bot keys

Each bot proves who it is to the ledger with a secret key. The database stores only the hash.

- Wallet report key (one per wallet, used by the wallet report every 5 minutes): `node scripts/new-wallet-key.mjs bbcore "BB-Core"` (same for `icore`, T-CORE). It prints the key (put it in that bot's `mexc-keys.json` as `ledgerWalletKey`, with `ledgerWallet`) and one SQL line to run in the Supabase SQL Editor.
- Bot dashboard intake (`/api/ingest`, `/api/poll`) uses `DASHBOARD_PUSH_SECRET` set in Vercel and on the VPS.

## Docs

| File | What it is |
|---|---|
| [docs/live-nav.md](docs/live-nav.md) | **Current.** The four steps, how the price is made, money rules, discrepancies. |
| [docs/auto-settlement.md](docs/auto-settlement.md) | **Current.** Automatic two-month settlement (not applied yet). |
| [docs/LEDGER-HOW-IT-WORKS-NOW.txt](docs/LEDGER-HOW-IT-WORKS-NOW.txt) | Long walk through of the live state and scenarios (Nov 12). Has an update block at the top. |
| [docs/accounting-model.md](docs/accounting-model.md) | Accounting rules: units, lots, high-water mark, integrity checks. |
| [docs/hwm-settlement.md](docs/hwm-settlement.md) | High-water mark and the two-month settlement rules. |
| [docs/settlement-controls.md](docs/settlement-controls.md) | Settlement window, audited exceptions, complete backups. |
| [docs/true-value-pricing.md](docs/true-value-pricing.md) | Pricing money at "if every open trade closed now". |
| [docs/wallet-snapshots.md](docs/wallet-snapshots.md) | How bots report wallets; the (off) payout cap. |
| [docs/php-contributions.md](docs/php-contributions.md) | Pesos paid, USDT received and the reference rate. |
| [docs/confirmed-gain-fee.md](docs/confirmed-gain-fee.md) | A fee rule built but switched off (`fee_timing = confirmed`); the setting still exists. |
| [docs/daily-recon.md](docs/daily-recon.md) | The daily books-vs-MEXC check and the backup schedule. |
| [docs/full-exit-rounding.md](docs/full-exit-rounding.md) | A rounding edge case on a full exit, and why it is refused. |
| [docs/which-migrations-are-applied.sql](docs/which-migrations-are-applied.sql) | Read-only check of the migrations that are not applied yet. |
| [docs/archive/README.md](docs/archive/README.md) | Documents that describe retired screens or an old state. |

## Older notes (not re-checked on Nov 13 2026)

These were in the old README. They may still be right, but nobody has re-checked them.

- **Test data.** The old README described `supabase/seed-test-data.sql`, `supabase/create-admin.sql` and `supabase/reset-ledger-data.sql`. These files are not in `supabase/` today. `scripts/seed-from-backtest.mjs` and `scripts/simulate.mjs` build test data from backtest trades, and `supabase/diagnostics/reset-ledger-for-live.sql` exists. Backtest results are hypothetical. Before real money, test logins must be deactivated.
- **Fee rules that stop gaming** (from the old flow, tested in `tests/ledger.test.mjs`):

  | Trick | Why it fails |
  |---|---|
  | Top up at a high so the "best level" rises and the fee already earned disappears | The high-water mark is per investor, and a deposit raises it only by the deposit. |
  | Manager raises someone's % after the gains are made | A higher % is only scheduled; it starts after the next settlement. A lower % applies at once. |
  | Several withdrawal requests that together exceed what is unlocked, or paying one twice | Pending requests count against unlocked units; a request is paid only once. |
  | Using an instant deposit to skip checks | `admin_deposit` is not callable from the website. |

  The old rule "new money waits for the next equity reading" and the quarterly close are replaced by the live price and the two-month settlement above.
- **Lock-up.** Wording says 3 months per deposit and withdrawals paid within 7 business days. `lock_enforced = 0` on live, so the lock-up is guidance, not enforced by the database.
- **What the software cannot police:** the manager's own MEXC actions and the dates of late entries. Everything is logged and auditable after the fact. Sharing a monthly MEXC statement lets investors check.

## Disclaimer

Records of a share in a pooled account. Not a bank balance, not insured, no guaranteed returns; backtested results are hypothetical. Money placed here can be lost. Check with a Philippine securities lawyer before accepting other people's money (pooled-fund arrangements can count as investment contracts under SEC rules).

# Per-wallet snapshots, combined NAV and the payout cap

Status: **implemented and tested on an in-memory database; not applied to any real database; nothing here has talked to MEXC or Supabase.**
Migration: [`20261130000000_wallet_snapshots.sql`](../supabase/migrations/20261130000000_wallet_snapshots.sql) (rollback: `supabase/rollback/20261130000000_rollback_wallet_snapshots.sql`).
Tests: `tests/wallet-snapshots.test.mjs` (WS1–WS11, ledger side), `test/ledger-wallet-test.js` in each bot repo (bot side, stubbed network).
Everything is **off by default** (`wallet_nav_mode = 'off'`, `payout_cap_mode = 'off'`); with both off, no existing function behaves differently (the full existing suite passes unchanged).

## The problem it solves

The pool runs two strategy wallets (BB-Core, I-Core), each its own MEXC account. The ledger values the pool from ONE typed "exchange total", and the old payout rule
waits for a moment with no open trade, which with two bots almost never comes (0.3% of the time in the 2022–2026 backtest). Valuing with open trades needs the
two wallets' real equity, and paying out needs to know how much can really leave the exchange.

## Trust model: how a bot reports

- Each wallet has **its own secret**. `bot_wallets` stores only its SHA-256 hash (the same pattern as `bot_key_hash`). A key works for its wallet only; a wrong key, an
  unknown wallet and an inactive wallet all answer `not allowed`. Keys are made with `node scripts/new-wallet-key.mjs <wallet> "<label>"` (rotate by running it again).
- The report is `bot_post_wallet_snapshot(key, wallet, seq, reported_at, equity, unrealized, withdrawable, available, open_positions, open_orders)`:
  - **Replay protection.** `seq` must only go up (the bots send the clock in milliseconds). The same report again is a harmless retry (`replayed: true`); the same
    `seq` with other data, or a lower `seq`, is refused.
  - **Clock.** The bot's own timestamp must be within 5 minutes of the ledger's (else refused). **Staleness is judged only on the ledger's clock** (`received_at`).
  - **Amounts.** More than 6 decimals is refused, never rounded silently. Negative equity or withdrawable is refused. An unknown count of positions or orders is refused.
  - **Jumps.** A wallet equity change of more than 50% since its previous snapshot is stored as **suspect**; it blocks use until the manager accepts it with a written
    reason (`admin_accept_wallet_snapshot`, in the activity log). Legitimate causes: a deposit, a transfer between the wallets.
  - **Append-only.** Snapshots can never be edited or deleted (only the acceptance note can be added).
- What the bots send is only what MEXC returned for their own account: `equity` (total equity), `unrealized`, `cashBalance` (MEXC's documented *withdrawable balance*),
  `availableBalance`, and the real counts of open positions and orders. If equity or `cashBalance` is missing, **nothing is sent**: it is never replaced by zero,
  by equity, or by the available balance. The bot code is off by default (`ledgerWalletSync: false`); `node <bot>.js ledger-wallet-sync [--dry]` sends one report.
- **Weak point, stated plainly:** whoever holds a wallet's key can misreport that wallet. The defences are the suspect-jump flag, the typed total having to match the
  wallets (mode `require`), and the manager's own balance check against the exchange app. They do not make a stolen key harmless.

## Combined NAV (`_wallet_nav`)

For each active wallet the newest snapshot is classed `ok`, `missing`, `stale` (older than `wallet_max_age_minutes`, 30), `suspect`, or `outdated` (a payout was sent from the
exchange after it was taken, so it still shows that money). The combined view is `ok` only if **every active wallet is ok, at least `wallet_expected_count` (2) are
registered, and the newest snapshots were received within `wallet_max_skew_minutes` (10) of each other** (so a transfer between the wallets cannot be counted twice or
missed). When not ok **no number is returned** (`combined_equity_usdt` is null), never a zero and never a partial sum.

- `combined equity = Σ wallet equity`. Equity already includes unrealized P&L, so unrealized and realized are stored but **never added again**; realizing a gain does not
  move equity; a transfer between the wallets cancels in the sum. (Tested against an independent model, WS6.)
- `pool NAV (wallet mode) = typed exchange total − money waiting to join − money redeemed but not yet sent`. Money waiting to join is in Spot (default) or inside a Futures
  wallet (`queued_money_location`), and the check handles both: the typed total must equal `combined equity (+ waiting money, if it waits in Spot)` within the pool
  tolerance (max 0.50 USDT or 0.05%).
- With `wallet_nav_mode = 'require'`: every valuation (post equity, settlement, withdrawal, quote, preview) first needs `ok` wallets and that agreement; otherwise it is
  refused with `WALLETS NOT READY` / `WALLET MISMATCH` and nothing is saved. 1112's "pending live P/L" guards and the single-snapshot reconciliation are skipped (closed
  trades are already in the wallets' equity), and the balance check's "no open positions" reason no longer blocks capital. Every other reason still does.

## Payout cap

`payable now = floor6( Σ transferable × (1 − payout_buffer_pct) − payout_buffer_usdt − money redeemed but not yet sent )`, where a wallet's transferable is the **smallest of
equity, `cashBalance` and `availableBalance`**. Defaults: 5% and 5 USDT (to confirm). With `payout_cap_mode = 'require'`, `admin_withdraw` (which the Money out form and
the workflow's redemption both use) checks the payout inside the same transaction: if the wallets are not usable it is `PAYOUT BLOCKED`, if it does not fit it is
`PAYOUT QUEUED`; either way **nothing is saved, the investor keeps their units, the request stays approved and waiting, and no trade is closed.** A retry of a payout
already made is a replay and is not re-checked. Paying from the manager's own money (`admin_withdraw_to_manager`) moves nothing out of the exchange and is not capped.
`admin_withdrawal_queue` shows what fits now (amounts are estimates, units × price, before fees). `admin_split_withdrawal_request` splits an approved request so part can
be paid now and the rest stays queued (units conserved exactly, audited).

## What this does NOT do (and the exact reason)

- **It has not been run against MEXC or Supabase.** The bot tests stub the network. That MEXC's asset response carries `cashBalance` and what it means rests on MEXC's own
  documentation page (it lists `cashBalance` as the withdrawable balance); whether a futures→spot transfer honours exactly that amount is not documented, which is what
  the buffer is for.
- **The bots must report far more often than every 4 hours** for the 30-minute freshness rule to hold. The bots' trading loop is not changed; run
  `ledger-wallet-sync` from cron every 5 minutes. Until then, turning the modes on blocks everything.
- **`capital-sync.js`** (in the bot repos) is an older, separate path: it adds both bots' journal readings into one total and posts it through `bot_post_snapshot`. It
  carries no withdrawable amount and no per-wallet authentication. It is untouched. Decide whether to retire it once wallet reporting is live.
- **The balance-check workflow** (`admin_enter_balance`, residuals, classification) is unchanged apart from the open-positions reason. With open trades every period has a
  trading-P&L difference to classify; making wallet snapshots replace that check is a larger redesign.
- **Exchange transfer precision** is unresolved: see [full-exit-rounding.md](full-exit-rounding.md).

## Turn-on checklist (staging first)

1. Apply the migrations in order; register both wallets (`new-wallet-key.mjs`), put the keys in each bot's `mexc-keys.json`, set `"ledgerWalletSync": true` or add the cron
   `ledger-wallet-sync` every 5 minutes. Use `--dry` first.
2. Watch `admin_wallet_nav`: both wallets `ok`, equities as the exchange app shows, `combined_equity` = the app's total.
3. Set `wallet_nav_mode = 'require'`; do a valuation; confirm the typed total must match.
4. Set `payout_cap_mode = 'require'`; try a payout above and below `payable_now`.
5. To go back at any time: `supabase/rollback/20261130000000_rollback_wallet_snapshots.sql`.

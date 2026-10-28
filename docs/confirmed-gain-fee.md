# Confirmed-gain performance fee (`fee_timing = 'confirmed'`)

Status: **implemented and tested on an in-memory database, not applied to any real database.** Migration:
[`20261127000000_confirmed_gain_fee.sql`](../supabase/migrations/20261127000000_confirmed_gain_fee.sql) (rollback:
`supabase/rollback/20261127000000_rollback_confirmed_gain_fee.sql`). Tests: `tests/confirmed-fee.test.mjs`.

## Why

The pool runs two strategies on five coins. In the 2022-2026 backtest it had no open trade only 0.3% of the time, so "settle when flat"
almost never happens. Settling with trades open means valuing open gains, and a fee on an open gain can be charged and then reversed.
This rule removes that risk without a refund reserve: **a gain becomes chargeable only once it is still there at the next settlement.**

## The rule (per investor; E = value now, H = mark, L = value right after the previous settlement, r = fee rate)

| Event | Rule |
|---|---|
| Settlement | fee = r_c × max(0, min(E, L) − H), with r_c = min(rate at the previous settlement, rate now). If min(E, L) > H: H := min(E, L) − fee. Always: L := E − fee. |
| Deposit D | H += D, L += D (a deposit is never profit). Coming in with no units: the current rate applies. |
| Withdrawal of share s | fee = s × (r_c × confirmed + r × pending), confirmed = max(0, min(E, L) − H), pending = max(0, E − max(L, H)). In profit: H, L × (1 − s). At or below the mark: H −= s × E, L −= s × min(E, L) (the whole shortfall stays). |
| 0% rate | no fee, the mark still moves up (gains made at 0% are never charged later, as in 1105). |

Money that leaves pays at once (it has no next settlement). Withdrawing and re-depositing while in profit therefore pays the pending part
early; while below the mark it changes nothing.

**Independent statement of the same rule** (one investor, no flows; `tests/confirmed-fee.test.mjs` part 3): after every event,
fees paid so far = r × max(0, highest confirmed gross level − capital), where gross level = value + fees already paid, and a settlement's
confirmed level is the lower of its gross level and the previous settlement's (an exit counts as confirmed).

## Worked numbers (20%, John 1,000 units at 1.00; all in the tests)

| Case | Steps | Fees |
|---|---|---|
| A | settle 1.10, 1.20, 1.30 | 0, 20, 20 (marks 1,000, 1,080, 1,160) |
| B | settle 1.10, 1.00, 1.10, 1.10 | 0, 0, 0, 20 |
| C | settle 1.10, 1.05 | 0, 10 |
| D | settle 1.10; withdraw 50% at 1.20; settle 1.20 | 0; 20 (paid 580); 10 |
| E | settle 1.10; deposit 550 at 1.10; settle 1.10 | 0; -; 20 |
| G | 0%: settle 1.10; raise to 20%; settle 1.10, 1.20, 1.20 | 0, 0, 0, 20 |
| H | settle 1.10; withdraw 50%, then 50% of the rest at 1.20; deposit 600; settle 1.20 twice; full exit | 20, 10, 5, 5, 0 = 40 on the 200 gain; paid 1,760 for 1,600 in |

## Open trades

Under `confirmed`, open positions no longer block a settlement; `_settlement_requirements` returns them under `warnings` (shown by the preview
and saved in the activity log). Under `immediate` the 1109 `open_positions` exception is still required. Reconciliation, the window and
backdating rules are unchanged.

## What is stored

- `investor_hwm.last_value` (L) and `rate_last` (rate in force up to the last settlement); `hwm_log` keeps their before-values, so undo is exact.
- `settlement_lines`: `fee_timing`, `last_value_before`, `confirmed_profit`, `pending_profit`, `rate_applied`, `last_value_after`. `eligible_profit`
  keeps its meaning (E − H).
- `admin_settlement_preview` lines add `confirmed_profit_usdt`, `pending_profit_usdt`, `last_value_usdt`, `rate_applied`; the result adds `warnings` and `fee_timing`.

## Cutover and rollout

- **Cutover: L := H.** That is fee-equivalent to the true last-settlement level (right after any close, L ≤ H). Consequence: **nobody is charged
  at the first settlement after the migration**; the current period's fee arrives one settlement later. No ledger row, unit or mark changes.
- Rollback: `fee_timing = 'immediate'` (the rollback file). The next settlement then charges everything not charged yet, once.
- Before applying: rehearse on a restored backup (`npm run rehearse`), update the investor terms and `reports/how-lucid-io-works*.html`
  (the fee now lands one settlement later; a withdrawal pays the pending part at once), and ask every investor to agree again.

## Not covered here (step 2)

Valuing the two strategy wallets as one NAV with open positions in the Update Pool / balance-check flow, and capping payouts at the
transferable balance with the rest queued. `_holder_summary.accrued_fee_usdt` still shows r × (E − H), which is what a full exit would pay
when the rate has not changed; the app does not yet show confirmed vs pending.

## Related withdrawal changes (separate files, separate approval)

- [`20261128000000_withdraw_quote.sql`](../supabase/migrations/20261128000000_withdraw_quote.sql): `admin_quote_withdraw`, read-only. The Money out
  preview (`js/app.js` `wdPrev`) now shows the database's own quote (the real withdrawal, rolled back) instead of the browser's `lotFee` estimate,
  which did not know the confirmed-gain rate rule. Tests: `tests/withdraw-safety.test.mjs` W1, W2, W6.
- **Full-exit rounding: no change.** An earlier proposal to cap the payout at the pool equity was withdrawn: the exchange's USDT precision is not documented, so a
  7-decimal payout could not be reconciled with the transfer. The refusal stays. See [full-exit-rounding.md](full-exit-rounding.md) for the options and the
  decision needed. Tests: W3 (the refusal, nothing saved, and the 6-decimal exit paying exactly the pool), W4 (every payout equals round(net × price, 6)).

## Accrued fee and the settlement preview (in 1127)

- `_holder_summary.accrued_fee_usdt` is now the fee a **full exit would charge right now**, computed by `_hwm_take(..., null)`, the same function the real
  withdrawal calls, so it follows the confirmed-gain rule and the rate-change rule. Under `fee_timing = 'immediate'` it equals the old `rate × (value − mark)`.
- `admin_settlement_preview` returns `preview_hash`. With `settlement_preview_mode = 'require'` (default `'off'`), `admin_close_quarter` and the workflow's
  `admin_settle_quarter` refuse unless they are given the hash of a preview of the **current** books. The check runs inside the settlement's transaction under the
  ledger lock, before any write. The hash covers the newest pool entry, total units, every investor's units, mark, last value and rates, waiting deposits, the
  fee rule, the exchange total and the settlement period. It expires when the books change, not by the clock.

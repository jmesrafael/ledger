# Full exit and rounding: the edge, what was established, and the decision still needed

Status: **no code change.** The refusal stays. Test: `tests/withdraw-safety.test.mjs` W3.

## The edge

`admin_withdraw` (1105, section 6) pays `round(net units × price, 6)` and refuses with `payout exceeds pool equity` if that is more than the pool equity.
When the person leaving holds **every** unit (no fee units belong to anyone else) and the exchange total they were valued at has **more than 6 decimals**
(for example 1234.5678916), rounding half up gives 1234.567892, which is more than the pool holds, and the whole withdrawal is refused. Nothing is saved
(W3 asserts the books are unchanged). The same exit valued at a 6-decimal total (1234.567891) pays exactly the pool.

Why it is rare: units are issued and the pool is valued in USDT to 6 decimals. A total typed by hand with more than 6 decimals, or a bot reading that was not
rounded, is the only way in. The bots round their equity to 6 decimals before sending it (`ledger-sync.js`: `Math.round(equity * 1e6) / 1e6`), and the new
per-wallet snapshot function **refuses** more than 6 decimals instead of rounding, so a total built from wallet snapshots never reaches this edge.

## What was investigated

- **Exchange precision.** MEXC's futures API page for the single-currency asset (`GET api/v1/private/account/asset/{currency}`) lists the fields as `decimal`
  without stating a number of decimal places, and the withdrawal and transfer pages I could reach do not state one for USDT either. **No exchange-supported
  precision for USDT transfers or withdrawals was established.** I did not guess one.
- **Candidate rules** and why none is adopted:

| Rule | Effect | Why not adopted |
|---|---|---|
| Pay `least(round(net × price, 6), pool equity)` (my earlier 1129) | The refused case pays exactly the pool, which can have 7+ decimals | The payout may have more decimals than the exchange accepts, so the manager would send a different amount from the one booked: an unreconciled difference. Withdrawn. |
| Pay the payout rounded **down** to 6 decimals, leave the remainder | Payout always ≤ pool | The remainder (under 0.000001 USDT) stays in a pool with no units: equity ≠ price × units, which the books check rejects, or it is dust nobody owns. |
| Reject any valuation total with more than 6 decimals | The edge cannot arise | Safe, but it changes validation for every valuation and breaks flows that pass arbitrary floats. It would need its own decision and test pass. |
| Refuse (current) | The last holder's exit fails with a clear message until the total is entered to 6 decimals | Safe: nothing is saved, nothing is guessed. Costs one retry. |

## Workaround today

Enter the exchange total rounded to 6 decimals (or fewer). A total taken from the wallet snapshots already has at most 6 decimals.

## Decision needed from you

1. **What decimal places does your exchange accept for a USDT withdrawal or transfer?** Check the withdrawal page of the account you pay from, or the
   transfer endpoint's documentation, and tell me the number. If it is 6 or more, "reject totals with more than 6 decimals" (row 3) is safe to add.
   If it is fewer than 6 (for example 2 or 4), then payouts themselves (not only this edge) need a precision rule, and that is a larger change: a payout would
   have to be rounded **down to the exchange's precision**, with the difference either returned to the investor's units or kept as a separate, visible
   rounding line. That is an accounting policy change, so I have not done it.
2. Who owns the sub-precision remainder: the investor (units stay), the fund manager, or the pool?

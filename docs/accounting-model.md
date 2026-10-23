# Lucid'io Ledger: accounting model and integrity remediation

> **Update (migration [`20261105000000_hwm_arrival_lockup.sql`](../supabase/migrations/20261105000000_hwm_arrival_lockup.sql), tests in
> `tests/hwm.test.mjs`).** It replaces the flat period fee in section 3 with a **high-water mark per investor** (`fee_engine = 'investor_hwm_v2'`).
> E = units × price, H = `investor_hwm.hwm_value`:
> deposit D → H += D · close with E > H → fee = rate × (E − H), H := value after fee · withdrawal of share s → fee = rate × max(0, E − H) × s,
> H := H − s × min(E, H) (a shortfall is never reduced by taking money out; a full exit keeps it, and money that comes back adds to it).
> So the uncharged gain (or shortfall) E − H moves only with the unit price and with fees. Cutover: H = value after the last close.
> Also: a waiting deposit is taken out of the MEXC total and joins **only once marked in MEXC** (`arrived_at`), whatever `settlement_gate` is;
> any deposit not in MEXC needs an explicit yes on a reading and stops `bot_post_equity`. The lock-up is guidance: only an investor's
> first deposit gets `lock_until`, and withdrawals are not refused unless `lock_enforced = '1'`. Sections 3 and 7 below describe the previous rule.

Status: **implemented and tested, not applied to any database.** The change is one migration,
[`20261101000000_ledger_integrity.sql`](../supabase/migrations/20261101000000_ledger_integrity.sql), plus small changes to
[`js/app.js`](../js/app.js) and the bot's `ledger-sync.js`. Read section 9 before running it anywhere.

## 1. Where every number comes from

| Value | Source of truth | Written by |
|---|---|---|
| Pool equity (NAV) | `pool_equity.equity_usdt` of the newest row: the MEXC total typed by the manager or sent by the bot, **minus money still waiting to join** | `admin_post_equity`, `admin_close_quarter`, `admin_withdraw`, `_convert_pending`, `bot_post_equity`, `admin_undo_last` |
| Outstanding units | `sum(ledger.units)` (every person, the manager included) | ledger inserts only |
| One person's units | `sum(ledger.units) where profile_id = …` | same |
| Manager units | the same, for the one `role = 'admin'` profile: own deposits + every `fee_in` | same |
| Unit price | `pool_equity.unit_price` of the newest row = NAV ÷ outstanding units | same as NAV |
| Period profit of an investor | computed, not stored: `_period_profit` over `pool_equity` and `ledger`; `investor_period.credit` = what a withdrawal already settled this period | `_period_take`, `_period_close`, `_period_revert` |
| Pending deposits | `pending_deposits` (`pending` → `converted` / `cancelled`; `arrived_at` once the money is in MEXC) | `admin_receive_deposit`, `admin_mark_arrived`, `bot_post_snapshot`, `_convert_pending`, `admin_cancel_pending` |
| Pending withdrawals | `withdrawal_requests` (`pending` → `paid` / `cancelled`) | `request_withdrawal`, `admin_withdraw`, `cancel_withdrawal_request` |
| Accrued fee | not stored: `rate × max(0, units × price − hwm_value)`, computed in `_holder_summary` | — |
| Settled fees | `ledger` pairs `fee_out` (investor, −units) / `fee_in` (manager, +units) with the same `equity_id` | `admin_close_quarter`, `admin_withdraw` |
| MEXC snapshots and transfers | `exchange_snapshots`, `exchange_transfers` (unique `ext_id`), `transfer_matches`, `snapshot_attestations` | `bot_post_snapshot`, `admin_classify_transfer`, `admin_attest_snapshot` |
| Realized / unrealized PnL, trading fees, funding | **not separated in the ledger.** They are inside the MEXC total. The bot keeps per-trade R, fees and funding in its own `state/`. The snapshot has fields for unrealized and realized PnL; the bot sends unrealized, but not yet realized PnL or the transfer history (section 7). | — |
| Corrections | `pool_equity.reversed_of` / `ledger.reversed_of` (each unique) and `corrections` (one row per reversed entry) | `admin_undo_last` |

Every function above is `security definer`, callable only with a manager session token (or the bot key for `bot_*`), and every table is closed to the website (RLS, all privileges revoked).

## 2. Unit accounting and its invariants

```
unit price P        = NAV ÷ U                     U = all outstanding units, the manager's included
deposit of D        units = round(D ÷ P, 8) at the NEXT valuation; P unchanged
withdrawal of n     paid  = round((n − fee) × P, 6); P unchanged
trading             changes NAV, so P; never anyone's units
fee                 fee units move from the investor to the manager; U, NAV and P unchanged
```

**Why the manager's units are in the denominator.** They are a real claim on the MEXC balance, so they must be. If U left them out, P would
be NAV ÷ investor units: every investor would be overstated by the manager's share, and each fee would *raise* the price, so investors
would be handed back part of the fee they had just paid. With them included, a fee is a pure transfer of ownership.

`_check_books()` runs at the end of every money write and rolls the whole write back if any of these fail:

1. `sum(ledger.units)` equals `total_units` of the newest `pool_equity` row.
2. In that row, `equity_usdt` = `unit_price × total_units` (tolerance 0.0001 USDT).
3. No person's units are negative.
4. All `fee_in` + `fee_out` units sum to zero.

Rounding: units are rounded to 8 decimals and USDT to 6. Fee units are always rounded **down** at the 8th decimal (they never round in the
manager's favour). Repeating-decimal noise is cleared at 12 decimals first, so an exact 1 unit stays 1. Worst case in the manager's
favour: under 5×10⁻¹³ units.

## 3. The performance fee: a flat rate on each period's net trading profit

Policy (fee_engine `flat_period_v1`): at each quarter close an investor pays **their fee rate (10% by default) of the net trading profit their
units made in that period, if it is positive**. A loss or zero profit costs nothing. **Nothing is carried between periods**: there is no
high-water mark, no recovery of earlier losses, no per-deposit line. (This replaced two earlier drafts: per-deposit lots, and an
investor-level high-water mark. The investor-level draft was never applied to any database.)

### Why the profit can be calculated exactly

The unit price changes **only** with trading. Deposits, withdrawals and fee transfers all happen at the current price and never move it.
So the profit of one person is a sum over the pool entries (`pool_equity` rows) in the period:

```
profit_i = SUM over entries e in the period of   units_i(just before e)  x  ( price(e) - price(entry before e) )
units_i(just before e) = SUM of i's ledger.units with equity_id < e.id        (_period_profit)
```

- Deposits are never profit: a deposit adds units at the current price, with no price move of its own.
- Withdrawals are never losses: selling units changes units, not price.
- A newcomer held 0 units before joining, so they earn nothing from earlier moves. A leaver keeps the profit earned while holding units.
- Fee transfers move units at the settlement price; NAV and price are unchanged.
- The period is "after the newest `close` entry, up to now". With no close yet it is the whole ledger.

### Formulas (per investor; r = the person's `fee_rate`; P = unit price at the settlement)

```
quarter close      fee   = r x max(0, profit_i - credit_i)               (USDT)
                   units = floor8( fee / P )                             rounded DOWN to 8 decimals: rounding never overcharges
                   then   credit_i := 0   for everyone                   a new period starts
withdrawal         s     = units sold / units held
                   fee   = r x max(0, profit_i - credit_i) x s           the same share of the profit so far
                   credit_i := profit_i - (1 - s) x (profit_i - credit_i)
                   (the units that stay keep (1 - s) of the profit or loss so far, and it is settled at the quarter close)
full exit (s = 1)  settles all of the profit so far; a loss so far is forgiven
```

`credit_i` (table `investor_period`) is only what a withdrawal has already settled within the current period. With no withdrawals it is 0.

### Worked example (tests B1, B4, B7, B11)

- John 1,000 units at 1.00, price 1.10: profit 100, fee 10 USDT = 9.09090909 units.
- Period 2 falls to 0.80 and the next goes to 0.90: period 2 pays 0; period 3 earns 1,000 x 0.10 = 100 and **pays 10 USDT although John is still
  below what he put in**. That is the rule.
- Dino joins at 1.20 (416.67 units); price goes to 1.32. John earned 1,000 x 0.32 = 320 (fee 32); Dino earned 416.67 x 0.12 = 50 (fee 5).
  Dino pays nothing on the 1.00 -> 1.20 move.
- John sells 40% at 1.20 with +200 so far: fee 10% x 200 x 0.4 = 8 USDT. At 1.50 the 600 units that stayed have 120 + 180 = 300: fee 30.
  Total 38 = 10% x (1,000 x 0.20 + 600 x 0.30).

### Fee-rate changes

Unchanged: a higher rate is stored in `fee_rate_next` and starts after the next close; a lower rate applies at once. The rate used is each
person's own `fee_rate`; the migration prints a notice if any investor is not on 10%.

### Limits of this definition

- "Net trading profit" is the unit-price change. It is as reliable as the valuations behind it. A MEXC transfer that was not recorded
  looks like trading profit or loss (section 7 is the control for that). With `settlement_gate = 'on'` a settlement is only allowed when the
  pool is flat, so the profit is realized.
- With the gate off, a settlement can charge a fee on unrealized gain, and fees already charged are never refunded after a later loss.
- Fee is per investor, not netted across investors: an investor who joined at a local peak and lost pays nothing even if the pool as a
  whole made money over the period.
- The manager's own units (and the fee units they receive) pay no fee.

## 4. Order of a valuation event

Everything below runs inside **one** database transaction, after `_ledger_lock()`. No other money write can start until it commits, and
every read of the books is one consistent statement snapshot (Postgres MVCC).

1. Lock, then replay check: an `p_idem` that was already used returns the stored result.
2. Validity checks: settlement spacing (80 days), the settlement gate, sanity checks (`_check_move`: a move of more than 25%, or unmatched MEXC transfers, needs `p_confirm`).
3. NAV = typed MEXC total − waiting money that is in MEXC (`_pending_total`; only *arrived* money when `settlement_gate = 'on'`).
4. Price P = NAV ÷ U (before any new units).
5. The pool entry (`update`, `close` or `withdrawal`) is written at P.
6. Settlement only: fee per investor on the period profit at P (`fee_out` / `fee_in` pairs), `credit` reset to 0. Then raised fee rates take effect.
7. Withdrawal only: fee on the redeemed share, units redeemed at P, request marked paid.
8. Waiting deposits buy units at the same P, each with its own `deposit` entry (a new deposit never pays for, or shares in, the period that is ending).
9. `_check_books()`; the idempotency key is stored with the result; commit.

## 5. Corrections

- Only the newest entry can be undone, and never a quarter close (unchanged).
- **A correction can never be undone.** The fix is to enter the right entry again. The database refuses (`admin_undo_last`), and the app
  no longer shows Edit or Delete on a correction row.
- Each entry can be reversed once. This is enforced by unique indexes on `pool_equity.reversed_of` and `ledger.reversed_of`, and the
  `corrections` table has one row per original.
- An undo of a withdrawal restores the period credit from `period_log`. Rows are marked `reverted_at` and never deleted.
- A deposit undone this way goes back to *waiting*. The manager then hands it back (`admin_cancel_pending`) or lets it join at the next reading.

## 6. Concurrency and retries

- Every function that writes money or units takes `pg_advisory_xact_lock(7461001)` before its first read of the books. One writer at a
  time, across every process: website, bot, scripts. The lock is released at commit or rollback, so a crashed session cannot leave it held.
- The money writes in the app send a request id (`p_idem`), kept on the form until the write succeeds. A resend after a lost reply
  returns the stored result (`replayed: true`) instead of repeating the write. Keys are unique in `idempotency_keys`, and a key reused for
  a different operation is refused.
- Database constraints back this up: one ledger entry per paid request; one conversion per waiting deposit; one reversal per entry; one
  record per MEXC transfer id.
- Deadlocks: all money writes take the same single lock first, so they cannot deadlock against each other. A statement timeout surfaces
  as an error with nothing saved; the app's resend carries the same request id.
- Verified on real PostgreSQL 16 with overlapping connections (`npm run test:race`, needs Docker): two simultaneous settlements, one
  request paid twice at once, racing valuations and deposits, a correction raced by a settlement, and five retries of one settlement.
  The old schema double-charged, double-paid and left the newest entry disagreeing with the ledger. The new one does none of these.

## 7. MEXC reconciliation and the settlement gate

- The bot sends `bot_post_snapshot` each run: balance, unrealized PnL, open positions, open orders and (when available) transfers.
  Transfers are stored once per `ext_id`. An inbound transfer is matched to a waiting deposit of the same amount (±0.01 USDT), which
  marks it *arrived*; an outbound transfer is matched to a recorded withdrawal of the same amount. Anything unmatched stays visible
  until the manager classifies it with a written reason (`admin_classify_transfer`, kept forever).
- An unmatched transfer stops `bot_post_equity`, and a typed reading needs an explicit confirmation, which is written into the entry's note.
- Reconciliation per snapshot: `expected = previous snapshot + transfers in − transfers out + realized PnL since + change in unrealized`.
  A difference above max(0.50 USDT, 0.05%), an incomplete transfer history, or missing realized PnL marks the snapshot `blocked`.
- With `settlement_gate = 'on'`, a fee settlement needs all of these:
  - a snapshot under 12 hours old;
  - zero open positions and zero open orders;
  - no unmatched transfers;
  - a clean reconciliation, or the manager's written attestation;
  - a typed equity within tolerance of the snapshot.

  The gate also makes only *arrived* deposits count. **This is the "settle only when flat" policy.** With the gate on, fee settlement is
  effectively realized-only, because nothing is open.
- With the gate `off` (the default after migration), settlement works as before: full NAV, including any open trades, at the manager's discretion.
- **Not implemented yet:** the bot's MEXC client has no endpoint for transfer history or realized PnL, so the bot always sends
  `transfers_complete = false` and `realized_since = null`. Until that exists, every settlement with the gate on needs a written attestation.
- An exchange error is never a zero balance. The bot sends nothing when the MEXC read failed, and the database refuses a missing or
  non-positive equity.

## 8. Read-only diagnostics

- **Before migrating:** [`supabase/diagnostics/pre-migration-integrity.sql`](../supabase/diagnostics/pre-migration-integrity.sql), plain
  SELECTs. It returns one row per check (severity, count, entry or account ids only).
- **After migrating:** `select public.admin_integrity_report('<manager token>')`. This runs the same checks on the migrated ledger. (The earlier
  draft's replay of an old fee rule over history is gone: the flat rule has no history to replay; each close can be recomputed with
  `_period_profit`.)
- Neither repairs anything. If a check fails, the plan is: export a backup; list the affected entries; for each one decide the correct
  compensating entry; record it as a new, explained entry (never by editing or deleting history); re-run the diagnostics.
- Historical settlements stay historical facts. The new rule is not applied backwards; any refund for a past overcharge would be a
  separate, reviewed decision.

## 9. Rollout, rollback, resume

1. **Run the diagnostic** (section 8) on the live database. The migration's own preflight refuses to run if an entry was reversed more
   than once or if ledger units and per-deposit lines disagree. Resolve those first.
2. **Back up** (`backup-ledger.cmd` or the manager's export).
3. **Staging first:** restore the backup into a separate Supabase project, apply the migration there, run section 10.
4. **Production:** apply in the SQL Editor, then move the file to `supabase/migrations/applied/`. The migration's statements are
   idempotent (`if not exists`, `create or replace`, `on conflict do nothing`). If it stops halfway, fix the cause and run the whole file
   again; the cutover credits only seed while `investor_period` is empty. If the EARLIER DRAFT (investor-level high-water mark; tables `investor_perf` / `perf_log`, `fee_engine = 'investor_hwm_v1'`) was applied,
   the same file upgrades it: those two tables are renamed `*_draft_archive` (nothing deleted), the unused `_perf_*` functions are dropped, and
   `fee_engine` becomes `flat_period_v1`. If the draft's tables exist but `fee_engine` is anything else, the file stops without changing anything.
5. Leave `settlement_gate = 'off'` until the bot sends snapshots and you have practised one attestation; then turn it on.
6. **Engines never overlap.** From the migration on, every settlement uses the flat period engine (`fee_engine = 'flat_period_v1'`).
   The per-deposit tables stop changing at that moment and stay as history.

**Rollback.**
- *Before any new money write:* re-run the old function definitions from the applied migrations. Nothing in the books has changed;
  `holder_lots` is exactly as it was.
- *After a write under the new engine:* there is no switch back. `holder_lots` no longer reflects later deposits, withdrawals or fees.
  Going back would be a reviewed rebuild of the lots from the ledger, not a revert. This is the point of no return, which is why steps 1 to 3 come first.
- Settings can be changed at any time without code: `books_check` (`enforce` / `warn` / `off`, as an emergency valve only),
  `settlement_gate`, `valuation_max_move`, `snapshot_max_age_hours`, `recon_tolerance_abs` and `recon_tolerance_pct`.

### Which state is this database in? (read-only)

```sql
select (select value from public.ledger_settings where key = 'fee_engine')          as fee_engine,        -- investor_hwm_v1 = the earlier draft; flat_period_v1 = done; null = neither
       to_regclass('public.investor_perf') is not null                               as has_draft_tables,
       to_regclass('public.investor_period') is not null                             as has_flat_tables,
       (select count(*) from public.pool_equity)                                     as entries,
       (select max(ts) from public.pool_equity)                                      as last_entry;
```

## 10. Staging verification

1. `npm test` (80+ tests on PGlite) and `npm run test:race` (real PostgreSQL in Docker) pass.
2. In staging, before the migration: run the diagnostic. Every count should be 0.
3. Note each investor's units, value and "owed this quarter".
4. Apply the migration. Units and values must be identical. "Owed this quarter" is identical for single-deposit investors and can only
   be lower for investors with several deposits (the policy change).
5. Run `admin_integrity_report`: nothing critical. Review any flagged historical overcharge.
6. In the app (staging URL):
   - post a reading;
   - Delete it; the Delete button should disappear from the correction row;
   - receive a deposit and join it;
   - pay a withdrawal request;
   - type a balance 30% away from the last one and see the confirmation.
7. Point a test bot (paper mode, the staging `ledgerUrl`) at staging. Check that snapshots arrive, then turn `settlement_gate` on and
   check that a settlement is refused while a trade is open.
8. Settle once in staging and compare each fee against the formulas in section 3 by hand.

## 11. Assumptions and open questions

- **Cutover of the current period.** Profit already earned in the current period is in the history, so it is charged at the first close
  under the new rule. Exception: an investor who withdrew during the current period had the fee on the withdrawn share taken by the OLD
  rule, so the profit counted so far for them is forgiven once (`credit`), to avoid charging that share twice. Check this list in staging.
- **No loss recovery** is a business decision (rule 6 of the brief), disclosed in the investor terms (version `2026-10-23`: every investor is
  asked to agree again). The guide `reports/how-lucid-io-works.html` still describes the old best-ever-level rule and its figures were
  generated from it: it must be regenerated before it is shared.
- **Default fee rate.** New accounts still default to 10% (`ledger_settings.default_fee_rate`). The 15% default you proposed is a business
  and terms change. It is not applied here: change the setting and the investor terms together. 10%, 15% and 20% are all supported per person.
- **"Withdraw all"** pays everything that is left after any fee. A request for more units than remain is capped, not refused.
- **Realized-only fee crystallisation** is available as the settlement gate, but it is not the default, because the bot cannot yet prove
  the transfer history (section 7).

## 12. What is still needed before real money

- The bot's transfer history and realized PnL from MEXC (endpoints, mocked tests, then a live read-only check).
- A legal review of the investor terms against the new fee rule (no loss recovery). The Philippine SEC position on pooled
  investment from friends and family has not been resolved.
- A human review of this migration by someone other than its author, and a staging run on a copy of the real data.
- Operational controls: who may type valuations; a monthly reconciliation against MEXC statements; the backup restore actually tested.

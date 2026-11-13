# Every money-in / money-out / profit-sharing scenario: solved or not

Written 2026-10-28 for the manager. "Today" means your database as you described it: migrations up to 1126 applied plus 1127, 1128 and 1130, with
`fee_timing = 'immediate'` (the old fee rule) and `wallet_nav_mode`, `payout_cap_mode` and `settlement_preview_mode` all `off`.

| Mark | Meaning |
|---|---|
| ✅ | Solved and working today |
| 🟡 | Solved in the code, but switched off or needs setup first (see [NEXT-STEPS-GUIDE.md](NEXT-STEPS-GUIDE.md)) |
| ❌ | Not solved |

## The two ideas everything rests on

1. **Units.** The pool has one unit price = pool value ÷ all units. Money in buys units at the current price; money out sells units at the current price. Trading
   changes the price, never anyone's units. So a deposit or a withdrawal can never look like profit or loss to the books, *as long as it is recorded*.
2. **Each investor's own high-water mark (H).** A deposit raises that person's H by the amount; the fee (20%, or the person's own rate) is charged only on value above H.
   So each person pays only on the gain their own money made, from the day it joined.

The weak point is the word **recorded**. The ledger cannot tell, from the exchange balance alone, whether a change is a trade result or money someone moved. Section 6 is
about exactly that.

---

## 1. Money in

| # | Scenario | Status | What happens |
|---|---|---|---|
| 1.1 | New investor joins, no trade open | ✅ | Record → receive deposit → mark "seen in the exchange" → it joins at the next valuation (Update Pool) at that price. Units = amount ÷ price. Their mark = their deposit. |
| 1.2 | New investor joins in the middle of a profitable period | ✅ | They buy at the price that already includes the period's profit, so they get none of it and pay no fee on it. Example below. |
| 1.3 | Existing investor tops up (no trade open) | ✅ | More units at today's price; their mark rises by the top-up. The gain they already had stays theirs and is still charged once, later. |
| 1.4 | Top-up **while a trade is open** | 🟡 (today: ❌ waits) | Today Update Pool needs a confirmed balance check with **no open position**, and with 1112 live joins also wait while a closed live trade is not applied. So the money waits until the account is flat. With wallet mode on, it joins at the wallets' value including the open trade's unrealized P/L, without waiting. |
| 1.5 | Deposit sent but not in the exchange yet | ✅ | It waits as "pending". It is not subtracted from the exchange total (it isn't there yet) and buys nothing until you mark it arrived. |
| 1.6 | Deposit arrived but the pool has not been updated yet | ✅ | Arrived waiting money is taken out of the exchange total, so it is never counted as profit, and it is not traded (it waits in Spot). |
| 1.7 | Deposit made just before the 2-month settlement | ✅ | Not profit (mark rises by it). Waiting deposits at the settlement join **after** the fees, at the settlement price, so they pay nothing for that period. |
| 1.8 | Fund manager adds own capital | ✅ | Record it as a deposit for the manager (Fund M). It buys units like anyone. No fee on the manager's own capital (`fee_basis = external_investors`). |
| 1.9 | First deposit ever (empty pool) | ✅ | Price starts at 1.00. |
| 1.10 | The same deposit entered twice by a double click / lost reply | ✅ | Each money step has a request id; a repeat is a replay, not a second deposit. |
| 1.11 | Money in to the exchange that you **forget** to record | ❌ (caught, not prevented) | It looks exactly like trading profit: everyone's units gain value and a fee could be charged on it. The balance check shows an **unexplained difference** you must classify; if you classify it instead of recording it as a deposit, it stays counted as profit. See section 6. |
| 1.12 | Money in that should go to **one** of the two strategy wallets | 🟡 | Today the ledger sees one typed total (both accounts added); which account holds it does not matter to the books. Wallet mode tracks each wallet; a big jump in one is flagged "suspect" until you accept it. |
| 1.13 | Deposit amount in pesos | ✅ | The peso amount and rate are stored with it; units are bought in USDT. |
| 1.14 | Deposit handed back / typed wrong | ✅ | "Handed back" removes a waiting deposit; nothing in the books changes. |
| 1.15 | **Investor pays YOU directly** (cash, GCash, bank) instead of the exchange: you give them some of **your** units | ✅ after `20261201000000_units_from_manager.sql` and the new website | Money in → tick **They paid me directly** → type the exchange balance now (open trades included) → Save. Your units worth what they paid move to them at today's price. The exchange total, the total units and the price do not move, so nobody else's value changes. Their mark = what they paid (fee only on gain from today); their lock-up starts like a deposit. Refused if you hold fewer units, if they are not an active investor, or while a closed live trade is waiting for Update Pool. Undo reverses both sides exactly. |
| 1.16 | Top-up while a trade is open, by unit transfer | ✅ (same as 1.15) | A unit transfer does not wait for a flat account: it is valued at the exchange balance you type, open trades included. It still waits if a **Pending P/L** card shows (press Update Pool first). |

**Example 1.2 (today's rule, 20%):** John has 1,000 units bought at 1.00. Month 1 makes +10%, so the price is 1.10. Dino joins with 1,100 USDT and gets 1,000 units; his mark is 1,100.
Month 2 makes +10%, so the price is 1.21. At the settlement both hold 1,000 units worth 1,210:
John's mark is 1,000, so his fee is 20% × 210 = **42**. Dino's mark is 1,100, so his fee is 20% × 110 = **22**. Dino pays nothing on month 1, which happened before he joined.

## 2. Money out

| # | Scenario | Status | What happens |
|---|---|---|---|
| 2.1 | Partial withdrawal, in profit | ✅ | Units sold at today's price. The fee on **that share's** gain above the mark is taken now; the rest of the gain stays with the remaining units and is charged later. |
| 2.2 | Partial withdrawal, at a loss | ✅ | No fee. The **whole** shortfall stays with the remaining units: withdrawing cannot be used to escape a loss. |
| 2.3 | Full exit in profit | ✅ | All units sold; fee on the whole gain above the mark. |
| 2.4 | Full exit at a loss, then the person comes back | ✅ | The shortfall is remembered: on re-entry their mark = old shortfall + new deposit, so they pay no fee until they have made back what they lost. |
| 2.5 | Withdrawal **while a trade is open** | 🟡 (today: ❌ waits) | Today a payout through the Balance desk waits for a flat, confirmed balance check, and with 1112 live it also waits while a closed live trade is unapplied. With wallet mode on, it is valued including the open trade and paid without closing anything. |
| 2.6 | Withdrawal in the middle of the 2-month period | ✅ | Settled at the withdrawal (2.1/2.2). Nothing is held back for the period end. |
| 2.7 | More requested than can leave the exchange right now (money tied up as margin) | 🟡 | Payout cap (off today): the payout is refused with "PAYOUT QUEUED", nothing is saved, the investor keeps their units, and it goes through when enough is withdrawable. Today the ledger does not know what is withdrawable; you must check MEXC yourself. |
| 2.8 | Pay part now, rest later | 🟡 | `admin_split_withdrawal_request` splits an approved request (units conserved). No screen yet. |
| 2.9 | **You pay the investor yourself** (cash, e-wallet): their units move to **your** units instead of money leaving the exchange | ✅ | Money out → tick **I pay from my own money (nothing leaves the exchange)** (or Redeem → *From my own money* on the Balance desk). Their fee is taken first; the rest of their units become yours; the exchange total and total units stay the same. You hand them the cash. Like 1.16, it does not wait for a flat account (only for a waiting Pending P/L). |
| 2.10 | Payout recorded, money not sent yet | ✅ | It stays an "awaiting" payout; the reconciliation counts it as still in the account. Mark "sent" right after sending. In wallet mode it is also taken out of the NAV until sent. |
| 2.11 | Payout failed and retried | ✅ | failed → retry → sent → completed; each step once only. |
| 2.12 | Same withdrawal clicked twice / lost reply | ✅ | Replay, not a second payout or a second fee. |
| 2.13 | Below the 500-peso minimum | ✅ | Refused unless you tick the override; taking everything out is always allowed. |
| 2.14 | Inside the 3-month first-deposit lock-up | ✅ | Guidance only (`lock_enforced = 0`): you can approve it with a written reason (logged). |
| 2.15 | The last investor takes everything out and the typed total has more than 6 decimals | ❌ (refused safely) | Refused with "payout exceeds pool equity"; nothing is saved. Workaround: type the total with at most 6 decimals. Needs the exchange's USDT decimal places to fix ([full-exit-rounding.md](full-exit-rounding.md)). |
| 2.16 | Money taken out of the exchange that you **forget** to record | ❌ (caught, not prevented) | It looks like a trading loss shared by everyone. See section 6. |
| 2.17 | The withdrawal preview on Money out shows the wrong fee | ✅ (after the website is deployed) | The preview is now the database's own quote (the real withdrawal, rolled back), not a browser estimate. Until the new website is deployed, the old screen still estimates. |

## 3. Profit sharing (the 2-month settlement)

| # | Scenario | Status | What happens |
|---|---|---|---|
| 3.1 | Normal settlement in profit | ✅ | 20% (each person's rate) of value above their mark; the fee moves as units to the manager; the mark moves up so that gain is never charged again. |
| 3.2 | Period ends in a loss | ✅ | No fee; the mark stays; nothing is charged until they are back above it (loss carried forward). |
| 3.3 | A gain that **reverses** right after it was charged | 🟡 (today: ❌) | Today (`immediate`) the fee is charged on the value at the settlement, even if it falls back next week; it is not refunded. With `fee_timing = 'confirmed'` a gain is charged only once it is still there at the next settlement (one settlement late). Needs the investor terms updated first. |
| 3.4 | Settlement while trades are open | 🟡 (today: needs an exception) | Today an open trade blocks the settlement unless you approve an "open positions" exception with a written reason. With the confirmed rule it is a warning only (the open gain is not charged yet anyway). |
| 3.5 | Someone joined during the period | ✅ | Only their own gain since joining (1.2). |
| 3.6 | Someone withdrew during the period | ✅ | Their withdrawn share was settled at the withdrawal; the rest at the settlement. |
| 3.7 | Fee rate raised | ✅ | Starts after the next settlement, never on profit already made. |
| 3.8 | Fee rate lowered | ✅ | Applies at once. |
| 3.9 | 0% rate | ✅ | No fee, and gains made at 0% are never charged later. |
| 3.10 | Settlement late (after the 7-day window) or dated in the past | ✅ | Refused unless you approve a "late" / "backdated" exception; a missed period is covered by the next settlement. |
| 3.11 | Settled twice in a period / double click | ✅ | Refused / replayed. |
| 3.12 | The preview showed one fee but the books changed before you clicked | 🟡 | `settlement_preview_mode = 'require'` refuses a settlement whose preview is stale. Off until the new website is live. |
| 3.13 | Fee shown on the investor's screen differs from what they will pay | ✅ | `accrued_fee_usdt` is now the database's own full-exit fee figure. |
| 3.14 | Manager's own money | ✅ | Not charged; the fee units and the manager's own capital are tracked apart. |

## 4. Trading and valuation

| # | Scenario | Status | What happens |
|---|---|---|---|
| 4.1 | A trade closes with profit or loss | ✅ | It changes the exchange balance, so the price at the next valuation. Everyone holding units then shares it by units. |
| 4.2 | Open trades (unrealized P/L) | 🟡 (today: ❌ for joins and payouts) | Today joins and payouts wait for a flat account (1.4, 2.5). Wallet mode values open trades by their unrealized P/L (already inside MEXC's "equity", never counted twice). |
| 4.3 | Two strategy accounts (BB-Core, I-Core) | 🟡 (today: manual) | Today you type ONE total: both accounts' Spot + Futures added together. Wallet mode takes each wallet's report and refuses a typed total that disagrees with them. Needs the bots set up (guide Part 3). |
| 4.4 | Money moved between Spot and Futures, or between the two accounts | ✅ (no entry) | Not a deposit or withdrawal: the total you type is unchanged, so enter nothing. In wallet mode, read both wallets at the same time (within 10 minutes) so a transfer is not counted twice or missed. |
| 4.5 | Exchange fees, funding payments | ✅ | They are inside the exchange balance: shared by everyone as part of the trading result. |
| 4.6 | A balance that jumps more than 25% | ✅ | The valuation asks you to confirm; in wallet mode a wallet jump over 50% is flagged suspect. |
| 4.7 | A bot reports a wrong balance | 🟡 | Today the bots do not move the price (`bot_equity_sync = off`). In wallet mode the typed total must match the wallets, and a jump is suspect; a stolen wallet key could still misreport one wallet. |
| 4.8 | A wallet report is old, missing, or the two wallets disagree in time | 🟡 | Wallet mode refuses to value or pay ("WALLETS NOT READY") and never uses zero or a guess. |

## 5. Mistakes, safety, records

| # | Scenario | Status | What happens |
|---|---|---|---|
| 5.1 | Typed a wrong entry | ✅ (newest only) | Only the newest entry can be undone; it adds a correction and erases nothing. An older mistake needs a new, explained correcting entry. |
| 5.2 | Undo of a withdrawal or deposit | ✅ | Units, marks and the fee state come back exactly. A settlement cannot be undone. |
| 5.3 | Backups | ✅ | The export includes every ledger table (checked by `admin_backup_coverage`), the wallet tables included, never passwords or keys. |
| 5.4 | Two people clicking at once | ✅ | One money write at a time (database lock). |
| 5.5 | Re-running an old migration after a newer one | ❌ (rule, not a guard) | It silently undoes parts of the newer one. Rule: never do it; or re-run the newer ones after it. |

---

## 6. Adding or removing capital at MEXC: what to do in the ledger

**The rule: every peso that enters or leaves the exchange because of a person (not because of a trade) must be in the ledger BEFORE the next balance reading.**
The ledger treats every change in the exchange total that is **not** a recorded deposit or payout as trading profit or loss, and shares it with everyone.

### Money going IN to MEXC

| Whose money | What to do in the ledger |
|---|---|
| An investor's (new or top-up) | Money in → choose the person → amount (USDT or pesos) → save. When it shows in MEXC: **Seen in the exchange**. Leave it in **Spot** (not traded). At the next Update Pool accept it, then move it Spot → Futures in MEXC. |
| Yours, as your own investment in the pool | The same, choosing **yourself (Fund M)**. You get units; no fee on your own money. |
| An investor's, but they paid **you** (cash / e-wallet) and nothing goes to MEXC | Money in → tick **They paid me directly** (1.15): they get your units, MEXC is untouched. |
| Yours, but only parked there (not meant for the pool) | Do not put it in the pool's account. If it is there, it inflates everyone's value: either record it as your deposit (you get units) or take it out before the next reading. |
| Moved between Spot and Futures, or between the two accounts | Nothing: the total does not change. |

### Money going OUT of MEXC

| Why | What to do in the ledger |
|---|---|
| Paying an investor | Through their request (approve → quote → redeem → **sent** → completed) or Money out. Record it **first**, then send it, then mark **sent**. |
| Paying an investor from **your** pocket, MEXC untouched | Money out → tick **I pay from my own money** (2.9): their units become yours, nothing leaves MEXC. |
| You taking your own money out | Money out for **yourself (Fund M)**. Your units are sold; nobody else's value moves. |
| Exchange or network withdrawal fee | It is a cost: it comes out of the payout, or is shared as a trading cost if the pool pays it. |
| Moved between Spot and Futures, or between the two accounts | Nothing. |

### How to tell a top-up from a profit, and a withdrawal from a loss

The ledger cannot know from the number alone. It knows only what you recorded, so it works like this:

- **expected exchange total = pool value + waiting deposits that arrived + payouts recorded but not sent + the closed trades the bot reported**
- Any difference beyond that is **unexplained**. The balance check shows it and blocks Update Pool until you deal with it.

| The difference is | Then |
|---|---|
| A deposit you forgot to record | **Record it as Money in** for the right person, then enter the balance check again. Do **not** just classify it: classifying only explains a difference, it does not take it out of the pool's value, so it would still be shared as profit and charged a fee. |
| A withdrawal you forgot to record | Record it as Money out for the right person. Otherwise everyone shares it as a loss. |
| A trade result the bot did not report | Classify it as a trading result with the source (the MEXC trade history line). |
| Fees, funding, timing | Classify it with what it is and a reason (it stays in the pool, shared by everyone). |
| You cannot explain it | Do not Update Pool. Find it in MEXC's deposit / withdrawal / transfer history first. |

Signals that help you spot it:
1. The reading changed by much more than the open/closed trades explain (the balance check's difference).
2. A jump over 25% asks you to confirm the valuation.
3. With wallet mode on, a wallet jump over 50% is held as suspect until you accept it.
4. MEXC's own deposit and withdrawal history: **the bots do not send it to the ledger yet** (❌), so check it by hand when there is a difference.

---

## 7. Not solved yet (the full list)

| # | What | Why / what is missing | Where it stands |
|---|---|---|---|
| N1 | Top-up or withdrawal **through the exchange** while a trade is open (1.4, 2.5, 4.2) | Today they wait for a flat account | Built: wallet mode. Needs the bots reporting every 5 minutes, then the switch (guide Parts 3–4). **Workaround that works today: a unit transfer (1.15 / 2.9)**, which does not wait. |
| N2 | Knowing how much can really leave the exchange (2.7) | The ledger does not read MEXC's withdrawable amount today | Built: payout cap. Same setup as N1 |
| N3 | A charged gain that reverses (3.3) | Old fee rule | Built: confirmed rule. Needs new investor terms, then the switch (guide Part 5) |
| N4 | Settling with open trades without an exception (3.4) | Old fee rule | Comes with N3 |
| N5 | Stale settlement preview (3.12) | Off | Switch after the new website is live (guide Part 6) |
| N6 | **A forgotten deposit or withdrawal is caught but not prevented** (1.11, 2.16) | The bots do not send MEXC's deposit/withdrawal/transfer history, so the ledger cannot match it automatically | ❌ Not built. Needs a bot reading MEXC's transfer history (an API the bot client does not have yet) |
| N7 | The bot-reported closed-trade P/L needs the dashboard to share live dollar amounts | Without `DASHBOARD_SHARE_LIVE_EQUITY=true` the pending trades have no dollar figure | Setting on the VPS |
| N8 | Last holder's full exit with a 7+ decimal total (2.15) | The exchange's USDT decimal places are unknown | Refused safely; needs your answer |
| N9 | Screens for wallet status, the queue, splitting a request, accepting a suspect report | Not built | Database functions only today |
| N10 | Correcting a mistake that is not the newest entry (5.1) | By design only the newest can be undone | Use a new, explained correcting entry |
| N11 | Re-running old migrations out of order (5.5) | A rule, not enforced | Follow the order rule |
| N12 | Each period with open trades needs a trading difference classified in the balance check | The balance-check workflow was not redesigned | Built around, not removed |
| N13 | The older `capital-sync.js` (adds both bots into one total) | Separate path, no withdrawable amount | Decide whether to retire it |
| N14 | Legal: pooled money from friends and family | Not a software question | The Philippine SEC position was flagged in the docs as unresolved |

**In one sentence:** everything about *who owns what and who pays what fee* is solved and tested; what is not solved yet is acting **while trades are open** (built, waiting for setup)
and **catching a forgotten deposit or withdrawal automatically** (not built: today it depends on you recording every movement before the next reading).

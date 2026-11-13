# What to do next: a guide you can follow later

Nothing in this guide has been done yet. Everything the code changes is written and tested locally; **nothing has been applied to your database, deployed to the website, or started on the bots.**
Tick the boxes as you go. If a step says STOP, do not continue until it is sorted out. Do the whole guide on a **staging copy first** (a second Supabase project restored from a backup), then repeat on production.

Related documents: [confirmed-gain-fee.md](confirmed-gain-fee.md) (the fee rule), [wallet-snapshots.md](wallet-snapshots.md) (wallet reports and the payout cap),
[full-exit-rounding.md](full-exit-rounding.md) (the open rounding question).

---

## Part 0. Before anything

- [ ] **Take a backup.** Run `backup-ledger.cmd` (or the manager's export). Keep the file somewhere safe.
- [ ] **Check what is already applied.** Open `docs/which-migrations-are-applied.sql`, paste it into the Supabase SQL Editor, Run. It only reads.
  Your last result had steps 1–5, 8 and 9 = true and steps 6, 7, 10, 11, 12 = false. Run it again before each part below.
- [ ] Decide **staging or production** for today. Staging first.

---

## Part 1. The three SQL files (database only, nothing changes for investors yet)

> **Status: you ran the SQL files (reported 2026-10-28).** Still to confirm: that `fee_timing` is `immediate` (query below) and that the detector shows steps 10, 11, 12 = true. Then continue at Part 2.

Paste each file **whole** into the SQL Editor and Run, in this order. If a file stops with "preflight … Nothing was changed", do what the message says, then run it again. All three are safe to run twice.

| # | File | Result |
|---|---|---|
| 1 | `supabase/migrations/20261127000000_confirmed_gain_fee.sql` | the delayed fee, the settlement preview check, the accrued-fee fix |
| 2 | *(this one line, immediately after #1)* | keeps the OLD fee rule for now |
| 3 | `supabase/migrations/20261128000000_withdraw_quote.sql` | the database quote the Money out screen uses |
| 4 | `supabase/migrations/20261130000000_wallet_snapshots.sql` | wallet reports, combined NAV, payout cap (all OFF) |

```sql
-- step 2: run right after file #1, before anyone settles
update public.ledger_settings set value = 'immediate' where key = 'fee_timing';
```

Why step 2: running file #1 on its own switches your live fee rule to "charge a gain only once it is still there at the next settlement". That is the new rule you chose, but it needs the investor terms updated first (Part 5). Until then keep the old rule.

- [ ] Check it worked. Run:
  ```sql
  select key, value from public.ledger_settings
   where key in ('fee_timing','settlement_preview_mode','wallet_nav_mode','payout_cap_mode') order by key;
  ```
  Expected: `fee_timing = immediate`, and the other three `off`. Then run the detector again: steps 10, 11, 12 must be `true`.
- [ ] **STOP if** any file errored or `fee_timing` is not `immediate`. Restore the backup if anything looks wrong; nothing is deleted by these files, so a restore is only needed if data looks different.

### Part 1b. One more SQL file: unit transfers (run any time after Part 1)

- [ ] Paste `supabase/migrations/20261201000000_units_from_manager.sql` whole into the SQL Editor and Run. It adds two functions and changes no data, no table and no existing function.
  It lets you give an investor **your** units when they paid **you** directly (Money in → *They paid me directly*). The other direction (*I pay from my own money* on Money out) already existed.
- [ ] Check: the detector now shows step 13 = true.
- [ ] The tick box appears in the app only after the new website is deployed (Part 2).

**Order rule (important):** never re-run an earlier migration (for example 1112) after these. It silently undoes parts of the later files. If you ever must, run `20261130000000_wallet_snapshots.sql` again afterwards (and 1127 before it).

---

## Part 2. Deploy the website (the app)

The updated screens (settlement preview, confirmation sheets, the database fee quote on Money out) are in `js/app.js`, `js/confirmsheet.js`, `js/settlepreview.js`, `js/investorctx.js`, `login.html`, `css/features.css`.
They are **not committed or deployed**. Other people have also been editing these files, so review `git status` and `git diff` first, then commit and deploy the way you normally do.

- [ ] **Do Part 1 first.** The new Money out screen asks the database for a quote; on a database without file #3 it shows "the quote is not available on this database yet".
- [ ] After deploying, open the manager screens: Money out (pick an investor with units, type units and a balance: you should see "Quoted by the database"), and the settlement tab (Preview settlement, then Settle).
- [ ] Do not turn on `settlement_preview_mode` until this website version is live (Part 6), or settlements will be refused.

---

## Part 3. Put the bots in a state to report (no trading is changed)

Each bot reports its **own wallet** with its **own secret**. Do this on your machine or the VPS, one bot at a time.

1. [ ] Make the wallet key and the SQL line (in the `ledger` folder):
   ```
   node scripts/new-wallet-key.mjs bbcore "BB-Core"
   node scripts/new-wallet-key.mjs icore  "I-Core"
   ```
   Each prints a **key** (secret: keep it out of chat, email and git) and **one SQL statement**.
2. [ ] Paste each SQL statement in the SQL Editor and Run. Check: `select wallet, label, active from public.bot_wallets;` shows both wallets.
3. [ ] In **each bot's `mexc-keys.json`** (it already has `ledgerUrl` and `ledgerKey`) add its own two lines:
   - BB-Core: `"ledgerWallet": "bbcore"` and `"ledgerWalletKey": "<the bbcore key>"`
   - I-Core: `"ledgerWallet": "icore"` and `"ledgerWalletKey": "<the icore key>"`
4. [ ] Update the bots' code on the VPS (the changes are in each bot repo's working tree, **not committed**: review and commit them: `ledger-sync.js`, `config.js`, `lucidio.js` / `icore.js`, `test/ledger-wallet-test.js`).
5. [ ] **Dry run first** (shows what would be sent, sends nothing):
   ```
   node lucidio.js ledger-wallet-sync --dry     (BB-Core)
   node icore.js ledger-wallet-sync --dry       (I-Core)
   ```
   Check: equity and withdrawable (`cashBalance`) match the MEXC app for that account, and the open position count is right.
   If it says "MEXC did not return cashBalance", STOP: that field is required and is never replaced by another number. Tell me.
6. [ ] **Send one real report** (drop `--dry`), then in the SQL Editor:
   ```sql
   select wallet, seq, received_at, equity_usdt, unrealized_usdt, withdrawable_usdt, available_usdt, open_positions, open_orders, suspect
     from public.wallet_snapshots order by id desc limit 10;
   ```
7. [ ] **Report often.** The ledger treats a report older than 30 minutes as stale, and the bots only report every 4 hours on their own. Add a cron job on the VPS for each bot (adjust the folders):
   ```
   */5 * * * *  cd /opt/lucidio && node lucidio.js ledger-wallet-sync >> /var/log/ledger-wallet.log 2>&1
   */5 * * * *  cd /opt/icore   && node icore.js   ledger-wallet-sync >> /var/log/ledger-wallet.log 2>&1
   ```
   This reads MEXC read-only and never touches trading. The two jobs should run at about the same time (the wallets must be read within 10 minutes of each other).
- [ ] Check after 15 minutes: both wallets have new rows every ~5 minutes, `suspect` is false.

**A "suspect" report** (a wallet's equity changed by more than 50% since its last report, for example after a deposit or a transfer between wallets) is stored but blocks use until you accept it. There is no screen yet; in the SQL Editor:
```sql
update public.wallet_snapshots
   set accepted_by = (select id from public.profiles where role = 'admin' limit 1), accepted_at = now(), accept_note = 'write the real reason here (10+ characters)'
 where id = <the snapshot id> and suspect and accepted_at is null;
```
(This does not write the activity-log line that the app function would; note the reason somewhere safe.)

---

## Part 4. Turn on wallet mode (one switch at a time), on staging first

Do not do this until Part 3 has been reporting cleanly for a while (a day is sensible).

1. [ ] Confirm both wallets are fresh and agree with the exchange: the latest snapshot rows (query above) are under 30 minutes old and their equities add up to the MEXC app totals.
2. [ ] Turn on **wallet mode**:
   ```sql
   update public.ledger_settings set value = 'require' where key = 'wallet_nav_mode';
   ```
   From now on every valuation needs fresh, agreeing wallets, and the exchange total you type must match them (within 0.50 USDT or 0.05%).
   Try one valuation. If you see `WALLETS NOT READY` or `WALLET MISMATCH` read the message: it says which wallet or by how much.
3. [ ] Turn on the **payout cap**:
   ```sql
   update public.ledger_settings set value = 'require' where key = 'payout_cap_mode';
   ```
   Test a payout **below** what can leave (it should go through) and one **above** (it should say `PAYOUT QUEUED`, save nothing, and leave the investor's units untouched).
4. [ ] **Go back at any time** with `supabase/rollback/20261130000000_rollback_wallet_snapshots.sql` (it just sets both modes `off`).

Settings you can change later (all in `public.ledger_settings`): `wallet_max_age_minutes` (30), `wallet_max_skew_minutes` (10), `wallet_max_jump_pct` (0.5), `payout_buffer_pct` (0.05), `payout_buffer_usdt` (5), `wallet_expected_count` (2).
The buffer values are **my guess at a safe margin**: confirm them with a small real payout.

---

## Part 5. Switch the fee to the delayed rule (only when ready)

The new rule: a gain is charged only if it is still there at the next settlement; money that leaves pays its pending gain at once.

- [ ] Update the investor terms and the "how it works" pages (`reports/how-lucid-io-works*.html`): the fee now lands one settlement later, and a withdrawal pays any pending gain immediately. Change the terms version so every investor agrees again.
- [ ] Rehearse on staging: `npm run rehearse` with a fresh backup.
- [ ] Understand the effect: **the first settlement after the switch charges nobody** (no gain is confirmed yet); that period's fee arrives one settlement later.
- [ ] Switch:
  ```sql
  update public.ledger_settings set value = 'confirmed' where key = 'fee_timing';
  ```
  Back to the old rule at any time with the same line and `'immediate'` (the next settlement then charges everything not charged yet, once).

---

## Part 6. Make the settlement refuse a stale preview (after Part 2)

- [ ] The new website must be live (Part 2).
- [ ] Switch:
  ```sql
  update public.ledger_settings set value = 'require' where key = 'settlement_preview_mode';
  ```
  Then a settlement only goes through if you pressed **Preview settlement** for the same balance and nothing changed since (a deposit, a withdrawal, a rate change). If the app says `STALE PREVIEW`, press Preview again.
- [ ] Off again with `'off'`.

---

## Things I did NOT do or could not prove (read before relying on this)

- Nothing has run against the real MEXC or the real Supabase. MEXC's documentation lists `cashBalance` as the withdrawable balance; whether a futures-to-spot transfer honours exactly that amount is not documented.
- **No screens** for wallet status, the withdrawal queue, splitting a request, or accepting a suspect snapshot. They are database functions only (`admin_wallet_nav`, `admin_withdrawal_queue`, `admin_split_withdrawal_request`, `admin_accept_wallet_snapshot`, called with a manager session token).
- The full-exit rounding edge is still **refused**, not fixed (the exchange's USDT decimal places are unknown). Workaround: type the exchange total with at most 6 decimals. See [full-exit-rounding.md](full-exit-rounding.md).
- `capital-sync.js` in the bot repos is an older, separate way of adding both bots into one total. Untouched. Decide whether to retire it once wallet reports are live.
- The existing balance-check workflow still asks you to explain differences; with open trades there will be a trading-P&L difference to classify each time.
- Migrations 1114 (default fee 20%) and 1115 (payout labels) are **not part of this work** and were left alone. 1114 changes investors' fee rate: decide it separately.

## Decisions waiting for you

1. What decimal places does your exchange accept for USDT withdrawals and transfers? (unblocks the full-exit fix)
2. Keep or retire `capital-sync.js`?
3. Are the defaults right: 30-minute freshness, 50% jump flag, payout buffer 5% + 5 USDT?
4. Should I build the app screens for the wallet features?
5. The 20% fee (1114) and the investor terms for the delayed fee.

## If something goes wrong

| You see | It means | Do |
|---|---|---|
| `WALLETS NOT READY: wallet X last reported N minutes ago` | a bot stopped reporting | check the cron / the bot; the message names the wallet |
| `WALLETS NOT READY … reported N minutes apart` | the two reads were too far apart | make the two cron jobs run at the same minute |
| `WALLET MISMATCH` | the total you typed differs from the two wallets | recheck the total; wait for fresh snapshots |
| `wallet X equity jumped …` | a suspect snapshot (deposit or transfer?) | accept it (Part 3, "A suspect report") if the jump is real |
| `PAYOUT QUEUED` | the payout is more than can leave the exchange now | nothing was saved; wait for more to become withdrawable, or split the request |
| `PAYOUT BLOCKED` | wallet reports not usable | fix the reports first |
| `STALE PREVIEW` / `PREVIEW REQUIRED` | the books changed since your preview | press Preview settlement again |
| `payout exceeds pool equity` on a full exit | the rounding edge | type the exchange total with at most 6 decimals |
| anything unexpected | | set `wallet_nav_mode`, `payout_cap_mode`, `settlement_preview_mode` back to `off`; if the fee looks wrong set `fee_timing` back to `immediate` |

**Never:** paste a wallet key into chat, email or git; re-run an earlier migration without re-running the later ones; turn on a mode on production before you have tried it on staging.

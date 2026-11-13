# Fable task: clean up the ledger accounting

How to run: `/model fable`, then `/clear`, then say **"Do the task in ledger/FABLE-LEDGER-CLEANUP.md"**.

---

## Task
Clean up the Lucid'io investor ledger in `D:\testing\Strat\ledger` so that only the flow we actually use remains, everything is accurate, and the first settlement (Jan 1–7 2027) is ready. Do all of it in one go: audit, fix, test, document. Stop only for the things listed under "Owner only".

## The flow we use (keep this, nothing else)
1. Add a new user
2. Money in: record deposit (pesos + USDT received) → seen in MEXC → admit at true value; peso top-up when less USDT arrived
3. Money out: request → approve → quote → redeem → send → completed
4. Spot ↔ Futures transfers happen in MEXC by hand (not in the ledger)
5. Bots book closed trades automatically (`auto_pool_mode = trades`)
6. Settlement every 2 months (never run yet)

Live switches: `flow_pricing = true_value`, `workflow_gate = off`, `bot_equity_sync = off`, `wallet_nav_mode = off`; admission spread NOT applied. The truth is `docs/LEDGER-HOW-IT-WORKS-NOW.txt`; where other docs disagree, it wins.

## Do this
1. **Find out what's really live.** Read-only queries against the live database (Supabase connector, or `docs/which-migrations-are-applied.sql`): which migrations ran, which tables and functions exist, the current switches.
2. **Fix the migrations folder.** Move every live migration into `supabase/migrations/applied/`, so a file left in `migrations/` really means "not run".
3. **Remove the dead screens from the app.** Every form, card or button that calls something refused under true-value pricing, a missing table, or the off workflow gate goes behind one flag (off by default). Known: old Balance / Update-equity form, manual Money-out form with a typed balance, "They paid me directly" (`admin_quote_units_from_manager`), admission-spread card, workflow-gate buttons (`admin_confirm_balance`, `admin_reject_balance`, `admin_classify_*`, `admin_escalate`), Capital desk (`js/desk.js`, `js/gate.js`). Check for others. The manager keeps: Dashboard, Users, Record (Money in / Money out / History), Settle, Reports, Log. The investor screens stay as they are.
4. **Retire dead database functions.** Write one migration that revokes the web role's access to every function that's no longer used (no dropped data tables, no data changes), plus a rollback file. Test it on a **Supabase branch** with `scripts/rehearse-migration.mjs`. Don't apply it to live.
5. **Rehearse the settlement.** On the same branch (copy of live data), run the full settlement for the current holders. Check units sum = pool total, fee units net to zero, and H values are correct. Fix any code bug that blocks it. List any blocker that needs a decision (N5, N7, the unsettled Sep–Oct period, `settlement_recon = require` without transfer history N1, open trades).
6. **Rewrite the docs.** `README.md` describes the current flow only. Move superseded docs to `docs/archive/` with one line on what replaced them.
7. **Tests.** Update or add tests for every change; `npm test` must pass.
8. **Report.** Write `docs/CLEANUP-REPORT.md`: what was live, what you changed (file by file), what you hid or revoked and why, settlement rehearsal numbers, risks found (anything that could misprice units, double-count or block a payout, ranked), test results, and the list of owner decisions.

## Hard rules
- **No writes to the live database.** Live = read-only `select`. Schema changes are rehearsed on a branch only.
- Never delete or rewrite history (pool entries, deposits, payouts, closed trades, audit log, corrections). The books are append-only.
- No investor names, contacts or person-linked amounts in anything sent outside. Use profile ids.
- No `git push`, no Vercel deploy.
- If a test fails or something can't be done, say so in the report. Don't hide it.

## Owner only (list these in the report, don't do them)
- Applying the retirement migration to the live database
- Publishing the website
- Fee terms and the default fee rate (N6), admission spread policy (N8), legal (N9)
- Any settlement on the live database

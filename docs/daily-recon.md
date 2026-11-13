> Note (Nov 13 2026): the screens named here as Record > Balance / Money in (by hand) / Money out (by hand) are retired; the manager now uses the four steps in docs/live-nav.md. The database rules below still apply.

# Daily books-vs-MEXC check (and getting the backup running)

`scripts/recon-check.mjs` compares what the books say the exchange wallets should hold with what the wallets last reported (the bots already send this every few minutes). It is **read-only**: it uses the same revocable backup key as the nightly backup, so it cannot change anything, and it touches no bot, no exchange, no database row.

```
expected wallet equity = pool value + payouts redeemed but not yet sent (+ queued deposits only if they wait in Futures) + open-trade profit
gap = wallets - expected        tolerance = max(0.50, 0.05% of the balance)   (the app's own pool_recon_tol_*)
```
Verdicts: **ok**, **review** (gap beyond tolerance, or units do not match the last reading), **not_fresh** (a bot stopped reporting / suspect snapshot), **no_data**.
A gap can also just be closed trades that Update Pool has not applied yet (they are in the wallets, not yet in the pool value): press Update Pool and re-run before digging.
It also warns when the last backup failed or is older than 3 days. Every run adds a line to `backups/recon-log.jsonl` (the evidence that the books matched on that day).

## Set up (about 10 minutes, on any computer that stays on)
1. In the app: **Fund → Log → Backups → Create nightly backup key**, copy it (shown once).
2. `copy backup.config.example.json backup.config.json`, paste the key. Optional: `"copyTo"` = a Google Drive / OneDrive **desktop-synced folder** (second copy of the backups), and `"telegram": {"token", "chatId"}` (same bot as the monthly report).
3. Test: `node scripts/backup-ledger.mjs`, then `node scripts/recon-check.mjs`.
4. Schedule (Windows): `node scripts/backup-ledger.mjs --schedule 02:30` and `node scripts/recon-check.mjs --schedule 08:00`.

No key yet? Try it on a saved export: `node scripts/recon-check.mjs --file backups/ledger-<date>/ledger.json` (or use the app's *Download backup (JSON)*).

## Known limits
- T-CORE has its own wallet; if it is not a registered wallet (`bot_wallets`), it is not in the comparison (the check lists the wallets it used, and notes when fewer than `wallet_expected_count` are registered).
- It needs the wallet-snapshot tables in the export (migration 20261130000000). Without them the verdict is `no_data`, never a false ok.
- Pending live trades are not in the export, so they appear as part of the gap.

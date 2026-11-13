# Archive

These documents are **old**. They describe a screen or a flow that is retired, or a state that is no longer true. They are kept so the history is not lost. Do not follow them.
Written Nov 13 2026. Current docs: see the Docs table in [../../README.md](../../README.md).

| File | What it described | What replaced it |
|---|---|---|
| `SCENARIOS.md` | Every money-in, money-out and profit-sharing case, solved or not, as of Oct 28 2026 (old by-hand screens, switches still off). | [../LEDGER-HOW-IT-WORKS-NOW.txt](../LEDGER-HOW-IT-WORKS-NOW.txt), the main [README](../../README.md) and [../live-nav.md](../live-nav.md). |
| `pool-update.md` | Pool Update: closed trades stay "pending" until the manager presses Update Pool (Record > Balance). | Retired. Closed trades are booked automatically (`auto_pool_mode = trades`) and the price follows the live NAV: [../live-nav.md](../live-nav.md). |
| `admission-spread.md` | Crediting pesos at a rate up to 1 peso above the real rate; the surplus stays the fund manager's. **Built and tested, not applied. Owner decision N8.** Migration `20261209000000_admission_spread.sql` is still waiting in `supabase/migrations/`. | Nothing yet. The live cash-in credits pesos divided by the rate, and the gap rule is in [../live-nav.md](../live-nav.md). Code comments in `js/app.js` and `js/contribution.js` still point to the old path `docs/admission-spread.md`. |
| `NEXT-STEPS-GUIDE.md` | A checklist (Oct 28) for running SQL files and deploying, written when "nothing has been applied". All its migrations are applied now, and it names retired screens. | [../../README.md](../../README.md) (setup, rehearsal) and [../which-migrations-are-applied.sql](../which-migrations-are-applied.sql). |

Kept in `docs/` on purpose: `confirmed-gain-fee.md` (the `fee_timing = confirmed` setting still exists, switched off), and the machinery docs (`accounting-model`, `hwm-settlement`, `settlement-controls`, `true-value-pricing`, `wallet-snapshots`, `php-contributions`, `daily-recon`, `full-exit-rounding`), because the database rules they describe are still live. Those with sections about retired screens carry a note at the top.

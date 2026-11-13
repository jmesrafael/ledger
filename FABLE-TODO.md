# FABLE TODO

Work to hand to Claude Fable 5.2 (`/model` → fable in Claude Code). Written 2026-11-13.

**Rules for every task**
- Read-only first: Fable writes a findings report (`.md`), nothing is changed before the owner reviews it.
- Code changes go to paper tags first (bbtr, bb1h, cbb/ctc, bbn/icn/tcn), then live, using the existing deploy checklists.
- Ledger / money changes go to a **Supabase branch** first, never straight to the live database.
- No investor names or personal data in anything sent to outside services. Use wallet / bot ids.
- Policy, fee terms and legal questions (N6, N8, N9) are the owner's, not Fable's.
- Fable has seen market history up to mid-2026. **Any backtest where the LLM judges past news or setups is contaminated.** LLM ideas can only be judged forward, in paper bots.
- Fable costs $8 / $40 per M tokens. High-volume, simple jobs (news tagging, log scanning) go to Haiku 5.5 or Sonnet 5.5. Fable only gets the hard or unclear cases.
- After each study: add a row to `StrategyBacktester/research/TESTED-STRATEGIES.md` and update graphify.

---

## Priority order (start here)

1. [ ] **A1** Exchange-layer audit (`mexc.js` × 4 versions)
2. [ ] **C1** End-to-end data map, VPS → dashboard → ledger
3. [ ] **C2** Daily three-way reconciliation
4. [ ] **A3** Live vs backtest parity
5. [ ] **B1** Engine realism audit
6. [ ] **C3** MEXC transfer-history feed (biggest payoff, highest risk)

---

## A. VPS bots

### A1. Exchange-layer audit and unification
**Finding (Nov 13):** the shared modules are copied per bot and the copies have drifted apart (md5):

| Module | bb-core | bb-trail | i-core | bb-core-1h |
|---|---|---|---|---|
| `mexc.js` | v1 | v2 | v3 | v4 |
| `ledger-sync.js` | v1 | v2 | v3 | v4 |
| `telegram.js` | v1 | v2 | v3 | v4 |
| `dashboard-push.js` | v1 | v2 | v3 | v4 |
| `journal.js` | A | B | C | A |
| `live.js`, `envfile.js` | A | B | B | A |

- [ ] Diff all versions; list every fix that is in one copy and missing in the others (risk-ranked)
- [ ] Design one shared, tested module (plus a sync script like `scripts/sync-*-core.mjs`)
- [ ] Roll it out one bot at a time, paper first

### A2. Failure-mode review of the live loop
Go through each bot's `live.js` and core, state by state: partial fill, rejected order, API timeout during order placement, VPS restart with an open position, duplicate signal, clock crossing a candle boundary.
- [ ] Gap list
- [ ] One test per gap

### A3. Live vs backtest parity
Each bot's `compare-live-vs-backtest.js` has drifted too.
- [ ] Check that the live engine and the backtest engine make the same decisions on the same candles (use the shadow recorder data)
- [ ] Any mismatch means the backtest results don't describe the bot that's trading. Report it.

### A4. Incident triage helper
- [ ] When a bot stalls: read logs + ledger + exchange responses and propose a diagnosis. The owner approves every action.

### A5. Daily ops watcher (Haiku / Sonnet, not Fable)
- [ ] Read bot and recorder logs daily; flag stalled feeds, missed fills, restarts.

---

## B. StrategyBacktester / research

### B1. Engine realism audit
Research folders (`big-swings`, `orb-*`, `long-history`, `news-lab`, …) seem to have their own engines.
- [ ] For each engine: fee, funding and slippage assumptions
- [ ] Same-bar stop + target: which gets assumed first? Settle it with the **1m candles** in the library. If a study assumed the friendly order, its R is inflated.
- [ ] Build one validated reference engine and re-run the winners (BB-CORE, T-CORE, I-CORE) on it

### B2. Robustness pass on the winners
- [ ] Walk-forward, parameter-plateau check, Monte Carlo on trade order
- [ ] Deflated Sharpe that accounts for how many strategies were tried (see the registry)

### B3. Portfolio-level risk study
BB-CORE, T-CORE and I-CORE overlap on coins (SUI, ARB going live on two bots).
- [ ] Correlated exposure, worst combined drawdown, how sizing should be split

### B4. Adversarial review of good-looking results
- [ ] Try to break each result: other date splits, fee/slippage stress, parameter sensitivity
- [ ] News Lab: does "skipped trade isn't replaced" inflate the +14.8R / +9.4R / +24R?

### B5. Hypothesis generator
- [ ] Read `TESTED-STRATEGIES.md` + the candle library schema; propose new tests that avoid what already failed (plain ORB, F&G rule, BTC-crash rule), and explain *why* the current winners work

### B6. Research review before each live decision
- [ ] Audit the ORB, long-history and coin-lab studies for overfitting, lookahead, survivorship bias and too-few-trades results

---

## C. VPS → bot dashboard → accounting (ledger) sync

How data flows today:
```
VPS bot ──dashboard-push.js (signed outbox)──► Vercel bot dashboard (api/ingest.js) ─► analytics
   ├──ledger-sync.js (Supabase RPCs) ──► ledger: snapshots, equity, wallet reports,
   │                                      closed trades (MEXC realised P&L) ─► pool / units / fees
   └──capital-sync.js (older separate path; N3: retire?)
```
Known gaps (from `ledger/docs/LEDGER-HOW-IT-WORKS-NOW.txt`):
- MEXC transfer history is not sent (N1), so `transfers_complete = false` and every fee settlement needs the manager's written attestation
- `bot_equity_sync` and `wallet_nav_mode` are built but off, waiting for proof the bot data is reliable
- The dashboard and the ledger get trade data through separate modules; nothing checks they agree
- Stale comments (e.g. `dashboard-push.js` lists 5 coins; it really follows `config.ALLOWED_SYMBOLS`)

### C1. End-to-end data map and audit (read-only)
- [ ] Every field: MEXC → bot → outbox → dashboard / ledger → pool → investor statement
- [ ] Every place a number can disagree: bot estimate vs MEXC realised, fees, funding, paper vs live
- [ ] Output: `ledger/docs/DATA-FLOW-AUDIT.md`

### C2. Daily three-way reconciliation
- [ ] MEXC ↔ ledger ↔ dashboard, matched on the MEXC position id; extend `ledger/recon-check.cmd`
- [ ] Report every mismatch by name
- [ ] This is the proof needed before switching on `wallet_nav_mode = require` / `bot_equity_sync`

### C3. MEXC transfer-history feed (closes N1)  ⚠ moves money
- [ ] Add deposit / withdraw / transfer history to `mexc.js`
- [ ] Send it through `ledger-sync.js`; match it to deposits in the ledger
- [ ] Idempotent (request ids), clear matching rules, tested on a Supabase branch
- [ ] Goal: `transfers_complete = true`, so settlements no longer need manual attestation

### C4. One shared event pipeline
- [ ] One outbox and one event format feeding both the dashboard and the ledger, so they can't drift
- [ ] Merge the 4 copies (with A1); decide N3 (retire `capital-sync.js`)

### C5. Dashboard analytics built on booked numbers
Use the definitions in `ledger/docs/accounting-model.md`.
- [ ] Realised R per bot and coin, fees, funding, slippage vs backtest
- [ ] Live vs backtest drift per bot
- [ ] Which bot produced the pool's return (NAV attribution)
- [ ] Settlement preview
- [ ] Plain-language weekly digest (could also go to Telegram)
- [ ] Natural-language queries ("tcore trades on SUI when funding > X")

### C6. Rehearsal harness (Supabase branch)
- [ ] Replay a real month of events into a branch
- [ ] Rehearse switches before going live: `wallet_nav_mode`, `payout_cap_mode`, `settlement_preview_mode`
- [ ] Rehearse the untested cases: period-end settlement with true value (N5), quarter-end under "immediate" (N7)

---

## D. News / Pulse (cheap models, Fable only for hard cases)

- [ ] **D1** Hack extraction: headline → {chain, amount, date, confidence} for the 72h no-long rule (Haiku; Fable for unclear ones)
- [ ] **D2** Better daily briefs (`crypto-news/data/briefs/`), with the gate fields extracted in the same pass
- [ ] **D3** Event-risk scoring for FOMC/CPI/exchange news, compared against the fixed 8h rule (forward test only)

## E. Trade review

- [ ] **E1** Weekly post-mortem: ledger trades (tcore, bbtr, bb1h, bbn/icn/tcn) vs backtest expectations; feeds the **Dec 4 bb1h review** and tcn vs bbtr
- [ ] **E2** Pre-trade "second opinion", **paper only**: veto/shrink/ok with a reason, logged next to the real decision; judge after ~100 trades. Never on live.

## F. Process

- [ ] **F1** Code review on every bot change before a VPS deploy (`/code-review` + the existing test suites)
- [ ] **F2** Keep the install guides and `HOME-TODO` files accurate after each change

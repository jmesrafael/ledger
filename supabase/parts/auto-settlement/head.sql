-- AUTOMATIC TWO-MONTH SETTLEMENT. Docs: docs/auto-settlement.md. Tests: tests/auto-settlement.test.mjs. Rollback: supabase/rollback/20261214000000_rollback_auto_settlement.sql
-- Built by scripts/build-auto-settlement.mjs (edit supabase/parts/auto-settlement/*, not this file).
-- NOT applied to the live database (owner step). Safe to run twice. It rewrites no ledger row and makes no settlement when it is run.
--
-- What it adds: the existing true-value settlement (admin_close_quarter_tv, 20261207) runs BY ITSELF at the first verified MEXC wallet reading after a
-- two-month period ends (Jan 1, Mar 1, May 1, Jul 1, Sep 1, Nov 1, Manila time), inside the 7-day window. Nothing about the fee changes:
--   fee = the investor's rate x (their value - their high-water mark), only when that is positive (profit only; a deposit raises the mark, so their own money is
--   never charged). The fee moves as UNITS from the investor to the fund manager (ledger rows fee_out / fee_in at the same price), so total units, pool value and
--   the unit price do not move, and the books check (units sum = pool total, fee units net to zero) runs after it as after every write.
--
--   1. _close_quarter_tv_core(p_actor, ...): the body of admin_close_quarter_tv, unchanged, with the acting person passed in instead of a session token.
--      admin_close_quarter_tv(p_token, ...) is now the same core behind the manager's token ("Settle now" in the app).
--   2. _settle_auto(p_source): called after every wallet report (after the NAV reading). It does nothing unless ALL of these hold:
--        settlement_auto = 'on'; flow_pricing = 'true_value'; a period has ended that is not settled; now is inside its window;
--        the wallet reading is verified (complete, fresh, reconciled with the books) and was measured after the period ended;
--        open trades are allowed by settlement_auto_open_trades (below).
--      A failure inside it never loses the wallet report (it is a protected step, like the NAV reading), saves nothing, and is written to the audit log
--      (settlement_auto_waiting, once per reason per day). A settlement it makes is audited as settlement_closed plus settlement_auto.
--   3. settlement_auto_open_trades:
--        'allow' (default): settle with trades open. The fee is taken at the true price (open P&L included, once) and the mark moves to that price, so the same
--                 profit is never charged again when the trade closes. Under fee_timing = 'immediate' this needs an open_positions exception: the automatic run
--                 writes it itself (kind open_positions, the reading's exchange total, the number of open positions, a fixed note), so it is on record.
--        'wait':  settle only at a reading with no open position on any wallet. If none comes inside the window, nothing is settled and the manager decides.
--   4. admin_settlement_status(p_token): what the Settle screen shows (period, window, state, each investor's fee at the current true price, the last settlement,
--      the last automatic attempt). Reads only.
--
-- A period whose window passed without a settlement is NOT settled late by the automatic run. Nothing is lost: the mark is per investor, so the next
-- settlement charges everything above it (this is how the unsettled Sep-Oct 2026 period is covered by the Jan 1-7, 2027 settlement).

insert into public.ledger_settings(key, value) values
  ('settlement_auto', 'on'),                 -- 'off': no automatic settlement (the manager presses Settle now inside the window)
  ('settlement_auto_open_trades', 'allow')   -- 'allow' | 'wait' (see above)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 1. the settlement core (body of 20261207's admin_close_quarter_tv; only the actor's source differs)

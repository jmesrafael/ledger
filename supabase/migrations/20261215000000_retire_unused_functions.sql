-- RETIRE THE FUNCTIONS THE WEBSITE NO LONGER USES. Docs: docs/CLEANUP-REPORT.md. Tests: tests/retire.test.mjs. Rollback: supabase/rollback/20261215000000_rollback_retire_unused_functions.sql
-- NOT applied to the live database (owner step). Safe to run twice.
--
-- It only takes away the website role's right to CALL these functions (revoke execute from public, anon, authenticated). Nothing is dropped, no table is
-- touched, no row changes: the functions stay in the database, the triggers and the kept functions that use them internally keep working (they run as the
-- owner), and every record they ever wrote (balance checks, capital events, pool updates, corrections, audit rows) stays readable in History, the Log and backups.
--
-- The flow that stays open: Add investor, Cash in, Withdraw, Transfer (20261213), the payout steps (sent / completed / failed / retry), the automatic
-- settlement and Settle now (20261214), book corrections, undo of the newest entry, profiles, contacts, payout details, backups, the audit log, every investor
-- screen, and the four bot functions.
--
--   A. typed totals and book pricing, already refused by the database while flow_pricing = 'true_value' (or useless without a typed total)
--   B. the workflow gate / Balance desk (workflow_gate = 'off': never switched on)
--   C. the by-hand true-value steps the four steps replaced (record deposit -> seen in MEXC -> admit; peso top-up; approve -> redeem). These DO still work
--      today; they are retired because two ways to do the same thing is how money gets entered twice. Apply this only after one real cash-in and one real
--      withdrawal have gone through the four steps on the live database (see docs/CLEANUP-REPORT.md, owner decisions).

do $$
declare v_stranded int;
begin
  if to_regprocedure('public.admin_cash_in(text,uuid,numeric,numeric,numeric,boolean,text,text)') is null then
    raise exception 'retirement refused: the four steps (20261213000000_live_nav.sql) are not on this database';
  end if;
  if to_regprocedure('public.admin_settlement_status(text)') is null then
    raise exception 'retirement refused: run 20261214000000_auto_settlement.sql first (the Settle screen reads admin_settlement_status)';
  end if;
  if coalesce((select value from public.ledger_settings where key = 'flow_pricing'), 'book') <> 'true_value' then
    raise exception 'retirement refused: flow_pricing is not true_value, so the typed-total steps are still the ones in use';
  end if;
  if coalesce((select value from public.ledger_settings where key = 'workflow_gate'), 'off') = 'on' then
    raise exception 'retirement refused: workflow_gate is on, so the Balance desk is in use';
  end if;
  -- money recorded the old way and still waiting could only be admitted or handed back by a retired function
  select count(*) into v_stranded from public.pending_deposits d where d.status = 'pending'
    and not exists (select 1 from public.cash_ins c where d.id in (c.investor_pending_id, c.manager_pending_id));
  if v_stranded > 0 then
    raise exception 'retirement refused: % deposit(s) recorded by hand are still waiting. Admit them or hand them back first', v_stranded;
  end if;
  -- a request approved by hand is redeemed by a retired function (Withdraw / Process only takes requests that are still "requested")
  select count(*) into v_stranded from public.withdrawal_requests r where r.status = 'pending' and coalesce(r.stage, 'requested') = 'approved';
  if v_stranded > 0 then
    raise exception 'retirement refused: % withdrawal request(s) are approved by hand and not redeemed yet. Redeem or reject them first', v_stranded;
  end if;
end $$;

do $$
declare
  v_names text[] := array[
    -- A. typed totals and book pricing
    'admin_post_equity', 'admin_withdraw', 'admin_withdraw_to_manager', 'admin_units_from_manager', 'admin_quote_units_from_manager', 'admin_quote_withdraw',
    'admin_close_quarter', 'admin_settlement_preview', 'admin_settlement_preview_tv', 'admin_update_pool', 'admin_update_pool_and_admit', 'admin_pending_pnl', 'admin_pool_status',
    'admin_attest_settlement', 'admin_attest_snapshot', 'admin_wallet_nav',
    -- B. the workflow gate / Balance desk
    'admin_enter_balance', 'admin_confirm_balance', 'admin_reject_balance', 'admin_apply_balance', 'admin_add_adjustment', 'admin_classify_difference', 'admin_classify_pool_difference',
    'admin_classify_transfer', 'admin_escalate', 'admin_balance_checks', 'admin_capital_queue', 'admin_capital_events', 'admin_admit_deposit', 'admin_execute_withdrawal',
    'admin_quote_withdrawal', 'admin_quote_close', 'admin_settle_quarter', 'admin_confirm_arrival', 'admin_split_withdrawal_request', 'admin_withdrawal_queue',
    -- C. the by-hand true-value steps
    'admin_receive_deposit', 'admin_mark_arrived', 'admin_cancel_pending', 'admin_admit_deposit_tv', 'admin_admit_deposits_tv', 'admin_peso_topup', 'admin_quote_peso_topup',
    'admin_approve_withdrawal', 'admin_execute_withdrawal_tv'];
  r record; v_n int := 0;
begin
  for r in select p.oid::regprocedure as sig, p.proacl::text as acl, obj_description(p.oid, 'pg_proc') as note
             from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any (v_names) order by 1 loop
    -- the rights it had are kept on the function itself (its comment), so the rollback restores exactly them; a second run keeps the first note
    if r.note is null or r.note not like 'retired 20261215; rights before: %' then
      execute format('comment on function %s is %L', r.sig, 'retired 20261215; rights before: ' || coalesce(r.acl, 'default'));
    end if;
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    v_n := v_n + 1;
  end loop;
  raise notice 'retired % function(s): the website role can no longer call them', v_n;
end $$;

-- the list, readable by the rollback, the tests and anyone checking: every retired function and whether the website role can call it (must all be false)
create or replace function public._retired_functions() returns table (fn text, website_can_call boolean) language sql stable security definer set search_path = public as $$
  select p.oid::regprocedure::text, has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any (array[
    'admin_post_equity', 'admin_withdraw', 'admin_withdraw_to_manager', 'admin_units_from_manager', 'admin_quote_units_from_manager', 'admin_quote_withdraw',
    'admin_close_quarter', 'admin_settlement_preview', 'admin_settlement_preview_tv', 'admin_update_pool', 'admin_update_pool_and_admit', 'admin_pending_pnl', 'admin_pool_status',
    'admin_attest_settlement', 'admin_attest_snapshot', 'admin_wallet_nav',
    'admin_enter_balance', 'admin_confirm_balance', 'admin_reject_balance', 'admin_apply_balance', 'admin_add_adjustment', 'admin_classify_difference', 'admin_classify_pool_difference',
    'admin_classify_transfer', 'admin_escalate', 'admin_balance_checks', 'admin_capital_queue', 'admin_capital_events', 'admin_admit_deposit', 'admin_execute_withdrawal',
    'admin_quote_withdrawal', 'admin_quote_close', 'admin_settle_quarter', 'admin_confirm_arrival', 'admin_split_withdrawal_request', 'admin_withdrawal_queue',
    'admin_receive_deposit', 'admin_mark_arrived', 'admin_cancel_pending', 'admin_admit_deposit_tv', 'admin_admit_deposits_tv', 'admin_peso_topup', 'admin_quote_peso_topup',
    'admin_approve_withdrawal', 'admin_execute_withdrawal_tv'])
   order by 1
$$;
revoke all on function public._retired_functions() from public, anon, authenticated;

notify pgrst, 'reload schema';

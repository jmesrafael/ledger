-- ROLLBACK of 20261112000000_pool_update.sql. Restores the previous functions (their bodies were never edited, only renamed) and removes the guards.
-- No data is deleted: the four new tables are renamed *_rolled_back. Settings rows stay (harmless). Safe to run twice.
-- If an Update Pool was applied, its pool_equity entry stays in the books (it is an ordinary 'update' valuation) and its trades are no longer tracked as applied.
drop trigger if exists pool_ledger_guard on public.ledger;
drop function if exists public._pool_ledger_guard();

drop function if exists public.admin_update_pool_and_admit(text, bigint, text[], numeric, bigint[], text, boolean, text);
drop function if exists public.admin_update_pool(text, bigint, text[], numeric, text, boolean, text);
drop function if exists public.admin_classify_pool_difference(text, bigint, text, text);
drop function if exists public.admin_pool_status(text);
drop function if exists public.admin_pending_pnl(text);

do $$
begin
  if to_regprocedure('public._admin_admit_deposit_core(text,bigint,bigint,text,boolean)') is not null then
    drop function public.admin_admit_deposit(text, bigint, bigint, text, boolean);
    alter function public._admin_admit_deposit_core(text, bigint, bigint, text, boolean) rename to admin_admit_deposit;
  end if;
  if to_regprocedure('public._admin_execute_withdrawal_core(text,bigint,bigint,boolean,numeric,text,text,boolean)') is not null then
    drop function public.admin_execute_withdrawal(text, bigint, bigint, boolean, numeric, text, text, boolean);
    alter function public._admin_execute_withdrawal_core(text, bigint, bigint, boolean, numeric, text, text, boolean) rename to admin_execute_withdrawal;
  end if;
  if to_regprocedure('public._admin_undo_last_core(text,text)') is not null then
    drop function public.admin_undo_last(text, text);
    alter function public._admin_undo_last_core(text, text) rename to admin_undo_last;
  end if;
  if to_regprocedure('public._bot_post_equity_core(text,numeric,text)') is not null then
    drop function public.bot_post_equity(text, numeric, text);
    alter function public._bot_post_equity_core(text, numeric, text) rename to bot_post_equity;
  end if;
  if to_regprocedure('public._bot_post_snapshot_core(text,numeric,int,int,numeric,numeric,jsonb,boolean)') is not null then
    drop function public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean);
    alter function public._bot_post_snapshot_core(text, numeric, int, int, numeric, numeric, jsonb, boolean) rename to bot_post_snapshot;
  end if;
end $$;
grant execute on function public.admin_admit_deposit(text, bigint, bigint, text, boolean), public.admin_execute_withdrawal(text, bigint, bigint, boolean, numeric, text, text, boolean),
  public.admin_undo_last(text, text), public.bot_post_equity(text, numeric, text),
  public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean) to anon, authenticated;

drop view if exists public.capital_flows;
drop view if exists public.pending_pnl;
drop view if exists public.pending_live_exits;
drop function if exists public._pool_guard(bigint);
drop function if exists public._pool_guard_pending();
drop function if exists public._pool_recon();
drop function if exists public._pool_log(text, text, jsonb);
drop function if exists public._pool_pending();
drop function if exists public._pool_unexplained(bigint);
drop function if exists public._pool_expected_total();
drop function if exists public._pool_tol(numeric);

-- the backup functions go back to their earlier definitions (20261110000000 and 20261109000000)
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payout_details', _dump_table('payout_details'),
    'idempotency_keys', _dump_table('idempotency_keys'),
    'holder_state', _dump_table('holder_state'),
    'investor_perf_draft_archive', _dump_table('investor_perf_draft_archive'),
    'perf_log_draft_archive', _dump_table('perf_log_draft_archive'),
    'settlement_exceptions', _dump_table('settlement_exceptions'),
    'contact_details', _dump_table('contact_details'),
    'contact_history', _dump_table('contact_history'),
    -- the rolled-back pool tables keep their data in every backup under their new names
    'pool_updates_rolled_back', _dump_table('pool_updates_rolled_back'),
    'applied_trades_rolled_back', _dump_table('applied_trades_rolled_back'),
    'applied_trades_log_rolled_back', _dump_table('applied_trades_log_rolled_back'),
    'pool_recon_log_rolled_back', _dump_table('pool_recon_log_rolled_back'))
$$;
revoke all on function public._export_extra() from public, anon, authenticated;
create or replace function public.admin_backup_coverage(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_keys text[]; v_excl text[] := array['sessions', 'backup_keys', 'app_settings', 'backtest_runs'];
begin
  perform _admin(p_token);
  select array_agg(k) into v_keys from jsonb_object_keys(_export_all()) k;
  return jsonb_build_object(
    'missing', coalesce((select jsonb_agg(t.table_name order by t.table_name) from information_schema.tables t
                          where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> all (v_excl)
                            and coalesce(case t.table_name when 'profiles' then 'people' when 'ledger_settings' then 'settings' end, t.table_name) <> all (v_keys)), '[]'::jsonb),
    'excluded', to_jsonb(v_excl),
    'excluded_why', 'sessions and backup_keys hold secrets; app_settings and backtest_runs belong to the backtester, not the ledger');
end $$;
revoke all on function public.admin_backup_coverage(text) from public;
grant execute on function public.admin_backup_coverage(text) to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['applied_trades', 'applied_trades_log', 'pool_recon_log', 'pool_updates'] loop
    if to_regclass('public.' || t) is not null and to_regclass('public.' || t || '_rolled_back') is null then
      execute format('alter table public.%I rename to %I', t, t || '_rolled_back');
    end if;
  end loop;
end $$;

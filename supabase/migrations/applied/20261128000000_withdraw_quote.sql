-- READ-ONLY WITHDRAWAL QUOTE for the Money out form. Run after 20261105000000_hwm_arrival_lockup.sql. NOT applied to any database yet. Safe to run twice.
-- Changes no data, no rule and no existing function. It adds admin_quote_withdraw: the real admin_withdraw (or admin_withdraw_to_manager) runs inside a
-- sub-transaction that is then rolled back, so the quote is the database's own result for exactly these inputs (fee, withdrawal fee, payout, price) and every
-- refusal the real call would raise (lock-up, minimum, pending live trades, a big valuation move, more units than held). Same pattern as 1106's
-- admin_quote_withdrawal, which quotes a workflow request; this one quotes the direct form. The browser stops estimating the fee itself (js/app.js wdPrev).
-- Side effect: id sequences used inside the rolled-back call still advance (gaps in ids, nothing else).

create or replace function public.admin_quote_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_force boolean default false, p_to_manager boolean default false, p_at timestamptz default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_res jsonb;
begin
  perform _admin(p_token);
  perform _ledger_lock();
  begin
    if p_to_manager then
      v_res := admin_withdraw_to_manager(p_token, p_profile, p_units, p_equity_before, p_php_rate, null, p_force, null, p_at, null, p_confirm);
    else
      v_res := admin_withdraw(p_token, p_profile, p_units, p_equity_before, p_php_rate, null, p_force, null, p_at, null, p_confirm);
    end if;
    raise exception 'quote rolled back' using errcode = 'WQ002';
  exception when sqlstate 'WQ002' then null;
  end;
  return v_res || jsonb_build_object('quote', true, 'units', p_units, 'to_manager', p_to_manager);
end $$;

revoke all on function public.admin_quote_withdraw(text, uuid, numeric, numeric, numeric, boolean, boolean, timestamptz, boolean) from public;
grant execute on function public.admin_quote_withdraw(text, uuid, numeric, numeric, numeric, boolean, boolean, timestamptz, boolean) to anon, authenticated;

notify pgrst, 'reload schema';

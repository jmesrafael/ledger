-- Rollback of 20261204000000_auto_pool_trades_mode.sql: automatic valuation back to off / wallet mode only. Pool values already booked stay (the ledger is append-only).
update public.ledger_settings set value = 'off' where key = 'auto_pool_mode' and value = 'trades';
drop function if exists public._auto_pool_value(text);
drop function if exists public._auto_pool_value_trades(text);
alter function public._auto_pool_value_wallet(text) rename to _auto_pool_value;
revoke all on function public._auto_pool_value(text) from public, anon, authenticated;
notify pgrst, 'reload schema';

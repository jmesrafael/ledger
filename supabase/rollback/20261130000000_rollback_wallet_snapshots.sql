-- ROLLBACK of 20261130000000_wallet_snapshots.sql. Turns both modes off: every wrapped function then behaves exactly as before the migration
-- (admin_withdraw -> the old function, _net_equity / _pool_guard* / _wf_ready -> the old rules). Nothing is deleted: the wallet tables, their snapshots and the renamed
-- functions stay, so you can turn the modes on again. The bots keep reporting harmlessly (the snapshots are only stored).
-- Money already redeemed under the cap stays redeemed: this changes what is allowed from now on, not the books.
update public.ledger_settings set value = 'off' where key in ('wallet_nav_mode', 'payout_cap_mode');
select key, value from public.ledger_settings where key in ('wallet_nav_mode', 'payout_cap_mode') order by key;
-- To also stop a wallet from reporting: update public.bot_wallets set active = false where wallet = 'bbcore';   (its key then returns "not allowed")

-- READ-ONLY. Paste into the Supabase SQL Editor and Run. It changes nothing: it only asks the database whether each migration's own objects exist.
-- applied = true means that migration (or what it creates) is already in this database. Run the ones that say false, in this order.
select * from (values
  (1, '20261109000000_settlement_controls_backup',   to_regclass('public.settlement_exceptions') is not null),
  (2, '20261110000000_contact_details',              to_regclass('public.contact_details') is not null),
  (3, '20261111000000_bot_events',                   to_regclass('public.bot_events') is not null),
  (4, '20261112000000_pool_update',                  to_regclass('public.pool_updates') is not null),
  (5, '20261113000000_bot_ask',                      exists (select 1 from pg_constraint where conname = 'bot_events_type_check' and conrelid = to_regclass('public.bot_events') and pg_get_constraintdef(oid) like '%ask%')),
  (6, '20261114000000_fee_20 (changes the default fee to 20%)', coalesce((select value::numeric from public.ledger_settings where key = 'default_fee_rate'), 0) >= 0.2),
  (7, '20261115000000_payout_methods',               to_regclass('public.payout_details') is not null and not exists (select 1 from pg_constraint where conrelid = 'public.payout_details'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%gcash%')),
  (8, '20261116000000_bot_events_more_symbols',      exists (select 1 from pg_constraint where conname = 'bot_events_symbol_check' and conrelid = to_regclass('public.bot_events') and pg_get_constraintdef(oid) like '%NEAR_USDT%')),
  (9, '20261126000000_bot_events_gala',              exists (select 1 from pg_constraint where conname = 'bot_events_symbol_check' and conrelid = to_regclass('public.bot_events') and pg_get_constraintdef(oid) like '%GALA_USDT%')),
  (10, '20261127000000_confirmed_gain_fee',          to_regprocedure('public._settlement_fingerprint(numeric,timestamptz)') is not null),
  (11, '20261128000000_withdraw_quote',              to_regprocedure('public.admin_quote_withdraw(text,uuid,numeric,numeric,numeric,boolean,boolean,timestamptz,boolean)') is not null),
  (12, '20261130000000_wallet_snapshots',            to_regclass('public.wallet_snapshots') is not null)
) as t(step, migration, applied) order by step;

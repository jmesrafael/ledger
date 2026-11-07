-- PREPARES (does not apply) the two corrections found on Nov 7, 2026. Run after 20261207000000_true_value_pricing.sql. Nothing moves until the manager applies each one
-- with admin_apply_book_correction (signed in), which writes one pool entry with the reason and the evidence. Re-running this file adds nothing twice.
insert into public.book_corrections(amount_usdt, reason, evidence)
select -4.9258, 'BB-Core SOL short closed 2026-11-04 14:48 UTC (realized -4.9258 USDT) was never added to the pool value: I-Core''s GALA (closed 15:05) reached the ledger 2 s earlier and the old "already included" rule skipped SOL.',
  jsonb_build_object('closed_trade_id', 11, 'wallet', 'bbcore', 'symbol', 'SOL_USDT', 'closed_at', '2026-11-04T14:48:03Z', 'realized_usd', -4.9258,
    'pool_log', '2026-11-04 16:05:06 "1 closed trade(s) closed before the pool value #14 was booked: treated as already included"', 'fix', '20261206000000_auto_pool_late_trade.sql')
where not exists (select 1 from public.book_corrections where evidence->>'closed_trade_id' = '11');
insert into public.book_corrections(amount_usdt, reason, evidence)
select 0.8582, 'The 2026-10-28 14:33 valuation (52.3082 -> 51.45) included the open loss of two trades (SOL short 0.6 @ 99.62, ZEC long 0.01 @ 1298.8, about -0.91 at MEXC prices); both later closed and their full results were added again, so that loss was counted twice.',
  jsonb_build_object('pool_equity_id', 2, 'valuation_change_usd', -0.8582, 'open_positions', jsonb_build_array('SOL_USDT SHORT 0.6 @ 99.62', 'ZEC_USDT LONG 0.01 @ 1298.8'),
    'mexc_prices_14_30_utc', jsonb_build_object('SOL_USDT', 100.82, 'ZEC_USDT', 1274.22), 'later_closed_trades', jsonb_build_array('SOL short +3.3959 on 2026-11-01', 'ZEC long -0.7967 on 2026-10-29'))
where not exists (select 1 from public.book_corrections where evidence->>'pool_equity_id' = '2');
select id, amount_usdt, status, left(reason, 80) from public.book_corrections order by id;

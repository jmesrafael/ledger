-- Wipes ALL ledger entries (deposits, withdrawals, fees, equity readings, requests) but keeps the accounts/logins.
-- Use it after practising with fake numbers, BEFORE the first real deposit. The books are append-only, so this is the only way to clear them.
-- Never run this once real money is recorded.
truncate table public.withdrawal_requests, public.holder_state, public.ledger, public.pool_equity restart identity;

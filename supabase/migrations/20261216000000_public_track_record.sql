-- PUBLIC TRACK RECORD: the numbers the public page /track-record may show, and nothing else.
-- Used by api/track-record.js (server side, service role). Tests: tests/track-record.test.mjs.
-- Rollback: drop function if exists public.public_track_record();
-- NOT applied to the live database (owner step). Safe to run twice. Read only: it writes nothing.
--
-- What it returns (one jsonb):
--   daily          [[date, unit_price, source, day_low, day_high], ...] one row per Manila day (low / high only on 'live' days): the LAST verified live NAV reading of that day ('live'),
--                  or, on a day with no live reading, the last book price of pool_equity ('book'). The unit price is an index (1.0 at the start),
--                  so it only shows PERCENT growth from trading. Deposits, withdrawals and transfers do not move it.
--   live           { price, at } the newest verified live NAV reading
--   open_positions total open positions right now (summed over the active wallets whose last report is under 30 minutes old)
--   trades         { closed, wins, losses } counts of closed live trades
-- What it never returns: USDT amounts, pool size, units, investors, wallet or bot names, how many bots there are, symbols, sides, prices of trades.
-- Not callable by the browser (anon / authenticated): only the service role, so the public endpoint can cache it and rate limit.

create or replace function public.public_track_record() returns jsonb
language sql stable security definer set search_path = public as $$
  with nav as (
    select (ts at time zone 'Asia/Manila')::date d, unit_price p, ts from nav_snapshots where status = 'verified' and unit_price > 0
  ), navd as (
    select d, (array_agg(p order by ts desc))[1] p, 'live'::text src, min(p) lo, max(p) hi from nav group by d
  ), book as (
    select distinct on ((ts at time zone 'Asia/Manila')::date) (ts at time zone 'Asia/Manila')::date d, unit_price p, 'book'::text src, null::numeric lo, null::numeric hi
    from pool_equity where reversed_of is null and unit_price > 0
    order by (ts at time zone 'Asia/Manila')::date, ts desc, id desc
  ), days as (
    select d, p, src, lo, hi from navd
    union all
    select d, p, src, lo, hi from book b where not exists (select 1 from navd n where n.d = b.d)
  ), w as (
    select s.open_positions, s.received_at from bot_wallets bw
    cross join lateral (select x.open_positions, x.received_at from wallet_snapshots x where x.wallet = bw.wallet order by x.id desc limit 1) s
    where bw.active
  )
  select jsonb_build_object(
    'daily', coalesce((select jsonb_agg(jsonb_build_array(d, round(p, 6), src, round(lo, 6), round(hi, 6)) order by d) from days), '[]'::jsonb),
    'live', (select jsonb_build_object('price', round(unit_price, 6), 'at', ts) from nav_snapshots where status = 'verified' and unit_price > 0 order by ts desc limit 1),
    'open_positions', (select sum(open_positions) from w where received_at > now() - interval '30 minutes'),
    'trades', (select jsonb_build_object('closed', count(*), 'wins', count(*) filter (where realized_usd > 0), 'losses', count(*) filter (where realized_usd < 0)) from closed_trades),
    'generated_at', now());
$$;

revoke all on function public.public_track_record() from public, anon, authenticated;
grant execute on function public.public_track_record() to service_role;

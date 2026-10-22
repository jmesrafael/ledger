-- Trading returns everyone may see, so investors can check the manager's own money is in the same boat.
--
-- fund_returns: one row per pool event with the unit price at that moment and whether the manager held units after it.
--   The unit price is the pure trading result: deposits, withdrawals and the profit share never move it (they buy or
--   redeem units at the current price, or move units between people). Chaining price changes over the periods someone
--   held units gives their return from trading only, whatever they added or took out.
--   Carries no pool size, no units and no amounts, so it keeps 20261023000000_hide_pool_from_investors.sql intact.
-- _history: unchanged except each point now also carries the pool event id, so a person's points line up exactly
--   with fund_returns rows (two events can share a timestamp).
-- Run after 20261028000000_terms_acceptance.sql. Safe on live data (functions only; no tables touched).

create or replace function public.fund_returns(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _me(p_token);   -- any signed-in person, including a read-only "view as" session
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'ts', e.ts, 'price', e.unit_price,
             'mgr', (select coalesce(sum(l.units), 0) from ledger l join profiles p on p.id = l.profile_id
                      where p.role = 'admin' and l.equity_id <= e.id) > 0.000000001)
           order by e.id)
      from pool_equity e), '[]'::jsonb);
end $$;

create or replace function public._history(p uuid) returns jsonb language sql stable security definer set search_path = public as $$
  with ev as (
    select e.id, e.ts, e.unit_price,
           (select coalesce(sum(l.units), 0) from ledger l where l.profile_id = p and l.equity_id <= e.id) as units,
           (select coalesce(sum(l.usdt), 0) from ledger l where l.profile_id = p and l.equity_id <= e.id
                                                          and l.kind in ('deposit', 'withdrawal')) as net_in
      from pool_equity e
     where e.id >= (select min(equity_id) from ledger where profile_id = p))
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ts', ts, 'value', units * unit_price, 'net_in', net_in, 'units', units, 'price', unit_price)
                            order by id), '[]'::jsonb) from ev
$$;

revoke all on function public.fund_returns(text) from public;
grant execute on function public.fund_returns(text) to anon, authenticated;

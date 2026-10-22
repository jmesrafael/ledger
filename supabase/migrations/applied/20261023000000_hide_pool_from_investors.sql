-- Investors only manage their own money: the pool's total size, ownership split and history are manager-only.
-- Run after 20261022000000_ledger.sql. Safe to run on live data (functions only; no tables touched).

create or replace function public.pool_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_price numeric := _price_now(); v_tu numeric := _total_units();
begin
  perform _admin(p_token);
  return jsonb_build_object(
    'unit_price', v_price, 'total_units', v_tu, 'equity_usdt', v_price * v_tu,
    'asof', (select ts from pool_equity order by id desc limit 1),
    'php_rate', _last_php_rate(), 'since_start_pct', v_price - 1,
    'admin_capital_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                      where p.role = 'admin' and l.kind in ('deposit', 'withdrawal')), 0),
    'admin_fee_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                  where p.role = 'admin' and l.kind in ('fee_in', 'fee_out')), 0),
    'investor_units', coalesce((select sum(l.units) from ledger l join profiles p on p.id = l.profile_id
                                 where p.role = 'investor'), 0),
    'investor_count', (select count(*) from (select l.profile_id from ledger l join profiles p on p.id = l.profile_id
                                               where p.role = 'investor' group by l.profile_id having sum(l.units) > 0) x),
    'pending_requests', (select count(*) from withdrawal_requests where status = 'pending'));
end $$;

create or replace function public.price_history(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('ts', ts, 'unit_price', unit_price, 'equity_usdt', equity_usdt,
                                                       'total_units', total_units, 'kind', kind) order by id) from pool_equity), '[]'::jsonb);
end $$;

-- an investor's own summary no longer carries their share of the pool (value / share would reveal the pool size)
create or replace function public.my_summary(p_token text) returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := _me(p_token); v_by uuid; r jsonb;
begin
  select impersonated_by into v_by from sessions where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  r := _holder_summary(v) || jsonb_build_object('impersonated', v_by is not null);
  if r->>'role' <> 'admin' then r := r - 'share_pct'; end if;
  return r;
end $$;

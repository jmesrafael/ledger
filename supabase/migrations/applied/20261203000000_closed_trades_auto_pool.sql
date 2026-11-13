-- Closed trades -> ledger, automatically.
--
-- 1. closed_trades: every closed live trade is recorded EXACTLY ONCE (unique wallet + MEXC position id) with the realized P&L MEXC booked
--    (history_positions.realised: the same figure the Telegram exit message shows). The bot sends it with its own wallet key.
--    A resend of the same trade is a harmless replay; the same trade with other numbers is refused, never overwritten.
-- 2. _auto_pool_value(): values the pool from the combined WALLET equity (which already contains every realized and unrealized result), as an
--    ordinary 'update' entry. It runs after each wallet report and each closed trade, and does nothing unless every gate below passes.
--    The unit price changes, units never do, so every holder gets their share by units and a joiner or leaver is never touched by earlier results:
--    this is the existing model (docs/accounting-model.md); no per-trade split of money is added on top of it.
--    The trade P&L is NOT added to the pool a second time: it only EXPLAINS the change (auto_pool_runs.residual).
-- 3. Off by default: ledger_settings.auto_pool_mode = 'off'. To turn on: wallet_nav_mode = 'require' first, then auto_pool_mode = 'on'.
--    Gates (each skip is logged once in pool_recon_log and returned, never raised): mode on, wallet_nav_mode require, ledger not paused (bot_sync_paused),
--    units exist, wallets fresh/not suspect/not skewed, no payout in progress, move under bot_max_jump, and (1) a closed trade is waiting for its
--    first valuation or (2) the last valuation is older than auto_pool_heartbeat_minutes. At most one valuation per auto_pool_min_minutes unless a trade is waiting.
-- Rollback: supabase/rollback/20261203000000_rollback_closed_trades_auto_pool.sql

insert into public.ledger_settings(key, value) values
  ('auto_pool_mode', 'off'), ('auto_pool_min_minutes', '15'), ('auto_pool_heartbeat_minutes', '240'), ('auto_pool_pause_on_payout', '1')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table if not exists public.closed_trades (
  id            bigserial primary key,
  wallet        text not null references public.bot_wallets(wallet),
  position_id   text not null check (length(position_id) between 1 and 64),
  symbol        text not null,
  side          text not null check (side in ('LONG', 'SHORT')),
  closed_at     timestamptz not null,
  realized_usd  numeric(20, 6) not null,          -- MEXC's realised P&L for the position, as booked (fees already in it or not: see auto_pool_runs.residual)
  fees_usd      numeric(20, 6),
  funding_usd   numeric(20, 6),
  r_result      numeric(12, 4),
  received_at   timestamptz not null default now(),
  equity_id     bigint references public.pool_equity(id),   -- the pool valuation that first included this trade; null = waiting for one
  reflected_at  timestamptz,
  unique (wallet, position_id)
);
create index if not exists closed_trades_waiting on public.closed_trades (closed_at) where equity_id is null;

create table if not exists public.auto_pool_runs (
  id               bigserial primary key,
  ts               timestamptz not null default now(),
  equity_id        bigint not null references public.pool_equity(id),
  nav_before       numeric not null,
  nav_after        numeric not null,
  unit_price       numeric not null,
  unrealized_after numeric,
  trades           int not null,
  realized_usd     numeric not null,
  residual         numeric,          -- (nav change) - (realized of the trades included) - (change in unrealized since the previous run). Fees, funding, rounding, or an unrecorded transfer.
  residual_flag    boolean not null default false
);

alter table public.closed_trades enable row level security;
alter table public.auto_pool_runs enable row level security;
revoke all on public.closed_trades, public.auto_pool_runs from public, anon, authenticated;
revoke all on sequence public.closed_trades_id_seq, public.auto_pool_runs_id_seq from public, anon, authenticated;

-- append-only: the figures can never change, a trade is never deleted; only the one-time "first valuation" link may be filled in
create or replace function public._closed_trade_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'closed trades cannot be deleted'; end if;
  if (new.wallet, new.position_id, new.symbol, new.side, new.closed_at, new.realized_usd, new.fees_usd, new.funding_usd, new.r_result)
     is distinct from (old.wallet, old.position_id, old.symbol, old.side, old.closed_at, old.realized_usd, old.fees_usd, old.funding_usd, old.r_result) then
    raise exception 'a closed trade cannot be edited';
  end if;
  if old.equity_id is not null and new.equity_id is distinct from old.equity_id then raise exception 'this trade is already included in a valuation'; end if;
  return new;
end $$;
drop trigger if exists closed_trade_guard on public.closed_trades;
create trigger closed_trade_guard before update or delete on public.closed_trades for each row execute function public._closed_trade_guard();

-- ---------------------------------------------------------------- the bot reports a closed trade
create or replace function public.bot_post_closed_trade(p_key text, p_wallet text, p_position_id text, p_symbol text, p_side text, p_closed_at timestamptz,
    p_realized numeric, p_fees numeric default null, p_funding numeric default null, p_r numeric default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  w bot_wallets%rowtype; t closed_trades%rowtype; v_now timestamptz := _clock(); v_pool jsonb;
begin
  select * into w from bot_wallets where wallet = p_wallet and active;
  if not found or w.key_hash is null or encode(digest(coalesce(p_key, ''), 'sha256'), 'hex') <> w.key_hash then raise exception 'not allowed'; end if;
  if p_position_id is null or length(trim(p_position_id)) = 0 then raise exception 'the trade needs its MEXC position id'; end if;
  if p_side not in ('LONG', 'SHORT') or p_symbol is null or p_closed_at is null or p_realized is null then raise exception 'incomplete closed trade'; end if;
  if p_closed_at > v_now + interval '5 minutes' then raise exception 'closed_at is in the future'; end if;
  if round(p_realized, 6) <> p_realized or (p_fees is not null and round(p_fees, 6) <> p_fees) or (p_funding is not null and round(p_funding, 6) <> p_funding) then
    raise exception 'amounts may have at most 6 decimals (the ledger never rounds a reported amount silently)';
  end if;
  perform pg_advisory_xact_lock(hashtext('closed_trade:' || p_wallet || ':' || p_position_id));
  select * into t from closed_trades where wallet = p_wallet and position_id = p_position_id;
  if found then
    if t.realized_usd = p_realized and t.symbol = p_symbol and t.side = p_side and t.closed_at = p_closed_at then
      return jsonb_build_object('ok', true, 'replayed', true, 'trade_id', t.id, 'included', t.equity_id is not null);
    end if;
    raise exception 'trade % of wallet % was already recorded with different figures (%): refused, nothing changed', p_position_id, p_wallet, t.realized_usd;
  end if;
  insert into closed_trades(wallet, position_id, symbol, side, closed_at, realized_usd, fees_usd, funding_usd, r_result, received_at)
  values (p_wallet, trim(p_position_id), p_symbol, p_side, p_closed_at, p_realized, p_fees, p_funding, p_r, v_now) returning * into t;
  -- the valuation is a separate step: whatever happens there, the trade stays recorded
  begin v_pool := _auto_pool_value('closed_trade'); exception when others then v_pool := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  return jsonb_build_object('ok', true, 'replayed', false, 'trade_id', t.id, 'pool', v_pool);
end $$;

-- ---------------------------------------------------------------- the automatic valuation
create or replace function public._auto_pool_value(p_source text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := _clock(); n jsonb; v_total numeric; v_net numeric; v_price numeric; v_u numeric; v_last pool_equity%rowtype; v_eq bigint;
  v_min numeric := _wf_setnum('auto_pool_min_minutes', 15); v_beat numeric := _wf_setnum('auto_pool_heartbeat_minutes', 240); v_jump numeric := coalesce(_setting('bot_max_jump'), '0.15')::numeric;
  v_waiting int; v_real numeric; v_unr numeric; v_prev auto_pool_runs%rowtype; v_res numeric; v_tol numeric; v_ids bigint[];
begin
  if coalesce(_setting('auto_pool_mode'), 'off') <> 'on' then return jsonb_build_object('ok', false, 'skipped', 'off'); end if;
  perform _ledger_lock();
  if _wallet_mode() <> 'require' then return _auto_skip(p_source, 'needs_wallet_mode', 'auto_pool_mode needs wallet_nav_mode = require'); end if;
  if coalesce(_setting('bot_sync_paused'), '0') = '1' then return _auto_skip(p_source, 'paused', 'automatic valuation is paused (bot_sync_paused)'); end if;
  v_u := _total_units();
  if v_u = 0 then return jsonb_build_object('ok', false, 'skipped', 'no_units'); end if;
  if coalesce(_setting('auto_pool_pause_on_payout'), '1') = '1' and exists (select 1 from withdrawal_requests where status = 'pending' and stage = 'approved') then
    return _auto_skip(p_source, 'payout_in_progress', 'a withdrawal is approved and not paid yet: its money may leave the exchange before it is recorded');
  end if;
  n := _wallet_nav();
  if not (n->>'ok')::boolean then
    return _auto_skip(p_source, 'wallets_not_ready', (select string_agg(x->>'text', '; ') from jsonb_array_elements(n->'reasons') x));
  end if;

  -- trades whose wallet reported AFTER they closed are inside that wallet's equity; the others wait for the next report
  select array_agg(c.id), count(*), coalesce(sum(c.realized_usd), 0) into v_ids, v_waiting, v_real
    from closed_trades c
    join lateral jsonb_array_elements(n->'wallets') w on w->>'wallet' = c.wallet
   where c.equity_id is null and c.closed_at <= (w->>'received_at')::timestamptz;
  v_waiting := coalesce(v_waiting, 0);

  select * into v_last from pool_equity order by id desc limit 1;
  if v_waiting = 0 then
    if v_last.id is not null and v_last.ts > v_now - make_interval(mins => v_min::int) then return jsonb_build_object('ok', false, 'skipped', 'too_soon'); end if;
    if v_last.id is not null and v_last.ts > v_now - make_interval(mins => v_beat::int) then return jsonb_build_object('ok', false, 'skipped', 'nothing_new'); end if;
  end if;

  v_total := _wallet_expected_total(n);
  v_net := _net_equity(v_total);
  if v_last.id is not null and v_last.equity_usdt > 0 and abs(v_net / v_last.equity_usdt - 1) > v_jump then
    return _auto_skip(p_source, 'jump', format('the wallets are %s%% away from the pool value (limit %s%%): probably a transfer in or out that was not recorded. Record it, then value by hand.',
      round((v_net / v_last.equity_usdt - 1) * 100, 2), round(v_jump * 100)));
  end if;
  if v_last.id is not null and abs(v_net - v_last.equity_usdt) < 0.000001 and v_waiting = 0 then return jsonb_build_object('ok', false, 'skipped', 'unchanged'); end if;

  v_price := _price_from(v_total);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (_at(null), 'update', v_net, v_u, v_price, _last_php_rate(),
          format('Auto (%s): wallets %s USDT, %s closed trade(s), realized %s', p_source, round((n->>'combined_equity_usdt')::numeric, 2), v_waiting, round(v_real, 2)), null)
  returning id into v_eq;

  v_unr := (n->>'combined_unrealized_usdt')::numeric;
  select * into v_prev from auto_pool_runs order by id desc limit 1;
  if found and v_prev.unrealized_after is not null and v_last.id is not null then
    v_res := round((v_net - v_last.equity_usdt) - v_real - (v_unr - v_prev.unrealized_after), 6);
  end if;
  v_tol := _pool_tol(v_net);
  insert into auto_pool_runs(equity_id, nav_before, nav_after, unit_price, unrealized_after, trades, realized_usd, residual, residual_flag)
  values (v_eq, coalesce(v_last.equity_usdt, 0), v_net, v_price, v_unr, v_waiting, v_real, v_res, v_res is not null and abs(v_res) > v_tol);
  if v_ids is not null then update closed_trades set equity_id = v_eq, reflected_at = v_now where id = any(v_ids); end if;
  if v_res is not null and abs(v_res) > v_tol then
    perform _pool_log('auto_pool', 'residual', jsonb_build_object('mismatch', v_res, 'tolerance', v_tol, 'equity_id', v_eq,
      'text', 'the pool change is not explained by the closed trades and the change in unrealized P&L: fees, funding, rounding, or a transfer that was not recorded'));
  end if;
  perform _check_books();
  return jsonb_build_object('ok', true, 'equity_id', v_eq, 'unit_price', v_price, 'nav_before', coalesce(v_last.equity_usdt, 0), 'nav_after', v_net,
    'trades', v_waiting, 'realized_usd', v_real, 'residual', v_res);
end $$;

create or replace function public._auto_skip(p_source text, p_code text, p_text text) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _pool_log('auto_pool', 'skipped', jsonb_build_object('mismatch', p_code, 'text', p_text, 'source', p_source));
  return jsonb_build_object('ok', false, 'skipped', p_code, 'detail', p_text);
end $$;

-- ---------------------------------------------------------------- every wallet report also triggers the valuation (its failure never rejects the report)
do $$
begin
  if to_regprocedure('public._bot_post_wallet_snapshot_core(text,text,bigint,timestamptz,numeric,numeric,numeric,numeric,int,int)') is null then
    alter function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) rename to _bot_post_wallet_snapshot_core;
  end if;
end $$;
revoke all on function public._bot_post_wallet_snapshot_core(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int) from public, anon, authenticated;

create or replace function public.bot_post_wallet_snapshot(p_key text, p_wallet text, p_seq bigint, p_reported_at timestamptz, p_equity numeric, p_unrealized numeric,
    p_withdrawable numeric, p_available numeric, p_open_positions int, p_open_orders int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; v_pool jsonb;
begin
  r := _bot_post_wallet_snapshot_core(p_key, p_wallet, p_seq, p_reported_at, p_equity, p_unrealized, p_withdrawable, p_available, p_open_positions, p_open_orders);
  if coalesce((r->>'replayed')::boolean, false) then return r; end if;
  begin v_pool := _auto_pool_value('wallet_report'); exception when others then v_pool := jsonb_build_object('ok', false, 'error', sqlerrm); end;
  return r || jsonb_build_object('pool', v_pool);
end $$;

-- ---------------------------------------------------------------- manager view: trades, what they changed, and what is still waiting
create or replace function public.admin_closed_trades(p_token text, p_limit int default 100) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return jsonb_build_object(
    'mode', coalesce(_setting('auto_pool_mode'), 'off'),
    'waiting', (select jsonb_build_object('count', count(*), 'realized_usd', coalesce(sum(realized_usd), 0)) from closed_trades where equity_id is null),
    'total', (select jsonb_build_object('count', count(*), 'realized_usd', coalesce(sum(realized_usd), 0)) from closed_trades),
    'trades', coalesce((select jsonb_agg(to_jsonb(t) order by t.closed_at desc) from (
        select c.id, c.wallet, c.position_id, c.symbol, c.side, c.closed_at, c.realized_usd, c.fees_usd, c.funding_usd, c.r_result, c.equity_id, c.reflected_at
          from closed_trades c order by c.closed_at desc, c.id desc limit greatest(1, least(coalesce(p_limit, 100), 500))) t), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.id desc) from (select * from auto_pool_runs order by id desc limit 20) r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- backup coverage
do $$
begin
  if to_regprocedure('public._export_extra_pre_trades()') is null then
    alter function public._export_extra() rename to _export_extra_pre_trades;
  end if;
end $$;
revoke all on function public._export_extra_pre_trades() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_pre_trades() || jsonb_build_object('closed_trades', _dump_table('closed_trades'), 'auto_pool_runs', _dump_table('auto_pool_runs'))
$$;

revoke all on function public._closed_trade_guard(), public._auto_pool_value(text), public._auto_skip(text, text, text), public._export_extra() from public, anon, authenticated;
revoke all on function public.bot_post_closed_trade(text, text, text, text, text, timestamptz, numeric, numeric, numeric, numeric),
  public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int), public.admin_closed_trades(text, int) from public;
grant execute on function public.bot_post_closed_trade(text, text, text, text, text, timestamptz, numeric, numeric, numeric, numeric),
  public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int), public.admin_closed_trades(text, int) to anon, authenticated;

notify pgrst, 'reload schema';

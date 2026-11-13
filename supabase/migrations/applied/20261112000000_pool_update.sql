-- POOL UPDATE: the bot's trading results never move the pool's money by themselves.
-- Run in filename order, after 20261106000000_capital_workflow.sql, 20261109000000_settlement_controls_backup.sql (backup functions) and
-- 20261111000000_bot_events.sql (it reads public.bot_events). NOT applied to any database. Safe to run twice.
--
--   1. Closed LIVE trades (bot_events type 'exit', mode 'live') are PENDING until the manager clicks "Update Pool" (admin_update_pool).
--      Paper trades can never be pending. Pending money changes nobody's units, the unit price or any balance.
--   2. admin_update_pool applies the CONFIRMED Exchange balance (a fresh, flat balance check) as an ordinary 'update' pool entry. The pending
--      trades only EXPLAIN the change: the check must reconcile (actual change - pending P/L within the tolerance) or nothing happens and the block is logged.
--      Each exit can be applied once (applied_trades primary key). The screen sends the exact exit ids and total it showed; a change in between is refused.
--   3. Joining and leaving are refused while any live exit is unapplied (functions AND a ledger trigger, so no direct path bypasses it).
--   4. bot_post_equity can no longer move the unit price unless the setting bot_equity_sync = 'on' (default 'off'). bot_post_snapshot keeps working.
--   5. admin_undo_last on an Update Pool returns its exits to pending.
--   6. capital_flows (deposits and payouts) for the bot dashboard, and a reconciliation of the exchange equity against the pool plus pending P/L.
--
-- Existing functions are NOT copied or edited: they are renamed to _<name>_core and wrapped. The cores are closed to the public roles.
-- Rollback: supabase/rollback/20261112000000_rollback_pool_update.sql

-- ---------------------------------------------------------------- 0. preflight
do $$
begin
  if to_regclass('public.bot_events') is null then raise exception 'preflight: run 20261111000000_bot_events.sql first. Nothing was changed.'; end if;
  if to_regprocedure('public._wf_ready(bigint)') is null or to_regprocedure('public._wf_residual(bigint)') is null then
    raise exception 'preflight: run 20261106000000_capital_workflow.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public._dump_table(text)') is null or to_regprocedure('public._export_all()') is null then
    raise exception 'preflight: run 20261109000000_settlement_controls_backup.sql first (the backup functions this migration extends). Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. settings
insert into public.ledger_settings(key, value) values
  ('bot_equity_sync', 'off'),          -- 'on' lets bot_post_equity move the unit price by itself. Leave it off: the pool moves only through Update Pool.
  ('pool_update_gate', 'on'),          -- 'on' = no join / payout while live trades are unapplied
  ('pool_recon_tol_abs', '0.5'),       -- reconciliation tolerance = max(abs, pct of the balance)
  ('pool_recon_tol_pct', '0.0005'),
  ('pool_recon_strict', '0'),          -- '1' = no recent bot snapshot also blocks (default: only a real mismatch blocks)
  ('queued_money_location', 'spot')    -- where money waits before acceptance: 'spot' (not traded, not in futures equity) or 'futures'
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 2. tables (closed to the website; only the functions below touch them)
create table if not exists public.pool_updates (
  id              bigserial primary key,
  ts              timestamptz not null default now(),
  equity_id       bigint unique references public.pool_equity(id),
  verification_id bigint,
  mexc_total      numeric not null,
  prev_nav        numeric,
  nav_after       numeric,
  actual_change   numeric,                 -- nav_after - prev_nav
  pending_count   int not null default 0,
  pending_usd     numeric not null default 0,
  pending_r       numeric not null default 0,
  missing_usd     int not null default 0,  -- exits the bot sent without a dollar figure (live equity not shared)
  difference      numeric,                 -- what the pending trades did NOT explain (inside the tolerance, or it was classified)
  tolerance       numeric,
  note            text,
  status          text not null default 'applied' check (status in ('applied', 'reverted')),
  created_by      uuid,
  reverted_at     timestamptz,
  reverted_by     uuid
);
create table if not exists public.applied_trades (
  event_id        text primary key,                      -- the bot event's id: one exit can be applied once (no foreign key, so a backup restores without bot_events)
  pool_update_id  bigint not null references public.pool_updates(id),
  ts_ms           bigint,
  symbol          text,
  usd             numeric,
  r               numeric,
  applied_at      timestamptz not null default now()
);
create index if not exists applied_trades_update_idx on public.applied_trades(pool_update_id);
create table if not exists public.applied_trades_log (   -- history: rows leave applied_trades only when an Update Pool is undone, and are kept here
  id              bigserial primary key,
  event_id        text not null,
  pool_update_id  bigint not null,
  usd             numeric,
  r               numeric,
  applied_at      timestamptz,
  released_at     timestamptz not null default now(),
  reason          text
);
create table if not exists public.pool_recon_log (        -- every time the reconciliation blocked something
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  source  text not null,
  status  text not null,
  detail  jsonb not null default '{}'::jsonb
);
do $$
declare t text;
begin
  foreach t in array array['pool_updates', 'applied_trades', 'applied_trades_log', 'pool_recon_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
  revoke all on sequence public.pool_updates_id_seq, public.applied_trades_log_id_seq, public.pool_recon_log_id_seq from public, anon, authenticated;
end $$;

-- ---------------------------------------------------------------- 3. views
create or replace view public.pending_live_exits as
  select e.event_id, e.ts_ms, e.symbol, e.side, e.data->>'trade_id' as trade_id,
         (e.data->>'usd')::numeric as usd, (e.data->>'r')::numeric as r, e.received_at
    from public.bot_events e
   where e.type = 'exit' and e.mode = 'live'
     and not exists (select 1 from public.applied_trades a where a.event_id = e.event_id);

create or replace view public.pending_pnl as
  select count(*)::int as trades, coalesce(sum(usd), 0) as usd, coalesce(sum(r), 0) as r, (count(*) filter (where usd is null))::int as missing_usd,
         min(ts_ms) as oldest_ms, max(ts_ms) as newest_ms
    from public.pending_live_exits;

-- the money that moved in or out of the trading account, for the bot dashboard (no names). usdt is signed: + in, - out.
--   deposit : when it joined the pool (= when it is moved into futures); reversals (an undone admission) are negative rows
--   payout  : when it was marked SENT from the exchange (before that the money is still in the account)
create or replace view public.capital_flows as
  select 'd:' || l.id as flow_id, 'deposit'::text as kind, l.ts, (extract(epoch from l.ts) * 1000)::bigint as ts_ms, l.usdt as usdt,
         case when l.reversed_of is null then 'admitted' else 'admission undone' end as note
    from public.ledger l where l.kind = 'deposit'
  union all
  select 'w:' || po.id, 'payout', po.sent_at, (extract(epoch from po.sent_at) * 1000)::bigint, -po.amount_usdt, 'payout sent'
    from public.payout_records po where po.leaves_mexc and po.status in ('sent', 'completed') and po.sent_at is not null;

revoke all on public.pending_live_exits, public.pending_pnl, public.capital_flows from public, anon, authenticated;

-- ---------------------------------------------------------------- 4. helpers
create or replace function public._pool_tol(p_total numeric) returns numeric language sql stable security definer set search_path = public as $$
  select greatest(_wf_setnum('pool_recon_tol_abs', 0.5), coalesce(p_total, 0) * _wf_setnum('pool_recon_tol_pct', 0.0005))
$$;


-- What the books say the exchange account total should be right now, and how far a typed balance is from that (after what the manager already classified).
--   expected = pool NAV + money waiting in the exchange to join + money redeemed but not yet sent out + pending live P/L
-- This reads the books, not the chain of earlier balance checks, so it stays right after an undo.
create or replace function public._pool_expected_total() returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce((select equity_usdt from pool_equity order by id desc limit 1), 0) + _pending_total()
       + coalesce((select sum(amount_usdt) from payout_records where leaves_mexc and status in ('awaiting', 'failed')), 0)
       + coalesce((_pool_pending()->>'usd')::numeric, 0);
end $$;
create or replace function public._pool_unexplained(p_vid bigint) returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  return (select v.mexc_total - _pool_expected_total()
         - coalesce((select sum(a.amount) from verification_adjustments a where a.verification_id = v.id and a.classified and a.kind <> 'trading_pnl'), 0)
    from balance_verifications v where v.id = p_vid);
end $$;

create or replace function public._pool_pending() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('count', count(*), 'usd', coalesce(sum(usd), 0), 'r', coalesce(sum(r), 0), 'missing_usd', count(*) filter (where usd is null),
    'oldest_ms', min(ts_ms), 'newest_ms', max(ts_ms),
    'ids', coalesce(jsonb_agg(event_id order by event_id), '[]'::jsonb),
    'exits', coalesce(jsonb_agg(jsonb_build_object('event_id', event_id, 'ts_ms', ts_ms, 'symbol', symbol, 'side', side, 'usd', usd, 'r', r) order by ts_ms, event_id), '[]'::jsonb))
  from pending_live_exits
$$;

create or replace function public._pool_log(p_source text, p_status text, p_detail jsonb) returns void language plpgsql security definer set search_path = public as $$
declare l pool_recon_log%rowtype;
begin
  select * into l from pool_recon_log order by id desc limit 1;
  -- the same block repeated by every bot run is one line, not hundreds
  if found and l.status = p_status and coalesce(l.detail->>'mismatch', '') = coalesce(p_detail->>'mismatch', '') then return; end if;
  insert into pool_recon_log(source, status, detail) values (p_source, p_status, coalesce(p_detail, '{}'::jsonb));
end $$;

-- Exchange futures equity (newest bot snapshot) against what the books say it should be.
--   expected = pool NAV + pending live P/L + unrealized + money redeemed but not yet sent out of the exchange (+ queued money, only when it waits in futures)
-- Status: ok | mismatch | waiting_snapshot (something changed after the snapshot) | no_snapshot | stale_snapshot | incomplete (an exit has no dollar figure)
create or replace function public._pool_recon() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s exchange_snapshots%rowtype; v_nav numeric; v_pend jsonb := _pool_pending(); v_unsent numeric; v_queued numeric; v_exp numeric; v_obs numeric; v_tol numeric;
  v_changed timestamptz; v_status text; v_where text := coalesce(_setting('queued_money_location'), 'spot');
begin
  select coalesce((select equity_usdt from pool_equity order by id desc limit 1), 0) into v_nav;
  select coalesce(sum(amount_usdt), 0) into v_unsent from payout_records where leaves_mexc and status in ('awaiting', 'failed');
  select coalesce(sum(usdt), 0) into v_queued from pending_deposits where status = 'pending' and arrived_at is not null;
  select * into s from exchange_snapshots order by id desc limit 1;
  if not found then
    return jsonb_build_object('status', 'no_snapshot', 'blocking', coalesce(_setting('pool_recon_strict'), '0') = '1', 'nav', v_nav, 'pending_usd', v_pend->'usd', 'pending_trades', v_pend->'count');
  end if;
  v_exp := v_nav + (v_pend->>'usd')::numeric + coalesce(s.unrealized_usdt, 0) + v_unsent + case when v_where = 'futures' then v_queued else 0 end;
  v_obs := s.equity_usdt; v_tol := _pool_tol(v_obs);
  select greatest(
      coalesce((select max(ts) from pool_equity), '-infinity'),
      coalesce((select to_timestamp(max(ts_ms) / 1000.0) from bot_events where type = 'exit' and mode = 'live'), '-infinity'),
      coalesce((select max(greatest(created_at, coalesce(sent_at, created_at))) from payout_records), '-infinity'),
      coalesce((select max(greatest(coalesce(arrived_at, '-infinity'), coalesce(admitted_at, '-infinity'))) from pending_deposits), '-infinity'))
    into v_changed;
  if s.ts < now() - make_interval(secs => _wf_setnum('snapshot_max_age_hours', 12) * 3600) then v_status := 'stale_snapshot';
  elsif v_changed > s.ts then v_status := 'waiting_snapshot';
  elsif (v_pend->>'missing_usd')::int > 0 then v_status := 'incomplete';
  elsif abs(v_obs - v_exp) > v_tol then v_status := 'mismatch';
  else v_status := 'ok'; end if;
  return jsonb_build_object('status', v_status, 'blocking', v_status = 'mismatch' or (v_status in ('stale_snapshot') and coalesce(_setting('pool_recon_strict'), '0') = '1'),
    'observed', v_obs, 'expected', v_exp, 'mismatch', round(v_obs - v_exp, 6), 'tolerance', v_tol, 'snapshot_ts', s.ts,
    'parts', jsonb_build_object('pool_nav', v_nav, 'pending_pnl', v_pend->'usd', 'unrealized', coalesce(s.unrealized_usdt, 0), 'redeemed_not_sent', v_unsent,
                                'queued_money', v_queued, 'queued_location', v_where), 'pending_trades', v_pend->'count', 'missing_usd', v_pend->'missing_usd');
end $$;

-- the guard behind joins and payouts. p_vid null = only the "unapplied trades" rule (used by the ledger trigger)
create or replace function public._pool_guard_pending() returns void language plpgsql stable security definer set search_path = public as $$
declare p jsonb;
begin
  if coalesce(_setting('pool_update_gate'), 'on') <> 'on' then return; end if;
  p := _pool_pending();
  if (p->>'count')::int > 0 then
    raise exception 'pending P/L: % closed live trade(s) (%) are not applied to the pool yet. Click Update Pool first, then accept joiners or pay out.',
      p->>'count', case when (p->>'missing_usd')::int > 0 then 'dollar amount not shared' else round((p->>'usd')::numeric, 2)::text || ' USDT' end;
  end if;
end $$;

create or replace function public._pool_guard(p_vid bigint) returns void language plpgsql stable security definer set search_path = public as $$
declare v balance_verifications%rowtype; v_last bigint; r jsonb;
begin
  if coalesce(_setting('pool_update_gate'), 'on') <> 'on' then return; end if;
  perform _pool_guard_pending();
  select max(ts_ms) into v_last from bot_events where type = 'exit' and mode = 'live';
  if p_vid is not null and v_last is not null then
    select * into v from balance_verifications where id = p_vid;
    if found and v.entered_at < to_timestamp(v_last / 1000.0) then
      raise exception 'this balance check (%) is older than the newest closed live trade: enter and confirm a new balance check, then Update Pool.', v.entered_at;
    end if;
  end if;
  r := _pool_recon();
  if (r->>'blocking')::boolean then
    raise exception 'reconciliation mismatch: Exchange equity % vs books % (difference %, tolerance %). Explain it before money moves.',
      r->>'observed', r->>'expected', r->>'mismatch', r->>'tolerance';
  end if;
end $$;

create or replace function public._pool_ledger_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('deposit', 'withdrawal') and new.reversed_of is null then perform _pool_guard_pending(); end if;
  return new;
end $$;
drop trigger if exists pool_ledger_guard on public.ledger;
create trigger pool_ledger_guard before insert on public.ledger for each row execute function public._pool_ledger_guard();

-- ---------------------------------------------------------------- 5. wrap the existing functions (rename to _core, close the core, wrapper keeps the name and grants)
do $$
begin
  if to_regprocedure('public._admin_admit_deposit_core(text,bigint,bigint,text,boolean)') is null then
    alter function public.admin_admit_deposit(text, bigint, bigint, text, boolean) rename to _admin_admit_deposit_core;
  end if;
  if to_regprocedure('public._admin_execute_withdrawal_core(text,bigint,bigint,boolean,numeric,text,text,boolean)') is null then
    alter function public.admin_execute_withdrawal(text, bigint, bigint, boolean, numeric, text, text, boolean) rename to _admin_execute_withdrawal_core;
  end if;
  if to_regprocedure('public._admin_undo_last_core(text,text)') is null then
    alter function public.admin_undo_last(text, text) rename to _admin_undo_last_core;
  end if;
  if to_regprocedure('public._bot_post_equity_core(text,numeric,text)') is null then
    alter function public.bot_post_equity(text, numeric, text) rename to _bot_post_equity_core;
  end if;
  if to_regprocedure('public._bot_post_snapshot_core(text,numeric,int,int,numeric,numeric,jsonb,boolean)') is null then
    alter function public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean) rename to _bot_post_snapshot_core;
  end if;
end $$;
revoke all on function public._admin_admit_deposit_core(text, bigint, bigint, text, boolean), public._admin_execute_withdrawal_core(text, bigint, bigint, boolean, numeric, text, text, boolean),
  public._admin_undo_last_core(text, text), public._bot_post_equity_core(text, numeric, text),
  public._bot_post_snapshot_core(text, numeric, int, int, numeric, numeric, jsonb, boolean) from public, anon, authenticated;

create or replace function public.admin_admit_deposit(p_token text, p_pending bigint, p_vid bigint, p_idem text default null, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  perform _ledger_lock();
  if _idem_get(p_idem, 'admin_admit_deposit') is null then perform _pool_guard(p_vid); end if;   -- a replay returns the stored answer, it is not a new admission
  return _admin_admit_deposit_core(p_token, p_pending, p_vid, p_idem, p_confirm);
end $$;

create or replace function public.admin_execute_withdrawal(p_token text, p_request bigint, p_vid bigint, p_to_manager boolean default false,
    p_php_rate numeric default null, p_note text default null, p_idem text default null, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  perform _ledger_lock();
  if _idem_get(p_idem, 'admin_execute_withdrawal') is null then perform _pool_guard(p_vid); end if;
  return _admin_execute_withdrawal_core(p_token, p_request, p_vid, p_to_manager, p_php_rate, p_note, p_idem, p_confirm);
end $$;

-- undoing an Update Pool: the engine reverses the pool entry; here its exits go back to pending (kept in applied_trades_log)
create or replace function public.admin_undo_last(p_token text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_eq bigint; pu pool_updates%rowtype; v_out jsonb; v_n int := 0;
begin
  perform _ledger_lock();
  select id into v_eq from pool_equity order by id desc limit 1;
  select * into pu from pool_updates where equity_id = v_eq and status = 'applied';
  v_out := _admin_undo_last_core(p_token, p_note);
  if pu.id is not null then
    insert into applied_trades_log(event_id, pool_update_id, usd, r, applied_at, reason)
      select event_id, pool_update_id, usd, r, applied_at, 'Update Pool undone' from applied_trades where pool_update_id = pu.id;
    delete from applied_trades where pool_update_id = pu.id;
    get diagnostics v_n = row_count;
    update pool_updates set status = 'reverted', reverted_at = now(), reverted_by = v_actor where id = pu.id;
    perform _wf_event(v_actor, 'valuation', pu.id, 'pool_update_undone', jsonb_build_object('exits_returned', v_n, 'pending_usd', pu.pending_usd), v_eq, pu.verification_id);
    v_out := v_out || jsonb_build_object('pool_update_id', pu.id, 'exits_returned_to_pending', v_n);
  end if;
  return v_out;
end $$;

-- the bot can no longer move the unit price unless bot_equity_sync = 'on'
create or replace function public.bot_post_equity(p_key text, p_equity numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text := _setting('bot_key_hash');
begin
  if v_hash is null or v_hash = '' or encode(digest(coalesce(p_key, ''), 'sha256'), 'hex') <> v_hash then raise exception 'not allowed'; end if;
  if coalesce(_setting('bot_equity_sync'), 'off') <> 'on' then
    return jsonb_build_object('ok', false, 'skipped', 'disabled', 'detail', 'the pool moves only through Update Pool (bot_equity_sync is off)');
  end if;
  return _bot_post_equity_core(p_key, p_equity, p_note);
end $$;

-- the snapshot path is unchanged; afterwards the reconciliation is checked and a block is logged (a logging failure never stops the snapshot)
create or replace function public.bot_post_snapshot(p_key text, p_equity numeric, p_open_positions int, p_open_orders int,
    p_unrealized numeric default null, p_realized_since numeric default null, p_transfers jsonb default '[]'::jsonb, p_transfers_complete boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_res jsonb; r jsonb;
begin
  v_res := _bot_post_snapshot_core(p_key, p_equity, p_open_positions, p_open_orders, p_unrealized, p_realized_since, p_transfers, p_transfers_complete);
  begin
    r := _pool_recon();
    if (r->>'blocking')::boolean then perform _pool_log('snapshot', r->>'status', r); end if;
  exception when others then null;
  end;
  return v_res;
end $$;

-- ---------------------------------------------------------------- 6. the manager's functions
create or replace function public.admin_pending_pnl(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return _pool_pending();
end $$;

-- recon + pending + recent updates + recent blocks, for the screen. Logs a block the first time it is seen.
create or replace function public.admin_pool_status(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform _admin(p_token);
  r := _pool_recon();
  if (r->>'blocking')::boolean then perform _pool_log('screen', r->>'status', r); end if;
  return jsonb_build_object('pending', _pool_pending(), 'recon', r, 'gate', coalesce(_setting('pool_update_gate'), 'on'), 'bot_equity_sync', coalesce(_setting('bot_equity_sync'), 'off'),
    'tolerance_abs', _wf_setnum('pool_recon_tol_abs', 0.5), 'tolerance_pct', _wf_setnum('pool_recon_tol_pct', 0.0005),
    'updates', coalesce((select jsonb_agg(to_jsonb(u) order by u.id desc) from (select * from pool_updates order by id desc limit 10) u), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(to_jsonb(b) order by b.id desc) from (select * from pool_recon_log order by id desc limit 10) b), '[]'::jsonb));
end $$;

-- "the rest is fees / funding / something else": classifies ONLY what the pending trades do not explain
create or replace function public.admin_classify_pool_difference(p_token text, p_vid bigint, p_kind text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v balance_verifications%rowtype; v_left numeric;
begin
  perform _ledger_lock();
  select * into v from balance_verifications where id = p_vid for update;
  if not found then raise exception 'unknown balance check'; end if;
  if v.status not in ('entered', 'confirmed') then raise exception 'this balance check is % and cannot be explained any more', v.status; end if;
  if v.first_used_at is not null then raise exception 'this balance check was already used: enter a new one'; end if;
  if p_kind not in ('fees', 'funding', 'transfer', 'timing', 'other') then raise exception 'choose what the difference is (fees, funding, transfer, timing, other)'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'write why (at least 10 characters)'; end if;
  v_left := round(_pool_unexplained(p_vid), 6);
  if v_left = 0 then raise exception 'there is no difference left to classify beyond the pending trades'; end if;
  insert into verification_adjustments(verification_id, created_by, kind, amount, note, classified) values (p_vid, v_actor, p_kind, v_left, trim(p_note), true);
  perform _wf_event(v_actor, 'verification', p_vid, 'pool_difference_classified', jsonb_build_object('kind', p_kind, 'amount', v_left, 'note', p_note), null, p_vid);
  return jsonb_build_object('classified', v_left, 'kind', p_kind, 'residual', _wf_residual(p_vid));
end $$;

-- UPDATE POOL. p_event_ids / p_expected_usd are exactly what the screen showed; if the pending set changed since, nothing happens.
-- Returns { ok: true, ... } when applied, { ok: false, blocked: true, ... } when the reconciliation blocks (the block is logged), and raises for everything else.
create or replace function public.admin_update_pool(p_token text, p_vid bigint, p_event_ids text[], p_expected_usd numeric, p_idem text default null,
    p_confirm boolean default false, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token); v_res jsonb; cur jsonb; v_ids text[]; v_in text[]; rd jsonb; v_other text; v balance_verifications%rowtype;
  v_pend numeric; v_res_amt numeric; v_left numeric; v_tol numeric; v_u numeric; v_prev numeric; v_net numeric; v_price numeric; v_eq bigint; v_pu bigint; v_flag text;
  v_count int; v_r numeric; v_miss int; rc jsonb;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_update_pool'); if v_res is not null then return v_res; end if;
  cur := _pool_pending();
  v_ids := array(select jsonb_array_elements_text(cur->'ids'));
  v_in := array(select x from unnest(coalesce(p_event_ids, '{}'::text[])) x order by x);
  if v_in is distinct from v_ids then
    raise exception 'stale screen: the pending trades changed (% pending now, the screen showed %). Reload and review them again.', cur->>'count', coalesce(cardinality(v_in), 0);
  end if;
  v_pend := (cur->>'usd')::numeric; v_count := (cur->>'count')::int; v_r := (cur->>'r')::numeric; v_miss := (cur->>'missing_usd')::int;
  if p_expected_usd is null or abs(p_expected_usd - v_pend) > 0.000001 then
    raise exception 'stale screen: the pending total is % but the screen showed %. Reload and review again.', round(v_pend, 6), p_expected_usd;
  end if;
  if p_vid is null then raise exception 'choose the confirmed balance check to use'; end if;
  rd := _wf_ready(p_vid);
  v_other := (select string_agg(x->>'text', ' ') from jsonb_array_elements(rd->'reasons') x where x->>'code' <> 'unresolved_difference');
  if v_other is not null then raise exception 'blocked: %', v_other; end if;
  select * into v from balance_verifications where id = p_vid;
  if v_count > 0 and cur->>'newest_ms' is not null and to_timestamp((cur->>'newest_ms')::bigint / 1000.0) > v.entered_at then
    raise exception 'a trade closed after this balance check was entered: enter and confirm a new balance check, then Update Pool.';
  end if;
  if _total_units() = 0 then raise exception 'no units yet: the first deposit starts the pool (accept it first)'; end if;

  -- reconciliation 1: the typed Exchange total against the books (pool NAV + waiting money + unsent payouts + pending trades), after what was classified
  v_left := round(_pool_unexplained(p_vid), 6); v_tol := _pool_tol(v.mexc_total); v_res_amt := _wf_residual(p_vid);
  if abs(v_left) > v_tol then
    perform _pool_log('update_pool', 'blocked', jsonb_build_object('verification', p_vid, 'pending_usd', v_pend, 'mismatch', v_left, 'tolerance', v_tol, 'missing_usd', v_miss));
    return jsonb_build_object('ok', false, 'blocked', true, 'reason', 'difference', 'pending_usd', v_pend, 'unexplained', v_left, 'tolerance', v_tol,
      'missing_usd', v_miss, 'text', 'The balance change does not match the pending trades by ' || round(v_left, 2) || ' USDT (tolerance ' || round(v_tol, 2) || '). Classify the difference (fees, funding, transfer) or fix the balance check.');
  end if;
  -- reconciliation 2: the bot's own Exchange reading, when it is newer than everything else
  rc := _pool_recon();
  if (rc->>'blocking')::boolean then
    perform _pool_log('update_pool', rc->>'status', rc);
    return jsonb_build_object('ok', false, 'blocked', true, 'reason', 'reconciliation', 'recon', rc, 'text', 'The bot''s Exchange reading does not match the books. Explain it first.');
  end if;

  -- explain the check's own variance with the pending trades (an adjustment on the balance check), then value the pool at the confirmed balance
  if v_res_amt <> 0 then
    insert into verification_adjustments(verification_id, created_by, kind, amount, note)
    values (p_vid, v_actor, case when abs(v_res_amt - v_pend) <= v_tol then 'trading_pnl' else 'other' end, v_res_amt,
            'Update Pool: ' || v_count || ' closed live trade(s) worth ' || round(v_pend, 2) || ' applied; balance check variance ' || round(v_res_amt, 2));
  end if;
  v_u := _total_units();
  select coalesce(equity_usdt, 0) into v_prev from pool_equity order by id desc limit 1;
  v_flag := _check_move(_net_equity(v.mexc_total), p_confirm);
  v_net := _net_equity(v.mexc_total); v_price := _price_from(v.mexc_total);
  insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by)
  values (_at(null), 'update', v_net, v_u, v_price, _last_php_rate(), nullif('Update Pool' || coalesce(': ' || p_note, '') || v_flag, ''), v_actor) returning id into v_eq;
  insert into pool_updates(equity_id, verification_id, mexc_total, prev_nav, nav_after, actual_change, pending_count, pending_usd, pending_r, missing_usd, difference, tolerance, note, created_by)
  values (v_eq, p_vid, v.mexc_total, v_prev, v_net, v_net - v_prev, v_count, v_pend, v_r, v_miss, v_left, v_tol, p_note, v_actor) returning id into v_pu;
  insert into applied_trades(event_id, pool_update_id, ts_ms, symbol, usd, r)
    select event_id, v_pu, ts_ms, symbol, usd, r from pending_live_exits;
  perform _wf_use(p_vid, false);
  perform _check_books();
  perform _wf_event(v_actor, 'valuation', v_pu, 'pool_updated', jsonb_build_object('pending_trades', v_count, 'pending_usd', v_pend, 'nav_before', v_prev, 'nav_after', v_net,
    'unit_price', v_price, 'difference', v_left), v_eq, p_vid);
  return _idem_put(p_idem, 'admin_update_pool', jsonb_build_object('ok', true, 'pool_update_id', v_pu, 'equity_id', v_eq, 'unit_price', v_price, 'nav_before', v_prev, 'nav_after', v_net,
    'applied_trades', v_count, 'applied_usd', v_pend, 'difference', v_left), v_actor);
end $$;

-- UPDATE POOL AND ACCEPT SELECTED: one transaction. If the update is blocked, nobody is accepted. If any acceptance fails, the update is rolled back too.
create or replace function public.admin_update_pool_and_admit(p_token text, p_vid bigint, p_event_ids text[], p_expected_usd numeric, p_pending_ids bigint[],
    p_idem text default null, p_confirm boolean default false, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); v_res jsonb; u jsonb; a jsonb; v_all jsonb := '[]'::jsonb; d bigint;
begin
  perform _ledger_lock();
  v_res := _idem_get(p_idem, 'admin_update_pool_and_admit'); if v_res is not null then return v_res; end if;
  u := admin_update_pool(p_token, p_vid, p_event_ids, p_expected_usd, null, p_confirm, p_note);
  if not (u->>'ok')::boolean then return u; end if;
  foreach d in array coalesce(p_pending_ids, '{}'::bigint[]) loop
    a := admin_admit_deposit(p_token, d, p_vid, null, p_confirm);
    v_all := v_all || jsonb_build_array(a || jsonb_build_object('pending_id', d));
  end loop;
  return _idem_put(p_idem, 'admin_update_pool_and_admit', u || jsonb_build_object('admitted', v_all), v_actor);
end $$;

-- ---------------------------------------------------------------- 8. backups: the pool tables are accounting records, so the ledger backup carries them
-- bot_events is the bot dashboard's event store, not the ledger's books: it is excluded from the coverage check (the bot can re-push it with dashboard-backfill).
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payout_details', _dump_table('payout_details'),
    'idempotency_keys', _dump_table('idempotency_keys'),
    'holder_state', _dump_table('holder_state'),
    'investor_perf_draft_archive', _dump_table('investor_perf_draft_archive'),
    'perf_log_draft_archive', _dump_table('perf_log_draft_archive'),
    'settlement_exceptions', _dump_table('settlement_exceptions'),
    'contact_details', _dump_table('contact_details'),
    'contact_history', _dump_table('contact_history'),
    'pool_updates', _dump_table('pool_updates'),
    'applied_trades', _dump_table('applied_trades'),
    'applied_trades_log', _dump_table('applied_trades_log'),
    'pool_recon_log', _dump_table('pool_recon_log'))
$$;
revoke all on function public._export_extra() from public, anon, authenticated;

create or replace function public.admin_backup_coverage(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_keys text[]; v_excl text[] := array['sessions', 'backup_keys', 'app_settings', 'backtest_runs', 'bot_events'];
begin
  perform _admin(p_token);
  select array_agg(k) into v_keys from jsonb_object_keys(_export_all()) k;
  return jsonb_build_object(
    'missing', coalesce((select jsonb_agg(t.table_name order by t.table_name) from information_schema.tables t
                          where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> all (v_excl)
                            and coalesce(case t.table_name when 'profiles' then 'people' when 'ledger_settings' then 'settings' end, t.table_name) <> all (v_keys)), '[]'::jsonb),
    'excluded', to_jsonb(v_excl),
    'excluded_why', 'sessions and backup_keys hold secrets; app_settings and backtest_runs belong to the backtester, not the ledger; bot_events is the bot dashboard''s event store (the bot re-sends it with dashboard-backfill)');
end $$;
revoke all on function public.admin_backup_coverage(text) from public;
grant execute on function public.admin_backup_coverage(text) to anon, authenticated;

-- ---------------------------------------------------------------- 7. grants
revoke all on function public._pool_tol(numeric), public._pool_expected_total(), public._pool_unexplained(bigint), public._pool_pending(), public._pool_log(text, text, jsonb), public._pool_recon(), public._pool_guard_pending(),
  public._pool_guard(bigint), public._pool_ledger_guard() from public, anon, authenticated;
revoke all on function public.admin_pending_pnl(text), public.admin_pool_status(text), public.admin_classify_pool_difference(text, bigint, text, text),
  public.admin_update_pool(text, bigint, text[], numeric, text, boolean, text),
  public.admin_update_pool_and_admit(text, bigint, text[], numeric, bigint[], text, boolean, text) from public;
grant execute on function public.admin_pending_pnl(text), public.admin_pool_status(text), public.admin_classify_pool_difference(text, bigint, text, text),
  public.admin_update_pool(text, bigint, text[], numeric, text, boolean, text),
  public.admin_update_pool_and_admit(text, bigint, text[], numeric, bigint[], text, boolean, text) to anon, authenticated;
revoke all on function public.admin_admit_deposit(text, bigint, bigint, text, boolean), public.admin_execute_withdrawal(text, bigint, bigint, boolean, numeric, text, text, boolean),
  public.admin_undo_last(text, text), public.bot_post_equity(text, numeric, text),
  public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean) from public;
grant execute on function public.admin_admit_deposit(text, bigint, bigint, text, boolean), public.admin_execute_withdrawal(text, bigint, bigint, boolean, numeric, text, text, boolean),
  public.admin_undo_last(text, text), public.bot_post_equity(text, numeric, text),
  public.bot_post_snapshot(text, numeric, int, int, numeric, numeric, jsonb, boolean) to anon, authenticated;

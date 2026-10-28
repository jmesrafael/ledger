-- PER-WALLET SNAPSHOTS, COMBINED NAV AND THE PAYOUT CAP. Run after 20261112000000_pool_update.sql and 20261109000000_settlement_controls_backup.sql.
-- NOT applied to any database yet. Safe to run twice. Read docs/wallet-snapshots.md.
--
-- Everything here is OFF until you turn it on (ledger_settings): wallet_nav_mode = 'off' and payout_cap_mode = 'off'. With both off, no existing function behaves differently.
--
--  1  bot_wallets: one row per strategy wallet (bbcore, icore), each with its OWN secret (only the SHA-256 hash is stored, like bot_key_hash). A key is bound to its wallet.
--  2  wallet_snapshots: append-only reports from each bot: wallet equity (incl. unrealized P&L), unrealized, withdrawable balance, available balance, open positions/orders.
--     bot_post_wallet_snapshot checks the key, a strictly increasing sequence number (replay protection), the bot's clock against the ledger's, 6-decimal amounts, and marks
--     a big jump 'suspect' (it blocks use until the manager accepts it with a reason).
--  3  _wallet_nav(): the newest snapshot per active wallet, judged on the LEDGER's clock: missing / stale / suspect / outdated (a payout was sent after it) / skewed (the two
--     reads too far apart). Not ok = NO number is returned (never a zero). Combined equity = sum of wallet equity: it already includes unrealized P&L, so unrealized and
--     realized are stored but never added again, and a transfer between the wallets cancels in the sum.
--  4  wallet_nav_mode = 'require': every valuation (_net_equity) needs fresh, agreeing wallets, and the exchange total typed must equal combined equity (+ money waiting in
--     Spot) within the pool tolerance; money redeemed but not yet sent is taken out of the NAV. The 1112 "pending live P/L" guards and the balance check's "no open positions"
--     rule are skipped (closed trades are already in the wallets' equity; open trades are valued by their unrealized P&L).
--  5  payout_cap_mode = 'require': a payout that leaves the exchange needs usable wallets and must fit  transferable x (1 - buffer%) - buffer USDT - money already redeemed
--     and not sent.  Otherwise it is refused, nothing is saved, and the request stays queued with the investor's units unchanged. No trade is closed.
--  6  admin_wallet_nav, admin_withdrawal_queue (what fits now), admin_split_withdrawal_request (pay part of an approved request now, queue the rest),
--     admin_accept_wallet_snapshot.

do $$
begin
  if to_regprocedure('public._pool_guard_pending()') is null or to_regprocedure('public._pool_guard(bigint)') is null then
    raise exception 'preflight: run 20261112000000_pool_update.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public._settlement_requirements(numeric,timestamptz,jsonb)') is null then
    raise exception 'preflight: run 20261109000000_settlement_controls_backup.sql first. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. settings (all defaults are decisions to confirm)
insert into public.ledger_settings(key, value) values
  ('wallet_nav_mode', 'off'),               -- 'require' = valuations need the wallet snapshots (see 4 above)
  ('payout_cap_mode', 'off'),               -- 'require' = payouts that leave the exchange are capped at the transferable amount
  ('wallet_expected_count', '2'),           -- how many active wallets must report; fewer = not ok (so one bot alone can never value the pool)
  ('wallet_max_age_minutes', '30'),         -- a snapshot older than this (ledger clock) is stale. The bots must report more often than every 4 hours for this to hold
  ('wallet_max_skew_minutes', '10'),        -- the wallets' newest snapshots must have been received within this of each other
  ('wallet_max_clock_drift_minutes', '5'),  -- a snapshot whose own timestamp differs from the ledger clock by more than this is refused
  ('wallet_max_jump_pct', '0.5'),           -- a wallet equity change of more than 50% since its previous snapshot is stored as suspect
  ('payout_buffer_pct', '0.05'),            -- safety buffer: never pay out the last 5% of what MEXC calls withdrawable
  ('payout_buffer_usdt', '5')               -- and never the last 5 USDT
on conflict (key) do nothing;

-- ---------------------------------------------------------------- 2. tables
create table if not exists public.bot_wallets (
  wallet     text primary key check (wallet ~ '^[a-z][a-z0-9_]{1,19}$'),
  label      text not null,
  key_hash   text check (key_hash is null or key_hash ~ '^[0-9a-f]{64}$'),   -- sha256 of the wallet's secret; the secret itself is never stored
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.wallet_snapshots (
  id                bigserial primary key,
  wallet            text not null references public.bot_wallets(wallet),
  seq               bigint not null check (seq > 0),
  reported_at       timestamptz not null,                      -- the bot's clock (checked against the ledger's, never used for staleness)
  received_at       timestamptz not null,                      -- the ledger's clock: this is what staleness is judged on
  equity_usdt       numeric not null check (equity_usdt >= 0), -- MEXC "equity" of this wallet: total equity, unrealized P&L included
  unrealized_usdt   numeric,                                   -- information only: already inside equity, never added
  withdrawable_usdt numeric not null check (withdrawable_usdt >= 0),   -- MEXC "cashBalance" (documented as the withdrawable balance)
  available_usdt    numeric check (available_usdt is null or available_usdt >= 0),   -- MEXC "availableBalance"
  open_positions    int not null check (open_positions >= 0),
  open_orders       int not null check (open_orders >= 0),
  payload_hash      text not null,
  prev_equity_usdt  numeric,
  suspect           boolean not null default false,
  accepted_by       uuid references public.profiles(id),
  accepted_at       timestamptz,
  accept_note       text,
  unique (wallet, seq)
);
create index if not exists wallet_snapshots_wallet_idx on public.wallet_snapshots(wallet, seq desc);
alter table public.bot_wallets enable row level security;
alter table public.wallet_snapshots enable row level security;
revoke all on public.bot_wallets, public.wallet_snapshots from public, anon, authenticated;
revoke all on sequence public.wallet_snapshots_id_seq from public, anon, authenticated;

-- append-only: a snapshot is never deleted, and only the three "accepted" columns can ever change
create or replace function public._wallet_snapshot_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'wallet snapshots are append-only'; end if;
  if (new.id, new.wallet, new.seq, new.reported_at, new.received_at, new.equity_usdt, new.unrealized_usdt, new.withdrawable_usdt, new.available_usdt,
      new.open_positions, new.open_orders, new.payload_hash, new.prev_equity_usdt, new.suspect)
     is distinct from (old.id, old.wallet, old.seq, old.reported_at, old.received_at, old.equity_usdt, old.unrealized_usdt, old.withdrawable_usdt, old.available_usdt,
      old.open_positions, old.open_orders, old.payload_hash, old.prev_equity_usdt, old.suspect) then
    raise exception 'wallet snapshots are append-only (only the acceptance note can be added)';
  end if;
  return new;
end $$;
drop trigger if exists wallet_snapshot_guard on public.wallet_snapshots;
create trigger wallet_snapshot_guard before update or delete on public.wallet_snapshots for each row execute function public._wallet_snapshot_guard();

-- ---------------------------------------------------------------- 3. the bot's report (the only door: a per-wallet secret, a sequence number, validation)
create or replace function public.bot_post_wallet_snapshot(p_key text, p_wallet text, p_seq bigint, p_reported_at timestamptz, p_equity numeric, p_unrealized numeric,
    p_withdrawable numeric, p_available numeric, p_open_positions int, p_open_orders int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  w bot_wallets%rowtype; prev wallet_snapshots%rowtype; v_now timestamptz := _clock(); v_hash text; v_susp boolean := false; v_id bigint;
  v_drift numeric := _wf_setnum('wallet_max_clock_drift_minutes', 5); v_jump numeric := _wf_setnum('wallet_max_jump_pct', 0.5);
begin
  -- the same pattern as bot_post_snapshot, but the key belongs to ONE wallet: an unknown wallet, an inactive wallet and a wrong key all give the same answer
  select * into w from bot_wallets where wallet = p_wallet and active;
  if not found or w.key_hash is null or encode(digest(coalesce(p_key, ''), 'sha256'), 'hex') <> w.key_hash then raise exception 'not allowed'; end if;
  perform pg_advisory_xact_lock(hashtext('wallet_snapshot:' || p_wallet));       -- this wallet's reports are handled one at a time; they never wait for the money lock
  if p_seq is null or p_seq <= 0 then raise exception 'the snapshot needs a sequence number (a number that only goes up)'; end if;
  if p_reported_at is null or abs(extract(epoch from p_reported_at - v_now)) > v_drift * 60 then
    raise exception 'the bot''s clock (%) differs from the ledger''s (%) by more than % minutes: fix the bot''s clock. Nothing was saved.', p_reported_at, v_now, v_drift;
  end if;
  if p_equity is null or p_equity < 0 or p_withdrawable is null or p_withdrawable < 0 then raise exception 'equity and withdrawable balance are required and cannot be negative'; end if;
  if p_open_positions is null or p_open_positions < 0 or p_open_orders is null or p_open_orders < 0 then raise exception 'open positions and orders must be real counts (an unknown count is not sent as zero)'; end if;
  if p_available is not null and p_available < 0 then raise exception 'available balance cannot be negative'; end if;
  if round(p_equity, 6) <> p_equity or round(p_withdrawable, 6) <> p_withdrawable or (p_unrealized is not null and round(p_unrealized, 6) <> p_unrealized)
     or (p_available is not null and round(p_available, 6) <> p_available) then
    raise exception 'amounts may have at most 6 decimals (the ledger never rounds a reported amount silently)';
  end if;
  v_hash := encode(digest(concat_ws('|', p_wallet, p_seq, p_reported_at, p_equity, coalesce(p_unrealized::text, '-'), p_withdrawable, coalesce(p_available::text, '-'), p_open_positions, p_open_orders), 'sha256'), 'hex');
  select * into prev from wallet_snapshots where wallet = p_wallet order by seq desc limit 1;
  if found then
    if p_seq = prev.seq then
      if v_hash = prev.payload_hash then return jsonb_build_object('ok', true, 'replayed', true, 'snapshot_id', prev.id); end if;   -- a retry of the same report
      raise exception 'sequence % was already used with different data: replay refused', p_seq;
    end if;
    if p_seq < prev.seq then raise exception 'sequence % is older than the last accepted one (%): replay refused', p_seq, prev.seq; end if;
    v_susp := abs(p_equity - prev.equity_usdt) > v_jump * greatest(prev.equity_usdt, 1);
  end if;
  insert into wallet_snapshots(wallet, seq, reported_at, received_at, equity_usdt, unrealized_usdt, withdrawable_usdt, available_usdt, open_positions, open_orders, payload_hash, prev_equity_usdt, suspect)
  values (p_wallet, p_seq, p_reported_at, v_now, p_equity, p_unrealized, p_withdrawable, p_available, p_open_positions, p_open_orders, v_hash, prev.equity_usdt, v_susp) returning id into v_id;
  return jsonb_build_object('ok', true, 'snapshot_id', v_id, 'suspect', v_susp, 'received_at', v_now);
end $$;

-- ---------------------------------------------------------------- 4. the combined view
create or replace function public._wallet_mode() returns text language sql stable security definer set search_path = public as $$
  select case when _setting('wallet_nav_mode') = 'require' then 'require' else 'off' end
$$;
-- money redeemed but not yet sent out of the exchange: still inside the wallets, no longer the pool's (same definition as 1112's reconciliation)
create or replace function public._outbound_unsent() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_usdt), 0) from payout_records where leaves_mexc and status in ('awaiting', 'failed')
$$;

create or replace function public._wallet_nav() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_now timestamptz := _clock(); v_exp int := _wf_setnum('wallet_expected_count', 2)::int; v_age numeric := _wf_setnum('wallet_max_age_minutes', 30) * 60;
  v_skew numeric := _wf_setnum('wallet_max_skew_minutes', 10) * 60; r record; s wallet_snapshots%rowtype; v_wallets jsonb := '[]'::jsonb; v_reasons jsonb := '[]'::jsonb;
  v_active int := 0; v_ok int := 0; v_eq numeric := 0; v_unr numeric := 0; v_wd numeric := 0; v_tr numeric := 0; v_pos int := 0; v_ord int := 0;
  v_min timestamptz; v_max timestamptz; v_sent timestamptz; v_status text; v_all boolean;
begin
  select max(sent_at) into v_sent from payout_records where leaves_mexc and sent_at is not null;
  for r in select * from bot_wallets where active order by wallet loop
    v_active := v_active + 1;
    select * into s from wallet_snapshots where wallet = r.wallet order by seq desc limit 1;
    if not found then v_status := 'missing';
    elsif extract(epoch from v_now - s.received_at) > v_age then v_status := 'stale';
    elsif s.suspect and s.accepted_at is null then v_status := 'suspect';
    elsif v_sent is not null and s.received_at < v_sent then v_status := 'outdated';   -- money left the exchange after this snapshot: it still shows that money
    else v_status := 'ok'; end if;
    v_wallets := v_wallets || jsonb_build_object('wallet', r.wallet, 'label', r.label, 'status', v_status, 'snapshot_id', s.id, 'received_at', s.received_at,
      'age_seconds', case when s.id is null then null else round(extract(epoch from v_now - s.received_at)) end,
      'equity_usdt', s.equity_usdt, 'unrealized_usdt', s.unrealized_usdt, 'withdrawable_usdt', s.withdrawable_usdt, 'available_usdt', s.available_usdt,
      'transferable_usdt', case when s.id is null then null else least(s.equity_usdt, s.withdrawable_usdt, coalesce(s.available_usdt, s.withdrawable_usdt)) end,
      'open_positions', s.open_positions, 'open_orders', s.open_orders, 'suspect', coalesce(s.suspect and s.accepted_at is null, false));
    if v_status = 'ok' then
      v_ok := v_ok + 1; v_eq := v_eq + s.equity_usdt; v_unr := v_unr + coalesce(s.unrealized_usdt, 0); v_wd := v_wd + s.withdrawable_usdt;
      v_tr := v_tr + least(s.equity_usdt, s.withdrawable_usdt, coalesce(s.available_usdt, s.withdrawable_usdt)); v_pos := v_pos + s.open_positions; v_ord := v_ord + s.open_orders;
      v_min := least(coalesce(v_min, s.received_at), s.received_at); v_max := greatest(coalesce(v_max, s.received_at), s.received_at);
    else
      v_reasons := v_reasons || jsonb_build_object('wallet', r.wallet, 'code', v_status, 'text', case v_status
        when 'missing' then format('wallet %s has never reported', r.wallet)
        when 'stale' then format('wallet %s last reported %s minutes ago (limit %s)', r.wallet, round(extract(epoch from v_now - s.received_at) / 60), round(v_age / 60))
        when 'suspect' then format('wallet %s equity jumped from %s to %s: accept the snapshot with a written reason (or wait for the next one)', r.wallet, s.prev_equity_usdt, s.equity_usdt)
        else format('a payout was sent from the exchange after wallet %s last reported: wait for its next snapshot', r.wallet) end);
    end if;
  end loop;
  if v_active < v_exp then v_reasons := v_reasons || jsonb_build_object('wallet', null, 'code', 'wallet_count', 'text', format('only %s of the %s expected wallets are registered and active', v_active, v_exp)); end if;
  if v_ok = v_active and v_active >= 2 and (extract(epoch from v_max - v_min)) > v_skew then
    v_reasons := v_reasons || jsonb_build_object('wallet', null, 'code', 'skewed', 'text', format('the wallets reported %s minutes apart (limit %s): a transfer between them could be counted twice or missed',
      round(extract(epoch from v_max - v_min) / 60), round(v_skew / 60)));
  end if;
  v_all := jsonb_array_length(v_reasons) = 0 and v_active >= v_exp and v_active > 0;
  return jsonb_build_object('ok', v_all, 'reasons', v_reasons, 'wallets', v_wallets, 'as_of', v_now,
    'combined_equity_usdt', case when v_all then v_eq end, 'combined_unrealized_usdt', case when v_all then v_unr end,
    'combined_withdrawable_usdt', case when v_all then v_wd end, 'transferable_total_usdt', case when v_all then v_tr end,
    'open_positions', case when v_all then v_pos end, 'open_orders', case when v_all then v_ord end);
end $$;

-- the exchange total the ledger should be given, from the wallets: combined equity (+ money waiting in Spot when it waits there, not in the wallets)
create or replace function public._wallet_expected_total(n jsonb) returns numeric language sql stable security definer set search_path = public as $$
  select (n->>'combined_equity_usdt')::numeric + case when coalesce(_setting('queued_money_location'), 'spot') = 'spot' then _pending_total() else 0 end
$$;

create or replace function public._wallet_assert_total(p_equity numeric) returns void language plpgsql stable security definer set search_path = public as $$
declare n jsonb := _wallet_nav(); v_exp numeric;
begin
  if not (n->>'ok')::boolean then
    raise exception 'WALLETS NOT READY: % Nothing was saved.', (select string_agg(x->>'text', '; ') from jsonb_array_elements(n->'reasons') x);
  end if;
  v_exp := _wallet_expected_total(n);
  if abs(p_equity - v_exp) > _pool_tol(p_equity) then
    raise exception 'WALLET MISMATCH: the exchange total (%) does not match the two wallets (% combined equity%): check the total, or wait for fresh snapshots. Nothing was saved.',
      p_equity, round((n->>'combined_equity_usdt')::numeric, 6), case when v_exp <> (n->>'combined_equity_usdt')::numeric then format(' + % waiting in Spot', round(_pending_total(), 6)) else '' end;
  end if;
end $$;

-- every valuation goes through here (post equity, settlement, withdrawal, quote, preview). Unchanged unless wallet_nav_mode = 'require'.
create or replace function public._net_equity(p_equity numeric) returns numeric language plpgsql stable security definer set search_path = public as $$
declare v numeric;
begin
  if p_equity is null or p_equity <= 0 then raise exception 'enter the current pool equity in USDT (must be > 0)'; end if;
  if _wallet_mode() = 'require' then
    perform _wallet_assert_total(p_equity);
    v := p_equity - _pending_total() - _outbound_unsent();      -- redeemed-but-not-sent money is still in the wallets but already left the pool
  else
    v := p_equity - _pending_total();
  end if;
  if v <= 0 then raise exception 'equity (%) must be more than the deposits still waiting (%): enter the full Exchange total', p_equity, _pending_total(); end if;
  return v;
end $$;

-- 1112's guards: in wallet mode closed trades are already inside the wallets' equity and open trades are valued by their unrealized P&L, so "unapplied live trades" and the
-- single-snapshot reconciliation do not apply; the wallet checks above (inside every valuation) replace them. Otherwise unchanged (1112's bodies).
create or replace function public._pool_guard_pending() returns void language plpgsql stable security definer set search_path = public as $$
declare p jsonb;
begin
  if _wallet_mode() = 'require' then return; end if;
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
  if _wallet_mode() = 'require' then return; end if;
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

-- the balance check's readiness: open positions no longer block capital in wallet mode (the unrealized P&L is in the wallets' equity). Every other reason stays.
do $$
begin
  if to_regprocedure('public._wf_ready_core(bigint)') is null then
    alter function public._wf_ready(bigint) rename to _wf_ready_core;
  end if;
end $$;
revoke all on function public._wf_ready_core(bigint) from public, anon, authenticated;
create or replace function public._wf_ready(p_vid bigint) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb := _wf_ready_core(p_vid); v_keep jsonb;
begin
  if _wallet_mode() <> 'require' then return r; end if;
  v_keep := coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(r->'reasons', '[]'::jsonb)) x where x->>'code' <> 'open_positions'), '[]'::jsonb);
  return (r - 'reasons' - 'ok') || jsonb_build_object('ok', jsonb_array_length(v_keep) = 0, 'reasons', v_keep,
    'open_positions_allowed', jsonb_array_length(coalesce(r->'reasons', '[]'::jsonb)) > jsonb_array_length(v_keep));
end $$;

-- ---------------------------------------------------------------- 5. the payout cap
create or replace function public._payout_capacity() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n jsonb := _wallet_nav(); v_tr numeric; v_pct numeric := _wf_setnum('payout_buffer_pct', 0.05); v_abs numeric := _wf_setnum('payout_buffer_usdt', 5); v_unsent numeric := _outbound_unsent(); v_pay numeric;
begin
  if not (n->>'ok')::boolean then return jsonb_build_object('ok', false, 'reasons', n->'reasons', 'wallets', n->'wallets', 'payable_now_usdt', null); end if;
  v_tr := (n->>'transferable_total_usdt')::numeric;
  v_pay := floor(greatest(0, v_tr * (1 - v_pct) - v_abs - v_unsent) * 1000000) / 1000000;      -- rounded DOWN: never promise more than is there
  return jsonb_build_object('ok', true, 'reasons', '[]'::jsonb, 'transferable_total_usdt', v_tr, 'buffer_pct', v_pct, 'buffer_usdt', v_abs, 'outbound_unsent_usdt', v_unsent,
    'payable_now_usdt', v_pay, 'wallets', n->'wallets', 'as_of', n->'as_of');
end $$;

create or replace function public._payout_guard(p_pay numeric) returns void language plpgsql stable security definer set search_path = public as $$
declare c jsonb;
begin
  if coalesce(_setting('payout_cap_mode'), 'off') <> 'require' then return; end if;
  c := _payout_capacity();
  if not (c->>'ok')::boolean then
    raise exception 'PAYOUT BLOCKED: the wallet snapshots are not usable (%). Nothing was paid or saved; the request stays queued and the investor keeps their units.',
      (select string_agg(x->>'text', '; ') from jsonb_array_elements(c->'reasons') x);
  end if;
  if p_pay is null or p_pay > (c->>'payable_now_usdt')::numeric + 0.0000005 then
    raise exception 'PAYOUT QUEUED: this payout is % USDT but only % USDT can leave the exchange now (transferable % less the buffer of % %% and % USDT, less % USDT already redeemed and not yet sent). Nothing was saved; the request stays queued and the investor keeps their units. No trade is closed.',
      p_pay, c->>'payable_now_usdt', c->>'transferable_total_usdt', round((c->>'buffer_pct')::numeric * 100, 4), c->>'buffer_usdt', c->>'outbound_unsent_usdt';
  end if;
end $$;

-- admin_withdraw keeps its name, signature and grants; the real work is the old function (renamed), and the cap is checked on its result inside the same transaction:
-- a refusal rolls the withdrawal back completely. A replay (same request id) already paid once and is not checked again. Paying from the manager's own money
-- (admin_withdraw_to_manager) moves nothing out of the exchange, so it is not capped.
do $$
begin
  if to_regprocedure('public._admin_withdraw_core(text,uuid,numeric,numeric,numeric,text,boolean,bigint,timestamptz,text,boolean)') is null then
    alter function public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) rename to _admin_withdraw_core;
  end if;
end $$;
revoke all on function public._admin_withdraw_core(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) from public, anon, authenticated;
create or replace function public.admin_withdraw(p_token text, p_profile uuid, p_units numeric, p_equity_before numeric,
    p_php_rate numeric default null, p_note text default null, p_force boolean default false, p_request_id bigint default null,
    p_at timestamptz default null, p_idem text default null, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  v := _admin_withdraw_core(p_token, p_profile, p_units, p_equity_before, p_php_rate, p_note, p_force, p_request_id, p_at, p_idem, p_confirm);
  if coalesce(v->>'replayed', 'false') <> 'true' then perform _payout_guard((v->>'pay_usdt')::numeric); end if;
  return v;
end $$;

-- ---------------------------------------------------------------- 6. what the manager sees and does
create or replace function public.admin_wallet_nav(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return _wallet_nav() || jsonb_build_object('modes', jsonb_build_object('wallet_nav_mode', _wallet_mode(), 'payout_cap_mode', coalesce(_setting('payout_cap_mode'), 'off')),
    'payout', _payout_capacity(), 'nav_implied_usdt', case when (_wallet_nav()->>'ok')::boolean then (_wallet_nav()->>'combined_equity_usdt')::numeric - _outbound_unsent()
        - case when coalesce(_setting('queued_money_location'), 'spot') = 'futures' then _pending_total() else 0 end end,
    'outbound_unsent_usdt', _outbound_unsent(), 'queued_money_usdt', _pending_total(), 'queued_location', coalesce(_setting('queued_money_location'), 'spot'));
end $$;

-- approved requests waiting to be redeemed, oldest first, and which of them fit in what can leave the exchange now. Amounts are ESTIMATES (units x current price, before
-- fees, so an upper bound); the real figure is whatever admin_quote_withdrawal says at redemption. Units stay with the investor until then: the queue is not a new liability.
create or replace function public.admin_withdrawal_queue(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c jsonb := _payout_capacity(); v_left numeric; v_price numeric := _price_now(); r record; v_rows jsonb := '[]'::jsonb; v_est numeric; v_fits boolean; v_tot numeric := 0;
begin
  perform _admin(p_token);
  v_left := case when (c->>'ok')::boolean then (c->>'payable_now_usdt')::numeric end;
  for r in select q.id, q.profile_id, p.name, q.units, q.requested_at, q.pay_by from withdrawal_requests q join profiles p on p.id = q.profile_id
            where q.status = 'pending' and q.stage = 'approved' order by q.requested_at, q.id loop
    v_est := floor(least(r.units, _units_of(r.profile_id)) * v_price * 1000000) / 1000000; v_tot := v_tot + v_est;
    v_fits := v_left is not null and v_est <= v_left;
    if v_fits then v_left := v_left - v_est; end if;
    v_rows := v_rows || jsonb_build_object('request_id', r.id, 'profile_id', r.profile_id, 'name', r.name, 'units', r.units, 'estimated_payout_usdt', v_est,
      'fits_now', v_fits, 'max_units_now', case when v_left is null or v_price <= 0 then null else floor(least(r.units, v_left / v_price) * 100000000) / 100000000 end,
      'requested_at', r.requested_at, 'pay_by', r.pay_by);
  end loop;
  return jsonb_build_object('capacity', c, 'requests', v_rows, 'estimated_total_usdt', v_tot, 'unit_price', v_price,
    'estimate_note', 'Estimates before fees (units x current price). The real payout is quoted at redemption. Units stay with the investor until a request is redeemed.');
end $$;

-- pay part of an approved request now and queue the rest: the request is split in two (same person, same approval and lock-up exception). Units are conserved exactly.
create or replace function public.admin_split_withdrawal_request(p_token text, p_request bigint, p_units numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); r withdrawal_requests%rowtype; v_new bigint;
begin
  perform _ledger_lock();
  select * into r from withdrawal_requests where id = p_request for update;
  if not found then raise exception 'unknown withdrawal request'; end if;
  if r.status <> 'pending' or r.stage <> 'approved' then raise exception 'only an approved request that is still waiting can be split (this one is %)', r.stage; end if;
  if p_units is null or p_units <= 0 or p_units >= r.units then raise exception 'the part to pay now must be more than 0 and less than the whole request (%)', r.units; end if;
  if round(p_units, 8) <> p_units then raise exception 'units have at most 8 decimals'; end if;
  insert into withdrawal_requests(profile_id, units, note, requested_at, pay_by, status, stage, approved_by, approved_at, approval_note, lock_exception, lock_exception_reason, lock_exception_by, lock_exception_at)
  values (r.profile_id, p_units, coalesce(p_note, r.note), r.requested_at, r.pay_by, r.status, r.stage, r.approved_by, r.approved_at, r.approval_note,
          r.lock_exception, r.lock_exception_reason, r.lock_exception_by, r.lock_exception_at) returning id into v_new;
  update withdrawal_requests set units = r.units - p_units where id = p_request;
  perform _wf_event(v_actor, 'withdrawal', p_request, 'request_split', jsonb_build_object('original_units', r.units, 'part_now_units', p_units, 'part_now_request', v_new,
    'queued_units', r.units - p_units, 'note', p_note), null, null, r.profile_id);
  return jsonb_build_object('pay_now_request', v_new, 'pay_now_units', p_units, 'queued_request', p_request, 'queued_units', r.units - p_units);
end $$;

create or replace function public.admin_accept_wallet_snapshot(p_token text, p_snapshot bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := _admin(p_token); s wallet_snapshots%rowtype;
begin
  perform _ledger_lock();
  select * into s from wallet_snapshots where id = p_snapshot for update;
  if not found then raise exception 'unknown wallet snapshot'; end if;
  if not s.suspect then raise exception 'this snapshot is not marked suspect'; end if;
  if s.accepted_at is not null then raise exception 'this snapshot was already accepted'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'write why this jump is real (at least 10 characters): for example a deposit or a transfer between the wallets'; end if;
  update wallet_snapshots set accepted_by = v_actor, accepted_at = now(), accept_note = trim(p_note) where id = p_snapshot;
  perform _audit(v_actor, 'wallet_snapshot_accepted', null, jsonb_build_object('snapshot_id', p_snapshot, 'wallet', s.wallet, 'equity_usdt', s.equity_usdt, 'prev_equity_usdt', s.prev_equity_usdt, 'note', trim(p_note)));
  return jsonb_build_object('snapshot_id', p_snapshot, 'accepted', true);
end $$;

-- ---------------------------------------------------------------- 7. backups include the wallet tables (never the secret hashes)
-- A WRAPPER, not a copy: the existing _export_extra (the newest one, 1112's) keeps producing every key it produces today, and the two wallet tables are added to it.
-- (An earlier draft of this file redefined the function with its own list and silently dropped the tables 1110 and 1112 had added; tests/wallet-snapshots.test.mjs WS10 caught it.)
do $$
begin
  if to_regprocedure('public._export_extra_core()') is null then
    alter function public._export_extra() rename to _export_extra_core;
  end if;
end $$;
revoke all on function public._export_extra_core() from public, anon, authenticated;
create or replace function public._export_extra() returns jsonb language sql stable security definer set search_path = public as $$
  select _export_extra_core() || jsonb_build_object(
    'bot_wallets', (select coalesce(jsonb_agg(to_jsonb(b) - 'key_hash' order by b.wallet), '[]'::jsonb) from bot_wallets b),
    'wallet_snapshots', _dump_table('wallet_snapshots'))
$$;

-- ---------------------------------------------------------------- access
revoke all on function public._wallet_snapshot_guard(), public._wallet_mode(), public._outbound_unsent(), public._wallet_nav(), public._wallet_expected_total(jsonb),
  public._wallet_assert_total(numeric), public._net_equity(numeric), public._pool_guard_pending(), public._pool_guard(bigint), public._wf_ready(bigint),
  public._payout_capacity(), public._payout_guard(numeric), public._export_extra() from public, anon, authenticated;
revoke all on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int), public.admin_wallet_nav(text),
  public.admin_withdrawal_queue(text), public.admin_split_withdrawal_request(text, bigint, numeric, text), public.admin_accept_wallet_snapshot(text, bigint, text),
  public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) from public;
grant execute on function public.bot_post_wallet_snapshot(text, text, bigint, timestamptz, numeric, numeric, numeric, numeric, int, int), public.admin_wallet_nav(text),
  public.admin_withdrawal_queue(text), public.admin_split_withdrawal_request(text, bigint, numeric, text), public.admin_accept_wallet_snapshot(text, bigint, text),
  public.admin_withdraw(text, uuid, numeric, numeric, numeric, text, boolean, bigint, timestamptz, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';

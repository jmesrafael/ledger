-- One-off (Nov 13, 2026): fill nav_snapshots from the MEXC wallet reports kept since Oct 28, 2026, so every holder's equity curve moves with the real account
-- (like the Total Fund chart) instead of jumping only at booked entries. It only ADDS nav_snapshots rows (source 'backfill', plus one 'flow' row per flow
-- checkpoint); it never touches ledger, pool_equity, units, marks or fees. A holder's value at a point = their units then × that point's price.
--
-- Why not simply public._nav_backfill(): for this history it needs three facts it does not know, which would skip almost every moment:
--   1. Raf's Oct 28 deposit (pending #2, 200 USDT) has no admitted_at (recorded before that column existed): it joined at its ledger time 2026-10-28 14:33:07.
--   2. T-CORE first reported on 2026-11-07 03:31:06 and held no pool money before: until then BB-Core + I-Core are the complete set.
--   3. Two book corrections applied on Nov 7 fix errors that existed earlier: #1 (−4.9258, the SOL short closed 2026-11-04 14:48:03 that was never added) and
--      #2 (+0.8582, the Oct 28 14:33 valuation that counted open trades twice). As of a moment after each error began, the corrected book is the true one.
-- Every other check is _nav_backfill's: each wallet's newest report at most 30 minutes old, the wallets within 10 minutes of each other, no unaccepted suspect
-- report, exchange (− money waiting) within max(0.50 USDT, 0.05%) of book + open P&L. A moment that fails is skipped, never guessed.
-- Safe to run twice: nothing is written at or after the first existing NAV row, and a moment that already has a row is skipped.

do $fill$
declare
  v_first timestamptz := (select min(ts) from public.nav_snapshots where source <> 'backfill');
  v_t timestamptz := timestamptz '2026-10-28 10:45:00+00'; v_step interval := interval '15 minutes';
  e public.pool_equity%rowtype; s record; v_ok boolean; v_eq numeric; v_unr numeric; v_wd numeric; v_min timestamptz; v_max timestamptz; v_ids jsonb; v_n int;
  v_book numeric; v_pend numeric; v_V numeric; v_gap numeric; v_tol numeric; v_written int := 0; v_skip jsonb := '{}'::jsonb; v_code text; f record;
begin
  perform public._ledger_lock();
  while v_t < v_first loop
    v_code := null;
    if exists (select 1 from public.nav_snapshots where ts = v_t) then v_code := 'exists'; end if;
    select * into e from public.pool_equity where ts <= v_t order by ts desc, id desc limit 1;
    if v_code is null and (e.id is null or e.total_units <= 0) then v_code := 'no_pool'; end if;
    if v_code is null then
      v_ok := true; v_eq := 0; v_unr := 0; v_wd := 0; v_min := null; v_max := null; v_ids := '{}'::jsonb; v_n := 0;
      for s in select w.wallet, (select ws from public.wallet_snapshots ws where ws.wallet = w.wallet and ws.received_at <= v_t order by ws.seq desc limit 1) as ws
                 from public.bot_wallets w where w.active
                  and exists (select 1 from public.wallet_snapshots x where x.wallet = w.wallet and x.received_at <= v_t) loop   -- a wallet counts from its first report
        if (s.ws).id is null or v_t - (s.ws).received_at > interval '30 minutes' or ((s.ws).suspect and (s.ws).accepted_at is null) then v_ok := false; end if;
        v_eq := v_eq + coalesce((s.ws).equity_usdt, 0); v_unr := v_unr + coalesce((s.ws).unrealized_usdt, 0); v_wd := v_wd + coalesce((s.ws).withdrawable_usdt, 0);
        v_min := least(coalesce(v_min, (s.ws).received_at), (s.ws).received_at); v_max := greatest(coalesce(v_max, (s.ws).received_at), (s.ws).received_at);
        v_ids := v_ids || jsonb_build_object(s.wallet, (s.ws).id); v_n := v_n + 1;
      end loop;
      if not v_ok or v_n < 2 or v_max - v_min > interval '10 minutes' then v_code := 'wallets'; end if;
    end if;
    if v_code is null then
      -- the book as it should have stood then: the entry in force + the later corrections whose error had already begun
      v_book := e.equity_usdt + coalesce((select sum(c.amount_usdt) from public.book_corrections c
                   join (values (1, timestamptz '2026-11-04 14:48:03+00'), (2, timestamptz '2026-10-28 14:33:07.33551+00')) as k(id, since) on k.id = c.id
                  where c.status = 'applied' and c.equity_id > e.id and k.since <= v_t), 0);
      select coalesce(sum(d.usdt), 0) into v_pend from public.pending_deposits d
       where d.arrived_at is not null and d.arrived_at <= v_t and d.status <> 'cancelled'
         and coalesce(d.admitted_at, (select l.ts from public.ledger l where l.id = d.ledger_id), 'infinity') > v_t;
      v_V := v_eq - v_pend;
      v_gap := v_V - (v_book + v_unr);
      v_tol := greatest(0.5, abs(v_V) * 0.0005);
      if abs(v_gap) > v_tol then v_code := 'gap';
      else
        insert into public.nav_snapshots(ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool,
            redeemed_not_sent, gap, tolerance, withdrawable, wallets)
        values (v_t, 'backfill', 'verified', v_max, e.id, e.total_units, v_V / e.total_units, v_V, v_book, v_unr, v_eq, v_pend, 0, v_gap, v_tol, v_wd, v_ids);
        v_written := v_written + 1;
      end if;
    end if;
    if v_code is not null then v_skip := v_skip || jsonb_build_object(v_code, coalesce((v_skip->>v_code)::int, 0) + 1); end if;
    v_t := v_t + v_step;
  end loop;
  -- a point at every flow made before the live start, at the price it used (exact time-weighted returns)
  for f in select * from public.flow_checkpoints c where c.created_at < v_first and not exists (select 1 from public.nav_snapshots n where n.checkpoint_id = c.id) order by id loop
    insert into public.nav_snapshots(ts, source, status, measured_at, equity_id, units, unit_price, true_value, book_usdt, open_pnl, combined_equity, not_in_pool, redeemed_not_sent,
        gap, tolerance, wallets, checkpoint_id)
    select f.created_at, 'flow', 'verified', f.measured_at, p.id, p.total_units, f.unit_price, f.unit_price * p.total_units, p.equity_usdt, f.open_pnl, f.combined_equity,
        f.not_in_pool, f.redeemed_not_sent, f.gap, f.tolerance, (select coalesce(jsonb_object_agg(w->>'wallet', w->'snapshot_id'), '{}'::jsonb) from jsonb_array_elements(f.wallets) w), f.id
      from public.pool_equity p where p.id = coalesce(f.book_equity_id, f.equity_id);
    v_written := v_written + 1;
  end loop;
  raise notice 'backfill: % rows written, skipped %', v_written, v_skip;
end $fill$;

-- curves: one point every 15 minutes (live readings come every 5)
update public.ledger_settings set value = '15' where key = 'nav_history_bucket_minutes';

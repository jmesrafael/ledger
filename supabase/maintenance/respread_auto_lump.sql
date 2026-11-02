-- ONE-TIME maintenance (not a migration): replace the automatic LUMP pool entry by one entry per closed trade, each dated at its close time.
--
-- Why it is allowed here: the lump entry was booked by the automatic valuation (created_by null, note 'Auto (...): N closed trade(s), realized ...'), it is the LATEST pool entry,
-- no investor money moved after it (nothing in `ledger` points at it), and only auto_pool_runs / closed_trades refer to it. The new entries end at exactly the same pool value
-- and the same units, so no balance changes; only the dates of the steps do.
--
-- It is the only place that switches the append-only guard off, inside ONE transaction (this DO block): any failed check or a final value that differs raises an exception and
-- NOTHING is changed (the guard stays on). Safe to run twice: the second run finds no lump entry and stops.
-- Needs 20261205000000_auto_pool_trades_dated.sql applied first. Run it in the Supabase SQL editor (as the table owner).

do $$
declare
  lump pool_equity%rowtype; n bigint; fk record; r jsonb; v_units numeric;
begin
  perform _ledger_lock();
  select * into lump from pool_equity order by id desc limit 1;
  if lump.id is null or lump.kind <> 'update' or lump.created_by is not null or lump.reversed_of is not null
     or coalesce(lump.note, '') !~ '^Auto \([a-z_]+\): [0-9]+ closed trade\(s\), realized' then
    raise exception 'STOP: the latest pool entry is not an automatic lump entry. Nothing was changed.';
  end if;
  if exists (select 1 from pool_equity where reversed_of = lump.id) then raise exception 'STOP: the lump entry was already reversed. Nothing was changed.'; end if;
  select count(*) into n from auto_pool_runs where equity_id = lump.id;
  if n <> 1 then raise exception 'STOP: expected exactly one auto run for the lump entry, found %. Nothing was changed.', n; end if;
  select count(*) into n from closed_trades where equity_id = lump.id;
  if n < 2 then raise exception 'STOP: the lump entry holds % trade(s): nothing to spread. Nothing was changed.', n; end if;
  -- nothing else may point at the entry (investor rows, payouts, updates...): look at every foreign key to pool_equity
  for fk in select k.conrelid::regclass::text as t, a.attname::text as c
              from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
             where k.contype = 'f' and k.confrelid = 'public.pool_equity'::regclass
               and k.conrelid not in ('public.auto_pool_runs'::regclass, 'public.closed_trades'::regclass, 'public.pool_equity'::regclass) loop
    execute format('select count(*) from %s where %I = $1', fk.t, fk.c) into n using lump.id;
    if n > 0 then raise exception 'STOP: % row(s) in % refer to the lump entry. Nothing was changed.', n, fk.t; end if;
  end loop;
  v_units := lump.total_units;

  alter table public.pool_equity disable trigger equity_append_only;
  alter table public.closed_trades disable trigger closed_trade_guard;
  update closed_trades set equity_id = null, reflected_at = null where equity_id = lump.id;
  delete from auto_pool_runs where equity_id = lump.id;
  delete from pool_equity where id = lump.id;
  alter table public.pool_equity enable trigger equity_append_only;
  alter table public.closed_trades enable trigger closed_trade_guard;

  r := _auto_pool_value_trades('respread');
  if not coalesce((r->>'ok')::boolean, false) then raise exception 'ABORT: re-booking failed (%): everything is rolled back.', r::text; end if;
  if abs((r->>'nav_after')::numeric - lump.equity_usdt) > 0.000001 then raise exception 'ABORT: final value % differs from the lump value %: everything is rolled back.', r->>'nav_after', lump.equity_usdt; end if;
  if (select total_units from pool_equity order by id desc limit 1) <> v_units then raise exception 'ABORT: units changed: everything is rolled back.'; end if;
  if (select count(*) from closed_trades where equity_id is null) <> 0 then raise exception 'ABORT: a trade is left unbooked: everything is rolled back.'; end if;
  raise notice 'DONE: % trades re-booked, one entry each, final pool value % (was %).', r->>'trades', r->>'nav_after', lump.equity_usdt;
end $$;

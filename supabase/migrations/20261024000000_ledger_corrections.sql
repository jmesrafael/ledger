-- Lets the manager fix a typo in the most recent entry (equity reading, deposit, or withdrawal) without
-- breaking the append-only guarantee: nothing is ever updated or deleted, a correction is appended instead.
-- Only the single most recent pool_equity row can be corrected -- once something new is recorded on top
-- of it, it is locked in for good (every later unit price depends on everything before it, and a holder's
-- high-water mark is updated incrementally, not recomputed from history, so undoing anything but the very
-- last entry would leave that number wrong). A quarter close is final by design and is never undoable here.
-- Run after 20261023000000_hide_pool_from_investors.sql. Safe to run on live data.

alter table public.ledger      add column reversed_of bigint references public.ledger(id);
alter table public.pool_equity add column reversed_of bigint references public.pool_equity(id);

create or replace function public.admin_ledger(p_token text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'ts', l.ts, 'profile_id', l.profile_id, 'name', p.name, 'kind', l.kind,
           'units', l.units, 'usdt', l.usdt, 'unit_price', l.unit_price, 'php_rate', l.php_rate, 'php_amount', l.php_amount,
           'lock_until', l.lock_until, 'note', l.note, 'equity_id', l.equity_id, 'reversed_of', l.reversed_of)
           order by l.id desc) from ledger l join profiles p on p.id = l.profile_id), '[]'::jsonb);
end $$;

create function public.admin_undo_last(p_token text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := _admin(p_token);
  v_last  pool_equity%rowtype;
  v_prev  pool_equity%rowtype;
  v_note  text := coalesce(p_note, 'correction');
  v_new_eq bigint;
  r record;
  v_profile uuid;
  v_old numeric; v_hwm numeric; v_old_hwm numeric;
begin
  select * into v_last from pool_equity order by id desc limit 1;
  if not found then raise exception 'nothing to undo'; end if;
  if v_last.kind = 'close' then raise exception 'a quarter close is final and cannot be undone here'; end if;
  select * into v_prev from pool_equity where id < v_last.id order by id desc limit 1;

  if v_last.kind = 'update' then
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'update', v_prev.equity_usdt, v_prev.total_units, v_prev.unit_price, v_prev.php_rate, v_note, v_actor, v_last.id);
    return jsonb_build_object('kind', 'update');

  elsif v_last.kind = 'deposit' then
    select * into r from ledger where equity_id = v_last.id and kind = 'deposit';
    if not found then raise exception 'could not find the matching entry'; end if;
    v_profile := r.profile_id;
    v_old := _units_of(v_profile) - r.units;   -- units this person held just before the deposit
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'withdrawal', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), v_last.unit_price, v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
    values (now(), v_profile, 'deposit', -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    if v_old <= 0 then
      delete from holder_state where profile_id = v_profile;
    else
      select hwm into v_hwm from holder_state where profile_id = v_profile;
      v_old_hwm := (v_hwm * (v_old + r.units) - r.units * r.unit_price) / v_old;
      update holder_state set hwm = v_old_hwm where profile_id = v_profile;
    end if;
    return jsonb_build_object('kind', 'deposit', 'profile_id', v_profile);

  else   -- withdrawal
    v_profile := (select profile_id from ledger where equity_id = v_last.id and kind = 'withdrawal' limit 1);
    insert into pool_equity(ts, kind, equity_usdt, total_units, unit_price, php_rate, note, created_by, reversed_of)
    values (now(), 'deposit', coalesce(v_prev.equity_usdt, 0), coalesce(v_prev.total_units, 0), v_last.unit_price, v_last.php_rate, v_note, v_actor, v_last.id)
    returning id into v_new_eq;
    for r in select * from ledger where equity_id = v_last.id loop
      insert into ledger(ts, profile_id, kind, units, usdt, unit_price, php_rate, equity_id, note, reversed_of)
      values (now(), r.profile_id, r.kind, -r.units, -r.usdt, r.unit_price, r.php_rate, v_new_eq, v_note, r.id);
    end loop;
    update withdrawal_requests set status = 'pending', ledger_id = null
     where ledger_id in (select id from ledger where equity_id = v_last.id and kind = 'withdrawal');
    return jsonb_build_object('kind', 'withdrawal', 'profile_id', v_profile);
  end if;
end $$;

grant execute on function public.admin_undo_last(text, text) to anon, authenticated;

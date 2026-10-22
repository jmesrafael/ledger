-- READ-ONLY integrity check of the CURRENT ledger, to run BEFORE 20261101000000_ledger_integrity.sql.
-- It only reads (SELECT). It changes nothing, and it shows no names, logins or amounts beyond what an investigation needs
-- (account ids and entry ids). Paste into the Supabase SQL Editor and Run. Every row with count > 0 needs a look before migrating.
-- After the migration, the same checks (and more) are available as: select public.admin_integrity_report('<manager token>');
with
per_person as (select profile_id, sum(units) u from public.ledger group by profile_id),
lots as (select profile_id, sum(units) u from public.holder_lots group by profile_id),
last_entry as (select * from public.pool_equity order by id desc limit 1),
checks as (
  select 'negative_unit_balance' as check_id, 'critical' as severity, count(*) as n,
         string_agg(profile_id::text, ', ') as sample from per_person where u < -0.000000001
  union all
  select 'total_units_vs_last_entry', 'critical',
         case when abs(coalesce((select sum(u) from per_person), 0) - coalesce((select total_units from last_entry), 0)) > 0.000001 then 1 else 0 end,
         format('ledger %s vs last entry %s', (select sum(u) from per_person), (select total_units from last_entry))
  union all
  select 'fee_transfer_not_netting_to_zero', 'critical', count(*), string_agg(equity_id::text, ', ')
    from (select equity_id from public.ledger where kind in ('fee_in', 'fee_out') group by equity_id having abs(sum(units)) > 0.00000001) x
  union all
  select 'correction_that_was_itself_reversed (Delete pressed twice)', 'critical', count(*), string_agg(c.id::text || '<-' || o.id::text, ', ')
    from public.pool_equity c join public.pool_equity o on o.reversed_of = c.id where c.reversed_of is not null
  union all
  select 'ledger_row_reversal_chain', 'critical', count(*), string_agg(c.id::text, ', ')
    from public.ledger c join public.ledger o on o.reversed_of = c.id where c.reversed_of is not null
  union all
  select 'entry_reversed_more_than_once', 'critical', count(*), string_agg(reversed_of::text, ', ')
    from (select reversed_of from public.pool_equity where reversed_of is not null group by reversed_of having count(*) > 1) x
  union all
  select 'ledger_units_vs_per_deposit_lines', 'critical', count(*), string_agg(p.id::text, ', ')
    from public.profiles p left join per_person l on l.profile_id = p.id left join lots h on h.profile_id = p.id
   where abs(coalesce(l.u, 0) - coalesce(h.u, 0)) > 0.000001
  union all
  select 'deposit_waiting_but_also_joined', 'critical', count(*), string_agg(d.id::text, ', ')
    from public.pending_deposits d
   where d.status = 'pending' and exists (
         select 1 from public.ledger l                                  -- the original deposit of this person and amount ...
          where l.kind = 'deposit' and l.reversed_of is null and l.profile_id = d.profile_id and l.usdt = d.usdt
            and exists (select 1 from public.ledger r1 where r1.reversed_of = l.id      -- ... was reversed, and that reversal was reversed again
                          and exists (select 1 from public.ledger r2 where r2.reversed_of = r1.id)))
  union all
  select 'entry_where_equity_is_not_price_times_units', 'high', count(*), string_agg(id::text, ', ')
    from public.pool_equity where abs(equity_usdt - unit_price * total_units) > 0.0001 + equity_usdt * 0.000000001
  union all
  select 'several_settlements_on_one_day', 'high', count(*), string_agg(d::text, ', ')
    from (select ts::date d from public.pool_equity where kind = 'close' group by ts::date having count(*) > 1) x
  union all
  select 'paid_request_without_ledger_entry', 'high', count(*), string_agg(id::text, ', ')
    from public.withdrawal_requests where status = 'paid' and ledger_id is null
  union all
  select 'request_paid_by_a_shared_ledger_entry', 'high', count(*), string_agg(ledger_id::text, ', ')
    from (select ledger_id from public.withdrawal_requests where ledger_id is not null group by ledger_id having count(*) > 1) x
  union all
  select 'pending_deposit_converted_twice', 'critical', count(*), string_agg(ledger_id::text, ', ')
    from (select ledger_id from public.pending_deposits where ledger_id is not null group by ledger_id having count(*) > 1) x
)
select check_id, severity, n as count, case when n > 0 then sample end as ids from checks
order by case severity when 'critical' then 0 when 'high' then 1 else 2 end, check_id;

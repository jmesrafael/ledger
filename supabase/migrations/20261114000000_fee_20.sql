-- Fee goes from 10% to 20% of new profit (above each person's high-water mark). NOT applied to any database. Safe to run twice.
-- Changes DATA only (no function or table is touched):
--   1. ledger_settings.default_fee_rate  0.10 -> 0.20   (every NEW account starts at 20%)
--   2. ledger_settings.fund_m_own_fee_rate 0.10 -> 0.20 (only used by the optional "all_pool" mode for Fund M's own capital, see docs/hwm-settlement.md)
--   3. investors currently at 10%:
--        - holding units, or with money waiting to join -> fee_rate_next = 0.20. It starts at the NEXT settlement, exactly like raising the % in
--          Users -> Edit, so profit already made under the 10% terms is never charged at 20%.
--        - nobody's money in yet -> fee_rate = 0.20 at once.
--      Investors on any other rate (for example a friend you agreed 15% with) are left alone: change them in Users -> Edit.
-- Tell investors BEFORE running this. The terms they agreed to say 10%; bump TERMS_VERSION in js/app.js so everyone is asked to agree again.
-- To undo before the next settlement: set the three values back to 0.10 and clear fee_rate_next.

update public.ledger_settings set value = '0.20' where key = 'default_fee_rate';
update public.ledger_settings set value = '0.20' where key = 'fund_m_own_fee_rate' and value = '0.10';

update public.profiles p
   set fee_rate_next = 0.20
 where p.role = 'investor' and p.fee_rate = 0.10
   and (public._units_of(p.id) > 0 or exists (select 1 from public.pending_deposits d where d.profile_id = p.id and d.status = 'pending'));

update public.profiles p
   set fee_rate = 0.20, fee_rate_next = null
 where p.role = 'investor' and p.fee_rate = 0.10 and p.fee_rate_next is null
   and not (public._units_of(p.id) > 0 or exists (select 1 from public.pending_deposits d where d.profile_id = p.id and d.status = 'pending'));

-- check: shows who is on what
select p.username, p.fee_rate as rate_now, p.fee_rate_next as rate_from_next_settlement from public.profiles p where p.role = 'investor' order by p.username;

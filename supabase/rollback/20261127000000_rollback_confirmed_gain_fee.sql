-- ROLLBACK of 20261127000000_confirmed_gain_fee.sql: back to 1105's rule (fee at the settlement on everything above the mark) and 1109's
-- open-trades block. The functions stay (they branch on fee_timing) and the new columns stay (settlement history). Nothing is deleted. Safe to run twice.
-- Effect: the next settlement charges every gain not charged yet (pending or confirmed) once, at the rate in force then
-- (tests/confirmed-fee.test.mjs, "switching fee_timing back to immediate").
update public.ledger_settings set value = 'immediate' where key = 'fee_timing';
select key, value from public.ledger_settings where key = 'fee_timing';

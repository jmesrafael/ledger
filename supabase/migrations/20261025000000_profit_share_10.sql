-- New accounts default to a 10% profit share. The manager can type a different % for each person when creating
-- them (or later in Users -> Edit). Existing accounts keep the rate they already have.
update public.ledger_settings set value = '0.10' where key = 'default_fee_rate';

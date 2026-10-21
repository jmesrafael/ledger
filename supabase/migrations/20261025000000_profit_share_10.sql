-- Profit share for investors is 10% for now (early-investor rate). Applies to profit not yet settled at a quarter close;
-- anything already settled stays settled. Run once; to change a person's rate later use Users -> Edit in the app.
update public.profiles set fee_rate = 0.10 where role = 'investor';
update public.ledger_settings set value = '0.10' where key = 'default_fee_rate';

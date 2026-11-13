-- ROLLBACK of 20261214000000_auto_settlement.sql: puts back admin_close_quarter_tv (20261207) and bot_post_wallet_snapshot (20261213) exactly, and removes the
-- automatic run. Built by scripts/build-auto-settlement.mjs. Settlements already made (automatic or not), their exceptions and audit rows are ordinary
-- append-only records and stay.
do $$ begin
  if to_regprocedure('public._settle_auto(text)') is null then raise exception 'rollback refused: 20261214000000_auto_settlement.sql is not applied'; end if;
end $$;

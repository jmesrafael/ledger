// Turns a ledger backup (ledger.json from backup-ledger / the app's export) into ONE SQL script that restores every accounting record.
// It never connects to a database. Run the script yourself, in a FRESH staging Supabase project that already has every migration applied.
//
//   node scripts/restore-ledger.mjs backups/<folder>/ledger.json restore.sql
//
// The script refuses to run if the target already holds ledger data, restores in one transaction, switches the activity-log triggers
// off while it loads (so the restore does not write fake history), resets the id sequences, and checks the row counts and the units
// against the backup before it commits. Passwords are not in backups: set a new one for each person afterwards (see the end of the script).
// The bot key is not in backups either: make a new one (scripts/new-bot-key.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// backup key -> table, in an order that satisfies the foreign keys
export const RESTORE_ORDER = [
  ['settings', 'ledger_settings'], ['people', 'profiles'], ['pool_equity', 'pool_equity'], ['ledger', 'ledger'], ['pending_deposits', 'pending_deposits'],
  ['withdrawal_requests', 'withdrawal_requests'], ['holder_lots', 'holder_lots'], ['holder_state', 'holder_state'], ['lot_log', 'lot_log'],
  ['investor_period', 'investor_period'], ['period_log', 'period_log'], ['investor_hwm', 'investor_hwm'], ['hwm_log', 'hwm_log'], ['corrections', 'corrections'],
  ['exchange_snapshots', 'exchange_snapshots'], ['exchange_transfers', 'exchange_transfers'], ['transfer_matches', 'transfer_matches'],
  ['snapshot_attestations', 'snapshot_attestations'], ['settlement_attestations', 'settlement_attestations'], ['balance_verifications', 'balance_verifications'],
  ['verification_adjustments', 'verification_adjustments'], ['capital_events', 'capital_events'], ['payout_records', 'payout_records'],
  ['position_snapshots', 'position_snapshots'], ['settlement_exceptions', 'settlement_exceptions'], ['settlements', 'settlements'],
  ['settlement_lines', 'settlement_lines'], ['terms_acceptances', 'terms_acceptances'], ['payout_details', 'payout_details'],
  ['idempotency_keys', 'idempotency_keys'], ['audit_log', 'audit_log'], ['investor_perf_draft_archive', 'investor_perf_draft_archive'],
  ['perf_log_draft_archive', 'perf_log_draft_archive'],
];
// the two draft archives exist only in a database that once ran the earlier trial migration; a fresh project does not have them, so they are skipped there
export const OPTIONAL = new Set(['investor_perf_draft_archive', 'perf_log_draft_archive']);
const KEYED = new Set(['settings']);   // loaded with "on conflict": the migrations already created these rows

export function buildRestoreSql(backup) {
  if (!backup || backup.format !== 'lucid-io-ledger-backup-1') throw new Error('not a Lucid\'io ledger backup (format lucid-io-ledger-backup-1 expected)');
  const tag = '$lucid_restore$';
  const parts = [];
  const counts = {};
  const tables = [];
  for (const [key, table] of RESTORE_ORDER) {
    let rows = backup[key];
    if (!Array.isArray(rows) || !rows.length) { counts[table] = 0; continue; }
    if (key === 'people') rows = rows.map((r) => ({ ...r, pass_hash: '!restored: set a new password', failed_attempts: 0 }));
    const json = JSON.stringify(rows);
    if (json.includes(tag)) throw new Error(`the backup contains the text ${tag}; cannot embed it safely`);
    counts[table] = rows.length;
    tables.push(table);
    const conflict = KEYED.has(key) ? ' on conflict (key) do update set value = excluded.value' : '';
    // the migrations themselves write a few activity-log rows into a fresh project; the backup's log replaces them (its triggers are off here)
    if (table === 'audit_log') parts.push('delete from public.audit_log;');
    const ins = `insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, ${tag}${json}${tag}::jsonb)${conflict};`;
    if (OPTIONAL.has(table)) parts.push(`do $r$ begin if to_regclass('public.${table}') is null then raise notice 'skipped ${table}: this project does not have it (a draft archive)'; else
${ins}
end if; end $r$;`);
    else parts.push(ins);
  }
  const totalUnits = (backup.ledger || []).reduce((t, r) => t + Number(r.units), 0);
  const lastUnits = (backup.pool_equity || []).length ? Number(backup.pool_equity[backup.pool_equity.length - 1].total_units) : 0;
  if (Math.abs(totalUnits - lastUnits) > 1e-6) throw new Error(`the backup itself is inconsistent: ledger units ${totalUnits} vs last pool entry ${lastUnits}`);
  return `-- Lucid'io Ledger RESTORE. Generated ${new Date().toISOString()} from a backup exported at ${backup.exported_at || '?'}.
-- RUN THIS ONLY IN A FRESH STAGING PROJECT that already has every migration applied. It refuses to run on a database that has ledger data.
begin;
do $r$ begin
  if exists (select 1 from public.pool_equity) or exists (select 1 from public.ledger) or exists (select 1 from public.profiles) then
    raise exception 'restore refused: this database already has ledger data. Use a fresh project with all migrations applied.';
  end if;
end $r$;

-- load without the activity-log and guard triggers (foreign keys stay on)
do $r$ declare t text; begin
  foreach t in array array[${[...new Set(tables)].map((t) => `'${t}'`).join(', ')}] loop if to_regclass('public.' || quote_ident(t)) is not null then execute format('alter table public.%I disable trigger user', t); end if; end loop;
  alter table public.pool_equity disable trigger user;
end $r$;

${parts.join('\n\n')}

do $r$ declare t text; begin
  foreach t in array array[${[...new Set(tables)].map((t) => `'${t}'`).join(', ')}] loop if to_regclass('public.' || quote_ident(t)) is not null then execute format('alter table public.%I enable trigger user', t); end if; end loop;
  alter table public.pool_equity enable trigger user;
end $r$;

-- ids continue after the restored ones
do $r$ declare t text; s text; begin
  foreach t in array array[${[...new Set(tables)].map((t) => `'${t}'`).join(', ')}] loop
    s := null;
    if to_regclass('public.' || quote_ident(t)) is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'id') then s := pg_get_serial_sequence('public.' || t, 'id'); end if;
    if s is not null then execute format('select setval(%L, greatest(coalesce((select max(id) from public.%I), 1), 1), (select max(id) from public.%I) is not null)', s, t, t); end if;
  end loop;
end $r$;

-- prove the copy before committing
do $r$ declare c jsonb := ${tag}${JSON.stringify(counts)}${tag}::jsonb; t text; n bigint; u numeric; l numeric; begin
  for t in select jsonb_object_keys(c) loop
    if to_regclass('public.' || quote_ident(t)) is null then
      if t = any(array[${[...OPTIONAL].map((t) => `'${t}'`).join(', ')}]) then raise notice 'not checked: % (not in this project)', t;
      elsif (c->>t)::bigint > 0 then raise exception 'restore check failed: table % does not exist here', t; end if;
    else
      execute format('select count(*) from public.%I', t) into n;
      if t = 'ledger_settings' then
        if n < (c->>t)::bigint then raise exception 'restore check failed: ledger_settings has % rows, backup has %', n, c->>t; end if;
      elsif n <> (c->>t)::bigint then raise exception 'restore check failed: % has % rows, backup has %', t, n, c->>t; end if;
    end if;
  end loop;
  select coalesce(sum(units), 0) into u from public.ledger;
  select coalesce(total_units, 0) into l from (select total_units from public.pool_equity order by id desc limit 1) x;
  if abs(u - coalesce(l, 0)) > 0.000001 then raise exception 'restore check failed: ledger units % vs last pool entry %', u, l; end if;
end $r$;
commit;

-- AFTER the restore (each person was restored without a password):
--   update public.profiles set pass_hash = extensions.crypt('NEW-PASSWORD', extensions.gen_salt('bf', 10)) where username = '<username>';
-- then run:  select public.admin_integrity_report('<manager token>');   and compare each person's value with the backup.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('usage: node scripts/restore-ledger.mjs <backup ledger.json> <output restore.sql>'); process.exit(2); }
  const sql = buildRestoreSql(JSON.parse(readFileSync(src, 'utf8')));
  writeFileSync(out, sql);
  console.log(`wrote ${out} (${(sql.length / 1024).toFixed(0)} KB). Run it in a fresh staging project, never in production.`);
}

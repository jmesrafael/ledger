// Turns a ledger backup (ledger.json from backup-ledger / the app's export) into ONE SQL script that restores every accounting record.
// It never connects to a database. Run the script yourself, in a FRESH staging Supabase project that already has every migration applied.
//
//   node scripts/restore-ledger.mjs backups/<folder>/ledger.json restore.sql
//
// Numbers are NEVER parsed here: JavaScript would round the 24-digit values PostgreSQL stores (high-water marks, unit prices) to 17 digits.
// The backup text is split into its top-level tables and each table is handed to PostgreSQL unchanged, so the restore is exact.
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

// Splits the text of ONE JSON object into { key: raw text of its value } without parsing any value (so no number is ever rounded).
export function splitTopLevel(text) {
  const out = {};
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const str = () => {                                  // reads a JSON string starting at the opening quote; returns the raw text including quotes
    const a = i; i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return text.slice(a, i);
  };
  ws();
  if (text[i] !== '{') throw new Error('a backup is one JSON object');
  i++;
  for (;;) {
    ws();
    if (i >= text.length) throw new Error('the backup ends early (truncated file?)');
    if (text[i] === '}') break;
    if (text[i] === ',') { i++; continue; }
    if (text[i] !== '"') throw new Error('unexpected text in the backup at position ' + i);
    const key = JSON.parse(str());
    ws(); if (text[i] !== ':') throw new Error('expected ":" after ' + key); i++; ws();
    const a = i;
    if (text[i] === '[' || text[i] === '{') {
      let depth = 0;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === '"') { str(); i--; }
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') { depth--; if (depth === 0) { i++; break; } }
      }
      if (depth !== 0) throw new Error('the backup ends early inside ' + key + ' (truncated file?)');
    } else if (text[i] === '"') str();
    else while (i < text.length && !',}'.includes(text[i])) i++;
    out[key] = text.slice(a, i).trim();
  }
  return out;
}

export function buildRestoreSql(backup) {
  const raw = splitTopLevel(typeof backup === 'string' ? backup : JSON.stringify(backup));
  if (raw.format !== '"lucid-io-ledger-backup-1"') throw new Error('not a Lucid\'io ledger backup (format lucid-io-ledger-backup-1 expected)');
  const tag = '$lucid_restore$';
  const load = [], tables = [];
  for (const [key, table] of RESTORE_ORDER) {
    const json = raw[key];
    if (!json || json === '[]') continue;
    if (!json.startsWith('[')) throw new Error(`${key} is not a list in this backup`);
    if (json.includes(tag)) throw new Error(`the backup contains the text ${tag}; cannot embed it safely`);
    tables.push(table);
    load.push(`insert into _restore_src values ('${table}', ${tag}${json}${tag}::jsonb);`);
  }
  const names = tables.map((t) => `'${t}'`).join(', ');
  const optional = [...OPTIONAL].map((t) => `'${t}'`).join(', ');
  const steps = [];
  for (const [key, table] of RESTORE_ORDER) {
    if (!tables.includes(table)) continue;
    const src = `(select j from _restore_src where t = '${table}')`;
    // people are restored without a password or lock state (the backup never contains them)
    const rows = table === 'profiles'
      ? `(select jsonb_agg(e || '{"pass_hash": "!restored: set a new password", "failed_attempts": 0}'::jsonb) from jsonb_array_elements(${src}) e)` : src;
    const conflict = KEYED.has(key) ? ' on conflict (key) do update set value = excluded.value' : '';
    const ins = `insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, ${rows})${conflict};`;
    // the migrations themselves write a few activity-log rows into a fresh project; the backup's log replaces them (its triggers are off here)
    const pre = table === 'audit_log' ? 'delete from public.audit_log;\n' : '';
    steps.push(OPTIONAL.has(table)
      ? `do $r$ begin if to_regclass('public.${table}') is null then raise notice 'skipped ${table}: this project does not have it (a draft archive)'; else\n${ins}\nend if; end $r$;`
      : pre + ins);
  }
  return `-- Lucid'io Ledger RESTORE. Generated ${new Date().toISOString()} from a backup exported at ${JSON.parse(raw.exported_at || 'null') || '?'}.
-- RUN THIS ONLY IN A FRESH STAGING PROJECT that already has every migration applied. It refuses to run on a database that has ledger data.
begin;
do $r$ begin
  if exists (select 1 from public.pool_equity) or exists (select 1 from public.ledger) or exists (select 1 from public.profiles) then
    raise exception 'restore refused: this database already has ledger data. Use a fresh project with all migrations applied.';
  end if;
end $r$;

-- the backup, table by table, exactly as exported (PostgreSQL reads every number itself)
create temp table _restore_src (t text primary key, j jsonb not null) on commit drop;
${load.join('\n')}

-- load without the activity-log and guard triggers (foreign keys stay on)
do $r$ declare t text; begin
  foreach t in array array[${names}] loop if to_regclass('public.' || quote_ident(t)) is not null then execute format('alter table public.%I disable trigger user', t); end if; end loop;
end $r$;

${steps.join('\n\n')}

do $r$ declare t text; begin
  foreach t in array array[${names}] loop if to_regclass('public.' || quote_ident(t)) is not null then execute format('alter table public.%I enable trigger user', t); end if; end loop;
end $r$;

-- ids continue after the restored ones
do $r$ declare t text; s text; begin
  foreach t in array array[${names}] loop
    s := null;
    if to_regclass('public.' || quote_ident(t)) is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'id') then s := pg_get_serial_sequence('public.' || t, 'id'); end if;
    if s is not null then execute format('select setval(%L, greatest(coalesce((select max(id) from public.%I), 1), 1), (select max(id) from public.%I) is not null)', s, t, t); end if;
  end loop;
end $r$;

-- prove the copy before committing: every table has exactly the rows the backup has, and the units agree
do $r$ declare x record; n bigint; u numeric; l numeric; begin
  for x in select t, jsonb_array_length(j) c from _restore_src loop
    if to_regclass('public.' || quote_ident(x.t)) is null then
      if x.t = any(array[${optional}]) then raise notice 'not checked: % (not in this project)', x.t;
      else raise exception 'restore check failed: table % does not exist here', x.t; end if;
    else
      execute format('select count(*) from public.%I', x.t) into n;
      if x.t = 'ledger_settings' then
        if n < x.c then raise exception 'restore check failed: ledger_settings has % rows, backup has %', n, x.c; end if;
      elsif n <> x.c then raise exception 'restore check failed: % has % rows, backup has %', x.t, n, x.c; end if;
    end if;
  end loop;
  select coalesce(sum(units), 0) into u from public.ledger;
  select coalesce(total_units, 0) into l from (select total_units from public.pool_equity order by id desc limit 1) q;
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
  const sql = buildRestoreSql(readFileSync(src, 'utf8'));
  writeFileSync(out, sql);
  console.log(`wrote ${out} (${(sql.length / 1024).toFixed(0)} KB). Run it in a fresh staging project, never in production.`);
}

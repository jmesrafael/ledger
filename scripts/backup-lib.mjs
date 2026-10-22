// Ledger backup logic, shared by scripts/backup-ledger.mjs (the nightly job) and the tests.
//   verify(export, previousSummary)  -> { problems, warnings }   re-checks the export against its own numbers
//   writeBackup(export, outDir, opts) -> { dir, files, pruned }  one folder per backup: ledger.json + one CSV per table + summary.json
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';

export const TABLES = ['people', 'pool_equity', 'ledger', 'pending_deposits', 'withdrawal_requests', 'holder_lots', 'lot_log', 'terms_acceptances', 'settings', 'audit_log'];
const FOLDER = /^ledger-\d{4}-\d{2}-\d{2}_\d{6}$/;

export function verify(x, prev = null) {
  const problems = [], warnings = [], c = x && x.checks;
  if (!x || x.format !== 'lucidyo-ledger-backup-1') return { problems: ['not a ledger backup (unknown format)'], warnings };
  for (const t of TABLES) if (!Array.isArray(x[t])) problems.push(`missing table: ${t}`);
  if (!c) { problems.push('missing checks'); return { problems, warnings }; }
  if (problems.length) return { problems, warnings };
  if (c.ledger_rows !== x.ledger.length) problems.push(`ledger rows: export says ${c.ledger_rows}, file has ${x.ledger.length}`);
  if (c.equity_rows !== x.pool_equity.length) problems.push(`equity rows: export says ${c.equity_rows}, file has ${x.pool_equity.length}`);
  if (c.people !== x.people.length) problems.push(`people: export says ${c.people}, file has ${x.people.length}`);
  const sumUnits = x.ledger.reduce((t, l) => t + Number(l.units), 0);
  if (Math.abs(sumUnits - Number(c.total_units_ledger)) > 1e-6) problems.push(`units in the ledger rows (${sumUnits}) do not match the export's own total (${c.total_units_ledger})`);
  if (x.pool_equity.length && Math.abs(Number(c.total_units_ledger) - Number(c.total_units_last_reading)) > 1e-6)
    problems.push(`everyone's units (${c.total_units_ledger}) do not match the last equity reading (${c.total_units_last_reading})`);
  if (c.fee_engine) {   // flat fee on period profit (20261101000000_ledger_integrity.sql): there are no per-deposit lines to compare any more
    if (!Array.isArray(x.investor_period)) problems.push('the export has no investor_period table');
  } else if (Math.abs(Number(c.lots_units) - Number(c.total_units_ledger)) > 1e-6) problems.push(`per-deposit lines (${c.lots_units}) do not add up to everyone's units (${c.total_units_ledger})`);
  if (/pass_hash|\$2[aby]\$/.test(JSON.stringify(x))) problems.push('the export contains a password hash');
  if (prev) {
    if (c.ledger_rows < prev.ledger_rows) warnings.push(`fewer ledger rows than the last backup (${c.ledger_rows} < ${prev.ledger_rows}): was the ledger reset?`);
    if (c.equity_rows < prev.equity_rows) warnings.push(`fewer equity readings than the last backup (${c.equity_rows} < ${prev.equity_rows})`);
  }
  return { problems, warnings };
}

const csvCell = (v) => {
  const t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
const LEAD = ['id', 'ts', 'received_at', 'requested_at', 'profile_id', 'username', 'name', 'kind', 'action', 'actor_name', 'subject_name', 'usdt', 'units', 'unit_price'];
export function toCsv(rows) {
  if (!rows.length) return '\r\n';
  const seen = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cols = [...LEAD.filter((c) => seen.includes(c)), ...seen.filter((c) => !LEAD.includes(c))];   // the useful columns first, for spreadsheets
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

const pad = (n) => String(n).padStart(2, '0');
export const folderName = (d) => `ledger-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;   // UTC, so it sorts

export function latestSummary(outDir) {
  if (!existsSync(outDir)) return null;
  const dirs = readdirSync(outDir).filter((f) => FOLDER.test(f)).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    try { return JSON.parse(readFileSync(path.join(outDir, dirs[i], 'summary.json'), 'utf8')); } catch { /* try the one before */ }
  }
  return null;
}

export function writeBackup(x, outDir, { now = new Date(), keep = 60, copyTo = '', verdict = null } = {}) {
  const dir = path.join(outDir, folderName(now));
  mkdirSync(dir, { recursive: true });
  const files = ['ledger.json'];
  writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(x));
  for (const t of TABLES) { writeFileSync(path.join(dir, t + '.csv'), toCsv(x[t] || [])); files.push(t + '.csv'); }
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ exported_at: x.exported_at, saved_at: now.toISOString(), ...x.checks, verified: verdict ? !verdict.problems.length : null, problems: verdict ? verdict.problems : [], warnings: verdict ? verdict.warnings : [] }, null, 2));
  files.push('summary.json');
  let pruned = [];
  const all = readdirSync(outDir).filter((f) => FOLDER.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) { rmSync(path.join(outDir, f), { recursive: true, force: true }); pruned.push(f); }
  if (copyTo) { mkdirSync(copyTo, { recursive: true }); cpSync(dir, path.join(copyTo, path.basename(dir)), { recursive: true }); }
  return { dir, files, pruned };
}

// Nightly ledger backup. Downloads everything (people, entries, equity readings, requests, activity log, settings) using a
// read-only BACKUP KEY, re-checks it against its own numbers, and saves a dated folder: ledger.json + one CSV per table.
// The key can only read the export (it cannot sign in, see the app, or change anything), and the manager can revoke it any
// time in the app (Fund → Log → Backups). Backups never contain passwords.
//
//   one-time setup: in the app (Fund → Log → Backups) press "Create nightly backup key", then copy backup.config.example.json
//   to backup.config.json and paste the key into it.
//
//   node scripts/backup-ledger.mjs                      run one backup now
//   node scripts/backup-ledger.mjs --schedule 02:30     (Windows) register it as a daily task at 02:30 local time
//   options: --key <key>  --out <folder>  --keep <how many to keep, default 60>  --copy-to <second folder, e.g. a Google Drive / OneDrive folder>
// Exit code 0 = saved and verified; 1 = failed or the data did not re-check (the raw data is still saved so nothing is lost).
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, writeBackup, latestSummary } from './backup-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };

if (opt('schedule')) {
  const time = opt('schedule');
  if (!/^\d{2}:\d{2}$/.test(time || '')) { console.error('use --schedule HH:MM, e.g. --schedule 02:30'); process.exit(1); }
  if (process.platform !== 'win32') { console.error('--schedule is for Windows. On Linux/macOS add a cron line: 30 2 * * * node ' + path.join(ROOT, 'scripts/backup-ledger.mjs')); process.exit(1); }
  const cmd = path.join(ROOT, 'backup-ledger.cmd');
  const r = spawnSync('schtasks', ['/create', '/tn', "Lucid'io ledger backup", '/tr', `"${cmd}"`, '/sc', 'daily', '/st', time, '/f'], { stdio: 'inherit' });
  if (r.status === 0) spawnSync('schtasks', ['/delete', '/tn', 'Lucidyo ledger backup', '/f'], { stdio: 'ignore' });   // the task from before the rename, if there is one
  console.log(r.status === 0 ? `Scheduled: every day at ${time} (task "Lucid'io ledger backup"). Remove it with: schtasks /delete /tn "Lucid'io ledger backup" /f` : 'Could not create the task. Try running this from an Administrator terminal.');
  process.exit(r.status === 0 ? 0 : 1);
}

const cfgFile = path.join(ROOT, 'backup.config.json');
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
const key = opt('key') || process.env.LEDGER_BACKUP_KEY || cfg.key;
const outDir = path.resolve(ROOT, opt('out') || process.env.LEDGER_BACKUP_DIR || cfg.outDir || 'backups');
const keep = Number(opt('keep') || cfg.keep || 60), copyTo = opt('copy-to') || process.env.LEDGER_BACKUP_COPY_TO || cfg.copyTo || '';
const site = readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
const URL_ = (site.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1], PUB = (site.match(/SUPABASE_KEY:\s*'([^']+)'/) || [])[1];

mkdirSync(outDir, { recursive: true });
const log = (msg) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); try { appendFileSync(path.join(outDir, 'backup.log'), line + '\n'); } catch { /* console only */ } };
const status = (o) => { try { writeFileSync(path.join(outDir, 'status.json'), JSON.stringify({ at: new Date().toISOString(), ...o }, null, 2)); } catch { /* ignore */ } };
const fail = (msg) => { log('FAILED: ' + msg); status({ ok: false, error: msg }); process.exit(1); };

if (!key) fail('no backup key. Create one in the app (Fund → Log → Backups) and put it in backup.config.json (see backup.config.example.json)');
if (!URL_ || !PUB) fail('could not read the site address from js/config.js');

async function download() {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${URL_}/rest/v1/rpc/backup_export`, { method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { apikey: PUB, Authorization: 'Bearer ' + PUB, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: key }) });
      const text = await res.text();
      if (!res.ok) { const m = (() => { try { return JSON.parse(text).message; } catch { return text.slice(0, 200); } })(); if (/invalid backup key/i.test(m || '')) fail('the backup key was rejected (revoked or mistyped). Create a new key in the app'); throw new Error(`HTTP ${res.status}: ${m}`); }
      return JSON.parse(text);
    } catch (e) { last = e; if (attempt < 3) { log(`download failed (attempt ${attempt}/3): ${e.message}; retrying`); await new Promise((r) => setTimeout(r, attempt * 5000)); } }
  }
  fail('could not download: ' + last.message);
}

const x = await download();
const verdict = verify(x, latestSummary(outDir));
const saved = writeBackup(x, outDir, { keep, copyTo, verdict });
const c = x.checks;
log(`saved ${path.relative(ROOT, saved.dir)} · ${c.people} people, ${c.ledger_rows} entries, ${c.equity_rows} equity readings, last equity ${Number(c.last_equity_usdt).toFixed(2)} USDT${copyTo ? ' · copied to ' + copyTo : ''}${saved.pruned.length ? ` · removed ${saved.pruned.length} old` : ''}`);
for (const w of verdict.warnings) log('WARNING: ' + w);
if (verdict.problems.length) { for (const p of verdict.problems) log('PROBLEM: ' + p); status({ ok: false, folder: path.basename(saved.dir), problems: verdict.problems }); process.exit(1); }
status({ ok: true, folder: path.basename(saved.dir), ledger_rows: c.ledger_rows, equity_rows: c.equity_rows, warnings: verdict.warnings });
log('verified: the numbers in the backup re-check.');

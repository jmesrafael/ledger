// Daily books-vs-MEXC check. READ-ONLY: it downloads the ledger export with the same revocable backup key the nightly backup uses (the key can only read),
// compares the books with the wallet reports the bots already send every few minutes (see scripts/recon-lib.mjs), logs the result and, if something is off,
// sends a Telegram message. It never touches a bot, the exchange or the database.
//
//   node scripts/recon-check.mjs                    check now (download with the backup key from backup.config.json)
//   node scripts/recon-check.mjs --file ledger.json check a saved export instead (e.g. backups/ledger-*/ledger.json): no key, no network
//   node scripts/recon-check.mjs --notify-ok        also send a Telegram message when all is fine
//   node scripts/recon-check.mjs --no-telegram      never send
//   node scripts/recon-check.mjs --schedule 08:00   (Windows) run it every day at 08:00 local time
//   Telegram: "telegram": {"token": "...", "chatId": "..."} in backup.config.json, or env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
// Exit code: 0 = ok, 1 = a problem was found (so Task Scheduler / cron can also notice), 2 = the check itself could not run.
// Every run appends one line to backups/recon-log.jsonl: the evidence trail that the books matched the exchange on that day.
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile, backupHealth, formatReport } from './recon-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k) => args.includes('--' + k);

if (opt('schedule')) {
  const time = opt('schedule');
  if (!/^\d{2}:\d{2}$/.test(time || '')) { console.error('use --schedule HH:MM, e.g. --schedule 08:00'); process.exit(2); }
  if (process.platform !== 'win32') { console.error('--schedule is for Windows. On Linux/macOS add a cron line: 0 8 * * * node ' + path.join(ROOT, 'scripts/recon-check.mjs')); process.exit(2); }
  const cmd = path.join(ROOT, 'recon-check.cmd');
  const r = spawnSync('schtasks', ['/create', '/tn', "Lucid'io books vs MEXC check", '/tr', `"${cmd}"`, '/sc', 'daily', '/st', time, '/f'], { stdio: 'inherit' });
  console.log(r.status === 0 ? `Scheduled: every day at ${time}. Remove it with: schtasks /delete /tn "Lucid'io books vs MEXC check" /f` : 'Could not create the task. Try an Administrator terminal.');
  process.exit(r.status === 0 ? 0 : 2);
}

const cfgFile = path.join(ROOT, 'backup.config.json');
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
const outDir = path.resolve(ROOT, process.env.LEDGER_BACKUP_DIR || cfg.outDir || 'backups');
mkdirSync(outDir, { recursive: true });
const tg = { token: process.env.TELEGRAM_BOT_TOKEN || cfg.telegram?.token, chatId: process.env.TELEGRAM_CHAT_ID || cfg.telegram?.chatId };

async function sendTelegram(text) {
  if (flag('no-telegram')) return 'skipped (--no-telegram)';
  if (!tg.token || !tg.chatId) return 'not configured (add "telegram" to backup.config.json)';
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: tg.chatId, text }) });
    return res.ok ? 'sent' : `failed (HTTP ${res.status})`;
  } catch { return 'failed (network)'; }   // never echo the error: the URL holds the token
}

async function load() {
  if (opt('file')) return JSON.parse(readFileSync(path.resolve(opt('file')), 'utf8'));
  const key = opt('key') || process.env.LEDGER_BACKUP_KEY || cfg.key;
  if (!key) throw new Error('no backup key: create one in the app (Fund → Log → Backups) and put it in backup.config.json, or use --file');
  const site = readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  const url = (site.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1], pub = (site.match(/SUPABASE_KEY:\s*'([^']+)'/) || [])[1];
  const res = await fetch(`${url}/rest/v1/rpc/backup_export`, { method: 'POST', signal: AbortSignal.timeout(90000), headers: { apikey: pub, Authorization: 'Bearer ' + pub, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: key }) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return res.json();
}

let report, backup, exitCode = 0;
try {
  const x = await load();
  report = reconcile(x);
  let status = null; try { status = JSON.parse(readFileSync(path.join(outDir, 'status.json'), 'utf8')); } catch { /* none yet */ }
  backup = backupHealth(status);
  const text = formatReport(report, backup);
  console.log(text);
  const problem = report.verdict !== 'ok' || !backup.ok;
  const sent = (problem || flag('notify-ok')) ? await sendTelegram(text) : 'not needed';
  console.log(`telegram: ${sent}`);
  appendFileSync(path.join(outDir, 'recon-log.jsonl'), JSON.stringify({ ...report, backup: backup.text, telegram: sent }) + '\n');
  exitCode = problem ? 1 : 0;
} catch (e) {
  // the check not running is itself an alarm: tell Telegram, but without the error text beyond the message
  console.error('CHECK FAILED: ' + e.message);
  await sendTelegram('Ledger vs MEXC check could not run: ' + e.message);
  exitCode = 2;
}
process.exit(exitCode);

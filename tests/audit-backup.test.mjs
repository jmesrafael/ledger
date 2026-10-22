// Pesos on a person's own entries, the activity log, and backups (20261031000000_pesos_backup_audit.sql), on the real
// migrations in an in-memory Postgres. Every call goes in as the public "anon" role, like the website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).map((f) => new URL(f, appl)), ...readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => new URL(f, dir))]
  .sort((a, b) => a.pathname.split('/').pop().localeCompare(b.pathname.split('/').pop()));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '0' where key in ('min_days_between_closes', 'lock_months');
                 update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  return db;
}
const call = async (db, fn, ...args) => {
  await db.exec('set role anon');
  try { return (await db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const token = async (db, u, p) => { const r = await call(db, 'login', u, p); assert.equal(r.ok, true, JSON.stringify(r)); return r.token; };
async function world() {
  const db = await setup();
  const A = await token(db, 'raf', 'admin-password-1');
  const ids = { raf: (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id };
  for (const [u, n] of [['john', 'John'], ['dino', 'Dino']]) ids[u] = await call(db, 'admin_create_user', A, u, n, u + '-password', 0.1);
  return { db, A, ids, J: await token(db, 'john', 'john-password'), D: await token(db, 'dino', 'dino-password') };
}
const reading = async (db, A, factor = 1) => {
  const pool = await call(db, 'pool_summary', A), w = (await call(db, 'admin_pending', A)).reduce((t, d) => t + Number(d.usdt), 0);
  return call(db, 'admin_post_equity', A, Number(pool.total_units) * Number(pool.unit_price) * factor + w);
};
const log = async (db, A, n = 500) => (await call(db, 'admin_audit_log', A, n)).reverse();   // oldest first
const actions = (rows) => rows.map((r) => r.action);

test('my_ledger: a person sees the pesos they paid on their own entries, and only their own', async () => {
  const { db, A, ids, J, D } = await world();
  await call(db, 'admin_receive_deposit', A, ids.john, 100, 56, 5600, 'first');
  await call(db, 'admin_receive_deposit', A, ids.dino, 50, 57, 2850);
  await reading(db, A);
  const mine = await call(db, 'my_ledger', J);
  assert.equal(mine.length, 1);
  near(mine[0].php_amount, 5600); near(mine[0].php_rate, 56); near(mine[0].usdt, 100);
  near((await call(db, 'my_ledger', D))[0].php_amount, 2850);
});

test('activity log: who did what, with the right person as actor, and only the manager can read it', async () => {
  const { db, A, ids, J } = await world();
  await call(db, 'admin_receive_deposit', A, ids.raf, 100, 56, 5600);
  await call(db, 'admin_receive_deposit', A, ids.john, 50, 56, 2800);
  await reading(db, A);                                        // the waiting money joins at this reading
  await call(db, 'admin_post_equity', A, 160);                 // +? just a reading
  await call(db, 'request_withdrawal', J, 5);                  // John asks (actor: John)
  const req = (await call(db, 'my_requests', J))[0];
  await call(db, 'cancel_withdrawal_request', J, req.id);
  await call(db, 'change_my_password', J, 'john-password', 'john-new-pass-1');
  await call(db, 'admin_set_password', A, ids.john, 'john-reset-pass-1');
  await call(db, 'admin_set_profile', A, ids.john, 'Johnny', null, 0.05);
  await call(db, 'accept_terms', J, '2026-10-22').catch(() => {});   // may need a fresh login token after the password change; not essential
  const J2 = await token(db, 'john', 'john-reset-pass-1');
  await call(db, 'accept_terms', J2, '2026-10-22');
  await call(db, 'admin_view_as', A, ids.john);
  await call(db, 'admin_close_quarter', A, 170);
  const rows = await log(db, A), by = (a) => rows.filter((r) => r.action === a);

  assert.deepEqual(by('user_created').map((r) => r.subject_name), ['Raf', 'John', 'Dino']);            // Raf was created by the SQL (no actor)
  assert.equal(by('user_created')[0].actor_name, null);
  assert.equal(by('user_created')[1].actor_name, 'Raf');
  assert.equal(by('money_received')[0].actor_name, 'Raf'); assert.equal(by('money_received')[1].subject_name, 'John');
  near(by('money_received')[1].detail.php_amount, 2800);
  assert.equal(by('money_in').length, 2);                      // both converted at the first reading, each naming the person
  assert.deepEqual(by('money_in').map((r) => r.subject_name).sort(), ['John', 'Raf']);
  assert.ok(by('money_in').every((r) => r.actor_name === 'Raf'));
  assert.equal(by('withdrawal_requested')[0].actor_name, 'John');
  assert.equal(by('withdrawal_cancelled')[0].actor_name, 'John');
  assert.equal(by('password_changed')[0].actor_name, 'John');                                           // own password
  assert.equal(by('password_reset')[0].actor_name, 'Raf'); assert.equal(by('password_reset')[0].subject_name, 'John');
  assert.equal(by('name_changed')[0].detail.to, 'Johnny');
  assert.ok(by('rate_changed').length === 1 || by('rate_scheduled').length === 1);                     // lowering applies at once
  near(by('rate_changed')[0].detail.to, 0.05);
  assert.equal(by('terms_agreed')[0].actor_name, 'Johnny');
  assert.equal(by('viewed_as')[0].actor_name, 'Raf'); assert.equal(by('viewed_as')[0].subject_name, 'Johnny');
  assert.equal(by('quarter_closed').length, 1); assert.equal(by('quarter_closed')[0].actor_name, 'Raf');
  assert.ok(by('fee_charged').length >= 1 && by('fee_charged')[0].subject_name === 'Johnny');           // profit share charged at the close
  assert.ok(by('equity_reading').length >= 1);   // the first reading only converts waiting money (logged as money_in)
  assert.ok(!actions(rows).includes('login'));                                                           // sign-ins are not logged
  // times only go forward and every row has an id
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].id > rows[i - 1].id);

  await assert.rejects(() => call(db, 'admin_audit_log', J2), /admin only/);                            // investors cannot read it
  await assert.rejects(() => call(db, 'admin_audit_log', 'not-a-token'), /not signed in/);
});

test('activity log: corrections are logged, and nobody can edit or delete a log row', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_receive_deposit', A, ids.john, 40, 56, 2240); await reading(db, A);
  await call(db, 'admin_undo_last', A, 'typo');
  const rows = await log(db, A);
  assert.ok(actions(rows).includes('correction'));
  await assert.rejects(() => db.query(`update public.audit_log set action = 'x'`), /cannot be changed or deleted/);
  await assert.rejects(() => db.query(`delete from public.audit_log`), /cannot be changed or deleted/);
  await db.exec('set role anon');
  await assert.rejects(() => db.query(`select * from public.audit_log`), /permission denied/);           // not readable directly from the website
  await db.exec('reset role');
});

test('backup export: complete, no password hashes or sessions, numbers re-check, manager only', async () => {
  const { db, A, ids, J } = await world();
  await call(db, 'admin_receive_deposit', A, ids.raf, 100, 56, 5600); await call(db, 'admin_receive_deposit', A, ids.john, 50, 56, 2800);
  await reading(db, A); await reading(db, A, 1.2); await call(db, 'admin_close_quarter', A, 190);
  const x = await call(db, 'admin_export_all', A), text = JSON.stringify(x);
  assert.equal(x.format, 'lucidyo-ledger-backup-1');
  assert.equal(x.people.length, 3); assert.ok(x.ledger.length >= 4); assert.ok(x.pool_equity.length >= 4);
  assert.ok(!/pass_hash|\$2[aby]\$/.test(text), 'a password hash is in the export');
  assert.equal(x.sessions, undefined);
  assert.ok(x.people.every((p) => !('failed_attempts' in p) && !('locked_until' in p)));
  near(x.checks.total_units_ledger, Number(x.checks.total_units_last_reading), 1e-6);                  // ledger agrees with the last reading
  near(x.checks.lots_units, Number(x.checks.total_units_ledger), 1e-6);                                  // per-deposit lines add up too
  assert.equal(x.checks.ledger_rows, x.ledger.length); assert.equal(x.checks.people, x.people.length);
  assert.ok(x.audit_log.some((r) => r.action === 'quarter_closed'));
  await assert.rejects(() => call(db, 'admin_export_all', J), /admin only/);
  assert.ok(actions(await log(db, A)).includes('backup_exported'));                                      // the download itself is logged
});

test('backup key: made by the manager, shown once, can only read the export, revocable, logged', async () => {
  const { db, A, ids, J } = await world();
  await call(db, 'admin_receive_deposit', A, ids.raf, 100, 56, 5600); await reading(db, A);
  await assert.rejects(() => call(db, 'admin_create_backup_key', J), /admin only/);
  await assert.rejects(() => call(db, 'backup_export', 'nope'), /invalid backup key/);
  await assert.rejects(() => call(db, 'backup_export', null), /invalid backup key/);
  const key = await call(db, 'admin_create_backup_key', A, 'VPS nightly');
  assert.match(key, /^[0-9a-f]{48}$/);
  assert.equal((await db.query(`select count(*)::int n from public.backup_keys where key_hash = $1`, [key])).rows[0].n, 0);   // the key itself is not stored
  const x = await call(db, 'backup_export', key);
  assert.equal(x.format, 'lucidyo-ledger-backup-1'); assert.equal(x.people.length, 3);
  const st = await call(db, 'admin_backup_status', A);
  assert.equal(st.keys.length, 1); assert.equal(st.keys[0].label, 'VPS nightly'); assert.ok(st.keys[0].last_used_at); assert.ok(st.last_automatic);
  await assert.rejects(() => call(db, 'admin_backup_status', J), /admin only/);
  // the key opens nothing else
  await assert.rejects(() => call(db, 'admin_overview', key), /not signed in/);
  assert.equal(await call(db, 'admin_revoke_backup_keys', A), 1);
  await assert.rejects(() => call(db, 'backup_export', key), /invalid backup key/);
  const rows = await log(db, A);
  assert.ok(actions(rows).includes('backup_key_created') && actions(rows).includes('backup_keys_revoked'));
  assert.ok(rows.some((r) => r.action === 'backup_exported' && /automatic/.test(r.detail.how)));
});

// ---------------------------------------------------------------- the backup script's logic (scripts/backup-lib.mjs) on a real export
import { verify, writeBackup, latestSummary, toCsv as csvRows } from '../scripts/backup-lib.mjs';
import { mkdtempSync, readdirSync as ls, readFileSync as rd, rmSync as rm, existsSync as ex } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('backup files: ledger.json + a CSV per table + summary, verified, pruned to the newest N, optional second copy', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_receive_deposit', A, ids.raf, 100, 56, 5600); await call(db, 'admin_receive_deposit', A, ids.john, 50, 56, 2800);
  await reading(db, A); await reading(db, A, 1.1);
  const key = await call(db, 'admin_create_backup_key', A), x = await call(db, 'backup_export', key);
  const v = verify(x); assert.deepEqual(v.problems, []); assert.deepEqual(v.warnings, []);
  const out = mkdtempSync(path.join(tmpdir(), 'ledger-bk-')), copy = mkdtempSync(path.join(tmpdir(), 'ledger-bk2-'));
  try {
    const r1 = writeBackup(x, out, { now: new Date('2026-10-22T02:30:00Z'), keep: 2, verdict: v, copyTo: copy });
    assert.ok(['ledger.json', 'people.csv', 'ledger.csv', 'pool_equity.csv', 'audit_log.csv', 'summary.json'].every((f) => r1.files.includes(f) && ex(path.join(r1.dir, f))));
    assert.deepEqual(JSON.parse(rd(path.join(r1.dir, 'ledger.json'), 'utf8')).checks, x.checks);              // the saved file is the export
    const head = rd(path.join(r1.dir, 'ledger.csv'), 'utf8').split('\r\n');
    assert.equal(head.length - 2, x.ledger.length); assert.ok(head[0].startsWith('id,ts,profile_id,kind'));   // header + one line per entry (+ trailing newline)
    assert.ok(!/pass_hash/.test(rd(path.join(r1.dir, 'people.csv'), 'utf8')));
    assert.ok(ex(path.join(copy, path.basename(r1.dir), 'ledger.json')));                                     // second copy made
    assert.equal(latestSummary(out).ledger_rows, x.checks.ledger_rows);
    writeBackup(x, out, { now: new Date('2026-10-23T02:30:00Z'), keep: 2, verdict: v });
    const r3 = writeBackup(x, out, { now: new Date('2026-10-24T02:30:00Z'), keep: 2, verdict: v });
    assert.deepEqual(ls(out).sort(), ['ledger-2026-10-23_023000', 'ledger-2026-10-24_023000']);               // only the newest 2 kept
    assert.equal(r3.pruned.length, 1);
  } finally { rm(out, { recursive: true, force: true }); rm(copy, { recursive: true, force: true }); }
});

test('backup checks catch a damaged or shrinking backup', async () => {
  const { db, A, ids } = await world();
  await call(db, 'admin_receive_deposit', A, ids.raf, 100, 56, 5600); await reading(db, A);
  const x = await call(db, 'admin_export_all', A);
  assert.deepEqual(verify(x).problems, []);
  const cut = structuredClone(x); cut.ledger.pop();
  assert.ok(verify(cut).problems.some((p) => /ledger rows/.test(p)));                                          // a row went missing
  const off = structuredClone(x); off.ledger[0].units = Number(off.ledger[0].units) + 1; off.checks.ledger_rows = off.ledger.length;
  assert.ok(verify(off).problems.some((p) => /units/.test(p)));                                                // numbers no longer add up
  const leak = structuredClone(x); leak.people[0].pass_hash = '$2a$04$abc'; assert.ok(verify(leak).problems.some((p) => /password hash/.test(p)));
  assert.ok(verify({ format: 'something else' }).problems.length);
  assert.ok(verify(x, { ledger_rows: x.checks.ledger_rows + 5, equity_rows: x.checks.equity_rows }).warnings.some((w) => /reset/.test(w)));   // fewer rows than last time
  assert.equal(csvRows([]), '\r\n'); assert.equal(csvRows([{ a: 'x,y', b: { k: 1 } }]), 'a,b\r\n"x,y","{""k"":1}"\r\n');
});

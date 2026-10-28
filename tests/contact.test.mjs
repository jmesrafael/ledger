// Investor contact details (20261110000000_contact_details.sql) on the full migration chain (applied + pending), in-memory Postgres,
// every call as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];

async function world() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; update public.ledger_settings set value = '0' where key = 'lock_months'; update public.ledger_settings set value = '1000' where key = 'valuation_max_move'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', 0.1);
  const J = (await call('login', 'john', 'john-password')).token, D = (await call('login', 'dino', 'dino-password')).token;
  return { db, call, q, A, ids, J, D };
}

test('an investor saves their own contact details; they are cleaned and read back, and only they and the manager can see them', async () => {
  const w = await world();
  assert.equal(await w.call('my_contact', w.J), null);
  await w.call('set_my_contact', w.J, '  0917   123 4567 ', ' John@Example.COM ', ' Maria Cruz ', '+63 918 765 4321');
  const c = await w.call('my_contact', w.J);
  assert.equal(c.phone, '0917 123 4567'); assert.equal(c.email, 'john@example.com'); assert.equal(c.emergency_name, 'Maria Cruz'); assert.equal(c.emergency_phone, '+63 918 765 4321');
  assert.equal(await w.call('my_contact', w.D), null);                                     // Dino sees only his own, never John's
  await assert.rejects(() => w.call('admin_contacts', w.J), /admin only/);
  await assert.rejects(() => w.call('admin_contact_history', w.J, w.ids.john), /admin only/);
  await assert.rejects(() => w.call('admin_set_contact', w.J, w.ids.dino, '0917 000 0000'), /admin only/);
  await assert.rejects(() => w.db.query('select * from public.contact_details'), /permission denied|must be owner/).catch(() => {});
  await w.db.exec('set role anon');
  await assert.rejects(() => w.db.query('select * from public.contact_details'), /permission denied/);
  await w.db.exec('reset role');
  const all = await w.call('admin_contacts', w.A);
  const john = all.find((x) => x.profile_id === w.ids.john), dino = all.find((x) => x.profile_id === w.ids.dino);
  assert.equal(john.phone, '0917 123 4567'); assert.equal(john.missing, false);
  assert.equal(dino.missing, true); assert.equal(dino.phone, null);                       // the manager can see who still has to add theirs
});

test('bad numbers and emails are refused with a plain message; email and emergency contact are optional', async () => {
  const w = await world();
  await assert.rejects(() => w.call('set_my_contact', w.J, 'abc'), /contact number/);
  await assert.rejects(() => w.call('set_my_contact', w.J, '12345'), /contact number/);
  await assert.rejects(() => w.call('set_my_contact', w.J, '09171234567', 'not-an-email'), /email/);
  await assert.rejects(() => w.call('set_my_contact', w.J, '09171234567', null, 'Maria', null), /both/);
  await assert.rejects(() => w.call('set_my_contact', w.J, '09171234567', null, null, '0918'), /emergency contact number/);
  assert.equal(await w.call('my_contact', w.J), null);                                     // nothing was saved by the failures
  await w.call('set_my_contact', w.J, '09171234567');
  const c = await w.call('my_contact', w.J);
  assert.equal(c.email, null); assert.equal(c.emergency_name, null);
});

test('every change is kept in an append-only history; unchanged saves add nothing; the activity log never holds the values', async () => {
  const w = await world();
  await w.call('set_my_contact', w.J, '09171234567', 'john@example.com');
  await w.call('set_my_contact', w.J, '09171234567', 'john@example.com');                  // same again
  await w.call('set_my_contact', w.J, '09999999999', 'john@example.com');                  // phone changed
  await w.call('admin_set_contact', w.A, w.ids.john, '09999999999', 'john@new.example.com'); // manager changes the email
  const h = await w.call('admin_contact_history', w.A, w.ids.john);
  assert.equal(h.length, 3);
  assert.deepEqual(h.map((x) => x.phone), ['09999999999', '09999999999', '09171234567']);   // newest first
  assert.equal(h[0].changed_by, 'Raf'); assert.equal(h[1].changed_by, 'john');
  await assert.rejects(() => w.q(`update public.contact_history set phone = '1'`), /append-only/);
  await assert.rejects(() => w.q(`delete from public.contact_history`), /append-only/);
  const log = (await w.q(`select detail::text d from public.audit_log where action = 'contact_updated'`)).map((r) => r.d).join(' ');
  assert.ok(log.includes('phone') && log.includes('by_manager'));
  assert.ok(!log.includes('0917') && !log.includes('0999') && !log.includes('example.com'), 'the activity log must not hold the values');
});

test('a "view as" session can look AND change contact details like the person (20261202000200); the history says the manager did it', async () => {
  const w = await world();
  await w.call('set_my_contact', w.J, '09171234567');
  const V = (await w.call('admin_view_as', w.A, w.ids.john)).token;
  assert.equal((await w.call('my_contact', V)).phone, '09171234567');
  await w.call('set_my_contact', V, '09000000000');
  assert.equal((await w.call('my_contact', w.J)).phone, '09000000000');
  const row = (await w.q(`select updated_by from public.contact_details where profile_id = $1`, [w.ids.john]))[0];
  assert.equal(row.updated_by, w.ids.raf, 'the manager is recorded as the one who changed it');
});

test('optional rule: with contact_required_for_withdrawal on, a withdrawal request needs a contact on file', async () => {
  const w = await world();
  await w.call('admin_receive_deposit', w.A, w.ids.john, 1000, 58, 58000, null, null, null, true);
  await w.call('admin_post_equity', w.A, 1000, 58);
  await w.call('set_my_payout', w.J, 'gcash', 'John', '09171234567');
  await w.call('request_withdrawal', w.J, 100, null);                                      // off by default: allowed, nothing breaks for existing investors
  await w.db.exec(`update public.ledger_settings set value = 'on' where key = 'contact_required_for_withdrawal'`);
  await assert.rejects(() => w.call('request_withdrawal', w.J, 100, null), /contact number/);
  await w.call('set_my_contact', w.J, '09171234567');
  await w.call('request_withdrawal', w.J, 100, null);
  assert.equal((await w.q(`select count(*)::int n from public.withdrawal_requests`))[0].n, 2);
});

test('backups carry contact details and history, and the backup coverage check does not flag them', async () => {
  const w = await world();
  await w.call('set_my_contact', w.J, '09171234567', 'john@example.com', 'Maria', '09181112222');
  const x = (await w.q(`select public._export_all() x`))[0].x;
  assert.equal(x.contact_details.length, 1); assert.equal(x.contact_details[0].phone, '09171234567');
  assert.equal(x.contact_history.length, 1);
  const cov = await w.call('admin_backup_coverage', w.A);
  assert.ok(!cov.missing.includes('contact_details') && !cov.missing.includes('contact_history'), JSON.stringify(cov.missing));
});

// Payout methods (20261115000000_payout_methods.sql) on the full migration chain (applied + pending), in-memory Postgres,
// every call as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const QR = '0123abcd-4567-89ab-cdef-0123456789ab.png';

async function world(extraSql = '') {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key, bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  if (extraSql) await db.exec(extraSql);
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  await call('admin_create_user', A, 'john', 'John', 'john-password', 0.2);
  const J = (await call('login', 'john', 'john-password')).token;
  return { db, call, A, J };
}

test('every way of being paid can be saved, read back, and changed; bank and "other" need a name, the others do not', async () => {
  const w = await world();
  await w.call('set_my_payout', w.J, 'gcash', ' John Reyes ', ' 0917 123 4567 ');
  let d = await w.call('my_payout', w.J);
  assert.equal(d.method, 'gcash'); assert.equal(d.account_name, 'John Reyes'); assert.equal(d.account_number, '0917 123 4567'); assert.equal(d.bank_name, null);
  await w.call('set_my_payout', w.J, 'maya', 'John Reyes', '09181234567', 'ignored name');
  d = await w.call('my_payout', w.J); assert.equal(d.method, 'maya'); assert.equal(d.bank_name, null, 'a wallet keeps no bank name');
  await w.call('set_my_payout', w.J, 'gotyme', 'John Reyes', '012345678901');
  assert.equal((await w.call('my_payout', w.J)).method, 'gotyme');
  await assert.rejects(() => w.call('set_my_payout', w.J, 'bank', 'John Reyes', '0012345678'), /name of the bank or e-wallet/);
  await w.call('set_my_payout', w.J, 'bank', 'John Reyes', '0012345678', ' BDO ');
  d = await w.call('my_payout', w.J); assert.equal(d.method, 'bank'); assert.equal(d.bank_name, 'BDO');
  await assert.rejects(() => w.call('set_my_payout', w.J, 'other', 'John Reyes', '0012345678'), /name of the bank or e-wallet/);
  await w.call('set_my_payout', w.J, 'other', 'John Reyes', '0012345678', 'UnionBank');
  d = await w.call('my_payout', w.J); assert.equal(d.method, 'other'); assert.equal(d.bank_name, 'UnionBank');
});

test('a QR image is optional and kept with any method; bad methods, short numbers and bad image names are refused', async () => {
  const w = await world();
  await w.call('set_my_payout', w.J, 'gcash', 'John Reyes', '09171234567', null, QR);
  assert.equal((await w.call('my_payout', w.J)).qr_path, QR);
  await assert.rejects(() => w.call('set_my_payout', w.J, 'paypal', 'John Reyes', '09171234567'), /choose how you want to be paid/);
  await assert.rejects(() => w.call('set_my_payout', w.J, null, 'John Reyes', '09171234567'), /choose how you want to be paid/);
  await assert.rejects(() => w.call('set_my_payout', w.J, 'gcash', 'John Reyes', '12'), /mobile number/);
  await assert.rejects(() => w.call('set_my_payout', w.J, 'gotyme', 'John Reyes', '12'), /account number/);
  await assert.rejects(() => w.call('set_my_payout', w.J, 'gcash', 'J', '09171234567'), /account name/);
  await assert.rejects(() => w.call('set_my_payout', w.J, 'gcash', 'John Reyes', '09171234567', null, '../../etc/passwd.png'), /invalid QR image/);
});

test('running the migration twice is harmless, and the manager sees every method', async () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261115000000_payout_methods.sql', import.meta.url), 'utf8');
  const w = await world(sql);                                      // the migration ran once in the chain and once more here
  await w.call('set_my_payout', w.J, 'maya', 'John Reyes', '09181234567', null, QR);
  const all = await w.call('admin_payouts', w.A);
  assert.equal(all.length, 1); assert.equal(all[0].method, 'maya'); assert.equal(all[0].qr_path, QR);
});

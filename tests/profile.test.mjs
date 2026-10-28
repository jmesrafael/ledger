// Profile page (20261202000000_profile_self_edit.sql): a person changes their own name and username; payout details accept a free-text label (20261115000000).
// Full migration chain (applied + pending), in-memory Postgres, every call as the public "anon" role.
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

test('P1 a person changes their own display name: tidied, 2 to 80 characters, logged as name_changed with themselves as the actor', async () => {
  const w = await world();
  await w.call('set_my_name', w.J, '  John   Lloyd  Berdin ');
  assert.equal((await w.call('my_summary', w.J)).name, 'John Lloyd Berdin');
  await assert.rejects(() => w.call('set_my_name', w.J, ' x '), /2 to 80/);
  await assert.rejects(() => w.call('set_my_name', w.J, 'x'.repeat(81)), /2 to 80/);
  const a = (await w.q(`select actor_id, subject_id, action, detail from public.audit_log where action = 'name_changed' order by id desc limit 1`))[0];
  assert.equal(a.actor_id, w.ids.john); assert.equal(a.subject_id, w.ids.john); assert.equal(a.detail.to, 'John Lloyd Berdin');
  assert.equal((await w.call('my_summary', w.D)).name, 'dino', 'nobody else is renamed');
});

test('P2 a username change needs the current password, follows the table rule, refuses a taken name, signs in under the new name only, and is audited', async () => {
  const w = await world();
  await assert.rejects(() => w.call('change_my_username', w.J, 'wrong-password', 'johnny'), /current password is wrong/);
  for (const bad of ['jo', 'x'.repeat(31), 'has space', 'semi;colon', '', 'a/b']) await assert.rejects(() => w.call('change_my_username', w.J, 'john-password', bad), /3 to 30 characters/, bad);
  await assert.rejects(() => w.call('change_my_username', w.J, 'john-password', ' DINO '), /already taken/);
  assert.equal(await w.call('change_my_username', w.J, 'john-password', '  Johnny.B-2  '), 'johnny.b-2');
  assert.equal((await w.call('my_summary', w.J)).username, 'johnny.b-2');
  assert.equal((await w.call('login', 'john', 'john-password')).ok, false, 'the old name no longer signs in');
  assert.equal((await w.call('login', 'JOHNNY.b-2', 'john-password')).ok, true, 'the new one does, in any letter case');
  assert.equal(await w.call('change_my_username', w.J, 'john-password', 'johnny.b-2'), 'johnny.b-2', 'the same name again is a harmless no-op');
  const a = (await w.q(`select actor_id, subject_id, detail from public.audit_log where action = 'username_changed' order by id desc`));
  assert.equal(a.length, 1, 'only the real change is logged'); assert.equal(a[0].actor_id, w.ids.john); assert.deepEqual(a[0].detail, { from: 'john', to: 'johnny.b-2' });
  assert.equal((await w.call('my_summary', w.D)).username, 'dino');
});

test('P3 the fund manager changes their own name and username too; a session that is only "viewing as" someone cannot change that person', async () => {
  const w = await world();
  await w.call('set_my_name', w.A, 'Raf Boroy');
  assert.equal(await w.call('change_my_username', w.A, 'admin-password-1', 'rafboroy'), 'rafboroy');
  const V = (await w.call('admin_view_as', w.A, w.ids.john)).token;
  await assert.rejects(() => w.call('set_my_name', V, 'Hacked'), /view-only/);
  await assert.rejects(() => w.call('change_my_username', V, 'john-password', 'hacked'), /view-only/);
  assert.equal((await w.call('my_summary', w.J)).username, 'john');
});

test('P4 payout details take a free-text label (GCash, Bank transfer, "BDO bank transfer"), and a too-short label or number is refused', async () => {
  const w = await world();
  await w.call('set_my_payout', w.J, 'BDO bank transfer', 'John Berdin', '1234 5678 90', null, null);
  const p = await w.call('my_payout', w.J);
  assert.equal(p.method, 'BDO bank transfer'); assert.equal(p.account_name, 'John Berdin'); assert.equal(p.account_number, '1234 5678 90');
  await assert.rejects(() => w.call('set_my_payout', w.J, 'x', 'John Berdin', '09171234567', null, null), /how you want to be paid/);
  await assert.rejects(() => w.call('set_my_payout', w.J, 'GCash', 'John Berdin', '12', null, null), /number/);
  assert.equal(await w.call('my_payout', w.D), null);
});

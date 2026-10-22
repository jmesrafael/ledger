// The bot's balance sync (migration 20261031000001_bot_equity_sync.sql), run on the real migrations in an in-memory Postgres.
// Every call goes in as the public "anon" role, exactly like the bot's HTTPS call does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const mig = (f) => { const a = new URL('../supabase/migrations/applied/' + f, import.meta.url); return existsSync(a) ? a : new URL('../supabase/migrations/' + f, import.meta.url); };
const CHAIN = ['20261022000000_ledger.sql', '20261023000000_hide_pool_from_investors.sql', '20261024000001_ledger_corrections.sql',
  '20261025000000_profit_share_10.sql', '20261026000000_pending_deposits.sql', '20261027000000_profit_share_hardening.sql',
  '20261028000000_terms_acceptance.sql', '20261029000000_fund_returns.sql', '20261030000000_net_of_fee_returns.sql',
  '20261031000000_pesos_backup_audit.sql', '20261031000001_bot_equity_sync.sql', '20261101000000_ledger_integrity.sql'];
const KEY = 'a'.repeat(64), HASH = createHash('sha256').update(KEY).digest('hex');

async function world() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; grant usage on schema public to anon, authenticated;`);
  for (const f of CHAIN) await db.exec(readFileSync(mig(f), 'utf8'));
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  await db.exec(`update public.ledger_settings set value = '1000' where key = 'valuation_max_move'`);
  await db.exec(`insert into public.ledger_settings(key, value) values ('bot_key_hash', '${HASH}') on conflict (key) do update set value = excluded.value`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const A = (await db.query(`select public.login('raf', 'admin-password-1') as r`)).rows[0].r.token;
  const raf = (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id;
  await db.query(`select public.admin_deposit($1, $2, 100, null, 56, 5600, 'own capital')`, [A, raf]);   // owner call, like the seed script
  return { db, A };
}
const bot = async (db, key, eq) => {
  await db.exec('set role anon');
  try { return (await db.query(`select public.bot_post_equity($1, $2) as r`, [key, eq])).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const noWait = (db) => db.exec(`update public.ledger_settings set value = '0' where key = 'bot_min_minutes'`);
const lastRow = async (db) => (await db.query(`select * from public.pool_equity order by id desc limit 1`)).rows[0];

test('a good reading is recorded as a normal equity update and moves the unit price', async () => {
  const { db } = await world(); await noWait(db);
  const r = await bot(db, KEY, 104);
  assert.equal(r.ok, true); assert.equal(Number(r.unit_price), 1.04);
  const row = await lastRow(db);
  assert.equal(row.kind, 'update'); assert.equal(Number(row.equity_usdt), 104); assert.equal(Number(row.unit_price), 1.04); assert.equal(Number(row.total_units), 100);
});

test('wrong, empty or missing key is refused and writes nothing', async () => {
  const { db } = await world(); await noWait(db);
  const before = (await db.query(`select count(*)::int n from public.pool_equity`)).rows[0].n;
  for (const k of ['b'.repeat(64), '', null]) await assert.rejects(() => bot(db, k, 104), /not allowed/);
  assert.equal((await db.query(`select count(*)::int n from public.pool_equity`)).rows[0].n, before);
});

test('no key set in the database: nobody gets in, not even with an empty key', async () => {
  const { db } = await world();
  await db.exec(`delete from public.ledger_settings where key = 'bot_key_hash'`);
  await assert.rejects(() => bot(db, KEY, 104), /not allowed/);
  await assert.rejects(() => bot(db, '', 104), /not allowed/);
});

test('the bot cannot read the key hash or other settings, or call the manager functions', async () => {
  const { db } = await world();
  await db.exec('set role anon');
  try {
    await assert.rejects(() => db.query(`select * from public.ledger_settings`));
    await assert.rejects(() => db.query(`select public.admin_post_equity($1, 104)`, [KEY]), /not signed in/);
    await assert.rejects(() => db.query(`select public.admin_close_quarter($1, 104)`, [KEY]), /not signed in/);
  } finally { await db.exec('reset role'); }
});

test('skips instead of misvaluing: too soon, big jump, paused, deposit waiting', async () => {
  const { db, A } = await world();
  assert.match((await bot(db, KEY, 101)).skipped, /too soon/);            // default 10-minute spacing
  await noWait(db);
  const j = await bot(db, KEY, 130);                                      // +30% in one reading: a transfer, not trading
  assert.equal(j.skipped, 'jump');
  assert.equal(Number((await lastRow(db)).equity_usdt), 100);
  assert.equal((await bot(db, KEY, 112)).ok, true);                       // +12%: inside the 15% guard

  await db.exec(`update public.ledger_settings set value = '1' where key = 'bot_sync_paused'`);
  assert.equal((await bot(db, KEY, 113)).skipped, 'paused');
  await db.exec(`update public.ledger_settings set value = '0' where key = 'bot_sync_paused'`);

  const john = await db.query(`select public.admin_create_user($1, 'john', 'John', 'john-password', 0.1) as id`, [A]);
  await db.query(`select public.admin_receive_deposit($1, $2, 50, 56, 2800, null)`, [A, john.rows[0].id]);
  assert.match((await bot(db, KEY, 113)).skipped, /deposit is waiting/);
  await db.query(`select public.admin_post_equity($1, 163)`, [A]);        // manager's own reading converts the waiting deposit
  assert.equal((await bot(db, KEY, 164)).ok, true);                       // and the bot carries on
});

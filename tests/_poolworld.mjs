// Shared by tests/pool-update.test.mjs and scripts/staging-flow.mjs: the FULL migration chain (applied/* then the pending migrations, which include
// the pool-update migration) on an in-memory Postgres (PGlite). Nothing here can reach a real database: there is no network and no credential.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const BOOT = `create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`;
export const BOT_KEY = 'b'.repeat(64);

export async function freshDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(BOOT);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  return db;
}

export async function world() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(BOOT);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; update public.ledger_settings set value = '1000' where key = 'valuation_max_move';
    update public.ledger_settings set value = '0' where key = 'min_days_between_closes'; update public.ledger_settings set value = 'on' where key = 'workflow_gate';
    insert into public.ledger_settings(key, value) values ('bot_key_hash', '${createHash('sha256').update(BOT_KEY).digest('hex')}') on conflict (key) do update set value = excluded.value`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino', 'eve']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', 0.1);
  const w = { db, call, q, A, ids };
  w.J = (await call('login', 'john', 'john-password')).token;
  await call('set_my_payout', w.J, 'gcash', 'John', '09171234567');
  w.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[who]]))[0].u);
  w.tu = async () => Number((await q(`select coalesce(sum(units),0) u from public.ledger`))[0].u);
  w.price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  w.nav = async () => Number((await q(`select equity_usdt p from public.pool_equity order by id desc limit 1`))[0].p);
  w.poolRows = async () => Number((await q(`select count(*) n from public.pool_equity`))[0].n);
  // a closed trade as the bot dashboard stores it. o.mode 'paper' for paper trades; o.ts = event time (ms)
  w.exit = (id, usd, o = {}) => db.query(`insert into public.bot_events(event_id, type, ts_ms, mode, symbol, side, data) values ($1, 'exit', $2, $3, 'SOL_USDT', 'LONG', $4::jsonb)`,
    [id, o.ts ?? Date.now() - 120000, o.mode ?? 'live', JSON.stringify({ trade_id: 't-' + id, usd, r: o.r === undefined ? usd / 100 : o.r, reason: 'tp' })]);
  w.pending = () => call('admin_pending_pnl', A);
  w.enter = (t, pos = 0) => call('admin_enter_balance', A, t, pos, 0, null, null);
  w.confirm = (id) => call('admin_confirm_balance', A, id, null);
  w.check = async (t, pos = 0) => { const v = await w.enter(t, pos); await w.confirm(v.id); return v.id; };
  w.arrive = async (who, usdt) => {
    const pd = (await call('admin_receive_deposit', A, ids[who], usdt, 58, null, null)).id;
    await call('admin_confirm_arrival', A, pd, 'seen in the exchange deposit history', null);
    return pd;
  };
  w.seed = async (usdt = 1000) => {
    const pd = await w.arrive('john', usdt); const v = await w.check(usdt);
    await call('admin_admit_deposit', A, pd, v, null, false);
  };
  // Update Pool with exactly what the screen shows
  w.update = async (vid, o = {}) => {
    const p = await w.pending();
    return call('admin_update_pool', A, vid, o.ids ?? p.ids, o.usd ?? p.usd, o.idem ?? null, o.confirm ?? false, o.note ?? null);
  };
  w.snap = (eq, pos = 0, ord = 0, extra = {}) => call('bot_post_snapshot', BOT_KEY, eq, pos, ord, extra.unrealized ?? 0, extra.realized ?? 0, JSON.stringify(extra.transfers ?? []), extra.complete ?? true);
  return w;
}


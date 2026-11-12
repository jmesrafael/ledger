// Shared world for the true-value tests (tests/true-value-db.test.mjs, tests/true-value-lifecycle.test.mjs): an in-memory Postgres with every migration, three bot wallets,
// raf (manager), john and dino (investors), helpers to post wallet reports, receive deposits and post closed trades. The clock starts 3 h in the past.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
export const TV = createRequire(import.meta.url)('../lib/truevalue.js');

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
export const CORRECTIONS = new URL('../supabase/corrections/20261107_prepare_book_corrections.sql', import.meta.url);
export const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(Number(a) - b) <= eps, `${msg} ${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, now()) $$;`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const WALLETS = ['bbcore', 'icore', 'tcore'];

// exclude: migration files to leave out (substring of the name), e.g. the production chain without 20261209000000_admission_spread.sql
export async function world({ rate = 0.2, exclude = [] } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) if (!exclude.some((x) => f.pathname.includes(x))) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(CLOCK_SQL);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', settlement_schedule: 'free', pool_update_gate: 'on', wallet_expected_count: '3', auto_pool_mode: 'trades' };
  for (const [k, v] of Object.entries(set)) await db.query(`insert into public.ledger_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', rate);
  const keys = Object.fromEntries(WALLETS.map((w) => [w, randomBytes(32).toString('hex')]));
  for (const w of WALLETS) await db.query(`insert into public.bot_wallets(wallet, label, key_hash) values ($1, $1, $2)`, [w, sha(keys[w])]);
  const w = { db, call, q, A, ids, keys, seq: Object.fromEntries(WALLETS.map((x) => [x, 0])), now: Date.now(), day: 0 };
  w.clock = async (ms) => { w.now = ms; await db.query(`select set_config('test.clock', $1, false)`, [new Date(ms).toISOString()]); };
  await w.clock(Date.now() - 3 * 3600e3);   // 3 h in the past: the tests move the clock forward, and entries may not be dated in the (real) future
  w.d = () => new Date(Date.UTC(2026, 2, 1 + w.day++, 4)).toISOString();
  w.mode = (k, v) => db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  w.pool = async () => (await q(`select equity_usdt::float e, unit_price::float p, total_units::float u, ts from public.pool_equity order by id desc limit 1`))[0];
  w.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[who]]))[0].u);
  // the first units, the plain way (before true value is switched on): raf (or another) joins at price 1
  w.join = async (who, usdt) => {
    await call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, w.d(), null, true);
    const pend = Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
    const p = (await q(`select 1 from public.pool_equity limit 1`)).length ? await w.pool() : null;
    return call('admin_post_equity', A, p ? p.e + pend : usdt, 58, null, w.d());
  };
  // one report per wallet: total cash + open P&L split 50/25/25 (or explicit per wallet), received now
  w.report = async (cash, open, o = {}) => {
    for (const [i, x] of WALLETS.entries()) {
      const s = [0.5, 0.25, 0.25][i], c = o[x] || {};
      const eq = c.eq ?? (cash + open) * s, unr = c.unr ?? open * s;
      await call('bot_post_wallet_snapshot', keys[x], x, ++w.seq[x], new Date(w.now).toISOString(), +eq.toFixed(6), +unr.toFixed(6), +(c.wd ?? eq - unr).toFixed(6), +(c.wd ?? eq - unr).toFixed(6), c.pos ?? (Math.abs(unr) > 0 ? 1 : 0), 0);
    }
  };
  w.receive = async (who, usdt) => {
    await call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, new Date(w.now - 60000).toISOString(), null, true);
    return Number((await q(`select max(id) i from public.pending_deposits`))[0].i);
  };
  w.trade = (o) => call('bot_post_closed_trade', keys[o.wallet ?? 'bbcore'], o.wallet ?? 'bbcore', o.pos, o.sym ?? 'SOL_USDT', o.side ?? 'LONG',
    o.at ?? new Date(w.now - 60000).toISOString(), o.pnl, null, null, null);
  w.status = () => call('admin_true_value', A);
  return w;
}
export const adv = async (w, min) => w.clock(w.now + min * 60000);
// a pool of 1000 USDT, raf holds it all at price 1; true value switched on
export async function ready(opts) {
  const w = await world(opts);
  await w.join('raf', 1000);
  await adv(w, 5);
  await w.mode('flow_pricing', 'true_value');
  return w;
}


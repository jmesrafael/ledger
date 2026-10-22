// Shared test world: the real migrations on an in-memory Postgres (PGlite + pgcrypto). Every call is made as the public "anon" role,
// like the website. build({ integrity: false }) stops before the integrity migration, so a test can show the ORIGINAL behaviour.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const mig = (f) => { const a = new URL('../supabase/migrations/applied/' + f, import.meta.url); return existsSync(a) ? a : new URL('../supabase/migrations/' + f, import.meta.url); };
export const OLD_CHAIN = ['20261022000000_ledger.sql', '20261023000000_hide_pool_from_investors.sql', '20261024000001_ledger_corrections.sql',
  '20261025000000_profit_share_10.sql', '20261026000000_pending_deposits.sql', '20261027000000_profit_share_hardening.sql',
  '20261028000000_terms_acceptance.sql', '20261029000000_fund_returns.sql', '20261030000000_net_of_fee_returns.sql',
  '20261031000000_pesos_backup_audit.sql', '20261031000001_bot_equity_sync.sql'];
export const INTEGRITY = '20261101000000_ledger_integrity.sql';
export const BOT_KEY = 'b'.repeat(64);
export const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - b) <= eps;
export const r6 = (x) => Math.round(Number(x) * 1e6) / 1e6;

export async function build({ integrity = true, rate = 0.1, gap = 0, maxMove = null, users = ['john', 'dino', 'eve'] } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; grant usage on schema public to anon, authenticated;`);
  for (const f of OLD_CHAIN) await db.exec(readFileSync(mig(f), 'utf8'));
  const seedAfterOld = async () => {
    await db.exec(`update public.ledger_settings set value = '${gap}' where key = 'min_days_between_closes'; update public.ledger_settings set value = '4' where key = 'bcrypt_cost';`);
    await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  };
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const ctx = { db, call, q };
  ctx.migrateIntegrity = async () => {
    await db.exec(readFileSync(mig(INTEGRITY), 'utf8'));
    if (maxMove !== null) await db.exec(`update public.ledger_settings set value = '${maxMove}' where key = 'valuation_max_move'`);
    await db.exec(`insert into public.ledger_settings(key, value) values ('bot_key_hash', '${createHash('sha256').update(BOT_KEY).digest('hex')}') on conflict (key) do update set value = excluded.value`);
  };
  await seedAfterOld();
  ctx.A = (await call('login', 'raf', 'admin-password-1')).token;
  ctx.ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of users) ctx.ids[u] = await call('admin_create_user', ctx.A, u, u, u + '-password', rate);
  if (integrity) {
    await ctx.migrateIntegrity();
    if (maxMove !== null) await db.exec(`update public.ledger_settings set value = '${maxMove}' where key = 'valuation_max_move'`);
  }
  await db.exec(`insert into public.ledger_settings(key, value) values ('bot_key_hash', '${createHash('sha256').update(BOT_KEY).digest('hex')}') on conflict (key) do update set value = excluded.value`);
  ctx.tok = async (u) => (await call('login', u, u + '-password')).token;
  ctx.h = async (who) => (await call('admin_overview', ctx.A)).find((x) => x.id === ctx.ids[who]);
  ctx.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ctx.ids[who]]))[0].u);
  ctx.tu = async () => Number((await q(`select coalesce(sum(units),0) u from public.ledger`))[0].u);
  ctx.price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  ctx.equity = async () => Number((await q(`select equity_usdt p from public.pool_equity order by id desc limit 1`))[0].p);
  ctx.pend = async () => Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
  // the person's net trading profit so far in the current period (USDT), and what a withdrawal has already settled
  ctx.periodProfit = async (who) => Number((await q(`select public._period_profit($1, public._last_close(null), (select max(id) from public.pool_equity)) as v`, [ctx.ids[who]]))[0].v);
  ctx.credit = async (who) => Number((await q(`select public._period_credit($1) as v`, [ctx.ids[who]]))[0].v);
  ctx.lotUnits = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.holder_lots where profile_id=$1`, [ctx.ids[who]]))[0].u);
  // owner-only: move every lock-up into the past (tests withdrawals without waiting 3 months)
  ctx.unlockAll = async () => {
    await db.exec(`alter table public.ledger disable trigger ledger_append_only; update public.ledger set lock_until = current_date - 1 where lock_until is not null; alter table public.ledger enable trigger ledger_append_only;`);
  };
  // join: money received, then the valuation that turns it into units (a fresh pool starts at price 1)
  ctx.join = async (who, usdt, mexcTotal) => {
    await call('admin_receive_deposit', ctx.A, ctx.ids[who], usdt, 58, usdt * 58, null);
    return call('admin_post_equity', ctx.A, mexcTotal);
  };
  ctx.botSnap = (eq, pos, ord, extra = {}) => call('bot_post_snapshot', BOT_KEY, eq, pos, ord, extra.unrealized ?? 0, extra.realized ?? 0, JSON.stringify(extra.transfers ?? []), extra.complete ?? true);
  return ctx;
}

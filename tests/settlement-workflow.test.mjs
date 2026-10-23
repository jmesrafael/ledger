// The manager's two-month routine on the FULL migration chain as it runs in production (applied/*) plus the pending migrations:
// type the MEXC balance, explain the difference, confirm it, settle. In-memory Postgres (PGlite); calls go in as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);
const BOOT = `create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`;

async function fresh() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(BOOT);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  return db;
}

async function world() {
  const db = await fresh();
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; update public.ledger_settings set value = '1000' where key = 'valuation_max_move';`);
  // these tests settle on the real date for a period that ended weeks ago: they are about the balance-check routine, not the window (tests/risk-fixes.test.mjs covers the window)
  await db.exec(`update public.ledger_settings set value = '3650' where key = 'settlement_window_days'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', 0.1);
  const at = (d) => `2026-${d}T04:00:00Z`;
  const w = { db, call, q, A, ids, at };
  w.navNow = async () => Number((await q(`select equity_usdt e from public.pool_equity order by id desc limit 1`))[0]?.e ?? 0);
  w.price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  w.total = async (p) => (await w.navNow()) / (await w.price()) * p;                  // MEXC total that puts the unit price at p
  // history before today, entered the old way (workflow_gate is off in production)
  w.join = async (who, usdt, d) => {
    await call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, at(d), null, true);
    const first = (await q(`select count(*)::int n from public.pool_equity`))[0].n === 0;
    return call('admin_post_equity', A, first ? usdt : (await w.total(await w.price())) + usdt, 58, null, at(d));
  };
  w.reading = async (p, d) => call('admin_post_equity', A, await w.total(p), 58, null, at(d));
  // today: the manager's balance check (type, explain, confirm)
  w.check = async (t) => {
    const v = await call('admin_enter_balance', A, t, 0, 0, 'read on MEXC app', null);
    if (Math.abs(Number(v.residual)) > 0) await call('admin_classify_difference', A, v.id, 'trading_pnl', 'two months of closed trades per the bot log');
    await call('admin_confirm_balance', A, v.id, null);
    return v.id;
  };
  return w;
}

// Jul-Aug: Raf puts in 500 of his own, John 1000; Dino joins at 1.20; the period ends at 1.32
async function twoMonths(w) {
  await w.join('raf', 500, '07-03');
  await w.join('john', 1000, '07-05');
  await w.reading(1.2, '08-01');
  await w.join('dino', 600, '08-10');                                    // 500 units at 1.20
  return w.total(1.32);
}

test('the two-month routine: a confirmed balance check settles the period; each person\'s profit and Raf\'s fee are saved apart', async () => {
  const w = await world();
  const t = await twoMonths(w);
  const vid = await w.check(t);
  const pv = await w.call('admin_settlement_preview', w.A, t, null);
  assert.equal(pv.can_settle, true, JSON.stringify(pv.blocked_reasons)); assert.equal(pv.recon.status, 'verified_manual');
  const s = await w.call('admin_settle_quarter', w.A, vid, 58, 'Jul-Aug', 'set-1', false);
  assert.equal(s.recon_status, 'verified_manual'); assert.equal(Number(s.balance_verification_id), vid);
  near(s.fee_usdt, 32 + 6, 1e-5);                                        // 10% of John's 320 and of Dino's 60
  const [row] = await w.call('admin_settlements', w.A);
  assert.equal(Number(row.balance_verification_id), vid);
  const L = Object.fromEntries(row.lines.map((l) => [l.profile_id, l]));
  near(L[w.ids.john].period_profit_usdt, 320, 1e-5); near(L[w.ids.john].fee_usdt, 32, 1e-5);
  near(L[w.ids.dino].period_profit_usdt, 60, 1e-5);  near(L[w.ids.dino].fee_usdt, 6, 1e-5);
  assert.equal(L[w.ids.raf], undefined);                                 // the manager is not charged
  const P = row.fund_m.period;
  near(P.own_investment_profit_usdt, 160, 1e-5);                         // Raf's own 500 x 0.32
  near(P.fee_earned_usdt, 38, 1e-5); near(P.fee_at_settlement_usdt, 38, 1e-5);
  near(row.fund_m.capital.contributed_usdt, 500); near(row.fund_m.fee_entitlement.earned_usdt, 38, 1e-5);
  // the preview said the same before anything was saved
  near(pv.fee_usdt, 38, 1e-5); near(pv.fund_m.period.own_investment_profit_usdt, 160, 1e-5);
  near(pv.lines.find((l) => l.profile_id === w.ids.john).period_profit_usdt, 320, 1e-5);
});

test('no double processing: a retry replays, a second settlement in the same period is refused, the check cannot be reused', async () => {
  const w = await world();
  const vid = await w.check(await twoMonths(w));
  const a = await w.call('admin_settle_quarter', w.A, vid, 58, null, 'set-1', false);
  const b = await w.call('admin_settle_quarter', w.A, vid, 58, null, 'set-1', false);
  assert.equal(b.replayed, true); near(a.fee_units, b.fee_units);
  await assert.rejects(() => w.call('admin_settle_quarter', w.A, vid, 58, null, 'set-2', false), /already settled/);
  const vid2 = await w.check(await w.total(1.32));
  await assert.rejects(() => w.call('admin_settle_quarter', w.A, vid2, 58, null, 'set-3', false), /already settled; the next settlement is allowed from/);
  assert.equal((await w.q(`select count(*)::int n from public.settlements`))[0].n, 1);
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind = 'fee_in'`))[0].n, 2);
});

test('without a confirmed balance check (or a written explanation) nothing is settled', async () => {
  const w = await world();
  const t = await twoMonths(w);
  await assert.rejects(() => w.call('admin_close_quarter', w.A, t, 58, null, null, null, false), /RECONCILE: .*Enter and confirm this MEXC balance/);
  const v = await w.call('admin_enter_balance', w.A, t, 0, 0, null, null);    // typed but not confirmed
  await assert.rejects(() => w.call('admin_close_quarter', w.A, t, 58, null, null, null, false), /RECONCILE/);
  await w.check(t + 40);                                                      // confirmed, but for another number
  await assert.rejects(() => w.call('admin_close_quarter', w.A, t, 58, null, null, null, false), /RECONCILE/);
  assert.equal((await w.q(`select count(*)::int n from public.settlements`))[0].n, 0);
  assert.ok(v.id);
});

test('deposits and withdrawals in the period never show up as profit', async () => {
  const w = await world();
  await w.join('john', 1000, '07-05');
  await w.reading(1.1, '07-20');
  await w.call('admin_withdraw', w.A, w.ids.john, 400, await w.total(1.1), 58, null, true, null, w.at('07-21'));   // takes 400 units out at 1.10
  await w.join('john', 330, '07-22');                                                                               // puts 300 units back
  await w.join('dino', 2000, '08-30');                                                                              // big deposit the day before the period ends
  const vid = await w.check(await w.total(1.1));                                                                    // no price move since 07-20
  await w.call('admin_settle_quarter', w.A, vid, 58, null, null, false);
  const L = Object.fromEntries((await w.call('admin_settlements', w.A))[0].lines.map((l) => [l.profile_id, l]));
  near(L[w.ids.john].period_profit_usdt, 100, 1e-5);       // only the 1.00 -> 1.10 move on his 1000 units
  near(L[w.ids.dino].period_profit_usdt, 0, 1e-6); near(L[w.ids.dino].fee_usdt, 0);
  const total = Number(L[w.ids.john].fee_usdt) + Number((await w.q(`select coalesce(sum(usdt),0) s from public.ledger where kind='fee_in' and note like '%withdrawal%'`))[0].s);
  near(total, 10, 1e-5);                                    // 10% of 100, split between the withdrawal and the settlement
});

test('backups carry every table (settlements, marks, balance checks) and restore into an empty database with identical numbers', async () => {
  const w = await world();
  const vid = await w.check(await twoMonths(w));
  await w.call('admin_settle_quarter', w.A, vid, 58, null, null, false);
  const x = (await w.q(`select public._export_all() x`))[0].x;
  for (const k of ['settlements', 'settlement_lines', 'investor_hwm', 'hwm_log', 'balance_verifications', 'capital_events', 'position_snapshots', 'ledger', 'pool_equity'])
    assert.ok(Array.isArray(x[k]) && (k === 'hwm_log' || k === 'position_snapshots' || x[k].length > 0), `backup is missing ${k}`);
  // restore: replay every table into a new database built from the same migrations
  const db2 = await fresh();
  await db2.exec(`set session_replication_role = replica; delete from public.ledger_settings;`);
  const order = ['settings', 'people', 'pool_equity', 'ledger', 'pending_deposits', 'withdrawal_requests', 'investor_hwm', 'hwm_log', 'exchange_snapshots',
    'balance_verifications', 'verification_adjustments', 'capital_events', 'payout_records', 'position_snapshots', 'settlement_attestations', 'settlements', 'settlement_lines', 'terms_acceptances'];
  const table = { settings: 'ledger_settings', people: 'profiles' };
  for (const k of order) {
    const rows = k === 'people' ? x[k].map((r) => ({ ...r, pass_hash: 'restored: set a new password', failed_attempts: 0 })) : x[k];
    if (!rows || !rows.length) continue;
    await db2.query(`insert into public.${table[k] || k} select * from jsonb_populate_recordset(null::public.${table[k] || k}, $1::jsonb)`, [JSON.stringify(rows)]);
  }
  await db2.exec(`set session_replication_role = origin`);
  const y = (await db2.query(`select public._export_all() x`)).rows[0].x;
  for (const k of ['ledger', 'pool_equity', 'settlements', 'settlement_lines', 'investor_hwm', 'balance_verifications']) assert.deepEqual(y[k], x[k], k);
  assert.deepEqual({ ...y.checks }, { ...x.checks });
  const hs = async (d) => (await d.query(`select p.username, (public._holder_summary(p.id)->>'value_usdt')::numeric v, case when p.role = 'investor' then public._hwm_value(p.id) end h from public.profiles p order by 1`)).rows.map((r) => [r.username, Number(r.v), r.h == null ? null : Number(r.h)]);
  assert.deepEqual(await hs(db2), await hs(w.db));
});

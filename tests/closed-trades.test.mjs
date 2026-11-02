// Closed trades -> ledger (migration 20261203000000_closed_trades_auto_pool.sql) on an in-memory Postgres (PGlite), every call as anon. Nothing talks to MEXC or Supabase.
//   CT1 exactly once, append-only  CT2 off by default  CT3 end to end  CT4 trade waits for the next report  CT5 joiner/leaver fairness  CT6 gates  CT7 random sequence
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(Number(a) - b) <= eps, `${msg} ${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, now()) $$;`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const T0 = Date.parse('2026-03-10T00:00:00Z');

async function world({ rate = 0.2, settings = {} } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(CLOCK_SQL);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', settlement_schedule: 'free', pool_update_gate: 'on', ...settings };
  for (const [k, v] of Object.entries(set)) await db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', rate);
  const keys = { bbcore: randomBytes(32).toString('hex'), icore: randomBytes(32).toString('hex') };
  await db.query(`insert into public.bot_wallets(wallet, label, key_hash) values ('bbcore', 'BB-Core', $1), ('icore', 'I-Core', $2)`, [sha(keys.bbcore), sha(keys.icore)]);
  const w = { db, call, q, A, ids, keys, seq: { bbcore: 0, icore: 0 }, now: T0, day: 0 };
  w.clock = async (ms) => { w.now = ms; await db.query(`select set_config('test.clock', $1, false)`, [new Date(ms).toISOString()]); };
  await w.clock(T0);
  const pend = async () => Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
  w.pool = async () => (await q(`select equity_usdt::float e, unit_price::float p, total_units::float u from public.pool_equity order by id desc limit 1`))[0];
  w.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[who]]))[0].u);
  w.pend = pend;
  w.d = () => new Date(Date.UTC(2026, 2, 1 + w.day++, 4)).toISOString();     // strictly increasing entry dates, all before the test clock
  // one wallet's report; eq = equity (unrealized included), wd = cashBalance (default: all of it), av = availableBalance (default: wd)
  w.snap = (wallet, o = {}) => {
    const eq = o.eq, wd = o.wd ?? eq, seq = o.seq ?? ++w.seq[wallet], dflt = (v, d) => (v === undefined ? d : v);   // an explicit null is sent as null (not replaced)
    return call('bot_post_wallet_snapshot', o.key ?? keys[wallet], o.wallet ?? wallet, seq, o.rep ?? new Date(w.now).toISOString(), eq, dflt(o.unr, 0), wd, dflt(o.av, wd), dflt(o.pos, 0), dflt(o.ord, 0));
  };
  w.both = async (a, b) => { await w.snap('bbcore', a); await w.snap('icore', b); };
  // join through the plain (pre-wallet) path: this is how the pool gets its first units, before the wallet mode is switched on
  w.join = async (who, usdt) => {
    await call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, w.d(), null, true);
    const p = (await q(`select 1 from public.pool_equity limit 1`)).length ? await w.pool() : null;
    return call('admin_post_equity', A, p ? p.e + (await pend()) : usdt, 58, null, w.d());
  };
  w.mode = (k, v) => db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  w.nav = () => call('admin_wallet_nav', A);
  w.trace = async () => (await q(`select (select count(*)::int from public.pool_equity) e, (select count(*)::int from public.ledger) l, (select count(*)::int from public.withdrawal_requests) r,
    (select count(*)::int from public.payout_records) p`))[0];
  return w;
}

const trade = (w, o = {}) => w.call('bot_post_closed_trade', o.key ?? w.keys[o.wallet ?? 'bbcore'], o.wallet ?? 'bbcore', o.pos ?? '1001', o.sym ?? 'SOL_USDT', o.side ?? 'LONG',
  o.at ?? new Date(w.now - 60000).toISOString(), o.pnl ?? 10, o.fees ?? null, o.fund ?? null, o.r ?? null);
const runs = (w) => w.q(`select * from public.auto_pool_runs order by id`);
async function ready() {
  const w = await world();
  await w.join('john', 1000);
  await w.both({ eq: 1000 }, { eq: 0 });
  await w.mode('wallet_nav_mode', 'require'); await w.mode('auto_pool_mode', 'on');
  return w;
}
const adv = async (w, min) => w.clock(w.now + min * 60000);
const both = async (w, a, b = 0) => { await w.snap('bbcore', { eq: a }); return w.snap('icore', { eq: b }); };

test('CT1 exactly once: replay is harmless, other figures refused, wrong key refused, append-only', async () => {
  const w = await ready();
  const a = await trade(w, { pnl: 12.5 });
  assert.equal(a.ok, true); assert.equal(a.replayed, false);
  const b = await trade(w, { pnl: 12.5 });
  assert.equal(b.replayed, true); assert.equal(b.trade_id, a.trade_id);
  await assert.rejects(() => trade(w, { pnl: 13 }), /already recorded with different figures/);
  await assert.rejects(() => trade(w, { key: w.keys.icore }), /not allowed/);
  await assert.rejects(() => trade(w, { pos: '2', pnl: 1.1234567 }), /at most 6 decimals/);
  await assert.rejects(() => trade(w, { pos: '3', at: new Date(w.now + 3600000).toISOString() }), /future/);
  assert.equal((await w.q('select count(*)::int n from public.closed_trades'))[0].n, 1);
  assert.equal((await trade(w, { wallet: 'icore', pos: '1001', pnl: 5 })).replayed, false, 'the same position id on another wallet is another trade');
  await assert.rejects(() => w.db.query(`update public.closed_trades set realized_usd = 99`), /cannot be edited/);
  await assert.rejects(() => w.db.query(`delete from public.closed_trades`), /cannot be deleted/);
  assert.equal((await w.q(`select has_table_privilege('anon', 'public.closed_trades', 'select') as x`))[0].x, false);
});

test('CT2 off by default: a trade and a wallet report move nothing', async () => {
  const w = await world();
  await w.join('john', 1000);
  await w.both({ eq: 1000 }, { eq: 0 });
  await w.mode('wallet_nav_mode', 'require');
  assert.equal((await w.q(`select value from public.ledger_settings where key='auto_pool_mode'`))[0].value, 'off');
  const before = await w.pool();
  await adv(w, 30);
  await trade(w, { pnl: 50 });
  const s = await both(w, 1050);
  assert.equal(s.pool.skipped, 'off');
  assert.deepEqual(await w.pool(), before);
});

test('CT3 end to end: the pool follows the wallets, the trade is included once and explains the change', async () => {
  const w = await ready();
  await adv(w, 30);
  const t = await trade(w, { pnl: 90, at: new Date(w.now - 120000).toISOString() });
  assert.equal(t.pool.skipped, 'unchanged', 'the wallets have not reported since the trade closed: nothing valued yet');
  assert.equal((await w.q('select equity_id from public.closed_trades'))[0].equity_id, null);
  await both(w, 1090);
  assert.equal((await w.q('select count(*)::int n from public.auto_pool_runs'))[0].n, 1);
  const p = await w.pool();
  near(p.e, 1090); near(p.p, 1.09); near(p.u, 1000);
  near(await w.units('john'), 1000);
  const r = (await runs(w))[0];
  assert.equal(r.trades, 1); near(r.realized_usd, 90); near(r.nav_before, 1000); near(r.nav_after, 1090);
  const c = (await w.q('select equity_id, reflected_at from public.closed_trades'))[0];
  assert.ok(c.equity_id && c.reflected_at, 'the trade is linked to the valuation that first included it');
  await adv(w, 300); await both(w, 1090);
  near((await w.pool()).e, 1090);
  assert.equal((await w.q('select count(*)::int n from public.closed_trades where equity_id is not null'))[0].n, 1);
  const view = await w.call('admin_closed_trades', w.A);
  assert.equal(view.waiting.count, 0); near(view.total.realized_usd, 90);
});

test('CT4 a trade that closed after its wallet last reported waits for the next report', async () => {
  const w = await ready();
  await adv(w, 30); await both(w, 1000);
  await adv(w, 2);
  await trade(w, { pnl: 40, at: new Date(w.now - 30000).toISOString() });
  assert.equal((await w.q('select equity_id from public.closed_trades'))[0].equity_id, null);
  await adv(w, 3); await both(w, 1040);
  near((await w.pool()).e, 1040);
  assert.ok((await w.q('select equity_id from public.closed_trades'))[0].equity_id);
});

test('CT5 a later joiner gets none of the earlier profit; a later loss is shared by units; earlier units never change', async () => {
  const w = await ready();
  await adv(w, 30);
  await trade(w, { pnl: 100 });
  await both(w, 1100);                                   // price 1.10
  const johnUnits = await w.units('john');
  await w.mode('wallet_nav_mode', 'off'); await w.mode('auto_pool_mode', 'off');
  await adv(w, 30);
  const dd = () => new Date().toISOString();
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 550, 58, 550 * 58, null, dd(), null, true);
  await both(w, 1650);
  await w.call('admin_post_equity', w.A, 1650, 58, null, dd());
  await w.mode('wallet_nav_mode', 'require'); await w.mode('auto_pool_mode', 'on');
  near(await w.units('dino'), 500, 1e-6); near((await w.pool()).p, 1.1);
  await adv(w, 30);
  await trade(w, { pos: '2002', pnl: -150, at: new Date(w.now - 120000).toISOString() });
  await both(w, 1500);
  const p = await w.pool(); near(p.e, 1500); near(p.p, 1);
  near(await w.units('john'), johnUnits, 1e-9, 'units never change with trading');
  near((await w.units('john')) * p.p, 1000); near((await w.units('dino')) * p.p, 500);     // -150 split 2:1 by units (john -100, dino -50)
});

test('CT6 gates: skipped with a reason, nothing saved', async () => {
  const w = await ready();
  await adv(w, 30);
  await trade(w, { pnl: 5 });
  await w.mode('wallet_nav_mode', 'off');
  assert.equal((await w.snap('bbcore', { eq: 1005 })).pool.skipped, 'needs_wallet_mode');
  await w.mode('wallet_nav_mode', 'require');
  await w.mode('bot_sync_paused', '1');
  assert.equal((await w.snap('bbcore', { eq: 1005 })).pool.skipped, 'paused');
  await w.mode('bot_sync_paused', '0');
  await adv(w, 45);
  assert.equal((await w.snap('bbcore', { eq: 1005 })).pool.skipped, 'wallets_not_ready');          // icore is stale
  const j = await w.snap('icore', { eq: 0 });                                          // both fresh again: the first valid run values it
  assert.equal(j.pool.ok, true);
  near((await w.pool()).e, 1005);
  // a 30% move (under the wallet's own 50% suspect limit, over the pool's 15%) is skipped and logged
  await adv(w, 20); await trade(w, { pos: '77', pnl: 5 }); await adv(w, 1);
  await w.snap('icore', { eq: 0 });
  const jump = await w.snap('bbcore', { eq: 1310 });
  assert.equal(jump.pool.skipped, 'jump');
  assert.ok((await w.q(`select 1 from public.pool_recon_log where source = 'auto_pool' and detail->>'mismatch' = 'jump'`)).length === 1, 'the skip is logged');
  near((await w.pool()).e, 1005, 1e-9, 'the pool did not move on a skipped run');
  assert.equal((await w.q('select count(*)::int n from public.closed_trades where equity_id is null'))[0].n, 1, 'the trade still waits');
});

test('CT7 many trades and reports: books balance, every trade included exactly once', async () => {
  const w = await ready();
  const rand = rng(7); let eq = 1000, id = 5000, total = 0;
  for (let i = 0; i < 40; i++) {
    await adv(w, 20);
    if (rand() < 0.6) { const pnl = Math.round((rand() - 0.45) * 60 * 100) / 100; total += pnl; eq += pnl; await trade(w, { pos: String(id++), pnl, at: new Date(w.now - 90000).toISOString() }); }
    await adv(w, 1);
    await both(w, Math.round(eq * 1e6) / 1e6);
  }
  await adv(w, 300); await both(w, Math.round(eq * 1e6) / 1e6);
  assert.equal((await w.q('select count(*)::int n from public.closed_trades where equity_id is null'))[0].n, 0);
  assert.equal((await w.q('select count(*)::int n from public.closed_trades'))[0].n, id - 5000);
  const p = await w.pool(); near(p.e, eq, 1e-4); near(p.p * p.u, p.e, 1e-4);
  near((await runs(w)).reduce((s, r) => s + Number(r.realized_usd), 0), total, 1e-4, 'the runs account for every trade once');
  assert.equal((await w.q('select count(*)::int n from public.auto_pool_runs where residual_flag'))[0].n, 0, 'trades + unrealized explain every change');
  near(await w.units('john'), 1000);
});

// ---- trades mode (migration 20261204000000_auto_pool_trades_mode.sql): the pool = last booked value + the realized P&L of the trades closed since
async function rolling() {
  const w = await world();
  await w.join('john', 1000);
  await w.mode('auto_pool_mode', 'trades'); await w.clock(Date.now());   // the pool rows carry the real time (_at), so the test clock must too
  return w;
}

test('CT8 trades mode: last booked value + realized P&L, every trade once, no wallet needed', async () => {
  const w = await rolling();
  await adv(w, 30);
  const t = await trade(w, { pos: 'a', pnl: -30 });
  assert.equal(t.pool.ok, true);
  near((await w.pool()).e, 970); near((await w.pool()).p, 0.97); near((await w.pool()).u, 1000);
  assert.equal((await trade(w, { pos: 'a', pnl: -30 })).replayed, true);
  near((await w.pool()).e, 970, 1e-6, 'a replay is not added twice');
  await adv(w, 60); await trade(w, { pos: 'b', pnl: 12.5 });
  near((await w.pool()).e, 982.5);
  near(await w.units('john'), 1000);
  const r = await runs(w); assert.equal(r.length, 2); assert.equal(r[1].trades, 1); near(r[1].nav_before, 970);
  assert.equal((await w.q('select count(*)::int n from public.closed_trades where equity_id is null'))[0].n, 0);
  assert.equal((await both(w, 5000)).pool.skipped, 'nothing_new', 'wallet reports do not move the pool in trades mode');
  near((await w.pool()).e, 982.5);
});

test('CT9 trades mode: a trade that closed before the last booked value is already in it; a joiner never shares earlier results', async () => {
  const w = await rolling();
  await adv(w, 30);
  await w.q(`insert into public.closed_trades(wallet, position_id, symbol, side, closed_at, realized_usd) values ('bbcore', 'old', 'SOL_USDT', 'LONG', $1, -500)`, ['2026-02-01T00:00:00Z']);   // before the pool value booked by the join
  await trade(w, { pos: 'n1', pnl: 100 });
  near((await w.pool()).e, 1100, 1e-6, 'the old trade (closed before the booked value) is not added');
  assert.equal((await w.q(`select equity_id from public.closed_trades where position_id='old'`))[0].equity_id != null, true);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 1100, 58, 1100 * 58, null, w.d(), null, true);
  await w.call('admin_post_equity', w.A, (await w.pool()).e + 1100, 58, null, new Date().toISOString());
  const p = await w.pool(); near(p.p, 1.1); near(await w.units('dino'), 1000);
  await adv(w, 30); await trade(w, { pos: 'n2', pnl: -210 });
  near((await w.pool()).e, 1990, 1e-6);
  near(await w.units('john'), 1000); near(await w.units('dino'), 1000);
});

test('CT10 trades mode: gates (paused, off, jump, payout) and the switch back to off', async () => {
  const w = await rolling();
  await adv(w, 30);
  await w.mode('bot_sync_paused', '1');
  assert.equal((await trade(w, { pos: 'p1', pnl: 10 })).pool.skipped, 'paused');
  near((await w.pool()).e, 1000);
  await w.mode('bot_sync_paused', '0');
  assert.equal((await trade(w, { pos: 'p2', pnl: 400 })).pool.skipped, 'jump');
  near((await w.pool()).e, 1000);
  await w.mode('auto_pool_mode', 'off');
  assert.equal((await trade(w, { pos: 'p3', pnl: 1 })).pool.skipped, 'off');
  near((await w.pool()).e, 1000);
});

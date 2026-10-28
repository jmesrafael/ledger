// Two-month settlement (supabase/migrations/applied/20261107000000_hwm_bimonthly_settlement.sql) on 1105's stored high-water mark. Every migration, applied and pending, on an
// in-memory Postgres (PGlite); every call goes in as the public "anon" role. Entries are dated in 2026 so the period rules apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];   // applied/* then the pending migrations
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`;   // tests set the recording time with: set test.clock = '...' (default: the year 2000, before every date used here)
const NOTE = 'bot has no realized PnL yet; checked against the exchange app by hand';

async function world({ settings = {} } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(CLOCK_SQL);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', fee_timing: 'immediate', ...settings };   // fee at the close (1105's rule); 1127's: confirmed-fee.test.mjs
  for (const [k, v] of Object.entries(set)) await db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino', 'eve']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', 0.1);
  const pend = async () => Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
  const nav = async () => Number((await q(`select equity_usdt e from public.pool_equity order by id desc limit 1`))[0]?.e ?? 0);
  const units = async (w) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[w]]))[0].u);
  const price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  const at = (d) => `2026-${d}T04:00:00Z`;                                        // 12:00 Manila
  const ctx = { db, call, q, A, ids, units, price, at, pend };
  ctx.receive = (w, usdt, d) => call('admin_receive_deposit', A, ids[w], usdt, 58, usdt * 58, null, at(d), null, true);
  ctx.total = async (p) => (await nav()) / (await price()) * p + (await pend());  // Exchange total that makes the unit price p
  ctx.reading = async (p, d) => call('admin_post_equity', A, await ctx.total(p), 58, null, at(d));
  ctx.join = async (w, usdt, d, p = null) => { await ctx.receive(w, usdt, d); return (await q(`select 1 from public.pool_equity limit 1`)).length ? ctx.reading(p ?? await price(), d) : call('admin_post_equity', A, usdt, 58, null, at(d)); };
  ctx.settle = async (p, d, { attest = true, idem = null } = {}) => {
    const t = await ctx.total(p);
    if (attest) await call('admin_attest_settlement', A, t, NOTE, at(d), 0);
    return call('admin_close_quarter', A, t, 58, null, at(d), idem);
  };
  ctx.withdraw = async (w, u, p, d) => call('admin_withdraw', A, ids[w], u, (await ctx.total(p)) - (await pend()), 58, null, true, null, at(d));
  ctx.h = async (w) => (await call('admin_overview', A)).find((x) => x.id === ids[w]);
  return ctx;
}

test('HWM: a loss must be recovered before any fee; the mark only moves up; fee = 10% of profit above it', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  const s1 = await w.settle(1.1, '03-02');                             // +100 -> fee 10
  near(s1.fee_usdt, 10, 1e-5);
  near((await w.h('john')).hwm_value, 1090, 1e-5);
  near((await w.settle(0.8, '05-02')).fee_usdt, 0);                   // loss: nothing, mark stays 1090
  near((await w.settle(0.9, '07-02')).fee_usdt, 0);                   // +100 but still below the mark: the flat engine charged 10 here
  const h = await w.h('john');
  near(h.below_hwm_usdt, 1090 - Number(h.units) * 0.9, 1e-5);
  const s4 = await w.settle(1.2, '09-02');                             // only the part above 1090 is charged
  const u = 1000 - 10 / 1.1;
  near(s4.fee_usdt, 0.1 * (u * 1.2 - 1090), 1e-5);
  near((await w.h('john')).hwm_value, u * 1.2 - s4.fee_usdt, 1e-5);
});

test('deposits are never profit: admitted just before a settlement, or still waiting at it', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.reading(1.2, '02-20');
  await w.join('dino', 600, '02-27');                                   // admitted at 1.2 two days before the period ends
  await w.receive('eve', 300, '02-28');                                 // still waiting at the settlement
  const s = await w.settle(1.2, '03-01');
  near(s.fee_usdt, 20, 1e-5);                                            // John's 200 only
  const lines = (await w.call('admin_settlements', w.A))[0].lines;
  near(lines.find((l) => l.profile_id === w.ids.dino).eligible_profit, 0, 1e-6);
  assert.equal(lines.some((l) => l.profile_id === w.ids.eve), false);
  near(await w.units('eve'), 300 / 1.2, 1e-6);                          // Eve joined after the fees, at the settlement price
  near((await w.h('eve')).period_profit_usdt, 0, 1e-6);
  assert.equal((await w.q(`select count(*) n from public.ledger where kind='deposit' and note like 'performance%'`))[0].n, 0);
});

test('different entry dates: each investor is measured from their own admission value', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.reading(1.2, '01-20');
  await w.join('dino', 1200, '01-21');                                  // 1000 units at 1.2
  const s = await w.settle(1.32, '03-02');
  const l = Object.fromEntries((await w.call('admin_settlements', w.A))[0].lines.map((x) => [x.profile_id, x]));
  near(l[w.ids.john].fee_usdt, 32, 1e-5);
  near(l[w.ids.dino].fee_usdt, 12, 1e-5);                               // 10% of 1000 x 0.12; nothing on the 1.00 -> 1.20 move
  near(s.fee_usdt, 44, 1e-5);
});

test('withdrawals: a partial one in a loss keeps the whole shortfall; in profit it settles only its share', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await w.reading(0.8, '01-10');                                        // shortfall 200
  const r = await w.withdraw('john', 500, 0.8, '01-11');
  near(r.fee_units, 0);
  near((await w.h('john')).below_hwm_usdt, 200, 1e-6);          // still 200 on the 500 units left
  near((await w.settle(1.1, '03-02')).fee_usdt, 0);                     // 500 x 0.3 = 150 < 200: nothing
  near((await w.h('john')).below_hwm_usdt, 50, 1e-6);

  const v = await world();
  await v.join('john', 1000, '01-05');
  await v.reading(1.2, '01-10');
  const x = await v.withdraw('john', 400, 1.2, '01-11');                // 40% of +200 -> 8 USDT
  near(Number(x.fee_units) * 1.2, 8, 1e-6);
  near((await v.settle(1.5, '03-02')).fee_usdt, 30, 1e-5);              // 600 x 0.5 - (600 x 0.2 already partly charged? no): 0.1 x (900 - 600) = 30; total 38
});

test('full exit in a loss, then re-entry: the shortfall is carried', async () => {
  for (const carry of ['on']) {          // 1105 always carries the shortfall
    const w = await world({ settings: { hwm_carry_after_exit: carry } });
    await w.join('raf', 1000, '01-04');
    await w.join('john', 1000, '01-05');
    await w.reading(0.8, '01-10');
    await w.withdraw('john', await w.units('john'), 0.8, '01-11');       // out with 800: lost 200
    near((await w.h('john')).hwm_value, carry === 'on' ? 200 : 0, 1e-6);
    await w.join('john', 800, '01-20');
    const s = await w.settle(1.0, '03-02');                               // +200 on the new 1000 units
    near(s.fee_usdt, carry === 'on' ? 0 : 20, 1e-5);
  }
});

test('capital flows never move E - H: withdraw-and-redeposit, or splitting a deposit, gives the same fee', async () => {
  const run = async (busy) => {
    const w = await world();
    await w.join('john', 1000, '01-05');
    await w.reading(0.9, '01-10');
    if (busy) { await w.withdraw('john', 300, 0.9, '01-11'); await w.join('john', 270, '01-12'); await w.join('john', 500, '01-13'); }
    else await w.join('john', 500, '01-13');
    await w.reading(1.3, '02-01');
    return Number((await w.settle(1.3, '03-02')).fee_usdt);
  };
  near(await run(true), await run(false), 1e-5);
});

test('two-month periods: one settlement per period, none before it ends, Manila time', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await assert.rejects(() => w.settle(1.1, '02-27'), /no settlement period has ended yet/);     // Jan-Feb has not ended; Nov-Dec 2025 predates the pool
  const w2 = await world();
  await w2.join('john', 1000, '01-05');
  const s = await w2.settle(1.1, '03-02');
  assert.equal(new Date(s.period_end).toISOString(), '2026-02-28T16:00:00.000Z');       // 1 March 00:00 Manila
  await assert.rejects(() => w2.settle(1.2, '04-29'), /already settled; the next settlement is allowed from 2026-05-01/);
  await w2.settle(1.2, '05-01');
});

test('duplicates: a retried settlement replays; a deposit retried with the same id is recorded once', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  const t = await w.total(1.1);
  await w.call('admin_attest_settlement', w.A, t, NOTE, w.at('03-02'), 0);
  const a = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), 'k1');
  const b = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), 'k1');
  assert.equal(b.replayed, true); near(a.fee_units, b.fee_units);
  assert.equal((await w.q(`select count(*)::int n from public.settlements`))[0].n, 1);
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind='fee_in'`))[0].n, 1);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 100, 58, 5800, null, w.at('03-03'), 'd1', true);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 100, 58, 5800, null, w.at('03-03'), 'd1', true);
  near(await w.pend(), 100);
});

test('reconciliation: unverified needs a written explanation for that total; unmatched transfers and broken entries are refused', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  await assert.rejects(() => w.settle(1.1, '03-02', { attest: false }), /RECONCILE/);
  const t = await w.total(1.1);
  await w.call('admin_attest_settlement', w.A, t + 50, NOTE, w.at('03-02'), 0);                 // explains a different number
  await assert.rejects(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02')), /RECONCILE/);
  const p = await w.call('admin_settlement_preview', w.A, t, w.at('03-02'));
  assert.equal(p.can_settle, false); assert.equal(p.recon.status, 'unverified'); near(p.fee_usdt, 10, 1e-5);
  near(p.recon.trading_pnl_usdt, 100, 1e-5); near(p.recon.trading_pnl_by_price_usdt, 100, 1e-5);

  await w.db.query(`insert into public.ledger_settings(key,value) values ('bot_key_hash', encode(extensions.digest('k','sha256'),'hex')) on conflict (key) do update set value=excluded.value`).catch(async () =>
    w.db.query(`insert into public.ledger_settings(key,value) values ('bot_key_hash', encode(extensions.digest('k','sha256'),'hex')) on conflict (key) do update set value=excluded.value`));
  await w.call('bot_post_snapshot', 'k', t, 0, 0, 0, 0, JSON.stringify([{ id: 'x1', ts: '2026-02-10T00:00:00Z', dir: 'in', usdt: 77 }]), true);
  await assert.rejects(() => w.settle(1.1, '03-02'), /cannot be explained away|not matched/);

  const v = await world();
  await v.join('john', 1000, '01-05');
  await v.reading(1.1, '01-10');
  await v.withdraw('john', 100, 1.1, '01-11');                                           // pays 110
  await v.db.exec(`alter table public.ledger disable trigger ledger_append_only;
    update public.ledger set usdt = -50 where kind = 'withdrawal';
    alter table public.ledger enable trigger ledger_append_only;`);                      // the cash record no longer matches the units
  await assert.rejects(() => v.settle(1.1, '03-02'), /cannot be explained away|differs from the price-move/);
});

test('a clean Exchange snapshot that agrees with the total settles without an explanation', async () => {
  const w = await world();
  await w.db.query(`insert into public.ledger_settings(key,value) values ('bot_key_hash', encode(extensions.digest('k','sha256'),'hex')) on conflict (key) do update set value=excluded.value`);
  await w.join('john', 1000, '01-05');
  await w.call('bot_post_snapshot', 'k', 1000, 0, 0, 0, 0, '[]', true);
  await w.call('bot_post_snapshot', 'k', 1100, 0, 0, 0, 100, '[]', true);
  await w.db.exec(`alter table public.exchange_snapshots disable trigger exchange_snapshots_append_only; update public.exchange_snapshots set ts = '2026-03-02T03:00:00Z'; alter table public.exchange_snapshots enable trigger exchange_snapshots_append_only;`);
  const s = await w.settle(1.1, '03-02', { attest: false });
  assert.equal(s.recon_status, 'verified'); near(s.fee_usdt, 10, 1e-5);
});

test('Fund M: own capital and fee entitlement are kept apart; fee basis "all_pool" never changes what investors pay', async () => {
  // pinned at 10%: this test is about keeping Fund M's capital and fee entitlement apart, not about the rate (20261114000000_fee_20.sql moves the default to 20%)
  const out = {};
  for (const basis of ['external_investors', 'all_pool']) {
    const w = await world({ settings: { fee_basis: basis, fund_m_own_fee_rate: '0.1' } });
    await w.join('raf', 1000, '01-04');
    await w.join('john', 1000, '01-05');
    const s = await w.settle(1.2, '03-02');
    const fm = await w.call('fund_manager_accounts', w.A);
    near(Number(fm.capital.units) + Number(fm.fee_entitlement.units), await w.units('raf'), 1e-8);
    near(fm.capital.contributed_usdt, 1000);
    if (basis === 'external_investors') { near(fm.fee_entitlement.earned_usdt, 20, 1e-5); near(fm.capital.value_usdt, 1200, 1e-5); }
    else { near(fm.fee_entitlement.own_capital_fee_usdt, 20, 1e-5); near(fm.capital.value_usdt, 1180, 1e-5); near(fm.fee_entitlement.earned_usdt, 40, 1e-5); }
    await w.call('admin_withdraw', w.A, w.ids.raf, 100, (await w.total(1.2)), 58, null, true, null, w.at('03-03'));
    const fm2 = await w.call('fund_manager_accounts', w.A), pool = await w.call('pool_summary', w.A);
    assert.ok(Number(fm2.capital.units) >= 0 && Number(fm2.fee_entitlement.units) >= 0);
    near(Number(pool.admin_capital_units) + Number(pool.admin_fee_units), await w.units('raf'), 1e-8);
    out[basis] = [s.fee_usdt, await w.units('john')];
  }
  near(out.all_pool[0], out.external_investors[0], 1e-9); near(out.all_pool[1], out.external_investors[1], 1e-9);
});

test('undo of a withdrawal or deposit restores the mark exactly; the integrity report is clean after a busy year', async () => {
  const w = await world();
  await w.join('raf', 500, '01-04');
  await w.join('john', 1000, '01-05');
  await w.reading(1.2, '01-10');
  await w.join('dino', 400, '01-12');
  await w.settle(1.3, '03-02');
  await w.reading(0.9, '04-01'); await w.withdraw('dino', 100, 0.9, '04-02'); await w.join('eve', 250, '04-03');
  await w.settle(1.0, '05-02'); await w.reading(1.4, '06-10'); await w.settle(1.4, '07-01');
  const rep = await w.call('admin_integrity_report', w.A);
  const bad = rep.checks.filter((c) => c.count > 0).map((c) => c.id);
  assert.deepEqual(bad, []);
  const before = (await w.h('john')).hwm_value;
  await w.withdraw('john', 300, 1.4, '07-02');
  await w.call('admin_undo_last', w.A, 'typo');                                         // undo is stamped now(), so it comes last
  near((await w.h('john')).hwm_value, before, 1e-9);
  const my = await w.call('my_settlements', (await w.call('login', 'john', 'john-password')).token);
  assert.equal(my.length, 3);
});

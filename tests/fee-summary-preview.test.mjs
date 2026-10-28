// Two guards from supabase/migrations/20261127000000_confirmed_gain_fee.sql, on an in-memory Postgres (PGlite) with every migration, every call as "anon":
//   AF1-AF3  accrued_fee_usdt (what the app shows) equals the fee a full exit then charges, after pending gains and rate changes. Checked against hand numbers AND
//            against the real withdrawal path (admin_quote_withdraw runs admin_withdraw and rolls it back), so the two cannot agree by being equally wrong.
//   PV1-PV4  the settlement refuses a stale preview server-side (settlement_preview_mode = 'require'): none, a wrong one, and one made before any change to the books.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(Number(a) - b) <= eps, `${msg} ${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`;
const NOTE = 'bot has no realized PnL yet; checked against the exchange app by hand';

async function world({ settings = {}, rate = 0.2 } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(CLOCK_SQL);
  const set = { lock_months: '0', bcrypt_cost: '4', valuation_max_move: '1000', settlement_schedule: 'free', ...settings };
  for (const [k, v] of Object.entries(set)) await db.query(`update public.ledger_settings set value = $2 where key = $1`, [k, v]);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of ['john', 'dino', 'eve']) ids[u] = await call('admin_create_user', A, u, u, u + '-password', rate);
  const pend = async () => Number((await q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'`))[0].s);
  const nav = async () => Number((await q(`select equity_usdt e from public.pool_equity order by id desc limit 1`))[0]?.e ?? 0);
  const price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  const at = (d) => (d.length > 5 ? d : `2026-${d}T04:00:00Z`);
  const w = { db, call, q, A, ids, price, at };
  w.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[who]]))[0].u);
  w.total = async (p) => (await nav()) / (await price()) * p + (await pend());
  w.receive = (who, usdt, d) => call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, at(d), null, true);
  w.join = async (who, usdt, d) => { await w.receive(who, usdt, d); return (await q(`select 1 from public.pool_equity limit 1`)).length ? call('admin_post_equity', A, await w.total(await price()), 58, null, at(d)) : call('admin_post_equity', A, usdt, 58, null, at(d)); };
  w.reading = async (p, d) => call('admin_post_equity', A, await w.total(p), 58, null, at(d));
  w.withdraw = async (who, u, p, d) => call('admin_withdraw', A, ids[who], u, (await w.total(p)) - (await pend()), 58, null, true, null, at(d));
  w.quote = (who, u, eq, d) => call('admin_quote_withdraw', A, ids[who], u, eq, 58, true, false, at(d), false);
  w.rate = (who, r) => call('admin_set_profile', A, ids[who], null, null, r);
  w.settle = async (p, d, hash = null) => {
    const t = await w.total(p);
    await call('admin_attest_settlement', A, t, NOTE, at(d), 0);
    return call('admin_close_quarter', A, t, 58, null, at(d), null, false, hash);
  };
  w.hash = async (p, d) => (await call('admin_settlement_preview', A, await w.total(p), at(d))).preview_hash;
  w.closes = async () => (await q(`select count(*)::int n from public.pool_equity where kind = 'close'`))[0].n;
  return w;
}
const day = (n) => new Date(Date.UTC(2026, 2, 2, 4) + n * 86400000).toISOString();
const accrued = async (w, who) => Number((await w.call('admin_overview', w.A)).find((x) => x.id === w.ids[who]).accrued_fee_usdt);
const exitFee = async (w, who, d) => {
  const p = await w.price(), r = await w.quote(who, await w.units(who), await w.total(p), d);
  return Number(r.fee_units) * Number(r.unit_price);
};

test('AF1 confirmed rule: accrued fee = confirmed gain + pending gain at today\'s rate, and equals the withdrawal\'s own quote', async () => {
  const w = await world();
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  await w.settle(1.1, '03-02');                                           // L = 1100, mark 1000
  await w.reading(1.2, '03-05');                                          // E = 1200: confirmed 100, pending 100
  near(await accrued(w, 'john'), 40, 1e-6, 'hand: 20% x (100 confirmed + 100 pending)');
  near(await accrued(w, 'john'), await exitFee(w, 'john', day(40)), 1e-6, 'equals the real withdrawal quote');
  await w.reading(1.05, '03-06');                                         // half reverses: only min(E, L) - H = 50 is confirmed, nothing pending
  near(await accrued(w, 'john'), 10, 1e-6, 'hand: 20% x 50');
  near(await accrued(w, 'john'), await exitFee(w, 'john', day(41)), 1e-6);
  await w.reading(0.9, '03-07');                                          // below the mark: nothing
  near(await accrued(w, 'john'), 0, 1e-9);
  near(await exitFee(w, 'john', day(42)), 0, 1e-9);
});

test('AF2 rate changes: a cut applies at once (confirmed part at the lower rate); a raise waits for the next settlement; all equal the withdrawal quote', async () => {
  const w = await world();
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  await w.settle(1.1, '03-02');
  await w.reading(1.2, '03-05');
  near(await accrued(w, 'john'), 40, 1e-6);
  await w.rate('john', 0.1);                                              // cut 20% -> 10%
  near(await accrued(w, 'john'), 20, 1e-6, 'hand: 10% x 100 + 10% x 100');
  near(await accrued(w, 'john'), await exitFee(w, 'john', day(50)), 1e-6);
  await w.rate('john', 0.3);                                              // raise 10% -> 30%: stored as "next", not in force yet
  const pr = (await w.q('select fee_rate r, fee_rate_next n from public.profiles where id = $1', [w.ids.john]))[0];
  near(pr.r, 0.1, 1e-12); near(pr.n, 0.3, 1e-12);
  near(await accrued(w, 'john'), 20, 1e-6, 'a raise that has not started changes nothing');
  near(await accrued(w, 'john'), await exitFee(w, 'john', day(51)), 1e-6);
});

test('AF3 immediate rule: accrued fee is rate x (value - mark); at a 0% rate it is 0 (and so is the real exit)', async () => {
  const w = await world({ settings: { fee_timing: 'immediate' } });
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  await w.reading(1.3, '03-05');
  near(await accrued(w, 'john'), 60, 1e-6, 'hand: 20% x 300');
  near(await accrued(w, 'john'), await exitFee(w, 'john', day(60)), 1e-6);
  const z = await world({ rate: 0 });
  await z.join('raf', 300, '2026-02-19T04:00:00Z'); await z.join('john', 1000, '2026-02-20T04:00:00Z');
  await z.reading(1.3, '03-05');
  near(await accrued(z, 'john'), 0, 0); near(await exitFee(z, 'john', day(61)), 0, 0);
});

test('PV1 mode off (default): no preview needed; mode require: none and a wrong one are refused, nothing is saved, the right one settles', async () => {
  const off = await world();
  await off.join('raf', 300, '2026-02-19T04:00:00Z'); await off.join('john', 1000, '2026-02-20T04:00:00Z');
  assert.equal((await off.call('admin_settlement_preview', off.A, await off.total(1.1), off.at('03-02'))).preview_enforced, false);
  assert.ok((await off.settle(1.1, '03-02', null)).settlement_id, 'mode off: a settlement without a hash is allowed');

  const w = await world({ settings: { settlement_preview_mode: 'require' } });
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  const rows = () => w.q('select (select count(*)::int from public.ledger) l, (select count(*)::int from public.settlement_lines) s, (select count(*)::int from public.settlements) x');
  const c0 = await w.closes(), r0 = await rows();
  await assert.rejects(() => w.settle(1.1, '03-02', null), /PREVIEW REQUIRED/);
  await assert.rejects(() => w.settle(1.1, '03-02', 'deadbeef'), /STALE PREVIEW/);
  assert.equal(await w.closes(), c0, 'a refused settlement writes no pool entry');
  assert.deepEqual(await rows(), r0, 'and no ledger, settlement or settlement-line rows');
  assert.equal((await w.call('admin_settlement_preview', w.A, await w.total(1.1), w.at('03-02'))).preview_enforced, true);
  const r = await w.settle(1.1, '03-02', await w.hash(1.1, '03-02'));
  assert.ok(r.settlement_id, 'the settlement with the matching hash went through');
  assert.equal(await w.closes(), c0 + 1);
});

test('PV2 any change after the preview makes it stale: the balance, a waiting deposit, a rate change, a withdrawal; a fresh preview of the new books settles', async () => {
  const w = await world({ settings: { settlement_preview_mode: 'require' } });
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z'); await w.join('dino', 500, '2026-02-21T04:00:00Z');
  const c0 = await w.closes();
  let h = await w.hash(1.1, '03-02');
  await assert.rejects(() => w.settle(1.15, '03-02', h), /STALE PREVIEW/);              // a different exchange total
  await w.receive('eve', 200, '03-01');                                                 // a deposit now waiting
  await assert.rejects(() => w.settle(1.1, '03-02', h), /STALE PREVIEW/);
  h = await w.hash(1.1, '03-02');
  await w.rate('dino', 0.3);                                                            // a rate raise scheduled
  await assert.rejects(() => w.settle(1.1, '03-02', h), /STALE PREVIEW/);
  h = await w.hash(1.1, '03-02');
  await w.withdraw('dino', 100, 1.1, '03-01');                                          // units and marks move
  await assert.rejects(() => w.settle(1.1, '03-02', h), /STALE PREVIEW/);
  assert.equal(await w.closes(), c0, 'no stale attempt settled anything');
  assert.ok((await w.settle(1.1, '03-02', await w.hash(1.1, '03-02'))).settlement_id, 'a fresh preview of the new books settles');
});

test('PV3 the settlement period is part of the hash, and the figures previewed are the ones charged', async () => {
  const w = await world({ settings: { settlement_preview_mode: 'require' } });
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  await w.settle(1.1, '03-02', await w.hash(1.1, '03-02'));
  await w.reading(1.2, '05-05');
  const t = await w.total(1.2);
  const pv = await w.call('admin_settlement_preview', w.A, t, w.at('05-10'));
  assert.notEqual(pv.preview_hash, await w.hash(1.2, '03-10'), 'a different settlement period is a different hash');
  const johnLine = pv.lines.find((l) => l.profile_id === w.ids.john);
  await w.call('admin_attest_settlement', w.A, t, NOTE, w.at('05-10'), 0);
  const res = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('05-10'), null, false, pv.preview_hash);
  near(res.fee_usdt, pv.fee_usdt, 1e-9, 'total fee charged = total fee previewed');
  const line = (await w.q('select * from public.settlement_lines where profile_id = $1 order by equity_id desc limit 1', [w.ids.john]))[0];
  near(line.fee_units, Number(johnLine.fee_units), 1e-12); near(line.hwm_after, Number(johnLine.hwm_after_usdt), 1e-9);
});

test('PV4 a retry with the same request id replays (no second settlement, no stale error)', async () => {
  const w = await world({ settings: { settlement_preview_mode: 'require' } });
  await w.join('raf', 300, '2026-02-19T04:00:00Z'); await w.join('john', 1000, '2026-02-20T04:00:00Z');
  const t = await w.total(1.1), h = await w.hash(1.1, '03-02');
  await w.call('admin_attest_settlement', w.A, t, NOTE, w.at('03-02'), 0);
  const a = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), 'idem-1', false, h);
  const b = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), 'idem-1', false, h);   // the books changed (settled), so the hash is stale now, but the replay comes first
  assert.equal(b.replayed, true);
  assert.equal(a.settlement_id, b.settlement_id);
  assert.equal(await w.closes(), 1);
});

test('PV5 (static check of js/app.js, NOT a browser run) both settlement routes send the preview hash, and only the one the database returned for this exact balance and date', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /const previewArg = \(eq, at\) => \{ const st = spState\(eq, at\); return st && st\.status === 'ok' && st\.pv && st\.pv\.preview_hash/, 'the hash comes only from a finished preview of this balance and date');
  assert.match(app, /admin_settle_quarter', \{ p_vid: usable\(\), \.\.\.previewArg\(Number\(RD\(\)\.balance\), null\) \}/, 'the workflow settlement sends it');
  assert.match(app, /p_at: atOf\(fm\), \.\.\.previewArg\(num\(fv\(fm, 'equity'\)\), atOf\(fm\)\) \}/, 'the Settle form sends it');
  assert.match(app, /await loadPreview\(eq, at\);\s*const st = spState\(eq, at\)/, 'a fresh preview is asked for right before the confirmation, so the hash is never older than the sheet');
});

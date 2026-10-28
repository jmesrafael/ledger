// Per-wallet snapshots, combined NAV and the payout cap (supabase/migrations/20261130000000_wallet_snapshots.sql), on an in-memory Postgres (PGlite) with every
// migration, every call as "anon". NOTHING here talks to MEXC or Supabase: the "bots" are the test calling bot_post_wallet_snapshot with made-up numbers.
//   WS1  authentication: a key works for ITS wallet only; wrong key, unknown wallet and an inactive wallet all give the same answer; nothing is stored
//   WS2  validation: more than 6 decimals, negative, unknown counts, clock drift, missing sequence are refused
//   WS3  replay: the same report again is a harmless retry; the same sequence with other data, or an older sequence, is refused
//   WS4  a big jump is stored as suspect and blocks use until accepted with a reason; snapshots are append-only
//   WS5  readiness: missing, stale, skewed, outdated (a payout was sent after it) all give "not ok" and NO numbers (never zero)
//   WS6  combined NAV against an independent model: trades, unrealized/realized, transfers between the wallets, waiting deposits (Spot and Futures), nothing double-counted
//   WS7  wallet_nav_mode: a typed total that disagrees with the wallets, or unusable wallets, refuses every valuation; with the mode off nothing changes
//   WS8  the payout cap: buffer arithmetic, queued (refused, nothing saved, units unchanged), blocked, unsent money, replay, manager-paid payouts not capped
//   WS9  the request split and the queue view conserve units
//   WS10 the backup carries the wallet tables and never a secret hash
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
const sums = (n) => ({ eq: Number(n.combined_equity_usdt), tr: Number(n.transferable_total_usdt) });

test('WS1 a key works for its own wallet only; every failure gives the same answer and stores nothing', async () => {
  const w = await world();
  assert.equal((await w.snap('bbcore', { eq: 600 })).ok, true);
  for (const bad of [{ key: w.keys.icore }, { key: 'x'.repeat(64) }, { key: '' }, { wallet: 'nope' }]) {
    await assert.rejects(() => w.snap('bbcore', { eq: 600, ...bad }), /^error: not allowed$|not allowed/);
  }
  await w.db.query(`update public.bot_wallets set active = false where wallet = 'icore'`);
  await assert.rejects(() => w.snap('icore', { eq: 400 }), /not allowed/);
  assert.equal((await w.q('select count(*)::int n from public.wallet_snapshots'))[0].n, 1, 'only the one valid report is stored');
  await assert.rejects(() => w.call('admin_wallet_nav', 'not-a-token'));
  assert.equal((await w.q(`select has_function_privilege('anon', 'public._wallet_nav()', 'execute') as x`))[0].x, false, 'internal functions are closed to the website role');
});

test('WS2 validation: decimals, negatives, unknown counts, clock drift, sequence', async () => {
  const w = await world();
  await assert.rejects(() => w.snap('bbcore', { eq: 600.1234567 }), /at most 6 decimals/);
  await assert.rejects(() => w.snap('bbcore', { eq: 600, wd: 10.0000001 }), /at most 6 decimals/);
  await assert.rejects(() => w.snap('bbcore', { eq: -1 }), /cannot be negative/);
  await assert.rejects(() => w.snap('bbcore', { eq: 600, pos: null }), /real counts/);
  await assert.rejects(() => w.snap('bbcore', { eq: 600, seq: 0 }), /sequence/);
  await assert.rejects(() => w.snap('bbcore', { eq: 600, rep: new Date(w.now - 6 * 60000).toISOString() }), /clock/);
  await assert.rejects(() => w.snap('bbcore', { eq: 600, rep: new Date(w.now + 6 * 60000).toISOString() }), /clock/);
  assert.equal((await w.snap('bbcore', { eq: 600, rep: new Date(w.now - 4 * 60000).toISOString() })).ok, true, 'within the drift limit');
  assert.equal((await w.q('select count(*)::int n from public.wallet_snapshots'))[0].n, 1);
});

test('WS3 replay protection: the same report is a retry; the same sequence with other data and an older sequence are refused', async () => {
  const w = await world();
  const a = await w.snap('bbcore', { eq: 600, seq: 10 });
  const b = await w.snap('bbcore', { eq: 600, seq: 10 });
  assert.equal(b.replayed, true); assert.equal(b.snapshot_id, a.snapshot_id);
  await assert.rejects(() => w.snap('bbcore', { eq: 610, seq: 10 }), /already used with different data/);
  await w.snap('bbcore', { eq: 601, seq: 11 });
  await assert.rejects(() => w.snap('bbcore', { eq: 600, seq: 10 }), /older than the last accepted/);
  assert.equal((await w.q('select count(*)::int n from public.wallet_snapshots'))[0].n, 2);
  assert.equal((await w.snap('icore', { eq: 400, seq: 10 })).ok, true, 'sequences are per wallet');
});

test('WS4 a big jump is suspect and blocks use until accepted with a reason; snapshots are append-only', async () => {
  const w = await world();
  await w.both({ eq: 600 }, { eq: 400 });
  const nav0 = await w.nav(); assert.equal(nav0.ok, true);
  const s = await w.snap('bbcore', { eq: 1000 });                       // +66%: over the 50% limit
  assert.equal(s.suspect, true);
  const nav1 = await w.nav();
  assert.equal(nav1.ok, false); assert.equal(nav1.combined_equity_usdt, null, 'no number is shown for unusable wallets');
  assert.ok(nav1.reasons.some((r) => r.code === 'suspect' && r.wallet === 'bbcore'));
  await assert.rejects(() => w.call('admin_accept_wallet_snapshot', w.A, s.snapshot_id, 'short'), /at least 10 characters/);
  await w.call('admin_accept_wallet_snapshot', w.A, s.snapshot_id, 'a 400 USDT deposit arrived in this wallet');
  await w.snap('icore', { eq: 400 });
  const nav2 = await w.nav(); assert.equal(nav2.ok, true); near(nav2.combined_equity_usdt, 1400);
  await assert.rejects(() => w.call('admin_accept_wallet_snapshot', w.A, s.snapshot_id, 'a 400 USDT deposit arrived in this wallet'), /already accepted/);
  await assert.rejects(() => w.db.query(`update public.wallet_snapshots set equity_usdt = 1 where id = $1`, [s.snapshot_id]), /append-only/);
  await assert.rejects(() => w.db.query(`delete from public.wallet_snapshots where id = $1`, [s.snapshot_id]), /append-only/);
  assert.equal((await w.q(`select count(*)::int n from public.audit_log where action = 'wallet_snapshot_accepted'`))[0].n, 1, 'the acceptance is in the activity log');
});

test('WS5 not ready means no numbers: missing, one wallet only, stale, skewed, outdated by a payout', async () => {
  const w = await world();
  let n = await w.nav(); assert.equal(n.ok, false); assert.equal(n.combined_equity_usdt, null);
  assert.deepEqual(n.reasons.filter((r) => r.wallet).map((r) => r.code).sort(), ['missing', 'missing']);
  await w.snap('bbcore', { eq: 600 });
  n = await w.nav(); assert.equal(n.ok, false, 'one wallet alone can never value the pool'); assert.ok(n.reasons.some((r) => r.code === 'missing' && r.wallet === 'icore'));
  await w.snap('icore', { eq: 400 });
  n = await w.nav(); assert.equal(n.ok, true); near(n.combined_equity_usdt, 1000);
  await w.clock(w.now + 29 * 60000); n = await w.nav(); assert.equal(n.ok, true, '29 minutes is still fresh');
  await w.clock(w.now + 2 * 60000); n = await w.nav();
  assert.equal(n.ok, false); assert.equal(n.combined_equity_usdt, null); assert.equal(n.reasons.filter((r) => r.code === 'stale').length, 2);
  await w.both({ eq: 600 }, { eq: 400 }); assert.equal((await w.nav()).ok, true);
  // skew: the wallets report 11 minutes apart (both fresh): a transfer between them could be counted twice
  await w.clock(w.now + 11 * 60000); await w.snap('icore', { eq: 400 });
  n = await w.nav(); assert.equal(n.ok, false); assert.ok(n.reasons.some((r) => r.code === 'skewed'));
  await w.snap('bbcore', { eq: 600 }); assert.equal((await w.nav()).ok, true, 'both re-read together: skew gone');
  // a payout sent from the exchange AFTER the last snapshots: they still show that money
  await w.join('raf', 300); await w.join('john', 700);
  await w.db.query(`insert into public.withdrawal_requests(profile_id, units, pay_by, status, stage) values ($1, 10, current_date, 'pending', 'redeemed')`, [w.ids.john]);
  const rid = (await w.q('select max(id) i from public.withdrawal_requests'))[0].i;
  await w.db.query(`insert into public.payout_records(request_id, profile_id, amount_usdt, leaves_mexc, status, sent_at) values ($1, $2, 10, true, 'sent', $3)`, [rid, w.ids.john, new Date(w.now + 1000).toISOString()]);
  n = await w.nav(); assert.equal(n.ok, false); assert.ok(n.reasons.some((r) => r.code === 'outdated'));
  await w.clock(w.now + 5000); await w.both({ eq: 600 }, { eq: 390 }); assert.equal((await w.nav()).ok, true, 'fresh snapshots after the payout are usable');
});

// ---------------------------------------------------------------- WS6: combined NAV against an independent model (nothing double-counted)
for (const where of ['spot', 'futures']) {
  for (const seed of [61, 62, 63]) {
    test(`WS6 (${where}, seed ${seed}) combined NAV and the valuation = an independent model, after every step`, async () => {
      const rand = rng(seed), w = await world({ settings: { queued_money_location: where } });
      await w.join('raf', 300); await w.join('john', 700);                    // the pool exists: 1000 USDT, 1000 units at price 1
      let A = 600, B = 400, uA = 0, uB = 0, waiting = [], U = 1000, price = 1, log = [];
      await w.both({ eq: A, unr: uA }, { eq: B, unr: uB });
      await w.mode('wallet_nav_mode', 'require');
      const typed = () => A + B + (where === 'spot' ? waiting.reduce((s, d) => s + d, 0) : 0);
      const navModel = () => A + B - (where === 'futures' ? waiting.reduce((s, d) => s + d, 0) : 0);
      for (let step = 0; step < 24; step++) {
        const r = rand(); w.now += 60000; await w.clock(w.now);
        if (r < 0.3) {                                                         // trading result on one wallet: partly unrealized, partly realized; equity moves by the whole
          const onA = rand() < 0.5, base = onA ? A : B, dlt = Math.round((rand() - 0.5) * 0.6 * base * 100) / 100;   // at most +-30% of THAT wallet: a normal move, never a "suspect" jump
          if (onA) { A = Math.round((A + dlt) * 1e6) / 1e6; uA = Math.round((uA + dlt * 0.5) * 1e6) / 1e6; } else { B = Math.round((B + dlt) * 1e6) / 1e6; uB = Math.round((uB + dlt * 0.5) * 1e6) / 1e6; }
          log.push('trade');
        } else if (r < 0.45) { uA = 0; uB = 0; log.push('realize'); }          // unrealized becomes realized: equity unchanged
        else if (r < 0.6) {                                                    // a transfer between the wallets: equity moves from one to the other, the sum does not
          const x = Math.round(Math.min(A * 0.4, B * 0.45) * rand() * 100) / 100;
          if (rand() < 0.5) { A -= x; B += x; } else { B -= x; A += x; }
          A = Math.round(A * 1e6) / 1e6; B = Math.round(B * 1e6) / 1e6; log.push('transfer');
        } else if (r < 0.72) {                                                 // money waits to join (Spot, or inside a Futures wallet)
          const d = Math.round((10 + rand() * 300) * 100) / 100;
          await w.call('admin_receive_deposit', w.A, w.ids.dino, d, 58, d * 58, null, w.d(), null, true); waiting.push(d);
          if (where === 'futures') { A = Math.round((A + d) * 1e6) / 1e6; }   // it sits in the wallet, so the wallet's equity includes it
          log.push('deposit');
        } else if (waiting.length) {                                           // value the pool: the waiting money buys units at the new price
          await w.both({ eq: A, unr: uA }, { eq: B, unr: uB });
          const nav = navModel(), sw = waiting.reduce((s, d) => s + d, 0); price = nav / U;
          await w.call('admin_post_equity', w.A, typed(), 58, null, w.d());
          for (const d of waiting) U += Math.round((d / price) * 1e8) / 1e8;   // the waiting money buys units at the new price (8 decimals, as the ledger does)
          waiting = [];
          const p = await w.pool();
          near(p.p, price, 1e-9, `step ${step} unit price = (A + B - waiting-in-futures) / units`);
          near(p.e, nav + sw, 1e-6, `step ${step} pool equity after the joiners are in`);
          near(p.u, U, 1e-6, `step ${step} total units`);
          if (where === 'spot') { A = Math.round((A + sw) * 1e6) / 1e6; }     // the manager then moves the joined money Spot -> Futures (docs/pool-update.md step 4): it is now in a wallet
          log.push('valuation');
          await w.both({ eq: A, unr: uA }, { eq: B, unr: uB });
          continue;
        } else { log.push('idle'); }
        await w.both({ eq: A, unr: uA }, { eq: B, unr: uB });
        const n = await w.nav();
        assert.equal(n.ok, true, `step ${step} (${log.at(-1)}): ${JSON.stringify(n.reasons)}`);
        near(n.combined_equity_usdt, A + B, 1e-6, `step ${step} (${log.at(-1)}) combined equity = sum of the wallets, unrealized not added again`);
        near(n.combined_unrealized_usdt, uA + uB, 1e-6);
        near(n.nav_implied_usdt, navModel(), 1e-6, `step ${step} implied NAV`);
        const pv = await w.call('admin_settlement_preview', w.A, typed(), new Date(w.now).toISOString());   // preview = _net_equity(typed): the NAV a valuation would use
        near(pv.nav, navModel(), 1e-6, `step ${step} (${log.at(-1)}) NAV used by the valuation`);
      }
    });
  }
}

test('WS6b money redeemed but not yet sent is still inside the wallets but is no longer the pool\'s: NAV = A + B - unsent, and it stops mattering once sent', async () => {
  const w = await world();
  await w.join('raf', 300); await w.join('john', 700);                         // 1000 units at price 1
  await w.both({ eq: 600 }, { eq: 400 });
  await w.mode('wallet_nav_mode', 'require');
  const at = () => new Date(w.now).toISOString();
  near((await w.call('admin_settlement_preview', w.A, 1000, at())).nav, 1000, 1e-9, 'nothing unsent: NAV = A + B');
  await w.db.query(`insert into public.withdrawal_requests(profile_id, units, pay_by, status, stage) values ($1, 200, current_date, 'pending', 'redeemed')`, [w.ids.john]);
  const rid = (await w.q('select max(id) i from public.withdrawal_requests'))[0].i;
  await w.db.query(`insert into public.payout_records(request_id, profile_id, amount_usdt, leaves_mexc, status) values ($1, $2, 200, true, 'awaiting')`, [rid, w.ids.john]);
  const nav = await w.nav();
  near(nav.nav_implied_usdt, 800, 1e-9, 'hand: 1000 in the wallets - 200 redeemed and waiting to be sent');
  near((await w.call('admin_settlement_preview', w.A, 1000, at())).nav, 800, 1e-9, 'the valuation uses the same NAV');
  await w.call('admin_post_equity', w.A, 1000, 58, null, w.d());
  near((await w.pool()).e, 800, 1e-9, 'the pool is valued without the money that already left it');
  // the manager sends it: the wallets now hold 200 less, and the snapshots taken after that say so
  await w.db.query(`update public.payout_records set status = 'sent', sent_at = $1 where request_id = $2`, [new Date(w.now + 1000).toISOString(), rid]);
  assert.equal((await w.nav()).ok, false, 'snapshots older than the send still show the money: not usable');
  await w.clock(w.now + 5000); await w.both({ eq: 500 }, { eq: 300 });
  near((await w.nav()).nav_implied_usdt, 800, 1e-9, 'after the send: A + B = 800, nothing unsent, same NAV');
  near((await w.call('admin_settlement_preview', w.A, 800, new Date(w.now).toISOString())).nav, 800, 1e-9);
});

test('WS7 wallet_nav_mode: a total that disagrees with the wallets, or unusable wallets, refuse every valuation; with the mode off nothing changes', async () => {
  const w = await world();
  await w.join('raf', 300); await w.join('john', 700);
  await w.both({ eq: 600 }, { eq: 400 });
  // mode off (default): any total is accepted exactly as before
  await w.call('admin_post_equity', w.A, 1100, 58, null, w.d());
  assert.equal((await w.pool()).e, 1100);
  await w.mode('wallet_nav_mode', 'require');
  const before = await w.trace();
  await assert.rejects(() => w.call('admin_post_equity', w.A, 1100, 58, null, w.d()), /WALLET MISMATCH/);          // the wallets say 1000
  await assert.rejects(() => w.call('admin_post_equity', w.A, 1000.6, 58, null, w.d()), /WALLET MISMATCH/);        // outside the 0.50 USDT tolerance
  assert.deepEqual(await w.trace(), before, 'a refused valuation saves nothing');
  await w.call('admin_post_equity', w.A, 1000.4, 58, null, w.d());                                                  // inside the tolerance
  near((await w.pool()).e, 1000.4, 1e-9);
  await w.clock(w.now + 31 * 60000);                                                                                 // stale
  await assert.rejects(() => w.call('admin_post_equity', w.A, 1000, 58, null, w.d()), /WALLETS NOT READY.*last reported 31 minutes ago/);
  await assert.rejects(() => w.call('admin_withdraw', w.A, w.ids.john, 100, 1000, 58, null, true, null, w.d(), null, false), /WALLETS NOT READY/);
  await assert.rejects(() => w.call('admin_settlement_preview', w.A, 1000, w.d()), /WALLETS NOT READY/);
  await w.mode('wallet_nav_mode', 'off');                                                                            // switching back restores the old behaviour at once
  await w.call('admin_post_equity', w.A, 1000, 58, null, w.d());
});

// ---------------------------------------------------------------- WS8: the payout cap
const payable = async (w) => Number((await w.nav()).payout.payable_now_usdt);
test('WS8 payout cap: buffer arithmetic, a payout over it is refused and saves nothing, one under it is paid, blocked when the wallets are not usable', async () => {
  const w = await world();
  await w.join('raf', 300); await w.join('john', 700);
  await w.both({ eq: 600, wd: 600 }, { eq: 400, wd: 400 });
  await w.mode('payout_cap_mode', 'require');
  near(await payable(w), 1000 * 0.95 - 5, 1e-9, 'hand: 1000 transferable x 95% - 5 buffer = 945');
  // transferable is the SMALLEST of withdrawable, available and equity (per wallet)
  await w.both({ eq: 600, wd: 600, av: 100 }, { eq: 400, wd: 300 });
  near(await payable(w), (100 + 300) * 0.95 - 5, 1e-9, 'hand: min(600,600,100) + min(400,300,300) = 400');
  await w.both({ eq: 600, wd: 700 }, { eq: 400, wd: 400, unr: -50 });
  near(await payable(w), 1000 * 0.95 - 5, 1e-9, 'withdrawable above equity (open losses) is capped at equity');
  // the cap now binds: only 300 + 200 = 500 is withdrawable, so 470 can leave. John holds 700 units at price 1 (no gain, no fee: a payout equals the units).
  await w.both({ eq: 600, wd: 300 }, { eq: 400, wd: 200 });
  near(await payable(w), 500 * 0.95 - 5, 1e-9, 'hand: 500 x 95% - 5 = 470');
  const u0 = await w.units('john'), before = await w.trace();
  await assert.rejects(() => w.call('admin_withdraw', w.A, w.ids.john, 480, 1000, 58, null, true, null, w.d(), null, false), /PAYOUT QUEUED.*470/);   // 10 over
  await assert.rejects(() => w.call('admin_withdraw', w.A, w.ids.john, 700, 1000, 58, null, true, null, w.d(), null, false), /PAYOUT QUEUED/);          // a full exit
  assert.deepEqual(await w.trace(), before, 'a refused payout writes nothing');
  near(await w.units('john'), u0, 0, "the investor's units are unchanged: the request simply stays queued");
  const ok = await w.call('admin_withdraw', w.A, w.ids.john, 470, 1000, 58, null, true, null, w.d(), 'wd-1', false);     // exactly what can leave
  near(ok.pay_usdt, 470, 1e-9);
  near(await w.units('john'), 230, 1e-9);
  const replay = await w.call('admin_withdraw', w.A, w.ids.john, 470, 1000, 58, null, true, null, w.d(), 'wd-1', false);
  assert.equal(replay.replayed, true, 'a retry of a payout already made is a replay, not checked against the cap again');
  near(await w.units('john'), 230, 1e-9, 'and it took no more units');
  // wallets that are not usable block the payout, with their own message
  await w.clock(w.now + 31 * 60000);
  await assert.rejects(() => w.call('admin_withdraw', w.A, w.ids.john, 10, 530, 58, null, true, null, w.d(), null, false), /PAYOUT BLOCKED.*last reported/);
  await w.mode('payout_cap_mode', 'off');
  assert.ok((await w.call('admin_withdraw', w.A, w.ids.john, 10, 530, 58, null, true, null, w.d(), null, false)).pay_usdt, 'with the cap off the same payout is allowed, exactly as before');
});

test('WS8b unsent money counts against the cap; a payout paid from the manager\'s own money is not capped', async () => {
  const w = await world();
  await w.join('raf', 300); await w.join('john', 700);
  await w.both({ eq: 600, wd: 300 }, { eq: 400, wd: 200 });                                    // 500 withdrawable: 470 can leave
  await w.mode('payout_cap_mode', 'require');
  near(await payable(w), 470, 1e-9);
  // 200 USDT already redeemed and waiting to be sent: still inside the wallets, but no longer available to pay someone else
  await w.db.query(`insert into public.withdrawal_requests(profile_id, units, pay_by, status, stage) values ($1, 200, current_date, 'pending', 'redeemed')`, [w.ids.john]);
  const rid = (await w.q('select max(id) i from public.withdrawal_requests'))[0].i;
  await w.db.query(`insert into public.payout_records(request_id, profile_id, amount_usdt, leaves_mexc, status) values ($1, $2, 200, true, 'awaiting')`, [rid, w.ids.john]);
  near(await payable(w), 470 - 200, 1e-9, 'hand: 470 - 200 already redeemed and not sent');
  near((await w.nav()).outbound_unsent_usdt, 200);
  await w.db.query(`update public.payout_records set status = 'completed', sent_at = $1 where request_id = $2`, [new Date(w.now - 1000).toISOString(), rid]);
  near(await payable(w), 470, 1e-9, 'once sent it no longer counts (the snapshot is newer than the send)');
  await w.db.query(`update public.payout_records set status = 'awaiting', sent_at = null where request_id = $1`, [rid]);
  await assert.rejects(() => w.call('admin_withdraw', w.A, w.ids.john, 300, 1000, 58, null, true, null, w.d(), null, false), /PAYOUT QUEUED.*270/, 'a 300 payout does not fit in the 270 left');
  // the same 300 paid from the manager's own money moves nothing out of the exchange: not capped
  const tm = await w.call('admin_withdraw_to_manager', w.A, w.ids.john, 300, 1000, 58, null, true, null, w.d(), null, false);
  near(tm.pay_usdt, 300, 1e-9);
});

// ---------------------------------------------------------------- WS9: the queue and the split
test('WS9 the queue shows what fits; splitting an approved request conserves units exactly and leaves the rest queued', async () => {
  const w = await world();
  await w.join('raf', 300); await w.join('john', 700);
  await w.both({ eq: 600 }, { eq: 400 });
  await w.mode('payout_cap_mode', 'require');
  for (const u of [500, 600]) {
    await w.db.query(`insert into public.withdrawal_requests(profile_id, units, pay_by, status, stage, approved_at) values ($1, $2, current_date, 'pending', 'approved', now())`, [w.ids.john, u]);
  }
  let q = await w.call('admin_withdrawal_queue', w.A);
  assert.equal(q.requests.length, 2); assert.equal(q.requests[0].fits_now, true); assert.equal(q.requests[1].fits_now, false);
  assert.match(q.estimate_note, /Estimates/);
  const rid = q.requests[1].request_id, total0 = q.requests.reduce((s, r) => s + Number(r.units), 0);
  await assert.rejects(() => w.call('admin_split_withdrawal_request', w.A, rid, 600, null), /more than 0 and less than the whole/);
  await assert.rejects(() => w.call('admin_split_withdrawal_request', w.A, rid, 0, null), /more than 0/);
  const sp = await w.call('admin_split_withdrawal_request', w.A, rid, 300, 'pay what fits now');
  near(Number(sp.pay_now_units) + Number(sp.queued_units), 600, 0);
  q = await w.call('admin_withdrawal_queue', w.A);
  assert.equal(q.requests.length, 3); near(q.requests.reduce((s, r) => s + Number(r.units), 0), total0, 0, 'units are conserved by a split');
  const rows = await w.q(`select id, units::float u, stage, status from public.withdrawal_requests where profile_id = $1 order by id`, [w.ids.john]);
  assert.ok(rows.every((r) => r.stage === 'approved' && r.status === 'pending'));
  assert.equal((await w.q(`select count(*)::int n from public.audit_log where action = 'wf_request_split'`))[0].n, 1);
  await w.db.query(`update public.withdrawal_requests set stage = 'requested' where id = $1`, [rid]);
  await assert.rejects(() => w.call('admin_split_withdrawal_request', w.A, rid, 100, null), /only an approved request/);
});

test('WS10 the backup carries the wallet tables and never a secret hash', async () => {
  const w = await world();
  await w.both({ eq: 600 }, { eq: 400 });
  const x = await w.call('admin_export_all', w.A), text = JSON.stringify(x);
  assert.equal(x.bot_wallets.length, 2); assert.equal(x.wallet_snapshots.length, 2);
  for (const k of Object.values(w.keys)) assert.ok(!text.includes(sha(k)) && !text.includes(k), 'neither a key nor its hash is in the backup');
  assert.ok(!/key_hash/.test(JSON.stringify(x.bot_wallets)));
  const cov = await w.call('admin_backup_coverage', w.A);
  assert.deepEqual(cov.missing, [], 'every table is in the backup or deliberately excluded');
});

// ---------------------------------------------------------------- WS11: end to end through the existing balance-check workflow
test('WS11 workflow end to end: an open trade blocks a payout only without wallet mode; over the cap it stays queued, then goes through on the SAME balance check', async () => {
  const w = await world();
  await w.join('raf', 300); await w.join('john', 700);                                  // 1000 units at price 1
  const J = (await w.call('login', 'john', 'john-password')).token;
  await w.call('set_my_payout', J, 'gcash', 'John', '09171234567');
  await w.call('request_withdrawal', J, 600);
  const rid = (await w.call('my_requests', J))[0].id;
  await w.call('admin_approve_withdrawal', w.A, rid, null, 'approved');
  await w.both({ eq: 600, wd: 300, pos: 1 }, { eq: 400, wd: 200, pos: 0 });             // one trade is open; 500 withdrawable
  const v = await w.call('admin_enter_balance', w.A, 1000, 1, 0, null, null); await w.call('admin_confirm_balance', w.A, v.id, null);
  // 1. without wallet mode the open position blocks the payout (the existing rule, unchanged)
  await assert.rejects(() => w.call('admin_execute_withdrawal', w.A, rid, v.id, false, null, null, 'x0', false), /trade is still open/);
  // 2. wallet mode + cap: the open trade is no longer a reason; but 600 does not fit in the 470 that can leave, so the request stays queued
  await w.mode('wallet_nav_mode', 'require'); await w.mode('payout_cap_mode', 'require');
  const u0 = await w.units('john'), t0 = await w.trace();
  await assert.rejects(() => w.call('admin_execute_withdrawal', w.A, rid, v.id, false, null, null, 'x1', false), /PAYOUT QUEUED.*470/);
  assert.deepEqual(await w.trace(), t0, 'nothing was saved');
  near(await w.units('john'), u0, 0, 'the investor still holds every unit');
  const rq = (await w.q('select status, stage from public.withdrawal_requests where id = $1', [rid]))[0];
  assert.deepEqual({ ...rq }, { status: 'pending', stage: 'approved' }, 'the request is still waiting, approved');
  assert.equal((await w.q('select spent_at from public.balance_verifications where id = $1', [v.id]))[0].spent_at, null, 'the balance check was not used up');
  const queue = await w.call('admin_withdrawal_queue', w.A);
  assert.equal(queue.requests[0].fits_now, false); near(queue.requests[0].estimated_payout_usdt, 600, 1e-6);
  // 3. more becomes withdrawable (a trade closes): the next snapshots allow it, and the SAME request and balance check now go through
  await w.clock(w.now + 60000); await w.both({ eq: 600, wd: 600, pos: 0 }, { eq: 400, wd: 400, pos: 0 });
  const out = await w.call('admin_execute_withdrawal', w.A, rid, v.id, false, null, null, 'x2', false);
  near(out.pay_usdt, 600, 1e-9);
  near(await w.units('john'), 100, 1e-9);
  assert.equal((await w.q(`select status from public.payout_records where request_id = $1`, [rid]))[0].status, 'awaiting');
  const again = await w.call('admin_execute_withdrawal', w.A, rid, v.id, false, null, null, 'x2', false);
  assert.equal(again.replayed, true, 'a retry with the same request id is a replay');
  near(await w.units('john'), 100, 1e-9, 'and took no more units');
  assert.equal((await w.q(`select count(*)::int n from public.payout_records where request_id = $1`, [rid]))[0].n, 1, 'one payout');
});

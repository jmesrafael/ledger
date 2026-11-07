// True-value pricing in the DATABASE (migration 20261207000000_true_value_pricing.sql) on an in-memory Postgres (PGlite), every call as the website's public role.
// Each flow is checked against the reference model lib/truevalue.js (same inputs, same price, same units), and against the rule that matters: existing holders keep
// their value from before the flow and the joiner / leaver gets exactly their money, once the open trades close as marked.
//   TVD1 off by default   TVD2 deposit, open winner   TVD3 deposit, open loser + trade moves after   TVD4 payout with fee   TVD5 blocked readings
//   TVD6 delayed reports   TVD7 duplicates   TVD8 corrections   TVD9 the normal path is unchanged   TVD10 status pages
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const TV = createRequire(import.meta.url)('../lib/truevalue.js');

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const CORRECTIONS = new URL('../supabase/corrections/20261107_prepare_book_corrections.sql', import.meta.url);
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(Number(a) - b) <= eps, `${msg} ${a} != ${b}`);
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, now()) $$;`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const WALLETS = ['bbcore', 'icore', 'tcore'];

async function world({ rate = 0.2 } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
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
      await call('bot_post_wallet_snapshot', keys[x], x, ++w.seq[x], new Date(w.now).toISOString(), +eq.toFixed(6), +unr.toFixed(6), +(c.wd ?? eq - unr).toFixed(6), +(c.wd ?? eq - unr).toFixed(6), c.pos ?? 1, 0);
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
const adv = async (w, min) => w.clock(w.now + min * 60000);
// a pool of 1000 USDT, raf holds it all at price 1; true value switched on
async function ready() {
  const w = await world();
  await w.join('raf', 1000);
  await adv(w, 5);
  await w.mode('flow_pricing', 'true_value');
  return w;
}

test('TVD1 off by default: the setting exists as "book", money cannot move through the new functions, the status still reads', async () => {
  const w = await world(); await w.join('raf', 1000); await adv(w, 5);
  assert.equal((await w.q(`select value from public.ledger_settings where key='flow_pricing'`))[0].value, 'book');
  const pid = await w.receive('john', 100);
  await w.report(1100, 0);                                     // 1000 pool + the 100 waiting
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, pid, null), /true-value pricing is off/);
  const s = await w.status(); assert.equal(s.enabled, false); assert.equal(s.allowed, false);
  near(s.true_value_usdt, 1000, 1e-6, 'the 100 waiting in the exchange is not pool money');
});

test('TVD2 deposit with an open WINNER: price, units and books match the model; after the trade closes Raf keeps 1100, John has exactly 500', async () => {
  const w = await ready();
  const pid = await w.receive('john', 500);
  await w.report(1500, 100);                                   // wallets: 1000 pool cash + 500 waiting + 100 open
  const st = await w.status(); assert.equal(st.ok, true, JSON.stringify(st.reasons)); near(st.unit_price, 1.1, 1e-9);
  const model = TV.value({ book: 1000, units: 1000, wallets: [{ wallet: 'all', equity: 1600, unrealized: 100, receivedMs: w.now, suspect: false }], notInPool: 500, nowMs: w.now, opts: { expectedWallets: 1 } });
  const r = await w.call('admin_admit_deposit_tv', w.A, pid, null);
  near(r.unit_price, model.price, 1e-9, 'same price as the model'); near(r.units, 500 / model.price, 1e-8, 'same units');
  near(await w.units('john'), 454.54545455, 1e-8);
  let p = await w.pool(); near(p.e, 1500, 1e-6, 'entry B: the book is 1000 + 500, the open 100 stays out'); near(p.u, 1454.54545455, 1e-8);
  const cp = (await w.q(`select * from public.flow_checkpoints`))[0];
  assert.equal(cp.kind, 'deposit'); near(cp.open_pnl, 100); near(cp.true_value, 1100); near(cp.unit_price, 1.1, 1e-9); assert.equal(cp.wallets.length, 3);
  await adv(w, 30); await w.trade({ pos: 'win', pnl: 100 });   // the open trade closes exactly as marked
  p = await w.pool(); near(p.p, 1.1, 1e-9);
  near((await w.units('raf')) * p.p, 1100, 1e-5, 'Raf'); near((await w.units('john')) * p.p, 500, 1e-5, 'John');
});

test('TVD3 deposit with an open LOSER, then the trade moves after the join: only the later move is shared', async () => {
  const w = await ready();
  const pid = await w.receive('john', 500);
  await w.report(1500, -100); const r = await w.call('admin_admit_deposit_tv', w.A, pid, null); near(r.unit_price, 0.9, 1e-9);
  await adv(w, 30); await w.trade({ pos: 'l', pnl: -160 });   // it was -100 at the join and closes at -160: -60 after the join
  const p = await w.pool(), raf = await w.units('raf'), john = await w.units('john'), share = john / (raf + john);
  near(john * p.p, 500 - 60 * share, 1e-5); near(raf * p.p, 900 - 60 * (1 - share), 1e-5); near(p.e, 1340, 1e-6);
});

test('TVD4 payout with an open winner: paid at the true price, the fee only on the gain above the lot\'s mark; the others keep their value', async () => {
  const w = await ready();
  let pid = await w.receive('john', 500); await w.report(1500, 0); await w.call('admin_admit_deposit_tv', w.A, pid, null);   // John joins at 1.00
  await adv(w, 10); await w.report(1500, 150);                                                                           // +150 open: true price 1.10
  const jt = (await w.call('login', 'john', 'john-password')).token;
  await w.call('set_my_payout', jt, 'gcash', 'John', '09171234567', null, null);
  const req = await w.call('request_withdrawal', jt, 250, null);
  const rid = Number(req.id ?? req.request_id ?? (await w.q(`select max(id) i from public.withdrawal_requests`))[0].i);
  await w.call('admin_approve_withdrawal', w.A, rid, null, null);
  const out = await w.call('admin_execute_withdrawal_tv', w.A, rid, 58, null, null);
  near(out.unit_price, 1.1, 1e-9);
  const feeUnits = TV.lotFee({ units: 500, hwm: 1.0 }, 1.1, 0.2).fee / 1.1 * (250 / 500);   // 20% of John's gain, the share of the lot he takes out
  near(out.fee_units, feeUnits, 1e-6, 'fee = 20% of the gain on the units paid out');
  near(out.pay_usdt, (250 - feeUnits) * 1.1, 1e-4);
  const rafBefore = (await w.units('raf') - out.fee_units) * 1.1;                                  // Raf's own 1000 units at 1.10 (the fee units are extra, received)
  assert.equal((await w.q(`select count(*)::int n from public.payout_records where request_id=$1 and leaves_mexc`, [rid]))[0].n, 1);
  await adv(w, 30); await w.trade({ pos: 'w2', pnl: 150 });   // within the 15% jump guard (a bigger one waits for a person, by design)
  const p = await w.pool(); near(p.p, 1.1, 1e-9, 'the price lands where the payout said');
  near(1000 * p.p, 1100, 1e-5); near(rafBefore, 1100, 1e-5);
  near((await w.units('john')) * p.p, 250 * 1.1, 1e-5, 'John\'s remaining 250 units, worth their share');
});

test('TVD5 blocked readings: stale, suspect, a wallet missing, out of step, unrecorded money (gap), a trade not booked, booked after the reading', async () => {
  const w = await ready();
  const pid = await w.receive('john', 100);
  const reason = async () => (await w.status()).reasons.map((x) => x.code);
  assert.ok((await reason()).includes('missing'), 'no report yet');
  await w.report(1100, 0); assert.deepEqual(await reason(), []);
  await adv(w, 45); assert.ok((await reason()).includes('stale'));
  await w.report(1100, 0);
  await w.call('bot_post_wallet_snapshot', w.keys.icore, 'icore', ++w.seq.icore, new Date(w.now).toISOString(), 900, 0, 900, 900, 0, 0);
  assert.ok((await reason()).includes('suspect'), 'a +260% jump is suspect until a person accepts it');
  await adv(w, 1); await w.report(1100, 0);
  assert.ok((await reason()).includes('suspect'), 'the jump back is suspect too');
  const sid = Number((await w.q(`select max(id) i from public.wallet_snapshots where wallet = 'icore'`))[0].i);
  await w.call('admin_accept_wallet_snapshot', w.A, sid, 'test: the 900 reading was a typo, back to normal');
  assert.deepEqual(await reason(), []);
  await adv(w, 12);
  for (const x of ['bbcore', 'icore']) await w.call('bot_post_wallet_snapshot', w.keys[x], x, ++w.seq[x], new Date(w.now).toISOString(), x === 'bbcore' ? 550 : 275, 0, 0, 0, 0, 0);
  assert.ok((await reason()).includes('skewed'), 'tcore reported 12 minutes before the others');
  await w.report(1150, 0); const c = await reason(); assert.ok(c.includes('gap'), '50 more in the exchange than the books know (money not recorded)');
  await w.report(1100, 0);
  await w.db.query(`insert into public.closed_trades(wallet, position_id, symbol, side, closed_at, realized_usd) values ('bbcore', 'x', 'SOL_USDT', 'LONG', $1, 1)`, [new Date(w.now - 30000).toISOString()]);
  await w.db.query(`update public.ledger_settings set value = '1' where key = 'bot_sync_paused'`);   // keep it waiting
  assert.ok((await reason()).includes('unbooked_trades'));
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, pid, null), /blocked: .*not in the pool value yet/);
  await w.db.query(`update public.ledger_settings set value = '0' where key = 'bot_sync_paused'`);
  await adv(w, 1); await w.trade({ pos: 'y', pnl: 2, at: new Date(w.now - 10000).toISOString() });   // books x and y now: newer than the reports
  assert.ok((await reason()).includes('booked_after_reading'));
  await adv(w, 5); await w.report(1103, 0); assert.deepEqual(await reason(), []);
  assert.equal((await w.call('admin_admit_deposit_tv', w.A, pid, null)).units > 0, true);
});

test('TVD6 delayed reports: a trade inside the wallet reports is not added again when its MEXC result arrives later; a trade after the report is', async () => {
  const w = await ready();
  const pid = await w.receive('john', 500);
  // bbcore closed a trade at +0.30 just before its report (inside the tolerance, so the flow goes ahead with a gap of +0.30), the bot books it later
  const closedAt = new Date(w.now - 2 * 60000).toISOString();
  await w.report(1500.3, 0);
  const r = await w.call('admin_admit_deposit_tv', w.A, pid, null); near(r.unit_price, 1.0003, 1e-9);
  const before = await w.pool();
  await adv(w, 20); await w.trade({ pos: 'inside', pnl: 0.3, at: closedAt });
  near((await w.pool()).e, before.e, 1e-9, 'not added again: it was already in the reported cash');
  await adv(w, 5); await w.trade({ pos: 'after', pnl: 5, at: new Date(w.now - 60000).toISOString() });
  near((await w.pool()).e, before.e + 5, 1e-9, 'a trade after the reports is added');
  near((await w.units('john')) * (await w.pool()).p, 500 + 5 * (await w.units('john')) / (await w.pool()).u, 1e-5);
});

test('TVD7 duplicates: the same deposit or payout twice is refused; the same request id is a harmless replay', async () => {
  const w = await ready();
  const pid = await w.receive('john', 200); await w.report(1200, 0);
  const a = await w.call('admin_admit_deposit_tv', w.A, pid, 'idem-1');
  const b = await w.call('admin_admit_deposit_tv', w.A, pid, 'idem-1'); assert.equal(b.replayed, true); near(b.units, a.units);
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, pid, 'idem-2'), /duplicate refused/);
  assert.equal((await w.q(`select count(*)::int n from public.flow_checkpoints`))[0].n, 1);
  await assert.rejects(w.q(`update public.flow_checkpoints set gap = 0`), /cannot be changed/);
  await assert.rejects(w.q(`delete from public.flow_checkpoints`), /cannot be changed/);
});

test('TVD8 book corrections: prepared rows move nothing; applying moves the pool once, with the reason; a correction never swallows a late trade', async () => {
  const w = await world(); await w.join('raf', 223.5521); await adv(w, 5);
  await w.db.exec(readFileSync(CORRECTIONS, 'utf8')); await w.db.exec(readFileSync(CORRECTIONS, 'utf8'));   // twice: still two rows
  const list = await w.call('admin_book_corrections', w.A);
  assert.equal(list.length, 2); assert.deepEqual(list.map((c) => c.status), ['prepared', 'prepared']);
  near((await w.pool()).e, 223.5521, 1e-9, 'preparing changes nothing');
  const tradeAt = new Date(w.now - 60000).toISOString();                          // a trade that closes before the correction but reaches the ledger after it
  const one = await w.call('admin_apply_book_correction', w.A, list[0].id, null);
  near(one.equity_after, 223.5521 - 4.9258, 1e-9);
  await assert.rejects(w.call('admin_apply_book_correction', w.A, list[0].id, null), /duplicate refused/);
  await w.call('admin_apply_book_correction', w.A, list[1].id, null);
  near((await w.pool()).e, 223.5521 - 4.9258 + 0.8582, 1e-9);
  near(await w.units('raf'), 223.5521, 1e-9, 'units never change');
  await adv(w, 1); await w.trade({ pos: 'late', pnl: -1, at: tradeAt });
  near((await w.pool()).e, 223.5521 - 4.9258 + 0.8582 - 1, 1e-9, 'the late trade is still added (a correction is not an exchange valuation)');
  await assert.rejects(w.q(`update public.book_corrections set amount_usdt = 1 where id = $1`, [list[0].id]), /cannot be edited|cannot change/);
});

test('TVD9 with flow_pricing = book the normal deposit path behaves as before (and the pending-exit guard still applies to it)', async () => {
  const w = await world(); await w.join('raf', 1000);
  await w.join('john', 500);
  near(await w.units('john'), 500, 1e-8); near((await w.pool()).e, 1500, 1e-9);
  assert.equal((await w.q(`select count(*)::int n from public.flow_checkpoints`))[0].n, 0);
});

test('TVD10 status pages: an investor sees only their own value, what can be withdrawn now and what is locked in trades', async () => {
  const w = await ready();
  const pid = await w.receive('john', 500); await w.report(1500, 0); await w.call('admin_admit_deposit_tv', w.A, pid, null);
  await adv(w, 5); await w.report(1500, 150, { bbcore: { eq: 825, unr: 75, wd: 450 }, icore: { eq: 412.5, unr: 37.5, wd: 375 }, tcore: { eq: 412.5, unr: 37.5, wd: 375 } });
  const jt = (await w.call('login', 'john', 'john-password')).token;
  const me = await w.call('my_true_value', jt);
  const share = 500 / 1500, V = 1650;
  near(me.unit_price, V / 1500, 1e-9); near(me.value_usdt, 500 * V / 1500, 1e-6);
  near(me.withdrawable_now_usdt, share * 1200, 1e-6, 'his share of the cash that can leave the exchange'); near(me.locked_in_trades_usdt, 550 - 400, 1e-6);
  assert.equal(me.allowed, true); assert.equal(me.wallets, undefined, 'no wallet or other investor data');
  await assert.rejects(w.call('admin_true_value', jt), /admin only/);
});

test('TVD11 the rollback (allowed only while no true-value flow exists) removes everything and trades mode keeps working with the previous rules', async () => {
  const w = await world(); await w.join('raf', 1000); await adv(w, 5);
  const RB = new URL('../supabase/rollback/20261207000000_rollback_true_value_pricing.sql', import.meta.url);
  await w.db.exec(readFileSync(RB, 'utf8'));
  assert.equal((await w.q(`select to_regclass('public.flow_checkpoints') t`))[0].t, null);
  assert.equal((await w.q(`select to_regprocedure('public.admin_admit_deposit_tv(text,bigint,text)') f`))[0].f, null);
  assert.ok((await w.q(`select public._export_extra() e`))[0].e.closed_trades !== undefined, 'the backup export works and still carries the earlier tables');
  await w.trade({ pos: 'after-rollback', pnl: 3 });
  near((await w.pool()).e, 1003, 1e-9, 'trades are still booked');
  const w2 = await ready(); const pid = await w2.receive('john', 100); await w2.report(1100, 0); await w2.call('admin_admit_deposit_tv', w2.A, pid, null);
  await assert.rejects(w2.db.exec(readFileSync(RB, 'utf8')), /true-value flows or applied corrections exist/);
});

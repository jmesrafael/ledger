// Remaining accounting risks (supabase/migrations/20261109000000_settlement_controls_backup.sql + scripts/restore-ledger.mjs):
// complete backup + restore, the settlement window (Manila time, late and merged settlements), reconciliation or an audited exception,
// no fees on open-trade gains without an exception, and no way around the controls. The full migration chain as it runs in production
// (applied/*) plus the pending migrations on an in-memory Postgres; every call goes in as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { buildRestoreSql } from '../scripts/restore-ledger.mjs';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl)),
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir))];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);
const BOOT = `create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`;
const NOTE = 'checked the MEXC total against the MEXC app by hand';
const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };

async function fresh() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(BOOT);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; update public.ledger_settings set value = '1000' where key = 'valuation_max_move';`);
  return db;
}

async function world({ users = ['john', 'dino'] } = {}) {
  const db = await fresh();
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => {
    await db.exec('set role anon');
    try { return (await db.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); }
  };
  const q = async (sql, a = []) => (await db.query(sql, a)).rows;
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await q(`select id from public.profiles where username='raf'`))[0].id };
  for (const u of users) ids[u] = await call('admin_create_user', A, u, u, u + '-password', 0.1);
  const at = (d) => `2026-${d}T04:00:00Z`;                                        // 12:00 Manila
  const w = { db, call, q, A, ids, at };
  w.nav = async () => Number((await q(`select equity_usdt e from public.pool_equity order by id desc limit 1`))[0]?.e ?? 0);
  w.price = async () => Number((await q(`select unit_price p from public.pool_equity order by id desc limit 1`))[0].p);
  w.units = async (who) => Number((await q(`select coalesce(sum(units),0) u from public.ledger where profile_id=$1`, [ids[who]]))[0].u);
  w.total = async (p) => (await w.nav()) / (await w.price()) * p;                  // MEXC total that puts the unit price at p
  w.join = async (who, usdt, d) => {
    await call('admin_receive_deposit', A, ids[who], usdt, 58, usdt * 58, null, at(d), null, true);
    const first = (await q(`select count(*)::int n from public.pool_equity`))[0].n === 0;
    return call('admin_post_equity', A, first ? usdt : (await w.total(await w.price())) + usdt, 58, null, at(d));
  };
  w.reading = async (p, d) => call('admin_post_equity', A, await w.total(p), 58, null, at(d));
  w.withdraw = async (who, units, p, d) => call('admin_withdraw', A, ids[who], units, await w.total(p), 58, null, true, null, at(d));
  // an audited exception for a period that cannot be reconciled with MEXC (no bot snapshot yet)
  w.except = async (p, d, kind = 'unreconciled', open = 0) => call('admin_approve_settlement_exception', A, kind, await w.total(p), NOTE, at(d), open);
  w.settle = async (p, d, { idem = null, unrec = true } = {}) => {
    const t = await w.total(p);
    if (unrec) await call('admin_approve_settlement_exception', A, 'unreconciled', t, NOTE, at(d), 0);
    return call('admin_close_quarter', A, t, 58, null, at(d), idem);
  };
  w.hwm = async (who) => Number((await q(`select hwm_value v from public.investor_hwm where profile_id=$1`, [ids[who]]))[0]?.v ?? NaN);
  w.fee = async (who, eq) => Number((await q(`select coalesce(sum(fee_usdt),0) f from public.settlement_lines where profile_id=$1 and ($2::bigint is null or equity_id=$2)`, [ids[who], eq]))[0].f);
  w.botKey = async () => {
    await db.query(`insert into public.ledger_settings(key,value) values ('bot_key_hash', encode(extensions.digest('k','sha256'),'hex')) on conflict (key) do update set value=excluded.value`);
    return 'k';
  };
  return w;
}

// ============================================================ 1. backups
test('R1 the backup covers every ledger table; a new table that is not covered is reported', async () => {
  const w = await world();
  await w.join('john', 1000, '01-05');
  const c = await w.call('admin_backup_coverage', w.A);
  assert.deepEqual(c.missing, [], `tables missing from the backup: ${c.missing}`);
  const x = (await w.q(`select public._export_all() x`))[0].x;
  for (const k of ['payout_details', 'idempotency_keys', 'settlement_exceptions', 'holder_state', 'investor_hwm', 'settlements', 'balance_verifications']) assert.ok(Array.isArray(x[k]), `export is missing ${k}`);
  assert.equal(x.people.some((p) => 'pass_hash' in p), false, 'no password hashes in a backup');
  await w.db.exec(`create table public.zz_new_ledger_table (id int)`);
  assert.deepEqual((await w.call('admin_backup_coverage', w.A)).missing, ['zz_new_ledger_table'], 'an uncovered table is caught');
});

test('R2 a backup restores into an empty database with every accounting record and the same numbers; it refuses a database that has data', async () => {
  const w = await world();
  await w.join('raf', 500, '01-05'); await w.join('john', 1000, '01-06'); await w.join('dino', 600, '01-07');
  await w.reading(1.2, '02-10');
  await w.withdraw('john', 300, 1.2, '02-12');
  const J = (await w.call('login', 'john', 'john-password')).token;
  await w.call('set_my_payout', J, 'gcash', 'John', '09171234567', null, null);
  await w.settle(1.3, '03-02');
  await w.join('dino', 200, '03-10');
  const x = (await w.q(`select public._export_all() x`))[0].x;
  assert.ok(x.settlement_exceptions.length === 1 && x.payout_details.length === 1 && x.settlements.length === 1 && x.investor_hwm.length === 2);

  const sql = buildRestoreSql(x);
  const db2 = await fresh();
  await db2.exec(sql);
  const y = (await db2.query(`select public._export_all() x`)).rows[0].x;
  const norm = (rows) => JSON.stringify([...rows].map((r) => JSON.stringify(r)).sort());
  for (const k of Object.keys(x)) {
    if (k === 'exported_at' || k === 'format') continue;
    if (k === 'checks') { assert.deepEqual(y.checks, x.checks, 'checks'); continue; }
    if (k === 'people') { assert.equal(y.people.length, x.people.length); continue; }
    if (k === 'settings') { for (const s of x.settings) assert.equal(y.settings.find((z) => z.key === s.key)?.value, s.value, `setting ${s.key}`); continue; }
    assert.equal(norm(y[k]), norm(x[k]), `table ${k} differs after the restore`);
  }
  const hs = async (d) => (await d.query(`select p.username, (public._holder_summary(p.id)->>'value_usdt')::numeric v, case when p.role = 'investor' then public._hwm_value(p.id) end h from public.profiles p order by 1`)).rows.map((r) => [r.username, Number(r.v), r.h == null ? null : Number(r.h)]);
  assert.deepEqual(await hs(db2), await hs(w.db), 'every value and high-water mark is the same');
  // ids continue, the restored copy keeps working, and the integrity report is clean
  await db2.exec(`update public.profiles set pass_hash = public._hash('admin-password-1') where username = 'raf'`);
  const call2 = async (fn, ...a) => { await db2.exec('set role anon'); try { return (await db2.query(`select public.${fn}(${a.map((_, i) => '$' + (i + 1)).join(',')}) as r`, a)).rows[0].r; } finally { await db2.exec('reset role'); } };
  const A2 = (await call2('login', 'raf', 'admin-password-1')).token;
  assert.equal((await call2('admin_integrity_report', A2)).worst, -1, 'integrity report is clean after the restore');
  const rid = await call2('admin_receive_deposit', A2, w.ids.john, 50, 58, 2900, null, null, null, true);
  assert.ok(Number(rid.id) > Math.max(...x.pending_deposits.map((d) => d.id)), 'new ids continue after the restored ones');
  assert.match(await err(() => db2.exec(sql)), /restore refused/, 'a second restore into the same database is refused');
});

// ============================================================ 2. the settlement window (Manila time)
test('R3 on time (within 7 days), late (refused without an audited exception), and a missed window merges into the next one', async () => {
  const w = await world({ users: ['john'] });
  await w.join('john', 1000, '01-03');
  await w.reading(1.1, '02-20');
  // Jan-Feb ends 2026-03-01 00:00 Manila = 2026-02-28T16:00Z
  assert.match(await err(() => w.call('admin_close_quarter', w.A, 1100, 58, null, '2026-02-28T15:59:00Z', null)), /no settlement period has ended yet/, '23:59 Manila on 28 Feb is still inside the period');
  const early = await w.settle(1.1, '03-03');                              // 3 Mar: inside the window
  assert.equal(early.late, false);
  const row = (await w.q(`select late, covered_from, covered_to, days_after_period_end, array_length(exception_ids,1) n from public.settlements`))[0];
  assert.equal(row.late, false); assert.equal(row.n, 1);
  near(row.days_after_period_end, 2.5, 1e-6);                              // 12:00 Manila on 3 Mar is 2.5 days after 00:00 on 1 Mar
  assert.equal(new Date(row.covered_from).toISOString(), '2026-01-03T04:00:00.000Z', 'covers from the first entry');

  // a different world: the March window is missed
  const v = await world({ users: ['john'] });
  await v.join('john', 1000, '01-03');
  await v.reading(1.1, '02-20');
  const t = await v.total(1.1);
  assert.match(await err(() => v.call('admin_close_quarter', v.A, t, 58, null, v.at('03-09'), null)), /LATE: the settlement window for the period ending 2026-02-28 closed on 2026-03-07/);
  assert.match(await err(() => v.settle(1.1, '03-09')), /LATE/, 'a reconciliation exception does not excuse lateness');
  // missed window: wait for the next one (from 1 May). It covers everything since the pool began; nothing is skipped
  await v.reading(1.2, '04-15');
  const s = await v.settle(1.2, '05-03');
  assert.equal(s.late, false);
  const r2 = (await v.q(`select covered_from, period_end from public.settlements`))[0];
  assert.equal(new Date(r2.covered_from).toISOString(), '2026-01-03T04:00:00.000Z', 'the May settlement covers from the start');
  near(await v.fee('john'), 20, 1e-5);                                     // 10% of the whole 200 gain, once
  // late is possible only with an approved, audited exception, and it is recorded
  const x = await world({ users: ['john'] });
  await x.join('john', 1000, '01-03'); await x.reading(1.1, '02-20');
  await x.except(1.1, '03-09', 'late', null);
  const late = await x.settle(1.1, '03-09');
  assert.equal(late.late, true);
  const lr = (await x.q(`select late, array_length(exception_ids,1) n from public.settlements`))[0];
  assert.equal(lr.late, true); assert.equal(lr.n, 2);
  const act = (await x.q(`select action from public.audit_log where action like 'settlement%' order by id`)).map((r) => r.action);
  assert.deepEqual(act, ['settlement_exception_late', 'settlement_exception_unreconciled', 'settlement_closed'], 'every exception and the settlement are in the activity log');
  assert.match(await err(() => x.settle(1.1, '03-10')), /already settled; the next settlement is allowed from 2026-05-01/, 'nothing can follow a day later');
});

// ============================================================ 3. reconciliation or an audited exception
test('R4 no verification and no exception: refused; the exception names the open positions, is audited, applies to one total, and is used once', async () => {
  const w = await world({ users: ['john'] });
  await w.join('raf', 500, '01-05'); await w.join('john', 1000, '01-06');
  await w.reading(1.2, '02-20');
  const t = await w.total(1.2);
  assert.match(await err(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), null)), /RECONCILE: .*approve an exception/);
  const pv = await w.call('admin_settlement_preview', w.A, t, w.at('03-02'));
  assert.equal(pv.can_settle, false); assert.match(pv.blocked_reasons[0], /RECONCILE/);
  // the older call (no open positions declared) cannot be used to get around the control
  assert.match(await err(() => w.call('admin_attest_settlement', w.A, t, NOTE, w.at('03-02'))), /say how many positions and orders are open/);
  assert.equal((await w.q(`select count(*)::int n from public.settlement_exceptions`))[0].n, 0, 'nothing was recorded');
  assert.match(await err(() => w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t, 'too short', w.at('03-02'), 0)), /at least 20 characters/);
  assert.match(await err(() => w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t, NOTE, w.at('03-02'), null)), /how many positions/);
  const J = (await w.call('login', 'john', 'john-password')).token;
  assert.match(await err(() => w.call('admin_approve_settlement_exception', J, 'unreconciled', t, NOTE, w.at('03-02'), 0)), /admin only/);
  await w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t + 40, NOTE, w.at('03-02'), 0);       // another total
  assert.match(await err(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), null)), /RECONCILE/, 'an exception for a different total does not apply');
  await w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t, NOTE, w.at('03-02'), 0);
  const s = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), 'k1');
  assert.equal(s.recon_status, 'unverified'); assert.equal(s.exception_ids.length, 1);
  assert.deepEqual(await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), 'k1'), { ...s, replayed: true }, 'a retry with the same request id replays');
  assert.match(await err(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-03'), 'k2')), /already settled/, 'a new request for the same period is refused');
  assert.equal((await w.q(`select public._settlement_exception('unreconciled', period_end, mexc_total) x from public.settlements`))[0].x, null, 'a used exception cannot be used again');
  const row = (await w.q(`select s.attestation_id, x.note, x.open_positions from public.settlements s join public.settlement_exceptions x on x.id = s.exception_ids[1]`))[0];
  assert.ok(row.attestation_id && row.note === NOTE && row.open_positions === 0);
  // records are immutable
  for (const sql of [`update public.settlement_exceptions set note = 'x'`, `delete from public.settlement_exceptions`, `update public.settlements set fee_usdt = 0`, `delete from public.settlement_lines`])
    assert.ok(await err(() => w.db.exec(sql)), sql);
});

test('R5 an unmatched MEXC transfer or an internal mismatch can never be excepted', async () => {
  const w = await world({ users: ['john'] });
  await w.join('john', 1000, '01-05'); await w.reading(1.1, '02-20');
  const t = await w.total(1.1);
  const key = await w.botKey();
  await w.call('bot_post_snapshot', key, t, 0, 0, 0, 0, JSON.stringify([{ id: 'x1', ts: '2026-02-10T00:00:00Z', dir: 'in', usdt: 77 }]), true);
  assert.match(await err(() => w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t, NOTE, w.at('03-02'), 0)), /cannot be explained away/);
  assert.match(await err(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), null)), /not matched|settlement refused/);
});

// ============================================================ 4. fees on unrealized gains
test('R6 open positions: no settlement (and no fee) without an open_positions exception, on every route', async () => {
  // a confirmed balance check that says one position is open
  const w = await world({ users: ['john'] });
  await w.join('raf', 500, '01-05'); await w.join('john', 1000, '01-06'); await w.reading(1.2, '02-20');
  const t = await w.total(1.2);
  const v = await w.call('admin_enter_balance', w.A, t, 1, 0, 'one trade still open', null);
  if (Math.abs(Number(v.residual)) > 0) await w.call('admin_classify_difference', w.A, v.id, 'trading_pnl', 'two months of trades per the bot log');
  await w.call('admin_confirm_balance', w.A, v.id, null);
  const pv = await w.call('admin_settlement_preview', w.A, t, w.at('03-02'));
  assert.equal(pv.can_settle, false); assert.match(pv.blocked_reasons.join(' '), /OPEN TRADES: 1 position/);
  assert.match(await err(() => w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), null)), /OPEN TRADES/);
  assert.equal((await w.q(`select count(*)::int n from public.settlements`))[0].n, 0, 'nothing saved');
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind='fee_in'`))[0].n, 0, 'no fee taken');
  await w.call('admin_approve_settlement_exception', w.A, 'open_positions', t, 'trades are still open; the manager accepts fees on their paper gain', w.at('03-02'), 1);
  const s = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-02'), null);
  assert.equal(s.recon_status, 'verified_manual');
  assert.equal((await w.q(`select open_positions_at_settlement n from public.settlements`))[0].n, 1);
  near(await w.fee('john'), 20, 1e-5);

  // a bot snapshot that is clean but shows an open order
  const v2 = await world({ users: ['john'] });
  await v2.join('john', 1000, '01-05'); await v2.reading(1.1, '02-20');
  const t2 = await v2.total(1.1);
  const key = await v2.botKey();
  await v2.call('bot_post_snapshot', key, t2, 0, 1, 0, 0, '[]', true);
  assert.match(await err(() => v2.call('admin_close_quarter', v2.A, t2, 58, null, v2.at('03-02'), null)), /OPEN TRADES: 1 position/);
  // a declared-flat exception on an unreconciled period needs no open_positions exception
  const v3 = await world({ users: ['john'] });
  await v3.join('john', 1000, '01-05'); await v3.reading(1.1, '02-20');
  assert.equal((await v3.settle(1.1, '03-02')).investors_charged, 1);
});

// ============================================================ 5. the whole life of a pool
test('R7 deposits, withdrawals, profits, losses, partial and full exits, a redeposit and repeated requests: fees only on real new profit', async () => {
  const w = await world({ users: ['john', 'dino'] });
  await w.join('raf', 500, '01-05'); await w.join('john', 1000, '01-06'); await w.join('dino', 1000, '01-07');
  await w.reading(1.2, '02-10');
  const wd = await w.withdraw('john', 500, 1.2, '02-11');                              // partial exit in profit: fee on its half of the 200 gain
  near(Number(wd.fee_units) * 1.2, 10, 1e-5);
  near(await w.hwm('john'), 500, 1e-6);
  const s1 = await w.settle(1.1, '03-02');                                             // john 500u x 1.1 = 550 vs mark 500; dino 1100 vs 1000
  near(await w.fee('john'), 5, 1e-5);                                                  // the withdrawal fee (10) is not a settlement line; only the 50 gain on the half that stayed
  const l1 = await w.q(`select p.username, l.eligible_profit, l.fee_usdt from public.settlement_lines l join public.profiles p on p.id = l.profile_id where l.equity_id = (select equity_id from public.settlements where id = $1) order by 1`, [s1.settlement_id]);
  near(l1.find((r) => r.username === 'john').fee_usdt, 5, 1e-5); near(l1.find((r) => r.username === 'dino').fee_usdt, 10, 1e-5);
  assert.equal(l1.some((r) => r.username === 'raf'), false, 'the manager\'s own investment pays no fee');
  const s2 = await w.settle(0.8, '05-03');                                             // a losing period
  near(s2.fee_usdt, 0);
  const dinoMark = await w.hwm('dino');
  const dinoE = (await w.units('dino')) * 0.8;
  await w.withdraw('dino', await w.units('dino'), 0.8, '06-01');                       // full exit at a loss: no fee, the shortfall stays
  assert.equal(await w.units('dino'), 0);
  near(await w.hwm('dino'), dinoMark - dinoE, 1e-4);
  await w.join('dino', 1000, '06-10');                                                 // redeposit: the old loss is NOT forgiven
  near(await w.hwm('dino'), dinoMark - dinoE + 1000, 1e-4);
  const s3 = await w.settle(0.9, '07-02');                                             // price recovers from 0.8 but dino is still below his mark
  near(s3.fee_usdt, 0);
  const idem = 'settle-4';
  const s4 = await w.settle(1.2, '09-02', { idem });
  const dinoE4 = (await w.units('dino')) + Number((await w.q(`select coalesce(sum(fee_units),0) f from public.settlement_lines where profile_id=$1 and equity_id=(select equity_id from public.settlements where id=$2)`, [w.ids.dino, s4.settlement_id]))[0].f);
  near(await w.fee('dino', (await w.q(`select equity_id from public.settlements where id=$1`, [s4.settlement_id]))[0].equity_id), 0.1 * (dinoE4 * 1.2 - (dinoMark - dinoE + 1000)), 1e-3);
  // repeated requests
  const again = await w.call('admin_close_quarter', w.A, await w.total(1.2), 58, null, w.at('09-02'), idem);
  assert.equal(again.replayed, true); assert.equal(again.settlement_id, s4.settlement_id);
  assert.match(await err(() => w.call('admin_close_quarter', w.A, 100, 58, null, w.at('09-03'), 'other')), /already settled/);
  assert.equal((await w.q(`select count(*)::int n from public.settlements`))[0].n, 4);
  // the books
  assert.equal((await w.call('admin_integrity_report', w.A)).worst, -1);
  near((await w.q(`select coalesce(sum(units),0) s from public.ledger`))[0].s, (await w.q(`select total_units t from public.pool_equity order by id desc limit 1`))[0].t, 1e-8);
  near((await w.q(`select coalesce(sum(units),0) s from public.ledger where kind in ('fee_in','fee_out')`))[0].s, 0, 1e-8);
});

// ============================================================ 6. no way around the controls
test('R8 a close cannot be written directly; the records cannot be changed; investors and anonymous callers have no access', async () => {
  const w = await world({ users: ['john'] });
  await w.join('john', 1000, '01-05');
  const direct = await err(() => w.db.exec(`insert into public.pool_equity(ts, kind, equity_usdt, total_units, unit_price) values ('2026-03-02T04:00:00Z', 'close', 1100, 1000, 1.1)`));
  assert.match(direct, /a settlement can only be made through admin_close_quarter/);
  const J = (await w.call('login', 'john', 'john-password')).token;
  for (const [fn, args] of [['admin_close_quarter', [J, 1100]], ['admin_approve_settlement_exception', [J, 'late', 1100, NOTE]], ['admin_settlement_preview', [J, 1100]], ['admin_backup_coverage', [J]]])
    assert.match(await err(() => w.call(fn, ...args)), /admin only/, fn);
  await w.db.exec('set role anon');
  for (const t of ['settlements', 'settlement_lines', 'settlement_exceptions', 'investor_hwm', 'ledger', 'payout_details'])
    assert.ok(await err(() => w.db.query(`select * from public.${t}`)), `anon can read ${t}`);
  for (const fn of ['_settlement_requirements', '_export_all', '_settle_guard'])
    assert.ok(await err(() => w.db.query(`select public.${fn}(1)`)), `anon can call ${fn}`);
  await w.db.exec('reset role');
  assert.ok(await err(() => w.db.exec(`update public.pool_equity set equity_usdt = 1`)), 'pool entries cannot be edited');
});

// Remaining accounting risks (supabase/migrations/20261109000000_settlement_controls_backup.sql + scripts/restore-ledger.mjs):
// complete backup + restore, the settlement window (Manila time, late and merged settlements), reconciliation or an audited exception,
// no fees on open-trade gains without an exception, and no way around the controls. The full migration chain as it runs in production
// (applied/*) plus the pending migrations on an in-memory Postgres; every call goes in as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { buildRestoreSql, splitTopLevel } from '../scripts/restore-ledger.mjs';

const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const APPLIED = readdirSync(appl).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, appl));
const PENDING = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => new URL(f, dir));
const FILES = [...APPLIED, ...PENDING];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);
const BOOT = `create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`;
const CLOCK_SQL = `create or replace function public._clock() returns timestamptz language sql stable as $$ select coalesce(nullif(current_setting('test.clock', true), '')::timestamptz, '2000-01-01T00:00:00Z'::timestamptz) $$;`;   // tests set the recording time with: set test.clock = '...' (default: the year 2000, before every date used here)
const NOTE = 'checked the MEXC total against the MEXC app by hand';
const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };

async function fresh(pending = true) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(BOOT);
  for (const f of pending ? FILES : APPLIED) await db.exec(readFileSync(f, 'utf8'));
  if (pending) await db.exec(CLOCK_SQL);
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'; update public.ledger_settings set value = '1000' where key = 'valuation_max_move';`);
  return db;
}

async function world({ users = ['john', 'dino'], pending = true } = {}) {
  const db = await fresh(pending);
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
  w.clock = async (iso) => db.exec(`set test.clock = '${iso}'`);                    // the moment the next settlement is being recorded
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

  const sql = buildRestoreSql((await w.q(`select public._export_all()::text x`))[0].x);        // the raw text, exactly like a backup file
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

test('R2b a restore is exact to the last digit, tolerates the optional draft archives, and the splitter reads awkward text safely', async () => {
  const w = await world({ users: ['john'] });
  await w.join('raf', 500, '01-05'); await w.join('john', 1000, '01-06');
  await w.reading(1.1, '02-10');
  // a database that once ran the earlier trial migration has two archive tables a fresh project does not have
  await w.db.exec(`create table public.investor_perf_draft_archive (profile_id uuid, hwm_value numeric); insert into public.investor_perf_draft_archive values (gen_random_uuid(), 1.5);
                   create table public.perf_log_draft_archive (id bigserial primary key, note text); insert into public.perf_log_draft_archive(note) values ('has "quotes", {braces} and a \\ backslash')`);
  // a 24-digit number, as PostgreSQL stores marks and prices (a JavaScript number would keep 17)
  await w.db.exec(`update public.investor_hwm set hwm_value = 182.034541742533754240015171 where profile_id = '${w.ids.john}'`);
  const text = (await w.q(`select public._export_all()::text x`))[0].x;
  assert.ok(text.includes('182.034541742533754240015171'), 'the export carries all 24 digits');
  const db2 = await fresh();
  await db2.exec(buildRestoreSql(text));
  assert.equal((await db2.query(`select hwm_value::text v from public.investor_hwm where profile_id = '${w.ids.john}'`)).rows[0].v, '182.034541742533754240015171', 'restored to the last digit');
  const t = async (d) => (await d.query(`select public._export_all()::text x`)).rows[0].x;
  const strip = (j) => { const o = JSON.parse(j); return JSON.stringify(['ledger', 'pool_equity', 'investor_hwm', 'settings'].map((k) => o[k].map((r) => JSON.stringify(r)).sort())); };
  assert.equal(strip(await t(db2)), strip(text), 'every restored table equals the original');
  assert.equal((await db2.query(`select to_regclass('public.investor_perf_draft_archive') x`)).rows[0].x, null, 'the optional archive was skipped, not invented');
  // the splitter: strings with quotes, braces and backslashes do not confuse it; a cut-off file is rejected
  const o = splitTopLevel('{"a": [1, {"b": "x]\\\\"}, "c"], "n": 0.123456789012345678901234, "s": "}", "t": {"u": []}}');
  assert.deepEqual(Object.keys(o), ['a', 'n', 's', 't']); assert.equal(o.n, '0.123456789012345678901234');
  assert.throws(() => splitTopLevel('{"a": [1, 2'), /truncated|ends early/);
  assert.throws(() => buildRestoreSql('{"format": "something-else"}'), /not a Lucid/);
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

// ============================================================ 7. upgrading a database that already has data
test('R9 the migration upgrades a database that already has a settlement without changing one number, and is safe to run twice', async () => {
  const w = await world({ users: ['john'], pending: false });                      // production as it is today: applied/* only
  await w.join('raf', 500, '01-03'); await w.join('john', 1000, '01-04');
  await w.reading(1.1, '02-20');
  const t = await w.total(1.1);
  await w.call('admin_attest_settlement', w.A, t, NOTE, w.at('03-03'));              // the way it was done before this migration
  const old = await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-03'), null);
  await w.join('john', 300, '03-10');
  await w.withdraw('john', 100, 1.1, '03-12');
  const snap = async () => {
    const x = (await w.q(`select public._export_all() x`))[0].x;
    return JSON.stringify(['ledger', 'pool_equity', 'settlements', 'settlement_lines', 'investor_hwm', 'hwm_log', 'pending_deposits'].map((k) => x[k]));
  };
  const before = await snap();
  const sql = readFileSync(PENDING.find((u) => u.pathname.includes('20261109')), 'utf8');
  await w.db.exec(sql);
  await w.db.exec(sql);                                                           // twice
  await w.db.exec(CLOCK_SQL);
  const after = (await w.q(`select public._export_all() x`))[0].x;
  const strip = (rows) => rows.map(({ covered_from, covered_to, days_after_period_end, late, backdated_days, exception_ids, open_positions_at_settlement, recorded_at, backdated, ...r }) => r);
  assert.equal(JSON.stringify(['ledger', 'pool_equity', 'settlement_lines', 'investor_hwm', 'hwm_log', 'pending_deposits'].map((k) => after[k])),
               JSON.stringify(JSON.parse(before).filter((_, i) => [0, 1, 3, 4, 5, 6].includes(i))), 'no existing number changed');
  assert.equal(JSON.stringify(strip(after.settlements)), JSON.stringify(JSON.parse(before)[2]), 'the earlier settlement is unchanged');
  assert.equal((await w.q(`select count(*)::int n from public.settlements where late = false and exception_ids = '{}'`))[0].n, 1, 'the old settlement gets neutral values for the new columns');
  assert.deepEqual((await w.call('admin_backup_coverage', w.A)).missing, []);
  // the new rules apply from now on
  await w.reading(1.3, '04-20');
  const t2 = await w.total(1.3);
  assert.match(await err(() => w.call('admin_close_quarter', w.A, t2, 58, null, w.at('05-03'), null)), /RECONCILE/);
  await w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t2, NOTE, w.at('05-03'), 0);
  const s2 = await w.call('admin_close_quarter', w.A, t2, 58, null, w.at('05-03'), null);
  assert.ok(Number(s2.settlement_id) > Number(old.settlement_id));
  assert.equal(new Date((await w.q(`select covered_from from public.settlements order by id desc limit 1`))[0].covered_from).toISOString(), '2026-03-03T04:00:00.000Z', 'covers from the previous settlement');
  assert.equal((await w.call('admin_integrity_report', w.A)).worst, -1);
});

// ============================================================ 8. known limits, pinned down so a change is deliberate
test('R10 a reading recorded after the window closes, and a missed window (backdating itself is R11)', async () => {
  // 1. A pool entry recorded after the window closed is what stops the backdating: the valuation date cannot go before the last entry.
  const v = await world({ users: ['john'] });
  await v.join('john', 1000, '01-03'); await v.reading(1.1, '02-20'); await v.reading(1.15, '03-12');
  assert.match(await err(() => v.settle(1.15, '03-05')), /the date must be after the last entry/);
  // 2. A missed window costs the fee on a peak that reverses: the fee is on the gain above the mark AT the settlement.
  const peak = await world({ users: ['john'] });
  await peak.join('raf', 500, '01-03'); await peak.join('john', 1000, '01-04'); await peak.reading(1.3, '02-25');
  const onTime = await peak.total(1.3);                                    // what an on-time settlement would have charged
  await peak.reading(1.0, '04-20');                                        // the window was missed and the price fell back
  const merged = await peak.settle(1.0, '05-03');
  near(merged.fee_usdt, 0, 1e-9);                                          // nothing is charged: the mark was never exceeded at the settlement
  assert.ok(onTime > 0);
});

// ============================================================ 9. no backdating
const NOTE2 = 'the manager confirms the reason for this exception in writing';
test('R11 backdating: a normal settlement, a late one and a backdated one, and what the record keeps', async () => {
  // Jan-Feb ends 2026-03-01 00:00 Manila (28 Feb 16:00Z); its window closes 2026-03-08 00:00 Manila (7 Mar 16:00Z)
  const build = async () => { const w = await world({ users: ['john'] }); await w.join('raf', 500, '01-03'); await w.join('john', 1000, '01-04'); await w.reading(1.2, '02-20'); w.t = await w.total(1.2); return w; };
  const ex = (w, kind, d, open = null) => w.call('admin_approve_settlement_exception', w.A, kind, w.t, NOTE2, w.at(d), open);
  const close = (w, d) => w.call('admin_close_quarter', w.A, w.t, 58, null, w.at(d), null);
  const kinds = async (w) => (await w.q(`select x.kind from public.settlements s, unnest(s.exception_ids) i join public.settlement_exceptions x on x.id = i order by x.id`)).map((r) => r.kind);

  // A. normal: recorded and dated 3 March (inside the window)
  const a = await build();
  await a.clock('2026-03-03T04:00:00Z');
  await ex(a, 'unreconciled', '03-03', 0);
  const sa = await close(a, '03-03');
  assert.equal(sa.late, false); assert.equal(sa.backdated, false);
  const ra = (await a.q(`select backdated, late, recorded_at, valued_at from public.settlements`))[0];
  assert.equal(ra.backdated, false); assert.equal(new Date(ra.recorded_at).toISOString(), '2026-03-03T04:00:00.000Z');

  // B. a clock difference of 30 minutes is not backdating (the allowance is 60)
  const b = await build();
  await b.clock('2026-03-03T04:30:00Z');
  await ex(b, 'unreconciled', '03-03', 0);
  assert.equal((await close(b, '03-03')).backdated, false);

  // C. backdated INSIDE the window: recorded 5 March, dated 3 March
  const c = await build();
  await c.clock('2026-03-05T04:00:00Z');
  await ex(c, 'unreconciled', '03-03', 0);
  assert.match(await err(() => close(c, '03-03')), /BACKDATED: this settlement is dated 2026-03-03 12:00 but is being recorded 48.0 hours later/);
  const pv = await c.call('admin_settlement_preview', c.A, c.t, c.at('03-03'));
  assert.equal(pv.can_settle, false); assert.equal(pv.backdated, true); assert.match(pv.blocked_reasons[0], /BACKDATED/);
  assert.equal((await c.q(`select count(*)::int n from public.settlements`))[0].n, 0, 'nothing was saved');
  await ex(c, 'backdated', '03-03');
  const sc = await close(c, '03-03');
  assert.equal(sc.backdated, true); assert.equal(sc.late, false);
  assert.deepEqual((await kinds(c)).sort(), ['backdated', 'unreconciled']);
  const rc = (await c.q(`select backdated, late, backdated_days, valued_at, recorded_at from public.settlements`))[0];
  assert.equal(rc.backdated, true); near(rc.backdated_days, 2, 1e-9);
  assert.equal(new Date(rc.valued_at).toISOString(), '2026-03-03T04:00:00.000Z'); assert.equal(new Date(rc.recorded_at).toISOString(), '2026-03-05T04:00:00.000Z');

  // D. THE LOOPHOLE: recorded 12 March (window closed 7 March), dated 5 March (inside it)
  const d = await build();
  await d.clock('2026-03-12T04:00:00Z');
  await ex(d, 'unreconciled', '03-05', 0);
  assert.match(await err(() => close(d, '03-05')), /BACKDATED/);
  await ex(d, 'backdated', '03-05');
  assert.match(await err(() => close(d, '03-05')), /LATE: the settlement window .* closed on 2026-03-07/, 'the window is judged on the recording time, so a backdated exception does not excuse lateness');
  await ex(d, 'late', '03-05');
  const sd = await close(d, '03-05');
  assert.equal(sd.late, true); assert.equal(sd.backdated, true);
  assert.deepEqual((await kinds(d)).sort(), ['backdated', 'late', 'unreconciled']);

  // E. honest and late: recorded and dated 12 March
  const e = await build();
  await e.clock('2026-03-12T04:00:00Z');
  await ex(e, 'unreconciled', '03-12', 0);
  assert.match(await err(() => close(e, '03-12')), /^LATE:|LATE:/);
  await ex(e, 'late', '03-12');
  const se = await close(e, '03-12');
  assert.equal(se.late, true); assert.equal(se.backdated, false);

  // the audit trail names every step; existing records cannot be changed
  const act = (await d.q(`select action from public.audit_log where action like 'settlement%' order by id`)).map((r) => r.action);
  assert.deepEqual(act, ['settlement_exception_unreconciled', 'settlement_exception_backdated', 'settlement_exception_late', 'settlement_closed']);
  const closed = (await d.q(`select detail from public.audit_log where action = 'settlement_closed'`))[0].detail;
  assert.equal(closed.backdated, true); assert.equal(closed.late, true); assert.equal(new Date(closed.recorded_at).toISOString(), '2026-03-12T04:00:00.000Z');
  for (const sql of [`update public.settlements set backdated = false`, `update public.settlement_exceptions set kind = 'late'`, `delete from public.settlement_exceptions`]) assert.ok(await err(() => d.db.exec(sql)), sql);

  // F. an exception only counts for its own period and MEXC total
  const g = await build();
  await g.clock('2026-03-05T04:00:00Z');
  await ex(g, 'unreconciled', '03-03', 0);
  await g.call('admin_approve_settlement_exception', g.A, 'backdated', g.t + 25, NOTE2, g.at('03-03'), null);
  assert.match(await err(() => close(g, '03-03')), /BACKDATED/, 'an exception for another total does not apply');
});

// ============================================================ 10. recovery tools: hotfix, rollback, verification script
const sbFile = (rel) => readFileSync(new URL('../supabase/' + rel, import.meta.url), 'utf8');
const FINGERPRINT = `select md5(string_agg(x, E'\n' order by x)) h from (
  select 'f:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')) x from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
  union all select 'c:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') from information_schema.columns where table_schema = 'public'
  union all select 't:' || event_object_table || '.' || trigger_name || ':' || event_manipulation || ':' || action_timing from information_schema.triggers where trigger_schema = 'public'
  union all select 's:' || key from public.ledger_settings) z`;
const SQL1109 = () => readFileSync(PENDING.find((u) => u.pathname.includes('20261109')), 'utf8');

test('R12a the hotfix closes the four internal helpers the website role could call (the live exposure), and the app\'s backup still works', async () => {
  const w = await world({ users: ['john'], pending: false });                   // production as it is today
  await w.join('john', 1000, '01-03');
  const asAnon = async (sql) => { await w.db.exec('set role anon'); try { return (await w.db.query(sql)).rows; } finally { await w.db.exec('reset role'); } };
  const before = await asAnon(`select jsonb_array_length(public._export_all() -> 'ledger') n`);
  assert.equal(before[0].n, 1, 'BEFORE: the public role can read the whole ledger export with no token');
  for (const q of ['select public._account_since(gen_random_uuid())', 'select public._exit_fee_rate(gen_random_uuid())']) await asAnon(q);
  await w.db.exec(sbFile('hotfix/20261023_revoke_internal_helpers.sql'));
  await w.db.exec(sbFile('hotfix/20261023_revoke_internal_helpers.sql'));      // safe twice
  for (const q of ['select public._export_all()', 'select public._account_since(gen_random_uuid())', 'select public._exit_fee_rate(gen_random_uuid())', 'select public._check_min_withdrawal(gen_random_uuid(), 1, 1, 1)'])
    assert.match(await err(() => asAnon(q)), /permission denied/, q);
  const backup = await w.call('admin_export_all', w.A);                          // the manager's Backup button: a function that runs as the owner
  assert.ok(Array.isArray(backup.ledger) && backup.ledger.length === 1, 'the Backup button still works');
  const J = (await w.call('login', 'john', 'john-password')).token;
  assert.ok(await w.call('exit_fee_info', J), 'investor screens that use these helpers internally still work');
});

test('R12b the rollback returns the schema to exactly what it was, keeps the revokes, and refuses once a settlement exists; the verification script passes', async () => {
  const w = await world({ users: ['john'], pending: false });
  await w.join('raf', 500, '01-03'); await w.join('john', 1000, '01-04'); await w.reading(1.2, '02-20');
  const f0 = (await w.q(FINGERPRINT))[0].h;
  const own = async () => JSON.stringify(['ledger', 'pool_equity', 'investor_hwm'].map((k) => w.q(`select count(*) from public.${k}`)));
  await w.db.exec(SQL1109());
  await w.db.exec(CLOCK_SQL);
  // the verification script (PART B): every row must say PASS
  const vf = sbFile('verify/20261109000000_post_apply_checks.sql');
  const partA = vf.slice(vf.indexOf('-- PART A'), vf.indexOf('-- ---------------------------------------------------------------- PART B'));
  const partB = vf.slice(vf.indexOf('-- ---------------------------------------------------------------- PART B'));
  await w.db.exec('reset role');
  await w.db.exec(`reset test.clock; create or replace function public._clock() returns timestamptz language sql stable security definer set search_path = public as $$ select now() $$;`);
  const checks = (await w.db.query(partB)).rows;
  assert.ok(checks.length >= 16, 'all checks ran');
  assert.deepEqual(checks.filter((c) => c.result !== 'PASS').map((c) => c.check + ' ' + (c.detail || '')), [], 'every verification check passes');
  const snapAfter = (await w.db.query(partA)).rows[0].snapshot;
  // rollback
  const rb = sbFile('rollback/20261109000000_rollback_settlement_controls.sql');
  await w.db.exec(rb);
  assert.equal((await w.q(FINGERPRINT))[0].h, f0, 'functions, columns, triggers and settings are exactly what they were');
  assert.equal((await w.db.query(partA)).rows[0].snapshot, snapAfter, 'no balance, mark or unit moved');
  assert.match(await err(() => w.db.exec(rb)), /nothing to roll back/, 'a second rollback is refused');
  await w.db.exec('set role anon'); const exposed = await err(() => w.db.query('select public._export_all()')); await w.db.exec('reset role');
  assert.match(exposed, /permission denied/, 'the rollback does not re-open the exposure');
  // apply again, make a settlement, and the rollback now refuses
  await w.db.exec(SQL1109()); await w.db.exec(CLOCK_SQL);
  await w.clock('2026-03-03T04:00:00Z');
  const t = await w.total(1.2);
  await w.call('admin_approve_settlement_exception', w.A, 'unreconciled', t, NOTE2, w.at('03-03'), 0);
  await w.call('admin_close_quarter', w.A, t, 58, null, w.at('03-03'), null);
  const f1 = (await w.q(FINGERPRINT))[0].h;
  assert.match(await err(() => w.db.exec(rb)), /rollback refused: a settlement or an exception was already recorded/);
  assert.equal((await w.q(FINGERPRINT))[0].h, f1, 'and it changed nothing');
});

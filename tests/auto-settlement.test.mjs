// The automatic two-month settlement (migration 20261214000000_auto_settlement.sql), on the real migrations, every call as the website's public role.
//   AS1 the first verified wallet reading after the period ends settles by itself: fee = rate x (value above the mark), moved as units to the fund manager;
//       total units, pool value and price do not move; the next reports do nothing more
//   AS2 nothing happens before the period ends, after the window has closed, or with settlement_auto = off (the manager's Settle now still works)
//   AS3 an investor below their mark is charged nothing (profit only), and the settlement is still recorded
//   AS4 open trades: 'allow' settles at the true price and records the exception itself; 'wait' waits for a reading with no open position
//   AS5 a paused price (MEXC does not match the books) settles nothing, saves nothing, and is logged once per day
//   AS6 admin_settlement_status shows the same fee the settlement then charges
//   AS7 the migration runs twice; the rollback restores the earlier functions exactly and keeps a settlement that was made
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, adv, near } from './_tvworld.mjs';

const END = Date.UTC(2026, 9, 31, 16);                       // Nov 1, 2026 00:00 Manila: the Sep-Oct period ends
const MIG = new URL('../supabase/migrations/20261214000000_auto_settlement.sql', import.meta.url);
const RB = new URL('../supabase/rollback/20261214000000_rollback_auto_settlement.sql', import.meta.url);
const n = async (w, sql) => Number((await w.q(sql))[0].n);
const settlements = (w) => n(w, `select count(*)::int n from public.settlements`);
const feeNet = (w) => n(w, `select coalesce(sum(units), 0) n from public.ledger where kind in ('fee_in', 'fee_out')`);
const mark = (w, who) => n(w, `select hwm_value n from public.investor_hwm where profile_id = '${w.ids[who]}'`);
const booksOk = async (w) => near(await n(w, `select coalesce(sum(units), 0) n from public.ledger`), (await w.pool()).u, 1e-8, 'units sum = pool total');

// raf 1000 units and john 500 units at price 1.00 on Oct 20, 2026 (bimonthly schedule, immediate fees, true-value pricing), then one closed trade of p_pnl
async function fund(pnl = 150, set = {}) {
  const w = await world({ exclude: ['admission_spread'] });
  await w.clock(Date.UTC(2026, 9, 20, 4));
  await w.join('raf', 1000);
  await adv(w, 5);
  for (const [k, v] of Object.entries({ flow_pricing: 'true_value', settlement_schedule: 'bimonthly', fee_timing: 'immediate', ...set })) {
    await w.db.query(`insert into public.ledger_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v]);
  }
  const pid = await w.receive('john', 500); await w.report(1500, 0);
  await w.call('admin_admit_deposit_tv', w.A, pid, null);
  await adv(w, 20); await w.trade({ pos: 'a1', pnl });
  await adv(w, 5); await w.report(1500 + pnl, 0);
  return w;
}

test('AS1 the first verified reading after the period ends settles by itself: profit-only fee as units to the manager; nothing else moves', async () => {
  const w = await fund(150);
  assert.equal(await settlements(w), 0, 'nothing is settled before the period ends (the earlier window is long closed)');
  await w.clock(END + 5 * 60000);
  const before = { raf: await w.units('raf'), john: await w.units('john'), pool: await w.pool() };
  near(before.pool.p, 1.1, 1e-9);
  await w.report(1650, 0);                                     // the third wallet's report completes the set: the settlement runs
  assert.equal(await settlements(w), 1, 'one settlement, made by the wallet report');
  const s = (await w.q(`select * from public.settlements`))[0], pool = await w.pool();
  const fee = Math.floor((0.2 * 50 / 1.1) * 1e8) / 1e8;        // John: 500 units x 1.10 = 550, mark 500, 20% of 50 = 10 USDT = 9.09090909 units
  near(Number(s.fee_usdt), 10, 1e-5, 'fee = 20% of the profit above the mark');
  near(Number(s.fee_units), fee, 1e-8);
  near((await w.units('john')), before.john - fee, 1e-8, 'the fee leaves the investor as units');
  near((await w.units('raf')), before.raf + fee, 1e-8, 'and arrives in the fund manager\'s account');
  near(await feeNet(w), 0, 1e-9, 'fee units net to zero');
  near(pool.u, before.pool.u, 1e-9, 'total units unchanged'); near(pool.e, 1650, 1e-6, 'pool value unchanged'); near(pool.p, 1.1, 1e-9, 'unit price unchanged');
  near(await mark(w, 'john'), 540, 1e-4, 'H moves to the value after the fee: 550 - 10');
  await booksOk(w);
  const line = (await w.q(`select * from public.settlement_lines where equity_id = $1`, [s.equity_id]))[0];
  near(Number(line.hwm_before), 500); near(Number(line.eligible_profit), 50, 1e-6); near(Number(line.hwm_after), 540, 1e-4);
  assert.equal(await n(w, `select count(*)::int n from public.audit_log where action = 'settlement_auto'`), 1, 'audited as automatic');
  assert.equal(s.recon_status, 'verified_true_value');
  // the following reports do nothing more
  await adv(w, 5); await w.report(1650, 0); await adv(w, 5); await w.report(1650, 0);
  assert.equal(await settlements(w), 1);
  near((await w.units('raf')), before.raf + fee, 1e-8);
});

test('AS2 not before the period ends, not after the window, not when switched off; the manager can still settle by hand', async () => {
  let w = await fund(150);
  await w.clock(END - 10 * 60000); await w.report(1650, 0);
  assert.equal(await settlements(w), 0, 'ten minutes before the boundary: nothing');
  await w.clock(END + 7 * 86400000 + 5 * 60000); await w.report(1650, 0);
  assert.equal(await settlements(w), 0, 'after the 7-day window: the automatic run leaves it to the next period');
  assert.equal((await w.call('admin_settlement_status', w.A)).state, 'missed');

  w = await fund(150, { settlement_auto: 'off' });
  await w.clock(END + 5 * 60000); await w.report(1650, 0);
  assert.equal(await settlements(w), 0, 'switched off: nothing');
  const st = await w.call('admin_settlement_status', w.A);
  assert.equal(st.state, 'due'); assert.equal(st.auto, 'off');
  const s = await w.call('admin_close_quarter_tv', w.A, null, null, 'manual-1');
  near(s.fee_usdt, 10, 1e-5, 'Settle now charges the same fee');
  assert.equal((await w.call('admin_close_quarter_tv', w.A, null, null, 'manual-1')).replayed, true);
  assert.equal(await settlements(w), 1);
  assert.equal((await w.call('admin_settlement_status', w.A)).state, 'settled');
  await booksOk(w);
});

test('AS3 below the mark nothing is charged (profit only); the settlement is still recorded and the mark stays', async () => {
  const w = await fund(-150);                                  // price 0.90: John is worth 450 against a mark of 500
  await w.clock(END + 5 * 60000);
  const john = await w.units('john'), raf = await w.units('raf');
  await w.report(1350, 0);
  assert.equal(await settlements(w), 1);
  near(Number((await w.q(`select fee_usdt from public.settlements`))[0].fee_usdt), 0);
  assert.equal(await n(w, `select count(*)::int n from public.ledger where kind in ('fee_in', 'fee_out')`), 0, 'no fee rows at all');
  near(await w.units('john'), john, 1e-12); near(await w.units('raf'), raf, 1e-12);
  near(await mark(w, 'john'), 500, 1e-9, 'the mark is not lowered by a loss');
  await booksOk(w);
});

test('AS4 open trades: "allow" settles at the true price and records the exception itself; "wait" waits for a flat reading', async () => {
  let w = await fund(150);
  await w.clock(END + 5 * 60000); await w.report(1650, 40);    // +40 open across the wallets: true price 1690 / 1500
  assert.equal(await settlements(w), 1);
  let s = (await w.q(`select * from public.settlements`))[0];
  const p = 1690 / 1500;
  near(Number(s.unit_price), p, 1e-9, 'the fee is taken at the true price');
  near(Number(s.fee_usdt), 0.2 * (500 * p - 500), 1e-4);
  assert.equal(s.exception_ids.length, 1, 'the open-positions exception is on the settlement');
  const x = (await w.q(`select * from public.settlement_exceptions`))[0];
  assert.equal(x.kind, 'open_positions'); assert.match(x.note, /automatic settlement at true value/);
  near((await w.pool()).e, 1650, 1e-6, 'the open P&L is taken back out of the book afterwards');
  near(await feeNet(w), 0, 1e-9); await booksOk(w);
  // the open trade then closes exactly as marked: nothing more is owed on it
  near(await mark(w, 'john'), 500 * p - Number(s.fee_usdt), 1e-4);

  w = await fund(150, { settlement_auto_open_trades: 'wait' });
  await w.clock(END + 5 * 60000); await w.report(1650, 40);
  assert.equal(await settlements(w), 0, 'waiting: trades are open');
  assert.equal(await n(w, `select count(*)::int n from public.settlement_exceptions`), 0, 'and no exception is written');
  await adv(w, 5); await w.report(1650, 40);
  assert.equal(await n(w, `select count(*)::int n from public.audit_log where action = 'settlement_auto_waiting' and detail->>'code' = 'open_trades'`), 1, 'logged once, not on every report');
  const st = await w.call('admin_settlement_status', w.A);
  assert.equal(st.last_waiting.code, 'open_trades');
  await adv(w, 5); await w.report(1650, 0);
  assert.equal(await settlements(w), 1, 'the first flat reading settles');
  s = (await w.q(`select * from public.settlements`))[0];
  near(Number(s.fee_usdt), 10, 1e-5); assert.equal(s.exception_ids.length, 0);
});

test('AS5 a paused price settles nothing, saves nothing, and is logged once', async () => {
  const w = await fund(150);
  await w.clock(END + 5 * 60000);
  const c0 = (await w.q(`select (select count(*)::int from public.pool_equity) e, (select count(*)::int from public.ledger) l`))[0];
  await w.report(1700, 0);                                     // MEXC shows 50 more than the books: unexplained
  await adv(w, 5); await w.report(1700, 0);
  assert.equal(await settlements(w), 0);
  assert.deepEqual((await w.q(`select (select count(*)::int from public.pool_equity) e, (select count(*)::int from public.ledger) l`))[0], c0, 'no pool entry, no ledger row');
  const a = await w.q(`select detail from public.audit_log where action = 'settlement_auto_waiting'`);
  assert.equal(a.length, 1); assert.equal(a[0].detail.code, 'price_paused');
  // explained (the trade is booked): the next reading settles
  await adv(w, 5); await w.trade({ pos: 'a2', pnl: 50 }); await adv(w, 5); await w.report(1700, 0);
  assert.equal(await settlements(w), 1);
  await booksOk(w);
});

test('AS6 the Settle screen shows exactly what the settlement then charges', async () => {
  const w = await fund(150, { settlement_auto: 'off' });
  await w.clock(END + 5 * 60000); await w.report(1650, 0);
  const st = await w.call('admin_settlement_status', w.A);
  assert.equal(st.lines.length, 1, 'only investors are charged: the manager has no line');
  near(st.lines[0].profit_above_mark_usdt, 50, 1e-6); near(st.lines[0].fee_usdt, 10, 1e-5); near(st.fee_usdt_now, 10, 1e-5); near(st.lines[0].mark_after_usdt, 540, 1e-4);
  const s = await w.call('admin_close_quarter_tv', w.A, null, null, null);
  near(s.fee_usdt, st.fee_usdt_now, 1e-6); near(s.fee_units, st.lines[0].fee_units, 1e-8);
  const tok = (await w.call('login', 'john', 'john-password')).token;
  await assert.rejects(w.call('admin_settlement_status', tok), /admin|not allowed|permission|manager/i, 'investors cannot read it');
  await w.db.exec('set role anon');
  try { await assert.rejects(w.db.query(`select public._settle_auto('x')`), /permission denied/, 'the website role cannot trigger the automatic run'); } finally { await w.db.exec('reset role'); }
});

test('AS7 the migration runs twice; the rollback restores the earlier functions exactly and keeps the settlement', async () => {
  const FP = `select md5(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(pg_get_functiondef(p.oid)), ',' order by 1)) f from pg_proc p where p.pronamespace = 'public'::regnamespace`;
  const w = await fund(150);
  const withIt = (await w.q(FP))[0].f;
  await w.db.exec(readFileSync(MIG, 'utf8'));
  assert.equal((await w.q(FP))[0].f, withIt, 'a second run changes nothing');
  await w.clock(END + 5 * 60000); await w.report(1650, 0);
  assert.equal(await settlements(w), 1);
  await w.db.exec(readFileSync(RB, 'utf8'));
  assert.equal(await settlements(w), 1, 'the settlement stays');
  assert.equal(await n(w, `select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('_settle_auto', '_close_quarter_tv_core', '_settlement_calendar', 'admin_settlement_status')`), 0);
  // exactly the schema of a database that never had it
  const base = await world({ exclude: ['admission_spread', 'auto_settlement'] });
  assert.equal((await w.q(FP))[0].f, (await base.q(FP))[0].f, 'functions are exactly what they were before the migration');
  await assert.rejects(w.db.exec(readFileSync(RB, 'utf8')), /rollback refused/);
  await adv(w, 5); await w.report(1650, 0);                    // wallet reports keep working after the rollback
  await booksOk(w);
});

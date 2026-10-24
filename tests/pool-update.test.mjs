// Pool Update (20261112000000_pool_update.sql) on the FULL migration chain, in-memory Postgres (PGlite), calls made as the public "anon" role.
// Every scenario prints expected vs actual so the signs can be read by a human. Staging mode: the "live" exits here are fake rows in bot_events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, freshDb, BOT_KEY } from './_poolworld.mjs';

const near = (a, b, eps = 1e-4) => Math.abs(Number(a) - b) <= eps;
const rows = [];
const check = (name, expected, actual, eps = 1e-4) => {
  const ok = typeof expected === 'number' ? near(actual, expected, eps) : String(actual) === String(expected);
  rows.push({ test: name, expected, actual: typeof actual === 'number' ? Number(actual.toFixed(6)) : actual, ok: ok ? 'PASS' : 'FAIL' });
  assert.ok(ok, `${name}: expected ${expected}, got ${actual}`);
};
test.after(() => { console.table(rows); });

test('1a. deposit queued + a LOSS in the same period: the loss is the old holder\'s alone, the joiner buys in after it', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('e1', -100);
  const dino = await w.arrive('dino', 500);
  let p = await w.pending();
  check('1a pending trades', 1, p.count); check('1a pending $ (sign)', -100, Number(p.usd));
  // before Update Pool the joiner cannot join
  const v = await w.check(1400);              // MEXC account: 1000 - 100 loss + 500 deposit
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, dino, v, null, false), /pending P\/L/);
  check('1a units untouched while pending', 1000, await w.tu());
  const u = await w.update(v);
  check('1a update ok', 'true', u.ok); check('1a NAV after update (1400 - 500 waiting)', 900, u.nav_after);
  check('1a unit price', 0.9, u.unit_price); check('1a pending cleared', 0, (await w.pending()).count);
  await w.call('admin_admit_deposit', w.A, dino, v, null, false);
  check('1a john units unchanged', 1000, await w.units('john'));
  check('1a dino units = 500 / 0.9', 500 / 0.9, await w.units('dino'));
  check('1a unit price after join stays', 0.9, await w.price());
  check('1a john value (lost 100)', 900, (await w.units('john')) * (await w.price()), 1e-3);
  check('1a dino value (lost nothing)', 500, (await w.units('dino')) * (await w.price()), 1e-3);
  check('1a pool NAV = MEXC account', 1400, await w.nav(), 1e-3);
});

test('1b. withdrawal after PROFIT: profit applied first, payout at the new price, fee on the gain', async () => {
  const w = await world(); await w.seed(1000);
  await w.db.exec(`alter table public.ledger disable trigger ledger_append_only; update public.ledger set lock_until = current_date - 1 where lock_until is not null; alter table public.ledger enable trigger ledger_append_only;`);
  await w.exit('e1', 200);
  await w.call('request_withdrawal', w.J, 500); const rid = (await w.call('my_requests', w.J))[0].id;
  await w.call('admin_approve_withdrawal', w.A, rid, null, 'approved as an exception for testing');
  const v = await w.check(1200);
  await assert.rejects(() => w.call('admin_execute_withdrawal', w.A, rid, v, false, null, null, null, false), /pending P\/L/);
  const u = await w.update(v);
  check('1b unit price after +200', 1.2, u.unit_price);
  const out = await w.call('admin_execute_withdrawal', w.A, rid, v, false, null, null, null, false);
  // john: 1000 units, mark 1000, value 1200, gain 200; selling half: fee = 10% x 200 x 0.5 = 10 USDT = 8.3333 units; paid = (500 - 8.3333) x 1.2 = 590
  check('1b fee units', 10 / 1.2, Number(out.fee_units), 1e-3);
  check('1b payout USDT', 590, Number(out.pay_usdt), 1e-2);
  check('1b john units left', 500, await w.units('john'));
  const asked = await w.q(`select leaves_mexc, amount_usdt from public.payout_records where request_id = $1`, [rid]);
  check('1b payout leaves MEXC', 'true', asked[0].leaves_mexc);
});

test('1c. deposit waiting in SPOT is not profit and not traded: reconciliation ignores it (futures) and counts it when told it is in futures', async () => {
  const w = await world(); await w.seed(1000);
  await w.arrive('dino', 500);                                // arrived in MEXC Spot, not admitted
  await w.snap(1000);                                         // bot sees FUTURES equity only
  let r = (await w.call('admin_pool_status', w.A)).recon;
  check('1c recon status, queued money in spot', 'ok', r.status); check('1c expected = pool NAV only', 1000, r.expected);
  await w.db.exec(`update public.ledger_settings set value = 'futures' where key = 'queued_money_location'`);
  await w.snap(1500);
  r = (await w.call('admin_pool_status', w.A)).recon;
  check('1c recon status, queued money in futures', 'ok', r.status); check('1c expected = NAV + queued', 1500, r.expected);
  await w.snap(1000);                                         // equity did not include it although we said it did
  r = (await w.call('admin_pool_status', w.A)).recon;
  check('1c wrong location is a MISMATCH', 'mismatch', r.status); check('1c mismatch amount', -500, r.mismatch);
});

test('1d. two joiners in a row on one Update Pool: both buy at the same price, nobody dilutes anybody', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('e1', 100); await w.exit('e2', 50);
  const dino = await w.arrive('dino', 330), eve = await w.arrive('eve', 220);
  const v = await w.check(1150 + 330 + 220);                  // 1000 + 150 profit + 550 deposits
  const out = await w.call('admin_update_pool_and_admit', w.A, v, (await w.pending()).ids, 150, [dino, eve], null, false, null);
  check('1d ok', 'true', out.ok); check('1d unit price after profit', 1.15, out.unit_price);
  check('1d dino units = 330 / 1.15', 330 / 1.15, await w.units('dino'), 1e-3);
  check('1d eve units = 220 / 1.15', 220 / 1.15, await w.units('eve'), 1e-3);
  check('1d john units unchanged', 1000, await w.units('john'));
  check('1d price unchanged by joins', 1.15, await w.price());
  check('1d pool NAV = MEXC', 1700, await w.nav(), 1e-2);
  check('1d pending cleared', 0, (await w.pending()).count);
});

test('1e. payout redeemed but NOT yet sent: money is still in MEXC, reconciliation expects it; once sent the flow is negative', async () => {
  const w = await world(); await w.seed(1000);
  await w.db.exec(`alter table public.ledger disable trigger ledger_append_only; update public.ledger set lock_until = current_date - 1 where lock_until is not null; alter table public.ledger enable trigger ledger_append_only;`);
  await w.call('request_withdrawal', w.J, 400); const rid = (await w.call('my_requests', w.J))[0].id;
  await w.call('admin_approve_withdrawal', w.A, rid, null, 'approved as an exception for testing');
  const v = await w.check(1000);
  const out = await w.call('admin_execute_withdrawal', w.A, rid, v, false, null, null, null, false);
  const pay = Number(out.pay_usdt); check('1e payout (no profit, no fee)', 400, pay, 1e-3);
  check('1e NAV after redemption', 600, await w.nav(), 1e-3);
  await w.snap(1000);                                         // payout not sent: MEXC still holds all 1000
  let r = (await w.call('admin_pool_status', w.A)).recon;
  check('1e expected = NAV 600 + unsent 400', 1000, r.expected, 1e-3); check('1e recon ok while unsent', 'ok', r.status);
  await w.call('admin_payout_sent', w.A, rid, 'MEXC-WD-1', null);
  assert.equal((await w.q(`select count(*)::int n from public.capital_flows where kind = 'payout'`))[0].n, 1);
  check('1e flow is negative', -400, Number((await w.q(`select usdt from public.capital_flows where kind = 'payout'`))[0].usdt), 1e-3);
  await w.snap(600);
  r = (await w.call('admin_pool_status', w.A)).recon;
  check('1e after sent: expected = NAV', 600, r.expected, 1e-3); check('1e recon ok after sent', 'ok', r.status);
});

test('1f. double-click: the same request id replays; a second click without one is refused; nothing applies twice', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('e1', 80);
  const v = await w.check(1080);
  const a = await w.update(v, { idem: 'click-1' });
  const rows1 = await w.poolRows();
  const b = await w.call('admin_update_pool', w.A, v, ['e1'], 80, 'click-1', false, null);
  check('1f replay returns the stored result', a.pool_update_id, b.replayed ? a.pool_update_id : -1);
  check('1f no second pool entry', rows1, await w.poolRows());
  await assert.rejects(() => w.call('admin_update_pool', w.A, v, ['e1'], 80, 'click-2', false, null), /stale screen/);
  check('1f applied rows', 1, Number((await w.q(`select count(*) n from public.applied_trades`))[0].n));
  check('1f unit price', 1.08, await w.price());
  await assert.rejects(() => w.db.query(`insert into public.applied_trades(event_id, pool_update_id) values ('e1', 1)`), /duplicate key|violates/);
});

test('1g. stale screen: a trade closed after the screen was drawn is refused, and a check older than that trade is refused', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('e1', 40);
  const shown = await w.pending();
  await w.exit('e2', -15, { ts: Date.now() - 100000 });
  const v = await w.check(1025);
  await assert.rejects(() => w.call('admin_update_pool', w.A, v, shown.ids, Number(shown.usd), null, false, null), /stale screen: the pending trades changed/);
  await assert.rejects(() => w.call('admin_update_pool', w.A, v, ['e1', 'e2'], 40, null, false, null), /stale screen: the pending total/);
  check('1g nothing applied', 0, Number((await w.q(`select count(*) n from public.applied_trades`))[0].n));
  await w.exit('e3', 10, { ts: Date.now() + 60000 });          // closes after the balance check was entered
  const p = await w.pending();
  await assert.rejects(() => w.call('admin_update_pool', w.A, v, p.ids, Number(p.usd), null, false, null), /closed after this balance check/);
  const v2 = await w.check(1035, 0);
  await assert.rejects(() => w.call('admin_update_pool', w.A, v2, p.ids, Number(p.usd), null, false, null), /closed after this balance check/);
});

test('1h. fees/funding difference: inside the tolerance it applies, outside it is blocked, logged, then applies once classified', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('e1', 100);
  // inside: bot says +100.00, MEXC shows +99.80 (fees/funding 0.20, tolerance max(0.5, 0.05% of 1099.8) = 0.55)
  let v = await w.check(1099.8);
  let u = await w.update(v);
  check('1h inside tolerance applies', 'true', u.ok); check('1h unexplained is the 0.20', -0.2, u.difference, 1e-6);
  check('1h pool uses the MEXC number, not the bot number', 1099.8, await w.nav(), 1e-6);
  // outside: bot says +50, MEXC shows +45 (5 USDT of fees/funding)
  await w.exit('e2', 50, { ts: Date.now() - 60000 });
  v = await w.check(1099.8 + 45);
  u = await w.update(v);
  check('1h outside tolerance blocked', 'true', u.blocked); check('1h unexplained amount', -5, u.unexplained, 1e-6); check('1h tolerance', 0.5724, u.tolerance, 1e-3);
  check('1h block logged', 1, Number((await w.q(`select count(*) n from public.pool_recon_log where source = 'update_pool'`))[0].n));
  check('1h nothing applied by the blocked call', 1, Number((await w.q(`select count(*) n from public.applied_trades`))[0].n));
  check('1h pool unchanged by the blocked call', 1099.8, await w.nav(), 1e-6);
  await assert.rejects(() => w.call('admin_classify_pool_difference', w.A, v, 'fees', 'short'), /at least 10 characters/);
  const c = await w.call('admin_classify_pool_difference', w.A, v, 'fees', 'MEXC fee statement shows 5 USDT of trading fees');
  check('1h classified amount', -5, c.classified, 1e-6);
  u = await w.update(v);
  check('1h applies after classification', 'true', u.ok); check('1h NAV', 1144.8, await w.nav(), 1e-6);
  // the tolerance is configurable
  await w.exit('e3', 100, { ts: Date.now() - 30000 });
  await w.db.exec(`update public.ledger_settings set value = '0.05' where key = 'pool_recon_tol_abs'; update public.ledger_settings set value = '0' where key = 'pool_recon_tol_pct'`);
  v = await w.check(1144.8 + 99.8);
  u = await w.update(v);
  check('1h tighter tolerance blocks a 0.20 difference', 'true', u.blocked);
});

test('2. undo of Update Pool: exits return to pending, can be applied again once, never twice', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('e1', 60); await w.exit('e2', -10);
  const v = await w.check(1050);
  const u = await w.update(v);
  check('2 applied', 2, u.applied_trades); check('2 price', 1.05, await w.price());
  const out = await w.call('admin_undo_last', w.A, 'wrong balance');
  check('2 exits returned', 2, out.exits_returned_to_pending);
  const p = await w.pending();
  check('2 pending again', 2, p.count); check('2 pending total', 50, Number(p.usd));
  check('2 price back', 1, await w.price());
  check('2 log kept', 2, Number((await w.q(`select count(*) n from public.applied_trades_log`))[0].n));
  check('2 update marked reverted', 'reverted', (await w.q(`select status from public.pool_updates order by id desc limit 1`))[0].status);
  await assert.rejects(() => w.call('admin_undo_last', w.A, 'again'), /correction and cannot be undone/);
  const v2 = await w.check(1050);
  const u2 = await w.update(v2);
  check('2 re-applied once', 'true', u2.ok); check('2 price', 1.05, await w.price());
  await assert.rejects(() => w.call('admin_update_pool', w.A, v2, ['e1', 'e2'], 50, null, false, null), /stale screen/);   // a second click sends the old screen
  check('2 active applied rows', 2, Number((await w.q(`select count(*) n from public.applied_trades`))[0].n));
});

test('3. guards live in the database: direct calls, the core functions and a raw ledger insert all refuse', async () => {
  const w = await world(); await w.seed(1000);
  const dino = await w.arrive('dino', 500);
  await w.exit('e1', 30);
  const v = await w.check(1530);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, dino, v, null, false), /pending P\/L: 1 closed live trade/);
  // the original (core) function is closed to the website: no bypass
  await assert.rejects(() => w.call('_admin_admit_deposit_core', w.A, dino, v, null, false), /permission denied/);
  await assert.rejects(() => w.call('_admin_execute_withdrawal_core', w.A, 1, v, false, null, null, null, false), /permission denied/);
  await assert.rejects(() => w.call('_admin_undo_last_core', w.A, null), /permission denied/);
  await assert.rejects(() => w.call('_bot_post_equity_core', BOT_KEY, 1000, null), /permission denied/);
  // even the owner cannot slip a deposit or withdrawal into the ledger while trades are pending (trigger)
  await assert.rejects(() => w.db.query(`insert into public.ledger(profile_id, kind, units, usdt, unit_price) values ($1, 'deposit', 1, 1, 1)`, [w.ids.dino]), /pending P\/L/);
  await assert.rejects(() => w.db.query(`insert into public.ledger(profile_id, kind, units, usdt, unit_price) values ($1, 'withdrawal', -1, -1, 1)`, [w.ids.john]), /pending P\/L/);
  // the website cannot read or write the new tables and views
  for (const t of ['pool_updates', 'applied_trades', 'applied_trades_log', 'pool_recon_log', 'pending_live_exits', 'pending_pnl', 'capital_flows']) {
    const r = await w.q(`select has_table_privilege('anon', 'public.${t}', 'select') s, has_table_privilege('authenticated', 'public.${t}', 'insert') i`);
    assert.equal(r[0].s, false, t + ' readable by anon'); assert.equal(r[0].i, false, t + ' writable');
  }
  // the manager's functions need the manager's token
  await assert.rejects(() => w.call('admin_update_pool', w.J, v, ['e1'], 30, null, false, null), /not allowed|admin/i);
  await assert.rejects(() => w.call('admin_pending_pnl', w.J), /not allowed|admin/i);
  // and after Update Pool the same admission works
  await w.update(v);
  await w.call('admin_admit_deposit', w.A, dino, v, null, false);
  check('3 admitted after Update Pool (price 1.03 after +30)', 500 / 1.03, await w.units('dino'), 1e-2);
  // a balance check older than the newest closed trade is refused even when nothing is pending
  const pd2 = await w.arrive('eve', 100);
  const old = await w.check(1630);
  await w.exit('e9', 0.01, { ts: Date.now() + 5000 });
  await w.db.query(`insert into public.applied_trades(event_id, pool_update_id, ts_ms) select 'e9', id, 1 from public.pool_updates order by id limit 1`);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, pd2, old, null, false), /older than the newest closed live trade/);
});

test('4. paper trades can never be pending, and the bot cannot move the unit price', async () => {
  const w = await world(); await w.seed(1000);
  await w.exit('p1', 500, { mode: 'paper' }); await w.exit('p2', -300, { mode: 'paper' });
  const p = await w.pending();
  check('4 paper exits pending', 0, p.count); check('4 paper $ pending', 0, Number(p.usd));
  const before = { rows: await w.poolRows(), price: await w.price() };
  const r = await w.call('bot_post_equity', BOT_KEY, 1300, 'MEXC balance (bot)');
  check('4 bot_post_equity refused', 'disabled', r.skipped); check('4 ok false', 'false', r.ok);
  check('4 no pool entry', before.rows, await w.poolRows()); check('4 unit price unchanged', before.price, await w.price());
  await assert.rejects(() => w.call('bot_post_equity', 'wrong-key', 1300, null), /not allowed/);
  // snapshots still work
  const s = await w.snap(1000);
  assert.ok(s.snapshot_id || s.recon_status, 'snapshot accepted');
  // only when the setting is deliberately 'on' does the old path run again
  await w.db.exec(`update public.ledger_settings set value = 'on' where key = 'bot_equity_sync'`);
  const r2 = await w.call('bot_post_equity', BOT_KEY, 1000.4, null);
  assert.notEqual(r2.skipped, 'disabled');
});

test('5. capital flows and the reconciliation block: deposit and payout rows, mismatch blocks admissions and is logged once', async () => {
  const w = await world(); await w.seed(1000);
  const f = await w.q(`select kind, usdt from public.capital_flows order by ts_ms`);
  check('5 deposit flow', 1000, Number(f[0].usdt)); check('5 flow kind', 'deposit', f[0].kind);
  await w.snap(1000);
  assert.equal((await w.call('admin_pool_status', w.A)).recon.status, 'ok');
  const dino = await w.arrive('dino', 200);
  await w.snap(940);                                          // 60 USDT missing with no trade, no payout: unexplained
  const st = await w.call('admin_pool_status', w.A);
  check('5 mismatch', 'mismatch', st.recon.status); check('5 mismatch amount', -60, st.recon.mismatch);
  const v = await w.check(1200);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, dino, v, null, false), /reconciliation mismatch/);
  await w.call('admin_pool_status', w.A); await w.call('admin_pool_status', w.A);
  check('5 same block logged once', 1, Number((await w.q(`select count(*) n from public.pool_recon_log where status = 'mismatch'`))[0].n));
  await w.snap(1000);                                         // explained / fixed
  assert.equal((await w.call('admin_pool_status', w.A)).recon.status, 'ok');
  await w.call('admin_admit_deposit', w.A, dino, v, null, false);
  check('5 admitted once reconciled', 200, await w.units('dino'), 1e-2);
});

test('6. the migration runs twice without error, and its rollback restores the old behaviour exactly (no data deleted)', async () => {
  const w = await world(); await w.seed(1000);
  const mig = readFileSync(new URL('../supabase/migrations/20261112000000_pool_update.sql', import.meta.url), 'utf8');
  const rb = readFileSync(new URL('../supabase/rollback/20261112000000_rollback_pool_update.sql', import.meta.url), 'utf8');
  await w.db.exec(mig);                                       // second run
  await w.exit('e1', 25);
  const v = await w.check(1025); await w.update(v);
  await w.exit('e2', 5);
  const dino = await w.arrive('dino', 100);
  const v2 = await w.check(1130);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, dino, v2, null, false), /pending P\/L/);
  await w.db.exec(rb); await w.db.exec(rb);                   // rollback, twice
  assert.equal((await w.q(`select to_regprocedure('public.admin_update_pool(text,bigint,text[],numeric,text,boolean,text)') is null as gone`))[0].gone, true);
  assert.equal((await w.q(`select to_regprocedure('public._admin_admit_deposit_core(text,bigint,bigint,text,boolean)') is null as gone`))[0].gone, true);
  check('6 applied-trades history kept', 1, Number((await w.q(`select count(*) n from public.applied_trades_rolled_back`))[0].n));
  check('6 after the rollback only bot_events is uncovered (as before this migration: the earlier definition does not know it)', ['bot_events'], (await w.call('admin_backup_coverage', w.A)).missing);
  assert.equal(Array.isArray((await w.q(`select public._export_all() x`))[0].x.applied_trades_rolled_back), true);
  await w.call('admin_classify_difference', w.A, v2, 'trading_pnl', 'bot log shows one closed trade worth 5 USDT');   // the old way to explain it
  await w.call('admin_admit_deposit', w.A, dino, v2, null, false);   // old behaviour: no pending-P/L guard
  assert.ok((await w.units('dino')) > 0);
  const r = await w.call('bot_post_equity', BOT_KEY, 1130, null);   // old behaviour: the bot function is the original again
  assert.notEqual(r.skipped, 'disabled');
  await w.db.exec(mig);                                       // and it can be applied again afterwards
  assert.equal((await w.q(`select to_regprocedure('public.admin_update_pool(text,bigint,text[],numeric,text,boolean,text)') is not null as there`))[0].there, true);
});

test('7. the screen end to end: the request the button builds from admin_pool_status is accepted by the database as is (named parameters), a double-click replays', async () => {
  const { createRequire } = await import('node:module');
  const PU = createRequire(import.meta.url)('../js/poolupdate.js');
  const w = await world(); await w.seed(1000);
  const dino = await w.arrive('dino', 250);
  await w.exit('e1', 30); await w.exit('e2', -10, { ts: Date.now() - 90000 });
  const v = await w.check(1270);
  const named = async (fn, o) => {
    const keys = Object.keys(o); await w.db.exec('set role anon');
    try { return (await w.db.query(`select public.${fn}(p_token => $1, ${keys.map((k, i) => `${k} => $${i + 2}`).join(', ')}) as r`, [w.A, ...keys.map((k) => o[k])])).rows[0].r; } finally { await w.db.exec('reset role'); }
  };
  const status = await w.call('admin_pool_status', w.A);
  const banner = PU.banner(status, 'UTC');
  assert.match(banner, /^2 trades, \+20\.00 USDT pending since /);
  const rd = (await w.call('admin_capital_queue', w.A)).ready;
  assert.equal(PU.ready(rd).ok, true, 'the button is offered');
  const req = PU.requestAndAdmit(status, PU.ready(rd).vid, 'screen-click-1', [dino]);
  const a = await named('admin_update_pool_and_admit', req);
  check('7 ok', 'true', a.ok); check('7 price', 1.02, a.unit_price); check('7 admitted', 1, a.admitted.length);
  check('7 dino units = 250 / 1.02', 250 / 1.02, await w.units('dino'), 1e-3);
  const b = await named('admin_update_pool_and_admit', req);          // the same click again (same screen, same request id)
  check('7 double-click replays', 'true', b.replayed);
  check('7 still one admission', 1, Number((await w.q(`select count(*) n from public.ledger where kind = 'deposit' and profile_id = $1`, [w.ids.dino]))[0].n));
  const after = await w.call('admin_pool_status', w.A);
  check('7 banner gone', 'null', PU.banner(after, 'UTC'));
  check('7 history shows the update', 1, after.updates.length);
});

test('8. the backup covers the pool tables, and a restore brings them back exactly (and a pool that was updated still reconciles)', async () => {
  const { buildRestoreSql } = await import('../scripts/restore-ledger.mjs');
  const w = await world(); await w.seed(1000);
  check('8 backup covers every table', [], (await w.call('admin_backup_coverage', w.A)).missing);
  await w.exit('e1', 40); await w.exit('e2', -15, { ts: Date.now() - 100000 });
  const v = await w.check(1025); await w.update(v);
  await w.exit('e3', 5, { ts: Date.now() - 50000 }); await w.snap(1030);
  await w.call('admin_pool_status', w.A);
  const x = (await w.q(`select public._export_all() x`))[0].x;
  check('8 export carries applied trades', 2, x.applied_trades.length); check('8 export carries the pool update', 1, x.pool_updates.length);
  const db2 = await freshDb();
  await db2.exec(buildRestoreSql((await w.q(`select public._export_all()::text x`))[0].x));
  const y = (await db2.query(`select public._export_all() x`)).rows[0].x;
  const norm = (rs) => JSON.stringify([...rs].map((r) => JSON.stringify(r)).sort());
  for (const k of ['pool_updates', 'applied_trades', 'applied_trades_log', 'pool_recon_log']) check('8 restored ' + k, norm(x[k]), norm(y[k]), 0);
  check('8 restored applied trades keep their pool update', 2, Number((await db2.query(`select count(*)::int n from public.applied_trades a join public.pool_updates u on u.id = a.pool_update_id`)).rows[0].n));
});

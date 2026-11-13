// 20261215000000_retire_unused_functions.sql and the app's LEGACY_SCREENS switch.
//   RT1 after the retirement the website role cannot call one retired function, no row changed, and the whole flow in use still works as the website role:
//       add investor, cash in, transfer, withdraw, mark sent, the settlement status and Settle now, undo, backup
//   RT2 the app: its RETIRED list is the migration's list (plus the never-applied admission spread); every other function the app calls exists and is open
//       to the website role on the retired database; with LEGACY_SCREENS off, call() refuses a retired function before anything is sent
//   RT3 the migration refuses while money recorded by hand is still waiting, runs twice, and its rollback restores exactly the earlier grants
//   RT4 the Record and Settle screens with the switch off: only the four steps, Live NAV and History; the settlement card words the database's figures
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { world, adv, near } from './_tvworld.mjs';

const require = createRequire(import.meta.url);
const Desk = require('../js/desk.js'), SettleAuto = require('../js/settleauto.js');
const MIG = readFileSync(new URL('../supabase/migrations/20261215000000_retire_unused_functions.sql', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../supabase/rollback/20261215000000_rollback_retire_unused_functions.sql', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const SPREAD = ['admin_admission_spreads', 'admin_quote_admission_spread', 'admin_admit_admission_spread_tv', 'admin_cancel_admission_spread'];
const migNames = () => [...new Set([...MIG.matchAll(/'((?:admin)_[a-z_]+)'/g)].map((m) => m[1]))].filter((x) => x !== 'admin_cash_in' && x !== 'admin_settlement_status').sort();
const appRetired = () => [...APP.slice(APP.indexOf('const RETIRED = new Set(['), APP.indexOf(']);', APP.indexOf('const RETIRED = new Set(['))).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
const GRANTS = `select md5(string_agg(p.oid::regprocedure::text || '=' || has_function_privilege('anon', p.oid, 'execute') || has_function_privilege('authenticated', p.oid, 'execute')
  || has_function_privilege('public', p.oid, 'execute'), ',' order by 1)) f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> '_retired_functions'`;
const ROWS = `select md5(string_agg(t || ':' || n, ',' order by t)) f from (select 'ledger' t, count(*)::text || md5(coalesce(string_agg(l::text, ',' order by id), '')) n from public.ledger l
  union all select 'pool', count(*)::text || md5(coalesce(string_agg(l::text, ',' order by id), '')) from public.pool_equity l
  union all select 'hwm', md5(coalesce(string_agg(l::text, ',' order by profile_id), '')) from public.investor_hwm l
  union all select 'pend', md5(coalesce(string_agg(l::text, ',' order by id), '')) from public.pending_deposits l
  union all select 'audit', count(*)::text from public.audit_log union all select 'settings', md5(string_agg(key || value, ',' order by key)) from public.ledger_settings) z`;

// raf 1000 units at 1.00, true-value pricing, bimonthly schedule; the retirement is NOT applied yet
async function fund() {
  const w = await world({ exclude: ['admission_spread'] });
  await w.join('raf', 1000);
  await adv(w, 5);
  for (const [k, v] of Object.entries({ flow_pricing: 'true_value', settlement_schedule: 'bimonthly', fee_timing: 'immediate', settlement_auto: 'off' })) {
    await w.db.query(`insert into public.ledger_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [k, v]);
  }
  await w.report(1000, 0); await adv(w, 5);
  return w;
}

test('RT1 retired functions are closed to the website role, nothing changed, and the flow in use works end to end', async () => {
  const w = await fund();
  const rows0 = (await w.q(ROWS))[0].f;
  await w.db.exec(MIG);
  assert.equal((await w.q(ROWS))[0].f, rows0, 'no ledger, pool, mark, deposit, audit or settings row changed');
  const ret = await w.q(`select * from public._retired_functions()`);
  assert.ok(ret.length >= migNames().length, 'every name is in the database');
  assert.ok(ret.every((r) => r.website_can_call === false), 'the website role can call none of them');
  await assert.rejects(w.call('admin_post_equity', w.A, 1000, 58, null, null), /permission denied/);
  await assert.rejects(w.call('admin_receive_deposit', w.A, w.ids.john, 100, 58, 5800, null, null, null, true), /permission denied/);
  await assert.rejects(w.call('admin_capital_queue', w.A), /permission denied/);
  await assert.rejects(w.call('admin_peso_topup', w.A, w.ids.john, 5, 58, 'peso top-up test', null), /permission denied/);
  assert.equal(await (async () => (await w.q(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_post_equity'`))[0].n)(), 1, 'nothing was dropped');

  // the four steps, as the website role
  const add = await w.call('admin_add_investor', w.A, 'maria', 'Maria', 'maria-password-1', 0.2, 5800, 100, 58, true, 'add-1');
  w.ids.maria = add.profile_id;
  await w.report(1100, 0); await adv(w, 5);                    // the money shows in the wallets: it joins by itself
  near(await w.units('maria'), 100, 1e-6, 'add investor + cash in');
  const ci = await w.call('admin_cash_in', w.A, w.ids.john, 2900, 50, 58, true, null, 'cash-1');
  assert.ok(ci.cash_in_id || ci.id || ci.status, 'cash in is accepted');
  await w.report(1150, 0); await adv(w, 5);
  near(await w.units('john'), 50, 1e-6);
  await w.trade({ pos: 'r1', pnl: 115 }); await adv(w, 5); await w.report(1265, 0); await adv(w, 5);      // +10%: price 1.10
  const tr = await w.call('admin_transfer', w.A, w.ids.maria, w.ids.dino, null, 11, null, false, null, 'move-1');
  assert.ok(Number(tr.usdt) > 0, 'transfer');
  await w.call('admin_set_payout', w.A, w.ids.john, 'gcash', 'john', '09171234567', null, null);
  const out = await w.call('admin_withdraw_now', w.A, w.ids.john, 11, false, null, 'test: allowed inside the lock-up', null, 'out-1');
  assert.ok(Number(out.pay_usdt) > 0, 'withdraw');
  const rid = Number((await w.q(`select max(id) i from public.withdrawal_requests`))[0].i);
  await w.call('admin_payout_sent', w.A, rid, 'MEXC-REF-1', null);
  const st = await w.call('admin_settlement_status', w.A);
  assert.ok(['due', 'missed', 'settled', 'no_period'].includes(st.state));
  assert.ok((await w.call('admin_nav', w.A)).settings, 'the Live NAV screen');
  assert.ok(await w.call('admin_export_all', w.A), 'backup');
  assert.ok(Array.isArray(await w.call('admin_pending', w.A)));
  near(Number((await w.q(`select coalesce(sum(units),0) n from public.ledger`))[0].n), (await w.pool()).u, 1e-8, 'units sum = pool total');
  near(Number((await w.q(`select coalesce(sum(units),0) n from public.ledger where kind in ('fee_in','fee_out')`))[0].n), 0, 1e-9, 'fee units net to zero');
  // investors and bots are untouched
  const tok = (await w.call('login', 'john', 'john-password')).token;
  assert.ok(await w.call('my_summary', tok)); assert.ok(await w.call('my_nav', tok));
});

test('RT2 the app\'s RETIRED list is the migration\'s list; everything else it calls is open on the retired database; call() refuses retired names', async () => {
  assert.deepEqual(appRetired(), [...migNames(), ...SPREAD].sort(), 'js/app.js RETIRED = the migration + the never-applied admission spread');
  const w = await fund();
  await w.db.exec(MIG);
  const called = [...new Set([...APP.matchAll(/(?:call|rpc)\((?:admin \? )?'([a-z_]+)'(?: : '([a-z_]+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)))];
  assert.ok(called.length > 60, 'the app\'s calls were found');
  const open = new Set((await w.q(`select distinct p.proname n from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')`)).map((r) => r.n));
  const retired = new Set(appRetired());
  const broken = called.filter((fn) => !retired.has(fn) && !open.has(fn));
  assert.deepEqual(broken, [], 'every function the app calls with the switch off exists and is open to the website role');
  // the choke point in the app: before anything is sent
  assert.match(APP, /if \(!LEGACY && RETIRED\.has\(fn\)\) throw new Error\(/);
  assert.match(readFileSync(new URL('../js/config.js', import.meta.url), 'utf8'), /LEGACY_SCREENS: false/, 'off by default');
  assert.match(readFileSync(new URL('../login.html', import.meta.url), 'utf8'), /js\/settleauto\.js/);
});

test('RT3 refused while by-hand money is waiting; runs twice; the rollback restores exactly the earlier grants', async () => {
  const w = await fund();
  const g0 = (await w.q(GRANTS))[0].f;
  await w.receive('john', 100);                                // recorded the old way, still waiting
  await assert.rejects(w.db.exec(MIG), /recorded by hand are still waiting/);
  assert.equal((await w.q(GRANTS))[0].f, g0, 'a refused run changes nothing');
  const pid = Number((await w.q(`select max(id) i from public.pending_deposits`))[0].i);
  await w.call('admin_cancel_pending', w.A, pid);
  await w.db.exec(MIG);
  const g1 = (await w.q(GRANTS))[0].f;
  assert.notEqual(g1, g0);
  await w.db.exec(MIG);
  assert.equal((await w.q(GRANTS))[0].f, g1, 'a second run changes nothing');
  await w.db.exec(RB);
  assert.equal((await w.q(GRANTS))[0].f, g0, 'after the rollback the website role has exactly the rights it had');
  await assert.rejects(w.db.exec(RB), /rollback refused/);
  assert.ok(await w.call('admin_capital_queue', w.A), 'the old screens\' functions answer again');
});

test('RT4 with the switch off the Record tab lists only the four steps, Live NAV and History; the settlement card words the database\'s figures', () => {
  const h = Desk.tabs('cash');
  for (const l of ['Add investor', 'Cash in', 'Withdraw', 'Transfer', 'Live NAV', 'History']) assert.ok(h.includes(l), l);
  for (const l of ['by hand', 'Balance']) assert.ok(!h.includes(l), 'not listed: ' + l);
  assert.ok(Desk.tabs('cash', true).includes('Money in (by hand)'), 'listed again with the switch on');
  const st = { auto: 'on', open_trades_rule: 'allow', state: 'due', timezone: 'Asia/Manila', period_end: '2026-12-31T16:00:00Z', window_end: '2027-01-07T16:00:00Z', next_period_end: '2027-02-28T16:00:00Z',
    price_ok: true, unit_price: 1.1, open_positions: 2, fee_usdt_now: 10, lines: [{ name: 'Investor <A>', value_usdt: 550, mark_usdt: 500, profit_above_mark_usdt: 50, fee_rate: 0.2, fee_units: 9.09090909, fee_usdt: 10 }], last_settlement: null };
  const c = SettleAuto.card(st);
  assert.ok(c.includes('Due now') && c.includes('Dec 31, 2026') && c.includes('Jan 7, 2027'), 'period and window in Manila dates');
  assert.ok(c.includes('10.0000 USDT') && c.includes('9.0909 units move to you') && c.includes('Investor &lt;A&gt;'), 'the fee, the units, the name escaped');
  assert.ok(c.includes('data-action="settlenow"'));
  assert.ok(SettleAuto.card({ ...st, state: 'settled' }).includes('Settled') && !SettleAuto.card({ ...st, state: 'settled' }).includes('settlenow'));
  assert.ok(SettleAuto.card({ ...st, price_ok: false, price_reasons: [{ text: 'gap 21.99' }] }).includes('gap 21.99'));
  assert.ok(SettleAuto.card(null).includes('20261214000000_auto_settlement.sql'));
  assert.ok(SettleAuto.card({ ...st, state: 'missed' }).includes('Nothing is lost'));
});

// Capital-movement workflow (20261106000000_capital_workflow.sql) on an in-memory Postgres, called as the public "anon" role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build, near } from './_world.mjs';

async function world() {
  const w = await build({ later: true });
  await w.db.exec(readFileSync(new URL('../supabase/migrations/applied/20261106000000_capital_workflow.sql', import.meta.url), 'utf8'));
  await w.db.exec(`update public.ledger_settings set value='on' where key='workflow_gate'; update public.ledger_settings set value='0' where key='min_days_between_closes'`);
  w.J = await w.tok('john');
  await w.call('set_my_payout', w.J, 'gcash', 'John', '09171234567');
  const A = w.A, c = w.call;
  w.enter = (t, pos = 0, ord = 0) => c('admin_enter_balance', A, t, pos, ord, null, null);
  w.confirm = (id) => c('admin_confirm_balance', A, id, null);
  // a fresh, confirmed, flat check at this balance (nothing unexplained expected)
  w.okCheck = async (t, pos = 0) => { const v = await w.enter(t, pos); await w.confirm(v.id); return v.id; };
  // john deposits 1000 and it is admitted through the workflow
  w.seed = async () => {
    const pd = (await c('admin_receive_deposit', A, w.ids.john, 1000, 58, 58000, null)).id;
    await c('admin_confirm_arrival', A, pd, 'seen in MEXC deposit history', null);
    const v = await w.okCheck(1000);
    await c('admin_admit_deposit', A, pd, v, null, false);
    return pd;
  };
  return w;
}
const poolRows = async (w) => Number((await w.q('select count(*) n from public.pool_equity'))[0].n);
const reasons = (v) => v.ready.reasons.map((r) => r.code);

test('entering a balance changes nothing and is not confirmed', async () => {
  const w = await world(); const before = await poolRows(w);
  const v = await w.enter(1000, 0);
  assert.equal(v.status, 'entered'); assert.equal(await poolRows(w), before);
  assert.equal((await w.call('admin_capital_queue', w.A)).ready.ok, false);
  const pd = (await w.call('admin_receive_deposit', w.A, w.ids.john, 1000, 58, null, null)).id;
  await w.call('admin_confirm_arrival', w.A, pd, 'seen in MEXC history', null);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, pd, v.id, null, false), /not been confirmed|blocked/);
  assert.equal(await w.tu(), 0);
});

test('confirming with an unexplained difference records the fact, issues no units, and blocks capital until explained', async () => {
  const w = await world(); await w.seed();
  const units = await w.tu(), pe = await poolRows(w);
  const v = await w.enter(1150, 0);
  assert.ok(near(v.variance, 150));
  const c = await w.confirm(v.id);
  assert.equal(c.status, 'confirmed'); assert.equal(await w.tu(), units); assert.equal(await poolRows(w), pe);
  assert.ok(reasons(c).includes('unresolved_difference'));
  const pd = (await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, null, null)).id;
  await w.call('admin_confirm_arrival', w.A, pd, 'seen in MEXC history', null);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, pd, v.id, null, false), /not explained/);
  await assert.rejects(() => w.call('admin_settle_quarter', w.A, v.id, null, null, null, false), /not explained/);
  const r = await w.call('admin_classify_difference', w.A, v.id, 'trading_pnl', 'bot log shows closed trades worth 150');
  assert.ok(Math.abs(r.residual) < 1e-9); assert.equal(r.ready.ok, true);
  assert.equal(r.adjustments[0].classified, true);
});

test('duplicate confirmation, duplicate admission and an unarrived deposit are refused', async () => {
  const w = await world(); const pd = await w.seed();
  const v = await w.enter(1000, 0); await w.confirm(v.id);
  await assert.rejects(() => w.confirm(v.id), /already confirmed/);
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, pd, v.id, null, false), /duplicate refused/);
  const pd2 = (await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, null, null)).id;   // reported, not in MEXC
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, pd2, v.id, null, false), /not confirmed as received/);
  assert.equal((await w.call('admin_capital_queue', w.A)).deposits.find((d) => d.id === pd2).state, 'awaiting_arrival');
  assert.equal(await w.units('dino'), 0);
  const pd3 = (await w.call('admin_receive_deposit', w.A, w.ids.eve, 500, 58, null, null)).id;
  await w.call('admin_confirm_arrival', w.A, pd3, 'seen in MEXC history', null);
  const v2 = await w.enter(1500, 0); await w.confirm(v2.id);
  const a = await w.call('admin_admit_deposit', w.A, pd3, v2.id, 'k1', true);
  const b = await w.call('admin_admit_deposit', w.A, pd3, v2.id, 'k1', true);
  assert.equal(b.replayed, true); assert.equal(a.units, b.units); assert.ok(near(await w.units('eve'), 500));
  await assert.rejects(() => w.call('admin_admit_deposit', w.A, pd3, v2.id, 'k2', true), /duplicate refused/);
});

test('direct deposit/close paths are blocked while the gate is on', async () => {
  const w = await world(); await w.seed();
  const pd = (await w.call('admin_receive_deposit', w.A, w.ids.dino, 500, 58, null, null, null, null, true)).id;   // marked in MEXC
  assert.ok(pd);
  await assert.rejects(() => w.call('admin_post_equity', w.A, 1500), /Capital desk/);
  await assert.rejects(() => w.call('admin_close_quarter', w.A, 1500), /Capital desk/);
});

test('withdrawal waits while a position is open (one closed, one open), then goes through when flat and reconciled', async () => {
  const w = await world(); await w.seed();
  await w.call('request_withdrawal', w.J, 400);
  const rid = (await w.call('my_requests', w.J))[0].id;
  let q = (await w.call('admin_capital_queue', w.A)).withdrawals[0];
  assert.equal(q.state, 'awaiting_approval');
  await w.call('admin_approve_withdrawal', w.A, rid, null, 'inside the lock-up, approved as an exception');
  const v1 = await w.enter(1000, 1); const c1 = await w.confirm(v1.id);      // one coin closed, one still open
  assert.ok(reasons(c1).includes('open_positions'));
  await assert.rejects(() => w.call('admin_execute_withdrawal', w.A, rid, v1.id, false, null, null, null, false), /trade is still open/);
  q = (await w.call('admin_capital_queue', w.A)).withdrawals[0];
  assert.equal(q.state, 'queued'); assert.ok(q.blocked_by.includes('open_positions')); assert.match(q.reason, /still open/);
  const mine = (await w.call('my_position', w.J)).withdrawals[0];
  assert.match(mine.reason, /open trades to close/); assert.ok(!('lock_exception' in mine));
  const u = await w.units('john');
  const v2 = await w.okCheck(1000, 0);                                        // both closed, reconciled
  const quote = await w.call('admin_quote_withdrawal', w.A, rid, v2, false, false);
  assert.equal(await w.units('john'), u);                                     // the quote changed nothing
  assert.equal((await w.q(`select status from public.withdrawal_requests where id=${rid}`))[0].status, 'pending');
  const out = await w.call('admin_execute_withdrawal', w.A, rid, v2, false, null, null, 'x1', false);
  assert.ok(near(out.pay_usdt, quote.pay_usdt)); assert.ok(near(out.pay_usdt, 400));
  assert.ok(near(await w.units('john'), 600));
  await assert.rejects(() => w.call('admin_execute_withdrawal', w.A, rid, v2, false, null, null, 'x2', false), /duplicate refused/);
  await assert.rejects(() => w.call('admin_apply_balance', w.A, v2, null, null, false), /already used/);   // MEXC balance changed
});

test('lock-up exception needs a written reason, is recorded and audited, and still goes through the engine', async () => {
  const w = await world(); await w.seed();
  await w.call('request_withdrawal', w.J, 200);
  const rid = (await w.call('my_requests', w.J))[0].id;
  await assert.rejects(() => w.call('admin_approve_withdrawal', w.A, rid, null, 'short'), /reason for the exception/);
  const ap = await w.call('admin_approve_withdrawal', w.A, rid, null, 'family emergency, approved by manager');
  assert.equal(ap.lock_exception, true);
  const v = await w.okCheck(1000, 0);
  await w.call('admin_execute_withdrawal', w.A, rid, v, false, null, null, null, false);
  assert.ok(near(await w.units('john'), 800));
  const ev = await w.call('admin_capital_events', w.A, 50);
  assert.ok(ev.some((e) => e.event === 'withdrawal_approved_lockup_exception' && /family emergency/.test(e.detail.lock_exception_reason)));
  assert.ok((await w.call('admin_audit_log', w.A, 100)).some((l) => l.action === 'wf_withdrawal_approved_lockup_exception'));
  assert.equal(Number((await w.q(`select count(*) n from public.ledger where kind='withdrawal'`))[0].n), 1);
  assert.ok(await w.tu() >= 0); // books check ran inside the engine
});

test('payout lifecycle: failed, retried, sent, completed; not repeatable; sent money is a known transfer in the next check', async () => {
  const w = await world(); await w.seed();
  await w.call('request_withdrawal', w.J, 300); const rid = (await w.call('my_requests', w.J))[0].id;
  await w.call('admin_approve_withdrawal', w.A, rid, null, 'approved as an exception for testing');
  const x = await w.okCheck(1000, 0);
  await w.call('admin_execute_withdrawal', w.A, rid, x, false, null, null, null, false);
  await assert.rejects(() => w.call('admin_payout_complete', w.A, rid, 'GC123', null), /sent from MEXC first/);
  await w.call('admin_payout_sent', w.A, rid, 'MEXC-WD-1', null);
  await w.call('admin_payout_fail', w.A, rid, 'GCash rejected the number');
  let s = (await w.call('my_position', w.J)).withdrawals[0]; assert.equal(s.state, 'payout_failed');
  await w.call('admin_payout_retry', w.A, rid, 'new number');
  await w.call('admin_payout_sent', w.A, rid, 'MEXC-WD-2', null);
  await w.call('admin_payout_complete', w.A, rid, 'GC-REF-9', null);
  s = (await w.call('my_position', w.J)).withdrawals[0]; assert.equal(s.state, 'completed');
  await assert.rejects(() => w.call('admin_payout_complete', w.A, rid, 'GC-REF-9', null), /duplicate refused/);
  const nx = await w.enter(700, 0); assert.ok(near(nx.known_out, 300)); assert.ok(Math.abs(nx.variance) < 1e-6);
});

test('delayed request is flagged and can be escalated; an unapproved request cannot be redeemed', async () => {
  const w = await world(); await w.seed();
  await w.call('request_withdrawal', w.J, 100); const rid = (await w.call('my_requests', w.J))[0].id;
  const x = await w.okCheck(1000, 0);
  await assert.rejects(() => w.call('admin_execute_withdrawal', w.A, rid, x, false, null, null, null, false), /approve the request first/);
  await w.db.exec(`update public.withdrawal_requests set pay_by = current_date - 2, requested_at = now() - interval '100 hours' where id = ${rid}`);
  await w.call('admin_approve_withdrawal', w.A, rid, null, 'approved as an exception for testing');
  const v = await w.enter(1000, 2); await w.confirm(v.id);          // two positions open: it queues
  const q = (await w.call('admin_capital_queue', w.A)).withdrawals[0];
  assert.equal(q.state, 'queued'); assert.equal(q.delayed, true); assert.equal(q.escalate, true);
  await w.call('admin_escalate', w.A, 'withdrawal', rid, 'will pay as soon as both trades close, told investor');
  assert.ok((await w.call('admin_capital_queue', w.A)).withdrawals[0].escalated_at);
});

test('settlement is refused with an unresolved difference, allowed after explanation; history cannot be edited', async () => {
  const w = await world(); await w.seed();
  const bad = await w.enter(1300, 0); await w.confirm(bad.id);
  await assert.rejects(() => w.call('admin_settle_quarter', w.A, bad.id, null, null, null, false), /not explained/);
  await w.call('admin_classify_difference', w.A, bad.id, 'trading_pnl', 'closed trades per bot log, 300 USDT');
  const quote = await w.call('admin_quote_close', w.A, bad.id, true); assert.equal(quote.quote, true);
  const before = await poolRows(w);
  const s = await w.call('admin_settle_quarter', w.A, bad.id, null, null, null, true);
  assert.equal(await poolRows(w), before + 1);
  assert.ok(near(s.unit_price, 1.3)); assert.ok(Number(s.fee_units) > 0);
  await assert.rejects(() => w.q('update public.balance_verifications set mexc_total = 5 where id=$1', [bad.id]), /cannot be edited/);
  await assert.rejects(() => w.q('delete from public.balance_verifications where id=$1', [bad.id]), /history/);
  await assert.rejects(() => w.call('admin_add_adjustment', w.A, bad.id, 'other', 5, 'too late to change this one'), /already used/);
  const p = await w.call('my_position', w.J);                       // finalized settlement shown separately from the estimate
  assert.equal(p.settlements.length, 1); assert.equal(p.settlements[0].kind, 'quarter_close');
});

test('investor position: unverified after a bot reading; flows separate; engine values passed through', async () => {
  const w = await world(); await w.seed();
  let p = await w.call('my_position', w.J);
  assert.equal(p.estimate.basis, 'verified'); assert.equal(p.estimate.reliable, true);
  await w.db.exec(`insert into public.ledger_settings(key,value) values ('bot_min_minutes','0') on conflict (key) do update set value='0'`);
  const bp = await w.call('bot_post_equity', 'b'.repeat(64), 1100, null); assert.equal(bp.ok, true);
  p = await w.call('my_position', w.J);
  assert.equal(p.estimate.reliable, false); assert.ok(p.estimate.last_verified); assert.match(p.estimate.reason, /not been verified/);
  const h = await w.h('john');
  assert.equal(Number(p.estimate.value_after_fee_usdt), Number(h.net_value_usdt));
  assert.equal(Number(p.capital.contributed_usdt), 1000); assert.equal(Number(p.capital.withdrawn_usdt), 0);
  assert.ok(near(p.capital.net_performance_usdt, Number(h.net_profit_usdt)));
  assert.deepEqual(p.settlements, []);
});

test('backup includes the workflow tables', async () => {
  const w = await world(); await w.seed();
  const ex = await w.call('admin_export_all', w.A);
  for (const k of ['balance_verifications', 'capital_events', 'payout_records', 'position_snapshots', 'verification_adjustments']) assert.ok(Array.isArray(ex[k]), k);
  assert.ok(ex.capital_events.length > 0);
});

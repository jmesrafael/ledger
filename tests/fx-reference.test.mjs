// 20261208000000_fx_reference_rate.sql: the ₱500 minimum and the default php_rate of new entries use the current PHP/USD reference rate (fx_reference_rates),
// never the rate stored on a pool entry or a deposit (a cash-in rate). Units, prices, pool values, fees and payouts do not depend on any peso rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, near } from './_tvworld.mjs';
const MIG = readFileSync(new URL('../supabase/migrations/20261208000000_fx_reference_rate.sql', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../supabase/rollback/20261208000000_rollback_fx_reference_rate.sql', import.meta.url), 'utf8');
const lastRate = async (w) => (await w.q(`select public._last_php_rate()::float r`))[0].r;
const hash = async (w, t) => (await w.q(`select count(*)::int n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by id), '')) h from public.${t} x`))[0];

// the live shape: raf in USDT, then James (₱5,000 = 66.40) and Raf (₱6,897 = 91.6278) join; their pool entries carry the CASH-IN rates
async function live() {
  const w = await world();
  await w.join('raf', 252.3082);
  const J = await w.call('admin_create_user', w.A, 'jamesrafael', 'James', 'james-password-1', 0.2); w.ids.james = J;
  await w.call('admin_receive_deposit', w.A, J, 66.4, 75.30120482, 5000, null, w.d(), null, true);
  await w.call('admin_receive_deposit', w.A, w.ids.raf, 91.6278, 75.27191529, 6897, null, w.d(), null, true);
  await w.call('admin_post_equity', w.A, 252.3082 + 158.0278, null, null, w.d());
  w.J = (await w.call('login', 'jamesrafael', 'james-password-1')).token;
  await w.call('accept_terms', w.J, '2026-10-26');
  await w.call('set_my_payout', w.J, 'gcash', 'James', '09170000000', null, null);
  return w;
}

test('FX1 no stored or cash-in rate is ever the current rate: with no reference reading the rate is NULL and the minimum is not checked', async () => {
  const w = await live();
  const rates = (await w.q(`select php_rate::float r from public.pool_equity where php_rate is not null order by id`)).map((x) => x.r);
  assert.ok(rates.includes(75.27191529) || rates.includes(75.30120482) || rates.includes(58), 'pool entries do carry stored rates: ' + rates);
  assert.equal(await lastRate(w), null, 'not the newest pool entry\'s rate any more');
  const ref = await w.call('fx_reference', w.J);
  assert.equal(ref.usd_php, null); assert.equal(ref.min_withdrawal_usdt, null); near(ref.min_withdrawal_php, 500); assert.equal(ref.max_age_hours, 168);
  await w.call('request_withdrawal', w.J, 1, null);   // about 1 USDT: allowed, because no current rate is known (never checked at a cash-in rate)
  assert.equal((await w.call('my_requests', w.J)).length, 1);
});

test('FX2 recording a reading: fund manager only, ₱20–₱200, fetched within the hour, a source; one per hour; logged; append-only', async () => {
  const w = await live();
  await assert.rejects(w.call('admin_record_fx_reference', w.J, 63.11, 'open.er-api.com', null), /admin only/);
  for (const bad of [19.99, 200.01, 0, -63, null]) await assert.rejects(w.call('admin_record_fx_reference', w.A, bad, 'x', null), /between 20 and 200/, String(bad));
  await assert.rejects(w.call('admin_record_fx_reference', w.A, 63.11, '  ', null), /name the source/);
  await assert.rejects(w.call('admin_record_fx_reference', w.A, 63.11, 'x', new Date(Date.now() - 2 * 3600e3).toISOString()), /within the last hour/);
  await assert.rejects(w.call('admin_record_fx_reference', w.A, 63.11, 'x', new Date(Date.now() + 10 * 60000).toISOString()), /within the last hour/);
  const r = await w.call('admin_record_fx_reference', w.A, 63.11, 'open.er-api.com', new Date(Date.now() - 5 * 60000).toISOString());
  assert.equal(r.recorded, true); near(r.usd_php, 63.11);
  const again = await w.call('admin_record_fx_reference', w.A, 64, 'frankfurter.dev', null);
  assert.equal(again.recorded, false); near(again.usd_php, 63.11, 1e-12, 'the hour\'s reading is kept');
  assert.equal((await w.q(`select count(*)::int n from public.fx_reference_rates`))[0].n, 1);
  const log = await w.q(`select detail from public.audit_log where action = 'fx_reference_recorded'`);
  assert.equal(log.length, 1); near(log[0].detail.usd_php, 63.11); assert.equal(log[0].detail.source, 'open.er-api.com');
  await assert.rejects(w.q(`update public.fx_reference_rates set usd_php = 70`), /append-only/);
  await assert.rejects(w.q(`delete from public.fx_reference_rates`), /append-only/);
  await w.db.exec('set role anon');
  try { await assert.rejects(w.q(`select * from public.fx_reference_rates`), /permission denied/, 'the website role cannot read or write the table directly'); }
  finally { await w.db.exec('reset role'); }
  near(await lastRate(w), 63.11);
  const ref = await w.call('fx_reference', w.J); near(ref.usd_php, 63.11); near(ref.min_withdrawal_usdt, 7.92); assert.equal(ref.source, 'open.er-api.com');
});

test('FX3 the ₱500 minimum is checked at the reference rate, not at the 75.27 cash-in rate on the pool entries', async () => {
  const w = await live();
  await w.call('admin_record_fx_reference', w.A, 63.11, 'open.er-api.com', null);
  const price = (await w.pool()).p;
  // 7.5 USDT: ₱564.53 at the cash-in rate 75.27 (would pass), ₱473.33 at the reference 63.11 (under the minimum)
  const u = 7.5 / price;
  await assert.rejects(w.call('request_withdrawal', w.J, u, null), /minimum withdrawal is 500 pesos/);
  await w.call('request_withdrawal', w.J, 8 / price, null);                                    // ₱504.88 at 63.11: allowed
  // the manager's payout: the rate the form sends (today's reference) or, with none, the stored reference
  await assert.rejects(w.call('admin_withdraw', w.A, w.ids.james, u, (await w.pool()).e, null, null, false, null, w.d(), null, true), /minimum withdrawal/);
  await assert.rejects(w.call('admin_withdraw', w.A, w.ids.james, u, (await w.pool()).e, 63.11, null, false, null, w.d(), null, true), /minimum withdrawal/);
  const ok = await w.call('admin_withdraw', w.A, w.ids.james, u, (await w.pool()).e, null, null, true, null, w.d(), null, true);   // override still works
  assert.ok(Number(ok.pay_usdt) > 0);
});

test('FX4 a reading older than fx_reference_max_age_hours (default 7 days) is not current; the window is a setting', async () => {
  const w = await live();
  await w.q(`insert into public.fx_reference_rates(usd_php, source, fetched_at, recorded_at) values (61, 'old', now() - interval '8 days', now() - interval '8 days')`);
  assert.equal(await lastRate(w), null);
  assert.equal((await w.call('fx_reference', w.J)).usd_php, null);
  await w.mode('fx_reference_max_age_hours', '240');
  near(await lastRate(w), 61);
  await w.q(`insert into public.fx_reference_rates(usd_php, source, fetched_at) values (62, 'future', now() + interval '1 day')`);
  near(await lastRate(w), 61, 1e-12, 'a reading dated in the future is never current');
});

test('FX5 new entries without a rate get the current reference rate (or none), never a cash-in rate; given rates are kept as given', async () => {
  const w = await live();
  await w.call('admin_post_equity', w.A, (await w.pool()).e, null, 'no rate', w.d());
  assert.equal((await w.q(`select php_rate from public.pool_equity order by id desc limit 1`))[0].php_rate, null);
  await w.call('admin_record_fx_reference', w.A, 63.11, 'open.er-api.com', null);
  await w.call('admin_post_equity', w.A, (await w.pool()).e, null, 'reference', w.d());
  near((await w.q(`select php_rate::float r from public.pool_equity order by id desc limit 1`))[0].r, 63.11);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 50, null, null, null, w.d(), null, true);
  near((await w.q(`select php_rate::float r from public.pending_deposits order by id desc limit 1`))[0].r, 63.11);
  await w.call('admin_receive_deposit', w.A, w.ids.dino, 66.4, 75.30120482, 5000, null, w.d(), null, true);
  near((await w.q(`select php_rate::float r from public.pending_deposits order by id desc limit 1`))[0].r, 75.30120482, 1e-12, 'a peso deposit keeps its own cash-in rate');
});

test('FX6 the reference rate changes no payout, fee, units or pool value', async () => {
  const out = [];
  for (const r of [null, 40, 150]) {
    const w = await live();
    if (r) await w.call('admin_record_fx_reference', w.A, r, 'test', null);
    const p = await w.pool();
    const q = await w.call('admin_quote_withdraw', w.A, w.ids.james, 30, p.e, null, true, false, null, true);
    const x = await w.call('admin_withdraw', w.A, w.ids.james, 30, p.e, null, null, true, null, w.d(), null, true);
    out.push({ q, x, p: await w.pool(), james: await w.units('james'), raf: await w.units('raf') });
  }
  for (const o of out.slice(1)) {
    for (const k of ['unit_price', 'fee_units', 'net_units', 'pay_usdt']) near(o.q[k], Number(out[0].q[k]), 1e-12, k);
    near(o.x.pay_usdt, Number(out[0].x.pay_usdt), 1e-12); near(o.p.e, out[0].p.e, 1e-9); near(o.p.u, out[0].p.u, 1e-12); near(o.p.p, out[0].p.p, 1e-15);
    near(o.james, out[0].james, 1e-12); near(o.raf, out[0].raf, 1e-12);
  }
});

test('FX7 applying the migration changes no existing row; it runs twice; the rollback restores the old functions and keeps the readings; it can be applied again', async () => {
  const w = await live();
  await w.db.exec(RB);                                                        // back to the state before this file
  near(await lastRate(w), (await w.q(`select php_rate::float r from public.pool_equity where php_rate is not null order by id desc limit 1`))[0].r, 1e-12, 'old: newest pool entry');
  const T = ['ledger', 'pool_equity', 'pending_deposits', 'withdrawal_requests', 'flow_checkpoints', 'book_corrections'];
  const before = {}; for (const t of T) before[t] = await hash(w, t);
  const settingsBefore = (await w.q(`select md5(string_agg(key || '=' || value, ',' order by key)) h from public.ledger_settings where key <> 'fx_reference_max_age_hours'`))[0].h;
  await w.db.exec(MIG); await w.db.exec(MIG);                                // apply, twice
  for (const t of T) assert.deepEqual(await hash(w, t), before[t], t + ' unchanged');
  assert.equal((await w.q(`select md5(string_agg(key || '=' || value, ',' order by key)) h from public.ledger_settings where key <> 'fx_reference_max_age_hours'`))[0].h, settingsBefore, 'no setting changed (one added)');
  assert.equal(await lastRate(w), null);
  await w.call('admin_record_fx_reference', w.A, 63.11, 'open.er-api.com', null);
  const cov = await w.call('admin_backup_coverage', w.A); assert.ok(!cov.missing.includes('fx_reference_rates'), 'the backup carries the readings');
  const ex = (await w.q(`select public._export_extra() e`))[0].e; assert.equal(ex.fx_reference_rates.length, 1); assert.ok(ex.flow_checkpoints && ex.book_corrections && ex.closed_trades, 'and everything it carried before');
  await w.db.exec(RB); await w.db.exec(RB);                                  // rollback, twice
  assert.equal((await w.q(`select to_regprocedure('public.admin_record_fx_reference(text,numeric,text,timestamptz)') f`))[0].f, null);
  assert.equal((await w.q(`select to_regprocedure('public.fx_reference(text)') f`))[0].f, null);
  assert.equal((await w.q(`select count(*)::int n from public.fx_reference_rates`))[0].n, 1, 'the readings are kept');
  assert.notEqual(await lastRate(w), null, 'old behaviour back: the newest pool entry\'s rate');
  for (const t of T) assert.deepEqual(await hash(w, t), before[t], t + ' unchanged by the rollback');
  assert.equal((await w.q(`select public._export_extra() e`))[0].e.fx_reference_rates.length, 1);
  await w.db.exec(MIG);                                                       // and again
  near(await lastRate(w), 63.11);
});

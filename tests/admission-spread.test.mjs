// 20261209000000_admission_spread.sql: ₱5,000 credited at ₱63 per USDT while the actual / reference rate is ₱62 (80.645161 USDT actually allocated):
//   credited 79.365079 USDT (the investor's units), manager-owned surplus 1.280082 USDT. The surplus is the manager's own units (p2p purchase) or simply stays in the manager's
//   holding (reallocation): never shared pool equity, never a trading result, never a change of anyone else's units, price or value; no duplicate pool deposit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, adv, near } from './_tvworld.mjs';

const MIG = readFileSync(new URL('../supabase/migrations/20261209000000_admission_spread.sql', import.meta.url), 'utf8');
const RB = readFileSync(new URL('../supabase/rollback/20261209000000_rollback_admission_spread.sql', import.meta.url), 'utf8');
const PHP = 5000, REF = 62, ADM = 63, ACTUAL = 80.645161, CREDITED = 79.365079, SURPLUS = 1.280082;
const r8 = (x) => Math.round(x * 1e8) / 1e8;

// raf (the manager) holds 1000 units, dino (an investor) 500; the pool then made 10%: price 1.1; true-value pricing on, wallets report the books (no open trades)
async function base({ rafUnits = 1000, gain = true, tv = true } = {}) {
  const w = await world();
  await w.join('raf', rafUnits); await w.join('dino', 500);
  if (gain) { const p = await w.pool(); await w.call('admin_post_equity', w.A, p.e * 1.1, null, 'gain', w.d()); }
  await adv(w, 5);
  if (tv) await w.mode('flow_pricing', 'true_value');
  w.J = (await w.call('login', 'john', 'john-password')).token;
  return w;
}
const ARGS = (w, source, o = {}) => [w.A, o.profile ?? w.ids.john, o.php ?? PHP, o.ref ?? REF, o.adm ?? ADM, o.actual ?? ACTUAL, source, null, o.mexc ?? true, o.idem ?? null];
const state = async (w) => ({
  pool: await w.pool(), units: { raf: await w.units('raf'), dino: await w.units('dino'), john: await w.units('john') },
  pend: Number((await w.q(`select count(*) n from public.pending_deposits`))[0].n), entries: Number((await w.q(`select count(*) n from public.pool_equity`))[0].n),
});
const spread = async (w, id) => (await w.call('admin_admission_spreads', w.A)).find((s) => Number(s.id) === Number(id));

test('AS1 the example: ₱5,000 at ₱63 against ₱62 is 79.365079 USDT credited, 80.645161 allocated, 1.280082 manager-owned (quote: nothing is saved)', async () => {
  const w = await base();
  const before = await state(w);
  for (const src of ['p2p_purchase', 'manager_reallocation']) {
    await w.report(before.pool.e, 0);
    const q = await w.call('admin_quote_admission_spread', w.A, w.ids.john, PHP, REF, ADM, ACTUAL, src);
    near(q.credited_usdt, CREDITED, 1e-9); near(q.actual_usdt, ACTUAL, 1e-9); near(q.surplus_usdt, SURPLUS, 1e-9); assert.equal(q.quote, true);
  }
  const after = await state(w);
  assert.deepEqual(after, before, 'a quote changes nothing');
  assert.equal((await w.q(`select count(*)::int n from public.admission_spreads`))[0].n, 0);
  near(5000 / 63, 79.36507936, 1e-8); near(5000 / 62, 80.64516129, 1e-8);
});

test('AS2 p2p purchase: two linked waiting deposits; the investor\'s carries the pesos and the admission rate; nothing is in the pool until both are admitted', async () => {
  const w = await base();
  const before = await state(w);
  for (let i = 0; i < 3; i++) await w.call('admin_quote_admission_spread', w.A, w.ids.john, PHP, REF, ADM, ACTUAL, 'p2p_purchase');   // quotes use up no number
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  assert.equal(Number(r.spread_id), 1, 'the first real spread is #1 however many quotes were made');
  assert.equal(r.status, 'waiting'); near(r.credited_usdt, CREDITED, 1e-9); near(r.surplus_usdt, SURPLUS, 1e-9);
  const s = (await w.q(`select * from public.admission_spreads`))[0];
  assert.equal(s.funding_source, 'p2p_purchase'); near(s.php_amount, PHP); near(s.reference_rate, REF); near(s.admission_rate, ADM); near(s.credited_usdt, CREDITED, 1e-9);
  near(s.actual_usdt, ACTUAL, 1e-9); near(s.surplus_usdt, SURPLUS, 1e-9); assert.equal(s.profile_id, w.ids.john); assert.equal(s.manager_id, w.ids.raf);
  const [inv, mgr] = await w.q(`select * from public.pending_deposits where id in ($1, $2) order by id`, [s.investor_pending_id, s.manager_pending_id]);
  assert.equal(inv.profile_id, w.ids.john); near(inv.usdt, CREDITED, 1e-9); near(inv.php_amount, PHP); near(inv.php_rate, ADM); assert.equal(inv.status, 'pending');
  assert.equal(mgr.profile_id, w.ids.raf); near(mgr.usdt, SURPLUS, 1e-9); assert.equal(mgr.php_amount, null, 'the surplus has no pesos: it is the manager\'s');
  near(Number(inv.usdt) + Number(mgr.usdt), ACTUAL, 1e-9, 'the two legs add up to the USDT actually allocated');
  const after = await state(w);
  assert.equal(after.entries, before.entries, 'no pool entry yet'); assert.deepEqual(after.units, before.units); assert.equal(after.pend, before.pend + 2);
  const au = await w.q(`select detail from public.audit_log where action = 'admission_spread_recorded'`);
  assert.equal(au.length, 1); near(au[0].detail.surplus_usdt, SURPLUS, 1e-9); near(au[0].detail.credited_usdt, CREDITED, 1e-9); assert.equal(au[0].detail.funding_source, 'p2p_purchase');
  assert.equal(String(s.credited_usdt), '79.365079', 'stored to exactly 6 decimals'); assert.equal(String(s.surplus_usdt), '1.280082');
});

test('AS3 p2p admitted: investor units for the CREDITED USDT only, the surplus becomes the MANAGER\'s units, price and everyone else unchanged, no trading profit, no fee on the spread', async () => {
  const w = await base();
  const b0 = await state(w); const H0 = await w.call('admin_overview', w.A); const dino0 = H0.find((h) => h.id === w.ids.dino), raf0 = H0.find((h) => h.id === w.ids.raf);
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  await w.report(b0.pool.e + ACTUAL, 0);                                                 // the exchange holds the pool plus all the USDT that arrived
  const price = (await w.call('admin_true_value', w.A)).unit_price; near(price, 1.1, 1e-9);
  const adm = await w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, 'adm-1');
  near(adm.unit_price, price, 1e-9);
  const a = await state(w);
  const johnUnits = r8(CREDITED / price), mgrUnits = r8(SURPLUS / price);
  near(a.units.john, johnUnits, 1e-8, 'investor units = credited USDT / admission price');
  near(a.units.raf, b0.units.raf + mgrUnits, 1e-8, 'the surplus is the manager\'s own units');
  near(a.units.dino, b0.units.dino, 1e-12, 'another investor: units unchanged');
  near(a.units.john * price, CREDITED, 1e-6, 'the investor holds exactly what was credited (never the surplus)');
  near(mgrUnits * price, SURPLUS, 1e-6);
  near(a.pool.e, b0.pool.e + ACTUAL, 1e-6, 'the pool grew by the USDT actually allocated, nothing else');
  near(a.pool.u, b0.pool.u + johnUnits + mgrUnits, 1e-7, 'total units = old + investor + manager surplus');
  near(a.pool.p, b0.pool.p, 1e-8, 'the unit price did not move: the surplus is not shared pool equity');
  const H1 = await w.call('admin_overview', w.A); const dino1 = H1.find((h) => h.id === w.ids.dino), raf1 = H1.find((h) => h.id === w.ids.raf), john1 = H1.find((h) => h.id === w.ids.john);
  near(dino1.value_usdt, dino0.value_usdt, 1e-9, 'another investor\'s value is unchanged'); near(dino1.profit_usdt, dino0.profit_usdt, 1e-9); near(dino1.share_pct, Number(dino0.share_pct) * b0.pool.u / a.pool.u, 1e-9);
  near(Number(raf1.value_usdt) - Number(raf0.value_usdt), SURPLUS, 1e-6, 'the manager\'s value rose by exactly the surplus');
  near(raf1.profit_usdt, raf0.profit_usdt, 1e-9, 'and it is NOT a trading result: the manager\'s profit is unchanged (the surplus is money in)');
  near(john1.profit_usdt, 0, 1e-6, 'the investor starts at zero profit on the credited amount'); near(john1.net_in_usdt, CREDITED, 1e-9);
  const rows = await w.q(`select kind, usdt::float u from public.ledger where profile_id = $1 order by id desc limit 1`, [w.ids.raf]);
  assert.equal(rows[0].kind, 'deposit'); near(rows[0].u, SURPLUS, 1e-9);
  assert.equal((await w.q(`select count(*)::int n from public.auto_pool_runs`))[0].n, 0, 'no trading booking');
  const led = await w.q(`select php_amount::float a, php_rate::float r, usdt::float u from public.ledger where profile_id = $1`, [w.ids.john]);
  assert.equal(led.length, 1); near(led[0].a, PHP); near(led[0].r, ADM); near(led[0].u, CREDITED, 1e-9);
  const hwm = (await w.q(`select hwm_value::float h from public.investor_hwm where profile_id = $1`, [w.ids.john]))[0]; near(hwm.h, CREDITED, 1e-9);   // no fee is ever owed on the spread
  const sp = await spread(w, r.spread_id); assert.equal(sp.status, 'admitted'); near(sp.investor_units, johnUnits, 1e-8); near(sp.manager_units, mgrUnits, 1e-8); near(sp.unit_price, price, 1e-9);
  const rep = await w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, 'adm-1'); assert.equal(rep.replayed, true);
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind = 'deposit' and profile_id in ($1, $2)`, [w.ids.john, w.ids.raf]))[0].n, 3, 'no duplicate issuance on a replay (raf: join + surplus, john: one)');
});

test('AS3b with OPEN trades the TRUE unit price (what a unit is worth if every trade closed) is unchanged by the admission, and so is every other holder\'s true value', async () => {
  const w = await base();
  const b0 = await state(w);
  await w.report(b0.pool.e, 30);                                                         // 30 USDT of open profit is in the wallets, not in the books
  const t0 = await w.call('admin_true_value', w.A); assert.equal(t0.ok, true, JSON.stringify(t0.reasons));
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  await w.report(b0.pool.e + ACTUAL, 30);
  const t1 = await w.call('admin_true_value', w.A); near(t1.unit_price, t0.unit_price, 1e-9, 'the same unit price once the money is counted');
  const adm = await w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, null); near(adm.unit_price, t0.unit_price, 1e-9, 'admitted at the true price');
  await adv(w, 5); await w.report(b0.pool.e + ACTUAL, 30);
  const t2 = await w.call('admin_true_value', w.A); assert.equal(t2.ok, true, JSON.stringify(t2.reasons));
  near(t2.unit_price, t0.unit_price, 1e-9, 'true unit price unchanged by the admission');
  const a = await state(w);
  near(a.units.dino * t2.unit_price, b0.units.dino * t0.unit_price, 1e-7, 'another investor true value unchanged');
  near(a.units.john * t2.unit_price, CREDITED, 1e-6); near((a.units.raf - b0.units.raf) * t2.unit_price, SURPLUS, 1e-6);
  near(t2.true_value_usdt - t0.true_value_usdt, ACTUAL, 1e-6, 'the pool true value rose by the USDT actually allocated, nothing else');
});

test('AS4 later trading is shared pro rata by units like any other money: the surplus units earn and lose like the manager\'s units, the spread itself creates no gain', async () => {
  const w = await base();
  const b0 = await state(w);
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  await w.report(b0.pool.e + ACTUAL, 0);
  await w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, null);
  const a = await state(w); const price0 = a.pool.p;
  await adv(w, 10);
  await w.trade({ pos: 'gain', pnl: 100 }); await w.report(a.pool.e + 100, 0);
  const p = await w.pool(); near(p.p, price0 * (1 + 100 / a.pool.e), 1e-9, 'the price moves with the trade only');
  const H = await w.call('admin_overview', w.A); const john = H.find((h) => h.id === w.ids.john), dino = H.find((h) => h.id === w.ids.dino);
  near(john.gross_profit_usdt ?? john.profit_usdt, CREDITED * (p.p / price0 - 1), 1e-6, 'the investor\'s gain is on the CREDITED amount');
  near(dino.profit_usdt, 500 * 1.1 * (p.p / price0 - 1) + (500 * 1.1 - 500), 1e-6);
});

test('AS5 manager reallocation: only the credited units move from the manager to the investor; no pool deposit, no pending deposit, equity and total units unchanged; the surplus stays with the manager', async () => {
  const w = await base();
  const b0 = await state(w); const H0 = await w.call('admin_overview', w.A); const dino0 = H0.find((h) => h.id === w.ids.dino), raf0 = H0.find((h) => h.id === w.ids.raf);
  await w.report(b0.pool.e, 0);
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'manager_reallocation', { idem: 'real-1' }));
  const price = r.unit_price; near(price, 1.1, 1e-9); const johnUnits = r8(CREDITED / price);
  assert.equal(r.status, 'done'); near(r.units, johnUnits, 1e-8);
  const a = await state(w);
  near(a.units.john, johnUnits, 1e-8); near(a.units.raf, b0.units.raf - johnUnits, 1e-8, 'the manager gave up exactly the credited units'); near(a.units.dino, b0.units.dino, 1e-12);
  near(a.pool.u, b0.pool.u, 1e-9, 'total units unchanged'); near(a.pool.e, b0.pool.e, 1e-9, 'pool equity unchanged'); near(a.pool.p, b0.pool.p, 1e-12, 'unit price unchanged');
  assert.equal(a.pend, b0.pend, 'NO pending deposit: nothing was added to the pool'); assert.equal(a.entries, b0.entries + 1, 'one pool entry, a transfer');
  const e = (await w.q(`select kind, equity_usdt::float e, total_units::float u from public.pool_equity order by id desc limit 1`))[0];
  assert.equal(e.kind, 'withdrawal'); near(e.e, b0.pool.e, 1e-9); near(e.u, b0.pool.u, 1e-9);
  assert.equal((await w.q(`select count(*)::int n from public.ledger where kind = 'deposit' and equity_id = $1`, [r.equity_id]))[0].n, 1, 'one deposit row (the investor\'s), no pool deposit for the manager');
  const H1 = await w.call('admin_overview', w.A); const dino1 = H1.find((h) => h.id === w.ids.dino), raf1 = H1.find((h) => h.id === w.ids.raf);
  near(dino1.value_usdt, dino0.value_usdt, 1e-9); near(Number(raf0.value_usdt) - Number(raf1.value_usdt), CREDITED, 1e-6, 'the manager\'s holding fell by exactly the credited USDT');
  // the allocation was 80.645161: what is left of it in the manager's holding is the surplus
  near(Number(raf1.value_usdt) - (Number(raf0.value_usdt) - ACTUAL), SURPLUS, 1e-6, 'the surplus stays the manager\'s');
  const s = (await w.q(`select * from public.admission_spreads`))[0]; assert.equal(s.funding_source, 'manager_reallocation'); assert.equal(s.investor_pending_id, null); near(s.surplus_usdt, SURPLUS, 1e-9);
  const cp = (await w.q(`select kind, subject_id, equity_id, units::float u, amount_usdt::float a, unit_price::float p, jsonb_array_length(wallets) w from public.flow_checkpoints order by id desc limit 1`))[0];
  assert.equal(cp.kind, 'reallocation'); assert.equal(Number(cp.subject_id), Number(s.id)); near(cp.a, CREDITED, 1e-9); near(cp.p, 1.1, 1e-9); assert.equal(cp.w, 3, 'the wallet reports it was priced on are kept');
  const led = await w.q(`select profile_id, kind, units::float n, usdt::float u, php_amount::float a, php_rate::float r from public.ledger where equity_id = $1 order by id`, [r.equity_id]);
  assert.equal(led.length, 2); assert.equal(led[0].profile_id, w.ids.john); near(led[0].a, PHP); near(led[0].r, ADM); assert.equal(led[1].profile_id, w.ids.raf); assert.equal(led[1].kind, 'withdrawal');
  near(Number(led[0].n) + Number(led[1].n), 0, 1e-9, 'units only moved');
  const hwm = (await w.q(`select hwm_value::float h from public.investor_hwm where profile_id = $1`, [w.ids.john]))[0]; near(hwm.h, CREDITED, 1e-9);
  const sp = await spread(w, r.spread_id); assert.equal(sp.status, 'done'); near(sp.investor_units, johnUnits, 1e-8);
  const again = await w.call('admin_admission_spread', ...ARGS(w, 'manager_reallocation', { idem: 'real-1' })); assert.equal(again.replayed, true);
  assert.equal((await state(w)).entries, a.entries, 'a retry does not move units twice');
  // the true-value machinery still works afterwards and a later deposit prices on the same pool value
  await w.report(b0.pool.e, 0);
  near((await w.call('admin_true_value', w.A)).unit_price, 1.1, 1e-9);
});

test('AS6 refused, nothing written: actual allocation below the credited amount, admission rate below the actual rate, spread above the agreed cap, numbers that do not match the rate', async () => {
  const w = await base();
  await w.report((await w.pool()).e, 0);
  const before = await state(w);
  const rej = (re, o, src = 'p2p_purchase') => assert.rejects(w.call('admin_admission_spread', ...ARGS(w, src, o)), re, JSON.stringify(o));
  await rej(/does not cover the credited amount \(79\.365079 USDT\).*nothing is taken from anywhere else/, { actual: 79 });
  await rej(/does not cover the credited amount/, { actual: 79 }, 'manager_reallocation');
  await rej(/does not cover the credited amount/, { ref: 63, adm: 63, actual: 79.0 });
  await rej(/admission rate \(62\) is below the actual \/ reference rate \(63\)/, { ref: 63, adm: 62 });
  await rej(/agreed spread is at most 1/, { adm: 64.5 });
  await rej(/imply 55\.5556 pesos per USDT, not the stated 62/, { actual: 90 });
  await rej(/between 20 and 200/, { ref: 5 }); await rej(/between 20 and 200/, { adm: 500, ref: 499 });
  await rej(/enter the pesos/, { php: 0 }); await rej(/enter the pesos/, { php: -5 });
  await rej(/at most 6 decimals/, { actual: 80.6451611 });
  await rej(/choose how it is funded/, {}, 'cash');
  await assert.rejects(w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase', { profile: w.ids.raf })), /for an investor/);
  await assert.rejects(w.call('admin_admission_spread', w.J, w.ids.john, PHP, REF, ADM, ACTUAL, 'p2p_purchase', null, true, null), /admin only/);
  await w.q(`update public.profiles set active = false where username = 'john'`);
  await assert.rejects(w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase')), /deactivated/);
  assert.deepEqual(await state(w), before, 'nothing was recorded by any refusal');
  assert.equal((await w.q(`select count(*)::int n from public.admission_spreads`))[0].n, 0);
});

test('AS7 a reallocation is refused unless the manager\'s holding covers the WHOLE actual allocation, and outside true-value pricing', async () => {
  const w = await base({ rafUnits: 50, gain: false });                                    // the manager holds only 50 units (worth 50 USDT)
  await w.report((await w.pool()).e, 0);
  const before = await state(w);
  await assert.rejects(w.call('admin_admission_spread', ...ARGS(w, 'manager_reallocation')), /does not cover the 80\.645161 USDT allocation: nothing is taken from anywhere else/);
  assert.deepEqual(await state(w), before);
  const b = await base({ tv: false });
  await assert.rejects(b.call('admin_admission_spread', ...ARGS(b, 'manager_reallocation')), /priced at true value: switch true-value pricing on/);
  const c = await base();                                                                 // true value on, but the wallets disagree with the books by more than the tolerance
  await c.report((await c.pool()).e - 40, 0);
  await assert.rejects(c.call('admin_admission_spread', ...ARGS(c, 'manager_reallocation')), /blocked: .*differ/);
});

test('AS8 the surplus must be real: claiming more USDT than arrived makes the true-value admission refuse (the exchange and the books would differ)', async () => {
  const w = await base();
  const b0 = await state(w);
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  await w.report(b0.pool.e + CREDITED, 0);                                               // only the credited part reached the exchange: the claimed surplus is not there
  await assert.rejects(w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, null), /blocked: .*differ/);
  assert.deepEqual((await state(w)).units, b0.units, 'no units were issued');
  assert.equal((await spread(w, r.spread_id)).status, 'waiting');
  await w.report(b0.pool.e + ACTUAL, 0);                                                 // once it really arrives, it admits
  await w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, null);
  assert.equal((await spread(w, r.spread_id)).status, 'admitted');
});

test('AS9 the two legs of a p2p spread are admitted or handed back TOGETHER: one alone is refused at commit and leaves nothing behind', async () => {
  const w = await base();
  const b0 = await state(w);
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  await w.report(b0.pool.e + ACTUAL, 0);
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, r.investor_pending_id, null), /must be admitted or handed back together/);
  await assert.rejects(w.call('admin_admit_deposit_tv', w.A, r.manager_pending_id, null), /must be admitted or handed back together/);
  await assert.rejects(w.call('admin_cancel_pending', w.A, r.investor_pending_id), /together/);
  const st = await w.q(`select status from public.pending_deposits where id in ($1, $2)`, [r.investor_pending_id, r.manager_pending_id]);
  assert.deepEqual(st.map((x) => x.status), ['pending', 'pending']); assert.deepEqual((await state(w)).units, b0.units);
  await w.call('admin_cancel_admission_spread', w.A, r.spread_id);                       // both together: fine
  assert.deepEqual((await w.q(`select status from public.pending_deposits where id in ($1, $2) order by id`, [r.investor_pending_id, r.manager_pending_id])).map((x) => x.status), ['cancelled', 'cancelled']);
  assert.equal((await spread(w, r.spread_id)).status, 'handed_back');
  await assert.rejects(w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, null), /handed back|cannot be admitted/);
  // a retry of the recording with the same id returns the first answer (no second pair of deposits)
  const x = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase', { idem: 'rec-1' })); const y = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase', { idem: 'rec-1' }));
  assert.equal(y.replayed, true); assert.equal(Number(y.spread_id), Number(x.spread_id));
  assert.equal((await w.q(`select count(*)::int n from public.pending_deposits where status = 'pending'`))[0].n, 2);
});

test('AS10 a spread with no surplus (admission = actual rate) has a single deposit; the record is append-only and closed to the website role', async () => {
  const w = await base();
  const r = await w.call('admin_admission_spread', w.A, w.ids.john, PHP, 62, 62, 80.645161, 'p2p_purchase', null, true, null);   // admission == reference: credited 80.645161
  near(r.surplus_usdt, 0, 1e-12); assert.equal(r.manager_pending_id, null);
  near(r.credited_usdt, 80.645161, 1e-9);
  assert.equal((await w.q(`select count(*)::int n from public.pending_deposits where profile_id = $1`, [w.ids.raf]))[0].n, 1, 'raf: only the earlier join, no surplus deposit');
  await assert.rejects(w.q(`update public.admission_spreads set surplus_usdt = 5`), /append-only/);
  await assert.rejects(w.q(`delete from public.admission_spreads`), /append-only/);
  await assert.rejects(w.q(`insert into public.admission_spreads(created_by, profile_id, manager_id, funding_source, php_amount, reference_rate, admission_rate, credited_usdt, actual_usdt, surplus_usdt, realloc)
    values ($1, $2, $1, 'manager_reallocation', 5000, 62, 63, 79, 80, 5, '{}')`, [w.ids.raf, w.ids.john]), /violates check/);
  await w.db.exec('set role anon');
  try { await assert.rejects(w.q(`select * from public.admission_spreads`), /permission denied/); } finally { await w.db.exec('reset role'); }
  await assert.rejects(w.call('admin_admission_spreads', w.J), /admin only/);
});

test('AS11 the migration changes no existing row; runs twice; its rollback is refused while a deposit waits, keeps the record, and it can be applied again', async () => {
  const w = await base();
  const T = ['ledger', 'pool_equity', 'pending_deposits', 'flow_checkpoints', 'book_corrections', 'withdrawal_requests'];
  const hash = async (t) => (await w.q(`select count(*)::int n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by id), '')) h from public.${t} x`))[0];
  const before = {}; for (const t of T) before[t] = await hash(t);
  await w.db.exec(RB);                                                                    // back to before this file
  assert.equal((await w.q(`select to_regprocedure('public.admin_admission_spread(text,uuid,numeric,numeric,numeric,numeric,text,text,boolean,text)') f`))[0].f, null);
  await w.db.exec(MIG); await w.db.exec(MIG);
  for (const t of T) assert.deepEqual(await hash(t), before[t], t + ' unchanged by the migration');
  const cov = await w.call('admin_backup_coverage', w.A); assert.ok(!cov.missing.includes('admission_spreads'), 'the backup carries the table');
  const b0 = await state(w);
  const r = await w.call('admin_admission_spread', ...ARGS(w, 'p2p_purchase'));
  await assert.rejects(w.db.exec(RB), /still has a waiting deposit/);
  await w.report(b0.pool.e + ACTUAL, 0); await w.call('admin_admit_admission_spread_tv', w.A, r.spread_id, null, null);
  await w.db.exec(RB); await w.db.exec(RB);
  assert.equal((await w.q(`select to_regprocedure('public.admin_admission_spreads(text)') f`))[0].f, null);
  assert.equal((await w.q(`select count(*)::int n from public.admission_spreads`))[0].n, 1, 'the record is kept');
  assert.equal((await w.q(`select count(*)::int n from public.ledger_settings where key in ('admission_spread_php', 'admission_rate_tolerance')`))[0].n, 0);
  assert.equal((await w.q(`select public._export_extra() e`))[0].e.admission_spreads.length, 1);
  await w.db.exec(MIG);
  assert.equal((await spread(w, r.spread_id)).status, 'admitted');
});

test('AS12 a spread changes no existing rule: the same deposit through the ordinary true-value path still prices the same, and settings default to the agreed ₱1 spread', async () => {
  const a = await base(), b = await base();
  assert.equal((await a.q(`select value from public.ledger_settings where key = 'admission_spread_php'`))[0].value, '1');
  assert.equal((await a.q(`select value from public.ledger_settings where key = 'admission_rate_tolerance'`))[0].value, '0.01');
  const pa = await a.receive('john', 50), pb = await b.receive('john', 50);
  await a.report((await a.pool()).e + 50, 0); await b.report((await b.pool()).e + 50, 0);
  const ra = await a.call('admin_admit_deposit_tv', a.A, pa, null), rb = await b.call('admin_admit_deposit_tv', b.A, pb, null);
  near(ra.units, rb.units, 1e-12); near(ra.unit_price, rb.unit_price, 1e-15);
  await a.mode('admission_spread_php', '2');                                              // the agreed spread is a setting: ₱2 is then allowed
  await a.report((await a.pool()).e, 0);
  const q = await a.call('admin_quote_admission_spread', a.A, a.ids.john, PHP, 62, 64, 80.645161, 'p2p_purchase');
  near(q.credited_usdt, 78.125, 1e-9); near(q.surplus_usdt, 2.520161, 1e-9);
});

// ---------------------------------------------------------------- the app side (js/contribution.js, js/app.js, js/truevalue-ui.js)
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('../js/contribution.js');
const TVUI = createRequire(import.meta.url)('../js/truevalue-ui.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('AS13 Contribution.spreadFigures: the example to the last digit; defaults for the form; bad input gives nothing', () => {
  const x = C.spreadFigures(5000, 62, 63, null);
  assert.equal(x.actual, 80.645161); assert.equal(x.credited, 79.365079); assert.equal(x.surplus, 1.280082); assert.equal(x.spread, 1); near(x.impliedRate, 5000 / 80.645161, 1e-12);
  const y = C.spreadFigures(5000, 62, 63, 80.645161); assert.deepEqual(y, x);
  assert.equal(C.spreadFigures(5000, 62.5, 62.5, null).surplus, 0, 'admission = actual rate: no surplus');
  assert.equal(C.spreadFigures(5000, 62, 63, 79).surplus, -0.365079, 'an insufficient allocation shows as a negative surplus (the database refuses it)');
  for (const bad of [[0, 62, 63], [5000, 0, 63], [5000, 62, null], ['x', 62, 63], [-5, 62, 63]]) assert.equal(C.spreadFigures(...bad), null, JSON.stringify(bad));
  assert.equal(C.spreadFigures.length, 4, 'pesos, reference rate, admission rate, actual: nothing about units, NAV or prices');
});

test('AS14 the investor sees what was credited and the rate applied, never the manager\'s surplus, and the numbers still add up', () => {
  const john = { id: 7, ts: '2026-11-08T01:00:00Z', kind: 'deposit', usdt: '79.365079', units: '72.15007182', php_amount: '5000', php_rate: '63' };
  const ref = C.referenceRate({ rate: 62, t: Date.now(), src: 'open.er-api.com' });
  const s = C.summary([john], ref, { units: '72.15007182', value_usdt: '79.365079' });
  assert.equal(s.php, 5000); assert.equal(s.usdt, 79.365079); near(s.rate, 63.00000029, 1e-7, 'pesos / credited USDT: the admission rate the investor was credited at');
  const h = C.card(s);
  for (const t of ['You paid', '₱5,000', 'Credited to you', '79.37 USDT', '₱63.00 paid per USDT', 'USDT credited to you']) assert.ok(h.includes(t), t);
  // nothing from the manager's side of the record: no surplus, no manager units, no spread or admission wording
  for (const t of ['surplus', 'manager', 'admission', 'spread', 'allocated', '80.645161']) assert.ok(!h.toLowerCase().includes(t.toLowerCase()), 'the investor card must not mention ' + t);
  // the one place the cost of converting shows is the generic comparison with TODAY'S market rate: it moves with the market, not with the manager's records
  const at = (rate) => C.card(C.summary([john], C.referenceRate({ rate, t: Date.now(), src: 'open.er-api.com' }), { units: '72.15007182', value_usdt: '79.365079' }));
  assert.ok(at(62).includes('Lost converting pesos to USDT') && at(62).includes('(1.28 USDT)'));
  assert.ok(at(60).includes('(3.97 USDT)') && !at(60).includes('(1.28 USDT)'), 'a different market rate gives a different figure');
  const j = C.journey(s); near(j.result, 0, 1e-9); near(j.paidPhp - j.conversionPhp + j.resultPhp, j.nowPhp, 1e-9);
});

test('AS15 the manager\'s screen: the Admission spread card, the database quote, Admit and Hand back for both parts together, the log wording, and nothing for investors', () => {
  const app = read('js/app.js');
  assert.match(app, /soft\(call\('admin_admission_spreads'\)\)/); assert.match(app, /S\.spreads = spreads;/);
  assert.match(app, /if \(S\.spreads == null\) return '';/, 'hidden until the migration is run');
  assert.match(app, /\$\{pendingCard\(\)\}\$\{spreadCard\(\)\}/);
  assert.match(app, /call\('admin_quote_admission_spread', args\)/);
  assert.match(app, /F = Contribution\.spreadFigures\(php0, ref, adm, num\(fv\(fm, 'act'\)\)\)/);
  assert.match(app, /moneyCall\(fm, 'admin_admission_spread', \{ \.\.\.args, p_note: null, p_in_mexc: /, 'one request id per form: a retry cannot save it twice');
  assert.match(app, /call\('admin_admit_admission_spread_tv', \{ p_spread: Number\(id\), p_as_of: null, p_idem: 'spread-admit-' \+ id \}\)/);
  assert.match(app, /call\('admin_cancel_admission_spread', \{ p_spread: Number\(id\) \}\)/);
  assert.match(app, /Move units from your capital\?/, 'a reallocation asks first');
  assert.match(app, /legs\.has\(Number\(d\.id\)\) \? `<span class="note">part of admission spread #/, 'a leg cannot be handed back alone');
  assert.match(app, /\['spreadForm', spreadPrev\]/);
  assert.match(app, /case 'admission_spread_recorded':/); assert.match(app, /case 'admission_spread_reallocated':/);
  const form = app.slice(app.indexOf('function spreadCard()'), app.indexOf('const spreadArgs'));
  assert.ok(form.includes('name="php"') && form.includes('name="ref"') && form.includes('name="adm"') && form.includes('name="act"') && form.includes('name="src"'));
  assert.ok(form.includes('Actual / reference rate (₱ per USDT)') && form.includes('Admission rate (₱ per USDT)') && form.includes('USDT actually allocated') && form.includes('New P2P purchase') && form.includes('My own capital (no new money)'));
  assert.ok(!/investor \? .*spreadCard|S\.me\.role === 'investor'.*spreadCard/.test(app), 'only the manager\'s Record tab has it');
  assert.equal(TVUI.adminCard({ mode: 'true_value', enabled: true, ok: true, allowed: true, reasons: [], wallets: [], corrections: [], unit_price: 1, book_price: 1, true_value_usdt: 1, combined_equity_usdt: 1,
    not_in_pool_usdt: 0, redeemed_not_sent_usdt: 0, open_pnl_usdt: 0, gap_usdt: 0, tolerance_usdt: 0.5, pool_cash_usdt: 1,
    checkpoints: [{ kind: 'reallocation', subject_id: 3, created_at: '2026-11-08T01:00:00Z', amount_usdt: 79.365079, unit_price: 1.1, book_before: 1, open_pnl: 0, gap: 0, realized_since: 0, wallets: [] }] }).includes('Reallocation #3'), true);
});

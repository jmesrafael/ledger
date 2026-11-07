// 20261210000000_peso_topup.sql: James's ₱5,000 bought only 66.40 USDT; at the live rate ₱63.083992 it is 79.259410 USDT, so 12.859410 USDT of the fund manager's units
// go to him at the true-value price. Nobody else's units, value or the pool move; the stored-reference, note, pricing and holding checks refuse with nothing written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, adv, near } from './_tvworld.mjs';

const RB = readFileSync(new URL('../supabase/rollback/20261210000000_rollback_peso_topup.sql', import.meta.url), 'utf8');
const GAP = 12.85941, RATE = 63.083992, NOTE = 'peso top-up for deposit #3: test';
const r8 = (x) => Math.round(x * 1e8) / 1e8;

async function base({ tv = true } = {}) {
  const w = await world();
  await w.join('raf', 1000); await w.join('dino', 500);
  const p = await w.pool(); await w.call('admin_post_equity', w.A, p.e * 1.1, null, 'gain', w.d());
  await adv(w, 5);
  if (tv) await w.mode('flow_pricing', 'true_value');
  return w;
}
const state = async (w) => ({ pool: await w.pool(), units: { raf: await w.units('raf'), dino: await w.units('dino'), john: await w.units('john') },
  entries: Number((await w.q(`select count(*) n from public.pool_equity`))[0].n), led: Number((await w.q(`select count(*) n from public.ledger`))[0].n) });

test('PT1 a top-up: the investor gets the manager\'s units for the gap at the true-value price; pool, price and everyone else unchanged; no fee on it; a retry is a replay', async () => {
  const w = await base();
  const b0 = await state(w); const dino0 = (await w.call('admin_overview', w.A)).find((h) => h.id === w.ids.dino);
  await w.report(b0.pool.e, 0);
  const q = await w.call('admin_quote_peso_topup', w.A, w.ids.john, GAP, RATE, NOTE);
  assert.equal(q.quote, true); assert.deepEqual(await state(w), b0, 'a quote saves nothing');
  const r = await w.call('admin_peso_topup', w.A, w.ids.john, GAP, RATE, NOTE, 'pt-1');
  near(r.unit_price, 1.1, 1e-9); near(r.units, r8(GAP / 1.1), 1e-8);
  const a = await state(w);
  near(a.units.john, r8(GAP / 1.1), 1e-8); near(a.units.raf, b0.units.raf - r8(GAP / 1.1), 1e-8); near(a.units.dino, b0.units.dino, 1e-12);
  near(a.pool.e, b0.pool.e, 1e-9); near(a.pool.u, b0.pool.u, 1e-9); near(a.pool.p, b0.pool.p, 1e-12); assert.equal(a.entries, b0.entries + 1);
  near((await w.call('admin_overview', w.A)).find((h) => h.id === w.ids.dino).value_usdt, dino0.value_usdt, 1e-9, 'another investor\'s value does not move');
  const led = await w.q(`select profile_id, kind, usdt::float u, php_amount, php_rate::float r, note from public.ledger where equity_id = $1 order by id`, [r.equity_id]);
  assert.equal(led.length, 2); assert.equal(led[0].profile_id, w.ids.john); assert.equal(led[0].kind, 'deposit'); near(led[0].u, GAP, 1e-9);
  assert.equal(led[0].php_amount, null, 'the pesos are on the original deposit, never counted twice'); near(led[0].r, RATE); assert.equal(led[0].note, NOTE);
  assert.equal(led[1].profile_id, w.ids.raf); assert.equal(led[1].kind, 'withdrawal'); near(led[1].u, -GAP, 1e-9);
  near((await w.q(`select hwm_value::float h from public.investor_hwm where profile_id = $1`, [w.ids.john]))[0].h, GAP, 1e-9);
  const cp = (await w.q(`select kind, amount_usdt::float a from public.flow_checkpoints order by id desc limit 1`))[0]; assert.equal(cp.kind, 'reallocation'); near(cp.a, GAP, 1e-9);
  assert.equal((await w.q(`select count(*)::int n from public.audit_log where action = 'peso_topup'`))[0].n, 1);
  const again = await w.call('admin_peso_topup', w.A, w.ids.john, GAP, RATE, NOTE, 'pt-1'); assert.equal(again.replayed, true);
  assert.equal((await state(w)).entries, a.entries, 'a retry does not move units twice');
});

test('PT2 refused, nothing written: rate far from the stored reference, a wrong note, bad amounts, a non-investor, too few manager units, book pricing', async () => {
  const w = await base();
  await w.report((await w.pool()).e, 0);
  await w.q(`insert into public.fx_reference_rates(usd_php, source, fetched_at, recorded_by) values (63.08, 'open.er-api.com', public._clock(), $1)`, [w.ids.raf]);
  const before = await state(w);
  const rej = (re, a) => assert.rejects(w.call('admin_peso_topup', w.A, ...a, null), re, JSON.stringify(a));
  await rej(/more than 2% from the fund's stored PHP\/USD reference/, [w.ids.john, GAP, 75.3, NOTE]);
  await rej(/must start with "peso top-up"/, [w.ids.john, GAP, RATE, 'gift']);
  await rej(/more than 0 USDT/, [w.ids.john, 0, RATE, NOTE]);
  await rej(/at most 6 decimals/, [w.ids.john, 1.1234567, RATE, NOTE]);
  await rej(/between 20 and 200/, [w.ids.john, GAP, 10, NOTE]);
  await rej(/for an investor/, [w.ids.raf, GAP, RATE, NOTE]);
  await rej(/nothing is taken from anyone else/, [w.ids.john, 5000, RATE, NOTE]);
  await w.mode('flow_pricing', 'book');
  await rej(/priced at true value/, [w.ids.john, GAP, RATE, NOTE]);
  assert.deepEqual(await state(w), before);
});

test('PT3 rollback removes the functions and keeps every recorded top-up', async () => {
  const w = await base();
  await w.report((await w.pool()).e, 0);
  await w.call('admin_peso_topup', w.A, w.ids.john, GAP, RATE, NOTE, null);
  const s = await state(w);
  await w.db.exec(RB);
  assert.deepEqual(await state(w), s);
  await assert.rejects(w.call('admin_peso_topup', w.A, w.ids.john, GAP, RATE, NOTE, null), /does not exist|function/);
});

// High-water mark fee, deposits that join only once in the exchange, lock-up as guidance (20261105000000_hwm_arrival_lockup.sql).
// Real migrations on an in-memory Postgres; every call goes in as the public "anon" role, like the website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, near, BOT_KEY } from './_world.mjs';

const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const hwmWorld = (opts = {}) => build({ later: true, users: ['john', 'dino', 'eve'], ...opts });
// money received; inMexc = the money is already in the exchange account
const recv = (w, who, usdt, inMexc = true) => w.call('admin_receive_deposit', w.A, w.ids[who], usdt, 58, usdt * 58, null, null, null, inMexc);
const post = (w, eq, confirm = true) => w.call('admin_post_equity', w.A, eq, null, null, null, null, confirm);
const close = (w, eq) => w.call('admin_close_quarter', w.A, eq, null, null, null, null, true);
const wd = (w, who, units, eqBefore, extra = {}) => w.call('admin_withdraw', w.A, w.ids[who], units, eqBefore, null, null, extra.force ?? false, null, null, null, true);
const pendIn = async (w) => Number((await w.q(`select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending' and arrived_at is not null`))[0].s);
// the exchange total for a unit price: the pool's units at that price plus money that is in the exchange but still waiting
const at = async (w, price) => (await w.tu()) * price + (await pendIn(w));
const setPrice = async (w, price) => post(w, await at(w, price));
const closeAt = async (w, price) => close(w, await at(w, price));
const wdAt = async (w, who, units, price, extra) => wd(w, who, units, await at(w, price), extra);
const join = async (w, who, usdt, price) => { await recv(w, who, usdt); return post(w, (await w.tu()) * price + (await pendIn(w))); };
const hwm = async (w, who) => Number((await w.q(`select hwm_value v from public.investor_hwm where profile_id=$1`, [w.ids[who]]))[0]?.v ?? NaN);
const feeUsdt = async (w, who, note = null) => Number((await w.q(`select coalesce(-sum(usdt),0) s from public.ledger where profile_id=$1 and kind='fee_out'${note ? ' and note=$2' : ''}`, note ? [w.ids[who], note] : [w.ids[who]]))[0].s);
const lastCloseFee = async (w, who) => Number((await w.q(`select coalesce(-sum(l.usdt),0) s from public.ledger l where l.profile_id=$1 and l.kind='fee_out' and l.equity_id=(select max(id) from public.pool_equity where kind='close')`, [w.ids[who]]))[0].s);
const value = async (w, who) => (await w.units(who)) * (await w.price());

// ============================================================ the fee follows real profit only
test('HW1 top-ups inside a quarter are not profit: money that was not there during a move pays nothing for it', async () => {
  const w = await hwmWorld();
  await recv(w, 'john', 1000); await recv(w, 'dino', 1000); await recv(w, 'raf', 1000);
  await post(w, 3000);
  await setPrice(w, 1.1);                                    // month 1: +10%
  await join(w, 'john', 1000, 1.1);                          // John tops up 1,000 (909.09 units)
  await setPrice(w, 1.21);                                   // month 2: +10%
  await join(w, 'john', 2000, 1.21);                         // and 2,000 the day before the close
  await closeAt(w, 1.21);
  assert.ok(near(await lastCloseFee(w, 'john'), 31, 1e-5), `John: 10% x (1,000 x 0.21 + 909.09 x 0.11) = 31, got ${await lastCloseFee(w, 'john')}`);
  assert.ok(near(await lastCloseFee(w, 'dino'), 21, 1e-5), 'Dino: 10% x 210 = 21');
  assert.ok(near(await hwm(w, 'john'), await value(w, 'john'), 1e-5), 'after the close the mark is the value after the fee');
});

test('HW2 a loss must be made back before any fee: lose 20%, recover to the start = no fee; only the gain above it is charged', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1);
  await closeAt(w, 0.8);
  assert.equal(await lastCloseFee(w, 'john'), 0, 'losing quarter: no fee');
  await closeAt(w, 1.0);
  assert.equal(await lastCloseFee(w, 'john'), 0, 'back to where he started: still no fee (the old rule charged 20 here)');
  await closeAt(w, 1.1);
  assert.ok(near(await lastCloseFee(w, 'john'), 10, 1e-5), 'only the 100 above his best is charged');
  await closeAt(w, 1.1);
  assert.equal(await lastCloseFee(w, 'john'), 0, 'the same gain is never charged twice');
});

// ============================================================ withdrawals
test('HW3 a withdrawal in profit settles its share; the rest follows the mark; total fee = 10% of the real profit', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1); await join(w, 'dino', 1000, 1);
  await setPrice(w, 1.1);
  const r = await wdAt(w, 'john', 500, 1.1);
  assert.ok(near(Number(r.fee_units) * 1.1, 5, 1e-6), '10% x 100 profit x half = 5 USDT');
  assert.ok(near(await hwm(w, 'john'), 500, 1e-6), 'the mark halves with the units: the 50 of profit left is still uncharged');
  await closeAt(w, 0.99);                                    // the 500 units left fall below their mark
  assert.equal(await lastCloseFee(w, 'john'), 0);
  await closeAt(w, 1.1);                                     // and come back
  assert.ok(near(await feeUsdt(w, 'john'), 10, 1e-5), `in total 10 = 10% of the 100 he really made, got ${await feeUsdt(w, 'john')}`);
});

test('HW4 reviewer case: take the profit out, the rest loses, add fresh money: the loss is kept and must be made back first', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1);
  await setPrice(w, 1.2);
  await wdAt(w, 'john', 500, 1.2);                           // fee 10 on half of the 200 gain
  await setPrice(w, 0.8);                                    // the units left fall: 500 x 0.8 = 400 against a mark of 500
  await join(w, 'john', 1000, 0.8);                          // fresh money
  assert.ok(near((await hwm(w, 'john')) - (await value(w, 'john')), 100, 1e-5), 'the 100 shortfall is still there after the deposit');
  await closeAt(w, 0.84);                                    // +5%: 70 of gain, still under the mark
  assert.equal(await lastCloseFee(w, 'john'), 0, 'no fee while the shortfall is not made back (the old rule charged 7 here)');
  const above = (await w.units('john')) * 0.9 - 1500;
  await closeAt(w, 0.9);
  assert.ok(near(await lastCloseFee(w, 'john'), 0.1 * above, 1e-5), `only what is above the mark (${above.toFixed(2)}) is charged`);
});

test('HW5 a withdrawal in a loss keeps the whole shortfall: out + what is left must reach what was put in before a fee', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1);
  await setPrice(w, 0.5);
  await wdAt(w, 'john', 500, 0.5);                           // takes 250 out
  assert.ok(near(await hwm(w, 'john'), 750, 1e-6), 'mark 1,000 - 250 = 750: the 500 shortfall stays');
  await closeAt(w, 1.5);                                     // 500 units x 1.5 = 750: 250 out + 750 = 1,000, just even
  assert.equal(await lastCloseFee(w, 'john'), 0);
  await closeAt(w, 1.6);
  assert.ok(near(await lastCloseFee(w, 'john'), 5, 1e-5), '50 above the mark, fee 5');
});

test('HW6 leaving at a loss and coming back keeps the loss: the same result as staying in and topping up', async () => {
  const exitAndBack = await hwmWorld(), stayAndTopUp = await hwmWorld();
  for (const w of [exitAndBack, stayAndTopUp]) { await join(w, 'raf', 1000, 1); await join(w, 'john', 1000, 1); await setPrice(w, 0.5); }
  const r = await wdAt(exitAndBack, 'john', 1000, 0.5);      // everything out: 500
  assert.ok(near(r.fee_units, 0) && near(await hwm(exitAndBack, 'john'), 500, 1e-6), 'full exit at a loss: no fee, the 500 shortfall is kept');
  await join(exitAndBack, 'john', 2000, 0.5);                // comes back with 2,000
  await join(stayAndTopUp, 'john', 1500, 0.5);               // or never left: 500 stays in, 1,500 more
  for (const w of [exitAndBack, stayAndTopUp]) {
    assert.ok(near(await hwm(w, 'john'), 2500, 1e-6) && near(await w.units('john'), 4000, 1e-6), 'both: 4,000 units, mark 2,500');
    await closeAt(w, 0.625);
    assert.equal(await lastCloseFee(w, 'john'), 0, 'back to 2,500: no fee yet');
    await closeAt(w, 0.7);
    assert.ok(near(await lastCloseFee(w, 'john'), 30, 1e-5), '300 above the mark: fee 30');
  }
});

test('HW7 an undone withdrawal or deposit puts the mark back exactly', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1);
  await setPrice(w, 1.2);
  await wdAt(w, 'john', 500, 1.2);
  await w.call('admin_undo_last', w.A, 'typo');
  assert.ok(near(await hwm(w, 'john'), 1000, 1e-9) && near(await w.units('john'), 1000, 1e-9), 'withdrawal undone: mark and units restored');
  await recv(w, 'john', 600); await post(w, await at(w, 1.2));
  await w.call('admin_undo_last', w.A, 'typo');
  assert.ok(near(await hwm(w, 'john'), 1000, 1e-9), 'deposit undone: mark restored');
});

test('HW8 the fund manager pays no fee and has no mark; moving an investor to the manager settles the fee like a withdrawal', async () => {
  const w = await hwmWorld();
  await join(w, 'raf', 1000, 1); await join(w, 'john', 1000, 1);
  await closeAt(w, 1.5);
  assert.equal((await w.q(`select count(*)::int n from public.investor_hwm where profile_id=$1`, [w.ids.raf]))[0].n, 0);
  assert.equal(await feeUsdt(w, 'raf'), 0);
  await setPrice(w, 1.65);
  const tu = await w.tu(), u = await w.units('john'), h = await hwm(w, 'john');
  const r = await w.call('admin_withdraw_to_manager', w.A, w.ids.john, 500, tu * 1.65, null, null, false, null, null, null, true);
  assert.ok(near(Number(r.fee_units) * 1.65, 0.1 * (u * 1.65 - h) * 500 / u, 1e-6), 'fee on the share moved, like a withdrawal');
  assert.ok(near(await hwm(w, 'john'), h * (1 - 500 / u), 1e-6), 'the mark shrinks by the same share');
  assert.ok(near(await w.tu(), tu, 1e-9), 'total units unchanged');
});

// ============================================================ deposits join only once their money is in the exchange
test('HW9 a deposit not yet in the exchange is not taken out of the total and does not join; once marked it joins at a fair price', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1);
  await recv(w, 'eve', 300, false);                         // still in GCash
  const e = await err(() => post(w, 1000, false));
  assert.match(e ?? '', /^CONFIRM: 1 waiting deposit/, 'a reading asks first');
  await post(w, 1000, true);
  assert.ok(near(await w.price(), 1, 1e-9), 'price unchanged: her 300 is not subtracted from a total that does not contain it');
  assert.equal(await w.units('eve'), 0, 'she does not join yet');
  const bot = await w.call('bot_post_equity', BOT_KEY, 1000, null);
  assert.equal(bot.ok, false, 'the bot does not post while a deposit is waiting');
  const id = (await w.q(`select id from public.pending_deposits where status='pending'`))[0].id;
  await w.call('admin_mark_arrived', w.A, id, null);
  await post(w, 1300);
  assert.ok(near(await w.units('eve'), 300, 1e-6) && near(await value(w, 'john'), 1000, 1e-6), 'Eve 300 units at 1.00, John unchanged: nobody gains or loses');
});

// ============================================================ lock-up: guidance only
test('HW10 the lock-up is wording only: only the first deposit gets a date, and withdrawals are not refused inside it', async () => {
  const w = await hwmWorld();
  await join(w, 'john', 1000, 1);
  await join(w, 'john', 500, 1);
  const locks = await w.q(`select lock_until from public.ledger where profile_id=$1 and kind='deposit' order by id`, [w.ids.john]);
  assert.ok(locks[0].lock_until !== null && locks[1].lock_until === null, 'first deposit dated, top-up not');
  const r = await wdAt(w, 'john', 200, 1);                  // no force
  assert.ok(near(r.pay_usdt, 200, 1e-6), 'paid inside the lock-up without an override');
  const J = await w.tok('john');
  await w.call('set_my_payout', J, 'gcash', 'John', '09171234567', null, null);
  const q = await w.call('request_withdrawal', J, 100, null);
  assert.ok(q.pay_by, 'the investor can ask inside the lock-up; the fund manager decides');
  await w.db.exec(`update public.ledger_settings set value='1' where key='lock_enforced'`);
  assert.match(await err(() => wdAt(w, 'john', 100, 1)) ?? '', /locked/, 'lock_enforced = 1 turns the old rule back on');
});

// ============================================================ cutover from the flat engine
test('HW11 cutover: the mark starts where the last quarter close left each investor, so a loss since then is made back first', async () => {
  const w = await build({ later: false, users: ['john'] });
  await w.join('john', 1000, 1000);
  await w.call('admin_close_quarter', w.A, 1200, null, null, null, null, true);          // flat engine: fee 20 at 1.2
  await w.call('admin_post_equity', w.A, (await w.tu()) * 0.9, null, null, null, null, true);
  await w.migrateLater();
  assert.equal((await w.q(`select value from public.ledger_settings where key='fee_engine'`))[0].value, 'investor_hwm_v2');
  assert.ok(near(await hwm(w, 'john'), (await w.units('john')) * 1.2, 1e-6), 'mark = his value right after the last close');
  await closeAt(w, 1.2);
  assert.equal(await lastCloseFee(w, 'john'), 0, 'back to the last close level: no fee (the flat rule charged 10% of the 0.3 rise)');
});

// ============================================================ randomized model check
test('HW12 random deposits, withdrawals, price moves and closes match an independent high-water-mark model', async () => {
  const floor8 = (x) => Math.floor(Math.round(x * 1e12) / 1e4) / 1e8;
  for (const seed of [7, 21, 99]) {
    let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const w = await hwmWorld({ users: ['john', 'dino', 'eve'] });
    const who = ['john', 'dino', 'eve'], M = { john: { u: 0, h: 0 }, dino: { u: 0, h: 0 }, eve: { u: 0, h: 0 } };
    let price = 1;
    for (const x of who) { await join(w, x, 1000, price); M[x].u += 1000; M[x].h += 1000; }
    for (let i = 0; i < 30; i++) {
      const op = rnd(), x = who[Math.floor(rnd() * 3)];
      if (op < 0.35) { price = Math.round(price * (0.85 + rnd() * 0.3) * 1e6) / 1e6; await setPrice(w, price); }
      else if (op < 0.55) { const d = Math.round(100 + rnd() * 900); await join(w, x, d, price); M[x].u += Math.round(d / price * 1e8) / 1e8; M[x].h += d; }
      else if (op < 0.8 && M[x].u > 1) {
        const n = Math.round(M[x].u * (0.1 + rnd() * 0.9) * 1e8) / 1e8, E = M[x].u * price, sh = Math.min(1, n / M[x].u);
        await wdAt(w, x, n, price, { force: true });
        M[x].h = Math.max(0, M[x].h - sh * Math.min(E, M[x].h)); M[x].u -= n;
      } else {
        await closeAt(w, price);
        for (const y of who) if (M[y].u > 0 && M[y].u * price > M[y].h) { const f = floor8(0.1 * (M[y].u * price - M[y].h) / price); M[y].u -= f; M[y].h = M[y].u * price; }
      }
      price = await w.price();
    }
    for (const x of who) {
      assert.ok(near(await w.units(x), M[x].u, 1e-6), `seed ${seed} ${x}: units ${await w.units(x)} vs model ${M[x].u}`);
      assert.ok(near(await hwm(w, x), M[x].h, 1e-4), `seed ${seed} ${x}: mark ${await hwm(w, x)} vs model ${M[x].h}`);
    }
  }
});

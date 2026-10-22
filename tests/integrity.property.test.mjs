// Randomized model check of the flat fee on period profit. The model below accrues profit INCREMENTALLY at every price move
// (N_i += units_i x price change), while the database REPLAYS the pool history (sum of units-before-entry x price change) and keeps a
// "credit" for withdrawals. Two different formulations of one rule must agree after every step: units, the net profit of the period,
// the unit price, what a withdrawal pays, and the fee at every settlement. Seeds are fixed, so a failure is reproducible.
// Steps include deposits left waiting across several valuations, fee-rate changes, big price jumps, partial and full exits, and undos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './_world.mjs';

const R8 = (x) => Math.round(x * 1e8) / 1e8, F8 = (x) => Math.floor(Math.round(x * 1e12) / 1e4) / 1e8, R6 = (x) => Math.round(x * 1e6) / 1e6;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const INV = ['john', 'dino', 'eve'];
export const SEEN = {};

class Model {
  constructor(rate) { this.rate = { john: rate, dino: rate, eve: rate }; this.next = { john: null, dino: null, eve: null }; this.P = 1;
    this.u = { raf: 0, john: 0, dino: 0, eve: 0 }; this.N = { john: 0, dino: 0, eve: 0 }; this.pending = []; }
  get U() { return Object.values(this.u).reduce((s, x) => s + x, 0); }
  get waiting() { return this.pending.reduce((s, d) => s + d.amt, 0); }
  clone() { const m = new Model(0); m.rate = { ...this.rate }; m.next = { ...this.next }; m.P = this.P; m.u = { ...this.u }; m.N = { ...this.N }; m.pending = this.pending.map((d) => ({ ...d })); return m; }
  move(P) { for (const k of INV) this.N[k] += this.u[k] * (P - this.P); this.P = P; }            // incremental accrual
  joinAll() { for (const d of this.pending) this.u[d.who] = R8(this.u[d.who] + R8(d.amt / this.P)); this.pending = []; }
  value(P) { this.move(P); this.joinAll(); }
  settle(P) {
    this.move(P);
    for (const k of INV) {
      if (this.u[k] <= 0) continue;
      const fee = F8(this.rate[k] * Math.max(0, this.N[k]) / this.P); this.u[k] = R8(this.u[k] - fee); this.u.raf = R8(this.u.raf + fee);
    }
    for (const k of INV) { this.N[k] = 0; if (this.next[k] !== null) { this.rate[k] = this.next[k]; this.next[k] = null; } }
    this.joinAll();
  }
  withdraw(who, n) {                                                                               // price unchanged; returns USDT paid
    const u = this.u[who], s = Math.min(1, n / u), fee = F8(this.rate[who] * Math.max(0, this.N[who]) * s / this.P);
    this.N[who] *= 1 - s; this.u[who] = R8(u - n); this.u.raf = R8(this.u.raf + fee); return R6((n - fee) * this.P);
  }
  setRate(who, r) { const pend = this.pending.some((d) => d.who === who); if (r > this.rate[who] && (this.u[who] > 0 || pend)) this.next[who] = r; else { this.rate[who] = r; this.next[who] = null; } }
}

async function compare(w, m, where) {
  const rows = await w.q(`select p.username, coalesce(sum(l.units), 0)::float u, p.fee_rate::float r, p.fee_rate_next::float rn
                            from public.profiles p left join public.ledger l on l.profile_id = p.id group by p.username, p.fee_rate, p.fee_rate_next`);
  for (const r of rows) {
    assert.ok(Math.abs(r.u - m.u[r.username]) < 1e-6, `${where}: ${r.username} units db ${r.u} vs model ${m.u[r.username]}`);
    if (r.username === 'raf') continue;
    const dbN = (await w.periodProfit(r.username)) - (await w.credit(r.username));
    assert.ok(Math.abs(dbN - m.N[r.username]) < 1e-5 + 1e-7 * Math.abs(m.N[r.username]), `${where}: ${r.username} period profit db ${dbN} vs model ${m.N[r.username]}`);
    assert.ok(Math.abs(r.r - m.rate[r.username]) < 1e-9 && Math.abs((r.rn ?? -1) - (m.next[r.username] ?? -1)) < 1e-9, `${where}: ${r.username} rate db ${r.r}/${r.rn} vs model ${m.rate[r.username]}/${m.next[r.username]}`);
  }
  const pend = Number((await w.q("select coalesce(sum(usdt),0) s from public.pending_deposits where status='pending'"))[0].s);
  assert.ok(Math.abs(pend - m.waiting) < 1e-6, `${where}: waiting db ${pend} vs model ${m.waiting}`);
  assert.ok(Math.abs((await w.price()) - m.P) < 1e-9 * Math.max(1, m.P), `${where}: price db ${await w.price()} vs model ${m.P}`);
}

for (const [seed, rate] of [[1, 0.1], [2, 0.1], [3, 0.15], [4, 0.1], [5, 0.2], [6, 0.1], [7, 0.15], [8, 0.1], [9, 0.1], [10, 0.2]]) {
  test(`G randomized sequence seed ${seed} (fee ${rate * 100}%): database = model after every step`, async () => {
    const rand = rng(seed), pick = (a) => a[Math.floor(rand() * a.length)];
    const w = await build({ rate, maxMove: 1000 }), m = new Model(rate);
    await w.join('raf', 200, 200); m.u.raf = 200;
    let undoable = null, prev = null; const log = [];
    for (let step = 0; step < 36; step++) {
      const r = rand(), held = INV.filter((k) => m.u[k] > 1e-4); let op;
      if (r < 0.14) op = 'join'; else if (r < 0.26) op = 'receive'; else if (r < 0.52) op = 'trade'; else if (r < 0.64) op = 'close';
      else if (r < 0.80 && held.length) op = 'withdraw'; else if (r < 0.86) op = 'rate'; else op = undoable ? 'undo' : 'trade';
      const before = m.clone();
      if (op === 'join') {                                                    // money in and valued in one go (the undoable case)
        const who = pick(INV), usdt = Math.round((20 + rand() * 1500) * 100) / 100;
        if (m.pending.length) { op = 'trade'; } else {
          await w.call('admin_receive_deposit', w.A, w.ids[who], usdt, 58, 0, null); m.pending.push({ who, amt: usdt });
          await w.call('admin_post_equity', w.A, m.U * m.P + m.waiting, null, null, null, null, true); m.value(m.P); undoable = 'join'; prev = before; log.push(`join ${who} ${usdt}`);
        }
      }
      if (op === 'receive') {                                                 // money waits across later valuations
        const who = pick(INV), usdt = Math.round((20 + rand() * 900) * 100) / 100;
        await w.call('admin_receive_deposit', w.A, w.ids[who], usdt, 58, 0, null); m.pending.push({ who, amt: usdt }); undoable = null; log.push(`receive ${who} ${usdt}`);
      } else if (op === 'trade') {
        let f = 0.55 + rand() * 0.95; if (m.P * f < 0.05 || m.P * f > 30) f = 1 / f; const P = m.P * f;
        const hadPending = m.pending.length;
        await w.call('admin_post_equity', w.A, m.U * P + m.waiting, null, null, null, null, true); m.value(P);
        undoable = hadPending ? null : 'trade'; prev = before; log.push(`trade x${f.toFixed(3)}${hadPending ? ' (joins waiting)' : ''}`);
      } else if (op === 'close') {
        let f = 0.7 + rand() * 0.7; if (m.P * f < 0.05 || m.P * f > 30) f = 1; const P = m.P * f;
        const feeBefore = m.u.raf;
        const res = await w.call('admin_close_quarter', w.A, m.U * P + m.waiting, null, null, null, null, true); m.settle(P);
        assert.ok(Math.abs(Number(res.fee_units) - (m.u.raf - feeBefore)) < 1e-6 * (1 + m.u.raf), `fee units db ${res.fee_units} vs model ${m.u.raf - feeBefore}`);
        undoable = null; log.push(`close x${f.toFixed(3)}`);
      } else if (op === 'withdraw') {
        const who = pick(held), full = rand() < 0.35, n = full ? m.u[who] : R8(m.u[who] * (0.05 + rand() * 0.9));
        await w.unlockAll();
        const res = await w.call('admin_withdraw', w.A, w.ids[who], n, m.U * m.P + m.waiting, null, null, false, null, null, null, true);
        const pay = m.withdraw(who, n);
        assert.ok(Math.abs(Number(res.pay_usdt) - pay) < 1e-5, `payout db ${res.pay_usdt} vs model ${pay}`);
        undoable = 'withdraw'; prev = before; log.push(`withdraw ${who} ${full ? 'all' : n}`);
      } else if (op === 'rate') {
        const who = pick(INV), r2 = pick([0.05, 0.1, 0.15, 0.2, 0.3]);
        await w.call('admin_set_profile', w.A, w.ids[who], null, null, r2); m.setRate(who, r2); undoable = null; log.push(`rate ${who} ${r2}`);
      } else if (op === 'undo') {
        const res = await w.call('admin_undo_last', w.A, 'undo');
        if (undoable === 'join' && res.back_to_pending) {
          const pid = (await w.q("select id from public.pending_deposits where status = 'pending' order by id desc limit 1"))[0].id;
          await w.call('admin_cancel_pending', w.A, pid);
        }
        m.P = prev.P; m.u = prev.u; m.N = prev.N; m.pending = prev.pending;
        await assert.rejects(() => w.call('admin_undo_last', w.A, 'again'), /itself a correction/);
        undoable = null; log.push('undo');
      }
      const kind = log.at(-1).split(' ')[0]; SEEN[kind] = (SEEN[kind] || 0) + 1;
      if (log.at(-1).startsWith('withdraw') && log.at(-1).endsWith('all')) SEEN['full exit'] = (SEEN['full exit'] || 0) + 1;
      try { await compare(w, m, `seed ${seed} step ${step} (${log.at(-1)})`); } catch (e) { e.message += `\n  sequence: ${log.join(' | ')}`; throw e; }
    }
    const rep = await w.call('admin_integrity_report', w.A);
    const bad = rep.checks.filter((c) => c.count > 0 && !['several_settlements_on_one_day', 'deposit_waiting_over_7_days_not_arrived'].includes(c.id));
    assert.deepEqual(bad.map((c) => c.id), [], 'the integrity report is clean after the whole sequence');
  });
}

test('G coverage: the random sequences exercised every kind of step', () => {
  for (const k of ['join', 'receive', 'trade', 'close', 'withdraw', 'full exit', 'rate', 'undo']) assert.ok((SEEN[k] || 0) >= 3, `${k} ran ${SEEN[k] || 0} times: ${JSON.stringify(SEEN)}`);
  console.log('steps run:', JSON.stringify(SEEN));
});

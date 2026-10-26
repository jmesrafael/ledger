// Monthly statements, month-by-month returns, drawdown and the pesos fix (js/returns.js), checked against the real database
// functions over a story that runs several months and includes a top-up, a withdrawal, a quarter close and an entry that
// falls right on a month boundary in Philippine time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const R = createRequire(import.meta.url)('../js/returns.js');
const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const FILES = [...readdirSync(appl).map((f) => new URL(f, appl)), ...readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => new URL(f, dir))]
  .sort((a, b) => a.pathname.split('/').pop().localeCompare(b.pathname.split('/').pop()));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(Number(a) - b) < eps, `${a} != ${b}`);

async function story() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects(bucket_id text, name text); alter table storage.objects enable row level security; grant usage on schema public to anon, authenticated;`);
  for (const f of FILES) await db.exec(readFileSync(f, 'utf8'));
  // these tests are not about Exchange arrival or the settlement rules (tests/hwm-settlement.test.mjs): every deposit is treated as already in the exchange,
  // and a close may happen any time without a reconciliation
  await db.exec(`update public.ledger_settings set value = 'free' where key = 'settlement_schedule'; update public.ledger_settings set value = 'off' where key = 'settlement_recon';`);
  await db.exec(`create function public._test_in_mexc() returns trigger language plpgsql as $t$ begin new.arrived_at := coalesce(new.arrived_at, now()); return new; end $t$;
                 create trigger test_in_mexc before insert on public.pending_deposits for each row execute function public._test_in_mexc();`);
  await db.exec(`update public.ledger_settings set value = '0' where key in ('min_days_between_closes', 'lock_months'); update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  await db.query(`select public.create_first_admin('raf', 'Raf', 'admin-password-1')`);
  const call = async (fn, ...a) => { await db.exec('set role anon'); try { return (await db.query(`select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); } };
  const A = (await call('login', 'raf', 'admin-password-1')).token;
  const ids = { raf: (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id };
  ids.john = await call('admin_create_user', A, 'john', 'John', 'john-password', 0.1);
  const total = async (f = 1) => { const p = await call('pool_summary', A), w = (await call('admin_pending', A)).reduce((t, d) => t + Number(d.usdt), 0); return Number(p.total_units) * Number(p.unit_price) * f + w; };
  const read = async (at, f) => call('admin_post_equity', A, await total(f), 58, 'r', at);
  const put = async (at, who, usdt, php) => { await call('admin_receive_deposit', A, who, usdt, 58, php, null, at); await read(at.replace(/:00Z$/, ':05Z'), 1); };
  await put('2025-01-10T02:00:00Z', ids.raf, 100, 5800);
  await read('2025-01-20T10:00:00Z', 1.10);
  await put('2025-02-03T02:00:00Z', ids.john, 50, 2900);
  await read('2025-02-15T10:00:00Z', 0.95);
  await read('2025-02-28T16:30:00Z', 1.04);                       // = 1 Mar 00:30 in the Philippines: belongs to March
  await put('2025-03-12T02:00:00Z', ids.raf, 20, 1160);            // the manager tops up
  await call('admin_close_quarter', A, await total(1.03), 58, 'close', '2025-03-31T15:59:00Z');   // 31 Mar 23:59 PH
  const j = (await call('admin_overview', A)).find((h) => h.id === ids.john);
  await call('admin_withdraw', A, ids.john, Number(j.units) * 0.3, await total(1), 57, 'w', false, null, '2025-04-20T10:00:00Z');
  await read('2025-05-10T10:00:00Z', 0.90);
  await read('2025-06-15T10:00:00Z', 1.20);
  await read('2025-07-02T10:00:00Z', 1.00);
  const data = async (id) => ({
    H: (await db.query(`select public._history($1) as r`, [id])).rows[0].r,
    L: (await db.query(`select ts, kind, usdt::float8 usdt, units::float8 units, php_amount::float8 php_amount, php_rate::float8 php_rate from public.ledger where profile_id = $1 order by id`, [id])).rows,
    S: (await db.query(`select public._holder_summary($1) as r`, [id])).rows[0].r,
  });
  return { db, call, A, ids, data };
}
const NOW = Date.parse('2025-07-20T00:00:00Z');

test('every month balances exactly and chains: opening + money in - money out + trading + profit share = closing', async () => {
  const { ids, data } = await story();
  for (const who of ['raf', 'john']) {
    const { H, L, S } = await data(ids[who]), rows = R.monthly(H, L, NOW);
    assert.ok(rows.length >= 5, who + ' has too few months');
    near(rows[0].opening, 0);
    rows.forEach((m, i) => {
      near(m.opening + m.deposits - m.withdrawals + m.trading + m.profitShare, m.closing, 1e-9);        // the statement adds up
      if (i > 0) { near(m.opening, rows[i - 1].closing, 1e-9); assert.equal(m.from, rows[i - 1].to); }  // each month starts where the last ended
    });
    near(rows[rows.length - 1].closing, Number(S.value_usdt), 1e-9);                                      // and ends at what the app shows today
    // month returns chain to the all-time return
    const pts = H.map((p) => ({ v: Number(p.value), n: Number(p.net_in), u: Number(p.units), price: Number(p.price) }));
    near(rows.reduce((g, m) => g * (1 + m.tradingPct), 1) - 1, R.total(R.tradingGrowth(pts)), 1e-9);
    near(rows.reduce((g, m) => g * (1 + m.yourPct), 1) - 1, R.total(R.yourGrowth(pts)), 1e-9);
    // money flows add up to the totals in the person's summary
    near(rows.reduce((t, m) => t + m.deposits, 0), Number(S.deposited_usdt), 1e-9);
    near(rows.reduce((t, m) => t + m.withdrawals, 0), Number(S.withdrawn_usdt), 1e-9);
  }
});

test('trading result per month = units held before each price move x the move (worked out separately from the history)', async () => {
  const { ids, data } = await story();
  for (const who of ['raf', 'john']) {
    const { H, L } = await data(ids[who]), rows = R.monthly(H, L, NOW), pts = H.map((p) => ({ t: Date.parse(p.ts), u: Number(p.units), price: Number(p.price) }));
    for (const m of rows) {
      let want = 0;
      for (let i = 1; i < pts.length; i++) if (pts[i].t >= m.from && pts[i].t < m.to) want += pts[i - 1].u * (pts[i].price - pts[i - 1].price);
      near(m.trading, want, 1e-6);   // units are stored to 8 decimals, so the two routes can differ by a billionth of a dollar
    }
  }
});

test('months are Philippine months: an entry at 00:30 on 1 March (PH) is a March entry, and the quarter close lands in March', async () => {
  const { ids, data } = await story();
  assert.equal(R.monthKey(Date.parse('2025-02-28T16:30:00Z')), '2025-03');
  assert.equal(R.monthKey(Date.parse('2025-03-31T15:59:00Z')), '2025-03');
  assert.equal(R.monthKey(Date.parse('2025-03-31T16:00:00Z')), '2025-04');
  const { H, L } = await data(ids.raf), rows = R.monthly(H, L, NOW), by = Object.fromEntries(rows.map((m) => [m.key, m]));
  assert.deepEqual(rows.map((m) => m.key), ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07']);
  const feb15 = H.find((p) => p.ts.startsWith('2025-02-15')); near(by['2025-02'].closing, Number(feb15.value), 1e-9);   // February ends at the 15 Feb reading
  assert.ok(by['2025-03'].trading > 0 && by['2025-03'].deposits > 0);                                                  // March: the +4% reading and the top-up
  near(by['2025-03'].deposits, 20, 1e-9);
  assert.ok(by['2025-03'].profitShare > 0);                                                                           // the manager received the quarter's profit share
  assert.equal(by['2025-07'].partial, true); assert.equal(by['2025-06'].partial, false);                               // the current month is "to date"
});

test('profit share: the investor pays it in the month it is charged; the manager receives the same amount', async () => {
  const { ids, data } = await story();
  const r = R.monthly((await data(ids.raf)).H, (await data(ids.raf)).L, NOW), j = R.monthly((await data(ids.john)).H, (await data(ids.john)).L, NOW);
  const rm = Object.fromEntries(r.map((m) => [m.key, m])), jm = Object.fromEntries(j.map((m) => [m.key, m]));
  assert.ok(jm['2025-03'].profitShare < 0);
  near(rm['2025-03'].profitShare, -jm['2025-03'].profitShare, 1e-9);      // John is the only investor
  near(jm['2025-03'].yourPct, jm['2025-03'].tradingPct, 1) ;               // sanity: both are fractions
  assert.ok(jm['2025-03'].yourPct < jm['2025-03'].tradingPct);             // after the cut he has less than the trading made
  assert.equal(jm['2025-01'], undefined);                                  // nothing before he joined
  near(jm['2025-02'].opening, 0);
});

test('pesos: "put in" is what was actually paid, and the exchange-rate part of the peso gain is separated', async () => {
  const { ids, data } = await story();
  const rateNow = 63;
  for (const who of ['raf', 'john']) {
    const { L, S } = await data(ids[who]), p = R.pesos(L, rateNow);
    const wantIn = who === 'raf' ? 5800 + 1160 : 2900;
    near(p.inPhp, wantIn);                                                                    // exactly the pesos handed over
    assert.ok(Math.abs(p.net - Number(S.net_in_usdt) * rateNow) > 1, 'would have shown the converted figure');
    // peso gain = trading gain at today's rate + the exchange rate part
    const pesoGain = Number(S.value_usdt) * rateNow + p.outPhp - p.inPhp, usdtGain = (Number(S.value_usdt) + Number(S.withdrawn_usdt) - Number(S.deposited_usdt)) * rateNow;
    near(pesoGain, usdtGain + p.fx, 1e-6);
  }
  const j = R.pesos((await data(ids.john)).L, rateNow);
  assert.ok(j.outPhp > 0 && Math.abs(j.net - (2900 - j.outPhp)) < 1e-9);                      // the withdrawal is counted at the rate it was paid
  // an old entry without a peso amount falls back to usdt x its rate, and with no rate at all to today's
  near(R.pesos([{ kind: 'deposit', usdt: 10, php_amount: null, php_rate: 50 }], 60).inPhp, 500);
  near(R.pesos([{ kind: 'deposit', usdt: 10 }], 60).inPhp, 600);
});

test('worst drop from peak, and CSV output', async () => {
  const { ids, data } = await story();
  const { H } = await data(ids.raf), pts = H.map((p) => ({ v: Number(p.value), n: Number(p.net_in), t: Date.parse(p.ts) }));
  const g = R.yourGrowth(pts), dd = R.drawdown(g, pts.map((p) => p.t));
  assert.ok(dd.worst < 0 && dd.worst > -1);
  const lo = g.indexOf(Math.min(...g.slice(g.findIndex((_, i) => pts[i].t >= dd.peakAt))));
  assert.ok(dd.troughAt >= dd.peakAt);
  assert.ok(dd.current <= 0 && dd.current >= dd.worst - 1e-12 || dd.current > dd.worst);   // now is never below the worst point ever seen
  const csv = R.toCsv([['Month', (m) => m.key], ['Note', (m) => m.note]], [{ key: '2025-01', note: 'a, "b"' }, { key: '2025-02', note: null }]);
  assert.equal(csv, 'Month,Note\r\n2025-01,"a, ""b"""\r\n2025-02,\r\n');
  void lo;
});

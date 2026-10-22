// Replays a period of trades through the REAL ledger functions (in-memory Postgres) and cross-checks every number
// against an independent plain-JS implementation of the same rules. Optionally writes a seed SQL file for the live app.
//
//   node scripts/simulate.mjs <trades.json> [--rate 58] [--risk 0.01] [--start 2020-03-01] [--joiner 2023-07-01] [--seed supabase/seed-test-data.sql]
//   (start defaults to the month of the first trade; the third person joins at the quarter nearest the middle of the period)
//
// trades.json: [{ exit: ISO time, R: result in risk units }, ...]  (sorted or not)
// Pool model: each trade risks `risk` x current pool equity, so the pool compounds. Deposits are in pesos at `rate`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
// a migration stays in supabase/migrations/ until it has been run on the live database, then moves to supabase/migrations/applied/
const mig = (f) => { const a = new URL('../supabase/migrations/applied/' + f, import.meta.url); return existsSync(a) ? a : new URL('../supabase/migrations/' + f, import.meta.url); };
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const RATE = Number(opt('rate', 58)), RISK = Number(opt('risk', 0.01)), SEED = opt('seed', null), FEE = 0.2;
const trades = JSON.parse(readFileSync(args[0], 'utf8')).map((t) => ({ ...t, x: new Date(t.exit) })).sort((a, b) => a.x - b.x);

// ---------------------------------------------------------------- the scenario
const PEOPLE = [
  { u: 'raf', name: 'Raf (manager)', admin: true },
  { u: 'john', name: 'John (test)', pass: 'john-test-123' },
  { u: 'dino', name: 'Dino (test)', pass: 'dino-test-123' },
];
const LAST = trades[trades.length - 1].x;
const START = opt('start', trades[0].x.toISOString().slice(0, 7) + '-01');
const qStart = (d) => `${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
const JOINER = opt('joiner', qStart(new Date((new Date(START).getTime() + LAST.getTime()) / 2)));
const DEPOSITS = [[START, 'raf', 5000], [START, 'john', 3000], [JOINER, 'dino', 3000]];   // pesos
const CLOSES = [];   // every quarter end inside the period
for (let y = Number(START.slice(0, 4)); y <= LAST.getUTCFullYear(); y++)
  for (const md of ['03-31', '06-30', '09-30', '12-31']) { const d = `${y}-${md}`; if (d > START && new Date(d + 'T23:59:00+08:00') < LAST) CLOSES.push(d); }

// Build the event list: weekly equity readings (Sundays), deposits, quarter closes, final reading.
const D = (s) => new Date(s + 'T23:59:00+08:00');   // end of the day in the Philippines
const marks = [];
const firstSunday = new Date(START + 'T23:59:59Z'); firstSunday.setUTCDate(firstSunday.getUTCDate() + ((7 - firstSunday.getUTCDay()) % 7 || 7));
for (let d = firstSunday; d <= LAST; d = new Date(d.getTime() + 7 * 864e5)) marks.push({ at: d, kind: 'update' });
for (const [day, who, php] of DEPOSITS) marks.push({ at: new Date(day + 'T00:00:00Z'), kind: 'deposit', who, php });
for (const day of CLOSES) marks.push({ at: D(day), kind: 'close' });
marks.push({ at: new Date(trades[trades.length - 1].x.getTime() + 1000), kind: 'update', note: 'last trade' });
marks.sort((a, b) => a.at - b.at || (a.kind === 'deposit' ? -1 : 1));

let equity = 0, ti = 0;
const events = [];
for (const m of marks) {
  while (ti < trades.length && trades[ti].x <= m.at) { equity += equity * RISK * trades[ti].R; ti++; }
  if (m.kind === 'deposit') { const usd = m.php / RATE; events.push({ ...m, usd, before: equity }); equity += usd; }
  else if (equity > 0) events.push({ ...m, equity });
}

// ---------------------------------------------------------------- independent model (plain JS, same rules)
function model() {
  const h = Object.fromEntries(PEOPLE.map((p) => [p.u, { units: 0, hwm: null, fees: 0 }]));
  let U = 0, price = 1; const fees = [];
  for (const e of events) {
    if (e.kind === 'deposit') {
      price = U === 0 ? 1 : e.before / U; const n = e.usd / price, p = h[e.who];
      p.hwm = p.units > 0 ? (p.units * p.hwm + n * price) / (p.units + n) : price; p.units += n; U += n;
    } else {
      price = e.equity / U;
      if (e.kind === 'close') {
        let q = 0;
        for (const p of PEOPLE.filter((x) => !x.admin)) {
          const s = h[p.u]; if (s.units <= 0) continue;
          const fee = FEE * Math.max(0, price - s.hwm) / price * s.units;
          s.units -= fee; h.raf.units += fee; h.raf.fees += fee; q += fee; s.hwm = Math.max(s.hwm, price);
        }
        fees.push({ at: e.at, units: q, usd: q * price });
      }
    }
  }
  return { h, price, U, fees };
}

// ---------------------------------------------------------------- run through the real database
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`create role anon; create role authenticated; create schema extensions; grant usage on schema public to anon, authenticated;`);
await db.exec(readFileSync(mig('20261022000000_ledger.sql'), 'utf8'));
await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
await db.query(`select public.create_first_admin('raf', 'Raf (manager)', 'manager-pass-1')`);
const call = async (fn, ...a) => { await db.exec('set role anon'); try { return (await db.query(`select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); } };
const T = (await call('login', 'raf', 'manager-pass-1')).token;
const id = { raf: (await db.query(`select id from public.profiles where username = 'raf'`)).rows[0].id };
for (const p of PEOPLE.filter((x) => !x.admin)) id[p.u] = await call('admin_create_user', T, p.u, p.name, p.pass, FEE);

const ymd = (d) => d.toISOString().slice(0, 10);
const sql = [];
const S = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pid = (u) => (u === 'raf' ? `(select id from public.profiles where role = 'admin')` : `(select id from public.profiles where username = ${S(u)})`);
const dbFees = [];
for (const e of events) {
  const note = `TEST sim ${ymd(e.at)}${e.note ? ' ' + e.note : ''}`;
  if (e.kind === 'deposit') {
    const first = (await call('pool_summary', T)).total_units == 0;
    await call('admin_deposit', T, id[e.who], e.usd, first ? null : e.before, RATE, e.php, note, e.at.toISOString());
    sql.push(`select public.admin_deposit(:tok, ${pid(e.who)}, ${e.usd.toFixed(8)}, ${first ? 'null' : e.before.toFixed(8)}, ${RATE}, ${e.php}, ${S(note)}, ${S(e.at.toISOString())});`);
  } else if (e.kind === 'close') {
    const r = await call('admin_close_quarter', T, e.equity, RATE, note + ' quarter close', e.at.toISOString());
    dbFees.push({ at: e.at, units: Number(r.fee_units), price: Number(r.unit_price) });
    sql.push(`select public.admin_close_quarter(:tok, ${e.equity.toFixed(8)}, ${RATE}, ${S(note + ' quarter close')}, ${S(e.at.toISOString())});`);
  } else {
    await call('admin_post_equity', T, e.equity, RATE, note, e.at.toISOString());
    sql.push(`select public.admin_post_equity(:tok, ${e.equity.toFixed(8)}, ${RATE}, ${S(note)}, ${S(e.at.toISOString())});`);
  }
}

// ---------------------------------------------------------------- compare & report
const M = model(), all = await call('admin_overview', T), pool = await call('pool_summary', T);
const by = Object.fromEntries(all.map((h) => [h.username, h]));
let worst = 0;
for (const p of PEOPLE) worst = Math.max(worst, Math.abs(Number(by[p.u].units) - M.h[p.u].units));
worst = Math.max(worst, Math.abs(Number(pool.unit_price) - M.price), ...dbFees.map((f, i) => Math.abs(f.units - M.fees[i].units)));
const sumVal = all.reduce((s, h) => s + Number(h.value_usdt), 0);

const php = (u) => '₱' + Math.round(u * RATE).toLocaleString('en-PH');
const pc = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
console.log(`\nReplay ${START} → ${LAST.toISOString().slice(0, 10)}: ${trades.length} trades, joiner on ${JOINER}, risk ${RISK * 100}% of pool per trade, peso rate ${RATE}, fee ${FEE * 100}% over high-water mark, quarterly`);
console.log(`Pool unit price: 1.0000 → ${Number(pool.unit_price).toFixed(4)} (${pc(pool.unit_price - 1)} gross, before fees)`);
console.log(`Pool equity: ${Number(pool.equity_usdt).toFixed(2)} USDT (${php(pool.equity_usdt)}); sum of everyone's value: ${sumVal.toFixed(6)} USDT`);
console.log('\nQuarter closes (fees charged, in units moved to the manager):');
if (dbFees.length <= 8) for (const [i, f] of dbFees.entries()) console.log(`  ${ymd(f.at)}  price ${f.price.toFixed(4)}  fee ${f.units.toFixed(6)} units = ${(f.units * f.price).toFixed(2)} USDT (${php(f.units * f.price)})`);
console.log('\nPerson            put in        now worth       profit     return   units      fee units earned');
for (const p of PEOPLE) {
  const h = by[p.u];
  console.log(`  ${p.name.padEnd(15)} ${php(h.deposited_usdt).padStart(8)}  ${(Number(h.value_usdt).toFixed(2) + ' USDT').padStart(12)} ${php(h.value_usdt).padStart(8)}  ${php(h.profit_usdt).padStart(7)}  ${pc(h.return_pct).padStart(7)}  ${Number(h.units).toFixed(4).padStart(9)}  ${Number(h.fee_units_earned).toFixed(4)}`);
}
console.log(`\nCross-check vs independent model: largest difference ${worst.toExponential(2)} (units/price)  → ${worst < 1e-6 ? 'MATCH' : 'MISMATCH'}`);
console.log(`Sum of values vs pool equity: diff ${Math.abs(sumVal - Number(pool.equity_usdt)).toExponential(2)} USDT → ${Math.abs(sumVal - Number(pool.equity_usdt)) < 1e-4 ? 'MATCH' : 'MISMATCH'}`);
if (worst >= 1e-6) process.exitCode = 1;

if (SEED) {
  const tok = randomBytes(24).toString('hex');
  const head = [
    `-- TEST DATA generated by scripts/simulate.mjs: replays backtest trades ${START} → ${LAST.toISOString().slice(0, 10)} (${trades.length} trades, risk ${RISK * 100}% of pool per trade) so every screen has numbers.`,
    '-- Backtest = hypothetical. The coins were picked after seeing results; real trading will very likely do worse.',
    '-- Needs: the migration + your manager account (create-admin.sql). Run supabase/reset-ledger-data.sql first if there are entries.',
    '-- Creates test logins  john / john-test-123  and  dino / dino-test-123.  Wipe it all with reset-ledger-data.sql before real money.',
    '-- Entries carry the simulated dates, so charts and lock-ups look real. If no manager exists yet it creates  raf / admin-test-123  (change it in the app!).',
    'begin;',
    "select public.create_first_admin('raf', 'Admin', 'admin-test-123') where not exists (select 1 from public.profiles where role = 'admin');",
    `insert into public.sessions(token_hash, profile_id, expires_at) select encode(extensions.digest(${S(tok)}, 'sha256'), 'hex'), id, now() + interval '1 hour' from public.profiles where role = 'admin';`,
    ...PEOPLE.filter((p) => !p.admin).map((p) => `select public.admin_create_user(:tok, ${S(p.u)}, ${S(p.name)}, ${S(p.pass)}, ${FEE}) where not exists (select 1 from public.profiles where username = ${S(p.u)});`),
  ];
  const tail = [`delete from public.sessions where token_hash = encode(extensions.digest(${S(tok)}, 'sha256'), 'hex');`, 'commit;'];
  writeFileSync(SEED, [...head, ...sql, ...tail].join('\n').replaceAll(':tok', S(tok)) + '\n');
  console.log(`\nWrote ${SEED} (${sql.length} entries).`);
}

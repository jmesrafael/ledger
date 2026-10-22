// Builds a full ledger history from backtest trades: simulates the exchange account (risk = a % of the balance on every
// trade, compounding, deposits added on the day they are made), turns it into the entries a manager would have made
// (money received, weekly equity readings with open trades valued, quarter closes), replays them through the REAL ledger
// functions on an in-memory Postgres to check every number, and writes one SQL file that creates any missing accounts,
// clears the books and loads the history.
//
//   node scripts/seed-from-backtest.mjs <trades.json> <fx.json> --manager-pass <password> [--manager-user raf] [--manager-name Raf]
//        [--risk 0.05] [--note "Backtest simulation"] [--out supabase/reset-and-seed-backtest.sql]
//
// trades.json: from 🔴BB-Core/export-trades.js. fx.json: Frankfurter USD→PHP series, e.g.
//   https://api.frankfurter.dev/v1/2025-01-01..2026-10-22?base=USD&symbols=PHP
// The output file holds passwords: it is gitignored. Investors get random temporary passwords (printed in the file).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const RISK = Number(opt('risk', 0.05)), NOTE = opt('note', 'Backtest simulation'), FEE_SIM = 0.10;   // FEE_SIM = the app's default rate
const OUT = opt('out', 'supabase/reset-and-seed-backtest.sql');
const BT = JSON.parse(readFileSync(args[0], 'utf8')), FX = JSON.parse(readFileSync(args[1], 'utf8')).rates;
const Returns = createRequire(import.meta.url)('../js/returns.js');
const COINS = Object.keys(BT.closes);   // e.g. MEXC_SOL, MEXC_ZEC
const MARKET = COINS.every((c) => c.startsWith('MEXC_'))
  ? `${COINS.map((c) => c.slice(5)).join(' + ')} on MEXC USDT-M perpetuals (MEXC prices; MEXC funding from Apr 2025, Binance funding before that)`
  : `${COINS.join(' + ')} (Binance USDT-M prices)`;

// ---------------------------------------------------------------- the story (Philippine time, UTC+8)
const pw = () => randomBytes(9).toString('base64url');   // 12 characters, temporary
const INV_PASS = (opt('inv-pass', '') || '').split(',').filter(Boolean);   // --inv-pass a,b,c keeps the investors' passwords the same as an earlier run
const MANAGER_PASS = opt('manager-pass', null);
if (!MANAGER_PASS || MANAGER_PASS.length < 8) { console.error('give --manager-pass (at least 8 characters)'); process.exit(1); }
const PEOPLE = [   // slot = how the SQL file refers to the person
  { slot: 'manager', user: opt('manager-user', 'raf'), name: opt('manager-name', 'Raf'), pass: MANAGER_PASS, admin: true },
  { slot: 'joined_2025_03_03', user: 'investor1', name: 'Investor 1', pass: INV_PASS[0] || pw(), php: 5000, when: '3 Mar 2025' },
  { slot: 'joined_2025_12_25', user: 'investor2', name: 'Investor 2', pass: INV_PASS[1] || pw(), php: 5000, when: '25 Dec 2025' },
  { slot: 'joined_2026_02_21', user: 'investor3', name: 'Investor 3', pass: INV_PASS[2] || pw(), php: 3000, when: '21 Feb 2026' },
];
const PH = (s) => new Date(s + '+08:00');
const DEPOSITS = [   // [when (PH), who, pesos]
  ['2025-01-10T10:00', 'manager', 5000],
  ['2025-03-03T10:00', 'joined_2025_03_03', 5000],
  ['2025-12-25T10:00', 'joined_2025_12_25', 5000],
  ['2026-02-21T10:00', 'joined_2026_02_21', 3000],
];
const fxDays = Object.keys(FX).sort();
const phpRate = (d) => { const day = new Date(d.getTime() + 8 * 36e5).toISOString().slice(0, 10); let r = null; for (const k of fxDays) { if (k > day) break; r = FX[k].PHP; } return r; };   // last published rate on or before that day

// ---------------------------------------------------------------- the exchange account
const lastClose = Math.max(...Object.values(BT.closes).map((c) => c[c.length - 1][0]));
const END = new Date(lastClose * 1000 + 5 * 60e3);            // final reading 5 minutes after the last 4h close in the data
const START = PH(DEPOSITS[0][0]);
const priceAt = (coin, sec) => { const c = BT.closes[coin]; let lo = 0, hi = c.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m][0] <= sec) { r = c[m][1]; lo = m + 1; } else hi = m - 1; } return r; };

const marks = [];   // what the manager records
for (const [at, who, php] of DEPOSITS) { const t = PH(at), rate = phpRate(t); marks.push({ at: t, kind: 'deposit', who, php, rate, usdt: php / rate }, { at: new Date(t.getTime() + 5 * 60e3), kind: 'update' }); }
for (let d = new Date(START); d <= END; d = new Date(d.getTime() + 864e5)) {
  const ph = new Date(d.getTime() + 8 * 36e5), day = ph.toISOString().slice(0, 10), md = day.slice(5);
  const at = PH(day + 'T23:59');
  if (at <= START || at > END) continue;
  if (['03-31', '06-30', '09-30', '12-31'].includes(md)) marks.push({ at, kind: 'close' });
  else if (ph.getUTCDay() === 0) marks.push({ at, kind: 'update' });                       // every Sunday night
}
marks.push({ at: END, kind: 'update', last: true });
marks.sort((a, b) => a.at - b.at);

// walk trades and marks in time order: entries risk RISK x the realised balance; exits add R x that risk; deposits add cash
const ev = [];
for (const t of BT.trades) { ev.push({ s: t.t, o: 1, t }); ev.push({ s: t.tExit, o: 0, t }); }
for (const m of marks) ev.push({ s: m.at.getTime() / 1000, o: m.kind === 'deposit' ? 2 : 3, m });
ev.sort((a, b) => a.s - b.s || a.o - b.o);   // same moment: exits, then entries, then deposits, then readings
let bal = 0, maxRisk = 0, trades = 0;
const open = new Map();
for (const e of ev) {
  if (e.o === 0) { const r = open.get(e.t); if (r != null) { bal += e.t.R * r; open.delete(e.t); trades++; } }
  else if (e.o === 1) { if (bal > 0) { const r = RISK * bal; open.set(e.t, r); maxRisk = Math.max(maxRisk, r); } }
  else if (e.o === 2) bal += e.m.usdt;
  else {
    let unreal = 0;
    for (const [t, r] of open) { const px = priceAt(t.coin, e.s); if (px != null) unreal += (t.dir * (px - t.entry) / Math.abs(t.entry - t.stop)) * r; }
    e.m.equity = bal + unreal; e.m.rate = phpRate(e.m.at); e.m.open = open.size;
  }
}

// ---------------------------------------------------------------- the SQL file
const iso = (d) => d.toISOString();
const S = (s) => `'${String(s).replace(/'/g, "''")}'`;
const n8 = (v) => Number(v).toFixed(8);
const pidSql = (slot) => `(select p.id from public.profiles p join seed_who w on p.username = lower(trim(w.username)) where w.slot = ${S(slot)})`;
const lines = [];
for (const m of marks) {
  if (m.kind === 'deposit') lines.push(`select public.admin_receive_deposit(:tok, ${pidSql(m.who)}, ${n8(m.usdt)}, ${m.rate}, ${m.php}, ${S(NOTE)}, ${S(iso(m.at))});`);
  else if (m.kind === 'close') lines.push(`select public.admin_close_quarter(:tok, ${n8(m.equity)}, ${m.rate}, ${S(NOTE + ' · quarter close')}, ${S(iso(m.at))});`);
  else lines.push(`select public.admin_post_equity(:tok, ${n8(m.equity)}, ${m.rate}, ${S(NOTE + (m.open ? ` · ${m.open} open trade${m.open > 1 ? 's' : ''} valued` : ''))}, ${S(iso(m.at))});`);
}
const tok = randomBytes(24).toString('hex');
const pad = (s, n) => (s + ',').padEnd(n);
const sql = `-- ACCOUNTS + RESET + LOAD: makes sure the 4 accounts below exist, clears every money entry in the ledger, and loads a
-- simulated history from the backtest.
--   * Accounts that do not exist yet are created with the username, name and password below. Accounts that already exist
--     are kept as they are (their password is NOT changed).
--   * Keeps all accounts, logins, profit-share rates and terms agreements. Deletes deposits, withdrawals, profit shares,
--     equity readings, withdrawal requests and money waiting to join. Cannot be undone.
--   * THIS FILE CONTAINS PASSWORDS: it is gitignored. Do not share it. Everyone can change their password in the app
--     (Home → Change password) and the manager can reset anyone's (Users → Edit / reset password).
--
-- What it loads (built by scripts/seed-from-backtest.mjs from the bot's backtest on ${MARKET}, with real fees and funding,
-- ${RISK * 100}% of the balance risked per trade, compounding):
${DEPOSITS.map(([at, who, php]) => { const p = PEOPLE.find((x) => x.slot === who); return `--   ${at.slice(0, 10)}  ${p.user.padEnd(10)} ₱${php.toLocaleString('en-PH')} at ₱${phpRate(PH(at))}/USDT`; }).join('\n')}
--   weekly equity readings every Sunday 23:59 (open trades valued at that moment), quarter closes on each quarter end,
--   last reading ${iso(END).slice(0, 16).replace('T', ' ')} UTC. ${marks.length} entries in all. Profit share uses each person's own rate (new accounts: the default 10%).
-- A backtest is hypothetical: the coins were picked after seeing results, and real trading will very likely do worse.
-- Every entry carries the note ${S(NOTE)} so it is clear on every screen that it is simulated.
--
-- HOW TO RUN: (optional) change the usernames / names / passwords below, then paste the whole file into the Supabase SQL
-- Editor and Run. Supabase warns about a table without Row Level Security: that is seed_who, a temporary table that exists
-- only during this run and is dropped at the end, so choose "run without RLS". It stops before touching anything if the
-- manager username does not match an existing manager, or a username belongs to the wrong kind of account.
begin;

create temp table seed_who (slot text primary key, username text not null, name text not null, password text not null) on commit drop;
insert into seed_who values
${PEOPLE.map((p, i) => `  (${pad(S(p.slot), 21)}${pad(S(p.user), 12)}${pad(S(p.name), 13)}${S(p.pass)})${i < PEOPLE.length - 1 ? ',' : ';'}   -- ${p.admin ? 'manager (you)' : `put in ₱${p.php.toLocaleString('en-PH')} on ${p.when}`}`).join('\n')}

do $$
declare n_admin int := (select count(*) from public.profiles where role = 'admin');
begin
  if exists (select 1 from seed_who where lower(trim(username)) !~ '^[a-z0-9_.-]{3,30}$') then raise exception 'usernames: 3-30 characters, letters/numbers/._- only; nothing was changed'; end if;
  if exists (select 1 from seed_who where length(password) < 8) then raise exception 'passwords must be at least 8 characters; nothing was changed'; end if;
  if (select count(distinct lower(trim(username))) from seed_who) <> 4 then raise exception 'the four usernames must all be different; nothing was changed'; end if;
  if n_admin > 1 then raise exception 'there is more than one manager account; nothing was changed'; end if;
  if n_admin = 1 and not exists (select 1 from public.profiles p join seed_who w on p.username = lower(trim(w.username)) where w.slot = 'manager' and p.role = 'admin')
    then raise exception 'the manager account here is %, not the manager username in this file; change it to match; nothing was changed',
      (select username from public.profiles where role = 'admin'); end if;
  if exists (select 1 from public.profiles p join seed_who w on p.username = lower(trim(w.username)) where w.slot <> 'manager' and p.role <> 'investor')
    then raise exception 'one of the investor usernames belongs to the manager account; nothing was changed'; end if;
end $$;

-- 1. the manager account (only if there is none yet)
select public.create_first_admin(username, name, password) from seed_who
 where slot = 'manager' and not exists (select 1 from public.profiles where role = 'admin');

-- 2. a one-off manager session for this script (removed at the end)
insert into public.sessions(token_hash, profile_id, expires_at)
select encode(extensions.digest(:tok, 'sha256'), 'hex'), id, now() + interval '1 hour' from public.profiles where role = 'admin';

-- 3. investor accounts that do not exist yet (default profit share), and make sure all three can sign in
select public.admin_create_user(:tok, w.username, w.name, w.password, null) from seed_who w
 where w.slot <> 'manager' and not exists (select 1 from public.profiles p where p.username = lower(trim(w.username)));
update public.profiles p set active = true from seed_who w where p.username = lower(trim(w.username)) and not p.active;

-- 4. clear the books (accounts, logins and terms agreements stay), including the integrity tables when that migration has been run
do $$
declare t text; l text := '';
begin
  foreach t in array array['lot_log', 'holder_lots', 'period_log', 'investor_period', 'corrections', 'idempotency_keys', 'transfer_matches',
                           'snapshot_attestations', 'exchange_transfers', 'exchange_snapshots', 'pending_deposits', 'withdrawal_requests',
                           'holder_state', 'ledger', 'pool_equity'] loop
    if to_regclass('public.' || t) is not null then l := l || case when l = '' then '' else ', ' end || 'public.' || t; end if;
  end loop;
  execute 'truncate table ' || l || ' restart identity';
end $$;

-- 5. the history, oldest first
${lines.join('\n')}

-- 6. done: the activity log starts empty, so simulated setup never looks like real activity
do $$ begin if to_regclass('public.audit_log') is not null then truncate table public.audit_log restart identity; end if; end $$;
delete from public.sessions where token_hash = encode(extensions.digest(:tok, 'sha256'), 'hex');
commit;
`.replaceAll(':tok', S(tok));

// ---------------------------------------------------------------- checks on in-memory copies of the real database
const dir = new URL('../supabase/migrations/', import.meta.url), appl = new URL('applied/', dir);
const files = [...readdirSync(appl).map((f) => new URL(f, appl)), ...(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => new URL(f, dir)) : [])]
  .sort((a, b) => a.pathname.split('/').pop().localeCompare(b.pathname.split('/').pop()));
async function freshDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create schema extensions; grant usage on schema public to anon, authenticated;`);
  for (const f of files) await db.exec(readFileSync(f, 'utf8'));
  await db.exec(`update public.ledger_settings set value = '4' where key = 'bcrypt_cost'`);
  return db;
}
const callAs = (db) => async (fn, ...a) => { await db.exec('set role anon'); try { return (await db.query(`select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(',')}) as r`, a)).rows[0].r; } finally { await db.exec('reset role'); } };
const login = async (db, u, p) => { const r = await callAs(db)('login', u, p); if (!r.ok) throw new Error(`login ${u}: ${r.error}`); return r.token; };

async function summarize(db, label, T, slotOf) {
  const call = callAs(db), pool = await call('pool_summary', T), all = await call('admin_overview', T);
  const rate = phpRate(END), php = (u) => '₱' + Math.round(Number(u) * rate).toLocaleString('en-PH'), pc = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  console.log(`\n${label}: pool ${Number(pool.equity_usdt).toFixed(2)} USDT = ${php(pool.equity_usdt)} at ₱${rate}; unit price 1.0000 → ${Number(pool.unit_price).toFixed(4)} (${pc(pool.unit_price - 1)} trading)`);
  console.log('  person         put in (₱ then)   worth now      trading %   after share %   share of pool');
  const out = {};
  for (const h of all) {
    const hist = (await db.query(`select public._history($1) as r`, [h.id])).rows[0].r;
    const tr = Returns.total(Returns.tradingGrowth(hist.map((p) => ({ u: Number(p.units), price: Number(p.price) }))));
    const yo = Returns.total(Returns.yourGrowth(hist.map((p) => ({ v: Number(p.value), n: Number(p.net_in) }))));
    const putIn = (await db.query(`select coalesce(sum(php_amount), 0)::float8 s from public.ledger where profile_id = $1 and kind = 'deposit'`, [h.id])).rows[0].s;
    out[slotOf[h.username]] = { value: Number(h.value_usdt), units: Number(h.units), tr, yo };
    console.log(`  ${h.username.padEnd(12)} ${('₱' + Math.round(putIn).toLocaleString('en-PH')).padStart(12)}   ${php(h.value_usdt).padStart(10)}     ${pc(tr).padStart(8)}     ${pc(yo).padStart(9)}     ${(Number(h.share_pct) * 100).toFixed(1).padStart(8)}%`);
  }
  return { pool, all, out };
}
const sameAs = (A, B) => Math.max(...Object.keys(A.out).map((k) => Math.abs(A.out[k].value - B.out[k].value) + Math.abs(A.out[k].units - B.out[k].units)), Math.abs(Number(A.pool.equity_usdt) - Number(B.pool.equity_usdt)));
const fileSlots = Object.fromEntries(PEOPLE.map((p) => [p.user, p.slot]));
const failures = [];

// (a) replay call by call (accounts named by slot)
const dbA = await freshDb(), cA = callAs(dbA);
await dbA.query(`select public.create_first_admin('manager', 'Manager', 'manager-pass-1')`);
const TA = await login(dbA, 'manager', 'manager-pass-1'), ids = { manager: (await dbA.query(`select id from public.profiles where role = 'admin'`)).rows[0].id };
for (const p of PEOPLE.filter((x) => !x.admin)) ids[p.slot] = await cA('admin_create_user', TA, p.slot.replaceAll('_', '-'), p.name, 'pass-' + p.slot, FEE_SIM);
for (const m of marks) {
  if (m.kind === 'deposit') await cA('admin_receive_deposit', TA, ids[m.who], m.usdt, m.rate, m.php, NOTE, iso(m.at));
  else if (m.kind === 'close') await cA('admin_close_quarter', TA, m.equity, m.rate, NOTE, iso(m.at));
  else await cA('admin_post_equity', TA, m.equity, m.rate, NOTE, iso(m.at));
}
console.log(`Account simulation: ${trades} trades closed, ${marks.length} ledger entries, largest single-trade risk ${maxRisk.toFixed(2)} USDT, final equity ${bal.toFixed(2)} USDT`);
const A = await summarize(dbA, 'Replay', TA, { manager: 'manager', ...Object.fromEntries(PEOPLE.filter((p) => !p.admin).map((p) => [p.slot.replaceAll('_', '-'), p.slot])) });

// (b) the SQL file on an EMPTY database (no accounts at all): creates everyone, loads the history; logins work
const dbB = await freshDb();
await dbB.exec(sql);
const B = await summarize(dbB, 'SQL file on an empty database', await login(dbB, PEOPLE[0].user, PEOPLE[0].pass), fileSlots);
for (const p of PEOPLE) await login(dbB, p.user, p.pass);
if (sameAs(A, B) > 1e-6) failures.push('empty database: numbers differ from the replay');

// (c) the SQL file on a database that already has this manager, one of the investors and old entries: reuses, clears, loads
const dbC = await freshDb(), cC = callAs(dbC);
await dbC.query(`select public.create_first_admin($1, 'Old name', 'old-password-9')`, [PEOPLE[0].user]);
const TC = await login(dbC, PEOPLE[0].user, 'old-password-9');
const inv1 = await cC('admin_create_user', TC, PEOPLE[1].user, 'Existing', 'existing-pass-1', FEE_SIM);
await cC('admin_receive_deposit', TC, inv1, 123); await cC('admin_post_equity', TC, 123); await cC('admin_receive_deposit', TC, inv1, 50);   // junk
await dbC.exec(sql);
const C = await summarize(dbC, 'SQL file on a database with existing accounts and old entries', await login(dbC, PEOPLE[0].user, 'old-password-9'), fileSlots);
await login(dbC, PEOPLE[1].user, 'existing-pass-1');   // existing password left alone
if (sameAs(A, C) > 1e-6) failures.push('existing accounts: numbers differ from the replay');

// (d) a different manager already exists: the file must refuse and change nothing
const dbD = await freshDb(), cD = callAs(dbD);
await dbD.query(`select public.create_first_admin('someone-else', 'X', 'other-pass-1')`);
const TD = await login(dbD, 'someone-else', 'other-pass-1');
await cD('admin_receive_deposit', TD, (await dbD.query(`select id from public.profiles where role = 'admin'`)).rows[0].id, 10); await cD('admin_post_equity', TD, 10);
try { await dbD.exec(sql); failures.push('wrong manager: file was not refused'); }
catch (e) { if (!/manager account here is someone-else/.test(e.message)) failures.push('wrong manager: unexpected error ' + e.message); await dbD.exec('rollback').catch(() => {}); }
if ((await dbD.query(`select count(*)::int n from public.pool_equity`)).rows[0].n !== 1 || (await dbD.query(`select count(*)::int n from public.profiles`)).rows[0].n !== 1) failures.push('wrong manager: data changed');

if ((await dbB.query(`select count(*)::int n from public.audit_log`)).rows[0].n !== 0) failures.push('activity log is not empty after the seed');
const sumVal = B.all.reduce((t, h) => t + Number(h.value_usdt), 0);
const eqDiff = Math.abs(Number(B.pool.equity_usdt) - bal), sumDiff = Math.abs(sumVal - Number(B.pool.equity_usdt)), mgr = Math.abs(B.out.manager.tr - (Number(B.pool.unit_price) - 1));
if (eqDiff > 1e-4) failures.push('ledger equity differs from the simulated account');
if (sumDiff > 1e-4) failures.push("everyone's values do not add up to the pool");
if (mgr > 1e-9) failures.push('manager trading % differs from the unit price');
console.log(`\nChecks: empty db = replay ${sameAs(A, B).toExponential(1)} · existing accounts = replay ${sameAs(A, C).toExponential(1)} · ledger vs simulated account ${eqDiff.toExponential(1)} USDT · values vs pool ${sumDiff.toExponential(1)} · manager % vs unit price ${mgr.toExponential(1)} · wrong manager refused, nothing changed`);
if (failures.length) { console.log('FAILED, SQL not written:\n  ' + failures.join('\n  ')); process.exit(1); }
writeFileSync(path.isAbsolute(OUT) ? OUT : new URL('../' + OUT, import.meta.url), sql);
console.log(`ALL CHECKS PASS → wrote ${OUT} (${lines.length} entries)\nLogins: ${PEOPLE.map((p) => `${p.user} / ${p.pass}`).join(' · ')}`);

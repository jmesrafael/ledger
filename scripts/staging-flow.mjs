// Staging mode: the whole pending-P/L -> Update Pool -> join -> payout flow, end to end, on an in-memory Postgres (PGlite) with FAKE live exits.
// No network, no environment variables, no credentials are read: it cannot touch the production Supabase project.
//   node scripts/staging-flow.mjs
import { world } from '../tests/_poolworld.mjs';

const f = (v, d = 4) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d });
const say = (s) => console.log(s);
const w = await world();
const snap = async (label) => say(`   ${label}: NAV ${f(await w.nav())} · unit price ${f(await w.price(), 6)} · units john ${f(await w.units('john'), 4)} dino ${f(await w.units('dino'), 4)} eve ${f(await w.units('eve'), 4)}`);
const pend = async () => { const p = await w.pending(); return `${p.count} trade(s), ${f(p.usd)} USDT pending`; };

say('STAGING FLOW (in-memory database, fake live trades)\n');
say('1. John joins with 1,000 USDT (first deposit starts the pool at price 1).');
await w.seed(1000); await snap('after join');
say('\n2. The bot closes two LIVE trades: +80 and -30. A PAPER trade of +500 is ignored.');
await w.exit('t1', 80); await w.exit('t2', -30, { ts: Date.now() - 90000 }); await w.exit('p1', 500, { mode: 'paper' });
say('   dashboard: ' + await pend()); await snap('pool did NOT move');
say('\n3. Dino and Eve send 300 and 200 USDT; both are seen arriving in MEXC (queued, not traded).');
const dino = await w.arrive('dino', 300), eve = await w.arrive('eve', 200);
const v = await w.check(1000 + 50 + 500);
say('   MEXC total typed and confirmed: ' + f(1550));
try { await w.call('admin_admit_deposit', w.A, dino, v, null, false); say('   !! admission was allowed (should not be)'); }
catch (e) { say('   accepting Dino now is refused: ' + e.message); }
say('\n4. Update Pool (exactly the two pending trades shown on screen) and accept both joiners in one transaction.');
const p = await w.pending();
const out = await w.call('admin_update_pool_and_admit', w.A, v, p.ids, p.usd, [dino, eve], 'staging-1', false, null);
say(`   ok=${out.ok}  unit price ${f(out.unit_price, 6)}  NAV before ${f(out.nav_before)} -> after (joiners excluded) ${f(out.nav_after)}  applied ${out.applied_trades} trade(s) = ${f(out.applied_usd)} USDT  unexplained ${f(out.difference)}`);
await snap('after update + joins'); say('   dashboard: ' + await pend());
say('\n5. A second click with the same request id replays; nothing is applied twice.');
const again = await w.call('admin_update_pool_and_admit', w.A, v, p.ids, p.usd, [dino, eve], 'staging-1', false, null);
say(`   replayed=${again.replayed}  pool entries still ${await w.poolRows()}`);
say('\n6. The bot reports MEXC futures equity; the reconciliation compares it with the books.');
await w.snap(1550);
let st = await w.call('admin_pool_status', w.A); say(`   status ${st.recon.status}: observed ${f(st.recon.observed)} vs expected ${f(st.recon.expected)} (difference ${f(st.recon.mismatch)}, tolerance ${f(st.recon.tolerance)})`);
await w.snap(1500);
st = await w.call('admin_pool_status', w.A); say(`   a 50 USDT shortfall -> status ${st.recon.status} (mismatch ${f(st.recon.mismatch)}); joins and payouts would now be refused`);
say('\n7. Undo: the ledger only undoes the NEWEST entry. A new trade closes, Update Pool is applied alone, and it is undone straight away.');
await w.exit('t3', 40, { ts: Date.now() - 20000 });
await w.snap(1590);                       // the bot's reading after that trade closed: MEXC futures equity includes its result
const v2 = await w.check(1590); const p2 = await w.pending();
const applied = await w.call('admin_update_pool', w.A, v2, p2.ids, p2.usd, null, false, null);
if (!applied.ok) throw new Error('Update Pool was blocked: ' + applied.text);
say('   applied: price ' + f(await w.price(), 6) + ', dashboard: ' + await pend());
const un = await w.call('admin_undo_last', w.A, 'staging: wrong balance');
say(`   undone: exits returned to pending ${un.exits_returned_to_pending}; price back to ${f(await w.price(), 6)}; dashboard: ${await pend()}`);
say('\nDone. Nothing here touched a real database.');
process.exit(0);

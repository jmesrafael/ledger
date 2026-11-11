// Daily "books vs MEXC" check. Pure logic, no network, no database writes: it reads a ledger export (the same JSON the nightly backup saves)
// and compares what the books say the exchange wallets should hold with what the wallets last reported.
//
//   expected wallet equity = pool value (last equity reading)
//                          + money redeemed but not yet sent out of the exchange
//                          + queued deposits, only when they wait in Futures (setting queued_money_location = 'futures')
//                          + unrealized P/L of open trades (the wallets' equity includes it, the booked pool value does not)
//   gap = combined wallet equity - expected          tolerance = max(0.50 USDT, 0.05% of the balance)  (the app's own pool_recon_tol_*)
//
// A gap beyond the tolerance means: a transfer / fee / trade the books do not know about, OR closed trades that Update Pool has not applied yet
// (they are inside the wallets but not yet in the pool value). The message says so; it does not guess which.
//
// verdicts: ok | review (gap beyond tolerance) | not_fresh (no usable wallet reports) | no_data (the export has no wallet reports)
export const WARN_BACKUP_DAYS = 3;

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const settingsMap = (x) => Object.fromEntries((x.settings || []).map((s) => [s.key, s.value]));

export function reconcile(x, { now = new Date() } = {}) {
  const S = settingsMap(x);
  const tolAbs = num(S.pool_recon_tol_abs, 0.5), tolPct = num(S.pool_recon_tol_pct, 0.0005);
  const maxAgeMin = num(S.wallet_max_age_minutes, 30), expectedCount = num(S.wallet_expected_count, 2);
  const out = { verdict: null, problems: [], notes: [], at: now.toISOString() };

  const wallets = (x.bot_wallets || []).filter((w) => w.active !== false);
  const snaps = x.wallet_snapshots || [];
  if (!Array.isArray(x.bot_wallets) || !wallets.length || !snaps.length) {
    out.verdict = 'no_data';
    out.problems.push('the export has no wallet reports (the wallet-snapshot migration is not applied, or the bots have not reported yet)');
    return out;
  }

  // newest snapshot per active wallet, by the ledger's clock (received_at)
  const rows = wallets.map((w) => {
    const mine = snaps.filter((s) => s.wallet === w.wallet).sort((a, b) => num(b.seq) - num(a.seq));
    const s = mine[0];
    if (!s) return { wallet: w.wallet, label: w.label, status: 'missing' };
    const ageMin = (now - new Date(s.received_at)) / 60000;
    const suspect = !!s.suspect && !s.accepted_at;
    const status = suspect ? 'suspect' : ageMin > maxAgeMin ? 'stale' : 'ok';
    return { wallet: w.wallet, label: w.label, status, age_min: round(ageMin, 1), received_at: s.received_at, equity: num(s.equity_usdt), unrealized: num(s.unrealized_usdt),
      open_positions: num(s.open_positions) };
  });
  out.wallets = rows;
  if (wallets.length < expectedCount) out.notes.push(`only ${wallets.length} of the ${expectedCount} expected wallets are registered`);

  const bad = rows.filter((r) => r.status !== 'ok');
  if (bad.length) {
    out.verdict = 'not_fresh';
    for (const r of bad) out.problems.push(r.status === 'missing' ? `wallet ${r.wallet} has never reported`
      : r.status === 'stale' ? `wallet ${r.wallet} last reported ${Math.round(r.age_min)} minutes ago (limit ${maxAgeMin}): the bot may be down`
      : `wallet ${r.wallet} has an unaccepted suspect snapshot (equity jumped)`);
    return out;
  }

  const equity = rows.reduce((t, r) => t + r.equity, 0);
  const unrealized = rows.reduce((t, r) => t + r.unrealized, 0);
  const lastEq = [...(x.pool_equity || [])].sort((a, b) => num(a.id) - num(b.id)).pop();
  const nav = lastEq ? num(lastEq.equity_usdt) : 0;
  const unsent = (x.payout_records || []).filter((p) => p.leaves_mexc && ['awaiting', 'failed'].includes(p.status)).reduce((t, p) => t + num(p.amount_usdt), 0);
  const queued = (x.pending_deposits || []).filter((d) => d.status === 'pending').reduce((t, d) => t + num(d.usdt), 0);
  const queuedInWallets = S.queued_money_location === 'futures' ? queued : 0;
  const expected = nav + unsent + queuedInWallets + unrealized;
  const gap = equity - expected, tol = Math.max(tolAbs, equity * tolPct);

  Object.assign(out, { wallet_equity: round(equity), unrealized: round(unrealized), pool_value: round(nav), unsent_payouts: round(unsent), queued_deposits: round(queued),
    queued_location: S.queued_money_location || 'spot', expected: round(expected), gap: round(gap), tolerance: round(tol), last_equity_reading_at: lastEq ? lastEq.ts : null });
  out.verdict = Math.abs(gap) <= tol ? 'ok' : 'review';
  if (out.verdict === 'review') out.problems.push(`the wallets hold ${round(equity)} but the books expect ${round(expected)}: gap ${gap >= 0 ? '+' : ''}${round(gap)} USDT (tolerance ${round(tol)}). `
    + 'Either closed trades are waiting for Update Pool (they are in the wallets but not yet in the pool value), or something moved that the books do not know about (a transfer, a fee, a trade).');

  // the books checking themselves (the same checks the backup runs): everyone's units must equal the last reading's units
  const ledgerUnits = (x.ledger || []).reduce((t, l) => t + num(l.units), 0);
  if (lastEq && Math.abs(ledgerUnits - num(lastEq.total_units)) > 1e-6) { out.verdict = 'review'; out.problems.push(`everyone's units (${ledgerUnits}) do not match the last equity reading (${lastEq.total_units})`); }
  return out;
}

// how old the newest local backup is. status = the backups/status.json the backup script writes ({ at, ok }); null = no backup was ever run here.
export function backupHealth(status, now = new Date()) {
  if (!status) return { ok: false, text: 'no automatic backup has ever run on this computer' };
  const days = (now - new Date(status.at)) / 86400000;
  if (status.ok === false) return { ok: false, text: `the last backup attempt FAILED (${status.error || (status.problems || []).join('; ') || 'unknown'})` };
  if (days > WARN_BACKUP_DAYS) return { ok: false, text: `the last backup was ${Math.floor(days)} days ago` };
  return { ok: true, text: `last backup ${days < 1 ? 'today' : Math.floor(days) + ' day(s) ago'}` };
}

export function formatReport(r, backup) {
  const icon = { ok: 'OK', review: 'CHECK THE BOOKS', not_fresh: 'NO FRESH WALLET DATA', no_data: 'NO WALLET DATA' }[r.verdict];
  const L = [`Ledger vs MEXC: ${icon}`];
  if (r.wallet_equity != null) {
    L.push(`wallets ${r.wallet_equity}  (of which open-trade profit ${r.unrealized})`, `books expect ${r.expected}  (pool ${r.pool_value} + unsent payouts ${r.unsent_payouts}${r.queued_location === 'futures' ? ` + queued ${r.queued_deposits}` : ''} + open-trade profit)`,
      `gap ${r.gap >= 0 ? '+' : ''}${r.gap}  tolerance ±${r.tolerance}`);
  }
  for (const p of r.problems) L.push('! ' + p);
  for (const n of r.notes) L.push('note: ' + n);
  if (backup && !backup.ok) L.push('! backup: ' + backup.text);
  return L.join('\n');
}

// contribution.js: what a person paid in pesos, the USDT it actually bought, and what those pesos are worth at today's reference rate.
// Shared by the app (window.Contribution) and the tests (require). Display only: nothing here feeds units, NAV, pool equity, fees, withdrawals or
// settlements. Units always come from the USDT actually received divided by the unit price the database approved when the money joined.
// Withdrawal requests are typed in USDT (withdrawUnits); pesos next to them are labelled estimates. Rules and the known database behaviour: docs/php-contributions.md.
//
// Two different rates, never mixed:
//  * Effective cash-in rate: pesos paid / USDT received, stored on a deposit (php_rate) when its pesos (php_amount) are stored too.
//    Without php_amount a stored php_rate is NOT a cash-in rate and is ignored here.
//  * Reference rate: today's PHP per USD from an independent live source (open.er-api.com, frankfurter.dev). Never a deposit's or a pool entry's
//    stored rate. Missing, invalid or older than MAX_AGE_MS -> no reference rate ("Rate unavailable"), no peso equivalent.
//
// Peso top-up (docs/php-contributions.md, section 9): a peso deposit is credited at the live reference rate, not at what the exchange delivered. When less USDT
// arrived than pesos / live rate, the fund manager gives the investor the difference from the manager's own units (admin_peso_topup), recorded as a
// deposit whose note starts with TOPUP and names the peso deposits it covers ("peso top-up for deposit #3: ..."). Each peso deposit is topped up at most once.
(function (root, factory) {
  const C = factory();
  if (typeof module === 'object' && module.exports) module.exports = C; else root.Contribution = C;
})(typeof self !== 'undefined' ? self : this, function () {
  const FRESH_MS = 36e5, MAX_AGE_MS = 12 * 36e5;   // refetch after an hour; a cached reading older than 12 hours is not used at all
  const MIN_RATE = 20, MAX_RATE = 200;             // PHP per USD outside this is a broken response, not a rate
  const n = (v) => (v == null || v === '' ? null : Number(v));
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  const TOPUP = 'peso top-up';
  const isTopup = (l) => String(l.note || '').toLowerCase().startsWith(TOPUP);
  const topupFor = (l) => (String(l.note || '').split(':')[0].match(/#\d+/g) || []).map((x) => x.slice(1));   // the peso deposit ids named before the first ':'

  // the PHP rate in a source's JSON ({ rates: { PHP } } for both sources), or null
  function parseFx(json) {
    const v = n(json && json.rates && json.rates.PHP);
    return ok(v) && v >= MIN_RATE && v <= MAX_RATE ? v : null;
  }

  // fx = { rate, t, src } as fetched (or cached). Returns { rate, t, src, ageMs, stale } or null when there is no usable reference rate.
  function referenceRate(fx, now = Date.now()) {
    if (!fx) return null;
    const r = n(fx.rate), t = n(fx.t);
    if (!ok(r) || r < MIN_RATE || r > MAX_RATE || !ok(t) || !fx.src) return null;
    const ageMs = now - t;
    if (ageMs < -6e4 || ageMs > MAX_AGE_MS) return null;   // from the future (clock wrong) or too old
    return { rate: r, t, src: String(fx.src), ageMs: Math.max(0, ageMs), stale: ageMs > FRESH_MS };
  }

  // pesos / USDT, 8 decimals (what the database stores), or null unless both are positive
  function effectiveRate(phpPaid, usdtReceived) {
    const p = n(phpPaid), u = n(usdtReceived);
    return ok(p) && ok(u) && p > 0 && u > 0 ? Math.round((p / u) * 1e8) / 1e8 : null;
  }

  // rows: the person's own ledger rows { id, ts, kind, usdt, units, php_amount, php_rate, reversed_of? }. ref: referenceRate() or null.
  // holding: { units, value_usdt, net_value_usdt? } as the database reports them.
  function summary(rows, ref, holding) {
    const dep = (rows || []).filter((l) => l.kind === 'deposit');
    // a reversed deposit (an "Edit" undoing it) has a matching negative row; neither counts. reversed_of when the row carries it, otherwise the exact negative.
    const undone = new Set(dep.filter((l) => l.reversed_of != null).map((l) => String(l.reversed_of)));
    const neg = dep.filter((l) => Number(l.usdt) < 0 && l.reversed_of == null);
    const live = dep.filter((l) => Number(l.usdt) > 0 && !undone.has(String(l.id)));
    for (const r of neg) {
      const i = live.findIndex((l) => Math.abs(Number(l.usdt) + Number(r.usdt)) < 1e-9 && Math.abs(Number(l.units) + Number(r.units)) < 1e-9);
      if (i >= 0) live.splice(i, 1);
    }
    const peso = live.filter((l) => n(l.php_amount) > 0 && !isTopup(l)), tops = live.filter(isTopup);
    const covered = new Set(tops.flatMap(topupFor));
    const deposits = peso.map((l) => ({ id: l.id, ts: l.ts, php: Number(l.php_amount), usdt: Number(l.usdt), rate: effectiveRate(l.php_amount, l.usdt), toppedUp: covered.has(String(l.id)) }))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const topup = tops.reduce((t, l) => t + Number(l.usdt), 0);
    const php = deposits.reduce((t, d) => t + d.php, 0), usdt = deposits.reduce((t, d) => t + d.usdt, 0) + topup;
    const usdtOnly = live.filter((l) => !(n(l.php_amount) > 0) && !isTopup(l));
    const h = holding || {};
    return {
      deposits, php, usdt, topup,
      rate: effectiveRate(php, usdt),                                   // total pesos / total USDT: weighted, never an average of the rates
      usdtOnly: usdtOnly.reduce((t, l) => t + Number(l.usdt), 0), usdtOnlyCount: usdtOnly.length,
      withdrawnUsdt: 0 - (rows || []).filter((l) => l.kind === 'withdrawal').reduce((t, l) => t + Number(l.usdt), 0),   // a reversed payout's +row cancels it
      ref: ref || null,
      usdEquivalent: ref && php > 0 ? php / ref.rate : null,           // reference only: not a balance, not a claim
      units: n(h.units), value: n(h.value_usdt), netValue: n(h.net_value_usdt),
    };
  }

  // The peso top-up still due: the peso deposits not topped up yet, credited at the live reference rate (pesos / rate, rounded down to 6 decimals),
  // minus the USDT that arrived for them. Null without a fresh live rate (never a stale or stored one) or when nothing is due (0.01 USDT or less).
  function topupDue(s, ref) {
    if (!s || !ref || ref.stale) return null;
    const open = s.deposits.filter((d) => !d.toppedUp);
    const php = open.reduce((t, d) => t + d.php, 0), arrived = open.reduce((t, d) => t + d.usdt, 0);
    if (!(php > 0)) return null;
    const credited = Math.floor((php / ref.rate) * 1e6 + 1e-7) / 1e6, gap = Math.round((credited - arrived) * 1e6) / 1e6;
    if (!(gap > 0.01)) return null;
    const ids = open.map((d) => '#' + d.id).join(', ');
    return { ids: open.map((d) => d.id), php, arrived, credited, gap, rate: ref.rate,
      note: `${TOPUP} for deposit ${ids}: ₱${f(php, 2)} credited at the live PHP/USD reference ₱${f(ref.rate, 4)} (${ref.src}, ${clock(ref.t)}) = ${f(credited, 6)} USDT; ${f(arrived, 6)} USDT arrived, ${f(gap, 6)} USDT from the fund manager's units` };
  }

  // "Put in", shown in pesos only when every peso of it was really paid (peso deposits only, nothing taken out); otherwise in USDT.
  // A USDT-only deposit is never turned into pesos, so it never looks as if it was paid in pesos.
  const putInPesos = (s) => (s && s.php > 0 && !s.usdtOnlyCount && !(Math.abs(s.withdrawnUsdt) > 1e-9) ? s.php : null);

  // ---------------------------------------------------------------- withdrawal requests are in USDT
  // The units a request for `amountUsdt` asks for, at the unit price shown. No rate goes in: a peso rate can never change a request.
  // Within 0.01 USDT of everything unlocked means "everything" (the Max button rounds down to the cent); more than that is left for the database to refuse.
  function withdrawUnits(amountUsdt, unitPrice, unlockedUnits) {
    const a = n(amountUsdt), p = n(unitPrice), all = n(unlockedUnits);
    if (!ok(a) || a <= 0 || !ok(p) || p <= 0) return null;
    const want = a / p;
    return ok(all) && all > 0 && Math.abs(want - all) <= 0.01 / p ? all : want;
  }

  // The figures of an admission spread (docs/admission-spread.md): pesos credited at an admission rate above the actual / reference rate.
  //   credited = pesos / admission rate, rounded DOWN to 6 decimals; actual = the USDT really allocated (default pesos / reference rate); surplus = actual - credited (the manager's).
  // The database does the same sums and every refusal (admin_quote_admission_spread); this only fills the form's defaults. Units never come from pesos or rates here.
  function spreadFigures(php, ref, adm, actual) {
    const p = n(php), r = n(ref), a = n(adm);
    if (!ok(p) || !ok(r) || !ok(a) || p <= 0 || r <= 0 || a <= 0) return null;
    const given = n(actual), act = ok(given) && given > 0 ? given : Math.round((p / r) * 1e6) / 1e6;
    const credited = Math.floor((p / a) * 1e6 + 1e-7) / 1e6;
    return { actual: act, credited, surplus: Math.round((act - credited) * 1e6) / 1e6, impliedRate: p / act, spread: Math.round((a - r) * 1e6) / 1e6 };
  }

  // ---------------------------------------------------------------- wording
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const f = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const php = (v) => '₱' + f(v, 2);
  const usd = (v, unit = 'USDT') => `${f(v, 2)} ${unit}`;
  const clock = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const row = (l, r, note) => `<div class="row"><span class="l">${l}${note ? `<br><span class="note">${note}</span>` : ''}</span><span class="r">${r}</span></div>`;

  function refText(ref) {
    if (!ref) return 'Rate unavailable';
    return `₱${f(ref.rate, 2)} per USD`;
  }
  function refNote(ref) {
    if (!ref) return 'no live rate could be loaded, so no peso comparison is shown';
    return `${ref.stale ? 'last loaded' : 'live'} from ${esc(ref.src)}, ${clock(ref.t)}`;
  }

  // the rows (for the manager's investor sheet) and the card (investor home, My account)
  // opts.holdings = false leaves out units and value (the investor sheet already shows them)
  function rows(s, opts = {}) {
    if (!s) return '';
    const holdings = opts.holdings !== false;
    const out = [];
    if (s.deposits.length) {
      out.push(row('Original PHP contribution', php(s.php), s.deposits.length > 1 ? `${s.deposits.length} peso deposits` : 'pesos paid in'));
      out.push(row('USDT credited to you', usd(s.usdt), 'what your pesos were credited as; only this buys units'));
      if (s.topup > 0) out.push(row('Topped up by the fund manager', usd(s.topup), 'so your pesos count at the live PHP/USD rate on the day; from the fund manager\'s own units, nobody else\'s'));
      out.push(row('Effective conversion rate', s.rate == null ? '—' : `₱${f(s.rate, 2)} per USDT`, s.deposits.length > 1 ? 'total pesos ÷ total USDT, at the time of each deposit' : 'pesos ÷ USDT, at the time of the deposit'));
      out.push(row('Current PHP/USD reference rate', refText(s.ref), refNote(s.ref)));
      out.push(row('Current USD equivalent of the pesos paid', s.usdEquivalent == null ? 'Rate unavailable' : usd(s.usdEquivalent, 'USD'), 'reference only: what those pesos would buy at today\'s rate. It is not a balance and does not change any units'));
    } else {
      out.push(row('Original PHP contribution', '—', 'no deposit paid in pesos'));
    }
    if (s.usdtOnlyCount) out.push(row('Put in directly in USDT', usd(s.usdtOnly), `${s.usdtOnlyCount} deposit${s.usdtOnlyCount === 1 ? '' : 's'}, no pesos involved`));
    if (holdings && s.units != null) out.push(row('Investment units owned', f(s.units, 8)));
    if (holdings && s.value != null) out.push(row('Current investment value', usd(s.value), `units × today's unit price${s.netValue != null && Math.abs(s.netValue - s.value) >= 0.005 ? ` · ${usd(s.netValue)} after the profit share due` : ''}`));
    return out.join('');
  }

  // The money's journey, for one look: what was put in -> what arrived in the fund (USDT) -> what it is worth now, and where the difference went.
  // In pesos (at today's reference rate) only when every peso of it was really paid in pesos and a reference rate is known; otherwise in USDT.
  //   conversionPhp = pesos paid − (USDT that arrived × today's rate): what converting pesos to USDT cost, seen at today's rate
  //   resultPhp     = (worth now − USDT that arrived) × today's rate: the fund's result since then (after fees charged)
  // Display only: none of these figures is stored or used for units, NAV, fees or payouts.
  function journey(s) {
    if (!s || (!s.deposits.length && !s.usdtOnlyCount)) return null;
    const inUsdt = s.usdt + s.usdtOnly, ref = s.ref ? s.ref.rate : null, now = s.value;
    const j = { pesoOnly: putInPesos(s) != null, paidPhp: s.php, inUsdt, outUsdt: s.withdrawnUsdt, now, ref,
      result: now == null ? null : now - inUsdt + s.withdrawnUsdt, inPesos: false };
    if (j.pesoOnly && ref && now != null) {
      const arrivedPhp = s.usdt * ref, nowPhp = now * ref;
      Object.assign(j, { inPesos: true, arrivedPhp, nowPhp, conversionPhp: s.php - arrivedPhp, resultPhp: nowPhp - arrivedPhp });
    }
    return j;
  }
  const phpR = (v) => '₱' + Number(v).toLocaleString('en-US', { minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
  const sgn = (v, fmt) => (v > 0.0049 ? '+' : v < -0.0049 ? '−' : '') + fmt(Math.abs(v));
  const tone = (v) => (v > 0.0049 ? 'up' : v < -0.0049 ? 'down' : '');

  function card(s, title = 'Your contribution') {
    const j = journey(s);
    if (!j) return '';
    const step = (k, v, sub, cls = '') => `<div class="fstep ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    const arrow = '<div class="farrow" aria-hidden="true">→</div>';
    const paid = s.php > 0 ? (s.usdtOnly > 0 ? `${phpR(s.php)} + ${usd(s.usdtOnly)}` : phpR(s.php)) : usd(s.usdtOnly);
    const paidSub = s.php > 0 ? (s.usdtOnly > 0 ? 'pesos, plus USDT put in directly' : s.deposits.length > 1 ? `in pesos · ${s.deposits.length} deposits` : 'in pesos') : 'in USDT';
    const flow = `<div class="jflow">${step(s.php > 0 ? 'You paid' : 'You put in', paid, paidSub)}${arrow}
      ${step('Credited to you', usd(j.inUsdt), s.rate ? `₱${f(s.rate, 2)} paid per USDT` : 'what buys your units')}
      ${j.now != null ? arrow + step(j.outUsdt > 0.0049 ? 'Worth now (after payouts)' : 'Worth now', usd(j.now), `${j.inPesos ? `≈ ${phpR(j.nowPhp)} today · ` : ''}<span class="${tone(j.result)}">${sgn(j.result, usd)}</span>`, 'now') : ''}</div>`;
    // where the difference went: one bar per line, widths to scale
    let lines;
    if (j.inPesos) {
      lines = [['You paid', j.paidPhp, 'paid', phpR(j.paidPhp), ''],
        ['Lost converting pesos to USDT', -j.conversionPhp, 'conv', sgn(-j.conversionPhp, phpR), `you paid ₱${f(s.rate, 2)} per USDT; today's rate is ₱${f(j.ref, 2)} (${usd(j.paidPhp / j.ref - s.usdt)})`],
        ['Trading so far', j.resultPhp, j.resultPhp >= 0 ? 'gain' : 'loss', sgn(j.resultPhp, phpR), `the fund's result since your money joined, after fees (${sgn(j.result, usd)})`],
        ['Worth now', j.nowPhp, 'now', phpR(j.nowPhp), 'at today\'s rate']];
    } else if (j.now != null) {
      lines = [['Put in', j.inUsdt, 'paid', usd(j.inUsdt), s.php > 0 ? `including ${phpR(s.php)} paid in pesos` : ''],
        ...(j.outUsdt > 0.0049 ? [['Taken out', -j.outUsdt, 'conv', sgn(-j.outUsdt, usd), 'withdrawals paid to you']] : []),
        ['Trading so far', j.result, j.result >= 0 ? 'gain' : 'loss', sgn(j.result, usd), 'the fund\'s result since your money joined, after fees'],
        ['Worth now', j.now, 'now', usd(j.now), j.pesoOnly && !j.ref ? 'peso figures: rate unavailable' : '']];
    }
    const max = lines ? Math.max(...lines.map((x) => Math.abs(x[1]))) || 1 : 1;
    const wf = lines ? `<div class="wf">${lines.map(([l, v, c, t, note]) => `<div class="wfrow"><div class="wfl">${l}${note ? `<span class="note">${note}</span>` : ''}</div>
      <div class="wfbar"><span class="${c}" style="width:${Math.max(1.5, (Math.abs(v) / max) * 100).toFixed(1)}%"></span></div><div class="wfv ${c === 'loss' || c === 'conv' ? 'down' : c === 'gain' ? 'up' : ''}">${t}</div></div>`).join('')}</div>` : '';
    return `<div class="card" data-contribution><h2>${esc(title)}</h2>${flow}${wf}
      <p class="note">${s.units != null ? `You own <b>${f(s.units, 8)} units</b>, bought` : 'Units are bought'} with the USDT credited to you, at the unit price on the day your money joined. Changes in the peso rate never change your units or their value.</p>
      <details class="more"><summary>All figures</summary>${rows(s)}</details></div>`;
  }

  return { FRESH_MS, MAX_AGE_MS, MIN_RATE, MAX_RATE, parseFx, referenceRate, effectiveRate, summary, topupDue, TOPUP, putInPesos, withdrawUnits, spreadFigures, journey, rows, card };
});

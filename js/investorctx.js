// investorctx.js: the investor detail "Position and actions" block on the manager's Users sheet: what this person holds, what is waiting for them,
// and which of Add money / Withdraw / Full exit make sense. Display and routing only: every number is a field the database already sent (admin_overview,
// admin_pending, withdrawal requests, the balance-check queue, pool status). Nothing is calculated here; a missing value reads "Not available".
// Shared by the app (window.InvestorCtx) and the tests (require).
(function (root, factory) {
  const I = factory();
  if (typeof module === 'object' && module.exports) module.exports = I; else root.InvestorCtx = I;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NA = '<span class="muted">Not available</span>';
  const has = (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !Number.isFinite(v));
  const held = (h) => has(h && h.units) && Number(h.units) > 1e-8;

  // Which actions this person gets, and why one is missing. Never offers a withdrawal to someone with no units, or any action to the manager's own row
  // (the manager's money is handled under My account) or to a deactivated account.
  function actions(h) {
    if (!h) return { add: { ok: false, why: 'Unknown person.' }, withdraw: { ok: false, why: 'Unknown person.' }, exit: { ok: false, why: 'Unknown person.' } };
    const inv = h.role === 'investor';
    const off = (why) => ({ ok: false, why });
    if (!inv) { const w = off('The fund manager\'s own money is handled under My account.'); return { add: w, withdraw: w, exit: w }; }
    const holds = held(h);
    return {
      add: h.active ? { ok: true } : off('This account is deactivated. Reactivate it first.'),
      withdraw: !holds ? off('Holds no units yet.') : { ok: true },
      exit: !holds ? off('Holds no units yet.') : { ok: true },
    };
  }

  // ctx: { pend: admin_pending rows, reqs: withdrawal_requests rows, queue: admin_capital_queue | null, pu: admin_pool_status | null,
  //        fmt: { money(usdt), units(n), day(ts), pc(rate) } }
  function summary(h, ctx) {
    const pend = (ctx.pend || []).filter((d) => d.profile_id === h.id);
    const reqs = (ctx.reqs || []).filter((q) => q.profile_id === h.id && q.status === 'pending');
    const qd = ctx.queue && Array.isArray(ctx.queue.deposits) ? ctx.queue : null;
    return { pend, reqs, queue: qd };
  }

  function tradeStatus(ctx) {
    const rd = ctx.queue && ctx.queue.ready, pu = ctx.pu;
    const parts = [];
    if (!ctx.queue && !pu) return `Open trades: ${NA}`;
    if (rd && rd.ok === true) parts.push('A confirmed balance check with no open trades is available.');
    else if (rd && Array.isArray(rd.reasons) && rd.reasons.length) parts.push(esc(rd.reasons.map((r) => r.text || r.code).join(' ')));
    else if (rd) parts.push('No usable balance check yet.');
    if (pu && pu.pending && Number(pu.pending.count) > 0) parts.push(`${esc(pu.pending.count)} closed live trade(s) not applied to the pool yet (Update Pool first).`);
    return parts.length ? parts.join(' ') : NA;
  }

  function card(h, ctx) {
    const fmt = ctx.fmt, a = actions(h), s = summary(h, ctx), inv = h.role === 'investor';
    const m = (v) => (has(v) ? esc(fmt.money(v)) : NA);
    const row = (l, r) => `<div class="row"><span class="l">${l}</span><span class="r">${r}</span></div>`;
    const btn = (key, label, act) => (a[act].ok
      ? `<button type="button" data-action="invact" data-inv="${esc(key)}" data-id="${esc(h.id)}">${esc(label)}</button>`
      : `<button type="button" disabled aria-disabled="true" title="${esc(a[act].why)}">${esc(label)}</button>`);
    const why = ['add', 'withdraw', 'exit'].filter((k) => !a[k].ok).map((k) => a[k].why).filter((w, i, arr) => arr.indexOf(w) === i);
    return `<div class="invctx" data-inv-card="${esc(h.id)}"><h3 class="hh" style="margin-top:14px">Position and actions</h3>
      ${row('Units', has(h.units) ? esc(fmt.units(h.units)) : NA)}
      ${row(inv && has(h.net_value_usdt) ? 'Balance after fee' : 'Balance', m(inv && has(h.net_value_usdt) ? h.net_value_usdt : h.value_usdt))}
      ${inv ? row('High-water mark', m(has(h.hwm_usdt) ? h.hwm_usdt : h.hwm_value)) : ''}
      ${inv ? row('Fee if they left now (not yet charged)', m(h.accrued_fee_usdt)) : ''}
      ${inv ? row('Below the mark by', m(h.below_hwm_usdt)) : ''}
      ${inv ? row('Waiting to join', s.pend.length ? s.pend.map((d) => `${esc(fmt.money(d.usdt))} (${d.arrived_at ? 'in the exchange' : 'not in the exchange yet'})`).join('<br>') : 'None') : ''}
      ${inv ? row('Withdrawal requests', s.reqs.length ? s.reqs.map((q) => `${esc(fmt.units(q.units))} units, pay by ${esc(fmt.day(q.pay_by))}`).join('<br>') : 'None') : ''}
      ${inv ? row('Trades and balance check', `<span class="note">${tradeStatus(ctx)}</span>`) : ''}
      ${inv ? `<div class="btns" role="group" aria-label="Actions for ${esc(h.name || h.username)}">${btn('add', 'Add Money', 'add')}${btn('withdraw', 'Withdraw', 'withdraw')}${btn('exit', 'Full Exit', 'exit')}</div>` : ''}
      ${why.length ? `<p class="note">${why.map(esc).join(' ')}</p>` : ''}
      ${inv ? '<p class="note">These buttons take you to the Money in / Money out form with this person filled in. Nothing is saved until you confirm there.</p>' : ''}</div>`;
  }
  return { actions, summary, tradeStatus, card, held };
});

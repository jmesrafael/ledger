// gate.js: what the manager's old direct forms show once workflow_gate is ON. With the gate on, deposits, withdrawals and settlements are only
// possible through the Capital tab (the database refuses the direct routes), so the old forms are replaced by instructions: nobody should
// meet an error message. No accounting here and no numbers beyond what the page passes in. Shared by the app (window.Gate) and the tests (require).
(function (root, factory) {
  const G = factory();
  if (typeof module === 'object' && module.exports) module.exports = G; else root.Gate = G;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const on = (queue) => !!queue && queue.gate === 'on';
  // an instruction card with a button to the Capital tab (the app's navigation reads data-tab)
  const instruction = (title, body) => `<div class="card" data-gate="instruction"><h2>${title}</h2><p class="note"><b>The workflow gate is on.</b> ${body}</p><div class="btns"><button data-tab="capital">Open the Capital tab</button></div></div>`;

  const TEXT = {
    withdrawal: 'Withdrawals are handled on the <b>Capital</b> tab: <b>Approve</b> the request, <b>Quote</b> it, <b>Redeem</b> it against a confirmed balance, then record the payout. This direct form is switched off, because it would pay out without a confirmed balance.',
    settlement: 'A settlement is made on the <b>Capital</b> tab, under <b>Valuation and settlement</b>, after you enter and confirm the MEXC balance. Settle in the first 7 days after a two-month period ends (Manila time). If it is late, dated earlier than it is recorded, or trades are open, you will be asked to approve an exception with your reason.',
    balance: (n, totalText) => `${n} deposit${n === 1 ? ' is' : 's are'} already in MEXC and waiting (${totalText}). A balance reading would try to admit ${n === 1 ? 'it' : 'them'}, and that must be done on the <b>Capital</b> tab against a confirmed balance. Admit ${n === 1 ? 'it' : 'them'} there first, then come back.`,
    deposit: 'After you save, confirm on the <b>Capital</b> tab that you saw the money arrive in MEXC (<b>Seen in MEXC</b>, with a note), then admit it.',
    waiting: 'Received but not in the pool yet: no gains, no losses. With the workflow gate on, each deposit joins in three steps on the <b>Capital</b> tab: <b>Seen in MEXC</b> (with a note), then a confirmed balance, then <b>Admit</b>.',
  };

  // What an old form should show. null = the normal form (gate off, or nothing in the way).
  //   kind: 'withdrawal' | 'balance' | 'settlement'      ctx: { arrived, totalText } for 'balance'
  function oldForm(kind, queue, ctx = {}) {
    if (!on(queue)) return null;
    if (kind === 'withdrawal') return instruction('Money out', TEXT.withdrawal);
    if (kind === 'settlement') return instruction('Two-month settlement', TEXT.settlement);
    if (kind === 'balance') return Number(ctx.arrived) > 0 ? instruction('Balance', TEXT.balance(Number(ctx.arrived), esc(ctx.totalText || ''))) : null;
    return null;
  }
  return { on, oldForm, instruction, TEXT };
});

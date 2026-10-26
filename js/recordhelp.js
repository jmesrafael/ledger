// recordhelp.js: the "? How this works" instructions for the manager's Record tabs (Money in, Money out, Balance). Plain words, one numbered flow per tab,
// in the order things really have to happen. Content only: no accounting and no numbers except the ones the page passes in (the workflow gate, how long a
// confirmed balance stays usable). Every button name it mentions is listed in `labels` and checked against the real screens by tests/record-help.test.mjs,
// so the instructions cannot drift away from the buttons. Shared by the app (window.RecordHelp) and the tests (require).
(function (root, factory) {
  const R = factory();
  if (typeof module === 'object' && module.exports) module.exports = R; else root.RecordHelp = R;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const b = (t) => `<b>${esc(t)}</b>`;   // a button or card name, always in bold so it can be found on the screen

  // a step: { t: title, where: where to do it, body: html, labels: [button names in it] }
  const STEP = {
    account: { t: 'They have an account', where: 'Users tab', body: 'New person? Add them under Users first. Already there? Skip this step.', labels: [] },
    spot: { t: 'The money arrives in the exchange Spot', where: 'In the exchange, outside this app',
      body: 'They send USDT to your exchange deposit address, and you keep it in the <b>Spot</b> wallet, <b>not Futures</b>. The bot only trades what is in Futures, so money that is still waiting can never be traded before the person has joined.', labels: [] },
    confirmBalance: (maxAge) => ({ t: 'Check and confirm the exchange balance', where: 'Balance tab, Balance check card',
      body: `Open Exchange and add up <b>Spot + Futures</b>. Make sure nothing is open (Futures: Positions 0, Orders 0). Type that total, put <b>0</b> open positions and <b>0</b> open orders, press ${b('Enter balance (not confirmed yet)')}, then ${b('Confirm this balance')}.
        It is only a draft until you confirm, and confirming changes nobody's money. A confirmed balance stays usable for ${maxAge} hours, and the trade list must be empty: money only moves while the account is flat.`,
      labels: ['Enter balance (not confirmed yet)', 'Confirm this balance', 'Balance check'] }),
    updatePool: { t: 'Press Update Pool, if the page asks you to', where: 'Balance tab, the Pending P/L card at the top',
      body: `If you see a <b>Pending P/L</b> card, the bot has closed trades that have not been applied to the pool yet. Nobody can join or be paid out until they are. Press ${b('Update Pool')}: it sets the pool to the balance you just confirmed, so the trading result goes to the people who are in the pool now, and a newcomer or a leaver gets today's price.
        You can also tick the person and press ${b('Update Pool and accept ticked')} to do both in one go. No Pending P/L card? Skip this step.`, labels: ['Update Pool', 'Update Pool and accept ticked'] },
  };

  function topics(ctx = {}) {
    const gate = !!ctx.gate, maxAge = Number(ctx.maxAgeHours) > 0 ? Math.round(Number(ctx.maxAgeHours)) : 12, cb = STEP.confirmBalance(maxAge);   // a number only: nothing from the page is put into the text as HTML
    return {
      dep: {
        title: 'Adding someone\'s money', tab: 'Money in',
        intro: `A new person's money goes through a few checkpoints before it becomes their share. Until the last one it is <b>outside the pool</b>: it earns nothing, loses nothing, and changes nobody else's value.`,
        glance: gate ? ['Account', 'Spot', 'Record', 'Seen in the exchange', 'Check balance', 'Update Pool', 'Admit', 'Spot → Futures'] : ['Account', 'Spot', 'Record', 'In the exchange', 'Update Pool', 'Update equity', 'Spot → Futures'],
        steps: [
          STEP.account, STEP.spot,
          { t: 'Record it here', where: 'This tab: Money in', body: `Choose ${b('Who')}, type the amount, choose the currency (₱ Pesos or USDT) and press ${b('Save')}. They now appear under ${b('Waiting to join')}. Nothing has changed for anyone yet.${gate ? '' : ` If the money is already in the exchange you can tick ${b('Already seen in the exchange')}.`}`, labels: ['Save', 'Waiting to join'].concat(gate ? [] : ['Already seen in the exchange']) },
          ...(gate ? [
            { t: 'Mark it as seen in the exchange', where: 'Balance tab, Deposits card', body: `Press ${b('Seen in the exchange')} on their row and write how you saw it arrive (for example the exchange deposit record).`, labels: ['Seen in the exchange'] },
            cb, STEP.updatePool,
            { t: 'Admit them', where: 'Balance tab, Deposits card', body: `Press ${b('Admit')}. They buy units at today's price, and from this moment they are in the pool.`, labels: ['Admit'] },
          ] : [
            { t: 'Mark it as in the exchange', where: 'This tab, the Waiting to join list', body: `When the money is in your exchange Spot wallet, press ${b('In the exchange')} on their row. It does not join yet.`, labels: ['In the exchange', 'Waiting to join'] },
            { t: 'Pending P/L card showing? Confirm the balance, then Update Pool', where: 'Balance tab', labels: ['Enter balance (not confirmed yet)', 'Confirm this balance', 'Update Pool', 'Balance check', 'Pending P/L'].filter((l) => l !== 'Pending P/L'),
              body: `Look at the top of the Balance tab. If a <b>Pending P/L</b> card shows closed bot trades, nobody can join until they are applied. Then: open Exchange, add up <b>Spot + Futures</b> with nothing open, type it in the Balance check card, press ${b('Enter balance (not confirmed yet)')}, then ${b('Confirm this balance')}, and press ${b('Update Pool')}.
                This sets the pool to that balance, so the trading result goes to the people already in the pool and the newcomer gets today's price. No Pending P/L card? Skip this step.` },
            { t: 'Update equity: this is what admits them', where: 'Balance tab, More options', body: `Type the current Exchange total (Spot + Futures, nothing open) and press ${b('Save')} under <b>More options</b>. Everyone marked in the exchange joins at that price.`, labels: ['Save'] },
          ]),
          { t: 'Move the money to Futures', where: 'In the exchange, right after', body: 'Transfer exactly the accepted amount from <b>Spot to Futures</b>. The bot sees the larger Futures balance at its next run (within 4 hours) and sizes its trades on it. That increase is capital, not profit.', labels: [] },
        ],
        good: [
          'They buy at today\'s price, so they get <b>none</b> of the profit or loss made before they joined, and they cannot dilute the people already in.',
          `Money you gave back? Press ${b('Handed back')} on their row. Nothing in the books changes.`,
          `Changed your mind half way? Nothing is saved until ${gate ? b('Admit') : b('Save') + ' under More options'}.`,
        ],
        refused: [
          ['It says "pending P/L … Click Update Pool first"', 'Closed trades are waiting. Do the Update Pool step, then try again.'],
          ['It says the balance is too old, or a trade is open', 'Enter and confirm the balance again, when nothing is open.'],
          ['Reconciliation shows MISMATCH', 'The bot\'s Exchange reading does not match the books. Find what moved (a transfer, fees, funding) before anything else.'],
        ],
        labels: [],
      },
      wd: {
        title: 'Paying someone out', tab: 'Money out',
        intro: `Investors ask in their own app and you walk the request through the checkpoints below. <b>Money only leaves the exchange at the end</b>, after the ledger has already sold their units at a fair price.`,
        glance: ['They ask', 'Approve', 'Check balance', 'Update Pool', 'Quote', 'Redeem', 'Send', 'Sent from the exchange', 'Completed'],
        steps: [
          { t: 'They ask', where: 'The investor\'s app', body: `The investor presses ${b('Request withdrawal')} and says how many units. They must have saved their GCash or bank details first, otherwise the app will not let them ask.`, labels: ['Request withdrawal'] },
          { t: 'Approve the request', where: 'Balance tab, Withdrawals and payouts card', body: `Press ${b('Approve')}. If they are still inside the lock-up shown to investors, it asks you for a written reason (an exception). ${b('Reject')} tells them no, with a reason.`, labels: ['Approve', 'Reject', 'Withdrawals and payouts'] },
          cb, STEP.updatePool,
          { t: 'Quote, then Redeem', where: 'Balance tab, Withdrawals and payouts card', body: `${b('Quote')} shows the price, the fee on their gain and the payout, and <b>saves nothing</b>. ${b('Redeem')} does it: their units are sold at that price, the fee is taken in units, and a payout is created. It asks whether you pay from your own money (nothing leaves the exchange) or from the exchange.`, labels: ['Quote', 'Redeem'] },
          { t: 'Send the money', where: 'Exchange, then their GCash or bank', body: 'In the exchange move the amount from <b>Futures to Spot</b>, withdraw it, and send it to their receiving details (Log tab, under Withdrawal requests, "Where to send it"). Contact them to confirm before sending.', labels: [] },
          { t: 'Mark it sent, then completed', where: 'Balance tab, Withdrawals and payouts card', body: `In the same sitting press ${b('Sent from the exchange')} (or ${b('Paid')} when you paid from your own pocket). When they have received it, press ${b('Completed')} and write the GCash or bank reference. If it went wrong press ${b('Failed')} with the reason, then ${b('Retry')}.`, labels: ['Sent from the exchange', 'Paid', 'Completed', 'Failed', 'Retry'] },
        ],
        good: [
          'Until you press <b>Sent from the exchange</b>, the reconciliation still counts the money as inside the account, so do the exchange transfer and the click together.',
          'A payout that leaves the exchange <b>uses up</b> the confirmed balance, because the real balance has changed. Confirm a fresh one before the next payout.',
          `The form on this tab is only for a payout you record by hand, when there is no request.`,
        ],
        refused: [
          ['It says "pending P/L … Click Update Pool first"', 'Do the Update Pool step, then press Redeem again.'],
          ['It says the balance was already used', 'The last payout used it up. Enter and confirm the balance again.'],
          ['It says to approve the request first', 'Press Approve on the request before Quote or Redeem.'],
        ],
        labels: [],
      },
      eq: {
        title: 'The Balance desk', tab: 'Balance',
        intro: `This is the control room. <b>Nobody can join, leave or be settled</b> unless Exchange's real balance has been checked here first. The cards run from top to bottom in the order you use them.`,
        glance: ['Look at the exchange', 'Enter balance', 'Confirm', 'Explain a difference', 'Pending P/L', 'Deposits', 'Withdrawals'],
        steps: [
          { t: 'Look at the exchange', where: 'In the exchange', body: 'Read the total of <b>Spot + Futures</b>, and check that nothing is open: Futures, Positions 0 and Orders 0. The ledger can only move money while the account is flat.', labels: [] },
          { t: 'Enter the balance', where: 'Balance check card', body: `Type the total, put the open positions (0, 1 or 2) and open orders, and press ${b('Enter balance (not confirmed yet)')}. It is a draft: nothing changes yet.`, labels: ['Enter balance (not confirmed yet)', 'Open positions (0, 1 or 2)', 'Balance check'] },
          { t: 'Confirm it', where: 'Balance check card', body: `Press ${b('Confirm this balance')} when the number is right (${b('Reject')} if you typed it wrong). Confirming records a fact: it moves no money. It stays usable for ${maxAge} hours.`, labels: ['Confirm this balance', 'Reject'] },
          { t: 'Read the difference', where: 'Balance check card', body: `${b('Unexplained difference')} should be about zero. If not, something moved that the ledger does not know about: a transfer, fees or funding, or trades the bot closed. Press ${b('Explain part')} to name a piece, or press ${b('Classify the rest')} and write why. When trades are pending use ${b('Classify beyond the pending trades')}: the pending trades already explain their own part.`, labels: ['Explain part', 'Classify the rest', 'Classify beyond the pending trades'] },
          { t: 'Work down the cards', where: 'The cards above and below', body: `<b>Pending P/L</b>: closed bot trades not yet applied; press ${b('Update Pool')}. <b>Reconciliation</b>: the bot's Exchange reading against the books; green means reconciled, MISMATCH blocks everything until explained. <b>Deposits</b>: ${b('Seen in the exchange')}, then ${b('Admit')}. <b>Withdrawals and payouts</b>: ${b('Approve')}, ${b('Quote')}, ${b('Redeem')}, ${b('Sent from the exchange')}, ${b('Completed')}. <b>Valuation and settlement</b>: the two-month fee.`,
            labels: ['Update Pool', 'Seen in the exchange', 'Admit', 'Approve', 'Quote', 'Redeem', 'Sent from the exchange', 'Completed', 'Withdrawals and payouts', 'Valuation and settlement'] },
        ],
        good: [
          'For a joiner follow the <b>?</b> on <b>Money in</b>; for a payout follow the <b>?</b> on <b>Money out</b>. This page is the checkpoint both of them go through.',
          'The bot\'s trading results never change anyone\'s money by themselves. They wait as Pending P/L until you press Update Pool.',
          'Only the newest confirmed balance counts. A newer one replaces an older one.',
        ],
        refused: [
          ['"No confirmed balance" or "too old"', 'Enter and confirm the balance again.'],
          ['"A trade is still open"', 'Wait until both coins are flat, then enter the balance again.'],
          ['"Unexplained difference"', 'Explain it or classify it, with a written reason (the step above).'],
          ['"Pending P/L … Click Update Pool first"', 'Press Update Pool, then continue.'],
          ['Reconciliation: MISMATCH', 'Do not move money. Find what changed in the exchange that the ledger was not told about.'],
        ],
        labels: [],
      },
    };
  }

  // every button / card name a topic mentions (for the test that checks them against the real screens)
  const labels = (topic, ctx) => { const t = topics(ctx)[topic]; return [...new Set(t.steps.flatMap((s) => s.labels || []))]; };

  // the button that opens it, placed at the top of each tab
  const button = (topic) => `<div class="helprow"><button type="button" class="helpbtn" data-action="help" data-help="${esc(topic)}" aria-haspopup="dialog"><span class="q" aria-hidden="true">?</span> How this works</button></div>`;

  // the modal: same look as the person sheet (modal-bg + sheet), closed by the existing closemodal action
  function sheet(topic, ctx, closeIcon) {
    const t = topics(ctx)[topic]; if (!t) return '';
    const steps = t.steps.map((s, i) => `<li class="hstep"><span class="hnum" aria-hidden="true">${i + 1}</span><div><div class="htitle">${esc(s.t)}</div><div class="hwhere">${esc(s.where)}</div><p class="hbody">${s.body}</p></div></li>`).join('');
    return `<div class="modal-bg" data-action="closemodal"><div class="sheet helpsheet" role="dialog" aria-modal="true" aria-label="How this works: ${esc(t.title)}" data-help="${esc(topic)}">
      <div class="sheet-head"><div><div class="sheet-nm">${esc(t.title)}</div><div class="note">How this works · the ${esc(t.tab)} tab</div></div>
        <button class="iconbtn" data-action="closemodal" aria-label="Close" title="Close">${closeIcon || '×'}</button></div>
      <p class="hintro">${t.intro}</p>
      <div class="hglance" aria-label="The whole flow">${t.glance.map((g, i) => `<span class="hchip">${esc(g)}</span>${i < t.glance.length - 1 ? '<span class="harrow" aria-hidden="true">›</span>' : ''}`).join('')}</div>
      <h3 class="hh">Step by step</h3><ol class="hsteps">${steps}</ol>
      <h3 class="hh">Good to know</h3><ul class="hlist">${t.good.map((g) => `<li>${g}</li>`).join('')}</ul>
      <h3 class="hh">If something is refused</h3><div class="hrefused">${t.refused.map(([a, c]) => `<div class="row"><span class="l">${esc(a)}</span><span class="r note">${esc(c)}</span></div>`).join('')}</div>
      <div class="btns"><button data-action="closemodal" class="full">Got it</button></div></div></div>`;
  }
  const isHelp = (modal) => typeof modal === 'string' && modal.startsWith('help:');
  return { topics, labels, button, sheet, isHelp, TOPIC_IDS: ['dep', 'wd', 'eq'] };
});

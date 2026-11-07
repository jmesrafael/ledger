// "Recent transactions" (js/app.js activityRows): a deposit made in pesos shows the pesos actually paid and the USDT it bought at that rate (not the USDT
// re-converted at today's rate), and an investor never sees the manager's internal notes on the ledger lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('AR1 a peso deposit shows the pesos paid and the USDT they count as, on one line: +₱5,000 ($79.26)', () => {
  assert.match(app, /const paid = l\.kind === 'deposit' && Number\(l\.php_amount\) > 0;/);
  assert.match(app, /const main = paid \? `\+\$\{php\(Number\(l\.php_amount\)\)\} \(\$\$\{f\(Number\(l\.usdt\), 2\)\}\)` : cash/);
  assert.match(app, /if \(!withName\) rows = Contribution\.foldTopups\(rows\);/, 'a peso top-up is folded into its deposit, so the line shows the full USDT');
});

test('AR3 a deposit or payout with no pesos recorded stays in USDT (today\'s pesos are a labelled estimate), so it never reads as pesos paid', () => {
  assert.match(app, /const cash = !paid && \(l\.kind === 'deposit' \|\| l\.kind === 'withdrawal'\);/);
  assert.match(app, /: cash \? \(rate\(\) \? `≈ \$\{php\(Math\.abs\(l\.usdt\) \* rate\(\)\)\} today` : ''\) : alt\(Math\.abs\(l\.usdt\)\);/);
});

test('AR2 the manager\'s notes are not shown to an investor (the manager still sees them)', () => {
  assert.match(app, /const investorView = !withName && S\.me && S\.me\.role === 'investor';/);
  assert.match(app, /l\.note && !investorView \? esc\(l\.note\) : null/);
});

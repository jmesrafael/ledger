// "Recent transactions" (js/app.js activityRows): a deposit made in pesos shows the pesos actually paid and the USDT it bought at that rate (not the USDT
// re-converted at today's rate), and an investor never sees the manager's internal notes on the ledger lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('AR1 a peso deposit shows the pesos paid and the rate it was bought at', () => {
  assert.match(app, /const paid = l\.kind === 'deposit' && Number\(l\.php_amount\) > 0;/);
  assert.match(app, /const main = paid && inPeso\(\) \? '\+' \+ php\(Number\(l\.php_amount\)\) : smoney\(l\.usdt\);/);
  assert.match(app, /\$\{usdt\(l\.usdt\)\} at ₱\$\{f\(Number\(l\.php_amount\) \/ Number\(l\.usdt\), 2\)\}\/USDT/);
});

test('AR2 the manager\'s notes are not shown to an investor (the manager still sees them)', () => {
  assert.match(app, /const investorView = !withName && S\.me && S\.me\.role === 'investor';/);
  assert.match(app, /l\.note && !investorView \? esc\(l\.note\) : null/);
});

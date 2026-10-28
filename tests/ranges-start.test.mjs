// The daily (1D) range on every line chart, and the start date shown for every person. The maths is tested in returns.test.mjs; this checks the screens use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const app = read('js/app.js'), bot = read('bot-dashboard/app.js'), botHtml = read('bot-dashboard/index.html');

test('RS1 the ledger: both line charts (balance and return from trading) use the shared range, 1D first; the button row stays even when a range has no readings', () => {
  assert.match(app, /const RANGES = \[\['1D', 1, 'Past day'\]/);
  assert.match(app, /const rangeStart = \(\) =>/);
  assert.match(app, /const start = rangeStart\(\);/.test(app) ? /./ : /const now = Date\.now\(\), start = rangeStart\(\);/);
  assert.match(app, /Returns\.fromStart\(l\.pts, start\)/);
  assert.match(app, /no readings in this range\.<\/p>\$\{rangeRow\}/);
  assert.equal((app.match(/data-range="\$\{k\}"/g) || []).length, 2, 'balance chart and the return chart (its empty state reuses the same row)');
});

test('RS2 the bot dashboard: 1D / 1W / 1M / 3M / All above the chart, applied to Capital, Performance, R and Drawdown, and remembered', () => {
  for (const d of ['1', '7', '30', '91', '0']) assert.ok(botHtml.includes(`data-range="${d}"`), d);
  assert.ok(botHtml.indexOf('id="rangeTabs"') < botHtml.indexOf('id="chart"'));
  assert.equal((bot.match(/inRange\(/g) || []).length, 5, 'the function and the four charts');
  assert.match(bot, /store\.set\('bot\.range', String\(chartDays\)\)/); assert.match(bot, /\[0, 1, 7, 30, 91\]\.includes\(\+store\.get\('bot\.range'\)\)/);
  assert.match(bot, /for \(const b of \$\$\('#rangeTabs button'\)\)/);
});

test('RS3 start dates: your balance card, the Users list, each person\'s sheet and the fund card all show when it began', () => {
  assert.match(app, /const startOf = \(pid\) => Returns\.firstDeposit\(S\.ledger, pid\);/);
  assert.match(app, /id="gs"[^>]*>Started \$\{startedText\(startOf\(m\.id\)/);
  assert.match(app, /<div class="note">Started \$\{startedText\(startOf\(h\.id\)\)\}<\/div>/);
  assert.match(app, /\$\{line\('Started', startedText\(startOf\(h\.id\)\)\)\}/);
  assert.match(app, /fund started '/);
  assert.match(app, /'No deposit yet'/);
});

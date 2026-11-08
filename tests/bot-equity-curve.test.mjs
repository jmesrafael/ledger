// The Performance card of every bot (live and lab) opens with an equity curve of its closed trades: the running total by R or by P&L, one dot per trade
// at the time it closed, with a range that restarts the curve at 0. Source checks on bot-dashboard/index.html, app.js and style.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL('../bot-dashboard/' + p, import.meta.url), 'utf8');
const html = rd('index.html'), app = rd('app.js'), css = rd('style.css');
const cut = (a, b) => app.slice(app.indexOf(a), app.indexOf(b, app.indexOf(a)));

test('EQ1 the card has the curve, a By R / By P&L switch and its own range, above the numbers', () => {
  const card = html.slice(html.indexOf('id="pPerf"'), html.indexOf('id="pTrend"'));
  for (const t of ['id="eqMetric"', 'data-eqm="r"', 'data-eqm="usd"', 'id="eqRange"', 'data-eqr="7"', 'data-eqr="30"', 'data-eqr="91"', 'data-eqr="0"', 'id="eqChart"', 'id="eqNote"']) assert.ok(card.includes(t), t);
  assert.ok(card.indexOf('id="eqChart"') < card.indexOf('id="perfTiles"'), 'the curve comes first, the tiles under it');
  assert.match(card.split('id="pTrend"')[0], /data-v="bots:performance lab:performance"/, 'every live bot and both labs');
});

test('EQ2 the curve is the running total of the bot\'s closed trades, by R or by dollars, each at its close time; a range restarts it at 0', () => {
  const fn = cut('function renderEquity(v)', 'function renderPeriods(p)');
  assert.match(fn, /v\.trades/, 'the selected bot\'s own trades');
  assert.match(fn, /t\.exit_ts != null/); assert.match(fn, /sort\(\(a, b\) => a\.exit_ts - b\.exit_ts\)/);
  assert.match(fn, /usd \? Number\(t\.usd\) \|\| 0 : Number\(t\.r\)/, 'dollars or R');
  assert.match(fn, /if \(eqMetric === 'usd' && !hasUsd\) eqMetric = 'r'/, 'no dollar figures: it falls back to R and hides the switch');
  assert.match(fn, /const before = trades\.filter\(\(t\) => t\.exit_ts < start\), inside = trades\.filter\(\(t\) => t\.exit_ts >= start\)/);
  assert.match(fn, /\{ ts: from, y: 0, start: true \}/, 'the curve starts at 0');
  assert.match(fn, /cum \+= val\(t\)/);
  assert.match(fn, /ts: t\.exit_ts, y: Math\.round\(cum \* 1e4\) \/ 1e4, t \}/, 'one point per closed trade, at its close time');
  assert.match(fn, /dots: true/); assert.match(fn, /p\.t\.symbol/); assert.match(fn, /p\.t\.reason/, 'hover names the trade: coin, side, exit, result and the total');
});

test('EQ3 wiring: drawn with the Performance card, the switch and range remembered and redraw it, dots are green up and red down', () => {
  assert.match(app, /clear\(\$\('#perfTiles'\)\)\.append\(\.\.\.tiles\);\s*renderEquity\(v\);/);
  assert.match(app, /store\.set\('bot\.eqm', eqMetric\)/); assert.match(app, /store\.set\('bot\.eqr', String\(eqDays\)\)/);
  assert.match(app, /\$\('#eqMetric'\)\.addEventListener\('click'/); assert.match(app, /\$\('#eqRange'\)\.addEventListener\('click'/);
  assert.match(app, /if \(dots && pts\.length <= 250\)/); assert.match(app, /p\.y > pts\[i - 1\]\.y \? 'up' : p\.y < pts\[i - 1\]\.y \? 'down'/);
  assert.match(css, /\.chart circle\.pt\.up \{ fill: var\(--up\); \} \.chart circle\.pt\.down \{ fill: var\(--down\); \}/);
});

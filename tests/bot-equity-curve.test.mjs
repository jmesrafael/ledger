// The Performance card of every bot (live and lab) opens with an equity curve of its closed trades: the running total by R or by P&L, one step per trade at the
// time it closed, drawn as the same plain line as the Overview's capital curve (no dots), with a range that restarts the curve at 0. A bot that shares no balance
// series gets the same curve in its Dashboard chart. Source checks on bot-dashboard/index.html, app.js and style.css.
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
  assert.match(html.slice(html.indexOf('id="pPerf"'), html.indexOf('id="pPerf"') + 120), /data-v="bots:performance lab:performance"/, 'every live bot and both labs');
});

test('EQ2 the curve is the running total of the bot\'s closed trades, by R or by dollars, each at its close time; a range restarts it at 0', () => {
  const fn = cut('const eqTrades = ', 'function renderPeriods(p)');
  assert.match(fn, /drawEquity\(\$\('#eqChart'\), \$\('#eqNote'\), v\.trades,/, 'the selected bot\'s own trades');
  assert.match(fn, /t\.exit_ts != null/); assert.match(fn, /sort\(\(a, b\) => a\.exit_ts - b\.exit_ts\)/);
  assert.match(fn, /usd \? Number\(t\.usd\) \|\| 0 : Number\(t\.r\)/, 'dollars or R');
  assert.match(fn, /if \(eqMetric === 'usd' && !hasUsd\) eqMetric = 'r'/, 'no dollar figures: it falls back to R and hides the switch');
  assert.match(fn, /inside = trades\.filter\(\(t\) => t\.exit_ts >= start\)/);
  assert.match(fn, /\{ ts: from, y: 0 \}/, 'the curve starts at 0');
  assert.match(fn, /cum \+= val\(t\)/);
  assert.match(fn, /ts: t\.exit_ts, y: Math\.round\(cum \* 1e4\) \/ 1e4, t \}/, 'one point per closed trade, at its close time');
  assert.ok(!/dots/.test(fn), 'no dots');
  assert.match(fn, /p\.t\.symbol/); assert.match(fn, /p\.t\.reason/, 'hover names the trade: coin, side, exit, result and the total');
});

test('EQ3 wiring: drawn with the Performance card, the switch and range are remembered and redraw it; no dots anywhere', () => {
  assert.match(app, /clear\(\$\('#perfTiles'\)\)\.append\(\.\.\.tiles\);\s*renderEquity\(v\);/);
  assert.match(app, /store\.set\('bot\.eqm', eqMetric\)/); assert.match(app, /store\.set\('bot\.eqr', String\(eqDays\)\)/);
  assert.match(app, /\$\('#eqMetric'\)\.addEventListener\('click'/); assert.match(app, /\$\('#eqRange'\)\.addEventListener\('click'/);
  assert.ok(!/\bdots\b\s*=\s*false|dots &&|class: `pt /.test(app) && !/circle\.pt/.test(css), 'neither the chart code nor the style has dots');
});

test('EQ4 a bot with no balance series: its Dashboard chart (Balance and Trading only) shows the closed-trades curve instead of "Unavailable"', () => {
  const fn = cut('function renderBotChart()', 'function renderRisk(b)');
  assert.match(fn, /const noSeries = !\(cap && cap\.points && cap\.points\.length\), tr = eqTrades\(b\.trades\);/);
  assert.match(fn, /if \(\(bchartKind === 'balance' \|\| bchartKind === 'perf'\) && noSeries && tr\.length\) \{/);
  assert.match(fn, /drawEquity\(host, note, b\.trades, usd, chartDays, `No balance series from \$\{b\.label\}: its closed trades instead, \$\{usd \? 'by P&L' : 'by R'\}\. `\)/);
  assert.match(fn, /else if \(bchartKind === 'balance'\) \{\s*lineChart\(host, inRange\(cap \? cap\.points/, 'a bot that does share a balance series is unchanged');
  assert.match(fn, /empty: noBal/, 'and with no trades either, the old message stays');
});

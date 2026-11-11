// BROWSER COPY of StrategyBacktester/news-gate/news-gate.js (the bots and the backtest use that one). Keep the logic identical:
// tests/news-lab.test.mjs checks both give the same verdicts. Loads as window.NewsGate in the page and as a CommonJS module in the tests.
(function (root) {
'use strict';
// News gate: one pure function shared by the backtest (research/news-lab), the live signal API
// (crypto-news /api/signal) and the news paper bots. It can only VETO or SHRINK a new entry — it never opens trades.
//
//   gate(ctx, cfg) -> { allow: boolean, size: 1 | 0.5, reasons: string[] }
//   ctx = { t, coin, dir, events, fngAt, btcChange24h, hacks }
//     t             entry time, unix seconds
//     coin          'SOL' | 'ZEC' | 'NEAR' | 'ADA' | 'GALA' | ...
//     dir           1 = long, -1 = short
//     events        [{ name, t }] USD high-impact calendar events (unix s), sorted by t
//     fngAt(t)      Fear & Greed value (0-100) known at time t, or null
//     btcChange24h  BTC % change over the 24h before t, or null
//     hacks         [{ t, amount, chains: [], name }] (t = time the hack was public), sorted by t
// Rules only use information available at time t (calendar dates are published in advance).

const BLACKOUT_NAMES = [/^CPI m\/m$/, /^Core CPI m\/m$/, /^Non-Farm Employment Change$/, /^Federal Funds Rate$/, /^FOMC Statement$/, /^Core PCE Price Index m\/m$/, /^PPI m\/m$/];
const COIN_CHAIN = { SOL: /^Solana$/i, NEAR: /^Near$/i, ADA: /^Cardano$/i, ZEC: /^Zcash$/i };
const COIN_NAME = { GALA: /\bgala\b/i };

const DEFAULTS = {
  blackout: { on: true, preH: 8, postH: 0 },            // no new entries in the 8h BEFORE CPI / NFP / FOMC / PCE / PPI (entries after the release are fine: backtest Nov 11 2026)
  fng: { on: false, mode: 'contrarian', lo: 20, hi: 80 }, // contrarian: no longs when F&G >= hi, no shorts when F&G <= lo
  crash: { on: false, pct: 5, action: 'skip' },          // no longs when BTC fell > pct% in 24h, no shorts when it rose > pct%
  hack: { on: true, coinHours: 72, coinMinUsd: 1e6, marketHours: 48, marketMinUsd: 1e15 }, // no longs within 72h of a $1M+ hack on the coin's own chain (market-wide part off: 1e15 = never)
};

function lowerBound(arr, t) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; } return lo; }

function gate(ctx, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const reasons = [];
  let size = 1;
  const { t, coin, dir } = ctx;

  if (c.blackout && c.blackout.on && ctx.events) {
    const from = t - c.blackout.postH * 3600, to = t + c.blackout.preH * 3600;
    for (let i = lowerBound(ctx.events, from); i < ctx.events.length && ctx.events[i].t <= to; i++) {
      const e = ctx.events[i];
      if (BLACKOUT_NAMES.some((re) => re.test(e.name))) { reasons.push(`blackout: ${e.name} ${e.t > t ? 'in' : ''} ${Math.round(Math.abs(e.t - t) / 360) / 10}h${e.t > t ? '' : ' ago'}`); break; }
    }
  }

  if (c.fng && c.fng.on && ctx.fngAt) {
    const v = ctx.fngAt(t);
    if (v != null) {
      const contrarian = c.fng.mode !== 'trend';
      if (contrarian ? (dir === 1 && v >= c.fng.hi) : (dir === 1 && v <= c.fng.lo)) reasons.push(`fear&greed ${v}: no longs`);
      if (contrarian ? (dir === -1 && v <= c.fng.lo) : (dir === -1 && v >= c.fng.hi)) reasons.push(`fear&greed ${v}: no shorts`);
    }
  }

  if (c.crash && c.crash.on && ctx.btcChange24h != null) {
    const ch = ctx.btcChange24h;
    const hit = (dir === 1 && ch <= -c.crash.pct) || (dir === -1 && ch >= c.crash.pct);
    if (hit) {
      if (c.crash.action === 'half') size = Math.min(size, 0.5);
      else reasons.push(`BTC ${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% in 24h`);
    }
  }

  if (c.hack && c.hack.on && ctx.hacks && dir === 1) {
    const horizon = Math.max(c.hack.coinHours, c.hack.marketHours) * 3600;
    for (let i = lowerBound(ctx.hacks, t - horizon); i < ctx.hacks.length && ctx.hacks[i].t <= t; i++) {
      const h = ctx.hacks[i], age = t - h.t;
      const onCoin = (COIN_CHAIN[coin] && (h.chains || []).some((ch) => COIN_CHAIN[coin].test(ch))) || (COIN_NAME[coin] && COIN_NAME[coin].test(h.name || ''));
      if (onCoin && age <= c.hack.coinHours * 3600 && (h.amount || 0) >= c.hack.coinMinUsd) { reasons.push(`hack on ${coin}: ${h.name}`); break; }
      if (age <= c.hack.marketHours * 3600 && (h.amount || 0) >= c.hack.marketMinUsd) { reasons.push(`market hack: ${h.name} $${Math.round(h.amount / 1e6)}M`); break; }
    }
  }

  return { allow: reasons.length === 0, size: reasons.length ? 0 : size, reasons };
}

const api = { gate, DEFAULTS, BLACKOUT_NAMES };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NewsGate = api;
})(typeof window !== 'undefined' ? window : globalThis);

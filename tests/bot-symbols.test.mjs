// The bot trades four coins (SOL, ZEC, NEAR, ADA). Migration 20261116000000_bot_events_more_symbols.sql widens the symbol check on bot_events,
// and lib/schema.js (what the website accepts) must name exactly the same symbols. Run on the real SQL in an in-memory Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const schema = require('../lib/schema.js');
const sql = (dir, f) => { const a = new URL(`../supabase/${dir}/applied/${f}`, import.meta.url); return readFileSync(existsSync(a) ? a : new URL(`../supabase/${dir}/${f}`, import.meta.url), 'utf8'); };
const BASE = '20261111000000_bot_events.sql', MORE = '20261116000000_bot_events_more_symbols.sql', BACK = '20261116000000_rollback_bot_events_more_symbols.sql';
const NEW_SYMBOLS = ['SOL_USDT', 'ZEC_USDT', 'NEAR_USDT', 'ADA_USDT'];

async function fresh() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated;');
  await db.exec(sql('migrations', BASE));
  return db;
}
let n = 0;
const put = (db, symbol) => db.query(`insert into public.bot_events(event_id, type, ts_ms, mode, symbol, side, data) values ($1, 'exit', 1792800000000, 'paper', $2, 'LONG', '{}'::jsonb)`, [`sym-test-${++n}`, symbol]);

test('before the migration the table only knows SOL and ZEC (so the migration is needed)', async () => {
  const db = await fresh();
  await put(db, 'SOL_USDT'); await put(db, 'ZEC_USDT');
  await assert.rejects(put(db, 'NEAR_USDT'), /check/i);
  await assert.rejects(put(db, 'ADA_USDT'), /check/i);
});

test('after the migration NEAR and ADA are stored; BTC and junk are still refused; no symbol (heartbeats) is still fine', async () => {
  const db = await fresh();
  await db.exec(sql('migrations', MORE));
  for (const s of NEW_SYMBOLS) await put(db, s);
  await put(db, null);
  for (const bad of ['BTC_USDT', 'ETH_USDT', 'near_usdt', 'NEAR', '']) await assert.rejects(put(db, bad), /check/i, `${JSON.stringify(bad)} must be refused`);
  assert.equal((await db.query('select count(*)::int as c from public.bot_events')).rows[0].c, NEW_SYMBOLS.length + 1);
});

test('the migration is safe to run twice and keeps the rows that already exist', async () => {
  const db = await fresh();
  await put(db, 'SOL_USDT');
  await db.exec(sql('migrations', MORE)); await db.exec(sql('migrations', MORE));
  assert.equal((await db.query(`select count(*)::int as c from public.bot_events where symbol = 'SOL_USDT'`)).rows[0].c, 1);
  await put(db, 'ADA_USDT');
});

test('it refuses to run before the base bot_events migration (nothing is changed)', async () => {
  const db = new PGlite();
  await assert.rejects(db.exec(sql('migrations', MORE)), /preflight/);
});

test('the rollback restores the two-coin check, and refuses while NEAR or ADA rows exist (no silent data loss)', async () => {
  const db = await fresh();
  await db.exec(sql('migrations', MORE));
  await put(db, 'NEAR_USDT');
  await assert.rejects(db.exec(sql('rollback', BACK)), /check/i);
  await db.exec(`delete from public.bot_events where symbol in ('NEAR_USDT','ADA_USDT')`);
  await db.exec(sql('rollback', BACK));
  await put(db, 'SOL_USDT');
  await assert.rejects(put(db, 'NEAR_USDT'), /check/i);
});

test('the website schema (lib/schema.js) and the database check name exactly the same symbols', () => {
  const m = sql('migrations', MORE).match(/symbol in \(([^)]*)\)/);
  assert.ok(m, 'the migration has a symbol list');
  const inDb = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual([...inDb].sort(), [...schema.ALLOWED_SYMBOLS].sort());
  assert.deepEqual([...schema.ALLOWED_SYMBOLS].sort(), [...NEW_SYMBOLS].sort());
});

test('the website accepts a four-coin heartbeat and exits for the new coins, and still refuses BTC', () => {
  const base = { ts_ms: 1792800000000, mode: 'paper' };
  for (const s of NEW_SYMBOLS) assert.ok(schema.validateEvent({ event_id: `site-test-${s}-0001`, type: 'exit', symbol: s, side: 'SHORT', ...base, data: { r: -1, usd: -1 } }).ok, s);
  assert.equal(schema.validateEvent({ event_id: 'site-test-btc-0001', type: 'exit', symbol: 'BTC_USDT', side: 'SHORT', ...base, data: {} }).ok, false);
  const prices = Object.fromEntries(NEW_SYMBOLS.map((s) => [s, { px: 1, candle_ms: base.ts_ms }]));
  assert.ok(schema.validateEvent({ event_id: 'site-test-heartbeat-1', type: 'heartbeat', ...base, data: { prices, enabled_coins: NEW_SYMBOLS } }).ok);
});

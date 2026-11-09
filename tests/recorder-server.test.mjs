// The data recorder's heartbeat carries the machine's numbers (CPU load, memory, which bot processes run) in a "server" section, and the System Monitor shows them.
// Numbers only; a figure the recorder cannot read stays Unavailable, never zero. Server side: lib/schema.js, lib/aggregate.js; page: bot-dashboard/app.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../lib/schema.js'), { aggregate } = require('../lib/aggregate.js');
const app = readFileSync(new URL('../bot-dashboard/app.js', import.meta.url), 'utf8');
const NOW = 1794262800000;
const hb = (data) => ({ event_id: 'rec|hb:1794262800', type: 'heartbeat', ts_ms: NOW, mode: 'paper', bot: 'recorder', data });
const SERVER = { load_1m: 0.13, load_5m: 0.03, load_15m: 0.01, cpus: 1, vps_uptime_sec: 1079352, mem_total_mb: 1673, mem_used_mb: 655, swap_used_mb: 1, svc_bbcore: 1, svc_icore: 1, svc_tcore: 1, svc_bb1h: 1, svc_recorder: 1, svc_shadow: 0 };

test('RS1 the server section is accepted and stored as numbers; names and values are checked; anything else is dropped', () => {
  const ok = schema.validateEvent(hb({ recorder: { disk_free_gb: 11.7 }, server: SERVER }));
  assert.equal(ok.ok, true); assert.deepEqual(ok.event.data.server, SERVER);
  assert.equal(schema.validateEvent(hb({ server: { load_1m: 'high' } })).ok, false, 'a number is a number');
  assert.equal(schema.validateEvent(hb({ server: { 'Bad Name': 1 } })).ok, false, 'names are short lower-case words');
  assert.equal(schema.validateEvent(hb({ server: Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['k' + i, i])) })).ok, false, 'at most 24 values');
  assert.equal(schema.validateEvent(hb({ server: { path: '/opt/lucidio' } })).ok, false, 'no text can ride in it');
  assert.equal(schema.validateEvent(hb({ logs: 'x', cmdline: 'node /opt/x' })).event.data.logs, undefined, 'unknown keys are dropped, never stored');
});

test('RS2 the dashboard data hands the section to the page; with none (an older recorder) it is empty, not zero', () => {
  const d = aggregate({ now: NOW + 60000, recorderHeartbeat: { ts_ms: NOW, data: { recorder: { disk_free_gb: 11.7 }, server: SERVER } } });
  assert.deepEqual(d.recorder.server, SERVER); assert.equal(d.recorder.health.disk_free_gb, 11.7);
  assert.deepEqual(aggregate({ now: NOW + 60000, recorderHeartbeat: { ts_ms: NOW, data: { recorder: {} } } }).recorder.server, {});
  assert.equal(aggregate({ now: NOW }).recorder, null, 'no heartbeat: the recorder is missing');
});

test('RS3 the System Monitor shows CPU, memory, services, disk and the recorder\'s exchange errors from it; logs stay unsent; a missing figure is Unavailable', () => {
  const i = app.indexOf('const h = rc && rc.health || {}, sv = rc && rc.server || {}'), fn = app.slice(i, app.indexOf('renderSysLog();', i));
  for (const t of ["kv('CPU load now'", "kv('Memory in use now'", "kv('Running services'", "kv('Disk free'", "kv('Exchange API errors'", "kv('Server logs'"]) assert.ok(fn.includes(t), t);
  assert.match(fn, /const SVC = \[\['svc_bbcore', 'BB-Core'\], \['svc_icore', 'I-Core'\], \['svc_tcore', 'T-CORE'\], \['svc_bb1h', 'BB-1h lab'\], \['svc_recorder', 'Recorder'\]\]\.filter\(\(\[k\]\) => has\(k\)\)/);
  assert.match(fn, /!has\('load_1m'\) \? na\(/); assert.match(fn, /memPct == null \? na\(/); assert.match(fn, /SVC\.length \? el\('span'/); assert.match(fn, /h\.errors_1h == null \? na\(/);
  assert.match(fn, /kv\('Server logs', na\('Logs are never sent/);
  assert.ok(!/The VPS does not report/.test(app), 'the old "not reported" lines are gone');
});

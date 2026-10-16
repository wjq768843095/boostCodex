'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const source = fs.readFileSync(path.join(__dirname, '../src/backend/boost-codex.cjs'), 'utf8');
const start = source.indexOf('function finiteNumber(value) {');
const end = source.indexOf('function refreshCodexUsage()', start);
assert(start >= 0 && end > start);
const window = { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1791964946 };
const legacy = { rateLimits: { planType: 'pro', primary: window, secondary: null } };
function load(spawn = () => { throw Error('unexpected spawn'); }) {
  const context = vm.createContext({ Buffer, setTimeout, clearTimeout, coreVersion: 'fixture', import_node_child_process11: { spawn } });
  vm.runInContext(source.slice(start, end), context);
  return context;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function fixture(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  let input = '';
  const messages = [];
  child.stdin.on('data', chunk => {
    input += chunk;
    const lines = input.split('\n'); input = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line); messages.push(message);
      onMessage(message, child, messages);
    }
  });
  child.reply = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); };
  return { child, messages, api: load(() => child) };
}
async function main() {
  const api = load();
  const expected = { planType: 'pro', primary: { ...window, remainingPercent: 77 }, secondary: null };
  assert.deepEqual(plain(api.normalizeCodexUsage(legacy)), expected);
  assert.deepEqual(plain(api.normalizeCodexUsage({ rateLimitsByLimitId: { base_model_inference: { primary: { ...window, usedPercent: 99 } }, codex: legacy.rateLimits } })), expected);
  assert.equal(api.normalizeCodexUsage({ rateLimitsByLimitId: { base_model_inference: legacy.rateLimits } }), null, 'another model bucket must not represent Codex account usage');
  const newer = { ...legacy.rateLimits, primary: { ...window, usedPercent: 42 } };
  assert.equal(api.normalizeCodexUsage({ ...legacy, rateLimitsByLimitId: { codex: newer } }).primary.usedPercent, 42, 'prefer the current per-limit Codex bucket');
  assert.deepEqual(plain(api.normalizeCodexUsage({ ...legacy, rateLimitsByLimitId: { codex: { primary: null } } })), expected, 'retain legacy fallback for incomplete new responses');
  for (const invalid of [null, undefined, '', ' ', false]) assert.equal(api.normalizeWindow({ ...window, usedPercent: invalid }), null, 'missing percentages are unavailable');
  assert.equal(api.normalizeWindow({ ...window, usedPercent: 120 }).remainingPercent, 0);
  assert.equal(api.normalizeWindow({ ...window, usedPercent: -2 }).remainingPercent, 100);
  assert.equal(api.normalizeWindow({ ...window, windowDurationMins: 0 }), null);
  let acknowledged = false;
  const success = fixture((message, child, messages) => {
    if (message.method === 'initialize') {
      assert.equal(messages.length, 1);
      setImmediate(() => {
        assert.equal(messages.length, 1, 'wait for initialize response before sending other messages');
        acknowledged = true;
        child.reply({ method: 'notification', params: {} });
        child.reply({ id: 1, result: { serverInfo: { version: 'fixture' } } });
      });
    } else {
      assert(acknowledged);
      if (message.method === 'account/rateLimits/read') {
        assert.equal(messages[1].method, 'initialized');
        child.stdout.write('malformed ignored\n');
        const reply = JSON.stringify({ id: 2, result: { rateLimitsByLimitId: { codex: legacy.rateLimits } } });
        child.stdout.write(reply.slice(0, 25)); child.stdout.write(reply.slice(25) + '\n');
      }
    }
  });
  assert.deepEqual(plain(await success.api.queryCodexUsage('fixture')), expected);
  assert.equal(success.child.killed, true);
  const failedInit = fixture((message, child) => { if (message.method === 'initialize') setImmediate(() => child.reply({ id: 1, error: { message: 'denied' } })); });
  await assert.rejects(failedInit.api.queryCodexUsage('fixture'), /codex_usage_initialize_failed/);
  assert.equal(failedInit.messages.length, 1);
  const earlyExit = fixture((message, child) => { if (message.method === 'initialize') setImmediate(() => child.emit('close', 1)); });
  await assert.rejects(earlyExit.api.queryCodexUsage('fixture'), /codex_usage_process_closed/);
  const failedRead = fixture((message, child) => {
    if (message.method === 'initialize') setImmediate(() => child.reply({ id: 1, result: {} }));
    if (message.method === 'account/rateLimits/read') setImmediate(() => child.reply({ id: 2, error: { message: 'unavailable' } }));
  });
  await assert.rejects(failedRead.api.queryCodexUsage('fixture'), /codex_usage_request_failed/);
  console.log('codex usage compatibility and initialization checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

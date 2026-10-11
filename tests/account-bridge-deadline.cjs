'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backend = fs.readFileSync(path.join(__dirname, '../src/backend/better-codex.cjs'), 'utf8');
const start = backend.indexOf('async function bridgeRequest(');
const end = backend.indexOf('\nasync function cdpJson(', start);
assert(start >= 0 && end > start, 'the real bridgeRequest must be available');
const bridgeSource = backend.slice(start, end);
const endpoint = '/api/dev/account-metadata';
const plain = value => JSON.parse(JSON.stringify(value));

// Only virtual timers and a fake local HTTP peer are used. AbortController and
// AbortSignal are real, so the bridge's actual abort/error path is exercised.
function fixture(delay = Infinity, status = 200, body = { metadata: true }) {
  let now = 0, sequence = 0;
  const timers = new Map(), requests = [], resolved = [], deadlines = [];
  const connection = {}, token = 'isolated-deadline-fixture-token';
  const schedule = (fn, ms) => {
    const id = ++sequence;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const context = vm.createContext({
    Error,
    cdpCommandTimeoutMs: 8000,
    import_node_crypto3: { randomUUID: () => 'deadline-fixture-trace' },
    AbortSignal: {
      timeout(ms) {
        deadlines.push(ms);
        const controller = new AbortController();
        schedule(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
        return controller.signal;
      }
    },
    fetch(url, options) {
      assert(url.startsWith('http://127.0.0.1:41731/api/'), 'the fixture must stay on the local runtime');
      assert(options.signal instanceof AbortSignal, 'timeout must yield a real AbortSignal');
      const request = { signal: options.signal, socketDestroyed: false, aborts: 0 };
      requests.push(request);
      return new Promise((resolve, reject) => {
        let settled = false, timer;
        const cleanup = () => { settled = true; timers.delete(timer); options.signal.removeEventListener('abort', abort); };
        const abort = () => {
          if (settled) return;
          request.aborts++; request.socketDestroyed = true;
          cleanup(); reject(options.signal.reason);
        };
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) return abort();
        if (Number.isFinite(delay)) timer = schedule(() => {
          cleanup(); resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
        }, delay);
      });
    },
    async evaluate(actualConnection, expression) {
      assert.equal(actualConnection, connection);
      vm.runInNewContext(expression, { window: { __betterCodexBridgeResolve: (id, result) => resolved.push({ id, result: plain(result) }) } });
    }
  });
  vm.runInContext(bridgeSource, context);
  function begin(route = endpoint, method = 'POST') {
    return context.bridgeRequest(connection, 41731, token, JSON.stringify({
      id: 'deadline-fixture-request', token, path: route, method,
      timeoutMs: 999999, body: method === 'POST' ? '{}' : undefined
    }));
  }
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
      // Flush the fetch -> JSON -> renderer promise chain without sleeping.
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }
  return { begin, advance, requests, resolved, deadlines };
}

(async () => {
  const slowSuccess = fixture(9000), success = slowSuccess.begin(endpoint + '?locale=zh-CN');
  assert.deepEqual(slowSuccess.deadlines, [15000]);
  await slowSuccess.advance(8000);
  assert.equal(slowSuccess.requests[0].signal.aborted, false, 'the old 8s deadline must not interrupt metadata');
  assert.equal(slowSuccess.resolved.length, 0);
  await slowSuccess.advance(1000); await success;
  assert.deepEqual(slowSuccess.resolved[0].result, { ok: true, status: 200, value: { metadata: true } });
  assert.equal(slowSuccess.requests[0].socketDestroyed, false);

  const upstream = fixture(12000, 502, { error: 'ACCOUNT_METADATA_TIMEOUT' }), denied = upstream.begin();
  await upstream.advance(12000); await denied;
  const upstreamResult = upstream.resolved[0].result;
  assert.equal(upstreamResult.ok, false);
  assert.equal(upstreamResult.status, 502, 'the upstream safe HTTP error must reach the renderer');
  assert.equal(upstreamResult.value.error, 'ACCOUNT_METADATA_TIMEOUT');
  assert.equal(upstreamResult.value.diagnostics.http_status, 502);
  assert.equal(upstreamResult.value.diagnostics.failure_type, undefined);
  assert.equal(JSON.stringify(upstreamResult).includes('isolated-deadline-fixture-token'), false);
  assert.equal(upstream.requests[0].signal.aborted, false);

  const stalled = fixture(), expired = stalled.begin();
  await stalled.advance(14999);
  assert.equal(stalled.requests[0].signal.aborted, false);
  assert.equal(stalled.resolved.length, 0);
  await stalled.advance(1); await expired;
  assert.equal(stalled.requests[0].signal.aborted, true);
  assert.equal(stalled.requests[0].signal.reason.name, 'TimeoutError');
  assert.equal(stalled.requests[0].socketDestroyed, true, 'the fake HTTP peer must destroy its socket on abort');
  assert.equal(stalled.requests[0].aborts, 1);
  assert.equal(stalled.resolved[0].result.status, 0);
  assert.equal(stalled.resolved[0].result.value.diagnostics.failure_type, 'transport');
  await stalled.advance(10000);
  assert.equal(stalled.resolved.length, 1, 'expiry must resolve the renderer only once');

  const cancel = fixture(), cancelled = cancel.begin(endpoint + '/cancel?locale=zh-CN');
  assert.deepEqual(cancel.deadlines, [5000]);
  await cancel.advance(4999); assert.equal(cancel.requests[0].signal.aborted, false);
  await cancel.advance(1); await cancelled;
  assert.equal(cancel.requests[0].socketDestroyed, true);
  assert.equal(cancel.resolved[0].result.status, 0);

  const ordinary = fixture(), unchanged = ordinary.begin('/api/account/usage', 'GET');
  assert.deepEqual(ordinary.deadlines, [8000], 'other endpoints retain the ordinary bridge deadline');
  await ordinary.advance(8000); await unchanged;
  assert.equal(ordinary.requests[0].signal.aborted, true);
  console.log('account bridge deadlines: virtual 9s success, 12s safe error, 15s abort cleanup, 5s cancellation and unchanged ordinary timeout passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

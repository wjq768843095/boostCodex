'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../integration/runtime-api.cjs'), 'utf8');
const transportPath = '../src/modules/account-metadata-transport.cjs';
const endpoint = '/api/dev/account-metadata';
const input = () => ({ requestId: randomUUID(), accountId: 'personal-account', userId: 'native-user' });
const metadata = () => ({
  accounts: { default: {
    account: { account_id: 'personal-account', account_user_id: 'membership-id', account_user_role: 'owner', structure: 'personal', plan_type: 'plus', is_zdr: false, is_deactivated: true },
    can_access_with_session: false, features: ['future-feature'], entitlement: null, subscriptions: [{ status: 'active' }], permissions: { unknown_permission: false }
  } }, account_ordering: ['default'], future_field: { untouched: true }
});
const codeError = code => Object.assign(new Error('raw private diagnostic must stay local'), { code, statusCode: 403, headers: { Authorization: 'Bearer fixture-secret' }, body: 'fixture-secret', cause: new Error('fixture-secret') });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const calls = [];
  const config = { mode: 'deferred' };
  const fetchAccountMetadata = parameters => {
    const call = { parameters, socket: { destroyed: false, destroy() { this.destroyed = true; } }, aborted: false };
    calls.push(call);
    return new Promise((resolve, reject) => {
      const cleanup = () => parameters.signal.removeEventListener('abort', abort);
      call.resolve = value => { cleanup(); resolve(value); };
      call.reject = error => { cleanup(); reject(error); };
      const abort = () => { call.aborted = true; call.socket.destroy(); call.reject(codeError('ACCOUNT_METADATA_ABORTED')); };
      parameters.signal.addEventListener('abort', abort, { once: true });
      if (parameters.signal.aborted) return abort();
      if (config.mode === 'success') call.resolve(metadata());
      if (config.mode === 'error') call.reject(config.error);
    });
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, AbortController,
    process: { env: { BOOST_CODEX_LOCAL_PROJECT: path.join(__dirname, '..') } },
    require(name) {
      if (name === transportPath) return { fetchAccountMetadata };
      assert.ok(['node:fs', 'node:path'].includes(name), `unexpected module ${name}`);
      return require(name);
    }
  };
  vm.runInNewContext(source, sandbox, { filename: path.join(__dirname, '../integration/runtime-api.cjs') });
  const handle = module.exports.handle;
  function start(body, route = endpoint, options = {}) {
    const request = new EventEmitter();
    request.aborted = !!options.requestAborted;
    const response = new EventEmitter();
    response.writableEnded = false; response.destroyed = !!options.destroyed;
    const writes = [], bodyLimits = [];
    const pending = handle({
      url: new URL(route, 'http://127.0.0.1:34567'), method: options.method || 'POST', request, response,
      worker: {}, stopHost() { throw new Error('metadata must not affect the session host'); },
      async readBody(actualRequest, limit) { assert.equal(actualRequest, request); bodyLimits.push(limit); options.onRead?.(response, request); return body; },
      sendJson(actualResponse, status, value) {
        assert.equal(actualResponse, response);
        assert.equal(response.destroyed, false, 'must not write to disconnected clients');
        writes.push({ status, value }); response.writableEnded = true;
      }
    });
    return { request, response, writes, bodyLimits, pending, async result() { assert.equal(await pending, true); assert.equal(writes.length, 1); return writes[0]; } };
  }
  return { calls, config, start };
}

(async () => {
  const success = fixture(); success.config.mode = 'success';
  const body = input(), completed = success.start(body);
  const result = await completed.result();
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), metadata(), 'the full response, membership denial and deactivation survive unchanged');
  assert.equal(success.calls.length, 1);
  assert.deepEqual(Object.keys(success.calls[0].parameters).sort(), ['accountId', 'signal', 'userId']);
  assert.equal(success.calls[0].parameters.accountId, body.accountId);
  assert.equal(success.calls[0].parameters.userId, body.userId);
  assert.equal(success.calls[0].parameters.signal.aborted, false);
  assert.deepEqual(completed.bodyLimits, [4096]);
  assert.equal(completed.response.listenerCount('close'), 0, 'completion removes the disconnect listener');
  completed.response.emit('close');
  assert.equal(success.calls[0].parameters.signal.aborted, false, 'closing a completed response does not abort the finished operation');

  const cancellationFirst = fixture(); const cancelledBody = input();
  const cancelled = await cancellationFirst.start({ requestId: cancelledBody.requestId }, `${endpoint}/cancel`).result();
  assert.equal(cancelled.status, 200); assert.equal(cancelled.value.cancelled, true);
  const cancelAgain = await cancellationFirst.start({ requestId: cancelledBody.requestId }, `${endpoint}/cancel`).result();
  assert.equal(cancelAgain.status, 200); assert.equal(cancelAgain.value.cancelled, true, 'repeated cancellation is idempotent');
  const prevented = await cancellationFirst.start(cancelledBody).result();
  assert.equal(prevented.status, 409); assert.equal(prevented.value.error, 'ACCOUNT_METADATA_ABORTED');
  assert.equal(cancellationFirst.calls.length, 0, 'an early cancellation prevents the transport from starting');

  const inflight = fixture(); const inFlightBody = input(); const running = inflight.start(inFlightBody);
  await tick(); assert.equal(inflight.calls.length, 1);
  const cancelResult = await inflight.start({ requestId: inFlightBody.requestId }, `${endpoint}/cancel`).result();
  assert.equal(cancelResult.status, 200);
  const stopped = await running.result();
  assert.equal(stopped.status, 409); assert.equal(stopped.value.error, 'ACCOUNT_METADATA_ABORTED');
  assert.equal(inflight.calls[0].parameters.signal.aborted, true);
  assert.equal(inflight.calls[0].socket.destroyed, true, 'in-flight cancellation reaches the transport socket cleanup');
  assert.equal(running.response.listenerCount('close'), 0);
  // Both the active-request entry and the consumed cancellation entry are released.
  inflight.config.mode = 'success'; assert.equal((await inflight.start(inFlightBody).result()).status, 200);

  const disconnect = fixture(); const gone = disconnect.start(input()); await tick();
  gone.response.destroyed = true; gone.response.emit('close');
  assert.equal(await gone.pending, true);
  assert.equal(disconnect.calls[0].parameters.signal.aborted, true);
  assert.equal(disconnect.calls[0].socket.destroyed, true);
  assert.equal(gone.writes.length, 0, 'disconnected clients receive no error write');
  assert.equal(gone.response.listenerCount('close'), 0);
  for (const options of [
    { destroyed: true },
    { requestAborted: true },
    { onRead(response) { response.destroyed = true; response.emit('close'); } }
  ]) {
    const preDisconnected = fixture(); const goneBeforeRegistration = preDisconnected.start(input(), endpoint, options);
    assert.equal(await goneBeforeRegistration.pending, true);
    assert.equal(preDisconnected.calls.length, 0, 'a disconnect before listener registration must never start the transport');
    assert.equal(goneBeforeRegistration.writes.length, 0);
    assert.equal(goneBeforeRegistration.response.listenerCount('close'), 0);
  }

  const duplicate = fixture(); const duplicateBody = input(); const first = duplicate.start(duplicateBody); await tick();
  const repeated = await duplicate.start(duplicateBody).result();
  assert.equal(repeated.status, 429); assert.equal(repeated.value.error, 'ACCOUNT_METADATA_BUSY');
  assert.equal(duplicate.calls.length, 1, 'duplicate IDs cannot start a second request');
  duplicate.calls[0].resolve(metadata()); assert.equal((await first.result()).status, 200);
  duplicate.config.mode = 'success'; assert.equal((await duplicate.start(duplicateBody).result()).status, 200, 'success releases the active request ID');

  const concurrency = fixture();
  const active = Array.from({ length: 4 }, () => concurrency.start(input())); await tick();
  assert.equal(concurrency.calls.length, 4);
  const saturated = await concurrency.start(input()).result();
  assert.equal(saturated.status, 429); assert.equal(saturated.value.error, 'ACCOUNT_METADATA_BUSY'); assert.equal(concurrency.calls.length, 4);
  concurrency.calls[0].resolve(metadata()); assert.equal((await active[0].result()).status, 200);
  const replacement = concurrency.start(input()); await tick(); assert.equal(concurrency.calls.length, 5, 'finishing one operation opens exactly one slot');
  for (let i = 1; i < concurrency.calls.length; i++) concurrency.calls[i].resolve(metadata());
  await Promise.all([...active.slice(1), replacement].map(entry => entry.result()));

  for (const code of ['ACCOUNT_METADATA_HTTP_DENIED', 'ACCOUNT_METADATA_AUTH_CHANGED', 'ACCOUNT_METADATA_WORKSPACE_POLICY', 'ACCOUNT_METADATA_TIMEOUT', 'ACCOUNT_METADATA_ABORTED']) {
    const failure = fixture(); failure.config.mode = 'error'; failure.config.error = codeError(code);
    const failed = failure.start(input()); const safe = await failed.result();
    assert.equal(safe.status, code === 'ACCOUNT_METADATA_ABORTED' ? 409 : 502);
    assert.equal(JSON.stringify(safe.value), JSON.stringify({ error: code }), 'only the approved safe code reaches the client');
    assert.equal(failed.response.listenerCount('close'), 0);
    failure.config.mode = 'success'; assert.equal((await failure.start(input()).result()).status, 200, 'failure releases its concurrency slot');
  }
  for (const error of [new Error('Bearer fixture-secret'), codeError('ECONNRESET'), codeError('ACCOUNT_METADATA_AUTH_FAILED\nfixture-secret'), { code: null, headers: { Authorization: 'fixture-secret' } }]) {
    const failure = fixture(); failure.config.mode = 'error'; failure.config.error = error;
    const safe = await failure.start(input()).result();
    assert.equal(safe.status, 502); assert.equal(JSON.stringify(safe.value), '{"error":"ACCOUNT_METADATA_FAILED"}');
  }
  const invalid = fixture();
  for (const body of [null, {}, { ...input(), requestId: 'unsafe-id' }, { ...input(), url: 'https://untrusted.example/' }, { ...input(), token: 'fixture-secret' }]) {
    const rejected = await invalid.start(body).result(); assert.equal(rejected.status, 400); assert.equal(rejected.value.error, 'ACCOUNT_METADATA_INPUT_INVALID');
  }
  assert.equal(invalid.calls.length, 0);
  const badCancellation = await invalid.start({ requestId: 'unsafe-id' }, `${endpoint}/cancel`).result();
  assert.equal(badCancellation.status, 400);
  for (const [route, method] of [[endpoint, 'GET'], [`${endpoint}/cancel`, 'GET'], [`${endpoint}/other`, 'POST']]) {
    const ignored = invalid.start(input(), route, { method }); assert.equal(await ignored.pending, false); assert.equal(ignored.writes.length, 0);
  }
  console.log('account metadata runtime API: early/in-flight cancellation, disconnect cleanup, duplicate/concurrency limits, complete JSON and safe errors passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

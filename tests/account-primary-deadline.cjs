'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getEventListeners } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/native-conversation-adapter.js'), 'utf8');
const route = '/accounts/check/{version}';
const metadata = () => ({ account_ordering: ['default'], accounts: { default: {
  account: { account_id: 'fixture-account', account_user_id: 'fixture-member', account_user_role: 'standard-user', structure: 'personal', plan_type: 'plus', is_zdr: true },
  can_access_with_session: false
} } });
const policyError = status => Object.assign(new Error('fixture policy denial'), { status, errorCode: status === 403 ? 'ip_not_authorized' : 'unauthorized' });

function fixture({ identity = { accountId: 'fixture-account', userId: 'fixture-user' }, abortError, deferAbort = false } = {}) {
  let now = 0, nextTimer = 0, nativePending, nativeSettled = false;
  const timers = new Map(), scheduled = [], calls = [], bridgeCalls = [];
  const clock = {
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); scheduled.push(ms); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
        for (let i = 0; i < 6; i++) await Promise.resolve();
      }
      now = until;
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
  };
  const context = vm.createContext({ URL, DOMException, AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(source, context);
  const controller = new AbortController();
  let assertions = 0;
  const options = {
    parameters: { path: { version: 'v4-2023-04-27' } },
    additionalHeaders: { 'ChatGPT-Account-ID': 'fixture-account', 'OAI-Language': 'zh-CN' },
    expectedIdentity: { accountId: 'fixture-account', userId: 'fixture-user' },
    expectedErrorStatuses: [401, 403], signal: controller.signal,
    assertRequestCurrent() { assertions++; }, onResponseHeaders() {}
  };
  const request = {
    getRequestTarget(pattern, settings) { return { headers: { 'X-OpenAI-Attach-Auth': '1', ...settings?.additionalHeaders } }; },
    safeGet(pattern, settings, extra) {
      calls.push({ pattern, settings, extra, aborts: 0 });
      return new Promise((resolve, reject) => {
        const cleanup = () => { nativeSettled = true; settings.signal?.removeEventListener('abort', abort); };
        nativePending = {
          resolve(value) { cleanup(); resolve(value); },
          reject(error) { cleanup(); reject(error); }
        };
        const abort = () => {
          calls.at(-1).aborts++;
          if (!deferAbort) nativePending.reject(abortError || settings.signal.reason);
        };
        settings.signal?.addEventListener('abort', abort, { once: true });
        if (settings.signal?.aborted) abort();
      });
    }
  };
  const recovery = context.__betterCodexAccountTransportRecovery__;
  recovery.identityFor = accountId => identity?.accountId === accountId ? identity : null;
  recovery.bridge = async (value, signal) => {
    assert.equal(nativeSettled, true, 'fallback must wait for the native promise to settle');
    assert.equal(timers.size, 0, 'the primary timer must be cleared before fallback');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the forwarding listener must be removed before fallback');
    bridgeCalls.push({ identity: value, signal });
    return metadata();
  };
  recovery.installRequest(request);
  return {
    clock, timers, scheduled, options, controller, calls, bridgeCalls, recovery,
    begin(pattern = route, extra) { return request.safeGet(pattern, options, extra); },
    resolve(value = metadata()) { nativePending.resolve(value); }, reject(error) { nativePending.reject(error); },
    setIdentity(value) { identity = value; }, get assertions() { return assertions; }
  };
}

(async () => {
  const slow = fixture(), marker = {}, completed = slow.begin(route, marker);
  assert.deepEqual(slow.scheduled, [10000]);
  assert.notEqual(slow.calls[0].settings, slow.options, 'only clone the native options');
  assert.notEqual(slow.calls[0].settings.signal, slow.controller.signal);
  assert.equal(slow.calls[0].settings.signal instanceof AbortSignal, true);
  for (const key of Object.keys(slow.options).filter(key => key !== 'signal')) assert.equal(slow.calls[0].settings[key], slow.options[key], key + ' retains its original reference');
  assert.equal(slow.calls[0].extra, marker);
  await slow.clock.advance(9999); assert.equal(slow.bridgeCalls.length, 0);
  await slow.clock.advance(1);
  assert.equal((await completed).accounts.default.can_access_with_session, false);
  assert.equal(slow.calls.length, 1); assert.equal(slow.calls[0].aborts, 1);
  assert.equal(slow.bridgeCalls.length, 1);
  assert.equal(slow.bridgeCalls[0].signal, slow.controller.signal, 'fallback uses the unmodified caller signal');
  assert.equal(slow.controller.signal.aborted, false);
  assert.equal(slow.calls[0].settings.signal.reason.name, 'TimeoutError');
  await slow.clock.advance(30000); assert.equal(slow.bridgeCalls.length, 1, 'a deadline never loops');

  const deferred = fixture({ deferAbort: true }), deferredResult = deferred.begin();
  await deferred.clock.advance(10000);
  assert.equal(deferred.bridgeCalls.length, 0, 'abort alone must not race past a still-pending native request');
  deferred.reject(deferred.calls[0].settings.signal.reason);
  await deferredResult; assert.equal(deferred.bridgeCalls.length, 1);

  for (const status of [401, 403]) {
    const before = fixture(), error = policyError(status), rejected = before.begin();
    const checked = assert.rejects(rejected, value => value === error);
    await before.clock.advance(9999); before.reject(error); await checked;
    assert.equal(before.bridgeCalls.length, 0); assert.equal(before.timers.size, 0);
    await before.clock.advance(1); assert.equal(before.calls[0].settings.signal.aborted, false);
    const simultaneous = fixture({ abortError: error }), simultaneousResult = simultaneous.begin();
    const policyStillRejected = assert.rejects(simultaneousResult, value => value === error);
    await simultaneous.clock.advance(10000); await policyStillRejected;
    assert.equal(simultaneous.bridgeCalls.length, 0, 'a real policy error at the deadline is not a timeout fallback');
  }
  for (const abortError of [new DOMException('native aborted', 'AbortError'), Object.assign(new Error('native cancelled'), { status: 499 })]) {
    const cancelledNative = fixture({ abortError }), result = cancelledNative.begin();
    await cancelledNative.clock.advance(10000); await result;
    assert.equal(cancelledNative.bridgeCalls.length, 1, 'native cancellation envelopes caused by the own deadline may recover once');
  }

  const outside = fixture(), outsideResult = outside.begin(), cancellation = new DOMException('caller closed', 'AbortError');
  const outsideRejected = assert.rejects(outsideResult, value => value === cancellation);
  await outside.clock.advance(9999); outside.controller.abort(cancellation); await outsideRejected;
  assert.equal(outside.bridgeCalls.length, 0); assert.equal(outside.timers.size, 0);
  assert.equal(getEventListeners(outside.controller.signal, 'abort').length, 0);
  await outside.clock.advance(1); assert.equal(outside.calls[0].aborts, 1);

  const switched = fixture(), changed = switched.begin(), changedRejected = assert.rejects(changed, error => error.name === 'AbortError');
  switched.setIdentity({ accountId: 'fixture-account', userId: 'different-fixture-user' });
  await switched.clock.advance(10000); await changedRejected;
  assert.equal(switched.bridgeCalls.length, 0);

  for (const [pattern, identity, headers] of [
    ['/accounts/fixture/settings', undefined, undefined],
    [route, null, undefined], // identityFor rejects an organization or unknown personal structure.
    [route, undefined, { 'ChatGPT-Account-ID': 'fixture-account', 'X-OpenAI-Attach-Auth': '0' }]
  ]) {
    const unbounded = fixture(identity === null ? { identity: null } : {});
    if (headers) unbounded.options.additionalHeaders = headers;
    const result = unbounded.begin(pattern);
    assert.equal(unbounded.calls[0].settings, unbounded.options);
    assert.equal(unbounded.scheduled.length, 0, 'other routes, organizations and unauthenticated calls get no extra timer');
    unbounded.resolve(); await result; assert.equal(unbounded.bridgeCalls.length, 0);
  }

  const fast = fixture(), immediate = fast.begin(); fast.resolve(); await immediate;
  assert.equal(fast.timers.size, 0);
  assert.equal(getEventListeners(fast.controller.signal, 'abort').length, 0);
  await fast.clock.advance(10000);
  assert.equal(fast.calls[0].settings.signal.aborted, false, 'a successful primary has no later deadline cancellation');
  assert.equal(fast.bridgeCalls.length, 0);
  console.log('account primary deadline: virtual cancellation, original caller identity/options, policy denial, owner abort, personal scope and cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

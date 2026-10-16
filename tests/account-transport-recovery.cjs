'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/ui/native-conversation-adapter.js'), 'utf8');
const route = '/accounts/check/{version}';
const challenge = () => Object.assign(new Error('cloudflare_challenge'), { status: 403, errorCode: 'cloudflare_challenge' });
const data = () => ({ account_ordering: ['workspace'], accounts: { workspace: {
  account: { account_id: 'workspace', account_user_id: 'member', account_user_role: 'member', structure: 'personal', plan_type: 'plus', is_deactivated: false, is_zdr: true },
  can_access_with_session: false, features: [], entitlement: null
} } });
function fixture(first = challenge(), fallback = data()) {
  const context = vm.createContext({ URL, DOMException });
  vm.runInContext(source, context);
  const calls = [], bridgeCalls = [];
  let asserted = 0;
  const request = {
    getRequestTarget(path, options) { return { headers: { 'X-OpenAI-Attach-Auth': '1', ...options?.additionalHeaders } }; },
    async safeGet(path, options) { calls.push({ path, options }); if (first instanceof Error) throw first; return first; }
  };
  const original = request.safeGet;
  const recovery = context.__boostCodexAccountTransportRecovery__;
  recovery.identityFor = accountId => ({ accountId, userId: 'native-user' });
  recovery.bridge = async (identity, signal) => { bridgeCalls.push({ identity, signal }); if (fallback instanceof Error) throw fallback; return fallback; };
  assert.equal(recovery.installRequest(request), true);
  const options = { parameters: { path: { version: 'v4-2023-04-27' } }, additionalHeaders: { 'ChatGPT-Account-ID': 'workspace', 'OAI-Language': 'zh-CN' }, signal: new AbortController().signal, expectedIdentity: { kind: 'chatgpt' }, assertRequestCurrent() { asserted++; } };
  return { context, request, original, recovery, calls, bridgeCalls, options, get asserted() { return asserted; } };
}
(async () => {
  function nativeIdentity(usageData, checkData, extra = {}) {
    const context = vm.createContext({ URL, DOMException });
    vm.runInContext(source, context);
    const usage = { queryKey: ['usage-settings', 'accounts-check', 'v4-2023-04-27', 'workspace', 'native-user'], state: { data: usageData }, isActive: () => true };
    const check = { queryKey: ['accounts', 'check'], state: { status: 'success', fetchStatus: 'idle', isInvalidated: false, data: checkData }, isActive: () => true, ...extra };
    const queries = [usage, check];
    context.__codexRoot = { _internalRoot: { current: { memoizedProps: { client: { getQueryCache: () => ({ getAll: () => queries }) } } } } };
    return { recovery: context.__boostCodexAccountTransportRecovery__, queries };
  }
  const checkData = { accounts: [{ id: 'workspace', structure: 'personal' }], account_ordering: ['workspace'] };
  const cold = nativeIdentity(undefined, checkData);
  assert.equal(cold.recovery.identityFor('workspace').userId, 'native-user', 'cold startup can use the native authenticated account list');
  for (const [usageData, listData, extra] of [
    [undefined, { accounts: [{ id: 'workspace', structure: 'organization' }], account_ordering: ['workspace'] }, {}],
    [data(), { accounts: [{ id: 'workspace', structure: 'organization' }], account_ordering: ['workspace'] }, {}],
    [undefined, { ...checkData, account_ordering: ['other'] }, {}],
    [undefined, checkData, { state: { status: 'success', fetchStatus: 'idle', isInvalidated: true, data: checkData } }],
    [undefined, checkData, { state: { status: 'success', fetchStatus: 'fetching', data: checkData } }],
    [undefined, { ...checkData, accounts: [...checkData.accounts, ...checkData.accounts] }, {}],
    [undefined, checkData, { isActive: () => false }],
    [undefined, checkData, { state: { status: 'error', data: checkData } }],
    [{ accounts: { workspace: { account: { account_id: 'workspace', structure: 'organization' } } } }, checkData, {}]
  ]) assert.equal(nativeIdentity(usageData, listData, extra).recovery.identityFor('workspace'), null);
  cold.queries.push({ ...cold.queries[0], queryKey: ['usage-settings', 'accounts-check', 'v4-2023-04-27', 'workspace', 'other-user'] });
  assert.equal(cold.recovery.identityFor('workspace'), null, 'ambiguous users cannot use a cached account list');
  const early = nativeIdentity(undefined, checkData);
  let startupFetches = 0;
  early.queries[0].state = { status: 'error', fetchStatus: 'idle', error: challenge() };
  early.queries[0].fetch = async () => { startupFetches++; };
  early.recovery.installRequest({ safeGet: async () => data(), getRequestTarget: () => ({ headers: {} }) });
  await Promise.resolve();
  assert.equal(startupFetches, 0, 'startup recovery waits for an installed bridge');
  early.recovery.bridge = async () => data();
  early.recovery.recoverStartupErrors(); early.recovery.recoverStartupErrors();
  await Promise.resolve();
  assert.equal(startupFetches, 1, 'an early real challenge is retried once without changing query state');
  assert.equal(early.queries[0].state.status, 'error');
  const closedBridge = nativeIdentity(undefined, checkData);
  let closedFetches = 0;
  closedBridge.queries[0].state = { status: 'error', fetchStatus: 'idle', error: challenge() };
  closedBridge.queries[0].fetch = async () => { closedFetches++; };
  closedBridge.recovery.request = {}; closedBridge.recovery.bridge = async () => data();
  closedBridge.recovery.recoverStartupErrors(); closedBridge.recovery.bridge = null;
  await Promise.resolve();
  assert.equal(closedFetches, 0, 'a destroyed bridge cannot issue a scheduled startup retry');
  for (const primaryError of [Object.assign(new Error('unauthorized'), { status: 401 }), Object.assign(new Error('policy'), { status: 403, errorCode: 'invalid_workspace_selected' })]) {
    const x = nativeIdentity(undefined, checkData);
    x.queries[0].state = { status: 'error', fetchStatus: 'idle', error: primaryError };
    x.queries[0].fetch = async () => { throw Error('must not retry'); };
    x.recovery.request = {}; x.recovery.bridge = async () => data();
    x.recovery.recoverStartupErrors();
    assert.equal(x.recovery.startupRetried.has(x.queries[0]), false);
  }
  const f = fixture();
  const result = await f.request.safeGet(route, f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.bridgeCalls.length, 1);
  assert.equal(result.accounts.workspace.can_access_with_session, false, 'a denied membership remains denied');
  assert.equal(result.accounts.workspace.account.is_zdr, true);
  assert.equal(f.bridgeCalls[0].signal, f.options.signal);
  assert.deepEqual(JSON.parse(JSON.stringify(f.bridgeCalls[0].identity)), { accountId: 'workspace', userId: 'native-user' });
  assert.equal(f.calls[0].options, f.options);
  assert.equal(f.asserted, 2, 'identity assertions run before and after the local transport');
  assert.equal(f.recovery.stats.recovered, 1);

  for (const error of [Object.assign(new Error('auth'), { status: 401 }), Object.assign(new Error('policy'), { status: 403, errorCode: 'invalid_workspace_selected' }), new Error('timeout')]) {
    const x = fixture(error);
    await assert.rejects(x.request.safeGet(route, x.options), e => e === error);
    assert.equal(x.bridgeCalls.length, 0);
  }
  const healthy = fixture(data());
  await healthy.request.safeGet(route, healthy.options);
  assert.equal(healthy.bridgeCalls.length, 0);
  const other = fixture();
  await assert.rejects(other.request.safeGet('/accounts/workspace/settings', other.options));
  assert.equal(other.bridgeCalls.length, 0);
  const guest = fixture();
  guest.options.additionalHeaders['X-OpenAI-Attach-Auth'] = '0';
  await assert.rejects(guest.request.safeGet(route, guest.options));
  assert.equal(guest.bridgeCalls.length, 0);
  const missingIdentity = fixture();
  missingIdentity.recovery.identityFor = () => null;
  await assert.rejects(missingIdentity.request.safeGet(route, missingIdentity.options));
  assert.equal(missingIdentity.bridgeCalls.length, 0);
  const missingBridge = fixture();
  missingBridge.recovery.bridge = null;
  await assert.rejects(missingBridge.request.safeGet(route, missingBridge.options));

  for (const invalid of [{ accounts: {}, account_ordering: [] }, { ...data(), accounts: { other: { ...data().accounts.workspace, account: { ...data().accounts.workspace.account, account_id: 'other' } } } }, { ...data(), accounts: { workspace: { account: { ...data().accounts.workspace.account, structure: 'organization' } } } }]) {
    const x = fixture(challenge(), invalid);
    await assert.rejects(x.request.safeGet(route, x.options));
    assert.equal(x.recovery.stats.recovered, 0);
    assert.equal(x.recovery.stats.lastFailureStage, 'validation');
  }
  const aborted = fixture();
  const controller = new AbortController(); controller.abort();
  aborted.options.signal = controller.signal;
  await assert.rejects(aborted.request.safeGet(route, aborted.options), e => e.name === 'AbortError');
  assert.equal(aborted.bridgeCalls.length, 0);
  const switched = fixture();
  switched.recovery.bridge = async () => { switched.recovery.identityFor = () => ({ accountId: 'workspace', userId: 'other-user' }); return data(); };
  await assert.rejects(switched.request.safeGet(route, switched.options), e => e.name === 'AbortError');
  assert.equal(switched.recovery.stats.recovered, 0);
  const failed = fixture(challenge(), challenge());
  await assert.rejects(failed.request.safeGet(route, failed.options));
  assert.equal(failed.bridgeCalls.length, 1, 'fallback never loops');
  assert.equal(failed.recovery.stats.lastFailureStage, 'transport');

  function lifecycleFixture() {
    let sequence = 0;
    const context = vm.createContext({ URL, DOMException, crypto: { randomUUID: () => 'request-' + ++sequence } });
    vm.runInContext(source, context);
    const calls = [], pending = [];
    const owner = () => context.boostCodexNativeConversation.create({ api(path, options) {
      calls.push({ path, requestId: JSON.parse(options.body).requestId });
      if (path.endsWith('/cancel')) return Promise.resolve({ cancelled: true });
      return new Promise(resolve => pending.push(resolve));
    } });
    return { context, calls, pending, owner, recovery: context.__boostCodexAccountTransportRecovery__ };
  }
  for (const action of ['dispose', 'destroy', 'reload']) {
    const x = lifecycleFixture(), owner = x.owner();
    const promise = x.recovery.bridge({ accountId: 'workspace', userId: 'native-user' });
    const rejected = assert.rejects(promise, e => e.name === 'AbortError');
    await Promise.resolve();
    if (action === 'dispose') x.recovery.dispose();
    if (action === 'destroy') owner.destroy();
    if (action === 'reload') vm.runInContext(source, x.context);
    await rejected;
    assert.equal(x.calls.filter(call => call.path.endsWith('/cancel')).length, 1, action + ' cancels the local request');
    assert.equal(x.recovery.pending.size, 0);
    x.pending[0](data());
    await Promise.resolve();
    assert.equal(x.recovery.pending.size, 0, 'late metadata cannot revive a cancelled request');
  }
  const owned = lifecycleFixture(), ownerA = owned.owner(), bridgeA = owned.recovery.bridge;
  const promiseA = bridgeA({ accountId: 'workspace', userId: 'native-user' });
  const rejectedA = assert.rejects(promiseA, e => e.name === 'AbortError');
  const ownerB = owned.owner(), bridgeB = owned.recovery.bridge;
  const promiseB = bridgeB({ accountId: 'workspace', userId: 'native-user' });
  await Promise.resolve();
  ownerA.destroy();
  await rejectedA;
  assert.equal(owned.recovery.bridge, bridgeB, 'destroying one owner retains another owner');
  assert.equal(owned.recovery.pending.size, 1);
  owned.pending[1](data());
  assert.equal((await promiseB).accounts.workspace.account.structure, 'personal');
  assert.equal(owned.recovery.pending.size, 0);
  ownerB.destroy();

  vm.runInContext(source, f.context);
  assert.equal(f.request.safeGet, f.original, 'hot reload restores the previous method');
  assert.equal(f.recovery.disposed, true);
  assert.equal(f.context.__boostCodexAccountTransportRecovery__.installRequest(f.request), true);
  f.context.__boostCodexAccountTransportRecovery__.dispose();
  assert.equal(f.request.safeGet, f.original);
  console.log('account transport recovery: authenticated bridge, policy, identity, cancellation and reload checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/ui/native-conversation-adapter.js'), 'utf8');
const route = '/accounts/check/{version}';
const challenge = () => Object.assign(new Error('cloudflare_challenge'), { status: 403, errorCode: 'cloudflare_challenge' });
const data = () => ({ account_ordering: ['workspace'], accounts: { workspace: {
  account: { account_id: 'workspace', account_user_id: 'member', account_user_role: 'member', structure: 'organization', plan_type: 'team', is_deactivated: false, is_zdr: true },
  can_access_with_session: false, features: [], entitlement: null
} } });
function fixture(first = challenge(), fallback = data()) {
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  const calls = [];
  const request = {
    getRequestTarget(path, options) { return { headers: { 'X-OpenAI-Attach-Auth': '1', ...options?.additionalHeaders } }; },
    async safeGet(path, options) { calls.push({ path, options }); if (calls.length === 1 && first instanceof Error) throw first; if (calls.length === 1) return first; if (fallback instanceof Error) throw fallback; return fallback; }
  };
  const original = request.safeGet;
  const recovery = context.__betterCodexAccountTransportRecovery__;
  assert.equal(recovery.installRequest(request), true);
  const options = { parameters: { path: { version: 'v4-2023-04-27' } }, additionalHeaders: { 'ChatGPT-Account-ID': 'workspace', 'OAI-Language': 'zh-CN' }, signal: new AbortController().signal, expectedIdentity: { kind: 'chatgpt' }, assertRequestCurrent() {} };
  return { context, request, original, recovery, calls, options };
}
(async () => {
  const f = fixture();
  const result = await f.request.safeGet(route, f.options);
  assert.equal(f.calls.length, 2);
  assert.equal(result.accounts.workspace.can_access_with_session, false, 'a denied membership remains denied');
  assert.equal(result.accounts.workspace.account.is_zdr, true);
  assert.equal(f.calls[1].options.signal, f.options.signal);
  assert.equal(f.calls[1].options.expectedIdentity, f.options.expectedIdentity);
  assert.equal(f.calls[1].options.assertRequestCurrent, f.options.assertRequestCurrent);
  assert.equal(f.calls[1].options.parameters, f.options.parameters);
  assert.equal(f.calls[1].options.additionalHeaders['OAI-Language'], 'zh-CN');
  assert.equal(Object.hasOwn(f.calls[1].options.additionalHeaders, 'ChatGPT-Account-ID'), false);
  assert.equal(f.options.additionalHeaders['ChatGPT-Account-ID'], 'workspace');
  assert.equal(f.recovery.stats.recovered, 1);

  for (const error of [Object.assign(new Error('auth'), { status: 401 }), Object.assign(new Error('policy'), { status: 403, errorCode: 'invalid_workspace_selected' }), new Error('timeout')]) {
    const x = fixture(error);
    await assert.rejects(x.request.safeGet(route, x.options), e => e === error);
    assert.equal(x.calls.length, 1);
  }
  const healthy = fixture(data());
  await healthy.request.safeGet(route, healthy.options);
  assert.equal(healthy.calls.length, 1);
  const other = fixture();
  await assert.rejects(other.request.safeGet('/accounts/workspace/settings', other.options));
  assert.equal(other.calls.length, 1);
  const guest = fixture();
  guest.options.additionalHeaders['X-OpenAI-Attach-Auth'] = '0';
  await assert.rejects(guest.request.safeGet(route, guest.options));
  assert.equal(guest.calls.length, 1);

  for (const invalid of [{ accounts: {}, account_ordering: [] }, { ...data(), accounts: { other: { ...data().accounts.workspace, account: { ...data().accounts.workspace.account, account_id: 'other' } } } }, { ...data(), accounts: { workspace: { account: { account_id: 'workspace' } } } }]) {
    const x = fixture(challenge(), invalid);
    await assert.rejects(x.request.safeGet(route, x.options));
    assert.equal(x.recovery.stats.recovered, 0);
  }
  const aborted = fixture();
  const controller = new AbortController(); controller.abort();
  aborted.options.signal = controller.signal;
  await assert.rejects(aborted.request.safeGet(route, aborted.options), e => e.name === 'AbortError');
  assert.equal(aborted.calls.length, 1);
  const failed = fixture(challenge(), challenge());
  await assert.rejects(failed.request.safeGet(route, failed.options));
  assert.equal(failed.calls.length, 2, 'fallback never loops');

  vm.runInContext(source, f.context);
  assert.equal(f.request.safeGet, f.original, 'hot reload restores the previous method');
  assert.equal(f.recovery.disposed, true);
  assert.equal(f.context.__betterCodexAccountTransportRecovery__.installRequest(f.request), true);
  f.context.__betterCodexAccountTransportRecovery__.dispose();
  assert.equal(f.request.safeGet, f.original);
  console.log('account transport recovery: authenticated fallback, policy, identity, cancellation and reload checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

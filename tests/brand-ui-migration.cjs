'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../src/ui', file), 'utf8');
const ui = read('boost-codex-ui.js');
const workflow = read('workflow-web/app.js');

function preferences(source, entries, failWrites = false) {
  const storage = new Map(entries), writes = [];
  const context = vm.createContext({ localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { writes.push(key); if (failWrites) throw Error('quota'); storage.set(key, value); }
  } });
  vm.runInContext(source, context);
  return { storage, writes, loaded: JSON.parse(JSON.stringify(context.loaded)) };
}
// Exercise the real preference initialization before the DOM-dependent behavior.
const composerInit = ui.slice(ui.indexOf('  function createComposerModelShortcuts('), ui.indexOf('    function picker(trigger)')) + 'return presets; } globalThis.loaded = createComposerModelShortcuts();';
const workflowInit = workflow.slice(0, workflow.indexOf('  let data =')) + 'globalThis.loaded = view; })();';
const presets = [{ name: '自定义', model: 'gpt-6.1-sol', effort: 'ultra' }];
const savedView = { projectRef: 'P005', taskRef: 'P005-T009', tab: 'review', drafts: { 'P005-T009': '草稿' }, pendingRequests: { save: 'request-1' } };
for (const [source, suffix, saved] of [[composerInit, 'composer-model-shortcuts-v1', presets], [workflowInit, 'workflow-view-v1', savedView]]) {
  const oldKey = 'better-codex-' + suffix, newKey = 'boost-codex-' + suffix, raw = JSON.stringify(saved);
  const migrated = preferences(source, [[oldKey, raw]]);
  assert.equal(migrated.storage.get(newKey), raw, 'copy legacy preferences to the new key');
  assert.equal(migrated.storage.get(oldKey), raw, 'retain legacy preference data');
  assert.deepEqual(migrated.loaded.drafts || migrated.loaded, saved.drafts || saved);
  if (!Array.isArray(saved)) for (const [key, value] of Object.entries(saved)) assert.deepEqual(migrated.loaded[key], value);
  const current = preferences(source, [[oldKey, 'legacy-invalid'], [newKey, raw]]);
  assert.equal(current.writes.length, 0, 'never overwrite an existing new preference');
  assert.deepEqual(current.loaded.drafts || current.loaded, saved.drafts || saved);
  const blocked = preferences(source, [[oldKey, raw]], true);
  assert.deepEqual(blocked.loaded.drafts || blocked.loaded, saved.drafts || saved, 'read legacy data even when migration writes fail');
  const malformed = preferences(source, [[oldKey, raw], [newKey, '{broken']]);
  assert.equal(malformed.writes.length, 0, 'an invalid but present new preference is still authoritative');
}

const calls = [];
const window = { location: { href: 'app://-/detached-window' },
  __betterCodexInjection__: { destroy() { calls.push('legacy'); } },
  __boostCodexInjection__: { destroy() { calls.push('current'); } } };
const injection = vm.createContext({ window, URL });
vm.runInContext(ui, injection);
assert.equal(injection.boostCodexInjected.install({}).reason, 'auxiliary_desktop_window');
assert.deepEqual(calls, ['legacy', 'current']);
assert.equal(window.__betterCodexInjection__, undefined);
window.location.href = 'app://-/local/fixture';
window.__betterCodexInjection__ = { destroy() { calls.push('legacy-reuse'); } };
window.__boostCodexInjection__ = { version: 'fixture', endpoint: 'local', profile: 'default', bundleChecksum: 'checksum',
  pulse() {}, refresh() { calls.push('refresh'); } };
assert.equal(injection.boostCodexInjected.install({ schemaVersion: 1, version: 'fixture', baseUrl: 'local', profile: 'default', bundleChecksum: 'checksum' }).reused, true);
assert.deepEqual(calls.slice(-2), ['legacy-reuse', 'refresh'], 'retire the legacy controller before reusing the current one');

const adapter = read('native-conversation-adapter.js');
const account = vm.createContext({ URL, DOMException });
// Model the already-installed old adapter with its actual disposal behavior.
vm.runInContext(adapter.replaceAll('__boostCodexAccountTransportRecovery__', '__betterCodexAccountTransportRecovery__'), account);
const legacyAccount = account.__betterCodexAccountTransportRecovery__;
const request = { safeGet() {}, getRequestTarget() {} }, original = request.safeGet;
assert.equal(legacyAccount.installRequest(request), true);
assert.notEqual(request.safeGet, original);
vm.runInContext(adapter, account);
assert.equal(legacyAccount.disposed, true);
assert.equal(request.safeGet, original, 'remove the previous transport wrapper before new adapter installation');
assert.equal(account.__betterCodexAccountTransportRecovery__, undefined);
const currentAccount = account.__boostCodexAccountTransportRecovery__;
vm.runInContext(adapter, account);
assert.equal(currentAccount.disposed, true, 'retain cleanup on repeated installs under the new name');

const cleanup = [];
const monitorWindow = {
  __betterCodexSubagentMonitor__: { destroy() { cleanup.push('legacy'); } },
  __boostCodexSubagentMonitor__: { destroy() { cleanup.push('current'); } }
};
const monitor = vm.createContext({ window: monitorWindow, document: { createElement() { throw Error('DOM boundary'); } } });
vm.runInContext(read('subagent-monitor.js'), monitor);
assert.throws(() => monitorWindow.boostCodexSubagentMonitor.create({ api() {} }), /DOM boundary/);
assert.deepEqual(cleanup, ['legacy', 'current']);
assert.equal(monitorWindow.__betterCodexSubagentMonitor__, undefined);
console.log('PASS: UI brand migration preserves preferences and disposes legacy injection, account transport and subagent controllers');

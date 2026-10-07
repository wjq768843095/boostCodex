'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backend = fs.readFileSync(path.join(__dirname, '../src/backend/better-codex.cjs'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function readFunction(source, name) {
  const match = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `Missing function ${name}`);
  const tail = source.slice(match.index + match[0].length);
  const next = new RegExp(`^${match[1]}(?:async )?function [a-zA-Z]`, 'm').exec(tail);
  assert(next, `Missing next function after ${name}`);
  return source.slice(match.index, match.index + match[0].length + next.index);
}
const plain = value => JSON.parse(JSON.stringify(value));

async function bridgeFixtures() {
  const requests = [], resolved = [], connections = [];
  const connection = { fixture: true }, port = 41731, token = 'isolated-fixture-token';
  const context = vm.createContext({
    Error, cdpCommandTimeoutMs: 3000,
    AbortSignal: { timeout: ms => ({ timeout: ms }) },
    import_node_crypto3: { randomUUID: () => 'fixture-trace-id' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ fixture: true }) };
    },
    evaluate: async (receivedConnection, expression) => {
      connections.push(receivedConnection);
      vm.runInNewContext(expression, { window: { __betterCodexBridgeResolve: (id, result) => resolved.push({ id, result: plain(result) }) } });
    }
  });
  vm.runInContext(readFunction(backend, 'bridgeRequest'), context);
  let sequence = 0;
  async function request(route, method = 'GET', extra = {}) {
    const id = 'fixture-request-' + ++sequence;
    await context.bridgeRequest(connection, port, token, JSON.stringify({ id, token, path: route, method, ...extra }));
    assert.equal(connections.at(-1), connection);
    assert.equal(resolved.at(-1).id, id);
    return resolved.at(-1).result;
  }
  for (const [route, method, body] of [
    ['/api/account/usage', 'GET'],
    ['/api/account/usage?refresh=1', 'GET'],
    ['/api/skills', 'GET'],
    ['/api/skills?scope=managed', 'GET'],
    ['/api/skills/fixture-skill', 'PATCH', JSON.stringify({ version: 2, instructions: 'fixture' })],
    ['/api/skills/fixture-skill', 'DELETE', JSON.stringify({ version: 2 })],
    ['/api/project-tools/project_context_read', 'POST', JSON.stringify({ project_id: 'fixture-project' })],
    ['/api/project-tools/project_plan_convert', 'POST', JSON.stringify({ project_id: 'fixture-project', item_ids: ['one'] })],
    ['/api/native-conversations/context?project_id=fixture-project&kind=charter&relay_id=fixture-relay&host_id=local', 'GET'],
    ['/api/native-conversations/prepare', 'POST', JSON.stringify({ project_id: 'fixture-project', kind: 'charter', relay_id: 'fixture-relay', host_id: 'local', expected_revision: 0, request_id: 'fixture-request' })],
    ['/api/native-conversations/bind', 'POST', JSON.stringify({ checkpoint: 'bound', thread_id: 'fixture-thread' })],
    ['/api/native-conversations/receipt', 'POST', JSON.stringify({ status: 'accepted', turn_id: 'fixture-turn' })],
    ['/api/native-conversations/tool', 'POST', JSON.stringify({ name: 'better_codex_project_context_read', arguments: {} })],
    ['/api/native-conversations/restart', 'POST', JSON.stringify({ expected_revision: 1, explicit: true })]
  ]) {
    const before = requests.length;
    assert.deepEqual(await request(route, method, body === undefined ? {} : { body }), { ok: true, status: 200, value: { fixture: true } });
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).url, `http://127.0.0.1:${port}${route}`);
    assert.equal(requests.at(-1).options.method, method);
    assert.equal(requests.at(-1).options.body, body);
    assert.equal(requests.at(-1).options.headers.authorization, `Bearer ${token}`);
    assert.equal(requests.at(-1).options.headers['x-better-codex-trace-id'], 'fixture-trace-id');
  }
  for (const [route, extra] of [
    ['/api/skills', { token: 'wrong-token' }],
    ['https://foreign.invalid/api/skills', {}],
    ['/unrelated/api/skills', {}],
    ['/api/skills-other', {}],
    ['/api/project-tools-other', {}],
    ['/api/native-conversations-other', {}],
    ['/api/native-conversations/context', { token: 'wrong-token' }],
    ['/api/remote-access/status', {}],
    ['/api/relay/status', {}],
    ['/api/sync/status', {}],
    ['/api/account/usage-other', {}],
    ['/api/account/usage/activity', {}],
    ['/api/account/profile', {}]
  ]) {
    const before = requests.length;
    const result = await request(route, 'GET', extra);
    assert.equal(requests.length, before, route);
    assert.equal(result.ok, false, route);
    assert.equal(result.status, 0, route);
    assert.equal(result.value.error, 'invalid_bridge_request', route);
  }
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const before = requests.length;
    const result = await request('/api/account/usage', method);
    assert.equal(requests.length, before);
    assert.equal(result.value.error, 'invalid_bridge_request');
  }
}

async function recoveryFixtures() {
  let resolveCopy;
  const copies = [], timers = [];
  const context = vm.createContext({
    copyText: text => {
      copies.push(text);
      return new Promise(resolve => { resolveCopy = resolve; });
    },
    t: text => text,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); }
  });
  vm.runInContext(readFunction(ui, 'copyServiceRestartCommand'), context);

  const button = { isConnected: true, textContent: '复制重启命令' };
  const event = { currentTarget: button };
  const pending = context.copyServiceRestartCommand(event);
  event.currentTarget = null;
  assert.equal(button.textContent, '复制重启命令');
  resolveCopy();
  await pending;
  assert.equal(copies.at(-1), 'better-codex service restart');
  assert.equal(button.textContent, '已复制');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1600);
  timers.shift().callback();
  assert.equal(button.textContent, '复制重启命令');

  const detached = { isConnected: true, textContent: '复制重启命令' };
  const detachedEvent = { currentTarget: detached };
  const detachedPending = context.copyServiceRestartCommand(detachedEvent);
  detachedEvent.currentTarget = null;
  detached.isConnected = false;
  resolveCopy();
  await detachedPending;
  assert.equal(detached.textContent, '复制重启命令');
  assert.equal(timers.length, 0, 'detached button must not schedule a text reset');

  const laterDetached = { isConnected: true, textContent: '复制重启命令' };
  const laterPending = context.copyServiceRestartCommand({ currentTarget: laterDetached });
  resolveCopy();
  await laterPending;
  assert.equal(laterDetached.textContent, '已复制');
  laterDetached.isConnected = false;
  laterDetached.textContent = 'detached marker';
  timers.shift().callback();
  assert.equal(laterDetached.textContent, 'detached marker', 'delayed reset must leave a detached button unchanged');
}

function visibilityFixtures() {
  class MockElement {
    constructor(display = 'block', rect = {}) {
      this.isConnected = true;
      this.hidden = false;
      this.inert = false;
      this.parentElement = null;
      this.children = [];
      this.attributes = {};
      this.style = { display, visibility: 'visible', opacity: '1' };
      this.rect = { width: 0, height: 0, left: 10, top: 10, right: 10, bottom: 10, ...rect };
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() { return this.rect; }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
  }
  const visibleRect = { width: 160, height: 90, left: 10, top: 10, right: 170, bottom: 100 };
  const context = vm.createContext({
    HTMLElement: MockElement, getComputedStyle: element => element.style,
    innerWidth: 1280, innerHeight: 800
  });
  vm.runInContext(readFunction(ui, 'injectedElementVisible'), context);
  const visible = element => context.injectedElementVisible(element);
  function tree() {
    const ancestor = new MockElement('block', visibleRect);
    const outer = ancestor.append(new MockElement('contents'));
    const inner = outer.append(new MockElement('contents'));
    inner.append(new MockElement());
    const leaf = inner.append(new MockElement('block', visibleRect));
    return { ancestor, outer, inner, leaf };
  }
  const initial = tree();
  assert.equal(visible(initial.outer), true, 'two contents layers must expose their visible child');
  assert.equal(visible(initial.inner), true);
  assert.equal(visible(initial.leaf), true);
  for (const node of ['ancestor', 'outer', 'inner']) {
    for (const [label, hide] of [
      ['hidden', element => { element.hidden = true; }],
      ['inert', element => { element.inert = true; }],
      ['aria-hidden', element => { element.attributes['aria-hidden'] = 'true'; }],
      ['display:none', element => { element.style.display = 'none'; }],
      ['opacity:0', element => { element.style.opacity = '0'; }],
      ['visibility:hidden', element => { element.style.visibility = 'hidden'; }]
    ]) {
      const elements = tree();
      hide(elements[node]);
      assert.equal(visible(elements.outer), false, `${node} ${label} must hide contents`);
      assert.equal(visible(elements.leaf), false, `${node} ${label} must hide its descendant`);
    }
  }
  assert.equal(visible(new MockElement('contents')), false, 'empty contents has no visible child');
  const emptyOuter = new MockElement('contents');
  const emptyInner = emptyOuter.append(new MockElement('contents'));
  emptyInner.append(new MockElement());
  emptyInner.append(new MockElement('block', { ...visibleRect, width: 0 }));
  assert.equal(visible(emptyOuter), false, 'contents with only zero-size children must stay hidden');
  const detached = tree(); detached.outer.isConnected = false;
  assert.equal(visible(detached.outer), false);
  assert.equal(visible({ isConnected: true }), false, 'non-elements are not mount candidates');
}

function auxiliaryWindowFixtures() {
  const main = 'app://-/index.html';
  const page = main + '?initialRoute=' + encodeURIComponent('/space/local-page-test?window=page&prewarm=1');
  for (const source of [backend, ui]) {
    const ctx = vm.createContext({ URL });
    vm.runInContext(readFunction(source, 'isAuxiliaryDesktopUrl'), ctx);
    assert.equal(ctx.isAuxiliaryDesktopUrl(main), false);
    assert.equal(ctx.isAuxiliaryDesktopUrl(main + '?initialRoute=' + encodeURIComponent('/local/thread-test')), false);
    assert.equal(ctx.isAuxiliaryDesktopUrl(main + '?initialRoute=' + encodeURIComponent('/space/page-test')), false, 'ordinary main-window Pages remain allowed');
    for (const value of [page, main + '?initialRoute=/space/test?window=page', main + '?prewarm=1', main + '?initialRoute=%2Fglobal-dictation', main + '?initialRoute=%2Favatar-overlay', 'app://-/detached-window.html']) {
      assert.equal(ctx.isAuxiliaryDesktopUrl(value), true, value);
    }
  }
  const compatibility = JSON.parse(fs.readFileSync(path.join(__dirname, '../integration/codex-compatibility.json'), 'utf8'));
  const ctx = vm.createContext({ URL, activeCompatibility: () => compatibility });
  vm.runInContext(readFunction(backend, 'isAuxiliaryDesktopUrl'), ctx);
  vm.runInContext(readFunction(backend, 'targetAllowed'), ctx);
  assert.equal(ctx.targetAllowed({ url: main }), true);
  assert.equal(ctx.targetAllowed({ url: page }), false);
  assert.equal(ctx.targetAllowed({ url: 'https://example.com/' }), false);
  const install = ui.slice(ui.indexOf('  function install(config) {'), ui.indexOf('    const VERSION = config.version;'));
  let destroyed = 0;
  const guard = vm.createContext({ URL, window: { location: { href: page }, __betterCodexInjection__: { destroy() { destroyed++; } } } });
  vm.runInContext(readFunction(ui, 'isAuxiliaryDesktopUrl'), guard);
  vm.runInContext(install + '\n return { installed: true };\n}', guard);
  assert.equal(guard.install(undefined).installed, false, 'auxiliary startup stops before bridge, relay or UI initialization');
  assert.equal(destroyed, 1, 'obsolete auxiliary injection is disposed');
}

(async () => {
  auxiliaryWindowFixtures();
  await bridgeFixtures();
  await recoveryFixtures();
  visibilityFixtures();
  process.stdout.write('PASS: native desktop bridge Skill/project tool routing, rejected foreign/remote requests, async recovery-copy lifecycle and nested display:contents visibility\n');
})().catch(error => { console.error(error); process.exitCode = 1; });

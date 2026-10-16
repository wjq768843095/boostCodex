'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag, owner) {
    this.tagName = tag; this.owner = owner; this.children = []; this.attributes = {}; this.listeners = {};
    this.style = { cssText: '' }; this.hidden = false; this._text = '';
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); for (const child of [...this.children]) child.remove(); }
  get isConnected() { return !!this.root || !!this.parentElement?.isConnected; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node === before) return node;
    node.remove(); node.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (before && index < 0) throw Error('Reference node is not a child');
    this.children.splice(index < 0 ? this.children.length : index, 0, node); return node;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) {
    if (selector.startsWith('.')) return (this.className || '').split(/\s+/).includes(selector.slice(1));
    if (!selector.startsWith('[')) return this.tagName === selector;
    return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => key in this.attributes && (value === undefined || this.attributes[key] === value));
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== callback); }
  dispatch(name) { for (const callback of [...(this.listeners[name] || [])]) callback({ target: this, preventDefault() {}, stopPropagation() {} }); }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  getBoundingClientRect() { return this.rect || { top: 40, left: 240, width: 800, height: 800 }; }
}

function fixture() {
  const document = new Element('document'); document.owner = document; document.root = true;
  document.createElement = tag => new Element(tag, document);
  document.head = document.createElement('head'); document.body = document.createElement('body'); document.append(document.head, document.body);
  const frame = document.createElement('main'); frame.className = 'app-shell-main-content-frame'; document.body.append(frame);
  const window = new Element('window', document), intervals = new Map(), storage = new Map(), calls = [];
  let time = 100000, threadId = 'thread-a', nextTimer = 0;
  window.innerHeight = 900;
  window.location = { href: 'app://-/local/019a0000-0000-7000-8000-000000000001' };
  window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
  window.setInterval = (callback, delay) => { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; };
  window.clearInterval = id => intervals.delete(id);
  const api = (route, options) => new Promise((resolve, reject) => calls.push({ route, options, resolve, reject }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/subagent-monitor.js'), 'utf8'), { window, document, URL });
  const create = () => window.BetterCodexSubagentMonitor.create({ api, getThreadId: () => threadId, now: () => time });
  const instance = create();
  return {
    document, window, calls, storage, intervals, frame, instance, create,
    get panel() { return document.querySelector('.bc-subagent-panel'); },
    get list() { return document.querySelector('.bc-subagent-list'); },
    get toggle() { return document.querySelector('.bc-subagent-toggle'); },
    get notice() { return document.querySelector('.bc-subagent-notice'); },
    setThread(value) { threadId = value; },
    advance(ms) { time += ms; for (const { callback } of [...intervals.values()]) callback(); },
    complete(agents, extras = {}, index = calls.length - 1) { calls[index].resolve({ threadId, agents, observedAt: time, syncing: false, ...extras }); },
    rows() { return document.querySelectorAll('.bc-subagent-row'); }
  };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const agent = (id, status, extras = {}) => ({ id, name: id, nickname: '昵称 ' + id, status, model: 'gpt-6.1-sol', effort: 'high', depth: 1, startedAt: 1000, elapsedMs: 0, runningSince: null, ...extras });
const name = row => row.querySelector('.bc-subagent-name').textContent;
const elapsed = row => row.querySelector('.bc-subagent-footer').children[1].textContent;

(async () => {
  const empty = fixture();
  assert.equal(empty.panel.hidden, true, 'the initial panel is hidden until agents are received');
  assert.equal(empty.calls.length, 1);
  assert.match(empty.calls[0].route, /^\/api\/dev\/subagents\?threadId=thread-a$/);
  empty.complete([]); await flush(); assert.equal(empty.panel.hidden, true, 'a chat without agents has no visible panel'); empty.instance.destroy();

  const live = fixture();
  live.complete([
    agent('done', 'completed', { startedAt: 500, elapsedMs: 65000 }),
    agent('later', 'running', { startedAt: 3000, elapsedMs: 12000, runningSince: 90000 }),
    agent('first', 'starting', { startedAt: 2000 }),
    agent('interrupted', 'interrupted', { startedAt: 1000 })
  ]); await flush();
  assert.equal(live.panel.hidden, false, 'agents automatically open the panel');
  assert.equal(live.toggle.getAttribute('aria-expanded'), 'true'); assert.equal(live.list.hidden, false);
  assert.match(live.toggle.textContent, /进行中 2 · 已完成 1/);
  assert.deepEqual(live.rows().map(name), ['first', 'later', 'done', 'interrupted'], 'active agents precede finished agents, then use start time');
  assert.match(live.panel.style.cssText, /left:252px;top:94px;width:330px/);
  assert.equal(elapsed(live.rows()[1]), '22秒', 'running duration adds completed intervals and the server-observed active interval');
  assert.equal(elapsed(live.rows()[2]), '1分5秒');
  live.advance(2000);
  assert.equal(elapsed(live.rows()[1]), '24秒', 'the active interval advances by client time between responses');
  assert.equal(elapsed(live.rows()[2]), '1分5秒', 'finished duration does not continue ticking');
  live.calls.at(-1).reject(new Error('private server path')); await flush();
  assert.equal(live.notice.textContent, '同步中', 'poll errors report synchronization without exposing raw errors');
  assert.equal(live.rows().length, 4, 'poll errors preserve the last good data');
  assert.ok(!live.panel.textContent.includes('private server path'));
  live.toggle.dispatch('click'); assert.equal(live.list.hidden, true);
  assert.equal(live.storage.get('bc-subagents-collapsed:thread-a'), 'true');
  live.setThread('thread-b'); live.instance.sync(); assert.equal(live.panel.hidden, true);
  live.complete([agent('other', 'running')]); await flush(); assert.equal(live.list.hidden, false, 'folding is independent in each chat');
  live.setThread('thread-a'); live.instance.sync(); live.complete([agent('return', 'completed')]); await flush();
  assert.equal(live.list.hidden, true, 'returning to a chat restores its folded preference');
  const replacement = live.create();
  assert.equal(live.intervals.size, 1, 'recreating the monitor tears down the old polling interval');
  assert.equal(live.document.querySelectorAll('.bc-subagent-panel').length, 1, 'recreating the monitor leaves a single panel');
  assert.equal(live.document.querySelectorAll('style').length, 1);
  live.complete([agent('restored', 'completed')]); await flush(); assert.equal(live.list.hidden, true, 'folding persists in localStorage across controller replacement');
  live.instance.destroy(); assert.equal(live.intervals.size, 1, 'destroying the replaced controller cannot tear down its replacement');
  replacement.destroy(); replacement.destroy();
  assert.equal(live.intervals.size, 0); assert.equal(live.panel, null); assert.equal(live.document.querySelectorAll('style').length, 0);
  assert.equal((live.document.listeners.visibilitychange || []).length, 0); assert.equal((live.window.listeners.resize || []).length, 0);

  const stale = fixture();
  stale.setThread('thread-b'); stale.instance.sync();
  assert.equal(stale.calls.length, 2, 'switching chats starts its own request even while the old chat is pending');
  stale.complete([agent('new-chat', 'running')], { threadId: 'thread-b' }, 1); await flush();
  stale.complete([agent('old-chat', 'completed')], { threadId: 'thread-a' }, 0); await flush();
  assert.deepEqual(stale.rows().map(name), ['new-chat'], 'a response from the previous chat cannot overwrite the current chat');
  stale.instance.destroy();

  const hidden = fixture(); hidden.complete([agent('visible', 'running')]); await flush();
  hidden.document.hidden = true; hidden.document.dispatch('visibilitychange');
  assert.equal(hidden.panel.hidden, true);
  hidden.advance(10000); assert.equal(hidden.calls.length, 1, 'hidden windows do not poll');
  hidden.document.hidden = false; hidden.document.dispatch('visibilitychange'); assert.equal(hidden.calls.length, 2, 'becoming visible refreshes immediately');
  hidden.document.hidden = true; hidden.document.dispatch('visibilitychange');
  hidden.complete([agent('pending-while-hidden', 'running')]); await flush();
  assert.equal(hidden.panel.hidden, true, 'a pending response must not reopen the panel while the window is hidden');
  hidden.instance.destroy();

  const unusual = fixture();
  const longTitle = '<img src=x onerror=alert(1)>' + '长标题'.repeat(100);
  unusual.complete([agent('nested', 'future-state', { name: longTitle, model: '', effort: '', depth: 12, nickname: '嵌套昵称' })]); await flush();
  const row = unusual.rows()[0];
  assert.equal(row.querySelector('.bc-subagent-state').textContent, '未知');
  assert.equal(row.querySelector('.bc-subagent-meta').textContent, '未知 · 未知');
  assert.equal(name(row), '↳ ' + longTitle, 'long titles remain literal text');
  assert.equal(row.querySelector('.bc-subagent-name').getAttribute('title'), longTitle + '（第 12 级子代理）');
  assert.equal(row.getAttribute('style'), '--bc-subagent-depth:5', 'deep hierarchy indentation stays bounded');
  assert.equal(unusual.document.querySelectorAll('img').length, 0, 'agent content cannot create markup');
  unusual.advance(1000); unusual.complete([], { syncing: true }); await flush();
  assert.equal(unusual.panel.hidden, true, 'a fresh empty snapshot hides previously displayed agents');
  unusual.advance(1000); unusual.complete([agent('replacement', 'completed', { elapsedMs: 3601000 })]); await flush();
  assert.deepEqual(unusual.rows().map(name), ['replacement'], 'new snapshots remove stale agent rows');
  assert.equal(elapsed(unusual.rows()[0]), '1小时0分1秒'); unusual.instance.destroy();

  const measured = fixture();
  measured.complete([agent('resumed', 'running', { elapsedMs: 30000, runningSince: 80000 })], { observedAt: 90000 }); await flush();
  assert.equal(elapsed(measured.rows()[0]), '40秒', 'server observation time controls the running interval when client and server snapshots differ');
  measured.advance(3000); assert.equal(elapsed(measured.rows()[0]), '43秒');
  measured.complete([agent('resumed', 'completed', { elapsedMs: 45000 })]); await flush();
  measured.advance(5000); assert.equal(elapsed(measured.rows()[0]), '45秒', 'an ended agent displays its authoritative cumulative duration');
  measured.calls.at(-1).reject(new Error('offline')); await flush(); measured.instance.destroy();

  const destroyed = fixture(); destroyed.instance.destroy(); destroyed.complete([agent('late', 'running')]); await flush();
  assert.equal(destroyed.panel, null, 'a response received after destruction cannot recreate the UI');

  const native = fixture(); native.window.location.href = 'app://-/index.html';
  const activeId = '019a0000-0000-7000-8000-000000000002', inactiveId = '019a0000-0000-7000-8000-000000000003';
  const addEditor = (parent, id) => {
    const editor = native.document.createElement('div'); editor.setAttribute('data-codex-composer', 'true');
    editor.__reactFiber$fixture = { memoizedProps: {}, return: { memoizedProps: { conversationId: id } } };
    editor.rect = { top: 300, left: 240, width: 800, height: 80 }; parent.append(editor); return editor;
  };
  const invisibleEditor = addEditor(native.frame, inactiveId); invisibleEditor.hidden = true;
  const inertSurface = native.document.createElement('section'); inertSurface.setAttribute('inert', ''); native.frame.append(inertSurface);
  addEditor(inertSurface, inactiveId);
  const activeEditor = addEditor(native.frame, activeId);
  assert.equal(native.window.BetterCodexSubagentMonitor.currentThread(), activeId, 'the visible composer parent fiber identifies native memory-router chats');
  native.complete([agent('native', 'running')]); await flush();
  assert.match(native.panel.style.cssText, /--bc-subagent-list-height:152px/, 'positioning respects the visible composer and ignores inactive editors');
  const inactiveFrame = native.document.createElement('main'); inactiveFrame.className = 'app-shell-main-content-frame'; inactiveFrame.hidden = true;
  native.document.body.insertBefore(inactiveFrame, native.frame);
  native.instance.sync(); assert.equal(native.panel.hidden, false, 'cached hidden native pages cannot hide the active panel');
  const liveRoot = {}, staleRoot = { stateNode: { current: liveRoot } };
  activeEditor.__reactFiber$fixture = {
    memoizedProps: { conversationId: inactiveId }, return: staleRoot,
    alternate: { memoizedProps: { conversationId: activeId }, return: liveRoot }
  };
  assert.equal(native.window.BetterCodexSubagentMonitor.currentThread(), activeId, 'the committed alternate fiber wins over a stale native composer branch');
  activeEditor.__reactFiber$fixture = { memoizedProps: { conversationId: 'new-chat' } };
  native.window.location.href = 'app://-/local/' + inactiveId;
  assert.equal(native.window.BetterCodexSubagentMonitor.currentThread(), null, 'a visible unsaved native chat must not reuse a stale route ID');
  activeEditor.hidden = true;
  assert.equal(native.window.BetterCodexSubagentMonitor.currentThread(), inactiveId, 'a valid route remains available when no active native composer identifies a chat');
  native.window.location.href = 'app://-/index.html?initialRoute=' + encodeURIComponent('/threads/' + activeId);
  assert.equal(native.window.BetterCodexSubagentMonitor.currentThread(), activeId, 'initialRoute supports routed chat windows');
  native.instance.destroy();
  console.log('PASS: subagent monitor visibility, scoped polling, status/order, cumulative timing, folding persistence, stale/error responses, hierarchy, native composer identity and singleton lifecycle (mock data only)');
})().catch(error => { console.error(error); process.exitCode = 1; });

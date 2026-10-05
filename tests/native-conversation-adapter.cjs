'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/native-conversation-adapter.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(check) { for (let i = 0; i < 60; i++) { await tick(); if (!check || check()) return; } throw Error('Fixture did not settle'); }
const tools = ['context_read', 'charter_save', 'charter_confirm', 'plan_save', 'plan_convert'].map(name => ({ name: 'better_codex_project_' + name, description: name, inputSchema: { type: 'object', properties: {} } }));

function fixture(config = {}) {
  const sent = [], delivered = [], http = [], bounds = [], turns = [], errors = [], away = [], routerNavigations = [], retainedViews = [], expiredViews = [], expirySlots = [], animationFrames = new Map();
  const records = new Map();
  const messageListeners = [];
  const operations = new Map();
  let sequence = 0, nativeRoute = '/index.html';
  let nativeDraft = 'client-new-thread:original-native-draft';
  let richDraft = undefined, richState = { imageAttachments: [], attachmentOrder: [], fileAttachments: [] }, nativeDocument = { type: 'doc', content: [] };
  const values = new Map();
  const draftStates = config.draftStates || new Map();
  const sender = { getState: () => null, setState() {}, postMessage(message) { sent.push(message); } };
  const dispatcher = {
    handlers: new Map(), bufferedMessages: new Map(),
    deliverOrBufferMessage(message) { delivered.push(message); config.onDeliver?.(message, sender); },
    dispatchHostMessage(message) { if (message.type === 'navigate-to-route') { nativeRoute = message.path; composerScope.value.focusComposerNonce = message.state?.focusComposerNonce; const url = new URL(message.path, 'https://codex.local'); routeScope.value = url.pathname === '/projects' ? { routeKind: 'home', projectContext: { projectId: url.searchParams.get('projectId') } } : { routeKind: 'local-thread', conversationId: decodeURIComponent(url.pathname.split('/').at(-1)) }; } this.deliverOrBufferMessage(message); }
  };
  const originalSend = sender.postMessage, originalDeliver = dispatcher.deliverOrBufferMessage;
  const draftDescriptor = { __scopeBrand: 'native-scope' }, draftAtom = { scope: draftDescriptor }, projectAtom = { resolve() {} };
  const nativeScope = { scope: draftDescriptor, get(atom) { return atom === draftAtom ? nativeDraft : { projectId: 'native-project' }; }, set(atom, key, id) { nativeDraft = id; } };
  const routeScope = { scope: {}, value: { routeKind: 'home', projectContext: { projectId: 'native-project' } }, get() {}, set() {} };
  const composerDescriptor = { __scopeBrand: 'native-composer' }, promptAtom = { scope: composerDescriptor }, viewAtom = { scope: composerDescriptor }, documentAtom = { scope: composerDescriptor };
  const docNode = value => ({ toJSON: () => value });
  const controller = { restoreDraft(text, retained) { nativeDocument = retained?.document?.toJSON() || { type: 'doc', content: [] }; }, plainTextMode: false, view: { dom: { isConnected: true, getBoundingClientRect: () => ({ width: 500 }) }, state: { schema: { nodeFromJSON: docNode }, get doc() { return docNode(nativeDocument); } } } };
  const composerScope = { scope: composerDescriptor, value: { kind: 'new', entrypoint: 'home' }, get(atom) { return atom === promptAtom ? richDraft : atom === viewAtom ? { ...richState, prompt: '' } : undefined; }, set() {} };
  const nativeElement = { isConnected: true, getBoundingClientRect: () => ({ width: 500 }), __reactFiber$fixture: { memoizedProps: { composerController: controller }, memoizedState: { memoizedState: { current: nativeScope }, next: { memoizedState: { current: routeScope }, next: { memoizedState: { current: composerScope } } } } } };
  controller.view.dom = nativeElement;
  if (config.retainedRouter) {
    const views = (config.retainedPaths || ['/local/retained-thread']).map((pathname, index) => ({ key: pathname, lastUsed: index + 1, route: { routeKind: 'local-thread', pathname, search: '' }, location: { location: { pathname, search: '', hash: '', state: { sidebarProductMode: 'codex', sidebarThreadLocationId: 'retained-sidebar-location' } } }, element: { type: 'native-page' } }));
    retainedViews.push(...views);
    const routerListeners = new Set();
    const router = { routes: [], state: { location: { pathname: '/', search: '', hash: '' } }, subscribe(listener) { routerListeners.add(listener); return () => routerListeners.delete(listener); }, navigate(path, options) {
      routerNavigations.push({ path, options });
      nativeRoute = path;
      this.state.location = { pathname: path, search: '', hash: '', state: options.state };
      routeScope.value = { routeKind: 'local-thread', conversationId: decodeURIComponent(path.split('/').at(-1)) };
      for (const listener of routerListeners) listener(this.state);
      return Promise.resolve();
    } };
    const retainedFiber = { memoizedProps: { value: { router } }, memoizedState: { memoizedState: { current: { ...views[0], key: '/native-home' }, views } } };
    let previous = null;
    for (const view of views) {
      const slot = { impl: () => expiredViews.push(view.key) };
      expirySlots.push(slot);
      const expiry = { memoizedProps: { active: false, ttlSeconds: 600, onExpire: slot.impl }, memoizedState: { memoizedState: { current: 1 }, next: { memoizedState: slot, next: { memoizedState: { deps: [false, 600] } } } } };
      expiry.sibling = { memoizedProps: { view, active: false } };
      const fragment = { key: view.key, child: expiry };
      if (previous) previous.sibling = fragment; else retainedFiber.child = fragment;
      previous = fragment;
    }
    nativeElement.__reactFiber$fixture.return = retainedFiber;
  }
  const host = { sender, dispatcher, dynamicTools: true, prewarm: true, draftIdentity: true, readDraft: () => nativeDraft, selectDraft: id => { nativeDraft = id; }, isSelectedDraft: (id, context) => nativeDraft === id && composerScope.value.focusComposerNonce === id && nativeRoute === '/projects?projectId=' + context.native_project_id, captureDraft: () => ({ draft: richDraft, view_state: richState, document_json: nativeDocument, plain_text_mode: false }), restoreDraft: snapshot => { richDraft = snapshot?.draft; richState = snapshot?.view_state || { imageAttachments: [], attachmentOrder: [], fileAttachments: [] }; nativeDocument = snapshot?.document_json || { type: 'doc', content: [] }; } };
  const root = {
    addEventListener(type, listener, capture = false) { if (type === 'message') messageListeners.push({ listener, capture: capture === true }); },
    removeEventListener(type, listener, capture = false) { if (type !== 'message') return; const index = messageListeners.findIndex(entry => entry.listener === listener && entry.capture === (capture === true)); if (index >= 0) messageListeners.splice(index, 1); },
    dispatchEvent(event) { let stopped = false; event.stopImmediatePropagation = () => { stopped = true; }; for (const entry of [...messageListeners].sort((a,b) => Number(b.capture) - Number(a.capture))) { if (stopped) break; entry.listener(event); } return !stopped; },
    crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}` },
    sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    location: { pathname: '/index.html', search: '', href: 'app://-/index.html', origin: new URL('app://-/index.html').origin },
    document: { querySelectorAll: selector => config.discovery ? (selector.includes('script') ? [{ src: 'app://-/assets/index-test.js' }] : [nativeElement]) : [] },
    fetch: async url => ({ text: async () => url.includes('app-shared') ? 'dynamic-tool-call-requested thread-prewarm-start client-local-thread' : 'import "./app-shared-test.js"; import "./app-initial-test.js"' }),
    setTimeout, clearTimeout, URL, URLSearchParams
  };
  if (config.animationFrames) {
    let frameSequence = 0;
    root.requestAnimationFrame = callback => { const id = ++frameSequence; animationFrames.set(id, callback); return id; };
    root.cancelAnimationFrame = id => animationFrames.delete(id);
  }
  if (config.indexedDB) {
    const persisted = new Map();
    const db = { createObjectStore() {}, transaction() {
      const tx = { objectStore() { return { get(id) { const request = {}; setImmediate(() => { request.result = persisted.has(id) ? structuredClone(persisted.get(id)) : undefined; tx.oncomplete?.(); }); return request; }, put(value, id) { const stored = structuredClone(value), request = {}; setImmediate(() => { persisted.set(id, stored); tx.oncomplete?.(); }); return request; } }; } };
      return tx;
    } };
    root.indexedDB = { open() { const request = {}; setImmediate(() => { request.result = db; request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } };
  }
  if (config.discovery) {
    root.testNamespace = { rpc: new Proxy({}, { get: () => () => {}, set: () => { throw Error('Cannot assign properties on RPC stubs'); } }), sender, dispatcher, GJt: draftDescriptor, Pyt: draftAtom, hbt: () => 'new-conversation', ZTt: projectAtom };
    root.testComposerNamespace = { VIn: composerDescriptor, KZt: promptAtom, DQt: viewAtom, _Qt: documentAtom, XQt(scope, draft) { richDraft = draft; }, 'o$t'(scope, fn) { fn(richState); }, ZQt() {}, FZt() { richDraft = undefined; richState = { imageAttachments: [], attachmentOrder: [], fileAttachments: [] }; } };
  }
  const reloadSource = () => vm.runInNewContext(config.discovery ? source.replace('await import(moduleUrl.href)', 'root.testNamespace').replace('await import(new URL(initialName, entry).href)', 'root.testComposerNamespace') : source, { window: root, URL, URLSearchParams, Error, Map, Set, Promise });
  reloadSource();
  const key = context => [context.project_id, context.kind, context.issue_id || ''].join(':') + (context.conversation_id ? ':conversation:' + encodeURIComponent(context.conversation_id) : '') + (context.history_id ? ':history:' + encodeURIComponent(context.history_id) : '');
  const context = (overrides = {}) => {
    const value = { project_id: 'project-one', kind: 'charter', native_project_id: 'native-project', host_id: 'local', cwd: 'D:\\中文项目', workspace_path: 'D:\\中文项目', root_paths: ['D:\\中文项目', 'E:\\关联后台'], expected_revision: 0, draft_generation: 0, mode: 'draft', dynamic_tools: tools, ...overrides };
    if (value.kind === 'work') {
      if (!Object.hasOwn(overrides,'task')) value.task={id:value.issue_id,project_id:value.project_id,version:1,title:'当前工作任务',description:'完成本工作项'};
      if (!Object.hasOwn(overrides,'work_context_text')) value.work_context_text='当前工作任务：'+value.issue_id+'\n任务要求：完成本工作项。';
    }
    return value;
  };
  const remember = value => { records.set(key(value), value); return value; };
  const api = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    http.push({ url, body });
    if (config.api) { const answer = await config.api(url, body); if (answer !== undefined) return answer; }
    if (url.endsWith('/validate-input')) return { valid: true };
    if (url.includes('/context?')) {
      const query = new URL(url, 'http://fixture.invalid').searchParams;
      return records.get(key({ project_id: query.get('project_id'), kind: query.get('kind'), issue_id: query.get('issue_id'), conversation_id: query.get('conversation_id'), history_id: query.get('history_id') }));
    }
    if (url.endsWith('/prepare')) {
      const known = records.get(key(body));
      const target = { project_id: body.project_id, kind: body.kind, issue_id: body.issue_id || null, host_id: body.host_id, ...(body.conversation_id ? { conversation_id: body.conversation_id } : {}) };
      if (config.enrollLegacy && body.kind !== 'work' && !body.conversation_id) { target.conversation_id = config.enrollLegacy; records.set(key(target), { ...known, ...target }); }
      const operation = { ...target, request_id: body.request_id, status: 'prepared', thread_id: known?.thread_id || null, expected_revision: body.expected_revision };
      operations.set(body.request_id, operation);
      return { target, operation, dynamic_tools: tools };
    }
    if (url.endsWith('/bind')) {
      const operation = operations.get(body.request_id);
      operation.thread_id = body.thread_id;
      operation.status = body.checkpoint;
      const binding = { project_id: body.project_id, kind: body.kind, issue_id: body.issue_id, host_id: body.host_id, thread_id: body.thread_id, ...(body.conversation_id ? { conversation_id: body.conversation_id } : {}) };
      if (body.checkpoint === 'bound') {
        const known = records.get(key(body));
        records.set(key(body), { ...known, binding, mode: 'thread', thread_id: body.thread_id });
      }
      return { operation, binding };
    }
    if (url.endsWith('/receipt')) { operations.get(body.request_id).status = body.status; return { accepted: true }; }
    if (url.endsWith('/tool')) return { value: 'saved', project_id: 'trusted-project', version: 2 };
    throw Error('Unexpected fixture API');
  };
  const options = {
    host: config.discovery ? undefined : host, api, getRelayId: () => 'fixture-leader', getActiveRoute: () => config.memoryRouter ? '/index.html' : nativeRoute,
    draftStorage: config.draftStorage || (config.indexedDB ? undefined : { get: async id => draftStates.get(id), set: async (id, snapshot) => { draftStates.set(id, snapshot); } }),
    isCurrentContext: () => true, afterNavigate: async () => {},
    onBound: value => bounds.push(plain(value)), onTurn: value => turns.push(plain(value)),
    onError: (error, origin) => errors.push({ error: error.message, origin: origin && plain(origin) }),
    onNavigateAway: origin => away.push(plain(origin))
  };
  const adapter = root.BetterCodexNativeConversation.create(options);
  const send = (method, params, id = 'native-' + ++sequence, rest = {}) => { const message = { type: 'mcp-request', hostId: 'local', request: { id, method, params }, ...rest }; sender.postMessage(message); return message; };
  const reply = (id, result, error) => dispatcher.deliverOrBufferMessage({ type: 'mcp-response', hostId: 'local', message: { id, ...(error ? { error } : { result }) } });
  return { root, host, nativeElement, controller, sender, dispatcher, adapter, options, context, remember, send, reply, http, sent, delivered, bounds, turns, errors, away, routerNavigations, retainedViews, expiredViews, expirySlots, animationFrames, messageListeners, paintFrame() { const frames = [...animationFrames]; animationFrames.clear(); for (const [, callback] of frames) callback(); }, originalSend, originalDeliver, operations, reloadSource, nativeRoute: () => nativeRoute, nativeDraft: () => nativeDraft, rich: () => ({ draft: richDraft, view_state: richState, document_json: nativeDocument }), setRich: value => { richDraft = value.draft; richState = value.view_state; nativeDocument = value.document_json; } };
}

(async () => {
  {
    let restored;
    const f = fixture({ api: (url, body) => {
      if (url.endsWith('/recover')) {
        assert.equal(body.request_id, 'lost-first-send');
        assert.equal(body.expected_revision, 1, 'recovery uses the lost operation revision');
        restored = f.remember(f.context({ kind: 'work', issue_id: 'recovery-task', conversation_id: 'recovery-conversation', thread_id: 'existing-empty-thread', mode: 'thread', expected_revision: 7, pending_operation: null }));
        return { ...restored, recovered: true };
      }
    } });
    const operation = { request_id: 'lost-first-send', status: 'outcome_unknown', thread_id: 'existing-empty-thread', expected_revision: 1 };
    const opened = await f.adapter.open(f.context({ kind: 'work', issue_id: 'recovery-task', conversation_id: 'recovery-conversation', expected_revision: 7, pending_operation: operation }));
    assert.equal(opened.mode, 'thread');
    assert.equal(f.nativeRoute(), '/local/existing-empty-thread');
    assert.equal(f.sent.length, 0, 'reopening restores the existing empty thread without replaying input');
    assert.equal(f.http.length, 1, 'opening only asks for evidence-based recovery');
    f.send('turn/start', { threadId: 'existing-empty-thread', input: [{ type: 'text', text: 'User explicitly sends again' }] }, 'recovered-turn');
    await settle(() => f.sent.length === 1);
    assert.equal(f.sent[0].request.method, 'turn/start');
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 1);
    f.reply('recovered-turn', { turn: { id: 'recovered-turn-id' } });
    await settle(() => f.delivered.some(x => x.message?.id === 'recovered-turn'));
    f.adapter.destroy();
  }
  {
    const f = fixture({ api: url => { if (url.endsWith('/recover')) throw Error('native_outcome_unknown'); } });
    const opened = await f.adapter.open(f.context({ kind: 'work', issue_id: 'uncertain-task', pending_operation: { request_id: 'uncertain-send', status: 'outcome_unknown', thread_id: 'uncertain-thread', expected_revision: 1 } }));
    assert.equal(opened.mode, 'unavailable');
    assert.equal(f.sent.length, 0, 'uncertain delivery evidence never triggers a replacement or replay');
    assert(!f.errors.some(x => String(x).includes('native_outcome_unknown')), 'internal recovery codes are not shown to users');
    f.adapter.destroy();
  }
  {
    const f = fixture({ api: (url, body) => {
      if (url.endsWith('/recover')) {
        assert.equal(body.request_id, 'timed-out-bound-send');
        return { ...f.remember(f.context({ kind: 'work', issue_id: 'bound-recovery-task', thread_id: 'bound-empty-thread', mode: 'thread', pending_operation: null })), recovered: true };
      }
    } });
    const original = f.context({ kind: 'work', issue_id: 'bound-recovery-task', thread_id: 'bound-empty-thread', mode: 'thread' });
    await f.adapter.open(original);
    f.remember({ ...original, pending_operation: { request_id: 'timed-out-bound-send', status: 'outcome_unknown', thread_id: 'bound-empty-thread', expected_revision: 0 } });
    f.send('turn/start', { threadId: 'bound-empty-thread', input: [{ type: 'text', text: 'New explicit user input' }] }, 'new-user-turn');
    await settle(() => f.sent.length === 1);
    assert.equal(f.http.filter(x => x.url.endsWith('/recover')).length, 1);
    assert.equal(f.sent[0].request.id, 'new-user-turn', 'only the new explicit input is forwarded after recovery');
    assert.equal(f.sent[0].request.params.input[0].text, 'New explicit user input');
    f.reply('new-user-turn', { turn: { id: 'new-user-turn-id' } });
    await settle(() => f.delivered.some(x => x.message?.id === 'new-user-turn'));
    f.adapter.destroy();
  }
  {
    const f = fixture({ discovery: true });
    f.nativeElement.isConnected = false;
    await f.adapter.connect();
    const opened = await f.adapter.open(f.context({ mode: 'thread', thread_id: 'existing-thread' }));
    assert.equal(opened.mode, 'thread');
    assert.equal(f.nativeRoute(), '/local/existing-thread');
    assert.equal(f.errors.length, 0);
    assert.equal(f.sent.length, 0, 'opening an existing conversation must not send a model request');
    f.adapter.destroy();
  }
  {
    const f = fixture();
    const readDraft = f.host.readDraft;
    f.host.readDraft = () => {
      if (f.nativeRoute() !== '/projects?projectId=native-project') throw Error('No draft composer on the previous page');
      return readDraft();
    };
    const opened = await f.adapter.open(f.context());
    assert.equal(opened.mode, 'draft');
    assert.equal(f.nativeRoute(), '/projects?projectId=native-project');
    assert.equal(f.errors.length, 0);
    assert.equal(f.sent.length, 0, 'opening a draft must not start a thread or send a model request');
    f.adapter.destroy();
  }
  {
    const f = fixture({ discovery: true, retainedRouter: true, animationFrames: true, retainedPaths: ['/local/retained-thread', '/local/other-thread'] });
    const context = f.context({ mode: 'thread', thread_id: 'retained-thread' });
    await f.adapter.connect();
    assert.equal(f.adapter.resumeRetained(context, { deferNavigation: true }), true);
    assert.equal(f.adapter.getCurrentContext().native_open_state, 'loading');
    const beforePreviewSend = f.sent.length;
    f.send('turn/start', { threadId: 'retained-thread', input: [] }, 'preview-send');
    assert.equal(f.sent.length, beforePreviewSend, 'a native keyboard shortcut cannot send while the cached page is only being displayed');
    assert(f.delivered.some(message => message.message?.id === 'preview-send' && message.message.error));
    assert.equal(f.routerNavigations.length, 0, 'prepare leaves native Activity unchanged for the first cached-page paint');
    assert.equal(f.animationFrames.size, 1);
    const completed = f.adapter.waitRetainedNavigation();
    f.paintFrame();
    assert.equal(f.routerNavigations.length, 0, 'native activation waits for the task after the paint callback');
    assert.equal(await completed, true);
    assert.equal(f.routerNavigations.length, 1);
    assert.equal(f.adapter.getCurrentContext().native_open_state, 'ready');
    assert.equal(f.adapter.resumeRetained({ ...context, thread_id: 'other-thread' }, { deferNavigation: true }), true);
    const cancelled = f.adapter.waitRetainedNavigation();
    f.adapter.leave();
    assert.equal(await cancelled, false); assert.equal(f.animationFrames.size, 0);
    f.paintFrame(); await tick(); assert.equal(f.routerNavigations.length, 1, 'leave cancels a scheduled retained navigation');
    assert.equal(f.adapter.resumeRetained({ ...context, thread_id: 'other-thread' }, { deferNavigation: true }), true);
    const superseded = f.adapter.waitRetainedNavigation();
    const router = f.nativeElement.__reactFiber$fixture.return.memoizedProps.value.router;
    await router.navigate('/local/ordinary-navigation', { state: {} });
    assert.equal(await superseded, false); assert.equal(f.adapter.getCurrentContext(), null);
    f.paintFrame(); await tick(); assert.equal(f.nativeRoute(), '/local/ordinary-navigation', 'ordinary native navigation wins over deferred project activation');
    assert.equal(f.http.length, 0); f.adapter.destroy();
    console.log('PASS: deferred retained activation allows first paint, reports completion and cancels on leave or ordinary native navigation');
  }
  {
    const f = fixture({ discovery: true, retainedRouter: true, retainedPaths: ['/local/retained-thread', '/local/other-thread'] });
    const context = f.context({ mode: 'thread', thread_id: 'retained-thread' });
    const originalAge = f.retainedViews[0].lastUsed;
    assert.equal(f.adapter.pinRetained({ ...context, thread_id: 'missing' }), false);
    assert.equal(f.adapter.pinRetained(context), true);
    assert.equal(f.retainedViews[0].lastUsed, Number.MAX_SAFE_INTEGER, 'only pinned page is protected from native capacity eviction');
    assert.equal(f.retainedViews[1].lastUsed, 2);
    f.expirySlots[0].impl(); f.expirySlots[1].impl();
    assert.deepEqual(f.expiredViews, ['/local/other-thread'], 'real expiry event is deferred only for pinned view');
    f.expirySlots[0].impl = () => f.expiredViews.push('latest-native-expiry');
    f.expirySlots[0].impl();
    assert.deepEqual(f.expiredViews, ['/local/other-thread'], 'React commits may update the event implementation without bypassing the pin');
    f.adapter.clearRetainedPin();
    assert.deepEqual(f.expiredViews, ['/local/other-thread', 'latest-native-expiry'], 'unpin gives deferred native callback its normal chance to reclaim the page');
    assert.equal(f.retainedViews[0].lastUsed, originalAge);
    assert.equal(Object.getOwnPropertyDescriptor(f.expirySlots[0], 'impl').get, undefined, 'unpin restores a normal writable native event');
    assert.equal(f.adapter.pinRetained(context), true);
    assert.equal(f.adapter.pinRetained({ ...context, thread_id: 'other-thread' }), true);
    assert.equal(f.retainedViews[0].lastUsed, originalAge); assert.equal(f.retainedViews[1].lastUsed, Number.MAX_SAFE_INTEGER, 'moving the pin retains exactly one view');
    f.adapter.clearRetainedPin();
    assert.equal(f.adapter.pinRetained(context), true);
    f.expirySlots[0].impl();
    const expiredBeforeActiveRelease = f.expiredViews.length;
    await f.adapter.connect();
    assert.equal(f.adapter.resumeRetained(context), true);
    f.adapter.clearRetainedPin();
    assert.equal(f.expiredViews.length, expiredBeforeActiveRelease, 'releasing a now-active page never invokes its previously deferred expiry');
    assert.equal(Object.getOwnPropertyDescriptor(f.expirySlots[0], 'impl').get, undefined);
    assert.equal(f.retainedViews[0].lastUsed, originalAge);
    const nativeRetentionFiber = f.nativeElement.__reactFiber$fixture.return;
    assert.equal(f.adapter.pinRetained(context), true);
    f.expirySlots[0].impl();
    nativeRetentionFiber.memoizedState.memoizedState.current = f.retainedViews[0];
    nativeRetentionFiber.memoizedProps.value.router.state.location.pathname = '/';
    f.adapter.clearRetainedPin();
    assert.equal(f.expiredViews.length, expiredBeforeActiveRelease, 'retention current-page guard also protects an active view during router transition');
    f.adapter.destroy();
    console.log('PASS: exact native expiry-event pin survives React event updates, protects one cache slot and restores normal expiry on release');
  }
  {
    const f = fixture({ discovery: true, retainedRouter: true });
    const context = f.remember(f.context({ mode: 'thread', thread_id: 'retained-thread' }));
    assert.equal(f.adapter.resumeRetained(context), false, 'unconnected adapter leaves the cold path intact');
    await f.adapter.connect();
    const editor = f.nativeElement, controller = f.controller;
    assert.equal(f.adapter.resumeRetained(context), true);
    assert.equal(f.nativeRoute(), '/local/retained-thread', 'retained route commits synchronously in the click turn');
    assert.equal(f.adapter.getCurrentContext().native_open_state, 'ready');
    assert.equal(f.root.__betterCodexNativeConversationHub__.threads.get('local:retained-thread').context.thread_id, context.thread_id);
    assert.deepEqual(plain(f.routerNavigations[0].options), { state: { sidebarProductMode: 'codex', sidebarThreadLocationId: 'retained-sidebar-location' }, flushSync: true, preventScrollReset: true });
    assert.equal(f.nativeElement, editor); assert.equal(f.controller, controller);
    assert.equal(f.delivered.some(message => message.type === 'navigate-to-route'), false, 'warm resume never sends a second bridge navigation');
    assert.equal(f.adapter.resumeRetained(context), true); assert.equal(f.routerNavigations.length, 1, 'same route keeps its native page selected');
    assert.equal(f.adapter.resumeRetained({ ...context, thread_id: 'uncached-thread' }), false);
    await f.adapter.open(context); assert.equal(f.routerNavigations.length, 1, 'ordinary open also avoids navigating an already-selected retained page');
    await f.adapter.open({ ...context, thread_id: 'uncached-thread' });
    assert.equal(f.nativeRoute(), '/local/uncached-thread');
    assert.equal(f.delivered.some(message => message.type === 'navigate-to-route'), true, 'uncached route retains native bridge fallback');
    assert.equal(f.http.length, 0, 'switching retained pages sends no model or binding request');
    f.adapter.destroy(); console.log('PASS: genuine retained native router resumes synchronously with cached provider state, same-route skip and cold bridge fallback');
  }
  {
    const f = fixture();
    const current = f.remember(f.context({ kind: 'work', issue_id: 'task-one', mode: 'thread', thread_id: 'current-task-thread' }));
    const history = f.remember(f.context({ kind: 'work', issue_id: 'task-one', history_id: 'history-one', mode: 'thread', thread_id: 'old-task-thread', read_only: true }));
    const opened = await f.adapter.open({ ...history, history_id: undefined, target: { history_id: history.history_id } });
    assert.equal(opened.mode, 'thread'); assert.equal(opened.context.read_only, true);
    assert.equal(f.adapter.capture().history_id, history.history_id, 'historical route survives source reload independently of the current task');
    assert.equal(f.nativeRoute(), '/local/old-task-thread');
    f.adapter.registerBindings([current, { ...history, read_only: false }]);
    assert.equal(f.root.__betterCodexNativeConversationHub__.threads.get('local:old-task-thread').context.history_id, history.history_id, 'bootstrap cannot turn visible history into an editable current binding');
    const blocked = f.send('turn/start', { threadId: history.thread_id, input: [{ type: 'text', text: 'must stay unsent' }] }, 'history-send');
    f.send('thread/start', { cwd: history.cwd }, 'history-create');
    await tick();
    assert.equal(f.sent.length, 0); assert.equal(f.http.length, 0, 'historical send and thread creation are rejected before prepare or native send');
    assert.ok(f.delivered.some(value => value.message?.id === blocked.request.id && value.message.error));
    const ordinary = f.send('turn/start', { threadId: 'ordinary-thread', input: [] }, 'ordinary-while-history');
    assert.equal(f.sent.at(-1), ordinary, 'unrelated ordinary conversations retain native send semantics');
    f.dispatcher.deliverOrBufferMessage({ type: 'dynamic-tool-call-requested', hostId: 'local', serverRequest: { id: 'history-tool', method: 'item/tool/call', params: { threadId: history.thread_id, callId: 'old-tool', tool: 'better_codex_project_plan_save', arguments: {} } } });
    await settle(() => f.sent.some(value => value.response?.id === 'history-tool'));
    assert.equal(f.http.length, 0, 'history dynamic tools never write project material');
    assert.equal(f.sent.find(value => value.response?.id === 'history-tool').response.result.success, false);
    const snapshot = f.adapter.capture(); f.adapter.destroy(); f.reloadSource();
    const replacement = f.root.BetterCodexNativeConversation.create(f.options);
    await replacement.restore(history, snapshot);
    assert.equal(replacement.capture().history_id, history.history_id);
    assert.equal(replacement.getCurrentContext().thread_id, history.thread_id);
    await replacement.open(current);
    assert.equal(f.root.__betterCodexNativeConversationHub__.threads.has('local:old-task-thread'), false, 'switching away removes the historical view-only hook from ordinary native navigation');
    f.send('turn/start', { threadId: current.thread_id, input: [] }, 'current-after-history');
    await settle(() => f.http.some(value => value.url.endsWith('/prepare')));
    assert.equal(f.http.find(value => value.url.endsWith('/prepare')).body.history_id, undefined);
    await settle(() => f.sent.some(value => value.request?.id === 'current-after-history'));
    f.reply('current-after-history', { turn: { id: 'current-turn' } }); await settle(() => f.turns.length === 1);
    replacement.destroy(); console.log('PASS: native historical work scope, reload identity, readonly send/tool barrier and writable current conversation isolation');
  }
  {
    const f = fixture();
    const planning = f.remember(f.context({ kind: 'planning', conversation_id: 'plan-locked', mode: 'thread', thread_id: 'planning-thread', read_only: true, planning_available: false }));
    await f.adapter.open(planning); f.adapter.registerBindings([planning]);
    f.send('turn/start', { threadId: planning.thread_id, input: [] }, 'planning-locked-send');
    assert.equal(f.http.length, 0); assert.equal(f.sent.length, 0);
    const confirmed = f.remember({ ...planning, read_only: false, planning_available: true });
    f.adapter.registerBindings([confirmed]);
    assert.equal(f.adapter.updateContext(confirmed), true);
    assert.equal(f.adapter.getCurrentContext().read_only, false);
    assert.equal(f.root.__betterCodexNativeConversationHub__.threads.get('local:planning-thread').context.read_only, false);
    f.send('turn/start', { threadId: planning.thread_id, input: [] }, 'planning-confirmed-send');
    await settle(() => f.sent.length === 1); f.reply('planning-confirmed-send', { turn: { id: 'confirmed-turn' } }); await settle(() => f.turns.length === 1);
    const requests = f.http.length;
    f.remember(planning); assert.equal(f.adapter.updateContext(planning), true);
    f.send('turn/start', { threadId: planning.thread_id, input: [] }, 'planning-revised-send');
    assert.equal(f.http.length, requests); assert.equal(f.sent.length, 1, 'a charter revision locks the selected planning thread again without navigation or allocation');
    assert.equal(f.adapter.updateContext({ ...confirmed, conversation_id: 'different-plan' }), false, 'late foreign context cannot unlock the selected conversation');
    f.adapter.destroy(); console.log('PASS: authoritative planning confirmation and revision update readonly bidirectionally without route or thread changes');
  }
  {
    const f = fixture(); const history = f.context({ kind: 'work', issue_id: 'task', history_id: 'old', thread_id: 'old-native-thread', mode: 'thread', read_only: true });
    await f.adapter.open(history);
    f.dispatcher.deliverOrBufferMessage({ type: 'navigate-to-route', path: '/local/ordinary-thread' });
    assert.equal(f.adapter.getCurrentContext(), null);
    assert.equal(f.root.__betterCodexNativeConversationHub__.threads.has('local:old-native-thread'), false);
    const message = f.send('turn/start', { threadId: history.thread_id, input: [] }, 'ordinary-outside-history');
    assert.equal(f.sent.at(-1), message, 'history-view restrictions cease after normal native navigation leaves Better Codex');
    f.adapter.destroy(); console.log('PASS: leaving historical workspace releases only historical scope while ordinary native navigation stays writable');
  }
  {
    const f = fixture(); const history = f.context({ kind: 'work', issue_id: 'task', history_id: 'old', thread_id: 'old-native-thread', mode: 'thread', read_only: true });
    await f.adapter.open(history);
    assert.equal(f.adapter.ownsRoute('/projects?projectId='+history.native_project_id), false, 'bound history owns its thread route rather than native project home');
    f.dispatcher.deliverOrBufferMessage({ type: 'navigate-to-route', path: '/projects?projectId='+history.native_project_id });
    assert.equal(f.adapter.getCurrentContext(), null); assert.equal(f.away.length, 1);
    const message = f.send('thread/start', { cwd: history.cwd }, 'ordinary-new-project-thread');
    assert.equal(f.sent.at(-1), message); assert.equal(f.http.length, 0);
    f.adapter.destroy(); console.log('PASS: native project navigation exits bound history and allows ordinary native conversation creation');
  }
  {
    const f = fixture();
    const a = f.remember(f.context({ conversation_id: 'charter-a' }));
    const b = f.remember(f.context({ conversation_id: 'charter-b' }));
    const openedA = await f.adapter.open({ ...a, conversation_id: undefined, target: { conversation_id: a.conversation_id } });
    const richA = { draft: { prompt: { plainTextMode: false, document: { type: 'doc', content: [{ type: 'skill_mention', attrs: { name: 'architecture', path: 'C:\\Skills\\SKILL.md' } }] } }, pullRequestChecks: [] }, view_state: { imageAttachments: [{ id: 'image-a', nativeField: { path: 'D:\\图片.png' } }], fileAttachments: [{ id: 'file-a', path: 'E:\\需求.pdf' }], attachmentOrder: ['file:file-a', 'image:image-a'] }, document_json: { type: 'doc', content: [{ type: 'skill_mention', attrs: { name: 'architecture', path: 'C:\\Skills\\SKILL.md' } }, { type: 'paragraph', content: [{ type: 'text', text: 'Conversation A unsent request' }] }] } };
    f.setRich(richA); const snapshotA = f.adapter.capture();
    assert.equal(snapshotA.conversation_id, a.conversation_id, 'target-only metadata must normalize to the stable conversation identity');
    const openedB = await f.adapter.open(b);
    assert.notEqual(openedB.context.client_draft_id, openedA.context.client_draft_id, 'same project and stage conversations require distinct native scopes');
    assert.equal(f.rich().draft, undefined); assert.equal(f.rich().view_state.fileAttachments.length, 0);
    const richB = { draft: { prompt: 'Conversation B unsent request', pullRequestChecks: [] }, view_state: { imageAttachments: [], fileAttachments: [], attachmentOrder: [] }, document_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Conversation B unsent request' }] }] } };
    f.setRich(richB); const snapshotB = f.adapter.capture();
    await f.adapter.restore(a, snapshotA);
    assert.deepEqual(f.rich(), richA, 'Skill node and raw attachment fields remain owned by conversation A');
    const incompatibleSnapshot = await f.adapter.restore(b, snapshotA);
    assert.equal(incompatibleSnapshot.context.client_draft_id, openedB.context.client_draft_id, 'snapshot from another conversation cannot replace the target native scope');
    assert.deepEqual(f.rich(), richB);
    const hub = f.root.__betterCodexNativeConversationHub__;
    f.adapter.destroy(); f.reloadSource();
    const replacement = f.root.BetterCodexNativeConversation.create(f.options);
    const nativeEvents = f.delivered.length;
    await replacement.restore(b, snapshotB);
    assert.equal(f.delivered.length, nativeEvents, 'source reload retains the selected native conversation without navigation');
    assert.deepEqual(f.rich(), richB); assert.equal(replacement.capture().conversation_id, b.conversation_id);
    await replacement.restore(a, snapshotA); assert.deepEqual(f.rich(), richA);
    assert.equal(f.sent.length, 0); assert.equal(f.http.length, 0, 'open/switch/restore never allocate, prepare, or send');
    assert.equal(hub.originalSend, f.originalSend);
    replacement.destroy();
    console.log('PASS: same-stage conversation A/B native rich drafts, opaque identity persistence and source reload isolation');
  }
  {
    let releaseBind; const barrier = new Promise(resolve => { releaseBind = resolve; });
    const f = fixture({ api: async (url, body) => { if (url.endsWith('/bind') && body.checkpoint === 'allocated') await barrier; } });
    const a = f.remember(f.context({ conversation_id: 'pending-a' }));
    const b = f.remember(f.context({ conversation_id: 'pending-b' }));
    await f.adapter.open(a);
    f.send('thread/start', { cwd: a.cwd }, 'conversation-pending-a'); await settle(() => f.sent.length === 1);
    f.reply('conversation-pending-a', { thread: { id: 'conversation-thread-a' } }); await tick();
    await f.adapter.open(b); releaseBind(); await settle(() => f.bounds.length === 1);
    assert.equal(f.bounds[0].target.conversation_id, a.conversation_id); assert.equal(f.bounds[0].context.conversation_id, a.conversation_id);
    assert.equal(f.adapter.getCurrentContext().conversation_id, b.conversation_id); assert.equal(f.adapter.getCurrentContext().thread_id, '', 'A binding cannot overwrite visible B even within one project/stage');
    const raw = [{ type: 'skill', name: 'architecture', path: 'C:\\Skills\\SKILL.md' }, { type: 'text', text: 'Original native input' }, { type: 'localImage', path: 'D:\\图片.png' }];
    const first = f.send('turn/start', { threadId: 'conversation-thread-a', input: raw }, 'conversation-first-a');
    await settle(() => f.sent.length === 2); assert.equal(f.sent.at(-1), first);
    f.reply('conversation-first-a', { turn: { id: 'conversation-turn-a' } }); await settle(() => f.turns.length === 1);
    const second = f.send('turn/start', { threadId: 'conversation-thread-a', input: raw }, 'conversation-followup-a');
    await settle(() => f.sent.length === 3); assert.equal(f.sent.at(-1), second);
    assert.equal(new URL(f.http.find(x => x.url.includes('/context?')).url, 'https://fixture.invalid').searchParams.get('conversation_id'), a.conversation_id, 'inactive bound thread refreshes its own exact conversation');
    f.reply('conversation-followup-a', { turn: { id: 'conversation-followup-turn-a' } }); await settle(() => f.turns.length === 2);
    for (const request of f.http.filter(x => /\/(prepare|bind|receipt)$/.test(x.url))) assert.equal(request.body.conversation_id, a.conversation_id);
    assert.equal(f.adapter.capture().conversation_id, b.conversation_id); assert.equal(f.sent.filter(x => x.request?.method === 'thread/start').length, 1);
    f.adapter.destroy(); console.log('PASS: same-stage binding switch, originating callbacks and exact-conversation follow-up reservation');
  }
  {
    let releaseBind; const barrier = new Promise(resolve => { releaseBind = resolve; });
    const f = fixture({ api: async (url, body) => { if (url.endsWith('/bind') && body.checkpoint === 'allocated') await barrier; } });
    const a = f.remember(f.context({ conversation_id: 'reload-a' }));
    await f.adapter.open(a); const snapshot = f.adapter.capture();
    f.send('thread/start', { cwd: a.cwd }, 'conversation-reload-a'); await settle(() => f.sent.length === 1);
    f.reply('conversation-reload-a', { thread: { id: 'conversation-reload-thread' } }); await tick();
    const hub = f.root.__betterCodexNativeConversationHub__;
    f.adapter.destroy(); f.reloadSource();
    const replacement = f.root.BetterCodexNativeConversation.create(f.options); await replacement.restore(a, snapshot);
    assert.equal(f.root.__betterCodexNativeConversationHub__, hub); assert.equal(hub.originalSend, f.originalSend);
    releaseBind(); await settle(() => f.bounds.length === 1);
    assert.equal(replacement.getCurrentContext().conversation_id, a.conversation_id); assert.equal(replacement.getCurrentContext().thread_id, 'conversation-reload-thread');
    assert.equal(f.delivered.filter(x => x.message?.id === 'conversation-reload-a').length, 1);
    f.send('turn/start', { threadId: 'conversation-reload-thread', input: [] }, 'conversation-reload-first-turn'); await settle(() => f.sent.length === 2);
    f.reply('conversation-reload-first-turn', { turn: { id: 'conversation-reload-turn' } }); await settle(() => f.turns.length === 1);
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 1, 'source reload preserves the pending first-send slot');
    assert.equal(f.sent.filter(x => x.request?.method === 'thread/start').length, 1);
    replacement.destroy(); assert.equal(f.sender.postMessage, f.originalSend);
    console.log('PASS: conversation-aware in-flight source upgrade without stacked hooks, duplicate allocation or duplicate delivery');
  }
  {
    const f = fixture({ enrollLegacy: 'enrolled-legacy' });
    const legacy = f.remember(f.context()); await f.adapter.open(legacy); const originalId = f.nativeDraft();
    f.send('thread/start', { cwd: legacy.cwd }, 'enroll-legacy'); await settle(() => f.sent.length === 1);
    f.reply('enroll-legacy', { thread: { id: 'enrolled-thread' } }); await settle(() => f.bounds.length === 1);
    assert.equal(f.bounds[0].target.conversation_id, undefined, 'callback preserves the original legacy sending identity');
    assert.equal(f.bounds[0].context.conversation_id, 'enrolled-legacy'); assert.equal(f.adapter.capture().conversation_id, 'enrolled-legacy');
    assert.equal(f.nativeDraft(), originalId, 'legacy enrollment keeps the original native rich draft scope');
    f.send('turn/start', { threadId: 'enrolled-thread', input: [] }, 'enrolled-first-turn'); await settle(() => f.sent.length === 2);
    f.reply('enrolled-first-turn', { turn: { id: 'enrolled-turn' } }); await settle(() => f.turns.length === 1);
    assert(f.http.filter(x => /\/(bind|receipt)$/.test(x.url)).every(x => x.body.conversation_id === 'enrolled-legacy'));
    await f.adapter.open(f.context({ conversation_id: 'enrolled-legacy' })); assert.equal(f.nativeDraft(), originalId, 'canonical identity aliases the persisted legacy draft key');
    const work = await f.adapter.open(f.context({ kind: 'work', issue_id: 'compat-work', conversation_id: 'ignored-work-id' }));
    assert.equal(work.context.conversation_id, 'ignored-work-id', 'work retains a conversation identity within the task');
    f.adapter.destroy();
  }
  {
    const f = fixture();
    const a = f.remember(f.context({ kind: 'work', issue_id: 'task-one', conversation_id: 'work-a' }));
    const b = f.remember(f.context({ kind: 'work', issue_id: 'task-one', conversation_id: 'work-b' }));
    await f.adapter.open(a); const aId = f.nativeDraft();
    const richA = { draft: { prompt: 'Task A draft' }, view_state: { imageAttachments: [], fileAttachments: [{ path: 'a.png' }], attachmentOrder: ['file:a'] }, document_json: { type: 'doc', content: [] } };
    f.setRich(richA);
    await f.adapter.open(b); const bId = f.nativeDraft();
    assert.notEqual(aId, bId, 'same-task work conversations have independent native drafts');
    const richB = { draft: { prompt: 'Task B draft' }, view_state: { imageAttachments: [], fileAttachments: [], attachmentOrder: [] }, document_json: { type: 'doc', content: [{ type: 'skill_mention', attrs: { name: 'project-reader' } }] } };
    f.setRich(richB);
    await f.adapter.open(a); assert.deepEqual(f.rich(), richA);
    await f.adapter.open(b); assert.deepEqual(f.rich(), richB);
    assert.equal(f.http.length, 0, 'switching work drafts never prepares or sends a model turn');
    f.adapter.destroy();
  }
  {
    const f = fixture({ discovery: true }); await f.adapter.open(f.context({ conversation_id: 'layout-conversation' }));
    assert.deepEqual(plain(f.adapter.inspectLayout()), { available: true, composer_visible: true, ancestry_consistent: true, route_kind: 'home', context_matches: true }, 'four-column layout retains all native providers under the same editor');
    f.nativeElement.parentElement = { inert: true, hasAttribute: name => name === 'data-better-codex-inline-blocked' };
    assert.equal(f.adapter.inspectLayout().available, true, 'owned loading protection permits read-only native scope inspection');
    f.nativeElement.parentElement = { hidden: true }; assert.equal(f.adapter.inspectLayout().available, false, 'hidden retained page cannot be used as active scope');
    f.nativeElement.parentElement = { inert: true }; assert.equal(f.adapter.inspectLayout().available, false, 'native inert cache is not the active composer');
    f.nativeElement.parentElement = undefined; f.adapter.destroy();
  }
  {
    const f = fixture({ api: (url) => { if (url.endsWith('/validate-input')) throw Error('skill_project_mismatch'); } });
    await f.adapter.open(f.remember(f.context({kind:'work',issue_id:'task-scoped',conversation_id:'scoped-work',mode:'thread',thread_id:'scoped-thread'})));
    f.send('turn/start',{threadId:'scoped-thread',input:[{type:'skill',name:'foreign-project-skill',path:'C:\\foreign\\SKILL.md'}]},'foreign-skill');
    await settle(()=>f.delivered.some(item=>item.message?.id==='foreign-skill'));
    assert.equal(f.sent.length,0,'rejected project Skill cannot reach native model execution');
    assert.match(f.delivered.find(item=>item.message?.id==='foreign-skill').message.error.message,/所属的项目/);
    assert.equal(f.http.filter(item=>item.url.endsWith('/prepare')).length,0,'invalid Skill is rejected before an execution reservation');
    f.adapter.destroy();
  }
  {
    const f = fixture(); await f.adapter.connect(); f.host.restoreDraft = () => { throw Error('Native composer not ready'); };
    const result = await f.adapter.open(f.context({ conversation_id: 'failed-view' })); assert.equal(result.mode, 'unavailable');
    f.send('thread/start', { cwd: f.context().cwd }, 'failed-page-send'); assert.equal(f.sent.length, 0); assert.equal(f.http.length, 0);
    f.send('turn/start', { threadId: 'ordinary-old-thread', input: [] }, 'failed-page-old-turn'); assert.equal(f.sent.length, 0, 'failed owned viewport cannot send through its stale native editor');
    f.dispatcher.dispatchHostMessage({ type: 'navigate-to-route', path: '/settings' });
    const ordinary = f.send('thread/start', { cwd: f.context().cwd }, 'ordinary-after-failed-page'); assert.equal(f.sent.at(-1), ordinary, 'leaving restores normal native interaction');
    f.adapter.destroy();
  }
  {
    const f = fixture();
    await f.adapter.open(f.remember(f.context()));
    const oldHub = f.root.__betterCodexNativeConversationHub__;
    const oldHook = f.sender.postMessage;
    f.reloadSource();
    const newProfile = { ...f.host, profileVersion: 'upgraded-source' };
    const replacement = f.root.BetterCodexNativeConversation.create({ ...f.options, host: newProfile });
    await replacement.connect();
    assert.equal(f.root.__betterCodexNativeConversationHub__, oldHub, 'source upgrade retains shared IPC request ownership');
    assert.equal(oldHub.host.profileVersion, 'upgraded-source');
    assert.notEqual(f.sender.postMessage, oldHook, 'new source upgrades handler function bodies');
    assert.equal(oldHub.originalSend, f.originalSend, 'an upgrade never wraps another wrapper');
    assert.equal(oldHub.originalDeliver, f.originalDeliver);
    assert.equal(f.sent.length, 0); assert.equal(f.http.length, 0);
    replacement.destroy(); f.adapter.destroy();
    assert.equal(f.sender.postMessage, f.originalSend);
  }
  {
    const f = fixture();
    const context = f.context();
    await f.adapter.open(context);
    const snapshot = f.adapter.capture();
    f.adapter.destroy();
    const afterSnapshot = { draft: { prompt: 'Input continued after source snapshot', pullRequestChecks: [] }, view_state: { imageAttachments: [], fileAttachments: [], attachmentOrder: [] }, document_json: { type: 'doc', content: [{ type: 'text', text: 'Input continued after source snapshot' }] } };
    f.setRich(afterSnapshot);
    const events = f.delivered.length;
    const replacement = f.root.BetterCodexNativeConversation.create(f.options);
    await replacement.restore(context, snapshot);
    assert.equal(f.delivered.length, events, 'same genuine native scope is reused without even navigation on reload');
    assert.deepEqual(f.rich(), afterSnapshot, 'a reload must not overwrite input entered after its captured snapshot');
    assert.equal(f.sent.length, 0); assert.equal(f.http.length, 0);
    replacement.destroy();
  }
  {
    const stored = new Map();
    let finishOrdinaryRestore;
    const f = fixture({ draftStorage: { set: async (id, value) => stored.set(id, value), get: async id => id === 'client-new-thread:original-native-draft' ? new Promise(resolve => { finishOrdinaryRestore = resolve; }) : stored.get(id) } });
    await f.adapter.open(f.context());
    f.adapter.leave();
    assert.equal(f.nativeDraft(), 'client-new-thread:original-native-draft', 'explicit leave restores ordinary home identity');
    const replacement = f.root.BetterCodexNativeConversation.create(f.options);
    await replacement.connect();
    const freshNative = { draft: { prompt: 'New native owner', pullRequestChecks: [] }, view_state: { imageAttachments: [], fileAttachments: [], attachmentOrder: [] }, document_json: { type: 'doc', content: [{ type: 'text', text: 'New native owner' }] } };
    f.setRich(freshNative);
    finishOrdinaryRestore(stored.get('client-new-thread:original-native-draft'));
    await settle();
    assert.deepEqual(f.rich(), freshNative, 'late leave must not write into the replacement native controller');
    replacement.destroy(); f.adapter.destroy();
  }
  {
    const f = fixture();
    const work = f.remember(f.context({ kind: 'work', issue_id: 'existing-native-work', thread_id: 'already-open-native-thread', mode: 'thread', expected_revision: 9 }));
    const registered = f.adapter.registerBindings([{ project_id: work.project_id, kind: work.kind, issue_id: work.issue_id, thread_id: work.thread_id, host_id: 'local' }, { ...work, host_id: 'foreign' }, { ...work, issue_id: undefined }]);
    assert.equal(registered.registered, 0, 'startup registry waits for connection without installing or navigating');
    await f.adapter.connect();
    assert.equal(f.sent.length, 0); assert.equal(f.delivered.length, 0); assert.equal(f.http.length, 0, 'trusted startup registry does not open any conversation');
    const original = f.send('turn/start', { threadId: work.thread_id, input: [{ type: 'text', text: 'Real native follow-up' }] }, 'startup-followup');
    assert.equal(f.sent.length, 0, 'already-open native bound work task must get execution gate even without Better open');
    await settle(() => f.sent.length === 1);
    assert.equal(f.sent[0].request.params.input, original.request.params.input, 'bound work followup keeps the original native input');
    assert(Object.values(f.sent[0].request.params.additionalContext).some(entry=>entry.value.includes(work.issue_id)), 'startup registry supplies the bound task context');
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 1);
    assert.equal(f.http.find(x => x.url.endsWith('/prepare')).body.expected_revision, 9, 'minimal startup registry refreshes authoritative task version before sending');
    f.adapter.registerBindings([]);
    assert(f.root.__betterCodexNativeConversationHub__.threads.has('local:' + work.thread_id), 'registry replacement must keep an in-flight receipt scope');
    f.reply('startup-followup', { turn: { id: 'startup-native-turn' } });
    await settle(() => f.turns.length === 1);
    assert(!f.root.__betterCodexNativeConversationHub__.threads.has('local:' + work.thread_id), 'retired binding unlinks after the in-flight reply completes');
    const archived = f.send('turn/start', { threadId: work.thread_id, input: [] }, 'ordinary-archived-native');
    assert.equal(f.sent.at(-1), archived, 'archived/unlinked thread resumes ordinary native routing');
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 1);
    f.adapter.destroy();
  }
  {
    const f = fixture({ indexedDB: true });
    const charter = f.remember(f.context());
    const original = await f.adapter.open(charter);
    const binary = new Blob(['native image bytes'], { type: 'image/png' });
    const rich = { draft: { prompt: { document: { type: 'doc', content: [{ type: 'skill_mention', attrs: { path: 'C:\\Skills\\SKILL.md' } }] } }, pullRequestChecks: [] }, document_json: { type: 'doc', content: [{ type: 'skill_mention', attrs: { path: 'C:\\Skills\\SKILL.md' } }] }, view_state: { imageAttachments: [{ id: 'blob-image', file: binary }], attachmentOrder: ['image:blob-image'], fileAttachments: [] } };
    f.setRich(rich);
    await f.adapter.open(f.context({ kind: 'planning' }));
    await settle(() => f.root.__betterCodexNativeDraftState__.pending.size === 0);
    f.adapter.destroy();
    await settle();
    delete f.root.__betterCodexNativeDraftState__;
    f.root.sessionStorage = { getItem: () => null, setItem() {} };
    const restarted = f.root.BetterCodexNativeConversation.create(f.options);
    const restored = await restarted.open(charter);
    assert.equal(restored.context.client_draft_id, original.context.client_draft_id);
    assert.deepEqual(f.rich().document_json, rich.document_json, 'native rich document persists independently of adapter memory');
    assert.equal(await f.rich().view_state.imageAttachments[0].file.text(), 'native image bytes', 'structured clone preserves native binary attachment');
    assert.equal(f.rich().view_state.imageAttachments[0].file.type, 'image/png');
    assert.equal(f.sent.length, 0, 'binary draft persistence never sends a model request');
    restarted.destroy();
  }
  {
    const f = fixture();
    const charter = f.remember(f.context());
    const first = await f.adapter.open(charter);
    assert.equal(first.mode, 'draft');
    assert.equal(f.sent.length, 0, 'opening must not emit a native server request');
    assert.equal(f.http.length, 0, 'opening must not prepare or bind');
    assert.equal(f.nativeRoute(), '/projects?projectId=native-project', 'use native project composer instead of an unregistered worktree client route');
    assert.equal(f.nativeDraft(), first.context.client_draft_id, 'native identity setter selects a distinct retained composer draft');
    assert.equal(f.delivered.filter(x => x.type === 'navigate-to-route').length, 1);
    assert(!f.delivered.some(x => x.prefillPrompt || x.prompt), 'navigation must not prefill input');
    const rich = { draft: { prompt: { document: { type: 'doc', content: [{ type: 'skill_mention', attrs: { name: 'project-skill', path: 'C:\\原生Skills\\SKILL.md' } }] }, plainTextMode: false }, pullRequestChecks: [] }, document_json: { type: 'doc', content: [{ type: 'skill_mention', attrs: { name: 'project-skill', path: 'C:\\原生Skills\\SKILL.md' } }, { type: 'paragraph', content: [{ type: 'text', text: 'Unsent native request' }] }] }, view_state: { imageAttachments: [{ id: 'native-image', nativeField: { path: 'D:\\图片.png' } }], attachmentOrder: ['image:native-image', 'file:native-file'], fileAttachments: [{ id: 'native-file', path: 'E:\\附件.pdf' }] } };
    f.setRich(rich);
    const planning = await f.adapter.open(f.remember(f.context({ kind: 'planning' })));
    assert.notEqual(planning.context.client_draft_id, first.context.client_draft_id, 'stages must own different native draft keys');
    assert.equal(f.rich().draft, undefined, 'home composer singleton must not leak another target input');
    assert.equal(f.rich().view_state.imageAttachments.length, 0, 'home image/order singleton must not leak another target attachments');
    const same = await f.adapter.open(charter);
    assert.equal(same.context.client_draft_id, first.context.client_draft_id, 'a target restores its native draft');
    assert.deepEqual(f.rich(), rich, 'raw native Skill document, file metadata and attachment order restore together');
    assert.equal(f.delivered.filter(x => x.type === 'navigate-to-route').at(-1).state.focusComposerNonce, first.context.client_draft_id, 'target uses a stable genuine native ComposerScope');
    const saved = plain(f.adapter.capture());
    await f.adapter.restore(charter, saved);
    assert.equal(f.sent.length, 0, 'restore must never start or send');
    const restart = await f.adapter.open(f.remember(f.context({ draft_generation: 1 })));
    assert.notEqual(restart.context.client_draft_id, first.context.client_draft_id, 'explicit restart gets an empty native draft key');
    const fresh = await f.adapter.restore(f.context({ draft_generation: 1 }), saved);
    assert.equal(fresh.context.client_draft_id, restart.context.client_draft_id, 'a stale reload snapshot cannot restore the pre-restart draft');
    assert.equal(f.rich().draft, undefined, 'explicit restart does not reuse the prior rich composer document');
    f.adapter.destroy();
    assert.equal(f.nativeDraft(), restart.context.client_draft_id, 'source destroy preserves selected native draft identity');
    assert.equal(f.sender.postMessage, f.originalSend, 'sender hook must unload');
    assert.equal(f.dispatcher.deliverOrBufferMessage, f.originalDeliver, 'dispatcher hook must unload');
    f.root.sessionStorage = { getItem: () => null, setItem() {} };
    const reinstalled = f.root.BetterCodexNativeConversation.create(f.options);
    const afterRestart = await reinstalled.open(charter);
    assert.equal(afterRestart.context.client_draft_id, first.context.client_draft_id, 'opaque target identity survives a cleared desktop session');
    assert.deepEqual(f.rich(), rich, 'desktop restart loads native serialized draft fields without flattening Skills or attachments');
    reinstalled.destroy();
  }
  {
    const f = fixture();
    await f.adapter.open(f.remember(f.context()));
    const nativeDefaults = { cwd: 'D:\\中文项目', model: 'native-model', reasoningEffort: 'ultra', approvalPolicy: 'on-request', serviceTier: 'fast', config: { keep: true }, dynamicTools: [{ name: 'native_tool', description: 'native', inputSchema: {} }] };
    const request = f.send('thread/start', nativeDefaults, 'first-thread');
    assert.equal(f.sent.length, 0, 'native thread allocation waits for trusted prepare');
    await settle(() => f.sent.length === 1);
    const outgoing = f.sent[0];
    for (const field of ['model', 'reasoningEffort', 'approvalPolicy', 'serviceTier', 'config']) assert.deepEqual(outgoing.request.params[field], nativeDefaults[field]);
    assert.deepEqual(plain(outgoing.request.params.runtimeWorkspaceRoots), ['D:\\中文项目', 'E:\\关联后台']);
    assert.equal(outgoing.request.params.dynamicTools[0], nativeDefaults.dynamicTools[0], 'existing native tools retain their structure');
    assert.equal(outgoing.request.params.dynamicTools.length, 6);
    assert.deepEqual(request.request.params, nativeDefaults, 'caller-owned request is not mutated');
    f.reply('first-thread', { thread: { id: 'bound-thread', cwd: 'D:\\中文项目', path: 'native' } });
    assert(!f.delivered.some(x => x.message?.id === 'first-thread'), 'thread reply is held until binding checkpoints complete');
    await settle(() => f.bounds.length === 1);
    const checkpoints = f.http.filter(x => x.url.endsWith('/bind')).map(x => x.body.checkpoint);
    assert.deepEqual(checkpoints, ['allocated', 'bound']);
    assert.equal(f.bounds[0].target.project_id, 'project-one', 'callback keeps originating target');
    const rawInput = [{ type: 'text', text: '$my-skill\nActual user request', text_elements: [{ start: 0, end: 9 }] }, { type: 'localImage', path: 'D:\\图片.png' }, { type: 'skill', name: 'my-skill', path: 'C:\\skills\\my-skill\\SKILL.md' }];
    const firstTurn = f.send('turn/start', { threadId: 'bound-thread', input: rawInput, collaborationMode: { mode: 'plan', settings: { effort: 'native' } } }, 'first-turn');
    await settle(() => f.sent.some(x => x.request?.id === 'first-turn'));
    assert.equal(f.sent.at(-1), firstTurn, 'native turn message and attachments remain untouched');
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 1, 'first turn reuses initial allocation reservation');
    f.reply('first-turn', { turn: { id: 'real-turn' } });
    await settle(() => f.turns.length === 1);
    assert.equal(f.http.at(-1).body.status, 'accepted');
    assert.equal(f.turns[0].target.kind, 'charter');
    f.send('turn/start', { threadId: 'bound-thread', input: rawInput }, 'followup');
    await settle(() => f.sent.some(x => x.request?.id === 'followup'));
    assert.equal(f.sent.filter(x => x.request?.method === 'thread/start').length, 1, 'followup never allocates a second thread');
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 2, 'followup receives an execution reservation');
    f.reply('followup', { turn: { id: 'followup-turn' } });
    await settle(() => f.turns.length === 2);
    f.adapter.leave();
    const serverRequest = { id: 'tool-request', method: 'item/tool/call', params: { threadId: 'bound-thread', turnId: 'real-turn', callId: 'call-one', tool: 'better_codex_project_charter_save', arguments: { sections: [{ id: 'scope', content: 'Document' }], expected_revision: 0 } } };
    f.dispatcher.dispatchHostMessage({ type: 'dynamic-tool-call-requested', hostId: 'local', serverRequest });
    await settle(() => f.sent.some(x => x.response?.id === 'tool-request'));
    const toolPost = f.http.find(x => x.url.endsWith('/tool'));
    assert.equal(toolPost.body.thread_id, 'bound-thread', 'tool scope is trusted server thread, independent of current page');
    assert(!('project_id' in toolPost.body.arguments), 'user never needs project or thread IDs in tool arguments');
    assert(!f.delivered.some(x => x.type === 'dynamic-tool-call-requested'), 'owned dynamic tool is not dispatched twice');
    const toolResponse = f.sent.find(x => x.response?.id === 'tool-request');
    assert.equal(toolResponse.requestMethod, 'item/tool/call'); assert.equal(toolResponse.response.result.success, true);
    f.dispatcher.dispatchHostMessage({ type: 'dynamic-tool-call-requested', hostId: 'local', serverRequest });
    await settle(() => f.sent.filter(x => x.response?.id === 'tool-request').length === 2);
    assert.equal(f.http.filter(x => x.url.endsWith('/tool')).length, 1, 'duplicate tool envelope is replayed without a second write');
    const foreign = { type: 'dynamic-tool-call-requested', hostId: 'local', serverRequest: { id: 'foreign', method: 'item/tool/call', params: { tool: 'native_tool', threadId: 'bound-thread' } } };
    f.dispatcher.dispatchHostMessage(foreign);
    assert.equal(f.delivered.at(-1), foreign, 'foreign namespace belongs to native handler');
    f.adapter.destroy();
  }
  {
    const f = fixture(); await f.adapter.open(f.remember(f.context()));
    f.sender.postMessage({ type: 'thread-prewarm-start', hostId: 'local', request: { id: 'prewarm-owned', method: 'thread/start', params: { cwd: 'D:\\中文项目' } } });
    assert.equal(f.sent.length, 0); assert.equal(f.delivered.at(-1).message.id, 'prewarm-owned');
    const other = { type: 'thread-prewarm-start', hostId: 'local', request: { id: 'prewarm-other', method: 'thread/start', params: { cwd: 'F:\\other' } } };
    f.sender.postMessage(other); assert.equal(f.sent.at(-1), other, 'unrelated prewarming remains native');
    const explicit = f.send('thread/start', { cwd: 'D:\\中文项目' }, 'queue-owned', { source: 'better-codex' });
    assert.equal(f.sent.at(-1), explicit); assert.equal(f.http.length, 0, 'explicit scheduler requests retain their existing execution reservation');
    f.send('turn/start', { threadId: 'projectless-warm-thread', input: [{ type: 'text', text: 'request' }] }, 'wrong-warm');
    assert.equal(f.sent.length, 2, 'unbound warm reservation cannot receive the Better draft');
    assert.equal(f.delivered.at(-1).message.id, 'wrong-warm');
    f.dispatcher.dispatchHostMessage({ type: 'new-chat' });
    const normal = f.send('thread/start', { cwd: 'D:\\中文项目' }, 'native-same-cwd');
    assert.equal(f.sent.at(-1), normal, 'same cwd outside Better viewport is never intercepted');
    assert.equal(f.away.length, 1); f.adapter.destroy();
  }
  {
    const f = fixture();
    await f.adapter.open(f.remember(f.context()));
    const explicit = f.send('turn/start', { threadId: 'explicit-owned-thread', input: [{ type: 'text', text: 'Explicit reserved task input' }] }, 'explicit-reserved-turn', { source: 'better-codex' });
    assert.equal(f.sent.at(-1), explicit, 'explicit execution keeps its own binding/reservation while a Better draft is visible');
    const remote = f.send('turn/start', { threadId: 'remote-native-thread', input: [{ type: 'text', text: 'Remote native input' }] }, 'remote-native-turn', { hostId: 'remote-host' });
    assert.equal(f.sent.at(-1), remote, 'an unrelated host keeps its native first-turn delivery');
    assert.equal(f.http.length, 0, 'unrelated reservations are neither prepared nor rebound to the visible draft');
    assert.equal(f.errors.length, 0, 'unrelated native task input does not surface a draft-binding error');
    f.send('turn/start', { threadId: 'local-unbound-warm', input: [{ type: 'text', text: 'Wrong warm reservation' }] }, 'local-unbound-turn');
    assert.equal(f.sent.length, 2, 'local ordinary warm input remains blocked until its Better binding exists');
    assert.equal(f.delivered.at(-1).message.id, 'local-unbound-turn');
    assert.match(f.delivered.at(-1).message.error.message, /尚未绑定/);
    f.adapter.destroy();
    console.log('PASS: draft binding guard preserves explicit reservations and foreign hosts while rejecting unbound local warm turns');
  }
  {
    const f = fixture({ api: (url, body) => { if (url.endsWith('/bind') && body.checkpoint === 'bound') throw Error('binding failure'); } });
    await f.adapter.open(f.remember(f.context()));
    f.send('thread/start', { cwd: 'D:\\中文项目' }, 'failed-binding'); await settle(() => f.sent.length === 1);
    f.reply('failed-binding', { thread: { id: 'allocated-only' } }); await settle(() => f.errors.length > 0);
    assert.equal(f.bounds.length, 0);
    assert(f.delivered.find(x => x.message?.id === 'failed-binding').message.error, 'binding failure blocks native start continuation');
    assert.equal(f.http.at(-1).body.status, 'outcome_unknown', 'allocated thread is recorded for recovery instead of duplicate retry');
    assert.equal(f.errors[0].origin.project_id, 'project-one'); f.adapter.destroy();
  }
  {
    const f = fixture();
    await f.adapter.open(f.remember(f.context({ kind: 'work', issue_id: 'work-one', mode: 'legacy_busy' })));
    assert.equal(f.sent.length, 0); assert.equal(f.delivered.length, 0); assert.equal(f.http.length, 0);
    await f.adapter.open(f.context({ kind: 'work', issue_id: 'work-one', mode: 'handoff_required' }));
    assert.equal(f.delivered.length, 0, 'opening must never transfer legacy thread ownership');
    f.adapter.destroy();
  }
  {
    const f = fixture({ memoryRouter: true }); await f.adapter.open(f.remember(f.context()));
    assert(f.adapter.ownsRoute('/index.html'), 'Electron memory-router shell owns tracked draft route');
    f.send('thread/start', { cwd: 'D:\\中文项目' }, 'memory-route'); await settle(() => f.sent.length === 1);
    f.reply('memory-route', { thread: { id: 'memory-thread' } }); await settle(() => f.bounds.length === 1);
    f.dispatcher.dispatchHostMessage({ type: 'navigate-to-route', path: '/settings' });
    assert.equal(f.adapter.getCurrentContext(), null, 'native navigation releases Better ownership'); f.adapter.destroy();
  }
  {
    let finishBind;
    const barrier = new Promise(resolve => { finishBind = resolve; });
    const f = fixture({ api: async (url, body) => { if (url.endsWith('/bind') && body.checkpoint === 'allocated') await barrier; } });
    const context = f.remember(f.context());
    await f.adapter.open(context);
    const snapshot = f.adapter.capture();
    f.send('thread/start', { cwd: context.cwd }, 'source-upgrade-pending');
    await settle(() => f.sent.length === 1);
    f.reply('source-upgrade-pending', { thread: { id: 'source-upgrade-thread' } });
    await tick();
    const originalHub = f.root.__betterCodexNativeConversationHub__;
    f.adapter.destroy(); f.reloadSource();
    const replacement = f.root.BetterCodexNativeConversation.create(f.options);
    await replacement.restore(context, snapshot);
    assert.equal(f.root.__betterCodexNativeConversationHub__, originalHub);
    assert.equal(originalHub.originalSend, f.originalSend);
    finishBind(); await settle(() => f.bounds.length === 1);
    assert.equal(replacement.getCurrentContext().thread_id, 'source-upgrade-thread', 'late binding transfers ownership into matching replacement client before native delivery');
    assert.equal(replacement.getCurrentContext().mode, 'thread');
    assert.equal(f.delivered.filter(x => x.message?.id === 'source-upgrade-pending').length, 1, 'upgraded source delivers native held reply once');
    assert.equal(f.sent.length, 1, 'source upgrade never repeats thread allocation');
    const request = f.send('turn/start', { threadId: 'source-upgrade-thread', input: [{ type: 'text', text: 'Original native first input' }] }, 'source-upgrade-first-turn');
    await settle(() => f.sent.length === 2);
    assert.equal(f.sent[1], request);
    assert.equal(f.http.filter(x => x.url.endsWith('/prepare')).length, 1, 'upgrade preserves first-turn execution reservation');
    f.reply('source-upgrade-first-turn', { turn: { id: 'source-upgrade-turn' } });
    await settle(() => f.turns.length === 1);
    replacement.destroy(); assert.equal(f.sender.postMessage, f.originalSend);
  }
  {
    let releaseBind; const barrier = new Promise(resolve => { releaseBind = resolve; });
    const f = fixture({ api: async (url, body) => { if (url.endsWith('/bind') && body.checkpoint === 'allocated') await barrier; } });
    await f.adapter.open(f.remember(f.context())); f.send('thread/start', { cwd: 'D:\\中文项目' }, 'hot-reload'); await settle(() => f.sent.length === 1);
    f.reply('hot-reload', { thread: { id: 'reload-thread' } }); await tick();
    const wrapped = f.sender.postMessage; f.adapter.destroy();
    assert.equal(f.sender.postMessage, wrapped, 'in-flight binding retains response barrier through reload');
    const next = f.root.BetterCodexNativeConversation.create(f.options);
    await next.open(f.remember(f.context({ kind: 'planning' })));
    assert.equal(f.sender.postMessage, wrapped, 'new adapter reuses one IPC hook instead of stacking');
    releaseBind(); await settle(() => f.bounds.length === 1);
    assert.equal(next.getCurrentContext().kind, 'planning', 'late binding cannot overwrite switched stage');
    next.destroy(); assert.equal(f.sender.postMessage, f.originalSend);
  }
  {
    const f = fixture({ api: (url, body) => {
      if (!url.endsWith('/tool')) return;
      if (body.thread_id !== 'durable-restored-thread') throw Error('native_binding_required');
      return { revision: 8 };
    } });
    await f.adapter.connect();
    const request = id => ({ type: 'dynamic-tool-call-requested', hostId: 'local', serverRequest: { id, method: 'item/tool/call', params: { threadId: id === 'restored' ? 'durable-restored-thread' : 'unbound-thread', callId: id + '-call', tool: 'better_codex_project_context_read', arguments: {} } } });
    f.dispatcher.dispatchHostMessage(request('restored'));
    await settle(() => f.sent.length === 1);
    assert.equal(f.sent[0].response.result.success, true, 'restored native thread uses durable backend scope without opening a Better page');
    assert.equal(f.adapter.getCurrentContext(), null);
    f.dispatcher.dispatchHostMessage(request('unbound'));
    await settle(() => f.sent.length === 2);
    assert.equal(f.sent[1].response.result.success, false, 'backend retains permission checks for unbound native threads');
    assert(!f.sent.some(x => x.request), 'connect/tool restoration never sends a model request');
    f.adapter.destroy();
  }
  {
    const f = fixture({ discovery: true });
    await f.adapter.connect();
    assert.equal(f.adapter.capabilities().available, true, 'real mutable native IPC objects are found after a fabricated RPC proxy');
    assert.equal(f.sent.length, 0); assert.equal(f.delivered.length, 0); assert.equal(f.http.length, 0, 'connect only installs hooks');
    f.adapter.destroy(); assert.equal(f.sender.postMessage, f.originalSend);
  }
  {
    const f = fixture();
    const nativeCalls = [];
    f.root.addEventListener('message', event => nativeCalls.push(event.data));
    await f.adapter.connect();
    const scoped = f.remember(f.context({kind:'work',issue_id:'bound-task',thread_id:'bound-work',mode:'thread'}));
    await f.adapter.open(scoped);
    const call = {type:'dynamic-tool-call-requested',hostId:'local',serverRequest:{id:'window-tool',method:'item/tool/call',params:{namespace:null,threadId:'bound-work',callId:'window-call',tool:'better_codex_project_context_read',arguments:{}}}};
    const dispatch = (data, overrides = {}) => f.root.dispatchEvent({type:'message',data,source:f.root,origin:f.root.location.origin,...overrides});
    dispatch(call);
    await settle(()=>f.sent.some(message=>message.response?.id==='window-tool'));
    assert.equal(nativeCalls.length,0,'capture owns project calls before the independent native namespace executor');
    assert.equal(f.http.filter(entry=>entry.url.endsWith('/tool')).length,1);
    assert.equal(f.sent.find(message=>message.response?.id==='window-tool').response.result.success,true);
    dispatch(call);
    await settle(()=>f.sent.filter(message=>message.response?.id==='window-tool').length===2);
    assert.equal(f.http.filter(entry=>entry.url.endsWith('/tool')).length,1,'window replay does not execute twice');
    const foreign = {...call,serverRequest:{...call.serverRequest,params:{...call.serverRequest.params,tool:'native_tool'}}};
    dispatch(foreign); dispatch(call,{source:{}}); dispatch(call,{origin:'https://foreign.invalid'});
    dispatch({...call,hostId:'remote-host'});
    dispatch({...call,serverRequest:{...call.serverRequest,params:{...call.serverRequest.params,namespace:'codex_app'}}});
    assert.equal(nativeCalls.length,5,'unrelated tools and foreign envelopes/namespaces remain with native handlers');
    f.reloadSource();
    const next = f.root.BetterCodexNativeConversation.create(f.options);
    await next.open(scoped);
    assert.equal(f.messageListeners.filter(entry=>entry.capture).length,1,'source reload replaces the project capture listener');
    f.adapter.destroy(); next.destroy();
    assert.equal(f.messageListeners.filter(entry=>entry.capture).length,0,'last client release removes the capture listener');
    dispatch(call); assert.equal(nativeCalls.length,6,'native handling resumes after release');
    console.log('PASS: real window dynamic-tool routing, null namespace capture, single response, foreign isolation and reload/release lifecycle');
  }
  {
    const f = fixture();
    const draft=f.remember(f.context({kind:'work',issue_id:'task-context-one',conversation_id:'work-context-one'}));
    await f.adapter.open(draft);assert.equal(f.sent.length,0,'opening work does not send task context or start a model turn');
    f.send('thread/start',{cwd:draft.cwd,model:'native-model',developerInstructions:'native instructions'},'work-context-start');
    await settle(()=>f.sent.length===1);f.reply('work-context-start',{thread:{id:'work-context-thread'}});
    await settle(()=>f.bounds.length===1);
    const material='当前任务：公共基础与共享规则\n'+('范围、产物、验收步骤与双方录音 🛰️\n'.repeat(160));
    const current=f.context({...draft,mode:'thread',thread_id:'work-context-thread',task:{...draft.task,version:2},work_context_text:material});
    const nested=()=>({project_id:current.project_id,kind:current.kind,issue_id:current.issue_id,conversation_id:current.conversation_id,thread_id:current.thread_id,host_id:'local',mode:'thread',context:{task:current.task,work_context_text:current.work_context_text},dynamic_tools:tools});
    f.remember(nested());
    const input=[{type:'text',text:'请开发这个任务',text_elements:[]},{type:'localImage',path:'D:\\参考.png'},{type:'skill',name:'better-codex-develop',path:'C:\\skills\\develop\\SKILL.md'}];
    const nativeContext={native_reference:{kind:'application',value:'native app context'}};
    const params={threadId:'work-context-thread',input,model:'native-model',effort:'ultra',approvalPolicy:'on-request',serviceTier:'fast',collaborationMode:{mode:'plan',settings:{model:'native-model',reasoning_effort:'ultra',developer_instructions:null}},additionalContext:nativeContext};
    const request=f.send('turn/start',params,'work-context-turn');
    await settle(()=>f.sent.some(entry=>entry.request?.id==='work-context-turn'));
    const outgoing=f.sent.find(entry=>entry.request?.id==='work-context-turn');
    assert.equal(outgoing.request.params.input,input,'original rich input remains the exact native array');
    for(const field of ['model','effort','approvalPolicy','serviceTier','collaborationMode'])assert.equal(outgoing.request.params[field],params[field]);
    assert.equal(outgoing.request.params.additionalContext.native_reference,nativeContext.native_reference,'native sibling context preserved');
    assert.equal(request.request.params,params);assert.deepEqual(Object.keys(nativeContext),['native_reference'],'caller metadata is not mutated');
    const parts=Object.entries(outgoing.request.params.additionalContext).filter(([key])=>key.includes('/part/')).sort(([a],[b])=>Number(a.split('/').at(-1))-Number(b.split('/').at(-1)));
    assert(parts.length>1,'long material is split below the native per-fragment truncation limit');
    assert.equal(parts.map(([,entry])=>entry.value.slice(entry.value.indexOf('\n')+1)).join(''),material,'all Unicode task material is delivered without truncation');
    assert(parts.every(([,entry])=>entry.kind==='untrusted'&&Buffer.byteLength(entry.value,'utf8')<1000),'each labelled fragment fits the conservative native token limit');
    const oldSnapshot=Object.values(outgoing.request.params.additionalContext).find(entry=>entry.value.startsWith('当前工作任务资料快照：')).value;
    assert.equal(f.sent.filter(entry=>entry.request?.method==='thread/resume').length,0,'task data requires no settings override/resume');
    f.reply('work-context-turn',{turn:{id:'context-turn-1'}});await settle(()=>f.turns.length===1);
    current.task={...current.task,version:3};current.work_context_text='当前任务：公共基础与共享规则\n任务要求：保留测试数据。';f.remember(nested());
    f.send('turn/start',{...params,input:[input[0]]},'work-context-followup');await settle(()=>f.sent.some(entry=>entry.request?.id==='work-context-followup'));
    const followup=f.sent.find(entry=>entry.request?.id==='work-context-followup').request.params.additionalContext;
    assert(Object.values(followup).some(entry=>entry.value.includes(current.work_context_text)),'loaded thread receives the latest nested server task material');
    assert(Object.values(followup).some(entry=>entry.value.includes('此旧资料段已被替换')),'shorter updates invalidate old trailing chunks');
    assert.notEqual(Object.values(followup).find(entry=>entry.value.startsWith('当前工作任务资料快照：')).value,oldSnapshot);
    assert.equal(f.sent.filter(entry=>entry.request?.method==='thread/start').length,1,'followup does not allocate another conversation');
    f.reply('work-context-followup',{turn:{id:'context-turn-2'}});await settle(()=>f.turns.length===2);f.adapter.destroy();
    const restored=fixture();await restored.adapter.open(restored.remember(restored.context({kind:'work',issue_id:'restored-task',thread_id:'restored-thread',mode:'thread'})));
    restored.send('turn/start',{threadId:'restored-thread',input:[{type:'text',text:'开发这个任务'}]},'restored-context-turn');
    await settle(()=>restored.sent.some(entry=>entry.request?.id==='restored-context-turn'));
    assert(Object.values(restored.sent.at(-1).request.params.additionalContext).some(entry=>entry.value.includes('restored-task')),'preexisting thread gets task context without captured instruction baseline');
    assert.equal(restored.sent.length,1,'only the user-authorized native turn is sent');
    restored.reply('restored-context-turn',{turn:{id:'restored-context-turn-id'}});await settle(()=>restored.turns.length===1);restored.adapter.destroy();
    const missing=fixture();await missing.adapter.open(missing.remember(missing.context({kind:'work',issue_id:'missing-task',thread_id:'missing-thread',mode:'thread',work_context_text:null})));
    missing.send('turn/start',{threadId:'missing-thread',input:[]},'missing-material');await settle(()=>missing.delivered.some(entry=>entry.message?.id==='missing-material'));
    assert.equal(missing.sent.length,0,'missing task material does not send an unscoped model turn');missing.adapter.destroy();
    console.log('PASS: first/restored native work turns carry fresh full task material, bounded Unicode fragments and snapshot replacement without input/settings changes or extra sends');
  }
  {
    const f = fixture(); f.host.dynamicTools = false;
    const result = await f.adapter.open(f.context());
    assert.equal(result.mode, 'unavailable'); assert.equal(f.sent.length, 0); assert.equal(f.delivered.length, 0);
    f.adapter.destroy();
  }
  console.log('PASS: native inline adapter open/send separation, isolated native draft identity, binding barrier, raw input, scoped tools, prewarm isolation, legacy gates and reload hook lifecycle');
})().catch(error => { console.error(error); process.exitCode = 1; });

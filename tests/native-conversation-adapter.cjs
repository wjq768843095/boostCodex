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
  const sent = [], delivered = [], http = [], bounds = [], turns = [], errors = [], away = [];
  const records = new Map();
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
    dispatchHostMessage(message) { if (message.type === 'navigate-to-route') { nativeRoute = message.path; composerScope.value.focusComposerNonce = message.state?.focusComposerNonce; } this.deliverOrBufferMessage(message); }
  };
  const originalSend = sender.postMessage, originalDeliver = dispatcher.deliverOrBufferMessage;
  const draftDescriptor = { __scopeBrand: 'native-scope' }, draftAtom = { scope: draftDescriptor }, projectAtom = { resolve() {} };
  const nativeScope = { scope: draftDescriptor, get(atom) { return atom === draftAtom ? nativeDraft : { projectId: 'native-project' }; }, set(atom, key, id) { nativeDraft = id; } };
  const routeScope = { scope: {}, value: { routeKind: 'home', projectContext: { projectId: 'native-project' } }, get() {}, set() {} };
  const composerDescriptor = { __scopeBrand: 'native-composer' }, promptAtom = { scope: composerDescriptor }, viewAtom = { scope: composerDescriptor }, documentAtom = { scope: composerDescriptor };
  const docNode = value => ({ toJSON: () => value });
  const controller = { restoreDraft(text, retained) { nativeDocument = retained?.document?.toJSON() || { type: 'doc', content: [] }; }, plainTextMode: false, view: { dom: { isConnected: true, getBoundingClientRect: () => ({ width: 500 }) }, state: { schema: { nodeFromJSON: docNode }, get doc() { return docNode(nativeDocument); } } } };
  const composerScope = { scope: composerDescriptor, value: { kind: 'new', entrypoint: 'home' }, get(atom) { return atom === promptAtom ? richDraft : atom === viewAtom ? { ...richState, prompt: '' } : undefined; }, set() {} };
  const nativeElement = { __reactFiber$fixture: { memoizedProps: { composerController: controller }, memoizedState: { memoizedState: { current: nativeScope }, next: { memoizedState: { current: routeScope }, next: { memoizedState: { current: composerScope } } } } } };
  const host = { sender, dispatcher, dynamicTools: true, prewarm: true, draftIdentity: true, readDraft: () => nativeDraft, selectDraft: id => { nativeDraft = id; }, captureDraft: () => ({ draft: richDraft, view_state: richState, document_json: nativeDocument, plain_text_mode: false }), restoreDraft: snapshot => { richDraft = snapshot?.draft; richState = snapshot?.view_state || { imageAttachments: [], attachmentOrder: [], fileAttachments: [] }; nativeDocument = snapshot?.document_json || { type: 'doc', content: [] }; } };
  const root = {
    crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}` },
    sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    location: { pathname: '/index.html', search: '', href: 'app://-/index.html', origin: new URL('app://-/index.html').origin },
    document: { querySelectorAll: selector => config.discovery ? (selector.includes('script') ? [{ src: 'app://-/assets/index-test.js' }] : [nativeElement]) : [] },
    fetch: async url => ({ text: async () => url.includes('app-shared') ? 'dynamic-tool-call-requested thread-prewarm-start client-local-thread' : 'import "./app-shared-test.js"; import "./app-initial-test.js"' }),
    setTimeout, clearTimeout, URL, URLSearchParams
  };
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
  vm.runInNewContext(config.discovery ? source.replace('await import(moduleUrl.href)', 'root.testNamespace').replace('await import(new URL(initialName, entry).href)', 'root.testComposerNamespace') : source, { window: root, URL, URLSearchParams, Error, Map, Set, Promise });
  const key = context => [context.project_id, context.kind, context.issue_id || ''].join(':');
  const context = (overrides = {}) => ({ project_id: 'project-one', kind: 'charter', native_project_id: 'native-project', host_id: 'local', cwd: 'D:\\中文项目', workspace_path: 'D:\\中文项目', root_paths: ['D:\\中文项目', 'E:\\关联后台'], expected_revision: 0, draft_generation: 0, mode: 'draft', dynamic_tools: tools, ...overrides });
  const remember = value => { records.set(key(value), value); return value; };
  const api = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    http.push({ url, body });
    if (config.api) { const answer = await config.api(url, body); if (answer !== undefined) return answer; }
    if (url.includes('/context?')) {
      const query = new URL(url, 'http://fixture.invalid').searchParams;
      return records.get([query.get('project_id'), query.get('kind'), query.get('issue_id') || ''].join(':'));
    }
    if (url.endsWith('/prepare')) {
      const known = records.get(key(body));
      const operation = { request_id: body.request_id, status: 'prepared', thread_id: known?.thread_id || null, expected_revision: body.expected_revision };
      operations.set(body.request_id, operation);
      return { operation, dynamic_tools: tools };
    }
    if (url.endsWith('/bind')) {
      const operation = operations.get(body.request_id);
      operation.thread_id = body.thread_id;
      operation.status = body.checkpoint;
      const binding = { project_id: body.project_id, kind: body.kind, issue_id: body.issue_id, thread_id: body.thread_id };
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
    draftStorage: config.indexedDB ? undefined : { get: async id => draftStates.get(id), set: async (id, snapshot) => { draftStates.set(id, snapshot); } },
    isCurrentContext: () => true, afterNavigate: async () => {},
    onBound: value => bounds.push(plain(value)), onTurn: value => turns.push(plain(value)),
    onError: (error, origin) => errors.push({ error: error.message, origin: origin && plain(origin) }),
    onNavigateAway: origin => away.push(plain(origin))
  };
  const adapter = root.BetterCodexNativeConversation.create(options);
  const send = (method, params, id = 'native-' + ++sequence, rest = {}) => { const message = { type: 'mcp-request', hostId: 'local', request: { id, method, params }, ...rest }; sender.postMessage(message); return message; };
  const reply = (id, result, error) => dispatcher.deliverOrBufferMessage({ type: 'mcp-response', hostId: 'local', message: { id, ...(error ? { error } : { result }) } });
  return { root, host, sender, dispatcher, adapter, options, context, remember, send, reply, http, sent, delivered, bounds, turns, errors, away, originalSend, originalDeliver, operations, nativeRoute: () => nativeRoute, nativeDraft: () => nativeDraft, rich: () => ({ draft: richDraft, view_state: richState, document_json: nativeDocument }), setRich: value => { richDraft = value.draft; richState = value.view_state; nativeDocument = value.document_json; } };
}

(async () => {
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
    assert.equal(f.nativeDraft(), 'client-new-thread:original-native-draft', 'leaving restores the ordinary native home draft');
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
    const f = fixture(); f.host.dynamicTools = false;
    const result = await f.adapter.open(f.context());
    assert.equal(result.mode, 'unavailable'); assert.equal(f.sent.length, 0); assert.equal(f.delivered.length, 0);
    f.adapter.destroy();
  }
  console.log('PASS: native inline adapter open/send separation, isolated native draft identity, binding barrier, raw input, scoped tools, prewarm isolation, legacy gates and reload hook lifecycle');
})().catch(error => { console.error(error); process.exitCode = 1; });

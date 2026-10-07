'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function readFunction(name) {
  const match = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `Missing ${name}`);
  const tail = source.slice(match.index + match[0].length);
  const next = new RegExp(`^${match[1]}(?:(?:async )?function [a-zA-Z]|window\\.__betterCodexInjection__ = )`, 'm').exec(tail);
  assert(next);
  return source.slice(match.index, match.index + match[0].length + next.index);
}
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(kind = 'charter') {
  const requests = [], actions = [], memory = new Map();
  const target = { project_id: 'p', kind, conversation_id: 'one', ...(kind === 'work' ? { issue_id: 'task' } : {}) };
  const result = { project_id: 'p', kind, unbound_conversation_id: 'one', thread_id: 'native-one', host_id: 'local', ...(kind === 'work' ? { issue_id: 'task' } : {}), selected_conversation_id: 'two' };
  memory.set('better-codex-project-view:p', JSON.stringify({ page: kind === 'work' ? 'work' : 'planning', stage: kind, conversations: { [kind]: 'one', planning: kind === 'planning' ? 'one' : 'plan-other' }, target }));
  memory.set('better-codex-native-return', JSON.stringify({ ...target, thread_id: 'native-one' }));
  memory.set('resume', 'projects');
  const storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const ctx = vm.createContext({
    URLSearchParams, READ_ONLY: false, destroyed: false, active: true,
    state: { nativePlanningEnabled: true, nativeThreadLinks: { 'native-one': { ...target, host_id: 'local', thread_id: 'native-one' }, 'native-two': { ...target, conversation_id: 'two', host_id: 'local', thread_id: 'native-two' } }, issues: [{ id: 'task', project_id: 'p', run_thread_id: 'native-one' }], projectIssues: [], nativeConversations: { p: [{ ...target, thread_id: 'native-one' }, { ...target, conversation_id: 'two', thread_id: 'native-two' }] }, nativeWorkConversations: { p: [{ ...target, thread_id: 'native-one' }, { ...target, conversation_id: 'two', thread_id: 'native-two' }] }, nativeWorkSelections: { p: { issue_id: 'task', conversation_id: 'one' } }, nativeConversationSelections: { p: 'one' }, planningContexts: { p: { stale: true } }, projectResumePending: 'p' },
    inlineConversation: { target, mode: 'thread', thread_id: 'native-one', binding: { thread_id: 'native-one', status: 'ready' }, conversation: { conversation_id: 'one', revision: 1 }, context: { task: { id: 'task', version: 10 } }, expected_revision: 10 },
    inlineConversationLoading: false, inlineConversationNavigationRequest: 2, inlineConversationRequest: 0,
    inlineConversationDetailsOpen: true, inlineConversationCompactDetailsOpen: false, inlineConversationWidth: 360,
    projectSurfaceCache: { conversation: { target, thread_id: 'native-one' } },
    inlineConversationAdapter: { unregisterBinding: (threadId, hostId) => actions.push(['unregister', threadId, hostId]), registerBindings: bindings => actions.push(['register', plain(bindings)]) },
    normalizeSessionId: value => String(value || ''), issueSessionId: issue => issue.run_thread_id || '',
    t: value => value, te: value => value, RESUME_SURFACE_KEY: 'resume', relayId: 'relay',
    localStorage: storage, sessionStorage: storage,
    renderInlineConversation: () => actions.push(['render']),
    confirmAction: async () => true,
    api: async (url, options = {}) => {
      requests.push({ url, ...(options.body ? plain(JSON.parse(options.body)) : {}) });
      if (url === '/api/native-conversations/unbind') return result;
      return { target, mode: 'thread', thread_id: 'native-one', binding: { thread_id: 'native-one' }, conversation: { conversation_id: 'one', revision: 4 }, expected_revision: 12 };
    },
    leaveInlineConversation: () => { actions.push(['leave']); ctx.inlineConversation = null; ctx.inlineConversationNavigationRequest++; },
    close: () => { actions.push(['close']); ctx.active = false; },
    releaseProjectSurfaceCache: () => { actions.push(['release']); ctx.projectSurfaceCache = null; },
    openThread: async threadId => { actions.push(['open-native', threadId]); },
    errorLabel: error => String(error.message || error),
    ensureBootstrapReady: async () => {}, projectPlanningDrafts: new Map(), render() {}, bootstrapFailure: null, injectionSurfaceError: () => null,
    openInlineConversation: async () => { throw Error('must not reopen detached workflow'); }
  });
  for (const name of ['inlineConversationKey', 'inlineConversationTarget', 'inlineConversationQuery', 'issueExecutionRunning', 'inlineConversationUnbindState', 'inlineConversationUnbindMarkup', 'readProjectView', 'clearUnboundConversationView', 'registerInlineConversationBindings', 'unbindInlineConversation', 'isManagedNativeThread', 'lookupNativeProjectBinding', 'restoreReloadState']) vm.runInContext(readFunction(name), ctx);
  return { ctx, requests, actions, memory, result, target };
}
(async () => {
  for (const kind of ['charter', 'planning', 'work']) {
    const f = fixture(kind);
    assert.match(f.ctx.inlineConversationUnbindMarkup(), /data-inline-unbind/);
    f.ctx.inlineConversation.read_only = kind === 'planning';
    await f.ctx.unbindInlineConversation({ disabled: false });
    assert.equal(f.requests[1].url, '/api/native-conversations/unbind');
    assert.equal(f.requests[1].conversation_id, 'one');
    assert.equal(f.requests[1].expected_revision, 4, 'fresh conversation revision is used, never an issue version');
    if (kind === 'work') assert.equal(f.requests[1].expected_issue_version, 12);
    else assert(!('expected_issue_version' in f.requests[1]));
    assert(f.actions.some(action => action[0] === 'unregister' && action[1] === 'native-one' && action[2] === 'local'));
    assert(f.actions.some(action => action[0] === 'open-native' && action[1] === 'native-one'));
    assert(!f.ctx.state.nativeThreadLinks['native-one']);
    assert(f.ctx.state.nativeThreadLinks['native-two']);
    assert.equal(f.ctx.isManagedNativeThread('native-one'), false, 'stale issue run_thread_id cannot capture an unbound native chat');
    assert.equal(f.ctx.projectSurfaceCache, null);
    assert(!f.memory.has('better-codex-native-return')); assert(!f.memory.has('resume'));
    const view = JSON.parse(f.memory.get('better-codex-project-view:p'));
    assert(!view.target); assert(!view.conversations[kind]);
    if (kind === 'charter') assert.equal(view.conversations.planning, 'plan-other');
    assert(!f.ctx.state.nativeWorkSelections.p); assert(!f.ctx.state.planningContexts.p);
    assert.equal(JSON.parse(f.memory.get('better-codex-unbound-threads'))['native-one'], true);
    assert(f.requests.every(request => !/archive|turn\/start|create|restart/.test(request.url)), 'unbind never archives native chats or generates messages');
  }
  for (const change of [ctx => { ctx.inlineConversation.mode = 'draft'; }, ctx => { ctx.inlineConversation.thread_id = ''; ctx.inlineConversation.binding = null; }, ctx => { ctx.inlineConversation.target.history_id = 'h'; }, ctx => { ctx.READ_ONLY = true; }, ctx => { ctx.inlineConversation.target.conversation_id = ''; ctx.inlineConversation.conversation = null; }]) {
    const f = fixture(); change(f.ctx);
    assert.equal(f.ctx.inlineConversationUnbindMarkup(), '');
    await f.ctx.unbindInlineConversation({ disabled: false }); assert.equal(f.requests.length, 0);
  }
  for (const change of [ctx => { ctx.inlineConversation.binding.status = 'running'; }, ctx => { ctx.inlineConversation.binding.status = 'waiting_on_approval'; }, ctx => { ctx.inlineConversation.binding.status = 'waiting_on_user'; }, ctx => { ctx.inlineConversation.pending_operation = {}; }, ctx => { ctx.inlineConversationLoading = true; }, ctx => { ctx.inlineConversation.context.task.session_active_turn_id = 'turn'; }]) {
    const f = fixture(); change(f.ctx); assert.match(f.ctx.inlineConversationUnbindMarkup(), /disabled/);
    await f.ctx.unbindInlineConversation({ disabled: false }); assert.equal(f.requests.length, 0);
  }
  {
    const f = fixture(); f.ctx.confirmAction = async () => false;
    await f.ctx.unbindInlineConversation({ disabled: false }); assert.equal(f.requests.length, 0); assert(f.ctx.state.nativeThreadLinks['native-one']);
  }
  {
    const f = fixture(); const api = f.ctx.api;
    f.ctx.api = async (...args) => { if (args[0].endsWith('/unbind')) throw Error('native_conversation_busy'); return api(...args); };
    await assert.rejects(f.ctx.unbindInlineConversation({ disabled: false }), /native_conversation_busy/);
    assert(f.ctx.state.nativeThreadLinks['native-one']); assert(f.ctx.inlineConversation); assert(f.ctx.projectSurfaceCache); assert(!f.actions.some(action => action[0] === 'unregister'));
  }
  {
    const f = fixture(); const api = f.ctx.api;
    f.ctx.api = async (...args) => { const response = await api(...args); if (!args[0].endsWith('/unbind')) response.thread_id = 'changed-thread'; return response; };
    await assert.rejects(f.ctx.unbindInlineConversation({ disabled: false }), /binding_changed/);
    assert.equal(f.requests.length, 1); assert(f.ctx.state.nativeThreadLinks['native-one']);
  }
  {
    const f = fixture(); f.ctx.confirmAction = async () => { f.ctx.inlineConversationNavigationRequest++; return true; };
    await f.ctx.unbindInlineConversation({ disabled: false }); assert.equal(f.requests.length, 0);
  }
  {
    const f = fixture(); const api = f.ctx.api;
    f.ctx.api = async (...args) => { const response = await api(...args); if (args[0].endsWith('/unbind')) { f.ctx.inlineConversation = { target: { project_id: 'other', kind: 'charter', conversation_id: 'other' } }; f.ctx.inlineConversationNavigationRequest++; } return response; };
    await f.ctx.unbindInlineConversation({ disabled: false });
    assert(!f.ctx.state.nativeThreadLinks['native-one']); assert.equal(f.ctx.inlineConversation.target.project_id, 'other');
    assert(!f.actions.some(action => ['open-native', 'leave', 'close'].includes(action[0])), 'late unbind completion cannot steal the user from another conversation');
  }
  {
    const f = fixture(); f.ctx.state.nativeUnboundThreads = { 'native-one': true };
    await f.ctx.restoreReloadState({ open: true, nativeConversation: { target: f.target, context: { thread_id: 'native-one' } }, nativeUnboundThreads: {} });
    assert(f.actions.some(action => action[0] === 'open-native' && action[1] === 'native-one'), 'saved workflow reload state opens detached chat as an ordinary native conversation');
  }
  {
    const f = fixture(); f.ctx.state.nativeUnboundThreads = { 'native-one': true }; f.ctx.state.nativeThreadLinks['native-one'] = { ...f.target, host_id: 'local', thread_id: 'native-one' };
    f.ctx.registerInlineConversationBindings();
    assert(!f.actions.at(-1)[1].some(binding => binding.thread_id === 'native-one'), 'stale registry cannot reattach a detached thread');
    f.ctx.state.surface = 'projects'; f.ctx.projectPlanningDrafts = new Map();
    vm.runInContext(readFunction('captureReloadState'), f.ctx);
    assert.equal(f.ctx.captureReloadState().nativeUnboundThreads['native-one'], true);
  }
  {
    const f = fixture(); f.ctx.state.nativeUnboundThreads = { 'native-one': true };
    assert.equal(await f.ctx.lookupNativeProjectBinding('native-one'), null);
    delete f.ctx.state.nativeUnboundThreads; delete f.ctx.state.nativeThreadLinks['native-one'];
    f.ctx.api = async () => { f.ctx.state.nativeUnboundThreads = { 'native-one': true }; return f.target; };
    assert.equal(await f.ctx.lookupNativeProjectBinding('native-one'), null);
    assert(!f.ctx.state.nativeThreadLinks['native-one'], 'a lookup started before unbinding cannot resurrect its cached binding');
  }
  {
    const f = fixture(); f.ctx.state.nativeUnboundThreads = { 'native-one': true };
    f.ctx.resumePersistedThread = async threadId => f.actions.push(['resume-existing', threadId]);
    f.ctx.findThreadRow = () => null;
    f.ctx.NAVIGATION = { messageType: 'navigate', threadRoutePrefix: '/local/' };
    f.ctx.window = { location: { origin: 'fixture' }, postMessage: message => f.actions.push(['navigate-existing', message.path]) };
    f.ctx.waitForThreadOpen = async () => ({ opened: true });
    f.ctx.openIssueNativeConversation = async () => { throw Error('detached issue must not capture the native chat'); };
    f.ctx.openProjectNativeSession = async () => { throw Error('detached project must not capture the native chat'); };
    vm.runInContext(readFunction('openThread'), f.ctx);
    assert.equal((await f.ctx.openThread('native-one')).opened, true);
    assert(f.actions.some(action => action[0] === 'resume-existing' && action[1] === 'native-one'));
    assert(f.actions.some(action => action[0] === 'navigate-existing' && action[1] === '/local/native-one'));
  }
  console.log('Native unbind UI: charter/planning/work, fresh versions, lifecycle cleanup, ordinary routing, busy/failure and navigation races passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

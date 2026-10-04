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
  assert(next, `Missing function after ${name}`);
  return source.slice(match.index, match.index + match[0].length + next.index);
}
const plain = value => JSON.parse(JSON.stringify(value));
const http = [], hostActions = [], registeredBindings = [], adapterContextUpdates = [], acceptedRoutes = new Set();
let hooks, desiredMode = 'draft', confirmed = true, binding = null;
const workFixtureConversations = [];
const adapter = {
  open: async response => { hostActions.push({ action: 'open', target: plain(response.target) }); const route = response.binding ? '/local/' + response.binding.thread_id : '/local/client-new-thread:' + response.target.project_id + ':' + response.target.kind + ':' + (response.target.issue_id || ''); acceptedRoutes.clear(); acceptedRoutes.add(route); ctx.location.pathname = route; ctx.location.search = ''; return { mode: response.mode }; },
  leave: () => { hostActions.push({ action: 'leave' }); acceptedRoutes.clear(); },
  restore: async (response, saved) => { hostActions.push({ action: 'restore', target: plain(response.target), saved }); acceptedRoutes.clear(); acceptedRoutes.add(ctx.location.pathname + ctx.location.search); return { mode: response.mode }; },
  ownsRoute: route => acceptedRoutes.has(route),
  registerBindings: bindings => registeredBindings.push(plain(bindings)),
  updateContext: context => adapterContextUpdates.push(plain(context)),
  capture: () => ({ opaque: 'native-draft-state' })
};
const ctx = vm.createContext({
  URLSearchParams, state: { projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], issues: [], projectIssues: [], surface: 'projects', projectPage: 'planning', nativePlanningEnabled: true },
  location: { pathname: '/local/original-thread', search: '' }, NAVIGATION: { threadRoutePrefix: '/local/' },
  projectSurfaceCache: null, inlineConversation: null, inlineConversationRoot: {}, inlineConversationAdapter: null,
  inlineConversationRequest: 0, inlineConversationCacheRestoring: false, inlineConversationLoading: false, inlineConversationError: '',
  inlineConversationDetailsOpen: true, inlineConversationCompactDetailsOpen: false, inlineConversationNavigationRequest: 0, inlineConversationWidth: 360, active: true, destroyed: false, routeSuppressed: false, pollTimer: null,
  relayId: 'fixture-relay', relayThreads: new Set(), RESUME_SURFACE_KEY: 'fixture-resume', projectPlanningDrafts: new Map(),
  t: value => value, normalizeSessionId: value => String(value || ''), appendDiagnostic() {},
  sessionStorage: { setItem() {} }, ensureEntry() {}, ensureBootstrapReady: async () => {}, mountPanel() {}, renderInlineConversation() {}, render() {},
  startLiveUpdates: () => true, setInterval: () => 1, perform: fn => fn(),
  bootstrapFailure: null, injectionSurfaceError: () => null,
  window: { BetterCodexNativeConversation: { create: config => { hooks = config; return adapter; } } },
  api: async (url, options = {}) => {
    http.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/create') && options.body) {
      const body = JSON.parse(options.body);
      if (body.kind === 'work') {
        workFixtureConversations.filter(row => row.issue_id === body.issue_id).forEach(row => row.selected = false);
        const conversation = { ...body, conversation_id: 'fixture-work-' + (workFixtureConversations.length + 1), selected: true, source: 'current', title: 'Work task', status: 'todo' };
        workFixtureConversations.push(conversation); return { conversation };
      }
    }
    if (url.endsWith('/select')) return {};
    if (url.endsWith('/conversation')) return { messages: [{ role: 'user', markdown: 'Historical request' }] };
    const query = new URLSearchParams(url.split('?')[1]);
    if (url.includes('/list?') && query.get('kind') === 'work') return { conversations: [{ project_id: query.get('project_id'), kind: 'work', issue_id: 'work', title: 'Work task', source: 'current', status: 'todo' }, ...workFixtureConversations.filter(row => row.project_id === query.get('project_id'))] };
    if (query.get('history_id')) return { mode: 'thread', read_only: true, thread_id: 'history-work-thread', binding: { thread_id: 'history-work-thread' }, target: { project_id: query.get('project_id'), kind: 'work', issue_id: query.get('issue_id'), history_id: query.get('history_id') }, context: { task: { id: query.get('issue_id'), title: 'Historical work' } } };
    return { mode: desiredMode, binding, expected_revision: 3, native_project_id: 'native-' + query.get('project_id'), planning_available: confirmed, ...(query.get('conversation_id') && query.get('kind') === 'work' ? { target: { project_id: query.get('project_id'), kind: 'work', issue_id: query.get('issue_id'), conversation_id: query.get('conversation_id') } } : {}), context: { project: { id: query.get('project_id') }, charter: { revision: 2, status: confirmed ? 'confirmed' : 'draft' }, plan: { revision: 1, items: [] } } };
  },
  isBetterCodexRoute: () => false,
  entry: {}, agentsEntry: {}, projectsEntry: {}, moreEntry: null, profileEntry: null, usageEntry: null, themeEntry: null,
  suppressAgentOutside: false, suppressSessionClickUntil: 0, nativeThreadOpenBypass: '', PANEL_ID: 'better-codex-panel',
  SELECTORS: { threadRow: '[data-thread]', sidebarNavigation: '[data-sidebar]', projectRow: '[data-project-row]' }, SIDEBAR_NAVIGATION_ITEM: '.sidebar-item',
  issueSessionId: issue => issue.session_thread_id || issue.thread_id || '', nativeThreadId: row => row.thread_id || '',
  isNativeRailDestination: () => false, isSidebarNavigationTarget: () => false,
  closeAuxiliaryMenu() {}, openRoute() {}, close() {}
});
for (const name of ['releaseProjectSurfaceCache', 'readProjectView', 'rememberProjectView', 'planningStageTabsMarkup', 'inlineConversationKey', 'inlineConversationTarget', 'inlineConversationRouteAllowed', 'nativeInlineErrorLabel', 'ensureInlineConversationAdapter', 'registerInlineConversationBindings', 'inlineConversationQuery', 'reloadInlineConversationContext', 'openInlineConversation', 'openIssueNativeConversation', 'createIssueNativeConversation', 'loadProjectWorkConversations', 'openProjectWorkSession', 'loadProjectNativeConversations', 'openProjectNativeSession', 'captureReloadState', 'restoreReloadState', 'isManagedNativeThread', 'onClick']) vm.runInContext(readFunction(name), ctx);

class NodeFixture {
  constructor(name) { this.name = name; this.children = []; this.attrs = new Map(); this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); } }; this.listeners = {}; this.parentElement = null; this.appendCount = 0; this.innerHTML = ''; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) || null; }
  removeAttribute(name) { this.attrs.delete(name); }
  matches(selector) { return this.name === 'native' && selector === '.native-layout'; }
  querySelector(selector) { if (this.name === 'native') return selector === '.native-frame' ? {} : null; return this.parts?.[selector] || null; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  appendChild(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child); this.appendCount++; this.children.push(child); child.parentElement = this; }
}
(async () => {
  const charter = { project_id: 'p1', kind: 'charter' };
  assert.equal((await ctx.openProjectNativeSession('p1', 'charter')).opened, true);
  assert.equal(ctx.active, true);
  assert.equal(ctx.inlineConversationKey(ctx.inlineConversation), 'p1:charter:');
  assert.equal(ctx.inlineConversationRouteAllowed(), true, 'only adapter-owned draft route remains composed');
  assert.equal(ctx.inlineConversationRouteAllowed('/local/unrelated', ''), false);
  assert.equal(ctx.inlineConversationRouteAllowed('/projects', '?projectId=native-other'), false);
  assert.equal(http.filter(call => call.method !== 'GET').length, 0, 'opening may only read context');
  const opens = hostActions.filter(action => action.action === 'open').length;
  await ctx.openProjectNativeSession('p1', 'charter');
  assert.equal(hostActions.filter(action => action.action === 'open').length, opens, 'reopening current page must reuse native draft');
  await ctx.openProjectNativeSession('p1', 'planning');
  await ctx.openProjectNativeSession('p2', 'charter');
  assert.deepEqual(hostActions.filter(action => action.action === 'open').map(action => [action.target.project_id, action.target.kind]), [['p1', 'charter'], ['p1', 'planning'], ['p2', 'charter']]);
  hooks.onBound({ target: charter, thread_id: 'old-project-thread' });
  assert.equal(ctx.inlineConversation.binding, null, 'a previous project bind response must not update current project');
  assert(ctx.relayThreads.has('old-project-thread'), 'old thread still forwards its real confirmation events');
  assert.equal(ctx.state.nativeThreadLinks['old-project-thread'].project_id, 'p1', 'an offscreen binding is cached only under its own trusted project');
  hooks.onError(new Error('native_binding_conflict'), charter);
  assert.equal(ctx.inlineConversationError, '', 'previous project error must not cover current composer');
  hooks.onBound({ target: { project_id: 'p2', kind: 'charter' }, thread_id: 'current-project-thread' });
  assert.equal(ctx.inlineConversation.binding.thread_id, 'current-project-thread');
  assert.equal(ctx.inlineConversationRouteAllowed('/local/current-project-thread', ''), true);
  const saved = plain(ctx.captureReloadState());
  assert.equal(saved.open, true, 'reload must capture native page even though ordinary panel is hidden');
  assert.equal(saved.nativeConversation.detailsWidth, 360);
  assert(!saved.nativeConversation.context.context, 'reload snapshot does not copy project documents or historical messages');
  const beforeRestore = hostActions.filter(action => action.action === 'open').length;
  binding = { thread_id: 'current-project-thread' }; desiredMode = 'thread';
  await ctx.restoreReloadState(saved);
  assert.equal(hostActions.filter(action => action.action === 'open').length, beforeRestore, 'reload only reattaches adapter');
  assert.equal(hostActions.at(-1).action, 'restore');
  confirmed = false; binding = null; desiredMode = 'draft';
  const beforeUnconfirmed = hostActions.filter(action => action.action === 'open').length;
  const planning = await ctx.openProjectNativeSession('p1', 'planning');
  assert.equal(planning.opened, false);
  assert.equal(hostActions.filter(action => action.action === 'open').length, beforeUnconfirmed, 'planning requires a confirmed charter before touching native chat');
  assert.match(ctx.inlineConversationError, /确认总纲/);
  confirmed = true; desiredMode = 'legacy_busy';
  const workOpens = hostActions.filter(action => action.action === 'open').length;
  await ctx.openIssueNativeConversation({ id: 'work', project_id: 'p1' });
  assert.equal(hostActions.filter(action => action.action === 'open').length, workOpens, 'legacy busy task remains with its existing writer');
  assert.equal(ctx.inlineConversation.history[0].markdown, 'Historical request');
  assert.equal(ctx.inlineConversationRouteAllowed(), true);
  desiredMode = 'handoff_required';
  await ctx.reloadInlineConversationContext();
  assert.equal(ctx.inlineConversation.mode, 'handoff_required');
  assert.equal(hostActions.filter(action => action.action === 'open').length, workOpens, 'idle transition never automatically transfers writer');
  assert.equal(http.filter(call => call.method !== 'GET').length, 0);
  desiredMode = 'draft';
  await ctx.openInlineConversation({ project_id: 'p1', issue_id: 'work', kind: 'work' }, { retry: true });
  const beforeExplicitNavigation = hostActions.filter(action => action.action === 'open').length;
  desiredMode = 'thread'; binding = { thread_id: 'queued-explicit-thread' };
  await ctx.reloadInlineConversationContext();
  assert.equal(hostActions.filter(action => action.action === 'open').length, beforeExplicitNavigation, 'normal context refresh does not navigate or start a task');
  ctx.inlineConversation.start_requested = true;
  await ctx.reloadInlineConversationContext();
  assert.equal(hostActions.filter(action => action.action === 'open').length, beforeExplicitNavigation + 1, 'a user-requested queued task shows its newly bound native thread in place');
  assert.equal(ctx.inlineConversation.start_requested, false);
  assert.equal(http.filter(call => call.method !== 'GET').length, 0, 'showing the queued result never sends another model request');
  let prevented = 0, stopped = 0;
  const nativeButton = { closest: () => null };
  ctx.onClick({ target: { closest: () => nativeButton }, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
  assert.equal(prevented, 0); assert.equal(stopped, 0, 'native composer, approval and menus keep their events');
  vm.runInContext(readFunction('isSidebarNavigationTarget'), ctx);
  const sidebar = {};
  function threadRow(id) {
    const row = { thread_id: id, closest(selector) { if (selector === '[data-sidebar]') return sidebar; if (selector === '[data-thread]' || selector === '.sidebar-item') return row; return null; }, matches: () => true, getAttribute: () => 'Native row label' };
    return row;
  }
  const knownRow = threadRow('known-work-thread'), unknownRow = threadRow('ordinary-native-thread');
  const utility = { closest: selector => knownRow.closest(selector), matches: () => true, getAttribute: () => 'More actions' };
  ctx.state.nativeThreadLinks = { 'known-work-thread': { project_id: 'p1', issue_id: 'work', kind: 'work', host_id: 'local', thread_id: 'known-work-thread' } };
  ctx.active = false;
  const openedSidebarThreads = []; ctx.openThread = async id => openedSidebarThreads.push(id);
  const sidebarClick = target => { let prevented = 0, stopped = 0; ctx.onClick({ target: { closest: () => target }, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ }); return { prevented, stopped }; };
  assert.deepEqual(sidebarClick(knownRow), { prevented: 1, stopped: 1 });
  assert.deepEqual(openedSidebarThreads, ['known-work-thread'], 'trusted Better Codex binding is mounted before native navigation even after reload');
  assert.deepEqual(sidebarClick(utility), { prevented: 0, stopped: 0 }, 'thread row menu keeps the original native event');
  assert.equal(openedSidebarThreads.length, 1);
  const beforeUnknown = http.length;
  assert.deepEqual(sidebarClick(unknownRow), { prevented: 0, stopped: 0 });
  assert.equal(http.length, beforeUnknown, 'ordinary native chats are never paused for async lookup/replay');
  ctx.active = true;
  let sidebarCloses = 0; ctx.close = () => sidebarCloses++;
  assert.deepEqual(sidebarClick(unknownRow), { prevented: 0, stopped: 0 });
  assert.equal(sidebarCloses, 1, 'native sidebar exits the project shell without relying on location.pathname');
  ctx.state.nativeThreadLinks = {
    current: { project_id: 'p1', kind: 'work', host_id: 'local', thread_id: 'current', issue_id: 'work', document: 'Must not register full project material' },
    foreign: { project_id: 'p1', kind: 'charter', host_id: 'remote', thread_id: 'foreign' },
    archived: { project_id: 'p1', kind: 'charter', host_id: 'local', thread_id: 'archived', archived_at: '2026-10-03' },
    invalid: { project_id: 'p1', kind: 'work', host_id: 'local', thread_id: 'invalid' }
  };
  const beforeRegistryHost = hostActions.length, beforeRegistryHttp = http.length;
  ctx.registerInlineConversationBindings();
  assert.deepEqual(registeredBindings.at(-1), [{ project_id: 'p1', kind: 'work', host_id: 'local', thread_id: 'current', issue_id: 'work' }]);
  delete ctx.state.nativeThreadLinks.current;
  ctx.registerInlineConversationBindings();
  assert.deepEqual(registeredBindings.at(-1), [], 'restarting a conversation removes its old active scope registration');
  assert.equal(hostActions.length, beforeRegistryHost, 'registering cold-start trusted bindings never navigates or opens a composer');
  assert.equal(http.length, beforeRegistryHttp, 'registering bindings has no API or model side effects');

  const native = new NodeFixture('native');
  const surface = new NodeFixture('surface'); surface.appendChild(native); const originalAppends = surface.appendCount;
  const layoutCtx = vm.createContext({
    inlineConversationRoot: null, inlineConversation: { target: charter }, panel: null, OWNED: 'data-owned',
    SELECTORS: { contentLayout: '.native-layout', contentFrame: '.native-frame' }, t: value => value, te: value => value,
    inlineConversationResize: null, inlineConversationWidth: 360, localStorage: { setItem() {} },
    inlineNativeElementVisible: node => node.name === 'native', syncPlanningWorkspaceNativeChrome() {},
    createPanel: () => { const panel = new NodeFixture('panel'); panel.setAttribute('data-owned', 'true'); return panel; }, observeComponentSize() {}, componentContext() {},
    onInlineConversationClick() {}, renderInlineConversation() {},
    document: { createElement() { const root = new NodeFixture('root'); root.parts = { '.better-codex-inline-resize': new NodeFixture('resize') }; return root; } }
  });
  vm.runInContext(readFunction('inlineConversationTarget'), layoutCtx);
  vm.runInContext(readFunction('mountInlineConversation'), layoutCtx);
  for (let index = 0; index < 20; index++) layoutCtx.mountInlineConversation(surface);
  assert.equal(surface.children[0], native, 'React native layout stays at its original position');
  assert.equal(surface.children.length, 2);
  assert.equal(surface.appendCount, originalAppends + 1, 'refresh neither moves native layout nor recreates project shell');
  assert.equal(native.hasAttribute('data-better-codex-native-hidden'), false);
  assert.equal(native.hasAttribute('data-better-codex-inline-content'), true);
  assert.equal(layoutCtx.panel.hidden, false, 'planning keeps the Better Codex project page shell visible');
  assert.equal(layoutCtx.inlineConversationRoot.parentElement, layoutCtx.panel);
  assert.equal(layoutCtx.panel.hasAttribute('data-better-codex-inline-shell'), true);
  layoutCtx.inlineConversation.target = { project_id: 'p1', kind: 'work', issue_id: 'work' };
  layoutCtx.mountInlineConversation(surface);
  assert.equal(layoutCtx.panel.hidden, false, 'work conversations retain the Better Codex workspace shell');
  assert.equal(layoutCtx.inlineConversationRoot.parentElement, layoutCtx.panel);
  assert.equal(surface.children[0], native, 'opening work keeps the same native React layout mounted');

  class LifecycleNode {
    constructor(name) { this.name = name; this.children = []; this.dataset = {}; this.parentElement = null; this.isConnected = false; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
    contains(child) { return child === this || this.children.some(node => node.contains(child)); }
    querySelectorAll() { return this.children.flatMap(child => [...(child.dataset.bcComponent ? [child] : []), ...child.querySelectorAll()]); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  }
  const componentCtx = vm.createContext({ HTMLElement: LifecycleNode, AbortController, activeComponents: new Set(), ownedComponents: new WeakMap(), componentFailure: (_, phase) => new Error(phase) });
  for (const name of ['createComponentLifecycle', 'registerOwnedComponent', 'destroyOwnedComponents', 'destroyRemovedComponents']) vm.runInContext(readFunction(name), componentCtx);
  const oldNativeSurface = new LifecycleNode('old-native-surface'), cachedPanel = new LifecycleNode('cached-panel'), cachedToolbar = new LifecycleNode('cached-toolbar'), cachedAction = new LifecycleNode('cached-action');
  cachedToolbar.appendChild(cachedAction); cachedPanel.appendChild(cachedToolbar); oldNativeSurface.appendChild(cachedPanel);
  const toolbarLifecycle = componentCtx.createComponentLifecycle('toolbar', { mountId: 'cached' }, cachedToolbar, {}, () => {});
  componentCtx.registerOwnedComponent(cachedToolbar, toolbarLifecycle.handle);
  componentCtx.destroyRemovedComponents([{ removedNodes: [oldNativeSurface] }], [cachedPanel]);
  assert(cachedPanel.contains(cachedToolbar), 'native React surface replacement preserves the cached panel toolbar');
  assert.equal(toolbarLifecycle.signal.aborted, false, 'retained toolbar keeps its click handlers after a temporary native unmount');
  const newNativeSurface = new LifecycleNode('new-native-surface'); newNativeSurface.appendChild(cachedPanel);
  assert(cachedPanel.contains(cachedAction), 'remounting a cached panel keeps the real controls needed for UI readiness');
  const replacedField = new LifecycleNode('replaced-field'); cachedPanel.appendChild(replacedField);
  const replacedLifecycle = componentCtx.createComponentLifecycle('field', { mountId: 'replaced' }, replacedField, {}, () => {});
  componentCtx.registerOwnedComponent(replacedField, replacedLifecycle.handle);
  replacedField.remove();
  componentCtx.destroyRemovedComponents([{ removedNodes: [replacedField] }], [cachedPanel]);
  assert.equal(replacedLifecycle.signal.aborted, true, 'a genuinely removed child still releases its listeners');
  componentCtx.destroyOwnedComponents(cachedPanel);
  assert.equal(toolbarLifecycle.signal.aborted, true, 'final teardown releases the preserved panel controls');
  assert.equal(componentCtx.activeComponents.size, 0);
  assert(source.includes('destroyRemovedComponents(records, [panel, inlineConversationRoot, projectSurfaceCache?.root].filter(Boolean))'), 'observer preserves current shells and the detached reusable project cache');
  let missingRailMounts = 0, missingRailCloses = 0;
  const routeCtx = vm.createContext({ HOST_KIND: 'codex', location: { pathname: '/index.html' }, state: {},
    active: true, inlineConversation: { target: charter }, inlineConversationCacheRestoring: false, inlineConversationLoading: false,
    isBetterCodexRoute: () => false, ensureEntry: () => false, inlineConversationRouteAllowed: () => true,
    mountPanel: () => missingRailMounts++, close: () => missingRailCloses++, routeSuppressed: false });
  vm.runInContext(readFunction('refresh'), routeCtx);
  routeCtx.refresh();
  assert.equal(missingRailCloses, 0, 'a native route transition may temporarily remove its rail without closing the project conversation');
  assert.equal(missingRailMounts, 1);
  routeCtx.inlineConversationRouteAllowed = () => false;
  routeCtx.refresh();
  assert.equal(missingRailCloses, 1, 'unrelated navigation still exits the composition');
  assert(!readFunction('refresh').includes('syncSessionHandoffFromHost()'), 'refresh cannot transfer old task ownership');
  let listResult = [{ id: 'legacy-work', active_run_status: 'running', reply_status: 'idle', updated_at: '2026-10-03T11:00:00Z' }];
  const listReads = [], listNotices = [], dialogUpdates = [];
  let listRenders = 0;
  const listCtx = vm.createContext({ URLSearchParams, draggingIssueId: null, sessionDragPointer: null, state: { search: '', issues: [], issuesLoaded: false, surface: 'projects', agentPane: 'preview' },
    pendingIssueRemovals: new Map(), pendingIssueReplies: new Map(), pendingIssueCreates: new Map(), issueSessionSnapshot: new Map(),
    requestList: async (url, resource, options) => { listReads.push({ url, resource, options: plain(options) }); return plain(listResult); },
    document: { getElementById: () => ({ dataset: { issueId: 'legacy-work' }, __betterCodexSyncIssue: issue => dialogUpdates.push(plain(issue)) }) },
    render: () => listRenders++, renderSessionEndNotice: issue => listNotices.push(plain(issue)),
    api: () => { throw new Error('List refresh must never write or transfer a thread'); } });
  vm.runInContext(readFunction('loadIssues'), listCtx);
  await listCtx.loadIssues();
  assert.equal(listCtx.state.issuesLoaded, true);
  assert.equal(listCtx.state.issues[0].active_run_status, 'running');
  assert.equal(listRenders, 1, 'foreground list load renders without a removed handoff helper');
  await listCtx.loadIssues({ background: true });
  assert.equal(listRenders, 1, 'unchanged background list load retains the current page');
  listResult = [{ id: 'legacy-work', active_run_status: '', reply_status: 'idle', last_activity_finished_at: '2026-10-03T11:05:00Z', updated_at: '2026-10-03T11:05:00Z' }];
  await listCtx.loadIssues({ background: true });
  assert.equal(listRenders, 2);
  assert.equal(listNotices.length, 1, 'legacy task completion still updates its notice while waiting for explicit handoff');
  assert.equal(dialogUpdates.at(-1).active_run_status, '');
  assert(listReads.every(read => read.url === '/api/issues' && read.resource === 'issues'), 'all list refresh paths are read-only');
  assert(!readFunction('openProjectNativeSession').includes('native-session'), 'opening cannot queue the previous injected first prompt');

  const conversationCalls = [], conversationOpens = [];
  let conversationRows = [{ conversation_id: 'A', project_id: 'p1', kind: 'charter', title: 'Architecture A', thread_id: 'thread-A', status: 'closed', selected: false }, { conversation_id: 'B', project_id: 'p1', kind: 'charter', title: 'Architecture B', thread_id: 'thread-B', status: 'ready', selected: true }];
  let delayedCreateResolve, pendingInteraction;
  const conversationCtx = vm.createContext({ URLSearchParams, inlineConversationNavigationRequest: 0, destroyed: false,
    state: { projects: [], issues: [], projectIssues: [], nativeThreadLinks: { 'thread-A': { project_id: 'p1', kind: 'charter', conversation_id: 'A' } } }, relayId: 'relay',
    inlineConversation: { target: { project_id: 'p1', kind: 'charter', conversation_id: 'B' }, binding: { thread_id: 'thread-B' }, expected_revision: 5 },
    normalizeSessionId: value => value, t: value => value, te: value => value, escapeHtml2: value => String(value), icon: name => '<i>' + name + '</i>',
    api: async (url, options = {}) => {
      conversationCalls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/list?')) return { conversations: conversationRows, selected_conversation_id: conversationRows.find(item => item.selected)?.conversation_id };
      if (url.endsWith('/select')) { const body = JSON.parse(options.body); conversationRows = conversationRows.map(item => ({ ...item, selected: item.conversation_id === body.conversation_id })); return { conversation: conversationRows.find(item => item.selected) }; }
      if (url.endsWith('/restart')) return { target: { project_id: 'p1', kind: 'charter', conversation_id: 'C' }, conversation_id: 'C' };
      if (url.endsWith('/create')) return new Promise(resolve => { delayedCreateResolve = resolve; });
      throw new Error('Unexpected conversation request ' + url);
    },
    openInlineConversation: async target => { conversationOpens.push(plain(target)); conversationCtx.inlineConversation = { target, mode: 'draft' }; return { opened: true }; },
    inlineConversationAdapter: { leave() {} }, registerInlineConversationBindings() {}, confirmAction: async () => true,
    perform: action => { pendingInteraction = action(); return pendingInteraction; }, openIssueNativeConversation() {}, onProjectsClick() {} });
  for (const name of ['releaseProjectSurfaceCache', 'readProjectView', 'rememberProjectView', 'planningStageTabsMarkup', 'inlineConversationKey', 'inlineConversationTarget', 'inlineConversationQuery', 'loadProjectNativeConversations', 'openProjectNativeSession', 'planningConversationListMarkup', 'onInlineConversationClick', 'openThread']) vm.runInContext(readFunction(name), conversationCtx);
  await conversationCtx.openThread('thread-A');
  assert.equal(conversationOpens.at(-1).conversation_id, 'A', 'native sidebar opens exact A even when same-stage B is selected');
  assert.equal(conversationCalls.find(call => call.url.endsWith('/select')).body.conversation_id, 'A');
  assert.notEqual(conversationCtx.inlineConversationKey({ project_id: 'p1', kind: 'charter', conversation_id: 'A' }), conversationCtx.inlineConversationKey({ project_id: 'p1', kind: 'charter', conversation_id: 'B' }));
  assert.match(conversationCtx.inlineConversationQuery({ project_id: 'p1', kind: 'charter', conversation_id: 'A' }), /conversation_id=A/);
  conversationCtx.inlineConversation = { target: { project_id: 'p1', kind: 'charter', conversation_id: 'A' }, binding: { thread_id: 'thread-A' }, expected_revision: 5 };
  conversationCtx.state.nativeThreadLinks['thread-A'] = { project_id: 'p1', kind: 'charter', conversation_id: 'A' };
  const interactionButton = selector => ({ dataset: {}, matches: value => value === selector, closest: () => null });
  const restart = interactionButton('[data-inline-restart]');
  conversationCtx.onInlineConversationClick({ target: { closest: () => restart } });
  await new Promise(resolve => setImmediate(resolve)); await pendingInteraction;
  assert.equal(conversationOpens.at(-1).conversation_id, 'C', 'restart opens newly selected canonical conversation instead of closed A');
  assert(conversationRows.some(item => item.conversation_id === 'A'), 'restart leaves old conversation history in the list');
  const create = interactionButton('[data-planning-create]'); create.dataset.planningCreate = 'charter';
  conversationCtx.onInlineConversationClick({ target: { closest: () => create } });
  const pendingCreate = pendingInteraction;
  await conversationCtx.openProjectNativeSession('p1', 'charter', 'B');
  delayedCreateResolve({ conversation: { conversation_id: 'late-D', kind: 'charter' } }); await pendingCreate;
  assert.equal(conversationOpens.at(-1).conversation_id, 'B', 'a delayed metadata creation must not override newer conversation navigation');
  conversationCtx.state.nativeConversations.p1 = [{ conversation_id: 'history-plan', kind: 'planning', thread_id: 'historical-thread', status: 'closed' }, { conversation_id: 'new-plan', kind: 'planning', thread_id: null, status: 'draft' }];
  conversationCtx.inlineConversation = { target: { project_id: 'p1', kind: 'charter' }, context: { charter: { status: 'draft' } } };
  const historyMarkup = conversationCtx.planningConversationListMarkup();
  assert(!/data-planning-conversation="history-plan"[^>]* disabled/.test(historyMarkup), 'existing planning history remains accessible while charter is revised');
  assert(/data-planning-conversation="new-plan"[^>]* disabled/.test(historyMarkup), 'a new planning draft still requires confirmed charter');

  class InteractiveNode extends NodeFixture {
    constructor(name) { super(name); this.isConnected = true; this.inert = false; this.hidden = false; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { return this.name === 'native-layout' && selector.includes('contenteditable') ? [editor] : []; }
    closest(selector) { return selector.includes('data-composer-surface-variant') ? composer : null; }
    getBoundingClientRect() { return { width: 500, height: 700, left: 0, top: 0, right: 500, bottom: 700 }; }
  }
  const nativeLayout = new InteractiveNode('native-layout'), composer = new InteractiveNode('composer'), editor = new InteractiveNode('editor');
  nativeLayout.appendChild(composer); composer.appendChild(editor);
  let editorBlurs = 0; editor.blur = () => editorBlurs++;
  const inertCtx = vm.createContext({ HTMLElement: InteractiveNode, innerWidth: 1326, innerHeight: 1400,
    inlineConversation: { mode: 'draft', read_only: false }, inlineConversationLoading: true, inlineConversationError: '',
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: { activeElement: editor, querySelectorAll: selector => selector === '[data-better-codex-inline-content]' ? [nativeLayout] : [nativeLayout, composer].filter(node => node.hasAttribute('data-better-codex-inline-blocked')) } });
  for (const name of ['injectedElementVisible', 'inlineNativeElementVisible', 'syncInlineConversationInteraction']) vm.runInContext(readFunction(name), inertCtx);
  inertCtx.syncInlineConversationInteraction(); inertCtx.syncInlineConversationInteraction();
  assert.equal(nativeLayout.inert, true, 'repeated loading renders keep previous native input blocked');
  assert.equal(inertCtx.injectedElementVisible(editor), false, 'general visibility does not change its native inert semantics');
  assert.equal(inertCtx.inlineNativeElementVisible(editor), true, 'owned inert is still available to read-only native layout inspection');
  inertCtx.inlineConversationLoading = false; inertCtx.inlineConversationError = 'Open failed';
  inertCtx.syncInlineConversationInteraction();
  assert.equal(nativeLayout.inert, true, 'failed open cannot expose the previous conversation input');
  inertCtx.inlineConversationError = ''; inertCtx.syncInlineConversationInteraction();
  assert.equal(nativeLayout.inert, false, 'successful retry releases only owned native blocking');
  inertCtx.inlineConversation.read_only = true;
  inertCtx.syncInlineConversationInteraction(); inertCtx.syncInlineConversationInteraction();
  assert.equal(nativeLayout.inert, false, 'history messages remain browsable');
  assert.equal(composer.inert, true, 'historical planning input stays disabled until charter confirmation');
  inertCtx.inlineConversation.read_only = false; inertCtx.syncInlineConversationInteraction();
  assert.equal(composer.inert, false);
  assert(editorBlurs > 0);

  const planningRoot = new NodeFixture('planning-root'), planningSurface = new NodeFixture('planning-surface');
  const projectColumn = new NodeFixture('projects'), conversationColumn = new NodeFixture('conversations'), detailsColumn = new NodeFixture('details');
  planningRoot.parts = { '.better-codex-inline-heading': new NodeFixture('heading'), '.bc-planning-projects': projectColumn, '.bc-planning-conversations': conversationColumn, '.better-codex-inline-details': detailsColumn, '.better-codex-inline-resize': new NodeFixture('resize'), '.better-codex-inline-notice': new NodeFixture('notice'), '.better-codex-inline-status': new NodeFixture('status') };
  planningRoot.closest = () => planningSurface;
  let compactWorkspace = false;
  const renderCtx = vm.createContext({ state: { issues: [], projectDetailId: 'p1', projects: [{ id: 'p1', name: 'Project one' }, { id: 'p2', name: 'Project two' }], nativeConversations: { p1: [{ conversation_id: 'A', kind: 'charter', title: 'Architecture A', status: 'draft' }, { conversation_id: 'B', kind: 'charter', title: 'Architecture B', thread_id: 'thread-B' }] } },
    inlineConversation: { target: { project_id: 'p1', kind: 'charter', conversation_id: 'A' }, context: { charter: { status: 'confirmed' } }, mode: 'draft' }, inlineConversationRoot: planningRoot,
    inlineConversationHeaderMarkup: '', inlineConversationNavigationMarkup: '', inlineConversationDetailsMarkup: '', inlineConversationError: '', inlineConversationCacheRestoring: false, inlineConversationLoading: false, projectSurfaceCache: null,
    inlineConversationDetailsOpen: true, inlineConversationCompactDetailsOpen: false, inlineConversationWidth: 360, innerWidth: 1326,
    window: { matchMedia: () => ({ matches: compactWorkspace }) }, document: { documentElement: { style: new NodeFixture('html').style } },
    t: value => value, te: value => value, escapeHtml2: value => String(value), icon: name => '<i>' + name + '</i>', projectLabel: project => project.name,
    statusLabels: { todo: '待办', backlog: '待规划', in_progress: '进行中', done: '已完成' },
    projectsByRecentActivity: projects => projects, projectRootPaths: () => ['D:\\workspace'], projectPlanningMarkup: () => 'Project charter and tasks', syncInlineConversationInteraction() {} });
  for (const name of ['releaseProjectSurfaceCache', 'readProjectView', 'rememberProjectView', 'planningStageTabsMarkup', 'inlineConversationTarget', 'projectSidebarMarkup', 'planningConversationListMarkup', 'issueExecutionRunning', 'inlineWorkStateLabel', 'workConversationListMarkup', 'projectDocumentValue', 'documentTextMarkup', 'issuePlanDetailMarkup', 'planItemDetailsMarkup', 'inlineWorkDetailsMarkup', 'renderInlineConversation']) vm.runInContext(readFunction(name), renderCtx);
  renderCtx.renderInlineConversation();
  renderCtx.inlineConversationLoading = true;
  renderCtx.inlineConversationCacheRestoring = true;
  renderCtx.projectSurfaceCache = { nativeRetained: true };
  renderCtx.renderInlineConversation();
  assert.equal(planningRoot.parts['.better-codex-inline-status'].hidden, true, 'a genuine retained native page stays visible during background validation');
  renderCtx.projectSurfaceCache.nativeRetained = false;
  renderCtx.renderInlineConversation();
  assert.equal(planningRoot.parts['.better-codex-inline-status'].hidden, false, 'a missing native cache cannot expose an unrelated Home composer');
  renderCtx.inlineConversationLoading = false;
  renderCtx.inlineConversationCacheRestoring = false;
  renderCtx.renderInlineConversation();
  assert(projectColumn.innerHTML.includes('Project one') && projectColumn.innerHTML.includes('Project two'), 'four-column workspace uses Better Codex project data');
  assert(conversationColumn.innerHTML.includes('Architecture A') && conversationColumn.innerHTML.includes('Architecture B'), 'second column contains current project planning conversation history');
  assert.equal(projectColumn.hidden, false); assert.equal(conversationColumn.hidden, false); assert.equal(detailsColumn.hidden, false);
  assert.equal(planningSurface.style.values.get('--bc-inline-nav-space'), '370px');
  assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '318px');
  renderCtx.inlineConversationDetailsOpen = false; renderCtx.renderInlineConversation();
  assert.equal(detailsColumn.hidden, true); assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '0px', 'desktop collapse releases the fourth-column space');
  compactWorkspace = true; renderCtx.innerWidth = 900; renderCtx.renderInlineConversation();
  assert.equal(projectColumn.hidden, false); assert.equal(conversationColumn.hidden, false); assert.equal(detailsColumn.hidden, true, 'compact workspace retains the first three columns');
  renderCtx.inlineConversationCompactDetailsOpen = true; renderCtx.renderInlineConversation();
  assert.equal(detailsColumn.hidden, false);
  assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '0px', 'compact document drawer never narrows the native chat column');

  renderCtx.state.nativeWorkConversations = { p1: [
    { project_id: 'p1', kind: 'work', issue_id: 'work-one', title: 'First task', source: 'current', status: 'todo' },
    { project_id: 'p1', kind: 'work', issue_id: 'work-one', title: 'First task', source: 'history', history_id: 'old-one', thread_id: 'old-work-one', archived_at: '2026-10-03T12:00:00Z' },
    { project_id: 'p1', kind: 'work', issue_id: 'work-two', title: 'Second task', source: 'current', status: 'in_progress', active_run_status: 'running', thread_id: 'work-two-thread' }
  ] };
  renderCtx.inlineConversation = { target: { project_id: 'p1', kind: 'work', issue_id: 'work-one' }, mode: 'draft', context: {
    task: { id: 'work-one', title: 'First task', status: 'todo', agent_enabled: true, description: 'Task requirements', architecture: 'Module responsibilities', acceptance_criteria: ['Required acceptance result'], charter_revision: 3 },
    charter: { revision: 3, sections: [{ title: 'Contract chapter', content: 'Referenced contract version three' }] }
  } };
  compactWorkspace = false; renderCtx.innerWidth = 1326; renderCtx.inlineConversationDetailsOpen = true;
  const heading = planningRoot.parts['.better-codex-inline-heading'];
  heading.parts = { '.better-codex-inline-heading-actions': { getBoundingClientRect: () => ({ width: 244 }) } };
  renderCtx.renderInlineConversation();
  assert.equal(projectColumn.hidden, false); assert.equal(conversationColumn.hidden, false); assert.equal(detailsColumn.hidden, false);
  assert(conversationColumn.innerHTML.includes('First task') && conversationColumn.innerHTML.includes('Second task'), 'work navigation groups all tasks in the current project');
  assert(conversationColumn.innerHTML.includes('data-work-history="old-one"'), 'each task exposes its associated history without replacing current session');
  assert(conversationColumn.innerHTML.includes('工作中'), 'second-column status comes from real task execution fields');
  assert(heading.innerHTML.includes('data-work-create="work-one"'), 'work toolbar creates a new native conversation for the same task');
  assert(!heading.innerHTML.includes('data-inline-start'), 'work toolbar sends work through the native composer');
  for (const value of ['Task requirements', 'Module responsibilities', 'Required acceptance result', 'Referenced contract version three', '任务状态 · 待办', '版本 3']) assert(detailsColumn.innerHTML.includes(value), value);
  assert.equal(planningSurface.style.values.get('--bc-inline-nav-space'), '370px', 'work reserves the same first two columns as planning');
  assert.equal(renderCtx.document.documentElement.style.values.get('--bc-planning-toolbar-space'), '268px', 'native menu reserves the measured workspace toolbar width');
  renderCtx.inlineConversation.context.task.status = 'backlog'; renderCtx.renderInlineConversation();
  assert(!heading.innerHTML.includes('data-inline-start'), 'backlog tasks cannot skip planning through a start button');
  renderCtx.inlineConversation.context.task.status = 'todo';
  renderCtx.inlineConversation.target.history_id = 'old-one'; renderCtx.inlineConversation.read_only = true; renderCtx.inlineConversation.mode = 'thread';
  renderCtx.renderInlineConversation();
  assert(!heading.innerHTML.includes('data-inline-start') && !heading.innerHTML.includes('data-inline-restart'), 'history has no task mutation buttons');
  assert.equal(planningRoot.parts['.better-codex-inline-status'].hidden, true, 'native historical messages are never replaced by a Better Codex message renderer');
  assert.equal(planningRoot.parts['.better-codex-inline-notice'].textContent, '历史会话仅供查看。');
  compactWorkspace = true; renderCtx.innerWidth = 900; renderCtx.inlineConversationCompactDetailsOpen = true; renderCtx.renderInlineConversation();
  assert.equal(detailsColumn.hidden, false);
  assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '0px', 'work material drawer overlays without compressing native messages');

  let resizeFrameSequence = 0, navigationRebuilds = 0;
  const resizeFrames = new Map(), cancelledResizeFrames = [];
  renderCtx.destroyed = false; renderCtx.inlineConversationResizeFrame = null;
  renderCtx.requestAnimationFrame = callback => { const id = ++resizeFrameSequence; resizeFrames.set(id, callback); return id; };
  renderCtx.cancelAnimationFrame = id => { cancelledResizeFrames.push(id); resizeFrames.delete(id); };
  for (const name of ['cancelInlineConversationViewportResize', 'onInlineConversationViewportResize']) vm.runInContext(readFunction(name), renderCtx);
  for (const column of [projectColumn, conversationColumn]) {
    let markup = column.innerHTML;
    Object.defineProperty(column, 'innerHTML', { get: () => markup, set: value => { markup = value; navigationRebuilds++; }, configurable: true });
  }
  const flushResizeFrame = () => { const [id, callback] = resizeFrames.entries().next().value; resizeFrames.delete(id); callback(); };
  renderCtx.inlineConversationCompactDetailsOpen = false;
  compactWorkspace = false; renderCtx.innerWidth = 1920; renderCtx.onInlineConversationViewportResize(); flushResizeFrame();
  assert.equal(planningSurface.style.values.get('--bc-inline-nav-space'), '370px');
  assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '360px');
  assert.equal(detailsColumn.hidden, false);
  compactWorkspace = true; renderCtx.innerWidth = 900;
  for (let index = 0; index < 8; index++) renderCtx.onInlineConversationViewportResize();
  assert.equal(resizeFrames.size, 1, 'continuous window resize events coalesce into one native layout update');
  flushResizeFrame();
  assert.equal(planningSurface.style.values.get('--bc-inline-nav-space'), '328px', 'narrow resize immediately matches the CSS sidebar widths');
  assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '0px', 'narrow resize releases the document column without waiting for a task event');
  assert.equal(detailsColumn.hidden, true);
  compactWorkspace = false; renderCtx.innerWidth = 1920; renderCtx.onInlineConversationViewportResize(); flushResizeFrame();
  assert.equal(planningSurface.style.values.get('--bc-inline-nav-space'), '370px');
  assert.equal(planningSurface.style.values.get('--bc-inline-details-space'), '360px', 'returning to desktop restores its saved document preference');
  assert.equal(detailsColumn.hidden, false);
  assert.equal(navigationRebuilds, 0, 'viewport resizing keeps project and task sidebar nodes intact');
  renderCtx.onInlineConversationViewportResize();
  const pendingResizeFrame = renderCtx.inlineConversationResizeFrame;
  renderCtx.cancelInlineConversationViewportResize();
  assert.equal(resizeFrames.size, 0); assert.equal(renderCtx.inlineConversationResizeFrame, null);
  assert(cancelledResizeFrames.includes(pendingResizeFrame));
  assert(readFunction('destroy').includes('cancelInlineConversationViewportResize()') && readFunction('destroy').includes('window.removeEventListener("resize", onInlineConversationViewportResize)'), 'final teardown cancels pending updates and releases the listener');
  assert(readFunction('leaveInlineConversation').includes('cancelInlineConversationViewportResize()'), 'leaving a workspace cancels its queued layout update');

  const historyTarget = { project_id: 'p1', kind: 'work', issue_id: 'work', history_id: 'history-one' };
  assert.notEqual(ctx.inlineConversationKey(historyTarget), ctx.inlineConversationKey({ project_id: 'p1', kind: 'work', issue_id: 'work' }));
  assert.notEqual(ctx.inlineConversationKey(historyTarget), ctx.inlineConversationKey({ ...historyTarget, history_id: 'history-two' }));
  assert.match(ctx.inlineConversationQuery(historyTarget), /history_id=history-one/);
  const historyHttpStart = http.length;
  await ctx.openInlineConversation(historyTarget);
  assert.equal(ctx.inlineConversation.read_only, true);
  assert.equal(ctx.inlineConversation.binding.thread_id, 'history-work-thread');
  assert.equal(ctx.state.nativeThreadLinks['history-work-thread'], undefined, 'historical threads never enter the active editable binding registry');
  await ctx.reloadInlineConversationContext();
  assert.equal(ctx.inlineConversation.read_only, true, 'refresh keeps historical work read-only even with a confirmed charter');
  const workHistorySnapshot = plain(ctx.captureReloadState());
  assert.equal(workHistorySnapshot.nativeConversation.target.history_id, 'history-one');
  assert.equal(workHistorySnapshot.nativeConversation.context.read_only, true);
  await ctx.restoreReloadState(workHistorySnapshot);
  assert.equal(ctx.inlineConversationTarget().history_id, 'history-one', 'hot reload restores the precise historical target');
  assert.equal(http.slice(historyHttpStart).filter(call => call.method !== 'GET').length, 0, 'opening, refreshing and restoring history is fully read-only');
  assert(registeredBindings.at(-1).every(row => row.thread_id !== 'history-work-thread'));

  conversationCtx.inlineConversation = { target: historyTarget, read_only: true, mode: 'thread' };
  const beforeHistoryMutation = conversationCalls.length;
  for (const selector of ['[data-inline-start]', '[data-inline-restart]', '[data-inline-handoff]']) conversationCtx.onInlineConversationClick({ target: { closest: () => interactionButton(selector) } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(conversationCalls.length, beforeHistoryMutation, 'readonly guards reject stale task toolbar events before API calls');

  const originalApi = ctx.api;
  let releaseProjectList;
  ctx.api = async (url, options) => url.includes('/list?project_id=p2&kind=work') ? new Promise(resolve => { releaseProjectList = resolve; }) : originalApi(url, options);
  const pendingProjectSwitch = ctx.openProjectWorkSession('p2');
  desiredMode = 'draft'; binding = null;
  await ctx.openIssueNativeConversation({ id: 'new-current-work', project_id: 'p1' });
  releaseProjectList({ conversations: [{ project_id: 'p2', kind: 'work', source: 'current', issue_id: 'other-project-work' }] });
  assert.equal((await pendingProjectSwitch).reason, 'navigation_changed');
  assert.equal(ctx.inlineConversationTarget().issue_id, 'new-current-work', 'a late project work list cannot override a more recent direct task click');
  let releaseOldContext;
  ctx.api = async (url, options) => url.includes('/context?') && url.includes('issue_id=old-current-work') ? new Promise(resolve => { releaseOldContext = resolve; }) : originalApi(url, options);
  const pendingOldWork = ctx.openIssueNativeConversation({ id: 'old-current-work', project_id: 'p1' });
  await new Promise(resolve => setImmediate(resolve));
  await ctx.openInlineConversation({ ...historyTarget, history_id: 'history-two' });
  releaseOldContext({ mode: 'draft', binding: null, context: { task: { id: 'old-current-work' } } });
  assert.equal((await pendingOldWork).reason, 'navigation_changed');
  assert.equal(ctx.inlineConversationTarget().history_id, 'history-two', 'a late task context cannot replace a different historical native conversation');
  assert.equal(ctx.inlineConversation.read_only, true);
  hooks.onBound({ target: { project_id: 'p1', kind: 'work', issue_id: 'old-current-work' }, thread_id: 'late-old-work-thread' });
  assert.equal(ctx.inlineConversation.binding.thread_id, 'history-work-thread', 'a late offscreen task binding stays under its own task');
  assert.equal(ctx.state.nativeThreadLinks['late-old-work-thread'].issue_id, 'old-current-work');
  ctx.api = originalApi;

  const workQueueRequests = [];
  let queueRefreshes = 0, materialRefreshes = 0, releaseQueuedStart;
  conversationCtx.inlineConversation = { target: { project_id: 'p1', kind: 'work', issue_id: 'explicit-queue-task' }, mode: 'draft' };
  conversationCtx.api = async (url, options = {}) => {
    workQueueRequests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (url.endsWith('/start')) return new Promise(resolve => { releaseQueuedStart = resolve; });
    return { id: 'explicit-queue-task', version: 9 };
  };
  conversationCtx.loadIssues = async () => queueRefreshes++;
  conversationCtx.reloadInlineConversationContext = async () => materialRefreshes++;
  const explicitStart = interactionButton('[data-inline-start]'); explicitStart.isConnected = true;
  conversationCtx.onInlineConversationClick({ target: { closest: () => explicitStart } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(conversationCtx.inlineConversation.start_requested, true);
  assert.deepEqual(workQueueRequests.filter(call => call.method === 'POST'), [{ url: '/api/issues/explicit-queue-task/start', method: 'POST', body: { version: 9 } }], 'explicit Start uses the existing versioned task queue exactly once');
  conversationCtx.inlineConversation = { target: historyTarget, mode: 'thread', read_only: true };
  releaseQueuedStart({ queued: true }); await pendingInteraction;
  assert.equal(queueRefreshes, 1);
  assert.equal(materialRefreshes, 0, 'a late queued start never navigates or reloads another task history');
  assert.equal(conversationCtx.inlineConversation.start_requested, undefined, 'queued start state cannot leak into the newly selected history');

  desiredMode = 'thread'; binding = { thread_id: 'history-planning-thread' }; confirmed = false;
  await ctx.openInlineConversation({ project_id: 'p1', kind: 'planning', conversation_id: 'history' });
  assert.equal(ctx.inlineConversation.read_only, true, 'bound planning history opens read-only during charter revision');
  confirmed = true; await ctx.reloadInlineConversationContext();
  assert.equal(ctx.inlineConversation.read_only, false, 'confirming charter releases current planning composer');
  assert.equal(adapterContextUpdates.at(-1).read_only, false, 'authoritative charter confirmation also releases the adapter send scope');
  assert.equal(adapterContextUpdates.at(-1).target.conversation_id, 'history', 'scope refresh keeps the same planning identity');
  confirmed = false; await ctx.reloadInlineConversationContext();
  assert.equal(ctx.inlineConversation.read_only, true, 'fresh charter revision disables the already-open planning composer');
  assert.equal(adapterContextUpdates.at(-1).read_only, true, 'fresh charter revision also blocks the adapter send scope without navigation');
  confirmed = true; desiredMode = 'draft'; binding = null;
  await ctx.openIssueNativeConversation({ project_id: 'p1', id: 'first-empty-task' });
  const firstEmptyId = ctx.inlineConversationTarget().conversation_id;
  assert(firstEmptyId, 'a first empty task conversation receives a stable ID before opening the native draft');
  assert.equal(ctx.state.nativeWorkSelections.p1.conversation_id, firstEmptyId);
  await ctx.createIssueNativeConversation({ project_id: 'p1', id: 'first-empty-task' });
  const secondEmptyId = ctx.inlineConversationTarget().conversation_id;
  assert(secondEmptyId && secondEmptyId !== firstEmptyId, 'a second empty native draft keeps a separate identity before either chat is sent');
  await ctx.openIssueNativeConversation({ project_id: 'p1', id: 'first-empty-task' }, firstEmptyId);
  assert.equal(ctx.inlineConversationTarget().conversation_id, firstEmptyId, 'the first unsent draft can be reopened by its stable ID');
  assert.equal(workFixtureConversations.filter(row => row.issue_id === 'first-empty-task').length, 2, 'opening an existing empty draft does not register a third conversation');
  const taskConversations = [
    { project_id: 'p1', kind: 'work', issue_id: 'multi-task', conversation_id: 'work-c1', source: 'current', selected: true, title: 'Multi-session task', thread_id: 'thread-c1', status: 'todo' },
    { project_id: 'p1', kind: 'work', issue_id: 'multi-task', conversation_id: 'work-c2', source: 'current', selected: false, title: 'Multi-session task', status: 'todo' }
  ];
  const multiCalls = [];
  ctx.api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    multiCalls.push({ url, method: options.method || 'GET', body });
    if (url.includes('/list?')) return { conversations: taskConversations };
    if (url.endsWith('/select')) { taskConversations.forEach(row => row.selected = row.conversation_id === body.conversation_id); return {}; }
    if (url.endsWith('/create')) {
      taskConversations.forEach(row => row.selected = false);
      const conversation = { project_id: body.project_id, kind: 'work', issue_id: body.issue_id, conversation_id: 'work-c3', source: 'current', selected: true, title: 'Multi-session task', status: 'todo' };
      taskConversations.push(conversation); return { conversation };
    }
    const query = new URLSearchParams(url.split('?')[1]);
    const row = taskConversations.find(item => item.conversation_id === query.get('conversation_id')) || taskConversations.find(item => item.selected);
    return { mode: row.thread_id ? 'thread' : 'draft', thread_id: row.thread_id || null, binding: row.thread_id ? { thread_id: row.thread_id } : null, expected_revision: 1, target: { project_id: 'p1', kind: 'work', issue_id: row.issue_id, conversation_id: row.conversation_id }, context: { task: { id: row.issue_id, title: row.title, status: row.status } } };
  };
  await ctx.openIssueNativeConversation({ project_id: 'p1', id: 'multi-task' }, 'work-c2');
  assert.equal(ctx.inlineConversationTarget().conversation_id, 'work-c2');
  assert.equal(ctx.state.nativeWorkSelections.p1.conversation_id, 'work-c2');
  assert.deepEqual(multiCalls.find(call => call.url.endsWith('/select')).body, { project_id: 'p1', kind: 'work', issue_id: 'multi-task', conversation_id: 'work-c2' });
  assert.equal(ctx.captureReloadState().nativeConversation.target.conversation_id, 'work-c2');
  await ctx.createIssueNativeConversation({ project_id: 'p1', id: 'multi-task' });
  assert.equal(ctx.inlineConversationTarget().conversation_id, 'work-c3');
  assert.equal(taskConversations.length, 3);
  assert.deepEqual(multiCalls.find(call => call.url.endsWith('/create')).body, { project_id: 'p1', kind: 'work', issue_id: 'multi-task' });
  assert(!multiCalls.some(call => /\/(start|prepare|bind)$/.test(call.url)), 'opening, selecting and adding chats never sends work');
  renderCtx.state.nativeWorkConversations.p1 = taskConversations;
  renderCtx.inlineConversation = { target: { project_id: 'p1', kind: 'work', issue_id: 'multi-task', conversation_id: 'work-c2' }, mode: 'draft', context: { task: { id: 'multi-task', title: 'Multi-session task', status: 'todo' } } };
  renderCtx.renderInlineConversation();
  assert.equal((conversationColumn.innerHTML.match(/class="bc-work-conversation-group"/g) || []).length, 1, 'one task groups all active native chats');
  for (const id of ['work-c1', 'work-c2', 'work-c3']) assert(conversationColumn.innerHTML.includes('data-work-conversation-id="' + id + '"'));
  assert(conversationColumn.innerHTML.includes('data-work-create="multi-task"'));
  assert.equal((conversationColumn.innerHTML.match(/aria-current="true"/g) || []).length, 1, 'only the precise selected chat is active');
  ctx.api = originalApi;
  console.log('PASS: planning conversation identity, precise sidebar selection, canonical restart, stale creation protection and native fail-closed/read-only fixtures');
  console.log('PASS: inline empty native drafts, scoped routes, stage isolation, stale callbacks, reload reattachment, legacy writer preservation and stable native DOM fixtures');
  console.log('PASS: work four-column navigation, honest task material/state, immutable native histories, reload identity and readonly toolbar guards');
})().catch(error => { console.error(error); process.exitCode = 1; });

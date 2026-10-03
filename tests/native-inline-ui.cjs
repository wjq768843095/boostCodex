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
const http = [], hostActions = [], registeredBindings = [], acceptedRoutes = new Set();
let hooks, desiredMode = 'draft', confirmed = true, binding = null;
const adapter = {
  open: async response => { hostActions.push({ action: 'open', target: plain(response.target) }); const route = response.binding ? '/local/' + response.binding.thread_id : '/local/client-new-thread:' + response.target.project_id + ':' + response.target.kind + ':' + (response.target.issue_id || ''); acceptedRoutes.clear(); acceptedRoutes.add(route); ctx.location.pathname = route; ctx.location.search = ''; return { mode: response.mode }; },
  leave: () => { hostActions.push({ action: 'leave' }); acceptedRoutes.clear(); },
  restore: async (response, saved) => { hostActions.push({ action: 'restore', target: plain(response.target), saved }); acceptedRoutes.clear(); acceptedRoutes.add(ctx.location.pathname + ctx.location.search); return { mode: response.mode }; },
  ownsRoute: route => acceptedRoutes.has(route),
  registerBindings: bindings => registeredBindings.push(plain(bindings)),
  capture: () => ({ opaque: 'native-draft-state' })
};
const ctx = vm.createContext({
  URLSearchParams, state: { projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }], issues: [], projectIssues: [], surface: 'projects', projectPage: 'planning', nativePlanningEnabled: true },
  location: { pathname: '/local/original-thread', search: '' }, NAVIGATION: { threadRoutePrefix: '/local/' },
  inlineConversation: null, inlineConversationRoot: {}, inlineConversationAdapter: null,
  inlineConversationRequest: 0, inlineConversationLoading: false, inlineConversationError: '',
  inlineConversationDetailsOpen: true, inlineConversationWidth: 360, active: true, destroyed: false, routeSuppressed: false, pollTimer: null,
  relayId: 'fixture-relay', relayThreads: new Set(), RESUME_SURFACE_KEY: 'fixture-resume', projectPlanningDrafts: new Map(),
  t: value => value, normalizeSessionId: value => String(value || ''), appendDiagnostic() {},
  sessionStorage: { setItem() {} }, ensureEntry() {}, ensureBootstrapReady: async () => {}, mountPanel() {}, renderInlineConversation() {}, render() {},
  startLiveUpdates: () => true, setInterval: () => 1, perform: fn => fn(),
  bootstrapFailure: null, injectionSurfaceError: () => null,
  window: { BetterCodexNativeConversation: { create: config => { hooks = config; return adapter; } } },
  api: async (url, options = {}) => {
    http.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/conversation')) return { messages: [{ role: 'user', markdown: 'Historical request' }] };
    const query = new URLSearchParams(url.split('?')[1]);
    return { mode: desiredMode, binding, expected_revision: 3, native_project_id: 'native-' + query.get('project_id'), planning_available: confirmed, context: { project: { id: query.get('project_id') }, charter: { revision: 2, status: confirmed ? 'confirmed' : 'draft' }, plan: { revision: 1, items: [] } } };
  },
  isBetterCodexRoute: () => false,
  entry: {}, agentsEntry: {}, projectsEntry: {}, moreEntry: null, profileEntry: null, usageEntry: null, themeEntry: null,
  suppressAgentOutside: false, suppressSessionClickUntil: 0, nativeThreadOpenBypass: '', PANEL_ID: 'better-codex-panel',
  SELECTORS: { threadRow: '[data-thread]', sidebarNavigation: '[data-sidebar]', projectRow: '[data-project-row]' }, SIDEBAR_NAVIGATION_ITEM: '.sidebar-item',
  issueSessionId: issue => issue.session_thread_id || issue.thread_id || '', nativeThreadId: row => row.thread_id || '',
  isNativeRailDestination: () => false, isSidebarNavigationTarget: () => false,
  closeAuxiliaryMenu() {}, openRoute() {}, close() {}
});
for (const name of ['inlineConversationKey', 'inlineConversationTarget', 'inlineConversationRouteAllowed', 'nativeInlineErrorLabel', 'ensureInlineConversationAdapter', 'registerInlineConversationBindings', 'inlineConversationQuery', 'reloadInlineConversationContext', 'openInlineConversation', 'openIssueNativeConversation', 'openProjectNativeSession', 'captureReloadState', 'restoreReloadState', 'isManagedNativeThread', 'onClick']) vm.runInContext(readFunction(name), ctx);

class NodeFixture {
  constructor(name) { this.name = name; this.children = []; this.attrs = new Map(); this.style = { setProperty() {} }; this.listeners = {}; this.parentElement = null; this.appendCount = 0; this.innerHTML = ''; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  hasAttribute(name) { return this.attrs.has(name); }
  matches(selector) { return this.name === 'native' && selector === '.native-layout'; }
  querySelector(selector) { if (this.name === 'native') return selector === '.native-frame' ? {} : null; return this.parts?.[selector] || null; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  appendChild(child) { this.appendCount++; this.children.push(child); child.parentElement = this; }
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
    inlineConversationRoot: null, inlineConversation: { target: charter }, panel: { hidden: false }, OWNED: 'data-owned',
    SELECTORS: { contentLayout: '.native-layout', contentFrame: '.native-frame' }, t: value => value, te: value => value,
    inlineConversationResize: null, inlineConversationWidth: 360, localStorage: { setItem() {} },
    onInlineConversationClick() {}, renderInlineConversation() {},
    document: { createElement() { const root = new NodeFixture('root'); root.parts = { '.better-codex-inline-resize': new NodeFixture('resize') }; return root; } }
  });
  vm.runInContext(readFunction('mountInlineConversation'), layoutCtx);
  for (let index = 0; index < 20; index++) layoutCtx.mountInlineConversation(surface);
  assert.equal(surface.children[0], native, 'React native layout stays at its original position');
  assert.equal(surface.children.length, 2);
  assert.equal(surface.appendCount, originalAppends + 1, 'refresh neither moves native layout nor recreates project shell');
  assert.equal(native.hasAttribute('data-better-codex-native-hidden'), false);
  assert.equal(native.hasAttribute('data-better-codex-inline-content'), true);
  assert.equal(layoutCtx.panel.hidden, true);

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
  assert(source.includes('destroyRemovedComponents(records, [panel, inlineConversationRoot].filter(Boolean))'), 'observer preserves only current reusable shells');
  let missingRailMounts = 0, missingRailCloses = 0;
  const routeCtx = vm.createContext({ HOST_KIND: 'codex', location: { pathname: '/index.html' }, state: {},
    active: true, inlineConversation: { target: charter }, inlineConversationLoading: false,
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
  console.log('PASS: inline empty native drafts, scoped routes, stage isolation, stale callbacks, reload reattachment, legacy writer preservation and stable native DOM fixtures');
})().catch(error => { console.error(error); process.exitCode = 1; });

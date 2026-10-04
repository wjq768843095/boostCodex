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
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function fixture() {
  const events = [], writes = [], restores = [], destroyedRoots = [];
  const scroller = { scrollTop: 187, scrollLeft: 29 };
  const root = { removed: 0, isConnected: true, remove() { this.removed++; this.isConnected = false; }, querySelectorAll: () => [scroller] };
  const context = { project: { id: 'p1' }, charter: { revision: 3, status: 'confirmed' }, plan: { revision: 2 } };
  const target = { project_id: 'p1', kind: 'planning', conversation_id: 'planning-one' };
  const conversation = { target, mode: 'thread', binding: { thread_id: 'native-one' }, thread_id: 'native-one', context, route: '/local/native-one', return_surface: 'projects' };
  const snapshot = { mode: 'thread', route: '/local/native-one', target, draft: 'Unsent composer text' };
  const adapter = {
    capture: () => snapshot,
    restore: async (cachedContext, cachedSnapshot) => { restores.push({ context: cachedContext, snapshot: cachedSnapshot }); events.push({ type: 'restore' }); return { mode: 'thread' }; },
    leave: () => events.push({ type: 'leave' }),
    updateContext: value => events.push({ type: 'context-update', value }),
    getCurrentContext: () => ({ thread_id: 'native-one' }),
    registerBindings() {}
  };
  const ctx = vm.createContext({
    URLSearchParams,
    state: { surface: 'projects', projectDetailId: 'p1', projectId: 'p1', projectPage: 'planning', projectDocumentView: 'planning', projectResumePending: '', projects: [{ id: 'p1' }, { id: 'p2' }], projectsLoaded: true, projectIssues: [], projectIssuesProjectId: 'p1', issues: [], nativePlanningEnabled: true },
    projectSurfaceCache: null, inlineConversation: conversation, inlineConversationRoot: root, inlineNativePanelObserver: null, inlineNativePanelNode: null,
    inlineConversationAdapter: adapter, inlineConversationRequest: 3, inlineConversationNavigationRequest: 5,
    inlineConversationLoading: false, inlineConversationCacheRestoring: false, inlineConversationError: '', inlineConversationDetailsMarkup: 'details', inlineConversationHeaderMarkup: 'heading', inlineConversationNavigationMarkup: 'navigation',
    inlineConversationDetailsOpen: false, inlineConversationCompactDetailsOpen: true, inlineConversationWidth: 432,
    active: true, destroyed: false, routeSuppressed: false, routeSeen: false,
    pollTimer: null, retryClockTimer: null, bootstrapFailure: null,
    availableSurfaces: ['projects', 'issues', 'agents'], HOST_KIND: 'desktop', RESUME_SURFACE_KEY: 'resume-surface', PROJECT_KEY: 'project-key', relayId: 'fixture-relay',
    location: { pathname: '/local/native-one', search: '' },
    localStorage: { getItem: key => key === 'better-codex-managed-project' ? 'p1' : null, setItem: (key, value) => writes.push({ key, value }) },
    sessionStorage: { setItem: (key, value) => writes.push({ key, value }), removeItem() {} },
    document: { hidden: false, querySelectorAll: () => [], documentElement: { removeAttribute() {} } },
    panel: { hidden: false, dataset: {}, removeAttribute() {}, querySelectorAll: () => [scroller] },
    normalizeSessionId: value => String(value || ''), appendDiagnostic() {}, rememberProjectView() {}, nativeInlineErrorLabel: () => '无法打开会话',
    ensureInlineConversationAdapter: () => adapter,
    ensureEntry() {}, ensureBootstrapReady: async () => {},
    mountPanel: () => { if (ctx.inlineConversationRoot) ctx.inlineConversationRoot.isConnected = true; events.push({ type: 'mount', root: ctx.inlineConversationRoot, page: ctx.state.projectPage, conversation: ctx.inlineConversation }); },
    renderInlineConversation: () => events.push({ type: 'inline-render', root: ctx.inlineConversationRoot }),
    render: () => events.push({ type: 'render', page: ctx.state.projectPage, conversation: ctx.inlineConversation }),
    renderProjects: () => events.push({ type: 'project-render', page: ctx.state.projectPage }),
    loadProjects: async () => { events.push({ type: 'load-projects' }); },
    load: async () => { events.push({ type: 'load' }); },
    loadSurface: async options => events.push({ type: 'load-surface', options }),
    reloadInlineConversationContext: async options => events.push({ type: 'reload-context', options }),
    perform: operation => operation(), startLiveUpdates: () => true, setInterval: () => 1, clearInterval() {},
    cancelInlineConversationViewportResize() {}, syncInlineConversationInteraction() {}, syncPlanningWorkspaceNativeChrome() {},
    destroyOwnedComponents: cachedRoot => destroyedRoots.push(cachedRoot),
    resetSessionDrag() {}, closeFilterMenu() {}, closeCreateMenu() {}, closeIssueMenu() {}, closeAuxiliaryMenu() {}, restoreNative() {},
    syncWebProjectRoute() {}, applyProjectView: projectId => { ctx.state.projectPage = 'overview'; ctx.state.projectDocumentView = 'charter'; ctx.state.projectResumePending = projectId; },
    injectionSurfaceError: () => null
  });
  for (const name of ['inlineConversationKey', 'inlineConversationTarget', 'releaseProjectSurfaceCache', 'cacheProjectSurface', 'restoreCachedProjectSurface', 'reconnectCachedProjectConversation', 'leaveInlineConversation', 'close', 'openRoute', 'open']) vm.runInContext(readFunction(name), ctx);
  return { ctx, events, writes, restores, destroyedRoots, root, scroller, context, target, conversation, snapshot, adapter };
}

(async () => {
  const saved = fixture();
  const { ctx, events, root, scroller, context, snapshot, adapter } = saved;
  const restoreGate = deferred();
  adapter.restore = (cachedContext, cachedSnapshot) => {
    saved.restores.push({ context: cachedContext, snapshot: cachedSnapshot });
    events.push({ type: 'restore' });
    return restoreGate.promise;
  };
  ctx.close();
  const cache = ctx.projectSurfaceCache;
  assert(cache, 'leaving through the native rail captures the healthy current project');
  assert.notEqual(cache.conversation, saved.conversation, 'navigation does not mutate the saved conversation envelope');
  assert.notEqual(cache.conversation.target, saved.target, 'target identifiers have an independent copy');
  assert.equal(cache.conversation.context, context, 'project materials remain in memory without serializing chat data');
  assert.equal(cache.root, root, 'the cache retains the actual sidebar/details DOM nodes');
  assert.equal(cache.adapterSnapshot, snapshot, 'native composer/route restoration uses the adapter snapshot');
  assert.equal(ctx.inlineConversation, null);
  assert.equal(ctx.inlineConversationRoot, null);
  assert.equal(ctx.active, false);
  assert.equal(events.filter(event => event.type === 'leave').length, 1, 'native sending scope is released while visiting Home');
  assert.equal(root.removed, 1, 'hidden UI is detached while its nodes stay available in memory');
  ctx.close();
  assert.equal(ctx.projectSurfaceCache, cache, 'closing an already hidden surface preserves its usable cache');

  scroller.scrollTop = 0; scroller.scrollLeft = 0;
  events.length = 0;
  ctx.state.projectPage = 'overview';
  ctx.inlineConversationWidth = 360;
  ctx.inlineConversationDetailsOpen = true;
  ctx.openRoute('projects');
  assert.equal(ctx.active, true, 'the project becomes visible synchronously');
  assert.equal(ctx.inlineConversationRoot, root, 'returning reuses the exact previous DOM node');
  assert.equal(ctx.state.projectPage, 'planning');
  assert.equal(ctx.state.projectDocumentView, 'planning');
  assert.equal(ctx.state.projectResumePending, '');
  assert.equal(ctx.inlineConversation.target.conversation_id, 'planning-one');
  assert.equal(ctx.inlineConversation.context, context);
  assert.equal(ctx.inlineConversationWidth, 432);
  assert.equal(ctx.inlineConversationDetailsOpen, false);
  assert.equal(ctx.inlineConversationCompactDetailsOpen, true);
  assert.equal(ctx.inlineConversationDetailsMarkup, 'details');
  assert.equal(ctx.inlineConversationHeaderMarkup, 'heading');
  assert.equal(ctx.inlineConversationNavigationMarkup, 'navigation');
  assert.equal(scroller.scrollTop, 187); assert.equal(scroller.scrollLeft, 29);
  assert.equal(ctx.inlineConversationLoading, true, 'native input remains guarded until the background permission check completes');
  assert.equal(events[0].type, 'mount');
  assert.equal(events[0].root, root);
  assert.equal(events[0].page, 'planning', 'the first frame is the remembered page without an overview flash');
  assert.deepEqual(events.map(event => event.type), ['mount', 'restore'], 'native route restoration begins before Runtime HTTP or generic project loading');
  assert.equal(saved.restores[0].snapshot, snapshot);
  assert.equal(saved.restores[0].context.context, context);
  restoreGate.resolve({ mode: 'thread' });
  await flush();
  assert.equal(ctx.inlineConversationLoading, false);
  assert.equal(ctx.inlineConversationCacheRestoring, false);
  assert.equal(events.filter(event => event.type === 'reload-context').length, 1);
  assert.equal(events.find(event => event.type === 'reload-context').options.background, true);
  assert(!events.some(event => ['load', 'load-projects', 'project-render'].includes(event.type)), 'cached inline navigation avoids the dashboard loading path');
  assert(saved.writes.every(write => !String(write.value).includes('Unsent composer text')), 'native draft content is never persisted by the surface cache');

  const beforeRepeat = events.length;
  ctx.openRoute('projects');
  assert.deepEqual(events.slice(beforeRepeat).map(event => event.type), ['mount'], 'reselecting the visible project does not release/reopen its conversation');
  assert.equal(ctx.restoreCachedProjectSurface('p2'), false, 'another project cannot inherit this conversation');
  assert.equal(ctx.inlineConversation.target.project_id, 'p1');

  const retained = fixture();
  retained.ctx.close();
  retained.events.length = 0;
  const permissionGate = deferred();
  retained.adapter.resumeRetained = () => { retained.events.push({ type: 'native-retained' }); return true; };
  retained.ctx.reloadInlineConversationContext = () => permissionGate.promise;
  retained.ctx.openRoute('projects');
  assert.deepEqual(retained.events.map(event => event.type), ['native-retained', 'mount'], 'the real native page is selected synchronously before the shell mounts, without regenerating prepared markup');
  assert.equal(retained.restores.length, 0, 'retained returns never reopen the conversation through async host navigation');
  assert.equal(retained.ctx.projectSurfaceCache.nativeRetained, true);
  assert.equal(retained.ctx.inlineConversationCacheRestoring, true, 'background validation keeps the existing page without the opening mask');
  permissionGate.resolve();
  await flush();
  assert.equal(retained.ctx.inlineConversationLoading, false);

  const prepared = fixture();
  const flags = new Map(), styles = new Map([['--bc-planning-left-space', '370px'], ['--bc-planning-details-space', '432px']]);
  const pageFlags = new Map(), homeFlags = new Map();
  const nativePage = { isConnected: true, children: [], style: { setProperty() {} }, setAttribute: (name, value) => pageFlags.set(name, value), removeAttribute: name => pageFlags.delete(name) };
  const homePage = { setAttribute: (name, value) => homeFlags.set(name, value), removeAttribute: name => homeFlags.delete(name) };
  const nativeLayout = { isConnected: true, setAttribute: (name, value) => flags.set(name, value) };
  const status = { hidden: true };
  const nativeSurface = { isConnected: true, closest: () => nativePage, querySelector: () => nativeLayout, setAttribute() {}, appendChild(node) { node.parentElement = this; }, style: { setProperty: (name, value) => styles.set(name, value) } };
  prepared.root.closest = () => nativeSurface;
  prepared.root.querySelector = () => status;
  prepared.ctx.document.documentElement.style = { getPropertyValue: name => styles.get(name) || '', setProperty: (name, value) => styles.set(name, value) };
  prepared.ctx.panel.appendChild = node => { node.parentElement = prepared.ctx.panel; node.isConnected = true; };
  prepared.ctx.panel.setAttribute = () => {};
  prepared.ctx.document.querySelector = () => homePage;
  prepared.ctx.close();
  prepared.events.length = 0;
  prepared.adapter.resumeRetained = (_value, options) => { assert.equal(options.deferNavigation, true); return true; };
  const preparedGate = deferred();
  prepared.ctx.reloadInlineConversationContext = () => preparedGate.promise;
  prepared.ctx.openRoute('projects');
  assert.equal(prepared.events.length, 0, 'the already prepared native surface attaches without layout searches or markup rendering');
  assert.equal(prepared.root.parentElement, prepared.ctx.panel);
  assert.equal(nativeLayout.inert, true, 'native input stays guarded while context validation is pending');
  assert.equal(status.hidden, true);
  assert.equal(pageFlags.get('data-better-codex-native-preview'), 'true', 'the same real native page is visible before its effects reactivate');
  assert.equal(homeFlags.get('data-better-codex-native-preview-obscured'), 'true', 'the unrelated native Home is never shown under the returning project');
  assert.equal(styles.get('--bc-inline-details-space'), '432px');
  preparedGate.resolve();
  await flush();
  assert.equal(pageFlags.size, 0);
  assert.equal(homeFlags.size, 0);

  for (const [field, value] of [['inlineConversationLoading', true], ['inlineConversationError', 'offline'], ['active', false], ['destroyed', true]]) {
    const blocked = fixture();
    blocked.ctx[field] = value;
    blocked.ctx.cacheProjectSurface();
    assert.equal(blocked.ctx.projectSurfaceCache, null, `${field} cannot be saved as a reusable page`);
  }
  const recovering = fixture();
  recovering.ctx.panel.dataset.recovery = 'true';
  recovering.ctx.cacheProjectSurface();
  assert.equal(recovering.ctx.projectSurfaceCache, null, 'a recovery shell cannot replace a healthy cached page');
  const foreignSurface = fixture();
  foreignSurface.ctx.inlineConversation = null;
  foreignSurface.ctx.state.surface = 'agents';
  foreignSurface.ctx.cacheProjectSurface();
  assert.equal(foreignSurface.ctx.projectSurfaceCache, null, 'unrelated features are excluded from the project cache');
  const removedProject = fixture();
  removedProject.ctx.close();
  removedProject.ctx.state.projects = [{ id: 'p2' }];
  assert.equal(removedProject.ctx.restoreCachedProjectSurface('p1'), false, 'deleted projects cannot resurrect cached UI');

  const dashboard = fixture();
  dashboard.ctx.inlineConversation = null;
  dashboard.ctx.inlineConversationRoot = null;
  dashboard.ctx.state.projectPage = 'work';
  dashboard.ctx.state.projectDocumentView = 'charter';
  dashboard.ctx.close();
  dashboard.ctx.state.projectPage = 'overview';
  dashboard.events.length = 0;
  const backgroundGate = deferred();
  dashboard.ctx.loadSurface = options => { dashboard.events.push({ type: 'load-surface', options }); return backgroundGate.promise; };
  dashboard.ctx.openRoute('projects');
  assert.equal(dashboard.ctx.state.projectPage, 'work');
  assert.deepEqual(dashboard.events.map(event => event.type), ['mount', 'render', 'load-surface'], 'dashboard content mounts and renders synchronously before a pending refresh');
  assert(dashboard.events.slice(0, 2).every(event => event.page === 'work'));
  assert.equal(dashboard.events[2].options.background, true);
  backgroundGate.resolve();
  await flush();

  for (const lateResult of [{ mode: 'thread' }, { error: 'expired_context' }]) {
    const racing = fixture();
    const gate = deferred();
    racing.adapter.restore = () => gate.promise;
    racing.ctx.close();
    racing.ctx.openRoute('projects');
    racing.ctx.close();
    racing.ctx.state.projectDetailId = 'p2';
    racing.ctx.inlineConversation = { target: { project_id: 'p2', kind: 'charter', conversation_id: 'new-current' }, mode: 'thread' };
    racing.ctx.active = true;
    const newConversation = racing.ctx.inlineConversation;
    const priorEvents = racing.events.length;
    gate.resolve(lateResult);
    await flush();
    assert.equal(racing.ctx.inlineConversation, newConversation, 'delayed native restore cannot overwrite a later user navigation');
    assert.equal(racing.ctx.inlineConversationError, '', 'a delayed error cannot appear on the new conversation');
    assert.equal(racing.events.length, priorEvents, 'a delayed restore never remounts or reloads an unrelated surface');
  }

  const failed = fixture();
  failed.adapter.restore = async () => ({ error: 'expired_context' });
  failed.ctx.close(); failed.ctx.openRoute('projects');
  await flush();
  assert.equal(failed.ctx.projectSurfaceCache, null, 'failed native restoration invalidates the stale page cache');
  assert.equal(failed.ctx.inlineConversationLoading, false);
  assert.equal(failed.ctx.inlineConversationError, '无法打开会话');
  assert.equal(failed.destroyedRoots.length, 0, 'a failed reconnect leaves its currently displayed DOM intact');

  const replaced = fixture();
  replaced.ctx.close();
  const nextRoot = { isConnected: true, querySelectorAll: () => [] };
  replaced.ctx.active = true;
  replaced.ctx.state.projectDetailId = 'p2';
  replaced.ctx.inlineConversation = { target: { project_id: 'p2', kind: 'charter' }, mode: 'draft' };
  replaced.ctx.inlineConversationRoot = nextRoot;
  replaced.ctx.cacheProjectSurface();
  assert.equal(replaced.ctx.projectSurfaceCache.projectId, 'p2');
  assert.equal(replaced.ctx.projectSurfaceCache.root, nextRoot);
  assert.deepEqual(replaced.destroyedRoots, [replaced.root], 'replacing the single project cache destroys the old detached DOM component handles');
  replaced.ctx.cacheProjectSurface();
  assert.deepEqual(replaced.destroyedRoots, [replaced.root], 'recaching the currently mounted root preserves its components');
  nextRoot.isConnected = false;
  replaced.ctx.releaseProjectSurfaceCache();
  assert.equal(replaced.ctx.projectSurfaceCache, null);
  assert.deepEqual(replaced.destroyedRoots, [replaced.root], 'even a temporarily detached root stays intact while still owned by the active conversation');

  const released = fixture();
  released.ctx.close();
  released.ctx.releaseProjectSurfaceCache();
  assert.equal(released.ctx.projectSurfaceCache, null);
  assert.deepEqual(released.destroyedRoots, [released.root], 'discarding an unused offline cache releases its DOM components');
  released.ctx.releaseProjectSurfaceCache();
  assert.equal(released.destroyedRoots.length, 1, 'cache disposal is idempotent');

  const validating = fixture();
  const contextGate = deferred();
  validating.ctx.api = () => contextGate.promise;
  for (const name of ['inlineConversationQuery', 'reloadInlineConversationContext']) vm.runInContext(readFunction(name), validating.ctx);
  const pendingContext = validating.ctx.reloadInlineConversationContext({ background: true });
  validating.ctx.close();
  validating.ctx.inlineConversation = { target: { ...validating.target }, mode: 'thread', context: { charter: { revision: 99 } } };
  const newerContext = validating.ctx.inlineConversation;
  contextGate.resolve({ mode: 'thread', target: validating.target, context: { charter: { revision: 1 } } });
  await pendingContext;
  assert.equal(validating.ctx.inlineConversation, newerContext, 'an old context HTTP response cannot overwrite a reopened identical conversation');
  assert.equal(validating.ctx.inlineConversation.context.charter.revision, 99);
  console.log('Project surface cache tests passed: synchronous return, retained DOM/scroll, released native scope, background validation and stale-response isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });

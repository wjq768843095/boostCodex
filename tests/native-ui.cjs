const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function readFunction(name) {
  const match = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `Missing UI function ${name}`);
  const tail = source.slice(match.index + match[0].length);
  const next = new RegExp(`^${match[1]}(?:async )?function [a-zA-Z]`, 'm').exec(tail);
  assert(next, `Missing next function after ${name}`);
  return source.slice(match.index, match.index + match[0].length + next.index);
}
const plain = value => JSON.parse(JSON.stringify(value));
const requests = [], http = [], opened = [], events = [];
const entry = {}, agentsEntry = {}, projectsEntry = {};
const routed = [];
const state = { agentView: 'all', agentSearch: '', agentPane: 'preview', nativePlanningEnabled: true };
const container = { innerHTML: '' };
const context = vm.createContext({
  state, panel: { dataset: {}, querySelector: () => container }, statusLabels: { backlog: '待规划', in_progress: '进行中', done: '已完成' },
  inlineConversation: null, inlineConversationLoading: false, inlineConversationTarget: () => ({}), READ_ONLY: false,
  SELECTORS: { threadRow: '[data-thread-row]' },
  entry, agentsEntry, projectsEntry, moreEntry: null, profileEntry: null, usageEntry: null, themeEntry: null,
  active: false, suppressAgentOutside: false, closeAuxiliaryMenu() {}, openRoute: surface => routed.push(surface),
  t: value => String(value), te: value => String(value),
  escapeHtml2: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  icon: name => `<i data-icon="${name}"></i>`, projectLabel: project => project?.name || '',
  normalizeSessionId: value => String(value || ''),
  relayThreads: new Set(), relayId: 'fixture-relay', relayCurrentThreadId: '', relayCommandInFlight: false,
  relayBufferedEvents: [], sessionStorage: { setItem() {} },
  setInterval: () => 1, clearInterval() {}, heartbeatSessionRelay() {}, flushRelayEvents() {},
  appendDiagnostic() {}, openThread: async threadId => { opened.push(threadId); return { opened: true }; },
  queueRelayEvent: (method, params) => events.push({ method, params: plain(params) }),
  sendAppServerRequest: async (method, params) => {
    requests.push({ method, params: plain(params) });
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn' } };
    return {};
  },
  api: async (url, options) => { http.push({ url, body: JSON.parse(options.body) }); return {}; }
});
for (const name of ['nativeWorkspaceParams', 'nativeExplicitParams', 'resumePersistedThread', 'semanticInput', 'turnStartParams', 'executeSessionCommand', 'nativeUserMessage', 'appServerEnvelope', 'projectDocumentValue', 'documentTextMarkup', 'issuePlanDetailMarkup', 'planItemDetailsMarkup', 'planningStageTabsMarkup', 'projectCharterConfirmationState', 'projectPlanningMarkup', 'skillAvailableForProject', 'skillScopeLabel', 'renderAgents', 'onClick', 'placeRailSequence']) vm.runInContext(readFunction(name), context);
(async () => {
  const rail = { children: [], moves: 0, insertBefore(node, cursor) {
    this.moves++;
    const old = this.children.indexOf(node);
    if (old >= 0) this.children.splice(old, 1);
    const next = cursor ? this.children.indexOf(cursor) : this.children.length;
    this.children.splice(next, 0, node);
  } };
  const railNode = name => ({ name, get parentElement() { return rail.children.includes(this) ? rail : null; }, get nextSibling() { return rail.children[rail.children.indexOf(this) + 1] || null; } });
  const [home, board, skills, projects, back] = ['home', 'board', 'skills', 'projects', 'back'].map(railNode);
  rail.children = [home, board, skills, projects, back];
  context.placeRailSequence([board, skills, projects], rail, null);
  assert.equal(rail.moves, 0, 'stable rail must not move on refresh');
  rail.children = [home, board, projects, skills, back];
  context.placeRailSequence([board, skills, projects], rail, null);
  assert.deepEqual(rail.children.map(item => item.name), ['home', 'board', 'skills', 'projects', 'back']);
  const movesAfterRepair = rail.moves;
  context.placeRailSequence([board, skills, projects], rail, null);
  assert.equal(rail.moves, movesAfterRepair, 'repaired rail must stay stable');
  for (const [target, surface] of [[entry, 'issues'], [agentsEntry, 'agents'], [projectsEntry, 'projects']]) {
    let prevented = 0, stopped = 0;
    context.onClick({ target: { closest: () => target }, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
    assert.equal(routed.pop(), surface); assert.equal(prevented, 1); assert.equal(stopped, 1);
  }
  const injected = { native_defaults: true, workspace_path: 'D:\\workspace', root_paths: ['D:\\workspace', 'E:\\backend'], model: 'profile-model', effort: 'high', approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write', developer_instructions: 'profile instructions' };
  assert.deepEqual(plain(context.nativeExplicitParams(injected)), { cwd: 'D:\\workspace', runtimeWorkspaceRoots: ['D:\\workspace', 'E:\\backend'] });
  assert.deepEqual(plain(context.nativeExplicitParams({})), {});
  assert.deepEqual(plain(context.nativeExplicitParams({ approval_policy: 'never', model: 'explicit' })), { model: 'explicit', approvalPolicy: 'never' });
  await context.resumePersistedThread('fixture-thread', injected);
  assert.deepEqual(requests.pop(), { method: 'thread/resume', params: { threadId: 'fixture-thread', excludeTurns: true, cwd: 'D:\\workspace', runtimeWorkspaceRoots: ['D:\\workspace', 'E:\\backend'] } });
  const turn = plain(context.turnStartParams('fixture-thread', { ...injected, message: 'User request' }));
  assert.deepEqual(turn, { threadId: 'fixture-thread', input: [{ type: 'text', text: 'User request' }], cwd: 'D:\\workspace', runtimeWorkspaceRoots: ['D:\\workspace', 'E:\\backend'] });
  assert.equal(context.turnStartParams('continued-thread', {native_defaults:true,message:'资料写入 __BETTER_CODEX_THREAD_ID__'}).input[0].text, '资料写入 continued-thread');
  await context.executeSessionCommand({ id: 'fixture-command', kind: 'start', scope: 'project', project_id: 'fixture-project', session_kind: 'charter', payload: { ...injected, title: 'Project charter', input: [{ type: 'text', text: 'Visible request for __BETTER_CODEX_THREAD_ID__' }] } });
  assert.equal(http.some(item => item.url.endsWith('/fail')), false);
  assert.deepEqual(requests[0], { method: 'thread/start', params: { cwd: 'D:\\workspace', runtimeWorkspaceRoots: ['D:\\workspace', 'E:\\backend'] } });
  assert.deepEqual(requests.find(item => item.method === 'turn/start').params.input, [{ type: 'text', text: 'Visible request for fixture-thread' }]);
  assert.deepEqual(http.filter(item => item.url.endsWith('/checkpoint')).map(item => item.body.result), [{ thread_id: 'fixture-thread' }, { thread_id: 'fixture-thread', turn_id: 'fixture-turn' }]);
  assert.deepEqual(opened, ['fixture-thread']);
  assert.equal(context.relayThreads.has('fixture-thread'), true);
  const workRequests = requests.length;
  const dynamicTools = [{ name: 'better_codex_project_context_read', description: 'Read task architecture', inputSchema: { type: 'object', properties: {} } }];
  await context.executeSessionCommand({ id: 'fixture-work-command', kind: 'start', scope: 'issue', issue_id: 'fixture-work', payload: { ...injected, dynamic_tools: dynamicTools, message: 'Explicit task instruction' } });
  const explicitWork = requests.slice(workRequests);
  assert.deepEqual(explicitWork[0], { method: 'thread/start', params: { cwd: 'D:\\workspace', runtimeWorkspaceRoots: ['D:\\workspace', 'E:\\backend'], dynamicTools } });
  assert(!Object.hasOwn(explicitWork.find(item => item.method === 'turn/start').params, 'dynamicTools'), 'thread tools must not be sent as turn settings');
  const userMessage = plain(context.nativeUserMessage({ id: 'confirmation-message', type: 'userMessage', content: [{ type: 'text', text: 'Confirm'.repeat(1000) }, { type: 'image', url: 'private' }, { type: 'text', text: 'extra' }] }));
  assert.equal(userMessage.id, 'confirmation-message');
  assert.equal(userMessage.content.length, 1);
  assert.equal(userMessage.content[0].text.length, 4096);
  assert.equal(context.appServerEnvelope({ type: 'mcp-notification', method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'native-confirmation', type: 'userMessage', content: [{ type: 'text', text: '确认当前总纲' }] } } }), true);
  assert.deepEqual(events.pop(), { method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'native-confirmation', type: 'userMessage', content: [{ type: 'text', text: '确认当前总纲' }] } } });
  assert.equal(context.appServerEnvelope({ type: 'mcp-notification', method: 'item/completed', params: { threadId: 'unrelated-thread', item: { type: 'userMessage', content: [{ type: 'text', text: 'Unrelated text' }] } } }), false);
  state.planningContexts = { p: { charter: { revision: 2, status: 'confirmed', sections: [{ id: 'scope', title: '范围', content: 'Scope <content>' }, { id: 'architecture', title: '系统架构', content: 'Architecture details' }] }, plan: { revision: 3, items: [{ id: 'one', title: 'Task one', goal: 'Goal', acceptance: ['Acceptance detail'], directories: ['src'], dependencies: ['two'] }, { id: 'two', title: 'Task two' }], issue_links: [{ item_id: 'two', issue_id: 'issue-two' }], validation: { warnings: [{ code: 'unmapped_requirement', requirement_id: 'REQ-1' }] } } } };
  state.planSelections = { p: ['one'] };
  const markup = context.projectPlanningMarkup({ id: 'p' });
  for (const text of ['Scope &lt;content&gt;', 'Architecture details', 'Acceptance detail', 'data-project-native-session="charter"', 'data-project-native-session="planning"', 'data-plan-convert="p"', '已关联开发任务', '该需求尚未安排任务']) assert(markup.includes(text), text);
  assert(!markup.includes('unmapped_requirement'));
  assert(!markup.includes('<textarea'));
  assert(!markup.includes('data-project-planning-form'));
  assert.match(markup, /data-plan-item="two"[^>]* disabled/);
  state.planningContexts.p.tasks = [{ id: 'issue-two', status: 'in_progress' }];
  const runningMarkup = context.projectPlanningMarkup({ id: 'p' }, { inline: true });
  assert(runningMarkup.includes('开发任务 · 进行中'));
  assert(runningMarkup.includes('data-plan-convert-item="one"'));
  assert(runningMarkup.includes('待转开发'));
  state.planningContexts.p.tasks[0].status = 'done';
  assert(context.projectPlanningMarkup({ id: 'p' }).includes('开发任务 · 已完成'));
  state.skillsManaged = [{ id: 'managed', name: 'Managed skill', instructions: 'Skill body', description: 'Description', version: 1 }];
  state.skillsExternal = [{ id: 'external:one', name: 'External skill', instructions: 'Read only body', path: 'C:\\skills\\one' }];
  context.renderAgents();
  assert(container.innerHTML.indexOf('Managed skill') < container.innerHTML.indexOf('External skill'));
  state.agentPane = 'detail'; state.selectedSkillId = 'external:one'; context.renderAgents();
  assert(container.innerHTML.includes('readonly'));
  assert(!container.innerHTML.includes('data-skill-delete'));
  assert(!container.innerHTML.includes('type="submit"'));
  state.selectedSkillId = 'managed'; context.renderAgents();
  assert(container.innerHTML.includes('data-skill-delete="managed"'));
  assert(container.innerHTML.includes('name="instructions"'));
  for (const field of ['name="model"', 'name="reasoning_effort"', 'name="fast"', 'name="sandbox_mode"', 'name="max_concurrency"']) assert(!container.innerHTML.includes(field), field);
  state.projects = [{ id: 'p1', name: 'Project one' }, { id: 'p2', name: 'Project two' }];
  state.skillsManaged.push({ id: 'project-one', name: 'Project one skill', scope: 'project', project_id: 'p1', source_skill_id: 'managed', source_version: 1, source_update_available: true }, { id: 'project-two', name: 'Project two skill', scope: 'project', project_id: 'p2' });
  assert.equal(context.skillAvailableForProject(state.skillsManaged[0], 'p1'), true);
  assert.equal(context.skillAvailableForProject(state.skillsManaged[1], 'p1'), true);
  assert.equal(context.skillAvailableForProject(state.skillsManaged[1], 'p2'), false);
  assert.equal(context.skillAvailableForProject({ project_id: 'p2' }, 'p1'), false, 'malformed scope cannot leak a project skill');
  state.agentPane = 'preview'; state.skillScopeFilter = 'project:p1'; context.renderAgents();
  assert(container.innerHTML.includes('data-skill-key="project-one"'));
  assert(!container.innerHTML.includes('data-skill-key="project-two"'));
  assert(!container.innerHTML.includes('data-skill-key="managed"'));
  assert(container.innerHTML.includes('来源有更新'));
  state.agentPane = 'detail'; state.selectedSkillId = 'external:one'; context.renderAgents();
  assert(container.innerHTML.includes('data-skill-derive="external:one"'), 'external skills can be copied into a project');
  state.agentPane = 'create'; state.skillDraft = { source_id: 'managed', name: 'Project copy', project_id: 'p1', instructions: 'Original method' }; context.renderAgents();
  assert(container.innerHTML.includes('data-skill-form="derive"'));
  assert(container.innerHTML.includes('name="project_id" required'));
  assert(container.innerHTML.includes('name="instructions" rows="12" readonly'));
  const createCalls = [], nativeDrafts = [], createSubmit = { disabled: false }, createError = { hidden: true };
  let closed = 0;
  const createContext = vm.createContext({
    issue: null, editingLocked: false, submitInFlight: false, retainCreateDraft: true,
    draft: { mode: 'manual', title: 'A development task', description: 'Task requirements', prompt: '', projectId: 'p1', skillId: 'project-one', assignee: 'none', status: 'todo', priority: 'none', labels: '', attachments: [], promptSemanticReferences: [] },
    state: { projects: [{ id: 'p1', workspace_path: 'D:\\workspace' }], issueDescriptionLimit: 10000, mockup: false, locale: 'zh-CN' },
    dialog: { querySelector: selector => selector === '.better-codex-submit' ? createSubmit : selector === '.better-codex-dialog-error' ? createError : null, close: () => closed++ },
    createRequestId: 'fixture-new-task', CREATE_DRAFT_KEY: 'fixture-create-draft', VERSION: 'fixture', RELAY: false, REMOTE: false, globalThis: { crypto: { randomUUID: () => 'fixture-command' } },
    readContext: () => ({}), resolveWorkspacePath: async () => '', uploadPastedImages: async () => {}, withAttachments: text => text,
    traceDialog() {}, writeCreateDraft() {}, sessionStorage: { removeItem() {} }, loadIssues: async () => {},
    api: async (url, options) => { const body = JSON.parse(options.body); createCalls.push({ url, body }); return { ...body, id: 'new-task' }; },
    createIssueNativeConversation: async item => nativeDrafts.push(plain(item)),
    reconcileIssueConflict: async error => { throw error; }, console
  });
  vm.runInContext(readFunction('submitIssue'), createContext);
  await createContext.submitIssue();
  assert.equal(createCalls.length, 1, 'creating task never sends a model request');
  assert.equal(createCalls[0].url, '/api/issues');
  assert.equal(createCalls[0].body.native_only, true);
  assert.equal(createCalls[0].body.ai_enrich, false);
  assert.equal(createCalls[0].body.agent_enabled, false);
  assert.equal(nativeDrafts[0].id, 'new-task');
  assert.equal(closed, 1);
  createContext.inlineConversationNavigationRequest = 0;
  createContext.destroyed = false;
  createContext.t = value => value;
  vm.runInContext(readFunction('createProjectWorkConversation'), createContext);
  let releaseDirectCreate;
  createCalls.length = 0; nativeDrafts.length = 0;
  createContext.api = (url, options) => { createCalls.push({ url, body: JSON.parse(options.body) }); return new Promise(resolve => { releaseDirectCreate = resolve; }); };
  const directCreate = createContext.createProjectWorkConversation('p1');
  const repeatedDirectCreate = createContext.createProjectWorkConversation('p1');
  assert.equal(createCalls.length, 1, 'double clicks cannot register duplicate work placeholders');
  assert.equal(createCalls[0].body.title, '新会话');
  assert.equal(createCalls[0].body.status, 'backlog');
  assert.equal(createCalls[0].body.native_only, true);
  assert.equal(createCalls[0].body.ai_enrich, false);
  releaseDirectCreate({ id: 'direct-task', project_id: 'p1' });
  await Promise.all([directCreate, repeatedDirectCreate]);
  assert.equal(nativeDrafts.length, 1, 'direct creation opens one native draft and never sends its contents');
  nativeDrafts.length = 0;
  const staleDirectCreate = createContext.createProjectWorkConversation('p1');
  createContext.inlineConversationNavigationRequest++;
  releaseDirectCreate({ id: 'background-task', project_id: 'p1' });
  assert.equal((await staleDirectCreate).reason, 'navigation_changed');
  assert.equal(nativeDrafts.length, 0, 'late task creation cannot replace the newly selected conversation');
  let skillSavePromise;
  const skillRequests = [], derivedSubmit = { disabled: false, isConnected: true }, skillError = { hidden: true };
  const derivedForm = { dataset: { skillForm: 'derive' }, elements: { name: { value: 'Project skill copy' }, description: { value: 'For project one' }, instructions: { value: 'Ignored read-only source' }, project_id: { value: 'p1' } }, querySelector: selector => selector === '[type="submit"]' ? derivedSubmit : skillError };
  const skillContext = vm.createContext({
    state: { skillsManaged: [], skillDraft: { source_id: 'external:one' } },
    perform: fn => { skillSavePromise = fn(); }, loadSkills: async () => {}, renderAgents() {}, errorLabel: error => error.message,
    api: async (url, options) => { skillRequests.push({ url, method: options.method, body: JSON.parse(options.body) }); return { skill: { id: 'derived-project-skill' } }; }
  });
  vm.runInContext(readFunction('onSkillSubmit'), skillContext);
  assert.equal(skillContext.onSkillSubmit({ target: { closest: () => derivedForm }, preventDefault() {} }), true);
  await skillSavePromise;
  assert.deepEqual(skillRequests, [{ url: '/api/skills/derive', method: 'POST', body: { source_id: 'external:one', project_id: 'p1', name: 'Project skill copy', description: 'For project one' } }]);
  assert.equal(skillContext.state.selectedSkillId, 'derived-project-skill');
  assert.equal(derivedSubmit.disabled, false);
  assert(!source.includes('/api/remote-access/'));
  assert(!source.includes('data-help-view="remote"'));
  assert(source.includes('function conversationPanel() { return ""; }'));
  assert(source.includes('!dialog.querySelector("[data-conversation-body]")'));
  console.log('PASS: native defaults, project queue checkpoint and routing, bounded confirmation forwarding, charter document, plan selection and Skill management fixtures');
})().catch(error => { console.error(error); process.exitCode = 1; });

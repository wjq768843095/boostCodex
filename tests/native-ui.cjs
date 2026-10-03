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
  state, panel: { dataset: {}, querySelector: () => container },
  SELECTORS: { threadRow: '[data-thread-row]' },
  entry, agentsEntry, projectsEntry, moreEntry: null, profileEntry: null, usageEntry: null, themeEntry: null,
  active: false, suppressAgentOutside: false, closeAuxiliaryMenu() {}, openRoute: surface => routed.push(surface),
  t: value => String(value), te: value => String(value),
  escapeHtml2: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  icon: name => `<i data-icon="${name}"></i>`,
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
for (const name of ['nativeWorkspaceParams', 'nativeExplicitParams', 'resumePersistedThread', 'semanticInput', 'turnStartParams', 'executeSessionCommand', 'nativeUserMessage', 'appServerEnvelope', 'projectDocumentValue', 'documentTextMarkup', 'issuePlanDetailMarkup', 'planItemDetailsMarkup', 'projectPlanningMarkup', 'renderAgents', 'onClick', 'placeRailSequence']) vm.runInContext(readFunction(name), context);
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
  for (const text of ['Scope &lt;content&gt;', 'Architecture details', 'Acceptance detail', 'data-project-native-session="charter"', 'data-project-native-session="planning"', 'data-plan-convert="p"', '已加入待规划', '该需求尚未安排任务']) assert(markup.includes(text), text);
  assert(!markup.includes('unmapped_requirement'));
  assert(!markup.includes('<textarea'));
  assert(!markup.includes('data-project-planning-form'));
  assert.match(markup, /data-plan-item="two"[^>]* disabled/);
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
  assert(!source.includes('/api/remote-access/'));
  assert(!source.includes('data-help-view="remote"'));
  assert(source.includes('function conversationPanel() { return ""; }'));
  assert(source.includes('!dialog.querySelector("[data-conversation-body]")'));
  console.log('PASS: native defaults, project queue checkpoint and routing, bounded confirmation forwarding, charter document, plan selection and Skill management fixtures');
})().catch(error => { console.error(error); process.exitCode = 1; });

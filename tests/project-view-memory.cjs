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
const memory = new Map();
const storageKey = projectId => 'better-codex-project-view:' + projectId;
let target = {}, availableConversations = [], resumes = [];
const state = { projectDetailId: 'p1', projectPage: 'planning', projectDocumentView: 'planning', projectResumePending: '', nativePlanningEnabled: true, projects: [{ id: 'p1' }, { id: 'p2' }], projectIssues: [], issues: [], planningContexts: { p1: { charter: { status: 'confirmed' } } } };
const escapeHtml2 = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const ctx = vm.createContext({
  state, active: true, destroyed: false, inlineConversation: null, inlineConversationNavigationRequest: 0,
  localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) },
  inlineConversationTarget: () => target,
  t: value => value, te: escapeHtml2, escapeHtml2, icon: () => '', appendDiagnostic() {}, render() {},
  loadProjectNativeConversations: async () => plain(availableConversations),
  loadProjectWorkConversations: async () => plain(availableConversations),
  openInlineConversation: async saved => { resumes.push({ method: 'inline', target: plain(saved) }); return { opened: true }; },
  openProjectNativeSession: async (projectId, kind, conversationId) => { resumes.push({ method: 'planning', projectId, kind, conversationId }); return { opened: true }; },
  openIssueNativeConversation: async (issue, conversationId) => { resumes.push({ method: 'work', issue: plain(issue), conversationId }); return { opened: true }; },
  openProjectWorkSession: async projectId => { resumes.push({ method: 'work-project', projectId }); return { opened: true }; },
  loadProjectIssues: async () => {},
  perform: fn => fn()
});
for (const name of ['readProjectView', 'rememberProjectView', 'applyProjectView', 'resumeProjectView', 'planningStageTabsMarkup']) vm.runInContext(readFunction(name), ctx);

function saveView(projectId, page, stage, savedTarget) {
  state.projectDetailId = projectId;
  state.projectPage = page;
  state.projectDocumentView = stage;
  target = savedTarget || {};
  ctx.inlineConversation = savedTarget ? { target: savedTarget } : null;
  ctx.rememberProjectView();
}
function restore(projectId) {
  ctx.inlineConversation = null;
  target = {};
  state.projectDetailId = projectId;
  ctx.applyProjectView(projectId);
}
function tabButton(markup, kind, inline = false) {
  const attribute = inline ? 'data-inline-stage' : 'data-project-native-session';
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes(`${attribute}="${kind}"`));
}

(async () => {
  assert.deepEqual(plain(ctx.readProjectView('p1')), { page: 'overview', stage: 'charter' });
  for (const invalid of ['{broken-json', 'null', '[]', '"text"']) {
    memory.set(storageKey('p1'), invalid);
    assert.deepEqual(plain(ctx.readProjectView('p1')), { page: 'overview', stage: 'charter' }, 'malformed storage never blocks entering a project');
  }
  memory.set(storageKey('p1'), JSON.stringify({ page: 'settings', stage: 'secrets' }));
  assert.deepEqual(plain(ctx.readProjectView('p1')), { page: 'overview', stage: 'charter' });

  saveView('p1', 'planning', 'planning', { project_id: 'p1', kind: 'planning', conversation_id: 'plan-one', markdown: 'Private conversation body', api_key: 'secret-token', context: { document: 'Sensitive project document' } });
  saveView('p2', 'work', 'charter');
  assert.equal(ctx.readProjectView('p1').page, 'planning');
  assert.equal(ctx.readProjectView('p1').stage, 'planning');
  assert.deepEqual(plain(ctx.readProjectView('p1').target), { project_id: 'p1', kind: 'planning', conversation_id: 'plan-one' });
  assert.equal(ctx.readProjectView('p2').page, 'work');
  assert.equal(ctx.readProjectView('p2').stage, 'charter');
  assert(!memory.get(storageKey('p1')).includes('Private conversation body'));
  assert(!memory.get(storageKey('p1')).includes('secret-token'));
  assert(!memory.get(storageKey('p1')).includes('Sensitive project document'), 'view memory contains identifiers only, without copied project/chat content');
  saveView('p1', 'planning', 'charter', { project_id: 'p1', kind: 'charter', conversation_id: 'charter-one' });
  assert.deepEqual(plain(ctx.readProjectView('p1').conversations), { planning: 'plan-one', charter: 'charter-one' }, 'switching stages remembers the last conversation within both tabs');
  saveView('p1', 'planning', 'planning', { project_id: 'p1', kind: 'planning', conversation_id: 'plan-one' });
  restore('p1');
  assert.equal(state.projectPage, 'planning');
  assert.equal(state.projectDocumentView, 'planning');
  assert.equal(state.projectResumePending, 'p1');
  restore('p2');
  assert.equal(state.projectPage, 'work', 'a different project keeps its own last page');
  assert.equal(state.projectDocumentView, 'charter');
  restore('p1');
  assert.equal(state.projectPage, 'planning', 'returning to the first project does not inherit the second project page');
  saveView('p2', 'overview', 'charter', { project_id: 'p1', kind: 'planning', conversation_id: 'plan-one' });
  assert(!ctx.readProjectView('p2').target, 'a previous project conversation is never saved under the next project');

  const restarted = vm.createContext({ localStorage: ctx.localStorage });
  vm.runInContext(readFunction('readProjectView'), restarted);
  assert.deepEqual(plain(restarted.readProjectView('p1')), plain(ctx.readProjectView('p1')), 'a fresh UI instance can restore the saved project view');
  memory.set(storageKey('p2'), JSON.stringify({ page: 'planning', stage: 'charter', target: { project_id: 'p1', kind: 'charter', conversation_id: 'foreign' } }));
  assert(!ctx.readProjectView('p2').target, 'storage cannot inject a target from another project');
  memory.set(storageKey('p2'), JSON.stringify({ page: 'work', stage: 'charter', target: { project_id: 'p2', kind: 'work', conversation_id: 'missing-task' } }));
  assert(!ctx.readProjectView('p2').target, 'work targets require the task identifier');
  memory.set(storageKey('p2'), JSON.stringify({ page: 'planning', stage: 'planning', target: { project_id: 'p2', kind: 'charter', conversation_id: 'wrong-stage' } }));
  assert(!ctx.readProjectView('p2').target, 'a target with a different stage cannot override the selected tab');

  const tabs = ctx.planningStageTabsMarkup('p1', 'charter', false);
  assert.match(tabs, /role="tablist"/);
  assert.equal((tabs.match(/role="tab"/g) || []).length, 2);
  assert.match(tabButton(tabs, 'charter'), /aria-selected="true"/);
  assert.match(tabButton(tabs, 'charter'), /总纲会话/);
  assert.match(tabButton(tabs, 'planning'), /aria-selected="false"/);
  assert.match(tabButton(tabs, 'planning'), /\bdisabled(?:\s|[=>])/);
  assert.match(tabButton(tabs, 'planning'), /任务规划会话/);
  const inlineTabs = ctx.planningStageTabsMarkup('p1', 'planning', true, true);
  assert.match(tabButton(inlineTabs, 'planning', true), /aria-selected="true"/);
  assert.doesNotMatch(tabButton(inlineTabs, 'planning', true), /\bdisabled(?:\s|[=>])/);
  assert.match(tabButton(inlineTabs, 'charter', true), /aria-selected="false"/);

  availableConversations = [{ project_id: 'p1', kind: 'planning', conversation_id: 'plan-one' }];
  restore('p1');
  ctx.active = false;
  await ctx.resumeProjectView('p1');
  assert.equal(resumes.length, 0, 'background polling does not reopen a hidden project');
  ctx.active = true;
  await ctx.resumeProjectView('p2');
  assert.equal(resumes.length, 0, 'a stale project callback cannot resume a different project');
  await ctx.resumeProjectView('p1');
  assert.equal(resumes.length, 1);
  const firstResume = resumes[0];
  assert(firstResume.target?.conversation_id === 'plan-one' || firstResume.conversationId === 'plan-one', 'reopening restores the exact saved planning conversation');
  await ctx.resumeProjectView('p1');
  await ctx.resumeProjectView('p1');
  assert.equal(resumes.length, 1, 'refreshes consume resume once and cannot repeatedly navigate');
  restore('p1');
  ctx.inlineConversation = { target: { project_id: 'p1', kind: 'charter' } };
  await ctx.resumeProjectView('p1');
  assert.equal(resumes.length, 1, 'current inline navigation takes precedence over a saved view');
  ctx.inlineConversation = null;

  availableConversations = [];
  restore('p1');
  await ctx.resumeProjectView('p1');
  assert.equal(resumes.length, 2);
  assert.equal(resumes.at(-1).method, 'planning');
  assert.equal(resumes.at(-1).projectId, 'p1');
  assert.equal(resumes.at(-1).kind, 'planning');
  assert(!resumes.at(-1).conversationId, 'a deleted conversation falls back to its stage, never a stale identifier');
  saveView('p2', 'overview', 'charter');
  restore('p2');
  await ctx.resumeProjectView('p2');
  assert.equal(resumes.length, 2, 'overview stays on the overview page without opening a conversation');

  saveView('p2', 'planning', 'planning');
  restore('p2');
  await ctx.resumeProjectView('p2');
  assert.equal(resumes.at(-1).kind, 'charter', 'a removed or unconfirmed charter retains the planning confirmation gate');

  const historical = { project_id: 'p2', kind: 'work', issue_id: 'task-two', conversation_id: 'work-two', history_id: 'history-two', markdown: 'Private history body' };
  saveView('p2', 'work', 'charter', historical);
  assert.deepEqual(plain(ctx.readProjectView('p2').target), { project_id: 'p2', kind: 'work', issue_id: 'task-two', conversation_id: 'work-two', history_id: 'history-two' });
  availableConversations = [{ project_id: 'p2', kind: 'work', issue_id: 'task-two', conversation_id: 'work-two', history_id: 'history-two' }];
  restore('p2');
  await ctx.resumeProjectView('p2');
  assert.deepEqual(resumes.at(-1).target, plain(ctx.readProjectView('p2').target), 'work history restores its exact task, conversation and history scope');

  const beforeRace = resumes.length;
  restore('p1');
  let resolveList;
  const loadConversations = ctx.loadProjectNativeConversations;
  ctx.loadProjectNativeConversations = () => new Promise(resolve => { resolveList = resolve; });
  const pendingResume = ctx.resumeProjectView('p1');
  await ctx.resumeProjectView('p1');
  assert.equal(resumes.length, beforeRace, 'simultaneous refresh cannot start a second pending resume');
  ctx.inlineConversationNavigationRequest++;
  resolveList([{ project_id: 'p1', kind: 'planning', conversation_id: 'plan-one' }]);
  await pendingResume;
  assert.equal(resumes.length, beforeRace, 'a later user navigation wins against the saved conversation lookup');
  ctx.loadProjectNativeConversations = loadConversations;

  restore('p1');
  ctx.loadProjectNativeConversations = () => new Promise(resolve => { resolveList = resolve; });
  const leavingResume = ctx.resumeProjectView('p1');
  state.projectDetailId = 'p2';
  resolveList([{ project_id: 'p1', kind: 'planning', conversation_id: 'plan-one' }]);
  await leavingResume;
  assert.equal(resumes.length, beforeRace, 'leaving the project before lookup completes cannot reopen it');
  ctx.loadProjectNativeConversations = loadConversations;

  ctx.localStorage = { getItem() { throw new Error('storage unavailable'); }, setItem() { throw new Error('storage unavailable'); } };
  assert.deepEqual(plain(ctx.readProjectView('p1')), { page: 'overview', stage: 'charter' });
  assert.doesNotThrow(() => ctx.rememberProjectView(), 'storage failures must not break navigation');
  console.log('Project view memory tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

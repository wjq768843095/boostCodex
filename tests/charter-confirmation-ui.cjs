const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function readFunction(name) {
  const match = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `Missing ${name}`);
  const tail = source.slice(match.index + match[0].length);
  const next = new RegExp(`^${match[1]}(?:async )?function [a-zA-Z]`, 'm').exec(tail);
  assert(next);
  return source.slice(match.index, match.index + match[0].length + next.index);
}
const requests = [], refreshes = [];
let rejectPost = false, releasePost;
const ctx = vm.createContext({
  state: { nativePlanningEnabled: true, projects: [{ id: 'p' }], planningContexts: { p: { charter: { revision: 3, status: 'draft', sections: [{ title: '范围', content: 'Current charter' }] }, sessions: { charter: { thread_id: 'charter-thread', status: 'idle' } } } } },
  inlineConversation: { target: { project_id: 'p', kind: 'charter' }, thread_id: 'charter-thread', binding: { status: 'idle' }, read_only: false }, inlineConversationLoading: false, READ_ONLY: false,
  renderProjects() {}, renderInlineConversation() {},
  api: async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    if (rejectPost) throw new Error('charter_revision_conflict');
    if (releasePost) await new Promise(resolve => { releasePost = resolve; });
  },
  loadPlanningContext: async projectId => { refreshes.push(['context', projectId]); ctx.state.planningContexts[projectId].charter.status = 'confirmed'; ctx.state.planningContexts[projectId].charter.revision = 4; },
  reloadInlineConversationContext: async () => { refreshes.push(['inline']); ctx.inlineConversation.planning_available = true; },
  errorLabel: error => error.message,
  t: value => String(value), te: value => String(value), icon: name => `<i>${name}</i>`,
  escapeHtml2: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  statusLabels: {},
});
for (const name of ['inlineConversationTarget', 'projectDocumentValue', 'documentTextMarkup', 'issuePlanDetailMarkup', 'planItemDetailsMarkup', 'planningStageTabsMarkup', 'projectCharterConfirmationState', 'confirmProjectCharter', 'projectPlanningMarkup', 'onProjectsClick']) vm.runInContext(readFunction(name), ctx);
const button = (revision = '3', inline = true) => ({ dataset: { projectCharterConfirm: 'p', charterRevision: revision, charterThread: 'charter-thread' }, disabled: false, closest: selector => inline && selector === '.better-codex-inline-details' ? {} : null });
const confirmationButtonMarkup = (inline = true) => ctx.projectPlanningMarkup({ id: 'p' }, { inline }).match(/<button[^>]*data-project-charter-confirm[^>]*>[^<]*<\/button>/)[0];
(async () => {
  assert.match(confirmationButtonMarkup(), /data-charter-revision="3"/);
  assert(!confirmationButtonMarkup().includes(' disabled'));
  assert.match(confirmationButtonMarkup(false), /确认总纲/);
  ctx.READ_ONLY = true;
  assert.match(confirmationButtonMarkup(false), / disabled/);
  await ctx.confirmProjectCharter(button()); assert.equal(requests.length, 0);
  ctx.READ_ONLY = false;
  for (const field of ['read_only', 'history']) {
    if (field === 'history') ctx.inlineConversation.target.history_id = 'history'; else ctx.inlineConversation.read_only = true;
    assert.match(confirmationButtonMarkup(), / disabled/);
    await ctx.confirmProjectCharter(button());
    assert.equal(requests.length, 0, 'historical and read-only details cannot confirm');
    delete ctx.inlineConversation.target.history_id; ctx.inlineConversation.read_only = false;
  }
  ctx.state.planningContexts.p.sessions.charter.status = 'running';
  assert.match(confirmationButtonMarkup(), / disabled/);
  await ctx.confirmProjectCharter(button()); assert.equal(requests.length, 0);
  ctx.state.planningContexts.p.sessions.charter.status = 'idle';
  ctx.state.planningContexts.p.charter = {};
  assert.match(confirmationButtonMarkup(), / disabled/);
  ctx.state.planningContexts.p.charter = { revision: 3, status: 'draft', markdown: 'Current charter' };

  releasePost = true;
  const pending = ctx.confirmProjectCharter(button());
  assert.match(confirmationButtonMarkup(), /aria-busy="true"/);
  await ctx.confirmProjectCharter(button()); assert.equal(requests.length, 1, 'a second click cannot create a second request');
  releasePost(); releasePost = null;
  await pending;
  assert.deepEqual(requests[0], { url: '/api/projects/p/charter-confirm', method: 'POST', body: { expected_revision: 3, thread_id: 'charter-thread' } });
  assert.deepEqual(refreshes, [['context', 'p'], ['inline']]);
  assert.equal(ctx.inlineConversation.planning_available, true);
  assert.match(confirmationButtonMarkup(), / disabled[^>]*>已确认/);
  await ctx.confirmProjectCharter(button()); assert.equal(requests.length, 1, 'confirmed charter cannot be submitted again');

  // A stale rendered button must send the displayed version and fail visibly,
  // never silently confirm a newer draft that the user has not reviewed.
  ctx.state.planningContexts.p.charter = { revision: 5, status: 'draft', markdown: 'New content' };
  rejectPost = true;
  const stale = button('3');
  await assert.rejects(ctx.confirmProjectCharter(stale), /charter_revision_conflict/);
  assert.equal(requests.at(-1).body.expected_revision, 3);
  assert.equal(ctx.state.planningContexts.p.charter.status, 'draft');
  assert.match(ctx.projectPlanningMarkup({ id: 'p' }, { inline: true }), /role="alert">charter_revision_conflict/);
  assert.equal(ctx.state.charterConfirmationPending, null);
  assert(!confirmationButtonMarkup().includes(' disabled'), 'failure leaves retry available');

  let dispatched;
  ctx.perform = action => { dispatched = action(); return dispatched; };
  const eventButton = button('5');
  ctx.onProjectsClick({ target: { closest: selector => selector === '[data-project-charter-confirm]' ? eventButton : null } });
  await assert.rejects(dispatched, /charter_revision_conflict/);
  assert.equal(requests.at(-1).body.expected_revision, 5, 'shared project handler dispatches the same direct confirmation');
  console.log('charter confirmation UI passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

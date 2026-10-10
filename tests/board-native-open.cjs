const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
const start = source.indexOf('    function onBoardClick(event) {');
const end = source.indexOf('    function sessionThreadTitle(', start);
assert(start >= 0 && end > start);
const calls = [];
const issues = ['todo', 'in_progress', 'in_review', 'done', 'blocked'].map(status => ({ id: status, project_id: 'project', status }));
issues.push({ id: 'pending', enrichmentPending: true }, { id: 'remote', remotePending: true });
const context = vm.createContext({
  Date, suppressIssueClickUntil: 0, state: { issues, projectDetailId: 'project' },
  issuePermissions: issue => issue || {},
  perform: action => action(),
  openIssueNativeConversation: issue => calls.push(['native', issue.id, issue.project_id]),
  openEditor: () => { throw new Error('Task clicks must not open the editor'); },
  openThread: id => calls.push(['thread', id]),
  openArchiveDialog: id => calls.push(['archive', id]),
  createProjectWorkConversation: (id, status) => calls.push(['create', id, status]),
  withLatestIssueOnConflict: async () => {}, loadIssues: async () => {}
});
vm.runInContext(source.slice(start, end), context);
function click(matches) {
  context.onBoardClick({ target: { closest: selector => matches[selector] || null }, preventDefault() {}, stopPropagation() {} });
}
for (const issue of issues) click({ '[data-issue-id]': { dataset: { issueId: issue.id } } });
assert.deepEqual(calls, issues.slice(0, 5).map(issue => ['native', issue.id, 'project']));
calls.length = 0;
click({ '[data-thread]': { dataset: { thread: 'existing' } }, '[data-issue-id]': { dataset: { issueId: 'todo' } } });
assert.deepEqual(calls, [['thread', 'existing']], 'thread control must not also activate the task');
calls.length = 0;
click({ '[data-add-status]': { dataset: { addStatus: 'todo' } }, '[data-project-board]': {} });
assert.deepEqual(calls, [['create', 'project', 'todo']]);
calls.length = 0;
context.suppressIssueClickUntil = Date.now() + 10000;
click({ '[data-issue-id]': { dataset: { issueId: 'todo' } } });
assert.deepEqual(calls, [], 'drag completion must not accidentally open a conversation');
console.log('PASS: task cards directly open native conversations across task states, preserve nested controls and pending/drag guards');

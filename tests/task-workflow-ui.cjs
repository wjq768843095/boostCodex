'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function extract(name) {
  const start = new RegExp('^    (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert(start, name);
  const tail = source.slice(start.index + start[0].length);
  const end = /^    (?:async )?function /m.exec(tail);
  assert(end, name + ' next function');
  return source.slice(start.index, start.index + start[0].length + end.index);
}
const requests = [], context = vm.createContext({
  te: value => value,
  escapeHtml2: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  inlineConversation: null,
  inlineConversationTarget: () => ({ kind: 'work', issue_id: 'task-1' }),
  inlineConversationKey: value => value.key,
  confirmAction: async () => true,
  api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); },
  loadIssues: async () => {}, reloadInlineConversationContext: async () => {}
});
vm.runInContext(['workflowActivityState', 'inlineTaskAcceptanceMarkup', 'confirmInlineTaskAcceptance'].map(extract).join('\n'), context);
const task = { id: 'task-1', status: 'in_review', version: 9,
  workflow: { result: 'review_passed', pending_manual: ['检查操作结果', '<script>不可执行</script>'] } };
assert(context.inlineTaskAcceptanceMarkup(task).includes('data-inline-accept-task'));
assert(context.inlineTaskAcceptanceMarkup(task).includes('&lt;script&gt;'));
assert(!context.inlineTaskAcceptanceMarkup(task, true).includes('data-inline-accept-task'));
assert(context.inlineTaskAcceptanceMarkup({ ...task, session_active_turn_id: 'turn-1' }).includes(' disabled'));
assert.equal(context.inlineTaskAcceptanceMarkup({ ...task, workflow: { result: 'development_complete', pending_manual: ['检查'] } }), '');
assert.equal(context.inlineTaskAcceptanceMarkup({ ...task, status: 'done' }), '');
assert.equal(context.workflowActivityState({ status: 'todo', workflow: {} }, 'completed'), 'not-started');
assert.equal(context.workflowActivityState({ status: 'in_progress', workflow: {} }, 'completed'), 'in_progress');
assert.equal(context.workflowActivityState({ status: 'in_review', workflow: {} }, 'completed'), 'in_review');
assert.equal(context.workflowActivityState({ status: 'done', workflow: {} }, 'not-started'), 'completed');
assert.equal(context.workflowActivityState({ status: 'todo' }, 'completed'), 'completed');
(async () => {
  const button = { disabled: false, isConnected: true };
  context.inlineConversation = { key: 'work:1', context: { task } };
  await context.confirmInlineTaskAcceptance(button);
  assert.deepEqual(requests[0], { url: '/api/issues/task-1/workflow', body: { expected_version: 9, action: 'accept' } });
  assert.equal(button.disabled, false);
  requests.length = 0;
  context.inlineConversation.read_only = true;
  await context.confirmInlineTaskAcceptance(button);
  assert.equal(requests.length, 0);
  context.inlineConversation.read_only = false;
  context.confirmAction = async () => false;
  await context.confirmInlineTaskAcceptance(button);
  assert.equal(requests.length, 0);
  context.confirmAction = async () => { context.inlineConversation = { key: 'work:other' }; return true; };
  await context.confirmInlineTaskAcceptance(button);
  assert.equal(requests.length, 0, 'switching task while confirming must not mutate the previous task');
  assert.equal(button.disabled, false);
  console.log('PASS: task phase labels, safe acceptance display, active/history restrictions and versioned human acceptance');
})().catch(error => { console.error(error); process.exitCode = 1; });

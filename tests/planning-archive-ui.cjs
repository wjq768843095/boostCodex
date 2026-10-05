'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function readFunction(name) {
  const match = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match);
  const tail = source.slice(match.index + match[0].length);
  const next = new RegExp(`^${match[1]}(?:async )?function [a-zA-Z]`, 'm').exec(tail);
  assert(next);
  return source.slice(match.index, match.index + match[0].length + next.index);
}
const first = { conversation_id: 'one', project_id: 'p', kind: 'charter', title: '总纲会话 1', thread_id: 'native-one', revision: 2 };
const second = { ...first, conversation_id: 'two', thread_id: 'native-two', title: '总纲会话 2' };
let rows, current, requests, opened, rendered, fail, navigate, saved;
const ctx = vm.createContext({
  state: {}, inlineConversation: {}, inlineConversationNavigationRequest: 1, destroyed: false,
  inlineConversationKey: () => current.conversation_id || 'blank', inlineConversationTarget: () => current,
  readProjectView: () => ({ conversations: { charter: 'one' }, target: { conversation_id: 'one' } }),
  localStorage: { setItem: (key, value) => saved = JSON.parse(value) },
  api: async (url, options) => { requests.push({ url, ...JSON.parse(options.body) }); if (fail) throw Error('offline'); if (navigate) current = { project_id: 'other', conversation_id: 'other' }; },
  loadProjectNativeConversations: async () => { ctx.state.nativeConversations.p = rows; return rows; },
  registerInlineConversationBindings() {}, renderInlineConversation: () => rendered++,
  openProjectNativeSession: async (...args) => opened.push(args), openInlineConversation: async value => opened.push(value),
  te: value => value, t: value => value, escapeHtml2: value => String(value).replaceAll('"', '&quot;'), icon: name => `<i>${name}</i>`
});
for (const name of ['archiveProjectNativeConversation', 'planningConversationListMarkup']) vm.runInContext(readFunction(name), ctx);
function reset() {
  rows = [second]; current = { project_id: 'p', kind: 'charter', conversation_id: 'one' };
  requests = []; opened = []; rendered = 0; fail = false; navigate = false; saved = null;
  ctx.state.nativeConversations = { p: [first, second] }; ctx.state.nativeThreadLinks = { 'native-one': first, 'native-two': second };
  ctx.inlineConversation = { planning_available: true };
}
(async () => {
  reset();
  const markup = ctx.planningConversationListMarkup();
  assert.equal((markup.match(/data-planning-archive=/g) || []).length, 2);
  assert(!/<button[^>]*data-planning-conversation[^>]*>[\s\S]*?<button/.test(markup.split('</button>')[0]), 'archive is a sibling button');
  await ctx.archiveProjectNativeConversation('p', 'one');
  assert.equal(requests[0].expected_revision, 2);
  assert.equal(requests[0].url, '/api/native-conversations/archive');
  assert.deepEqual(opened[0], ['p', 'charter', 'two']);
  assert(!ctx.state.nativeThreadLinks['native-one']);
  assert(ctx.state.nativeThreadLinks['native-two']);
  assert(!saved.target); assert(!saved.conversations.charter);
  reset(); current.conversation_id = 'two';
  await ctx.archiveProjectNativeConversation('p', 'one');
  assert.equal(opened.length, 0); assert.equal(rendered, 1, 'archiving another row preserves current chat');
  reset(); rows = [];
  await ctx.archiveProjectNativeConversation('p', 'one');
  assert.equal(opened[0].project_id, 'p'); assert.equal(opened[0].kind, 'charter'); assert(!opened[0].conversation_id);
  reset(); fail = true;
  await assert.rejects(ctx.archiveProjectNativeConversation('p', 'one'), /offline/);
  assert.equal(opened.length, 0); assert(ctx.state.nativeThreadLinks['native-one']); assert.equal(saved, null);
  reset(); navigate = true;
  await ctx.archiveProjectNativeConversation('p', 'one');
  assert.equal(opened.length, 0, 'late archive response must not navigate back to prior project');
  console.log('Planning archive UI: buttons, fallback, background removal, failure and navigation checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

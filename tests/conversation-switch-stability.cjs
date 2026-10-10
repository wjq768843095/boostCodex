const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
function extract(name) {
  const start = source.indexOf('    function ' + name + '(');
  assert(start >= 0, name);
  const end = source.indexOf('    function ', start + 14);
  return source.slice(start, end);
}
let replacements = 0, mounts = 0;
const row = id => ({ dataset: { workConversation: 'task', workConversationId: id }, attrs: {}, selected: false,
  classList: { toggle(name, selected) { this.owner.selected = selected; } },
  getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; } });
const rows = ['one', 'two'].map(row); rows.forEach(row => row.classList.owner = row);
const list = { scrollTop: 480 };
const container = { classList: { contains: () => false }, querySelector: () => list, querySelectorAll: () => rows,
  set innerHTML(value) { replacements++; list.scrollTop = 0; this.markup = value; } };
const markup = selected => rows.map(row => '<button class="bc-planning-conversation-row' + (row.dataset.workConversationId === selected ? ' is-active' : '') + '" data-work-conversation-id="' + row.dataset.workConversationId + '" aria-current="' + String(row.dataset.workConversationId === selected) + '">Title</button>').join('');
const ctx = vm.createContext({ active: true, inlineConversation: {}, mountPanel: () => mounts++ });
vm.runInContext(extract('updateInlineConversationNavigation'), ctx);
vm.runInContext(extract('syncInlineConversationRouteMount'), ctx);
ctx.updateInlineConversationNavigation(container, markup('one'), { issue_id: 'task', conversation_id: 'one' });
assert.equal(list.scrollTop, 480);
const originalList = list, originalRows = [...rows];
ctx.updateInlineConversationNavigation(container, markup('two'), { issue_id: 'task', conversation_id: 'two' });
assert.equal(replacements, 1, 'selection changes preserve list DOM instead of replacing all rows');
assert.equal(rows[0].selected, false); assert.equal(rows[1].selected, true);
assert.equal(rows[1].attrs['aria-current'], 'true');
assert.equal(container.querySelector(), originalList); assert.deepEqual(rows, originalRows);
assert.equal(list.scrollTop, 480);
ctx.updateInlineConversationNavigation(container, markup('two').replaceAll('Title', 'Updated'), { issue_id: 'task', conversation_id: 'two' });
assert.equal(replacements, 2, 'changed task data still refreshes'); assert.equal(list.scrollTop, 480);
ctx.syncInlineConversationRouteMount([{ type: 'attributes', attributeName: 'data-app-shell-active-page' }]);
assert.equal(mounts, 1, 'native retained-page activation mounts synchronously before paint');
ctx.syncInlineConversationRouteMount([{ type: 'attributes', attributeName: 'aria-current' }]);
assert.equal(mounts, 1, 'ordinary selection mutations do not repeat mount work');
ctx.active = false;
ctx.syncInlineConversationRouteMount([{ type: 'attributes', attributeName: 'data-app-shell-active-page' }]);
assert.equal(mounts, 1, 'native homepage remains outside the managed workspace');
console.log('PASS: stable conversation-list DOM/selection/scroll, data refresh and pre-paint native-page remount without homepage takeover');

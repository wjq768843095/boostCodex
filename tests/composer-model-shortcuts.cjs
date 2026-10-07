const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
const start = source.indexOf('  function createComposerModelShortcuts(');
const end = source.indexOf('\n  function install(config)', start);
assert.ok(start >= 0 && end > start, 'the composer shortcut factory is present');
const factory = source.slice(start, end);
const preferenceKey = 'better-codex-composer-model-shortcuts-v1';

// A small DOM fixture exercises user actions and native callback routing without
// starting a renderer, changing the real profile, or making model requests.
class Element {
  constructor(tag, owner) {
    this.tagName = tag;
    this.owner = owner;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.rect = { width: 600, left: 0, right: 600, top: 0, bottom: 300 };
  }
  get isConnected() { return !!this.root || !!this.parentElement?.isConnected; }
  get value() { return this.assignedValue ?? (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  set value(value) { this.assignedValue = value; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  insertBefore(node, reference) { node.remove(); node.parentElement = this; const index = this.children.indexOf(reference); if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, action) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(action); }
  dispatch(name, extras = {}) { for (const action of this.listeners.get(name) || []) action({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extras }); }
  matches(selector) {
    return selector.split(',').some(part => {
      const item = part.trim();
      if (item.startsWith('.')) return this.className.split(' ').includes(item.slice(1));
      const attribute = item.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attribute) return attribute[2] === undefined ? attribute[1] in this.attributes : this.attributes[attribute[1]] === attribute[2];
      return this.tagName === item;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return this.rect; }
  focus() { this.owner.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function fixture({ tier = 'standard', saved, alternateCurrent = false } = {}) {
  const document = { activeElement: null };
  document.head = new Element('head', document);
  document.body = new Element('body', document);
  document.head.root = document.body.root = true;
  document.createElement = tag => new Element(tag, document);
  document.querySelectorAll = selector => [...document.head.querySelectorAll(selector), ...document.body.querySelectorAll(selector)];
  const surface = document.createElement('div');
  surface.setAttribute('data-composer-surface-variant', 'regular');
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  const left = document.createElement('div');
  const addWrapper = document.createElement('div');
  const add = document.createElement('button');
  add.setAttribute('data-composer-navigation-target', 'add-context');
  addWrapper.append(add);
  left.append(addWrapper);
  const trigger = document.createElement('button');
  trigger.setAttribute('data-codex-intelligence-trigger', 'true');
  surface.append(editor, left, trigger);
  document.body.append(surface);
  const models = [{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high', 'ultra'].map(reasoningEffort => ({ reasoningEffort })) }];
  const calls = [], tierWrites = [];
  models[0].serviceTiers = [{ id: 'priority', name: 'Fast' }];
  let nativeTier = tier;
  const props = {
    models, model: 'gpt-6.1-sol', reasoningEffort: 'high',
    selectedServiceTier: tier === 'priority' ? 'priority' : null,
    serviceTierOptions: [{ value: null }, { value: 'priority' }],
    onSelectModel(model, effort) { calls.push(['model', model, effort]); props.model = model; props.reasoningEffort = effort; },
    onSelectModelOption() { calls.push(['model-option']); },
    onSelectServiceTier(value) { tierWrites.push(value); nativeTier = value; props.selectedServiceTier = value; }
  };
  Object.defineProperty(props, 'serviceTier', { enumerable: true, get: () => nativeTier, set: value => { tierWrites.push(value); nativeTier = value; } });
  const root = { stateNode: {} }, currentRoot = { stateNode: root.stateNode };
  root.stateNode.current = alternateCurrent ? currentRoot : root;
  const staleProps = { ...props, onSelectModel() { throw new Error('stale React branch selected'); } };
  const parent = { memoizedProps: alternateCurrent ? staleProps : props, return: root };
  const alternate = { memoizedProps: props, return: currentRoot };
  trigger.__reactFiber$fixture = { memoizedProps: {}, return: parent, alternate: { memoizedProps: {}, return: alternate } };
  const preferences = new Map(saved === undefined ? [] : [[preferenceKey, JSON.stringify(saved)]]);
  const localStorage = { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
  const listeners = new Map(), intervals = new Map();
  const window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); } };
  const context = vm.createContext({ document, window, localStorage, setInterval: fn => { intervals.set(1, fn); return 1; }, clearInterval: id => intervals.delete(id) });
  const controller = vm.runInContext(factory + '\ncreateComposerModelShortcuts()', context);
  return { document, controller, props, calls, tierWrites, preferences, listeners, intervals, editor, trigger, surface, left,
    items: () => left.querySelector('.bc-composer-shortcut-list').children,
    configure: () => left.querySelector('[aria-label="配置模型快捷选项"]').dispatch('click') };
}

for (const tier of ['standard', 'priority']) {
  const f = fixture({ tier });
  f.items()[0].dispatch('click');
  assert.deepEqual(f.calls, [['model-option'], ['model', 'gpt-6.1-sol', 'medium']]);
  assert.equal(f.items()[0].getAttribute('aria-pressed'), 'true');
  f.items()[1].dispatch('click');
  assert.deepEqual(f.calls.slice(-2), [['model-option'], ['model', 'gpt-6.1-sol', 'ultra']]);
  assert.equal(f.props.serviceTier, tier, 'model and effort changes preserve the lightning setting');
  assert.deepEqual(f.tierWrites, [], 'shortcuts never call or assign the service tier');
  f.controller.destroy();
}

const ordering = fixture();
const dataTransfer = { setData(type, value) { this.type = type; this.value = value; } };
const first = ordering.items()[0], second = ordering.items()[1];
first.dispatch('dragstart', { dataTransfer });
ordering.props.reasoningEffort = 'medium';
ordering.controller.sync();
assert.equal(ordering.items()[0], first, 'native updates cannot replace controls during drag');
second.dispatch('dragover', { clientX: 500, dataTransfer });
assert.equal(second.getAttribute('data-bc-drop'), 'after');
second.dispatch('drop', { clientX: 500, dataTransfer });
assert.equal(ordering.items()[0].textContent, '6.1 Sol · Ultra');
assert.equal(JSON.parse(ordering.preferences.get(preferenceKey))[0].effort, 'ultra', 'drag order is saved');
ordering.items()[0].dispatch('click');
assert.deepEqual(ordering.calls, [], 'drop does not accidentally select a model');
assert.deepEqual(ordering.tierWrites, [], 'reordering never changes speed');
ordering.items()[1].dispatch('dragstart', { dataTransfer });
ordering.items()[0].dispatch('drop', { clientX: 0, dataTransfer });
assert.equal(ordering.items()[0].textContent, '6.1 Sol · 中等', 'backward dragging restores order');
ordering.items()[0].dispatch('dragstart', { dataTransfer });
ordering.items()[0].dispatch('dragend');
assert.equal(ordering.items()[0].getAttribute('data-bc-dragging'), null, 'cancelled drag clears styling');
ordering.controller.destroy();

const speed = fixture();
const lightning = () => speed.left.querySelector('.bc-composer-fast');
assert.equal(speed.left.children[1].className, 'bc-composer-shortcuts', 'lightning group sits immediately after the add button');
assert.equal(lightning().getAttribute('aria-pressed'), 'false');
lightning().dispatch('click');
assert.deepEqual(speed.tierWrites, ['priority']);
assert.equal(lightning().getAttribute('aria-pressed'), 'true');
assert.deepEqual(speed.calls, [], 'lightning does not change model or effort');
speed.items()[0].dispatch('click');
assert.equal(speed.props.selectedServiceTier, 'priority', 'model shortcut preserves the independently enabled speed');
lightning().dispatch('click');
assert.deepEqual(speed.tierWrites, ['priority', null]);
assert.equal(lightning().getAttribute('aria-pressed'), 'false');
speed.props.serviceTierOptionsLoading = true;
speed.controller.sync();
assert.equal(lightning().disabled, true);
lightning().dispatch('click');
assert.equal(speed.tierWrites.length, 2, 'loading cannot toggle speed');
speed.props.serviceTierOptionsLoading = false;
speed.props.models[0].serviceTiers = [];
speed.controller.sync();
assert.equal(lightning().disabled, true, 'models without fast support cannot enable it');
speed.controller.destroy();

const guards = fixture();
for (const [name, apply, reset] of [
  ['unsupported effort', () => guards.props.models[0].supportedReasoningEfforts = [{ reasoningEffort: 'high' }], () => guards.props.models[0].supportedReasoningEfforts = [{ reasoningEffort: 'medium' }]],
  ['locked model', () => guards.props.lockedModelSlug = 'other-model', () => delete guards.props.lockedModelSlug],
  ['model disabled', () => guards.props.modelOptionsDisabled = true, () => delete guards.props.modelOptionsDisabled],
  ['effort disabled', () => guards.props.reasoningEffortDisabled = true, () => delete guards.props.reasoningEffortDisabled],
  ['native trigger disabled', () => guards.trigger.disabled = true, () => guards.trigger.disabled = false],
  ['hidden model', () => guards.props.models[0].hidden = true, () => delete guards.props.models[0].hidden],
  ['disabled option', () => guards.props.modelOptions = [{ model: guards.props.models[0], disabledReason: 'unavailable' }], () => delete guards.props.modelOptions]
]) {
  apply();
  guards.controller.sync();
  assert.equal(guards.items()[0].disabled, true, name + ' disables the shortcut');
  guards.items()[0].dispatch('click');
  assert.deepEqual(guards.calls, [], name + ' remains guarded if a callback is dispatched directly');
  reset();
}
guards.props.model = 'other-model';
guards.props.onBeforeSelectModel = () => false;
guards.controller.sync();
guards.items()[0].dispatch('click');
assert.deepEqual(guards.calls, [], 'the native model confirmation gate can decline selection');
guards.editor.setAttribute('contenteditable', 'false');
guards.controller.sync();
assert.equal(guards.left.querySelector('.bc-composer-shortcuts').hidden, true, 'a read-only composer hides shortcuts');
guards.controller.destroy();

const alternate = fixture({ alternateCurrent: true });
alternate.items()[0].dispatch('click');
assert.deepEqual(alternate.calls, [['model-option'], ['model', 'gpt-6.1-sol', 'medium']], 'the current React root selects the alternate fiber rather than stale props');
alternate.controller.destroy();

const configured = fixture();
configured.configure();
const dialog = configured.document.body.querySelector('dialog');
const rows = dialog.querySelector('.bc-composer-shortcut-rows');
const rowFirst = rows.children[0], rowSecond = rows.children[1];
const rowHandle = rowFirst.querySelector('[aria-label="拖动排序"]');
assert.equal(rowHandle.getAttribute('draggable'), 'true');
rowHandle.dispatch('dragstart', { dataTransfer });
rowSecond.dispatch('dragover', { clientY: 250 });
assert.equal(rowSecond.getAttribute('data-bc-row-drop'), 'after');
rowSecond.dispatch('drop', { clientY: 250 });
assert.equal(rows.children[1], rowFirst, 'configuration handle moves the complete row downward');
assert.equal(configured.preferences.has(preferenceKey), false, 'configuration order is pending until Save');
rowHandle.dispatch('keydown', { altKey: true, key: 'ArrowUp' });
assert.equal(rows.children[0], rowFirst, 'keyboard sorting moves the row back up');
assert.deepEqual(configured.calls, [], 'configuration sorting cannot change models');
rows.children[0].querySelector('input').value = '日常';
rows.children[0].querySelectorAll('select')[1].value = 'high';
rows.children[1].querySelector('[aria-label="删除快捷选项"]').dispatch('click');
dialog.querySelector('form').dispatch('submit');
const saved = JSON.parse(configured.preferences.get(preferenceKey));
assert.deepEqual(saved, [{ name: '日常', model: 'gpt-6.1-sol', effort: 'high' }]);
assert.equal(configured.items()[0].textContent, '日常');
assert.equal(configured.document.activeElement, configured.left.querySelector('[aria-label="配置模型快捷选项"]'), 'saving restores focus to the current config opener');
assert.deepEqual(configured.calls, [], 'editing presets does not select a model');
configured.controller.destroy();
assert.equal(configured.intervals.size, 0, 'teardown clears polling');
assert.equal(configured.listeners.size, 0, 'teardown removes the storage listener');
assert.equal(configured.document.head.children.length, 0, 'teardown removes injected styles');
assert.equal(configured.left.querySelector('.bc-composer-shortcuts'), null, 'teardown removes shortcut controls');
assert.equal(configured.document.body.querySelector('dialog'), null, 'teardown removes configuration dialog');
const restored = fixture({ saved });
assert.equal(restored.items().length, 1);
assert.equal(restored.items()[0].textContent, '日常', 'saved presets survive reinjection');
restored.items()[0].dispatch('click');
assert.deepEqual(restored.calls.slice(-1), [['model', 'gpt-6.1-sol', 'high']]);
restored.listeners.get('storage')({ key: preferenceKey, newValue: JSON.stringify([{ name: '跨窗口', model: 'gpt-6.1-sol', effort: 'medium' }]) });
assert.equal(restored.items()[0].textContent, '跨窗口', 'external preference changes update controls');
restored.controller.destroy();
console.log('PASS: composer model/effort callbacks, independent speed, native guards, current React branch, preset persistence and teardown');

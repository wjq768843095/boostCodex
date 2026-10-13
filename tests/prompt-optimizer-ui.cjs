'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
class Element {
  constructor(tag, document) { this.tagName = tag; this.owner = document; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; }
  get isConnected() { return !!this.root || !!this.parentElement?.isConnected; }
  get lastElementChild() { return this.children.at(-1); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  matches(selector) { if (selector.startsWith('.')) return this.className === selector.slice(1); if (!selector.startsWith('[')) return this.tagName === selector; return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => key in this.attributes && (value === undefined || this.attributes[key] === value)); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== callback); }
  dispatch(name, extras = {}) { for (const callback of this.listeners[name] || []) callback({ target: this, preventDefault() {}, stopPropagation() {}, ...extras }); }
  focus() { this.owner.activeElement = this; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function fixture({ mode = 'recent', hotkey = 'Ctrl+Alt+P' } = {}) {
  const document = new Element('document'); document.owner = document; document.root = true;
  document.createElement = tag => new Element(tag, document); document.createTextNode = text => Object.assign(new Element('text', document), { textContent: text });
  document.head = document.createElement('head'); document.body = document.createElement('body'); document.append(document.head, document.body);
  const surface = document.createElement('div'); surface.setAttribute('data-composer-surface-variant', 'default'); document.body.append(surface);
  const anchor = document.createElement('div'), wrapper = document.createElement('span'), add = document.createElement('button');
  add.setAttribute('data-composer-navigation-target', 'add-context'); wrapper.append(add); anchor.append(wrapper); surface.append(anchor);
  const editor = document.createElement('div'); editor.setAttribute('data-codex-composer', 'true'); editor.setAttribute('contenteditable', 'true'); surface.append(editor);
  const doc = text => ({ text, eq(other) { return this === other; }, descendants(callback) { callback({ type: { name: 'paragraph' } }); } });
  const writes = [], calls = [];
  const state = { doc: doc('原始提示词'), get tr() { const meta = { sentinel: 42 }; return { getMeta(key) { return meta[typeof key === 'string' ? key : key.key]; }, setMeta(key, value) { meta[key] = value; return this; } }; } };
  const controller = { historyBoundaries: 0, view: { dom: editor, state, dispatch(transaction) { assert.equal(transaction.getMeta('sentinel'), 42); assert.equal(transaction.getMeta('addToHistory'), false); if (transaction.getMeta({key:'closeHistory$23'})) controller.historyBoundaries++; } }, getPersistedText() { return this.view.state.doc.text; }, setPromptText(text) { writes.push(text); this.view.state.doc = doc(text); }, restoreDocument(previous) { this.view.state.doc = previous; }, focus() { editor.focus(); } };
  const thread = { memoizedProps: { conversationId: 'fixture-chat' }, child: { memoizedProps: { turn: { turnId: 'one', turnStartedAtMs: 1, params: { threadId: 'fixture-chat' }, items: [
    { type: 'userMessage', content: [{ type: 'text', text: '只调整顶部按钮，保留布局' }, { type: 'image', url: 'private-attachment' }] },
    { type: 'agentMessage', phase: 'commentary', text: '内部进度不发送' },
    { type: 'commandExecution', text: '工具输出不发送' },
    { type: 'agentMessage', phase: 'final_answer', text: '建议将顶部按钮缩小' }
  ] } }, sibling: { memoizedProps: { conversationId: 'other-chat' }, child: { memoizedProps: { turn: { turnId: 'foreign', items: [{ type: 'userMessage', content: [{ type: 'text', text: '另一聊天私密消息' }] }] } } } } } };
  editor.__reactFiber$fixture = { memoizedProps: { composerController: controller }, return: thread };
  surface.__reactFiber$fixture = thread;
  const window = new Element('window', document); window.location = { href: 'app://-/local/fixture' }; let complete, fail;
  let settings = {hasApiKey:true,contextMode:mode,hotkey,model:'deepseek-flash',systemPrompt:'优化当前输入'};
  const saves=[];
  const api = (route, options) => { if (route.endsWith('/settings')) { if (options?.method === 'POST') { const input=JSON.parse(options.body);saves.push(input);settings={...settings,...input}; } return Promise.resolve({...settings}); } calls.push({ route, options }); return new Promise((resolve, reject) => { complete = resolve; fail = reject; }); };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/prompt-optimizer-shortcut.js'), 'utf8'), { window });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/prompt-optimizer.js'), 'utf8'), { window, document, navigator: {} });
  const instance = window.BetterCodexPromptOptimizer.create({ api }); instance.sync();
  const optimize = document.querySelector('.bc-prompt-tools').children[0];
  return { document, editor, controller, window, instance, optimize, calls, saves, writes, doc, thread, complete: value => complete(value), fail: value => fail(value) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
(async () => {
  const f = fixture(); f.optimize.dispatch('click'); f.optimize.dispatch('click');
  await flush();
  assert.equal(f.calls.length, 1, 'double click sends one request'); assert.equal(f.optimize.disabled, true);
  assert.equal(JSON.parse(f.calls[0].options.body).text, '原始提示词');
  assert.deepEqual(JSON.parse(f.calls[0].options.body).context, [{ role: 'user', content: '只调整顶部按钮，保留布局' }, { role: 'assistant', content: '建议将顶部按钮缩小' }]);
  f.complete({ text: '优化后的提示词' }); await flush(); assert.deepEqual(f.writes, ['优化后的提示词'], 'successful optimization automatically replaces the draft');
  assert.equal(f.document.querySelector('.bc-prompt-dialog'), undefined, 'optimization never opens a dialog');
  assert.equal(f.controller.historyBoundaries, 2, 'replacement is separated from prior typing and following edits in native history');
  f.document.querySelector('.bc-prompt-tools').children[1].dispatch('click'); assert.equal(f.controller.getPersistedText(), '原始提示词', 'restore returns the exact original document');
  f.document.dispatch('keydown', { target: f.editor, code: 'KeyP', ctrlKey: true, altKey: true, isComposing: true }); assert.equal(f.calls.length, 1);
  f.document.dispatch('keydown', { target: f.editor, code: 'KeyP', ctrlKey: true, altKey: true }); await flush(); assert.equal(f.calls.length, 2);
  f.controller.view.state.doc = f.doc('用户新输入'); f.complete({ text: '迟到的优化结果' }); await flush();
  assert.equal(f.writes.length, 1, 'editing during request must preserve the new draft');
  assert.equal(f.document.querySelector('.bc-prompt-dialog'), undefined);
  assert.equal(f.controller.getPersistedText(), '用户新输入');
  f.instance.destroy(); assert.equal(f.document.querySelector('.bc-prompt-tools'), undefined);
  const route = fixture(); route.optimize.dispatch('click'); await flush(); route.window.location.href += '-other'; route.complete({ text: '另一会话结果' }); await flush(); assert.equal(route.writes.length, 0);
  assert.equal(route.document.querySelector('.bc-prompt-dialog'), undefined);
  route.instance.destroy();
  const gone = fixture(); gone.optimize.dispatch('click'); await flush(); gone.instance.destroy(); gone.complete({ text: '卸载后的结果' }); await flush(); assert.equal(gone.writes.length, 0);
  const failed = fixture(); failed.optimize.dispatch('click'); await flush(); failed.fail(new Error('敏感原始报错')); await flush(); assert.equal(failed.writes.length, 0); assert.equal(failed.optimize.disabled, false); failed.instance.destroy();
  const stale = fixture(); const liveRoot = {}; const oldRoot = { stateNode: { current: liveRoot } };
  const old = stale.editor.__reactFiber$fixture; old.return = oldRoot; old.alternate = { memoizedProps: { composerController: stale.controller }, return: liveRoot };
  stale.optimize.dispatch('click'); await flush(); stale.complete({ text: '当前分支结果' }); await flush(); assert.equal(stale.writes[0], '当前分支结果'); stale.instance.destroy();
  const input = fixture({ mode: 'input' }); input.optimize.dispatch('click'); await flush(); assert.deepEqual(JSON.parse(input.calls[0].options.body).context, []); input.instance.destroy();
  const hidden = fixture(); hidden.optimize.dispatch('click'); await flush(); hidden.editor.hidden = true; hidden.complete({ text: '隐藏聊天结果' }); await flush(); assert.equal(hidden.writes.length, 0); hidden.instance.destroy();
  const unavailable = fixture(); unavailable.thread.child = null; unavailable.optimize.dispatch('click'); await flush(); assert.equal(unavailable.calls.length, 0, 'missing history must not silently optimize without context'); unavailable.instance.destroy();
  const custom = fixture({ hotkey: 'Ctrl+Shift+K' }); await flush();
  const dispatchKey = (test, extras) => test.document.dispatch('keydown', { target: test.editor, ctrlKey: true, ...extras });
  dispatchKey(custom, {code:'KeyP',altKey:true}); await flush(); assert.equal(custom.calls.length,0,'the old shortcut is inactive');
  dispatchKey(custom, {code:'KeyK',shiftKey:true}); await flush(); assert.equal(custom.calls.length,1,'a persisted custom shortcut triggers');
  custom.complete({text:'自定义快捷键结果'}); await flush();
  await custom.instance.configure(custom.optimize);
  const recorder=custom.document.querySelector('[aria-label="优化快捷键"]');
  recorder.dispatch('keydown',{code:'KeyZ',key:'z',ctrlKey:true});assert.equal(recorder.value,'Ctrl + Shift + K','undo shortcut is reserved');
  recorder.dispatch('keydown',{code:'F8',key:'F8',ctrlKey:true,altKey:true});assert.equal(recorder.value,'Ctrl + Alt + F8');
  custom.document.querySelector('form').dispatch('submit');await flush();assert.equal(custom.saves.at(-1).hotkey,'Ctrl+Alt+F8');
  dispatchKey(custom,{code:'KeyK',shiftKey:true});await flush();assert.equal(custom.calls.length,1,'saving disables the former binding immediately');
  dispatchKey(custom,{code:'F8',altKey:true});await flush();assert.equal(custom.calls.length,2,'saving activates the new binding immediately');
  custom.complete({text:'功能键结果'});await flush();custom.instance.destroy();
  const disabled=fixture({hotkey:''});await flush();dispatchKey(disabled,{code:'KeyP',altKey:true});await flush();assert.equal(disabled.calls.length,0);disabled.optimize.dispatch('click');await flush();assert.equal(disabled.calls.length,1,'disabling the shortcut does not disable the button');disabled.instance.destroy();
  const bounded = f.window.BetterCodexPromptOptimizer.limitContext(Array.from({length:14}, (_,i)=>({role:'user',content:String(i).repeat(10000)})));
  assert.ok(bounded.messages.length<=12); assert.ok(bounded.messages.reduce((sum,m)=>sum+m.content.length,0)<=32000); assert.equal(bounded.truncated,true);
  console.log('PASS: scoped recent context, automatic replacement without dialogs, native history boundaries, draft/visibility guards, restore and hotkey (mock responses only)');
})().catch(error => { console.error(error); process.exitCode = 1; });

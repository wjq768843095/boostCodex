'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/workflow-web/app.js'), 'utf8');
const storageKey = 'boost-codex-workflow-view-v1';
const copy = value => JSON.parse(JSON.stringify(value));
const decode = value => String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => copy(value) });

function baseline() {
  return { cursor: 1, projects: [{ ref: 'P001', name: '项目一', root: 'C:/fixture', revision: 2, status: 'active' }],
    tasks: [{ ref: 'P001-T001', projectRef: 'P001', type: 'charter', charterVersion: 1, revision: 1, status: 'draft', title: '总纲' },
      { ref: 'P001-T002', projectRef: 'P001', type: 'development', revision: 3, status: 'human_review', title: '任务', requirements: '旧要求', acceptance: '检查页面' }],
    charters: [{ taskRef: 'P001-T001', version: 1, status: 'draft', content: '已保存总纲' }], reviews: [], batches: [], issues: [], executions: [] };
}

function fixture({ saved, state = baseline(), fetchHook } = {}) {
  const elements = new Map(), listeners = new Map(), windowListeners = new Map(), streams = [], calls = [], timers = [];
  const storage = new Map([[storageKey, saved || JSON.stringify({ projectRef: 'P001', tab: 'charter', drafts: {} })]]);
  const document = { documentElement: { dataset: {} }, activeElement: null, hidden: false,
    getElementById: id => elements.get(id) || null,
    addEventListener: (name, handler) => listeners.set(name, handler) };
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.dataset = {}; this.fields = []; this.handlers = new Map(); this.classList = { add() {}, remove() {}, toggle() {} }; this.open = false; }
    set innerHTML(html) {
      this.html = html; this.fields = [];
      for (const match of html.matchAll(/<(textarea|input|select)\b([^>]*)>(?:([\s\S]*?)<\/\1>)?/g)) {
        const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
        const node = new Element(attrs.id); node.name = attrs.name; node.value = match[1] === 'input' ? attrs.value || '' : decode(match[3]); node.parent = this;
        if (attrs['data-draft']) node.dataset.draft = attrs['data-draft']; if (attrs['data-revision']) node.dataset.revision = attrs['data-revision'];
        this.fields.push(node); if (node.id) elements.set(node.id, node);
      }
    }
    get innerHTML() { return this.html || ''; }
    querySelector() { return this.fields[0] || null; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    closest(selector) { return selector === '#dialog-fields' && this.parent?.id === 'dialog-fields' ? this.parent : null; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  for (const id of ['tool', 'toast', 'project-count', 'overview-nav', 'project-nav', 'breadcrumb', 'content', 'dialog-title', 'dialog-fields', 'dialog-error', 'dialog-submit', 'dialog-form', 'form-dialog', 'connection']) elements.set(id, new Element(id));
  class EventSource {
    constructor(url) { this.url = url; this.handlers = new Map(); streams.push(this); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    close() { this.closed = true; }
    emit(name) { return this.handlers.get(name)?.({}); }
  }
  const api = { state: copy(state), sessionStatus: 200, revision: 'r1', reloads: 0, hook: fetchHook };
  const context = { document, window: { addEventListener: (name, fn) => windowListeners.set(name, fn) }, navigator: { clipboard: { writeText: async () => {} } },
    crypto, AbortSignal, EventSource, location: { reload: () => { api.reloads++; } }, confirm: () => true,
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout: timer => { if (timer) timer.cancelled = true; },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    FormData: class { constructor() { return elements.get('dialog-fields').fields.filter(n => n.name).map(n => [n.name, n.value]); } },
    fetch: async (url, options = {}) => {
      const input = options.body ? JSON.parse(options.body) : null; calls.push({ url, input });
      const hooked = api.hook?.(url, options, input); if (hooked !== undefined) return hooked;
      if (url.endsWith('/session')) return response({ csrf: 'test-csrf', revision: api.revision, message: '请重新连接' }, api.sessionStatus);
      if (url.endsWith('/state')) return response(api.state);
      if (url.endsWith('/context')) return response({ finalAcceptance: { current: true } });
      return response({ task: { revision: 4 }, project: { revision: 3 } });
    }, console };
  vm.runInNewContext(source, context, { filename: 'workflow-web/app.js' });
  const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
  return Object.assign(api, {
    document, calls, streams, timers, flush, element: id => elements.get(id),
    field: name => elements.get('dialog-fields').fields.find(n => n.name === name),
    stored: () => JSON.parse(storage.get(storageKey)), saved: () => storage.get(storageKey),
    async input(node, value) { node.value = value; listeners.get('input')({ target: node }); await flush(); },
    async click(action, ref) { const node = { disabled: false, dataset: { action, ref } }; listeners.get('click')({ target: { closest: () => node } }); await flush(); },
    async submit() { const result = elements.get('dialog-form').handlers.get('submit')({ target: elements.get('dialog-form'), preventDefault() {} }); await flush(); return result; },
    async event(name) { streams.at(-1).emit(name); await flush(); },
    async online() { windowListeners.get('online')(); await flush(); },
    async retry() { const timer = timers.find(t => !t.cancelled && !t.ran && t.delay <= 1200); assert.ok(timer, 'one bounded retry is pending'); timer.ran = true; timer.callback(); await flush(); }
  });
}

async function main() {
  const network = fixture({ fetchHook: url => url.endsWith('/session') ? Promise.reject(Error('offline')) : undefined });
  await network.flush(); await network.retry(); await network.retry();
  assert.equal(network.calls.filter(c => c.url.endsWith('/session')).length, 3);
  assert.equal(network.document.documentElement.dataset.panelAuth, 'unknown');
  assert.equal(network.stored().projectRef, 'P001', 'initial network errors retain the saved project');
  network.hook = null; await network.click('refresh');
  assert.equal(network.document.documentElement.dataset.panelAuth, 'ready');
  assert.equal(network.element('breadcrumb').textContent, '项目 / 项目一');

  const unauthenticated = fixture({ fetchHook: url => url.endsWith('/session') ? response({ message: '请重新连接' }, 401) : undefined });
  await unauthenticated.flush();
  assert.equal(unauthenticated.document.documentElement.dataset.panelAuth, 'required');
  assert.equal(unauthenticated.calls.length, 1, '401 does not repeatedly retry a failed cookie');

  const f = fixture(); await f.flush();
  await f.click('tab', 'tasks'); await f.click('task', 'P001-T002');
  await f.input(f.element('review-note'), '正在核验，不要丢失');
  f.state.projects[0].name = '更新的项目'; f.state.cursor++;
  await f.event('change');
  assert.equal(f.element('review-note').value, '正在核验，不要丢失');
  assert.equal(f.stored().drafts['note:P001-T002'].revision, 3);
  assert.equal(f.reloads, 0, 'ordinary data changes never reload the page');
  f.state.tasks[1].revision = 4; await f.event('change');
  assert.equal(f.stored().drafts['note:P001-T002'].revision, 3);
  await f.click('rebase-note', 'P001-T002'); assert.equal(f.stored().drafts['note:P001-T002'].revision, 4);
  f.state.tasks[1].revision = 3;

  let release;
  let held = false;
  f.hook = url => { if (url.endsWith('/state') && !held) { held = true; const old = copy(f.state); return new Promise(resolve => { release = () => resolve(response(old)); }); } };
  f.streams.at(-1).emit('change'); await f.flush();
  f.state.projects[0].name = '最后的项目'; f.state.cursor++;
  f.streams.at(-1).emit('change'); await f.flush(); release(); await f.flush();
  assert.equal(f.element('breadcrumb').textContent, '项目 / 最后的项目', 'an event during a state request is caught up');

  f.hook = null; await f.click('tab', 'charter');
  await f.input(f.element('charter-editor'), '第一次编辑');
  f.hook = (url, options, input) => { if (url.endsWith('/charter.save')) return new Promise(resolve => { release = () => { f.state.tasks[0].revision = 2; f.state.charters[0].content = input.content; resolve(response({ task: { revision: 2 } })); }; }); };
  f.streams.at(-1).emit('change'); await f.flush();
  await f.click('save-charter', 'P001-T001');
  await f.input(f.element('charter-editor'), '保存期间继续编辑'); release(); await f.flush();
  assert.equal(f.stored().drafts['charter:P001-T001'].content, '保存期间继续编辑');
  assert.equal(f.stored().drafts['charter:P001-T001'].revision, 2);
  f.hook = null;

  await f.click('tab', 'tasks'); await f.click('edit-task', 'P001-T002');
  await f.input(f.field('requirements'), '新的要求草稿');
  const saved = f.saved(); f.state.tasks[1].revision = 4; f.state.tasks[1].requirements = '远程新要求';
  await f.event('change');
  assert.equal(f.stored().dialogDraft.expectedRevision, 3, 'SSE never rebases an open editing form');
  const restored = fixture({ saved, state: f.state }); await restored.flush();
  assert.equal(restored.element('form-dialog').open, true);
  assert.equal(restored.field('requirements').value, '新的要求草稿');
  assert.equal(restored.stored().dialogDraft.expectedRevision, 3);
  await restored.submit();
  assert.equal(restored.calls.some(c => c.url.endsWith('/task.update')), false, 'a stale draft cannot overwrite the remote task');
  assert.ok(restored.element('dialog-fields').innerHTML.includes('远程新要求'));
  await restored.click('rebase-dialog'); await restored.submit();
  assert.equal(restored.calls.find(c => c.url.endsWith('/task.update')).input.expectedRevision, 4);
  assert.equal(restored.stored().dialogDraft, undefined);

  for (const [action, field, value] of [['new-project', 'name', '项目草稿'], ['new-issue', 'description', '问题草稿']]) {
    const form = fixture(); await form.flush(); await form.click(action); await form.input(form.field(field), value);
    const reload = fixture({ saved: form.saved() }); await reload.flush();
    assert.equal(reload.field(field).value, value, 'form fields survive actual document replacement');
    await reload.click('close-dialog'); assert.equal(reload.stored().dialogDraft, undefined, 'explicit cancel discards the modal draft');
  }
  const lost = fixture(); await lost.flush(); await lost.click('new-task');
  await lost.input(lost.field('title'), '请求已经保存'); await lost.input(lost.field('requirements'), '保持一次'); await lost.input(lost.field('acceptance'), '一次记录');
  lost.hook = (url, options, input) => {
    if (url.endsWith('/task.create')) { lost.state.projects[0].revision = 3; lost.state.tasks.push({ ref: 'P001-T003', projectRef: 'P001', revision: 1, status: 'pending', ...input }); return Promise.reject(Error('response lost after commit')); }
  };
  await lost.submit(); const firstRequest = lost.calls.find(c => c.url.endsWith('/task.create')).input;
  const replay = fixture({ saved: lost.saved(), state: lost.state, fetchHook: url => url.endsWith('/task.create') ? response({ task: { ref: 'P001-T003', revision: 1 } }) : undefined });
  await replay.flush(); await replay.submit();
  assert.equal(replay.calls.find(c => c.url.endsWith('/task.create')).input.requestId, firstRequest.requestId, 'a recovered form retries the same committed request');
  assert.equal(replay.stored().dialogDraft, undefined);
  const issueState = baseline(); issueState.tasks[1].status = 'completed'; issueState.issues.push({ ref: 'P001-I001', projectRef: 'P001', revision: 7, title: '问题', status: 'open', repairTaskRefs: ['P001-T002'] });
  const issue = fixture({ state: issueState }); await issue.flush(); await issue.click('retest-fail', 'P001-I001'); await issue.input(issue.field('note'), '复验草稿');
  const issueReload = fixture({ saved: issue.saved(), state: issueState }); await issueReload.flush();
  assert.equal(issueReload.field('note').value, '复验草稿'); assert.equal(issueReload.stored().dialogDraft.expectedRevision, 7);

  const projects = baseline(); projects.projects[0].finalBatchRef = 'P001-B001'; projects.projects[0].status = 'completed';
  projects.projects.push({ ref: 'P002', name: '另一个项目', root: 'C:/other', revision: 1, status: 'active' });
  let releaseAcceptance;
  const switching = fixture({ state: projects, fetchHook: (url, options, input) => {
    if (url.endsWith('/context') && input.projectRef === 'P001') return new Promise(resolve => { releaseAcceptance = () => resolve(response({ finalAcceptance: { current: false } })); });
  } });
  await switching.flush(); await switching.click('project', 'P002'); releaseAcceptance(); await switching.flush();
  assert.equal(switching.stored().projectRef, 'P002');
  assert.equal(switching.element('content').innerHTML.includes('badge needs_retest'), false, 'a late acceptance response belongs to its original project');

  const translatedState = baseline(); translatedState.tasks[1].status = 'future_status';
  translatedState.reviews.push({ taskRef: 'P001-T002', client: 'future_client', passed: true, evidence: [{ kind: 'future_kind', result: 'future_result' }] });
  translatedState.reviews[0].evidence.push({ kind: 'browser', result: 'not_run', required: false });
  translatedState.batches.push({ ref: 'P001-B001', projectRef: 'P001', status: 'confirmed', report: { passed: true } });
  const translated = fixture({ state: translatedState }); await translated.flush(); await translated.click('tab', 'tasks'); await translated.click('task', 'P001-T002');
  const text = decode(translated.element('content').innerHTML.replace(/<[^>]*>/g, ''));
  assert.equal(/future_(status|client|kind|result)/.test(text), false, 'unknown enum values remain business-language labels');
  assert.ok(text.includes('未执行'), 'optional unexecuted evidence is never presented as passed');
  await translated.click('tab', 'batches');
  assert.match(translated.element('content').innerHTML, /data-action="confirm-batch"[^>]*disabled/, 'a confirmed batch cannot be confirmed again');
  await issue.click('close-dialog'); issue.state.tasks[1].status = 'in_progress'; await issue.event('change'); await issue.click('tab', 'issues');
  assert.match(issue.element('content').innerHTML, /data-action="retest-issue"[^>]*disabled/, 'unfinished repair tasks cannot be manually retested');
  issue.state.tasks[1].status = 'completed'; await issue.event('change');
  assert.doesNotMatch(issue.element('content').innerHTML, /data-action="retest-issue"[^>]*disabled/, 'completed repairs allow manual retesting');

  const service = fixture(); await service.flush(); await service.event('open'); assert.equal(service.reloads, 0);
  service.revision = 'r2'; await service.event('open'); assert.equal(service.reloads, 1, 'only a changed service revision reloads the page');
  const cookie = fixture(); await cookie.flush(); cookie.hook = url => url.endsWith('/state') ? response({ message: '登录已失效' }, 401) : undefined;
  await cookie.event('change'); assert.equal(cookie.document.documentElement.dataset.panelAuth, 'required'); assert.equal(cookie.streams.at(-1).closed, true);
  console.log('workflow web: retry/authentication, live catch-up, preserved drafts, conflict review and revision reload checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
(() => {
  const key = 'better-codex-workflow-view-v1', $ = id => document.getElementById(id), esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const labels = { pending: '待开发', in_progress: '进行中', ai_review: '待 AI 验收', human_review: '待人工验收', completed: '已完成', draft: '草稿', awaiting_confirmation: '待确认', submitted: '待确认', confirmed: '已确认', active: '进行中', open: '待解决', repairing: '修复中', needs_retest: '需复验', closed: '已解决', passed: '通过', failed: '不通过', ready: '待确认', reviewing: '验收中' };
  const kindLabels = { source: '源码检查', static: '源码检查', build: '构建', api: '接口', database: '数据', browser: '界面', device: '设备', manual: '人工', test: '测试' };
  const resultLabels = { passed: '通过', failed: '不通过', not_run: '未执行', unknown: '未核验', pass: '通过', fail: '不通过' };
  const clientLabels = { codex: 'Codex', claude: 'Claude Code', web: '面板' };
  let view; try { view = JSON.parse(localStorage.getItem(key)); } catch {} view = { projectRef: '', tab: 'charter', taskRef: '', filter: '', search: '', tool: 'codex', drafts: {}, ...view };
  let data = { projects: [], tasks: [], charters: [], reviews: [], batches: [], issues: [], executions: [], cursor: 0 }, csrf, serviceRevision, stream, busy = false, modal = null, toastTimer, refreshPromise = null, refreshWanted = false, finalAcceptance = null;
  let sessionPromise = null, recoveryPromise = null, hasState = false, reloading = false;
  const requests = new Map(Object.entries(view.pendingRequests || {}));
  document.documentElement.dataset.panelInstance = crypto.randomUUID();
  document.documentElement.dataset.panelAuth = 'unknown';
  $('tool').value = view.tool;
  function saveView() { try { localStorage.setItem(key, JSON.stringify(view)); } catch {} }
  function saveRequests() { view.pendingRequests = Object.fromEntries(requests); saveView(); }
  function badge(status) { return '<span class="badge ' + esc(status) + '">' + esc(labels[status] || '待处理') + '</span>'; }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
  function project() { return data.projects.find(item => item.ref === view.projectRef); }
  function tasks() { return data.tasks.filter(item => item.projectRef === view.projectRef); }
  function task(ref = view.taskRef) { return data.tasks.find(item => item.ref === ref); }
  function charterFor(ref) { return data.charters.filter(item => item.taskRef === ref).sort((a, b) => b.version - a.version)[0]; }
  function evidence(items) { return (items || []).map(item => '<div class="evidence"><strong>' + esc(kindLabels[item.kind] || '其他检查') + '</strong><span>' + esc(resultLabels[item.result] || '待核验') + (item.detail ? ' · ' + esc(item.detail) : '') + '</span></div>').join(''); }
  function reviewsFor(t) {
    const records = data.reviews.filter(item => item.taskRef === t.ref).map(item => '<div class="review"><small>' + esc(item.kind === 'human' || item.type === 'human' ? '人工验收' : 'AI 验收') + ' · ' + esc(clientLabels[item.client || (item.kind === 'human' ? 'web' : data.executions.find(execution => execution.ref === item.executionId)?.client)] || '其他工具') + '</small> ' + badge(item.passed ? 'passed' : 'failed') + '<p>' + esc(item.summary || item.note) + '</p>' + evidence(item.evidence) + '</div>').join('');
    const draft = view.drafts['note:' + t.ref];
    return records + (t.status === 'human_review' && draft && draft.revision !== t.revision ? '<p class="remote-notice">任务已有更新。请核对当前成果和验收记录后继续验收。</p>' + button('rebase-note', '已核对当前成果', t.ref) : '');
  }
  function button(action, text, ref, cls = '', disabled = false) { return '<button type="button" class="' + cls + '" data-action="' + action + '"' + (ref ? ' data-ref="' + esc(ref) + '"' : '') + (disabled ? ' disabled' : '') + '>' + text + '</button>'; }
  function empty(title, message, action = '') { return '<div class="empty"><h2>' + esc(title) + '</h2><div>' + esc(message) + '</div>' + action + '</div>'; }
  function updateNavigation() {
    $('project-count').textContent = data.projects.length; $('overview-nav').classList.toggle('selected', !view.projectRef);
    $('project-nav').innerHTML = data.projects.map(item => '<button class="project-link' + (item.ref === view.projectRef ? ' selected' : '') + '" data-action="project" data-ref="' + esc(item.ref) + '">' + esc(item.name) + '</button>').join('');
    $('breadcrumb').textContent = project() ? '项目 / ' + project().name : '项目总览';
  }
  function overview() {
    const pending = data.tasks.filter(item => item.type !== 'charter' && ['pending', 'in_progress'].includes(item.status)).length, review = data.tasks.filter(item => ['ai_review', 'human_review', 'awaiting_confirmation'].includes(item.status)).length, issues = data.issues.filter(item => item.status !== 'closed').length;
    return '<div class="page-heading"><div><div class="eyebrow">工作流</div><h1>项目总览</h1><p class="subtitle">从总纲到交付，在这里查看每一步的进展。</p></div>' + button('new-project', '+ 添加项目', '', 'primary') + '</div><div class="stats">' + [['项目', data.projects.length], ['开发中 / 待开发', pending], ['待验收 / 待确认', review], ['待解决问题', issues]].map(([name, count]) => '<div class="stat"><small>' + name + '</small><strong>' + count + '</strong></div>').join('') + '</div><div class="section-heading"><h2>全部项目</h2><span class="small-text">' + data.projects.length + ' 个项目</span></div>' + (data.projects.length ? '<div class="projects-grid">' + data.projects.map(item => { const list = data.tasks.filter(t => t.projectRef === item.ref && t.type !== 'charter'); return '<article class="project-card"><div class="detail-heading"><span class="ref">' + esc(item.ref) + '</span>' + badge(item.status) + '</div><h3>' + esc(item.name) + '</h3><div class="path">' + esc(item.root) + '</div><div class="card-footer"><span>' + list.filter(t => t.status === 'completed').length + ' / ' + list.length + ' 项任务完成</span>' + button('project', '进入项目', item.ref) + '</div></article>'; }).join('') + '</div>' : empty('开始你的第一个项目', '登记项目名称和目录，然后创建总纲。', button('new-project', '添加项目', '', 'primary')));
  }
  function charterView(p) {
    const t = tasks().filter(item => item.type === 'charter').sort((a, b) => b.charterVersion - a.charterVersion)[0];
    if (!t) return empty('还没有总纲', '创建总纲任务，确定项目目标和验收标准。', button('create-charter', '创建总纲任务', p.ref, 'primary'));
    const c = charterFor(t.ref), draftKey = 'charter:' + t.ref, draft = view.drafts[draftKey], current = draft || { content: c?.content || '', revision: t.revision };
    return '<section class="panel"><div class="panel-head"><div><h2>项目总纲</h2><div class="ref">' + esc(t.ref) + ' · 版本 ' + (c?.version || 0) + '</div></div>' + badge(t.status) + '</div>' + (draft && draft.revision !== t.revision ? '<p class="remote-notice">总纲已有更新。你的未保存内容已保留，请核对后再保存。</p><details class="version-compare"><summary>查看最新已保存内容</summary><p class="prose">' + esc(c?.content) + '</p></details>' + button('rebase-charter', '以最新版本继续编辑', t.ref) : '') + '<textarea class="charter-editor" id="charter-editor" data-draft="' + esc(draftKey) + '" data-revision="' + current.revision + '" aria-label="总纲内容"' + (c?.status === 'confirmed' ? ' readonly' : '') + ' placeholder="填写项目目标、功能范围和验收标准">' + esc(current.content) + '</textarea><div class="actions">' + button('save-charter', '保存草稿', t.ref, '', c?.status === 'confirmed') + button('submit-charter', '提交确认', t.ref, '', !c?.content || !!draft || c?.status === 'confirmed') + button('confirm-charter', '确认此版本', t.ref, 'primary', t.status !== 'awaiting_confirmation' && t.status !== 'submitted') + button('copy-charter', '复制总纲指令', t.ref) + (data.executions.some(execution => execution.taskRef === t.ref && execution.status === 'active') ? button('revoke', '结束当前执行', t.ref, 'danger') : '') + (c?.status === 'confirmed' ? button('create-charter', '创建新版本', p.ref) : '') + '</div></section><div class="panel small-text gap-top">' + (p.confirmedCharterVersion ? '已确认版本：' + p.confirmedCharterVersion : '总纲确认后，可以拆分开发任务。') + '</div>';
  }
  function taskDetail(t) {
    if (!t) return '<section class="panel detail">' + empty('选择一项任务', '查看要求、成果与验收记录。') + '</section>';
    const active = data.executions.find(item => item.taskRef === t.ref && item.status === 'active');
    return '<section class="panel detail"><div class="detail-heading"><span class="ref">' + esc(t.ref) + '</span>' + badge(t.status) + '</div><h2>' + esc(t.title) + '</h2><div class="actions">' + button('copy-develop', '复制开发指令', t.ref, 'primary', t.status !== 'pending' && t.status !== 'in_progress') + button('copy-review', '复制验收指令', t.ref, '', t.status !== 'ai_review') + button('edit-task', '编辑', t.ref, '', !!active) + (active ? button('revoke', '结束当前执行', t.ref, 'danger') : '') + '</div><div class="detail-block"><h3>任务要求</h3><p class="prose">' + esc(t.requirements) + '</p></div><div class="detail-block"><h3>验收标准</h3><p class="prose">' + esc(t.acceptance) + '</p></div>' + (t.scopePaths?.length ? '<div class="detail-block"><h3>修改范围</h3><p class="prose">' + esc(t.scopePaths.join('\n')) + '</p></div>' : '') + (t.result ? '<div class="detail-block"><h3>开发成果</h3><p class="prose">' + esc(t.result.summary) + '</p>' + evidence(t.result.evidence) + '</div>' : '') + (t.status === 'human_review' ? '<textarea class="note-input" id="review-note" data-draft="note:' + esc(t.ref) + '" data-revision="' + (view.drafts['note:' + t.ref]?.revision ?? t.revision) + '" aria-label="人工验收说明" placeholder="填写验收说明或退回原因">' + esc(view.drafts['note:' + t.ref]?.content || '') + '</textarea><div class="actions small-gap">' + button('human-pass', '验收通过', t.ref, 'primary') + button('human-fail', '退回修改', t.ref, 'danger') + '</div>' : '') + reviewsFor(t) + '</section>';
  }
  function taskView(p) {
    const list = tasks().filter(item => item.type !== 'charter').filter(item => (!view.filter || item.status === view.filter) && (!view.search || (item.ref + item.title).toLowerCase().includes(view.search.toLowerCase())));
    return '<div class="toolbar"><div class="filters"><input id="task-search" type="search" value="' + esc(view.search) + '" placeholder="搜索任务名称或编号" aria-label="搜索任务"><select id="task-filter" aria-label="任务状态"><option value="">全部状态</option>' + ['pending', 'in_progress', 'ai_review', 'human_review', 'completed'].map(status => '<option value="' + status + '"' + (view.filter === status ? ' selected' : '') + '>' + labels[status] + '</option>').join('') + '</select></div><div class="actions">' + button('copy-plan', '复制拆分指令', p.ref, '', !p.confirmedCharterVersion) + button('new-task', '+ 添加任务', '', 'primary', !p.confirmedCharterVersion) + '</div></div><div class="task-grid"><div class="table-wrap">' + (list.length ? '<table><thead><tr><th>任务</th><th>状态</th></tr></thead><tbody>' + list.map(item => '<tr class="task-row' + (item.ref === view.taskRef ? ' selected' : '') + '" data-action="task" data-ref="' + esc(item.ref) + '"><td><div class="task-title">' + esc(item.title) + '</div><div class="ref">' + esc(item.ref) + (item.type === 'repair' ? ' · 问题修复' : '') + '</div></td><td>' + badge(item.status) + '</td></tr>').join('') + '</tbody></table>' : empty('暂无任务', p.confirmedCharterVersion ? '拆分总纲或添加第一项任务。' : '请先完成并确认总纲。')) + '</div>' + taskDetail(task()) + '</div>';
  }
  function batchView(p) {
    const list = data.batches.filter(item => item.projectRef === p.ref).slice().reverse(), necessary = tasks().filter(item => item.type !== 'charter'), canStart = necessary.length > 0 && necessary.every(item => item.status === 'completed');
    return '<div class="toolbar"><p class="subtitle">检查完整业务流程，发现的问题继续进入修复任务。</p>' + button('start-batch', '创建全项目验收', p.ref, 'primary', !canStart) + '</div><div class="split-list">' + (list.length ? list.map(item => '<section class="batch-card"><div class="detail-heading"><h3>全项目验收 <span class="ref">' + esc(item.ref) + '</span></h3>' + badge(item.status) + '</div><p>' + esc(item.summary || item.report?.summary || '等待提交项目验收报告。') + '</p>' + evidence(item.evidence || item.report?.evidence) + '<div class="actions">' + button('copy-batch', '复制项目验收指令', item.ref) + button('confirm-batch', '确认项目验收通过', item.ref, 'primary', ['completed', 'confirmed'].includes(item.status) || !(item.passed || item.report?.passed)) + '</div></section>').join('') : empty('尚未进行全项目验收', canStart ? '创建验收批次，检查各项功能配合后的实际表现。' : '全部开发任务通过人工验收后，即可开始。')) + '</div>';
  }
  function issueView(p) {
    const list = data.issues.filter(item => item.projectRef === p.ref).slice().reverse();
    const canRetest = item => item.status !== 'closed' && item.repairTaskRefs?.length > 0 && item.repairTaskRefs.every(ref => task(ref)?.status === 'completed');
    return '<div class="toolbar"><p class="subtitle">跟踪验收发现的问题，修复完成后进行复验。</p>' + button('new-issue', '+ 记录问题', '', 'primary') + '</div><div class="split-list">' + (list.length ? list.map(item => '<article class="issue-card"><div class="detail-heading"><h3>' + esc(item.title) + '</h3>' + badge(item.status) + '</div><div class="ref">' + esc(item.ref) + (item.batchRef ? ' · ' + esc(item.batchRef) : '') + '</div><p>' + esc(item.description) + '</p>' + ((item.repairTaskRefs?.length || item.taskRef) ? '<p class="small-text">关联任务：' + esc(item.repairTaskRefs?.join('、') || item.taskRef) + '</p>' : '') + '<div class="actions">' + button('repair-issue', '创建修复任务', item.ref, '', item.status === 'closed' || (item.repairTaskRefs || []).some(ref => task(ref)?.status !== 'completed')) + button('retest-issue', '复验通过', item.ref, 'primary', !canRetest(item)) + button('retest-fail', '复验不通过', item.ref, '', !canRetest(item)) + '</div></article>').join('') : empty('暂无验收问题', '后续发现的问题会集中显示在这里。')) + '</div>';
  }
  function render() {
    if (!hasState) return;
    const focused = document.activeElement, focusId = focused?.id, start = focused?.selectionStart, end = focused?.selectionEnd;
    updateNavigation(); const p = project(); if (!p) view.projectRef = '';
    if (!p) $('content').innerHTML = overview();
    else { const counts = [tasks().filter(t => t.type !== 'charter').length, data.batches.filter(b => b.projectRef === p.ref).length, data.issues.filter(i => i.projectRef === p.ref && i.status !== 'closed').length]; $('content').innerHTML = '<div class="page-heading"><div><div class="eyebrow">' + esc(p.ref) + '</div><h1>' + esc(p.name) + '</h1><p class="subtitle">' + esc(p.root) + '</p></div>' + badge(finalAcceptance && !finalAcceptance.current ? 'needs_retest' : p.status) + '</div><nav class="tabs" aria-label="项目内容">' + [['charter', '总纲', ''], ['tasks', '任务', counts[0]], ['batches', '验收', counts[1]], ['issues', '问题', counts[2]]].map(([tab, name, count]) => '<button data-action="tab" data-ref="' + tab + '" class="' + (view.tab === tab ? 'selected' : '') + '">' + name + (count !== '' ? '<span class="count">' + count + '</span>' : '') + '</button>').join('') + '</nav>' + ({ charter: charterView, tasks: taskView, batches: batchView, issues: issueView }[view.tab] || charterView)(p); }
    if (focusId && $(focusId)) { $(focusId).focus({ preventScroll: true }); if (typeof start === 'number' && $(focusId).setSelectionRange) { try { $(focusId).setSelectionRange(start, end); } catch {} } }
    saveView();
  }
  function requireAuthentication() {
    csrf = null; document.documentElement.dataset.panelAuth = 'required';
    stream?.close(); stream = null;
    $('connection').textContent = '需要重新连接'; $('connection').classList.remove('online');
  }
  async function readResponse(response) {
    if (response.status === 401) requireAuthentication();
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.message || '连接暂时不可用，请重试。'), { status: response.status, code: result.error });
    return result;
  }
  function ensureSession(force = false) {
    if (reloading) return Promise.resolve(null);
    if (sessionPromise) return sessionPromise;
    if (csrf && !force) return Promise.resolve({ csrf, revision: serviceRevision });
    sessionPromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await readResponse(await fetch('/api/workflow/v1/session', { signal: AbortSignal.timeout(8000) }));
          if (!result.csrf) throw Error('连接暂时不可用，请重试。');
          if (serviceRevision && result.revision && serviceRevision !== result.revision) { saveView(); reloading = true; location.reload(); return null; }
          csrf = result.csrf; serviceRevision = result.revision; document.documentElement.dataset.panelAuth = 'ready';
          return result;
        } catch (error) {
          if (error.status === 401 || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 400 : 1200));
        }
      }
    })().finally(() => { sessionPromise = null; });
    return sessionPromise;
  }
  async function refresh() {
    if (!csrf && !await ensureSession()) return;
    if (reloading) return;
    refreshWanted = true; if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      while (refreshWanted) {
        refreshWanted = false;
        data = await readResponse(await fetch('/api/workflow/v1/state')); hasState = true; finalAcceptance = null;
        if (project()?.finalBatchRef) {
          const projectRef = view.projectRef;
          const context = await readResponse(await fetch('/api/workflow/v1/actions/context', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workflow-CSRF': csrf }, body: JSON.stringify({ projectRef }) }));
          if (view.projectRef === projectRef) finalAcceptance = context.finalAcceptance;
          else { finalAcceptance = null; refreshWanted = true; }
        }
        render();
        if (view.dialogDraft && !$('form-dialog').open) openForm(view.dialogDraft);
      }
    })().finally(() => { refreshPromise = null; }); return refreshPromise;
  }
  async function act(operation, input = {}) {
    if (busy) throw Error('上一项操作尚未完成'); busy = true;
    const signature = JSON.stringify([operation, input]); const requestId = requests.get(signature) || crypto.randomUUID(); requests.set(signature, requestId); saveRequests();
    try { if (!await ensureSession()) throw Error('正在更新面板，请稍候。'); const response = await fetch('/api/workflow/v1/actions/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workflow-CSRF': csrf }, body: JSON.stringify({ ...input, requestId }) }); if (!response.ok) { requests.delete(signature); saveRequests(); } const result = await readResponse(response); requests.delete(signature); saveRequests(); await refresh().catch(() => toast('操作已保存，正在同步最新内容。')); return result; } finally { busy = false; }
  }
  async function copy(name, ref, suffix = '') { const text = (view.tool === 'claude' ? '/' : '$') + name + (ref ? ' ' + ref : '') + suffix; await navigator.clipboard.writeText(text); toast('指令已复制'); }
  function field(name, title, value = '', multi = false, hint = '') { return '<label class="field"><span>' + title + '</span>' + (multi ? '<textarea name="' + name + '"' + (name === 'scopePaths' ? '' : ' required') + '>' + esc(value) + '</textarea>' : '<input name="' + name + '" value="' + esc(value) + '" required>') + (hint ? '<small>' + hint + '</small>' : '') + '</label>'; }
  function dialogEntity(draft) {
    if (draft.kind === 'task.update') return task(draft.ref);
    if (draft.kind === 'issue.retest') return data.issues.find(item => item.ref === draft.ref);
    return data.projects.find(item => item.ref === draft.projectRef);
  }
  function openForm(draft) {
    const allowed = ['project.create', 'task.create', 'task.update', 'issue.create', 'issue.retest'];
    if (!draft || !allowed.includes(draft.kind) || !draft.values || typeof draft.values !== 'object') { delete view.dialogDraft; saveView(); return; }
    modal = draft; view.dialogDraft = draft; saveView(); const v = draft.values;
    let title, content;
    if (draft.kind === 'project.create') { title = '添加项目'; content = field('name', '项目名称', v.name) + field('root', '项目目录', v.root, false, '填写本机现有项目目录的完整路径。'); }
    else if (draft.kind.startsWith('task.')) { title = draft.kind === 'task.update' ? '编辑任务' : '添加任务'; content = field('title', '任务名称', v.title) + field('requirements', '任务要求', v.requirements, true) + field('acceptance', '验收标准', v.acceptance, true) + field('scopePaths', '修改范围（可选）', v.scopePaths, true, '填写相对项目目录的文件或文件夹，每行一项。'); }
    else if (draft.kind === 'issue.create') { title = '记录验收问题'; content = field('title', '问题名称', v.title) + field('description', '问题表现及复现步骤', v.description, true); }
    else { title = '问题复验'; content = field('note', draft.passed ? '复验说明' : '未通过原因', v.note, true); }
    const current = dialogEntity(draft);
    if (current && current.revision !== draft.expectedRevision) content += '<p class="remote-notice">内容已有更新。你的输入已保留，请核对后再保存。</p><details class="version-compare"><summary>查看当前已保存内容</summary><p class="prose">' + esc([current.title || current.name, current.requirements || current.description, current.acceptance].filter(Boolean).join('\n')) + '</p></details>' + button('rebase-dialog', '以当前版本继续编辑');
    $('dialog-title').textContent = title; $('dialog-fields').innerHTML = content; $('dialog-error').textContent = '';
    if (!$('form-dialog').open) $('form-dialog').showModal(); $('dialog-fields').querySelector('input,textarea')?.focus();
  }
  function closeForm() { $('form-dialog').close(); modal = null; delete view.dialogDraft; saveView(); }
  function taskForm(existing) {
    const p = project(); openForm({ kind: existing ? 'task.update' : 'task.create', ref: existing?.ref, projectRef: p.ref, expectedRevision: existing ? existing.revision : p.revision, values: { title: existing?.title || '', requirements: existing?.requirements || '', acceptance: existing?.acceptance || '', scopePaths: existing?.scopePaths?.join('\n') || '' } });
  }
  function submitDialog(draft, values) {
    const current = dialogEntity(draft);
    const input = { ...values, ...(draft.expectedRevision === undefined ? {} : { expectedRevision: draft.expectedRevision }) };
    if (draft.kind === 'task.create' || draft.kind === 'task.update') input.scopePaths = String(values.scopePaths || '').split('\n').map(value => value.trim()).filter(Boolean);
    if (draft.kind === 'task.update') input.taskRef = draft.ref;
    else if (draft.kind === 'issue.retest') { input.issueRef = draft.ref; input.passed = draft.passed; }
    else if (draft.kind !== 'project.create') input.projectRef = draft.projectRef;
    if (current && current.revision !== draft.expectedRevision && !requests.has(JSON.stringify([draft.kind, input]))) throw Object.assign(Error('内容已有更新，请核对当前内容后再保存。'), { code: 'revision_conflict' });
    return act(draft.kind, input);
  }
  async function action(name, ref) {
    const p = project(), t = task(ref);
    if (name === 'overview') { view.projectRef = ''; render(); }
    else if (name === 'project') { view.projectRef = ref; view.taskRef = ''; view.tab = 'charter'; view.search = ''; view.filter = ''; finalAcceptance = null; render(); void refresh().catch(() => {}); }
    else if (name === 'tab') { view.tab = ref; render(); }
    else if (name === 'task') { view.taskRef = ref; render(); }
    else if (name === 'refresh') await recover(true);
    else if (name === 'close-dialog') closeForm();
    else if (name === 'new-project') openForm({ kind: 'project.create', values: { name: '', root: '' } });
    else if (name === 'create-charter') { await act('charter.create', { projectRef: ref, expectedRevision: p.revision }); toast('总纲任务已创建'); }
    else if (name === 'copy-charter') await copy('bc-charter', ref, ' continue');
    else if (name === 'copy-plan') await copy('bc-plan', ref);
    else if (name === 'copy-develop') await copy('bc-develop', ref);
    else if (name === 'copy-review') await copy('bc-review', ref);
    else if (name === 'copy-batch') await copy('bc-project-review', ref);
    else if (name === 'rebase-charter') { if (confirm('已核对最新保存内容，保留你的草稿继续编辑？')) { view.drafts['charter:' + ref].revision = t.revision; saveView(); render(); } }
    else if (name === 'save-charter') { const draftKey = 'charter:' + ref, submitted = { content: $('charter-editor').value, revision: view.drafts[draftKey]?.revision ?? t.revision }; const result = await act('charter.save', { taskRef: ref, content: submitted.content, expectedRevision: submitted.revision }); const latest = view.drafts[draftKey]; if (!latest || latest.content === submitted.content && latest.revision === submitted.revision) delete view.drafts[draftKey]; else if (latest.revision === submitted.revision) latest.revision = result.task.revision; saveView(); render(); toast('草稿已保存'); }
    else if (name === 'submit-charter') { await act('charter.submit', { taskRef: ref, expectedRevision: t.revision }); toast('总纲已提交确认'); }
    else if (name === 'confirm-charter') { await act('charter.confirm', { taskRef: ref, version: charterFor(ref)?.version, expectedRevision: t.revision }); toast('总纲版本已确认'); }
    else if (name === 'new-task') taskForm();
    else if (name === 'edit-task') taskForm(t);
    else if (name === 'rebase-dialog' && view.dialogDraft) { const current = dialogEntity(view.dialogDraft); if (current && confirm('已核对当前保存内容，保留你的输入继续编辑？')) { view.dialogDraft.expectedRevision = current.revision; openForm(view.dialogDraft); } }
    else if (name === 'rebase-note' && view.drafts['note:' + ref] && confirm('已核对当前任务成果和验收记录，保留说明继续验收？')) { view.drafts['note:' + ref].revision = t.revision; saveView(); render(); }
    else if (name === 'revoke') { if (confirm('请先停止原工具中的执行。结束当前执行并允许重新领取？')) { await act('task.revoke', { taskRef: ref, expectedRevision: t.revision }); toast('当前执行已结束'); } }
    else if (name === 'human-pass' || name === 'human-fail') { const note = $('review-note').value.trim(); if (name === 'human-fail' && !note) throw Error('请填写退回原因'); await act('task.humanReview', { taskRef: ref, expectedRevision: view.drafts['note:' + ref]?.revision ?? t.revision, passed: name === 'human-pass', note: note || '人工验收通过' }); toast(name === 'human-pass' ? '人工验收已通过' : '任务已退回修改'); }
    else if (name === 'start-batch') { await act('batch.start', { projectRef: ref, expectedRevision: p.revision }); toast('项目验收批次已创建'); }
    else if (name === 'confirm-batch') { const batch = data.batches.find(item => item.ref === ref); await act('batch.confirm', { batchRef: ref, expectedRevision: batch.revision }); toast('项目验收已确认'); }
    else if (name === 'new-issue') openForm({ kind: 'issue.create', projectRef: p.ref, expectedRevision: p.revision, values: { title: '', description: '' } });
    else if (name === 'repair-issue') { const issue = data.issues.find(item => item.ref === ref); const result = await act('issue.repair', { issueRef: ref, expectedRevision: issue.revision }); toast('修复任务已创建：' + result.task.ref); }
    else if (name === 'retest-issue' || name === 'retest-fail') { const issue = data.issues.find(item => item.ref === ref); openForm({ kind: 'issue.retest', ref, projectRef: p.ref, expectedRevision: issue.revision, passed: name === 'retest-issue', values: { note: '' } }); }
  }
  document.addEventListener('click', event => { const target = event.target.closest('[data-action]'); if (!target || target.disabled) return; action(target.dataset.action, target.dataset.ref).catch(error => toast(error.message || '操作未完成，请重试')); });
  document.addEventListener('input', event => { const node = event.target; if (node.name && node.closest('#dialog-fields') && view.dialogDraft) { view.dialogDraft.values[node.name] = node.value; saveView(); } else if (node.dataset.draft) { view.drafts[node.dataset.draft] = { content: node.value, revision: Number(node.dataset.revision) }; saveView(); } else if (node.id === 'task-search') { view.search = node.value; render(); } });
  document.addEventListener('change', event => { if (event.target.id === 'task-filter') { view.filter = event.target.value; render(); } else if (event.target.id === 'tool') { view.tool = event.target.value; saveView(); } });
  $('form-dialog').addEventListener('cancel', event => { event.preventDefault(); closeForm(); });
  $('dialog-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!modal || busy) return; $('dialog-submit').disabled = true;
    const submitted = modal, values = Object.fromEntries(new FormData(event.target)); submitted.values = { ...values }; saveView();
    try {
      const result = await submitDialog(submitted, values);
      if (view.dialogDraft === submitted && JSON.stringify(submitted.values) === JSON.stringify(values)) { closeForm(); toast('已保存'); }
      else if (view.dialogDraft === submitted) {
        const entity = submitted.kind === 'issue.create' ? result.project : result.task || result.issue || result.project;
        if (entity) { submitted.expectedRevision = entity.revision; if (submitted.kind === 'task.create') { submitted.kind = 'task.update'; submitted.ref = entity.ref; } }
        saveView(); toast('已保存，后续输入已保留。');
      }
    } catch (error) {
      if (error.code === 'revision_conflict') { await refresh().catch(() => {}); if (view.dialogDraft === submitted) openForm(submitted); }
      $('dialog-error').textContent = error.message || '保存未完成，请重试';
    } finally { $('dialog-submit').disabled = false; }
  });
  function connect() {
    stream?.close(); stream = new EventSource('/api/workflow/v1/events?cursor=' + data.cursor);
    stream.addEventListener('open', async () => { try { if (!await ensureSession(true)) return; $('connection').textContent = '实时同步'; $('connection').classList.add('online'); await refresh(); } catch (error) { toast(error.message); } });
    stream.addEventListener('change', () => { void refresh().catch(error => toast(error.message)); });
    stream.addEventListener('error', () => { $('connection').textContent = '正在重连'; $('connection').classList.remove('online'); void ensureSession(true).catch(() => {}); });
  }
  function recover(force = false) {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => { if (!await ensureSession(force)) return; await refresh(); if (!stream) connect(); })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  }
  function reconnect() { void recover(true).catch(error => { if (!hasState) $('content').innerHTML = empty('面板尚未连接', error.message || '请点击刷新重试。'); if (error.status !== 401) { $('connection').textContent = '等待重连'; $('connection').classList.remove('online'); } }); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnect(); });
  window.addEventListener('online', reconnect);
  window.addEventListener('beforeunload', saveView);
  $('content').innerHTML = empty('正在加载面板', '请稍候'); reconnect();
})();

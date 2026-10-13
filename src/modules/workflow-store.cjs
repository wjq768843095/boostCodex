'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

class WorkflowError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'WorkflowError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new WorkflowError(code, status); };
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])]));
  return value;
}
function text(value, name, maximum = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail('invalid_' + name);
  return value.trim();
}
function scopes(value = []) {
  if (!Array.isArray(value) || value.length > 100) fail('invalid_scope_paths');
  return [...new Set(value.map(item => {
    const normalized = text(item, 'scope_path', 2048).replace(/\\/g, '/').replace(/\/$/, '');
    if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.' || !part)) fail('invalid_scope_path');
    return normalized;
  }))].sort();
}
const excluded = file => file.split('/').some(part => /^(?:\.git|node_modules|vendor|dist|build|coverage|\.dev|\.next|\.nuxt|unpackage|logs?|tmp|temp|backups?|\.agents|\.claude|\.codex|\.better-codex(?:-dev)?|\.ssh)$/i.test(part)) || /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|prompt-optimizer-settings\.json|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|token|[^/]+\.(?:pem|key|p12|pfx|db|sqlite|sqlite3|log))$/i.test(file);
function git(root, args) {
  try { return cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function fingerprint(root, selected = []) {
  let real;
  try { real = fs.realpathSync(root); if (!fs.statSync(real).isDirectory()) fail('project_root_unavailable', 409); }
  catch (error) { if (error instanceof WorkflowError) throw error; fail('project_root_unavailable', 409); }
  const scopePaths = scopes(selected);
  const listed = git(real, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  let files = [];
  if (listed !== null) files = listed.split('\0').filter(Boolean);
  else {
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = prefix + entry.name;
        if (excluded(file)) continue;
        if (entry.isSymbolicLink()) fail('source_symlink_not_supported', 409);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), file + '/');
        else if (entry.isFile()) files.push(file);
      }
    };
    walk(real);
  }
  files = [...new Set(files.map(file => file.replace(/\\/g, '/')))].filter(file => !excluded(file) && (!scopePaths.length || scopePaths.some(scope => file === scope || file.startsWith(scope + '/')))).sort();
  if (files.length > 50000) fail('source_inventory_too_large', 409);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  for (const file of files) {
    const absolute = path.resolve(real, file);
    if (!absolute.startsWith(real + path.sep)) fail('source_path_invalid', 409);
    hash.update(file).update('\0');
    let descriptor;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) fail('source_symlink_not_supported', 409);
      if (!fs.realpathSync(absolute).startsWith(real + path.sep)) fail('source_path_invalid', 409);
      descriptor = fs.openSync(absolute, 'r');
      const contentHash = crypto.createHash('sha256');
      let length;
      while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) contentHash.update(buffer.subarray(0, length));
      hash.update(contentHash.digest('hex')).update('\0');
    } catch (error) {
      if (error?.code === 'ENOENT') hash.update('deleted\0');
      else if (error instanceof WorkflowError) throw error;
      else fail('source_read_failed', 409);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  const head = git(real, ['rev-parse', '--verify', 'HEAD'])?.trim() || null;
  const dirty = git(real, ['status', '--porcelain', '--untracked-files=normal']);
  return { hash: hash.digest('hex'), head, dirty: dirty === null ? null : !!dirty.trim(), files: files.length, scopePaths };
}

const collections = ['projects', 'tasks', 'charters', 'reviews', 'batches', 'issues', 'executions'];
const humanOnly = new Set(['project.create', 'charter.confirm', 'task.create', 'task.update', 'task.revoke', 'task.humanReview', 'batch.confirm', 'issue.retest']);
const agentOnly = new Set(['task.claim', 'task.renew', 'task.submit', 'task.review']);
class WorkflowStore {
  constructor({ home, now = () => Date.now() }) {
    if (!home) fail('invalid_home');
    fs.mkdirSync(home, { recursive: true });
    this.now = now;
    this.db = new DatabaseSync(path.join(home, 'workflow-v1.db'));
    const schemaVersion = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (schemaVersion > 1) { this.db.close(); fail('workflow_schema_newer_than_runtime', 409); }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflow_entities (collection TEXT NOT NULL, ref TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,ref));
      CREATE TABLE IF NOT EXISTS workflow_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, operation TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_requests (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  _load() {
    const state = Object.fromEntries(collections.map(key => [key, []]));
    for (const row of this.db.prepare('SELECT collection,data FROM workflow_entities ORDER BY rowid').all()) state[row.collection].push(JSON.parse(row.data));
    state.cursor = Number(this.db.prepare('SELECT coalesce(max(id),0) cursor FROM workflow_events').get().cursor);
    return state;
  }
  state() {
    const state = this._load();
    state.executions = state.executions.map(({ tokenHash, ...execution }) => ({ ...execution, status: execution.status === 'active' && Date.parse(execution.expiresAt) <= this.now() ? 'expired' : execution.status }));
    return state;
  }
  context({ projectRef, taskRef, batchRef } = {}) {
    const state = this.state();
    if (taskRef) { const task = state.tasks.find(item => item.ref === taskRef); if (!task) fail('task_not_found', 404); if (projectRef && projectRef !== task.projectRef) fail('project_task_mismatch', 409); projectRef = task.projectRef; }
    if (batchRef) { const batch = state.batches.find(item => item.ref === batchRef); if (!batch) fail('batch_not_found', 404); if (projectRef && projectRef !== batch.projectRef) fail('project_batch_mismatch', 409); projectRef = batch.projectRef; }
    if (!projectRef) return { projects: state.projects, cursor: state.cursor };
    const project = state.projects.find(item => item.ref === projectRef); if (!project) fail('project_not_found', 404);
    let finalAcceptance = null;
    if (project.finalBatchRef) {
      const finalBatch = state.batches.find(item => item.ref === project.finalBatchRef);
      const currentTasks = state.tasks.filter(item => item.projectRef === projectRef && item.type !== 'charter');
      let reason = null;
      if (!finalBatch || finalBatch.status !== 'confirmed' || !finalBatch.report?.passed) reason = 'passing_batch_report_required';
      else if (finalBatch.charterVersion !== project.confirmedCharterVersion) reason = 'batch_baseline_outdated';
      else if (currentTasks.length !== finalBatch.taskSet.length || finalBatch.taskSet.some(entry => { const task = currentTasks.find(item => item.ref === entry.taskRef); return !task || task.revision !== entry.revision || task.status !== 'completed'; })) reason = 'batch_task_set_changed';
      else if (state.issues.some(item => item.projectRef === projectRef && item.status !== 'closed' && item.severity !== 'informational')) reason = 'blocking_issues_open';
      else {
        try { const actual = fingerprint(project.root); if (actual.hash !== finalBatch.baseline.hash || actual.head !== finalBatch.baseline.head) reason = 'source_baseline_changed'; }
        catch (error) { reason = error instanceof WorkflowError ? error.code : 'source_read_failed'; }
      }
      finalAcceptance = { current: reason === null, reason, batchRef: project.finalBatchRef };
    }
    return { project, tasks: state.tasks.filter(item => item.projectRef === projectRef), charters: state.charters.filter(item => item.projectRef === projectRef), reviews: state.reviews.filter(item => item.projectRef === projectRef), batches: state.batches.filter(item => item.projectRef === projectRef), issues: state.issues.filter(item => item.projectRef === projectRef), executions: state.executions.filter(item => item.projectRef === projectRef), task: state.tasks.find(item => item.ref === taskRef) || null, batch: state.batches.find(item => item.ref === batchRef) || null, finalAcceptance, cursor: state.cursor };
  }
  eventsAfter(cursor = 0) {
    if (!Number.isSafeInteger(Number(cursor)) || Number(cursor) < 0) fail('invalid_cursor');
    return this.db.prepare('SELECT * FROM workflow_events WHERE id>? ORDER BY id LIMIT 1000').all(Number(cursor)).map(row => ({ id: Number(row.id), at: row.at, operation: row.operation, ...JSON.parse(row.data) }));
  }
  close() { this.db.close(); }
  execute(operation, input = {}, actor = {}) {
    if (!['human', 'agent'].includes(actor.role)) fail('unauthorized', 401);
    if (humanOnly.has(operation) && actor.role !== 'human' || agentOnly.has(operation) && actor.role !== 'agent') fail('role_forbidden', 403);
    const requestId = text(input.requestId, 'request_id', 200);
    const digest = crypto.createHash('sha256').update(stable({ operation, input, actor: { role: actor.role, client: actor.client || null } })).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT digest,result FROM workflow_requests WHERE request_id=?').get(requestId);
      if (previous) { if (previous.digest !== digest) fail('request_id_conflict', 409); this.db.exec('COMMIT'); return JSON.parse(previous.result); }
      const state = this._load();
      const before = new Map(collections.flatMap(collection => state[collection].map(entity => [collection + ':' + entity.ref, stable(entity)])));
      const result = this._mutate(state, operation, input, actor);
      const save = this.db.prepare('INSERT INTO workflow_entities(collection,ref,data) VALUES(?,?,?) ON CONFLICT(collection,ref) DO UPDATE SET data=excluded.data');
      const changed = [];
      for (const collection of collections) for (const entity of state[collection]) if (before.get(collection + ':' + entity.ref) !== stable(entity)) { save.run(collection, entity.ref, JSON.stringify(entity)); changed.push({ collection, ref: entity.ref, revision: entity.revision }); }
      this.db.prepare('INSERT INTO workflow_events(at,operation,data) VALUES(?,?,?)').run(new Date(this.now()).toISOString(), operation, JSON.stringify({ actor: { role: actor.role, client: actor.client || null }, changed, requestId }));
      this.db.prepare('INSERT INTO workflow_requests(request_id,digest,result) VALUES(?,?,?)').run(requestId, digest, JSON.stringify(result));
      this.db.exec('COMMIT');
      return clone(result);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  _mutate(state, op, input, actor) {
    const now = this.now(), at = new Date(now).toISOString();
    const get = (collection, ref) => { const entity = state[collection].find(item => item.ref === ref); if (!entity) fail(collection.slice(0, -1) + '_not_found', 404); return entity; };
    const revision = entity => { if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== entity.revision) fail('revision_conflict', 409); };
    const bump = entity => { entity.revision++; entity.updatedAt = at; };
    const project = ref => get('projects', ref);
    const overlaps = (a, b) => { const left = a.toLowerCase(), right = b.toLowerCase(); return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep); };
    const active = projectRef => state.executions.find(item => overlaps(project(item.projectRef).root, project(projectRef).root) && item.status === 'active' && Date.parse(item.expiresAt) > now);
    const idle = projectRef => { if (active(projectRef)) fail('project_execution_busy', 409); };
    const source = task => fingerprint(project(task.projectRef).root, task.scopePaths || []);
    const currentBaseline = (baseline, actual) => { if (!baseline || baseline.hash !== actual.hash || baseline.head !== actual.head) fail('source_baseline_changed', 409); };
    const next = (collection, prefix) => prefix + String(state[collection].filter(item => item.ref.startsWith(prefix)).reduce((max, item) => Math.max(max, Number(item.ref.slice(prefix.length)) || 0), 0) + 1).padStart(3, '0');
    const lease = (task, phase) => {
      const execution = get('executions', input.executionId);
      const received = crypto.createHash('sha256').update(String(input.leaseToken || '')).digest('hex');
      if (execution.taskRef !== task.ref || execution.status !== 'active' || Date.parse(execution.expiresAt) <= now || execution.tokenHash !== received || execution.client !== (actor.client || null) || phase && execution.phase !== phase) fail('execution_lease_invalid', 409);
      return execution;
    };
    const finish = execution => { execution.status = 'finished'; execution.endedAt = at; bump(execution); };
    const evidence = passed => {
      if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 100) fail('evidence_required');
      const items = input.evidence.map(item => ({ kind: text(item.kind, 'evidence_kind', 100), result: text(item.result, 'evidence_result', 100), detail: text(item.detail, 'evidence_detail', 20000) }));
      if (passed && (!items.some(item => /^(passed|pass|通过)$/i.test(item.result)) || items.some(item => /^(failed|fail|not_run|blocked|未测|未执行|失败)$/i.test(item.result)))) fail('passing_evidence_required');
      return items;
    };
    const confirmed = (p, version = p.confirmedCharterVersion) => { const charter = state.charters.find(item => item.projectRef === p.ref && item.version === version && item.status === 'confirmed'); if (!charter || version !== p.confirmedCharterVersion) fail('confirmed_charter_required', 409); return charter; };
    const addTask = (p, data, type = 'development') => {
      confirmed(p);
      const task = { ref: next('tasks', p.ref + '-T'), projectRef: p.ref, type, title: text(data.title, 'title', 500), requirements: text(data.requirements, 'requirements'), acceptance: text(data.acceptance, 'acceptance'), scopePaths: scopes(data.scopePaths), status: 'pending', revision: 1, contentRevision: 1, charterVersion: p.confirmedCharterVersion, createdAt: at, updatedAt: at };
      state.tasks.push(task); return task;
    };
    const addIssue = (p, data) => {
      if (data.taskRef && get('tasks', data.taskRef).projectRef !== p.ref || data.batchRef && get('batches', data.batchRef).projectRef !== p.ref) fail('issue_project_mismatch', 409);
      const issue = { ref: next('issues', p.ref + '-I'), projectRef: p.ref, taskRef: data.taskRef || null, batchRef: data.batchRef || null, title: text(data.title, 'title', 500), description: text(data.description, 'description'), severity: data.severity || 'blocking', status: 'open', repairTaskRefs: [], revision: 1, createdAt: at, updatedAt: at };
      state.issues.push(issue); return issue;
    };
    if (op === 'project.create') {
      const root = text(input.root, 'root', 4096); let real;
      try { real = fs.realpathSync(root); if (!fs.statSync(real).isDirectory()) fail('invalid_project_root'); } catch { fail('invalid_project_root'); }
      if (state.projects.some(item => item.root.toLowerCase() === real.toLowerCase())) fail('project_root_registered', 409);
      const p = { ref: next('projects', 'P'), name: text(input.name, 'name', 500), root: real, revision: 1, status: 'active', createdAt: at, updatedAt: at }; state.projects.push(p); return { project: p };
    }
    if (op === 'charter.create') {
      const p = project(input.projectRef); revision(p); idle(p.ref);
      if (state.charters.some(item => item.projectRef === p.ref && item.status !== 'confirmed')) fail('charter_draft_exists', 409);
      const version = Math.max(0, ...state.charters.filter(item => item.projectRef === p.ref).map(item => item.version)) + 1;
      const task = { ref: next('tasks', p.ref + '-T'), projectRef: p.ref, type: 'charter', title: '项目总纲', requirements: '编写项目总纲', acceptance: '人工确认总纲', scopePaths: [], status: 'draft', revision: 1, contentRevision: 1, charterVersion: version, createdAt: at, updatedAt: at };
      const charter = { ref: p.ref + '-C' + String(version).padStart(3, '0'), projectRef: p.ref, taskRef: task.ref, version, content: '', status: 'draft', revision: 1, createdAt: at, updatedAt: at }; state.tasks.push(task); state.charters.push(charter); bump(p); return { task, charter };
    }
    if (['charter.save', 'charter.submit', 'charter.confirm'].includes(op)) {
      const task = get('tasks', input.taskRef); revision(task);
      if (task.type !== 'charter') fail('charter_task_required');
      const charter = state.charters.find(item => item.taskRef === task.ref); const p = project(task.projectRef);
      if (charter.status === 'confirmed') fail('charter_already_confirmed', 409);
      if (op === 'charter.confirm') {
        idle(p.ref); if (charter.status !== 'submitted' || input.version !== charter.version) fail('charter_confirmation_invalid', 409);
        charter.status = 'confirmed'; task.status = 'completed'; p.confirmedCharterVersion = charter.version; p.status = 'active'; bump(p);
      } else {
        const execution = actor.role === 'human' ? (idle(p.ref), null) : lease(task, 'charter');
        if (op === 'charter.save') { charter.content = text(input.content, 'content'); charter.status = 'draft'; task.status = 'draft'; task.contentRevision++; }
        else { text(charter.content, 'content'); charter.status = 'submitted'; task.status = 'awaiting_confirmation'; if (execution) finish(execution); }
      }
      bump(charter); bump(task); return { task, charter, project: p };
    }
    if (op === 'plan.tasks' || op === 'task.create') {
      const p = project(input.projectRef); revision(p); idle(p.ref); confirmed(p, input.charterVersion || p.confirmedCharterVersion);
      if (op === 'task.create') { const task = addTask(p, input); p.status = 'active'; bump(p); return { task, project: p }; }
      if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 200) fail('invalid_tasks');
      const tasks = input.tasks.map(item => addTask(p, item)); p.status = 'active'; bump(p); return { tasks, project: p };
    }
    if (op.startsWith('task.')) {
      const task = get('tasks', input.taskRef), p = project(task.projectRef); revision(task);
      if (op === 'task.claim') {
        idle(p.ref);
        const phase = input.phase;
        if (!['charter', 'develop', 'review'].includes(phase)) fail('invalid_execution_phase');
        if (phase === 'charter' ? task.type !== 'charter' || !['draft'].includes(task.status) : task.type === 'charter' || (phase === 'review' ? task.status !== 'ai_review' : !['pending', 'in_progress'].includes(task.status))) fail('task_phase_invalid', 409);
        if (phase !== 'charter') confirmed(p, task.charterVersion);
        if (phase === 'review') currentBaseline(task.result?.baseline, source(task));
        for (const execution of state.executions) if (execution.projectRef === p.ref && execution.status === 'active') { execution.status = 'expired'; bump(execution); }
        const leaseToken = crypto.randomBytes(32).toString('hex'), executionId = crypto.randomUUID();
        const execution = { ref: executionId, executionId, taskRef: task.ref, projectRef: p.ref, phase, client: actor.client || null, status: 'active', revision: 1, tokenHash: crypto.createHash('sha256').update(leaseToken).digest('hex'), startedAt: at, expiresAt: new Date(now + 30 * 60000).toISOString() };
        state.executions.push(execution); if (phase === 'develop') task.status = 'in_progress'; bump(task);
        return { executionId, leaseToken, task, expiresAt: execution.expiresAt };
      }
      if (op === 'task.renew') { const execution = lease(task); execution.expiresAt = new Date(now + 30 * 60000).toISOString(); bump(execution); return { task, executionId: execution.ref, expiresAt: execution.expiresAt }; }
      if (op === 'task.revoke') {
        for (const execution of state.executions) if (execution.taskRef === task.ref && execution.status === 'active') { execution.status = 'revoked'; execution.endedAt = at; bump(execution); }
        if (task.status === 'in_progress') task.status = 'pending'; bump(task); return { task };
      }
      if (op === 'task.update') {
        idle(p.ref); if (task.type === 'charter') fail('use_charter_save');
        confirmed(p);
        for (const field of ['title', 'requirements', 'acceptance']) if (input[field] !== undefined) task[field] = text(input[field], field, field === 'title' ? 500 : 100000);
        if (input.scopePaths !== undefined) task.scopePaths = scopes(input.scopePaths);
        task.contentRevision++; task.charterVersion = p.confirmedCharterVersion; task.status = 'pending'; delete task.result; delete task.currentReviewRef; delete task.humanReviewRef; p.status = 'active'; bump(p); bump(task); return { task };
      }
      if (op === 'task.submit') {
        const execution = lease(task, 'develop'); if (task.status !== 'in_progress') fail('task_phase_invalid', 409);
        task.result = { summary: text(input.summary, 'summary'), evidence: evidence(false), baseline: source(task), contentRevision: task.contentRevision, executionId: execution.ref, submittedAt: at }; task.status = 'ai_review'; finish(execution); bump(task); return { task };
      }
      if (op === 'task.review') {
        const execution = lease(task, 'review'); if (task.status !== 'ai_review' || typeof input.passed !== 'boolean') fail('task_phase_invalid', 409);
        if (execution.ref === task.result?.executionId) fail('independent_review_execution_required', 409);
        currentBaseline(task.result?.baseline, source(task));
        const review = { ref: crypto.randomUUID(), projectRef: p.ref, taskRef: task.ref, kind: 'ai', passed: input.passed, summary: text(input.summary, 'summary'), evidence: evidence(input.passed), contentRevision: task.contentRevision, baseline: task.result.baseline, executionId: execution.ref, at };
        state.reviews.push(review); task.currentReviewRef = review.ref; task.status = input.passed ? 'human_review' : 'pending'; finish(execution); bump(task); return { task, review };
      }
      if (op === 'task.humanReview') {
        idle(p.ref); if (task.status !== 'human_review' || typeof input.passed !== 'boolean') fail('task_phase_invalid', 409);
        const ai = state.reviews.find(item => item.ref === task.currentReviewRef);
        if (!ai?.passed || ai.contentRevision !== task.contentRevision) fail('current_ai_review_required', 409);
        currentBaseline(ai.baseline, source(task));
        const review = { ref: crypto.randomUUID(), projectRef: p.ref, taskRef: task.ref, kind: 'human', passed: input.passed, note: text(input.note, 'note'), contentRevision: task.contentRevision, baseline: ai.baseline, at }; state.reviews.push(review); task.humanReviewRef = review.ref; task.status = input.passed ? 'completed' : 'pending'; bump(task); return { task, review };
      }
    }
    if (op === 'batch.start') {
      const p = project(input.projectRef); revision(p); idle(p.ref); confirmed(p);
      const tasks = state.tasks.filter(item => item.projectRef === p.ref && item.type !== 'charter');
      if (!tasks.length || tasks.some(item => item.status !== 'completed' || item.charterVersion !== p.confirmedCharterVersion || !state.reviews.some(review => review.ref === item.humanReviewRef && review.passed && review.contentRevision === item.contentRevision))) fail('project_tasks_incomplete', 409);
      const batch = { ref: next('batches', p.ref + '-A'), projectRef: p.ref, charterVersion: p.confirmedCharterVersion, taskSet: tasks.map(task => ({ taskRef: task.ref, revision: task.revision, contentRevision: task.contentRevision })), baseline: fingerprint(p.root), status: 'reviewing', revision: 1, createdAt: at, updatedAt: at }; state.batches.push(batch); bump(p); return { batch, project: p };
    }
    if (op === 'batch.report' || op === 'batch.confirm') {
      const batch = get('batches', input.batchRef), p = project(batch.projectRef); revision(batch); idle(p.ref);
      if (batch.status === 'confirmed') fail('batch_already_confirmed', 409);
      if (batch.charterVersion !== p.confirmedCharterVersion) fail('batch_baseline_outdated', 409);
      const tasks = state.tasks.filter(item => item.projectRef === p.ref && item.type !== 'charter');
      if (tasks.length !== batch.taskSet.length || batch.taskSet.some(entry => { const task = tasks.find(item => item.ref === entry.taskRef); return !task || task.revision !== entry.revision || task.status !== 'completed'; })) fail('batch_task_set_changed', 409);
      currentBaseline(batch.baseline, fingerprint(p.root));
      if (op === 'batch.report') {
        if (typeof input.passed !== 'boolean') fail('invalid_passed');
        if (!Array.isArray(input.issues || []) || (input.issues || []).length > 200) fail('invalid_issues');
        const issues = (input.issues || []).map(item => addIssue(p, { ...item, batchRef: batch.ref }));
        batch.report = { passed: input.passed && !issues.some(item => item.severity !== 'informational'), summary: text(input.summary, 'summary'), evidence: evidence(input.passed), role: actor.role, at }; batch.status = batch.report.passed ? 'awaiting_confirmation' : 'failed'; bump(batch); return { batch, issues };
      }
      if (!batch.report?.passed || batch.status !== 'awaiting_confirmation') fail('passing_batch_report_required', 409);
      if (state.batches.filter(item => item.projectRef === p.ref).at(-1)?.ref !== batch.ref) fail('latest_batch_required', 409);
      if (state.issues.some(item => item.projectRef === p.ref && item.status !== 'closed' && item.severity !== 'informational')) fail('blocking_issues_open', 409);
      batch.status = 'confirmed'; batch.confirmedAt = at; p.status = 'completed'; p.finalBatchRef = batch.ref; bump(batch); bump(p); return { batch, project: p };
    }
    if (op === 'issue.create') { const p = project(input.projectRef); revision(p); const issue = addIssue(p, input); p.status = 'active'; bump(p); return { issue, project: p }; }
    if (op === 'issue.repair' || op === 'issue.retest') {
      const issue = get('issues', input.issueRef), p = project(issue.projectRef); revision(issue); idle(p.ref);
      if (issue.status === 'closed') fail('issue_already_closed', 409);
      if (op === 'issue.repair') {
        if (issue.repairTaskRefs.some(ref => get('tasks', ref).status !== 'completed')) fail('repair_task_active', 409);
        const task = addTask(p, { title: '修复：' + issue.title, requirements: issue.description, acceptance: '问题复验通过：' + issue.title, scopePaths: issue.taskRef ? get('tasks', issue.taskRef).scopePaths : [] }, 'repair'); task.issueRef = issue.ref; issue.repairTaskRefs.push(task.ref); issue.status = 'repairing'; p.status = 'active'; bump(p); bump(issue); return { issue, task };
      }
      if (typeof input.passed !== 'boolean' || !issue.repairTaskRefs.length) fail('repair_required', 409);
      const tasks = issue.repairTaskRefs.map(ref => get('tasks', ref));
      if (tasks.some(task => task.status !== 'completed')) fail('repair_incomplete', 409);
      const latest = tasks.at(-1); currentBaseline(latest.result?.baseline, source(latest));
      issue.retest = { passed: input.passed, note: text(input.note, 'note'), baseline: source(latest), at }; issue.status = input.passed ? 'closed' : 'open'; bump(issue); return { issue };
    }
    fail('operation_not_found', 404);
  }
}
module.exports = { WorkflowStore, WorkflowError, fingerprint };

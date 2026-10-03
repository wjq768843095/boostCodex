'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { nativeTools } = require('./project-mcp.cjs');

const ACTIVE = "'prepared','allocated','bound','outcome_unknown'";
function ensureConversationTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_conversation_operations (
    request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('charter','planning','work')), issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
    scope_key TEXT NOT NULL, relay_id TEXT NOT NULL, host_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    thread_id TEXT, turn_id TEXT, status TEXT NOT NULL CHECK(status IN ('prepared','allocated','bound','accepted','failed','outcome_unknown')),
    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS native_conversation_one_operation ON native_conversation_operations(scope_key) WHERE status IN (${ACTIVE});
  CREATE TABLE IF NOT EXISTS native_conversation_bindings (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('charter','planning','work')), issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
    host_id TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL, archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS native_conversation_history (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, issue_id TEXT, thread_id TEXT NOT NULL, binding_json TEXT NOT NULL, archived_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS native_conversation_scopes (
    scope_key TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS native_conversation_tool_calls (
    call_id TEXT PRIMARY KEY, relay_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    name TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL
  );`);
}

function createNativeConversationRuntime({ store, planning, home, context, invokeTool, onProjectEvent = () => {}, publishChange = () => {}, recover = true }) {
  const db = store.db, now = () => new Date().toISOString();
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const text = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) fail('invalid_' + name); return value.trim(); };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const transaction = action => { db.exec('BEGIN IMMEDIATE'); try { const value = action(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  ensureConversationTables(db);
  // No automatic replay after a process/transport interruption, even before allocation.
  if (recover) db.prepare(`UPDATE native_conversation_operations SET status='outcome_unknown',error='runtime_restarted',updated_at=? WHERE status IN ('prepared','allocated','bound')`).run(now());
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const issueSession = issueId => hasTable('issue_sessions') ? db.prepare('SELECT * FROM issue_sessions WHERE issue_id=?').get(issueId) || null : null;
  const nativeOwned = issue => Boolean(issue.session_handoff_at || db.prepare('SELECT 1 FROM issue_native_ownership WHERE issue_id=?').get(issue.id));
  const pending = scope => db.prepare(`SELECT * FROM native_conversation_operations WHERE scope_key=? AND status IN (${ACTIVE})`).get(scope) || null;
  const operation = requestId => db.prepare('SELECT * FROM native_conversation_operations WHERE request_id=?').get(requestId) || null;
  function recoverRelay(relayId) {
    return db.prepare("UPDATE native_conversation_operations SET status='outcome_unknown',error='native_host_disconnected',updated_at=? WHERE relay_id=? AND status IN ('prepared','allocated','bound')").run(now(),relayId).changes;
  }
  function recoverStale() {
    // Operations must finish within the adapter's bounded RPC timeout. A lost
    // receipt can stop blocking reload without relinquishing the issue reservation.
    const cutoff = new Date(Date.now() - 120000).toISOString();
    return db.prepare("UPDATE native_conversation_operations SET status='outcome_unknown',error='native_operation_timeout',updated_at=? WHERE updated_at<? AND status IN ('prepared','allocated','bound')").run(now(),cutoff).changes;
  }
  function target(args) {
    const projectId = text(args.project_id, 'project_id');
    const project = store.getProject(projectId); if (!project) fail('project_not_found');
    if (!['charter','planning','work'].includes(args.kind)) fail('invalid_session_kind');
    const issue = args.kind === 'work' ? store.getIssue(text(args.issue_id, 'issue_id')) : null;
    if (args.kind === 'work' && (!issue || issue.project_id !== projectId)) fail('issue_project_mismatch');
    if (issue?.archived_at) fail('issue_archived');
    return { project, issue, kind: args.kind, scope_key: args.kind === 'work' ? 'work:' + issue.id : projectId + ':' + args.kind };
  }
  function busyIssue(issue, allowOperationId) {
    if (!issue) return false;
    const session = issueSession(issue.id);
    const busy = issue.active_run_status || issue.session_active_turn_id || session?.active_turn_id ||
      ['starting','active','stopping','waiting_on_approval','waiting_on_user'].includes(session?.status) ||
      (hasTable('issue_runs') && db.prepare("SELECT 1 FROM issue_runs WHERE issue_id=? AND status IN ('claimed','running','scheduling')").get(issue.id)) ||
      (hasTable('issue_replies') && db.prepare("SELECT 1 FROM issue_replies WHERE issue_id=? AND status='running'").get(issue.id)) ||
      (hasTable('session_commands') && db.prepare("SELECT 1 FROM session_commands WHERE issue_id=? AND status IN ('pending','claimed')").get(issue.id));
    const reserved = pending('work:' + issue.id);
    return Boolean(busy || reserved && reserved.request_id !== allowOperationId);
  }
  function bindingFor(value) {
    if (value.kind !== 'work') return planning.getSession(value.project.id, value.kind);
    return issueSession(value.issue.id);
  }
  function readContext(args) {
    recoverStale();
    const value = target(args), binding = bindingFor(value), currentOperation = pending(value.scope_key);
    const owned = !value.issue || nativeOwned(value.issue) || !(binding || value.issue.run_thread_id), busy = busyIssue(value.issue);
    const expectedRevision = value.issue ? value.issue.version : binding?.revision || 0;
    const metadata = binding?.thread_id && db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(binding.thread_id);
    const details = context(value.project.id, { ...(binding?.thread_id ? { thread_id: binding.thread_id } : {}), ...(value.issue ? { issue_id: value.issue.id } : {}) });
    if (value.issue && !details.task) details.task = { ...value.issue };
    const draftGeneration = db.prepare('SELECT generation FROM native_conversation_scopes WHERE scope_key=?').get(value.scope_key)?.generation || 0;
    return { context: details, binding, pending_operation: currentOperation, expected_revision: expectedRevision, draft_generation: draftGeneration,
      native_project_id: value.project.external_id || '', workspace_path: value.issue?.workspace_path || value.project.workspace_path || '',
      cwd: value.issue?.workspace_path || value.project.workspace_path || '', root_paths: details.root_paths || value.project.root_paths || [],
      host_id: metadata?.host_id || binding?.host_id || 'local', thread_id: owned ? binding?.thread_id || null : null,
      mode: !owned ? (busy ? 'legacy_busy' : 'handoff_required') : binding ? 'thread' : 'draft',
      planning_available: planning.getCharter(value.project.id)?.status === 'confirmed', dynamic_tools: nativeTools };
  }
  function identity(args) {
    const relayId = text(args.relay_id, 'relay_id'), hostId = text(args.host_id, 'host_id'), requestId = text(args.request_id, 'request_id');
    if (!store.nativeSessionProxyIsLeader(relayId)) fail('session_relay_not_leader');
    return { relay_id: relayId, host_id: hostId, request_id: requestId };
  }
  function checkOperation(args) {
    const auth = identity(args), value = operation(auth.request_id); if (!value) fail('native_operation_not_found');
    if (value.relay_id !== auth.relay_id || value.host_id !== auth.host_id) fail('native_operation_identity_mismatch');
    if (args.expected_revision !== undefined && args.expected_revision !== value.expected_revision) fail('version_conflict');
    if (args.project_id !== undefined && args.project_id !== value.project_id || args.kind !== undefined && args.kind !== value.kind || args.issue_id !== undefined && args.issue_id !== value.issue_id) fail('native_operation_scope_mismatch');
    return value;
  }
  function prepare(args) {
    recoverStale();
    const value = target(args), auth = identity(args);
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) fail('invalid_expected_revision');
    const fingerprint = hash({ project_id: value.project.id, kind: value.kind, issue_id: value.issue?.id || null, host_id: auth.host_id, expected_revision: args.expected_revision, draft_generation: args.draft_generation });
    const result = transaction(() => {
      const existing = operation(auth.request_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.relay_id !== auth.relay_id) fail('request_id_conflict');
        if (existing.thread_id && db.prepare('SELECT 1 FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NOT NULL').get(existing.thread_id)) fail('native_operation_finished');
        return existing;
      }
      const previous = pending(value.scope_key); if (previous) fail(previous.status === 'outcome_unknown' ? 'native_outcome_unknown' : 'native_operation_busy');
      const binding = bindingFor(value), expected = value.issue ? value.issue.version : binding?.revision || 0;
      if (args.expected_revision !== expected) fail('version_conflict');
      const generation = db.prepare('SELECT generation FROM native_conversation_scopes WHERE scope_key=?').get(value.scope_key)?.generation || 0;
      if (args.draft_generation !== undefined && args.draft_generation !== generation) fail('version_conflict');
      const recorded = binding?.thread_id && db.prepare('SELECT host_id FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(binding.thread_id);
      if (binding && (recorded?.host_id || binding.host_id || 'local') !== auth.host_id) fail('native_host_mismatch');
      if (value.kind === 'planning' && planning.getCharter(value.project.id)?.status !== 'confirmed') fail('confirmed_charter_required');
      if (value.issue && !nativeOwned(value.issue) && (binding || value.issue.run_thread_id)) fail('native_handoff_required');
      if (busyIssue(value.issue)) fail('issue_execution_running');
      if (binding && ['running','active','starting','waiting_on_user','waiting_on_approval'].includes(binding.status)) fail('native_conversation_busy');
      const timestamp = now();
      db.prepare(`INSERT INTO native_conversation_operations(request_id,project_id,kind,issue_id,scope_key,relay_id,host_id,expected_revision,fingerprint,thread_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(auth.request_id,value.project.id,value.kind,value.issue?.id || null,value.scope_key,auth.relay_id,auth.host_id,args.expected_revision,fingerprint,binding?.thread_id || null,timestamp,timestamp);
      return operation(auth.request_id);
    });
    publishChange(); return { ...readContext(args), operation: result };
  }
  function bind(args) {
    const saved = checkOperation(args), threadId = text(args.thread_id, 'thread_id');
    if (!['allocated','bound'].includes(args.checkpoint)) fail('invalid_checkpoint');
    const result = transaction(() => {
      const op = operation(saved.request_id), value = target(op);
      if (op.status === 'failed') fail('native_operation_finished');
      if (op.thread_id && op.thread_id !== threadId) fail('session_thread_mismatch');
      if (op.status === 'accepted') return { operation: op, binding: bindingFor(value) };
      const elsewhere = db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=?').get(threadId);
      if (elsewhere && (elsewhere.project_id !== op.project_id || elsewhere.kind !== op.kind || elsewhere.issue_id !== op.issue_id || elsewhere.host_id !== op.host_id || elsewhere.archived_at)) fail('session_thread_mismatch');
      const projectOwner = db.prepare('SELECT project_id,kind FROM project_native_sessions WHERE thread_id=?').get(threadId);
      const workOwner = hasTable('issue_sessions') && db.prepare('SELECT issue_id,host_id FROM issue_sessions WHERE thread_id=?').get(threadId);
      if (projectOwner && (op.kind === 'work' || projectOwner.project_id !== op.project_id || projectOwner.kind !== op.kind) || workOwner && (op.kind !== 'work' || workOwner.issue_id !== op.issue_id || workOwner.host_id !== op.host_id)) fail('session_thread_mismatch');
      if (args.checkpoint === 'allocated') {
        if (!['bound','accepted'].includes(op.status)) db.prepare("UPDATE native_conversation_operations SET thread_id=?,status='allocated',error=NULL,updated_at=? WHERE request_id=?").run(threadId,now(),op.request_id);
        return { operation: operation(op.request_id), binding: bindingFor(value) };
      }
      if (!op.thread_id) fail('native_allocation_checkpoint_required');
      if (op.status !== 'bound') {
        const current = bindingFor(value);
        if (current && current.thread_id !== threadId) fail('session_thread_mismatch');
        if (value.issue) {
          if (value.issue.version !== op.expected_revision) fail('version_conflict');
          if (busyIssue(value.issue,op.request_id)) fail('issue_execution_running');
          const timestamp = now();
          db.prepare(`INSERT INTO issue_sessions(issue_id,host_id,thread_id,status,created_at,updated_at)
            VALUES(?,?,?,'idle',?,?) ON CONFLICT(issue_id) DO NOTHING`).run(value.issue.id,op.host_id,threadId,timestamp,timestamp);
          db.prepare("INSERT OR IGNORE INTO issue_native_ownership(issue_id,owner,created_at) VALUES(?,'native',?)").run(value.issue.id,timestamp);
        } else if (!current) planning.bindSession({project_id:op.project_id,kind:op.kind,thread_id:threadId,expected_revision:op.expected_revision});
        else if (current.revision !== op.expected_revision) fail('version_conflict');
        db.prepare('INSERT OR IGNORE INTO native_conversation_bindings(thread_id,project_id,kind,issue_id,host_id,request_id,created_at) VALUES(?,?,?,?,?,?,?)').run(threadId,op.project_id,op.kind,op.issue_id,op.host_id,op.request_id,now());
        db.prepare("UPDATE native_conversation_operations SET status='bound',error=NULL,updated_at=? WHERE request_id=?").run(now(),op.request_id);
      }
      return { operation: operation(op.request_id), binding: bindingFor(value) };
    });
    publishChange(); return result;
  }
  function receipt(args) {
    const saved = checkOperation(args);
    if (!['accepted','failed','outcome_unknown'].includes(args.status)) fail('invalid_receipt_status');
    if (args.thread_id && args.thread_id !== saved.thread_id) fail('session_thread_mismatch');
    if (saved.status === 'accepted') { if (args.status !== 'accepted' || args.turn_id !== saved.turn_id) fail('native_operation_finished'); return {operation:saved}; }
    if (args.status === 'accepted') {
      if (saved.status !== 'bound' && !(saved.status === 'outcome_unknown' && saved.thread_id && db.prepare('SELECT 1 FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(saved.thread_id))) fail('native_binding_required');
      text(args.turn_id,'turn_id');
      if (saved.kind === 'work' && store.sessionTurnStarted) store.sessionTurnStarted(saved.thread_id,args.turn_id);
      else if (saved.kind !== 'work') {
        const observed = hasTable('project_native_activity') && db.prepare('SELECT turn_id FROM project_native_activity WHERE thread_id=?').get(saved.thread_id);
        if (!observed || observed.turn_id !== args.turn_id) onProjectEvent('turn/started',{threadId:saved.thread_id,turn:{id:args.turn_id}});
      }
    }
    // A failed/uncertain turn after allocation retains the thread and blocks blind replacement.
    const status = args.status === 'failed' && saved.thread_id && saved.status !== 'bound' ? 'outcome_unknown' : args.status;
    db.prepare('UPDATE native_conversation_operations SET status=?,turn_id=?,error=?,updated_at=? WHERE request_id=?').run(status,args.turn_id || saved.turn_id || null,args.error || null,now(),saved.request_id);
    publishChange(); return {operation:operation(saved.request_id)};
  }
  function trustedBinding(threadId, hostId) {
    const recorded = db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(threadId);
    if (recorded) { if (recorded.host_id !== hostId) fail('native_host_mismatch'); return recorded; }
    const project = db.prepare('SELECT * FROM project_native_sessions WHERE thread_id=?').get(threadId);
    if (project && hostId === 'local') return {...project,issue_id:null,host_id:hostId};
    const session = hasTable('issue_sessions') && db.prepare('SELECT * FROM issue_sessions WHERE thread_id=?').get(threadId);
    const issue = session && store.getIssue(session.issue_id);
    if (issue && nativeOwned(issue) && session.host_id === hostId) return {project_id:issue.project_id,kind:'work',issue_id:issue.id,thread_id:threadId,host_id:hostId};
    fail('native_binding_required');
  }
  function listBindings() {
    // Bootstrap exposes identity only. Current sessions remain authoritative;
    // archived historical bindings must never redirect a normal native chat.
    const result = new Map(), conflicts = new Set();
    const recorded = new Map(db.prepare('SELECT * FROM native_conversation_bindings').all().map(row=>[row.thread_id,row]));
    const add = (session,projectId,kind,issueId) => {
      if (!session.thread_id || !store.getProject(projectId)) return;
      const metadata=recorded.get(session.thread_id);
      if (metadata && (metadata.archived_at || metadata.project_id!==projectId || metadata.kind!==kind || (metadata.issue_id || null)!==(issueId || null))) return;
      const hostId=metadata?.host_id || session.host_id || 'local';
      if (session.host_id && session.host_id!==hostId) return;
      const value={thread_id:session.thread_id,host_id:hostId,project_id:projectId,kind,issue_id:issueId || null};
      const key=hostId+':'+session.thread_id, previous=result.get(key);
      if (conflicts.has(key)) return;
      if (previous && (previous.project_id!==value.project_id || previous.kind!==value.kind || previous.issue_id!==value.issue_id)) {result.delete(key);conflicts.add(key);return;}
      result.set(key,value);
    };
    for (const session of db.prepare('SELECT project_id,kind,thread_id FROM project_native_sessions').all()) add(session,session.project_id,session.kind,null);
    if (hasTable('issue_sessions')) for (const session of db.prepare('SELECT issue_id,thread_id,host_id FROM issue_sessions').all()) {
      const issue=store.getIssue(session.issue_id);
      if (issue && !issue.archived_at && nativeOwned(issue)) add(session,issue.project_id,'work',issue.id);
    }
    return [...result.values()];
  }
  async function tool(args) {
    const relayId = text(args.relay_id,'relay_id'), hostId = text(args.host_id,'host_id'), threadId = text(args.thread_id,'thread_id'), callId = text(args.call_id,'call_id');
    if (!store.nativeSessionProxyIsLeader(relayId)) fail('session_relay_not_leader');
    const bound = trustedBinding(threadId,hostId), definition = nativeTools.find(tool => tool.name === args.name);
    if (!definition) fail('tool_not_found');
    const input = args.arguments;
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_arguments');
    for (const key of Object.keys(input)) if (!(key in definition.inputSchema.properties)) fail('invalid_argument_' + key);
    for (const key of definition.inputSchema.required) if (!(key in input)) fail('missing_' + key);
    const fingerprint = hash({threadId,hostId,name:args.name,input});
    const existing = db.prepare('SELECT * FROM native_conversation_tool_calls WHERE call_id=?').get(callId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('native_tool_call_conflict');
      if (existing.status === 'completed') return JSON.parse(existing.result_json);
      fail(existing.error || 'native_tool_outcome_unknown');
    }
    db.prepare("INSERT INTO native_conversation_tool_calls(call_id,relay_id,host_id,thread_id,name,fingerprint,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").run(callId,relayId,hostId,threadId,args.name,fingerprint,now());
    try {
      const result = await invokeTool(args.name.slice('better_codex_'.length),{...input,project_id:bound.project_id,thread_id:threadId});
      db.prepare("UPDATE native_conversation_tool_calls SET status='completed',result_json=? WHERE call_id=?").run(JSON.stringify(result),callId); return result;
    } catch(error) {
      db.prepare("UPDATE native_conversation_tool_calls SET status='failed',error=? WHERE call_id=?").run(error.code || error.message,callId); throw error;
    }
  }
  function backup(value,binding) {
    const folder = path.join(home,'backups','native-conversations'); fs.mkdirSync(folder,{recursive:true});
    const filename = path.join(folder,randomUUID()+'.json');
    fs.writeFileSync(filename,JSON.stringify({project_id:value.project.id,kind:value.kind,issue_id:value.issue?.id || null,binding,operation:pending(value.scope_key),created_at:now()},null,2),{flag:'wx'});
    if (!fs.statSync(filename).size) fail('project_backup_failed');
  }
  function restart(args) {
    if (args.explicit !== true) fail('explicit_restart_required');
    const value = target(args), binding = bindingFor(value);
    const expected = value.issue ? value.issue.version : binding?.revision || 0;
    if (args.expected_revision !== expected) fail('version_conflict');
    if (busyIssue(value.issue) || binding && ['running','active','starting'].includes(binding.status) || pending(value.scope_key)) fail('native_conversation_busy');
    if (binding) backup(value,binding);
    transaction(() => {
      db.prepare('INSERT INTO native_conversation_scopes(scope_key,generation) VALUES(?,1) ON CONFLICT(scope_key) DO UPDATE SET generation=generation+1').run(value.scope_key);
      if (!binding) return;
      db.prepare('INSERT INTO native_conversation_history(id,project_id,kind,issue_id,thread_id,binding_json,archived_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),value.project.id,value.kind,value.issue?.id || null,binding.thread_id,JSON.stringify(binding),now());
      db.prepare('UPDATE native_conversation_bindings SET archived_at=? WHERE thread_id=?').run(now(),binding.thread_id);
      if (value.issue) db.prepare('DELETE FROM issue_sessions WHERE issue_id=?').run(value.issue.id);
      else db.prepare('DELETE FROM project_native_sessions WHERE project_id=? AND kind=?').run(value.project.id,value.kind);
    }); publishChange(); return readContext(args);
  }
  function blockingStatus() { recoverStale(); return {pending_bindings:db.prepare(`SELECT COUNT(*) AS count FROM native_conversation_operations WHERE status IN ('prepared','allocated','bound')`).get().count}; }
  async function handle({url,method,request,response,readBody,sendJson}) {
    if (!url.pathname.startsWith('/api/native-conversations/')) return false;
    const endpoint = url.pathname.slice('/api/native-conversations/'.length);
    let result;
    if (endpoint === 'context' && method === 'GET') result = readContext(Object.fromEntries(url.searchParams));
    else if (method === 'POST') {
      const args = await readBody(request);
      if (endpoint === 'prepare') result = prepare(args);
      else if (endpoint === 'bind') result = bind(args);
      else if (endpoint === 'receipt') result = receipt(args);
      else if (endpoint === 'tool') result = await tool(args);
      else if (endpoint === 'restart') result = restart(args);
      else {sendJson(response,404,{error:'not_found'});return true;}
    } else {sendJson(response,404,{error:'not_found'});return true;}
    sendJson(response,200,result);return true;
  }
  return {readContext,prepare,bind,receipt,tool,restart,handle,busyIssue,operation,pending,blockingStatus,recoverRelay,recoverStale,listBindings};
}
module.exports = {ensureConversationTables,createNativeConversationRuntime};

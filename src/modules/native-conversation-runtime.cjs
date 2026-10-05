'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { nativeTools } = require('./project-mcp.cjs');

const ACTIVE = "'prepared','allocated','bound','outcome_unknown'";
function ensurePlanningConversationTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_native_conversations (
    conversation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('charter','planning')), title TEXT NOT NULL,
    thread_id TEXT UNIQUE, host_id TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'draft',
    last_error TEXT, revision INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
    selected INTEGER NOT NULL DEFAULT 0, legacy_scope TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE UNIQUE INDEX IF NOT EXISTS project_native_conversation_selected ON project_native_conversations(project_id) WHERE selected=1;`);
}
function ensureConversationTables(db) {
  ensurePlanningConversationTables(db);
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
  );
  CREATE TABLE IF NOT EXISTS native_conversation_operation_links (
    request_id TEXT PRIMARY KEY REFERENCES native_conversation_operations(request_id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES project_native_conversations(conversation_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS issue_native_conversations (
    conversation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'work' CHECK(kind='work'), title TEXT NOT NULL,
    thread_id TEXT UNIQUE, host_id TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'draft',
    last_error TEXT, revision INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
    active_turn_id TEXT, last_turn_id TEXT, selected INTEGER NOT NULL DEFAULT 0,
    legacy_scope TEXT UNIQUE, history_id TEXT UNIQUE REFERENCES native_conversation_history(id),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS issue_native_conversation_selected ON issue_native_conversations(issue_id) WHERE selected=1;
  CREATE TABLE IF NOT EXISTS native_work_operation_links (
    request_id TEXT PRIMARY KEY REFERENCES native_conversation_operations(request_id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES issue_native_conversations(conversation_id) ON DELETE CASCADE
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
  const pending = scope => db.prepare(`SELECT operations.*,COALESCE(links.conversation_id,work_links.conversation_id) AS conversation_id FROM native_conversation_operations AS operations
    LEFT JOIN native_conversation_operation_links AS links ON links.request_id=operations.request_id
    LEFT JOIN native_work_operation_links AS work_links ON work_links.request_id=operations.request_id
    WHERE (operations.scope_key=? OR COALESCE(links.conversation_id,work_links.conversation_id)=?) AND operations.status IN (${ACTIVE})`).get(scope,scope.startsWith('conversation:')?scope.slice('conversation:'.length):null) || null;
  const operation = requestId => db.prepare(`SELECT operations.*,COALESCE(links.conversation_id,work_links.conversation_id) AS conversation_id FROM native_conversation_operations AS operations
    LEFT JOIN native_conversation_operation_links AS links ON links.request_id=operations.request_id
    LEFT JOIN native_work_operation_links AS work_links ON work_links.request_id=operations.request_id WHERE operations.request_id=?`).get(requestId) || null;
  const conversation = conversationId => db.prepare('SELECT * FROM project_native_conversations WHERE conversation_id=?').get(conversationId) || db.prepare('SELECT * FROM issue_native_conversations WHERE conversation_id=?').get(conversationId) || null;
  const display = row => row && {...row,selected:Boolean(row.selected),draft_generation:row.generation};
  const hasHistory = args => Object.hasOwn(args,'history_id');
  const assertWritable = args => {if (hasHistory(args)) fail('native_history_read_only');};
  const safeIdentifier = value => typeof value==='string' && Boolean(value.trim()) && value.length<=200 && !value.includes('\0') && value===value.trim();
  function defaultConversation(projectId,kind) {
    const selected=db.prepare('SELECT * FROM project_native_conversations WHERE project_id=? AND kind=? AND selected=1').get(projectId,kind);
    if (selected) return selected;
    const current=planning.getSession(projectId,kind);
    if (current) return db.prepare('SELECT * FROM project_native_conversations WHERE thread_id=?').get(current.thread_id) || null;
    return db.prepare('SELECT * FROM project_native_conversations WHERE project_id=? AND kind=? ORDER BY updated_at DESC,created_at DESC,conversation_id LIMIT 1').get(projectId,kind) || null;
  }
  function insertConversation(projectId,kind,input={}) {
    const count=db.prepare('SELECT COUNT(*) AS count FROM project_native_conversations WHERE project_id=? AND kind=?').get(projectId,kind).count;
    const label=kind==='charter'?'总纲会话':'任务规划';
    const timestamp=now(), identifier=input.conversation_id || randomUUID();
    db.prepare(`INSERT INTO project_native_conversations(conversation_id,project_id,kind,title,thread_id,host_id,status,last_error,revision,generation,selected,legacy_scope,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(identifier,projectId,kind,input.title || label+' '+(count+1),input.thread_id || null,input.host_id || 'local',input.status || (input.thread_id?'ready':'draft'),input.last_error || null,input.revision || (input.thread_id?1:0),input.generation || 0,Number(Boolean(input.selected)),input.legacy_scope || null,input.created_at || timestamp,timestamp);
    return conversation(identifier);
  }
  function defaultWorkConversation(issueId) {
    return db.prepare("SELECT * FROM issue_native_conversations WHERE issue_id=? AND status!='closed' ORDER BY selected DESC,updated_at DESC,created_at DESC,conversation_id LIMIT 1").get(issueId) || null;
  }
  function insertWorkConversation(issue,input={}) {
    const count=db.prepare('SELECT COUNT(*) AS count FROM issue_native_conversations WHERE issue_id=?').get(issue.id).count;
    const timestamp=now(),identifier=input.conversation_id || randomUUID();
    db.prepare(`INSERT INTO issue_native_conversations(conversation_id,project_id,issue_id,title,thread_id,host_id,status,last_error,revision,generation,active_turn_id,last_turn_id,selected,legacy_scope,history_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(identifier,issue.project_id,issue.id,input.title || (count?issue.title+' · 会话 '+(count+1):issue.title),input.thread_id || null,input.host_id || 'local',input.status || (input.thread_id?'ready':'draft'),input.last_error || null,input.revision || (input.thread_id?1:0),input.generation || 0,input.active_turn_id || null,input.last_turn_id || null,Number(Boolean(input.selected)),input.legacy_scope || null,input.history_id || null,input.created_at || timestamp,input.updated_at || timestamp);
    return conversation(identifier);
  }
  function workBinding(row) {
    if (!row?.thread_id || row.status==='closed') return null;
    const current=issueSession(row.issue_id);
    const live=current?.thread_id===row.thread_id?current:null;
    return {...display(row),...(workSessionMetadata(live) || {}),conversation_id:row.conversation_id,project_id:row.project_id,kind:'work',
      revision:row.revision,generation:row.generation,title:row.title,selected:Boolean(row.selected),
      created_at:row.created_at,updated_at:row.updated_at,
      active_turn_id:live?live.active_turn_id || null:row.active_turn_id || null};
  }
  function workSessionMetadata(session) {
    if (!session) return null;
    // Session execution caches may include assistant text or retry input. Native
    // conversation identities and recovery snapshots retain metadata only.
    return Object.fromEntries(['issue_id','thread_id','host_id','status','active_turn_id','last_turn_id','active_command_id','created_at','updated_at']
      .filter(key=>Object.hasOwn(session,key)).map(key=>[key,session[key]]));
  }
  function migrateConversations() {
    for (const current of db.prepare('SELECT * FROM project_native_sessions ORDER BY created_at,kind').all()) {
      if (db.prepare('SELECT 1 FROM project_native_conversations WHERE thread_id=?').get(current.thread_id)) continue;
      insertConversation(current.project_id,current.kind,{...current,selected:!db.prepare('SELECT 1 FROM project_native_conversations WHERE project_id=? AND selected=1').get(current.project_id),legacy_scope:current.project_id+':'+current.kind,
        host_id:db.prepare('SELECT host_id FROM native_conversation_bindings WHERE thread_id=?').get(current.thread_id)?.host_id || 'local'});
    }
    for (const history of db.prepare("SELECT * FROM native_conversation_history WHERE kind IN ('charter','planning') ORDER BY archived_at").all()) {
      if (db.prepare('SELECT 1 FROM project_native_conversations WHERE thread_id=?').get(history.thread_id)) continue;
      let previous;
      try {previous=JSON.parse(history.binding_json);} catch {continue;}
      if (!previous || typeof previous!=='object' || Array.isArray(previous)) continue;
      const title=typeof previous.title==='string' && previous.title.trim() && previous.title.length<=200 ? previous.title : undefined;
      const hostId=typeof previous.host_id==='string' && previous.host_id.trim() && previous.host_id.length<=200 && !previous.host_id.includes('\0') ? previous.host_id : 'local';
      insertConversation(history.project_id,history.kind,{title,thread_id:history.thread_id,status:'closed',selected:false,host_id:hostId,
        revision:Number.isSafeInteger(previous.revision)&&previous.revision>0?previous.revision:1,
        generation:Number.isSafeInteger(previous.generation)&&previous.generation>=0?previous.generation:0,
        ...(typeof previous.created_at==='string'?{created_at:previous.created_at}:{})});
    }
    for (const op of db.prepare("SELECT operations.* FROM native_conversation_operations AS operations WHERE operations.kind IN ('charter','planning') AND NOT EXISTS(SELECT 1 FROM native_conversation_operation_links AS links WHERE links.request_id=operations.request_id)").all()) {
      let bound=op.thread_id && db.prepare('SELECT * FROM project_native_conversations WHERE thread_id=?').get(op.thread_id);
      bound ||= defaultConversation(op.project_id,op.kind);
      if (!bound) bound=insertConversation(op.project_id,op.kind,{selected:!db.prepare('SELECT 1 FROM project_native_conversations WHERE project_id=? AND selected=1').get(op.project_id),legacy_scope:op.project_id+':'+op.kind});
      db.prepare('INSERT OR IGNORE INTO native_conversation_operation_links(request_id,conversation_id) VALUES(?,?)').run(op.request_id,bound.conversation_id);
    }
  }
  migrateConversations();
  function migrateWorkConversations() {
    const candidates=[];
    if (hasTable('issue_sessions')) for (const current of db.prepare('SELECT * FROM issue_sessions ORDER BY created_at,issue_id').all()) {
      const issue=store.getIssue(current.issue_id);
      if (!issue || !nativeOwned(issue) || !current.thread_id || db.prepare('SELECT 1 FROM issue_native_conversations WHERE thread_id=?').get(current.thread_id)) continue;
      const metadata=db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=?').get(current.thread_id);
      if (metadata && (metadata.archived_at || metadata.project_id!==issue.project_id || metadata.kind!=='work' || metadata.issue_id!==issue.id || metadata.host_id!==current.host_id)) continue;
      candidates.push({issue,input:{...workSessionMetadata(current),host_id:metadata?.host_id || current.host_id || 'local',status:current.status || 'ready',
        selected:!defaultWorkConversation(issue.id),legacy_scope:'work:'+issue.id,
        generation:db.prepare('SELECT generation FROM native_conversation_scopes WHERE scope_key=?').get('work:'+issue.id)?.generation || 0}});
    }
    for (const history of db.prepare("SELECT * FROM native_conversation_history WHERE kind='work' ORDER BY archived_at,id").all()) {
      const issue=store.getIssue(history.issue_id);
      if (!issue || issue.project_id!==history.project_id || db.prepare('SELECT 1 FROM issue_native_conversations WHERE thread_id=? OR history_id=?').get(history.thread_id,history.id)) continue;
      let validated;try {validated=workHistory(history,issue);} catch(error) {if (error.code==='native_history_scope_mismatch') continue;throw error;}
      candidates.push({issue,input:{thread_id:history.thread_id,host_id:validated.host_id,title:validated.conversation_title || validated.title,revision:validated.revision,generation:validated.generation,status:'closed',selected:false,history_id:history.id,
        legacy_scope:'history:'+history.id,created_at:validated.created_at,updated_at:validated.updated_at}});
    }
    const operations=db.prepare("SELECT operations.* FROM native_conversation_operations AS operations WHERE kind='work' AND NOT EXISTS(SELECT 1 FROM native_work_operation_links AS links WHERE links.request_id=operations.request_id)").all();
    const linkable=operations.filter(op=>op.thread_id && (candidates.some(row=>row.input.thread_id===op.thread_id) || db.prepare('SELECT 1 FROM issue_native_conversations WHERE thread_id=?').get(op.thread_id)));
    if (!candidates.length && !linkable.length) return;
    // Migration backs up affected identity/state only, without copying chat content.
    const folder=path.join(home,'backups','native-conversations');fs.mkdirSync(folder,{recursive:true});
    const filename=path.join(folder,randomUUID()+'.json');
    fs.writeFileSync(filename,JSON.stringify({kind:'work_conversation_migration',created_at:now(),
      conversations:candidates.map(row=>({project_id:row.issue.project_id,issue_id:row.issue.id,...row.input})),operations:linkable.map(op=>({request_id:op.request_id,thread_id:op.thread_id,scope_key:op.scope_key,status:op.status}))},null,2),{flag:'wx'});
    if (!fs.statSync(filename).size) fail('project_backup_failed');
    transaction(()=>{
      for (const {issue,input} of candidates) {
        if (db.prepare('SELECT 1 FROM issue_native_conversations WHERE thread_id=?').get(input.thread_id)) continue;
        // Old per-task generation rows survive restarts; the original scope may
        // already belong to an archived conversation created by this runtime.
        if (input.legacy_scope && db.prepare('SELECT 1 FROM issue_native_conversations WHERE legacy_scope=?').get(input.legacy_scope)) delete input.legacy_scope;
        insertWorkConversation(issue,input);
      }
      for (const op of linkable) {
        const row=db.prepare('SELECT conversation_id FROM issue_native_conversations WHERE thread_id=? AND project_id=? AND issue_id=?').get(op.thread_id,op.project_id,op.issue_id);
        if (row) db.prepare('INSERT OR IGNORE INTO native_work_operation_links(request_id,conversation_id) VALUES(?,?)').run(op.request_id,row.conversation_id);
      }
    });
  }
  migrateWorkConversations();
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
    const selected=args.conversation_id ? conversation(text(args.conversation_id,'conversation_id')) : null;
    if (args.conversation_id && (!selected || selected.project_id!==projectId)) fail('conversation_project_mismatch');
    const kind=args.kind || selected?.kind;
    if (!['charter','planning','work'].includes(kind)) fail('invalid_session_kind');
    if (selected && selected.kind!==kind) fail('conversation_kind_mismatch');
    const issue = kind === 'work' ? store.getIssue(text(args.issue_id || selected?.issue_id, 'issue_id')) : null;
    if (kind === 'work' && (!issue || issue.project_id !== projectId)) fail('issue_project_mismatch');
    if (selected && kind==='work' && selected.issue_id!==issue.id) fail('conversation_issue_mismatch');
    if (issue?.archived_at) fail('issue_archived');
    const resolved=selected || (kind==='work'?defaultWorkConversation(issue.id):defaultConversation(projectId,kind));
    return { project, issue, kind, conversation:resolved, scope_key:kind==='work'?'work:'+issue.id:resolved?'conversation:'+resolved.conversation_id:projectId+':'+kind };
  }
  function busyIssue(issue, allowOperationId) {
    if (!issue) return false;
    const session = issueSession(issue.id);
    const busy = issue.active_run_status || issue.session_active_turn_id || session?.active_turn_id ||
      ['starting','active','stopping','waiting_on_approval','waiting_on_user'].includes(session?.status) ||
      (hasTable('issue_runs') && db.prepare("SELECT 1 FROM issue_runs WHERE issue_id=? AND status IN ('claimed','running','scheduling')").get(issue.id)) ||
      (hasTable('issue_replies') && db.prepare("SELECT 1 FROM issue_replies WHERE issue_id=? AND status='running'").get(issue.id)) ||
      (hasTable('session_commands') && db.prepare("SELECT 1 FROM session_commands WHERE issue_id=? AND status IN ('pending','claimed')").get(issue.id)) ||
      db.prepare("SELECT 1 FROM issue_native_conversations WHERE issue_id=? AND status!='closed' AND (active_turn_id IS NOT NULL OR status='running')").get(issue.id);
    const reserved = pending('work:' + issue.id);
    return Boolean(busy || reserved && reserved.request_id !== allowOperationId);
  }
  function bindingFor(value) {
    if (value.kind !== 'work') return value.conversation ? value.conversation.thread_id ? display(value.conversation) : null : planning.getSession(value.project.id, value.kind);
    return value.conversation ? workBinding(value.conversation) : workSessionMetadata(issueSession(value.issue.id));
  }
  function assertSelectionFree(projectId,nextId) {
    for (const row of db.prepare('SELECT * FROM project_native_conversations WHERE project_id=? AND conversation_id!=?').all(projectId,nextId || '')) {
      if (pending('conversation:'+row.conversation_id) || row.status==='running' || row.thread_id && hasTable('project_native_activity') && db.prepare("SELECT 1 FROM project_native_activity WHERE thread_id=? AND status='running'").get(row.thread_id)) fail('native_conversation_busy');
    }
  }
  function mirrorConversation(row) {
    if (!row.thread_id) {db.prepare('DELETE FROM project_native_sessions WHERE project_id=? AND kind=?').run(row.project_id,row.kind);return;}
    db.prepare(`INSERT INTO project_native_sessions(project_id,kind,thread_id,owner,status,last_error,revision,created_at,updated_at)
      VALUES(?,?,?,'native',?,?,?,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET thread_id=excluded.thread_id,status=excluded.status,last_error=excluded.last_error,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(row.project_id,row.kind,row.thread_id,row.status==='closed'?'ready':row.status,row.last_error,Math.max(1,row.revision),row.created_at,now());
  }
  function listConversations(projectId) {
    if (!store.getProject(text(projectId,'project_id'))) fail('project_not_found');
    const rows=db.prepare('SELECT * FROM project_native_conversations WHERE project_id=? ORDER BY selected DESC,created_at DESC,conversation_id').all(projectId).map(display);
    return {conversations:rows,selected_conversation_id:rows.find(row=>row.selected)?.conversation_id || null};
  }
  function workHistory(row,issue) {
    if (row.project_id!==issue.project_id || row.kind!=='work' || row.issue_id!==issue.id || !safeIdentifier(row.id) || !safeIdentifier(row.thread_id)) fail('native_history_scope_mismatch');
    // The history row is the durable identity. Snapshot JSON is optional display
    // metadata: damage must not prevent current task access or rewrite old data.
    let previous={};
    try {const value=JSON.parse(row.binding_json);if (value && typeof value==='object' && !Array.isArray(value)) previous=value;} catch {}
    for (const [key,expected] of [['project_id',row.project_id],['kind','work'],['issue_id',issue.id],['thread_id',row.thread_id]]) {
      if (previous[key]!==undefined && previous[key]!==null && previous[key]!==expected) fail('native_history_scope_mismatch');
    }
    const metadata=db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=?').get(row.thread_id);
    if (metadata && (metadata.project_id!==row.project_id || metadata.kind!=='work' || metadata.issue_id!==issue.id || !metadata.archived_at)) fail('native_history_scope_mismatch');
    const savedHost=safeIdentifier(previous.host_id)?previous.host_id:null;
    if (metadata && (!safeIdentifier(metadata.host_id) || savedHost && metadata.host_id!==savedHost)) fail('native_history_scope_mismatch');
    // A historical identity cannot borrow a current work/planning binding or a
    // different project's history, even when an old snapshot claims otherwise.
    if ((hasTable('issue_sessions') && db.prepare('SELECT 1 FROM issue_sessions WHERE thread_id=?').get(row.thread_id)) ||
      db.prepare('SELECT 1 FROM project_native_conversations WHERE thread_id=?').get(row.thread_id) ||
      db.prepare("SELECT 1 FROM issue_native_conversations WHERE thread_id=? AND (status!='closed' OR project_id!=? OR issue_id!=? OR history_id!=?)").get(row.thread_id,row.project_id,issue.id,row.id) ||
      db.prepare('SELECT 1 FROM project_native_sessions WHERE thread_id=?').get(row.thread_id) ||
      db.prepare("SELECT 1 FROM native_conversation_history WHERE thread_id=? AND (project_id!=? OR kind!='work' OR issue_id IS NULL OR issue_id!=?)").get(row.thread_id,row.project_id,issue.id)) fail('native_history_scope_mismatch');
    const migrated=db.prepare('SELECT conversation_id FROM issue_native_conversations WHERE history_id=?').get(row.id);
    return {project_id:row.project_id,kind:'work',issue_id:issue.id,history_id:row.id,...(migrated?{conversation_id:migrated.conversation_id}:{}),thread_id:row.thread_id,
      host_id:metadata?.host_id || savedHost || 'local',title:issue.title,
      conversation_title:typeof previous.title==='string' && previous.title.trim() && previous.title.length<=200?previous.title:issue.title,
      revision:Number.isSafeInteger(previous.revision) && previous.revision>0?previous.revision:1,
      generation:Number.isSafeInteger(previous.generation) && previous.generation>=0?previous.generation:0,
      status:issue.status,active_run_status:issue.active_run_status || null,
      mode:'thread',source:'history',read_only:true,created_at:typeof previous.created_at==='string' && previous.created_at.length<=80?previous.created_at:row.archived_at,
      updated_at:row.archived_at,archived_at:row.archived_at};
  }
  function historyTarget(args) {
    const value=target(args);
    if (value.kind!=='work') fail('native_history_scope_mismatch');
    const row=db.prepare('SELECT * FROM native_conversation_history WHERE id=?').get(text(args.history_id,'history_id'));
    if (!row) fail('native_history_not_found');
    if (args.conversation_id && (!value.conversation || value.conversation.status!=='closed' || value.conversation.history_id!==row.id)) fail('native_history_scope_mismatch');
    return {value,history:workHistory(row,value.issue)};
  }
  function workDisplay(issue,row) {
    const binding=row?workBinding(row):workSessionMetadata(issueSession(issue.id)),owned=nativeOwned(issue) || !(issueSession(issue.id) || issue.run_thread_id);
    const metadata=binding?.thread_id && db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(binding.thread_id);
    const hostId=metadata?.host_id || binding?.host_id || row?.host_id || 'local';
    return {...(row?display(row):{}),project_id:issue.project_id,kind:'work',issue_id:issue.id,title:issue.title,conversation_title:row?.title || issue.title,
      conversation_status:binding?.status || row?.status || 'draft',status:issue.status,active_run_status:issue.active_run_status || null,
      source:'current',read_only:false,thread_id:owned?binding?.thread_id || null:null,host_id:hostId,
      binding:binding?{...binding,issue_id:issue.id,host_id:hostId}:null,
      mode:!owned?(busyIssue(issue)?'legacy_busy':'handoff_required'):binding?'thread':'draft',
      created_at:row?.created_at || binding?.created_at || issue.created_at || null,updated_at:row?.updated_at || binding?.updated_at || issue.updated_at || null,
      session_status:binding?.status || null,session_active_turn_id:binding?.active_turn_id || null,
      task_execution_running:busyIssue(issue)};
  }
  function listWorkConversations(projectId,issueId) {
    const project=store.getProject(text(projectId,'project_id'));if (!project) fail('project_not_found');
    if (issueId!==undefined && issueId!==null) {
      const issue=store.getIssue(text(issueId,'issue_id'));if (!issue || issue.project_id!==project.id) fail('issue_project_mismatch');
    }
    const conversations=[];
    for (const issue of store.listIssues({projectId:project.id})) {
      if (issue.project_id!==project.id || issue.archived_at || issueId && issue.id!==issueId) continue;
      const rows=db.prepare("SELECT * FROM issue_native_conversations WHERE issue_id=? AND status!='closed' ORDER BY selected DESC,created_at DESC,conversation_id").all(issue.id);
      if (rows.length) for (const row of rows) conversations.push(workDisplay(issue,row));
      else conversations.push(workDisplay(issue,null));
      for (const row of db.prepare("SELECT * FROM native_conversation_history WHERE project_id=? AND kind='work' AND issue_id=? ORDER BY archived_at DESC,id").all(project.id,issue.id)) {
        try {conversations.push(workHistory(row,issue));} catch(error) {if (error.code!=='native_history_scope_mismatch') throw error;}
      }
    }
    return {conversations,selected_conversation_id:issueId?conversations.find(row=>row.selected)?.conversation_id || null:null};
  }
  function metadataBackup(projectId,kind,row) {
    const previous=planning.getSession(projectId,kind);
    const archived=row?.thread_id && db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NOT NULL').get(row.thread_id);
    if (!previous && !archived) return;
    const folder=path.join(home,'backups','native-conversations');fs.mkdirSync(folder,{recursive:true});
    const filename=path.join(folder,randomUUID()+'.json');
    fs.writeFileSync(filename,JSON.stringify({kind:'conversation_selection',project_id:projectId,previous,archived_binding:archived || null,created_at:now()},null,2),{flag:'wx'});
    if (!fs.statSync(filename).size) fail('project_backup_failed');
  }
  function createConversation(args) {
    assertWritable(args);
    const value=target({project_id:args.project_id,kind:args.kind,issue_id:args.issue_id});
    const title=args.title===undefined?undefined:text(args.title,'title');
    if (value.issue) {
      const created=transaction(()=>{
        db.prepare('UPDATE issue_native_conversations SET selected=0 WHERE issue_id=?').run(value.issue.id);
        return insertWorkConversation(value.issue,{title,selected:true});
      });publishChange();return {conversation:display(created)};
    }
    assertSelectionFree(value.project.id,null);
    metadataBackup(value.project.id,value.kind);
    const created=transaction(()=> {
      assertSelectionFree(value.project.id,null);
      db.prepare('UPDATE project_native_conversations SET selected=0 WHERE project_id=?').run(value.project.id);
      const row=insertConversation(value.project.id,value.kind,{title,selected:true});
      mirrorConversation(row);return row;
    });publishChange();return {conversation:display(created)};
  }
  function selectConversation(args) {
    assertWritable(args);
    const value=target({project_id:args.project_id,kind:args.kind,issue_id:args.issue_id,conversation_id:args.conversation_id});
    const row=value.conversation;
    if (!row) fail('native_conversation_not_found');
    if (args.expected_revision!==undefined && args.expected_revision!==row.revision) fail('version_conflict');
    if (value.issue) {
      if (row.status==='closed') fail('native_history_read_only');
      if (row.selected) return {conversation:display(row)};
      const updated=transaction(()=>{
        db.prepare('UPDATE issue_native_conversations SET selected=0 WHERE issue_id=?').run(value.issue.id);
        db.prepare('UPDATE issue_native_conversations SET selected=1,updated_at=? WHERE conversation_id=?').run(now(),row.conversation_id);
        return conversation(row.conversation_id);
      });publishChange();return {conversation:display(updated)};
    }
    if (row.selected) return {conversation:display(row)};
    assertSelectionFree(value.project.id,row.conversation_id);
    metadataBackup(value.project.id,row.kind,row);
    const updated=transaction(()=>{
      assertSelectionFree(value.project.id,row.conversation_id);
      db.prepare('UPDATE project_native_conversations SET selected=0 WHERE project_id=?').run(value.project.id);
      db.prepare("UPDATE project_native_conversations SET selected=1,status=CASE WHEN status='closed' THEN 'ready' ELSE status END,updated_at=? WHERE conversation_id=?").run(now(),row.conversation_id);
      const saved=conversation(row.conversation_id);mirrorConversation(saved);
      if (saved.thread_id) db.prepare('UPDATE native_conversation_bindings SET archived_at=NULL WHERE thread_id=? AND project_id=? AND kind=?').run(saved.thread_id,saved.project_id,saved.kind);
      return saved;
    });publishChange();return {conversation:display(updated)};
  }
  function readContext(args) {
    if (hasHistory(args)) {
      const {value,history}=historyTarget(args);
      const details=context(value.project.id,{issue_id:value.issue.id});
      delete details.work_instructions;
      delete details.work_context_text;
      if (!details.task) details.task={...value.issue};
      const scopeTarget={project_id:value.project.id,kind:'work',issue_id:value.issue.id,history_id:history.history_id,...(history.conversation_id?{conversation_id:history.conversation_id}:{})};
      return {...scopeTarget,target:scopeTarget,context:details,history,read_only:true,source:'history',mode:'thread',thread_id:history.thread_id,host_id:history.host_id,
        binding:{issue_id:value.issue.id,thread_id:history.thread_id,host_id:history.host_id,status:'closed',created_at:history.created_at,updated_at:history.updated_at},
        conversation:null,pending_operation:null,expected_revision:value.issue.version,draft_generation:0,
        native_project_id:value.project.external_id || '',workspace_path:value.issue.workspace_path || value.project.workspace_path || '',
        cwd:value.issue.workspace_path || value.project.workspace_path || '',root_paths:details.root_paths || value.project.root_paths || [],
        planning_available:planning.getCharter(value.project.id)?.status==='confirmed',dynamic_tools:[]};
    }
    const value = target(args);
    if (value.issue && value.conversation?.status==='closed') {
      if (!value.conversation.history_id) fail('native_history_read_only');
      return readContext({project_id:value.project.id,kind:'work',issue_id:value.issue.id,history_id:value.conversation.history_id});
    }
    recoverStale();
    const binding = bindingFor(value), currentOperation = pending(value.scope_key);
    const owned = !value.issue || nativeOwned(value.issue) || !(issueSession(value.issue.id) || value.issue.run_thread_id), busy = busyIssue(value.issue);
    const expectedRevision = value.issue ? value.issue.version : binding?.revision || 0;
    const metadata = binding?.thread_id && db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(binding.thread_id);
    const details = context(value.project.id, { ...(binding?.thread_id ? { thread_id: binding.thread_id } : {}), ...(value.issue ? { issue_id: value.issue.id } : {}) });
    if (value.issue && !details.task) details.task = { ...value.issue };
    if (value.issue) details.task={...details.task,session_status:binding?.status || null,session_active_turn_id:binding?.active_turn_id || null,task_execution_running:busy};
    const draftGeneration = value.conversation?.generation ?? db.prepare('SELECT generation FROM native_conversation_scopes WHERE scope_key=?').get(value.scope_key)?.generation ?? 0;
    const scopeTarget={project_id:value.project.id,kind:value.kind,...(value.issue?{issue_id:value.issue.id}:{}),...(value.conversation?{conversation_id:value.conversation.conversation_id}:{})};
    return { context: details, target:scopeTarget, ...scopeTarget, ...(value.issue?{read_only:false,source:'current'}:{}), conversation:display(value.conversation), binding, pending_operation: currentOperation, expected_revision: expectedRevision, draft_generation: draftGeneration,
      native_project_id: value.project.external_id || '', workspace_path: value.issue?.workspace_path || value.project.workspace_path || '',
      cwd: value.issue?.workspace_path || value.project.workspace_path || '', root_paths: details.root_paths || value.project.root_paths || [],
      host_id: metadata?.host_id || binding?.host_id || 'local', thread_id: owned ? binding?.thread_id || null : null,
      task_execution_running:busy,mode: !owned ? (busy ? 'legacy_busy' : 'handoff_required') : binding ? 'thread' : 'draft',
      planning_available: planning.getCharter(value.project.id)?.status === 'confirmed', dynamic_tools: nativeTools };
  }
  function identity(args) {
    const relayId = text(args.relay_id, 'relay_id'), hostId = text(args.host_id, 'host_id'), requestId = text(args.request_id, 'request_id');
    if (!store.nativeSessionProxyIsLeader(relayId)) fail('session_relay_not_leader');
    return { relay_id: relayId, host_id: hostId, request_id: requestId };
  }
  function checkOperation(args) {
    assertWritable(args);
    const auth = identity(args), value = operation(auth.request_id); if (!value) fail('native_operation_not_found');
    if (value.relay_id !== auth.relay_id || value.host_id !== auth.host_id) fail('native_operation_identity_mismatch');
    if (args.expected_revision !== undefined && args.expected_revision !== value.expected_revision) fail('version_conflict');
    if (args.project_id !== undefined && args.project_id !== value.project_id || args.kind !== undefined && args.kind !== value.kind || args.issue_id !== undefined && args.issue_id !== value.issue_id) fail('native_operation_scope_mismatch');
    if (args.conversation_id !== undefined && args.conversation_id !== value.conversation_id) fail('native_operation_scope_mismatch');
    return value;
  }
  function prepare(args) {
    assertWritable(args);
    recoverStale();
    let value = target(args); const auth = identity(args);
    if (value.issue && value.conversation?.status==='closed') fail('native_history_read_only');
    const skillPaths=args.skill_paths ?? [];
    if (!Array.isArray(skillPaths)) fail('invalid_skill_paths');
    store.nativeProjectRuntime?.assertSkillPaths?.(skillPaths,value.project.id);
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) fail('invalid_expected_revision');
    const fingerprintInput={ project_id: value.project.id, kind: value.kind, issue_id: value.issue?.id || null, conversation_id:args.conversation_id || null, host_id: auth.host_id, expected_revision: args.expected_revision, draft_generation: args.draft_generation };
    const fingerprint = hash({...fingerprintInput,skill_paths:skillPaths}),legacyFingerprint=skillPaths.length?null:hash(fingerprintInput);
    const result = transaction(() => {
      const existing = operation(auth.request_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint && existing.fingerprint !== legacyFingerprint || existing.relay_id !== auth.relay_id) fail('request_id_conflict');
        if (existing.thread_id && db.prepare('SELECT 1 FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NOT NULL').get(existing.thread_id)) fail('native_operation_finished');
        return existing;
      }
      const previous = pending(value.scope_key); if (previous) fail(previous.status === 'outcome_unknown' ? 'native_outcome_unknown' : 'native_operation_busy');
      if (!value.issue) assertSelectionFree(value.project.id,value.conversation?.conversation_id);
      const binding = bindingFor(value), expected = value.issue ? value.issue.version : binding?.revision || 0;
      if (args.expected_revision !== expected) fail('version_conflict');
      const generation = value.conversation?.generation ?? db.prepare('SELECT generation FROM native_conversation_scopes WHERE scope_key=?').get(value.scope_key)?.generation ?? 0;
      if (args.draft_generation !== undefined && args.draft_generation !== generation) fail('version_conflict');
      const recorded = binding?.thread_id && db.prepare('SELECT host_id FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(binding.thread_id);
      if (binding && (recorded?.host_id || binding.host_id || 'local') !== auth.host_id) fail('native_host_mismatch');
      if (value.kind === 'planning' && planning.getCharter(value.project.id)?.status !== 'confirmed') fail('confirmed_charter_required');
      if (value.conversation?.status==='closed') fail('conversation_select_required');
      if (value.issue && !nativeOwned(value.issue) && (issueSession(value.issue.id) || value.issue.run_thread_id)) fail('native_handoff_required');
      if (busyIssue(value.issue)) fail('issue_execution_running');
      if (binding && ['running','active','starting','waiting_on_user','waiting_on_approval'].includes(binding.status)) fail('native_conversation_busy');
      if (!value.issue && binding?.thread_id && hasTable('project_native_activity') && db.prepare("SELECT 1 FROM project_native_activity WHERE thread_id=? AND status='running'").get(binding.thread_id)) fail('native_conversation_busy');
      if (value.issue && !value.conversation) {
        const row=insertWorkConversation(value.issue,{selected:true,generation,legacy_scope:db.prepare('SELECT 1 FROM issue_native_conversations WHERE legacy_scope=?').get(value.scope_key)?null:value.scope_key,
          ...(binding?{thread_id:binding.thread_id,host_id:binding.host_id || 'local',status:binding.status || 'ready',active_turn_id:binding.active_turn_id,last_turn_id:binding.last_turn_id,created_at:binding.created_at}:{}),title:value.issue.title});
        value={...value,conversation:row};
      } else if (!value.issue && !value.conversation) {
        const selected=!db.prepare('SELECT 1 FROM project_native_conversations WHERE project_id=? AND selected=1').get(value.project.id);
        const row=insertConversation(value.project.id,value.kind,{selected,legacy_scope:value.project.id+':'+value.kind,generation});
        value={...value,conversation:row,scope_key:'conversation:'+row.conversation_id};
      }
      const timestamp = now();
      db.prepare(`INSERT INTO native_conversation_operations(request_id,project_id,kind,issue_id,scope_key,relay_id,host_id,expected_revision,fingerprint,thread_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(auth.request_id,value.project.id,value.kind,value.issue?.id || null,value.scope_key,auth.relay_id,auth.host_id,args.expected_revision,fingerprint,binding?.thread_id || null,timestamp,timestamp);
      if (value.conversation) db.prepare('INSERT INTO '+(value.issue?'native_work_operation_links':'native_conversation_operation_links')+'(request_id,conversation_id) VALUES(?,?)').run(auth.request_id,value.conversation.conversation_id);
      return operation(auth.request_id);
    });
    publishChange(); return { ...readContext({...args,...(result.conversation_id?{conversation_id:result.conversation_id}:{})}), operation: result };
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
      const conversationOwner=db.prepare('SELECT conversation_id FROM project_native_conversations WHERE thread_id=? UNION ALL SELECT conversation_id FROM issue_native_conversations WHERE thread_id=?').get(threadId,threadId);
      if (conversationOwner && conversationOwner.conversation_id!==op.conversation_id) fail('session_thread_mismatch');
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
          if (value.conversation) {
            db.prepare("UPDATE issue_native_conversations SET thread_id=?,host_id=?,status='ready',revision=CASE WHEN revision=0 THEN 1 ELSE revision END,updated_at=? WHERE conversation_id=? AND (thread_id IS NULL OR thread_id=?)")
              .run(threadId,op.host_id,timestamp,value.conversation.conversation_id,threadId);
            value.conversation=conversation(value.conversation.conversation_id);
          }
          db.prepare(`INSERT INTO issue_sessions(issue_id,host_id,thread_id,status,created_at,updated_at)
            VALUES(?,?,?,'idle',?,?) ON CONFLICT(issue_id) DO NOTHING`).run(value.issue.id,op.host_id,threadId,timestamp,timestamp);
          const mirror=issueSession(value.issue.id);
          if (mirror.thread_id!==threadId) {
            // The per-task execution mirror changes only when this exact
            // conversation is bound for an explicit send, never when browsing.
            db.prepare("UPDATE issue_sessions SET host_id=?,thread_id=?,status='idle',active_turn_id=NULL,active_command_id=NULL,last_turn_id=?,updated_at=? WHERE issue_id=?")
              .run(op.host_id,threadId,value.conversation?.last_turn_id || null,timestamp,value.issue.id);
          }
          db.prepare("INSERT OR IGNORE INTO issue_native_ownership(issue_id,owner,created_at) VALUES(?,'native',?)").run(value.issue.id,timestamp);
        } else if (value.conversation) {
          if ((current?.revision || 0)!==op.expected_revision) fail('version_conflict');
          if (current && (current.status==='running' || hasTable('project_native_activity') && db.prepare("SELECT 1 FROM project_native_activity WHERE thread_id=? AND status='running'").get(current.thread_id))) fail('native_conversation_busy');
          if (!current) {
            db.prepare("UPDATE project_native_conversations SET thread_id=?,host_id=?,status='ready',revision=1,updated_at=? WHERE conversation_id=? AND thread_id IS NULL").run(threadId,op.host_id,now(),value.conversation.conversation_id);
            value.conversation=conversation(value.conversation.conversation_id);
            const selected=defaultConversation(op.project_id,op.kind);
            if (value.conversation.selected || selected?.conversation_id===value.conversation.conversation_id) mirrorConversation(value.conversation);
          }
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
      if (saved.kind === 'work') {
        const issue=store.getIssue(saved.issue_id);
        const mirror=issueSession(saved.issue_id);
        if (!issue || !mirror || mirror.thread_id!==saved.thread_id) fail('session_thread_mismatch');
        if (busyIssue(issue,saved.request_id) && mirror.active_turn_id!==args.turn_id) fail('issue_execution_running');
        if (store.sessionTurnStarted) store.sessionTurnStarted(saved.thread_id,args.turn_id);
        handleWorkEvent('turn/started',{threadId:saved.thread_id,turn:{id:args.turn_id}});
      }
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
    const projectConversation=db.prepare('SELECT * FROM project_native_conversations WHERE thread_id=?').get(threadId);
    if (projectConversation) {
      if (projectConversation.host_id!==hostId) fail('native_host_mismatch');
      if (recorded && (recorded.project_id!==projectConversation.project_id || recorded.kind!==projectConversation.kind)) fail('session_thread_mismatch');
      return {...projectConversation,issue_id:null};
    }
    const workConversation=db.prepare('SELECT * FROM issue_native_conversations WHERE thread_id=?').get(threadId);
    if (workConversation) {
      if (workConversation.status==='closed') fail('native_history_read_only');
      const issue=store.getIssue(workConversation.issue_id);
      if (!issue || issue.archived_at || issue.project_id!==workConversation.project_id || !nativeOwned(issue)) fail('native_binding_required');
      if (workConversation.host_id!==hostId) fail('native_host_mismatch');
      if (recorded && (recorded.project_id!==workConversation.project_id || recorded.kind!=='work' || recorded.issue_id!==issue.id || recorded.host_id!==workConversation.host_id)) fail('session_thread_mismatch');
      return {...workConversation,...(workBinding(workConversation) || {})};
    }
    if (recorded) { if (recorded.host_id !== hostId) fail('native_host_mismatch'); return recorded; }
    const project = db.prepare('SELECT * FROM project_native_sessions WHERE thread_id=?').get(threadId);
    if (project && hostId === 'local') return {...project,issue_id:null,host_id:hostId};
    const session = hasTable('issue_sessions') && db.prepare('SELECT * FROM issue_sessions WHERE thread_id=?').get(threadId);
    const issue = session && store.getIssue(session.issue_id);
    if (issue && nativeOwned(issue) && session.host_id === hostId) return {project_id:issue.project_id,kind:'work',issue_id:issue.id,thread_id:threadId,host_id:hostId};
    if (db.prepare("SELECT 1 FROM native_conversation_history WHERE thread_id=? AND kind='work'").get(threadId)) fail('native_history_read_only');
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
      const value={thread_id:session.thread_id,host_id:hostId,project_id:projectId,kind,issue_id:issueId || null,...(session.conversation_id?{conversation_id:session.conversation_id}:{})};
      const key=hostId+':'+session.thread_id, previous=result.get(key);
      if (conflicts.has(key)) return;
      if (previous && (previous.project_id!==value.project_id || previous.kind!==value.kind || previous.issue_id!==value.issue_id)) {result.delete(key);conflicts.add(key);return;}
      result.set(key,value);
    };
    for (const session of db.prepare("SELECT * FROM project_native_conversations WHERE thread_id IS NOT NULL AND status!='closed'").all()) add(session,session.project_id,session.kind,null);
    for (const session of db.prepare("SELECT * FROM issue_native_conversations WHERE thread_id IS NOT NULL AND status!='closed'").all()) {
      const issue=store.getIssue(session.issue_id);
      if (issue && !issue.archived_at && nativeOwned(issue)) add(session,session.project_id,'work',session.issue_id);
    }
    for (const session of db.prepare('SELECT project_id,kind,thread_id FROM project_native_sessions WHERE NOT EXISTS(SELECT 1 FROM project_native_conversations WHERE project_native_conversations.thread_id=project_native_sessions.thread_id)').all()) add(session,session.project_id,session.kind,null);
    if (hasTable('issue_sessions')) for (const session of db.prepare('SELECT issue_id,thread_id,host_id FROM issue_sessions WHERE NOT EXISTS(SELECT 1 FROM issue_native_conversations WHERE issue_native_conversations.thread_id=issue_sessions.thread_id)').all()) {
      const issue=store.getIssue(session.issue_id);
      if (issue && !issue.archived_at && nativeOwned(issue)) add(session,issue.project_id,'work',issue.id);
    }
    return [...result.values()];
  }
  function handleWorkEvent(method,params={}) {
    const threadId=params.threadId || params.thread_id;
    if (!threadId) return null;
    const row=db.prepare('SELECT * FROM issue_native_conversations WHERE thread_id=?').get(threadId);
    if (!row) return null;
    const issue=store.getIssue(row.issue_id);
    if (!issue || issue.archived_at || !nativeOwned(issue) || row.status==='closed') return {changed:false,ignored:true,binding:display(row)};
    const turnId=params.turn?.id || params.turnId || params.turn_id;
    const result=changed=>({changed:Boolean(changed),binding:display(conversation(row.conversation_id)),issue_id:issue.id});
    if (method==='turn/started' && turnId) {
      const mirror=issueSession(issue.id),reserved=pending('work:'+issue.id);
      if (mirror?.thread_id!==threadId || mirror?.active_turn_id && mirror.active_turn_id!==turnId || reserved && reserved.conversation_id && reserved.conversation_id!==row.conversation_id) return {...result(false),ignored:true,error:'issue_execution_running'};
      if (row.last_turn_id===turnId && !row.active_turn_id) return {...result(false),ignored:true};
      const timestamp=now();
      db.prepare("UPDATE issue_native_conversations SET active_turn_id=?,last_turn_id=?,status='running',last_error=NULL,updated_at=? WHERE conversation_id=?").run(turnId,turnId,timestamp,row.conversation_id);
      if (hasTable('project_native_activity')) db.prepare(`INSERT INTO project_native_activity(thread_id,turn_id,status,updated_at) VALUES(?,?,'running',?)
        ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id,status=excluded.status,updated_at=excluded.updated_at`).run(threadId,turnId,timestamp);
      return result(true);
    }
    if (method==='turn/completed') {
      const activity=hasTable('project_native_activity') && db.prepare('SELECT * FROM project_native_activity WHERE thread_id=?').get(threadId);
      if (!turnId || row.active_turn_id!==turnId || activity && activity.turn_id!==turnId) return {...result(false),ignored:true};
      const timestamp=now(),failed=params.turn?.status==='failed';
      db.prepare("UPDATE issue_native_conversations SET active_turn_id=NULL,last_turn_id=?,status=?,last_error=?,updated_at=? WHERE conversation_id=? AND active_turn_id=?")
        .run(turnId,failed?'failed':'ready',params.turn?.error?.message || null,timestamp,row.conversation_id,turnId);
      if (activity) db.prepare("UPDATE project_native_activity SET status='ready',updated_at=? WHERE thread_id=? AND turn_id=?").run(timestamp,threadId,turnId);
      return result(true);
    }
    if (method==='thread/status/changed') {
      const status=params.status?.type;
      const mirror=issueSession(issue.id);
      if (mirror?.thread_id!==threadId) return {...result(false),ignored:true};
      // Status notifications do not identify a turn and can arrive after a
      // completed turn. Only turn/started owns the execution reservation.
      if (row.active_turn_id) return mirror.active_turn_id===row.active_turn_id?result(false):{...result(false),ignored:true};
      if (status!=='idle') return {...result(false),ignored:true};
      db.prepare("UPDATE issue_native_conversations SET status='ready',updated_at=? WHERE conversation_id=?").run(now(),row.conversation_id);
      return result(true);
    }
    return result(false);
  }
  async function tool(args) {
    assertWritable(args);
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
    assertWritable(args);
    if (args.explicit !== true) fail('explicit_restart_required');
    const value = target(args), binding = bindingFor(value);
    if (value.issue && value.conversation?.status==='closed') fail('native_history_read_only');
    const expected = value.issue ? value.issue.version : binding?.revision || 0;
    if (args.expected_revision !== expected) fail('version_conflict');
    if (busyIssue(value.issue) || binding && ['running','active','starting'].includes(binding.status) || pending(value.scope_key)) fail('native_conversation_busy');
    if (!value.issue) assertSelectionFree(value.project.id,value.conversation?.conversation_id);
    if (binding) backup(value,binding);
    let nextId;
    transaction(() => {
      let historyId;
      if (binding) {
        historyId=randomUUID();
        db.prepare('INSERT INTO native_conversation_history(id,project_id,kind,issue_id,thread_id,binding_json,archived_at) VALUES(?,?,?,?,?,?,?)').run(historyId,value.project.id,value.kind,value.issue?.id || null,binding.thread_id,JSON.stringify(binding),now());
        db.prepare('UPDATE native_conversation_bindings SET archived_at=? WHERE thread_id=?').run(now(),binding.thread_id);
      }
      if (value.issue) {
        const generation=(value.conversation?.generation ?? db.prepare('SELECT generation FROM native_conversation_scopes WHERE scope_key=?').get(value.scope_key)?.generation ?? 0)+1;
        if (value.conversation) db.prepare("UPDATE issue_native_conversations SET status='closed',selected=0,active_turn_id=NULL,history_id=?,updated_at=? WHERE conversation_id=?")
          .run(historyId || null,now(),value.conversation.conversation_id);
        // Remove only the execution mirror of the archived conversation.
        if (binding) db.prepare('DELETE FROM issue_sessions WHERE issue_id=? AND thread_id=?').run(value.issue.id,binding.thread_id);
        db.prepare('UPDATE issue_native_conversations SET selected=0 WHERE issue_id=?').run(value.issue.id);
        const row=insertWorkConversation(value.issue,{selected:true,generation,title:value.conversation?.title || value.issue.title});nextId=row.conversation_id;
        db.prepare('INSERT INTO native_conversation_scopes(scope_key,generation) VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET generation=excluded.generation').run(value.scope_key,generation);
      }
      else {
        if (value.conversation) db.prepare("UPDATE project_native_conversations SET status='closed',selected=0,updated_at=? WHERE conversation_id=?").run(now(),value.conversation.conversation_id);
        db.prepare('UPDATE project_native_conversations SET selected=0 WHERE project_id=?').run(value.project.id);
        const row=insertConversation(value.project.id,value.kind,{selected:true,generation:(value.conversation?.generation || 0)+1});nextId=row.conversation_id;mirrorConversation(row);
      }
    }); publishChange(); return readContext({...args,...(nextId?{conversation_id:nextId}:{})});
  }
  function blockingStatus() { recoverStale(); return {pending_bindings:db.prepare(`SELECT COUNT(*) AS count FROM native_conversation_operations WHERE status IN ('prepared','allocated','bound')`).get().count}; }
  async function handle({url,method,request,response,readBody,sendJson}) {
    if (!url.pathname.startsWith('/api/native-conversations/')) return false;
    const endpoint = url.pathname.slice('/api/native-conversations/'.length);
    let result;
    if (endpoint === 'context' && method === 'GET') result = readContext(Object.fromEntries(url.searchParams));
    else if (endpoint === 'list' && method === 'GET') {
      const kind=url.searchParams.get('kind');
      if (kind && !['charter','planning','work'].includes(kind)) fail('invalid_session_kind');
      result=kind==='work'?listWorkConversations(url.searchParams.get('project_id'),url.searchParams.get('issue_id')):listConversations(url.searchParams.get('project_id'));
    }
    else if (method === 'POST') {
      const args = await readBody(request);
      if (endpoint === 'prepare') result = prepare(args);
      else if (endpoint === 'bind') result = bind(args);
      else if (endpoint === 'receipt') result = receipt(args);
      else if (endpoint === 'tool') result = await tool(args);
      else if (endpoint === 'restart') result = restart(args);
      else if (endpoint === 'create') result = createConversation(args);
      else if (endpoint === 'select') result = selectConversation(args);
      else {sendJson(response,404,{error:'not_found'});return true;}
    } else {sendJson(response,404,{error:'not_found'});return true;}
    sendJson(response,200,result);return true;
  }
  return {readContext,prepare,bind,receipt,tool,restart,handle,busyIssue,operation,pending,blockingStatus,recoverRelay,recoverStale,listBindings,listConversations,listWorkConversations,createConversation,selectConversation,trustedBinding,handleWorkEvent,migrateWorkConversations};
}
module.exports = {ensureConversationTables,ensurePlanningConversationTables,createNativeConversationRuntime};

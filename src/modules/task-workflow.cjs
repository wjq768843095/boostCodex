'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

function createTaskWorkflow({ store }) {
  const db = store.db, now = () => new Date().toISOString();
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const table = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const columns = name => new Set(db.prepare('PRAGMA table_info('+name+')').all().map(row => row.name));
  db.exec(`CREATE TABLE IF NOT EXISTS issue_task_workflow (
    issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, result TEXT, task_version INTEGER NOT NULL,
    summary TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]',
    pending_manual_json TEXT NOT NULL DEFAULT '[]', reports_json TEXT NOT NULL DEFAULT '{}',
    blocked_from_status TEXT, thread_id TEXT, turn_id TEXT, scope_hash TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issue_task_workflow_events (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    action TEXT NOT NULL, actor TEXT NOT NULL, task_version INTEGER NOT NULL,
    report_json TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  if (!columns('issue_task_workflow').has('scope_hash')) db.exec('ALTER TABLE issue_task_workflow ADD COLUMN scope_hash TEXT');
  const issue = id => store.getIssue ? store.getIssue(id) : db.prepare('SELECT * FROM issues WHERE id=?').get(id);
  function scopeHash(task) {
    const project=typeof store.getProject==='function'?store.getProject(task.project_id):null;
    const link=table('project_planning_issue_links')?db.prepare('SELECT * FROM project_planning_issue_links WHERE issue_id=?').get(task.id):null;
    const scope={title:task.title || '',description:task.description || '',project_id:task.project_id || '',workspace_path:task.workspace_path || project?.workspace_path || '',
      charter_revision:link?.charter_revision ?? null,plan_revision:link?.plan_revision ?? null,item_json:link?.item_json ?? null};
    return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  }
  function get(id) {
    const row = db.prepare('SELECT * FROM issue_task_workflow WHERE issue_id=?').get(id);
    if (!row) return null;
    const {evidence_json,pending_manual_json,reports_json,...value}=row;
    const task=issue(id);
    return {...value,evidence_valid:Boolean(task && value.result!=='scope_changed' && value.scope_hash && value.scope_hash===scopeHash(task)),evidence:JSON.parse(evidence_json),pending_manual:JSON.parse(pending_manual_json),reports:JSON.parse(reports_json)};
  }
  function ensure(id) {
    const task=issue(id); if (!task) fail('issue_not_found');
    const stage=task.status==='in_review'?'review':task.status==='in_progress'?'development':task.status==='done'?'completed':'todo';
    const scope=scopeHash(task);
    const legacy=task.status==='in_review'?{legacy_review:{task_version:task.version,status:task.status,scope_hash:scope,summary:'existing review task; verification required',evidence:[]}}:{};
    db.prepare(`INSERT OR IGNORE INTO issue_task_workflow(issue_id,stage,result,task_version,reports_json,scope_hash,updated_at) VALUES(?,?,?,?,?,?,?)`).run(id,stage,task.status==='in_review'?'legacy_review':null,task.version,JSON.stringify(legacy),scope,now());
    return get(id);
  }
  const strings = (input, name) => {
    if (!Array.isArray(input) || input.length>100 || input.some(value=>typeof value!=='string' || !value.trim() || value.length>8000)) fail('invalid_'+name);
    return [...new Set(input.map(value=>value.trim()))];
  };
  function active(id) {
    const sessions=table('issue_sessions')?db.prepare('SELECT * FROM issue_sessions WHERE issue_id=?').all(id):[];
    const work=table('issue_native_conversations')?db.prepare("SELECT * FROM issue_native_conversations WHERE issue_id=? AND status!='closed'").all(id):[];
    const turns=[...sessions,...work].filter(row=>row.active_turn_id);
    const runs=table('issue_runs')?db.prepare("SELECT 1 FROM issue_runs WHERE issue_id=? AND status IN ('claimed','running','scheduling')").get(id):null;
    return {sessions,work,turns,busy:Boolean(turns.length || runs || sessions.some(row=>['starting','active','stopping','waiting_on_user','waiting_on_approval'].includes(row.status)))};
  }
  function writeTask(task, status, timestamp) {
    const allowed=columns('issues'), assignments=['status=?','version=version+1'],values=[status];
    if (allowed.has('needs_attention')) assignments.push('needs_attention=0');
    if (allowed.has('pending_actor')) assignments.push("pending_actor='user'");
    if (allowed.has('updated_at')) {assignments.push('updated_at=?');values.push(timestamp);}
    const result=db.prepare('UPDATE issues SET '+assignments.join(',')+' WHERE id=? AND version=?').run(...values,task.id,task.version);
    if (result.changes!==1) fail('version_conflict');
    return issue(task.id);
  }
  function transition(args, {actor}={}) {
    if (!['skill','user'].includes(actor)) fail('invalid_workflow_actor');
    if (!args || typeof args.issue_id!=='string') fail('invalid_issue_id');
    if (!Number.isSafeInteger(args.expected_version) || args.expected_version<1) fail('invalid_version');
    if (typeof args.summary!=='string' || !args.summary.trim() || args.summary.length>8000) fail('workflow_summary_required');
    const evidence=args.evidence===undefined?[]:strings(args.evidence,'evidence');
    const pending=args.pending_manual===undefined?null:strings(args.pending_manual,'pending_manual');
    db.exec('BEGIN IMMEDIATE');
    try {
      const task=issue(args.issue_id);if (!task) fail('issue_not_found');
      if (task.archived_at) fail('issue_archived');
      if (task.version!==args.expected_version) fail('version_conflict');
      const activity=active(task.id),thread=args.thread_id;
      if (actor==='skill' && !thread) fail('workflow_thread_required');
      if (thread) {
        if (table('native_conversation_unbindings') && db.prepare('SELECT 1 FROM native_conversation_unbindings WHERE thread_id=?').get(thread)) fail('native_conversation_unbound');
        const binding=table('native_conversation_bindings')?db.prepare("SELECT * FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL").get(thread):null;
        if (binding && (binding.issue_id!==task.id || binding.kind!=='work')) fail('session_thread_mismatch');
        const known=activity.work.find(row=>row.thread_id===thread && row.status!=='closed') || activity.sessions.find(row=>row.thread_id===thread);
        if (!binding && !known || activity.turns.some(row=>row.thread_id!==thread)) fail('session_thread_mismatch');
        if (activity.work.length && !activity.work.some(row=>row.thread_id===thread && row.selected)) fail('session_thread_mismatch');
        const mirrored=activity.sessions[0];
        if (mirrored && mirrored.thread_id!==thread) fail('session_thread_mismatch');
      } else if (activity.busy) fail('issue_execution_running');
      const current=ensure(task.id),stage=current.stage,result=current.result;
      const scope=scopeHash(task),validReport=action=>current.reports[action]?.scope_hash===scope;
      if (task.status==='done') fail('workflow_transition_invalid');
      let status=task.status,nextStage=stage,nextResult=result,blockedFrom=current.blocked_from_status;
      const manual=pending===null?current.pending_manual:pending;
      if (args.action!=='accept' && current.pending_manual.some(entry=>!manual.includes(entry))) fail('pending_manual_acceptance_required');
      switch(args.action) {
        case 'start_development':
          if (task.status==='done' || task.status==='blocked') fail('workflow_transition_invalid');
          status='in_progress';nextStage='development';nextResult=null;break;
        case 'development_complete':
          if (stage!=='development' || task.status==='blocked' || !validReport('start_development')) fail('workflow_development_required');
          if (!evidence.length) fail('workflow_evidence_required');
          status='in_review';nextStage='review';nextResult='development_complete';break;
        case 'start_review':
          if (stage!=='review' || task.status==='blocked' || !(validReport('development_complete') || validReport('legacy_review'))) fail('workflow_development_required');
          status='in_review';nextResult='reviewing';break;
        case 'review_passed':
        case 'review_failed':
          if (stage!=='review' || task.status==='blocked' || !current.evidence_valid || !(validReport('development_complete') || validReport('legacy_review') && validReport('start_review')) || !['development_complete','reviewing'].includes(result)) fail('workflow_review_required');
          if (!evidence.length) fail('workflow_evidence_required');
          nextResult=args.action;
          if (args.action==='review_passed') status=manual.length?'in_review':'done';
          else {status='in_progress';nextStage='development';}
          break;
        case 'block':
          if (task.status==='done') fail('workflow_transition_invalid');
          blockedFrom=task.status==='blocked'?blockedFrom:task.status;status='blocked';break;
        case 'resume':
          if (task.status!=='blocked' || !blockedFrom) fail('workflow_transition_invalid');
          status=blockedFrom;blockedFrom=null;break;
        case 'accept':
          if (actor!=='user') fail('workflow_user_acceptance_required');
          if (activity.busy) fail('issue_execution_running');
          if (task.status!=='in_review' || result!=='review_passed' || !current.pending_manual.length || !current.evidence_valid || !validReport('review_passed') || !current.reports.review_passed.evidence?.length) fail('workflow_acceptance_required');
          status='done';nextResult='accepted';break;
        default:fail('invalid_workflow_action');
      }
      const timestamp=now(),saved=writeTask(task,status,timestamp),turn=activity.turns.find(row=>row.thread_id===thread)?.active_turn_id || null;
      const report={summary:args.summary.trim(),evidence,pending_manual:args.action==='accept'?[]:manual,task_version:saved.version,scope_hash:scope,thread_id:thread || null,turn_id:turn,updated_at:timestamp};
      const reports={...current.reports,[args.action]:report};
      db.prepare(`UPDATE issue_task_workflow SET stage=?,result=?,task_version=?,summary=?,evidence_json=?,pending_manual_json=?,reports_json=?,blocked_from_status=?,thread_id=?,turn_id=?,scope_hash=?,updated_at=? WHERE issue_id=?`).run(nextStage,nextResult,saved.version,report.summary,JSON.stringify(evidence),JSON.stringify(report.pending_manual),JSON.stringify(reports),blockedFrom,thread || null,turn,scope,timestamp,task.id);
      db.prepare('INSERT INTO issue_task_workflow_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),task.id,args.action,actor,saved.version,JSON.stringify(report),timestamp);
      db.exec('COMMIT');return {task:{id:saved.id,status:saved.status,version:saved.version},workflow:get(task.id)};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  // Lifecycle errors retain development/review reports; ordinary interruption has no business meaning.
  function turnFailed(id, thread, turn, reason) {
    if (table('native_conversation_unbindings') && db.prepare('SELECT 1 FROM native_conversation_unbindings WHERE thread_id=?').get(thread)) return;
    const current=get(id),task=issue(id);if (!current || !task || task.archived_at || task.status==='done') return;
    const mirror=active(id).sessions.find(row=>row.thread_id===thread);
    if (!mirror || (mirror.active_turn_id || mirror.last_turn_id)!==turn) return;
    const timestamp=now(),previous=task.status==='blocked'?current.blocked_from_status:task.status;
    const saved=writeTask(task,'blocked',timestamp);
    db.prepare('UPDATE issue_task_workflow SET blocked_from_status=?,task_version=?,updated_at=? WHERE issue_id=?').run(previous,saved.version,timestamp,id);
    db.prepare('INSERT INTO issue_task_workflow_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,'turn_failed','runtime',saved.version,JSON.stringify({summary:reason || 'session_turn_failed',thread_id:thread,turn_id:turn}),timestamp);
  }
  function manualStatus(previous, saved) {
    const current=get(saved.id);if (!current) return;
    const timestamp=now(),scope=scopeHash(saved),scopeChanged=scopeHash(previous)!==scope || Boolean(current.scope_hash && current.scope_hash!==scope);
    let stage=current.stage,result=current.result,blocked=previous.status!==saved.status && saved.status==='blocked'?previous.status:current.blocked_from_status;
    let evidence=current.evidence,summary=current.summary,reports=current.reports;
    if (scopeChanged) {
      // The original PATCH already incremented version; invalidate in that same write transaction.
      const status=saved.status==='blocked'?'blocked':'todo',allowed=columns('issues');
      const setters=['status=?'];if(allowed.has('needs_attention'))setters.push('needs_attention=0');if(allowed.has('pending_actor'))setters.push("pending_actor='user'");
      db.prepare('UPDATE issues SET '+setters.join(',')+' WHERE id=? AND version=?').run(status,saved.id,saved.version);
      Object.assign(saved,issue(saved.id));stage='todo';result='scope_changed';evidence=[];summary='Task scope changed; development and review required';if(status==='blocked')blocked='todo';
      const report={summary,scope_hash:scope,previous_scope_hash:current.scope_hash,task_version:saved.version,pending_manual:current.pending_manual,updated_at:timestamp};
      reports={...reports,scope_invalidated:report};
      db.prepare('INSERT INTO issue_task_workflow_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),saved.id,'scope_invalidated','user',saved.version,JSON.stringify(report),timestamp);
    } else if (previous.status!==saved.status && saved.status!=='blocked') {
      stage=saved.status==='in_progress'?'development':saved.status==='in_review'?'review':saved.status==='done'?'completed':'todo';
      // Moving a card changes its stage, not its development/review evidence.
      if (saved.status!=='in_review' || !['development_complete','reviewing','review_passed'].includes(result)) {result=null;evidence=[];}
      blocked=null;
    }
    db.prepare('UPDATE issue_task_workflow SET stage=?,result=?,task_version=?,summary=?,evidence_json=?,reports_json=?,blocked_from_status=?,scope_hash=?,updated_at=? WHERE issue_id=?').run(stage,result,saved.version,summary,JSON.stringify(evidence),JSON.stringify(reports),blocked,scope,timestamp,saved.id);
    return saved;
  }
  function migratePlanningTasks(home) {
    if (!table('project_planning_issue_links')) return {migrated:0,backup_path:null};
    db.exec('BEGIN IMMEDIATE');
    try {
      const candidates=db.prepare("SELECT DISTINCT issues.id FROM issues JOIN project_planning_issue_links ON project_planning_issue_links.issue_id=issues.id WHERE issues.status='backlog'").all().map(row=>issue(row.id)).filter(task=>{
        const activity=active(task.id);
        return !task.archived_at && !task.run_thread_id && !task.active_run_status && !activity.busy && ![...activity.sessions,...activity.work].some(row=>row.last_turn_id) &&
          !(table('issue_runs') && db.prepare('SELECT 1 FROM issue_runs WHERE issue_id=?').get(task.id)) &&
          !(table('issue_replies') && db.prepare('SELECT 1 FROM issue_replies WHERE issue_id=? AND started_at IS NOT NULL').get(task.id));
      });
      let backup=null;
      if (candidates.length) {
        if (!home || !path.isAbsolute(home)) fail('workflow_backup_home_required');
        const folder=path.join(home,'backups','task-workflow');fs.mkdirSync(folder,{recursive:true});
        backup=path.join(folder,now().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json');
        const metadata=candidates.map(task=>({id:task.id,project_id:task.project_id,status:task.status,version:task.version,needs_attention:task.needs_attention ?? null,pending_actor:task.pending_actor ?? null,updated_at:task.updated_at ?? null,workflow:get(task.id)}));
        fs.writeFileSync(backup,JSON.stringify({kind:'planning_backlog_to_todo',created_at:now(),tasks:metadata},null,2),{flag:'wx',mode:0o600});
        if (!fs.statSync(backup).size || JSON.parse(fs.readFileSync(backup,'utf8')).tasks.length!==candidates.length) fail('workflow_backup_failed');
        for (const task of candidates) {const saved=writeTask(task,'todo',now());ensure(saved.id);db.prepare('UPDATE issue_task_workflow SET task_version=? WHERE issue_id=?').run(saved.version,saved.id);}
      }
      db.exec('COMMIT');return {migrated:candidates.length,backup_path:backup};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  return {get,ensure,transition,migratePlanningTasks,turnFailed,manualStatus};
}
module.exports={createTaskWorkflow};

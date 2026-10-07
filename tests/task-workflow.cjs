'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {createTaskWorkflow}=require('../src/modules/task-workflow.cjs');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'bc-task-workflow-'));
const db=new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE issues(id TEXT PRIMARY KEY,project_id TEXT,status TEXT,version INTEGER,needs_attention INTEGER,pending_actor TEXT,archived_at TEXT,updated_at TEXT);
CREATE TABLE issue_sessions(issue_id TEXT PRIMARY KEY,thread_id TEXT,status TEXT,active_turn_id TEXT,active_command_id TEXT,last_turn_id TEXT,last_agent_message TEXT,last_error TEXT,retry_json TEXT,updated_at TEXT);
CREATE TABLE issue_native_conversations(conversation_id TEXT PRIMARY KEY,issue_id TEXT,thread_id TEXT,status TEXT,selected INTEGER,active_turn_id TEXT,last_turn_id TEXT);
CREATE TABLE native_conversation_bindings(thread_id TEXT PRIMARY KEY,issue_id TEXT,kind TEXT,archived_at TEXT);
CREATE TABLE native_conversation_unbindings(thread_id TEXT PRIMARY KEY);
CREATE TABLE issue_runs(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT,turn_id TEXT,thread_id TEXT,execution_mode TEXT,pid INTEGER,finished_at TEXT,error TEXT,execution_error TEXT,execution_result TEXT,scheduler_pid INTEGER,scheduler_status TEXT,scheduler_error TEXT,scheduler_result TEXT);
CREATE TABLE issue_replies(issue_id TEXT PRIMARY KEY,request_id TEXT,status TEXT,message TEXT,error TEXT,started_at TEXT,finished_at TEXT);
CREATE TABLE session_commands(id TEXT PRIMARY KEY,issue_id TEXT,run_id TEXT,kind TEXT,turn_id TEXT,status TEXT,cancel_requested INTEGER,thread_id TEXT);
CREATE TABLE project_planning_issue_links(issue_id TEXT PRIMARY KEY);
ALTER TABLE issues ADD COLUMN title TEXT;
ALTER TABLE issues ADD COLUMN description TEXT;
ALTER TABLE issues ADD COLUMN workspace_path TEXT;
ALTER TABLE issues ADD COLUMN priority TEXT;
ALTER TABLE issues ADD COLUMN labels_json TEXT;
ALTER TABLE issues ADD COLUMN sort_order INTEGER;
`);
const store={db,getIssue:id=>db.prepare('SELECT * FROM issues WHERE id=?').get(id),transaction(fn){db.exec('BEGIN IMMEDIATE');try {const result=fn();db.exec('COMMIT');return result;} catch(error){db.exec('ROLLBACK');throw error;}}};
store.taskWorkflow=createTaskWorkflow({store});
const workflow=store.taskWorkflow;
function task(id,status='todo') {db.prepare("INSERT INTO issues(id,project_id,status,version,needs_attention,pending_actor,archived_at,updated_at,title,description,workspace_path) VALUES(?,'p',?,1,1,'agent',NULL,'2026-01-01','task','original scope','D:/fixture')").run(id,status);}
function bind(id,thread) {
  db.prepare("INSERT INTO issue_sessions VALUES(?,?,'idle',NULL,NULL,NULL,'',NULL,NULL,'2026-01-01')").run(id,thread);
  db.prepare("INSERT INTO issue_native_conversations VALUES(?,?,?,'ready',1,NULL,NULL)").run('conversation-'+id,id,thread);
  db.prepare("INSERT INTO native_conversation_bindings VALUES(?,?,'work',NULL)").run(thread,id);
}
const transition=(id,action,extra={},actor='skill')=>workflow.transition({issue_id:id,thread_id:'thread-'+id,expected_version:store.getIssue(id).version,action,summary:action,...extra},{actor});
const throws=(fn,code)=>assert.throws(fn,error=>error.message===code,code);
function edit(id,patch) {
  return store.transaction(()=>{
    const previous=store.getIssue(id),keys=Object.keys(patch);
    db.prepare('UPDATE issues SET '+keys.map(key=>key+'=?').join(',')+',version=version+1 WHERE id=? AND version=?').run(...keys.map(key=>patch[key]),id,previous.version);
    const saved=store.getIssue(id);workflow.manualStatus(previous,saved);return saved;
  });
}
function pendingReview(id) {
  task(id);bind(id,'thread-'+id);transition(id,'start_development');
  transition(id,'development_complete',{evidence:['implementation verified'],pending_manual:['device acceptance']});
  return transition(id,'review_passed',{evidence:['review checked against scope']});
}

// Exercise actual Store lifecycle methods without starting a Runtime or model process.
const source=fs.readFileSync(path.join(__dirname,'../src/backend/better-codex.cjs'),'utf8');
function method(name) {
  const start=source.indexOf('      '+name+'('),end=source.indexOf('\n      }',start)+8;
  assert.ok(start>=0 && end>start,name);
  return new Function('now','return ({'+source.slice(start,end)+'});')(()=>new Date().toISOString())[name];
}
for(const name of ['sessionTurnStarted','completeSessionTurn','finalizeScheduler']) store[name]=method(name);
try {
  task('discussion');bind('discussion','thread-discussion');
  const initial=store.getIssue('discussion').version;
  store.sessionTurnStarted('thread-discussion','discussion-turn');
  assert.equal(store.getIssue('discussion').status,'todo');assert.equal(store.getIssue('discussion').version,initial);
  const discussion=store.completeSessionTurn('thread-discussion','discussion-turn','completed');
  assert.equal(discussion.should_schedule,false);assert.equal(store.getIssue('discussion').status,'todo');
  task('a');bind('a','thread-a');task('b');bind('b','thread-b');
  workflow.ensure('a');
  throws(()=>transition('a','development_complete',{evidence:['check']}),'workflow_development_required');
  throws(()=>transition('a','start_development',{thread_id:'thread-b'}),'session_thread_mismatch');
  throws(()=>transition('a','start_development',{expected_version:999}),'version_conflict');
  store.sessionTurnStarted('thread-a','turn-a');
  transition('a','start_development');
  transition('a','development_complete',{evidence:['fixture API result'],pending_manual:['device acceptance']});
  transition('a','start_review');
  throws(()=>transition('a','review_passed',{evidence:[]}), 'workflow_evidence_required');
  throws(()=>transition('a','review_passed',{evidence:['review result'],pending_manual:[]}), 'pending_manual_acceptance_required');
  const review=transition('a','review_passed',{evidence:['review result']});
  assert.equal(review.task.status,'in_review');assert.equal(review.workflow.result,'review_passed');
  throws(()=>transition('a','accept',{},'skill'),'workflow_user_acceptance_required');
  throws(()=>transition('a','accept',{},'user'),'issue_execution_running');
  const reviewVersion=review.task.version;
  store.completeSessionTurn('thread-a','turn-a','completed');
  assert.equal(store.getIssue('a').version,reviewVersion);assert.equal(workflow.get('a').result,'review_passed');
  assert.equal(transition('a','accept',{},'user').task.status,'done');
  assert.ok(workflow.get('a').reports.development_complete);assert.deepEqual(workflow.get('a').pending_manual,[]);
  task('fix');bind('fix','thread-fix');store.sessionTurnStarted('thread-fix','turn-fix');
  transition('fix','start_development');transition('fix','development_complete',{evidence:['first implementation']});
  transition('fix','review_failed',{evidence:['reproduced defect']});
  assert.equal(store.getIssue('fix').status,'in_progress');assert.equal(store.getIssue('fix').needs_attention,0);
  transition('fix','block');assert.equal(store.getIssue('fix').status,'blocked');
  transition('fix','resume');assert.equal(store.getIssue('fix').status,'in_progress');
  transition('fix','development_complete',{evidence:['fixed defect']});
  transition('fix','review_passed',{evidence:['review and tests passed']});
  const doneVersion=store.getIssue('fix').version;
  store.completeSessionTurn('thread-fix','turn-fix','completed');
  assert.equal(store.getIssue('fix').status,'done');assert.equal(store.getIssue('fix').version,doneVersion);
  task('stop');bind('stop','thread-stop');store.sessionTurnStarted('thread-stop','turn-stop');transition('stop','start_development');
  store.completeSessionTurn('thread-stop','turn-stop','interrupted','user_stopped');assert.equal(store.getIssue('stop').status,'in_progress');
  store.sessionTurnStarted('thread-stop','turn-failed');
  store.completeSessionTurn('thread-stop','turn-failed','failed','connection failed');
  assert.equal(store.getIssue('stop').status,'blocked');assert.ok(workflow.get('stop').reports.start_development);
  throws(()=>transition('stop','resume',{thread_id:'thread-b'}),'session_thread_mismatch');
  transition('stop','resume');assert.equal(store.getIssue('stop').status,'in_progress');
  db.prepare("INSERT INTO issue_runs(id,issue_id,status,execution_error) VALUES('scheduler','stop','scheduling',NULL)").run();
  const beforeScheduler=store.getIssue('stop');store.finalizeScheduler('scheduler','stop',true,{status:'done'},null);
  assert.deepEqual(store.getIssue('stop'),beforeScheduler);
  task('legacy-review','in_review');bind('legacy-review','thread-legacy-review');workflow.ensure('legacy-review');
  assert.equal(workflow.get('legacy-review').result,'legacy_review');assert.equal(store.getIssue('legacy-review').status,'in_review');
  throws(()=>transition('legacy-review','review_passed',{evidence:['real review result']}),'workflow_review_required');
  transition('legacy-review','start_review');
  transition('legacy-review','review_passed',{evidence:['real test result'],pending_manual:['manual demonstration']});
  transition('legacy-review','start_review');
  transition('legacy-review','review_passed',{evidence:['repeated technical checks'],pending_manual:['manual demonstration','second demonstration']});
  assert.equal(workflow.get('legacy-review').pending_manual.length,2);
  task('legacy-dev','in_progress');bind('legacy-dev','thread-legacy-dev');workflow.ensure('legacy-dev');
  assert.equal(workflow.get('legacy-dev').stage,'development');
  throws(()=>transition('legacy-dev','development_complete',{evidence:['implementation']}),'workflow_development_required');
  for(const [index,patch] of [{title:'changed title'},{description:'additional operation required'},{project_id:'other-project'},{workspace_path:'D:/other-workspace'}].entries()) {
    const id='scope-'+index,review=pendingReview(id),snapshot=review.workflow.reports.review_passed;
    const saved=edit(id,patch);
    assert.equal(saved.status,'todo');assert.equal(workflow.get(id).stage,'todo');assert.equal(workflow.get(id).result,'scope_changed');
    assert.equal(workflow.get(id).evidence_valid,false);assert.deepEqual(workflow.get(id).evidence,[]);
    assert.deepEqual(workflow.get(id).reports.review_passed,snapshot);assert.deepEqual(workflow.get(id).pending_manual,['device acceptance']);
    throws(()=>transition(id,'accept',{},'user'),'workflow_acceptance_required');
    throws(()=>transition(id,'development_complete',{evidence:['old result']}),'workflow_development_required');
    edit(id,{status:'in_review'});
    assert.equal(workflow.get(id).stage,'review');
    throws(()=>transition(id,'start_review'),'workflow_development_required');
    transition(id,'start_development');transition(id,'development_complete',{evidence:['new scope implementation verified']});
    transition(id,'review_passed',{evidence:['new scope reviewed']});
    assert.equal(transition(id,'accept',{},'user').task.status,'done');
  }
  const unaffected=pendingReview('metadata'),technical=unaffected.workflow.reports.review_passed;
  edit('metadata',{priority:'high',labels_json:'["focus"]',sort_order:999});
  assert.equal(workflow.get('metadata').result,'review_passed');assert.equal(workflow.get('metadata').evidence_valid,true);
  assert.deepEqual(workflow.get('metadata').reports.review_passed,technical);
  assert.equal(transition('metadata','accept',{},'user').task.status,'done');
  pendingReview('scope-bypass');db.prepare("UPDATE issues SET description='changed outside editor',version=version+1 WHERE id='scope-bypass'").run();
  assert.equal(workflow.get('scope-bypass').evidence_valid,false);
  throws(()=>transition('scope-bypass','accept',{},'user'),'workflow_acceptance_required');
  task('drag');bind('drag','thread-drag');workflow.ensure('drag');
  edit('drag',{status:'in_progress'});assert.equal(workflow.get('drag').stage,'development');
  edit('drag',{status:'in_review'});assert.equal(workflow.get('drag').stage,'review');
  assert.equal(workflow.get('drag').reports.development_complete,undefined);
  throws(()=>transition('drag','review_passed',{evidence:['cannot invent completion']}),'workflow_review_required');
  task('migrate','backlog');task('unlinked','backlog');task('archived','backlog');task('running','backlog');task('history','backlog');
  for(const id of ['migrate','archived','running','history'])db.prepare('INSERT INTO project_planning_issue_links VALUES(?)').run(id);
  db.prepare("UPDATE issues SET archived_at='archived' WHERE id='archived'").run();
  bind('running','thread-running');db.prepare("UPDATE issue_sessions SET active_turn_id='busy',status='active' WHERE issue_id='running'").run();
  db.prepare("INSERT INTO issue_runs(id,issue_id,status) VALUES('old','history','completed')").run();
  throws(()=>workflow.migratePlanningTasks('relative-home'),'workflow_backup_home_required');assert.equal(store.getIssue('migrate').status,'backlog');
  const migrated=workflow.migratePlanningTasks(home);assert.equal(migrated.migrated,1);
  assert.ok(fs.statSync(migrated.backup_path).size);
  const backup=JSON.parse(fs.readFileSync(migrated.backup_path,'utf8'));assert.deepEqual(backup.tasks.map(row=>row.id),['migrate']);
  assert.equal(store.getIssue('migrate').status,'todo');assert.equal(store.getIssue('migrate').needs_attention,0);assert.equal(store.getIssue('migrate').pending_actor,'user');
  assert.equal(workflow.migratePlanningTasks(home).migrated,0);
  for(const id of ['unlinked','archived','running','history'])assert.equal(store.getIssue(id).status,'backlog');
  console.log('task workflow: stage gates, concurrent threads, lifecycle preservation, scheduler isolation, scoped migration passed');
} finally {db.close();fs.rmSync(home,{recursive:true,force:true});}

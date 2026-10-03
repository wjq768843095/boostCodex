'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./native-project-runtime.cjs');

async function run() {
  const f=createFixture(),{store,runtime,api}=f,db=store.db;
  const post=(name,args)=>api('/api/native-conversations/'+name,'POST',args);
  const list=()=>api('/api/native-conversations/list?project_id=p1&kind=work');
  const read=args=>api('/api/native-conversations/context?'+new URLSearchParams(args));
  const work=(issueId,requestId,generation=0)=>({project_id:'p1',kind:'work',issue_id:issueId,request_id:requestId,expected_revision:store.getIssue(issueId).version,
    draft_generation:generation,relay_id:'relay-leader',host_id:'local'});
  const bind=async(args,threadId)=>{
    await post('prepare',args);await post('bind',{...args,thread_id:threadId,checkpoint:'allocated'});
    await post('bind',{...args,thread_id:threadId,checkpoint:'bound'});
    await post('receipt',{...args,thread_id:threadId,status:'failed',error:'fixture deliberately sends no model turn'});
  };
  const history=(id,issueId,threadId,snapshot={},projectId='p1',kind='work')=>db.prepare('INSERT INTO native_conversation_history VALUES(?,?,?,?,?,?,?)')
    .run(id,projectId,kind,issueId,threadId,typeof snapshot==='string'?snapshot:JSON.stringify(snapshot),'2001-01-01T00:00:00Z');
  const snapshot=()=>JSON.stringify(Object.fromEntries(['issues','issue_sessions','issue_native_ownership','native_conversation_bindings','native_conversation_history',
    'native_conversation_operations','native_conversation_scopes','native_conversation_tool_calls','project_charter_revisions','project_planning_revisions','project_planning_issue_links',
    'project_native_sessions','project_native_conversations','project_native_commands','project_native_activity','issue_runs','issue_replies','session_commands']
    .map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])));
  try {
    db.exec(`CREATE TABLE issue_sessions(issue_id TEXT PRIMARY KEY REFERENCES issues(id),host_id TEXT DEFAULT 'local',thread_id TEXT UNIQUE,
      status TEXT DEFAULT 'idle',active_turn_id TEXT,active_command_id TEXT,last_turn_id TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE issue_replies(issue_id TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE issue_runs(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT);
      CREATE TABLE session_commands(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT);`);
    await f.startAndBind('p1','charter','history-charter');
    await api('/api/project-tools/project_charter_save','POST',f.charterArgs('p1','history-charter'));
    f.userMessage('history-charter','history-confirm','确认总纲');
    await api('/api/project-tools/project_charter_confirm','POST',{project_id:'p1',thread_id:'history-charter',expected_revision:1,message_id:'history-confirm'});
    await f.startAndBind('p1','planning','history-plan');
    await api('/api/project-tools/project_plan_save','POST',{project_id:'p1',thread_id:'history-plan',expected_revision:0,charter_revision:2,items:[f.item()]});
    const converted=(await api('/api/projects/p1/plan/convert','POST',{expected_revision:1,item_ids:['deliver-login']})).value;
    const issue=converted.issues[0];
    await api('/api/project-tools/project_plan_save','POST',{project_id:'p1',thread_id:'history-plan',expected_revision:1,charter_revision:2,items:[f.item({title:'后续规划资料'})]});
    await api('/api/project-tools/project_charter_save','POST',f.charterArgs('p1','history-charter',{expected_revision:2,sections:[{id:'api',title:'后续契约',content:'较新草稿'}]}));
    await bind(work(issue.id,'history-first'),'historical-work');
    const restarted=(await post('restart',{project_id:'p1',kind:'work',issue_id:issue.id,expected_revision:issue.version,explicit:true})).value;
    assert.equal(restarted.mode,'draft');assert.equal(restarted.draft_generation,1);
    const old=db.prepare("SELECT * FROM native_conversation_history WHERE thread_id='historical-work'").get();
    await bind(work(issue.id,'history-current',1),'current-work');
    store.createIssue({id:'empty-work',projectId:'p1',title:'未发送任务',description:'空白草稿',status:'backlog',agentEnabled:true});
    store.createIssue({id:'legacy-work',projectId:'p1',title:'旧任务执行中',description:'保留旧执行器',status:'in_progress',agentEnabled:true});
    db.prepare("INSERT INTO issue_sessions(issue_id,host_id,thread_id,status,active_turn_id,created_at,updated_at) VALUES('legacy-work','local','legacy-thread','active','legacy-turn','2000','2000')").run();
    db.prepare("INSERT INTO issue_runs VALUES('legacy-run','legacy-work','running')").run();
    store.createIssue({id:'foreign-work',projectId:'p2',title:'另一项目',description:'隔离',status:'backlog',agentEnabled:true});
    for (const [index,damaged] of ['','broken JSON','null','[]'].entries()) history('damaged-work-'+index,issue.id,'damaged-thread-'+index,damaged);
    history('snapshot-mismatch',issue.id,'wrong-snapshot',{thread_id:'some-other-thread'});
    history('current-conflict',issue.id,'current-work');
    history('foreign-history','foreign-work','foreign-history-thread',{},'p2');
    history('planning-history',null,'planning-history-thread',{},'p1','planning');
    history('metadata-conflict',issue.id,'metadata-conflict-thread');
    db.prepare("INSERT INTO native_conversation_bindings(thread_id,project_id,kind,issue_id,host_id,created_at,archived_at) VALUES('metadata-conflict-thread','p2','work','foreign-work','local','2000','2001')").run();
    // Historical/list reads do not recover stale current reservations as a side effect.
    db.prepare("UPDATE native_conversation_operations SET status='bound',updated_at='2000' WHERE request_id='history-current'").run();
    const before=snapshot(),changes=f.state.change;
    const rows=(await list()).value.conversations;
    assert.equal(rows.filter(row=>row.source==='current').length,3);
    const current=rows.find(row=>row.issue_id===issue.id&&row.source==='current');
    assert.equal(current.thread_id,'current-work');assert.equal(current.title,issue.title);assert.equal(current.mode,'thread');assert.equal(current.status,'backlog');
    assert.equal(rows.find(row=>row.issue_id==='empty-work').mode,'draft');
    const legacy=rows.find(row=>row.issue_id==='legacy-work');assert.equal(legacy.mode,'legacy_busy');assert.equal(legacy.thread_id,null);assert.equal(legacy.binding.thread_id,'legacy-thread');
    assert.equal(rows.filter(row=>row.source==='history').length,5,'valid durable histories survive damaged optional JSON; conflicting identities stay out');
    assert(!rows.some(row=>row.project_id==='p2'||row.history_id==='planning-history'));
    const selected={project_id:'p1',kind:'work',issue_id:issue.id,history_id:old.id};
    for (let i=0;i<3;i++) {
      const value=(await read(selected)).value;
      assert.equal(value.mode,'thread');assert.equal(value.read_only,true);assert.equal(value.thread_id,'historical-work');assert.equal(value.target.history_id,old.id);
      assert.equal(value.binding.status,'closed');assert.equal(value.pending_operation,null);assert.deepEqual(value.dynamic_tools,[]);
      assert.equal(value.context.charter.revision,2);assert.equal(value.context.plan.revision,1);
      assert.equal(value.context.task.charter_revision,2);assert.equal(value.context.task.plan_revision,1);assert.equal(value.context.plan.items[0].title,'登录闭环');
      assert.equal(value.context.task.agent_enabled,true);assert.equal(value.context.task.status,issue.status);assert.equal(value.context.task.active_run_status,null);assert.equal(value.context.task.archived_at,null);
      assert(value.context.tasks.every(task=>Object.hasOwn(task,'archived_at')));
    }
    assert.equal((await read({...selected,history_id:'damaged-work-1'})).value.thread_id,'damaged-thread-1');
    for (const invalid of [
      {...selected,project_id:'p2'}, {...selected,issue_id:'empty-work'}, {...selected,history_id:'foreign-history'},
      {...selected,history_id:'planning-history'}, {...selected,kind:'planning'}, {...selected,history_id:'snapshot-mismatch'},
      {...selected,history_id:'current-conflict'}, {...selected,history_id:'metadata-conflict'},
      {...selected,history_id:''}, {...selected,history_id:'does-not-exist'}
    ]) await assert.rejects(read(invalid),/mismatch|invalid_history_id|native_history_not_found/);
    await assert.rejects(api('/api/native-conversations/list?project_id=p1&kind=other'),/invalid_session_kind/);
    for (const endpoint of ['prepare','bind','receipt','restart','create','select','tool']) {
      await assert.rejects(post(endpoint,{...work(issue.id,'history-current',1),...selected,thread_id:'current-work',checkpoint:'bound',status:'failed',explicit:true,
        call_id:'must-not-write',name:'better_codex_project_charter_save',arguments:{}}),/native_history_read_only/);
    }
    await assert.rejects(post('tool',{relay_id:'relay-leader',host_id:'local',thread_id:'historical-work',call_id:'archived-tool',name:'better_codex_project_charter_save',arguments:{}}),/native_history_read_only/);
    await assert.rejects(api('/api/project-tools/project_charter_save','POST',{...f.charterArgs('p1','history-charter',{expected_revision:3}),history_id:old.id}),/native_history_read_only/);
    assert.equal(snapshot(),before,'history/list/invalid requests never mutate sessions, ownership, reservations, versions, history JSON or execution rows');
    assert.equal(f.state.change,changes);assert.equal(f.state.dispatch,0);assert.equal(f.state.wake,0);
    assert.equal(runtime.conversations.operation('history-current').status,'bound','history browsing must not recover the current stale reservation');
    assert.equal(runtime.conversations.listBindings().some(row=>row.thread_id==='historical-work'),false);
    console.log('PASS: work current/draft/legacy/history list, precise read-only history scope, damaged JSON preservation, pinned material and zero mutation/dispatch');
  } finally {f.cleanup();}
}
if (require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./native-project-runtime.cjs');
const {createNativeConversationRuntime}=require('../src/modules/native-conversation-runtime.cjs');

async function run() {
  const nativeCalls=[],f=createFixture({threadAction:async(...args)=>nativeCalls.push(args)}),{runtime,store,api}=f,db=store.db;
  const post=(name,args)=>api('/api/native-conversations/'+name,'POST',args);
  const row=identifier=>db.prepare('SELECT * FROM project_native_conversations WHERE conversation_id=?').get(identifier) || db.prepare('SELECT * FROM issue_native_conversations WHERE conversation_id=?').get(identifier);
  const unbindArgs=value=>({project_id:value.project_id,conversation_id:value.conversation_id,kind:value.kind,expected_revision:value.revision,
    ...(value.issue_id?{issue_id:value.issue_id,expected_issue_version:store.getIssue(value.issue_id).version}:{})});
  const toolArgs=(thread,call)=>({thread_id:thread,host_id:'local',relay_id:'relay-leader',call_id:call,name:'better_codex_project_context_read',arguments:{}});
  try {
    db.exec(`CREATE TABLE issue_sessions(issue_id TEXT PRIMARY KEY REFERENCES issues(id),host_id TEXT DEFAULT 'local',thread_id TEXT UNIQUE,
      status TEXT DEFAULT 'idle',active_turn_id TEXT,active_command_id TEXT,last_turn_id TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE issue_runs(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT);
      CREATE TABLE issue_replies(issue_id TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE session_commands(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT);`);
    await f.startAndBind('p1','charter','unbind-charter');
    runtime.planning.saveCharter(f.charterArgs('p1','unbind-charter'));
    f.userMessage('unbind-charter','unbind-confirm','确认总纲');
    await f.startAndBind('p1','planning','unbind-planning');
    runtime.planning.savePlan({project_id:'p1',thread_id:'unbind-planning',expected_revision:0,charter_revision:2,items:[f.item()]});
    const documents=JSON.stringify([runtime.planning.getCharter('p1'),runtime.planning.getPlan('p1')]);
    for (const kind of ['planning','charter']) {
      const current=runtime.conversations.listConversations('p1').conversations.find(value=>value.kind===kind),args=unbindArgs(current);
      await post('tool',toolArgs(current.thread_id,'cached-'+kind));
      await assert.rejects(post('unbind',{...args,project_id:'p2'}),/conversation_project_mismatch/);
      await assert.rejects(post('unbind',{...args,expected_revision:args.expected_revision+1}),/version_conflict/);
      db.prepare("UPDATE project_native_activity SET status='running' WHERE thread_id=?").run(current.thread_id);
      await assert.rejects(post('unbind',args),/native_conversation_busy/);
      db.prepare("UPDATE project_native_activity SET status='ready' WHERE thread_id=?").run(current.thread_id);
      db.prepare("INSERT INTO native_conversation_tool_calls VALUES(?,?,?,?,?,?,'pending',NULL,NULL,'2000')").run('busy-'+kind,'relay-leader','local',current.thread_id,'fixture','fixture');
      await assert.rejects(post('unbind',args),/native_conversation_busy/);
      db.prepare("UPDATE native_conversation_tool_calls SET status='failed' WHERE call_id=?").run('busy-'+kind);
      const unbound=(await post('unbind',args)).value;
      assert.equal(unbound.thread_id,current.thread_id);assert.equal(unbound.unbound_conversation_id,current.conversation_id);
      assert.deepEqual((await post('unbind',args)).value,unbound,'same revision retry is idempotent');
      await assert.rejects(post('select',{project_id:'p1',conversation_id:current.conversation_id}),/native_conversation_unbound/);
      await assert.rejects(post('archive',args),/native_conversation_unbound/);
      await assert.rejects(post('tool',toolArgs(current.thread_id,'cached-'+kind)),/native_conversation_unbound/,'cached tool results are revoked before replay');
      assert.throws(()=>runtime.planning.bindSession({project_id:'p1',kind,thread_id:current.thread_id,expected_revision:0}),/native_conversation_unbound/);
      assert.equal(runtime.handleProjectEvent('turn/started',{threadId:current.thread_id,turn:{id:'late'}}),false);
      assert.equal(runtime.handleProjectEvent('item/completed',{threadId:current.thread_id,item:{type:'userMessage',id:'late-confirm',text:'确认总纲'}}),false);
      assert.equal(runtime.planning.getSessionByThread(current.thread_id),null);
      assert.equal(runtime.conversations.listBindings().some(value=>value.thread_id===current.thread_id),false);
      assert.equal(row(current.conversation_id).thread_id,current.thread_id,'retains identity without touching native chat');
      assert.equal(JSON.stringify([runtime.planning.getCharter('p1'),runtime.planning.getPlan('p1')]),documents);
    }
    const issue=store.createIssue({id:'unbind-task',projectId:'p1',title:'保留任务',description:'保留业务内容',status:'todo',agentEnabled:false});
    const create=async()=> (await post('create',{project_id:'p1',kind:'work',issue_id:issue.id})).value.conversation;
    const first=await create(),second=await create();
    const bindArgs={project_id:'p1',kind:'work',issue_id:issue.id,conversation_id:first.conversation_id,request_id:'unbind-work-bind',
      expected_revision:issue.version,relay_id:'relay-leader',host_id:'local'};
    await post('prepare',bindArgs);await post('bind',{...bindArgs,thread_id:'unbind-work',checkpoint:'allocated'});
    await post('bind',{...bindArgs,thread_id:'unbind-work',checkpoint:'bound'});
    const work=row(first.conversation_id),args=unbindArgs(work);
    await assert.rejects(post('unbind',args),/native_conversation_busy/,'unfinished operation is retained');
    await post('receipt',{...bindArgs,thread_id:'unbind-work',status:'failed',error:'fixture sends no model turn'});
    await post('tool',toolArgs('unbind-work','cached-work'));
    runtime.workflow.ensure(issue.id);
    const beforeIssue=JSON.stringify(store.getIssue(issue.id)),beforeWorkflow=JSON.stringify(runtime.workflow.get(issue.id));
    db.prepare("UPDATE issue_sessions SET active_turn_id='busy',status='waiting_on_approval' WHERE issue_id=?").run(issue.id);
    await assert.rejects(post('unbind',args),/native_conversation_busy/);
    db.prepare("UPDATE issue_sessions SET active_turn_id=NULL,status='idle' WHERE issue_id=?").run(issue.id);
    await assert.rejects(post('unbind',{...args,expected_issue_version:issue.version+1}),/version_conflict/);
    const result=(await post('unbind',args)).value;
    assert.equal(result.selected_conversation_id,second.conversation_id,'other task conversation remains selected');
    assert.equal(db.prepare('SELECT * FROM issue_sessions WHERE issue_id=?').get(issue.id),undefined);
    assert.equal(JSON.stringify(store.getIssue(issue.id)),beforeIssue);
    assert.equal(JSON.stringify(runtime.workflow.get(issue.id)),beforeWorkflow);
    assert.equal(runtime.conversations.listWorkConversations('p1',issue.id).conversations.some(value=>value.thread_id==='unbind-work'),false);
    assert.equal(runtime.handleProjectEvent('turn/completed',{threadId:'unbind-work',turn:{id:'late',status:'failed'}}),false);
    assert.throws(()=>runtime.workflow.transition({issue_id:issue.id,thread_id:'unbind-work',expected_version:issue.version,action:'start_development',summary:'denied'},{actor:'skill'}),/native_conversation_unbound/);
    await assert.rejects(post('tool',toolArgs('unbind-work','cached-work')),/native_conversation_unbound/);
    await assert.rejects(post('recover',{...bindArgs,thread_id:'unbind-work'}),/native_conversation_unbound/);
    const reloaded=createNativeConversationRuntime({store,planning:runtime.planning,home:f.home,context:runtime.context,invokeTool(){throw Error('model tools forbidden');}});
    assert.equal(reloaded.listBindings().length,0);
    assert.equal(reloaded.listConversations('p1').conversations.length,0);
    assert.equal(reloaded.listWorkConversations('p1',issue.id).conversations.some(value=>value.thread_id==='unbind-work'),false);
    assert.throws(()=>reloaded.trustedBinding('unbind-work','local'),/native_conversation_unbound/);
    const replacement=await post('create',{project_id:'p1',kind:'charter'}),draft=replacement.value.conversation;
    const replacementArgs={project_id:'p1',kind:'charter',conversation_id:draft.conversation_id,request_id:'rebind-old',relay_id:'relay-leader',host_id:'local',expected_revision:0};
    await post('prepare',replacementArgs);
    await assert.rejects(post('bind',{...replacementArgs,thread_id:'unbind-charter',checkpoint:'allocated'}),/native_conversation_unbound/);
    assert.equal(nativeCalls.length,0,'unbind never archives, deletes or reads real native chat');
    const backups=fs.readdirSync(path.join(f.home,'backups','native-conversations'));
    assert(backups.length>=3);assert(backups.every(filename=>fs.statSync(path.join(f.home,'backups','native-conversations',filename)).size>0));
    assert.equal(f.state.dispatch,0);assert.equal(f.state.wake,0);
    console.log('PASS: fixture unbind preserves chat identity/documents/tasks, rejects busy/version races, revokes cached tools and permanently blocks recovery/rebinding/events');
  } finally {f.cleanup();}
}
if(require.main===module) run().catch(error=>{console.error(error);process.exit(1);});
module.exports={run};

'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createFixture}=require('./native-project-runtime.cjs');
const {createNativeConversationRuntime,ensurePlanningConversationTables}=require('../src/modules/native-conversation-runtime.cjs');

async function run() {
  const calls=[];let nativeError=null,holdArchive=null;
  const f=createFixture({threadAction:async(ids,action)=>{
    calls.push({ids,action});
    if (holdArchive) await holdArchive;
    if (nativeError) throw Error(nativeError);
  }}),{api,runtime,store}=f;
  const post=(name,args)=>api('/api/native-conversations/'+name,'POST',args);
  const create=async(kind='charter')=>(await post('create',{project_id:'p1',kind})).value.conversation;
  const archive=row=>post('archive',{project_id:row.project_id,conversation_id:row.conversation_id,expected_revision:row.revision});
  const visible=()=>runtime.conversations.listConversations('p1');
  try {
    // Existing installations receive a nullable column without changing rows.
    const oldDb=new DatabaseSync(':memory:');
    oldDb.exec('CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE project_native_conversations(conversation_id TEXT PRIMARY KEY,project_id TEXT,kind TEXT,title TEXT,thread_id TEXT,host_id TEXT,status TEXT,last_error TEXT,revision INTEGER,generation INTEGER,selected INTEGER,legacy_scope TEXT,created_at TEXT,updated_at TEXT)');
    oldDb.prepare("INSERT INTO project_native_conversations VALUES('old','p1','charter','old',NULL,'local','draft',NULL,0,0,1,NULL,'old','old')").run();
    ensurePlanningConversationTables(oldDb);ensurePlanningConversationTables(oldDb);
    assert.equal(oldDb.prepare("SELECT archived_at FROM project_native_conversations WHERE conversation_id='old'").get().archived_at,null);oldDb.close();

    const first=await create(),second=await create();
    await assert.rejects(post('archive',{project_id:'p2',conversation_id:first.conversation_id,expected_revision:0}),/conversation_project_mismatch/);
    await assert.rejects(post('archive',{project_id:'p1',conversation_id:first.conversation_id,expected_revision:2}),/version_conflict/);
    await archive(first);
    assert.deepEqual(visible().conversations.map(row=>row.conversation_id),[second.conversation_id]);assert.equal(calls.length,0);
    assert.equal((await archive(first)).value.selected_conversation_id,second.conversation_id);
    await assert.rejects(post('select',{project_id:'p1',conversation_id:first.conversation_id}),/native_conversation_archived/);
    await assert.rejects(api('/api/native-conversations/context?project_id=p1&conversation_id='+first.conversation_id),/native_conversation_archived/);

    // Real identity is allocated by fixture checkpoints; no model turn is sent.
    await f.startAndBind('p1','charter','12345678-1234-1234-1234-123456789001');
    const bound=visible().conversations.find(row=>row.conversation_id===second.conversation_id);
    const charter=runtime.planning.saveCharter(f.charterArgs('p1',bound.thread_id));
    const beforeCharter=JSON.stringify(runtime.planning.getCharter('p1'));
    assert.equal(charter.revision,1);
    const fallback=await create();
    await post('select',{project_id:'p1',conversation_id:bound.conversation_id});
    store.db.prepare("UPDATE project_native_conversations SET status='running' WHERE conversation_id=?").run(bound.conversation_id);
    await assert.rejects(archive(bound),/native_conversation_busy/);assert.equal(calls.length,0);
    store.db.prepare("UPDATE project_native_conversations SET status='ready' WHERE conversation_id=?").run(bound.conversation_id);
    nativeError='session_host_unavailable';
    await assert.rejects(archive(bound),/session_host_unavailable/);
    assert(visible().conversations.some(row=>row.conversation_id===bound.conversation_id));assert.equal(runtime.planning.getSession('p1','charter').thread_id,bound.thread_id);
    nativeError='thread_archived: already archived';
    const result=(await archive(bound)).value;
    assert.equal(result.selected_conversation_id,fallback.conversation_id);assert.equal(result.conversation.thread_id,null);
    assert.equal(JSON.stringify(runtime.planning.getCharter('p1')),beforeCharter,'archiving retains the project document');
    assert.equal(runtime.planning.getSessionByThread(bound.thread_id),null);
    assert.equal(runtime.handleProjectEvent('turn/started',{threadId:bound.thread_id,turn:{id:'late-turn'}}),false,'late events cannot reactivate archived rows');
    assert.equal(runtime.conversations.listBindings().some(row=>row.thread_id===bound.thread_id),false);
    assert.throws(()=>runtime.conversations.trustedBinding(bound.thread_id,'local'),/native_conversation_archived/);
    assert(store.db.prepare('SELECT 1 FROM native_conversation_history WHERE thread_id=?').get(bound.thread_id));
    assert(store.db.prepare('SELECT archived_at FROM native_conversation_bindings WHERE thread_id=?').get(bound.thread_id).archived_at);
    const archiveCallCount=calls.length;await archive(bound);assert.equal(calls.length,archiveCallCount,'idempotent local retry does not contact native host');
    const reloaded=createNativeConversationRuntime({store,planning:runtime.planning,home:f.home,context:runtime.context,invokeTool:()=>{throw Error('no model/business tools');}});
    assert.equal(reloaded.listConversations('p1').conversations.some(row=>row.thread_id===bound.thread_id),false,'history migration must not reintroduce archived entries');
    assert.equal(reloaded.readContext({project_id:'p1',kind:'charter'}).conversation.conversation_id,fallback.conversation_id);
    assert.equal(fs.readdirSync(path.join(f.home,'backups','native-conversations')).length>0,true);

    // Removing the last planning entry returns the empty state and keeps history.
    await archive(fallback);assert.equal(visible().selected_conversation_id,null);assert.equal(visible().conversations.length,0);
    assert.equal(runtime.conversations.readContext({project_id:'p1',kind:'charter'}).thread_id,null);

    // Archive's pending native call blocks competing selection/send and reload.
    nativeError=null;
    const held=await create();
    const reservedArgs={project_id:'p1',kind:'charter',conversation_id:held.conversation_id,request_id:'reserved-archive',relay_id:'relay-leader',host_id:'local',expected_revision:0};
    await post('prepare',reservedArgs);
    await assert.rejects(archive(held),/native_conversation_busy/);
    await post('receipt',{...reservedArgs,status:'failed',error:'fixture does not send a model turn'});
    store.db.prepare("UPDATE project_native_conversations SET thread_id=?,revision=1,status='ready' WHERE conversation_id=?").run('12345678-1234-1234-1234-123456789002',held.conversation_id);
    const heldRow=visible().conversations[0];let release;holdArchive=new Promise(resolve=>{release=resolve;});
    const runningArchive=archive(heldRow);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,1);
    await assert.rejects(create(),/native_conversation_busy/);
    await assert.rejects(post('select',{project_id:'p1',conversation_id:heldRow.conversation_id}),/native_conversation_busy/);
    await assert.rejects(post('prepare',{project_id:'p1',kind:'charter',conversation_id:heldRow.conversation_id,request_id:'blocked-send',relay_id:'relay-leader',host_id:'local',expected_revision:1}),/native_conversation_busy/);
    release();await runningArchive;holdArchive=null;
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,0);

    const issue=store.createIssue({id:'work-archive',projectId:'p1',title:'工作会话',description:'保留任务',status:'backlog'});
    const work=(await post('create',{project_id:'p1',kind:'work',issue_id:issue.id})).value.conversation;
    await assert.rejects(archive(work),/invalid_expected_issue_version/);
    assert(calls.every(call=>call.action==='archive'),'the lifecycle never deletes chat content');
    console.log('PASS: planning archives hide draft/native/already-archived entries, retain documents/history, survive reload and guard busy/failure/races');
  } finally {f.cleanup();}
}
if (require.main===module) run().catch(error=>{console.error(error);process.exit(1);});
module.exports={run};

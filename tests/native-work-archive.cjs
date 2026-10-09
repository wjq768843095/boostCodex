'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createFixture}=require('./native-project-runtime.cjs');
const {createNativeConversationRuntime}=require('../src/modules/native-conversation-runtime.cjs');
async function run() {
  const calls=[];let nativeError=null,hold=null;
  const f=createFixture({threadAction:async(ids,action)=>{calls.push({ids,action});if(hold)await hold;if(nativeError)throw Error(nativeError);}});
  const {store,runtime,api}=f,db=store.db;
  const post=(name,args)=>api('/api/native-conversations/'+name,'POST',args);
  const list=issueId=>runtime.conversations.listWorkConversations('p1',issueId);
  try {
    db.exec('CREATE TABLE issue_sessions(issue_id TEXT PRIMARY KEY,thread_id TEXT,status TEXT,active_turn_id TEXT,created_at TEXT,updated_at TEXT);');
    const issue=store.createIssue({id:'archive-work',projectId:'p1',title:'保留开发任务',description:'任务资料保持不变',status:'backlog'});
    const create=async title=>(await post('create',{project_id:'p1',kind:'work',issue_id:issue.id,title})).value.conversation;
    const archive=row=>post('archive',{project_id:'p1',kind:'work',issue_id:issue.id,conversation_id:row.conversation_id,expected_revision:row.revision,expected_issue_version:store.getIssue(issue.id).version});
    const first=await create('误建草稿'),second=await create('继续开发');
    await assert.rejects(post('archive',{project_id:'p2',conversation_id:first.conversation_id,expected_revision:0}),/conversation_project_mismatch/);
    await assert.rejects(archive({...first,revision:99}),/version_conflict/);
    const taskBefore={...store.getIssue(issue.id)};
    await archive(first);assert.equal(calls.length,0);
    assert.deepEqual(list(issue.id).conversations.map(row=>row.conversation_id),[second.conversation_id]);
    await archive(first);assert.equal(calls.length,0,'retry is idempotent');
    await assert.rejects(post('select',{project_id:'p1',conversation_id:first.conversation_id}),/native_conversation_archived/);
    await archive(second);assert.equal(list(issue.id).conversations.length,0,'last removal cannot recreate a same-name placeholder');
    assert.deepEqual({...store.getIssue(issue.id)},taskBefore);

    const bound=await create('已有聊天');
    db.prepare("INSERT INTO issue_native_ownership VALUES(?,'native','2000')").run(issue.id);
    db.prepare("UPDATE issue_native_conversations SET thread_id='12345678-1234-1234-1234-123456789101',revision=1,status='ready' WHERE conversation_id=?").run(bound.conversation_id);
    db.prepare("INSERT INTO native_conversation_bindings VALUES('12345678-1234-1234-1234-123456789101','p1','work',?,'local',NULL,'2000',NULL)").run(issue.id);
    db.prepare("INSERT INTO issue_sessions VALUES(?,'12345678-1234-1234-1234-123456789101','idle',NULL,'2000','2000')").run(issue.id);
    const row=list(issue.id).conversations[0];
    db.prepare("UPDATE issue_native_conversations SET status='running',active_turn_id='running-turn' WHERE conversation_id=?").run(row.conversation_id);
    await assert.rejects(archive(row),/native_conversation_busy/);assert.equal(calls.length,0);
    db.prepare("UPDATE issue_native_conversations SET status='ready',active_turn_id=NULL WHERE conversation_id=?").run(row.conversation_id);
    nativeError='session_host_unavailable';await assert.rejects(archive(row),/session_host_unavailable/);
    assert.equal(list(issue.id).conversations[0].conversation_id,row.conversation_id);assert(db.prepare('SELECT 1 FROM issue_sessions WHERE issue_id=?').get(issue.id));
    nativeError=null;let release;hold=new Promise(resolve=>{release=resolve;});
    const removal=archive(row);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,1);
    const draft=await create('保留的另一个会话');
    await assert.rejects(post('prepare',{project_id:'p1',kind:'work',issue_id:issue.id,conversation_id:draft.conversation_id,request_id:'cannot-send-during-archive',expected_revision:1,draft_generation:0,relay_id:'relay-leader',host_id:'local'}),/issue_execution_running/);
    release();await removal;hold=null;
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,0);
    assert.equal(db.prepare('SELECT 1 FROM issue_sessions WHERE issue_id=?').get(issue.id),undefined);
    assert(db.prepare('SELECT 1 FROM issue_native_conversations WHERE conversation_id=? AND thread_id=?').get(row.conversation_id,'12345678-1234-1234-1234-123456789101'),'identity and original native chat are retained');
    assert.equal(list(issue.id).conversations.some(item=>item.conversation_id===row.conversation_id),false);
    assert.equal(runtime.conversations.handleWorkEvent('turn/started',{threadId:'12345678-1234-1234-1234-123456789101',turn:{id:'late'}}).ignored,true);
    await archive(row);assert.equal(calls.length,2,'idempotent retry does not contact native host');

    // Historical chat removal retains its history snapshot and cannot return on reload.
    const historical=await create('历史误建会话');
    db.prepare("INSERT INTO native_conversation_history VALUES('old-work','p1','work',?,'12345678-1234-1234-1234-123456789102',?,'2000')").run(issue.id,JSON.stringify({host_id:'local',title:'历史误建会话'}));
    db.prepare("UPDATE issue_native_conversations SET status='closed',selected=0,revision=1,thread_id='12345678-1234-1234-1234-123456789102',history_id='old-work' WHERE conversation_id=?").run(historical.conversation_id);
    const history=list(issue.id).conversations.find(item=>item.history_id==='old-work');assert(history);
    nativeError='thread_archived: already archived';await archive(history);nativeError=null;
    assert(db.prepare("SELECT 1 FROM native_conversation_history WHERE id='old-work'").get());
    const reloaded=createNativeConversationRuntime({store,planning:runtime.planning,home:f.home,context:runtime.context,recover:false});
    assert.equal(reloaded.listWorkConversations('p1',issue.id).conversations.some(item=>item.history_id==='old-work'),false);
    assert.deepEqual({...store.getIssue(issue.id)},taskBefore);
    assert(calls.every(call=>call.action==='archive'));
    const backups=fs.readdirSync(path.join(f.home,'backups','native-conversations'));assert(backups.length>0);assert(backups.every(file=>fs.statSync(path.join(f.home,'backups','native-conversations',file)).size>0));
    assert.equal(f.state.dispatch,0);assert.equal(f.state.wake,0);
    console.log('PASS: work draft/native/history removal retains tasks and chat identities, survives reload, guards running/version/failure/races, and never starts model work');
  } finally {f.cleanup();}
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

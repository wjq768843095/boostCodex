'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createFixture} = require('./native-project-runtime.cjs');
const {ensureConversationTables} = require('../src/modules/native-conversation-runtime.cjs');
const executionHelper=fs.readFileSync(path.join(__dirname,'../src/ui/better-codex-ui.js'),'utf8').match(/function issueExecutionRunning\(issue\) \{[\s\S]*?\n    \}/);
assert(executionHelper,'UI execution state helper must be available for the runtime contract');
const issueExecutionRunning=vm.runInNewContext('('+executionHelper[0]+')');

async function recoveryFixture({checkpoint='allocated',kind='charter',response,onRead}={}) {
  const threadId='01a10c1b-c051-7791-ba0d-68bf6b510798',reads=[];
  let f;
  f=createFixture({semanticRequest:async(method,params)=>{
    reads.push({method,params});await onRead?.(f);
    return {result:response===undefined?{thread:{id:threadId,turns:[],status:{type:'idle'}}}:response};
  }});
  const identity={project_id:'p1',kind,request_id:'unknown-first-turn',relay_id:'relay-leader',host_id:'local',expected_revision:0,draft_generation:0};
  if (kind==='work') {
    f.store.db.exec("CREATE TABLE issue_sessions(issue_id TEXT PRIMARY KEY,host_id TEXT DEFAULT 'local',thread_id TEXT UNIQUE,status TEXT DEFAULT 'idle',active_turn_id TEXT,active_command_id TEXT,last_turn_id TEXT,created_at TEXT,updated_at TEXT)");
    f.store.createIssue({id:'recovery-work',projectId:'p1',title:'恢复空会话',description:'只恢复元数据',status:'backlog',agentEnabled:true});
    identity.issue_id='recovery-work';identity.expected_revision=1;
  }
  const post=async(name,args)=>f.api('/api/native-conversations/'+name,'POST',args);
  await post('prepare',identity);
  if (checkpoint) await post('bind',{...identity,thread_id:threadId,checkpoint:'allocated'});
  if (checkpoint==='bound') await post('bind',{...identity,thread_id:threadId,checkpoint:'bound'});
  f.runtime.conversations.recoverRelay('relay-leader');
  return {f,identity,threadId,reads,post};
}

async function runRecovery() {
  {
    const backendSource=fs.readFileSync(path.join(__dirname,'../src/backend/better-codex.cjs'),'utf8');
    const hostStart=backendSource.indexOf('var SessionHostServer = class');
    const semanticStart=backendSource.indexOf('    if (message.type === "semantic_request") {',hostStart);
    const semanticEnd=backendSource.indexOf('    if (message.type === "begin_handoff") {',semanticStart);
    assert(semanticStart>hostStart && semanticEnd>semanticStart,'host semantic request handler must be available');
    const responses=[],hostCalls=[];
    const handler=vm.runInNewContext('(async function(message,connection){'+backendSource.slice(semanticStart,semanticEnd)+'})',{
      Buffer,writeMessage:(_socket,response)=>responses.push(response),semanticResponseError:error=>error.message
    });
    const connection={authenticated:true,socket:{}};
    const host={connection,hostInstanceId:'fixture-host',relay:{status:()=>({}),semanticRequest:async(method,params)=>{hostCalls.push({method,params});return {result:{thread:{id:params.threadId,turns:[]}},identity:{}};}}};
    const request={type:'semantic_request',request_id:'history-check',method:'thread/read',params:{threadId:'01a10c1b-c051-7791-ba0d-68bf6b510798',includeTurns:true},deadline_at:new Date(Date.now()+30000).toISOString()};
    await handler.call(host,request,connection);
    assert.equal(hostCalls.length,1,'authenticated recovery reads pass through the host to the owning relay');
    assert.equal(responses.at(-1).ok,true);
    await handler.call(host,{...request,method:'turn/start'},connection);
    assert.equal(responses.at(-1).error,'semantic_request_invalid','semantic history access does not authorize model execution');
    await handler.call(host,request,{...connection,authenticated:false});
    assert.equal(hostCalls.length,1,'unauthenticated history requests never reach the relay');
    const nativeReadMethod=backendSource.match(/async semanticRequest\(method, params, timeout = 8e3\) \{\n    if \(method === "thread\/read"\) \{[\s\S]*?\n  \}(?=\n  async handoffThread)/);
    assert(nativeReadMethod,'native recovery reads must use the original thread worker when it exists');
    const method=vm.runInNewContext('({'+nativeReadMethod[0]+'}).semanticRequest',{Error,sessionId:id=>/^[a-f0-9-]{36}$/i.test(id || '')?id:null});
    const threadId='01a10c1b-c051-7791-ba0d-68bf6b510798',calls=[];
    let busy=false;
    const owner={waitUntilReady:async()=>{},busyForThread:()=>busy,semanticRequest:async(method,params)=>{calls.push({method,params});return {result:{thread:{id:threadId,turns:[]}}};}};
    const catalog={waitUntilReady:async()=>{},semanticRequest:async()=>{calls.push({catalog:true});return {result:{thread:{id:threadId,turns:[]}}};}};
    const relay={threadWorkers:new Map([[threadId,owner]]),catalog};
    await method.call(relay,'thread/read',{threadId,includeTurns:true});assert.equal(calls.length,1);assert(!calls[0].catalog,'unmaterialized original thread reads stay with their owning process');
    busy=true;await assert.rejects(method.call(relay,'thread/read',{threadId,includeTurns:true}),/native_recovery_busy/);assert.equal(calls.length,1,'pending original requests block empty-history repair');
    busy=false;owner.semanticRequest=async()=>{busy=true;return {result:{thread:{id:threadId,turns:[]}}};};
    await assert.rejects(method.call(relay,'thread/read',{threadId,includeTurns:true}),/native_recovery_busy/);
    relay.threadWorkers.clear();await method.call(relay,'thread/read',{threadId,includeTurns:true});assert.equal(calls.at(-1).catalog,true,'durable threads without an owner are read through the catalog');
    await assert.rejects(method.call(relay,'thread/read',{threadId,includeTurns:false}),/invalid_thread_id/);
  }
  for (const [kind,checkpoint] of [['charter','allocated'],['charter','bound'],['work','allocated'],['work','bound']]) {
    const {f,identity,threadId,reads,post}=await recoveryFixture({kind,checkpoint});
    try {
      const restored=(await post('recover',identity)).value;
      assert.equal(restored.recovered,true);assert.equal(restored.operation.status,'failed');assert.equal(restored.operation.error,'native_recovered_not_sent');
      assert.equal(restored.thread_id,threadId,'recovery binds the original allocated thread instead of creating another');
      assert.equal(restored.mode,'thread');assert.equal(restored.pending_operation,null);
      assert.deepEqual(reads,[{method:'thread/read',params:{threadId,includeTurns:true}}]);
      const replay=(await post('recover',identity)).value;assert.equal(replay.thread_id,threadId);assert.equal(reads.length,1,'metadata repair is idempotent');
      const next=(await post('prepare',{...identity,request_id:'new-authorized-send',conversation_id:restored.conversation_id,expected_revision:restored.expected_revision})).value;
      assert.equal(next.operation.thread_id,threadId,'a subsequent explicit user send reserves the existing repaired thread');
      assert.equal(f.state.wake,0);assert.equal(f.state.dispatch,0,'recovery and prepare never start a model request');
    } finally {f.cleanup();}
  }
  const unsafeResponses=[{thread:{id:'different',turns:[]}},{thread:{id:'01a10c1b-c051-7791-ba0d-68bf6b510798'}},{thread:{id:'01a10c1b-c051-7791-ba0d-68bf6b510798',turns:[{id:'accepted-turn'}]}},{thread:{id:'01a10c1b-c051-7791-ba0d-68bf6b510798',turns:[],status:{type:'active'}}}];
  for (const response of unsafeResponses) {
    const {f,identity,post}=await recoveryFixture({response});
    try {await assert.rejects(post('recover',identity),/native_outcome_unknown/);assert.equal(f.runtime.conversations.operation(identity.request_id).status,'outcome_unknown');}
    finally {f.cleanup();}
  }
  {
    const {f,identity,reads,post}=await recoveryFixture({checkpoint:null});
    try {await assert.rejects(post('recover',identity),/native_outcome_unknown/);assert.equal(reads.length,0,'missing thread allocation has no safe read target');}
    finally {f.cleanup();}
  }
  {
    const {f,identity,reads,post}=await recoveryFixture();
    try {
      await assert.rejects(post('recover',{...identity,relay_id:'foreign'}),/session_relay_not_leader/);
      await assert.rejects(post('recover',{...identity,host_id:'remote'}),/native_operation_identity_mismatch/);
      await assert.rejects(post('recover',{...identity,project_id:'p2'}),/native_operation_scope_mismatch/);
      await assert.rejects(post('recover',{...identity,expected_revision:10}),/version_conflict/);
      assert.equal(reads.length,0,'scope/auth failures occur before native history reads');
      f.store.nativeSessionProxyIsLeader=id=>id==='replacement-leader';
      const restored=(await post('recover',{...identity,relay_id:'replacement-leader'})).value;
      assert.equal(restored.operation.relay_id,'replacement-leader','current leader can verify and repair interrupted previous leader metadata');
    } finally {f.cleanup();}
  }
  {
    const {f,identity,post}=await recoveryFixture({checkpoint:'bound',onRead:async fixture=>{
      fixture.runtime.handleProjectEvent('turn/started',{threadId:'01a10c1b-c051-7791-ba0d-68bf6b510798',turn:{id:'late-real-turn'}});
    }});
    try {await assert.rejects(post('recover',identity),/native_outcome_unknown/);assert.equal(f.runtime.conversations.operation(identity.request_id).status,'outcome_unknown','native turn observed while the read is in flight prevents recovery');}
    finally {f.cleanup();}
  }
  {
    const {f,identity,post}=await recoveryFixture({onRead:async()=>{throw Error('host disconnected');}});
    try {await assert.rejects(post('recover',identity),/host disconnected/);assert.equal(f.runtime.conversations.operation(identity.request_id).status,'outcome_unknown','failed native history read never releases the reservation');}
    finally {f.cleanup();}
  }
  console.log('PASS: unknown first-turn recovery requires authoritative empty native history, restores the same thread, isolates scope/leader and rejects sent, active, missing and racing evidence without model replay');
}

async function run() {
  const f = createFixture(), {runtime,store,api} = f;
  const request = (project_id,kind,request_id,extra={}) => ({project_id,kind,request_id,relay_id:'relay-leader',host_id:'local',expected_revision:0,draft_generation:0,...extra});
  const post = (name,args) => api('/api/native-conversations/'+name,'POST',args);
  const get = (projectId,kind,issueId) => api('/api/native-conversations/context?project_id='+projectId+'&kind='+kind+(issueId?'&issue_id='+issueId:''));
  try {
    store.db.exec(`CREATE TABLE issue_sessions(issue_id TEXT PRIMARY KEY REFERENCES issues(id),host_id TEXT DEFAULT 'local',thread_id TEXT UNIQUE,
      status TEXT DEFAULT 'idle',active_turn_id TEXT,active_command_id TEXT,last_turn_id TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE issue_replies(issue_id TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE issue_runs(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT);
      CREATE TABLE session_commands(id TEXT PRIMARY KEY,issue_id TEXT,status TEXT);`);
    store.sessionTurnStarted = (threadId,turnId) => {
      const session = store.db.prepare('SELECT issue_id FROM issue_sessions WHERE thread_id=?').get(threadId);
      store.db.prepare("UPDATE issue_sessions SET active_turn_id=?,status='active' WHERE thread_id=?").run(turnId,threadId);
      store.db.prepare("INSERT INTO issue_replies(issue_id,status) VALUES(?,'running') ON CONFLICT(issue_id) DO UPDATE SET status='running'").run(session.issue_id);
    };
    store.getIssueReplyState=issueId=>store.db.prepare('SELECT status FROM issue_replies WHERE issue_id=?').get(issueId) || {status:'idle'};
    const issue = store.createIssue({id:'work-1',projectId:'p1',title:'人工验收闭环',description:'交付需求和验收步骤',status:'backlog',agentEnabled:true});
    for (const [kind,issueId] of [['charter'],['planning'],['work',issue.id]]) {
      const opened = (await get('p1',kind,issueId)).value;
      assert.equal(opened.mode,'draft'); assert.equal(opened.thread_id,null); assert.equal(opened.draft_generation,0);
      assert.equal(opened.pending_operation,null); assert.equal(opened.dynamic_tools.length,kind==='work'?6:5);
      assert(opened.dynamic_tools.every(tool=>!('project_id' in tool.inputSchema.properties)&&!('thread_id' in tool.inputSchema.properties)));
      if (kind==='work') assert.equal(opened.context.task.description,'交付需求和验收步骤');
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM native_conversation_operations').get().count,0);
    assert.equal(runtime.planning.listPendingCommands().length,0);
    await assert.rejects(post('prepare',request('p1','charter','invalid-leader',{relay_id:'foreign'})),/session_relay_not_leader/);
    await assert.rejects(post('prepare',request('p1','charter','stale',{expected_revision:2})),/version_conflict/);
    await assert.rejects(post('prepare',request('p1','planning','unconfirmed')),/confirmed_charter_required/);
    const charter = request('p1','charter','user-first-send');
    const prepared = (await post('prepare',charter)).value;
    assert.equal(prepared.operation.status,'prepared'); assert.equal(prepared.operation.thread_id,null);
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,1);
    assert.equal((await post('prepare',charter)).value.operation.request_id,charter.request_id);
    await assert.rejects(post('prepare',request('p1','charter','double-submit')),/native_operation_busy/);
    await assert.rejects(post('bind',{...charter,project_id:'p2',thread_id:'charter-1',checkpoint:'allocated'}),/native_operation_scope_mismatch/);
    await assert.rejects(post('bind',{...charter,thread_id:'charter-1',checkpoint:'bound'}),/native_allocation_checkpoint_required/);
    await assert.rejects(post('receipt',{...charter,status:'accepted',turn_id:'turn-1'}),/native_binding_required/);
    await post('bind',{...charter,thread_id:'charter-1',checkpoint:'allocated'});
    assert.equal(runtime.planning.getSession('p1','charter'),null,'allocation alone must not expose a usable conversation');
    await post('bind',{...charter,thread_id:'charter-1',checkpoint:'bound'});
    assert.equal(runtime.planning.getSession('p1','charter').thread_id,'charter-1');
    assert(runtime.conversations.listBindings().some(binding=>binding.thread_id==='charter-1'&&binding.kind==='charter'));
    await assert.rejects(post('bind',{...charter,thread_id:'different-thread',checkpoint:'bound'}),/session_thread_mismatch/);
    await post('receipt',{...charter,thread_id:'charter-1',turn_id:'turn-1',status:'accepted'});
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,0);
    runtime.handleProjectEvent('turn/completed',{threadId:'charter-1',turn:{id:'turn-1',status:'completed'}});
    const tool = (call_id,name,args={},extra={}) => post('tool',{relay_id:'relay-leader',host_id:'local',thread_id:'charter-1',call_id,name:'better_codex_'+name,arguments:args,...extra});
    await assert.rejects(tool('unbound','project_context_read',{}, {thread_id:'unbound'}),/native_binding_required/);
    await assert.rejects(tool('host','project_context_read',{}, {host_id:'remote'}),/native_host_mismatch/);
    await assert.rejects(tool('ids','project_context_read',{project_id:'p2'}),/invalid_argument_project_id/);
    assert.equal((await tool('read','project_context_read')).value.project.id,'p1');
    const args = f.charterArgs('p1','charter-1'); delete args.project_id;delete args.thread_id;
    const saved = (await tool('save','project_charter_save',args)).value;assert.equal(saved.revision,1);
    const replay = (await tool('save','project_charter_save',args)).value;assert.equal(replay.revision,1);
    const originalLeaderCheck = store.nativeSessionProxyIsLeader;
    store.nativeSessionProxyIsLeader = relayId=>relayId==='replacement-leader';
    assert.equal((await tool('save','project_charter_save',args,{relay_id:'replacement-leader'})).value.revision,1,'new leader reuses the completed tool result without another write');
    store.nativeSessionProxyIsLeader=originalLeaderCheck;
    await assert.rejects(tool('save','project_context_read'),/native_tool_call_conflict/);
    await assert.rejects(tool('fake-confirm','project_charter_confirm',{expected_revision:1,message_id:'fake'}),/explicit_user_confirmation_required/);
    f.userMessage('charter-1','user-confirm','确认总纲');
    const confirmed = (await tool('confirm','project_charter_confirm',{expected_revision:1,message_id:'user-confirm'})).value;assert.equal(confirmed.status,'confirmed');
    const charterCount = store.db.prepare('SELECT COUNT(*) AS count FROM project_charter_revisions').get().count;
    ensureConversationTables(store.db);ensureConversationTables(store.db);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM project_charter_revisions').get().count,charterCount);
    const reset = (await post('restart',{project_id:'p1',kind:'charter',expected_revision:1,explicit:true})).value;
    assert.equal(reset.mode,'draft');assert.equal(reset.draft_generation,1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM native_conversation_history').get().count,1);
    assert.equal(runtime.conversations.listBindings().some(binding=>binding.thread_id==='charter-1'),false,'archived history must not redirect normal native chats');
    assert.equal(runtime.planning.getCharter('p1').revision,2);
    assert(fs.readdirSync(path.join(f.home,'backups','native-conversations')).some(name=>fs.statSync(path.join(f.home,'backups','native-conversations',name)).size>0));
    await assert.rejects(post('prepare',request('p1','charter','old-draft')),/version_conflict/);
    await assert.rejects(post('prepare',charter),/native_operation_finished/);

    const work = request('p1','work','first-work',{issue_id:issue.id,expected_revision:1});
    await post('prepare',work);assert.equal(runtime.conversations.busyIssue(store.getIssue(issue.id)),true);
    await post('bind',{...work,thread_id:'work-native',checkpoint:'allocated'});
    await post('bind',{...work,thread_id:'work-native',checkpoint:'bound'});
    assert.equal(runtime.enrichIssue(store.getIssue(issue.id)).session_native_owned,true);
    assert(runtime.conversations.listBindings().some(binding=>binding.thread_id==='work-native'&&binding.issue_id===issue.id));
    store.db.prepare('DELETE FROM native_conversation_bindings WHERE thread_id=?').run('work-native');
    assert(runtime.conversations.listBindings().some(binding=>binding.thread_id==='work-native'&&binding.issue_id===issue.id),'old trusted native ownership remains discoverable');
    store.db.prepare('DELETE FROM issue_native_ownership WHERE issue_id=?').run(issue.id);
    assert.equal(runtime.conversations.listBindings().some(binding=>binding.thread_id==='work-native'),false,'executor-owned legacy sessions must remain ordinary native chats until handoff');
    store.db.prepare("INSERT INTO issue_native_ownership(issue_id,owner,created_at) VALUES(?,'native',?)").run(issue.id,new Date().toISOString());
    await post('receipt',{...work,thread_id:'work-native',turn_id:'ordinary-turn',status:'accepted'});
    const activeWork=(await get('p1','work',issue.id)).value.context.task;
    assert.equal(activeWork.session_status,'active');assert.equal(activeWork.session_active_turn_id,'ordinary-turn');assert.equal(activeWork.reply_status,'running');
    assert.equal(issueExecutionRunning(activeWork),true,'current native turn data must suppress execution controls through the real UI helper');
    const activeList=(await api('/api/native-conversations/list?project_id=p1&kind=work')).value.conversations.find(row=>row.issue_id===issue.id&&row.source==='current');
    assert.equal(activeList.session_active_turn_id,'ordinary-turn');assert.equal(issueExecutionRunning(activeList),true,'current work list shows the active native turn');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM issue_runs').get().count,0,'ordinary chat must not create execution runs');
    assert.equal(runtime.conversations.busyIssue(store.getIssue(issue.id)),true,'accepted first send remains reserved by active native turn/reply');
    await assert.rejects(post('prepare',request('p1','work','while-active',{issue_id:issue.id,expected_revision:1})),/issue_execution_running/);
    store.db.prepare("UPDATE issue_sessions SET status='idle',active_turn_id=NULL WHERE issue_id=?").run(issue.id);
    store.db.prepare("UPDATE issue_replies SET status='succeeded' WHERE issue_id=?").run(issue.id);
    runtime.conversations.handleWorkEvent('turn/completed',{threadId:'work-native',turn:{id:'ordinary-turn',status:'completed'}});
    assert.equal(issueExecutionRunning((await get('p1','work',issue.id)).value.context.task),false,'completed direct chat restores execution affordance data without starting a task');
    await post('prepare',request('p1','work','disconnect',{issue_id:issue.id,expected_revision:1}));
    runtime.conversations.recoverRelay('relay-leader');
    assert.equal(runtime.conversations.operation('disconnect').status,'outcome_unknown');
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,0);
    assert.equal(runtime.conversations.busyIssue(store.getIssue(issue.id)),true,'unknown outcomes retain execution exclusion');
    await assert.rejects(post('prepare',request('p1','work','no-blind-retry',{issue_id:issue.id,expected_revision:1})),/native_outcome_unknown/);
    await post('receipt',{...request('p1','work','disconnect',{issue_id:issue.id,expected_revision:1}),status:'failed',error:'known failure before send'});
    assert.equal(runtime.conversations.operation('disconnect').status,'outcome_unknown','uncertain allocated/current-thread outcome cannot be released without bound checkpoint');
    const timeout = request('p2','charter','timeout');await post('prepare',timeout);
    store.db.prepare("UPDATE native_conversation_operations SET updated_at='2000-01-01T00:00:00.000Z' WHERE request_id=?").run(timeout.request_id);
    assert.equal(runtime.conversations.blockingStatus().pending_bindings,0);assert.equal(runtime.conversations.operation('timeout').status,'outcome_unknown');
    assert.equal(runtime.planning.listPendingCommands().length,0);assert.equal(f.state.dispatch,0);assert.equal(f.state.wake,0);
    await runRecovery();
    console.log('PASS: inline read-only opening, first-send allocation/binding, trusted idempotent tools, confirmation, generation/history, ordinary reply semantics and disconnect/timeout reservations');
  } finally {f.cleanup();}
}
if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};

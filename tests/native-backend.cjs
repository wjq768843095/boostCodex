'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-native-backend-'));
const home = path.join(folder, 'better'), user = path.join(folder, 'user'), codex = path.join(user, '.codex'), workspace = path.join(folder, '中文 项目'), projectWorkspace = path.join(folder, '独立项目');
for (const entry of [home, user, codex, workspace, projectWorkspace]) fs.mkdirSync(entry, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'isolated', dependencies: { react: '^18.2.0' } }));
fs.copyFileSync(path.join(workspace,'package.json'),path.join(projectWorkspace,'package.json'));
const env = { ...process.env, BETTER_CODEX_HOME: home, BETTER_CODEX_SKILLS_USER_HOME: user, CODEX_HOME: codex, USERPROFILE: user, HOME: user, NODE_TEST_CONTEXT: 'native-backend-fixture' };
delete env.BETTER_CODEX_LOCAL_PROJECT;
delete env.BC_RUNTIME_API;
let output = '', child, token, port;
const wait = async check => { for (let i = 0; i < 150; i++) { if (check()) return; if (child?.exitCode !== null) throw Error('isolated runtime exited: ' + output.slice(-1500)); await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('isolated runtime timeout: ' + output.slice(-1500)); };
async function api(route, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:' + port + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, value: await response.json() };
}
async function main() {
  child = cp.spawn(process.execPath, [path.join(__dirname, '../src/backend/better-codex.cjs'), 'runtime'], { env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const state = path.join(home, 'run/runtime.json');
  await wait(() => fs.existsSync(state));
  const runtime = JSON.parse(fs.readFileSync(state, 'utf8')); port = runtime.port;
  token = fs.readFileSync(path.join(home, 'run/token'), 'utf8').trim();
  assert.equal((await api('/health')).status, 200);
  let initial = await api('/api/projects');
  for (let retry = 0; initial.status === 503 && retry < 50; retry++) {
    await new Promise(resolve => setTimeout(resolve,100)); initial = await api('/api/projects');
  }
  assert.equal(initial.status, 200); assert.equal(initial.value.length, 1, 'only the built-in inbox should exist'); assert.equal(initial.value[0].external_id,'inbox'); assert.equal(initial.value[0].workspace_path,workspace);
  for (const route of ['/web', '/web/session', '/web/injection.js', '/api/relay/status', '/api/remote-access/status', '/api/sync/status']) assert.equal((await api(route)).status, 404, route);
  const relay = await fetch('http://127.0.0.1:' + port + '/api/projects', { headers: { Authorization: 'Bearer ' + token, 'x-better-codex-relay': '1' } }); assert([403,404].includes(relay.status), 'relay headers must be rejected');
  const created = await api('/api/projects', 'POST', { name: '隔离项目', workspace_path: projectWorkspace });
  assert.equal(created.status, 201, JSON.stringify(created.value)); const project = created.value.project || created.value;
  const groups = await api('/api/skills'); assert.equal(groups.status, 200); assert(groups.value.managed.some(skill => skill.id === 'better-codex-charter'));
  assert(groups.value.managed.every(skill => skill.path.startsWith(user)), 'fixture exports must stay in temporary user home');
  const context = await api('/api/projects/' + project.id + '/planning-context'); assert.equal(context.status, 200); assert(context.value.stack_facts.some(fact => fact.name === 'react'));
  const premature = await api('/api/projects/' + project.id + '/native-session', 'POST', { kind: 'planning', request_id: randomUUID() }); assert([400,409].includes(premature.status)); assert.equal(premature.value.error,'confirmed_charter_required');
  const opened = await api('/api/projects/' + project.id + '/native-session', 'POST', { kind: 'charter', request_id: randomUUID() }); assert.equal(opened.status, 202, JSON.stringify(opened.value));
  assert.equal(opened.value.command,null); assert.equal(opened.value.session,null); assert.equal(opened.value.mode,'draft'); assert.equal(Object.hasOwn(opened.value,'prompt'),false);
  const emptyConversations=await api('/api/native-conversations/list?project_id='+project.id);assert.equal(emptyConversations.status,200);assert.equal(emptyConversations.value.conversations.length,0);
  const discarded=(await api('/api/native-conversations/create','POST',{project_id:project.id,kind:'charter'})).value.conversation;
  const archiveDraftArgs={project_id:project.id,conversation_id:discarded.conversation_id,expected_revision:discarded.revision};
  const archivedDraft=await api('/api/native-conversations/archive','POST',archiveDraftArgs);
  assert.equal(archivedDraft.status,200,JSON.stringify(archivedDraft.value));assert.equal(archivedDraft.value.archived_conversation_id,discarded.conversation_id);
  assert.equal(archivedDraft.value.selected_conversation_id,null);assert.equal(archivedDraft.value.conversation,null);
  assert.equal((await api('/api/native-conversations/list?project_id='+project.id)).value.conversations.length,0);
  assert.equal((await api('/api/native-conversations/archive','POST',archiveDraftArgs)).status,200,'lost archive responses are retryable');
  assert.equal((await api('/api/native-conversations/select','POST',{project_id:project.id,conversation_id:discarded.conversation_id})).status,409,'archived entries cannot be reselected');
  const firstConversation=await api('/api/native-conversations/create','POST',{project_id:project.id,kind:'charter',title:'需求总纲'});
  const secondConversation=await api('/api/native-conversations/create','POST',{project_id:project.id,kind:'charter',title:'架构核对'});
  assert.equal(firstConversation.status,200);assert.equal(secondConversation.status,200);assert.equal(secondConversation.value.conversation.thread_id,null);
  const conversationId=secondConversation.value.conversation.conversation_id;
  const listConversations=await api('/api/native-conversations/list?project_id='+project.id);assert.equal(listConversations.value.conversations.length,2);assert.equal(listConversations.value.selected_conversation_id,conversationId);
  const relayId = randomUUID(), pollBody = { relay_id: relayId, app_session_id: 'isolated-fixture', owner: 'native', capability: 'ready' };
  let poll = await api('/api/session-relay/poll', 'POST', pollBody); assert.equal(poll.status, 200);
  assert.equal(poll.value.command,null,'opening must not queue native model requests');
  const projectSkill = await api('/api/skills/derive','POST',{source_id:'better-codex-plan',project_id:project.id,name:'本项目规划'});
  assert.equal(projectSkill.status,201,JSON.stringify(projectSkill.value));
  const scopedSkill=projectSkill.value.skill;
  assert.equal((await api('/api/skills?project_id='+initial.value[0].id)).value.managed.some(item=>item.id===scopedSkill.id),false);
  const foreignSkillIssue=await api('/api/issues','POST',{project_id:initial.value[0].id,title:'拒绝跨项目Skill',native_only:true,skill_id:scopedSkill.id});
  assert.equal(foreignSkillIssue.status,403);assert.equal(foreignSkillIssue.value.error,'skill_project_mismatch');
  const nativeOnly = await api('/api/issues','POST',{project_id:project.id,title:'原生工作会话',native_only:true,status:'todo',agent_enabled:true,skill_id:scopedSkill.id});
  assert.equal(nativeOnly.status,201);assert.equal(nativeOnly.value.session_native_owned,true);
  assert.equal(Boolean(nativeOnly.value.agent_enabled),false,'native creation cannot enable background dispatch');
  const workA=await api('/api/native-conversations/create','POST',{project_id:project.id,kind:'work',issue_id:nativeOnly.value.id,title:'调查'});
  const workB=await api('/api/native-conversations/create','POST',{project_id:project.id,kind:'work',issue_id:nativeOnly.value.id,title:'开发'});
  assert.equal(workA.status,200,JSON.stringify(workA.value));assert.equal(workB.status,200);
  assert.notEqual(workA.value.conversation.conversation_id,workB.value.conversation.conversation_id);
  const workRows=(await api('/api/native-conversations/list?project_id='+project.id+'&kind=work&issue_id='+nativeOnly.value.id)).value.conversations;
  assert.equal(workRows.length,2);assert(workRows.every(item=>!item.thread_id));
  assert.equal((await api('/api/session-relay/poll','POST',pollBody)).value.command,null,'creating native work conversations leaves dispatch queue empty');
  const prepareArgs = {project_id:project.id,kind:'charter',conversation_id:conversationId,relay_id:relayId,host_id:'local',request_id:randomUUID(),expected_revision:0};
  const prepared = await api('/api/native-conversations/prepare','POST',prepareArgs); assert.equal(prepared.status,200,JSON.stringify(prepared.value));
  assert.equal(prepared.value.operation.status,'prepared'); assert.equal(prepared.value.dynamic_tools.length,5);
  assert.equal(prepared.value.operation.conversation_id,conversationId);
  const illegalSkillPrepare=await api('/api/native-conversations/prepare','POST',{...prepareArgs,request_id:randomUUID(),skill_paths:[scopedSkill.path],project_id:initial.value[0].id,conversation_id:undefined});
  assert.equal(illegalSkillPrepare.status,403);assert.equal(illegalSkillPrepare.value.error,'skill_project_mismatch');
  const busySelect=await api('/api/native-conversations/select','POST',{project_id:project.id,conversation_id:firstConversation.value.conversation.conversation_id});assert.equal(busySelect.status,409);assert.equal(busySelect.value.error,'native_conversation_busy');
  assert.equal((await api('/api/session-relay/poll','POST',pollBody)).value.command,null,'inline operations are not consumed by the queue');
  const threadId = randomUUID();
  assert.equal((await api('/api/native-conversations/bind','POST',{...prepareArgs,thread_id:threadId,checkpoint:'allocated'})).status,200);
  assert.equal((await api('/api/native-conversations/bind','POST',{...prepareArgs,thread_id:threadId,checkpoint:'bound'})).status,200);
  const inputCheck=await api('/api/native-conversations/validate-input','POST',{relay_id:relayId,host_id:'local',thread_id:threadId,skill_paths:[scopedSkill.path]});
  assert.equal(inputCheck.status,200,JSON.stringify(inputCheck.value));
  const turnId = randomUUID();
  assert.equal((await api('/api/native-conversations/receipt','POST',{...prepareArgs,thread_id:threadId,turn_id:turnId,status:'accepted'})).status,200);
  assert.equal((await api('/api/session-relay/events','POST',{relay_id:relayId,method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}})).status,200);
  assert.equal((await api('/api/native-conversations/select','POST',{project_id:project.id,conversation_id:firstConversation.value.conversation.conversation_id})).status,200);
  const oldThreadContext=await api('/api/native-conversations/context?project_id='+project.id+'&conversation_id='+conversationId);
  assert.equal(oldThreadContext.status,200);assert.equal(oldThreadContext.value.thread_id,threadId,'unselected conversation remains readable without creating another native thread');
  assert.equal((await api('/api/native-conversations/select','POST',{project_id:project.id,conversation_id:conversationId})).status,200);
  const nativeContext = await api('/api/native-conversations/tool','POST',{relay_id:relayId,host_id:'local',thread_id:threadId,call_id:randomUUID(),name:'better_codex_project_context_read',arguments:{}});
  assert.equal(nativeContext.status,200,JSON.stringify(nativeContext.value));assert.equal(nativeContext.value.project.id,project.id);
  const draft = await api('/api/project-tools/project_charter_save', 'POST', { project_id: project.id, thread_id: threadId, expected_revision: 0, sections: [{ id: 'architecture', title: '架构', content: '共享接口由基础能力负责。' }], requirements: [{ id: 'REQ-1', content: '验收闭环' }] }); assert.equal(draft.status, 200, JSON.stringify(draft.value));
  const eventId = randomUUID();
  const event = await api('/api/session-relay/events', 'POST', { relay_id: relayId, method: 'item/completed', params: { threadId, item: { type: 'userMessage', id: eventId, content: [{ type: 'text', text: '确认总纲' }] } } }); assert.equal(event.status, 200, JSON.stringify(event.value));
  const confirmed = await api('/api/project-tools/project_charter_confirm', 'POST', { project_id: project.id, thread_id: threadId, expected_revision: draft.value.revision, message_id: eventId }); assert.equal(confirmed.status, 200); assert.equal(confirmed.value.status, 'confirmed');
  const ordinaryIssue = await api('/api/issues','POST',{project_id:project.id,title:'普通页内聊天',description:'Isolated ordinary native reply; do not execute.',status:'backlog',agent_enabled:true,ai_enrich:false});
  assert.equal(ordinaryIssue.status,201);
  const workContext = await api('/api/native-conversations/context?project_id='+project.id+'&kind=work&issue_id='+ordinaryIssue.value.id);
  assert.equal(workContext.value.mode,'draft');
  const ordinaryArgs = {...prepareArgs,kind:'work',issue_id:ordinaryIssue.value.id,request_id:randomUUID(),expected_revision:ordinaryIssue.value.version};delete ordinaryArgs.conversation_id;
  assert.equal((await api('/api/native-conversations/prepare','POST',ordinaryArgs)).status,200);
  const racedStart = await api('/api/issues/'+ordinaryIssue.value.id+'/start','POST',{version:ordinaryIssue.value.version,status:'todo'});
  assert.equal(racedStart.status,409,JSON.stringify(racedStart.value));assert.equal(racedStart.value.error,'issue_execution_running');
  const ordinaryThread = randomUUID(), ordinaryTurn = randomUUID();
  assert.equal((await api('/api/native-conversations/bind','POST',{...ordinaryArgs,thread_id:ordinaryThread,checkpoint:'allocated'})).status,200);
  assert.equal((await api('/api/native-conversations/bind','POST',{...ordinaryArgs,thread_id:ordinaryThread,checkpoint:'bound'})).status,200);
  assert.equal((await api('/api/native-conversations/receipt','POST',{...ordinaryArgs,thread_id:ordinaryThread,turn_id:ordinaryTurn,status:'accepted'})).status,200);
  const activeNativeTask=(await api('/api/native-conversations/context?project_id='+project.id+'&kind=work&issue_id='+ordinaryIssue.value.id)).value.context.task;
  assert.equal(activeNativeTask.session_status,'active');assert.equal(activeNativeTask.session_active_turn_id,ordinaryTurn);assert.equal(activeNativeTask.reply_status,'running');
  const activeOrdinary = await api('/api/issues/'+ordinaryIssue.value.id);
  const whileReply = await api('/api/issues/'+ordinaryIssue.value.id+'/start','POST',{version:activeOrdinary.value.version,status:'todo'});
  assert.equal(whileReply.status,409,JSON.stringify(whileReply.value));assert.equal(whileReply.value.error,'issue_execution_running');
  assert.equal((await api('/api/session-relay/events','POST',{relay_id:relayId,method:'turn/completed',params:{threadId:ordinaryThread,turn:{id:ordinaryTurn,status:'completed'}}})).status,200);
  const followupContext = await api('/api/native-conversations/context?project_id='+project.id+'&kind=work&issue_id='+ordinaryIssue.value.id);
  assert.equal(followupContext.value.thread_id,ordinaryThread);
  const followupArgs = {...ordinaryArgs,request_id:randomUUID(),expected_revision:followupContext.value.expected_revision};
  const followupPrepared = await api('/api/native-conversations/prepare','POST',followupArgs);
  assert.equal(followupPrepared.status,200,JSON.stringify(followupPrepared.value));assert.equal(followupPrepared.value.operation.thread_id,ordinaryThread);
  const followupRacedStart = await api('/api/issues/'+ordinaryIssue.value.id+'/start','POST',{version:followupContext.value.expected_revision,status:'todo'});
  assert.equal(followupRacedStart.status,409,JSON.stringify(followupRacedStart.value));
  assert.equal((await api('/api/native-conversations/bind','POST',{...followupArgs,thread_id:ordinaryThread,checkpoint:'allocated'})).status,200);
  assert.equal((await api('/api/native-conversations/bind','POST',{...followupArgs,thread_id:ordinaryThread,checkpoint:'bound'})).status,200);
  const followupTurn=randomUUID();
  assert.equal((await api('/api/native-conversations/receipt','POST',{...followupArgs,thread_id:ordinaryThread,turn_id:followupTurn,status:'accepted'})).status,200);
  const issue = await api('/api/issues', 'POST', { project_id: project.id, title: '隔离工作任务', description: 'Fixture only; never execute a model request.', status: 'backlog', agent_enabled: true, ai_enrich: false, skill_id: 'better-codex-charter' }); assert.equal(issue.status, 201, JSON.stringify(issue.value));
  const start = await api('/api/issues/' + issue.value.id + '/start', 'POST', { version: issue.value.version, status: 'todo', skill_id: 'better-codex-charter' }); assert.equal(start.status, 202, JSON.stringify(start.value));
  await new Promise(resolve => setTimeout(resolve, 200));
  poll = await api('/api/session-relay/poll', 'POST', pollBody); assert.equal(poll.status, 200); assert.equal(poll.value.command?.issue_id, issue.value.id);
  assert.equal(poll.value.command.payload.native_defaults, true); assert(poll.value.command.payload.input.some(item => item.type === 'skill'));
  assert.equal(poll.value.command.payload.dynamic_tools.length,5,'explicit starts must declare the same scoped project tools as composer starts');
  assert(poll.value.command.payload.dynamic_tools.every(tool=>tool.name.startsWith('better_codex_project_')&&!('project_id' in tool.inputSchema.properties)&&!('thread_id' in tool.inputSchema.properties)));
  const manualThread=randomUUID();
  const manualCheckpoint=await api('/api/session-relay/commands/'+poll.value.command.id+'/checkpoint','POST',{relay_id:relayId,result:{thread_id:manualThread}});
  assert.equal(manualCheckpoint.status,200,JSON.stringify(manualCheckpoint.value));
  const manualContext=await api('/api/native-conversations/context?project_id='+project.id+'&kind=work&issue_id='+issue.value.id);
  assert.equal(manualContext.value.thread_id,manualThread);assert.equal(manualContext.value.mode,'thread');
  const manualTools=await api('/api/native-conversations/tool','POST',{relay_id:relayId,host_id:'local',thread_id:manualThread,call_id:randomUUID(),name:'better_codex_project_context_read',arguments:{}});
  assert.equal(manualTools.status,200,JSON.stringify(manualTools.value));assert.equal(manualTools.value.task.id,issue.value.id);
  const bootstrap=await api('/api/bootstrap');assert.equal(bootstrap.status,200,JSON.stringify(bootstrap.value));
  const bindings=bootstrap.value.native_thread_bindings;
  assert(Array.isArray(bindings));
  assert.deepEqual(bindings.find(row=>row.thread_id===manualThread),{thread_id:manualThread,host_id:'local',project_id:project.id,kind:'work',issue_id:issue.value.id});
  assert.equal(bindings.find(row=>row.thread_id===threadId).kind,'charter');
  assert.equal(bindings.find(row=>row.thread_id===ordinaryThread).issue_id,ordinaryIssue.value.id);
  assert(bindings.every(row=>Object.keys(row).every(key=>['host_id','issue_id','kind','project_id','thread_id','conversation_id'].includes(key))),'bootstrap identity must not expose instructions or draft contents');
  // The native proxy only claims this fixture command; no app-server request is issued.
  const dbFile = (await api('/health')).value.database?.path || fs.readdirSync(home).map(name => path.join(home, name)).find(name => /\.sqlite$|\.db$/.test(name));
  if (dbFile) { const db = new DatabaseSync(dbFile, { readOnly: true }); try {
    assert.equal(db.prepare('SELECT owner FROM issue_native_ownership WHERE issue_id=?').get(issue.value.id).owner, 'native');
    const nativeBinding=db.prepare('SELECT * FROM native_conversation_bindings WHERE thread_id=?').get(manualThread);
    assert.equal(nativeBinding.issue_id,issue.value.id);assert.equal(nativeBinding.project_id,project.id);assert.equal(nativeBinding.kind,'work');assert.equal(nativeBinding.host_id,'local');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issue_runs WHERE issue_id=?').get(ordinaryIssue.value.id).count,0,'ordinary reply does not create an execution run');
    assert.equal(db.prepare('SELECT status FROM issue_replies WHERE issue_id=?').get(ordinaryIssue.value.id).status,'running');
  } finally { db.close(); } }
  // Browse a restarted task's old native thread through real HTTP routes. The
  // fixture only persists IDs/checkpoints; it never contacts an app server.
  assert.equal((await api('/api/session-relay/events','POST',{relay_id:relayId,method:'turn/completed',params:{threadId:ordinaryThread,turn:{id:followupTurn,status:'completed'}}})).status,200);
  const beforeRestart=(await api('/api/native-conversations/context?project_id='+project.id+'&kind=work&issue_id='+ordinaryIssue.value.id)).value;
  const restartedWork=await api('/api/native-conversations/restart','POST',{project_id:project.id,kind:'work',issue_id:ordinaryIssue.value.id,expected_revision:beforeRestart.expected_revision,explicit:true});
  assert.equal(restartedWork.status,200,JSON.stringify(restartedWork.value));assert.equal(restartedWork.value.mode,'draft');
  const workList=await api('/api/native-conversations/list?project_id='+project.id+'&kind=work');assert.equal(workList.status,200);
  const historicalWork=workList.value.conversations.find(row=>row.issue_id===ordinaryIssue.value.id&&row.source==='history');
  assert(historicalWork?.history_id);assert.equal(historicalWork.thread_id,ordinaryThread);assert.equal(historicalWork.read_only,true);
  assert.equal(workList.value.conversations.find(row=>row.issue_id===ordinaryIssue.value.id&&row.source==='current').mode,'draft');
  const newCurrentArgs={...ordinaryArgs,request_id:randomUUID(),expected_revision:restartedWork.value.expected_revision,draft_generation:restartedWork.value.draft_generation};
  const newCurrentThread=randomUUID();
  assert.equal((await api('/api/native-conversations/prepare','POST',newCurrentArgs)).status,200);
  assert.equal((await api('/api/native-conversations/bind','POST',{...newCurrentArgs,thread_id:newCurrentThread,checkpoint:'allocated'})).status,200);
  assert.equal((await api('/api/native-conversations/bind','POST',{...newCurrentArgs,thread_id:newCurrentThread,checkpoint:'bound'})).status,200);
  assert.equal((await api('/api/native-conversations/receipt','POST',{...newCurrentArgs,thread_id:newCurrentThread,status:'failed',error:'fixture sends no model turn'})).status,200);
  const historyTarget={project_id:project.id,kind:'work',issue_id:ordinaryIssue.value.id,history_id:historicalWork.history_id};
  const stateSnapshot=()=>{
    const db=new DatabaseSync(dbFile,{readOnly:true});
    try {return JSON.stringify(Object.fromEntries(['issues','issue_sessions','issue_native_ownership','native_conversation_bindings','native_conversation_history',
      'native_conversation_scopes','native_conversation_operations','native_conversation_tool_calls','project_charter_revisions','project_planning_revisions','issue_runs','issue_replies','session_commands']
      .map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])));} finally {db.close();}
  };
  assert(dbFile,'fixture database must be available for mutation checks');
  const historyBefore=stateSnapshot();
  for (let i=0;i<3;i++) {
    const historyRead=await api('/api/native-conversations/context?'+new URLSearchParams(historyTarget));
    assert.equal(historyRead.status,200,JSON.stringify(historyRead.value));assert.equal(historyRead.value.thread_id,ordinaryThread);
    assert.equal(historyRead.value.read_only,true);assert.equal(historyRead.value.mode,'thread');assert.equal(historyRead.value.target.history_id,historicalWork.history_id);
    assert.equal(historyRead.value.context.task.status,beforeRestart.context.task.status);assert.equal(historyRead.value.context.task.agent_enabled,true);assert.deepEqual(historyRead.value.dynamic_tools,[]);
  }
  const mixedWork=(await api('/api/native-conversations/list?project_id='+project.id+'&kind=work')).value.conversations;
  assert.equal(mixedWork.find(row=>row.issue_id===ordinaryIssue.value.id&&row.source==='current').thread_id,newCurrentThread);
  assert.equal(mixedWork.find(row=>row.history_id===historicalWork.history_id).thread_id,ordinaryThread);
  for (const endpoint of ['prepare','bind','receipt','restart','tool']) {
    const rejected=await api('/api/native-conversations/'+endpoint,'POST',{...newCurrentArgs,...historyTarget,thread_id:newCurrentThread,checkpoint:'bound',status:'failed',explicit:true,
      call_id:randomUUID(),name:'better_codex_project_context_read',arguments:{}});
    assert.equal(rejected.status,403,JSON.stringify(rejected.value));assert.equal(rejected.value.error,'native_history_read_only');
  }
  const archivedTool=await api('/api/native-conversations/tool','POST',{relay_id:relayId,host_id:'local',thread_id:ordinaryThread,call_id:randomUUID(),name:'better_codex_project_charter_save',arguments:{}});
  assert.equal(archivedTool.status,403);assert.equal(archivedTool.value.error,'native_history_read_only');
  for (const endpoint of ['start','session-handoff','reply']) {
    const rejected=await api('/api/issues/'+ordinaryIssue.value.id+'/'+endpoint,'POST',{...historyTarget,version:restartedWork.value.expected_revision,status:'todo',message:'must remain unsent'});
    assert.equal(rejected.status,403,JSON.stringify(rejected.value));assert.equal(rejected.value.error,'native_history_read_only');
  }
  const wrongIssueHistory=await api('/api/native-conversations/context?'+new URLSearchParams({...historyTarget,issue_id:issue.value.id}));
  assert.equal(wrongIssueHistory.status,409);assert.equal(wrongIssueHistory.value.error,'native_history_scope_mismatch');
  const wrongProjectHistory=await api('/api/native-conversations/context?'+new URLSearchParams({...historyTarget,project_id:initial.value[0].id}));
  assert.equal(wrongProjectHistory.status,409);assert.equal(wrongProjectHistory.value.error,'issue_project_mismatch');
  const wrongKindHistory=await api('/api/native-conversations/context?'+new URLSearchParams({...historyTarget,kind:'charter'}));
  assert.equal(wrongKindHistory.status,409);assert.equal(wrongKindHistory.value.error,'native_history_scope_mismatch');
  assert.equal(stateSnapshot(),historyBefore,'real HTTP history/list routes and refused writes preserve records, bindings, ownership and versions');
  const historyBootstrap=(await api('/api/bootstrap')).value.native_thread_bindings;
  assert(!historyBootstrap.some(row=>row.thread_id===ordinaryThread),'read-only history is never enrolled as a current binding');
  assert(historyBootstrap.some(row=>row.thread_id===newCurrentThread&&row.issue_id===ordinaryIssue.value.id));
  assert.equal((await api('/api/agents', 'POST', {})).status, 404);
  const buttonDraft = await api('/api/project-tools/project_charter_save','POST',{ project_id:project.id,thread_id:threadId,
    expected_revision:confirmed.value.revision,sections:[{id:'scope',title:'范围',content:'按钮确认测试'}] });
  assert.equal(buttonDraft.status,200);
  const buttonConfirmed = await api('/api/projects/'+project.id+'/charter-confirm','POST',{expected_revision:buttonDraft.value.revision});
  assert.equal(buttonConfirmed.status,200,JSON.stringify(buttonConfirmed.value));
  assert.equal(buttonConfirmed.value.status,'confirmed');
  assert.match(buttonConfirmed.value.confirmation_message_id,/^ui-charter-confirm:/);
  assert.equal((await api('/api/projects/'+project.id+'/charter-confirm','POST',{expected_revision:buttonDraft.value.revision})).status,409);
  assert(!/codex_exec|planning_process_started|scheduler_started/.test(output), 'no model process may be started by the fixture');
  console.log('PASS: isolated real backend routes, read-only opening, first-send checkpoints, trusted native tools, confirmation events and explicit native-owned work queue without model execution');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child?.exitCode === null && port && token) await api('/api/shutdown', 'POST', {}).catch(() => {});
  if (child?.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 4000))]); if (child.exitCode === null) child.kill(); }
  const resolved = path.resolve(folder); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('bc-native-backend-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries:10, retryDelay:100 });
});

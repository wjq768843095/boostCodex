'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createNativeProjectRuntime, workPayload } = require('../src/modules/native-project-runtime.cjs');

function createFixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'better-codex-native-fixture-'));
  const home = path.join(temporary, 'better-home'), userHome = path.join(temporary, 'user'), codexHome = path.join(temporary, 'codex');
  const roots = [path.join(temporary, 'frontend'),path.join(temporary, 'backend'),path.join(temporary, 'missing')];
  for (const folder of [home,userHome,codexHome,...roots.slice(0,2)]) fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(roots[0],'package.json'),JSON.stringify({name:'fixture',dependencies:{vue:'^3.4.0'},engines:{node:'>=24'}}));
  fs.writeFileSync(path.join(roots[0],'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/vue':{version:'3.4.38'}}}));
  fs.writeFileSync(path.join(roots[1],'composer.json'),JSON.stringify({require:{php:'^8.2','topthink/framework':'^6.0'}}));
  const externalPath = path.join(codexHome,'skills','external-reader','SKILL.md');
  fs.mkdirSync(path.dirname(externalPath),{recursive:true});
  const externalText = '---\nname: external-reader\ndescription: External fixture\n---\n\nDo not change my instructions.\n';
  fs.writeFileSync(externalPath,externalText);
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,workspace_path TEXT);
    CREATE TABLE issues(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),identifier TEXT,title TEXT,description TEXT,
      status TEXT,version INTEGER,agent_enabled INTEGER,user_assigned INTEGER,needs_attention INTEGER,thread_id TEXT,history TEXT,
      run_thread_id TEXT,active_run_status TEXT,agent_id TEXT);`);
  const projects = new Map(['p1','p2','p3'].map((projectId,index)=>[projectId,{id:projectId,name:'项目 '+projectId,
    workspace_path:roots[index===2?1:0],root_paths:index===0?roots:[roots[1]],description:'isolated fixture'}]));
  for (const project of projects.values()) db.prepare('INSERT INTO projects VALUES(?,?,?)').run(project.id,project.name,project.workspace_path);
  const state = {create:0,update:0,wake:0,dispatch:0,change:0};
  const store = {
    db, getProject: projectId=>projects.get(projectId), getIssue:issueId=>db.prepare('SELECT * FROM issues WHERE id=?').get(issueId),
    listIssues:({projectId}={})=>projectId?db.prepare('SELECT * FROM issues WHERE project_id=?').all(projectId):db.prepare('SELECT * FROM issues').all(),
    listAgentProfiles:()=>[{id:'legacy-reader',name:'旧角色',description:'迁移后的指导',instructions:'Read requirements carefully.'}],
    nativeSessionProxyIsLeader:relayId=>relayId==='relay-leader',
    createIssue(input) {
      const number = ++state.create;
      const userAssigned = Boolean(input.userAssigned) && !Boolean(input.agentEnabled);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO issues VALUES(?,?,?,?,?,?,1,?,?,?,NULL,?,NULL,NULL,NULL)').run(input.id,input.projectId,'FIX-'+number,
          input.title,input.description,input.status,Number(input.agentEnabled),Number(userAssigned),Number(input.agentEnabled&&input.status!=='backlog'), 'existing history');
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
      return this.getIssue(input.id);
    },
    updateIssue(issueId,version,patch) {
      assert.equal(this.getIssue(issueId).version,version);
      state.update++;
      db.prepare('UPDATE issues SET title=?,description=?,version=version+1 WHERE id=?').run(patch.title,patch.description,issueId);
      return this.getIssue(issueId);
    }
  };
  const worker = {wake(){state.wake++;throw Error('unexpected_worker_wake');},startIssue(){state.dispatch++;throw Error('unexpected_dispatch');}};
  const runtime = createNativeProjectRuntime({store,worker,home,userHome,codexHome,publishChange(){state.change++;}});
  store.nativeProjectRuntime = runtime;
  async function api(route,method='GET',body={}) {
    let result;
    const handled = await runtime.handle({url:new URL(route,'http://fixture.invalid'),method,request:{},response:{},readBody:async()=>body,
      sendJson(_response,status,value){result={status,value};}});
    assert.equal(handled,true,'expected runtime route: '+route);
    return result;
  }
  const charterArgs = (projectId,threadId,extra={})=>({project_id:projectId,thread_id:threadId,expected_revision:0,
    title:'通用项目总纲',sections:[{id:'scope',title:'范围',content:'按已有需求交付'},
      {id:'api',title:'接口契约',content:'旧确认接口契约'}],requirements:[{id:'REQ-1',content:'闭环验收'}],
    metadata:{workspace_map:[{path:roots[0],role:'Web前端',source_of_truth:'本地源码'},
      {path:path.dirname(externalPath),role:'外部目录',source_of_truth:'外部权威'}]},
    facts:[{source:path.join(roots[0],'package-lock.json'),name:'vue',version:'3.4.38',version_kind:'locked'}],...extra});
  const item = (extra={})=>({id:'deliver-login',title:'登录闭环',goal:'用户完成登录',scope:'前后端',requirement_refs:['REQ-1'],
    directories:[roots[0],roots[1]],deliverables:['可用登录入口','权限校验'],contract_refs:['api'],contract_owner:'共享接口',dependencies:[],
    acceptance:['有权限可访问，无权限拒绝'],manual_steps:['打开入口，提交登录，验证结果'],unresolved_questions:[],skill_id:'better-codex-plan',...extra});
  async function startAndBind(projectId,kind,threadId) {
    const started = await api('/api/projects/'+projectId+'/native-session','POST',{kind,request_id:projectId+'-'+kind});
    assert.equal(started.value.command,null); assert.equal(started.value.session,null);
    assert.equal(runtime.planning.listPendingCommands().length,0,'opening is read-only');
    const args = {project_id:projectId,kind,request_id:projectId+'-'+kind,relay_id:'relay-leader',host_id:'local',expected_revision:0};
    const prepared = await api('/api/native-conversations/prepare','POST',args);
    const command = {id:prepared.value.operation.request_id};
    await api('/api/native-conversations/bind','POST',{...args,thread_id:threadId,checkpoint:'allocated'});
    const checkpoint = await api('/api/native-conversations/bind','POST',{...args,thread_id:threadId,checkpoint:'bound'});
    const duringStart = await api('/api/projects/'+projectId+'/native-session','POST',{kind,request_id:'repeat-during-'+command.id});
    assert.equal(duringStart.value.session.thread_id,threadId);
    assert.equal(duringStart.value.command,null);
    assert.equal(duringStart.value.pending_operation.request_id,command.id);
    assert.equal(duringStart.value.pending_operation.status,'bound');
    await api('/api/native-conversations/receipt','POST',{...args,thread_id:threadId,turn_id:'turn-'+threadId,status:'accepted'});
    assert.ok(runtime.activeTurns().some(turn=>turn.thread_id===threadId&&turn.turn_id==='turn-'+threadId));
    assert.equal(runtime.conversations.operation(command.id).status,'accepted');
    // A command receipt acknowledges dispatch, not the end of its native turn.
    assert.ok(runtime.activeTurns().some(turn=>turn.thread_id===threadId&&turn.turn_id==='turn-'+threadId));
    runtime.handleProjectEvent('turn/completed',{threadId,turn:{id:'old-'+threadId,status:'completed'}});
    assert.equal(runtime.planning.getSession(projectId,kind).status,'running');
    assert.ok(runtime.activeTurns().some(turn=>turn.thread_id===threadId&&turn.turn_id==='turn-'+threadId));
    runtime.handleProjectEvent('turn/completed',{threadId,turn:{id:'turn-'+threadId,status:'completed'}});
    assert.equal(runtime.activeTurns().some(turn=>turn.thread_id===threadId),false);
    return {started,command,checkpoint};
  }
  function userMessage(threadId,eventId,message) {
    return runtime.handleProjectEvent('item/completed',{threadId,item:{type:'userMessage',id:eventId,content:[{type:'text',text:message}]}});
  }
  function cleanup() {
    db.close();
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('better-codex-native-fixture-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
  return {temporary,home,userHome,codexHome,roots,externalPath,externalText,store,state,runtime,api,charterArgs,item,startAndBind,userMessage,cleanup};
}

async function run() {
  const f = createFixture();
  try {
    const {runtime,api,store,state} = f;
    for (const builtin of runtime.skills.list({includeExternal:false}).managed) {
      assert.ok(builtin.path.startsWith(f.userHome+path.sep)); assert.ok(fs.existsSync(builtin.path));
    }
    await assert.rejects(api('/api/projects/p1/native-session','POST',{kind:'planning'}),/confirmed_charter_required/);
    const {started,command} = await f.startAndBind('p1','charter','charter-p1');
    assert.equal(Object.hasOwn(started.value,'prompt'),false);
    assert.deepEqual(started.value.root_paths,f.roots);
    assert.equal(started.value.mode,'draft');
    const repeat = await api('/api/projects/p1/native-session','POST',{kind:'charter'});
    assert.equal(repeat.value.command,null);assert.equal(repeat.value.session.thread_id,'charter-p1');
    await f.startAndBind('p2','charter','charter-p2');
    await api('/api/project-tools/project_charter_save','POST',f.charterArgs('p1','charter-p1'));
    await api('/api/project-tools/project_charter_save','POST',f.charterArgs('p2','charter-p2'));
    await assert.rejects(api('/api/project-tools/project_charter_save','POST',f.charterArgs('p1','charter-p2',{expected_revision:1})),/session_thread_mismatch/);
    assert.equal(f.userMessage('unbound-thread','unbound','确认总纲'),false);
    f.userMessage('charter-p1','conditional','等我确认总纲再规划');
    assert.equal(runtime.context('p1',{thread_id:'charter-p1'}).confirmation_candidates.length,0);
    await assert.rejects(api('/api/project-tools/project_charter_confirm','POST',{project_id:'p1',thread_id:'charter-p1',expected_revision:1,message_id:'invented'}),/explicit_user_confirmation_required/);
    f.userMessage('charter-p1','real-user','确认总纲');
    assert.equal(runtime.context('p1',{thread_id:'charter-p1'}).confirmation_candidates[0].event_id,'real-user');
    await assert.rejects(api('/api/project-tools/project_charter_confirm','POST',{project_id:'p2',thread_id:'charter-p2',expected_revision:1,message_id:'real-user'}),/explicit_user_confirmation_required/);
    const confirmed = await api('/api/project-tools/project_charter_confirm','POST',{project_id:'p1',thread_id:'charter-p1',expected_revision:1,message_id:'real-user'});
    assert.equal(confirmed.value.revision,2);
    const planningStart = await f.startAndBind('p1','planning','planning-p1');
    assert.equal(planningStart.started.value.context.workspaces[0].role,'Web前端');
    assert.equal(planningStart.started.value.context.workspaces[0].source_of_truth,'本地源码');
    assert.equal(planningStart.started.value.context.workspaces[2].availability,'missing');
    assert.deepEqual(planningStart.started.value.root_paths,f.roots);
    assert.equal(runtime.context('p1',{thread_id:'planning-p1'}).confirmation_candidates.length,0);
    const context = runtime.context('p1');
    assert.deepEqual(context.root_paths,f.roots);assert.equal(context.workspaces[2].availability,'missing');
    assert.equal(context.workspaces[0].role,'Web前端');assert.equal(context.workspaces[0].source_of_truth,'本地源码');
    assert.equal(context.workspaces.some(workspace=>workspace.path===path.dirname(f.externalPath)),false);
    assert.equal(context.charter.facts[0].version,'3.4.38');
    assert.ok(context.stack_facts.some(fact=>fact.name==='vue'&&fact.version==='3.4.38'&&fact.version_kind==='locked'));
    assert.ok(context.stack_facts.every(fact=>fact.runtime_version==='unknown'));
    assert.ok(context.skills.some(skill=>skill.id==='better-codex-plan'));
    const plan = await api('/api/project-tools/project_plan_save','POST',{project_id:'p1',thread_id:'planning-p1',expected_revision:0,charter_revision:2,items:[f.item()]});
    assert.equal(plan.value.items[0].directories.length,2);assert.equal(plan.value.items[0].contract_owner,'共享接口');
    const converted = await api('/api/projects/p1/plan/convert','POST',{expected_revision:1,item_ids:['deliver-login']});
    const issue = converted.value.issues[0];
    assert.equal(issue.status,'backlog');assert.equal(issue.agent_enabled,1);assert.equal(issue.needs_attention,0);
    assert.equal(issue.thread_id,null);assert.equal(issue.skill_id,'better-codex-plan');
    assert.equal(state.dispatch,0);assert.equal(state.wake,0);
    await api('/api/projects/p1/plan/convert','POST',{expected_revision:1,item_ids:['deliver-login']});
    assert.equal(state.create,1);assert.equal(state.update,0);
    await api('/api/project-tools/project_charter_save','POST',f.charterArgs('p1','charter-p1',{expected_revision:2,
      sections:[{id:'api',title:'新契约',content:'新草稿未确认'}],
      metadata:{workspace_map:[{path:f.roots[0],role:'新草稿职责',source_of_truth:'待确认来源'}]}}));
    await api('/api/project-tools/project_plan_save','POST',{project_id:'p1',thread_id:'planning-p1',expected_revision:1,
      charter_revision:2,items:[f.item({title:'后续修订的登录闭环'})]});
    assert.equal(runtime.planning.getPlan('p1').revision,2);
    store.db.prepare('UPDATE issues SET thread_id=? WHERE id=?').run('work-p1',issue.id);
    const workContext = runtime.context('p1',{thread_id:'work-p1'});
    assert.equal(workContext.charter.status,'confirmed');assert.equal(workContext.charter.revision,2);
    assert.equal(workContext.charter.sections.find(section=>section.id==='api').content,'旧确认接口契约');
    assert.equal(workContext.plan.revision,1);
    assert.equal(workContext.plan.items[0].title,'登录闭环');
    assert.equal(workContext.workspaces[0].role,'Web前端');assert.equal(workContext.workspaces[0].source_of_truth,'本地源码');
    assert.deepEqual(workContext.root_paths,f.roots);
    assert.equal(workContext.task.item_id,'deliver-login');
    assert.ok(workContext.tasks.some(task=>task.id===issue.id&&task.version===issue.version));
    assert.deepEqual(workContext.confirmation_candidates,[]);
    const externalMetadata = workContext.skills.find(skill=>skill.managed===false&&skill.path===f.externalPath);
    assert.ok(externalMetadata);assert.equal(Object.hasOwn(externalMetadata,'instructions'),false);
    assert.throws(()=>runtime.context('p2',{thread_id:'work-p1'}),/session_thread_mismatch/);
    await assert.rejects(api('/api/project-tools/project_charter_save','POST',f.charterArgs('p1','work-p1',{expected_revision:3})),/session_thread_mismatch/);
    const payload = workPayload(store,store.getIssue(issue.id),f.roots[0],'现在开发',[{type:'text',text:'现在开发'}]);
    assert.equal(payload.native_defaults,true);assert.deepEqual(payload.root_paths,f.roots);
    assert.equal(payload.dynamic_tools.length,5);assert(payload.dynamic_tools.every(tool=>tool.name.startsWith('better_codex_project_')));
    assert.ok(payload.message.includes('项目总纲版本：2'));assert.ok(payload.message.includes('规划项：deliver-login'));
    assert.ok(payload.message.includes('Web前端'));assert.ok(payload.message.includes('本地源码'));
    assert.ok(!payload.message.includes('外部目录'));
    assert.ok(payload.input.some(entry=>entry.type==='skill'&&entry.name==='better-codex-plan'&&entry.path.startsWith(f.userHome)));
    assert.equal(JSON.parse(payload.config_fingerprint).charter_revision,2);
    for (const forbidden of ['model','model_provider','reasoning_effort','sandbox','approval_policy','fast_mode']) assert.equal(Object.hasOwn(payload,forbidden),false);
    const selected = runtime.skills.get('better-codex-plan');
    await api('/api/skills/'+selected.id,'PATCH',{version:selected.version,instructions:selected.instructions+'\n新增指导。'});
    const nextPayload = workPayload(store,store.getIssue(issue.id),f.roots[0],'现在开发');
    assert.notEqual(payload.config_fingerprint,nextPayload.config_fingerprint);
    runtime.handleProjectEvent('turn/started',{threadId:'planning-p1',turn:{id:'manual-planning-turn'}});
    assert.equal(runtime.planning.getSession('p1','planning').status,'running');
    assert.deepEqual(runtime.activeTurns().map(turn=>({thread_id:turn.thread_id,turn_id:turn.turn_id})),[{thread_id:'planning-p1',turn_id:'manual-planning-turn'}]);
    runtime.handleProjectEvent('turn/completed',{threadId:'planning-p1',turn:{id:'previous-planning-turn',status:'completed'}});
    assert.equal(runtime.planning.getSession('p1','planning').status,'running');
    assert.equal(runtime.activeTurns()[0].turn_id,'manual-planning-turn');
    runtime.handleProjectEvent('turn/completed',{threadId:'planning-p1',turn:{id:'manual-planning-turn',status:'completed'}});
    assert.equal(runtime.planning.getSession('p1','planning').status,'ready');
    assert.equal(runtime.activeTurns().length,0);
    const created = await api('/api/skills','POST',{name:'测试技能',slug:'better-codex-fixture',description:'独立指导',instructions:'测试技能内容'});
    assert.equal(created.status,201);assert.equal(created.value.skill.version,1);assert.ok(fs.existsSync(created.value.skill.path));
    const skillId = created.value.skill.id;
    const unchangedSkill = runtime.skills.get(skillId), unchangedFile = fs.readFileSync(unchangedSkill.path,'utf8'), unchangedChangeCount=state.change;
    await assert.rejects(api('/api/skills/'+skillId,'PATCH',{instructions:'未携带版本的覆盖'}),/invalid_version/);
    await assert.rejects(api('/api/skills/'+skillId,'DELETE',{}),/invalid_version/);
    assert.deepEqual(runtime.skills.get(skillId),unchangedSkill);
    assert.equal(fs.readFileSync(unchangedSkill.path,'utf8'),unchangedFile);
    assert.equal(state.change,unchangedChangeCount);
    await api('/api/skills/'+skillId,'PATCH',{version:1,instructions:'更新内容'});
    await assert.rejects(api('/api/skills/'+skillId,'PATCH',{version:1,instructions:'覆盖并发内容'}),/version_conflict/);
    await assert.rejects(api('/api/skills/'+skillId,'DELETE',{version:1}),/version_conflict/);
    const external = (await api('/api/skills')).value.external.find(entry=>entry.path===f.externalPath);
    assert.ok(external);assert.equal(external.managed,false);
    await assert.rejects(api('/api/skills/'+encodeURIComponent(external.id),'PATCH',{version:0,instructions:'forbidden'}),/external_skill_read_only/);
    await assert.rejects(api('/api/skills/'+encodeURIComponent(external.id),'DELETE',{version:0}),/external_skill_read_only/);
    await assert.rejects(api('/api/skills/'+encodeURIComponent(external.id),'DELETE',{}),/external_skill_read_only/);
    assert.equal(fs.readFileSync(f.externalPath,'utf8'),f.externalText);
    await api('/api/skills/'+skillId,'DELETE',{version:2});assert.equal(runtime.skills.get(skillId),null);
    await assert.rejects(api('/api/projects/p1/native-session/bind','POST',{kind:'charter',request_id:command.id,relay_id:'foreign-relay',thread_id:'attacker'}),/session_relay_not_leader/);
    const pendingStart = runtime.planning.enqueueCommand({project_id:'p3',session_kind:'charter',kind:'start',expected_revision:0,request_id:'recovery-checkpoint',payload:{message:'legacy queued explicit send'}});
    runtime.planning.claimCommand('relay-leader');
    runtime.commandReceipt(pendingStart.id,'relay-leader','checkpoint',{thread_id:'recovered-thread',turn_id:'recovered-turn'});
    runtime.planning.enqueueCommand({project_id:'p2',session_kind:'charter',kind:'turn',thread_id:'charter-p2',expected_revision:1,
      request_id:'recovery-no-checkpoint',payload:{message:'继续澄清'}});
    runtime.planning.claimCommand('relay-leader');
    const restarted = createNativeProjectRuntime({store,worker:{wake(){throw Error('unexpected restart wake');}},
      home:f.home,userHome:f.userHome,codexHome:f.codexHome});
    assert.equal(restarted.planning.getCommand(pendingStart.id).status,'outcome_unknown');
    assert.equal(restarted.planning.getCommand('recovery-no-checkpoint').status,'pending');
    assert.equal(restarted.planning.getSession('p3','charter').thread_id,'recovered-thread');
    assert.equal(restarted.startSession('p3',{kind:'charter'}).command,null);
    // A thread-only checkpoint does not prove the native first turn was saved.
    // After recovery, keep the unresolved command attached to the button and
    // expose no session that the UI could prematurely open or replay.
    store.db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p4','项目四',f.roots[0]);
    const p4 = {...store.getProject('p3'),id:'p4',name:'项目四',workspace_path:f.roots[0],root_paths:[f.roots[0]]};
    const originalGetProject = store.getProject;
    store.getProject = projectId => projectId==='p4'?p4:originalGetProject(projectId);
    // Finish the unrelated safely requeued command before claiming this start.
    const requeued = restarted.planning.claimCommand('relay-leader');
    restarted.commandReceipt(requeued.id,'relay-leader','complete',{thread_id:'charter-p2'});
    const threadOnlyStart = restarted.planning.enqueueCommand({project_id:'p4',session_kind:'charter',kind:'start',expected_revision:0,request_id:'recovery-thread-only',payload:{message:'legacy queued explicit send'}});
    const threadOnlyClaim = restarted.planning.claimCommand('relay-leader');
    assert.equal(threadOnlyClaim.id,threadOnlyStart.id);
    restarted.commandReceipt(threadOnlyStart.id,'relay-leader','checkpoint',{thread_id:'thread-without-first-turn'});
    const secondRestart = createNativeProjectRuntime({store,worker:{wake(){throw Error('unexpected restart wake');}},
      home:f.home,userHome:f.userHome,codexHome:f.codexHome});
    const unresolved = secondRestart.startSession('p4',{kind:'charter',request_id:'must-not-create-another-thread'});
    assert.equal(unresolved.session.thread_id,'thread-without-first-turn');
    assert.equal(unresolved.command,null);
    assert.equal(secondRestart.planning.getCommand(threadOnlyStart.id).status,'outcome_unknown');
    assert.equal(secondRestart.planning.getSession('p4','charter').thread_id,'thread-without-first-turn');
    assert.equal(secondRestart.planning.listPendingCommands().some(entry=>entry.project_id==='p4'),false);
    const again = secondRestart.startSession('p4',{kind:'charter'});
    assert.equal(again.session.thread_id,'thread-without-first-turn');assert.equal(again.command,null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM project_native_commands WHERE project_id=?').get('p4').count,1);
    secondRestart.planning.enqueueCommand({project_id:'p2',session_kind:'planning',kind:'start',expected_revision:0,
      request_id:'retire-automatic-open',payload:{native_defaults:true,message:'previous generated opening prompt'}});
    const migrated = createNativeProjectRuntime({store,worker:{wake(){throw Error('unexpected migration wake');}},home:f.home,userHome:f.userHome,codexHome:f.codexHome});
    assert.equal(migrated.planning.getCommand('retire-automatic-open').status,'failed');
    assert.equal(migrated.planning.getCommand('retire-automatic-open').payload.message,'previous generated opening prompt');
    assert.equal(migrated.planning.listPendingCommands().length,0,'previous auto-opening requests must never be resent');
    const migrationBackups=fs.readdirSync(path.join(f.home,'backups','native-conversations'));
    assert(migrationBackups.length>0);
    createNativeProjectRuntime({store,worker:{wake(){throw Error('unexpected migration wake');}},home:f.home,userHome:f.userHome,codexHome:f.codexHome});
    assert.deepEqual(fs.readdirSync(path.join(f.home,'backups','native-conversations')),migrationBackups,'idempotent migration only backs up actual affected records once');
    assert.equal(state.dispatch,0);assert.equal(state.wake,0);
    console.log('PASS: native project runtime lifecycle, confirmation evidence, safe backlog conversion, pinned work payload and Skill API');
  } finally { f.cleanup(); }
}

module.exports = {createFixture,run};
if (require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});

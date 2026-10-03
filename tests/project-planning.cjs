'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createProjectPlanning } = require('../src/modules/project-planning.cjs');

const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,workspace_path TEXT);
  CREATE TABLE issues(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,description TEXT,
    status TEXT,version INTEGER,history TEXT,agent_enabled INTEGER,run_thread_id TEXT,active_run_status TEXT);
  INSERT INTO projects VALUES('p1','项目一','D:\\projects\\one'),('p2','项目二','D:\\projects\\two');`);
let creates = 0, updates = 0;
const getIssue = issueId => db.prepare('SELECT * FROM issues WHERE id=?').get(issueId);
const api = createProjectPlanning({ db,
  getProject: projectId => db.prepare('SELECT * FROM projects WHERE id=?').get(projectId), getIssue,
  listIssues: () => db.prepare('SELECT * FROM issues').all(), home: 'unused-memory-fixture',
  createIssue(input) {
    creates++;
    assert.equal(input.status, 'backlog'); assert.equal(input.agentEnabled, true);
    // Model the real Store's transaction: conversion must not nest BEGIN.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO issues VALUES(?,?,?,?,?,1,?,?,NULL,NULL)').run(input.id, input.projectId,
        input.title, input.description, input.status, 'existing execution history', Number(input.agentEnabled));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return getIssue(input.id);
  },
  updateIssue(issueId, expected, patch) {
    const issue = getIssue(issueId); assert.equal(issue.version, expected);
    assert.deepEqual(Object.keys(patch).sort(), ['description','title']); updates++;
    db.prepare('UPDATE issues SET title=?,description=?,version=version+1 WHERE id=?').run(patch.title, patch.description, issueId);
    return getIssue(issueId);
  }
});

const throws = (operation, code) => assert.throws(operation, error => error.code === code, code);
const bind = (project_id, kind, thread_id) => api.bindSession({ project_id, kind, thread_id, expected_revision: 0 });
const charterWrite = (extra = {}) => ({ project_id:'p1', thread_id:'charter-1', expected_revision:0,
  title:'通用技术栈总纲', sections:[{id:'stack',title:'技术栈',content:'Node SQLite 原生会话'},
    {id:'api',title:'接口契约',content:'版本冲突拒绝写入'}], requirements:[{id:'r1',content:'稳定版本'}, {id:'r2',content:'人工验收'}],
  metadata:{stack:'Node'}, facts:[{source:'local',fact:'SQLite'}], ...extra });
const item = (extra = {}) => ({id:'stable-task',title:'实现接口',goal:'版本可追溯',scope:['数据层'],directories:['src/modules'],
  deliverables:['接口'],requirement_refs:['r1'],contract_refs:['api'],contract_owner:'数据层',dependencies:[],
  acceptance:['冲突写入被拒绝'],manual_steps:['用户读取旧版本'],skill_id:'better-codex',unresolved_questions:[],...extra});
const planWrite = (extra = {}) => ({project_id:'p1',thread_id:'plan-1',expected_revision:0,charter_revision:2,items:[item()],...extra});

try {
  api.migrate(); api.migrate();
  assert.equal(api.getCharter('p1'), null); assert.equal(api.getPlan('p1'), null);
  assert.equal(api.getContext('p1').sessions.charter, null);
  throws(() => api.getContext('missing'), 'project_not_found');
  bind('p1','charter','charter-1'); bind('p1','planning','plan-1');
  bind('p2','charter','charter-2'); bind('p2','planning','plan-2');
  throws(() => api.saveCharter(charterWrite({thread_id:'charter-2'})), 'session_thread_mismatch');
  throws(() => api.bindSession({project_id:'p2',kind:'planning',thread_id:'plan-1',expected_revision:1}), 'session_thread_mismatch');
  const draft = api.saveCharter(charterWrite()); assert.equal(draft.revision,1); assert.equal(draft.status,'draft');
  assert.deepEqual(draft.metadata,{stack:'Node'});
  throws(() => api.saveCharter(charterWrite()), 'version_conflict');
  throws(() => api.savePlan(planWrite({charter_revision:1})), 'confirmed_charter_required');
  throws(() => api.confirmCharter({project_id:'p1',thread_id:'charter-1',expected_revision:1,
    confirmed:true,confirmation_role:'user',message_id:'invented',confirmation_message:'确认总纲'}), 'explicit_user_confirmation_required');
  const event = (event_id, role, message, extra = {}) => api.recordSessionEvent({project_id:'p1',kind:'charter',
    thread_id:'charter-1',event_id,role,message,expected_revision:1,...extra});
  event('assistant','assistant','确认总纲'); event('negative','user','暂不确认总纲');
  event('future','user','等我确认总纲再规划'); event('instruction','user','请用户确认总纲后再规划');
  assert.equal(api.getConfirmationCandidates('p1','charter-1').length,0);
  event('real-user-message','user','确认总纲');
  assert.equal(api.getConfirmationCandidates('p1','charter-1')[0].event_id,'real-user-message');
  assert.equal(api.getContext('p1',{thread_id:'plan-1'}).confirmation_candidates.length,0);
  throws(() => api.getContext('p1',{thread_id:'charter-2'}), 'session_thread_mismatch');
  assert.equal(event('real-user-message','user','确认总纲').replayed,true);
  assert.ok(!Object.hasOwn(db.prepare('SELECT * FROM project_native_session_events WHERE event_id=?').get('real-user-message'),'message'));
  throws(() => event('real-user-message','user','同意总纲'), 'event_id_conflict');
  api.saveCharter({...charterWrite(),project_id:'p2',thread_id:'charter-2'});
  throws(() => api.confirmCharter({project_id:'p2',thread_id:'charter-2',expected_revision:1,message_id:'real-user-message'}), 'explicit_user_confirmation_required');
  throws(() => api.confirmCharter({project_id:'p1',thread_id:'charter-1',expected_revision:1,
    message_id:'real-user-message',confirmation_message:'同意总纲'}), 'confirmation_message_mismatch');
  const confirmed = api.confirmCharter({project_id:'p1',thread_id:'charter-1',expected_revision:1,message_id:'real-user-message'});
  assert.equal(confirmed.revision,2); assert.equal(confirmed.status,'confirmed');
  assert.equal(confirmed.confirmation_message_id,'real-user-message'); assert.equal(confirmed.confirmation_message,null);
  assert.equal(api.getCharter('p1',{revision:1}).status,'draft');
  assert.deepEqual(api.getCharter('p1',{revision:2,section_ids:['api']}).sections.map(entry=>entry.id),['api']);
  throws(() => api.getCharter('p2',{revision:2}), 'charter_revision_not_found');
  throws(() => api.getCharter('p1',{section_id:'missing'}), 'charter_section_not_found');
  throws(() => api.savePlan(planWrite({items:[item({dependencies:['missing']})]})), 'invalid_plan');
  const cyclic = api.validate('p1',{charter_revision:2,items:[item({id:'a',dependencies:['b']}),item({id:'b',dependencies:['a']})]});
  assert.equal(cyclic.valid,false); assert.ok(cyclic.errors.some(error=>error.code==='dependency_cycle'));
  throws(() => api.savePlan(planWrite({items:[item(),item()]})), 'duplicate_item_id');
  const duplicateMappings = api.validate('p1',{charter_revision:2,items:[item({id:'a'}),item({id:'b'})]});
  assert.ok(duplicateMappings.warnings.some(warning=>warning.code==='duplicate_requirement_mapping'));
  const minimal = api.validate('p1',{charter_revision:2,items:[{id:'minimal',title:'待补充的规划项',goal:'验收业务结果'}]});
  assert.equal(minimal.valid,true);
  for (const code of ['missing_scope','missing_acceptance','missing_deliverables','missing_manual_steps','missing_directories','missing_contract_refs','missing_requirement_refs']) {
    assert.ok(minimal.warnings.some(warning=>warning.code===code&&warning.item_id==='minimal'),code);
  }
  const plan = api.savePlan(planWrite()); assert.equal(plan.revision,1); assert.equal(plan.charter_revision,2);
  assert.ok(plan.validation.warnings.some(warning=>warning.code==='unmapped_requirement'));
  throws(() => api.savePlan(planWrite()), 'version_conflict');
  const convert = (extra = {}) => api.convertItems({project_id:'p1',thread_id:'plan-1',expected_revision:1,item_ids:['stable-task'],...extra});
  throws(() => convert({item_ids:['stable-task','unknown']}), 'plan_item_not_found'); assert.equal(creates,0);
  throws(() => convert({expected_revision:0}), 'version_conflict');
  const first = convert(); const issueId = first.items[0].issue_id;
  assert.equal(creates,1); assert.equal(getIssue(issueId).status,'backlog');
  assert.match(getIssue(issueId).description,/D:\\projects\\one/);
  assert.match(getIssue(issueId).description,/版本冲突拒绝写入/); assert.match(getIssue(issueId).description,/人工验收步骤/);
  assert.equal(convert().items[0].replayed,true); assert.equal(creates,1); assert.equal(updates,0);
  // Recover a creation that persisted before its link did.
  db.prepare('DELETE FROM project_planning_issue_links WHERE project_id=?').run('p1');
  assert.equal(convert().items[0].issue_id,issueId); assert.equal(creates,1);
  api.saveCharter(charterWrite({expected_revision:2,sections:[{id:'stack',title:'技术栈',content:'变更后的草稿'}]}));
  throws(() => api.confirmCharter({project_id:'p1',thread_id:'charter-1',expected_revision:3,message_id:'real-user-message'}), 'explicit_user_confirmation_required');
  api.savePlan(planWrite({expected_revision:1,items:[item({title:'新任务标题'})]}));
  assert.equal(api.getPlan('p1',{revision:1}).items[0].title,'实现接口');
  assert.equal(api.getContext('p1',{plan_revision:1}).charter.revision,2);
  assert.equal(api.getCharter('p1',{revision:2}).sections[1].content,'版本冲突拒绝写入');
  assert.equal(convert({expected_revision:2}).items[0].issue.title,'实现接口');
  throws(() => convert({expected_revision:2,action:'update'}), 'version_conflict');
  db.prepare("UPDATE issues SET status='done' WHERE id=?").run(issueId);
  convert({expected_revision:2,action:'update',issue_versions:{'stable-task':1}});
  assert.equal(updates,1); assert.equal(getIssue(issueId).title,'新任务标题');
  assert.equal(getIssue(issueId).status,'done'); assert.equal(getIssue(issueId).history,'existing execution history');
  db.prepare('UPDATE issues SET run_thread_id=? WHERE id=?').run('active-run',issueId);
  throws(() => convert({expected_revision:2,action:'update',issue_versions:{'stable-task':2}}), 'issue_execution_locked');
  // First native start is authorized by a claimed command and checkpoints only
  // the resulting native thread. A foreign relay cannot bind a conversation.
  db.prepare("INSERT INTO projects VALUES('p3','项目三','D:\\projects\\three')").run();
  const queued = api.enqueueCommand({request_id:'start-p3',project_id:'p3',session_kind:'charter',kind:'start',expected_revision:0,
    payload:{native_defaults:true,message:'总纲需求'}});
  assert.equal(queued.kind,'start'); assert.equal(queued.session_kind,'charter'); assert.equal(queued.scope,'project');
  assert.equal(api.enqueueCommand({request_id:'start-p3',project_id:'p3',session_kind:'charter',kind:'start',expected_revision:0,
    payload:{native_defaults:true,message:'总纲需求'}}).replayed,true);
  throws(() => api.enqueueCommand({request_id:'start-p3',project_id:'p3',session_kind:'charter',kind:'start',expected_revision:0,payload:{different:true}}), 'request_id_conflict');
  const claimed = api.claimCommand('relay-a'); assert.equal(claimed.id,'start-p3'); assert.equal(api.claimCommand('relay-b'),null);
  throws(() => api.checkpointCommand({id:'start-p3',relay_id:'relay-b',thread_id:'new-thread'}), 'command_relay_mismatch');
  const checkpoint = api.checkpointCommand({id:'start-p3',relay_id:'relay-a',thread_id:'new-thread'});
  assert.equal(api.getSession('p3','charter').thread_id,'new-thread');
  throws(() => api.checkpointCommand({id:'start-p3',relay_id:'relay-a',thread_id:'other-thread'}), 'session_thread_mismatch');
  api.checkpointCommand({id:'start-p3',relay_id:'relay-a',thread_id:'new-thread',turn_id:'turn-1'});
  assert.equal(api.recoverCommands('relay-a')[0].status,'outcome_unknown'); assert.equal(api.listPendingCommands().length,0);
  api.enqueueCommand({request_id:'turn-p3',project_id:'p3',session_kind:'charter',kind:'turn',thread_id:'new-thread',expected_revision:1,payload:{message:'继续'}});
  api.claimCommand('relay-c'); assert.equal(api.recoverCommands('relay-c')[0].status,'pending');
  const retry = api.claimCommand('relay-c');
  const completed = api.finishCommand({request_id:retry.id,project_id:'p3',session_kind:'charter',thread_id:'new-thread',relay_id:'relay-c',expected_revision:retry.revision,result:{ok:true}});
  assert.equal(completed.status,'completed'); assert.equal(api.getCommand(retry.id).result.ok,true);
  throws(() => api.finishCommand({request_id:retry.id,project_id:'p3',session_kind:'charter',thread_id:'new-thread',relay_id:'relay-c',expected_revision:completed.revision}), 'command_already_finished');
  db.prepare("INSERT INTO projects VALUES('p4','项目四','D:\\projects\\four')").run();
  api.enqueueCommand({request_id:'failed-start',project_id:'p4',session_kind:'planning',kind:'start',expected_revision:0,payload:{}});
  const failedStart = api.claimCommand('relay-d');
  assert.equal(api.finishCommand({id:failedStart.id,relay_id:'relay-d',expected_revision:failedStart.revision,status:'failed',error:'native start failed'}).status,'failed');
  assert.equal(api.getSession('p4','planning'),null);
  console.log('PASS: project planning revisions, confirmation evidence, graph validation, conversion idempotency, history preservation and native command ownership/recovery');
} finally { db.close(); }

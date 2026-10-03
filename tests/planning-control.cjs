const assert=require('node:assert/strict'),cp=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');const controls=require('../src/modules/planning-control.cjs');
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE project_planning_sessions(project_id TEXT PRIMARY KEY,status TEXT,last_error TEXT,updated_at TEXT,thread_id TEXT);
CREATE TABLE project_planning_messages(id TEXT PRIMARY KEY,project_id TEXT,role TEXT,created_at TEXT);
INSERT INTO project_planning_sessions VALUES('test','ready',NULL,'','saved-thread');`);
let count=0,children=0,maxChildren=0;const received=[];
const store={db,getAgentProfile:()=>({}),getProject:id=>id==='test'?{id,planning:{agent_id:'agent',status:db.prepare('SELECT status FROM project_planning_sessions').get().status}}:null,
startProjectPlanningTurn(id,agent,message){received.push(message);const messageId='message-'+(++count);db.prepare("INSERT INTO project_planning_messages VALUES (?,?,'user',?)").run(messageId,id,new Date(Date.now()+count).toISOString());db.prepare("UPDATE project_planning_sessions SET status='running',last_error=NULL WHERE project_id=?").run(id);return{project:this.getProject(id),messageId,threadId:'saved-thread'};},
failProjectPlanningTurn(){throw Error('Pause must not mark the turn failed');}};
const worker={store,stopped:false,projectPlannings:new Map(),onChange(){},async runProjectPlanningTurn(project,_source,thread){
  assert.equal(thread,'saved-thread');controls.guard(this,project.id);
  const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{windowsHide:true,stdio:'ignore'});
  this.projectPlannings.set(project.id,child);children++;maxChildren=Math.max(maxChildren,children);
  await new Promise(resolve=>child.once('close',resolve));children--;controls.guard(this,project.id);
}};
(async()=>{
try{
  await controls.send(worker,'test','agent','original');
  await controls.send(worker,'test','agent','correct the direction');
  assert.equal(maxChildren,1);assert.deepEqual(received,['original','correct the direction']);
  await controls.control(worker,'test','pause');
  assert.equal(children,0);assert.equal(db.prepare('SELECT last_error FROM project_planning_sessions').get().last_error,'planning_paused');
  const before=count;await controls.control(worker,'test','resume');assert.equal(count,before);
  await controls.control(worker,'test','pause');
  assert.equal(children,0);assert.equal(worker.projectPlannings.size,0);
  await assert.rejects(controls.send(worker,'missing','agent','test'),/project_not_found/);
  await assert.rejects(controls.send(worker,'test','agent',' '),/message_required/);
  console.log('PASS: running correction, serialized process replacement, pause, resume same thread without duplicate messages, validation');
}finally{for(const child of worker.projectPlannings.values())child?.kill();db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

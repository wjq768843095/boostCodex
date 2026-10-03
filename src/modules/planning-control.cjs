const cp=require('node:child_process');
function operations(worker){return worker.__planningOperations ||= new Map();}
function guard(worker,id){if(operations(worker).get(id)?.paused)throw Error('planning_interrupted');}
async function stopChild(child){
  if(!child || !Number.isInteger(child.pid) || child.pid<=0)return;
  if(process.platform==='win32')await new Promise((resolve,reject)=>{
    const stop=cp.spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    stop.once('error',reject);stop.once('close',()=>resolve());
  });else child.kill('SIGTERM');
}
async function pause(worker,id){
  const project=worker.store.getProject(id);if(!project)throw Error('project_not_found');
  const op=operations(worker).get(id);
  if(op){op.paused=true;await stopChild(worker.projectPlannings.get(id));await op.done;}
  else if(worker.projectPlannings.has(id))throw Error('project_planning_busy');
  worker.store.db.prepare("UPDATE project_planning_sessions SET status='ready',last_error='planning_paused',updated_at=? WHERE project_id=?").run(new Date().toISOString(),id);
  worker.onChange();return worker.store.getProject(id);
}
function start(worker,turn){
  const id=turn.project.id;const op={paused:false,done:null};operations(worker).set(id,op);worker.projectPlannings.set(id,null);worker.onChange();
  op.done=Promise.resolve().then(()=>worker.runProjectPlanningTurn(turn.project,turn.messageId,turn.threadId)).catch(error=>{
    if(!op.paused){worker.store.failProjectPlanningTurn(id,error?.message || 'project_planning_failed');worker.onChange();}
  }).finally(()=>{
    if(operations(worker).get(id)===op){operations(worker).delete(id);worker.projectPlannings.delete(id);}
  });
}
async function send(worker,id,agent,message){
  if(worker.stopped)return false;
  if(!String(message||'').trim())throw Error('project_planning_message_required');
  if(agent&&!worker.store.getAgentProfile(agent))throw Error('agent_not_found');
  const project=worker.store.getProject(id);if(!project)throw Error('project_not_found');
  if(project.planning.agent_id && project.planning.agent_id!==agent)throw Error('project_planning_agent_locked');
  // Serialize corrections and controls; a second request cannot overtake the first.
  const locks=worker.__planningControlLocks ||= new Map();
  const previous=locks.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(async()=>{
    if(worker.projectPlannings.has(id))await pause(worker,id);
    start(worker,worker.store.startProjectPlanningTurn(id,agent,message));return true;
  });locks.set(id,current);
  try{return await current;}finally{if(locks.get(id)===current)locks.delete(id);}
}
async function control(worker,id,action){
  if(worker.stopped)throw Error('worker_stopped');
  const locks=worker.__planningControlLocks ||= new Map();const previous=locks.get(id)||Promise.resolve();
  const current=previous.catch(()=>{}).then(async()=>{
    if(action==='pause')return pause(worker,id);
    if(action!=='resume')throw Error('invalid_planning_control');
    const project=worker.store.getProject(id);if(!project)throw Error('project_not_found');
    if(worker.projectPlannings.has(id))return project;
    const message=worker.store.db.prepare("SELECT id FROM project_planning_messages WHERE project_id=? AND role='user' ORDER BY created_at DESC LIMIT 1").get(id);
    if(!message)throw Error('project_planning_message_required');
    const session=worker.store.db.prepare('SELECT thread_id FROM project_planning_sessions WHERE project_id=?').get(id);
    worker.store.db.prepare("UPDATE project_planning_sessions SET status='running',last_error=NULL,updated_at=? WHERE project_id=?").run(new Date().toISOString(),id);
    start(worker,{project:worker.store.getProject(id),messageId:message.id,threadId:session?.thread_id||null});return worker.store.getProject(id);
  });locks.set(id,current);try{return await current;}finally{if(locks.get(id)===current)locks.delete(id);}
}
module.exports={send,control,guard};

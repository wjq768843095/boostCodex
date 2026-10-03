const fs=require('node:fs'),path=require('node:path');
function idle(worker){
 const result=worker.updateDrainStatus();const pending=worker.store.db.prepare("SELECT count(*) AS n FROM session_commands WHERE status IN ('pending','claimed')").get().n;
 let projectPending=0,projectActive=0;
 try{projectPending=worker.store.db.prepare("SELECT count(*) AS n FROM project_native_commands WHERE status IN ('pending','claimed')").get().n;projectActive=worker.store.db.prepare("SELECT count(*) AS n FROM project_native_sessions WHERE status='running'").get().n;}catch{}
 let host={};try{host=JSON.parse(fs.readFileSync(path.join(process.env.BETTER_CODEX_HOME,'run/session-host-status.json'),'utf8'));}catch{}
 const hostBusy=!!host.command_in_flight||(host.active_turns||[]).length>0||(host.pending_requests||0)>0||(host.queued_deliveries||0)>0;
 return {...result,ready:result.ready&&result.active_issue_ids.length===0&&pending===0&&projectPending===0&&projectActive===0&&!hostBusy&&(worker.manualQueue?.size||0)===0,pendingCommands:pending,projectPendingCommands:projectPending,activeProjectSessions:projectActive,sessionHostBusy:hostBusy};
}
async function handle({url,method,request,response,worker,readBody,sendJson,stopHost}){
 const dev=path.join(process.env.BETTER_CODEX_LOCAL_PROJECT,'.dev');
 if(url.pathname==='/api/dev/status'&&method==='GET'){
  let reload={};try{reload=JSON.parse(fs.readFileSync(path.join(dev,'status.json'),'utf8'));}catch{}
  sendJson(response,200,{pid:process.pid,revision:process.env.BC_REVISION,draining:!!worker.__devDraining,...idle(worker),reload});return true;
 }
 if(url.pathname==='/api/dev/reload'&&method==='POST'){fs.writeFileSync(path.join(dev,'reload-request.json'),JSON.stringify({at:Date.now()}));sendJson(response,202,{queued:true});return true;}
 if(url.pathname==='/api/dev/drain'&&method==='POST'){
  const current=idle(worker);if(!current.ready){sendJson(response,409,current);return true;}
  worker.__devDraining=true;worker.beginUpdateDrain();
  // The host uses the same backend bundle: retire it while idle so backend edits apply there too.
  const host=worker.sessionHostStatus().host;worker.stopSessionHostClient();await stopHost();
  for(let i=0;host?.pid&&i<40;i++){try{process.kill(host.pid,0);await new Promise(r=>setTimeout(r,100));}catch{break;}}
  sendJson(response,200,{ready:true,draining:true});return true;
 }
 if(url.pathname==='/api/dev/resume'&&method==='POST'){worker.__devDraining=false;worker.sessionRelay.start();worker.resumeAfterUpdate();sendJson(response,200,{resumed:true});return true;}
 return false;
}
module.exports={handle,idle};

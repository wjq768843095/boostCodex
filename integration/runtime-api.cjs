const fs=require('node:fs'),path=require('node:path');
const metadataRequests=new Map(),metadataCancelled=new Map();
const metadataRequestId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function idle(worker){
 const result=worker.updateDrainStatus();const pending=worker.store.db.prepare("SELECT count(*) AS n FROM session_commands WHERE status IN ('pending','claimed')").get().n;
 let projectPending=0,projectActive=0,nativeBindingPending=0;
 try{projectPending=worker.store.db.prepare("SELECT count(*) AS n FROM project_native_commands WHERE status IN ('pending','claimed')").get().n;projectActive=worker.store.db.prepare("SELECT count(*) AS n FROM project_native_sessions WHERE status='running'").get().n;}catch{}
 try{nativeBindingPending=worker.store.nativeProjectRuntime?.conversations?.blockingStatus?.().pending_bindings ?? worker.store.db.prepare("SELECT count(*) AS n FROM native_conversation_operations WHERE status IN ('prepared','allocated','bound')").get().n;}catch{}
 let host={};try{host=JSON.parse(fs.readFileSync(path.join(process.env.BETTER_CODEX_HOME,'run/session-host-status.json'),'utf8'));}catch{}
 const hostBusy=!!host.command_in_flight||(host.active_turns||[]).length>0||(host.pending_requests||0)>0||(host.queued_deliveries||0)>0;
 return {...result,ready:result.ready&&result.active_issue_ids.length===0&&pending===0&&projectPending===0&&projectActive===0&&nativeBindingPending===0&&!hostBusy&&(worker.manualQueue?.size||0)===0,pendingCommands:pending,projectPendingCommands:projectPending,activeProjectSessions:projectActive,nativeBindingOperations:nativeBindingPending,sessionHostBusy:hostBusy};
}
async function handle({url,method,request,response,worker,readBody,sendJson,stopHost}){
 const dev=path.join(process.env.BETTER_CODEX_LOCAL_PROJECT,'.dev');
 // The core has already required the local runtime token and rejected relay
 // callers for /api/dev/. This route reads only native account metadata.
 if(url.pathname==='/api/dev/account-metadata/cancel'&&method==='POST'){
  const body=await readBody(request,4096);
  if(!metadataRequestId(body?.requestId)){sendJson(response,400,{error:'ACCOUNT_METADATA_INPUT_INVALID'});return true;}
  for(const [id,expires] of metadataCancelled)if(expires<Date.now())metadataCancelled.delete(id);
  if(metadataCancelled.size>=64)metadataCancelled.delete(metadataCancelled.keys().next().value);
  metadataCancelled.set(body.requestId,Date.now()+30000);metadataRequests.get(body.requestId)?.abort();
  sendJson(response,200,{cancelled:true});return true;
 }
 if(url.pathname==='/api/dev/account-metadata'&&method==='POST'){
  const body=await readBody(request,4096);
  if(!body||Object.keys(body).some(key=>!['requestId','accountId','userId'].includes(key))||!metadataRequestId(body.requestId)){
   sendJson(response,400,{error:'ACCOUNT_METADATA_INPUT_INVALID'});return true;
  }
  if(response.destroyed||request.aborted)return true;
  if((metadataCancelled.get(body.requestId)||0)>Date.now()){metadataCancelled.delete(body.requestId);sendJson(response,409,{error:'ACCOUNT_METADATA_ABORTED'});return true;}
  if(metadataRequests.has(body.requestId)||metadataRequests.size>=4){sendJson(response,429,{error:'ACCOUNT_METADATA_BUSY'});return true;}
  const controller=new AbortController();metadataRequests.set(body.requestId,controller);
  const disconnected=()=>{if(!response.writableEnded)controller.abort();};response.once('close',disconnected);
  try{
   const {fetchAccountMetadata}=require('../src/modules/account-metadata-transport.cjs');
   const data=await fetchAccountMetadata({accountId:body.accountId,userId:body.userId,signal:controller.signal});
   if(!response.destroyed)sendJson(response,200,data);
  }catch(error){
   const code=/^ACCOUNT_METADATA_[A-Z_]+$/.test(error?.code||'')?error.code:'ACCOUNT_METADATA_FAILED';
   if(!response.destroyed)sendJson(response,code==='ACCOUNT_METADATA_ABORTED'?409:502,{error:code});
  }finally{response.removeListener('close',disconnected);metadataRequests.delete(body.requestId);metadataCancelled.delete(body.requestId);}
  return true;
 }
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

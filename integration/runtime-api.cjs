const fs=require('node:fs'),path=require('node:path');
const metadataRequests=new Map(),metadataCancelled=new Map();
const optimizerRequests=new Set();
const metadataRequestId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function idle(worker){
 const result=worker.updateDrainStatus();
 let host={};try{host=JSON.parse(fs.readFileSync(path.join(process.env.BETTER_CODEX_HOME,'run/session-host-status.json'),'utf8'));}catch{}
 const hostBusy=!!host.command_in_flight||(host.active_turns||[]).length>0||(host.pending_requests||0)>0||(host.queued_deliveries||0)>0;
 return {...result,ready:result.ready&&!hostBusy&&!optimizerRequests.size,sessionHostBusy:hostBusy,promptOptimizerBusy:optimizerRequests.size>0};
}
async function handle({url,method,request,response,worker,readBody,sendJson,stopHost}){
 const dev=path.join(process.env.BETTER_CODEX_LOCAL_PROJECT,'.dev');
 // /api/dev/ is authenticated by the core before entering this extension.
 if(url.pathname==='/api/dev/workflow/panel-url'&&method==='POST'){
  try{const result=await require('./workflow-service.cjs').panelUrl();sendJson(response,200,result);}
  catch(error){console.error('workflow_panel_open_failed',error.code||error.message);sendJson(response,503,{error:'WORKFLOW_PANEL_UNAVAILABLE',message:'面板暂时无法打开，请稍后重试。'});}
  return true;
 }
 if(url.pathname==='/api/dev/prompt-optimizer/settings'||url.pathname==='/api/dev/prompt-optimizer/optimize'){
  const optimizer=require('../src/modules/prompt-optimizer.cjs');
  const controller=new AbortController();
  const disconnected=()=>{if(!response.writableEnded)controller.abort();};
  response.once('close',disconnected);request.once('aborted',disconnected);
  try{
   if(response.destroyed||request.aborted)return true;
   let data;
   if(url.pathname.endsWith('/settings')&&method==='GET')data=optimizer.getSettings();
   else if(method==='POST'){
    const body=await readBody(request,optimizer.LIMITS.bodyBytes);
    if(response.destroyed||request.aborted||controller.signal.aborted)return true;
    if(url.pathname.endsWith('/settings'))data=optimizer.saveSettings(body);
    else{
     if(worker?.__devDraining)throw Object.assign(new Error(),{code:'PROMPT_OPTIMIZER_BUSY'});
     optimizerRequests.add(controller);data=await optimizer.optimize(body,{signal:controller.signal});
    }
   }else throw Object.assign(new Error(),{code:'PROMPT_OPTIMIZER_METHOD_NOT_ALLOWED'});
   if(!response.destroyed&&!controller.signal.aborted)sendJson(response,200,data);
  }catch(error){
   const result=optimizer.errorResponse(error);
   if(!response.destroyed&&!controller.signal.aborted)sendJson(response,result.status,result.body);
  }finally{optimizerRequests.delete(controller);response.removeListener('close',disconnected);request.removeListener('aborted',disconnected);}
  return true;
 }
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

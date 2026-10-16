const fs=require('node:fs'),path=require('node:path');const lib=require('./lib.cjs');
let running=false,stopping=false,rejected=null,pending=false,force=false,recoveryFailures=0;const handles=[];
function preserveExpression(){return `(() => ({...(window.__boostCodexInjection__ || window.__betterCodexInjection__)?.captureReloadState?.()}))()`;}
async function cdp(expression){const targets=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(3000)})).json();const target=targets.find(t=>t.url==='app://-/index.html');if(!target)throw Error('Codex window unavailable');const ws=new WebSocket(target.webSocketDebuggerUrl);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('CDP timeout'));},20000);ws.onerror=()=>{clearTimeout(timer);reject(Error('CDP unavailable'));};ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id!==1)return;clearTimeout(timer);ws.close();if(r.result?.exceptionDetails)reject(Error('UI evaluation failed: '+String(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'unknown error').split('\n')[0].slice(0,400)));else resolve(r.result?.result?.value);};});}
async function refresh(savedView){
 let saved=savedView;try{saved ||= await cdp(preserveExpression());}catch{lib.log('injection_deferred',{reason:'Codex window unavailable'});return {deferred:true};}
 await lib.inject();
 const result=await cdp(`(async()=>{const saved=${JSON.stringify(saved)};if(window.__boostCodexInjection__?.restoreReloadState)await window.__boostCodexInjection__.restoreReloadState(saved);return {ready:window.__boostCodexInjection__?.ready?.(),error:window.__boostCodexInjection__?.bootstrapError?.()};})()`);
 if(result?.error)throw Error(result.error);
 if(!result?.ready)throw Error('injection_not_ready');
 return result;
}
async function reconcile(){
 if(running||stopping)return;running=true;
 try{
  const hash=lib.hashes(),old=lib.state();if(hash.sourceHash===old.sourceHash&&!force)return;if(hash.sourceHash===rejected&&!force)return;force=false;
  try{lib.validate();}catch(e){rejected=hash.sourceHash;pending=false;lib.status({phase:'invalid',error:e.message,acceptedRevision:old.sourceHash});lib.log('validation_failed',{error:e.message});return;}
  const live=await lib.api('/api/dev/status','GET',{},true);if(!live?.ready){pending=true;lib.status({phase:'waiting_for_idle',pendingRevision:hash.sourceHash,blocking:live?.blocking||null});return;}
  if(hash.backendHash===old.backendHash){
   const previous=fs.readFileSync(lib.LIVE);lib.atomic(lib.LIVE,lib.uiBundle());
   try{await refresh();await lib.refreshWorkflowService?.();lib.save(path.join(lib.DEV,'state.json'),{...old,...hash});lib.status({phase:'ready',error:null,revision:hash.sourceHash});lib.log('ui_applied',{revision:hash.sourceHash});pending=false;rejected=null;}
   catch(e){lib.atomic(lib.LIVE,previous);try{await refresh();}catch{}rejected=hash.sourceHash;lib.status({phase:'rolled_back',error:e.message});lib.log('ui_rollback',{error:e.message});}return;
  }
  const build=lib.snapshot(hash);let view;try{view=await cdp(preserveExpression());}catch{}
 lib.runCore(['dev-stop-injector','--json'],{build:old.current});
  try{await lib.api('/api/dev/drain','POST');}catch(e){await refresh(view);if(e.httpStatus===409){pending=true;lib.status({phase:'waiting_for_idle',pendingRevision:hash.sourceHash});return;}throw e;}
  lib.status({phase:'reloading',pendingRevision:hash.sourceHash});
  const priorUi=fs.readFileSync(lib.LIVE);let stopped=false;
  try{
   await lib.shutdown();stopped=true;lib.save(path.join(lib.DEV,'state.json'),{current:build,previous:old.current,...hash});lib.atomic(lib.LIVE,lib.uiBundle(build));
   await lib.waitReady(lib.spawnCore(['runtime'],build));await refresh(view);await lib.refreshWorkflowService?.();lib.atomic(lib.ENTRY,fs.readFileSync(path.join(build,'integration/entry.cjs')));
   lib.status({phase:'ready',error:null,revision:hash.sourceHash});lib.log('backend_applied',{revision:hash.sourceHash});pending=false;rejected=null;
   // Restart the accepted supervisor so changes to its own source also become active.
   setTimeout(()=>finish(true),50);
  }catch(e){
   rejected=hash.sourceHash;
   if(stopped){try{await lib.shutdown();}catch{}lib.save(path.join(lib.DEV,'state.json'),old);lib.atomic(lib.LIVE,priorUi);await lib.waitReady(lib.spawnCore(['runtime'],old.current));try{await refresh(view);}catch{}}
   else await lib.api('/api/dev/resume','POST',{},true);
   rejected=hash.sourceHash;lib.status({phase:'rolled_back',error:e.message,revision:old.sourceHash});lib.log('backend_rollback',{error:e.message});
  }
 }catch(e){lib.status({phase:'error',error:e.message});lib.log('reload_error',{error:e.message});}finally{running=false;try{const now=lib.hashes().sourceHash;if(now!==lib.state().sourceHash&&now!==rejected)pending=true;}catch{}}
}
async function recover(){
 if(running||stopping||lib.read(path.join(lib.DEV,'status.json'))?.phase==='repairing'||!lib.read(path.join(lib.DEV,'activated.json')))return;
 // Health requests can time out while the desktop or disk is busy. Serialize
 // probes with source reloads and never rebuild the UI for a transient failure.
 running=true;
 try{
  const h=await lib.health();if(h?.ok){recoveryFailures=0;return;}
  if(++recoveryFailures<3)return;
  const before=lib.read(path.join(lib.HOME,'run/runtime.json'));
  if(lib.alive(before?.pid)){lib.log('runtime_recovery_deferred',{reason:'runtime_still_running'});recoveryFailures=0;return;}
  const ready=await lib.ensureLocalRuntime();
  recoveryFailures=0;
  if(ready.pid!==before?.pid){await refresh();lib.log('runtime_recovered',{pid:ready.pid});}
 }catch(e){lib.log('runtime_recovery_failed',{error:e.message});}
 finally{running=false;}
}
function finish(restart=false){if(stopping)return;stopping=true;for(const handle of handles)clearInterval(handle);const lock=path.join(lib.DEV,'watcher.json');if(lib.read(lock)?.pid===process.pid)fs.unlinkSync(lock);if(restart)lib.ensureWatcher();process.exit(0);}
async function start(){
 const lock=path.join(lib.DEV,'watcher.json');const existing=lib.read(lock);if(existing?.pid!==process.pid&&lib.alive(existing?.pid))return;
 try{const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,root:lib.ROOT,startedAt:new Date().toISOString()}));fs.closeSync(fd);}catch(e){if(e.code==='EEXIST'){const owner=lib.read(lock);if(lib.alive(owner?.pid))return;fs.unlinkSync(lock);return start();}throw e;}
 const stopFile=path.join(lib.DEV,'watcher-stop.json');if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
 lib.log('watcher_started',{pid:process.pid});
 let seen=lib.hashes().sourceHash,changedAt=seen!==lib.state().sourceHash?Date.now()-600:0;
 handles.push(setInterval(()=>{if(fs.existsSync(stopFile))return finish();try{const next=lib.hashes().sourceHash;if(next!==seen){seen=next;changedAt=Date.now();}const request=path.join(lib.DEV,'reload-request.json');if(fs.existsSync(request)){fs.unlinkSync(request);force=true;changedAt=Date.now()-600;}if(changedAt&&Date.now()-changedAt>=600){changedAt=0;void reconcile();}else if(pending&&!running)void reconcile();}catch(e){lib.status({phase:'invalid',error:e.message});}},750));
 process.on('SIGTERM',()=>finish());process.on('SIGINT',()=>finish());
 // Recover an unavailable service only after this project has been activated.
 handles.push(setInterval(()=>void recover(),10000));
}
module.exports={start,reconcile,recover,refresh,cdp,preserveExpression};

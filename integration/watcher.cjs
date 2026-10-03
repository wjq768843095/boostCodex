const fs=require('node:fs'),path=require('node:path');const lib=require('./lib.cjs');
let running=false,stopping=false,rejected=null,pending=false,force=false;const handles=[];
function preserveExpression(){return `(() => {const panel=document.querySelector('#better-codex-panel');return {surface:panel?.dataset.surface,open:!!panel&&!panel.hidden,project:document.querySelector('.bc-project-row.is-active')?.dataset.projectId||localStorage.getItem('better-codex-managed-project'),tab:document.querySelector('.better-codex-project-dashboard-tabs-desktop [data-project-dashboard-view][aria-current="page"]')?.dataset.projectDashboardView,...window.__betterCodexInjection__?.captureReloadState?.(),fields:[...document.querySelectorAll('#better-codex-panel textarea,#better-codex-panel input')].map(e=>({key:e.getAttribute('name')||e.id||e.getAttribute('placeholder'),value:e.value,focus:e===document.activeElement,start:e.selectionStart,end:e.selectionEnd})),scroll:[...document.querySelectorAll('#better-codex-panel [class]')].filter(e=>e.scrollTop>0).map(e=>({cls:e.className,top:e.scrollTop}))};})()`;}
function restoredViewMatches(saved,current){
 if(!current||current.surface!==saved.surface||!current.open)return false;
 if(saved.nativeConversation){
  const expected=saved.nativeConversation.target,actual=current.nativeConversation?.target;
  return !!expected&&!!actual&&['project_id','kind','issue_id','conversation_id','history_id'].every(key=>expected[key]===undefined||expected[key]===actual[key]);
 }
 return (!saved.project||saved.project===current.project)&&(!saved.tab||saved.tab===current.tab);
}
async function cdp(expression){const targets=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(3000)})).json();const target=targets.find(t=>t.url==='app://-/index.html');if(!target)throw Error('Codex window unavailable');const ws=new WebSocket(target.webSocketDebuggerUrl);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('CDP timeout'));},20000);ws.onerror=()=>{clearTimeout(timer);reject(Error('CDP unavailable'));};ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id!==1)return;clearTimeout(timer);ws.close();if(r.result?.exceptionDetails)reject(Error('UI evaluation failed: '+String(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'unknown error').split('\n')[0].slice(0,400)));else resolve(r.result?.result?.value);};});}
async function refresh(savedView){
 let saved=savedView;try{saved ||= await cdp(preserveExpression());}catch{lib.log('injection_deferred',{reason:'Codex window unavailable'});return {deferred:true};}
 await lib.inject();
 if(saved?.open){const result=await cdp(`(async()=>{
  const saved=${JSON.stringify(saved)},sleep=ms=>new Promise(r=>setTimeout(r,ms));
  if(window.__betterCodexInjection__?.restoreReloadState)await window.__betterCodexInjection__.restoreReloadState(saved);else window.__betterCodexInjection__?.open(saved.surface,{projectId:saved.project});
  const viewMatches=${restoredViewMatches.toString()};
  for(let i=0;i<50;i++){if(window.__betterCodexInjection__?.ready?.()&&viewMatches(saved,window.__betterCodexInjection__?.captureReloadState?.()))break;await sleep(100);}
  if(saved.surface==='projects'&&saved.tab&&!saved.nativeConversation){document.querySelector('.better-codex-project-dashboard-tabs-desktop [data-project-dashboard-view="'+saved.tab+'"]')?.click();for(let i=0;i<20;i++){if(document.querySelector('.better-codex-project-dashboard-tabs-desktop [aria-current="page"]')?.dataset.projectDashboardView===saved.tab)break;await sleep(100);}}
  await sleep(100);
  for(const f of saved.fields){const e=[...document.querySelectorAll('#better-codex-panel textarea,#better-codex-panel input')].find(e=>(e.getAttribute('name')||e.id||e.getAttribute('placeholder'))===f.key);if(!e)continue;e.value=f.value;e.dispatchEvent(new Event('input',{bubbles:true}));if(f.focus){e.focus();if(typeof e.setSelectionRange==='function')e.setSelectionRange(f.start,f.end);}}
  for(const s of saved.scroll){const e=[...document.querySelectorAll('#better-codex-panel [class]')].find(e=>e.className===s.cls);if(e)e.scrollTop=s.top;}
  return {error:window.__betterCodexInjection__?.bootstrapError?.()};
 })()`);if(result?.error)throw Error(result.error);}
 else{const result=await cdp(`({ready:window.__betterCodexInjection__?.ready?.(),error:window.__betterCodexInjection__?.bootstrapError?.()})`);if(result?.error)throw Error(result.error);}
}
async function reconcile(){
 if(running||stopping)return;running=true;
 try{
  const hash=lib.hashes(),old=lib.state();if(hash.sourceHash===old.sourceHash&&!force)return;if(hash.sourceHash===rejected&&!force)return;force=false;
  try{lib.validate();}catch(e){rejected=hash.sourceHash;pending=false;lib.status({phase:'invalid',error:e.message,acceptedRevision:old.sourceHash});lib.log('validation_failed',{error:e.message});return;}
  const live=await lib.api('/api/dev/status','GET',{},true);if(!live?.ready){pending=true;lib.status({phase:'waiting_for_idle',pendingRevision:hash.sourceHash,blocking:live?.blocking||null});return;}
  if(hash.backendHash===old.backendHash){
   const previous=fs.readFileSync(lib.LIVE);lib.atomic(lib.LIVE,lib.uiBundle());
   try{await refresh();lib.save(path.join(lib.DEV,'state.json'),{...old,...hash});lib.status({phase:'ready',error:null,revision:hash.sourceHash});lib.log('ui_applied',{revision:hash.sourceHash});pending=false;rejected=null;}
   catch(e){lib.atomic(lib.LIVE,previous);try{await refresh();}catch{}rejected=hash.sourceHash;lib.status({phase:'rolled_back',error:e.message});lib.log('ui_rollback',{error:e.message});}return;
  }
  const build=lib.snapshot(hash);let view;try{view=await cdp(preserveExpression());}catch{}
 lib.runCore(['dev-stop-injector','--json'],{build:old.current});
  try{await lib.api('/api/dev/drain','POST');}catch(e){await refresh(view);if(e.httpStatus===409){pending=true;lib.status({phase:'waiting_for_idle',pendingRevision:hash.sourceHash});return;}throw e;}
  lib.status({phase:'reloading',pendingRevision:hash.sourceHash});
  const priorUi=fs.readFileSync(lib.LIVE);let stopped=false;
  try{
   await lib.shutdown();stopped=true;lib.save(path.join(lib.DEV,'state.json'),{current:build,previous:old.current,...hash});lib.atomic(lib.LIVE,lib.uiBundle(build));
   await lib.waitReady(lib.spawnCore(['runtime'],build));await refresh(view);lib.atomic(lib.ENTRY,fs.readFileSync(path.join(build,'integration/entry.cjs')));
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
 handles.push(setInterval(async()=>{if(running||stopping||lib.read(path.join(lib.DEV,'status.json'))?.phase==='repairing'||!lib.read(path.join(lib.DEV,'activated.json')))return;const h=await lib.health();if(!h?.ok){try{await lib.ensureLocalRuntime();await refresh();lib.log('runtime_recovered');}catch(e){lib.log('runtime_recovery_failed',{error:e.message});}}},10000));
}
module.exports={start,reconcile,refresh,cdp,preserveExpression,restoredViewMatches};

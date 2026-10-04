const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),lib=require('../integration/lib.cjs');
(async()=>{
 lib.validate();
 const os=require('node:os'),bundleFolder=fs.mkdtempSync(path.join(os.tmpdir(),'bc-ui-bundle-'));
 try{const ui=path.join(bundleFolder,'src/ui');fs.mkdirSync(ui,{recursive:true});fs.writeFileSync(path.join(ui,'better-codex-ui.js'),'var BetterCodexInjected = {};');assert.equal(lib.uiBundle(bundleFolder),'var BetterCodexInjected = {};');fs.writeFileSync(path.join(ui,'native-conversation-adapter.js'),'var BetterCodexNativeConversation = {};');assert(lib.uiBundle(bundleFolder).startsWith('var BetterCodexNativeConversation = {};\n;\nvar BetterCodexInjected'));new vm.Script(lib.uiBundle(bundleFolder));}finally{fs.rmSync(bundleFolder,{recursive:true,force:true});}
 // Idle checks include CLI jobs, native turns and queued session commands.
 const apiSource=fs.readFileSync(path.join(root,'integration/runtime-api.cjs'),'utf8');let host={active_turns:[]};
 const context={module:{exports:{}},require:name=>name==='node:fs'?{readFileSync:()=>JSON.stringify(host)}:require(name),process:{env:{BETTER_CODEX_HOME:'C:\\数据 空格'}},JSON};vm.runInNewContext(apiSource,context);
 let pending=0;const worker={updateDrainStatus:()=>({ready:true,blocking:{},active_issue_ids:[]}),store:{db:{prepare:()=>({get:()=>({n:pending})})}},manualQueue:new Map()};
 assert(context.module.exports.idle(worker).ready);host.active_turns=['busy'];assert(!context.module.exports.idle(worker).ready);host.active_turns=[];pending=1;assert(!context.module.exports.idle(worker).ready);pending=0;worker.manualQueue.set('queued',true);assert(!context.module.exports.idle(worker).ready);
 worker.manualQueue.clear();let projectPending=1,projectActive=0,nativeBindingPending=0;worker.store.db.prepare=sql=>({get:()=>({n:sql.includes('project_native_commands')?projectPending:sql.includes('project_native_sessions')?projectActive:sql.includes('native_conversation_operations')?nativeBindingPending:0})});assert(!context.module.exports.idle(worker).ready);projectPending=0;projectActive=1;assert(!context.module.exports.idle(worker).ready);projectActive=0;assert(context.module.exports.idle(worker).ready);nativeBindingPending=1;assert(!context.module.exports.idle(worker).ready);nativeBindingPending=0;assert(context.module.exports.idle(worker).ready);
 // Busy backends must not be shut down or replaced.
 const watcherSource=fs.readFileSync(path.join(root,'integration/watcher.cjs'),'utf8');let staged=0,stopped=0,phase='';
 const fake={hashes:()=>({sourceHash:'new',backendHash:'new'}),state:()=>({sourceHash:'old',backendHash:'old'}),validate:()=>{},api:async()=>({ready:false,blocking:{project_plannings:1}}),snapshot:()=>{staged++;},shutdown:()=>{stopped++;},status:s=>phase=s.phase,log:()=>{}};
 const wc={module:{exports:{}},require:name=>name==='./lib.cjs'?fake:require(name),setTimeout,clearInterval,process,console};vm.runInNewContext(watcherSource,wc);await wc.module.exports.reconcile();assert.equal(phase,'waiting_for_idle');assert.equal(staged,0);assert.equal(stopped,0);
 // Readiness follows the saved conversation identity instead of hidden old tabs.
 const restored=wc.module.exports.restoredViewMatches,saved={surface:'projects',open:true,nativeConversation:{target:{project_id:'p',kind:'charter',conversation_id:'c1'}}};
 assert(restored(saved,{surface:'projects',open:true,nativeConversation:{target:{project_id:'p',kind:'charter',conversation_id:'c1'}}}));
 assert(!restored(saved,{surface:'projects',open:true,nativeConversation:{target:{project_id:'p',kind:'charter',conversation_id:'c2'}}}));
 assert(!restored(saved,{surface:'projects',open:true,nativeConversation:{target:{project_id:'other',kind:'charter',conversation_id:'c1'}}}));
 assert(!restored(saved,{surface:'projects',open:true,nativeConversation:null}));
 const historySaved={surface:'board',open:true,nativeConversation:{target:{project_id:'p',kind:'work',issue_id:'i',history_id:'h1'}}};
 assert(restored(historySaved,{surface:'board',open:true,nativeConversation:{target:{project_id:'p',kind:'work',issue_id:'i',history_id:'h1'}}}));
 assert(!restored(historySaved,{surface:'board',open:true,nativeConversation:{target:{project_id:'p',kind:'work',issue_id:'i'}}}));
 assert(!restored(historySaved,{surface:'board',open:true,nativeConversation:{target:{project_id:'p',kind:'work',issue_id:'i',history_id:'h2'}}}));
 assert(!restored({surface:'board',open:true,nativeConversation:{target:{project_id:'p',kind:'work',issue_id:'i'}}},{surface:'board',open:true,nativeConversation:{target:{project_id:'p',kind:'work',issue_id:'i',history_id:'h1'}}}));
 assert(restored({surface:'agents',open:true},{surface:'agents',open:true}));
 // Recovery must not reinject for transient probes, degraded live processes,
 // overlapping timers, or a service that recovered before ensure completed.
 let probe=null,alive=true,ensured=0,injected=0,releaseProbe;
 const recoveryFake={DEV:root,HOME:root,read:file=>file.endsWith('runtime.json')?{pid:11}:{},alive:()=>alive,health:async()=>probe,ensureLocalRuntime:async()=>{ensured++;return {pid:22};},inject:async()=>{injected++;},log:()=>{}};
 const recoveryContext={module:{exports:{}},require:name=>name==='./lib.cjs'?recoveryFake:require(name),setTimeout,clearInterval,process,console,fetch:async()=>{throw Error('no desktop');}};
 vm.runInNewContext(watcherSource,recoveryContext);const recover=recoveryContext.module.exports.recover;
 await recover();probe={ok:true};await recover();probe=null;await recover();await recover();assert.equal(ensured,0);
 await recover();assert.equal(ensured,0);assert.equal(injected,0); // live but unhealthy
 alive=false;await recover();await recover();await recover();assert.equal(ensured,1);
 recoveryFake.ensureLocalRuntime=async()=>{ensured++;return {pid:11};};await recover();await recover();await recover();assert.equal(ensured,2);assert.equal(injected,0);
 recoveryFake.health=()=>new Promise(resolve=>{releaseProbe=resolve;});const pendingProbe=recover();await recover();assert.equal(typeof releaseProbe,'function');releaseProbe({ok:true});await pendingProbe;assert.equal(ensured,2);
 // A failed health probe cannot spawn a second runtime beside a live process.
 const ensureSource=lib.ensureLocalRuntime.toString();let spawned=0;
 const ensure=vm.runInNewContext('('+ensureSource+')',{health:async()=>null,alive:()=>true,read:()=>({pid:11}),path,HOME:root,spawnCore:()=>{spawned++;},waitReady:async()=>({ok:true})});
 await assert.rejects(ensure(),/runtime_still_running_health_unavailable/);assert.equal(spawned,0);
 // Discovery accepts Unicode and spaces and recovers when the old CLI disappears.
 const core=fs.readFileSync(path.join(root,'src/backend/better-codex.cjs'),'utf8');const begin=core.indexOf('function createCodexExecutablePathResolver('),end=core.indexOf('function codexExecutablePath()',begin);
 const factory=vm.runInNewContext('('+core.slice(begin,end).trim()+')',{import_node_path13:path,process});let target='C:\\程序 空格\\旧版\\codex.exe';const available=new Set([target]);const resolve=factory(()=>target,p=>available.has(p),'win32');assert.equal(resolve(),target);available.clear();target='C:\\程序 空格\\新版\\codex.exe';available.add(target);assert.equal(resolve(),target);
 assert(core.includes('if (!validAccessToken(bearerToken(request2)))'));assert(!core.includes("join)(betterCodexHome,'customizations'"));
 console.log('PASS: source syntax, native/queued-work idle checks, deferred reload without interruption, Unicode paths and CLI rediscovery');
})().catch(e=>{console.error(e);process.exitCode=1;});

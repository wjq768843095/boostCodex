const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.env.BETTER_CODEX_LOCAL_PROJECT || path.resolve(__dirname,'..');
process.env.BETTER_CODEX_LOCAL_PROJECT=root;
const stateFile=path.join(root,'.dev/state.json');
if(!fs.existsSync(stateFile)){console.error('Run npm run prepare-local first.');process.exit(1);}
const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
const lib=require(path.join(state.current,'integration/lib.cjs'));
const args=process.argv.slice(2),command=args[0]||'launch';
(async()=>{
 if(command==='watch')return require(path.join(state.current,'integration/watcher.cjs')).start();
 if(command==='dev-status'){console.log(JSON.stringify({state:lib.state(),watcher:lib.read(path.join(lib.DEV,'watcher.json')),reload:lib.read(path.join(lib.DEV,'status.json')),runtime:await lib.health()},null,2));return;}
 if(command==='repair'){
  lib.ensureWatcher();await lib.ensureLocalRuntime();const idle=await lib.api('/api/dev/status');if(!idle.ready)throw Error('Wait for active work before repairing');
  const watcher=require(path.join(state.current,'integration/watcher.cjs'));let view;try{view=await watcher.cdp(watcher.preserveExpression());}catch{}
  lib.status({phase:'repairing'});try{lib.runCore(['dev-stop-injector','--json']);await lib.api('/api/dev/drain','POST');await lib.shutdown();await lib.waitReady(lib.spawnCore(['runtime']));await watcher.refresh(view);lib.status({phase:'ready',error:null});console.log(JSON.stringify({repaired:true,runtime:await lib.api('/readyz')}));}catch(e){lib.status({phase:'error',error:e.message});throw e;}return;
 }
 if(command==='dev-start'){lib.ensureWatcher();await lib.ensureLocalRuntime();await lib.inject();console.log(JSON.stringify({started:true,watcher:lib.read(path.join(lib.DEV,'watcher.json')),runtime:await lib.api('/readyz')}));return;}
 if(command==='dev-stop'){const idle=await lib.api('/api/dev/status','GET',{},true);if(idle&&!idle.ready)throw Error('Wait for active work before stopping');lib.save(path.join(lib.DEV,'watcher-stop.json'),{at:Date.now()});await new Promise(r=>setTimeout(r,1000));if(idle)await lib.api('/api/dev/drain','POST');lib.runCore(['stop','--json']);console.log(JSON.stringify({stopped:true}));return;}
 if(['launch','start','runtime','mcp'].includes(command))lib.ensureWatcher();
 if(command==='launch'||command==='start')await lib.ensureLocalRuntime();
 const child=cp.spawn(process.execPath,[lib.coreFile(),...args.length?args:['launch']],{cwd:root,env:lib.environment(),stdio:'inherit',windowsHide:true});
 child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('close',code=>{process.exitCode=code||0;});
})().catch(e=>{console.error(e.message);process.exitCode=1;});

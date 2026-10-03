const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../integration/rollback.cjs'),'utf8');
async function exercise(current){
 const actions=[];const fakeProcess={env:{BETTER_CODEX_LOCAL_PROJECT:'local',BC_REVISION:'local'},execPath:process.execPath,exitCode:0};
 const lib={DEV:'dev',HOME:'data',read:()=>({installed:'original'}),api:async endpoint=>{actions.push(endpoint);return endpoint==='/api/dev/status'?current:{};},save:()=>actions.push('stop-watcher'),runCore:args=>actions.push(args[0]),health:async()=>current,shutdown:async()=>actions.push('shutdown')};
 const deps={'./lib.cjs':lib,'node:fs':{existsSync:file=>file==='original',renameSync:()=>actions.push('rename')},'node:path':path,'node:child_process':{execFileSync:(exe,args,opts)=>{assert(!opts.env.BETTER_CODEX_LOCAL_PROJECT);assert(!opts.env.BC_REVISION);actions.push('install:'+args[1]);}}};
 await vm.runInNewContext(source,{require:name=>deps[name],process:fakeProcess,setTimeout:fn=>fn(),console:{log:()=>{},error:()=>{}}});
 return {actions,exitCode:fakeProcess.exitCode};
}
(async()=>{
 const busy=await exercise({ready:false});assert.equal(busy.exitCode,1);assert.deepEqual(busy.actions,['/api/dev/status']);
 const live=await exercise({ready:true});assert.equal(live.exitCode,0);assert(live.actions.indexOf('dev-stop-injector')<live.actions.indexOf('shutdown'));assert(live.actions.indexOf('/api/dev/drain')<live.actions.indexOf('shutdown'));assert(live.actions.indexOf('shutdown')<live.actions.indexOf('install:mcp'));
 const offline=await exercise(null);assert.equal(offline.exitCode,0);assert(!offline.actions.includes('shutdown'));assert(offline.actions.includes('install:mcp'));
 console.log('PASS: restore entry waits for active work, stops injection before service, and works with an unavailable runtime');
})().catch(e=>{console.error(e);process.exitCode=1;});

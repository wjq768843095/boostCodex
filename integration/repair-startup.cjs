'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const lib=require('./lib.cjs'),startup=require('./startup.cjs');
const reportFile=path.join(lib.HOME,'run/local-startup-repair.json');
const digest=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function progress(patch){lib.save(reportFile,{...lib.read(reportFile,{}),...patch,updatedAt:new Date().toISOString()});}
function redirectInstalledEntries(backup){
 const roots=[path.join(process.env.LOCALAPPDATA,'BetterCodex'),path.join(process.env.LOCALAPPDATA,'Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/BetterCodex')];
 const shim=`// Better Codex local entry redirect. Original installer entry is backed up.\nprocess.env.BETTER_CODEX_LOCAL_PROJECT=${JSON.stringify(lib.ROOT)};\nprocess.env.BETTER_CODEX_HOME=${JSON.stringify(lib.HOME)};\nrequire(${JSON.stringify(lib.ENTRY)});\n`;
 const changed=[];
 for(let index=0;index<roots.length;index++)for(const name of ['bin/better-codex.cjs','desktop-launch.cjs']){
  const file=path.join(roots[index],name);if(!fs.existsSync(file))continue;
  if(fs.readFileSync(file,'utf8')===shim)continue;
  const copy=path.join(backup,'installed-'+index,name);fs.mkdirSync(path.dirname(copy),{recursive:true});fs.copyFileSync(file,copy);lib.atomic(file,shim);changed.push(file);
 }
 return changed;
}
async function runtimeRepair(){
 lib.validate();
 const backup=path.join(lib.HOME,'backups','local-startup-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
 progress({phase:'preparing',backup,error:null});
 for(const name of ['state.json','status.json','launcher.cjs']){const file=path.join(lib.DEV,name);if(fs.existsSync(file))fs.copyFileSync(file,path.join(backup,name));}
 for(const name of ['Better Codex Launcher.vbs','run/launch-integration.json']){const file=path.join(lib.HOME,name);if(fs.existsSync(file)){const copy=path.join(backup,name);fs.mkdirSync(path.dirname(copy),{recursive:true});fs.copyFileSync(file,copy);}}
 // Stop only this checkout's supervisor before replacing its accepted build.
 const watcher=lib.read(path.join(lib.DEV,'watcher.json'));
 if(watcher?.root===lib.ROOT&&lib.alive(watcher.pid)){
  lib.save(path.join(lib.DEV,'watcher-stop.json'),{at:Date.now()});
  for(let attempt=0;attempt<120&&lib.alive(watcher.pid);attempt++)await sleep(250);
  if(lib.alive(watcher.pid))throw Error('watcher_stop_timeout');
 }
 await startup.withStartupLock(lib,async()=>{
  const h=await lib.health();
  const managed=h?.ok?await lib.api('/api/dev/status','GET',{},true):null;
  if(h?.ok&&!managed){progress({phase:'retiring_legacy',legacyPid:h.pid});await startup.replaceLegacyRuntime(lib,h);}
  // SQLite has closed. Preserve the historical database before local startup;
  // the customized Runtime never opens this database.
  const historical=path.join(lib.HOME,'better-codex.db');
  if(fs.existsSync(historical))fs.copyFileSync(historical,path.join(backup,'better-codex.db'));
  for(const suffix of ['-wal','-shm'])if(fs.existsSync(historical+suffix))fs.copyFileSync(historical+suffix,path.join(backup,'better-codex.db'+suffix));
  const historicalHash=digest(historical);
  if(!managed)lib.bootstrap();
  progress({phase:'starting_local',historicalHash});
  await lib.ensureLocalRuntime();
  lib.runCore(['launcher','install','--json']);lib.runCore(['service','install','--json']);
  const redirected=redirectInstalledEntries(backup);
  lib.ensureWatcher();
  const ready=await lib.api('/readyz'),local=await lib.api('/api/dev/status');
  if(!ready.ok||ready.pid!==local.pid||ready.database.opened!==false||digest(historical)!==historicalHash)throw Error('local_runtime_verification_failed');
  lib.status({phase:'ready',revision:lib.state().sourceHash,error:null});
  progress({phase:'runtime_ready',runtimePid:ready.pid,version:ready.version,historicalUnchanged:true,redirected});
 });
}
async function desktopRepair(){
 progress({phase:'restarting_desktop'});
 lib.runCore(['launch','--restart','--json'],{timeout:120000});
 const watcher=require('./watcher.cjs');
 const ui=await watcher.cdp(`({ready:!!window.__betterCodexInjection__?.ready?.(),error:window.__betterCodexInjection__?.bootstrapError?.(),endpoint:window.__betterCodexInjection__?.endpoint,optimizer:!!document.querySelector('[data-bc-optimizer]'),version:window.__betterCodexInjection__?.version})`);
 const ready=await lib.api('/readyz');
 if(!ui?.ready||ui.error||ui.endpoint!=='http://127.0.0.1:'+ready.port||!ready.session_host.connected)throw Error('desktop_verification_failed');
 progress({phase:'complete',runtimePid:ready.pid,version:ready.version,ui,sessionConnected:true});
}
(async()=>{if(!process.argv.includes('--desktop-only'))await runtimeRepair();if(!process.argv.includes('--runtime-only'))await desktopRepair();console.log(JSON.stringify(lib.read(reportFile)));})().catch(error=>{progress({phase:'failed',error:error.message});lib.log('startup_repair_failed',{error:error.message});console.error(error.message);process.exitCode=1;});

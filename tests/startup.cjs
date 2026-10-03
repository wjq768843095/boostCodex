const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');const lib=require('../integration/lib.cjs');
const uiFile=path.join(lib.ROOT,'src/ui/better-codex-ui.js'),originalUi=fs.readFileSync(uiFile,'utf8');
async function accepted(){for(let i=0;i<100;i++){if(lib.state().sourceHash===lib.hashes().sourceHash&&lib.read(path.join(lib.DEV,'status.json'))?.phase==='ready')return;await new Promise(r=>setTimeout(r,300));}throw Error('Source application not ready');}
(async()=>{
 await accepted();const original=await lib.api('/readyz');const host=original.session_host.host.pid;
 cp.execFileSync(process.execPath,[lib.ENTRY,'repair'],{windowsHide:true,timeout:60000,stdio:'pipe'});
 const repaired=await lib.api('/readyz');assert.notEqual(repaired.pid,original.pid);assert.notEqual(repaired.session_host.host.pid,host);assert(repaired.session_host.connected);console.log('PASS: repair restarts accepted backend and native session host, then reconnects current Codex');
 // Rewrite the launcher using the accepted Unicode-safe Windows implementation.
 lib.runCore(['launcher','install','--json']);
 cp.execFileSync(process.execPath,[lib.ENTRY,'dev-stop'],{windowsHide:true,timeout:60000,stdio:'pipe'});
 assert.equal(await lib.health(),null);await new Promise(r=>setTimeout(r,1200));const stopped=lib.read(path.join(lib.DEV,'watcher.json'));assert(!stopped||!lib.alive(stopped.pid));
 fs.writeFileSync(uiFile,originalUi+'\nwindow.__bcColdSaveProbe=true;\n');
 const launcher=path.join(lib.HOME,'Better Codex Launcher.vbs');const bytes=fs.readFileSync(launcher);assert.equal(bytes[0],255);assert.equal(bytes[1],254);assert(bytes.toString('utf16le').includes(lib.ENTRY));
 const child=cp.spawn(path.join(process.env.SystemRoot,'System32/wscript.exe'),[launcher],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();
 await lib.waitReady();let watcher;for(let i=0;i<30;i++){watcher=lib.read(path.join(lib.DEV,'watcher.json'));if(watcher&&lib.alive(watcher.pid))break;await new Promise(r=>setTimeout(r,200));}assert(watcher&&lib.alive(watcher.pid));
 const live=await lib.api('/api/dev/status');assert.equal(live.revision,lib.state().backendHash);assert((await lib.api('/readyz')).session_host.connected);
 await accepted();assert.equal(await require('../integration/watcher.cjs').cdp('window.__bcColdSaveProbe'),true);
 lib.save(path.join(lib.DEV,'startup-acceptance.json'),{at:new Date().toISOString(),desktopLauncher:true,watcherRecovered:true,serviceRestart:true,repair:true,nativeHostRestart:true,offlineSaveApplied:true});
 console.log('PASS: stopping service/watcher then reopening from desktop launcher restores the independent project and watcher');
})().catch(e=>{console.error(String(e.stderr||e.message));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(uiFile,originalUi);try{await accepted();}catch(e){console.error(e.message);process.exitCode=1;}});

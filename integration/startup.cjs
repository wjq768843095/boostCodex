'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net'),crypto=require('node:crypto');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function powershell(script){return cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();}
function ownedProcess(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return null;
 const result=powershell(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p -and $p.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId -and (Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){$p|Select-Object ProcessId,CommandLine,CreationDate|ConvertTo-Json -Compress}`);
 return result?JSON.parse(result):null;
}
function legacyProcess(process,role){
 return !!process&&new RegExp(String.raw`[\\/]BetterCodex[\\/]bin[\\/]better-codex\.cjs"?\s+${role}(?:\s|$)`,'i').test(process.CommandLine||'');
}
function idleLegacy(health,host){
 return !health.handoffUpdateId&&host?.runtime_instance_id===health.instanceId&&host.running===true&&host.command_in_flight===false&&host.pending_requests===0&&host.queued_deliveries===0&&Array.isArray(host.active_turns)&&host.active_turns.length===0&&Array.isArray(host.thread_workers)&&host.thread_workers.length===0;
}
async function replaceLegacyRuntime(lib,health){
 const before=lib.read(path.join(lib.HOME,'run/runtime.json'));
 if(!before||before.pid!==health.pid||before.instanceId!==health.instanceId||!legacyProcess(ownedProcess(before.pid),'runtime'))throw Error('runtime_owner_unrecognized');
 const host=lib.read(path.join(lib.HOME,'run/session-host-status.json'));
 if(!idleLegacy(health,host))throw Error('legacy_runtime_busy_retry_when_idle');
 const injectorFile=path.join(lib.HOME,'run/injector.pid');
 const children=[{pid:fs.existsSync(injectorFile)?Number(fs.readFileSync(injectorFile,'utf8')):null,role:'watch-inject'},{pid:host.host_pid,role:'session-host'}].map(item=>({...item,process:ownedProcess(item.pid)}));
 if(children.some(item=>item.process&&!legacyProcess(item.process,item.role)))throw Error('legacy_child_owner_unrecognized');
 // Recheck immediately before the authenticated shutdown. Never change databases
 // or global disable flags; desktop_exit stops accepting work and closes SQLite.
 const current=await lib.health();
 if(current?.instanceId!==before.instanceId||!idleLegacy(current,lib.read(path.join(lib.HOME,'run/session-host-status.json'))))throw Error('legacy_runtime_busy_retry_when_idle');
 lib.log('legacy_runtime_retiring',{pid:before.pid});
 await lib.api('/api/shutdown','POST',{reason:'desktop_exit',runtime_instance_id:before.instanceId});
 for(let attempt=0;attempt<100&&lib.alive(before.pid);attempt++)await sleep(100);
 if(lib.alive(before.pid))throw Error('legacy_runtime_shutdown_timeout');
 for(const item of children){
  if(!item.process)continue;
  const now=ownedProcess(item.pid);
  if(now&&now.CommandLine===item.process.CommandLine&&now.CreationDate===item.process.CreationDate){
   // The retired injector and idle host are detached from the stopped Runtime.
   // Stop only these verified processes; never kill Codex CLI or other projects.
   powershell(`$ErrorActionPreference='Stop'; Stop-Process -Id ${item.pid} -ErrorAction SilentlyContinue`);
  }
 }
 lib.log('legacy_runtime_retired',{pid:before.pid});
}
async function withStartupLock(lib,action){
 // The OS releases this loopback-only mutex even after a crash. No stale-file
 // deletion race can remove a lock acquired by another launcher.
 const port=45000+crypto.createHash('sha256').update(path.resolve(lib.HOME).toLowerCase()).digest().readUInt16BE(0)%12000;
 for(let attempt=0;attempt<120;attempt++){
  const server=net.createServer(socket=>socket.destroy());
  const acquired=await new Promise((resolve,reject)=>{server.once('error',error=>error.code==='EADDRINUSE'?resolve(false):reject(error));server.listen({host:'127.0.0.1',port,exclusive:true},()=>resolve(true));});
  if(acquired){try{return await action();}finally{await new Promise(resolve=>server.close(resolve));}}
  await sleep(250);
 }
 throw Error('local_startup_busy');
}
module.exports={ownedProcess,legacyProcess,idleLegacy,replaceLegacyRuntime,withStartupLock};

const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),cp=require('node:child_process');
require('../src/modules/brand.cjs').normalizeEnvironment();
const ROOT=process.env.BOOST_CODEX_LOCAL_PROJECT || path.resolve(__dirname,'..');
const HOME=process.env.BOOST_CODEX_HOME || path.join(process.env.USERPROFILE,'.better-codex');
const DEV=path.join(ROOT,'.dev'),LIVE=path.join(DEV,'live/boost-codex-ui.js'),ENTRY=path.join(DEV,'launcher.cjs');
function read(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,data);fs.renameSync(temp,file);}
function save(file,data){atomic(file,JSON.stringify(data,null,2));}
function log(event,data={}){fs.mkdirSync(DEV,{recursive:true});fs.appendFileSync(path.join(DEV,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');}
function status(patch){const file=path.join(DEV,'status.json');const value={...read(file,{}),...patch,updatedAt:new Date().toISOString()};save(file,value);return value;}
function alive(pid){if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch{return false;}}
function list(dir){if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?list(path.join(dir,e.name)):[path.join(dir,e.name)]);}
function sources(){return [...list(path.join(ROOT,'src')),...list(path.join(ROOT,'integration'))].filter(f=>/\.(cjs|js|css|json|html|md|yaml|yml)$/.test(f)).sort();}
function uiBundle(base=ROOT){
 const adapter=path.join(base,'src/ui/native-conversation-adapter.js');
 const optimizer=path.join(base,'src/ui/prompt-optimizer.js');
 const shortcut=path.join(base,'src/modules/prompt-optimizer-shortcut.js');
 const workflow=path.join(base,'src/ui/workflow-panel.js');
 const subagents=path.join(base,'src/ui/subagent-monitor.js');
 return (fs.existsSync(adapter)?fs.readFileSync(adapter,'utf8')+'\n;\n':'')+(fs.existsSync(shortcut)?fs.readFileSync(shortcut,'utf8')+'\n;\n':'')+(fs.existsSync(optimizer)?fs.readFileSync(optimizer,'utf8')+'\n;\n':'')+(fs.existsSync(workflow)?fs.readFileSync(workflow,'utf8')+'\n;\n':'')+(fs.existsSync(subagents)?fs.readFileSync(subagents,'utf8')+'\n;\n':'')+fs.readFileSync(path.join(base,'src/ui/boost-codex-ui.js'),'utf8');
}
function hashes(files=sources()){
 const full=crypto.createHash('sha256'),backend=crypto.createHash('sha256');for(const file of files){const rel=path.relative(ROOT,file),data=fs.readFileSync(file);full.update(rel).update(data);if(!rel.startsWith('src'+path.sep+'ui'+path.sep))backend.update(rel).update(data);}
 return {sourceHash:full.digest('hex'),backendHash:backend.digest('hex'),uiHash:crypto.createHash('sha256').update(uiBundle()).digest('hex')};
}
function validate(files=sources()){
 for(const file of files){const content=fs.readFileSync(file,'utf8');if(/\.(js|cjs)$/.test(file))new vm.Script(content,{filename:file});else if(file.endsWith('.json'))JSON.parse(content);}
 const ui=fs.readFileSync(path.join(ROOT,'src/ui/boost-codex-ui.js'),'utf8');if(!ui.includes('boostCodexInjected'))throw Error('UI export missing');
}
function snapshot(hash=hashes()){
 const dest=path.join(DEV,'builds',hash.sourceHash);for(const folder of ['src','integration'])for(const file of list(path.join(ROOT,folder))){const target=path.join(dest,path.relative(ROOT,file));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);}
 save(path.join(dest,'manifest.json'),{...hash,createdAt:new Date().toISOString()});return dest;
}
function state(){return read(path.join(DEV,'state.json'));}
function bootstrap(){validate();const hash=hashes();const current=snapshot(hash);atomic(LIVE,uiBundle());atomic(ENTRY,fs.readFileSync(path.join(ROOT,'integration/entry.cjs')));save(path.join(DEV,'state.json'),{current,...hash,previous:null});status({phase:'prepared',revision:hash.sourceHash});return state();}
function environment(build=state()?.current){if(!build)throw Error('No accepted build');return {...process.env,BOOST_CODEX_LOCAL_PROJECT:ROOT,BOOST_CODEX_HOME:HOME,BOOST_CODEX_PROFILE:'stable',BOOST_CODEX_BASE_ENTRYPOINT:ENTRY,BC_UI_FILE:LIVE,BC_RUNTIME_API:path.join(build,'integration/runtime-api.cjs'),BC_COMPATIBILITY_FILE:path.join(build,'integration/codex-compatibility.json'),BC_REVISION:read(path.join(build,'manifest.json')).backendHash};}
function coreFile(build=state()?.current){return path.join(build,'src/backend/boost-codex.cjs');}
function runCore(args,options={}){return cp.execFileSync(process.execPath,[coreFile(options.build),...args],{env:environment(options.build),windowsHide:true,encoding:'utf8',timeout:options.timeout||60000,stdio:options.stdio||['ignore','pipe','pipe']});}
async function api(url,method='GET',body={},optional=false){
 const runtime=read(path.join(HOME,'run/runtime.json'));if(!runtime){if(optional)return null;throw Error('runtime_unavailable');}
 const token=fs.readFileSync(path.join(HOME,'run/token'),'utf8').trim();
 try{const response=await fetch('http://127.0.0.1:'+runtime.port+url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(url==='/api/dev/drain'?12000:5000)});const result=await response.json();if(!response.ok)throw Object.assign(Error(url+' HTTP '+response.status),{httpStatus:response.status,data:result});return result;}catch(e){if(optional)return null;throw e;}
}
async function health(){return api('/health','GET',{},true);}
async function refreshWorkflowService(){const service=require('./workflow-service.cjs');if(await service.health(HOME))return service.ensureStarted({home:HOME,root:ROOT});return null;}
function spawnCore(args,build=state()?.current){fs.mkdirSync(path.join(DEV,'logs'),{recursive:true});const fd=fs.openSync(path.join(DEV,'logs/runtime.log'),'a');const child=cp.spawn(process.execPath,[coreFile(build),...args],{cwd:ROOT,env:environment(build),windowsHide:true,detached:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);child.unref();return child.pid;}
async function waitReady(expectedPid){for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,250));const current=read(path.join(HOME,'run/runtime.json'));if(expectedPid&&current?.pid!==expectedPid){if(alive(expectedPid))continue;const local=await api('/api/dev/status','GET',{},true);if(local?.revision!==state()?.backendHash)continue;}const ready=await api('/readyz','GET',{},true);if(ready?.ok)return ready;}throw Error('runtime_start_failed');}
async function shutdown(){const runtime=read(path.join(HOME,'run/runtime.json'));if(!runtime)return;await api('/api/shutdown','POST');for(let i=0;i<80&&alive(runtime.pid);i++)await new Promise(r=>setTimeout(r,100));if(alive(runtime.pid))throw Error('runtime_did_not_stop');}
async function ensureLocalRuntime(options={}){const h=await health();if(h?.ok){const local=await api('/api/dev/status','GET',{},true);if(local)return h;if(!options.takeover)throw Error('runtime_not_managed_by_this_project');await require('./startup.cjs').replaceLegacyRuntime(module.exports,h);}else if(alive(read(path.join(HOME,'run/runtime.json'))?.pid)){throw Error('runtime_still_running_health_unavailable');}return waitReady(spawnCore(['runtime']));}
function ensureWatcher(){const lock=read(path.join(DEV,'watcher.json'));if(lock?.root===ROOT&&alive(lock.pid))return lock.pid;const fd=fs.openSync(path.join(DEV,'watcher.log'),'a');const child=cp.spawn(process.execPath,[ENTRY,'watch'],{cwd:ROOT,env:environment(),windowsHide:true,detached:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);child.unref();return child.pid;}
async function inject(){try{return JSON.parse(runCore(['refresh-injection','--json']));}catch(e){throw Error('injection_refresh_failed: '+String(e.stderr||e.message).slice(-300));}}
module.exports={ROOT,HOME,DEV,LIVE,ENTRY,read,atomic,save,log,status,alive,list,sources,uiBundle,hashes,validate,snapshot,state,bootstrap,environment,coreFile,runCore,api,health,refreshWorkflowService,spawnCore,waitReady,shutdown,ensureLocalRuntime,ensureWatcher,inject};

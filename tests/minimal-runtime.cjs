'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),home=fs.mkdtempSync(path.join(os.tmpdir(),'bc-minimal-runtime-'));
const sentinel=Buffer.from('historical database must remain untouched');
fs.writeFileSync(path.join(home,'better-codex.db'),sentinel);
let child;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 child=cp.spawn(process.execPath,[path.join(root,'src/backend/better-codex.cjs'),'serve'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_TEST_CONTEXT:'fixture',BETTER_CODEX_HOME:home,BETTER_CODEX_PEER_HOME:path.join(home,'peer'),BETTER_CODEX_PROFILE:'stable',BETTER_CODEX_RUNTIME_PORT:'0',BETTER_CODEX_LOCAL_PROJECT:root,BC_RUNTIME_API:path.join(root,'integration/runtime-api.cjs'),BC_COMPATIBILITY_FILE:path.join(root,'integration/codex-compatibility.json'),BC_REVISION:'isolated-test'}});
 let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);child.stdout.resume();
 const stateFile=path.join(home,'run/runtime.json');
 for(let attempt=0;attempt<80&&!fs.existsSync(stateFile);attempt++){if(child.exitCode!==null)throw Error(diagnostic||'runtime exited');await sleep(50);}
 assert(fs.existsSync(stateFile),'isolated runtime publishes its identity');
 const state=JSON.parse(fs.readFileSync(stateFile)),base='http://127.0.0.1:'+state.port,token=fs.readFileSync(path.join(home,'run/token'),'utf8').trim();
 const request=(route,options={})=>fetch(base+route,{...options,headers:{Authorization:'Bearer '+token,...options.headers},signal:AbortSignal.timeout(3000)});
 const ready=await(await request('/readyz')).json();assert(ready.ok);assert.equal(ready.database.opened,false);assert.equal(ready.session_host.connected,false);
 assert.equal((await fetch(base+'/api/account/usage')).status,401);
 assert.equal((await request('/api/account/usage',{headers:{Origin:'https://untrusted.example'}})).status,403);
 assert.equal((await request('/api/account/usage',{headers:{'x-better-codex-relay':'fixture'}})).status,403);
 for(const route of ['/api/projects','/api/issues','/api/agents','/api/skills','/api/project/context','/api/board'])assert.equal((await request(route)).status,404,route+' is removed');
 assert.deepEqual(await(await request('/api/account/usage')).json(),{usage:null});
 assert.equal((await request('/api/dev/account-metadata',{method:'POST',body:'{}'})).status,400);
 assert.equal((await request('/api/dev/drain',{method:'POST',body:'{}'})).status,200);
 assert.equal((await request('/readyz')).status,503);
 assert.equal((await request('/api/dev/resume',{method:'POST',body:'{}'})).status,200);
 assert.equal((await request('/readyz')).status,200);
 assert(fs.readFileSync(path.join(home,'better-codex.db')).equals(sentinel));
 assert.equal((await request('/api/shutdown',{method:'POST',body:'{}'})).status,200);
 for(let attempt=0;attempt<40&&child.exitCode===null;attempt++)await sleep(50);
 assert.equal(child.exitCode,0);
 console.log('PASS: isolated runtime auth/origin/relay guards, removed APIs, drain/resume, no database access and no model requests');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 if(child?.exitCode===null){child.kill();for(let attempt=0;attempt<40&&child.exitCode===null;attempt++)await sleep(50);}
 fs.rmSync(home,{recursive:true,force:true});
});

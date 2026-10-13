'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {NativeAccountSession}=require('../src/modules/native-account-session.cjs');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'bc-account-session-'));
let connectionCount=0,child;
const messages=[];
function spawn(executable,args){
 assert.equal(executable,'fixture-codex');assert.deepEqual(args,['app-server']);connectionCount++;
 child=new EventEmitter();child.pid=123;child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>queueMicrotask(()=>child.emit('close',0));
 let buffer='';child.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){const message=JSON.parse(line);messages.push(message);if(message.method==='initialize')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result:{serverInfo:{version:'fixture'}}})+'\n'));if(message.method==='account/rateLimits/read')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:message.id,result:{rateLimits:{planType:'pro'}}})+'\n'));}});
 return child;
}
const session=new NativeAccountSession({home,executable:()=> 'fixture-codex',version:'fixture',spawn});
(async()=>{
 const result=await session.readUsage();assert.equal(result.rateLimits.planType,'pro');assert(session.status().connected);
 assert.deepEqual(messages.map(message=>message.method),['initialize','initialized','account/rateLimits/read']);
 await assert.rejects(session.send('turn/start',{input:'forbidden'}),/native_account_method_unavailable/);
 await assert.rejects(session.send('thread/start'),/native_account_method_unavailable/);
 assert.equal(messages.length,3);
 await session.readUsage();assert.equal(connectionCount,1,'reuse initialized connection');
 await session.stop();assert.equal(session.status().connected,false);assert.equal(session.pending.size,0);
 await session.readUsage();assert.equal(connectionCount,2,'recover after explicit disconnect');
 assert(messages.every(message=>['initialize','initialized','account/rateLimits/read'].includes(message.method)));
 console.log('PASS: read-only native account connection initialization, reuse, recovery and business-method rejection');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await session.stop();fs.rmSync(home,{recursive:true,force:true});});

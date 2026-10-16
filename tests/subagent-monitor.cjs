'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {createMonitor,validId}=require('../src/modules/subagent-monitor.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'better-codex-subagents-'));
const ids=Array.from({length:12},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
let fixtureCount=0;
const event=(time,type,payload={})=>({timestamp:new Date(time).toISOString(),type:'event_msg',payload:{type,...payload}});
const context=(time,model,effort)=>({timestamp:new Date(time).toISOString(),type:'turn_context',payload:{model,effort}});
const json=event=>JSON.stringify(event)+'\n';
function fixture(limits={}){
 const home=path.join(temporary,String(++fixtureCount));let clock=100000;
 const monitor=createMonitor({codexHome:home,now:()=>clock,limits});
 function file(id,parentId,events=[],options={}){
  const directory=path.join(home,options.archived?'archived_sessions':'sessions','2026','10','16');fs.mkdirSync(directory,{recursive:true});
  const target=path.join(directory,`rollout-${id}.jsonl`);
  const source=parentId&&!options.fork?{subagent:{thread_spawn:{parent_thread_id:parentId,agent_path:options.agentPath||'/root/research',agent_nickname:options.nickname||'Euler',agent_role:'worker'}}}:undefined;
  const meta={type:'session_meta',timestamp:new Date(1000).toISOString(),payload:{id,parent_thread_id:parentId,source,timestamp:new Date(1000).toISOString(),base_instructions:{text:'PRIVATE-SHOULD-NOT-APPEAR'}}};
  fs.writeFileSync(target,json(meta)+events.map(json).join(''));return target;
 }
 return {home,monitor,file,advance:()=>{clock+=5000;},get:(id=ids[0])=>monitor.getSubagents(id)};
}

(async()=>{
 try{
  assert.equal(validId('../secret'),false);assert.equal(validId(ids[0]),true);
  const a=fixture();a.file(ids[0],null);
  const child=a.file(ids[1],ids[0],[event(1000,'task_started',{turn_id:'a'}),context(1001,'gpt-6.1-sol','high'),event(1100,'task_complete',{turn_id:'a',duration_ms:99})]);
  a.file(ids[2],ids[1],[event(1050,'task_started',{turn_id:'b'}),context(1051,'gpt-6-astra','xhigh')],{archived:true,agentPath:'/root/research/verify'});
  a.file(ids[3],ids[0],[],{fork:true});a.file(ids[4],ids[5],[],{agentPath:'/root/unrelated'});
  let result=await a.get();assert.equal(result.syncing,false);assert.equal(result.agents.length,2);
  assert.deepEqual(result.agents.map(x=>[x.id,x.parentId,x.depth]),[[ids[1],ids[0],1],[ids[2],ids[1],2]]);
  let row=result.agents[0];assert.equal(row.name,'research');assert.equal(row.nickname,'Euler');
  assert.equal(row.model,'gpt-6.1-sol');assert.equal(row.effort,'high');assert.equal(row.status,'completed');
  assert.equal(row.elapsedMs,99);assert.equal(row.runningSince,null);assert.equal(row.completedAt,1100);
  assert.equal(result.agents[1].runningSince,1050);assert.equal(result.agents[1].elapsedMs,0);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes('agent_role'),false);
  // Reusing a completed agent adds active intervals and excludes the long idle gap.
  fs.appendFileSync(child,json(event(90000,'task_started',{turn_id:'c'}))+json(context(90000,'gpt-6.1-sol','ultra')));
  result=await a.get();row=result.agents[0];assert.equal(result.agents.length,2);assert.equal(row.status,'running');assert.equal(row.elapsedMs,99);assert.equal(row.runningSince,90000);assert.equal(row.completedAt,null);assert.equal(row.effort,'ultra');
  fs.appendFileSync(child,json(event(90500,'turn_aborted',{turn_id:'c'})));
  result=await a.get();assert.equal(result.agents[0].elapsedMs,599);assert.equal(result.agents[0].status,'interrupted');
  fs.appendFileSync(child,json(event(90500,'task_complete',{turn_id:'c',duration_ms:500})));
  assert.equal((await a.get()).agents[0].elapsedMs,599);
  fs.appendFileSync(child,json(event(95000,'task_started',{turn_id:'d'}))+json(event(95010,'error',{turn_id:'d'})));
  result=await a.get();assert.equal(result.agents[0].status,'failed');assert.equal(result.agents[0].elapsedMs,609);
  // A partial UTF-8 code point and an unfinished JSON line are retried safely.
  const b=fixture(),partial=b.file(ids[1],ids[0],[event(1000,'task_started',{turn_id:'e'})]);
  const bytes=Buffer.from(json(context(1001,'模型测试','high'))),split=bytes.indexOf(Buffer.from('模型'))+1;
  fs.appendFileSync(partial,bytes.subarray(0,split));result=await b.get();assert.equal(result.syncing,true);assert.equal(result.agents[0].model,null);
  fs.appendFileSync(partial,bytes.subarray(split));result=await b.get();assert.equal(result.syncing,false);assert.equal(result.agents[0].model,'模型测试');
  // Oversized content and malformed unrelated events do not poison lifecycle parsing.
  const c=fixture({line:1024,bytes:4096});c.file(ids[1],ids[0],[event(1000,'task_started',{turn_id:'f'})]);
  const longFile=path.join(c.home,'sessions','2026','10','16',`rollout-${ids[1]}.jsonl`);
  fs.appendFileSync(longFile,'x'.repeat(12000)+'\n{bad json}\n'+json(event(1300,'task_complete',{turn_id:'f',duration_ms:300})));
  for(let i=0;i<8;i++){result=await c.get();if(!result.syncing)break;}
  assert.equal(result.syncing,false);assert.equal(result.agents[0].status,'completed');assert.equal(result.agents[0].elapsedMs,300);
  // Work is budgeted and incomplete discovery is explicitly observable.
  const d=fixture({headers:1});d.file(ids[1],ids[0]);d.file(ids[2],ids[1],[],{agentPath:'/root/research/deep'});
  result=await d.get();assert.equal(result.syncing,true);result=await d.get();assert.equal(result.syncing,false);assert.equal(result.agents.length,2);
  // Initial empty logs are discovered once their first line has been written.
  const e=fixture();const initial=e.file(ids[1],ids[0]);const saved=fs.readFileSync(initial);fs.writeFileSync(initial,'');assert.equal((await e.get()).agents.length,0);
  fs.writeFileSync(initial,saved);e.advance();assert.equal((await e.get()).agents.length,1);
  // Archiving is a move, not a new agent; appended archival events remain visible.
  const archived=path.join(a.home,'archived_sessions','moved.jsonl');fs.renameSync(child,archived);a.advance();
  fs.appendFileSync(archived,json(event(99000,'task_started',{turn_id:'g'}))+json(event(99100,'task_complete',{turn_id:'g',duration_ms:100})));
  result=await a.get();assert.equal(result.agents.length,2);assert.equal(result.agents[0].elapsedMs,709);
  // Successful native parent controls are evidence; failed calls are not.
  const f=fixture();const parent=f.file(ids[0],null),controlled=f.file(ids[1],ids[0],[event(1000,'task_started',{turn_id:'h'})]);
  f.file(ids[5],null);f.file(ids[6],ids[5],[event(1000,'task_started',{turn_id:'unrelated'})]);
  const call=(name,target,call_id)=>({timestamp:new Date(1100).toISOString(),type:'response_item',payload:{type:'function_call',name,namespace:'collaboration',arguments:JSON.stringify({target}),call_id}});
  const output=(call_id,data)=>({timestamp:new Date(1200).toISOString(),type:'response_item',payload:{type:'function_call_output',call_id,output:JSON.stringify(data)}});
  fs.appendFileSync(parent,json(call('close_agent','research','one'))+json(output('one',{error:'not found'})));assert.equal((await f.get()).agents[0].status,'running');
  fs.appendFileSync(parent,json(call('interrupt_agent','research','two'))+json(output('two',{previous_status:'running'})));
  result=await f.get();assert.equal(result.agents[0].status,'interrupted');assert.equal(result.agents[0].elapsedMs,200);assert.equal(result.agents[0].runningSince,null);
  result=await f.get(ids[5]);assert.equal(result.agents[0].status,'running');assert.equal(result.agents[0].elapsedMs,0);
  fs.appendFileSync(controlled,json(event(4000,'task_started',{turn_id:'resumed'}))+json(event(4300,'task_complete',{turn_id:'resumed',duration_ms:300})));
  result=await f.get();assert.equal(result.agents[0].status,'completed');assert.equal(result.agents[0].elapsedMs,500);
  fs.unlinkSync(controlled);assert.equal((await f.get()).syncing,true);
  f.file(ids[1],ids[0],[event(1000,'task_started',{turn_id:'replacement'})]);
  await assert.rejects(f.get('invalid'),{code:'SUBAGENT_THREAD_INVALID'});
  // HTTP contract uses the authenticated dev extension, validates UUIDs, and
  // never sends local read failures or session data back to the caller.
  const mod={exports:{}};const sandbox={module:mod,exports:mod.exports,process:{env:{BETTER_CODEX_LOCAL_PROJECT:temporary}},require(name){if(name==='../src/modules/subagent-monitor.cjs')return {validId,getSubagents:id=>f.get(id)};return require(name);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../integration/runtime-api.cjs'),'utf8'),sandbox);
  async function route(query,method='GET'){let received;const handled=await mod.exports.handle({url:new URL('http://local/api/dev/subagents'+query),method,response:{destroyed:false},sendJson(_response,status,data){received={status,data};}});assert.equal(handled,true);return received;}
  assert.equal((await route('?threadId=../../data')).status,400);assert.equal((await route(`?threadId=${ids[0]}`,'POST')).status,405);
  const http=await route(`?threadId=${ids[0]}`);assert.equal(http.status,200);assert.equal(http.data.threadId,ids[0]);assert.equal(http.data.agents.length,1);
  console.log('subagent-monitor: isolated lifecycle, hierarchy, incremental I/O, archive and HTTP checks passed');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

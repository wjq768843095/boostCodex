'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createReader}=require('../src/modules/subagent-work.cjs');
const {createMonitor}=require('../src/modules/subagent-monitor.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'boost-subagent-work-'));
const ids=Array.from({length:8},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
const line=e=>JSON.stringify(e)+'\n',event=(time,type,payload)=>({timestamp:new Date(time).toISOString(),type,payload});
const msg=(time,text,phase='commentary',extras={})=>event(time,'response_item',{type:'message',role:'assistant',phase,content:[{type:'output_text',text}],...extras});
const call=(time,name,args,id)=>event(time,'response_item',{type:'function_call',namespace:'collaboration',name,arguments:JSON.stringify(args),call_id:id});
const output=(time,id,data)=>event(time,'response_item',{type:'function_call_output',call_id:id,output:JSON.stringify(data)});
let counter=0;
function fixture(limits={}){
 const home=path.join(temporary,String(++counter));const monitor=createMonitor({codexHome:home}),reader=createReader({codexHome:home,descriptionHome:home,monitor,limits});
 function file(id,parent,events=[],extra={}){
  const dir=path.join(home,extra.archived?'archived_sessions':'sessions','2026','10','16');fs.mkdirSync(dir,{recursive:true});
  const filename=path.join(dir,`rollout-${id}.jsonl`),agentPath=extra.agentPath||'/root/selected';
  const source=parent?{subagent:{thread_spawn:{parent_thread_id:parent,agent_path:agentPath}}}:undefined;
  fs.writeFileSync(filename,line(event(1000,'session_meta',{id,source,agent_path:parent?agentPath:undefined,timestamp:new Date(1000).toISOString(),base_instructions:{text:'SECRET-SYSTEM'}}))+events.map(line).join(''));return filename;
 }
 const boundary=event(1002,'response_item',{type:'agent_message',author:'/root',recipient:'/root/selected',content:[{type:'encrypted_content',encrypted_content:'SECRET-ENCRYPTED'}]});
 function standard(childEvents=[],parentEvents=[]){
  const parent=file(ids[0],null,[call(1001,'spawn_agent',{task_name:'selected',message:'Actual assigned task'},'spawn'),output(1002,'spawn',{task_name:'/root/selected'}),...parentEvents]);
  const child=file(ids[1],ids[0],[msg(1001,'SECRET-INHERITED-ASSISTANT'),event(1001,'response_item',{type:'message',role:'user',content:[{type:'input_text',text:'SECRET-INHERITED-USER'}]}),boundary,...childEvents]);
  return {parent,child};
 }
 return {home,monitor,reader,file,standard,get:(root=ids[0],agent=ids[1])=>reader.getWork(root,agent),append:(file,events)=>fs.appendFileSync(file,events.map(line).join(''))};
}
(async()=>{
 let server;
 try{
  const f=fixture(),files=f.standard([
   msg(1100,'Original commentary'),msg(1101,'SECRET-ANALYSIS','analysis'),msg(1101,'SECRET-CHANNEL-ANALYSIS','final_answer',{channel:'analysis'}),
   event(1102,'response_item',{type:'reasoning',summary:[{text:'SECRET-REASONING'}]}),
   event(1103,'response_item',{type:'custom_tool_call',input:'SECRET-ARGUMENTS'}),
   event(1104,'response_item',{type:'function_call_output',output:'SECRET-TOOL-OUTPUT'}),
   msg(1200,'Latest progress'),msg(1300,'Original final answer','final_answer')]);
  f.file(ids[2],ids[3],[msg(1400,'SECRET-OTHER-ROOT')]);
  f.file(ids[4],ids[0],[event(1003,'response_item',{type:'agent_message',recipient:'/root/second'}),msg(1250,'Second selected agent','final_answer')],{agentPath:'/root/second'});
  let result=await f.get();assert.deepEqual(result,{threadId:ids[0],agentId:ids[1],task:'Actual assigned task',title:'子代理任务',taskUnavailable:false,progress:'Latest progress',result:'Original final answer',updatedAt:1300,syncing:false,truncated:false});
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
  assert.equal((await f.get(ids[0],ids[4])).result,'Second selected agent','adjacent hovers reuse bounded filename candidates without a rescan');
  await assert.rejects(f.get(ids[0],ids[2]),{status:403});await assert.rejects(f.get('../escape',ids[1]),{status:400});await assert.rejects(f.get(ids[0],'bad'),{status:400});await assert.rejects(f.get(ids[0],ids[0]),{status:403});
  // A successful, explicitly addressed follow-up replaces the assignment and
  // hides previous-turn progress/result even before the child writes again.
  f.append(files.parent,[call(2000,'followup_task',{target:'selected',message:'Follow-up assignment'},'next'),output(2001,'next',{status:'running'})]);
  result=await f.get();assert.equal(result.task,'Follow-up assignment');assert.equal(result.progress,'');assert.equal(result.result,'');assert.equal(result.updatedAt,2000);
  f.append(files.parent,[call(2100,'followup_task',{target:'selected',message:'SECRET-FAILED-ASSIGNMENT'},'failed'),output(2101,'failed',{error:'failed'})]);
  f.append(files.child,[msg(2200,'Follow-up progress'),msg(2300,'Follow-up final','final_answer')]);
  result=await f.get();assert.equal(result.task,'Follow-up assignment');assert.equal(result.result,'Follow-up final');
  // Buffer partial JSON, including a split UTF-8 codepoint, without leaking or
  // corrupting it. Polling resumes from the existing offset.
  const bytes=Buffer.from(line(msg(2400,'中文进度'))),split=bytes.indexOf(Buffer.from('中文'))+1;
  fs.appendFileSync(files.child,bytes.subarray(0,split));result=await f.get();assert.equal(result.syncing,true);assert.equal(result.progress,'Follow-up progress');
  fs.appendFileSync(files.child,bytes.subarray(split));result=await f.get();assert.equal(result.syncing,false);assert.equal(result.progress,'中文进度');
  // A filename cannot substitute for verified session metadata.
  const wrong=fixture();wrong.file(ids[0],null);const wrongFile=wrong.file(ids[1],ids[0]);const text=fs.readFileSync(wrongFile,'utf8');fs.writeFileSync(wrongFile,text.replace(ids[1],ids[4]));
  const fakeMonitor={getSubagents:async()=>({agents:[{id:ids[1],parentId:ids[0]}],syncing:false})};
  await assert.rejects(createReader({codexHome:wrong.home,monitor:fakeMonitor}).getWork(ids[0],ids[1]),{status:503});
  await assert.rejects(createReader({codexHome:wrong.home,monitor:{getSubagents:async()=>({agents:[],syncing:true})}}).getWork(ids[0],ids[1]),{status:503});
  // Parent identity and archived files are both checked. Nested agents obtain
  // their assignment only from their immediate native parent.
  const nested=fixture();nested.file(ids[0],null);nested.file(ids[1],ids[0],[call(1001,'spawn_agent',{task_name:'selected',message:'Nested task'},'nested'),output(1002,'nested',{agent_id:ids[2]})],{agentPath:'/root'});
  nested.file(ids[2],ids[1],[event(1003,'response_item',{type:'agent_message',recipient:'/root/selected'}),msg(1100,'Archived result','final_answer')],{archived:true});
  result=await nested.get(ids[0],ids[2]);assert.equal(result.task,'Nested task');assert.equal(result.result,'Archived result');
  // Without a verified boundary, plausible assistant messages from forked
  // context are withheld. First-user or system instruction text is never used.
  const unsafe=fixture();unsafe.file(ids[0],null);unsafe.file(ids[1],ids[0],[msg(1500,'SECRET-FORKED-FINAL','final_answer')]);result=await unsafe.get();assert.equal(result.result,'');assert.equal(result.task,'');
  const bounded=fixture({task:16,progress:12,result:20,bytes:2048});bounded.standard([msg(1100,'p'.repeat(100)),msg(1200,'r'.repeat(100),'final_answer')],[call(1050,'followup_task',{target:'selected',message:'t'.repeat(100)},'bound'),output(1051,'bound',{ok:true})]);
  for(let i=0;i<20;i++){result=await bounded.get();if(!result.syncing)break;}
  assert.equal(result.syncing,false);assert.equal(result.task.length,16);assert.equal(result.progress.length,12);assert.equal(result.result.length,20);assert.equal(result.truncated,true);
  // Encrypted transport is never presented as assignment prose. A local
  // recovery is scoped to both native IDs and the exact assignment fingerprint.
  const {fingerprint}=require('../src/modules/subagent-task-description.cjs');
  const encrypted='gAAAAA'+'x'.repeat(100),encoded=fixture();
  const encodedFiles=encoded.standard([msg(1200,'Progress stays intact'),msg(1300,'Result stays intact','final_answer')],[call(1050,'followup_task',{target:'selected',message:encrypted},'encrypted'),output(1051,'encrypted',{ok:true})]);
  result=await encoded.get();assert.equal(result.task,'');assert.equal(result.taskUnavailable,true);assert.equal(result.progress,'Progress stays intact');assert.equal(result.result,'Result stays intact');
  fs.writeFileSync(path.join(encoded.home,'subagent-task-descriptions.json'),JSON.stringify({[`${ids[0]}:${ids[1]}`]:{assignmentHash:fingerprint(encrypted),title:'核对接口',task:'核对当前接口的参数与权限范围。'}}));
  result=await encoded.get();assert.equal(result.task,'核对当前接口的参数与权限范围。');assert.equal(result.title,'核对接口');assert.equal(result.taskUnavailable,false);assert.equal(result.result,'Result stays intact');
  assert.equal((await encoded.monitor.getSubagents(ids[0])).agents.find(a=>a.id===ids[1]).title,result.title,'list and work endpoints reuse the same resolved Chinese title');
  encoded.append(encodedFiles.parent,[call(2000,'followup_task',{target:'selected',message:encrypted+'y'},'new-encrypted'),output(2001,'new-encrypted',{ok:true})]);
  result=await encoded.get();assert.equal(result.task,'');assert.equal(result.taskUnavailable,true,'an old recovered task cannot replace a new encrypted assignment');
  const addressed=fixture();addressed.standard([event(1100,'response_item',{type:'agent_message',author:'/root',recipient:'/root/selected',content:[{type:'input_text',text:'Message Type: NEW_TASK\nTask name: /root/selected\nSender: /root\nPayload:\n核对真实任务内容'}]})],[call(1050,'followup_task',{target:'selected',message:encrypted},'encoded'),output(1051,'encoded',{ok:true})]);
  assert.equal((await addressed.get()).task,'核对真实任务内容');
  // Existing files disappearing yield a retry response; no unrelated fallback.
  fs.unlinkSync(files.child);await assert.rejects(f.get(),{status:503});
  // Exercise the real extension through HTTP, including status mapping and
  // exact-method guards. The fixture home remains separate from native data.
  const apiFixture=fixture();apiFixture.standard([msg(1200,'HTTP final','final_answer')]);
  process.env.CODEX_HOME=apiFixture.home;process.env.BOOST_CODEX_LOCAL_PROJECT=temporary;
  const api=require('../integration/runtime-api.cjs');
  server=http.createServer(async(req,res)=>{const handled=await api.handle({url:new URL(req.url,'http://localhost'),method:req.method,request:req,response:res,sendJson:(r,status,body)=>{r.writeHead(status,{'content-type':'application/json'});r.end(JSON.stringify(body));}});if(!handled){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  let response=await fetch(`${base}/api/dev/subagents/work?threadId=${ids[0]}&agentId=${ids[1]}`);assert.equal(response.status,200);assert.equal((await response.json()).result,'HTTP final');
  response=await fetch(`${base}/api/dev/subagents/work?threadId=bad&agentId=${ids[1]}`);assert.equal(response.status,400);
  response=await fetch(`${base}/api/dev/subagents/work?threadId=${ids[0]}&agentId=${ids[2]}`);assert.equal(response.status,403);
  response=await fetch(`${base}/api/dev/subagents/work`,{method:'POST'});assert.equal(response.status,405);
  response=await fetch(`${base}/api/dev/subagents/work-extra`);assert.equal(response.status,404);
  console.log('PASS: selected subagent original excerpts, native ancestry, privacy boundaries, incremental UTF-8, bounds, follow-up and HTTP route (isolated)');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

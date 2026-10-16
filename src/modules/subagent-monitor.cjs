'use strict';

// Read-only projection of native Codex metadata and lifecycle events. Parsed
// message/prompt text is never stored in the projection or returned to callers.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stamp=value=>{const result=typeof value==='number'?value:Date.parse(value);return Number.isFinite(result)?result:null;};
const label=value=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160):null;
const validId=value=>typeof value==='string'&&UUID.test(value);

function createMonitor(options={}){
 const home=path.resolve(options.codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
 const now=options.now||Date.now;
 const limits={directories:128,headers:160,bytes:8*1024*1024,line:512*1024,states:512,files:100000,...options.limits};
 const index=new Map(),files=new Map(),directories=new Map(),states=new Map(),effects=new Map();
 const roots=['sessions','archived_sessions'].map(name=>path.join(home,name));
 let queue=[],pending=[],lastScan=-Infinity,chain=Promise.resolve(),scanLimited=false,visit=0;

 async function header(file){
  let handle;
  try{
   handle=await fs.open(file,'r');let offset=0,chunks=[];
   while(offset<limits.line){
    const buffer=Buffer.alloc(Math.min(65536,limits.line-offset));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
    if(!bytesRead)return null;
    const data=buffer.subarray(0,bytesRead),end=data.indexOf(10);
    chunks.push(end<0?data:data.subarray(0,end));offset+=bytesRead;
    if(end>=0){
     const event=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(event.type!=='session_meta'||!validId(event.payload?.id))return null;
     const meta=event.payload,source=meta.source?.subagent?.thread_spawn;
     // parent_thread_id on its own can also describe a fork. Only a native
     // subagent spawn establishes a monitored parent-child relationship.
     const parentId=source&&validId(source.parent_thread_id)?source.parent_thread_id:null;
     const agentPath=label(source?.agent_path||meta.agent_path);
     return {id:meta.id.toLowerCase(),parentId:parentId?.toLowerCase()||null,
      name:agentPath?.split('/').filter(Boolean).at(-1)||null,agentPath,
      nickname:label(source?.agent_nickname||meta.agent_nickname),
      createdAt:stamp(meta.timestamp||event.timestamp),file,
      headerBytes:offset-bytesRead+end+1};
    }
   }
  }catch{}finally{await handle?.close().catch(()=>{});}
  return null;
 }

 async function discover(){
  if(!queue.length&&!pending.length&&now()-lastScan>=4000){queue=[...roots];lastScan=now();scanLimited=false;}
  let count=0;
  while(queue.length&&count++<limits.directories){
   const directory=queue.shift();
   try{
    const stat=await fs.stat(directory);let cached=directories.get(directory);
    if(!cached||cached.mtime!==stat.mtimeMs){
     const entries=(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>b.name.localeCompare(a.name));
     cached={mtime:stat.mtimeMs,children:entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>path.join(directory,e.name)),files:[]};
     directories.set(directory,cached);
     for(const entry of entries){
      if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;
      const file=path.join(directory,entry.name);
      cached.files.push(file);
      if(files.has(file))continue;
      if(files.size>=limits.files){scanLimited=true;continue;}
      files.set(file,null);pending.push(file);
     }
    }else{
     // Files can be observed before their first JSONL line has finished writing.
     for(const file of cached.files)if(!files.has(file)&&files.size<limits.files){files.set(file,null);pending.push(file);}
    }
    // Descend the current sessions tree before old, often flat archives.
    queue.unshift(...cached.children);
   }catch{}
  }
  for(let i=0;i<limits.headers&&pending.length;i++){
   const file=pending.shift(),meta=await header(file);
   if(!meta){files.delete(file);continue;}
   files.set(file,meta.id);
   const existing=index.get(meta.id);
   // An archive move has the same identity; use its current readable path.
   if(!existing||existing.file===file)index.set(meta.id,meta);
   else{
    try{await fs.access(existing.file);}catch{index.set(meta.id,meta);const state=states.get(meta.id);if(state)state.file=file;}
   }
  }
 }

 function fresh(meta){return {file:meta.file,offset:meta.headerBytes,carry:Buffer.alloc(0),dropping:false,
  model:null,effort:null,status:'starting',startedAt:meta.createdAt,completedAt:null,elapsedMs:0,
  runningSince:null,turnId:null,lastEvent:meta.createdAt||0,finished:new Set(),calls:new Map(),usedAt:0};}
 function finish(state,event,status){
  const payload=event.payload,time=stamp(event.timestamp),id=payload.turn_id||state.turnId;
  if(id&&state.finished.has(id))return;
  // A late event from a preceding turn cannot end a newly started turn.
  if(payload.turn_id&&state.turnId&&payload.turn_id!==state.turnId)return;
  const duration=Number(payload.duration_ms);
  if(Number.isFinite(duration)&&duration>=0&&payload.duration_ms!=null)state.elapsedMs+=duration;
  else if(state.runningSince!=null&&time!=null)state.elapsedMs+=Math.max(0,time-state.runningSince);
  if(id){state.finished.add(id);if(state.finished.size>512)state.finished.delete(state.finished.values().next().value);}
  state.runningSince=null;state.turnId=null;state.status=status;state.completedAt=time;state.lastEvent=time||state.lastEvent;
 }
 function targetEffect(target,status,time){
  if(!target||time==null)return;
  const previous=effects.get(target);
  if(!previous||previous.at<=time)effects.set(target,{status,at:time});
 }
 function rootOf(meta){
  let id=meta.id,current=meta;const seen=new Set([id]);
  while(current?.parentId&&!seen.has(current.parentId)){
   id=current.parentId;seen.add(id);current=index.get(id);
  }
  return id;
 }
 function controlFor(meta){
  const direct=effects.get(meta.id),scoped=effects.get(`${rootOf(meta)}:${meta.agentPath}`);
  return !direct?scoped:!scoped||direct.at>=scoped.at?direct:scoped;
 }
 function applyControl(state,meta,before=Infinity){
  const effect=controlFor(meta);
  if(effect&&effect.at>state.lastEvent&&effect.at<=before)finish(state,{timestamp:effect.at,payload:{}},effect.status);
 }
 function consume(state,event,meta){
  const payload=event.payload||{},time=stamp(event.timestamp);
  if(time!=null)applyControl(state,meta,time);
  if(event.type==='turn_context'){
   state.model=label(payload.model)||state.model;
   state.effort=label(payload.effort||payload.reasoning_effort)||state.effort;
  }else if(event.type==='event_msg'){
   if(payload.type==='task_started'){
    if(payload.turn_id&&state.finished.has(payload.turn_id))return;
    if(state.runningSince!=null&&payload.turn_id===state.turnId)return;
    if(time!=null){state.startedAt=state.startedAt==null?time:Math.min(state.startedAt,time);state.runningSince=time;}
    state.turnId=payload.turn_id||null;state.status='running';state.completedAt=null;state.lastEvent=time||state.lastEvent;
   }else if(['task_complete','task_completed','turn_complete'].includes(payload.type))finish(state,event,'completed');
   else if(['turn_aborted','task_aborted','task_interrupted'].includes(payload.type))finish(state,event,'interrupted');
   else if(['task_failed','turn_failed','error'].includes(payload.type))finish(state,event,'failed');
   else if(['agent_closed','thread_closed'].includes(payload.type))finish(state,event,'closed');
  }else if(event.type==='response_item'){
   // Parent control calls supply close/interruption evidence not present in some
   // child logs. Never retain the message or spawn prompt in these arguments.
   if(payload.type==='function_call'&&payload.namespace==='collaboration'&&['interrupt_agent','close_agent'].includes(payload.name)){
    try{
     const args=JSON.parse(payload.arguments),target=label(args.target||args.agent_id);
     if(target){state.calls.set(payload.call_id,{target,status:payload.name==='close_agent'?'closed':'interrupted',at:time});if(state.calls.size>64)state.calls.delete(state.calls.keys().next().value);}
    }catch{}
   }else if(payload.type==='function_call_output'&&state.calls.has(payload.call_id)){
    const call=state.calls.get(payload.call_id);state.calls.delete(payload.call_id);
    try{
     const result=typeof payload.output==='string'?JSON.parse(payload.output):payload.output;
     if(result&&!result.error&&!result.isError){
      const target=validId(call.target)?call.target.toLowerCase():`${rootOf(meta)}:${call.target.startsWith('/')?call.target:`${meta.agentPath||'/root'}/${call.target}`}`;
      // Interrupting an already finished agent does not change its result.
      if(call.status!=='interrupted'||!['completed','done','closed'].includes(result.previous_status))targetEffect(target,call.status,time||call.at);
     }
    }catch{}
   }
  }
 }

 async function read(meta,budget){
  let state=states.get(meta.id);
  if(!state){state=fresh(meta);states.set(meta.id,state);}state.usedAt=++visit;
  let handle;
  try{
   handle=await fs.open(meta.file,'r');const stat=await handle.stat();
   if(stat.size<state.offset){state=fresh(meta);states.set(meta.id,state);}
   while(state.offset<stat.size&&budget.bytes>0){
    const size=Math.min(262144,stat.size-state.offset,budget.bytes),buffer=Buffer.alloc(size);
    const {bytesRead}=await handle.read(buffer,0,size,state.offset);if(!bytesRead)break;
    state.offset+=bytesRead;budget.bytes-=bytesRead;
    const data=state.carry.length?Buffer.concat([state.carry,buffer.subarray(0,bytesRead)]):buffer.subarray(0,bytesRead);
    let start=0,end;
    while((end=data.indexOf(10,start))>=0){
     if(!state.dropping&&end-start<=limits.line){try{consume(state,JSON.parse(data.subarray(start,end).toString('utf8')),meta);}catch{}}
     state.dropping=false;start=end+1;
    }
    if(data.length-start>limits.line){state.carry=Buffer.alloc(0);state.dropping=true;}
    else state.carry=Buffer.from(data.subarray(start));
   }
   return state.offset<stat.size||state.carry.length>0||state.dropping;
  }catch{return true;}finally{await handle?.close().catch(()=>{});}
 }

 async function snapshot(threadId){
  await discover();
  const descendants=[],seen=new Set([threadId]);
  // Traverse explicit parent links only, including nested and archived agents.
  let frontier=[threadId],depth=0;
  while(frontier.length){
   const next=[];depth++;
   for(const meta of index.values())if(meta.parentId&&frontier.includes(meta.parentId)&&!seen.has(meta.id)){
    seen.add(meta.id);next.push(meta.id);descendants.push({meta,depth});
   }
   frontier=next;
  }
  const budget={bytes:limits.bytes};let syncing=!!(queue.length||pending.length||scanLimited);
  const root=index.get(threadId);
  if(root){const rootBudget={bytes:Math.min(262144,budget.bytes)},before=rootBudget.bytes;syncing=(await read(root,rootBudget))||syncing;budget.bytes-=before-rootBudget.bytes;}
  // Fair scheduling: never let a large earlier log starve newly spawned agents.
  const ordered=[...descendants].sort((a,b)=>(states.get(a.meta.id)?.usedAt||0)-(states.get(b.meta.id)?.usedAt||0));
  for(const {meta} of ordered){if(budget.bytes<=0){syncing=true;break;}syncing=(await read(meta,budget))||syncing;}
  const observedAt=now();
  const agents=descendants.map(({meta,depth})=>{
   const state=states.get(meta.id)||fresh(meta);
   applyControl(state,meta);
   return {id:meta.id,parentId:meta.parentId,depth,name:meta.name||meta.nickname||meta.id,
    nickname:meta.nickname,model:state.model,effort:state.effort,
    status:state.status,startedAt:state.startedAt,
    completedAt:state.completedAt,elapsedMs:state.elapsedMs,
    runningSince:state.runningSince};
  }).sort((a,b)=>(a.startedAt||0)-(b.startedAt||0)||a.id.localeCompare(b.id));
  const selected=new Set([threadId,...descendants.map(e=>e.meta.id)]);
  for(const [id] of [...states].sort((a,b)=>a[1].usedAt-b[1].usedAt)){
   if(states.size<=limits.states)break;if(!selected.has(id))states.delete(id);
  }
  return {threadId,agents,syncing,observedAt};
 }
 function getSubagents(threadId){
  if(!validId(threadId))return Promise.reject(Object.assign(new Error('Invalid thread ID'),{code:'SUBAGENT_THREAD_INVALID'}));
  const result=chain.then(()=>snapshot(threadId.toLowerCase()));chain=result.catch(()=>{});return result;
 }
 return {getSubagents};
}

let shared;
module.exports={createMonitor,validId,getSubagents(threadId){shared||=createMonitor();return shared.getSubagents(threadId);}};

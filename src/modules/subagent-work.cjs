'use strict';

// Selected-agent original excerpts only. No conversation, reasoning, tool output,
// or inherited user context is projected. All filesystem access is read-only.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const monitorModule=require('./subagent-monitor.cjs');
const descriptions=require('./subagent-task-description.cjs');
const stamp=value=>{const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?n:null;};
const failure=(code,status)=>Object.assign(new Error(code),{code,status});
function createReader(options={}){
 const home=path.resolve(options.codexHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
 const monitor=options.monitor||monitorModule;
 const limits={milliseconds:150,bytes:2*1024*1024,line:512*1024,directories:128,states:24,metadata:256,task:8192,progress:8192,result:12288,...options.limits};
 const roots=['sessions','archived_sessions'].map(name=>path.join(home,name));
 const found=new Map(),candidates=new Map(),cache=new Map(),inFlight=new Map();let queue=[],scanAt=0,chain=Promise.resolve();
 const remember=meta=>{found.delete(meta.id);found.set(meta.id,meta);while(found.size>limits.metadata)found.delete(found.keys().next().value);};
 const cap=(value,length)=>{let text=typeof value==='string'?value:'';const truncated=text.length>length;if(truncated){text=text.slice(0,length);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);}return {text,truncated};};
 async function header(file){
  let handle;
  try{
   handle=await fs.open(file,'r');let parts=[],size=0;
   while(size<limits.line){const b=Buffer.alloc(Math.min(16384,limits.line-size)),r=await handle.read(b,0,b.length,size);if(!r.bytesRead)return null;
    const data=b.subarray(0,r.bytesRead),end=data.indexOf(10);parts.push(end<0?data:data.subarray(0,end));size+=r.bytesRead;
    if(end>=0){const e=JSON.parse(Buffer.concat(parts).toString('utf8')),p=e.payload||{},spawn=p.source?.subagent?.thread_spawn;
     if(e.type!=='session_meta'||!monitorModule.validId(p.id))return null;
     return {id:p.id.toLowerCase(),parentId:monitorModule.validId(spawn?.parent_thread_id)?spawn.parent_thread_id.toLowerCase():null,
      agentPath:typeof spawn?.agent_path==='string'?spawn.agent_path:typeof p.agent_path==='string'?p.agent_path:null,
      createdAt:stamp(p.timestamp||e.timestamp),file,offset:size-r.bytesRead+end+1};}
   }
  }catch{}finally{await handle?.close().catch(()=>{});}return null;
 }
 async function locate(ids,deadline){
  // A directory is visited once per discovery cycle; only requested UUID
  // basenames cause header reads. Keep the queue across bounded polls.
  const needed=new Set(ids.filter(id=>!found.has(id)));
  for(const id of ids){const m=found.get(id);if(m){try{await fs.access(m.file);}catch{found.delete(id);needed.add(id);}}}
  for(const id of [...needed]){const file=candidates.get(id);if(!file||Date.now()>=deadline)continue;
   const m=await header(file);if(m?.id===id){remember(m);needed.delete(id);}else candidates.delete(id);
  }
  if(!needed.size)return false;
  if(!queue.length&&Date.now()-scanAt>=1000){queue=[...roots];scanAt=Date.now();}
  let count=0;
  while(queue.length&&count++<limits.directories&&Date.now()<deadline){
   const directory=queue.shift();let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch{continue;}
   entries.sort((a,b)=>b.name.localeCompare(a.name));
   const children=[];
   for(const entry of entries){
    if(entry.isDirectory()&&!entry.isSymbolicLink()){children.push(path.join(directory,entry.name));continue;}
    if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;
    const filename=entry.name.toLowerCase(),match=filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    if(match){candidates.delete(match[1]);candidates.set(match[1],path.join(directory,entry.name));while(candidates.size>4096)candidates.delete(candidates.keys().next().value);}
    const id=match&&needed.has(match[1])?match[1]:null;if(!id)continue;
    const m=await header(path.join(directory,entry.name));if(m?.id!==id)continue;
    remember(m);needed.delete(id);
   }
   queue.unshift(...children.slice(0,4096));if(queue.length>4096)queue.length=4096;
   if(!needed.size)break;
  }
  return needed.size>0;
 }
 function logState(meta){return {file:meta.file,offset:meta.offset,carry:Buffer.alloc(0),dropping:false,skipped:false,calls:new Map(),gate:false,progress:'',result:'',progressAt:null,resultAt:null,progressCut:false,resultCut:false,task:'',taskAt:null,taskCut:false,plainTask:'',plainTaskAt:null};}
 function targetMatches(target,parent,child){
  if(typeof target!=='string')return false;
  if(monitorModule.validId(target))return target.toLowerCase()===child.id;
  return !!child.agentPath&&(target===child.agentPath||`${parent.agentPath||'/root'}/${target}`===child.agentPath);
 }
 function consumeParent(s,e,parent,child){
  if(e.type!=='response_item')return;const p=e.payload||{};
  if(p.type==='function_call'&&(!p.namespace||p.namespace==='collaboration')&&['spawn_agent','followup_task','send_input'].includes(p.name)){
   try{const a=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;
    if(typeof a?.message!=='string')return;
    if(p.name!=='spawn_agent'&&!targetMatches(a.target||a.id||a.agent_id,parent,child))return;
    // Keep only plausible selected-child spawn prompts, never other tasks.
    if(p.name==='spawn_agent'&&a.task_name&&child.agentPath!==`${parent.agentPath||'/root'}/${a.task_name}`)return;
    const value=cap(a.message,limits.task);s.calls.set(p.call_id,{name:p.name,...value,at:stamp(e.timestamp)});
    while(s.calls.size>32)s.calls.delete(s.calls.keys().next().value);
   }catch{}
  }else if(p.type==='function_call_output'&&s.calls.has(p.call_id)){
   const call=s.calls.get(p.call_id);s.calls.delete(p.call_id);
   try{const out=typeof p.output==='string'?JSON.parse(p.output):p.output;
    if(!out||out.error||out.isError)return;
    if(call.name==='spawn_agent'&&!((typeof out.agent_id==='string'&&out.agent_id.toLowerCase()===child.id)||(out.task_name&&out.task_name===child.agentPath)))return;
    s.task=call.text;s.taskAt=call.at;s.taskCut=call.truncated;
   }catch{}
  }
 }
 function consumeChild(s,e,meta,assignment){
  const p=e.payload||{},time=stamp(e.timestamp);
  if(time==null||meta.createdAt!=null&&time<meta.createdAt)return;
  // A native addressed agent-message marks the end of the inherited fork
  // context. Its encrypted or instruction content is never exposed.
  if(e.type==='response_item'&&p.type==='agent_message'&&meta.agentPath&&p.recipient===meta.agentPath){
   s.gate=true;
   // Only an explicitly addressed NEW_TASK payload can supplement assignment
   // text. Other user/system/inherited messages remain excluded.
   const text=Array.isArray(p.content)?p.content.filter(x=>x.type==='input_text'&&typeof x.text==='string').map(x=>x.text).join('\n'):'';
   const match=/^Message Type: NEW_TASK\r?\n[\s\S]*?\r?\nPayload:\r?\n([\s\S]+)$/.exec(text);
   if(match&&match[1].trim()&&!descriptions.encrypted(match[1])){s.plainTask=match[1].trim();s.plainTaskAt=time;}
   return;
  }
  // Older native sessions use an explicit user_message assignment event.
  if(e.type==='event_msg'&&p.type==='user_message'&&assignment.task&&!assignment.taskCut&&p.message===assignment.task){s.gate=true;return;}
  if(e.type==='response_item'&&p.type==='message'&&p.role==='user'&&assignment.task&&!assignment.taskCut&&Array.isArray(p.content)&&p.content.length===1&&p.content[0].type==='input_text'&&p.content[0].text===assignment.task){s.gate=true;return;}
  if(!s.gate||e.type!=='response_item'||p.type!=='message'||p.role!=='assistant')return;
  if(p.recipient&&p.recipient!=='all')return;
  if(p.channel&&!['commentary','final','final_answer'].includes(p.channel))return;
  const phase=p.phase||p.channel;
  if(!['commentary','final','final_answer'].includes(phase))return;
  const text=Array.isArray(p.content)?p.content.filter(x=>x.type==='output_text'&&typeof x.text==='string').map(x=>x.text).join('\n'):'';
  if(!text)return;
  const key=phase==='commentary'?'progress':'result',value=cap(text,limits[key]);s[key]=value.text;s[`${key}At`]=time;s[`${key}Cut`]=value.truncated;
 }
 async function read(meta,s,budget,deadline,consume){
  let handle;
  try{handle=await fs.open(meta.file,'r');const stat=await handle.stat();
   if(s.file!==meta.file||stat.size<s.offset){Object.assign(s,logState(meta));}
   while(s.offset<stat.size&&budget.bytes>0&&Date.now()<deadline){
    const b=Buffer.alloc(Math.min(65536,stat.size-s.offset,budget.bytes)),r=await handle.read(b,0,b.length,s.offset);if(!r.bytesRead)break;
    s.offset+=r.bytesRead;budget.bytes-=r.bytesRead;
    const data=s.carry.length?Buffer.concat([s.carry,b.subarray(0,r.bytesRead)]):b.subarray(0,r.bytesRead);let start=0,end;
    while((end=data.indexOf(10,start))>=0){if(!s.dropping&&end-start<=limits.line){try{consume(JSON.parse(data.subarray(start,end).toString('utf8')));}catch{}}else s.skipped=true;s.dropping=false;start=end+1;}
    if(data.length-start>limits.line){s.carry=Buffer.alloc(0);s.dropping=true;s.skipped=true;}else s.carry=Buffer.from(data.subarray(start));
   }
   return s.offset<stat.size||s.carry.length>0||s.dropping;
  }catch{throw failure('SUBAGENT_WORK_UNAVAILABLE',503);}finally{await handle?.close().catch(()=>{});}
 }
 async function snapshot(threadId,agentId){
  const deadline=Date.now()+limits.milliseconds;
  const projection=await monitor.getSubagents(threadId),agent=projection.agents.find(a=>a.id===agentId);
  if(!agent)throw failure(projection.syncing?'SUBAGENT_WORK_SYNCING':'SUBAGENT_WORK_FORBIDDEN',projection.syncing?503:403);
  await locate([agentId,agent.parentId],deadline);
  const child=found.get(agentId),parent=found.get(agent.parentId);
  if(!child||!parent)throw failure('SUBAGENT_WORK_SYNCING',503);
  // Repeat identity checks at the trust boundary, independent of filenames.
  if(child.parentId!==agent.parentId)throw failure('SUBAGENT_WORK_FORBIDDEN',403);
  const key=`${threadId}:${agentId}`;let state=cache.get(key);
  if(!state){state={parent:logState(parent),child:logState(child)};}cache.delete(key);cache.set(key,state);
  while(cache.size>limits.states)cache.delete(cache.keys().next().value);
  const budget={bytes:limits.bytes};
  const parentBudget={bytes:Math.ceil(budget.bytes/2)},before=parentBudget.bytes;
  let syncing=await read(parent,state.parent,parentBudget,deadline,e=>consumeParent(state.parent,e,parent,child));budget.bytes-=before-parentBudget.bytes;
  syncing=(await read(child,state.child,budget,deadline,e=>consumeChild(state.child,e,child,state.parent)))||syncing;
  const a=state.parent,c=state.child,after=time=>time!=null&&(a.taskAt==null||time>=a.taskAt);
  const progress=after(c.progressAt)?c.progress:'',result=after(c.resultAt)?c.result:'';
  const times=[a.taskAt,progress?c.progressAt:null,result?c.resultAt:null].filter(x=>x!=null);
  const description=await descriptions.describe({threadId,agentId,task:a.task,name:agent.name,plainTask:after(c.plainTaskAt)?c.plainTask:'',home:options.descriptionHome});
  const task=cap(description.task,limits.task);
  return {threadId,agentId,...description,task:task.text,progress,result,updatedAt:times.length?Math.max(...times):null,
   syncing:!!syncing,truncated:!!(task.truncated||a.skipped||c.skipped||a.taskCut||progress&&c.progressCut||result&&c.resultCut)};
 }
 function getWork(threadId,agentId){
  if(!monitorModule.validId(threadId)||!monitorModule.validId(agentId))return Promise.reject(failure('SUBAGENT_WORK_INPUT_INVALID',400));
  threadId=threadId.toLowerCase();agentId=agentId.toLowerCase();const key=`${threadId}:${agentId}`;
  if(threadId===agentId)return Promise.reject(failure('SUBAGENT_WORK_FORBIDDEN',403));
  if(inFlight.has(key))return inFlight.get(key);
  if(inFlight.size>=16)return Promise.reject(failure('SUBAGENT_WORK_BUSY',503));
  const work=chain.then(()=>snapshot(threadId,agentId)).finally(()=>inFlight.delete(key));inFlight.set(key,work);chain=work.catch(()=>{});return work;
 }
 return {getWork};
}
let shared;
module.exports={createReader,getWork(threadId,agentId){shared||=createReader();return shared.getWork(threadId,agentId);}};

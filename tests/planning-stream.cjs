const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {DatabaseSync}=require('node:sqlite');
const {normalize}=require('../src/modules/planning-stream.cjs');
const home=path.join(process.env.USERPROFILE,'.better-codex');
const bundle=path.resolve(__dirname,'../src/backend/better-codex.cjs');
const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,updated_at TEXT);
CREATE TABLE project_planning_sessions(project_id TEXT PRIMARY KEY,status TEXT,thread_id TEXT);
CREATE TABLE project_planning_messages(id TEXT PRIMARY KEY,project_id TEXT,role TEXT,markdown TEXT,html TEXT,created_at TEXT);
INSERT INTO projects VALUES('test','');
INSERT INTO project_planning_sessions VALUES('test','running',NULL);
INSERT INTO project_planning_messages VALUES('user-1','test','user','test','','2026-10-03T06:00:00.000Z');`);
assert.equal(normalize({type:'item.completed',item:{type:'reasoning',text:'private'}}),null);
assert.equal(normalize({type:'item.completed',item:{type:'AgentMessage',phase:'analysis',content:'private'}}),null);
const files=new Map();let changes=0;
const source=fs.readFileSync(bundle,'utf8');
const start=source.indexOf('      runProjectPlanningProcess(project, threadId, prompt) {');
const end=source.indexOf('      sandboxMode(agentId2) {',start);
assert(start>=0&&end>start);
const worker=vm.runInNewContext('({'+source.slice(start,end)+'})',{
  require,__dirname:path.resolve(__dirname,'../src/backend'),betterCodexHome:home,Date,console,
  setTimeout:()=>{throw Error('Planning worker must not set a deadline');},clearTimeout,
  runLogPath:'/fixture',projectPlanningTimeout:1000,projectPlanningSchemaPath:'/fixture/schema.json',process,
  import_node_path23:path,
  import_node_readline3:require('node:readline'),
  import_node_fs28:{existsSync:p=>p==='/workspace'||files.has(p),readFileSync:p=>files.get(p),unlinkSync:p=>files.delete(p)},
  codexExecutablePath:()=>'/fixture/codex',agentConfigProfileName:()=>'',
  projectPlanningThreadId:line=>{const e=JSON.parse(line);return e.type==='thread.started'?e.thread_id:'';},
  import_node_child_process12:{spawn:(_cmd,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};
    setTimeout(()=>{
      for(const event of [
        {type:'thread.started',thread_id:'thread-fixture'},
        {type:'item.started',item:{id:'tool',type:'command_execution',status:'in_progress',command:'rg app --token hidden-secret'}},
        {type:'item.completed',item:{id:'tool',type:'command_execution',status:'completed',exit_code:0,aggregated_output:'private output'}},
        {type:'item.completed',item:{id:'message',type:'agent_message',text:'已经核对项目页面。'}},
        {type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify({reply:'done',plan:{}})}},
        {type:'turn.completed'}
      ])child.stdout.write(JSON.stringify(event)+'\n');
      const output=args[args.indexOf('--output-last-message')+1];files.set(output,'{"reply":"done","plan":{}}');
      child.stdout.end();child.emit('close',0);
    },10);return child;
  }}
});
worker.store={db};worker.projectPlannings=new Map();worker.onChange=()=>changes++;
(async()=>{
  const result=await worker.runProjectPlanningProcess({id:'test',root_paths:['/workspace'],workspace_path:'/workspace',planning:{}},null,'fixture');
  assert.equal(result.threadId,'thread-fixture');
  assert.equal(db.prepare('SELECT thread_id FROM project_planning_sessions').get().thread_id,'thread-fixture');
  const rows=db.prepare("SELECT * FROM project_planning_messages WHERE role='agent'").all();assert.equal(rows.length,1);
  const events=JSON.parse(rows[0].markdown).events;
  assert.equal(events.filter(e=>e.id==='tool').length,1);
  assert.equal(events.find(e=>e.id==='tool').status,'completed');
  assert(events.some(e=>e.text==='已经核对项目页面。'));
  assert(rows[0].markdown.includes('rg app'));
  assert(!rows[0].markdown.includes('hidden-secret')&&!rows[0].markdown.includes('private output'));
  assert(!events.some(e=>e.status==='running'));
  assert(changes>=5);
  assert(Date.parse(rows[0].created_at)>Date.parse('2026-10-03T06:00:00.000Z'));
  db.close();console.log('PASS: worker stdout → persisted progress → UI snapshot; deduplication, private-data exclusion, session preservation and completion status');
})().catch(e=>{console.error(e);process.exitCode=1;});

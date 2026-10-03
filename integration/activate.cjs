const fs=require('node:fs'),path=require('node:path');const lib=require('./lib.cjs');const {DatabaseSync}=require('node:sqlite');
(async()=>{
 lib.validate();if(!lib.read(path.join(lib.DEV,'activated.json')))lib.bootstrap();
 const legacy=await lib.health();const db=new DatabaseSync(path.join(lib.HOME,'better-codex.db'),{readOnly:true});
 const active=db.prepare("SELECT count(*) n FROM project_planning_sessions WHERE status='running'").get().n;
 const issues=db.prepare('SELECT count(*) n FROM issues').get().n;db.close();if(active)throw Error('Active planning prevents migration');
 const ready=await lib.ensureLocalRuntime();
 try{
  for(const action of [['mcp','install','--json'],['launcher','install','--json'],['service','install','--json']])lib.runCore(action);
  await require('./watcher.cjs').refresh();
  lib.save(path.join(lib.DEV,'activated.json'),{at:new Date().toISOString(),pid:ready.pid});lib.ensureWatcher();
  const finalReady=await lib.api('/readyz');const local=await lib.api('/api/dev/status');if(local.pid!==finalReady.pid)throw Error('Runtime identity mismatch');
  lib.status({phase:'ready',error:null,revision:lib.state().sourceHash});
  console.log(JSON.stringify({activated:true,pid:finalReady.pid,existingIssueCount:issues,sessionHostConnected:finalReady.session_host?.connected,dev:local}));
 }catch(e){lib.log('activation_failed',{error:e.message});throw e;}
})().catch(e=>{console.error(e.message);process.exitCode=1;});

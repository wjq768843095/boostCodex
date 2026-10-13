const path=require('node:path');const lib=require('./lib.cjs');
(async()=>{
 lib.validate();if(!lib.read(path.join(lib.DEV,'activated.json')))lib.bootstrap();
 const ready=await lib.ensureLocalRuntime();
 for(const action of [['launcher','install','--json'],['service','install','--json']])lib.runCore(action);
 await require('./watcher.cjs').refresh();
 lib.save(path.join(lib.DEV,'activated.json'),{at:new Date().toISOString(),pid:ready.pid});lib.ensureWatcher();
 const finalReady=await lib.api('/readyz');const local=await lib.api('/api/dev/status');if(local.pid!==finalReady.pid)throw Error('Runtime identity mismatch');
 lib.status({phase:'ready',error:null,revision:lib.state().sourceHash});
 console.log(JSON.stringify({activated:true,pid:finalReady.pid,sessionHostConnected:finalReady.session_host?.connected,dev:local}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});

const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const lib=require('./lib.cjs');
(async()=>{
 const migration=lib.read(path.join(lib.DEV,'migration.json'));if(!migration||!fs.existsSync(migration.installed))throw Error('Original installation unavailable');
 const current=await lib.api('/api/dev/status','GET',{},true);if(current&&!current.ready)throw Error('Wait for active work before rollback');
 lib.save(path.join(lib.DEV,'watcher-stop.json'),{at:Date.now()});await new Promise(r=>setTimeout(r,1000));
 // Prevent the injector from bringing the local runtime back while switching entries.
 lib.runCore(['dev-stop-injector','--json']);
 if(current)await lib.api('/api/dev/drain','POST');
 if(await lib.health())await lib.shutdown();
 const env={...process.env,BETTER_CODEX_HOME:lib.HOME};for(const key of ['BETTER_CODEX_LOCAL_PROJECT','BETTER_CODEX_BASE_ENTRYPOINT','BC_UI_FILE','BC_RUNTIME_API','BC_COMPATIBILITY_FILE','BC_REVISION'])delete env[key];
 for(const args of [['mcp','install','--json'],['launcher','install','--json'],['service','install','--json'],['refresh-injection','--json']])cp.execFileSync(process.execPath,[migration.installed,...args],{env,windowsHide:true,timeout:60000,stdio:'pipe'});
 const activated=path.join(lib.DEV,'activated.json');if(fs.existsSync(activated))fs.renameSync(activated,path.join(lib.DEV,'deactivated.json'));
 console.log(JSON.stringify({restoredOriginalInstallation:true,dataPreserved:true}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});

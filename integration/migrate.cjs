const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const ROOT=path.resolve(__dirname,'..'),HOME=path.join(process.env.USERPROFILE,'.better-codex');
const installed=path.join(process.env.USERPROFILE,'AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/BetterCodex/bin/better-codex.cjs');
function write(name,value){const file=path.join(ROOT,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
function fingerprint(db){const tables=['projects','issues','project_planning_sessions','project_planning_messages'];const result={};for(const table of tables){const rows=db.prepare('SELECT * FROM '+table).all();result[table]={count:rows.length,hash:crypto.createHash('sha256').update(JSON.stringify(rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex')};}return result;}
(async()=>{
 if(fs.existsSync(path.join(ROOT,'src/backend/better-codex.cjs')))throw Error('Migration source already exists');
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');const dest=path.join(ROOT,'.dev/backups',stamp);fs.mkdirSync(dest,{recursive:true});
 fs.copyFileSync(installed,path.join(dest,'better-codex.cjs'));
 for(const [name,source] of [['launcher.vbs',path.join(HOME,'Better Codex Launcher.vbs')],['launch-integration.json',path.join(HOME,'run/launch-integration.json')],['codex-config.toml',path.join(process.env.USERPROFILE,'.codex/config.toml')]])if(fs.existsSync(source))fs.copyFileSync(source,path.join(dest,name));
 const db=new DatabaseSync(path.join(HOME,'better-codex.db'),{readOnly:true});const before=fingerprint(db);await backup(db,path.join(dest,'better-codex.db'));db.close();
 const restored=new DatabaseSync(path.join(dest,'better-codex.db'),{readOnly:true});if(restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity failed');const after=fingerprint(restored);restored.close();if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Backup content mismatch');
 fs.writeFileSync(path.join(dest,'data-fingerprint.json'),JSON.stringify(before,null,2));
 let source=fs.readFileSync(installed,'utf8');const prefix='    injectedUiBundle = ';const start=source.indexOf(prefix);if(start<0)throw Error('UI assignment missing');let pos=start+prefix.length;if(source[pos]!=='`')throw Error('UI template missing');let end=pos+1;for(;end<source.length;end++){if(source[end]==='\\'){end++;continue;}if(source[end]==='`')break;}if(source[end+1]!==';')throw Error('UI template boundary invalid');
 const ui=vm.runInNewContext(source.slice(pos,end+1),Object.create(null),{timeout:1000});new vm.Script(ui);write('src/ui/better-codex-ui.js',ui);
 source=source.slice(0,start)+`    injectedUiBundle = require('node:fs').readFileSync(process.env.BC_UI_FILE || require('node:path').join(__dirname,'../ui/better-codex-ui.js'),'utf8');\n    injectedUiBundleChecksum = require('node:crypto').createHash('sha256').update(injectedUiBundle).digest('hex');`+source.slice(end+2);
 function replace(a,b){if(source.split(a).length!==2)throw Error('Migration anchor: '+a.slice(0,70));source=source.replace(a,b);}
 replace('function sourceProcessArguments(args) {',`function sourceProcessArguments(args) {\n  if (process.env.BETTER_CODEX_LOCAL_PROJECT) return [process.env.BETTER_CODEX_BASE_ENTRYPOINT, ...args];`);
 replace('function activeCoreExecutable() {',`function activeCoreExecutable() {\n  if (process.env.BETTER_CODEX_LOCAL_PROJECT) return currentCoreEntrypoint();`);
 replace('function maybeDelegateToActiveCore() {',`function maybeDelegateToActiveCore() {\n  if (process.env.BETTER_CODEX_LOCAL_PROJECT) return null;`);
 replace('function startGatewayUpdateChecks() {',`function startGatewayUpdateChecks() {\n  if (process.env.BETTER_CODEX_LOCAL_PROJECT) return () => {};`);
 replace('async function installRuntimeUpdate(targetVersion, channel) {',`async function installRuntimeUpdate(targetVersion, channel) {\n  if (process.env.BETTER_CODEX_LOCAL_PROJECT) throw new Error('local_project_update_managed');`);
 replace('async function updateAll(channel = selectedUpdateChannel(), pinned) {',`async function updateAll(channel = selectedUpdateChannel(), pinned) {\n  if (process.env.BETTER_CODEX_LOCAL_PROJECT) throw new Error('local_project_update_managed');`);
 source=source.replace(/\(0, import_node_path23\.join\)\(betterCodexHome,\s*'customizations',\s*'(planning-(?:stream|control)\.cjs)'\)/g,"require('node:path').join(__dirname,'../modules','$1')");
 replace('function injectionBundleChecksum() {',`function refreshLocalInjectedUi() {\n  if (!process.env.BC_UI_FILE) return;\n  const latest = require('node:fs').readFileSync(process.env.BC_UI_FILE,'utf8');\n  injectedUiBundle = latest;\n  injectedUiBundleChecksum = require('node:crypto').createHash('sha256').update(latest).digest('hex');\n}\nfunction injectionBundleChecksum() {\n  refreshLocalInjectedUi();`);
 replace('function injectionScript(port, accessToken3, action, locale = "zh-CN", host = "codex") {',`function injectionScript(port, accessToken3, action, locale = "zh-CN", host = "codex") {\n  refreshLocalInjectedUi();`);
 replace('      if (mockupEnabled && mockupLocalOnlyPath(url.pathname))',`      if (process.env.BETTER_CODEX_LOCAL_PROJECT && url.pathname.startsWith('/api/dev/')) {\n        if (relayRequest) return sendJson(response,403,{error:'local_access_required'});\n        const handled = await require(process.env.BC_RUNTIME_API).handle({url,method,request:request2,response,worker,readBody,sendJson});\n        if (handled) return;\n      }\n      if (mockupEnabled && mockupLocalOnlyPath(url.pathname))`);
 write('src/backend/better-codex.cjs',source);
 for(const name of ['planning-stream.cjs','planning-control.cjs'])write('src/modules/'+name,fs.readFileSync(path.join(HOME,'customizations',name)));
 write('.dev/migration.json',JSON.stringify({backup:dest,installed,home:HOME,baseline:'0.4.18',fingerprint:before},null,2));
 console.log(JSON.stringify({sourceReady:true,backup:dest,data:before,uiBytes:Buffer.byteLength(ui)}));
})().catch(e=>{console.error(e);process.exitCode=1;});

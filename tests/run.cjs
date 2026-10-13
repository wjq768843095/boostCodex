const cp=require('node:child_process'),path=require('node:path');
const suites=['account-primary-deadline.cjs','account-bridge-deadline.cjs','account-metadata-transport.cjs','account-metadata-runtime-api.cjs','account-transport-recovery.cjs','startup-diagnostics.cjs','codex-usage.cjs','composer-model-shortcuts.cjs','reload.cjs','minimal-runtime.cjs','native-account-session.cjs'];
for(const name of suites){const result=cp.spawnSync(process.execPath,[path.join(__dirname,name)],{stdio:'inherit',windowsHide:true});if(result.status!==0)process.exit(result.status||1);}

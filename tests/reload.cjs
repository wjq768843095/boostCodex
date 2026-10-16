'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const lib=require('../integration/lib.cjs');lib.validate();
let host={active_turns:[]};const source=fs.readFileSync(path.join(__dirname,'../integration/runtime-api.cjs'),'utf8');
const context={module:{exports:{}},require:name=>name==='node:fs'?{readFileSync:()=>JSON.stringify(host)}:require(name),process:{env:{BOOST_CODEX_HOME:'fixture'}},JSON};vm.runInNewContext(source,context);
let ready=true;const worker={updateDrainStatus:()=>({ready})};const idle=context.module.exports.idle;
assert(idle(worker).ready);for(const busy of [{active_turns:['thread']},{command_in_flight:true},{pending_requests:1},{queued_deliveries:1}]){host=busy;assert(!idle(worker).ready);}host={};ready=false;assert(!idle(worker).ready);
const ensure=vm.runInNewContext('('+lib.ensureLocalRuntime.toString()+')',{health:async()=>null,alive:()=>true,read:()=>({pid:11}),path,HOME:'fixture',spawnCore:()=>{throw Error('must not spawn');}});
(async()=>{await assert.rejects(ensure(),/runtime_still_running_health_unavailable/);console.log('PASS: syntax, active native work blocks reload and live runtime is never duplicated');})().catch(e=>{console.error(e);process.exitCode=1;});

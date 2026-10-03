const assert=require('node:assert/strict'),path=require('node:path'),lib=require('../integration/lib.cjs');const {cdp}=require('../integration/watcher.cjs');
let saved;
(async()=>{
 saved=await cdp('window.__betterCodexInjection__.captureReloadState()');
 const result=await cdp(`(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms)),wait=async check=>{for(let i=0;i<60;i++){if(check())return;await sleep(100);}throw Error('UI did not render');};
  window.__betterCodexInjection__.open('projects',{projectId:'ca6c2b16-6698-4e19-a0f1-a895b99d04dd'});
  await wait(()=>document.querySelectorAll('.bc-project-row').length===32);
  const count=document.querySelectorAll('.bc-project-row').length,panel=document.querySelector('#better-codex-panel');
  const second=[...document.querySelectorAll('.bc-project-row')].find(e=>!e.classList.contains('is-active')),nextId=second.dataset.projectId;
  second.click();await wait(()=>document.querySelector('.bc-project-row.is-active')?.dataset.projectId===nextId);
  const switched=window.__betterCodexInjection__.captureReloadState().project===nextId&&document.querySelector('#better-codex-panel')===panel;
  [...document.querySelectorAll('.bc-project-row')].find(e=>e.dataset.projectId==='ca6c2b16-6698-4e19-a0f1-a895b99d04dd').click();
  await wait(()=>document.querySelector('.bc-project-row.is-active')?.dataset.projectId==='ca6c2b16-6698-4e19-a0f1-a895b99d04dd');
  document.querySelector('.better-codex-project-dashboard-tabs-desktop [data-project-dashboard-view="planning"]').click();
  await wait(()=>document.querySelector('[data-project-planning-form] textarea')&&document.querySelector('#better-codex-panel').textContent.includes('PC 和 H5'));
  const planning=!!document.querySelector('[data-project-planning-form] textarea')&&document.querySelector('#better-codex-panel').textContent.includes('PC 和 H5');
  const input=document.querySelector('[data-project-planning-form] textarea');if(input.value==='自动重载验证草稿'){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));}
  document.querySelector('.better-codex-project-dashboard-tabs-desktop [data-project-dashboard-view="work"]').click();
  await wait(()=>document.querySelector('.better-codex-project-dashboard-tabs-desktop [aria-current="page"]')?.dataset.projectDashboardView==='work');
  const work=window.__betterCodexInjection__.captureReloadState().tab==='work';
  window.__betterCodexInjection__.close();const home=document.querySelector('#better-codex-panel').hidden;
  return {count,switched,planning,work,home,error:window.__betterCodexInjection__.bootstrapError()};
 })()`);
 assert.equal(result.count,32);for(const field of ['switched','planning','work','home'])assert.equal(result[field],true,field);assert.equal(result.error,null);assert((await lib.api('/readyz')).session_host.connected);
 lib.save(path.join(lib.DEV,'ui-acceptance.json'),{at:new Date().toISOString(),...result,nativeSessionConnected:true});console.log('PASS: native home, 32-project split view, selection switching, existing planning messages, work tab and native session connection');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(saved)try{saved.planningDrafts=(saved.planningDrafts||[]).map(([id,value])=>[id,value==='自动重载验证草稿'?'':value]);await cdp('window.__betterCodexInjection__.restoreReloadState('+JSON.stringify(saved)+')');}catch(e){console.error(e.message);process.exitCode=1;}});

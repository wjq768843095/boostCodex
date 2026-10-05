'use strict';
// Installed desktop checks: read native metadata and inspect UI; never create a
// thread, send a turn, approve an action, or modify project planning records.
const assert = require('node:assert/strict');
const path = require('node:path');
const lib = require('../integration/lib.cjs');
const { cdp } = require('../integration/watcher.cjs');

async function nativeRequest(method, params, projection = 'result') {
  const value = await cdp(`(async()=>{try{
    const id='bc-acceptance:'+crypto.randomUUID();
    const result=await new Promise((resolve,reject)=>{
      let timer;
      const done=()=>{clearTimeout(timer);window.removeEventListener('message',listener);};
      const listener=event=>{let value=event.data;if(typeof value==='string'){try{value=JSON.parse(value);}catch{return;}}
        if(value?.type!=='mcp-response'||value.message?.id!==id)return;
        done();if(value.message.error)reject(Error(value.message.error.message||'native metadata request failed'));else resolve(value.message.result);};
      window.addEventListener('message',listener);timer=setTimeout(()=>{done();reject(Error('native metadata timeout'));},9500);
      Promise.resolve(window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',source:'better-codex',timeoutMs:9500,request:{id,method:${JSON.stringify(method)},params:${JSON.stringify(params)}}})).catch(error=>{done();reject(error);});
    });
    return ${projection};
    }catch(error){return {acceptanceError:String(error.message||error)};}
  })()`);
  if (value?.acceptanceError) throw Error(method+': '+value.acceptanceError);
  return value;
}

async function main() {
  if (process.argv.includes('--refresh-mcp')) await nativeRequest('config/mcpServer/reload', undefined, '({refreshed:true})');
  const mcp = await nativeRequest('mcpServerStatus/list', { cursor:null,limit:100,detail:'toolsAndAuthOnly' }, `({servers:(result.data||[]).filter(server=>/better[-_]codex/i.test(server.name)).map(server=>({name:server.name,tools:Object.keys(server.tools||{}),charterFields:Object.keys(server.tools?.project_charter_save?.inputSchema?.properties||{})}))})`);
  const skills = await nativeRequest('skills/list', { cwds:[lib.ROOT],forceReload:true }, `({skills:(result.data||[]).flatMap(entry=>entry.skills||[]).filter(skill=>skill.name.startsWith('better-codex-')).map(skill=>({name:skill.name,path:skill.path,enabled:skill.enabled})),errors:(result.data||[]).flatMap(entry=>entry.errors||[]).map(error=>({path:error.path,message:error.message}))})`);
  const tools = mcp.servers.flatMap(server=>server.tools);
  for (const name of ['project_context_read','project_charter_save','project_charter_confirm','project_plan_save','project_plan_convert']) assert.ok(tools.some(tool=>tool.endsWith(name)), 'native MCP tool missing: '+name);
  for (const name of ['better-codex-charter','better-codex-charter-review','better-codex-plan','better-codex-task-review','better-codex-develop','better-codex-test']) assert.ok(skills.skills.some(skill=>skill.name===name&&skill.enabled!==false),'native Skill missing: '+name);
  for (const name of ['metadata','facts']) assert.ok(mcp.servers.some(server=>server.charterFields.includes(name)),'native charter field missing: '+name);
  assert.ok(skills.errors.every(error=>!String(error.path||'').includes(path.join('.agents','skills','better-codex-'))),'managed Skills must parse successfully');
  const projects = await lib.api('/api/projects');
  const project = (projects.projects||projects).find(entry=>path.resolve(entry.workspace_path||'').toLowerCase()===lib.ROOT.toLowerCase());
  assert.ok(project,'current project must exist');
  let ui;
  await cdp(`(()=>{
    window.__bcAcceptanceSavedView=window.__betterCodexInjection__.captureReloadState();
    const seen=new Set();
    for(const element of document.querySelectorAll('.ProseMirror')){
      if(element.getBoundingClientRect().width<1)continue;
      for(let node=element;node;node=node.parentElement){
        const key=Object.keys(node).find(name=>name.startsWith('__reactFiber$'));
        let fiber=key&&node[key];
        while(fiber&&!seen.has(fiber)){
          seen.add(fiber);const values=[fiber.memoizedProps?.value];let hook=fiber.memoizedState;
          for(let index=0;hook&&typeof hook==='object'&&index<100;index++,hook=hook.next)values.push(hook.memoizedState?.current);
          for(const scope of values)if(typeof scope?.value?.routeKind==='string'&&scope.value.pathname){window.__bcAcceptanceNativeRoute=scope.value.pathname+(scope.value.search||'');return true;}
          fiber=fiber.return;
        }
      }
    }
    return true;
  })()`);
  try {
    ui = await cdp(`(async()=>{
      const api=window.__betterCodexInjection__,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const wait=async check=>{for(let i=0;i<70;i++){if(check())return;await sleep(100);}throw Error('installed view did not render');};
      const rect=element=>{if(!element)return null;const bounds=element.getBoundingClientRect(),style=getComputedStyle(element);return {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,display:style.display,visibility:style.visibility,hidden:element.hidden};};
      const visible=element=>{if(!element)return false;for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||node.inert||style.display==='none'||style.visibility==='hidden')return false;}const bounds=element.getBoundingClientRect();return bounds.width>0&&bounds.height>0;};
      const nativeLayout=()=>[...document.querySelectorAll('[data-better-codex-inline-content]')].find(visible);
      api.open('projects',{projectId:${JSON.stringify(project.id)}});
      await sleep(150);
      await wait(()=>{if(api.captureReloadState().nativeConversation?.adapterSnapshot?.project_id===${JSON.stringify(project.id)})return true;const button=document.querySelector('[data-project-dashboard-view="planning"]');if(button)button.click();return false;});
      await wait(()=>api.captureReloadState().nativeConversation?.adapterSnapshot?.project_id===${JSON.stringify(project.id)}&&!document.querySelector('.better-codex-inline-status')?.textContent);
      window.__bcAcceptanceNativeHost=window.__betterCodexNativeConversationHub__?.host;
      const inline=document.querySelector('#better-codex-native-conversation');
      if(inline.querySelector('.better-codex-inline-details').hidden)inline.querySelector('[data-inline-details]').click();
      const center=nativeLayout(),editor=center?.querySelector('.ProseMirror[contenteditable="true"]'),detail=inline.querySelector('.better-codex-inline-details');
      const columns=[rect(inline.querySelector('.bc-planning-projects')),rect(inline.querySelector('.bc-planning-conversations')),rect(center),rect(detail)];
      const editorBounds=rect(editor),compact=matchMedia('(max-width:980px)').matches;
      const planning={charter:!!inline.querySelector('[data-inline-stage="charter"],[data-planning-create="charter"]'),planning:!!inline.querySelector('[data-inline-stage="planning"],[data-planning-create="planning"]'),customChat:!!document.querySelector('[data-project-planning-form] textarea'),nativeComposer:visible(editor),nativeLayout:visible(center),details:!detail.hidden,shellVisible:visible(document.querySelector('#better-codex-panel')),columns,columnsVisible:columns.every(column=>column&&column.width>0&&column.height>0&&!column.hidden),ordered:columns.slice(0,compact?2:3).every((column,index)=>column.x+column.width<=columns[index+1].x+2),composerInThirdColumn:!!editorBounds&&editorBounds.x>=columns[2].x-2&&editorBounds.x+editorBounds.width<=columns[2].x+columns[2].width+2,nativeSidebarHidden:[...document.querySelectorAll('.app-shell-left-panel .sidebar-navigation')].every(sidebar=>!visible(sidebar)),compact};
      inline.querySelector('[data-inline-details]').click();
      planning.collapsed={hidden:detail.hidden,chatWidthBefore:columns[2].width,chatWidthAfter:rect(nativeLayout())?.width,snapshotDetailsOpen:api.captureReloadState().nativeConversation?.detailsOpen};
      window.__bcAcceptancePlanningView=api.captureReloadState();
      inline.querySelector('[data-inline-details]').click();
      api.open('agents');await sleep(350);await wait(()=>document.querySelector('#better-codex-panel [data-skill-key="better-codex-charter"]'));
      const panel=document.querySelector('#better-codex-panel');
      const keys=[...panel.querySelectorAll('[data-skill-key]')].map(row=>row.dataset.skillKey);
      for(const key of ['better-codex-develop','better-codex-test','better-codex-charter-review','better-codex-task-review'])if(!keys.includes(key))throw Error('installed Skill missing: '+key);
      const firstExternal=keys.findIndex(key=>key.startsWith('external:'));
      const managedFirst=keys.length>0&&!keys[0].startsWith('external:')&&(firstExternal<0||keys.slice(firstExternal).every(key=>key.startsWith('external:')));
      const external=panel.querySelector('[data-skill-key^="external:"]');
      let externalReadonly=false;
      if(external){external.click();await wait(()=>panel.querySelector('[data-skill-form]'));externalReadonly=!!panel.querySelector('[data-skill-form] textarea[readonly]')&&!panel.querySelector('[data-skill-form] button[type="submit"]');}
      const projectSkills={scopeFilter:!!panel.querySelector('[data-skill-scope-filter]'),projectOptions:panel.querySelectorAll('[data-skill-scope-filter] option[value^="project:"]').length,deriveButton:!!panel.querySelector('[data-skill-derive]')};
      for(let i=0;i<25&&!api.ready();i++)await sleep(100);
      return {ready:api.ready(),error:api.bootstrapError(),planning,managedFirst,externalReadonly,projectSkills,remoteEntry:!!document.querySelector('[data-help-view="remote"]'),modelControls:!!panel.querySelector('[name="model"],[name="reasoning_effort"],[name="sandbox_mode"]'),layout:{surface:panel.dataset.surface,panel:rect(panel),skills:rect(panel.querySelector('#better-codex-agents')),toolbar:!!panel.querySelector('.better-codex-toolbar button')}};
    })()`);
    if (process.argv.includes('--check-reload')) {
      await require('../integration/watcher.cjs').refresh();
      ui.reload = await cdp(`(async()=>{for(let i=0;i<70&&!window.__betterCodexInjection__?.ready?.();i++)await new Promise(resolve=>setTimeout(resolve,100));return {ready:window.__betterCodexInjection__?.ready?.(),error:window.__betterCodexInjection__?.bootstrapError?.(),surface:document.querySelector('#better-codex-panel')?.dataset.surface,externalReadonly:!!document.querySelector('[data-skill-form] textarea[readonly]')};})()`);
      assert.equal(ui.reload.ready,true,'ready after native injection refresh');
      assert.equal(ui.reload.error,null,'no reconnect error after refresh');
      assert.equal(ui.reload.surface,'agents','Skill view restored');
      assert.equal(ui.reload.externalReadonly,true,'external Skill detail restored');
      await cdp('(async()=>{window.__bcAcceptanceSkillView=window.__betterCodexInjection__.captureReloadState();await window.__betterCodexInjection__.restoreReloadState(window.__bcAcceptancePlanningView);return true;})()');
      await require('../integration/watcher.cjs').refresh();
      ui.planningReload=await cdp(`(async()=>{const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));for(let i=0;i<70;i++){const root=document.querySelector('#better-codex-native-conversation');if(window.__betterCodexInjection__?.ready?.()&&root&&!root.querySelector('.better-codex-inline-status')?.textContent)break;await sleep(100);}const api=window.__betterCodexInjection__,root=document.querySelector('#better-codex-native-conversation'),saved=window.__bcAcceptancePlanningView,current=api.captureReloadState(),panel=document.querySelector('#better-codex-panel');const result={ready:api.ready(),error:api.bootstrapError(),collapsed:!!root?.querySelector('.better-codex-inline-details')?.hidden,identityMatches:JSON.stringify(current.nativeConversation?.target)===JSON.stringify(saved.nativeConversation?.target),shellVisible:!!panel&&!panel.hidden&&panel.getBoundingClientRect().width>0,nativeComposerVisible:[...document.querySelectorAll('[data-better-codex-inline-content] .ProseMirror[contenteditable="true"]')].some(editor=>editor.getBoundingClientRect().width>0&&!editor.closest('[inert]'))};await api.restoreReloadState(window.__bcAcceptanceSkillView);return result;})()`);
      assert.equal(ui.planningReload.ready,true,'planning workspace ready after refresh');
      assert.equal(ui.planningReload.error,null,'planning workspace restore has no error');
      assert.equal(ui.planningReload.collapsed,true,'collapsed documents stay collapsed after reload');
      assert.equal(ui.planningReload.identityMatches,true,'conversation identity stays in the same project workspace');
      assert.equal(ui.planningReload.shellVisible,true,'Better Codex project shell remains visible after reload');
      assert.equal(ui.planningReload.nativeComposerVisible,true,'real native composer remains visible after reload');
    }
  } finally {
    await cdp('(async()=>{const saved=window.__bcAcceptanceSavedView,route=window.__bcAcceptanceNativeRoute,host=window.__bcAcceptanceNativeHost;delete window.__bcAcceptanceSavedView;delete window.__bcAcceptancePlanningView;delete window.__bcAcceptanceSkillView;delete window.__bcAcceptanceNativeRoute;delete window.__bcAcceptanceNativeHost;if(saved)await window.__betterCodexInjection__.restoreReloadState(saved);if(!saved?.open&&route&&host)host.dispatcher.dispatchHostMessage({type:"navigate-to-route",path:route});return true;})()');
  }
  assert.equal(ui.ready,true,'UI ready: '+JSON.stringify({error:ui.error,layout:ui.layout}));assert.equal(ui.error,null,'UI bootstrap');
  assert.equal(ui.planning.charter,true,'charter entry');assert.equal(ui.planning.planning,true,'planning entry');assert.equal(ui.planning.customChat,false,'custom chat removed');assert.equal(ui.planning.nativeComposer,true,'real native composer');assert.equal(ui.planning.nativeLayout,true,'native layout retained');assert.equal(ui.planning.details,true,'project documents beside native chat');
  assert.equal(ui.planning.shellVisible,true,'project page shell remains visible');assert.equal(ui.planning.columnsVisible,true,'all four columns are visible');assert.equal(ui.planning.ordered,true,'project, planning conversation, native chat and documents have ordered boundaries');assert.equal(ui.planning.composerInThirdColumn,true,'real composer is contained in the third column');assert.equal(ui.planning.nativeSidebarHidden,true,'unrelated global native chat list is hidden');assert.equal(ui.planning.collapsed.hidden,true,'documents can be collapsed');assert.ok(ui.planning.collapsed.chatWidthAfter>=ui.planning.collapsed.chatWidthBefore,'collapsing documents never narrows native chat');
  assert.equal(ui.managedFirst,true,'managed Skills first');assert.equal(ui.externalReadonly,true,'external Skills read only');assert.equal(ui.remoteEntry,false,'remote entry removed');assert.equal(ui.modelControls,false,'model controls removed');
  assert.equal(ui.projectSkills.scopeFilter,true,'project Skill scope filter visible');assert.ok(ui.projectSkills.projectOptions>0,'project Skill ownership options present');assert.equal(ui.projectSkills.deriveButton,true,'external Skill can be copied into a project');
  const status = await lib.api('/api/dev/status'), ready = await lib.api('/readyz'), hashes = lib.hashes();
  assert.equal(lib.state().sourceHash,hashes.sourceHash);assert.equal(status.revision,hashes.backendHash);assert.equal(ready.session_host.connected,true);
  const report = {at:new Date().toISOString(),sourceRevision:hashes.sourceHash,applied:true,runtimeReady:ready.ok,nativeSessionConnected:ready.session_host.connected,mcp,skills,ui,realConversationValidated:false};
  lib.save(path.join(lib.DEV,'native-planning-acceptance.json'),report);
  console.log(JSON.stringify(report));
}
module.exports = { nativeRequest };
if (require.main === module) main().catch(error=>{console.error(error.message);process.exitCode=1;});

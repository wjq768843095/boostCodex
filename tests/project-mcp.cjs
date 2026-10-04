'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {tools,call} = require('../src/modules/project-mcp.cjs');
const {createFixture} = require('./native-project-runtime.cjs');

// Check actual arguments against the published declaration as an MCP client
// does. The HTTP adapter and the declaration must expose the same vocabulary.
function checkSchema(value,schema,at='arguments') {
  if (!schema) throw Error('schema_missing_'+at);
  if (schema.anyOf) {
    assert.ok(schema.anyOf.some(entry=>{try{checkSchema(value,entry,at);return true;}catch{return false;}}),at+' anyOf');
    return;
  }
  const types = Array.isArray(schema.type)?schema.type:[schema.type];
  const type = Array.isArray(value)?'array':value===null?'null':typeof value;
  assert.ok(types.includes(type)||types.includes('integer')&&type==='number'&&Number.isInteger(value),at+' type');
  if (schema.enum) assert.ok(schema.enum.includes(value),at+' enum');
  if (type==='object') {
    for (const field of schema.required||[]) assert.ok(Object.hasOwn(value,field),at+'.'+field+' required');
    for (const [field,entry] of Object.entries(value)) {
      if (schema.properties?.[field]) checkSchema(entry,schema.properties[field],at+'.'+field);
      else assert.notEqual(schema.additionalProperties,false,at+'.'+field+' additional');
    }
  }
  if (type==='array') {
    if (schema.minItems!==undefined) assert.ok(value.length>=schema.minItems,at+' minItems');
    for (const [index,entry] of value.entries()) checkSchema(entry,schema.items,at+'['+index+']');
  }
  if (schema.minimum!==undefined) assert.ok(value>=schema.minimum,at+' minimum');
}

async function run() {
  const f = createFixture();
  const requests = [];
  try {
    fs.mkdirSync(path.join(f.home,'run'),{recursive:true});
    fs.writeFileSync(path.join(f.home,'run','runtime.json'),JSON.stringify({port:45123}));
    fs.writeFileSync(path.join(f.home,'run','token'),'fixture-token\n');
    const mockFetch = async (url,options) => {
      requests.push({url,options});
      assert.equal(new URL(url).origin,'http://127.0.0.1:45123');
      assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer fixture-token');
      assert.equal(options.headers['Content-Type'],'application/json');assert.ok(options.signal instanceof AbortSignal);
      try {
        const {value,status} = await f.api(new URL(url).pathname,'POST',JSON.parse(options.body));
        return {ok:status<400,json:async()=>JSON.parse(JSON.stringify(value))};
      } catch(error) {return {ok:false,json:async()=>({error:error.message})};}
    };
    const invoke = async(name,args)=>{
      const declaration = tools.find(tool=>tool.name===name);
      checkSchema(args,declaration.inputSchema);
      const result = await call(name,args,{home:f.home,fetch:mockFetch});
      assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
      return result.structuredContent;
    };
    assert.deepEqual(tools.map(tool=>tool.name),['project_context_read','project_charter_save','project_charter_confirm','project_plan_save','project_plan_convert']);
    assert.equal(tools[0].annotations.readOnlyHint,true);
    assert.ok(tools.slice(1).every(tool=>tool.inputSchema.required.includes('thread_id')&&tool.inputSchema.required.includes('expected_revision')));
    for (const [projectId,sessionKind,threadId] of [['p1','charter','charter-1'],['p1','planning','plan-1'],['p2','charter','charter-2']]) {
      f.runtime.planning.bindSession({project_id:projectId,kind:sessionKind,thread_id:threadId,expected_revision:0});
    }
    const initial = await invoke('project_context_read',{project_id:'p1',thread_id:'charter-1'});
    assert.equal(initial.charter,null);assert.deepEqual(initial.project.root_paths,f.roots);
    await assert.rejects(invoke('project_context_read',{project_id:'p1',thread_id:'charter-2'}),/session_thread_mismatch/);
    const charterInput = f.charterArgs('p1','charter-1');
    const savedCharter = await invoke('project_charter_save',charterInput);
    assert.deepEqual(savedCharter.metadata,charterInput.metadata);assert.deepEqual(savedCharter.facts,charterInput.facts);
    await assert.rejects(invoke('project_charter_save',f.charterArgs('p1','charter-2',{expected_revision:1})),/session_thread_mismatch/);
    await assert.rejects(invoke('project_charter_confirm',{project_id:'p1',thread_id:'charter-1',expected_revision:1,message_id:'fake-user'}),/explicit_user_confirmation_required/);
    f.userMessage('charter-1','user-accept','确认总纲');
    const evidence = await invoke('project_context_read',{project_id:'p1',thread_id:'charter-1',section_ids:['api']});
    assert.equal(evidence.charter.sections.length,1);assert.equal(evidence.charter.sections[0].id,'api');
    assert.equal(evidence.charter.status,'confirmed');
    assert.equal(evidence.charter.confirmation_message_id,'user-accept');
    await invoke('project_charter_confirm',{project_id:'p1',thread_id:'charter-1',expected_revision:1,message_id:'user-accept'});
    const confirmedContext = await invoke('project_context_read',{project_id:'p1',thread_id:'plan-1'});
    assert.equal(confirmedContext.workspaces[0].role,'Web前端');
    assert.equal(confirmedContext.workspaces[0].source_of_truth,'本地源码');
    assert.deepEqual(confirmedContext.charter.facts,charterInput.facts);
    assert.deepEqual(confirmedContext.root_paths,f.roots);
    assert.equal(confirmedContext.workspaces.some(workspace=>workspace.path===path.dirname(f.externalPath)),false);
    const saved = await invoke('project_plan_save',{project_id:'p1',thread_id:'plan-1',expected_revision:0,charter_revision:2,items:[f.item()]});
    assert.deepEqual(saved.items[0].directories,f.roots.slice(0,2));
    assert.deepEqual(saved.items[0].contract_refs,['api']);assert.equal(saved.items[0].contract_owner,'共享接口');
    assert.deepEqual(saved.items[0].unresolved_questions,[]);
    const converted = await invoke('project_plan_convert',{project_id:'p1',thread_id:'plan-1',expected_revision:1,item_ids:['deliver-login']});
    assert.equal(converted.issues[0].status,'backlog');assert.equal(converted.issues[0].thread_id,null);
    const replayed = await invoke('project_plan_convert',{project_id:'p1',thread_id:'plan-1',expected_revision:1,item_ids:['deliver-login']});
    assert.equal(replayed.issues[0].id,converted.issues[0].id);assert.equal(f.state.create,1);
    await invoke('project_plan_save',{project_id:'p1',thread_id:'plan-1',expected_revision:1,charter_revision:2,items:[f.item({title:'修订登录闭环'})]});
    const unchanged = await invoke('project_plan_convert',{project_id:'p1',thread_id:'plan-1',expected_revision:2,item_ids:['deliver-login']});
    assert.equal(unchanged.issues[0].title,'登录闭环');assert.equal(f.state.update,0);
    const issueId = converted.issues[0].id;
    f.store.db.prepare("UPDATE issues SET status='done' WHERE id=?").run(issueId);
    const updated = await invoke('project_plan_convert',{project_id:'p1',thread_id:'plan-1',expected_revision:2,item_ids:['deliver-login'],action:'update',issue_versions:{'deliver-login':1}});
    assert.equal(updated.issues[0].title,'修订登录闭环');assert.equal(updated.issues[0].status,'done');
    assert.equal(updated.issues[0].history,'existing history');assert.equal(f.state.update,1);
    f.store.db.prepare('UPDATE issues SET thread_id=? WHERE id=?').run('mcp-work-p1',issueId);
    await invoke('project_charter_save',f.charterArgs('p1','charter-1',{expected_revision:2,
      metadata:{workspace_map:[{path:f.roots[0],role:'新草稿职责',source_of_truth:'待确认来源'}]}}));
    const workContext = await invoke('project_context_read',{project_id:'p1',thread_id:'mcp-work-p1'});
    assert.equal(workContext.charter.revision,2);assert.equal(workContext.charter.status,'confirmed');
    assert.equal(workContext.workspaces[0].role,'Web前端');assert.equal(workContext.workspaces[0].source_of_truth,'本地源码');
    assert.deepEqual(workContext.charter.facts,charterInput.facts);assert.deepEqual(workContext.root_paths,f.roots);
    assert.equal(f.state.dispatch,0);assert.equal(f.state.wake,0);
    await assert.rejects(invoke('project_plan_save',{project_id:'p1',thread_id:'plan-1',expected_revision:0,charter_revision:2,items:[f.item()]}),/version_conflict/);
    const historical = await invoke('project_context_read',{project_id:'p1',thread_id:'plan-1',revision:2,section_ids:['api']});
    assert.equal(historical.charter.revision,2);assert.equal(historical.charter.sections[0].content,'旧确认接口契约');
    const beforeInvalid = requests.length;
    await assert.rejects(call('missing',{}, {home:f.home,fetch:mockFetch}),/tool_not_found/);
    await assert.rejects(call('project_charter_save',{project_id:'p1'}, {home:f.home,fetch:mockFetch}),/missing_thread_id/);
    await assert.rejects(call('project_context_read',{project_id:'p1',model:'forbidden'}, {home:f.home,fetch:mockFetch}),/invalid_argument_model/);
    assert.equal(requests.length,beforeInvalid);
    await assert.rejects(call('project_context_read',{project_id:'p1'},{home:f.home,fetch:async()=>({ok:false,json:async()=>({error:'fixture_http_error'})})}),/fixture_http_error/);
    console.log('PASS: project MCP schemas, mock HTTP adapter, bound thread isolation, native confirmation evidence and safe backlog conversion');
  } finally {f.cleanup();}
}

if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports = {run};

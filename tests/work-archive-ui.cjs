'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/ui/better-codex-ui.js'),'utf8');
function readFunction(name) {
  const match=new RegExp(`^( *)(?:async )?function ${name}\\(`,'m').exec(source);assert(match);
  const tail=source.slice(match.index+match[0].length),next=new RegExp(`^${match[1]}(?:async )?function [a-zA-Z]`,'m').exec(tail);assert(next);
  return source.slice(match.index,match.index+match[0].length+next.index);
}
let current,rows,requests,opened,rendered,saved,failed,navigate;
const first={project_id:'p',issue_id:'i',kind:'work',conversation_id:'one',conversation_title:'误建会话',thread_id:'native-one',revision:2,version:3};
const second={...first,conversation_id:'two',thread_id:'native-two',selected:true};
const ctx=vm.createContext({state:{},inlineConversation:{},inlineConversationNavigationRequest:1,destroyed:false,
  inlineConversationKey:()=>current.conversation_id,inlineConversationTarget:()=>current,
  readProjectView:()=>({target:{conversation_id:'one'},work_target:{conversation_id:'one'}}),
  localStorage:{setItem:(_key,value)=>saved=JSON.parse(value)},
  api:async(url,options)=>{requests.push({url,...JSON.parse(options.body)});if(failed)throw Error('offline');if(navigate)current={project_id:'other',conversation_id:'other'};},
  loadProjectWorkConversations:async()=>rows,registerInlineConversationBindings(){},renderInlineConversation:()=>rendered++,
  openIssueNativeConversation:async(...args)=>opened.push(args),openInlineConversation:async value=>opened.push(value),leaveInlineConversation(){},openRoute:(...args)=>opened.push(args),
  issueExecutionRunning:row=>Boolean(row.active_run_status),inlineWorkStateLabel:()=>'',te:value=>value,t:value=>value,escapeHtml2:value=>String(value).replaceAll('"','&quot;'),icon:name=>`<i>${name}</i>`
});
for(const name of ['deleteWorkNativeConversation','workConversationListMarkup'])vm.runInContext(readFunction(name),ctx);
function reset() {
  current={project_id:'p',kind:'work',issue_id:'i',conversation_id:'one'};rows=[second];requests=[];opened=[];rendered=0;saved=null;failed=false;navigate=false;
  ctx.state.nativeWorkConversations={p:[first,second]};ctx.state.nativeWorkSelections={p:{conversation_id:'one'}};ctx.state.nativeThreadLinks={'native-one':first,'native-two':second};
}
(async()=>{
  reset();const markup=ctx.workConversationListMarkup();assert.equal((markup.match(/data-work-delete=/g)||[]).length,2);assert(markup.includes('bc-planning-conversation-item'));
  ctx.state.nativeWorkConversations.p=[{...first,task_execution_running:true}];assert(/data-work-delete=[^>]+disabled/.test(ctx.workConversationListMarkup()));
  reset();await ctx.deleteWorkNativeConversation('p','one');assert.equal(requests[0].expected_revision,2);assert.equal(requests[0].expected_issue_version,3);assert.equal(requests[0].kind,'work');assert.equal(opened[0][1],'two');assert(!ctx.state.nativeThreadLinks['native-one']);assert(ctx.state.nativeThreadLinks['native-two']);assert(!saved.target);assert(!saved.work_target);
  reset();current.conversation_id='two';await ctx.deleteWorkNativeConversation('p','one');assert.equal(opened.length,0);assert.equal(rendered,1);
  reset();rows=[];await ctx.deleteWorkNativeConversation('p','one');assert.equal(opened[0][0],'projects');assert.equal(opened[0][1].projectId,'p');assert.equal(ctx.state.projectPage,'work');
  reset();failed=true;await assert.rejects(ctx.deleteWorkNativeConversation('p','one'),/offline/);assert.equal(opened.length,0);assert(ctx.state.nativeThreadLinks['native-one']);assert.equal(saved,null);
  reset();navigate=true;await ctx.deleteWorkNativeConversation('p','one');assert.equal(opened.length,0,'late removal response preserves user navigation');
  console.log('PASS: work removal UI exposes independent buttons, locks running rows, selects remaining chats, preserves failures and navigation, and returns empty projects to the board');
})().catch(error=>{console.error(error);process.exitCode=1;});

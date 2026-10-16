'use strict';
// Model-free isolated browser fixture. No native session data is served.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const page = `<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><title>子代理浮窗验收</title>
<style>body{margin:0;background:#202020;color:#eee;font:14px system-ui}aside{position:fixed;inset:0 auto 0 0;width:220px;background:#171717;padding:16px;box-sizing:border-box}main{position:absolute;left:220px;right:0;top:40px;bottom:0;background:inherit}header{padding:12px;border-bottom:1px solid #7773}.message{margin:440px 28px 0;max-width:600px;color:#999}.composer{position:absolute;bottom:24px;left:24px;right:24px;padding:20px;border:1px solid #7775;border-radius:16px}button{margin:6px;padding:7px 10px;cursor:pointer}body.light{background:#fafafa;color:#252525}body.light aside{background:#eee}</style>
<aside>聊天列表<p>当前会话</p><button id="switch">切换空会话</button><button id="obstruction">切换遮挡场景</button><button id="complete">完成任务</button><button id="resume">再次执行</button><button id="theme">切换主题</button><button id="narrow">窄窗口布局</button><button id="reinject">重新注入</button><button id="failure">模拟读取失败</button><button id="many">增加多条代理</button><button id="add">增加最新代理</button></aside>
<main class="app-shell-main-content-frame"><header>当前会话</header><div class="message" data-thread-find-target="conversation">正在检查执行结果。子代理浮窗只展示当前会话关联的执行状态。</div><div class="composer" data-composer-surface-variant="default"><div data-codex-composer="true" contenteditable="true">输入消息</div></div></main>
<script src="/monitor.js"></script><script>
let id='11111111-1111-1111-1111-111111111111', empty=false,fail=false;
const stamp=Date.now();
const agents=[{id:'a',parentId:id,depth:1,title:'核对模型配置',name:'核对模型配置与执行契约，检查全部边界及错误处理',nickname:'Fermat',model:'gpt-6.1-sol',effort:'high',status:'running',elapsedMs:12000,runningSince:stamp-23000,startedAt:stamp-35000},{id:'b',parentId:'a',depth:2,title:'检查接口',name:'检查接口兼容性',nickname:'Turing',model:'gpt-6-astra',effort:'high',status:'completed',elapsedMs:48000,runningSince:null,startedAt:stamp-60000},{id:'c',parentId:id,depth:1,title:'核对界面',name:'核对界面交互',nickname:'Ohm',model:null,effort:null,status:'interrupted',elapsedMs:17000,runningSince:null,startedAt:stamp-50000}];
function install(){window.boostCodexSubagentMonitor.create({getThreadId:()=>id,api:async(route)=>{if(fail)throw Error('fixture');if(route.startsWith('/api/dev/subagents/work?')){const agentId=new URL(route,'http://fixture').searchParams.get('agentId'),agent=agents.find(a=>a.id===agentId);return {threadId:id,agentId,title:agentId==='a'?'核对模型配置':'检查接口',task:agentId==='a'?'核对模型配置与执行契约。检查接口参数、权限边界以及错误处理，并报告发现的问题。':'检查接口兼容性与返回结果，记录需要调整的差异。',progress:agent.status==='running'?'正在核对接口返回字段，已完成权限与参数检查。':'接口和返回字段已核对完成。',result:agent.status==='completed'?'检查完成：现有接口字段兼容，权限范围与预期一致。':'',updatedAt:Date.now(),syncing:false,truncated:false}}return {threadId:id,agents:empty?[]:structuredClone(agents),observedAt:Date.now()}}})}install();
document.getElementById('switch').onclick=()=>{empty=!empty;id=empty?'22222222-2222-2222-2222-222222222222':'11111111-1111-1111-1111-111111111111';window.__boostCodexSubagentMonitor__.sync()};
document.getElementById('complete').onclick=()=>{agents[0].elapsedMs+=Date.now()-agents[0].runningSince;agents[0].runningSince=null;agents[0].status='completed'};
document.getElementById('resume').onclick=()=>{if(agents[0].status!=='running'){agents[0].runningSince=Date.now();agents[0].status='running'}};
document.getElementById('theme').onclick=()=>{document.body.classList.toggle('light');document.documentElement.dataset.theme=document.body.classList.contains('light')?'light':'dark'};
document.getElementById('narrow').onclick=()=>{const m=document.querySelector('main');m.style.width=m.style.width?'':'310px'};
document.getElementById('reinject').onclick=install;
document.getElementById('failure').onclick=()=>{fail=!fail};
document.getElementById('obstruction').onclick=()=>{const m=document.querySelector('.message');m.style.marginTop=m.style.marginTop?'':'20px';window.__boostCodexSubagentMonitor__.sync()};
function addAgent(){agents.push({id:'agent-'+agents.length,parentId:id,depth:1,title:'核对执行结果',name:'fixture-agent',nickname:'模拟代理',model:'gpt-6.1-sol',effort:'high',status:'running',elapsedMs:0,runningSince:Date.now(),startedAt:Date.now()})}
document.getElementById('many').onclick=()=>{for(let i=0;i<10;i++)addAgent()};document.getElementById('add').onclick=addAgent;
</script></html>`;
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/monitor.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return response.end(fs.readFileSync(path.join(__dirname, '../src/ui/subagent-monitor.js'))); }
  response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(page);
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
process.stdin.resume(); process.stdin.on('data', () => server.close(() => process.exit()));

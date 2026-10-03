'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-native-backend-'));
const home = path.join(folder, 'better'), user = path.join(folder, 'user'), codex = path.join(user, '.codex'), workspace = path.join(folder, '中文 项目');
for (const entry of [home, user, codex, workspace]) fs.mkdirSync(entry, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'isolated', dependencies: { react: '^18.2.0' } }));
const env = { ...process.env, BETTER_CODEX_HOME: home, BETTER_CODEX_SKILLS_USER_HOME: user, CODEX_HOME: codex, USERPROFILE: user, HOME: user, NODE_TEST_CONTEXT: 'native-backend-fixture' };
delete env.BETTER_CODEX_LOCAL_PROJECT;
delete env.BC_RUNTIME_API;
let output = '', child, token, port;
const wait = async check => { for (let i = 0; i < 150; i++) { if (check()) return; if (child?.exitCode !== null) throw Error('isolated runtime exited: ' + output.slice(-1500)); await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('isolated runtime timeout: ' + output.slice(-1500)); };
async function api(route, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:' + port + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, value: await response.json() };
}
async function main() {
  child = cp.spawn(process.execPath, [path.join(__dirname, '../src/backend/better-codex.cjs'), 'runtime'], { env, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const state = path.join(home, 'run/runtime.json');
  await wait(() => fs.existsSync(state));
  const runtime = JSON.parse(fs.readFileSync(state, 'utf8')); port = runtime.port;
  token = fs.readFileSync(path.join(home, 'run/token'), 'utf8').trim();
  assert.equal((await api('/health')).status, 200);
  const initial = await api('/api/projects'); assert.equal(initial.status, 200); assert.equal(initial.value.length, 1, 'only the built-in inbox should exist'); assert.equal(initial.value[0].external_id,'inbox'); assert.equal(initial.value[0].workspace_path,workspace);
  for (const route of ['/web', '/web/session', '/web/injection.js', '/api/relay/status', '/api/remote-access/status', '/api/sync/status']) assert.equal((await api(route)).status, 404, route);
  const relay = await fetch('http://127.0.0.1:' + port + '/api/projects', { headers: { Authorization: 'Bearer ' + token, 'x-better-codex-relay': '1' } }); assert([403,404].includes(relay.status), 'relay headers must be rejected');
  const created = await api('/api/projects', 'POST', { name: '隔离项目', workspace_path: workspace });
  assert.equal(created.status, 201, JSON.stringify(created.value)); const project = created.value.project || created.value;
  const groups = await api('/api/skills'); assert.equal(groups.status, 200); assert(groups.value.managed.some(skill => skill.id === 'better-codex-charter'));
  assert(groups.value.managed.every(skill => skill.path.startsWith(user)), 'fixture exports must stay in temporary user home');
  const context = await api('/api/projects/' + project.id + '/planning-context'); assert.equal(context.status, 200); assert(context.value.stack_facts.some(fact => fact.name === 'react'));
  const premature = await api('/api/projects/' + project.id + '/native-session', 'POST', { kind: 'planning', request_id: randomUUID() }); assert([400,409].includes(premature.status)); assert.equal(premature.value.error,'confirmed_charter_required');
  const opened = await api('/api/projects/' + project.id + '/native-session', 'POST', { kind: 'charter', request_id: randomUUID() }); assert.equal(opened.status, 202, JSON.stringify(opened.value));
  assert.equal(opened.value.command,null); assert.equal(opened.value.session,null); assert.equal(opened.value.mode,'draft'); assert.equal(Object.hasOwn(opened.value,'prompt'),false);
  const relayId = randomUUID(), pollBody = { relay_id: relayId, app_session_id: 'isolated-fixture', owner: 'native', capability: 'ready' };
  let poll = await api('/api/session-relay/poll', 'POST', pollBody); assert.equal(poll.status, 200);
  assert.equal(poll.value.command,null,'opening must not queue native model requests');
  const prepareArgs = {project_id:project.id,kind:'charter',relay_id:relayId,host_id:'local',request_id:randomUUID(),expected_revision:0};
  const prepared = await api('/api/native-conversations/prepare','POST',prepareArgs); assert.equal(prepared.status,200,JSON.stringify(prepared.value));
  assert.equal(prepared.value.operation.status,'prepared'); assert.equal(prepared.value.dynamic_tools.length,5);
  assert.equal((await api('/api/session-relay/poll','POST',pollBody)).value.command,null,'inline operations are not consumed by the queue');
  const threadId = randomUUID();
  assert.equal((await api('/api/native-conversations/bind','POST',{...prepareArgs,thread_id:threadId,checkpoint:'allocated'})).status,200);
  assert.equal((await api('/api/native-conversations/bind','POST',{...prepareArgs,thread_id:threadId,checkpoint:'bound'})).status,200);
  const turnId = randomUUID();
  assert.equal((await api('/api/native-conversations/receipt','POST',{...prepareArgs,thread_id:threadId,turn_id:turnId,status:'accepted'})).status,200);
  assert.equal((await api('/api/session-relay/events','POST',{relay_id:relayId,method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}})).status,200);
  const nativeContext = await api('/api/native-conversations/tool','POST',{relay_id:relayId,host_id:'local',thread_id:threadId,call_id:randomUUID(),name:'better_codex_project_context_read',arguments:{}});
  assert.equal(nativeContext.status,200,JSON.stringify(nativeContext.value));assert.equal(nativeContext.value.project.id,project.id);
  const draft = await api('/api/project-tools/project_charter_save', 'POST', { project_id: project.id, thread_id: threadId, expected_revision: 0, sections: [{ id: 'architecture', title: '架构', content: '共享接口由基础能力负责。' }], requirements: [{ id: 'REQ-1', content: '验收闭环' }] }); assert.equal(draft.status, 200, JSON.stringify(draft.value));
  const eventId = randomUUID();
  const event = await api('/api/session-relay/events', 'POST', { relay_id: relayId, method: 'item/completed', params: { threadId, item: { type: 'userMessage', id: eventId, content: [{ type: 'text', text: '确认总纲' }] } } }); assert.equal(event.status, 200, JSON.stringify(event.value));
  const confirmed = await api('/api/project-tools/project_charter_confirm', 'POST', { project_id: project.id, thread_id: threadId, expected_revision: draft.value.revision, message_id: eventId }); assert.equal(confirmed.status, 200); assert.equal(confirmed.value.status, 'confirmed');
  const issue = await api('/api/issues', 'POST', { project_id: project.id, title: '隔离工作任务', description: 'Fixture only; never execute a model request.', status: 'backlog', agent_enabled: true, ai_enrich: false, skill_id: 'better-codex-charter' }); assert.equal(issue.status, 201, JSON.stringify(issue.value));
  const start = await api('/api/issues/' + issue.value.id + '/start', 'POST', { version: issue.value.version, status: 'todo', skill_id: 'better-codex-charter' }); assert.equal(start.status, 202, JSON.stringify(start.value));
  await new Promise(resolve => setTimeout(resolve, 200));
  poll = await api('/api/session-relay/poll', 'POST', pollBody); assert.equal(poll.status, 200); assert.equal(poll.value.command?.issue_id, issue.value.id);
  assert.equal(poll.value.command.payload.native_defaults, true); assert(poll.value.command.payload.input.some(item => item.type === 'skill'));
  // The native proxy only claims this fixture command; no app-server request is issued.
  const dbFile = (await api('/health')).value.database?.path || fs.readdirSync(home).map(name => path.join(home, name)).find(name => /\.sqlite$|\.db$/.test(name));
  if (dbFile) { const db = new DatabaseSync(dbFile, { readOnly: true }); try { assert.equal(db.prepare('SELECT owner FROM issue_native_ownership WHERE issue_id=?').get(issue.value.id).owner, 'native'); } finally { db.close(); } }
  assert.equal((await api('/api/agents', 'POST', {})).status, 404);
  assert(!/codex_exec|planning_process_started|scheduler_started/.test(output), 'no model process may be started by the fixture');
  console.log('PASS: isolated real backend routes, read-only opening, first-send checkpoints, trusted native tools, confirmation events and explicit native-owned work queue without model execution');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child?.exitCode === null && port && token) await api('/api/shutdown', 'POST', {}).catch(() => {});
  if (child?.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 4000))]); if (child.exitCode === null) child.kill(); }
  const resolved = path.resolve(folder); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith('bc-native-backend-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});

'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process'), http = require('node:http');
const manager = require('../integration/workflow-service.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workflow-http-')), home = path.join(temp, 'home'), projectRoot = path.join(temp, 'project'), root = path.resolve(__dirname, '..');
fs.mkdirSync(home); fs.mkdirSync(projectRoot); fs.writeFileSync(path.join(projectRoot, 'app.js'), 'const fixture = 1;\n'); const sentinel = Buffer.from('old database untouched'); fs.writeFileSync(path.join(home, 'better-codex.db'), sentinel);
let port, cookie, csrf, streamReader, child, servicePid;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function human(op, input, revision, options = {}) { const response = await fetch('http://127.0.0.1:' + port + '/api/workflow/v1/actions/' + op, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://127.0.0.1:' + port, 'X-Workflow-CSRF': csrf, 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify({ ...input, requestId: options.requestId || crypto.randomUUID(), ...(revision === undefined ? {} : { expectedRevision: revision }) }) }); return { status: response.status, value: await response.json() }; }
async function state() { return (await fetch('http://127.0.0.1:' + port + '/api/workflow/v1/state', { headers: { Cookie: cookie } })).json(); }
async function agent(op, input) { return manager.agentRequest(op, input, { home, root, client: 'codex' }); }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopped() { for (let i = 0; i < 100 && alive(servicePid); i++) await sleep(50); assert(!alive(servicePid), 'owned fixture service exits before cleanup'); }
(async () => {
  const ready = await manager.ensureStarted({ home, root }); port = ready.port; servicePid = ready.pid;
  assert.equal(ready.ready, true); assert.equal((await manager.ensureStarted({ home, root })).instanceId, ready.instanceId, 'single service instance');
  const base = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(base + '/api/workflow/v1/state')).status, 401);
  assert.equal((await fetch(base + '/health', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const hostileHost = await new Promise((resolve, reject) => { const request = http.get(base + '/health', { headers: { Host: 'attacker.example:' + port } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); }); assert.equal(hostileHost, 403);
  const launch = await manager.panelUrl({ home, root }); assert.equal(launch.stableUrl, base + '/');
  const opened = await fetch(launch.url, { redirect: 'manual' }); assert.equal(opened.status, 302); assert.equal(opened.headers.get('location'), '/'); cookie = opened.headers.get('set-cookie').split(';')[0]; assert(opened.headers.get('set-cookie').includes('HttpOnly')); assert(opened.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.equal((await fetch(launch.url, { redirect: 'manual' })).status, 401, 'launch tickets are single-use');
  const session = await (await fetch(base + '/api/workflow/v1/session', { headers: { Cookie: cookie } })).json(); csrf = session.csrf;
  const page = await fetch(base + '/'); assert.equal(page.status, 200); assert((await page.text()).includes('面板')); assert(!page.headers.get('content-security-policy').includes('unsafe-inline'));
  const js = await fetch(base + '/app.js'); assert.equal(js.status, 200); assert(!(await js.text()).includes(fs.readFileSync(manager.paths(home).agent, 'utf8').trim()));
  assert.equal((await human('project.create', { name: '隔离项目', root: projectRoot }, undefined, { headers: { 'X-Workflow-CSRF': 'incorrect' } })).status, 403);
  const project = (await human('project.create', { name: '隔离项目', root: projectRoot })).value.project;
  assert.equal(project.ref, 'P001');
  await assert.rejects(agent('charter.confirm', { taskRef: 'P001-T001', requestId: crypto.randomUUID(), expectedRevision: 1, version: 1 }), error => error.status === 403);
  const charter = (await human('charter.create', { projectRef: project.ref }, project.revision)).value;
  const saved = await human('charter.save', { taskRef: charter.task.ref, content: '实现一个项目内的功能，并进行验收。' }, charter.task.revision); assert.equal(saved.status, 200);
  const submitted = (await human('charter.submit', { taskRef: charter.task.ref }, saved.value.task.revision)).value;
  const confirmed = (await human('charter.confirm', { taskRef: charter.task.ref, version: 1 }, submitted.task.revision)).value;
  const task = (await human('task.create', { projectRef: project.ref, title: '隔离开发任务', requirements: '修改页面', acceptance: '检查完成', scopePaths: [] }, confirmed.project.revision)).value.task;
  const lease = await agent('task.claim', { taskRef: task.ref, phase: 'develop', requestId: crypto.randomUUID(), expectedRevision: task.revision });
  const publicState = await state(); assert(!JSON.stringify(publicState).includes(lease.leaseToken)); assert(!JSON.stringify(publicState).includes('tokenHash'));
  await assert.rejects(manager.agentRequest('task.renew', { taskRef: task.ref, executionId: lease.executionId, leaseToken: lease.leaseToken, requestId: crypto.randomUUID(), expectedRevision: lease.task.revision }, { home, root, client: 'claude' }), error => error.code === 'execution_lease_invalid');
  const revoked = await human('task.revoke', { taskRef: task.ref }, lease.task.revision); assert.equal(revoked.status, 200);
  await assert.rejects(agent('task.submit', { taskRef: task.ref, executionId: lease.executionId, leaseToken: lease.leaseToken, summary: '旧执行不能提交', evidence: [{ kind: 'source', result: 'passed', detail: 'isolated' }], requestId: crypto.randomUUID(), expectedRevision: revoked.value.task.revision }), error => error.code === 'execution_lease_invalid');
  const cursor = (await state()).cursor;
  const sse = await fetch(base + '/api/workflow/v1/events?cursor=' + cursor, { headers: { Cookie: cookie } }); assert.equal(sse.headers.get('content-type'), 'text/event-stream'); streamReader = sse.body.getReader(); await streamReader.read();
  const pending = streamReader.read();
  const issue = await human('issue.create', { projectRef: project.ref, title: '实时问题', description: '检查实时更新' }, (await state()).projects[0].revision); assert.equal(issue.status, 200);
  const update = await Promise.race([pending, sleep(3000).then(() => { throw Error('SSE event timeout'); })]); assert(Buffer.from(update.value).toString().includes('event: change'));
  await streamReader.cancel(); streamReader = null;
  await manager.controlRequest('stop', {}, home); await stopped();
  const restarted = await manager.ensureStarted({ home, root }); servicePid = restarted.pid; assert.equal(restarted.port, port); assert.notEqual(restarted.instanceId, ready.instanceId); assert.equal((await state()).projects[0].ref, project.ref, 'persisted cookie and data work across restart');
  assert(fs.readFileSync(path.join(home, 'better-codex.db')).equals(sentinel));
  await manager.controlRequest('stop', {}, home); await stopped();
  // Native clients discover stdio tools without opening any workflow database.
  const discoveryHome = path.join(temp, 'discovery'); fs.mkdirSync(discoveryHome);
  child = cp.spawn(process.execPath, [path.join(root, 'integration/workflow-service.cjs'), 'mcp', '--client', 'codex'], { windowsHide: true, env: { ...process.env, BETTER_CODEX_HOME: discoveryHome, BETTER_CODEX_LOCAL_PROJECT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isolated', version: '1' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  for (let i = 0; i < 60 && !output.includes('bc_context'); i++) await sleep(50);
  assert(output.includes('bc_context'), errors || 'real stable launcher discovers MCP tools'); assert(!fs.existsSync(path.join(discoveryHome, 'workflow-v1.db'))); assert(!fs.existsSync(path.join(discoveryHome, 'run/workflow-runtime.json')));
  child.stdin.end(); for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(50); assert.equal(child.exitCode, 0);
  console.log('PASS: independent workflow HTTP auth/CSRF/roles, real API leases, SSE, restart persistence, historical sentinel, stable stdio launcher without database side effects');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await streamReader?.cancel(); } catch {} if (child?.exitCode === null) { child.kill(); for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(50); } try { if (alive(servicePid)) { await manager.controlRequest('stop', {}, home); await stopped(); } } catch {} const resolved = path.resolve(temp); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('bc-workflow-http-')); if (!alive(servicePid)) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

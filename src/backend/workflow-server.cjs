'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const { WorkflowStore } = require('../modules/workflow-store.cjs');
const ALLOWED_AGENT = new Set(['context', 'project.list', 'charter.create', 'charter.save', 'charter.submit', 'plan.tasks', 'task.claim', 'task.renew', 'task.submit', 'task.review', 'batch.start', 'batch.report', 'issue.create', 'issue.repair']);
function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function atomic(file, value) { const temp = file + '.tmp-' + crypto.randomUUID(); fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function authorized(request, token) { const value = String(request.headers.authorization || '').replace(/^Bearer /, ''); return Buffer.byteLength(value) === Buffer.byteLength(token) && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token)); }
const messages = { revision_conflict: '内容已有更新。未保存内容已保留，请核对后再操作。', project_execution_busy: '该项目正在执行其他任务，请先完成或结束原执行。', execution_lease_invalid: '本次执行已失效，请重新领取任务。', source_baseline_changed: '代码已有变化，请重新提交成果或进行验收。', project_root_registered: '这个项目目录已登记。', project_root_unavailable: '项目目录无法访问，请检查目录是否可用。', invalid_project_root: '请选择本机现有的项目目录。', confirmed_charter_required: '请先确认当前总纲版本。', charter_draft_exists: '已有总纲草稿，请继续处理原总纲任务。', charter_already_confirmed: '该版本已确认，请创建新版本后修改。', charter_confirmation_invalid: '请确认已提交的最新总纲版本。', task_phase_invalid: '任务状态已变化，请重新核对后操作。', project_tasks_incomplete: '请先完成所有任务的人工验收。', blocking_issues_open: '仍有待解决问题，请修复并复验。', repair_incomplete: '修复任务尚未完成验收。', repair_required: '请先创建并完成修复任务。', repair_task_active: '已有修复任务正在处理。', batch_baseline_outdated: '总纲已有变化，请创建新的项目验收。', batch_task_set_changed: '任务已有变化，请创建新的项目验收。', passing_batch_report_required: '请先提交通过的项目验收报告。', latest_batch_required: '请确认最新的项目验收批次。', passing_evidence_required: '验收证据不完整，请补充已执行的检查。', current_ai_review_required: '请先完成当前版本的 AI 验收。', role_forbidden: '该操作需要在面板中由你完成。', source_symlink_not_supported: '部分项目文件无法核对，请检查目录链接。', request_id_conflict: '操作内容已变化，请重新提交。', evidence_required: '请补充检查结果。', issue_already_closed: '该问题已经解决。', project_task_mismatch: '任务编号与项目不一致。', project_batch_mismatch: '验收编号与项目不一致。' };
function errorMessage(error) { if (!error.code) return '操作未完成，请重试。'; return messages[error.code] || (error.code.endsWith('_not_found') ? '未找到对应记录，请检查编号。' : error.code.startsWith('invalid_') ? '请检查填写内容及编号。' : error.code === 'BODY_TOO_LARGE' ? error.message : '当前操作无法完成，请核对内容和状态后重试。'); }
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
async function body(request) { let result = '', bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw Object.assign(Error('内容过长，请分次保存'), { code: 'BODY_TOO_LARGE', status: 413 }); result += chunk; } try { const value = JSON.parse(result || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; } catch { throw Object.assign(Error('请求内容不完整'), { code: 'INVALID_INPUT', status: 400 }); } }
async function startServer({ home = process.env.BETTER_CODEX_HOME || path.join(os.homedir(), '.better-codex'), assets = path.join(process.env.BC_WORKFLOW_BUILD || path.resolve(__dirname, '../..'), 'src/ui/workflow-web'), revision = process.env.BC_WORKFLOW_REVISION || 'test', port } = {}) {
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  const run = path.join(home, 'run'), stateFile = path.join(run, 'workflow-runtime.json'), sessionFile = path.join(run, 'workflow-human-sessions.json');
  const agentToken = fs.readFileSync(path.join(run, 'workflow-agent-token'), 'utf8').trim(), controlToken = fs.readFileSync(path.join(run, 'workflow-control-token'), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(agentToken) || !/^[a-f0-9]{64}$/.test(controlToken)) throw Error('workflow_credentials_invalid');
  const store = new WorkflowStore({ home }), instanceId = crypto.randomUUID(), streams = new Set(), tickets = new Map();
  let sessions = read(sessionFile, {}), draining = false, inFlight = 0, readyPort, closed = false;
  const saveSessions = () => atomic(sessionFile, sessions);
  function session(request) { const prefix = 'bc_workflow_' + readyPort + '='; const cookies = String(request.headers.cookie || '').split(';').map(item => item.trim()); const value = cookies.find(item => item.startsWith(prefix))?.slice(prefix.length); const key = digest(value || ''); const selected = sessions[key]; if (!selected || selected.expiresAt <= Date.now()) return null; return selected; }
  function originAllowed(request) { return !request.headers.origin || request.headers.origin === 'http://127.0.0.1:' + readyPort; }
  function events(response, after) { let cursor = after; while (true) { const pending = store.eventsAfter(cursor); for (const event of pending) { response.write('id: ' + event.id + '\nevent: change\ndata: ' + JSON.stringify(event) + '\n\n'); cursor = event.id; } if (pending.length < 1000) return cursor; } }
  function broadcast() { for (const stream of streams) { try { stream.cursor = events(stream.response, stream.cursor); } catch { stream.response.end(); streams.delete(stream); } } }
  async function stop() { if (closed) return; draining = true; for (const stream of streams) stream.response.end(); streams.clear(); await new Promise(resolve => { const timer = setInterval(() => { if (!inFlight) { clearInterval(timer); resolve(); } }, 20); }); closed = true; clearInterval(heartbeat); store.close(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); if (read(stateFile)?.instanceId === instanceId) fs.unlinkSync(stateFile); }
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== '127.0.0.1:' + readyPort || !originAllowed(request)) return json(response, 403, { error: 'ORIGIN_DENIED', message: '无法从当前页面访问面板' });
      const url = new URL(request.url, 'http://127.0.0.1:' + readyPort), method = request.method;
      if (method === 'GET' && url.pathname === '/health') return json(response, draining ? 503 : 200, { name: 'BetterCodex Workflow', ready: !draining, pid: process.pid, instanceId, revision });
      if (url.pathname.startsWith('/_control/')) {
        if (method !== 'POST' || !authorized(request, controlToken)) return json(response, 401, { error: 'UNAUTHORIZED', message: '请重新打开面板' });
        if (url.pathname === '/_control/launch' && !draining) { const ticket = crypto.randomBytes(24).toString('hex'); for (const [key, expires] of tickets) if (expires < Date.now()) tickets.delete(key); tickets.set(ticket, Date.now() + 60000); return json(response, 200, { url: 'http://127.0.0.1:' + readyPort + '/launch?ticket=' + ticket }); }
        if (url.pathname === '/_control/stop') { json(response, 200, { stopping: true }); setImmediate(() => stop().then(() => { if (require.main === module) process.exit(0); }).catch(error => { process.stderr.write(error.message + '\n'); })); return; }
        return json(response, 404, { error: 'NOT_FOUND', message: '操作不存在' });
      }
      if (method === 'GET' && url.pathname === '/launch') {
        const ticket = url.searchParams.get('ticket'), expires = tickets.get(ticket); tickets.delete(ticket);
        if (!expires || expires < Date.now()) return json(response, 401, { error: 'LAUNCH_EXPIRED', message: '请从顶部重新打开面板' });
        const value = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex'); sessions[digest(value)] = { csrf, expiresAt: Date.now() + 30 * 86400000 };
        for (const [key, selected] of Object.entries(sessions)) if (selected.expiresAt <= Date.now()) delete sessions[key]; saveSessions();
        response.writeHead(302, { Location: '/', 'Set-Cookie': 'bc_workflow_' + readyPort + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); return;
      }
      if (method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1), type = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css' }[file]; const bytes = fs.readFileSync(path.join(assets, file));
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); response.end(bytes); return;
      }
      if (!url.pathname.startsWith('/api/workflow/v1/')) return json(response, 404, { error: 'NOT_FOUND', message: '页面不存在' });
      const agent = url.pathname.startsWith('/api/workflow/v1/agent/'), human = !agent ? session(request) : null;
      if (agent ? !authorized(request, agentToken) : !human) return json(response, 401, { error: 'UNAUTHORIZED', message: '请从顶部重新打开面板' });
      if (!agent && method === 'GET' && url.pathname === '/api/workflow/v1/session') return json(response, 200, { csrf: human.csrf, instanceId, revision });
      if (!agent && method === 'GET' && url.pathname === '/api/workflow/v1/state') return json(response, 200, store.state());
      if (!agent && method === 'GET' && url.pathname === '/api/workflow/v1/events') {
        if (draining) return json(response, 503, { error: 'SERVICE_RESTARTING', message: '连接正在恢复，请稍候' });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); response.write('retry: 1000\n\n');
        const cursor = Number(request.headers['last-event-id'] || url.searchParams.get('cursor') || 0); const stream = { response, cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0 }; streams.add(stream); stream.cursor = events(response, stream.cursor); response.on('close', () => streams.delete(stream)); return;
      }
      if (method !== 'POST') return json(response, 405, { error: 'METHOD_NOT_ALLOWED', message: '当前操作不可用' });
      if (draining) return json(response, 503, { error: 'SERVICE_RESTARTING', message: '连接正在恢复，请稍候' });
      if (!agent && (request.headers.origin !== 'http://127.0.0.1:' + readyPort || request.headers['x-workflow-csrf'] !== human.csrf)) return json(response, 403, { error: 'CSRF_DENIED', message: '请重新打开面板后再操作' });
      const prefix = agent ? '/api/workflow/v1/agent/' : '/api/workflow/v1/actions/'; if (!url.pathname.startsWith(prefix)) return json(response, 404, { error: 'NOT_FOUND', message: '操作不存在' });
      const operation = decodeURIComponent(url.pathname.slice(prefix.length)); if (agent && !ALLOWED_AGENT.has(operation)) return json(response, 403, { error: 'OPERATION_DENIED', message: '该操作需要在面板中由你完成' });
      inFlight++;
      try { const input = await body(request); if (Object.hasOwn(input, 'actor') || Object.hasOwn(input, 'role') || Object.hasOwn(input, 'conversationId')) throw Object.assign(Error('请求参数不正确'), { code: 'INVALID_INPUT', status: 400 }); const actor = { role: agent ? 'agent' : 'human', client: agent && request.headers['x-workflow-client'] === 'claude' ? 'claude' : agent ? 'codex' : 'web' }; let result;
        if (operation === 'context') result = store.context(input); else if (operation === 'project.list') result = { projects: store.state().projects }; else result = store.execute(operation, input, actor);
        json(response, 200, result); broadcast();
      } finally { inFlight--; }
    } catch (error) { if (!response.headersSent) json(response, error.status || (error.code ? 409 : 500), { error: error.code || 'WORKFLOW_FAILED', message: errorMessage(error), ...(error.details ? { details: error.details } : {}) }); else response.end(); if (!error.code) process.stderr.write(String(error.stack || error) + '\n'); }
  });
  const heartbeat = setInterval(() => { for (const stream of streams) stream.response.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port === undefined ? read(path.join(run, 'workflow-port.json'), {}).port || 0 : port, '127.0.0.1', resolve); }); } catch (error) { clearInterval(heartbeat); store.close(); throw error; }
  readyPort = server.address().port; atomic(path.join(run, 'workflow-port.json'), { port: readyPort }); atomic(stateFile, { pid: process.pid, port: readyPort, instanceId, revision, startedAt: new Date().toISOString() });
  return { server, store, port: readyPort, instanceId, stop };
}
module.exports = { startServer, ALLOWED_AGENT };
if (require.main === module) startServer().then(instance => { const stop = () => instance.stop().then(() => process.exit(0)); process.once('SIGTERM', stop); process.once('SIGINT', stop); }).catch(error => { process.stderr.write(error.code === 'EADDRINUSE' ? 'workflow_port_in_use\n' : String(error.stack || error) + '\n'); process.exitCode = 1; });

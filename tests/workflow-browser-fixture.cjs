'use strict';
// An isolated, model-free server for browser acceptance. Never uses live data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), readline = require('node:readline');
const { startServer } = require('../src/backend/workflow-server.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workflow-browser-')), home = path.join(temp, 'home'), root = path.join(temp, 'project'), secondRoot = path.join(temp, 'second-project');
fs.mkdirSync(path.join(home, 'run'), { recursive: true }); fs.mkdirSync(root); fs.mkdirSync(secondRoot); fs.writeFileSync(path.join(root, 'app.js'), 'const fixture = 1;\n');
fs.writeFileSync(path.join(home, 'run/workflow-agent-token'), crypto.randomBytes(32).toString('hex')); fs.writeFileSync(path.join(home, 'run/workflow-control-token'), crypto.randomBytes(32).toString('hex'));
let instance, projectRef, charterTaskRef;
const actor = { role: 'human', client: 'web' }, agent = { role: 'agent', client: 'codex' }, reviewer = { role: 'agent', client: 'claude' };
function call(op, input, owner = actor) { const state = instance.store.state(); const entity = input.taskRef ? state.tasks.find(t => t.ref === input.taskRef) : input.batchRef ? state.batches.find(t => t.ref === input.batchRef) : input.issueRef ? state.issues.find(t => t.ref === input.issueRef) : state.projects.find(p => p.ref === input.projectRef); return instance.store.execute(op, { ...input, requestId: crypto.randomUUID(), ...(entity ? { expectedRevision: entity.revision } : {}) }, owner); }
async function stop() { if (instance) await instance.stop(); const target = path.resolve(temp); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(target).startsWith('bc-workflow-browser-')) throw Error('fixture_cleanup_target_invalid'); fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); process.exit(0); }
(async () => {
  instance = await startServer({ home, revision: 'isolated-browser-v1', port: 0 });
  projectRef = call('project.create', { name: '工作流验收', root }).project.ref;
  charterTaskRef = call('charter.create', { projectRef }).task.ref; call('charter.save', { taskRef: charterTaskRef, content: '目标：建立清晰的项目工作流。\n范围：总纲、任务与验收记录。\n验收：每项任务按流程提交并由人工确认。' }); call('charter.submit', { taskRef: charterTaskRef }); call('charter.confirm', { taskRef: charterTaskRef, version: 1 });
  const tasks = call('plan.tasks', { projectRef, charterVersion: 1, tasks: [
    { title: '项目列表与总纲', requirements: '显示项目列表，支持编写和确认总纲。', acceptance: '项目可打开，总纲版本可确认。' },
    { title: '任务状态与验收', requirements: '记录任务成果与验收结果。', acceptance: '状态按顺序流转，保留验收记录。' }
  ] }, agent).tasks;
  const lease = call('task.claim', { taskRef: tasks[0].ref, phase: 'develop' }, agent);
  const evidence = [{ kind: 'source', result: 'passed', detail: '核对页面和数据接口。' }, { kind: 'device', result: 'not_run', detail: '设备操作留人工核对。', required: false }];
  call('task.submit', { taskRef: tasks[0].ref, executionId: lease.executionId, leaseToken: lease.leaseToken, summary: '项目列表及总纲表单已经完成。', evidence }, agent);
  const review = call('task.claim', { taskRef: tasks[0].ref, phase: 'review' }, reviewer); call('task.review', { taskRef: tasks[0].ref, executionId: review.executionId, leaseToken: review.leaseToken, passed: true, summary: '源码检查通过，等待人工核对使用流程。', evidence }, reviewer);
  const draft = call('charter.create', { projectRef }); charterTaskRef = draft.task.ref; call('charter.save', { taskRef: charterTaskRef, content: '新版本草稿：补充项目验收和问题复验路径。' });
  call('project.create', { name: '待规划项目', root: secondRoot });
  const manager = require('../integration/workflow-service.cjs'); const launch = await manager.controlRequest('launch', {}, home);
  process.stdout.write(JSON.stringify({ url: launch.url, baseUrl: 'http://127.0.0.1:' + instance.port, home, projectRoot: root, secondRoot, projectRef, taskRef: tasks[0].ref }) + '\n');
  const lines = readline.createInterface({ input: process.stdin }); lines.on('line', async line => { try { const command = JSON.parse(line); if (command.action === 'stop') return stop(); if (command.action === 'event') { const result = call('issue.create', { projectRef, title: '交互细节核对', description: '检查页面更新和未保存输入。' }); const response = await fetch('http://127.0.0.1:' + instance.port + '/api/workflow/v1/agent/project.list', { method: 'POST', headers: { Authorization: 'Bearer ' + fs.readFileSync(path.join(home, 'run/workflow-agent-token'), 'utf8'), 'Content-Type': 'application/json' }, body: '{}' }); await response.json(); process.stdout.write(JSON.stringify({ changed: result.issue.ref }) + '\n'); } else if (command.action === 'charter-update') { const result = call('charter.save', { taskRef: charterTaskRef, content: '其他窗口保存的总纲内容。' }); const response = await fetch('http://127.0.0.1:' + instance.port + '/api/workflow/v1/agent/project.list', { method: 'POST', headers: { Authorization: 'Bearer ' + fs.readFileSync(path.join(home, 'run/workflow-agent-token'), 'utf8'), 'Content-Type': 'application/json' }, body: '{}' }); await response.json(); process.stdout.write(JSON.stringify({ revision: result.task.revision }) + '\n'); } } catch (error) { process.stderr.write(error.message + '\n'); } });
  process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); void stop(); });

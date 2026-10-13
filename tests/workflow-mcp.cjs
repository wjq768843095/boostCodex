'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { TOOL_DEFINITIONS, createMcpServer } = require('../src/backend/workflow-mcp.cjs');
const { PassThrough } = require('node:stream');
async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workflow-mcp-'));
  const modulePath = path.resolve(__dirname, '../src/backend/workflow-mcp.cjs');
  const fixture = path.join(folder, 'stdio-fixture.cjs');
  fs.writeFileSync(fixture, `const m=require(${JSON.stringify(modulePath)});let calls=0;m.createMcpServer({client:'claude',agentRequest:async(operation,args,options)=>{calls++;if(args.projectRef==='P999')throw Object.assign(Error('Bearer private-test-token'),{code:'revision_conflict',currentRevision:8});return {operation,args,client:options.client,calls};}});`);
  const child = cp.spawn(process.execPath, [fixture], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  const waiters = new Map();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const item = JSON.parse(line); // stdout must contain newline-delimited JSON-RPC only.
    assert.equal(item.jsonrpc, '2.0');
    const waiter = waiters.get(item.id);
    if (waiter) { waiters.delete(item.id); waiter(item); } else responses.set(item.id, item);
  });
  function send(method, params, id) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) + '\n'); }
  function response(id) {
    if (responses.has(id)) { const item = responses.get(id); responses.delete(id); return Promise.resolve(item); }
    return Promise.race([new Promise(resolve => waiters.set(id, resolve)), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('MCP response timeout: ' + id)), 5000); timer.unref(); })]);
  }
  try {
    send('tools/list', {}, 1); assert.equal((await response(1)).error.code, -32600);
    send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 2);
    const initialized = await response(2); assert.equal(initialized.result.protocolVersion, '2025-11-25');
    assert.deepEqual(initialized.result.capabilities, { tools: {} });
    send('notifications/initialized');
    send('tools/list', {}, 3);
    const tools = (await response(3)).result.tools;
    assert.equal(tools.length, 14);
    assert.ok(!tools.some(tool => /confirm|human|revoke|update/.test(tool.name)));
    send('tools/call', { name: 'bc_context', arguments: {} }, 4);
    assert.deepEqual((await response(4)).result.structuredContent, { operation: 'context', args: {}, client: 'claude', calls: 1 });
    // Reject actor spoofing and human-only or arbitrary methods before service dispatch.
    send('tools/call', { name: 'bc_context', arguments: { actor: 'human' } }, 5); assert.equal((await response(5)).error.code, -32602);
    send('tools/call', { name: 'bc_charter_confirm', arguments: {} }, 6); assert.equal((await response(6)).error.code, -32602);
    send('tools/call', { name: 'bc_task_claim', arguments: { taskRef: 'P001-T001', phase: 'develop', requestId: 'a' } }, 7); assert.equal((await response(7)).error.code, -32602);
    send('tools/call', { name: 'bc_task_claim', arguments: { taskRef: 'P001-T001', phase: 'develop', requestId: 'a', expectedRevision: 2 } }, 8);
    const claimed = (await response(8)).result.structuredContent;
    assert.equal(claimed.operation, 'task.claim'); assert.equal(claimed.args.expectedRevision, 2); assert.equal(claimed.calls, 2);
    send('tools/call', { name: 'bc_context', arguments: { projectRef: 'P999' } }, 9);
    const failure = (await response(9)).result; assert.equal(failure.isError, true); assert.ok(!JSON.stringify(failure).includes('private-test-token'));
    assert.equal(JSON.parse(failure.content[0].text).currentRevision, 8);
    child.stdin.write('not-json\n'); assert.equal((await response(null)).error.code, -32700);
    send('ping', {}, 10); assert.deepEqual((await response(10)).result, {});
    const submit = { taskRef: 'P001-T001', executionId: 'execution-fixture', leaseToken: 'lease-fixture', expectedRevision: 3, requestId: 'submit-fixture' };
    send('tools/call', { name: 'bc_charter_submit', arguments: submit }, 11);
    assert.deepEqual((await response(11)).result.structuredContent.args, submit);
    send('tools/call', { name: 'bc_charter_submit', arguments: { ...submit, content: 'must be saved separately' } }, 12);
    assert.equal((await response(12)).error.code, -32602);
    send('tools/call', { name: 'bc_task_review', arguments: { ...submit, passed: true, summary: 'required checks passed; device verification remains manual', evidence: [{ kind: 'static', result: 'passed', detail: 'scoped check', required: true }, { kind: 'device', result: 'not_run', detail: 'manual check per project rule', required: false }] } }, 13);
    assert.equal((await response(13)).result.structuredContent.args.evidence[1].required, false);
    assert.equal(stderr, '');
  } finally {
    child.kill();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('bc-workflow-mcp-'));
    fs.rmSync(folder, { recursive: true, force: true });
  }
  const input = new PassThrough(); const output = new PassThrough(); let wire = ''; let cancelled = false;
  output.on('data', value => { wire += value; });
  const server = createMcpServer({ input, output, client: 'codex', agentRequest: (op, args, options) => new Promise(resolve => options.signal.addEventListener('abort', () => { cancelled = true; resolve({ ok: true }); })) });
  await server.dispatch({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 'future' } });
  assert.ok(wire.includes('2025-11-25'));
  await server.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const running = server.dispatch({ jsonrpc: '2.0', id: 'cancel', method: 'tools/call', params: { name: 'bc_context' } });
  await server.dispatch({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel', reason: 'test' } });
  await running; assert.equal(cancelled, true); assert.ok(!wire.includes('"id":"cancel"')); server.close();
  assert.throws(() => createMcpServer({ client: 'human' }), /workflow_client_required/);
  const direct = cp.spawnSync(process.execPath, [modulePath, '--client', 'codex'], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n', encoding: 'utf8', windowsHide: true });
  assert.equal(direct.status, 0); assert.equal(JSON.parse(direct.stdout).result.protocolVersion, '2024-11-05'); assert.equal(direct.stderr, '');
  assert.equal(TOOL_DEFINITIONS.find(tool => tool.name === 'bc_plan_tasks').inputSchema.additionalProperties, false);
  console.log('workflow-mcp: real stdio negotiation, discovery, dispatch, validation and cancellation passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

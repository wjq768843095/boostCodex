'use strict';
const readline = require('node:readline');
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const string = { type: 'string', minLength: 1, maxLength: 20000 };
const ref = pattern => ({ type: 'string', pattern });
const projectRef = ref('^P[0-9]{3,}$');
const taskRef = ref('^P[0-9]{3,}-T[0-9]{3,}$');
const batchRef = ref('^P[0-9]{3,}-A[0-9]{3,}$');
const issueRef = ref('^P[0-9]{3,}-I[0-9]{3,}$');
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items, maxItems: 1000 });
const write = { expectedRevision: { type: 'integer', minimum: 0 }, requestId: { type: 'string', minLength: 1, maxLength: 200 } };
const lease = { executionId: string, leaseToken: string };
const evidence = array(object({ kind: string, result: string, detail: string, required: { type: 'boolean' } }, ['kind', 'result', 'detail']));
const definitions = [
  ['context', 'Read current workflow state and permanent references.', object({ projectRef, taskRef, batchRef }, []), true],
  ['project.list', 'List projects, local roots and current revisions.', object({}), true],
  ['charter.create', 'Create or resume the project charter draft.', object({ projectRef, ...write }), false],
  ['charter.save', 'Save a charter draft under a valid charter lease.', object({ taskRef, content: string, ...lease, ...write }), false],
  ['charter.submit', 'Submit the saved project charter for human confirmation.', object({ taskRef, ...lease, ...write }), false],
  ['plan.tasks', 'Create tasks from the human-confirmed charter.', object({ projectRef, charterVersion: { type: 'integer', minimum: 1 }, tasks: array(object({ title: string, requirements: string, acceptance: string, scopePaths: array(string) })), ...write }), false],
  ['task.claim', 'Claim a 30-minute execution lease for a workflow phase.', object({ taskRef, phase: { type: 'string', enum: ['develop', 'charter', 'review'] }, ...write }), false],
  ['task.renew', 'Renew the current execution lease before it expires.', object({ taskRef, ...lease, ...write }), false],
  ['task.submit', 'Submit development evidence for automated review.', object({ taskRef, summary: string, evidence, ...lease, ...write }), false],
  ['task.review', 'Record the independent review result under a review lease.', object({ taskRef, passed: { type: 'boolean' }, summary: string, evidence, ...lease, ...write }), false],
  ['batch.start', 'Start a project review batch.', object({ projectRef, ...write }), false],
  ['batch.report', 'Report a project review batch and discovered issues.', object({ batchRef, passed: { type: 'boolean' }, summary: string, evidence, issues: array(object({ title: string, description: string, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical', 'informational'] } })), ...write }), false],
  ['issue.create', 'Record an issue against a project, task or batch.', object({ projectRef, batchRef, taskRef, title: string, description: string, ...write }, ['projectRef', 'title', 'description', ...Object.keys(write)]), false],
  ['issue.repair', 'Create a repair task for an existing issue.', object({ issueRef, ...write }), false],
];
const TOOL_DEFINITIONS = definitions.map(([operation, description, inputSchema, readOnly]) => ({ name: 'bc_' + operation.replaceAll('.', '_'), description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
const byName = new Map(definitions.map((entry, i) => [TOOL_DEFINITIONS[i].name, entry]));
function validate(value, schema, at = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(at + ' must be an object');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw Error(at + '.' + key + ' is required');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw Error(at + '.' + key + ' is not allowed');
      validate(value[key], schema.properties[key], at + '.' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw Error(at + ' must be a bounded array');
    value.forEach((item, i) => validate(item, schema.items, at + '[' + i + ']'));
  } else {
    if (schema.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== schema.type) throw Error(at + ' has an invalid type');
    if (schema.minimum !== undefined && value < schema.minimum) throw Error(at + ' is below minimum');
    if (schema.minLength !== undefined && value.length < schema.minLength) throw Error(at + ' is empty');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw Error(at + ' is too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw Error(at + ' has an invalid reference');
    if (schema.enum && !schema.enum.includes(value)) throw Error(at + ' has an invalid enum value');
  }
}
function publicError(error) {
  const code = /^[a-z][a-z0-9_]{0,80}$/i.test(error?.code || '') ? error.code : 'workflow_request_failed';
  return { code, message: code, ...(Number.isSafeInteger(error?.currentRevision) ? { currentRevision: error.currentRevision } : {}) };
}
function createMcpServer({ input = process.stdin, output = process.stdout, client, agentRequest } = {}) {
  if (!['codex', 'claude'].includes(client)) throw Error('workflow_client_required');
  let initialized = false;
  let ready = false;
  const pending = new Map();
  const send = value => output.write(JSON.stringify(value) + '\n');
  const failure = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  async function dispatch(message) {
    const hasId = Object.hasOwn(message || {}, 'id');
    const id = message?.id;
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && typeof id !== 'string' && !Number.isSafeInteger(id))) return failure(null, -32600, 'Invalid Request');
    if (message.method === 'notifications/cancelled' && !hasId) { const request = pending.get(message.params?.requestId); if (request) { request.cancelled = true; request.controller.abort(); } return; }
    if (message.method === 'notifications/initialized' && !hasId) { if (initialized) ready = true; return; }
    if (!hasId) return;
    if (message.method === 'initialize') {
      if (initialized) return failure(id, -32600, 'Already initialized');
      if (!message.params || typeof message.params.protocolVersion !== 'string') return failure(id, -32602, 'protocolVersion is required');
      initialized = true;
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(message.params.protocolVersion) ? message.params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: 'boost-codex-workflow', version: '1.0.0' }, instructions: 'Only use workflow mutation tools after the human explicitly invokes a bc-charter, bc-plan, bc-develop, bc-review or bc-project-review Skill. Ordinary coding requests do not start this workflow. Use permanent project/task/batch references and latest revisions. Human confirmation tools are unavailable. Never infer a target from the current chat or working directory.' } });
    }
    if (message.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (!ready) return failure(id, -32600, 'Server is not initialized');
    if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } });
    if (message.method !== 'tools/call') return failure(id, -32601, 'Method not found');
    const definition = byName.get(message.params?.name);
    if (!definition) return failure(id, -32602, 'Unknown workflow tool');
    const args = message.params.arguments ?? {};
    try { validate(args, definition[2]); } catch (error) { return failure(id, -32602, error.message); }
    if (pending.has(id)) return failure(id, -32600, 'Duplicate request ID');
    const request = { controller: new AbortController(), cancelled: false };
    pending.set(id, request);
    try {
      // Discovery must not load the service, open the database or start a daemon.
      const call = agentRequest || require('../../integration/workflow-service.cjs').agentRequest;
      const result = await call(definition[0], args, { client, signal: request.controller.signal });
      if (!request.cancelled) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}), isError: false } });
    } catch (error) {
      if (!request.cancelled) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(publicError(error)) }], isError: true } });
    } finally { pending.delete(id); }
  }
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 1024 * 1024) { failure(null, -32600, 'Request exceeds limit'); return; }
    let message;
    try { message = JSON.parse(line); } catch { failure(null, -32700, 'Parse error'); return; }
    dispatch(message).catch(() => failure(message?.id ?? null, -32603, 'Internal error'));
  });
  lines.on('close', () => { for (const request of pending.values()) { request.cancelled = true; request.controller.abort(); } });
  return { close: () => lines.close(), dispatch };
}
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--client' || !['codex', 'claude'].includes(argv[1])) { process.stderr.write('Usage: workflow-mcp.cjs --client codex|claude\n'); process.exitCode = 2; return; }
  createMcpServer({ client: argv[1] });
}
module.exports = { TOOL_DEFINITIONS, PROTOCOLS, validate, createMcpServer, main };
if (require.main === module) main();

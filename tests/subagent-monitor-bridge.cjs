'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/backend/boost-codex.cjs'), 'utf8');
const start = source.indexOf('async function bridgeRequest('), end = source.indexOf('\nasync function cdpJson(', start);
const calls = [], results = [], connection = {};
const context = vm.createContext({ Error, AbortSignal, cdpCommandTimeoutMs: 8000, import_node_crypto3: { randomUUID: () => 'fixture-trace' },
  async fetch(url, options) { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ agents: [] }) }; },
  async evaluate(peer, expression) { assert.equal(peer, connection); vm.runInNewContext(expression, { window: { __boostCodexBridgeResolve: (_id, result) => results.push(result) } }); }
});
vm.runInContext(source.slice(start, end), context);
async function call(path, method = 'GET', token = 'fixture-token') {
  await context.bridgeRequest(connection, 12345, 'fixture-token', JSON.stringify({ id: 'one', token, path, method })); return results.at(-1);
}
(async () => {
  assert.equal((await call('/api/dev/subagents?threadId=11111111-1111-1111-1111-111111111111&locale=zh-CN')).ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-token'); assert.equal(calls[0].options.method, 'GET');
  assert.equal((await call('/api/dev/subagents/work?threadId=11111111-1111-1111-1111-111111111111&agentId=22222222-2222-2222-2222-222222222222')).ok, true);
  assert.equal(calls.length, 2);assert.equal(calls[1].options.method,'GET');
  for (const args of [['/api/dev/subagents', 'POST'], ['/api/dev/subagents', 'DELETE'], ['/api/dev/subagents', 'GET', 'wrong'], ['/api/dev/subagents-extra'], ['/api/dev/subagents/work','POST'], ['/api/dev/subagents/work','DELETE'], ['/api/dev/subagents/work','GET','wrong'], ['/api/dev/subagents/work-extra'], ['/api/dev/subagents/work/other'], ['https://other.example/api/dev/subagents'],['https://other.example/api/dev/subagents/work']]) {
    assert.equal((await call(...args)).ok, false); assert.equal(calls.length, 2, 'denied requests never reach HTTP');
  }
  console.log('PASS: subagent renderer bridge GET allowlist, token and unrelated-route guards (isolated)');
})().catch(error => { console.error(error); process.exitCode = 1; });

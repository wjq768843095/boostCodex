'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');

const filter = require.resolve('../src/modules/runtime-warnings.cjs');
const result = cp.spawnSync(process.execPath, ['-e', `
  require(${JSON.stringify(filter)}).installSQLiteWarningFilter();
  require('node:sqlite');
  process.emitWarning('unrelated experimental warning', 'ExperimentalWarning');
  process.emitWarning('operational warning');
`], { encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 0);
assert(!result.stderr.includes('SQLite is an experimental feature'));
assert(result.stderr.includes('unrelated experimental warning'));
assert(result.stderr.includes('operational warning'));

const source = fs.readFileSync(path.join(__dirname, '../src/backend/better-codex.cjs'), 'utf8');
const start = source.indexOf('function assertTrustedCdpListener(port) {');
const end = source.indexOf('\nasync function targets(', start);
assert(start >= 0 && end > start);
const functionSource = source.slice(start, end);
function checker(execFileSync) {
  return vm.runInNewContext(functionSource + '\nassertTrustedCdpListener', {
    process: { platform: 'win32' }, import_node_child_process3: { execFileSync }
  });
}
for (const [status, message] of [[2, 'cdp_listener_absent'], [1, 'cdp_listener_untrusted']]) {
  assert.throws(() => checker(() => { throw Object.assign(new Error('PowerShell failed'), { status }); })(9229), { message });
}
checker((exe, args, options) => {
  assert.equal(exe, 'powershell.exe');
  assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
  return '12345\r\n';
})(9229);
assert.throws(() => checker(() => 'unexpected output')(9229), { message: 'cdp_listener_untrusted' });
assert.throws(() => checker(() => { throw new Error('must not run'); })(0), { message: 'cdp_port_invalid' });

(async () => {
  if (process.platform === 'win32') {
    // Exercise the actual CIM no-match case on a freshly released local port.
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    let stderr;
    assert.throws(() => checker((...args) => {
      try { return cp.execFileSync(...args); }
      catch (error) { stderr = error.stderr; throw error; }
    })(port), { message: 'cdp_listener_absent' });
    assert.equal(String(stderr), '', 'no-match CIM query must not print an error');
  }
  console.log('PASS: startup SQLite notice filtering, unrelated warning visibility and trusted CDP listener failures');
})().catch(error => { console.error(error); process.exitCode = 1; });

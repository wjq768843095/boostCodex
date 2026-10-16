'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const backend = fs.readFileSync(path.join(__dirname, '../src/backend/boost-codex.cjs'), 'utf8');
const start = backend.indexOf('async function liveInjectorPid()'), end = backend.indexOf('\nfunction tryStartInjector(', start);
let finish, alive = true, contents = '12345', queries = 0;
const context = vm.createContext({ process: { platform: 'win32' }, injectorPidPath: 'fixture', processAlive5: () => alive,
  import_node_fs31: { readFileSync: () => contents },
  import_node_child_process14: { execFile(command, args, options, callback) {
    queries++; assert.equal(command, 'powershell.exe'); assert.match(args.at(-1), /ProcessId = 12345/); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000); finish = callback;
  }, execFileSync() { throw Error('supervisor must not block the event loop'); } }
});
vm.runInContext(backend.slice(start, end), context);
(async () => {
  let resolved = false; const pending = context.liveInjectorPid().then(value => { resolved = true; return value; });
  await Promise.resolve(); assert.equal(resolved, false, 'identity query yields instead of blocking');
  finish(null, 'node launcher.cjs watch-inject 9229'); assert.equal(await pending, 12345);
  const unrelated = context.liveInjectorPid(); finish(null, 'node unrelated.cjs'); assert.equal(await unrelated, null);
  const died = context.liveInjectorPid(); alive = false; finish(null, 'node launcher.cjs watch-inject'); assert.equal(await died, null, 'identity completion cannot authorize a dead PID');
  alive = true; const failed = context.liveInjectorPid(); finish(new Error('timeout')); assert.equal(await failed, null);
  contents = 'invalid'; assert.equal(await context.liveInjectorPid(), null); assert.equal(queries, 4);
  const ensureStart = backend.indexOf('async function ensureInjector('), ensureEnd = backend.indexOf('\nasync function withLaunchLock(', ensureStart);
  const ensure = backend.slice(ensureStart, ensureEnd); assert.match(ensure, /await liveInjectorPid\(\)/); assert.doesNotMatch(ensure, /\binjectorPid\(\)/);
  console.log('PASS: injector supervisor async identity, bounded query, unrelated/dead PID and failure checks');
})().catch(error => { console.error(error); process.exitCode = 1; });

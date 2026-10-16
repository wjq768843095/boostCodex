'use strict';
require('../src/modules/brand.cjs').normalizeEnvironment();
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process'), vm = require('node:vm');
const ROOT = process.env.BOOST_CODEX_LOCAL_PROJECT || path.resolve(__dirname, '..');
const HOME = process.env.BOOST_CODEX_HOME || path.join(os.homedir(), '.better-codex');
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = file + '.tmp-' + crypto.randomUUID(); fs.writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
function paths(home = HOME) { return { home, run: path.join(home, 'run'), state: path.join(home, 'run/workflow-runtime.json'), port: path.join(home, 'run/workflow-port.json'), lock: path.join(home, 'run/workflow-start.lock'), agent: path.join(home, 'run/workflow-agent-token'), control: path.join(home, 'run/workflow-control-token') }; }
function alive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function secret(file) { if (!fs.existsSync(file)) { try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } } const value = fs.readFileSync(file, 'utf8').trim(); if (!/^[a-f0-9]{64}$/.test(value)) throw Error('workflow_credentials_invalid'); return value; }
function files(directory) { if (!fs.existsSync(directory)) return []; return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : entry.isFile() ? [path.join(directory, entry.name)] : []); }
function build(root = ROOT) {
  const selected = ['src/backend/workflow-server.cjs', 'src/backend/workflow-mcp.cjs', 'src/modules/workflow-store.cjs', 'src/modules/brand.cjs', 'integration/workflow-service.cjs'];
  const sources = [...selected.map(file => path.join(root, file)), ...files(path.join(root, 'src/ui/workflow-web'))];
  const hash = crypto.createHash('sha256');
  for (const file of sources.sort()) { const bytes = fs.readFileSync(file); if (/\.(cjs|js)$/.test(file)) new vm.Script(bytes.toString('utf8'), { filename: file }); hash.update(path.relative(root, file)).update(bytes); }
  const revision = hash.digest('hex'), destination = path.join(root, '.dev/workflow-builds', revision);
  if (!fs.existsSync(path.join(destination, 'manifest.json'))) {
    for (const file of sources) { const output = path.join(destination, path.relative(root, file)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(file, output); }
    atomic(path.join(destination, 'manifest.json'), { revision, createdAt: new Date().toISOString() });
  }
  atomic(path.join(root, '.dev/workflow-state.json'), { revision, current: destination });
  return { revision, current: destination };
}
async function health(home = HOME) {
  const state = read(paths(home).state); if (!state || !alive(state.pid)) return null;
  try { const response = await fetch('http://127.0.0.1:' + state.port + '/health', { signal: AbortSignal.timeout(2000), redirect: 'error' }); const result = await response.json(); return response.ok && ['boostCodex Workflow', 'BetterCodex Workflow'].includes(result.name) && result.instanceId === state.instanceId && result.pid === state.pid ? { ...result, port: state.port } : null; } catch { return null; }
}
async function controlRequest(operation, body = {}, home = HOME) {
  const state = read(paths(home).state); if (!state) throw Error('workflow_unavailable');
  const response = await fetch('http://127.0.0.1:' + state.port + '/_control/' + operation, { method: 'POST', headers: { Authorization: 'Bearer ' + secret(paths(home).control), 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(Error(result.message || result.error || 'workflow_request_failed'), { code: result.error, status: response.status }); return result;
}
async function ensureStarted({ home = HOME, root = ROOT } = {}) {
  const p = paths(home); fs.mkdirSync(p.run, { recursive: true });
  const accepted = build(root), current = await health(home);
  if (current?.revision === accepted.revision) return current;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { fs.writeFileSync(p.lock, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), at: Date.now() }), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; const owner = read(p.lock); if (!owner || !alive(owner.pid)) { try { fs.unlinkSync(p.lock); } catch {} continue; } if (attempt === 99) throw Error('workflow_start_busy'); await sleep(100); const live = await health(home); if (live?.revision === accepted.revision) return live; }
  }
  try {
    const live = await health(home);
    if (live?.revision === accepted.revision) return live;
    const prior = read(p.state);
    if (live) { await controlRequest('stop', {}, home); for (let i = 0; i < 100 && alive(prior.pid); i++) await sleep(50); if (alive(prior.pid)) throw Error('workflow_shutdown_pending'); }
    else if (prior && alive(prior.pid)) throw Error('workflow_running_unavailable');
    secret(p.agent); secret(p.control);
    const logs = path.join(home, 'logs'); fs.mkdirSync(logs, { recursive: true }); const fd = fs.openSync(path.join(logs, 'workflow.log'), 'a');
    const child = cp.spawn(process.execPath, [path.join(accepted.current, 'src/backend/workflow-server.cjs')], { cwd: root, env: { ...process.env, BOOST_CODEX_HOME: home, BOOST_CODEX_LOCAL_PROJECT: root, BC_WORKFLOW_BUILD: accepted.current, BC_WORKFLOW_REVISION: accepted.revision }, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd); child.unref();
    let spawnError; child.once('error', error => { spawnError = error; });
    for (let i = 0; i < 100; i++) { if (spawnError) throw spawnError; await sleep(100); const ready = await health(home); if (ready?.revision === accepted.revision) return ready; if (!alive(child.pid)) throw Error('workflow_start_failed'); }
    throw Error('workflow_start_timeout');
  } finally { if (read(p.lock)?.pid === process.pid) { try { fs.unlinkSync(p.lock); } catch {} } }
}
async function agentRequest(operation, input, { client = 'codex', home = HOME, root = ROOT, signal } = {}) {
  if (!['codex', 'claude'].includes(client)) throw Error('workflow_client_invalid');
  signal?.throwIfAborted();
  const ready = await ensureStarted({ home, root });
  signal?.throwIfAborted();
  const response = await fetch('http://127.0.0.1:' + ready.port + '/api/workflow/v1/agent/' + encodeURIComponent(operation), { method: 'POST', headers: { Authorization: 'Bearer ' + secret(paths(home).agent), 'Content-Type': 'application/json', 'X-Workflow-Client': client }, body: JSON.stringify(input || {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  const result = await response.json(); if (!response.ok) throw Object.assign(Error(result.message || '任务操作未完成'), { code: result.error, status: response.status, details: result.details }); return result;
}
async function panelUrl(options = {}) { const ready = await ensureStarted(options); return { url: (await controlRequest('launch', {}, options.home || HOME)).url, stableUrl: 'http://127.0.0.1:' + ready.port + '/' }; }
async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'status';
  if (command === 'mcp') { const accepted = build(); process.env.BOOST_CODEX_LOCAL_PROJECT = ROOT; const client = args[args.indexOf('--client') + 1] || 'codex'; return require(path.join(accepted.current, 'src/backend/workflow-mcp.cjs')).main(['--client', client]); }
  if (command === 'start') { const ready = await ensureStarted(); return process.stdout.write(JSON.stringify({ running: true, port: ready.port, revision: ready.revision }) + '\n'); }
  if (command === 'status') { const ready = await health(); return process.stdout.write(JSON.stringify({ running: !!ready, port: ready?.port || null, revision: ready?.revision || null }) + '\n'); }
  if (command === 'stop') { if (await health()) await controlRequest('stop'); return process.stdout.write(JSON.stringify({ stopped: true }) + '\n'); }
  if (command === 'open') throw Error('Use the Codex 面板 entry to open the authenticated page.');
  throw Error('workflow_command_invalid');
}
module.exports = { ROOT, HOME, paths, read, atomic, build, health, ensureStarted, agentRequest, panelUrl, controlRequest, main };
if (require.main === module) main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });

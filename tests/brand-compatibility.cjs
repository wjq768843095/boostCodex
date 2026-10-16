'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { normalizeEnvironment } = require('../src/modules/brand.cjs');
const env = { BETTER_CODEX_HOME: 'legacy-home', BETTER_CODEX_PROFILE: 'stable', BOOST_CODEX_HOME: 'chosen-home', OTHER: 'untouched' };
normalizeEnvironment(env);
assert.equal(env.BOOST_CODEX_HOME, 'chosen-home');
assert.equal(env.BETTER_CODEX_HOME, 'chosen-home');
assert.equal(env.BOOST_CODEX_PROFILE, 'stable');
assert.equal(env.OTHER, 'untouched');
assert.deepEqual(normalizeEnvironment({ BETTER_CODEX_HOME: 'existing-home' }), { BETTER_CODEX_HOME: 'existing-home', BOOST_CODEX_HOME: 'existing-home' });
const source = fs.readFileSync(path.join(__dirname, '../src/backend/boost-codex.cjs'), 'utf8');
const implementation = source.slice(source.indexOf('function installService() {'), source.indexOf('function uninstallService() {'));
function service(prior) {
  const commands = [], backups = [];
  const context = { process: { platform: 'win32' }, boostCodexProfile: 'stable', boostCodexHome: 'fixture', path,
    ensureDirectories() {}, windowsStartupCommand: () => 'owned-startup-command', windowsRunKey: 'fixture-run-key', windowsTask: 'boostCodex Runtime',
    reg(args) { commands.push(args); return args[0] === 'QUERY' ? prior : ''; },
    fs: { mkdirSync() {}, writeFileSync(file, data) { backups.push({ file, data: JSON.parse(data) }); } }, startService() {} };
  vm.runInNewContext(implementation, context);
  return { run: () => context.installService(), commands, backups };
}
const old = service('Better Codex Runtime    REG_SZ    owned-startup-command');
assert.equal(old.run().installed, true);
assert.deepEqual(old.commands.filter(args => args[0] === 'ADD').map(args => args[3]), ['boostCodex Runtime']);
assert.deepEqual(old.commands.filter(args => args[0] === 'DELETE').map(args => args[3]), ['Better Codex Runtime']);
assert.equal(old.backups[0].data.command, 'owned-startup-command');
const foreign = service('Better Codex Runtime    REG_SZ    someone-elses-startup');
assert.throws(foreign.run, /not_owned/);
assert.equal(foreign.commands.some(args => ['ADD', 'DELETE'].includes(args[0])), false);
assert.equal(foreign.backups.length, 0);
const fresh = service(''); assert.equal(fresh.run().installed, true);
assert.equal(fresh.commands.some(args => args[0] === 'DELETE'), false);
console.log('brand compatibility: legacy environment fallback, new precedence and ownership-checked startup migration passed');

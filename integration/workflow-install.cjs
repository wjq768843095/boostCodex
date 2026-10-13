'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const VERSION = 1;
const OWNER = 'better-codex-workflow';
const SKILLS = ['bc-charter', 'bc-plan', 'bc-develop', 'bc-review', 'bc-project-review'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = file => fs.existsSync(file);
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw Error('Invalid managed JSON: ' + file, { cause: error }); } }
function same(a, b) { return json(a) === json(b); }
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + crypto.randomUUID();
  try { fs.writeFileSync(temp, value, { mode: 0o600 }); fs.renameSync(temp, file); } finally { if (exists(temp)) fs.unlinkSync(temp); }
}
function safeFile(file) {
  // Never follow user-level symlinks/junctions when writing managed configuration.
  let cursor = path.resolve(file);
  while (true) {
    if (exists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Refusing linked install target: ' + cursor);
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function renderSkill(repoRoot, name, client) {
  const prefix = client === 'codex' ? 'mcp__better_codex_workflow__' : 'mcp__better_codex_workflow__';
  const common = fs.readFileSync(path.join(repoRoot, 'src/skills/workflow-common.md'), 'utf8');
  let source = fs.readFileSync(path.join(repoRoot, 'src/skills', name, 'SKILL.md'), 'utf8');
  source = source.replace('{{COMMON_WORKFLOW_RULES}}', common).replaceAll('{{CLIENT}}', client).replaceAll('{{TOOL_PREFIX}}', prefix);
  if (/\{\{[A-Z_]+\}\}/.test(source)) throw Error('Unresolved skill template: ' + name);
  if (client === 'claude') source = source.replace(/\n---\n/, '\ndisable-model-invocation: true\n---\n');
  const files = { 'SKILL.md': source };
  if (client === 'codex') files['agents/openai.yaml'] = 'policy:\n  allow_implicit_invocation: false\n';
  return files;
}
function codexConfig(source, entry, owned) {
  // Preserve unrelated TOML verbatim. Refuse duplicate or differently quoted aliases.
  const lines = source.split(/(?<=\n)/);
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (match) tables.push({ i, key: match[1].replace(/["'\s]/g, '') });
  }
  const matches = tables.filter(table => table.key === 'mcp_servers.better_codex_workflow' || table.key.startsWith('mcp_servers.better_codex_workflow.'));
  if (matches.length > 1 || (matches.length === 1 && matches[0].key !== 'mcp_servers.better_codex_workflow')) throw Error('Conflicting Codex MCP table');
  const block = '[mcp_servers.better_codex_workflow]\n# ' + OWNER + ' managed v' + VERSION + '\ncommand = ' + JSON.stringify(entry.command) + '\nargs = ' + JSON.stringify(entry.args) + '\n';
  if (!matches.length) {
    if (/^\s*mcp_servers\s*=/m.test(source) || /^\s*(?:mcp_servers\.)?["']?better_codex_workflow["']?\s*=/m.test(source)) throw Error('Conflicting inline Codex MCP configuration');
    return { text: source + (source && !source.endsWith('\n') ? '\n' : '') + (source ? '\n' : '') + block, managedHash: hash(block) };
  }
  const table = matches[0];
  const next = tables.find(other => other.i > table.i);
  const end = next ? next.i : lines.length;
  const original = lines.slice(table.i, end).join('');
  const normalized = original.trimEnd() + '\n';
  if (!owned || hash(normalized) !== owned.hash) throw Error('Codex workflow configuration is not owned or was edited');
  return { text: lines.slice(0, table.i).join('') + block + (next ? '\n' : '') + lines.slice(end).join(''), managedHash: hash(block) };
}
function installWorkflow(options = {}) {
  const userHome = path.resolve(options.userHome || os.homedir());
  const dataHome = path.resolve(options.dataHome || process.env.BETTER_CODEX_HOME || path.join(userHome, '.better-codex'));
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const nodePath = path.resolve(options.nodePath || process.execPath);
  const targets = options.targets || ['codex', 'claude'];
  if (!Array.isArray(targets) || !targets.length || targets.some(target => !['codex', 'claude'].includes(target)) || new Set(targets).size !== targets.length) throw Error('Invalid install targets');
  if (!exists(nodePath) || !fs.statSync(nodePath).isFile()) throw Error('Node executable is unavailable');
  const manager = path.join(repoRoot, 'integration/workflow-service.cjs');
  if (!exists(manager)) throw Error('Stable workflow service entry is unavailable');
  const ledgerFile = path.join(dataHome, 'run/workflow-install-manifest.json');
  safeFile(ledgerFile);
  const previous = exists(ledgerFile) ? readJson(ledgerFile) : { owner: OWNER, version: VERSION, configs: {} };
  if (previous.owner !== OWNER || previous.version !== VERSION) throw Error('Unsupported installation manifest');
  const ledger = { ...previous, repoRoot, nodePath, configs: { ...previous.configs } };
  const changes = [];
  const configFiles = [];
  function plan(file, value) {
    safeFile(file);
    const before = exists(file) ? fs.readFileSync(file) : null;
    const after = Buffer.from(value);
    if (!before || !before.equals(after)) changes.push({ file, before, after });
  }
  for (const client of targets) {
    const skillsRoot = path.join(userHome, client === 'codex' ? '.agents' : '.claude', 'skills');
    for (const name of SKILLS) {
      const folder = path.join(skillsRoot, name);
      safeFile(folder);
      const manifestFile = path.join(folder, '.better-codex-workflow.json');
      const files = renderSkill(repoRoot, name, client);
      if (exists(folder)) {
        if (!exists(manifestFile)) throw Error('Refusing to overwrite an unmanaged skill: ' + name + ' (' + client + ')');
        const previousSkill = readJson(manifestFile);
        if (previousSkill.owner !== OWNER || previousSkill.version !== VERSION || previousSkill.skill !== name || previousSkill.client !== client) throw Error('Unsupported skill ownership: ' + name);
        if (!previousSkill.files || typeof previousSkill.files !== 'object') throw Error('Invalid skill file manifest');
        for (const [relative, expected] of Object.entries(previousSkill.files)) {
          if (!Object.hasOwn(files, relative)) throw Error('Unsupported managed skill file: ' + relative);
          const file = path.join(folder, relative);
          safeFile(file);
          if (!exists(file) || hash(fs.readFileSync(file)) !== expected) throw Error('Managed skill has local changes: ' + name + '/' + relative);
        }
        for (const relative of Object.keys(files)) if (exists(path.join(folder, relative)) && !Object.hasOwn(previousSkill.files, relative)) throw Error('Unmanaged skill file conflicts: ' + name + '/' + relative);
      }
      for (const [relative, content] of Object.entries(files)) plan(path.join(folder, relative), content);
      plan(manifestFile, json({ owner: OWNER, version: VERSION, skill: name, client, files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, hash(content)])) }));
    }
    const entry = { command: nodePath, args: [manager, 'mcp', '--client', client] };
    if (client === 'codex') {
      const file = path.join(userHome, '.codex/config.toml');
      safeFile(file);
      const result = codexConfig(exists(file) ? fs.readFileSync(file, 'utf8') : '', entry, previous.configs.codex);
      plan(file, result.text);
      ledger.configs.codex = { path: file, hash: result.managedHash };
      configFiles.push(file);
    } else {
      const file = path.join(userHome, '.claude.json');
      safeFile(file);
      const config = exists(file) ? readJson(file) : {};
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid Claude user configuration');
      if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw Error('Invalid Claude MCP servers');
      const current = config.mcpServers?.better_codex_workflow;
      if (current !== undefined && (!previous.configs.claude || hash(json(current)) !== previous.configs.claude.hash)) throw Error('Claude workflow configuration is not owned or was edited');
      const merged = { ...config, mcpServers: { ...config.mcpServers, better_codex_workflow: entry } };
      if (!same(config, merged)) plan(file, json(merged));
      ledger.configs.claude = { path: file, hash: hash(json(entry)) };
      configFiles.push(file);
    }
  }
  plan(ledgerFile, json(ledger));
  if (!changes.length) return { version: VERSION, targets, changed: false, backupDirectory: null, skills: SKILLS, configFiles };
  // Complete all ownership checks before backing up or mutating any user file.
  const configChanges = changes.filter(change => configFiles.includes(change.file) && change.before !== null);
  let backupDirectory = null;
  if (configChanges.length) {
    backupDirectory = path.join(dataHome, 'backups/workflow-install-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID());
    safeFile(backupDirectory);
    fs.mkdirSync(backupDirectory, { recursive: true });
    for (const change of configChanges) {
      if (!change.before.length) throw Error('Existing configuration is empty; a recoverable nonempty backup is required');
      const backup = path.join(backupDirectory, path.basename(change.file));
      fs.writeFileSync(backup, change.before, { mode: 0o600 });
      if (!fs.statSync(backup).size || !fs.readFileSync(backup).equals(change.before)) throw Error('Configuration backup verification failed');
    }
  }
  const applied = [];
  try {
    for (const change of changes) { atomic(change.file, change.after); applied.push(change); }
  } catch (error) {
    for (const change of applied.reverse()) { if (change.before === null) fs.unlinkSync(change.file); else atomic(change.file, change.before); }
    throw error;
  }
  return { version: VERSION, targets, changed: true, backupDirectory, skills: SKILLS, configFiles };
}
module.exports = { VERSION, SKILLS, renderSkill, codexConfig, installWorkflow };
if (require.main === module) {
  try { process.stdout.write(json(installWorkflow())); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const VERSION = 1;
const OWNER = 'boost-codex-workflow';
const LEGACY_OWNER = 'better-codex-workflow';
const ALIAS = 'boost_codex_workflow';
const LEGACY_ALIAS = 'better_codex_workflow';
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
  const prefix = 'mcp__boost_codex_workflow__';
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
  const aliases = [ALIAS, LEGACY_ALIAS];
  const matches = tables.filter(table => aliases.some(alias => table.key === 'mcp_servers.' + alias || table.key.startsWith('mcp_servers.' + alias + '.')));
  // Inline or array-table spellings must not hide either a legacy or new collision.
  for (const line of lines) {
    const assignment = line.match(/^\s*([^=#]+)=/);
    const key = assignment?.[1].replace(/["'\s]/g, '');
    if (key === 'mcp_servers' || aliases.some(alias => key === alias || key?.startsWith(alias + '.') || key === 'mcp_servers.' + alias || key?.startsWith('mcp_servers.' + alias + '.'))) throw Error('Conflicting inline Codex MCP configuration');
    if (/^\s*\[\[/.test(line) && aliases.some(alias => line.replace(/["'\s]/g, '').includes('mcp_servers.' + alias))) throw Error('Conflicting Codex MCP table');
  }
  if (matches.length > 1 || (matches.length === 1 && !aliases.some(alias => matches[0].key === 'mcp_servers.' + alias))) throw Error('Conflicting Codex MCP table');
  const block = '[mcp_servers.' + ALIAS + ']\n# ' + OWNER + ' managed v' + VERSION + '\ncommand = ' + JSON.stringify(entry.command) + '\nargs = ' + JSON.stringify(entry.args) + '\n';
  if (!matches.length) {
    return { text: source + (source && !source.endsWith('\n') ? '\n' : '') + (source ? '\n' : '') + block, managedHash: hash(block) };
  }
  const table = matches[0];
  const next = tables.find(other => other.i > table.i);
  const end = next ? next.i : lines.length;
  const original = lines.slice(table.i, end).join('');
  const normalized = original.trimEnd() + '\n';
  if (!owned || table.key !== 'mcp_servers.' + owned.alias || hash(normalized) !== owned.hash) throw Error('Codex workflow configuration is not owned or was edited');
  return { text: lines.slice(0, table.i).join('') + block + (next ? '\n' : '') + lines.slice(end).join(''), managedHash: hash(block) };
}
function installWorkflow(options = {}) {
  const userHome = path.resolve(options.userHome || os.homedir());
  const dataHome = path.resolve(options.dataHome || process.env.BOOST_CODEX_HOME || process.env.BETTER_CODEX_HOME || path.join(userHome, '.better-codex'));
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
  if (![OWNER, LEGACY_OWNER].includes(previous.owner) || previous.version !== VERSION || !previous.configs || typeof previous.configs !== 'object' || Array.isArray(previous.configs)) throw Error('Unsupported installation manifest');
  const previousConfigs = Object.fromEntries(Object.entries(previous.configs).map(([client, config]) => [client, { ...config, alias: config.alias || (previous.owner === LEGACY_OWNER ? LEGACY_ALIAS : ALIAS) }]));
  const ledger = { ...previous, owner: OWNER, repoRoot, nodePath, configs: { ...previousConfigs } };
  const changes = [];
  const configFiles = [];
  function plan(file, value) {
    safeFile(file);
    const before = exists(file) ? fs.readFileSync(file) : null;
    const after = value === null ? null : Buffer.from(value);
    if ((before === null) !== (after === null) || (before !== null && !before.equals(after))) changes.push({ file, before, after });
  }
  for (const client of targets) {
    const skillsRoot = path.join(userHome, client === 'codex' ? '.agents' : '.claude', 'skills');
    for (const name of SKILLS) {
      const folder = path.join(skillsRoot, name);
      safeFile(folder);
      const manifestFile = path.join(folder, '.' + OWNER + '.json');
      const legacyManifestFile = path.join(folder, '.' + LEGACY_OWNER + '.json');
      safeFile(manifestFile); safeFile(legacyManifestFile);
      const files = renderSkill(repoRoot, name, client);
      if (exists(folder)) {
        if (exists(manifestFile) && exists(legacyManifestFile)) throw Error('Conflicting skill ownership markers: ' + name);
        const activeManifestFile = exists(manifestFile) ? manifestFile : legacyManifestFile;
        if (!exists(activeManifestFile)) throw Error('Refusing to overwrite an unmanaged skill: ' + name + ' (' + client + ')');
        const previousSkill = readJson(activeManifestFile);
        const expectedOwner = activeManifestFile === manifestFile ? OWNER : LEGACY_OWNER;
        if (previousSkill.owner !== expectedOwner || previousSkill.version !== VERSION || previousSkill.skill !== name || previousSkill.client !== client) throw Error('Unsupported skill ownership: ' + name);
        if (!previousSkill.files || typeof previousSkill.files !== 'object' || Array.isArray(previousSkill.files)) throw Error('Invalid skill file manifest');
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
      if (exists(legacyManifestFile)) plan(legacyManifestFile, null);
    }
    const entry = { command: nodePath, args: [manager, 'mcp', '--client', client] };
    if (client === 'codex') {
      const file = path.join(userHome, '.codex/config.toml');
      safeFile(file);
      const owned = previousConfigs.codex?.path === file ? previousConfigs.codex : undefined;
      const result = codexConfig(exists(file) ? fs.readFileSync(file, 'utf8') : '', entry, owned);
      plan(file, result.text);
      ledger.configs.codex = { path: file, alias: ALIAS, hash: result.managedHash };
      configFiles.push(file);
    } else {
      const file = path.join(userHome, '.claude.json');
      safeFile(file);
      const config = exists(file) ? readJson(file) : {};
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid Claude user configuration');
      if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw Error('Invalid Claude MCP servers');
      for (const alias of [ALIAS, LEGACY_ALIAS]) {
        const current = config.mcpServers?.[alias];
        const owned = previousConfigs.claude;
        if (current !== undefined && (!owned || owned.path !== file || owned.alias !== alias || hash(json(current)) !== owned.hash)) throw Error('Claude workflow configuration is not owned or was edited');
      }
      const servers = { ...config.mcpServers, [ALIAS]: entry };
      delete servers[LEGACY_ALIAS];
      const merged = { ...config, mcpServers: servers };
      if (!same(config, merged)) plan(file, json(merged));
      ledger.configs.claude = { path: file, alias: ALIAS, hash: hash(json(entry)) };
      configFiles.push(file);
    }
  }
  plan(ledgerFile, json(ledger));
  if (!changes.length) return { version: VERSION, targets, changed: false, backupDirectory: null, skills: SKILLS, configFiles };
  // Complete all ownership checks before backing up or mutating any user file.
  const existingChanges = changes.filter(change => change.before !== null);
  let backupDirectory = null;
  if (existingChanges.length) {
    backupDirectory = path.join(dataHome, 'backups/workflow-install-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID());
    safeFile(backupDirectory);
    fs.mkdirSync(backupDirectory, { recursive: true });
    const recovery = [];
    for (const [index, change] of existingChanges.entries()) {
      const backupName = configFiles.includes(change.file) ? path.basename(change.file) : path.join('managed', String(index), path.basename(change.file));
      const backup = path.join(backupDirectory, backupName);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, change.before, { mode: 0o600 });
      if (!fs.readFileSync(backup).equals(change.before)) throw Error('Configuration backup verification failed');
      recovery.push({ path: change.file, backup: backupName, hash: hash(change.before) });
    }
    atomic(path.join(backupDirectory, 'restore-manifest.json'), json({ owner: OWNER, version: VERSION, files: recovery }));
  }
  const applied = [];
  try {
    for (const change of changes) { if (change.after === null) fs.unlinkSync(change.file); else atomic(change.file, change.after); applied.push(change); }
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

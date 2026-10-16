'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SKILLS, installWorkflow } = require('../integration/workflow-install.cjs');
const { TOOL_DEFINITIONS } = require('../src/backend/workflow-mcp.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workflow-install-'));
const repoRoot = path.join(root, '项目 with spaces');
const userHome = path.join(root, '用户 home');
const dataHome = path.join(userHome, '.better-codex');
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const digest = content => crypto.createHash('sha256').update(content).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => put(file, JSON.stringify(value, null, 2) + '\n');
const snapshot = folder => Object.fromEntries(fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const file = path.join(entry.parentPath, entry.name); return [file, digest(fs.readFileSync(file))];
}));
// Recreate the exact legacy ownership format from an isolated installation.
function legacyInstallation(options) {
  installWorkflow(options);
  for (const client of ['codex', 'claude']) for (const name of SKILLS) {
    const folder = path.join(options.userHome, client === 'codex' ? '.agents' : '.claude', 'skills', name);
    const marker = path.join(folder, '.boost-codex-workflow.json');
    const manifest = readJson(marker); manifest.owner = 'better-codex-workflow';
    for (const relative of Object.keys(manifest.files)) {
      const file = path.join(folder, relative);
      const content = fs.readFileSync(file, 'utf8').replaceAll('boostCodex', 'Better Codex').replaceAll('boost_codex_workflow', 'better_codex_workflow');
      put(file, content); manifest.files[relative] = digest(content);
    }
    writeJson(path.join(folder, '.better-codex-workflow.json'), manifest); fs.unlinkSync(marker);
  }
  const codex = path.join(options.userHome, '.codex/config.toml');
  const toml = fs.readFileSync(codex, 'utf8').replaceAll('boost_codex_workflow', 'better_codex_workflow').replaceAll('boost-codex-workflow', 'better-codex-workflow');
  put(codex, toml);
  const claude = path.join(options.userHome, '.claude.json'); const config = readJson(claude);
  config.mcpServers.better_codex_workflow = config.mcpServers.boost_codex_workflow; delete config.mcpServers.boost_codex_workflow; writeJson(claude, config);
  const ledgerFile = path.join(options.dataHome, 'run/workflow-install-manifest.json'); const ledger = readJson(ledgerFile);
  ledger.owner = 'better-codex-workflow'; delete ledger.configs.codex.alias; delete ledger.configs.claude.alias;
  ledger.configs.codex.hash = digest(toml.slice(toml.indexOf('[mcp_servers.better_codex_workflow]')).trimEnd() + '\n');
  ledger.configs.claude.hash = digest(JSON.stringify(config.mcpServers.better_codex_workflow, null, 2) + '\n'); writeJson(ledgerFile, ledger);
}
try {
  put(path.join(repoRoot, 'src/skills/workflow-common.md'), fs.readFileSync(path.resolve(__dirname, '../src/skills/workflow-common.md')));
  for (const name of SKILLS) put(path.join(repoRoot, 'src/skills', name, 'SKILL.md'), fs.readFileSync(path.resolve(__dirname, '../src/skills', name, 'SKILL.md')));
  put(path.join(repoRoot, 'integration/workflow-service.cjs'), '// fixture stable entry\n');
  const codex = path.join(userHome, '.codex/config.toml'); const claude = path.join(userHome, '.claude.json');
  const originalToml = 'model = "existing"\n[mcp_servers.unrelated]\ncommand = "kept"\nargs = ["private-test-value"]\n';
  const originalClaude = { theme: 'dark', mcpServers: { unrelated: { command: 'kept', env: { PRIVATE: 'private-test-value' } } }, projects: { '/other': { allowedTools: ['x'] } } };
  put(codex, originalToml); put(claude, JSON.stringify(originalClaude));
  const options = { repoRoot, userHome, dataHome, nodePath: process.execPath };
  const result = installWorkflow(options); assert.equal(result.changed, true); assert.ok(result.backupDirectory);
  assert.equal(fs.readFileSync(path.join(result.backupDirectory, 'config.toml'), 'utf8'), originalToml);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.backupDirectory, '.claude.json'), 'utf8')), originalClaude);
  assert.ok(fs.readFileSync(codex, 'utf8').startsWith(originalToml));
  const merged = JSON.parse(fs.readFileSync(claude, 'utf8'));
  assert.deepEqual(merged.mcpServers.unrelated, originalClaude.mcpServers.unrelated); assert.deepEqual(merged.projects, originalClaude.projects);
  assert.deepEqual(merged.mcpServers.boost_codex_workflow.args, [path.join(repoRoot, 'integration/workflow-service.cjs'), 'mcp', '--client', 'claude']);
  assert.equal(merged.mcpServers.boost_codex_workflow.command, path.resolve(process.execPath));
  for (const name of SKILLS) {
    const codexFolder = path.join(userHome, '.agents/skills', name); const claudeFolder = path.join(userHome, '.claude/skills', name);
    const codexBody = fs.readFileSync(path.join(codexFolder, 'SKILL.md'), 'utf8'); const claudeBody = fs.readFileSync(path.join(claudeFolder, 'SKILL.md'), 'utf8');
    assert.ok(codexBody.includes('mcp__boost_codex_workflow__bc_context'));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(codexBody)); assert.ok(!/\{\{[A-Z_]+\}\}/.test(claudeBody));
    assert.equal(fs.readFileSync(path.join(codexFolder, 'agents/openai.yaml'), 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
    assert.match(claudeBody.split('\n---\n')[0], /disable-model-invocation: true/);
    const callableTools = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
    for (const match of codexBody.matchAll(/mcp__boost_codex_workflow__(bc_[a-z_]+)/g)) assert.ok(callableTools.has(match[1]), 'Unavailable skill tool: ' + match[1]);
    for (const match of claudeBody.matchAll(/mcp__boost_codex_workflow__(bc_[a-z_]+)/g)) assert.ok(callableTools.has(match[1]), 'Unavailable skill tool: ' + match[1]);
    assert.ok(!codexBody.includes('章程')); assert.ok(!claudeBody.includes('章程'));
  }
  const bytes = fs.readFileSync(codex); const second = installWorkflow(options); assert.equal(second.changed, false); assert.equal(second.backupDirectory, null); assert.ok(fs.readFileSync(codex).equals(bytes));
  // Updates to the single source update both clients, preserve user fields and back up changes.
  const source = path.join(repoRoot, 'src/skills/bc-plan/SKILL.md'); fs.appendFileSync(source, '\nScoped update.\n');
  assert.equal(installWorkflow(options).changed, true);
  assert.ok(fs.readFileSync(path.join(userHome, '.claude/skills/bc-plan/SKILL.md'), 'utf8').endsWith('Scoped update.\n'));
  assert.equal(installWorkflow(options).changed, false);
  const managedSkill = path.join(userHome, '.agents/skills/bc-charter/SKILL.md'); fs.appendFileSync(managedSkill, '\nUser edit.\n');
  const untouched = fs.readFileSync(claude); assert.throws(() => installWorkflow(options), /local changes/); assert.ok(fs.readFileSync(claude).equals(untouched));
  const conflictHome = path.join(root, 'conflict');
  put(path.join(conflictHome, '.claude.json'), JSON.stringify({ mcpServers: { better_codex_workflow: { command: 'user-owned' } } }));
  assert.throws(() => installWorkflow({ ...options, userHome: conflictHome, dataHome: path.join(conflictHome, '.better-codex') }), /not owned/);
  assert.equal(fs.existsSync(path.join(conflictHome, '.agents/skills/bc-charter/SKILL.md')), false);
  const skillConflict = path.join(root, 'skill-conflict'); put(path.join(skillConflict, '.agents/skills/bc-charter/SKILL.md'), 'user skill');
  assert.throws(() => installWorkflow({ ...options, userHome: skillConflict, dataHome: path.join(skillConflict, '.better-codex') }), /unmanaged skill/);
  const inlineConflict = path.join(root, 'inline-conflict'); put(path.join(inlineConflict, '.codex/config.toml'), 'mcp_servers = { better_codex_workflow = { command = "user" } }\n');
  assert.throws(() => installWorkflow({ ...options, userHome: inlineConflict, dataHome: path.join(inlineConflict, '.better-codex'), targets: ['codex'] }), /inline/);
  for (const client of ['codex', 'claude']) for (const alias of ['better_codex_workflow', 'boost_codex_workflow']) {
    const home = path.join(root, 'unowned-' + client + '-' + alias);
    if (client === 'codex') put(path.join(home, '.codex/config.toml'), '[mcp_servers.' + alias + ']\ncommand = "user"\n');
    else writeJson(path.join(home, '.claude.json'), { mcpServers: { [alias]: { command: 'user' } } });
    const before = snapshot(home);
    assert.throws(() => installWorkflow({ ...options, userHome: home, dataHome: path.join(home, '.better-codex') }), /not owned/);
    assert.deepEqual(snapshot(home), before, 'Unowned ' + alias + ' must prevent every write');
  }
  const migratedHome = path.join(root, 'legacy-migration');
  const migrationOptions = { ...options, userHome: migratedHome, dataHome: path.join(migratedHome, '.better-codex') };
  put(path.join(migratedHome, '.codex/config.toml'), originalToml); writeJson(path.join(migratedHome, '.claude.json'), originalClaude);
  legacyInstallation(migrationOptions);
  const unrelatedTail = '\n[mcp_servers.another]\ncommand = "preserve-tail"\n';
  fs.appendFileSync(path.join(migratedHome, '.codex/config.toml'), unrelatedTail);
  const beforeMigration = snapshot(migratedHome);
  const migrated = installWorkflow(migrationOptions); assert.equal(migrated.changed, true); assert.ok(migrated.backupDirectory);
  const recovery = readJson(path.join(migrated.backupDirectory, 'restore-manifest.json'));
  for (const entry of recovery.files) {
    assert.equal(digest(fs.readFileSync(path.join(migrated.backupDirectory, entry.backup))), beforeMigration[entry.path]);
    assert.equal(entry.hash, beforeMigration[entry.path]);
  }
  const backedUp = new Set(recovery.files.map(entry => entry.path));
  for (const client of ['codex', 'claude']) for (const name of SKILLS) {
    const folder = path.join(migratedHome, client === 'codex' ? '.agents' : '.claude', 'skills', name);
    const legacyMarker = path.join(folder, '.better-codex-workflow.json'); const marker = path.join(folder, '.boost-codex-workflow.json');
    assert.equal(fs.existsSync(legacyMarker), false); assert.equal(readJson(marker).owner, 'boost-codex-workflow');
    assert.ok(backedUp.has(legacyMarker)); assert.ok(backedUp.has(path.join(folder, 'SKILL.md')));
    assert.ok(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8').includes('mcp__boost_codex_workflow__bc_context'));
  }
  const migratedToml = fs.readFileSync(path.join(migratedHome, '.codex/config.toml'), 'utf8');
  assert.ok(migratedToml.includes('[mcp_servers.boost_codex_workflow]')); assert.ok(!migratedToml.includes('better_codex_workflow'));
  assert.ok(migratedToml.startsWith(originalToml)); assert.ok(migratedToml.endsWith(unrelatedTail));
  const migratedClaude = readJson(path.join(migratedHome, '.claude.json'));
  assert.deepEqual(migratedClaude.projects, originalClaude.projects); assert.deepEqual(migratedClaude.mcpServers.unrelated, originalClaude.mcpServers.unrelated);
  assert.ok(migratedClaude.mcpServers.boost_codex_workflow); assert.equal(Object.hasOwn(migratedClaude.mcpServers, 'better_codex_workflow'), false);
  assert.ok(backedUp.has(path.join(migrationOptions.dataHome, 'run/workflow-install-manifest.json')));
  assert.equal(installWorkflow(migrationOptions).changed, false);
  // Selecting one client preserves the other client's legacy ownership until its own migration.
  const partialHome = path.join(root, 'partial-migration');
  const partialOptions = { ...options, userHome: partialHome, dataHome: path.join(partialHome, '.better-codex') };
  legacyInstallation(partialOptions);
  const legacyClaude = fs.readFileSync(path.join(partialHome, '.claude.json'));
  installWorkflow({ ...partialOptions, targets: ['codex'] });
  assert.ok(fs.readFileSync(path.join(partialHome, '.claude.json')).equals(legacyClaude));
  assert.equal(readJson(path.join(partialOptions.dataHome, 'run/workflow-install-manifest.json')).configs.claude.alias, 'better_codex_workflow');
  assert.equal(installWorkflow({ ...partialOptions, targets: ['codex'] }).changed, false);
  installWorkflow({ ...partialOptions, targets: ['claude'] }); assert.equal(installWorkflow(partialOptions).changed, false);
  // A second alias, edited old config or edited old skill blocks migration without any writes.
  for (const damage of ['codex-new-alias', 'claude-new-alias', 'codex-edited', 'claude-edited', 'skill-edited', 'marker-new-collision', 'marker-wrong-owner']) {
    const home = path.join(root, damage); const damagedOptions = { ...options, userHome: home, dataHome: path.join(home, '.better-codex') };
    legacyInstallation(damagedOptions);
    if (damage === 'codex-new-alias') fs.appendFileSync(path.join(home, '.codex/config.toml'), '\n[mcp_servers.boost_codex_workflow]\ncommand = "unowned"\n');
    if (damage === 'claude-new-alias' || damage === 'claude-edited') {
      const file = path.join(home, '.claude.json'); const config = readJson(file);
      if (damage === 'claude-new-alias') config.mcpServers.boost_codex_workflow = { command: 'unowned' };
      else config.mcpServers.better_codex_workflow.command = 'edited'; writeJson(file, config);
    }
    if (damage === 'codex-edited') fs.appendFileSync(path.join(home, '.codex/config.toml'), 'env = { USER_EDIT = "kept" }\n');
    if (damage === 'skill-edited') fs.appendFileSync(path.join(home, '.agents/skills/bc-charter/SKILL.md'), '\nUser edit.\n');
    if (damage === 'marker-new-collision') writeJson(path.join(home, '.agents/skills/bc-charter/.boost-codex-workflow.json'), { owner: 'unowned' });
    if (damage === 'marker-wrong-owner') {
      const file = path.join(home, '.agents/skills/bc-charter/.better-codex-workflow.json'); const marker = readJson(file); marker.owner = 'unowned'; writeJson(file, marker);
    }
    const before = snapshot(home); assert.throws(() => installWorkflow(damagedOptions), /Conflicting|not owned|local changes|ownership/);
    assert.deepEqual(snapshot(home), before, damage + ' must prevent every write');
  }
  const savedBoostHome = process.env.BOOST_CODEX_HOME; const savedBetterHome = process.env.BETTER_CODEX_HOME;
  try {
    const envHome = path.join(root, 'env-user'); const { dataHome: ignored, ...envOptions } = { ...options, userHome: envHome };
    process.env.BOOST_CODEX_HOME = path.join(root, 'boost-env-data'); process.env.BETTER_CODEX_HOME = path.join(root, 'legacy-env-data');
    installWorkflow(envOptions); assert.ok(fs.existsSync(path.join(process.env.BOOST_CODEX_HOME, 'run/workflow-install-manifest.json')));
    assert.equal(fs.existsSync(process.env.BETTER_CODEX_HOME), false);
    delete process.env.BOOST_CODEX_HOME;
    installWorkflow({ ...envOptions, userHome: path.join(root, 'legacy-env-user') }); assert.ok(fs.existsSync(path.join(process.env.BETTER_CODEX_HOME, 'run/workflow-install-manifest.json')));
    delete process.env.BETTER_CODEX_HOME;
    const defaultHome = path.join(root, 'default-user'); installWorkflow({ ...envOptions, userHome: defaultHome });
    assert.ok(fs.existsSync(path.join(defaultHome, '.better-codex/run/workflow-install-manifest.json'))); assert.equal(fs.existsSync(path.join(defaultHome, '.boost-codex')), false);
  } finally {
    if (savedBoostHome === undefined) delete process.env.BOOST_CODEX_HOME; else process.env.BOOST_CODEX_HOME = savedBoostHome;
    if (savedBetterHome === undefined) delete process.env.BETTER_CODEX_HOME; else process.env.BETTER_CODEX_HOME = savedBetterHome;
  }
  console.log('workflow-install: isolated two-client install, backups, legacy migration, partial migration, idempotence, environment compatibility and ownership conflicts passed');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('bc-workflow-install-'));
  fs.rmSync(root, { recursive: true, force: true });
}

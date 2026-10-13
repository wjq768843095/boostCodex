'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SKILLS, installWorkflow } = require('../integration/workflow-install.cjs');
const { TOOL_DEFINITIONS } = require('../src/backend/workflow-mcp.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workflow-install-'));
const repoRoot = path.join(root, '项目 with spaces');
const userHome = path.join(root, '用户 home');
const dataHome = path.join(userHome, '.better-codex');
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
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
  assert.deepEqual(merged.mcpServers.better_codex_workflow.args, [path.join(repoRoot, 'integration/workflow-service.cjs'), 'mcp', '--client', 'claude']);
  assert.equal(merged.mcpServers.better_codex_workflow.command, path.resolve(process.execPath));
  for (const name of SKILLS) {
    const codexFolder = path.join(userHome, '.agents/skills', name); const claudeFolder = path.join(userHome, '.claude/skills', name);
    const codexBody = fs.readFileSync(path.join(codexFolder, 'SKILL.md'), 'utf8'); const claudeBody = fs.readFileSync(path.join(claudeFolder, 'SKILL.md'), 'utf8');
    assert.ok(codexBody.includes('mcp__better_codex_workflow__bc_context'));
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(codexBody)); assert.ok(!/\{\{[A-Z_]+\}\}/.test(claudeBody));
    assert.equal(fs.readFileSync(path.join(codexFolder, 'agents/openai.yaml'), 'utf8'), 'policy:\n  allow_implicit_invocation: false\n');
    assert.match(claudeBody.split('\n---\n')[0], /disable-model-invocation: true/);
    const callableTools = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
    for (const match of codexBody.matchAll(/mcp__better_codex_workflow__(bc_[a-z_]+)/g)) assert.ok(callableTools.has(match[1]), 'Unavailable skill tool: ' + match[1]);
    for (const match of claudeBody.matchAll(/mcp__better_codex_workflow__(bc_[a-z_]+)/g)) assert.ok(callableTools.has(match[1]), 'Unavailable skill tool: ' + match[1]);
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
  console.log('workflow-install: isolated two-client install, backups, idempotence, shared-source update and ownership conflicts passed');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('bc-workflow-install-'));
  fs.rmSync(root, { recursive: true, force: true });
}

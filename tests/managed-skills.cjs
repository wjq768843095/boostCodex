'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createManagedSkills } = require('../src/modules/managed-skills.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'better-codex-skills-test-'));
const db = new DatabaseSync(':memory:');
const home = path.join(temporary, 'data');
const userHome = path.join(temporary, 'user');
const root = path.join(userHome, '.agents', 'skills');
const codexHome = path.join(userHome, '.codex');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const snapshot = folder => {
  const files = {};
  if (!fs.existsSync(folder)) return files;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) for (const [child, value] of Object.entries(snapshot(file))) files[path.join(entry.name, child)] = value;
    else files[entry.name] = fs.readFileSync(file).toString('base64');
  }
  return files;
};
try {
  db.exec(`CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,role TEXT,name TEXT,description TEXT,instructions TEXT,model TEXT,reasoning_effort TEXT,sandbox_mode TEXT,max_concurrency INTEGER);
    CREATE TABLE issues(id TEXT PRIMARY KEY,agent_id TEXT);
    INSERT INTO agent_profiles VALUES('legacy-agent','legacy-role','旧项目规划师','','检查需求后规划任务','original-model','high','workspace-write',3);
    INSERT INTO issues VALUES('issue-1','legacy-agent');`);
  const legacyBefore = db.prepare('SELECT * FROM agent_profiles').all();
  const associationsBefore = db.prepare('SELECT * FROM issues').all();
  write(path.join(codexHome, 'config.toml'), 'model = "native-model"\nsandbox_mode = "workspace-write"\n');
  write(path.join(codexHome, 'skills', 'outside', 'SKILL.md'), '---\nname: native-outside\ndescription: >\n  A native Skill\n  kept outside management.\n---\n\nExternal instructions.');
  write(path.join(codexHome, 'skills', '.system', 'nested', 'SKILL.md'), '---\nname: nested\ndescription: "Nested native Skill"\n---\nExternal instructions.');
  write(path.join(root, 'external', 'SKILL.md'), '---\nname: external\ndescription: "Unmanaged user Skill"\n---\nExternal instructions.');
  write(path.join(root, 'external', 'auth.json'), 'not-a-real-secret-must-not-be-read-or-changed');
  const nativeBefore = snapshot(codexHome);
  const externalBefore = snapshot(path.join(root, 'external'));
  const store = createManagedSkills({ db, home, userHome, codexHome });
  assert.equal(store.list().managed.length, 3);
  assert.deepEqual(store.list().managed.filter(skill => skill.builtin).map(skill => skill.name).sort(), ['任务规划', '项目总纲']);
  const migrated = store.list().managed.find(skill => skill.legacy_agent_id === 'legacy-agent');
  assert.equal(migrated.name, '旧项目规划师');
  assert.equal(migrated.description, '');
  assert.equal(migrated.instructions, '检查需求后规划任务');
  for (const key of ['model', 'reasoning_effort', 'service_tier', 'sandbox_mode', 'max_concurrency', 'fast']) assert.equal(key in migrated, false);
  assert.equal(store.migrate().inserted, 0);
  assert.equal(createManagedSkills({ db, home, userHome, codexHome }).migrate().inserted, 0);
  assert.deepEqual(db.prepare('SELECT * FROM agent_profiles').all(), legacyBefore);
  assert.deepEqual(db.prepare('SELECT * FROM issues').all(), associationsBefore);
  const external = store.list().external;
  assert.equal(external.length, 3);
  assert.equal(external.find(skill => skill.name === 'native-outside').description, 'A native Skill kept outside management.');
  assert.ok(external.every(skill => !skill.managed && skill.instructions === ''));
  assert.throws(() => store.save({ id: external[0].id, instructions: 'replace' }), /external_skill_read_only/);
  assert.throws(() => store.delete(external[0].id), /external_skill_read_only/);
  assert.throws(() => store.save({ name: 'bad', slug: '../escape', instructions: 'bad' }), /slug_invalid/);
  assert.throws(() => store.delete('better-codex-charter'), /builtin_skill_delete_forbidden/);
  const first = store.exportOwned();
  assert.equal(first.exported.length, 3);
  assert.equal(first.conflicts.length, 0);
  assert.ok(fs.readFileSync(migrated.path, 'utf8').includes('description: "按旧项目规划师提供工作指导。"'));
  assert.equal(store.get(migrated.id).description, '');
  assert.equal(db.prepare('SELECT description FROM agent_profiles WHERE id=?').get('legacy-agent').description, '');
  assert.equal(store.list().external.length, 3);
  const firstFiles = snapshot(root);
  assert.equal(store.exportOwned().unchanged.length, 3);
  assert.deepEqual(snapshot(root), firstFiles);
  assert.equal(fs.existsSync(path.join(home, 'backups')), false);
  const originalCharter = store.get('better-codex-charter');
  const charter = store.save({ id: originalCharter.id, instructions: `${originalCharter.instructions}\n\n已确认的本地调整。` }, { expectedVersion: originalCharter.version });
  assert.equal(charter.version, 2);
  assert.throws(() => store.save({ id: charter.id, name: 'stale' }, { expectedVersion: 1 }), /version_conflict/);
  assert.equal(store.exportOwned().exported.length, 1);
  const backupsAfterUpdate = snapshot(path.join(home, 'backups', 'managed-skills'));
  assert.equal(Object.keys(backupsAfterUpdate).length, 2);
  assert.ok(Object.values(backupsAfterUpdate).some(content => Buffer.from(content, 'base64').toString('utf8').includes(originalCharter.instructions)));
  store.migrate();
  assert.equal(store.get(charter.id).version, 2);
  assert.equal(store.get(charter.id).instructions, charter.instructions);
  // A same-name user directory is never claimed or overwritten, even without SKILL.md.
  const conflict = store.save({ name: '冲突', slug: 'better-codex-conflict', instructions: 'instruction' });
  write(path.join(root, conflict.slug, 'SKILL.md'), '---\nname: conflict\ndescription: external owner\n---\nDo not overwrite.');
  const conflictingBefore = snapshot(path.join(root, conflict.slug));
  assert.deepEqual(store.exportOwned().conflicts.map(item => item.id), [conflict.id]);
  store.delete(conflict.id, { expectedVersion: conflict.version });
  assert.deepEqual(snapshot(path.join(root, conflict.slug)), conflictingBefore);
  const custom = store.save({ name: '自定义', description: '说明', slug: 'better-codex-custom', instructions: '第一版', model: 'ignored-model' });
  assert.equal('model' in custom, false);
  assert.ok(store.exportOwned().exported.includes(custom.id));
  write(path.join(root, custom.slug, 'external-note.txt'), 'leave additional resources untouched');
  const customUpdated = store.save({ id: custom.id, slug: 'better-codex-renamed', instructions: '第二版' }, { expectedVersion: 1 });
  assert.ok(store.exportOwned().exported.includes(custom.id));
  assert.equal(fs.existsSync(path.join(root, custom.slug, 'SKILL.md')), false);
  assert.equal(fs.readFileSync(path.join(root, custom.slug, 'external-note.txt'), 'utf8'), 'leave additional resources untouched');
  assert.throws(() => store.delete(custom.id, { expectedVersion: 1 }), /version_conflict/);
  store.delete(custom.id, { expectedVersion: customUpdated.version });
  assert.equal(fs.existsSync(path.join(root, customUpdated.slug)), false);
  assert.equal(store.get(custom.id), null);
  // Exported text is not imported into the database; the DB is authoritative.
  fs.writeFileSync(charter.path, 'manual exported modification');
  assert.equal(store.get(charter.id).instructions, charter.instructions);
  store.exportOwned();
  assert.ok(fs.readFileSync(charter.path, 'utf8').includes(charter.instructions));
  // Deleting a migrated Skill does not delete the role or allow migration to revive it.
  store.delete(migrated.id, { expectedVersion: 1 });
  assert.equal(store.migrate().inserted, 0);
  assert.equal(store.get(migrated.id), null);
  assert.deepEqual(db.prepare('SELECT * FROM agent_profiles').all(), legacyBefore);
  assert.deepEqual(db.prepare('SELECT * FROM issues').all(), associationsBefore);
  assert.deepEqual(snapshot(codexHome), nativeBefore);
  assert.deepEqual(snapshot(path.join(root, 'external')), externalBefore);
  // A different database cannot claim a previously exported Better Codex directory.
  const otherDb = new DatabaseSync(':memory:');
  try {
    const other = createManagedSkills({ db: otherDb, home: path.join(temporary, 'other-data'), userHome, codexHome });
    const before = snapshot(root);
    assert.equal(other.exportOwned().conflicts.length, 2);
    assert.deepEqual(snapshot(root), before);
  } finally { otherDb.close(); }
  // A hardlink inserted into an owned directory must not cause writes outside it.
  const hardlinkSkill = store.save({ name: '硬链接测试', slug: 'better-codex-hardlink', instructions: 'managed content' });
  store.exportOwned();
  const hardlinkTarget = path.join(temporary, 'hardlink-target.txt');
  write(hardlinkTarget, 'outside hardlink target');
  fs.unlinkSync(hardlinkSkill.path);
  fs.linkSync(hardlinkTarget, hardlinkSkill.path);
  store.exportOwned();
  assert.equal(fs.readFileSync(hardlinkTarget, 'utf8'), 'outside hardlink target');
  assert.ok(fs.readFileSync(hardlinkSkill.path, 'utf8').includes('managed content'));
  store.delete(hardlinkSkill.id);
  assert.equal(fs.readFileSync(hardlinkTarget, 'utf8'), 'outside hardlink target');
  // Symlinked Skill files are rejected without touching the link target.
  const linkSkill = store.save({ name: '链接测试', slug: 'better-codex-link', instructions: 'owned' });
  store.exportOwned();
  const linkTarget = path.join(temporary, 'link-target.txt');
  write(linkTarget, 'outside target');
  fs.unlinkSync(linkSkill.path);
  try {
    fs.symlinkSync(linkTarget, linkSkill.path, 'file');
    assert.equal(store.exportOwned().conflicts.find(item => item.id === linkSkill.id).reason, 'skill_export_path_conflict');
    assert.throws(() => store.delete(linkSkill.id), /skill_export_path_conflict/);
    assert.equal(fs.readFileSync(linkTarget, 'utf8'), 'outside target');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('NOTE: symlink creation unavailable; all other ownership invariants tested.');
  }
  // Upgrade untracked initial defaults by exact known hashes, then track future defaults.
  const upgradeDb = new DatabaseSync(':memory:');
  try {
    const upgradeHome = path.join(temporary, 'template-upgrade-data');
    const upgradeUser = path.join(temporary, 'template-upgrade-user');
    const templateDir = path.join(temporary, 'template-fixtures');
    const templates = {};
    for (const id of ['better-codex-charter', 'better-codex-plan']) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'skills', id, 'SKILL.md'), 'utf8');
      const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
      templates[id] = { source, body };
      write(path.join(templateDir, id, 'SKILL.md'), source);
    }
    const upgradeStore = createManagedSkills({ db: upgradeDb, home: upgradeHome, userHome: upgradeUser, templatesDir: templateDir });
    const previousCharter = templates['better-codex-charter'].body
      .replace('工具中的确认参数是 `message_id`，取自 `project_context_read` 返回的 `confirmation_candidates[].event_id`；不得虚构消息标识或仅凭助手回复确认。\n\n', '')
      .replace('保存目录证据时，保留正文的 `directories` 章节，并在总纲的 `metadata.workspace_map` 中用数组格式镜像项目已经关联的目录：每项包含原始 `path`、经证据核实的职责 `role` 和权威性质 `source_of_truth`。权威性质可以说明本地源码、线上映射、快照或 `unknown`；职责或权威尚不明确时使用 `unknown` 并列为待确认。仅使用 `project_context_read` 返回的已关联目录，按规范真实路径对应，不增加目录、不扩大读取或写入范围、不更改权限；关联目录缺失时保留其原路径和待核对状态，不把快照自动认定为线上权威。\n\n', '');
    const previousPlan = templates['better-codex-plan'].body
      .replace('用户明确选择需要转换的规划项后，调用 `project_plan_convert`，传入 `project_id`、`thread_id`、当前计划的 `expected_revision` 和选择的稳定任务编号 `item_ids`。', '用户明确授权把当前计划转为任务后，调用 `project_plan_convert`，传入 `project_id`、`thread_id`、当前计划的 `expected_revision` 和工具声明要求的实际用户消息标识。')
      .replace('总纲或计划更新不会自动覆盖已经转换的任务。只有用户明确选择更新其规划资料时，重新读取 `project_context_read` 的任务版本，使用 `action: update`，并在 `issue_versions` 中按规划项编号提供关联任务的当前版本。已开始执行的任务若拒绝修改，报告实际限制，不重建任务或改写其聊天。\n\n', '');
    assert.notEqual(previousCharter, templates['better-codex-charter'].body);
    assert.notEqual(previousPlan, templates['better-codex-plan'].body);
    // Emulate the previously shipped DB: old default bodies, no template-hash settings.
    upgradeDb.prepare("DELETE FROM managed_skill_settings WHERE key LIKE 'builtin_template_hash:%'").run();
    upgradeDb.prepare('UPDATE managed_skills SET instructions=? WHERE id=?').run(previousCharter.replace(/\n/g, '\r\n'), 'better-codex-charter');
    upgradeDb.prepare('UPDATE managed_skills SET instructions=? WHERE id=?').run(previousPlan, 'better-codex-plan');
    assert.equal(upgradeStore.exportOwned().exported.length, 2);
    const upgrade = upgradeStore.migrate();
    assert.deepEqual(upgrade.upgraded.sort(), ['better-codex-charter', 'better-codex-plan']);
    assert.deepEqual(upgrade.preserved, []);
    for (const id of upgrade.upgraded) {
      assert.equal(upgradeStore.get(id).instructions, templates[id].body);
      assert.equal(upgradeStore.get(id).version, 2);
    }
    assert.equal(upgradeStore.exportOwned().exported.length, 2);
    const upgradeBackups = snapshot(path.join(upgradeHome, 'backups', 'managed-skills'));
    assert.equal(Object.keys(upgradeBackups).length, 4);
    assert.ok(Object.values(upgradeBackups).some(content => Buffer.from(content, 'base64').toString('utf8').includes(previousPlan)));
    assert.deepEqual(upgradeStore.migrate().upgraded, []);
    assert.equal(upgradeStore.exportOwned().unchanged.length, 2);
    assert.deepEqual(snapshot(path.join(upgradeHome, 'backups', 'managed-skills')), upgradeBackups);
    // Custom instructions stay untouched; customized names/descriptions survive default updates.
    const customized = upgradeStore.save({ id: 'better-codex-charter', name: '用户总纲名称', description: '用户总纲说明', instructions: '用户定制规则，不能用模板覆盖。' });
    const namedPlan = upgradeStore.save({ id: 'better-codex-plan', name: '用户规划名称', description: '用户规划说明' });
    upgradeStore.exportOwned();
    for (const [id, template] of Object.entries(templates)) write(path.join(templateDir, id, 'SKILL.md'), `${template.source.trim()}\n\n下一版默认模板规则。\n`);
    const nextUpgrade = upgradeStore.migrate();
    assert.deepEqual(nextUpgrade.upgraded, ['better-codex-plan']);
    assert.deepEqual(nextUpgrade.preserved, ['better-codex-charter']);
    assert.deepEqual(upgradeStore.get(customized.id), customized);
    const upgradedPlan = upgradeStore.get(namedPlan.id);
    assert.equal(upgradedPlan.version, namedPlan.version + 1);
    assert.equal(upgradedPlan.name, namedPlan.name);
    assert.equal(upgradedPlan.description, namedPlan.description);
    assert.ok(upgradedPlan.instructions.endsWith('下一版默认模板规则。'));
    const beforeNextExport = snapshot(path.join(upgradeHome, 'backups', 'managed-skills'));
    assert.deepEqual(upgradeStore.exportOwned().exported, ['better-codex-plan']);
    assert.equal(Object.keys(snapshot(path.join(upgradeHome, 'backups', 'managed-skills'))).length, Object.keys(beforeNextExport).length + 2);
    const reopened = createManagedSkills({ db: upgradeDb, home: upgradeHome, userHome: upgradeUser, templatesDir: templateDir });
    assert.deepEqual(reopened.get(customized.id), customized);
    assert.deepEqual(reopened.get(namedPlan.id), upgradedPlan);
    assert.deepEqual(reopened.migrate().upgraded, []);
    // Missing history cannot turn arbitrary customized instructions into a trusted baseline.
    upgradeDb.prepare('DELETE FROM managed_skill_settings WHERE key=?').run('builtin_template_hash:better-codex-charter');
    assert.ok(reopened.migrate().preserved.includes(customized.id));
    assert.equal(upgradeDb.prepare('SELECT value FROM managed_skill_settings WHERE key=?').get('builtin_template_hash:better-codex-charter'), undefined);
    assert.deepEqual(reopened.get(customized.id), customized);
    console.log('PASS: both initial defaults upgraded, recorded-hash future upgrades, customized instructions/name/description preserved, unrecognized baseline rejected, version/idempotency and owned-file backups verified');
  } finally { upgradeDb.close(); }
  console.log('PASS: isolated Skill migration, stable DB authority, native configuration/role preservation, external read-only metadata, ownership conflicts, idempotent export, affected-file backups, rename/delete boundaries, optimistic versions');
} finally {
  db.close();
  // The resolved directory comes from mkdtemp under the OS temporary directory.
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), 'better-codex-skills-test-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}

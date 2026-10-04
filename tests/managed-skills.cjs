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
    // Fixed shipped bodies keep adoption tests independent of current Skill wording.
    const previousCharter = fs.readFileSync(path.join(__dirname, 'fixtures', 'skills', 'better-codex-charter-initial.md'), 'utf8').trim();
    const previousPlan = fs.readFileSync(path.join(__dirname, 'fixtures', 'skills', 'better-codex-plan-initial.md'), 'utf8').trim();
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
  // Project Skills derive complete resources without changing their read-only sources.
  const projectA = path.join(temporary, 'project-a');
  const projectB = path.join(temporary, 'project-b');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  const projectResolver = id => ({ a: { id: 'a', workspace_path: projectA }, b: { id: 'b', workspace_path: projectB }, shared: { id: 'shared', workspace_path: projectA } })[id];
  let includeSharedProject = false;
  const listProjects = () => (includeSharedProject ? ['a', 'b', 'shared'] : ['a', 'b']).map(projectResolver);
  const projectStore = createManagedSkills({ db, home, userHome, codexHome, resolveProject: projectResolver, listProjects });
  const global = projectStore.get('better-codex-plan');
  const fromGlobal = projectStore.derive({ source_skill_id: global.id, project_id: 'a', name: 'A 项目规划' });
  assert.equal(fromGlobal.scope, 'project');
  assert.equal(fromGlobal.source_skill_id, global.id);
  assert.equal(fromGlobal.source_version, global.version);
  assert.equal(fromGlobal.source_update_available, false);
  assert.equal(projectStore.list().managed.some(skill => skill.id === fromGlobal.id), false);
  assert.ok(projectStore.list({ projectId: 'a' }).managed.some(skill => skill.id === fromGlobal.id));
  assert.equal(projectStore.list({ projectId: 'b' }).managed.some(skill => skill.id === fromGlobal.id), false);
  assert.ok(projectStore.list({ includeAllProjects: true }).managed.some(skill => skill.id === fromGlobal.id));
  assert.throws(() => projectStore.assertAvailable(fromGlobal.id, 'b'), /skill_project_mismatch/);
  assert.throws(() => projectStore.assertAvailable(fromGlobal.id, null), /skill_project_mismatch/);
  assert.throws(() => projectStore.derive({ source_skill_id: fromGlobal.id, project_id: 'b' }), /skill_project_mismatch/);
  assert.throws(() => projectStore.save({ id: fromGlobal.id, scope: 'global', project_id: null }), /skill_scope/);
  assert.throws(() => projectStore.save({ scope: 'project', project_id: 'unknown', name: 'x', instructions: 'x' }), /skill_project_not_found/);
  const projectExport = projectStore.exportOwned();
  const beforeProjectGlobals = snapshot(root);
  assert.ok(projectExport.exported.includes(fromGlobal.id));
  projectStore.exportOwned();
  assert.ok(fs.existsSync(fromGlobal.path));
  assert.equal(fs.existsSync(path.join(root, fromGlobal.slug)), false);
  assert.deepEqual(snapshot(root), beforeProjectGlobals);
  projectStore.save({ id: global.id, instructions: `${global.instructions}\n新的来源规则。` });
  assert.equal(projectStore.list({ projectId: 'a' }).managed.find(skill => skill.id === fromGlobal.id).source_update_available, true);
  assert.equal(projectStore.get(fromGlobal.id).instructions, fromGlobal.instructions);
  const originalExternal = projectStore.list().external.find(skill => skill.name === 'external');
  write(path.join(root, 'external', 'scripts', 'nested', 'run.cjs'), 'console.log("fixture only");');
  write(path.join(root, 'external', 'references', 'guide.md'), '项目工作方法');
  write(path.join(root, 'external', 'assets', 'example.bin'), Buffer.from([0, 255, 17, 0]));
  write(path.join(root, 'external', 'agents', 'openai.yaml'), 'interface:\n  display_name: Fixture');
  const sourceBeforeCopy = snapshot(path.join(root, 'external'));
  const copied = projectStore.derive({ source_id: originalExternal.id, project_id: 'a', name: '复制外部 Skill' });
  assert.equal(copied.instructions, 'External instructions.');
  assert.equal(copied.source_version, null);
  projectStore.exportOwned();
  for (const resource of ['scripts/nested/run.cjs', 'references/guide.md', 'assets/example.bin', 'agents/openai.yaml']) {
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(copied.path), resource)), fs.readFileSync(path.join(root, 'external', resource)));
  }
  assert.equal(fs.existsSync(path.join(path.dirname(copied.path), 'auth.json')), false);
  assert.deepEqual(snapshot(path.join(root, 'external')), sourceBeforeCopy);
  write(path.join(root, 'external', 'scripts', 'nested', 'run.cjs'), 'source updated');
  assert.equal(projectStore.list({ projectId: 'a' }).managed.find(skill => skill.id === copied.id).source_update_available, true);
  const copiedAgain = projectStore.derive({ source_id: copied.id, project_id: 'a', name: '再次复制' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM managed_skill_resources WHERE skill_id=?').get(copiedAgain.id).count, 4);
  assert.throws(() => projectStore.save({ scope: 'project', project_id: 'shared', slug: copied.slug, name: '共享根目录', instructions: 'x' }), /skill_project_root_shared/);
  assert.throws(() => projectStore.derive({ source_id: global.id, project_id: 'shared' }), /skill_project_root_shared/);
  const scopedExternalPath = path.join(projectB, '.agents', 'skills', 'outside', 'SKILL.md');
  write(scopedExternalPath, '---\nname: project-b-only\ndescription: only B\n---\nB only.');
  const bExternal = projectStore.list({ projectId: 'b' }).external.find(skill => skill.name === 'project-b-only');
  assert.ok(bExternal);
  assert.ok(projectStore.list({ includeAllProjects: true }).external.some(skill => skill.id === bExternal.id));
  assert.equal(projectStore.list({ projectId: 'a' }).external.some(skill => skill.id === bExternal.id), false);
  assert.throws(() => projectStore.derive({ source_id: bExternal.id, project_id: 'a' }), /skill_not_found/);
  // Existing files never become managed resources merely because their directory is owned.
  projectStore.exportOwned();
  const editedResource = path.join(path.dirname(copied.path), 'references', 'guide.md');
  write(editedResource, 'external modification must be kept');
  assert.equal(projectStore.exportOwned().conflicts.find(item => item.id === copied.id).reason, 'skill_resource_modified_conflict');
  assert.throws(() => projectStore.delete(copied.id), /skill_resource_modified_conflict/);
  assert.equal(fs.readFileSync(editedResource, 'utf8'), 'external modification must be kept');
  write(editedResource, '项目工作方法');
  write(path.join(path.dirname(copiedAgain.path), 'external-note.txt'), 'keep external note');
  projectStore.delete(copiedAgain.id);
  assert.equal(fs.readFileSync(path.join(path.dirname(copiedAgain.path), 'external-note.txt'), 'utf8'), 'keep external note');
  assert.equal(fs.existsSync(path.join(path.dirname(copiedAgain.path), 'scripts')), false);
  projectStore.delete(copied.id);
  assert.equal(fs.existsSync(path.dirname(copied.path)), false);
  // Exercise the link rejection branches even when Windows denies creating file symlinks.
  const realLstat = fs.lstatSync;
  try {
    fs.lstatSync = function(file, ...args) {
      const stat = realLstat.call(this, file, ...args);
      if (path.resolve(file) === path.resolve(projectA)) return { ...stat, isSymbolicLink: () => true, isDirectory: () => true };
      return stat;
    };
    assert.equal(projectStore.exportOwned().conflicts.find(item => item.id === fromGlobal.id).reason, 'skill_export_path_conflict');
  } finally { fs.lstatSync = realLstat; }
  try {
    fs.lstatSync = function(file, ...args) {
      const stat = realLstat.call(this, file, ...args);
      if (path.resolve(file) === path.resolve(root, 'external', 'scripts')) return { ...stat, isSymbolicLink: () => true, isDirectory: () => true };
      return stat;
    };
    assert.throws(() => projectStore.derive({ source_id: originalExternal.id, project_id: 'a' }), /skill_source_symlink_forbidden/);
  } finally { fs.lstatSync = realLstat; }
  // Project parent junctions and resource symlinks must never redirect export or derivation.
  const redirected = path.join(temporary, 'redirected-project');
  const outsideRedirect = path.join(temporary, 'outside-redirect');
  fs.mkdirSync(outsideRedirect);
  try {
    fs.symlinkSync(outsideRedirect, redirected, 'junction');
    const redirectedStore = createManagedSkills({ db, home, userHome, codexHome, resolveProject: id => id === 'redirected' ? { workspace_path: redirected } : projectResolver(id) });
    assert.throws(() => redirectedStore.save({ scope: 'project', project_id: 'redirected', name: 'redirect', instructions: 'x' }), /skill_export_path_conflict/);
    const blocked = db.prepare('INSERT INTO managed_skills(id,name,slug,description,instructions,created_at,updated_at,scope,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('redirected-skill', 'redirect', 'better-codex-redirected', '', 'x', 'fixture', 'fixture', 'project', 'redirected');
    assert.equal(redirectedStore.exportOwned().conflicts.find(item => item.id === 'redirected-skill').reason, 'skill_export_path_conflict');
    assert.deepEqual(snapshot(outsideRedirect), {});
    // Remove the fixture row without following the redirected export location.
    db.prepare('DELETE FROM managed_skills WHERE id=?').run('redirected-skill');
    const sourceLink = path.join(root, 'external', 'scripts', 'linked.cjs');
    fs.symlinkSync(linkTarget, sourceLink, 'file');
    assert.throws(() => projectStore.derive({ source_id: originalExternal.id, project_id: 'a' }), /skill_source_symlink_forbidden/);
    fs.unlinkSync(sourceLink);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('NOTE: project junction fixture unavailable in this environment.');
  }
  const orphanStore = createManagedSkills({ db, home, userHome, codexHome, resolveProject: id => id === 'a' ? null : projectResolver(id), listProjects: () => [projectResolver('b')] });
  assert.ok(orphanStore.list().managed.every(skill => skill.scope === 'global'));
  assert.equal(orphanStore.list({ includeAllProjects: true }).managed.find(skill => skill.id === fromGlobal.id).project_unavailable, true);
  assert.equal(orphanStore.exportOwned().conflicts.find(skill => skill.id === fromGlobal.id).reason, 'skill_project_not_found');
  assert.ok(orphanStore.get('better-codex-plan'));
  const beforeShared = projectStore.derive({ source_id: originalExternal.id, project_id: 'a', name: '共享前资源副本' });
  const independent = projectStore.save({ scope: 'project', project_id: 'b', name: '独立项目', instructions: '独立的工作方法' });
  projectStore.exportOwned();
  const modifiedBeforeShared = path.join(path.dirname(beforeShared.path), 'references', 'guide.md');
  write(modifiedBeforeShared, 'external modification');
  const globalBeforeShared = snapshot(root);
  includeSharedProject = true;
  assert.throws(() => projectStore.save({ scope: 'project', project_id: 'a', name: 'blocked', instructions: 'blocked' }), /skill_project_root_shared/);
  assert.throws(() => projectStore.derive({ source_id: global.id, project_id: 'a' }), /skill_project_root_shared/);
  assert.throws(() => projectStore.assertAvailable(fromGlobal.id, 'a'), /skill_project_root_shared/);
  const disabled = projectStore.exportOwned();
  assert.equal(disabled.conflicts.find(skill => skill.id === fromGlobal.id).reason, 'skill_project_root_shared');
  assert.ok(disabled.deactivated.includes(fromGlobal.id));
  assert.equal(fs.existsSync(fromGlobal.path), false);
  assert.equal(disabled.conflicts.find(skill => skill.id === beforeShared.id).cleanup_reason, 'skill_resource_modified_conflict');
  assert.equal(fs.readFileSync(modifiedBeforeShared, 'utf8'), 'external modification');
  assert.ok(fs.existsSync(path.join(path.dirname(beforeShared.path), '.better-codex-owned.json')));
  assert.ok(fs.existsSync(independent.path));
  assert.deepEqual(snapshot(root), globalBeforeShared);
  write(modifiedBeforeShared, '项目工作方法');
  assert.ok(projectStore.exportOwned().deactivated.includes(beforeShared.id));
  assert.equal(fs.existsSync(path.dirname(beforeShared.path)), false);
  assert.ok(Object.keys(snapshot(path.join(home, 'backups', 'managed-skills'))).some(file => file.includes(beforeShared.slug)));
  includeSharedProject = false;
  assert.ok(projectStore.exportOwned().exported.includes(fromGlobal.id));
  const ancestorDb = new DatabaseSync(':memory:');
  try {
    const ancestorRoot = path.join(temporary, 'ancestor-project');
    const descendantRoot = path.join(ancestorRoot, 'descendant');
    fs.mkdirSync(descendantRoot, { recursive: true });
    const ancestorProjects = [{ id: 'parent', workspace_path: ancestorRoot }, { id: 'child', workspace_path: descendantRoot }];
    const ancestorStore = createManagedSkills({ db: ancestorDb, home: path.join(temporary, 'ancestor-data'), userHome: path.join(temporary, 'ancestor-user'), resolveProject: id => ancestorProjects.find(item => item.id === id), listProjects: () => ancestorProjects });
    assert.throws(() => ancestorStore.save({ scope: 'project', project_id: 'parent', name: 'parent', instructions: 'x' }), /skill_project_root_shared/);
    const descendant = ancestorStore.save({ scope: 'project', project_id: 'child', name: 'child', instructions: 'x' });
    assert.ok(ancestorStore.exportOwned().exported.includes(descendant.id));
    assert.equal(fs.existsSync(path.join(ancestorRoot, '.agents', 'skills')), false);
    assert.ok(fs.existsSync(descendant.path));
  } finally { ancestorDb.close(); }
  const aliasDb = new DatabaseSync(':memory:');
  const originalStat = fs.statSync, originalRealpath = fs.realpathSync.native;
  try {
    const realRoot = path.join(temporary,'physical-root'), aliasRoot = path.join(temporary,'physical-alias');
    fs.mkdirSync(realRoot,{recursive:true});
    const aliasProjects = [{id:'real',workspace_path:realRoot}];
    const aliasStore = createManagedSkills({db:aliasDb,home:path.join(temporary,'alias-data'),userHome:path.join(temporary,'alias-user'),resolveProject:id=>aliasProjects.find(item=>item.id===id),listProjects:()=>aliasProjects});
    const isolated = aliasStore.save({scope:'project',project_id:'real',name:'物理隔离',instructions:'x'});
    aliasStore.exportOwned(); assert.ok(fs.existsSync(isolated.path));
    aliasProjects.push({id:'alias',workspace_path:aliasRoot});
    fs.statSync = (file,...args) => path.resolve(file)===aliasRoot?originalStat(realRoot,...args):originalStat(file,...args);
    fs.realpathSync.native = (file,...args) => path.resolve(file)===aliasRoot?originalRealpath(realRoot,...args):originalRealpath(file,...args);
    assert.throws(()=>aliasStore.assertAvailable(isolated.id,'real'),/skill_project_root_shared/,'junction/ancestor aliases must participate in physical-root isolation');
    assert.ok(aliasStore.exportOwned().deactivated.includes(isolated.id));
    assert.equal(fs.existsSync(isolated.path),false);
    aliasProjects.pop(); fs.statSync=originalStat;fs.realpathSync.native=originalRealpath;
    aliasStore.exportOwned();
    assert.ok(aliasStore.deactivateProject('real').deactivated.includes(isolated.id));
    assert.equal(fs.existsSync(isolated.path),false);assert.ok(aliasStore.get(isolated.id),'project deactivation preserves authoritative Skill metadata');
  } finally { fs.statSync=originalStat;fs.realpathSync.native=originalRealpath;aliasDb.close(); }
  // Upgrade an existing legacy schema only after writing a restorable table backup.
  const migrationDb = new DatabaseSync(':memory:');
  try {
    migrationDb.exec(`CREATE TABLE managed_skills(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,description TEXT NOT NULL,instructions TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,builtin INTEGER NOT NULL DEFAULT 0,legacy_agent_id TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO managed_skills VALUES('existing','Existing','better-codex-existing','','preserved',1,0,NULL,'before','before');`);
    const migrationHome = path.join(temporary, 'migration-backup-data');
    const migratedStore = createManagedSkills({ db: migrationDb, home: migrationHome, userHome: path.join(temporary, 'migration-backup-user') });
    const backups = snapshot(path.join(migrationHome, 'backups', 'managed-skills-migrations'));
    assert.equal(Object.keys(backups).length, 1);
    const backup = JSON.parse(Buffer.from(Object.values(backups)[0], 'base64').toString('utf8'));
    assert.ok(backup.tables[0].schema.includes('CREATE TABLE'));
    assert.equal(backup.tables[0].rows[0].instructions, 'preserved');
    const restored = new DatabaseSync(':memory:');
    try {
      for (const table of backup.tables) {
        restored.exec(table.schema);
        for (const row of table.rows) {
          const columns = Object.keys(row);
          restored.prepare(`INSERT INTO ${table.name} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
        }
      }
      assert.equal(restored.prepare('SELECT instructions FROM managed_skills WHERE id=?').get('existing').instructions, 'preserved');
      assert.equal(restored.prepare('PRAGMA table_info(managed_skills)').all().some(column => column.name === 'scope'), false);
    } finally { restored.close(); }
    assert.equal(migratedStore.get('existing').scope, 'global');
    createManagedSkills({ db: migrationDb, home: migrationHome, userHome: path.join(temporary, 'migration-backup-user') });
    assert.deepEqual(snapshot(path.join(migrationHome, 'backups', 'managed-skills-migrations')), backups);
  } finally { migrationDb.close(); }
  console.log('PASS: project/global visibility, server scope validation, source version/hash update hints, full resource copies, shared/ancestor native-root isolation and backed-up deactivation, external read-only preservation, resource conflicts and symlink boundaries');
  console.log('PASS: isolated Skill migration, stable DB authority, native configuration/role preservation, external read-only metadata, ownership conflicts, idempotent export, affected-file backups, rename/delete boundaries, optimistic versions');
} finally {
  db.close();
  // The resolved directory comes from mkdtemp under the OS temporary directory.
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), 'better-codex-skills-test-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}

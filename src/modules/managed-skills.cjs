'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');

const MARKER = '.better-codex-owned.json';
const BUILTINS = [
  { id: 'better-codex-charter', slug: 'better-codex-charter', name: '项目总纲',
    historical_hashes: ['6ca795ed80d0891ea696da05f2db37018507b25ff1a9f9578ea5ea1ac10efc31'] },
  { id: 'better-codex-plan', slug: 'better-codex-plan', name: '任务规划',
    historical_hashes: ['b84acbad371210c47765bee025f57f20746655b4944ea4af6542ae5e76658ced'] }
];
const digest = value => createHash('sha256').update(String(value)).digest('hex');
// The initial shipped defaults predated hash tracking. These exact hashes are the
// only unrecorded defaults eligible for adoption; arbitrary current text is never adopted.
const instructionsHash = value => digest(String(value).replace(/\r\n/g, '\n').trim());
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function regular(file) { const stat = exists(file); return !!stat && stat.isFile() && !stat.isSymbolicLink(); }
function readHeader(file) {
  // Only SKILL.md metadata is read; no sibling scripts, settings, or credential files.
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function frontmatter(text) {
  const match = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const values = {};
  if (!match) return { values, body: String(text).trim() };
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const item = lines[index].match(/^([a-z_]+):\s*(.*)$/);
    if (!item) continue;
    let value = item[2].trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      const folded = value[0] === '>';
      const parts = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1])) parts.push(lines[++index].trim());
      value = parts.join(folded ? ' ' : '\n');
    } else if (value.startsWith('"')) { try { value = JSON.parse(value); } catch {} }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    values[item[1]] = value;
  }
  return { values, body: String(text).slice(match[0].length).trim() };
}
function validSlug(value) {
  return typeof value === 'string' && /^better-codex-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
}
function createManagedSkills({ db, home, codexHome, userHome = os.homedir(), templatesDir = path.join(__dirname, '..', 'skills'), profiles } = {}) {
  if (!db || !home) throw Error('managed_skills_database_and_home_required');
  const root = path.resolve(userHome, '.agents', 'skills');
  const nativeRoot = path.resolve(codexHome || path.join(userHome, '.codex'), 'skills');
  db.exec(`CREATE TABLE IF NOT EXISTS managed_skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL, instructions TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0, legacy_agent_id TEXT UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS managed_skill_migrations (legacy_agent_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS managed_skill_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO managed_skill_settings(key,value) VALUES('export_owner',?)").run(randomUUID());
  const owner = db.prepare("SELECT value FROM managed_skill_settings WHERE key='export_owner'").get().value;
  const transaction = fn => {
    db.exec('SAVEPOINT managed_skills_change');
    try { const result = fn(); db.exec('RELEASE managed_skills_change'); return result; }
    catch (error) { db.exec('ROLLBACK TO managed_skills_change'); db.exec('RELEASE managed_skills_change'); throw error; }
  };
  const describe = row => row ? {
    id: row.id, name: row.name, slug: row.slug, description: row.description,
    instructions: row.instructions, version: row.version, path: path.join(root, row.slug, 'SKILL.md'),
    managed: true, builtin: !!row.builtin, legacy_agent_id: row.legacy_agent_id ?? null
  } : null;
  const get = id => describe(db.prepare('SELECT * FROM managed_skills WHERE id=?').get(String(id)));
  const managed = () => db.prepare('SELECT * FROM managed_skills ORDER BY builtin DESC, name, id').all().map(describe);
  function migrate() {
    return transaction(() => {
      let inserted = 0;
      const upgraded = [];
      const preserved = [];
      const insert = db.prepare('INSERT OR IGNORE INTO managed_skills(id,name,slug,description,instructions,builtin,legacy_agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
      const timestamp = new Date().toISOString();
      for (const builtin of BUILTINS) {
        const source = fs.readFileSync(path.join(templatesDir, builtin.slug, 'SKILL.md'), 'utf8');
        const parsed = frontmatter(source);
        const templateHash = instructionsHash(parsed.body);
        const key = `builtin_template_hash:${builtin.id}`;
        const remember = () => db.prepare('INSERT INTO managed_skill_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, templateHash);
        const current = get(builtin.id);
        if (!current) {
          const changes = Number(insert.run(builtin.id, builtin.name, builtin.slug, parsed.values.description || builtin.name, parsed.body, 1, null, timestamp, timestamp).changes);
          inserted += changes;
          if (changes) remember();
          continue;
        }
        if (!current.builtin) { preserved.push(current.id); continue; }
        const currentHash = instructionsHash(current.instructions);
        if (currentHash === templateHash) { remember(); continue; }
        const recordedHash = db.prepare('SELECT value FROM managed_skill_settings WHERE key=?').get(key)?.value;
        if (currentHash !== recordedHash && !builtin.historical_hashes.includes(currentHash)) {
          preserved.push(current.id);
          continue;
        }
        const result = db.prepare('UPDATE managed_skills SET instructions=?,version=version+1,updated_at=? WHERE id=? AND version=?')
          .run(parsed.body, timestamp, current.id, current.version);
        if (Number(result.changes) !== 1) throw Error('version_conflict');
        remember();
        upgraded.push(current.id);
      }
      let legacy;
      if (profiles !== undefined) legacy = typeof profiles === 'function' ? profiles() : profiles;
      else legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_profiles'").get()
        ? db.prepare('SELECT id,name,description,instructions FROM agent_profiles').all() : [];
      for (const profile of legacy || []) {
        if (!profile.id || db.prepare('SELECT 1 FROM managed_skill_migrations WHERE legacy_agent_id=?').get(profile.id)) continue;
        const id = `legacy-${digest(profile.id).slice(0, 24)}`;
        const slug = `better-codex-agent-${digest(profile.id).slice(0, 20)}`;
        const instructions = String(profile.instructions || '').trim();
        inserted += Number(insert.run(id, String(profile.name || profile.id), slug, String(profile.description || ''), instructions, 0, String(profile.id), timestamp, timestamp).changes);
        db.prepare('INSERT OR IGNORE INTO managed_skill_migrations(legacy_agent_id,skill_id) VALUES(?,?)').run(String(profile.id), id);
      }
      return { inserted, total: managed().length, upgraded, preserved };
    });
  }
  function safeRoot(create = false) {
    // Reject redirected export paths rather than following junctions or symlinks.
    for (const folder of [path.resolve(userHome), path.resolve(userHome, '.agents'), root]) {
      const stat = exists(folder);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw Error('skill_export_path_conflict');
    }
    if (create) fs.mkdirSync(root, { recursive: true });
  }
  function owned(folder, id) {
    const stat = exists(folder);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
    const marker = path.join(folder, MARKER);
    if (!regular(marker)) return false;
    try {
      const data = JSON.parse(readHeader(marker));
      return data.owner === owner && data.skill_id === id && data.format === 1;
    } catch { return false; }
  }
  function backup(folder) {
    const files = ['SKILL.md', MARKER].filter(file => regular(path.join(folder, file)));
    if (!files.length) return;
    const destination = path.resolve(home, 'backups', 'managed-skills', `${Date.now()}-${randomUUID()}`, path.basename(folder));
    fs.mkdirSync(destination, { recursive: true });
    for (const file of files) fs.copyFileSync(path.join(folder, file), path.join(destination, file), fs.constants.COPYFILE_EXCL);
  }
  function removeOwned(folder, id) {
    if (!owned(folder, id)) return false;
    const skillFile = path.join(folder, 'SKILL.md');
    if (exists(skillFile) && !regular(skillFile)) throw Error('skill_export_path_conflict');
    backup(folder);
    if (regular(skillFile)) fs.unlinkSync(skillFile);
    fs.unlinkSync(path.join(folder, MARKER));
    // Leave any externally added resources in place; only our two files belong to us.
    if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
    return true;
  }
  function externalSkills() {
    const result = [];
    const seen = new Set();
    const ownedPaths = new Set(managed().filter(skill => owned(path.dirname(skill.path), skill.id)).map(skill => path.resolve(skill.path)));
    const inspect = (folder, source) => {
      const file = path.join(folder, 'SKILL.md');
      if (!regular(file) || ownedPaths.has(path.resolve(file)) || seen.has(path.resolve(file))) return;
      seen.add(path.resolve(file));
      try {
        const { values } = frontmatter(readHeader(file));
        result.push({ id: `external:${digest(file)}`, name: values.name || path.basename(folder), slug: path.basename(folder),
          description: values.description || '', instructions: '', version: null, path: file,
          managed: false, builtin: false, legacy_agent_id: null, source });
      } catch { /* An unreadable external Skill stays untouched. */ }
    };
    for (const [folder, source] of [[root, 'agents'], [nativeRoot, 'codex']]) {
      const stat = exists(folder);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(folder, entry.name);
        inspect(child, source);
        if (entry.name === '.system') {
          for (const nested of fs.readdirSync(child, { withFileTypes: true })) {
            if (nested.isDirectory() && !nested.isSymbolicLink()) inspect(path.join(child, nested.name), source);
          }
        }
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  function list({ includeExternal = true } = {}) { return { managed: managed(), external: includeExternal ? externalSkills() : [] }; }
  function save(input, { expectedVersion = input?.version } = {}) {
    if (!input || typeof input !== 'object') throw Error('skill_input_required');
    if (String(input.id || '').startsWith('external:')) throw Error('external_skill_read_only');
    const current = input.id ? get(input.id) : null;
    if (input.id && !current) throw Error('skill_not_found');
    if (current && expectedVersion !== undefined && expectedVersion !== current.version) throw Error('version_conflict');
    const id = current?.id || randomUUID();
    const slug = input.slug ?? current?.slug ?? `better-codex-skill-${id.replaceAll('-', '')}`;
    if (!validSlug(slug)) throw Error('skill_slug_invalid');
    if (current?.builtin && slug !== current.slug) throw Error('builtin_skill_slug_locked');
    const name = String(input.name ?? current?.name ?? '').trim();
    const description = String(input.description ?? current?.description ?? '').trim();
    const instructions = String(input.instructions ?? current?.instructions ?? '').trim();
    if (!name || !instructions) throw Error('skill_name_and_instructions_required');
    const duplicate = db.prepare('SELECT id FROM managed_skills WHERE slug=? AND id<>?').get(slug, id);
    if (duplicate) throw Error('skill_slug_conflict');
    const timestamp = new Date().toISOString();
    if (current) {
      const result = db.prepare('UPDATE managed_skills SET name=?,slug=?,description=?,instructions=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(name, slug, description, instructions, timestamp, id, current.version);
      if (Number(result.changes) !== 1) throw Error('version_conflict');
    } else db.prepare('INSERT INTO managed_skills(id,name,slug,description,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, name, slug, description, instructions, timestamp, timestamp);
    return get(id);
  }
  function deleteSkill(id, { expectedVersion } = {}) {
    if (String(id).startsWith('external:')) throw Error('external_skill_read_only');
    const current = get(id);
    if (!current) throw Error('skill_not_found');
    if (current.builtin) throw Error('builtin_skill_delete_forbidden');
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw Error('version_conflict');
    safeRoot();
    // Files must be backed up successfully before removing the authoritative record.
    if (exists(root)) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && validSlug(entry.name)) removeOwned(path.join(root, entry.name), current.id);
      }
    }
    const result = db.prepare('DELETE FROM managed_skills WHERE id=? AND version=?').run(current.id, current.version);
    if (Number(result.changes) !== 1) throw Error('version_conflict');
    return current;
  }
  function document(skill) {
    const description = skill.description.trim() || `按${skill.name}提供工作指导。`;
    return `---\nname: ${skill.slug}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  display_name: ${JSON.stringify(skill.name)}\n---\n\n${skill.instructions}\n`;
  }
  function replaceOwned(file, content) {
    const temporary = path.join(path.dirname(file), `.better-codex-write-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
      // Replacing the directory entry avoids truncating an externally added hardlink.
      fs.renameSync(temporary, file);
    } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  }
  function exportOwned() {
    safeRoot(true);
    const report = { exported: [], unchanged: [], conflicts: [] };
    const rows = managed();
    for (const skill of rows) {
      const folder = path.dirname(skill.path);
      const stat = exists(folder);
      if (stat && !owned(folder, skill.id)) { report.conflicts.push({ id: skill.id, path: skill.path, reason: 'skill_ownership_conflict' }); continue; }
      if (exists(skill.path) && !regular(skill.path)) { report.conflicts.push({ id: skill.id, path: skill.path, reason: 'skill_export_path_conflict' }); continue; }
      const content = document(skill);
      const marker = `${JSON.stringify({ format: 1, owner, skill_id: skill.id, version: skill.version }, null, 2)}\n`;
      if (stat && fs.readFileSync(path.join(folder, MARKER), 'utf8') === marker && regular(skill.path) && fs.readFileSync(skill.path, 'utf8') === content) {
        report.unchanged.push(skill.id); continue;
      }
      if (stat) backup(folder);
      else fs.mkdirSync(folder); // Exclusive directory claim: never take over an existing external directory.
      try {
        // New files are exclusive; updates are limited to verified owned files.
        if (stat) {
          replaceOwned(skill.path, content);
          replaceOwned(path.join(folder, MARKER), marker);
        } else {
          fs.writeFileSync(skill.path, content, { encoding: 'utf8', flag: 'wx' });
          fs.writeFileSync(path.join(folder, MARKER), marker, { encoding: 'utf8', flag: 'wx' });
        }
      } catch (error) {
        // An incomplete first export never claims a pre-existing directory.
        if (!stat && !exists(path.join(folder, MARKER))) {
          if (regular(skill.path) && fs.readFileSync(skill.path, 'utf8') === content) fs.unlinkSync(skill.path);
          if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
        }
        throw error;
      }
      report.exported.push(skill.id);
    }
    // Reconcile old names only after their replacement has been exported successfully.
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validSlug(entry.name)) continue;
      const folder = path.join(root, entry.name);
      for (const skill of rows) {
        if (entry.name !== skill.slug && !report.conflicts.some(conflict => conflict.id === skill.id)) removeOwned(folder, skill.id);
      }
    }
    return report;
  }
  migrate();
  return { migrate, list, get, save, delete: deleteSkill, exportOwned };
}
module.exports = { createManagedSkills };

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
    historical_hashes: ['b84acbad371210c47765bee025f57f20746655b4944ea4af6542ae5e76658ced'] },
  { id: 'better-codex-develop', slug: 'better-codex-develop', name: '开发与复核', historical_hashes: [] },
  { id: 'better-codex-test', slug: 'better-codex-test', name: '测试与验收', historical_hashes: [] },
  { id: 'better-codex-charter-review', slug: 'better-codex-charter-review', name: '总纲审核', historical_hashes: [] },
  { id: 'better-codex-task-review', slug: 'better-codex-task-review', name: '任务审核', historical_hashes: [] }
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
function createManagedSkills({ db, home, codexHome, userHome = os.homedir(), templatesDir = path.join(__dirname, '..', 'skills'), profiles, resolveProject, listProjects, projects } = {}) {
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
  const columns = new Set(db.prepare('PRAGMA table_info(managed_skills)').all().map(row => row.name));
  if (['scope', 'project_id', 'source_id', 'source_version', 'source_hash'].some(name => !columns.has(name)) && db.prepare('SELECT 1 FROM managed_skills LIMIT 1').get()) {
    // Preserve only the affected table and its small migration metadata before ALTER.
    const tables = ['managed_skills', 'managed_skill_settings', 'managed_skill_migrations'].map(name => ({
      name, schema: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql,
      rows: db.prepare(`SELECT * FROM ${name}`).all()
    }));
    const destination = path.resolve(home, 'backups', 'managed-skills-migrations');
    fs.mkdirSync(destination, { recursive: true });
    const file = path.join(destination, `${Date.now()}-${randomUUID()}.json`);
    const content = JSON.stringify({ format: 1, migration: 'project-scoped-skills', created_at: new Date().toISOString(), tables }, null, 2);
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
    if (!regular(file) || fs.statSync(file).size === 0 || fs.readFileSync(file, 'utf8') !== content || JSON.parse(content).tables[0].rows.length !== tables[0].rows.length) throw Error('skill_migration_backup_failed');
  }
  for (const [name, type] of [['scope', "TEXT NOT NULL DEFAULT 'global'"], ['project_id', 'TEXT'], ['source_id', 'TEXT'], ['source_version', 'INTEGER'], ['source_hash', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE managed_skills ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS managed_skill_resources (skill_id TEXT NOT NULL, relative_path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(skill_id,relative_path))');
  db.prepare("INSERT OR IGNORE INTO managed_skill_settings(key,value) VALUES('export_owner',?)").run(randomUUID());
  const owner = db.prepare("SELECT value FROM managed_skill_settings WHERE key='export_owner'").get().value;
  const transaction = fn => {
    db.exec('SAVEPOINT managed_skills_change');
    try { const result = fn(); db.exec('RELEASE managed_skills_change'); return result; }
    catch (error) { db.exec('ROLLBACK TO managed_skills_change'); db.exec('RELEASE managed_skills_change'); throw error; }
  };
  function project(id) {
    if (!id) throw Error('skill_project_required');
    const resolver = resolveProject || (typeof projects === 'function' ? projects : projects?.get?.bind(projects));
    const item = resolver?.(String(id));
    if (!item || !item.workspace_path || !path.isAbsolute(item.workspace_path)) throw Error('skill_project_not_found');
    const stat = exists(path.resolve(item.workspace_path));
    if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) throw Error('skill_project_not_found');
    return { ...item, id: String(id), workspace_path: path.resolve(item.workspace_path) };
  }
  const exportRoot = row => row.scope === 'project' ? path.join(project(row.project_id).workspace_path, '.agents', 'skills') : root;
  function checkProjectIsolation(projectId) {
    const current = project(projectId);
    safeRoot(false, current.workspace_path);
    if (typeof listProjects !== 'function') return;
    const canonical = folder => {
      const value = fs.realpathSync.native(folder);
      return process.platform === 'win32' ? value.toLowerCase() : value;
    };
    const target = canonical(current.workspace_path);
    for (const candidate of listProjects() || []) {
      if (!candidate?.id || String(candidate.id) === String(projectId) || !candidate.workspace_path || !path.isAbsolute(candidate.workspace_path)) continue;
      const folder = path.resolve(candidate.workspace_path);
      let other;
      // Redirected project roots still share physical Skill discovery even
      // though they are never eligible export destinations themselves.
      try { if (!fs.statSync(folder).isDirectory()) continue; other = canonical(folder); } catch { continue; }
      const relative = path.relative(target, other);
      // Native Codex searches ancestor .agents/skills directories from each workspace.
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw Error('skill_project_root_shared');
    }
  }
  const describe = row => {
    if (!row) return null;
    let destination;
    try { destination = exportRoot(row); } catch (error) {
      if (error.message !== 'skill_project_not_found' && error.message !== 'skill_project_required') throw error;
    }
    return {
    id: row.id, name: row.name, slug: row.slug, description: row.description,
    instructions: row.instructions, version: row.version, path: destination ? path.join(destination, row.slug, 'SKILL.md') : null,
    ...(destination ? {} : { project_unavailable: true }),
    scope: row.scope || 'global', project_id: row.project_id || null,
    source_id: row.source_id || null, source_skill_id: row.source_id || null, source_version: row.source_version ?? null, source_hash: row.source_hash || null,
    managed: true, builtin: !!row.builtin, legacy_agent_id: row.legacy_agent_id ?? null
  };
  };
  const get = (id, context = {}) => {
    const item = describe(db.prepare('SELECT * FROM managed_skills WHERE id=?').get(String(id)));
    if (item?.scope === 'project' && Object.hasOwn(context, 'projectId') && item.project_id !== String(context.projectId || '')) throw Error('skill_project_mismatch');
    return item;
  };
  const managed = () => db.prepare('SELECT * FROM managed_skills ORDER BY builtin DESC, name, id').all().map(describe);
  const visible = (skill, projectId) => skill.scope !== 'project' || skill.project_id === String(projectId || '');
  const resources = id => db.prepare('SELECT relative_path,content FROM managed_skill_resources WHERE skill_id=? ORDER BY relative_path').all(String(id));
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
  function safeRoot(create = false, destination = root) {
    // Reject redirected export paths rather than following junctions or symlinks.
    const folders = [];
    for (let folder = path.resolve(destination); ; folder = path.dirname(folder)) {
      folders.push(folder);
      if (folder === path.dirname(folder)) break;
    }
    for (const folder of folders.reverse()) {
      const stat = exists(folder);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw Error('skill_export_path_conflict');
    }
    if (create) fs.mkdirSync(destination, { recursive: true });
  }
  function owned(folder, id) {
    const stat = exists(folder);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
    const marker = path.join(folder, MARKER);
    if (!regular(marker)) return false;
    try {
      const data = readMarker(folder);
      const row = db.prepare('SELECT scope,project_id FROM managed_skills WHERE id=?').get(String(id));
      return data.owner === owner && data.skill_id === id && data.format === 1 &&
        (!data.export_root || path.resolve(data.export_root) === path.dirname(path.resolve(folder))) &&
        (row?.scope !== 'project' || data.project_id === row.project_id);
    } catch { return false; }
  }
  function backup(folder) {
    const files = ['SKILL.md', MARKER, ...ownedResourcePaths(folder)].filter(file => regular(path.join(folder, file)));
    if (!files.length) return;
    const destination = path.resolve(home, 'backups', 'managed-skills', `${Date.now()}-${randomUUID()}`, path.basename(folder));
    fs.mkdirSync(destination, { recursive: true });
    for (const file of files) {
      safeResource(file);
      fs.mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
      fs.copyFileSync(path.join(folder, file), path.join(destination, file), fs.constants.COPYFILE_EXCL);
    }
  }
  function safeResource(value) {
    if (value === 'SKILL.md' || value === MARKER) return value;
    if (typeof value !== 'string' || !/^(scripts|references|assets|agents)\//.test(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw Error('skill_resource_path_invalid');
    return value;
  }
  function ownedResourcePaths(folder) {
    const metadata = readMarker(folder);
    if (metadata.resources === undefined) return [];
    if (!Array.isArray(metadata.resources) || metadata.resources.some(item => typeof item?.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash))) throw Error('skill_resource_metadata_invalid');
    return metadata.resources.map(item => safeResource(item.path));
  }
  function readMarker(folder) {
    const marker = path.join(folder, MARKER);
    if (!regular(marker) || fs.statSync(marker).size > 1024 * 1024) throw Error('skill_resource_metadata_invalid');
    return JSON.parse(fs.readFileSync(marker, 'utf8'));
  }
  function resourceConflicts(folder, files) {
    ownedResourcePaths(folder);
    const previous = new Map(readMarker(folder).resources?.map(item => [safeResource(item.path), item.hash]) || []);
    for (const file of files) {
      const relative = safeResource(file.relative_path);
      const destination = path.join(folder, relative);
      safeRoot(false, path.dirname(destination));
      if (!exists(destination)) continue;
      if (!regular(destination) || !previous.has(relative)) throw Error('skill_resource_ownership_conflict');
      if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== previous.get(relative)) throw Error('skill_resource_modified_conflict');
    }
  }
  function removeOwned(folder, id) {
    if (!owned(folder, id)) return false;
    const skillFile = path.join(folder, 'SKILL.md');
    if (exists(skillFile) && !regular(skillFile)) throw Error('skill_export_path_conflict');
    for (const file of ownedResourcePaths(folder)) {
      safeRoot(false, path.dirname(path.join(folder, file)));
      if (exists(path.join(folder, file)) && !regular(path.join(folder, file))) throw Error('skill_export_path_conflict');
    }
    resourceConflicts(folder, ownedResourcePaths(folder).map(relative_path => ({ relative_path })));
    backup(folder);
    for (const file of ownedResourcePaths(folder)) {
      if (regular(path.join(folder, file))) fs.unlinkSync(path.join(folder, file));
      for (let directory = path.dirname(path.join(folder, file)); directory !== folder; directory = path.dirname(directory)) {
        if (exists(directory) && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
      }
    }
    if (regular(skillFile)) fs.unlinkSync(skillFile);
    fs.unlinkSync(path.join(folder, MARKER));
    // Leave any externally added resources in place; only our two files belong to us.
    if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
    return true;
  }
  function externalSkills(projectId, includeAllProjects = false) {
    const result = [];
    const seen = new Set();
    const ownedPaths = new Set(managed().filter(skill => skill.path && owned(path.dirname(skill.path), skill.id)).map(skill => path.resolve(skill.path)));
    const inspect = (folder, source, scope = 'global', project_id = null) => {
      const file = path.join(folder, 'SKILL.md');
      if (!regular(file) || ownedPaths.has(path.resolve(file)) || seen.has(path.resolve(file))) return;
      seen.add(path.resolve(file));
      try {
        const { values } = frontmatter(readHeader(file));
        result.push({ id: `external:${digest(file)}`, name: values.name || path.basename(folder), slug: path.basename(folder),
          description: values.description || '', instructions: '', version: null, path: file,
          managed: false, builtin: false, legacy_agent_id: null, source, scope, project_id });
      } catch { /* An unreadable external Skill stays untouched. */ }
    };
    const roots = [[root, 'agents', 'global', null], [nativeRoot, 'codex', 'global', null]];
    if (projectId) roots.push([path.join(project(projectId).workspace_path, '.agents', 'skills'), 'project', 'project', String(projectId)]);
    else if (includeAllProjects && typeof listProjects === 'function') {
      for (const item of listProjects() || []) {
        if (item?.id && item.workspace_path && path.isAbsolute(item.workspace_path)) roots.push([path.join(project(item.id).workspace_path, '.agents', 'skills'), 'project', 'project', String(item.id)]);
      }
    }
    for (const [folder, source, scope, project_id] of roots) {
      const stat = exists(folder);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
      try { safeRoot(false, folder); } catch { continue; }
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(folder, entry.name);
        inspect(child, source, scope, project_id);
        if (entry.name === '.system') {
          for (const nested of fs.readdirSync(child, { withFileTypes: true })) {
            if (nested.isDirectory() && !nested.isSymbolicLink()) inspect(path.join(child, nested.name), source, scope, project_id);
          }
        }
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  function sourceSnapshot(skill) {
    if (skill.managed) {
      const files = resources(skill.id);
      return { instructions: skill.instructions, description: skill.description, files, version: skill.version,
        hash: snapshotHash(document(skill), files) };
    }
    const folder = path.dirname(skill.path);
    safeRoot(false, folder);
    if (!regular(skill.path)) throw Error('skill_export_path_conflict');
    const text = fs.readFileSync(skill.path, 'utf8');
    const parsed = frontmatter(text);
    const files = [];
    let bytes = Buffer.byteLength(text);
    const walk = (directory, relative) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        const relative_path = safeResource(`${relative}/${entry.name}`);
        if (entry.isSymbolicLink()) throw Error('skill_source_symlink_forbidden');
        if (entry.isDirectory()) walk(file, relative_path);
        else if (entry.isFile()) {
          const content = fs.readFileSync(file);
          bytes += content.length;
          if (bytes > 32 * 1024 * 1024 || files.length >= 2000) throw Error('skill_source_resources_too_large');
          files.push({ relative_path, content });
        } else throw Error('skill_source_resource_invalid');
      }
    };
    for (const directory of ['scripts', 'references', 'assets', 'agents']) {
      const stat = exists(path.join(folder, directory));
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('skill_source_symlink_forbidden');
      walk(path.join(folder, directory), directory);
    }
    return { instructions: parsed.body, description: parsed.values.description || '', files, version: null, hash: snapshotHash(text, files) };
  }
  function snapshotHash(text, files) {
    const hash = createHash('sha256').update(text);
    for (const file of [...files].sort((a, b) => a.relative_path.localeCompare(b.relative_path))) hash.update('\0' + file.relative_path + '\0').update(Buffer.from(file.content));
    return hash.digest('hex');
  }
  function sourceState(skill, external) {
    if (!skill.source_id) return skill;
    const source = get(skill.source_id) || external.find(item => item.id === skill.source_id);
    try {
      return { ...skill, source_update_available: source ? sourceSnapshot(source).hash !== skill.source_hash : false, source_missing: !source };
    } catch { return { ...skill, source_update_available: false, source_missing: true }; }
  }
  function list({ includeExternal = true, projectId, includeAllProjects = false } = {}) {
    if (projectId) project(projectId);
    const external = externalSkills(projectId, includeAllProjects);
    return { managed: managed().filter(skill => includeAllProjects || visible(skill, projectId)).map(skill => sourceState(skill, external)), external: includeExternal ? external : [] };
  }
  function assertAvailable(id, projectId) {
    if (projectId) project(projectId);
    const skill = get(id, { projectId }) || externalSkills(projectId).find(item => item.id === id);
    if (!skill || !visible(skill, projectId)) throw Error('skill_not_found');
    if (skill.managed && skill.scope === 'project') checkProjectIsolation(skill.project_id);
    return skill;
  }
  function save(input, { expectedVersion = input?.version } = {}) {
    if (!input || typeof input !== 'object') throw Error('skill_input_required');
    if (String(input.id || '').startsWith('external:')) throw Error('external_skill_read_only');
    const current = input.id ? get(input.id) : null;
    if (input.id && !current) throw Error('skill_not_found');
    if (current && expectedVersion !== undefined && expectedVersion !== current.version) throw Error('version_conflict');
    const id = current?.id || randomUUID();
    const scope = input.scope ?? current?.scope ?? (input.project_id ? 'project' : 'global');
    const projectId = input.project_id ?? current?.project_id ?? null;
    if (!['global', 'project'].includes(scope) || (scope === 'global' && projectId)) throw Error('skill_scope_invalid');
    if (scope === 'project') project(projectId);
    if (!current && scope === 'project') checkProjectIsolation(projectId);
    if (current && (current.scope !== scope || current.project_id !== projectId)) throw Error('skill_scope_locked');
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
    } else db.prepare('INSERT INTO managed_skills(id,name,slug,description,instructions,created_at,updated_at,scope,project_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, name, slug, description, instructions, timestamp, timestamp, scope, projectId);
    return get(id);
  }
  function derive(input) {
    if (!input || !input.project_id) throw Error('skill_project_required');
    checkProjectIsolation(input.project_id);
    const sourceId = input.source_skill_id || input.source_id;
    const source = assertAvailable(sourceId, input.project_id);
    const snapshot = sourceSnapshot(source);
    return transaction(() => {
      const skill = save({ scope: 'project', project_id: String(input.project_id), name: input.name || source.name,
        slug: input.slug, description: input.description ?? snapshot.description, instructions: input.instructions ?? snapshot.instructions });
      const insert = db.prepare('INSERT INTO managed_skill_resources(skill_id,relative_path,content) VALUES(?,?,?)');
      for (const file of snapshot.files) insert.run(skill.id, safeResource(file.relative_path), file.content);
      db.prepare('UPDATE managed_skills SET source_id=?,source_version=?,source_hash=? WHERE id=?').run(source.id, snapshot.version, snapshot.hash, skill.id);
      return sourceState(get(skill.id), [source]);
    });
  }
  function deleteSkill(id, { expectedVersion } = {}) {
    if (String(id).startsWith('external:')) throw Error('external_skill_read_only');
    const current = get(id);
    if (!current) throw Error('skill_not_found');
    if (current.builtin) throw Error('builtin_skill_delete_forbidden');
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw Error('version_conflict');
    const destination = exportRoot(current);
    safeRoot(false, destination);
    // Files must be backed up successfully before removing the authoritative record.
    if (exists(destination)) {
      for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
        if (entry.isDirectory() && validSlug(entry.name)) removeOwned(path.join(destination, entry.name), current.id);
      }
    }
    const result = db.prepare('DELETE FROM managed_skills WHERE id=? AND version=?').run(current.id, current.version);
    if (Number(result.changes) !== 1) throw Error('version_conflict');
    db.prepare('DELETE FROM managed_skill_resources WHERE skill_id=?').run(current.id);
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
  function exportOwned({ projectId } = {}) {
    const report = { exported: [], unchanged: [], conflicts: [], deactivated: [] };
    const rows = managed().filter(skill => projectId === undefined || visible(skill, projectId));
    const destinations = new Set();
    for (const skill of rows) {
      let destination;
      try { destination = exportRoot(skill); safeRoot(false, destination); destinations.add(destination); } catch (error) { report.conflicts.push({ id: skill.id, path: skill.path, reason: error.message }); continue; }
      if (skill.scope === 'project') {
        try { checkProjectIsolation(skill.project_id); } catch (error) {
          const conflict = { id: skill.id, path: skill.path, reason: error.message };
          if (error.message === 'skill_project_root_shared') {
            try {
              for (const entry of exists(destination) ? fs.readdirSync(destination, { withFileTypes: true }) : []) {
                if (entry.isDirectory() && validSlug(entry.name) && removeOwned(path.join(destination, entry.name), skill.id)) report.deactivated.push(skill.id);
              }
            } catch (cleanupError) { conflict.cleanup_reason = cleanupError.message; }
          }
          report.conflicts.push(conflict);
          continue;
        }
      }
      safeRoot(true, destination);
      const folder = path.dirname(skill.path);
      const stat = exists(folder);
      if (stat && !owned(folder, skill.id)) { report.conflicts.push({ id: skill.id, path: skill.path, reason: 'skill_ownership_conflict' }); continue; }
      if (exists(skill.path) && !regular(skill.path)) { report.conflicts.push({ id: skill.id, path: skill.path, reason: 'skill_export_path_conflict' }); continue; }
      const content = document(skill);
      const files = resources(skill.id);
      try {
        if (stat) resourceConflicts(folder, files);
        else for (const file of files) safeResource(file.relative_path);
      } catch (error) { report.conflicts.push({ id: skill.id, path: skill.path, reason: error.message }); continue; }
      const metadata = { format: 1, owner, skill_id: skill.id, version: skill.version };
      if (skill.scope === 'project' || files.length) Object.assign(metadata, { scope: skill.scope, project_id: skill.project_id, export_root: destination,
        resources: files.map(file => ({ path: file.relative_path, hash: createHash('sha256').update(Buffer.from(file.content)).digest('hex') })) });
      const marker = `${JSON.stringify(metadata, null, 2)}\n`;
      if (stat && fs.readFileSync(path.join(folder, MARKER), 'utf8') === marker && regular(skill.path) && fs.readFileSync(skill.path, 'utf8') === content) {
        report.unchanged.push(skill.id); continue;
      }
      if (stat) backup(folder);
      else fs.mkdirSync(folder); // Exclusive directory claim: never take over an existing external directory.
      try {
        // New files are exclusive; updates are limited to verified owned files.
        if (stat) {
          replaceOwned(skill.path, content);
        } else {
          fs.writeFileSync(skill.path, content, { encoding: 'utf8', flag: 'wx' });
        }
        for (const file of files) {
          const resourcePath = path.join(folder, file.relative_path);
          safeRoot(true, path.dirname(resourcePath));
          if (regular(resourcePath)) replaceOwned(resourcePath, Buffer.from(file.content));
          else fs.writeFileSync(resourcePath, Buffer.from(file.content), { flag: 'wx' });
        }
        if (stat) replaceOwned(path.join(folder, MARKER), marker);
        else fs.writeFileSync(path.join(folder, MARKER), marker, { encoding: 'utf8', flag: 'wx' });
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
    for (const destination of destinations) {
    if (!exists(destination)) continue;
    try { safeRoot(false, destination); } catch { continue; }
    for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validSlug(entry.name)) continue;
      const folder = path.join(destination, entry.name);
      for (const skill of rows) {
        if (skill.path && path.dirname(path.dirname(skill.path)) === destination && entry.name !== skill.slug && !report.conflicts.some(conflict => conflict.id === skill.id)) removeOwned(folder, skill.id);
      }
    }
    }
    return report;
  }
  migrate();
  function deactivateProject(projectId) {
    const removed = [];
    for (const skill of managed().filter(item => item.scope === 'project' && item.project_id === String(projectId))) {
      const destination = exportRoot(skill);
      safeRoot(false, destination);
      for (const entry of exists(destination) ? fs.readdirSync(destination, { withFileTypes: true }) : []) {
        if (entry.isDirectory() && validSlug(entry.name) && removeOwned(path.join(destination, entry.name), skill.id)) removed.push(skill.id);
      }
    }
    return { deactivated: removed };
  }
  return { migrate, list, get, save, derive, assertAvailable, delete: deleteSkill, exportOwned, deactivateProject };
}
module.exports = { createManagedSkills };

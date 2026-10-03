'use strict';
const fs = require('node:fs');
const path = require('node:path');

const normalizeKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
function stat(file) { try { return fs.statSync(file); } catch { return null; } }
function canonical(file) {
  const resolved = path.resolve(file);
  try { return fs.realpathSync.native(resolved); }
  catch {
    // Resolve the nearest existing ancestor so missing descendants cannot hide an escape.
    let ancestor = resolved;
    const missing = [];
    while (true) {
      try { return path.join(fs.realpathSync.native(ancestor), ...missing.reverse()); }
      catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return resolved;
        missing.push(path.basename(ancestor)); ancestor = parent;
      }
    }
  }
}
function pathWithinRoots(file, roots, { allowRoot = true } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const target = canonical(file);
  return (Array.isArray(roots) ? roots : []).some(item => {
    const original = typeof item === 'string' ? item : item?.path || item?.canonical_path;
    if (typeof original !== 'string' || !path.isAbsolute(original) || !stat(original)?.isDirectory()) return false;
    const root = canonical(original);
    const relative = path.relative(root, target);
    return relative === '' ? allowRoot : !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
  });
}
function projectRoots(project) {
  const decode = value => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch {} }
    return [];
  };
  let roots = decode(project?.root_paths);
  if (!roots.length) roots = decode(project?.root_paths_json);
  if (!roots.length && typeof project?.workspace_path === 'string' && project.workspace_path.trim()) roots = [project.workspace_path];
  return roots.map(item => typeof item === 'string' ? item : item?.path).filter(item => typeof item === 'string' && item.trim());
}
function scanWorkspace(workspace, roots) {
  const facts = [];
  const add = (source, ecosystem, name, version, versionKind, extra = {}) => {
    if (!name || version === undefined || version === null || typeof version === 'object') return;
    facts.push({ workspace_id: workspace.id, source: path.join(workspace.path, source), ecosystem, name: String(name),
      version: String(version), version_kind: versionKind, runtime_version: 'unknown', ...extra });
  };
  const read = file => {
    const full = path.join(workspace.path, file);
    // A linked root is supported; a manifest link is not followed into another file.
    try { if (fs.lstatSync(full).isSymbolicLink()) return null; } catch { return null; }
    const info = stat(full);
    if (!info?.isFile() || info.size > 8 * 1024 * 1024 || !pathWithinRoots(full, roots, { allowRoot: false })) return null;
    try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
  };
  const json = file => { const content = read(file); if (content === null) return null; try { return JSON.parse(content); } catch { return null; } };
  const declarations = (file, ecosystem, source, fields) => {
    for (const field of fields) for (const [name, version] of Object.entries(source?.[field] || {})) add(file, ecosystem, name, version, 'declared', { scope: field });
  };
  const pkg = json('package.json');
  if (pkg) {
    declarations('package.json', 'node', pkg, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
    for (const [name, version] of Object.entries(pkg.engines || {})) add('package.json', 'node', name, version, 'declared', { scope: 'engines' });
    if (pkg.packageManager) add('package.json', 'node', 'packageManager', pkg.packageManager, 'declared');
  }
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lock = json(file);
    if (!lock) continue;
    if (lock.packages) {
      for (const [location, info] of Object.entries(lock.packages)) {
        if (!location || !info?.version) continue;
        const name = info.name || location.split('node_modules/').pop();
        add(file, 'node', name, info.version, 'locked', { package_path: location });
      }
    } else {
      const visit = dependencies => { for (const [name, info] of Object.entries(dependencies || {})) { add(file, 'node', name, info.version, 'locked'); visit(info.dependencies); } };
      visit(lock.dependencies);
    }
  }
  const yarn = read('yarn.lock');
  if (yarn !== null) {
    let names = [];
    for (const line of yarn.split(/\r?\n/)) {
      if (/^[^\s#].*:\s*$/.test(line) && !line.startsWith('__metadata:')) {
        names = line.slice(0, line.lastIndexOf(':')).split(/,\s*/).map(part => part.replace(/^['"]|['"]$/g, '').replace(/@(?:npm:)?[^@]*$/, ''));
      }
      const version = line.match(/^\s+version[:\s]+["']?([^\s"']+)/);
      if (version) for (const name of names) add('yarn.lock', 'node', name, version[1], 'locked');
    }
  }
  const pnpm = read('pnpm-lock.yaml');
  if (pnpm !== null) {
    // Package keys in pnpm v6+ contain resolved versions; importer specifiers remain declarations.
    for (const line of pnpm.split(/\r?\n/)) {
      const item = line.match(/^ {2}['"]?\/?(@?[^\s:'"]+?)(?:@|\/)(\d[^\s:'"(]*)(?:\([^\n]*)?['"]?:\s*$/);
      if (item) add('pnpm-lock.yaml', 'node', item[1], item[2], 'locked');
    }
  }
  const composer = json('composer.json');
  declarations('composer.json', 'php', composer, ['require', 'require-dev']);
  const composerLock = json('composer.lock');
  for (const field of ['packages', 'packages-dev']) for (const item of composerLock?.[field] || []) add('composer.lock', 'php', item.name, item.version, 'locked', { scope: field });
  const requirement = (file, line) => {
    const match = line.trim().match(/^([a-zA-Z0-9_.-]+)(?:\[[^\]]+\])?\s*([^;#]*)/);
    if (match) add(file, 'python', match[1], match[2].trim() || 'unspecified', 'declared');
  };
  const requirements = read('requirements.txt');
  if (requirements !== null) for (const line of requirements.split(/\r?\n/)) if (!/^\s*(?:#|--|-r|-e)/.test(line)) requirement('requirements.txt', line);
  const pyproject = read('pyproject.toml');
  if (pyproject !== null) {
    let section = '';
    let dependencyArray = false;
    for (const line of pyproject.split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) { section = header[1]; dependencyArray = false; continue; }
      if (section === 'project' && /^\s*requires-python\s*=/.test(line)) {
        const version = line.match(/=\s*["']([^"']+)/); if (version) add('pyproject.toml', 'python', 'python', version[1], 'declared', { scope: 'runtime_constraint' });
      }
      if (/^\s*dependencies\s*=\s*\[/.test(line) && section === 'project') dependencyArray = true;
      if (dependencyArray || section === 'project.optional-dependencies') {
        for (const match of line.matchAll(/["']([^"']+)["']/g)) requirement('pyproject.toml', match[1]);
        if (line.includes(']')) dependencyArray = false;
      }
      if (/^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(section)) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'])/);
        if (match) add('pyproject.toml', 'python', match[1], match[2] || match[3], 'declared');
      }
    }
  }
  for (const file of ['poetry.lock', 'uv.lock', 'Cargo.lock']) {
    const content = read(file);
    if (content === null) continue;
    for (const block of content.split(/\[\[package\]\]/).slice(1)) {
      const name = block.match(/^name\s*=\s*["']([^"']+)["']/m);
      const version = block.match(/^version\s*=\s*["']([^"']+)["']/m);
      if (name && version) add(file, file === 'Cargo.lock' ? 'rust' : 'python', name[1], version[1], 'locked');
    }
  }
  const go = read('go.mod');
  if (go !== null) {
    let requires = false;
    for (const raw of go.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (/^require\s*\(/.test(line)) { requires = true; continue; }
      if (line === ')') { requires = false; continue; }
      const runtime = line.match(/^(go|toolchain)\s+(\S+)/);
      if (runtime) add('go.mod', 'go', runtime[1], runtime[2], 'declared', { scope: 'runtime_constraint' });
      const dep = line.match(requires ? /^(\S+)\s+(v\S+)/ : /^require\s+(\S+)\s+(v\S+)/);
      if (dep) add('go.mod', 'go', dep[1], dep[2], 'declared');
    }
  }
  const goSum = read('go.sum');
  if (goSum !== null) for (const line of goSum.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(v\S+)\s+h1:/);
    if (match) add('go.sum', 'go', match[1], match[2].replace(/\/go\.mod$/, ''), 'locked', { scope: 'checksum_record' });
  }
  const cargo = read('Cargo.toml');
  if (cargo !== null) {
    let section = '';
    for (const line of cargo.split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) { section = header[1]; continue; }
      if (/(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)$/.test(section)) {
        const match = line.match(/^\s*([\w-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'])/);
        if (match) add('Cargo.toml', 'rust', match[1], match[2] || match[3], 'declared', { scope: section });
      }
      const rustVersion = line.match(/^\s*rust-version\s*=\s*["']([^"']+)/);
      if (section === 'package' && rustVersion) add('Cargo.toml', 'rust', 'rust', rustVersion[1], 'declared', { scope: 'runtime_constraint' });
    }
  }
  let entries = [];
  try { entries = fs.readdirSync(workspace.path, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!/\.(?:csproj|fsproj|vbproj)$/i.test(entry.name)) continue;
    const source = read(entry.name);
    if (source === null) continue;
    for (const match of source.matchAll(/<PackageReference\b([^>]*)(?:\/>|>([\s\S]*?)<\/PackageReference>)/g)) {
      const name = match[1].match(/\b(?:Include|Update)\s*=\s*["']([^"']+)["']/);
      const version = match[1].match(/\bVersion\s*=\s*["']([^"']+)["']/) || match[2]?.match(/<Version>([^<]+)<\/Version>/);
      if (name && version) add(entry.name, 'dotnet', name[1], version[1], 'declared');
    }
    for (const match of source.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)) add(entry.name, 'dotnet', 'TargetFramework', match[1], 'declared', { scope: 'runtime_constraint' });
  }
  const nuget = json('packages.lock.json');
  for (const [target, dependencies] of Object.entries(nuget?.dependencies || {})) for (const [name, info] of Object.entries(dependencies || {})) {
    if (info.resolved) add('packages.lock.json', 'dotnet', name, info.resolved, 'locked', { target });
  }
  const seen = new Set();
  return facts.filter(fact => { const key = JSON.stringify(fact); if (seen.has(key)) return false; seen.add(key); return true; });
}
function getWorkspaceContext(project, { scan = true, workspaceMap = project?.workspace_map } = {}) {
  const rootPaths = [];
  const workspaces = [];
  const seen = new Set();
  for (const original of projectRoots(project)) {
    const canonicalPath = canonical(original);
    const key = normalizeKey(canonicalPath);
    if (seen.has(key)) continue;
    seen.add(key); rootPaths.push(original);
    const info = stat(original);
    workspaces.push({ id: `workspace-${workspaces.length + 1}`, path: original, canonical_path: canonicalPath,
      role: 'unknown', availability: !info ? 'missing' : info.isDirectory() ? 'available' : 'not_directory', source_of_truth: 'unknown' });
  }
  const mapping = Array.isArray(workspaceMap) ? workspaceMap : workspaceMap && typeof workspaceMap === 'object'
    ? Object.entries(workspaceMap).map(([directory, value]) => ({ ...value, path: directory })) : [];
  const byCanonicalPath = new Map(workspaces.map(workspace => [normalizeKey(workspace.canonical_path), workspace]));
  for (const entry of mapping) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) continue;
    const workspace = byCanonicalPath.get(normalizeKey(canonical(entry.path)));
    if (!workspace) continue;
    // Saved metadata supplies descriptive facts only; it never introduces roots or permissions.
    for (const field of ['role', 'source_of_truth']) {
      if (typeof entry[field] === 'string' && entry[field].trim()) workspace[field] = entry[field].trim();
    }
  }
  const context = { root_paths: rootPaths, canonical_roots: workspaces.map(workspace => workspace.canonical_path), workspaces, stack_facts: [] };
  if (scan) for (const workspace of workspaces) if (workspace.availability === 'available') context.stack_facts.push(...scanWorkspace(workspace, rootPaths));
  return context;
}
module.exports = { getWorkspaceContext, pathWithinRoots };

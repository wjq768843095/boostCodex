'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getWorkspaceContext, pathWithinRoots } = require('../src/modules/workspace-context.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'better-codex-context-test-'));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const snapshot = folder => {
  const files = {};
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) files[entry.name] = `link:${fs.readlinkSync(file)}`;
    else if (entry.isDirectory()) for (const [child, value] of Object.entries(snapshot(file))) files[path.join(entry.name, child)] = value;
    else files[entry.name] = fs.readFileSync(file).toString('base64');
  }
  return files;
};
try {
  const frontend = path.join(temporary, '中文项目', '前端');
  const backend = path.join(temporary, '中文项目', '后台');
  const sibling = `${frontend}-sibling`;
  const missing = path.join(temporary, '待核对');
  const notDirectory = path.join(temporary, 'not-directory.txt');
  write(path.join(frontend, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.2.0' }, engines: { node: '>=22' } }));
  write(path.join(frontend, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { version: '0.1.0' }, 'node_modules/vue': { version: '3.4.1' } } }));
  write(path.join(backend, 'composer.json'), JSON.stringify({ require: { php: '^8.1', 'vendor/framework': '^6.0' } }));
  write(path.join(backend, 'composer.lock'), JSON.stringify({ packages: [{ name: 'vendor/framework', version: 'v6.2.3' }] }));
  write(path.join(frontend, '.env'), 'DO_NOT_READ');
  write(path.join(frontend, 'sub-business-repo', 'package.json'), JSON.stringify({ dependencies: { unrelated: '999.0.0' } }));
  write(path.join(sibling, 'package.json'), JSON.stringify({ dependencies: { outside: '999.0.0' } }));
  write(notDirectory, 'not a folder');
  const project = { root_paths: [frontend, path.join(frontend, '.'), backend, missing, notDirectory], workspace_path: sibling };
  const before = snapshot(temporary);
  const context = getWorkspaceContext(project);
  assert.deepEqual(context.root_paths, [frontend, backend, missing, notDirectory]);
  assert.deepEqual(context.workspaces.map(item => item.id), ['workspace-1', 'workspace-2', 'workspace-3', 'workspace-4']);
  assert.deepEqual(context.workspaces.map(item => item.availability), ['available', 'available', 'missing', 'not_directory']);
  assert.ok(context.workspaces.every(item => item.role === 'unknown' && item.source_of_truth === 'unknown'));
  assert.ok(context.stack_facts.every(item => item.runtime_version === 'unknown'));
  assert.deepEqual(context.stack_facts.filter(item => item.name === 'vue').map(item => [item.version_kind, item.version]), [['declared', '^3.2.0'], ['locked', '3.4.1']]);
  assert.deepEqual(context.stack_facts.filter(item => item.name === 'vendor/framework').map(item => [item.version_kind, item.version]), [['declared', '^6.0'], ['locked', 'v6.2.3']]);
  assert.ok(!context.stack_facts.some(item => ['unrelated', 'outside'].includes(item.name)));
  assert.deepEqual(snapshot(temporary), before);
  const mapped = getWorkspaceContext({ ...project, workspace_map: [
    { path: frontend, role: '前端业务界面', source_of_truth: '本地源码' },
    { path: backend, source_of_truth: '线上映射' },
    { path: sibling, role: '外部系统', source_of_truth: '外部权威' },
    { path: path.join(frontend, 'sub-business-repo'), role: '嵌套目录不成为根' },
    { path: path.dirname(frontend), role: '父目录不成为根' }
  ] });
  assert.deepEqual(mapped.root_paths, context.root_paths);
  assert.deepEqual(mapped.canonical_roots, context.canonical_roots);
  assert.equal(mapped.workspaces.length, context.workspaces.length);
  assert.equal(mapped.workspaces[0].role, '前端业务界面');
  assert.equal(mapped.workspaces[0].source_of_truth, '本地源码');
  assert.equal(mapped.workspaces[1].role, 'unknown');
  assert.equal(mapped.workspaces[1].source_of_truth, '线上映射');
  assert.ok(mapped.workspaces.slice(2).every(item => item.role === 'unknown' && item.source_of_truth === 'unknown'));
  assert.deepEqual(mapped.stack_facts, context.stack_facts);
  const keyed = getWorkspaceContext(project, { scan: false, workspaceMap: {
    [frontend]: { role: ' 前端职责 ', source_of_truth: '快照' },
    [backend]: { role: '后台业务', source_of_truth: '' },
    [sibling]: { role: '不能新增外部关联' }
  } });
  assert.deepEqual(keyed.root_paths, context.root_paths);
  assert.equal(keyed.workspaces[0].role, '前端职责');
  assert.equal(keyed.workspaces[0].source_of_truth, '快照');
  assert.equal(keyed.workspaces[1].role, '后台业务');
  assert.equal(keyed.workspaces[1].source_of_truth, 'unknown');
  assert.deepEqual(keyed.stack_facts, []);
  assert.deepEqual(snapshot(temporary), before);
  assert.deepEqual(getWorkspaceContext(project, { scan: false }).stack_facts, []);
  assert.deepEqual(getWorkspaceContext({ root_paths_json: JSON.stringify([frontend, backend]) }).root_paths, [frontend, backend]);
  assert.deepEqual(getWorkspaceContext({ workspace_path: backend }).root_paths, [backend]);
  assert.deepEqual(getWorkspaceContext({ root_paths: [] }).root_paths, []);
  assert.ok(pathWithinRoots(path.join(frontend, 'package.json'), context.root_paths));
  assert.ok(pathWithinRoots(path.join(frontend, 'new', 'future.js'), context.root_paths));
  assert.equal(pathWithinRoots(path.join(sibling, 'package.json'), [frontend]), false);
  assert.equal(pathWithinRoots(path.join(frontend, '..', '后台', 'composer.json'), [frontend]), false);
  assert.equal(pathWithinRoots(path.join(missing, 'future.js'), [missing]), false);
  assert.equal(pathWithinRoots('relative.js', [frontend]), false);
  assert.equal(pathWithinRoots(frontend, [frontend], { allowRoot: false }), false);
  assert.equal(pathWithinRoots(frontend, [frontend]), true);
  // All parser fixtures are explicit root-level manifests, never recursively discovered.
  const multi = path.join(temporary, '多栈');
  write(path.join(multi, 'pyproject.toml'), '[project]\nrequires-python = ">=3.11"\ndependencies = ["requests>=2.0"]\n');
  write(path.join(multi, 'requirements.txt'), 'urllib3==2.1.0\n-r ../external-requirements.txt\n');
  write(path.join(multi, 'uv.lock'), '[[package]]\nname = "requests"\nversion = "2.32.1"\n');
  write(path.join(multi, 'go.mod'), 'module example.invalid/project\ngo 1.23\nrequire (\n example.invalid/lib v1.2.3\n)\n');
  write(path.join(multi, 'go.sum'), 'example.invalid/lib v1.2.3 h1:fixture\n');
  write(path.join(multi, 'Cargo.toml'), '[package]\nrust-version = "1.75"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\n');
  write(path.join(multi, 'Cargo.lock'), '[[package]]\nname = "serde"\nversion = "1.0.200"\n');
  write(path.join(multi, 'service.csproj'), '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Example.Package" Version="1.2.*" /></ItemGroup></Project>');
  write(path.join(multi, 'packages.lock.json'), JSON.stringify({ dependencies: { net8: { 'Example.Package': { requested: '1.2.*', resolved: '1.2.3' } } } }));
  write(path.join(multi, 'pnpm-lock.yaml'), 'packages:\n  vue@3.4.2:\n    resolution: {integrity: fixture}\n');
  const facts = getWorkspaceContext({ root_paths: [multi] }).stack_facts;
  const fact = (name, versionKind, version) => facts.some(item => item.name === name && item.version_kind === versionKind && item.version === version);
  assert.ok(fact('requests', 'declared', '>=2.0'));
  assert.ok(fact('requests', 'locked', '2.32.1'));
  assert.ok(fact('urllib3', 'declared', '==2.1.0'));
  assert.ok(fact('example.invalid/lib', 'declared', 'v1.2.3'));
  assert.ok(fact('example.invalid/lib', 'locked', 'v1.2.3'));
  assert.ok(fact('serde', 'declared', '1.0'));
  assert.ok(fact('serde', 'locked', '1.0.200'));
  assert.ok(fact('Example.Package', 'declared', '1.2.*'));
  assert.ok(fact('Example.Package', 'locked', '1.2.3'));
  assert.ok(fact('vue', 'locked', '3.4.2'));
  // Windows junctions allow validating linked roots without file symlink privileges.
  const rootLink = path.join(temporary, '关联目录');
  const escapeLink = path.join(frontend, 'escape');
  try {
    fs.symlinkSync(backend, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(sibling, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = getWorkspaceContext({ root_paths: [rootLink, backend] });
    assert.deepEqual(linked.root_paths, [rootLink]);
    assert.equal(linked.workspaces[0].canonical_path, fs.realpathSync.native(backend));
    const linkedMapping = getWorkspaceContext({ root_paths: [rootLink] }, { scan: false, workspaceMap: [{
      path: backend, role: '映射后台', source_of_truth: '线上映射'
    }, { path: sibling, role: '忽略未关联目录' }] });
    assert.deepEqual(linkedMapping.root_paths, [rootLink]);
    assert.equal(linkedMapping.workspaces[0].role, '映射后台');
    assert.equal(linkedMapping.workspaces[0].source_of_truth, '线上映射');
    const canonicalRootMapping = getWorkspaceContext({ root_paths: [backend] }, { scan: false, workspaceMap: {
      [rootLink]: { role: '关联目录职责', source_of_truth: '本地源码' }
    } });
    assert.deepEqual(canonicalRootMapping.root_paths, [backend]);
    assert.equal(canonicalRootMapping.workspaces[0].role, '关联目录职责');
    assert.equal(canonicalRootMapping.workspaces[0].source_of_truth, '本地源码');
    assert.ok(pathWithinRoots(path.join(rootLink, 'composer.json'), [rootLink]));
    assert.equal(pathWithinRoots(path.join(escapeLink, 'package.json'), [frontend]), false);
    assert.equal(pathWithinRoots(path.join(escapeLink, 'missing.txt'), [frontend]), false);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('NOTE: linked directory creation unavailable; remaining path boundaries tested.');
  }
  console.log('PASS: read-only multi-root context, Chinese/linked root metadata mapping without root expansion, unknown missing metadata, missing roots, escape boundaries, sibling-prefix rejection, manifest/lock distinction, runtime unknown');
} finally {
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), 'better-codex-context-test-')));
  fs.rmSync(temporary, { recursive: true, force: true });
}

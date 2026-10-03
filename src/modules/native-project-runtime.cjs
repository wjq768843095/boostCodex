'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createProjectPlanning } = require('./project-planning.cjs');
const { createManagedSkills } = require('./managed-skills.cjs');
const { getWorkspaceContext } = require('./workspace-context.cjs');

function directoryBrief(workspace) {
  return workspace.workspaces.map(entry => `- ${entry.id}: ${entry.path}；职责：${entry.role === 'unknown' ? '待确认' : entry.role}；数据来源：${entry.source_of_truth === 'unknown' ? '待核对' : entry.source_of_truth}${entry.availability === 'available' ? '' : '（无法访问，待核对）'}`).join('\n');
}

function ensureNativeTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS issue_native_ownership (
    issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    owner TEXT NOT NULL CHECK(owner='native'), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issue_managed_skills (
    issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
    skill_id TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_native_activity (
    thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, status TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

function createNativeProjectRuntime({ store, worker, home, userHome = process.env.BETTER_CODEX_SKILLS_USER_HOME, codexHome, publishChange = () => {} }) {
  ensureNativeTables(store.db);
  const planning = createProjectPlanning({ db: store.db, home,
    getProject: id => store.getProject(id), createIssue: input => store.createIssue(input),
    getIssue: id => store.getIssue(id), listIssues: projectId => store.listIssues({ projectId }),
    updateIssue: (id, version, patch) => store.updateIssue(id, version, patch)
  });
  planning.migrate();
  const skills = createManagedSkills({ db: store.db, home, userHome, codexHome, profiles: store.listAgentProfiles() });
  let exportStatus = skills.exportOwned();
  if (exportStatus.conflicts?.length) console.error('BETTER_CODEX_DIAGNOSTIC ' + JSON.stringify({ scope: 'managed_skills', event: 'export_conflict', conflicts: exportStatus.conflicts.map(entry => typeof entry === 'string' ? entry : entry.id || entry.slug) }));
  // Claimed native operations with a checkpoint are never resent on restart.
  for (const row of store.db.prepare("SELECT DISTINCT relay_id FROM project_native_commands WHERE status='claimed' AND relay_id IS NOT NULL").all()) planning.recoverCommands(row.relay_id);

  const skillList = () => {
    const groups = skills.list();
    const conflicts = new Set(exportStatus.conflicts?.map(entry => entry.id) || []);
    return { managed: groups.managed.map(skill => ({ ...skill, available: !conflicts.has(skill.id), ...(conflicts.has(skill.id) ? { path: '' } : {}) })), external: groups.external };
  };
  const findSkill = id => {
    const groups = skillList();
    return [...groups.managed, ...groups.external].find(skill => skill.id === id) || null;
  };
  function setIssueSkill(issueId, skillId) {
    if (!store.getIssue(issueId)) throw Error('issue_not_found');
    if (skillId && !findSkill(skillId)) throw Error('skill_not_found');
    if (!skillId) store.db.prepare('DELETE FROM issue_managed_skills WHERE issue_id=?').run(issueId);
    else store.db.prepare(`INSERT INTO issue_managed_skills(issue_id,skill_id,updated_at) VALUES(?,?,?)
      ON CONFLICT(issue_id) DO UPDATE SET skill_id=excluded.skill_id,updated_at=excluded.updated_at`).run(issueId, skillId, new Date().toISOString());
  }
  function enrichIssue(issue) {
    if (!issue) return issue;
    const selected = store.db.prepare('SELECT skill_id FROM issue_managed_skills WHERE issue_id=?').get(issue.id);
    const skill = selected ? findSkill(selected.skill_id) : skills.list({ includeExternal: false }).managed.find(entry => entry.legacy_agent_id === issue.agent_id);
    return { ...issue, skill_id: skill?.id || '', skill_name: skill?.name || '',
      session_native_owned: Boolean(store.db.prepare('SELECT 1 FROM issue_native_ownership WHERE issue_id=?').get(issue.id)) };
  }
  function context(projectId, options = {}) {
    const sessions = ['charter', 'planning'].map(kind => planning.getSession(projectId, kind));
    const tasks = store.listIssues({ projectId });
    const workTask = options.thread_id && !sessions.some(session => session?.thread_id === options.thread_id)
      ? tasks.find(issue => [issue.thread_id, issue.session_thread_id, issue.run_thread_id].includes(options.thread_id)) : null;
    const link = workTask && store.db.prepare('SELECT item_id,charter_revision,plan_revision FROM project_planning_issue_links WHERE issue_id=?').get(workTask.id);
    const value = planning.getContext(projectId, workTask ? { ...options, thread_id: undefined,
      ...(link ? { charter_revision: options.charter_revision ?? options.revision ?? link.charter_revision, plan_revision: options.plan_revision ?? link.plan_revision } : {}) } : options);
    if (workTask) value.confirmation_candidates = [];
    const project = store.getProject(projectId);
    const groups = skillList();
    return { ...value, project: { ...value.project, root_paths: project.root_paths || [] }, ...getWorkspaceContext(project, { workspaceMap: value.charter?.metadata?.workspace_map }),
      tasks: tasks.map(issue => ({ id: issue.id, title: issue.title, status: issue.status, version: issue.version })),
      ...(workTask ? { task: { id: workTask.id, title: workTask.title, description: workTask.description, ...link } } : {}),
      skills: [...groups.managed, ...groups.external].map(({ id, name, slug, description, path, managed }) => ({ id, name, slug, description, path, managed })) };
  }
  function openingPayload(project, kind) {
    const charter = planning.getCharter(project.id);
    const workspace = getWorkspaceContext(project, { scan: false, workspaceMap: charter?.metadata?.workspace_map });
    const skill = skills.get(kind === 'charter' ? 'better-codex-charter' : 'better-codex-plan');
    if (exportStatus.conflicts?.some(entry => entry.id === skill.id)) throw Error('skill_name_conflict');
    const message = [
      kind === 'charter' ? '开始制定这个项目的总纲。先调查项目现状、实际技术栈、目录职责和已有需求，再与我澄清关键问题。所有架构、共享契约与交付约束集中在一份总纲中。保存草稿；只有我在本会话明确确认总纲后才确认版本。' : '根据这个项目已确认的总纲制定任务列表。按可独立验收的业务闭环拆分，保留需求来源、目录、共享契约、依赖、产物和人工验收步骤。保存规划资料，等待我选择转换任务；本次不执行开发。',
      `项目 ID：${project.id}\n本原生会话 ID：__BETTER_CODEX_THREAD_ID__\n使用 $${skill.slug}。通过 Better Codex 项目工具读取与保存资料。`,
      '关联目录：\n' + directoryBrief(workspace),
      '请先调用 project_context_read。依据项目规则与当前文件取证；无法核对的运行版本保留未知。'
    ].join('\n\n');
    return { native_defaults: true, workspace_path: project.workspace_path, root_paths: workspace.root_paths,
      title: `${project.name} · ${kind === 'charter' ? '项目总纲' : '任务规划'}`,
      message, input: [{ type: 'text', text: message }, ...(skill.path ? [{ type: 'skill', name: skill.slug, path: skill.path }] : [])] };
  }
  function startSession(projectId, body) {
    const project = store.getProject(projectId);
    if (!project) throw Error('project_not_found');
    const kind = body.kind;
    if (!['charter', 'planning'].includes(kind)) throw Error('invalid_session_kind');
    const session = planning.getSession(projectId, kind);
    const pending = planning.listPendingCommands().find(command => command.project_id === projectId && command.session_kind === kind);
    const claimed = store.db.prepare("SELECT request_id FROM project_native_commands WHERE project_id=? AND kind=? AND status='claimed' LIMIT 1").get(projectId, kind);
    const unfinished = pending || (claimed && planning.getCommand(claimed.request_id));
    // A first checkpoint binds the thread before its visible first turn exists.
    // Keep repeat clicks attached to that command until the native start completes.
    if (unfinished?.kind === 'start') return { session: null, command: unfinished, prompt: unfinished.payload.message };
    const unknown = store.db.prepare("SELECT request_id FROM project_native_commands WHERE project_id=? AND kind=? AND command='start' AND status='outcome_unknown' AND turn_id IS NULL LIMIT 1").get(projectId, kind);
    if (unknown) return { session: null, command: planning.getCommand(unknown.request_id) };
    if (session) return { session, command: null };
    if (kind === 'planning' && planning.getCharter(projectId)?.status !== 'confirmed') throw Error('confirmed_charter_required');
    const command = unfinished || planning.enqueueCommand({ project_id: projectId, session_kind: kind, kind: 'start', expected_revision: 0, request_id: body.request_id || randomUUID(), payload: openingPayload(project, kind) });
    return { session: null, command, prompt: command.payload.message };
  }
  function handleProjectEvent(method, params) {
    const row = store.db.prepare('SELECT * FROM project_native_sessions WHERE thread_id=?').get(params.threadId);
    if (!row) return false;
    const item = params.item;
    if (['item/started', 'item/completed'].includes(method) && item?.type === 'userMessage') {
      const message = Array.isArray(item.content) ? item.content.filter(entry => entry.type === 'text').map(entry => entry.text || '').join('\n') : String(item.text || '');
      if (item.id && message.trim()) planning.recordSessionEvent({ project_id: row.project_id, kind: row.kind, thread_id: row.thread_id, event_id: item.id, role: 'user', message, expected_revision: planning.getCharter(row.project_id)?.revision || 0 });
    }
    if (method === 'turn/started' || method === 'thread/status/changed' || method === 'turn/completed') {
      const turnId = params.turn?.id;
      if (method === 'turn/started' && turnId) store.db.prepare(`INSERT INTO project_native_activity(thread_id,turn_id,status,updated_at) VALUES(?,?,'running',?)
        ON CONFLICT(thread_id) DO UPDATE SET turn_id=excluded.turn_id,status='running',updated_at=excluded.updated_at`).run(row.thread_id, turnId, new Date().toISOString());
      if (method === 'turn/completed' && turnId) {
        const activity = store.db.prepare('SELECT turn_id FROM project_native_activity WHERE thread_id=?').get(row.thread_id);
        if (activity && activity.turn_id !== turnId) return true;
        store.db.prepare("UPDATE project_native_activity SET status='ready',updated_at=? WHERE thread_id=? AND turn_id=?").run(new Date().toISOString(), row.thread_id, turnId);
      }
      const status = method === 'turn/started' || params.status?.type === 'active' ? 'running' : method === 'turn/completed' && params.turn?.status === 'failed' ? 'failed' : 'ready';
      store.db.prepare('UPDATE project_native_sessions SET status=?,last_error=?,updated_at=? WHERE thread_id=?').run(status, params.turn?.error?.message || null, new Date().toISOString(), row.thread_id);
      publishChange();
    }
    return true;
  }
  async function handle({ url, method, request, response, readBody, sendJson }) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (value, status = 200) => { sendJson(response, status, value); return true; };
    if (parts[0] !== 'api') return false;
    if (parts[1] === 'skills') {
      if (parts[2] && ['PATCH', 'DELETE'].includes(method) && findSkill(parts[2])?.managed === false) throw Error('external_skill_read_only');
      if (parts.length === 2 && method === 'GET') return send(skillList());
      if (parts.length === 2 && method === 'POST' || parts.length === 3 && method === 'PATCH') {
        const body = await readBody(request);
        if (method === 'PATCH' && (!Number.isSafeInteger(body.version) || body.version < 1)) throw Error('invalid_version');
        const skill = skills.save({ ...body, ...(parts[2] ? { id: parts[2] } : {}) }, { expectedVersion: body.version });
        const exported = exportStatus = skills.exportOwned(); publishChange();
        return send({ skill: skills.get(skill.id), export_status: exported }, method === 'POST' ? 201 : 200);
      }
      if (parts.length === 3 && method === 'GET') {
        const skill = findSkill(parts[2]); if (!skill) throw Error('skill_not_found'); return send({ skill });
      }
      if (parts.length === 3 && method === 'DELETE') { const body = await readBody(request); if (!Number.isSafeInteger(body.version) || body.version < 1) throw Error('invalid_version'); skills.delete(parts[2], { expectedVersion: body.version }); publishChange(); return send({ deleted: true }); }
      return send({ error: 'not_found' }, 404);
    }
    if (parts[1] === 'project-tools' && method === 'POST') {
      const body = await readBody(request);
      const name = parts[2];
      if (name === 'project_context_read') return send(context(body.project_id, body));
      let value;
      if (name === 'project_charter_save') value = planning.saveCharter(body);
      else if (name === 'project_charter_confirm') value = planning.confirmCharter(body);
      else if (name === 'project_plan_save') value = planning.savePlan(body);
      else if (name === 'project_plan_convert') value = convert(body);
      else throw Error('tool_not_found');
      publishChange(); return send(value);
    }
    if (parts[1] !== 'projects' || !parts[2]) return false;
    const projectId = parts[2];
    if (parts[3] === 'planning-context' && method === 'GET') return send(context(projectId));
    if (parts[3] === 'native-session' && method === 'POST') {
      const body = await readBody(request);
      if (parts[4] === 'bind') {
        // Bind only an operation checkpoint owned by the current native proxy.
        if (!store.nativeSessionProxyIsLeader(body.relay_id)) throw Error('session_relay_not_leader');
        const command = planning.getCommand(body.request_id);
        if (!command || command.project_id !== projectId || command.session_kind !== body.kind) throw Error('command_project_mismatch');
        return send({ command: planning.checkpointCommand({ id: body.request_id, relay_id: body.relay_id, thread_id: body.thread_id, turn_id: body.turn_id }), session: planning.getSession(projectId, body.kind) });
      }
      return send(startSession(projectId, body), 202);
    }
    if (parts[3] === 'charter') {
      if (method === 'GET') return send(planning.getCharter(projectId, { ...(url.searchParams.has('revision') ? { revision: Number(url.searchParams.get('revision')) } : {}), ...(url.searchParams.has('sections') ? { section_ids: url.searchParams.get('sections').split(',') } : {}) }));
      if (method === 'POST') { const body = await readBody(request); const value = parts[4] === 'confirm' ? planning.confirmCharter({ ...body, project_id: projectId }) : planning.saveCharter({ ...body, project_id: projectId }); publishChange(); return send(value); }
    }
    if (parts[3] === 'plan') {
      if (method === 'GET') return send(planning.getPlan(projectId));
      if (method === 'POST') {
        const body = await readBody(request);
        const value = parts[4] === 'convert' ? convert({ ...body, project_id: projectId, thread_id: body.thread_id || planning.getSession(projectId, 'planning')?.thread_id }) : planning.savePlan({ ...body, project_id: projectId });
        publishChange(); return send(value);
      }
    }
    return false;
  }
  function convert(body) {
    const bound = planning.getSession(body.project_id, 'planning');
    if (!bound || bound.thread_id !== body.thread_id) throw Error('session_thread_mismatch');
    const plan = planning.getPlan(body.project_id);
    if (!plan || body.expected_revision !== plan.revision) throw Error('version_conflict');
    if (!Array.isArray(body.item_ids) || !body.item_ids.length || body.item_ids.some(id => !plan.items.some(item => item.id === id))) throw Error('invalid_item_ids');
    // Snapshot only the project rows and selected task rows affected by this handoff.
    const existing = store.db.prepare('SELECT * FROM project_planning_issue_links WHERE project_id=?').all(body.project_id);
    const selected = existing.filter(link => body.item_ids?.includes(link.item_id));
    if (body.action === 'update' || selected.length !== body.item_ids?.length) {
      const folder = path.join(home, 'backups', 'project-planning');
      fs.mkdirSync(folder, { recursive: true });
      const backup = path.join(folder, randomUUID() + '.json');
      fs.writeFileSync(backup, JSON.stringify({ created_at: new Date().toISOString(), project: store.getProject(body.project_id), links: selected, issues: selected.map(link => store.getIssue(link.issue_id)), plan }, null, 2), { flag: 'wx' });
      if (fs.statSync(backup).size === 0) throw Error('project_backup_failed');
    }
    const value = planning.convertItems(body);
    for (const result of value.items) {
      const link = store.db.prepare('SELECT item_json FROM project_planning_issue_links WHERE issue_id=?').get(result.issue_id);
      const selected = link && JSON.parse(link.item_json).skill_id;
      if (selected && findSkill(selected)) setIssueSkill(result.issue_id, selected);
    }
    return { ...value, issues: value.items.map(result => enrichIssue(store.getIssue(result.issue_id))) };
  }
  function commandReceipt(id, relayId, action, result = {}, error) {
    const command = planning.getCommand(id);
    if (!command) return null;
    if (!store.nativeSessionProxyIsLeader(relayId) || command.relay_id !== relayId) throw Error('session_relay_not_leader');
    if (action === 'checkpoint') {
      const updated = planning.checkpointCommand({ id, relay_id: relayId, thread_id: result.thread_id, turn_id: result.turn_id });
      if (result.turn_id) handleProjectEvent('turn/started', { threadId: result.thread_id, turn: { id: result.turn_id } });
      return updated;
    }
    // Failure before thread/start has no binding to assert, but cannot be replayed implicitly.
    if (action === 'fail' && !command.thread_id) {
      store.db.prepare("UPDATE project_native_commands SET status='failed',last_error=?,revision=revision+1,updated_at=? WHERE request_id=? AND status='claimed'").run(error || 'desktop_bridge_request_failed', new Date().toISOString(), id);
      return planning.getCommand(id);
    }
    return planning.finishCommand({ request_id: id, project_id: command.project_id, session_kind: command.session_kind, thread_id: command.thread_id, expected_revision: command.revision, relay_id: relayId, result, ...(action === 'fail' ? { status: 'failed', error: error || 'desktop_bridge_request_failed' } : {}) });
  }
  const activeTurns = () => store.db.prepare("SELECT activity.thread_id,activity.turn_id FROM project_native_activity AS activity JOIN project_native_sessions AS sessions ON sessions.thread_id=activity.thread_id WHERE activity.status='running' AND sessions.status='running'").all();
  return { planning, skills, context, handle, startSession, handleProjectEvent, commandReceipt, enrichIssue, setIssueSkill, findSkill, activeTurns };
}

function workPayload(store, issue, workspacePath, message, input) {
  const runtime = store.nativeProjectRuntime;
  const project = store.getProject(issue.project_id);
  const enriched = runtime?.enrichIssue(issue) || issue;
  const skill = enriched.skill_id && runtime?.findSkill(enriched.skill_id);
  const link = store.db.prepare('SELECT charter_revision,plan_revision,item_id FROM project_planning_issue_links WHERE issue_id=?').get(issue.id);
  const charter = link ? runtime?.planning.getCharter(issue.project_id, { revision: link.charter_revision }) : runtime?.planning.getCharter(issue.project_id);
  const workspace = getWorkspaceContext(project || { workspace_path: workspacePath }, { scan: false, workspaceMap: charter?.metadata?.workspace_map });
  const context = [`Better Codex 项目 ID：${issue.project_id}`, '本原生会话 ID：__BETTER_CODEX_THREAD_ID__',
    '关联目录：\n' + directoryBrief(workspace),
    ...(charter?.status === 'confirmed' ? [`项目总纲版本：${charter.revision}。按需使用 project_context_read 读取此版本的相关章节。${link ? `规划版本：${link.plan_revision}；规划项：${link.item_id}。` : ''}`] : [])].join('\n\n');
  const combined = context + '\n\n' + message;
  const original = input || [{ type: 'text', text: message }];
  return { native_defaults: true, root_paths: workspace.root_paths, workspace_path: workspacePath,
    title: `${issue.identifier} ${issue.title}`.trim().slice(0, 200), message: combined,
    input: [{ type: 'text', text: context + '\n\n' }, ...original, ...(skill?.path ? [{ type: 'skill', name: skill.slug || skill.name, path: skill.path }] : [])],
    config_fingerprint: JSON.stringify({ roots: workspace.root_paths, skill: skill?.id || '', version: skill?.version || 0, charter_revision: charter?.status === 'confirmed' ? charter.revision : 0 }) };
}
module.exports = { ensureNativeTables, createNativeProjectRuntime, workPayload };

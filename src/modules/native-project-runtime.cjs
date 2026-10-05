'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createProjectPlanning } = require('./project-planning.cjs');
const { createManagedSkills } = require('./managed-skills.cjs');
const { getWorkspaceContext } = require('./workspace-context.cjs');
const { createNativeConversationRuntime, ensureConversationTables } = require('./native-conversation-runtime.cjs');
const { nativeTools } = require('./project-mcp.cjs');
const { readPinnedPlanningItem, buildWorkContextText } = require('./native-work-context.cjs');

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
  ensureConversationTables(db);
}

function createNativeProjectRuntime({ store, worker, home, userHome = process.env.BETTER_CODEX_SKILLS_USER_HOME, codexHome, publishChange = () => {} }) {
  ensureNativeTables(store.db);
  const planning = createProjectPlanning({ db: store.db, home,
    getProject: id => store.getProject(id), createIssue: input => store.createIssue(input),
    getIssue: id => store.getIssue(id), listIssues: projectId => store.listIssues({ projectId }),
    updateIssue: (id, version, patch) => store.updateIssue(id, version, patch)
  });
  planning.migrate();
  const skills = createManagedSkills({ db: store.db, home, userHome, codexHome, profiles: store.listAgentProfiles(), resolveProject: id => store.getProject(id), listProjects: () => store.listProjects?.() || [] });
  let exportStatus = skills.exportOwned();
  const projectSignature = () => JSON.stringify((store.listProjects?.() || []).map(project => [project.id, project.workspace_path]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  let exportedProjects = projectSignature();
  function refreshSkillExports(force = false) {
    const signature = projectSignature();
    if (force || signature !== exportedProjects) { exportStatus = skills.exportOwned(); exportedProjects = signature; }
    return exportStatus;
  }
  async function refreshNativeSkills(skill) {
    if (typeof worker.semanticRequest !== 'function') return false;
    const projects = store.listProjects?.() || [];
    const candidates = skill?.scope === 'project' ? [store.getProject(skill.project_id)?.workspace_path] : [process.cwd(), ...projects.map(project => project.workspace_path)];
    const cwds = [...new Set(candidates.filter(folder => { try { return folder && fs.statSync(folder).isDirectory(); } catch { return false; } }))];
    if (!cwds.length) return false;
    try { await worker.semanticRequest('skills/list', { cwds, forceReload: true }, 3000); return true; }
    catch { return false; }
  }
  if (exportStatus.conflicts?.length) console.error('BETTER_CODEX_DIAGNOSTIC ' + JSON.stringify({ scope: 'managed_skills', event: 'export_conflict', conflicts: exportStatus.conflicts.map(entry => typeof entry === 'string' ? entry : entry.id || entry.slug) }));
  // Claimed native operations with a checkpoint are never resent on restart.
  for (const row of store.db.prepare("SELECT DISTINCT relay_id FROM project_native_commands WHERE status='claimed' AND relay_id IS NOT NULL").all()) planning.recoverCommands(row.relay_id);
  // Earlier UI versions queued a generated initial prompt just by opening a
  // project. Preserve those records, but never dispatch them in the new flow.
  const automaticStarts = store.db.prepare("SELECT * FROM project_native_commands WHERE command='start' AND status='pending' AND thread_id=''").all()
    .filter(row => JSON.parse(row.payload_json).native_defaults === true);
  if (automaticStarts.length) {
    const folder = path.join(home,'backups','native-conversations'); fs.mkdirSync(folder,{recursive:true});
    const filename = path.join(folder,randomUUID()+'.json');
    fs.writeFileSync(filename,JSON.stringify({kind:'retired_automatic_starts',rows:automaticStarts,created_at:new Date().toISOString()},null,2),{flag:'wx'});
    if (!fs.statSync(filename).size) throw Error('project_backup_failed');
    const retire = store.db.prepare("UPDATE project_native_commands SET status='failed',last_error='native_explicit_send_required',revision=revision+1,updated_at=? WHERE request_id=? AND status='pending' AND thread_id=''");
    for (const row of automaticStarts) retire.run(new Date().toISOString(),row.request_id);
  }

  const skillList = (projectId, includeAllProjects = projectId === undefined) => {
    refreshSkillExports();
    const groups = skills.list({ ...(projectId === undefined ? {} : { projectId }), includeAllProjects });
    const conflicts = new Set(exportStatus.conflicts?.map(entry => entry.id) || []);
    return { managed: groups.managed.map(skill => ({ ...skill, available: !conflicts.has(skill.id), ...(conflicts.has(skill.id) ? { path: '' } : {}) })), external: groups.external };
  };
  const findSkill = (id, projectId) => {
    const groups = skillList(projectId);
    return [...groups.managed, ...groups.external].find(skill => skill.id === id) || null;
  };
  function assertSkill(id, projectId) {
    skills.assertAvailable(id, projectId);
    const known = findSkill(id, projectId) || findSkill(id);
    if (!known) throw Error('skill_not_found');
    if (known.scope === 'project' && known.project_id !== projectId) throw Error('skill_project_mismatch');
    if (known.available === false || !known.path) throw Error('skill_export_path_conflict');
    return known;
  }
  function assertSkillPaths(paths, projectId) {
    if (!Array.isArray(paths) || paths.length > 100 || paths.some(value => typeof value !== 'string' || !value || value.length > 4096)) throw Error('invalid_skill_paths');
    const normalize = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
    const all = skills.list({ includeAllProjects: true });
    for (const value of paths) {
      const known = [...all.managed, ...all.external].find(skill => skill.path && normalize(skill.path) === normalize(value));
      if (known && !findSkill(known.id, projectId)) throw Error('skill_project_mismatch');
      if (known) assertSkill(known.id, projectId);
    }
    return true;
  }
  function setIssueSkill(issueId, skillId) {
    const issue = store.getIssue(issueId);
    if (!issue) throw Error('issue_not_found');
    if (skillId) assertSkill(skillId, issue.project_id);
    if (!skillId) store.db.prepare('DELETE FROM issue_managed_skills WHERE issue_id=?').run(issueId);
    else store.db.prepare(`INSERT INTO issue_managed_skills(issue_id,skill_id,updated_at) VALUES(?,?,?)
      ON CONFLICT(issue_id) DO UPDATE SET skill_id=excluded.skill_id,updated_at=excluded.updated_at`).run(issueId, skillId, new Date().toISOString());
  }
  function enrichIssue(issue) {
    if (!issue) return issue;
    const selected = store.db.prepare('SELECT skill_id FROM issue_managed_skills WHERE issue_id=?').get(issue.id);
    const skill = selected ? findSkill(selected.skill_id, issue.project_id) : skills.list({ includeExternal: false, projectId: issue.project_id }).managed.find(entry => entry.legacy_agent_id === issue.agent_id);
    return { ...issue, skill_id: skill?.id || '', skill_name: skill?.name || '',
      session_native_owned: Boolean(store.db.prepare('SELECT 1 FROM issue_native_ownership WHERE issue_id=?').get(issue.id)) };
  }
  function context(projectId, options = {}) {
    const sessions = ['charter', 'planning'].map(kind => planning.getSession(projectId, kind));
    const tasks = store.listIssues({ projectId });
    const threadBinding = options.thread_id && store.db.prepare('SELECT project_id,issue_id,kind FROM native_conversation_bindings WHERE thread_id=? AND archived_at IS NULL').get(options.thread_id);
    if (threadBinding && (threadBinding.project_id !== projectId || options.issue_id &&
      (threadBinding.kind !== 'work' || threadBinding.issue_id !== options.issue_id))) throw Error('session_thread_mismatch');
    let workBinding = threadBinding?.kind === 'work' ? threadBinding : null;
    if (options.thread_id && !threadBinding) {
      workBinding = store.db.prepare("SELECT project_id,issue_id FROM issue_native_conversations WHERE thread_id=? AND status!='closed'").get(options.thread_id);
      // Earlier native work sessions may only have an issue_sessions checkpoint.
      // Read that exact stored identity, rather than trusting a caller-supplied ID.
      if (!workBinding && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='issue_sessions'").get()) {
        const saved = store.db.prepare('SELECT issue_id FROM issue_sessions WHERE thread_id=?').get(options.thread_id);
        const savedIssue = saved && store.getIssue(saved.issue_id);
        if (savedIssue) workBinding = { project_id: savedIssue.project_id, issue_id: savedIssue.id };
      }
      if (workBinding && (workBinding.project_id !== projectId || options.issue_id && workBinding.issue_id !== options.issue_id)) throw Error('session_thread_mismatch');
    }
    const workTask = options.issue_id ? tasks.find(issue => issue.id === options.issue_id) : options.thread_id && !sessions.some(session => session?.thread_id === options.thread_id)
      ? workBinding ? tasks.find(issue => issue.id === workBinding.issue_id) : tasks.find(issue => [issue.thread_id, issue.session_thread_id, issue.run_thread_id].includes(options.thread_id)) : null;
    if (options.issue_id && !workTask) throw Error('issue_project_mismatch');
    if (workTask && options.thread_id && !workBinding && ![workTask.thread_id, workTask.session_thread_id, workTask.run_thread_id].includes(options.thread_id)) throw Error('session_thread_mismatch');
    const link = workTask && store.db.prepare('SELECT project_id,item_id,charter_revision,plan_revision,item_json FROM project_planning_issue_links WHERE issue_id=?').get(workTask.id);
    if (link && link.project_id !== projectId) throw Error('issue_project_mismatch');
    const value = planning.getContext(projectId, workTask ? { ...options, thread_id: undefined,
      ...(link ? { charter_revision: link.charter_revision, plan_revision: link.plan_revision } : {}) } : options);
    if (workTask) value.confirmation_candidates = [];
    const project = store.getProject(projectId);
    const groups = skillList(projectId);
    const planningLinks=store.db.prepare('SELECT item_id,issue_id,charter_revision,plan_revision FROM project_planning_issue_links WHERE project_id=?').all(projectId);
    const workspace = getWorkspaceContext(project, { workspaceMap: value.charter?.metadata?.workspace_map });
    const planningItem = readPinnedPlanningItem(link);
    const task = workTask ? { id: workTask.id, project_id: projectId, version: workTask.version,
      title: workTask.title, description: workTask.description, status:workTask.status,agent_enabled:Boolean(workTask.agent_enabled),
      active_run_status:workTask.active_run_status || null,session_status:workTask.session_status || null,session_active_turn_id:workTask.session_active_turn_id || null,
      reply_status:workTask.reply_status || store.getIssueReplyState?.(workTask.id)?.status || 'idle',archived_at:workTask.archived_at || null,
      ...(link ? { item_id: link.item_id, charter_revision: link.charter_revision, plan_revision: link.plan_revision } : {}), planning_item: planningItem } : null;
    return { ...value, project: { ...value.project, root_paths: project.root_paths || [] }, ...workspace,
      tasks: tasks.map(issue => ({ id: issue.id, title: issue.title, status: issue.status, version: issue.version,archived_at:issue.archived_at || null,...planningLinks.find(entry=>entry.issue_id===issue.id) })),
      planning_links: planningLinks.map(entry=>{const issue=store.getIssue(entry.issue_id);return {...entry,status:issue?.status || 'missing',version:issue?.version || null,archived:Boolean(issue?.archived_at)};}),
      ...(task ? { task, work_context_text: buildWorkContextText({ project, task, planningItem, plan: value.plan, workspaces: workspace.workspaces,
        charter: link ? planning.getCharter(projectId, { revision: link.charter_revision }) : value.charter }) } : {}),
      skills: [...groups.managed, ...groups.external].map(({ id, name, slug, description, path, managed, scope, project_id }) => ({ id, name, slug, description, path, managed, scope, project_id })) };
  }
  function startSession(projectId, body) {
    if (Object.hasOwn(body,'history_id')) throw Error('native_history_read_only');
    // Compatibility entrypoint is now read-only: opening never manufactures a turn.
    const value = conversations.readContext({ project_id: projectId, kind: body.kind,...(body.conversation_id?{conversation_id:body.conversation_id}:{}) });
    if (body.kind === 'planning' && !value.planning_available) throw Error('confirmed_charter_required');
    return { ...value, session: value.binding, command: null };
  }
  function handleProjectEvent(method, params) {
    const work = conversations.handleWorkEvent(method, params);
    if (work) {
      if (!work.ignored && store.getIssueSession?.(work.issue_id)?.thread_id === params.threadId) worker.handleSessionEvent?.(method, params);
      if (work.changed) publishChange();
      return true;
    }
    const row = planning.getSessionByThread(params.threadId);
    if (!row) return false;
    const item = params.item;
    if (['item/started', 'item/completed'].includes(method) && item?.type === 'userMessage') {
      const message = Array.isArray(item.content) ? item.content.filter(entry => entry.type === 'text').map(entry => entry.text || '').join('\n') : String(item.text || '');
      if (item.id && message.trim()) {
        const evidence = planning.recordSessionEvent({ project_id: row.project_id, kind: row.kind, thread_id: row.thread_id, event_id: item.id, role: 'user', message, expected_revision: planning.getCharter(row.project_id)?.revision || 0 });
        const charter = planning.getCharter(row.project_id);
        if (method === 'item/completed' && evidence.is_confirmation && charter?.status === 'draft' && charter.revision === evidence.charter_revision) {
          planning.confirmCharter({ project_id: row.project_id, thread_id: row.thread_id,
            expected_revision: charter.revision, message_id: evidence.event_id });
          publishChange();
        }
      }
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
      store.db.prepare('UPDATE project_native_conversations SET status=?,last_error=?,updated_at=? WHERE thread_id=?').run(status,params.turn?.error?.message || null,new Date().toISOString(),row.thread_id);
      publishChange();
    }
    return true;
  }
  async function handle({ url, method, request, response, readBody, sendJson }) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const send = (value, status = 200) => { sendJson(response, status, value); return true; };
    if (parts[0] !== 'api') return false;
    if (parts[1] === 'native-conversations' && parts[2] === 'validate-input' && method === 'POST') {
      const body = await readBody(request);
      if (!store.nativeSessionProxyIsLeader(body.relay_id)) throw Error('session_relay_not_leader');
      const binding = conversations.trustedBinding(body.thread_id, body.host_id);
      assertSkillPaths(body.skill_paths || [], binding.project_id);
      return send({ valid: true });
    }
    if (await conversations.handle({ url, method, request, response, readBody, sendJson })) return true;
    if (parts[1] === 'skills') {
      if (parts[2] && ['PATCH', 'DELETE'].includes(method) && findSkill(parts[2])?.managed === false) throw Error('external_skill_read_only');
      if (parts.length === 2 && method === 'GET') return send(skillList(url.searchParams.has('project_id') ? url.searchParams.get('project_id') : undefined));
      if (parts.length === 3 && parts[2] === 'derive' && method === 'POST') {
        const body = await readBody(request);
        const skill = skills.derive(body);
        const exported = exportStatus = skills.exportOwned(); publishChange();
        const catalogRefreshed = await refreshNativeSkills(skill);
        return send({ skill: skills.get(skill.id), export_status: exported, catalog_refreshed: catalogRefreshed }, 201);
      }
      if (parts.length === 2 && method === 'POST' || parts.length === 3 && method === 'PATCH') {
        const body = await readBody(request);
        if (method === 'PATCH' && (!Number.isSafeInteger(body.version) || body.version < 1)) throw Error('invalid_version');
        const skill = skills.save({ ...body, ...(parts[2] ? { id: parts[2] } : {}) }, { expectedVersion: body.version });
        const exported = exportStatus = skills.exportOwned(); publishChange();
        const catalogRefreshed = await refreshNativeSkills(skill);
        return send({ skill: skills.get(skill.id), export_status: exported, catalog_refreshed: catalogRefreshed }, method === 'POST' ? 201 : 200);
      }
      if (parts.length === 3 && method === 'GET') {
        const skill = findSkill(parts[2]); if (!skill) throw Error('skill_not_found'); return send({ skill });
      }
      if (parts.length === 3 && method === 'DELETE') { const body = await readBody(request); if (!Number.isSafeInteger(body.version) || body.version < 1) throw Error('invalid_version'); const skill = findSkill(parts[2]); skills.delete(parts[2], { expectedVersion: body.version }); publishChange(); return send({ deleted: true, catalog_refreshed: await refreshNativeSkills(skill) }); }
      return send({ error: 'not_found' }, 404);
    }
    if (parts[1] === 'project-tools' && method === 'POST') {
      const body = await readBody(request);
      if (Object.hasOwn(body,'history_id')) throw Error('native_history_read_only');
      const name = parts[2];
      if (name === 'project_context_read') return send(context(body.project_id, body));
      return send(invokeTool(name, body));
    }
    if (parts[1] !== 'projects' || !parts[2]) return false;
    const projectId = parts[2];
    if (parts[3] === 'planning-context' && method === 'GET') return send(context(projectId));
    if (parts[3] === 'charter-confirm' && method === 'POST') {
      const body = await readBody(request);
      if (Object.hasOwn(body, 'history_id')) throw Error('native_history_read_only');
      const value = planning.confirmCharterFromUI({ project_id: projectId,
        expected_revision: body.expected_revision, thread_id: body.thread_id });
      publishChange(); return send(value);
    }
    if (parts[3] === 'native-session' && method === 'POST') {
      const body = await readBody(request);
      if (Object.hasOwn(body,'history_id')) throw Error('native_history_read_only');
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
      if (method === 'POST') { const body = await readBody(request); if (Object.hasOwn(body,'history_id')) throw Error('native_history_read_only'); const value = parts[4] === 'confirm' ? planning.confirmCharter({ ...body, project_id: projectId }) : planning.saveCharter({ ...body, project_id: projectId }); publishChange(); return send(value); }
    }
    if (parts[3] === 'plan') {
      if (method === 'GET') return send(planning.getPlan(projectId));
      if (method === 'POST') {
        const body = await readBody(request);
        if (Object.hasOwn(body,'history_id')) throw Error('native_history_read_only');
        const value = parts[4] === 'convert' ? convert({ ...body, project_id: projectId, thread_id: body.thread_id || planning.getSession(projectId, 'planning')?.thread_id }) : planning.savePlan({ ...body, project_id: projectId });
        publishChange(); return send(value);
      }
    }
    return false;
  }
  function convert(body) {
    planning.assertThread(body.project_id,'planning',body.thread_id);
    const plan = planning.getPlan(body.project_id);
    if (!plan || body.expected_revision !== plan.revision) throw Error('version_conflict');
    if (!Array.isArray(body.item_ids) || !body.item_ids.length || body.item_ids.some(id => !plan.items.some(item => item.id === id))) throw Error('invalid_item_ids');
    for (const item of plan.items.filter(item => body.item_ids.includes(item.id))) if (item.skill_id) assertSkill(item.skill_id, body.project_id);
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
      if (selected) { assertSkill(selected, body.project_id); setIssueSkill(result.issue_id, selected); }
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
  const activeTurns = () => store.db.prepare("SELECT activity.thread_id,activity.turn_id FROM project_native_activity AS activity WHERE activity.status='running' AND (EXISTS(SELECT 1 FROM project_native_sessions AS sessions WHERE sessions.thread_id=activity.thread_id AND sessions.status='running') OR EXISTS(SELECT 1 FROM project_native_conversations AS conversations WHERE conversations.thread_id=activity.thread_id AND conversations.status='running') OR EXISTS(SELECT 1 FROM issue_native_conversations AS work WHERE work.thread_id=activity.thread_id AND work.active_turn_id=activity.turn_id AND work.status='running'))").all();
  function invokeTool(name, body) {
    if (Object.hasOwn(body,'history_id')) throw Error('native_history_read_only');
    let value;
    if (name === 'project_context_read') return context(body.project_id, body);
    if (name === 'project_charter_save') value = planning.saveCharter(body);
    else if (name === 'project_charter_confirm') value = planning.confirmCharter(body);
    else if (name === 'project_plan_save') value = planning.savePlan(body);
    else if (name === 'project_plan_convert') value = convert(body);
    else throw Error('tool_not_found');
    publishChange(); return value;
  }
  const conversations = createNativeConversationRuntime({ store, planning, home, context, invokeTool,
    threadAction:async(threadIds,action,hostId)=>{
      if (hostId!=='local') throw Error('native_host_mismatch');
      if (!threadIds.every(id=>/^[a-f0-9-]{36}$/i.test(id))) throw Error('invalid_thread_id');
      if (typeof worker.sessionRelay?.threadAction!=='function') throw Error('native_archive_unavailable');
      return worker.sessionRelay.threadAction(threadIds,action);
    },onProjectEvent: handleProjectEvent, publishChange });
  return { planning, skills, conversations, context, handle, startSession, handleProjectEvent, commandReceipt, enrichIssue, setIssueSkill, findSkill, assertSkill, assertSkillPaths, refreshSkillExports, activeTurns };
}

function workPayload(store, issue, workspacePath, message, input) {
  const runtime = store.nativeProjectRuntime;
  const project = store.getProject(issue.project_id);
  const enriched = runtime?.enrichIssue(issue) || issue;
  const skill = enriched.skill_id && runtime?.assertSkill(enriched.skill_id, issue.project_id);
  const link = store.db.prepare('SELECT charter_revision,plan_revision,item_id FROM project_planning_issue_links WHERE issue_id=?').get(issue.id);
  const charter = link ? runtime?.planning.getCharter(issue.project_id, { revision: link.charter_revision }) : runtime?.planning.getCharter(issue.project_id);
  const workspace = getWorkspaceContext(project || { workspace_path: workspacePath }, { scan: false, workspaceMap: charter?.metadata?.workspace_map });
  const context = [`Better Codex 项目 ID：${issue.project_id}`, '本原生会话 ID：__BETTER_CODEX_THREAD_ID__',
    '关联目录：\n' + directoryBrief(workspace),
    ...(charter?.status === 'confirmed' ? [`项目总纲版本：${charter.revision}。按需使用 project_context_read 读取此版本的相关章节。${link ? `规划版本：${link.plan_revision}；规划项：${link.item_id}。` : ''}`] : [])].join('\n\n');
  const combined = context + '\n\n' + message;
  const original = input || [{ type: 'text', text: message }];
  return { native_defaults: true, dynamic_tools: nativeTools, root_paths: workspace.root_paths, workspace_path: workspacePath,
    title: `${issue.identifier} ${issue.title}`.trim().slice(0, 200), message: combined,
    input: [{ type: 'text', text: context + '\n\n' }, ...original, ...(skill?.path ? [{ type: 'skill', name: skill.slug || skill.name, path: skill.path }] : [])],
    config_fingerprint: JSON.stringify({ roots: workspace.root_paths, skill: skill?.id || '', version: skill?.version || 0, charter_revision: charter?.status === 'confirmed' ? charter.revision : 0 }) };
}
module.exports = { ensureNativeTables, createNativeProjectRuntime, workPayload };

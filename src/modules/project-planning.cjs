'use strict';

const { randomUUID, createHash } = require('node:crypto');

// This module only adds tables. The caller owns backups of existing project/issue
// tables before conversion, and retains responsibility for issue scheduling.
function createProjectPlanning({ db, getProject, createIssue, getIssue, listIssues, home, updateIssue }) {
  const now = () => new Date().toISOString();
  const fail = (code, details) => { const error = new Error(code); error.code = code; if (details) error.details = details; throw error; };
  const string = (value, field, required = false) => {
    if (value === undefined || value === null) { if (required) fail(`invalid_${field}`); return ''; }
    if (typeof value !== 'string' || value.includes('\0') || (required && !value.trim())) fail(`invalid_${field}`);
    return value.trim();
  };
  const id = (value, field) => {
    const cleaned = string(value, field, true);
    if (cleaned.length > 200 || !/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(cleaned)) fail(`invalid_${field}`);
    return cleaned;
  };
  const revision = (value) => {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_expected_revision');
    return value;
  };
  const checkRevision = (value, current) => { if (revision(value) !== (current || 0)) fail('version_conflict'); };
  const project = (projectId) => { const result = getProject(string(projectId, 'project_id', true)); if (!result) fail('project_not_found'); return result; };
  const kind = (value) => { if (!['charter', 'planning'].includes(value)) fail('invalid_session_kind'); return value; };
  const list = (value, field) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail(`invalid_${field}`);
    return value.map(entry => string(entry, field, true));
  };
  const readJson = (value) => JSON.parse(value);
  const latest = (table, projectId) => db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY revision DESC LIMIT 1`).get(projectId);

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_charter_revisions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','confirmed')),
        document_json TEXT NOT NULL, source_thread_id TEXT NOT NULL,
        confirmation_message_id TEXT, confirmation_message TEXT, confirmed_at TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(project_id,revision)
      );
      CREATE TABLE IF NOT EXISTS project_planning_revisions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, charter_revision INTEGER NOT NULL,
        plan_json TEXT NOT NULL, validation_json TEXT NOT NULL, source_thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(project_id,revision),
        FOREIGN KEY(project_id,charter_revision) REFERENCES project_charter_revisions(project_id,revision)
      );
      CREATE TABLE IF NOT EXISTS project_planning_issue_links (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL, issue_id TEXT NOT NULL REFERENCES issues(id),
        plan_revision INTEGER NOT NULL, charter_revision INTEGER NOT NULL,
        item_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id,item_id), UNIQUE(issue_id),
        FOREIGN KEY(project_id,plan_revision) REFERENCES project_planning_revisions(project_id,revision),
        FOREIGN KEY(project_id,charter_revision) REFERENCES project_charter_revisions(project_id,revision)
      );
      CREATE TABLE IF NOT EXISTS project_native_sessions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('charter','planning')), thread_id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL DEFAULT 'native' CHECK(owner='native'),
        status TEXT NOT NULL DEFAULT 'ready', last_error TEXT, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,kind)
      );
      CREATE TABLE IF NOT EXISTS project_native_commands (
        request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('charter','planning')), thread_id TEXT NOT NULL,
        command TEXT NOT NULL, payload_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','claimed','completed','failed','outcome_unknown')),
        revision INTEGER NOT NULL, result_json TEXT, last_error TEXT,
        relay_id TEXT, turn_id TEXT, claimed_at TEXT, checkpoint_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_native_commands_pending ON project_native_commands(status,created_at);
      CREATE TABLE IF NOT EXISTS project_native_session_events (
        event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('charter','planning')), thread_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), message_hash TEXT NOT NULL,
        charter_revision INTEGER NOT NULL, is_confirmation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_native_confirmation_events ON project_native_session_events(project_id,thread_id,charter_revision,is_confirmation);
    `);
  }

  function getSession(projectId, sessionKind) {
    project(projectId); kind(sessionKind);
    return db.prepare('SELECT * FROM project_native_sessions WHERE project_id=? AND kind=?').get(projectId, sessionKind) || null;
  }

  function assertThread(projectId, sessionKind, threadId) {
    const session = getSession(projectId, sessionKind);
    if (!session || session.thread_id !== string(threadId, 'thread_id', true)) fail('session_thread_mismatch');
    return session;
  }

  function bindSession(args) {
    project(args.project_id); kind(args.kind);
    const threadId = string(args.thread_id, 'thread_id', true);
    if (threadId.length > 200) fail('invalid_thread_id');
    const current = getSession(args.project_id, args.kind);
    checkRevision(args.expected_revision, current?.revision);
    if (current && current.thread_id !== threadId) fail('session_thread_mismatch');
    const elsewhere = db.prepare('SELECT project_id,kind FROM project_native_sessions WHERE thread_id=?').get(threadId);
    if (elsewhere && (elsewhere.project_id !== args.project_id || elsewhere.kind !== args.kind)) fail('session_thread_mismatch');
    const status = args.status === undefined ? (current?.status || 'ready') : string(args.status, 'session_status', true);
    if (!['ready','idle','running','failed','interrupted','closed'].includes(status)) fail('invalid_session_status');
    const timestamp = now();
    db.prepare(`INSERT INTO project_native_sessions(project_id,kind,thread_id,owner,status,last_error,revision,created_at,updated_at)
      VALUES(?,?,?,'native',?,?,1,?,?) ON CONFLICT(project_id,kind) DO UPDATE SET
      status=excluded.status,last_error=excluded.last_error,revision=project_native_sessions.revision+1,updated_at=excluded.updated_at`)
      .run(args.project_id, args.kind, threadId, status, args.last_error == null ? null : string(args.last_error, 'last_error'), timestamp, timestamp);
    return getSession(args.project_id, args.kind);
  }

  function charterFromRow(row, options = {}) {
    if (!row) return null;
    const document = readJson(row.document_json);
    let sections = document.sections;
    const sectionIds = options.section_ids || (options.section_id ? [options.section_id] : null);
    if (sectionIds) {
      const requested = list(sectionIds, 'section_ids');
      if (requested.some(sectionId => !sections.some(section => section.id === sectionId))) fail('charter_section_not_found');
      sections = sections.filter(section => requested.includes(section.id));
    }
    return {
      project_id: row.project_id, revision: row.revision, status: row.status,
      ...document, sections, source_thread_id: row.source_thread_id,
      confirmation_message_id: row.confirmation_message_id, confirmation_message: row.confirmation_message,
      confirmed_at: row.confirmed_at, created_at: row.created_at
    };
  }

  function getCharter(projectId, options = {}) {
    project(projectId);
    let row;
    if (options.revision !== undefined) {
      revision(options.revision);
      row = db.prepare('SELECT * FROM project_charter_revisions WHERE project_id=? AND revision=?').get(projectId, options.revision);
      if (!row) fail('charter_revision_not_found');
    } else if (options.confirmed) {
      row = db.prepare("SELECT * FROM project_charter_revisions WHERE project_id=? AND status='confirmed' ORDER BY revision DESC LIMIT 1").get(projectId);
    } else row = latest('project_charter_revisions', projectId);
    return charterFromRow(row, options);
  }

  function normalizeCharter(input) {
    if (!input || !Array.isArray(input.sections) || !input.sections.length) fail('invalid_charter_sections');
    const ids = new Set();
    const sections = input.sections.map(section => {
      const sectionId = id(section.id, 'section_id');
      if (ids.has(sectionId)) fail('duplicate_section_id');
      ids.add(sectionId);
      return { id: sectionId, title: string(section.title, 'section_title', true), content: string(section.content, 'section_content', true) };
    });
    const requirements = (input.requirements || []).map(requirement => {
      if (typeof requirement === 'string') return { id: id(requirement, 'requirement_id'), content: '' };
      return { id: id(requirement.id, 'requirement_id'), content: string(requirement.content || requirement.title, 'requirement_content') };
    });
    if (new Set(requirements.map(entry => entry.id)).size !== requirements.length) fail('duplicate_requirement_id');
    const metadata = input.metadata === undefined ? {} : input.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('invalid_charter_metadata');
    const facts = input.facts === undefined ? [] : input.facts;
    if (!Array.isArray(facts) && (!facts || typeof facts !== 'object')) fail('invalid_charter_facts');
    return { title: string(input.title || '项目总纲', 'charter_title', true), sections, requirements, metadata, facts };
  }

  function saveCharter(args) {
    assertThread(args.project_id, 'charter', args.thread_id);
    const current = latest('project_charter_revisions', args.project_id);
    checkRevision(args.expected_revision, current?.revision);
    const document = normalizeCharter(args.charter || args);
    const next = (current?.revision || 0) + 1;
    db.prepare(`INSERT INTO project_charter_revisions(project_id,revision,status,document_json,source_thread_id,created_at)
      VALUES(?,?,'draft',?,?,?)`).run(args.project_id, next, JSON.stringify(document), args.thread_id, now());
    return getCharter(args.project_id);
  }

  function confirmCharter(args) {
    assertThread(args.project_id, 'charter', args.thread_id);
    const current = latest('project_charter_revisions', args.project_id);
    checkRevision(args.expected_revision, current?.revision);
    if (!current) fail('charter_not_found');
    const messageId = string(args.confirmation_message_id || args.message_id, 'confirmation_message_id', true);
    const evidence = db.prepare(`SELECT * FROM project_native_session_events WHERE event_id=? AND project_id=?
      AND thread_id=? AND kind='charter' AND role='user' AND charter_revision=? AND is_confirmation=1`)
      .get(messageId, args.project_id, args.thread_id, current.revision);
    if (!evidence) fail('explicit_user_confirmation_required');
    if (args.confirmation_message !== undefined && createHash('sha256').update(string(args.confirmation_message, 'confirmation_message', true)).digest('hex') !== evidence.message_hash) fail('confirmation_message_mismatch');
    const timestamp = now();
    db.prepare(`INSERT INTO project_charter_revisions(project_id,revision,status,document_json,source_thread_id,
      confirmation_message_id,confirmation_message,confirmed_at,created_at) VALUES(?,?,'confirmed',?,?,?,?,?,?)`)
      .run(args.project_id, current.revision + 1, current.document_json, args.thread_id, messageId, null, timestamp, timestamp);
    return getCharter(args.project_id);
  }

  function normalizeItem(item, charterRevision) {
    if (!item || typeof item !== 'object') fail('invalid_plan_item');
    const itemId = id(item.id || item.stable_id, 'item_id');
    if (item.charter_revision !== undefined && item.charter_revision !== charterRevision) fail('item_charter_revision_mismatch');
    const textOrList = (value, field) => Array.isArray(value) ? list(value, field) : string(value, field);
    return {
      id: itemId, title: string(item.title, 'item_title', true), charter_revision: charterRevision,
      requirement_refs: list(item.requirement_refs || item.requirement_ids, 'requirement_refs'),
      goal: string(item.goal || item.objective, 'goal', true), scope: textOrList(item.scope, 'scope'),
      directories: list(item.directories || item.related_directories, 'directories'),
      deliverables: list(item.deliverables || item.artifacts, 'deliverables'),
      contract_refs: list(item.contract_refs || item.charter_section_ids, 'contract_refs'),
      contract_owner: string(item.contract_owner, 'contract_owner'),
      dependencies: list(item.dependencies, 'dependencies'), acceptance: textOrList(item.acceptance, 'acceptance'),
      manual_steps: list(item.manual_steps, 'manual_steps'), skill_id: string(item.skill_id, 'skill_id'),
      unresolved_questions: list(item.unresolved_questions || item.open_questions, 'unresolved_questions')
    };
  }

  function validate(projectId, input) {
    const charterRevision = input.charter_revision;
    if (!Number.isSafeInteger(charterRevision) || charterRevision < 1) fail('confirmed_charter_required');
    const charter = getCharter(projectId, { revision: charterRevision });
    if (charter.status !== 'confirmed') fail('confirmed_charter_required');
    if (!Array.isArray(input.items)) fail('invalid_plan_items');
    const items = input.items.map(item => normalizeItem(item, charterRevision));
    const ids = new Set(items.map(item => item.id));
    if (ids.size !== items.length) fail('duplicate_item_id');
    const sections = new Set(charter.sections.map(section => section.id));
    const requirements = new Set(charter.requirements.map(entry => entry.id));
    const errors = [], warnings = [], mapped = new Map();
    for (const item of items) {
      if (!item.scope.length) warnings.push({ code: 'missing_scope', item_id: item.id });
      if (!item.acceptance.length) warnings.push({ code: 'missing_acceptance', item_id: item.id });
      if (!item.deliverables.length) warnings.push({ code: 'missing_deliverables', item_id: item.id });
      if (!item.manual_steps.length) warnings.push({ code: 'missing_manual_steps', item_id: item.id });
      if (!item.directories.length) warnings.push({ code: 'missing_directories', item_id: item.id });
      if (!item.contract_refs.length) warnings.push({ code: 'missing_contract_refs', item_id: item.id });
      if (item.contract_refs.length && !item.contract_owner) warnings.push({ code: 'missing_contract_owner', item_id: item.id });
      if (requirements.size && !item.requirement_refs.length) warnings.push({ code: 'missing_requirement_refs', item_id: item.id });
      for (const dependency of item.dependencies) {
        if (!ids.has(dependency)) errors.push({ code: 'unknown_dependency', item_id: item.id, dependency });
        if (dependency === item.id) errors.push({ code: 'self_dependency', item_id: item.id });
      }
      for (const ref of item.contract_refs) if (!sections.has(ref)) errors.push({ code: 'unknown_contract_ref', item_id: item.id, section_id: ref });
      for (const ref of item.requirement_refs) {
        if (!requirements.has(ref)) errors.push({ code: 'unknown_requirement_ref', item_id: item.id, requirement_id: ref });
        const entries = mapped.get(ref) || []; entries.push(item.id); mapped.set(ref, entries);
      }
    }
    const visiting = new Set(), visited = new Set(), byId = new Map(items.map(item => [item.id, item]));
    const walk = (itemId, path) => {
      if (visiting.has(itemId)) { errors.push({ code: 'dependency_cycle', path: [...path, itemId] }); return; }
      if (visited.has(itemId)) return;
      visiting.add(itemId);
      for (const dependency of byId.get(itemId).dependencies) if (byId.has(dependency)) walk(dependency, [...path, itemId]);
      visiting.delete(itemId); visited.add(itemId);
    };
    for (const itemId of ids) walk(itemId, []);
    for (const requirementId of requirements) {
      const entries = mapped.get(requirementId) || [];
      if (!entries.length) warnings.push({ code: 'unmapped_requirement', requirement_id: requirementId });
      if (entries.length > 1) warnings.push({ code: 'duplicate_requirement_mapping', requirement_id: requirementId, item_ids: entries });
    }
    return { valid: !errors.length, errors, warnings, items, charter_revision: charterRevision };
  }

  function planFromRow(row) {
    if (!row) return null;
    return { project_id: row.project_id, revision: row.revision, ...readJson(row.plan_json),
      charter_revision: row.charter_revision, validation: readJson(row.validation_json),
      source_thread_id: row.source_thread_id, created_at: row.created_at,
      issue_links: db.prepare('SELECT item_id,issue_id,plan_revision,charter_revision FROM project_planning_issue_links WHERE project_id=?').all(row.project_id) };
  }

  function getPlan(projectId, options = {}) {
    project(projectId);
    if (options.revision !== undefined) {
      revision(options.revision);
      const row = db.prepare('SELECT * FROM project_planning_revisions WHERE project_id=? AND revision=?').get(projectId, options.revision);
      if (!row) fail('plan_revision_not_found');
      return planFromRow(row);
    }
    return planFromRow(latest('project_planning_revisions', projectId));
  }

  function savePlan(args) {
    assertThread(args.project_id, 'planning', args.thread_id);
    const current = latest('project_planning_revisions', args.project_id);
    checkRevision(args.expected_revision, current?.revision);
    const input = args.plan || args;
    const validated = validate(args.project_id, input);
    if (!validated.valid) fail('invalid_plan', validated);
    const { items, ...validation } = validated;
    const plan = { title: string(input.title || '项目任务规划', 'plan_title', true), items };
    db.prepare(`INSERT INTO project_planning_revisions(project_id,revision,charter_revision,plan_json,validation_json,source_thread_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(args.project_id, (current?.revision || 0) + 1, validated.charter_revision,
        JSON.stringify(plan), JSON.stringify(validation), args.thread_id, now());
    return getPlan(args.project_id);
  }

  function getContext(projectId, options = {}) {
    const currentProject = project(projectId);
    const charterSession = getSession(projectId, 'charter');
    const planningSession = getSession(projectId, 'planning');
    if (options.thread_id && options.thread_id !== charterSession?.thread_id && options.thread_id !== planningSession?.thread_id) fail('session_thread_mismatch');
    const plan = getPlan(projectId, options.plan_revision === undefined ? {} : { revision: options.plan_revision });
    const charterOptions = { section_ids: options.section_ids, section_id: options.section_id };
    if (options.charter_revision !== undefined) charterOptions.revision = options.charter_revision;
    else if (options.revision !== undefined) charterOptions.revision = options.revision;
    else if (options.plan_revision !== undefined && plan) charterOptions.revision = plan.charter_revision;
    return { project: { id: currentProject.id, name: currentProject.name, workspace_path: currentProject.workspace_path || '',
      root_paths: currentProject.root_paths || [], workspace_map: currentProject.workspace_map || currentProject.workspace_roots || {} },
      charter: getCharter(projectId, charterOptions), plan,
      confirmation_candidates: options.thread_id && options.thread_id !== charterSession?.thread_id ? [] : getConfirmationCandidates(projectId, charterSession?.thread_id),
      sessions: { charter: charterSession, planning: planningSession } };
  }

  function recordSessionEvent(args) {
    const sessionKind = kind(args.kind || args.session_kind);
    assertThread(args.project_id, sessionKind, args.thread_id);
    const charter = getCharter(args.project_id);
    checkRevision(args.expected_revision, charter?.revision);
    const eventId = string(args.event_id || args.id, 'event_id', true);
    const role = args.role;
    if (!['user','assistant'].includes(role)) fail('invalid_event_role');
    const message = string(args.message, 'event_message', true);
    const hash = createHash('sha256').update(message).digest('hex');
    const existing = db.prepare('SELECT * FROM project_native_session_events WHERE event_id=?').get(eventId);
    if (existing) {
      if (existing.project_id !== args.project_id || existing.thread_id !== args.thread_id || existing.kind !== sessionKind || existing.role !== role || existing.message_hash !== hash) fail('event_id_conflict');
      return { ...existing, replayed: true };
    }
    const negative = /(?:不(?:要|能|会|予|应|同意|确认)|暂不|拒绝|尚未|未确认|不要确认|\b(?:no|not|never|don't|do not)\b)/i.test(message);
    const explicit = /^(?:我(?:已|现在)?\s*)?(?:确认|同意|认可)(?:本|这份|该|当前|项目)?总纲(?:[，,。.!！\s]*(?:可以|请)?(?:开始|继续)(?:项目)?(?:规划|拆解任务))?[。.!！\s]*$|^(?:I\s+)?confirm\s+(?:the\s+)?(?:project\s+)?charter[.!\s]*$/i.test(message);
    const isConfirmation = role === 'user' && sessionKind === 'charter' && charter?.status === 'draft' && explicit && !negative;
    db.prepare(`INSERT INTO project_native_session_events(event_id,project_id,kind,thread_id,role,message_hash,charter_revision,is_confirmation,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(eventId, args.project_id, sessionKind, args.thread_id, role, hash, charter?.revision || 0, Number(isConfirmation), now());
    return { ...db.prepare('SELECT * FROM project_native_session_events WHERE event_id=?').get(eventId), replayed: false };
  }

  function getConfirmationCandidates(projectId, threadId) {
    project(projectId);
    if (!threadId) return [];
    assertThread(projectId, 'charter', threadId);
    const charter = getCharter(projectId);
    if (!charter || charter.status !== 'draft') return [];
    return db.prepare(`SELECT event_id,thread_id,role,charter_revision,created_at FROM project_native_session_events
      WHERE project_id=? AND thread_id=? AND charter_revision=? AND kind='charter' AND role='user' AND is_confirmation=1
      ORDER BY created_at,event_id`).all(projectId, threadId, charter.revision);
  }

  function issueDescription(currentProject, plan, item) {
    const charter = getCharter(currentProject.id, { revision: plan.charter_revision });
    const sections = item.contract_refs.length ? charter.sections.filter(section => item.contract_refs.includes(section.id)) : charter.sections;
    const format = value => Array.isArray(value) ? value.map(entry => `- ${entry}`).join('\n') : value || '未指定';
    return [
      `# ${item.title}`, `项目根目录：${currentProject.workspace_path || ''}`,
      `相关项目根目录：${format(currentProject.root_paths || [])}`,
      `总纲版本：${plan.charter_revision}；规划版本：${plan.revision}；规划项：${item.id}`,
      `## 目标\n${item.goal}`, `## 范围\n${format(item.scope)}`,
      `## 需求引用\n${format(item.requirement_refs)}`, `## 相关目录\n${format(item.directories)}`,
      `## 产物\n${format(item.deliverables)}`, `## 契约归属\n${item.contract_owner || '未指定'}`,
      `## 总纲契约\n${sections.map(section => `### ${section.title} (${section.id})\n${section.content}`).join('\n\n')}`,
      `## 依赖\n${format(item.dependencies)}`, `## 验收标准\n${format(item.acceptance)}`,
      `## 人工验收步骤\n${format(item.manual_steps)}`, `## 技能\n${item.skill_id || '未指定'}`,
      `## 未解决问题\n${format(item.unresolved_questions)}`
    ].join('\n\n');
  }

  function convertItems(args) {
    const currentProject = project(args.project_id);
    assertThread(args.project_id, 'planning', args.thread_id);
    const plan = getPlan(args.project_id);
    checkRevision(args.expected_revision, plan?.revision);
    if (!plan) fail('plan_not_found');
    if (args.plan_revision !== undefined && args.plan_revision !== plan.revision) fail('version_conflict');
    const action = args.action || 'create';
    if (!['create','update'].includes(action)) fail('invalid_conversion_action');
    const selected = list(args.item_ids, 'item_ids');
    if (!selected.length || new Set(selected).size !== selected.length) fail('invalid_item_ids');
    const items = selected.map(itemId => { const item = plan.items.find(entry => entry.id === itemId); if (!item) fail('plan_item_not_found'); return item; });
    const links = items.map(item => db.prepare('SELECT * FROM project_planning_issue_links WHERE project_id=? AND item_id=?').get(args.project_id, item.id));
    // Preflight all selected updates before making any changes.
    if (action === 'update') {
      if (typeof updateIssue !== 'function') fail('update_issue_unavailable');
      for (let index = 0; index < items.length; index++) {
        if (!links[index]) fail('item_not_converted');
        const issue = getIssue(links[index].issue_id);
        if (!issue || issue.project_id !== args.project_id) fail('issue_not_found');
        const expectedIssue = args.issue_versions?.[items[index].id];
        if (!Number.isSafeInteger(expectedIssue) || expectedIssue !== issue.version) fail('version_conflict');
        if (issue.run_thread_id || issue.active_run_status) fail('issue_execution_locked');
      }
    }
    const converted = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index], link = links[index];
      let issue;
      if (link && action === 'create') {
        issue = getIssue(link.issue_id);
        if (!issue || issue.project_id !== args.project_id) fail('issue_not_found');
        converted.push({ item_id: item.id, issue_id: issue.id, issue, replayed: true });
        continue;
      }
      const description = issueDescription(currentProject, plan, item);
      if (action === 'update') issue = updateIssue(link.issue_id, args.issue_versions[item.id], { title: item.title, description });
      else {
        // Stable issue IDs allow recovery if creation succeeds before link insertion.
        const issueId = `plan-${createHash('sha256').update(JSON.stringify([args.project_id, item.id])).digest('hex').slice(0, 40)}`;
        issue = getIssue(issueId);
        if (issue && issue.project_id !== args.project_id) fail('issue_project_mismatch');
        if (!issue) issue = createIssue({ id: issueId, projectId: args.project_id, title: item.title, description,
          status: 'backlog', agentEnabled: true, userAssigned: true, workspacePath: currentProject.workspace_path || undefined });
      }
      if (!issue || !issue.id) fail('issue_creation_failed');
      const timestamp = now();
      db.prepare(`INSERT INTO project_planning_issue_links(project_id,item_id,issue_id,plan_revision,charter_revision,item_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,item_id) DO UPDATE SET
        plan_revision=excluded.plan_revision,charter_revision=excluded.charter_revision,item_json=excluded.item_json,updated_at=excluded.updated_at`)
        .run(args.project_id, item.id, issue.id, plan.revision, plan.charter_revision, JSON.stringify(item), timestamp, timestamp);
      converted.push({ item_id: item.id, issue_id: issue.id, issue, replayed: false });
    }
    return { project_id: args.project_id, revision: plan.revision, action, items: converted };
  }

  function commandFromRow(row) {
    if (!row) return null;
    const { payload_json, result_json, fingerprint, ...result } = row;
    return { ...result, id: result.request_id, session_kind: result.kind, kind: result.command,
      scope: 'project', payload: readJson(payload_json), result: result_json === null ? null : readJson(result_json) };
  }

  function getCommand(requestId) { return commandFromRow(db.prepare('SELECT * FROM project_native_commands WHERE request_id=?').get(string(requestId, 'request_id', true))); }

  function enqueueCommand(args) {
    project(args.project_id);
    const sessionKind = kind(args.session_kind || args.kind);
    const session = getSession(args.project_id, sessionKind);
    const command = string(args.command || (args.session_kind ? args.kind : ''), 'command', true);
    if (!['start','turn','interrupt'].includes(command)) fail('invalid_command');
    const threadId = args.thread_id ? string(args.thread_id, 'thread_id', true) : session?.thread_id || '';
    if (session && threadId !== session.thread_id) fail('session_thread_mismatch');
    if (!session && command !== 'start') fail('session_not_found');
    const requestId = string(args.request_id, 'request_id', true);
    if (requestId.length > 200) fail('invalid_request_id');
    const payload = args.payload || {};
    const fingerprint = createHash('sha256').update(JSON.stringify({ project_id: args.project_id, kind: sessionKind, command, payload })).digest('hex');
    const existing = db.prepare('SELECT * FROM project_native_commands WHERE request_id=?').get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('request_id_conflict');
      revision(args.expected_revision);
      return { ...commandFromRow(existing), replayed: true };
    }
    checkRevision(args.expected_revision, session?.revision);
    if (command === 'start' && db.prepare(`SELECT 1 FROM project_native_commands WHERE project_id=? AND kind=?
      AND command='start' AND status IN ('pending','claimed','outcome_unknown') LIMIT 1`).get(args.project_id, sessionKind)) fail('native_start_already_pending');
    const timestamp = now();
    db.prepare(`INSERT INTO project_native_commands(request_id,project_id,kind,thread_id,command,payload_json,fingerprint,status,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'pending',1,?,?)`).run(requestId, args.project_id, sessionKind, threadId, command, JSON.stringify(payload), fingerprint, timestamp, timestamp);
    return { ...getCommand(requestId), replayed: false };
  }

  function listPendingCommands() {
    return db.prepare("SELECT * FROM project_native_commands WHERE status='pending' ORDER BY created_at,request_id").all().map(commandFromRow);
  }

  function finishCommand(args) {
    const requestId = args.request_id || args.id;
    const command = getCommand(requestId);
    if (!command) fail('command_not_found');
    if (args.project_id && args.project_id !== command.project_id) fail('command_project_mismatch');
    if ((args.session_kind || args.kind) && (args.session_kind || args.kind) !== command.session_kind) fail('command_project_mismatch');
    checkRevision(args.expected_revision, command.revision);
    const status = args.status || (args.error ? 'failed' : 'completed');
    if (!['completed','failed'].includes(status)) fail('invalid_command_status');
    if (!['pending','claimed'].includes(command.status)) fail('command_already_finished');
    if (command.status === 'claimed' && args.relay_id !== command.relay_id) fail('command_relay_mismatch');
    const session = getSession(command.project_id, command.session_kind);
    if (session) {
      assertThread(command.project_id, command.session_kind, args.thread_id);
      if (args.thread_id !== command.thread_id) fail('session_thread_mismatch');
    } else if (command.kind !== 'start' || status !== 'failed' || command.status !== 'claimed' || args.thread_id) fail('session_not_found');
    const error = status === 'failed' ? string(args.error || args.last_error, 'last_error', true) : null;
    db.prepare('UPDATE project_native_commands SET status=?,result_json=?,last_error=?,revision=revision+1,updated_at=? WHERE request_id=?')
      .run(status, JSON.stringify(args.result ?? null), error, now(), requestId);
    return getCommand(requestId);
  }

  function claimCommand(relayId) {
    const relay = string(relayId, 'relay_id', true);
    // SQLite's update and selection share one statement; no second relay can
    // observe this command as pending after ownership has been assigned.
    const row = db.prepare(`UPDATE project_native_commands SET status='claimed',relay_id=?,claimed_at=?,
      revision=revision+1,updated_at=? WHERE request_id=(SELECT request_id FROM project_native_commands
      WHERE status='pending' ORDER BY created_at,request_id LIMIT 1) AND status='pending' RETURNING *`).get(relay, now(), now());
    return commandFromRow(row);
  }

  function checkpointCommand(args) {
    const requestId = args.id || args.request_id;
    const command = getCommand(requestId);
    if (!command) fail('command_not_found');
    if (command.status !== 'claimed' || command.relay_id !== string(args.relay_id, 'relay_id', true)) fail('command_relay_mismatch');
    if (args.project_id && args.project_id !== command.project_id) fail('command_project_mismatch');
    const threadId = string(args.thread_id, 'thread_id', true);
    if (command.thread_id && command.thread_id !== threadId) fail('session_thread_mismatch');
    const currentSession = getSession(command.project_id, command.session_kind);
    if (currentSession && currentSession.thread_id !== threadId) fail('session_thread_mismatch');
    const turnId = args.turn_id == null ? command.turn_id : string(args.turn_id, 'turn_id', true);
    if (command.turn_id && turnId !== command.turn_id) fail('command_turn_mismatch');
    if (!currentSession) {
      if (command.kind !== 'start') fail('session_not_found');
      bindSession({ project_id: command.project_id, kind: command.session_kind, thread_id: threadId,
        expected_revision: 0, status: 'ready' });
    }
    db.prepare('UPDATE project_native_commands SET thread_id=?,turn_id=?,checkpoint_at=?,revision=revision+1,updated_at=? WHERE request_id=?')
      .run(threadId, turnId || null, now(), now(), requestId);
    return getCommand(requestId);
  }

  function recoverCommands(relayId) {
    const relay = string(relayId, 'relay_id', true);
    const commands = db.prepare("SELECT * FROM project_native_commands WHERE status='claimed' AND relay_id=? ORDER BY created_at,request_id").all(relay);
    for (const command of commands) {
      // Never replay a checkpointed native operation: its outcome may already
      // be visible in the native conversation. Empty claims are safe to retry.
      const status = command.checkpoint_at || command.turn_id ? 'outcome_unknown' : 'pending';
      db.prepare(`UPDATE project_native_commands SET status=?,relay_id=NULL,claimed_at=NULL,
        last_error=?,revision=revision+1,updated_at=? WHERE request_id=?`)
        .run(status, status === 'outcome_unknown' ? 'native_command_outcome_unknown' : null, now(), command.request_id);
    }
    return commands.map(command => getCommand(command.request_id));
  }

  return { migrate, getContext, getCharter, saveCharter, confirmCharter, getPlan, savePlan, validate, convertItems,
    getSession, bindSession, recordSessionEvent, getConfirmationCandidates, enqueueCommand, getCommand, listPendingCommands, finishCommand,
    claimCommand, checkpointCommand, recoverCommands };
}

module.exports = { createProjectPlanning };

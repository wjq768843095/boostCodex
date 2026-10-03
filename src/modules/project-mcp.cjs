'use strict';
const fs = require('node:fs');
const path = require('node:path');
const properties = {
  project_id: { type: 'string', description: 'Better Codex project ID.' },
  thread_id: { type: 'string', description: 'The bound native conversation ID supplied in its opening message.' },
  expected_revision: { type: 'integer', minimum: 0 },
  revision: { type: 'integer', minimum: 1 },
  section_ids: { type: 'array', items: { type: 'string' } },
  title: { type: 'string' },
  sections: { type: 'array', items: { type: 'object', required: ['id', 'title', 'content'], properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false } },
  requirements: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  metadata: { type: 'object', properties: { workspace_map: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' }, source_of_truth: { type: 'string' } }, required: ['path'], additionalProperties: false } } }, additionalProperties: true },
  facts: { type: 'array', items: { type: 'object', additionalProperties: true } },
  message_id: { type: 'string', description: 'A real native user confirmation candidate returned by project_context_read.' },
  charter_revision: { type: 'integer', minimum: 1 },
  plan_revision: { type: 'integer', minimum: 1 },
  summary: { type: 'string' },
  items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, scope: { type: 'string' }, detail: { type: 'string' },
    requirement_refs: { type: 'array', items: { type: 'string' } }, contract_refs: { type: 'array', items: { type: 'string' } },
    directories: { type: 'array', items: { type: 'string' } }, deliverables: { type: 'array', items: { type: 'string' } },
    contract_owner: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } },
    manual_steps: { type: 'array', items: { type: 'string' } }, unresolved_questions: { type: 'array', items: { type: 'string' } }, skill_id: { type: 'string' }
  }, required: ['id', 'title', 'goal'], additionalProperties: false } },
  item_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
  action: { type: 'string', enum: ['create', 'update'] },
  issue_versions: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } }
};
const definitions = [
  ['project_context_read', 'Read the project workspaces, technology evidence, charter chapters, saved plan, and real user confirmation candidates.', ['project_id'], ['thread_id', 'revision', 'charter_revision', 'plan_revision', 'section_ids'], true],
  ['project_charter_save', 'Save a draft of the single project charter from its bound native conversation, preserving directory responsibilities in metadata.workspace_map and version evidence in facts. Does not modify project source files.', ['project_id', 'thread_id', 'expected_revision', 'sections'], ['title', 'requirements', 'metadata', 'facts'], false],
  ['project_charter_confirm', 'Confirm the current draft using a real user confirmation message observed in the bound native conversation.', ['project_id', 'thread_id', 'expected_revision', 'message_id'], [], false],
  ['project_plan_save', 'Save business-complete planning items based on a confirmed charter, including dependencies and acceptance paths. Does not execute tasks.', ['project_id', 'thread_id', 'expected_revision', 'charter_revision', 'items'], ['summary'], false],
  ['project_plan_convert', 'Convert only explicitly selected planning items to backlog work tasks. Does not start tasks; repeated conversion is idempotent. Updating an existing task requires its current issue_versions entry.', ['project_id', 'thread_id', 'expected_revision', 'item_ids'], ['action', 'issue_versions'], false]
];
const tools = definitions.map(([name, description, required, optional, readOnlyHint]) => ({
  name, description, inputSchema: { type: 'object', required, properties: Object.fromEntries([...required, ...optional].map(key => [key, properties[key]])), additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false }
}));
async function call(name, args, options = {}) {
  const definition = tools.find(tool => tool.name === name);
  if (!definition) throw new Error('tool_not_found');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_arguments');
  for (const key of definition.inputSchema.required) if (!(key in args)) throw new Error('missing_' + key);
  for (const key of Object.keys(args)) if (!(key in definition.inputSchema.properties)) throw new Error('invalid_argument_' + key);
  const home = options.home || process.env.BETTER_CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.better-codex');
  const runtime = JSON.parse(fs.readFileSync(path.join(home, 'run/runtime.json'), 'utf8'));
  const token = fs.readFileSync(path.join(home, 'run/token'), 'utf8').trim();
  const response = await (options.fetch || fetch)('http://127.0.0.1:' + runtime.port + '/api/project-tools/' + name, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'project_tool_failed');
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
module.exports = { tools, call };

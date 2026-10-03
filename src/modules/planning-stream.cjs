const PREFIX = 'bc-planning-live-';
function textContent(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text || '').join('\n') : '';
}
function publicText(text) {
  return String(text || '').replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[已隐藏]').replace(/(Bearer\s+)[\w.\-]+/gi,'$1[已隐藏]').replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|token|password|passwd|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]').replace(/(--(?:api-key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,'$1[已隐藏]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已隐藏]@').slice(0, 16000);
}
function normalize(event) {
  const stamp = event.timestamp || new Date().toISOString();
  let type = event.type;
  let item = event.item;
  if (type === 'event_msg') {
    type = event.payload?.type;
    item = event.payload?.item;
  }
  if (type === 'task_started' || type === 'turn.started' || type === 'thread.started') return {id:'started',kind:'status',text:'正在分析项目',status:'running',at:stamp};
  if (type === 'turn.failed' || type === 'error') return {id:'failed',kind:'status',text:'本次规划未能完成',status:'failed',at:stamp};
  if (type === 'turn.completed' || type === 'task_complete') return {id:'finished',kind:'status',text:'本轮规划已完成',status:'completed',at:stamp};
  if (!item || !['item.started','item.updated','item.completed','item_completed','item_started'].includes(type)) return null;
  const kind = item.type;
  if (kind === 'agent_message' || kind === 'AgentMessage') {
    if (item.phase === 'analysis') return null;
    const text = textContent(item.text || item.content);
    if (!text) return null;
    try { const json=JSON.parse(text); if (json.plan && json.reply) return {id:item.id,kind:'status',text:'计划已生成，正在整理结果',status:'completed',at:stamp}; } catch {}
    return {id:item.id,kind:'message',text:publicText(text),status:'completed',at:stamp};
  }
  const status = item.status === 'failed' || item.error || (item.exit_code != null && item.exit_code !== 0) ? 'failed' : /completed/.test(type) ? 'completed' : 'running';
  const durationMs = event.payload?.completed_at_ms != null && event.payload?.started_at_ms != null ? Math.max(0,event.payload.completed_at_ms-event.payload.started_at_ms) : item.duration_ms ?? (item.duration?.secs != null ? item.duration.secs*1000+(item.duration.nanos||0)/1000000 : undefined);
  if (kind === 'command_execution' || kind === 'CommandExecution') return {id:item.id,kind:'command',text:'执行命令',command:publicText(Array.isArray(item.command)?item.command.join(' '):item.command || ''),exitCode:item.exit_code,durationMs,status,at:stamp};
  if (kind === 'mcp_tool_call' || kind === 'McpToolCall') return {id:item.id,kind:'tool',text:'使用工具',tool:publicText([item.server,item.tool || item.name].filter(Boolean).join(' / ')),durationMs,status,at:stamp};
  if (kind === 'SubAgentActivity' || kind === 'collab_tool_call') {
    const agents = item.agents_states || {};
    const names = Object.values(agents).map(a=>a.agent_nickname || a.agent_name || a.nickname).filter(Boolean);
    const name = item.agent_nickname || item.agent_name || item.agent_path?.split('/').pop() || names.join('、');
    return {id:item.id,kind:'agent',text:'子智能体',agent:publicText(name || '子智能体'),action:publicText(item.tool || item.kind || ''),status:item.kind === 'started' ? 'running' : status,durationMs,at:stamp};
  }
  return null;
}
function createRecorder(db, projectId, onChange = () => {}) {
  const message = db.prepare("SELECT id,created_at FROM project_planning_messages WHERE project_id=? AND role='user' ORDER BY created_at DESC LIMIT 1").get(projectId);
  if (!message) return {ingest:()=>false};
  const id = PREFIX + message.id;
  const existing = db.prepare('SELECT markdown FROM project_planning_messages WHERE id=?').get(id);
  let events = [];
  try {events=JSON.parse(existing?.markdown || '{}').events || [];} catch {}
  const upsert = db.prepare("INSERT INTO project_planning_messages (id,project_id,role,markdown,html,created_at) VALUES (?,?,'agent',?,'',?) ON CONFLICT(id) DO UPDATE SET markdown=excluded.markdown,created_at=excluded.created_at");
  return {ingest(event) {
    const threadId=event.type==='thread.started' ? event.thread_id : event.type==='session_meta' ? event.payload?.id : null;
    if (threadId) db.prepare("UPDATE project_planning_sessions SET thread_id=? WHERE project_id=? AND status='running'").run(threadId,projectId);
    const next=normalize(event);
    if (!next) return false;
    if (next.id==='finished' || next.id==='failed') events=events.map(e=>e.status==='running'?{...e,status:next.status}:e);
    next.id ||= String(events.length);
    const index=events.findIndex(e=>e.id===next.id);
    if(index>=0 && Object.keys(next).every(key=>key==='at' || next[key]===undefined || events[index][key]===next[key])) return false;
    for(const key of Object.keys(next)) if(next[key]===undefined || next[key]==='') delete next[key];
    if(index>=0) events[index]={...events[index],...next,at:events[index].at}; else events.push(next);
    events=events.slice(-100);
    // Keep one progress row per turn; tool output and private reasoning are never persisted here.
    const snapshot=JSON.stringify({version:1,events,updated_at:event.timestamp || new Date().toISOString()});
    if(db.prepare('SELECT status FROM project_planning_sessions WHERE project_id=?').get(projectId)?.status!=='running') return false;
    upsert.run(id,projectId,snapshot,new Date(Date.parse(message.created_at)+1).toISOString());
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(new Date().toISOString(),projectId);
    onChange();
    return true;
  }};
}
module.exports={PREFIX,normalize,createRecorder};

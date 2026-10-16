'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const titles = new Map();
function rememberTitle(threadId, agentId, title) {
  const key = `${threadId}:${agentId}`; titles.delete(key); titles.set(key, title);
  if (titles.size > 512) titles.delete(titles.keys().next().value);
  return title;
}
function getTitle(threadId, agentId, name) { return titles.get(`${threadId}:${agentId}`) || shortTitle('', name); }
// Native task transport can be encrypted. Never interpret those bytes as prose
// or try to decrypt them. Optional local descriptions bind to one exact assignment.
function encrypted(value) { return typeof value === 'string' && /^gAAAA[A-Za-z0-9_-]{60,}={0,2}$/.test(value.trim()); }
function fingerprint(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shortTitle(task, name = '') {
  const readableName = name.replace(/[_/\-]+/g, ' ');
  const text = readableName + '\n' + task;
  if (/subagent[_/ -]*(?:work|detail)|work_reader/i.test(name)) return '读取工作内容';
  if (/subagent.*ui.*test/i.test(name)) return '验证子代理界面';
  if (/subagent[_/ -]*reader/i.test(name)) return '读取子代理记录';
  const range = /(?:detail|tasks?)[_ -]*(\d{1,2})[_ -]+(\d{1,2})/i.exec(name);
  if (range) {
    const number = value => { const n = Number(value), digits = '零一二三四五六七八九'; return n < 10 ? digits[n] : (n < 20 ? '' : digits[Math.floor(n / 10)]) + '十' + (n % 10 ? digits[n % 10] : ''); };
    const title = (/review|audit/i.test(name) ? '审查' : '细化') + number(range[1]) + '至' + number(range[2]) + '项任务';
    if (title.length <= 10) return title;
  }
  if (/requirements?/i.test(readableName)) return '梳理需求';
  if (/dependenc/i.test(readableName)) return '核查任务依赖';
  if (/identity.*version|version.*identity/i.test(readableName)) return '核对身份版本';
  if (/acceptance/i.test(readableName)) return '核对验收要求';
  if (/framework/i.test(readableName)) return '核查框架';
  if (/model.*contract|contract.*model/i.test(readableName)) return '核对模型约定';
  if (/execution.*design|design.*execution/i.test(readableName)) return '设计执行方案';
  if (/scope|boundar/i.test(readableName)) return '核对任务范围';
  if (/权限|permission|authori[sz]/i.test(text)) return '核对权限';
  if (/界面|页面|\bui\b|frontend|layout/i.test(text)) return '检查界面';
  if (/接口|\bapi\b|endpoint/i.test(text)) return '检查接口';
  if (/测试|验证|\btest|validation/i.test(text)) return '验证功能';
  if (/审查|审核|review|audit/i.test(text)) return '审查代码';
  if (/修复|fix|repair/i.test(text)) return '修复问题';
  if (/开发|实现|implement|develop/i.test(text)) return '实现功能';
  if (/调查|分析|research|analysis|explor/i.test(text)) return '分析任务';
  return '子代理任务';
}
async function describe({ threadId, agentId, task, name, plainTask = '', home }) {
  const encoded = encrypted(task);
  if (!encoded) return { task, title: rememberTitle(threadId, agentId, shortTitle(task, name)), taskUnavailable: false };
  let saved;
  try {
    const base = home || process.env.BOOST_CODEX_HOME || process.env.BETTER_CODEX_HOME || path.join(os.homedir(), '.better-codex');
    const file = path.join(base, 'subagent-task-descriptions.json');
    if ((await fs.stat(file)).size <= 256 * 1024) saved = JSON.parse(await fs.readFile(file, 'utf8'))[`${threadId}:${agentId}`];
  } catch { /* A missing description is unavailable, never ciphertext. */ }
  const matched = saved && saved.assignmentHash === fingerprint(task) && typeof saved.task === 'string' && !encrypted(saved.task);
  const readable = matched ? saved.task : typeof plainTask === 'string' && !encrypted(plainTask) ? plainTask : '';
  const title = matched && typeof saved.title === 'string' && /^[\u3400-\u9fff]{2,10}$/.test(saved.title) ? saved.title : shortTitle(readable, name);
  return { task: readable, title: rememberTitle(threadId, agentId, title), taskUnavailable: !readable };
}
module.exports = { describe, encrypted, fingerprint, shortTitle, getTitle };

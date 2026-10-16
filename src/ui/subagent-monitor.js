"use strict";
(function (root) {
  const statuses = { starting: '启动中', running: '进行中', completed: '已完成', interrupted: '已中断', failed: '失败', closed: '已关闭', unknown: '未知' };
  const efforts = { none: '无', minimal: '极低', low: '轻度', medium: '中等', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra' };
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  function currentThread() {
    // Desktop navigation uses an in-memory router; location can remain index.html.
    for (const editor of document.querySelectorAll('[data-codex-composer]')) {
      if (!editor.getClientRects().length || editor.closest('[inert]')) continue;
      const inspected = new Set();
      for (let node = editor; node; node = node.parentElement) {
        let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber$'))], top = fiber;
        while (top?.return) top = top.return;
        if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber?.alternate;
        for (; fiber && !inspected.has(fiber); fiber = fiber.return) {
          inspected.add(fiber);
          const id = fiber.memoizedProps?.conversationId;
          if (typeof id === 'string') return uuid.test(id) ? id : null;
        }
      }
    }
    try {
      const url = new URL(root.location.href);
      const route = new URL(url.searchParams.get('initialRoute') || url.pathname, 'https://codex.local');
      const match = /^\/(?:local|threads)\/([^/]+)\/?$/.exec(route.pathname);
      return match && uuid.test(match[1]) ? match[1] : null;
    } catch { return null; }
  }
  function duration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return (hours ? hours + '小时' : '') + (minutes || hours ? minutes + '分' : '') + seconds % 60 + '秒';
  }
  function create({ api, getThreadId = currentThread, now = () => Date.now() }) {
    root.__betterCodexSubagentMonitor__?.destroy();
    let disposed = false, threadId = null, generation = 0, pending = null, lastPoll = 0, data = [], syncing = false, receivedAt = 0, observedAt = 0;
    const rows = new Map(), memory = new Map();
    const panel = document.createElement('section'); panel.className = 'bc-subagent-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '当前会话子代理'); panel.setAttribute('data-better-codex-owned', 'true');
    const header = document.createElement('div'); header.className = 'bc-subagent-header';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'bc-subagent-toggle';
    const notice = document.createElement('span'); notice.className = 'bc-subagent-notice'; notice.setAttribute('role', 'status');
    const list = document.createElement('div'); list.className = 'bc-subagent-list'; list.id = 'bc-subagent-list'; toggle.setAttribute('aria-controls', list.id);
    header.append(toggle, notice); panel.append(header, list);
    const style = document.createElement('style');
    style.textContent = `
      .bc-subagent-panel{position:fixed;z-index:30;width:330px;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:12px;background:var(--bc-subagent-bg,#fff);color:var(--bc-subagent-fg,#252525);box-shadow:0 6px 24px #0002;font:12px/1.5 system-ui,sans-serif;overflow:hidden;isolation:isolate}
      .bc-subagent-panel[hidden],.bc-subagent-list[hidden]{display:none!important}
      .bc-subagent-header{display:flex;align-items:center;padding:10px 12px;gap:8px}
      .bc-subagent-toggle{flex:1;min-width:0;text-align:left;background:none;border:0;padding:0;color:inherit;font:inherit;font-weight:600;cursor:pointer;-webkit-app-region:no-drag}
      .bc-subagent-toggle:focus-visible{outline:2px solid #5689e9;outline-offset:3px;border-radius:3px}
      .bc-subagent-notice{font-size:11px;color:#888;white-space:nowrap}
      .bc-subagent-list{overflow:auto;max-height:var(--bc-subagent-list-height,320px);overscroll-behavior:contain;padding:0 8px 8px}
      .bc-subagent-row{border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);padding:9px 4px 9px calc(4px + var(--bc-subagent-depth,0)*10px)}
      .bc-subagent-line{display:flex;align-items:center;gap:8px;min-width:0}
      .bc-subagent-name{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bc-subagent-state{font-size:11px;white-space:nowrap;color:#777}
      .bc-subagent-state[data-state=running],.bc-subagent-state[data-state=starting]{color:#3677d4}
      .bc-subagent-state[data-state=completed]{color:#32835b}
      .bc-subagent-state[data-state=failed],.bc-subagent-state[data-state=interrupted]{color:#bd6542}
      .bc-subagent-meta{display:block;color:color-mix(in srgb,currentColor 62%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;margin-top:3px}
      .bc-subagent-footer{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:color-mix(in srgb,currentColor 62%,transparent);margin-top:3px}
      .bc-subagent-footer>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-subagent-footer>span:last-child{flex-shrink:0}
      @media(prefers-color-scheme:dark){.bc-subagent-panel{--bc-subagent-bg:#252526;--bc-subagent-fg:#e8e8e8}}
      [data-theme=dark] .bc-subagent-panel,.dark .bc-subagent-panel{--bc-subagent-bg:#252526;--bc-subagent-fg:#e8e8e8}
      [data-theme=light] .bc-subagent-panel,.light .bc-subagent-panel{--bc-subagent-bg:#fff;--bc-subagent-fg:#252525}
    `;
    document.head.append(style); document.body.append(panel);
    function collapsed() {
      if (!memory.has(threadId)) {
        let value = false; try { value = root.localStorage.getItem('bc-subagents-collapsed:' + threadId) === 'true'; } catch {}
        memory.set(threadId, value);
      }
      return memory.get(threadId);
    }
    function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
    function attr(node, key, value) { if (node.getAttribute(key) !== String(value)) node.setAttribute(key, String(value)); }
    function position() {
      const editor = [...document.querySelectorAll('[data-codex-composer]')].find(node => node.getClientRects().length && !node.closest('[inert]'));
      const frame = editor?.closest('[data-app-shell-thread-edge-divider]') || [...document.querySelectorAll('.app-shell-main-content-frame'), ...document.querySelectorAll('[data-app-shell-main-content-layout]')].find(node => node.getClientRects().length);
      if (!frame || !frame.getClientRects().length) { panel.hidden = true; return; }
      const rect = frame.getBoundingClientRect();
      const top = Math.max(8, rect.top + 54), left = Math.max(8, rect.left + 12);
      const composer = editor?.closest('[data-composer-surface-variant]') || editor;
      const bottom = composer?.getClientRects().length ? composer.getBoundingClientRect().top - 12 : root.innerHeight - 16;
      const height = Math.min(380, bottom - top);
      if (height < 50 || rect.width < 120) { panel.hidden = true; return; }
      const css = `left:${left}px;top:${top}px;width:${Math.min(330, rect.width - 24)}px;--bc-subagent-list-height:${Math.max(0, height - 42)}px`;
      if (panel.style.cssText !== css) panel.style.cssText = css;
      panel.hidden = !data.length;
    }
    function render() {
      if (disposed) return;
      if (document.hidden || !threadId || getThreadId() !== threadId || !data.length) { panel.hidden = true; return; }
      const folded = collapsed(), active = data.filter(a => a.status === 'running' || a.status === 'starting').length;
      setText(toggle, '子代理 · 进行中 ' + active + ' · 已完成 ' + data.filter(a => a.status === 'completed').length + (folded ? '　展开' : '　收起'));
      attr(toggle, 'aria-expanded', !folded); list.hidden = folded; setText(notice, syncing ? '同步中' : '');
      const ordered = [...data].sort((a, b) => Number(['running', 'starting'].includes(b.status)) - Number(['running', 'starting'].includes(a.status)) || (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id));
      const ids = new Set();
      for (let index = 0; index < ordered.length; index++) {
        const agent = ordered[index]; ids.add(agent.id);
        let row = rows.get(agent.id);
        if (!row) {
          const node = document.createElement('article'); node.className = 'bc-subagent-row';
          const line = document.createElement('div'); line.className = 'bc-subagent-line';
          const name = document.createElement('span'); name.className = 'bc-subagent-name';
          const state = document.createElement('span'); state.className = 'bc-subagent-state';
          const meta = document.createElement('span'); meta.className = 'bc-subagent-meta';
          const footer = document.createElement('div'); footer.className = 'bc-subagent-footer';
          const nickname = document.createElement('span'), elapsed = document.createElement('span');
          line.append(name, state); footer.append(nickname, elapsed); node.append(line, meta, footer);
          row = { node, name, state, meta, nickname, elapsed }; rows.set(agent.id, row);
        }
        const depth = Math.max(0, (agent.depth || 1) - 1), name = agent.name || agent.nickname || '子代理';
        setText(row.name, (depth ? '↳ ' : '') + name); attr(row.name, 'title', name + (depth ? '（第 ' + (depth + 1) + ' 级子代理）' : ''));
        attr(row.node, 'style', '--bc-subagent-depth:' + Math.min(depth, 5));
        setText(row.state, statuses[agent.status] || statuses.unknown); attr(row.state, 'data-state', agent.status);
        const meta = (agent.model || '未知') + ' · ' + (efforts[agent.effort] || agent.effort || '未知');
        setText(row.meta, meta); attr(row.meta, 'title', meta);
        setText(row.nickname, agent.nickname || ''); attr(row.nickname, 'title', agent.nickname || '');
        const running = Number.isFinite(agent.runningSince) ? Math.max(0, observedAt - agent.runningSince) + Math.max(0, now() - receivedAt) : 0;
        setText(row.elapsed, duration((agent.elapsedMs || 0) + running));
        if (list.children[index] !== row.node) list.insertBefore(row.node, list.children[index] || null);
      }
      for (const [id, row] of rows) if (!ids.has(id)) { row.node.remove(); rows.delete(id); }
      position();
    }
    toggle.addEventListener('click', () => {
      const value = !collapsed(); memory.set(threadId, value);
      try { root.localStorage.setItem('bc-subagents-collapsed:' + threadId, String(value)); } catch {}
      render();
    });
    async function poll(id, epoch) {
      const job = {}; pending = job; lastPoll = now();
      try {
        const result = await api('/api/dev/subagents?threadId=' + encodeURIComponent(id), { timeoutMs: 15000 });
        if (disposed || epoch !== generation || id !== threadId || getThreadId() !== id) return;
        if (result?.threadId !== id || !Array.isArray(result.agents)) throw Error('invalid_subagents');
        data = result.agents; syncing = !!result.syncing; receivedAt = now(); observedAt = result.observedAt || receivedAt;
      } catch { if (!disposed && epoch === generation) syncing = true; }
      finally { if (pending === job) pending = null; if (!disposed && epoch === generation) render(); }
    }
    function sync() {
      if (disposed) return;
      const id = getThreadId();
      if (id !== threadId) {
        threadId = id; generation++; pending = null; lastPoll = -Infinity; data = []; syncing = false;
        for (const row of rows.values()) row.node.remove(); rows.clear(); panel.hidden = true;
      }
      if (document.hidden || !threadId) { panel.hidden = true; return; }
      render();
      if (!pending && now() - lastPoll >= 1000) void poll(threadId, generation);
    }
    function visible() { lastPoll = -Infinity; sync(); }
    document.addEventListener('visibilitychange', visible);
    root.addEventListener('resize', sync); root.addEventListener('popstate', sync);
    const timer = root.setInterval(sync, 1000);
    const controller = { sync, destroy() {
      if (disposed) return; disposed = true; generation++;
      root.clearInterval(timer); document.removeEventListener('visibilitychange', visible);
      root.removeEventListener('resize', sync); root.removeEventListener('popstate', sync);
      panel.remove(); style.remove(); rows.clear();
      if (root.__betterCodexSubagentMonitor__ === controller) delete root.__betterCodexSubagentMonitor__;
    } };
    root.__betterCodexSubagentMonitor__ = controller; sync(); return controller;
  }
  root.BetterCodexSubagentMonitor = { create, duration, currentThread };
})(window);

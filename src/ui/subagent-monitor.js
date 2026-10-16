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
  function intersects(a, b) {
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }
  function contentRects(frame, area) {
    const result = [];
    const conversations = [...frame.querySelectorAll('[data-thread-find-target="conversation"]')];
    if (!conversations.length) conversations.push(...frame.querySelectorAll('[data-app-action-timeline-scroll]'));
    for (const conversation of conversations) {
      if (!conversation.getClientRects().length || conversation.closest('[inert]')) continue;
      const scroller = conversation.closest('[data-app-action-timeline-scroll]');
      const clip = scroller?.getBoundingClientRect() || frame.getBoundingClientRect();
      const visible = { left: Math.max(area.left, clip.left), right: Math.min(area.right, clip.right), top: Math.max(area.top, clip.top, 0), bottom: Math.min(area.bottom, clip.bottom, root.innerHeight) };
      if (visible.left >= visible.right || visible.top >= visible.bottom) continue;
      // Message wrappers fill the whole column even when all text is on its
      // right. Only painted text and visual/interactive content can obstruct it.
      if (typeof document.createTreeWalker === 'function') {
        const walker = document.createTreeWalker(conversation, 4);
        let text, visited = 0;
        while ((text = walker.nextNode()) && visited++ < 6000) {
          const parent = text.parentElement;
          if (!text.textContent.trim() || !parent?.getClientRects().length || parent.closest('[inert]') || !intersects(parent.getBoundingClientRect(), visible)) continue;
          const range = document.createRange(); range.selectNodeContents(text);
          for (const rect of range.getClientRects()) if (intersects(rect, visible)) result.push(rect);
          if (result.length >= 64) break;
        }
        if (visited >= 6000) result.push(visible); // Uninspected content stays conservative.
      }
      for (const selector of ['pre', 'img', 'video', 'canvas', 'table', 'button', 'svg']) {
        for (const element of conversation.querySelectorAll(selector)) {
          if (!element.getClientRects().length) continue;
          const rect = element.getBoundingClientRect();
          if (intersects(rect, visible)) result.push(rect);
          if (result.length >= 64) return result;
        }
      }
    }
    return result;
  }
  function create({ api, getThreadId = currentThread, now = () => Date.now(), getContentRects = contentRects }) {
    const legacy = root.__betterCodexSubagentMonitor__;
    if (legacy && legacy !== root.__boostCodexSubagentMonitor__) legacy.destroy?.();
    if (root.__betterCodexSubagentMonitor__ === legacy) delete root.__betterCodexSubagentMonitor__;
    root.__boostCodexSubagentMonitor__?.destroy();
    let disposed = false, threadId = null, generation = 0, pending = null, lastPoll = 0, data = [], syncing = false, receivedAt = 0, observedAt = 0, listError = false, syncSince = null;
    const rows = new Map(), memory = new Map();
    let layoutSignature = '', folded = false;
    let panelCss = '', detailCss = '';
    let followBottom = true;
    let detailId = null, detailEpoch = 0, detailPending = null, detailPollAt = -Infinity, hoverTimer = null, closeTimer = null, work = null, workError = false, detailPointer = false;
    const workCache = new Map();
    const panel = document.createElement('section'); panel.className = 'bc-subagent-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '当前会话子代理'); panel.setAttribute('data-boost-codex-owned', 'true');
    const header = document.createElement('div'); header.className = 'bc-subagent-header';
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'bc-subagent-toggle';
    const runningCount = document.createElement('span'); runningCount.className = 'bc-subagent-count bc-subagent-count-running';
    const completedCount = document.createElement('span'); completedCount.className = 'bc-subagent-count bc-subagent-count-completed';
    const disclosure = document.createElement('span'); disclosure.className = 'bc-subagent-disclosure'; disclosure.setAttribute('aria-hidden', 'true');
    runningCount.textContent = '进行中 0'; completedCount.textContent = '已完成 0';
    toggle.append(runningCount, completedCount, disclosure);
    const notice = document.createElement('span'); notice.className = 'bc-subagent-notice'; notice.setAttribute('role', 'status');
    const list = document.createElement('div'); list.className = 'bc-subagent-list'; list.id = 'bc-subagent-list'; toggle.setAttribute('aria-controls', list.id);
    // Host @layer base declares [hidden] { display:none !important }. Layered
    // important rules beat our unlayered stylesheet even at higher specificity.
    // Keep only this owned list measurable; visibility:hidden still conceals
    // folded rows and removes them from pointer/keyboard/accessibility exposure.
    list.style.setProperty('display', 'block', 'important');
    list.setAttribute('tabindex', '0'); list.setAttribute('aria-label', '子代理列表');
    header.append(toggle, notice); panel.append(header, list);
    const detail = document.createElement('aside'); detail.className = 'bc-subagent-detail'; detail.id = 'bc-subagent-detail'; detail.hidden = true;
    detail.setAttribute('aria-label', '子代理工作内容'); detail.setAttribute('data-boost-codex-owned', 'true');
    const detailHeader = document.createElement('div'); detailHeader.className = 'bc-subagent-detail-header';
    const detailTitle = document.createElement('strong'); detailTitle.className = 'bc-subagent-detail-title';
    const detailClose = document.createElement('button'); detailClose.type = 'button'; detailClose.textContent = '关闭'; detailClose.setAttribute('aria-label', '关闭工作内容');
    detailHeader.append(detailTitle, detailClose);
    const detailMeta = document.createElement('div'); detailMeta.className = 'bc-subagent-detail-meta';
    const detailNotice = document.createElement('div'); detailNotice.className = 'bc-subagent-detail-notice'; detailNotice.setAttribute('role', 'status');
    const detailBody = document.createElement('div'); detailBody.className = 'bc-subagent-detail-body';
    const workFields = {};
    for (const [key, label] of [['task', '分配任务'], ['progress', '最新进展'], ['result', '执行结果']]) {
      const section = document.createElement('section'), title = document.createElement('h3'), text = document.createElement('div');
      title.textContent = label; text.className = 'bc-subagent-work-text'; section.append(title, text); detailBody.append(section); workFields[key] = text;
    }
    detail.append(detailHeader, detailMeta, detailNotice, detailBody);
    const style = document.createElement('style');
    style.textContent = `
      .bc-subagent-panel{position:fixed;z-index:30;width:180px;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:9px;background:var(--bc-subagent-bg,#fff);color:var(--bc-subagent-fg,#252525);box-shadow:0 6px 24px #0002;font:12px/1.5 system-ui,sans-serif;overflow:hidden;isolation:isolate}
      .bc-subagent-panel[hidden]{display:none!important}
      .bc-subagent-header{position:relative;display:flex;align-items:center;padding:6px;gap:3px}
      .bc-subagent-toggle{display:flex;align-items:center;gap:4px;flex:1;min-width:0;text-align:left;background:none;border:0;padding:0;color:inherit;font:inherit;font-size:10px;font-weight:600;white-space:nowrap;cursor:pointer;-webkit-app-region:no-drag}
      .bc-subagent-count{display:inline-flex;align-items:center;justify-content:center;min-width:0;padding:2px 4px;border-radius:4px;color:#fff}
      .bc-subagent-count-running{background:#b88708}.bc-subagent-count-completed{background:#258456}
      /* Lucide play, v1.28.0 (ISC); original asset in assets/disclosure-play.svg. */
      .bc-subagent-disclosure{display:inline-block;flex-shrink:0;width:12px;height:12px;margin-left:auto;background:currentColor;mask:url("data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjI4LjAgLSBJU0MgLS0+CjxzdmcKICBjbGFzcz0ibHVjaWRlIGx1Y2lkZS1wbGF5IgogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIKICB3aWR0aD0iMjQiCiAgaGVpZ2h0PSIyNCIKICB2aWV3Qm94PSIwIDAgMjQgMjQiCiAgZmlsbD0ibm9uZSIKICBzdHJva2U9ImN1cnJlbnRDb2xvciIKICBzdHJva2Utd2lkdGg9IjIiCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIgogIHN0cm9rZS1saW5lam9pbj0icm91bmQiCj4KICA8cGF0aCBkPSJNNSA1YTIgMiAwIDAgMSAzLjAwOC0xLjcyOGwxMS45OTcgNi45OThhMiAyIDAgMCAxIC4wMDMgMy40NThsLTEyIDdBMiAyIDAgMCAxIDUgMTl6IiAvPgo8L3N2Zz4K") center/contain no-repeat}
      .bc-subagent-toggle[aria-expanded=true] .bc-subagent-disclosure{transform:rotate(90deg)}
      .bc-subagent-toggle:focus-visible{outline:2px solid #5689e9;outline-offset:3px;border-radius:3px}
      .bc-subagent-notice{position:absolute;top:2px;right:2px;width:4px;height:4px;border-radius:50%;font-size:0;background:#b88708;pointer-events:none}
      .bc-subagent-notice:empty{display:none}
      .bc-subagent-list{overflow:auto;max-height:var(--bc-subagent-list-height,320px);overscroll-behavior:contain;padding:0 5px 5px}
      /* Keep an invisible, out-of-flow layout box while folded. Its expanded
         size remains measurable without briefly reopening the visible list. */
      .bc-subagent-list[hidden]{display:block!important;position:absolute;left:0;right:0;top:0;visibility:hidden;pointer-events:none}
      .bc-subagent-row{border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);padding:7px 2px 7px calc(2px + var(--bc-subagent-depth,0)*8px)}
      .bc-subagent-line{display:flex;align-items:center;gap:4px;min-width:0}
      .bc-subagent-sequence{flex-shrink:0;font-size:10px;font-variant-numeric:tabular-nums;color:color-mix(in srgb,currentColor 60%,transparent)}
      .bc-subagent-name{font-size:11px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bc-subagent-state{font-size:11px;white-space:nowrap;color:#777}
      .bc-subagent-state[data-state=running],.bc-subagent-state[data-state=starting]{color:#fff;background:#b88708;border-radius:3px;padding:1px 4px;font-size:10px}
      .bc-subagent-state[data-state=completed]{color:#fff;background:#258456;border-radius:3px;padding:1px 4px;font-size:10px}
      .bc-subagent-state[data-state=failed],.bc-subagent-state[data-state=interrupted]{color:#bd6542}
      .bc-subagent-meta{display:block;color:color-mix(in srgb,currentColor 62%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;margin-top:3px}
      .bc-subagent-footer{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:color-mix(in srgb,currentColor 62%,transparent);margin-top:3px}
      .bc-subagent-footer>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-subagent-footer>span:last-child{flex-shrink:0}
      .bc-subagent-row:focus-visible{outline:2px solid #5689e9;outline-offset:-2px;border-radius:5px}
      .bc-subagent-row[aria-expanded=true]{background:color-mix(in srgb,currentColor 5%,transparent);border-radius:6px}
      .bc-subagent-detail{position:fixed;inset:auto;padding:0;margin:0;z-index:31;display:flex;flex-direction:column;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:12px;background:var(--bc-subagent-bg,#fff);color:var(--bc-subagent-fg,#252525);box-shadow:0 8px 28px #0003;font:12px/1.6 system-ui,sans-serif;overflow:hidden;user-select:text}
      .bc-subagent-detail[hidden]{display:none!important}.bc-subagent-detail-header{display:flex;gap:12px;align-items:flex-start;padding:12px 14px 4px}
      .bc-subagent-detail-title{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px}
      .bc-subagent-detail button{background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer;flex-shrink:0;opacity:.7}
      .bc-subagent-detail-meta,.bc-subagent-detail-notice{padding:0 14px 8px;font-size:11px;color:color-mix(in srgb,currentColor 60%,transparent);overflow-wrap:anywhere}
      .bc-subagent-detail-notice:empty{display:none}.bc-subagent-detail-body{overflow:auto;min-height:0;padding:0 14px 14px;overscroll-behavior:contain}
      .bc-subagent-detail h3{font-size:11px;margin:12px 0 5px;color:color-mix(in srgb,currentColor 65%,transparent);font-weight:600}
      .bc-subagent-work-text{white-space:pre-wrap;overflow-wrap:anywhere}
      @media(prefers-color-scheme:dark){.bc-subagent-panel,.bc-subagent-detail{--bc-subagent-bg:#252526;--bc-subagent-fg:#e8e8e8}}
      [data-theme=dark] .bc-subagent-panel,[data-theme=dark] .bc-subagent-detail,.dark .bc-subagent-panel,.dark .bc-subagent-detail{--bc-subagent-bg:#252526;--bc-subagent-fg:#e8e8e8}
      [data-theme=light] .bc-subagent-panel,[data-theme=light] .bc-subagent-detail,.light .bc-subagent-panel,.light .bc-subagent-detail{--bc-subagent-bg:#fff;--bc-subagent-fg:#252525}
    `;
    document.head.append(style); document.body.append(panel, detail);
    function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
    function setHidden(node, value) { if (node.hidden !== value) node.hidden = value; }
    function attr(node, key, value) { if (node.getAttribute(key) !== String(value)) node.setAttribute(key, String(value)); }
    function taskTitle(agent) {
      const title = workCache.get(threadId + ':' + agent.id)?.title || agent.title;
      return typeof title === 'string' && /^[\u3400-\u9fff]{2,10}$/.test(title) ? title : '子代理任务';
    }
    function followLatest() {
      if (!followBottom || folded || panel.hidden || document.hidden) return;
      const bottom = Math.max(0, (list.scrollHeight || 0) - (list.clientHeight || 0));
      if (Math.abs((list.scrollTop || 0) - bottom) > 1) list.scrollTop = bottom;
    }
    function onListScroll() {
      if (folded || panel.hidden || document.hidden) return;
      followBottom = (list.scrollHeight || 0) - (list.clientHeight || 0) - (list.scrollTop || 0) <= 4;
      if (detailId) placeDetail();
    }
    list.addEventListener('scroll', onListScroll);
    list.addEventListener('wheel', event => { if (event.deltaY < 0) followBottom = false; }, { passive: true });
    function clearHover() { if (hoverTimer !== null) { root.clearTimeout(hoverTimer); hoverTimer = null; } }
    function clearClose() { if (closeTimer !== null) { root.clearTimeout(closeTimer); closeTimer = null; } }
    function hideDetail() {
      clearHover(); clearClose();
      if (detailId) attr(rows.get(detailId)?.node || detail, 'aria-expanded', false);
      detailId = null; detailEpoch++; detailPending = null; work = null; workError = false; detailPointer = false; setHidden(detail, true);
    }
    function placeDetail() {
      const row = rows.get(detailId)?.node;
      if (!row || panel.hidden || folded || document.hidden || !row.getClientRects().length) { hideDetail(); return; }
      const anchor = row.getBoundingClientRect(), panelRect = panel.getBoundingClientRect(), listRect = list.getBoundingClientRect();
      if (anchor.bottom <= listRect.top || anchor.top >= listRect.bottom) { hideDetail(); return; }
      const viewportWidth = root.innerWidth || document.documentElement?.clientWidth || 1000;
      const editor = [...document.querySelectorAll('[data-codex-composer]')].find(node => node.getClientRects().length && !node.closest('[inert]'));
      const composer = editor?.closest('[data-composer-surface-variant]') || editor;
      const bottom = Math.min(root.innerHeight - 12, composer?.getClientRects().length ? composer.getBoundingClientRect().top - 12 : root.innerHeight - 12);
      if (bottom < 100) { hideDetail(); return; }
      const right = viewportWidth - panelRect.right - 20, leftSpace = panelRect.left - 20;
      let width, left;
      if (right >= 240 || right >= 180 && leftSpace < 240) { width = Math.min(380, right); left = panelRect.right + 8; }
      else if (leftSpace >= 240) { width = Math.min(380, leftSpace); left = panelRect.left - width - 8; }
      else { width = Math.min(380, viewportWidth - 24); left = Math.max(12, viewportWidth - width - 12); }
      const maxHeight = Math.min(460, bottom - 12), top = Math.max(12, Math.min(anchor.top, bottom - maxHeight));
      const css = `left:${left}px;top:${top}px;width:${width}px;max-height:${maxHeight}px`;
      if (detailCss !== css) { detail.style.cssText = css; detailCss = css; }
    }
    function renderDetail() {
      const agent = data.find(item => item.id === detailId);
      if (!agent || getThreadId() !== threadId || document.hidden) { hideDetail(); return; }
      const sequence = rows.get(agent.id)?.sequence.textContent;
      setText(detailTitle, (sequence ? sequence + ' ' : '') + taskTitle(agent));
      setText(detailMeta, [agent.nickname, agent.model || '未知', statuses[agent.status] || '未知'].filter(Boolean).join(' · '));
      setText(detailNotice, workError ? (work ? '同步中' : '暂时无法读取，请稍后重试。') : !work ? '正在读取工作内容…' : work.syncing ? '同步中' : work.truncated ? '内容较长，已显示部分内容。' : '');
      const task = work?.task && !/^gAAAA[A-Za-z0-9_-]{60,}={0,2}$/.test(work.task.trim()) ? work.task : '';
      setText(workFields.task, task || (work ? work.taskUnavailable ? '任务内容暂不可读取' : '暂无任务说明' : ''));
      setText(workFields.progress, work?.progress || (work ? '暂无进展记录' : ''));
      setText(workFields.result, work?.result || (work ? '尚无执行结果' : ''));
      setHidden(detail, false); placeDetail();
    }
    async function pollDetail() {
      if (!detailId || detailPending || document.hidden) return;
      const id = detailId, owner = threadId, epoch = detailEpoch, job = {}; detailPending = job; detailPollAt = now();
      try {
        const result = await api('/api/dev/subagents/work?threadId=' + encodeURIComponent(owner) + '&agentId=' + encodeURIComponent(id), { timeoutMs: 15000 });
        if (disposed || epoch !== detailEpoch || id !== detailId || owner !== threadId || getThreadId() !== owner) return;
        if (result?.threadId !== owner || result.agentId !== id || !['task', 'progress', 'result'].every(key => typeof result[key] === 'string')) throw Error('invalid_work');
        work = result; workError = false;
        const key = owner + ':' + id; workCache.delete(key); workCache.set(key, result);
        if (workCache.size > 12) workCache.delete(workCache.keys().next().value);
      } catch { if (!disposed && epoch === detailEpoch) workError = true; }
      finally { if (detailPending === job) detailPending = null; if (!disposed && epoch === detailEpoch && detailId) render(); }
    }
    function showDetail(id) {
      clearHover(); clearClose();
      if (disposed || folded || panel.hidden || document.hidden || !data.some(agent => agent.id === id)) return;
      if (detailId !== id) {
        if (detailId) attr(rows.get(detailId)?.node || detail, 'aria-expanded', false);
        detailId = id; detailEpoch++; detailPending = null; detailPollAt = -Infinity;
        work = workCache.get(threadId + ':' + id) || null; workError = false;
      }
      attr(rows.get(id).node, 'aria-expanded', true); renderDetail();
      if (!detailPending && now() - detailPollAt >= 1000) void pollDetail();
    }
    function queueDetail(id) {
      clearHover(); clearClose();
      if (detailId) showDetail(id);
      else hoverTimer = root.setTimeout(() => { hoverTimer = null; showDetail(id); }, 250);
    }
    function leaveDetail() { clearHover(); clearClose(); closeTimer = root.setTimeout(hideDetail, 220); }
    detail.addEventListener('mouseenter', () => { detailPointer = true; clearClose(); });
    detail.addEventListener('mouseleave', () => { detailPointer = false; leaveDetail(); });
    detail.addEventListener('focusin', clearClose);
    detailClose.addEventListener('click', hideDetail);
    detail.addEventListener('keydown', event => { if (event.key === 'Escape') hideDetail(); });
    function position() {
      const editor = [...document.querySelectorAll('[data-codex-composer]')].find(node => node.getClientRects().length && !node.closest('[inert]'));
      const frame = editor?.closest('[data-app-shell-thread-edge-divider]') || [...document.querySelectorAll('.app-shell-main-content-frame'), ...document.querySelectorAll('[data-app-shell-main-content-layout]')].find(node => node.getClientRects().length);
      if (!frame || !frame.getClientRects().length) { setHidden(panel, true); return; }
      const rect = frame.getBoundingClientRect();
      const top = Math.max(8, rect.top + 54), left = Math.max(0, rect.left);
      const composer = editor?.closest('[data-composer-surface-variant]') || editor;
      const bottom = composer?.getClientRects().length ? composer.getBoundingClientRect().top - 12 : root.innerHeight - 16;
      const height = Math.min(380, bottom - top);
      if (height < 50 || rect.width < 120) { setHidden(panel, true); return; }
      const width = Math.min(180, rect.width);
      const css = `left:${left}px;top:${top}px;width:${width}px;--bc-subagent-list-height:${Math.max(0, height - 42)}px`;
      if (panelCss !== css) { panel.style.cssText = css; panelCss = css; }
      setHidden(panel, !data.length);
      // Folded lists retain an invisible layout box, so measuring never changes
      // their visibility or triggers pointer leave/enter events during polling.
      const listHeight = list.getBoundingClientRect().height;
      // A missing layout box is unknown geometry, not proof that the expanded
      // panel would fit. Stay conservative if another host rule removes it.
      const expandedHeight = listHeight > 0 ? Math.min(height, header.getBoundingClientRect().height + listHeight + 2) : height;
      const area = { left: left - 4, right: left + width + 4, top: top - 4, bottom: top + expandedHeight + 4 };
      const blocked = getContentRects(frame, area).filter(box => intersects(box, area));
      const signature = [threadId, left, top, width, expandedHeight, rect.width, rect.height, bottom, blocked.length > 0]
        .map(value => typeof value === 'number' ? Math.round(value / 4) : value).join(':');
      const manual = memory.get(threadId);
      folded = manual?.signature === signature ? manual.folded : blocked.length > 0;
      if (manual && manual.signature !== signature) memory.delete(threadId);
      layoutSignature = signature;
      setHidden(list, folded);
      const active = data.filter(a => a.status === 'running' || a.status === 'starting').length;
      const completed = data.filter(a => a.status === 'completed').length;
      setText(runningCount, '进行中 ' + active); setText(completedCount, '已完成 ' + completed);
      const label = (folded ? '展开子代理' : '收起子代理') + '，进行中 ' + active + '，已完成 ' + completed;
      attr(toggle, 'aria-label', label); attr(toggle, 'title', label); attr(toggle, 'aria-expanded', !folded);
      followLatest();
      if (detailId) { if (folded) hideDetail(); else renderDetail(); }
    }
    function render() {
      if (disposed) return;
      if (document.hidden || !threadId || getThreadId() !== threadId || !data.length) { setHidden(panel, true); hideDetail(); return; }
      // Short successful discovery passes are routine background work. Avoid a
      // blinking status and never let its appearance change the card's height.
      if (syncing) { if (syncSince === null) syncSince = now(); } else syncSince = null;
      const status = listError || syncSince !== null && now() - syncSince >= 1500 ? '同步中' : '';
      setText(notice, status); attr(notice, 'aria-label', status); attr(notice, 'title', status);
      // Creation order keeps both numbering and scroll anchors stable when a
      // running agent completes. New agents belong at the bottom of the list.
      const ordered = [...data].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id));
      const ids = new Set();
      for (let index = 0; index < ordered.length; index++) {
        const agent = ordered[index]; ids.add(agent.id);
        let row = rows.get(agent.id);
        if (!row) {
          const node = document.createElement('article'); node.className = 'bc-subagent-row';
          node.setAttribute('data-subagent-id', agent.id);
          node.setAttribute('tabindex', '0'); node.setAttribute('aria-controls', detail.id); node.setAttribute('aria-expanded', 'false');
          node.addEventListener('mouseenter', () => queueDetail(agent.id)); node.addEventListener('mouseleave', leaveDetail);
          node.addEventListener('focus', () => showDetail(agent.id)); node.addEventListener('blur', () => { if (!detailPointer) leaveDetail(); });
          node.addEventListener('keydown', event => { if (event.key === 'Escape') hideDetail(); if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showDetail(agent.id); } });
          const line = document.createElement('div'); line.className = 'bc-subagent-line';
          const sequence = document.createElement('span'); sequence.className = 'bc-subagent-sequence';
          const name = document.createElement('span'); name.className = 'bc-subagent-name';
          const state = document.createElement('span'); state.className = 'bc-subagent-state';
          const meta = document.createElement('span'); meta.className = 'bc-subagent-meta';
          const footer = document.createElement('div'); footer.className = 'bc-subagent-footer';
          const nickname = document.createElement('span'), elapsed = document.createElement('span');
          line.append(sequence, name, state); footer.append(nickname, elapsed); node.append(line, meta, footer);
          row = { node, sequence, name, state, meta, nickname, elapsed }; rows.set(agent.id, row);
        }
        const depth = Math.max(0, (agent.depth || 1) - 1), name = taskTitle(agent);
        setText(row.sequence, String(index + 1) + '.');
        attr(row.node, 'aria-label', '查看 ' + name + ' 的工作内容');
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
      memory.set(threadId, { folded: !folded, signature: layoutSignature });
      render();
    });
    async function poll(id, epoch) {
      const job = {}; pending = job; lastPoll = now();
      try {
        const result = await api('/api/dev/subagents?threadId=' + encodeURIComponent(id), { timeoutMs: 15000 });
        if (disposed || epoch !== generation || id !== threadId || getThreadId() !== id) return;
        if (result?.threadId !== id || !Array.isArray(result.agents)) throw Error('invalid_subagents');
        data = result.agents; syncing = !!result.syncing; listError = false; receivedAt = now(); observedAt = result.observedAt || receivedAt;
      } catch { if (!disposed && epoch === generation) { syncing = true; listError = true; } }
      finally { if (pending === job) pending = null; if (!disposed && epoch === generation) render(); }
    }
    function sync() {
      if (disposed) return;
      const id = getThreadId();
      if (id !== threadId) {
        hideDetail();
        threadId = id; generation++; pending = null; lastPoll = -Infinity; data = []; syncing = false; listError = false; syncSince = null; followBottom = true;
        for (const row of rows.values()) row.node.remove(); rows.clear(); setHidden(panel, true);
      }
      if (document.hidden || !threadId) { setHidden(panel, true); hideDetail(); return; }
      render();
      if (!pending && now() - lastPoll >= 1000) void poll(threadId, generation);
      if (detailId && !detailPending && now() - detailPollAt >= 1000) void pollDetail();
    }
    function visible() { lastPoll = -Infinity; sync(); }
    function onDocumentScroll(event) { if (event.target !== list && !detail.contains?.(event.target)) sync(); }
    document.addEventListener('visibilitychange', visible);
    root.addEventListener('resize', sync); root.addEventListener('popstate', sync);
    document.addEventListener('scroll', onDocumentScroll, true);
    const timer = root.setInterval(sync, 1000);
    const controller = { sync, destroy() {
      if (disposed) return; disposed = true; generation++;
      hideDetail(); workCache.clear();
      root.clearInterval(timer); document.removeEventListener('visibilitychange', visible);
      root.removeEventListener('resize', sync); root.removeEventListener('popstate', sync);
      document.removeEventListener('scroll', onDocumentScroll, true);
      panel.remove(); detail.remove(); style.remove(); rows.clear();
      if (root.__boostCodexSubagentMonitor__ === controller) delete root.__boostCodexSubagentMonitor__;
    } };
    root.__boostCodexSubagentMonitor__ = controller; sync(); return controller;
  }
  root.boostCodexSubagentMonitor = { create, duration, currentThread, contentRects };
})(window);

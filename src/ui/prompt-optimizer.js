"use strict";
(function (root) {
  function currentFiber(node) {
    let fiber = node[Object.keys(node).find(key => key.startsWith("__reactFiber$"))], top = fiber;
    while (top?.return) top = top.return;
    return top?.stateNode?.current && top.stateNode.current !== top ? fiber?.alternate : fiber;
  }
  function limitContext(messages) {
    let remaining = 32000, truncated = false;
    const selected = [];
    for (const message of messages.slice(-12).reverse()) {
      if (remaining < 200) { truncated = true; break; }
      let content = message.content.trim();
      const budget = Math.min(8000, remaining);
      if (content.length > budget) {
        const marker = '\n[较长消息中间部分已省略]\n';
        const half = Math.floor((budget - marker.length) / 2);
        content = content.slice(0, half) + marker + content.slice(-(budget - marker.length - half)); truncated = true;
      }
      if (content) { selected.push({ role: message.role, content }); remaining -= content.length; }
    }
    return { messages: selected.reverse(), truncated: truncated || messages.length > 12 };
  }
  function conversationId(editor) {
    for (let node = editor; node; node = node.parentElement) {
      for (let fiber = currentFiber(node); fiber; fiber = fiber.return) {
        const id = fiber.memoizedProps?.conversationId;
        if (typeof id === 'string' && id) return id;
      }
    }
    return null;
  }
  function activeEditor(editor) { return editor.isConnected && !!editor.getClientRects().length && !editor.closest('[inert]'); }
  function conversationContext(editor) {
    let ownerId = null;
    const inspected = new Set();
    for (let node = editor; node; node = node.parentElement) {
      for (let fiber = currentFiber(node); fiber; fiber = fiber.return) {
        if (inspected.has(fiber)) continue;
        inspected.add(fiber);
        const id = fiber.memoizedProps?.conversationId;
        if (typeof id !== 'string' || !id) continue;
        ownerId ||= id;
        if (id !== ownerId) continue;
        const turns = new Map(), stack = fiber.child ? [fiber.child] : [], seen = new Set();
        while (stack.length && seen.size < 20000) {
          const child = stack.pop();
          if (!child || seen.has(child)) continue;
          seen.add(child);
          if (child.sibling) stack.push(child.sibling);
          const props = child.memoizedProps || {};
          if (props.conversationId && props.conversationId !== ownerId) continue;
          const turn = props.turn;
          if (turn?.turnId && Array.isArray(turn.items) && (!turn.params?.threadId || turn.params.threadId === ownerId)) turns.set(turn.turnId, turn);
          if (child.child) stack.push(child.child);
        }
        if (!turns.size) continue;
        const messages = [];
        // Walk order is native display order; timestamps stabilize duplicate presentations.
        const ordered = [...turns.values()].sort((a, b) => (a.turnStartedAtMs || 0) - (b.turnStartedAtMs || 0));
        for (const turn of ordered.slice(-6)) {
          for (const item of turn.items) {
            if (item.type === 'userMessage') {
              const content = (item.content || []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
              if (content.trim()) messages.push({ role: 'user', content });
            } else if (item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string' && item.text.trim()) {
              messages.push({ role: 'assistant', content: item.text });
            }
          }
        }
        return { available: true, conversationId: ownerId, ...limitContext(messages) };
      }
    }
    return { available: !ownerId, conversationId: ownerId, messages: [], truncated: false };
  }
  function nativeController(editor) {
    for (let node = editor; node; node = node.parentElement) {
      let fiber = node[Object.keys(node).find(key => key.startsWith("__reactFiber$"))];
      let top = fiber;
      while (top?.return) top = top.return;
      if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber?.alternate;
      for (let count = 0; fiber && count < 20; count++, fiber = fiber.return) {
        const controller = fiber.memoizedProps?.composerController;
        if (controller?.view?.dom === editor && typeof controller.getPersistedText === "function" && typeof controller.setPromptText === "function" && typeof controller.restoreDocument === "function") return controller;
      }
    }
    return null;
  }
  function create({ api }) {
    const bars = new Map();
    let dialog = null, opener = null, disposed = false, busy = false;
    const style = document.createElement("style");
    style.textContent = `
      .bc-prompt-tools{display:flex;align-items:center;gap:5px;min-width:0}
      .bc-prompt-tools button{font:inherit;font-size:12px;border:1px solid #8884;border-radius:999px;background:transparent;color:var(--color-text-secondary,#aaa);padding:3px 8px;white-space:nowrap;cursor:pointer}
      .bc-prompt-tools button:disabled{opacity:.5;cursor:default}
      .bc-prompt-status{font-size:12px;color:var(--color-text-secondary,#aaa);max-width:200px;white-space:normal}
      .bc-prompt-dialog{width:min(620px,calc(100vw - 32px));max-height:85vh;overflow:auto;padding:24px;border:1px solid #8885;border-radius:16px;background:var(--color-background-elevated-primary,#282828);color:var(--color-text-primary,#eee);font:inherit}
      .bc-prompt-dialog::backdrop{background:#0007}
      .bc-prompt-dialog h2{font-size:18px;margin:0 0 16px}
      .bc-prompt-dialog p{font-size:13px;line-height:1.6}
      .bc-prompt-dialog label{display:flex;flex-direction:column;gap:6px;margin:14px 0;font-size:13px}
      .bc-prompt-dialog input,.bc-prompt-dialog textarea,.bc-prompt-dialog select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #8885;border-radius:8px;background:var(--color-background-primary,#202020);color:inherit;font:inherit}
      .bc-prompt-dialog textarea{min-height:180px;resize:vertical}
      .bc-prompt-dialog button{padding:8px 12px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
      .bc-prompt-dialog button:disabled{opacity:.5;cursor:default}
      .bc-prompt-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
      .bc-prompt-dialog .bc-prompt-save{background:#3478ed;color:#fff;border-color:transparent}
      .bc-prompt-error{color:#f88}
      .bc-prompt-tools button:focus-visible,.bc-prompt-dialog button:focus-visible{outline:2px solid #438cff;outline-offset:2px}
    `;
    document.head.append(style);
    function button(label, action) {
      const node = document.createElement("button"); node.type = "button"; node.textContent = label;
      node.addEventListener("click", action); return node;
    }
    function close() {
      dialog?.close(); dialog?.remove(); dialog = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }
    function modal(title, from) {
      close(); opener = from;
      const current = document.createElement("dialog"); current.className = "bc-prompt-dialog";
      current.setAttribute("aria-label", title);
      const heading = document.createElement("h2"); heading.textContent = title; current.append(heading);
      current.addEventListener("cancel", event => { event.preventDefault(); close(); });
      document.body.append(current); dialog = current; current.showModal(); return current;
    }
    function errorText(error) {
      if (error?.message && /[\u4e00-\u9fff]/.test(error.message)) return error.message;
      return "操作失败，请检查设置和网络后重试。";
    }
    async function configure(from) {
      const current = modal("DeepSeek 提示词优化", from);
      const loading = document.createElement("p"); loading.textContent = "正在读取设置…"; current.append(loading);
      current.append(button("关闭", close));
      let settings;
      try { settings = await api("/api/dev/prompt-optimizer/settings"); }
      catch (error) { if (dialog === current) loading.textContent = errorText(error); return; }
      if (disposed || dialog !== current) return;
      loading.remove(); current.lastElementChild.remove();
      const form = document.createElement("form");
      function field(label, control) { const node = document.createElement("label"); node.append(document.createTextNode(label), control); form.append(node); }
      const key = document.createElement("input"); key.type = "password"; key.autocomplete = "new-password"; key.maxLength = 512;
      key.placeholder = settings.hasApiKey ? "已配置，留空保留原密钥" : "请输入 DeepSeek API Key";
      field("API Key", key);
      const model = document.createElement("select");
      for (const [value, name] of [["deepseek-flash", "DeepSeek Flash（快速）"], ["deepseek-v4-pro", "DeepSeek V4 Pro"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = name; model.append(option);
      }
      model.value = settings.model; model.required = true;
      field("模型", model);
      const contextMode = document.createElement("select");
      for (const [value, name] of [["recent", "最近对话（默认）"], ["input", "仅当前输入"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = name; contextMode.append(option);
      }
      contextMode.value = settings.contextMode || 'recent'; field("关联上下文", contextMode);
      const prompt = document.createElement("textarea"); prompt.value = settings.systemPrompt; prompt.maxLength = 12000; prompt.required = true;
      field("优化指令", prompt);
      const hint = document.createElement("p"); hint.textContent = "选择最近对话时，当前聊天最近 6 轮的文字会随本次输入发送给 DeepSeek。优化结果先预览，确认后替换输入框。快捷键：Ctrl + Alt + P。";
      const error = document.createElement("p"); error.className = "bc-prompt-error"; error.setAttribute("role", "alert");
      const actions = document.createElement("div"); actions.className = "bc-prompt-actions";
      const save = button("保存", () => {}); save.type = "submit"; save.className = "bc-prompt-save";
      let clearApiKey = false;
      const clear = button("清除密钥", () => { clearApiKey = true; key.value = ""; key.placeholder = "保存后清除密钥"; clear.disabled = true; });
      clear.disabled = !settings.hasApiKey;
      actions.append(clear, button("取消", close), save); form.append(hint, error, actions); current.append(form);
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return; save.disabled = true; error.textContent = "";
        try {
          await api("/api/dev/prompt-optimizer/settings", { method: "POST", body: JSON.stringify({ apiKey: key.value.trim(), clearApiKey: clearApiKey && !key.value.trim(), model: model.value.trim(), contextMode: contextMode.value, systemPrompt: prompt.value.trim() }) });
          key.value = ""; if (dialog === current) close();
        } catch (failure) { if (dialog === current) { error.textContent = errorText(failure); save.disabled = false; } }
      });
      key.focus();
    }
    function unchanged(job) {
      return activeEditor(job.editor) && root.location.href === job.route && conversationId(job.editor) === job.conversationId && nativeController(job.editor) === job.controller && job.controller.view.state.doc.eq(job.doc);
    }
    function apply(job, text) {
      if (!unchanged(job)) return false;
      job.controller.setPromptText(text, { preserveLibraryFileMentions: true });
      job.controller.focus(); return true;
    }
    function remember(job, bar) {
      bar.previous = { ...job, result: job.controller.view.state.doc, plainTextMode: job.controller.plainTextMode };
      bar.restore.hidden = false;
    }
    function preview(job, text, bar) {
      const current = modal("优化结果", bar.optimize);
      const hint = document.createElement("p"); hint.textContent = job.contextMode === 'recent' ? `已关联当前聊天 ${job.contextCount} 条近期消息${job.truncated ? '（较长内容已截取）' : ''}。确认内容后再替换输入框。` : "仅根据当前输入优化。确认内容后再替换输入框。";
      const originalLabel = document.createElement("label"); const original = document.createElement("textarea");
      original.value = job.text; original.readOnly = true; original.setAttribute("aria-label", "原始输入"); originalLabel.append(document.createTextNode("原始输入"), original);
      const resultLabel = document.createElement("label");
      const result = document.createElement("textarea"); result.value = text; result.setAttribute("aria-label", "优化后的提示词"); resultLabel.append(document.createTextNode("优化结果（可修改）"), result);
      const error = document.createElement("p"); error.className = "bc-prompt-error"; error.setAttribute("role", "alert");
      const actions = document.createElement("div"); actions.className = "bc-prompt-actions";
      actions.append(button("关闭", close), button("复制", async () => {
        try { await navigator.clipboard.writeText(result.value); if (dialog === current) error.textContent = "已复制"; }
        catch { result.focus(); result.select(); error.textContent = "请按 Ctrl + C 复制。"; }
      }), button("替换输入框", () => {
        if (!activeEditor(job.editor) || root.location.href !== job.route || conversationId(job.editor) !== job.conversationId || nativeController(job.editor) !== job.controller) { error.textContent = "请返回原聊天后重新优化。"; return; }
        if (!unchanged(job) && !job.overwriteConfirmed) {
          job.overwriteConfirmed = job.controller.view.state.doc;
          error.textContent = "输入框内容已变化。再次点击替换，将覆盖当前文字。"; return;
        }
        if (!unchanged(job) && !job.controller.view.state.doc.eq(job.overwriteConfirmed)) { job.overwriteConfirmed = null; error.textContent = "输入框再次变化，请重新确认替换。"; return; }
        if (!result.value.trim()) { error.textContent = "优化结果不能为空。"; return; }
        job.doc = job.controller.view.state.doc;
        if (apply(job, result.value)) { remember(job, bar); close(); bar.status.textContent = "已替换。"; }
      }));
      current.append(hint, originalLabel, resultLabel, error, actions);
    }
    async function optimize(editor, bar) {
      if (busy || disposed || !activeEditor(editor)) return;
      const controller = nativeController(editor);
      if (!controller || controller.view.isDestroyed || controller.view.composing || editor.getAttribute("contenteditable") !== "true") { bar.status.textContent = "当前输入框暂不可优化。"; return; }
      const text = controller.getPersistedText();
      if (!text.trim()) { bar.status.textContent = "请先输入需要优化的内容。"; editor.focus(); return; }
      const job = { editor, controller, text, doc: controller.view.state.doc, route: root.location.href, conversationId: conversationId(editor) };
      busy = true; for (const item of bars.values()) item.optimize.disabled = true;
      bar.status.textContent = "正在优化…";
      try {
        const settings = await api("/api/dev/prompt-optimizer/settings");
        if (disposed) return;
        if (!unchanged(job)) { bar.status.textContent = "输入内容已变化，请重新优化。"; return; }
        job.contextMode = settings.contextMode || 'recent';
        const context = job.contextMode === 'recent' ? conversationContext(editor) : { available: true, messages: [], truncated: false };
        if (!context.available) { bar.status.textContent = "暂时无法读取当前聊天，请重试或选择仅当前输入。"; return; }
        job.contextCount = context.messages.length; job.truncated = context.truncated;
        const response = await api("/api/dev/prompt-optimizer/optimize", { method: "POST", body: JSON.stringify({ text, context: context.messages, contextMode: job.contextMode }), timeoutMs: 100000 });
        if (disposed) return;
        if (typeof response.text !== "string" || !response.text.trim()) throw new Error("empty_result");
        if (Number.isInteger(response.contextCount)) job.contextCount = response.contextCount;
        bar.status.textContent = "优化完成，请查看结果。"; preview(job, response.text, bar);
      } catch (error) { if (!disposed) bar.status.textContent = errorText(error); }
      finally { busy = false; for (const item of bars.values()) item.optimize.disabled = false; }
    }
    function sync() {
      for (const [editor, bar] of bars) if (!editor.isConnected || !bar.node.isConnected) { bar.node.remove(); bars.delete(editor); }
      for (const editor of document.querySelectorAll('[data-codex-composer][contenteditable="true"]')) {
        const surface = editor.closest("[data-composer-surface-variant]");
        const anchor = surface?.querySelector('.bc-composer-lower-actions') || surface?.querySelector('[data-composer-navigation-target="add-context"]')?.parentElement?.parentElement;
        if (!anchor) continue;
        if (bars.has(editor)) {
          const existing = bars.get(editor).node;
          if (existing.parentElement !== anchor) anchor.append(existing);
          continue;
        }
        const node = document.createElement("div"); node.className = "bc-prompt-tools"; node.setAttribute("data-better-codex-owned", "true");
        const status = document.createElement("span"); status.className = "bc-prompt-status"; status.setAttribute("role", "status");
        const bar = { node, status };
        bar.optimize = button("优化提示词", () => void optimize(editor, bar)); bar.optimize.title = "用 DeepSeek 优化提示词（Ctrl + Alt + P）"; bar.optimize.disabled = busy;
        bar.restore = button("还原原文", () => {
          const previous = bar.previous;
          if (!previous || busy) return;
          if (!activeEditor(editor) || root.location.href !== previous.route || conversationId(editor) !== previous.conversationId || nativeController(editor) !== previous.controller || !previous.controller.view.state.doc.eq(previous.result)) {
            bar.status.textContent = "内容已变化，无法还原，请使用输入框撤销。"; return;
          }
          previous.controller.restoreDocument(previous.doc, previous.plainTextMode);
          previous.controller.focus(); bar.restore.hidden = true; bar.previous = null; bar.status.textContent = "已还原原文。";
        });
        bar.restore.hidden = true;
        node.append(bar.optimize, bar.restore, status); anchor.append(node); bars.set(editor, bar);
      }
    }
    function keydown(event) {
      if (event.isComposing || event.repeat || !event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey || event.code !== "KeyP") return;
      const editor = event.target.closest?.('[data-codex-composer][contenteditable="true"]');
      if (!editor || !bars.has(editor) || dialog?.open) return;
      event.preventDefault(); event.stopPropagation(); void optimize(editor, bars.get(editor));
    }
    document.addEventListener("keydown", keydown, true);
    return { configure, sync, destroy() { disposed = true; close(); document.removeEventListener("keydown", keydown, true); for (const bar of bars.values()) bar.node.remove(); bars.clear(); style.remove(); } };
  }
  root.BetterCodexPromptOptimizer = { create, nativeController, conversationContext, limitContext };
})(window);

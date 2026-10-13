"use strict";
var BetterCodexInjected = (() => {
  function isAuxiliaryDesktopUrl(value) {
    try {
      const url = new URL(value);
      const route = new URL(url.searchParams.get("initialRoute") || url.pathname + url.search, "https://codex.local");
      return /detached-window|global-dictation|avatar-overlay/i.test(url.pathname + route.pathname) ||
        route.searchParams.get("window") === "page" || route.searchParams.get("prewarm") === "1";
    } catch { return false; }
  }
  // Use the owning native picker so draft and existing chats share the same
  // model/effort semantics. Service tier remains exclusively native-owned.
  function createComposerModelShortcuts(renderFastIcon = () => "", renderSettingsIcon = () => "", renderGripIcon = () => "") {
    const key = "better-codex-composer-model-shortcuts-v1";
    const defaults = [
      { name: "6.1 Sol · 中等", model: "gpt-6.1-sol", effort: "medium" },
      { name: "6.1 Sol · Ultra", model: "gpt-6.1-sol", effort: "ultra" }
    ];
    const effortNames = { none: "无", minimal: "极低", low: "轻度", medium: "中等", high: "高", xhigh: "极高", max: "Max", ultra: "Ultra", persistent: "持续" };
    const bars = new Map();
    let presets = defaults, dialog = null, returnFocus = null, dragging = null, suppressClickUntil = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(saved)) presets = saved.filter(p => p && typeof p.name === "string" && typeof p.model === "string" && typeof p.effort === "string").map(p => ({ name: p.name.slice(0, 40), model: p.model, effort: p.effort }));
    } catch { /* Keep usable defaults if local preferences are damaged. */ }
    function picker(trigger) {
      let fiber = trigger?.[Object.keys(trigger).find(k => k.startsWith("__reactFiber$"))];
      let top = fiber;
      while (top?.return) top = top.return;
      if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber?.alternate;
      for (; fiber; fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (Array.isArray(props?.models) && typeof props.onSelectModel === "function") return props;
      }
      return null;
    }
    const modelsFor = props => (props.modelOptions || props.models.map(model => ({ model }))).filter(option => !option.disabledReason && !option.model.hidden && (!props.lockedModelSlug || option.model.model === props.lockedModelSlug)).map(option => option.model);
    const effortsFor = model => (model?.supportedReasoningEfforts || []).map(item => item.reasoningEffort || item.value).filter(Boolean);
    function available(props, preset) {
      return !!props && !props.modelOptionsDisabled && !props.reasoningEffortDisabled && modelsFor(props).some(model => (model.model || model.id) === preset.model && effortsFor(model).includes(preset.effort));
    }
    function fastOption(props) {
      const model = props?.models.find(model => (model.model || model.id) === props.model);
      return props?.serviceTierOptions?.find(option => ["priority", "fast"].includes(option.value) &&
        (model?.serviceTiers?.some(tier => tier.id === option.value) || model?.additionalSpeedTiers?.includes("fast")));
    }
    function canToggleFast(props, trigger) {
      return !!props && !trigger.disabled && !props.disabled && !props.serviceTierOptionsLoading && typeof props.onSelectServiceTier === "function" && !!fastOption(props);
    }
    function button(text, action) {
      const node = document.createElement("button");
      node.type = "button";
      node.textContent = text;
      node.addEventListener("click", action);
      return node;
    }
    function closeDialog() {
      dialog?.close();
      dialog?.remove();
      dialog = null;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }
    function configure(trigger, opener, draft = presets) {
      const props = picker(trigger);
      if (!props) return;
      closeDialog();
      returnFocus = opener;
      const catalog = modelsFor(props);
      dialog = document.createElement("dialog");
      dialog.className = "bc-composer-shortcut-dialog";
      dialog.setAttribute("aria-label", "配置模型快捷选项");
      const form = document.createElement("form");
      const heading = document.createElement("h2");
      heading.textContent = "模型快捷选项";
      const rows = document.createElement("div");
      rows.className = "bc-composer-shortcut-rows";
      let draggedRow = null;
      function clearRowDrag() {
        draggedRow = null;
        for (const row of rows.children) { row.removeAttribute("data-bc-row-dragging"); row.removeAttribute("data-bc-row-drop"); }
      }
      const error = document.createElement("p");
      error.className = "bc-composer-shortcut-error";
      error.setAttribute("role", "alert");
      function addRow(preset = {}) {
        const row = document.createElement("div");
        row.className = "bc-composer-shortcut-row";
        const handle = button("", () => {});
        handle.className = "bc-composer-shortcut-drag-handle";
        handle.innerHTML = renderGripIcon();
        handle.setAttribute("aria-label", "拖动排序");
        handle.title = "拖动排序（也可按 Alt + ↑ / ↓）";
        handle.setAttribute("draggable", "true");
        handle.addEventListener("dragstart", event => {
          event.stopPropagation();
          draggedRow = row;
          row.setAttribute("data-bc-row-dragging", "true");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-better-codex-shortcut-row", "reorder");
            event.dataTransfer.setDragImage?.(row, 16, 16);
          }
        });
        handle.addEventListener("dragend", clearRowDrag);
        handle.addEventListener("keydown", event => {
          if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const index = [...rows.children].indexOf(row);
          if (event.key === "ArrowUp" && index > 0) rows.insertBefore(row, rows.children[index - 1]);
          if (event.key === "ArrowDown" && index < rows.children.length - 1) rows.insertBefore(row, rows.children[index + 1].nextSibling);
          handle.focus();
        });
        row.append(handle);
        row.addEventListener("dragover", event => {
          if (!draggedRow) return;
          event.preventDefault();
          event.stopPropagation();
          for (const sibling of rows.children) sibling.removeAttribute("data-bc-row-drop");
          if (row !== draggedRow) {
            const rect = row.getBoundingClientRect();
            row.setAttribute("data-bc-row-drop", event.clientY < (rect.top + rect.bottom) / 2 ? "before" : "after");
          }
        });
        row.addEventListener("drop", event => {
          if (!draggedRow) return;
          event.preventDefault();
          event.stopPropagation();
          if (row !== draggedRow) {
            const rect = row.getBoundingClientRect();
            rows.insertBefore(draggedRow, event.clientY < (rect.top + rect.bottom) / 2 ? row : row.nextSibling);
          }
          const focusHandle = draggedRow.querySelector('.bc-composer-shortcut-drag-handle');
          clearRowDrag();
          focusHandle?.focus();
        });
        const name = document.createElement("input");
        name.value = preset.name || "";
        name.placeholder = "例如：日常 / 深度思考";
        name.maxLength = 40;
        const model = document.createElement("select");
        const effort = document.createElement("select");
        function option(select, value, label) {
          const node = document.createElement("option");
          node.value = value;
          node.textContent = label;
          select.append(node);
        }
        for (const entry of catalog) option(model, entry.model || entry.id, entry.displayName || entry.model || entry.id);
        if (preset.model && !catalog.some(entry => (entry.model || entry.id) === preset.model)) option(model, preset.model, preset.model + "（暂不可用）");
        if (preset.model) model.value = preset.model;
        function syncEfforts(preferred) {
          effort.replaceChildren();
          const entry = catalog.find(entry => (entry.model || entry.id) === model.value);
          for (const value of effortsFor(entry)) option(effort, value, effortNames[value] || value);
          if (preferred && !effortsFor(entry).includes(preferred)) option(effort, preferred, (effortNames[preferred] || preferred) + "（暂不可用）");
          effort.value = preferred || entry?.defaultReasoningEffort || effortsFor(entry)[0] || "";
        }
        syncEfforts(preset.effort);
        model.addEventListener("change", () => syncEfforts());
        for (const [text, control] of [["名称", name], ["模型", model], ["强度", effort]]) {
          const label = document.createElement("label");
          const caption = document.createElement("span");
          caption.textContent = text;
          label.append(caption, control);
          row.append(label);
        }
        const remove = button("删除", () => row.remove());
        remove.setAttribute("aria-label", "删除快捷选项");
        row.append(remove);
        rows.append(row);
        return name;
      }
      draft.forEach(addRow);
      const add = button("新增选项", () => addRow().focus());
      const actions = document.createElement("div");
      actions.className = "bc-composer-shortcut-actions";
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "保存";
      save.className = "bc-composer-shortcut-save";
      actions.append(button("取消", closeDialog), save);
      form.append(heading, rows, add, error, actions);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const next = [...rows.children].map(row => ({ name: row.querySelector("input").value.trim(), model: row.querySelectorAll("select")[0].value, effort: row.querySelectorAll("select")[1].value }));
        if (next.some(p => !p.name || !p.model || !p.effort)) { error.textContent = "请填写名称，并选择模型和强度。"; return; }
        try { localStorage.setItem(key, JSON.stringify(next)); }
        catch { error.textContent = "保存失败，请重试。"; return; }
        presets = next;
        for (const bar of bars.values()) bar.signature = "";
        closeDialog();
        sync();
        bars.get(trigger)?.node.querySelector('[aria-label="配置模型快捷选项"]')?.focus({ preventScroll: true });
      });
      dialog.append(form);
      dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
      dialog.addEventListener("click", event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); } });
      document.body.append(dialog);
      dialog.showModal();
    }
    const style = document.createElement("style");
    style.textContent = `
      .bc-composer-shortcuts{display:flex;align-items:center;gap:2px;min-width:0;max-width:clamp(120px,34vw,480px);margin-left:2px;padding:2px 3px;box-sizing:border-box;border:1px solid rgba(120,151,195,.28);border-radius:14px;background:rgba(85,119,168,.14)}
      .bc-composer-shortcuts[hidden]{display:none}
      .bc-composer-shortcut-list{display:flex;align-items:center;gap:2px;min-width:0;overflow-x:auto;scrollbar-width:none}
      .bc-composer-shortcuts button{flex-shrink:0;border:1px solid transparent;border-radius:999px;padding:3px 6px;background:transparent;color:var(--text-tertiary,#999);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
      .bc-composer-shortcuts button:hover{background:var(--color-bg-primary-ghost-hover,rgba(128,128,128,.14))}
      .bc-composer-shortcuts button[aria-pressed="true"]{color:var(--color-text-primary,#eee);background:rgba(128,128,128,.18);border-color:rgba(128,128,128,.25)}
      .bc-composer-shortcuts .bc-composer-fast{display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0}
      .bc-composer-shortcuts .bc-composer-fast svg{width:18px;height:18px}
      .bc-composer-shortcuts .bc-composer-shortcut-settings{display:flex;align-items:center;justify-content:center;width:24px;height:26px;padding:0}
      .bc-composer-shortcuts .bc-composer-shortcut-settings svg{width:15px;height:15px}
      .bc-composer-shortcuts .bc-composer-fast[aria-pressed="true"]{color:#438cff;background:rgba(67,140,255,.12);border-color:transparent}
      .bc-composer-shortcuts button:disabled{opacity:.4;cursor:default}
      .bc-composer-shortcuts button:focus-visible{outline:2px solid #438cff;outline-offset:1px}
      .bc-composer-shortcut-list button[draggable="true"]{cursor:grab}
      .bc-composer-shortcut-list button[data-bc-dragging="true"]{opacity:.45;cursor:grabbing}
      .bc-composer-shortcut-list button[data-bc-drop="before"]{box-shadow:-2px 0 #438cff}
      .bc-composer-shortcut-list button[data-bc-drop="after"]{box-shadow:2px 0 #438cff}
      .bc-composer-shortcut-dialog{width:min(720px,calc(100vw - 32px));max-height:80vh;overflow:auto;border:1px solid rgba(128,128,128,.25);border-radius:18px;padding:24px;background:var(--color-background-elevated-primary,#282828);color:var(--color-text-primary,#eee);font:inherit;box-shadow:0 16px 64px #0006}
      .bc-composer-shortcut-dialog::backdrop{background:#0007}
      .bc-composer-shortcut-dialog h2{font-size:18px;margin:0 0 20px}
      .bc-composer-shortcut-row{display:grid;grid-template-columns:28px 1fr 1.4fr .7fr auto;gap:10px;align-items:end;margin-bottom:14px}
      .bc-composer-shortcut-dialog .bc-composer-shortcut-drag-handle{display:flex;align-items:center;justify-content:center;width:28px;height:36px;padding:0;border-color:transparent;color:var(--color-text-secondary,#aaa);cursor:grab}
      .bc-composer-shortcut-drag-handle svg{width:18px;height:18px}
      .bc-composer-shortcut-row[data-bc-row-dragging="true"]{opacity:.5}
      .bc-composer-shortcut-row[data-bc-row-drop="before"]{box-shadow:0 -2px #438cff}
      .bc-composer-shortcut-row[data-bc-row-drop="after"]{box-shadow:0 2px #438cff}
      .bc-composer-shortcut-row label{display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:0}
      .bc-composer-shortcut-row input,.bc-composer-shortcut-row select{width:100%;min-width:0;box-sizing:border-box;border:1px solid #8885;border-radius:8px;padding:8px;background:var(--color-background-primary,#202020);color:inherit;font:inherit}
      .bc-composer-shortcut-dialog button{border:1px solid #8885;border-radius:8px;padding:8px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:13px}
      .bc-composer-shortcut-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
      .bc-composer-shortcut-dialog .bc-composer-shortcut-save{background:#3478ed;color:white;border-color:transparent}
      .bc-composer-shortcut-error{color:#f88;font-size:13px}
      @media(max-width:600px){.bc-composer-shortcut-row{grid-template-columns:28px 1fr 1fr}.bc-composer-shortcut-drag-handle{grid-row:span 2}.bc-composer-shortcut-dialog{padding:16px}}
    `;
    document.head.append(style);
    function clearDrag() {
      dragging = null;
      for (const bar of bars.values()) for (const item of bar.node.querySelector('.bc-composer-shortcut-list')?.children || []) {
        item.removeAttribute("data-bc-dragging");
        item.removeAttribute("data-bc-drop");
      }
    }
    function sync() {
      for (const [trigger, bar] of bars) if (!trigger.isConnected) { bar.node.remove(); bars.delete(trigger); }
      for (const bar of bars.values()) bar.node.hidden = true;
      for (const trigger of document.querySelectorAll('[data-codex-intelligence-trigger="true"]')) {
        const surface = trigger.closest("[data-composer-surface-variant]");
        const editor = surface?.querySelector('[contenteditable="true"]');
        if (!editor || !trigger.getBoundingClientRect().width || surface.closest('[aria-hidden="true"], [inert]')) continue;
        const props = picker(trigger);
        if (!props) continue;
        const left = surface.querySelector('.bc-composer-lower-actions') || surface.querySelector('[data-composer-navigation-target="add-context"]')?.parentElement?.parentElement;
        if (!left) continue;
        let bar = bars.get(trigger);
        if (!bar || bar.node.parentElement !== left) {
          bar?.node.remove();
          const node = document.createElement("div");
          node.className = "bc-composer-shortcuts";
          node.setAttribute("role", "group");
          node.setAttribute("aria-label", "模型快捷选项");
          bar = { node, signature: "" };
          bars.set(trigger, bar);
          const addWrapper = surface.querySelector('[data-composer-navigation-target="add-context"]').parentElement;
          if (left.classList?.contains("bc-composer-lower-actions")) left.prepend(node);
          else left.insertBefore(node, addWrapper.nextSibling);
        }
        bar.node.hidden = false;
        if (dragging?.list === bar.node.querySelector('.bc-composer-shortcut-list')) continue;
        const signature = JSON.stringify([presets, props.model, props.reasoningEffort, presets.map(p => available(props, p)), trigger.disabled, props.selectedServiceTier, canToggleFast(props, trigger), fastOption(props)?.value]);
        if (bar.signature === signature) continue;
        bar.signature = signature;
        const fastHadFocus = document.activeElement === bar.node.querySelector('.bc-composer-fast');
        const fast = button("", () => {
          const current = picker(trigger);
          if (!canToggleFast(current, trigger)) return;
          const enabled = ["priority", "fast"].includes(current.selectedServiceTier);
          current.onSelectServiceTier(enabled ? null : fastOption(current).value);
          sync();
        });
        fast.className = "bc-composer-fast";
        fast.innerHTML = renderFastIcon();
        const fastEnabled = ["priority", "fast"].includes(props.selectedServiceTier);
        fast.setAttribute("aria-pressed", String(fastEnabled));
        fast.setAttribute("aria-label", fastEnabled ? "关闭加速" : "开启加速");
        fast.disabled = !canToggleFast(props, trigger);
        fast.title = fast.disabled ? "当前无法使用加速" : fastEnabled ? "关闭加速" : "开启加速";
        const list = document.createElement("div");
        list.className = "bc-composer-shortcut-list";
        for (const preset of presets) {
          const item = button(preset.name, () => {
            if (dragging || Date.now() < suppressClickUntil) return;
            const current = picker(trigger);
            if (trigger.disabled || !available(current, preset)) return;
            if (current.model !== preset.model && current.onBeforeSelectModel?.(preset.model) === false) return;
            // The native callback accepts model and effort together; do not call
            // onSelectServiceTier, nor reset the user's lightning preference.
            current.onSelectModelOption?.();
            current.onSelectModel(preset.model, preset.effort);
            sync();
          });
          item.dataset.bcModelShortcut = preset.model + ":" + preset.effort;
          item.setAttribute("aria-pressed", String(props.model === preset.model && props.reasoningEffort === preset.effort));
          item.disabled = trigger.disabled || !available(props, preset);
          item.title = preset.model + " · " + (effortNames[preset.effort] || preset.effort) + (item.disabled ? "（暂不可用）" : "");
          item.setAttribute("draggable", String(!item.disabled));
          item.addEventListener("dragstart", event => {
            if (item.disabled || !presets.includes(preset)) { event.preventDefault(); return; }
            event.stopPropagation();
            dragging = { preset, list };
            item.setAttribute("data-bc-dragging", "true");
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-better-codex-model-shortcut", "reorder");
            }
          });
          item.addEventListener("dragover", event => {
            if (dragging?.list !== list) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            for (const sibling of list.children) sibling.removeAttribute("data-bc-drop");
            if (dragging.preset !== preset) {
              const rect = item.getBoundingClientRect();
              item.setAttribute("data-bc-drop", event.clientX < rect.left + rect.width / 2 ? "before" : "after");
            }
          });
          item.addEventListener("drop", event => {
            if (dragging?.list !== list) return;
            event.preventDefault();
            event.stopPropagation();
            const moving = dragging.preset;
            const next = presets.filter(p => p !== moving);
            const target = next.indexOf(preset);
            if (moving !== preset && target >= 0 && presets.includes(moving)) {
              const rect = item.getBoundingClientRect();
              next.splice(target + (event.clientX < rect.left + rect.width / 2 ? 0 : 1), 0, moving);
              try { localStorage.setItem(key, JSON.stringify(next)); presets = next; }
              catch { item.title = "排序保存失败，请重试。"; }
            }
            suppressClickUntil = Date.now() + 300;
            clearDrag();
            sync();
          });
          item.addEventListener("dragend", event => {
            event.stopPropagation();
            suppressClickUntil = Date.now() + 300;
            clearDrag();
            sync();
          });
          list.append(item);
        }
        const settings = button("", event => configure(trigger, event.currentTarget));
        settings.className = "bc-composer-shortcut-settings";
        settings.innerHTML = renderSettingsIcon();
        settings.title = "配置模型快捷选项";
        settings.setAttribute("aria-label", "配置模型快捷选项");
        bar.node.replaceChildren(fast, list, settings);
        if (fastHadFocus) fast.focus({ preventScroll: true });
      }
    }
    const timer = setInterval(sync, 700);
    const storageChanged = event => {
      if (event.key !== key) return;
      clearDrag();
      try { const saved = JSON.parse(event.newValue); if (Array.isArray(saved)) presets = saved.filter(p => p && typeof p.name === "string" && typeof p.model === "string" && typeof p.effort === "string"); else presets = defaults; } catch { return; }
      sync();
    };
    window.addEventListener("storage", storageChanged);
    sync();
    return {
      sync,
      capture() {
        if (!dialog?.open) return null;
        const controls = [...dialog.querySelectorAll("input,select")];
        return { rows: [...dialog.querySelector(".bc-composer-shortcut-rows").children].map(row => ({
          name: row.querySelector("input").value, model: row.querySelectorAll("select")[0].value, effort: row.querySelectorAll("select")[1].value
        })), scrollTop: dialog.scrollTop, focus: controls.indexOf(document.activeElement), start: document.activeElement?.selectionStart, end: document.activeElement?.selectionEnd };
      },
      restore(saved) {
        if (!Array.isArray(saved?.rows)) return false;
        const trigger = [...bars.keys()].find(item => item.isConnected && picker(item));
        if (!trigger) return false;
        configure(trigger, bars.get(trigger)?.node.querySelector('[aria-label="配置模型快捷选项"]'), saved.rows);
        if (!dialog) return false;
        dialog.scrollTop = saved.scrollTop || 0;
        const focus = dialog.querySelectorAll("input,select")[saved.focus];
        focus?.focus({ preventScroll: true });
        if (typeof focus?.setSelectionRange === "function" && saved.start != null) focus.setSelectionRange(saved.start, saved.end);
        return true;
      },
      destroy() { clearInterval(timer); window.removeEventListener("storage", storageChanged); clearDrag(); closeDialog(); for (const bar of bars.values()) bar.node.remove(); bars.clear(); style.remove(); }
    };
  }
  function createComposerPlanToggle(renderIcon = () => "") {
    const buttons = new Map();
    function picker(editor) {
      const seen = new Set();
      let props = null, locked = false;
      for (let node = editor; node; node = node.parentElement) {
        let fiber = node[Object.keys(node).find(key => key.startsWith("__reactFiber$"))], top = fiber;
        while (top?.return) top = top.return;
        if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber?.alternate;
        for (; fiber; fiber = fiber.return) {
          if (seen.has(fiber)) continue;
          seen.add(fiber);
          const value = fiber.memoizedProps;
          if (value?.lockedCollaborationMode != null) locked = true;
          if (!props && Array.isArray(value?.collaborationModes) && typeof value.setSelectedCollaborationMode === "function") props = value;
        }
      }
      return { props, locked };
    }
    function available({ props, locked }) {
      return !!props && !locked && !props.disabled && !props.hideModeControls && !props.isThreadHistoryLoading && !props.isThreadHandoffInProgress &&
        props.collaborationModes.some(mode => mode.mode === "plan") && props.collaborationModes.some(mode => mode.mode === "default");
    }
    const style = document.createElement("style");
    style.textContent = `
      .bc-prompt-tools .bc-composer-plan{display:flex;align-items:center;justify-content:center;flex:0 0 26px;width:26px;height:26px;padding:0;border-color:transparent}
      .bc-composer-plan svg{width:18px;height:18px}
      .bc-prompt-tools .bc-composer-plan[aria-pressed="true"]{color:#438cff;background:rgba(67,140,255,.12);border-color:transparent}
    `;
    document.head.append(style);
    function sync() {
      for (const [editor, button] of buttons) if (!editor.isConnected || !button.isConnected) { button.remove(); buttons.delete(editor); }
      for (const editor of document.querySelectorAll('[data-codex-composer][contenteditable="true"]')) {
        const tools = editor.closest('[data-composer-surface-variant]')?.querySelector('.bc-prompt-tools');
        if (!tools) continue;
        let button = buttons.get(editor);
        if (!button) {
          button = document.createElement("button"); button.type = "button"; button.className = "bc-composer-plan";
          button.innerHTML = renderIcon();
          button.addEventListener("click", () => {
            const current = picker(editor);
            if (!available(current) || !editor.isConnected) return;
            current.props.setSelectedCollaborationMode(current.props.activeCollaborationMode?.mode === "plan" ? "default" : "plan");
            sync();
          });
          buttons.set(editor, button);
        }
        if (button.parentElement !== tools) tools.insertBefore(button, tools.firstChild);
        const current = picker(editor), enabled = current.props?.activeCollaborationMode?.mode === "plan";
        button.disabled = !available(current);
        const label = enabled ? "关闭计划模式" : "开启计划模式";
        if (button.getAttribute("aria-pressed") !== String(enabled)) button.setAttribute("aria-pressed", String(enabled));
        if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
        button.title = button.disabled ? "当前无法切换计划模式" : label;
      }
    }
    const timer = setInterval(sync, 600);
    return { sync, destroy() { clearInterval(timer); for (const button of buttons.values()) button.remove(); buttons.clear(); style.remove(); } };
  }
  function createComposerFooterLayout() {
    const footers = new Set();
    const style = document.createElement("style");
    style.textContent = `
      [data-bc-composer-rows]{container:bc-composer-actions / inline-size;grid-template-columns:minmax(0,1fr) 0 auto!important;grid-template-rows:auto auto auto!important;row-gap:6px!important}
      [data-bc-composer-input]{grid-column:1 / -1!important;grid-row:1!important;min-width:0}
      [data-bc-composer-leading]{grid-column:1 / -1!important;grid-row:2!important;min-width:0}
      [data-bc-composer-trailing]{grid-column:3!important;grid-row:3!important;align-self:end;min-width:0}
      .bc-composer-lower-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;grid-column:1 / 3;grid-row:3}
      .bc-composer-lower-actions .bc-composer-shortcuts{max-width:min(480px,100%);margin-left:0;box-sizing:border-box}
      .bc-composer-lower-actions .bc-prompt-tools{flex-wrap:wrap;max-width:100%}
      .bc-composer-lower-actions .bc-prompt-status{overflow-wrap:anywhere}
      @container bc-composer-actions (max-width:440px){
        .bc-composer-lower-actions{grid-column:1 / -1}
        [data-bc-composer-trailing]{grid-column:1 / -1!important;grid-row:4!important;justify-self:end}
      }
    `;
    document.head.append(style);
    function cleanup(footer) {
      footer.removeAttribute("data-bc-composer-rows");
      for (const child of footer.children) for (const name of ["input", "leading", "trailing"]) child.removeAttribute("data-bc-composer-" + name);
      footer.querySelector('.bc-composer-lower-actions')?.remove();
    }
    function sync() {
      for (const footer of footers) if (!footer.isConnected) { cleanup(footer); footers.delete(footer); }
      for (const surface of document.querySelectorAll('[data-composer-surface-variant]')) {
        const footer = surface.querySelector('[data-composer-footer-responsive]');
        if (!footer) continue;
        const children = [...footer.children];
        const input = children.find(child => child.querySelector('[data-codex-composer]'));
        const leading = children.find(child => child.querySelector('[data-composer-navigation-target="add-context"]'));
        const trailing = children.find(child => child.querySelector('[data-codex-intelligence-trigger="true"]'));
        if (!input || !leading || !trailing || leading === trailing) continue;
        if (!footer.hasAttribute("data-bc-composer-rows")) footer.setAttribute("data-bc-composer-rows", "true");
        for (const [child, name] of [[input, "input"], [leading, "leading"], [trailing, "trailing"]]) if (!child.hasAttribute("data-bc-composer-" + name)) child.setAttribute("data-bc-composer-" + name, "true");
        if (!footer.querySelector('.bc-composer-lower-actions')) {
          const row = document.createElement("div"); row.className = "bc-composer-lower-actions"; row.setAttribute("data-better-codex-owned", "true"); footer.append(row);
        }
        footers.add(footer);
      }
    }
    return { sync, destroy() { for (const footer of footers) cleanup(footer); footers.clear(); style.remove(); } };
  }
  function install(config) {
    if (isAuxiliaryDesktopUrl(window.location.href)) {
      window.__betterCodexInjection__?.destroy?.();
      return { installed: false, reason: "auxiliary_desktop_window" };
    }
    if (!config || config.schemaVersion !== 1) throw new Error("injected_ui_schema_mismatch");
    const previous = window.__betterCodexInjection__;
    if (previous?.version === config.version && previous?.endpoint === config.baseUrl && previous?.profile === config.profile && previous?.bundleChecksum === config.bundleChecksum && typeof previous.pulse === "function") {
      previous.refresh();
      return { installed: true, reused: true };
    }
    previous?.destroy?.();
    const requests = new Map();
    let destroyed = false, observer = null, shortcuts = null, accountAdapter = null, optimizer = null, composerLayout = null, planToggle = null, workflowPanel = null;
    let sequence = 0, refreshTimer = null, usageTimer = null, usagePending = false, accountCheckedAt = 0;
    const locale = config.initialLocale || "zh-CN";
    const english = locale.startsWith("en");
    const labels = { "已归档聊天": "Archived chats", "用量加载中…": "Loading usage…", "用量暂不可用": "Usage unavailable", "点击刷新用量": "Click to refresh usage", "剩余": "Remaining", "重置时间": "Resets", "每周": "Weekly", "天": " days", "小时": " hours", "分钟": " minutes" };
    const text = value => english ? labels[value] || value : value;
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
    // These paths and nodes come from the existing Lucide icon catalog.
    function icon(name, strokeWidth) {
      const definition = config.lucideIcons?.[name];
      if (!definition) return "";
      return '<svg class="lucide lucide-' + escape(definition.name) + '" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="' + escape(strokeWidth) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + definition.nodes + '</svg>';
    }
    function api(path, options = {}) {
      if (destroyed) return Promise.reject(new Error("injection_destroyed"));
      const parameters = { path: path + (path.includes("?") ? "&" : "?") + "locale=" + encodeURIComponent(locale), method: options.method || "GET", body: options.body, timeoutMs: options.timeoutMs };
      if (typeof window.betterCodexHost?.request === "function") return Promise.resolve(window.betterCodexHost.request(parameters));
      if (typeof window.betterCodexRequest !== "function") return Promise.reject(new Error("runtime_bridge_unavailable"));
      const id = config.version + ":" + ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error("runtime_bridge_timeout")); }, Number(options.timeoutMs) || 10000);
        requests.set(id, { resolve, reject, timer });
        try { window.betterCodexRequest(JSON.stringify({ id, token: config.bridgeToken, ...parameters })); }
        catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
      });
    }
    const resolveBridge = (id, result) => {
      const pending = requests.get(id);
      if (!pending) return;
      requests.delete(id); clearTimeout(pending.timer);
      if (result?.ok) pending.resolve(result.value);
      else pending.reject(Object.assign(new Error(result?.value?.message || result?.value?.error || "request_failed"), { code: result?.value?.error }));
    };
    window.__betterCodexBridgeResolve = resolveBridge;
    function navigate(path) {
      window.postMessage({ type: config.navigation?.messageType || "navigate-to-route", path }, window.location.origin);
    }
    function ensureTitlebarActions() {
      const help = document.getElementById("application-menu-trigger-help-menu");
      if (!help) return;
      let group = document.getElementById("better-codex-titlebar-actions");
      if (!group) {
        group = document.createElement("div");
        group.id = "better-codex-titlebar-actions";
        group.className = "no-drag";
        group.setAttribute("data-better-codex-owned", "true");
        group.style.cssText = "display:flex;align-items:center;gap:8px;white-space:nowrap;-webkit-app-region:no-drag";
        const panel = document.createElement("button");
        panel.type = "button"; panel.className = help.className; panel.textContent = "面板";
        panel.dataset.workflowPanel = "true";
        panel.addEventListener("click", async () => {
          panel.disabled = true;
          try { await workflowPanel?.open(); } finally { panel.disabled = false; }
        });
        const archive = document.createElement("button");
        archive.type = "button"; archive.className = help.className;
        archive.textContent = text("已归档聊天");
        archive.addEventListener("click", () => navigate("/archive"));
        const usage = document.createElement("button");
        usage.type = "button"; usage.className = help.className;
        usage.dataset.titlebarUsage = "true"; usage.textContent = text("用量加载中…");
        usage.addEventListener("click", () => void refreshTitlebarUsage());
        const settings = document.createElement("button");
        settings.type = "button"; settings.className = help.className;
        settings.textContent = "提示词优化设置";
        settings.addEventListener("click", () => void optimizer?.configure(settings));
        group.append(panel, settings, archive, usage);
        void refreshTitlebarUsage(group);
      }
      if (help.nextElementSibling !== group) help.after(group);
    }
    async function refreshTitlebarUsage(root = document.getElementById("better-codex-titlebar-actions")) {
      if (destroyed || usagePending || !root) return;
      const output = root.querySelector("[data-titlebar-usage]");
      if (!output) return;
      usagePending = true;
      try {
        const result = await api("/api/account/usage");
        if (destroyed) return;
        const windows = [result.usage?.primary, result.usage?.secondary].filter(item => item && Number.isFinite(item.remainingPercent) && Number.isFinite(item.windowDurationMins));
        const remaining = windows.map(item => {
          const mins = item.windowDurationMins;
          const period = mins === 10080 ? text("每周") : mins % 1440 === 0 ? mins / 1440 + text("天") : mins % 60 === 0 ? mins / 60 + text("小时") : mins + text("分钟");
          return period + " " + Math.max(0, Math.min(100, item.remainingPercent)) + "%";
        });
        output.textContent = remaining.length ? text("剩余") + "：" + remaining.join(" · ") : text("用量暂不可用");
        output.title = windows.filter(item => Number.isFinite(item.resetsAt)).map(item => text("重置时间") + "：" + new Date(item.resetsAt * 1000).toLocaleString()).join("\n") || text("点击刷新用量");
      } catch {
        if (!destroyed) { output.textContent = text("用量暂不可用"); output.title = text("点击刷新用量"); }
      } finally { usagePending = false; }
    }
    function refresh() {
      if (destroyed) return;
      ensureTitlebarActions();
      composerLayout?.sync();
      shortcuts?.sync();
      optimizer?.sync();
      planToggle?.sync();
      if (accountAdapter && !window.__betterCodexAccountTransportRecovery__?.request && Date.now() - accountCheckedAt > 10000) {
        accountCheckedAt = Date.now();
        void accountAdapter.connect().catch(() => {});
      }
    }
    function scheduleRefresh() {
      if (destroyed || refreshTimer !== null) return;
      refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 50);
    }
    function destroy() {
      if (destroyed) return;
      accountAdapter?.destroy();
      destroyed = true;
      observer?.disconnect(); shortcuts?.destroy(); planToggle?.destroy(); optimizer?.destroy(); composerLayout?.destroy();
      clearTimeout(refreshTimer); clearInterval(usageTimer);
      document.removeEventListener("DOMContentLoaded", mount);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      document.getElementById("better-codex-titlebar-actions")?.remove();
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("injection_destroyed")); }
      requests.clear();
      workflowPanel?.destroy();
      if (window.__betterCodexBridgeResolve === resolveBridge) delete window.__betterCodexBridgeResolve;
      if (window.__betterCodexInjection__ === controller) delete window.__betterCodexInjection__;
    }
    function onVisible() { if (!document.hidden) { refresh(); void refreshTitlebarUsage(); } }
    function onOnline() { refresh(); void refreshTitlebarUsage(); }
    function mount() {
      document.removeEventListener("DOMContentLoaded", mount);
      if (destroyed || observer || !document.documentElement) return;
      composerLayout = createComposerFooterLayout(); composerLayout.sync();
      shortcuts = createComposerModelShortcuts(() => icon("fast", "2"), () => icon("settings", "1.8"), () => icon("grip", "1.8"));
      optimizer = window.BetterCodexPromptOptimizer?.create({ api });
      workflowPanel = window.BetterCodexWorkflowPanel?.create({
        getPanelUrl: () => api("/api/dev/workflow/panel-url", { method: "POST", body: "{}", timeoutMs: 45000 }),
        reportError: error => { const button = document.querySelector('[data-workflow-panel]'); if (button) button.title = error.message; }
      });
      planToggle = createComposerPlanToggle(() => icon("plan", "1.8"));
      if (typeof window.BetterCodexNativeConversation?.create === "function") accountAdapter = window.BetterCodexNativeConversation.create({ api });
      observer = new MutationObserver(scheduleRefresh);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme", "aria-current"] });
      usageTimer = setInterval(() => { if (!document.hidden) { refresh(); void refreshTitlebarUsage(); } }, 60000);
      refresh();
    }
    const controller = {
      version: config.version, bundleChecksum: config.bundleChecksum, profile: config.profile, host: "codex", endpoint: config.baseUrl,
      refresh, pulse: () => !destroyed, ready: () => !destroyed && !!shortcuts, bootstrapError: () => "",
      open: () => refresh(), openThread: threadId => navigate((config.navigation?.threadRoutePrefix || "/local/") + encodeURIComponent(threadId)), close: () => {}, destroy,
      openPanel: () => workflowPanel?.open(), hidePanel: () => workflowPanel?.hide(),
      captureReloadState: () => ({ shortcutConfiguration: shortcuts?.capture() || null, workflowPanel: workflowPanel?.capture() || null }),
      restoreReloadState: async saved => { refresh(); shortcuts?.restore(saved?.shortcutConfiguration); if (saved?.workflowPanel?.open) await workflowPanel?.open(); return { error: "" }; }
    };
    window.__betterCodexInjection__ = controller;
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    if (document.documentElement) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
    return { installed: true, reused: false };
  }
  return { install };
})();

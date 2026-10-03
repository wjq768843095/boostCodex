"use strict";
// This adapter keeps the native composer and message renderer in their owning
// React tree. It only coordinates native IPC and trusted project bindings.
(function installNativeConversationAdapter(root) {
  const HUB_KEY = "__betterCodexNativeConversationHub__";
  const DRAFT_KEY = "better-codex-native-drafts-v1";
  const DRAFT_STATE_KEY = "__betterCodexNativeDraftState__";
  const PREFIX = "better_codex_";
  const API_ROOT = "/api/native-conversations/";
  const LOCAL = "local";
  const toolNames = new Set([
    "better_codex_project_context_read", "better_codex_project_charter_save",
    "better_codex_project_charter_confirm", "better_codex_project_plan_save",
    "better_codex_project_plan_convert"
  ]);
  const normalizePath = value => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  const conversationId = context => context.kind === "work" ? "" : context.conversation_id || "";
  const conversationFields = context => conversationId(context) ? { conversation_id: conversationId(context) } : {};
  const targetIdentity = context => ({ project_id: context.project_id, kind: context.kind, ...(context.issue_id ? { issue_id: context.issue_id } : {}), ...conversationFields(context) });
  const targetKey = context => [context.project_id, context.kind, context.issue_id || ""].join(":") + (conversationId(context) ? ":conversation:" + encodeURIComponent(conversationId(context)) : "");
  const threadKey = (host, thread) => [host || LOCAL, thread].join(":");
  const requestKey = (host, id) => JSON.stringify([host || LOCAL, id]);
  const messageId = value => value?.message?.id ?? value?.response?.id;
  const messageBody = value => value?.message || value?.response;
  const errorText = error => String(error?.message || error || "原生会话暂时无法打开");
  const uuid = () => root.crypto.randomUUID();

  function flattenContext(value) {
    const context = { ...(value?.context || {}), ...(value?.target || {}), ...(value || {}) };
    delete context.context;
    context.kind = context.kind || context.session_kind;
    context.project_id = context.project_id || context.binding?.project_id || context.project?.id;
    context.issue_id = context.issue_id || context.binding?.issue_id;
    context.conversation_id = context.kind === "work" ? undefined : context.conversation_id || context.binding?.conversation_id || value?.target?.conversation_id || undefined;
    context.thread_id = context.thread_id || context.binding?.thread_id || "";
    context.host_id = context.host_id || LOCAL;
    context.cwd = context.cwd || context.workspace_path || "";
    context.root_paths = Array.isArray(context.root_paths) && context.root_paths.length ? context.root_paths : [context.cwd].filter(Boolean);
    context.mode = context.mode || (context.thread_id ? "thread" : "draft");
    return context;
  }

  function assertReturnedTarget(expected, returned) {
    if (!returned) return;
    for (const key of ["project_id", "kind", "issue_id", "host_id", ...(expected.thread_id ? ["thread_id"] : [])]) if (returned[key] !== undefined && String(returned[key] || "") !== String(expected[key] || "")) throw Error("会话资料已更新，请重新打开会话");
    if (conversationId(expected) && returned.conversation_id !== undefined && returned.conversation_id !== conversationId(expected)) throw Error("会话资料已更新，请重新打开会话");
  }

  function responseError(request, message, code = -32000) {
    return {
      type: "mcp-response", hostId: request.hostId || LOCAL,
      message: { id: request.request.id, error: { code, message } }
    };
  }

  function toolsForThread(context, existing) {
    const supplied = context.dynamic_tools || [];
    if (!Array.isArray(supplied) || supplied.length !== toolNames.size) throw Error("项目资料工具暂时不可用");
    const names = new Set();
    for (const tool of supplied) {
      if (!toolNames.has(tool.name) || names.has(tool.name) || !tool.inputSchema || typeof tool.description !== "string") throw Error("项目资料工具暂时不可用");
      names.add(tool.name);
    }
    const native = Array.isArray(existing) ? existing : [];
    if (native.some(tool => names.has(tool?.name))) throw Error("项目资料工具名称重复");
    return [...native, ...supplied];
  }

  function ownDataFunction(value, name) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor && "value" in descriptor && typeof descriptor.value === "function" && descriptor.writable === true;
    } catch { return false; }
  }

  function nativeDispatcher(value) {
    try {
      const handlers = Object.getOwnPropertyDescriptor(value, "handlers");
      const buffered = Object.getOwnPropertyDescriptor(value, "bufferedMessages");
      if (!handlers || !(handlers.value instanceof Map) || !buffered || !(buffered.value instanceof Map)) return false;
      let prototype = value;
      while (prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "deliverOrBufferMessage");
        if (descriptor) return typeof descriptor.value === "function" && descriptor.writable === true && typeof value.dispatchHostMessage === "function";
        prototype = Object.getPrototypeOf(prototype);
      }
    } catch { /* Remote RPC stubs are not locally mutable host objects. */ }
    return false;
  }

  function visibleNativeElement(element) {
    if (!element?.isConnected || !(element.getBoundingClientRect?.().width > 0)) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent.hidden || parent.getAttribute?.("aria-hidden") === "true" || parent.inert && !parent.hasAttribute?.("data-better-codex-inline-blocked")) return false;
      const style = root.getComputedStyle?.(parent);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    }
    return true;
  }

  function findNativeValue(predicate, selector = '[contenteditable]', anchor) {
    const seen = new Set();
    for (const element of anchor ? [anchor] : root.document.querySelectorAll(selector)) {
      if (!visibleNativeElement(element)) continue;
      let parent = element;
      while (parent) {
        const key = Object.keys(parent).find(name => name.startsWith("__reactFiber$"));
        let fiber = key ? parent[key] : null;
        while (fiber && !seen.has(fiber)) {
          seen.add(fiber);
          const props = fiber.memoizedProps;
          for (const value of [props?.composerController, props?.homeComposerController, props?.controller, props?.value]) if (value && predicate(value)) return value;
          let hook = fiber.memoizedState;
          let limit = 0;
          while (hook && typeof hook === "object" && limit++ < 128) {
            const scope = hook.memoizedState?.current;
            if (scope && predicate(scope)) return scope;
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        parent = parent.parentElement;
      }
    }
    return null;
  }

  const findNativeScope = (predicate, selector, anchor) => findNativeValue(value => value.scope && typeof value.get === "function" && typeof value.set === "function" && predicate(value), selector, anchor);

  function nativeDraftAccess(namespace, composer) {
    // Source-managed capability profile for the installed native scope runtime.
    // Each role is verified; a changed host fails closed instead of navigating
    // to an unregistered worktree draft and leaving a permanently busy composer.
    const descriptor = namespace.GJt;
    const identity = namespace.Pyt;
    const location = namespace.hbt;
    const project = namespace.ZTt;
    if (!descriptor?.__scopeBrand || identity?.scope !== descriptor || typeof location !== "function" || !project?.resolve || !composer?.VIn?.__scopeBrand || composer.KZt?.scope !== composer.VIn || composer.DQt?.scope !== composer.VIn || composer._Qt?.scope !== composer.VIn || !["XQt", "o$t", "ZQt", "FZt"].every(name => typeof composer[name] === "function")) return null;
    const draftLocation = location({ entrypoint: "home" });
    if (draftLocation !== "new-conversation") return null;
    const getParts = () => {
      for (const editor of root.document.querySelectorAll('[contenteditable]')) {
        if (!visibleNativeElement(editor)) continue;
        const controller = findNativeValue(value => {
          const view = Object.getOwnPropertyDescriptor(value, "view")?.value;
          return view?.dom === editor && !!view.state?.schema && typeof value.restoreDraft === "function";
        }, undefined, editor);
        if (!controller) continue;
        const nativeRoot = findNativeScope(scope => scope.scope === descriptor, undefined, editor);
        const route = findNativeScope(scope => typeof scope.value?.routeKind === "string", undefined, editor);
        const nativeComposer = findNativeScope(scope => scope.scope === composer.VIn, undefined, editor);
        if (nativeRoot && route && nativeComposer) return { editor, controller, nativeRoot, route, nativeComposer };
      }
      return null;
    };
    const getScope = () => {
      const scope = getParts()?.nativeRoot;
      if (!scope || !/^client-new-thread:[a-z0-9-]+$/i.test(scope.get(identity, draftLocation) || "")) throw Error("当前 Codex 暂时不支持页内会话");
      return scope;
    };
    const getHomeParts = () => {
      const parts = getParts();
      if (!parts || parts.nativeComposer.value?.kind !== "new" || parts.nativeComposer.value?.entrypoint !== "home") throw Error("原生输入框尚未就绪，请重新打开会话");
      return parts;
    };
    return {
      inspectLayout(context) {
        const parts = getParts();
        if (parts) {
          // These are all discovered from the same native editor ancestry. A
          // layout can hide navigation/header siblings while retaining the
          // native providers and controller in their original React subtree.
          const { nativeRoot, route, nativeComposer } = parts;
          const consistent = true;
          const matches = consistent && (!context ? true : context.thread_id ? route.value.routeKind === "local-thread" && route.value.conversationId === context.thread_id : route.value.routeKind === "home" && route.value.projectContext?.projectId === context.native_project_id && nativeRoot.get(identity, draftLocation) === context.client_draft_id && nativeComposer.value.focusComposerNonce === context.client_draft_id);
          return { available: consistent, composer_visible: true, ancestry_consistent: consistent, route_kind: route?.value.routeKind || null, context_matches: matches };
        }
        return { available: false, composer_visible: [...root.document.querySelectorAll('[contenteditable]')].some(visibleNativeElement), ancestry_consistent: false, route_kind: null, context_matches: false };
      },
      readDraft() { return getScope().get(identity, draftLocation); },
      isHomeComposer() { try { return !!getHomeParts(); } catch { return false; } },
      isSelectedDraft(id, context) {
        try { const parts = getHomeParts(); return parts.nativeRoot.get(identity, draftLocation) === id && parts.nativeComposer.value.focusComposerNonce === id && parts.route.value?.routeKind === "home" && parts.route.value.projectContext?.projectId === context.native_project_id; }
        catch { return false; }
      },
      async waitForProject(context, current) {
        for (let index = 0; index < 100; index++) {
          if (!current()) return false;
          const route = getParts()?.route;
          if (route?.value?.routeKind === "home" && route.value.projectContext?.projectId === context.native_project_id) return true;
          await new Promise(resolve => root.setTimeout(resolve, 30));
        }
        throw Error("原生项目尚未就绪，请重新打开会话");
      },
      selectDraft(id, context) {
        if (!/^client-new-thread:[a-z0-9-]+$/i.test(id || "")) throw Error("会话草稿资料已更新");
        const parts = getParts();
        const scope = getScope();
        if (context && (parts?.route.value?.routeKind !== "home" || parts.route.value.projectContext?.projectId !== context.native_project_id)) throw Error("原生项目尚未就绪，请重新打开会话");
        scope.set(identity, draftLocation, id);
        if (scope.get(identity, draftLocation) !== id) throw Error("会话草稿暂时无法恢复");
      },
      captureDraft() {
        const { nativeComposer: scope, controller } = getHomeParts();
        const { prompt, ...viewState } = scope.get(composer.DQt);
        return { draft: scope.get(composer.KZt), view_state: viewState, document_json: controller.view.state.doc.toJSON(), plain_text_mode: controller.plainTextMode };
      },
      restoreDraft(snapshot) {
        const { nativeComposer: scope, controller } = getHomeParts();
        // Native setters preserve all business fields, Skill mentions, image
        // order and attachment ownership. Native's own controller hydrates the
        // original rich document; input is never read from or rebuilt via DOM.
        if (snapshot) {
          composer.XQt(scope, snapshot.draft, undefined, { discardRetainedDraft: true });
          composer["o$t"](scope, value => Object.assign(value, snapshot.view_state));
        } else composer.FZt(scope);
        const retained = snapshot?.document_json ? { document: controller.view.state.schema.nodeFromJSON(snapshot.document_json), plainTextMode: snapshot.plain_text_mode } : undefined;
        composer.ZQt(scope, retained);
        controller.restoreDraft(scope.get(composer.DQt).prompt, retained);
        // Native's change subscription may update its serialized prompt. Keep
        // the retained rich document paired with that native representation.
        composer.ZQt(scope, retained);
      }
    };
  }

  async function loadInstalledHost() {
    const scripts = [...root.document.querySelectorAll('script[type="module"][src]')];
    for (const script of scripts) {
      const entry = new URL(script.src, root.location.href);
      if (entry.origin !== root.location.origin) continue;
      const source = await (await root.fetch(entry.href)).text();
      const sharedName = /["'`]([^"'`]*app-shared-[^"'`]+\.js)["'`]/.exec(source)?.[1];
      if (!sharedName) continue;
      const moduleUrl = new URL(sharedName, entry);
      if (moduleUrl.origin !== entry.origin) continue;
      const sharedSource = await (await root.fetch(moduleUrl.href)).text();
      const namespace = await import(moduleUrl.href);
      const initialName = /["'`]([^"'`]*app-initial-[^"'`]+\.js)["'`]/.exec(source)?.[1];
      const composer = initialName ? await import(new URL(initialName, entry).href) : null;
      const values = Object.values(namespace);
      // RPC proxies fabricate methods on property access. Require real writable
      // own data properties instead of accidentally wrapping a remote stub.
      const sender = values.find(value => value && ownDataFunction(value, "postMessage") && ownDataFunction(value, "getState") && ownDataFunction(value, "setState"));
      const dispatcher = values.find(value => value && nativeDispatcher(value));
      if (!sender || !dispatcher) continue;
      const draftAccess = nativeDraftAccess(namespace, composer);
      return {
        sender, dispatcher, moduleUrl: moduleUrl.href,
        dynamicTools: sharedSource.includes("dynamic-tool-call-requested"),
        prewarm: sharedSource.includes("thread-prewarm-start"),
        draftIdentity: !!draftAccess, ...draftAccess
      };
    }
    throw Error("当前 Codex 暂时不支持页内会话");
  }

  function readDraftIds(storage) {
    try {
      const value = JSON.parse(storage?.getItem(DRAFT_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function nativeDraftStorage() {
    const state = root[DRAFT_STATE_KEY] || (root[DRAFT_STATE_KEY] = { records: new Map(), pending: new Map(), database: null });
    async function database() {
      if (!root.indexedDB) throw Error("会话草稿暂时无法保存");
      if (!state.database) state.database = new Promise((resolve, reject) => {
        const request = root.indexedDB.open("better-codex-native-drafts", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("drafts");
        request.onerror = () => reject(request.error || Error("会话草稿暂时无法保存"));
        request.onsuccess = () => resolve(request.result);
      }).catch(error => { state.database = null; throw error; });
      return state.database;
    }
    async function transaction(id, value, write) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("drafts", write ? "readwrite" : "readonly");
        const request = write ? tx.objectStore("drafts").put(value, id) : tx.objectStore("drafts").get(id);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || Error("会话草稿暂时无法保存"));
      });
    }
    return {
      async get(id) {
        if (state.records.has(id)) return state.records.get(id);
        const value = await transaction(id, undefined, false);
        if (value !== undefined) state.records.set(id, value);
        return value;
      },
      set(id, value) {
        // IndexedDB's structured clone preserves native File/Blob attachments.
        // Unsupported objects fail the transaction; the exact in-memory draft
        // remains available and the caller reports persistence failure.
        state.records.set(id, value);
        const prior = state.pending.get(id) || Promise.resolve();
        const work = prior.catch(() => {}).then(() => transaction(id, value, true));
        state.pending.set(id, work);
        work.finally(() => { if (state.pending.get(id) === work) state.pending.delete(id); }).catch(() => {});
        return work;
      }
    };
  }

  function createHub(host, previous) {
    const hub = previous || {
      host, clients: new Set(), threads: new Map(), requests: new Map(), calls: new Map(), pending: 0,
      originalSend: host.sender.postMessage, originalDeliver: host.dispatcher.deliverOrBufferMessage,
      released: false,
      latestClient() { return [...this.clients].reverse().find(client => !client.disposed) || null; },
      activeClient() { return [...this.clients].reverse().find(client => client.ownsCurrentDraft()) || null; },
      send(message) { return Reflect.apply(this.originalSend, this.host.sender, [message]); },
      deliver(message) { return Reflect.apply(this.originalDeliver, this.host.dispatcher, [message]); },
      release() {
        if (this.clients.size || this.pending || this.requests.size) return;
        if (this.host.sender.postMessage === this.sendWrapper) this.host.sender.postMessage = this.originalSend;
        if (this.host.dispatcher.deliverOrBufferMessage === this.deliverWrapper) this.host.dispatcher.deliverOrBufferMessage = this.originalDeliver;
        this.released = true;
        if (root[HUB_KEY] === this) delete root[HUB_KEY];
      },
      run(promise) {
        this.pending++;
        Promise.resolve(promise).catch(error => this.latestClient()?.report(error)).finally(() => { this.pending--; this.release(); });
      }
    };
    // Reload upgrades the function bodies in place, keeping the original native
    // methods and shared request/promise ownership. Never wrap an older wrapper
    // as if it were the original host sender.
    hub.host = host;
    hub.factory = createHub;

    hub.sendWrapper = function wrappedNativeSend(message) {
      const client = hub.activeClient();
      const request = message?.request;
      const method = request?.method;
      const blocked = hub.latestClient();
      if (message.source !== "better-codex" && message?.type === "mcp-request" && ["thread/start", "turn/start"].includes(method) && blocked?.blocksNativeInput() && (message.hostId || LOCAL) === blocked.current.host_id && !hub.threads.get(threadKey(message.hostId, request.params?.threadId))?.awaitingFirstTurn) {
        hub.deliver(responseError(message, "当前项目会话尚未就绪，请重新打开会话"));
        return;
      }
      if (client && message.source !== "better-codex" && message?.type === "thread-prewarm-start" && request?.method === "thread/start" && (message.hostId || LOCAL) === client.current.host_id && (client.isNavigating() || client.ownsNativeDraft() && client.matchesWorkspace(message))) {
        // Native prewarming catches this error and drops only this reservation.
        // Existing warm threads and other native projects remain untouched.
        hub.deliver(responseError(message, "当前项目会话在发送后创建", -32001));
        return;
      }
      if (client && message.source !== "better-codex" && message?.type === "mcp-request" && method === "thread/start" && (message.hostId || LOCAL) === client.current.host_id && !request.params?.ephemeral && request.params?.threadSource !== "mcp_extension_host") {
        if (!client.ownsNativeDraft() || !client.matchesWorkspace(message)) {
          hub.deliver(responseError(message, "当前项目会话尚未就绪，请重新打开会话"));
          client.report(Error("当前项目会话尚未就绪，请重新打开会话"));
        } else hub.run(client.beginThread(message));
        return;
      }
      if (message?.type === "mcp-request" && method === "turn/start") {
        const scope = hub.threads.get(threadKey(message.hostId, request.params?.threadId));
        if (client && !client.current.thread_id && !scope) {
          // A native warm reservation must never become a Better Codex binding.
          hub.deliver(responseError(message, "当前会话尚未绑定，请重新发送"));
          client.report(Error("当前会话尚未绑定，请重新发送"));
          return;
        }
        if (scope && message.source !== "better-codex") { hub.run(beginTurn(hub, scope, message)); return; }
      }
      return hub.send(message);
    };

    hub.deliverWrapper = function wrappedNativeDeliver(message) {
      if (message?.type === "new-chat" || message?.type === "navigate-to-route") {
        for (const client of hub.clients) {
          if (!client.current || client.isNavigating()) continue;
          if (message.type === "new-chat" || !client.ownsRoute(message.path)) {
            const origin = { ...client.current };
            client.leave();
            client.options.onNavigateAway?.(origin);
          }
        }
      }
      if (message?.type === "dynamic-tool-call-requested") {
        const request = message.serverRequest;
        const params = request?.params;
        const name = params?.tool || params?.name;
        if (typeof name === "string" && name.startsWith(PREFIX)) {
          hub.run(handleTool(hub, message));
          return;
        }
      }
      if (message?.type === "mcp-response") {
        const key = requestKey(message.hostId, messageId(message));
        const pending = hub.requests.get(key);
        if (pending) {
          hub.requests.delete(key);
          if (pending.timer) root.clearTimeout(pending.timer);
          if (pending.type === "start") {
            hub.run(pending.client.acceptThread(pending, message));
            return;
          }
          if (pending.type === "turn") {
            hub.run(acceptTurn(hub, pending, message));
            return;
          }
        }
      }
      return hub.deliver(message);
    };
    host.sender.postMessage = hub.sendWrapper;
    host.dispatcher.deliverOrBufferMessage = hub.deliverWrapper;
    root[HUB_KEY] = hub;
    return hub;
  }

  async function post(scope, endpoint, data) {
    const client = scope.hub.latestClient() || scope.client;
    const relayId = client.options.getRelayId?.() || scope.context.relay_id;
    if (!relayId) throw Error("本地连接尚未就绪");
    return client.options.api(API_ROOT + endpoint, {
      method: "POST", body: JSON.stringify({ ...data, relay_id: relayId })
    });
  }

  function operationIdentity(scope) {
    return {
      ...targetIdentity(scope.context),
      host_id: scope.context.host_id, request_id: scope.operation.request_id,
      expected_revision: scope.operation.expected_revision ?? scope.context.expected_revision
    };
  }

  async function receipt(scope, status, values = {}) {
    if (!scope.operation) return;
    return post(scope, "receipt", { ...operationIdentity(scope), thread_id: scope.context.thread_id || undefined, status, ...values });
  }

  async function beginTurn(hub, threadScope, message) {
    const key = requestKey(message.hostId, message.request.id);
    if (hub.requests.has(key)) return;
    const scope = { ...threadScope, context: { ...threadScope.context }, operation: threadScope.awaitingFirstTurn ? threadScope.operation : null };
    const pending = { type: "turn", scope, message };
    hub.requests.set(key, pending);
    try {
      if (!scope.operation) {
        const client = hub.latestClient() || scope.client;
        const target = scope.context;
        const query = new URLSearchParams({ project_id: target.project_id, kind: target.kind, relay_id: client.options.getRelayId?.() || target.relay_id, host_id: target.host_id });
        if (target.issue_id) query.set("issue_id", target.issue_id);
        if (conversationId(target)) query.set("conversation_id", conversationId(target));
        const latest = await client.options.api(API_ROOT + "context?" + query);
        assertReturnedTarget(target, latest); assertReturnedTarget(target, latest?.target);
        const context = flattenContext({ ...target, ...latest });
        assertReturnedTarget(target, context);
        if (conversationId(target) && conversationId(context) !== conversationId(target)) throw Error("会话资料已更新，请重新打开会话");
        if (context.thread_id !== message.request.params.threadId || context.mode !== "thread") throw Error("当前任务仍在运行，请稍后再发送");
        scope.context = context;
        const prepared = await post(scope, "prepare", {
          ...targetIdentity(context),
          host_id: context.host_id, request_id: uuid(), expected_revision: context.expected_revision,
          draft_generation: context.draft_generation
        });
        scope.operation = prepared.operation;
        assertReturnedTarget(context, scope.operation);
        assertReturnedTarget(context, prepared.target);
        if (scope.operation?.thread_id !== context.thread_id) throw Error("会话资料已更新，请重新打开会话");
        const identity = { ...operationIdentity(scope), thread_id: context.thread_id };
        const allocated = await post(scope, "bind", { ...identity, checkpoint: "allocated" });
        assertReturnedTarget(context, allocated.binding); assertReturnedTarget(context, allocated.operation);
        const bound = await post(scope, "bind", { ...identity, checkpoint: "bound" });
        assertReturnedTarget(context, bound.binding); assertReturnedTarget(context, bound.operation);
      }
      threadScope.awaitingFirstTurn = false;
      pending.timer = root.setTimeout(() => {
        if (hub.requests.get(key) !== pending) return;
        hub.run(receipt(scope, "outcome_unknown", { error: "发送结果尚待核对" }));
        (hub.latestClient() || scope.client).report(Error("发送结果尚待核对"), scope.context);
      }, Math.max(15_000, Math.min(message.timeoutMs || 60_000, 120_000)) + 1_000);
      hub.send(message);
    } catch (error) {
      hub.requests.delete(key);
      if (scope.operation) try { await receipt(scope, "failed", { error: errorText(error) }); } catch { /* Surface the originating request failure. */ }
      hub.deliver(responseError(message, errorText(error)));
      (hub.latestClient() || scope.client).report(error, scope.context);
    }
  }

  async function acceptTurn(hub, pending, message) {
    const body = messageBody(message);
    const scope = pending.scope;
    const turnId = body?.result?.turn?.id;
    try {
      if (body?.error) await receipt(scope, "failed", { error: String(body.error.message || "发送失败") });
      else await receipt(scope, "accepted", { turn_id: turnId });
    } catch (error) { hub.latestClient()?.report(error); }
    // The native UI owns delivery semantics. A receipt failure must not hide a
    // turn which the server has already accepted, or trigger an automatic retry.
    hub.deliver(message);
    for (const [key, registered] of hub.threads) {
      if (!registered.registryRetired || registered.awaitingFirstTurn) continue;
      if (![...hub.requests.values()].some(request => request.scope?.context?.thread_id === registered.context.thread_id && request.scope.context.host_id === registered.context.host_id)) hub.threads.delete(key);
    }
    if (!body?.error) {
      const client = hub.latestClient() || scope.client;
      client.options.onTurn?.({ target: { ...scope.context }, context: { ...scope.context }, thread_id: scope.context.thread_id, turn_id: turnId });
    }
  }

  async function handleTool(hub, message) {
    const request = message.serverRequest;
    const params = request?.params || {};
    const name = params.tool || params.name;
    const hostId = message.hostId || LOCAL;
    const key = JSON.stringify([hostId, request?.id, params.threadId, params.callId, name, params.arguments]);
    let response;
    if (hub.calls.has(key)) response = await hub.calls.get(key);
    else {
      const work = (async () => {
        try {
          const client = hub.latestClient();
          const scope = hub.threads.get(threadKey(hostId, params.threadId)) || (client && params.threadId ? { hub, client, context: { host_id: hostId, thread_id: params.threadId } } : null);
          // A restored native thread need not have been opened through this UI
          // process. The backend verifies the trusted server envelope against
          // its durable host/thread binding before allowing any document write.
          if (!scope || request?.method !== "item/tool/call" || !params.callId || !toolNames.has(name)) throw Error("项目资料工具无法确认当前会话");
          const result = await post(scope, "tool", {
            host_id: hostId, thread_id: params.threadId, call_id: params.callId,
            ...(params.turnId ? { turn_id: params.turnId } : {}), name, arguments: params.arguments
          });
          if (result?.result?.contentItems) return result.result;
          if (result?.contentItems) return result;
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
        } catch (error) {
          return { success: false, contentItems: [{ type: "inputText", text: errorText(error) }] };
        }
      })();
      hub.calls.set(key, work);
      response = await work;
      // Keep a bounded replay cache for duplicate server envelopes.
      if (hub.calls.size > 128) hub.calls.delete(hub.calls.keys().next().value);
    }
    hub.send({ type: "mcp-response", hostId, requestMethod: "item/tool/call", response: { id: request.id, result: response } });
  }

  function create(options) {
    if (typeof options?.api !== "function") throw Error("Native conversation API is required");
    let hub = null;
    let host = null;
    let hostPromise = null;
    let navigationGeneration = 0;
    let internalNavigation = 0;
    let initialRoute = "";
    let currentRoute = "";
    let originalNativeDraft = "";
    let registry = null;
    const draftIdStorage = options.storage || root.localStorage || root.sessionStorage;
    const drafts = { ...readDraftIds(root.sessionStorage), ...readDraftIds(draftIdStorage) };
    try { if (Object.keys(drafts).length) draftIdStorage?.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* Mounted drafts still retain their stable IDs. */ }
    const draftStorage = options.draftStorage || nativeDraftStorage();
    const client = {
      options, disposed: false, current: null,
      report(error, origin = this.current) { options.onError?.(error instanceof Error ? error : Error(errorText(error)), origin ? { ...origin } : undefined); },
      isNavigating() { return internalNavigation > 0; },
      ownsNativeDraft() {
        try { return !!host && !!this.current?.client_draft_id && host.readDraft() === this.current.client_draft_id; }
        catch { return false; }
      },
      async ensureHost() {
        if (this.disposed) throw Error("会话页面已关闭");
        if (!hostPromise) hostPromise = Promise.resolve(options.host || loadInstalledHost());
        host = await hostPromise;
        if (!host.dynamicTools || !host.prewarm || !host.draftIdentity || typeof host.readDraft !== "function" || typeof host.selectDraft !== "function" || typeof host.captureDraft !== "function" || typeof host.restoreDraft !== "function" || typeof host.sender?.postMessage !== "function" || typeof host.dispatcher?.deliverOrBufferMessage !== "function") throw Error("当前 Codex 暂时不支持页内会话");
        host.readDraft();
        if (!hub) {
          const existing = root[HUB_KEY];
          hub = existing && !existing.released && existing.host.sender === host.sender && existing.host.dispatcher === host.dispatcher ? existing.factory === createHub ? existing : createHub(host, existing) : createHub(host);
          hub.clients.add(this);
          if (registry) this.registerBindings(registry);
        }
        return host;
      },
      registerBindings(values) {
        registry = (Array.isArray(values) ? values : []).filter(value => value && value.host_id === LOCAL && typeof value.project_id === "string" && value.project_id && typeof value.thread_id === "string" && value.thread_id && ["charter", "planning", "work"].includes(value.kind) && (value.kind !== "work" || typeof value.issue_id === "string" && value.issue_id) && (value.kind === "work" || !value.conversation_id || typeof value.conversation_id === "string")).map(value => ({ ...targetIdentity(value), host_id: LOCAL, thread_id: value.thread_id, mode: "thread" }));
        if (!hub || this.disposed) return { registered: 0 };
        const keys = new Set(registry.map(context => threadKey(context.host_id, context.thread_id)));
        for (const [key, scope] of hub.threads) {
          if (keys.has(key) || scope.client !== this && scope.registryClient !== this) continue;
          const pending = [...hub.requests.values()].some(request => request.scope?.context?.thread_id === scope.context.thread_id && request.scope.context.host_id === scope.context.host_id);
          if (!pending && !scope.awaitingFirstTurn) hub.threads.delete(key);
          else scope.registryRetired = true;
        }
        for (const context of registry) {
          const key = threadKey(context.host_id, context.thread_id);
          const existing = hub.threads.get(key);
          if (existing) {
            existing.context = { ...existing.context, ...context };
            existing.registryClient = this;
            existing.registryRetired = false;
          } else hub.threads.set(key, { hub, client: this, registryClient: this, context, operation: null });
        }
        return { registered: registry.length };
      },
      route() {
        const actual = options.getActiveRoute?.() || (root.location.pathname + root.location.search);
        // Electron also hosts the native memory router at /index.html.
        return /^\/index\.html(?:\?|$)/.test(actual) && currentRoute ? currentRoute : actual || currentRoute;
      },
      ownsCurrentDraft() {
        if (this.disposed || !this.current || this.current.mode !== "draft") return false;
        if (options.isCurrentContext && !options.isCurrentContext(this.current)) return false;
        return internalNavigation > 0 || this.ownsRoute(this.route());
      },
      blocksNativeInput() { return !this.disposed && this.current?.native_open_state === "failed" && options.isCurrentContext?.(this.current) !== false; },
      ownsRoute(route) {
        if (!this.current) return false;
        const supplied = String(route || "");
        const path = /^\/index\.html(?:\?|$)/.test(supplied) && currentRoute ? currentRoute : supplied;
        const context = this.current;
        if (context.thread_id && path.split("?")[0] === "/local/" + encodeURIComponent(context.thread_id)) return true;
        if (context.thread_id && path.split("?")[0] === "/local/" + context.thread_id) return true;
        try {
          const url = new URL(path, "https://codex.local");
          return url.pathname === "/projects" && !!context.native_project_id && url.searchParams.get("projectId") === context.native_project_id;
        } catch { return false; }
      },
      matchesWorkspace(message) {
        if ((message.hostId || LOCAL) !== this.current.host_id) return false;
        const cwd = message.request?.params?.cwd;
        return cwd == null || normalizePath(cwd) === normalizePath(this.current.cwd);
      },
      async navigate(path, state) {
        currentRoute = path;
        if (options.navigate) return options.navigate(path, state);
        host.dispatcher.dispatchHostMessage({ type: "navigate-to-route", path, ...(state ? { state } : {}) });
        if (typeof options.afterNavigate === "function") await options.afterNavigate(path);
        else await new Promise(resolve => root.setTimeout(resolve, 40));
      },
      draftId(context) {
        const key = targetKey(context) + ":" + (context.draft_generation ?? context.binding?.generation ?? "0");
        let id = drafts[key];
        if (typeof id !== "string" || !/^client-new-thread:[a-z0-9-]+$/i.test(id)) {
          id = "client-new-thread:" + uuid();
          drafts[key] = id;
          try { draftIdStorage?.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* Native draft still remains in this mounted adapter. */ }
        }
        return id;
      },
      saveDraft(id, origin) {
        if (!host || !id) return;
        try {
          const snapshot = host.captureDraft();
          Promise.resolve(draftStorage.set(id, snapshot)).catch(error => this.report(error, origin));
        } catch (error) { this.report(error, origin); }
      },
      rememberOrdinaryDraft(context, restored) {
        if (originalNativeDraft) return;
        const nativeId = host.readDraft();
        const restoredOriginal = restored?.native_home_draft_id || drafts.__ordinary_home__;
        const managed = Object.entries(drafts).some(([key, id]) => key !== "__ordinary_home__" && id === nativeId);
        originalNativeDraft = managed && /^client-new-thread:[a-z0-9-]+$/i.test(restoredOriginal || "") ? restoredOriginal : nativeId;
        drafts.__ordinary_home__ = originalNativeDraft;
        try { draftIdStorage?.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* The mounted adapter still retains native ownership. */ }
        if (nativeId === originalNativeDraft) this.saveDraft(originalNativeDraft, context);
      },
      async open(value, restored) {
        const generation = ++navigationGeneration;
        const context = flattenContext(value);
        if (!context.project_id || !["charter", "planning", "work"].includes(context.kind) || context.kind === "work" && !context.issue_id) throw Error("项目会话资料不完整");
        if (context.conversation_id && typeof context.conversation_id !== "string") throw Error("项目会话资料不完整");
        const previous = this.current;
        if (previous?.mode === "draft" && previous.client_draft_id && this.ownsNativeDraft()) this.saveDraft(previous.client_draft_id, previous);
        this.current = context;
        context.native_open_state = "loading";
        if (!initialRoute) initialRoute = this.route();
        if (context.mode === "legacy_busy" || context.mode === "handoff_required") return { mode: context.mode, context: { ...context }, capabilities: this.capabilities() };
        try {
          await this.ensureHost();
          if (generation !== navigationGeneration || this.disposed) return { cancelled: true };
          if (!context.thread_id && context.pending_operation && ["allocated", "outcome_unknown", "prepared"].includes(context.pending_operation.status)) throw Error("上次会话连接尚待核对，请恢复后再发送");
          if (context.thread_id) {
            const scope = { hub, client: this, context: { ...context }, operation: null };
            hub.threads.set(threadKey(context.host_id, context.thread_id), scope);
            internalNavigation++;
            try { await this.navigate("/local/" + encodeURIComponent(context.thread_id)); }
            finally { internalNavigation--; }
          } else {
            const restoreDraft = restored && targetKey(restored) === targetKey(context) && (restored.draft_generation ?? 0) === (context.draft_generation ?? 0) && /^client-new-thread:[a-z0-9-]+$/i.test(restored.client_draft_id || "");
            context.client_draft_id = restoreDraft ? restored.client_draft_id : this.draftId(context);
            if (!context.native_project_id) throw Error("该项目尚未关联到 Codex 项目");
            const draftRoute = "/projects?projectId=" + encodeURIComponent(context.native_project_id);
            if (host.isSelectedDraft?.(context.client_draft_id, context)) {
              // A source reload does not unmount the native editor. Its current
              // document can contain input entered after the previous snapshot;
              // preserve the genuine scope, caret and undo state exactly.
              currentRoute = draftRoute;
              this.rememberOrdinaryDraft(context, restored);
              this.saveDraft(context.client_draft_id, context);
              context.native_open_state = "ready";
              return { mode: "draft", context: { ...context }, capabilities: this.capabilities() };
            }
            if (previous?.client_draft_id === context.client_draft_id && this.route() === draftRoute && host.readDraft() === context.client_draft_id) { context.native_open_state = "ready"; return { mode: "draft", context: { ...context }, capabilities: this.capabilities() }; }
            internalNavigation++;
            try {
              // Project selection supplies native projectId and prevents the
              // host from consuming a projectless warm reservation of this cwd.
              await this.navigate(draftRoute, { focusComposerNonce: context.client_draft_id });
              if (generation !== navigationGeneration || this.disposed) return { cancelled: true };
              if (host.waitForProject && !await host.waitForProject(context, () => generation === navigationGeneration && !this.disposed)) return { cancelled: true };
              this.rememberOrdinaryDraft(context, restored);
              const snapshot = await draftStorage.get(context.client_draft_id);
              if (generation !== navigationGeneration || this.disposed) return { cancelled: true };
              host.selectDraft(context.client_draft_id, context);
              host.restoreDraft(snapshot);
            } finally { internalNavigation--; }
          }
          context.native_open_state = "ready";
          return { mode: context.mode, context: { ...context }, capabilities: this.capabilities() };
        } catch (error) {
          context.native_open_state = "failed";
          this.report(error, context);
          return { mode: "unavailable", context: { ...context }, error: errorText(error), capabilities: this.capabilities() };
        }
      },
      async beginThread(message) {
        const context = { ...this.current };
        const scope = { hub, client: this, context, originTarget: { ...context }, operation: null };
        const nativeKey = requestKey(message.hostId, message.request.id);
        if (hub.requests.has(nativeKey)) return;
        const inProgress = [...hub.requests.values()].find(value => value.type === "start" && targetKey(value.scope.context) === targetKey(context));
        if (inProgress) { hub.deliver(responseError(message, "当前会话正在连接")); return; }
        // Reserve before awaiting HTTP so two native sends cannot prepare two
        // operations or allocate two native threads for the same target.
        const pending = { type: "start", scope, client: this, message, timer: null };
        hub.requests.set(nativeKey, pending);
        try {
          const requestId = uuid();
          const prepared = await post(scope, "prepare", {
            ...targetIdentity(context),
            host_id: context.host_id, request_id: requestId, expected_revision: context.expected_revision,
            draft_generation: context.draft_generation
          });
          scope.operation = prepared.operation;
          assertReturnedTarget(context, prepared.target); assertReturnedTarget(context, scope.operation);
          if (!scope.operation?.request_id || scope.operation.thread_id) throw Error("上次会话连接尚待核对，请恢复后再发送");
          if (this.disposed || !this.current || targetKey(this.current) !== targetKey(context) || !this.ownsCurrentDraft()) throw Error("会话页面已切换，请回到原页面发送");
          scope.context = flattenContext({ ...context, ...prepared.target, ...(!conversationId(context) && !prepared.target?.conversation_id && scope.operation.conversation_id ? { conversation_id: scope.operation.conversation_id } : {}), dynamic_tools: prepared.dynamic_tools || context.dynamic_tools });
          assertReturnedTarget(scope.context, prepared.target); assertReturnedTarget(scope.context, scope.operation);
          if (conversationId(scope.context) && targetKey(scope.context) !== targetKey(context)) {
            // The first authorized send can enroll a legacy unnamed draft. Keep
            // its native document/nonce while assigning the new stable identity.
            drafts[targetKey(scope.context) + ":" + (scope.context.draft_generation ?? "0")] = context.client_draft_id;
            try { draftIdStorage?.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch { /* The native draft remains retained. */ }
          }
          const params = { ...message.request.params, cwd: context.cwd, runtimeWorkspaceRoots: [...context.root_paths], dynamicTools: toolsForThread(scope.context, message.request.params?.dynamicTools) };
          const outgoing = { ...message, request: { ...message.request, params } };
          pending.timer = root.setTimeout(() => {
            if (hub.requests.get(nativeKey) !== pending) return;
            hub.run(receipt(scope, "outcome_unknown", { error: "会话连接结果尚待核对" }));
            this.report(Error("会话连接结果尚待核对"), context);
          }, Math.max(15_000, Math.min(message.timeoutMs || 60_000, 120_000)) + 1_000);
          hub.send(outgoing);
        } catch (error) {
          hub.requests.delete(nativeKey);
          if (scope.operation) try { await receipt(scope, "failed", { error: errorText(error) }); } catch { /* Failure is already surfaced by the native request. */ }
          hub.deliver(responseError(message, errorText(error)));
          this.report(error, context);
        }
      },
      async acceptThread(pending, message) {
        const scope = pending.scope;
        const body = messageBody(message);
        if (body?.error) {
          try { await receipt(scope, "failed", { error: String(body.error.message || "连接失败") }); } catch (error) { this.report(error); }
          hub.deliver(message);
          return;
        }
        const threadId = body?.result?.thread?.id;
        try {
          if (!threadId) throw Error("原生会话未返回会话编号");
          scope.context.thread_id = threadId;
          const identity = { ...operationIdentity(scope), thread_id: threadId };
          const allocated = await post(scope, "bind", { ...identity, checkpoint: "allocated" });
          assertReturnedTarget(scope.context, allocated.binding); assertReturnedTarget(scope.context, allocated.operation);
          const bound = await post(scope, "bind", { ...identity, checkpoint: "bound" });
          assertReturnedTarget(scope.context, bound.binding); assertReturnedTarget(scope.context, bound.operation);
          scope.context = { ...scope.context, binding: bound.binding, mode: "thread" };
          scope.awaitingFirstTurn = true;
          hub.threads.set(threadKey(scope.context.host_id, threadId), scope);
          const origin = scope.originTarget || scope.context;
          if (!this.disposed && this.current && [targetKey(scope.context), targetKey(origin)].includes(targetKey(this.current))) {
            this.current = { ...this.current, ...scope.context };
          }
          const receiver = hub.latestClient() || this;
          if (!receiver.disposed && receiver.current && [targetKey(scope.context), targetKey(origin)].includes(targetKey(receiver.current)) && (receiver.current.draft_generation ?? 0) === (scope.context.draft_generation ?? 0) && (!receiver.current.thread_id || receiver.current.thread_id === threadId)) receiver.current = { ...receiver.current, ...scope.context };
          receiver.options.onBound?.({ target: { ...origin }, origin_target: { ...origin }, context: { ...scope.context }, thread_id: threadId, binding: bound.binding, operation: bound.operation });
          // Native's thread/start continuation sends the original rich input.
          // Delivering only after both checkpoints is the binding/send barrier.
          hub.deliver(message);
        } catch (error) {
          try { await receipt(scope, threadId ? "outcome_unknown" : "failed", { thread_id: threadId, error: errorText(error) }); } catch { /* Keep the original failure. */ }
          hub.deliver(responseError(pending.message, errorText(error)));
          this.report(error, scope.context);
        }
      },
      leave(preserveNative = false) {
        const generation = ++navigationGeneration;
        if (host && originalNativeDraft && this.current?.client_draft_id) {
          const origin = { ...this.current };
          const original = originalNativeDraft;
          try {
            if (host.readDraft() === this.current.client_draft_id && this.current.mode === "draft") {
              this.saveDraft(this.current.client_draft_id, origin);
              if (!preserveNative) host.selectDraft(original);
              // Restoring ordinary native home data does not navigate, send or
              // operate on the composer of an already-bound task/thread.
              if (!preserveNative) Promise.resolve(draftStorage.get(original)).then(snapshot => {
                const currentHub = root[HUB_KEY];
                const replaced = currentHub && [...currentHub.clients].some(client => client !== this && !client.disposed);
                if (!this.disposed && generation === navigationGeneration && !replaced && host.readDraft() === original && !this.current && host.isHomeComposer?.() !== false) host.restoreDraft(snapshot);
              }).catch(error => { if (!this.disposed && generation === navigationGeneration) this.report(error, origin); });
            }
          } catch { /* Native navigation may have already disposed its scope. */ }
        }
        this.current = null; currentRoute = ""; originalNativeDraft = "";
      },
      destroy() {
        if (this.disposed) return;
        // Hot reload disposes the source controller while native React stays
        // mounted. Save its draft, but never restore another home identity or
        // enqueue a late native editor write into the replacement controller.
        this.leave(true); this.disposed = true;
        if (hub) { hub.clients.delete(this); hub.release(); }
      },
      capture() {
        return this.current ? {
          ...targetIdentity(this.current),
          thread_id: this.current.thread_id, client_draft_id: this.current.client_draft_id,
          native_home_draft_id: originalNativeDraft || undefined,
          draft_generation: this.current.draft_generation, route: this.route()
        } : null;
      },
      restore(value, snapshot) { return this.open(value, snapshot); },
      getCurrentContext() { return this.current ? { ...this.current } : null; },
      inspectLayout() { return host?.inspectLayout?.(this.current) || { available: false, composer_visible: false, ancestry_consistent: false, route_kind: null, context_matches: false }; },
      capabilities() {
        return {
          available: !!host && host.dynamicTools === true && host.prewarm === true && host.draftIdentity === true,
          native_composer: !!host, dynamic_tools: host?.dynamicTools === true,
          scoped_prewarm: host?.prewarm === true, isolated_native_drafts: host?.draftIdentity === true
        };
      }
    };
    return {
      connect: client.ensureHost.bind(client),
      registerBindings: client.registerBindings.bind(client),
      mount: client.open.bind(client), open: client.open.bind(client),
      leave: () => client.leave(), destroy: client.destroy.bind(client),
      capture: client.capture.bind(client), restore: client.restore.bind(client),
      capabilities: client.capabilities.bind(client), ownsRoute: client.ownsRoute.bind(client),
      inspectLayout: client.inspectLayout.bind(client),
      getCurrentContext: client.getCurrentContext.bind(client)
    };
  }

  root.BetterCodexNativeConversation = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);

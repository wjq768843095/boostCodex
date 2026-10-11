"use strict";
// This adapter keeps the native composer and message renderer in their owning
// React tree. It only coordinates native IPC and trusted project bindings.
(function installNativeConversationAdapter(root) {
  const HUB_KEY = "__betterCodexNativeConversationHub__";
  const DRAFT_KEY = "better-codex-native-drafts-v1";
  const DRAFT_STATE_KEY = "__betterCodexNativeDraftState__";
  const RETAINED_PIN_KEY = "__betterCodexRetainedNativePin__";
  const PREFIX = "better_codex_";
  const API_ROOT = "/api/native-conversations/";
  const LOCAL = "local";

  // Recover only the account-list GET through the local authenticated transport
  // after the native transport has completed its policy checks and returned a
  // Cloudflare challenge. The backend verifies the native token's user, fetches
  // fresh metadata, and refuses organization routing. Native policy checks and
  // the query's before/after identity assertions still consume the real result.
  root.__betterCodexAccountTransportRecovery__?.dispose?.();
  const accountTransport = {
    request: null, original: null, wrapper: null, disposed: false, bridge: null, pending: new Set(), startupRetried: new WeakSet(),
    stats: { installed: false, attempted: 0, recovered: 0, rejected: 0, lastFailureStage: null },
    queryClient() {
      const stack = [root.__codexRoot?._internalRoot?.current], seen = new Set();
      let client;
      while (stack.length && seen.size < 30000) {
        const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
        if (typeof fiber.memoizedProps?.client?.getQueryCache === "function") { client = fiber.memoizedProps.client; break; }
        stack.push(fiber.child, fiber.sibling);
      }
      return client;
    },
    identityFor(accountId) {
      const queries = this.queryClient()?.getQueryCache().getAll() || [];
      const matches = queries.filter(query => query.isActive() &&
        query.queryKey[0] === "usage-settings" && query.queryKey[1] === "accounts-check" &&
        query.queryKey[2] === "v4-2023-04-27" && query.queryKey[3] === accountId);
      const users = new Set(matches.map(query => query.queryKey[4]));
      if (users.size !== 1) return null;
      const userId = [...users][0];
      if (typeof userId !== "string" || !userId) return null;
      const account = matches.flatMap(query => Object.values(query.state.data?.accounts || {}))
        .find(item => item?.account?.account_id === accountId)?.account;
      const check = queries.find(query => query.queryKey.length === 2 && query.queryKey[0] === "accounts" && query.queryKey[1] === "check" &&
        query.isActive() && query.state.status === "success" && query.state.fetchStatus === "idle" && !query.state.isInvalidated);
      const coldAccounts = Array.isArray(check?.state.data?.accounts) && check.state.data.account_ordering?.includes(accountId) ?
        check.state.data.accounts.filter(item => item?.id === accountId) : [];
      const coldAccount = coldAccounts.length === 1 ? coldAccounts[0] : null;
      if (coldAccounts.length > 1 || coldAccounts.some(item => item.structure !== "personal")) return null;
      // Do not send an organization's request outside its native residency/IP
      // routing. The backend also checks the fresh response's account structure.
      return (account || coldAccount)?.structure === "personal" ? { accountId, userId } : null;
    },
    recoverStartupErrors() {
      if (this.disposed || !this.request || typeof this.bridge !== "function") return;
      for (const query of this.queryClient()?.getQueryCache().getAll() || []) {
        const error = query.state.error;
        if (!query.isActive() || query.queryKey[0] !== "usage-settings" || query.queryKey[1] !== "accounts-check" ||
            query.queryKey[2] !== "v4-2023-04-27" || query.state.status !== "error" || query.state.fetchStatus !== "idle" ||
            error?.status !== 403 || error?.errorCode !== "cloudflare_challenge" || this.startupRetried.has(query) || !this.identityFor(query.queryKey[3])) continue;
        this.startupRetried.add(query);
        // A first query can fail before the local bridge has mounted. Retry its
        // real native query once after installation; never synthesize success.
        Promise.resolve().then(() => {
          if (!this.disposed && typeof this.bridge === "function" && query.isActive() && query.state.error === error &&
              query.state.fetchStatus === "idle" && this.identityFor(query.queryKey[3])) return query.fetch();
        }).catch(() => {});
      }
    },
    installRequest(request) {
      if (this.disposed || this.request || typeof request?.safeGet !== "function" || typeof request.getRequestTarget !== "function") return false;
      const original = request.safeGet, state = this;
      const wrapper = async function (route, ...args) {
        const originalOptions = args[0];
        const metadataRoute = route === "/accounts/check/v4-2023-04-27" || route === "/accounts/check/{version}" && originalOptions?.parameters?.path?.version === "v4-2023-04-27";
        let primaryArgs = args, deadlineController, deadlineTimer, forwardAbort, deadlineFired = false, boundedIdentity;
        const clearDeadline = () => {
          if (deadlineTimer != null) { root.clearTimeout(deadlineTimer); deadlineTimer = null; }
          if (forwardAbort) { originalOptions?.signal?.removeEventListener("abort", forwardAbort); forwardAbort = null; }
        };
        // Use the native cancellation hook for this personal metadata GET.
        // Native auth/routing still run; a timeout is not policy approval.
        if (metadataRoute && !state.disposed && typeof state.bridge === "function" && typeof root.AbortController === "function" && typeof root.setTimeout === "function") {
          const key = Object.keys(originalOptions?.additionalHeaders || {}).find(key => key.toLowerCase() === "chatgpt-account-id");
          const accountId = key && originalOptions.additionalHeaders[key];
          const headers = this.getRequestTarget(route, originalOptions).headers || {};
          boundedIdentity = typeof accountId === "string" && state.identityFor(accountId);
          if (boundedIdentity && Object.entries(headers).some(([key, value]) => key.toLowerCase() === "x-openai-attach-auth" && String(value) === "1")) {
            deadlineController = new root.AbortController();
            forwardAbort = () => deadlineController.abort(originalOptions.signal.reason);
            originalOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
            if (originalOptions.signal?.aborted) forwardAbort();
            deadlineTimer = root.setTimeout(() => {
              deadlineFired = true;
              deadlineController.abort(new DOMException("Account metadata request timed out", "TimeoutError"));
            }, 10000);
            primaryArgs = [{ ...originalOptions, signal: deadlineController.signal }, ...args.slice(1)];
          }
        }
        try { return await Reflect.apply(original, this, [route, ...primaryArgs]); }
        catch (primaryError) {
          clearDeadline();
          const options = args[0];
          const version = options?.parameters?.path?.version;
          const ownTimeout = deadlineFired && deadlineController?.signal.aborted &&
            (primaryError === deadlineController.signal.reason || primaryError?.name === "AbortError" || primaryError?.status === 499);
          if (state.disposed || !(primaryError?.status === 403 && primaryError?.errorCode === "cloudflare_challenge" || ownTimeout) ||
              !(route === "/accounts/check/v4-2023-04-27" || route === "/accounts/check/{version}" && version === "v4-2023-04-27")) throw primaryError;
          options?.signal?.throwIfAborted();
          const headerKey = Object.keys(options?.additionalHeaders || {}).find(key => key.toLowerCase() === "chatgpt-account-id");
          const accountId = headerKey && options.additionalHeaders[headerKey];
          if (typeof accountId !== "string" || !accountId) throw primaryError;
          const target = this.getRequestTarget(route, options);
          const targetHeaders = Object.entries(target.headers || {});
          if (!targetHeaders.some(([key, value]) => key.toLowerCase() === "x-openai-attach-auth" && String(value) === "1") || typeof state.bridge !== "function") throw primaryError;
          const identity = state.identityFor(accountId);
          if (!identity) throw primaryError;
          options.assertRequestCurrent?.();
          if (ownTimeout && identity.userId !== boundedIdentity?.userId) throw new DOMException("Account identity changed", "AbortError");
          state.stats.attempted++;
          state.stats.lastFailureStage = "transport";
          try {
            const data = await state.bridge(identity, options.signal);
            options.signal?.throwIfAborted();
            options.assertRequestCurrent?.();
            const currentIdentity = state.identityFor(accountId);
            if (state.disposed || currentIdentity?.userId !== identity.userId) throw new DOMException("Account identity changed", "AbortError");
            state.stats.lastFailureStage = "validation";
            const record = data?.accounts && Object.values(data.accounts).find(item => item?.account?.account_id === accountId);
            const account = record?.account;
            const required = ["account_id", "account_user_id", "account_user_role", "structure", "plan_type", "is_zdr"];
            if (!Array.isArray(data?.account_ordering) || !account || !required.every(key => account[key] != null) || account.structure !== "personal") throw primaryError;
            state.stats.recovered++;
            state.stats.lastFailureStage = null;
            return data;
          } catch (error) { state.stats.rejected++; if (error?.name === "AbortError") state.stats.lastFailureStage = "aborted"; throw error; }
        } finally { clearDeadline(); }
      };
      this.request = request; this.original = original; this.wrapper = wrapper;
      request.safeGet = wrapper; this.stats.installed = true;
      this.recoverStartupErrors();
      return true;
    },
    async installFromSource(source, sharedUrl) {
      if (this.disposed || this.request) return;
      const name = /["'`]([^"'`]*chatgpt-request-[^"'`]+\.js)["'`]/.exec(source)?.[1];
      if (!name) return;
      const url = new URL(name, sharedUrl);
      if (url.protocol !== root.location?.protocol || url.host !== root.location?.host || !url.pathname.startsWith("/assets/")) return;
      const namespace = await import(url.href);
      if (!this.disposed) this.installRequest(namespace.Request);
    },
    dispose() {
      this.disposed = true;
      for (const cancel of [...this.pending]) cancel();
      this.bridge = null;
      if (this.request?.safeGet === this.wrapper) this.request.safeGet = this.original;
      this.stats.installed = false;
    }
  };
  root.__betterCodexAccountTransportRecovery__ = accountTransport;
  const retainedSharedUrl = root[HUB_KEY]?.host?.moduleUrl;
  if (retainedSharedUrl && root.fetch) root.fetch(retainedSharedUrl).then(response => response.text())
    .then(source => accountTransport.installFromSource(source, retainedSharedUrl)).catch(() => {});
  const toolNames = new Set([
    "better_codex_project_context_read", "better_codex_project_charter_save",
    "better_codex_project_charter_confirm", "better_codex_project_plan_save",
    "better_codex_project_plan_convert", "better_codex_project_task_transition"
  ]);
  const normalizePath = value => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  const conversationId = context => context.conversation_id || "";
  const conversationFields = context => conversationId(context) ? { conversation_id: conversationId(context) } : {};
  const historyFields = context => context.history_id ? { history_id: context.history_id } : {};
  const readOnly = context => !!context?.history_id || context?.read_only === true;
  const targetIdentity = context => ({ project_id: context.project_id, kind: context.kind, ...(context.issue_id ? { issue_id: context.issue_id } : {}), ...conversationFields(context), ...historyFields(context) });
  const targetKey = context => [context.project_id, context.kind, context.issue_id || ""].join(":") + (conversationId(context) ? ":conversation:" + encodeURIComponent(conversationId(context)) : "") + (context.history_id ? ":history:" + encodeURIComponent(context.history_id) : "");
  const threadKey = (host, thread) => [host || LOCAL, thread].join(":");
  const requestKey = (host, id) => JSON.stringify([host || LOCAL, id]);
  const messageId = value => value?.message?.id ?? value?.response?.id;
  const messageBody = value => value?.message || value?.response;
  const errorText = error => {
    const value = String(error?.message || error || "原生会话暂时无法打开");
    if (value === "native_outcome_unknown") return "上次发送结果仍在核对，请稍后重试。";
    if (value === "native_recovery_unavailable") return "暂时无法核对会话，请稍后重试。";
    return ({ skill_project_mismatch: "此 Skill 仅适用于它所属的项目，请重新选择。", skill_project_root_shared: "项目目录与其他项目重叠，请选择独立目录后重试。", skill_project_not_found: "项目目录暂时无法访问，请检查项目设置。", skill_export_path_conflict: "此 Skill 暂时无法使用，请检查保存位置。", issue_execution_running: "任务正在执行，请等待完成后再发送。" })[value] || value;
  };
  const uuid = () => root.crypto.randomUUID();

  function flattenContext(value) {
    const context = { ...(value?.context || {}), ...(value?.target || {}), ...(value || {}) };
    delete context.context;
    context.kind = context.kind || context.session_kind;
    context.project_id = context.project_id || context.binding?.project_id || context.project?.id;
    context.issue_id = context.issue_id || context.binding?.issue_id;
    context.conversation_id = context.conversation_id || context.binding?.conversation_id || value?.target?.conversation_id || undefined;
    context.history_id = context.history_id || value?.target?.history_id || undefined;
    if (context.history_id) context.read_only = true;
    context.thread_id = context.thread_id || context.binding?.thread_id || "";
    if (!context.history_id && context.kind === "planning" && context.thread_id && typeof context.planning_available === "boolean") context.read_only = !context.planning_available;
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
    if (returned.history_id !== undefined && String(returned.history_id || "") !== String(expected.history_id || "")) throw Error("会话资料已更新，请重新打开会话");
  }

  function responseError(request, message, code = -32000) {
    return {
      type: "mcp-response", hostId: request.hostId || LOCAL,
      message: { id: request.request.id, error: { code, message } }
    };
  }

  function toolsForThread(context, existing) {
    const supplied = context.dynamic_tools || [];
    const requiredNames = new Set([...toolNames].filter(name => context.kind === "work" || name !== "better_codex_project_task_transition"));
    if (!Array.isArray(supplied) || supplied.length !== requiredNames.size) throw Error("项目资料工具暂时不可用");
    const names = new Set();
    for (const tool of supplied) {
      if (!requiredNames.has(tool.name) || names.has(tool.name) || !tool.inputSchema || typeof tool.description !== "string") throw Error("项目资料工具暂时不可用");
      names.add(tool.name);
    }
    const native = Array.isArray(existing) ? existing : [];
    if (native.some(tool => names.has(tool?.name))) throw Error("项目资料工具名称重复");
    return [...native, ...supplied];
  }

  function refreshedContext(previous, value) {
    return flattenContext({ ...previous, ...(value?.context || {}), ...(value?.target || {}), ...(value || {}) });
  }

  function contextChunks(value) {
    // The installed app-server truncates each additional-context fragment at
    // about 1000 tokens. Keep the UTF-8 byte upper bound comfortably below it,
    // including the per-fragment snapshot label, and preserve Unicode scalars.
    const chunks = []; let part = "", bytes = 0;
    for (const character of value) {
      const point = character.codePointAt(0);
      const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (bytes + size > 640) { chunks.push(part); part = ""; bytes = 0; }
      part += character; bytes += size;
    }
    if (part) chunks.push(part);
    return chunks;
  }

  function withWorkContext(hub, context, params) {
    if (context.kind !== "work") return params;
    const task = context.task, material = context.work_context_text;
    if (readOnly(context) || !task || task.id !== context.issue_id || task.project_id !== context.project_id || typeof material !== "string" || !material.trim()) throw Error("当前任务资料暂时不可用，请重新打开会话");
    const original = params.additionalContext;
    if (original != null && (typeof original !== "object" || Array.isArray(original))) throw Error("当前任务资料暂时无法同步，请重新发送");
    hub.workContexts ||= new Map();
    const key = threadKey(context.host_id, context.thread_id);
    let state = hub.workContexts.get(key);
    if (!state) { state = { source: uuid(), material: null, snapshot: null, count: 0 }; hub.workContexts.set(key, state); }
    if (state.material !== material) { state.material = material; state.snapshot = uuid(); }
    const prefix = "better_codex_work_context/" + state.source + "/";
    if (Object.keys(original || {}).some(name => name.startsWith(prefix))) throw Error("当前任务资料暂时无法同步，请重新发送");
    const chunks = contextChunks(material), additionalContext = { ...(original || {}) };
    additionalContext[prefix + "snapshot"] = { kind: "untrusted", value: `当前工作任务资料快照：${state.snapshot}，共 ${chunks.length} 段。以此快照的完整资料和本次用户要求为准；其他快照的旧资料不替代当前任务要求。` };
    chunks.forEach((chunk, index) => { additionalContext[prefix + "part/" + index] = { kind: "untrusted", value: `任务资料快照 ${state.snapshot}，第 ${index + 1}/${chunks.length} 段：\n${chunk}` }; });
    for (let index = chunks.length; index < state.count; index++) additionalContext[prefix + "part/" + index] = { kind: "untrusted", value: `任务资料快照 ${state.snapshot}：此旧资料段已被替换，不属于当前任务要求。` };
    state.count = chunks.length;
    return { ...params, additionalContext };
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

  function nativeNavigationRuntime() {
    // The installed host retains genuine React route trees, including their
    // location providers and editor controllers. Discover that owning router;
    // never move its DOM or create a second editor outside those providers.
    let router = null;
    let retained = null;
    let retainedFiber = null;
    const seen = new Set();
    const anchors = [...root.document.querySelectorAll('[data-app-shell-active-page="true"]'), ...root.document.querySelectorAll('[contenteditable], main')];
    for (const anchor of anchors) {
      for (let element = anchor; element; element = element.parentElement) {
        const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
        for (let fiber = key && element[key]; fiber && !seen.has(fiber); fiber = fiber.return) {
          seen.add(fiber);
          const candidate = fiber.memoizedProps?.value?.router;
          if (candidate && typeof candidate.navigate === "function" && candidate.state?.location && Array.isArray(candidate.routes)) router ||= candidate;
          let hook = fiber.memoizedState;
          for (let limit = 0; hook && typeof hook === "object" && limit < 128; limit++, hook = hook.next) {
            const value = hook.memoizedState;
            if (!retained && value?.current?.location?.location && Array.isArray(value.views) && value.views.every(view => view?.route && view?.location?.location && view.element)) { retained = value; retainedFiber = fiber; }
          }
        }
      }
      if (router && retained) break;
    }
    return { router, retained, retainedFiber };
  }

  function retainedExpirySlot(fiber, key) {
    // The native retention component pairs an expiry event and a page in the
    // same keyed Fragment. Require both identities before touching an event.
    for (let fragment = fiber?.child; fragment; fragment = fragment.sibling) {
      if (fragment.key !== key) continue;
      let expiry = null, page = null;
      for (let child = fragment.child; child; child = child.sibling) {
        const props = child.memoizedProps;
        if (props?.view?.key === key && typeof props.active === "boolean") page = child;
        if (typeof props?.onExpire === "function" && typeof props.active === "boolean" && Number.isFinite(props.ttlSeconds) && props.ttlSeconds > 0) expiry = child;
      }
      if (!page || !expiry || page.memoizedProps.active !== expiry.memoizedProps.active) return null;
      const first = expiry.memoizedState, second = first?.next, effect = second?.next;
      const slot = second?.memoizedState;
      const descriptor = slot && Object.getOwnPropertyDescriptor(slot, "impl");
      if (!first?.memoizedState || !Object.prototype.hasOwnProperty.call(first.memoizedState, "current") || !effect?.memoizedState?.deps || effect.memoizedState.deps[0] !== expiry.memoizedProps.active || effect.memoizedState.deps[1] !== expiry.memoizedProps.ttlSeconds || !descriptor?.configurable || !("value" in descriptor && typeof descriptor.value === "function" && descriptor.writable || descriptor.get && root[RETAINED_PIN_KEY]?.slots?.has(slot))) return null;
      return { slot, descriptor };
    }
    return null;
  }

  function refreshRetainedPin(pin = root[RETAINED_PIN_KEY]) {
    if (!pin || !pin.active || pin.refreshing) return false;
    pin.refreshing = true;
    try {
      const runtime = nativeNavigationRuntime();
      const view = runtime.retained?.views.find(view => view.key === pin.key && view.route.pathname === pin.path && view.route.routeKind === "local-thread");
      const access = view && retainedExpirySlot(runtime.retainedFiber, view.key);
      if (!view || !access) return false;
      for (const [previous, age] of pin.ages) if (previous !== view) {
        Object.defineProperty(previous, "lastUsed", { ...age.descriptor, value: age.value });
        pin.ages.delete(previous);
      }
      for (const [previous, record] of pin.slots) if (previous !== access.slot) {
        Object.defineProperty(previous, "impl", { ...record.descriptor, value: record.implementation });
        pin.slots.delete(previous);
      }
      if (!pin.slots.has(access.slot)) {
        const record = { descriptor: access.descriptor, implementation: access.descriptor.value, deferred: false };
        pin.slots.set(access.slot, record);
        Object.defineProperty(access.slot, "impl", {
          configurable: true, enumerable: access.descriptor.enumerable,
          get: () => function retainedPageExpiry(...args) {
            if (pin.active && root[RETAINED_PIN_KEY] === pin) { record.deferred = true; return; }
            return record.implementation.apply(this, args);
          },
          set: implementation => { record.implementation = implementation; }
        });
      }
      if (!pin.ages.has(view)) {
        const descriptor = Object.getOwnPropertyDescriptor(view, "lastUsed");
        if (descriptor?.configurable && descriptor.writable && typeof descriptor.value === "number") {
          const age = { descriptor, value: descriptor.value === Number.MAX_SAFE_INTEGER ? pin.lastUsed : descriptor.value };
          pin.lastUsed = age.value;
          pin.ages.set(view, age);
          Object.defineProperty(view, "lastUsed", { configurable: true, enumerable: descriptor.enumerable, get: () => Number.MAX_SAFE_INTEGER, set: value => { age.value = value; pin.lastUsed = value; } });
        }
      }
      return true;
    } finally { pin.refreshing = false; }
  }

  function clearRetainedPin(expire = true) {
    const pin = root[RETAINED_PIN_KEY];
    if (!pin) return;
    const runtime = expire ? nativeNavigationRuntime() : null;
    const inactive = !!runtime?.retained && runtime.retained.current?.key !== pin.key && runtime.router?.state?.location?.pathname !== pin.path;
    pin.active = false;
    pin.observer?.disconnect();
    if (pin.refreshFrame != null) root.cancelAnimationFrame?.(pin.refreshFrame);
    if (pin.refreshTimeout != null) root.clearTimeout(pin.refreshTimeout);
    if (pin.timer) root.clearInterval?.(pin.timer);
    delete root[RETAINED_PIN_KEY];
    for (const [view, age] of pin.ages) Object.defineProperty(view, "lastUsed", { ...age.descriptor, value: age.value });
    for (const [slot, record] of pin.slots) Object.defineProperty(slot, "impl", { ...record.descriptor, value: record.implementation });
    // An elapsed native timer has no remaining timeout. On release, give its
    // latest original event the normal opportunity to reclaim an inactive page.
    if (expire && inactive) for (const record of pin.slots.values()) if (record.deferred) record.implementation();
  }

  function retainedNativeNavigation(path) {
    const { router, retained } = nativeNavigationRuntime();
    if (!router || !retained) return null;
    const view = retained.views.find(view => view.route.routeKind === "local-thread" && view.route.pathname === path && !(view.route.search || ""));
    if (!view) return null;
    const location = router.state.location;
    return { router, view, selected: location.pathname === path && !(location.search || "") && !(location.hash || "") };
  }

  function nativeDraftProfile(namespace, initial) {
    // Bundler export names change between desktop releases. Keep verified
    // profiles together and validate the actual scope ownership before use.
    const profiles = [
      { descriptor: namespace.GJt, identity: namespace.Pyt, location: namespace.hbt, composer: initial },
      { descriptor: namespace.kQt, identity: namespace.ZSt, location: namespace.MCt, composer: {
        VIn: namespace.AH, KZt: initial?.l1t, DQt: initial?.W1t,
        XQt: initial?.u0t, 'o$t': initial?.b0t, ZQt: initial?.d0t, FZt: initial?.['Q$t']
      } }
    ];
    const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
    for (const profile of profiles) {
      const { descriptor, identity, location, composer } = profile;
      if (typeof own(descriptor, '__scopeBrand') !== 'string' || own(identity, 'scope') !== descriptor || typeof location !== 'function' ||
          typeof own(composer?.VIn, '__scopeBrand') !== 'string' || own(composer?.KZt, 'scope') !== composer.VIn || own(composer?.DQt, 'scope') !== composer.VIn ||
          !['XQt', 'o$t', 'ZQt', 'FZt'].every(name => typeof composer?.[name] === 'function')) continue;
      if (location({ entrypoint: 'home' }) === 'new-conversation') return profile;
    }
    return null;
  }

  function nativeDraftAccess(namespace, initial) {
    // Source-managed capability profile for the installed native scope runtime.
    // Each role is verified; a changed host fails closed instead of navigating
    // to an unregistered worktree draft and leaving a permanently busy composer.
    const profile = nativeDraftProfile(namespace, initial);
    if (!profile) return null;
    const { descriptor, identity, location, composer } = profile;
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
      await accountTransport.installFromSource(sharedSource, moduleUrl.href).catch(() => {});
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
        if (this.toolMessageListener) root.removeEventListener?.("message", this.toolMessageListener, true);
        this.toolMessageListener = null;
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
    hub.unboundThreads ||= new Set();

    // The desktop's dynamic-tool executor also listens directly on window.
    // Capture our same-page calls before that independent native listener can
    // reject an otherwise valid unnamespaced project tool or reply twice.
    if (hub.toolMessageListener) root.removeEventListener?.("message", hub.toolMessageListener, true);
    hub.toolMessageListener = event => {
      if (event.source !== root || event.origin !== root.location?.origin) return;
      let message = event.data;
      if (typeof message === "string") { try { message = JSON.parse(message); } catch { return; } }
      const request = message?.serverRequest, params = request?.params;
      if (message?.type !== "dynamic-tool-call-requested" || (message.hostId || LOCAL) !== LOCAL || request?.method !== "item/tool/call" || params?.namespace != null || !toolNames.has(params?.tool || params?.name)) return;
      event.stopImmediatePropagation();
      hub.run(handleTool(hub, message));
    };
    root.addEventListener?.("message", hub.toolMessageListener, true);

    hub.sendWrapper = function wrappedNativeSend(message) {
      const client = hub.activeClient();
      const request = message?.request;
      const method = request?.method;
      const blocked = hub.latestClient();
      const ownedThread = hub.threads.get(threadKey(message.hostId, request?.params?.threadId));
      if (message.source !== "better-codex" && message?.type === "mcp-request" && (method === "turn/start" && readOnly(ownedThread?.context) || method === "thread/start" && blocked?.blocksReadOnlyInput() && (message.hostId || LOCAL) === blocked.current.host_id)) {
        hub.deliver(responseError(message, "此会话仅供查看，请选择当前工作会话"));
        return;
      }
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
        if (client && message.source !== "better-codex" && (message.hostId || LOCAL) === client.current.host_id && !client.current.thread_id && !scope) {
          // A reload can lose the in-memory scope after the durable bind.
          // Verify the exact thread and target with Runtime before rejecting it.
          hub.run(recoverBoundTurn(hub, client, message));
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
        if (typeof name === "string" && name.startsWith(PREFIX) && params?.namespace == null) {
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

  async function recoverPending(hub, client, context) {
    const operation = context.pending_operation;
    if (readOnly(context) || operation?.status !== "outcome_unknown" || !operation.thread_id) return { context, recovered: false };
    const scope = { hub, client, context, operation };
    const result = await post(scope, "recover", operationIdentity(scope));
    assertReturnedTarget(context, result); assertReturnedTarget(context, result?.target);
    if (!result?.recovered) throw Error("上次发送结果仍在核对，请稍后重试。");
    return { context: refreshedContext(context, result), recovered: true };
  }

  async function recoverBoundTurn(hub, client, message) {
    const draft = client.current && { ...client.current };
    const deny = (reason = "当前会话尚未绑定，请重新发送") => {
      hub.deliver(responseError(message, reason));
      client.report(Error(reason), draft);
    };
    const threadId = message.request.params?.threadId;
    if (!draft || !threadId || hub.unboundThreads.has(threadKey(message.hostId, threadId))) return deny();
    try {
      const query = new URLSearchParams({ ...targetIdentity(draft), relay_id: client.options.getRelayId?.() || draft.relay_id, host_id: draft.host_id });
      const latest = await client.options.api(API_ROOT + "context?" + query);
      assertReturnedTarget(draft, latest);
      assertReturnedTarget(draft, latest?.target);
      let context = refreshedContext(draft, latest);
      if (latest?.mode !== "thread" || latest?.thread_id !== threadId || !latest.binding || context.host_id !== (message.hostId || LOCAL) || readOnly(context) ||
          hub.unboundThreads.has(threadKey(context.host_id, threadId)) || client.disposed || !client.current || targetKey(client.current) !== targetKey(draft) ||
          (client.current.thread_id && client.current.thread_id !== threadId)) return deny();
      let pending = latest.pending_operation;
      if (pending?.status === "outcome_unknown" && pending.thread_id === threadId) {
        const recovered = await recoverPending(hub, client, context);
        context = recovered.context;
        pending = null;
      }
      if (pending && (pending.status !== "bound" || pending.thread_id !== threadId || pending.host_id !== context.host_id || !pending.request_id)) return deny("会话连接结果尚待核对，请稍后重试");
      if (context.mode !== "thread" || context.thread_id !== threadId || readOnly(context) || client.disposed || !client.current || targetKey(client.current) !== targetKey(draft) ||
          hub.unboundThreads.has(threadKey(context.host_id, threadId)) || (client.current.thread_id && client.current.thread_id !== threadId)) return deny("会话连接结果尚待核对，请稍后重试");
      const scope = { hub, client, context, operation: pending || null, awaitingFirstTurn: !!pending };
      hub.threads.set(threadKey(context.host_id, threadId), scope);
      client.current = { ...client.current, ...context };
      try { client.options.onBound?.({ target: { ...draft }, origin_target: { ...draft }, context: { ...context }, thread_id: threadId, binding: latest.binding }); }
      catch (error) { client.report(error, draft); }
      await beginTurn(hub, scope, message);
    } catch (error) {
      deny("会话连接暂时无法核对，请稍后重试");
    }
  }

  async function beginTurn(hub, threadScope, message) {
    if (readOnly(threadScope.context)) { hub.deliver(responseError(message, "此会话仅供查看，请选择当前工作会话")); return; }
    const key = requestKey(message.hostId, message.request.id);
    if (hub.requests.has(key)) return;
    const scope = { ...threadScope, context: { ...threadScope.context }, operation: threadScope.awaitingFirstTurn ? threadScope.operation : null };
    const pending = { type: "turn", scope, message };
    hub.requests.set(key, pending);
    try {
      const skillPaths = (message.request.params?.input || []).filter(item => item?.type === "skill").map(item => item.path);
      if (skillPaths.length) await post(scope, "validate-input", { thread_id: message.request.params.threadId, host_id: scope.context.host_id, skill_paths: skillPaths });
      const client = hub.latestClient() || scope.client;
      const target = scope.context;
      const query = new URLSearchParams({ project_id: target.project_id, kind: target.kind, relay_id: client.options.getRelayId?.() || target.relay_id, host_id: target.host_id });
      if (target.issue_id) query.set("issue_id", target.issue_id);
      if (conversationId(target)) query.set("conversation_id", conversationId(target));
      if (target.history_id) query.set("history_id", target.history_id);
      const latest = await client.options.api(API_ROOT + "context?" + query);
      assertReturnedTarget(target, latest); assertReturnedTarget(target, latest?.target);
      let context = refreshedContext(target, latest);
      assertReturnedTarget(target, context);
      if (readOnly(context)) throw Error("此会话仅供查看，请选择当前工作会话");
      const recovery = await recoverPending(hub, client, context);
      context = recovery.context;
      if (recovery.recovered) { scope.operation = null; threadScope.operation = null; threadScope.awaitingFirstTurn = false; }
      if (conversationId(target) && conversationId(context) !== conversationId(target)) throw Error("会话资料已更新，请重新打开会话");
      if (context.thread_id !== message.request.params.threadId || context.mode !== "thread") throw Error("当前任务仍在运行，请稍后再发送");
      scope.context = context;
      if (!scope.operation) {
        const prepared = await post(scope, "prepare", {
          ...targetIdentity(context),
          host_id: context.host_id, request_id: uuid(), expected_revision: context.expected_revision,
          draft_generation: context.draft_generation, skill_paths: skillPaths
        });
        scope.operation = prepared.operation;
        assertReturnedTarget(context, scope.operation);
        assertReturnedTarget(context, prepared.target);
        if (scope.operation?.thread_id !== context.thread_id) throw Error("会话资料已更新，请重新打开会话");
        scope.context = refreshedContext(context, prepared);
        assertReturnedTarget(context, scope.context);
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
      const params = withWorkContext(hub, scope.context, message.request.params);
      hub.send(params === message.request.params ? message : { ...message, request: { ...message.request, params } });
    } catch (error) {
      hub.requests.delete(key);
      if (pending.timer) root.clearTimeout(pending.timer);
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
    if (hub.unboundThreads.has(threadKey(hostId, params.threadId))) response = { success: false, contentItems: [{ type: "inputText", text: "此会话已解除绑定" }] };
    else if (hub.calls.has(key)) response = await hub.calls.get(key);
    else {
      const work = (async () => {
        try {
          const client = hub.latestClient();
          if (hub.unboundThreads.has(threadKey(hostId, params.threadId))) throw Error("此会话已解除绑定");
          const scope = hub.threads.get(threadKey(hostId, params.threadId)) || (client && params.threadId ? { hub, client, context: { host_id: hostId, thread_id: params.threadId } } : null);
          // A restored native thread need not have been opened through this UI
          // process. The backend verifies the trusted server envelope against
          // its durable host/thread binding before allowing any document write.
          if (!scope || request?.method !== "item/tool/call" || !params.callId || !toolNames.has(name)) throw Error("项目资料工具无法确认当前会话");
          if (readOnly(scope.context)) throw Error("此会话仅供查看，请选择当前工作会话");
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
    const bridgePending = new Set();
    let bridgeDisposed = false;
    const metadataBridge = (identity, signal) => {
      if (bridgeDisposed || accountTransport.disposed) throw new DOMException("Account transport closed", "AbortError");
      signal?.throwIfAborted();
      const requestId = uuid();
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (error, data) => {
          if (settled) return; settled = true; signal?.removeEventListener("abort", abort);
          bridgePending.delete(abort); accountTransport.pending.delete(abort);
          if (error) reject(error); else resolve(data);
        };
        const abort = () => {
          if (settled) return;
          try { Promise.resolve(options.api("/api/dev/account-metadata/cancel", { method: "POST", body: JSON.stringify({ requestId }), timeoutMs: 5000 })).catch(() => {}); } catch {}
          settle(signal?.aborted && signal.reason || new DOMException("Account metadata request cancelled", "AbortError"));
        };
        bridgePending.add(abort); accountTransport.pending.add(abort);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        Promise.resolve().then(() => settled ? null : options.api("/api/dev/account-metadata", {
          method: "POST", body: JSON.stringify({ requestId, ...identity }), timeoutMs: 18000
        })).then(data => settle(null, data), error => settle(error));
      });
    };
    accountTransport.bridge = metadataBridge;
    accountTransport.recoverStartupErrors();
    let hub = null;
    let host = null;
    let hostPromise = null;
    let navigationGeneration = 0;
    let internalNavigation = 0;
    let initialRoute = "";
    let currentRoute = "";
    let boundDraftRoute = "";
    let originalNativeDraft = "";
    let registry = null;
    let retainedNavigationPromise = Promise.resolve(false);
    let pendingRetainedNavigation = null;
    function cancelRetainedNavigation() {
      const pending = pendingRetainedNavigation;
      if (!pending) return;
      pendingRetainedNavigation = null;
      if (pending.frame != null) root.cancelAnimationFrame?.(pending.frame);
      if (pending.timeout != null) root.clearTimeout(pending.timeout);
      pending.unsubscribe?.();
      pending.resolve(false);
    }
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
        // The current page may show an existing thread or have no composer.
        // Validate draft state after navigating to the requested project.
        if (!hub) {
          const existing = root[HUB_KEY];
          hub = existing && !existing.released && existing.host.sender === host.sender && existing.host.dispatcher === host.dispatcher ? existing.factory === createHub ? existing : createHub(host, existing) : createHub(host);
          hub.clients.add(this);
          if (registry) this.registerBindings(registry);
        }
        return host;
      },
      registerBindings(values) {
        registry = (Array.isArray(values) ? values : []).filter(value => value && !value.history_id && value.host_id === LOCAL && typeof value.project_id === "string" && value.project_id && typeof value.thread_id === "string" && value.thread_id && ["charter", "planning", "work"].includes(value.kind) && (value.kind !== "work" || typeof value.issue_id === "string" && value.issue_id) && (value.kind === "work" || !value.conversation_id || typeof value.conversation_id === "string")).map(value => ({ ...targetIdentity(value), host_id: LOCAL, thread_id: value.thread_id, mode: "thread", read_only: value.read_only === true }));
        if (!hub || this.disposed) return { registered: 0 };
        registry = registry.filter(context => !hub.unboundThreads.has(threadKey(context.host_id, context.thread_id)));
        const keys = new Set(registry.map(context => threadKey(context.host_id, context.thread_id)));
        for (const [key, scope] of hub.threads) {
          if (scope.client === this && readOnly(scope.context) && this.current && targetKey(scope.context) === targetKey(this.current)) continue;
          if (keys.has(key) || scope.client !== this && scope.registryClient !== this) continue;
          const pending = [...hub.requests.values()].some(request => request.scope?.context?.thread_id === scope.context.thread_id && request.scope.context.host_id === scope.context.host_id);
          if (!pending && !scope.awaitingFirstTurn) hub.threads.delete(key);
          else scope.registryRetired = true;
        }
        for (const context of registry) {
          const key = threadKey(context.host_id, context.thread_id);
          const existing = hub.threads.get(key);
          if (existing) {
            if (existing.context.history_id && this.current && targetKey(existing.context) === targetKey(this.current)) continue;
            existing.context = { ...existing.context, ...context };
            if (this.current && targetKey(existing.context) === targetKey(this.current)) existing.context.read_only = readOnly(this.current);
            existing.registryClient = this;
            existing.registryRetired = false;
          } else hub.threads.set(key, { hub, client: this, registryClient: this, context, operation: null });
        }
        return { registered: registry.length };
      },
      unregisterBinding(threadId, hostId = LOCAL) {
        const key = threadKey(hostId, threadId);
        registry = (registry || []).filter(context => threadKey(context.host_id, context.thread_id) !== key);
        if (hub) {
          hub.unboundThreads.add(key);
          hub.threads.delete(key);
          for (const owner of hub.clients) {
            if (owner.current && threadKey(owner.current.host_id, owner.current.thread_id) === key) owner.leave(true);
          }
        } else if (this.current && threadKey(this.current.host_id, this.current.thread_id) === key) this.leave(true);
        return { unregistered: true };
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
      blocksNativeInput() { return !this.disposed && (this.current?.native_open_state === "failed" || !!pendingRetainedNavigation) && options.isCurrentContext?.(this.current) !== false; },
      blocksReadOnlyInput() { return !this.disposed && readOnly(this.current) && options.isCurrentContext?.(this.current) !== false && (internalNavigation > 0 || this.ownsRoute(this.route())); },
      updateContext(value) {
        const context = flattenContext(value);
        if (!this.current || targetKey(context) !== targetKey(this.current) || context.thread_id !== this.current.thread_id || context.host_id !== this.current.host_id) return false;
        this.current = { ...this.current, ...context, read_only: readOnly(context) };
        if (hub && context.thread_id) {
          const scope = hub.threads.get(threadKey(context.host_id, context.thread_id));
          if (scope && targetKey(scope.context) === targetKey(context)) scope.context = { ...scope.context, ...context, read_only: readOnly(context) };
        }
        return true;
      },
      forgetHistory(context = this.current) {
        if (!hub || !context?.history_id) return;
        const key = threadKey(context.host_id, context.thread_id);
        const scope = hub.threads.get(key);
        if (scope?.client === this && scope.context.history_id === context.history_id) hub.threads.delete(key);
      },
      ownsRoute(route) {
        if (!this.current) return false;
        const supplied = String(route || "");
        const path = /^\/index\.html(?:\?|$)/.test(supplied) && currentRoute ? currentRoute : supplied;
        const context = this.current;
        if (context.thread_id && ["/local/" + encodeURIComponent(context.thread_id), "/local/" + context.thread_id].includes(path.split("?")[0])) {
          boundDraftRoute = "";
          return true;
        }
        if (context.thread_id && boundDraftRoute && path === boundDraftRoute && hub?.threads.get(threadKey(context.host_id, context.thread_id))?.awaitingFirstTurn) return true;
        if (context.thread_id) return false;
        try {
          const url = new URL(path, "https://codex.local");
          return url.pathname === "/projects" && !!context.native_project_id && url.searchParams.get("projectId") === context.native_project_id;
        } catch { return false; }
      },
      adoptBoundRoute(context) {
        if (!this.current || targetKey(this.current) !== targetKey(context) || this.current.thread_id !== context.thread_id) return;
        // Electron keeps /index.html in location while its memory router moves
        // from the project draft to the allocated native thread.
        boundDraftRoute = currentRoute;
        currentRoute = "/local/" + encodeURIComponent(context.thread_id);
      },
      matchesWorkspace(message) {
        if ((message.hostId || LOCAL) !== this.current.host_id) return false;
        const cwd = message.request?.params?.cwd;
        return cwd == null || normalizePath(cwd) === normalizePath(this.current.cwd);
      },
      async navigate(path, state) {
        currentRoute = path;
        if (options.navigate) return options.navigate(path, state);
        const retained = state === undefined ? retainedNativeNavigation(path) : null;
        if (retained) {
          if (!retained.selected) await retained.router.navigate(path, { state: retained.view.location.location.state, flushSync: true, preventScrollReset: true });
          if (typeof options.afterNavigate === "function") await options.afterNavigate(path);
          return;
        }
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
        cancelRetainedNavigation();
        const generation = ++navigationGeneration;
        let context = flattenContext(value);
        if (!context.project_id || !["charter", "planning", "work"].includes(context.kind) || context.kind === "work" && !context.issue_id) throw Error("项目会话资料不完整");
        if (context.conversation_id && typeof context.conversation_id !== "string") throw Error("项目会话资料不完整");
        if (context.history_id && (context.kind !== "work" || typeof context.history_id !== "string" || !context.thread_id)) throw Error("历史会话资料不完整");
        const previous = this.current;
        if (previous?.history_id && targetKey(previous) !== targetKey(context)) this.forgetHistory(previous);
        if (previous?.mode === "draft" && previous.client_draft_id && this.ownsNativeDraft()) this.saveDraft(previous.client_draft_id, previous);
        this.current = context;
        context.native_open_state = "loading";
        if (!initialRoute) initialRoute = this.route();
        if (context.mode === "legacy_busy" || context.mode === "handoff_required") return { mode: context.mode, context: { ...context }, capabilities: this.capabilities() };
        try {
          await this.ensureHost();
          if (generation !== navigationGeneration || this.disposed) return { cancelled: true };
          if (context.thread_id && hub.unboundThreads.has(threadKey(context.host_id, context.thread_id))) { this.leave(true); throw Error("此会话已解除绑定"); }
          context = (await recoverPending(hub, this, context)).context;
          if (generation !== navigationGeneration || this.disposed) return { cancelled: true };
          this.current = context;
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
      resumeRetained(value, resumeOptions = {}) {
        if (this.disposed || !host || !hub || options.navigate) return false;
        const context = flattenContext(value);
        if (hub.unboundThreads.has(threadKey(context.host_id, context.thread_id))) return false;
        if (!context.project_id || !["charter", "planning", "work"].includes(context.kind) || context.kind === "work" && !context.issue_id || !context.thread_id || context.mode === "legacy_busy" || context.mode === "handoff_required") return false;
        if (context.conversation_id && typeof context.conversation_id !== "string" || context.history_id && (context.kind !== "work" || typeof context.history_id !== "string")) return false;
        const path = "/local/" + encodeURIComponent(context.thread_id);
        const retained = retainedNativeNavigation(path);
        if (!retained) return false;
        const previous = this.current;
        if (previous?.history_id && targetKey(previous) !== targetKey(context)) this.forgetHistory(previous);
        if (previous?.mode === "draft" && previous.client_draft_id && this.ownsNativeDraft()) this.saveDraft(previous.client_draft_id, previous);
        cancelRetainedNavigation();
        const generation = ++navigationGeneration;
        if (!initialRoute) initialRoute = this.route();
        const deferred = resumeOptions.deferNavigation === true && !retained.selected;
        this.current = { ...context, native_open_state: deferred ? "loading" : "ready" };
        hub.threads.set(threadKey(context.host_id, context.thread_id), { hub, client: this, context: { ...this.current }, operation: null });
        currentRoute = path;
        if (retained.selected) { retainedNavigationPromise = Promise.resolve(true); return true; }
        const originLocation = retained.router.state.location;
        let synchronousFailure = false;
        retainedNavigationPromise = new Promise(resolve => {
          const pending = { resolve, generation, frame: null, timeout: null, unsubscribe: null, started: false };
          pendingRetainedNavigation = pending;
          const current = () => pendingRetainedNavigation === pending && generation === navigationGeneration && !this.disposed;
          const complete = ready => {
            if (pendingRetainedNavigation === pending) pendingRetainedNavigation = null;
            pending.unsubscribe?.();
            resolve(ready);
          };
          const navigate = () => {
            if (!current()) { complete(false); return; }
            if (retained.router.state.location !== originLocation) {
              const origin = { ...this.current };
              this.leave();
              this.options.onNavigateAway?.(origin);
              complete(false);
              return;
            }
            pending.started = true;
            internalNavigation++;
            let navigation;
            try { navigation = retained.router.navigate(path, { state: retained.view.location.location.state, flushSync: true, preventScrollReset: true }); }
            catch (error) {
              synchronousFailure = true;
              if (current()) { this.current = previous; this.report(error, context); }
              complete(false);
              return;
            } finally { internalNavigation--; }
            Promise.resolve(navigation).then(() => {
              if (!current()) { complete(false); return; }
              if (retained.router.state.location.pathname !== path || retained.router.state.location.search) {
                const origin = { ...this.current };
                this.leave();
                this.options.onNavigateAway?.(origin);
                complete(false);
                return;
              }
              this.current.native_open_state = "ready";
              complete(true);
            }, error => {
              if (current()) { this.current.native_open_state = "failed"; this.report(error, context); }
              complete(false);
            });
          };
          if (deferred) {
            if (typeof retained.router.subscribe === "function") pending.unsubscribe = retained.router.subscribe(state => {
              if (current() && !pending.started && (state.location !== originLocation || state.navigation?.state && state.navigation.state !== "idle" && state.navigation.location?.pathname !== path)) {
                const origin = { ...this.current };
                this.leave();
                this.options.onNavigateAway?.(origin);
              }
            });
            const afterPaint = () => { if (current()) pending.timeout = root.setTimeout(navigate, 0); else complete(false); };
            if (typeof root.requestAnimationFrame === "function") pending.frame = root.requestAnimationFrame(afterPaint);
            else pending.timeout = root.setTimeout(afterPaint, 0);
          } else navigate();
        });
        if (synchronousFailure) return false;
        return true;
      },
      waitRetainedNavigation() { return retainedNavigationPromise; },
      pinRetained(value = this.current) {
        const context = flattenContext(value);
        if (this.disposed || !context.thread_id || !context.project_id || !["charter", "planning", "work"].includes(context.kind)) return false;
        const path = "/local/" + encodeURIComponent(context.thread_id);
        const runtime = nativeNavigationRuntime();
        const view = runtime.retained?.views.find(view => view.route.pathname === path && view.route.routeKind === "local-thread");
        if (!view || !retainedExpirySlot(runtime.retainedFiber, view.key)) return false;
        let pin = root[RETAINED_PIN_KEY];
        if (pin?.key === view.key && pin.path === path) return refreshRetainedPin(pin);
        clearRetainedPin();
        pin = { active: true, key: view.key, path, lastUsed: view.lastUsed, slots: new Map(), ages: new Map(), refreshing: false };
        root[RETAINED_PIN_KEY] = pin;
        if (!refreshRetainedPin(pin)) { clearRetainedPin(false); return false; }
        if (typeof root.MutationObserver === "function" && root.document.documentElement) {
          pin.observer = new root.MutationObserver(() => {
            if (!pin.active || pin.refreshScheduled) return;
            pin.refreshScheduled = true;
            const refresh = () => {
              pin.refreshScheduled = false;
              pin.refreshFrame = pin.refreshTimeout = null;
              refreshRetainedPin(pin);
            };
            if (typeof root.requestAnimationFrame === "function") pin.refreshFrame = root.requestAnimationFrame(refresh);
            else pin.refreshTimeout = root.setTimeout(refresh, 0);
          });
          pin.observer.observe(root.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-app-shell-active-page"] });
        }
        if (typeof root.setInterval === "function") pin.timer = root.setInterval(() => refreshRetainedPin(pin), 30_000);
        return true;
      },
      async beginThread(message) {
        const context = { ...this.current };
        if (readOnly(context)) { hub.deliver(responseError(message, "此会话仅供查看，请选择当前工作会话")); return; }
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
          if (pending.timer) root.clearTimeout(pending.timer);
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
          receiver.adoptBoundRoute(scope.context);
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
        cancelRetainedNavigation();
        const generation = ++navigationGeneration;
        this.forgetHistory();
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
        this.current = null; currentRoute = ""; boundDraftRoute = ""; originalNativeDraft = "";
      },
      destroy() {
        if (this.disposed) return;
        bridgeDisposed = true;
        for (const cancel of [...bridgePending]) cancel();
        if (accountTransport.bridge === metadataBridge) accountTransport.bridge = null;
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
      unregisterBinding: client.unregisterBinding.bind(client),
      mount: client.open.bind(client), open: client.open.bind(client),
      leave: () => client.leave(), destroy: client.destroy.bind(client),
      capture: client.capture.bind(client), restore: client.restore.bind(client),
      resumeRetained: client.resumeRetained.bind(client),
      waitRetainedNavigation: client.waitRetainedNavigation.bind(client),
      pinRetained: client.pinRetained.bind(client), clearRetainedPin,
      capabilities: client.capabilities.bind(client), ownsRoute: client.ownsRoute.bind(client),
      inspectLayout: client.inspectLayout.bind(client),
      getCurrentContext: client.getCurrentContext.bind(client),
      updateContext: client.updateContext.bind(client)
    };
  }

  root.BetterCodexNativeConversation = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);

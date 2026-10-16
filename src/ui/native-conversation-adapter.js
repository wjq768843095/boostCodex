"use strict";
// Preserve native account settings recovery without owning the conversation tree.
(function installAccountSettingsAdapter(root) {
  // Recover only the account-list GET through the local authenticated transport
  // after the native transport has completed its policy checks and returned a
  // Cloudflare challenge. The backend verifies the native token's user, fetches
  // fresh metadata, and refuses organization routing. Native policy checks and
  // the query's before/after identity assertions still consume the real result.
  const legacy = root.__betterCodexAccountTransportRecovery__;
  if (legacy && legacy !== root.__boostCodexAccountTransportRecovery__) legacy.dispose?.();
  if (root.__betterCodexAccountTransportRecovery__ === legacy) delete root.__betterCodexAccountTransportRecovery__;
  root.__boostCodexAccountTransportRecovery__?.dispose?.();
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
  root.__boostCodexAccountTransportRecovery__ = accountTransport;
  function create(options) {
    if (typeof options?.api !== "function") throw Error("Account metadata API is required");
    const bridgePending = new Set();
    let bridgeDisposed = false;
    const metadataBridge = (identity, signal) => {
      if (bridgeDisposed || accountTransport.disposed) throw new DOMException("Account transport closed", "AbortError");
      signal?.throwIfAborted();
      const requestId = root.crypto.randomUUID();
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
    let connecting = null;
    async function connect() {
      if (bridgeDisposed || accountTransport.disposed) return false;
      if (accountTransport.request) return true;
      if (connecting) return connecting;
      connecting = (async () => {
        if (!root.document || !root.fetch || !root.location) return false;
        const trusted = value => {
          const url = new URL(value, root.location.href);
          return url.origin === root.location.origin && url.pathname.startsWith("/assets/") ? url : null;
        };
        const visited = new Set();
        const install = async url => {
          if (!url || visited.has(url.href) || bridgeDisposed || accountTransport.disposed) return false;
          visited.add(url.href);
          try {
            const response = await root.fetch(url.href);
            const source = await response.text();
            if (bridgeDisposed || accountTransport.disposed) return false;
            await accountTransport.installFromSource(source, url.href);
          } catch { /* Another native entry may contain the active request module. */ }
          return !!accountTransport.request;
        };
        for (const link of root.document.querySelectorAll('link[rel="modulepreload"][href]')) {
          const url = trusted(link.href);
          if (url && /app-shared-[^/]+\.js$/.test(url.pathname) && await install(url)) return true;
        }
        for (const script of root.document.querySelectorAll('script[type="module"][src]')) {
          if (bridgeDisposed || accountTransport.disposed) return false;
          const entry = trusted(script.src);
          if (!entry) continue;
          try {
            const response = await root.fetch(entry.href);
            const source = await response.text();
            const sharedName = /["'`]([^"'`]*app-shared-[^"'`]+\.js)["'`]/.exec(source)?.[1];
            const shared = sharedName && trusted(new URL(sharedName, entry).href);
            if (shared && await install(shared)) return true;
          } catch { /* Keep looking through the other native entries. */ }
        }
        return false;
      })().finally(() => { connecting = null; });
      return connecting;
    }
    function destroy() {
      if (bridgeDisposed) return;
      bridgeDisposed = true;
      for (const cancel of [...bridgePending]) cancel();
      if (accountTransport.bridge === metadataBridge) accountTransport.bridge = null;
    }
    return { connect, destroy };
  }
  // Keep the installed bridge name stable across desktop reinjection.
  root.boostCodexNativeConversation = Object.freeze({ create });
})(typeof window !== "undefined" ? window : globalThis);

"use strict";
var BetterCodexWorkflowPanel = (() => {
  const OWNER = "better-codex-global-workflow-panel";
  const TAB = "manual:better-codex-global-workflow-panel";
  const MESSAGE = "面板暂时无法打开，请稍后重试。";
  let nativePromise = null;

  function findScope(shared, document) {
    const seen = new Set();
    for (const element of document.querySelectorAll("[data-app-shell-main-content-layout],[data-codex-composer]")) {
      let fiber = element[Object.keys(element).find(key => key.startsWith("__reactFiber$"))];
      for (; fiber; fiber = fiber.return) {
        for (let dependency = fiber.dependencies?.firstContext; dependency; dependency = dependency.next) {
          const chain = dependency.memoizedValue;
          if (!(chain instanceof Map)) continue;
          for (const node of chain.values()) {
            if (node?.token !== shared.Q4 || seen.has(node)) continue;
            seen.add(node);
            // Ask the existing scope runtime for its public wrapper. No chat
            // messages or project data are read to decide which page to open.
            const binding = shared.son(node.token, (_key, context) => context.scope);
            let scope;
            try { scope = binding.resolve(node, chain, null); }
            finally { node.familyBindings.delete(binding); }
            if (scope.value.pathname === scope.get(shared.z1t)?.pathname) return scope;
          }
        }
      }
    }
    throw new Error("panel_native_scope_unavailable");
  }

  function assetUrl(stem) {
    const names = [...document.querySelectorAll('link[rel="modulepreload"]')].map(link => link.href)
      .concat(performance.getEntriesByType("resource").map(entry => entry.name));
    const pattern = new RegExp("/assets/" + stem + "-[^/]+\\.js$");
    const found = names.find(name => pattern.test(name));
    if (!found) throw new Error("panel_native_bundle_unavailable");
    const url = new URL(found, document.baseURI);
    if (url.protocol !== "app:" || url.origin !== window.location.origin) throw new Error("panel_native_bundle_invalid");
    return url.href;
  }

  async function loadNative() {
    if (!nativePromise) nativePromise = (async () => {
      const [shared, initial] = await Promise.all([import(assetUrl("app-shared")), import(assetUrl("app-initial"))]);
      if (typeof shared.son !== "function" || !shared.Q4 || !shared.z1t ||
          typeof initial.Bpt !== "function" || typeof initial.rpn !== "function" ||
          !initial.sgn?.updateTab || !initial.UPt?.pages?.getHost) throw new Error("panel_native_contract_changed");
      const getScope = () => findScope(shared, document);
      return {
        getScope,
        host: () => initial.UPt.pages.getHost(OWNER, TAB),
        snapshot: () => initial.UPt.getSnapshot(OWNER, TAB),
        async authRequired() {
          const webview = initial.UPt.pages.getHost(OWNER, TAB)?.webview;
          if (typeof webview?.executeJavaScript !== "function") return false;
          try { return await webview.executeJavaScript("document.documentElement.dataset.panelAuth === 'required'") === true; }
          catch { return false; }
        },
        open: (scope, initialUrl) => initial.Bpt(scope, {
          browserConversationId: OWNER, browserTabId: TAB, browserHostDisplayName: "面板",
          cwd: null, target: "right", source: "manual", initiator: "side_panel_menu",
          ...(initialUrl ? { initialUrl } : {})
        }),
        active: scope => scope.get(initial.sgn.activeTab$)?.tabId === TAB &&
          !!scope.get(initial.nGn) && !!scope.get(initial.rGn),
        hide: scope => initial.rpn(scope, "right"),
        retainOnClose(scope) {
          // Only this tab changes close behavior. Native tab removal hides its
          // presentation; the global webContents remains available for reopen.
          initial.sgn.updateTab(scope, TAB, { onClose: () => {
            if (scope.get(initial.sgn.activeTab$)?.tabId === TAB) initial.rpn(scope, "right");
          } });
        }
      };
    })().catch(error => { nativePromise = null; throw error; });
    return nativePromise;
  }

  function localPanelUrl(value) {
    const url = new URL(String(value));
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error("panel_url_invalid");
    }
    return url.href;
  }

  function panelTarget(value) {
    if (typeof value === "string") {
      const url = localPanelUrl(value);
      return { url, stableUrl: url, launchOrigin: null };
    }
    if (!value || typeof value !== "object" || typeof value.url !== "string" || typeof value.stableUrl !== "string") {
      throw new Error("panel_url_invalid");
    }
    const url = new URL(localPanelUrl(value.url)), stable = new URL(localPanelUrl(value.stableUrl));
    if (url.origin !== stable.origin || url.pathname !== "/launch" || url.hash ||
        !url.searchParams.get("ticket") || [...url.searchParams.keys()].some(key => key !== "ticket") ||
        stable.pathname !== "/" || stable.search || stable.hash) throw new Error("panel_url_invalid");
    return { url: url.href, stableUrl: stable.href, launchOrigin: stable.origin };
  }

  function matchesTarget(snapshot, target) {
    if (!target.launchOrigin) return (snapshot?.committedUrl || snapshot?.url) === target.stableUrl;
    const urls = [snapshot?.url, snapshot?.committedUrl].filter(Boolean);
    if (!urls.length) return false;
    try {
      const parsed = urls.map(value => new URL(value));
      if (parsed.every(url => url.href === target.stableUrl)) return true;
      const belongsToPanel = url => url.href === target.stableUrl ||
        url.origin === target.launchOrigin && url.pathname === "/launch" && !url.hash &&
        !!url.searchParams.get("ticket") && [...url.searchParams.keys()].every(key => key === "ticket");
      if (snapshot?.committedUrl === target.stableUrl && parsed.every(belongsToPanel)) return true;
      // A previous one-time launch may still be redirecting. Do not interrupt
      // it with the next ticket; only this exact local bootstrap route qualifies.
      return !!(snapshot?.isLoading || snapshot?.isWaitingForResponse) && parsed.every(belongsToPanel);
    } catch { return false; }
  }

  function create({ getPanelUrl, reportError = () => {}, native = null } = {}) {
    if (typeof getPanelUrl !== "function") throw new TypeError("getPanelUrl is required");
    let destroyed = false, opening = null, driver = native;
    function fail(error) {
      // Native/transport exceptions can contain a launch URL. Keep bootstrap
      // credentials out of diagnostics, including unexpected error messages.
      const code = /^panel_[a-z_]+$/.test(error?.message || "") ? error.message : "panel_native_failed";
      if (typeof console !== "undefined") console.warn("Better Codex panel compatibility", { code });
      if (!destroyed) reportError(new Error(MESSAGE));
      return false;
    }
    async function performOpen() {
      try {
        driver ||= await loadNative();
        const target = panelTarget(await getPanelUrl());
        if (destroyed) return false;
        const scope = driver.getScope();
        const host = driver.host(), snapshot = driver.snapshot();
        let needsNavigation = !host || host.disposed || snapshot?.isSuspended ||
          !matchesTarget(snapshot, target);
        if (!needsNavigation && !snapshot?.isLoading && !snapshot?.isWaitingForResponse &&
            (snapshot?.committedUrl || snapshot?.url) === target.stableUrl && driver.authRequired) needsNavigation = await driver.authRequired();
        if (destroyed) return false;
        if (!driver.open(scope, needsNavigation ? target.url : undefined)) throw new Error("panel_native_open_rejected");
        driver.retainOnClose(scope);
        return true;
      } catch (error) { return fail(error); }
    }
    return {
      open() {
        if (destroyed) return Promise.resolve(false);
        if (!opening) opening = performOpen().finally(() => { opening = null; });
        return opening;
      },
      hide() {
        if (destroyed || !driver) return false;
        try { const scope = driver.getScope(); if (!driver.active(scope)) return false; driver.hide(scope); return true; }
        catch (error) { return fail(error); }
      },
      capture() {
        try { return { open: !destroyed && !!driver && driver.active(driver.getScope()) }; }
        catch { return { open: false }; }
      },
      // Reinjection releases the adapter, not the native global page.
      destroy() { destroyed = true; }
    };
  }
  return { create };
})();
if (typeof window !== "undefined") window.BetterCodexWorkflowPanel = BetterCodexWorkflowPanel;
if (typeof module !== "undefined" && module.exports) module.exports = BetterCodexWorkflowPanel;

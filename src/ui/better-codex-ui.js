"use strict";
var BetterCodexInjected = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  var injected_entry_exports = {};
  __export(injected_entry_exports, {
    install: () => install
  });

  function updateOutcome(update) {
    const status = String(update.operation?.status || "");
    if (status === "COMPLETED") return "completed";
    if (["ROLLED_BACK", "FAILED"].includes(status) && (update.recovery?.status === "restored" || update.recovery === "restored")) return "rolled_back";
    if (update.recovery?.status === "failed" || update.recovery === "failed") return "recovery_failed";
    if (status === "ROLLING_BACK") return "recovering";
    if (status === "FAILED") return "failed";
    if (update.status === "unknown") return "unknown";
    if (status && !["COMPLETED", "ROLLED_BACK", "FAILED"].includes(status)) return "updating";
    return update.status === "available" ? "available" : "idle";
  }
  function createUpdateObserver(options) {
    const key = `${options.namespace}-request`;
    let watching = null;
    let changed = null;
    const pending = () => {
      const value = options.storage.getItem(key);
      return value ? JSON.parse(value) : null;
    };
    const persist = (value) => options.storage.setItem(key, JSON.stringify(value));
    const accept = async (value) => {
      const response = await options.request("/install", { method: "POST", body: JSON.stringify({ idempotency_key: value.key, ...value.target ? { target_version: value.target } : {} }), timeoutMs: 45e3 });
      if (response.accepted !== true || typeof response.update_id !== "string") throw new Error("update_not_accepted");
      value.id = response.update_id;
      persist(value);
    };
    return {
      pending,
      adopt(update) {
        if (!pending() && update.operation?.id && ["updating", "recovering"].includes(updateOutcome(update))) persist({ id: update.operation.id, key: update.operation.id, target: update.operation.target_core_version || "" });
      },
      async start(target = "") {
        let value = pending();
        if (!value) {
          value = { key: crypto.randomUUID(), target };
          persist(value);
        }
        if (!value.id) {
          try {
            await accept(value);
          } catch (error) {
            if (!options.transient(error)) throw error;
          }
        }
      },
      observe(onState) {
        changed = onState;
        if (watching) return watching;
        const work = (async () => {
          const deadline = Date.now() + 30 * 60 * 1e3;
          let last = {};
          let submissions = 0;
          let observed = pending();
          let phase = "";
          while (!options.stopped() && Date.now() < deadline) {
            const stored = pending();
            if (!observed || stored?.key === observed.key) observed = stored || observed;
            const value = observed;
            if (!value) return null;
            try {
              last = await options.request(value.id ? "?update_id=" + encodeURIComponent(value.id) : "?idempotency_key=" + encodeURIComponent(value.key), { passive: true });
              if (last.operation?.id) {
                value.id = last.operation.id;
                if (pending()?.key === value.key) persist(value);
              }
              if (phase !== last.operation?.status) {
                phase = last.operation?.status || "";
                options.diagnostic?.({ update_id: value.id, phase, shared_request_present: Boolean(stored), recovery: last.recovery });
              }
              changed?.(last);
              if (["completed", "rolled_back", "failed", "recovery_failed"].includes(updateOutcome(last))) {
                if (pending()?.key === value.key) options.storage.removeItem(key);
                return last;
              }
            } catch (error) {
              if (!value.id && String(error).includes("update_operation_not_found") && submissions < 3) {
                submissions += 1;
                try {
                  await accept(value);
                } catch (failure) {
                  if (!options.transient(failure)) throw failure;
                }
              } else if (!options.transient(error)) {
                changed?.({ ...last, status: "unknown", operation: null, error: String(error), requires_action: true });
                return null;
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          if (!options.stopped()) changed?.({ ...last, status: "unknown", operation: null });
          return null;
        })().finally(() => {
          watching = null;
        });
        watching = work;
        return work;
      }
    };
  }

  function createCommandObserver(options) {
    const observations = /* @__PURE__ */ new Map();
    const delays = [300, 700, 1500, 3e3, 5e3, 1e4, 3e4];
    let destroyed = false;
    function remove(id, observation) {
      if (observation.timer !== null) clearTimeout(observation.timer);
      if (observations.get(id) === observation) observations.delete(id);
    }
    function schedule(id, observation) {
      observation.timer = setTimeout(async () => {
        observation.timer = null;
        if (destroyed || observations.get(id) !== observation) return;
        let receipt;
        try {
          receipt = await options.read(id);
        } catch (error) {
          if (destroyed || observations.get(id) !== observation) return;
          if (options.retryable(error)) {
            observation.attempt += 1;
            schedule(id, observation);
            return;
          }
          remove(id, observation);
          const failure = error instanceof Error ? error : new Error(String(error));
          for (const listener of observation.listeners) listener.reject(failure);
          return;
        }
        if (destroyed || observations.get(id) !== observation) return;
        if (["pending", "dispatched", "processing"].includes(receipt.status) || receipt.queued === true) {
          observation.attempt += 1;
          schedule(id, observation);
          return;
        }
        remove(id, observation);
        options.diagnostic("command_observed", { command_id: id, status: receipt.status, attempt_count: observation.attempt + 1 });
        for (const listener of observation.listeners) listener.resolve(receipt);
      }, delays[Math.min(observation.attempt, delays.length - 1)]);
    }
    function subscribe(id, listener) {
      if (destroyed) throw new Error("command_observer_destroyed");
      let observation = observations.get(id);
      if (!observation) {
        observation = { attempt: 0, timer: null, listeners: /* @__PURE__ */ new Set() };
        observations.set(id, observation);
        schedule(id, observation);
      }
      observation.listeners.add(listener);
      const current = observation;
      return () => {
        current.listeners.delete(listener);
        if (!current.listeners.size) remove(id, current);
      };
    }
    return {
      watch: subscribe,
      wait(id, timeoutMs) {
        if (destroyed) return Promise.reject(new Error("command_observer_destroyed"));
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error("remote_command_timeout"));
          }, timeoutMs);
          const unsubscribe = subscribe(id, {
            resolve(receipt) {
              clearTimeout(timeout);
              unsubscribe();
              resolve(receipt);
            },
            reject(error) {
              clearTimeout(timeout);
              unsubscribe();
              reject(error);
            }
          });
        });
      },
      destroy() {
        destroyed = true;
        for (const [id, observation] of observations) {
          remove(id, observation);
          for (const listener of observation.listeners) listener.reject(new Error("command_observer_destroyed"));
        }
      }
    };
  }

  function sessionThreadMissing(error) {
    const value = String(error instanceof Error ? error.message : error || "").toLowerCase();
    return ["thread not found", "thread_not_found", "rollout not found", "no rollout found", "thread_not_materialized"].some((code) => value.includes(code));
  }

  function conversationEmptyState(input) {
    if (input.failed) return {
      title: input.started ? "任务执行失败" : "任务尚未启动",
      description: sessionThreadMissing(input.error) ? "会话记录尚不可恢复，需要先处理会话绑定问题。" : "请查看下方失败原因，处理后再继续。",
      hint: "原始任务内容已保留"
    };
    if (input.running) return {
      title: input.started ? "正在处理任务" : "正在启动任务",
      description: input.started ? "智能体回复产生后会显示在这里。" : "请求已接收，正在准备会话。",
      hint: "请稍候"
    };
    return input.hasThread ? { title: "开始对话", description: "补充下一步要求，智能体会继续处理。", hint: "在下方输入消息并发送" } : { title: "尚未开始对话", description: "发送消息后将开始处理任务。", hint: "在下方输入消息并发送" };
  }

  function createInjectedHostAdapter(capabilities) {
    return { kind: "codex", remote: false, relay: false, capabilities: capabilities && typeof capabilities === "object" ? capabilities : {} };
  }


  function createHostAdapter(kind, host, relay) {
    
    const source = host && typeof host === "object" ? host : {};
    return createInjectedHostAdapter(source.capabilities);
  }

  function injectedElementVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.inert || ancestor.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    if (getComputedStyle(element).display === "contents") return Array.from(element.children).some(injectedElementVisible);
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight;
  }
  function findInjectedMount(selectors, ownedAttribute, isVisible = injectedElementVisible) {
    const native = (element) => !element.closest(`[${ownedAttribute}="true"]`);
    const layouts = /* @__PURE__ */ new Set();
    document.querySelectorAll(selectors.contentFrame).forEach((frame) => {
      if (!native(frame)) return;
      const layout = frame.closest(selectors.contentLayout);
      if (layout) layouts.add(layout);
    });
    document.querySelectorAll(selectors.contentLayout).forEach((layout) => {
      if (native(layout)) layouts.add(layout);
    });
    for (const layout of layouts) {
      const surface = layout.parentElement;
      if (surface?.closest("main") && native(surface) && isVisible(layout) && isVisible(surface)) return surface;
    }
    for (const main of document.querySelectorAll("main")) {
      if (!native(main) || !isVisible(main)) continue;
      return main;
    }
    return null;
  }

  var betterCodexThemeColors = {
    light: { canvas: "#ffffff", navigation: "#f8f8f8", surface: "#f8f8f8", raised: "#ededee", control: "#f3f3f4", hover: "#eaeaeb", pressed: "#e3e3e4", hairline: "#e5e5e6", ink: "#1a1c1f", accent: "#339cff" },
    dark: { canvas: "#1e1e1e", navigation: "#181818", surface: "#232323", raised: "#2c2c2c", control: "#272727", hover: "#2f2f2f", pressed: "#343434", hairline: "#323232", ink: "#d4d4d4", accent: "#007acc" }
  };
  var codexSemanticTokens = [
    { name: "--bc-color-canvas", layer: "codex-semantic", light: `var(--bc-host-light-canvas, ${betterCodexThemeColors.light.canvas})`, dark: `var(--bc-host-dark-canvas, ${betterCodexThemeColors.dark.canvas})`, hostOverridable: true, order: 35 },
    { name: "--bc-color-navigation", layer: "codex-semantic", light: betterCodexThemeColors.light.navigation, dark: betterCodexThemeColors.dark.navigation, hostOverridable: false, order: 36 },
    { name: "--bc-color-surface", layer: "codex-semantic", light: `var(--bc-host-light-surface, ${betterCodexThemeColors.light.surface})`, dark: `var(--bc-host-dark-surface, ${betterCodexThemeColors.dark.surface})`, hostOverridable: true, order: 37 },
    { name: "--bc-color-surface-raised", layer: "codex-semantic", light: `var(--bc-host-light-raised, ${betterCodexThemeColors.light.raised})`, dark: `var(--bc-host-dark-raised, ${betterCodexThemeColors.dark.raised})`, hostOverridable: true, order: 38 },
    { name: "--bc-color-control", layer: "codex-semantic", light: `var(--bc-host-light-control, ${betterCodexThemeColors.light.control})`, dark: `var(--bc-host-dark-control, ${betterCodexThemeColors.dark.control})`, hostOverridable: true, order: 39 },
    { name: "--bc-color-input", layer: "codex-semantic", light: "var(--bc-color-canvas)", dark: "var(--bc-color-control)", hostOverridable: false, order: 40 },
    { name: "--bc-color-hover", layer: "codex-semantic", light: `var(--bc-host-light-hover, ${betterCodexThemeColors.light.hover})`, dark: `var(--bc-host-dark-hover, ${betterCodexThemeColors.dark.hover})`, hostOverridable: true, order: 41 },
    { name: "--bc-color-pressed", layer: "codex-semantic", light: `var(--bc-host-light-pressed, ${betterCodexThemeColors.light.pressed})`, dark: `var(--bc-host-dark-pressed, ${betterCodexThemeColors.dark.pressed})`, hostOverridable: true, order: 42 },
    { name: "--bc-color-hairline", layer: "codex-semantic", light: `var(--bc-host-light-hairline, ${betterCodexThemeColors.light.hairline})`, dark: `var(--bc-host-dark-hairline, ${betterCodexThemeColors.dark.hairline})`, hostOverridable: true, order: 43 },
    { name: "--bc-color-text", layer: "codex-semantic", light: `var(--bc-host-light-ink, ${betterCodexThemeColors.light.ink})`, dark: `var(--bc-host-dark-ink, ${betterCodexThemeColors.dark.ink})`, hostOverridable: true, order: 44 },
    { name: "--bc-color-text-muted", layer: "codex-semantic", light: "color-mix(in srgb, var(--bc-color-text) 62%, var(--bc-color-canvas))", hostOverridable: false, order: 45 },
    { name: "--bc-color-text-faint", layer: "codex-semantic", light: "color-mix(in srgb, var(--bc-color-text) 44%, var(--bc-color-canvas))", hostOverridable: false, order: 46 },
    { name: "--bc-color-focus", layer: "codex-semantic", light: `var(--bc-host-light-accent, ${betterCodexThemeColors.light.accent})`, dark: `var(--bc-host-dark-accent, ${betterCodexThemeColors.dark.accent})`, hostOverridable: true, order: 47 },
    { name: "--bc-color-info", layer: "codex-semantic", light: "var(--bc-color-focus)", hostOverridable: false, order: 48 },
    { name: "--bc-color-primary", layer: "codex-semantic", light: "var(--bc-color-text)", dark: "var(--bc-color-text)", hostOverridable: false, order: 49 },
    { name: "--bc-color-on-primary", layer: "codex-semantic", light: "var(--bc-color-canvas)", dark: "var(--bc-color-canvas)", hostOverridable: false, order: 50 },
    { name: "--bc-color-scrim", layer: "codex-semantic", light: "rgb(18 18 20 / .28)", dark: "rgb(0 0 0 / .56)", hostOverridable: false, order: 61 }
  ];

  var betterCodexDefaultUiFont = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  var betterCodexDefaultHostTheme = {
    schemaVersion: 1,
    source: "fallback",
    theme: "system",
    light: { accent: betterCodexThemeColors.light.accent, contrast: 45, ink: betterCodexThemeColors.light.ink, surface: betterCodexThemeColors.light.canvas, uiFont: betterCodexDefaultUiFont },
    dark: { accent: betterCodexThemeColors.dark.accent, contrast: 50, ink: betterCodexThemeColors.dark.ink, surface: betterCodexThemeColors.dark.canvas, uiFont: betterCodexDefaultUiFont },
    capabilities: ["light", "dark", "font-family", "contrast"]
  };

  function channels(value) {
    const match = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!match) throw new Error(`invalid_theme_color:${value}`);
    return match.slice(1).map((channel) => Number.parseInt(channel, 16));
  }
  function luminance(value) {
    const values = channels(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  }
  function contrast(left, right) {
    const first = luminance(left);
    const second = luminance(right);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }
  function mixedColor(ink, canvas, percentage) {
    const foreground = channels(ink);
    const background = channels(canvas);
    const ratio = percentage / 100;
    return `#${foreground.map((channel, index) => Math.round(channel * ratio + background[index] * (1 - ratio)).toString(16).padStart(2, "0")).join("")}`;
  }
  function guardedProfile(mode, profile2, adjusted) {
    const fallback = betterCodexDefaultHostTheme[mode];
    const next = { ...profile2 };
    if (contrast(next.ink, next.surface) < 4.5) {
      next.ink = fallback.ink;
      adjusted.push(`${mode}.ink`);
    }
    if (contrast(next.accent, next.surface) < 2) {
      next.accent = fallback.accent;
      adjusted.push(`${mode}.accent`);
    }
    return next;
  }
  function deriveHostTheme(input, colorMixSupported) {
    const tokens = {};
    const contrastAdjustedTokens = [];
    for (const mode of ["light", "dark"]) {
      const profile2 = guardedProfile(mode, input[mode], contrastAdjustedTokens);
      const amount = (value) => Math.round(value * profile2.contrast / 50 * 100) / 100;
      const layer = (value) => colorMixSupported ? `color-mix(in srgb, ${profile2.ink} ${amount(value)}%, ${profile2.surface})` : mixedColor(profile2.ink, profile2.surface, amount(value));
      const prefix = `--bc-host-${mode}-`;
      tokens[`${prefix}canvas`] = profile2.surface;
      tokens[`${prefix}ink`] = profile2.ink;
      tokens[`${prefix}accent`] = profile2.accent;
      tokens[`${prefix}surface`] = layer(2.5);
      tokens[`${prefix}control`] = layer(5);
      tokens[`${prefix}raised`] = layer(7.5);
      tokens[`${prefix}hover`] = layer(9);
      tokens[`${prefix}pressed`] = layer(12);
      tokens[`${prefix}hairline`] = layer(11);
      tokens[`${prefix}font-ui`] = profile2.uiFont;
    }
    return { tokens, contrastAdjustedTokens };
  }

  function themeCapabilitySignature(host, declared, colorMixSupported, fontFamilySupported) {
    return [host, ...declared, `color-mix:${colorMixSupported ? "yes" : "no"}`, `font-family:${fontFamilySupported ? "yes" : "no"}`].sort().join("|");
  }
  function themeIsDegraded(diagnostics) {
    return diagnostics.invalidTokens.length > 0 || diagnostics.fallbackTokens.length > 0 || diagnostics.contrastAdjustedTokens.length > 0;
  }

  function object(value) {
    return value && typeof value === "object" ? value : {};
  }
  function unique(values) {
    return [...new Set(values)].sort();
  }
  function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
  }
  function profile(value, mode, missingTokens, invalidTokens, fallbackTokens) {
    const source = object(value);
    const fallback = betterCodexDefaultHostTheme[mode];
    const readColor = (key) => {
      const path = `${mode}.${key}`;
      if (source[key] === void 0 || source[key] === "") {
        missingTokens.push(path);
        fallbackTokens.push(path);
        return fallback[key];
      }
      if (typeof source[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(source[key])) {
        invalidTokens.push(path);
        fallbackTokens.push(path);
        return fallback[key];
      }
      return source[key].toLowerCase();
    };
    const contrastValue = Number(source.contrast);
    let contrast2 = contrastValue;
    if (source.contrast === void 0 || source.contrast === "") {
      missingTokens.push(`${mode}.contrast`);
      fallbackTokens.push(`${mode}.contrast`);
      contrast2 = fallback.contrast;
    } else if (!Number.isFinite(contrastValue) || contrastValue < 0 || contrastValue > 100) {
      invalidTokens.push(`${mode}.contrast`);
      fallbackTokens.push(`${mode}.contrast`);
      contrast2 = fallback.contrast;
    }
    let uiFont = typeof source.uiFont === "string" ? source.uiFont.trim() : "";
    if (!uiFont) {
      if (source.uiFont === void 0 || source.uiFont === "") missingTokens.push(`${mode}.uiFont`);
      else invalidTokens.push(`${mode}.uiFont`);
      fallbackTokens.push(`${mode}.uiFont`);
      uiFont = fallback.uiFont;
    }
    return { accent: readColor("accent"), contrast: contrast2, ink: readColor("ink"), surface: readColor("surface"), uiFont };
  }
  function normalizeHostThemeInput(value) {
    const source = object(value);
    const seedDiagnostics = object(source.diagnostics);
    const missingTokens = stringArray(seedDiagnostics.missingTokens);
    const invalidTokens = stringArray(seedDiagnostics.invalidTokens);
    const fallbackTokens = stringArray(seedDiagnostics.fallbackTokens);
    const schemaVersion = source.schemaVersion === void 0 ? 1 : Number(source.schemaVersion);
    if (schemaVersion !== 1) {
      invalidTokens.push("schemaVersion");
      fallbackTokens.push("schemaVersion");
    }
    const validSources = ["codex-config", "codex-css-probe", "web-bootstrap", "fallback"];
    const themeSource = validSources.includes(source.source) ? source.source : source.light || source.dark ? "codex-config" : "fallback";
    if (source.source !== void 0 && !validSources.includes(source.source)) invalidTokens.push("source");
    if (source.source === void 0) missingTokens.push("source");
    const validModes = ["system", "light", "dark"];
    const theme = validModes.includes(source.theme) ? source.theme : "system";
    if (!validModes.includes(source.theme)) {
      if (source.theme === void 0 || source.theme === "") missingTokens.push("theme");
      else invalidTokens.push("theme");
      fallbackTokens.push("theme");
    }
    const capabilities = stringArray(source.capabilities);
    return {
      input: {
        schemaVersion: 1,
        source: themeSource,
        theme,
        light: profile(source.light, "light", missingTokens, invalidTokens, fallbackTokens),
        dark: profile(source.dark, "dark", missingTokens, invalidTokens, fallbackTokens),
        capabilities: capabilities.length ? unique(capabilities) : [...betterCodexDefaultHostTheme.capabilities]
      },
      missingTokens: unique(missingTokens),
      invalidTokens: unique(invalidTokens),
      fallbackTokens: unique(fallbackTokens)
    };
  }

  function applyHostTheme(value, environment) {
    const normalized = normalizeHostThemeInput(value);
    const derived = deriveHostTheme(normalized.input, environment.colorMixSupported);
    const invalidTokens = [...normalized.invalidTokens];
    const fallbackTokens = [...normalized.fallbackTokens];
    for (const [name, tokenValue] of Object.entries(derived.tokens)) {
      if (name.endsWith("font-ui") && !environment.fontFamilySupported(tokenValue)) {
        invalidTokens.push(name);
        fallbackTokens.push(name);
        const mode = name.includes("-dark-") ? "dark" : "light";
        environment.style.setProperty(name, betterCodexDefaultHostTheme[mode].uiFont);
      } else {
        environment.style.setProperty(name, tokenValue);
      }
    }
    const diagnostics = {
      host: environment.host,
      themeSource: normalized.input.source,
      schemaVersion: normalized.input.schemaVersion,
      missingTokens: normalized.missingTokens,
      invalidTokens: [...new Set(invalidTokens)].sort(),
      fallbackTokens: [...new Set(fallbackTokens)].sort(),
      contrastAdjustedTokens: derived.contrastAdjustedTokens,
      capabilitySignature: themeCapabilitySignature(environment.host, normalized.input.capabilities, environment.colorMixSupported, environment.fontFamilySupported(normalized.input.light.uiFont) && environment.fontFamilySupported(normalized.input.dark.uiFont))
    };
    return { theme: normalized.input, diagnostics };
  }

  function componentFailure(component, phase, context, error) {
    return new Error(JSON.stringify({
      code: "ui_component_failed",
      component,
      feature: context.feature,
      host: context.host,
      mountId: context.mountId,
      phase,
      themeSource: context.themeSource
    }), { cause: error });
  }

  var activeComponents = /* @__PURE__ */ new Set();
  function createComponentLifecycle(component, context, element, initial, render, cleanup) {
    const identity = `${component}:${context.mountId}`;
    if (activeComponents.has(identity)) throw componentFailure(component, "mount", context, new Error("duplicate_component_mount"));
    activeComponents.add(identity);
    const controller = new AbortController();
    let current = initial;
    let destroyed = false;
    element.dataset.bcComponent = component;
    element.dataset.bcMountId = context.mountId;
    const execute = (phase, action) => {
      try {
        action();
      } catch (error) {
        throw componentFailure(component, phase, context, error);
      }
    };
    execute("mount", () => render(current));
    const handle = {
      element,
      update(next) {
        if (destroyed) throw componentFailure(component, "update", context, new Error("component_destroyed"));
        current = next;
        execute("update", () => render(current));
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        activeComponents.delete(identity);
        controller.abort();
        execute("destroy", () => cleanup?.());
        element.remove();
      }
    };
    return { handle, props: () => current, signal: controller.signal };
  }
  function observeComponentSize(element, context) {
    const apply = (width) => {
      if (width <= 0) return;
      element.dataset.bcSize = width < 480 ? "narrow" : width < 900 ? "compact" : "wide";
    };
    let observer;
    try {
      observer = new ResizeObserver((entries) => {
        try {
          apply(entries.at(-1)?.contentRect.width || element.getBoundingClientRect().width);
        } catch (error) {
          throw componentFailure("responsive-size", "observe", context, error);
        }
      });
      observer.observe(element);
      apply(element.getBoundingClientRect().width);
    } catch (error) {
      throw componentFailure("responsive-size", "mount", context, error);
    }
    return () => observer.disconnect();
  }

  function listen(target, type, listener, signal, options = {}) {
    target.addEventListener(type, listener, { ...options, signal });
  }

  var allowedElements = /* @__PURE__ */ new Set(["circle", "ellipse", "line", "path", "polygon", "polyline", "rect"]);
  var allowedAttributes = /* @__PURE__ */ new Set(["cx", "cy", "d", "fill", "height", "opacity", "points", "r", "rx", "ry", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width", "width", "x", "x1", "x2", "y", "y1", "y2"]);
  function iconNodes(definition) {
    if (!/^[a-z0-9-]+$/.test(definition.name)) throw new Error("icon_name_invalid");
    const parsed = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${definition.nodes}</svg>`, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error(`icon_nodes_invalid:${definition.name}`);
    for (const node of parsed.documentElement.querySelectorAll("*")) {
      if (!allowedElements.has(node.localName)) throw new Error(`icon_element_invalid:${definition.name}:${node.localName}`);
      for (const attribute of Array.from(node.attributes)) if (!allowedAttributes.has(attribute.name)) throw new Error(`icon_attribute_invalid:${definition.name}:${attribute.name}`);
    }
    return Array.from(parsed.documentElement.children).map((node) => document.importNode(node, true));
  }
  function iconElement(props) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.replaceChildren(...iconNodes(props.definition));
    if (props.label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", props.label);
    } else {
      svg.setAttribute("aria-hidden", "true");
    }
    return svg;
  }

  function button(initial, context, iconOnly, existing) {
    const root = existing || document.createElement("button");
    const preserveContent = Boolean(existing);
    if (!existing) root.type = "button";
    const stateObserver = new MutationObserver(() => {
      if (root.disabled && root.dataset.bcState !== "loading") root.dataset.bcState = "disabled";
      else if (!root.disabled && root.dataset.bcState === "disabled") root.dataset.bcState = "default";
    });
    const lifecycle = createComponentLifecycle(iconOnly ? "icon-button" : "button", context, root, initial, (props) => {
      const variant = props.variant || "secondary";
      const disabled = Boolean(props.disabled || props.loading);
      root.dataset.bcVariant = variant;
      root.dataset.bcState = props.loading ? "loading" : disabled ? "disabled" : "default";
      root.disabled = disabled;
      root.toggleAttribute("aria-busy", Boolean(props.loading));
      if (iconOnly || props.accessibleName) root.setAttribute("aria-label", props.accessibleName || props.label);
      else root.removeAttribute("aria-label");
      if (preserveContent) return;
      const children = [];
      if (props.icon) {
        const icon = iconElement({ definition: props.icon });
        if (props.loading) icon.dataset.bcSpin = "true";
        children.push(icon);
      }
      if (!iconOnly) {
        const label = document.createElement("span");
        label.textContent = props.label;
        children.push(label);
      }
      root.replaceChildren(...children);
    }, () => stateObserver.disconnect());
    stateObserver.observe(root, { attributes: true, attributeFilter: ["disabled"] });
    listen(root, "click", (event) => {
      const props = lifecycle.props();
      if (props.disabled || props.loading || !props.onPress) return;
      try {
        const result = props.onPress(event);
        if (result instanceof Promise) void result.catch((error) => Promise.reject(new Error(JSON.stringify({ code: "ui_component_action_failed", component: iconOnly ? "icon-button" : "button", feature: context.feature, host: context.host, mountId: context.mountId, phase: "action", themeSource: context.themeSource }), { cause: error })));
      } catch (error) {
        throw new Error(JSON.stringify({ code: "ui_component_action_failed", component: iconOnly ? "icon-button" : "button", feature: context.feature, host: context.host, mountId: context.mountId, phase: "action", themeSource: context.themeSource }), { cause: error });
      }
    }, lifecycle.signal);
    return lifecycle.handle;
  }
  function createButton(initial, context) {
    return button(initial, context, false);
  }
  function adoptButton(element, initial, context) {
    return button(initial, context, false, element);
  }
  function createIconButton(initial, context) {
    return button(initial, context, true);
  }
  function adoptIconButton(element, initial, context) {
    return button(initial, context, true, element);
  }

  function createEmptyState(initial, context) {
    const root = document.createElement("section");
    let actionHandle = null;
    let stopSizeObservation = () => {
    };
    const lifecycle = createComponentLifecycle("empty-state", context, root, initial, (props) => {
      actionHandle?.destroy();
      actionHandle = null;
      const children = [];
      if (props.icon) children.push(iconElement({ definition: props.icon }));
      const title = document.createElement("strong");
      title.textContent = props.title;
      const description = document.createElement("p");
      description.textContent = props.description;
      children.push(title, description);
      if (props.action) {
        actionHandle = createButton(props.action, { ...context, mountId: `${context.mountId}:action` });
        children.push(actionHandle.element);
      }
      root.replaceChildren(...children);
    }, () => {
      actionHandle?.destroy();
      stopSizeObservation();
    });
    stopSizeObservation = observeComponentSize(root, context);
    return lifecycle.handle;
  }

  function inlineFeedback(initial, context, existing) {
    const root = existing || document.createElement("div");
    const preserveContent = Boolean(existing);
    const lifecycle = createComponentLifecycle("inline-feedback", context, root, initial, (props) => {
      const tone = props.tone || "info";
      root.dataset.bcVariant = tone;
      root.dataset.bcState = "default";
      root.setAttribute("role", tone === "error" ? "alert" : "status");
      if (!preserveContent) root.textContent = props.message;
    });
    return lifecycle.handle;
  }
  function adoptInlineFeedback(element, initial, context) {
    return inlineFeedback(initial, context, element);
  }

  function focusable(dialog) {
    return [...dialog.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden);
  }
  function createDialog(initial, context) {
    const root = document.createElement("dialog");
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.documentElement.style.overflow;
    const lifecycle = createComponentLifecycle("dialog", context, root, initial, (props) => {
      root.setAttribute("aria-label", props.accessibleName);
      if (root.firstChild !== props.content) root.replaceChildren(props.content);
    }, () => {
      if (root.open) root.close();
      document.documentElement.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    listen(root, "cancel", (event) => {
      event.preventDefault();
      lifecycle.props().onRequestClose?.();
    }, lifecycle.signal);
    listen(root, "click", (event) => {
      if (event.target !== root) return;
      const pointer = event;
      const bounds = root.getBoundingClientRect();
      if (pointer.clientX < bounds.left || pointer.clientX > bounds.right || pointer.clientY < bounds.top || pointer.clientY > bounds.bottom) lifecycle.props().onRequestClose?.();
    }, lifecycle.signal);
    listen(root, "keydown", (event) => {
      const key = event;
      if (key.key !== "Tab") return;
      const elements = focusable(root);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements.at(-1);
      if (key.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!key.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }, lifecycle.signal);
    document.body.append(root);
    document.documentElement.style.overflow = "hidden";
    root.showModal();
    queueMicrotask(() => (lifecycle.props().initialFocus || focusable(root)[0] || root).focus());
    return lifecycle.handle;
  }

  function adoptFieldShell(root, context) {
    const control = root.querySelector('input, textarea, select, button, [role="radiogroup"]');
    const label = root.querySelector("strong, [data-bc-field-label]")?.textContent?.trim();
    if (!control || !label) throw new Error("field_shell_contract_invalid");
    const description = root.querySelector("small")?.textContent?.trim() || "";
    const lifecycle = createComponentLifecycle("field-shell", context, root, { control, description, label }, () => {
      root.dataset.bcState = control.matches(":disabled") ? "disabled" : "default";
      if (description) {
        const descriptionNode = root.querySelector("small");
        if (descriptionNode) {
          descriptionNode.id ||= context.mountId + "-description";
          control.setAttribute("aria-describedby", descriptionNode.id);
        }
      }
    });
    return lifecycle.handle;
  }

  function adoptMenu(root, initial, context) {
    let lifecycle;
    lifecycle = createComponentLifecycle("menu", context, root, initial, (props) => {
      root.hidden = !props.open;
      props.trigger.setAttribute("aria-expanded", String(props.open));
      root.dataset.bcState = props.open ? "open" : "closed";
    }, () => lifecycle.props().trigger.setAttribute("aria-expanded", "false"));
    const items = () => [...root.querySelectorAll('[role="menuitem"], [role="option"], button:not(:disabled)')].filter((item) => !item.hidden);
    listen(root, "keydown", (event) => {
      const key = event;
      const entries = items();
      if (!entries.length) return;
      const index = Math.max(0, entries.indexOf(document.activeElement));
      const destination = key.key === "Home" ? entries[0] : key.key === "End" ? entries.at(-1) : key.key === "ArrowDown" ? entries[(index + 1) % entries.length] : key.key === "ArrowUp" ? entries[(index - 1 + entries.length) % entries.length] : null;
      if (destination) {
        event.preventDefault();
        destination.focus();
      } else if (key.key === "Escape") {
        event.preventDefault();
        lifecycle.props().onClose?.();
        lifecycle.props().trigger.focus();
      }
    }, lifecycle.signal);
    listen(document, "pointerdown", (event) => {
      const props = lifecycle.props();
      if (props.open && !root.contains(event.target) && !props.trigger.contains(event.target)) props.onClose?.();
    }, lifecycle.signal, { capture: true });
    return lifecycle.handle;
  }

  var ownedComponents = /* @__PURE__ */ new WeakMap();
  function registerOwnedComponent(element, handle) {
    const current = ownedComponents.get(element);
    if (current && current !== handle) current.destroy();
    ownedComponents.set(element, handle);
    return handle;
  }
  function destroyOwnedComponents(root, preservedRoots = []) {
    if (!(root instanceof HTMLElement)) return;
    const elements = [root, ...root.querySelectorAll("[data-bc-component]")];
    elements.forEach((element) => {
      if (preservedRoots.some((preserved) => preserved === element || preserved?.contains(element))) return;
      const handle = ownedComponents.get(element);
      if (!handle) return;
      ownedComponents.delete(element);
      handle.destroy();
    });
  }
  function destroyRemovedComponents(records, preservedRoots = []) {
    records.forEach((record) => record.removedNodes.forEach((node) => {
      if (!node.isConnected) destroyOwnedComponents(node, preservedRoots);
    }));
  }

  function badge(initial, context, component, existing) {
    const root = existing || document.createElement("span");
    const preserveContent = Boolean(existing);
    const lifecycle = createComponentLifecycle("badge", context, root, initial, (props) => {
      const variant = props.variant || "neutral";
      root.dataset.bcVariant = variant;
      if (component === "status-badge") root.dataset.tone = variant;
      else delete root.dataset.tone;
      root.dataset.bcState = "default";
      if (!preserveContent) root.textContent = props.label;
    });
    lifecycle.handle.element.dataset.bcComponent = component;
    return lifecycle.handle;
  }
  function createStatusBadge(initial, context) {
    return badge(initial, context, "status-badge");
  }
  function adoptBadge(element, initial, context) {
    return badge(initial, context, "badge", element);
  }
  function adoptStatusBadge(element, initial, context) {
    return badge(initial, context, "status-badge", element);
  }

  function adoptFormRow(root, context) {
    return createComponentLifecycle("form-row", context, root, {}, () => {
    }).handle;
  }

  function adoptToolbar(root, context) {
    return createComponentLifecycle("toolbar", context, root, {}, () => {
    }).handle;
  }

  function renderAgentsFeature(view, state) {
    if (state.destroyed) throw new Error("agents_feature_destroyed");
    state.active = true;
    state.renderCount += 1;
    view.render(state);
  }

  function createAgentsController(view) {
    const state = { active: false, destroyed: false, renderCount: 0 };
    return {
      render: () => renderAgentsFeature(view, state),
      deactivate: () => {
        state.active = false;
      },
      destroy: () => {
        state.active = false;
        state.destroyed = true;
      }
    };
  }

  function renderBoardFeature(view, state) {
    if (state.destroyed) throw new Error("board_feature_destroyed");
    state.active = true;
    state.renderCount += 1;
    view.render(state);
  }

  function createBoardController(view) {
    const state = { active: false, destroyed: false, renderCount: 0 };
    return {
      render: () => renderBoardFeature(view, state),
      deactivate: () => {
        state.active = false;
      },
      destroy: () => {
        state.active = false;
        state.destroyed = true;
      }
    };
  }

  function createSemanticController(input) {
    let generation = 0;
    return {
      async search(query, kinds = []) {
        const current = ++generation;
        const path = `${input.endpoint()}?schema_version=2&query=${encodeURIComponent(query)}${kinds.length ? `&kinds=${encodeURIComponent(kinds.join(","))}` : ""}`;
        const result = await input.request(path);
        if (current !== generation) throw new Error("semantic_search_cancelled");
        return result;
      },
      cancel() {
        generation += 1;
      }
    };
  }

  function normalizedAnchors(value, text) {
    return value.filter((anchor) => Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= text.length && text.slice(anchor.start, anchor.end) === anchor.display && anchor.handle).sort((left, right) => left.start - right.start || left.end - right.end).filter((anchor, index, anchors) => !index || anchors[index - 1].end <= anchor.start);
  }
  function createSemanticDraft(text = "", document2) {
    if (document2?.schema_version !== 2 || !Array.isArray(document2.parts)) return { text, anchors: [], degraded: false };
    let value = "";
    const anchors = [];
    for (const part of document2.parts) {
      if (!part || typeof part !== "object") continue;
      const item = part;
      if (item.type === "text") value += String(item.text || "");
      if (item.type === "reference") {
        const display = String(item.display || "");
        const handle = String(item.handle || "");
        if (!display || !handle) continue;
        const start = value.length;
        value += display;
        anchors.push({ start, end: value.length, handle, display });
      }
    }
    return { text: value || text, anchors: normalizedAnchors(anchors, value || text), degraded: false };
  }
  function applySemanticTextEdit(draft, start, end, replacement) {
    const safeStart = Math.max(0, Math.min(draft.text.length, start));
    const safeEnd = Math.max(safeStart, Math.min(draft.text.length, end));
    const delta = replacement.length - (safeEnd - safeStart);
    let degraded = draft.degraded;
    const anchors = draft.anchors.flatMap((anchor) => {
      if (anchor.end <= safeStart) return [anchor];
      if (anchor.start >= safeEnd) return [{ ...anchor, start: anchor.start + delta, end: anchor.end + delta }];
      degraded = true;
      return [];
    });
    const text = draft.text.slice(0, safeStart) + replacement + draft.text.slice(safeEnd);
    return { text, anchors: normalizedAnchors(anchors, text), degraded };
  }
  function reconcileSemanticText(draft, text) {
    if (draft.text === text) return draft;
    let start = 0;
    while (start < draft.text.length && start < text.length && draft.text[start] === text[start]) start += 1;
    let oldEnd = draft.text.length;
    let newEnd = text.length;
    while (oldEnd > start && newEnd > start && draft.text[oldEnd - 1] === text[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    return applySemanticTextEdit(draft, start, oldEnd, text.slice(start, newEnd));
  }
  function insertSemanticReference(draft, start, end, handle, display) {
    const replacement = `${display} `;
    const edited = applySemanticTextEdit(draft, start, end, replacement);
    const anchor = { start, end: start + display.length, handle, display };
    return { text: edited.text, anchors: normalizedAnchors([...edited.anchors, anchor], edited.text), degraded: edited.degraded };
  }
  function serializeSemanticDraft(draft) {
    const anchors = normalizedAnchors(draft.anchors, draft.text);
    const parts = [];
    let cursor = 0;
    for (const anchor of anchors) {
      if (anchor.start > cursor) parts.push({ type: "text", text: draft.text.slice(cursor, anchor.start) });
      parts.push({ type: "reference", handle: anchor.handle, display: anchor.display });
      cursor = anchor.end;
    }
    if (cursor < draft.text.length || !parts.length) parts.push({ type: "text", text: draft.text.slice(cursor) });
    return { schema_version: 2, parts };
  }

  function semanticCandidateIcon(kind) {
    if (kind === "skill") return "wrench";
    if (kind === "file") return "docs";
    if (kind === "directory") return "folder";
    if (kind.startsWith("mcp_")) return "server";
    if (kind === "plugin" || kind === "app" || kind === "desktop_app") return "sparkles";
    if (kind === "builtin_browser") return "external";
    if (kind === "builtin_computer") return "terminal";
    return "terminal";
  }
  function semanticCandidateGroup(kind) {
    if (["builtin_browser", "builtin_computer", "desktop_app"].includes(kind)) return "Capabilities";
    if (kind === "skill") return "Skills";
    if (kind === "plugin") return "Plugins";
    if (kind === "app") return "Apps";
    if (kind.startsWith("mcp_")) return "MCP";
    return "Files";
  }

  function renderProjectsFeature(view, state) {
    if (state.destroyed) throw new Error("projects_feature_destroyed");
    state.active = true;
    state.renderCount += 1;
    view.render(state);
  }
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }
  function renderProjectDashboardTabs(state, page, labels) {
    const current = (target, pane = "") => page === target && (!pane || state.planningPane === pane) ? ' aria-current="page"' : "";
    const label = Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, escapeHtml(value)]));
    const desktop = '<nav class="better-codex-project-dashboard-tabs better-codex-project-dashboard-tabs-desktop" aria-label="' + label.page + '"><button type="button" data-project-dashboard-view="overview"' + current("overview") + ">" + label.overview + '</button><button type="button" data-project-dashboard-view="planning"' + current("planning") + ">" + label.planning + '</button><button type="button" data-project-dashboard-view="work"' + current("work") + ">" + label.work + "</button></nav>";
    const mobile = desktop.replace("better-codex-project-dashboard-tabs-desktop", "better-codex-project-dashboard-tabs-mobile");
    return desktop + mobile;
  }

  function createProjectsController(view) {
    const state = { active: false, destroyed: false, renderCount: 0, planningPane: "plan" };
    return {
      render: () => renderProjectsFeature(view, state),
      planningPane: () => state.planningPane,
      resetPlanningPane: () => {
        state.planningPane = "plan";
      },
      selectDashboard: (page, pane) => {
        const selectedPage = page === "planning" || page === "work" ? page : "overview";
        if (selectedPage === "planning") state.planningPane = pane === "chat" ? "chat" : "plan";
        return { page: selectedPage, planningPane: state.planningPane };
      },
      renderDashboardTabs: (page, labels) => renderProjectDashboardTabs(state, page, labels),
      deactivate: () => {
        state.active = false;
      },
      destroy: () => {
        state.active = false;
        state.destroyed = true;
      }
    };
  }

  function openSettingsFeature(view, state, initialView) {
    if (state.destroyed) throw new Error("settings_feature_destroyed");
    state.openCount += 1;
    view.open(initialView, state);
  }

  function createSettingsController(view) {
    const state = { destroyed: false, openCount: 0 };
    return {
      open: (initialView) => openSettingsFeature(view, state, initialView),
      destroy: () => {
        state.destroyed = true;
      }
    };
  }

  function isAuxiliaryDesktopUrl(value) {
    try {
      const url = new URL(value);
      const route = new URL(url.searchParams.get("initialRoute") || url.pathname + url.search, "https://codex.local");
      return /detached-window|global-dictation|avatar-overlay/i.test(url.pathname + route.pathname) ||
        route.searchParams.get("window") === "page" || route.searchParams.get("prewarm") === "1";
    } catch { return false; }
  }
  function install(config) {
    if (isAuxiliaryDesktopUrl(window.location.href)) {
      window.__betterCodexInjection__?.destroy?.();
      return { installed: false, reason: "auxiliary_desktop_window" };
    }
    if (!config || config.schemaVersion !== 1) throw new Error("injected_ui_schema_mismatch");
    "use strict";
    const VERSION = config.version;
    const CORE_VERSION = config.coreVersion;
    const PROFILE = config.profile;
    const HOST_KIND = "codex";
    const SESSION_NATIVE_COMMANDS = config.sessionNativeCommands;
    const DESKTOP_NATIVE_COMMANDS = config.desktopNativeCommands;
    const RELAY = false;
    const HOST_ADAPTER = createHostAdapter(HOST_KIND, window.betterCodexHost, RELAY);
    const HOST_CAPABILITIES = HOST_ADAPTER.capabilities;
    const READ_ONLY = HOST_CAPABILITIES.issues === "read-only";
    const AGENTS_READ_ONLY = HOST_CAPABILITIES.agents === "read-only";
    const CODEX_SEMANTICS_AVAILABLE = HOST_CAPABILITIES.codexSemantics !== false;
    const REMOTE = false;
    if (READ_ONLY) document.documentElement.setAttribute("data-better-codex-read-only", "true");
    const HELP_MODE_MARKDOWN = config.helpModeMarkdown;
    const previous = window.__betterCodexInjection__;
    if (previous?.version === VERSION && previous?.endpoint === config.baseUrl && previous?.profile === PROFILE && previous?.host === HOST_KIND && previous?.bundleChecksum === config.bundleChecksum && typeof previous?.pulse === "function") {
      previous.refresh();
      return { installed: true, reused: true };
    }
    previous?.destroy?.();
    const ENTRY_ID = "better-codex-entry";
    const AGENTS_ENTRY_ID = "better-codex-agents-entry";
    const PROJECTS_ENTRY_ID = "better-codex-projects-entry";
    const MORE_ENTRY_ID = "better-codex-more-entry";
    const PANEL_ID = "better-codex-panel";
    const STYLE_ID = "better-codex-style";
    const OWNED = "data-better-codex-owned";
    const HIDDEN = "data-better-codex-native-hidden";
    const HOST = "data-better-codex-page-host";
    const EXTERNAL_MCP_HIDDEN = "data-better-codex-external-mcp-host-hidden";
    const BASE_URL = config.baseUrl;
    const BRIDGE_TOKEN = config.bridgeToken;
    const BETTER_CODEX_LOGO_URL = config.logoUrl;
    const DEFAULT_AGENT_AVATAR_URL = config.defaultAgentAvatarUrl;
    const INITIAL_LOCALE = config.initialLocale;
    const SELECTORS = HOST_KIND === "web" ? {
      sidebarScroll: "[data-app-action-sidebar-scroll]",
      sidebarSection: "[data-app-action-sidebar-section]",
      truncatedText: ".text-fade-truncate",
      contentFrame: ".app-shell-main-content-frame",
      contentLayout: "[data-app-shell-main-content-layout]",
      threadRow: "[data-app-action-sidebar-thread-id]",
      projectList: "[data-app-action-sidebar-project-list-id]",
      projectId: "[data-app-action-sidebar-project-id]",
      currentProjectRow: '[data-app-action-sidebar-project-row][aria-current="page"]',
      projectRow: "[data-app-action-sidebar-project-row]",
      searchInput: 'input[type="search"]',
      sidebarNavigation: 'aside nav[role="navigation"]'
    } : config.selectors;
    const ATTRIBUTES = HOST_KIND === "web" ? {
      threadId: "data-app-action-sidebar-thread-id",
      threadActive: "data-app-action-sidebar-thread-active",
      projectListId: "data-app-action-sidebar-project-list-id",
      projectId: "data-app-action-sidebar-project-id",
      projectLabel: "data-app-action-sidebar-project-label"
    } : config.attributes;
    const NAVIGATION = HOST_KIND === "web" ? {
      messageType: "navigate-to-route",
      threadRoutePrefix: "/local/"
    } : config.navigation;
    const BETTER_CODEX_ROUTE = config.betterCodexRoute;
    const FEATURE_MANIFEST = config.featureManifest;
    const ENABLED_FEATURES = new Set(FEATURE_MANIFEST.features.filter((feature) => feature.enabled).map((feature) => feature.id));
    const SIDEBAR_NAVIGATION_ITEM = SELECTORS.sidebarNavigationItem || ".sidebar-item";
    const LUCIDE_ICONS = config.lucideIcons;
    const AGENT_AVATAR_PRESETS = config.agentAvatarPresets;
    const DEFAULT_PRESET_AVATAR_URL = AGENT_AVATAR_PRESETS.find((item) => item.id === "bot").image;
    const USER_AVATAR_COLORS = config.userAvatarColors;
    const RESUME_SURFACE_KEY = "better-codex-resume-surface";
    const PROJECT_KEY = "better-codex-project-id";
    const LANGUAGE_KEY = "better-codex-language";
    const COMPLETION_DURATION_KEY = "better-codex-completion-notice-duration";
    const COMPLETION_NOTICE_CACHE_KEY = "better-codex-completion-notices:" + PROFILE;
    const COMPLETION_NOTICE_CACHE_LIMIT = 50;
    const CREATE_DRAFT_KEY = "better-codex-create-draft";
    const KEEP_CREATE_KEY = "better-codex-keep-create";
    const CREATE_ISSUE_SHORTCUT_KEY = "better-codex-create-issue-shortcut";
    const SEND_MODE_KEY = "better-codex-send-mode";
    const AGENT_INSPECTOR_WIDTH_KEY = "better-codex-agent-inspector-width";
    const CREATE_DIALOG_EXPANDED_KEY = "better-codex-create-dialog-expanded";
    const ISSUE_DIALOG_EXPANDED_KEY = "better-codex-issue-dialog-expanded";
    const AGENT_INSPECTOR_MIN_WIDTH = 320;
    const AGENT_DIRECTORY_MIN_WIDTH = 320;
    const THREAD_OPEN_TIMEOUT_MS = 1e4;
    const THREAD_OPEN_POLL_MS = 100;
    const statusLabels = { backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "待审核", done: "已完成", blocked: "已阻塞" };
    const priorityLabels = { none: "无", low: "低", medium: "中", high: "高", urgent: "紧急" };
    const mockupRunStatusLabels = { "not-started": "未开始", claimed: "排队中", running: "工作中", completed: "已完成", failed: "执行失败", interrupted: "已停止" };
    const projectDocumentViews = [
      { key: "charter", label: "项目章程", icon: "docs" },
      { key: "product", label: "产品地图", icon: "layout" },
      { key: "architecture", label: "架构地图", icon: "server" },
      { key: "roadmap", label: "路线图", icon: "calendar" },
      { key: "work", label: "工作图", icon: "issues" },
      { key: "delivery", label: "交付图", icon: "code" },
      { key: "evidence", label: "证据与学习", icon: "shield" }
    ];
    const rememberedSurface = sessionStorage.getItem(RESUME_SURFACE_KEY);
    const rememberedProjectId = localStorage.getItem(PROJECT_KEY) || "";
    const rememberedLanguage = localStorage.getItem(LANGUAGE_KEY);
    const rememberedKeepCreate = localStorage.getItem(KEEP_CREATE_KEY) === "true";
    const rememberedAgentInspectorWidth = Number(localStorage.getItem(AGENT_INSPECTOR_WIDTH_KEY));
    const languageSetting = ["system", "zh-CN", "en"].includes(rememberedLanguage) ? rememberedLanguage : "system";
    function resolveSystemLocale(fallback) {
      const locale = String(fallback || document.documentElement.lang || navigator.language || "").trim().toLowerCase().replace(/_/g, "-");
      return ["zh-cn", "zh-hans", "zh-hans-cn"].includes(locale) ? "zh-CN" : "en";
    }
    const systemLocale = resolveSystemLocale(INITIAL_LOCALE);
    const MOCKUP_PROJECT_ID = "mockup-better-codex";
    const hasFeature = (feature) => ENABLED_FEATURES.has(feature);
    const availableSurfaces = ["issues", "agents", ...hasFeature("project-management") ? ["projects"] : []];
    const initialProjectRoute = hasFeature("project-management") ? webProjectRoute() : null;
    const initialAgentRoute = webAgentRoute();
    if (HOST_KIND === "web" && !hasFeature("project-management") && /^\/web\/projects(?:\/|$)/.test(location.pathname)) history.replaceState({ betterCodex: true, betterCodexSurface: "issues" }, "", "/web");
    const initialAgentKey = initialAgentRoute?.agentKey || "";
    const state = { projects: [], projectsLoaded: false, issues: [], issuesLoaded: false, projectIssues: [], projectIssuesProjectId: "", projectDetailId: initialProjectRoute?.projectId || "", projectPage: "overview", projectDocumentView: "charter", projectDocumentPending: null, projectDocumentError: null, projectPlanningPending: null, projectPlanningError: null, agents: [], agentModelCatalog: [], agentModels: [], agentReasoningEfforts: [], user: { id: "", name: "你", email: "", handle: "", initials: "你", color: USER_AVATAR_COLORS[0], avatar: "", avatar_generated: true }, users: [], projectId: "", search: "", agentSearch: "", agentView: "all", agentPane: initialAgentKey === "new" ? "create" : initialAgentKey ? "detail" : "preview", selectedAgentId: initialAgentKey && initialAgentKey !== "new" ? initialAgentKey : "", agentDraft: initialAgentKey === "new" ? { avatar: DEFAULT_PRESET_AVATAR_URL } : null, agentInspectorWidth: Number.isFinite(rememberedAgentInspectorWidth) && rememberedAgentInspectorWidth > 0 ? rememberedAgentInspectorWidth : 0, surface: initialProjectRoute ? "projects" : initialAgentRoute ? "agents" : availableSurfaces.includes(rememberedSurface) ? rememberedSurface : "issues", view: "all", autoDispatch: false, autoDispatchPending: false, schedulerModel: "gpt-5.6-sol", schedulerReasoningEffort: "high", issueDescriptionLimit: 1e5, mockup: false, keepCreate: rememberedKeepCreate, selected: null, error: "", systemLocale, languageSetting, locale: languageSetting === "system" ? systemLocale : languageSetting, filters: { status: [], priority: [], date: [], assignee: [], creator: [], project: [], label: [] } };
    const pendingIssueRemovals = /* @__PURE__ */ new Map();
    const pendingIssueCreates = /* @__PURE__ */ new Map();
    const pendingIssueReplies = /* @__PURE__ */ new Map();
    const projectPlanningDrafts = /* @__PURE__ */ new Map();
    let projectPlanningComposition = "";
    let projectRenderDeferred = null;
    let projectRenderedMarkup = "";
    function webProjectRoute() {
      if (HOST_KIND !== "web") return null;
      const match = location.pathname.match(/^\/web\/projects(?:\/([^/?#]+))?\/?$/);
      if (!match) return null;
      try {
        return { projectId: match[1] ? decodeURIComponent(match[1]) : "" };
      } catch {
        return { projectId: "" };
      }
    }
    function projectRoutePath(projectId = "") {
      return "/web/projects" + (projectId ? "/" + encodeURIComponent(projectId) : "");
    }
    function syncWebProjectRoute(projectId = "", mode = "push") {
      if (HOST_KIND !== "web" || mode === "none") return;
      const path = projectRoutePath(projectId);
      if (location.pathname === path) return;
      const routeState = { betterCodex: true, betterCodexSurface: "projects", betterCodexProjectId: projectId || "" };
      if (projectId && location.pathname === projectRoutePath()) routeState.betterCodexProjectFromHome = true;
      history[mode === "replace" ? "replaceState" : "pushState"](routeState, "", path);
    }
    function webAgentRoute() {
      if (HOST_KIND !== "web") return null;
      const match = location.pathname.match(/^\/web\/agents(?:\/([^/?#]+))?\/?$/);
      if (!match) return null;
      try {
        return { agentKey: match[1] ? decodeURIComponent(match[1]) : "" };
      } catch {
        return { agentKey: "" };
      }
    }
    function agentRoutePath(agentKey2 = "") {
      return "/web/agents" + (agentKey2 ? "/" + encodeURIComponent(agentKey2) : "");
    }
    function syncWebAgentRoute(agentKey2 = "", mode = "push") {
      if (HOST_KIND !== "web" || mode === "none") return;
      const path = agentRoutePath(agentKey2);
      if (location.pathname === path) return;
      const routeState = { betterCodex: true, betterCodexSurface: "agents", betterCodexAgentKey: agentKey2 || "" };
      if (agentKey2 && (location.pathname === agentRoutePath() || history.state?.betterCodexAgentFromList)) routeState.betterCodexAgentFromList = true;
      history[mode === "replace" ? "replaceState" : "pushState"](routeState, "", path);
    }
    function shortcutKeyFromCode(code, key) {
      const source = String(code || "");
      if (/^Key[A-Z]$/.test(source)) return source.slice(3);
      if (/^Digit[0-9]$/.test(source)) return source.slice(5);
      const names = { Space: "Space", Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Comma: "Comma", Period: "Period", Slash: "Slash", Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", BracketLeft: "BracketLeft", BracketRight: "BracketRight", Minus: "Minus", Equal: "Equal", Backquote: "Backquote", NumpadAdd: "NumpadAdd", NumpadSubtract: "NumpadSubtract", NumpadMultiply: "NumpadMultiply", NumpadDivide: "NumpadDivide", NumpadDecimal: "NumpadDecimal" };
      if (names[source]) return names[source];
      const value = String(key || "").trim();
      return value.length === 1 ? value.toUpperCase() : value.replace(/\s+/g, "");
    }
    function shortcutFromKeyboardEvent(event) {
      const key = shortcutKeyFromCode(event.code, event.key);
      if (!key || ["Meta", "Control", "Alt", "Shift"].includes(key)) return "";
      const modifiers = [];
      if (event.metaKey || event.ctrlKey) modifiers.push("Mod");
      if (event.altKey) modifiers.push("Alt");
      if (event.shiftKey) modifiers.push("Shift");
      return [...modifiers, key].join("+");
    }
    function normalizeShortcut(value) {
      const parts = String(value || "").split("+").map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return "";
      const key = parts.at(-1);
      if (["Meta", "Control", "Ctrl", "Command", "Cmd", "Alt", "Option", "Shift"].includes(key)) return "";
      const modifiers = [];
      if (parts.slice(0, -1).some((part) => ["Mod", "Ctrl", "Control", "Command", "Cmd"].includes(part))) modifiers.push("Mod");
      if (parts.slice(0, -1).some((part) => ["Alt", "Option"].includes(part))) modifiers.push("Alt");
      if (parts.slice(0, -1).includes("Shift")) modifiers.push("Shift");
      return [...modifiers, key].join("+");
    }
    function readCreateIssueShortcut() {
      return normalizeShortcut(localStorage.getItem(CREATE_ISSUE_SHORTCUT_KEY));
    }
    function readSendMode() {
      return localStorage.getItem(SEND_MODE_KEY) === "enter" ? "enter" : "mod-enter";
    }
    function isSendKeyboardEvent(event) {
      if (event.key !== "Enter" || event.isComposing || event.repeat) return false;
      if (readSendMode() === "enter") return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
    }
    function shortcutLabel(value) {
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
      const labels = { Mod: mac ? "⌘" : "Ctrl", Alt: mac ? "⌥" : "Alt", Shift: mac ? "⇧" : "Shift", Space: "Space", Up: "↑", Down: "↓", Left: "←", Right: "→" };
      return normalizeShortcut(value).split("+").filter(Boolean).map((part) => labels[part] || part).join(mac ? " " : " + ");
    }
    function readCreateDraft() {
      try {
        const draft = JSON.parse(sessionStorage.getItem(CREATE_DRAFT_KEY) || "null");
        if (!draft || typeof draft !== "object") return null;
        return {
          mode: draft.mode === "agent" ? "agent" : "manual",
          title: String(draft.title || ""),
          description: String(draft.description || ""),
          prompt: String(draft.prompt || ""),
          promptSemanticReferences: Array.isArray(draft.promptSemanticReferences) ? draft.promptSemanticReferences.filter((reference) => reference && ["skill", "app", "mention"].includes(reference.type) && typeof reference.name === "string" && typeof reference.ref === "string").slice(0, 32) : [],
          promptSemanticDocument: draft.promptSemanticDocument && typeof draft.promptSemanticDocument === "object" ? draft.promptSemanticDocument : void 0,
          attachments: Array.isArray(draft.attachments) ? draft.attachments.filter((item) => item && typeof item.name === "string" && typeof item.path === "string" && item.path).slice(0, 4).map((item) => ({ name: item.name, path: item.path, type: typeof item.type === "string" ? item.type : "" })) : [],
          requestId: typeof draft.requestId === "string" && draft.requestId.length <= 200 ? draft.requestId : ""
        };
      } catch {
        sessionStorage.removeItem(CREATE_DRAFT_KEY);
        return null;
      }
    }
    function writeCreateDraft(draft, requestId) {
      const cached = { mode: draft.mode, title: draft.title, description: draft.description, prompt: draft.prompt, promptSemanticReferences: draft.promptSemanticReferences, promptSemanticDocument: serializeSemanticDraft(draft.promptSemanticDocument), attachments: draft.attachments.filter((item) => item.path).map((item) => ({ name: item.name, path: item.path, type: item.type || "" })), requestId };
      if (![cached.title, cached.description, cached.prompt].some((value) => value.trim()) && !cached.attachments.length) {
        sessionStorage.removeItem(CREATE_DRAFT_KEY);
        return;
      }
      sessionStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(cached));
    }
    function normalizeMockupIssues(value) {
      const source = Array.isArray(value) ? value : value?.issues;
      if (!Array.isArray(source)) throw new Error("展示数据格式无效");
      if (source.length > 500) throw new Error("展示卡片不能超过 500 条");
      const now = (/* @__PURE__ */ new Date()).toISOString();
      return source.map((issue, index) => {
        const title = String(issue?.title || "").trim();
        if (!title) throw new Error("展示卡片缺少标题");
        if (title.length > 500 || String(issue.description || "").length > 2e4) throw new Error("展示卡片内容过长");
        if (Array.isArray(issue.labels) && (issue.labels.length > 50 || issue.labels.some((label2) => String(label2).length > 100))) throw new Error("展示卡片标签过多或过长");
        const status = Object.hasOwn(statusLabels, issue.status) ? issue.status : "backlog";
        const priority = Object.hasOwn(priorityLabels, issue.priority) ? issue.priority : "none";
        return {
          id: String(issue.id || "mockup-import-" + (index + 1)),
          identifier: String(issue.identifier || "BET-" + (index + 20)),
          project_id: MOCKUP_PROJECT_ID,
          title,
          description: String(issue.description || ""),
          status,
          priority,
          sort_order: Number.isFinite(Number(issue.sort_order)) ? Number(issue.sort_order) : (index + 1) * 1e3,
          pinned: Boolean(issue.pinned),
          archived_at: null,
          thread_id: null,
          workspace_path: "",
          version: Number.isInteger(issue.version) ? issue.version : 1,
          created_at: issue.created_at || now,
          updated_at: issue.updated_at || now,
          agent_enabled: Boolean(issue.agent_enabled),
          agent_id: issue.agent_id || null,
          mockup_agent_name: String(issue.mockup_agent_name || ""),
          user_assigned: Boolean(issue.user_assigned),
          needs_attention: false,
          pending_actor: "user",
          enrichment_status: null,
          reply_draft: "",
          reply_draft_attachments: [],
          labels: Array.isArray(issue.labels) ? issue.labels.map((label2) => String(label2)).filter(Boolean) : [],
          mockup_run_status: Object.hasOwn(mockupRunStatusLabels, issue.mockup_run_status) ? issue.mockup_run_status : "not-started"
        };
      });
    }
    async function exportMockupIssues() {
      const data = await api("/api/mockup/state");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "better-codex-mockup.json";
      link.click();
      URL.revokeObjectURL(url);
    }
    async function importMockupIssues(file) {
      if (file.size > 16 * 1024 * 1024) throw new Error("展示数据不能超过 16 MB");
      let imported;
      try {
        imported = JSON.parse(await file.text());
      } catch {
        throw new Error("展示数据格式无效");
      }
      const data = Array.isArray(imported) || !Array.isArray(imported?.agents) ? { ...await api("/api/mockup/state"), version: 1, issues: normalizeMockupIssues(imported) } : imported;
      await api("/api/mockup/state", { method: "PUT", body: JSON.stringify(data) });
      await load();
    }
    function confirmMockupReset() {
      return confirmAction("重置展示数据", "恢复默认展示卡片和布局吗？", "重置").then((confirmed) => {
        if (!confirmed) return;
        return api("/api/mockup/reset", { method: "POST" });
      }).then((result) => result ? load() : void 0);
    }
    function moveMockupIssue(id, version, status, beforeId = "") {
      return api("/api/issues/" + encodeURIComponent(id) + "/move", { method: "POST", body: JSON.stringify({ version, status, before_id: beforeId }) });
    }
    const localeResources = { "zh-CN": {}, en: {
      "调度失败": "Scheduling failed",
      "模型列表暂不可用，请检查 Codex 会话服务后刷新。": "Model list unavailable. Check the Codex session service and refresh.",
      "任务执行失败": "Task execution failed",
      "任务尚未启动": "Task has not started",
      "正在启动任务": "Starting the task",
      "请求已接收，正在准备会话。": "Request received. Preparing the conversation.",
      "会话记录尚不可恢复，需要先处理会话绑定问题。": "The conversation cannot be restored yet. Resolve the thread binding issue first.",
      "请查看下方失败原因，处理后再继续。": "Resolve the failure shown below before continuing.",
      "原始任务内容已保留": "Your original task has been preserved",
      "尚未开始对话": "Conversation has not started",
      "发送消息后将开始处理任务。": "Send a message to start the task.",
      "任务执行失败。请根据下方失败原因处理后重新运行。": "Task execution failed. Resolve the failure below, then run the task again.",
      "重试回复": "Retry reply",
      "重新加载": "Reload",
      "回复等待超时。请检查模型服务连接后重试。": "The reply timed out. Check the model service connection and retry.",
      "网络连接异常，回复未完成。请检查网络和 Better Codex Runtime 后重试。": "The reply did not finish because of a network problem. Check your network and Better Codex Runtime, then retry.",
      "当前权限不足，无法完成回复。请调整智能体权限或允许所需操作后重试。": "The reply needs additional permission. Adjust the agent permission or allow the required action, then retry.",
      "Better Codex Runtime 已停止。请重新启动后重试。": "Better Codex Runtime stopped. Restart it and retry.",
      "上一条回复仍在进行中。请稍后重新加载。": "The previous reply is still running. Reload shortly.",
      "回复未完成。请打开完整会话查看详情，然后重试。": "The reply did not finish. Open the full conversation for details, then retry.",
      "会话加载超时。请确认 Better Codex Runtime 正在运行，然后重新加载。": "The conversation timed out while loading. Make sure Better Codex Runtime is running, then reload.",
      "无法加载会话。请检查网络和 Better Codex Runtime，然后重新加载。": "Unable to load the conversation. Check your network and Better Codex Runtime, then reload.",
      "没有权限加载会话。请调整权限后重新加载。": "You do not have permission to load the conversation. Adjust the permission, then reload.",
      "VPS 入口返回了 404；这表示路径或资源不存在，不能据此判断本机 Runtime 已停止。": "The VPS endpoint returned 404. The path or resource does not exist; this does not show that the local Runtime stopped.",
      "浏览器无法连接 VPS Relay 入口。请检查域名、网络、反向代理和 Relay 服务；本机 Runtime 状态未知。": "The browser cannot reach the VPS Relay endpoint. Check DNS, network, reverse proxy, and the Relay service. The local Runtime state is unknown.",
      "VPS 入口无法连接 Relay 服务。本机 Runtime 状态未知。": "The VPS endpoint cannot reach the Relay service. The local Runtime state is unknown.",
      "VPS Relay 当前没有连接到本机 Runtime。可能是 Runtime 停止、正在重启或网络中断。": "The VPS Relay is not connected to the local Runtime. The Runtime may be stopped or restarting, or the network may be interrupted.",
      "本机 Runtime 已主动断开与 VPS Relay 的连接，可能正在重启或已停止。": "The local Runtime actively disconnected from the VPS Relay. It may be restarting or stopped.",
      "VPS Relay 与本机 Runtime 的请求通道已中断，请等待重连后重试。": "The request channel between the VPS Relay and local Runtime was interrupted. Wait for reconnection, then retry.",
      "内容刚刚发生变化，请稍后重试。": "This content just changed. Try again shortly.",
      "内容刚刚发生变化，已同步最新状态，请重试本次操作。": "This content just changed. The latest state is synced; try the action again.",
      "相关内容不存在或已被移除。": "The requested content does not exist or was removed.",
      "当前账号没有执行此操作的权限。": "Your account does not have permission to perform this action.",
      "输入内容不符合要求，请检查后重试。": "Check the entered values and try again.",
      "当前状态无法完成此操作，请刷新后重试。": "This action is not available in the current state. Refresh and try again.",
      "服务暂时不可用，请稍后重试。": "The service is temporarily unavailable. Try again shortly.",
      "服务返回的数据格式异常，请稍后重试。": "The service returned an invalid response. Try again shortly.",
      "数据完整性检查失败，操作已停止。": "The integrity check failed, so the operation was stopped.",
      "安全校验失败，操作已停止。": "The security check failed, so the operation was stopped.",
      "服务发生异常，请稍后重试。": "The service encountered an error. Try again shortly.",
      "任务看板": "Task board",
      "打开任务看板": "Open task board",
      "智能体": "Agents",
      "管理智能体": "Manage agents",
      "创建和管理你的智能体": "Create and manage your agents",
      "Better Codex 服务需要重启": "Better Codex needs to restart",
      "当前页面与后台服务的连接已失效。请在终端运行下面的命令，完成后重新连接。": "The connection between this page and the background service has expired. Run the command below in your terminal, then reconnect.",
      "复制重启命令": "Copy restart command",
      "复制消息": "Copy message",
      "已复制": "Copied",
      "重新连接": "Reconnect",
      "正在连接…": "Connecting…",
      "错误详情": "Error details",
      "全部": "All",
      "已分配": "Assigned",
      "未分配": "Unassigned",
      "待规划": "Backlog",
      "待办": "Todo",
      "进行中": "In progress",
      "待审核": "In review",
      "调度中": "Scheduling",
      "已完成": "Done",
      "已阻塞": "Blocked",
      "归档": "Archive",
      "拖到这里即可归档": "Drop here to archive",
      "查看已归档卡片": "View archived cards",
      "已归档任务": "Archived tasks",
      "搜索已归档任务": "Search archived tasks",
      "所有项目": "All projects",
      "全部删除": "Delete all",
      "删除已归档聊天": "Delete archived chat",
      "删除项目中的全部内容": "Delete all project content",
      "确定删除项目中的全部已归档任务吗？": "Delete all archived tasks in this project?",
      "取消归档": "Unarchive",
      "已归档卡片": "Archived cards",
      "暂无已归档卡片": "No archived cards",
      "归档列表加载失败": "Unable to load archived cards",
      "无": "None",
      "低": "Low",
      "中": "Medium",
      "高": "High",
      "紧急": "Urgent",
      "超高": "Extra high",
      "无优先级": "No priority",
      "优先级": "Priority",
      "状态": "Status",
      "日期": "Date",
      "筛选": "Filter",
      "标签": "Labels",
      "新建": "New",
      "新建 issue": "New issue",
      "新建任务": "New task",
      "新建智能体": "New agent",
      "创建": "Create",
      "创建任务": "Create task",
      "删除": "Delete",
      "删除任务": "Delete task",
      "删除智能体": "Delete agent",
      "保存": "Save",
      "确认": "Confirm",
      "取消": "Cancel",
      "关闭": "Close",
      "返回": "Back",
      "重试": "Retry",
      "稍后": "Later",
      "展开": "Expand",
      "全屏": "Full screen",
      "缩小": "Minimize",
      "退出全屏": "Exit full screen",
      "缩放头像": "Zoom avatar",
      "项目": "Project",
      "无项目": "No project",
      "选择项目": "Select project",
      "选择责任人": "Select owner",
      "选择执行智能体": "Select agent",
      "更多创建选项": "More creation options",
      "任务标题": "Task title",
      "添加描述...": "Add description...",
      "添加标签": "Add label",
      "添加附件": "Add attachment",
      "移除附件": "Remove attachment",
      "搜索任务": "Search tasks",
      "搜索项目": "Search projects",
      "搜索项目...": "Search projects...",
      "搜索智能体": "Search agents",
      "负责人": "Owner",
      "创建人": "Creator",
      "创建者": "Creator",
      "未知创建人": "Unknown creator",
      "指定负责人": "Assign owner",
      "由我创建": "Created by me",
      "由我": "By me",
      "我": "Me",
      "你": "You",
      "未指派": "Not assigned",
      "未提供": "Not provided",
      "已同步": "Synced",
      "对话已被占用": "Conversation is in use",
      "这个对话已在 Codex CLI 或其他 Codex 客户端中打开。请先在 CLI 或对应客户端关闭这个对话，再返回这里重新打开。": "This conversation is open in Codex CLI or another Codex client. Close it in that client, then return here and try opening it again.",
      "自动运行": "Auto-run",
      "手动运行": "Manual run",
      "切换为自动运行": "Switch to auto-run",
      "切换为手动运行": "Switch to manual run",
      "切换到智能体": "Switch to agents",
      "手动创建": "Manual creation",
      "通过智能体创建": "Create with agent",
      "新建会话": "New chat",
      "新会话": "New chat",
      "会话": "Chat",
      "新建工作项": "New work item",
      "创建并打开会话": "Create and open chat",
      "责任人": "Owner",
      "适用范围": "Scope",
      "全部范围": "All scopes",
      "通用 Skill": "Global Skill",
      "项目专属 Skill": "Project Skill",
      "归属": "Belongs to",
      "来源 Skill": "Source Skill",
      "来源有更新": "Source updated",
      "来源有更新，当前版本继续保留": "Source updated; current version preserved",
      "创建项目专属版本": "Create project copy",
      "创建项目专属 Skill": "Create project Skill",
      "管理通用与项目专属的操作指引": "Manage global and project instructions",
      "运行模式说明": "Run mode",
      "帮助与设置": "Help and settings",
      "设置": "Settings",
      "快捷键": "Shortcuts",
      "快捷键设置": "Keyboard shortcuts",
      "为常用操作设置键盘快捷键。": "Set keyboard shortcuts for common actions.",
      "创建 Issue": "Create Issue",
      "打开创建 Issue 窗口": "Open the Create Issue window",
      "设置快捷键": "Set shortcut",
      "点击录入": "Click to record",
      "按下新的快捷键": "Press a new shortcut",
      "未设置": "Not set",
      "清除快捷键": "Clear shortcut",
      "关于": "About",
      "会话结束提醒": "Session completion alerts",
      "Issue 会话结束后在当前窗口显示提醒": "Show an alert in the current window when an issue session ends",
      "弹窗持续时间": "Popup duration",
      "1 秒": "1 second",
      "5 秒": "5 seconds",
      "10 秒": "10 seconds",
      "永久": "Permanent",
      "会话已结束": "Session ended",
      "通知": "Notifications",
      "个人资料": "Profile",
      "编辑个人资料": "Edit profile",
      "昵称和头像只用于 WebUI 协作": "Your name and avatar are used for WebUI collaboration",
      "昵称": "Display name",
      "更换头像": "Change avatar",
      "选择颜色": "Choose color",
      "蓝色": "Blue",
      "紫色": "Purple",
      "青色": "Teal",
      "绿色": "Green",
      "青柠色": "Lime",
      "琥珀色": "Amber",
      "橙色": "Orange",
      "粉色": "Pink",
      "资料已保存": "Profile saved",
      "语言": "Language",
      "界面语言": "Interface language",
      "选择 Better Codex 的界面语言": "Choose the language used by Better Codex",
      "调度": "Scheduling",
      "调度器模型": "Scheduler model",
      "这个模型用于 Issue 状态调度": "This model is used for Issue status routing",
      "调度器思考强度": "Scheduler reasoning effort",
      "这个强度用于 Issue 状态调度": "This level is used for Issue status routing",
      "跟随系统": "System",
      "中文": "Chinese",
      "软件更新": "Software updates",
      "更新状态": "Update status",
      "检查新版本": "Check for updates",
      "检查中…": "Checking…",
      "发现新版本": "Update available",
      "无法检查更新": "Unable to check",
      "版本信息": "Version info",
      "兼容版本": "Compatibility version",
      "运行状态": "Runtime status",
      "运行正常": "Running",
      "正在检查": "Checking",
      "已是最新版本": "Up to date",
      "从开始到完成，让 Codex 里的工作清晰可见。": "From start to finish, keep your work in Codex clear and visible.",
      "如果你喜欢 Better Codex，欢迎给我们一个 Star。": "If you like Better Codex, please give us a Star.",
      "最大并发": "Max concurrency",
      "模型": "Model",
      "推理": "Reasoning",
      "Fast": "Fast",
      "更快响应，增加用量": "Faster responses with increased usage",
      "指令": "Instructions",
      "默认": "Default",
      "自定义": "Custom",
      "点击": "Click",
      "，或者在已完成的会话卡片中": ", or use",
      "新消息，智能体才会执行任务。": "to post a new message in a completed conversation card. Only then will the agent run the task.",
      "会主动执行分配给自己的任务，但是不会执行": "automatically runs tasks assigned to it, but does not run",
      "区域的任务。": "tasks.",
      "代码审查": "Code review",
      "问题排查": "Troubleshooting",
      "前端实现": "Frontend implementation",
      "文档写作": "Documentation",
      "创意探索": "Creative exploration",
      "终端工程": "Terminal engineering",
      "通用助手": "General assistant",
      "修复工具": "Fixer",
      "安全审查": "Security review",
      "测试验证": "Test verification",
      "插件": "Plugins",
      "数据与存储": "Data and storage",
      "检查改动的正确性、回归风险和可维护性": "Review changes for correctness, regression risk, and maintainability",
      "负责 Codex 原生风格的界面实现与视觉验证": "Build and visually verify interfaces in the native Codex style",
      "定位崩溃、回归和异常行为的根因": "Find the root cause of crashes, regressions, and unexpected behavior",
      "通用任务处理": "General task handling",
      "代码实现": "Code implementation",
      "最大": "Maximum",
      "极致": "Ultra",
      "发送": "Send",
      "副本": "Copy",
      "复制卡片": "Copy card",
      "更多操作": "More actions",
      "本次启动关闭": "Disable for this launch",
      "正在重启 Better Codex": "Restarting Better Codex",
      "正在下载并校验新版本，请保持 Codex 打开。": "Downloading and verifying the update. Keep Codex open.",
      "正在重启 Better Codex Runtime，稍后会自动恢复。": "Restarting Better Codex Runtime. It will recover shortly.",
      "Better Codex 已恢复到上一版本。": "Better Codex has been restored to the previous version.",
      "展示模式": "Mockup mode",
      "导出展示数据": "Export mockup data",
      "导入展示数据": "Import mockup data",
      "重置展示数据": "Reset mockup data",
      "重置布局": "Reset layout",
      "重置": "Reset",
      "恢复默认展示卡片和布局吗？": "Restore the default mockup cards and layout?",
      "展示数据不能超过 16 MB": "Mockup data cannot exceed 16 MB",
      "展示数据格式无效": "The mockup data format is invalid",
      "展示卡片缺少标题": "A mockup card is missing a title",
      "展示模式不支持此操作": "This action is not supported in mockup mode",
      "展示模式不会运行真实任务": "Mockup mode does not run real tasks",
      "任务不存在": "Task not found",
      "修复任务卡片拖拽错位": "Fix task card drag misalignment",
      "复现缩放状态下的卡片拖拽偏移，并修正坐标计算与落点反馈。": "Reproduce card drag offset while zoomed, then correct the coordinate calculation and drop feedback.",
      "重写首页首屏价值主张": "Rewrite the homepage value proposition",
      "提炼 Better Codex 的核心价值，让新访客快速理解产品用途。": "Clarify Better Codex's core value so new visitors quickly understand what it does.",
      "调研独立开发者工作流": "Research indie developer workflows",
      "整理从想法到交付的常见流程、主要痛点和决策节点。": "Document common flows, key pain points, and decision points from idea to delivery.",
      "整理本地安装步骤": "Organize local installation steps",
      "核对安装、启动与常见异常处理步骤，统一文档表达。": "Verify installation, startup, and common troubleshooting steps, then unify the documentation.",
      "优化首次启动加载速度": "Improve first-launch loading speed",
      "定位启动阶段主要耗时，缩短进入任务看板前的等待时间。": "Identify the main startup costs and shorten the wait before the task board opens.",
      "整理功能亮点短文案": "Write concise feature highlights",
      "为任务分派、会话协作和代码审核分别撰写简洁说明。": "Write concise descriptions for task assignment, conversation collaboration, and code review.",
      "对比三款任务看板体验": "Compare three task board experiences",
      "对比 Linear、Notion 和 Trello 的卡片密度、拖拽与筛选体验。": "Compare card density, drag and drop, and filtering in Linear, Notion, and Trello.",
      "撰写产品发布介绍": "Write a product launch introduction",
      "围绕目标用户、核心问题和使用方式准备公开发布稿。": "Prepare launch copy around target users, the core problem, and how the product is used.",
      "完善会话回复失败提示": "Improve failed reply messages",
      "梳理超时、网络异常和权限问题的提示文案与重试入口。": "Refine messages and retry paths for timeouts, network failures, and permission issues.",
      "优化空状态引导语": "Improve empty-state guidance",
      "重写空看板与空会话的标题、说明和首个行动提示。": "Rewrite the title, explanation, and first action prompt for empty boards and conversations.",
      "收集首批用户常见问题": "Collect early user FAQs",
      "汇总安装、任务分派、运行状态和数据存储相关问题。": "Compile questions about installation, task assignment, runtime status, and data storage.",
      "准备更新日志发布稿": "Prepare release notes",
      "整理本次新增、修复和已知限制，形成可直接发布的更新日志。": "Organize this release's additions, fixes, and known limitations into publish-ready notes.",
      "统一看板筛选状态": "Unify task board filter state",
      "检查筛选逻辑与顶部计数，确保切换后卡片结果同步更新。": "Check filter logic and the top count so card results update together after a change.",
      "检查 Windows 安装流程": "Check the Windows installation flow",
      "核对安装、启动、权限与卸载流程，记录关键异常。": "Verify installation, startup, permissions, and uninstall flows, and record key issues.",
      "起草用户访谈邀请信": "Draft a user interview invitation",
      "说明访谈目的、所需时间和隐私边界，给出清晰回复方式。": "Explain the interview purpose, time needed, and privacy boundaries, with a clear way to reply.",
      "归档版本发布资料": "Archive release materials",
      "整理版本说明、截图、校验结果和发布链接，方便后续复盘。": "Organize release notes, screenshots, verification results, and launch links for later review.",
      "性能": "Performance",
      "文案": "Copywriting",
      "调研": "Research",
      "文档": "Documentation",
      "写作": "Writing",
      "选择头像": "Choose avatar",
      "预设头像": "Preset avatars",
      "更换": "Change",
      "保存失败": "Save failed",
      "正在自动保存…": "Saving…",
      "已自动保存": "Saved automatically",
      "创建失败": "Creation failed",
      "加载失败": "Loading failed",
      "启动失败": "Start failed",
      "发送失败": "Send failed",
      "回复失败": "Reply failed",
      "回复": "Reply",
      "回复中": "Replying",
      "回复完成": "Reply completed",
      "回复进行中…": "Replying…",
      "回复已完成": "Reply completed",
      "等待对话": "Waiting for conversation",
      "加载中…": "Loading…",
      "正在加载任务看板": "Loading task board",
      "加载对话…": "Loading conversation…",
      "正在打开…": "Opening…",
      "在此回复智能体…": "Reply to the agent here…",
      "对话": "Conversation",
      "详情": "Details",
      "关闭详情": "Close details",
      "Issue 详情": "Issue details",
      "名称": "Name",
      "介绍": "Description",
      "智能体名称": "Agent name",
      "尚未添加介绍": "No description yet",
      "没有匹配的智能体": "No matching agents",
      "此分类暂无智能体": "No agents in this category",
      "裁剪头像": "Crop avatar",
      "拖动图片调整位置": "Drag the image to adjust its position",
      "正在更新": "Updating",
      "正在更新 Better Codex": "Updating Better Codex",
      "更新完成": "Update complete",
      "更新未完成": "Update incomplete",
      "稍后提醒": "Remind me later",
      "Better Codex 有新版本": "A new Better Codex version is available",
      "Better Codex 已是最新版本": "Better Codex is up to date",
      "Better Codex 保持当前版本运行。": "Better Codex will continue running on the current version.",
      "正在下载并校验新版本，请不要关闭 Codex。": "Downloading and verifying the update. Please do not close Codex.",
      "正在重启 Codex，稍后会自动恢复。": "Restarting Codex. It will resume shortly.",
      "刚刚完成检查，无需更新。": "Just checked. No update is needed.",
      "任务已完成": "Task completed",
      "知道了": "Got it",
      "附带文件：": "Attached files:",
      "部分文件无法读取本地路径，已跳过": "Some files could not be read locally and were skipped",
      "当前环境无法读取本地文件路径": "The current environment cannot read local file paths",
      "无关联对话。": "No linked conversation.",
      "暂无对话，可在下方回复或打开完整对话。": "No conversation yet. Reply below or open the full conversation.",
      "图片不能超过 10 MB": "Images must be 10 MB or smaller",
      "请选择 PNG、JPEG 或 WebP 图片": "Choose a PNG, JPEG or WebP image",
      "无法读取这张图片": "Unable to read this image",
      "创建智能体 Issue 需要本地工作区：请先打开该项目下的一个 Codex 会话": "Creating an agent issue requires a local workspace. Open a Codex conversation in this project first.",
      "粘贴的图片": "Pasted image",
      "图片保存失败": "Unable to save the image",
      "添加描述": "Add description",
      "展开描述": "Show more",
      "收起描述": "Show less",
      "对话链接无效。": "The conversation link is invalid.",
      "对话仍在加载，请稍后重试。": "The conversation is still loading. Try again shortly.",
      "任务正在执行，请先等待完成。": "The task is still running. Wait for it to finish first.",
      "任务仍在整理中，请稍后再编辑。": "The task is still being organized. Try editing it again shortly.",
      "当前为手动运行，请先点击“立即开始任务”。": "Manual run is enabled. Click “Start task now” first.",
      "待规划中的 Issue 不会自动触发任务，请先移出待规划区。": "Issues in Backlog do not trigger tasks automatically. Move it out of Backlog first.",
      "当前没有运行中的任务": "No agents are currently working",
      "查看运行中的任务": "View running tasks",
      "暂无任务": "No tasks",
      "手动运行时，只有点击“立即开始任务”才会触发智能体任务。": "In manual mode, agent tasks start only after you click “Start task now”.",
      "自动运行时，只要 Issue 不在「待规划」区，你发送的新消息都会触发任务；「待规划」里的 Issue 不会自动触发。": "In auto-run mode, new messages trigger tasks unless the Issue is in Backlog; Issues in Backlog do not trigger tasks automatically.",
      "未关联对话。": "No linked conversation.",
      "确定删除任务 “": "Delete task “",
      "确定删除所有已归档任务吗？": "Delete all archived tasks?",
      "吗？": "”?",
      "刚刚": "Just now",
      "分钟": "minutes",
      "小时": "hours",
      "天": "days",
      "更新于": "Updated",
      "个筛选": "filters",
      "个智能体工作中": "agents working",
      "条": "items",
      "最近 24 小时": "Last 24 hours",
      "最近 7 天": "Last 7 days",
      "最近 30 天": "Last 30 days",
      "暂无可选项": "No options available",
      "清除筛选": "Clear filters",
      "复制本地 workdir 路径": "Copy local workdir path",
      "工作中": "Working",
      "排队中": "Queued",
      "执行失败": "Execution failed",
      "已停止": "Stopped",
      "未开始": "Not started",
      "无法连接 Better Codex Runtime": "Unable to connect to Better Codex Runtime",
      "打开完整会话": "Open in conversation",
      "前往会话": "Open conversation",
      "请前往会话继续对话": "Continue in the conversation",
      "任务正在进行中": "Task is running",
      "立即开始任务": "Start task now",
      "切换到手动": "Switch to manual",
      "继续创建": "Keep creating",
      "指派给": "Assign to",
      "可选": "Optional",
      "建议": "Suggestions",
      "开始对话": "Start the conversation",
      "补充下一步要求，智能体会继续处理。": "Add your next request and the agent will continue.",
      "在下方输入消息并发送": "Type a message below and send it",
      "正在处理任务": "Working on the task",
      "智能体回复产生后会显示在这里。": "The agent's response will appear here when available.",
      "请稍候": "Please wait",
      "输入下一步要求…": "Enter your next request…",
      "调整侧边栏宽度": "Resize sidebar",
      "头像": "Avatar",
      "上传图片": "Upload image",
      "使用此头像": "Use this avatar",
      "点击选择预设图标，或上传图片": "Choose a preset icon or upload an image",
      "从预设图标中选择，也可以上传图片": "Choose a preset icon or upload an image",
      "创建智能体": "Create agent",
      "Codex 默认智能体": "Default Codex agent",
      "说明这个智能体适合承担什么工作": "Describe what this agent is good at",
      "定义职责、工作方式和输出要求": "Define responsibilities, workflow, and output requirements",
      "权限": "Permissions",
      "只读": "Read-only",
      "工作区可写": "Workspace write access",
      "完全访问": "Full access",
      "仅可读取工作区文件，不能修改": "Can read workspace files but cannot modify them",
      "可修改当前工作区内的文件": "Can modify files in the current workspace",
      "可不受限制地访问互联网和电脑上的任何文件": "Unrestricted access to the internet and files on this computer",
      "已经执行过对话的 Issue 只能修改状态、优先级和指派人。": "Issues with an executed conversation can only change status, priority, and assignee.",
      "终止任务后才能打开对话，是否终止任务？": "The task must be stopped before opening the conversation. Stop it now?",
      "终止并打开": "Stop and open",
      "正在终止…": "Stopping…",
      "升级会中断正在执行的任务": "Updating will interrupt running tasks",
      "仍要升级吗？正在执行的任务会被立即中断，未完成的工作可能丢失。": "Update anyway? Running tasks will be interrupted immediately, and unfinished work may be lost.",
      "仍要升级": "Update anyway",
      "忽略当前版本": "Ignore this version",
      "立即更新": "Update now",
      "暂无项目": "No projects",
      "告诉智能体要做什么，例如：“修复项目里任务运行状态不可见的问题”": "Tell the agent what to do, for example: “Fix the invisible task run status in the project”"
    } };
    localeResources.en["创建新项目"] = "Create new project";
    localeResources.en["浏览本机文件夹"] = "Browse folders on this device";
    localeResources.en["更改文件夹"] = "Change folder";
    localeResources.en["选择当前文件夹"] = "Select current folder";
    localeResources.en["目录路径"] = "Folder path";
    localeResources.en["上一级"] = "Up one level";
    localeResources.en["主目录"] = "Home";
    localeResources.en["文件系统"] = "File system";
    localeResources.en["打开文件夹"] = "Open folder";
    localeResources.en["显示隐藏目录"] = "Show hidden folders";
    localeResources.en["不显示隐藏目录"] = "Hide hidden folders";
    localeResources.en["新建文件夹"] = "New folder";
    localeResources.en["文件夹名称"] = "Folder name";
    localeResources.en["请输入文件夹名称"] = "Enter a folder name";
    localeResources.en["正在创建…"] = "Creating…";
    localeResources.en["文件夹已存在"] = "A folder with this name already exists";
    localeResources.en["文件夹名称无效"] = "The folder name is invalid";
    localeResources.en["无法创建文件夹"] = "Unable to create the folder";
    localeResources.en["正在读取文件夹…"] = "Loading folders…";
    localeResources.en["这个文件夹中没有子文件夹"] = "This folder has no subfolders";
    localeResources.en["隐藏目录已屏蔽"] = "Hidden folders are hidden";
    localeResources.en["仅显示前 500 个文件夹"] = "Showing the first 500 folders";
    localeResources.en["无法读取文件夹"] = "Unable to read this folder";
    localeResources.en["本机 Runtime 版本不支持远程文件夹浏览"] = "The local Runtime does not support remote folder browsing";
    localeResources.en["文件不能超过 10 MB"] = "Files must be 10 MB or smaller";
    localeResources.en["部分文件超过 10 MB，已跳过"] = "Some files larger than 10 MB were skipped";
    localeResources.en["最多传输 4 个文件且总大小不能超过 20 MB"] = "Transfer up to 4 files with a total size of 20 MB or less";
    localeResources.en["部分文件超出传输限制，已跳过"] = "Some files exceeded the transfer limits and were skipped";
    localeResources.en["无法读取文件"] = "Unable to read the file";
    Object.assign(localeResources.en, {
      "附件预览": "Attachment preview",
      "附件": "Attachment",
      "打开附件": "Open attachment",
      "下载附件": "Download attachment",
      "正在加载附件…": "Loading attachment…",
      "无法打开附件": "Unable to open attachment",
      "不支持预览此文件，可下载后查看。": "Preview is unavailable for this file. Download it to view the contents.",
      "图片": "Image",
      "PDF 文档": "PDF document",
      "文本文档": "Text document",
      "文件": "File",
      "原始链接": "Original link"
    });
    localeResources.en["源码开发版"] = "Source development build";
    localeResources.en["发现兼容更新"] = "Compatibility update available";
    localeResources.en["源码开发版仅检查兼容层更新，核心版本请更新源码并重新构建。"] = "Source builds only check for compatibility updates. Update the source and rebuild to change the core version.";
    Object.assign(localeResources.en, {
      "远程访问": "Remote access",
      "从浏览器安全访问你的任务看板": "Access your task board securely from a browser",
      "部署 Hub": "Deploy Hub",
      "复制提示词，交给能访问 VPS 的 Codex": "Copy the prompt for Codex with VPS access",
      "复制安装提示词": "Copy install prompt",
      "提示词已复制": "Prompt copied",
      "连接 Hub": "Connect Hub",
      "输入 VPS 部署后的 HTTPS 地址": "Enter the HTTPS URL of the VPS deployment",
      "访问地址": "Access URL",
      "复制连接指令": "Copy connect command",
      "服务在线": "Online",
      "无法访问": "Unavailable",
      "服务版本": "Service version",
      "更新通道": "Update channel",
      "稳定版": "Stable",
      "预览版": "Preview",
      "尚未检查更新": "Updates have not been checked yet",
      "当前通道暂无新版本": "No newer version in this channel",
      "此通道仅检查正式版，不会提示 Beta 更新。": "This channel checks stable releases only. Beta updates are not included.",
      "前往网站管理更新": "Manage updates on the website",
      "检查升级": "Check for update",
      "升级": "Upgrade",
      "最新": "Current",
      "同步协议": "Sync protocol",
      "最后同步": "Last sync",
      "尚未同步": "Not synced yet",
      "刷新状态": "Refresh status",
      "指令已复制": "Command copied",
      "状态检查失败": "Status check failed",
      "部署在 VPS": "Deployed on VPS",
      "检测中": "Checking",
      "登录设备": "Signed-in devices",
      "管理已登录 Better Codex Relay 的浏览器": "Manage browsers signed in to Better Codex Relay",
      "正在读取登录设备…": "Loading signed-in devices…",
      "暂无登录设备": "No signed-in devices",
      "最近活动": "Last active",
      "已记住": "Remembered",
      "临时会话": "Temporary session",
      "退出登录": "Sign out",
      "此设备需要重新输入账户密码才能访问。": "This device will need the account password to sign in again.",
      "设备读取失败": "Unable to load devices",
      "台设备": " devices",
      "升级状态": "Update status",
      "正在检查更新": "Checking for updates",
      "升级请求已提交": "Update request submitted",
      "正在准备升级": "Preparing update",
      "正在验证发布版本": "Verifying release",
      "正在备份服务数据": "Backing up service data",
      "正在下载升级版本": "Downloading update",
      "正在重新构建服务": "Rebuilding service",
      "正在重启远程服务": "Restarting remote service",
      "正在验证服务状态": "Verifying service health",
      "远程服务升级完成": "Remote service updated",
      "发现可用升级": "Update available",
      "正在升级": "Updating"
    });
    localeResources.en["有任务正在运行，请等待任务结束后再更新。"] = "A task is running. Wait for it to finish before updating.";
    localeResources.en["更新正在进行中，请稍候。"] = "An update is already in progress. Please wait.";
    localeResources.en["当前部署尚未启用在线升级。"] = "Online updates are not enabled for this deployment.";
    localeResources.en["数据所在磁盘空间不足，请清理空间后重试。"] = "The data disk is low on space. Free up space and try again.";
    localeResources.en["服务器磁盘空间不足，请清理空间后重试升级（至少保留 5 GiB 和 5% 可用空间）。"] = "The server is low on disk space. Free up space before retrying the update (at least 5 GiB and 5% free space required).";
    localeResources.en["远程服务升级完成。"] = "The remote service update is complete.";
    localeResources.en["远程服务正在重启，页面稍后会自动恢复。"] = "The remote service is restarting. This page will reconnect automatically.";
    localeResources.en["正在备份并升级远程服务，请不要关闭页面。"] = "Backing up and updating the remote service. Keep this page open.";
    localeResources.en["下载的更新版本与发布版本不一致，请稍后重试。"] = "The downloaded version does not match the release. Try again later.";
    localeResources.en["更新包验证失败，已保留当前版本。"] = "The update package could not be verified. The current version was kept.";
    localeResources.en["同步中"] = "Syncing";
    localeResources.en["同步冲突"] = "Sync conflict";
    localeResources.en["更新后的版本验证失败。"] = "The updated version could not be verified.";
    localeResources.en["Better Codex 重启超时。"] = "Better Codex took too long to restart.";
    localeResources.en["无法下载更新，请检查网络后重试。"] = "The update could not be downloaded. Check your network and try again.";
    localeResources.en["更新包安全校验失败，已保留当前版本。"] = "The update failed its security check. The current version was kept.";
    localeResources.en["更新进程意外中断。"] = "The update was interrupted.";
    localeResources.en["更新失败，请稍后重试。"] = "The update failed. Try again later.";
    localeResources.en["Codex 会话连接失败"] = "Codex connection failed";
    localeResources.en["原生会话正在创建，请稍后重试。"] = "The native conversation is being created. Try again shortly.";
    localeResources.en["停止任务"] = "Stop task";
    localeResources.en["停止等待"] = "Stop waiting";
    localeResources.en["打开完整会话"] = "Open full conversation";
    localeResources.en["全屏查看对话"] = "Read conversation full screen";
    localeResources.en["重新生成标题"] = "Regenerate title";
    localeResources.en["标题生成中"] = "Regenerating title";
    localeResources.en["标题生成失败"] = "Title generation failed";
    localeResources.en["加入队列"] = "Queue message";
    localeResources.en["正在思考与处理…"] = "Thinking…";
    localeResources.en["正在发送…"] = "Sending…";
    localeResources.en["队列中 {{count}} 条消息"] = "{{count}} queued messages";
    localeResources.en["立即发送"] = "Send now";
    localeResources.en["编辑队列消息"] = "Edit queued message";
    localeResources.en["删除队列消息"] = "Delete queued message";
    localeResources.en["保存修改"] = "Save changes";
    localeResources.en["取消编辑"] = "Cancel editing";
    localeResources.en["当前任务已结束，消息会按队列顺序发送。"] = "The current task has finished. This message will be sent in queue order.";
    localeResources.en["该队列消息已发生变化，正在同步最新状态。"] = "This queued message changed. Syncing the latest state.";
    localeResources.en["该队列消息已发生变化，已同步最新状态。"] = "This queued message changed. The latest state is synced.";
    localeResources.en["队列操作失败，请重试。"] = "The queue action failed. Try again.";
    localeResources.en["正在停止…"] = "Stopping…";
    localeResources.en["未命名任务"] = "Untitled issue";
    localeResources.en["无法确定会话所属项目。请先把会话放入一个项目。"] = "We couldn't determine this conversation's project. Move it into a project first.";
    localeResources.en["该会话对应的 Issue 已归档，请先取消归档。"] = "The issue linked to this conversation is archived. Restore it first.";
    localeResources.en["发送方式"] = "Send with";
    localeResources.en["发送消息"] = "Send messages";
    localeResources.en["选择消息输入框的发送按键"] = "Choose the key used to send from message fields";
    localeResources.en["横向滚动任务看板"] = "Scroll the task board horizontally";
    localeResources.en["向左滚动任务看板"] = "Scroll the task board left";
    localeResources.en["向右滚动任务看板"] = "Scroll the task board right";
    Object.assign(localeResources.en, {
      "项目文档": "Project documentation",
      "项目章程": "Charter",
      "产品地图": "Product map",
      "架构地图": "Architecture map",
      "路线图": "Roadmap",
      "工作图": "Work graph",
      "交付图": "Delivery graph",
      "证据与学习": "Evidence and learning",
      "生成完整文档": "Generate documentation",
      "重新生成全部": "Regenerate all",
      "生成智能体": "Generation agent",
      "使用默认智能体": "Use default agent",
      "修改意见": "Revision feedback",
      "告诉智能体哪些内容需要修正、补充或重新组织": "Tell the agent what to correct, add, or reorganize",
      "已完成 {done}/7 个视图": "{done} of 7 views complete",
      "正在生成 {view}": "Generating {view}",
      "等待生成": "Waiting to generate",
      "已生成": "Generated",
      "生成失败": "Generation failed",
      "生成任务已提交，等待运行端接收。": "The generation task was submitted and is waiting for the runtime.",
      "生成中…": "Generating…",
      "项目文档生成超时，请重试。": "Project documentation generation timed out. Try again.",
      "运行端未及时响应，请确认 Better Codex 在线后重试。": "The runtime did not respond in time. Confirm Better Codex is online and try again.",
      "项目文件夹不可用，无法生成文档。": "The project folder is unavailable, so documentation cannot be generated.",
      "项目文档生成未能完成，请重试。": "Project documentation could not be completed. Try again.",
      "当前显示上一版本，新的内容正在生成。": "Showing the previous version while new content is generated.",
      "这个视图正在形成": "This view is taking shape",
      "代码、Issue 与会话证据正在被整理为结构化文档。": "Code, issue, and conversation evidence is being organized into structured documentation.",
      "尚未生成这个视图": "This view has not been generated yet",
      "选择智能体后生成七个相互关联的项目视图。": "Choose an agent to generate seven connected project views.",
      "该视图生成失败，重新生成时可附上修改意见。": "This view failed to generate. Add feedback when regenerating.",
      "视图关系": "View relationships"
    });
    Object.assign(localeResources.en, {
      "项目管理": "Projects",
      "管理项目": "Manage projects",
      "更多": "More",
      "更多功能": "More features",
      "Codex 额度": "Codex usage",
      "已归档聊天": "Archived chats",
      "用量加载中…": "Loading usage…",
      "用量暂不可用": "Usage unavailable",
      "点击刷新用量": "Click to refresh usage",
      "重置时间": "Resets at",
      "剩余": "Remaining",
      "每周": "Weekly",
      "天": " days",
      "小时": "h",
      "分钟": "m",
      "查看 Codex 额度": "View Codex usage",
      "切换为深色主题": "Switch to dark theme",
      "切换为浅色主题": "Switch to light theme",
      "创建项目": "Create project",
      "删除项目": "Delete project",
      "项目、任务与规划会从 Better Codex 和 Codex 清单移除，磁盘文件夹和文件会保留。": "The project, tasks, and planning will be removed from Better Codex and the Codex list. The folder and files on disk will remain.",
      "项目正在运行或生成内容，请等待完成后再删除。": "The project has running work or generated content in progress. Wait for it to finish before deleting the project.",
      "Codex 项目清单无法读取，未删除任何内容。": "The Codex project list could not be read. Nothing was deleted.",
      "Codex 项目清单中找不到这个项目，未删除任何内容。": "This project was not found in the Codex project list. Nothing was deleted.",
      "项目删除失败，Codex 项目清单也未能自动恢复，请立即检查 Codex 项目列表。": "Project deletion failed, and the Codex project list could not be restored automatically. Check the Codex project list now.",
      "项目名称": "Project name",
      "项目文件夹": "Project folder",
      "选择文件夹": "Choose folder",
      "选择本地项目文件夹": "Choose a local project folder",
      "正在选择…": "Choosing…",
      "返回项目列表": "Back to projects",
      "最近 Issue 与对话": "Recent issues and conversations",
      "正在加载最近 Issue": "Loading recent issues",
      "项目介绍": "Project overview",
      "重新生成": "Regenerate",
      "生成项目介绍": "Generate overview",
      "正在读取项目代码和会话…": "Reading project code and conversations…",
      "尚未生成项目介绍": "No project overview yet",
      "项目介绍生成失败，可重新生成。": "The overview could not be generated. Try again.",
      "创建后会加入 Codex 的项目列表。": "The project will be added to Codex.",
      "创建项目后，它会出现在 Codex 的项目列表中。": "Create a project to add it to Codex.",
      "暂无关联 Issue": "No linked issues",
      "已归档": "Archived",
      "打开 Issue 详情": "Open issue details",
      "取消归档后继续对话": "Unarchive to continue the conversation",
      "项目概况": "Project summary",
      "个项目": "projects",
      "个文件夹": "folders",
      "创建 Codex 项目": "Create Codex project",
      "无法选择文件夹": "Unable to choose a folder",
      "新建工作项": "New work item",
      "有风险": "At risk",
      "需关注": "Needs attention",
      "进展正常": "On track",
      "探索": "Explore",
      "计划": "Plan",
      "开发": "Build",
      "验证": "Validate",
      "交付": "Deliver",
      "下一版本": "Next version",
      "稳定版本": "Stable release",
      "今天": "Today",
      "你": "You",
      "未指派": "Unassigned",
      "正在加载当前工作": "Loading current work",
      "当前没有进行中的工作": "No work is currently in progress",
      "正在加载待处理事项": "Loading attention items",
      "需解阻": "Unblock",
      "需复核": "Review",
      "需处理": "Action needed",
      "没有需要你处理的事项": "Nothing needs your attention",
      "项目负责人": "Project owner",
      "待命": "Standing by",
      "未提供项目文件夹": "No project folder",
      "项目协作者": "Project collaborators",
      "项目页面": "Project pages",
      "概览": "Overview",
      "工作": "Work",
      "项目说明": "Project brief",
      "当前状态": "Current status",
      "进行中": "In progress",
      "待复核": "Awaiting review",
      "阻塞": "Blocked",
      "当前版本": "Current version",
      "下一里程碑": "Next milestone",
      "当前阶段": "Current phase",
      "版本计划与里程碑": "Release plan and milestones",
      "已发布": "Released",
      "当前安装": "Installed",
      "版本收口": "Release hardening",
      "稳定交付": "Stable delivery",
      "当前安装版本": "Currently installed",
      "预计": "Estimated",
      "当前工作": "Current work",
      "等你处理": "Needs your attention",
      "活跃协作者": "Active collaborators",
      "规划": "Planning",
      "项目规划": "Project plan",
      "规划对话": "Planning conversation",
      "与智能体对话，把目标、里程碑、风险和交付证据整理成可执行计划。": "Talk with an agent to turn goals, milestones, risks, and delivery evidence into an actionable plan.",
      "规划摘要": "Plan summary",
      "里程碑时间线": "Milestone timeline",
      "按目标日期排序": "Ordered by target date",
      "日期待定": "Date pending",
      "已排期": "scheduled",
      "预期成果": "Outcomes",
      "里程碑": "Milestones",
      "工作流": "Workstreams",
      "风险": "Risks",
      "决策": "Decisions",
      "待确认": "Open questions",
      "交付路径": "Delivery",
      "证据": "Evidence",
      "尚未生成项目计划": "No project plan yet",
      "从一个问题开始，智能体会读取代码、Issue 和关联会话。": "Start with a question. The agent will read the code, issues, and linked conversations.",
      "梳理这个项目的目标、范围和非目标": "Clarify this project's goals, scope, and non-goals",
      "根据当前代码和 Issue 生成下一阶段计划": "Create the next-stage plan from the current code and issues",
      "找出当前最大的风险、依赖和待确认问题": "Find the biggest risks, dependencies, and open questions",
      "询问项目规划…": "Ask about the project plan…",
      "新对话": "New conversation",
      "开始新规划对话": "Start a new planning conversation",
      "这会清除当前规划对话和计划版本。": "This clears the current planning conversation and plan revisions.",
      "规划中…": "Planning…",
      "计划版本": "Plan revision",
      "暂无明确日期": "No target date",
      "依赖": "Dependencies",
      "用户确认": "User confirmed",
      "智能体推断": "Agent inference",
      "代码事实": "Code fact",
      "Issue 事实": "Issue fact",
      "会话事实": "Conversation fact",
      "用户输入": "User input",
      "建议": "Proposed",
      "已确认": "Confirmed",
      "确认总纲": "Confirm charter",
      "正在确认…": "Confirming…",
      "解除绑定": "Unbind conversation",
      "正在解除…": "Unbinding…",
      "解除后，此会话将作为普通 Codex 会话继续使用，聊天记录会保留。": "This conversation will continue as an ordinary Codex chat, with its chat history preserved.",
      "会话正在运行，请等待完成后再解除绑定。": "Wait for the conversation to finish before unbinding it.",
      "会话绑定已更新，请重新打开后再试。": "The conversation binding has changed. Reopen it and try again.",
      "会话仍在处理消息，请等待完成后再操作。": "Wait for the conversation to finish processing before continuing.",
      "总纲会话正在运行，请等待回复完成后再确认。": "The charter conversation is running. Wait for the reply before confirming.",
      "暂无可确认的总纲，请先完成总纲内容。": "Complete the charter before confirming it.",
      "历史会话仅供查看。": "Historical conversations are read-only.",
      "当前页面仅供查看。": "This page is read-only.",
      "计划生成失败，当前仍显示上一版本。": "Plan generation failed. The previous revision is still shown.",
      "规划会话正在运行，请等待完成。": "The planning conversation is running. Wait for it to finish.",
      "规划会话未能完成，请重试。": "The planning conversation could not be completed. Try again.",
      "项目事实": "Project facts",
      "计划内容来自规划对话，不会自动修改 Issue。": "Plan content comes from the planning conversation and does not automatically change issues."
    });
    Object.assign(localeResources.en, {
      "错误报告": "Error report",
      "发生了一个错误": "An error occurred",
      "错误信息、请求信息和直接相关日志已保留，可直接复制给开发者。": "The error, request details, and directly related logs are ready to copy.",
      "上一条": "Previous",
      "下一条": "Next",
      "复制当前错误": "Copy current error",
      "复制全部错误": "Copy all errors",
      "移除当前错误": "Remove current error",
      "复制失败": "Copy failed",
      "列表数据暂时无法读取，请稍后重试。": "List data is temporarily unavailable. Try again shortly.",
      "任务内容超过长度限制，请缩短内容或作为附件上传。": "The task content is too long. Shorten it or upload it as an attachment.",
      "网络连接不稳定，正在等待恢复。": "The network connection is unstable. Waiting to reconnect."
    });
    const bridgeRequests = /* @__PURE__ */ new Map();
    const appServerRequests = /* @__PURE__ */ new Map();
    const sessionHandoffPending = /* @__PURE__ */ new Set();
    let nativeThreadOpenBypass = "";
    const relayId = "better-codex:" + (globalThis.crypto?.randomUUID?.() || Date.now() + ":" + Math.random().toString(36).slice(2));
    const relayThreads = /* @__PURE__ */ new Set();
    let bridgeSequence = 0;
    let appServerSequence = 0;
    let diagnosticSequence = 0;
    const diagnosticLog = [];
    const errorQueue = [];
    let errorQueueIndex = 0;
    let errorDialog = null;
    let entry = null;
    let nativeReturnEntry = null;
    let agentsEntry = null;
    let projectsEntry = null;
    let auxiliaryNavigation = null;
    let moreEntry = null;
    let auxiliaryMenu = null;
    let profileEntry = null;
    let usageEntry = null;
    let themeEntry = null;
    let auxiliaryMenuDismiss = null;
    let panel = null;
    let inlineConversation = null;
    let projectSurfaceCache = null;
    let inlineConversationCacheRestoring = false;
    let inlineConversationRoot = null;
    let inlineNativePanelObserver = null;
    let inlineNativePanelNode = null;
    let inlineConversationAdapter = null;
    let inlineConversationRequest = 0;
    let inlineConversationLoading = false;
    let inlineConversationError = "";
    let inlineConversationDetailsMarkup = "";
    let inlineConversationHeaderMarkup = "";
    let inlineConversationNavigationMarkup = "";
    let inlineConversationResize = null;
    let inlineConversationResizeFrame = null;
    let inlineConversationWidth = Math.min(4096, Math.max(280, Number(localStorage.getItem("better-codex-conversation-details-width")) || 360));
    let inlineConversationDetailsOpen = !window.matchMedia("(max-width: 980px)").matches;
    let inlineConversationCompactDetailsOpen = false;
    let inlineConversationNavigationRequest = 0;
    let panelSizeCleanup = null;
    let projectRefreshButton = null;
    let projectEmptyState = null;
    let projectHealthBadge = null;
    let projectRefreshLoading = false;
    let managedButtonSequence = 0;
    const managedButtons = /* @__PURE__ */ new Set();
    let adoptedIconButtonSequence = 0;
    let adoptedButtonSequence = 0;
    let adoptedBadgeSequence = 0;
    let adoptedFeedbackSequence = 0;
    let adoptedPatternSequence = 0;
    let featureControllers = null;
    let observer = null;
    let refreshPending = false;
    let refreshTimer = null;
    let pollTimer = null;
    let liveUnsubscribe = null;
    let liveDirty = false;
    let passiveNetworkErrorVisible = false;
    let updateTimer = null;
    let retryClockTimer = null;
    let relayTimer = null;
    let relayBusy = false;
    let relayHeartbeatBusy = false;
    let relayTurnProbeAt = 0;
    let relayCapability = "unknown";
    let relayCapabilityError = "";
    let relayCapabilityCheckedAt = 0;
    let relayAppSessionId = "";
    let relayCurrentThreadId = "";
    let relayEventQueue = Promise.resolve();
    let relayCommandInFlight = false;
    let relayBufferedEvents = [];
    const relayGuardianDenials = /* @__PURE__ */ new Map();
    let updateNotice = null;
    let updateNoticeResizeObserver = null;
    let boardScrollResizeObserver = null;
    let issueSessionSnapshot = /* @__PURE__ */ new Map();
    let completionNoticesRestored = false;
    let completionNoticeStack = null;
    const completionNoticeDismissals = /* @__PURE__ */ new Map();
    const completionNoticeTimers = /* @__PURE__ */ new Map();
    let dismissedUpdateVersion = sessionStorage.getItem("better-codex-dismissed-update") || "";
    let ignoredUpdateVersion = localStorage.getItem("better-codex-ignored-update") || "";
    let filterDismiss = null;
    let createMenuDismiss = null;
    let issueMenu = null;
    let issueMenuDismiss = null;
    let issueLongPress = null;
    let suppressIssueClickUntil = 0;
    let avatarPickerClose = null;
    let suppressAgentOutside = false;
    let agentInspectorResize = null;
    let draggingIssueId = "";
    let sessionDragPointer = null;
    let sessionDropInFlight = false;
    const listRequests = /* @__PURE__ */ new Map();
    let suppressSessionClickUntil = 0;
    let active = false;
    let bootstrapReady = false;
    let bootstrapFailure = null;
    let bootstrapPromise = null;
    function componentContext(feature, mountId) {
      return {
        feature,
        host: HOST_ADAPTER.kind + (HOST_ADAPTER.remote ? ":remote" : ""),
        mountId,
        themeSource: window.__betterCodexThemeDiagnostics__?.themeSource || "fallback"
      };
    }
    function controllers() {
      if (featureControllers) return featureControllers;
      featureControllers = {
        agents: createAgentsController({ render: () => renderAgents() }),
        board: createBoardController({ render: () => renderBoard() }),
        projects: createProjectsController({ render: () => renderProjects() }),
        settings: createSettingsController({ open: (initialView) => renderSettingsOverlay(initialView) })
      };
      return featureControllers;
    }
    function activateFeature(name) {
      const activeControllers = controllers();
      ["agents", "board", "projects"].forEach((feature) => {
        if (feature !== name) activeControllers[feature].deactivate();
      });
      activeControllers[name].render();
    }
    function projectRefreshProps() {
      return {
        accessibleName: t(projectRefreshLoading ? "正在刷新项目" : "刷新项目"),
        disabled: state.mockup,
        icon: LUCIDE_ICONS.refresh,
        label: t(projectRefreshLoading ? "正在刷新项目" : "刷新项目"),
        loading: projectRefreshLoading,
        onPress: async () => {
          projectRefreshLoading = true;
          syncProjectRefreshButton();
          try {
            await perform(() => loadProjects());
          } finally {
            projectRefreshLoading = false;
            syncProjectRefreshButton();
          }
        },
        variant: "ghost"
      };
    }
    function syncProjectRefreshButton() {
      projectRefreshButton?.update(projectRefreshProps());
    }
    let routeSeen = false;
    let routeSuppressed = false;
    let destroyed = false;
    function label(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    }
    function escapeHtml2(value) {
      return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
    }
    function t(value) {
      const source = String(value ?? "");
      if (localeResources[state.locale]?.[source]) return localeResources[state.locale][source];
      if (state.locale === "zh-CN" || !/[\p{Script=Han}]/u.test(source)) return source;
      const leading = source.match(/^\s*/)?.[0] || "";
      const trailing = source.match(/\s*$/)?.[0] || "";
      const core = source.slice(leading.length, source.length - trailing.length || void 0);
      if (localeResources.en[core]) return leading + localeResources.en[core] + trailing;
      if (core === "更多操作") return leading + "More actions" + trailing;
      if (core === "本次启动关闭") return leading + "Disable for this launch" + trailing;
      let match = core.match(/^(\d+) 个智能体工作中$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " agent working" : " agents working") + trailing;
      match = core.match(/^(\d+) 项工作进行中$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " work item running" : " work items running") + trailing;
      match = core.match(/^(\d+) 个筛选$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " filter" : " filters") + trailing;
      match = core.match(/^(\d+) 个任务$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " task" : " tasks") + trailing;
      match = core.match(/^(\d+) 条$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " message" : " messages") + trailing;
      match = core.match(/^更新于 (.+)$/);
      if (match) return leading + "Updated " + t(match[1]) + trailing;
      match = core.match(/^归档于 (.+)$/);
      if (match) return leading + "Archived " + t(match[1]) + trailing;
      match = core.match(/^(\d+) 分钟前$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " minute ago" : " minutes ago") + trailing;
      match = core.match(/^(\d+) 小时前$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " hour ago" : " hours ago") + trailing;
      match = core.match(/^(\d+) 天前$/);
      if (match) return leading + match[1] + (match[1] === "1" ? " day ago" : " days ago") + trailing;
      match = core.match(/^(无|低|中|高|紧急|超高)优先级$/);
      if (match) return leading + localeResources.en[match[1]] + " priority" + trailing;
      match = core.match(/^(.+) · (低|中|高|超高|最大|极致)推理$/);
      if (match) return leading + match[1] + " · " + localeResources.en[match[2]] + " reasoning" + trailing;
      match = core.match(/^确定删除任务 “(.+)” 吗？$/);
      if (match) return leading + "Delete task “" + match[1] + "”?" + trailing;
      match = core.match(/^确定删除智能体 “(.+)” 吗？$/);
      if (match) return leading + "Delete agent “" + match[1] + "”?" + trailing;
      match = core.match(/^创建后由 (.+) 立即开始工作，同时在后台生成 Issue 标题。$/);
      if (match) return leading + "After creation, " + match[1] + " will start working immediately while generating the Issue title in the background." + trailing;
      match = core.match(/^(.+) · 点击刷新重试$/);
      if (match) return leading + t(match[1]) + " · Click to retry" + trailing;
      match = core.match(/^v(.+) 已可用，升级时 Better Codex Runtime 会暂时重启，Codex 无需重启。$/);
      if (match) return leading + "v" + match[1] + " is available. Better Codex Runtime will restart briefly during the update; Codex will stay open." + trailing;
      match = core.match(/^v(.+) 已可用，升级时远程服务会暂时重启。$/);
      if (match) return leading + "v" + match[1] + " is available. The remote service will restart briefly during the update." + trailing;
      match = core.match(/^更换 (.+) 的头像$/);
      if (match) return leading + "Change " + match[1] + "'s avatar" + trailing;
      return source;
    }
    function te(value) {
      return escapeHtml2(t(value));
    }
    function mockupText(value) {
      const source = String(value ?? "");
      return source;
    }
    function projectLabel(project) {
      return project?.external_id === "inbox" ? t("未分配") : project?.name || "";
    }
    function projectsByRecentActivity(projects, issues = state.issues) {
      const issueActivity = /* @__PURE__ */ new Map();
      issues.forEach((issue) => {
        const timestamp = Date.parse(issue?.updated_at || "");
        if (!Number.isFinite(timestamp)) return;
        issueActivity.set(issue.project_id, Math.max(issueActivity.get(issue.project_id) || 0, timestamp));
      });
      const activityAt = (project) => {
        const timestamp = Date.parse(project?.updated_at || project?.created_at || "");
        const projectActivity = Number.isFinite(timestamp) ? timestamp : 0;
        return Math.max(projectActivity, issueActivity.get(project?.id) || 0);
      };
      return [...projects].sort((left, right) => {
        const difference = activityAt(right) - activityAt(left);
        if (difference) return difference;
        return projectLabel(left).localeCompare(projectLabel(right), state.locale || void 0);
      });
    }
    function normalizeSessionId(value) {
      const id = String(value || "").replace(/^(local|cloud):/i, "");
      return /^[a-f0-9-]{36}$/i.test(id) ? id : "";
    }
    function issueSessionId(issue) {
      if (REMOTE && issue?.has_conversation) return String(issue.id || "");
      return normalizeSessionId(issue?.run_thread_id) || "";
    }
    function linkedIssueThreadId(issue) {
      return issueSessionId(issue) || normalizeSessionId(issue?.thread_id) || "";
    }
    function sessionRetryElapsed(retry) {
      const startedAt = Date.parse(retry?.started_at || "");
      return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    }
    function sessionRetryDuration(retry) {
      const seconds = Math.max(1, Math.floor(sessionRetryElapsed(retry) / 1e3));
      if (seconds < 60) return state.locale === "zh-CN" ? seconds + " 秒" : seconds + "s";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return state.locale === "zh-CN" ? minutes + " 分钟" : minutes + "m";
      const hours = Math.floor(minutes / 60);
      return state.locale === "zh-CN" ? hours + " 小时 " + minutes % 60 + " 分钟" : hours + "h " + minutes % 60 + "m";
    }
    function sessionRetryReason(retry) {
      const labels = state.locale === "zh-CN" ? { network: "网络异常", stream: "响应流中断", overloaded: "服务繁忙", rate_limit: "请求受限", service: "模型服务异常" } : { network: "Network problem", stream: "Response stream interrupted", overloaded: "Service overloaded", rate_limit: "Request limited", service: "Model service problem" };
      return labels[retry?.kind] || labels.service;
    }
    function sessionRetryCardLabel(retry) {
      return state.locale === "zh-CN" ? sessionRetryReason(retry) + "，重试 " + retry.count + " 次 · " + sessionRetryDuration(retry) : sessionRetryReason(retry) + ", retry " + retry.count + " · " + sessionRetryDuration(retry);
    }
    function sessionRetryDetail(retry) {
      const longRunning = sessionRetryElapsed(retry) >= 10 * 60 * 1e3;
      if (state.locale === "zh-CN") return sessionRetryReason(retry) + "，正在重试 · 第 " + retry.count + " 次 · 已等待 " + sessionRetryDuration(retry) + (longRunning ? " · 重试持续较久" : "");
      return sessionRetryReason(retry) + ", retrying · attempt " + retry.count + " · waiting " + sessionRetryDuration(retry) + (longRunning ? " · Taking longer than expected" : "");
    }
    function issueExecutionRunning(issue) {
      return ["claimed", "running", "scheduling"].includes(issue?.active_run_status) || issue?.reply_status === "running" || ["starting", "active", "stopping", "waiting_on_approval", "waiting_on_user"].includes(issue?.session_status) || Boolean(issue?.session_active_turn_id);
    }
    function issueConversationRunning(issue) {
      const terminalIssue = ["blocked", "cancelled", "done", "in_review"].includes(issue?.status) && !issue?.active_run_status && issue?.reply_status !== "running" && !issue?.session_active_turn_id;
      return !terminalIssue && issueExecutionRunning(issue);
    }
    function issuePermissions(issue) {
      const enrichmentPending = issue?.enrichment_status === "regenerating";
      const executionRunning = issueExecutionRunning(issue);
      const remotePending = issue?.remote_pending === true || issue?.remote_state?.status === "pending";
      const remoteConflict = issue?.remote_conflict === true || issue?.remote_state?.status === "conflict";
      const executed = Boolean(issue?.run_thread_id);
      const sessionHandoff = Boolean(issue?.session_handoff_at && !issue?.session_owned);
      const executionLocked = executionRunning || executed;
      return {
        enrichmentPending,
        executionRunning,
        remotePending,
        remoteConflict,
        executed,
        sessionHandoff,
        executionLocked,
        editingLocked: enrichmentPending || executionLocked || remotePending,
        boardLocked: enrichmentPending || executionRunning || remotePending,
        contextLocked: enrichmentPending || executionRunning || remotePending,
        archiveLocked: enrichmentPending || remotePending
      };
    }
    function queuedIssuePlaceholder(commandId, body) {
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      return {
        id: body.id || "queued:" + commandId,
        identifier: "…",
        project_id: body.project_id,
        title: body.title,
        description: body.description || "",
        status: body.status || "todo",
        priority: body.priority || "none",
        labels: body.labels || [],
        workspace_path: body.workspace_path || "",
        agent_enabled: body.agent_enabled === true,
        agent_id: body.agent_id || "",
        user_assigned: body.user_assigned === true,
        assignee_user_id: body.assignee_user_id || null,
        creator_user_id: state.user.id || null,
        version: 1,
        reply_status: "idle",
        remote_state: { command_id: commandId, status: "pending", operation: "issue.create", error: null },
        created_at: timestamp,
        updated_at: timestamp
      };
    }
    async function resolveWorkspacePath(context) {
      const fromUrl = String(context?.workspacePath || "").trim();
      const threadId = normalizeSessionId(context?.threadId);
      if (fromUrl && (!threadId || currentRouteThreadId() === threadId)) return fromUrl;
      if (!threadId) return "";
      try {
        const result = await api("/api/sessions/" + encodeURIComponent(threadId) + "/workspace");
        return String(result?.workspace_path || "").trim();
      } catch {
        return "";
      }
    }
    async function ensureContextProject(context) {
      if (!context.projectId) return null;
      const source = context.projects.find((item) => item.id === context.projectId);
      const existing = state.projects.find((item) => item.external_id === context.projectId);
      const workspacePath = await resolveWorkspacePath(context);
      const project = await api("/api/projects/ensure", {
        method: "POST",
        body: JSON.stringify({
          external_id: context.projectId,
          name: source?.name || existing?.name || "Codex",
          workspace_path: workspacePath
        })
      });
      const index = state.projects.findIndex((item) => item.id === project.id || item.external_id === project.external_id);
      if (index >= 0) state.projects[index] = project;
      else state.projects.push(project);
      state.projectId = project.id;
      localStorage.setItem(PROJECT_KEY, state.projectId);
      return project;
    }
    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute(OWNED, "true");
      style.textContent = `
/* Keep native navigation and Better Codex entries in one compact column. */
[data-app-navigation-rail] {
  box-sizing: border-box !important;
  width: 52px !important;
  min-width: 52px !important;
  max-width: 52px !important;
  flex-basis: 52px !important;
}
[data-app-navigation-rail] > [data-appearance] > div:has(> [data-sidebar-destination="builtin:home"]) {
  flex-direction: column !important;
  align-items: center !important;
  gap: 8px !important;
}

        .better-codex-native-navigation { display: flex; align-items: center; width: 100%; border: 0; border-radius: var(--bc-radius-sm); background: transparent; color: inherit; text-align: start; cursor: pointer; }
        .better-codex-native-navigation:hover { background: var(--bc-color-hover); }
        .better-codex-native-navigation svg { width: var(--better-codex-native-icon-width, var(--bc-space-4)); height: var(--better-codex-native-icon-height, var(--bc-space-4)); flex-shrink: 0; }
        [data-better-codex-rail-entry="true"].better-codex-native-navigation { width: 2.5rem; height: 2.5rem; justify-content: center; padding: 0; }
        [data-better-codex-launcher-hidden="true"] { display: none !important; }
        #${ENTRY_ID}[aria-current="page"], #${AGENTS_ENTRY_ID}[aria-current="page"], #${PROJECTS_ENTRY_ID}[aria-current="page"], #${MORE_ENTRY_ID}[aria-current="page"] { background: var(--bc-color-hover); }
        html[data-better-codex-open="true"] ${SELECTORS.sidebarNavigation} [aria-current="page"]:not(#${ENTRY_ID}):not(#${AGENTS_ENTRY_ID}):not(#${PROJECTS_ENTRY_ID}):not(#${MORE_ENTRY_ID}) { background: transparent !important; }
        html[data-better-codex-open="true"] ${SELECTORS.sidebarNavigation} [aria-current="page"]:not(#${ENTRY_ID}):not(#${AGENTS_ENTRY_ID}):not(#${PROJECTS_ENTRY_ID}):not(#${MORE_ENTRY_ID}) .text-token-list-active-selection-foreground { color: var(--color-token-foreground) !important; }
        [${EXTERNAL_MCP_HIDDEN}="true"] { display: none !important; pointer-events: none !important; }
        [${HOST}="true"] { position: relative !important; z-index: 31 !important; pointer-events: none !important; }
        [${HIDDEN}="true"] { visibility: hidden !important; pointer-events: none !important; }
        [data-better-codex-inline-host="true"] { position: relative !important; isolation: isolate; }
        [data-better-codex-native-preview="true"] { display: flex !important; flex-direction: column !important; position: absolute !important; inset: 0 !important; z-index: 40 !important; visibility: visible !important; }
        [data-better-codex-native-preview="true"] > * { display: var(--bc-native-retained-display, block) !important; }
        [data-better-codex-native-preview-obscured="true"] { visibility: hidden !important; }
        [data-better-codex-inline-content="true"] { position: absolute !important; left: var(--bc-inline-nav-space, 0px) !important; right: calc(var(--bc-inline-details-space, 0px) + var(--bc-inline-native-panel-width, 0px)) !important; top: 98px !important; bottom: 0 !important; width: auto !important; max-width: none !important; height: auto !important; min-height: 0 !important; margin: 0 !important; pointer-events: auto !important; }
        [data-better-codex-inline-content="true"]:not([data-app-shell-right-panel-full-width="true"]) { overflow-x: auto !important; overflow-y: hidden !important; scrollbar-width: auto; }
        [data-better-codex-inline-content="true"]:not([data-app-shell-right-panel-full-width="true"]) > [data-app-shell-thread-edge-divider] { width: 100% !important; min-width: 360px !important; max-width: none !important; align-self: flex-start !important; box-sizing: border-box; }
        [data-better-codex-inline-content="true"]::-webkit-scrollbar { height: 12px; }
        [data-better-codex-inline-content="true"]::-webkit-scrollbar-thumb { background: var(--bc-color-hairline); border: 3px solid var(--bc-color-canvas); border-radius: 6px; }
        [data-better-codex-native-panel="true"] { position: absolute !important; top: 98px !important; right: var(--bc-inline-details-space, 0px) !important; bottom: 0 !important; width: var(--bc-inline-native-panel-width, 0px) !important; max-width: calc(100% - var(--bc-inline-nav-space, 0px) - var(--bc-inline-details-space, 0px)) !important; height: auto !important; z-index: 34 !important; }
        [data-better-codex-planning-native-hidden="true"] { display: none !important; }
        [data-better-codex-planning-native-rail="true"] { width: 52px !important; min-width: 52px !important; max-width: 52px !important; flex-basis: 52px !important; }
        [data-better-codex-planning-native-header="true"] { top: calc(var(--bc-native-header-top, 44px) + 58px) !important; left: calc(52px + var(--bc-planning-left-space, 370px)) !important; right: var(--bc-planning-details-space, 0px) !important; height: 40px !important; --app-shell-header-height: 40px; width: auto !important; background: transparent !important; pointer-events: none !important; z-index: 42 !important; }
        [data-better-codex-planning-native-header="true"] > * { pointer-events: none !important; }
        [data-better-codex-planning-native-header="true"] [data-app-shell-header-slot="end"] { margin-left: auto; pointer-events: auto; background: var(--bc-color-canvas); }
        [data-better-codex-planning-native-header="true"] button, [data-better-codex-planning-native-header="true"] a, [data-better-codex-planning-native-header="true"] input, [data-better-codex-planning-native-header="true"] [role="button"] { pointer-events: auto !important; }
        #better-codex-panel[data-better-codex-inline-shell="true"] { position: absolute !important; inset: 0 !important; display: block !important; width: auto !important; max-width: none !important; height: auto !important; padding: 0 !important; margin: 0 !important; background: transparent !important; pointer-events: none !important; overflow: visible !important; }
        #better-codex-panel[data-better-codex-inline-shell="true"] > :not(#better-codex-native-conversation) { display: none !important; }
        #better-codex-native-conversation { position: absolute; inset: 0; z-index: 32; display: block; min-width: 0; pointer-events: none; color: var(--bc-color-ink); background: transparent; }
        .better-codex-inline-heading { height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--bc-color-hairline); background: var(--bc-color-canvas); pointer-events: none; box-sizing: border-box; }
        .better-codex-inline-heading-leading { display: flex; align-items: center; gap: 6px; width: calc(var(--bc-planning-projects-width, 180px) + var(--bc-planning-conversations-width, 190px) - 24px); min-width: 0; flex-shrink: 0; pointer-events: auto; }
        .better-codex-inline-heading-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-shrink: 0; pointer-events: auto; }
        .better-codex-inline-heading button { display: inline-flex; align-items: center; flex-shrink: 0; gap: 6px; min-height: 32px; padding: 4px 10px; border: 1px solid var(--bc-color-hairline); border-radius: 7px; background: transparent; color: inherit; white-space: nowrap; cursor: pointer; }
        .better-codex-inline-heading button:hover { background: var(--bc-color-hover); }
        .better-codex-inline-heading button[aria-selected="true"] { background: var(--bc-color-hover); }
        .better-codex-inline-heading svg { width: 16px; height: 16px; flex-shrink: 0; }
        .better-codex-inline-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .better-codex-inline-tabs { display: flex; flex-shrink: 0; gap: 4px; margin-inline-start: auto; }
        [data-project-charter-confirm] { background: #2563eb !important; border-color: #2563eb !important; color: #fff !important; }
        [data-project-charter-confirm]:not(:disabled):hover { background: #1d4ed8 !important; border-color: #1d4ed8 !important; }
        [data-project-charter-confirm]:focus-visible { outline: 2px solid #60a5fa !important; outline-offset: 2px; }
        .bc-planning-stage-tabs { display: flex; align-items: center; gap: 4px; padding: 4px; border: 1px solid var(--bc-color-hairline); border-radius: 9px; background: var(--bc-color-hover); width: fit-content; max-width: 100%; margin: 12px 0 16px; }
        .bc-planning-stage-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 7px 14px; border: 0; border-radius: 6px; background: transparent; color: var(--bc-color-text-muted); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
        .bc-planning-stage-tabs button[aria-selected="true"] { background: var(--bc-color-surface-raised); color: var(--bc-color-text); box-shadow: 0 1px 3px #0002; }
        .bc-planning-stage-tabs button:focus-visible { outline: 2px solid var(--bc-color-focus); outline-offset: 2px; }
        .bc-planning-stage-tabs button:disabled { opacity: .45; cursor: default; }
        .bc-planning-stage-tabs svg { width: 15px; height: 15px; }
        .better-codex-inline-heading .bc-planning-stage-tabs { margin: 0; flex-shrink: 0; pointer-events: auto; }
        .bc-planning-projects, .bc-planning-conversations { position: absolute; top: 58px; bottom: 0; pointer-events: auto; background: var(--bc-color-canvas); border-right: 1px solid var(--bc-color-hairline); overflow: hidden; box-sizing: border-box; }
        .bc-planning-projects { left: 0; width: var(--bc-planning-projects-width, 200px); }
        .bc-planning-projects .bc-project-sidebar { display: flex; flex-direction: column; height: 100%; width: 100%; min-height: 0; }
        .bc-planning-projects .bc-project-sidebar-head, .bc-planning-conversations > header { display: flex; align-items: center; justify-content: space-between; min-height: 50px; gap: 8px; padding: 12px; border-bottom: 1px solid var(--bc-color-hairline); }
        .bc-planning-projects .bc-project-sidebar-head button { border: 0; background: transparent; color: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .bc-planning-projects .bc-project-sidebar-list, .bc-planning-conversations nav { overflow-y: auto; flex: 1; min-height: 0; padding: 8px; }
        .bc-planning-projects .bc-project-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 11px 8px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
        .bc-planning-projects .bc-project-row span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .bc-planning-projects svg, .bc-planning-conversations svg { width: 16px; height: 16px; flex-shrink: 0; }
        .bc-planning-projects .bc-project-row.is-active, .bc-planning-projects .bc-project-row:hover, .bc-planning-conversation-row.is-active, .bc-planning-conversation-row:hover { background: var(--bc-color-hover); }
        .bc-planning-conversations { left: var(--bc-planning-projects-width, 200px); width: var(--bc-planning-conversations-width, 220px); display: flex; flex-direction: column; }
        .bc-planning-conversation-create { display: flex; flex-direction: column; gap: 6px; padding: 10px 8px; border-bottom: 1px solid var(--bc-color-hairline); }
        .bc-planning-conversation-create button { display: flex; align-items: center; gap: 7px; padding: 8px; border: 1px solid var(--bc-color-hairline); border-radius: 7px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
        .bc-planning-conversation-create button:disabled, .bc-planning-conversation-row:disabled { opacity: .45; cursor: default; }
        .bc-planning-conversation-row { display: block; width: 100%; padding: 11px 8px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
        .bc-planning-conversation-row > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .bc-planning-conversation-row strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; }
        .bc-planning-conversation-row small { display: block; margin-top: 5px; color: var(--bc-color-text-muted); padding-left: 24px; font-size: 11px; }
        .bc-planning-conversation-item { display: flex; align-items: center; gap: 3px; }
        .bc-planning-conversation-item .bc-planning-conversation-row { flex: 1; min-width: 0; }
        .bc-planning-conversation-archive { flex-shrink: 0; padding: 6px; border: 0; border-radius: 5px; background: transparent; color: var(--bc-color-text-muted); font: inherit; font-size: 11px; cursor: pointer; }
        .bc-planning-conversation-archive:hover, .bc-planning-conversation-archive:focus-visible { background: var(--bc-color-hover); color: var(--bc-color-text); }
        .bc-planning-conversation-archive:disabled { opacity: .45; cursor: default; }
        .bc-work-conversation-group + .bc-work-conversation-group { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--bc-color-hairline); }
        .bc-work-conversation-group > strong { display: block; padding: 4px 8px; overflow-wrap: anywhere; font-size: 12px; }
        .bc-work-conversation-history { margin-left: 8px; width: calc(100% - 8px); }
        .better-codex-inline-work-state { display: block; margin: 8px 0 16px; color: var(--bc-color-text-muted); font-size: 12px; }
        #better-codex-native-conversation[data-planning-workspace="true"] { --bc-planning-projects-width: 180px; --bc-planning-conversations-width: 190px; }
        #better-codex-native-conversation[data-planning-workspace="true"] .better-codex-inline-details { box-shadow: none; }
        @media (max-width: 980px) { #better-codex-native-conversation[data-planning-workspace="true"] .better-codex-inline-details { z-index: 35; box-shadow: -12px 0 30px #0002; } }
        #better-codex-native-conversation[data-planning-workspace="true"] .better-codex-inline-title { max-width: 220px; }
        #better-codex-native-conversation[data-planning-workspace="true"] .better-codex-inline-status { left: calc(var(--bc-planning-projects-width) + var(--bc-planning-conversations-width)); }
        #better-codex-native-conversation[data-planning-workspace="true"] .better-codex-inline-notice { left: calc(var(--bc-planning-projects-width) + var(--bc-planning-conversations-width) + 12px); }
        .bc-planning-projects[hidden], .bc-planning-conversations[hidden] { display: none; }
        @media (max-width: 1100px) { #better-codex-native-conversation[data-planning-workspace="true"] { --bc-planning-projects-width: 152px; --bc-planning-conversations-width: 176px; } }
        .better-codex-inline-details { position: absolute; top: 58px; right: 0; bottom: 0; width: var(--bc-inline-details-width, 360px); border-left: 1px solid var(--bc-color-hairline); background: var(--bc-color-canvas); overflow: auto; overscroll-behavior: contain; pointer-events: auto; box-sizing: border-box; }
        .better-codex-inline-details[hidden], .better-codex-inline-status[hidden] { display: none; }
        .better-codex-inline-details .bc-native-planning .better-codex-project-plan-item { display: block !important; }
        #better-codex-panel .better-codex-inline-details .better-codex-project-plan-scroll { overflow: visible; overscroll-behavior: auto; }
        #better-codex-panel .better-codex-inline-details .better-codex-project-plan-item > .bc-planning-fold { color: var(--bc-color-ink); }
        #better-codex-panel .better-codex-inline-details .better-codex-project-plan-item > .bc-planning-fold > summary { color: var(--bc-color-ink); }

        .better-codex-inline-details .bc-planning-fold > summary { width: 100%; box-sizing: border-box; }
        .better-codex-inline-details .bc-planning-fold > summary > label { display: flex; align-items: center; gap: 8px; }
        .better-codex-inline-details .bc-planning-fold > summary > label input { flex: 0 0 auto; }
        .better-codex-inline-details .bc-planning-fold > summary > label strong { min-width: 0; overflow-wrap: anywhere; }
        .better-codex-inline-details .bc-planning-fold > summary > .better-codex-project-plan-status { flex: 0 0 auto; white-space: nowrap; }
        .better-codex-inline-details .better-codex-inline-details-toolbar button { display: inline-flex; width: auto; flex: 0 0 auto; white-space: nowrap; }
        .better-codex-inline-details .better-codex-project-plan-item, .better-codex-inline-details .better-codex-project-plan-item :is(details, summary, label, strong, p, li, section, .better-codex-project-plan-status) { font-size: inherit !important; line-height: inherit; }
        .better-codex-inline-resize:hover, .better-codex-inline-resize:active { background: color-mix(in srgb, var(--bc-color-accent) 25%, transparent); }
        .bc-project-work-views { display: flex; align-items: center; gap: 4px; padding: 4px; margin: 8px 0 12px; width: fit-content; border: 1px solid var(--bc-color-hairline); border-radius: 8px; pointer-events: auto; }
        .bc-project-work-views button { padding: 6px 12px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; white-space: nowrap; cursor: pointer; }
        .bc-project-work-views button[aria-current="page"] { background: var(--bc-color-control); font-weight: 600; }
        .better-codex-inline-heading-actions .bc-project-work-views { margin: 0; }
        #better-codex-panel input[data-plan-item] { appearance: auto !important; display: inline-block !important; position: static !important; width: 18px !important; height: 18px !important; min-width: 18px; flex: 0 0 18px; margin: 0 8px 0 0 !important; padding: 0 !important; opacity: 1 !important; visibility: visible !important; pointer-events: auto !important; accent-color: var(--bc-color-accent); }
        .bc-planning-fold { min-width: 0; width: 100%; }
        .bc-planning-fold > summary { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 0; cursor: pointer; list-style: none; font-weight: 600; }
        .bc-planning-fold > summary::-webkit-details-marker { display: none; }
        .bc-planning-fold > summary::before { content: "▸"; flex-shrink: 0; width: 12px; color: var(--bc-color-muted); }
        .bc-planning-fold[open] > summary::before { content: "▾"; }
        .bc-planning-fold > summary > label { flex: 1; min-width: 0; }
        .bc-planning-fold-body { padding: 4px 0 12px; }
        .better-codex-inline-details-toolbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; padding: 6px 12px; border-bottom: 1px solid var(--bc-color-hairline); background: var(--bc-color-canvas); box-sizing: border-box; }
        .better-codex-inline-details-toolbar button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 30px; padding: 4px 8px; border: 1px solid var(--bc-color-hairline); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
        .better-codex-inline-details-toolbar svg { width: 16px; height: 16px; }
        .better-codex-inline-details .better-codex-project-document-panel { min-width: 0; height: auto; padding: 16px; display: block; }
        .better-codex-inline-details .better-codex-project-plan { min-width: 0; height: auto; display: block; }
        .better-codex-inline-details .better-codex-project-plan-scroll { overflow: visible; max-height: none; }
        .better-codex-inline-details article, .better-codex-inline-details p { overflow-wrap: anywhere; }
        .better-codex-inline-details-body { padding: 16px; }
        .better-codex-inline-resize { position: absolute; top: 58px; bottom: 0; right: var(--bc-inline-details-width, 360px); width: 12px; margin-right: -6px; cursor: col-resize; pointer-events: auto; touch-action: none; z-index: 4; }
        .better-codex-inline-resize:focus-visible { outline: 2px solid var(--bc-color-accent); outline-offset: -2px; }
        .bc-conversations-resize { position: absolute; top: 58px; bottom: 0; left: calc(var(--bc-planning-projects-width) + var(--bc-planning-conversations-width) - 6px); width: 12px; cursor: col-resize; pointer-events: auto; touch-action: none; z-index: 4; }
        .bc-conversations-resize:hover, .bc-conversations-resize:active { background: color-mix(in srgb, var(--bc-color-accent) 25%, transparent); }
        .bc-conversations-resize:focus-visible { outline: 2px solid var(--bc-color-accent); outline-offset: -2px; }
        .better-codex-inline-status { position: absolute; left: 0; right: var(--bc-inline-details-space, 0px); top: 58px; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 28px; background: var(--bc-color-canvas); pointer-events: auto; overflow: auto; }
        .better-codex-inline-status p { max-width: 520px; white-space: pre-wrap; }
        .better-codex-inline-status button { border: 1px solid var(--bc-color-hairline); border-radius: 7px; padding: 8px 16px; color: inherit; background: var(--bc-color-control); cursor: pointer; }
        .better-codex-inline-notice { position: absolute; top: 66px; left: 16px; max-width: min(520px, calc(100% - 32px)); padding: 10px 14px; border: 1px solid var(--bc-color-hairline); border-radius: 8px; background: var(--bc-color-raised); color: inherit; pointer-events: auto; z-index: 3; }
        .better-codex-inline-notice[hidden] { display: none; }
        .better-codex-inline-history { align-self: stretch; width: 100%; max-width: 760px; margin: 0 auto; }
        .better-codex-inline-history article { padding: 12px 0; border-top: 1px solid var(--bc-color-hairline); }
        .better-codex-inline-history p { max-width: none; overflow-wrap: anywhere; }
        @media (max-width: 980px) { .better-codex-inline-heading { gap: 6px; padding-inline: 8px; } .better-codex-inline-title { max-width: 28vw; } .better-codex-inline-heading button { padding-inline: 7px; } #better-codex-native-conversation:not([data-planning-workspace="true"]) .better-codex-inline-details { box-shadow: -12px 0 30px #0002; width: min(var(--bc-inline-details-width, 360px), 90%); } .better-codex-inline-resize { display: none; } }
        ${config.designSystemCss}
      `;
      (document.head || document.documentElement).appendChild(style);
    }
    function findReferenceButton() {
      const scroll = document.querySelector(SELECTORS.sidebarScroll);
      if (!scroll) return null;
      const buttons = Array.from(scroll.querySelectorAll("button")).filter((button2) => !button2.hasAttribute(OWNED));
      const plugin = buttons.find((button2) => ["插件", "plugins"].includes(label(button2.textContent || button2.getAttribute("aria-label"))));
      if (plugin) return plugin;
      return buttons.find((button2) => button2.closest(SELECTORS.sidebarSection)) || buttons[0] || null;
    }
    function navigationRail() {
      return document.querySelector("[data-app-navigation-rail]");
    }
    function nativeLauncher(button2) {
      if (!(button2 instanceof Element) || button2.hasAttribute(OWNED)) return false;
      const destination = button2.getAttribute("data-sidebar-destination") || "";
      const name = label(button2.querySelector(".sr-only")?.textContent || button2.getAttribute("aria-label") || button2.textContent);
      return destination.includes("better-codex") || button2.getAttribute("href") === BETTER_CODEX_ROUTE || name === "better codex";
    }
    function railReferenceButton() {
      const rail = navigationRail();
      if (!rail) return null;
      const buttons = Array.from(rail.querySelectorAll("button")).filter((button2) => !button2.hasAttribute(OWNED) && !nativeLauncher(button2));
      return buttons.find((button2) => button2.hasAttribute("data-sidebar-destination")) || null;
    }
    function syncRailButton(button2) {
      button2.setAttribute("data-better-codex-rail-entry", "true");
      const reference = railReferenceButton();
      if (reference) {
        if (button2.className !== reference.className) button2.className = reference.className;
        for (const name of ["data-color", "data-variant", "data-squircle", "data-uniform", "data-size", "data-icon-size"]) {
          const value = reference.getAttribute(name);
          if (value === null) button2.removeAttribute(name);
          else if (button2.getAttribute(name) !== value) button2.setAttribute(name, value);
        }
      } else if (!button2.classList.contains("better-codex-native-navigation")) {
        button2.classList.add("better-codex-native-navigation");
      }
      let inner = button2.querySelector(":scope > span");
      const referenceInner = reference?.querySelector(":scope > span");
      if (!(inner instanceof HTMLElement)) {
        inner = document.createElement("span");
        const svg = button2.querySelector("svg");
        if (svg) inner.append(svg);
        button2.append(inner);
      }
      if (referenceInner instanceof HTMLElement && inner.className !== referenceInner.className) inner.className = referenceInner.className;
      if (!inner.querySelector("svg")) inner.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>');
      if (!inner.querySelector(".sr-only")) {
        const accessible = document.createElement("span");
        accessible.className = "sr-only";
        inner.append(accessible);
      }
      inner.querySelectorAll(".text-fade-truncate").forEach((node) => node.remove());
    }
    function railButton(text) {
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.innerHTML = '<span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg><span class="sr-only"></span></span>';
      const accessible = button2.querySelector(".sr-only");
      if (accessible) accessible.textContent = text;
      syncRailButton(button2);
      return button2;
    }
    function placeRailSequence(nodes, parent, anchor) {
      // Keep an already-mounted group in place when there is no native launcher
      // after it. Re-appending it on every refresh triggers the observer again.
      let cursor = anchor || (nodes.at(-1)?.parentElement === parent ? nodes.at(-1).nextSibling : null);
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node.parentElement !== parent || node.nextSibling !== cursor) parent.insertBefore(node, cursor);
        cursor = node;
      }
    }
    function syncNativeIconSize(button2, reference) {
      if (HOST_KIND === "web" || !reference) return;
      const referenceIcon = reference.querySelector("svg");
      if (!(referenceIcon instanceof SVGElement)) return;
      const style = getComputedStyle(referenceIcon);
      const width = Number.parseFloat(style.width) > 0 ? style.width : "";
      const height = Number.parseFloat(style.height) > 0 ? style.height : "";
      if (width) button2.style.setProperty("--better-codex-native-icon-width", width);
      if (height) button2.style.setProperty("--better-codex-native-icon-height", height);
    }
    function nativeButton(text) {
      const reference = findReferenceButton();
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.className = HOST_KIND === "web" ? "web-nav-button" : "better-codex-native-navigation";
      button2.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg><span class="text-fade-truncate"></span>';
      button2.querySelector("span").textContent = text;
      if (reference && HOST_KIND !== "web") {
        const style = getComputedStyle(reference);
        button2.style.height = style.height;
        button2.style.padding = style.padding;
        button2.style.font = style.font;
        button2.style.gap = style.gap;
        syncNativeIconSize(button2, reference);
      }
      return button2;
    }
    function actionButton(text) {
      const handle = createButton({ label: t(text), variant: "ghost" }, componentContext("global-toolbar", "action-button:" + ++managedButtonSequence));
      handle.element.classList.add("better-codex-button");
      managedButtons.add(handle);
      return handle.element;
    }
    function hydrateIconButtons(root, feature) {
      if (!root) return;
      const candidates = root instanceof HTMLButtonElement && root.matches("button[aria-label]") ? [root, ...root.querySelectorAll("button[aria-label]")] : [...root.querySelectorAll("button[aria-label]")];
      candidates.forEach((button2) => {
        if (!(button2 instanceof HTMLButtonElement) || button2.dataset.bcComponent) return;
        if (button2.children.length !== 1 || button2.firstElementChild?.tagName.toLowerCase() !== "svg") return;
        const accessibleName = button2.getAttribute("aria-label")?.trim();
        if (!accessibleName) return;
        const handle = adoptIconButton(button2, {
          accessibleName,
          disabled: button2.disabled,
          label: accessibleName,
          variant: button2.classList.contains("is-danger") ? "danger" : "ghost"
        }, componentContext(feature, "adopted-icon-button:" + ++adoptedIconButtonSequence));
        registerOwnedComponent(button2, handle);
      });
    }
    function hydrateActionButtons(root, feature) {
      if (!root) return;
      const selector = [
        ".better-codex-submit",
        ".better-codex-update-button",
        ".better-codex-confirm-actions > button",
        ".better-codex-error-report-actions > button",
        ".better-codex-error-report-navigation > button",
        ".better-codex-recovery-command > button",
        ".better-codex-recovery-retry",
        "dialog footer > button:not([aria-label])"
      ].join(",");
      root.querySelectorAll(selector).forEach((button2) => {
        if (!(button2 instanceof HTMLButtonElement) || button2.dataset.bcComponent) return;
        const label2 = button2.textContent?.trim() || button2.getAttribute("aria-label")?.trim();
        if (!label2) return;
        const primary = button2.classList.contains("is-primary") || button2.classList.contains("better-codex-submit") || button2.classList.contains("better-codex-confirm-primary");
        const danger = button2.classList.contains("is-danger") || button2.matches("[data-agent-delete], [data-confirm-danger]");
        const handle = adoptButton(button2, {
          disabled: button2.disabled,
          label: label2,
          variant: danger ? "danger" : primary ? "primary" : "secondary"
        }, componentContext(feature, "adopted-button:" + ++adoptedButtonSequence));
        registerOwnedComponent(button2, handle);
      });
    }
    function hydrateSharedControls(root, feature) {
      hydrateIconButtons(root, feature);
      hydrateActionButtons(root, feature);
      root.querySelectorAll(".better-codex-remote-status-badge, .better-codex-completion-status").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.dataset.bcComponent) return;
        const stateValue = element.dataset.state || element.closest("[data-remote-status]")?.getAttribute("data-remote-status") || "";
        const variant = ["running", "enabled", "online", "completed"].includes(stateValue) ? "success" : ["offline", "failed", "blocked"].includes(stateValue) ? "danger" : "neutral";
        const handle = adoptStatusBadge(element, { label: element.textContent?.trim() || "", variant }, componentContext(feature, "adopted-status-badge:" + ++adoptedBadgeSequence));
        registerOwnedComponent(element, handle);
      });
      root.querySelectorAll(".better-codex-column-title > span:last-child, .better-codex-archive-project-count").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.dataset.bcComponent) return;
        const handle = adoptBadge(element, { label: element.textContent?.trim() || "" }, componentContext(feature, "adopted-count-badge:" + ++adoptedBadgeSequence));
        registerOwnedComponent(element, handle);
      });
      root.querySelectorAll(".better-codex-dialog-error, .better-codex-agent-inspector-error, .better-codex-update-error, .better-codex-help-error, .better-codex-composer-queue-error, .better-codex-project-document-notice.is-error").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.dataset.bcComponent) return;
        const handle = adoptInlineFeedback(element, { message: element.textContent?.trim() || "", tone: "error" }, componentContext(feature, "adopted-inline-feedback:" + ++adoptedFeedbackSequence));
        registerOwnedComponent(element, handle);
      });
      root.querySelectorAll(".better-codex-help-setting-row").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.dataset.bcComponent) return;
        const handle = adoptFieldShell(element, componentContext(feature, "adopted-field-shell:" + ++adoptedPatternSequence));
        registerOwnedComponent(element, handle);
      });
      root.querySelectorAll(".better-codex-toolbar").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.dataset.bcComponent) return;
        const handle = adoptToolbar(element, componentContext(feature, "adopted-toolbar:" + ++adoptedPatternSequence));
        registerOwnedComponent(element, handle);
      });
      root.querySelectorAll(".better-codex-project-document-form > label").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.dataset.bcComponent) return;
        const handle = adoptFormRow(element, componentContext(feature, "adopted-form-row:" + ++adoptedPatternSequence));
        registerOwnedComponent(element, handle);
      });
    }
    function hydrateAddedIconButtons(records) {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const scope = node.matches('#better-codex-panel, [id^="better-codex"], [class*="better-codex"]') ? node : node.querySelector('#better-codex-panel, [id^="better-codex"], [class*="better-codex"]');
        if (!scope) return;
        hydrateSharedControls(scope, scope.closest("#better-codex-panel")?.dataset.surface || "global-overlay");
      }));
    }
    function createEntry(text, id, title, surface) {
      const button2 = HOST_KIND === "web" ? nativeButton(t(text)) : railButton(t(text));
      button2.id = id;
      button2.setAttribute(OWNED, "true");
      button2.setAttribute("aria-label", t(title));
      button2.setAttribute("title", t(title));
      syncEntryIcon(button2, surface);
      button2.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAuxiliaryMenu();
        openRoute(surface);
      });
      return button2;
    }
    function closeAuxiliaryMenu() {
      if (moreEntry) moreEntry.setAttribute("aria-expanded", "false");
      if (auxiliaryMenu) auxiliaryMenu.removeAttribute("data-open");
      if (auxiliaryMenuDismiss) document.removeEventListener("pointerdown", auxiliaryMenuDismiss, true);
      auxiliaryMenuDismiss = null;
    }
    function syncAuxiliaryMenuOrder() {
      if (!auxiliaryMenu) return;
      const items = [projectsEntry, usageEntry, themeEntry, profileEntry].filter(
        (item) => Boolean(item)
      );
      for (const [index, item] of items.entries()) {
        if (auxiliaryMenu.children[index] !== item) {
          auxiliaryMenu.insertBefore(item, auxiliaryMenu.children[index] ?? null);
        }
      }
    }
    function createAuxiliaryNavigation() {
      const navigation = document.createElement("div");
      navigation.className = "web-nav-auxiliary";
      navigation.setAttribute(OWNED, "true");
      moreEntry = nativeButton(t("更多"));
      moreEntry.id = MORE_ENTRY_ID;
      moreEntry.classList.add("web-nav-more-entry");
      moreEntry.setAttribute(OWNED, "true");
      moreEntry.setAttribute("aria-label", t("更多功能"));
      moreEntry.setAttribute("title", t("更多功能"));
      moreEntry.setAttribute("aria-haspopup", "menu");
      moreEntry.setAttribute("aria-expanded", "false");
      moreEntry.setAttribute("aria-controls", "better-codex-more-menu");
      syncEntryIcon(moreEntry, "more");
      auxiliaryMenu = document.createElement("div");
      auxiliaryMenu.id = "better-codex-more-menu";
      auxiliaryMenu.className = "web-nav-more-menu";
      auxiliaryMenu.setAttribute(OWNED, "true");
      auxiliaryMenu.setAttribute("aria-label", t("更多功能"));
      if (REMOTE) {
        profileEntry = nativeButton("");
        profileEntry.id = "better-codex-profile-entry";
        profileEntry.classList.add("web-nav-mobile-action", "web-nav-profile-entry");
        profileEntry.setAttribute(OWNED, "true");
        profileEntry.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeAuxiliaryMenu();
          showUserProfileDialog();
        });
      }
      usageEntry = nativeButton(t("Codex 额度"));
      usageEntry.id = "better-codex-usage-entry";
      usageEntry.classList.add("web-nav-mobile-action");
      usageEntry.setAttribute(OWNED, "true");
      usageEntry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAuxiliaryMenu();
        document.getElementById("web-usage-toggle")?.click();
      });
      themeEntry = nativeButton("");
      themeEntry.id = "better-codex-theme-entry";
      themeEntry.classList.add("web-nav-mobile-action");
      themeEntry.setAttribute(OWNED, "true");
      themeEntry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeAuxiliaryMenu();
        document.getElementById("web-theme")?.click();
      });
      moreEntry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const opening = moreEntry.getAttribute("aria-expanded") !== "true";
        closeAuxiliaryMenu();
        if (!opening) return;
        moreEntry.setAttribute("aria-expanded", "true");
        auxiliaryMenu.setAttribute("data-open", "true");
        auxiliaryMenuDismiss = (pointerEvent) => {
          if (!navigation.contains(pointerEvent.target)) closeAuxiliaryMenu();
        };
        setTimeout(() => document.addEventListener("pointerdown", auxiliaryMenuDismiss, true), 0);
      });
      syncAuxiliaryMenuOrder();
      navigation.append(moreEntry, auxiliaryMenu);
      return navigation;
    }
    function syncEntryIcon(button2, surface) {
      const svg = button2.querySelector("svg");
      if (svg) {
        const iconKey = { agents: "sparkles", projects: "folder", more: "more", usage: "usage", moon: "moon", sun: "sun" }[surface] || "issues";
        const definition = LUCIDE_ICONS[iconKey];
        if (svg.getAttribute("viewBox") !== "0 0 24 24") svg.setAttribute("viewBox", "0 0 24 24");
        if (svg.getAttribute("fill") !== "none") svg.setAttribute("fill", "none");
        if (svg.getAttribute("stroke") !== "currentColor") svg.setAttribute("stroke", "currentColor");
        if (svg.getAttribute("stroke-width") !== "1.8") svg.setAttribute("stroke-width", "1.8");
        if (svg.getAttribute("stroke-linecap") !== "round") svg.setAttribute("stroke-linecap", "round");
        if (svg.getAttribute("stroke-linejoin") !== "round") svg.setAttribute("stroke-linejoin", "round");
        if (svg.getAttribute("class") !== "lucide lucide-" + definition.name) svg.setAttribute("class", "lucide lucide-" + definition.name);
        if (svg.innerHTML !== definition.nodes) svg.innerHTML = definition.nodes;
        if (button2.hasAttribute("data-better-codex-rail-entry")) {
          if (svg.getAttribute("width") !== "20") svg.setAttribute("width", "20");
          if (svg.getAttribute("height") !== "20") svg.setAttribute("height", "20");
        }
      }
    }
    function syncEntryLabel(button2, text, title) {
      text = t(text);
      title = t(title);
      const content = button2.querySelector(".sr-only") || button2.querySelector(SELECTORS.truncatedText) || Array.from(button2.querySelectorAll("span")).at(-1);
      if (content && content.textContent !== text) content.textContent = text;
      else if (!content && button2.textContent !== text) button2.textContent = text;
      if (button2.getAttribute("aria-label") !== title) button2.setAttribute("aria-label", title);
      if (button2.getAttribute("title") !== title) button2.setAttribute("title", title);
    }
    function syncMobileActions() {
      if (!usageEntry || !themeEntry) return;
      if (profileEntry) {
        const user = state.user || {};
        profileEntry.innerHTML = userAvatarMarkup(user, "web-nav-profile-avatar") + '<span class="web-nav-profile-meta"><strong>' + escapeHtml2(user.name || t("你")) + "</strong><small>" + te("编辑个人资料") + "</small></span>" + icon("chevron");
        profileEntry.setAttribute("aria-label", t("编辑个人资料"));
        profileEntry.setAttribute("title", t("编辑个人资料"));
      }
      syncEntryLabel(usageEntry, "Codex 额度", "查看 Codex 额度");
      syncEntryIcon(usageEntry, "usage");
      const light = document.documentElement.dataset.theme === "dark";
      const label2 = light ? "切换为浅色主题" : "切换为深色主题";
      syncEntryLabel(themeEntry, label2, label2);
      syncEntryIcon(themeEntry, light ? "sun" : "moon");
    }
    function syncEntrySelection() {
      const currentEntry = active && state.surface === "issues" ? entry : active && state.surface === "agents" ? agentsEntry : active && state.surface === "projects" ? projectsEntry : null;
      for (const item of [entry, agentsEntry, projectsEntry].filter(Boolean)) {
        const selected = item === currentEntry;
        if (selected && item.getAttribute("aria-current") !== "page") item.setAttribute("aria-current", "page");
        if (!selected && item.hasAttribute("aria-current")) item.removeAttribute("aria-current");
        if (!item.hasAttribute("data-better-codex-rail-entry")) continue;
        if (selected && !item.hasAttribute("data-selected")) item.setAttribute("data-selected", "");
        if (!selected && item.hasAttribute("data-selected")) item.removeAttribute("data-selected");
        if (selected && item.hasAttribute("data-suppress-active-style")) item.removeAttribute("data-suppress-active-style");
        if (!selected && !item.hasAttribute("data-suppress-active-style")) item.setAttribute("data-suppress-active-style", "");
      }
      if (moreEntry) {
        if (active && state.surface === "projects" && moreEntry.getAttribute("aria-current") !== "page") moreEntry.setAttribute("aria-current", "page");
        if ((!active || state.surface !== "projects") && moreEntry.hasAttribute("aria-current")) moreEntry.removeAttribute("aria-current");
      }
    }
    function hideNativeLaunchers(mounted) {
      const roots = [document.querySelector(SELECTORS.sidebarScroll), navigationRail()].filter(Boolean);
      const hidden = mounted && bootstrapReady ? "true" : "false";
      for (const root of roots) {
        root.querySelectorAll("button, a").forEach((button2) => {
          if (!nativeLauncher(button2)) return;
          if (button2.getAttribute("data-better-codex-launcher-hidden") !== hidden) {
            button2.setAttribute("data-better-codex-launcher-hidden", hidden);
            console.info("[better-codex] launcher_visibility", { hidden: hidden === "true", mounted, bootstrapReady });
          }
        });
      }
    }
    async function lookupNativeProjectBinding(threadId) {
      if (!threadId || !state.nativePlanningEnabled) return null;
      if (state.nativeUnboundThreads?.[threadId]) return null;
      const cached = state.nativeThreadLinks?.[threadId];
      if (cached) return cached;
      try {
        const binding = await api("/api/projects/from-thread?thread_id=" + encodeURIComponent(threadId));
        if (state.nativeUnboundThreads?.[threadId]) return null;
        if (!binding?.project_id) return null;
        state.nativeThreadLinks ||= {};
        state.nativeThreadLinks[threadId] = { thread_id: threadId, project_id: binding.project_id, kind: binding.kind, ...(binding.conversation_id ? { conversation_id: binding.conversation_id } : {}) };
        return state.nativeThreadLinks[threadId];
      } catch (error) {
        const value = error instanceof Error ? error.message : String(error);
        if (["project_session_not_found", "session_not_found", "project_not_found", "route_not_found", "not_found"].includes(value)) return null;
        throw error;
      }
    }
    function syncNativeReturnEntry(parent) {
      let saved;
      try { saved = JSON.parse(sessionStorage.getItem("better-codex-native-return") || "null"); } catch { saved = null; }
      const threadId = currentRouteThreadId() || activeThreadId();
      const issue = state.issues.find((item) => issueSessionId(item) === threadId);
      const context = state.nativeUnboundThreads?.[threadId] ? null : issue ? { thread_id: threadId, issue_id: issue.id, project_id: issue.project_id } : state.nativeThreadLinks?.[threadId] || (saved?.thread_id === threadId ? saved : null);
      if (!context && threadId && state.nativePlanningEnabled && state.nativeReturnLookupThread !== threadId) {
        state.nativeReturnLookupThread = threadId;
        void lookupNativeProjectBinding(threadId).then((binding) => { if (binding && !destroyed) ensureEntry(); }).catch((error) => appendDiagnostic("native_return_lookup_failed", { error: String(error) }));
      }
      if (!nativeReturnEntry) {
        nativeReturnEntry = railButton(t("返回项目"));
        nativeReturnEntry.id = "better-codex-native-return";
        nativeReturnEntry.setAttribute(OWNED, "true");
        nativeReturnEntry.addEventListener("click", (event) => {
          event.preventDefault(); event.stopPropagation();
          const target = nativeReturnEntry.__betterCodexReturn;
          if (!target) return;
          if (target.issue_id) {
            openRoute("issues");
            void perform(async () => openEditor(state.issues.find((item) => item.id === target.issue_id) || await api("/api/issues/" + encodeURIComponent(target.issue_id))));
          } else {
            openRoute("projects", { projectId: target.project_id });
            state.projectPage = "planning";
            renderProjects();
          }
        });
      }
      syncRailButton(nativeReturnEntry);
      nativeReturnEntry.__betterCodexReturn = context;
      syncEntryLabel(nativeReturnEntry, context?.issue_id ? "返回任务详情" : "返回项目规划", context?.issue_id ? "返回任务详情" : "返回项目规划");
      syncEntryIcon(nativeReturnEntry, context?.issue_id ? "issues" : "projects");
      nativeReturnEntry.hidden = active || !context;
      if (nativeReturnEntry.parentElement !== parent || nativeReturnEntry.previousElementSibling !== projectsEntry) projectsEntry.after(nativeReturnEntry);
    }
    let titlebarUsageTimer = null;
    let titlebarUsagePending = false;
    function ensureTitlebarActions() {
      if (HOST_KIND === "web") return;
      const help = document.getElementById("application-menu-trigger-help-menu");
      if (!help) return;
      let group = document.getElementById("better-codex-titlebar-actions");
      if (!group) {
        group = document.createElement("div");
        group.id = "better-codex-titlebar-actions";
        group.setAttribute(OWNED, "true");
        group.className = "no-drag";
        group.style.cssText = "display:flex;align-items:center;gap:8px;white-space:nowrap;-webkit-app-region:no-drag";
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = help.className;
        archive.textContent = t("已归档聊天");
        archive.addEventListener("click", () => {
          close();
          window.postMessage({ type: NAVIGATION.messageType, path: "/archive" }, window.location.origin);
        });
        const usage = document.createElement("button");
        usage.type = "button";
        usage.className = help.className;
        usage.dataset.titlebarUsage = "true";
        usage.textContent = t("用量加载中…");
        usage.addEventListener("click", () => void refreshTitlebarUsage());
        group.append(archive, usage);
        void refreshTitlebarUsage(group);
        if (titlebarUsageTimer === null) titlebarUsageTimer = setInterval(() => void refreshTitlebarUsage(), 60000);
      }
      if (help.nextElementSibling !== group) help.after(group);
    }
    async function refreshTitlebarUsage(root = document.getElementById("better-codex-titlebar-actions")) {
      if (titlebarUsagePending || destroyed || !root) return;
      titlebarUsagePending = true;
      const output = root.querySelector("[data-titlebar-usage]");
      try {
        const result = await api("/api/account/usage", { passive: true });
        const windows = [result.usage?.primary, result.usage?.secondary].filter(Boolean);
        const labels = windows.map(item => {
          const mins = item.windowDurationMins;
          const period = mins === 10080 ? t("每周") : mins % 1440 === 0 ? mins / 1440 + t("天") : mins % 60 === 0 ? mins / 60 + t("小时") : mins + t("分钟");
          return period + " " + Math.max(0, Math.min(100, item.remainingPercent)) + "%";
        });
        output.textContent = labels.length ? t("剩余") + "：" + labels.join(" · ") : t("用量暂不可用");
        output.title = windows.map(item => t("重置时间") + "：" + new Date(item.resetsAt * 1000).toLocaleString()).join("\n") || t("点击刷新用量");
      } catch {
        output.textContent = t("用量暂不可用");
        output.title = t("点击刷新用量");
      } finally { titlebarUsagePending = false; }
    }
    function ensureDesktopEntries() {
      ensureTitlebarActions();
      const rail = navigationRail();
      const launcher = rail ? Array.from(rail.querySelectorAll("button")).find(nativeLauncher) : null;
      const reference = railReferenceButton();
      const parent = launcher?.parentElement || reference?.parentElement;
      if (!parent) return false;
      if (!entry) entry = createEntry("任务看板", ENTRY_ID, "打开任务看板", "issues");
      syncRailButton(entry);
      syncEntryLabel(entry, "任务看板", "打开任务看板");
      syncEntryIcon(entry, "issues");
      if (!agentsEntry) agentsEntry = createEntry("Skill 管理", AGENTS_ENTRY_ID, "管理 Skill", "agents");
      syncRailButton(agentsEntry);
      syncEntryLabel(agentsEntry, "Skill 管理", "管理 Skill");
      syncEntryIcon(agentsEntry, "agents");
      if (!projectsEntry) projectsEntry = createEntry("项目管理", PROJECTS_ENTRY_ID, "管理项目", "projects");
      syncRailButton(projectsEntry);
      syncEntryLabel(projectsEntry, "项目管理", "管理项目");
      syncEntryIcon(projectsEntry, "projects");
      projectsEntry.hidden = !hasFeature("project-management");
      const anchor = launcher && launcher.parentElement === parent ? launcher : null;
      placeRailSequence([entry, agentsEntry, projectsEntry], parent, anchor);
      syncNativeReturnEntry(parent);
      syncEntrySelection();
      const mounted = entry.isConnected && agentsEntry.isConnected && projectsEntry.isConnected;
      hideNativeLaunchers(mounted);
      return mounted;
    }
    function ensureEntry() {
      if (destroyed) return false;
      installStyle();
      if (HOST_KIND !== "web") return ensureDesktopEntries();
      const reference = findReferenceButton();
      const parent = reference?.parentElement || (HOST_KIND === "web" ? document.querySelector(SELECTORS.sidebarSection) : null);
      if (!parent) return false;
      if (!entry) entry = createEntry("任务看板", ENTRY_ID, "打开任务看板", "issues");
      syncEntryLabel(entry, "任务看板", "打开任务看板");
      syncEntryIcon(entry, "issues");
      if (reference) {
        if (entry.parentElement !== parent || entry.previousElementSibling !== reference) reference.after(entry);
      } else if (entry.parentElement !== parent || entry !== parent.firstElementChild) {
        parent.prepend(entry);
      }
      if (!agentsEntry) agentsEntry = createEntry("Skill 管理", AGENTS_ENTRY_ID, "管理 Skill", "agents");
      syncEntryLabel(agentsEntry, "Skill 管理", "管理 Skill");
      syncEntryIcon(agentsEntry, "agents");
      if (agentsEntry.parentElement !== parent || agentsEntry.previousElementSibling !== entry) entry.after(agentsEntry);
      if (!projectsEntry) projectsEntry = createEntry("项目管理", PROJECTS_ENTRY_ID, "管理项目", "projects");
      syncEntryLabel(projectsEntry, "项目管理", "管理项目");
      syncEntryIcon(projectsEntry, "projects");
      projectsEntry.hidden = !hasFeature("project-management");
      if (HOST_KIND === "web") {
        if (!auxiliaryNavigation) auxiliaryNavigation = createAuxiliaryNavigation();
        syncEntryLabel(moreEntry, "更多", "更多功能");
        syncEntryIcon(moreEntry, "more");
        syncMobileActions();
        auxiliaryNavigation.hidden = false;
        if (auxiliaryNavigation.parentElement !== parent || auxiliaryNavigation.previousElementSibling !== agentsEntry) agentsEntry.after(auxiliaryNavigation);
        syncAuxiliaryMenuOrder();
      }
      syncEntrySelection();
      const mounted = entry.isConnected && agentsEntry.isConnected && projectsEntry.isConnected && (HOST_KIND !== "web" || auxiliaryNavigation?.isConnected);
      return mounted;
    }
    function findMount() {
      if (HOST_KIND === "web") return document.querySelector("[data-better-codex-web-surface]");
      if (inlineConversation) {
        const page = document.querySelector('[data-app-shell-active-page="true"]');
        const layout = page?.querySelector(SELECTORS.contentLayout);
        const surface = layout?.parentElement;
        if (surface?.closest("main") && !surface.closest('[' + OWNED + '="true"]') && inlineNativeElementVisible(surface)) return surface;
      }
      return findInjectedMount(SELECTORS, OWNED, inlineConversation ? inlineNativeElementVisible : injectedElementVisible);
    }
    function activeThreadRow() {
      const rows = Array.from(document.querySelectorAll(SELECTORS.threadRow));
      return rows.find((row) => row.getAttribute(ATTRIBUTES.threadActive) === "true") || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current"))) || null;
    }
    function readContext(row = activeThreadRow()) {
      const projectList = row?.closest(SELECTORS.projectList);
      const projectRow = row?.closest(SELECTORS.projectId) || document.querySelector(SELECTORS.currentProjectRow);
      const projects = Array.from(document.querySelectorAll(SELECTORS.projectRow)).flatMap((item) => {
        const id = item.getAttribute(ATTRIBUTES.projectId)?.trim();
        const name = (item.getAttribute(ATTRIBUTES.projectLabel) || item.getAttribute("aria-label") || "").trim();
        return id && name ? [{ id, name }] : [];
      });
      const url = new URL(location.href);
      return {
        projectId: projectList?.getAttribute(ATTRIBUTES.projectListId) || projectRow?.getAttribute(ATTRIBUTES.projectId) || "",
        threadId: row ? nativeThreadId(row) : location.pathname.match(/\/local\/([^/?#]+)/)?.[1] || "",
        workspacePath: url.searchParams.get("workspace") || url.searchParams.get("cwd") || "",
        projects
      };
    }
    function transientRuntimeTransportError(error) {
      const message = error instanceof Error ? error.message : String(error || "");
      return ["runtime_offline", "runtime_unavailable", "runtime_reconciling", "update_in_progress", "update_commit_pending", "runtime_bridge_timeout", "runtime_bridge_unavailable", "injection_destroyed"].includes(message) || message === "runtime_fetch_failed" || message.startsWith("runtime_fetch_failed:");
    }
    function transientNetworkError(error) {
      const message = error instanceof Error ? error.message : String(error || "");
      const failureType = String(error?.betterCodexDiagnostics?.failure_type || "");
      return transientRuntimeTransportError(error) || failureType === "network_transport" || ["browser_transport_failed", "Failed to fetch", "NetworkError when attempting to fetch resource."].includes(message);
    }
    function contentConflict(error) {
      const value = error instanceof Error ? error.message : String(error || "");
      return value === "version_conflict" || value === "queued_reply_update_conflict";
    }
    function contentConflictCorrelation(error) {
      const diagnostics = error?.betterCodexDiagnostics || {};
      return compactFields({
        trace_id: diagnostics.trace_id,
        command_id: diagnostics.command_id,
        request_id: diagnostics.response_request_id || diagnostics.request_id,
        method: diagnostics.method,
        path: diagnostics.path,
        http_status: diagnostics.http_status
      });
    }
    async function loadLatestIssue(issueId) {
      const latest = await api("/api/issues/" + encodeURIComponent(issueId));
      const dialog = document.getElementById("better-codex-dialog");
      if (dialog?.dataset.issueId === issueId && typeof dialog.__betterCodexSyncIssue === "function") dialog.__betterCodexSyncIssue(latest);
      else {
        const index = state.issues.findIndex((issue) => issue.id === issueId);
        if (index >= 0) state.issues[index] = { ...state.issues[index], ...latest };
        else state.issues.push(latest);
      }
      if (active) render();
      return state.issues.find((issue) => issue.id === issueId) || latest;
    }
    async function withLatestIssueOnConflict(issueId, action) {
      let current = state.issues.find((issue) => issue.id === issueId) || await loadLatestIssue(issueId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await action(current);
        } catch (error) {
          if (attempt === 1 || !contentConflict(error)) throw error;
          appendDiagnostic("content_conflict_retry", { issue_id: issueId, previous_version: current.version });
          current = await loadLatestIssue(issueId);
        }
      }
      throw new Error("version_conflict");
    }
    async function reconcileSurfaceConflict(error) {
      if (!contentConflict(error)) return { error, reconciled: false };
      const correlation = contentConflictCorrelation(error);
      appendDiagnostic("content_conflict_sync_started", { surface: state.surface, ...correlation });
      try {
        await loadSurface({ background: true });
        appendDiagnostic("content_conflict_sync_completed", { surface: state.surface, ...correlation });
        return { error, reconciled: true };
      } catch (syncError) {
        appendDiagnostic("content_conflict_sync_failed", { surface: state.surface, ...correlation, error: syncError instanceof Error ? syncError.message : String(syncError || "request_failed") });
        return { error: syncError, reconciled: false };
      }
    }
    function api(path, options = {}) {
      const method = String(options.method || "GET").toUpperCase();
      const requestPath = path + (path.includes("?") ? "&" : "?") + "locale=" + encodeURIComponent(state.locale);
      const commandId = method === "GET" ? "" : options.commandId || globalThis.crypto?.randomUUID?.() || VERSION + "-command-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const traceId = globalThis.crypto?.randomUUID?.() || VERSION + "-trace-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const removalMatch = path.match(/^\/api\/issues\/([^\/?]+)(?:\/(archive))?(?:\?.*)?$/);
      const removalId = removalMatch && (method === "DELETE" || method === "POST" && removalMatch[2] === "archive") ? decodeURIComponent(removalMatch[1]) : "";
      const removalIssue = removalId ? state.issues.find((issue) => issue.id === removalId) : null;
      if (removalIssue && !READ_ONLY) {
        pendingIssueRemovals.set(removalId, { commandId, issue: removalIssue });
        state.issues = state.issues.filter((issue) => issue.id !== removalId);
        render();
      }
      const startedAt = Date.now();
      const bodyBytes = typeof options.body === "string" ? new TextEncoder().encode(options.body).byteLength : 0;
      appendDiagnostic("api_request", { trace_id: traceId, method, path: requestPath, command_id: commandId, request_body_bytes: bodyBytes });
      if (READ_ONLY && method !== "GET") {
        const error = new Error("remote_read_only");
        appendDiagnostic("api_failure", { trace_id: traceId, method, path: requestPath, command_id: commandId, request_body_bytes: bodyBytes, elapsed_ms: Date.now() - startedAt, error: error.message });
        return Promise.reject(error);
      }
      const attempt = (retriesLeft) => {
        if (typeof window.betterCodexHost?.request === "function") {
          return Promise.resolve(window.betterCodexHost.request({ path: requestPath, method: options.method || "GET", body: options.body, timeoutMs: options.timeoutMs, commandId, traceId, enqueue: options.enqueue === true })).catch((error) => {
            if (retriesLeft > 0 && error instanceof Error && ["runtime_bridge_timeout", "runtime_response_invalid"].includes(error.message)) return attempt(retriesLeft - 1);
            throw error;
          });
        }
        if (typeof window.betterCodexRequest !== "function") return Promise.reject(new Error("runtime_bridge_unavailable"));
        const id = VERSION + ":" + ++bridgeSequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            bridgeRequests.delete(id);
            reject(new Error("runtime_bridge_timeout"));
          }, Number(options.timeoutMs) || 1e4);
          bridgeRequests.set(id, { resolve, reject, timer });
          try {
            window.betterCodexRequest(JSON.stringify({ id, token: BRIDGE_TOKEN, path: requestPath, method: options.method || "GET", body: options.body, timeoutMs: options.timeoutMs, commandId, traceId, enqueue: options.enqueue === true }));
          } catch (error) {
            bridgeRequests.delete(id);
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error("runtime_bridge_unavailable"));
          }
        }).catch((error) => {
          if (retriesLeft > 0 && error instanceof Error && ["runtime_bridge_timeout", "runtime_response_invalid"].includes(error.message)) {
            return attempt(retriesLeft - 1);
          }
          throw error;
        });
      };
      return attempt(method === "GET" ? 1 : 0).then((value) => {
        appendDiagnostic("api_response", { trace_id: traceId, method, path: requestPath, command_id: commandId, elapsed_ms: Date.now() - startedAt });
        if (removalId && value?.queued === true) settleIssueRemoval(removalId, commandId);
        else if (removalId) pendingIssueRemovals.delete(removalId);
        return value;
      }).catch((error) => {
        if (removalId) {
          const pending = pendingIssueRemovals.get(removalId);
          if (pending?.commandId === commandId) {
            pendingIssueRemovals.delete(removalId);
            if (!state.issues.some((issue) => issue.id === removalId)) state.issues.push(pending.issue);
            render();
          }
        }
        appendDiagnostic("api_failure", { trace_id: traceId, method, path: requestPath, command_id: commandId, request_body_bytes: bodyBytes, elapsed_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error || "request_failed") });
        throw error;
      });
    }
    function runtimeUpdatePath(suffix = "") {
      return (RELAY ? "/api/runtime-update" : "/api/update") + suffix;
    }
    function commandStatusPath(commandId) {
      return (REMOTE && !RELAY ? "/api/v1/commands/" : "/api/commands/") + encodeURIComponent(commandId);
    }
    function settleIssueRemoval(issueId, commandId, attempt = 0) {
      const pending = pendingIssueRemovals.get(issueId);
      if (!pending || pending.commandId !== commandId) return;
      const delays = [1e3, 2e3, 5e3, 1e4, 3e4, 12e4, 6e5];
      setTimeout(async () => {
        const current = pendingIssueRemovals.get(issueId);
        if (!current || current.commandId !== commandId) return;
        try {
          const result = await api(commandStatusPath(commandId));
          if (result?.queued === true || ["pending", "dispatched", "processing"].includes(result?.status)) return settleIssueRemoval(issueId, commandId, attempt + 1);
          if (["rejected", "conflict", "expired"].includes(result?.status)) throw new Error(result.error || "command_rejected");
          pendingIssueRemovals.delete(issueId);
          void loadIssues({ background: true }).catch(() => {
          });
        } catch (error) {
          if (error instanceof Error && ["command_not_found", "runtime_offline", "runtime_unavailable", "runtime_bridge_timeout", "relay_stream_interrupted", "request_outcome_unknown"].includes(error.message)) return settleIssueRemoval(issueId, commandId, attempt + 1);
          pendingIssueRemovals.delete(issueId);
          if (!state.issues.some((issue) => issue.id === issueId)) state.issues.push(current.issue);
          render();
          void loadIssues({ background: true }).catch(() => {
          });
        }
      }, delays[Math.min(attempt, delays.length - 1)]);
    }
    function listResponse(value, path, kind) {
      if (Array.isArray(value)) return value;
      const diagnostics = {
        response_path: path,
        response_kind: kind,
        response_type: value === null ? "null" : typeof value,
        response_keys: value && typeof value === "object" ? Object.keys(value).slice(0, 20) : []
      };
      appendDiagnostic("api_invalid_response", diagnostics);
      const error = new Error("invalid_" + kind + "_response");
      error.betterCodexDiagnostics = diagnostics;
      throw error;
    }
    async function requestList(path, kind, options = {}) {
      const key = kind + ":" + path + ":" + String(Boolean(options.passive));
      if (listRequests.has(key)) return listRequests.get(key);
      const request = (async () => {
        try {
          return listResponse(await api(path, options), path, kind);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "invalid_" + kind + "_response") throw error;
          return listResponse(await api(path, options), path, kind);
        }
      })();
      listRequests.set(key, request);
      try {
        return await request;
      } finally {
        if (listRequests.get(key) === request) listRequests.delete(key);
      }
    }
    function requestProjects(options = {}) {
      return requestList("/api/projects", "projects", options);
    }
    function startLiveUpdates() {
      if (liveUnsubscribe || typeof window.betterCodexHost?.subscribe !== "function") return false;
      liveUnsubscribe = window.betterCodexHost.subscribe((event) => {
        if (event?.event === "ready" && !bootstrapReady) return;
        if (document.hidden) {
          liveDirty = true;
          return;
        }
        if (active && !panel?.dataset.recovery) void perform(() => REMOTE ? Promise.all([loadSurface({ background: true }), loadAutoDispatch({ background: true })]) : loadSurface({ background: true }), { background: true });
      });
      return typeof liveUnsubscribe === "function";
    }
    function onVisibilityChange() {
      if (document.hidden || !liveDirty && !passiveNetworkErrorVisible || !active || panel?.dataset.recovery) return;
      liveDirty = false;
      void perform(() => REMOTE ? Promise.all([loadSurface({ background: true }), loadAutoDispatch({ background: true })]) : loadSurface({ background: true }), { background: true });
    }
    function onNetworkOnline() {
      if (!active || panel?.dataset.recovery) return;
      void perform(() => REMOTE ? Promise.all([loadSurface({ background: true }), loadAutoDispatch({ background: true })]) : loadSurface({ background: true }), { background: true });
    }
    function appServerError(value) {
      if (!value) return "desktop_bridge_request_failed";
      if (typeof value === "string") return value;
      if (typeof value.message === "string") return value.message;
      if (typeof value.code === "string") return value.code;
      return "desktop_bridge_request_failed";
    }
    function codexError(value) {
      const error = value && typeof value === "object" ? value : {};
      const info = error.codexErrorInfo;
      if (typeof info === "string") return { code: info, httpStatusCode: null };
      const structured = info && typeof info === "object" ? info : {};
      const code = Object.keys(structured)[0] || "other";
      const detail = structured[code] && typeof structured[code] === "object" ? structured[code] : {};
      return { code, httpStatusCode: Number.isInteger(detail.httpStatusCode) ? detail.httpStatusCode : null };
    }
    function retryKind(code) {
      if (code === "httpConnectionFailed") return "network";
      if (["responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].includes(code)) return "stream";
      if (code === "serverOverloaded") return "overloaded";
      if (code === "usageLimitExceeded") return "rate_limit";
      return "service";
    }
    function relayEventTurnId(method, params) {
      if (["error", "item/started", "item/completed"].includes(method)) return normalizeSessionId(params?.turnId);
      if (method === "turn/started" || method === "turn/completed") return normalizeSessionId(params?.turn?.id);
      return "";
    }
    function queueRelayEvent(method, params) {
      relayEventQueue = relayEventQueue.catch(() => {
      }).then(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            return await api("/api/session-relay/events", {
              method: "POST",
              body: JSON.stringify({ relay_id: relayId, method, params })
            });
          } catch {
            if (attempt === 2) return;
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
      }).catch(() => {
      });
    }
    function flushRelayEvents(turnId = "", includeUnmatched = false) {
      const buffered = relayBufferedEvents;
      relayBufferedEvents = [];
      buffered.forEach((event) => {
        const eventTurnId = relayEventTurnId(event.method, event.params);
        if (includeUnmatched || !eventTurnId || eventTurnId === turnId) queueRelayEvent(event.method, event.params);
      });
    }
    function nativeUserMessage(item) {
      let remaining = 4096;
      const source = Array.isArray(item.content) ? item.content : typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];
      const content = source.flatMap((part) => {
        if (part?.type !== "text" || typeof part.text !== "string" || !remaining) return [];
        const text = part.text.slice(0, remaining);
        remaining -= text.length;
        return [{ type: "text", text }];
      });
      return { id: String(item.id || ""), type: "userMessage", content };
    }
    function appServerEnvelope(value, event = null) {
      let message = value;
      if (typeof message === "string") {
        try {
          message = JSON.parse(message);
        } catch {
          return false;
        }
      }
      if (!message || typeof message !== "object") return false;
      if (message.type === "mcp-response") {
        const response = message.message && typeof message.message === "object" ? message.message : {};
        const id = String(response.id || "");
        const pending = appServerRequests.get(id);
        if (!pending) return false;
        event?.stopImmediatePropagation?.();
        appServerRequests.delete(id);
        clearTimeout(pending.timer);
        const elapsed = Date.now() - pending.startedAt;
        if (elapsed >= 5e3) appendDiagnostic("app_server_request_slow", { request_id: id, method: pending.method, elapsed_ms: elapsed, outcome: response.error ? "error" : "success", thread_id: relayCurrentThreadId || null });
        if (response.error) pending.reject(new Error(appServerError(response.error)));
        else pending.resolve(response.result);
        return true;
      }
      if (message.type !== "mcp-notification") return false;
      const method = String(message.method || "");
      const params = message.params && typeof message.params === "object" ? message.params : {};
      if (method === "thread/started") return false;
      const threadId = normalizeSessionId(params.threadId);
      if (!threadId || !relayThreads.has(threadId) && threadId !== relayCurrentThreadId) return false;
      if (method === "item/autoApprovalReview/completed") {
        if (params.review?.status === "denied") {
          const denials = relayGuardianDenials.get(threadId) || [];
          const source = params.action || {};
          const commandSource = source.source === "unifiedExec" ? "unified_exec" : source.source;
          const protocol = source.protocol === "socks5Tcp" ? "socks5_tcp" : source.protocol === "socks5Udp" ? "socks5_udp" : source.protocol;
          const permissions = source.permissions || {};
          const action = source.type === "command" ? { type: "command", source: commandSource, command: source.command, cwd: source.cwd } : source.type === "execve" ? { type: "execve", source: commandSource, program: source.program, argv: source.argv, cwd: source.cwd } : source.type === "applyPatch" ? { type: "apply_patch", cwd: source.cwd, files: source.files } : source.type === "networkAccess" ? { type: "network_access", target: source.target, host: source.host, protocol, port: source.port } : source.type === "mcpToolCall" ? { type: "mcp_tool_call", server: source.server, tool_name: source.toolName, connector_id: source.connectorId ?? null, connector_name: source.connectorName ?? null, tool_title: source.toolTitle ?? null } : source.type === "requestPermissions" ? { type: "request_permissions", reason: source.reason ?? null, permissions: { network: permissions.network ?? null, file_system: permissions.fileSystem ?? null } } : { type: source.type };
          denials.push({ id: String(params.reviewId || ""), target_item_id: params.targetItemId ?? null, turn_id: String(params.turnId || ""), status: String(params.review.status || ""), risk_level: params.review.riskLevel ?? null, user_authorization: params.review.userAuthorization ?? null, rationale: params.review.rationale ?? null, decision_source: params.decisionSource ?? null, action });
          relayGuardianDenials.set(threadId, denials.slice(-20));
        }
        return true;
      }
      if (!["thread/status/changed", "turn/started", "turn/completed", "error", "item/started", "item/completed"].includes(method)) return false;
      let relayParams = params;
      if (method === "thread/status/changed") {
        const status = params.status && typeof params.status === "object" ? params.status : {};
        relayParams = { threadId, status: { type: String(status.type || ""), activeFlags: Array.isArray(status.activeFlags) ? status.activeFlags.filter((value2) => typeof value2 === "string") : [] } };
      }
      if (method === "turn/started") {
        const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
        relayParams = { threadId, turn: { id: String(turn.id || ""), status: String(turn.status || "") } };
      }
      if (method === "error") {
        const turnId = normalizeSessionId(params.turnId);
        if (!turnId) return false;
        const error = params.error && typeof params.error === "object" ? params.error : {};
        const detail = codexError(error);
        relayParams = { threadId, turnId, willRetry: params.willRetry === true, error: { kind: retryKind(detail.code), code: detail.code, httpStatusCode: detail.httpStatusCode, message: String(error.message || "provider_request_failed").slice(0, 2e3) } };
      }
      if (method === "item/started") {
        const turnId = normalizeSessionId(params.turnId);
        if (!turnId) return false;
        const item = params.item && typeof params.item === "object" ? params.item : {};
        relayParams = { threadId, turnId, item: item.type === "userMessage" ? nativeUserMessage(item) : { type: String(item.type || "").slice(0, 100) } };
      }
      if (method === "item/completed") {
        const item = params.item && typeof params.item === "object" ? params.item : {};
        if (item.type === "userMessage") relayParams = { threadId, turnId: String(params.turnId || ""), item: nativeUserMessage(item) };
        else if (item.type === "agentMessage" && typeof item.text === "string") relayParams = { threadId, turnId: String(params.turnId || ""), item: { type: "agentMessage", text: item.text } };
        else return false;
      }
      if (method === "turn/completed") {
        const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
        const error = turn.error && typeof turn.error === "object" ? turn.error : null;
        const items = Array.isArray(turn.items) ? turn.items.flatMap((item) => item && typeof item === "object" && item.type === "agentMessage" && typeof item.text === "string" ? [{ type: "agentMessage", text: item.text }] : []) : [];
        relayParams = { threadId, turn: { id: String(turn.id || ""), status: String(turn.status || ""), items, error: error ? { message: String(error.message || "") } : null } };
      }
      if (relayCommandInFlight && method !== "thread/status/changed" && method !== "turn/started") relayBufferedEvents.push({ method, params: relayParams });
      else queueRelayEvent(method, relayParams);
      return true;
    }
    function onAppServerMessage(event) {
      appServerEnvelope(event.data, event);
    }
    function sendAppServerRequest(method, params) {
      if (typeof window.electronBridge?.sendMessageFromView !== "function") return Promise.reject(new Error("desktop_bridge_unavailable"));
      const id = relayId + ":" + ++appServerSequence;
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          appServerRequests.delete(id);
          appendDiagnostic("app_server_request_timeout", { request_id: id, method, timeout_ms: 3e4, elapsed_ms: Date.now() - startedAt, pending_requests: appServerRequests.size, command_in_flight: relayCommandInFlight, thread_id: relayCurrentThreadId || null });
          reject(new Error("desktop_bridge_timeout"));
        }, 3e4);
        appServerRequests.set(id, { resolve, reject, timer, method, startedAt });
        Promise.resolve(window.electronBridge.sendMessageFromView({
          type: "mcp-request",
          hostId: "local",
          request: { id, method, params },
          source: "better-codex",
          timeoutMs: 3e4
        })).catch((error) => {
          const pending = appServerRequests.get(id);
          if (!pending) return;
          appServerRequests.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("desktop_bridge_unavailable"));
        });
      });
    }
    function nativeWorkspaceParams(payload = {}) {
      const params = {};
      if (payload.workspace_path) params.cwd = String(payload.workspace_path);
      const roots = Array.isArray(payload.root_paths) ? payload.root_paths.map(String).filter(Boolean) : [];
      if (roots.length) params.runtimeWorkspaceRoots = roots;
      return params;
    }
    function nativeExplicitParams(payload = {}) {
      const params = nativeWorkspaceParams(payload);
      if (payload.native_defaults === true) return params;
      for (const [source, target] of Object.entries({ model: "model", effort: "effort", service_tier: "serviceTier", approval_policy: "approvalPolicy", approvals_reviewer: "approvalsReviewer", sandbox_mode: "sandbox", developer_instructions: "developerInstructions" })) {
        if (typeof payload[source] === "string" && payload[source]) params[target] = payload[source];
      }
      return params;
    }
    async function resumePersistedThread(threadId, payload = null) {
      const expected = normalizeSessionId(threadId);
      if (!expected) throw new Error("thread_id_invalid");
      const resumed = await sendAppServerRequest("thread/resume", { threadId: expected, excludeTurns: true, ...nativeExplicitParams(payload || {}) });
      if (normalizeSessionId(resumed?.thread?.id) !== expected) throw new Error("desktop_thread_resume_invalid");
      relayThreads.add(expected);
      return resumed;
    }
    function isThreadNotFoundError(error) {
      const value = String(error instanceof Error ? error.message : error || "").toLowerCase();
      return value.includes("thread not found") || value.includes("thread_not_found");
    }
    function semanticInput(payload) {
      if (!Array.isArray(payload.input)) return [{ type: "text", text: String(payload.message || "") }];
      const input = payload.input.slice(0, 33).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        if (item.type === "text") return [{ type: "text", text: String(item.text || "").slice(0, 1e5) }];
        if (!["skill", "mention"].includes(item.type)) return [];
        const name = String(item.name || "").trim().slice(0, 500);
        const path = String(item.path || "").trim().slice(0, 4096);
        return name && path ? [{ type: item.type, name, path }] : [];
      });
      return input.some((item) => item.type === "text") ? input : [{ type: "text", text: String(payload.message || "") }, ...input];
    }
    function turnStartParams(threadId, payload) {
      const params = { threadId, input: semanticInput(payload), ...nativeExplicitParams(payload) };
      if (payload.native_defaults === true) params.input = params.input.map((item) => item.type === "text" ? { ...item, text: item.text.replaceAll("__BETTER_CODEX_THREAD_ID__", threadId) } : item);
      delete params.sandbox;
      delete params.developerInstructions;
      return params;
    }
    function heartbeatSessionRelay() {
      if (relayHeartbeatBusy || destroyed) return Promise.resolve();
      relayHeartbeatBusy = true;
      return api("/api/session-relay/poll", {
        method: "POST",
        body: JSON.stringify({
          relay_id: relayId,
          app_session_id: relayAppSessionId || relayId,
          owner: "native",
          capability: relayCapability,
          capability_error: relayCapabilityError,
          busy: true
        })
      }).catch(() => {
      }).finally(() => {
        relayHeartbeatBusy = false;
      });
    }
    function nativeArgument(command, argument) {
      if (!argument) throw new Error("native_command_argument_required:" + command);
      return argument;
    }
    async function executeInjectedNativeCommand(threadId, payload) {
      const command = String(payload.native_command || "");
      const argument = String(payload.argument || "").trim();
      const resumed = await resumePersistedThread(threadId, payload);
      if (command === "approve") {
        const denials = relayGuardianDenials.get(threadId) || [];
        const event = denials.at(-1);
        if (!event) throw new Error("native_approval_not_found");
        const response = await sendAppServerRequest("thread/approveGuardianDeniedAction", { threadId, event });
        denials.pop();
        return { thread_id: threadId, command, approved: true, response };
      }
      if (command === "fast") {
        const value = argument.toLowerCase();
        if (value && !["on", "off", "fast", "default", "true", "false", "1", "0"].includes(value)) throw new Error("native_fast_value_invalid");
        const enabled = value ? ["on", "fast", "true", "1"].includes(value) : String(resumed?.serviceTier || "default") !== "fast";
        await sendAppServerRequest("thread/settings/update", { threadId, serviceTier: enabled ? "fast" : null });
        return { thread_id: threadId, command, service_tier: enabled ? "fast" : "default" };
      }
      if (command === "feedback") {
        const reason = nativeArgument(command, argument);
        const response = await sendAppServerRequest("feedback/upload", { classification: "bug", reason, threadId, includeLogs: false });
        return { thread_id: threadId, command, uploaded: true, response };
      }
      if (command === "fork") {
        const response = await sendAppServerRequest("thread/fork", { threadId, cwd: String(payload.workspace_path || "") || null, excludeTurns: true });
        const forkedThreadId = normalizeSessionId(response?.thread?.id);
        if (!forkedThreadId) throw new Error("native_fork_invalid");
        if (argument) await sendAppServerRequest("thread/name/set", { threadId: forkedThreadId, name: argument.slice(0, 200) });
        relayThreads.add(forkedThreadId);
        return { thread_id: forkedThreadId, source_thread_id: threadId, command, rebind_thread: true };
      }
      if (command === "goal") {
        const value = argument.toLowerCase();
        if (!argument) return { thread_id: threadId, command, ...await sendAppServerRequest("thread/goal/get", { threadId }) };
        if (["clear", "off", "none"].includes(value)) {
          await sendAppServerRequest("thread/goal/clear", { threadId });
          return { thread_id: threadId, command, goal: null };
        }
        return { thread_id: threadId, command, ...await sendAppServerRequest("thread/goal/set", { threadId, objective: argument, status: "active" }) };
      }
      if (command === "init") {
        const input = [{ type: "text", text: "Create an AGENTS.md file that serves as a concise contributor guide for this repository. Inspect the repository first. Include project structure, build and validation commands, coding conventions, and commit guidance that are actually supported by the repository. Do not overwrite an existing AGENTS.md; if one exists, report that clearly instead." }];
        const turn = await sendAppServerRequest("turn/start", turnStartParams(threadId, { ...payload, input }));
        const turnId = normalizeSessionId(turn?.turn?.id);
        if (!turnId) throw new Error("desktop_turn_start_invalid");
        return { thread_id: threadId, turn_id: turnId, command };
      }
      if (command === "mcp") {
        const response = await sendAppServerRequest("mcpServerStatus/list", { threadId, cursor: null, limit: 100, detail: "toolsAndAuthOnly" });
        const servers = (Array.isArray(response?.data) ? response.data : []).map((server) => ({ name: String(server?.name || ""), auth_status: String(server?.authStatus || ""), tool_count: server?.tools && typeof server.tools === "object" ? Object.keys(server.tools).length : 0, resource_count: Array.isArray(server?.resources) ? server.resources.length : 0 }));
        return { thread_id: threadId, command, servers, next_cursor: response?.nextCursor ?? null };
      }
      if (command === "memories") {
        const value = nativeArgument(command, argument).toLowerCase();
        if (!["on", "off", "enabled", "disabled"].includes(value)) throw new Error("native_memories_value_invalid");
        const mode = ["on", "enabled"].includes(value) ? "enabled" : "disabled";
        await sendAppServerRequest("thread/memoryMode/set", { threadId, mode });
        return { thread_id: threadId, command, memory_mode: mode };
      }
      if (command === "model") {
        const model = nativeArgument(command, argument);
        await sendAppServerRequest("thread/settings/update", { threadId, model });
        return { thread_id: threadId, command, model };
      }
      if (command === "personality") {
        const personality = nativeArgument(command, argument).toLowerCase();
        if (!["none", "friendly", "pragmatic"].includes(personality)) throw new Error("native_personality_value_invalid");
        await sendAppServerRequest("thread/settings/update", { threadId, personality });
        return { thread_id: threadId, command, personality };
      }
      if (command === "plan") {
        const value = argument.toLowerCase();
        if (value && !["on", "off", "plan", "default"].includes(value)) throw new Error("native_plan_value_invalid");
        const mode = ["off", "default"].includes(value) ? "default" : "plan";
        const presets = await sendAppServerRequest("collaborationMode/list", {});
        const preset = (Array.isArray(presets?.data) ? presets.data : []).find((item) => item?.mode === mode);
        if (!preset) throw new Error("native_plan_preset_unavailable");
        await sendAppServerRequest("thread/settings/update", { threadId, collaborationMode: { mode, settings: { model: preset.model || resumed?.model, reasoning_effort: preset.reasoning_effort ?? resumed?.reasoningEffort, developer_instructions: null } } });
        return { thread_id: threadId, command, collaboration_mode: mode };
      }
      if (command === "project") {
        const projectId = nativeArgument(command, argument);
        await sendAppServerRequest("thread/metadata/update", { threadId, projectId: ["none", "clear"].includes(projectId) ? "" : projectId });
        return { thread_id: threadId, command, project_id: ["none", "clear"].includes(projectId) ? null : projectId };
      }
      if (command === "reasoning") {
        const effort = nativeArgument(command, argument);
        await sendAppServerRequest("thread/settings/update", { threadId, effort });
        return { thread_id: threadId, command, reasoning_effort: effort };
      }
      throw new Error("native_command_invalid");
    }
    async function executeSessionCommand(command) {
      const payload = command?.payload && typeof command.payload === "object" ? command.payload : {};
      let threadId = normalizeSessionId(command?.thread_id);
      let turnId = normalizeSessionId(command?.turn_id);
      const heartbeat = setInterval(() => void heartbeatSessionRelay(), 2e3);
      relayCommandInFlight = true;
      relayBufferedEvents = [];
      try {
        let completion = {};
        if (command.kind === "bind" || command.kind === "start") {
          const params = nativeExplicitParams(payload);
          if (Array.isArray(payload.dynamic_tools)) params.dynamicTools = payload.dynamic_tools;
          const started = await sendAppServerRequest("thread/start", params);
          threadId = normalizeSessionId(started?.thread?.id);
          if (!threadId) throw new Error("desktop_thread_start_invalid");
          relayThreads.add(threadId);
          relayCurrentThreadId = threadId;
          if (command.scope === "project") {
            state.nativeThreadLinks ||= {};
            state.nativeThreadLinks[threadId] = { thread_id: threadId, project_id: command.project_id, kind: command.session_kind };
            sessionStorage.setItem("better-codex-native-return", JSON.stringify(state.nativeThreadLinks[threadId]));
          }
          if (command.scope === "project" || payload.native_defaults === true) {
            payload.message = String(payload.message || "").replaceAll("__BETTER_CODEX_THREAD_ID__", threadId);
            if (Array.isArray(payload.input)) payload.input = payload.input.map((item) => item?.type === "text" ? { ...item, text: String(item.text || "").replaceAll("__BETTER_CODEX_THREAD_ID__", threadId) } : item);
            if (payload.title) await sendAppServerRequest("thread/name/set", { threadId, name: String(payload.title).slice(0, 200) });
          }
          await api("/api/session-relay/commands/" + encodeURIComponent(command.id) + "/checkpoint", {
            method: "POST",
            body: JSON.stringify({ relay_id: relayId, result: { thread_id: threadId } })
          });
          if (command.kind === "start") {
            const turn = payload.semantic_command === "review" ? await sendAppServerRequest("review/start", { threadId, target: { type: "uncommittedChanges" }, delivery: "inline" }) : await sendAppServerRequest("turn/start", turnStartParams(threadId, payload));
            turnId = normalizeSessionId(turn?.turn?.id);
            if (!turnId) throw new Error("desktop_turn_start_invalid");
            await api("/api/session-relay/commands/" + encodeURIComponent(command.id) + "/checkpoint", {
              method: "POST",
              body: JSON.stringify({ relay_id: relayId, result: { thread_id: threadId, turn_id: turnId } })
            });
          }
        } else if (command.kind === "turn") {
          if (!threadId) throw new Error("session_thread_invalid");
          relayCurrentThreadId = threadId;
          await resumePersistedThread(threadId, payload);
          let turn;
          try {
            turn = await sendAppServerRequest("turn/start", turnStartParams(threadId, payload));
          } catch (error) {
            if (!isThreadNotFoundError(error)) throw error;
            await resumePersistedThread(threadId, payload);
            turn = await sendAppServerRequest("turn/start", turnStartParams(threadId, payload));
          }
          turnId = normalizeSessionId(turn?.turn?.id);
          if (!turnId) throw new Error("desktop_turn_start_invalid");
          await api("/api/session-relay/commands/" + encodeURIComponent(command.id) + "/checkpoint", {
            method: "POST",
            body: JSON.stringify({ relay_id: relayId, result: { thread_id: threadId, turn_id: turnId } })
          });
        } else if (command.kind === "review") {
          if (!threadId) throw new Error("session_thread_invalid");
          relayCurrentThreadId = threadId;
          await resumePersistedThread(threadId, payload);
          const review = await sendAppServerRequest("review/start", { threadId, target: { type: "uncommittedChanges" }, delivery: "inline" });
          turnId = normalizeSessionId(review?.turn?.id);
          if (!turnId) throw new Error("desktop_turn_start_invalid");
          await api("/api/session-relay/commands/" + encodeURIComponent(command.id) + "/checkpoint", {
            method: "POST",
            body: JSON.stringify({ relay_id: relayId, result: { thread_id: threadId, turn_id: turnId } })
          });
        } else if (command.kind === "compact") {
          if (!threadId) throw new Error("session_thread_invalid");
          relayCurrentThreadId = threadId;
          await resumePersistedThread(threadId, payload);
          await sendAppServerRequest("thread/compact/start", { threadId });
        } else if (command.kind === "rename") {
          if (!threadId) throw new Error("session_thread_invalid");
          const name = String(payload.title || "").trim().slice(0, 200);
          if (!name) throw new Error("thread_name_required");
          relayCurrentThreadId = threadId;
          await sendAppServerRequest("thread/name/set", { threadId, name });
          completion = { name };
          appendDiagnostic("thread_name_updated", { command_id: command.id, issue_id: command.issue_id, thread_id: threadId, title_length: name.length });
        } else if (command.kind === "native") {
          if (!threadId) throw new Error("session_thread_invalid");
          relayCurrentThreadId = threadId;
          completion = await executeInjectedNativeCommand(threadId, payload);
          threadId = normalizeSessionId(completion.thread_id) || threadId;
          turnId = normalizeSessionId(completion.turn_id) || turnId;
        } else if (command.kind === "steer") {
          if (!threadId || !turnId) throw new Error("session_turn_invalid");
          relayCurrentThreadId = threadId;
          const steered = await sendAppServerRequest("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: semanticInput(payload)
          });
          turnId = normalizeSessionId(steered?.turnId) || turnId;
        } else if (command.kind === "interrupt") {
          if (!threadId || !turnId) throw new Error("session_turn_invalid");
          relayCurrentThreadId = threadId;
          await sendAppServerRequest("turn/interrupt", { threadId, turnId });
        } else {
          throw new Error("session_command_invalid");
        }
        await api("/api/session-relay/commands/" + encodeURIComponent(command.id) + "/complete", {
          method: "POST",
          body: JSON.stringify({ relay_id: relayId, result: { thread_id: threadId, turn_id: turnId, ...completion } })
        });
        relayCommandInFlight = false;
        flushRelayEvents(turnId, command.kind === "steer" || command.kind === "interrupt" || command.kind === "compact");
        if (threadId) relayThreads.add(threadId);
        if (command.scope === "project" && threadId) await openThread(threadId);
      } catch (error) {
        const commandError = error instanceof Error ? error.message : "desktop_bridge_request_failed";
        if (command.kind === "rename") appendDiagnostic("thread_name_failed", { command_id: command.id, issue_id: command.issue_id, thread_id: threadId || null, error: commandError });
        if (threadId && turnId && commandError === "session_command_not_claimed") {
          await sendAppServerRequest("turn/interrupt", { threadId, turnId }).catch(() => {
          });
        }
        const failed = await api("/api/session-relay/commands/" + encodeURIComponent(command.id) + "/fail", {
          method: "POST",
          body: JSON.stringify({ relay_id: relayId, error: commandError, thread_id: threadId, turn_id: turnId })
        }).catch(() => {
        });
        relayCommandInFlight = false;
        flushRelayEvents("", true);
        if (commandError === "desktop_bridge_unavailable" || commandError === "desktop_bridge_timeout") {
          relayCapability = "failed";
          relayCapabilityError = commandError;
          relayCapabilityCheckedAt = Date.now();
        }
        if (failed && threadId) relayThreads.add(threadId);
      } finally {
        clearInterval(heartbeat);
        if (relayCommandInFlight) {
          relayCommandInFlight = false;
          flushRelayEvents("", true);
        }
        relayCurrentThreadId = "";
      }
    }
    async function resolveRelayAppSessionId() {
      if (relayAppSessionId) return relayAppSessionId;
      try {
        const value = await window.electronBridge?.getAppSessionId?.();
        relayAppSessionId = typeof value === "string" ? value : typeof value?.appSessionId === "string" ? value.appSessionId : relayId;
      } catch {
        relayAppSessionId = relayId;
      }
      return relayAppSessionId;
    }
    async function reconcileRelayTurns(values) {
      await Promise.all(values.map(async (value) => {
        const threadId = normalizeSessionId(value?.thread_id);
        const turnId = normalizeSessionId(value?.turn_id);
        if (!threadId || !turnId) return;
        try {
          let summary = await sendAppServerRequest("thread/read", { threadId, includeTurns: false });
          let status = summary?.thread?.status && typeof summary.thread.status === "object" ? summary.thread.status : {};
          let statusType = String(status.type || "");
          if (statusType === "notLoaded") {
            await resumePersistedThread(threadId);
            summary = await sendAppServerRequest("thread/read", { threadId, includeTurns: false });
            status = summary?.thread?.status && typeof summary.thread.status === "object" ? summary.thread.status : {};
            statusType = String(status.type || "");
          }
          if (statusType === "active") {
            queueRelayEvent("thread/status/changed", {
              threadId,
              status: {
                type: statusType,
                activeFlags: Array.isArray(status.activeFlags) ? status.activeFlags.filter((item) => typeof item === "string") : []
              }
            });
            return;
          }
          if (statusType !== "idle") return;
          const detail = await sendAppServerRequest("thread/read", { threadId, includeTurns: true });
          const turns = Array.isArray(detail?.thread?.turns) ? detail.thread.turns : [];
          const turn = turns.find((item) => normalizeSessionId(item?.id) === turnId);
          if (!turn || !["completed", "interrupted", "failed"].includes(String(turn.status || ""))) return;
          const items = Array.isArray(turn.items) ? turn.items.flatMap((item) => item && typeof item === "object" && item.type === "agentMessage" && typeof item.text === "string" ? [{ type: "agentMessage", text: item.text }] : []) : [];
          const error = turn.error && typeof turn.error === "object" ? { message: String(turn.error.message || "") } : null;
          queueRelayEvent("turn/completed", { threadId, turn: { id: turnId, status: String(turn.status), items, error } });
        } catch {
        }
      }));
    }
    let desktopCatalogServices = null;
    async function syncThreadCatalogAction(action) {
      let error = "";
      try {
        if (!desktopCatalogServices) {
          const entry2 = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).find((link) => /\/app-initial-[^/]+\.js$/.test(new URL(link.href).pathname));
          if (!entry2) throw new Error("desktop_catalog_module_unavailable");
          const exports = await import(entry2.href);
          desktopCatalogServices = Object.values(exports).find((value) => value && typeof value === "object" && typeof value.localThreadCatalog?.notifyThread === "function");
          if (!desktopCatalogServices) throw new Error("desktop_catalog_service_unavailable");
        }
        await desktopCatalogServices.localThreadCatalog.notifyThread({ hostId: "local", threadId: action.thread_id }, action.action === "unarchive" ? "upsert" : "remove");
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "mcp-notification",
          hostId: "local",
          method: action.action === "delete" ? "thread/deleted" : action.action === "archive" ? "thread/archived" : "thread/unarchived",
          params: { threadId: action.thread_id }
        } }));
        appendDiagnostic("thread_catalog_synced", { thread_id: action.thread_id, event_id: action.event_id, action: action.action });
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        desktopCatalogServices = null;
        appendDiagnostic("thread_catalog_sync_failed", { thread_id: action.thread_id, event_id: action.event_id, action: action.action, error });
      }
      await api("/api/session-relay/catalog-ack", { method: "POST", body: JSON.stringify({ relay_id: relayId, thread_id: action.thread_id, event_id: action.event_id, error }) });
    }
    async function pollSessionRelay() {
      if (relayBusy || destroyed) return;
      relayBusy = true;
      try {
        if (relayCapability === "failed" && Date.now() - relayCapabilityCheckedAt > 1e4) relayCapability = "unknown";
        if (relayCapability === "unknown") {
          relayCapabilityCheckedAt = Date.now();
          try {
            await sendAppServerRequest("thread/list", { limit: 1 });
            relayCapability = "ready";
            relayCapabilityError = "";
          } catch (error) {
            relayCapability = "failed";
            relayCapabilityError = error instanceof Error ? error.message : "desktop_bridge_unavailable";
          }
        }
        const result = await api("/api/session-relay/poll", {
          method: "POST",
          body: JSON.stringify({
            relay_id: relayId,
            app_session_id: await resolveRelayAppSessionId(),
            owner: "native",
            capability: relayCapability,
            capability_error: relayCapabilityError
          })
        });
        relayThreads.clear();
        (Array.isArray(result?.thread_ids) ? result.thread_ids : []).forEach((value) => {
          const threadId = normalizeSessionId(value);
          if (threadId) relayThreads.add(threadId);
        });
        if (!result?.leader) return;
        if (relayCapability !== "ready") return;
        for (const action of result.catalog_actions || []) await syncThreadCatalogAction(action);
        if (result.command) {
          await executeSessionCommand(result.command);
          return;
        }
        const activeTurns = Array.isArray(result?.active_turns) ? result.active_turns : [];
        if (activeTurns.length && Date.now() - relayTurnProbeAt >= 5e3) {
          relayTurnProbeAt = Date.now();
          await reconcileRelayTurns(activeTurns);
        }
      } catch {
      } finally {
        relayBusy = false;
      }
    }
    function pulseSessionRelay() {
      if (destroyed) return false;
      if (relayBusy) {
        if (relayCapability === "ready") void heartbeatSessionRelay();
        return true;
      }
      void pollSessionRelay();
      return true;
    }
    function startSessionRelay() {
      if (relayTimer !== null) return;
      pulseSessionRelay();
      relayTimer = setInterval(pulseSessionRelay, 1e3);
    }
    function diagnosticTarget(target) {
      if (!(target instanceof Element)) return "";
      const name = target.getAttribute("name");
      const type = target.getAttribute("type");
      return [target.tagName.toLowerCase(), name ? "name=" + name : "", type ? "type=" + type : ""].filter(Boolean).join(" ");
    }
    function traceRendererDiagnostic(event, fields = {}) {
      const context = readContext();
      const selected = state.selected;
      const body = {
        event,
        sequence: ++diagnosticSequence,
        client_time: (/* @__PURE__ */ new Date()).toISOString(),
        performance_ms: Math.round(performance.now() * 1e3) / 1e3,
        issue_id: selected?.id || "",
        issue_identifier: selected?.identifier || "",
        active_thread_id: context.threadId || "",
        document_focused: document.hasFocus(),
        ...fields
      };
      appendDiagnostic(event, body);
      try {
        void window.electronBridge?.sendMessageFromView?.({
          type: "log-message",
          level: "info",
          message: "BETTER_CODEX_DIAGNOSTIC",
          tags: { safe: body, sensitive: {} }
        })?.catch?.(() => {
        });
      } catch {
      }
    }
    function interruptMessage(detail) {
      if (!detail || typeof detail !== "object") return null;
      const candidates = [detail, detail.message, detail.request, detail.params, detail.message?.request, detail.message?.params];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const method = String(candidate.method || candidate.requestMethod || "");
        const type = String(candidate.type || "");
        if (method !== "turn/interrupt" && type !== "interrupt-conversation") continue;
        const params = candidate.params && typeof candidate.params === "object" ? candidate.params : candidate;
        return {
          message_type: String(detail.type || type || ""),
          method: method || type,
          thread_id: String(params.threadId || params.conversationId || ""),
          turn_id: String(params.turnId || "")
        };
      }
      return null;
    }
    function onHostMessageFromView(event) {
      appServerEnvelope(event.detail);
      const message = interruptMessage(event.detail);
      if (message) traceRendererDiagnostic("host_interrupt_message", message);
    }
    window.__betterCodexBridgeResolve = (id, result) => {
      const pending = bridgeRequests.get(id);
      if (!pending) return;
      bridgeRequests.delete(id);
      clearTimeout(pending.timer);
      if (result?.ok) pending.resolve(result.value);
      else {
        const error = new Error(result?.value?.error || "request_failed");
        if (result?.value?.diagnostics) error.betterCodexDiagnostics = result.value.diagnostics;
        pending.reject(error);
      }
    };
    function diagnosticValue(value, depth = 0) {
      if (value === null || value === void 0 || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value === "string") return value.length > 4e3 ? value.slice(0, 4e3) + "…" : value;
      if (value instanceof Error) return { name: value.name, message: value.message, stack: String(value.stack || "").slice(0, 12e3) };
      if (depth >= 4) return "[depth limited]";
      if (Array.isArray(value)) return value.slice(0, 50).map((item) => diagnosticValue(item, depth + 1));
      if (typeof value !== "object") return String(value);
      const result = {};
      for (const [key, item] of Object.entries(value).slice(0, 80)) {
        if (/authorization|cookie|token|password|secret|request_body|response_body|content|prompt/i.test(key) && !/bytes|length|size/i.test(key)) result[key] = "[redacted]";
        else result[key] = diagnosticValue(item, depth + 1);
      }
      return result;
    }
    function appendDiagnostic(event, fields = {}) {
      diagnosticLog.push({ time: (/* @__PURE__ */ new Date()).toISOString(), event, ...diagnosticValue(fields) });
      if (diagnosticLog.length > 80) diagnosticLog.splice(0, diagnosticLog.length - 80);
    }
    function relatedDiagnosticLogs(record) {
      const keys = ["trace_id", "command_id", "request_id", "update_id", "issue_id", "issue_identifier", "thread_id", "turn_id"];
      const sources = [record.context || {}, record.diagnostics || {}];
      const traceId = sources.map((source) => String(source.trace_id || "")).find(Boolean);
      const hostTimeline = Array.isArray(record.diagnostics?.trace_timeline) ? record.diagnostics.trace_timeline : [];
      if (traceId) return [...hostTimeline, ...diagnosticLog.filter((log) => String(log.trace_id || "") === traceId)].sort((left, right) => String(left.time || "").localeCompare(String(right.time || ""))).slice(-8);
      const correlations = new Map(keys.map((key) => [key, sources.map((source) => String(source[key] || "")).filter(Boolean)]));
      const paths = sources.flatMap((source) => [source.path, source.response_path]).map((value) => String(value || "")).filter(Boolean);
      const message = String(record.message || "");
      const matchesCorrelation = (log) => keys.some((key) => correlations.get(key).includes(String(log[key] || ""))) || paths.includes(String(log.path || log.response_path || ""));
      const matchesFailure = (log) => /error|fail|invalid|reject|timeout/i.test(String(log.event || "")) || String(log.error || log.message || "") === message;
      const failures = diagnosticLog.filter((log) => log.id === record.id || matchesFailure(log) && (matchesCorrelation(log) || String(log.error || log.message || "") === message)).slice(-4);
      const firstFailure = failures[0];
      if (!firstFailure) return [];
      const firstFailureIndex = diagnosticLog.indexOf(firstFailure);
      const request = diagnosticLog.slice(0, firstFailureIndex).reverse().find((log) => log.event === "api_request" && matchesCorrelation(log));
      return request ? [request, ...failures].slice(-5) : failures;
    }
    function errorCause(error) {
      const causes = [];
      let current = error?.cause;
      for (let depth = 0; current && depth < 4; depth += 1) {
        causes.push(current instanceof Error ? { name: current.name, message: current.message, stack: String(current.stack || "").slice(0, 6e3) } : diagnosticValue(current));
        current = current?.cause;
      }
      return causes;
    }
    function compactFields(fields) {
      return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== "" && value !== null && value !== void 0));
    }
    function serviceFailureKind(message, diagnostics = {}) {
      const value = String(message || "request_failed").toLowerCase();
      const detail = String(diagnostics.response_detail || "").toLowerCase();
      const status = Number(diagnostics.http_status) || 0;
      if (HOST_KIND === "web" && status === 404 && ["not_found", "not found"].includes(value)) return "vps_http_not_found";
      if (HOST_KIND === "web" && value === "browser_transport_failed") return "vps_relay_unreachable";
      if (HOST_KIND === "web" && [502, 503, 504].includes(status) && !diagnostics.relay_channel_id && !["runtime_offline", "runtime_unavailable"].includes(value)) return "vps_relay_unreachable";
      if (HOST_KIND === "web" && ["runtime_stopped", "runtime_unavailable"].includes(value) && (value === "runtime_stopped" || detail.includes("runtime_stopped"))) return "local_runtime_stopped";
      if (HOST_KIND === "web" && ["runtime_offline", "runtime_unavailable"].includes(value)) return "local_runtime_disconnected";
      if (HOST_KIND === "web" && value === "relay_stream_interrupted") return "relay_runtime_interrupted";
      if (value.includes("runtime_stopped")) return "local_runtime_stopped";
      return "";
    }
    function serviceFailureLabel(error) {
      const value = error instanceof Error ? error.message : String(error || "request_failed");
      const diagnostics = error?.betterCodexDiagnostics || {};
      const kind = serviceFailureKind(value, diagnostics);
      if (kind === "vps_http_not_found") return t("VPS 入口返回了 404；这表示路径或资源不存在，不能据此判断本机 Runtime 已停止。");
      if (kind === "vps_relay_unreachable" && Number(diagnostics.http_status)) return t("VPS 入口无法连接 Relay 服务。本机 Runtime 状态未知。");
      if (kind === "vps_relay_unreachable") return t("浏览器无法连接 VPS Relay 入口。请检查域名、网络、反向代理和 Relay 服务；本机 Runtime 状态未知。");
      if (kind === "local_runtime_disconnected") return t("VPS Relay 当前没有连接到本机 Runtime。可能是 Runtime 停止、正在重启或网络中断。");
      if (kind === "local_runtime_stopped" && HOST_KIND === "web") return t("本机 Runtime 已主动断开与 VPS Relay 的连接，可能正在重启或已停止。");
      if (kind === "local_runtime_stopped") return t("Better Codex Runtime 已停止。请重新启动后重试。");
      if (kind === "relay_runtime_interrupted") return t("VPS Relay 与本机 Runtime 的请求通道已中断，请等待重连后重试。");
      return "";
    }
    function compactErrorRecord(record) {
      const context = record.context || {};
      const diagnostics = record.diagnostics || {};
      const traceId = String(context.trace_id || diagnostics.trace_id || "");
      const source = String(context.source || diagnostics.source || "application");
      const boundary = serviceFailureKind(record.message, diagnostics);
      const stage = record.message === "browser_transport_failed" ? "browser_transport" : diagnostics.relay_channel_id ? "relay_runtime_transport" : source === "api" || diagnostics.source === "web_host_request" ? "runtime_request" : source;
      const outcome = boundary === "vps_http_not_found" ? "resource_not_found" : boundary === "vps_relay_unreachable" ? "relay_unreachable" : boundary === "local_runtime_disconnected" ? "runtime_not_connected" : boundary === "local_runtime_stopped" ? "runtime_disconnected_intentionally" : diagnostics.relay_request_ended === true && diagnostics.relay_response_started !== true ? "request_sent_result_unknown" : diagnostics.relay_response_started === true ? "response_started" : record.message === "runtime_offline" ? "request_not_forwarded" : "request_failed";
      const checks = {
        browser_transport_failed: "browser_network_and_relay_health",
        relay_stream_interrupted: "request_receipt_and_relay_connection",
        runtime_socket_closed: "request_receipt_and_relay_connection",
        runtime_offline: "runtime_process_and_relay_connection",
        runtime_bridge_timeout: "runtime_health_and_request_receipt"
      };
      const timeline = Array.isArray(record.related_logs) ? record.related_logs : [];
      const lastCheckpoint = timeline.filter((entry2) => entry2.event !== "error_reported").at(-1)?.event || "";
      const report = {
        time: record.time,
        error: compactFields({ code: record.message, message: record.display_message, type: record.name, category: record.category }),
        diagnosis: compactFields({ category: record.category, boundary, stage, outcome, last_checkpoint: lastCheckpoint, next_check: checks[record.message] || "matching_trace_timeline" }),
        trace: compactFields({ trace_id: traceId, command_id: context.command_id || diagnostics.command_id, request_id: diagnostics.response_request_id || context.request_id, channel_id: diagnostics.relay_channel_id, connection_epoch: diagnostics.relay_connection_epoch, runtime_instance_id: diagnostics.relay_runtime_instance_id }),
        request: compactFields({ method: context.method || diagnostics.method, path: context.path || diagnostics.path, http_status: diagnostics.http_status, elapsed_ms: context.elapsed_ms || diagnostics.elapsed_ms, attempt_count: diagnostics.attempt_count, request_ended: diagnostics.relay_request_ended, response_started: diagnostics.relay_response_started, replay_attempts: diagnostics.relay_replay_attempts }),
        timeline,
        occurrences: record.occurrences
      };
      if (source === "update_details" || source === "remote_update_details") report.update = diagnosticValue(context.update || compactFields({ update_id: context.update_id, phase: context.phase, actual_version: context.actual_version, target_version: context.target_version, recovery: context.recovery, desktop: context.desktop, error_details: context.details }));
      if (source === "window_error") report.browser_event = compactFields({ filename: context.filename, line: context.line, column: context.column, error_present: context.error_present, trusted: context.trusted });
      if (["window_error", "unhandled_rejection"].includes(source) && record.stack) report.stack = String(record.stack).split("\n").slice(0, 8).join("\n");
      return report;
    }
    function formatErrorReport(records) {
      return JSON.stringify({
        report: "Better Codex error report",
        exported_at: (/* @__PURE__ */ new Date()).toISOString(),
        errors: records.map(compactErrorRecord)
      }, null, 2);
    }
    function renderErrorDialog() {
      if (!errorDialog?.isConnected || !errorQueue.length) return;
      errorQueueIndex = Math.max(0, Math.min(errorQueueIndex, errorQueue.length - 1));
      const record = errorQueue[errorQueueIndex];
      errorDialog.querySelector("[data-error-report-message]").textContent = record.display_message;
      errorDialog.querySelector("[data-error-report-time]").textContent = new Date(record.time).toLocaleString(state.locale === "zh-CN" ? "zh-CN" : "en-US");
      errorDialog.querySelector("[data-error-report-counter]").textContent = String(errorQueueIndex + 1) + " / " + String(errorQueue.length);
      errorDialog.querySelector("[data-error-report-detail]").textContent = formatErrorReport([record]);
      errorDialog.querySelector("[data-error-report-previous]").disabled = errorQueueIndex === 0;
      errorDialog.querySelector("[data-error-report-next]").disabled = errorQueueIndex >= errorQueue.length - 1;
    }
    function ensureErrorDialog() {
      if (errorDialog?.isConnected) return errorDialog;
      const dialog = document.createElement("dialog");
      dialog.id = "better-codex-error-dialog";
      dialog.setAttribute(OWNED, "true");
      dialog.setAttribute("aria-labelledby", "better-codex-error-report-title");
      dialog.setAttribute("aria-describedby", "better-codex-error-report-description");
      dialog.innerHTML = '<div class="better-codex-error-report-shell"><header class="better-codex-error-report-head"><span class="better-codex-error-report-icon" aria-hidden="true">' + icon("permissionDanger") + '</span><div><h2 id="better-codex-error-report-title">' + te("错误报告") + '</h2><p id="better-codex-error-report-description">' + te("错误信息、请求信息和直接相关日志已保留，可直接复制给开发者。") + '</p></div><button class="better-codex-error-report-close" type="button" data-error-report-close aria-label="' + te("关闭") + '">' + icon("close") + '</button></header><section class="better-codex-error-report-summary"><strong data-error-report-message>' + te("发生了一个错误") + '</strong><span data-error-report-time></span></section><pre class="better-codex-error-report-detail" data-error-report-detail tabindex="0"></pre><footer class="better-codex-error-report-footer"><div class="better-codex-error-report-navigation"><button type="button" data-error-report-previous>' + te("上一条") + '</button><output data-error-report-counter>1 / 1</output><button type="button" data-error-report-next>' + te("下一条") + '</button></div><div class="better-codex-error-report-actions"><button type="button" data-error-report-dismiss>' + te("移除当前错误") + '</button><button type="button" data-error-report-copy-all>' + te("复制全部错误") + '</button><button class="is-primary" type="button" data-error-report-copy>' + te("复制当前错误") + "</button></div></footer></div>";
      const copyRecords = async (button2, records) => {
        const label2 = button2.textContent;
        try {
          await copyText(formatErrorReport(records));
          button2.textContent = t("已复制");
        } catch {
          button2.textContent = t("复制失败");
        }
        setTimeout(() => {
          if (button2.isConnected) button2.textContent = label2;
        }, 1600);
      };
      dialog.querySelector("[data-error-report-close]").addEventListener("click", () => dialog.close());
      dialog.querySelector("[data-error-report-previous]").addEventListener("click", () => {
        errorQueueIndex -= 1;
        renderErrorDialog();
      });
      dialog.querySelector("[data-error-report-next]").addEventListener("click", () => {
        errorQueueIndex += 1;
        renderErrorDialog();
      });
      dialog.querySelector("[data-error-report-copy]").addEventListener("click", (event) => void copyRecords(event.currentTarget, [errorQueue[errorQueueIndex]]));
      dialog.querySelector("[data-error-report-copy-all]").addEventListener("click", (event) => void copyRecords(event.currentTarget, errorQueue));
      dialog.querySelector("[data-error-report-dismiss]").addEventListener("click", () => {
        errorQueue.splice(errorQueueIndex, 1);
        if (!errorQueue.length) return dialog.close();
        errorQueueIndex = Math.min(errorQueueIndex, errorQueue.length - 1);
        renderErrorDialog();
      });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dialog.close();
      });
      bindModalDismiss(dialog, () => dialog.close());
      document.body.appendChild(dialog);
      errorDialog = dialog;
      return dialog;
    }
    function reportGlobalError(error, context = {}) {
      if (destroyed) return null;
      const value = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error?.message || error || "request_failed"));
      if (value.betterCodexReported) return null;
      installStyle();
      try {
        Object.defineProperty(value, "betterCodexReported", { value: true, configurable: true });
      } catch {
      }
      const selected = state.selected;
      const record = {
        id: globalThis.crypto?.randomUUID?.() || "error-" + Date.now() + "-" + Math.random().toString(36).slice(2),
        time: (/* @__PURE__ */ new Date()).toISOString(),
        display_message: errorLabel(value),
        name: value.name || "Error",
        message: value.message || "request_failed",
        category: errorPresentation(value).category,
        stack: String(value.stack || "").slice(0, 12e3),
        causes: errorCause(value),
        context: diagnosticValue({
          source: context.source || "application",
          issue_id: selected?.id || "",
          issue_identifier: selected?.identifier || "",
          ...context
        }),
        diagnostics: diagnosticValue(value.betterCodexDiagnostics || {}),
        environment: {
          core_version: CORE_VERSION,
          compatibility_version: VERSION,
          host: HOST_KIND,
          locale: state.locale,
          path: location.pathname,
          online: navigator.onLine,
          user_agent: navigator.userAgent,
          viewport: String(window.innerWidth) + "x" + String(window.innerHeight)
        },
        related_logs: [],
        occurrences: 1,
        occurrence_times: [(/* @__PURE__ */ new Date()).toISOString()]
      };
      const fingerprint = [record.message, record.context.source || "", record.context.path || "", record.context.update_id || record.context.update?.operation?.id || "", record.diagnostics.response_detail || ""].join("|");
      const repeatedIndex = errorQueue.findIndex((item) => item.fingerprint === fingerprint);
      if (repeatedIndex >= 0) {
        const repeated = errorQueue[repeatedIndex];
        repeated.time = record.time;
        repeated.context = record.context;
        repeated.diagnostics = record.diagnostics;
        repeated.category = record.category;
        repeated.occurrences += 1;
        repeated.occurrence_times.push(record.time);
        if (repeated.occurrence_times.length > 20) repeated.occurrence_times.shift();
        repeated.related_logs = relatedDiagnosticLogs(repeated);
        errorQueueIndex = repeatedIndex;
        const dialog2 = ensureErrorDialog();
        renderErrorDialog();
        if (!dialog2.open) dialog2.showModal();
        return repeated.id;
      }
      record.fingerprint = fingerprint;
      appendDiagnostic("error_reported", { id: record.id, trace_id: record.context.trace_id || record.diagnostics.trace_id || "", update_id: record.context.update_id || record.context.update?.operation?.id || "", message: record.message, category: record.category, source: record.context.source });
      record.related_logs = relatedDiagnosticLogs(record);
      errorQueue.push(record);
      if (errorQueue.length > 50) errorQueue.shift();
      errorQueueIndex = errorQueue.length - 1;
      const dialog = ensureErrorDialog();
      renderErrorDialog();
      if (!dialog.open) dialog.showModal();
      dialog.querySelector("[data-error-report-copy]")?.focus();
      return record.id;
    }
    function onWindowError(event) {
      const context = { source: "window_error", filename: event.filename || "", line: event.lineno || 0, column: event.colno || 0, error_present: event.error != null, trusted: event.isTrusted };
      const message = String(event.message || typeof event.error === "object" && event.error?.message || event.error || "");
      if (/ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(message)) {
        appendDiagnostic("window_diagnostic", { ...context, kind: "resize_observer_delivery", message });
        return;
      }
      reportGlobalError(event.error || event.message, context);
    }
    function onUnhandledRejection(event) {
      reportGlobalError(event.reason, { source: "unhandled_rejection" });
    }
    function onExternalError(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      const error = detail.error instanceof Error ? detail.error : new Error(String(detail.message || detail.error || "request_failed"));
      if (detail.diagnostics) error.betterCodexDiagnostics = detail.diagnostics;
      reportGlobalError(error, { source: detail.source || "host", ...diagnosticValue(detail.context || {}) });
    }
    function errorLabel(error) {
      const value = error instanceof Error ? error.message : String(error || "request_failed");
      if (value === "insufficient_disk_space" || value.startsWith("insufficient_disk_space:")) return t("数据所在磁盘空间不足，请清理空间后重试。");
      const serviceLabel = serviceFailureLabel(error);
      if (serviceLabel) return serviceLabel;
      if (value === "thread_open_timeout" || value === "thread_open_unconfirmed") return t("对话仍在加载，请稍后重试。");
      if (value === "confirmed_charter_required") return t("请先在总纲会话中确认项目总纲，再开始任务规划。");
      if (["invalid_expected_revision", "charter_revision_not_found", "plan_revision_not_found"].includes(value)) return t("项目文档版本已经变化，请刷新后重试。");
      if (value === "charter_confirmation_busy") return t("总纲会话正在运行，请等待回复完成后再确认。");
      if (value === "charter_not_found") return t("暂无可确认的总纲，请先完成总纲内容。");
      if (value === "native_history_read_only") return t("历史会话仅供查看。");
      if (value === "workflow_review_required" || value === "workflow_acceptance_required") return t("请先完成任务验收，再确认完成。");
      if (["workflow_transition_required", "invalid_workflow_transition", "workflow_transition_invalid"].includes(value)) return t("当前任务阶段已变化，请核对任务状态后重试。");
      if (value === "workflow_development_required") return t("请先完成开发并提交开发结果。");
      if (["pending_manual_acceptance_required", "workflow_user_acceptance_required"].includes(value)) return t("仍有人工验收项目待确认，请完成后确认验收通过。");
      if (value === "workflow_evidence_required") return t("请先记录验收结果。");
      if (value === "work_task_required") return t("请在对应任务的工作会话中操作。");
      if (["invalid_item_ids", "plan_item_not_found"].includes(value)) return t("所选任务已发生变化，请重新选择。");
      if (value === "skill_name_and_instructions_required") return t("请填写 Skill 名称和指令。");
      if (value === "skill_slug_conflict") return t("已存在同名 Skill，请修改名称。");
      if (value === "skill_name_conflict") return t("已存在同名 Skill，请修改名称。");
      if (["project_backup_failed", "workflow_backup_failed", "workflow_backup_home_required"].includes(value)) return t("项目资料备份未能完成，本次操作已停止，请稍后重试。");
      if (value === "skill_export_path_conflict") return t("Skill 保存位置已被占用，请调整名称后重试。");
      if (value === "skill_project_root_shared") return t("项目目录与其他项目重叠，请选择独立目录后重试。");
      if (value === "skill_project_required") return t("请选择此 Skill 所属的项目。");
      if (value === "skill_project_mismatch") return t("此 Skill 仅适用于它所属的项目，请重新选择。");
      if (value === "skill_project_not_found") return t("项目目录暂时无法访问，请检查项目设置。");
      if (value === "skill_not_found") return t("此 Skill 已不存在，请重新选择。");
      if (value === "skill_scope_invalid") return t("请选择有效的 Skill 归属。");
      if (value === "skill_source_symlink_forbidden") return t("此 Skill 的资料包含目录链接，请使用完整的本地副本。");
      if (["skill_source_resource_invalid", "skill_source_resources_too_large"].includes(value)) return t("此 Skill 的资料无法完整复制，请检查后重试。");
      if (["skill_resource_modified_conflict", "skill_resource_ownership_conflict"].includes(value)) return t("Skill 的资料已被其他程序修改，请核对后重试。");
      if (["skill_resource_metadata_invalid", "skill_resource_path_invalid", "skill_migration_backup_failed"].includes(value)) return t("Skill 资料暂时无法保存，请稍后重试。");
      if (value === "skill_scope_locked") return t("Skill 的归属不能修改，请创建一个项目专属版本。");
      if (value === "builtin_skill_slug_locked") return t("此 Skill 的调用名称不能修改。");
      if (["invalid_plan", "invalid_plan_item", "invalid_plan_items"].includes(value)) return t("任务规划内容不完整，请在规划会话中补充后重试。");
      if (["explicit_user_confirmation_required", "confirmation_message_mismatch"].includes(value)) return t("请在总纲会话中明确确认当前版本。");
      if (value === "native_start_already_pending") return t("会话正在创建，请稍后重试。");
      if (value === "native_command_outcome_unknown") return t("会话创建结果尚未确认，请先在 Codex 中核对会话后再重试。");
      if (["session_thread_mismatch", "command_project_mismatch", "command_relay_mismatch", "command_turn_mismatch"].includes(value)) return t("会话关联已发生变化，请重新打开后重试。");
      if (["external_skill_read_only", "builtin_skill_delete_forbidden"].includes(value)) return t("此 Skill 只能查看和调用。");
      if (value === "skill_slug_invalid") return t("请使用有效的 Skill 名称。");
      if (value === "thread_id_invalid") return t("对话链接无效。");
      if (value === "issue_execution_running") return t("任务正在执行，请先等待完成。");
      if (value === "issue_enrichment_pending") return t("任务仍在整理中，请稍后再编辑。");
      if (value === "issue_execution_locked") return t("已经执行过对话的 Issue 只能修改状态、优先级和指派人。");
      if (value === "issue_session_handed_off") return t("请前往会话继续对话");
      if (value === "issue_session_starting") return t("原生会话正在创建，请稍后重试。");
      if (value === "manual_start_required") return t("当前为手动运行，请先点击“立即开始任务”。");
      if (value === "backlog_reply_blocked") return t("待规划中的 Issue 不会自动触发任务，请先移出待规划区。");
      if (value === "project_required") return t("无法确定会话所属项目。请先把会话放入一个项目。");
      if (value === "project_operation_running") return t("项目正在运行或生成内容，请等待完成后再删除。");
      if (["codex_state_invalid", "codex_projects_invalid"].includes(value)) return t("Codex 项目清单无法读取，未删除任何内容。");
      if (["codex_project_not_found", "codex_project_ambiguous"].includes(value)) return t("Codex 项目清单中找不到这个项目，未删除任何内容。");
      if (value === "project_delete_rollback_failed") return t("项目删除失败，Codex 项目清单也未能自动恢复，请立即检查 Codex 项目列表。");
      if (value === "issue_description_too_long") return t("任务内容超过长度限制，请缩短内容或作为附件上传。");
      if (value === "browser_transport_failed") return t("网络连接不稳定，正在等待恢复。");
      if (["runtime_response_invalid", "invalid_projects_response", "invalid_issues_response", "invalid_agents_response"].includes(value)) return t("列表数据暂时无法读取，请稍后重试。");
      if (value === "issue_archived") return t("该会话对应的 Issue 已归档，请先取消归档。");
      if (value === "issue_not_archived") return t("该任务尚未归档。");
      if (["native_conversation_busy", "native_operation_busy", "native_outcome_unknown"].includes(value)) return t("会话仍在处理消息，请等待完成后再操作。");
      if (["native_conversation_binding_changed", "native_conversation_unbound", "native_thread_unbound", "native_binding_required"].includes(value)) return t("会话绑定已更新，请重新打开后再试。");
      if (["native_archive_unavailable", "session_host_unavailable", "session_host_timeout", "session_host_thread_action_unavailable", "native_host_mismatch"].includes(value)) return t("暂时无法归档会话，请稍后重试。");
      if (value === "native_conversation_archived") return t("该会话已归档，请选择其他会话。");
      if (["project_planning_busy", "project_planning_agent_locked", "project_planning_unavailable", "project_planning_invalid_output", "project_planning_session_missing"].includes(value)) return projectPlanningErrorLabel(value);
      if (["project_overview_timeout", "project_overview_unavailable", "project_document_invalid_output", "remote_command_timeout", "workspace_missing"].includes(value)) return projectDocumentErrorLabel(value);
      if (value === "version_conflict" || value === "queued_reply_update_conflict") return t("内容刚刚发生变化，请稍后重试。");
      const presentation = errorPresentation(error);
      if (presentation.category === "not_found") return t("相关内容不存在或已被移除。");
      if (presentation.category === "authorization") return t("当前账号没有执行此操作的权限。");
      if (presentation.category === "validation") return t("输入内容不符合要求，请检查后重试。");
      if (presentation.category === "conflict" || presentation.category === "state") return t("当前状态无法完成此操作，请刷新后重试。");
      if (presentation.category === "availability") return t("服务暂时不可用，请稍后重试。");
      if (presentation.category === "protocol") return t("服务返回的数据格式异常，请稍后重试。");
      if (presentation.category === "integrity") return t("数据完整性检查失败，操作已停止。");
      if (presentation.category === "security") return t("安全校验失败，操作已停止。");
      if (presentation.category === "service") return t("服务发生异常，请稍后重试。");
      return /^[a-z0-9_:.-]+$/.test(value) && value.includes("_") ? t("操作未能完成，请稍后重试。") : t(value);
    }
    const availabilityErrorCodes = /* @__PURE__ */ new Set([
      "browser_transport_failed",
      "project_overview_timeout",
      "project_overview_unavailable",
      "project_planning_unavailable",
      "remote_command_timeout",
      "reply_network_error",
      "runtime_bridge_timeout",
      "runtime_bridge_unavailable",
      "runtime_offline",
      "runtime_stopped",
      "runtime_unavailable",
      "thread_open_timeout",
      "thread_open_unconfirmed",
      "update_check_failed"
    ]);
    const stateErrorCodes = /* @__PURE__ */ new Set([
      "backlog_reply_blocked",
      "command_rejected",
      "issue_archived",
      "issue_enrichment_pending",
      "issue_not_startable",
      "issue_session_handed_off",
      "issue_session_starting",
      "manual_start_required",
      "project_document_invalid_output",
      "project_operation_running",
      "project_planning_invalid_output",
      "project_planning_session_missing",
      "project_required",
      "remote_mode_disabled",
      "session_relay_not_leader",
      "thread_id_invalid",
      "workspace_missing"
    ]);
    const validationErrorCodes = /* @__PURE__ */ new Set([
      "body_too_large"
    ]);
    const informationalErrorCodes = /* @__PURE__ */ new Set([
      "hub_update_not_configured",
      "issue_not_running",
      "remote_read_only",
      "update_not_available"
    ]);
    const protocolErrorCodes = /* @__PURE__ */ new Set([
      "invalid_agents_response",
      "invalid_directory_response",
      "invalid_issues_response",
      "invalid_profile_response",
      "invalid_projects_response",
      "runtime_response_invalid",
      "update_not_accepted"
    ]);
    const integrityErrorCodes = /* @__PURE__ */ new Set([
      "compatibility_activation_version_mismatch",
      "compatibility_manifest_mismatch",
      "core_activation_version_mismatch",
      "core_health_validation_failed",
      "core_validation_failed",
      "core_version_mismatch",
      "database_integrity_check_failed",
      "project_delete_rollback_failed",
      "runtime_restart_timeout",
      "update_activation_interrupted",
      "update_asset_invalid",
      "update_compatibility_invalid",
      "update_core_invalid",
      "update_manifest_invalid",
      "update_runtime_stop_timeout"
    ]);
    const securityErrorCodes = /* @__PURE__ */ new Set([
      "update_hash_invalid",
      "update_hash_mismatch",
      "update_https_required",
      "update_public_key_unavailable",
      "update_signature_invalid"
    ]);
    function errorPresentation(error, context = {}) {
      const code = String(error instanceof Error ? error.message : error || "request_failed");
      const lowered = code.toLowerCase();
      const status = Number(error?.betterCodexDiagnostics?.http_status || 0);
      if (context.source === "conversation" && context.origin === "turn") return { category: "conversation", tone: "warning", report: false };
      if (availabilityErrorCodes.has(code) || transientNetworkError(error) || ["runtime_fetch_failed", "relay_stream_interrupted"].includes(code) || code.startsWith("runtime_fetch_failed:") || code.startsWith("update_http_") || ["network", "econn", "enotfound", "dns", "socket"].some((marker) => lowered.includes(marker))) return { category: "availability", tone: "warning", report: false };
      if (securityErrorCodes.has(code)) return { category: "security", tone: "danger", report: true };
      if (integrityErrorCodes.has(code) || code.startsWith("update_activation_failed:")) return { category: "integrity", tone: "danger", report: true };
      if (protocolErrorCodes.has(code)) return { category: "protocol", tone: "danger", report: true };
      if (code === "insufficient_disk_space" || code.startsWith("insufficient_disk_space:")) return { category: "service", tone: "warning", report: true };
      if (code === "database_unavailable") return { category: "service", tone: "danger", report: true };
      if (validationErrorCodes.has(code) || code.startsWith("native_command_argument_required:") || code.endsWith("_value_invalid") || code === "native_command_invalid" || code.startsWith("请选择") || code.startsWith("图片") || code.startsWith("最多传输") || code.startsWith("当前环境无法") || code.startsWith("创建智能体 Issue 需要本地工作区") || code.startsWith("展示")) return { category: "validation", tone: "danger", report: false };
      if (informationalErrorCodes.has(code)) return { category: "state", tone: "info", report: false };
      if (code.endsWith("_not_found") || status === 404) return { category: "not_found", tone: "info", report: false };
      if (code === "unauthorized" || code === "forbidden" || status === 401 || status === 403) return { category: "authorization", tone: "warning", report: false };
      if (code.endsWith("_conflict") || code.endsWith("_busy") || code.endsWith("_locked") || code.endsWith("_running") || code.endsWith("_in_progress") || status === 409) return { category: "conflict", tone: "warning", report: false };
      if (stateErrorCodes.has(code) || code.endsWith("_pending") || code.endsWith("_starting") || code.endsWith("_handed_off")) return { category: "state", tone: "warning", report: false };
      if (status === 400 || status === 413 || status === 422) return { category: "validation", tone: "danger", report: false };
      if (status >= 400 && status < 500) return { category: "state", tone: "warning", report: false };
      if (status >= 500) return { category: "service", tone: "danger", report: true };
      return { category: "unexpected", tone: "danger", report: true };
    }
    function reportUnexpectedError(error, context = {}) {
      const presentation = errorPresentation(error, context);
      const allowReport = context.report !== false;
      const reportContext = { ...context };
      delete reportContext.report;
      if (allowReport && presentation.report) reportGlobalError(error, reportContext);
      else appendDiagnostic("user_feedback", { category: presentation.category, tone: presentation.tone, message: error instanceof Error ? error.message : String(error || "request_failed"), source: reportContext.source || "ui_action", action: reportContext.action || "", origin: reportContext.origin || "" });
      return { ...presentation, report: allowReport && presentation.report };
    }
    function presentInlineError(output, error, message, context = {}) {
      const presentation = reportUnexpectedError(error, context);
      if (!output) return presentation;
      output.dataset.tone = presentation.tone;
      output.textContent = message || errorLabel(error);
      output.hidden = false;
      return presentation;
    }
    function reportReconciledContentConflict(error, context = {}) {
      appendDiagnostic("user_feedback", {
        category: "conflict",
        tone: "info",
        message: "content_conflict_reconciled",
        source: context.source || "ui_action",
        action: context.action || "",
        origin: context.origin || "",
        issue_id: context.issue_id || "",
        command_id: context.command_id || "",
        request_id: context.request_id || "",
        ...contentConflictCorrelation(error)
      });
      return { category: "conflict", tone: "info", report: false };
    }
    function presentReconciledContentConflict(output, error, context = {}) {
      const presentation = reportReconciledContentConflict(error, context);
      if (!output) return presentation;
      output.dataset.tone = presentation.tone;
      output.textContent = t("内容刚刚发生变化，已同步最新状态，请重试本次操作。");
      output.hidden = false;
      return presentation;
    }
    Object.assign(localeResources.en, {
      "升级完成": "Update complete",
      "已恢复旧版": "Previous version restored",
      "恢复未完成": "Recovery incomplete",
      "服务已更新，主窗口可用后会自动连接。": "The service is updated. The main window will reconnect when available.",
      "旧版已启动并通过服务检查，可以继续使用。": "The previous version is running and has passed readiness checks.",
      "自动恢复未能完成，请查看详情处理。": "Automatic recovery could not finish. Open details to resolve it.",
      "服务已升级，桌面连接需要处理": "Service updated; desktop connection needs attention",
      "服务可以继续使用。请查看桌面连接失败的原因。": "The service is available. Open details to resolve the desktop connection.",
      "正在启动旧版、重连会话并验证服务状态。": "Starting the previous version, reconnecting sessions, and verifying readiness.",
      "升级未能完成，请查看原因后重试。": "The update could not finish. Check the details before retrying.",
      "正在确认升级结果": "Confirming update status",
      "暂时无法连接服务，恢复连接后会继续确认本次升级。": "The service is temporarily unreachable. This update will be checked again after reconnecting.",
      "正在重连会话并验证服务状态。": "Reconnecting sessions and verifying readiness.",
      "正在后台下载并校验新版本，可以继续使用。": "Downloading and verifying the update in the background.",
      "继续检查": "Continue checking",
      "重试升级": "Retry update",
      "查看详情": "View details"
    });
    function updateErrorLabel(error) {
      let value = error instanceof Error ? error.message : String(error || "update_install_failed");
      if (value.startsWith("update_activation_failed:")) value = value.slice("update_activation_failed:".length);
      if (value === "reply_busy" || value === "issue_execution_running") return t("有任务正在运行，请等待任务结束后再更新。");
      if (value === "update_in_progress") return t("更新正在进行中，请稍候。");
      if (value === "hub_update_not_configured") return t("当前部署尚未启用在线升级。");
      if (value === "update_storage_reserve" || value.startsWith("update_storage_reserve:")) return t("服务器磁盘空间不足，请清理空间后重试升级（至少保留 5 GiB 和 5% 可用空间）。");
      if (value === "core_version_mismatch" || value === "compatibility_manifest_mismatch") return t("下载的更新版本与发布版本不一致，请稍后重试。");
      if (value === "core_validation_failed" || value === "core_health_validation_failed" || value === "update_asset_invalid" || value === "update_manifest_invalid" || value === "update_compatibility_invalid" || value === "update_core_invalid") return t("更新包验证失败，已保留当前版本。");
      if (value === "core_activation_version_mismatch" || value === "compatibility_activation_version_mismatch") return t("更新后的版本验证失败。");
      if (value === "update_runtime_stop_timeout" || value === "runtime_restart_timeout") return t("Better Codex 重启超时。");
      if (value.startsWith("update_http_") || value === "update_check_failed") return t("无法下载更新，请检查网络后重试。");
      if (value === "update_public_key_unavailable" || value === "update_https_required" || value === "update_hash_invalid" || value === "update_hash_mismatch" || value === "update_signature_invalid") return t("更新包安全校验失败，已保留当前版本。");
      if (value === "update_activation_interrupted") return t("更新进程意外中断。");
      return t("更新失败，请稍后重试。");
    }
    function showError(error) {
      if (destroyed) return;
      passiveNetworkErrorVisible = false;
      const presentation = reportUnexpectedError(error, { source: "ui_action" });
      state.error = errorLabel(error);
      if (inlineConversation) renderInlineConversation();
      const output = panel?.querySelector("#better-codex-error");
      if (output) {
        output.dataset.tone = presentation.tone;
        output.textContent = state.error;
        output.hidden = false;
      }
    }
    function showReconciledContentConflict(error) {
      if (destroyed) return;
      passiveNetworkErrorVisible = false;
      state.error = t("内容刚刚发生变化，已同步最新状态，请重试本次操作。");
      if (inlineConversation) renderInlineConversation();
      presentReconciledContentConflict(panel?.querySelector("#better-codex-error"), error, { source: "ui_action" });
    }
    function showPassiveNetworkError() {
      if (state.error && !passiveNetworkErrorVisible) return;
      passiveNetworkErrorVisible = true;
      state.error = t("网络连接不稳定，正在等待恢复。");
      if (inlineConversation) renderInlineConversation();
      const output = panel?.querySelector("#better-codex-error");
      if (output) {
        output.dataset.tone = "warning";
        output.textContent = state.error;
        output.hidden = false;
      }
    }
    function clearPassiveNetworkError() {
      if (!passiveNetworkErrorVisible) return;
      clearError();
    }
    function clearError() {
      passiveNetworkErrorVisible = false;
      state.error = "";
      if (inlineConversation) renderInlineConversation();
      const output = panel?.querySelector("#better-codex-error");
      if (output) {
        delete output.dataset.tone;
        output.textContent = "";
        output.hidden = true;
      }
    }
    function needsServiceRecovery(error) {
      const value = error instanceof Error ? error.message : String(error || "");
      return ["invalid_bridge_request", "runtime_bridge_unavailable", "runtime_bridge_timeout", "runtime_unavailable"].includes(value);
    }
    async function copyServiceRestartCommand(event) {
      const button = event.currentTarget;
      await copyText("better-codex service restart");
      if (!button?.isConnected) return;
      button.textContent = t("已复制");
      setTimeout(() => {
        if (button.isConnected) button.textContent = t("复制重启命令");
      }, 1600);
    }
    function showServiceRecovery(error) {
      if (!panel) return;
      clearError();
      panel.dataset.recovery = "true";
      const recovery = panel.querySelector("#better-codex-recovery");
      const detail = recovery?.querySelector("[data-recovery-error]");
      const retry = recovery?.querySelector("[data-recovery-retry]");
      if (detail) detail.textContent = error instanceof Error ? error.message : String(error || "runtime_unavailable");
      if (retry) {
        retry.disabled = false;
        retry.innerHTML = icon("refresh") + "<span>" + te("重新连接") + "</span>";
      }
      if (recovery) recovery.hidden = false;
    }
    function hideServiceRecovery() {
      if (!panel) return;
      delete panel.dataset.recovery;
      const recovery = panel.querySelector("#better-codex-recovery");
      if (recovery) recovery.hidden = true;
    }
    function syncCompletionNoticePosition() {
      if (!completionNoticeStack?.isConnected) return;
      const updateOffset = updateNotice?.isConnected ? updateNotice.getBoundingClientRect().height + 24 : 16;
      completionNoticeStack.style.bottom = updateOffset + "px";
    }
    function dismissUpdate(version) {
      dismissedUpdateVersion = version;
      sessionStorage.setItem("better-codex-dismissed-update", version);
      updateNoticeResizeObserver?.disconnect();
      updateNoticeResizeObserver = null;
      updateNotice?.remove();
      updateNotice = null;
      syncCompletionNoticePosition();
    }
    function ignoreUpdate(version) {
      ignoredUpdateVersion = version;
      localStorage.setItem("better-codex-ignored-update", version);
      updateNoticeResizeObserver?.disconnect();
      updateNoticeResizeObserver = null;
      updateNotice?.remove();
      updateNotice = null;
      syncCompletionNoticePosition();
    }
    const runtimeUpdateObserver = createUpdateObserver({ storage: localStorage, namespace: "better-codex-runtime-update", request: (suffix, options) => api(runtimeUpdatePath(suffix), options), stopped: () => destroyed, transient: transientNetworkError, diagnostic: (event) => appendDiagnostic("update_observed", event) });
    const vpsUpdateObserver = createUpdateObserver({ storage: localStorage, namespace: "better-codex-vps-update", request: (suffix, options) => api("/api/update" + suffix, options), stopped: () => destroyed, transient: transientNetworkError, diagnostic: (event) => appendDiagnostic("update_observed", event) });
    const legacyUpdateId = localStorage.getItem("better-codex-active-update-id");
    if (legacyUpdateId && !runtimeUpdateObserver.pending()) localStorage.setItem("better-codex-runtime-update-request", JSON.stringify({ id: legacyUpdateId, key: localStorage.getItem("better-codex-update-request-key") || legacyUpdateId, target: "" }));
    function updateCopy(update) {
      const outcome = updateOutcome(update);
      const phase = String(update.operation?.status || "");
      if (outcome === "completed" && update.desktop?.state === "failed") return ["服务已升级，桌面连接需要处理", "服务可以继续使用。请查看桌面连接失败的原因。"];
      if (outcome === "completed") return ["升级完成", update.desktop?.state === "waiting_window" ? "服务已更新，主窗口可用后会自动连接。" : "更新已完成。"];
      if (outcome === "rolled_back") return ["已恢复旧版", "旧版已启动并通过服务检查，可以继续使用。"];
      if (outcome === "recovery_failed") return ["恢复未完成", "自动恢复未能完成，请查看详情处理。"];
      if (outcome === "recovering") return ["正在恢复 Better Codex", "正在启动旧版、重连会话并验证服务状态。"];
      if (outcome === "failed") return ["更新未完成", "升级未能完成，请查看原因后重试。"];
      if (outcome === "unknown") return ["正在确认升级结果", "暂时无法连接服务，恢复连接后会继续确认本次升级。"];
      if (["RESTARTING_RUNTIME", "REPLAYING", "RECONCILING", "SERVING_READY"].includes(phase)) return ["正在切换 Better Codex Runtime", "正在重连会话并验证服务状态。"];
      if (["WAITING_FOR_HOST_DRAIN", "HANDOFF_READY"].includes(phase)) return ["正在安全交接会话", "正在等待命令落盘并准备 Runtime 接管，运行中的会话会继续执行。"];
      return ["正在更新 Better Codex", "正在后台下载并校验新版本，可以继续使用。"];
    }
    function renderUpdateNotice(update, force = false) {
      runtimeUpdateObserver.adopt(update);
      let outcome = updateOutcome(update);
      if (runtimeUpdateObserver.pending() && outcome === "idle") outcome = "unknown";
      const version = String(update?.latestVersion || update?.target_version || "");
      const noticeVersion = String(update.operation?.id || runtimeUpdateObserver.pending()?.id || version);
      const desktopFailed = outcome === "completed" && update.desktop?.state === "failed";
      if (outcome === "idle" || outcome === "completed" && !desktopFailed && !runtimeUpdateObserver.pending() && !force) return;
      if (!force && (dismissedUpdateVersion === noticeVersion || ignoredUpdateVersion === noticeVersion || localStorage.getItem("better-codex-dismissed-update-operation") === noticeVersion)) return;
      if (updateNotice?.dataset.version !== noticeVersion) {
        updateNoticeResizeObserver?.disconnect();
        updateNotice?.remove();
        const notice2 = document.createElement("section");
        notice2.id = "better-codex-update-notice";
        notice2.dataset.version = noticeVersion;
        notice2.setAttribute(OWNED, "true");
        notice2.setAttribute("role", "status");
        notice2.setAttribute("aria-live", "polite");
        notice2.innerHTML = '<button class="better-codex-update-menu-toggle" type="button" aria-label="' + escapeHtml2(t("更多操作")) + '" aria-expanded="false" aria-haspopup="menu" data-update-menu-toggle>' + icon("more") + '</button><div class="better-codex-update-menu" data-update-menu hidden><button type="button" role="menuitem" data-update-ignore>' + escapeHtml2(t("忽略当前版本")) + '</button></div><button class="better-codex-update-close" type="button" aria-label="' + escapeHtml2(t("稍后提醒")) + '">' + icon("close") + '</button><div class="better-codex-update-layout"><span class="better-codex-update-icon">' + icon("refresh") + '</span><div class="better-codex-update-copy"><p class="better-codex-update-title"></p><p class="better-codex-update-description"></p><p class="better-codex-update-error" hidden></p></div><div class="better-codex-update-actions"><button class="better-codex-update-button" type="button" data-update-details hidden>' + escapeHtml2(t("查看详情")) + '</button><button class="better-codex-update-button" type="button" data-update-later>' + escapeHtml2(t("稍后")) + '</button><button class="better-codex-update-button is-primary" type="button" data-update-install></button></div></div>';
        updateNotice = notice2;
        document.body.appendChild(notice2);
        updateNoticeResizeObserver = new ResizeObserver(syncCompletionNoticePosition);
        updateNoticeResizeObserver.observe(notice2);
        syncCompletionNoticePosition();
        const menuToggle = notice2.querySelector("[data-update-menu-toggle]");
        const menu = notice2.querySelector("[data-update-menu]");
        const closeMenu = () => menuHandle.update({ onClose: closeMenu, open: false, trigger: menuToggle });
        const menuHandle = adoptMenu(menu, { onClose: closeMenu, open: false, trigger: menuToggle }, componentContext("update-notice", "update-menu:" + noticeVersion));
        registerOwnedComponent(menu, menuHandle);
        menuToggle.addEventListener("click", () => menuHandle.update({ onClose: closeMenu, open: menu.hidden, trigger: menuToggle }));
        menu.querySelector("[data-update-ignore]").addEventListener("click", () => {
          closeMenu();
          ignoreUpdate(notice2.dataset.version);
        });
        const dismiss = () => {
          localStorage.setItem("better-codex-dismissed-update-operation", notice2.dataset.version);
          dismissUpdate(notice2.dataset.version);
        };
        notice2.querySelector(".better-codex-update-close").addEventListener("click", dismiss);
        notice2.querySelector("[data-update-later]").addEventListener("click", dismiss);
      }
      const notice = updateNotice;
      notice.querySelector("[data-update-menu-toggle]").hidden = outcome !== "available";
      const busy = ["updating", "recovering"].includes(outcome);
      const failed = ["failed", "recovery_failed", "rolled_back"].includes(outcome);
      notice.dataset.status = failed ? "install-error" : outcome === "completed" ? "current" : busy || outcome === "unknown" ? "installing" : "available";
      const copy = outcome === "available" ? ["Better Codex 有新版本", "v" + version + " 已可用。Runtime 会安全切换，正在运行的会话会继续执行。"] : updateCopy(outcome === "unknown" ? { status: "unknown" } : update);
      notice.querySelector(".better-codex-update-title").textContent = t(copy[0]);
      notice.querySelector(".better-codex-update-description").textContent = t(copy[1]);
      const error = notice.querySelector(".better-codex-update-error");
      error.hidden = !failed || outcome === "recovery_failed";
      error.textContent = failed ? updateErrorLabel(update.operation?.error_code || update.error) : "";
      const details = notice.querySelector("[data-update-details]");
      details.hidden = !failed && !desktopFailed && !update.requires_action;
      const showDetails = () => reportGlobalError(new Error(String(update.operation?.error_code || update.error || update.desktop?.error || update.desktop?.reason || "update_result_unknown")), { source: "update_details", update_id: update.operation?.id, phase: update.phase, actual_version: update.actual_version || update.currentVersion, target_version: update.target_version, recovery: update.recovery, desktop: update.desktop, details: update.error_details });
      details.onclick = showDetails;
      const install2 = notice.querySelector("[data-update-install]");
      install2.disabled = busy;
      install2.hidden = outcome === "completed" || outcome === "recovery_failed";
      install2.textContent = t(outcome === "recovery_failed" ? "查看详情" : outcome === "unknown" ? "继续检查" : busy ? "正在更新" : failed ? "重试升级" : "立即更新");
      install2.onclick = async () => {
        if (outcome === "recovery_failed") return showDetails();
        install2.disabled = true;
        try {
          if (!runtimeUpdateObserver.pending()) await runtimeUpdateObserver.start(String(update.targetVersion || ""));
          void runtimeUpdateObserver.observe((value) => renderUpdateNotice(value, true)).catch((reason) => renderUpdateNotice({ status: "unknown", error: String(reason) }, true));
        } catch (reason) {
          appendDiagnostic("update_request_failed", { update_id: runtimeUpdateObserver.pending()?.id, error: String(reason) });
          renderUpdateNotice({ status: "unknown", error: String(reason) }, true);
        }
      };
      if (outcome === "completed") {
        localStorage.removeItem("better-codex-active-update-id");
        localStorage.removeItem("better-codex-update-request-key");
        if (!desktopFailed) setTimeout(() => {
          if (updateNotice === notice) dismissUpdate(noticeVersion);
        }, 2500);
      }
      if (runtimeUpdateObserver.pending() && !["completed", "rolled_back", "failed", "recovery_failed"].includes(outcome)) void runtimeUpdateObserver.observe((value) => renderUpdateNotice(value, true)).catch((reason) => {
        appendDiagnostic("update_observation_failed", { error: String(reason) });
        if (updateNotice === notice) {
          notice.querySelector(".better-codex-update-title").textContent = t("正在确认升级结果");
          notice.querySelector(".better-codex-update-description").textContent = t("暂时无法连接服务，恢复连接后会继续确认本次升级。");
          install2.disabled = false;
          install2.textContent = t("继续检查");
        }
      });
    }
    async function checkUpdateNotice() {
      try {
        const pending = runtimeUpdateObserver.pending();
        const suffix = pending?.id ? "?update_id=" + encodeURIComponent(pending.id) : pending ? "?idempotency_key=" + encodeURIComponent(pending.key) : "";
        renderUpdateNotice(await api(runtimeUpdatePath(suffix), { passive: true }));
        clearPassiveNetworkError();
      } catch (error) {
        if (runtimeUpdateObserver.pending()) renderUpdateNotice({ status: "unknown" });
        else if (transientNetworkError(error)) showPassiveNetworkError();
      }
    }
    function completionNoticeSuppressed() {
      return sessionStorage.getItem("better-codex-completion-notice-disabled") === "true";
    }
    function completionNoticeDuration() {
      const duration = Number(localStorage.getItem(COMPLETION_DURATION_KEY) || 5e3);
      return [0, 1e3, 5e3, 1e4].includes(duration) ? duration : 5e3;
    }
    function readCompletionNoticeCache() {
      try {
        const records = JSON.parse(localStorage.getItem(COMPLETION_NOTICE_CACHE_KEY) || "[]");
        if (!Array.isArray(records)) return [];
        return records.filter((record) => record && typeof record.key === "string" && record.issue && typeof record.issue.id === "string" && Number.isFinite(record.createdAt) && [0, 1e3, 5e3, 1e4].includes(record.duration)).map((record) => ({ ...record, issue: completionNoticeSnapshot(record.issue) }));
      } catch {
        return [];
      }
    }
    function writeCompletionNoticeCache(records) {
      try {
        localStorage.setItem(COMPLETION_NOTICE_CACHE_KEY, JSON.stringify(records.slice(-COMPLETION_NOTICE_CACHE_LIMIT)));
      } catch {
      }
    }
    function forgetCompletionNotice(key) {
      writeCompletionNoticeCache(readCompletionNoticeCache().filter((record) => record.key !== key));
    }
    function completionNoticeSnapshot(issue) {
      return {
        id: String(issue?.id || ""),
        identifier: String(issue?.identifier || ""),
        title: String(issue?.title || ""),
        status: String(issue?.status || ""),
        agent_id: typeof issue?.agent_id === "string" ? issue.agent_id : null,
        updated_at: String(issue?.updated_at || "")
      };
    }
    function cacheCompletionNotice(issue, duration) {
      const snapshot = completionNoticeSnapshot(issue);
      const key = snapshot.id + ":" + (snapshot.updated_at || Date.now()) + ":" + snapshot.status;
      const record = { key, issue: snapshot, createdAt: Date.now(), duration };
      const records = readCompletionNoticeCache().filter((item) => item.key !== key);
      records.push(record);
      writeCompletionNoticeCache(records);
      return record;
    }
    function restoreCompletionNotices() {
      const now = Date.now();
      const records = readCompletionNoticeCache().filter((record) => (record.duration === 0 || now - record.createdAt < record.duration) && state.issues.some((issue) => issue.id === record.issue.id));
      writeCompletionNoticeCache(records);
      records.forEach((record) => {
        if (completionNoticeSuppressed() && record.duration !== 0) return;
        const issue = state.issues.find((item) => item.id === record.issue.id);
        if (!issue) return;
        renderSessionEndNotice(issue, record);
      });
    }
    function renderSessionEndNotice(issue, cachedNotice = null) {
      if (!cachedNotice && completionNoticeSuppressed()) return;
      const duration = cachedNotice?.duration ?? completionNoticeDuration();
      const permanent = duration === 0;
      if (cachedNotice && completionNoticeSuppressed() && !permanent) return;
      const cached = cachedNotice || cacheCompletionNotice(issue, duration);
      const remaining = permanent ? 0 : duration - (Date.now() - cached.createdAt);
      if (!permanent && remaining <= 0) {
        forgetCompletionNotice(cached.key);
        return;
      }
      if (completionNoticeStack?.querySelector('[data-notice-key="' + CSS.escape(cached.key) + '"]')) return;
      if (!completionNoticeStack?.isConnected) {
        completionNoticeStack = document.createElement("div");
        completionNoticeStack.id = "better-codex-completion-notices";
        completionNoticeStack.setAttribute(OWNED, "true");
        document.body.appendChild(completionNoticeStack);
      }
      if (completionNoticeStack.children.length >= COMPLETION_NOTICE_CACHE_LIMIT) {
        const oldest = completionNoticeStack.firstElementChild;
        completionNoticeDismissals.get(oldest)?.(false);
      }
      syncCompletionNoticePosition();
      const previousPositions = new Map(Array.from(completionNoticeStack.children, (item) => [item, item.getBoundingClientRect().top]));
      const notice = document.createElement("section");
      notice.className = "better-codex-completion-notice";
      notice.dataset.status = String(issue?.status || "");
      notice.dataset.noticeKey = cached.key;
      notice.dataset.permanent = String(permanent);
      notice.setAttribute(OWNED, "true");
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      const identifier = String(issue?.identifier || "").trim();
      const title = String(issue?.title || "").trim();
      const subject = [identifier, title].filter(Boolean).join(" ");
      const status = t(statusLabels[issue?.status] || String(issue?.status || ""));
      const completionAgent = state.agents.find((agent) => agent.id === issue?.agent_id) || state.agents.find((agent) => agent.is_default) || { name: "Codex", is_default: true };
      notice.innerHTML = '<div class="better-codex-completion-layout">' + agentAvatarMarkup(completionAgent, "better-codex-completion-avatar") + '<p class="better-codex-completion-message">' + escapeHtml2(subject || t("会话已结束")) + '</p><span class="better-codex-completion-status">' + escapeHtml2(status) + '</span></div><button class="better-codex-completion-menu-toggle" type="button" aria-label="' + escapeHtml2(t("更多操作")) + '" aria-expanded="false" aria-haspopup="menu" data-completion-menu-toggle>' + icon("more") + '</button><div class="better-codex-completion-menu" data-completion-menu hidden><button type="button" role="menuitem" data-completion-suppress>' + escapeHtml2(t("本次启动关闭")) + '</button></div><button class="better-codex-completion-close" type="button" aria-label="' + escapeHtml2(t("关闭")) + '">' + icon("close") + "</button>";
      completionNoticeStack.appendChild(notice);
      requestAnimationFrame(() => previousPositions.forEach((top, item) => {
        if (!item.isConnected) return;
        const offset = top - item.getBoundingClientRect().top;
        if (offset) item.animate([{ transform: "translateY(" + offset + "px)" }, { transform: "translateY(0)" }], { duration: 280, easing: "cubic-bezier(.16,1,.3,1)" });
      }));
      const menuToggle = notice.querySelector("[data-completion-menu-toggle]");
      const menu = notice.querySelector("[data-completion-menu]");
      let menuDismiss = null;
      const closeMenu = () => {
        menu.hidden = true;
        menuToggle.setAttribute("aria-expanded", "false");
        if (menuDismiss) document.removeEventListener("pointerdown", menuDismiss, true);
        menuDismiss = null;
      };
      const closeMenuOutside = (event) => {
        if (!menu.contains(event.target) && event.target !== menuToggle) closeMenu();
      };
      menuToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!menu.hidden) return closeMenu();
        menu.hidden = false;
        menuToggle.setAttribute("aria-expanded", "true");
        menuDismiss = closeMenuOutside;
        setTimeout(() => document.addEventListener("pointerdown", closeMenuOutside, true), 0);
      });
      menu.querySelectorAll("[data-completion-suppress]").forEach((button2) => button2.addEventListener("click", () => {
        sessionStorage.setItem("better-codex-completion-notice-disabled", "true");
        closeMenu();
        completionNoticeDismissals.forEach((dismissNotice, currentNotice) => {
          if (currentNotice.dataset.permanent !== "true") dismissNotice(true);
        });
      }));
      const dismiss = (forget = true) => {
        if (!notice.isConnected) return;
        closeMenu();
        const timer = completionNoticeTimers.get(notice);
        if (timer !== void 0) clearTimeout(timer);
        completionNoticeTimers.delete(notice);
        completionNoticeDismissals.delete(notice);
        if (forget) forgetCompletionNotice(cached.key);
        notice.remove();
        if (!completionNoticeDismissals.size) {
          completionNoticeStack?.remove();
          completionNoticeStack = null;
        }
      };
      completionNoticeDismissals.set(notice, dismiss);
      notice.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        dismiss(true);
        void perform(() => openEditor(issue));
      });
      notice.querySelector(".better-codex-completion-close").addEventListener("click", () => dismiss(true));
      if (!permanent) completionNoticeTimers.set(notice, setTimeout(() => dismiss(true), remaining));
    }
    async function perform(action, options = {}) {
      if (!options.background) clearError();
      try {
        const result = await action();
        if (options.background) clearPassiveNetworkError();
        return result;
      } catch (error) {
        if (options.background && transientNetworkError(error)) {
          showPassiveNetworkError();
          return null;
        }
        const reconciliation = options.background ? { error, reconciled: false } : await reconcileSurfaceConflict(error);
        if (reconciliation.reconciled) showReconciledContentConflict(reconciliation.error);
        else showError(reconciliation.error);
        return null;
      }
    }
    function onGlobalShortcut(event) {
      if (!active || !panel || panel.hidden || event.isComposing) return;
      const target = event.target;
      if (target?.closest?.("dialog") || target?.closest?.("input,textarea,select,[contenteditable='true']")) return;
      const shortcut = readCreateIssueShortcut();
      if (!shortcut || shortcutFromKeyboardEvent(event) !== shortcut) return;
      event.preventDefault();
      event.stopPropagation();
      closeCreateMenu();
      void perform(() => createProjectWorkConversation());
    }
    function bindModalDismiss(dialog, dismiss) {
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
        if (outside) dismiss();
      });
    }
    function confirmAction(title, message, confirmLabel = "确认", notice = false) {
      document.getElementById("better-codex-confirm")?.remove();
      return new Promise((resolve) => {
        const content = document.createElement("div");
        const body = document.createElement("div");
        body.className = "better-codex-confirm-body";
        const heading = document.createElement("h2");
        heading.className = "better-codex-confirm-title";
        heading.textContent = t(title);
        const copy = document.createElement("p");
        copy.className = "better-codex-confirm-message";
        copy.textContent = t(message);
        body.append(heading, copy);
        const actions = document.createElement("div");
        actions.className = "better-codex-confirm-actions";
        let settled = false;
        let dialogHandle;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          dialogHandle.destroy();
          resolve(value);
        };
        const cancel = createButton({ label: t("取消"), onPress: () => finish(false), variant: "secondary" }, componentContext("confirmation", "confirm-cancel:" + ++managedButtonSequence));
        cancel.element.dataset.confirmCancel = "true";
        const accept = createButton({ label: t(confirmLabel), onPress: () => finish(true), variant: notice ? "primary" : "danger" }, componentContext("confirmation", "confirm-accept:" + ++managedButtonSequence));
        accept.element.classList.add("better-codex-confirm-primary");
        accept.element.dataset.confirmAccept = "true";
        if (!notice) actions.append(cancel.element);
        actions.append(accept.element);
        content.append(body, actions);
        dialogHandle = createDialog({ accessibleName: t(title), content, initialFocus: accept.element, onRequestClose: () => finish(false) }, componentContext("confirmation", "confirm-dialog:" + ++managedButtonSequence));
        dialogHandle.element.id = "better-codex-confirm";
        dialogHandle.element.setAttribute(OWNED, "true");
        registerOwnedComponent(cancel.element, cancel);
        registerOwnedComponent(accept.element, accept);
        registerOwnedComponent(dialogHandle.element, dialogHandle);
      });
    }
    function openArchiveDialog(scopeProjectId = "") {
      document.getElementById("better-codex-archive-dialog")?.remove();
      const dialog = document.createElement("dialog");
      dialog.id = "better-codex-archive-dialog";
      dialog.setAttribute(OWNED, "true");
      dialog.innerHTML = '<div class="better-codex-archive-shell"><header><h1>' + te("已归档任务") + '</h1><button class="better-codex-archive-delete-all" type="button" data-archive-delete-all>' + icon("trash") + "<span>" + te("全部删除") + '</span></button></header><div class="better-codex-archive-toolbar"><label class="better-codex-archive-search">' + icon("search") + '<input type="search" data-archive-search placeholder="' + te("搜索已归档任务") + '"></label><button class="better-codex-archive-filter better-codex-archive-project-filter" type="button" data-archive-project aria-haspopup="menu" aria-expanded="false">' + icon("folder") + "<span data-archive-project-label>" + te("所有项目") + "</span>" + icon("chevronDown") + '</button></div><div class="better-codex-archive-list" data-archive-list><div class="better-codex-archive-empty">' + te("加载中…") + "</div></div></div>";
      const finish = () => {
        dialog.close();
        dialog.remove();
      };
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish();
      });
      bindModalDismiss(dialog, finish);
      document.body.appendChild(dialog);
      dialog.showModal();
      const search = dialog.querySelector("[data-archive-search]");
      const projectSelect = dialog.querySelector("[data-archive-project]");
      const projectLabelOutput = dialog.querySelector("[data-archive-project-label]");
      let projectId = scopeProjectId;
      let projectOptions = [];
      let archivedIssues = [];
      const collapsedProjects = /* @__PURE__ */ new Set();
      const formatDate = (value) => {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return "";
        if (state.locale !== "zh-CN") return date.toLocaleString();
        return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日，" + date.getHours() + ":" + String(date.getMinutes()).padStart(2, "0");
      };
      const archiveTime = (issue) => {
        const value = Date.parse(issue.archived_at || issue.updated_at || issue.created_at || "");
        return Number.isFinite(value) ? value : 0;
      };
      const render2 = () => {
        const query = String(search.value || "").trim().toLowerCase();
        const visible = archivedIssues.filter((issue) => {
          const text = [issue.identifier, issue.title, issue.description, ...Array.isArray(issue.labels) ? issue.labels : []].join(" ").toLowerCase();
          return (!query || text.includes(query)) && (!projectId || issue.project_id === projectId);
        }).sort((left, right) => archiveTime(right) - archiveTime(left) || String(right.id).localeCompare(String(left.id)));
        const groups = /* @__PURE__ */ new Map();
        visible.forEach((issue) => {
          const key = issue.project_id || "";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(issue);
        });
        const list = dialog.querySelector("[data-archive-list]");
        if (!list) return;
        const content = [...groups.entries()].map(([key, issues]) => {
          const project = state.projects.find((item) => item.id === key);
          const name = projectLabel(project) || t("无项目");
          const collapsed = collapsedProjects.has(key);
          const rows = issues.map((issue) => '<article class="better-codex-archive-row"><div class="better-codex-archive-row-copy"><strong>' + escapeHtml2(issue.title || issue.identifier) + "</strong><span>" + escapeHtml2(formatDate(issue.archived_at || issue.updated_at)) + '</span></div><div class="better-codex-archive-row-actions"><button class="better-codex-archive-trash" type="button" data-archive-delete="' + escapeHtml2(issue.id) + '" data-archive-version="' + escapeHtml2(issue.version) + '" aria-label="' + te("删除已归档聊天") + '" title="' + te("删除已归档聊天") + '">' + icon("trash") + '</button><button class="better-codex-archive-restore" type="button" data-archive-restore="' + escapeHtml2(issue.id) + '" data-archive-version="' + escapeHtml2(issue.version) + '"><span>' + te("取消归档") + "</span></button></div></article>").join("");
          return '<section class="better-codex-archive-group"><div class="better-codex-archive-group-head"><button class="better-codex-archive-project-name" type="button" data-archive-group-toggle="' + escapeHtml2(key) + '" aria-expanded="' + String(!collapsed) + '">' + icon(collapsed ? "folder" : "permissionWorkspace") + "<strong>" + escapeHtml2(name) + '</strong></button><span class="better-codex-archive-project-count">' + te(issues.length + " 个任务") + '</span><button class="better-codex-archive-more" type="button" data-archive-project-more="' + escapeHtml2(key) + '" aria-label="' + te("更多操作") + '" title="' + te("更多操作") + '">' + icon("more") + '</button></div><div class="better-codex-archive-card"' + (collapsed ? " hidden" : "") + ">" + rows + "</div></section>";
        }).join("");
        list.innerHTML = content ? content + '<div class="better-codex-archive-end-spacer" aria-hidden="true"></div>' : '<div class="better-codex-archive-empty">' + te("暂无已归档卡片") + "</div>";
      };
      const load2 = async () => {
        try {
          archivedIssues = await requestList("/api/issues?archived=1" + (scopeProjectId ? "&project_id=" + encodeURIComponent(scopeProjectId) : ""), "issues");
          const projects = projectsByRecentActivity(state.projects.filter((project) => archivedIssues.some((issue) => issue.project_id === project.id)), archivedIssues);
          projectOptions = projects;
          if (scopeProjectId) {
            projectSelect.hidden = true;
            projectLabelOutput.textContent = projectLabel(state.projects.find((project) => project.id === scopeProjectId)) || t("当前项目");
          }
          render2();
        } catch {
          const list = dialog.querySelector("[data-archive-list]");
          if (list) list.innerHTML = '<div class="better-codex-archive-empty">' + te("归档列表加载失败") + "</div>";
        }
      };
      const restoreArchivedIssue = (issue) => {
        if (!archivedIssues.some((item) => item.id === issue.id)) archivedIssues.push(issue);
        if (dialog.isConnected) render2();
      };
      const settleArchivedRemoval = (issue, commandId, attempt = 0) => {
        const delays = [1e3, 2e3, 5e3, 1e4, 3e4, 12e4, 6e5];
        setTimeout(async () => {
          try {
            const result = await api(commandStatusPath(commandId));
            if (result?.queued === true || ["pending", "dispatched", "processing"].includes(result?.status)) return settleArchivedRemoval(issue, commandId, attempt + 1);
            if (["rejected", "conflict", "expired"].includes(result?.status)) restoreArchivedIssue(issue);
          } catch (error) {
            if (error instanceof Error && ["command_not_found", "runtime_offline", "runtime_unavailable", "runtime_bridge_timeout", "relay_stream_interrupted", "request_outcome_unknown"].includes(error.message)) return settleArchivedRemoval(issue, commandId, attempt + 1);
            restoreArchivedIssue(issue);
          }
        }, delays[Math.min(attempt, delays.length - 1)]);
      };
      const deleteArchivedIssue = async (issue) => {
        archivedIssues = archivedIssues.filter((item) => item.id !== issue.id);
        render2();
        try {
          const result = await api("/api/issues/" + encodeURIComponent(issue.id), { method: "DELETE", body: JSON.stringify({ version: Number(issue.version) }) });
          if (result?.queued === true && result.command_id) settleArchivedRemoval(issue, result.command_id);
        } catch (error) {
          restoreArchivedIssue(issue);
          throw error;
        }
      };
      search.addEventListener("input", render2);
      dialog.addEventListener("click", (event) => {
        const projectToggle = event.target.closest("[data-archive-group-toggle]");
        const projectOption = event.target.closest("[data-archive-project-option]");
        const projectMore = event.target.closest("[data-archive-project-more]");
        const projectDeleteAll = event.target.closest("[data-archive-project-delete]");
        const restore = event.target.closest("[data-archive-restore]");
        const remove = event.target.closest("[data-archive-delete]");
        const deleteAll = event.target.closest("[data-archive-delete-all]");
        if (projectToggle) {
          const key = projectToggle.dataset.archiveGroupToggle || "";
          if (collapsedProjects.has(key)) collapsedProjects.delete(key);
          else collapsedProjects.add(key);
          return render2();
        }
        if (projectOption) {
          projectId = projectOption.dataset.archiveProjectOption || "";
          projectLabelOutput.textContent = projectId ? projectOptions.find((project) => project.id === projectId)?.name || t("所有项目") : t("所有项目");
          dialog.querySelector("[data-archive-project-menu]")?.remove();
          projectSelect.setAttribute("aria-expanded", "false");
          return render2();
        }
        if (projectMore) {
          const openMenu = projectMore.nextElementSibling;
          if (openMenu?.matches("[data-archive-project-menu]")) {
            openMenu.remove();
            return;
          }
          dialog.querySelectorAll("[data-archive-project-menu]").forEach((menu2) => menu2.remove());
          search.blur();
          projectMore.focus({ preventScroll: true });
          const menu = document.createElement("div");
          menu.className = "better-codex-archive-project-menu better-codex-archive-group-menu";
          menu.setAttribute("data-archive-project-menu", "true");
          menu.innerHTML = '<button class="is-danger" type="button" data-archive-project-delete="' + escapeHtml2(projectMore.dataset.archiveProjectMore || "") + '">' + icon("trash") + "<span>" + te("删除项目中的全部内容") + "</span></button>";
          projectMore.after(menu);
          return;
        }
        if (event.target.closest("[data-archive-project]")) {
          const openMenu = dialog.querySelector(".better-codex-archive-project-menu:not(.better-codex-archive-group-menu)");
          if (openMenu) {
            openMenu.remove();
            projectSelect.setAttribute("aria-expanded", "false");
            return;
          }
          dialog.querySelectorAll("[data-archive-project-menu]").forEach((menu2) => menu2.remove());
          search.blur();
          projectSelect.focus({ preventScroll: true });
          projectSelect.setAttribute("aria-expanded", "true");
          const menu = document.createElement("div");
          menu.className = "better-codex-archive-project-menu";
          menu.setAttribute("data-archive-project-menu", "true");
          menu.setAttribute("role", "menu");
          menu.innerHTML = '<button type="button" data-archive-project-option="">' + te("所有项目") + "</button>" + projectOptions.map((project) => '<button type="button" data-archive-project-option="' + escapeHtml2(project.id) + '">' + escapeHtml2(projectLabel(project)) + "</button>").join("");
          projectSelect.after(menu);
          return;
        }
        if (projectDeleteAll) {
          const targetProjectId = projectDeleteAll.dataset.archiveProjectDelete || "";
          const targetIssues = archivedIssues.filter((issue) => (issue.project_id || "") === targetProjectId);
          return void confirmAction("删除任务", "确定删除项目中的全部已归档任务吗？", "删除").then((confirmed) => confirmed && perform(async () => {
            for (const issue of targetIssues) await deleteArchivedIssue(issue);
          }));
        }
        if (restore) return void perform(async () => {
          await api("/api/issues/" + encodeURIComponent(restore.dataset.archiveRestore) + "/unarchive", { method: "POST", body: JSON.stringify({ version: Number(restore.dataset.archiveVersion) }) });
          await loadIssues();
          await load2();
        });
        if (remove) return void confirmAction("删除任务", "确定删除任务 “" + remove.dataset.archiveDelete + "” 吗？", "删除").then((confirmed) => confirmed && perform(async () => {
          const issue = archivedIssues.find((item) => item.id === remove.dataset.archiveDelete);
          if (issue) await deleteArchivedIssue(issue);
        }));
        if (deleteAll) return void confirmAction("删除任务", "确定删除所有已归档任务吗？", "删除").then((confirmed) => confirmed && perform(async () => {
          for (const issue of [...archivedIssues]) await deleteArchivedIssue(issue);
        }));
        if (!event.target.closest("[data-archive-project-menu]")) {
          dialog.querySelectorAll("[data-archive-project-menu]").forEach((menu) => menu.remove());
          projectSelect.setAttribute("aria-expanded", "false");
        }
      });
      void load2();
    }
    function codexLogo() {
      return '<img src="' + escapeHtml2(DEFAULT_AGENT_AVATAR_URL) + '" alt="Codex">';
    }
    function betterCodexLogo() {
      return '<img src="' + BETTER_CODEX_LOGO_URL + '" alt="Better Codex">';
    }
    function githubLogo() {
      return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 .7a11.5 11.5 0 00-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18A10.96 10.96 0 0112 6.11c.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0012 .7z"></path></svg>';
    }
    function icon(name, className = "", strokeWidth = "1.7") {
      const definition = LUCIDE_ICONS[name];
      if (!definition) return "";
      const classes = "lucide lucide-" + definition.name + (className ? " " + escapeHtml2(className) : "");
      return '<svg class="' + classes + '" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="' + escapeHtml2(strokeWidth) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + definition.nodes + "</svg>";
    }
    function statusIcon(status) {
      const names = { backlog: "statusBacklog", todo: "statusTodo", in_progress: "statusInProgress", in_review: "statusInReview", done: "statusDone", blocked: "statusBlocked", archive: "archive" };
      const markup = icon(names[status] || "statusTodo", "better-codex-status-icon", "2.35");
      return markup.replace("<svg ", '<svg data-status="' + escapeHtml2(status) + '" ');
    }
    function mockupRunStatusIcon(status) {
      return icon(status === "completed" ? "check" : status === "failed" || status === "interrupted" ? "close" : status === "running" ? "statusInProgress" : "circle", "better-codex-status-icon");
    }
    function priorityIcon(priority) {
      const names = { none: "priorityNone", low: "priorityLow", medium: "priorityMedium", high: "priorityHigh", urgent: "priorityUrgent" };
      const markup = icon(names[priority] || "priorityNone", "better-codex-priority", "2.35");
      return markup.replace("<svg ", '<svg data-priority="' + escapeHtml2(priority) + '" ');
    }
    function timeAgo(value) {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1e3));
      if (seconds < 60) return state.locale === "zh-CN" ? "刚刚" : "Just now";
      const unit = seconds < 3600 ? "minute" : seconds < 86400 ? "hour" : "day";
      const amount = Math.floor(seconds / (unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400));
      if (state.locale !== "zh-CN") return amount + " " + unit + (amount === 1 ? "" : "s") + " ago";
      return amount + (unit === "minute" ? " 分钟前" : unit === "hour" ? " 小时前" : " 天前");
    }
    function issueMatchesFilters(issue) {
      const filters = state.filters;
      if (filters.status.length && !filters.status.includes(issue.status)) return false;
      if (filters.priority.length && !filters.priority.includes(issue.priority)) return false;
      if (filters.project.length && !filters.project.includes(issue.project_id)) return false;
      if (filters.label.length && !filters.label.some((value) => (issue.labels || []).includes(value))) return false;
      if (filters.assignee.length) {
        const assignee = issue.agent_enabled ? issue.agent_id || "codex" : issue.user_assigned ? "user:" + String(issue.assignee_user_id || state.user.id || "default") : "none";
        if (!filters.assignee.includes(assignee)) return false;
      }
      if (filters.creator.length) {
        const creator = issue.creator_user_id ? "user:" + issue.creator_user_id : "unknown";
        if (!filters.creator.includes(creator)) return false;
      }
      if (filters.date.length) {
        const age = Date.now() - new Date(issue.updated_at).getTime();
        if (!filters.date.some((days) => age <= Number(days) * 864e5)) return false;
      }
      return true;
    }
    function closeFilterMenu() {
      panel?.querySelectorAll(".better-codex-filter-menu,.better-codex-filter-submenu").forEach((node) => node.remove());
      if (filterDismiss) document.removeEventListener("click", filterDismiss, true);
      filterDismiss = null;
    }
    function closeCreateMenu(restoreFocus = false) {
      const menu = panel?.querySelector(".better-codex-create-menu");
      const toggle = panel?.querySelector("[data-create-menu-toggle]");
      menu?.remove();
      toggle?.setAttribute("aria-expanded", "false");
      if (createMenuDismiss) {
        document.removeEventListener("pointerdown", createMenuDismiss, true);
        document.removeEventListener("keydown", createMenuDismiss, true);
      }
      createMenuDismiss = null;
      if (restoreFocus) toggle?.focus();
    }
    function openCreateMenu(trigger) {
      if (panel?.querySelector(".better-codex-create-menu")) return closeCreateMenu(true);
      closeFilterMenu();
      const menu = document.createElement("div");
      menu.className = "better-codex-create-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute(OWNED, "true");
      const project = document.createElement("button");
      project.type = "button";
      project.className = "better-codex-create-menu-item";
      project.setAttribute("role", "menuitem");
      project.innerHTML = icon("folder") + "<span>" + escapeHtml2(t("创建新项目")) + "</span>";
      project.addEventListener("click", (event) => {
        event.stopPropagation();
        closeCreateMenu();
        openCreateProjectDialog();
      });
      menu.append(project);
      const workItem = document.createElement("button");
      workItem.type = "button";
      workItem.className = "better-codex-create-menu-item";
      workItem.setAttribute("role", "menuitem");
      workItem.innerHTML = icon("board") + "<span>" + escapeHtml2(t("新建工作项")) + "</span>";
      workItem.addEventListener("click", event => {
        event.stopPropagation();
        closeCreateMenu();
        openEditor(null, "backlog");
      });
      menu.append(workItem);
      trigger.closest(".better-codex-create-split")?.append(menu);
      trigger.setAttribute("aria-expanded", "true");
      createMenuDismiss = (event) => {
        if (event.type === "keydown") {
          if (event.key === "Escape") closeCreateMenu(true);
          return;
        }
        if (!menu.contains(event.target) && !trigger.contains(event.target)) closeCreateMenu();
      };
      setTimeout(() => {
        document.addEventListener("pointerdown", createMenuDismiss, true);
        document.addEventListener("keydown", createMenuDismiss, true);
      }, 0);
    }
    function filterOptions(key) {
      if (key === "status") return Object.entries(statusLabels).map(([value, text]) => ({ value, text: t(text) }));
      if (key === "priority") return Object.entries(priorityLabels).map(([value, text]) => ({ value, text: t(value === "none" ? "无优先级" : text + "优先级") }));
      if (key === "date") return [{ value: "1", text: t("最近 24 小时") }, { value: "7", text: t("最近 7 天") }, { value: "30", text: t("最近 30 天") }];
      if (key === "assignee") return [...state.users.filter((user) => !user.disabled).map((user) => ({ value: "user:" + user.id, text: user.name || user.handle })), { value: "codex", text: "Codex" }, ...state.agents.filter((agent) => !agent.is_default).map((agent) => ({ value: agent.id, text: agentDisplayName(agent) })), { value: "none", text: t("未分配") }];
      if (key === "creator") {
        const creators = new Set(state.issues.map((issue) => issue.creator_user_id).filter(Boolean));
        const users = state.users.filter((user) => creators.has(user.id));
        const knownIds = new Set(users.map((user) => user.id));
        const missing = [...creators].filter((id) => !knownIds.has(id)).map((id) => ({ id, name: t("已停用用户"), initials: "?", color: "var(--bc-color-text-faint)", disabled: true }));
        return [...users, ...missing].map((user) => ({ value: "user:" + user.id, text: user.name || user.handle, user })).concat(state.issues.some((issue) => !issue.creator_user_id) ? [{ value: "unknown", text: t("未知创建人") }] : []);
      }
      if (key === "project") return projectsByRecentActivity(state.projects).map((project) => ({ value: project.id, text: projectLabel(project) }));
      if (key === "label") return [...new Set(state.issues.flatMap((issue) => issue.labels || []))].map((value) => ({ value, text: value }));
      return [];
    }
    function filterOptionIcon(key, value) {
      if (key === "status") return statusIcon(value);
      if (key === "priority") return priorityIcon(value);
      if (key === "assignee") {
        if (value.startsWith("user:")) {
          const user = state.users.find((item) => item.id === value.slice(5)) || state.user;
          return userAvatarMarkup(user, "better-codex-filter-avatar");
        }
        if (value === "none") return '<span class="better-codex-filter-avatar is-fallback">' + icon("user") + "</span>";
        const agent = value === "codex" ? state.agents.find((item) => item.is_default) || { name: "Codex", is_default: true } : state.agents.find((item) => item.id === value);
        return agentAvatarMarkup(agent, "better-codex-filter-avatar");
      }
      if (key === "creator") {
        if (value === "unknown") return '<span class="better-codex-filter-avatar is-fallback">' + icon("userEdit") + "</span>";
        const user = state.users.find((item) => item.id === value.slice(5)) || { name: t("已停用用户"), initials: "?", color: "var(--bc-color-text-faint)", disabled: true };
        return userAvatarMarkup(user, "better-codex-filter-avatar");
      }
      const names = { date: "calendar", assignee: "user", creator: "userEdit", project: "folder", label: "tag" };
      return icon(names[key] || "circle");
    }
    function sideMenuPlacement(parentRect, naturalWidth) {
      const inset = 8;
      const gap = 4;
      const availableRight = Math.max(0, window.innerWidth - inset - parentRect.right - gap);
      const availableLeft = Math.max(0, parentRect.left - inset - gap);
      const openRight = naturalWidth <= availableRight || naturalWidth > availableLeft && availableRight >= availableLeft;
      const availableWidth = openRight ? availableRight : availableLeft;
      const width = Math.min(naturalWidth, availableWidth);
      return {
        constrained: naturalWidth > availableWidth,
        openRight,
        width
      };
    }
    function openFilterMenu(trigger) {
      if (panel?.querySelector(".better-codex-filter-menu")) return closeFilterMenu();
      closeFilterMenu();
      const categories = [
        { key: "status", text: "状态", icon: "circle" },
        { key: "priority", text: "优先级", icon: "display" },
        { key: "date", text: "日期", icon: "calendar" },
        { key: "assignee", text: "负责人", icon: "user" },
        { key: "creator", text: "创建人", icon: "userEdit" },
        { key: "project", text: "项目", icon: "folder" },
        { key: "label", text: "标签", icon: "tag" }
      ];
      const menu = document.createElement("div");
      menu.className = "better-codex-filter-menu";
      menu.setAttribute(OWNED, "true");
      const submenu = document.createElement("div");
      submenu.className = "better-codex-filter-submenu";
      submenu.setAttribute(OWNED, "true");
      submenu.hidden = true;
      function renderSubmenu(key, row) {
        menu.querySelectorAll(".better-codex-filter-row").forEach((item) => item.classList.toggle("is-active", item.dataset.filterCategory === key));
        const options = filterOptions(key);
        submenu.innerHTML = "";
        submenu.style.top = row.offsetTop + "px";
        if (!options.length) {
          submenu.innerHTML = '<div class="better-codex-filter-row"><span class="better-codex-filter-label">' + escapeHtml2(t("暂无可选项")) + "</span></div>";
        } else {
          for (const option of options) {
            const selected = state.filters[key].includes(option.value);
            const item = document.createElement("button");
            item.type = "button";
            item.className = "better-codex-filter-row";
            item.innerHTML = '<span class="better-codex-filter-visual">' + filterOptionIcon(key, option.value) + '</span><span class="better-codex-filter-label">' + escapeHtml2(option.text) + '</span><span class="better-codex-filter-check">' + (selected ? icon("check") : "") + "</span>";
            item.addEventListener("click", (event) => {
              event.stopPropagation();
              const values = state.filters[key];
              state.filters[key] = values.includes(option.value) ? values.filter((value) => value !== option.value) : [...values, option.value];
              render();
              renderSubmenu(key, row);
            });
            submenu.appendChild(item);
          }
        }
        submenu.hidden = false;
        submenu.style.right = "auto";
        submenu.style.left = "0px";
        submenu.style.removeProperty("width");
        submenu.style.removeProperty("min-width");
        const menuRect = menu.getBoundingClientRect();
        const placement = sideMenuPlacement(menuRect, submenu.getBoundingClientRect().width);
        if (placement.constrained) {
          submenu.style.minWidth = "0px";
          submenu.style.width = placement.width + "px";
        }
        submenu.style.left = placement.openRight ? "calc(100% + var(--bc-space-1))" : "auto";
        submenu.style.right = placement.openRight ? "auto" : "calc(100% + var(--bc-space-1))";
      }
      for (const category of categories) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "better-codex-filter-row";
        row.dataset.filterCategory = category.key;
        const count = state.filters[category.key].length;
        row.innerHTML = icon(category.icon) + '<span class="better-codex-filter-label">' + escapeHtml2(t(category.text)) + "</span>" + (count ? '<span class="better-codex-filter-count">' + count + "</span>" : "") + '<span class="better-codex-filter-chevron">' + icon("chevron") + "</span>";
        row.addEventListener("mouseenter", () => renderSubmenu(category.key, row));
        row.addEventListener("click", (event) => {
          event.stopPropagation();
          renderSubmenu(category.key, row);
        });
        menu.appendChild(row);
      }
      if (Object.values(state.filters).some((values) => values.length)) {
        const separator = document.createElement("div");
        separator.className = "better-codex-filter-separator";
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "better-codex-filter-row";
        reset.innerHTML = '<span class="better-codex-filter-label">' + escapeHtml2(t("清除筛选")) + "</span>";
        reset.addEventListener("click", (event) => {
          event.stopPropagation();
          for (const key of Object.keys(state.filters)) state.filters[key] = [];
          render();
          closeFilterMenu();
        });
        menu.append(separator, reset);
      }
      menu.appendChild(submenu);
      trigger.parentElement.appendChild(menu);
      filterDismiss = (event) => {
        if (!menu.contains(event.target) && !submenu.contains(event.target) && !trigger.contains(event.target)) closeFilterMenu();
      };
      setTimeout(() => document.addEventListener("click", filterDismiss, true), 0);
    }
    function closeIssueMenu() {
      issueMenu?.remove();
      issueMenu = null;
      if (issueMenuDismiss) {
        document.removeEventListener("pointerdown", issueMenuDismiss, true);
        document.removeEventListener("keydown", issueMenuDismiss, true);
      }
      issueMenuDismiss = null;
    }
    function positionIssueSubmenus(menu) {
      const inset = 8;
      const viewportHeight = window.innerHeight;
      const menuRect = menu.getBoundingClientRect();
      menu.querySelectorAll(".better-codex-context-submenu").forEach((submenu) => {
        const wrap = submenu.parentElement;
        if (!wrap) return;
        submenu.style.display = "block";
        submenu.style.visibility = "hidden";
        submenu.style.pointerEvents = "none";
        submenu.style.top = "0px";
        submenu.style.right = "auto";
        submenu.style.left = "0px";
        submenu.style.removeProperty("width");
        submenu.style.removeProperty("min-width");
        submenu.removeAttribute("data-constrained");
        const wrapRect = wrap.getBoundingClientRect();
        const naturalWidth = submenu.getBoundingClientRect().width;
        const placement = sideMenuPlacement(menuRect, naturalWidth);
        if (placement.constrained) {
          submenu.style.minWidth = "0px";
          submenu.style.width = placement.width + "px";
          submenu.dataset.constrained = "true";
        }
        const submenuRect = submenu.getBoundingClientRect();
        const maximumTop = Math.max(inset, viewportHeight - submenuRect.height - inset);
        const top = Math.max(inset, Math.min(wrapRect.top - 5, maximumTop));
        submenu.style.left = placement.openRight ? "calc(100% + var(--bc-space-1))" : "auto";
        submenu.style.right = placement.openRight ? "auto" : "calc(100% + var(--bc-space-1))";
        submenu.style.top = top - wrapRect.top + "px";
        submenu.style.removeProperty("display");
        submenu.style.removeProperty("visibility");
        submenu.style.removeProperty("pointer-events");
      });
    }
    async function copyText(value) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          return;
        }
      } catch {
      }
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) throw new Error("clipboard_write_failed");
    }
    async function stopIssueSession(issueId) {
      const updated = await withLatestIssueOnConflict(issueId, (issue) => api("/api/issues/" + encodeURIComponent(issueId) + "/stop", { method: "POST", body: JSON.stringify({ version: issue.version }) }));
      await loadIssues();
      return state.issues.find((issue) => issue.id === issueId) || updated;
    }
    function openIssueMenuAt(card, clientX, clientY) {
      const issue = state.issues.find((item) => item.id === card?.dataset.issueId);
      if (!issue) return;
      closeFilterMenu();
      closeIssueMenu();
      const project = state.projects.find((item) => item.id === issue.project_id);
      const workspacePath = issue.workspace_path || project?.workspace_path || readContext().workspacePath;
      const permissions = issuePermissions(issue);
      const contextLockAttrs = permissions.contextLocked ? ' disabled aria-disabled="true"' : "";
      const contextLockClass = permissions.contextLocked ? " is-disabled" : "";
      const archiveLockAttrs = permissions.archiveLocked ? ' disabled aria-disabled="true"' : "";
      const deleteLockAttrs = permissions.archiveLocked || permissions.executionRunning ? ' disabled aria-disabled="true"' : "";
      const stopItem = permissions.executionRunning ? '<div class="better-codex-context-divider"></div><button class="better-codex-context-item is-danger" type="button" data-context-action="stop">' + icon("stop") + "<span>" + escapeHtml2(t("停止任务")) + "</span></button>" : "";
      const regenerateTitleItem = state.mockup || issue.session_native_owned ? "" : '<div class="better-codex-context-divider"></div><button class="better-codex-context-item" type="button"' + contextLockAttrs + ' data-context-action="regenerate-title">' + icon("sparkles") + "<span>" + escapeHtml2(t("重新生成标题")) + "</span></button>";
      const statusItems = Object.entries(statusLabels).map(([value, text]) => '<button class="better-codex-context-item" type="button"' + contextLockAttrs + ' data-context-action="update" data-context-field="status" data-context-value="' + value + '"><span class="better-codex-context-check">' + (issue.status === value ? icon("check") : "") + "</span>" + statusIcon(value) + "<span>" + escapeHtml2(t(text)) + "</span></button>").join("");
      const priorityItems = Object.entries(priorityLabels).map(([value, text]) => '<button class="better-codex-context-item" type="button"' + contextLockAttrs + ' data-context-action="update" data-context-field="priority" data-context-value="' + value + '"><span class="better-codex-context-check">' + (issue.priority === value ? icon("check") : "") + "</span>" + priorityIcon(value) + "<span>" + escapeHtml2(t(value === "none" ? "无优先级" : text + "优先级")) + "</span></button>").join("");
      const assignedUser = issueUserProfile(issue);
      const noneSelected = !issue.user_assigned && !issue.agent_enabled;
      const contextAssigneeLabel = (name, tags = "") => '<span class="better-codex-context-assignee-label"><span class="better-codex-context-assignee-name">' + escapeHtml2(name) + "</span>" + tags + "</span>";
      const unassignedAvatar = '<span class="better-codex-context-avatar is-fallback">' + icon("user") + "</span>";
      const assigneeItems = [
        '<button class="better-codex-context-item" type="button"' + contextLockAttrs + ' data-context-action="assign" data-assignee-kind="none"><span class="better-codex-context-check">' + (noneSelected ? icon("check") : "") + "</span>" + unassignedAvatar + contextAssigneeLabel(t("未指派")) + "</button>",
        ...state.users.filter((user) => !user.disabled).map((user) => {
          const selected = Boolean(issue.user_assigned) && !issue.agent_enabled && String(assignedUser?.id || "") === String(user.id || "");
          return '<button class="better-codex-context-item" type="button"' + contextLockAttrs + ' data-context-action="assign" data-assignee-kind="user" data-context-user-id="' + escapeHtml2(user.id || "") + '"><span class="better-codex-context-check">' + (selected ? icon("check") : "") + "</span>" + userAvatarMarkup(user, "better-codex-context-avatar") + contextAssigneeLabel(user.name || user.handle || t("协作者")) + "</button>";
        }),
        ...!issue.session_native_owned ? ['<button class="better-codex-context-item" type="button"' + contextLockAttrs + ' data-context-action="assign" data-assignee-kind="agent" data-context-agent-id=""><span class="better-codex-context-check">' + (issue.agent_enabled ? icon("check") : "") + '</span><span class="better-codex-context-avatar">' + icon("bot") + '</span>' + contextAssigneeLabel("Codex") + '</button>'] : []
      ].join("");
      const menu = document.createElement("div");
      menu.id = "better-codex-context-menu";
      menu.setAttribute(OWNED, "true");
      menu.dataset.issueId = issue.id;
      menu.innerHTML = '<div class="better-codex-context-item-wrap' + contextLockClass + '"><button class="better-codex-context-item" type="button"' + contextLockAttrs + ">" + statusIcon(issue.status) + "<span>" + escapeHtml2(t("状态")) + "</span>" + icon("chevron") + '</button><div class="better-codex-context-submenu">' + statusItems + '</div></div><div class="better-codex-context-item-wrap' + contextLockClass + '"><button class="better-codex-context-item" type="button"' + contextLockAttrs + ">" + priorityIcon(issue.priority) + "<span>" + escapeHtml2(t("优先级")) + "</span>" + icon("chevron") + '</button><div class="better-codex-context-submenu">' + priorityItems + '</div></div><div class="better-codex-context-item-wrap' + contextLockClass + '"><button class="better-codex-context-item" type="button"' + contextLockAttrs + ">" + icon("user") + "<span>" + escapeHtml2(t("指定负责人")) + "</span>" + icon("chevron") + '</button><div class="better-codex-context-submenu is-assignee">' + assigneeItems + "</div></div>" + stopItem + (workspacePath ? '<div class="better-codex-context-divider"></div><button class="better-codex-context-item" type="button" data-context-action="copy-workspace">' + icon("folder") + "<span>" + escapeHtml2(t("复制本地 workdir 路径")) + "</span></button>" : "") + regenerateTitleItem + '<div class="better-codex-context-divider"></div><button class="better-codex-context-item" type="button"' + archiveLockAttrs + ' data-context-action="archive">' + icon("archive") + "<span>" + escapeHtml2(t("归档")) + "</span></button>" + (state.mockup ? "" : '<button class="better-codex-context-item is-danger" type="button"' + deleteLockAttrs + ' data-context-action="delete">' + icon("trash") + "<span>" + escapeHtml2(t("删除任务")) + "</span></button>");
      document.body.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8)) + "px";
      positionIssueSubmenus(menu);
      async function assignIssue(kind, agentId = "", userId = "") {
        const current = state.issues.find((candidate) => candidate.id === menu.dataset.issueId);
        if (!current) return closeIssueMenu();
        const alreadyUser = kind === "user" && current.user_assigned && !current.agent_enabled && String(issueUserProfile(current)?.id || "") === userId;
        const alreadyNone = kind === "none" && !current.user_assigned && !current.agent_enabled;
        const alreadyAgent = kind === "agent" && current.agent_enabled && (agentId ? current.agent_id === agentId : !current.agent_id);
        if (alreadyUser || alreadyNone || alreadyAgent) return closeIssueMenu();
        closeIssueMenu();
        await perform(async () => {
          await withLatestIssueOnConflict(current.id, (latest) => {
            const body = kind === "user" ? { version: latest.version, user_assigned: true, assignee_user_id: REMOTE ? userId || null : null, agent_enabled: false, agent_id: "" } : kind === "agent" ? { version: latest.version, user_assigned: false, assignee_user_id: null, agent_enabled: true, agent_id: agentId } : { version: latest.version, user_assigned: false, assignee_user_id: null, agent_enabled: false, agent_id: "" };
            return api("/api/issues/" + encodeURIComponent(current.id), { method: "PATCH", body: JSON.stringify(body) });
          });
          await loadIssues();
        });
      }
      menu.addEventListener("click", (clickEvent) => {
        const item = clickEvent.target.closest("[data-context-action]");
        if (!item || !menu.contains(item)) return;
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        const current = state.issues.find((candidate) => candidate.id === menu.dataset.issueId);
        if (!current) return closeIssueMenu();
        const currentPermissions = issuePermissions(current);
        if (currentPermissions.contextLocked && (item.dataset.contextAction === "update" || item.dataset.contextAction === "assign" || item.dataset.contextAction === "regenerate-title")) return closeIssueMenu();
        if (currentPermissions.archiveLocked && item.dataset.contextAction === "archive") return closeIssueMenu();
        if ((currentPermissions.archiveLocked || currentPermissions.executionRunning) && item.dataset.contextAction === "delete") return closeIssueMenu();
        if (item.dataset.contextAction === "copy-workspace") {
          closeIssueMenu();
          return void perform(() => copyText(workspacePath));
        }
        if (item.dataset.contextAction === "stop") {
          closeIssueMenu();
          return void perform(() => stopIssueSession(current.id));
        }
        if (item.dataset.contextAction === "regenerate-title") {
          closeIssueMenu();
          return void perform(async () => {
            await withLatestIssueOnConflict(current.id, (latest) => api("/api/issues/" + encodeURIComponent(current.id) + "/regenerate-title", { method: "POST", body: JSON.stringify({ version: latest.version }) }));
            await loadIssues();
          });
        }
        if (item.dataset.contextAction === "duplicate") {
          closeIssueMenu();
          return void perform(async () => {
            await api("/api/issues", { method: "POST", body: JSON.stringify({ ...current, title: current.title + " " + t("副本") }) });
            await loadIssues();
          });
        }
        if (item.dataset.contextAction === "archive") {
          closeIssueMenu();
          return void perform(async () => {
            await withLatestIssueOnConflict(current.id, (latest) => api("/api/issues/" + encodeURIComponent(current.id) + "/archive", { method: "POST", body: JSON.stringify({ version: latest.version }) }));
            await loadIssues();
          });
        }
        if (item.dataset.contextAction === "delete") {
          closeIssueMenu();
          return void confirmAction("删除任务", "确定删除任务 “" + current.title + "” 吗？", "删除").then((confirmed) => confirmed && perform(async () => {
            await withLatestIssueOnConflict(current.id, (latest) => api("/api/issues/" + encodeURIComponent(current.id), { method: "DELETE", body: JSON.stringify({ version: latest.version }) }));
            await loadIssues();
          }));
        }
        if (item.dataset.contextAction === "assign") {
          const kind = item.getAttribute("data-assignee-kind") || "";
          const agentId = item.getAttribute("data-context-agent-id") || "";
          const userId = item.getAttribute("data-context-user-id") || "";
          return void assignIssue(kind, agentId, userId);
        }
        const field = item.dataset.contextField;
        const value = item.dataset.contextValue;
        if (!field || !value || current[field] === value) return closeIssueMenu();
        closeIssueMenu();
        void perform(async () => {
          await withLatestIssueOnConflict(current.id, (latest) => api("/api/issues/" + encodeURIComponent(current.id), { method: "PATCH", body: JSON.stringify({ version: latest.version, [field]: value }) }));
          await loadIssues();
        });
      });
      issueMenu = menu;
      issueMenuDismiss = (dismissEvent) => {
        if (dismissEvent.type === "keydown" && dismissEvent.key !== "Escape") return;
        if (dismissEvent.type === "pointerdown" && menu.contains(dismissEvent.target)) return;
        closeIssueMenu();
      };
      setTimeout(() => {
        document.addEventListener("pointerdown", issueMenuDismiss, true);
        document.addEventListener("keydown", issueMenuDismiss, true);
      }, 0);
    }
    function openIssueMenu(event) {
      const card = event.target.closest("[data-issue-id]");
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      openIssueMenuAt(card, event.clientX, event.clientY);
    }
    function resetIssueLongPress() {
      if (issueLongPress?.timer) clearTimeout(issueLongPress.timer);
      issueLongPress = null;
    }
    function onIssueLongPressStart(event) {
      if (event.pointerType !== "touch" || event.isPrimary === false || event.button !== 0) return;
      const card = event.target.closest("[data-issue-id]");
      if (!card) return;
      resetIssueLongPress();
      const press = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, timer: null };
      press.timer = setTimeout(() => {
        if (issueLongPress !== press) return;
        suppressIssueClickUntil = Date.now() + 700;
        openIssueMenuAt(card, press.startX, press.startY);
        resetIssueLongPress();
      }, 500);
      issueLongPress = press;
    }
    function onIssueLongPressMove(event) {
      if (!issueLongPress || event.pointerId !== issueLongPress.pointerId) return;
      const deltaX = event.clientX - issueLongPress.startX;
      const deltaY = event.clientY - issueLongPress.startY;
      if (deltaX * deltaX + deltaY * deltaY > 64) resetIssueLongPress();
    }
    function onIssueLongPressEnd(event) {
      if (!issueLongPress || event.pointerId !== issueLongPress.pointerId) return;
      resetIssueLongPress();
    }
    let isPanningBoard = false;
    let panStartX = 0;
    let panStartScrollLeft = 0;
    let panPointerId = -1;
    let panMoved = false;
    let panActiveBoard = null;
    function onBoardPanStart(event) {
      if (event.button !== 0 || event.pointerType === "touch") return;
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest("[data-issue-id], button, input, textarea, a, select, [role='button'], [data-archive-open], [data-add-status], [data-pin], [data-thread]")) {
        return;
      }
      const board = target.closest(".better-codex-board");
      if (!board || board.scrollWidth <= board.clientWidth) return;
      isPanningBoard = true;
      panActiveBoard = board;
      panStartX = event.clientX;
      panStartScrollLeft = board.scrollLeft;
      panPointerId = event.pointerId;
      panMoved = false;
      event.preventDefault();
      try {
        board.setPointerCapture(event.pointerId);
      } catch {
      }
    }
    function onBoardPanMove(event) {
      if (!isPanningBoard || event.pointerId !== panPointerId || !panActiveBoard) return;
      const dx = event.clientX - panStartX;
      if (Math.abs(dx) > 3) {
        panMoved = true;
        panActiveBoard.classList.add("is-panning");
      }
      panActiveBoard.scrollLeft = panStartScrollLeft - dx;
    }
    function onBoardPanEnd(event) {
      if (!isPanningBoard || event.pointerId !== panPointerId) return;
      isPanningBoard = false;
      const board = panActiveBoard;
      panActiveBoard = null;
      if (board) {
        board.classList.remove("is-panning");
        try {
          board.releasePointerCapture(event.pointerId);
        } catch {
        }
      }
      if (panMoved) {
        suppressIssueClickUntil = Date.now() + 250;
      }
    }
    function inlineConversationKey(context) {
      const target = context?.target || context || {};
      return [target.project_id || "", target.kind || "charter", target.issue_id || ""].join(":") + (target.conversation_id ? ":" + target.conversation_id : "") + (target.history_id ? ":history:" + target.history_id : "");
    }
    function inlineConversationTarget() {
      return inlineConversation?.target || inlineConversation || {};
    }
    function inlineConversationRouteAllowed(pathname = location.pathname, search = location.search) {
      if (!inlineConversation) return false;
      const hostRoute = pathname === "/index.html" ? inlineConversationAdapter?.capture?.()?.route || pathname + search : pathname + search;
      if (typeof inlineConversationAdapter?.ownsRoute === "function" && inlineConversationAdapter.ownsRoute(hostRoute)) return true;
      const target = inlineConversationTarget();
      const threadId = normalizeSessionId(inlineConversation.binding?.thread_id || inlineConversation.thread_id || target.thread_id);
      if (threadId && pathname === NAVIGATION.threadRoutePrefix + encodeURIComponent(threadId)) return true;
      if (inlineConversation.mode === "legacy_busy" || inlineConversation.mode === "handoff_required" || inlineConversationError) return inlineConversation.route === pathname + search || isBetterCodexRoute();
      const projectId = inlineConversation.native_project_id || target.native_project_id;
      if (pathname !== "/projects" || !projectId) return false;
      return new URLSearchParams(search).get("projectId") === projectId;
    }
    function nativeInlineErrorLabel(error) {
      const value = String(error instanceof Error ? error.message : error || "");
      if (value === "task_execution_running") return t("此任务的另一会话正在工作，请等待完成后再发送。你输入的内容已保留。");
      if (value === "charter_confirmation_required" || value === "confirmed_charter_required" || value === "charter_not_confirmed") return t("请先在总纲会话中确认总纲，再进行任务规划。");
      if (value.includes("busy") || value.includes("active_writer")) return t("当前任务仍在运行，请等待完成后再打开会话。");
      if (value.includes("unavailable") || value.includes("unsupported") || value.includes("incompatible")) return t("当前无法打开页内会话，请更新 Codex 后重试。");
      if (value.includes("relay") || value.includes("offline") || value.includes("timeout")) return t("会话暂时无法连接，请稍后重试。");
      if (value.includes("binding") || value.includes("revision") || value.includes("conflict")) return t("会话资料已更新，请重试。你输入的内容已保留。");
      return t("暂时无法打开会话，请重试。");
    }
    function ensureInlineConversationAdapter() {
      if (inlineConversationAdapter) return inlineConversationAdapter;
      const factory = window.BetterCodexNativeConversation;
      if (typeof factory?.create !== "function") throw new Error("native_conversation_adapter_unavailable");
      inlineConversationAdapter = factory.create({
        api, getRelayId: () => relayId, getHostId: () => "local",
        getActiveRoute: () => location.pathname === "/index.html" ? "" : location.pathname + location.search,
        isCurrentContext: (context) => active && Boolean(inlineConversation) && inlineConversationKey(context) === inlineConversationKey(inlineConversation),
        onBound: (result) => {
          const threadId = normalizeSessionId(result?.thread_id || result?.binding?.thread_id || result?.threadId);
          if (threadId) relayThreads.add(threadId);
          const origin = result?.origin_target || result?.target || result?.context?.target || result?.context;
          const conversationId = result?.context?.target?.conversation_id || result?.context?.conversation_id || result?.binding?.conversation_id || origin?.conversation_id;
          if (threadId && state.nativeUnboundThreads?.[threadId]) return;
          if (threadId && origin?.project_id && !origin.history_id && ["charter", "planning", "work"].includes(origin.kind)) {
            state.nativeThreadLinks ||= {};
            state.nativeThreadLinks[threadId] = { thread_id: threadId, host_id: origin.host_id || "local", project_id: origin.project_id, kind: origin.kind, ...(origin.issue_id ? { issue_id: origin.issue_id } : {}), ...(conversationId ? { conversation_id: conversationId } : {}) };
            registerInlineConversationBindings();
          }
          if (!inlineConversation || !origin || inlineConversationKey(origin) !== inlineConversationKey(inlineConversation)) return;
          if (threadId) {
            inlineConversation = { ...inlineConversation, target: { ...inlineConversationTarget(), ...(conversationId ? { conversation_id: conversationId } : {}) }, ...(conversationId ? { conversation_id: conversationId } : {}), binding: { ...inlineConversation.binding, ...(result?.binding || {}), thread_id: threadId }, thread_id: threadId, mode: "thread" };
          }
          inlineConversationError = "";
          renderInlineConversation();
          void perform(() => reloadInlineConversationContext(), { background: true });
        },
        onTurn: () => void perform(() => reloadInlineConversationContext(), { background: true }),
        onNavigateAway: (origin) => {
          if (inlineConversation && inlineConversationKey(origin) === inlineConversationKey(inlineConversation)) close({ resume: true, suppressRoute: false });
        },
        onError: (error, origin) => {
          if (!inlineConversation || origin && inlineConversationKey(origin) !== inlineConversationKey(inlineConversation)) return;
          inlineConversationError = nativeInlineErrorLabel(error);
          appendDiagnostic("native_inline_conversation_failed", { error: error instanceof Error ? error.message : String(error || "native_conversation_failed"), target: inlineConversationKey(inlineConversation) });
          renderInlineConversation();
        }
      });
      return inlineConversationAdapter;
    }
    function registerInlineConversationBindings() {
      if (typeof inlineConversationAdapter?.registerBindings !== "function") return;
      const bindings = Object.values(state.nativeThreadLinks || {}).filter((binding) =>
        binding?.host_id === "local" && normalizeSessionId(binding.thread_id) && !state.nativeUnboundThreads?.[binding.thread_id] && binding.project_id && !binding.archived_at && !binding.history_id && !binding.read_only &&
        ["charter", "planning", "work"].includes(binding.kind) && (binding.kind !== "work" || binding.issue_id)
      ).map((binding) => ({ project_id: binding.project_id, kind: binding.kind, host_id: "local", thread_id: normalizeSessionId(binding.thread_id), ...(binding.issue_id ? { issue_id: binding.issue_id } : {}), ...(binding.conversation_id ? { conversation_id: binding.conversation_id } : {}) }));
      inlineConversationAdapter.registerBindings(bindings);
    }
    function inlineConversationQuery(target) {
      const query = new URLSearchParams({ project_id: target.project_id, kind: target.kind || "charter", relay_id: relayId, host_id: "local" });
      if (target.issue_id) query.set("issue_id", target.issue_id);
      if (target.conversation_id) query.set("conversation_id", target.conversation_id);
      if (target.history_id) query.set("history_id", target.history_id);
      return "/api/native-conversations/context?" + query.toString();
    }
    async function reloadInlineConversationContext(options = {}) {
      if (!inlineConversation) return;
      const request = inlineConversationRequest;
      const key = inlineConversationKey(inlineConversation);
      const target = inlineConversationTarget();
      const response = await api(inlineConversationQuery(target), { passive: options.background !== false });
      if (!inlineConversation || request !== inlineConversationRequest || inlineConversationKey(inlineConversation) !== key) return;
      if (state.nativeUnboundThreads?.[normalizeSessionId(response.thread_id || response.binding?.thread_id)]) return;
      const oldMode = inlineConversation.mode;
      inlineConversation = { ...inlineConversation, ...response, target: { ...target, ...(response.target || {}) } };
      inlineConversation.read_only = response.read_only === true || Boolean(target.history_id) || target.kind === "planning" && response.mode === "thread" && response.planning_available !== true && response.context?.charter?.status !== "confirmed";
      inlineConversationAdapter?.updateContext?.(inlineConversation);
      const projectContext = response.context;
      if (projectContext && target.kind !== "work") {
        state.planningContexts ||= {};
        state.planningContexts[target.project_id] = projectContext;
      }
      if (target.kind === "work" && response.mode === "legacy_busy" && !inlineConversation.history) {
        const history = await api("/api/issues/" + encodeURIComponent(target.issue_id) + "/conversation", { passive: true }).catch(() => null);
        if (inlineConversation && inlineConversationKey(inlineConversation) === key) inlineConversation.history = history?.messages || [];
      }
      if (oldMode === "legacy_busy" && response.mode === "handoff_required") inlineConversationError = "";
      const startedThread = normalizeSessionId(response.thread_id || response.binding?.thread_id);
      if (startedThread && response.mode === "thread" && !inlineConversation.read_only && !target.history_id) {
        state.nativeThreadLinks ||= {};
        state.nativeThreadLinks[startedThread] = { thread_id: startedThread, host_id: response.host_id || "local", ...target };
        registerInlineConversationBindings();
      }
      if (inlineConversation.start_requested && response.mode === "thread" && startedThread && !inlineConversation.read_only && !target.history_id) {
        inlineConversation.start_requested = false;
        const adapter = ensureInlineConversationAdapter();
        if (adapter.getCurrentContext?.()?.thread_id !== startedThread) {
          inlineConversationLoading = true;
          try {
            const opened = await adapter.open(inlineConversation);
            if (opened?.error) throw new Error(opened.error);
          } finally { if (request === inlineConversationRequest) inlineConversationLoading = false; }
        }
      }
      if (target.kind === "work") await loadProjectWorkConversations(target.project_id, { background: true });
      else await loadProjectNativeConversations(target.project_id, { background: true });
      if (!inlineConversation || request !== inlineConversationRequest || inlineConversationKey(inlineConversation) !== key) return;
      renderInlineConversation();
    }
    async function openInlineConversation(target, options = {}) {
      if (!target.project_id) throw new Error("project_required");
      inlineConversationCacheRestoring = false;
      inlineConversationNavigationRequest++;
      const key = inlineConversationKey(target);
      if (inlineConversation && inlineConversationKey(inlineConversation) === key && !options.retry && !options.restore) {
        mountPanel();
        rememberProjectView();
        return { opened: true, mode: inlineConversation.mode };
      }
      const request = ++inlineConversationRequest;
      if (inlineConversation && inlineConversationKey(inlineConversation) !== key) inlineConversationAdapter?.leave?.();
      const returnSurface = inlineConversation?.return_surface || (active && state.surface === "projects" ? "projects" : target.kind === "work" ? "issues" : "projects");
      inlineConversation = { ...target, target: { ...target }, mode: "draft", route: location.pathname + location.search, return_surface: returnSurface, ...(options.restore || {}) };
      inlineConversationLoading = true;
      inlineConversationError = "";
      state.projectDetailId = target.project_id;
      state.projectPage = target.kind === "work" ? "work" : "planning";
      if (target.kind === "work") {
        state.nativeWorkSelections ||= {};
        state.nativeWorkSelections[target.project_id] = { issue_id: target.issue_id, ...(target.conversation_id ? { conversation_id: target.conversation_id } : {}), ...(target.history_id ? { history_id: target.history_id } : {}) };
      }
      state.projectDocumentView = target.kind === "planning" ? "planning" : "charter";
      state.surface = target.kind === "work" ? "issues" : "projects";
      active = true;
      routeSuppressed = false;
      sessionStorage.setItem(RESUME_SURFACE_KEY, state.surface);
      ensureEntry();
      mountPanel();
      renderInlineConversation();
      try {
        await ensureBootstrapReady();
        const response = await api(inlineConversationQuery(target));
        if (destroyed || request !== inlineConversationRequest) return { opened: false, reason: "navigation_changed" };
        inlineConversation = { ...inlineConversation, ...response, target: { ...target, ...(response.target || {}) } };
        const boundThread = normalizeSessionId(response.thread_id || response.binding?.thread_id);
        if (target.kind === "work") state.nativeWorkSelections[target.project_id] = { issue_id: target.issue_id, ...(inlineConversationTarget().conversation_id ? { conversation_id: inlineConversationTarget().conversation_id } : {}), ...(target.history_id ? { history_id: target.history_id } : {}) };
        const planningUnconfirmed = target.kind === "planning" && response.planning_available !== true && response.context?.charter?.status !== "confirmed";
        if (planningUnconfirmed && !boundThread) throw new Error("charter_not_confirmed");
        inlineConversation.read_only = response.read_only === true || Boolean(target.history_id) || planningUnconfirmed;
        if (boundThread) relayThreads.add(boundThread);
        if (response.context && target.kind !== "work") {
          state.planningContexts ||= {};
          state.planningContexts[target.project_id] = response.context;
        }
        if (target.kind === "work") await loadProjectWorkConversations(target.project_id);
        else await loadProjectNativeConversations(target.project_id);
        if (destroyed || request !== inlineConversationRequest) return { opened: false, reason: "navigation_changed" };
        if (response.mode === "legacy_busy" || response.mode === "handoff_required") {
          const history = target.issue_id ? await api("/api/issues/" + encodeURIComponent(target.issue_id) + "/conversation", { passive: true }).catch(() => null) : null;
          if (request === inlineConversationRequest) inlineConversation.history = history?.messages || [];
        } else {
          const adapter = ensureInlineConversationAdapter();
          const result = options.restore ? await adapter.restore(inlineConversation, options.adapterSnapshot) : await adapter.open(inlineConversation);
          if (destroyed || request !== inlineConversationRequest) return { opened: false, reason: "navigation_changed" };
          if (result?.error || result?.mode === "unavailable") throw new Error(result.error || "native_conversation_adapter_unavailable");
          if (result?.mode) inlineConversation.mode = result.mode;
          inlineConversation.route = location.pathname + location.search;
        }
        if (!startLiveUpdates() && pollTimer === null) pollTimer = setInterval(() => {
          if (!document.hidden && active && inlineConversation) void perform(() => reloadInlineConversationContext(), { background: true });
        }, 3e3);
        state.projectResumePending = "";
        rememberProjectView();
        return { opened: true, mode: inlineConversation.mode };
      } catch (error) {
        if (request === inlineConversationRequest) {
          inlineConversationError = nativeInlineErrorLabel(error);
          appendDiagnostic("native_inline_open_failed", { error: error instanceof Error ? error.message : String(error), target: key });
        }
        return { opened: false, reason: "unavailable" };
      } finally {
        if (request === inlineConversationRequest) {
          inlineConversationLoading = false;
          mountPanel();
          renderInlineConversation();
        }
      }
    }
    async function openIssueNativeConversation(issue, conversationId = "") {
      if (!issue) throw new Error("issue_not_found");
      const navigationRequest = ++inlineConversationNavigationRequest;
      const rows = await loadProjectWorkConversations(issue.project_id);
      if (destroyed || navigationRequest !== inlineConversationNavigationRequest) return { opened: false, reason: "navigation_changed" };
      if (!conversationId) {
        const selected = rows.find(row => row.issue_id === issue.id && row.selected && row.conversation_id && !row.history_id) || rows.find(row => row.issue_id === issue.id && row.conversation_id && !row.history_id && row.source !== "history");
        if (selected) conversationId = selected.conversation_id;
        else {
          const context = await api(inlineConversationQuery({ project_id: issue.project_id, issue_id: issue.id, kind: "work" }));
          if (destroyed || navigationRequest !== inlineConversationNavigationRequest) return { opened: false, reason: "navigation_changed" };
          if (context.mode === "draft" && !context.thread_id && !context.binding?.thread_id) return createIssueNativeConversation(issue);
        }
      }
      if (conversationId) {
        const row = rows.find(candidate => candidate.issue_id === issue.id && candidate.conversation_id === conversationId && !candidate.history_id);
        if (!row) throw new Error("native_conversation_not_found");
        if (!row.selected) await api("/api/native-conversations/select", { method: "POST", body: JSON.stringify({ project_id: issue.project_id, kind: "work", issue_id: issue.id, conversation_id: conversationId }) });
        if (destroyed || navigationRequest !== inlineConversationNavigationRequest) return { opened: false, reason: "navigation_changed" };
      }
      return openInlineConversation({ project_id: issue.project_id, issue_id: issue.id, kind: "work", ...(conversationId ? { conversation_id: conversationId } : {}) });
    }
    async function createIssueNativeConversation(issue) {
      if (!issue?.id || !issue.project_id) throw new Error("issue_not_found");
      const navigationRequest = ++inlineConversationNavigationRequest;
      const response = await api("/api/native-conversations/create", { method: "POST", body: JSON.stringify({ project_id: issue.project_id, kind: "work", issue_id: issue.id }) });
      const conversationId = response.conversation?.conversation_id || response.conversation_id;
      if (!conversationId) throw new Error("native_conversation_unavailable");
      if (destroyed || navigationRequest !== inlineConversationNavigationRequest) return { opened: false, reason: "navigation_changed" };
      return openIssueNativeConversation(issue, conversationId);
    }
    async function createProjectWorkConversation(projectId = state.projectDetailId || state.projectId, initialStatus = "backlog") {
      const project = state.projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error("project_required");
      state.nativeWorkCreatePending ||= {};
      if (state.nativeWorkCreatePending[projectId]) return state.nativeWorkCreatePending[projectId];
      const navigationRequest = ++inlineConversationNavigationRequest;
      const requestId = globalThis.crypto?.randomUUID?.() || VERSION + "-native-work-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      state.nativeWorkCreatePending[projectId] = (async () => {
        const response = await api("/api/issues", { method: "POST", body: JSON.stringify({ id: requestId, request_id: requestId, project_id: projectId, title: t("新会话"), description: "", status: initialStatus || "backlog", priority: "none", workspace_path: project.workspace_path || "", native_only: true, ai_enrich: false, agent_enabled: false, agent_id: "" }) });
        const issue = response.issue || response;
        if (!issue?.id) throw new Error("issue_create_failed");
        await loadIssues();
        if (destroyed || navigationRequest !== inlineConversationNavigationRequest) return { opened: false, reason: "navigation_changed" };
        return createIssueNativeConversation(issue);
      })();
      try { return await state.nativeWorkCreatePending[projectId]; }
      finally { delete state.nativeWorkCreatePending[projectId]; }
    }
    async function loadProjectWorkConversations(projectId, options = {}) {
      const result = await api("/api/native-conversations/list?project_id=" + encodeURIComponent(projectId) + "&kind=work", { passive: Boolean(options.background) });
      state.nativeWorkConversations ||= {};
      state.nativeWorkConversations[projectId] = Array.isArray(result.conversations) ? result.conversations.filter(row => row.kind === "work" && row.project_id === projectId && row.issue_id) : [];
      return state.nativeWorkConversations[projectId];
    }
    async function openProjectWorkSession(projectId) {
      const request = ++inlineConversationNavigationRequest;
      const rows = await loadProjectWorkConversations(projectId);
      if (request !== inlineConversationNavigationRequest || destroyed) return { opened: false, reason: "navigation_changed" };
      const selected = state.nativeWorkSelections?.[projectId];
      const row = rows.find(candidate => candidate.issue_id === selected?.issue_id && (candidate.conversation_id || "") === (selected?.conversation_id || "") && (candidate.history_id || "") === (selected?.history_id || "")) || rows.find(candidate => candidate.selected && candidate.source !== "history") || rows.find(candidate => candidate.source === "current") || rows[0];
      if (!row) {
        leaveInlineConversation();
        state.projectPage = "work";
        openRoute("projects", { projectId });
        return { opened: false, reason: "project_has_no_tasks" };
      }
      return row.history_id ? openInlineConversation({ project_id: projectId, kind: "work", issue_id: row.issue_id, ...(row.conversation_id ? { conversation_id: row.conversation_id } : {}), history_id: row.history_id }) : openIssueNativeConversation({ project_id: projectId, id: row.issue_id }, row.conversation_id || "");
    }
    function inlineWorkStateLabel(issue) {
      if (issue?.archived_at) return t("已归档");
      if (issue?.active_run_status === "claimed" || issue?.session_status === "starting") return t("排队中");
      if (issue?.active_run_status === "scheduling") return t("调度中");
      if (issue?.session_status === "waiting_on_approval") return t("等待确认");
      if (issue?.session_status === "waiting_on_user") return t("等待回复");
      if (issue?.session_status === "stopping") return t("正在停止…");
      if (issueExecutionRunning(issue)) return t("工作中");
      return t(statusLabels[issue?.status] || "未开始");
    }
    function workConversationListMarkup() {
      const target = inlineConversationTarget();
      const rows = state.nativeWorkConversations?.[target.project_id] || [];
      const tasks = [...new Map(rows.map(row => [row.issue_id, row])).values()];
      const groups = tasks.map(task => {
        const conversations = rows.filter(row => row.issue_id === task.issue_id).map((row, index) => {
          const historical = Boolean(row.history_id || row.source === "history");
          const selected = row.issue_id === target.issue_id && (row.conversation_id ? row.conversation_id === target.conversation_id : !target.conversation_id) && (row.history_id || "") === (target.history_id || "");
          return '<button type="button" class="bc-planning-conversation-row' + (historical ? ' bc-work-conversation-history' : '') + (selected ? ' is-active' : '') + '" data-work-conversation="' + escapeHtml2(row.issue_id) + '"' + (row.conversation_id ? ' data-work-conversation-id="' + escapeHtml2(row.conversation_id) + '"' : '') + (row.history_id ? ' data-work-history="' + escapeHtml2(row.history_id) + '"' : '') + ' aria-current="' + String(selected) + '"><span>' + icon(historical ? "docs" : "board") + '<strong>' + escapeHtml2(row.conversation_title || row.session_title || t(historical ? "历史会话" : "会话") + " " + (index + 1)) + '</strong></span><small>' + (historical ? escapeHtml2(row.archived_at || row.created_at || "") : escapeHtml2(inlineWorkStateLabel(row)) + ' · ' + te(row.thread_id ? "已有会话" : "草稿")) + '</small></button>';
        }).join("");
        const newConversation = task.archived_at && !rows.some(row => row.issue_id === task.issue_id && !row.history_id && row.source !== "history") ? "" : '<button type="button" class="bc-planning-conversation-row" data-work-create="' + escapeHtml2(task.issue_id) + '"><span>' + icon("plus") + '<strong>' + te("新建会话") + '</strong></span></button>';
        return '<section class="bc-work-conversation-group"><strong>' + escapeHtml2(task.title || t("工作任务")) + '</strong>' + conversations + newConversation + '</section>';
      }).join("");
      return '<header><strong>' + te("工作会话") + '</strong></header><nav aria-label="' + te("项目工作会话") + '">' + (groups || '<div class="better-codex-project-dashboard-empty">' + te("暂无工作任务") + '</div>') + '</nav>';
    }
    function leaveInlineConversation() {
      inlineNativePanelObserver?.disconnect();
      inlineNativePanelObserver = inlineNativePanelNode = null;
      document.querySelectorAll('[data-better-codex-native-preview], [data-better-codex-native-preview-obscured]').forEach(node => { node.removeAttribute('data-better-codex-native-preview'); node.removeAttribute('data-better-codex-native-preview-obscured'); });
      if (!inlineConversation) return;
      rememberProjectView();
      cancelInlineConversationViewportResize();
      inlineConversationRequest++;
      inlineConversationNavigationRequest++;
      inlineConversationAdapter?.leave?.();
      inlineConversation = null;
      inlineConversationLoading = false;
      inlineConversationCacheRestoring = false;
      inlineConversationError = "";
      inlineConversationRoot?.remove();
      inlineConversationRoot = null;
      inlineConversationDetailsMarkup = "";
      inlineConversationHeaderMarkup = "";
      inlineConversationNavigationMarkup = "";
      syncInlineConversationInteraction(false);
      syncPlanningWorkspaceNativeChrome(false);
      panel?.removeAttribute("data-better-codex-inline-shell");
      document.querySelectorAll("[data-better-codex-inline-content]").forEach((node) => { if (node !== projectSurfaceCache?.nativeLayout) node.removeAttribute("data-better-codex-inline-content"); });
      document.querySelectorAll("[data-better-codex-inline-host]").forEach((node) => { if (node === projectSurfaceCache?.nativeSurface) return; node.querySelectorAll("[data-better-codex-native-panel]").forEach(panel => panel.removeAttribute("data-better-codex-native-panel")); node.removeAttribute("data-better-codex-inline-host"); node.style.removeProperty("--bc-inline-details-space"); node.style.removeProperty("--bc-inline-nav-space"); node.style.removeProperty("--bc-inline-native-panel-width"); });
    }
    function workflowActivityState(issue, fallback) {
      if (!issue?.workflow) return fallback;
      return { backlog: "not-started", todo: "not-started", in_progress: "in_progress", in_review: "in_review", blocked: "blocked", done: "completed" }[issue.status] || fallback;
    }
    function inlineTaskAcceptanceMarkup(issue, readOnly = false) {
      const pending = issue.workflow?.pending_manual;
      if (issue.status !== "in_review" || issue.workflow?.result !== "review_passed" || issue.workflow?.evidence_valid === false || !Array.isArray(pending) || !pending.length) return "";
      const disabled = readOnly || Boolean(issue.session_active_turn_id || issue.task_execution_running || issue.active_run_status);
      return '<section class="better-codex-project-plan-section"><header><strong>' + te("待人工验收") + '</strong></header><ul>' + pending.map(item => '<li>' + escapeHtml2(item) + '</li>').join("") + '</ul>' + (readOnly ? "" : '<button type="button" class="better-codex-submit" data-inline-accept-task' + (disabled ? ' disabled' : '') + '>' + te("确认验收通过") + '</button>') + '</section>';
    }
    async function confirmInlineTaskAcceptance(button) {
      if (!inlineConversation || inlineConversation.read_only || inlineConversationTarget().history_id || button.disabled) return;
      const current = inlineConversationTarget();
      const originKey = inlineConversationKey(inlineConversation);
      const issue = inlineConversation.context?.task;
      if (!issue || issue.id !== current.issue_id || issue.workflow?.result !== "review_passed" || issue.workflow?.evidence_valid === false || issue.status !== "in_review") return;
      button.disabled = true;
      try {
        const confirmed = await confirmAction("确认验收通过", "请确认列出的人工验收项目均已通过，确认后任务将进入已完成。", "确认通过");
        if (!confirmed || !inlineConversation || inlineConversationKey(inlineConversation) !== originKey || inlineConversation.read_only) return;
        await api("/api/issues/" + encodeURIComponent(issue.id) + "/workflow", { method: "POST", body: JSON.stringify({ expected_version: issue.version, action: "accept" }) });
        await loadIssues();
        if (inlineConversation && inlineConversationKey(inlineConversation) === originKey) await reloadInlineConversationContext();
      } finally { if (button.isConnected) button.disabled = false; }
    }
    function inlineWorkDetailsMarkup() {
      const target = inlineConversationTarget();
      const context = inlineConversation.context || {};
      const issue = context.task || context.issue || state.issues.find((candidate) => candidate.id === target.issue_id) || state.projectIssues?.find((candidate) => candidate.id === target.issue_id) || {};
      const charter = context.charter;
      const plan = context.plan;
      const planItem = plan?.items?.find((item) => item.id === issue.item_id || item.issue_id === target.issue_id) || plan?.items?.find((item) => plan.issue_links?.some((link) => link.item_id === item.id && link.issue_id === target.issue_id));
      const sections = Array.isArray(charter?.sections) ? charter.sections : Object.values(charter?.sections || {});
      const charterMarkup = charter ? '<details><summary>' + te("引用的项目总纲") + ' · ' + te("版本") + ' ' + escapeHtml2(charter.revision || issue.charter_revision || "") + '</summary>' + sections.map((section) => '<section class="better-codex-project-plan-section"><header><strong>' + escapeHtml2(section.title || section.id || "项目章节") + '</strong></header>' + documentTextMarkup(section.content || section.markdown || section.text) + '</section>').join("") + (charter.markdown ? documentTextMarkup(charter.markdown) : "") + '</details>' : "";
      return '<div class="better-codex-inline-details-body"><h3>' + te("任务资料") + '</h3><strong>' + escapeHtml2(issue.title || t("工作任务")) + '</strong><span class="better-codex-inline-work-state">' + te("任务状态") + ' · ' + escapeHtml2(inlineWorkStateLabel(issue)) + '</span>' + inlineTaskAcceptanceMarkup(issue, inlineConversation.read_only || Boolean(target.history_id)) + '<section class="better-codex-project-plan-section"><header><strong>' + te("任务要求") + '</strong></header>' + documentTextMarkup(issue.description || issue.goal) + '</section>' + issuePlanDetailMarkup(issue) + (planItem ? planItemDetailsMarkup(planItem) + issuePlanDetailMarkup(planItem) : "") + charterMarkup + '</div>';
    }
    function inlineNativeElementVisible(element) {
      if (!(element instanceof HTMLElement) || !element.isConnected) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.getAttribute("data-app-shell-active-page") === "false") return false;
        if (ancestor.hidden || ancestor.inert && !ancestor.hasAttribute("data-better-codex-inline-blocked") || ancestor.getAttribute("aria-hidden") === "true") return false;
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      }
      if (getComputedStyle(element).display === "contents") return Array.from(element.children).some(inlineNativeElementVisible);
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight;
    }
    function syncInlineConversationInteraction(blocked = Boolean(inlineConversation && (inlineConversationLoading || inlineConversationError || ["legacy_busy", "handoff_required"].includes(inlineConversation.mode)))) {
      const desired = new Set();
      const layouts = Array.from(document.querySelectorAll("[data-better-codex-inline-content]")).filter(inlineNativeElementVisible);
      if (blocked) layouts.forEach(layout => desired.add(layout));
      else if (inlineConversation?.read_only) layouts.forEach(layout => {
        layout.querySelectorAll('[data-codex-composer="true"][contenteditable], [contenteditable="true"]').forEach(editor => {
          if (!inlineNativeElementVisible(editor)) return;
          const composer = editor.closest("[data-composer-surface-variant]") || editor.closest("[data-composer-body]") || editor.closest("form") || editor;
          desired.add(composer);
        });
      });
      document.querySelectorAll("[data-better-codex-inline-blocked]").forEach(node => {
        if (desired.has(node)) return;
        node.removeAttribute("data-better-codex-inline-blocked");
        node.inert = false;
      });
      desired.forEach(node => {
        if (!node.inert) {
          node.setAttribute("data-better-codex-inline-blocked", "true");
          node.inert = true;
          if (node.contains(document.activeElement)) document.activeElement?.blur?.();
        }
      });
    }
    function cancelInlineConversationViewportResize() {
      if (inlineConversationResizeFrame !== null) cancelAnimationFrame(inlineConversationResizeFrame);
      inlineConversationResizeFrame = null;
    }
    function onInlineConversationViewportResize() {
      if (destroyed || !inlineConversation || inlineConversationResizeFrame !== null) return;
      inlineConversationResizeFrame = requestAnimationFrame(() => {
        inlineConversationResizeFrame = null;
        if (!destroyed && inlineConversation) renderInlineConversation();
      });
    }
    function inlineConversationUnbindState() {
      const target = inlineConversationTarget();
      const threadId = normalizeSessionId(inlineConversation?.thread_id || inlineConversation?.binding?.thread_id);
      const conversationId = target.conversation_id || inlineConversation?.conversation?.conversation_id;
      const issue = inlineConversation?.context?.task || inlineConversation?.context?.issue;
      const busy = Boolean(inlineConversationLoading || inlineConversation?.pending_operation || inlineConversation?.binding?.active_turn_id || inlineConversation?.conversation?.active_turn_id || ["running", "active", "starting", "stopping", "waiting_on_approval", "waiting_on_user"].some(status => status === inlineConversation?.binding?.status || status === inlineConversation?.conversation?.status) || issueExecutionRunning(issue));
      const pending = Boolean(state.nativeUnbindPending);
      return { target: { ...target, conversation_id: conversationId }, threadId, busy, pending, visible: !READ_ONLY && Boolean(threadId && conversationId && target.project_id && ["charter", "planning", "work"].includes(target.kind) && !target.history_id && !inlineConversation?.history && inlineConversation?.source !== "history" && inlineConversation?.mode === "thread" && !state.nativeUnboundThreads?.[threadId]) };
    }
    function inlineConversationUnbindMarkup() {
      const action = inlineConversationUnbindState();
      if (!action.visible) return "";
      return '<button type="button" data-inline-unbind' + (action.busy || action.pending ? ' disabled' : '') + (action.busy ? ' title="' + te("会话正在运行，请等待完成后再解除绑定。") + '"' : '') + (action.pending ? ' aria-busy="true"' : '') + '>' + te(action.pending ? "正在解除…" : "解除绑定") + '</button>';
    }
    function clearUnboundConversationView(result) {
      const projectId = result.project_id;
      const conversationId = result.unbound_conversation_id;
      const threadId = normalizeSessionId(result.thread_id);
      const view = readProjectView(projectId);
      if (view.conversations?.[result.kind] === conversationId) delete view.conversations[result.kind];
      if (view.target?.conversation_id === conversationId) delete view.target;
      try { localStorage.setItem("better-codex-project-view:" + projectId, JSON.stringify(view)); } catch {}
      if (state.nativeWorkSelections?.[projectId]?.conversation_id === conversationId) delete state.nativeWorkSelections[projectId];
      if (state.nativeConversationSelections?.[projectId] === conversationId) state.nativeConversationSelections[projectId] = result.selected_conversation_id || "";
      for (const name of ["nativeConversations", "nativeWorkConversations"]) if (state[name]?.[projectId]) state[name][projectId] = state[name][projectId].filter(row => row.conversation_id !== conversationId && normalizeSessionId(row.thread_id) !== threadId);
      delete state.planningContexts?.[projectId];
      state.projectResumePending = "";
      try {
        const saved = JSON.parse(sessionStorage.getItem("better-codex-native-return") || "null");
        if (saved?.thread_id === threadId || saved?.conversation_id === conversationId) sessionStorage.removeItem("better-codex-native-return");
        sessionStorage.removeItem(RESUME_SURFACE_KEY);
      } catch {}
    }
    async function unbindInlineConversation(button) {
      const action = inlineConversationUnbindState();
      if (button.disabled || !action.visible || action.busy || action.pending) return;
      const originKey = inlineConversationKey(inlineConversation);
      const navigation = inlineConversationNavigationRequest;
      state.nativeUnbindPending = originKey;
      state.error = "";
      renderInlineConversation();
      try {
        const confirmed = await confirmAction("解除绑定", "解除后，此会话将作为普通 Codex 会话继续使用，聊天记录会保留。", "解除绑定");
        if (!confirmed || !inlineConversation || inlineConversationKey(inlineConversation) !== originKey || navigation !== inlineConversationNavigationRequest) return;
        const current = await api(inlineConversationQuery(action.target));
        if (!inlineConversation || inlineConversationKey(inlineConversation) !== originKey || navigation !== inlineConversationNavigationRequest) return;
        if (normalizeSessionId(current.thread_id || current.binding?.thread_id) !== action.threadId || current.conversation?.conversation_id !== action.target.conversation_id) throw new Error("native_conversation_binding_changed");
        const result = await api("/api/native-conversations/unbind", { method: "POST", body: JSON.stringify({ ...action.target, expected_revision: current.conversation.revision, ...(action.target.kind === "work" ? { expected_issue_version: current.expected_revision } : {}) }) });
        const threadId = normalizeSessionId(result.thread_id);
        state.nativeUnboundThreads ||= {};
        state.nativeUnboundThreads[threadId] = true;
        try { sessionStorage.setItem("better-codex-unbound-threads", JSON.stringify(state.nativeUnboundThreads)); } catch {}
        if (state.nativeThreadLinks) delete state.nativeThreadLinks[threadId];
        inlineConversationAdapter?.unregisterBinding?.(threadId, result.host_id || "local");
        registerInlineConversationBindings();
        const stillCurrent = !destroyed && inlineConversation && inlineConversationKey(inlineConversation) === originKey && navigation === inlineConversationNavigationRequest;
        if (stillCurrent) { leaveInlineConversation(); close(); }
        if (stillCurrent || projectSurfaceCache?.conversation && normalizeSessionId(projectSurfaceCache.conversation.thread_id || projectSurfaceCache.conversation.binding?.thread_id) === threadId) releaseProjectSurfaceCache();
        clearUnboundConversationView(result);
        if (stillCurrent) { await openThread(threadId); releaseProjectSurfaceCache(); }
        else if (inlineConversation) renderInlineConversation();
      } catch (error) {
        const value = String(error instanceof Error ? error.message : error);
        if (inlineConversation && inlineConversationKey(inlineConversation) === originKey) state.error = value.includes("busy") ? t("会话正在运行，请等待完成后再解除绑定。") : value === "native_conversation_binding_changed" ? t("会话绑定已更新，请重新打开后再试。") : errorLabel(error);
        throw error;
      } finally {
        state.nativeUnbindPending = null;
        if (inlineConversation) renderInlineConversation();
      }
    }
    function inlineConversationColumnSizing() {
      const kind = inlineConversationTarget()?.kind === "work" ? "work" : "planning";
      const projectsWidth = innerWidth <= 1100 ? 152 : 180;
      const surfaceWidth = inlineConversationRoot?.closest("[data-better-codex-inline-host]")?.clientWidth || innerWidth - 52;
      const compact = window.matchMedia("(max-width: 980px)").matches;
      const detailsSpace = !compact && inlineConversationDetailsOpen ? 280 : 0;
      const max = Math.max(160, Math.min(520, surfaceWidth - projectsWidth - detailsSpace - 360));
      let saved = 0;
      try { saved = Number(localStorage.getItem("better-codex-" + kind + "-conversations-width")); } catch {}
      const width = Math.min(max, Math.max(160, saved || (innerWidth <= 1100 ? 176 : 190)));
      return { kind, projectsWidth, max, width };
    }
    function bindInlineConversationColumnResize(handle) {
      let drag = null;
      const update = (width) => {
        const sizing = inlineConversationColumnSizing();
        try { localStorage.setItem("better-codex-" + sizing.kind + "-conversations-width", String(Math.min(sizing.max, Math.max(160, width)))); } catch {}
        renderInlineConversation();
      };
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        drag = { pointerId: event.pointerId, x: event.clientX, width: inlineConversationColumnSizing().width };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener("pointermove", event => {
        if (drag?.pointerId === event.pointerId) update(drag.width + event.clientX - drag.x);
      });
      const finish = event => {
        if (drag?.pointerId !== event.pointerId) return;
        drag = null;
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      };
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
      handle.addEventListener("lostpointercapture", () => { drag = null; });
      handle.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        update(inlineConversationColumnSizing().width + (event.key === "ArrowRight" ? 20 : -20));
      });
    }
    function renderInlineConversation() {
      if (!inlineConversation || !inlineConversationRoot) return;
      const target = inlineConversationTarget();
      const project = state.projects.find((candidate) => candidate.id === target.project_id) || inlineConversation.context?.project || { id: target.project_id };
      const context = inlineConversation.context || {};
      const task = context.task || context.issue || state.issues.find((candidate) => candidate.id === target.issue_id) || state.nativeWorkConversations?.[target.project_id]?.find(candidate => candidate.issue_id === target.issue_id && candidate.source === "current");
      const title = target.kind === "work" ? task?.title || t("工作任务") : projectLabel(project) || t("项目规划");
      const workWorkspace = target.kind === "work";
      const tabs = '<div class="better-codex-inline-tabs"><button type="button" data-planning-workspace-view="overview">' + te("概览") + '</button><button type="button" data-planning-workspace-view="' + (workWorkspace ? 'planning' : 'work') + '">' + te(workWorkspace ? "规划" : "工作") + '</button></div>';
      const stageTabs = workWorkspace ? "" : planningStageTabsMarkup(target.project_id, target.kind, target.kind === "planning" || inlineConversation.planning_available === true || context.charter?.status === "confirmed", true);
      const taskStart = workWorkspace && !task?.archived_at ? '<button type="button" data-work-create="' + escapeHtml2(target.issue_id) + '">' + icon("plus") + te("新建会话") + '</button>' : "";
      const compact = window.matchMedia("(max-width: 980px)").matches;
      const detailsOpen = compact ? inlineConversationCompactDetailsOpen : inlineConversationDetailsOpen;
      const header = '<div class="better-codex-inline-heading-leading"><button type="button" data-inline-back aria-label="' + te(workWorkspace ? "返回任务看板" : "返回项目") + '">' + icon("back") + te("返回") + '</button><span class="better-codex-inline-title" title="' + escapeHtml2(title) + '">' + escapeHtml2(title) + '</span>' + tabs + '</div>' + stageTabs + '<div class="better-codex-inline-heading-actions">' + (workWorkspace ? '<nav class="bc-project-work-views" aria-label="' + te("工作视图") + '"><button type="button" data-inline-work-view="board">' + te("状态看板") + '</button><button type="button" aria-current="page" data-inline-work-view="conversations">' + te("工作会话") + '</button></nav>' : '') + taskStart + inlineConversationUnbindMarkup() + '<button type="button" data-inline-details aria-expanded="' + String(detailsOpen) + '">' + icon("docs") + te(workWorkspace ? "资料" : "总纲与任务") + '</button>' + (workWorkspace && !inlineConversation.read_only && !target.history_id && inlineConversation.mode !== "legacy_busy" && !issueExecutionRunning(task) ? '<button type="button" data-inline-restart>' + te("重新开始") + '</button>' : '') + '<button type="button" data-inline-retry aria-label="' + te("重新连接会话") + '" title="' + te("重新连接会话") + '">' + icon("refresh") + '</button></div>';
      const heading = inlineConversationRoot.querySelector(".better-codex-inline-heading");
      if (header !== inlineConversationHeaderMarkup) { heading.innerHTML = header; inlineConversationHeaderMarkup = header; }
      const projects = inlineConversationRoot.querySelector(".bc-planning-projects");
      const conversations = inlineConversationRoot.querySelector(".bc-planning-conversations");
      {
        const projectMarkup = projectSidebarMarkup();
        const conversationMarkup = workWorkspace ? workConversationListMarkup() : planningConversationListMarkup();
        if (projectMarkup + conversationMarkup !== inlineConversationNavigationMarkup) {
          const projectScroll = projects.querySelector(".bc-project-sidebar-list")?.scrollTop || 0;
          const conversationScroll = conversations.querySelector("nav")?.scrollTop || 0;
          projects.innerHTML = projectMarkup;
          conversations.innerHTML = conversationMarkup;
          if (projects.querySelector(".bc-project-sidebar-list")) projects.querySelector(".bc-project-sidebar-list").scrollTop = projectScroll;
          if (conversations.querySelector("nav")) conversations.querySelector("nav").scrollTop = conversationScroll;
          inlineConversationNavigationMarkup = projectMarkup + conversationMarkup;
        }
      }
      projects.hidden = false;
      conversations.hidden = false;
      conversations.setAttribute("aria-label", t(workWorkspace ? "工作会话" : "规划会话"));
      inlineConversationRoot.setAttribute("data-planning-workspace", "true");
      inlineConversationRoot.setAttribute("data-work-workspace", String(workWorkspace));
      const details = inlineConversationRoot.querySelector(".better-codex-inline-details");
      if (target.kind !== "work" && context.charter) {
        state.planningContexts ||= {};
        state.planningContexts[target.project_id] = context;
      }
      const markup = '<header class="better-codex-inline-details-toolbar"><strong>' + te(workWorkspace ? "任务资料" : "总纲与任务") + '</strong><button type="button" data-inline-details-close aria-label="' + te("收起资料") + '">' + icon("close") + te("收起") + '</button></header>' + (target.kind === "work" ? inlineWorkDetailsMarkup() : projectPlanningMarkup(project, { inline: true }));
      if (markup !== inlineConversationDetailsMarkup) {
        const scrollTop = details.scrollTop;
        details.innerHTML = markup;
        details.scrollTop = scrollTop;
        inlineConversationDetailsMarkup = markup;
      }
      const mode = inlineConversation.mode;
      const notice = inlineConversationRoot.querySelector(".better-codex-inline-notice");
      if (notice) {
        const message = state.error || (inlineConversation.read_only ? t(target.history_id ? "历史会话仅供查看。" : "总纲修订中，确认后可继续任务规划。") : "");
        if (notice.textContent !== message) notice.textContent = message;
        notice.hidden = !message;
      }
      const status = inlineConversationRoot.querySelector(".better-codex-inline-status");
      const waiting = mode === "legacy_busy" || mode === "handoff_required";
      const statusMarkup = inlineConversationError ? '<p>' + escapeHtml2(inlineConversationError) + '</p><button type="button" data-inline-retry>' + te("重试") + '</button>' : waiting ? '<strong>' + te(mode === "legacy_busy" ? "任务正在运行" : "任务会话已准备好") + '</strong><p>' + te(mode === "legacy_busy" ? "完成后可在这里继续会话。" : "打开会话，继续当前任务。") + '</p>' + (mode === "handoff_required" ? '<button type="button" data-inline-handoff>' + te("打开会话") + '</button>' : "") + ((inlineConversation.history || []).length ? '<div class="better-codex-inline-history">' + inlineConversation.history.map((message) => '<article><strong>' + te(message.role === "user" ? "你" : "Codex") + '</strong>' + documentTextMarkup(message.markdown || message.text || message.content) + '</article>').join("") + '</div>' : "") : inlineConversationLoading && !inlineConversationCacheRestoring ? '<p>' + te("正在打开会话…") + '</p>' : "";
      if (status.innerHTML !== statusMarkup) status.innerHTML = statusMarkup;
      status.hidden = !statusMarkup && (!inlineConversationCacheRestoring || projectSurfaceCache?.nativeRetained === true);
      const nativeSurface = inlineConversationRoot.closest("[data-better-codex-inline-host]");
      const columnSizing = inlineConversationColumnSizing();
      inlineConversationRoot.style.setProperty("--bc-planning-conversations-width", columnSizing.width + "px");
      const conversationResize = inlineConversationRoot.querySelector(".bc-conversations-resize");
      conversationResize.setAttribute("aria-label", t(workWorkspace ? "调整工作会话宽度" : "调整规划会话宽度"));
      conversationResize.setAttribute("aria-valuemin", "160");
      conversationResize.setAttribute("aria-valuemax", String(columnSizing.max));
      conversationResize.setAttribute("aria-valuenow", String(columnSizing.width));
      const navSpace = (columnSizing.projectsWidth + columnSizing.width) + "px";
      const maxDetailsWidth = compact ? Math.round(innerWidth * .9) : Math.max(280, (nativeSurface?.clientWidth || innerWidth - 52) - parseFloat(navSpace) - 360);
      const detailsWidth = Math.min(inlineConversationWidth, maxDetailsWidth);
      details.hidden = !detailsOpen;
      inlineConversationRoot.querySelector(".better-codex-inline-resize").hidden = !detailsOpen;
      inlineConversationRoot.style.setProperty("--bc-inline-details-width", detailsWidth + "px");
      nativeSurface?.style.setProperty("--bc-inline-nav-space", navSpace);
      nativeSurface?.style.setProperty("--bc-inline-details-space", detailsOpen && !compact ? detailsWidth + "px" : "0px");
      document.documentElement.style.setProperty("--bc-planning-left-space", navSpace);
      document.documentElement.style.setProperty("--bc-planning-details-space", detailsOpen && !compact ? detailsWidth + "px" : "0px");
      if (nativeSurface) syncInlineNativeFilePanel(nativeSurface);
      const toolbarWidth = heading.querySelector(".better-codex-inline-heading-actions")?.getBoundingClientRect?.().width || 0;
      document.documentElement.style.setProperty("--bc-planning-toolbar-space", Math.ceil(toolbarWidth + 24) + "px");
      syncInlineConversationInteraction();
    }
    function syncPlanningWorkspaceNativeChrome(enabled, nativePage = document.querySelector('[data-app-shell-active-page="true"]')) {
      if (!enabled) {
        document.querySelectorAll("[data-better-codex-planning-native-hidden], [data-better-codex-planning-native-rail], [data-better-codex-planning-native-header]").forEach(node => {
          if (projectSurfaceCache?.nativeSurface?.closest('[data-app-shell-active-page]')?.contains(node)) return;
          node.removeAttribute("data-better-codex-planning-native-hidden");
          node.removeAttribute("data-better-codex-planning-native-rail");
          node.removeAttribute("data-better-codex-planning-native-header");
        });
        document.documentElement.style.removeProperty("--bc-planning-left-space");
        document.documentElement.style.removeProperty("--bc-planning-details-space");
        document.documentElement.style.removeProperty("--bc-planning-toolbar-space");
        return;
      }
      const ownsChrome = node => !node.closest('[data-app-shell-active-page]') || node.closest('[data-app-shell-active-page]') === nativePage;
      Array.from(document.querySelectorAll(".app-shell-left-panel")).filter(ownsChrome).forEach(node => {
        if (node.getAttribute("data-better-codex-planning-native-rail") !== "true") node.setAttribute("data-better-codex-planning-native-rail", "true");
        node.querySelectorAll(".sidebar-navigation").forEach(sidebar => { if (!sidebar.querySelector("[data-app-navigation-rail]") && sidebar.getAttribute("data-better-codex-planning-native-hidden") !== "true") sidebar.setAttribute("data-better-codex-planning-native-hidden", "true"); });
      });
      Array.from(document.querySelectorAll('[data-app-shell-header-layout="thread-edge-scroll"][data-app-shell-application-menu-bar="true"]')).filter(ownsChrome).forEach(node => {
        if (node.getAttribute("data-better-codex-planning-native-header") !== "true") {
          node.style.setProperty('--bc-native-header-top', getComputedStyle(node).top);
          node.setAttribute("data-better-codex-planning-native-header", "true");
        }
      });
    }
    function syncInlineNativeFilePanel(surface) {
      const filePanel = surface.querySelector(':scope > aside[data-app-shell-focus-area="right-panel"]');
      const nativeLayout = surface.querySelector(':scope > ' + SELECTORS.contentLayout);
      let width = 0;
      if (filePanel && !filePanel.hidden && filePanel.getAttribute('aria-hidden') !== 'true' && getComputedStyle(filePanel).display !== 'none') {
        const navWidth = parseFloat(surface.style.getPropertyValue('--bc-inline-nav-space')) || 0;
        const detailsWidth = parseFloat(surface.style.getPropertyValue('--bc-inline-details-space')) || 0;
        const available = Math.max(0, (surface.clientWidth || innerWidth - 52) - navWidth - detailsWidth);
        const full = nativeLayout?.getAttribute('data-app-shell-right-panel-full-width') === 'true';
        const nativeWidth = filePanel.style.width;
        const preferred = /px$/.test(nativeWidth) ? parseFloat(nativeWidth) : parseFloat(filePanel.getAttribute('data-better-codex-panel-width')) || Math.min(480, available * .5);
        if (!full) filePanel.setAttribute('data-better-codex-panel-width', String(preferred));
        width = full ? available : Math.min(preferred, Math.max(0, available - 360), available * .6);
        filePanel.setAttribute('data-better-codex-native-panel', 'true');
      }
      const value = Math.round(width) + 'px';
      if (surface.style.getPropertyValue('--bc-inline-native-panel-width') !== value) surface.style.setProperty('--bc-inline-native-panel-width', value);
      if (inlineNativePanelNode !== filePanel) {
        inlineNativePanelObserver?.disconnect();
        inlineNativePanelObserver = null;
        inlineNativePanelNode = filePanel;
        if (filePanel && typeof MutationObserver === 'function') {
          inlineNativePanelObserver = new MutationObserver(() => { if (active && inlineConversation && filePanel.isConnected) syncInlineNativeFilePanel(surface); });
          inlineNativePanelObserver.observe(filePanel, { attributes: true, attributeFilter: ['style', 'aria-hidden', 'hidden'] });
        }
      }
    }
    function mountInlineConversation(surface) {
      if (!inlineConversationRoot) {
        inlineConversationRoot = document.createElement("section");
        inlineConversationRoot.id = "better-codex-native-conversation";
        inlineConversationRoot.setAttribute(OWNED, "true");
        inlineConversationRoot.innerHTML = '<header class="better-codex-inline-heading"></header><aside class="bc-planning-projects" aria-label="' + te("项目列表") + '"></aside><aside class="bc-planning-conversations" aria-label="' + te("规划会话") + '"></aside><aside class="better-codex-inline-details" aria-label="' + te("总纲与任务") + '"></aside><div class="better-codex-inline-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-label="' + te("调整资料宽度") + '"></div><div class="better-codex-inline-status" hidden></div><div class="better-codex-inline-notice" role="status" hidden></div>';
        inlineConversationRoot.addEventListener("click", onInlineConversationClick);
        const conversationResize = document.createElement("div");
        conversationResize.className = "bc-conversations-resize";
        conversationResize.setAttribute("role", "separator");
        conversationResize.setAttribute("tabindex", "0");
        conversationResize.setAttribute("aria-orientation", "vertical");
        inlineConversationRoot.appendChild(conversationResize);
        bindInlineConversationColumnResize(conversationResize);
        const resize = inlineConversationRoot.querySelector(".better-codex-inline-resize");
        resize.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          inlineConversationResize = { pointerId: event.pointerId, x: event.clientX, width: parseFloat(inlineConversationRoot.style.getPropertyValue("--bc-inline-details-width")) || inlineConversationWidth };
          resize.setPointerCapture(event.pointerId);
          event.preventDefault();
        });
        resize.addEventListener("pointermove", (event) => {
          if (!inlineConversationResize || event.pointerId !== inlineConversationResize.pointerId) return;
          const sizing = inlineConversationColumnSizing();
          const surfaceWidth = inlineConversationRoot.closest("[data-better-codex-inline-host]")?.clientWidth || innerWidth - 52;
          inlineConversationWidth = Math.min(Math.max(280, surfaceWidth - sizing.projectsWidth - sizing.width - 360), Math.max(280, inlineConversationResize.width + inlineConversationResize.x - event.clientX));
          renderInlineConversation();
        });
        const finishResize = () => { inlineConversationResize = null; localStorage.setItem("better-codex-conversation-details-width", String(inlineConversationWidth)); };
        resize.addEventListener("pointerup", finishResize);
        resize.addEventListener("pointercancel", finishResize);
        resize.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const sizing = inlineConversationColumnSizing();
          const surfaceWidth = inlineConversationRoot.closest("[data-better-codex-inline-host]")?.clientWidth || innerWidth - 52;
          inlineConversationWidth = Math.min(Math.max(280, surfaceWidth - sizing.projectsWidth - sizing.width - 360), Math.max(280, (parseFloat(inlineConversationRoot.style.getPropertyValue("--bc-inline-details-width")) || inlineConversationWidth) + (event.key === "ArrowLeft" ? 20 : -20)));
          localStorage.setItem("better-codex-conversation-details-width", String(inlineConversationWidth));
          renderInlineConversation();
        });
      }
      syncPlanningWorkspaceNativeChrome(true);
      if (!panel) { panel = createPanel(); panelSizeCleanup = observeComponentSize(panel, componentContext("host", "panel-layout")); }
      if (panel.parentElement !== surface) surface.appendChild(panel);
      panel.setAttribute("data-better-codex-inline-shell", "true");
      panel.hidden = false;
      if (inlineConversationRoot.parentElement !== panel) panel.appendChild(inlineConversationRoot);
      surface.setAttribute("data-better-codex-inline-host", "true");
      const nativeLayout = Array.from(surface.children).find((child) => !child.hasAttribute(OWNED) && child.matches(SELECTORS.contentLayout)) || Array.from(surface.children).find((child) => !child.hasAttribute(OWNED) && inlineNativeElementVisible(child) && child.querySelector(SELECTORS.contentFrame));
      if (nativeLayout) nativeLayout.setAttribute("data-better-codex-inline-content", "true");
      renderInlineConversation();
    }
    function onInlineConversationClick(event) {
      const target = event.target.closest("button,input[data-plan-item]");
      if (!target) return;
      const projectRow = target.closest("[data-project-id]");
      if (projectRow && target.closest(".bc-planning-projects")) return void perform(() => openProjectDetail(projectRow.dataset.projectId));
      if (target.matches("[data-project-sidebar-create]")) return openCreateProjectDialog();
      if (target.matches("[data-inline-unbind]")) return target.disabled ? void 0 : void perform(() => unbindInlineConversation(target));
      if (target.matches("[data-planning-archive]")) return target.disabled ? void 0 : void perform(async () => {
        target.disabled = true;
        try { await archiveProjectNativeConversation(inlineConversationTarget().project_id, target.dataset.planningArchive); }
        finally { if (target.isConnected) target.disabled = false; }
      });
      if (target.matches("[data-planning-conversation]")) return target.disabled ? void 0 : void perform(() => openProjectNativeSession(inlineConversationTarget().project_id, "", target.dataset.planningConversation));
      if (target.matches("[data-work-conversation]")) return void perform(() => target.dataset.workHistory ? openInlineConversation({ project_id: inlineConversationTarget().project_id, kind: "work", issue_id: target.dataset.workConversation, ...(target.dataset.workConversationId ? { conversation_id: target.dataset.workConversationId } : {}), history_id: target.dataset.workHistory }) : openIssueNativeConversation({ project_id: inlineConversationTarget().project_id, id: target.dataset.workConversation }, target.dataset.workConversationId || ""));
      if (target.matches("[data-work-create]")) return void perform(async () => {
        target.disabled = true;
        try { await createIssueNativeConversation({ project_id: inlineConversationTarget().project_id, id: target.dataset.workCreate }); }
        finally { if (target.isConnected) target.disabled = false; }
      });
      if (target.matches("[data-planning-create]")) return target.disabled ? void 0 : void perform(async () => {
        const navigationRequest = ++inlineConversationNavigationRequest;
        const projectId = inlineConversationTarget().project_id;
        const originKey = inlineConversationKey(inlineConversation);
        const response = await api("/api/native-conversations/create", { method: "POST", body: JSON.stringify({ project_id: projectId, kind: target.dataset.planningCreate }) });
        await loadProjectNativeConversations(projectId);
        if (!inlineConversation || inlineConversationKey(inlineConversation) !== originKey || navigationRequest !== inlineConversationNavigationRequest) return;
        await openInlineConversation({ project_id: projectId, kind: response.conversation.kind, conversation_id: response.conversation.conversation_id });
      });
      if (target.matches("[data-inline-work-view]")) {
        const projectId = inlineConversationTarget().project_id;
        if (target.dataset.inlineWorkView === "conversations") return void perform(() => openProjectWorkSession(projectId));
        leaveInlineConversation();
        state.projectDetailId = projectId;
        state.projectPage = "work";
        state.projectResumePending = "";
        rememberProjectView();
        openRoute("projects", { projectId, resume: false });
        if (!state.issuesLoaded) void perform(() => loadIssues());
        return;
      }
      if (target.matches("[data-planning-workspace-view]")) {
        const projectId = inlineConversationTarget().project_id;
        if (target.dataset.planningWorkspaceView === "work") return void perform(() => openProjectWorkSession(projectId));
        if (target.dataset.planningWorkspaceView === "planning") return void perform(() => openProjectNativeSession(projectId, ""));
        leaveInlineConversation();
        state.projectPage = target.dataset.planningWorkspaceView;
        rememberProjectView();
        return openRoute("projects", { projectId, resume: false });
      }
      if (target.matches("[data-inline-work-task]")) return void perform(() => openIssueNativeConversation({ id: target.dataset.inlineWorkTask, project_id: inlineConversationTarget().project_id }));
      if (target.matches("[data-inline-accept-task]")) return void perform(() => confirmInlineTaskAcceptance(target));
      if (target.matches("[data-inline-back]")) {
        const current = inlineConversationTarget();
        const surface = inlineConversation.return_surface || (current.kind === "work" ? "issues" : "projects");
        leaveInlineConversation();
        rememberProjectView();
        return openRoute(surface, { projectId: current.project_id, resume: false });
      }
      if (target.matches("[data-inline-details], [data-inline-details-close]")) {
        const closing = target.matches("[data-inline-details-close]");
        if (window.matchMedia("(max-width: 980px)").matches) inlineConversationCompactDetailsOpen = closing ? false : !inlineConversationCompactDetailsOpen;
        else inlineConversationDetailsOpen = closing ? false : !inlineConversationDetailsOpen;
        renderInlineConversation(); return;
      }
      if (target.matches("[data-inline-stage]")) return target.disabled ? void 0 : void perform(() => openProjectNativeSession(inlineConversationTarget().project_id, target.dataset.inlineStage));
      if (target.matches("[data-inline-retry]")) return void perform(() => openInlineConversation(inlineConversationTarget(), { retry: true }));
      if (target.matches("[data-inline-restart]") && (inlineConversation.read_only || inlineConversationTarget().history_id)) return;
      if (target.matches("[data-inline-restart]")) {
        const current = { ...inlineConversationTarget() };
        const previousThread = normalizeSessionId(inlineConversation.thread_id || inlineConversation.binding?.thread_id);
        const expectedRevision = inlineConversation.expected_revision;
        return void confirmAction("重新开始会话", "当前会话与项目资料会保留，新的会话从空白输入框开始。", "重新开始").then((confirmed) => confirmed && inlineConversation && inlineConversationKey(inlineConversation) === inlineConversationKey(current) && perform(async () => {
        const response = await api("/api/native-conversations/restart", { method: "POST", body: JSON.stringify({ ...current, expected_revision: expectedRevision, explicit: true }) });
        if (previousThread && state.nativeThreadLinks) delete state.nativeThreadLinks[previousThread];
        registerInlineConversationBindings();
        if (!inlineConversation || inlineConversationKey(inlineConversation) !== inlineConversationKey(current)) return;
        inlineConversationAdapter?.leave?.();
        if (current.kind === "work") await loadProjectWorkConversations(current.project_id);
        else await loadProjectNativeConversations(current.project_id);
        if (!inlineConversation || inlineConversationKey(inlineConversation) !== inlineConversationKey(current)) return;
        await openInlineConversation({ ...current, ...(response.target || {}), ...(response.conversation_id ? { conversation_id: response.conversation_id } : {}) }, { retry: true });
      }));
      }
      if (target.matches("[data-inline-handoff]")) return void perform(async () => {
        if (inlineConversation.read_only || inlineConversationTarget().history_id) return;
        const current = inlineConversationTarget();
        const issue = state.issues.find((candidate) => candidate.id === current.issue_id) || await api("/api/issues/" + encodeURIComponent(current.issue_id));
        await requestSessionHandoff(issue, issueSessionId(issue));
        if (!inlineConversation || inlineConversationKey(inlineConversation) !== inlineConversationKey(current)) return;
        await openInlineConversation(current, { retry: true });
      });
      if (target.matches("[data-inline-start]")) return void perform(async () => {
        if (inlineConversation.read_only || inlineConversationTarget().history_id) return;
        target.disabled = true;
        const current = inlineConversationTarget();
        inlineConversation.start_requested = true;
        try {
          const issue = await api("/api/issues/" + encodeURIComponent(current.issue_id));
          await api("/api/issues/" + encodeURIComponent(issue.id) + "/start", { method: "POST", body: JSON.stringify({ version: issue.version }) });
          await loadIssues();
          if (inlineConversation && inlineConversationKey(inlineConversation) === inlineConversationKey(current)) await reloadInlineConversationContext();
        } catch (error) {
          if (inlineConversation && inlineConversationKey(inlineConversation) === inlineConversationKey(current)) inlineConversation.start_requested = false;
          throw error;
        } finally { if (target.isConnected) target.disabled = false; }
      });
      onProjectsClick(event);
    }
    function createPanel() {
      const nativeFrame = document.querySelector(SELECTORS.contentFrame);
      const section = document.createElement("section");
      section.id = PANEL_ID;
      section.className = nativeFrame?.className || "";
      section.dataset.host = HOST_KIND;
      section.hidden = true;
      section.setAttribute(OWNED, "true");
      const error = document.createElement("div");
      error.id = "better-codex-error";
      error.className = "better-codex-error";
      error.hidden = true;
      const toolbar = document.createElement("div");
      toolbar.className = "better-codex-toolbar";
      const tabs = document.createElement("div");
      tabs.className = "better-codex-tabs better-codex-issue-only";
      for (const [view, text] of [["all", "全部"], ["assigned", "已分配"], ["unassigned", "未分配"]]) {
        const button2 = actionButton(text);
        button2.dataset.view = view;
        button2.setAttribute("aria-label", t(text));
        button2.innerHTML = icon(view === "all" ? "board" : view === "assigned" ? "userCheck" : "userX", "better-codex-tab-icon") + "<span>" + te(text) + "</span>";
        button2.addEventListener("click", () => {
          state.view = view;
          render();
        });
        tabs.append(button2);
      }
      const agentHeading = document.createElement("div");
      agentHeading.className = "better-codex-agent-heading";
      for (const [view, text] of [["all", "全部"], ["managed", "管理的 Skill"], ["external", "外部 Skill"]]) {
        const button2 = actionButton(text);
        button2.dataset.agentView = view;
        button2.addEventListener("click", () => {
          state.agentView = view;
          renderAgents();
        });
        agentHeading.append(button2);
      }
      const actions = document.createElement("div");
      actions.className = "better-codex-actions better-codex-issue-only";
      const working = actionButton("0 项工作进行中");
      working.id = "better-codex-working";
      working.dataset.runningCount = "0";
      working.classList.add("better-codex-working-chip", "is-bordered");
      working.setAttribute("aria-label", t("0 项工作进行中"));
      working.addEventListener("click", () => {
        state.view = state.view === "working" ? "all" : "working";
        render();
      });
      const searchWrap = document.createElement("div");
      searchWrap.className = "better-codex-search-wrap";
      searchWrap.innerHTML = icon("search");
      const search = document.createElement("input");
      search.id = "better-codex-search";
      search.className = "better-codex-search";
      search.placeholder = t("搜索任务");
      search.setAttribute("aria-label", t("搜索任务"));
      search.value = "";
      search.addEventListener("input", () => {
        state.search = search.value;
        void perform(loadIssues);
      });
      searchWrap.appendChild(search);
      const filter = actionButton("筛选");
      filter.id = "better-codex-filter";
      filter.classList.add("is-bordered");
      filter.setAttribute("aria-label", t("筛选"));
      filter.innerHTML = icon("filter") + "<span>" + te("筛选") + "</span>";
      filter.addEventListener("click", (event) => {
        event.stopPropagation();
        openFilterMenu(filter);
      });
      const filterWrap = document.createElement("div");
      filterWrap.className = "better-codex-filter-wrap";
      filterWrap.appendChild(filter);
      const autoDispatchWrap = document.createElement("div");
      autoDispatchWrap.className = "better-codex-auto-dispatch-wrap";
      const autoDispatch = actionButton("");
      autoDispatch.id = "better-codex-auto-dispatch";
      autoDispatch.classList.add("better-codex-auto-dispatch", "is-bordered");
      autoDispatch.setAttribute("aria-pressed", "false");
      autoDispatch.setAttribute("aria-label", t("切换为自动运行"));
      autoDispatch.innerHTML = icon("user") + "<span>" + escapeHtml2(t("手动运行")) + "</span>";
      autoDispatch.addEventListener("click", () => {
        if (state.autoDispatchPending) return;
        const next = !state.autoDispatch;
        state.autoDispatchPending = true;
        syncAutoDispatch();
        void perform(async () => {
          try {
            const result = await api("/api/settings/auto-dispatch", { method: "PATCH", body: JSON.stringify({ enabled: next }) });
            if (result.command_id) {
              const command = await waitForRemoteCommand(result.command_id);
              if (command.status !== "applied") throw new Error(command.error || "command_rejected");
              await loadAutoDispatch();
            } else state.autoDispatch = Boolean(result.enabled);
          } finally {
            state.autoDispatchPending = false;
            if (REMOTE) await loadAutoDispatch().catch(() => {
            });
            syncAutoDispatch();
          }
        });
      });
      const autoDispatchHelp = actionButton("");
      autoDispatchHelp.className = "better-codex-auto-dispatch-help";
      autoDispatchHelp.setAttribute("aria-label", t("帮助与设置"));
      autoDispatchHelp.innerHTML = icon("help");
      autoDispatchHelp.addEventListener("click", (event) => {
        event.stopPropagation();
        showAutoDispatchHelp();
      });
      autoDispatchWrap.append(autoDispatch, autoDispatchHelp);
      const addIssue = actionButton("新建会话");
      addIssue.className = "better-codex-create-primary";
      addIssue.setAttribute("aria-label", t("新建会话"));
      addIssue.innerHTML = icon("plus") + "<span>" + te("新建会话") + "</span>";
      let addIssueLongPress = null;
      let suppressAddIssueClickUntil = 0;
      const resetAddIssueLongPress = () => {
        if (addIssueLongPress?.timer) clearTimeout(addIssueLongPress.timer);
        addIssueLongPress = null;
      };
      addIssue.addEventListener("click", (event) => {
        if (Date.now() < suppressAddIssueClickUntil) {
          suppressAddIssueClickUntil = 0;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        closeCreateMenu();
        void perform(() => createProjectWorkConversation());
      });
      if (HOST_KIND === "web") {
        addIssue.addEventListener("pointerdown", (event) => {
          if (event.pointerType !== "touch" || event.isPrimary === false || event.button !== 0) return;
          resetAddIssueLongPress();
          const press = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, timer: null };
          press.timer = setTimeout(() => {
            if (addIssueLongPress !== press) return;
            suppressAddIssueClickUntil = Date.now() + 700;
            openCreateMenu(createToggle);
            resetAddIssueLongPress();
          }, 500);
          addIssueLongPress = press;
        });
        addIssue.addEventListener("pointermove", (event) => {
          if (!addIssueLongPress || event.pointerId !== addIssueLongPress.pointerId) return;
          const deltaX = event.clientX - addIssueLongPress.startX;
          const deltaY = event.clientY - addIssueLongPress.startY;
          if (deltaX * deltaX + deltaY * deltaY > 64) resetAddIssueLongPress();
        });
        addIssue.addEventListener("pointerup", resetAddIssueLongPress);
        addIssue.addEventListener("pointercancel", resetAddIssueLongPress);
      }
      const createToggle = actionButton("");
      createToggle.id = "better-codex-create-toggle";
      createToggle.className = "better-codex-create-toggle";
      createToggle.dataset.createMenuToggle = "true";
      createToggle.setAttribute("aria-label", t("更多创建选项"));
      createToggle.setAttribute("aria-haspopup", "menu");
      createToggle.setAttribute("aria-expanded", "false");
      createToggle.innerHTML = icon("chevronDown");
      createToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        openCreateMenu(createToggle);
      });
      const createSplit = document.createElement("div");
      createSplit.className = "better-codex-create-split";
      createSplit.append(addIssue, createToggle);
      actions.append(working, searchWrap, filterWrap, createSplit);
      const agentActions = document.createElement("div");
      agentActions.className = "better-codex-agent-actions";
      const addAgent = actionButton("新建 Skill");
      addAgent.classList.add("is-bordered");
      addAgent.insertAdjacentHTML("afterbegin", icon("plus"));
      addAgent.addEventListener("click", () => startAgentCreate());
      agentActions.append(addAgent);
      const projectHeading = document.createElement("div");
      projectHeading.className = "better-codex-project-heading";
      projectHeading.innerHTML = "<strong>" + te("项目管理") + "</strong><span data-project-heading-meta></span>";
      projectHeading.addEventListener("click", onProjectsClick);
      const projectActions = document.createElement("div");
      projectActions.className = "better-codex-project-actions";
      projectRefreshButton = createIconButton(projectRefreshProps(), componentContext("projects", "projects-toolbar-refresh"));
      projectRefreshButton.element.classList.add("better-codex-project-refresh");
      const addProject = actionButton("创建项目");
      addProject.classList.add("is-bordered");
      addProject.insertAdjacentHTML("afterbegin", icon("plus"));
      addProject.addEventListener("click", () => state.projectDetailId ? void perform(() => createProjectWorkConversation(state.projectDetailId)) : openCreateProjectDialog());
      const addWorkItem = actionButton("新建工作项");
      addWorkItem.dataset.projectWorkItemCreate = "true";
      addWorkItem.hidden = !state.projectDetailId;
      addWorkItem.addEventListener("click", () => openEditor(null, "backlog"));
      projectActions.append(projectRefreshButton.element, addProject);
      projectActions.append(addWorkItem);
      toolbar.append(tabs, agentHeading, projectHeading, error, actions, agentActions, projectActions);
      const board = document.createElement("main");
      board.id = "better-codex-board";
      board.className = "better-codex-board better-codex-issue-only";
      board.addEventListener("click", onBoardClick);
      board.addEventListener("contextmenu", openIssueMenu);
      board.addEventListener("pointerdown", onIssueLongPressStart);
      board.addEventListener("pointermove", onIssueLongPressMove);
      board.addEventListener("pointerup", onIssueLongPressEnd);
      board.addEventListener("pointercancel", onIssueLongPressEnd);
      board.addEventListener("pointerdown", onBoardPanStart);
      board.addEventListener("pointermove", onBoardPanMove);
      board.addEventListener("pointerup", onBoardPanEnd);
      board.addEventListener("pointercancel", onBoardPanEnd);
      board.addEventListener("dragstart", onCardDragStart);
      board.addEventListener("dragend", onCardDragEnd);
      board.addEventListener("dragover", (event) => event.preventDefault());
      board.addEventListener("drop", onDrop);
      const boardScrollControl = document.createElement("div");
      boardScrollControl.className = "better-codex-board-scroll better-codex-issue-only";
      boardScrollControl.hidden = true;
      boardScrollControl.innerHTML = '<button class="better-codex-board-scroll-btn is-start" type="button" aria-label="' + te("向左滚动任务看板") + '">' + icon("chevron") + '</button><input type="range" min="0" max="0" value="0" step="1" aria-label="' + te("横向滚动任务看板") + '"><button class="better-codex-board-scroll-btn is-end" type="button" aria-label="' + te("向右滚动任务看板") + '">' + icon("chevron") + "</button>";
      const range = boardScrollControl.querySelector("input");
      range.addEventListener("input", () => {
        board.scrollLeft = Number(range.value);
      });
      boardScrollControl.querySelector(".is-start")?.addEventListener("click", () => {
        board.scrollBy({ left: -300, behavior: "smooth" });
      });
      boardScrollControl.querySelector(".is-end")?.addEventListener("click", () => {
        board.scrollBy({ left: 300, behavior: "smooth" });
      });
      board.addEventListener("scroll", syncBoardScrollControl, { passive: true });
      boardScrollResizeObserver?.disconnect();
      boardScrollResizeObserver = new ResizeObserver(syncBoardScrollControl);
      boardScrollResizeObserver.observe(board);
      const recovery = document.createElement("main");
      recovery.id = "better-codex-recovery";
      recovery.className = "better-codex-recovery";
      recovery.hidden = true;
      recovery.innerHTML = '<section class="better-codex-recovery-card"><span class="better-codex-recovery-icon">' + icon("terminal") + "</span><h2>" + te("Better Codex 服务需要重启") + "</h2><p>" + te("当前页面与后台服务的连接已失效。请在终端运行下面的命令，完成后重新连接。") + '</p><div class="better-codex-recovery-command"><code>better-codex service restart</code><button type="button" data-recovery-copy>' + te("复制重启命令") + '</button></div><button class="better-codex-recovery-retry" type="button" data-recovery-retry>' + icon("refresh") + "<span>" + te("重新连接") + "</span></button><details><summary>" + te("错误详情") + "</summary><code data-recovery-error></code></details></section>";
      recovery.querySelector("[data-recovery-copy]").addEventListener("click", event => {
        void copyServiceRestartCommand(event).catch(error => reportUnexpectedError(error, { source: "recovery_copy" }));
      });
      recovery.querySelector("[data-recovery-retry]").addEventListener("click", (event) => {
        const button2 = event.currentTarget;
        button2.disabled = true;
        button2.innerHTML = icon("refresh") + "<span>" + te("正在连接…") + "</span>";
        void load();
      });
      const agents = document.createElement("main");
      agents.id = "better-codex-agents";
      agents.className = "better-codex-agents";
      agents.addEventListener("click", onAgentsClick);
      agents.addEventListener("pointerdown", onAgentInspectorResizeStart);
      agents.addEventListener("pointermove", onAgentInspectorResizeMove);
      agents.addEventListener("pointerup", finishAgentInspectorResize);
      agents.addEventListener("pointercancel", finishAgentInspectorResize);
      agents.addEventListener("keydown", (event) => {
        if (onAgentInspectorResizeKeydown(event)) return;
        if (event.key !== "Escape") return;
        const openPicker = agents.querySelector(".better-codex-agent-setting.is-open");
        if (!openPicker) return;
        openPicker.classList.remove("is-open");
        const trigger = openPicker.querySelector("[data-agent-picker-toggle]");
        trigger?.setAttribute("aria-expanded", "false");
        trigger?.focus();
      });
      agents.addEventListener("input", (event) => {
        if (event.target.matches("[data-agent-search]")) {
          state.agentSearch = event.target.value;
          renderAgents();
          const search2 = agents.querySelector("[data-agent-search]");
          if (search2) {
            search2.focus();
            search2.setSelectionRange(search2.value.length, search2.value.length);
          }
          return;
        }
        const skillForm = event.target.closest("[data-skill-form]");
        if (skillForm) {
          const creatingSkill = ["create", "derive"].includes(skillForm.dataset.skillForm);
          const selected = state.skillsManaged?.find((item) => item.id === skillForm.dataset.skillId);
          const base = creatingSkill ? state.skillDraft || {} : selected || {};
          const values = { ...base, name: skillForm.elements.name.value, description: skillForm.elements.description.value, instructions: skillForm.elements.instructions.value, scope: creatingSkill ? skillForm.elements.project_id?.value ? "project" : "global" : base.scope || "global", project_id: creatingSkill ? skillForm.elements.project_id?.value || null : base.project_id || null };
          if (creatingSkill) state.skillDraft = values;
          else {
            state.skillEditDrafts ||= {};
            if (selected) state.skillEditDrafts[selected.id] = { ...selected, ...values };
          }
          return;
        }
        const form = event.target.closest('[data-agent-form]:not([data-agent-form="create"])');
        if (form && !event.isComposing) scheduleAgentAutosave(form, event.target.matches('input[type="checkbox"], input[type="number"]'));
      });
      agents.addEventListener("change", (event) => {
        if (event.target.matches('[data-skill-form] [name="project_id"]')) {
          state.skillDraft = { ...(state.skillDraft || {}), scope: event.target.value ? "project" : "global", project_id: event.target.value || null };
          return;
        }
        if (!event.target.matches("[data-skill-scope-filter]")) return;
        state.skillScopeFilter = event.target.value;
        renderAgents();
      });
      agents.addEventListener("compositionend", (event) => {
        const form = event.target.closest('[data-agent-form]:not([data-agent-form="create"])');
        if (form) scheduleAgentAutosave(form);
      });
      agents.addEventListener("submit", onAgentSubmit);
      const projects = document.createElement("main");
      projects.id = "better-codex-projects";
      projects.className = "better-codex-projects";
      projects.addEventListener("click", onProjectsClick);
      projects.addEventListener("click", onBoardClick);
      projects.addEventListener("contextmenu", openIssueMenu);
      projects.addEventListener("pointerdown", onIssueLongPressStart);
      projects.addEventListener("pointermove", onIssueLongPressMove);
      projects.addEventListener("pointerup", onIssueLongPressEnd);
      projects.addEventListener("pointercancel", onIssueLongPressEnd);
      projects.addEventListener("pointerdown", onBoardPanStart);
      projects.addEventListener("pointermove", onBoardPanMove);
      projects.addEventListener("pointerup", onBoardPanEnd);
      projects.addEventListener("pointercancel", onBoardPanEnd);
      projects.addEventListener("dragstart", onCardDragStart);
      projects.addEventListener("dragend", onCardDragEnd);
      projects.addEventListener("dragover", (event) => {
        if (event.target.closest("[data-project-board]")) event.preventDefault();
      });
      projects.addEventListener("drop", (event) => {
        if (event.target.closest("[data-project-board]")) onDrop(event);
      });
      projects.addEventListener("input", (event) => {
        if (!event.target.matches("[data-project-planning-form] textarea[name=message]")) return;
        const projectId = event.target.closest("[data-project-planning-form]")?.dataset.projectPlanningForm;
        if (projectId) projectPlanningDrafts.set(projectId, event.target.value);
      });
      projects.addEventListener("compositionstart", (event) => {
        if (!event.target.matches("[data-project-planning-form] textarea[name=message]")) return;
        projectPlanningComposition = event.target.closest("[data-project-planning-form]")?.dataset.projectPlanningForm || "";
      });
      projects.addEventListener("compositionend", (event) => {
        if (!event.target.matches("[data-project-planning-form] textarea[name=message]")) return;
        projectPlanningComposition = "";
        const projectId = event.target.closest("[data-project-planning-form]")?.dataset.projectPlanningForm;
        if (projectId) projectPlanningDrafts.set(projectId, event.target.value);
      });
      projects.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const picker = projects.querySelector("[data-project-document-agent-picker].is-open");
        if (!picker) return;
        picker.classList.remove("is-open");
        const trigger = picker.querySelector("[data-project-document-agent-toggle]");
        trigger?.setAttribute("aria-expanded", "false");
        trigger?.focus();
      });
      projects.addEventListener("submit", onProjectDocumentSubmit);
      projects.addEventListener("submit", onProjectPlanningSubmit);
      section.append(toolbar, board, boardScrollControl, agents, projects, recovery);
      return section;
    }
    function syncBoardScrollControl() {
      if (!panel) return;
      const board = panel.querySelector("#better-codex-board");
      const control = panel.querySelector(".better-codex-board-scroll");
      const range = control?.querySelector("input");
      if (!board || !control || !range) return;
      const max = Math.max(0, Math.ceil(board.scrollWidth - board.clientWidth));
      control.hidden = state.surface !== "issues" || max < 2;
      range.max = String(max);
      range.value = String(Math.min(max, Math.max(0, Math.round(board.scrollLeft))));
      if (control.hidden) return;
      const trackWidth = range.clientWidth;
      const minimumThumbWidth = Math.min(48, trackWidth);
      const proportionalThumbWidth = trackWidth * Math.min(1, board.clientWidth / board.scrollWidth);
      const thumbWidth = max <= trackWidth - minimumThumbWidth ? trackWidth - max : proportionalThumbWidth;
      range.style.setProperty("--bc-board-scroll-thumb-width", Math.max(minimumThumbWidth, Math.min(trackWidth, thumbWidth)) + "px");
    }
    function agentKey(agent) {
      return agent.is_default ? "default" : agent.id;
    }
    function parseAgentAvatarPreset(avatar) {
      const value = String(avatar || "");
      const match = value.match(/^icon:([a-z0-9_-]+)$/i);
      return AGENT_AVATAR_PRESETS.find((item) => item.id === match?.[1] || item.image === value) || null;
    }
    function rasterAgentAvatarPng(value) {
      const source = String(value || "");
      if (/^data:image\/png;base64,/.test(source)) return Promise.resolve(source);
      const preset = parseAgentAvatarPreset(source);
      if (preset) return Promise.resolve(preset.image);
      if (!/^data:image\/(?:jpeg|webp);base64,/.test(source)) return Promise.reject(new Error("invalid_agent_avatar_format"));
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 256;
          canvas.height = 256;
          const context = canvas.getContext("2d");
          if (!context) return reject(new Error("avatar_canvas_unavailable"));
          context.drawImage(image, 0, 0, 256, 256);
          const png = canvas.toDataURL("image/png");
          if (png.length > 4e5) return reject(new Error("agent_avatar_png_too_large"));
          resolve(png);
        };
        image.onerror = () => reject(new Error("agent_avatar_png_conversion_failed"));
        image.src = source;
      });
    }
    async function normalizeAgentAvatarPngs(agents) {
      const normalized = [];
      for (const agent of agents) {
        const source = String(agent?.avatar || "");
        if (!source || /^data:image\/png;base64,/.test(source)) {
          normalized.push(agent);
          continue;
        }
        const avatar = await rasterAgentAvatarPng(source);
        const next = { ...agent, avatar };
        if (!AGENTS_READ_ONLY) {
          const path = agent.is_default ? "/api/agents/default/avatar" : "/api/agents/" + encodeURIComponent(agent.id) + "/avatar";
          await api(path, { method: "PATCH", body: JSON.stringify({ avatar }) });
        }
        normalized.push(next);
      }
      return normalized;
    }
    function agentAvatarMarkup(agent, className) {
      const branded = Boolean(agent?.is_default);
      const preset = parseAgentAvatarPreset(agent?.avatar);
      const customized = Boolean(agent?.avatar) && !preset;
      const fallback = AGENT_AVATAR_PRESETS.find((item) => item.id === "bot");
      const content = customized ? '<img src="' + escapeHtml2(agent.avatar) + '" alt="">' : preset ? '<img src="' + escapeHtml2(preset.image) + '" alt="">' : branded ? codexLogo() : '<img src="' + escapeHtml2(fallback.image) + '" alt="">';
      return '<span class="' + className + " has-image" + (preset ? " is-preset" : branded ? " is-codex" : customized ? "" : " is-fallback") + '">' + content + "</span>";
    }
    function issueUserProfile(issue) {
      if (issue?.assignee_user?.name) return issue.assignee_user;
      if (issue?.assignee_user_id) return state.users.find((user) => user.id === issue.assignee_user_id) || { id: issue.assignee_user_id, name: t("已停用用户"), initials: "?", color: "var(--bc-color-text-faint)", disabled: true };
      return state.user;
    }
    function issueAssigneeValue(issue) {
      if (issue?.agent_enabled) return issue.agent_id || "codex";
      if (issue?.user_assigned) return "user:" + String(issueUserProfile(issue)?.id || "default");
      return "none";
    }
    function userAvatarInitials(name) {
      const source = String(name || "").trim();
      if (!source) return "?";
      const latin = source.match(/[A-Za-z]+/g);
      if (latin && latin.length >= 2) return (latin[0][0] + latin[1][0]).toUpperCase();
      if (latin && latin[0].length >= 2) return latin[0].slice(0, 2).toUpperCase();
      if (latin) return latin[0][0].toUpperCase();
      return Array.from(source.replace(/\s+/g, "")).slice(0, 2).join("") || "?";
    }
    const generatedUserAvatarCache = /* @__PURE__ */ new Map();
    function designToken(name) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (!value) throw new Error("design_token_missing:" + name);
      return value;
    }
    function generatedUserAvatar(name, color) {
      const initials = userAvatarInitials(name);
      const background = USER_AVATAR_COLORS.includes(color) ? color : USER_AVATAR_COLORS[0];
      const key = initials + ":" + background;
      const cached = generatedUserAvatarCache.get(key);
      if (cached) return cached;
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("avatar_canvas_unavailable");
      context.fillStyle = background;
      context.fillRect(0, 0, 256, 256);
      context.fillStyle = designToken("--bc-color-on-avatar");
      context.textAlign = "center";
      context.textBaseline = "middle";
      const family = designToken("--bc-font-ui");
      let fontSize = initials.length > 1 ? 92 : 116;
      context.font = "700 " + fontSize + "px " + family;
      while (context.measureText(initials).width > 176 && fontSize > 54) {
        fontSize -= 2;
        context.font = "700 " + fontSize + "px " + family;
      }
      context.fillText(initials, 128, 132);
      const result = canvas.toDataURL("image/png");
      if (generatedUserAvatarCache.size >= 128) generatedUserAvatarCache.clear();
      generatedUserAvatarCache.set(key, result);
      return result;
    }
    function userAvatarMarkup(user, className) {
      const profile2 = user || state.user;
      const color = USER_AVATAR_COLORS.includes(profile2?.color) ? profile2.color : USER_AVATAR_COLORS[0];
      const image = String(profile2?.avatar || generatedUserAvatar(profile2?.name || profile2?.initials || t("你"), color));
      const title = profile2?.handle ? "@" + profile2.handle : profile2?.name || "";
      return '<span class="' + className + ' is-user has-image" style="background:' + escapeHtml2(color) + '" title="' + escapeHtml2(title) + '" aria-hidden="true"><img src="' + escapeHtml2(image) + '" alt=""></span>';
    }
    function syncAgentAvatar(node, agent) {
      if (!node) return;
      const branded = Boolean(agent?.is_default);
      const preset = parseAgentAvatarPreset(agent?.avatar);
      const customized = Boolean(agent?.avatar) && !preset;
      const fallback = AGENT_AVATAR_PRESETS.find((item) => item.id === "bot");
      node.classList.add("has-image");
      node.classList.toggle("is-preset", Boolean(preset));
      node.classList.toggle("is-codex", !customized && !preset && branded);
      node.classList.toggle("is-fallback", !customized && !preset && !branded);
      node.removeAttribute("data-tone");
      node.innerHTML = customized ? '<img src="' + escapeHtml2(agent.avatar) + '" alt="">' : preset ? '<img src="' + escapeHtml2(preset.image) + '" alt="">' : branded ? codexLogo() : '<img src="' + escapeHtml2(fallback.image) + '" alt="">';
    }
    function agentAvatarEditorMarkup(agent, key) {
      return '<button class="better-codex-agent-avatar-editor" type="button" data-agent-avatar-form="' + escapeHtml2(key) + '" aria-label="' + te("更换 " + (agent?.name || t("智能体")) + " 的头像") + '">' + agentAvatarMarkup(agent, "better-codex-agent-list-avatar") + '<span class="better-codex-agent-avatar-overlay" aria-hidden="true">' + icon("plus") + "</span></button>";
    }
    function chooseAgentAvatar(current = "", anchor = null) {
      avatarPickerClose?.();
      document.getElementById("better-codex-avatar-picker")?.remove();
      return new Promise((resolve) => {
        const picker = document.createElement("div");
        picker.id = "better-codex-avatar-picker";
        picker.setAttribute(OWNED, "true");
        picker.setAttribute("role", "dialog");
        picker.setAttribute("aria-label", t("选择头像"));
        const currentPreset = parseAgentAvatarPreset(current)?.id || "";
        const presets = AGENT_AVATAR_PRESETS.map((item) => '<button class="better-codex-avatar-preset' + (item.id === currentPreset ? " is-selected" : "") + '" type="button" data-avatar-preset="' + escapeHtml2(item.id) + '" title="' + te(item.label) + '" aria-label="' + te(item.label) + '" aria-pressed="' + (item.id === currentPreset) + '"><span class="better-codex-avatar-preset-visual"><img src="' + escapeHtml2(item.image) + '" alt=""></span><span class="better-codex-avatar-preset-label">' + te(item.label) + "</span></button>").join("");
        picker.innerHTML = '<div class="better-codex-avatar-picker-shell"><header><div><strong>' + te("选择头像") + "</strong><span>" + te("从预设图标中选择，也可以上传图片") + '</span></div><button type="button" data-avatar-picker-cancel aria-label="' + te("关闭") + '">' + icon("close") + '</button></header><div class="better-codex-avatar-preset-grid" role="listbox" aria-label="' + te("预设头像") + '">' + presets + '</div><footer><button type="button" data-avatar-picker-cancel>' + te("取消") + '</button><button class="is-primary" type="button" data-avatar-picker-upload>' + icon("image") + "<span>" + te("上传图片") + "</span></button></footer></div>";
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          avatarPickerClose = null;
          document.removeEventListener("mousedown", onDismiss, true);
          document.removeEventListener("keydown", onKeydown, true);
          window.removeEventListener("resize", position);
          picker.remove();
          resolve(value);
        };
        avatarPickerClose = () => finish(null);
        const onDismiss = (event) => {
          if (picker.contains(event.target)) return;
          suppressAgentOutside = true;
          finish(null);
          setTimeout(() => {
            suppressAgentOutside = false;
          }, 0);
        };
        const onKeydown = (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
          }
        };
        const position = () => {
          const width = Math.min(360, window.innerWidth - 16);
          const anchorRect = (anchor || document.body).getBoundingClientRect();
          picker.style.width = width + "px";
          picker.style.left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8)) + "px";
          picker.style.visibility = "hidden";
          picker.style.top = "0px";
          const height = picker.offsetHeight || 280;
          const below = anchorRect.bottom + 8;
          const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchorRect.top - height - 8);
          picker.style.top = top + "px";
          picker.style.visibility = "";
        };
        document.body.appendChild(picker);
        position();
        picker.querySelectorAll("[data-avatar-preset]").forEach((button2) => button2.addEventListener("click", () => finish(AGENT_AVATAR_PRESETS.find((item) => item.id === button2.dataset.avatarPreset)?.image || null)));
        picker.querySelectorAll("[data-avatar-picker-cancel]").forEach((button2) => button2.addEventListener("click", () => finish(null)));
        picker.querySelector("[data-avatar-picker-upload]").addEventListener("click", () => finish("__upload__"));
        window.addEventListener("resize", position);
        setTimeout(() => {
          document.addEventListener("mousedown", onDismiss, true);
          document.addEventListener("keydown", onKeydown, true);
        }, 0);
      }).then(async (value) => {
        if (value !== "__upload__") return value;
        return pickAgentAvatar();
      });
    }
    function cropAgentAvatar(file) {
      return new Promise((resolve, reject) => {
        if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) return reject(new Error("请选择 PNG、JPEG 或 WebP 图片"));
        if (file.size > 10 * 1024 * 1024) return reject(new Error("图片不能超过 10 MB"));
        const source = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
          const size = 512;
          let zoom = 1;
          let offsetX = 0;
          let offsetY = 0;
          let dragging = false;
          let pointerX = 0;
          let pointerY = 0;
          let settled = false;
          const dialog = document.createElement("dialog");
          dialog.id = "better-codex-avatar-cropper";
          dialog.setAttribute(OWNED, "true");
          dialog.innerHTML = '<div class="better-codex-avatar-cropper-shell"><header><div><strong>' + te("裁剪头像") + "</strong><span>" + te("拖动图片调整位置") + '</span></div><button type="button" data-avatar-crop-cancel aria-label="' + te("关闭") + '">' + icon("close") + '</button></header><div class="better-codex-avatar-canvas-wrap"><canvas width="' + size + '" height="' + size + '"></canvas><span class="better-codex-avatar-crop-guide" aria-hidden="true"></span></div><label class="better-codex-avatar-zoom"><span>' + icon("image") + '</span><input type="range" min="1" max="3" value="1" step="0.01" aria-label="' + te("缩放头像") + '"><span>' + icon("image") + '</span></label><footer><button type="button" data-avatar-crop-cancel>' + te("取消") + '</button><button class="is-primary" type="button" data-avatar-crop-save>' + te("使用此头像") + "</button></footer></div>";
          const canvas = dialog.querySelector("canvas");
          const context = canvas.getContext("2d");
          const range = dialog.querySelector('input[type="range"]');
          const baseScale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
          const finish = (value) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(source);
            dialog.close();
            dialog.remove();
            resolve(value);
          };
          const clamp = () => {
            const width = image.naturalWidth * baseScale * zoom;
            const height = image.naturalHeight * baseScale * zoom;
            offsetX = Math.max((size - width) / 2, Math.min((width - size) / 2, offsetX));
            offsetY = Math.max((size - height) / 2, Math.min((height - size) / 2, offsetY));
          };
          const draw = () => {
            clamp();
            const width = image.naturalWidth * baseScale * zoom;
            const height = image.naturalHeight * baseScale * zoom;
            context.clearRect(0, 0, size, size);
            context.drawImage(image, (size - width) / 2 + offsetX, (size - height) / 2 + offsetY, width, height);
          };
          range.addEventListener("input", () => {
            zoom = Number(range.value);
            draw();
          });
          canvas.addEventListener("pointerdown", (event) => {
            dragging = true;
            pointerX = event.clientX;
            pointerY = event.clientY;
            canvas.setPointerCapture(event.pointerId);
          });
          canvas.addEventListener("pointermove", (event) => {
            if (!dragging) return;
            const ratio = size / canvas.getBoundingClientRect().width;
            offsetX += (event.clientX - pointerX) * ratio;
            offsetY += (event.clientY - pointerY) * ratio;
            pointerX = event.clientX;
            pointerY = event.clientY;
            draw();
          });
          canvas.addEventListener("pointerup", () => {
            dragging = false;
          });
          canvas.addEventListener("pointercancel", () => {
            dragging = false;
          });
          dialog.querySelectorAll("[data-avatar-crop-cancel]").forEach((button2) => button2.addEventListener("click", () => finish(null)));
          dialog.querySelector("[data-avatar-crop-save]").addEventListener("click", () => {
            const output = document.createElement("canvas");
            output.width = 256;
            output.height = 256;
            output.getContext("2d").drawImage(canvas, 0, 0, 256, 256);
            finish(output.toDataURL("image/png"));
          });
          dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            finish(null);
          });
          bindModalDismiss(dialog, () => finish(null));
          document.body.appendChild(dialog);
          draw();
          dialog.showModal();
        };
        image.onerror = () => {
          URL.revokeObjectURL(source);
          reject(new Error("无法读取这张图片"));
        };
        image.src = source;
      });
    }
    function pickAgentAvatar() {
      return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp";
        input.addEventListener("change", () => {
          if (!input.files?.[0]) return resolve(null);
          cropAgentAvatar(input.files[0]).then(resolve, reject);
        }, { once: true });
        input.addEventListener("cancel", () => resolve(null), { once: true });
        input.click();
      });
    }
    function applyUserProfile(user) {
      state.user = user;
      state.users = state.users.map((item) => item.id === user.id ? user : item);
      for (const issue of [...state.issues, ...state.projectIssues]) {
        if (issue.assignee_user_id === user.id) issue.assignee_user = user;
      }
      window.dispatchEvent(new CustomEvent("better-codex:bootstrap", { detail: { user, locale: state.locale } }));
      syncMobileActions();
      render();
    }
    function showUserProfileDialog() {
      if (!REMOTE) return;
      const existing = document.getElementById("better-codex-profile-dialog");
      if (existing) {
        existing.querySelector("input")?.focus();
        return;
      }
      const colorLabels = ["蓝色", "紫色", "青色", "绿色", "青柠色", "琥珀色", "橙色", "粉色"];
      let color = USER_AVATAR_COLORS.includes(state.user?.color) ? state.user.color : USER_AVATAR_COLORS[0];
      let avatarGenerated = state.user?.avatar_generated !== false || !state.user?.avatar;
      let avatar = avatarGenerated ? generatedUserAvatar(state.user?.name || t("你"), color) : String(state.user?.avatar || "");
      const colors = USER_AVATAR_COLORS.map((value, index) => '<button class="better-codex-profile-avatar-color' + (value === color ? " is-selected" : "") + '" type="button" data-profile-avatar-color="' + escapeHtml2(value) + '" style="--profile-avatar-color:' + escapeHtml2(value) + '" aria-label="' + te(colorLabels[index]) + '" title="' + te(colorLabels[index]) + '" aria-pressed="' + (value === color) + '">' + icon("check") + "</button>").join("");
      const dialog = document.createElement("dialog");
      dialog.id = "better-codex-profile-dialog";
      dialog.setAttribute(OWNED, "true");
      dialog.setAttribute("aria-labelledby", "better-codex-profile-dialog-title");
      dialog.innerHTML = '<form><header><div><h2 id="better-codex-profile-dialog-title">' + te("个人资料") + "</h2><p>" + te("昵称和头像只用于 WebUI 协作") + '</p></div><button type="button" data-profile-dialog-close aria-label="' + te("关闭") + '">' + icon("close") + '</button></header><div class="better-codex-profile-dialog-body"><button class="better-codex-profile-dialog-avatar-button" type="button" data-profile-dialog-avatar aria-label="' + te("更换头像") + '">' + userAvatarMarkup({ ...state.user, avatar, color }, "better-codex-profile-dialog-avatar") + '<span aria-hidden="true">' + icon("image") + "</span></button><label><span>" + te("昵称") + '</span><input name="nickname" maxlength="80" autocomplete="name" value="' + escapeHtml2(state.user?.name || "") + '" required></label><fieldset><legend>' + te("选择颜色") + '</legend><div class="better-codex-profile-avatar-colors">' + colors + '</div></fieldset><output hidden></output></div><footer><button type="button" data-profile-dialog-cancel>' + te("取消") + '</button><button class="is-primary" type="submit">' + te("保存") + "</button></footer></form>";
      const form = dialog.querySelector("form");
      const avatarButton = dialog.querySelector("[data-profile-dialog-avatar]");
      const input = dialog.querySelector('input[name="nickname"]');
      const output = dialog.querySelector("output");
      const submit = dialog.querySelector('button[type="submit"]');
      const colorButtons = [...dialog.querySelectorAll("[data-profile-avatar-color]")];
      const finish = () => {
        dialog.close();
        dialog.remove();
      };
      const syncPreview = () => {
        avatarButton.querySelector(".better-codex-profile-dialog-avatar")?.remove();
        avatarButton.insertAdjacentHTML("afterbegin", userAvatarMarkup({ ...state.user, name: input.value, avatar, color }, "better-codex-profile-dialog-avatar"));
        for (const button2 of colorButtons) {
          const selected = button2.dataset.profileAvatarColor === color;
          button2.classList.toggle("is-selected", selected);
          button2.setAttribute("aria-pressed", String(selected));
        }
      };
      avatarButton.addEventListener("click", () => {
        void pickAgentAvatar().then((value) => {
          if (!value) return;
          avatar = value;
          avatarGenerated = false;
          syncPreview();
        }).catch((error) => {
          presentInlineError(output, error, error instanceof Error ? t(error.message) : String(error), { source: "profile_avatar", report: false });
        });
      });
      input.addEventListener("input", () => {
        if (!avatarGenerated) return;
        avatar = generatedUserAvatar(input.value || t("你"), color);
        syncPreview();
      });
      for (const button2 of colorButtons) button2.addEventListener("click", () => {
        color = button2.dataset.profileAvatarColor;
        avatarGenerated = true;
        avatar = generatedUserAvatar(input.value || t("你"), color);
        syncPreview();
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const nickname = String(input.value || "").trim();
        if (!nickname) {
          input.focus();
          return;
        }
        if (avatarGenerated) avatar = generatedUserAvatar(nickname, color);
        submit.disabled = true;
        output.hidden = true;
        appendDiagnostic("profile_update_requested", { avatar_changed: avatar !== String(state.user?.avatar || ""), avatar_generated: avatarGenerated, color_changed: color !== String(state.user?.color || ""), nickname_changed: nickname !== String(state.user?.name || "") });
        void api("/api/profile", { method: "PATCH", body: JSON.stringify({ nickname, avatar, avatar_color: color, avatar_generated: avatarGenerated }) }).then((result) => {
          if (!result?.user?.id) throw new Error("invalid_profile_response");
          appendDiagnostic("profile_update_completed", { user_id: result.user.id });
          applyUserProfile(result.user);
          finish();
        }).catch((error) => {
          appendDiagnostic("profile_update_failed", { error: error instanceof Error ? error.message : String(error) });
          presentInlineError(output, error, errorLabel(error), { source: "profile_save" });
        }).finally(() => {
          submit.disabled = false;
        });
      });
      dialog.querySelectorAll("[data-profile-dialog-close], [data-profile-dialog-cancel]").forEach((button2) => button2.addEventListener("click", finish));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish();
      });
      bindModalDismiss(dialog, finish);
      document.body.appendChild(dialog);
      dialog.showModal();
      input.focus();
      input.select();
    }
    function onUserProfileOpen() {
      showUserProfileDialog();
    }
    function modelLabel(value) {
      return state.agentModelCatalog.find((model) => model.id === value)?.displayName || value;
    }
    function effortLabel(value) {
      return t({ low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大", ultra: "极致" }[value] || value);
    }
    function sandboxModeLabel(value) {
      return t({ "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" }[value] || value);
    }
    function modelTag(value) {
      const raw = String(value || "").trim();
      if (!raw || /^默认/.test(raw)) return "";
      return raw.replace(/^gpt[-_]?/i, "").replace(/(^|[-_])([a-z])/g, (_, separator, character) => separator + character.toUpperCase());
    }
    function reasoningTag(value) {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw || /^默认/.test(raw)) return "";
      return { medium: "mid" }[raw] || raw;
    }
    function modelSupportsFast(model) {
      const entry2 = state.agentModelCatalog.find((item) => item.id === model);
      return entry2?.serviceTiers?.some((tier) => ["fast", "priority"].includes(String(tier.id || "").toLowerCase()) || String(tier.name || "").toLowerCase() === "fast") === true;
    }
    function fastMark() {
      return '<span class="better-codex-fast-mark" title="Fast" aria-label="Fast">' + icon("fast", "", "2") + "</span>";
    }
    function agentConfigTags(agent) {
      const model = modelTag(agent?.model);
      const reasoning = reasoningTag(agent?.reasoning_effort);
      return [model ? { value: model, tone: "model", fast: agent?.service_tier === "fast" } : null, reasoning ? { value: reasoning, tone: "reasoning" } : null].filter(Boolean);
    }
    function agentOptionLabel(agent, name) {
      return state.locale === "en" ? String(agent?.name_en || name || "") : name;
    }
    function agentDisplayName(agent) {
      return agentOptionLabel(agent, agent?.name || "");
    }
    function applyAppearance(appearance) {
      let applied;
      try {
        applied = applyHostTheme(appearance, {
          host: HOST_ADAPTER.kind + (HOST_ADAPTER.remote ? ":remote" : ""),
          style: document.documentElement.style,
          colorMixSupported: CSS.supports("color", "color-mix(in srgb, currentColor 50%, transparent)"),
          fontFamilySupported: (value) => CSS.supports("font-family", value)
        });
      } catch (error) {
        throw new Error(JSON.stringify({ code: "theme_apply_failed", host: HOST_ADAPTER.kind, phase: "apply", component: "theme-adapter" }), { cause: error });
      }
      window.__betterCodexThemeDiagnostics__ = applied.diagnostics;
      window.dispatchEvent(new CustomEvent("better-codex:theme-diagnostics", { detail: applied.diagnostics }));
      if (themeIsDegraded(applied.diagnostics)) console.warn("better_codex_theme_degraded", applied.diagnostics);
      if (HOST_KIND === "web") {
        const storedTheme = localStorage.getItem("better-codex-web-theme");
        const configuredTheme = applied.theme.theme;
        const resolvedTheme = storedTheme === "light" || storedTheme === "dark" ? storedTheme : configuredTheme === "light" || configuredTheme === "dark" ? configuredTheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        document.documentElement.dataset.theme = resolvedTheme;
      }
    }
    function effortsForModel(model) {
      const entry2 = state.agentModelCatalog.find((item) => item.id === model);
      return entry2?.supportedReasoningEfforts?.length ? entry2.supportedReasoningEfforts.map((item) => ({ value: item.value, label: effortLabel(item.value), description: item.description || "" })) : state.agentReasoningEfforts.map((value) => ({ value, label: effortLabel(value), description: "" }));
    }
    function agentPicker(name, label2, selected, options) {
      const current = options.find((option) => option.value === selected) || options[0] || { value: "", label: "未提供" };
      const fastSuffix = name === "model" ? fastMark() : "";
      let lastGroup = "";
      const rows = options.map((option) => {
        let groupHeader = "";
        if (option.provider && option.provider !== lastGroup) {
          lastGroup = option.provider;
          groupHeader = '<div class="better-codex-agent-menu-group">' + escapeHtml2(option.provider) + "</div>";
        }
        const hasDescription = Boolean(option.description);
        const copy = hasDescription ? '<span class="better-codex-agent-menu-item-copy">' + (option.icon ? '<span class="better-codex-agent-menu-item-icon">' + icon(option.icon) + "</span>" : "") + "<span><strong>" + escapeHtml2(option.label) + "</strong><small>" + escapeHtml2(option.description) + "</small></span></span>" : '<span class="better-codex-agent-menu-item-copy">' + (option.icon ? '<span class="better-codex-agent-menu-item-icon">' + icon(option.icon) + "</span>" : "") + "<span>" + escapeHtml2(option.label) + "</span></span>";
        return groupHeader + '<button class="better-codex-agent-menu-item' + (option.value === current.value ? " is-selected" : "") + (option.tone === "warning" ? " is-warning" : "") + '" type="button" role="option" aria-selected="' + (option.value === current.value) + '" data-agent-option="' + escapeHtml2(name) + '" data-agent-option-value="' + escapeHtml2(option.value) + '">' + copy + '<span class="better-codex-agent-menu-item-check">' + (option.value === current.value ? icon("check") : "") + "</span></button>";
      }).join("");
      return '<div class="better-codex-agent-setting" data-agent-picker="' + escapeHtml2(name) + '"><span>' + escapeHtml2(label2) + '</span><input type="hidden" name="' + escapeHtml2(name) + '" value="' + escapeHtml2(current.value) + '"><button class="better-codex-agent-picker-trigger" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" data-agent-picker-toggle="' + escapeHtml2(name) + '"><span data-agent-picker-label>' + escapeHtml2(current.label) + "</span>" + fastSuffix + icon("chevron") + '</button><div class="better-codex-agent-menu" role="listbox"><div class="better-codex-agent-menu-title">' + escapeHtml2(label2) + "</div>" + rows + "</div></div>";
    }
    function agentNumberInput(name, label2, value, min, max) {
      const numericValue = Number(value);
      const current = Number.isInteger(numericValue) ? Math.min(max, Math.max(min, numericValue)) : 5;
      return '<label class="better-codex-agent-setting"><span>' + escapeHtml2(label2) + '</span><input class="better-codex-agent-number-input" type="number" name="' + escapeHtml2(name) + '" min="' + min + '" max="' + max + '" step="1" value="' + current + '" aria-label="' + escapeHtml2(label2) + '"></label>';
    }
    function agentFastToggle(checked, enabled) {
      return '<label class="better-codex-agent-setting better-codex-agent-fast-setting' + (enabled ? "" : " is-disabled") + '"><span><strong>' + te("Fast") + "</strong><small>" + te("更快响应，增加用量") + '</small></span><span class="better-codex-agent-switch"><input type="checkbox" name="fast" aria-label="Fast"' + (checked ? " checked" : "") + (enabled ? "" : " disabled") + "><i></i></span></label>";
    }
    const suggestedAgents = config.suggestedAgents;
    let agentAutosaveTimer = null;
    let agentAutosavePending = null;
    let agentAutosaveRunning = null;
    function agentInspectorWidthLimit() {
      const available = panel?.getBoundingClientRect().width || window.innerWidth;
      return Math.max(AGENT_INSPECTOR_MIN_WIDTH, Math.floor(available - AGENT_DIRECTORY_MIN_WIDTH));
    }
    function clampAgentInspectorWidth(width) {
      return Math.round(Math.min(agentInspectorWidthLimit(), Math.max(AGENT_INSPECTOR_MIN_WIDTH, Number(width) || AGENT_INSPECTOR_MIN_WIDTH)));
    }
    function applyAgentInspectorWidth(inspector, width = state.agentInspectorWidth) {
      if (!inspector || window.matchMedia?.("(max-width: 720px)")?.matches) return;
      if (!width) {
        inspector.style.removeProperty("--bc-agent-inspector-width");
        delete inspector.dataset.resized;
        const defaultHandle = inspector.querySelector("[data-agent-inspector-resize]");
        defaultHandle?.setAttribute("aria-valuemin", String(AGENT_INSPECTOR_MIN_WIDTH));
        defaultHandle?.setAttribute("aria-valuemax", String(agentInspectorWidthLimit()));
        defaultHandle?.setAttribute("aria-valuenow", String(Math.round(inspector.getBoundingClientRect().width)));
        return;
      }
      const nextWidth = clampAgentInspectorWidth(width);
      state.agentInspectorWidth = nextWidth;
      inspector.dataset.resized = "true";
      inspector.style.setProperty("--bc-agent-inspector-width", nextWidth + "px");
      const handle = inspector.querySelector("[data-agent-inspector-resize]");
      handle?.setAttribute("aria-valuemin", String(AGENT_INSPECTOR_MIN_WIDTH));
      handle?.setAttribute("aria-valuemax", String(agentInspectorWidthLimit()));
      handle?.setAttribute("aria-valuenow", String(nextWidth));
    }
    function persistAgentInspectorWidth() {
      if (!state.agentInspectorWidth) return;
      localStorage.setItem(AGENT_INSPECTOR_WIDTH_KEY, String(state.agentInspectorWidth));
    }
    function onAgentInspectorResizeStart(event) {
      const handle = event.target.closest("[data-agent-inspector-resize]");
      if (!handle || event.button !== 0 || window.matchMedia?.("(max-width: 720px)")?.matches) return;
      const inspector = handle.closest(".better-codex-agent-inspector");
      if (!inspector) return;
      agentInspectorResize = { pointerId: event.pointerId, startX: event.clientX, startWidth: inspector.getBoundingClientRect().width, handle, inspector };
      inspector.classList.add("is-resizing");
      panel.dataset.agentResizing = "true";
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    function onAgentInspectorResizeMove(event) {
      if (!agentInspectorResize || event.pointerId !== agentInspectorResize.pointerId) return;
      applyAgentInspectorWidth(agentInspectorResize.inspector, agentInspectorResize.startWidth + agentInspectorResize.startX - event.clientX);
      event.preventDefault();
    }
    function finishAgentInspectorResize(event) {
      if (!agentInspectorResize || event.pointerId !== agentInspectorResize.pointerId) return;
      const { handle, inspector, pointerId } = agentInspectorResize;
      agentInspectorResize = null;
      inspector.classList.remove("is-resizing");
      delete panel.dataset.agentResizing;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      persistAgentInspectorWidth();
    }
    function onAgentInspectorResizeKeydown(event) {
      const handle = event.target.closest("[data-agent-inspector-resize]");
      if (!handle || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return false;
      const inspector = handle.closest(".better-codex-agent-inspector");
      if (!inspector) return false;
      const currentWidth = inspector.getBoundingClientRect().width;
      const step = event.shiftKey ? 48 : 16;
      const nextWidth = event.key === "Home" ? AGENT_INSPECTOR_MIN_WIDTH : event.key === "End" ? agentInspectorWidthLimit() : currentWidth + (event.key === "ArrowLeft" ? step : -step);
      applyAgentInspectorWidth(inspector, nextWidth);
      persistAgentInspectorWidth();
      event.preventDefault();
      return true;
    }
    function closeAgentInspector() {
      if (state.agentPane === "preview") return;
      state.agentPane = "preview";
      state.selectedAgentId = "";
      state.agentDraft = null;
      renderAgents();
      if (HOST_KIND !== "web" || !webAgentRoute()?.agentKey) return;
      if (history.state?.betterCodexAgentFromList) history.back();
      else syncWebAgentRoute("", "replace");
    }
    function skillAvailableForProject(skill, projectId) {
      return skill?.scope === "project" ? Boolean(projectId) && skill.project_id === projectId : !skill?.project_id && (!skill?.scope || skill.scope === "global");
    }
    function skillScopeLabel(skill) {
      if (skill?.scope !== "project") return t("通用 Skill");
      return projectLabel(state.projects?.find(project => project.id === skill.project_id)) || t("项目专属 Skill");
    }
    function renderAgents() {
      const container = panel?.querySelector("#better-codex-agents");
      if (!container) return;
      panel.dataset.agentPane = state.agentPane;
      const query = state.agentSearch.trim().toLowerCase();
      const skills = [...(state.skillsManaged || []), ...(state.skillsExternal || []).map((item) => ({ ...item, external: true }))];
      const scopeFilter = state.skillScopeFilter || "all";
      const scopeOptions = [{ id: "all", label: t("全部范围") }, { id: "global", label: t("通用 Skill") }, ...(state.projects || []).map(project => ({ id: "project:" + project.id, label: projectLabel(project) }))];
      const scopePicker = '<label class="better-codex-agent-inspector-field"><span>' + te("适用范围") + '</span><select class="better-codex-search" data-skill-scope-filter aria-label="' + te("适用范围") + '">' + scopeOptions.map(option => '<option value="' + escapeHtml2(option.id) + '"' + (option.id === scopeFilter ? ' selected' : '') + '>' + escapeHtml2(option.label) + '</option>').join("") + '</select></label>';
      const rows = skills.filter((item) => (state.agentView === "all" || (state.agentView === "external" ? item.external : !item.external)) && (scopeFilter === "all" || scopeFilter === "global" && skillAvailableForProject(item, "") || scopeFilter.startsWith("project:") && item.scope === "project" && item.project_id === scopeFilter.slice(8)) && (!query || [item.name, item.description].some((value) => String(value || "").toLowerCase().includes(query)))).map((item, index) => '<button class="better-codex-agent-row" type="button" data-skill-key="' + escapeHtml2(String(item.id || item.path || index)) + '"><span class="better-codex-agent-list-avatar">' + icon("sparkles") + '</span><span class="better-codex-agent-row-copy"><strong>' + escapeHtml2(item.name) + '</strong><span>' + escapeHtml2(item.description || "") + '</span><em>' + escapeHtml2(skillScopeLabel(item)) + (item.external ? ' · ' + te("外部 Skill · 只读") : '') + (item.source_update_available ? ' · ' + te("来源有更新") : '') + '</em></span>' + icon("chevron") + '</button>').join("");
      const selected = skills.find((item, index) => String(item.id || item.path || index) === state.selectedSkillId);
      const draft = state.agentPane === "create" ? state.skillDraft || {} : selected?.external ? selected : state.skillEditDrafts?.[selected?.id] || selected;
      const creating = state.agentPane === "create";
      const deriving = creating && Boolean(draft?.source_id);
      const readOnly = Boolean(draft?.external);
      const fields = draft ? [["名称", "name", 2], ["介绍", "description", 3], ["指令", "instructions", 12]].map(([title, name, rows]) => '<label class="better-codex-agent-inspector-field"><span>' + te(title) + '</span>' + (name === "name" ? '<input name="name" required value="' + escapeHtml2(draft.name || "") + '"' + (readOnly ? ' readonly' : '') + '>' : '<textarea name="' + name + '" rows="' + rows + '"' + (readOnly || deriving && name === "instructions" ? ' readonly' : '') + '>' + escapeHtml2(draft[name] || "") + '</textarea>') + '</label>').join("") : '';
      const assignment = draft ? '<label class="better-codex-agent-inspector-field"><span>' + te("归属") + '</span>' + (creating ? '<select class="better-codex-search" name="project_id"' + (deriving ? ' required' : '') + '><option value="">' + te(deriving ? "选择项目" : "通用 Skill") + '</option>' + (state.projects || []).map(project => '<option value="' + escapeHtml2(project.id) + '"' + (draft.project_id === project.id ? ' selected' : '') + '>' + escapeHtml2(projectLabel(project)) + '</option>').join("") + '</select>' : '<span>' + escapeHtml2(skillScopeLabel(draft)) + '</span>') + '</label>' : '';
      const sourceInfo = draft?.source_skill_id || deriving ? '<p>' + te("来源 Skill") + ' · ' + escapeHtml2(draft.source_name || skills.find(item => item.id === (draft.source_skill_id || draft.source_id))?.name || draft.source_skill_id || draft.source_id) + (draft.source_version ? ' · ' + te("版本") + ' ' + escapeHtml2(draft.source_version) : '') + (draft.source_update_available ? ' · ' + te("来源有更新，当前版本继续保留") : '') + '</p>' : '';
      const deriveButton = !creating && draft?.id ? '<button type="button" data-skill-derive="' + escapeHtml2(draft.id) + '">' + te("创建项目专属版本") + '</button>' : '';
      const inspector = draft ? '<aside class="better-codex-agent-inspector"><form data-skill-form="' + (deriving ? 'derive' : creating ? 'create' : 'update') + '" data-skill-id="' + escapeHtml2(draft.id || '') + '"><header class="better-codex-agent-inspector-head"><strong>' + te(deriving ? "创建项目专属 Skill" : creating ? "新建 Skill" : "Skill 详情") + '</strong><button type="button" data-skill-close>' + icon("close") + '</button></header><div class="better-codex-agent-inspector-scroll">' + assignment + sourceInfo + fields + (readOnly ? '<p>' + te("在 Codex 会话中使用 $" + (draft.slug || draft.name) + " 调用此 Skill。") + '</p>' : '') + '<output data-skill-error hidden></output></div><footer class="better-codex-agent-inspector-footer">' + deriveButton + (!readOnly ? (!creating && !draft.builtin ? '<button type="button" data-skill-delete="' + escapeHtml2(draft.id) + '">' + te("删除") + '</button>' : '') + '<button class="better-codex-submit" type="submit">' + te(creating ? "创建" : "保存") + '</button>' : '') + '</footer></form></aside>' : '';
      container.innerHTML = '<div class="better-codex-agent-shell" data-pane="' + state.agentPane + '"><section class="better-codex-agent-directory"><header class="better-codex-agent-page-heading"><h1>' + te("Skill 管理") + '</h1><p>' + te("管理通用与项目专属的操作指引") + '</p></header><div class="better-codex-agent-search-wrap">' + icon("search") + '<input class="better-codex-search" data-agent-search type="search" value="' + escapeHtml2(state.agentSearch) + '" placeholder="' + te("搜索 Skill") + '"></div>' + scopePicker + '<div class="better-codex-agent-list">' + (rows || '<div class="better-codex-agent-list-empty">' + te("暂无 Skill") + '</div>') + '</div></section>' + inspector + '</div>';
    }
    async function loadSkills(options = {}) {
      if (!state.nativePlanningEnabled) return;
      const result = await api("/api/skills", { passive: Boolean(options.background) });
      state.skillsManaged = Array.isArray(result.managed) ? result.managed : [];
      state.skillsExternal = Array.isArray(result.external) ? result.external : [];
    }
    function onSkillSubmit(event) {
      const form = event.target.closest("[data-skill-form]");
      if (!form) return false;
      event.preventDefault();
      const selected = state.skillsManaged?.find((item) => item.id === form.dataset.skillId);
      const creating = form.dataset.skillForm === "create";
      const deriving = form.dataset.skillForm === "derive";
      const projectId = form.elements.project_id?.value || selected?.project_id || null;
      const body = deriving ? { source_id: state.skillDraft.source_id, project_id: projectId, name: form.elements.name.value, description: form.elements.description.value } : { name: form.elements.name.value, description: form.elements.description.value, instructions: form.elements.instructions.value, scope: projectId ? "project" : "global", project_id: projectId, ...selected ? { version: selected.version } : {} };
      void perform(async () => {
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          const saved = await api(deriving ? "/api/skills/derive" : creating ? "/api/skills" : "/api/skills/" + encodeURIComponent(selected.id), { method: creating || deriving ? "POST" : "PATCH", body: JSON.stringify(body) });
          state.selectedSkillId = saved.skill?.id || saved.id;
          if (state.skillEditDrafts) delete state.skillEditDrafts[state.selectedSkillId];
          state.agentPane = "detail";
          state.skillScopeFilter = "all";
          await loadSkills();
          renderAgents();
        } catch (error) {
          const output = form.querySelector("[data-skill-error]");
          output.textContent = errorLabel(error); output.hidden = false;
        } finally { if (submit.isConnected) submit.disabled = false; }
      });
      return true;
    }
    function projectRootPaths(project) {
      const paths = Array.isArray(project?.root_paths) ? project.root_paths.map(String).filter(Boolean) : [];
      if (!paths.length && project?.workspace_path) paths.push(String(project.workspace_path));
      return paths;
    }
    function normalizedProjectDocumentViews(project) {
      const source = Array.isArray(project?.document_views) ? project.document_views : [];
      return projectDocumentViews.map((definition) => {
        const view = source.find((item) => item?.key === definition.key);
        if (view) return { ...definition, ...view };
        if (definition.key === "charter" && project?.overview_html) return { ...definition, status: "ready", markdown: "", html: project.overview_html, diagram: null, error: null, updated_at: project.overview_updated_at || null };
        return { ...definition, status: "idle", markdown: "", html: "", diagram: null, error: null, updated_at: null };
      });
    }
    function projectDocumentAgentPicker(selectedId) {
      const defaultAgent = state.agents.find((agent) => agent.is_default);
      const options = [{ value: "", label: t("使用默认智能体"), agent: defaultAgent }, ...state.agents.filter((agent) => !agent.is_default && agent.id).map((agent) => ({ value: agent.id, label: agentDisplayName(agent), agent }))];
      const current = options.find((option) => option.value === selectedId) || options[0];
      const avatar = (option) => option.agent ? agentAvatarMarkup(option.agent, "better-codex-project-document-agent-avatar") : '<span class="better-codex-project-document-agent-avatar">' + codexLogo() + "</span>";
      const rows = options.map((option) => '<button class="better-codex-agent-menu-item' + (option.value === current.value ? " is-selected" : "") + '" type="button" role="option" aria-selected="' + String(option.value === current.value) + '" data-project-document-agent-option="' + escapeHtml2(option.value) + '"><span class="better-codex-agent-menu-item-copy">' + avatar(option) + "<span>" + escapeHtml2(option.label) + '</span></span><span class="better-codex-agent-menu-item-check">' + (option.value === current.value ? icon("check") : "") + "</span></button>").join("");
      return '<div class="better-codex-project-document-agent-picker better-codex-agent-setting" data-project-document-agent-picker><span>' + te("生成智能体") + '</span><input type="hidden" name="agent_id" value="' + escapeHtml2(current.value) + '"><button class="better-codex-agent-picker-trigger" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" data-project-document-agent-toggle><span>' + avatar(current) + "<span data-project-document-agent-label>" + escapeHtml2(current.label) + "</span></span>" + icon("chevron") + '</button><div class="better-codex-agent-menu" role="listbox"><div class="better-codex-agent-menu-title">' + te("生成智能体") + "</div>" + rows + "</div></div>";
    }
    function projectDocumentErrorLabel(error) {
      const value = String(error || "");
      if (value === "project_overview_timeout") return t("项目文档生成超时，请重试。");
      if (value === "remote_command_timeout") return t("运行端未及时响应，请确认 Better Codex 在线后重试。");
      if (value === "workspace_missing") return t("项目文件夹不可用，无法生成文档。");
      return t("项目文档生成未能完成，请重试。");
    }
    function projectDocumentDiagramMarkup(diagram) {
      if (!diagram || !Array.isArray(diagram.nodes) || !diagram.nodes.length) return "";
      const groups = [];
      for (const node of diagram.nodes) {
        const label2 = String(node.group || t("视图关系"));
        let group = groups.find((item) => item.label === label2);
        if (!group) {
          group = { label: label2, nodes: [] };
          groups.push(group);
        }
        group.nodes.push(node);
      }
      const columns = groups.map((group) => '<section class="better-codex-project-document-group"><strong>' + escapeHtml2(group.label) + "</strong><div>" + group.nodes.map((node) => '<article class="better-codex-project-document-node" data-project-document-node="' + escapeHtml2(node.id) + '"><b>' + escapeHtml2(node.label) + "</b>" + (node.detail ? "<span>" + escapeHtml2(node.detail) + "</span>" : "") + "</article>").join("") + "</div></section>").join("");
      const relations = Array.isArray(diagram.edges) && diagram.edges.length ? '<div class="better-codex-project-document-relations">' + diagram.edges.map((edge) => "<span><b>" + escapeHtml2(edge.from) + "</b>" + icon("chevron") + "<b>" + escapeHtml2(edge.to) + "</b>" + (edge.label ? "<em>" + escapeHtml2(edge.label) + "</em>" : "") + "</span>").join("") + "</div>" : "";
      return '<section class="better-codex-project-document-diagram" data-project-document-diagram><div class="better-codex-project-document-diagram-head"><strong>' + te("视图关系") + "</strong><span>" + escapeHtml2(diagram.nodes.length + " / " + (diagram.edges?.length || 0)) + '</span></div><div class="better-codex-project-document-graph"><svg aria-hidden="true"></svg><div class="better-codex-project-document-groups">' + columns + "</div></div>" + relations + "</section>";
    }
    function layoutProjectDocumentDiagrams(container) {
      container.querySelectorAll("[data-project-document-diagram]").forEach((diagram) => {
        const svg = diagram.querySelector("svg");
        const graph = diagram.querySelector(".better-codex-project-document-graph");
        const project = state.projects.find((item) => item.id === state.projectDetailId);
        const view = normalizedProjectDocumentViews(project).find((item) => item.key === state.projectDocumentView);
        if (!svg || !graph || !view?.diagram?.edges) return;
        const bounds = graph.getBoundingClientRect();
        svg.setAttribute("viewBox", "0 0 " + Math.max(1, bounds.width) + " " + Math.max(1, bounds.height));
        svg.innerHTML = '<defs><marker id="better-codex-project-document-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>';
        const nodes = Array.from(diagram.querySelectorAll("[data-project-document-node]"));
        for (const edge of view.diagram.edges) {
          const from = nodes.find((node) => node.dataset.projectDocumentNode === edge.from);
          const to = nodes.find((node) => node.dataset.projectDocumentNode === edge.to);
          if (!from || !to) continue;
          const a = from.getBoundingClientRect();
          const b = to.getBoundingClientRect();
          const leftToRight = b.left >= a.right;
          const x1 = (leftToRight ? a.right : a.left + a.width / 2) - bounds.left;
          const y1 = a.top + a.height / 2 - bounds.top;
          const x2 = (leftToRight ? b.left : b.left + b.width / 2) - bounds.left;
          const y2 = b.top + b.height / 2 - bounds.top;
          const distance = Math.max(28, Math.abs(x2 - x1) * 0.42);
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", "M " + x1 + " " + y1 + " C " + (x1 + distance) + " " + y1 + ", " + (x2 - distance) + " " + y2 + ", " + x2 + " " + y2);
          path.setAttribute("marker-end", "url(#better-codex-project-document-arrow)");
          svg.append(path);
        }
      });
    }
    function projectDocumentLoading(view, overallError = "") {
      const failed = view.status === "failed" || Boolean(overallError);
      const idle = view.status === "idle" && !failed;
      const title = failed ? "生成失败" : view.status === "queued" ? "等待生成" : idle ? "尚未生成这个视图" : "这个视图正在形成";
      const copy = failed ? projectDocumentErrorLabel(view.error || overallError) : idle ? t("选择智能体后生成七个相互关联的项目视图。") : t("代码、Issue 与会话证据正在被整理为结构化文档。");
      const active2 = ["queued", "generating"].includes(view.status);
      return '<div class="better-codex-project-document-loading' + (failed ? " is-error" : "") + '"><span class="better-codex-project-document-orbit' + (active2 ? " is-active" : "") + '">' + icon(failed ? "shield" : "sparkles") + "</span><strong>" + te(title) + "</strong><p>" + escapeHtml2(copy) + "</p>" + (active2 ? '<div class="better-codex-project-document-skeleton"><i></i><i></i><i></i><i></i></div>' : "") + "</div>";
    }
    function projectPlanningState(project) {
      const planning = project.planning || {};
      return {
        status: ["idle", "running", "ready", "failed", "paused"].includes(planning.status) ? planning.status : "idle",
        error: planning.error || null,
        agent_id: planning.agent_id || null,
        revision: Number(planning.revision) || 0,
        updated_at: planning.updated_at || null,
        messages: Array.isArray(planning.messages) ? planning.messages : [],
        plan: planning.plan || null
      };
    }
    function projectPlanningSourceLabel(source) {
      return t({ code: "代码事实", issue: "Issue 事实", conversation: "会话事实", user: "用户输入", inference: "智能体推断" }[source] || "智能体推断");
    }
    function projectPlanningStatusLabel(status) {
      return t({ proposed: "建议", confirmed: "已确认", in_progress: "进行中", blocked: "阻塞", done: "已完成" }[status] || "建议");
    }
    function projectPlanningItemMarkup(item, index) {
      const dependencies = Array.isArray(item.dependencies) && item.dependencies.length ? "<span>" + te("依赖") + " " + escapeHtml2(item.dependencies.join("、")) + "</span>" : "";
      const evidence = Array.isArray(item.evidence) && item.evidence.length ? "<details><summary>" + te("证据") + " " + escapeHtml2(String(item.evidence.length)) + "</summary><ul>" + item.evidence.map((value) => "<li>" + escapeHtml2(value) + "</li>").join("") + "</ul></details>" : "";
      const date = item.target_date ? '<time datetime="' + escapeHtml2(item.target_date) + '">' + escapeHtml2(item.target_date) + "</time>" : "";
      return '<article class="better-codex-project-plan-item" data-plan-status="' + escapeHtml2(item.status || "proposed") + '"><span class="better-codex-project-plan-index">' + escapeHtml2(String(index + 1).padStart(2, "0")) + "</span><div><header><strong>" + escapeHtml2(item.title || t("待确认")) + '</strong><span class="better-codex-project-plan-status">' + escapeHtml2(projectPlanningStatusLabel(item.status)) + "</span></header>" + (item.detail ? "<p>" + escapeHtml2(item.detail) + "</p>" : "") + '<footer><span data-plan-source="' + escapeHtml2(item.source || "inference") + '">' + escapeHtml2(projectPlanningSourceLabel(item.source)) + "</span>" + date + dependencies + "</footer>" + evidence + "</div></article>";
    }
    function projectPlanningTimelineMarkup(plan) {
      const milestones = Array.isArray(plan?.milestones) ? plan.milestones.map((item, index) => ({ item, index })) : [];
      if (!milestones.length) return "";
      milestones.sort((left, right) => {
        if (left.item.target_date && right.item.target_date) return left.item.target_date.localeCompare(right.item.target_date) || left.index - right.index;
        if (left.item.target_date) return -1;
        if (right.item.target_date) return 1;
        return left.index - right.index;
      });
      const dated = milestones.filter((entry2) => entry2.item.target_date).length;
      const rows = milestones.map(({ item }) => {
        const date = item.target_date ? '<time class="better-codex-project-plan-timeline-date" datetime="' + escapeHtml2(item.target_date) + '">' + escapeHtml2(item.target_date) + "</time>" : '<span class="better-codex-project-plan-timeline-date" data-pending="true">' + te("日期待定") + "</span>";
        const dependencies = Array.isArray(item.dependencies) && item.dependencies.length ? "<span>" + te("依赖") + " " + escapeHtml2(item.dependencies.join("、")) + "</span>" : "";
        return '<li data-plan-status="' + escapeHtml2(item.status || "proposed") + '">' + date + '<span class="better-codex-project-plan-timeline-rail" aria-hidden="true"></span><div class="better-codex-project-plan-timeline-copy"><header><strong>' + escapeHtml2(item.title || t("待确认")) + '</strong><span class="better-codex-project-plan-status">' + escapeHtml2(projectPlanningStatusLabel(item.status)) + "</span></header>" + (item.detail ? "<p>" + escapeHtml2(item.detail) + "</p>" : "") + "<footer><span>" + escapeHtml2(projectPlanningSourceLabel(item.source)) + "</span>" + dependencies + "</footer></div></li>";
      }).join("");
      return '<section class="better-codex-project-plan-timeline" aria-label="' + te("里程碑时间线") + '"><header><div><strong>' + te("里程碑时间线") + "</strong><span>" + te("按目标日期排序") + "</span></div><span>" + escapeHtml2(dated + "/" + milestones.length + " " + t("已排期")) + "</span></header><ol>" + rows + "</ol></section>";
    }
    function projectPlanningSection(plan, key, label2) {
      const items = Array.isArray(plan?.[key]) ? plan[key] : [];
      if (!items.length) return "";
      return '<section class="better-codex-project-plan-section" data-plan-section="' + escapeHtml2(key) + '"><header><strong>' + te(label2) + "</strong><span>" + escapeHtml2(String(items.length)) + "</span></header><div>" + items.map((item, index) => projectPlanningItemMarkup(item, index)).join("") + "</div></section>";
    }
    function projectPlanningErrorLabel(error) {
      const value = String(error || "");
      if (value === "project_planning_timeout") return t("本次规划超过等待时限，已保留对话和进展，请继续发送消息。");
      if (value === "project_planning_busy") return t("规划会话正在运行，请等待完成。");
      if (value === "workspace_missing") return t("项目文件夹不可用，无法生成文档。");
      if (value === "remote_command_timeout") return t("运行端未及时响应，请确认 Better Codex 在线后重试。");
      return t("规划会话未能完成，请重试。");
    }
    function projectDocumentValue(value) {
      if (Array.isArray(value)) return value.map(projectDocumentValue).filter(Boolean).join("\n");
      if (value && typeof value === "object") return Object.values(value).map(projectDocumentValue).filter(Boolean).join("\n");
      return value == null ? "" : String(value);
    }
    function documentTextMarkup(value) {
      return '<p style="white-space:pre-wrap">' + escapeHtml2(projectDocumentValue(value)) + '</p>';
    }
    function issuePlanDetailMarkup(issue) {
      return [["架构与实现", issue?.architecture || issue?.implementation_plan], ["验收标准", issue?.acceptance_criteria || issue?.acceptance]].filter(([, value]) => projectDocumentValue(value)).map(([title, value]) => '<section class="better-codex-project-plan-section"><header><strong>' + te(title) + '</strong></header>' + documentTextMarkup(value) + '</section>').join("");
    }
    function planItemDetailsMarkup(item) {
      return [["范围", item.scope], ["相关目录", item.directories], ["交付物", item.deliverables], ["依赖", item.dependencies], ["人工步骤", item.manual_steps], ["待确认事项", item.unresolved_questions]].filter(([, value]) => projectDocumentValue(value)).map(([title, value]) => '<section><strong>' + te(title) + '</strong>' + documentTextMarkup(value) + '</section>').join("");
    }
    function planningStageTabsMarkup(projectId, stage, available, inline = false) {
      return '<nav class="bc-planning-stage-tabs" role="tablist" aria-label="' + te("规划会话") + '">' + ["charter", "planning"].map(kind => '<button type="button" role="tab" aria-selected="' + String(stage === kind) + '" ' + (inline ? 'data-inline-stage="' + kind + '"' : 'data-project-native-session="' + kind + '" data-project-id="' + escapeHtml2(projectId) + '"') + (kind === "planning" && !available ? ' disabled title="' + te("请先确认项目总纲") + '"' : '') + '>' + icon(kind === "planning" ? "board" : "docs") + '<span>' + te(kind === "planning" ? "任务规划会话" : "总纲会话") + '</span></button>').join("") + '</nav>';
    }
    function readProjectView(projectId) {
      try {
        const saved = JSON.parse(localStorage.getItem("better-codex-project-view:" + projectId) || "null");
        if (!saved || !["overview", "planning", "work"].includes(saved.page)) return { page: "overview", stage: "charter" };
        const view = { page: saved.page, stage: saved.stage === "planning" ? "planning" : "charter", conversations: {} };
        for (const kind of ["charter", "planning"]) if (typeof saved.conversations?.[kind] === "string") view.conversations[kind] = saved.conversations[kind];
        const target = saved.target;
        if (target?.project_id === projectId && ["charter", "planning", "work"].includes(target.kind) && (view.page === "planning" ? target.kind === view.stage : view.page === "work" && target.kind === "work")) {
          view.target = { project_id: projectId, kind: target.kind };
          for (const key of ["issue_id", "conversation_id", "history_id"]) if (typeof target[key] === "string" && target[key]) view.target[key] = target[key];
          if (target.kind === "work" && !view.target.issue_id) delete view.target;
        }
        return view;
      } catch { return { page: "overview", stage: "charter" }; }
    }
    function rememberProjectView() {
      const projectId = state.projectDetailId;
      if (!projectId || !["overview", "planning", "work"].includes(state.projectPage)) return;
      const previous = readProjectView(projectId);
      const view = { page: state.projectPage, stage: state.projectDocumentView === "planning" ? "planning" : "charter", conversations: previous.conversations || {} };
      const target = inlineConversation ? inlineConversationTarget() : null;
      if (target?.project_id === projectId && (view.page === "work" ? target.kind === "work" : view.page === "planning" && target.kind === view.stage)) {
        view.target = { project_id: projectId, kind: target.kind };
        for (const key of ["issue_id", "conversation_id", "history_id"]) if (typeof target[key] === "string" && target[key]) view.target[key] = target[key];
        if (target.kind !== "work" && target.conversation_id) view.conversations[target.kind] = target.conversation_id;
      }
      try { localStorage.setItem("better-codex-project-view:" + projectId, JSON.stringify(view)); localStorage.setItem("better-codex-managed-project", projectId); } catch {}
    }
    function applyProjectView(projectId) {
      const view = readProjectView(projectId);
      state.projectPage = view.page;
      state.projectDocumentView = view.stage;
      state.projectResumePending = projectId;
    }
    async function resumeProjectView(projectId) {
      if (state.projectResumePending !== projectId || state.projectDetailId !== projectId || !active || inlineConversation) return;
      state.projectResumePending = "";
      const saved = readProjectView(projectId), navigation = inlineConversationNavigationRequest;
      if (saved.target) {
        const rows = saved.target.kind === "work" ? await loadProjectWorkConversations(projectId) : await loadProjectNativeConversations(projectId);
        if (destroyed || !active || state.projectDetailId !== projectId || navigation !== inlineConversationNavigationRequest || inlineConversation) return;
        const valid = rows.some(row => (saved.target.kind !== "work" || row.issue_id === saved.target.issue_id) && (row.kind || saved.target.kind) === saved.target.kind && (!saved.target.conversation_id || row.conversation_id === saved.target.conversation_id) && (row.history_id || "") === (saved.target.history_id || ""));
        if (valid) return openInlineConversation(saved.target);
      }
      if (saved.page === "planning" && state.nativePlanningEnabled) {
        const context = state.planningContexts?.[projectId];
        const stage = saved.stage === "planning" && context?.charter?.status !== "confirmed" ? "charter" : saved.stage;
        return openProjectNativeSession(projectId, stage);
      }
    }
    function projectCharterConfirmationState(projectId, options = {}) {
      const context = state.planningContexts?.[projectId];
      const charter = context?.charter || (state.projects || []).find(project => project.id === projectId)?.charter || {};
      const current = options.inline && inlineConversationTarget().project_id === projectId ? inlineConversation : null;
      const session = context?.sessions?.charter;
      const revision = Number(charter.revision || 0);
      const pending = state.charterConfirmationPending?.projectId === projectId;
      const readOnly = Boolean(READ_ONLY || context?.read_only || current && (current.read_only || inlineConversationTarget().history_id));
      const busy = session?.status === "running" || current && (inlineConversationLoading || current.pending_operation || current.target?.kind === "charter" && current.binding?.status === "running");
      const threadId = current && inlineConversationTarget().kind === "charter" ? current.thread_id || current.binding?.thread_id : session?.thread_id;
      return { revision, pending, readOnly, busy: Boolean(busy), threadId, confirmed: charter.status === "confirmed", available: state.nativePlanningEnabled === true && charter.status === "draft" && revision > 0 && !state.charterConfirmationPending && !readOnly && !busy };
    }
    async function confirmProjectCharter(button) {
      const projectId = button.dataset.projectCharterConfirm;
      const options = { inline: Boolean(button.closest(".better-codex-inline-details")) };
      const confirmation = projectCharterConfirmationState(projectId, options);
      if (button.disabled || !confirmation.available) return;
      const revision = Number(button.dataset.charterRevision);
      const threadId = button.dataset.charterThread;
      if (!Number.isInteger(revision) || revision < 1) return;
      state.charterConfirmationPending = { projectId, revision };
      state.charterConfirmationError = null;
      button.disabled = true;
      renderProjects();
      if (inlineConversation) renderInlineConversation();
      try {
        await api("/api/projects/" + encodeURIComponent(projectId) + "/charter-confirm", { method: "POST", body: JSON.stringify({ expected_revision: revision, ...(threadId ? { thread_id: threadId } : {}) }) });
        await loadPlanningContext(projectId);
        if (inlineConversationTarget().project_id === projectId) await reloadInlineConversationContext({ background: false });
      } catch (error) {
        state.charterConfirmationError = { projectId, message: errorLabel(error) };
        throw error;
      } finally {
        state.charterConfirmationPending = null;
        renderProjects();
        if (inlineConversation) renderInlineConversation();
      }
    }
    function projectPlanningMarkup(project, options = {}) {
      const context = state.planningContexts?.[project.id];
      const charter = context?.charter || project.charter || {};
      const plan = context?.plan || project.plan || {};
      const sections = Array.isArray(charter.sections) ? charter.sections : Object.entries(charter.sections || {}).map(([key, value]) => ({ key, ...(value && typeof value === "object" ? value : { content: value }) }));
      const sectionNames = { goals: "目标", scope: "范围", non_goals: "非目标", architecture: "系统架构", workflows: "业务流程", data: "数据与接口", risks: "风险与依赖", acceptance: "验收标准", decisions: "已确认决策", open_questions: "待确认事项" };
      const chapters = sections.map((item, index) => '<section class="better-codex-project-plan-section" id="bc-charter-' + index + '"><header><strong>' + escapeHtml2(item.title || item.label || sectionNames[item.key] || "项目章节") + '</strong></header>' + documentTextMarkup(item.content || item.markdown || item.text || item.value || item.body) + '</section>').join("");
      const document = chapters || (charter.markdown ? documentTextMarkup(charter.markdown) : '<div class="better-codex-project-dashboard-empty">' + te("在总纲会话中确认项目目标、范围、架构和验收标准。") + '</div>');
      const items = Array.isArray(plan.items) ? plan.items.map((item) => ({ ...item, issue_id: item.issue_id || plan.issue_links?.find((link) => link.item_id === item.id)?.issue_id })) : [];
      const selected = (state.planSelections?.[project.id] || []).filter(id => items.some(item => item.id === id && !item.issue_id && !context?.planning_links?.some(link => link.item_id === id && link.issue_id)));
      if (state.planSelections?.[project.id]) state.planSelections[project.id] = selected;
      const taskRows = items.map((item) => {
        const link = context?.planning_links?.find(candidate => candidate.item_id === item.id);
        const issueId = item.issue_id || link?.issue_id;
        const issue = context?.tasks?.find(candidate => candidate.id === issueId) || state.projectIssues?.find(candidate => candidate.id === issueId) || state.issues?.find(candidate => candidate.id === issueId);
        const workState = issue?.archived_at || link?.archived ? "已归档" : statusLabels[issue?.status || link?.status] || "待规划";
        const action = issueId ? '<button type="button" data-inline-work-task="' + escapeHtml2(issueId) + '">' + te("开发任务") + ' · ' + te(workState) + '</button>' : '';
        return '<article class="better-codex-project-plan-item">' + (options.inline ? '<details class="bc-planning-fold" data-planning-fold="task:' + escapeHtml2(project.id) + ':' + escapeHtml2(item.id) + '"><summary>' : '') + '<label><input type="checkbox" aria-label="' + te("选择任务") + ' ' + escapeHtml2(item.id) + '" data-plan-item="' + escapeHtml2(item.id) + '" data-plan-project="' + escapeHtml2(project.id) + '"' + (issueId ? ' disabled' : '') + (selected.includes(item.id) ? ' checked' : '') + '><strong>' + escapeHtml2((item.id && !(item.title || item.name || "").startsWith(item.id) ? item.id + " · " : "") + (item.title || item.name || "任务")) + '</strong></label><span class="better-codex-project-plan-status">' + te(issueId ? "已转开发" : "待转开发") + '</span>' + (options.inline ? '</summary><div class="bc-planning-fold-body">' : '') + documentTextMarkup(item.goal || item.description || item.summary) + planItemDetailsMarkup(item) + issuePlanDetailMarkup(item) + '<footer>' + (issueId ? '<span>' + te("已关联开发任务") + '</span>' : '') + action + '</footer>' + (options.inline ? '</div></details>' : '') + '</article>';
      }).join("");
      const warningLabels = { missing_scope: "请补充任务范围", missing_acceptance: "请补充验收标准", missing_deliverables: "请补充任务产物", missing_manual_steps: "请补充人工验收步骤", missing_directories: "请明确任务涉及的目录" };
      const warnings = (plan.validation?.warnings || plan.warnings || []).filter(warning => warningLabels[warning.code] && items.some(item => item.id === warning.item_id)).map(warning => warningLabels[warning.code] + " · " + warning.item_id);
      const warningMarkup = warnings.length ? (options.inline ? '<details class="bc-planning-fold" data-planning-fold="warnings:' + escapeHtml2(project.id) + '"><summary>' + te("任务待补充内容") + ' · ' + escapeHtml2(String(warnings.length)) + '</summary><div class="bc-planning-fold-body">' + documentTextMarkup(warnings) + '</div></details>' : '<section class="better-codex-project-plan-section"><header><strong>' + te("任务待补充内容") + '</strong></header>' + documentTextMarkup(warnings) + '</section>') : '';
      const ready = state.nativePlanningEnabled === true;
      const actions = ready && !options.inline ? planningStageTabsMarkup(project.id, state.projectDocumentView, charter.status === "confirmed") : '';
      const confirmation = projectCharterConfirmationState(project.id, options);
      const confirmTitle = confirmation.readOnly ? "当前页面仅供查看。" : confirmation.busy ? "总纲会话正在运行，请等待回复完成后再确认。" : !confirmation.revision ? "暂无可确认的总纲，请先完成总纲内容。" : "";
      const confirmButton = ready ? '<button type="button" class="better-codex-submit" data-project-charter-confirm="' + escapeHtml2(project.id) + '" data-charter-revision="' + escapeHtml2(String(confirmation.revision)) + '"' + (confirmation.threadId ? ' data-charter-thread="' + escapeHtml2(confirmation.threadId) + '"' : '') + (!confirmation.available ? ' disabled' : '') + (confirmation.pending ? ' aria-busy="true"' : '') + (confirmTitle ? ' title="' + te(confirmTitle) + '"' : '') + '>' + te(confirmation.pending ? "正在确认…" : confirmation.confirmed ? "已确认" : "确认总纲") + '</button>' : '';
      const confirmationError = state.charterConfirmationError?.projectId === project.id ? '<p class="better-codex-project-document-notice is-error" role="alert">' + escapeHtml2(state.charterConfirmationError.message) + '</p>' : '';
      return '<section class="better-codex-project-document-panel bc-native-planning">' + actions + '<article class="better-codex-project-plan"><header class="better-codex-project-planning-panel-head"><div><span>' + te("项目总纲") + '</span><strong>' + te(charter.status === "confirmed" ? "已确认" : "待确认") + ' · ' + te("版本") + ' ' + escapeHtml2(String(charter.revision || 0)) + '</strong></div>' + confirmButton + '</header>' + confirmationError + '<div class="better-codex-project-plan-scroll">' + (options.inline ? '<details class="bc-planning-fold" data-planning-fold="charter:' + escapeHtml2(project.id) + '"><summary>' + te("总纲内容") + '</summary><div class="bc-planning-fold-body">' + document + '</div></details>' : document) + '<section class="better-codex-project-plan-section"><header><strong>' + te("任务规划") + '</strong><span>' + te("版本") + ' ' + escapeHtml2(String(plan.revision || 0)) + '</span></header>' + warningMarkup + (taskRows || '<div class="better-codex-project-dashboard-empty">' + te("暂无规划任务") + '</div>') + (ready && items.length ? '<button type="button" class="better-codex-submit" data-plan-convert="' + escapeHtml2(project.id) + '"' + (!selected.length ? ' disabled' : '') + '>' + te("将所选任务转为开发") + '</button>' : '') + '</section></div></article></section>';
    }
    async function loadPlanningContext(projectId, options = {}) {
      if (!state.nativePlanningEnabled || !projectId) return;
      const context = await api("/api/projects/" + encodeURIComponent(projectId) + "/planning-context", { passive: Boolean(options.background) });
      state.planningContexts ||= {};
      state.planningContexts[projectId] = context;
    }
    async function loadProjectNativeConversations(projectId, options = {}) {
      const result = await api("/api/native-conversations/list?project_id=" + encodeURIComponent(projectId), { passive: Boolean(options.background) });
      state.nativeConversations ||= {};
      state.nativeConversationSelections ||= {};
      state.nativeConversations[projectId] = Array.isArray(result.conversations) ? result.conversations.filter(item => item.kind === "charter" || item.kind === "planning") : [];
      state.nativeConversationSelections[projectId] = result.selected_conversation_id || "";
      return state.nativeConversations[projectId];
    }
    async function openProjectNativeSession(projectId, kind, conversationId = "") {
      const request = ++inlineConversationNavigationRequest;
      const conversations = await loadProjectNativeConversations(projectId);
      if (request !== inlineConversationNavigationRequest || destroyed) return { opened: false, reason: "navigation_changed" };
      const explicit = conversationId ? conversations.find(item => item.conversation_id === conversationId) : null;
      const selected = conversations.find(item => item.selected);
      const stage = ["charter", "planning"].includes(kind) ? kind : explicit?.kind || selected?.kind || readProjectView(projectId).stage || "charter";
      const remembered = readProjectView(projectId).conversations?.[stage];
      const conversation = conversationId ? explicit : conversations.find(item => item.kind === stage && item.conversation_id === remembered) || conversations.find(item => item.kind === stage && item.selected) || conversations.find(item => item.kind === stage);
      if (conversation && !conversation.selected) await api("/api/native-conversations/select", { method: "POST", body: JSON.stringify({ project_id: projectId, conversation_id: conversation.conversation_id }) });
      if (request !== inlineConversationNavigationRequest || destroyed) return { opened: false, reason: "navigation_changed" };
      return openInlineConversation({ project_id: projectId, kind: conversation?.kind || stage, ...(conversation ? { conversation_id: conversation.conversation_id } : {}) });
    }
    async function archiveProjectNativeConversation(projectId, conversationId) {
      const row = state.nativeConversations?.[projectId]?.find(item => item.conversation_id === conversationId);
      if (!row) return;
      const originKey = inlineConversationKey(inlineConversation);
      const navigationRequest = inlineConversationNavigationRequest;
      await api("/api/native-conversations/archive", { method: "POST", body: JSON.stringify({ project_id: projectId, conversation_id: conversationId, expected_revision: row.revision }) });
      const rows = await loadProjectNativeConversations(projectId);
      const view = readProjectView(projectId);
      if (view.conversations?.[row.kind] === conversationId) delete view.conversations[row.kind];
      if (view.target?.conversation_id === conversationId) delete view.target;
      try { localStorage.setItem("better-codex-project-view:" + projectId, JSON.stringify(view)); } catch {}
      if (row.thread_id && state.nativeThreadLinks) delete state.nativeThreadLinks[row.thread_id];
      registerInlineConversationBindings();
      if (destroyed || !inlineConversation || originKey !== inlineConversationKey(inlineConversation) || navigationRequest !== inlineConversationNavigationRequest) return;
      const current = inlineConversationTarget();
      if (current.project_id !== projectId) return;
      if (current.conversation_id !== conversationId) { renderInlineConversation(); return; }
      const next = rows.find(item => item.kind === row.kind && item.selected) || rows.find(item => item.kind === row.kind) || rows.find(item => item.selected) || rows[0];
      if (next) await openProjectNativeSession(projectId, next.kind, next.conversation_id);
      else await openInlineConversation({ project_id: projectId, kind: row.kind });
    }
    function planningConversationListMarkup() {
      const target = inlineConversationTarget();
      const rows = state.nativeConversations?.[target.project_id] || [];
      const planningAvailable = inlineConversation.planning_available === true || inlineConversation.context?.charter?.status === "confirmed";
      const rowMarkup = rows.length ? rows.map(item => '<div class="bc-planning-conversation-item"><button type="button" class="bc-planning-conversation-row' + (item.conversation_id === target.conversation_id ? ' is-active' : '') + '" data-planning-conversation="' + escapeHtml2(item.conversation_id) + '" aria-current="' + String(item.conversation_id === target.conversation_id) + '"' + (item.kind === "planning" && !item.thread_id && !planningAvailable ? ' disabled' : '') + '><span>' + icon(item.kind === "planning" ? "board" : "docs") + '<strong>' + escapeHtml2(item.title || t(item.kind === "planning" ? "任务规划" : "项目总纲")) + '</strong></span><small>' + te(item.kind === "planning" ? "任务规划" : "总纲") + ' · ' + te(["closed", "archived"].includes(item.status) ? "历史会话" : item.thread_id ? "已有会话" : "草稿") + '</small></button><button type="button" class="bc-planning-conversation-archive" data-planning-archive="' + escapeHtml2(item.conversation_id) + '" aria-label="' + te("归档") + ' ' + escapeHtml2(item.title || t("会话")) + '">' + te("归档") + '</button></div>').join("") : ["charter", "planning"].map(kind => '<button type="button" class="bc-planning-conversation-row' + (target.kind === kind ? ' is-active' : '') + '" data-inline-stage="' + kind + '"' + (kind === "planning" && !planningAvailable ? ' disabled' : '') + '><span>' + icon(kind === "planning" ? "board" : "docs") + '<strong>' + te(kind === "planning" ? "任务规划会话" : "总纲会话") + '</strong></span><small>' + te("草稿") + '</small></button>').join("");
      return '<header><strong>' + te("规划会话") + '</strong></header><div class="bc-planning-conversation-create"><button type="button" data-planning-create="charter">' + icon("plus") + te("新建总纲会话") + '</button><button type="button" data-planning-create="planning"' + (!planningAvailable ? ' disabled' : '') + '>' + icon("plus") + te("新建任务规划") + '</button></div><nav aria-label="' + te("项目规划会话") + '">' + rowMarkup + '</nav>';
    }
    function projectDashboardMarkup(project, issues, issuesLoading, paths) {
      const activeIssues = issues.filter((issue) => !issue.archived_at);
      const counts = activeIssues.reduce((result, issue) => {
        result[issue.status] = (result[issue.status] || 0) + 1;
        return result;
      }, {});
      const running = activeIssues.filter((issue) => issue.status === "in_progress" || ["claimed", "running", "scheduling"].includes(issue.active_run_status)).length;
      const review = counts.in_review || 0;
      const blocked = counts.blocked || 0;
      const attention = activeIssues.filter((issue) => issue.needs_attention || issue.status === "blocked" || issue.pending_actor === "user" && issue.status === "in_review");
      const healthTone = blocked ? "danger" : attention.length ? "warning" : "success";
      const healthLabel = blocked ? t("有风险") : attention.length ? t("需关注") : t("进展正常");
      const activeAgentIds = new Set(activeIssues.filter((issue) => issue.agent_enabled && ["in_progress", "in_review", "blocked"].includes(issue.status)).map((issue) => String(issue.agent_id || "default")));
      const projectAgentIds = new Set(activeIssues.filter((issue) => issue.agent_enabled).map((issue) => String(issue.agent_id || "default")));
      const agents = state.agents.filter((agent) => projectAgentIds.has(agentKey(agent))).sort((left, right) => Number(activeAgentIds.has(agentKey(right))) - Number(activeAgentIds.has(agentKey(left)))).slice(0, 3);
      const agentAvatars = agents.map((agent) => agentAvatarMarkup(agent, "better-codex-project-dashboard-avatar")).join("");
      const page = ["overview", "planning", "work"].includes(state.projectPage) ? state.projectPage : "overview";
      const headerActions = '<div class="better-codex-project-dashboard-actions">' + (agentAvatars ? '<div class="better-codex-project-dashboard-people" aria-label="' + te("项目智能体") + '">' + agentAvatars + "</div>" : "") + '<button class="better-codex-project-dashboard-delete" type="button" data-project-delete="' + escapeHtml2(project.id) + '" aria-label="' + te("删除项目") + '" title="' + te("删除项目") + '">' + icon("trash") + "<span>" + te("删除项目") + "</span></button></div>";
      const tabs = controllers().projects.renderDashboardTabs(page, { page: t("项目页面"), overview: t("概览"), planning: t("规划"), conversation: t("对话"), conversationAria: t("规划对话"), work: t("工作") });
      const header = '<header class="better-codex-project-dashboard-head"><div class="better-codex-project-dashboard-title"><div><h1>' + escapeHtml2(projectLabel(project)) + '</h1><span data-project-health-badge data-tone="' + healthTone + '">' + escapeHtml2(healthLabel) + "</span></div><p>" + escapeHtml2(project.description || t("尚未生成项目介绍")) + "</p></div>" + headerActions + "</header>" + tabs;
      if (page === "planning") return '<section class="better-codex-project-dashboard">' + header + projectPlanningMarkup(project) + "</section>";
      if (page === "work") return '<section class="better-codex-project-dashboard">' + header + '<nav class="bc-project-work-views" aria-label="' + te("工作视图") + '"><button type="button" aria-current="page" data-project-work-view="board">' + te("状态看板") + '</button><button type="button" data-project-work-view="conversations">' + te("工作会话") + '</button></nav><main class="better-codex-board better-codex-project-work-board" data-project-board></main></section>';
      const priority = { blocked: 0, in_review: 1, in_progress: 2, todo: 3, backlog: 4, done: 5 };
      const work = [...activeIssues].filter((issue) => ["blocked", "in_review", "in_progress", "todo"].includes(issue.status)).sort((left, right) => (priority[left.status] ?? 9) - (priority[right.status] ?? 9) || String(right.updated_at).localeCompare(String(left.updated_at))).slice(0, 5);
      const issueAssignee = (issue) => {
        if (issue.user_assigned) return issueUserProfile(issue)?.name || t("你");
        if (!issue.agent_enabled) return t("未指派");
        const agent = state.agents.find((item) => agentKey(item) === String(issue.agent_id || "default"));
        return agent ? agentDisplayName(agent) : "Codex";
      };
      const workRows = issuesLoading ? '<div class="better-codex-project-dashboard-empty">' + te("正在加载当前工作") + "</div>" : work.length ? work.map((issue) => '<button class="better-codex-project-work-row" type="button" data-project-issue="' + escapeHtml2(issue.id) + '">' + statusIcon(issue.status) + "<b>" + escapeHtml2(issue.identifier) + '</b><span class="better-codex-project-work-title"><strong>' + escapeHtml2(issue.title) + "</strong><span>" + escapeHtml2(issueAssignee(issue)) + " · " + te("更新于 " + timeAgo(issue.updated_at)) + '</span></span><span class="better-codex-project-work-state">' + te(statusLabels[issue.status] || issue.status) + "</span></button>").join("") : '<div class="better-codex-project-dashboard-empty">' + te("当前没有进行中的工作") + "</div>";
      const attentionRows = issuesLoading ? '<div class="better-codex-project-dashboard-empty">' + te("正在加载待处理事项") + "</div>" : attention.length ? attention.slice(0, 4).map((issue) => '<button class="better-codex-project-attention-row" type="button" data-project-issue="' + escapeHtml2(issue.id) + '"><span class="better-codex-project-attention-icon">' + icon(issue.status === "blocked" ? "shield" : "review") + '</span><span class="better-codex-project-attention-copy"><strong>' + escapeHtml2(issue.title) + "</strong><span>" + escapeHtml2(issue.identifier) + " · " + escapeHtml2(issueAssignee(issue)) + '</span></span><span class="better-codex-project-attention-state">' + escapeHtml2(issue.status === "blocked" ? t("需解阻") : issue.status === "in_review" ? t("需复核") : t("需处理")) + "</span></button>").join("") : '<div class="better-codex-project-dashboard-empty">' + te("没有需要你处理的事项") + "</div>";
      const planning = projectPlanningState(project);
      const milestoneItems = Array.isArray(planning.plan?.milestones) ? planning.plan.milestones.slice(0, 3) : [];
      const milestones = milestoneItems.length ? milestoneItems.map((item, index) => projectPlanningItemMarkup(item, index)).join("") : '<div class="better-codex-project-dashboard-empty">' + te("尚未生成项目计划") + "</div>";
      const path = paths[0] || t("未提供项目文件夹");
      return '<section class="better-codex-project-dashboard">' + header + '<section class="better-codex-project-dashboard-summary"><article class="better-codex-project-dashboard-card better-codex-project-dashboard-description"><strong>' + te("项目事实") + "</strong><p>" + escapeHtml2(project.description || t("尚未生成项目介绍")) + '</p><div class="better-codex-project-dashboard-path" title="' + escapeHtml2(path) + '">' + icon("folder") + "<span>" + escapeHtml2(path) + '</span></div></article><article class="better-codex-project-dashboard-card"><strong>' + te("当前状态") + '</strong><div class="better-codex-project-metrics"><span class="better-codex-project-metric"><b>' + escapeHtml2(String(running)) + "</b><span>" + te("进行中") + '</span></span><span class="better-codex-project-metric" data-tone="warning"><b>' + escapeHtml2(String(review)) + "</b><span>" + te("待复核") + '</span></span><span class="better-codex-project-metric" data-tone="danger"><b>' + escapeHtml2(String(blocked)) + "</b><span>" + te("阻塞") + '</span></span></div></article><article class="better-codex-project-dashboard-card better-codex-project-planning-overview"><header class="better-codex-project-section-head"><strong>' + te("项目规划") + '</strong><button type="button" data-project-dashboard-view="planning">' + te(planning.revision ? "计划版本" : "规划") + (planning.revision ? " " + escapeHtml2(String(planning.revision)) : "") + icon("chevron") + "</button></header><p>" + escapeHtml2(planning.plan?.summary || t("从一个问题开始，智能体会读取代码、Issue 和关联会话。")) + '</p></article></section><section class="better-codex-project-dashboard-card better-codex-project-overview-milestones"><header class="better-codex-project-section-head"><strong>' + te("里程碑") + "</strong><span>" + escapeHtml2(String(milestoneItems.length)) + "</span></header><div>" + milestones + '</div></section><section class="better-codex-project-dashboard-lists"><article class="better-codex-project-dashboard-card"><header class="better-codex-project-section-head"><strong>' + te("当前工作") + "</strong><span>" + escapeHtml2(String(work.length)) + '</span></header><div class="better-codex-project-work-list">' + workRows + '</div></article><article class="better-codex-project-dashboard-card"><header class="better-codex-project-section-head"><strong>' + te("等你处理") + "</strong><span>" + escapeHtml2(String(attention.length)) + '</span></header><div class="better-codex-project-attention-list">' + attentionRows + "</div></article></section></section>";
    }
    function projectRenderKey() {
      return state.projectDetailId ? [state.projectDetailId, state.projectPage, state.projectDocumentView].join(":") : "projects";
    }
    function projectScrollState(container) {
      const surfaces = [
        ["page", ""],
        ["issues", ".better-codex-project-issues"],
        ["timeline", ".better-codex-project-timeline-scroll"],
        ["document-tabs", ".better-codex-project-document-tabs"],
        ["document", ".better-codex-project-document-scroll"],
        ["plan", ".better-codex-project-plan-scroll"],
        ["planning-messages", ".better-codex-project-planning-messages"],
        ["board", "[data-project-board]"]
      ];
      return surfaces.flatMap(([name, selector]) => {
        const surface = selector ? container.querySelector(selector) : container;
        if (!surface) return [];
        return [{ name, selector, top: surface.scrollTop, left: surface.scrollLeft, stickToEnd: name === "planning-messages" && surface.scrollHeight - surface.scrollTop - surface.clientHeight < 48 }];
      });
    }
    function restoreProjectScrollState(container, viewKey, positions) {
      if (container.dataset.projectRenderKey !== viewKey) return;
      for (const position of positions) {
        const surface = position.selector ? container.querySelector(position.selector) : container;
        if (!surface) continue;
        surface.scrollLeft = position.left;
        surface.scrollTop = position.stickToEnd ? surface.scrollHeight : position.top;
      }
    }
    function destroyProjectRenderComponents() {
      projectEmptyState?.destroy();
      projectEmptyState = null;
      projectHealthBadge?.destroy();
      projectHealthBadge = null;
    }
    function projectSidebarMarkup() {
      return '<aside class="bc-project-sidebar" aria-label="' + te('项目列表') + '"><div class="bc-project-sidebar-head"><strong>' + te('项目') + '</strong><button type="button" data-project-sidebar-create>' + te('创建项目') + '</button></div><nav class="bc-project-sidebar-list">' + projectsByRecentActivity(state.projects).map(project => '<button type="button" class="bc-project-row' + (project.id === state.projectDetailId ? ' is-active' : '') + '" data-project-id="' + escapeHtml2(project.id) + '" aria-current="' + (project.id === state.projectDetailId ? 'true' : 'false') + '" title="' + escapeHtml2(projectRootPaths(project)[0] || projectLabel(project)) + '">' + icon('folder') + '<span>' + escapeHtml2(projectLabel(project)) + '</span></button>').join('') + '</nav></aside>';
    }
    function selectDefaultManagedProject() {
      if (state.projectDetailId || !state.projects.length) return;
      const remembered = localStorage.getItem('better-codex-managed-project');
      const project = state.projects.find(item => item.id === remembered) || projectsByRecentActivity(state.projects)[0];
      state.projectDetailId = project.id;
      applyProjectView(project.id);
      localStorage.setItem('better-codex-managed-project', project.id);
      syncWebProjectRoute(project.id, 'replace');
    }
    function renderProjectContent(container, markup) {
      markup = projectSidebarMarkup() + markup;
      const viewKey = projectRenderKey();
      const sameView = container.dataset.projectRenderKey === viewKey;
      if (sameView && projectRenderedMarkup === markup) return;
      const positions = sameView ? projectScrollState(container) : [];
      destroyProjectRenderComponents();
      const typing = document.activeElement?.matches('[data-project-planning-form] textarea') && document.activeElement.closest('[data-project-planning-form]').dataset.projectPlanningForm === state.projectDetailId ? {start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd} : null;
      const sidebarScroll = container.querySelector('.bc-project-sidebar-list')?.scrollTop || 0;
      const focusedProjectRow = document.activeElement?.closest('.bc-project-row')?.dataset.projectId;
      container.innerHTML = markup;
      const sidebarList = container.querySelector('.bc-project-sidebar-list');
      if (sidebarList) sidebarList.scrollTop = sidebarScroll;
      if (focusedProjectRow) [...container.querySelectorAll('.bc-project-row')].find(row => row.dataset.projectId === focusedProjectRow)?.focus({ preventScroll: true });
      if (typing) { const editor=container.querySelector('[data-project-planning-form] textarea'); if(editor && !editor.disabled){editor.focus({preventScroll:true});editor.setSelectionRange(typing.start,typing.end);} }
      container.dataset.projectRenderKey = viewKey;
      projectRenderedMarkup = markup;
      restoreProjectScrollState(container, viewKey, positions);
      requestAnimationFrame(() => {
        restoreProjectScrollState(container, viewKey, positions);
        if (!positions.length) return;
        appendDiagnostic("project_scroll_restored", {
          project_id: state.projectDetailId,
          page: state.projectPage,
          surfaces: positions.filter((position) => position.top || position.left || position.stickToEnd).map((position) => position.name).join(",") || "zero"
        });
      });
    }
    function renderProjectEmptyState(container) {
      const markup = "<span data-project-empty-state></span>";
      renderProjectContent(container, markup);
      const props = {
        action: state.mockup ? void 0 : {
          icon: LUCIDE_ICONS.plus,
          label: t("创建项目"),
          onPress: () => openCreateProjectDialog(),
          variant: "primary"
        },
        description: t("创建项目后，它会出现在 Codex 的项目列表中。"),
        icon: LUCIDE_ICONS.folder,
        title: t("暂无项目")
      };
      if (projectEmptyState) {
        projectEmptyState.update(props);
        return;
      }
      const placeholder = container.querySelector("[data-project-empty-state]");
      if (!placeholder) throw new Error("project_empty_state_mount_missing");
      projectEmptyState = createEmptyState(props, componentContext("projects", "projects-empty-state"));
      placeholder.replaceWith(projectEmptyState.element);
    }
    function mountProjectHealthBadge(container, projectId) {
      const placeholder = container.querySelector("[data-project-health-badge]");
      if (!placeholder) throw new Error("project_health_badge_mount_missing");
      projectHealthBadge = createStatusBadge({
        label: placeholder.textContent || "",
        variant: placeholder.dataset.tone || "success"
      }, componentContext("projects", "project-health:" + projectId));
      projectHealthBadge.element.classList.add("better-codex-project-health");
      placeholder.replaceWith(projectHealthBadge.element);
    }
    function renderProjects() {
      if (inlineConversation) return;
      const container = panel?.querySelector("#better-codex-projects");
      if (!container) return;
      selectDefaultManagedProject();
      const focusedEditor = container.querySelector("textarea:focus");
      const planningEditor = container.querySelector("[data-project-planning-form] textarea[name=message]");
      const planningProjectId = planningEditor?.closest("[data-project-planning-form]")?.dataset.projectPlanningForm || "";
      const focusedProjectId = focusedEditor?.closest("[data-project-planning-form]")?.dataset.projectPlanningForm || focusedEditor?.closest("[data-project-document-form]")?.dataset.projectDocumentForm || state.projectDetailId;
      if (projectPlanningComposition && projectPlanningComposition !== state.projectDetailId) projectPlanningComposition = "";
      const activePlanningEditor = planningEditor && planningProjectId === state.projectDetailId && (planningEditor === focusedEditor || projectPlanningComposition === planningProjectId) ? planningEditor : null;
      if (activePlanningEditor && planningProjectId) projectPlanningDrafts.set(planningProjectId,activePlanningEditor.value);
      const activeEditor = projectPlanningComposition ? activePlanningEditor : (activePlanningEditor ? null : focusedEditor && focusedProjectId === state.projectDetailId ? focusedEditor : null);
      if (activeEditor) {
        const projectId = activePlanningEditor ? planningProjectId : focusedProjectId;
        if (activePlanningEditor && projectId) projectPlanningDrafts.set(projectId, activePlanningEditor.value);
        if (!projectRenderDeferred) appendDiagnostic("project_render_deferred", { project_id: projectId, editor: activePlanningEditor ? "planning" : "project", reason: projectPlanningComposition === projectId ? "composition" : "focus" });
        projectRenderDeferred = { projectId, editor: activePlanningEditor ? "planning" : "project" };
        return;
      }
      if (projectRenderDeferred) {
        appendDiagnostic("project_render_resumed", { project_id: projectRenderDeferred.projectId, editor: projectRenderDeferred.editor });
        projectRenderDeferred = null;
      }
      const heading = panel.querySelector(".better-codex-project-heading");
      syncProjectRefreshButton();
      const createButton2 = panel.querySelector(".better-codex-project-actions .better-codex-button");
      if (createButton2) {
        createButton2.hidden = false;
        createButton2.innerHTML = icon("plus") + "<span>" + te(state.projectDetailId ? "新建会话" : "创建项目") + "</span>";
      }
      const workItemButton = panel.querySelector("[data-project-work-item-create]");
      if (workItemButton) workItemButton.hidden = !state.projectDetailId;
      if (!state.projectDetailId) {
        if (heading) heading.innerHTML = "<strong>" + te("项目管理") + "</strong><span>" + escapeHtml2(state.projects.length + " " + t("个项目")) + "</span>";
        if (HOST_KIND === "web" && state.surface === "projects") document.title = t("项目管理") + " · Better Codex";
        if (!state.projects.length) {
          renderProjectEmptyState(container);
          return;
        }
        renderProjectContent(container, '<section class="better-codex-project-list">' + projectsByRecentActivity(state.projects).map((project2) => {
          const paths2 = projectRootPaths(project2);
          const description = project2.description || t("尚未生成项目介绍");
          return '<button class="better-codex-project-card" type="button" data-project-id="' + escapeHtml2(project2.id) + '"><span class="better-codex-project-card-head"><span class="better-codex-project-card-icon">' + icon("folder") + '</span><span class="better-codex-project-card-title"><strong>' + escapeHtml2(projectLabel(project2)) + "</strong><span>" + escapeHtml2(paths2.length + " " + t("个文件夹")) + "</span></span>" + icon("chevron") + '</span><span class="better-codex-project-card-description">' + escapeHtml2(description) + '</span><span class="better-codex-project-card-path">' + icon("folder") + "<span>" + escapeHtml2(paths2[0] || t("未提供")) + "</span></span></button>";
        }).join("") + "</section>");
        return;
      }
      const project = state.projects.find((item) => item.id === state.projectDetailId);
      if (!project) {
        if (!state.projectsLoaded) {
          if (heading) heading.innerHTML = "<strong>" + te("项目管理") + "</strong>";
          renderProjectContent(container, "");
          return;
        }
        state.projectDetailId = "";
        syncWebProjectRoute("", "replace");
        return renderProjects();
      }
      const paths = projectRootPaths(project);
      state.projectId = project.id;
      localStorage.setItem(PROJECT_KEY, state.projectId);
      const issuesLoading = state.projectIssuesProjectId !== project.id;
      const issues = issuesLoading ? [] : [...state.projectIssues].sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
      const projectName = projectLabel(project);
      if (heading) heading.innerHTML = '<strong>' + te('项目管理') + '</strong><span>' + escapeHtml2(projectName) + '</span>';
      if (HOST_KIND === "web" && state.surface === "projects") document.title = t("项目管理") + " > " + projectName + " · Better Codex";
      renderProjectContent(container, '<section class="better-codex-project-detail">' + projectDashboardMarkup(project, issues, issuesLoading, paths) + "</section>");
      if (!projectHealthBadge) mountProjectHealthBadge(container, project.id);
      if (state.projectPage === "work") {
        const board = container.querySelector("[data-project-board]");
        if (!board) throw new Error("project_board_mount_missing");
        renderBoard({ board, issues: state.issues.filter((issue) => issue.project_id === project.id), loaded: state.issuesLoaded, projectId: project.id });
      }
    }
    async function loadProjects(options = {}) {
      const requestOptions = { passive: Boolean(options.background) };
      const projects = await requestProjects(requestOptions);
      const projectsChanged = JSON.stringify(projects) !== JSON.stringify(state.projects);
      let projectIssuesChanged = false;
      let planningContextChanged = false;
      const pending = state.projectDocumentPending;
      if (pending) {
        const project = projects.find((item) => item.id === pending.projectId);
        if (project && (project.overview_status === "generating" || String(project.updated_at || "") !== pending.updatedAt)) state.projectDocumentPending = null;
      }
      const planningPending = state.projectPlanningPending;
      if (planningPending) {
        const project = projects.find((item) => item.id === planningPending.projectId);
        if (project && (project.planning?.status === "running" || String(project.updated_at || "") !== planningPending.updatedAt)) state.projectPlanningPending = null;
      }
      state.projects = projects;
      state.projectsLoaded = true;
      if (state.projectDetailId && !projects.some(project => project.id === state.projectDetailId)) state.projectDetailId = '';
      selectDefaultManagedProject();
      if (state.projectDetailId) {
        if (!state.projects.some((project) => project.id === state.projectDetailId)) {
          state.projectDetailId = "";
          state.projectIssues = [];
          state.projectIssuesProjectId = "";
          syncWebProjectRoute("", "replace");
        } else {
          const projectId = state.projectDetailId;
          const priorContext = JSON.stringify(state.planningContexts?.[projectId]);
          await loadPlanningContext(projectId, options);
          planningContextChanged = priorContext !== JSON.stringify(state.planningContexts?.[projectId]);
          if (state.projectIssuesProjectId !== projectId) {
            state.projectIssues = [];
            renderProjects();
          }
          const [activeIssues, archivedIssues] = await Promise.all([
            requestList("/api/issues?project_id=" + encodeURIComponent(projectId), "issues", requestOptions),
            requestList("/api/issues?archived=1&project_id=" + encodeURIComponent(projectId), "issues", requestOptions)
          ]);
          if (state.projectDetailId === projectId) {
            const projectIssues = [...activeIssues, ...archivedIssues];
            projectIssuesChanged = JSON.stringify(projectIssues) !== JSON.stringify(state.projectIssues);
            state.projectIssues = projectIssues;
            state.projectIssuesProjectId = projectId;
          }
        }
      }
      if (state.projectResumePending === state.projectDetailId && active && state.surface === "projects" && !inlineConversation) await resumeProjectView(state.projectDetailId);
      if (options.background && !projectsChanged && !projectIssuesChanged && !planningContextChanged) return;
      if (options.background) appendDiagnostic("project_background_update", { project_id: state.projectDetailId, projects_changed: projectsChanged, issues_changed: projectIssuesChanged });
      render();
    }
    async function openProjectDetail(projectId) {
      if (state.projectDetailId === projectId) return;
      rememberProjectView();
      leaveInlineConversation();
      localStorage.setItem('better-codex-managed-project', projectId);
      state.projectDetailId = projectId;
      applyProjectView(projectId);
      controllers().projects.resetPlanningPane();
      state.projectId = projectId;
      localStorage.setItem(PROJECT_KEY, state.projectId);
      state.projectIssues = [];
      state.projectIssuesProjectId = "";
      syncWebProjectRoute(projectId);
      renderProjects();
      await loadProjects();
    }
    function onProjectsClick(event) {
      const workView = event.target.closest("[data-project-work-view]");
      if (workView) {
        if (workView.dataset.projectWorkView === "conversations") return void perform(() => openProjectWorkSession(state.projectDetailId));
        state.projectPage = "work";
        state.projectResumePending = "";
        rememberProjectView();
        renderProjects();
        return;
      }

      const charterConfirm = event.target.closest("[data-project-charter-confirm]");
      if (charterConfirm) return void perform(() => confirmProjectCharter(charterConfirm));
      const nativeSession = event.target.closest("[data-project-native-session]");
      if (nativeSession) return nativeSession.disabled ? void 0 : void perform(() => openProjectNativeSession(nativeSession.dataset.projectId, nativeSession.dataset.projectNativeSession));
      const planItem = event.target.closest("[data-plan-item]");
      if (planItem) {
        if (planItem.disabled) return;
        state.planSelections ||= {};
        const selected = new Set(state.planSelections[planItem.dataset.planProject] || []);
        if (planItem.checked) selected.add(planItem.dataset.planItem); else selected.delete(planItem.dataset.planItem);
        state.planSelections[planItem.dataset.planProject] = [...selected];
        const convert = (inlineConversationRoot || panel)?.querySelector("[data-plan-convert]:not([data-plan-convert-item])");
        if (convert) convert.disabled = !selected.size;
        return;
      }
      const convert = event.target.closest("[data-plan-convert]");
      if (convert && !convert.disabled) return void perform(async () => {
        const projectId = convert.dataset.planConvert;
        const context = state.planningContexts?.[projectId];
        const itemIds = (state.planSelections?.[projectId] || []).filter(id => context?.plan?.items?.some(item => item.id === id && !item.issue_id) && !context?.plan?.issue_links?.some(link => link.item_id === id && link.issue_id) && !context?.planning_links?.some(link => link.item_id === id && link.issue_id));
        if (!itemIds.length) { convert.disabled = true; return; }
        convert.disabled = true;
        try {
          await api("/api/projects/" + encodeURIComponent(projectId) + "/plan/convert", { method: "POST", body: JSON.stringify({ expected_revision: state.planningContexts?.[projectId]?.plan?.revision, item_ids: itemIds }) });
          state.planSelections[projectId] = [];
          await Promise.all([loadProjects(), loadIssues()]);
          if (inlineConversation) await reloadInlineConversationContext({ background: false });
        } finally { if (convert.isConnected) convert.disabled = false; }
      });
      const planningControl = event.target.closest('[data-project-planning-control]');
      if (planningControl) {
        planningControl.disabled = true;
        void perform(async () => {
          try { await api('/api/projects/' + encodeURIComponent(planningControl.dataset.projectPlanningControlProject) + '/planning/' + planningControl.dataset.projectPlanningControl,{method:'POST',body:'{}'}); await loadProjects(); }
          finally { planningControl.disabled = false; }
        });
        return;
      }
      if (event.target.closest('[data-project-sidebar-create]')) return openCreateProjectDialog();
      const agentOption = event.target.closest("[data-project-document-agent-option]");
      if (agentOption) {
        const picker = agentOption.closest("[data-project-document-agent-picker]");
        const input = picker?.querySelector('[name="agent_id"]');
        if (!picker || !input) return;
        input.value = agentOption.dataset.projectDocumentAgentOption || "";
        picker.outerHTML = projectDocumentAgentPicker(input.value);
        return;
      }
      const agentToggle = event.target.closest("[data-project-document-agent-toggle]");
      if (agentToggle) {
        const picker = agentToggle.closest("[data-project-document-agent-picker]");
        const opening = !picker.classList.contains("is-open");
        panel.querySelectorAll("[data-project-document-agent-picker].is-open").forEach((item) => {
          item.classList.remove("is-open");
          item.querySelector("[data-project-document-agent-toggle]")?.setAttribute("aria-expanded", "false");
        });
        picker.classList.toggle("is-open", opening);
        agentToggle.setAttribute("aria-expanded", String(opening));
        return;
      }
      panel.querySelectorAll("[data-project-document-agent-picker].is-open").forEach((item) => {
        item.classList.remove("is-open");
        item.querySelector("[data-project-document-agent-toggle]")?.setAttribute("aria-expanded", "false");
      });
      const back = event.target.closest("[data-project-back],[data-project-home]");
      if (back) {
        if (HOST_KIND === "web" && history.state?.betterCodexProjectFromHome) return history.back();
        state.projectDetailId = "";
        syncWebProjectRoute("", "replace");
        renderProjects();
        return;
      }
      const projectDelete = event.target.closest("[data-project-delete]");
      if (projectDelete) {
        const projectId = projectDelete.dataset.projectDelete || "";
        const project2 = state.projects.find((item) => item.id === projectId);
        if (!project2) return;
        appendDiagnostic("project_delete_requested", { project_id: projectId, workspace_path_present: Boolean(project2.workspace_path) });
        return void confirmAction("删除项目", "项目、任务与规划会从 Better Codex 和 Codex 清单移除，磁盘文件夹和文件会保留。", "删除项目").then((confirmed) => confirmed && perform(async () => {
          const result = await api("/api/projects/" + encodeURIComponent(projectId), { method: "DELETE", body: "{}" });
          if (result.command_id) {
            const command = await waitForRemoteCommand(result.command_id);
            if (command.status !== "applied") throw new Error(command.error || "command_rejected");
          }
          projectPlanningDrafts.delete(projectId);
          state.projects = state.projects.filter((item) => item.id !== projectId);
          state.issues = state.issues.filter((item) => item.project_id !== projectId);
          state.projectIssues = [];
          state.projectIssuesProjectId = "";
          state.projectDetailId = "";
          state.projectId = "";
          localStorage.removeItem(PROJECT_KEY);
          syncWebProjectRoute("", "replace");
          appendDiagnostic("project_delete_completed", { project_id: projectId, workspace_deleted: false });
          await loadProjects();
        }));
      }
      const dashboardView = event.target.closest("[data-project-dashboard-view]");
      if (dashboardView) {
        const page = dashboardView.dataset.projectDashboardView;
        const selection = controllers().projects.selectDashboard(page, dashboardView.dataset.projectPlanningPane || "");
        state.projectPage = selection.page;
        state.projectResumePending = "";
        rememberProjectView();
        if (state.projectPage === "planning" && state.nativePlanningEnabled) return void perform(() => openProjectNativeSession(state.projectDetailId, state.projectDocumentView === "planning" ? "planning" : "charter"));
        renderProjects();
        if (state.projectPage === "planning" && (selection.planningPane === "chat" || !window.matchMedia("(max-width: 980px)").matches)) requestAnimationFrame(() => {
          const messages = panel.querySelector(".better-codex-project-planning-messages");
          if (messages) messages.scrollTop = messages.scrollHeight;
        });
        if (state.projectPage === "work" && !state.issuesLoaded) void perform(() => loadIssues());
        return;
      }
      const planningPrompt = event.target.closest("[data-project-planning-prompt]");
      if (planningPrompt) {
        const textarea = panel.querySelector("[data-project-planning-form] textarea[name=message]");
        if (!textarea) return;
        textarea.value = planningPrompt.dataset.projectPlanningPrompt || "";
        const projectId = textarea.closest("[data-project-planning-form]")?.dataset.projectPlanningForm;
        if (projectId) projectPlanningDrafts.set(projectId, textarea.value);
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        return;
      }
      const planningReset = event.target.closest("[data-project-planning-reset]");
      if (planningReset && !planningReset.disabled) {
        const projectId = planningReset.dataset.projectPlanningReset;
        return void confirmAction("开始新规划对话", "这会清除当前规划对话和计划版本。", "新对话").then((confirmed) => confirmed && perform(async () => {
          const result = await api("/api/projects/" + encodeURIComponent(projectId) + "/planning/reset", { method: "POST", body: "{}" });
          if (result.command_id) {
            const command = await waitForRemoteCommand(result.command_id);
            if (command.status !== "applied") throw new Error(command.error || "command_rejected");
          }
          projectPlanningDrafts.delete(projectId);
          state.projectPlanningError = null;
          await loadProjects();
        }));
      }
      const documentView = event.target.closest("[data-project-document-view]");
      if (documentView) {
        state.projectDocumentView = documentView.dataset.projectDocumentView;
        rememberProjectView();
        renderProjects();
        return;
      }
      const issue = event.target.closest("[data-project-issue]");
      if (issue) {
        const selected = state.projectIssues.find((item) => item.id === issue.dataset.projectIssue);
        if (selected && !issuePermissions(selected).enrichmentPending) return void perform(() => openEditor(selected));
        return;
      }
      const project = event.target.closest("[data-project-id]");
      if (project) {
        void perform(() => openProjectDetail(project.dataset.projectId));
      }
    }
    function onProjectDocumentSubmit(event) {
      const form = event.target.closest("[data-project-document-form]");
      if (!form) return;
      event.preventDefault();
      if (state.projectDocumentPending?.projectId === form.dataset.projectDocumentForm) return;
      const data = new FormData(form);
      const projectId = form.dataset.projectDocumentForm;
      const project = state.projects.find((item) => item.id === projectId);
      const agentId = String(data.get("agent_id") || "");
      const feedback = String(data.get("feedback") || "");
      state.projectDocumentError = null;
      state.projectDocumentPending = { projectId, agentId, feedback, updatedAt: String(project?.updated_at || "") };
      renderProjects();
      void (async () => {
        try {
          const result = await api("/api/projects/" + encodeURIComponent(projectId) + "/overview", { method: "POST", body: JSON.stringify({ agent_id: agentId, feedback }) });
          if (result.command_id) {
            const command = await waitForRemoteCommand(result.command_id);
            if (command.status !== "applied") throw new Error(command.error || "command_rejected");
          }
          await loadProjects();
        } catch (error) {
          state.projectDocumentPending = null;
          const presentation = reportUnexpectedError(error, { source: "project_document" });
          state.projectDocumentError = { projectId, message: projectDocumentErrorLabel(error instanceof Error ? error.message : error), tone: presentation.tone };
          renderProjects();
        }
      })();
    }
    function onProjectPlanningSubmit(event) {
      const form = event.target.closest("[data-project-planning-form]");
      if (!form) return;
      event.preventDefault();
      const projectId = form.dataset.projectPlanningForm;
      if (state.projectPlanningPending?.projectId === projectId) return;
      const project = state.projects.find((item) => item.id === projectId);

      const data = new FormData(form);
      const message = String(data.get("message") || "").trim();
      const agentId = String(data.get("agent_id") || "");
      if (!message) return void form.querySelector("textarea")?.focus();
      state.projectPlanningError = null;
      state.projectPlanningPending = { projectId, message, updatedAt: String(project?.updated_at || "") };
      projectPlanningDrafts.delete(projectId);
      form.querySelector("textarea[name=message]").value = "";
      renderProjects();
      void (async () => {
        try {
          const result = await api("/api/projects/" + encodeURIComponent(projectId) + "/planning/messages", { method: "POST", body: JSON.stringify({ agent_id: agentId, message }) });
          if (result.command_id) {
            const command = await waitForRemoteCommand(result.command_id);
            if (command.status !== "applied") throw new Error(command.error || "command_rejected");
          }
          await loadProjects();
        } catch (error) {
          state.projectPlanningPending = null;
          projectPlanningDrafts.set(projectId, message);
          const presentation = reportUnexpectedError(error, { source: "project_planning" });
          state.projectPlanningError = { projectId, message: projectPlanningErrorLabel(error instanceof Error ? error.message : error), tone: presentation.tone };
          renderProjects();
        }
      })();
    }
    function openCreateProjectDialog() {
      document.getElementById("better-codex-project-dialog")?.remove();
      const dialog = document.createElement("dialog");
      dialog.id = "better-codex-project-dialog";
      dialog.setAttribute(OWNED, "true");
      dialog.dataset.directoryBrowser = REMOTE ? "true" : "false";
      const directoryBrowser = REMOTE ? '<section class="better-codex-directory-browser" aria-label="' + te("浏览本机文件夹") + '"><div class="better-codex-directory-toolbar"><button type="button" data-directory-up aria-label="' + te("上一级") + '" disabled>' + icon("send") + '</button><input data-directory-path maxlength="4096" aria-label="' + te("目录路径") + '" autocomplete="off" spellcheck="false"></div><div class="better-codex-directory-shortcuts"><button type="button" data-directory-home>' + icon("folder") + "<span>" + te("主目录") + '</span></button><button type="button" data-directory-root>' + icon("folder") + "<span>" + te("文件系统") + '</span></button><button type="button" data-directory-hidden aria-pressed="false" aria-label="' + te("显示隐藏目录") + '" title="' + te("显示隐藏目录") + '" disabled>' + icon("eyeOff") + "<span>" + te("显示隐藏目录") + '</span></button><button type="button" data-directory-create disabled>' + icon("plus") + "<span>" + te("新建文件夹") + '</span></button></div><div class="better-codex-directory-create" hidden><input data-directory-create-name maxlength="120" aria-label="' + te("文件夹名称") + '" placeholder="' + te("文件夹名称") + '" autocomplete="off" spellcheck="false"><button type="button" data-directory-create-cancel>' + te("取消") + '</button><button type="button" data-directory-create-confirm>' + te("创建") + '</button></div><div class="better-codex-directory-list" aria-label="' + te("浏览本机文件夹") + '"></div><span data-directory-status aria-live="polite"></span></section>' : "";
      dialog.innerHTML = "<form><h2>" + te("创建 Codex 项目") + "</h2><p>" + te("创建后会加入 Codex 的项目列表。") + "</p><label><span>" + te("项目名称") + '</span><input name="name" maxlength="120" autocomplete="off" required></label><label><span>' + te("项目文件夹") + '</span><span class="better-codex-project-folder-field"><input name="workspace_path" maxlength="4096" placeholder="' + te("选择本地项目文件夹") + '" autocomplete="off" spellcheck="false" readonly required><button type="button" data-project-choose-folder>' + te("选择文件夹") + "</button></span></label>" + directoryBrowser + '<output hidden></output><div class="better-codex-project-dialog-actions"><button type="button" data-project-create-cancel>' + te("取消") + '</button><button type="submit" disabled>' + te("创建项目") + "</button></div></form>";
      let directoryRequest = 0;
      let currentDirectory = null;
      let showHiddenDirectories = false;
      const workspaceInput = dialog.querySelector('[name="workspace_path"]');
      const nameInput = dialog.querySelector('[name="name"]');
      const submit = dialog.querySelector('button[type="submit"]');
      const output = dialog.querySelector("output");
      const chooseButton = dialog.querySelector("[data-project-choose-folder]");
      const directoryPanel = dialog.querySelector(".better-codex-directory-browser");
      const directoryPath = dialog.querySelector("[data-directory-path]");
      const directoryList = dialog.querySelector(".better-codex-directory-list");
      const directoryStatus = dialog.querySelector("[data-directory-status]");
      const directoryUp = dialog.querySelector("[data-directory-up]");
      const directoryHome = dialog.querySelector("[data-directory-home]");
      const directoryRoot = dialog.querySelector("[data-directory-root]");
      const directoryHidden = dialog.querySelector("[data-directory-hidden]");
      const directoryCreate = dialog.querySelector("[data-directory-create]");
      const directoryCreateForm = dialog.querySelector(".better-codex-directory-create");
      const directoryCreateName = dialog.querySelector("[data-directory-create-name]");
      const directoryCreateCancel = dialog.querySelector("[data-directory-create-cancel]");
      const directoryCreateConfirm = dialog.querySelector("[data-directory-create-confirm]");
      const finish = () => {
        directoryRequest += 1;
        dialog.close();
        dialog.remove();
      };
      dialog.querySelector("[data-project-create-cancel]").addEventListener("click", finish);
      const applyWorkspacePath = (workspacePath) => {
        workspaceInput.value = workspacePath;
        workspaceInput.title = workspacePath;
        submit.disabled = false;
        chooseButton.textContent = t("更改文件夹");
        if (!nameInput.value.trim()) nameInput.value = workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
        if (directoryPanel) directoryPanel.hidden = true;
        nameInput.focus();
        nameInput.select();
      };
      const directoryErrorLabel = (error) => {
        const value = error instanceof Error ? error.message : "";
        return value === "incompatible_protocol" ? t("本机 Runtime 版本不支持远程文件夹浏览") : t("无法读取文件夹");
      };
      const renderDirectoryEntries = () => {
        if (!currentDirectory) return;
        const visibleDirectories = showHiddenDirectories ? currentDirectory.directories : currentDirectory.directories.filter((entry2) => !entry2.name.startsWith("."));
        directoryList.innerHTML = visibleDirectories.length ? visibleDirectories.map((entry2) => '<button class="better-codex-directory-row" type="button" data-directory-entry="' + escapeHtml2(entry2.path) + '" title="' + escapeHtml2(entry2.path) + '" aria-label="' + te("打开文件夹") + ": " + escapeHtml2(entry2.name) + '">' + icon("folder") + "<span>" + escapeHtml2(entry2.name) + "</span>" + icon("chevron") + "</button>").join("") : '<span class="better-codex-directory-state">' + (currentDirectory.directories.length ? te("隐藏目录已屏蔽") : te("这个文件夹中没有子文件夹")) + "</span>";
      };
      const renderDirectory = (directory) => {
        currentDirectory = directory;
        directoryPath.value = directory.path;
        directoryUp.disabled = !directory.parent_path;
        directoryUp.dataset.path = directory.parent_path || "";
        directoryHome.disabled = directory.home_path === directory.path;
        directoryHome.dataset.path = directory.home_path;
        directoryRoot.disabled = directory.root_path === directory.path;
        directoryRoot.dataset.path = directory.root_path;
        directoryHidden.disabled = false;
        directoryCreate.disabled = false;
        chooseButton.disabled = false;
        chooseButton.textContent = t("选择当前文件夹");
        directoryStatus.textContent = directory.truncated ? t("仅显示前 500 个文件夹") : "";
        renderDirectoryEntries();
      };
      const loadRemoteDirectory = async (path) => {
        const request = ++directoryRequest;
        currentDirectory = null;
        directoryPanel.hidden = false;
        directoryPanel.setAttribute("aria-busy", "true");
        chooseButton.disabled = true;
        chooseButton.textContent = t("正在选择…");
        directoryHidden.disabled = true;
        directoryCreate.disabled = true;
        directoryCreateForm.hidden = true;
        directoryCreateName.value = "";
        directoryStatus.textContent = "";
        directoryList.innerHTML = '<span class="better-codex-directory-state">' + te("正在读取文件夹…") + "</span>";
        try {
          const result = await api("/api/system/directories", { method: "POST", body: JSON.stringify({ path: String(path || "") }), timeoutMs: 3e4 });
          const command = result.command_id ? await waitForRemoteCommand(result.command_id, 3e4) : null;
          if (command && command.status !== "applied") throw new Error(command.error || "command_rejected");
          const directory = command?.payload || result;
          if (!directory || typeof directory.path !== "string" || typeof directory.home_path !== "string" || typeof directory.root_path !== "string" || !Array.isArray(directory.directories) || directory.directories.some((entry2) => !entry2 || typeof entry2.name !== "string" || typeof entry2.path !== "string")) throw new Error("invalid_directory_response");
          if (request !== directoryRequest || !dialog.isConnected) return;
          renderDirectory(directory);
        } catch (error) {
          if (request !== directoryRequest || !dialog.isConnected) return;
          reportUnexpectedError(error, { source: "directory_browser" });
          currentDirectory = null;
          chooseButton.disabled = false;
          chooseButton.textContent = t("重试");
          directoryHidden.disabled = true;
          directoryList.innerHTML = '<span class="better-codex-directory-state">' + escapeHtml2(directoryErrorLabel(error)) + "</span>";
          directoryStatus.textContent = directoryErrorLabel(error);
        } finally {
          if (request === directoryRequest && dialog.isConnected) directoryPanel.removeAttribute("aria-busy");
        }
      };
      const chooseFolder = async () => {
        if (REMOTE) {
          if (!directoryPanel.hidden && currentDirectory?.path) return void applyWorkspacePath(currentDirectory.path);
          return void loadRemoteDirectory(workspaceInput.value || currentDirectory?.path || "");
        }
        chooseButton.disabled = true;
        chooseButton.textContent = t("正在选择…");
        output.hidden = true;
        try {
          const result = await api("/api/system/directory", { method: "POST", timeoutMs: 3e5 });
          const command = result.command_id ? await waitForRemoteCommand(result.command_id, 3e5) : null;
          if (command && command.status !== "applied") throw new Error(command.error || "command_rejected");
          const workspacePath = String(command?.payload?.workspace_path || result.workspace_path || "");
          if (!workspacePath) return;
          applyWorkspacePath(workspacePath);
        } catch (error) {
          presentInlineError(output, error, directoryErrorLabel(error), { source: "directory_picker" });
        } finally {
          chooseButton.disabled = false;
          chooseButton.textContent = workspaceInput.value ? t("更改文件夹") : t("选择文件夹");
        }
      };
      dialog.querySelector("[data-project-choose-folder]").addEventListener("click", () => {
        void chooseFolder();
      });
      if (REMOTE) {
        const directoryCreationErrorLabel = (error) => {
          const value = error instanceof Error ? error.message : "";
          if (value === "directory_already_exists") return t("文件夹已存在");
          if (value === "invalid_directory_name") return t("文件夹名称无效");
          if (value === "incompatible_protocol") return t("本机 Runtime 版本不支持远程文件夹浏览");
          return t("无法创建文件夹");
        };
        const createNewDirectory = async () => {
          const parentPath = currentDirectory?.path || "";
          const name = directoryCreateName.value.trim();
          if (!name) {
            directoryStatus.textContent = t("请输入文件夹名称");
            directoryCreateName.focus();
            return;
          }
          directoryCreateName.disabled = true;
          directoryCreateCancel.disabled = true;
          directoryCreateConfirm.disabled = true;
          directoryCreateConfirm.textContent = t("正在创建…");
          directoryStatus.textContent = "";
          try {
            const result = await api("/api/system/directories/create", { method: "POST", body: JSON.stringify({ parent_path: parentPath, name }), timeoutMs: 3e4 });
            const command = result.command_id ? await waitForRemoteCommand(result.command_id, 3e4) : null;
            if (command && command.status !== "applied") throw new Error(command.error || "command_rejected");
            const workspacePath = String(command?.payload?.workspace_path || result.workspace_path || "");
            if (!workspacePath) throw new Error("invalid_directory_response");
            applyWorkspacePath(workspacePath);
          } catch (error) {
            reportUnexpectedError(error, { source: "directory_create", parent_path: parentPath, directory_name: name });
            directoryStatus.textContent = directoryCreationErrorLabel(error);
          } finally {
            directoryCreateName.disabled = false;
            directoryCreateCancel.disabled = false;
            directoryCreateConfirm.disabled = false;
            directoryCreateConfirm.textContent = t("创建");
          }
        };
        directoryList.addEventListener("click", (event) => {
          const row = event.target.closest("[data-directory-entry]");
          if (row) void loadRemoteDirectory(row.dataset.directoryEntry);
        });
        directoryUp.addEventListener("click", () => {
          if (directoryUp.dataset.path) void loadRemoteDirectory(directoryUp.dataset.path);
        });
        directoryHome.addEventListener("click", () => {
          if (directoryHome.dataset.path) void loadRemoteDirectory(directoryHome.dataset.path);
        });
        directoryRoot.addEventListener("click", () => {
          if (directoryRoot.dataset.path) void loadRemoteDirectory(directoryRoot.dataset.path);
        });
        directoryHidden.addEventListener("click", () => {
          showHiddenDirectories = !showHiddenDirectories;
          const label2 = showHiddenDirectories ? t("不显示隐藏目录") : t("显示隐藏目录");
          directoryHidden.setAttribute("aria-pressed", String(showHiddenDirectories));
          directoryHidden.setAttribute("aria-label", label2);
          directoryHidden.title = label2;
          directoryHidden.innerHTML = icon(showHiddenDirectories ? "eye" : "eyeOff") + "<span>" + escapeHtml2(label2) + "</span>";
          renderDirectoryEntries();
        });
        directoryPath.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void loadRemoteDirectory(directoryPath.value);
        });
        directoryCreate.addEventListener("click", () => {
          directoryCreateForm.hidden = false;
          directoryStatus.textContent = "";
          directoryCreateName.focus();
        });
        directoryCreateCancel.addEventListener("click", () => {
          directoryCreateForm.hidden = true;
          directoryCreateName.value = "";
          directoryStatus.textContent = "";
          directoryCreate.focus();
        });
        directoryCreateConfirm.addEventListener("click", () => {
          void createNewDirectory();
        });
        directoryCreateName.addEventListener("keydown", (event) => {
          if (event.key === "Escape") return void directoryCreateCancel.click();
          if (event.key !== "Enter") return;
          event.preventDefault();
          void createNewDirectory();
        });
      }
      dialog.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
        const submit2 = dialog.querySelector('button[type="submit"]');
        const output2 = dialog.querySelector("output");
        const data = new FormData(event.currentTarget);
        submit2.disabled = true;
        output2.hidden = true;
        const name = String(data.get("name") || "");
        const workspacePath = String(data.get("workspace_path") || "");
        void api("/api/projects", { method: "POST", body: JSON.stringify({ name, workspace_path: workspacePath }) }).then(async (project) => {
          if (project.command_id) {
            const command = await waitForRemoteCommand(project.command_id);
            if (command.status !== "applied") throw new Error(command.error || "command_rejected");
            await loadProjects();
            project = state.projects.find((item) => projectRootPaths(item).includes(workspacePath) && projectLabel(item) === name);
            if (!project) throw new Error("project_not_found");
          }
          finish();
          await loadProjects();
          await openProjectDetail(project.id);
        }).catch((error) => {
          presentInlineError(output2, error, errorLabel(error), { source: "project_create" });
          submit2.disabled = false;
        });
      });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish();
      });
      bindModalDismiss(dialog, finish);
      document.body.appendChild(dialog);
      dialog.showModal();
      if (REMOTE) {
        void loadRemoteDirectory("");
        directoryPath.focus();
      } else {
        void chooseFolder();
      }
    }
    function showAutoDispatchHelp(initialView = "mode") {
      controllers().settings.open(initialView);
    }
    function renderSettingsOverlay(initialView = "mode") {
      document.getElementById("better-codex-auto-dispatch-help-dialog")?.remove();
      const dialog = document.createElement("dialog");
      dialog.id = "better-codex-auto-dispatch-help-dialog";
      dialog.setAttribute(OWNED, "true");
      const completionEnabled = !completionNoticeSuppressed();
      const completionDuration = completionNoticeDuration();
      const mockupTools = "";
      const modeDescription = (markdown) => '<div class="better-codex-help-mode-markdown">' + markdown.replace("{{start}}", '<span class="better-codex-help-inline-control is-start">' + te("立即开始任务") + "</span>").replace("{{send}}", '<span class="better-codex-help-inline-control is-send">' + te("发送") + "</span>").replace("{{agent}}", '<span class="better-codex-help-inline-state is-agent">' + icon("bot") + "<span>" + te("智能体") + "</span></span>").replace("{{backlog}}", '<span class="better-codex-help-inline-state is-backlog">' + icon("statusBacklog") + "<span>" + te("待规划") + "</span></span>") + "</div>";
      const helpMode = HELP_MODE_MARKDOWN[state.locale] || HELP_MODE_MARKDOWN.en;
      const defaultSchedulerModel = state.agentModelCatalog.find((model) => model.isDefault)?.id || state.agentModelCatalog[0]?.id || "gpt-5.6-sol";
      const schedulerModel = state.agentModelCatalog.some((model) => model.id === state.schedulerModel) ? state.schedulerModel : defaultSchedulerModel;
      const schedulerModelLabel = modelLabel(schedulerModel);
      const schedulerModelOptions = state.agentModelCatalog.map((model) => '<button type="button" role="option" data-setting-scheduler-model-option="' + escapeHtml2(model.id) + '" aria-selected="' + String(model.id === schedulerModel) + '" class="' + (model.id === schedulerModel ? "is-selected" : "") + '"><span>' + escapeHtml2(model.displayName) + '</span><span class="better-codex-help-model-check">' + (model.id === schedulerModel ? icon("check") : "") + "</span></button>").join("");
      const schedulerReasoningOptions = effortsForModel(schedulerModel);
      const schedulerReasoningEffort = schedulerReasoningOptions.some((item) => item.value === state.schedulerReasoningEffort) ? state.schedulerReasoningEffort : state.agentModelCatalog.find((model) => model.id === schedulerModel)?.defaultReasoningEffort || schedulerReasoningOptions[0]?.value || "high";
      const schedulerReasoningEffortLabel = effortLabel(schedulerReasoningEffort);
      const schedulerReasoningEffortOptions = schedulerReasoningOptions.map((option) => '<button type="button" role="option" data-setting-scheduler-reasoning-option="' + escapeHtml2(option.value) + '" aria-selected="' + String(option.value === schedulerReasoningEffort) + '" class="' + (option.value === schedulerReasoningEffort ? "is-selected" : "") + '"><span>' + escapeHtml2(option.label) + '</span><span class="better-codex-help-model-check">' + (option.value === schedulerReasoningEffort ? icon("check") : "") + "</span></button>").join("");
      const createIssueShortcut = readCreateIssueShortcut();
      const sendMode = readSendMode();
      const modifiedEnterLabel = shortcutLabel("Mod+Enter");
      const settingsPage = [
        '<section class="better-codex-help-page" data-help-page="settings" hidden>',
        '<div class="better-codex-help-setting-group"><h3>' + te("语言") + '</h3><div class="better-codex-help-setting-row is-language"><span><strong>' + te("界面语言") + "</strong><small>" + te("选择 Better Codex 的界面语言") + '</small></span><div class="better-codex-language-switch" role="radiogroup" aria-label="' + te("界面语言") + '" data-language-value="' + state.languageSetting + '"><button type="button" role="radio" data-language="system" aria-checked="' + String(state.languageSetting === "system") + '">' + te("跟随系统") + '</button><button type="button" role="radio" data-language="zh-CN" aria-checked="' + String(state.languageSetting === "zh-CN") + '">' + te("中文") + '</button><button type="button" role="radio" data-language="en" aria-checked="' + String(state.languageSetting === "en") + '">English</button></div></div></div>',
        '<div class="better-codex-help-setting-group"><h3>' + te("通知") + '</h3><div class="better-codex-help-setting-row is-notification"><span><strong>' + te("会话结束提醒") + "</strong><small>" + te("Issue 会话结束后在当前窗口显示提醒") + '</small></span><span class="better-codex-help-setting-controls"><span class="better-codex-help-duration' + (completionEnabled ? "" : " is-disabled") + '" data-setting-completion-picker><button type="button" class="better-codex-help-duration-toggle" data-setting-completion-duration aria-haspopup="listbox" aria-expanded="false" aria-label="' + te("弹窗持续时间") + '"' + (completionEnabled ? "" : " disabled") + ">" + te(completionDuration === 1e3 ? "1 秒" : completionDuration === 1e4 ? "10 秒" : completionDuration === 0 ? "永久" : "5 秒") + icon("chevronDown") + '</button><span class="better-codex-help-duration-menu" role="listbox" hidden>' + [[1e3, "1 秒"], [5e3, "5 秒"], [1e4, "10 秒"], [0, "永久"]].map(([value, label2]) => '<button type="button" role="option" data-setting-completion-option="' + value + '" aria-selected="' + String(completionDuration === value) + '" class="' + (completionDuration === value ? "is-selected" : "") + '">' + te(label2) + (completionDuration === value ? icon("check") : "") + "</button>").join("") + '</span></span><input type="checkbox" data-setting-completion aria-label="' + te("会话结束提醒") + '"' + (completionEnabled ? " checked" : "") + "></span></div></div>",
        '<div class="better-codex-help-setting-group"><h3>' + te("调度") + '</h3><div class="better-codex-help-setting-row is-model"><span><strong>' + te("调度器模型") + "</strong><small>" + te("这个模型用于 Issue 状态调度") + '</small></span><span class="better-codex-help-setting-controls better-codex-help-scheduler-controls"><span class="better-codex-help-model" data-setting-scheduler-model-picker><button type="button" class="better-codex-help-model-toggle" data-setting-scheduler-model aria-haspopup="listbox" aria-expanded="false" aria-label="' + te("调度器模型") + '"><span data-setting-scheduler-model-label>' + escapeHtml2(schedulerModelLabel) + "</span>" + icon("chevronDown") + '</button><span class="better-codex-help-model-menu" role="listbox" hidden><span class="better-codex-help-model-title">' + te("模型") + "</span>" + schedulerModelOptions + '</span></span><span class="better-codex-help-model" data-setting-scheduler-reasoning-picker><button type="button" class="better-codex-help-model-toggle" data-setting-scheduler-reasoning aria-haspopup="listbox" aria-expanded="false" aria-label="' + te("调度器思考强度") + '"><span data-setting-scheduler-reasoning-label>' + escapeHtml2(schedulerReasoningEffortLabel) + "</span>" + icon("chevronDown") + '</button><span class="better-codex-help-model-menu" role="listbox" hidden><span class="better-codex-help-model-title">' + te("调度器思考强度") + "</span>" + schedulerReasoningEffortOptions + "</span></span></span></div></div>",
        "</section>"
      ].join("");
      const shortcutPage = '<section class="better-codex-help-page" data-help-page="shortcuts" hidden><div class="better-codex-help-setting-group"><h3>' + te("发送方式") + '</h3><div class="better-codex-help-setting-row is-send-mode"><span><strong>' + te("发送消息") + "</strong><small>" + te("选择消息输入框的发送按键") + '</small></span><div class="better-codex-send-mode-switch" role="radiogroup" aria-label="' + te("发送方式") + '" data-send-mode-value="' + sendMode + '"><button type="button" role="radio" data-send-mode="mod-enter" aria-checked="' + String(sendMode === "mod-enter") + '">' + escapeHtml2(modifiedEnterLabel) + '</button><button type="button" role="radio" data-send-mode="enter" aria-checked="' + String(sendMode === "enter") + '">Enter</button></div></div></div><div class="better-codex-help-setting-group"><h3>' + te("快捷键") + '</h3><div class="better-codex-help-setting-row is-shortcut"><span><strong>' + te("新建会话") + "</strong><small>" + te("开启当前项目的新会话") + '</small></span><span class="better-codex-help-shortcut-controls"><button type="button" class="better-codex-help-shortcut-key" data-setting-create-issue-shortcut aria-pressed="false">' + escapeHtml2(createIssueShortcut ? shortcutLabel(createIssueShortcut) : te("点击录入")) + '</button><button type="button" class="better-codex-help-shortcut-clear" data-setting-create-issue-shortcut-clear' + (createIssueShortcut ? "" : " disabled") + ">" + te("清除快捷键") + "</button></span></div></div></section>";

      dialog.innerHTML = [
        '<div class="better-codex-auto-dispatch-help-shell" data-help-view="mode">',
        '<header><div class="better-codex-help-tabs" role="tablist" aria-label="' + te("帮助与设置") + '"><button type="button" class="is-active" data-help-view="mode" aria-selected="true">' + te("运行模式说明") + '</button><button type="button" data-help-view="settings" aria-selected="false">' + te("设置") + '</button><button type="button" data-help-view="shortcuts" aria-selected="false">' + te("快捷键") + '</button><button type="button" data-help-view="about" aria-selected="false">' + te("关于") + "</button></div>" + mockupTools + '<button type="button" data-help-close aria-label="' + te("关闭") + '">' + icon("close") + "</button></header>",
        '<main class="better-codex-help-content">',
        '<section class="better-codex-help-page is-active" data-help-page="mode"><div class="better-codex-auto-dispatch-help-panels"><article class="better-codex-auto-dispatch-help-panel is-manual"><div class="better-codex-auto-dispatch-help-heading">' + icon("user") + "<h3>" + te("手动运行") + "</h3></div>" + modeDescription(helpMode.manual) + "</article>",
        '<div class="better-codex-auto-dispatch-help-divider" aria-hidden="true"></div>',
        '<article class="better-codex-auto-dispatch-help-panel is-auto"><div class="better-codex-auto-dispatch-help-heading">' + icon("refresh") + "<h3>" + te("自动运行") + "</h3></div>" + modeDescription(helpMode.auto) + "</article></div></section>",
        settingsPage,
        shortcutPage,
        '<section class="better-codex-help-page" data-help-page="about" hidden><div class="better-codex-help-about"><span class="better-codex-help-about-logo">' + betterCodexLogo() + '</span><div><h2>Better Codex</h2><p class="better-codex-help-about-slogan">' + te("从开始到完成，让 Codex 里的工作清晰可见。") + '</p></div><span class="better-codex-help-runtime-status"><span class="better-codex-help-status-dot"></span>' + te("运行正常") + '</span></div><dl class="better-codex-help-about-details"><div><dt>' + te("版本信息") + '</dt><dd><button class="better-codex-help-check-update" type="button" data-check-update>' + te("检查新版本") + '</button><span data-product-core></span></dd></div></dl><div class="better-codex-help-github-row"><a class="better-codex-help-github" href="https://github.com/Ericwong5021/better-codex" target="_blank" rel="noreferrer">' + githubLogo() + '<span class="better-codex-help-github-name">Better Codex</span><span class="better-codex-help-github-stars">' + icon("star", "better-codex-help-star") + "</span></a><p>" + te("如果你喜欢 Better Codex，欢迎给我们一个 Star。") + "</p></div></section>",
        "</main>",
        "</div>"
      ].join("");
      const finish = () => {
        document.removeEventListener("pointerdown", closeMockupOutside, true);
        dialog.close();
        dialog.remove();
      };
      const mockupMenu = dialog.querySelector(".better-codex-help-mockup-menu");
      const mockupToggle = dialog.querySelector("[data-mockup-menu-toggle]");
      const closeMockupMenu = () => {
        if (!mockupMenu || !mockupToggle) return;
        mockupMenu.hidden = true;
        mockupToggle.setAttribute("aria-expanded", "false");
      };
      const closeMockupOutside = (event) => {
        if (dialog.querySelector(".better-codex-help-mockup")?.contains(event.target)) return;
        closeMockupMenu();
      };
      mockupToggle?.addEventListener("click", (event) => {
        event.stopPropagation();
        const opening = mockupMenu.hidden;
        closeMockupMenu();
        if (opening) {
          mockupMenu.hidden = false;
          mockupToggle.setAttribute("aria-expanded", "true");
        }
      });
      document.addEventListener("pointerdown", closeMockupOutside, true);
      dialog.querySelector("[data-mockup-export]")?.addEventListener("click", () => {
        closeMockupMenu();
        void perform(exportMockupIssues);
      });
      const mockupImportInput = dialog.querySelector("[data-mockup-import-input]");
      dialog.querySelector("[data-mockup-import]")?.addEventListener("click", () => mockupImportInput.click());
      mockupImportInput?.addEventListener("change", () => {
        const file = mockupImportInput.files?.[0];
        mockupImportInput.value = "";
        closeMockupMenu();
        if (file) void perform(() => importMockupIssues(file));
      });
      dialog.querySelector("[data-mockup-reset]")?.addEventListener("click", () => {
        closeMockupMenu();
        void perform(confirmMockupReset);
      });
      dialog.querySelectorAll("[data-help-close]").forEach((button2) => button2.addEventListener("click", finish));
      const setHelpView = (view) => {
        dialog.querySelector(".better-codex-auto-dispatch-help-shell").dataset.helpView = view;
        dialog.querySelectorAll("[data-help-view]").forEach((item) => {
          const selected = item.dataset.helpView === view;
          item.classList.toggle("is-active", selected);
          item.setAttribute("aria-selected", String(selected));
        });
        dialog.querySelectorAll("[data-help-page]").forEach((page) => {
          const selected = page.dataset.helpPage === view;
          page.hidden = !selected;
          page.classList.toggle("is-active", selected);
        });
      };
      dialog.querySelectorAll("[data-help-view]").forEach((button2) => button2.addEventListener("click", () => setHelpView(button2.dataset.helpView)));

      const languageSwitch = dialog.querySelector("[data-language-value]");
      languageSwitch.querySelectorAll("[data-language]").forEach((button2) => button2.addEventListener("click", () => {
        const setting = button2.dataset.language;
        if (!["system", "zh-CN", "en"].includes(setting) || setting === state.languageSetting) return;
        localStorage.setItem(LANGUAGE_KEY, setting);
        state.languageSetting = setting;
        state.systemLocale = resolveSystemLocale(state.systemLocale);
        state.locale = setting === "system" ? state.systemLocale : setting;
        if (HOST_KIND === "web") window.dispatchEvent(new CustomEvent("better-codex:bootstrap", { detail: { user: state.user, locale: state.locale } }));
        finish();
        panelSizeCleanup?.();
        panelSizeCleanup = null;
        panel?.remove();
        panel = null;
        ensureEntry();
        mountPanel();
        if (!state.mockup) {
          render();
          showAutoDispatchHelp("settings");
          return;
        }
        state.issues = [];
        state.agents = [];
        void load().then(() => showAutoDispatchHelp("settings")).catch(() => render());
      }));
      const sendModeSwitch = dialog.querySelector("[data-send-mode-value]");
      sendModeSwitch.querySelectorAll("[data-send-mode]").forEach((button2) => button2.addEventListener("click", () => {
        const value = button2.dataset.sendMode;
        if (!["mod-enter", "enter"].includes(value)) return;
        localStorage.setItem(SEND_MODE_KEY, value);
        sendModeSwitch.dataset.sendModeValue = value;
        sendModeSwitch.querySelectorAll("[data-send-mode]").forEach((option) => option.setAttribute("aria-checked", String(option.dataset.sendMode === value)));
      }));
      const shortcutButton = dialog.querySelector("[data-setting-create-issue-shortcut]");
      const shortcutClear = dialog.querySelector("[data-setting-create-issue-shortcut-clear]");
      let recordingShortcut = false;
      const syncShortcutControls = (shortcut) => {
        const value = normalizeShortcut(shortcut);
        shortcutButton.textContent = recordingShortcut ? te("按下新的快捷键") : value ? shortcutLabel(value) : te("点击录入");
        shortcutButton.dataset.settingShortcutRecording = String(recordingShortcut);
        shortcutButton.setAttribute("aria-pressed", String(recordingShortcut));
        shortcutClear.disabled = recordingShortcut || !value;
      };
      const setShortcutRecording = (recording) => {
        recordingShortcut = recording;
        syncShortcutControls(readCreateIssueShortcut());
      };
      shortcutButton.addEventListener("click", () => setShortcutRecording(!recordingShortcut));
      shortcutClear.addEventListener("click", () => {
        localStorage.removeItem(CREATE_ISSUE_SHORTCUT_KEY);
        setShortcutRecording(false);
      });
      dialog.addEventListener("keydown", (event) => {
        if (!recordingShortcut) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") return setShortcutRecording(false);
        const shortcut = shortcutFromKeyboardEvent(event);
        if (!shortcut) return;
        localStorage.setItem(CREATE_ISSUE_SHORTCUT_KEY, shortcut);
        setShortcutRecording(false);
        syncShortcutControls(shortcut);
      });
      const completionToggle = dialog.querySelector("[data-setting-completion]");
      const positionHelpMenu = (toggle, menu) => {
        const viewportTop = window.visualViewport?.offsetTop || 0;
        const viewportBottom = viewportTop + (window.visualViewport?.height || window.innerHeight);
        const toggleRect = toggle.getBoundingClientRect();
        const spaceAbove = Math.max(0, toggleRect.top - viewportTop - 12);
        const spaceBelow = Math.max(0, viewportBottom - toggleRect.bottom - 12);
        const openAbove = spaceBelow < 280 && spaceAbove > spaceBelow;
        const availableHeight = Math.min(320, Math.max(140, openAbove ? spaceAbove : spaceBelow));
        menu.classList.toggle("is-above", openAbove);
        menu.style.maxHeight = Math.floor(availableHeight) + "px";
        const selected = menu.querySelector(".is-selected");
        if (selected && typeof selected.scrollIntoView === "function") {
          selected.scrollIntoView({ block: "nearest" });
        }
      };
      const completionDurationSelect = dialog.querySelector("[data-setting-completion-duration]");
      const completionDurationPicker = dialog.querySelector("[data-setting-completion-picker]");
      const completionDurationMenu = dialog.querySelector(".better-codex-help-duration-menu");
      const closeCompletionDurationMenu = () => {
        completionDurationPicker.classList.remove("is-open");
        completionDurationMenu.hidden = true;
        completionDurationSelect.setAttribute("aria-expanded", "false");
        completionDurationMenu.classList.remove("is-above");
        completionDurationMenu.style.removeProperty("max-height");
      };
      const schedulerModelPicker = dialog.querySelector("[data-setting-scheduler-model-picker]");
      const schedulerModelSelect = dialog.querySelector("[data-setting-scheduler-model]");
      const schedulerModelMenu = schedulerModelPicker.querySelector(".better-codex-help-model-menu");
      const schedulerModelLabelNode = dialog.querySelector("[data-setting-scheduler-model-label]");
      const schedulerReasoningPicker = dialog.querySelector("[data-setting-scheduler-reasoning-picker]");
      const schedulerReasoningSelect = dialog.querySelector("[data-setting-scheduler-reasoning]");
      const schedulerReasoningMenu = schedulerReasoningPicker.querySelector(".better-codex-help-model-menu");
      const schedulerReasoningLabelNode = dialog.querySelector("[data-setting-scheduler-reasoning-label]");
      const closeSchedulerModelMenu = () => {
        schedulerModelPicker.classList.remove("is-open");
        schedulerModelMenu.hidden = true;
        schedulerModelSelect.setAttribute("aria-expanded", "false");
        schedulerModelMenu.classList.remove("is-above");
        schedulerModelMenu.style.removeProperty("max-height");
      };
      const closeSchedulerReasoningMenu = () => {
        schedulerReasoningPicker.classList.remove("is-open");
        schedulerReasoningMenu.hidden = true;
        schedulerReasoningSelect.setAttribute("aria-expanded", "false");
        schedulerReasoningMenu.classList.remove("is-above");
        schedulerReasoningMenu.style.removeProperty("max-height");
      };
      const syncSchedulerModel = (model) => {
        state.schedulerModel = model;
        schedulerModelLabelNode.textContent = modelLabel(model);
        schedulerModelMenu.querySelectorAll("[data-setting-scheduler-model-option]").forEach((item) => {
          const selected = item.dataset.settingSchedulerModelOption === model;
          item.classList.toggle("is-selected", selected);
          item.setAttribute("aria-selected", String(selected));
          item.querySelector(".better-codex-help-model-check").innerHTML = selected ? icon("check") : "";
        });
      };
      const syncSchedulerReasoning = (effort) => {
        state.schedulerReasoningEffort = effort;
        schedulerReasoningLabelNode.textContent = effortLabel(effort);
        schedulerReasoningMenu.querySelectorAll("[data-setting-scheduler-reasoning-option]").forEach((item) => {
          const selected = item.dataset.settingSchedulerReasoningOption === effort;
          item.classList.toggle("is-selected", selected);
          item.setAttribute("aria-selected", String(selected));
          item.querySelector(".better-codex-help-model-check").innerHTML = selected ? icon("check") : "";
        });
      };
      const renderSchedulerReasoningOptions = (model, preferred) => {
        const options = effortsForModel(model);
        const entry2 = state.agentModelCatalog.find((item) => item.id === model);
        const effort = options.some((item) => item.value === preferred) ? preferred : entry2?.defaultReasoningEffort || options[0]?.value || "high";
        schedulerReasoningMenu.innerHTML = '<span class="better-codex-help-model-title">' + te("调度器思考强度") + "</span>" + options.map((option) => '<button type="button" role="option" data-setting-scheduler-reasoning-option="' + escapeHtml2(option.value) + '" aria-selected="' + String(option.value === effort) + '" class="' + (option.value === effort ? "is-selected" : "") + '"><span>' + escapeHtml2(option.label) + '</span><span class="better-codex-help-model-check">' + (option.value === effort ? icon("check") : "") + "</span></button>").join("");
        syncSchedulerReasoning(effort);
        return effort;
      };
      completionToggle.addEventListener("change", (event) => {
        sessionStorage.setItem("better-codex-completion-notice-disabled", String(!event.currentTarget.checked));
        completionDurationSelect.disabled = !event.currentTarget.checked;
        completionDurationPicker.classList.toggle("is-disabled", !event.currentTarget.checked);
        if (!event.currentTarget.checked) closeCompletionDurationMenu();
      });
      completionDurationSelect.addEventListener("click", (event) => {
        event.stopPropagation();
        if (completionDurationSelect.disabled) return;
        const opening = completionDurationMenu.hidden;
        closeCompletionDurationMenu();
        closeSchedulerModelMenu();
        closeSchedulerReasoningMenu();
        if (opening) {
          completionDurationPicker.classList.add("is-open");
          completionDurationMenu.hidden = false;
          completionDurationSelect.setAttribute("aria-expanded", "true");
          positionHelpMenu(completionDurationSelect, completionDurationMenu);
        }
      });
      completionDurationMenu.querySelectorAll("[data-setting-completion-option]").forEach((option) => option.addEventListener("click", () => {
        const duration = Number(option.dataset.settingCompletionOption);
        if (![0, 1e3, 5e3, 1e4].includes(duration)) return;
        localStorage.setItem(COMPLETION_DURATION_KEY, String(duration));
        completionDurationSelect.firstChild.textContent = te(duration === 1e3 ? "1 秒" : duration === 1e4 ? "10 秒" : duration === 0 ? "永久" : "5 秒");
        completionDurationMenu.querySelectorAll("[data-setting-completion-option]").forEach((item) => {
          const selected = Number(item.dataset.settingCompletionOption) === duration;
          item.classList.toggle("is-selected", selected);
          item.setAttribute("aria-selected", String(selected));
          const check = item.querySelector("svg");
          if (selected && !check) item.insertAdjacentHTML("beforeend", icon("check"));
          if (!selected && check) check.remove();
        });
        closeCompletionDurationMenu();
      }));
      schedulerModelSelect.addEventListener("click", (event) => {
        event.stopPropagation();
        const opening = schedulerModelMenu.hidden;
        closeSchedulerModelMenu();
        closeCompletionDurationMenu();
        closeSchedulerReasoningMenu();
        if (opening) {
          schedulerModelPicker.classList.add("is-open");
          schedulerModelMenu.hidden = false;
          schedulerModelSelect.setAttribute("aria-expanded", "true");
          positionHelpMenu(schedulerModelSelect, schedulerModelMenu);
        }
      });
      schedulerModelMenu.querySelectorAll("[data-setting-scheduler-model-option]").forEach((option) => option.addEventListener("click", async () => {
        const model = option.dataset.settingSchedulerModelOption;
        if (!state.agentModelCatalog.some((item) => item.id === model)) return;
        const previous2 = state.schedulerModel;
        const previousEffort = state.schedulerReasoningEffort;
        syncSchedulerModel(model);
        const nextEffort = renderSchedulerReasoningOptions(model, previousEffort);
        closeSchedulerModelMenu();
        try {
          const result = await api("/api/settings/scheduler-model", { method: "PATCH", body: JSON.stringify({ model }) });
          syncSchedulerModel(result.model || model);
          renderSchedulerReasoningOptions(result.model || model, result.reasoning_effort || nextEffort);
        } catch {
          syncSchedulerModel(previous2);
          renderSchedulerReasoningOptions(previous2, previousEffort);
        }
      }));
      schedulerReasoningSelect.addEventListener("click", (event) => {
        event.stopPropagation();
        const opening = schedulerReasoningMenu.hidden;
        closeSchedulerReasoningMenu();
        closeSchedulerModelMenu();
        closeCompletionDurationMenu();
        if (opening) {
          schedulerReasoningPicker.classList.add("is-open");
          schedulerReasoningMenu.hidden = false;
          schedulerReasoningSelect.setAttribute("aria-expanded", "true");
          positionHelpMenu(schedulerReasoningSelect, schedulerReasoningMenu);
        }
      });
      schedulerReasoningMenu.addEventListener("click", async (event) => {
        const option = event.target.closest("[data-setting-scheduler-reasoning-option]");
        if (!option) return;
        const effort = option.dataset.settingSchedulerReasoningOption;
        if (!effort || !effortsForModel(state.schedulerModel).some((item) => item.value === effort)) return;
        const previous2 = state.schedulerReasoningEffort;
        syncSchedulerReasoning(effort);
        closeSchedulerReasoningMenu();
        try {
          const result = await api("/api/settings/scheduler-reasoning-effort", { method: "PATCH", body: JSON.stringify({ reasoning_effort: effort }) });
          syncSchedulerReasoning(result.reasoning_effort || effort);
        } catch {
          syncSchedulerReasoning(previous2);
        }
      });
      document.addEventListener("pointerdown", (event) => {
        if (!completionDurationPicker.contains(event.target)) closeCompletionDurationMenu();
        if (!schedulerModelPicker.contains(event.target)) closeSchedulerModelMenu();
        if (!schedulerReasoningPicker.contains(event.target)) closeSchedulerReasoningMenu();
      });
      const checkUpdate = dialog.querySelector("[data-check-update]");
      const renderUpdateState = (update, checked = false) => {
        const sourceBuild = update?.coreUpdateSupported === false;
        checkUpdate.textContent = t(update?.status === "available" ? sourceBuild ? "发现兼容更新" : "发现新版本" : update?.status === "error" ? "无法检查更新" : sourceBuild ? "源码开发版" : checked ? "已是最新版本" : "检查新版本");
        checkUpdate.title = sourceBuild ? t("源码开发版仅检查兼容层更新，核心版本请更新源码并重新构建。") : "";
      };
      checkUpdate.addEventListener("click", async () => {
        checkUpdate.disabled = true;
        checkUpdate.textContent = t("检查中…");
        try {
          const update = await api(runtimeUpdatePath("/check"), { method: "POST" });
          renderUpdateState(update, true);
          if (update?.status === "available") {
            finish();
            renderUpdateNotice(update, true);
          }
        } catch {
          checkUpdate.textContent = t("无法检查更新");
        } finally {
          checkUpdate.disabled = false;
        }
      });
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish();
      });
      bindModalDismiss(dialog, finish);
      document.body.appendChild(dialog);
      dialog.showModal();
      setHelpView(initialView);
      dialog.querySelector("[data-product-core]").textContent = "v" + CORE_VERSION;
      void api(runtimeUpdatePath()).then((update) => {
        if (!dialog.isConnected) return;
        renderUpdateState(update);
      }).catch(() => {
      });
    }
    function syncAutoDispatch() {
      const button2 = panel?.querySelector("#better-codex-auto-dispatch");
      if (!button2) return;
      const label2 = state.autoDispatchPending ? "切换中…" : state.autoDispatch ? "自动运行" : "手动运行";
      const markup = icon(state.autoDispatch || state.autoDispatchPending ? "refresh" : "user") + "<span>" + te(label2) + "</span>";
      button2.classList.toggle("is-on", state.autoDispatch);
      button2.setAttribute("aria-pressed", String(state.autoDispatch));
      button2.disabled = state.autoDispatchPending;
      button2.setAttribute("aria-busy", String(state.autoDispatchPending));
      button2.removeAttribute("title");
      button2.setAttribute("aria-label", t(state.autoDispatch ? "切换为手动运行" : "切换为自动运行"));
      if (button2.__betterCodexMarkup !== markup) {
        button2.innerHTML = markup;
        button2.__betterCodexMarkup = markup;
      }
    }
    function syncMockupUi() {
      if (!panel) return;
      panel.dataset.mockup = String(state.mockup);
      const autoDispatch = panel.querySelector("#better-codex-auto-dispatch");
      if (autoDispatch) autoDispatch.hidden = false;
      const createToggle = panel.querySelector("#better-codex-create-toggle");
      if (createToggle) createToggle.hidden = false;
    }
    function syncBoardAttributes(current, next) {
      Array.from(current.attributes).forEach((attribute) => {
        if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      });
      Array.from(next.attributes).forEach((attribute) => {
        if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      });
    }
    function syncBoardElement(current, next) {
      const markup = next.innerHTML;
      syncBoardAttributes(current, next);
      if (current.__betterCodexMarkup === markup) return;
      if (current.innerHTML !== markup) current.innerHTML = markup;
      current.__betterCodexMarkup = markup;
    }
    function reconcileBoard(board, markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      const nextColumns = Array.from(template.content.children);
      const currentColumns = new Map(Array.from(board.querySelectorAll(":scope > .better-codex-column")).map((column) => [column.dataset.status, column]));
      const currentCards = new Map(Array.from(board.querySelectorAll("[data-issue-id]")).map((card) => [card.dataset.issueId, card]));
      const retainedColumns = /* @__PURE__ */ new Set();
      nextColumns.forEach((nextColumn, columnIndex) => {
        const status = nextColumn.dataset.status;
        let currentColumn = currentColumns.get(status);
        const nextHead = nextColumn.querySelector(":scope > .better-codex-column-head");
        const nextCards = nextColumn.querySelector(":scope > .better-codex-cards");
        const currentHead = currentColumn?.querySelector(":scope > .better-codex-column-head");
        const currentCardsContainer = currentColumn?.querySelector(":scope > .better-codex-cards");
        if (!currentColumn || !nextHead || !nextCards || !currentHead || !currentCardsContainer) {
          currentColumn = nextColumn;
          if (nextHead) nextHead.__betterCodexMarkup = nextHead.innerHTML;
          Array.from(nextCards?.children || []).forEach((card) => {
            card.__betterCodexMarkup = card.innerHTML;
          });
        } else {
          syncBoardAttributes(currentColumn, nextColumn);
          syncBoardElement(currentHead, nextHead);
          const retainedCards = /* @__PURE__ */ new Set();
          Array.from(nextCards.children).forEach((nextCard, cardIndex) => {
            const issueId = nextCard.dataset.issueId;
            let currentCard = issueId ? currentCards.get(issueId) : Array.from(currentCardsContainer.children).find((card) => !card.dataset.issueId);
            if (!currentCard || currentCard.tagName !== nextCard.tagName) {
              currentCard = nextCard;
              currentCard.__betterCodexMarkup = currentCard.innerHTML;
            } else syncBoardElement(currentCard, nextCard);
            retainedCards.add(currentCard);
            if (currentCardsContainer.children[cardIndex] !== currentCard) currentCardsContainer.insertBefore(currentCard, currentCardsContainer.children[cardIndex] || null);
          });
          Array.from(currentCardsContainer.children).forEach((card) => {
            if (!retainedCards.has(card)) card.remove();
          });
        }
        retainedColumns.add(currentColumn);
        if (board.children[columnIndex] !== currentColumn) board.insertBefore(currentColumn, board.children[columnIndex] || null);
      });
      Array.from(board.children).forEach((column) => {
        if (!retainedColumns.has(column)) column.remove();
      });
    }
    function render() {
      if (inlineConversation) { renderInlineConversation(); return; }
      if (!panel) return;
      panel.dataset.surface = state.surface;
      if (HOST_KIND === "web" && state.surface !== "projects") document.title = t(state.surface === "agents" ? "智能体" : "任务看板") + " · Better Codex";
      syncAutoDispatch();
      syncMockupUi();
      if (state.surface === "agents") {
        activateFeature("agents");
        hydrateSharedControls(panel, "agents");
        return;
      }
      if (state.surface === "projects") {
        activateFeature("projects");
        hydrateSharedControls(panel, "projects");
        return;
      }
      activateFeature("board");
    }
    function renderBoard(options = {}) {
      if (!panel && !options.board) return;
      const projectBoard = Boolean(options.projectId);
      const sourceIssues = options.issues || state.issues;
      if (!projectBoard && panel) {
        const runningCount = state.issues.filter((issue) => issueExecutionRunning(issue)).length;
        panel.querySelectorAll("[data-view]").forEach((button2) => button2.classList.toggle("is-active", button2.dataset.view === state.view));
        const working = panel.querySelector("#better-codex-working");
        if (working) {
          const workingMarkup = icon("board") + "<span>" + te(runningCount + " 项工作进行中") + "</span>";
          if (working.innerHTML !== workingMarkup) working.innerHTML = workingMarkup;
          working.dataset.runningCount = String(runningCount);
          working.setAttribute("aria-label", t(runningCount + " 项工作进行中"));
          working.title = t(runningCount ? "查看运行中的任务" : "当前没有运行中的任务");
          working.classList.toggle("has-work", runningCount > 0);
          working.classList.toggle("is-active", state.view === "working");
          working.hidden = false;
        }
        const filterButton = panel.querySelector("#better-codex-filter");
        if (filterButton) {
          const filterCount = Object.values(state.filters).reduce((total, values) => total + values.length, 0);
          const filterMarkup = icon("filter") + "<span>" + te(filterCount ? filterCount + " 个筛选" : "筛选") + "</span>";
          if (filterButton.innerHTML !== filterMarkup) filterButton.innerHTML = filterMarkup;
          filterButton.setAttribute("aria-label", t(filterCount ? filterCount + " 个筛选" : "筛选"));
          filterButton.classList.toggle("is-active", filterCount > 0);
        }
      }
      const visible = sourceIssues.filter((issue) => {
        const assigned = Boolean(issue.agent_enabled || issue.user_assigned);
        const matchesView = projectBoard || state.view === "all" || state.view === "assigned" && assigned || state.view === "unassigned" && !assigned || state.view === "working" && issueExecutionRunning(issue);
        return matchesView && (projectBoard || issueMatchesFilters(issue));
      });
      const board = options.board || panel.querySelector("#better-codex-board");
      if (!board) throw new Error(projectBoard ? "project_board_mount_missing" : "board_mount_missing");
      if (!(options.loaded ?? state.issuesLoaded)) {
        board.innerHTML = '<section class="better-codex-board-loading" role="status" aria-live="polite"><span aria-hidden="true"></span><strong>' + te("正在加载任务看板") + "</strong></section>";
        if (!projectBoard) requestAnimationFrame(syncBoardScrollControl);
        return;
      }
      const visibleStatuses = [...Object.entries(statusLabels), ["archive", "归档"]];
      const boardMarkup = visibleStatuses.map(([status, statusLabel]) => {
        const archiveColumn = status === "archive";
        const issues = archiveColumn ? [] : visible.filter((issue) => issue.status === status);
        const cards = issues.map((issue) => {
          const permissions = issuePermissions(issue);
          const enrichmentLocked = permissions.enrichmentPending;
          const executionRunning = permissions.executionRunning;
          const issueLocked = permissions.boardLocked;
          const assignedAgent = state.agents.find((agent) => agent.id === issue.agent_id);
          const defaultAgent = state.agents.find((agent) => agent.is_default);
          const assignee = issue.agent_enabled ? assignedAgent || defaultAgent || { name: "Codex", is_default: true } : null;
          const agentName = mockupText(agentDisplayName(assignee));
          const activityAgent = assignee || defaultAgent || { name: "Codex", is_default: true };
          const latestRunStatus = issue.latest_run_status || "";
          const replyResultState = issue.reply_status === "succeeded" ? "completed" : ["failed", "interrupted"].includes(issue.reply_status) ? issue.reply_status : "";
          const executionState = workflowActivityState(issue, issue.status === "done" ? "completed" : issue.status === "cancelled" ? "interrupted" : issue.status === "blocked" ? "blocked" : issue.status === "in_review" ? issue.latest_scheduler_status === "failed" ? "scheduler-failed" : "in_review" : replyResultState || (latestRunStatus === "failed" ? "failed" : latestRunStatus === "interrupted" ? "interrupted" : latestRunStatus === "scheduling" ? "scheduling" : latestRunStatus === "running" ? "running" : latestRunStatus === "claimed" ? "claimed" : issue.agent_enabled ? "not-started" : ""));
          const sessionExecutionState = issue.session_status === "stopping" ? "stopping" : issue.session_status === "starting" ? "claimed" : ["active", "waiting_on_approval", "waiting_on_user"].includes(issue.session_status) ? "running" : "";
          const activeExecutionState = issue.active_run_status || (issue.reply_status === "running" ? "running" : sessionExecutionState);
          const activityState = permissions.remotePending ? "remote-pending" : permissions.remoteConflict ? "remote-conflict" : enrichmentLocked ? "thinking" : issue.session_status === "stopping" ? "stopping" : issue.session_retry ? "retrying" : activeExecutionState || (issue.enrichment_status === "failed" ? "title-regeneration-failed" : executionState);
          const activityLabel = activityState === "retrying" ? escapeHtml2(sessionRetryCardLabel(issue.session_retry)) : t(activityState === "remote-pending" ? "同步中" : activityState === "remote-conflict" ? "同步冲突" : issue.enrichment_status === "regenerating" ? "标题生成中" : activityState === "title-regeneration-failed" ? "标题生成失败" : activityState === "stopping" ? "正在停止…" : activityState === "running" ? "工作中" : activityState === "scheduling" ? "调度中" : activityState === "scheduler-failed" ? "调度失败" : activityState === "claimed" ? "排队中" : activityState === "in_progress" ? "进行中" : activityState === "in_review" ? "待审核" : activityState === "completed" ? "已完成" : activityState === "blocked" ? "已阻塞" : activityState === "failed" ? "执行失败" : activityState === "interrupted" ? "已停止" : activityState === "not-started" ? "未开始" : "");
          const activityIcon = activityState === "retrying" ? '<span class="better-codex-activity-dot" aria-hidden="true"></span>' : activityState === "scheduling" ? '<span class="better-codex-activity-dot better-codex-scheduler-dot" aria-hidden="true"></span>' : activityState === "scheduler-failed" ? '<span class="better-codex-activity-dot better-codex-scheduler-failed-dot" aria-hidden="true"></span>' : ["completed", "interrupted", "not-started"].includes(activityState) ? '<span class="better-codex-activity-dot" aria-hidden="true"></span>' : ["failed", "blocked", "remote-conflict", "title-regeneration-failed"].includes(activityState) ? icon("close") : agentAvatarMarkup(activityAgent, "better-codex-card-avatar");
          const activity = activityState ? '<span class="better-codex-activity" data-run="' + escapeHtml2(activityState) + '" title="' + (activityState === "retrying" ? escapeHtml2(sessionRetryDetail(issue.session_retry)) : activityLabel) + '">' + activityIcon + '<span class="' + ((enrichmentLocked || executionRunning || permissions.remotePending) && activityState !== "retrying" ? "better-codex-shimmer" : "") + '">' + activityLabel + "</span></span>" : "";
          const description = mockupText(issue.description).replace(/[#*_`~>[]()]/g, "").replace(/\s+/g, " ").trim();
          const issueProject = state.projects.find((item) => item.id === issue.project_id);
          const projectChip = projectLabel(issueProject) ? '<span class="better-codex-chip">' + icon("folder") + "<span>" + escapeHtml2(projectLabel(issueProject)) + "</span></span>" : "";
          const labelChips = (issue.labels || []).map((value) => '<span class="better-codex-chip">' + escapeHtml2(mockupText(value)) + "</span>").join("");
          const chips = projectChip + labelChips;
          const assignedUser = issueUserProfile(issue);
          const meta = assignee ? '<span class="better-codex-card-assignee">' + agentAvatarMarkup(assignee, "better-codex-card-avatar") + "<span>" + escapeHtml2(agentName || "Codex") + "</span></span>" : issue.user_assigned ? '<span class="better-codex-card-assignee">' + userAvatarMarkup(assignedUser, "better-codex-card-avatar") + "<span>" + escapeHtml2(assignedUser?.name || t("我")) + "</span></span>" : '<span class="better-codex-card-assignee is-empty">' + icon("user") + "<span>" + te("未分配") + "</span></span>";
          return '<article class="better-codex-card' + (issue.id === draggingIssueId ? " is-dragging" : "") + (enrichmentLocked ? " is-enrichment-pending" : "") + (executionRunning ? " is-execution-running" : "") + (permissions.remotePending ? " is-remote-pending" : "") + (permissions.remoteConflict ? " is-remote-conflict" : "") + '" draggable="' + String(!issueLocked && supportsIssueDrag()) + '" aria-disabled="' + String(issueLocked) + '"' + (issueLocked ? ' aria-busy="' + String(enrichmentLocked || executionRunning || permissions.remotePending) + '"' : "") + ' data-issue-id="' + escapeHtml2(issue.id) + '"><div class="better-codex-card-row"><div class="better-codex-card-id">' + priorityIcon(issue.priority) + "<span>" + escapeHtml2(issue.identifier) + "</span></div>" + activity + '</div><div class="better-codex-card-title">' + escapeHtml2(mockupText(issue.title)) + "</div>" + (description ? '<div class="better-codex-card-description">' + escapeHtml2(description) + "</div>" : "") + (chips ? '<div class="better-codex-chip-row">' + chips + "</div>" : "") + '<div class="better-codex-card-meta">' + meta + "<span>" + te("更新于 " + timeAgo(issue.updated_at)) + "</span></div></article>";
        }).join("");
        const columnButton = archiveColumn ? '<button class="better-codex-column-icon" type="button" data-archive-open aria-label="' + te("查看已归档卡片") + '" title="' + te("查看已归档卡片") + '">' + icon("archive") + "</button>" : '<button class="better-codex-column-icon" type="button" data-add-status="' + status + '" aria-label="' + te("新建会话") + '">' + icon("plus") + "</button>";
        return '<section class="better-codex-column" data-status="' + status + '"><div class="better-codex-column-head"><span class="better-codex-column-title">' + statusIcon(status) + "<span>" + te(statusLabel) + "</span>" + (archiveColumn ? "" : "<span>" + issues.length + "</span>") + '</span><span class="better-codex-column-actions">' + columnButton + '</span></div><div class="better-codex-cards">' + (cards || (archiveColumn ? '<div class="better-codex-empty">' + te("拖到这里即可归档") + "</div>" : "")) + "</div></section>";
      }).join("");
      reconcileBoard(board, boardMarkup);
      hydrateSharedControls(board, projectBoard ? "projects" : "board");
      if (!projectBoard) requestAnimationFrame(syncBoardScrollControl);
    }
    async function loadIssues(options = {}) {
      if (options.background && (draggingIssueId || sessionDragPointer?.dragging)) return;
      const query = new URLSearchParams();
      if (state.search) query.set("search", state.search);
      const issuePath = "/api/issues" + (query.toString() ? "?" + query : "");
      let issues;
      try {
        issues = await requestList(issuePath, "issues", { passive: Boolean(options.background) });
      } catch (error) {
        if (pendingIssueRemovals.size) return state.issues;
        throw error;
      }
      issues = issues.filter((issue) => !pendingIssueRemovals.has(issue.id));
      issues = issues.map((issue) => {
        const pending = pendingIssueReplies.get(issue.id);
        return pending ? { ...issue, ...pending.patch } : issue;
      });
      for (const pending of pendingIssueCreates.values()) {
        if (!issues.some((issue) => issue.id === pending.issue.id)) issues.push(pending.issue);
      }
      const changed = JSON.stringify(issues) !== JSON.stringify(state.issues);
      if (issueSessionSnapshot.size) {
        const ended = issues.filter((issue) => {
          const previous2 = issueSessionSnapshot.get(issue.id);
          return previous2 && (["claimed", "running", "scheduling"].includes(previous2.activeRunStatus) && !issue.active_run_status || previous2.replyStatus === "running" && issue.reply_status !== "running" || issue.last_activity_finished_at && issue.last_activity_finished_at !== previous2.lastActivityFinishedAt);
        });
        ended.sort((left, right) => new Date(left.updated_at).getTime() - new Date(right.updated_at).getTime()).forEach(renderSessionEndNotice);
      }
      issueSessionSnapshot = new Map(issues.map((issue) => [issue.id, { activeRunStatus: issue.active_run_status || "", replyStatus: issue.reply_status || "idle", lastActivityFinishedAt: issue.last_activity_finished_at || "" }]));
      state.issues = issues;
      state.issuesLoaded = true;
      const dialog = document.getElementById("better-codex-dialog");
      const dialogIssue = dialog?.dataset.issueId ? issues.find((issue) => issue.id === dialog.dataset.issueId) : null;
      if (dialog && dialogIssue && typeof dialog.__betterCodexSyncIssue === "function") dialog.__betterCodexSyncIssue(dialogIssue);
      if (options.background && !changed) return;
      if (options.background && state.surface === "agents" && state.agentPane !== "preview") return;
      render();
    }
    async function loadAgents(options = {}) {
      if (state.nativePlanningEnabled) {
        const previous = JSON.stringify([state.skillsManaged, state.skillsExternal]);
        await loadSkills(options);
        if (options.background && (state.agentPane !== "preview" || previous === JSON.stringify([state.skillsManaged, state.skillsExternal]))) return;
        render();
        return;
      }
      const agents = await normalizeAgentAvatarPngs(await requestList("/api/agents", "agents", { passive: Boolean(options.background) }));
      const changed = JSON.stringify(agents) !== JSON.stringify(state.agents);
      state.agents = agents;
      if (state.surface === "agents" && state.agentPane === "detail" && !agents.some((agent) => agentKey(agent) === state.selectedAgentId)) {
        state.agentPane = "preview";
        state.selectedAgentId = "";
        state.agentDraft = null;
        syncWebAgentRoute("", "replace");
      }
      if (options.preserveInspector && panel?.dataset.surface === "agents" && state.agentPane !== "preview") return;
      if (options.background && (state.agentPane !== "preview" || !changed)) return;
      render();
    }
    async function loadAutoDispatch(options = {}) {
      const result = await api("/api/settings/auto-dispatch", { passive: Boolean(options.background) });
      state.autoDispatch = result.enabled === true;
      syncAutoDispatch();
      return state.autoDispatch;
    }
    const commandObserver = createCommandObserver({
      read: (commandId) => api(commandStatusPath(commandId)),
      retryable: (error) => transientNetworkError(error) || error instanceof Error && ["command_not_found", "runtime_offline", "runtime_unavailable", "relay_stream_interrupted", "request_outcome_unknown"].includes(error.message),
      diagnostic: appendDiagnostic
    });
    function waitForRemoteCommand(commandId, timeoutMs = 3e4) {
      return commandObserver.wait(commandId, timeoutMs);
    }
    function watchQueuedCommand(commandId, handlers) {
      const failed = (error) => {
        if (destroyed) return;
        appendDiagnostic("queued_command_failed", { command_id: commandId, error: error.message });
        Promise.resolve().then(() => handlers.failed?.(error)).catch((callbackError) => reportUnexpectedError(callbackError, { source: "command_observer", command_id: commandId }));
      };
      return commandObserver.watch(commandId, {
        resolve: (command) => {
          if (destroyed) return;
          if (command.status !== "applied") return failed(new Error(command.error || "command_rejected"));
          appendDiagnostic("queued_command_applied", { command_id: commandId });
          Promise.resolve().then(() => handlers.applied?.(command.payload, command)).catch((error) => reportUnexpectedError(error, { source: "command_observer", command_id: commandId }));
        },
        reject: failed
      });
    }
    async function loadSurface(options = {}) {
      if (inlineConversation) {
        await reloadInlineConversationContext(options);
        if (inlineConversationTarget().kind === "work") await loadIssues(options);
        return;
      }
      if (state.surface === "agents") await loadAgents(options);
      else if (state.surface === "projects") {
        if (state.projectDetailId && state.projectPage === "work") await Promise.all([loadProjects(options), loadIssues(options)]);
        else await loadProjects(options);
      } else await loadIssues(options);
    }
    function ensureBootstrapReady() {
      if (bootstrapReady) return Promise.resolve();
      if (bootstrapPromise) return bootstrapPromise;
      const request = (async () => {
        const bootstrap = await api("/api/bootstrap");
        if (destroyed) throw new Error("injection_destroyed");
        applyAppearance(bootstrap.hostTheme || bootstrap.appearance);
        state.systemLocale = resolveSystemLocale(HOST_KIND === "web" ? INITIAL_LOCALE : bootstrap.locale);
        state.locale = state.languageSetting === "system" ? state.systemLocale : state.languageSetting;
        if (bootstrap.user && typeof bootstrap.user === "object") state.user = bootstrap.user;
        if (RELAY) {
          const relayUser = window.betterCodexHost?.user?.();
          const relayUsers = window.betterCodexHost?.users?.();
          if (relayUser?.id) state.user = relayUser;
          if (Array.isArray(relayUsers)) state.users = relayUsers;
        } else state.users = Array.isArray(bootstrap.users) ? bootstrap.users : [state.user];
        if (HOST_KIND === "web") window.dispatchEvent(new CustomEvent("better-codex:bootstrap", { detail: { user: state.user, locale: state.locale } }));
        state.mockup = Boolean(bootstrap.mockup);
        state.nativePlanningEnabled = bootstrap.native_planning_enabled === true;
        try { state.nativeUnboundThreads = JSON.parse(sessionStorage.getItem("better-codex-unbound-threads") || "{}"); } catch { state.nativeUnboundThreads = {}; }
        state.nativeThreadLinks ||= {};
        for (const binding of bootstrap.native_thread_bindings || []) {
          const threadId = normalizeSessionId(binding?.thread_id);
          if (!threadId || state.nativeUnboundThreads?.[threadId] || binding.host_id !== "local" || !binding.project_id || !["charter", "planning", "work"].includes(binding.kind)) continue;
          state.nativeThreadLinks[threadId] = { ...binding, thread_id: threadId };
        }
        if (state.nativePlanningEnabled) await loadSkills();
        try {
          state.agents = listResponse(bootstrap.agents, "/api/bootstrap", "agents");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "invalid_agents_response") throw error;
          state.agents = await requestList("/api/agents", "agents");
        }
        state.agents = await normalizeAgentAvatarPngs(state.agents);
        try {
          state.projects = listResponse(bootstrap.projects, "/api/bootstrap", "projects");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "invalid_projects_response") throw error;
          state.projects = await requestProjects();
        }
        state.agentModelCatalog = bootstrap.agentModelCatalog || (bootstrap.agentModels || []).map((id) => ({ id, displayName: id, description: "", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: (bootstrap.agentReasoningEfforts || []).map((value) => ({ value, description: "" })) }));
        state.agentModelCatalogError = bootstrap.agentModelCatalogError || null;
        if (state.agentModelCatalogError) {
          appendDiagnostic("model_catalog_unavailable", { error: state.agentModelCatalogError });
          state.error = t("模型列表暂不可用，请检查 Codex 会话服务后刷新。");
          const output = panel?.querySelector("#better-codex-error");
          if (output) {
            output.dataset.tone = "warning";
            output.textContent = state.error;
            output.hidden = false;
          }
        }
        state.agentModels = state.agentModelCatalog.map((model) => model.id);
        state.agentReasoningEfforts = bootstrap.agentReasoningEfforts || [];
        state.autoDispatch = Boolean(bootstrap.autoDispatch);
        state.schedulerModel = bootstrap.schedulerModel || state.agentModelCatalog.find((model) => model.isDefault)?.id || state.agentModels[0] || "gpt-5.6-sol";
        state.schedulerReasoningEffort = bootstrap.schedulerReasoningEffort || "high";
        const issueDescriptionLimit = Number(bootstrap.limits?.issue_description);
        if (Number.isInteger(issueDescriptionLimit) && issueDescriptionLimit > 0) state.issueDescriptionLimit = issueDescriptionLimit;
        if (destroyed) throw new Error("injection_destroyed");
        bootstrapReady = true;
        bootstrapFailure = null;
        if (state.nativePlanningEnabled && typeof window.BetterCodexNativeConversation?.create === "function") {
          try {
            const adapter = ensureInlineConversationAdapter();
            if (typeof adapter.connect === "function") void adapter.connect().then(() => registerInlineConversationBindings()).catch((error) => appendDiagnostic("native_inline_host_unavailable", { error: error instanceof Error ? error.message : String(error) }));
          } catch (error) { appendDiagnostic("native_inline_host_unavailable", { error: error instanceof Error ? error.message : String(error) }); }
        }
        ensureEntry();
        syncAutoDispatch();
      })();
      bootstrapPromise = request.catch((error) => {
        bootstrapReady = false;
        bootstrapFailure = error instanceof Error ? error.message : String(error);
        bootstrapPromise = null;
        appendDiagnostic("bootstrap_failed", {
          source: "bootstrap",
          error: error instanceof Error ? error.message : String(error || "bootstrap_failed")
        });
        throw error;
      });
      return bootstrapPromise;
    }
    async function load() {
      clearError();
      try {
        await ensureBootstrapReady();
        if (state.mockup) {
          state.projectId = MOCKUP_PROJECT_ID;
        } else {
          const context = readContext();
          if (context.projectId) {
            await ensureContextProject(context);
          } else if (!state.projects.some((item) => item.id === state.projectId)) {
            state.projectId = HOST_KIND === "web" ? "" : state.projects.find((item) => item.id === rememberedProjectId)?.id || state.projects[0]?.id || "";
          }
        }
        await loadSurface({ preserveInspector: true });
        if (state.surface === "agents" && state.agentPane !== "preview") render();
        if (!state.mockup && HOST_KIND === "web") state.projectId = projectsByRecentActivity(state.projects)[0]?.id || "";
        if (state.projectId) localStorage.setItem(PROJECT_KEY, state.projectId);
        if (!completionNoticesRestored) {
          completionNoticesRestored = true;
          restoreCompletionNotices();
        }
        hideServiceRecovery();
      } catch (error) {
        if (needsServiceRecovery(error)) return showServiceRecovery(error);
        const board = panel?.querySelector("#better-codex-board");
        const message = error instanceof Error ? error.message : "无法连接 Better Codex Runtime";
        showError(message);
        if (board) board.innerHTML = '<div class="better-codex-empty">' + te(message + " · 点击刷新重试") + "</div>";
      }
    }
    function startAgentCreate(draft = null) {
      if (!state.nativePlanningEnabled) return;
      state.agentPane = "create";
      state.selectedSkillId = "";
      state.skillDraft = draft || {};
      renderAgents();
      setTimeout(() => panel?.querySelector('[data-skill-form] [name="name"]')?.focus(), 0);
    }
    function agentFormBody(form, selected) {
      return {
        name: form.elements.name?.value || selected?.name || state.agentDraft?.name || form.elements.name_en?.value || "Codex",
        name_en: form.elements.name_en?.value || selected?.name_en || state.agentDraft?.name_en || "",
        description: form.elements.description?.value || "",
        instructions: form.elements.instructions?.value || "",
        model: form.elements.model.value,
        reasoning_effort: form.elements.reasoning_effort.value,
        service_tier: form.elements.fast?.checked ? "fast" : "default",
        sandbox_mode: form.elements.sandbox_mode.value,
        max_concurrency: Number(form.elements.max_concurrency?.value || 5),
        avatar: form.elements.avatar?.value || ""
      };
    }
    function setAgentAutosaveStatus(key, stateName, message) {
      const form = panel?.querySelector('[data-agent-form][data-agent-key="' + CSS.escape(key) + '"]');
      if (!form) return;
      const status = form.querySelector(".better-codex-agent-inspector-status");
      const error = form.querySelector(".better-codex-agent-inspector-error");
      status.hidden = stateName === "error";
      status.dataset.state = stateName;
      status.textContent = stateName === "error" ? "" : t(message);
      error.hidden = stateName !== "error";
      error.textContent = stateName === "error" ? t(message) : "";
    }
    function scheduleAgentAutosave(form, immediate = false) {
      const mode = form?.dataset.agentForm;
      if (!form || mode === "create" || AGENTS_READ_ONLY) return;
      if (!form.checkValidity()) {
        agentAutosavePending = null;
        clearTimeout(agentAutosaveTimer);
        agentAutosaveTimer = null;
        return;
      }
      const key = form.dataset.agentKey;
      const selected = state.agents.find((agent) => agentKey(agent) === key);
      if (!selected) return;
      agentAutosavePending = { key, mode, body: agentFormBody(form, selected) };
      setAgentAutosaveStatus(key, "saving", "正在自动保存…");
      clearTimeout(agentAutosaveTimer);
      agentAutosaveTimer = null;
      if (immediate) void flushAgentAutosave();
      else agentAutosaveTimer = setTimeout(() => {
        agentAutosaveTimer = null;
        void flushAgentAutosave();
      }, 250);
    }
    async function flushAgentAutosave() {
      clearTimeout(agentAutosaveTimer);
      agentAutosaveTimer = null;
      if (agentAutosaveRunning) return agentAutosaveRunning;
      if (!agentAutosavePending) return true;
      agentAutosaveRunning = (async () => {
        let latestSaved = true;
        while (agentAutosavePending) {
          const pending = agentAutosavePending;
          agentAutosavePending = null;
          const selected = state.agents.find((agent) => agentKey(agent) === pending.key);
          if (!selected) {
            latestSaved = false;
            setAgentAutosaveStatus(pending.key, "error", "保存失败");
            appendDiagnostic("agent_autosave_failed", { agent_key: pending.key, mode: pending.mode, error: "agent_not_found" });
            continue;
          }
          try {
            appendDiagnostic("agent_autosave_started", { agent_key: pending.key, mode: pending.mode, version: selected.version });
            const path = pending.mode === "default" ? "/api/agents/default" : "/api/agents/" + encodeURIComponent(selected.id);
            const saved = await api(path, { method: "PATCH", body: JSON.stringify({ ...pending.body, version: selected.version }) });
            state.agents = state.agents.map((agent) => agentKey(agent) === pending.key ? saved : agent);
            latestSaved = true;
            setAgentAutosaveStatus(pending.key, "saved", "已自动保存");
            appendDiagnostic("agent_autosave_completed", { agent_key: pending.key, mode: pending.mode, version: saved.version });
          } catch (caught) {
            latestSaved = false;
            setAgentAutosaveStatus(pending.key, "error", caught instanceof Error ? caught.message : "保存失败");
            appendDiagnostic("agent_autosave_failed", { agent_key: pending.key, mode: pending.mode, error: caught instanceof Error ? caught.message : "保存失败" });
          }
        }
        return latestSaved;
      })();
      try {
        return await agentAutosaveRunning;
      } finally {
        agentAutosaveRunning = null;
      }
    }
    async function finishAgentAutosave() {
      const form = panel?.querySelector('[data-agent-form]:not([data-agent-form="create"])');
      if (form && !form.reportValidity()) return false;
      if (form && !await flushAgentAutosave()) return false;
      return true;
    }
    async function closeAgentInspectorAfterSave() {
      if (!await finishAgentAutosave()) return;
      closeAgentInspector();
    }
    function onAgentSubmit(event) {
      if (onSkillSubmit(event)) return;
      const form = event.target.closest("[data-agent-form]");
      if (!form) return;
      event.preventDefault();
      if (AGENTS_READ_ONLY) return;
      const mode = form.dataset.agentForm;
      if (mode !== "create") {
        scheduleAgentAutosave(form, true);
        return;
      }
      const selected = state.agents.find((agent) => agentKey(agent) === form.dataset.agentKey);
      const submit = form.querySelector('[type="submit"]');
      const error = form.querySelector(".better-codex-agent-inspector-error");
      const body = { ...agentFormBody(form, selected), ...selected ? { version: selected.version } : {} };
      void perform(async () => {
        submit.disabled = true;
        error.hidden = true;
        try {
          const path = mode === "default" ? "/api/agents/default" : mode === "create" ? "/api/agents" : "/api/agents/" + encodeURIComponent(selected.id);
          const saved = await api(path, { method: mode === "create" ? "POST" : "PATCH", body: JSON.stringify(body) });
          state.agentPane = "detail";
          state.selectedAgentId = agentKey(saved);
          state.agentDraft = null;
          syncWebAgentRoute(state.selectedAgentId, "replace");
          await loadAgents();
        } catch (caught) {
          presentInlineError(error, caught, errorLabel(caught), { source: "agent_save", mode });
          submit.disabled = false;
        }
      });
    }
    function onAgentsClick(event) {
      if (event.target.closest("[data-skill-close]")) { state.agentPane = "preview"; state.selectedSkillId = ""; renderAgents(); return; }
      const skillRow = event.target.closest("[data-skill-key]");
      if (skillRow) { state.agentPane = "detail"; state.selectedSkillId = skillRow.dataset.skillKey; renderAgents(); return; }
      const skillDerive = event.target.closest("[data-skill-derive]");
      if (skillDerive) {
        const source = [...(state.skillsManaged || []), ...(state.skillsExternal || [])].find(skill => skill.id === skillDerive.dataset.skillDerive);
        if (!source) return;
        const projectId = state.skillScopeFilter?.startsWith("project:") ? state.skillScopeFilter.slice(8) : source.project_id || state.projectDetailId || state.projectId || "";
        startAgentCreate({ source_id: source.id, source_name: source.name, source_version: source.version, name: source.name, description: source.description, instructions: source.instructions, scope: "project", project_id: projectId });
        return;
      }
      const skillDelete = event.target.closest("[data-skill-delete]");
      if (skillDelete) return void confirmAction("删除 Skill", "删除后将无法再为新任务选择此 Skill。", "删除").then((confirmed) => confirmed && perform(async () => {
        const selected = state.skillsManaged?.find((skill) => skill.id === skillDelete.dataset.skillDelete);
        await api("/api/skills/" + encodeURIComponent(skillDelete.dataset.skillDelete), { method: "DELETE", body: JSON.stringify({ version: selected?.version }) });
        state.agentPane = "preview"; state.selectedSkillId = ""; await loadSkills(); renderAgents();
      }));
      if (suppressAgentOutside) return;
      if (event.target.closest("[data-agent-close-pane]")) return void closeAgentInspectorAfterSave();
      const row = event.target.closest(".better-codex-agent-directory [data-agent-key]");
      if (row) {
        const agent = state.agents.find((item) => agentKey(item) === row.dataset.agentKey);
        if (!agent) return;
        void (async () => {
          if (!await finishAgentAutosave()) return;
          state.selectedAgentId = agentKey(agent);
          state.agentPane = "detail";
          state.agentDraft = null;
          syncWebAgentRoute(state.selectedAgentId, webAgentRoute()?.agentKey ? "replace" : "push");
          renderAgents();
        })();
        return;
      }
      if (state.agentPane !== "preview" && event.target.closest(".better-codex-agent-directory")) return void closeAgentInspectorAfterSave();
      if (AGENTS_READ_ONLY) return;
      const formAvatarButton = event.target.closest("[data-agent-avatar-form]");
      if (formAvatarButton) {
        const form = formAvatarButton.closest("form");
        if (!form) return;
        if (document.getElementById("better-codex-avatar-picker")) {
          avatarPickerClose?.();
          return;
        }
        void perform(async () => {
          const anchor = formAvatarButton.closest(".better-codex-agent-avatar-field, .better-codex-agent-profile-head") || formAvatarButton;
          const avatar = await chooseAgentAvatar(form.elements.avatar?.value || "", anchor);
          if (!avatar) return;
          form.elements.avatar.value = avatar;
          const selected = state.agents.find((agent) => agentKey(agent) === form.dataset.agentKey);
          const draft = { ...selected || state.agentDraft || {}, avatar };
          if (form.dataset.agentForm === "create") state.agentDraft = draft;
          syncAgentAvatar(formAvatarButton.querySelector(".better-codex-agent-list-avatar"), draft);
          if (form.dataset.agentForm !== "create") scheduleAgentAutosave(form, true);
        });
        return;
      }
      const option = event.target.closest("[data-agent-option]");
      if (option) {
        const picker = option.closest("[data-agent-picker]");
        const form = option.closest("form");
        const name = option.dataset.agentOption;
        const value = option.dataset.agentOptionValue;
        if (!picker || !form || !name) return;
        picker.querySelector('[name="' + name + '"]').value = value;
        picker.querySelector("[data-agent-picker-label]").textContent = name === "model" ? modelLabel(value) : name === "reasoning_effort" ? effortLabel(value) : sandboxModeLabel(value);
        picker.querySelectorAll("[data-agent-option]").forEach((row2) => {
          const selected = row2.dataset.agentOptionValue === value;
          row2.classList.toggle("is-selected", selected);
          row2.setAttribute("aria-selected", String(selected));
          const check = row2.querySelector(".better-codex-agent-menu-item-check");
          if (check) check.innerHTML = selected ? icon("check") : "";
        });
        picker.classList.remove("is-open");
        picker.querySelector("[data-agent-picker-toggle]").setAttribute("aria-expanded", "false");
        if (name === "model") {
          const efforts = effortsForModel(value);
          const effortPicker = form.querySelector('[data-agent-picker="reasoning_effort"]');
          const oldEffort = form.elements.reasoning_effort.value;
          const modelDefault = state.agentModelCatalog.find((item) => item.id === value)?.defaultReasoningEffort;
          const nextEffort = efforts.some((item) => item.value === oldEffort) ? oldEffort : modelDefault || efforts[0]?.value || "medium";
          effortPicker.outerHTML = agentPicker("reasoning_effort", t("推理"), nextEffort, efforts);
          const fastInput = form.elements.fast;
          if (fastInput) {
            const enabled = modelSupportsFast(value);
            fastInput.disabled = !enabled;
            if (!enabled) fastInput.checked = false;
            fastInput.closest(".better-codex-agent-fast-setting")?.classList.toggle("is-disabled", !enabled);
          }
        }
        scheduleAgentAutosave(form, true);
        return;
      }
      const pickerToggle = event.target.closest("[data-agent-picker-toggle]");
      if (pickerToggle) {
        const picker = pickerToggle.closest("[data-agent-picker]");
        const opening = !picker.classList.contains("is-open");
        panel.querySelectorAll(".better-codex-agent-setting.is-open").forEach((item) => item.classList.remove("is-open"));
        picker.classList.toggle("is-open", opening);
        pickerToggle.setAttribute("aria-expanded", String(opening));
        return;
      }
      panel.querySelectorAll(".better-codex-agent-setting.is-open").forEach((item) => {
        item.classList.remove("is-open");
        item.querySelector("[data-agent-picker-toggle]")?.setAttribute("aria-expanded", "false");
      });
      if (event.target.closest("[data-agent-create]")) return startAgentCreate();
      const templateButton = event.target.closest("[data-agent-template]");
      if (templateButton) return startAgentCreate(suggestedAgents.find((item) => item.key === templateButton.dataset.agentTemplate) || null);
      const deleteButton = event.target.closest("[data-agent-delete]");
      if (deleteButton) {
        const agent = state.agents.find((item) => agentKey(item) === deleteButton.dataset.agentKey);
        if (!agent || agent.is_default) return;
        void (async () => {
          if (!await finishAgentAutosave()) return;
          const current = state.agents.find((item) => agentKey(item) === deleteButton.dataset.agentKey);
          if (!current) return;
          const confirmed = await confirmAction("删除智能体", "确定删除智能体 “" + agentDisplayName(current) + "” 吗？", "删除");
          if (!confirmed) return;
          await perform(async () => {
            await api("/api/agents/" + encodeURIComponent(current.id), { method: "DELETE", body: JSON.stringify({ version: current.version }) });
            state.selectedAgentId = "";
            state.agentDraft = null;
            await loadAgents({ preserveInspector: true });
            closeAgentInspector();
          });
        })();
        return;
      }
    }
    function openEditor(issue = null, initialStatus = "todo", createMode = "manual") {
      state.selected = issue;
      document.getElementById("better-codex-dialog")?.remove();
      const cachedCreateDraft = issue ? null : readCreateDraft();
      const draftMode = "manual";
      let cachedTitle = cachedCreateDraft?.title || "";
      let cachedDescription = cachedCreateDraft?.description || "";
      let cachedPrompt = cachedCreateDraft?.prompt || "";
      if (cachedCreateDraft && cachedCreateDraft.mode !== draftMode) {
        if (draftMode === "agent") {
          cachedPrompt ||= [cachedTitle, cachedDescription].filter(Boolean).join("\n\n");
        } else {
          cachedTitle ||= cachedPrompt.split(/\n/).find((line) => line.trim())?.trim().slice(0, 120) || "";
          cachedDescription ||= cachedPrompt;
        }
      }
      const draft = {
        mode: draftMode,
        title: issue?.title || cachedTitle,
        description: issue?.description || cachedDescription,
        prompt: issue?.description || cachedPrompt,
        agentId: issue?.agent_id || "",
        skillId: issue?.skill_id || "",
        assignee: issue?.user_assigned ? issueAssigneeValue(issue) : "none",
        status: issue?.status || initialStatus,
        priority: issue?.priority || "none",
        runStatus: issue?.mockup_run_status || "not-started",
        labels: (issue?.labels || []).join(", "),
        projectId: issue?.project_id || state.projectId,
        expanded: draftMode === "agent" ? false : localStorage.getItem(issue ? ISSUE_DIALOG_EXPANDED_KEY : CREATE_DIALOG_EXPANDED_KEY) === "true",
        descriptionExpanded: false,
        conversationExpanded: false,
        reply: issue?.reply_draft || "",
        promptSemanticReferences: cachedCreateDraft?.promptSemanticReferences || [],
        replySemanticReferences: [],
        promptSemanticDocument: createSemanticDraft(issue?.description || cachedPrompt, cachedCreateDraft?.promptSemanticDocument),
        replySemanticDocument: createSemanticDraft(issue?.reply_draft || ""),
        attachments: cachedCreateDraft?.attachments?.map((item) => ({ ...item, file: null, previewUrl: "" })) || [],
        replyAttachments: Array.isArray(issue?.reply_draft_attachments) ? issue.reply_draft_attachments.map((item) => ({ name: item.name, path: item.path, type: item.type || "", file: null, previewUrl: "" })) : []
      };
      const dialog = document.createElement("dialog");
      dialog.id = "better-codex-dialog";
      dialog.dataset.host = HOST_KIND;
      dialog.setAttribute(OWNED, "true");
      let projectDismiss = null;
      let selectDismiss = null;
      let conversationTimer = null;
      let retryPresentationTimer = null;
      let conversationLoadFailures = 0;
      let conversationFailureState = "";
      let conversationFailureKey = "";
      let conversationMessages = [];
      let lastReplyMessage = "";
      let lastReplySemanticReferences = [];
      let lastReplySemanticDocument = null;
      let lastReplyCommand = "";
      let lastReplyRequestId = "";
      let lastReplyStatus = issue?.reply_status || "idle";
      let queuedReplies = [];
      let queueEditingRequestId = "";
      let queueEditDraft = "";
      let queueEditSemanticDocument = null;
      let queueActionRequestId = "";
      let queueActionError = "";
      let queueEditFocusPreserved = false;
      const pendingQueueCommands = /* @__PURE__ */ new Map();
      const optimisticReplies = /* @__PURE__ */ new Map();
      let replyRecoveryRequestId = "";
      let replyRecoveryTimer = null;
      let replyDraftTimer = null;
      let latestReplyDraft = draft.reply;
      let sessionId = issueSessionId(issue);
      let enrichmentLocked = issuePermissions(issue).enrichmentPending;
      let executionRunning = issuePermissions(issue).executionRunning;
      let executionLocked = issuePermissions(issue).executionLocked;
      let sessionHandoff = issuePermissions(issue).sessionHandoff;
      let completedIssue = issuePermissions(issue).executed && !executionRunning;
      let editingLocked = issuePermissions(issue).editingLocked;
      let completedIssueUpdate = Promise.resolve();
      let replyDraftUpdate = Promise.resolve();
      let replyDraftPersistenceError = null;
      let replySubmitInFlight = false;
      let retainCreateDraft = !issue;
      let createRequestId = issue ? "" : cachedCreateDraft?.requestId || globalThis.crypto?.randomUUID?.() || VERSION + "-create-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      let submitInFlight = false;
      let mobileInputFrame = null;
      let dialogBoundsObserver = null;
      let semanticCatalog = null;
      let semanticMenuState = null;
      const semanticController = createSemanticController({
        request: (path) => api(path),
        endpoint: () => issue ? "/api/issues/" + encodeURIComponent(issue.id) + "/semantics" : "/api/projects/" + encodeURIComponent(draft.projectId) + "/semantics"
      });
      const clearIssueFullscreenBounds = () => {
        dialog.style.removeProperty("--bc-dialog-fullscreen-top");
        dialog.style.removeProperty("--bc-dialog-fullscreen-left");
        dialog.style.removeProperty("--bc-dialog-fullscreen-width");
        dialog.style.removeProperty("--bc-dialog-fullscreen-height");
      };
      const syncIssueFullscreenBounds = () => {
        const compact = HOST_KIND === "web" && window.matchMedia("(max-width: 720px)").matches;
        if (!issue || !draft.expanded || compact || !panel?.isConnected) {
          clearIssueFullscreenBounds();
          return;
        }
        const bounds = panel.getBoundingClientRect();
        dialog.style.setProperty("--bc-dialog-fullscreen-top", bounds.top + "px");
        dialog.style.setProperty("--bc-dialog-fullscreen-left", bounds.left + "px");
        dialog.style.setProperty("--bc-dialog-fullscreen-width", bounds.width + "px");
        dialog.style.setProperty("--bc-dialog-fullscreen-height", bounds.height + "px");
      };
      const mobileDialogViewport = () => {
        if (mobileInputFrame !== null) {
          cancelAnimationFrame(mobileInputFrame);
          mobileInputFrame = null;
        }
        const compact = HOST_KIND === "web" && window.matchMedia("(max-width: 720px)").matches;
        if (!compact) {
          dialog.style.removeProperty("--bc-mobile-viewport-top");
          dialog.style.removeProperty("--bc-mobile-viewport-height");
          dialog.style.removeProperty("--bc-mobile-viewport-bottom");
          dialog.style.removeProperty("--bc-mobile-layout-height");
          dialog.style.removeProperty("--bc-mobile-keyboard-translation");
          syncIssueFullscreenBounds();
          return;
        }
        const viewport = window.visualViewport;
        const viewportHeight = viewport?.height || window.innerHeight;
        const active2 = document.activeElement;
        const viewportTop = viewport?.offsetTop || 0;
        dialog.style.setProperty("--bc-mobile-viewport-top", viewportTop + "px");
        dialog.style.setProperty("--bc-mobile-viewport-height", viewportHeight + "px");
        dialog.style.setProperty("--bc-mobile-viewport-bottom", Math.max(0, window.innerHeight - viewportTop - viewportHeight) + "px");
        dialog.style.removeProperty("--bc-mobile-layout-height");
        dialog.style.removeProperty("--bc-mobile-keyboard-translation");
        mobileInputFrame = requestAnimationFrame(() => {
          mobileInputFrame = null;
          if (!(active2 instanceof HTMLElement) || !dialog.contains(active2) || !active2.matches("input, textarea, [contenteditable='true']")) return;
          if (issue) return;
          (active2.closest(".better-codex-composer") || active2).scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      };
      const dirtyDraftFields = /* @__PURE__ */ new Set();
      const dialogKind = () => issue ? "issue" : draft.mode === "agent" ? "create_agent" : "create_manual";
      const traceDialog = (event, fields = {}) => traceRendererDiagnostic(event, {
        dialog_kind: dialogKind(),
        issue_id: issue?.id || "",
        issue_identifier: issue?.identifier || "",
        ...fields
      });
      function stopConversationPoll() {
        if (conversationTimer !== null) {
          clearTimeout(conversationTimer);
          conversationTimer = null;
        }
      }
      function stopReplyRecovery() {
        if (replyRecoveryTimer !== null) {
          clearTimeout(replyRecoveryTimer);
          replyRecoveryTimer = null;
        }
        replyRecoveryRequestId = "";
      }
      function completeReplySubmission(submittedText, submittedAttachments = [], options = {}) {
        const textarea = dialog.querySelector('[name="reply"]');
        const currentText = String(textarea?.value || "").trim();
        const composerUnchanged = !textarea || currentText === submittedText;
        const composerAlreadyCleared = currentText === "" && draft.reply === "";
        if (composerUnchanged) {
          if (textarea) textarea.value = "";
          draft.reply = "";
          latestReplyDraft = "";
          draft.replySemanticReferences = [];
          draft.replySemanticDocument = createSemanticDraft("");
          closeSemanticMenu();
        }
        const submittedAttachmentSet = new Set(submittedAttachments);
        draft.replyAttachments = draft.replyAttachments.filter((item) => {
          if (!submittedAttachmentSet.has(item)) return true;
          releaseAttachment(item);
          return false;
        });
        if (replyDraftTimer !== null) {
          clearTimeout(replyDraftTimer);
          replyDraftTimer = null;
        }
        if (!composerUnchanged || options.persistDraftClear === true) persistReplyDraft(draft.reply, draft.replyAttachments);
        const attachments = dialog.querySelector("[data-reply-attachments]");
        if (attachments) attachments.outerHTML = attachmentList(draft.replyAttachments, "reply");
        updateReplySendState();
        return composerUnchanged || composerAlreadyCleared;
      }
      function recomputeIssuePermissions() {
        const permissions = issuePermissions(issue);
        enrichmentLocked = permissions.enrichmentPending;
        executionRunning = permissions.executionRunning;
        executionLocked = permissions.executionLocked;
        sessionHandoff = permissions.sessionHandoff;
        completedIssue = permissions.executed && !executionRunning;
        editingLocked = permissions.editingLocked;
      }
      function acceptReplySubmission(requestId, message) {
        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
        const patch = { status: "in_progress", reply_status: "running", needs_attention: false, pending_actor: "agent", updated_at: timestamp };
        pendingIssueReplies.set(issue.id, {
          requestId,
          patch,
          previous: {
            status: issue.status,
            reply_status: issue.reply_status,
            needs_attention: issue.needs_attention,
            pending_actor: issue.pending_actor,
            updated_at: issue.updated_at
          }
        });
        Object.assign(issue, patch);
        recomputeIssuePermissions();
        state.selected = issue;
        const issueIndex = state.issues.findIndex((candidate) => candidate.id === issue.id);
        if (issueIndex >= 0) state.issues[issueIndex] = issue;
        optimisticReplies.set(requestId, { role: "user", markdown: message, timestamp, optimistic_request_id: requestId, accepted_at_ms: Date.now() });
        syncOptimisticReplies();
        syncConversationStatus("running");
        render();
      }
      function settlePendingIssueReply(requestId, rollback = false) {
        const pending = pendingIssueReplies.get(issue.id);
        if (!pending || pending.requestId !== requestId) return;
        pendingIssueReplies.delete(issue.id);
        if (!rollback) return;
        Object.assign(issue, pending.previous);
        recomputeIssuePermissions();
        state.selected = issue;
        const issueIndex = state.issues.findIndex((candidate) => candidate.id === issue.id);
        if (issueIndex >= 0) state.issues[issueIndex] = issue;
        render();
      }
      function recoverReply(requestId, message, submittedText, submittedAttachments, attempts = 0) {
        if (!issue || !sessionId || !dialog.isConnected || requestId !== replyRecoveryRequestId) return;
        if (attempts >= 5) {
          traceDialog("reply_recovery_unconfirmed", { request_id: requestId, attempts });
          stopReplyRecovery();
          showConversationFailure("reply_request_unconfirmed", "reply", message);
          return;
        }
        replyRecoveryTimer = setTimeout(async () => {
          replyRecoveryTimer = null;
          if (requestId !== replyRecoveryRequestId) return;
          try {
            const data = await api("/api/issues/" + encodeURIComponent(issue.id) + "/conversation");
            const reply = data?.reply || {};
            if (reply.request_id === requestId) {
              stopReplyRecovery();
              const composerCleared = completeReplySubmission(submittedText, submittedAttachments);
              traceDialog("reply_recovery_confirmed", { request_id: requestId, reply_status: reply.status || "idle", composer_cleared: composerCleared });
              applyConversation(data, { preserveBody: true });
              return;
            }
          } catch (error) {
            traceDialog("reply_recovery_probe_failed", { request_id: requestId, attempt: attempts + 1, error: String(error instanceof Error ? error.message : "request_failed").slice(0, 200) });
          }
          recoverReply(requestId, message, submittedText, submittedAttachments, attempts + 1);
        }, attempts === 0 ? 1500 : 2e3);
      }
      function scheduleReplyRecovery(requestId, message, submittedText, submittedAttachments) {
        stopReplyRecovery();
        replyRecoveryRequestId = requestId;
        recoverReply(requestId, message, submittedText, submittedAttachments);
      }
      function syncDraft() {
        const form = dialog.querySelector("form");
        if (!form) return;
        const value = (name) => form.querySelector('[name="' + name + '"]')?.value;
        if (value("assignee") !== void 0) draft.assignee = String(value("assignee"));
        if (value("skill_id") !== void 0) draft.skillId = String(value("skill_id"));
        if (draft.mode === "manual") {
          if (value("title") !== void 0) draft.title = String(value("title"));
          if (value("description") !== void 0) draft.description = String(value("description"));
          if (value("status") !== void 0) draft.status = String(value("status"));
          if (value("priority") !== void 0) draft.priority = String(value("priority"));
          if (value("mockup_run_status") !== void 0) draft.runStatus = String(value("mockup_run_status"));
          if (value("labels") !== void 0) draft.labels = String(value("labels"));
          if (value("reply") !== void 0) draft.reply = String(value("reply"));
        } else {
          if (value("prompt") !== void 0) draft.prompt = String(value("prompt"));
        }
      }
      function syncDraftFromIssue() {
        if (!issue) return;
        if (!dirtyDraftFields.has("title")) draft.title = issue.title || "";
        if (!dirtyDraftFields.has("description")) draft.description = issue.description || "";
        if (!dirtyDraftFields.has("status")) draft.status = issue.status || "todo";
        if (!dirtyDraftFields.has("priority")) draft.priority = issue.priority || "none";
        if (!dirtyDraftFields.has("labels")) draft.labels = (issue.labels || []).join(", ");
        if (!dirtyDraftFields.has("assignee")) draft.assignee = issue?.user_assigned ? issueAssigneeValue(issue) : "none";
        if (!dirtyDraftFields.has("project_id")) draft.projectId = issue.project_id || draft.projectId;
        if (!dirtyDraftFields.has("agent_id")) draft.agentId = issue.agent_id || "";
      }
      function persistCompletedIssuePatch(patch) {
        if (!issue) return;
        completedIssueUpdate = completedIssueUpdate.catch(() => {
        }).then(async () => {
          if (!completedIssue || executionRunning) return;
          let current = issue;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const updated = await api("/api/issues/" + encodeURIComponent(issue.id), { method: "PATCH", body: JSON.stringify({ version: current.version, ...patch }) });
              refreshIssueState(updated);
              await loadIssues();
              return;
            } catch (error) {
              if (attempt === 1 || !(error instanceof Error) || error.message !== "version_conflict") {
                showError(error);
                return;
              }
              current = await api("/api/issues/" + encodeURIComponent(issue.id));
              refreshIssueState(current);
            }
          }
        });
      }
      function replyDraftAttachmentPayload(items = draft.replyAttachments) {
        return items.filter((item) => item.path).map((item) => ({ name: item.name, path: item.path, type: item.type || item.file?.type || "" }));
      }
      function persistReplyDraft(value, items = draft.replyAttachments) {
        if (!issue || REMOTE && !RELAY) return;
        replyDraftUpdate = replyDraftUpdate.catch(() => {
        }).then(async () => {
          replyDraftPersistenceError = null;
          try {
            if (RELAY) await cacheRemoteAttachments(items);
            else await uploadPastedImages(items);
          } catch (error) {
            showError(error);
            throw error;
          }
          const attachments = replyDraftAttachmentPayload(items);
          let current = issue;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const body = { version: current.version, reply_draft: value, reply_draft_attachments: attachments };
              const updated = await api("/api/issues/" + encodeURIComponent(issue.id), { method: "PATCH", body: JSON.stringify(body) });
              if (updated?.queued === true) {
                watchQueuedCommand(updated.command_id, {
                  applied: (payload) => {
                    if (payload?.id && dialog.isConnected) refreshIssueState(payload);
                  },
                  failed: (error) => {
                    reportUnexpectedError(error, { source: "reply_draft_queue", issue_id: issue.id, command_id: updated.command_id });
                    if (dialog.isConnected) showError(error);
                  }
                });
                return;
              }
              refreshIssueState(updated);
              return;
            } catch (error) {
              if (attempt === 1 || !(error instanceof Error) || error.message !== "version_conflict") {
                replyDraftPersistenceError = error;
                showError(error);
                return;
              }
              current = await api("/api/issues/" + encodeURIComponent(issue.id));
              refreshIssueState(current);
            }
          }
        });
      }
      function scheduleReplyDraft(value) {
        latestReplyDraft = value;
        if (replyDraftTimer !== null) clearTimeout(replyDraftTimer);
        replyDraftTimer = setTimeout(() => {
          replyDraftTimer = null;
          persistReplyDraft(value);
        }, 300);
      }
      function flushReplyDraft() {
        if (replyDraftTimer !== null) {
          clearTimeout(replyDraftTimer);
          replyDraftTimer = null;
          persistReplyDraft(latestReplyDraft);
        }
        return replyDraftUpdate;
      }
      function updateSubmitState() {
        const submit = dialog.querySelector(".better-codex-submit");
        const startNow = dialog.querySelector("[data-dialog-start-now]");
        const content = dialog.querySelector(draft.mode === "agent" ? '[name="prompt"]' : '[name="title"]');
        const disabled = !String(content?.value || "").trim();
        const draftAgentDisabled = dirtyDraftFields.has("assignee") && (draft.assignee === "none" || draft.assignee.startsWith("user:"));
        const startBlocked = !issue || Boolean(issue.archived_at) || !issue.agent_enabled || draftAgentDisabled || Boolean(issue.active_run_status) || Boolean(sessionId) || issuePermissions(issue).enrichmentPending || issue.status === "done";
        if (submit) submit.disabled = editingLocked || disabled;
        if (startNow) startNow.disabled = editingLocked || disabled || startBlocked;
      }
      function updateReplySendState(replyStatus = issue?.reply_status || "idle") {
        const send = dialog.querySelector("[data-conversation-send]");
        const reply = dialog.querySelector('[name="reply"]');
        if (!send) return;
        const composer = send.closest(".better-codex-composer");
        if (replySubmitInFlight) {
          if (composer) composer.dataset.state = "submitting";
          send.dataset.composerMode = "submitting";
          send.setAttribute("aria-label", t("正在发送…"));
          send.setAttribute("aria-busy", "true");
          send.title = t("正在发送…");
          send.innerHTML = replySubmitLoadingIcon();
          send.disabled = true;
          return;
        }
        send.removeAttribute("aria-busy");
        const stopping = issue?.session_status === "stopping";
        const archived = Boolean(issue?.archived_at);
        const working = stopping || executionRunning || enrichmentLocked || replyStatus === "running";
        const hasContent = Boolean(String(reply?.value || "").trim() || draft.replyAttachments.length);
        const mode = stopping ? "stopping" : working && !hasContent ? "stop" : working ? "queue" : "send";
        if (reply) reply.disabled = archived;
        if (composer) composer.dataset.state = mode;
        send.dataset.composerMode = mode;
        const actionLabel = t(stopping ? "正在停止…" : mode === "stop" ? "停止任务" : mode === "queue" ? "加入队列" : "发送");
        send.setAttribute("aria-label", actionLabel);
        send.title = actionLabel;
        send.innerHTML = icon(mode === "stop" || mode === "stopping" ? "stop" : "send", "", mode === "stop" || mode === "stopping" ? "2.5" : "2");
        send.disabled = stopping || archived || mode !== "stop" && !hasContent;
        const attach = dialog.querySelector("[data-conversation-attach]");
        if (attach) attach.disabled = archived;
      }
      function setReplySubmitLoading(loading) {
        replySubmitInFlight = loading;
        updateReplySendState();
      }
      function replySubmitLoadingIcon() {
        return icon("refresh").replace("<svg ", '<svg data-bc-spin="true" ');
      }
      function applyDialogPermissions() {
        if (!dialog.isConnected) return;
        dialog.dataset.executionRunning = String(executionRunning);
        dialog.dataset.executionLocked = String(executionLocked);
        dialog.dataset.locked = String(editingLocked);
        dialog.querySelectorAll("input, textarea, select, button").forEach((control) => {
          if (control.matches('[data-semantic-option][aria-disabled="true"]')) {
            control.disabled = true;
            return;
          }
          if (control.matches("[data-dialog-close], [data-dialog-expand], [data-conversation-expand], [data-dialog-open-thread], [data-dialog-open-native], [data-dialog-stop], [data-dialog-restore], [data-description-toggle], [data-conversation-copy], [data-conversation-attachment], [data-dialog-preview]")) {
            control.disabled = false;
            return;
          }
          if (issue?.archived_at) {
            control.disabled = true;
            return;
          }
          if (enrichmentLocked) {
            control.disabled = true;
            return;
          }
          if (executionRunning) {
            control.disabled = !control.matches('[name="reply"], [data-conversation-send], [data-conversation-attach], [data-conversation-retry], [data-dialog-attachment-scope="reply"], [data-queue-edit-input], [data-queue-send-now], [data-queue-edit], [data-queue-delete], [data-queue-edit-save], [data-queue-edit-cancel], [data-semantic-option]');
            return;
          }
          if (executionLocked) {
            control.disabled = !(control.matches('[name="reply"], [data-conversation-send], [data-conversation-attach], [data-conversation-retry], [data-dialog-attachment-scope="reply"], [data-semantic-option]') || control.closest('[data-dialog-select="status"], [data-dialog-select="priority"], [data-dialog-select="assignee"]'));
            return;
          }
          control.disabled = false;
        });
        updateSubmitState();
        updateReplySendState();
      }
      function refreshIssueState(next) {
        if (!issue || !next) return;
        const previousSessionId = sessionId;
        const previousEnrichmentLocked = enrichmentLocked;
        const previousExecutionRunning = executionRunning;
        const previousSessionHandoff = sessionHandoff;
        const previousArchivedAt = issue.archived_at;
        const previousTitle = issue.title;
        const previousDescription = issue.description;
        const previousStatus = issue.status;
        const previousPriority = issue.priority;
        const previousLabels = JSON.stringify(issue.labels || []);
        const previousAssignee = [issue.agent_enabled, issue.agent_id || "", issue.user_assigned, issue.assignee_user_id || ""].join(":");
        const previousProjectId = issue.project_id;
        const previousRetry = JSON.stringify(issue.session_retry || null);
        Object.assign(issue, next);
        const permissions = issuePermissions(issue);
        sessionId = issueSessionId(issue);
        enrichmentLocked = permissions.enrichmentPending;
        executionRunning = permissions.executionRunning;
        executionLocked = permissions.executionLocked;
        sessionHandoff = permissions.sessionHandoff;
        completedIssue = permissions.executed && !executionRunning;
        editingLocked = permissions.editingLocked;
        state.selected = issue;
        const issueIndex = state.issues.findIndex((candidate) => candidate.id === issue.id);
        if (issueIndex >= 0) state.issues[issueIndex] = issue;
        if (!dialog.isConnected) return;
        const footerPresent = Boolean(dialog.querySelector(".better-codex-dialog-footer"));
        const draftSourceChanged = previousTitle !== issue.title || previousDescription !== issue.description || previousStatus !== issue.status || previousPriority !== issue.priority || previousLabels !== JSON.stringify(issue.labels || []) || previousAssignee !== [issue.agent_enabled, issue.agent_id || "", issue.user_assigned, issue.assignee_user_id || ""].join(":") || previousProjectId !== issue.project_id;
        if (previousSessionId !== sessionId || previousEnrichmentLocked !== enrichmentLocked || previousExecutionRunning !== executionRunning || previousSessionHandoff !== sessionHandoff || previousArchivedAt !== issue.archived_at || previousRetry !== JSON.stringify(issue.session_retry || null) || footerPresent !== !executionLocked || draftSourceChanged) {
          syncDraft();
          syncDraftFromIssue();
          renderDialog();
          return;
        }
        syncDraftFromIssue();
        applyDialogPermissions();
        syncQueuedReplyState();
        syncConversationStatus(issue.reply_status || "idle");
      }
      async function reconcileIssueConflict(error) {
        if (!issue || !contentConflict(error)) return { error, reconciled: false };
        const correlation = contentConflictCorrelation(error);
        appendDiagnostic("content_conflict_sync_started", { surface: "issue_dialog", issue_id: issue.id, ...correlation });
        try {
          await loadLatestIssue(issue.id);
          appendDiagnostic("content_conflict_sync_completed", { surface: "issue_dialog", issue_id: issue.id, ...correlation });
          return { error, reconciled: true };
        } catch (syncError) {
          appendDiagnostic("content_conflict_sync_failed", { surface: "issue_dialog", issue_id: issue.id, ...correlation, error: syncError instanceof Error ? syncError.message : String(syncError || "request_failed") });
          return { error: syncError, reconciled: false };
        }
      }
      function header() {
        const breadcrumbProject = state.projects.find((item) => item.id === draft.projectId);
        const openThreadButton = issue && !enrichmentLocked && HOST_CAPABILITIES.nativeThreads !== false ? '<button class="better-codex-dialog-open-thread" type="button" data-dialog-open-native="' + escapeHtml2(issue.id) + '" aria-label="' + te("打开会话") + '">' + icon("docs") + "<span>" + te("打开会话") + "</span></button>" : "";
        const startNowButton = issue && !issue.archived_at ? '<button class="better-codex-dialog-start-now" type="button" data-dialog-new-native aria-label="' + te("新建会话") + '">' + icon("plus") + "<span>" + te("新建会话") + "</span></button>" : "";
        const restoreButton = issue?.archived_at ? '<button class="better-codex-dialog-start-now better-codex-dialog-restore" type="button" data-dialog-restore aria-label="' + te("取消归档") + '">' + icon("archive") + "<span>" + te("取消归档") + "</span></button>" : "";
        const title = issue ? escapeHtml2(issue.identifier) : t("新建工作项");
        const crumb = issue ? '<span class="better-codex-dialog-route-root">' + te("任务看板") + '</span><span class="better-codex-dialog-route-root-separator" aria-hidden="true">' + icon("chevron") + "</span><span data-dialog-breadcrumb-project>" + escapeHtml2(projectLabel(breadcrumbProject) || t("未提供")) + '</span><span aria-hidden="true">' + icon("chevron") + "</span><strong>" + title + "</strong>" : "<strong>" + title + "</strong>";
        const expandButton = draft.mode === "agent" ? "" : '<button class="better-codex-icon-button" type="button" data-dialog-expand aria-label="' + te(draft.expanded ? issue ? "退出全屏" : "缩小" : "展开") + '">' + icon(draft.expanded ? "shrink" : "expand") + "</button>";
        return '<div class="better-codex-dialog-head"><div class="better-codex-dialog-head-leading"><nav class="better-codex-dialog-breadcrumb" aria-label="' + te("任务看板") + '">' + crumb + '</nav></div><div class="better-codex-dialog-head-actions">' + restoreButton + openThreadButton + startNowButton + expandButton + '<button class="better-codex-icon-button" type="button" data-dialog-close aria-label="' + te("关闭") + '">' + icon("close") + "</button></div></div>";
      }
      function issueConversationFailed(candidate = issue) {
        return candidate?.latest_run_status === "failed" || candidate?.latest_scheduler_status === "failed" || candidate?.session_status === "failed" || candidate?.reply_status === "failed";
      }
      function conversationPanel() { return ""; }
      function sessionRetryBannerMarkup() {
        if (!issue?.session_retry) return "";
        const detail = sessionRetryDetail(issue.session_retry);
        const openThreadButton = sessionId && HOST_CAPABILITIES.nativeThreads !== false ? '<button type="button" data-dialog-open-thread="' + escapeHtml2(sessionId) + '">' + te("打开完整会话") + "</button>" : "";
        return '<div class="better-codex-session-retry" data-session-retry role="status"><span class="better-codex-session-retry-icon" aria-hidden="true">' + icon("refresh", "better-codex-spin") + "</span><div><strong>" + escapeHtml2(state.locale === "zh-CN" ? "模型连接正在恢复" : "Reconnecting to the model") + "</strong><span data-session-retry-detail>" + escapeHtml2(detail) + '</span></div><div class="better-codex-session-retry-actions">' + openThreadButton + '<button type="button" data-dialog-stop>' + te("停止等待") + "</button></div></div>";
      }
      function conversationStatusMarkup(replyStatus) {
        const enrichmentLocked2 = issuePermissions(issue).enrichmentPending;
        const latestRunStatus = issue?.latest_run_status || "";
        const executionState = workflowActivityState(issue, issue?.status === "done" ? "completed" : issue?.status === "cancelled" ? "interrupted" : issue?.status === "blocked" ? "blocked" : issue?.latest_scheduler_status === "failed" && issue?.status === "in_review" ? "scheduler-failed" : latestRunStatus === "completed" ? "completed" : latestRunStatus === "failed" ? "failed" : latestRunStatus === "interrupted" ? "interrupted" : latestRunStatus === "scheduling" ? "scheduling" : latestRunStatus === "running" ? "running" : latestRunStatus === "claimed" ? "claimed" : issue?.agent_enabled ? "not-started" : "");
        const sessionExecutionState = issue?.session_status === "stopping" ? "stopping" : issue?.session_status === "starting" ? "claimed" : ["active", "waiting_on_approval", "waiting_on_user"].includes(issue?.session_status) ? "running" : "";
        const activeExecutionState = issue?.active_run_status || (replyStatus === "running" ? "running" : sessionExecutionState);
        const replyResultState = replyStatus === "succeeded" ? issue?.workflow ? "" : "completed" : ["failed", "interrupted"].includes(replyStatus) ? replyStatus : conversationFailureState;
        const relayFailure = issue?.session_relay_error && !issue?.session_relay_connected && issue?.active_run_status === "claimed";
        const activityState = enrichmentLocked2 ? "thinking" : issue?.session_status === "stopping" ? "stopping" : issue?.session_retry ? "retrying" : relayFailure ? "relay-failed" : activeExecutionState || (issue?.enrichment_status === "failed" ? "title-regeneration-failed" : replyResultState || executionState);
        if (!activityState) return "";
        const activityLabel = activityState === "retrying" ? sessionRetryCardLabel(issue.session_retry) : t(issue?.enrichment_status === "regenerating" ? "标题生成中" : activityState === "title-regeneration-failed" ? "标题生成失败" : activityState === "stopping" ? "正在停止…" : activityState === "relay-failed" ? "Codex 会话连接失败" : activityState === "running" ? "工作中" : activityState === "scheduling" ? "调度中" : activityState === "scheduler-failed" ? "调度失败" : activityState === "claimed" ? "排队中" : activityState === "in_progress" ? "进行中" : activityState === "in_review" ? "待审核" : activityState === "completed" ? "已完成" : activityState === "blocked" ? "已阻塞" : activityState === "failed" ? "执行失败" : activityState === "interrupted" ? "已停止" : activityState === "not-started" ? "未开始" : "");
        const agent = state.agents.find((item) => item.id === issue?.agent_id) || state.agents.find((item) => item.is_default) || { name: "Codex", is_default: true };
        const activityIcon = activityState === "scheduling" ? '<span class="better-codex-activity-dot better-codex-scheduler-dot" aria-hidden="true"></span>' : activityState === "scheduler-failed" ? '<span class="better-codex-activity-dot better-codex-scheduler-failed-dot" aria-hidden="true"></span>' : ["completed", "interrupted", "not-started"].includes(activityState) ? '<span class="better-codex-activity-dot" aria-hidden="true"></span>' : activityState === "retrying" ? '<span class="better-codex-activity-dot" aria-hidden="true"></span>' : ["failed", "blocked", "relay-failed"].includes(activityState) ? icon("close") : agentAvatarMarkup(agent, "better-codex-bubble-avatar better-codex-conversation-status-avatar");
        return '<span class="better-codex-activity" data-run="' + activityState + '">' + activityIcon + '<span class="' + ((enrichmentLocked2 || issueExecutionRunning(issue)) && activityState !== "retrying" ? "better-codex-shimmer" : "") + '">' + escapeHtml2(activityLabel) + "</span></span>";
      }
      function syncConversationStatus(replyStatus) {
        const status = dialog.querySelector("[data-conversation-status]");
        if (!status) return;
        status.dataset.state = replyStatus;
        status.innerHTML = conversationStatusMarkup(replyStatus);
        status.hidden = !status.innerHTML;
      }
      function syncRetryPresentation() {
        syncConversationStatus(issue?.reply_status || "idle");
        const detail = dialog.querySelector("[data-session-retry-detail]");
        if (detail && issue?.session_retry) detail.textContent = sessionRetryDetail(issue.session_retry);
      }
      function semanticToken(input) {
        const cursor = Number(input?.selectionStart);
        if (!input || !Number.isInteger(cursor)) return null;
        const before = input.value.slice(0, cursor);
        const match = before.match(/(^|\s)([/@$])([^\s]*)$/);
        if (!match) return null;
        return { trigger: match[2], query: match[3], start: cursor - match[2].length - match[3].length, end: cursor };
      }
      function semanticCommands() {
        const zh = state.locale === "zh-CN";
        const sessionCommandAvailable = Boolean(issue && sessionId && !executionRunning);
        const initialReviewAvailable = Boolean(!issue && draft.mode === "agent");
        const desktopCommandAvailable = sessionCommandAvailable && HOST_KIND !== "web";
        const sessionRequired = zh ? "需已有会话" : "Existing chat required";
        const desktopSessionRequired = zh ? "需桌面已有会话" : "Existing desktop chat required";
        return [
          { kind: "command", name: "status", label: "/status", description: zh ? "查看当前会话与智能体状态" : "Show the current session and agent status", icon: "usage", available: true, scope: zh ? "可用" : "Available" },
          { kind: "command", name: "skills", label: "/skills", description: zh ? "浏览并调用已启用的 Codex Skills" : "Browse and invoke enabled Codex Skills", icon: "wrench", available: true, scope: "$" },
          { kind: "command", name: "apps", label: "/apps", description: zh ? "浏览并调用已安装的插件与连接器" : "Browse and invoke installed plugins and connectors", icon: "server", available: true, scope: "@" },
          { kind: "command", name: "review", label: "/review", description: zh ? "审查工作区中的未提交改动" : "Review uncommitted workspace changes", icon: "review", available: initialReviewAvailable || sessionCommandAvailable, scope: initialReviewAvailable || sessionCommandAvailable ? zh ? "可用" : "Available" : sessionRequired },
          { kind: "command", name: "compact", label: "/compact", description: zh ? "压缩当前会话上下文" : "Compact the current conversation context", icon: "sparkles", available: sessionCommandAvailable, scope: sessionCommandAvailable ? zh ? "可用" : "Available" : sessionRequired },
          ...[
            ["approve", zh ? "批准最近一次自动审查拒绝的重试" : "Approve one retry after an automatic-review denial"],
            ["cloud", zh ? "在云端运行当前会话" : "Run the current chat in the cloud"],
            ["cloud-environment", zh ? "选择云端环境" : "Choose the cloud environment"],
            ["fast", zh ? "切换 Fast 服务层级" : "Toggle the Fast service tier"],
            ["feedback", zh ? "提交反馈：/feedback 反馈内容" : "Submit feedback: /feedback message"],
            ["fork", zh ? "复制为新的本地会话或工作树" : "Copy into a new local chat or worktree"],
            ["goal", zh ? "查看或设置持久目标：/goal [目标|clear]" : "Get or set a goal: /goal [objective|clear]"],
            ["ide-context", zh ? "切换 IDE 上下文共享" : "Toggle shared IDE context"],
            ["init", zh ? "生成 AGENTS.md 初始文件" : "Generate an AGENTS.md scaffold"],
            ["local", zh ? "在本地项目中运行会话" : "Run the chat in a local project"],
            ["mcp", zh ? "查看 MCP 服务器状态" : "View MCP server status"],
            ["memories", zh ? "配置会话记忆：/memories on|off" : "Configure memories: /memories on|off"],
            ["model", zh ? "选择当前会话模型：/model 模型名" : "Choose model: /model model-name"],
            ["pet", zh ? "唤醒或收起桌面宠物" : "Wake or tuck away the desktop pet"],
            ["personality", zh ? "响应风格：/personality friendly|pragmatic|none" : "Personality: friendly|pragmatic|none"],
            ["plan", zh ? "切换规划模式" : "Toggle plan mode"],
            ["project", zh ? "设置原生项目：/project 项目ID" : "Set native project: /project project-id"],
            ["reasoning", zh ? "推理强度：/reasoning high" : "Reasoning effort: /reasoning high"],
            ["side", zh ? "开始临时侧边会话" : "Start a temporary side chat"],
            ["task", zh ? "开始不关联项目的会话" : "Start a chat without a project"],
            ["worktree", zh ? "在新 Git 工作树中运行" : "Run in a new Git worktree"]
          ].map(([name, description]) => {
            const desktop = DESKTOP_NATIVE_COMMANDS.includes(name);
            const available = desktop ? desktopCommandAvailable : sessionCommandAvailable;
            return { kind: "command", name, label: "/" + name, description, icon: "terminal", available, scope: available ? desktop ? zh ? "桌面" : "Desktop" : zh ? "可用" : "Available" : desktop ? desktopSessionRequired : sessionRequired };
          })
        ];
      }
      function semanticStatusMarkup() {
        const agent = issue ? state.agents.find((item) => item.id === issue.agent_id) : state.agents.find((item) => item.is_default ? draft.assignee === "codex" : item.id === draft.assignee);
        const zh = state.locale === "zh-CN";
        const rows = [
          [zh ? "会话" : "Session", issue?.session_status || (zh ? "待创建" : "New")],
          [zh ? "智能体" : "Agent", agent?.name || "Codex"],
          [zh ? "模型" : "Model", agent?.model || (zh ? "默认模型" : "Default model")],
          [zh ? "推理" : "Reasoning", agent?.reasoning_effort || (zh ? "默认" : "Default")]
        ];
        return '<div class="better-codex-semantic-status"><div class="better-codex-semantic-status-title">' + icon("usage") + "<span>" + te(zh ? "当前会话" : "Current session") + "</span></div>" + rows.map((row) => "<div><span>" + escapeHtml2(row[0]) + "</span><strong>" + escapeHtml2(row[1]) + "</strong></div>").join("") + "</div>";
      }
      function semanticNativeResultMarkup(command, result) {
        const zh = state.locale === "zh-CN";
        const servers = command === "mcp" && Array.isArray(result?.servers) ? result.servers.slice(0, 30) : [];
        const values = Object.entries(result || {}).filter(([key, value]) => !["thread_id", "source_thread_id", "command", "response", "servers"].includes(key) && value !== void 0).slice(0, 12);
        const rows = servers.length ? servers.map((server) => [String(server.name || "MCP"), [server.auth_status, String(server.tool_count || 0) + (zh ? " 个工具" : " tools")].filter(Boolean).join(" · ")]) : values.length ? values.map(([key, value]) => [key.replaceAll("_", " "), typeof value === "object" ? JSON.stringify(value) : String(value)]) : [[zh ? "状态" : "Status", zh ? "已完成" : "Completed"]];
        return '<div class="better-codex-semantic-status"><div class="better-codex-semantic-status-title">' + icon("check") + "<span>" + escapeHtml2("/" + command) + "</span></div>" + rows.map((row) => "<div><span>" + escapeHtml2(row[0]) + "</span><strong>" + escapeHtml2(row[1]) + "</strong></div>").join("") + "</div>";
      }
      function semanticEditor() {
        return dialog.querySelector(!issue && draft.mode === "agent" ? '[name="prompt"]' : '[name="reply"]');
      }
      function semanticDraftReferences() {
        return !issue && draft.mode === "agent" ? draft.promptSemanticReferences : draft.replySemanticReferences;
      }
      function setSemanticDraftReferences(references) {
        if (!issue && draft.mode === "agent") draft.promptSemanticReferences = references;
        else draft.replySemanticReferences = references;
      }
      function semanticDraftDocument() {
        return !issue && draft.mode === "agent" ? draft.promptSemanticDocument : draft.replySemanticDocument;
      }
      function setSemanticDraftDocument(document2) {
        if (!issue && draft.mode === "agent") draft.promptSemanticDocument = document2;
        else draft.replySemanticDocument = document2;
      }
      function semanticWarningText() {
        return state.locale === "zh-CN" ? "引用已变成普通文本，请重新选择" : "The reference became plain text. Select it again.";
      }
      function semanticWarningMarkup(document2) {
        return '<div class="better-codex-semantic-warning" data-semantic-warning role="status"' + (document2?.degraded ? "" : " hidden") + ">" + icon("permissionDanger") + "<span>" + escapeHtml2(semanticWarningText()) + "</span></div>";
      }
      function syncSemanticWarning() {
        const warning = dialog.querySelector("[data-semantic-warning]");
        if (warning) warning.hidden = !semanticDraftDocument()?.degraded;
      }
      function renderSemanticMenu() {
        const menu = dialog.querySelector("[data-semantic-menu]");
        const input = semanticEditor();
        if (!menu || !input) return;
        if (!semanticMenuState) {
          menu.hidden = true;
          menu.innerHTML = "";
          input.setAttribute("aria-expanded", "false");
          return;
        }
        if (semanticMenuState.status) {
          menu.innerHTML = semanticStatusMarkup();
          menu.hidden = false;
          input.setAttribute("aria-expanded", "true");
          return;
        }
        if (semanticMenuState.nativeResult) {
          menu.innerHTML = semanticNativeResultMarkup(semanticMenuState.nativeResult.command, semanticMenuState.nativeResult.result);
          menu.hidden = false;
          input.setAttribute("aria-expanded", "true");
          return;
        }
        const items = semanticMenuState.items || [];
        if (semanticMenuState.loading && !items.length) {
          menu.innerHTML = '<div class="better-codex-semantic-empty">' + icon("refresh", "better-codex-spin") + "<span>" + te(state.locale === "zh-CN" ? "正在读取 Codex 语义…" : "Loading Codex semantics…") + "</span></div>";
        } else if (semanticMenuState.error && !items.length) {
          menu.innerHTML = '<div class="better-codex-semantic-empty is-error">' + icon("permissionDanger") + "<span>" + escapeHtml2(semanticMenuState.error) + "</span></div>";
        } else if (!items.length) {
          menu.innerHTML = '<div class="better-codex-semantic-empty">' + te(state.locale === "zh-CN" ? "没有匹配项" : "No matches") + "</div>";
        } else {
          let currentGroup = "";
          menu.innerHTML = items.map((item, index) => {
            const group = item.group || "";
            const heading = group && group !== currentGroup ? '<div class="better-codex-semantic-group" role="presentation">' + escapeHtml2(group) + "</div>" : "";
            currentGroup = group;
            return heading + '<button type="button" role="option" aria-selected="' + (index === semanticMenuState.index) + '" data-semantic-option="' + index + '"' + (item.available === false ? ' disabled aria-disabled="true"' : "") + '><span class="better-codex-semantic-icon">' + icon(item.icon || semanticCandidateIcon(item.kind)) + '</span><span class="better-codex-semantic-copy"><strong>' + escapeHtml2(item.label) + "</strong><small>" + escapeHtml2(item.description || "") + "</small></span><kbd>" + escapeHtml2(item.scope || "") + "</kbd></button>";
          }).join("");
        }
        menu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      }
      function closeSemanticMenu() {
        semanticMenuState = null;
        renderSemanticMenu();
      }
      async function loadSemanticCatalog(query = "", kinds = []) {
        if (!CODEX_SEMANTICS_AVAILABLE) return semanticCatalog = { schema_version: 2, results: [], provider_errors: [{ source: "catalog", message: state.locale === "zh-CN" ? "当前 Web 视图无法读取本机 Codex 功能" : "This web view cannot read local Codex capabilities" }] };
        try {
          const data = await semanticController.search(query, kinds);
          semanticCatalog = { schema_version: 2, results: Array.isArray(data?.results) ? data.results : [], provider_errors: Array.isArray(data?.provider_errors) ? data.provider_errors : [] };
        } catch (error) {
          if (error instanceof Error && error.message === "semantic_search_cancelled") throw error;
          appendDiagnostic("semantic_catalog_unavailable", { issue_id: issue?.id || "", project_id: draft.projectId || "", error: error instanceof Error ? error.message : String(error) });
          semanticCatalog = { schema_version: 2, results: [], provider_errors: [{ source: "catalog", message: error instanceof Error ? error.message : "codex_semantics_unavailable" }] };
        }
        return semanticCatalog;
      }
      function semanticCandidateItems(trigger) {
        return (semanticCatalog?.results || []).map((candidate) => ({ kind: candidate.kind, name: candidate.label, handle: candidate.handle, display: (trigger === "$" && candidate.kind === "skill" ? "$" : "@") + (candidate.display_path || candidate.label), label: candidate.label, description: candidate.detail, scope: candidate.source + (candidate.availability === "available" ? "" : " · " + candidate.availability), group: semanticCandidateGroup(candidate.kind), icon: semanticCandidateIcon(candidate.kind), available: candidate.availability === "available" && candidate.addressability === "direct" }));
      }
      function semanticCatalogError(source) {
        const error = (semanticCatalog?.provider_errors || []).find((item) => item?.source === source || item?.source === "catalog");
        return error ? String(error.message || "codex_semantics_unavailable") : "";
      }
      function syncSemanticMenu() {
        const input = semanticEditor();
        const token = semanticToken(input);
        if (!token) return closeSemanticMenu();
        if (token.trigger === "/") {
          const query = token.query.toLowerCase();
          const items = semanticCommands().filter((item) => !query || item.name.includes(query));
          semanticMenuState = { token, items, index: Math.min(semanticMenuState?.index || 0, Math.max(0, items.length - 1)) };
          return renderSemanticMenu();
        }
        if (token.trigger === "$") {
          semanticMenuState = { token, items: [], index: 0, loading: true, error: "" };
          renderSemanticMenu();
          void loadSemanticCatalog(token.query, ["skill"]).then(() => {
            const current = semanticToken(semanticEditor());
            if (!current || current.trigger !== "$" || current.query !== token.query) return;
            semanticMenuState = { token: current, items: semanticCandidateItems("$"), index: 0, error: semanticCatalogError("skills") };
            renderSemanticMenu();
          }).catch(() => {
          });
          return;
        }
        semanticMenuState = { token, items: [], index: 0, loading: true, error: "" };
        renderSemanticMenu();
        void loadSemanticCatalog(token.query).then(() => {
          const current = semanticToken(semanticEditor());
          if (!current || current.trigger !== "@" || current.query !== token.query) return;
          semanticMenuState = { token: current, items: semanticCandidateItems("@"), index: 0, error: semanticCatalogError("catalog") };
          renderSemanticMenu();
        }).catch(() => {
        });
      }
      function replaceSemanticToken(value) {
        const input = semanticEditor();
        const token = semanticMenuState?.token || semanticToken(input);
        if (!input || !token) return;
        input.value = input.value.slice(0, token.start) + value + input.value.slice(token.end);
        const cursor = token.start + value.length;
        input.setSelectionRange(cursor, cursor);
        if (!issue && draft.mode === "agent") {
          draft.prompt = input.value;
          updateSubmitState();
        } else {
          draft.reply = input.value;
          latestReplyDraft = input.value;
          scheduleReplyDraft(input.value);
          updateReplySendState();
        }
      }
      function selectSemanticOption(index = semanticMenuState?.index || 0) {
        const item = semanticMenuState?.items?.[index];
        if (!item || item.available === false) return;
        if (item.kind === "command") {
          if (item.name === "status") {
            replaceSemanticToken("");
            semanticMenuState = { status: true };
            renderSemanticMenu();
            return;
          }
          if (item.name === "skills") {
            replaceSemanticToken("$");
            semanticMenuState = null;
            return syncSemanticMenu();
          }
          if (item.name === "apps") {
            replaceSemanticToken("@");
            semanticMenuState = null;
            return syncSemanticMenu();
          }
          const argumentCommand = ["feedback", "memories", "model", "personality", "project", "reasoning"].includes(item.name);
          replaceSemanticToken(item.label + (argumentCommand ? " " : ""));
          closeSemanticMenu();
          return;
        }
        const input = semanticEditor();
        const activeToken = semanticMenuState?.token || semanticToken(input);
        if (!input || !activeToken || !item.handle) return;
        const document2 = insertSemanticReference(semanticDraftDocument(), activeToken.start, activeToken.end, item.handle, item.display);
        setSemanticDraftDocument(document2);
        input.value = document2.text;
        const cursor = activeToken.start + item.display.length + 1;
        input.setSelectionRange(cursor, cursor);
        if (!issue && draft.mode === "agent") draft.prompt = input.value;
        else {
          draft.reply = input.value;
          latestReplyDraft = input.value;
          scheduleReplyDraft(input.value);
        }
        closeSemanticMenu();
      }
      function handleSemanticMenuKeydown(event) {
        if (!semanticMenuState) return false;
        const items = semanticMenuState.items || [];
        if (event.key === "Escape") {
          event.preventDefault();
          closeSemanticMenu();
          return true;
        }
        if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          const offset = event.key === "ArrowDown" ? 1 : -1;
          semanticMenuState.index = (semanticMenuState.index + offset + items.length) % items.length;
          renderSemanticMenu();
          return true;
        }
        if (items.length && (event.key === "Enter" || event.key === "Tab")) {
          event.preventDefault();
          selectSemanticOption();
          return true;
        }
        return false;
      }
      function conversationComposer() {
        if (!issue || !sessionId) return "";
        const stopping = issue.session_status === "stopping";
        const archived = Boolean(issue.archived_at);
        const working = stopping || executionRunning || enrichmentLocked || issue.reply_status === "running";
        const hasContent = Boolean(draft.reply.trim() || draft.replyAttachments.length);
        const mode = replySubmitInFlight ? "submitting" : stopping ? "stopping" : working && !hasContent ? "stop" : working ? "queue" : "send";
        const inputDisabled = archived ? " disabled" : "";
        const actionDisabled = replySubmitInFlight || stopping || archived || mode !== "stop" && !hasContent ? " disabled" : "";
        const actionLabel = t(replySubmitInFlight ? "正在发送…" : stopping ? "正在停止…" : mode === "stop" ? "停止任务" : mode === "queue" ? "加入队列" : "发送");
        const attachments = attachmentList(draft.replyAttachments, "reply");
        const attachButton = '<button class="better-codex-composer-attach" type="button" data-conversation-attach aria-label="' + te("添加附件") + '" title="' + te("添加附件") + '"' + inputDisabled + ">" + icon("plus", "", "1.9") + "</button>";
        const actionIcon = replySubmitInFlight ? replySubmitLoadingIcon() : icon(mode === "stop" || mode === "stopping" ? "stop" : "send", "", mode === "stop" || mode === "stopping" ? "2.5" : "2");
        return '<div class="better-codex-composer" data-state="' + mode + '">' + attachments + '<div class="better-codex-semantic-menu" id="better-codex-semantic-menu" data-semantic-menu role="listbox" hidden></div><textarea name="reply" rows="2" placeholder="' + te(archived ? "取消归档后继续对话" : "输入下一步要求…") + '" aria-label="' + te("回复") + '" aria-autocomplete="list" aria-controls="better-codex-semantic-menu" aria-expanded="false"' + inputDisabled + ">" + escapeHtml2(draft.reply) + "</textarea>" + semanticWarningMarkup(draft.replySemanticDocument) + '<div class="better-codex-composer-toolbar"><div class="better-codex-composer-toolbar-leading">' + attachButton + '</div><button class="better-codex-composer-send" type="button" data-conversation-send data-composer-mode="' + mode + '" aria-label="' + escapeHtml2(actionLabel) + '" title="' + escapeHtml2(actionLabel) + '"' + (replySubmitInFlight ? ' aria-busy="true"' : "") + actionDisabled + ">" + actionIcon + "</button></div></div>";
      }
      function syncQueuedReplyState() {
        const queue = dialog.querySelector("[data-conversation-queue]");
        if (!queue) return;
        const activeEditInput = queue.querySelector("[data-queue-edit-input]");
        if (queueEditingRequestId && activeEditInput === document.activeElement && !queueActionRequestId) {
          if (!queueEditFocusPreserved) {
            queueEditFocusPreserved = true;
            traceDialog("conversation_queue_edit_preserved", { request_id: queueEditingRequestId });
          }
          return;
        }
        queueEditFocusPreserved = false;
        queue.hidden = queuedReplies.length === 0;
        queue.setAttribute("aria-label", t("队列中 {{count}} 条消息").replace("{{count}}", String(queuedReplies.length)));
        queue.innerHTML = queuedReplies.length ? queuedReplies.map((item) => {
          const requestId = String(item.request_id || "");
          const message = item.message || t("附件");
          const busy = queueActionRequestId === requestId;
          if (queueEditingRequestId === requestId) {
            return '<div class="better-codex-composer-queue-row is-editing" role="listitem" data-queue-request="' + escapeHtml2(requestId) + '"><span class="better-codex-composer-queue-icon" aria-hidden="true">' + icon("queue") + '</span><span class="better-codex-composer-queue-edit-field"><textarea class="better-codex-composer-queue-edit" data-queue-edit-input rows="2" aria-label="' + te("编辑队列消息") + '">' + escapeHtml2(queueEditDraft) + '</textarea><span class="better-codex-semantic-warning" data-queue-edit-warning role="status"' + (queueEditSemanticDocument?.degraded ? "" : " hidden") + ">" + icon("permissionDanger") + "<span>" + escapeHtml2(semanticWarningText()) + '</span></span></span><span class="better-codex-composer-queue-actions"><button type="button" data-queue-edit-save="' + escapeHtml2(requestId) + '" aria-label="' + te("保存修改") + '" title="' + te("保存修改") + '"' + (busy || !queueEditDraft.trim() ? " disabled" : "") + ">" + icon(busy ? "refresh" : "check", busy ? "better-codex-spin" : "") + '</button><button type="button" data-queue-edit-cancel aria-label="' + te("取消编辑") + '" title="' + te("取消编辑") + '"' + (busy ? " disabled" : "") + ">" + icon("close") + "</button></span></div>";
          }
          const disabled = busy || Boolean(issue?.archived_at);
          return '<div class="better-codex-composer-queue-row" role="listitem" data-queue-request="' + escapeHtml2(requestId) + '" title="' + escapeHtml2(message) + '"><span class="better-codex-composer-queue-icon" aria-hidden="true">' + icon("queue") + '</span><span class="better-codex-composer-queue-message">' + escapeHtml2(message) + '</span><span class="better-codex-composer-queue-actions"><button type="button" data-queue-send-now="' + escapeHtml2(requestId) + '" aria-label="' + te("立即发送") + '" title="' + te("立即发送") + '"' + (disabled ? " disabled" : "") + ">" + icon(busy ? "refresh" : "send", busy ? "better-codex-spin" : "") + '</button><button type="button" data-queue-edit="' + escapeHtml2(requestId) + '" aria-label="' + te("编辑队列消息") + '" title="' + te("编辑队列消息") + '"' + (disabled ? " disabled" : "") + ">" + icon("edit") + '</button><button type="button" data-queue-delete="' + escapeHtml2(requestId) + '" aria-label="' + te("删除队列消息") + '" title="' + te("删除队列消息") + '"' + (disabled ? " disabled" : "") + ">" + icon("trash") + "</button></span></div>";
        }).join("") + (queueActionError ? '<div class="better-codex-composer-queue-error" role="listitem">' + escapeHtml2(queueActionError) + "</div>" : "") : "";
      }
      function queuedReplyError(error, reconciled = false) {
        const value = String(error instanceof Error ? error.message : error || "");
        if (value === "issue_not_running") return t("当前任务已结束，消息会按队列顺序发送。");
        if (reconciled) return t("该队列消息已发生变化，已同步最新状态。");
        if (["queued_reply_not_found", "queued_reply_not_pending", "queued_reply_update_conflict"].includes(value)) return t("该队列消息已发生变化，正在同步最新状态。");
        return t("队列操作失败，请重试。");
      }
      async function reconcileQueuedReplyConflict(error) {
        if (!contentConflict(error)) return { error, reconciled: false };
        const correlation = contentConflictCorrelation(error);
        appendDiagnostic("content_conflict_sync_started", { surface: "conversation_queue", issue_id: issue?.id || "", ...correlation });
        try {
          await loadConversation({ quiet: true });
          appendDiagnostic("content_conflict_sync_completed", { surface: "conversation_queue", issue_id: issue?.id || "", ...correlation });
          return { error, reconciled: true };
        } catch (syncError) {
          appendDiagnostic("content_conflict_sync_failed", { surface: "conversation_queue", issue_id: issue?.id || "", ...correlation, error: syncError instanceof Error ? syncError.message : String(syncError || "request_failed") });
          return { error: syncError, reconciled: false };
        }
      }
      async function updateQueuedReply(action, requestId) {
        if (!issue || !requestId || queueActionRequestId) return;
        const message = queueEditDraft.trim();
        if (action === "update" && !message) return;
        queueActionRequestId = requestId;
        queueActionError = "";
        syncQueuedReplyState();
        try {
          const commandId = globalThis.crypto?.randomUUID?.() || VERSION + "-queue-" + Date.now() + "-" + Math.random().toString(36).slice(2);
          const path = "/api/issues/" + encodeURIComponent(issue.id) + "/queue/" + encodeURIComponent(requestId) + (action === "send" ? "/send" : "");
          const result = await api(path, { method: action === "send" ? "POST" : action === "delete" ? "DELETE" : "PATCH", body: JSON.stringify(action === "update" ? { command_id: commandId, message, input_document: serializeSemanticDraft(reconcileSemanticText(queueEditSemanticDocument || createSemanticDraft(message), message)) } : { command_id: commandId }), commandId, enqueue: true });
          if (result.queued === true) {
            pendingQueueCommands.set(commandId, { action, requestId });
            if (action === "send" || action === "delete") queuedReplies = queuedReplies.filter((item) => item.request_id !== requestId);
            else queuedReplies = queuedReplies.map((item) => item.request_id === requestId ? { ...item, message } : item);
            queueEditingRequestId = "";
            queueEditDraft = "";
            queueEditSemanticDocument = null;
            traceDialog("conversation_queue_command_queued", { command_id: commandId, request_id: requestId, action });
            watchQueuedCommand(commandId, {
              applied: async (payload) => {
                pendingQueueCommands.delete(commandId);
                if (!pendingQueueCommands.size && Array.isArray(payload?.queued_replies)) queuedReplies = payload.queued_replies;
                queueActionError = "";
                if (dialog.isConnected) {
                  syncQueuedReplyState();
                  if (!pendingQueueCommands.size) await loadConversation({ quiet: true });
                }
              },
              failed: async (error) => {
                pendingQueueCommands.delete(commandId);
                const reconciliation = await reconcileQueuedReplyConflict(error);
                const reportContext = { source: "conversation_queue_settle", action, issue_id: issue.id, request_id: requestId, command_id: commandId };
                queueActionError = queuedReplyError(reconciliation.error, reconciliation.reconciled);
                if (reconciliation.reconciled) reportReconciledContentConflict(reconciliation.error, reportContext);
                else reportUnexpectedError(reconciliation.error, reportContext);
                if (dialog.isConnected) {
                  syncQueuedReplyState();
                  if (!pendingQueueCommands.size && reconciliation.error === error) await loadConversation({ quiet: true });
                }
              }
            });
          } else if (result.command_id) {
            const command = await waitForRemoteCommand(result.command_id);
            if (command.status !== "applied") throw new Error(command.error || "command_rejected");
            if (Array.isArray(command.payload?.queued_replies)) queuedReplies = command.payload.queued_replies;
            else if (action === "send" || action === "delete") queuedReplies = queuedReplies.filter((item) => item.request_id !== requestId);
            else queuedReplies = queuedReplies.map((item) => item.request_id === requestId ? { ...item, message } : item);
            queueEditingRequestId = "";
            queueEditDraft = "";
            queueEditSemanticDocument = null;
          } else {
            if (Array.isArray(result.queued_replies)) queuedReplies = result.queued_replies;
            else if (action === "send" || action === "delete") queuedReplies = queuedReplies.filter((item) => item.request_id !== requestId);
            else queuedReplies = queuedReplies.map((item) => item.request_id === requestId ? { ...item, message } : item);
            queueEditingRequestId = "";
            queueEditDraft = "";
            queueEditSemanticDocument = null;
            conversationTimer = setTimeout(() => void loadConversation({ quiet: true }), 1500);
          }
        } catch (error) {
          const reconciliation = await reconcileQueuedReplyConflict(error);
          const reportContext = { source: "conversation_queue", action, issue_id: issue.id, request_id: requestId };
          queueActionError = queuedReplyError(reconciliation.error, reconciliation.reconciled);
          if (reconciliation.reconciled) reportReconciledContentConflict(reconciliation.error, reportContext);
          else reportUnexpectedError(reconciliation.error, reportContext);
        } finally {
          queueActionRequestId = "";
          syncQueuedReplyState();
        }
      }
      function replyFailureMessage(error, action) {
        const value = String(error instanceof Error ? error.message : error || "request_failed").toLowerCase();
        const serviceLabel = serviceFailureLabel(error);
        if (serviceLabel) return serviceLabel;
        if (sessionThreadMissing(value)) return "会话记录尚不可恢复，需要先处理会话绑定问题。";
        if (action === "execution") return "任务执行失败。请根据下方失败原因处理后重新运行。";
        if (action === "load") {
          if (value.includes("timeout") || value.includes("timed out") || value.includes("deadline")) return "会话加载超时。请确认 Better Codex Runtime 正在运行，然后重新加载。";
          if (["permission", "eacces", "eperm", "forbidden", "unauthorized", "401", "403", "approval"].some((marker) => value.includes(marker))) return "没有权限加载会话。请调整权限后重新加载。";
          return "无法加载会话。请检查网络和 Better Codex Runtime，然后重新加载。";
        }
        if (value.includes("timeout") || value.includes("timed out") || value.includes("deadline")) return "回复等待超时。请检查模型服务连接后重试。";
        if (["reply_network_error", "apiconnectionerror", "network", "fetch", "econn", "enotfound", "dns", "socket", "relay_stream", "runtime_bridge_unavailable"].some((marker) => value.includes(marker))) return "网络连接异常，回复未完成。请检查网络和 Better Codex Runtime 后重试。";
        if (["reply_permission_denied", "permission", "eacces", "eperm", "forbidden", "unauthorized", "401", "403", "approval"].some((marker) => value.includes(marker))) return "当前权限不足，无法完成回复。请调整智能体权限或允许所需操作后重试。";
        if (value.includes("reply_busy")) return "上一条回复仍在进行中。请稍后重新加载。";
        return "回复未完成。请打开完整会话查看详情，然后重试。";
      }
      function showConversationFailure(error, action = "reply", message = "", context = {}) {
        const feedback = dialog.querySelector("[data-conversation-feedback]");
        if (!feedback) return;
        const failure = error instanceof Error ? error : new Error(String(error || "request_failed"));
        const reportContext = { source: "conversation", action, ...context };
        const failureKey = action + ":" + String(reportContext.origin || "") + ":" + failure.message;
        const presentation = errorPresentation(failure, reportContext);
        if (failureKey !== conversationFailureKey) reportUnexpectedError(failure, reportContext);
        conversationFailureKey = failureKey;
        conversationFailureState = "failed";
        if (message) lastReplyMessage = message;
        feedback.dataset.tone = presentation.tone;
        const retry = action === "load" || action === "reply" && Boolean(message) ? '<button type="button" data-conversation-retry="' + action + '">' + te(action === "load" ? "重新加载" : "重试回复") + "</button>" : "";
        const reasonLabel = state.locale === "zh-CN" ? "失败原因" : "Failure reason";
        feedback.innerHTML = "<span><strong>" + te(action === "load" ? "无法加载会话" : "执行失败") + "</strong><br><span>" + te(replyFailureMessage(failure, action)) + "</span><br><code>" + escapeHtml2(reasonLabel + ": " + failure.message) + "</code></span>" + retry;
        feedback.hidden = false;
        syncConversationStatus("failed");
        feedback.querySelector("[data-conversation-retry]")?.addEventListener("click", (event) => {
          if (event.currentTarget.dataset.conversationRetry === "load") void loadConversation();
          else {
            const retryRequestId = ["failed", "interrupted"].includes(lastReplyStatus) ? "" : lastReplyRequestId;
            void sendReply(lastReplyMessage, retryRequestId, lastReplySemanticReferences, lastReplyCommand);
          }
        });
      }
      function clearConversationFailure() {
        const feedback = dialog.querySelector("[data-conversation-feedback]");
        if (!feedback) return;
        conversationFailureState = "";
        conversationFailureKey = "";
        feedback.hidden = true;
        feedback.innerHTML = "";
      }
      function relativeTime(value) {
        if (!value) return "";
        const time = Date.parse(value);
        if (!Number.isFinite(time)) return "";
        const delta = Math.max(0, Date.now() - time);
        const minute = 60 * 1e3;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (delta < minute) return state.locale === "zh-CN" ? "刚刚" : "Just now";
        if (delta < day * 30) {
          const unit = delta < hour ? "minute" : delta < day ? "hour" : "day";
          const amount = Math.floor(delta / (unit === "minute" ? minute : unit === "hour" ? hour : day));
          if (state.locale !== "zh-CN") return amount + " " + unit + (amount === 1 ? "" : "s") + " ago";
          return amount + (unit === "minute" ? " 分钟前" : unit === "hour" ? " 小时前" : " 天前");
        }
        return new Date(time).toLocaleDateString(state.locale);
      }
      function attachmentTypeLabel(attachment) {
        if (attachment.kind === "image") return t("图片");
        if (attachment.kind === "pdf") return t("PDF 文档");
        if (attachment.kind === "text") return t("文本文档");
        return t("文件");
      }
      function conversationAttachments(message, messageIndex) {
        if (!Array.isArray(message.attachments) || !message.attachments.length) return "";
        const items = message.attachments.map((attachment, attachmentIndex) => '<button class="better-codex-message-attachment" type="button" data-conversation-attachment="' + attachmentIndex + '" data-conversation-attachment-message="' + messageIndex + '" aria-label="' + te("打开附件") + " " + escapeHtml2(attachment.name || t("附件")) + '"><span class="better-codex-message-attachment-icon" data-kind="' + escapeHtml2(attachment.kind || "file") + '">' + icon(attachment.kind === "image" ? "image" : attachment.kind === "text" || attachment.kind === "pdf" ? "docs" : "paperclip") + '</span><span class="better-codex-message-attachment-copy"><strong>' + escapeHtml2(attachment.name || t("附件")) + "</strong><small>" + escapeHtml2(attachmentTypeLabel(attachment)) + '</small></span><span class="better-codex-message-attachment-open">' + icon("external") + "</span></button>").join("");
        return '<div class="better-codex-message-attachments">' + items + "</div>";
      }
      function attachmentSize(value) {
        const size = Number(value) || 0;
        if (size < 1024) return size + " B";
        if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + " KB";
        return (size / 1024 / 1024).toFixed(1) + " MB";
      }
      function attachmentBlob(data, type) {
        const encoded = String(data || "").split(",", 2)[1] || "";
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new Blob([bytes], { type: type || "application/octet-stream" });
      }
      async function openAttachmentPreview(attachment, load2, diagnostics = {}) {
        document.getElementById("better-codex-attachment-dialog")?.remove();
        const preview = document.createElement("dialog");
        preview.id = "better-codex-attachment-dialog";
        preview.setAttribute(OWNED, "true");
        preview.setAttribute("aria-labelledby", "better-codex-attachment-title");
        preview.innerHTML = '<div class="better-codex-attachment-shell"><header><div><span>' + te("附件预览") + '</span><strong id="better-codex-attachment-title">' + escapeHtml2(attachment.name || t("附件")) + '</strong></div><button type="button" data-attachment-close aria-label="' + te("关闭") + '">' + icon("close") + '</button></header><div class="better-codex-attachment-body" data-attachment-body><div class="better-codex-attachment-loading">' + icon("refresh") + "<span>" + te("正在加载附件…") + "</span></div></div><footer><span data-attachment-meta>" + escapeHtml2(attachmentTypeLabel(attachment)) + '</span><div><a data-attachment-original hidden target="_blank" rel="noreferrer noopener">' + icon("external") + "<span>" + te("原始链接") + '</span></a><a class="is-primary" data-attachment-download download="' + escapeHtml2(attachment.name || t("附件")) + '">' + icon("download") + "<span>" + te("下载附件") + "</span></a></div></footer></div>";
        document.body.appendChild(preview);
        let objectUrl = "";
        const finish = () => {
          if (preview.open) preview.close();
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          preview.remove();
        };
        preview.querySelector("[data-attachment-close]").addEventListener("click", finish);
        preview.addEventListener("cancel", (event) => {
          event.preventDefault();
          finish();
        });
        preview.addEventListener("click", (event) => event.stopPropagation());
        bindModalDismiss(preview, finish);
        preview.showModal();
        preview.querySelector("[data-attachment-close]").focus();
        const body = preview.querySelector("[data-attachment-body]");
        const download = preview.querySelector("[data-attachment-download]");
        const original = preview.querySelector("[data-attachment-original]");
        const meta = preview.querySelector("[data-attachment-meta]");
        const render2 = async (source, data = attachment) => {
          if (data.kind === "image") body.innerHTML = '<img src="' + escapeHtml2(source) + '" alt="' + escapeHtml2(data.name || t("附件")) + '">';
          else if (data.kind === "pdf") body.innerHTML = '<iframe src="' + escapeHtml2(source) + '" title="' + escapeHtml2(data.name || t("附件")) + '"></iframe>';
          else if (data.kind === "text") {
            const text = data.data ? await attachmentBlob(data.data, data.type).text() : "";
            body.innerHTML = text ? "<pre>" + escapeHtml2(text.slice(0, 5e5)) + "</pre>" : '<iframe src="' + escapeHtml2(source) + '" title="' + escapeHtml2(data.name || t("附件")) + '"></iframe>';
          } else body.innerHTML = '<div class="better-codex-attachment-file">' + icon("paperclip") + "<strong>" + escapeHtml2(data.name || t("附件")) + "</strong><span>" + te("不支持预览此文件，可下载后查看。") + "</span></div>";
        };
        try {
          const loaded = await load2();
          if (!preview.isConnected) {
            if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
            return;
          }
          const data = loaded.attachment || attachment;
          objectUrl = loaded.objectUrl || "";
          download.href = loaded.source;
          download.download = data.name || attachment.name || t("附件");
          meta.textContent = attachmentTypeLabel(data) + (data.size ? " · " + attachmentSize(data.size) : "");
          if (loaded.originalUrl) {
            download.target = "_blank";
            download.rel = "noreferrer noopener";
            original.href = loaded.originalUrl;
            original.hidden = false;
          }
          await render2(loaded.source, data);
        } catch (error) {
          appendDiagnostic("attachment_preview_failed", { ...diagnostics, error: error instanceof Error ? error.message : String(error) });
          body.innerHTML = '<div class="better-codex-attachment-file is-error">' + icon("paperclip") + "<strong>" + te("无法打开附件") + "</strong><span>" + escapeHtml2(error instanceof Error ? t(error.message) : t("无法读取文件")) + "</span></div>";
          download.hidden = true;
        }
      }
      async function openConversationAttachment(messageIndex, attachmentIndex) {
        const message = conversationMessages[messageIndex];
        const attachment = message?.attachments?.[attachmentIndex];
        if (!attachment) return;
        await openAttachmentPreview(attachment, async () => {
          if (attachment.source === "url" && attachment.url) return { source: attachment.url, attachment, originalUrl: attachment.url };
          const result = await api("/api/issues/" + encodeURIComponent(issue.id) + "/attachments/" + encodeURIComponent(message.id) + "/" + attachmentIndex, { timeoutMs: 12e4 });
          const source = URL.createObjectURL(attachmentBlob(result.data, result.type));
          return { source, attachment: result, objectUrl: source };
        }, { issue_id: issue.id, message_id: message.id, attachment_index: attachmentIndex });
      }
      async function openDraftAttachment(scope, attachmentIndex) {
        const attachments = scope === "reply" ? draft.replyAttachments : draft.attachments;
        const attachment = attachments[attachmentIndex];
        if (!attachment || !attachment.previewUrl && !attachment.path) return;
        const data = { name: attachment.name, type: attachment.type || attachment.file?.type || "image/png", kind: "image", size: attachment.file?.size || 0 };
        await openAttachmentPreview(data, async () => {
          if (attachment.previewUrl) return { source: attachment.previewUrl, attachment: data };
          const cacheName = String(attachment.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
          const result = await api("/api/issues/attachments/preview?name=" + encodeURIComponent(cacheName), { timeoutMs: 12e4 });
          const source = URL.createObjectURL(attachmentBlob(result.data, result.type));
          return { source, attachment: { ...result, name: attachment.name || result.name }, objectUrl: source };
        }, { issue_id: issue?.id || "", attachment_scope: scope, attachment_index: attachmentIndex });
      }
      const expandedThinkingCards = /* @__PURE__ */ new Set();
      function conversationStepsMarkup(steps, isRunning = false, id = "") {
        if (!Array.isArray(steps) || !steps.length) return "";
        const visibleSteps = steps.filter((step) => step.kind !== "reasoning");
        if (!visibleSteps.length) return "";
        const count = visibleSteps.length;
        const totalDurationMs = steps.reduce((sum, s) => sum + (Number(s.duration_ms) || 0), 0);
        const durationLabel = totalDurationMs >= 6e4 ? Math.floor(totalDurationMs / 6e4) + "m " + Math.floor(totalDurationMs % 6e4 / 1e3) + "s" : totalDurationMs >= 1e3 ? (totalDurationMs / 1e3).toFixed(0) + "s" : "";
        const title = isRunning ? te("执行中…") : te("执行过程");
        const countLabel = te("共 ") + count + te(" 步") + (durationLabel ? " · " + durationLabel : "");
        const isOpen = id ? expandedThinkingCards.has(id) : false;
        const stepItems = visibleSteps.map((step) => {
          const iconKey = step.kind === "reasoning" ? "sparkles" : step.kind === "command" ? "terminal" : step.kind === "image" ? "image" : step.kind === "file" ? "folder" : "wrench";
          const statusMarkup = step.status === "failed" ? icon("close") : step.status === "running" ? '<span class="better-codex-activity-dot" aria-hidden="true"></span>' : icon("check");
          const stepDuration = step.duration_ms && step.duration_ms >= 1e3 ? (step.duration_ms / 1e3).toFixed(1) + "s" : "";
          return '<li class="better-codex-thinking-step ' + escapeHtml2(step.status || "completed") + '"><span class="better-codex-thinking-step-icon">' + icon(iconKey) + '</span><span class="better-codex-thinking-step-title" title="' + escapeHtml2(step.detail || step.title) + '">' + escapeHtml2(step.title) + "</span>" + (stepDuration ? '<span class="better-codex-thinking-step-duration">' + escapeHtml2(stepDuration) + "</span>" : "") + '<span class="better-codex-thinking-step-status">' + statusMarkup + "</span></li>";
        }).join("");
        return '<details class="better-codex-thinking-card" data-thinking-id="' + escapeHtml2(id) + '"' + (isOpen ? " open" : "") + '><summary class="better-codex-thinking-summary"><span class="better-codex-thinking-icon">' + (isRunning ? '<span class="better-codex-activity-dot" aria-hidden="true"></span>' : icon("check")) + '</span><span class="better-codex-thinking-title">' + title + '</span><span class="better-codex-thinking-badge">' + countLabel + '</span><span class="better-codex-thinking-chevron">' + icon("chevronDown") + '</span></summary><div class="better-codex-thinking-content"><ol class="better-codex-thinking-steps">' + stepItems + "</ol></div></details>";
      }
      function conversationBubbles(messages, profile2 = null) {
        const agent = state.agents.find((item) => item.id === issue?.agent_id) || state.agents.find((item) => item.is_default) || null;
        const agentName = agent ? agentDisplayName(agent) : issue?.agent_enabled ? "Codex" : t("智能体");
        const user = profile2 && profile2.name ? profile2 : state.user || { name: t("你"), initials: t("你"), color: USER_AVATAR_COLORS[0] };
        if (profile2 && profile2.name) state.user = { ...state.user, ...profile2 };
        return (messages || []).map((message, index) => {
          const isUser = message.role === "user";
          const avatar = isUser ? userAvatarMarkup(user, "better-codex-bubble-avatar") : agentAvatarMarkup(agent, "better-codex-bubble-avatar");
          const name = isUser ? user.name || t("你") : agentName;
          const time = relativeTime(message.timestamp);
          const content = message.html || (message.attachments?.length ? "" : renderPlainBubble(message.markdown || ""));
          const stepsMarkup = !isUser && message.steps?.length ? conversationStepsMarkup(message.steps, false, message.id || "msg-step-" + index) : "";
          return '<article class="better-codex-bubble ' + (isUser ? "is-user" : "is-agent") + '">' + avatar + '<div class="better-codex-bubble-main"><button class="better-codex-bubble-copy" type="button" data-conversation-copy="' + index + '" aria-label="' + te("复制消息") + '" title="' + te("复制消息") + '">' + icon("copy") + '</button><div class="better-codex-bubble-meta"><strong>' + escapeHtml2(name) + "</strong>" + (time ? '<time datetime="' + escapeHtml2(message.timestamp || "") + '">' + escapeHtml2(time) + "</time>" : "") + "</div>" + stepsMarkup + (content ? '<div class="better-codex-bubble-content">' + content + "</div>" : "") + conversationAttachments(message, index) + "</div></article>";
        }).join("");
      }
      function syncOptimisticReplies() {
        const body = dialog.querySelector("[data-conversation-body]");
        const messages = dialog.querySelector("[data-conversation-messages]");
        if (!body || !messages) return;
        const confirmed = conversationMessages.filter((message) => !message.optimistic_request_id);
        conversationMessages = [...confirmed, ...optimisticReplies.values()];
        messages.innerHTML = conversationBubbles(conversationMessages, RELAY ? state.user : null) + (optimisticReplies.size ? conversationRunningMarkup() : "");
        body.scrollTop = body.scrollHeight;
      }
      function reconcileOptimisticReplies(messages) {
        for (const [requestId, optimistic] of optimisticReplies) {
          const optimisticAt = Date.parse(optimistic.timestamp || "");
          const confirmed = messages.some((message) => {
            if (message.id === "reply-" + requestId) return true;
            if (message.role !== "user" || message.markdown !== optimistic.markdown) return false;
            const messageAt = Date.parse(message.timestamp || "");
            return Number.isFinite(messageAt) && (!Number.isFinite(optimisticAt) || messageAt >= optimisticAt);
          });
          if (confirmed) {
            optimisticReplies.delete(requestId);
            traceDialog("reply_optimistic_confirmed", { request_id: requestId, confirmation_latency_ms: Math.max(0, Date.now() - Number(optimistic.accepted_at_ms || Date.now())) });
          }
        }
      }
      function renderPlainBubble(value) {
        return "<p>" + escapeHtml2(value).replace(/\n/g, "<br>") + "</p>";
      }
      function conversationThinkingMarkup() {
        return '<span class="better-codex-conversation-thinking" data-conversation-thinking role="status" aria-live="polite" aria-busy="true" aria-label="' + te("正在思考与处理…") + '"><span class="better-codex-conversation-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="better-codex-shimmer">' + te("正在思考与处理…") + "</span></span>";
      }
      function conversationRunningMarkup(activeSteps = [], turnId = "") {
        const agent = state.agents.find((item) => item.id === issue?.agent_id) || state.agents.find((item) => item.is_default) || null;
        const agentName = agent ? agentDisplayName(agent) : issue?.agent_enabled ? "Codex" : t("智能体");
        return '<article class="better-codex-bubble is-agent is-running">' + agentAvatarMarkup(agent, "better-codex-bubble-avatar") + '<div class="better-codex-bubble-main"><div class="better-codex-bubble-meta"><strong>' + escapeHtml2(agentName) + "</strong></div>" + conversationThinkingMarkup() + (activeSteps.length ? conversationStepsMarkup(activeSteps, true, "active-running-" + (turnId || "turn")) : "") + "</div></article>";
      }
      function applyConversation(data, options = {}) {
        const body = dialog.querySelector("[data-conversation-body]");
        const messageList = dialog.querySelector("[data-conversation-messages]");
        const status = dialog.querySelector("[data-conversation-status]");
        const send = dialog.querySelector("[data-conversation-send]");
        if (!body || !messageList || !status) return;
        if (!RELAY && data?.user && typeof data.user === "object") state.user = { ...state.user, ...data.user };
        const nextQueuedReplies = Array.isArray(data?.queued_replies) ? data.queued_replies : Array.isArray(data?.reply?.queued_replies) ? data.reply.queued_replies : null;
        if (nextQueuedReplies && !queueActionRequestId && !pendingQueueCommands.size) queuedReplies = nextQueuedReplies;
        syncQueuedReplyState();
        const confirmedMessages = Array.isArray(data?.messages) ? data.messages : data?.html ? [{ role: "agent", html: data.html, markdown: data.markdown || "", timestamp: null }] : [];
        reconcileOptimisticReplies(confirmedMessages);
        const messages = [...confirmedMessages, ...optimisticReplies.values()];
        const previousScrollTop = body.scrollTop;
        const stickToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        const reply = data?.reply || { status: "idle" };
        if (reply.message) lastReplyMessage = reply.message;
        if (reply.request_id) lastReplyRequestId = reply.request_id;
        const stateName = optimisticReplies.size && ["idle", "running"].includes(reply.status) ? "running" : reply.status || "idle";
        lastReplyStatus = stateName;
        const conversationIssue = { ...issue || {}, ...data?.issue || {}, reply_status: stateName };
        const isRunning = issueConversationRunning(conversationIssue) || data?.activity?.status === "running";
        const activeSteps = Array.isArray(data?.activity?.steps) ? data.activity.steps : [];
        const runningBubbleHtml = isRunning ? conversationRunningMarkup(activeSteps, data?.activity?.turn_id || "") : "";
        if (messages.length) {
          conversationMessages = messages;
          messageList.innerHTML = conversationBubbles(messages, RELAY ? state.user : data.user) + runningBubbleHtml;
          body.scrollTop = stickToBottom ? body.scrollHeight : previousScrollTop;
        } else if (!options.preserveBody) {
          conversationMessages = [];
          const empty = conversationEmptyState({
            hasThread: Boolean(sessionId),
            running: isRunning,
            started: Boolean(data?.activity?.turn_id || issue?.session_active_turn_id),
            failed: stateName === "failed" || issue?.latest_run_status === "failed",
            error: reply.error || issue?.session_last_error
          });
          messageList.innerHTML = '<div class="better-codex-conversation-empty"><h3>' + te(empty.title) + "</h3><p>" + te(empty.description) + "</p><span>" + te(empty.hint) + "</span></div>" + (isRunning ? conversationRunningMarkup(activeSteps, data?.activity?.turn_id || "") : "") + (activeSteps.length ? conversationStepsMarkup(activeSteps, true, "empty-running") : "");
        }
        const expectedInterruption = stateName === "interrupted" && ["user_stopped", "session_interrupted"].includes(String(reply.error || ""));
        if (stateName === "failed" || stateName === "interrupted" && !expectedInterruption) showConversationFailure(reply.error, reply.message ? "reply" : "execution", reply.message, { origin: "turn" });
        else {
          clearConversationFailure();
          syncConversationStatus(stateName);
        }
        if (send) updateReplySendState(stateName);
        stopConversationPoll();
        if (stateName === "running" || executionRunning) conversationTimer = setTimeout(() => void loadConversation({ quiet: true }), 2e3);
        else if (stateName === "succeeded" && !options.afterSuccess) conversationTimer = setTimeout(() => void loadConversation({ quiet: true, afterSuccess: true }), 1200);
      }
      async function loadConversation(options = {}) {
        if (!issue || !dialog.isConnected || !dialog.querySelector("[data-conversation-body]")) return;
        try {
          const data = await api("/api/issues/" + encodeURIComponent(issue.id) + "/conversation");
          conversationLoadFailures = 0;
          if (data?.issue && Number(data.issue.version) !== Number(issue.version)) await loadIssues({ background: true }).catch(() => {
          });
          applyConversation(data, options);
        } catch (error) {
          conversationLoadFailures += 1;
          if (options.quiet && conversationLoadFailures < 2) {
            conversationTimer = setTimeout(() => void loadConversation({ quiet: true }), 2500);
            return;
          }
          showConversationFailure(error, "load");
        }
      }
      async function waitForNativeCommand(requestId) {
        const deadline = Date.now() + 3e4;
        while (Date.now() < deadline) {
          const command = await api("/api/issues/" + encodeURIComponent(issue.id) + "/native-command/" + encodeURIComponent(requestId));
          if (command.status === "completed") return command.result || {};
          if (command.status === "failed" || command.status === "cancelled") throw new Error(command.error || "native_command_failed");
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        throw new Error("native_command_timeout");
      }
      async function executeSessionNativeCommand(command, argument, requestId) {
        traceDialog("native_command_requested", { request_id: requestId, command, argument_length: argument.length });
        const queued = await api("/api/issues/" + encodeURIComponent(issue.id) + "/native-command", { method: "POST", body: JSON.stringify({ request_id: requestId, command, argument }) });
        const result = queued.status === "completed" ? queued.result || {} : await waitForNativeCommand(requestId);
        traceDialog("native_command_completed", { request_id: requestId, command });
        return result;
      }
      function visibleNativeComposer() {
        const candidates = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]'));
        return candidates.find((element) => {
          if (element.closest("[" + OWNED + "]")) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 40 && rect.height > 20 && getComputedStyle(element).visibility !== "hidden";
        }) || null;
      }
      async function executeDesktopNativeCommand(command) {
        if (HOST_KIND === "web") throw new Error("native_desktop_command_unavailable");
        const original = command;
        const nativeCommand = command === "task" ? "chat" : command;
        traceDialog("native_desktop_command_requested", { command: original, native_command: nativeCommand, thread_id: sessionId });
        dialog.close();
        const opened = await openThread(sessionId);
        if (!opened.opened) {
          dialog.showModal();
          return;
        }
        const deadline = Date.now() + 5e3;
        let composer = visibleNativeComposer();
        while (!composer && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          composer = visibleNativeComposer();
        }
        if (!composer) throw new Error("native_desktop_composer_not_found");
        const value = "/" + nativeCommand;
        composer.focus();
        if (composer instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          if (!setter) throw new Error("native_desktop_composer_invalid");
          setter.call(composer, value);
        } else {
          composer.textContent = value;
        }
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 400));
        const remaining = composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent;
        if (remaining === value) throw new Error("native_desktop_command_not_accepted");
      }
      async function sendReply(retryMessage = "", retryRequestId = "", retrySemanticReferences = null, retryCommand = "", retrySemanticDocument = lastReplySemanticDocument) {
        const textarea = dialog.querySelector('[name="reply"]');
        const send = dialog.querySelector("[data-conversation-send]");
        const errorOutput = dialog.querySelector(".better-codex-dialog-error");
        const retrying = Boolean(retryMessage);
        const text = String(retryMessage || textarea?.value || "").trim();
        const slashMatch = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(text);
        const slashCommand = slashMatch?.[1] || "";
        const slashArgument = String(slashMatch?.[2] || "").trim();
        const semanticCommand = retryCommand || (["review", "compact"].includes(slashCommand) ? slashCommand : "");
        const semanticReferences = retrying ? retrySemanticReferences || [] : draft.replySemanticReferences.filter((reference) => text.includes((reference.type === "skill" ? "$" : "@") + reference.name));
        const semanticDocument = retrySemanticDocument || reconcileSemanticText(draft.replySemanticDocument, text);
        const requestId = retryRequestId || (globalThis.crypto?.randomUUID?.() || VERSION + "-reply-" + Date.now() + "-" + Math.random().toString(36).slice(2));
        if (!issue || !sessionId || !text && !draft.replyAttachments.length || !send || !errorOutput) return;
        if (!retrying && slashCommand === "status") {
          if (textarea) textarea.value = "";
          draft.reply = "";
          latestReplyDraft = "";
          draft.replySemanticReferences = [];
          semanticMenuState = { status: true };
          renderSemanticMenu();
          persistReplyDraft("");
          updateReplySendState();
          return;
        }
        if (!retrying && (slashCommand === "skills" || slashCommand === "apps")) {
          if (textarea) {
            textarea.value = slashCommand === "skills" ? "$" : "@";
            textarea.setSelectionRange(1, 1);
          }
          draft.reply = textarea?.value || "";
          latestReplyDraft = draft.reply;
          scheduleReplyDraft(draft.reply);
          syncSemanticMenu();
          updateReplySendState();
          return;
        }
        if (!retrying && DESKTOP_NATIVE_COMMANDS.includes(slashCommand)) {
          send.disabled = true;
          errorOutput.hidden = true;
          try {
            await executeDesktopNativeCommand(slashCommand);
          } catch (error) {
            if (dialog.isConnected) {
              presentInlineError(errorOutput, error, errorLabel(error), { source: "native_desktop_command", command: slashCommand });
              send.disabled = false;
            }
          }
          return;
        }
        if (!retrying && SESSION_NATIVE_COMMANDS.includes(slashCommand)) {
          send.disabled = true;
          errorOutput.hidden = true;
          clearConversationFailure();
          try {
            const result = await executeSessionNativeCommand(slashCommand, slashArgument, requestId);
            completeReplySubmission(text, [], { persistDraftClear: true });
            semanticMenuState = { nativeResult: { command: slashCommand, result } };
            renderSemanticMenu();
            await loadIssues({ background: true });
            if (result.rebind_thread) await loadConversation({ quiet: true });
          } catch (error) {
            traceDialog("native_command_failed", { request_id: requestId, command: slashCommand, error: String(error instanceof Error ? error.message : "native_command_failed").slice(0, 200) });
            presentInlineError(errorOutput, error, errorLabel(error), { source: "native_command", command: slashCommand, request_id: requestId });
            send.disabled = false;
          }
          return;
        }
        if (replySubmitInFlight) return;
        const initialComposerMode = send.dataset.composerMode || "send";
        traceDialog("reply_submit_started", { request_id: requestId, composer_mode: initialComposerMode, message_length: text.length, attachment_count: draft.replyAttachments.length });
        setReplySubmitLoading(true);
        if (!retrying) {
          try {
            await flushReplyDraft();
          } catch (error) {
            replyDraftPersistenceError = error;
          }
          if (replyDraftPersistenceError) {
            presentInlineError(errorOutput, replyDraftPersistenceError, errorLabel(replyDraftPersistenceError), { source: "reply_draft_flush", request_id: requestId });
            setReplySubmitLoading(false);
            return;
          }
        }
        stopReplyRecovery();
        send.disabled = true;
        errorOutput.hidden = true;
        clearConversationFailure();
        let message = text;
        let files = [];
        if (REMOTE || !retrying) {
          try {
            if (REMOTE) {
              files = await remoteFiles(draft.replyAttachments.filter((item) => item.file));
              message = withAttachments(text, draft.replyAttachments.filter((item) => item.path));
            } else {
              await uploadPastedImages(draft.replyAttachments);
              message = withAttachments(text, draft.replyAttachments);
            }
          } catch (error) {
            presentInlineError(errorOutput, error, t(error instanceof Error ? error.message : "图片保存失败"), { source: "attachment_prepare", action: "reply", report: false });
            setReplySubmitLoading(false);
            return;
          }
        }
        const submittedAttachments = draft.replyAttachments.slice();
        const submittedSemanticDocument = reconcileSemanticText(semanticDocument, message);
        const submissionCommandId = globalThis.crypto?.randomUUID?.() || VERSION + "-reply-command-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const queueMode = initialComposerMode === "queue" || executionRunning;
        let reply;
        try {
          lastReplySemanticReferences = semanticReferences.map((reference) => ({ ...reference }));
          lastReplySemanticDocument = submittedSemanticDocument;
          lastReplyCommand = semanticCommand;
          reply = await api("/api/issues/" + encodeURIComponent(issue.id) + "/reply", { method: "POST", body: JSON.stringify({ message, input_document: serializeSemanticDraft(submittedSemanticDocument), request_id: requestId, files, command: semanticCommand }), timeoutMs: files.length ? 12e4 : void 0, commandId: submissionCommandId, enqueue: true });
        } catch (error) {
          lastReplyRequestId = requestId;
          const outcomeUncertain = !Number(error?.betterCodexDiagnostics?.http_status);
          const composerCleared2 = outcomeUncertain ? completeReplySubmission(text, submittedAttachments) : false;
          traceDialog("reply_submit_unconfirmed", { request_id: requestId, outcome_uncertain: outcomeUncertain, composer_cleared: composerCleared2, error: String(error instanceof Error ? error.message : "request_failed").slice(0, 200) });
          showConversationFailure(error, "reply", message);
          scheduleReplyRecovery(requestId, message, text, submittedAttachments);
          setReplySubmitLoading(false);
          return;
        }
        lastReplyRequestId = reply.request_id || requestId;
        lastReplyStatus = "running";
        stopReplyRecovery();
        const composerCleared = completeReplySubmission(text, submittedAttachments);
        const queuedCommandId = reply.queued === true ? submissionCommandId : HOST_KIND === "remote-projection" && reply.status === "running" ? reply.request_id || requestId : "";
        if (queuedCommandId) {
          pendingQueueCommands.set(queuedCommandId, { action: "reply", requestId });
          if (queueMode) {
            if (!queuedReplies.some((item) => item.request_id === requestId)) queuedReplies.push({ request_id: requestId, message, created_at: (/* @__PURE__ */ new Date()).toISOString(), input_document: serializeSemanticDraft(submittedSemanticDocument) });
            syncQueuedReplyState();
          } else {
            acceptReplySubmission(requestId, message);
          }
          setReplySubmitLoading(false);
          traceDialog("reply_command_queued", { command_id: queuedCommandId, request_id: requestId, queue_mode: queueMode, composer_cleared: composerCleared });
          watchQueuedCommand(queuedCommandId, {
            applied: async (payload) => {
              pendingQueueCommands.delete(queuedCommandId);
              settlePendingIssueReply(requestId);
              if (!pendingQueueCommands.size && Array.isArray(payload?.queued_replies)) queuedReplies = payload.queued_replies;
              if (!dialog.isConnected) return;
              syncQueuedReplyState();
              await loadIssues({ background: true });
              if (payload?.initial_run) dialog.close();
              else await loadConversation({ quiet: true });
            },
            failed: async (error) => {
              pendingQueueCommands.delete(queuedCommandId);
              settlePendingIssueReply(requestId, true);
              optimisticReplies.delete(requestId);
              queuedReplies = queuedReplies.filter((item) => item.request_id !== requestId);
              reportUnexpectedError(error, { source: "reply_queue_settle", issue_id: issue.id, request_id: requestId, command_id: queuedCommandId });
              if (!dialog.isConnected) return;
              syncOptimisticReplies();
              syncQueuedReplyState();
              showConversationFailure(error, "reply", message, { origin: "command_queue", command_id: queuedCommandId });
            }
          });
          return;
        }
        if (!queueMode) acceptReplySubmission(requestId, message);
        setReplySubmitLoading(false);
        settlePendingIssueReply(requestId);
        traceDialog("reply_submit_confirmed", { request_id: lastReplyRequestId, initial_run: Boolean(reply.initial_run), composer_cleared: composerCleared });
        if (reply.initial_run) {
          try {
            await loadIssues();
            dialog.close();
          } catch (error) {
            reportGlobalError(error, { source: "reply_refresh", action: "initial_run", request_id: lastReplyRequestId });
            showError(error);
          }
          return;
        }
        await loadIssues().catch((error) => reportGlobalError(error, { source: "reply_refresh", action: "conversation", request_id: lastReplyRequestId }));
        applyConversation({ found: true, reply }, { preserveBody: true });
        conversationTimer = setTimeout(() => void loadConversation({ quiet: true }), 1500);
      }
      async function stopIssueFromDialog(button2) {
        if (!issue || !button2 || button2.disabled) return;
        const errorOutput = dialog.querySelector(".better-codex-dialog-error");
        button2.disabled = true;
        button2.dataset.composerMode = "stopping";
        button2.setAttribute("aria-busy", "true");
        button2.setAttribute("aria-label", t("正在停止…"));
        button2.title = t("正在停止…");
        button2.closest(".better-codex-composer")?.setAttribute("data-state", "stopping");
        try {
          const updated = await stopIssueSession(issue.id);
          refreshIssueState(updated);
        } catch (error) {
          if (errorOutput) {
            presentInlineError(errorOutput, error, errorLabel(error), { source: "issue_stop" });
          } else {
            reportUnexpectedError(error, { source: "issue_stop" });
          }
          if (button2.isConnected) {
            button2.disabled = false;
            button2.dataset.composerMode = "stop";
            button2.removeAttribute("aria-busy");
            button2.setAttribute("aria-label", t("停止任务"));
            button2.title = t("停止任务");
            button2.closest(".better-codex-composer")?.setAttribute("data-state", "stop");
          }
        }
      }
      async function restoreIssueFromDialog(button2) {
        if (!issue?.archived_at || !button2 || button2.disabled) return;
        const errorOutput = dialog.querySelector(".better-codex-dialog-error");
        button2.disabled = true;
        button2.setAttribute("aria-busy", "true");
        try {
          let current = issue;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              let updated = await api("/api/issues/" + encodeURIComponent(issue.id) + "/unarchive", { method: "POST", body: JSON.stringify({ version: Number(current.version) }) });
              const commandId = updated?.remote_state?.command_id;
              if (commandId) {
                const command = await waitForRemoteCommand(commandId);
                if (command.status !== "applied") throw new Error(command.error || "command_rejected");
                updated = await api("/api/issues/" + encodeURIComponent(issue.id));
              }
              refreshIssueState(updated);
              await Promise.all([loadIssues({ background: true }), loadProjects({ background: true })]);
              dialog.querySelector('[name="reply"]')?.focus();
              return;
            } catch (error) {
              if (attempt === 1 || !(error instanceof Error) || error.message !== "version_conflict") throw error;
              current = await api("/api/issues/" + encodeURIComponent(issue.id));
              refreshIssueState(current);
            }
          }
        } catch (error) {
          if (errorOutput) {
            presentInlineError(errorOutput, error, errorLabel(error), { source: "issue_restore" });
          } else {
            reportUnexpectedError(error, { source: "issue_restore" });
          }
          if (button2.isConnected) {
            button2.disabled = false;
            button2.removeAttribute("aria-busy");
          }
        }
      }
      function projectPicker() {
        const selectedProject = state.projects.find((item) => item.id === draft.projectId);
        const options = projectsByRecentActivity(state.projects).map((item) => '<button class="better-codex-project-option" type="button" data-dialog-project-option="' + escapeHtml2(item.id) + '">' + icon("folder") + "<span>" + escapeHtml2(projectLabel(item)) + '</span><span class="better-codex-project-check">' + (item.id === draft.projectId ? icon("check") : "") + "</span></button>").join("");
        return '<span class="better-codex-project-picker"><button class="better-codex-property" type="button" data-dialog-project>' + icon("folder") + "<span data-project-label>" + escapeHtml2(projectLabel(selectedProject) || t("选择项目")) + "</span>" + icon("chevron") + '</button><span class="better-codex-project-menu" hidden><input class="better-codex-project-search" type="search" placeholder="' + te("搜索项目...") + '" aria-label="' + te("搜索项目") + '"><span data-project-options>' + (options || '<span class="better-codex-project-empty">' + te("暂无项目") + "</span>") + "</span></span></span>";
      }
      function labelPicker() {
        const selected = draft.labels.split(/[,，]/).map((value) => value.trim()).filter(Boolean);
        const options = [.../* @__PURE__ */ new Set([...state.issues.flatMap((item) => Array.isArray(item.labels) ? item.labels : []), ...selected])].sort((left, right) => String(left).localeCompare(String(right), state.locale));
        const rows = options.map((value) => '<button class="better-codex-dialog-select-option' + (selected.includes(value) ? " is-selected" : "") + '" type="button" role="option" aria-selected="' + selected.includes(value) + '" data-dialog-label-option="' + escapeHtml2(value) + '"><span class="better-codex-dialog-select-option-visual">' + icon("tag") + "</span><span>" + escapeHtml2(value) + '</span><span class="better-codex-dialog-select-check">' + (selected.includes(value) ? icon("check") : "") + "</span></button>").join("");
        return '<span class="better-codex-label-picker" data-dialog-label-picker><button class="better-codex-property better-codex-label-trigger" type="button" aria-label="' + te("标签") + '" aria-haspopup="listbox" aria-expanded="false" data-dialog-label-toggle>' + icon("tag") + '</button><span class="better-codex-label-menu"><label class="better-codex-property better-codex-label-property">' + icon("tag") + '<input name="labels" value="' + escapeHtml2(draft.labels) + '" placeholder="' + te("添加标签") + '" aria-label="' + te("标签") + '"></label><span class="better-codex-label-options" role="listbox" aria-multiselectable="true">' + (rows || '<span class="better-codex-project-empty">' + te("暂无可选项") + "</span>") + "</span></span></span>";
      }
      function dialogSelect(name, ariaLabel, selected, options, modifier = "") {
        const current = options.find((option) => option.value === selected) || options[0] || { value: "", label: t("未提供"), visual: "" };
        const visual = (option) => typeof option.visual === "function" ? option.visual() : option.visual || "";
        const tagMarkup = (option) => (option.tags || []).map((tag) => '<span class="better-codex-dialog-select-tag" data-tone="' + escapeHtml2(tag.tone || "model") + '">' + escapeHtml2(tag.value) + (tag.fast ? fastMark() : "") + "</span>").join("");
        const labelMarkup = (option) => escapeHtml2(option.label) + tagMarkup(option);
        const rows = options.map((option) => '<button class="better-codex-dialog-select-option' + (option.value === current.value ? " is-selected" : "") + '" type="button" role="option" aria-selected="' + (option.value === current.value) + '" data-dialog-select-option="' + escapeHtml2(name) + '" data-dialog-select-value="' + escapeHtml2(option.value) + '"><span class="better-codex-dialog-select-option-visual">' + visual(option) + "</span><span>" + labelMarkup(option) + '</span><span class="better-codex-dialog-select-check">' + (option.value === current.value ? icon("check") : "") + "</span></button>").join("");
        return '<span class="better-codex-dialog-select ' + escapeHtml2(modifier) + '" data-dialog-select="' + escapeHtml2(name) + '"><input type="hidden" name="' + escapeHtml2(name) + '" value="' + escapeHtml2(current.value) + '"><button class="better-codex-property better-codex-dialog-select-trigger" type="button" role="combobox" aria-label="' + escapeHtml2(ariaLabel) + '" aria-haspopup="listbox" aria-expanded="false" data-dialog-select-toggle="' + escapeHtml2(name) + '"><span class="better-codex-dialog-select-trigger-visual">' + visual(current) + '</span><span class="better-codex-dialog-select-label" data-dialog-select-label>' + labelMarkup(current) + "</span>" + icon("chevron") + '</button><span class="better-codex-dialog-select-menu" role="listbox" hidden>' + rows + "</span></span>";
      }
      function assigneePicker() {
        const assignedUser = issue?.user_assigned ? issueUserProfile(issue) : null;
        const assignedUserValue = assignedUser ? "user:" + String(assignedUser.id || "default") : "";
        const userOptions = [
          ...state.users.filter((user) => !user.disabled).map((user) => ({ value: "user:" + String(user.id), label: user.name || user.handle || t("协作者"), visual: () => userAvatarMarkup(user, "better-codex-agent-avatar") })),
          ...assignedUserValue && !state.users.some((user) => "user:" + String(user.id) === assignedUserValue && !user.disabled) ? [{ value: assignedUserValue, label: assignedUser.name || t("已停用用户"), visual: () => userAvatarMarkup(assignedUser, "better-codex-agent-avatar") }] : []
        ];
        const options = [
          { value: "none", label: t("未指派"), visual: () => icon("user") },
          ...userOptions
        ];
        const availableSkills = (state.skillsManaged || []).filter(skill => skillAvailableForProject(skill, draft.projectId));
        if (draft.skillId && !availableSkills.some(skill => skill.id === draft.skillId)) draft.skillId = "";
        return '<div class="better-codex-agent-picker"><span>' + te("责任人") + "</span>" + dialogSelect("assignee", t("选择责任人"), draft.assignee || "none", options, "is-assignee") + '<span>' + te("Skill") + '</span>' + dialogSelect("skill_id", t("选择 Skill"), draft.skillId, [{ value: "", label: t("不使用 Skill"), visual: () => icon("sparkles") }, ...availableSkills.map((skill) => ({ value: skill.id, label: skill.name, visual: () => icon("sparkles") }))]) + "</div>";
      }
      function propertyRows() {
        const projectChip = projectPicker();
        if (draft.mode === "agent") return '<div class="better-codex-dialog-properties">' + projectChip + "</div>";
        const statuses = Object.entries(statusLabels).map(([value, text]) => ({ value, label: t(text), visual: statusIcon(value) }));
        const priorities = Object.entries(priorityLabels).map(([value, text]) => ({ value, label: t(value === "none" ? "无优先级" : text + "优先级"), visual: priorityIcon(value) }));
        return '<div class="better-codex-dialog-properties">' + dialogSelect("status", t("状态"), draft.status, statuses) + dialogSelect("priority", t("优先级"), draft.priority, priorities) + labelPicker() + projectChip + "</div>";
      }
      function attachmentPaths(items = draft.attachments) {
        return items.map((item) => item.path).filter(Boolean);
      }
      function releaseAttachment(item) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      function fileDataUrl(file) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取文件"));
          reader.onerror = () => reject(new Error("无法读取文件"));
          reader.readAsDataURL(file);
        });
      }
      async function remoteFiles(items) {
        return Promise.all(items.map(async (item) => ({ name: item.name, type: item.file.type || "application/octet-stream", data: await fileDataUrl(item.file) })));
      }
      async function cacheRemoteAttachments(items) {
        const pending = items.filter((item) => item.file && !item.path);
        if (!pending.length) return;
        const files = await remoteFiles(pending);
        const result = await api("/api/issues/attachments", { method: "POST", body: JSON.stringify({ files }), timeoutMs: 12e4 });
        if (!Array.isArray(result.attachments) || result.attachments.length !== pending.length) throw new Error("attachment_cache_invalid");
        pending.forEach((item, index) => {
          const saved = result.attachments[index];
          if (!saved || typeof saved.path !== "string" || !saved.path) throw new Error("attachment_cache_invalid");
          item.name = saved.name || item.name;
          item.path = saved.path;
          item.type = saved.type || item.type || item.file?.type || "";
          item.file = null;
        });
      }
      async function uploadPastedImages(items = draft.attachments) {
        for (const item of items) {
          if (!item.file) continue;
          const data = await fileDataUrl(item.file);
          let saved;
          try {
            saved = await api("/api/issues/attachments", { method: "POST", body: JSON.stringify({ data }) });
          } catch (error) {
            if (error instanceof Error && ["invalid_image_attachment", "body_too_large"].includes(error.message)) throw new Error("图片保存失败");
            throw error;
          }
          item.path = saved.path;
          item.file = null;
        }
      }
      function withAttachments(text, items = draft.attachments) {
        const paths = attachmentPaths(items);
        if (!paths.length) return text;
        const block = t("附带文件：") + "\n" + paths.map((path) => "- " + path).join("\n");
        return text ? text + "\n\n" + block : block;
      }
      function attachmentList(items = draft.attachments, scope = "issue") {
        const marker = scope === "reply" ? " data-reply-attachments" : " data-dialog-attachments";
        if (!items.length) return '<div class="better-codex-dialog-attachments"' + marker + " hidden></div>";
        const chips = items.map((item, index) => {
          const image = Boolean(item.previewUrl || String(item.type || item.file?.type || "").startsWith("image/"));
          const previewContent = item.previewUrl ? '<img class="better-codex-attachment-preview" src="' + escapeHtml2(item.previewUrl) + '" alt="" width="30" height="30">' : icon("image");
          const preview = image && (item.previewUrl || item.path) ? '<button class="better-codex-attachment-preview-button" type="button" data-dialog-preview="' + index + '" data-dialog-attachment-scope="' + scope + '" aria-label="' + te("预览附件") + " " + escapeHtml2(item.name) + '">' + previewContent + "</button>" : icon(image ? "image" : "paperclip");
          return '<span class="better-codex-attachment-chip' + (image ? " is-image" : "") + '" title="' + escapeHtml2(item.path || item.name) + '">' + preview + "<span>" + escapeHtml2(item.name) + '</span><button type="button" data-dialog-detach="' + index + '" data-dialog-attachment-scope="' + scope + '" aria-label="' + te("移除附件") + '">' + icon("close") + "</button></span>";
        }).join("");
        return '<div class="better-codex-dialog-attachments"' + marker + ">" + chips + "</div>";
      }
      async function pasteImages(event) {
        const replyPaste = event.target?.matches?.('[name="reply"]');
        if (editingLocked && !replyPaste) return;
        const files = Array.from(event.clipboardData?.items || []).flatMap((item) => item.kind === "file" && item.type.startsWith("image/") ? [item.getAsFile()].filter(Boolean) : []);
        if (!files.length) return;
        const activeName = event.target?.getAttribute("name") || "";
        const selectionStart = event.target?.selectionStart;
        const selectionEnd = event.target?.selectionEnd;
        event.preventDefault();
        const attachments = replyPaste ? draft.replyAttachments : draft.attachments;
        let totalSize = attachments.reduce((size, item) => size + (item.file?.size || 0), 0);
        let acceptedCount = 0;
        const accepted = files.filter((file) => {
          if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return false;
          if (file.size > 10 * 1024 * 1024) return false;
          if (REMOTE && (attachments.length + acceptedCount >= 4 || totalSize + file.size > 20 * 1024 * 1024)) return false;
          totalSize += file.size;
          acceptedCount += 1;
          return true;
        });
        if (!accepted.length) {
          const errorOutput = dialog.querySelector(".better-codex-dialog-error");
          if (errorOutput) {
            const message = REMOTE && attachments.length >= 4 ? "最多传输 4 个文件且总大小不能超过 20 MB" : files.some((file) => file.size > 10 * 1024 * 1024) ? "图片不能超过 10 MB" : "请选择 PNG、JPEG 或 WebP 图片";
            presentInlineError(errorOutput, new Error(message), t(message), { source: "attachment_paste", action: replyPaste ? "reply" : issue ? "edit" : "create", report: false });
          }
          return;
        }
        syncDraft();
        const next = accepted.map((file, index) => ({
          name: file.name || t("粘贴的图片") + (accepted.length > 1 ? " " + (index + 1) : ""),
          path: "",
          file,
          type: file.type,
          previewUrl: URL.createObjectURL(file)
        }));
        try {
          if (RELAY) await cacheRemoteAttachments(next);
          else if (!REMOTE) await uploadPastedImages(next);
        } catch (error) {
          next.forEach(releaseAttachment);
          const errorOutput = dialog.querySelector(".better-codex-dialog-error");
          if (errorOutput) presentInlineError(errorOutput, error, t(error instanceof Error ? error.message : "图片保存失败"), { source: "attachment_cache", action: replyPaste ? "reply" : issue ? "edit" : "create", report: false });
          return;
        }
        attachments.push(...next);
        if (replyPaste) scheduleReplyDraft(draft.reply);
        else if (!issue) writeCreateDraft(draft, createRequestId);
        renderDialog();
        const active2 = activeName ? dialog.querySelector('[name="' + activeName + '"]') : null;
        active2?.focus();
        if (active2?.setSelectionRange && Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) active2.setSelectionRange(selectionStart, selectionEnd);
      }
      function pickAttachments(existing = []) {
        return new Promise((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "*/*";
          input.multiple = true;
          input.addEventListener("change", () => {
            const files = Array.from(input.files || []);
            const selected = [];
            let skipped = 0;
            let totalSize = existing.reduce((size, item) => size + (item.file?.size || 0), 0);
            for (const file of files) {
              const path = String(file.path || "").trim();
              if (!path && !REMOTE) {
                skipped += 1;
                continue;
              }
              if (file.size > 10 * 1024 * 1024) {
                skipped += 1;
                continue;
              }
              if (REMOTE && (existing.length + selected.length >= 4 || totalSize + file.size > 20 * 1024 * 1024)) {
                skipped += 1;
                continue;
              }
              const image = file.type.startsWith("image/");
              selected.push({ name: file.name || path.split(/[\\/]/).pop() || path || t("附件"), path, type: file.type || "", file: REMOTE || image ? file : null, previewUrl: image ? URL.createObjectURL(file) : "" });
              totalSize += file.size;
            }
            resolve({ files: selected, skipped, picked: files.length });
          }, { once: true });
          input.addEventListener("cancel", () => resolve({ files: [], skipped: 0, picked: 0 }), { once: true });
          input.click();
        });
      }
      function footer() {
        if (issue?.archived_at || executionLocked) return "";
        const switchButton = "";
        const submitText = issue ? "保存" : "创建并打开会话";
        const keepOpen = "";
        return '<div class="better-codex-dialog-footer"><button class="better-codex-icon-button" type="button" data-dialog-attach aria-label="' + te("添加附件") + '">' + icon("paperclip") + '</button><div class="better-codex-dialog-footer-right">' + switchButton + keepOpen + '<button class="better-codex-submit" type="submit">' + te(submitText) + "</button></div></div>";
      }
      function updateDescriptionDisclosure() {
        const editor = dialog.querySelector('[name="description"]');
        const toggle = dialog.querySelector("[data-description-toggle]");
        if (!editor || !toggle) return;
        const hasOverflow = editor.scrollHeight > editor.clientHeight;
        toggle.hidden = !hasOverflow && !draft.descriptionExpanded;
        toggle.setAttribute("aria-expanded", String(draft.descriptionExpanded));
        toggle.textContent = te(draft.descriptionExpanded ? "收起描述" : "展开描述");
      }
      function renderDialog() {
        if (projectDismiss) document.removeEventListener("pointerdown", projectDismiss, true);
        if (selectDismiss) document.removeEventListener("pointerdown", selectDismiss, true);
        projectDismiss = null;
        selectDismiss = null;
        stopConversationPoll();
        dialog.dataset.mode = draft.mode;
        dialog.dataset.detail = issue ? "true" : "false";
        dialog.dataset.issueId = issue?.id || "";
        dialog.dataset.executionRunning = String(executionRunning);
        dialog.dataset.executionLocked = String(executionLocked);
        dialog.dataset.expanded = String(draft.expanded);
        dialog.dataset.descriptionExpanded = String(draft.descriptionExpanded);
        dialog.dataset.conversationExpanded = String(draft.conversationExpanded);
        dialog.dataset.locked = String(editingLocked);
        if (issue) {
          const descriptionEditor = '<div class="better-codex-description-field"><textarea class="better-codex-dialog-editor" name="description" placeholder="' + te("添加描述...") + '" rows="3">' + escapeHtml2(draft.description) + '</textarea><button class="better-codex-description-toggle" type="button" data-description-toggle hidden></button></div>';
          dialog.innerHTML = "<form>" + header() + assigneePicker() + '<input class="better-codex-manual-title" name="title" maxlength="500" placeholder="' + te("任务标题") + '" value="' + escapeHtml2(draft.title) + '">' + descriptionEditor + issuePlanDetailMarkup(issue) + propertyRows() + attachmentList() + '<div class="better-codex-dialog-error" hidden></div>' + footer() + "</form>";
        } else {
          dialog.innerHTML = "<form>" + header() + assigneePicker() + '<input class="better-codex-manual-title" name="title" maxlength="500" placeholder="' + te("任务标题") + '" value="' + escapeHtml2(draft.title) + '"><textarea class="better-codex-dialog-editor" name="description" placeholder="' + te("添加描述...") + '">' + escapeHtml2(draft.description) + "</textarea>" + propertyRows() + attachmentList() + '<div class="better-codex-dialog-error" hidden></div>' + footer() + "</form>";
        }
        const content = dialog.querySelector(draft.mode === "agent" ? '[name="prompt"]' : '[name="title"]');
        dialog.querySelector("form")?.addEventListener("pointerdown", (event) => {
          const compactAgentCreate = HOST_KIND === "web" && window.matchMedia("(max-width: 720px)").matches && !issue && draft.mode === "agent";
          if (!compactAgentCreate || document.activeElement !== content) return;
          const target = event.target;
          if (target.closest("[data-dialog-close], textarea, [contenteditable='true'], input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='number'], input[type='password']")) return;
          event.preventDefault();
        }, true);
        applyDialogPermissions();
        syncQueuedReplyState();
        const syncLabelOptions = () => {
          const selected = new Set(String(dialog.querySelector('[name="labels"]')?.value || "").split(/[,，]/).map((value) => value.trim()).filter(Boolean));
          dialog.querySelectorAll("[data-dialog-label-option]").forEach((option) => {
            const active2 = selected.has(option.dataset.dialogLabelOption);
            option.classList.toggle("is-selected", active2);
            option.setAttribute("aria-selected", String(active2));
            option.querySelector(".better-codex-dialog-select-check").innerHTML = active2 ? icon("check") : "";
          });
        };
        content?.addEventListener("input", () => {
          content.removeAttribute("aria-invalid");
          dirtyDraftFields.add(draft.mode === "agent" ? "prompt" : "title");
          if (!issue && draft.mode === "agent") {
            draft.prompt = content.value;
            const previous2 = draft.promptSemanticDocument;
            draft.promptSemanticDocument = reconcileSemanticText(previous2, content.value);
            if (!previous2.degraded && draft.promptSemanticDocument.degraded) appendDiagnostic("semantic_reference_degraded", { editor: "prompt", project_id: draft.projectId || "" });
            syncSemanticWarning();
            syncSemanticMenu();
          }
          updateSubmitState();
        });
        if (!issue && draft.mode === "agent") {
          content?.addEventListener("focus", () => {
            syncSemanticMenu();
          });
          content?.addEventListener("blur", () => {
            setTimeout(() => {
              if (!dialog.querySelector("[data-semantic-menu]:hover")) closeSemanticMenu();
            }, 120);
          });
          content?.addEventListener("keydown", (event) => {
            if (handleSemanticMenuKeydown(event)) event.stopPropagation();
          });
        }
        dialog.querySelectorAll('[name="description"], [name="labels"]').forEach((control) => control.addEventListener("input", () => {
          dirtyDraftFields.add(control.getAttribute("name"));
          if (control.matches('[name="labels"]')) {
            draft.labels = control.value;
            syncLabelOptions();
          }
          requestAnimationFrame(updateDescriptionDisclosure);
        }));
        requestAnimationFrame(updateDescriptionDisclosure);
        dialog.querySelector("[data-description-toggle]")?.addEventListener("click", () => {
          draft.descriptionExpanded = !draft.descriptionExpanded;
          dialog.dataset.descriptionExpanded = String(draft.descriptionExpanded);
          updateDescriptionDisclosure();
        });
        dialog.querySelector('[name="keep"]')?.addEventListener("change", (event) => {
          state.keepCreate = event.currentTarget.checked;
          localStorage.setItem(KEEP_CREATE_KEY, String(state.keepCreate));
        });
        const replyInput = dialog.querySelector('[name="reply"]');
        const sendButton = dialog.querySelector("[data-conversation-send]");
        const queue = dialog.querySelector("[data-conversation-queue]");
        queue?.addEventListener("input", (event) => {
          if (!event.target.matches("[data-queue-edit-input]")) return;
          queueEditDraft = event.target.value;
          queueEditSemanticDocument = reconcileSemanticText(queueEditSemanticDocument || createSemanticDraft(queueEditDraft), queueEditDraft);
          const warning = queue.querySelector("[data-queue-edit-warning]");
          if (warning) warning.hidden = !queueEditSemanticDocument.degraded;
          const save = queue.querySelector("[data-queue-edit-save]");
          if (save) save.disabled = !queueEditDraft.trim() || Boolean(queueActionRequestId);
        });
        queue?.addEventListener("keydown", (event) => {
          if (!event.target.matches("[data-queue-edit-input]")) return;
          if (event.key === "Escape") {
            event.preventDefault();
            queueEditingRequestId = "";
            queueEditDraft = "";
            queueEditSemanticDocument = null;
            queueActionError = "";
            syncQueuedReplyState();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void updateQueuedReply("update", queueEditingRequestId);
          }
        });
        queue?.addEventListener("click", (event) => {
          const sendNow = event.target.closest("[data-queue-send-now]");
          if (sendNow) {
            void updateQueuedReply("send", sendNow.dataset.queueSendNow);
            return;
          }
          const edit = event.target.closest("[data-queue-edit]");
          if (edit) {
            const item = queuedReplies.find((entry2) => entry2.request_id === edit.dataset.queueEdit);
            if (!item) return;
            queueEditingRequestId = item.request_id;
            queueEditDraft = item.message || "";
            queueEditSemanticDocument = createSemanticDraft(queueEditDraft, item.input_document);
            queueActionError = "";
            syncQueuedReplyState();
            requestAnimationFrame(() => {
              const input = queue.querySelector("[data-queue-edit-input]");
              input?.focus();
              input?.setSelectionRange?.(input.value.length, input.value.length);
            });
            return;
          }
          const remove = event.target.closest("[data-queue-delete]");
          if (remove) {
            void updateQueuedReply("delete", remove.dataset.queueDelete);
            return;
          }
          if (event.target.closest("[data-queue-edit-cancel]")) {
            queueEditingRequestId = "";
            queueEditDraft = "";
            queueEditSemanticDocument = null;
            queueActionError = "";
            syncQueuedReplyState();
            return;
          }
          const save = event.target.closest("[data-queue-edit-save]");
          if (save) void updateQueuedReply("update", save.dataset.queueEditSave);
        });
        replyInput?.addEventListener("input", () => {
          draft.reply = replyInput.value;
          const previous2 = draft.replySemanticDocument;
          draft.replySemanticDocument = reconcileSemanticText(previous2, replyInput.value);
          if (!previous2.degraded && draft.replySemanticDocument.degraded) appendDiagnostic("semantic_reference_degraded", { editor: "reply", issue_id: issue?.id || "" });
          syncSemanticWarning();
          scheduleReplyDraft(replyInput.value);
          updateReplySendState();
          syncSemanticMenu();
        });
        replyInput?.addEventListener("focus", () => {
          syncSemanticMenu();
        });
        replyInput?.addEventListener("blur", () => {
          flushReplyDraft();
          setTimeout(() => {
            if (!dialog.querySelector("[data-semantic-menu]:hover")) closeSemanticMenu();
          }, 120);
        });
        dialog.querySelector("[data-semantic-menu]")?.addEventListener("pointerdown", (event) => event.preventDefault());
        dialog.querySelector("[data-semantic-menu]")?.addEventListener("click", (event) => {
          const option = event.target.closest("[data-semantic-option]");
          if (!option) return;
          selectSemanticOption(Number(option.dataset.semanticOption));
          semanticEditor()?.focus();
        });
        sendButton?.addEventListener("click", (event) => {
          const button2 = event.currentTarget;
          if (button2.dataset.composerMode === "stop") void stopIssueFromDialog(button2);
          else if (["send", "queue"].includes(button2.dataset.composerMode)) void sendReply();
        });
        dialog.querySelector("[data-conversation-body]")?.addEventListener("toggle", (event) => {
          const details = event.target?.closest?.(".better-codex-thinking-card");
          if (!details) return;
          const id = details.dataset.thinkingId;
          if (id) {
            if (details.open) expandedThinkingCards.add(id);
            else expandedThinkingCards.delete(id);
          }
        }, true);
        dialog.querySelector("[data-conversation-body]")?.addEventListener("click", async (event) => {
          const attachmentButton = event.target.closest("[data-conversation-attachment]");
          if (attachmentButton) {
            await openConversationAttachment(Number(attachmentButton.dataset.conversationAttachmentMessage), Number(attachmentButton.dataset.conversationAttachment));
            return;
          }
          const button2 = event.target.closest("[data-conversation-copy]");
          if (!button2) return;
          const message = conversationMessages[Number(button2.dataset.conversationCopy)];
          const visibleContent = button2.closest(".better-codex-bubble")?.querySelector(".better-codex-bubble-content")?.innerText || "";
          const content2 = typeof message?.markdown === "string" && message.markdown ? message.markdown : visibleContent;
          if (!content2) return;
          await copyText(content2);
          button2.classList.add("is-copied");
          button2.innerHTML = icon("check");
          button2.setAttribute("aria-label", t("已复制"));
          button2.setAttribute("title", t("已复制"));
          setTimeout(() => {
            if (!button2.isConnected) return;
            button2.classList.remove("is-copied");
            button2.innerHTML = icon("copy");
            button2.setAttribute("aria-label", t("复制消息"));
            button2.setAttribute("title", t("复制消息"));
          }, 1600);
        });
        dialog.querySelector("[data-conversation-attach]")?.addEventListener("click", () => {
          void pickAttachments(draft.replyAttachments).then(async (result) => {
            const errorOutput = dialog.querySelector(".better-codex-dialog-error");
            const showAttachError = (message) => {
              if (!errorOutput) return;
              presentInlineError(errorOutput, new Error(message), t(message), { source: "attachment_picker", action: "reply", report: false });
            };
            if (!result.picked) return;
            if (!result.files.length) return showAttachError(REMOTE ? "最多传输 4 个文件且总大小不能超过 20 MB" : "当前环境无法读取本地文件路径");
            const known = new Set(draft.replyAttachments.map((file) => file.path || file.name + ":" + (file.file?.size || 0)));
            const next = result.files.filter((file) => !known.has(file.path || file.name + ":" + (file.file?.size || 0)));
            if (next.length) {
              try {
                if (RELAY) await cacheRemoteAttachments(next);
                else if (!REMOTE) await uploadPastedImages(next);
                syncDraft();
                draft.replyAttachments.push(...next);
                scheduleReplyDraft(draft.reply);
                renderDialog();
              } catch (error) {
                next.forEach(releaseAttachment);
                return showAttachError(error instanceof Error ? error.message : "附件缓存失败");
              }
            }
            if (result.skipped) showAttachError(REMOTE ? "部分文件超出传输限制，已跳过" : "部分文件无法读取本地路径，已跳过");
            dialog.querySelector('[name="reply"]')?.focus();
          });
        });
        replyInput?.addEventListener("keydown", (event) => {
          if (handleSemanticMenuKeydown(event)) return;
          if (isSendKeyboardEvent(event)) {
            event.preventDefault();
            if (["send", "queue"].includes(sendButton?.dataset.composerMode || "")) void sendReply();
          }
        });
        if (issue && dialog.open && (sessionId || issueConversationRunning(issue) || issueConversationFailed())) void loadConversation();
        const closeDialogSelects = () => {
          dialog.querySelectorAll("[data-dialog-select]").forEach((picker) => {
            picker.classList.remove("is-open");
            picker.querySelector("[data-dialog-select-toggle]")?.setAttribute("aria-expanded", "false");
            const menu = picker.querySelector(".better-codex-dialog-select-menu");
            if (menu) menu.hidden = true;
          });
          dialog.querySelectorAll("[data-dialog-label-picker]").forEach((picker) => {
            picker.classList.remove("is-open");
            picker.querySelector("[data-dialog-label-toggle]")?.setAttribute("aria-expanded", "false");
          });
          if (selectDismiss) document.removeEventListener("pointerdown", selectDismiss, true);
          selectDismiss = null;
        };
        dialog.querySelectorAll("[data-dialog-select-toggle]").forEach((toggle) => toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          const picker = toggle.closest("[data-dialog-select]");
          const opening = !picker.classList.contains("is-open");
          closeDialogSelects();
          if (!opening) return;
          picker.classList.add("is-open");
          toggle.setAttribute("aria-expanded", "true");
          picker.querySelector(".better-codex-dialog-select-menu").hidden = false;
          selectDismiss = (dismissEvent) => {
            if (picker.contains(dismissEvent.target)) return;
            closeDialogSelects();
          };
          setTimeout(() => document.addEventListener("pointerdown", selectDismiss, true), 0);
        }));
        dialog.querySelectorAll("[data-dialog-label-toggle]").forEach((toggle) => toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          const picker = toggle.closest("[data-dialog-label-picker]");
          const opening = !picker.classList.contains("is-open");
          closeDialogSelects();
          if (!opening) return;
          picker.classList.add("is-open");
          toggle.setAttribute("aria-expanded", "true");
          selectDismiss = (dismissEvent) => {
            if (picker.contains(dismissEvent.target)) return;
            closeDialogSelects();
          };
          setTimeout(() => document.addEventListener("pointerdown", selectDismiss, true), 0);
        }));
        dialog.querySelectorAll("[data-dialog-label-option]").forEach((option) => option.addEventListener("click", (event) => {
          event.stopPropagation();
          const picker = option.closest("[data-dialog-label-picker]");
          const input = picker.querySelector('[name="labels"]');
          const labels = new Set(String(input.value || "").split(/[,，]/).map((value2) => value2.trim()).filter(Boolean));
          const value = option.dataset.dialogLabelOption;
          if (labels.has(value)) labels.delete(value);
          else labels.add(value);
          input.value = [...labels].join(", ");
          draft.labels = input.value;
          dirtyDraftFields.add("labels");
          syncLabelOptions();
          updateSubmitState();
        }));
        dialog.querySelectorAll("[data-dialog-select-option]").forEach((option) => option.addEventListener("click", (event) => {
          event.stopPropagation();
          const picker = option.closest("[data-dialog-select]");
          const name = option.dataset.dialogSelectOption;
          const value = option.dataset.dialogSelectValue;
          picker.querySelector('input[type="hidden"]').value = value;
          picker.querySelector("[data-dialog-select-label]").innerHTML = option.querySelector(":scope > span:nth-child(2)").innerHTML;
          picker.querySelector(".better-codex-dialog-select-trigger-visual").innerHTML = option.querySelector(".better-codex-dialog-select-option-visual").innerHTML;
          picker.querySelectorAll("[data-dialog-select-option]").forEach((item) => {
            const selected = item === option;
            item.classList.toggle("is-selected", selected);
            item.setAttribute("aria-selected", String(selected));
            item.querySelector(".better-codex-dialog-select-check").innerHTML = selected ? icon("check") : "";
          });
          if (name === "status") {
            draft.status = value;
            dirtyDraftFields.add(name);
          }
          if (name === "mockup_run_status") {
            draft.runStatus = value;
            dirtyDraftFields.add(name);
          }
          if (name === "priority") {
            draft.priority = value;
            dirtyDraftFields.add(name);
          }
          if (name === "assignee") {
            draft.assignee = value;
            dirtyDraftFields.add(name);
          }
          if (name === "skill_id") {
            draft.skillId = value;
            dirtyDraftFields.add(name);
          }
          if (completedIssue) {
            if (name === "status") persistCompletedIssuePatch({ status: value });
            if (name === "priority") persistCompletedIssuePatch({ priority: value });
            if (name === "assignee") persistCompletedIssuePatch(value.startsWith("user:") ? { user_assigned: true, assignee_user_id: REMOTE && value.slice(5) !== "default" ? value.slice(5) : null, agent_enabled: false, agent_id: "" } : value === "none" ? { user_assigned: false, assignee_user_id: null, agent_enabled: false, agent_id: "" } : { user_assigned: false, assignee_user_id: null, agent_enabled: true, agent_id: value === "codex" ? "" : value });
          }
          if (name === "agent_id") {
            draft.agentId = value;
            dirtyDraftFields.add(name);
            const selectedAgent = state.agents.find((agent) => agent.id === draft.agentId);
            const selectedName = selectedAgent?.name || "Codex";
            const runAvatar = dialog.querySelector(".better-codex-run-hint .better-codex-agent-avatar");
            syncAgentAvatar(runAvatar, selectedAgent);
            const hint = dialog.querySelector(".better-codex-run-hint span:last-child");
            if (hint) hint.textContent = t("创建后由 " + selectedName + " 立即开始工作，同时在后台生成 Issue 标题。");
          }
          closeDialogSelects();
          if (name === "assignee" && draft.mode === "agent") {
            syncDraft();
            renderDialog();
            return;
          }
          updateSubmitState();
          picker.querySelector("[data-dialog-select-toggle]")?.focus();
        }));
        const projectButton = dialog.querySelector("[data-dialog-project]");
        const projectMenu = dialog.querySelector(".better-codex-project-menu");
        const projectSearch = dialog.querySelector(".better-codex-project-search");
        const positionProjectMenu = () => {
          if (HOST_KIND === "web" && window.matchMedia("(max-width: 720px)").matches) {
            projectMenu.classList.remove("is-above");
            projectMenu.style.removeProperty("max-height");
            projectMenu.querySelector("[data-project-options]").style.removeProperty("max-height");
            return;
          }
          const viewportTop = window.visualViewport?.offsetTop || 0;
          const viewportBottom = viewportTop + (window.visualViewport?.height || window.innerHeight);
          const buttonRect = projectButton.getBoundingClientRect();
          const spaceAbove = Math.max(0, buttonRect.top - viewportTop - 12);
          const spaceBelow = Math.max(0, viewportBottom - buttonRect.bottom - 12);
          const openAbove = spaceAbove > spaceBelow;
          const availableHeight = Math.min(320, openAbove ? spaceAbove : spaceBelow);
          projectMenu.classList.toggle("is-above", openAbove);
          projectMenu.style.maxHeight = Math.floor(availableHeight) + "px";
          projectMenu.querySelector("[data-project-options]").style.maxHeight = Math.max(0, Math.floor(availableHeight) - 44) + "px";
        };
        projectButton?.addEventListener("click", (event) => {
          event.stopPropagation();
          projectMenu.hidden = !projectMenu.hidden;
          if (projectMenu.hidden) {
            if (projectDismiss) document.removeEventListener("pointerdown", projectDismiss, true);
            projectDismiss = null;
            return;
          }
          projectSearch.value = "";
          projectMenu.querySelectorAll("[data-dialog-project-option]").forEach((option) => {
            option.hidden = false;
          });
          positionProjectMenu();
          if (!(HOST_KIND === "web" && window.matchMedia("(max-width: 720px)").matches)) projectSearch.focus();
          projectDismiss = (dismissEvent) => {
            if (projectMenu.contains(dismissEvent.target) || projectButton.contains(dismissEvent.target)) return;
            projectMenu.hidden = true;
            document.removeEventListener("pointerdown", projectDismiss, true);
            projectDismiss = null;
          };
          setTimeout(() => document.addEventListener("pointerdown", projectDismiss, true), 0);
        });
        projectSearch?.addEventListener("input", () => {
          const query = label(projectSearch.value);
          projectMenu.querySelectorAll("[data-dialog-project-option]").forEach((option) => {
            option.hidden = Boolean(query) && !label(option.textContent).includes(query);
          });
        });
        dialog.querySelectorAll("[data-dialog-project-option]").forEach((option) => option.addEventListener("click", (event) => {
          event.stopPropagation();
          draft.projectId = option.dataset.dialogProjectOption;
          dirtyDraftFields.add("project_id");
          semanticCatalog = null;
          closeSemanticMenu();
          const selectedProject = state.projects.find((item) => item.id === draft.projectId);
          syncDraft();
          if (draft.skillId && !(state.skillsManaged || []).some(skill => skill.id === draft.skillId && skillAvailableForProject(skill, draft.projectId))) draft.skillId = "";
          const skillPicker = dialog.querySelector(".better-codex-agent-picker");
          if (skillPicker) { skillPicker.outerHTML = assigneePicker(); renderDialog(); return; }
          dialog.querySelector("[data-project-label]").textContent = projectLabel(selectedProject) || t("选择项目");
          const breadcrumbProject = dialog.querySelector("[data-dialog-breadcrumb-project]");
          if (breadcrumbProject) breadcrumbProject.textContent = projectLabel(selectedProject) || t("未提供");
          dialog.querySelectorAll("[data-dialog-project-option]").forEach((item) => {
            item.querySelector(".better-codex-project-check").innerHTML = item.dataset.dialogProjectOption === draft.projectId ? icon("check") : "";
          });
          projectMenu.hidden = true;
          if (projectDismiss) document.removeEventListener("pointerdown", projectDismiss, true);
          projectDismiss = null;
        }));
        dialog.querySelector("[data-dialog-close]")?.addEventListener("click", () => dialog.close());
        dialog.querySelector("[data-conversation-expand]")?.addEventListener("click", () => setConversationExpanded(!draft.conversationExpanded));
        const handleDialogOpenThread = (event) => {
          const button2 = event.currentTarget;
          const threadId = normalizeSessionId(event.currentTarget.dataset.dialogOpenThread);
          if (!threadId || button2.disabled) return;
          const errorOutput = dialog.querySelector(".better-codex-dialog-error");
          const idleLabel = button2.textContent || t("打开完整会话");
          button2.disabled = true;
          button2.classList.add("is-loading");
          button2.setAttribute("aria-busy", "true");
          button2.innerHTML = icon("refresh") + "<span>" + te("正在打开…") + "</span>";
          clearError();
          void (async () => {
            try {
              const opened = await openThread(threadId);
              if (opened.opened) dialog.close();
            } catch (error) {
              showError(error);
              if (errorOutput) {
                errorOutput.textContent = errorLabel(error);
                errorOutput.hidden = false;
              }
            } finally {
              if (button2.isConnected) {
                button2.disabled = false;
                button2.classList.remove("is-loading");
                button2.removeAttribute("aria-busy");
                button2.textContent = idleLabel;
              }
            }
          })();
        };
        dialog.querySelectorAll("[data-dialog-open-thread]").forEach((button2) => button2.addEventListener("click", handleDialogOpenThread));
        dialog.querySelectorAll("[data-dialog-open-native]").forEach((button2) => button2.addEventListener("click", () => {
          button2.disabled = true;
          void perform(async () => {
            const selected = state.issues.find((candidate) => candidate.id === button2.dataset.dialogOpenNative) || issue;
            dialog.close();
            await openIssueNativeConversation(selected);
          });
        }));
        dialog.querySelector("[data-dialog-new-native]")?.addEventListener("click", () => {
          void perform(async () => {
            dialog.close();
            await createIssueNativeConversation(issue);
          });
        });
        dialog.querySelectorAll("[data-dialog-stop]").forEach((button2) => button2.addEventListener("click", (event) => void stopIssueFromDialog(event.currentTarget)));
        dialog.querySelector("[data-dialog-restore]")?.addEventListener("click", (event) => void restoreIssueFromDialog(event.currentTarget));
        const startNow = dialog.querySelector("[data-dialog-start-now]");
        startNow?.addEventListener("click", () => {
          syncDraft();
          void startIssueNow();
        });
        const setDialogExpanded = (expanded) => {
          draft.expanded = expanded;
          localStorage.setItem(issue ? ISSUE_DIALOG_EXPANDED_KEY : CREATE_DIALOG_EXPANDED_KEY, String(draft.expanded));
          if (issue && draft.expanded) syncIssueFullscreenBounds();
          dialog.dataset.expanded = String(draft.expanded);
          if (issue && !draft.expanded) clearIssueFullscreenBounds();
          const button2 = dialog.querySelector("[data-dialog-expand]");
          button2?.setAttribute("aria-label", t(draft.expanded ? issue ? "退出全屏" : "缩小" : "展开"));
          if (button2) button2.innerHTML = icon(draft.expanded ? "shrink" : "expand");
        };
        dialog.querySelector("[data-dialog-expand]")?.addEventListener("click", () => {
          setDialogExpanded(!draft.expanded);
        });
        dialog.querySelector("[data-dialog-attach]")?.addEventListener("click", () => {
          void pickAttachments(draft.attachments).then(async (result) => {
            const showAttachError = (message) => {
              const errorOutput = dialog.querySelector(".better-codex-dialog-error");
              if (!errorOutput) return;
              presentInlineError(errorOutput, new Error(message), t(message), { source: "attachment_picker", action: issue ? "edit" : "create", report: false });
            };
            if (!result.picked) return;
            if (!result.files.length) return showAttachError(REMOTE ? "最多传输 4 个文件且总大小不能超过 20 MB" : "当前环境无法读取本地文件路径");
            const known = new Set(draft.attachments.map((file) => file.path || file.name + ":" + (file.file?.size || 0)));
            const next = result.files.filter((file) => !known.has(file.path || file.name + ":" + (file.file?.size || 0)));
            if (next.length) {
              try {
                if (RELAY) await cacheRemoteAttachments(next);
                else if (!REMOTE) await uploadPastedImages(next);
                syncDraft();
                draft.attachments.push(...next);
                if (!issue) writeCreateDraft(draft, createRequestId);
                renderDialog();
              } catch (error) {
                next.forEach(releaseAttachment);
                return showAttachError(error instanceof Error ? error.message : "附件缓存失败");
              }
            }
            if (result.skipped) showAttachError(REMOTE ? "部分文件超出传输限制，已跳过" : "部分文件无法读取本地路径，已跳过");
            dialog.querySelector(draft.mode === "agent" ? '[name="prompt"]' : '[name="title"]')?.focus();
          });
        });
        dialog.querySelectorAll("[data-dialog-detach]").forEach((button2) => button2.addEventListener("click", (event) => {
          event.preventDefault();
          const index = Number(button2.dataset.dialogDetach);
          if (!Number.isInteger(index) || index < 0) return;
          syncDraft();
          const scope = button2.dataset.dialogAttachmentScope;
          const attachments = scope === "reply" ? draft.replyAttachments : draft.attachments;
          const [removed] = attachments.splice(index, 1);
          if (removed) releaseAttachment(removed);
          if (scope === "reply") scheduleReplyDraft(draft.reply);
          else if (!issue) writeCreateDraft(draft, createRequestId);
          renderDialog();
          dialog.querySelector(scope === "reply" ? '[name="reply"]' : draft.mode === "agent" ? '[name="prompt"]' : '[name="title"]')?.focus();
        }));
        dialog.querySelectorAll("[data-dialog-preview]").forEach((button2) => button2.addEventListener("click", () => {
          const index = Number(button2.dataset.dialogPreview);
          if (!Number.isInteger(index) || index < 0) return;
          void openDraftAttachment(button2.dataset.dialogAttachmentScope, index);
        }));
        dialog.querySelector("form")?.addEventListener("paste", pasteImages);
        dialog.querySelector("form")?.addEventListener("keydown", (event) => {
          if (event.target?.matches?.('[name="reply"]')) return;
          if (isSendKeyboardEvent(event)) {
            event.preventDefault();
            dialog.querySelector("form")?.requestSubmit();
          }
        });
        dialog.querySelector("form")?.addEventListener("submit", (event) => {
          event.preventDefault();
          syncDraft();
          void submitIssue();
        });
      }
      async function submitIssue() {
        if (editingLocked || submitInFlight) return;
        const submit = dialog.querySelector(".better-codex-submit");
        const errorOutput = dialog.querySelector(".better-codex-dialog-error");
        if (!submit || !errorOutput) return;
        const prompt = draft.prompt.trim();
        const title = draft.mode === "agent" ? prompt.split(/\n/).find((line) => line.trim())?.replace(/^[#*\s-]+/, "").trim().slice(0, 120) || "" : draft.title.trim();
        if (!title) return;
        const description = draft.mode === "agent" ? prompt : draft.description;
        if (description.length > state.issueDescriptionLimit) {
          const editor = dialog.querySelector(draft.mode === "agent" ? '[name="prompt"]' : '[name="description"]');
          errorOutput.textContent = state.locale === "zh-CN" ? "内容长度 " + description.length + "，超过 " + state.issueDescriptionLimit + " 的限制。请缩短内容或作为附件上传。" : "Content length is " + description.length + ", above the " + state.issueDescriptionLimit + " limit. Shorten it or upload it as an attachment.";
          errorOutput.hidden = false;
          editor?.setAttribute("aria-invalid", "true");
          editor?.focus();
          return;
        }
        submitInFlight = true;
        submit.disabled = true;
        errorOutput.hidden = true;
        traceDialog("dialog_submit_start", { action: issue ? "update_issue" : "create_issue" });
        try {
          const humanAssignee = draft.assignee.startsWith("user:");
          const assignee = humanAssignee ? { user_assigned: true, assignee_user_id: REMOTE && draft.assignee.slice(5) !== "default" ? draft.assignee.slice(5) : null, agent_enabled: false, agent_id: "" } : { user_assigned: false, assignee_user_id: null, agent_enabled: false, agent_id: "" };
          const latestContext = readContext();
          const selectedProject = state.projects.find((item) => item.id === draft.projectId);
          let workspacePath = selectedProject?.workspace_path || await resolveWorkspacePath(latestContext);
          if (!workspacePath && selectedProject?.external_id && latestContext.projectId === selectedProject.external_id) {
            const ensured = await ensureContextProject(latestContext);
            workspacePath = ensured?.workspace_path || "";
          }
          let files = [];
          if (RELAY) await cacheRemoteAttachments(draft.attachments);
          else if (REMOTE) files = await remoteFiles(draft.attachments);
          else await uploadPastedImages();
          const submittedDescription = withAttachments(draft.description);
          const body = {
            project_id: draft.projectId,
            skill_id: dialog.querySelector('[name="skill_id"]')?.value ?? draft.skillId ?? "",
            title,
            description: submittedDescription,
            status: draft.status,
            priority: draft.priority,
            labels: draft.labels.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
            workspace_path: workspacePath,
            ai_enrich: false,
            ...!issue ? { native_only: true } : {},
            files,
            ...state.mockup ? { mockup_run_status: draft.runStatus } : {},
            ...assignee,
            ...!issue ? { id: createRequestId, request_id: createRequestId } : {}
          };
          const transferTimeoutMs = files.length ? 12e4 : void 0;
          let queuedCreate = false;
          let createdIssue = null;
          if (issue) await api("/api/issues/" + encodeURIComponent(issue.id), { method: "PATCH", body: JSON.stringify({ ...body, version: issue.version }), timeoutMs: transferTimeoutMs });
          else {
            writeCreateDraft(draft, createRequestId);
            const commandId = globalThis.crypto?.randomUUID?.() || VERSION + "-create-command-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            const submittedDraft = { ...draft, attachments: draft.attachments.map((item) => ({ ...item })), promptSemanticReferences: draft.promptSemanticReferences.map((reference) => ({ ...reference })) };
            const result = await api("/api/issues", { method: "POST", body: JSON.stringify({ ...body, project_id: draft.projectId }), timeoutMs: transferTimeoutMs, commandId, enqueue: true });
            if (result?.queued !== true) createdIssue = result?.issue || result;
            state.projectId = draft.projectId;
            if (result?.queued === true) {
              queuedCreate = true;
              const placeholder = queuedIssuePlaceholder(commandId, { ...body, project_id: draft.projectId });
              pendingIssueCreates.set(commandId, { issue: placeholder, requestId: createRequestId });
              state.issues.push(placeholder);
              state.issuesLoaded = true;
              render();
              traceDialog("issue_create_queued", { command_id: commandId, request_id: createRequestId });
              watchQueuedCommand(commandId, {
                applied: async (payload) => {
                  const pending = pendingIssueCreates.get(commandId);
                  pendingIssueCreates.delete(commandId);
                  state.issues = state.issues.filter((item) => item.id !== pending?.issue.id);
                  if (payload?.id) state.issues.push({ ...payload, reply_status: payload.reply_status || "idle" });
                  await loadIssues({ background: true });
                  if (payload?.id) await createIssueNativeConversation(payload);
                },
                failed: async (error) => {
                  const pending = pendingIssueCreates.get(commandId);
                  pendingIssueCreates.delete(commandId);
                  state.issues = state.issues.filter((item) => item.id !== pending?.issue.id);
                  if (!state.keepCreate && !sessionStorage.getItem(CREATE_DRAFT_KEY)) writeCreateDraft(submittedDraft, createRequestId);
                  render();
                  reportGlobalError(error, { source: "issue_create_queue", command_id: commandId, request_id: createRequestId });
                  showError(error);
                }
              });
            }
          }
          traceDialog("dialog_submit_success", { action: issue ? "update_issue" : "create_issue" });
          if (!issue) sessionStorage.removeItem(CREATE_DRAFT_KEY);
          if (!queuedCreate) await loadIssues();
          retainCreateDraft = false;
          dialog.close();
          if (!issue && createdIssue?.id) await createIssueNativeConversation(createdIssue);
        } catch (error) {
          traceDialog("dialog_submit_error", { action: issue ? "update_issue" : "create_issue", error: String(error instanceof Error ? error.message : "create_failed").slice(0, 200) });
          const reconciliation = await reconcileIssueConflict(error);
          const reportContext = { source: "issue_dialog_submit", action: issue ? "update" : "create" };
          if (reconciliation.reconciled) presentReconciledContentConflict(errorOutput, reconciliation.error, reportContext);
          else presentInlineError(errorOutput, reconciliation.error, errorLabel(reconciliation.error), reportContext);
          submitInFlight = false;
          submit.disabled = false;
        }
      }
      async function startIssueNow() {
        if (!issue || editingLocked || !issue.agent_enabled || dirtyDraftFields.has("assignee") && (draft.assignee === "none" || draft.assignee.startsWith("user:"))) return;
        const button2 = dialog.querySelector("[data-dialog-start-now]");
        const errorOutput = dialog.querySelector(".better-codex-dialog-error");
        if (!button2 || !errorOutput) return;
        button2.disabled = true;
        errorOutput.hidden = true;
        try {
          const current = await api("/api/issues/" + encodeURIComponent(issue.id));
          if (current.archived_at || !current.agent_enabled || dirtyDraftFields.has("assignee") && (draft.assignee === "none" || draft.assignee.startsWith("user:")) || current.active_run_status || issueSessionId(current) || issuePermissions(current).enrichmentPending || current.status === "done") {
            refreshIssueState(current);
            throw new Error("issue_not_startable");
          }
          const agentId = dirtyDraftFields.has("assignee") ? draft.assignee && draft.assignee !== "none" && draft.assignee !== "codex" && !draft.assignee.startsWith("user:") ? draft.assignee : "" : current.agent_id || "";
          const status = current.status === "backlog" ? "todo" : dirtyDraftFields.has("status") ? draft.status : current.status;
          await uploadPastedImages();
          await api("/api/issues/" + encodeURIComponent(issue.id) + "/start", {
            method: "POST",
            body: JSON.stringify({
              version: current.version,
              project_id: dirtyDraftFields.has("project_id") ? draft.projectId : current.project_id,
              title: dirtyDraftFields.has("title") ? draft.title : current.title,
              description: withAttachments(dirtyDraftFields.has("description") ? draft.description : current.description),
              status,
              priority: dirtyDraftFields.has("priority") ? draft.priority : current.priority,
              labels: (dirtyDraftFields.has("labels") ? draft.labels : (current.labels || []).join(", ")).split(/[,，]/).map((value) => value.trim()).filter(Boolean),
              agent_id: agentId
            })
          });
          await loadIssues();
          dialog.close();
        } catch (error) {
          const reconciliation = await reconcileIssueConflict(error);
          if (reconciliation.reconciled) presentReconciledContentConflict(errorOutput, reconciliation.error, { source: "issue_start" });
          else presentInlineError(errorOutput, reconciliation.error, errorLabel(reconciliation.error), { source: "issue_start" });
          button2.disabled = false;
        }
      }
      dialog.__betterCodexSyncIssue = refreshIssueState;
      document.body.append(dialog);
      const dialogAction = (target) => {
        const control = target?.closest?.("button");
        if (!control || !dialog.contains(control)) return "";
        if (control.matches("[data-dialog-close]")) return "close";
        if (control.matches(".better-codex-submit")) return "submit";
        if (control.matches("[data-dialog-open-thread]")) return "open_thread";
        if (control.matches("[data-dialog-start-now]")) return "start_now";
        if (control.matches("[data-dialog-stop]")) return "stop";
        if (control.matches("[data-dialog-restore]")) return "restore";
        if (control.matches("[data-dialog-switch]")) return "switch_mode";
        if (control.matches("[data-dialog-expand]")) return "expand";
        if (control.matches("[data-dialog-attach]")) return "attach";
        if (control.matches("[data-dialog-detach]")) return "detach";
        if (control.matches("[data-dialog-project]")) return "project";
        if (control.matches("[data-dialog-project-option]")) return "project_option";
        if (control.matches("[data-dialog-select-toggle]")) return "select";
        if (control.matches("[data-dialog-select-option]")) return "select_option";
        if (control.matches("[data-dialog-label-toggle]")) return "labels";
        if (control.matches("[data-dialog-label-option]")) return "label_option";
        if (control.matches("[data-reply-send]")) return "reply_send";
        return "";
      };
      const traceDialogAction = (event) => {
        const action = dialogAction(event.target);
        if (!action) return;
        traceDialog("dialog_action", { input_event: event.type, action, target: diagnosticTarget(event.target) });
      };
      dialog.addEventListener("pointerdown", traceDialogAction, true);
      dialog.addEventListener("click", traceDialogAction, true);
      dialog.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && draft.conversationExpanded) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setConversationExpanded(false);
          return;
        }
        if (!["Escape", "Enter"].includes(event.key)) return;
        const fields = {
          key: event.key,
          code: event.code,
          target: diagnosticTarget(event.target),
          meta_key: event.metaKey,
          ctrl_key: event.ctrlKey,
          alt_key: event.altKey,
          shift_key: event.shiftKey,
          repeat: event.repeat,
          default_prevented: event.defaultPrevented,
          dialog_open: dialog.open
        };
        traceDialog("dialog_keydown_capture", fields);
        setTimeout(() => traceDialog("dialog_keydown_settled", { ...fields, default_prevented: event.defaultPrevented, dialog_open: dialog.open }), 0);
      }, true);
      dialog.addEventListener("cancel", (event) => {
        traceDialog("dialog_cancel", { default_prevented: event.defaultPrevented, dialog_open: dialog.open });
      }, true);
      dialog.addEventListener("keydown", (event) => {
        if (issue || event.key !== "Escape") return;
        event.preventDefault();
        traceDialog("dialog_escape_close", { default_prevented: event.defaultPrevented, dialog_open: dialog.open });
        dialog.close();
      });
      dialog.addEventListener("close", () => {
        traceDialog("dialog_close", { dialog_open: dialog.open });
        if (retainCreateDraft) {
          syncDraft();
          writeCreateDraft(draft, createRequestId);
        }
        draft.attachments.forEach(releaseAttachment);
        draft.replyAttachments.forEach(releaseAttachment);
        stopConversationPoll();
        stopReplyRecovery();
        if (retryPresentationTimer !== null) clearInterval(retryPresentationTimer);
        retryPresentationTimer = null;
        flushReplyDraft();
        if (projectDismiss) document.removeEventListener("pointerdown", projectDismiss, true);
        if (selectDismiss) document.removeEventListener("pointerdown", selectDismiss, true);
        window.visualViewport?.removeEventListener("resize", mobileDialogViewport);
        window.visualViewport?.removeEventListener("scroll", mobileDialogViewport);
        window.removeEventListener("resize", mobileDialogViewport);
        dialogBoundsObserver?.disconnect();
        if (mobileInputFrame !== null) cancelAnimationFrame(mobileInputFrame);
        dialog.remove();
      }, { once: true });
      bindModalDismiss(dialog, () => dialog.close());
      renderDialog();
      mobileDialogViewport();
      dialog.showModal();
      if (issue) retryPresentationTimer = setInterval(syncRetryPresentation, 3e4);
      if (issue && panel && typeof ResizeObserver === "function") {
        dialogBoundsObserver = new ResizeObserver(syncIssueFullscreenBounds);
        dialogBoundsObserver.observe(panel);
      }
      window.visualViewport?.addEventListener("resize", mobileDialogViewport, { passive: true });
      window.visualViewport?.addEventListener("scroll", mobileDialogViewport, { passive: true });
      window.addEventListener("resize", mobileDialogViewport, { passive: true });
      traceDialog("dialog_open", { dialog_open: dialog.open });
      dialog.querySelector(draft.mode === "agent" ? '[name="prompt"]' : HOST_KIND === "web" && window.matchMedia("(max-width: 720px)").matches ? "[data-dialog-close]" : '[name="title"]')?.focus();
      if (issue && (sessionId || issueConversationFailed())) requestAnimationFrame(() => void loadConversation());
    }
    function onBoardClick(event) {
      if (Date.now() < suppressIssueClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const archiveOpen = event.target.closest("[data-archive-open]");
      if (archiveOpen) return void openArchiveDialog(event.target.closest("[data-project-board]") ? state.projectDetailId : "");
      const add = event.target.closest("[data-add-status]");
      if (add) return void perform(() => createProjectWorkConversation(event.target.closest("[data-project-board]") ? state.projectDetailId : state.projectId, add.dataset.addStatus));
      const thread = event.target.closest("[data-thread]");
      if (thread) {
        event.stopPropagation();
        return void perform(() => openThread(thread.dataset.thread));
      }
      const pin = event.target.closest("[data-pin]");
      if (pin) {
        const issue2 = state.issues.find((item) => item.id === pin.dataset.pin);
        if (!issue2 || issuePermissions(issue2).enrichmentPending) return;
        return void perform(async () => {
          const pinned = !issue2.pinned;
          await withLatestIssueOnConflict(issue2.id, (latest) => api("/api/issues/" + encodeURIComponent(issue2.id), { method: "PATCH", body: JSON.stringify({ version: latest.version, pinned }) }));
          await loadIssues();
        });
      }
      const card = event.target.closest("[data-issue-id]");
      const issue = state.issues.find((item) => item.id === card?.dataset.issueId);
      const permissions = issuePermissions(issue);
      if (issue && !permissions.enrichmentPending && !permissions.remotePending) return void perform(() => openEditor(issue));
    }
    function sessionThreadTitle(row) {
      const attribute = ATTRIBUTES.threadTitle ? row.getAttribute(ATTRIBUTES.threadTitle) : "";
      return String(attribute || row.getAttribute("aria-label") || row.querySelector(SELECTORS.truncatedText)?.textContent || row.textContent || "").replace(/\s+/g, " ").trim();
    }
    function sessionDropTarget(clientX, clientY) {
      const board = panel?.querySelector("#better-codex-board");
      if (!board || panel?.hidden) return null;
      const bounds = board.getBoundingClientRect();
      if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
      const column = Array.from(board.querySelectorAll(".better-codex-column")).find((node) => {
        const rect = node.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      }) || null;
      if (column?.dataset.status === "archive") return null;
      return { board, column };
    }
    function setSessionDropTarget(target) {
      panel?.querySelectorAll(".is-session-drop-target").forEach((node) => node.classList.remove("is-session-drop-target"));
      if (!target) return;
      target.board.classList.add("is-session-drop-target");
    }
    function resetSessionDrag() {
      sessionDragPointer = null;
      setSessionDropTarget(null);
    }
    function revealImportedIssue(issueId) {
      requestAnimationFrame(() => {
        const card = Array.from(panel?.querySelectorAll("[data-issue-id]") || []).find((node) => node.dataset.issueId === issueId);
        if (!card) return;
        const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
        card.classList.add("is-session-imported");
        setTimeout(() => card.classList.remove("is-session-imported"), 1400);
      });
    }
    async function importSessionIssue(context) {
      if (sessionDropInFlight) return null;
      sessionDropInFlight = true;
      try {
        if (state.nativePlanningEnabled) {
          const binding = await lookupNativeProjectBinding(context.threadId);
          if (binding?.project_id) {
            openRoute("projects", { projectId: binding.project_id });
            state.projectPage = "planning";
            renderProjects();
            return null;
          }
        }
        let issue = null;
        try {
          const existing = await api("/api/issues/from-thread?thread_id=" + encodeURIComponent(context.threadId));
          if (existing && linkedIssueThreadId(existing) === context.threadId) {
            issue = await api("/api/issues/from-thread", {
              method: "POST",
              body: JSON.stringify({ thread_id: context.threadId })
            });
          }
        } catch (error) {
          if (String(error instanceof Error ? error.message : error) !== "issue_not_found") throw error;
        }
        if (!issue) {
          state.projects = await requestProjects();
          let project = context.projectId ? await ensureContextProject(context) : null;
          let workspacePath = String(project?.workspace_path || "").trim();
          if (!workspacePath) workspacePath = await resolveWorkspacePath(context);
          if (!project && workspacePath) project = state.projects.find((item) => item.workspace_path === workspacePath) || null;
          if (!project) throw new Error("project_required");
          issue = await api("/api/issues/from-thread", {
            method: "POST",
            body: JSON.stringify({
              project_id: project.id,
              title: context.threadTitle || t("未命名任务"),
              thread_id: context.threadId,
              workspace_path: workspacePath || project.workspace_path || ""
            })
          });
        }
        if (issue.archived_at) throw new Error("issue_archived");
        await loadIssues();
        revealImportedIssue(issue.id);
        return issue;
      } finally {
        sessionDropInFlight = false;
      }
    }
    function onSessionPointerDown(event) {
      if (!active || state.surface !== "issues" || state.mockup || READ_ONLY || REMOTE || HOST_CAPABILITIES.nativeThreads === false || event.button !== 0 || event.isPrimary === false) return;
      const row = event.target?.closest?.(SELECTORS.threadRow);
      if (!row || row.closest("#" + PANEL_ID)) return;
      const nestedControl = event.target?.closest?.("button,a,input,textarea,select,[contenteditable='true']");
      if (nestedControl && nestedControl !== row) return;
      const threadId = nativeThreadId(row);
      if (!threadId) return;
      const context = readContext(row);
      context.threadId = threadId;
      context.threadTitle = sessionThreadTitle(row);
      sessionDragPointer = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false, context };
    }
    function onSessionPointerMove(event) {
      const drag = sessionDragPointer;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.dragging) {
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (deltaX * deltaX + deltaY * deltaY < 36) return;
        drag.dragging = true;
      }
      setSessionDropTarget(sessionDropTarget(event.clientX, event.clientY));
    }
    function onSessionPointerUp(event) {
      const drag = sessionDragPointer;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const target = drag.dragging ? sessionDropTarget(event.clientX, event.clientY) : null;
      resetSessionDrag();
      if (!target) return;
      suppressSessionClickUntil = Date.now() + 500;
      void perform(() => importSessionIssue(drag.context));
    }
    function onSessionPointerCancel(event) {
      if (!sessionDragPointer || event.pointerId !== sessionDragPointer.pointerId) return;
      resetSessionDrag();
    }
    function supportsIssueDrag() {
      return !window.matchMedia?.("(hover: none), (pointer: coarse)")?.matches;
    }
    function onCardDragStart(event) {
      const card = event.target.closest("[data-issue-id]");
      if (!card || !event.dataTransfer) return;
      if (!supportsIssueDrag()) {
        event.preventDefault();
        return;
      }
      const issueId = card.dataset.issueId || "";
      const issue = state.issues.find((item) => item.id === issueId);
      if (!issue || issuePermissions(issue).boardLocked) return;
      draggingIssueId = issueId;
      event.dataTransfer.setData("text/plain", issueId);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("is-dragging");
    }
    function onCardDragEnd(event) {
      draggingIssueId = "";
      event.target.closest("[data-issue-id]")?.classList.remove("is-dragging");
      document.querySelectorAll(".better-codex-card.is-dragging").forEach((node) => node.classList.remove("is-dragging"));
    }
    function onDrop(event) {
      event.preventDefault();
      const id = event.dataTransfer?.getData("text/plain");
      const status = event.target.closest("[data-status]")?.dataset.status;
      const beforeId = event.target.closest("[data-issue-id]")?.dataset.issueId || "";
      const issue = state.issues.find((item) => item.id === id);
      if (!issue || issuePermissions(issue).boardLocked || !status) return;
      if (status === "archive") {
        return void perform(async () => {
          await withLatestIssueOnConflict(issue.id, (latest) => api("/api/issues/" + encodeURIComponent(issue.id) + "/archive", { method: "POST", body: JSON.stringify({ version: latest.version }) }));
          await loadIssues();
        });
      }
      if (state.mockup) {
        if (issue.status === status && beforeId === issue.id) return;
        return void perform(async () => {
          await moveMockupIssue(issue.id, issue.version, status, beforeId);
          await loadIssues();
        });
      }
      if (issue.status === status) return;
      void perform(async () => {
        await withLatestIssueOnConflict(issue.id, (latest) => api("/api/issues/" + encodeURIComponent(issue.id), { method: "PATCH", body: JSON.stringify({ version: latest.version, status }) }));
        await loadIssues();
      });
    }
    function hideExternalMcpAppHost() {
      if (HOST_KIND === "web") return;
      const views = Array.from(document.querySelectorAll("webview"));
      for (const view of views) {
        if (view.title !== "Better Codex") continue;
        const host = view.closest("body > div.fixed.inset-0, body > div[class*='fixed'], body > div");
        if (host && host !== document.body && !host.contains(panel)) {
          host.setAttribute(EXTERNAL_MCP_HIDDEN, "true");
        }
      }
    }
    function mountPanel() {
      if (!active) return;
      restoreNative();
      const surface = findMount();
      if (!surface) {
        if (panel) panel.hidden = true;
        return;
      }
      if (inlineConversation) {
        mountInlineConversation(surface);
        return;
      }
      if (!panel) {
        panel = createPanel();
        panelSizeCleanup = observeComponentSize(panel, componentContext("host", "panel-layout"));
      }
      if (panel.parentElement !== surface) surface.appendChild(panel);
      surface.setAttribute(HOST, "true");
      Array.from(surface.children).forEach((child) => {
        if (child !== panel && child.getAttribute(OWNED) !== "true") child.setAttribute(HIDDEN, "true");
      });
      hideExternalMcpAppHost();
      panel.hidden = false;
      document.documentElement.setAttribute("data-better-codex-open", "true");
    }
    function restoreNative() {
      document.querySelectorAll("[" + HIDDEN + '="true"]').forEach((node) => node.removeAttribute(HIDDEN));
      document.querySelectorAll("[" + HOST + '="true"]').forEach((node) => node.removeAttribute(HOST));
      document.querySelectorAll("[" + EXTERNAL_MCP_HIDDEN + '="true"]').forEach((node) => node.removeAttribute(EXTERNAL_MCP_HIDDEN));
      document.documentElement.removeAttribute("data-better-codex-open");
    }
    function injectionSurfaceError() {
      if (![entry, agentsEntry, projectsEntry].every((item) => item?.isConnected)) return "injection_navigation_unmounted";
      if (!active) return null;
      if (inlineConversation) return injectedElementVisible(inlineConversationRoot) ? null : "injection_content_mount_unavailable";
      if (!injectedElementVisible(panel)) return "injection_content_mount_unavailable";
      const content = panel.querySelector(state.surface === "agents" ? "#better-codex-agents" : state.surface === "projects" ? "#better-codex-projects" : "#better-codex-board");
      if (!injectedElementVisible(content) || !panel.querySelector(".better-codex-toolbar button")) return "injection_surface_render_unavailable";
      return null;
    }
    function isBetterCodexRoute() {
      if (HOST_KIND === "web") return location.pathname === "/web" || location.pathname === "/" || Boolean(webProjectRoute()) || Boolean(webAgentRoute());
      if (Array.from(document.querySelectorAll("webview")).some((view) => view.title === "Better Codex")) return true;
      // Inspect text once. Reading every ancestor's textContent repeatedly
      // scales quadratically with a long native conversation.
      for (const main of document.querySelectorAll("main")) {
        const walker = document.createTreeWalker(main, 4);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (["找不到 MCP 应用视图", "MCP app view not found"].includes(node.nodeValue?.trim())) return true;
        }
      }
      return false;
    }
    function releaseProjectSurfaceCache() {
      inlineConversationAdapter?.clearRetainedPin?.();
      projectSurfaceCache?.nativePage?.removeAttribute('data-better-codex-native-preview');
      projectSurfaceCache?.obscuredPage?.removeAttribute('data-better-codex-native-preview-obscured');
      const root = projectSurfaceCache?.root;
      if (root !== inlineConversationRoot) {
        const surface = projectSurfaceCache?.nativeSurface;
        const page = surface?.closest?.('[data-app-shell-active-page]');
        projectSurfaceCache?.nativeLayout?.removeAttribute?.("data-better-codex-inline-content");
        surface?.removeAttribute?.("data-better-codex-inline-host");
        surface?.style.removeProperty("--bc-inline-nav-space");
        surface?.style.removeProperty("--bc-inline-details-space");
        surface?.style.removeProperty("--bc-inline-native-panel-width");
        surface?.querySelectorAll?.('[data-better-codex-native-panel]').forEach(node => node.removeAttribute('data-better-codex-native-panel'));
        projectSurfaceCache?.chromeStyles?.forEach(([name]) => page?.style.removeProperty(name));
        page?.querySelectorAll('[data-better-codex-planning-native-hidden], [data-better-codex-planning-native-rail], [data-better-codex-planning-native-header]').forEach(node => {
          ["data-better-codex-planning-native-hidden", "data-better-codex-planning-native-rail", "data-better-codex-planning-native-header"].forEach(name => node.removeAttribute(name));
        });
      }
      if (root && !root.isConnected && root !== inlineConversationRoot) destroyOwnedComponents(root);
      projectSurfaceCache = null;
    }
    function cacheProjectSurface() {
      if (!active || !state.projectDetailId || destroyed || inlineConversationLoading || inlineConversationError || panel?.dataset.recovery) return;
      if (state.surface !== "projects" && !inlineConversation) return;
      if (projectSurfaceCache?.root !== inlineConversationRoot) releaseProjectSurfaceCache();
      const nativeSurface = inlineConversationRoot?.closest?.("[data-better-codex-inline-host]");
      projectSurfaceCache = {
        projectId: state.projectDetailId, page: state.projectPage, stage: state.projectDocumentView, surface: state.surface,
        conversation: inlineConversation ? { ...inlineConversation, target: { ...inlineConversationTarget() } } : null,
        adapterSnapshot: inlineConversationAdapter?.capture?.(), root: inlineConversationRoot,
        nativeSurface, nativeLayout: nativeSurface?.querySelector?.("[data-better-codex-inline-content]"),
        chromeStyles: nativeSurface ? ["--bc-planning-left-space", "--bc-planning-details-space", "--bc-planning-toolbar-space"].map(name => [name, document.documentElement.style.getPropertyValue(name)]) : [],
        detailsMarkup: inlineConversationDetailsMarkup, headerMarkup: inlineConversationHeaderMarkup, navigationMarkup: inlineConversationNavigationMarkup,
        detailsOpen: inlineConversationDetailsOpen, compactDetailsOpen: inlineConversationCompactDetailsOpen, detailsWidth: inlineConversationWidth,
        scroll: [...(inlineConversationRoot || panel)?.querySelectorAll?.('*') || []].filter(node => node.scrollTop || node.scrollLeft).map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }))
      };
      const nativePage = nativeSurface?.closest?.('[data-app-shell-active-page]');
      projectSurfaceCache.chromeStyles.forEach(([name, value]) => nativePage?.style.setProperty(name, value));
      projectSurfaceCache.nativePage = nativePage;
      if (nativePage) [...nativePage.children].forEach(node => node.style.setProperty('--bc-native-retained-display', getComputedStyle(node).display));
      if (projectSurfaceCache.conversation) inlineConversationAdapter?.pinRetained?.(projectSurfaceCache.conversation);
    }
    function restoreCachedProjectSurface(projectId) {
      const cache = projectSurfaceCache;
      if (!cache || cache.projectId !== projectId || destroyed || !state.projects.some(project => project.id === projectId)) return false;
      state.projectDetailId = projectId;
      state.projectId = projectId;
      state.projectPage = cache.page;
      state.projectDocumentView = cache.stage;
      state.projectResumePending = "";
      state.surface = cache.surface;
      routeSuppressed = false;
      routeSeen = false;
      active = true;
      sessionStorage.setItem(RESUME_SURFACE_KEY, state.surface);
      ensureEntry();
      inlineConversationNavigationRequest++;
      const request = ++inlineConversationRequest;
      if (cache.conversation) {
        inlineConversation = { ...cache.conversation, target: { ...cache.conversation.target } };
        inlineConversationRoot = cache.root;
        inlineConversationDetailsMarkup = cache.detailsMarkup;
        inlineConversationHeaderMarkup = cache.headerMarkup;
        inlineConversationNavigationMarkup = cache.navigationMarkup;
        inlineConversationDetailsOpen = cache.detailsOpen;
        inlineConversationCompactDetailsOpen = cache.compactDetailsOpen;
        inlineConversationWidth = cache.detailsWidth;
        inlineConversationLoading = true;
        inlineConversationCacheRestoring = true;
        inlineConversationError = "";
        // Switch the genuine retained React page before attaching our shell.
        // A warm return must not paint Home or wait on host IPC/Runtime HTTP.
        cache.nativeRetained = ensureInlineConversationAdapter().resumeRetained?.(inlineConversation, { deferNavigation: Boolean(cache.nativePage?.isConnected) }) === true;
        if (cache.nativeRetained && cache.nativeSurface?.isConnected && cache.nativeLayout?.isConnected && panel) {
          // The retained page already has its prepared layout. Reattach refs
          // directly without markup generation or forced geometry measurements.
          if (panel.parentElement !== cache.nativeSurface) cache.nativeSurface.appendChild(panel);
          panel.setAttribute("data-better-codex-inline-shell", "true");
          panel.hidden = false;
          panel.appendChild(inlineConversationRoot);
          cache.nativeSurface.setAttribute("data-better-codex-inline-host", "true");
          cache.nativeLayout.setAttribute("data-better-codex-inline-content", "true");
          cache.nativeLayout.setAttribute("data-better-codex-inline-blocked", "true");
          cache.nativeLayout.inert = true;
          const navSpace = cache.chromeStyles.find(([name]) => name === "--bc-planning-left-space")?.[1] || "370px";
          const detailsSpace = cache.chromeStyles.find(([name]) => name === "--bc-planning-details-space")?.[1] || "0px";
          cache.nativeSurface.style.setProperty("--bc-inline-nav-space", navSpace);
          cache.nativeSurface.style.setProperty("--bc-inline-details-space", detailsSpace);
          cache.chromeStyles.forEach(([name, value]) => document.documentElement.style.setProperty(name, value));
          syncPlanningWorkspaceNativeChrome(true, cache.nativeSurface.closest?.('[data-app-shell-active-page]'));
          const status = inlineConversationRoot.querySelector(".better-codex-inline-status");
          if (status) status.hidden = true;
          if (cache.nativePage?.isConnected) {
            // Display the original retained DOM while its native effects are
            // still paused. Its own editor stays inert until route activation.
            cache.obscuredPage = document.querySelector('[data-app-shell-active-page="true"]');
            if (cache.obscuredPage !== cache.nativePage) cache.obscuredPage?.setAttribute('data-better-codex-native-preview-obscured', 'true');
            cache.nativePage.setAttribute('data-better-codex-native-preview', 'true');
          }
        } else mountPanel();
        void reconnectCachedProjectConversation(cache, request);
      } else {
        mountPanel();
        render();
        void perform(() => loadSurface({ background: true }), { background: true });
      }
      for (const scroll of cache.scroll) { scroll.node.scrollTop = scroll.top; scroll.node.scrollLeft = scroll.left; }
      if (!startLiveUpdates() && pollTimer === null) pollTimer = setInterval(() => {
        if (!document.hidden && active && !panel?.dataset.recovery) void perform(() => loadSurface({ background: true }), { background: true });
      }, 3e3);
      return true;
    }
    async function reconnectCachedProjectConversation(cache, request) {
      const key = inlineConversationKey(cache.conversation);
      const current = () => !destroyed && active && request === inlineConversationRequest && inlineConversation && inlineConversationKey(inlineConversation) === key;
      try {
        const adapter = ensureInlineConversationAdapter();
        // Reattach the native route from memory before any Runtime HTTP lookup.
        const result = cache.nativeRetained ? { mode: inlineConversation.mode } : await adapter.restore(inlineConversation, cache.adapterSnapshot);
        if (!current()) return;
        if (result?.error || result?.mode === "unavailable") throw Error(result.error || "native_conversation_adapter_unavailable");
        inlineConversation.route = location.pathname + location.search;
        // Retain the warm page while permissions are refreshed; loading guards
        // input without placing an opening mask over the existing messages.
        if (!cache.nativeRetained) inlineConversationCacheRestoring = false;
        if (!cache.nativeRetained) renderInlineConversation();
        // Keep native input blocked until current permissions/context are checked.
        if (cache.nativeRetained && typeof requestAnimationFrame === "function") {
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          if (!current()) return;
        }
        if (cache.nativeRetained) {
          const restored = await adapter.waitRetainedNavigation?.();
          cache.nativePage?.removeAttribute('data-better-codex-native-preview');
          cache.obscuredPage?.removeAttribute('data-better-codex-native-preview-obscured');
          if (!current()) return;
          if (restored === false) throw Error("native_conversation_adapter_unavailable");
        }
        await reloadInlineConversationContext({ background: true });
        if (!current()) return;
        if (["draft", "thread"].includes(inlineConversation.mode) && (adapter.getCurrentContext?.()?.thread_id || "") !== (inlineConversation.thread_id || inlineConversation.binding?.thread_id || "")) {
          const reopened = await adapter.open(inlineConversation);
          if (!current()) return;
          if (reopened?.error || reopened?.mode === "unavailable") throw Error(reopened.error || "native_conversation_adapter_unavailable");
        }
        rememberProjectView();
      } catch (error) {
        if (!current()) return;
        releaseProjectSurfaceCache();
        inlineConversationError = nativeInlineErrorLabel(error);
        appendDiagnostic("cached_project_reconnect_failed", { error: error instanceof Error ? error.message : String(error), target: key });
      } finally {
        if (current()) {
          inlineConversationLoading = false;
          inlineConversationCacheRestoring = false;
          mountPanel();
          renderInlineConversation();
        }
      }
    }
    function openRoute(surface = state.surface, options = {}) {
      const sameProject = surface === "projects" && (typeof options.projectId !== "string" || options.projectId === state.projectDetailId);
      if (active && sameProject && inlineConversation && options.resume !== false) { mountPanel(); return; }
      if (active) rememberProjectView();
      if (active) cacheProjectSurface();
      leaveInlineConversation();
      if (!availableSurfaces.includes(surface)) surface = "issues";
      routeSuppressed = false;
      routeSeen = false;
      if (surface === "projects") {
        const projectId = typeof options.projectId === "string" ? options.projectId : localStorage.getItem("better-codex-managed-project") || "";
        if (options.resume !== false && restoreCachedProjectSurface(projectId)) return;
        if (projectId !== state.projectDetailId) {
          state.projectIssues = [];
          state.projectIssuesProjectId = "";
        }
        state.projectDetailId = projectId;
        if (options.resume !== false) applyProjectView(projectId);
        else state.projectResumePending = "";
        if (HOST_KIND === "web") {
          const mode = options.history || (webProjectRoute() ? "replace" : "push");
          syncWebProjectRoute(state.projectDetailId, mode);
        }
      } else if (surface === "agents") {
        state.projectDetailId = "";
        const agentKey2 = typeof options.agentKey === "string" ? options.agentKey : "";
        state.agentPane = agentKey2 === "new" ? "create" : agentKey2 ? "detail" : "preview";
        state.selectedAgentId = agentKey2 && agentKey2 !== "new" ? agentKey2 : "";
        state.agentDraft = agentKey2 === "new" ? { avatar: DEFAULT_PRESET_AVATAR_URL } : null;
        if (HOST_KIND === "web") {
          if (options.history === "none" && agentKey2 && !history.state?.betterCodexAgentFromList) {
            syncWebAgentRoute("", "replace");
            syncWebAgentRoute(agentKey2);
          } else {
            const mode = options.history || (webAgentRoute() ? "replace" : "push");
            syncWebAgentRoute(agentKey2, mode);
          }
        }
      } else {
        state.projectDetailId = "";
        if (HOST_KIND === "web" && options.history !== "none") window.postMessage({ type: NAVIGATION.messageType, path: BETTER_CODEX_ROUTE }, window.location.origin);
      }
      open(surface);
    }
    function open(surface = state.surface) {
      if (destroyed) return;
      if (!availableSurfaces.includes(surface)) surface = "issues";
      routeSuppressed = false;
      state.surface = surface;
      sessionStorage.setItem(RESUME_SURFACE_KEY, surface);
      active = true;
      ensureEntry();
      mountPanel();
      render();
      void load();
      if (!startLiveUpdates() && pollTimer === null) pollTimer = setInterval(() => {
        if (!document.hidden && active && !panel?.dataset.recovery) void perform(() => loadSurface({ background: true }), { background: true });
      }, 3e3);
      if (retryClockTimer === null) retryClockTimer = setInterval(() => {
        if (active && state.issues.some((issue) => issue.session_retry)) render();
      }, 3e4);
    }
    function close(options = {}) {
      rememberProjectView();
      cacheProjectSurface();
      leaveInlineConversation();
      const resume = Boolean(options.resume);
      if (resume) sessionStorage.setItem(RESUME_SURFACE_KEY, state.surface);
      else sessionStorage.removeItem(RESUME_SURFACE_KEY);
      routeSuppressed = options.suppressRoute !== false;
      active = false;
      resetSessionDrag();
      closeFilterMenu();
      closeCreateMenu();
      closeIssueMenu();
      closeAuxiliaryMenu();
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (retryClockTimer !== null) {
        clearInterval(retryClockTimer);
        retryClockTimer = null;
      }
      if (panel) panel.hidden = true;
      restoreNative();
      ensureEntry();
    }
    function findThreadRow(expected) {
      return Array.from(document.querySelectorAll(SELECTORS.threadRow)).find((item) => nativeThreadId(item) === expected);
    }
    function currentRouteThreadId() {
      const match = location.pathname.match(/\/local\/([^/?#]+)/);
      if (!match) return "";
      try {
        return normalizeSessionId(decodeURIComponent(match[1]));
      } catch {
        return "";
      }
    }
    function activeThreadId() {
      const activeRow = Array.from(document.querySelectorAll(SELECTORS.threadRow)).find((item) => item.getAttribute(ATTRIBUTES.threadActive) === "true");
      return activeRow ? nativeThreadId(activeRow) : "";
    }
    async function requestSessionHandoff(issue, threadId) {
      if (sessionHandoffPending.has(issue.id)) throw new Error("thread_handoff_busy");
      sessionHandoffPending.add(issue.id);
      try {
        const updated = await api("/api/issues/" + encodeURIComponent(issue.id) + "/session-handoff", { method: "POST", body: JSON.stringify({ thread_id: threadId }) });
        const index = state.issues.findIndex((candidate) => candidate.id === issue.id);
        if (index >= 0) state.issues[index] = { ...state.issues[index], ...updated };
        const dialog = document.getElementById("better-codex-dialog");
        if (dialog?.dataset.issueId === issue.id && typeof dialog.__betterCodexSyncIssue === "function") dialog.__betterCodexSyncIssue(updated);
        if (active) render();
        return updated;
      } finally {
        sessionHandoffPending.delete(issue.id);
      }
    }
    async function waitForThreadOpen(expected) {
      const deadline = Date.now() + THREAD_OPEN_TIMEOUT_MS;
      let clickedRow = false;
      while (Date.now() < deadline) {
        const active2 = activeThreadId();
        if (active2 === expected) return { opened: true, via: "sidebar" };
        if (currentRouteThreadId() === expected) return { opened: true, via: "route" };
        const row = findThreadRow(expected);
        if (row && !clickedRow) {
          clickedRow = true;
          nativeThreadOpenBypass = expected;
          row.click();
        }
        await new Promise((resolve) => setTimeout(resolve, THREAD_OPEN_POLL_MS));
      }
      throw new Error("thread_open_timeout");
    }
    async function openThread(threadId) {
      const expected = normalizeSessionId(threadId);
      if (!expected) throw new Error("thread_id_invalid");
      const unbound = Boolean(state.nativeUnboundThreads?.[expected]);
      const work = !unbound && (state.issues.find((candidate) => issueSessionId(candidate) === expected) || state.projectIssues.find((candidate) => issueSessionId(candidate) === expected));
      if (work) return openIssueNativeConversation(work);
      const projectLink = unbound ? null : state.nativeThreadLinks?.[expected] || (state.nativePlanningEnabled ? await lookupNativeProjectBinding(expected) : null);
      if (projectLink?.issue_id && projectLink?.project_id) return openIssueNativeConversation({ id: projectLink.issue_id, project_id: projectLink.project_id });
      if (projectLink?.project_id) return openProjectNativeSession(projectLink.project_id, projectLink.kind, projectLink.conversation_id);
      try {
        await resumePersistedThread(expected);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== "thread " + expected + " already has an active writer") throw error;
        appendDiagnostic("thread_open_blocked", { thread_id: expected, reason: "active_writer", stage: "thread_resume", error: message });
        await confirmAction("对话已被占用", "这个对话已在 Codex CLI 或其他 Codex 客户端中打开。请先在 CLI 或对应客户端关闭这个对话，再返回这里重新打开。", "知道了", true);
        return { opened: false, reason: "active_writer" };
      }
      const row = findThreadRow(expected);
      close();
      if (!row) window.postMessage({ type: NAVIGATION.messageType, path: NAVIGATION.threadRoutePrefix + encodeURIComponent(expected) }, window.location.origin);
      const result = await waitForThreadOpen(expected);
      close();
      return result;
    }
    function nativeThreadId(row) {
      const annotated = normalizeSessionId(row.getAttribute(ATTRIBUTES.threadId));
      if (annotated) return annotated;
      const fiberKey = Object.keys(row).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey ? row[fiberKey] : null;
      for (let depth = 0; fiber && depth < 40; depth += 1, fiber = fiber.return) {
        const conversationId = normalizeSessionId(fiber.memoizedProps?.conversationId);
        if (conversationId) return conversationId;
      }
      return "";
    }
    function isNativeRailDestination(target) {
      if (!(target instanceof Element) || !target.closest("[data-app-navigation-rail]")) return false;
      const button2 = target.closest("button,a,[role='button']");
      if (!button2 || button2.hasAttribute(OWNED) || button2.getAttribute("aria-haspopup") === "menu") return false;
      return true;
    }
    function isSidebarNavigationTarget(target) {
      if (!target.closest(SELECTORS.sidebarNavigation) || target.closest(SELECTORS.projectRow)) return false;
      const navigationItem = target.closest(SIDEBAR_NAVIGATION_ITEM) || target.closest(SELECTORS.threadRow);
      if (!navigationItem) return false;
      const nestedUtility = target !== navigationItem && target.matches("button,a,[role='button']") && target.getAttribute("aria-label");
      return !nestedUtility;
    }
    function isManagedNativeThread(threadId) {
      if (state.nativeUnboundThreads?.[threadId]) return false;
      const binding = state.nativeThreadLinks?.[threadId];
      if (binding && (!binding.host_id || binding.host_id === "local")) return true;
      return Boolean(active && threadId && ((state.issues || []).some((candidate) => !candidate.session_native_owned && issueSessionId(candidate) === threadId) || (state.projectIssues || []).some((candidate) => !candidate.session_native_owned && issueSessionId(candidate) === threadId)));
    }
    function onClick(event) {
      const target = event.target?.closest?.("button,a,[role='button']," + SELECTORS.threadRow);
      const ownedSurface = target === entry ? "issues" : target === agentsEntry ? "agents" : target === projectsEntry ? "projects" : "";
      if (ownedSurface) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeAuxiliaryMenu();
        openRoute(ownedSurface);
        return;
      }
      if (!target || target === entry || target === agentsEntry || target === projectsEntry || target === moreEntry || target === profileEntry || target === usageEntry || target === themeEntry || target.closest("#" + PANEL_ID) || target.closest("#better-codex-native-conversation") || target.closest("#better-codex-dialog") || target.closest("#better-codex-agent-dialog") || target.closest("#better-codex-project-dialog") || target.closest("#better-codex-profile-dialog") || target.closest("#better-codex-avatar-picker")) return;
      const threadRow = target.closest(SELECTORS.threadRow);
      const threadId = threadRow ? nativeThreadId(threadRow) : "";
      if (threadId && nativeThreadOpenBypass === threadId) nativeThreadOpenBypass = "";
      else if (!suppressAgentOutside && isManagedNativeThread(threadId) && isSidebarNavigationTarget(target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void perform(() => openThread(threadId));
        return;
      }
      if (!active || suppressAgentOutside) return;
      if (inlineConversation && !target.closest(SELECTORS.sidebarNavigation) && !isNativeRailDestination(target)) return;
      if (Date.now() < suppressSessionClickUntil && target.closest(SELECTORS.threadRow)) {
        suppressSessionClickUntil = 0;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (isNativeRailDestination(target)) {
        close({ resume: true });
        return;
      }
      if (isSidebarNavigationTarget(target)) close({ resume: true });
      else if (target.closest(SELECTORS.sidebarNavigation)) scheduleRefresh();
    }
    function refresh() {
      if (active && inlineConversationCacheRestoring && projectSurfaceCache?.nativeRetained && inlineConversationRoot?.isConnected) return;
      if (HOST_KIND === "web" && !hasFeature("project-management") && /^\/web\/projects(?:\/|$)/.test(location.pathname)) history.replaceState({ betterCodex: true, betterCodexSurface: "issues" }, "", "/web");
      const betterCodexRoute = isBetterCodexRoute();
      const entriesAvailable = ensureEntry();
      if (!entriesAvailable) {
        if (active && inlineConversation && (inlineConversationLoading || inlineConversationRouteAllowed())) {
          mountPanel();
          return;
        }
        if (active && !betterCodexRoute) close({ resume: true, suppressRoute: false });
        if (!betterCodexRoute) routeSuppressed = false;
        return;
      }
      const resumeSurface = sessionStorage.getItem(RESUME_SURFACE_KEY);
      if (betterCodexRoute) routeSeen = true;
      if (!betterCodexRoute) routeSuppressed = false;
      if (inlineConversation) {
        if (!inlineConversationLoading && !inlineConversationRouteAllowed()) return close({ resume: true, suppressRoute: false });
        mountPanel();
        return;
      }
      if (active && routeSeen && !betterCodexRoute) return close({ resume: true, suppressRoute: false });
      if (!active && betterCodexRoute && !routeSuppressed && availableSurfaces.includes(resumeSurface)) return open(resumeSurface);
      if (active) {
        const hadPanel = Boolean(panel);
        mountPanel();
        if (!hadPanel && panel) render();
      }
    }
    function scheduleRefresh() {
      if (refreshPending || destroyed) return;
      refreshPending = true;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshPending = false;
        if (destroyed) return;
        refresh();
      }, 50);
    }
    function destroy() {
      if (titlebarUsageTimer !== null) clearInterval(titlebarUsageTimer);
      titlebarUsageTimer = null;
      if (destroyed) return;
      destroyed = true;
      releaseProjectSurfaceCache();
      cancelInlineConversationViewportResize();
      syncInlineConversationInteraction(false);
      syncPlanningWorkspaceNativeChrome(false);
      inlineConversationAdapter?.destroy?.();
      inlineConversationAdapter = null;
      commandObserver.destroy();
      refreshPending = false;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (updateTimer !== null) clearInterval(updateTimer);
      if (retryClockTimer !== null) clearInterval(retryClockTimer);
      if (relayTimer !== null) clearInterval(relayTimer);
      relayTimer = null;
      updateNoticeResizeObserver?.disconnect();
      updateNoticeResizeObserver = null;
      boardScrollResizeObserver?.disconnect();
      boardScrollResizeObserver = null;
      isPanningBoard = false;
      panActiveBoard = null;
      panelSizeCleanup?.();
      panelSizeCleanup = null;
      Array.from(completionNoticeDismissals.values()).forEach((dismissNotice) => dismissNotice(false));
      completionNoticeTimers.forEach((timer) => clearTimeout(timer));
      completionNoticeTimers.clear();
      completionNoticeDismissals.clear();
      completionNoticeStack?.remove();
      completionNoticeStack = null;
      issueSessionSnapshot.clear();
      sessionHandoffPending.clear();
      pendingIssueReplies.clear();
      closeFilterMenu();
      closeIssueMenu();
      closeAuxiliaryMenu();
      observer?.disconnect();
      for (const pending of bridgeRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("injection_destroyed"));
      }
      bridgeRequests.clear();
      for (const pending of appServerRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("injection_destroyed"));
      }
      appServerRequests.clear();
      liveUnsubscribe?.();
      liveUnsubscribe = null;
      projectRefreshButton?.destroy();
      projectRefreshButton = null;
      destroyProjectRenderComponents();
      if (featureControllers) {
        featureControllers.agents.destroy();
        featureControllers.board.destroy();
        featureControllers.projects.destroy();
        featureControllers.settings.destroy();
        featureControllers = null;
      }
      managedButtons.forEach((handle) => handle.destroy());
      managedButtons.clear();
      document.removeEventListener("DOMContentLoaded", mount);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onSessionPointerDown, true);
      document.removeEventListener("pointermove", onSessionPointerMove, true);
      document.removeEventListener("pointerup", onSessionPointerUp, true);
      document.removeEventListener("pointercancel", onSessionPointerCancel, true);
      document.removeEventListener("keydown", onGlobalShortcut, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onNetworkOnline);
      window.removeEventListener("resize", onInlineConversationViewportResize);
      window.removeEventListener("codex-message-from-view", onHostMessageFromView, true);
      window.removeEventListener("message", onAppServerMessage, true);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("better-codex:error", onExternalError);
      window.removeEventListener("better-codex:profile-open", onUserProfileOpen);
      close();
      document.querySelectorAll("[" + OWNED + '="true"]').forEach((node) => node.remove());
      document.querySelectorAll("[data-better-codex-launcher-hidden]").forEach((node) => node.removeAttribute("data-better-codex-launcher-hidden"));
      ["light", "dark"].forEach((mode) => ["canvas", "ink", "accent", "surface", "control", "raised", "hover", "pressed", "hairline", "font-ui"].forEach((token) => document.documentElement.style.removeProperty("--bc-host-" + mode + "-" + token)));
      delete window.__betterCodexBridgeResolve;
      delete window.__betterCodexInjection__;
      errorDialog = null;
    }
    function mount() {
      document.removeEventListener("DOMContentLoaded", mount);
      if (destroyed || observer || !document.documentElement) return;
      observer = new MutationObserver((records) => {
        destroyRemovedComponents(records, [panel, inlineConversationRoot, projectSurfaceCache?.root].filter(Boolean));
        hydrateAddedIconButtons(records);
        scheduleRefresh();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme", "aria-current", ATTRIBUTES.threadActive, "data-app-shell-right-panel-full-width"] });
      startLiveUpdates();
      if (HOST_KIND !== "web" && HOST_CAPABILITIES.nativeThreads !== false) startSessionRelay();
      refresh();
      void ensureBootstrapReady().catch((error) => {
        if (destroyed) return;
        appendDiagnostic("bootstrap_mount_failed", {
          error: error instanceof Error ? error.message : String(error || "bootstrap_failed")
        });
      });
      void checkUpdateNotice();
      updateTimer = setInterval(() => {
        if (!document.hidden) void checkUpdateNotice();
      }, 15e3);
    }
    function captureReloadState() {
      return {nativeUnboundThreads:state.nativeUnboundThreads,surface:state.surface,open:active,project:state.projectDetailId,tab:state.projectPage,documentView:state.projectDocumentView,agentPane:state.agentPane,agent:state.selectedAgentId,skill:state.selectedSkillId,skillDraft:state.skillDraft,skillEditDrafts:state.skillEditDrafts,skillScopeFilter:state.skillScopeFilter,planSelections:state.planSelections,nativeWorkSelections:state.nativeWorkSelections,planningDrafts:[...projectPlanningDrafts],nativeConversation:inlineConversation ? {target:{...inlineConversationTarget()},context:{target:{...inlineConversationTarget()},mode:inlineConversation.mode,binding:inlineConversation.binding,expected_revision:inlineConversation.expected_revision,thread_id:inlineConversation.thread_id,read_only:inlineConversation.read_only,start_requested:inlineConversation.start_requested,route:inlineConversation.route,return_surface:inlineConversation.return_surface},adapterSnapshot:inlineConversationAdapter?.capture?.(),detailsOpen:inlineConversationDetailsOpen,compactDetailsOpen:inlineConversationCompactDetailsOpen,detailsWidth:inlineConversationWidth} : null};
    }
    async function restoreReloadState(saved) {
      await ensureBootstrapReady();
      releaseProjectSurfaceCache();
      state.nativeUnboundThreads = { ...saved.nativeUnboundThreads, ...state.nativeUnboundThreads };
      state.projectDetailId=saved.project || state.projectDetailId;
      state.projectPage=saved.tab || state.projectPage;
      state.projectDocumentView=saved.documentView || state.projectDocumentView;
      state.agentPane=saved.agentPane || state.agentPane;
      state.selectedAgentId=saved.agent || state.selectedAgentId;
      state.selectedSkillId=saved.skill || state.selectedSkillId;
      state.skillDraft=saved.skillDraft || state.skillDraft;
      state.skillEditDrafts=saved.skillEditDrafts || state.skillEditDrafts;
      state.skillScopeFilter=saved.skillScopeFilter || state.skillScopeFilter;
      state.planSelections=saved.planSelections || state.planSelections;
      state.nativeWorkSelections=saved.nativeWorkSelections || state.nativeWorkSelections;
      for(const [id,draft] of saved.planningDrafts || [])projectPlanningDrafts.set(id,draft);
      const message=(saved.fields || []).find(f=>f.key==='message');
      if(message&&state.projectDetailId)projectPlanningDrafts.set(state.projectDetailId,message.value);
      const restoredThread = normalizeSessionId(saved.nativeConversation?.context?.thread_id || saved.nativeConversation?.context?.binding?.thread_id);
      if (state.nativeUnboundThreads?.[restoredThread]) { close(); await openThread(restoredThread); }
      else if (saved.open && saved.nativeConversation) {
        inlineConversationDetailsOpen = saved.nativeConversation.detailsOpen !== false;
        inlineConversationCompactDetailsOpen = saved.nativeConversation.compactDetailsOpen === true;
        inlineConversationWidth = Math.min(4096, Math.max(280, Number(saved.nativeConversation.detailsWidth) || 360));
        await openInlineConversation(saved.nativeConversation.target, { restore: saved.nativeConversation.context, adapterSnapshot: saved.nativeConversation.adapterSnapshot });
      } else if(saved.open)open(saved.surface);else close();
      render();return {error:bootstrapFailure || injectionSurfaceError()};
    }
    window.__betterCodexInjection__ = { version: VERSION, bundleChecksum: config.bundleChecksum, profile: PROFILE, host: HOST_KIND, endpoint: BASE_URL, refresh, pulse: () => true, ready: () => bootstrapReady && !injectionSurfaceError(), bootstrapError: () => bootstrapFailure || injectionSurfaceError(), open: openRoute, openThread, close, destroy, reportError: reportGlobalError,captureReloadState,restoreReloadState };
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", onSessionPointerDown, true);
    document.addEventListener("pointermove", onSessionPointerMove, true);
    document.addEventListener("pointerup", onSessionPointerUp, true);
    document.addEventListener("pointercancel", onSessionPointerCancel, true);
    document.addEventListener("keydown", onGlobalShortcut, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onNetworkOnline);
    window.addEventListener("resize", onInlineConversationViewportResize, { passive: true });
    window.addEventListener("codex-message-from-view", onHostMessageFromView, true);
    window.addEventListener("message", onAppServerMessage, true);
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("better-codex:error", onExternalError);
    window.addEventListener("better-codex:profile-open", onUserProfileOpen);
    if (document.documentElement) mount();
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
    return { installed: true, reused: false };
  }
  return __toCommonJS(injected_entry_exports);
})();

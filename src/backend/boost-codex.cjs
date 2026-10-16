#!/usr/bin/env node
"use strict";
require('../modules/brand.cjs').normalizeEnvironment();
require("../modules/runtime-warnings.cjs").installSQLiteWarningFilter();
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto'), http = require('node:http');
var coreVersion = '0.4.18-local.2';
function init_version() {}
var import_node_crypto18=crypto, import_node_child_process14=cp, import_node_fs31=fs, import_node_path27=path, import_node_sea6=require('node:sea');
var boostCodexProfile, boostCodexHome, peerBoostCodexHome, runPath, logPath, runtimeVersionsPath, runtimeCurrentPath, compatibilityPath, compatibilityStatusPath, compatibilityVersionsPath, compatibilityCurrentPath, runtimeStatePath, runtimeLockPath, runtimeAuthorityPath, tokenPath, injectorLogPath, injectorPidPath, injectionStatePath, launchIntegrationStatePath, launchLockPath, runtimeLogPath, runtimePort, cdpPort;
var configInitialized=false;
function init_config() {
  if(configInitialized)return;configInitialized=true;
  boostCodexProfile=process.env.BOOST_CODEX_PROFILE || 'stable';
  if(!['stable','development'].includes(boostCodexProfile))throw Error('invalid_boost_codex_profile');
  boostCodexHome=path.resolve(process.env.BOOST_CODEX_HOME || path.join(os.homedir(),boostCodexProfile==='development'?'.better-codex-dev':'.better-codex'));
  peerBoostCodexHome=path.resolve(process.env.BOOST_CODEX_PEER_HOME || path.join(os.homedir(),boostCodexProfile==='development'?'.better-codex':'.better-codex-dev'));
  runPath=path.join(boostCodexHome,'run');logPath=path.join(boostCodexHome,'logs');
  runtimeVersionsPath=path.join(boostCodexHome,'runtime','versions');runtimeCurrentPath=path.join(boostCodexHome,'runtime','current.json');
  compatibilityPath=path.join(boostCodexHome,'runtime','compatibility');compatibilityStatusPath=path.join(compatibilityPath,'status.json');compatibilityVersionsPath=path.join(compatibilityPath,'versions');compatibilityCurrentPath=path.join(compatibilityPath,'current.json');
  runtimeStatePath=path.join(runPath,'runtime.json');runtimeLockPath=path.join(runPath,'runtime.lock');runtimeAuthorityPath=path.join(runPath,'runtime-authority.json');
  tokenPath=path.join(runPath,'token');injectorLogPath=path.join(logPath,'injector.log');injectorPidPath=path.join(runPath,'injector.pid');injectionStatePath=path.join(runPath,'injection.json');
  launchIntegrationStatePath=path.join(runPath,'launch-integration.json');launchLockPath=path.join(os.homedir(),'.better-codex-launch.lock');
  runtimeLogPath=path.join(logPath,'runtime.log');injectorStartLockPath=injectorPidPath+'.start';
  runtimePort=Number(process.env.BOOST_CODEX_RUNTIME_PORT ?? process.env.BOOST_CODEX_PORT ?? 0);cdpPort=Number(process.env.BOOST_CODEX_CDP_PORT ?? 9229);
}
function ensureDirectories(){for(const directory of [runPath,logPath,compatibilityPath])fs.mkdirSync(directory,{recursive:true});}
function canonicalPath(value){try{return fs.realpathSync(value);}catch{return path.resolve(value);}}
function sourceProcessArguments(args){return process.env.BOOST_CODEX_LOCAL_PROJECT ? [process.env.BOOST_CODEX_BASE_ENTRYPOINT,...args] : [process.argv[1],...args];}
function token(){ensureDirectories();if(process.env.BOOST_CODEX_TOKEN)return process.env.BOOST_CODEX_TOKEN;if(fs.existsSync(tokenPath))return fs.readFileSync(tokenPath,'utf8').trim();const value=crypto.randomBytes(32).toString('hex');fs.writeFileSync(tokenPath,value,{mode:0o600});return value;}
function appIconIco(){return fs.readFileSync(path.join(__dirname,'assets','AppIcon.ico'));}
function appIconIcns(){return fs.readFileSync(path.join(__dirname,'assets','AppIcon.icns'));}
function init_brand_assets(){}
var injectedUiBundle='',injectedUiBundleChecksum='',injectedUiBundleSchemaVersion=1;
var lucideIcons=JSON.parse(fs.readFileSync(path.join(__dirname,'assets','icons.json'),'utf8'));
function refreshLocalInjectedUi(){const file=process.env.BC_UI_FILE || path.join(__dirname,'../ui/boost-codex-ui.js');injectedUiBundle=fs.readFileSync(file,'utf8');injectedUiBundleChecksum=crypto.createHash('sha256').update(injectedUiBundle).digest('hex');}
function injectionVersion(){return activeCompatibility().version;}
function injectionBundleChecksum(){refreshLocalInjectedUi();return injectedUiBundleChecksum;}
function init_dom(){refreshLocalInjectedUi();}
function injectionScript(port,accessToken3,action,locale='zh-CN',host='codex'){
 refreshLocalInjectedUi();
 if(action==='uninstall')return `(() => { window.__boostCodexInjection__?.destroy?.(); window.__betterCodexInjection__?.destroy?.(); document.querySelectorAll('[data-boost-codex-owned="true"], [data-better-codex-owned="true"]').forEach(node => node.remove()); document.querySelectorAll('[data-boost-codex-native-hidden="true"]').forEach(node => node.removeAttribute('data-boost-codex-native-hidden')); document.documentElement.removeAttribute('data-boost-codex-open'); delete window.__boostCodexInjection__; delete window.__betterCodexInjection__; return {uninstalled:true}; })()`;
 if(!injectedUiBundle.includes('boostCodexInjected'))throw Error('injected_ui_bundle_invalid');
 const compatibility=activeCompatibility();
 return `${injectedUiBundle}\nboostCodexInjected.install(${JSON.stringify({schemaVersion:injectedUiBundleSchemaVersion,bundleChecksum:injectedUiBundleChecksum,version:compatibility.version,coreVersion,profile:boostCodexProfile,host,baseUrl:`http://127.0.0.1:${port}`,bridgeToken:accessToken3,initialLocale:locale,navigation:compatibility.navigation,lucideIcons})})`;
}
function accessToken2(){return token();}

// src/runtime-state.ts
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function processStartTime(pid) {
  try {
    const value = process.platform === "win32" ? (0, import_node_child_process.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CreationDate.ToUniversalTime().ToString('o') }`], { encoding: "utf8", windowsHide: true }).trim() : (0, import_node_child_process.execFileSync)("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function parse(path) {
  try {
    return JSON.parse((0, import_node_fs2.readFileSync)(path, "utf8"));
  } catch {
    return null;
  }
}
function readAuthority() {
  try {
    const value = JSON.parse((0, import_node_fs2.readFileSync)(runtimeAuthorityPath, "utf8"));
    if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !["claimed", "reserved"].includes(String(value.status))) throw new Error("runtime_authority_invalid");
    return value;
  } catch (error2) {
    if (error2.code === "ENOENT") return null;
    throw new Error("runtime_authority_invalid", { cause: error2 });
  }
}
function writeAuthority(authority) {
  const temporary = `${runtimeAuthorityPath}.${process.pid}.tmp`;
  const descriptor = (0, import_node_fs2.openSync)(temporary, "w", 384);
  try {
    (0, import_node_fs2.writeFileSync)(descriptor, JSON.stringify(authority));
    (0, import_node_fs2.fsyncSync)(descriptor);
  } finally {
    (0, import_node_fs2.closeSync)(descriptor);
  }
  (0, import_node_fs2.renameSync)(temporary, runtimeAuthorityPath);
  if (process.platform !== "win32") {
    const directory = (0, import_node_fs2.openSync)((0, import_node_path2.dirname)(runtimeAuthorityPath), "r");
    try {
      (0, import_node_fs2.fsyncSync)(directory);
    } finally {
      (0, import_node_fs2.closeSync)(directory);
    }
  }
}
function readRuntimeState() {
  const value = parse(runtimeStatePath);
  if (!value || !Number.isInteger(value.pid) || value.pid < 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.instanceId !== "string" || !value.instanceId) return null;
  if (!processAlive(value.pid)) return null;
  return { ...value, generation: Number.isSafeInteger(value.generation) ? Number(value.generation) : 0, handoffUpdateId: typeof value.handoffUpdateId === "string" ? value.handoffUpdateId : null, handoffRecovery: value.handoffRecovery === true, handoffHostReplacement: value.handoffHostReplacement === true };
}
function createRuntimeIdentity() {
  return {
    pid: process.pid,
    instanceId: (0, import_node_crypto2.randomUUID)(),
    version: coreVersion,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    processStartedAt: new Date(processStartTime(process.pid) ?? Date.now()).toISOString(),
    generation: 0,
    handoffUpdateId: null,
    handoffRecovery: false,
    handoffHostReplacement: false
  };
}
function claimRuntimeAuthority(identity) {
  const lock = parse(runtimeLockPath);
  if (lock?.instanceId !== identity.instanceId || lock.pid !== process.pid) throw new Error("runtime_authority_lock_mismatch");
  const current = readAuthority();
  const reserved = current?.status === "reserved";
  const continuing = Boolean(current?.status === "claimed" && current.updateId && current.runtimePid !== process.pid && !processAlive(current.runtimePid));
  const generation = reserved ? current.generation : Math.max(current?.generation || 0, identity.generation) + 1;
  const handoffUpdateId = reserved || continuing ? current.updateId : null;
  writeAuthority({
    settledUpdateId: current?.settledUpdateId ?? null,
    settledOutcome: current?.settledOutcome ?? null,
    generation,
    status: "claimed",
    runtimeInstanceId: identity.instanceId,
    runtimePid: process.pid,
    processStartedAt: identity.processStartedAt,
    updateId: handoffUpdateId,
    targetVersion: reserved || continuing ? current.targetVersion : identity.version,
    recovery: (reserved || continuing) && current.recovery === true,
    hostReplacement: (reserved || continuing) && current.hostReplacement === true,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  return { ...identity, generation, handoffUpdateId, handoffRecovery: (reserved || continuing) && current.recovery === true, handoffHostReplacement: (reserved || continuing) && current.hostReplacement === true };
}
function acquireRuntimeLock(identity) {
  ensureDirectories();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = (0, import_node_fs2.openSync)(runtimeLockPath, "wx", 384);
      (0, import_node_fs2.writeFileSync)(descriptor, JSON.stringify({ pid: process.pid, instanceId: identity.instanceId, startedAt: identity.startedAt, processStartedAt: identity.processStartedAt }));
      (0, import_node_fs2.closeSync)(descriptor);
      return;
    } catch (error2) {
      const current = parse(runtimeLockPath);
      if (current?.pid && processAlive(current.pid)) {
        const expectedStart = typeof current.processStartedAt === "string" ? Date.parse(current.processStartedAt) : NaN;
        const observedStart = processStartTime(current.pid);
        const reused = Number.isFinite(expectedStart) && observedStart !== null && Math.abs(expectedStart - observedStart) > 1500;
        let legacyStale = false;
        try {
          legacyStale = !current.processStartedAt && Date.now() - (0, import_node_fs2.statSync)(runtimeLockPath).mtimeMs > 3e4;
        } catch {
        }
        if (!reused && !legacyStale) throw new Error("runtime_already_running");
      }
      if ((0, import_node_fs2.existsSync)(runtimeLockPath)) (0, import_node_fs2.unlinkSync)(runtimeLockPath);
      if (attempt === 1) throw error2;
    }
  }
}
function publishRuntimeState(state) {
  ensureDirectories();
  const temporary = `${runtimeStatePath}.${process.pid}.tmp`;
  (0, import_node_fs2.writeFileSync)(temporary, JSON.stringify(state), { mode: 384 });
  (0, import_node_fs2.renameSync)(temporary, runtimeStatePath);
}
function runtimeIdentityHealth(identity) {
  try {
    const lock = parse(runtimeLockPath);
    const published = parse(runtimeStatePath);
    const authority = readAuthority();
    if (lock?.pid !== identity.pid || lock.instanceId !== identity.instanceId || lock.processStartedAt !== identity.processStartedAt) throw new Error("runtime_lock_identity_mismatch");
    if (!published || published.pid !== identity.pid || published.instanceId !== identity.instanceId || published.processStartedAt !== identity.processStartedAt || published.version !== identity.version || published.port !== identity.port || published.generation !== identity.generation) throw new Error("runtime_published_identity_mismatch");
    if (!authority || authority.runtimePid !== identity.pid || authority.runtimeInstanceId !== identity.instanceId || authority.processStartedAt !== identity.processStartedAt || authority.generation !== identity.generation + (authority.status === "reserved" ? 1 : 0)) throw new Error("runtime_authority_identity_mismatch");
    return { ok: true, error: null };
  } catch (error2) {
    return { ok: false, error: error2 instanceof Error ? error2.message : String(error2) };
  }
}
function clearRuntimeState(instanceId) {
  const state = parse(runtimeStatePath);
  if (state?.instanceId === instanceId && (0, import_node_fs2.existsSync)(runtimeStatePath)) (0, import_node_fs2.unlinkSync)(runtimeStatePath);
  const lock = parse(runtimeLockPath);
  if (lock?.instanceId === instanceId && (0, import_node_fs2.existsSync)(runtimeLockPath)) (0, import_node_fs2.unlinkSync)(runtimeLockPath);
}
var import_node_crypto2, import_node_child_process, import_node_fs2, import_node_path2;
var init_runtime_state = __esm({
  "src/runtime-state.ts"() {
    "use strict";
    import_node_crypto2 = require("node:crypto");
    import_node_child_process = require("node:child_process");
    import_node_fs2 = require("node:fs");
    import_node_path2 = require("node:path");
    init_config();
    init_version();
  }
});


// src/injection-state.ts
function readInjectionState() {
  try {
    return JSON.parse((0, import_node_fs3.readFileSync)(injectionStatePath, "utf8"));
  } catch {
    return {};
  }
}
function writeInjectionState(state) {
  ensureDirectories();
  const temporary = `${injectionStatePath}.${process.pid}.tmp`;
  (0, import_node_fs3.writeFileSync)(temporary, JSON.stringify(state), { mode: 384 });
  (0, import_node_fs3.renameSync)(temporary, injectionStatePath);
}
function injectionEnabled() {
  return injectionPreferenceEnabled();
}
function injectionPreferenceEnabled() {
  return readInjectionState().enabled !== false;
}
function setInjectionEnabled(enabled) {
  writeInjectionState({ ...readInjectionState(), enabled });
  return enabled;
}
function recordInjectionOwnership(profile, endpoint) {
  writeInjectionState({ ...readInjectionState(), profile, endpoint });
}
var import_node_fs3;
var init_injection_state = __esm({
  "src/injection-state.ts"() {
    "use strict";
    import_node_fs3 = require("node:fs");
    init_config();
  }
});


// src/compatibility.ts
function versionParts(version) {
  const normalized = version.replace(/^v/, "").split("+", 1)[0];
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]([A-Za-z0-9.-]+))?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split(".") : []
  };
}
function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return a ? 1 : b ? -1 : left.localeCompare(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const x = a.core[index] ?? 0;
    const y = b.core[index] ?? 0;
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === void 0 || y === void 0) return x === void 0 ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function stringArray(value, maximum = 32) {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 512);
}
function stringMap(value, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && required.every((key) => typeof value[key] === "string") && entries.every(([key, item]) => /^[A-Za-z][A-Za-z0-9]*$/.test(key) && typeof item === "string" && item.length > 0 && item.length <= 512);
}
function validateCompatibility(value, activeCoreVersion2 = coreVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("compatibility_invalid");
  const item = value;
  const allowed = ["version", "minimumCoreVersion", "supportedPlatforms", "supportedCodexVersions", "targetRules", "selectors", "attributes", "navigation"];
  if (Object.keys(item).some((key) => !allowed.includes(key))) throw new Error("compatibility_field_not_allowed");
  if (typeof item.version !== "string" || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(item.version)) throw new Error("compatibility_version_invalid");
  if (typeof item.minimumCoreVersion !== "string" || !versionParts(item.minimumCoreVersion) || compareVersions(activeCoreVersion2, item.minimumCoreVersion) < 0) throw new Error("compatibility_core_incompatible");
  if (!stringArray(item.supportedPlatforms) || !item.supportedPlatforms.every((platform) => ["darwin", "win32"].includes(platform))) throw new Error("compatibility_platforms_invalid");
  const codex = item.supportedCodexVersions;
  if (!codex || codex.strategy !== "capability" || ![null, "string"].includes(codex.minimum === null ? null : typeof codex.minimum) || ![null, "string"].includes(codex.maximumExclusive === null ? null : typeof codex.maximumExclusive)) throw new Error("compatibility_codex_range_invalid");
  const rules = item.targetRules;
  if (!rules || !stringArray(rules.urlPrefixes) || !stringArray(rules.titleTerms) || !stringArray(rules.excludedRoutes)) throw new Error("compatibility_target_rules_invalid");
  if (!stringMap(item.selectors, ["sidebarScroll", "contentLayout", "threadRow", "projectRow"])) throw new Error("compatibility_selectors_invalid");
  if (!stringMap(item.attributes, ["threadId"])) throw new Error("compatibility_attributes_invalid");
  const navigation = item.navigation;
  if (!navigation || Object.keys(navigation).some((key) => !["messageType", "threadRoutePrefix"].includes(key)) || typeof navigation.messageType !== "string" || typeof navigation.threadRoutePrefix !== "string") throw new Error("compatibility_navigation_invalid");
  return value;
}
function readCompatibilityPointer() {
  try {
    const value = JSON.parse((0, import_node_fs4.readFileSync)(compatibilityCurrentPath, "utf8"));
    if (typeof value.current !== "string" || !Number.isInteger(value.failures)) throw new Error("compatibility_pointer_invalid");
    return value;
  } catch (error2) {
    if (error2.code === "ENOENT") return null;
    throw error2;
  }
}
function activeCoreVersion() {
  try {
    const value = JSON.parse((0, import_node_fs4.readFileSync)(runtimeCurrentPath, "utf8"));
    return typeof value.current === "string" ? value.current : coreVersion;
  } catch {
    return coreVersion;
  }
}
function activeCompatibility() {
  if (process.env.BC_COMPATIBILITY_FILE) return validateCompatibility(JSON.parse(require('node:fs').readFileSync(process.env.BC_COMPATIBILITY_FILE,'utf8')),coreVersion);
  const pointer = readCompatibilityPointer();
  if (!pointer || pointer.current === bundledCompatibility.version) return bundledCompatibility;
  try {
    return validateCompatibility(JSON.parse((0, import_node_fs4.readFileSync)((0, import_node_path3.join)(compatibilityVersionsPath, pointer.current, "manifest.json"), "utf8")), activeCoreVersion());
  } catch (error2) {
    throw new Error("compatibility_package_invalid", { cause: error2 });
  }
}
function isAuxiliaryDesktopUrl(value) {
  try {
    const url = new URL(value);
    const route = new URL(url.searchParams.get("initialRoute") || url.pathname + url.search, "https://codex.local");
    return /detached-window|global-dictation|avatar-overlay/i.test(url.pathname + route.pathname) ||
      route.searchParams.get("window") === "page" || route.searchParams.get("prewarm") === "1";
  } catch { return false; }
}
function targetAllowed(target) {
  const compatibility = activeCompatibility();
  const url = target.url ?? "";
  if (isAuxiliaryDesktopUrl(url)) return false;
  if (compatibility.targetRules.excludedRoutes.some((route) => url.includes(route))) return false;
  if (/^https?:\/\//i.test(url)) return false;
  return compatibility.targetRules.urlPrefixes.some((prefix) => url.startsWith(prefix));
}
function capabilityExpression() {
  const selectors = JSON.stringify(activeCompatibility().selectors);
  return `(() => {
    const selectors = ${selectors};
    const layout = document.querySelector(selectors.contentLayout);
    const surface = layout?.parentElement || document.querySelector("main > div");
    return {
      loading: document.readyState !== "complete" || (!document.querySelector("main") && performance.now() < 30000),
      documentId: performance.timeOrigin,
      sidebar: Boolean(document.querySelector(selectors.sidebarScroll) || document.querySelector("[data-app-navigation-rail], [data-app-shell-page-sidebar]")),
      content: Boolean((layout && surface?.closest("main")) || document.querySelector("main")),
      threads: Boolean(document.querySelector(selectors.threadRow)),
      projects: Boolean(document.querySelector(selectors.projectRow))
    };
  })()`;
}
function missingCapabilities(capabilities) {
  return [capabilities.sidebar ? null : "sidebar", capabilities.content ? null : "content"].filter((value) => Boolean(value));
}
function readCompatibilityStatus() {
  const runtime = readRuntimeState();
  const base = { state: "waiting_window", compatible: false, reason: "probe_pending", version: bundledCompatibility.version, coreVersion, supportedCodexVersions: bundledCompatibility.supportedCodexVersions, platform: process.platform, codexVersion: null, targetId: null, targetUrl: null, documentId: null, capabilities: null, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), lastSuccessfulAt: null, profile: boostCodexProfile, runtimeInstanceId: runtime?.instanceId || null, runtimeGeneration: runtime?.generation ?? null };
  if (!injectionPreferenceEnabled()) return { ...base, state: "disabled", reason: "disabled" };
  let compatibility;
  try {
    compatibility = activeCompatibility();
  } catch (error2) {
    return { ...base, state: "failed", reason: "compatibility_package_invalid", error: String(error2) };
  }
  base.version = compatibility.version;
  base.supportedCodexVersions = compatibility.supportedCodexVersions;
  try {
    const value = JSON.parse((0, import_node_fs4.readFileSync)(compatibilityStatusPath, "utf8"));
    if (value.coreVersion !== coreVersion || value.version !== compatibility.version || value.profile !== boostCodexProfile || value.runtimeInstanceId !== (runtime?.instanceId || null) || value.runtimeGeneration !== (runtime?.generation ?? null) || !Number.isFinite(Date.parse(value.checkedAt)) || Date.now() - Date.parse(value.checkedAt) > 9e4) return base;
    return value;
  } catch (error2) {
    if (error2.code !== "ENOENT") return { ...base, state: "failed", reason: "compatibility_status_invalid", error: String(error2) };
    return base;
  }
}
function writeCompatibilityStatus(input, successful = false) {
  ensureDirectories();
  const compatibility = activeCompatibility();
  const runtime = readRuntimeState();
  const previous = readCompatibilityStatus();
  const now2 = /* @__PURE__ */ new Date();
  const state = input.state || (input.reason === "disabled" ? "disabled" : successful ? "ready" : input.reason?.startsWith("missing_") || input.reason === "unsupported_platform" || input.reason === "injection_bootstrap_failed" ? "failed" : "waiting_window");
  const unchanged = previous && previous.state === state && previous.runtimeInstanceId === runtime?.instanceId && previous.runtimeGeneration === runtime?.generation && previous.version === compatibility.version && previous.codexVersion === input.codexVersion && previous.compatible === input.compatible && previous.reason === input.reason && previous.targetId === input.targetId && previous.documentId === input.documentId && JSON.stringify(previous.capabilities) === JSON.stringify(input.capabilities);
  const lastWrite = previous ? Date.parse(successful ? previous.lastSuccessfulAt ?? "" : previous.checkedAt) : 0;
  if (unchanged && Number.isFinite(lastWrite) && now2.getTime() - lastWrite < 6e4) return previous;
  const value = {
    state,
    runtimeInstanceId: runtime?.instanceId || null,
    runtimeGeneration: runtime?.generation ?? null,
    profile: boostCodexProfile,
    targetUrl: input.targetUrl || null,
    documentId: input.documentId ?? input.capabilities?.documentId ?? null,
    version: compatibility.version,
    coreVersion,
    supportedCodexVersions: compatibility.supportedCodexVersions,
    platform: process.platform,
    codexVersion: input.codexVersion,
    compatible: input.compatible,
    reason: input.reason,
    error: input.error || null,
    targetId: input.targetId,
    capabilities: input.capabilities,
    checkedAt: now2.toISOString(),
    lastSuccessfulAt: successful ? now2.toISOString() : previous?.lastSuccessfulAt ?? null
  };
  const temporary = `${compatibilityStatusPath}.${process.pid}.tmp`;
  (0, import_node_fs4.writeFileSync)(temporary, JSON.stringify(value), { mode: 384 });
  (0, import_node_fs4.renameSync)(temporary, compatibilityStatusPath);
  return value;
}
function clearCompatibilityStatus() {
  return writeCompatibilityStatus({ codexVersion: null, compatible: false, reason: "disabled", targetId: null, capabilities: null });
}
var import_node_fs4, import_node_path3, bundledCompatibility;
var init_compatibility = __esm({
  "src/compatibility.ts"() {
    "use strict";
    import_node_fs4 = require("node:fs");
    import_node_path3 = require("node:path");
    init_config();
    init_runtime_state();
    init_injection_state();
    init_version();
    init_version();
    bundledCompatibility = {
      version: "0.3.10",
      minimumCoreVersion: "0.2.0",
      supportedPlatforms: ["darwin", "win32"],
      supportedCodexVersions: {
        strategy: "capability",
        minimum: null,
        maximumExclusive: null
      },
      targetRules: {
        urlPrefixes: ["app://"],
        titleTerms: ["Codex"],
        excludedRoutes: ["initialRoute=%2Fglobal-dictation", "initialRoute=%2Favatar-overlay"]
      },
      selectors: {
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
        sidebarNavigation: 'aside nav[role="navigation"]',
        sidebarNavigationItem: ".sidebar-item"
      },
      attributes: {
        threadId: "data-app-action-sidebar-thread-id",
        threadTitle: "data-app-action-sidebar-thread-title",
        threadActive: "data-app-action-sidebar-thread-active",
        projectListId: "data-app-action-sidebar-project-list-id",
        projectId: "data-app-action-sidebar-project-id",
        projectLabel: "data-app-action-sidebar-project-label"
      },
      navigation: {
        messageType: "navigate-to-route",
        threadRoutePrefix: "/local/"
      }
    };
  }
});


// src/locale.ts
function codexComputerUseConfigPath() {
  const codexHome2 = process.env.CODEX_HOME || (0, import_node_path5.join)((0, import_node_os3.homedir)(), ".codex");
  return (0, import_node_path5.join)(codexHome2, "computer-use", "config.json");
}
function normalizeCodexLocale(value) {
  const locale = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  return ["zh-cn", "zh-hans", "zh-hans-cn"].includes(locale) ? "zh-CN" : "en";
}
function readCodexLocale(configPath2 = codexComputerUseConfigPath()) {
  try {
    const parsed = JSON.parse((0, import_node_fs6.readFileSync)(configPath2, "utf8"));
    return normalizeCodexLocale(parsed?.locale);
  } catch {
    return "en";
  }
}
var import_node_fs6, import_node_os3, import_node_path5;
var init_locale = __esm({
  "src/locale.ts"() {
    "use strict";
    import_node_fs6 = require("node:fs");
    import_node_os3 = require("node:os");
    import_node_path5 = require("node:path");
  }
});


// src/native-dialog.ts
function powershellString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
function showNativeChoiceDialog(options) {
  const assetDirectory = (0, import_node_fs7.mkdtempSync)((0, import_node_path6.join)((0, import_node_os4.tmpdir)(), "boost-codex-dialog-"));
  try {
    if (process.platform === "win32") {
      const iconPath = (0, import_node_path6.join)(assetDirectory, "AppIcon.ico");
      (0, import_node_fs7.writeFileSync)(iconPath, appIconIco());
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "[System.Windows.Forms.Application]::EnableVisualStyles()",
        "$message = " + powershellString(options.message),
        "$parts = @($message -split '(?:\r?\n){2,}', 2)",
        "$heading = if ($parts.Count -gt 1) { $parts[1].Trim() } else { $message.Trim() }",
        "$detail = if ($parts.Count -gt 1) { $parts[0].Trim() } else { '' }",
        `$dialogIcon = [System.Drawing.Icon]::new(${powershellString(iconPath)})`,
        "$form = New-Object System.Windows.Forms.Form",
        `$form.Text = ${powershellString(options.title)}`,
        "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
        "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog",
        "$form.ControlBox = $true",
        "$form.MinimizeBox = $false",
        "$form.MaximizeBox = $false",
        "$form.Icon = $dialogIcon",
        "$form.ShowIcon = $true",
        "$form.ShowInTaskbar = $false",
        "$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi",
        "$form.ClientSize = [System.Drawing.Size]::new(500, 176)",
        "$form.BackColor = [System.Drawing.SystemColors]::Control",
        "$form.Font = [System.Drawing.SystemFonts]::MessageBoxFont",
        `$form.AccessibleName = ${powershellString(options.title)}`,
        "$headingLabel = New-Object System.Windows.Forms.Label",
        "$headingLabel.Text = $heading",
        "$headingLabel.Location = [System.Drawing.Point]::new(24, 22)",
        "$headingLabel.Size = [System.Drawing.Size]::new(452, 24)",
        "$headingLabel.Font = [System.Drawing.Font]::new($form.Font, [System.Drawing.FontStyle]::Bold)",
        "$headingLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft",
        "$headingLabel.AccessibleName = $heading",
        "$detailLabel = New-Object System.Windows.Forms.Label",
        "$detailLabel.Text = $detail",
        "$detailLabel.Location = [System.Drawing.Point]::new(24, 54)",
        "$detailLabel.Size = [System.Drawing.Size]::new(452, 48)",
        "$detailLabel.TextAlign = [System.Drawing.ContentAlignment]::TopLeft",
        "$detailLabel.AccessibleName = $detail",
        "$secondary = New-Object System.Windows.Forms.Button",
        `$secondary.Text = ${powershellString(options.secondaryLabel)}`,
        "$secondary.Location = [System.Drawing.Point]::new(236, 128)",
        "$secondary.Size = [System.Drawing.Size]::new(120, 29)",
        "$secondary.FlatStyle = [System.Windows.Forms.FlatStyle]::System",
        "$secondary.UseVisualStyleBackColor = $true",
        `$secondary.AccessibleName = ${powershellString(options.secondaryLabel)}`,
        "$secondary.TabIndex = 0",
        "$secondary.DialogResult = [System.Windows.Forms.DialogResult]::No",
        "$primary = New-Object System.Windows.Forms.Button",
        `$primary.Text = ${powershellString(options.primaryLabel)}`,
        "$primary.Location = [System.Drawing.Point]::new(364, 128)",
        "$primary.Size = [System.Drawing.Size]::new(120, 29)",
        "$primary.FlatStyle = [System.Windows.Forms.FlatStyle]::System",
        "$primary.UseVisualStyleBackColor = $true",
        `$primary.AccessibleName = ${powershellString(options.primaryLabel)}`,
        "$primary.TabIndex = 1",
        "$primary.DialogResult = [System.Windows.Forms.DialogResult]::Yes",
        "$form.Controls.Add($headingLabel)",
        "$form.Controls.Add($detailLabel)",
        "$form.Controls.Add($secondary)",
        "$form.Controls.Add($primary)",
        "$form.AcceptButton = $primary",
        "$form.Add_Shown({ [void]$secondary.Focus() })",
        "$result = $form.ShowDialog()",
        "$dialogIcon.Dispose()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { Write-Output 'primary' } elseif ($result -eq [System.Windows.Forms.DialogResult]::No) { Write-Output 'secondary' } else { Write-Output 'cancelled' }"
      ].join("; ");
      const output = (0, import_node_child_process2.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
      return ["primary", "secondary"].includes(output) ? output : "cancelled";
    }
    if (process.platform === "darwin") {
      const iconPath = (0, import_node_path6.join)(assetDirectory, "AppIcon.icns");
      (0, import_node_fs7.writeFileSync)(iconPath, appIconIcns());
      const primary = JSON.stringify(options.primaryLabel);
      const secondary = JSON.stringify(options.secondaryLabel);
      const output = (0, import_node_child_process2.execFileSync)("/usr/bin/osascript", ["-e", `display dialog ${JSON.stringify(options.message)} with title ${JSON.stringify(options.title)} buttons {${secondary}, ${primary}} default button ${secondary} with icon (POSIX file ${JSON.stringify(iconPath)})`], { encoding: "utf8" }).trim();
      if (output.includes(`button returned:${options.primaryLabel}`)) return "primary";
      if (output.includes(`button returned:${options.secondaryLabel}`)) return "secondary";
    }
  } catch {
    return "cancelled";
  } finally {
    (0, import_node_fs7.rmSync)(assetDirectory, { recursive: true, force: true });
  }
  return "cancelled";
}
async function chooseNativeDirectory() {
  try {
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = '\u9009\u62E9 Codex \u9879\u76EE\u6587\u4EF6\u5939'",
        "$dialog.ShowNewFolderButton = $true",
        "$result = $dialog.ShowDialog()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }"
      ].join("; ");
      return await new Promise((resolve11) => {
        (0, import_node_child_process2.execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { encoding: "utf8", windowsHide: true }, (error2, output) => resolve11(error2 ? "" : output.trim()));
      });
    }
    if (process.platform === "darwin") {
      return await new Promise((resolve11) => {
        (0, import_node_child_process2.execFile)("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "\u9009\u62E9 Codex \u9879\u76EE\u6587\u4EF6\u5939")'], { encoding: "utf8" }, (error2, output) => resolve11(error2 ? "" : output.trim().replace(/\/$/, "")));
      });
    }
  } catch {
  }
  return "";
}
var import_node_child_process2, import_node_fs7, import_node_os4, import_node_path6;
var init_native_dialog = __esm({
  "src/native-dialog.ts"() {
    "use strict";
    import_node_child_process2 = require("node:child_process");
    import_node_fs7 = require("node:fs");
    import_node_os4 = require("node:os");
    import_node_path6 = require("node:path");
    init_brand_assets();
  }
});


// src/codex-cli.ts
function unique(values) {
  return [...new Set(values.filter((value) => Boolean(value)))];
}
function existing(values) {
  return unique(values).filter((value) => (0, import_node_fs14.existsSync)(value));
}
function modifiedAt(path) {
  try {
    return (0, import_node_fs14.statSync)(path).mtimeMs;
  } catch {
    return 0;
  }
}
function windowsLocalCliCandidates(env) {
  const root = env.LOCALAPPDATA ? (0, import_node_path13.join)(env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : null;
  if (!root || !(0, import_node_fs14.existsSync)(root)) return [];
  let versioned = [];
  try {
    versioned = (0, import_node_fs14.readdirSync)(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => (0, import_node_path13.join)(root, entry.name, "codex.exe"));
  } catch {
  }
  return existing([...versioned, (0, import_node_path13.join)(root, "codex.exe")]).sort((left, right) => modifiedAt(right) - modifiedAt(left));
}
function windowsNpmCliCandidates(env, arch) {
  const packageName = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const pathValue = env.Path || env.PATH || "";
  const prefixes = unique([
    env.APPDATA ? (0, import_node_path13.join)(env.APPDATA, "npm") : null,
    ...pathValue.split(";").map((value) => value.trim().replace(/^"|"$/g, ""))
  ]);
  return existing(prefixes.flatMap((prefix) => [
    (0, import_node_path13.join)(prefix, "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe"),
    (0, import_node_path13.join)(prefix, "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe")
  ]));
}
function windowsApplicationPath() {
  try {
    return (0, import_node_child_process7.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5e3
    }).trim() || null;
  } catch {
    return null;
  }
}
function copiedWindowsApplicationCandidates(applicationPath, tempDirectory) {
  if (!applicationPath) return [];
  const sources = existing([
    (0, import_node_path13.join)(applicationPath, "app", "resources", "codex.exe"),
    (0, import_node_path13.join)(applicationPath, "resources", "codex.exe"),
    (0, import_node_path13.join)(applicationPath, "codex.exe")
  ]);
  return sources.flatMap((source) => {
    try {
      const stats = (0, import_node_fs14.statSync)(source);
      const destinationDirectory = (0, import_node_path13.join)(tempDirectory, "boost-codex", "codex-cli");
      const destination = (0, import_node_path13.join)(destinationDirectory, `codex-${stats.size}-${Math.floor(stats.mtimeMs)}.exe`);
      (0, import_node_fs14.mkdirSync)(destinationDirectory, { recursive: true });
      if (!(0, import_node_fs14.existsSync)(destination)) (0, import_node_fs14.copyFileSync)(source, destination);
      return [destination, source];
    } catch {
      return [source];
    }
  });
}
function unixLocalCliCandidates() {
  const home = (0, import_node_os9.homedir)();
  const paths = [
    (0, import_node_path13.join)(home, ".hermes", "node", "bin", "codex"),
    (0, import_node_path13.join)(home, ".local", "bin", "codex"),
    (0, import_node_path13.join)(home, ".npm-global", "bin", "codex"),
    (0, import_node_path13.join)(home, ".yarn", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex"
  ];
  return existing(paths);
}
function macApplicationCandidates(applicationPath) {
  const applications = applicationPath === void 0 ? ["/Applications/Codex.app", "/Applications/ChatGPT.app"] : [applicationPath];
  return existing(applications.map((application) => application ? (0, import_node_path13.join)(application, "Contents", "Resources", "codex") : null));
}
function codexExecutableCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const configured = [env.BOOST_CODEX_CODEX_PATH, env.CODEX_CLI_PATH];
  if (platform === "win32") {
    const applicationPath = options.applicationPath === void 0 ? windowsApplicationPath() : options.applicationPath;
    return unique([
      ...configured,
      ...windowsLocalCliCandidates(env),
      ...windowsNpmCliCandidates(env, arch),
      ...copiedWindowsApplicationCandidates(applicationPath, options.tempDirectory ?? (0, import_node_os9.tmpdir)()),
      "codex"
    ]);
  }
  if (platform === "darwin") return unique([...configured, ...macApplicationCandidates(options.applicationPath), ...unixLocalCliCandidates(), "codex"]);
  if (platform === "linux") return unique([...configured, ...unixLocalCliCandidates(), "codex"]);
  return unique([...configured, "codex"]);
}
function probeCodexExecutable(executable) {
  try {
    (0, import_node_child_process7.execFileSync)(executable, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
function resolveCodexExecutable(options = {}) {
  const probe = options.probe ?? probeCodexExecutable;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const local = codexExecutableCandidates({ ...options, applicationPath: null }).find(probe);
    if (local) return local;
    const applicationPath = options.applicationPath === void 0 ? windowsApplicationPath() : options.applicationPath;
    return codexExecutableCandidates({ ...options, applicationPath }).find(probe) ?? null;
  }
  return codexExecutableCandidates(options).find(probe) ?? null;
}
function createCodexExecutablePathResolver(discover = () => resolveCodexExecutable(), pathExists = import_node_fs14.existsSync, platform = process.platform) {
  let cachedExecutable;
  return () => {
    const absolute = cachedExecutable && (platform === "win32" ? import_node_path13.win32.isAbsolute(cachedExecutable) : import_node_path13.posix.isAbsolute(cachedExecutable));
    if (!cachedExecutable || absolute && !pathExists(cachedExecutable)) cachedExecutable = discover() ?? "codex";
    return cachedExecutable;
  };
}
function codexExecutablePath() {
  return cachedCodexExecutablePath();
}
function requireCodexExecutablePath(options = {}) {
  const executable = resolveCodexExecutable(options);
  if (!executable) throw new Error("codex_cli_not_found");
  return executable;
}
var import_node_child_process7, import_node_fs14, import_node_os9, import_node_path13, cachedCodexExecutablePath;
var init_codex_cli = __esm({
  "src/codex-cli.ts"() {
    "use strict";
    import_node_child_process7 = require("node:child_process");
    import_node_fs14 = require("node:fs");
    import_node_os9 = require("node:os");
    import_node_path13 = require("node:path");
    cachedCodexExecutablePath = createCodexExecutablePathResolver();
  }
});


// src/codex-usage.ts
function finiteNumber(value) {
  if (value === null || value === void 0 || typeof value === "boolean" || typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function normalizeWindow(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  const usedPercent = finiteNumber(source.usedPercent);
  const windowDurationMins = finiteNumber(source.windowDurationMins);
  const resetsAt = finiteNumber(source.resetsAt);
  if (usedPercent === null || windowDurationMins === null || resetsAt === null || windowDurationMins <= 0 || resetsAt <= 0) return null;
  const used = Math.min(100, Math.max(0, Math.round(usedPercent)));
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    windowDurationMins: Math.round(windowDurationMins),
    resetsAt: Math.round(resetsAt)
  };
}
function normalizeCodexUsage(value) {
  if (!value || typeof value !== "object") return null;
  const result2 = value;
  const buckets = result2.rateLimitsByLimitId;
  const codexBucket = buckets && typeof buckets === "object" ? buckets.codex ?? Object.values(buckets).find((bucket) => bucket && typeof bucket === "object" && bucket.limitId === "codex") : null;
  for (const source of [codexBucket, result2.rateLimits]) {
    if (!source || typeof source !== "object") continue;
    const primary = normalizeWindow(source.primary);
    const secondary = normalizeWindow(source.secondary);
    if (!primary && !secondary) continue;
    return {
      planType: typeof source.planType === "string" ? source.planType.trim().slice(0, 40) : "",
      primary,
      secondary
    };
  }
  return null;
}
function queryCodexUsage(executable) {
  return new Promise((resolve11, reject) => {
    const maxOutputBytes = 1048576;
    const maxLineBytes2 = 262144;
    const child = (0, import_node_child_process11.spawn)(executable, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    let initialized = false;
    const finish = (error2, usage2) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners("data");
      child.stdout.destroy();
      child.stdin.destroy();
      child.kill();
      if (error2) reject(error2);
      else if (usage2) resolve11(usage2);
      else reject(new Error("codex_usage_empty"));
    };
    const timer = setTimeout(() => finish(new Error("codex_usage_timeout")), 5e3);
    child.on("error", (error2) => finish(error2));
    child.stdin.on("error", (error2) => finish(error2));
    child.on("close", () => finish(new Error("codex_usage_process_closed")));
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) return finish(new Error("codex_usage_output_too_large"));
      output += String(chunk);
      const lines = output.split(/\r?\n/);
      output = lines.pop() || "";
      if (Buffer.byteLength(output) > maxLineBytes2) return finish(new Error("codex_usage_line_too_large"));
      for (const line of lines) {
        if (Buffer.byteLength(line) > maxLineBytes2) return finish(new Error("codex_usage_line_too_large"));
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) return finish(new Error("codex_usage_initialize_failed"));
            initialized = true;
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
            continue;
          }
          if (!initialized) continue;
          if (message.id !== 2) continue;
          if (message.error) return finish(new Error("codex_usage_request_failed"));
          const usage2 = normalizeCodexUsage(message.result);
          return usage2 ? finish(void 0, usage2) : finish(new Error("codex_usage_empty"));
        } catch {
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "boost-codex", title: "boostCodex", version: coreVersion }, capabilities: { experimentalApi: true } } });
  });
}
function refreshCodexUsage() {
  if (usageRefresh) return usageRefresh;
  const refresh = (async () => {
    try {
      cachedUsage = { expiresAt: Date.now() + 6e4, value: process.env.NODE_TEST_CONTEXT ? null : normalizeCodexUsage(await nativeSession.readUsage()) };
    } catch {
      cachedUsage = { expiresAt: Date.now() + 15e3, value: null };
    }
  })().finally(() => {
    if (usageRefresh === refresh) usageRefresh = null;
  });
  usageRefresh = refresh;
  return refresh;
}
async function readCodexUsage() {
  if (!cachedUsage || cachedUsage.expiresAt <= Date.now()) await refreshCodexUsage();
  return cachedUsage?.value ?? null;
}
var import_node_child_process11, cachedUsage, usageRefresh;
var init_codex_usage = __esm({
  "src/codex-usage.ts"() {
    "use strict";
    import_node_child_process11 = require("node:child_process");
    init_compatibility();
    init_codex_cli();
    cachedUsage = null;
    usageRefresh = null;
  }
});


// src/cdp.ts
var import_node_child_process3 = require("node:child_process");
var import_node_crypto3 = require("node:crypto");
var import_node_fs8 = require("node:fs");
var import_node_path7 = require("node:path");
init_compatibility();
init_config();
init_dom();
init_injection_state();
init_locale();
init_native_dialog();
init_runtime_state();
var cdpHttpTimeoutMs = 1500;
var cdpWebSocketOpenTimeoutMs = 2e3;
var cdpCommandTimeoutMs = 8e3;
var cdpTargetScanTimeoutMs = 3e4;
var cdpTargetCandidateLimit = 32;
var injectionIdentityExpression = "({ version: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.version || null, bundleChecksum: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.bundleChecksum || null, profile: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.profile || null, endpoint: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.endpoint || null, pulse: typeof (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.pulse === 'function', ready: typeof (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.ready === 'function' && Boolean((window.__boostCodexInjection__ || window.__betterCodexInjection__).ready()), documentId: performance.timeOrigin, bootstrapError: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.bootstrapError?.() || null })";
function currentInjectionMatches(existing2, endpoint) {
  return existing2.version === injectionVersion() && existing2.bundleChecksum === injectionBundleChecksum() && existing2.profile === boostCodexProfile && existing2.endpoint === endpoint && existing2.pulse;
}
var Connection = class {
  constructor(url, openTimeoutMs = cdpWebSocketOpenTimeoutMs, commandTimeoutMs = cdpCommandTimeoutMs, deadlineAt) {
    this.openTimeoutMs = openTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.deadlineAt = deadlineAt;
    this.socket = new WebSocket(url);
  }
  openTimeoutMs;
  commandTimeoutMs;
  deadlineAt;
  sequence = 0;
  socket;
  timeoutBudget(limit) {
    if (this.deadlineAt === void 0) return limit;
    return Math.max(1, Math.min(limit, this.deadlineAt - Date.now()));
  }
  open() {
    return new Promise((resolve11, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve11();
      };
      const onError = () => {
        cleanup();
        reject(new Error("cdp_websocket_error"));
      };
      const timer = setTimeout(() => {
        cleanup();
        try {
          this.socket.close();
        } catch {
        }
        reject(new Error("cdp_websocket_timeout"));
      }, this.timeoutBudget(this.openTimeoutMs));
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve11, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("message", onMessage);
        this.socket.removeEventListener("close", onClose);
        this.socket.removeEventListener("error", onError);
      };
      const finish = (error2, result2) => {
        cleanup();
        if (error2) reject(error2);
        else resolve11(result2 ?? {});
      };
      const onMessage = (event) => {
        let reply;
        try {
          reply = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (reply.id !== id) return;
        if (reply.error) finish(new Error(reply.error.message ?? "cdp_error"));
        else finish(null, reply.result ?? {});
      };
      const onClose = () => finish(new Error(`cdp_closed_${method}`));
      const onError = () => finish(new Error("cdp_websocket_error"));
      const timer = setTimeout(() => finish(new Error(`cdp_timeout_${method}`)), this.timeoutBudget(this.commandTimeoutMs));
      this.socket.addEventListener("message", onMessage);
      this.socket.addEventListener("close", onClose, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error2) {
        finish(error2 instanceof Error ? error2 : new Error("cdp_send_failed"));
      }
    });
  }
  on(method, listener) {
    const handler = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.method === method && reply.params) listener(reply.params);
    };
    this.socket.addEventListener("message", handler);
    return () => this.socket.removeEventListener("message", handler);
  }
  onClose(listener) {
    this.socket.addEventListener("close", listener, { once: true });
    return () => this.socket.removeEventListener("close", listener);
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve11) => {
      this.socket.addEventListener("close", () => resolve11(), { once: true });
      this.socket.addEventListener("error", () => resolve11(), { once: true });
    });
    try {
      if (this.socket.readyState !== WebSocket.CLOSING) this.socket.close();
    } catch {
      return;
    }
    await Promise.race([closed, new Promise((resolve11) => setTimeout(resolve11, 500))]);
    await new Promise((resolve11) => setTimeout(resolve11, 100));
  }
};
async function bridgeRequest(connection, runtimePort2, accessToken3, payload) {
  let requestId = "";
  let traceId = "";
  let path = "";
  let method = "GET";
  let result2;
  try {
    const request2 = JSON.parse(String(payload));
    requestId = typeof request2.id === "string" ? request2.id : "";
    path = typeof request2.path === "string" ? request2.path : "";
    method = typeof request2.method === "string" ? request2.method : "GET";
    traceId = typeof request2.traceId === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(request2.traceId) ? request2.traceId : (0, import_node_crypto3.randomUUID)();
    const accountMetadataPath = /^\/api\/dev\/account-metadata(?:\/cancel)?(?:[?]|$)/.test(path);
    const optimizerSettings = /^\/api\/dev\/prompt-optimizer\/settings(?:[?]|$)/.test(path);
    const optimizerRequest = /^\/api\/dev\/prompt-optimizer\/optimize(?:[?]|$)/.test(path);
    const workflowPanel = /^\/api\/dev\/workflow\/panel-url(?:[?]|$)/.test(path);
    const subagentRead = /^\/api\/dev\/subagents(?:\/work)?(?:[?]|$)/.test(path);
    if (!requestId || request2.token !== accessToken3 || !(accountMetadataPath || optimizerSettings || optimizerRequest || workflowPanel || subagentRead || /^\/api\/account\/usage(?:[?]|$)/.test(path)) || !["GET", "POST"].includes(method) || (/^\/api\/account\/usage(?:[?]|$)/.test(path) || subagentRead) && method !== "GET" || (accountMetadataPath || optimizerRequest || workflowPanel) && method !== "POST") throw new Error("invalid_bridge_request");
    // Account metadata has a 12s upstream deadline. Allow it to complete and
    // return a bounded result before the renderer's 18s deadline. Other bridge
    // requests retain their normal timeout; cancellation remains short.
    const requestTimeoutMs = workflowPanel ? 40000 : optimizerRequest ? 95000 : /^\/api\/dev\/account-metadata(?:[?]|$)/.test(path) ? 15000 :
      /^\/api\/dev\/account-metadata\/cancel(?:[?]|$)/.test(path) ? 5000 : cdpCommandTimeoutMs;
    const response = await fetch(`http://127.0.0.1:${runtimePort2}${path}`, {
      method,
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        authorization: `Bearer ${accessToken3}`,
        "content-type": "application/json",
        "x-boost-codex-trace-id": traceId
      },
      body: typeof request2.body === "string" && method !== "GET" ? request2.body : void 0
    });
    const value = await response.json();
    result2 = response.ok ? { ok: true, status: response.status, value } : { ok: false, status: response.status, value: { ...value, diagnostics: { source: "cdp_bridge_request", trace_id: traceId, method, path, http_status: response.status } } };
  } catch (error2) {
    result2 = { ok: false, status: 0, value: { error: error2 instanceof Error ? error2.message : "runtime_unavailable", diagnostics: { source: "cdp_bridge_request", trace_id: traceId, method, path, failure_type: "transport" } } };
  }
  if (!requestId) return;
  await evaluate(connection, `window.__boostCodexBridgeResolve?.(${JSON.stringify(requestId)}, ${JSON.stringify(result2)})`);
}
async function cdpJson(port, path, timeoutMs = cdpHttpTimeoutMs) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    if (!response.ok) throw new Error(`cdp_http_${response.status}`);
    return await response.json();
  } catch (error2) {
    if (error2 instanceof Error && error2.message.startsWith("cdp_http_")) throw error2;
    const suffix = error2 instanceof Error && ["AbortError", "TimeoutError"].includes(error2.name) ? "_timeout" : "";
    throw new Error(`cdp_unavailable_${port}${suffix}`);
  }
}
function debuggerUrlAllowed(value, port) {
  try {
    const url = new URL(value);
    const hostname2 = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return url.protocol === "ws:" && ["127.0.0.1", "::1", "localhost"].includes(hostname2) && Number(url.port) === port && !url.username && !url.password;
  } catch {
    return false;
  }
}
function darwinCdpListenerTrusted(listeners, currentUid, application) {
  return listeners.length > 0 && new Set(listeners.map((listener) => listener.socket)).size === 1 && listeners.every((listener) => listener.uid === currentUid) && listeners.some((listener) => listener.executable.startsWith(`${application}/Contents/`));
}
function assertTrustedCdpListener(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("cdp_port_invalid");
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference = 'Stop'
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$listenerErrors = @()
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue -ErrorVariable listenerErrors | Select-Object -ExpandProperty OwningProcess -Unique)
if (@($listenerErrors | Where-Object { $_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound,*' }).Count -gt 0) { exit 1 }
if ($listeners.Count -eq 0) { exit 2 }
$trusted = @($listeners | ForEach-Object {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $_"
  if (-not $process -or $process.Name -ne 'ChatGPT.exe' -or $process.SessionId -ne $sessionId -or $process.ExecutablePath -notlike '*\\WindowsApps\\OpenAI.Codex_*') { return }
  try { if ((Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $ownerSid) { $process.ProcessId } } catch {}
})
if ($trusted.Count -ne 1 -or $listeners.Count -ne 1) { exit 1 }
Write-Output $trusted[0]`;
    try {
      const result2 = (0, import_node_child_process3.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 5e3, stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (!/^\d+$/.test(result2)) throw new Error("cdp_listener_untrusted");
      return;
    } catch (error2) {
      if (error2?.status === 2) throw new Error("cdp_listener_absent");
      throw new Error("cdp_listener_untrusted");
    }
  }
  if (process.platform === "darwin") {
    let output = "";
    try {
      output = (0, import_node_child_process3.execFileSync)("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F0pd"], { encoding: "utf8", timeout: 5e3 });
    } catch (error2) {
      const stdout = error2 && typeof error2 === "object" && "stdout" in error2 ? String(error2.stdout ?? "") : "";
      if (!stdout.trim()) throw new Error("cdp_listener_absent");
      output = stdout;
    }
    try {
      const fields = output.split(/[\0\r\n]+/).filter(Boolean);
      let pid = "";
      const sockets = fields.flatMap((field) => {
        if (/^p\d+$/.test(field)) {
          pid = field.slice(1);
          return [];
        }
        return pid && /^d.+/.test(field) ? [{ pid, socket: field.slice(1) }] : [];
      });
      if (!sockets.length) throw new Error("cdp_listener_absent");
      const application = desktopApplication();
      const listeners = sockets.map((listener) => {
        const uid = (0, import_node_child_process3.execFileSync)("/bin/ps", ["-p", listener.pid, "-o", "uid="], { encoding: "utf8", timeout: 5e3 }).trim();
        const executable = (0, import_node_child_process3.execFileSync)("/usr/sbin/lsof", ["-a", "-p", listener.pid, "-d", "txt", "-Fn"], { encoding: "utf8", timeout: 5e3 }).split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1) || "";
        return { socket: listener.socket, uid: Number(uid), executable };
      });
      if (!darwinCdpListenerTrusted(listeners, process.getuid?.(), application)) throw new Error("cdp_listener_untrusted");
      return;
    } catch (error2) {
      if (error2 instanceof Error && ["cdp_listener_absent", "cdp_listener_untrusted", "codex_app_not_found"].includes(error2.message)) throw error2;
      throw new Error("cdp_listener_untrusted");
    }
  }
}
async function targets(port, timeoutMs = cdpHttpTimeoutMs, verifyListener = true) {
  if (verifyListener) assertTrustedCdpListener(port);
  const values = await cdpJson(port, "/json/list", timeoutMs);
  return values.filter((target) => target.type === "page" && target.webSocketDebuggerUrl && debuggerUrlAllowed(target.webSocketDebuggerUrl, port) && target.id && targetAllowed(target));
}
async function browserDebuggerUrl(port) {
  assertTrustedCdpListener(port);
  const value = await cdpJson(port, "/json/version");
  if (typeof value.webSocketDebuggerUrl !== "string" || !debuggerUrlAllowed(value.webSocketDebuggerUrl, port)) throw new Error("cdp_browser_websocket_unavailable");
  return value.webSocketDebuggerUrl;
}
async function evaluate(connection, expression) {
  const result2 = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const payload = result2.result;
  return payload?.value;
}
function targetTimeout(options, limit) {
  const requestLimit = options.requestTimeoutMs === void 0 ? limit : Math.min(limit, options.requestTimeoutMs);
  if (options.deadlineAt === void 0) return Math.max(1, requestLimit);
  return Math.max(1, Math.min(requestLimit, options.deadlineAt - Date.now()));
}
async function mainTargets(port, options = {}) {
  const boundedOptions = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + cdpTargetScanTimeoutMs };
  if (!activeCompatibility().supportedPlatforms.some((platform) => platform === process.platform)) {
    writeCompatibilityStatus({ codexVersion: null, compatible: false, reason: "unsupported_platform", targetId: null, capabilities: null });
    throw new Error(`codex_incompatible_unsupported_platform_${process.platform}`);
  }
  const discovered = await targets(port, targetTimeout(boundedOptions, cdpHttpTimeoutMs));
  const candidates = boundedOptions.trustIds?.size ? [
    ...discovered.filter((target) => boundedOptions.trustIds.has(target.id)),
    ...discovered.filter((target) => !boundedOptions.trustIds.has(target.id))
  ].slice(0, cdpTargetCandidateLimit) : discovered.slice(0, cdpTargetCandidateLimit);
  const selected = [];
  const codexVersion2 = desktopVersion();
  let lastReason = "renderer_not_found";
  let lastTargetId = null;
  let lastCapabilities = null;
  let compatibleCapabilities = null;
  for (const target of candidates) {
    if (boundedOptions.trustIds?.has(target.id)) {
      selected.push(target);
      continue;
    }
    if (Date.now() >= boundedOptions.deadlineAt) throw new Error(`cdp_unavailable_${port}_timeout`);
    const connection = new Connection(
      target.webSocketDebuggerUrl,
      targetTimeout(boundedOptions, cdpWebSocketOpenTimeoutMs),
      targetTimeout(boundedOptions, cdpCommandTimeoutMs),
      boundedOptions.deadlineAt
    );
    try {
      await connection.open();
      const capabilities = await evaluate(connection, capabilityExpression());
      const missing = missingCapabilities(capabilities);
      lastTargetId = target.id;
      lastCapabilities = capabilities;
      if (missing.length === 0) {
        selected.push(target);
        compatibleCapabilities ??= capabilities;
      } else if (capabilities.loading) {
        lastReason = "renderer_loading";
      } else {
        lastReason = `missing_${missing.join("_")}`;
      }
    } catch {
      lastReason = "renderer_probe_failed";
      lastTargetId = target.id;
      lastCapabilities = null;
    } finally {
      await connection.close();
    }
  }
  if (selected.length > 0) {
    if (!boundedOptions.trustIds?.size) {
      writeCompatibilityStatus({ codexVersion: codexVersion2, compatible: true, reason: null, targetId: selected[0].id, capabilities: compatibleCapabilities });
    }
    return selected;
  }
  if (Date.now() >= boundedOptions.deadlineAt) throw new Error(`cdp_unavailable_${port}_timeout`);
  writeCompatibilityStatus({ codexVersion: codexVersion2, compatible: false, reason: lastReason, targetId: lastTargetId, capabilities: lastCapabilities });
  if (lastReason.startsWith("missing_")) throw new Error(`codex_incompatible_${lastReason}`);
  return [];
}
var cachedCodexVersion;
function desktopVersion() {
  if (cachedCodexVersion !== void 0) return cachedCodexVersion;
  try {
    if (process.platform === "darwin") {
      cachedCodexVersion = (0, import_node_child_process3.execFileSync)("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", (0, import_node_path7.join)(desktopApplication(), "Contents", "Info.plist")], { encoding: "utf8" }).trim() || null;
    } else if (process.platform === "win32") {
      cachedCodexVersion = (0, import_node_child_process3.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty Version)"], { encoding: "utf8", windowsHide: true }).trim() || null;
    } else {
      cachedCodexVersion = null;
    }
  } catch {
    cachedCodexVersion = null;
  }
  return cachedCodexVersion;
}
function desktopApplication() {
  const application = ["/Applications/Codex.app", "/Applications/ChatGPT.app"].find(import_node_fs8.existsSync);
  if (!application) throw new Error("codex_app_not_found");
  return application;
}
function codexInstallationStatus() {
  if (process.platform === "darwin") {
    const path = ["/Applications/Codex.app", "/Applications/ChatGPT.app"].find(import_node_fs8.existsSync) ?? null;
    return { installed: Boolean(path), platform: process.platform, path, version: path ? desktopVersion() : null };
  }
  if (process.platform === "win32") {
    try {
      const value = (0, import_node_child_process3.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($app) { $app | Select-Object Name, Version, InstallLocation | ConvertTo-Json -Compress }"], { encoding: "utf8", windowsHide: true }).trim();
      if (!value) return { installed: false, platform: process.platform, path: null, version: null };
      const app = JSON.parse(value);
      return { installed: true, platform: process.platform, path: app.InstallLocation ?? null, version: app.Version ?? desktopVersion() };
    } catch {
      return { installed: false, platform: process.platform, path: null, version: null };
    }
  }
  return { installed: false, platform: process.platform, path: null, version: null };
}
function desktopApplicationBundleId(application) {
  const bundleId = (0, import_node_child_process3.execFileSync)("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", (0, import_node_path7.join)(application, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  if (!bundleId) throw new Error("codex_app_bundle_id_unavailable");
  return bundleId;
}
function windowsActivationScript(port, allowExisting = false) {
  return `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try {
$runningMainProcess = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
  Where-Object { $_.CommandLine -notmatch "--type=" } |
  Select-Object -First 1
if ($runningMainProcess -and ${allowExisting ? "$false" : "$true"}) {
  throw "Codex is already running without CDP. Quit Codex completely and try again."
}

$codexApp = Get-StartApps |
  Where-Object { $_.AppID -like "OpenAI.Codex_*!App" } |
  Select-Object -First 1
if (-not $codexApp) {
  throw "The Microsoft Store Codex application is not installed for this Windows user."
}

$activationSource = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  [PreserveSig]
  int ActivateApplication(
    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments,
    uint options,
    out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager {}

public static class boostCodexApplication {
  public static uint Activate(string appUserModelId, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint processId;
    int result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
    Marshal.ThrowExceptionForHR(result);
    return processId;
  }
}
'@

Add-Type -TypeDefinition $activationSource
$arguments = "--remote-debugging-port=${port} --remote-allow-origins=http://127.0.0.1:${port}"
[void][boostCodexApplication]::Activate($codexApp.AppID, $arguments)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
}
function launchCodex(port, activateExisting = false) {
  if (process.platform === "darwin") {
    const application = desktopApplication();
    const child = (0, import_node_child_process3.spawn)("/usr/bin/open", [
      ...activateExisting ? [] : ["-n"],
      "-a",
      application,
      "--args",
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`
    ], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  if (process.platform === "win32") {
    const encoded = Buffer.from(windowsActivationScript(port, activateExisting), "utf16le").toString("base64");
    try {
      (0, import_node_child_process3.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", encoded], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error2) {
      const output = error2 && typeof error2 === "object" ? String("stderr" in error2 ? error2.stderr : "stdout" in error2 ? error2.stdout : "").trim() : "";
      throw new Error(output || "codex_windows_launch_failed");
    }
    return;
  }
  throw new Error(`codex_launch_unsupported_${process.platform}`);
}
function requiresCodexRestartForLaunch(codexRunning, platform = process.platform) {
  return platform === "win32" && codexRunning;
}
function codexProcessRunning() {
  if (process.platform === "win32") {
    const processes = (0, import_node_child_process3.execFileSync)("tasklist.exe", ["/FI", "IMAGENAME eq ChatGPT.exe", "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
    return /"ChatGPT\.exe"/i.test(processes);
  }
  if (process.platform !== "darwin") return false;
  const application = desktopApplication();
  const bundleId = desktopApplicationBundleId(application);
  const appleScriptBundleId = bundleId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const result2 = (0, import_node_child_process3.execFileSync)("/usr/bin/osascript", ["-e", `tell application id "${appleScriptBundleId}" to return running`], { encoding: "utf8" }).trim();
    return result2 === "true";
  } catch {
    return false;
  }
}
function chooseCodexRestartAction() {
  if (process.env.BOOST_CODEX_LOCAL_PROJECT) return 'reuse-current';
  const chinese = readCodexLocale() === "zh-CN";
  const choice = showNativeChoiceDialog({
    message: chinese ? "\u201C\u91CD\u7F6E\u670D\u52A1\u201D\u53EA\u4F1A\u91CD\u542F boostCodex Runtime\uFF1B\u201C\u91CD\u542FCodex\u201D\u4F1A\u5173\u95ED\u5E76\u91CD\u65B0\u6253\u5F00\u6574\u4E2A Codex\u3002\n\nboostCodex \u5DF2\u5728\u8FD0\u884C\u3002" : "Reset Service restarts only the boostCodex Runtime. Restart Codex closes and reopens the entire Codex app.\n\nboostCodex is already running.",
    title: "boostCodex",
    primaryLabel: chinese ? "\u91CD\u542FCodex" : "Restart Codex",
    secondaryLabel: chinese ? "\u91CD\u7F6E\u670D\u52A1" : "Reset Service"
  });
  if (choice === "primary") return "restart-codex";
  if (choice === "secondary") return "reset-runtime";
  return "cancelled";
}
function windowsCodexPackageProcessPowerShell(action) {
  const ownedPackageProcesses = `& { $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId; $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object { if ($_.SessionId -ne $sessionId -or $_.ExecutablePath -notlike "*\\WindowsApps\\OpenAI.Codex_*") { return $false }; try { return (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop).Sid -eq $ownerSid } catch { return $false } }) }`;
  if (action === "stop") {
    return `$processes = @(${ownedPackageProcesses}); if ($processes.Count -gt 0) { $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; exit 0`;
  }
  return `$processes = @(${ownedPackageProcesses}); $count = @($processes).Count; Write-Output $count; exit 0`;
}
async function quitCodex() {
  if (process.platform === "win32") {
    const stopPackageProcesses = windowsCodexPackageProcessPowerShell("stop");
    const countPackageProcesses = windowsCodexPackageProcessPowerShell("count");
    (0, import_node_child_process3.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopPackageProcesses], { stdio: "ignore", windowsHide: true });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const count = (0, import_node_child_process3.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", countPackageProcesses], { encoding: "utf8", windowsHide: true }).trim();
      if (Number(count) === 0) return;
      await new Promise((resolve11) => setTimeout(resolve11, 250));
    }
    throw new Error("codex_quit_timeout");
  }
  if (process.platform !== "darwin") throw new Error(`codex_quit_unsupported_${process.platform}`);
  const application = desktopApplication();
  const bundleId = desktopApplicationBundleId(application);
  const appleScriptBundleId = bundleId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const running = () => {
    try {
      const result2 = (0, import_node_child_process3.execFileSync)("/usr/bin/osascript", ["-e", `tell application id "${appleScriptBundleId}" to return running`], { encoding: "utf8" }).trim();
      return result2 === "true";
    } catch {
      return false;
    }
  };
  try {
    (0, import_node_child_process3.execFileSync)("/usr/bin/osascript", ["-e", `tell application id "${appleScriptBundleId}" to quit`], { stdio: "ignore" });
  } catch {
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!running()) return;
    await new Promise((resolve11) => setTimeout(resolve11, 250));
  }
  throw new Error("codex_quit_timeout");
}
async function waitForTargetsWithin(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let incompatibility = null;
  while (Date.now() < deadline) {
    try {
      const values = await mainTargets(port, { deadlineAt: deadline });
      if (values.length > 0) return values;
    } catch (error2) {
      if (error2 instanceof Error && error2.message.startsWith("codex_incompatible_")) {
        incompatibility = error2;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve11) => setTimeout(resolve11, 150));
  }
  if (incompatibility) throw incompatibility;
  throw new Error(`cdp_unavailable_${port}`);
}
async function waitForTargets(port) {
  return waitForTargetsWithin(port, 3e4);
}
async function recordDesktopIntegration(connection, target, expectedEndpoint) {
  const identity = await evaluate(connection, injectionIdentityExpression);
  const current = readCompatibilityStatus();
  const ready = Boolean(currentInjectionMatches(identity, expectedEndpoint)) && identity.ready === true;
  const failed = identity.bootstrapError && !/fetch|network|timeout|runtime_|update_|503|reconnecting/i.test(identity.bootstrapError);
  return writeCompatibilityStatus({ codexVersion: current?.codexVersion ?? desktopVersion(), compatible: ready, reason: ready ? null : failed ? "injection_bootstrap_failed" : "bootstrap_pending", error: identity.bootstrapError || null, targetId: target.id, targetUrl: target.url, documentId: identity.documentId, capabilities: current?.capabilities ?? null }, ready);
}
async function installTarget(target, runtimePort2, accessToken3) {
  const connection = new Connection(target.webSocketDebuggerUrl);
  try {
    await connection.open();
    await connection.send("Page.enable");
    await connection.send("Page.setBypassCSP", { enabled: true });
    await connection.send("Runtime.enable");
    try {
      await connection.send("Runtime.addBinding", { name: "boostCodexRequest" });
    } catch {
    }
    const existing2 = await evaluate(connection, injectionIdentityExpression);
    const expectedEndpoint = `http://127.0.0.1:${runtimePort2}`;
    const foreignDevelopmentInjection = boostCodexProfile === "development" && (existing2.profile && existing2.profile !== boostCodexProfile || !existing2.profile && existing2.endpoint && existing2.endpoint !== expectedEndpoint);
    if (foreignDevelopmentInjection) throw new Error("profile_not_active");
    const storedIdentifier = await evaluate(connection, "window.__boostCodexNewDocumentScriptId || window.__betterCodexNewDocumentScriptId || null");
    if (currentInjectionMatches(existing2, expectedEndpoint)) {
      await evaluate(connection, "window.__boostCodexInjection__.refresh()");
      await recordDesktopIntegration(connection, target, expectedEndpoint);
      return { targetId: target.id, title: target.title, installed: true, reused: true, identifier: typeof storedIdentifier === "string" ? storedIdentifier : void 0 };
    }
    if (typeof storedIdentifier === "string" && storedIdentifier) {
      try {
        await connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: storedIdentifier });
      } catch {
      }
    }
    const source = injectionScript(runtimePort2, accessToken3, "install", readCodexLocale());
    const registration = await connection.send("Page.addScriptToEvaluateOnNewDocument", { source });
    const identifier = String(registration.identifier ?? "");
    await evaluate(connection, source);
    await evaluate(connection, `window.__boostCodexNewDocumentScriptId = ${JSON.stringify(identifier)}; delete window.__betterCodexNewDocumentScriptId`);
    await recordDesktopIntegration(connection, target, expectedEndpoint);
    return { targetId: target.id, title: target.title, installed: true, reused: false, identifier };
  } finally {
    await connection.close();
  }
}
async function uninstallTarget(target, accessToken3, ownership) {
  const connection = new Connection(target.webSocketDebuggerUrl);
  try {
    await connection.open();
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    const existing2 = await evaluate(connection, "({ profile: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.profile || null, endpoint: (window.__boostCodexInjection__ || window.__betterCodexInjection__)?.endpoint || null })");
    if (ownership) {
      const owned = existing2.profile ? existing2.profile === ownership.profile : Boolean(ownership.allowLegacyProfileless || ownership.endpoint && existing2.endpoint === ownership.endpoint);
      if (!owned) return { targetId: target.id, title: target.title, uninstalled: false, reason: "profile_not_active" };
    }
    const stored = await evaluate(connection, "window.__boostCodexNewDocumentScriptId || window.__betterCodexNewDocumentScriptId || null");
    const scriptIdentifier = typeof stored === "string" ? stored : "";
    if (scriptIdentifier) {
      try {
        await connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptIdentifier });
      } catch {
      }
    }
    const value = await evaluate(connection, injectionScript(0, accessToken3, "uninstall"));
    return { targetId: target.id, title: target.title, uninstalled: true, value };
  } finally {
    await connection.close();
  }
}
async function cdpInject(port, runtimePort2, accessToken3, launch = false) {
  let values;
  try {
    values = await mainTargets(port);
  } catch (error2) {
    if (error2 instanceof Error && error2.message.startsWith("codex_incompatible_")) values = await waitForTargets(port);
    else if (!launch) throw error2;
    else {
      launchCodex(port);
      values = await waitForTargets(port);
    }
  }
  if (values.length === 0 && launch) {
    launchCodex(port);
    values = await waitForTargets(port);
  }
  if (values.length === 0) throw new Error("cdp_main_renderer_not_found");
  const installed = await Promise.all(values.map((target) => installTarget(target, runtimePort2, accessToken3)));
  recordInjectionOwnership(boostCodexProfile, `http://127.0.0.1:${runtimePort2}`);
  return installed;
}
async function cdpRestartAndInject(port, runtimePort2, accessToken3) {
  if (!["darwin", "win32"].includes(process.platform)) throw new Error(`setup_unsupported_${process.platform}`);
  await quitCodex();
  return cdpInject(port, runtimePort2, accessToken3, true);
}
async function cdpRefreshAndInject(port, runtimePort2, accessToken3) {
  return cdpInject(port, runtimePort2, accessToken3, false);
}
async function cdpEject(port, accessToken3, ownership) {
  try {
    const values = await targets(port);
    return await Promise.all(values.map((target) => uninstallTarget(target, accessToken3, ownership)));
  } finally {
    clearCompatibilityStatus();
  }
}
async function cdpStatus(port) {
  try {
    const values = await mainTargets(port);
    const rendered = [];
    for (const target of values) {
      const connection = new Connection(target.webSocketDebuggerUrl);
      try {
        await connection.open();
        const value = await evaluate(connection, `({
          version: window.__boostCodexInjection__?.version || null,
          bundleChecksum: window.__boostCodexInjection__?.bundleChecksum || null,
          profile: window.__boostCodexInjection__?.profile || null,
          endpoint: window.__boostCodexInjection__?.endpoint || null,
          ready: typeof window.__boostCodexInjection__?.ready === 'function' && Boolean(window.__boostCodexInjection__.ready()),
          entry: Boolean(document.getElementById('boost-codex-entry')),
          panel: Boolean(document.getElementById('boost-codex-panel')),
          open: document.documentElement.hasAttribute('data-boost-codex-open')
        })`);
        rendered.push({ targetId: target.id, title: target.title, url: target.url, ...value });
      } finally {
        await connection.close();
      }
    }
    return { available: true, port, compatibility: readCompatibilityStatus(), targets: rendered };
  } catch (error2) {
    return { available: false, port, error: error2 instanceof Error ? error2.message : "cdp_error", compatibility: readCompatibilityStatus(), targets: [] };
  }
}
async function watchInjection(port, accessToken3) {
  const attached = /* @__PURE__ */ new Map();
  let activeRuntimePort2 = 0;
  let stopping = false;
  let yieldedToPeer = false;
  let discovery = null;
  let wakeTargetActivity = null;
  const pulsing = /* @__PURE__ */ new Set();
  const pulseTimer = setInterval(() => {
    for (const [id, current] of attached) {
      if (pulsing.has(id)) continue;
      pulsing.add(id);
      void evaluate(current.connection, "window.__boostCodexInjection__?.pulse?.()").catch(() => {
      }).finally(() => pulsing.delete(id));
    }
  }, 2e3);
  pulseTimer.unref();
  const wake = () => {
    const finish = wakeTargetActivity;
    wakeTargetActivity = null;
    finish?.();
  };
  const stop = () => {
    stopping = true;
    wake();
  };
  const ensureDiscovery = async () => {
    if (discovery) return;
    let connection = null;
    try {
      connection = new Connection(await browserDebuggerUrl(port));
      await connection.open();
      const reset = () => {
        if (discovery === connection) discovery = null;
        wake();
      };
      connection.onClose(reset);
      connection.on("Target.targetCreated", wake);
      connection.on("Target.targetInfoChanged", wake);
      connection.on("Target.targetDestroyed", wake);
      await connection.send("Target.setDiscoverTargets", { discover: true });
      discovery = connection;
    } catch {
      await connection?.close();
    }
  };
  const targetActivity = () => new Promise((resolve11) => {
    const finish = () => {
      if (wakeTargetActivity === finish) wakeTargetActivity = null;
      resolve11();
    };
    wakeTargetActivity = finish;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopping) {
    let settleMs = 250;
    const activity = targetActivity();
    try {
      await ensureDiscovery();
      const runtime = readRuntimeState();
      if (!runtime) throw new Error("runtime_unavailable");
      if (activeRuntimePort2 && activeRuntimePort2 !== runtime.port) {
        for (const current of attached.values()) {
          try {
            if (current.identifier) await current.connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: current.identifier });
            await evaluate(current.connection, injectionScript(0, accessToken3, "uninstall"));
          } catch {
          }
          await current.connection.close();
        }
        attached.clear();
      }
      activeRuntimePort2 = runtime.port;
      const values = await mainTargets(port, { trustIds: new Set(attached.keys()) });
      const activeIds = new Set(values.map((target) => target.id));
      for (const [id, current] of attached) {
        if (!activeIds.has(id)) {
          await current.connection.close();
          attached.delete(id);
        }
      }
      for (const target of values) {
        if (attached.has(target.id)) continue;
        const connection = new Connection(target.webSocketDebuggerUrl);
        let transferred = false;
        try {
          await connection.open();
          await connection.send("Page.enable");
          await connection.send("Page.setBypassCSP", { enabled: true });
          await connection.send("Runtime.enable");
          try {
            await connection.send("Runtime.addBinding", { name: "boostCodexRequest" });
          } catch {
          }
          connection.on("Runtime.bindingCalled", (params) => {
            if (params.name === "boostCodexRequest") void bridgeRequest(connection, activeRuntimePort2, accessToken3, params.payload);
          });
          const existing2 = await evaluate(connection, injectionIdentityExpression);
          const expectedEndpoint = `http://127.0.0.1:${activeRuntimePort2}`;
          if (boostCodexProfile === "development" && (existing2.profile ? existing2.profile !== boostCodexProfile : Boolean(existing2.endpoint && existing2.endpoint !== expectedEndpoint))) {
            setInjectionEnabled(false);
            stopping = true;
            yieldedToPeer = true;
            break;
          }
          let identifier;
          if (currentInjectionMatches(existing2, expectedEndpoint)) {
            const stored = await evaluate(connection, "window.__boostCodexNewDocumentScriptId || window.__betterCodexNewDocumentScriptId || null");
            identifier = typeof stored === "string" ? stored : void 0;
            await evaluate(connection, "window.__boostCodexInjection__.refresh()");
          } else {
            const oldIdentifier = await evaluate(connection, "window.__boostCodexNewDocumentScriptId || window.__betterCodexNewDocumentScriptId || null");
            if (typeof oldIdentifier === 'string' && oldIdentifier) {
              try { await connection.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: oldIdentifier }); } catch {}
            }
            const source = injectionScript(activeRuntimePort2, accessToken3, "install", readCodexLocale());
            const registration = await connection.send("Page.addScriptToEvaluateOnNewDocument", { source });
            identifier = String(registration.identifier ?? "") || void 0;
            await evaluate(connection, source);
            await evaluate(connection, `window.__boostCodexNewDocumentScriptId = ${JSON.stringify(identifier ?? "")}; delete window.__betterCodexNewDocumentScriptId`);
          }
          attached.set(target.id, { connection, identifier, target });
          transferred = true;
          recordInjectionOwnership(boostCodexProfile, expectedEndpoint);
          await recordDesktopIntegration(connection, target, expectedEndpoint);
        } finally {
          if (!transferred) await connection.close();
        }
      }
      if (stopping) break;
      for (const [id, current] of attached) {
        try {
          const existing2 = await evaluate(current.connection, injectionIdentityExpression);
          if (boostCodexProfile === "development" && (existing2.profile ? existing2.profile !== boostCodexProfile : Boolean(existing2.endpoint && existing2.endpoint !== `http://127.0.0.1:${activeRuntimePort2}`))) {
            setInjectionEnabled(false);
            stopping = true;
            yieldedToPeer = true;
            break;
          }
          await recordDesktopIntegration(current.connection, current.target, `http://127.0.0.1:${activeRuntimePort2}`);
          if (!currentInjectionMatches(existing2, `http://127.0.0.1:${activeRuntimePort2}`)) {
            if (current.identifier) {
              try {
                await current.connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: current.identifier });
              } catch {
              }
            }
            await current.connection.close();
            attached.delete(id);
          }
        } catch {
          await current.connection.close();
          attached.delete(id);
        }
      }
      if (stopping) break;
      settleMs = attached.size > 0 ? 2500 : 250;
    } catch (error2) {
      const message = error2 instanceof Error ? error2.message : "injector_cycle_failed";
      settleMs = message.startsWith("codex_incompatible_") || message.startsWith("cdp_unavailable_") ? 200 : 500;
      const current = readCompatibilityStatus();
      const reason = message.startsWith("cdp_unavailable_") ? "renderer_not_found" : message.startsWith("codex_incompatible_") ? message.slice("codex_incompatible_".length) : "renderer_probe_failed";
      writeCompatibilityStatus({ codexVersion: desktopVersion(), compatible: false, reason, targetId: null, capabilities: null });
      if (current?.reason !== reason) console.error(`BOOST_CODEX_DIAGNOSTIC ${JSON.stringify({ scope: "desktop", event: "integration_pending", reason, error: message })}`);
    }
    await Promise.race([activity, new Promise((resolve11) => setTimeout(resolve11, settleMs))]);
    wake();
  }
  clearInterval(pulseTimer);
  const activeDiscovery = discovery;
  await activeDiscovery?.close();
  for (const current of attached.values()) {
    try {
      if (current.identifier) await current.connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: current.identifier });
      if (!yieldedToPeer) await evaluate(current.connection, injectionScript(0, accessToken3, "uninstall"));
    } catch {
    }
    await current.connection.close();
  }
}


// src/launch-integration.ts
var import_node_child_process4 = require("node:child_process");
var import_node_crypto4 = require("node:crypto");
var import_node_fs10 = require("node:fs");
var import_node_path9 = require("node:path");
var import_node_os6 = require("node:os");
var import_node_sea2 = require("node:sea");
init_brand_assets();

// src/macos-desktop-assets.ts
function macMenuBarExecutable() {
  throw new Error("macos_only");
}
function macMenuBarIcon() {
  throw new Error("macos_only");
}

// src/launch-integration.ts
init_config();
var developmentProfile = boostCodexProfile === "development";
var launcherDisplayName = developmentProfile ? "boostCodex Dev" : "boostCodex";
var MAC_BUNDLE_ID = developmentProfile ? "com.boost-codex.launcher.dev" : "com.boost-codex.launcher";
var MAC_OWNERSHIP_FILE = ".boost-codex-owner";
var WINDOWS_SHORTCUT_NAME = `${launcherDisplayName}.lnk`;
var WINDOWS_LAUNCHER_SCRIPT_NAME = `${launcherDisplayName} Launcher.vbs`;
function macLauncherPath() {
  return `/Applications/${launcherDisplayName}.app`;
}
function legacyMacLauncherPaths() {
  if (developmentProfile) return [];
  return [
    "/Applications/boostCodex Launcher.app",
    "/Applications/Better Codex.app",
    "/Applications/Better Codex Launcher.app",
    (0, import_node_path9.join)((0, import_node_os6.homedir)(), "Applications", "boostCodex Launcher.app")
  ];
}
function allowedMacLauncherPaths() {
  return [macLauncherPath(), ...legacyMacLauncherPaths()];
}
function macBundleIdentifier(infoPath) {
  try {
    return (0, import_node_child_process4.execFileSync)("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPath], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
function windowsOwnedShortcutRoots() {
  const script = `@(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
) | Where-Object { $_ } | Select-Object -Unique | ConvertTo-Json -Compress`;
  const output = (0, import_node_child_process4.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  const value = output ? JSON.parse(output) : [];
  return (Array.isArray(value) ? value : [value]).map((root) => (0, import_node_path9.resolve)(root));
}
function windowsLegacyShortcutRoots() {
  const script = `@(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('StartMenu'),
  (Join-Path $env:APPDATA 'MicrosoftInternet ExplorerQuick LaunchUser PinnedTaskBar')
) | Where-Object { $_ } | Select-Object -Unique | ConvertTo-Json -Compress`;
  const output = (0, import_node_child_process4.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  const value = output ? JSON.parse(output) : [];
  return (Array.isArray(value) ? value : [value]).map((root) => (0, import_node_path9.resolve)(root));
}
function pathWithin(path, root) {
  const normalizedPath = path.toLowerCase();
  const normalizedRoot = root.toLowerCase().replace(/[\\/]+$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}
function isLegacyWindowsShortcut(shortcut) {
  return "targetPath" in shortcut && typeof shortcut.targetPath === "string";
}
function isLegacyWindowsState(state) {
  return state.platform === "win32" && Boolean(state.shortcuts?.some(isLegacyWindowsShortcut));
}
function backupDirectoryPath() {
  return (0, import_node_path9.resolve)((0, import_node_path9.join)((0, import_node_path9.dirname)(launchIntegrationStatePath), "shortcut-backups"));
}
function validateState(value) {
  if (!value || typeof value !== "object") throw new Error("launch_integration_state_invalid");
  const state = value;
  if (!["darwin", "win32"].includes(state.platform) || typeof state.launcher !== "string") throw new Error("launch_integration_state_invalid");
  if (state.platform !== process.platform) throw new Error("launch_integration_state_invalid");
  if (state.launcherArguments && (!Array.isArray(state.launcherArguments) || state.launcherArguments.some((argument) => typeof argument !== "string"))) {
    throw new Error("launch_integration_state_invalid");
  }
  if (state.baseCommand !== void 0 && (!Array.isArray(state.baseCommand) || !state.baseCommand.length || state.baseCommand.some((argument) => typeof argument !== "string"))) throw new Error("launch_integration_state_invalid");
  if (state.platform === "darwin" && !allowedMacLauncherPaths().includes(state.appPath ?? "")) throw new Error("launch_integration_state_invalid");
  if (state.platform === "win32") {
    if (!Array.isArray(state.shortcuts)) throw new Error("launch_integration_state_invalid");
    if (isLegacyWindowsState(state)) validateLegacyWindowsState(state);
    else validateOwnedWindowsState(state);
  }
  return state;
}
function validateOwnedWindowsState(state) {
  const roots = windowsOwnedShortcutRoots().filter(import_node_fs10.existsSync).map((root) => import_node_fs10.realpathSync.native(root));
  for (const shortcut of state.shortcuts ?? []) {
    if (!shortcut || typeof shortcut !== "object" || typeof shortcut.path !== "string") throw new Error("launch_integration_state_invalid");
    if (isLegacyWindowsShortcut(shortcut)) throw new Error("launch_integration_state_invalid");
    const shortcutPath = (0, import_node_path9.resolve)(shortcut.path);
    if (![WINDOWS_SHORTCUT_NAME, developmentProfile ? "Better Codex Dev.lnk" : "Better Codex.lnk"].some(name => name.toLowerCase() === (0, import_node_path9.basename)(shortcutPath).toLowerCase()) || !shortcutPath.toLowerCase().endsWith(".lnk")) {
      throw new Error("launch_integration_state_invalid");
    }
    if ((0, import_node_fs10.existsSync)(shortcutPath)) {
      if ((0, import_node_fs10.lstatSync)(shortcutPath).isSymbolicLink() || !roots.some((root) => pathWithin(import_node_fs10.realpathSync.native(shortcutPath), root))) {
        throw new Error("launch_integration_state_invalid");
      }
    } else {
      const parent = (0, import_node_path9.dirname)(shortcutPath);
      if (!(0, import_node_fs10.existsSync)(parent) || (0, import_node_fs10.lstatSync)(parent).isSymbolicLink() || !roots.some((root) => pathWithin(import_node_fs10.realpathSync.native(parent), root))) {
        throw new Error("launch_integration_state_invalid");
      }
    }
  }
}
function validateLegacyWindowsState(state) {
  const backupDirectory = backupDirectoryPath();
  if (!(0, import_node_fs10.existsSync)(backupDirectory) || (0, import_node_fs10.lstatSync)(backupDirectory).isSymbolicLink()) throw new Error("launch_integration_state_invalid");
  const canonicalBackupDirectory = import_node_fs10.realpathSync.native(backupDirectory);
  const roots = windowsLegacyShortcutRoots().filter(import_node_fs10.existsSync).map((root) => import_node_fs10.realpathSync.native(root));
  for (const shortcut of state.shortcuts ?? []) {
    if (!shortcut || typeof shortcut !== "object" || !isLegacyWindowsShortcut(shortcut)) throw new Error("launch_integration_state_invalid");
    for (const key of ["path", "targetPath", "arguments", "workingDirectory", "description", "iconLocation"]) {
      if (typeof shortcut[key] !== "string") throw new Error("launch_integration_state_invalid");
    }
    const shortcutPath = (0, import_node_path9.resolve)(shortcut.path);
    if (!shortcutPath.toLowerCase().endsWith(".lnk")) throw new Error("launch_integration_state_invalid");
    if ((0, import_node_fs10.existsSync)(shortcutPath)) {
      if ((0, import_node_fs10.lstatSync)(shortcutPath).isSymbolicLink() || !roots.some((root) => pathWithin(import_node_fs10.realpathSync.native(shortcutPath), root))) {
        throw new Error("launch_integration_state_invalid");
      }
    }
    if (shortcut.backupPath) {
      const backup = (0, import_node_path9.resolve)(shortcut.backupPath);
      if ((0, import_node_path9.dirname)(backup) !== backupDirectory || !backup.toLowerCase().endsWith(".lnk")) throw new Error("launch_integration_state_invalid");
      if ((0, import_node_fs10.existsSync)(backup) && ((0, import_node_fs10.lstatSync)(backup).isSymbolicLink() || (0, import_node_path9.dirname)(import_node_fs10.realpathSync.native(backup)) !== canonicalBackupDirectory)) {
        throw new Error("launch_integration_state_invalid");
      }
    }
  }
}
function managedEntrypoint(path) {
  const relation = (0, import_node_path9.relative)((0, import_node_path9.resolve)(runtimeVersionsPath), (0, import_node_path9.resolve)(path));
  return !relation || !relation.startsWith("..") && !(0, import_node_path9.isAbsolute)(relation);
}
function installationCommand() {
  const base = process.env.BOOST_CODEX_BASE_ENTRYPOINT;
  const launcher = process.env.BOOST_CODEX_LAUNCHER_PATH;
  let invocation;
  if (base) invocation = [process.execPath, (0, import_node_path9.resolve)(base)];
  else if (launcher) invocation = [(0, import_node_path9.resolve)(launcher)];
  else if (managedEntrypoint((0, import_node_sea2.isSea)() ? process.execPath : process.argv[1] || process.execPath)) {
    const state = JSON.parse((0, import_node_fs10.readFileSync)(launchIntegrationStatePath, "utf8"));
    if (!state || typeof state.launcher !== "string" || state.launcherArguments !== void 0 && (!Array.isArray(state.launcherArguments) || !state.launcherArguments.every((value) => typeof value === "string"))) throw new Error("installation_base_entrypoint_invalid");
    if (state.baseCommand !== void 0) {
      if (!Array.isArray(state.baseCommand) || !state.baseCommand.length || !state.baseCommand.every((value) => typeof value === "string")) throw new Error("installation_base_entrypoint_invalid");
      invocation = state.baseCommand;
    } else {
      if (state.platform !== "darwin") throw new Error("installation_base_entrypoint_required");
      invocation = [state.launcher, ...state.launcherArguments ?? []];
    }
  } else if ((0, import_node_sea2.isSea)()) invocation = [process.execPath];
  else {
    const args = sourceProcessArguments([]);
    if (!args) throw new Error("installation_requires_file_entrypoint");
    invocation = [process.execPath, ...args];
  }
  if (invocation.some((value) => (0, import_node_path9.isAbsolute)(value) && managedEntrypoint(value))) throw new Error("installation_base_entrypoint_required");
  if (!(0, import_node_path9.isAbsolute)(invocation[0]) || invocation.some((value) => (0, import_node_path9.isAbsolute)(value) && !(0, import_node_fs10.existsSync)(value))) throw new Error("installation_base_executable_missing");
  return invocation;
}
function launcherCommand(command2) {
  if (process.platform !== "win32") return command2;
  ensureDirectories();
  const scriptPath = (0, import_node_path9.join)(boostCodexHome, WINDOWS_LAUNCHER_SCRIPT_NAME);
  const commandLine = command2.map((value) => `"${value.replace(/"/g, '""')}"`).join(" ");
  (0, import_node_fs10.writeFileSync)(scriptPath, `\uFEFFOption Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("BOOST_CODEX_PROFILE") = "${boostCodexProfile}"
shell.Environment("Process")("BOOST_CODEX_HOME") = "${boostCodexHome.replace(/"/g, '""')}"
shell.Environment("Process")("BOOST_CODEX_PEER_HOME") = "${peerBoostCodexHome.replace(/"/g, '""')}"
shell.Run "${commandLine.replace(/"/g, '""')}" & " launch", 0, False
`, { mode: 384, encoding: 'utf16le' });
  return [(0, import_node_path9.join)(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"), scriptPath];
}
function shellSingleQuoted(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function powershellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
function windowsArgument(value) {
  if (value && !/[\s"]/.test(value)) return value;
  let quoted2 = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted2 += "\\".repeat(backslashes * 2 + 1) + character;
      backslashes = 0;
      continue;
    }
    quoted2 += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted2 + "\\".repeat(backslashes * 2) + '"';
}
function readState() {
  if (!(0, import_node_fs10.existsSync)(launchIntegrationStatePath)) return null;
  try {
    return validateState(JSON.parse((0, import_node_fs10.readFileSync)(launchIntegrationStatePath, "utf8")));
  } catch {
    throw new Error("launch_integration_state_invalid");
  }
}
function writeState(state) {
  ensureDirectories();
  (0, import_node_fs10.writeFileSync)(launchIntegrationStatePath, JSON.stringify(state, null, 2), { mode: 384 });
}
function writeMacAppIcon(resources) {
  (0, import_node_fs10.mkdirSync)(resources, { recursive: true, mode: 448 });
  (0, import_node_fs10.writeFileSync)((0, import_node_path9.join)(resources, "AppIcon.icns"), appIconIcns());
}
function writeWindowsAppIcon() {
  ensureDirectories();
  const path = (0, import_node_path9.join)(boostCodexHome, "AppIcon.ico");
  (0, import_node_fs10.writeFileSync)(path, appIconIco());
  return path;
}
function macLauncherScript(command2) {
  return `#!/bin/sh
BOOST_CODEX_PROFILE=${shellSingleQuoted(boostCodexProfile)} BOOST_CODEX_HOME=${shellSingleQuoted(boostCodexHome)} BOOST_CODEX_PEER_HOME=${shellSingleQuoted(peerBoostCodexHome)} ${command2.map(shellSingleQuoted).join(" ")} launch >>${shellSingleQuoted((0, import_node_path9.join)(logPath, "launcher.log"))} 2>&1 &
exit 0
`;
}
function legacyMacLauncherScript(command2) {
  return `#!/bin/sh
${command2.map(shellSingleQuoted).join(" ")} launch >>${shellSingleQuoted((0, import_node_path9.join)(logPath, "launcher.log"))} 2>&1 &
exit 0
`;
}
function macLauncherOwnershipScripts(command2) {
  return developmentProfile ? [macLauncherScript(command2)] : [macLauncherScript(command2), legacyMacLauncherScript(command2)];
}
function assertOwnedMacApp(appPath, state) {
  const contents = (0, import_node_path9.join)(appPath, "Contents");
  const info = (0, import_node_path9.join)(contents, "Info.plist");
  const identified = (0, import_node_fs10.existsSync)(info) && !(0, import_node_fs10.lstatSync)(info).isSymbolicLink() && macBundleIdentifier(info) === MAC_BUNDLE_ID;
  if ((0, import_node_fs10.lstatSync)(appPath).isSymbolicLink() || !(0, import_node_fs10.existsSync)(contents) || (0, import_node_fs10.lstatSync)(contents).isSymbolicLink() || !identified) {
    throw new Error("mac_launcher_path_occupied");
  }
  if (state?.platform !== "darwin" || !state.appPath || (0, import_node_path9.resolve)(state.appPath) !== (0, import_node_path9.resolve)(appPath)) throw new Error("mac_launcher_path_occupied");
  if (state.desktopBundle && nativeMacBundle(appPath)) return;
  const marker = (0, import_node_path9.join)(contents, "Resources", MAC_OWNERSHIP_FILE);
  if (state.ownershipToken && (0, import_node_fs10.existsSync)(marker) && !(0, import_node_fs10.lstatSync)(marker).isSymbolicLink() && (0, import_node_fs10.readFileSync)(marker, "utf8") === state.ownershipToken) return;
  const executable = (0, import_node_path9.join)(contents, "MacOS", "boost-codex-launcher");
  if (!state.ownershipToken && (0, import_node_fs10.existsSync)(executable) && !(0, import_node_fs10.lstatSync)(executable).isSymbolicLink()) {
    const scriptContents = (0, import_node_fs10.readFileSync)(executable, "utf8");
    if (macLauncherOwnershipScripts([state.launcher, ...state.launcherArguments ?? []]).includes(scriptContents)) return;
  }
  throw new Error("mac_launcher_path_occupied");
}
function migrateLegacyMacLauncher(appPath, previous) {
  if ((0, import_node_fs10.existsSync)(appPath)) return false;
  for (const legacyAppPath of legacyMacLauncherPaths()) {
    if (!(0, import_node_fs10.existsSync)(legacyAppPath)) continue;
    assertOwnedMacApp(legacyAppPath, previous);
    (0, import_node_fs10.renameSync)(legacyAppPath, appPath);
    return true;
  }
  return false;
}
function installMacLauncher(command2, previous) {
  const appPath = macLauncherPath();
  const migrated = migrateLegacyMacLauncher(appPath, previous);
  const ownedState = migrated && previous ? { ...previous, appPath } : previous;
  const adopting = process.env.BOOST_CODEX_DESKTOP_APP === appPath && nativeMacBundle(appPath) && JSON.parse((0, import_node_fs10.readFileSync)((0, import_node_path9.join)(appPath, "Contents", "Resources", "desktop-bundle.json"), "utf8")).executableSha256 === (0, import_node_crypto4.createHash)("sha256").update(macMenuBarExecutable()).digest("hex");
  if ((0, import_node_fs10.existsSync)(appPath) && !adopting) assertOwnedMacApp(appPath, ownedState);
  const existingContents = (0, import_node_path9.join)(appPath, "Contents");
  const stableCommand = boostCodexProfile === "stable" && (0, import_node_fs10.existsSync)(appPath) && previous?.platform === "darwin" && (0, import_node_path9.resolve)(previous.launcher) === (0, import_node_path9.resolve)(command2[0]) && (previous.launcherArguments ?? []).length === command2.length - 1 && (previous.launcherArguments ?? []).every((argument, index) => argument === command2[index + 1]) ? [previous.launcher, ...previous.launcherArguments ?? []] : command2;
  const [launcher, ...launcherArguments] = stableCommand;
  const ownershipToken = ownedState?.ownershipToken ?? (0, import_node_crypto4.randomUUID)();
  if (adopting || ownedState?.desktopBundle && nativeMacBundle(appPath)) {
    return { platform: "darwin", launcher, launcherArguments, appPath, desktopBundle: true };
  }
  if ((0, import_node_fs10.existsSync)(appPath)) {
    const existingExecutable = (0, import_node_path9.join)(existingContents, "MacOS", "boost-codex-launcher");
    if (!(0, import_node_fs10.existsSync)(existingExecutable) || (0, import_node_fs10.lstatSync)(existingExecutable).isSymbolicLink()) {
      throw new Error("mac_launcher_replacement_required");
    }
  }
  const temporaryApp = `${appPath}.tmp.${(0, import_node_crypto4.randomUUID)()}`;
  const contents = (0, import_node_path9.join)(temporaryApp, "Contents");
  const macos = (0, import_node_path9.join)(contents, "MacOS");
  const resources = (0, import_node_path9.join)(contents, "Resources");
  try {
    (0, import_node_fs10.mkdirSync)(macos, { recursive: true, mode: 448 });
    (0, import_node_fs10.mkdirSync)(resources, { recursive: true, mode: 448 });
    (0, import_node_fs10.writeFileSync)((0, import_node_path9.join)(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>${launcherDisplayName}</string>
<key>CFBundleExecutable</key><string>boost-codex-menubar</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIdentifier</key><string>${MAC_BUNDLE_ID}</string>
<key>CFBundleName</key><string>${launcherDisplayName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>boostCodexProfile</key><string>${boostCodexProfile}</string>
</dict></plist>
`);
    const executable = (0, import_node_path9.join)(macos, "boost-codex-menubar");
    (0, import_node_fs10.writeFileSync)(executable, macMenuBarExecutable());
    (0, import_node_fs10.chmodSync)(executable, 493);
    writeMacAppIcon(resources);
    (0, import_node_fs10.writeFileSync)((0, import_node_path9.join)(resources, "MenuBarTemplate.png"), macMenuBarIcon());
    (0, import_node_fs10.writeFileSync)((0, import_node_path9.join)(resources, "desktop-bundle.json"), JSON.stringify({ kind: "boost-codex-desktop", schemaVersion: 1 }));
    (0, import_node_fs10.writeFileSync)((0, import_node_path9.join)(resources, MAC_OWNERSHIP_FILE), ownershipToken, { mode: 384 });
    const backup = `${appPath}.previous.${(0, import_node_crypto4.randomUUID)()}`;
    if ((0, import_node_fs10.existsSync)(appPath)) (0, import_node_fs10.renameSync)(appPath, backup);
    try {
      (0, import_node_fs10.renameSync)(temporaryApp, appPath);
    } catch (error2) {
      if ((0, import_node_fs10.existsSync)(backup)) (0, import_node_fs10.renameSync)(backup, appPath);
      throw error2;
    }
    (0, import_node_fs10.rmSync)(backup, { recursive: true, force: true });
  } catch (error2) {
    (0, import_node_fs10.rmSync)(temporaryApp, { recursive: true, force: true });
    throw error2;
  }
  try {
    (0, import_node_child_process4.execFileSync)("/usr/bin/touch", [appPath]);
    (0, import_node_child_process4.execFileSync)("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", appPath], { stdio: "ignore" });
  } catch {
  }
  return { platform: "darwin", launcher, launcherArguments, appPath, ownershipToken, desktopBundle: true };
}
function nativeMacBundle(appPath) {
  const contents = (0, import_node_path9.join)(appPath, "Contents");
  const manifest = (0, import_node_path9.join)(contents, "Resources", "desktop-bundle.json");
  const executable = (0, import_node_path9.join)(contents, "MacOS", "boost-codex-menubar");
  try {
    return !(0, import_node_fs10.lstatSync)(appPath).isSymbolicLink() && !(0, import_node_fs10.lstatSync)(contents).isSymbolicLink() && !(0, import_node_fs10.lstatSync)(manifest).isSymbolicLink() && !(0, import_node_fs10.lstatSync)(executable).isSymbolicLink() && macBundleIdentifier((0, import_node_path9.join)(contents, "Info.plist")) === MAC_BUNDLE_ID && JSON.parse((0, import_node_fs10.readFileSync)(manifest, "utf8")).kind === "boost-codex-desktop";
  } catch {
    return false;
  }
}
function openMacMenuBar() {
  if (process.platform !== "darwin" || process.env.BOOST_CODEX_DISABLE_MENUBAR === "1" || process.env.NODE_TEST_CONTEXT) return;
  const state = readState();
  if (!state?.appPath || !(0, import_node_fs10.existsSync)((0, import_node_path9.join)(state.appPath, "Contents", "MacOS", "boost-codex-menubar"))) return;
  assertOwnedMacApp(state.appPath, state);
  (0, import_node_child_process4.execFileSync)("/usr/bin/open", ["-g", state.appPath, "--args", "--background", "--home", boostCodexHome], { stdio: "ignore", timeout: 5e3 });
}
function restoreLegacyWindowsShortcuts(state) {
  const payload = Buffer.from(JSON.stringify(state.shortcuts ?? []), "utf8").toString("base64");
  const expectedArguments = [...state.launcherArguments ?? [], "launch"].map(windowsArgument).join(" ");
  const backupDirectory = backupDirectoryPath();
  const script = `$ErrorActionPreference = "Continue"
$launcher = ${powershellLiteral(state.launcher)}
$launchArguments = ${powershellLiteral(expectedArguments)}
$backupDirectory = ${powershellLiteral(backupDirectory)}
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellLiteral(payload)}))
$items = @(ConvertFrom-Json -InputObject $json)
if ($items.Count -eq 1 -and $items[0] -is [Array]) { $items = @($items[0]) }
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('StartMenu'),
  (Join-Path $env:APPDATA 'MicrosoftInternet ExplorerQuick LaunchUser PinnedTaskBar')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$canonicalRoots = @($roots | ForEach-Object { (Resolve-Path -LiteralPath $_).Path.TrimEnd('\\') })
$canonicalBackupDirectory = if (Test-Path -LiteralPath $backupDirectory) { (Resolve-Path -LiteralPath $backupDirectory).Path.TrimEnd('\\') } else { '' }
function Test-ManagedShortcut([string]$path) {
  try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
    foreach ($root in $canonicalRoots) {
      if ($resolved.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
  } catch {}
  return $false
}
function Test-ManagedBackup([string]$path) {
  try {
    if (-not $canonicalBackupDirectory) { return $false }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
    return [IO.Path]::GetDirectoryName($resolved).Equals($canonicalBackupDirectory, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}
$shell = New-Object -ComObject WScript.Shell
$restored = 0
$pending = 0
foreach ($item in $items) {
  if (-not $item.targetPath) { continue }
  if (-not (Test-ManagedShortcut ([string]$item.path))) { continue }
  try {
    $shortcut = $shell.CreateShortcut([string]$item.path)
    if ([IO.Path]::GetFullPath([string]$shortcut.TargetPath) -ne [IO.Path]::GetFullPath($launcher) -or [string]$shortcut.Arguments -ne $launchArguments) { continue }
    if ($item.backupPath -and (Test-ManagedBackup ([string]$item.backupPath))) {
      Copy-Item -LiteralPath $item.backupPath -Destination $item.path -Force -ErrorAction Stop
      $restored += 1
      continue
    }
    $shortcut.TargetPath = [string]$item.targetPath
    $shortcut.Arguments = [string]$item.arguments
    $shortcut.WorkingDirectory = [string]$item.workingDirectory
    $shortcut.Description = [string]$item.description
    $shortcut.IconLocation = [string]$item.iconLocation
    $shortcut.Save()
    $restored += 1
  } catch { $pending += 1 }
}
[pscustomobject]@{ restored = $restored; pending = $pending } | ConvertTo-Json -Compress
`;
  const output = (0, import_node_child_process4.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return JSON.parse(output);
}
function cleanupLegacyWindowsBackups() {
  (0, import_node_fs10.rmSync)(backupDirectoryPath(), { recursive: true, force: true });
}
function installWindowsShortcuts(command2, previous) {
  if (previous && !isLegacyWindowsState(previous)) {
    const oldName = developmentProfile ? "Better Codex Dev.lnk" : "Better Codex.lnk";
    const oldLinks = previous.shortcuts.filter(item => path.basename(item.path).toLowerCase() === oldName.toLowerCase());
    if (oldLinks.length) {
      const backup = path.join(boostCodexHome, "backups", "brand-rename-launcher"); fs.mkdirSync(backup, { recursive: true });
      fs.copyFileSync(launchIntegrationStatePath, path.join(backup, "launch-integration.json"));
      for (let i=0;i<oldLinks.length;i++) if(fs.existsSync(oldLinks[i].path)) fs.copyFileSync(oldLinks[i].path,path.join(backup,i+"-"+oldName));
      const result = removeOwnedWindowsShortcuts({ ...previous, shortcuts: oldLinks }, oldName);
      if (result.pending) throw Error("brand_shortcut_migration_incomplete");
    }
  }
  if (previous && isLegacyWindowsState(previous)) {
    const result2 = restoreLegacyWindowsShortcuts(previous);
    if (result2.pending > 0) throw new Error(`shortcut_restore_incomplete_${result2.pending}`);
    cleanupLegacyWindowsBackups();
  }
  const [launcher, ...launcherArguments] = command2;
  const target = launcher;
  const targetArguments = [...launcherArguments, "launch"].map(windowsArgument).join(" ");
  const script = `$ErrorActionPreference = "Stop"
$launcher = ${powershellLiteral(target)}
$launchArguments = ${powershellLiteral(targetArguments)}
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
if (-not (Test-Path -LiteralPath $startMenu)) { New-Item -ItemType Directory -Path $startMenu -Force | Out-Null }
$paths = @(
  (Join-Path $desktop ${powershellLiteral(WINDOWS_SHORTCUT_NAME)}),
  (Join-Path $startMenu ${powershellLiteral(WINDOWS_SHORTCUT_NAME)})
) | Where-Object { $_ }
$iconLocation = ${powershellLiteral(`${writeWindowsAppIcon()},0`)}
$shell = New-Object -ComObject WScript.Shell
$created = @()
foreach ($path in $paths) {
  $shortcut = $shell.CreateShortcut($path)
  $shortcut.TargetPath = $launcher
  $shortcut.Arguments = $launchArguments
  $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($launcher)
$shortcut.Description = ${powershellLiteral(launcherDisplayName)}
  $shortcut.IconLocation = $iconLocation
  $shortcut.Save()
  $created += [pscustomobject]@{ path = $path }
}
@($created) | ConvertTo-Json -Depth 3 -Compress
`;
  const output = (0, import_node_child_process4.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true
  }).trim();
  const shortcuts = output ? JSON.parse(output) : [];
  return {
    platform: "win32",
    launcher: target,
    launcherArguments,
    shortcuts: Array.isArray(shortcuts) ? shortcuts : [shortcuts]
  };
}
function removeOwnedWindowsShortcuts(state, shortcutName = WINDOWS_SHORTCUT_NAME) {
  const payload = Buffer.from(JSON.stringify(state.shortcuts ?? []), "utf8").toString("base64");
  const expectedArguments = [...state.launcherArguments ?? [], "launch"].map(windowsArgument).join(" ");
  const script = `$ErrorActionPreference = "Continue"
$launcher = ${powershellLiteral(state.launcher)}
$launchArguments = ${powershellLiteral(expectedArguments)}
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellLiteral(payload)}))
$items = @(ConvertFrom-Json -InputObject $json)
if ($items.Count -eq 1 -and $items[0] -is [Array]) { $items = @($items[0]) }
$roots = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$canonicalRoots = @($roots | ForEach-Object { (Resolve-Path -LiteralPath $_).Path.TrimEnd('\\') })
function Test-OwnedShortcut([string]$path) {
  try {
    if ([IO.Path]::GetFileName($path) -ne ${powershellLiteral(shortcutName)}) { return $false }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
    foreach ($root in $canonicalRoots) {
      if ([IO.Path]::GetDirectoryName($resolved).Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
  } catch {}
  return $false
}
$shell = New-Object -ComObject WScript.Shell
$removed = 0
$pending = 0
foreach ($item in $items) {
  $path = [string]$item.path
  if (-not (Test-Path -LiteralPath $path)) { continue }
  if (-not (Test-OwnedShortcut $path)) { $pending += 1; continue }
  try {
    $shortcut = $shell.CreateShortcut($path)
    if ([IO.Path]::GetFullPath([string]$shortcut.TargetPath) -ne [IO.Path]::GetFullPath($launcher) -or [string]$shortcut.Arguments -ne $launchArguments) {
      $pending += 1
      continue
    }
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    $removed += 1
  } catch { $pending += 1 }
}
[pscustomobject]@{ removed = $removed; pending = $pending } | ConvertTo-Json -Compress
`;
  const output = (0, import_node_child_process4.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return JSON.parse(output);
}
function windowsShortcutStatus(state) {
  const payload = Buffer.from(JSON.stringify(state.shortcuts ?? []), "utf8").toString("base64");
  const expectedArguments = [...state.launcherArguments ?? [], "launch"].map(windowsArgument).join(" ");
  const script = `$ErrorActionPreference = "Continue"
$launcher = ${powershellLiteral(state.launcher)}
$launchArguments = ${powershellLiteral(expectedArguments)}
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellLiteral(payload)}))
$items = @(ConvertFrom-Json -InputObject $json)
if ($items.Count -eq 1 -and $items[0] -is [Array]) { $items = @($items[0]) }
$shell = New-Object -ComObject WScript.Shell
$healthy = 0
$drifted = 0
$missing = 0
foreach ($item in $items) {
  if (-not (Test-Path -LiteralPath $item.path)) { $missing += 1; continue }
  try {
    $shortcut = $shell.CreateShortcut([string]$item.path)
    if ([IO.Path]::GetFullPath([string]$shortcut.TargetPath) -eq [IO.Path]::GetFullPath($launcher) -and [string]$shortcut.Arguments -eq $launchArguments) { $healthy += 1 }
    else { $drifted += 1 }
  } catch { $drifted += 1 }
}
[pscustomobject]@{ healthy = $healthy; drifted = $drifted; missing = $missing } | ConvertTo-Json -Compress
`;
  const output = (0, import_node_child_process4.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  return JSON.parse(output);
}
function installLaunchIntegration() {
  const baseCommand = installationCommand();
  const command2 = launcherCommand(baseCommand);
  const previous = readState();
  let state;
  if (process.platform === "darwin") state = installMacLauncher(command2, previous);
  else if (process.platform === "win32") state = installWindowsShortcuts(command2, previous);
  else return { installed: false, platform: process.platform, reason: "launch_integration_unsupported" };
  state.baseCommand = baseCommand;
  writeState(state);
  return { installed: true, ...state, shortcutCount: state.shortcuts?.length ?? void 0 };
}
function uninstallLaunchIntegration() {
  const state = readState();
  if (!state) return { uninstalled: true, restored: 0, removed: null };
  let restored = 0;
  let removed = null;
  if (state.platform === "win32" && process.platform === "win32") {
    if (isLegacyWindowsState(state)) {
      const result2 = restoreLegacyWindowsShortcuts(state);
      restored = result2.restored;
      if (result2.pending > 0) throw new Error(`shortcut_restore_incomplete_${result2.pending}`);
      cleanupLegacyWindowsBackups();
    } else {
      const result2 = removeOwnedWindowsShortcuts(state);
      if (result2.pending > 0) throw new Error(`shortcut_remove_incomplete_${result2.pending}`);
      removed = result2.removed > 0 ? WINDOWS_SHORTCUT_NAME : null;
    }
  }
  if (state.platform === "darwin" && state.appPath && process.platform === "darwin") {
    const appPath = state.appPath;
    if ((0, import_node_fs10.existsSync)(appPath)) {
      assertOwnedMacApp(appPath, state);
      (0, import_node_fs10.rmSync)(appPath, { recursive: true, force: true });
      removed = appPath;
    }
  }
  (0, import_node_fs10.rmSync)(launchIntegrationStatePath, { force: true });
  return { uninstalled: true, restored, removed };
}
function launchIntegrationStatus() {
  const state = readState();
  if (!state) return { installed: false, platform: process.platform };
  if (state.platform === "win32" && process.platform === "win32") {
    if (isLegacyWindowsState(state)) {
      return { installed: true, ...state, shortcutCount: state.shortcuts?.length ?? 0, legacy: true };
    }
    const shortcuts = windowsShortcutStatus(state);
    return { installed: shortcuts.healthy > 0, ...state, shortcutCount: state.shortcuts?.length ?? 0, ...shortcuts };
  }
  let installed = false;
  if (state.platform === "darwin" && state.appPath && (0, import_node_fs10.existsSync)(state.appPath)) {
    try {
      assertOwnedMacApp(state.appPath, state);
      installed = true;
    } catch {
    }
  }
  return { installed, ...state, shortcutCount: state.shortcuts?.length ?? void 0 };
}


// src/service.ts
var import_node_child_process5 = require("node:child_process");
var import_node_fs11 = require("node:fs");
var import_node_os7 = require("node:os");
var import_node_path10 = require("node:path");
var import_node_util = require("node:util");
init_config();
init_runtime_state();
var label = "com.boost-codex.runtime";
var legacyLabel = "com.better-codex.runtime";
var windowsTask = "boostCodex Runtime";
var windowsRunKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
var launchAgentPath = (0, import_node_path10.join)((0, import_node_os7.homedir)(), "Library", "LaunchAgents", `${label}.plist`);
var legacyLaunchAgentPath = (0, import_node_path10.join)((0, import_node_os7.homedir)(), "Library", "LaunchAgents", `${legacyLabel}.plist`);
function xml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function command() {
  return [...installationCommand(), "runtime"];
}
function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
function windowsStartupCommand() {
  const [executable, ...args] = command();
  const script = `Start-Process -FilePath ${quotePowerShell(executable)} -ArgumentList @(${args.map(quotePowerShell).join(",")}) -WindowStyle Hidden`;
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
function windowsRuntime() {
  try {
    const value = JSON.parse((0, import_node_fs11.readFileSync)((0, import_node_path10.join)(runPath, "runtime.json"), "utf8"));
    if (!Number.isInteger(value.pid) || value.pid < 1) return null;
    const output = (0, import_node_child_process5.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId = ${value.pid}" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress)`], { encoding: "utf8", windowsHide: true }).trim();
    if (!output) return null;
    const processInfo = JSON.parse(output);
    if (processInfo.ProcessId !== value.pid || !processInfo.ExecutablePath || !processInfo.CommandLine || !/(?:^|\s)runtime(?:\s|$)/i.test(processInfo.CommandLine)) return null;
    const executable = (0, import_node_path10.resolve)(processInfo.ExecutablePath).toLowerCase();
    const expected = [command()[0], process.env.BOOST_CODEX_LAUNCHER_PATH].filter((item) => Boolean(item)).map((item) => (0, import_node_path10.resolve)(item).toLowerCase());
    const managedRoot = (0, import_node_path10.resolve)((0, import_node_path10.join)(boostCodexHome, "runtime", "versions")).toLowerCase();
    const managedRelation = (0, import_node_path10.relative)(managedRoot, executable);
    if (!expected.includes(executable) && (!managedRelation || managedRelation.startsWith("..") || (0, import_node_path10.isAbsolute)(managedRelation))) return null;
    process.kill(value.pid, 0);
    return value.pid;
  } catch {
    return null;
  }
}
function servicePlist() {
  const definition = serviceDefinition();
  const environmentXml = Object.entries(definition.EnvironmentVariables).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
  const argumentsXml = definition.ProgramArguments.map((value) => `<string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${definition.Label}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>EnvironmentVariables</key><dict>${environmentXml}</dict>
<key>WorkingDirectory</key><string>${xml(definition.WorkingDirectory)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>${definition.ThrottleInterval}</integer>
<key>ProcessType</key><string>${definition.ProcessType}</string>
<key>StandardOutPath</key><string>${xml(definition.StandardOutPath)}</string>
<key>StandardErrorPath</key><string>${xml(definition.StandardErrorPath)}</string>
</dict></plist>
`;
}
function serviceDefinition() {
  const invocation = command();
  const environment = { BOOST_CODEX_HOME: boostCodexHome, BOOST_CODEX_CDP_PORT: String(cdpPort) };
  if (invocation.length === 2) environment.BOOST_CODEX_LAUNCHER_PATH = invocation[0];
  else if (invocation.length === 3 && invocation[1].endsWith(".cjs")) environment.BOOST_CODEX_BASE_ENTRYPOINT = invocation[1];
  return {
    Label: label,
    ProgramArguments: invocation,
    EnvironmentVariables: environment,
    WorkingDirectory: boostCodexHome,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 5,
    ProcessType: "Background",
    StandardOutPath: runtimeLogPath,
    StandardErrorPath: (0, import_node_path10.join)(logPath, "runtime.error.log")
  };
}
function serviceConfigurationMatches() {
  if (process.platform !== "darwin" || !(0, import_node_fs11.existsSync)(launchAgentPath)) return false;
  const expected = serviceDefinition();
  try {
    const installed = JSON.parse((0, import_node_child_process5.execFileSync)("/usr/bin/plutil", ["-convert", "json", "-o", "-", launchAgentPath], { encoding: "utf8" }));
    return (0, import_node_util.isDeepStrictEqual)(installed, expected);
  } catch {
    return false;
  }
}
function repairServiceConfiguration() {
  if (boostCodexProfile === "development" || process.platform !== "darwin" || !(0, import_node_fs11.existsSync)(launchAgentPath)) return false;
  if (serviceConfigurationMatches()) return false;
  const installed = JSON.parse((0, import_node_child_process5.execFileSync)("/usr/bin/plutil", ["-convert", "json", "-o", "-", launchAgentPath], { encoding: "utf8" }));
  console.error(`BOOST_CODEX_DIAGNOSTIC ${JSON.stringify({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), scope: "service", event: "configuration_repair", profile: boostCodexProfile, home: boostCodexHome, pid: process.pid, installed, expected: serviceDefinition() })}`);
  installService();
  return true;
}
function launchctl(args, ignoreFailure = false) {
  try {
    return (0, import_node_child_process5.execFileSync)("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error2) {
    if (ignoreFailure) return "";
    const message = error2 && typeof error2 === "object" && "stderr" in error2 ? String(error2.stderr).trim() : "launchctl_failed";
    throw new Error(message || "launchctl_failed");
  }
}
function reg(args, ignoreFailure = false) {
  try {
    return (0, import_node_child_process5.execFileSync)("reg.exe", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error2) {
    if (ignoreFailure) return "";
    const message = error2 && typeof error2 === "object" && "stderr" in error2 ? String(error2.stderr).trim() : "windows_service_failed";
    throw new Error(message || "windows_service_failed");
  }
}
function domain() {
  const uid = process.getuid?.();
  if (uid === void 0) throw new Error("service_install_requires_macos");
  return `gui/${uid}`;
}
function installService() {
  if (boostCodexProfile === "development") return { installed: false, label: "boostCodex Dev Runtime", path: null, reason: "development_runtime_unmanaged" };
  ensureDirectories();
  if (process.platform === "win32") {
    const startup = windowsStartupCommand();
    const prior = reg(["QUERY", windowsRunKey, "/V", "Better Codex Runtime"], true);
    if (prior) {
      const oldCommand = prior.match(/REG_SZ\s+(.+)/)?.[1]?.trim();
      if (oldCommand !== startup) throw Error("legacy_startup_configuration_not_owned");
      fs.mkdirSync(path.join(boostCodexHome,"backups","brand-rename-launcher"),{recursive:true});
      fs.writeFileSync(path.join(boostCodexHome,"backups","brand-rename-launcher","startup.json"),JSON.stringify({name:"Better Codex Runtime",command:oldCommand}));
    }
    reg(["ADD", windowsRunKey, "/V", windowsTask, "/T", "REG_SZ", "/D", startup, "/F"]);
    if (prior) reg(["DELETE", windowsRunKey, "/V", "Better Codex Runtime", "/F"]);
    startService();
    return { installed: true, label: windowsTask, path: null };
  }
  if (process.platform !== "darwin") throw new Error("service_install_unsupported");
  (0, import_node_fs11.mkdirSync)((0, import_node_path10.join)((0, import_node_os7.homedir)(), "Library", "LaunchAgents"), { recursive: true });
  launchctl(["bootout", domain(), legacyLaunchAgentPath], true);
  if ((0, import_node_fs11.existsSync)(legacyLaunchAgentPath)) (0, import_node_fs11.unlinkSync)(legacyLaunchAgentPath);
  (0, import_node_fs11.writeFileSync)(launchAgentPath, servicePlist(), { mode: 420 });
  if (!serviceConfigurationMatches()) throw new Error("service_configuration_write_failed");
  launchctl(["bootout", domain(), launchAgentPath], true);
  launchctl(["bootstrap", domain(), launchAgentPath]);
  launchctl(["kickstart", "-k", `${domain()}/${label}`]);
  return { installed: true, label, path: launchAgentPath };
}
function uninstallService() {
  if (boostCodexProfile === "development") return { installed: false, label: "boostCodex Dev Runtime", path: null, reason: "development_runtime_unmanaged" };
  if (process.platform === "win32") {
    stopService();
    reg(["DELETE", windowsRunKey, "/V", windowsTask, "/F"], true);
    return { installed: false, label: windowsTask, path: null };
  }
  if (process.platform !== "darwin") throw new Error("service_uninstall_unsupported");
  launchctl(["bootout", domain(), launchAgentPath], true);
  launchctl(["bootout", domain(), legacyLaunchAgentPath], true);
  if ((0, import_node_fs11.existsSync)(launchAgentPath)) (0, import_node_fs11.unlinkSync)(launchAgentPath);
  if ((0, import_node_fs11.existsSync)(legacyLaunchAgentPath)) (0, import_node_fs11.unlinkSync)(legacyLaunchAgentPath);
  return { installed: false, label, path: launchAgentPath };
}
function startService() {
  if (boostCodexProfile === "development") throw new Error("development_runtime_unmanaged");
  if (process.platform === "win32") {
    if (!serviceStatus().installed) throw new Error("service_not_installed");
    if (!windowsRuntime()) {
      const [executable, ...args] = command();
      const child = (0, import_node_child_process5.spawn)(executable, args, { cwd: boostCodexHome, detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    }
    return { started: true, label: windowsTask };
  }
  if (!(0, import_node_fs11.existsSync)(launchAgentPath)) throw new Error("service_not_installed");
  if (!serviceConfigurationMatches()) {
    const runtime = readRuntimeState();
    const service = serviceStatus();
    if (runtime || service.running) {
      console.error(`BOOST_CODEX_DIAGNOSTIC ${JSON.stringify({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), scope: "service", event: "configuration_repair_blocked", profile: boostCodexProfile, home: boostCodexHome, pid: process.pid, service_pid: service.pid, runtime_pid: runtime?.pid ?? null, runtime_instance_id: runtime?.instanceId ?? null, error: "service_configuration_mismatch_runtime_active" })}`);
      throw new Error("service_configuration_mismatch_runtime_active");
    }
    repairServiceConfiguration();
    return { started: true, label, configurationRepaired: true };
  }
  launchctl(["bootstrap", domain(), launchAgentPath], true);
  launchctl(["kickstart", "-k", `${domain()}/${label}`]);
  return { started: true, label };
}
function stopService() {
  if (boostCodexProfile === "development") return { stopped: true, label: "boostCodex Dev Runtime", unmanaged: true };
  if (process.platform === "win32") {
    const pid = windowsRuntime();
    if (pid) {
      try {
        process.kill(pid);
      } catch {
      }
    }
    return { stopped: true, label: windowsTask };
  }
  launchctl(["bootout", domain(), launchAgentPath], true);
  return { stopped: true, label };
}
function restartService() {
  stopService();
  return startService();
}
function serviceStatus() {
  if (boostCodexProfile === "development") return { installed: false, running: false, pid: null, label: "boostCodex Dev Runtime", path: null, reason: "development_runtime_unmanaged" };
  if (process.platform === "win32") {
    const output2 = reg(["QUERY", windowsRunKey, "/V", windowsTask], true);
    const installed2 = Boolean(output2);
    const pid2 = windowsRuntime();
    return { installed: installed2, running: Boolean(pid2), pid: pid2, label: windowsTask, path: null };
  }
  if (process.platform !== "darwin") return { installed: false, running: false, pid: null, label, path: null };
  const installed = (0, import_node_fs11.existsSync)(launchAgentPath);
  const output = installed ? launchctl(["print", `${domain()}/${label}`], true) : "";
  const pid = output.match(/\bpid = (\d+)/)?.[1];
  return { installed, running: Boolean(pid), pid: pid ? Number(pid) : null, label, path: launchAgentPath, configurationMatches: installed && serviceConfigurationMatches() };
}
function serviceLogs(lines = 50) {
  if (!(0, import_node_fs11.existsSync)(runtimeLogPath)) return "";
  return (0, import_node_fs11.readFileSync)(runtimeLogPath, "utf8").split("\n").slice(-Math.max(1, lines) - 1).join("\n");
}


function commandArguments() {
  const values = process.argv.slice(2);
  const launcher = process.env.BOOST_CODEX_LAUNCHER_PATH;
  if (launcher && values[0] && canonicalPath(values[0]) === canonicalPath(launcher)) values.shift();
  return values;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}

async function request(path, options = {}) {
  const runtime = readRuntimeState();
  if (!runtime) throw new Error("runtime_unavailable");
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken2()}`,
      "content-type": "application/json",
      ...options.headers ?? {}
    }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(String(value.error ?? response.statusText));
  return value;
}

async function health() {
  const runtime = readRuntimeState();
  if (!runtime) throw new Error("runtime_unavailable");
  const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(5e3) });
  if (!response.ok) throw new Error("runtime_unavailable");
  const value = await response.json();
  if (value.instanceId !== runtime.instanceId || value.pid !== runtime.pid) throw new Error("runtime_identity_mismatch");
  return value;
}

async function readiness() {
  const runtime = readRuntimeState();
  if (!runtime) throw new Error("runtime_unavailable");
  const response = await fetch(`http://127.0.0.1:${runtime.port}/readyz`, { signal: AbortSignal.timeout(5e3) });
  const value = await response.json();
  if (value.instanceId !== runtime.instanceId || value.pid !== runtime.pid) throw new Error("runtime_identity_mismatch");
  if (!response.ok || value.ok !== true) {
    throw new Error(`runtime_not_ready:${JSON.stringify({ status: response.status, database: value.database ?? null, storage: value.storage ?? null, compatibility: value.compatibility ?? null, session_host: value.session_host ?? null })}`);
  }
  return value;
}

async function waitForRuntimeReady(timeoutMs = 6e4) {
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("runtime_not_ready");
  while (Date.now() < deadline) {
    try {
      return await readiness();
    } catch (error2) {
      lastError = error2;
      await new Promise((resolve11) => setTimeout(resolve11, 200));
    }
  }
  throw lastError;
}

function spawnSelf(args, logFile, detached = true) {
  const ownArgs = (0, import_node_sea6.isSea)() ? args : sourceProcessArguments(args);
  if (!ownArgs) throw new Error("self_requires_file_entrypoint");
  ensureDirectories();
  const descriptor = (0, import_node_fs31.openSync)(logFile, "a");
  const child = (0, import_node_child_process14.spawn)(process.execPath, ownArgs, {
    cwd: process.cwd(),
    detached,
    env: { ...process.env, BOOST_CODEX_TOKEN: accessToken2() },
    stdio: ["ignore", descriptor, descriptor],
    windowsHide: true
  });
  if (detached) child.unref();
  (0, import_node_fs31.closeSync)(descriptor);
  return child;
}

function activeRuntimePort() {
  const runtime = readRuntimeState();
  if (!runtime) throw new Error("runtime_unavailable");
  return runtime.port;
}

function injectionOwnership(profile = boostCodexProfile, stateRunPath = runPath, allowLegacyProfileless = false) {
  const runtime = readJsonFile((0, import_node_path27.join)(stateRunPath, "runtime.json"));
  const injection = readJsonFile((0, import_node_path27.join)(stateRunPath, "injection.json"));
  const runtimePort2 = Number(runtime?.port);
  const recordedEndpoint = typeof injection?.endpoint === "string" ? injection.endpoint : "";
  const expectedEndpoint = Number.isInteger(runtimePort2) && runtimePort2 > 0 ? `http://127.0.0.1:${runtimePort2}` : recordedEndpoint;
  return { profile, ...expectedEndpoint ? { endpoint: expectedEndpoint } : {}, ...allowLegacyProfileless ? { allowLegacyProfileless: true } : {} };
}

function processAlive5(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      return (0, import_node_child_process14.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).trim();
    }
    return (0, import_node_child_process14.execFileSync)("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function processStartTime4(pid) {
  try {
    const value = process.platform === "win32" ? (0, import_node_child_process14.execFileSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($process) { $process.CreationDate.ToUniversalTime().ToString('o') }`], { encoding: "utf8", windowsHide: true }).trim() : (0, import_node_child_process14.execFileSync)("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isInjectorProcess(pid) {
  return /\bwatch-inject\b/.test(processCommandLine(pid));
}

function injectorPid() {
  if (!(0, import_node_fs31.existsSync)(injectorPidPath)) return null;
  const pid = Number((0, import_node_fs31.readFileSync)(injectorPidPath, "utf8"));
  return Number.isInteger(pid) && processAlive5(pid) && isInjectorProcess(pid) ? pid : null;
}

// The supervisor runs every second. Do not block all renderer/API traffic on
// a synchronous PowerShell process query during its ordinary liveness check.
async function liveInjectorPid() {
  let pid;
  try { pid = Number(import_node_fs31.readFileSync(injectorPidPath, 'utf8')); } catch { return null; }
  if (!Number.isInteger(pid) || !processAlive5(pid)) return null;
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`] : ['-p', String(pid), '-o', 'command='];
  const line = await new Promise(resolve => import_node_child_process14.execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 }, (error, stdout) => resolve(error ? '' : stdout.trim())));
  return /\bwatch-inject\b/.test(line) && processAlive5(pid) ? pid : null;
}

function tryStartInjector(portNumber) {
  const existing2 = injectorPid();
  if (existing2) return existing2;
  let lock;
  try {
    lock = (0, import_node_fs31.openSync)(injectorStartLockPath, "wx", 384);
  } catch (error2) {
    if (error2.code === "EEXIST") return null;
    throw error2;
  }
  try {
    (0, import_node_fs31.writeFileSync)(lock, String(process.pid));
    const current = injectorPid();
    if (current) return current;
    const pid = spawnSelf(["watch-inject", String(portNumber)], injectorLogPath).pid;
    if (!pid) throw new Error("injector_start_failed");
    (0, import_node_fs31.writeFileSync)(injectorPidPath, String(pid));
    return pid;
  } finally {
    (0, import_node_fs31.closeSync)(lock);
    try {
      (0, import_node_fs31.unlinkSync)(injectorStartLockPath);
    } catch {
    }
  }
}

async function ensureInjector(portNumber) {
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    const pid = await liveInjectorPid();
    if (pid) return pid;
    const started = tryStartInjector(portNumber);
    if (started) {
      await new Promise((resolve11) => setTimeout(resolve11, 100));
      const running = await liveInjectorPid();
      if (running) return running;
    } else {
      try {
        if (Date.now() - (0, import_node_fs31.statSync)(injectorStartLockPath).mtimeMs > 5e3) (0, import_node_fs31.unlinkSync)(injectorStartLockPath);
      } catch {
      }
    }
    await new Promise((resolve11) => setTimeout(resolve11, 50));
  }
  throw new Error("injector_start_failed");
}

async function withLaunchLock(operation) {
  ensureDirectories();
  const token2 = (0, import_node_crypto18.randomUUID)();
  let acquired = false;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    let created = false;
    try {
      (0, import_node_fs31.mkdirSync)(launchLockPath, { mode: 448 });
      created = true;
      (0, import_node_fs31.writeFileSync)((0, import_node_path27.join)(launchLockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: token2, processStartedAt: new Date(processStartTime4(process.pid) ?? Date.now()).toISOString() }), { mode: 384 });
      acquired = true;
      break;
    } catch (error2) {
      if (created) {
        (0, import_node_fs31.rmSync)(launchLockPath, { recursive: true, force: true });
        throw error2;
      }
      let owner = null;
      try {
        owner = JSON.parse((0, import_node_fs31.readFileSync)((0, import_node_path27.join)(launchLockPath, "owner.json"), "utf8"));
      } catch {
      }
      let leaseExpired = false;
      try {
        leaseExpired = Date.now() - (0, import_node_fs31.statSync)(launchLockPath).mtimeMs > 15e3;
      } catch {
      }
      const expectedStart = owner?.processStartedAt ? Date.parse(owner.processStartedAt) : NaN;
      const observedStart = owner?.pid && processAlive5(owner.pid) ? processStartTime4(owner.pid) : null;
      const identityMismatch = Number.isFinite(expectedStart) && observedStart !== null && Math.abs(expectedStart - observedStart) > 1500;
      const stale = Boolean(owner?.pid && (!processAlive5(owner.pid) || identityMismatch)) || Boolean(leaseExpired && (!owner?.pid || !owner.processStartedAt));
      if (stale) {
        const stalePath = `${launchLockPath}.stale.${token2}`;
        try {
          (0, import_node_fs31.renameSync)(launchLockPath, stalePath);
          (0, import_node_fs31.rmSync)(stalePath, { recursive: true, force: true });
          continue;
        } catch {
        }
      }
      await new Promise((resolve11) => setTimeout(resolve11, 100));
    }
  }
  if (!acquired) throw new Error("codex_launch_busy");
  const heartbeat = setInterval(() => {
    try {
      (0, import_node_fs31.utimesSync)(launchLockPath, /* @__PURE__ */ new Date(), /* @__PURE__ */ new Date());
    } catch {
    }
  }, 1e3);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    try {
      const owner = JSON.parse((0, import_node_fs31.readFileSync)((0, import_node_path27.join)(launchLockPath, "owner.json"), "utf8"));
      if (owner.token === token2) {
        const releasedPath = `${launchLockPath}.released.${token2}`;
        (0, import_node_fs31.renameSync)(launchLockPath, releasedPath);
        (0, import_node_fs31.rmSync)(releasedPath, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

async function stopInjector() {
  const pid = injectorPid();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error2) {
      if (processAlive5(pid)) throw error2;
    }
    for (let attempt = 0; attempt < 90 && processAlive5(pid); attempt += 1) {
      await new Promise((resolve11) => setTimeout(resolve11, 100));
    }
    if (processAlive5(pid) && isInjectorProcess(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error2) {
        if (processAlive5(pid)) throw error2;
      }
      for (let attempt = 0; attempt < 10 && processAlive5(pid); attempt += 1) await new Promise((resolve11) => setTimeout(resolve11, 100));
    }
    if (processAlive5(pid)) throw new Error("injector_stop_failed");
  }
  if ((0, import_node_fs31.existsSync)(injectorPidPath)) {
    const recorded = Number((0, import_node_fs31.readFileSync)(injectorPidPath, "utf8"));
    if (!Number.isInteger(recorded) || recorded === pid || !processAlive5(recorded) || !isInjectorProcess(recorded)) (0, import_node_fs31.unlinkSync)(injectorPidPath);
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse((0, import_node_fs31.readFileSync)(path, "utf8"));
  } catch {
    return null;
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function selfCommand() {
  return installationCommand();
}

var import_node_crypto17 = crypto, accessToken, preloadedRequestBodies = new WeakMap();
function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "app://-",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-boost-codex-trace-id",
    "access-control-expose-headers": "x-boost-codex-trace-id, x-boost-codex-request-id",
    "access-control-allow-private-network": "true",
    "cross-origin-resource-policy": "cross-origin",
    "vary": "Origin"
  });
  response.end(body);
}

function sendPreflight(response) {
  response.writeHead(204, {
    "access-control-allow-origin": "app://-",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-boost-codex-trace-id",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    "vary": "Origin"
  });
  response.end();
}

function readBody(request2, limit = 1024 * 1024) {
  const preloaded = preloadedRequestBodies.get(request2);
  if (preloaded) {
    if (preloaded.length > limit) return Promise.reject(new Error("body_too_large"));
    try {
      const value = preloaded.length ? JSON.parse(preloaded.toString("utf8")) : {};
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
      return Promise.resolve(value);
    } catch {
      return Promise.reject(new Error("invalid_json"));
    }
  }
  return new Promise((resolve11, reject) => {
    const declaredLength = Number(request2.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      request2.resume();
      reject(new Error("body_too_large"));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error2) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error2);
    };
    const onData = (chunk) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > limit) {
        request2.off("data", onData);
        request2.resume();
        fail(new Error("body_too_large"));
        return;
      }
      chunks.push(value);
    };
    request2.on("data", onData);
    request2.on("error", (error2) => fail(error2 instanceof Error ? error2 : new Error("request_error")));
    request2.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const source = Buffer.concat(chunks, size).toString("utf8");
        const value = source ? JSON.parse(source) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
        resolve11(value);
      } catch {
        reject(new Error("invalid_json"));
      }
    });
  });
}

function loopback(request2) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request2.socket.remoteAddress ?? "");
}

function trustedOrigin(request2) {
  const origin = request2.headers.origin;
  if (!origin) return true;
  if (origin === "app://-") return true;
  const port = request2.socket.localPort;
  return Number.isInteger(port) && origin === `http://127.0.0.1:${port}`;
}

function validAccessToken(value) {
  if (typeof value !== "string") return false;
  const received = Buffer.from(value);
  const expected = Buffer.from(accessToken);
  return received.length === expected.length && (0, import_node_crypto17.timingSafeEqual)(received, expected);
}

function bearerToken(request2) {
  const authorization = String(request2.headers.authorization || "");
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
}

// Minimal local service. Existing project and chat databases are never opened.
var nativeSession, injectorStartLockPath;
function activeVersions(){return {core:coreVersion,compatibility:activeCompatibility().version,managedCore:null};}
function createLocalWorker(session){
  return {
    __devDraining:false,
    updateDrainStatus(){const status=session.status();return {ready:status.host.pending_requests===0,active_issue_ids:[],blocking:status.host.pending_requests?{pendingRequests:status.host.pending_requests}:null};},
    beginUpdateDrain(){this.__devDraining=true;},
    sessionHostStatus(){return session.status();},
    stopSessionHostClient(){void session.stop();},
    sessionRelay:{start(){if(!process.env.NODE_TEST_CONTEXT)void session.start().catch(()=>{});}},
    resumeAfterUpdate(){this.__devDraining=false;}
  };
}
function storageStatus(){try{const stat=fs.statfsSync(runPath),free=Number(stat.bavail)*Number(stat.bsize),total=Number(stat.blocks)*Number(stat.bsize);return {ok:true,degraded:free<5*1024**3 || free/total<0.05,free_bytes:free,total_bytes:total,path:runPath};}catch{return {ok:true,degraded:false,path:runPath};}}
function startServer(){
 if(!Number.isInteger(runtimePort)||runtimePort<0||runtimePort>65535)throw Error('invalid_runtime_port');
 const initial=createRuntimeIdentity();acquireRuntimeLock(initial);
 let identity;
 try{identity=claimRuntimeAuthority(initial);if(identity.handoffUpdateId)throw Error('runtime_update_in_progress');}catch(error){clearRuntimeState(initial.instanceId);throw error;}
 accessToken=token();
 const {NativeAccountSession}=require('../modules/native-account-session.cjs');
 nativeSession=new NativeAccountSession({home:boostCodexHome,executable:codexExecutablePath,version:coreVersion});
 nativeSession.publish();
 const worker=createLocalWorker(nativeSession);
 let cleaned=false;
 const cleanup=()=>{if(cleaned)return;cleaned=true;void nativeSession.stop();clearRuntimeState(identity.instanceId);};
 const server=http.createServer((request2,response)=>{
  void(async()=>{
   if(!request2.url||!loopback(request2)||!trustedOrigin(request2))return sendJson(response,403,{error:'forbidden'});
   if(request2.headers['x-boost-codex-relay']!==undefined||request2.headers['x-better-codex-relay']!==undefined)return sendJson(response,403,{error:'local_access_required'});
   const url=new URL(request2.url,'http://127.0.0.1'),method=request2.method || 'GET';
   if(method==='OPTIONS')return sendPreflight(response);
   if(['/health','/livez','/readyz'].includes(url.pathname)&&method==='GET'){
    const address=server.address(),port=typeof address==='object'&&address?address.port:0,runtimeIdentity=runtimeIdentityHealth({...identity,port});
    const ready=runtimeIdentity.ok&&!worker.__devDraining;
    return sendJson(response,url.pathname==='/readyz'&&!ready?503:200,{ok:url.pathname==='/readyz'?ready:runtimeIdentity.ok,serving_ready:ready,name:'boostCodex Runtime',version:coreVersion,pid:process.pid,port,instanceId:identity.instanceId,generation:identity.generation,runtime_identity:runtimeIdentity,database:{ok:true,opened:false},storage:storageStatus(),compatibility:readCompatibilityStatus(),session_host:nativeSession.status()});
   }
   if(!validAccessToken(bearerToken(request2)))return sendJson(response,401,{error:'unauthorized'});
   if(process.env.BOOST_CODEX_LOCAL_PROJECT && url.pathname.startsWith('/api/dev/')){
    const hook=process.env.BC_RUNTIME_API;
    if(hook&&await require(hook).handle({url,method,request:request2,response,worker,readBody,sendJson,stopHost:()=>nativeSession.stop()}))return;
   }
   if(url.pathname==='/api/shutdown'&&method==='POST'){
    if(!worker.updateDrainStatus().ready)return sendJson(response,409,{error:'runtime_busy'});
    sendJson(response,200,{stopped:true});setTimeout(stop,20);return;
   }
   if(worker.__devDraining&&!['GET','HEAD'].includes(method))return sendJson(response,503,{error:'service_restarting'});
   if(url.pathname==='/api/account/usage'&&method==='GET')return sendJson(response,200,{usage:await readCodexUsage()});
   return sendJson(response,404,{error:'not_found'});
  })().catch(error=>{if(!response.headersSent&&!response.destroyed)sendJson(response,['invalid_json','body_too_large'].includes(error.message)?400:500,{error:['invalid_json','body_too_large'].includes(error.message)?error.message:'request_failed'});});
 });
 const stop=()=>{server.close(()=>{cleanup();process.exit(0);});server.closeAllConnections();};
 server.once('error',error=>{cleanup();console.error(error.message);process.exitCode=1;});
 server.listen(runtimePort,'127.0.0.1',()=>{
  const port=server.address().port;identity={...identity,port};publishRuntimeState(identity);
  if(!process.env.NODE_TEST_CONTEXT)void nativeSession.start().catch(()=>{});
  console.log(`boostCodex Runtime ${coreVersion} listening on http://127.0.0.1:${port}`);
 });
 process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('exit',cleanup);
 return server;
}
async function ensureRuntime(timeoutMs=12000){
 try{return await health();}catch{}
 const current=readRuntimeState();if(current&&processAlive(current.pid))throw Error('runtime_still_running_health_unavailable');
 const child=spawnSelf(['runtime'],runtimeLogPath);if(!child.pid)throw Error('runtime_start_failed');
 return waitForRuntimeReady(timeoutMs);
}
async function runRuntime(){
 const server=startServer();await stopInjector();
 let stopping=false,reconciling=false;
 const reconcile=async()=>{if(stopping||reconciling)return;reconciling=true;try{if(injectionEnabled())await ensureInjector(cdpPort);else await stopInjector();}catch(error){console.error(error.message);}finally{reconciling=false;}};
 if(!process.env.NODE_TEST_CONTEXT)void reconcile();
 const timer=process.env.NODE_TEST_CONTEXT?null:setInterval(()=>void reconcile(),1000);timer?.unref();
 process.once('exit',()=>{stopping=true;if(timer)clearInterval(timer);const pid=injectorPid();if(pid)try{process.kill(pid,'SIGTERM');}catch{}});
 return server;
}
function usage(){console.log('boost-codex version | launch [--restart] | start | stop | status | doctor | refresh-injection | inject [--launch] | eject | launcher install|uninstall|status | service install|repair|uninstall|start|stop|restart|status|logs');}
async function main(){
 const [command2='launch',action,...args]=commandArguments();const values=[action,...args].filter(Boolean);
 if(['version','--version','-v'].includes(command2))return print({...activeVersions(),profile:boostCodexProfile,home:boostCodexHome});
 if(command2==='runtime')return runRuntime();if(command2==='serve')return startServer();
 if(command2==='update')throw Error('local_project_update_managed');
 if(command2==='watch-inject')return watchInjection(Number(action || cdpPort),accessToken2());
 if(command2==='dev-stop-injector'&&process.env.BOOST_CODEX_LOCAL_PROJECT){setInjectionEnabled(false);await stopInjector();return print({stopped:true});}
 if(command2==='launch')return print(await withLaunchLock(async()=>{
  await ensureRuntime();const port=Number(option(values,'--port') || cdpPort);
  let restart=values.includes('--restart');
  if(!restart&&process.platform==='win32'&&codexProcessRunning()){
   try{assertTrustedCdpListener(port);}catch(error){if(error.message!=='cdp_listener_absent')throw error;restart=true;}
  }
  if(restart)await quitCodex();
  setInjectionEnabled(true);const injection=await cdpInject(port,activeRuntimePort(),accessToken2(),true);await ensureInjector(port);return {launched:true,restarted:restart,injection};
 }));
 if(command2==='start'){const runtime=await ensureRuntime();if(values.includes('--runtime-only'))return print({runtime});setInjectionEnabled(true);const port=Number(option(values,'--port')||cdpPort);await cdpInject(port,activeRuntimePort(),accessToken2(),values.includes('--launch'));await ensureInjector(port);return print({runtime,injection:await cdpStatus(port)});}
 if(command2==='stop'){setInjectionEnabled(false);await stopInjector();try{await cdpEject(cdpPort,accessToken2(),injectionOwnership());}catch{}let runtime;try{runtime=await request('/api/shutdown',{method:'POST'});}catch(error){if(readRuntimeState())throw error;runtime={stopped:true,alreadyStopped:true};}return print({runtime,injection:{stopped:true}});}
 if(command2==='status'||command2==='doctor'){let runtime;try{runtime=await health();}catch{runtime={ok:false,error:'runtime_unavailable'};}const injection=await cdpStatus(Number(option(values,'--port')||cdpPort));return print({ok:runtime.ok===true,profile:boostCodexProfile,home:boostCodexHome,core:activeVersions(),runtime,injection,injectionEnabled:injectionEnabled(),injectorPid:injectorPid()});}
 if(command2==='refresh-injection'||command2==='inject')return print(await withLaunchLock(async()=>{
  const port=Number(option(values,'--port')||cdpPort);setInjectionEnabled(false);await stopInjector();
  try{await ensureRuntime();const removed=command2==='refresh-injection'?await cdpEject(port,accessToken2(),injectionOwnership()):[];const injection=await cdpInject(port,activeRuntimePort(),accessToken2(),values.includes('--launch'));setInjectionEnabled(true);const pid=await ensureInjector(port);return {refreshed:true,removed,injection,injectorPid:pid};}catch(error){setInjectionEnabled(false);await stopInjector();throw error;}
 }));
 if(command2==='eject'){setInjectionEnabled(false);await stopInjector();return print(await cdpEject(Number(option(values,'--port')||cdpPort),accessToken2(),injectionOwnership()));}
 if(command2==='launcher'){if(action==='status')return print(launchIntegrationStatus());if(action==='install')return print(installLaunchIntegration());if(action==='uninstall')return print(uninstallLaunchIntegration());}
 if(command2==='service'){
  const operations={install:installService,repair:repairServiceConfiguration,uninstall:uninstallService,start:startService,stop:stopService,restart:restartService,status:serviceStatus};
  if(action==='logs')return console.log(serviceLogs(Number(option(args,'--lines')||50)));if(operations[action])return print(operations[action]());
 }
 if(['--help','-h','help'].includes(command2))return usage();
 throw Error('command_not_available');
}
init_config();init_codex_cli();init_codex_usage();
module.exports={startServer,createLocalWorker,normalizeCodexUsage,queryCodexUsage,injectionScript,bridgeRequest,activeVersions};
if(require.main===module)void main().catch(error=>{console.error(error.message);process.exitCode=1;});
process.once('exit',()=>{if(commandArguments()[0]==='watch-inject'&&fs.existsSync(injectorPidPath)&&Number(fs.readFileSync(injectorPidPath,'utf8'))===process.pid)fs.unlinkSync(injectorPidPath);});
// Retained icon definitions: lucide-static v1.28.0, ISC license.

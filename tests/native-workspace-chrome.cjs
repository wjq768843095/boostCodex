const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/ui/better-codex-ui.js'), 'utf8');
const start = source.indexOf('    function syncPlanningWorkspaceNativeChrome(');
const end = source.indexOf('    function mountInlineConversation(', start);
assert(start > 0 && end > start);
function node(page = null) {
  const attrs = new Map(), styles = new Map();
  return { attrs, styles, getAttribute: name => attrs.get(name), setAttribute: (name, value) => attrs.set(name, value), removeAttribute: name => attrs.delete(name), closest: () => page, querySelector: () => null, querySelectorAll: () => [], style: { setProperty: (name, value) => styles.set(name, value) } };
}
const active = { contains: element => element.closest() === active };
const inactive = {};
const sharedRail = node(), sharedHeader = node(), activeRail = node(active), inactiveRail = node(inactive);
const sidebar = node();
sharedRail.querySelectorAll = () => [sidebar];
const removedProperties = [];
const context = vm.createContext({
  projectSurfaceCache: null,
  getComputedStyle: () => ({ top: '44px' }),
  document: {
    querySelector: () => active,
    querySelectorAll: selector => selector === '.app-shell-left-panel' ? [sharedRail, activeRail, inactiveRail] : selector.startsWith('[data-app-shell-header-layout') ? [sharedHeader] : [sharedRail, sharedHeader, activeRail, sidebar],
    documentElement: { style: { removeProperty: name => removedProperties.push(name) } }
  }
});
vm.runInContext(source.slice(start, end), context);
context.syncPlanningWorkspaceNativeChrome(true);
assert.equal(sharedRail.attrs.get('data-better-codex-planning-native-rail'), 'true', 'the shared native sidebar outside retained pages must collapse');
assert.equal(activeRail.attrs.get('data-better-codex-planning-native-rail'), 'true');
assert.equal(inactiveRail.attrs.size, 0, 'other retained pages are left alone');
assert.equal(sidebar.attrs.get('data-better-codex-planning-native-hidden'), 'true');
assert.equal(sharedHeader.styles.get('--bc-native-header-top'), '44px');
context.getComputedStyle = () => ({ top: '102px' });
context.syncPlanningWorkspaceNativeChrome(true);
assert.equal(sharedHeader.styles.get('--bc-native-header-top'), '44px', 'repeated mounts cannot accumulate header offsets');
context.projectSurfaceCache = { nativeSurface: { closest: () => active } };
context.syncPlanningWorkspaceNativeChrome(false);
assert.equal(sharedRail.attrs.size, 0, 'leaving restores the shared native sidebar');
assert.equal(sharedHeader.attrs.size, 0);
assert.equal(activeRail.attrs.get('data-better-codex-planning-native-rail'), 'true', 'the hidden cached page keeps its prepared layout');
assert(!/\[data-better-codex-planning-native-header="true"\][^\n]*display:\s*none/.test(source), 'native titlebar controls must remain available');
const nativeHeaderRule = source.match(/\[data-better-codex-planning-native-header="true"\] \{([^}]+)\}/)[1];
assert(Number(nativeHeaderRule.match(/z-index:\s*(\d+)/)[1]) > 41, 'native preview controls must sit above the installed main-content layer');
assert(/pointer-events:\s*none/.test(nativeHeaderRule), 'the transparent header must let native file-tab close buttons receive clicks');
const filePanel = node(), chatLayout = node();
filePanel.style.width = '900px';
const sizing = new Map([['--bc-inline-nav-space', '370px'], ['--bc-inline-details-space', '400px']]);
const surface = { clientWidth: 2000, querySelector: selector => selector.includes('aside') ? filePanel : chatLayout, style: { getPropertyValue: name => sizing.get(name) || '', setProperty: (name, value) => sizing.set(name, value) } };
context.SELECTORS = { contentLayout: '[data-app-shell-main-content-layout]' };
context.inlineNativePanelObserver = context.inlineNativePanelNode = null;
context.getComputedStyle = () => ({ display: 'flex' });
context.syncInlineNativeFilePanel(surface);
assert.equal(sizing.get('--bc-inline-native-panel-width'), '738px', 'split preview leaves usable chat width and cannot extend under project details');
chatLayout.attrs.set('data-app-shell-right-panel-full-width', 'true');
filePanel.style.width = '100%';
context.syncInlineNativeFilePanel(surface);
assert.equal(sizing.get('--bc-inline-native-panel-width'), '1230px', 'native full view occupies exactly the central area');
chatLayout.attrs.delete('data-app-shell-right-panel-full-width');
filePanel.style.width = '600px';
context.syncInlineNativeFilePanel(surface);
assert.equal(sizing.get('--bc-inline-native-panel-width'), '600px', 'native restore and width changes remain effective');
filePanel.attrs.set('aria-hidden', 'true');
context.syncInlineNativeFilePanel(surface);
assert.equal(sizing.get('--bc-inline-native-panel-width'), '0px', 'native panel hiding returns all central width to chat');
console.log('PASS: shared native sidebar collapse, retained-page isolation, stable header offsets and visible native controls');

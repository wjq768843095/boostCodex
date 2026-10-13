const assert = require('node:assert/strict');
const { create } = require('../src/ui/workflow-panel.js');

function fixture() {
  let scope = { route: '/' }, host = null, snapshot = null, visible = false, authRequired = false;
  const opens = [], closeHandlers = [], errors = [];
  const native = {
    getScope: () => scope,
    host: () => host,
    snapshot: () => snapshot,
    authRequired: async () => authRequired,
    open(current, url) {
      opens.push({ route: current.route, url });
      if (url) { host = { identity: Symbol('page'), disposed: false }; snapshot = { committedUrl: url, isSuspended: false }; }
      visible = true;
      return 'manual:better-codex-global-workflow-panel';
    },
    active: () => visible,
    hide: () => { visible = false; },
    retainOnClose: () => closeHandlers.push(true)
  };
  return {
    native, opens, closeHandlers, errors,
    options: { native, getPanelUrl: async () => 'http://127.0.0.1:40123/panel', reportError: error => errors.push(error.message) },
    route: route => { scope = { route }; },
    host: () => host,
    snapshot: value => { snapshot = value; },
    requireAuth: value => { authRequired = value; },
    suspend: () => { host = null; snapshot.isSuspended = true; }
  };
}

async function main() {
  const f = fixture(), panel = create(f.options);
  assert.equal(await panel.open(), true);
  const host = f.host();
  assert.deepEqual(panel.capture(), { open: true });
  assert.equal(panel.hide(), true);
  assert.deepEqual(panel.capture(), { open: false });
  assert.equal(await panel.open(), true);
  assert.equal(f.host(), host, 'ordinary hide/reopen retains the page');
  for (const route of ['/local/client-new-thread:test', '/local/existing-task']) {
    f.route(route);
    assert.equal(await panel.open(), true);
    assert.equal(f.host(), host, 'page identity is independent of the route');
  }
  assert.equal(f.opens.filter(item => item.url).length, 1, 'reopen must not navigate again');
  assert.equal(f.closeHandlers.length, 4, 'each presentation retains the page on close');
  assert.equal(f.errors.length, 0);
  panel.destroy();
  assert.equal(await panel.open(), false);
  const afterReload = create(f.options);
  assert.equal(await afterReload.open(), true);
  assert.equal(f.host(), host, 'reinjection reuses the native host');
  f.suspend();
  assert.equal(await afterReload.open(), true);
  assert.notEqual(f.host(), host, 'actual host suspension requires recovery');

  const authenticated = fixture();
  let ticket = 0;
  const stableUrl = 'http://127.0.0.1:40123/';
  const authenticatedPanel = create({ ...authenticated.options, getPanelUrl: async () => ({
    url: stableUrl + 'launch?ticket=one-time-' + ++ticket, stableUrl
  }) });
  assert.equal(await authenticatedPanel.open(), true);
  const authenticatedHost = authenticated.host();
  authenticated.snapshot({ url: stableUrl + 'launch?ticket=one-time-1', committedUrl: '', isLoading: true });
  assert.equal(await authenticatedPanel.open(), true);
  assert.equal(authenticated.opens.at(-1).url, undefined, 'a launch already redirecting is not interrupted by a new ticket');
  authenticated.snapshot({ url: stableUrl, committedUrl: stableUrl, isLoading: false });
  authenticatedPanel.hide();
  assert.equal(await authenticatedPanel.open(), true);
  assert.equal(authenticated.opens.at(-1).url, undefined, 'root redirect and a fresh ticket still identify one page');
  assert.equal(authenticated.host(), authenticatedHost);
  authenticated.snapshot({ url: stableUrl + 'launch?ticket=one-time-1', committedUrl: stableUrl, isLoading: false });
  assert.equal(await authenticatedPanel.open(), true);
  assert.equal(authenticated.opens.at(-1).url, undefined, 'the committed root wins over a stale launch URL');
  authenticated.requireAuth(true);
  assert.equal(await authenticatedPanel.open(), true);
  assert.equal(authenticated.opens.at(-1).url, stableUrl + 'launch?ticket=one-time-5', 'a 401-marked live page receives a fresh bootstrap');
  authenticated.requireAuth(false);
  authenticated.suspend();
  assert.equal(await authenticatedPanel.open(), true);
  assert.equal(authenticated.opens.at(-1).url, stableUrl + 'launch?ticket=one-time-6', 'actual recovery uses a fresh launch ticket');
  for (const unexpected of [
    'http://127.0.0.1:40124/launch?ticket=foreign',
    stableUrl + 'other?ticket=wrong-path',
    stableUrl + 'launch?ticket=old&other=unexpected'
  ]) {
    authenticated.snapshot({ url: unexpected, committedUrl: '', isLoading: true });
    assert.equal(await authenticatedPanel.open(), true);
    assert.notEqual(authenticated.opens.at(-1).url, undefined, 'only the same-origin launch route is reusable while loading');
  }
  authenticated.snapshot({ url: stableUrl + 'launch?ticket=failed', committedUrl: '', isLoading: false });
  assert.equal(await authenticatedPanel.open(), true);
  assert.notEqual(authenticated.opens.at(-1).url, undefined, 'a completed failed launch requires a fresh ticket');

  let release;
  const concurrent = fixture();
  const pending = create({ ...concurrent.options, getPanelUrl: () => new Promise(resolve => { release = resolve; }) });
  const first = pending.open(), second = pending.open();
  assert.equal(first, second);
  release('http://127.0.0.1:40123/panel');
  await first;
  assert.equal(concurrent.opens.length, 1, 'double click opens one presentation');

  const stale = fixture();
  const disposed = create({ ...stale.options, getPanelUrl: () => new Promise(resolve => { release = resolve; }) });
  const staleOpen = disposed.open(); disposed.destroy(); release('http://127.0.0.1:40123/panel');
  assert.equal(await staleOpen, false);
  assert.equal(stale.opens.length, 0, 'a destroyed adapter does not open a late result');

  const oldWarn = console.warn, warnings = []; console.warn = (...args) => warnings.push(args);
  try {
    const invalid = fixture(), denied = create({ ...invalid.options, getPanelUrl: async () => 'https://example.com/panel' });
    assert.equal(await denied.open(), false);
    assert.equal(invalid.opens.length, 0);
    assert.deepEqual(invalid.errors, ['面板暂时无法打开，请稍后重试。']);
    const crossOrigin = fixture(), crossOriginPanel = create({ ...crossOrigin.options, getPanelUrl: async () => ({
      url: 'http://127.0.0.1:40124/launch?ticket=secret', stableUrl
    }) });
    assert.equal(await crossOriginPanel.open(), false);
    assert.equal(crossOrigin.opens.length, 0, 'the launch and stable page must share one origin');
    const nativeFailure = fixture();
    nativeFailure.native.open = () => { throw new Error('Failed http://127.0.0.1:40123/launch?ticket=private-value'); };
    assert.equal(await create(nativeFailure.options).open(), false);
    assert.equal(JSON.stringify(warnings).includes('ticket='), false, 'diagnostics never contain launch credentials');
    assert.equal(JSON.stringify(warnings).includes('private-value'), false);
  } finally { console.warn = oldWarn; }
  console.log('workflow panel: global host, bootstrap redirect, ticket recovery and lifecycle checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

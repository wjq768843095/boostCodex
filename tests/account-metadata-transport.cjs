'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fetchAccountMetadata } = require('../src/modules/account-metadata-transport.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'better-codex-account-metadata-'));
const input = { accountId: 'personal-account', userId: 'native-user' };
const now = Date.now();
function token(userId = input.userId, expiry = now / 1000 + 3600, extra = {}) {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expiry, 'https://api.openai.com/auth': { chatgpt_user_id: userId }, ...extra })).toString('base64url')}.signature`;
}
function auth(home, accessToken = token()) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessToken } }));
}
function metadata() {
  return { account_ordering: [input.accountId], accounts: { [input.accountId]: {
    account: { account_id: input.accountId, account_user_id: 'membership-id-not-jwt-user', account_user_role: 'owner', structure: 'personal', plan_type: 'plus', is_zdr: false },
    features: ['unchanged'], entitlement: null, subscriptions: [{ state: 'active' }], permissions: { future_unknown: false }
  } }, future_field: { preserve: true } };
}
function resource() {
  const item = new EventEmitter();
  item.destroyed = false;
  item.destroy = () => { item.destroyed = true; };
  item.kill = () => { item.destroyed = true; };
  return item;
}
let sequence = 0;
function fixture(options = {}) {
  const home = path.join(root, `fixture-${++sequence}`);
  auth(home, options.token || token());
  const calls = [], sockets = [], requests = [], registryCalls = [];
  const config = { ...options };
  const env = options.env || { CODEX_HOME: home };
  const result = { home, config, env, calls, sockets, requests, registryCalls };
  const request = (transport, requestOptions, callback) => {
    const call = { transport, options: requestOptions };
    calls.push(call);
    const req = resource(); requests.push(req);
    req.end = () => {
      setImmediate(() => {
        if (req.destroyed) return;
        if (requestOptions.method === 'CONNECT') {
          const socket = resource(); sockets.push(socket); req.emit('socket', socket);
          if (!config.holdConnect) req.emit('connect', { statusCode: config.proxyStatus || 200 }, socket, Buffer.alloc(0));
          return;
        }
        const socket = resource(); sockets.push(socket); req.emit('socket', socket);
        if (config.networkError) return req.emit('error', new Error(`secret ${token()}`));
        if (config.holdResponse) return;
        const response = resource(); result.response = response;
        response.statusCode = config.status || 200;
        response.headers = { ...(config.headers || {}) };
        callback(response);
        setImmediate(() => {
          if (response.destroyed) return;
          config.beforeResponse?.(result);
          const chunks = config.chunks || [Buffer.from(config.raw ?? JSON.stringify(config.body || metadata()))];
          for (const chunk of chunks) response.emit('data', chunk);
          response.emit('end');
        });
      });
    };
    return req;
  };
  result.deps = {
    env, platform: 'win32', now: () => now,
    execFile(file, args, settings, callback) {
      registryCalls.push({ file, args, settings });
      const child = resource();
      setImmediate(() => callback(config.registryError ? new Error('read failed') : null, config.registry ?? '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:8111;https=127.0.0.1:8222\r\n'));
      return child;
    },
    http: { request: (...args) => request('http', ...args) },
    https: { request: (...args) => request('https', ...args), Agent: class extends EventEmitter { constructor(options) { super(); this.options = options; } destroy() { this.destroyed = true; } } },
    tls: { connect(options) { result.tlsOptions = options; const socket = resource(); sockets.push(socket); if (!config.holdTls) setImmediate(() => { if (!socket.destroyed) socket.emit('secureConnect'); }); return socket; } },
    ...(options.deps || {})
  };
  return result;
}
async function rejects(f, code, parameters = input) {
  await assert.rejects(fetchAccountMetadata(parameters, f.deps), error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.stack.includes(token()), false, 'errors never contain a token');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const f = fixture();
  assert.deepEqual(await fetchAccountMetadata(input, f.deps), metadata(), 'all unknown values and nested metadata survive');
  assert.equal(f.calls.length, 2, 'exactly one CONNECT and one GET');
  assert.equal(f.calls[0].options.method, 'CONNECT');
  assert.equal(f.calls[0].options.hostname, '127.0.0.1');
  assert.equal(f.calls[0].options.port, 8222, 'uses the current HTTPS destination proxy');
  assert.deepEqual(f.calls[0].options.headers, { Host: 'chatgpt.com:443' }, 'no credential is sent as a proxy header');
  assert.equal(f.calls[1].options.hostname, 'chatgpt.com');
  assert.equal(f.calls[1].options.path, '/backend-api/accounts/check/v4-2023-04-27');
  assert.equal(f.calls[1].options.method, 'GET');
  assert.equal(f.calls[1].options.headers['ChatGPT-Account-ID'], input.accountId);
  assert.equal(f.calls[1].options.headers.originator, 'codex_cli_rs');
  assert.equal(f.calls[1].options.headers.Authorization, `Bearer ${token()}`);
  assert.equal(f.calls[1].options.headers['User-Agent'], 'BetterCodex/0.4.18');
  assert.equal(f.calls[1].options.rejectUnauthorized, true);
  assert.equal(f.tlsOptions.rejectUnauthorized, true);
  assert.equal(f.tlsOptions.servername, 'chatgpt.com');
  assert.ok(f.requests.every(req => req.destroyed));
  assert.ok(f.sockets.every(socket => socket.destroyed));
  assert.equal(f.registryCalls[0].file, 'reg.exe');
  assert.ok(f.registryCalls[0].args.includes('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'));

  f.config.registry = ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ alternate.example:9137\n';
  await fetchAccountMetadata(input, f.deps);
  assert.equal(f.registryCalls.length, 2, 'reads current system configuration for every invocation');
  assert.equal(f.calls[2].options.hostname, 'alternate.example');
  assert.equal(f.calls[2].options.port, 9137);

  const direct = fixture({ registry: ' ProxyEnable REG_DWORD 0x0\n ProxyServer REG_SZ ignored:8111\n' });
  await fetchAccountMetadata(input, direct.deps);
  assert.equal(direct.calls.length, 1);
  assert.equal(direct.calls[0].options.rejectUnauthorized, true);
  assert.equal(direct.calls[0].options.agent, false);
  const emptyPac = fixture({ registry: ' AutoConfigURL REG_SZ    \r\n ProxyEnable REG_DWORD 0x1\r\n ProxyServer REG_SZ http=127.0.0.1:8011;https=127.0.0.1:8012\r\n' });
  await fetchAccountMetadata(input, emptyPac.deps);
  assert.equal(emptyPac.calls[0].options.port, 8012, 'empty registry strings do not consume the next line');
  const secureProxy = fixture({ registry: ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ https://secure-proxy.example:8443\n' });
  await fetchAccountMetadata(input, secureProxy.deps);
  assert.equal(secureProxy.calls[0].transport, 'https');
  assert.equal(secureProxy.calls[0].options.rejectUnauthorized, true);

  for (const registry of [
    ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ socks=localhost:1080\n',
    ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ http=localhost:8080\n',
    ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ socks5://localhost:1080\n',
    ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ http://user:password@localhost:8080\n',
    ' ProxyEnable REG_DWORD 0x1\n ProxyServer REG_SZ http://localhost:8080/other\n',
    ' ProxyEnable REG_DWORD 0x1\n'
  ]) {
    const invalid = fixture({ registry }); await rejects(invalid, 'ACCOUNT_METADATA_PROXY_UNSUPPORTED'); assert.equal(invalid.calls.length, 0);
  }
  const pac = fixture({ registry: ' ProxyEnable REG_DWORD 0x0\n AutoConfigURL REG_SZ https://proxy.example/config.pac\n' });
  await rejects(pac, 'ACCOUNT_METADATA_PROXY_PAC_UNSUPPORTED'); assert.equal(pac.calls.length, 0);
  await rejects(fixture({ registryError: true }), 'ACCOUNT_METADATA_PROXY_READ_FAILED');
  await rejects(fixture({ deps: { platform: 'linux' } }), 'ACCOUNT_METADATA_PROXY_PLATFORM_UNSUPPORTED');
  for (const key of ['url', 'host', 'path', 'token', 'headers']) {
    const invalid = fixture(); await rejects(invalid, 'ACCOUNT_METADATA_INPUT_INVALID', { ...input, [key]: 'untrusted' }); assert.equal(invalid.calls.length, 0);
  }
  for (const id of ['', 'bad\nheader']) await rejects(fixture(), 'ACCOUNT_METADATA_INPUT_INVALID', { ...input, accountId: id });
  const mismatch = fixture({ token: token('other-user') }); await rejects(mismatch, 'ACCOUNT_METADATA_AUTH_MISMATCH'); assert.equal(mismatch.calls.length, 0);
  await rejects(fixture({ token: token(input.userId, now / 1000 - 1) }), 'ACCOUNT_METADATA_AUTH_EXPIRED');
  await rejects(fixture({ token: 'invalid' }), 'ACCOUNT_METADATA_AUTH_INVALID');
  const apiKeyMode = fixture(); fs.writeFileSync(path.join(apiKeyMode.home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: token() } }));
  await rejects(apiKeyMode, 'ACCOUNT_METADATA_AUTH_UNAVAILABLE'); assert.equal(apiKeyMode.calls.length, 0, 'inactive ChatGPT tokens cannot override current auth mode');
  const missing = fixture(); fs.unlinkSync(path.join(missing.home, 'auth.json')); await rejects(missing, 'ACCOUNT_METADATA_AUTH_UNAVAILABLE');
  const profile = path.join(root, 'profile'); auth(path.join(profile, '.codex'));
  const userProfile = fixture({ env: { USERPROFILE: profile } }); await fetchAccountMetadata(input, userProfile.deps);
  const precedence = fixture({ env: { CODEX_HOME: path.join(root, 'missing-codex-home'), USERPROFILE: profile } });
  await rejects(precedence, 'ACCOUNT_METADATA_AUTH_UNAVAILABLE');

  const switched = fixture({ beforeResponse: result => auth(result.home, token('other-user')) });
  await rejects(switched, 'ACCOUNT_METADATA_AUTH_MISMATCH');
  const refreshed = fixture({ beforeResponse: result => auth(result.home, token(input.userId, now / 1000 + 3600, { generation: 2 })) });
  await rejects(refreshed, 'ACCOUNT_METADATA_AUTH_CHANGED');
  const moved = fixture({ beforeResponse: result => { const other = path.join(root, 'other-home'); auth(other); result.env.CODEX_HOME = other; } });
  await rejects(moved, 'ACCOUNT_METADATA_AUTH_CHANGED');

  for (const status of [301, 302, 307, 308]) {
    const redirect = fixture({ status, headers: { location: 'https://evil.example/capture' } });
    await rejects(redirect, 'ACCOUNT_METADATA_REDIRECT_DENIED'); assert.equal(redirect.calls.length, 2);
  }
  const denied = fixture({ status: 403, raw: `private server body ${token()}` });
  await assert.rejects(fetchAccountMetadata(input, denied.deps), error => error.code === 'ACCOUNT_METADATA_HTTP_DENIED' && error.statusCode === 403 && error.message === 'ACCOUNT_METADATA_HTTP_DENIED');
  assert.equal(denied.calls.length, 2, 'denied requests do not retry');
  await rejects(fixture({ proxyStatus: 407 }), 'ACCOUNT_METADATA_PROXY_CONNECT_FAILED');
  await rejects(fixture({ raw: `not JSON ${token()}` }), 'ACCOUNT_METADATA_JSON_INVALID');
  await rejects(fixture({ networkError: true }), 'ACCOUNT_METADATA_NETWORK_FAILED');
  await rejects(fixture({ chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.from('x')] }), 'ACCOUNT_METADATA_RESPONSE_TOO_LARGE');
  await rejects(fixture({ headers: { 'content-length': 2 * 1024 * 1024 + 1 } }), 'ACCOUNT_METADATA_RESPONSE_TOO_LARGE');
  const restricted = metadata(); restricted.accounts[input.accountId].can_access_with_session = false;
  restricted.accounts[input.accountId].account.is_deactivated = true;
  assert.deepEqual(await fetchAccountMetadata(input, fixture({ body: restricted }).deps), restricted, 'denial and deactivation are never rewritten');
  const defaultKey = metadata(); defaultKey.accounts.default = defaultKey.accounts[input.accountId]; delete defaultKey.accounts[input.accountId]; defaultKey.account_ordering = ['default'];
  assert.deepEqual(await fetchAccountMetadata(input, fixture({ body: defaultKey }).deps), defaultKey, 'native default map key need not equal the account UUID');
  const alias = metadata(); alias.accounts.default = structuredClone(alias.accounts[input.accountId]);
  assert.deepEqual(await fetchAccountMetadata(input, fixture({ body: alias }).deps), alias, 'official default and UUID aliases are accepted only when the complete records agree');
  alias.account_ordering = ['default'];
  assert.deepEqual(await fetchAccountMetadata(input, fixture({ body: alias }).deps), alias, 'either matching alias may be in account ordering');
  for (const mutate of [
    record => { record.account.account_user_role = 'reader'; },
    record => { record.can_access_with_session = false; },
    record => { record.permissions.future_unknown = true; },
    record => { record.entitlement = {}; }
  ]) {
    const conflict = metadata(); conflict.accounts.default = structuredClone(conflict.accounts[input.accountId]); mutate(conflict.accounts.default);
    await rejects(fixture({ body: conflict }), 'ACCOUNT_METADATA_SCHEMA_INVALID');
  }
  const organization = metadata(); organization.accounts[input.accountId].account.structure = 'organization';
  await rejects(fixture({ body: organization }), 'ACCOUNT_METADATA_WORKSPACE_POLICY');
  for (const mutation of [
    body => { delete body.accounts[input.accountId].account.account_user_id; },
    body => { body.accounts[input.accountId].account.account_user_role = null; },
    body => { body.accounts[input.accountId].account.is_zdr = null; },
    body => { body.accounts[input.accountId].account.account_id = 'other'; },
    body => { body.accounts[input.accountId].can_access_with_session = 'false'; },
    body => { body.accounts[input.accountId].account.is_deactivated = 0; },
    body => { body.accounts = {}; },
    body => { body.account_ordering = []; }
  ]) { const body = metadata(); mutation(body); await rejects(fixture({ body }), 'ACCOUNT_METADATA_SCHEMA_INVALID'); }

  const already = new AbortController(); already.abort();
  const early = fixture(); await rejects(early, 'ACCOUNT_METADATA_ABORTED', { ...input, signal: already.signal }); assert.equal(early.calls.length, 0);
  for (const phase of ['holdConnect', 'holdTls', 'holdResponse']) {
    const stopped = fixture({ [phase]: true }); const controller = new AbortController();
    const pending = fetchAccountMetadata({ ...input, signal: controller.signal }, stopped.deps);
    for (let i = 0; i < 10 && !stopped.calls.length; i++) await tick();
    // Allow the selected network stage to establish before cancelling.
    await tick(); await tick();
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ACCOUNT_METADATA_ABORTED');
    assert.ok(stopped.requests.every(req => req.destroyed)); assert.ok(stopped.sockets.every(socket => socket.destroyed));
  }
  const timeout = fixture({ holdResponse: true, deps: { setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 12000); return setTimeout(callback, 20); } } });
  await rejects(timeout, 'ACCOUNT_METADATA_TIMEOUT');
  assert.ok(timeout.requests.every(req => req.destroyed)); assert.ok(timeout.sockets.every(socket => socket.destroyed));
  console.log('account metadata transport: fixed official endpoint, current auth/proxy, TLS, unchanged denial, identity, cancellation, timeout and response limits passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));

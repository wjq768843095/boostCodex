'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

const HOST = 'chatgpt.com';
const ENDPOINT = '/backend-api/accounts/check/v4-2023-04-27';
const TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function failure(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  if (code === 'ACCOUNT_METADATA_ABORTED') error.name = 'AbortError';
  return error;
}

function proxyAddress(value) {
  const address = value.trim();
  if (!address || /[\s@/?#]/.test(address.replace(/^https?:\/\//i, ''))) throw failure('ACCOUNT_METADATA_PROXY_UNSUPPORTED');
  let url;
  try { url = new URL(address.includes('://') ? address : `http://${address}`); } catch { throw failure('ACCOUNT_METADATA_PROXY_UNSUPPORTED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw failure('ACCOUNT_METADATA_PROXY_UNSUPPORTED');
  // WinINET's protocol map describes the destination protocol, not the proxy's TLS mode.
  return { protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

async function systemProxy(deps) {
  if (deps.platform !== 'win32') throw failure('ACCOUNT_METADATA_PROXY_PLATFORM_UNSUPPORTED');
  const output = await new Promise((resolve, reject) => {
    const child = deps.execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) reject(failure('ACCOUNT_METADATA_PROXY_READ_FAILED')); else resolve(stdout);
    });
    deps.track(child);
  });
  const value = name => String(output).split(/\r?\n/).map(line => line.match(new RegExp(`^[ \\t]*${name}[ \\t]+REG_\\w+[ \\t]*(.*?)[ \\t]*$`, 'i'))).find(Boolean)?.[1] || '';
  if (value('AutoConfigURL')) throw failure('ACCOUNT_METADATA_PROXY_PAC_UNSUPPORTED');
  const enable = value('ProxyEnable');
  if (!enable || /^(?:0x0|0)$/i.test(enable)) return null;
  if (!/^(?:0x1|1)$/i.test(enable)) throw failure('ACCOUNT_METADATA_PROXY_UNSUPPORTED');
  const server = value('ProxyServer');
  if (!server) throw failure('ACCOUNT_METADATA_PROXY_UNSUPPORTED');
  if (!server.includes('=')) return proxyAddress(server);
  const entries = server.split(';').map(entry => entry.trim()).filter(Boolean);
  const match = entries.find(entry => /^https=/i.test(entry));
  if (!match) throw failure('ACCOUNT_METADATA_PROXY_UNSUPPORTED');
  return proxyAddress(match.slice(match.indexOf('=') + 1));
}

async function nativeIdentity(deps, userId) {
  const env = deps.env;
  const home = env.CODEX_HOME || (env.USERPROFILE && path.join(env.USERPROFILE, '.codex'));
  if (!home) throw failure('ACCOUNT_METADATA_AUTH_UNAVAILABLE');
  const authPath = path.resolve(home, 'auth.json');
  let auth;
  try {
    const raw = await deps.fs.readFile(authPath, 'utf8');
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error();
    auth = JSON.parse(raw);
  } catch { throw failure('ACCOUNT_METADATA_AUTH_UNAVAILABLE'); }
  if (auth?.auth_mode && auth.auth_mode !== 'chatgpt') throw failure('ACCOUNT_METADATA_AUTH_UNAVAILABLE');
  const token = auth?.tokens?.access_token;
  if (typeof token !== 'string' || token.length > 256 * 1024) throw failure('ACCOUNT_METADATA_AUTH_UNAVAILABLE');
  let claims;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw failure('ACCOUNT_METADATA_AUTH_INVALID'); }
  if (claims?.['https://api.openai.com/auth']?.chatgpt_user_id !== userId) throw failure('ACCOUNT_METADATA_AUTH_MISMATCH');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= deps.now()) throw failure('ACCOUNT_METADATA_AUTH_EXPIRED');
  return { token, authPath };
}

function validateMetadata(body, accountId) {
  if (!object(body) || !object(body.accounts) || !Array.isArray(body.account_ordering) || !body.account_ordering.every(id => typeof id === 'string')) throw failure('ACCOUNT_METADATA_SCHEMA_INVALID');
  const matches = Object.entries(body.accounts).filter(([, record]) => record?.account?.account_id === accountId);
  if (matches.length !== 1 || !body.account_ordering.includes(matches[0][0])) throw failure('ACCOUNT_METADATA_SCHEMA_INVALID');
  const record = matches[0][1];
  const account = record?.account;
  if (!object(record) || !object(account) || account.account_id !== accountId || !['account_id', 'account_user_id', 'account_user_role', 'structure', 'plan_type'].every(key => own(account, key) && typeof account[key] === 'string' && account[key].length > 0) || !own(account, 'is_zdr') || typeof account.is_zdr !== 'boolean') throw failure('ACCOUNT_METADATA_SCHEMA_INVALID');
  if (account.structure !== 'personal') throw failure('ACCOUNT_METADATA_WORKSPACE_POLICY');
  if ((own(account, 'is_deactivated') && typeof account.is_deactivated !== 'boolean') || (own(record, 'can_access_with_session') && typeof record.can_access_with_session !== 'boolean')) throw failure('ACCOUNT_METADATA_SCHEMA_INVALID');
  return body;
}

/** Fixed, single-use metadata transport. Credentials never cross the local caller boundary. */
function fetchAccountMetadata(input, dependencies = {}) {
  const deps = { fs, http, https, tls, execFile, env: process.env, platform: process.platform, now: Date.now, setTimeout, clearTimeout, ...dependencies };
  return new Promise((resolve, reject) => {
    const resources = new Set();
    let finished = false;
    let timer;
    const signal = input?.signal;
    const accountId = input?.accountId;
    const userId = input?.userId;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      deps.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      for (const resource of resources) {
        try { if (typeof resource.destroy === 'function') resource.destroy(); else if (typeof resource.kill === 'function') resource.kill(); } catch {}
      }
      resources.clear();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(failure('ACCOUNT_METADATA_ABORTED'));
    const safeNetworkError = () => finish(failure('ACCOUNT_METADATA_NETWORK_FAILED'));
    deps.track = resource => {
      if (resource) {
        resources.add(resource);
        resource.on?.('error', safeNetworkError);
        if (finished) { try { resource.destroy?.(); resource.kill?.(); } catch {} }
      }
      return resource;
    };
    if (!object(input) || Object.keys(input).some(key => !['accountId', 'userId', 'signal'].includes(key)) || ![input.accountId, input.userId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(id)) || (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) return finish(failure('ACCOUNT_METADATA_INPUT_INVALID'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = deps.setTimeout(() => finish(failure('ACCOUNT_METADATA_TIMEOUT')), TIMEOUT_MS);

    (async () => {
      const identity = await nativeIdentity(deps, userId);
      if (finished) return;
      const proxy = await systemProxy(deps);
      if (finished) return;
      const beforeSend = await nativeIdentity(deps, userId);
      if (finished) return;
      if (identity.token !== beforeSend.token || identity.authPath !== beforeSend.authPath) throw failure('ACCOUNT_METADATA_AUTH_CHANGED');
      const headers = { Authorization: `Bearer ${identity.token}`, 'ChatGPT-Account-ID': accountId, originator: 'codex_cli_rs', 'User-Agent': 'BetterCodex/0.4.18', Accept: 'application/json', 'Accept-Encoding': 'identity' };
      const receive = response => {
        deps.track(response);
        if (finished) return;
        if (response.statusCode !== 200) return finish(failure(response.statusCode >= 300 && response.statusCode < 400 ? 'ACCOUNT_METADATA_REDIRECT_DENIED' : 'ACCOUNT_METADATA_HTTP_DENIED', response.statusCode));
        if (Number(response.headers?.['content-length']) > MAX_BYTES) return finish(failure('ACCOUNT_METADATA_RESPONSE_TOO_LARGE'));
        let bytes = 0;
        const chunks = [];
        response.on('aborted', safeNetworkError);
        response.on('data', chunk => {
          if (finished) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_BYTES) return finish(failure('ACCOUNT_METADATA_RESPONSE_TOO_LARGE'));
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (finished) return;
          (async () => {
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('ACCOUNT_METADATA_JSON_INVALID'); }
            validateMetadata(body, accountId);
            const current = await nativeIdentity(deps, userId);
            if (finished) return;
            if (identity.token !== current.token || identity.authPath !== current.authPath) throw failure('ACCOUNT_METADATA_AUTH_CHANGED');
            finish(null, body);
          })().catch(error => finish(error?.code?.startsWith('ACCOUNT_METADATA_') ? error : failure('ACCOUNT_METADATA_FAILED')));
        });
      };
      const send = secureSocket => {
        if (finished) return;
        let agent = false;
        if (secureSocket) {
          agent = deps.track(new deps.https.Agent({ keepAlive: false, maxSockets: 1 }));
          agent.createConnection = () => secureSocket;
        }
        const request = deps.track(deps.https.request({ protocol: 'https:', hostname: HOST, port: 443, method: 'GET', path: ENDPOINT, headers, agent, rejectUnauthorized: true, servername: HOST, timeout: TIMEOUT_MS }, receive));
        request.on('timeout', () => finish(failure('ACCOUNT_METADATA_TIMEOUT')));
        request.on('socket', socket => deps.track(socket));
        request.end();
      };
      if (!proxy) return send();
      const client = proxy.protocol === 'https:' ? deps.https : deps.http;
      const connect = deps.track(client.request({ protocol: proxy.protocol, hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${HOST}:443`, headers: { Host: `${HOST}:443` }, agent: false, rejectUnauthorized: true, timeout: TIMEOUT_MS }, response => {
        deps.track(response);
        finish(failure('ACCOUNT_METADATA_PROXY_CONNECT_FAILED', response.statusCode));
      }));
      connect.on('socket', socket => deps.track(socket));
      connect.on('timeout', () => finish(failure('ACCOUNT_METADATA_TIMEOUT')));
      connect.on('connect', (response, socket, head) => {
        deps.track(socket);
        if (finished) return;
        if (response.statusCode !== 200 || head?.length) return finish(failure('ACCOUNT_METADATA_PROXY_CONNECT_FAILED', response.statusCode));
        const secure = deps.track(deps.tls.connect({ socket, servername: HOST, rejectUnauthorized: true }));
        secure.once('secureConnect', () => send(secure));
      });
      connect.end();
    })().catch(error => finish(error?.code?.startsWith('ACCOUNT_METADATA_') ? error : failure('ACCOUNT_METADATA_FAILED')));
  });
}

module.exports = { fetchAccountMetadata };

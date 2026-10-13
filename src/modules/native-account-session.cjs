'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

// This connection only reads account metadata. It never starts or resumes turns.
class NativeAccountSession {
  constructor({ home, executable, version, spawn = cp.spawn, timeoutMs = 5000 }) {
    this.home = home;
    this.executable = executable;
    this.version = version;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.instanceId = crypto.randomUUID();
    this.pending = new Map();
    this.sequence = 0;
    this.connected = false;
    this.stopped = true;
    this.child = null;
    this.starting = null;
    this.error = null;
  }

  status() {
    return {
      connected: this.connected,
      required: false,
      error: this.error,
      host: {
        pid: this.child?.pid || null,
        instanceId: this.instanceId,
        app_server_pid: this.child?.pid || null,
        command_in_flight: this.pending.size > 0,
        pending_requests: this.pending.size,
        queued_deliveries: 0,
        active_turns: [],
        capabilities: ['account/rateLimits/read']
      }
    };
  }

  publish() {
    const file = path.join(this.home, 'run', 'session-host-status.json');
    const temp = file + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const status = this.status();
    fs.writeFileSync(temp, JSON.stringify({ ...status.host, runtime_pid: process.pid, connected: status.connected, error: status.error, updated_at: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  async start() {
    if (this.connected) return this;
    if (this.starting) return this.starting;
    this.stopped = false;
    const operation = this.open();
    this.starting = operation;
    try { return await operation; }
    finally { if (this.starting === operation) this.starting = null; }
  }

  async open() {
    let child;
    try {
      child = this.spawn(this.executable(), ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      this.error = 'native_account_connection_failed';
      this.publish();
      throw new Error(this.error);
    }
    this.child = child;
    this.error = null;
    let buffer = '';
    const fail = () => {
      if (this.child !== child) return;
      this.connected = false;
      this.error = this.stopped ? null : 'native_account_connection_closed';
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('native_account_connection_closed'));
      }
      this.pending.clear();
      this.child = null;
      this.publish();
    };
    child.once('error', fail);
    child.once('close', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1024 * 1024) { this.stop(); return; }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (Buffer.byteLength(line) > 256 * 1024) { this.stop(); return; }
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error('native_account_request_failed'));
          else pending.resolve(message.result);
          this.publish();
        } else if (message.id !== undefined && message.method) {
          // The read-only client never grants a server request to run tools.
          this.write({ id: message.id, error: { code: -32601, message: 'Method not available' } });
        }
      }
    });
    this.publish();
    try {
      const initialized = await this.send('initialize', { clientInfo: { name: 'better-codex', title: 'Better Codex', version: this.version }, capabilities: { experimentalApi: true } });
      if (!initialized || typeof initialized !== 'object' || Array.isArray(initialized)) throw new Error('native_account_initialize_failed');
      if (this.stopped || this.child !== child) throw new Error('native_account_connection_closed');
      this.write({ method: 'initialized', params: {} });
      this.connected = true;
      this.publish();
      return this;
    } catch (error) {
      this.stop();
      this.error = 'native_account_initialize_failed';
      this.publish();
      throw new Error(this.error);
    }
  }

  write(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('native_account_connection_closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  send(method, params = {}) {
    if (!['initialize', 'account/rateLimits/read'].includes(method)) return Promise.reject(new Error('native_account_method_unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.publish();
        reject(new Error('native_account_request_timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); this.publish(); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async readUsage() {
    await this.start();
    return this.send('account/rateLimits/read');
  }

  async stop() {
    this.stopped = true;
    this.connected = false;
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('native_account_connection_closed'));
    }
    this.pending.clear();
    if (child) {
      child.stdin.destroy();
      child.stdout.destroy();
      try { child.kill(); } catch {}
    }
    this.error = null;
    this.publish();
  }
}

module.exports = { NativeAccountSession };

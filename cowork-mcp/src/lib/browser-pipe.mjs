/**
 * Client for communicating with Claude in Chrome extension over Windows Named Pipe.
 *
 * Bridge path: \\.\pipe\claude-mcp-browser-bridge-<USERNAME>
 *
 * Wire protocol:
 * - 4 bytes little-endian length prefix
 * - UTF-8 JSON payload
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { ensureChromeHostRegistered } from './chrome-host.mjs';

export function getBrowserPipeName() {
  const user = process.env.USERNAME || process.env.USER || 'default';
  return `\\\\.\\pipe\\claude-mcp-browser-bridge-${user}`;
}

export class BrowserPipeClient {
  constructor(pipeName = getBrowserPipeName()) {
    this.pipeName = pipeName;
    this.socket = null;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = Buffer.alloc(0);
    this.connecting = false;
  }

  _connectSingle() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.pipeName);

      socket.once('connect', () => {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        resolve(socket);
      });

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });

      socket.on('error', (err) => {
        reject(err);
      });

      socket.on('close', () => {
        this.socket = null;
        for (const [id, req] of this.pending.entries()) {
          clearTimeout(req.timer);
          req.reject(new Error('Connection closed while waiting for tool response'));
        }
        this.pending.clear();
      });
    });
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    if (this.connecting) {
      return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          if (this.socket && !this.socket.destroyed) {
            clearInterval(interval);
            resolve(this.socket);
          } else if (!this.connecting) {
            clearInterval(interval);
            reject(new Error('Connection attempt failed'));
          }
        }, 50);
      });
    }

    this.connecting = true;
    try {
      try {
        const sock = await this._connectSingle();
        return sock;
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Self-heal: ensure Native Host registry keys and manifest are active
          try {
            ensureChromeHostRegistered();
          } catch {}

          // Poll up to 3 times for Chrome to launch native host and pipe to become available
          for (let attempt = 1; attempt <= 3; attempt++) {
            await new Promise((r) => setTimeout(r, 600));
            try {
              const sock = await this._connectSingle();
              return sock;
            } catch {
              /* wait for next attempt */
            }
          }

          throw new Error(
            'Cannot connect to Claude in Chrome extension (Named Pipe not found).\n' +
              'Please ensure:\n' +
              '1. Google Chrome is running.\n' +
              '2. The extension "Claude in Chrome (Gateway Edition)" is loaded.\n' +
              '3. Reload the extension once at chrome://extensions if you just updated it.',
          );
        }
        throw err;
      }
    } finally {
      this.connecting = false;
    }
  }

  drain() {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) {
        break; // Wait for full frame
      }
      const raw = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      try {
        const msg = JSON.parse(raw.toString('utf8'));
        this.handleMessage(msg);
      } catch (e) {
        console.error('[browser-pipe] Failed to parse message JSON:', e);
      }
    }
  }

  handleMessage(msg) {
    if (msg.tool_use_id && this.pending.has(msg.tool_use_id)) {
      const req = this.pending.get(msg.tool_use_id);
      this.pending.delete(msg.tool_use_id);
      clearTimeout(req.timer);
      req.resolve(msg);
      return;
    }

    // Ping / status messages
    if (msg.type === 'ping' && this.socket && !this.socket.destroyed) {
      this.writeRaw({ type: 'pong' });
    }
  }

  writeRaw(obj) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Socket not connected');
    }
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    this.socket.write(Buffer.concat([len, buf]));
  }

  async callTool(toolName, args = {}, timeoutMs = 30000) {
    await this.connect();

    const toolUseId = crypto.randomUUID();
    const frame = {
      type: 'tool_request',
      method: 'execute_tool',
      params: {
        tool_use_id: toolUseId,
        tool: toolName,
        args,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        reject(new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(toolUseId, { resolve, reject, timer });

      try {
        this.writeRaw(frame);
      } catch (err) {
        this.pending.delete(toolUseId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  disconnect() {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }
  }
}

let defaultClient = null;

export function getBrowserClient() {
  if (!defaultClient) {
    defaultClient = new BrowserPipeClient();
  }
  return defaultClient;
}

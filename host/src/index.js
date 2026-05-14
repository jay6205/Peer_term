/**
 * PeerTerm Host Agent
 *
 * CLI tool that:
 *   1. Connects to the relay server and registers sessions
 *   2. Manages multiple simultaneous sessions
 *   3. Performs ECDH key exchange for E2E encryption per session
 *   4. Spawns independent PTY instances per session
 *   5. Supports read-only mode and terminal resize
 *
 * CLI flags:
 *   --expiry <value>   Session code expiry (e.g. 5m, 30s, 1h). Default: 5m
 *   --readonly         Prevent client keystrokes from reaching the PTY
 *   --path <dir>       Starting directory for the terminal session
 *   --relay <url>      Custom relay server URL
 *   --verbose          Enable debug-level logging
 *   --help             Show usage information
 *   --version          Print version number
 */

import * as dotenv from 'dotenv';
import os from 'os';
import fs from 'fs';
import path from 'path';
import net from 'net';
import readline from 'readline';
import { exec as cpExec } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import pty from 'node-pty';
import minimist from 'minimist';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from './crypto.js';
import { HostWebRTC } from './webrtc.js';
import logger, { writeToErrorLog } from './logger.js';
import { printBanner, printSessionBox, printHelp, printVersion } from './ui.js';

// ─── File paths ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from host/ directory (parent of src/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  boolean: ['readonly', 'verbose', 'help', 'version'],
  string: ['expiry', 'relay', 'path'],
  alias: { h: 'help', v: 'version', V: 'verbose' },
  default: { expiry: '5m' },
});

// Handle --help
if (argv.help) {
  printHelp();
  process.exit(0);
}

// Handle --version
if (argv.version) {
  printVersion();
  process.exit(0);
}

// Enable verbose logging
if (argv.verbose) {
  logger.setVerbose(true);
}

// ─── Configuration ───────────────────────────────────────────────────────────
const RELAY_URL = argv.relay || process.env.RELAY_URL || 'ws://localhost:8080';
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_PINGS = 2;

// ─── Path Resolution ─────────────────────────────────────────────────────────

function expandTilde(inputPath) {
  if (inputPath.startsWith('~/') || inputPath === '~') {
    return inputPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
  }
  return inputPath;
}

function resolveStartPath(inputPath) {
  if (!inputPath) return process.env.HOME || process.env.USERPROFILE || process.cwd();

  const resolved = path.resolve(expandTilde(inputPath));

  if (!fs.existsSync(resolved)) {
    logger.error(`Path does not exist: ${resolved}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    logger.error(`Path is not a directory: ${resolved}`);
    process.exit(1);
  }

  return resolved;
}

// ─── Duration Parsing ────────────────────────────────────────────────────────

function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default:  return null;
  }
}

function formatDuration(ms) {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)} hour(s)`;
  if (ms >= 60000) return `${Math.round(ms / 60000)} minute(s)`;
  return `${Math.round(ms / 1000)} second(s)`;
}

function getExpiry() {
  const parsed = parseDuration(argv.expiry);
  if (!parsed) {
    logger.error(`Invalid expiry format: "${argv.expiry}". Use 30s, 5m, or 1h.`);
    process.exit(1);
  }
  return parsed;
}

// ─── Shell Detection ─────────────────────────────────────────────────────────

function detectShell() {
  const platform = os.platform();
  if (process.env.SHELL) return process.env.SHELL;
  if (platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
    const username = os.userInfo().username;
    const line = passwd.split('\n').find((l) => l.startsWith(username + ':'));
    if (line) {
      const shell = line.split(':').pop().trim();
      if (shell) return shell;
    }
  } catch {}
  return platform === 'win32' ? 'powershell.exe' : 'bash';
}

// ─── Session Class ───────────────────────────────────────────────────────────

class Session {
  constructor(shell, expiryMs, readOnly, startPath, onDestroy) {
    this.shell = shell;
    this.expiryMs = expiryMs;
    this.readOnly = readOnly;
    this.startPath = startPath;
    this.onDestroy = onDestroy;

    this.ws = null;
    this.code = null;
    this.keyPair = null;
    this.sharedKey = null;
    this.ptyProcess = null;
    this.heartbeatInterval = null;
    this.missedPings = 0;
    this.isClientConnected = false;
    this.awaitingRejoin = false;
    this.destroyed = false;
    this.createdAt = Date.now();

    // Phase 4: WebRTC state
    this.webrtc = null;
    this.useDataChannel = false;

    // Local TCP viewer (new terminal window)
    this.viewerServer = null;
    this.viewerSocket = null;
  }

  log(msg) {
    const prefix = this.code ? `[${this.code}]` : '[???]';
    logger.info(`${prefix} ${msg}`);
  }

  logDebug(msg) {
    const prefix = this.code ? `[${this.code}]` : '[???]';
    logger.debug(`${prefix} ${msg}`);
  }

  // ─── Start the session ──────────────────────────────────────────────
  async start() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(RELAY_URL);

      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'host-register',
          expiry: this.expiryMs,
          readonly: this.readOnly,
        }));
      });

      this.ws.on('message', async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.log('Invalid message from relay');
          return;
        }

        switch (msg.type) {
          case 'code': {
            this.code = msg.code;
            printSessionBox({
              code: this.code,
              expiry: formatDuration(this.expiryMs),
              mode: this.readOnly ? 'Read-Only' : 'Read-Write',
              shell: this.shell,
              startPath: this.startPath,
            });
            resolve(this.code);
            break;
          }

          case 'client-connected': {
            if (this.awaitingRejoin) {
              this.log('Client reconnected.');
              this.awaitingRejoin = false;
            } else {
              this.log('Client connected! Starting key exchange...');
            }
            this.isClientConnected = true;
            this.missedPings = 0;

            this.keyPair = await generateKeyPair();
            const pubKeyBase64 = await exportPublicKey(this.keyPair.publicKey);
            this.ws.send(JSON.stringify({ type: 'key-exchange', publicKey: pubKeyBase64 }));
            break;
          }

          case 'key-exchange': {
            if (!this.keyPair) return;
            this.logDebug('Deriving shared secret...');

            const peerPublicKey = await importPublicKey(msg.publicKey);
            this.sharedKey = await deriveSharedKey(this.keyPair.privateKey, peerPublicKey);
            this.log('Encrypted tunnel active');

            this.startHeartbeat();

            if (!this.ptyProcess) {
              this.spawnTerminal();
            }

            // Phase 4: Initiate WebRTC after encryption is ready
            this._initiateWebRTC();
            break;
          }

          // Phase 4: WebRTC signaling messages
          case 'signal': {
            if (this.webrtc && this.sharedKey) {
              try {
                const plaintext = await decrypt(this.sharedKey, msg.payload);
                this.webrtc.handleSignal(JSON.parse(plaintext));
              } catch (err) {
                this.logDebug(`[WebRTC] Signal decryption failed: ${err.message}`);
              }
            }
            break;
          }

          case 'heartbeat': {
            this.missedPings = 0;
            break;
          }

          case 'data': {
            if (!this.sharedKey || !this.ptyProcess) return;
            try {
              const plaintext = await decrypt(this.sharedKey, msg.payload);

              // Check if this is a resize event
              if (msg.meta === 'resize') {
                try {
                  const resizeData = JSON.parse(plaintext);
                  if (resizeData.type === 'resize' && resizeData.cols && resizeData.rows) {
                    this.ptyProcess.resize(resizeData.cols, resizeData.rows);
                    this.logDebug(`Terminal resized to ${resizeData.cols}x${resizeData.rows}`);
                  }
                } catch {}
                return;
              }

              // Normal keystroke — drop if read-only
              if (this.readOnly) return;
              this.ptyProcess.write(plaintext);
            } catch (err) {
              this.log(`Decryption failed: ${err.message}`);
            }
            break;
          }

          case 'peer-disconnected': {
            this.log('Client disconnected. Rejoin window: 2 minutes.');
            this.isClientConnected = false;
            this.awaitingRejoin = true;
            this.sharedKey = null;
            this.keyPair = null;
            this.stopHeartbeat();
            // Phase 4: Clean up WebRTC on peer disconnect
            this._cleanupWebRTC();
            break;
          }

          case 'session-expired': {
            this.log('Rejoin window expired. Session ended.');
            this.destroy();
            break;
          }

          case 'error': {
            this.log(`Error: ${msg.msg}`);
            break;
          }
        }
      });

      this.ws.on('close', () => {
        if (!this.destroyed) {
          this.log('Connection to relay lost.');
          this.destroy();
        }
      });

      this.ws.on('error', (err) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          logger.error(`Relay not reachable at ${RELAY_URL}`, err);
          reject(err);
        } else {
          this.log(`WS error: ${err.message}`);
        }
      });
    });
  }

  // ─── Send encrypted resize to client ────────────────────────────────
  async _sendResize(cols, rows) {
    if (!this.sharedKey) return;
    try {
      const resizeJson = JSON.stringify({ type: 'resize', cols, rows });
      const payload = await encrypt(this.sharedKey, resizeJson);
      // Phase 4: Route through DataChannel if active, else relay
      if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
        // Send resize as a tagged message so client can distinguish
        this.webrtc.send(JSON.stringify({ _meta: 'resize', payload }));
      } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'data', payload, meta: 'resize' }));
      }
    } catch {}
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────
  startHeartbeat() {
    this.stopHeartbeat();
    this.missedPings = 0;
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
      this.missedPings++;
      if (this.missedPings >= MAX_MISSED_PINGS + 1) {
        this.log('Client heartbeat lost. Waiting for reconnect...');
        this.isClientConnected = false;
        this.awaitingRejoin = true;
        this.sharedKey = null;
        this.keyPair = null;
        this.stopHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ─── Spawn PTY ──────────────────────────────────────────────────────
  spawnTerminal() {
    const cols = 80;
    const rows = 24;
    this.log(`Spawning terminal: ${this.shell} (${cols}x${rows})`);

    this.ptyProcess = pty.spawn(this.shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.startPath,
      env: process.env,
    });

    this.ptyProcess.onData(async (data) => {
      // Mirror PTY output to local viewer terminal
      if (this.viewerSocket) {
        try { this.viewerSocket.write(data); } catch {}
      }

      if (!this.sharedKey) return;
      try {
        const payload = await encrypt(this.sharedKey, data);
        // Phase 4: Route through DataChannel if active, else relay
        if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
          this.webrtc.send(payload);
        } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'data', payload }));
        }
      } catch {}
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.log(`Shell exited with code ${exitCode}`);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'session-ended' }));
      }
      this.destroy();
    });

    // Open a local viewer terminal for the host
    this._startViewerServer();
  }

  // ─── Local TCP viewer for host terminal ─────────────────────────────
  _startViewerServer() {
    this.viewerServer = net.createServer((socket) => {
      // Close any existing viewer connection before accepting a new one
      if (this.viewerSocket) {
        this.logDebug('Replacing existing viewer connection.');
        this.viewerSocket.removeAllListeners();
        try { this.viewerSocket.destroy(); } catch {}
      }
      this.viewerSocket = socket;
      this.log('Host viewer connected.');

      socket.on('data', (data) => {
        // Control messages (resize) start with \x00
        if (data[0] === 0x00) {
          try {
            const msg = JSON.parse(data.slice(1).toString().trim());
            if (msg.type === 'resize' && msg.cols && msg.rows && this.ptyProcess) {
              this.ptyProcess.resize(msg.cols, msg.rows);
              this._sendResize(msg.cols, msg.rows);
              this.logDebug(`Viewer resized to ${msg.cols}x${msg.rows}`);
            }
          } catch {}
          return;
        }
        // Host keystrokes → PTY (host always has access, readOnly only blocks web client)
        if (this.ptyProcess) {
          this.ptyProcess.write(data);
        }
      });

      socket.on('close', () => {
        this.viewerSocket = null;
        this.logDebug('Host viewer disconnected.');
      });

      socket.on('error', () => {
        this.viewerSocket = null;
      });
    });

    this.viewerServer.listen(0, '127.0.0.1', () => {
      const port = this.viewerServer.address().port;
      this.logDebug(`Viewer server on port ${port}`);
      this._openViewerTerminal(port);
    });
  }

  _openViewerTerminal(port) {
    const viewerScript = path.join(__dirname, 'session-viewer.js');
    const platform = os.platform();

    if (platform === 'win32') {
      cpExec(`start "PeerTerm - ${this.code}" cmd /c node "${viewerScript}" ${port} ${this.code}`);
    } else if (platform === 'darwin') {
      cpExec(`osascript -e 'tell app "Terminal" to do script "node \"${viewerScript}\" ${port} ${this.code}"'`);
    } else {
      // Linux: try common terminal emulators
      cpExec(`x-terminal-emulator -e "node '${viewerScript}' ${port} ${this.code}" 2>/dev/null || gnome-terminal -- node "${viewerScript}" ${port} ${this.code} 2>/dev/null || xterm -e "node '${viewerScript}' ${port} ${this.code}"`);
    }
    this.log('Opening terminal viewer...');
  }

  // ─── Destroy ────────────────────────────────────────────────────────
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopHeartbeat();
    // Clean up viewer
    if (this.viewerSocket) {
      try { this.viewerSocket.destroy(); } catch {}
      this.viewerSocket = null;
    }
    if (this.viewerServer) {
      try { this.viewerServer.close(); } catch {}
      this.viewerServer = null;
    }
    // Phase 4: Clean up WebRTC
    this._cleanupWebRTC();
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch {}
      this.ptyProcess = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.log('Session ended.');
    if (this.onDestroy) this.onDestroy(this.code);
  }

  // ─── Phase 4: WebRTC helpers ─────────────────────────────────────

  _initiateWebRTC() {
    // Clean up any previous WebRTC instance
    this._cleanupWebRTC();

    // Pass debug-level logger to WebRTC (internal messages are verbose)
    this.webrtc = new HostWebRTC((msg) => this.logDebug(msg));

    this.webrtc.onOpen(() => {
      this.useDataChannel = true;
      this.log('DataChannel open — relay bypassed');
    });

    this.webrtc.onClose(() => {
      if (this.useDataChannel) {
        this.log('DataChannel closed — falling back to relay');
        this.useDataChannel = false;
      }
    });

    this.webrtc.onMessage(async (data) => {
      if (!this.sharedKey || !this.ptyProcess) return;
      try {
        // Check if this is a tagged message (resize)
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = null;
        }

        if (parsed && parsed._meta === 'resize') {
          const resizeData = JSON.parse(await decrypt(this.sharedKey, parsed.payload));
          if (resizeData.type === 'resize' && resizeData.cols && resizeData.rows) {
            this.ptyProcess.resize(resizeData.cols, resizeData.rows);
            this.logDebug(`Terminal resized to ${resizeData.cols}x${resizeData.rows}`);
          }
          return;
        }

        // Normal encrypted terminal data
        const plaintext = await decrypt(this.sharedKey, data);
        if (this.readOnly) return;
        this.ptyProcess.write(plaintext);
      } catch (err) {
        this.logDebug(`[WebRTC] Decryption failed: ${err.message}`);
      }
    });

    // Start the WebRTC negotiation
    this.webrtc.initiate(async (msg) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sharedKey) {
        try {
          const payloadStr = JSON.stringify(msg.payload);
          const encryptedPayload = await encrypt(this.sharedKey, payloadStr);
          this.ws.send(JSON.stringify({ type: 'signal', payload: encryptedPayload }));
        } catch (e) {
          this.logDebug(`[WebRTC] Failed to encrypt signal: ${e.message}`);
        }
      }
    });
  }

  _cleanupWebRTC() {
    this.useDataChannel = false;
    if (this.webrtc) {
      this.webrtc.close();
      this.webrtc = null;
    }
  }

  // ─── Status string for list command ─────────────────────────────────
  getStatus() {
    const elapsed = Date.now() - this.createdAt;
    const remaining = Math.max(0, this.expiryMs - elapsed);
    let status = '';
    if (this.isClientConnected) {
      status = 'client connected';
    } else if (this.awaitingRejoin) {
      status = 'awaiting rejoin';
    } else {
      status = `waiting for client (expires in ${formatDuration(remaining)})`;
    }
    if (this.readOnly) status += '  (readonly)';
    return status;
  }
}

// ─── Session Manager ─────────────────────────────────────────────────────────

class SessionManager {
  constructor(shell, expiryMs, readOnly, startPath) {
    this.shell = shell;
    this.expiryMs = expiryMs;
    this.readOnly = readOnly;
    this.startPath = startPath;
    this.sessions = new Map(); // code → Session
  }

  async createSession() {
    const session = new Session(this.shell, this.expiryMs, this.readOnly, this.startPath, (code) => {
      this.sessions.delete(code);
    });

    try {
      const code = await session.start();
      this.sessions.set(code, session);
      return code;
    } catch (err) {
      logger.error(`Failed to create session: ${err.message}`, err);
      return null;
    }
  }

  listSessions() {
    if (this.sessions.size === 0) {
      logger.info('No active sessions.');
      return;
    }
    console.log('');
    console.log('  Active sessions:');
    for (const [code, session] of this.sessions) {
      console.log(`    ${code} — ${session.getStatus()}`);
    }
    console.log('');
  }

  killSession(code) {
    const session = this.sessions.get(code);
    if (!session) {
      logger.warn(`Session ${code} not found.`);
      return;
    }
    session.destroy();
    logger.info(`Session ${code} killed.`);
  }

  killAll() {
    for (const [, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const shell = detectShell();
  const expiryMs = getExpiry();
  const readOnly = argv.readonly;
  const startPath = resolveStartPath(argv.path);

  // Print startup banner
  printBanner();
  logger.info(`Shell: ${shell}`);
  logger.info(`Relay: ${RELAY_URL}`);
  logger.info(`Path:  ${startPath}`);
  if (readOnly) logger.info('Mode:  READ-ONLY');
  if (argv.verbose) logger.info('Verbose logging enabled');
  console.log('');

  const manager = new SessionManager(shell, expiryMs, readOnly, startPath);

  // Create first session automatically
  const firstCode = await manager.createSession();
  if (!firstCode) {
    logger.error('Failed to start. Is the relay server running?');
    process.exit(1);
  }

  // ─── Interactive CLI menu ──────────────────────────────────────────
  console.log('  ─────────────────────────────────────────');
  console.log('  Commands:');
  console.log('    [n] New session');
  console.log('    [l] List sessions');
  console.log('    [k <code>] Kill session');
  console.log('    [q] Quit all');
  console.log('  ─────────────────────────────────────────');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  > ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (input === 'n') {
      logger.info('Creating new session...');
      await manager.createSession();
    } else if (input === 'l') {
      manager.listSessions();
    } else if (input.startsWith('k ')) {
      const code = input.slice(2).trim();
      manager.killSession(code);
    } else if (input === 'q') {
      logger.info('Shutting down all sessions...');
      manager.killAll();
      rl.close();
      process.exit(0);
    } else if (input) {
      console.log('  Unknown command. Use n, l, k <code>, or q.');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    manager.killAll();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('');
    logger.info('Shutting down...');
    manager.killAll();
    rl.close();
    process.exit(0);
  });
}

// ─── Global Error Handling ───────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled rejection: ${err.message}`, err);
  process.exit(1);
});

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`, err);
  process.exit(1);
});

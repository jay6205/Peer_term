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
 *   --rejoin <value>   Reconnection window (e.g. 5m, 1h, 6h). Default: 2m
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
import crypto from 'crypto';
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
  fingerprintPublicKeys,
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

// Load package.json for version information
let version = 'unknown';
try {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch {}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  boolean: ['readonly', 'verbose', 'help', 'version', 'secure'],
  string: ['expiry', 'rejoin', 'relay', 'path'],
  alias: { h: 'help', v: 'version', V: 'verbose' },
});

// Detect if --expiry or --rejoin were explicitly passed on the command line
const expiryFlagPassed = process.argv.some(a => a === '--expiry' || a.startsWith('--expiry='));
const rejoinFlagPassed = process.argv.some(a => a === '--rejoin' || a.startsWith('--rejoin='));

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
const DEFAULT_RELAYS = [
  'wss://peer-term-relay.onrender.com',
  'wss://peer-term-relay-production-9b7a.up.railway.app'
];
const RELAY_URLS = argv.relay 
  ? argv.relay.split(',').map(s => s.trim()) 
  : (process.env.RELAY_URL ? process.env.RELAY_URL.split(',').map(s => s.trim()) : DEFAULT_RELAYS);
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

// ─── Interactive Prompts ─────────────────────────────────────────────────────

/**
 * Prompt the user for a duration value in the terminal.
 * Re-prompts on invalid input until a valid value is entered or Enter is pressed for default.
 *
 * @param {Object} opts
 * @param {string} opts.label       - Main prompt question
 * @param {string} opts.description - Additional context shown below the question
 * @param {number} opts.defaultMs   - Default value in milliseconds
 * @param {string} opts.defaultLabel - Human-readable default (e.g. "5 minutes")
 * @param {number} opts.minMs       - Minimum allowed value in milliseconds
 * @param {number} opts.maxMs       - Maximum allowed value in milliseconds
 * @param {string} opts.minLabel    - Human-readable minimum (e.g. "2m")
 * @param {string} opts.maxLabel    - Human-readable maximum (e.g. "24h")
 * @returns {Promise<number>} Resolved duration in milliseconds
 */
function promptDuration({ label, description, defaultMs, defaultLabel, minMs, maxMs, minLabel, maxLabel }) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      console.log('');
      console.log(`  ${label}`);
      if (description) console.log(`  ${description}`);
      console.log(`  Enter a value between ${minLabel} and ${maxLabel} (e.g. ${minLabel}, 30m, 2h)`);
      console.log(`  Default is ${defaultLabel}. Press Enter to use default.`);
      rl.question('  > ', (answer) => {
        const input = answer.trim();

        // Empty input — use default
        if (!input) {
          rl.close();
          resolve(defaultMs);
          return;
        }

        const parsed = parseDuration(input);
        if (!parsed || parsed < minMs || parsed > maxMs) {
          console.log(`  Invalid value. Please enter a time between ${minLabel} and ${maxLabel} (e.g. 5m, 1h).`);
          ask();
          return;
        }

        rl.close();
        resolve(parsed);
      });
    };

    ask();
  });
}

/**
 * Get the session code expiry — from flag, interactive prompt, or silent default.
 */
async function getExpiryInteractive() {
  const DEFAULT_EXPIRY = 5 * 60 * 1000;       // 5 minutes
  const MIN_EXPIRY     = 2 * 60 * 1000;       // 2 minutes
  const MAX_EXPIRY     = 24 * 60 * 60 * 1000; // 24 hours

  // If --expiry flag was explicitly passed, use it (validate and exit on error)
  if (expiryFlagPassed) {
    const parsed = parseDuration(argv.expiry);
    if (!parsed || parsed < MIN_EXPIRY || parsed > MAX_EXPIRY) {
      logger.error(`Invalid expiry: "${argv.expiry}". Must be between 2m and 24h.`);
      process.exit(1);
    }
    return parsed;
  }

  // Non-interactive — use default silently
  if (!process.stdin.isTTY) return DEFAULT_EXPIRY;

  // Interactive prompt
  return promptDuration({
    label: 'How long should the session code be valid?',
    description: null,
    defaultMs: DEFAULT_EXPIRY,
    defaultLabel: '5 minutes',
    minMs: MIN_EXPIRY,
    maxMs: MAX_EXPIRY,
    minLabel: '2m',
    maxLabel: '24h',
  });
}

/**
 * Get the reconnection window — from flag, interactive prompt, or silent default.
 */
async function getRejoinInteractive() {
  const DEFAULT_REJOIN = 5 * 60 * 1000;       // 5 minutes
  const MIN_REJOIN     = 5 * 60 * 1000;       // 5 minutes
  const MAX_REJOIN     = 6 * 60 * 60 * 1000;  // 6 hours

  // If --rejoin flag was explicitly passed, use it
  if (rejoinFlagPassed) {
    const parsed = parseDuration(argv.rejoin);
    if (!parsed || parsed < MIN_REJOIN || parsed > MAX_REJOIN) {
      logger.error(`Invalid rejoin window: "${argv.rejoin}". Must be between 5m and 6h.`);
      process.exit(1);
    }
    return parsed;
  }

  // Non-interactive — use default silently
  if (!process.stdin.isTTY) return DEFAULT_REJOIN;

  // Interactive prompt
  return promptDuration({
    label: 'How long should the reconnection window be?',
    description: 'This is how long a disconnected client or host has to rejoin before the session ends.',
    defaultMs: DEFAULT_REJOIN,
    defaultLabel: '2 minutes',
    minMs: MIN_REJOIN,
    maxMs: MAX_REJOIN,
    minLabel: '5m',
    maxLabel: '6h',
  });
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
  constructor(shell, expiryMs, rejoinMs, readOnly, startPath, onDestroy) {
    this.shell = shell;
    this.expiryMs = expiryMs;
    this.rejoinMs = rejoinMs;
    this.readOnly = readOnly;
    this.startPath = startPath;
    this.onDestroy = onDestroy;
    this.secureMode = argv.secure || false;

    this.ws = null;
    this.code = null;
    this.hostToken = null;
    this.keyPair = null;
    this.hostPublicKeyBase64 = null;
    this.clientPublicKeyBase64 = null;
    this.sharedKey = null;
    this.securityFingerprint = null;
    this.fingerprintAuthorized = false;
    this.ptyProcess = null;
    this.heartbeatInterval = null;
    this.missedPings = 0;
    this.isClientConnected = false;
    this.awaitingRejoin = false;
    this.destroyed = false;
    this.intentionalClose = false;
    this.ptyOutputQueue = Promise.resolve();
    this.reconnectTimer = null;
    this.createdAt = Date.now();
    this.relayUrl = null;  // Track which relay URL we connected to

    // Phase 4: WebRTC state
    this.webrtc = null;
    this.useDataChannel = false;

    // Local TCP viewer (new terminal window)
    this.viewerServer = null;
    this.viewerSocket = null;
    this.viewerToken = null;   // Random nonce for viewer auth
  }

  log(msg) {
    const prefix = this.code ? `[${this.code}]` : '[???]';
    logger.info(`${prefix} ${msg}`);
  }

  logDebug(msg) {
    const prefix = this.code ? `[${this.code}]` : '[???]';
    logger.debug(`${prefix} ${msg}`);
  }

  async _beginKeyExchange() {
    this.keyPair = await generateKeyPair();
    this.hostPublicKeyBase64 = await exportPublicKey(this.keyPair.publicKey);
    this.clientPublicKeyBase64 = null;
    this.sharedKey = null;
    this.securityFingerprint = null;
    this.fingerprintAuthorized = false;
    this.stopHeartbeat();
    this._cleanupWebRTC();
    this.ws.send(JSON.stringify({ 
      type: 'key-exchange', 
      publicKey: this.hostPublicKeyBase64,
      secureMode: this.secureMode 
    }));
  }

  async _completeKeyExchange(clientPublicKeyBase64) {
    if (!this.keyPair || !this.hostPublicKeyBase64) return;
    if (typeof clientPublicKeyBase64 !== 'string' || clientPublicKeyBase64.length === 0) {
      this._rejectProtocolMessage('Invalid key-exchange public key');
      return;
    }

    try {
      this.logDebug('Deriving shared secret...');
      this.clientPublicKeyBase64 = clientPublicKeyBase64;

      const peerPublicKey = await importPublicKey(clientPublicKeyBase64);
      this.sharedKey = await deriveSharedKey(this.keyPair.privateKey, peerPublicKey);

      if (this.secureMode) {
        this.securityFingerprint = await fingerprintPublicKeys(
          this.code,
          this.hostPublicKeyBase64,
          this.clientPublicKeyBase64
        );
        this.fingerprintAuthorized = false;
        this._printFingerprintAuthorization();
      } else {
        this.fingerprintAuthorized = true;
        await this._activateSecureSession();
      }
    } catch (err) {
      this._rejectProtocolMessage(`Invalid key exchange: ${err.message}`);
    }
  }

  _rejectProtocolMessage(reason) {
    this.log(`Protocol error: ${reason}`);
    this.isClientConnected = false;
    this.awaitingRejoin = false;
    this.sharedKey = null;
    this.keyPair = null;
    this.hostPublicKeyBase64 = null;
    this.clientPublicKeyBase64 = null;
    this.securityFingerprint = null;
    this.fingerprintAuthorized = false;
    this.stopHeartbeat();
    this._cleanupWebRTC();
    this.destroy();
  }

  _handleMessageError(err) {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`Protocol handler error: ${message}`);
    this.destroy();
  }

  _printFingerprintAuthorization() {
    console.log('');
    this.log('Encrypted candidate established. Verify before terminal access.');
    console.log(`  Fingerprint: ${this.securityFingerprint}`);
    console.log('  Ask the viewer to compare this exact fingerprint.');
    console.log(`  Type "a ${this.code}" after it matches, or "k ${this.code}" to kill the session.`);
    console.log('');
  }

  async authorizeFingerprint() {
    if (!this.sharedKey || !this.securityFingerprint) {
      logger.warn(`Session ${this.code} has no fingerprint awaiting authorization.`);
      return false;
    }
    if (this.fingerprintAuthorized) {
      logger.info(`Session ${this.code} is already authorized.`);
      return true;
    }

    this.fingerprintAuthorized = true;
    await this._activateSecureSession();
    return true;
  }

  async _activateSecureSession() {
    if (!this.sharedKey || !this.fingerprintAuthorized) return;

    this.log(`Fingerprint authorized: ${this.securityFingerprint}`);
    this.log('Encrypted tunnel active');
    await this._sendSessionConfig();

    this.startHeartbeat();

    if (!this.ptyProcess) {
      this.spawnTerminal();
    }

    this._initiateWebRTC();
  }

  async _sendSessionConfig() {
    if (!this.sharedKey || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const config = JSON.stringify({
      type: 'session-config',
      readonly: this.readOnly,
      version: version,
      shell: this.shell,
      startPath: this.startPath,
    });
    try {
      const payload = await encrypt(this.sharedKey, config);
      this.ws.send(JSON.stringify({ type: 'data', payload }));
    } catch (err) {
      this.log(`Failed to send session config: ${err.message}`);
    }
  }

  // ─── Start the session ──────────────────────────────────────────────
  async start() {
    for (let i = 0; i < RELAY_URLS.length; i++) {
      const url = RELAY_URLS[i];
      try {
        const code = await this._tryConnect(url);
        return code;
      } catch (err) {
        if (i === RELAY_URLS.length - 1) {
          throw new Error(`All relay servers failed. Last error: ${err.message}`);
        }
        logger.warn(`Failed to connect to ${url}: ${err.message}. Trying next relay...`);
      }
    }
  }

  async _tryConnect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.relayUrl = url;
      
      let isConnected = false;

      this.ws.on('open', () => {
        isConnected = true;
        this.ws.send(JSON.stringify({
          type: 'host-register',
          expiry: this.expiryMs,
          rejoinWindow: this.rejoinMs,
          readonly: this.readOnly,
        }));
      });

      this.ws.on('message', async (raw) => {
        try {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.log('Invalid message from relay');
          return;
        }
        if (!msg || typeof msg.type !== 'string') {
          this._rejectProtocolMessage('Malformed relay message');
          return;
        }

        switch (msg.type) {
          case 'code': {
            this.code = msg.code;
            this.hostToken = msg.hostToken || null;
            printSessionBox({
              code: this.code,
              expiry: formatDuration(this.expiryMs),
              rejoinWindow: formatDuration(this.rejoinMs),
              mode: (this.readOnly ? 'Read-Only' : 'Read-Write') + (this.secureMode ? ' (Secure)' : ''),
              shell: this.shell,
              startPath: this.startPath,
              shareUrl: url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
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

            if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
              this.startHeartbeat();
              break;
            }

            await this._beginKeyExchange();
            break;
          }

          case 'key-exchange': {
            await this._completeKeyExchange(msg.publicKey);
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
            if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
              this.log('Client relay connection lost; direct DataChannel still active.');
              this.missedPings = 0;
              this.startHeartbeat();
              break;
            }

            this.log(`Client disconnected. Rejoin window: ${formatDuration(this.rejoinMs)}.`);
            this.isClientConnected = false;
            this.awaitingRejoin = true;
            this.sharedKey = null;
            this.keyPair = null;
            this.hostPublicKeyBase64 = null;
            this.clientPublicKeyBase64 = null;
            this.securityFingerprint = null;
            this.fingerprintAuthorized = false;
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

          case 'rejoined': {
            this.log(`\u2705 Reconnected. Session restored. (code: ${msg.code})`);
            await this._restartPeerSessionAfterHostRejoin();
            break;
          }

          case 'error': {
            this.log(`Error: ${msg.msg}`);
            break;
          }
        }
        } catch (err) {
          this._handleMessageError(err);
        }
      });

      this.ws.on('close', () => {
        if (!isConnected) {
          reject(new Error('WebSocket closed before connection was established'));
        } else if (this.destroyed) {
          // Already destroyed, nothing to do
        } else if (this.intentionalClose) {
          this.log('Connection to relay closed (intentional).');
          this.destroy();
        } else {
          // Unexpected disconnect — start reconnect loop
          this.log('Connection to relay lost. Starting reconnect...');
          this.stopHeartbeat();
          this._startReconnecting();
        }
      });

      this.ws.on('error', (err) => {
        if (!isConnected) {
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
      this._sendEncryptedToClient(payload, {
        directPayload: JSON.stringify({ _meta: 'resize', payload }),
        meta: 'resize',
      });
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

      if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
        this.missedPings = 0;
        return;
      }

      this.missedPings++;
      if (this.missedPings >= MAX_MISSED_PINGS + 1) {
        this.log('Client heartbeat lost. Waiting for reconnect...');
        this.isClientConnected = false;
        this.awaitingRejoin = true;
        this.sharedKey = null;
        this.keyPair = null;
        this.hostPublicKeyBase64 = null;
        this.clientPublicKeyBase64 = null;
        this.securityFingerprint = null;
        this.fingerprintAuthorized = false;
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

    this.ptyProcess.onData((data) => {
      // Mirror PTY output to local viewer terminal
      if (this.viewerSocket) {
        try { this.viewerSocket.write(data); } catch {}
      }

      if (!this.sharedKey) return;
      this._queuePtyOutput(data, this.sharedKey);
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
  _queuePtyOutput(data, sharedKey) {
    this.ptyOutputQueue = this.ptyOutputQueue
      .then(() => this._sendPtyOutput(data, sharedKey))
      .catch((err) => {
        this.logDebug(`Failed to send PTY output: ${err.message}`);
      });
  }

  async _sendPtyOutput(data, sharedKey) {
    if (this.destroyed || !sharedKey || sharedKey !== this.sharedKey) return;

    const payload = await encrypt(sharedKey, data);
    if (this.destroyed || sharedKey !== this.sharedKey) return;

    this._sendEncryptedToClient(payload, { enforceBackpressure: true });
  }

  _sendEncryptedToClient(payload, options = {}) {
    const directPayload = options.directPayload || payload;

    if (this.useDataChannel) {
      if (this.webrtc && this.webrtc.isActive()) {
        let sentDirect = false;
        try {
          sentDirect = this.webrtc.send(directPayload);
        } catch {}

        if (sentDirect) return true;
      }

      this.useDataChannel = false;
      this.log('DataChannel send failed — falling back to relay');
    }

    return this._sendViaRelay(payload, options);
  }

  _sendViaRelay(payload, { meta, enforceBackpressure = false } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (enforceBackpressure && this.ws.bufferedAmount >= 1.25 * 1024 * 1024) return false;

    const msg = { type: 'data', payload };
    if (meta) msg.meta = meta;

    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  _startViewerServer() {
    // Generate a random nonce for viewer authentication
    this.viewerToken = crypto.randomBytes(16).toString('hex');

    this.viewerServer = net.createServer((socket) => {
      // Close any existing viewer connection before accepting a new one
      if (this.viewerSocket) {
        this.logDebug('Replacing existing viewer connection.');
        this.viewerSocket.removeAllListeners();
        try { this.viewerSocket.destroy(); } catch {}
      }

      // ── Token authentication gate ──────────────────────────────────
      // The first data packet must be the viewer token followed by a newline.
      // Reject the connection if no valid token arrives within 2 seconds.
      let authenticated = false;
      let authBuf = '';

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          this.logDebug('Viewer auth timeout — closing connection.');
          try { socket.destroy(); } catch {}
        }
      }, 2000);

      const onAuthData = (data) => {
        authBuf += data.toString();
        const newlineIdx = authBuf.indexOf('\n');
        if (newlineIdx === -1) {
          // Accumulated too much data without a newline — reject
          if (authBuf.length > 256) {
            clearTimeout(authTimeout);
            this.logDebug('Viewer auth buffer overflow — closing connection.');
            try { socket.destroy(); } catch {}
          }
          return;
        }

        const token = authBuf.slice(0, newlineIdx).trim();
        const remaining = authBuf.slice(newlineIdx + 1);
        clearTimeout(authTimeout);
        socket.removeListener('data', onAuthData);

        if (token !== this.viewerToken) {
          this.logDebug('Viewer auth failed — wrong token.');
          try { socket.destroy(); } catch {}
          return;
        }

        // Authenticated — promote to active viewer
        authenticated = true;
        this.viewerSocket = socket;
        this.log('Host viewer connected (authenticated).');

        // Install the real data handler
        let recvBuf = '';

        // Process any leftover data that arrived after the token line
        if (remaining.length > 0) {
          handleViewerData(remaining);
        }

        socket.on('data', (chunk) => handleViewerData(chunk.toString()));

        const handleViewerData = (chunk) => {
          // Control messages start with \x00{
          if (recvBuf.length > 0 || chunk.startsWith('\x00{')) {
            recvBuf += chunk;
            let nlIdx;
            while ((nlIdx = recvBuf.indexOf('\n')) !== -1) {
              const line = recvBuf.slice(0, nlIdx).trim();
              recvBuf = recvBuf.slice(nlIdx + 1);

              if (line.startsWith('\x00')) {
                try {
                  const msg = JSON.parse(line.slice(1));
                  if (msg.type === 'resize' &&
                      Number.isInteger(msg.cols) && msg.cols > 0 &&
                      Number.isInteger(msg.rows) && msg.rows > 0 &&
                      this.ptyProcess) {
                    this.ptyProcess.resize(msg.cols, msg.rows);
                    this._sendResize(msg.cols, msg.rows);
                    this.logDebug(`Viewer resized to ${msg.cols}x${msg.rows}`);
                  }
                } catch {}
              } else if (this.ptyProcess) {
                 this.ptyProcess.write(line + '\n');
              }
            }
            // Flush any non-control data left in the buffer
            if (recvBuf.length > 0 && !recvBuf.startsWith('\x00')) {
               if (this.ptyProcess) this.ptyProcess.write(recvBuf);
               recvBuf = '';
            }
            return;
          }

          // Host keystrokes → PTY (host always has access)
          if (this.ptyProcess) {
            this.ptyProcess.write(chunk);
          }
        };

        socket.on('close', () => {
          this.viewerSocket = null;
          this.logDebug('Host viewer disconnected.');
        });

        socket.on('error', () => {
          this.viewerSocket = null;
        });
      };

      socket.on('data', onAuthData);

      socket.on('error', () => {
        clearTimeout(authTimeout);
      });
    });

    this.viewerServer.listen(0, '127.0.0.1', () => {
      const port = this.viewerServer.address().port;
      this.logDebug(`Viewer server on port ${port}`);
      this._openViewerTerminal(port, this.viewerToken);
    });

    this.viewerServer.on('error', (err) => {
      this.log(`Viewer server error: ${err.message}`);
      this.viewerServer = null;
    });
  }

  _openViewerTerminal(port, token) {
    if (!/^[A-Za-z0-9_-]+$/.test(this.code)) {
      this.log('Invalid session code format. Aborting viewer terminal.');
      return;
    }

    const viewerScript = path.join(__dirname, 'session-viewer.js');
    const platform = os.platform();

    if (platform === 'win32') {
      cpExec(`start "PeerTerm - ${this.code}" cmd /c node "${viewerScript}" ${port} ${this.code} ${token}`);
    } else if (platform === 'darwin') {
      cpExec(`osascript -e 'tell app "Terminal" to do script "node \"${viewerScript}\" ${port} ${this.code} ${token}"'`);
    } else {
      // Linux: try common terminal emulators
      cpExec(`x-terminal-emulator -e "node '${viewerScript}' ${port} ${this.code} ${token}" 2>/dev/null || gnome-terminal -- node "${viewerScript}" ${port} ${this.code} ${token} 2>/dev/null || xterm -e "node '${viewerScript}' ${port} ${this.code} ${token}"`);
    }
    this.log('Opening terminal viewer...');
  }

  // ─── Host Reconnect Logic ───────────────────────────────────────────
  _startReconnecting() {
    if (this.destroyed || this.intentionalClose) return;

    let attempts = 0;
    const maxAttempts = 24; // 24 × 5s = 2 minutes

    this.reconnectTimer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        this.log('Could not reconnect. Session expired.');
        this._stopReconnecting();
        this.destroy();
        return;
      }

      this.log(`Reconnect attempt ${attempts}/${maxAttempts}...`);

      // Close any in-flight reconnect socket from the previous tick
      if (this._pendingReconnectWs) {
        try { this._pendingReconnectWs.removeAllListeners(); this._pendingReconnectWs.close(); } catch {}
        this._pendingReconnectWs = null;
      }

      try {
        const newWs = new WebSocket(this.relayUrl);
        this._pendingReconnectWs = newWs;

        newWs.on('open', () => {
          newWs.send(JSON.stringify({ type: 'host-rejoin', code: this.code, hostToken: this.hostToken }));
        });

        newWs.on('message', async (raw) => {
          try {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (!msg || typeof msg.type !== 'string') {
            this._rejectProtocolMessage('Malformed relay message');
            return;
          }

          if (msg.type === 'rejoined') {
            // Success — replace the old ws with this new one
            this._pendingReconnectWs = null;
            this.ws = newWs;
            this._stopReconnecting();
            this.log(`Reconnected. Session restored.`);

            // Re-attach the full message handler by wiring up events
            this._attachWsHandlers(newWs);

            await this._restartPeerSessionAfterHostRejoin();
          } else if (msg.type === 'error') {
            this.log(`Rejoin failed: ${msg.msg}`);
            this._pendingReconnectWs = null;
            this._stopReconnecting();
            this.destroy();
            try { newWs.close(); } catch {}
          }
          } catch (err) {
            this._handleMessageError(err);
          }
        });

        newWs.on('error', () => {
          // Connection failed, next retry in 5s
          if (this._pendingReconnectWs === newWs) this._pendingReconnectWs = null;
          try { newWs.close(); } catch {}
        });

        newWs.on('close', () => {
          // Clean up reference if this was the pending socket
          if (this._pendingReconnectWs === newWs) this._pendingReconnectWs = null;
        });
      } catch (e) {
        // Connection failed, next retry in 5s
      }
    }, 5000);
  }

  _stopReconnecting() {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._pendingReconnectWs) {
      try { this._pendingReconnectWs.removeAllListeners(); this._pendingReconnectWs.close(); } catch {}
      this._pendingReconnectWs = null;
    }
  }

  /**
   * Re-attach message/close/error handlers to a new WebSocket after rejoin.
   * This mirrors the handlers set in _tryConnect but skips the initial registration flow.
   */
  _attachWsHandlers(newWs) {
    newWs.on('message', async (raw) => {
      try {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.log('Invalid message from relay');
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        this._rejectProtocolMessage('Malformed relay message');
        return;
      }

      switch (msg.type) {
        case 'client-connected': {
          if (this.awaitingRejoin) {
            this.log('Client reconnected.');
            this.awaitingRejoin = false;
          } else {
            this.log('Client connected! Starting key exchange...');
          }
          this.isClientConnected = true;
          this.missedPings = 0;

          if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
            // Keep existing keys if direct session is healthy
            this.startHeartbeat();
            break;
          }

          await this._beginKeyExchange();
          break;
        }

        case 'key-exchange': {
          await this._completeKeyExchange(msg.publicKey);
          break;
        }

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

            if (this.readOnly) return;
            this.ptyProcess.write(plaintext);
          } catch (err) {
            this.log(`Decryption failed: ${err.message}`);
          }
          break;
        }

        case 'peer-disconnected': {
          if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
            this.log('Client relay connection lost; direct DataChannel still active.');
            this.missedPings = 0;
            this.startHeartbeat();
            break;
          }

          this.log(`Client disconnected. Rejoin window: ${formatDuration(this.rejoinMs)}.`);
          this.isClientConnected = false;
          this.awaitingRejoin = true;
          this.sharedKey = null;
          this.keyPair = null;
          this.hostPublicKeyBase64 = null;
          this.clientPublicKeyBase64 = null;
          this.securityFingerprint = null;
          this.fingerprintAuthorized = false;
          this.stopHeartbeat();
          this._cleanupWebRTC();
          break;
        }

        case 'session-expired': {
          this.log('Rejoin window expired. Session ended.');
          this.destroy();
          break;
        }

        case 'rejoined': {
          this.log(`Reconnected. Session restored. (code: ${msg.code})`);
          await this._restartPeerSessionAfterHostRejoin();
          break;
        }

        case 'error': {
          this.log(`Error: ${msg.msg}`);
          break;
        }
      }
      } catch (err) {
        this._handleMessageError(err);
      }
    });

    newWs.on('close', () => {
      if (this.destroyed) return;
      if (this.intentionalClose) {
        this.log('Connection to relay closed (intentional).');
        this.destroy();
      } else {
        this.log('Connection to relay lost. Starting reconnect...');
        this.stopHeartbeat();
        this._startReconnecting();
      }
    });

    newWs.on('error', (err) => {
      this.log(`WS error: ${err.message}`);
    });
  }

  // ─── Destroy ────────────────────────────────────────────────────────
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.intentionalClose = true;
    this.stopHeartbeat();
    this._stopReconnecting();
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
      // Send session-ended so relay knows this is intentional and destroys session immediately
      try { this.ws.send(JSON.stringify({ type: 'session-ended' })); } catch {}
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

  async _restartPeerSessionAfterHostRejoin() {
    this.missedPings = 0;

    if (this.useDataChannel && this.webrtc && this.webrtc.isActive()) {
      this.startHeartbeat();
      return;
    }

    this.sharedKey = null;
    this.hostPublicKeyBase64 = null;
    this.clientPublicKeyBase64 = null;
    this.securityFingerprint = null;
    this.fingerprintAuthorized = false;
    this._cleanupWebRTC();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this._beginKeyExchange();
    }
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
    if (this.securityFingerprint && !this.fingerprintAuthorized) {
      status = `verify fingerprint ${this.securityFingerprint}`;
    } else if (this.isClientConnected) {
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
  constructor(shell, expiryMs, rejoinMs, readOnly, startPath) {
    this.shell = shell;
    this.expiryMs = expiryMs;
    this.rejoinMs = rejoinMs;
    this.readOnly = readOnly;
    this.startPath = startPath;
    this.sessions = new Map(); // code → Session
  }

  async createSession() {
    const session = new Session(this.shell, this.expiryMs, this.rejoinMs, this.readOnly, this.startPath, (code) => {
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

  async authorizeSession(code) {
    const session = this.sessions.get(code);
    if (!session) {
      logger.warn(`Session ${code} not found.`);
      return;
    }
    await session.authorizeFingerprint();
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
  const readOnly = argv.readonly;
  const startPath = resolveStartPath(argv.path);

  // Print startup banner
  printBanner();

  // Interactive prompts — always ask unless flags are passed or non-interactive
  const expiryMs = await getExpiryInteractive();
  const rejoinMs = await getRejoinInteractive();
  console.log('');

  logger.info(`Shell:          ${shell}`);
  logger.info(`Relays:         ${RELAY_URLS.join(', ')}`);
  logger.info(`Path:           ${startPath}`);
  logger.info(`Expiry:         ${formatDuration(expiryMs)}`);
  logger.info(`Rejoin Window:  ${formatDuration(rejoinMs)}`);
  if (readOnly) logger.info('Mode:           READ-ONLY');
  if (argv.verbose) logger.info('Verbose logging enabled');
  console.log('');

  const manager = new SessionManager(shell, expiryMs, rejoinMs, readOnly, startPath);

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
  console.log('    [a <code>] Authorize verified fingerprint');
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
    } else if (input.startsWith('a ')) {
      const code = input.slice(2).trim();
      await manager.authorizeSession(code);
    } else if (input.startsWith('k ')) {
      const code = input.slice(2).trim();
      manager.killSession(code);
    } else if (input === 'q') {
      logger.info('Shutting down all sessions...');
      manager.killAll();
      rl.close();
      process.exit(0);
    } else if (input) {
      console.log('  Unknown command. Use n, l, a <code>, k <code>, or q.');
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
});

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`, err);
  process.exit(1);
});

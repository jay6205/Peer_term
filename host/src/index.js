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

import WebSocket from 'ws';
import pty from 'node-pty';
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
import logger from './logger.js';
import { printSessionBox } from './ui.js';
import {
  argv,
  version,
  RELAY_URLS,
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_PINGS,
} from './config.js';
import { formatDuration } from './utils.js';
import { FileTransferHandler } from './file-transfer.js';
import { ViewerServer } from './viewer.js';

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

    // File upload handler
    this._fileTransfer = new FileTransferHandler(this._buildFileTransferContext());

    // Local TCP viewer
    this._viewer = null;

    // Session duration tracking
    this.sessionStartedAt = null;        // Timestamp: when the terminal session became active
    this.sessionDurationInterval = null; // Interval: periodic CLI status log
  }

  /**
   * Build the context object for FileTransferHandler.
   * Called on construction and whenever shared key changes.
   */
  _buildFileTransferContext() {
    return {
      get sharedKey() { return this.session.sharedKey; },
      get readOnly() { return this.session.readOnly; },
      get ptyProcess() { return this.session.ptyProcess; },
      log: (msg) => this.log(msg),
      logDebug: (msg) => this.logDebug(msg),
      sendEncrypted: (payload) => this._sendEncryptedToClient(payload),
      session: this,
    };
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

    // Mark session start time for duration tracking
    if (!this.sessionStartedAt) {
      this.sessionStartedAt = Date.now();
      this._startDurationLogging();
    }

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

        await this._handleRelayMessage(msg, url, resolve);
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

  /**
   * Central relay message handler — shared by _tryConnect and _attachWsHandlers.
   * The optional `resolve` parameter is only provided during initial registration.
   */
  async _handleRelayMessage(msg, url, resolve) {
    switch (msg.type) {
      case 'code': {
        this.code = msg.code;
        this.hostToken = msg.hostToken || null;
        await printSessionBox({
          code: this.code,
          expiry: formatDuration(this.expiryMs),
          rejoinWindow: formatDuration(this.rejoinMs),
          mode: (this.readOnly ? 'Read-Only' : 'Read-Write') + (this.secureMode ? ' (Secure)' : ''),
          shell: this.shell,
          startPath: this.startPath,
          shareUrl: url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')
        });
        if (resolve) resolve(this.code);
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

          // Check if decrypted message is a file transfer message (file-start, file-chunk, file-end)
          try {
            const parsedMsg = JSON.parse(plaintext);
            if (parsedMsg && typeof parsedMsg.type === 'string' && parsedMsg.type.startsWith('file-')) {
              if (this.readOnly) {
                this._fileTransfer._sendError(parsedMsg.id, 'File uploads are disabled in read-only mode');
                return;
              }
              this._fileTransfer.handleMessage(parsedMsg);
              return;
            }
          } catch {
            // Not JSON — normal keystroke data, fall through
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
        this._resetCryptoState();
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
  }

  /**
   * Reset all crypto state (shared key, key pair, fingerprint).
   * Used on peer disconnect and heartbeat loss.
   */
  _resetCryptoState() {
    this.sharedKey = null;
    this.keyPair = null;
    this.hostPublicKeyBase64 = null;
    this.clientPublicKeyBase64 = null;
    this.securityFingerprint = null;
    this.fingerprintAuthorized = false;
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
        this._resetCryptoState();
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
      if (this._viewer) {
        this._viewer.write(data);
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
    this._startViewer();
  }

  // ─── PTY Output Queue ──────────────────────────────────────────────
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

  // ─── Viewer ─────────────────────────────────────────────────────────
  _startViewer() {
    this._viewer = new ViewerServer({
      code: this.code,
      log: (msg) => this.log(msg),
      logDebug: (msg) => this.logDebug(msg),
      onResize: (cols, rows) => {
        if (this.ptyProcess) {
          this.ptyProcess.resize(cols, rows);
          this._sendResize(cols, rows);
        }
      },
      onKeystroke: (data) => {
        if (this.ptyProcess) {
          this.ptyProcess.write(data);
        }
      },
    });
    this._viewer.start();
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
   * Uses the shared _handleRelayMessage method to avoid duplicating the switch block.
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

      await this._handleRelayMessage(msg, this.relayUrl, null);
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
    this._stopDurationLogging();
    // Clean up in-progress file uploads
    this._fileTransfer.cleanup();
    // Clean up viewer
    if (this._viewer) {
      this._viewer.destroy();
      this._viewer = null;
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
    // Log session duration on end
    if (this.sessionStartedAt) {
      const duration = formatDuration(Date.now() - this.sessionStartedAt);
      this.log(`Session ended. Duration: ${duration}`);
    } else {
      this.log('Session ended.');
    }
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
      if (!this.sharedKey) return;
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

        // Normal encrypted data — decrypt first
        const plaintext = await decrypt(this.sharedKey, data);

        // Check if decrypted message is a file transfer message (file-start, file-chunk, file-end)
        try {
          const msg = JSON.parse(plaintext);
          if (msg && typeof msg.type === 'string' && msg.type.startsWith('file-')) {
            if (this.readOnly) {
              this._fileTransfer._sendError(msg.id, 'File uploads are disabled in read-only mode');
              return;
            }
            this._fileTransfer.handleMessage(msg);
            return;
          }
        } catch {
          // Not JSON — normal keystroke data, fall through
        }

        // Normal keystroke — drop if read-only or no PTY
        if (!this.ptyProcess) return;
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

    this._resetCryptoState();
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
      const duration = this.sessionStartedAt
        ? ` (${formatDuration(Date.now() - this.sessionStartedAt)})`
        : '';
      status = `client connected${duration}`;
    } else if (this.awaitingRejoin) {
      status = 'awaiting rejoin';
    } else {
      status = `waiting for client (expires in ${formatDuration(remaining)})`;
    }
    if (this.readOnly) status += '  (readonly)';
    return status;
  }

  // ─── Session Duration Logging ────────────────────────────────────────

  _formatElapsedCompact(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    return `${pad(minutes)}:${pad(seconds)}`;
  }

  _startDurationLogging() {
    this._stopDurationLogging();
    // Log session duration every 5 minutes
    this.sessionDurationInterval = setInterval(() => {
      if (!this.sessionStartedAt || this.destroyed) return;
      const elapsed = Date.now() - this.sessionStartedAt;
      this.log(`Session active — ${this._formatElapsedCompact(elapsed)}`);
    }, 5 * 60 * 1000);
  }

  _stopDurationLogging() {
    if (this.sessionDurationInterval) {
      clearInterval(this.sessionDurationInterval);
      this.sessionDurationInterval = null;
    }
  }
}

// ─── Session Manager ─────────────────────────────────────────────────────────

export class SessionManager {
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

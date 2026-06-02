    // ─── DOM Elements ──────────────────────────────────────────────────────
    const connectScreen   = document.getElementById('connect-screen');
    const terminalScreen  = document.getElementById('terminal-screen');
    const codeInput       = document.getElementById('code-input');
    const connectBtn      = document.getElementById('connect-btn');
    const errorMsg        = document.getElementById('error-msg');
    const connectingOvl   = document.getElementById('connecting-overlay');
    const statusCode      = document.getElementById('status-code');
    const terminalEl      = document.getElementById('terminal-container');
    const connIndicator   = document.getElementById('connection-indicator');
    const readonlyBadge   = document.getElementById('readonly-badge');
    const pasteBtn        = document.getElementById('paste-btn');
    const copyBtn         = document.getElementById('copy-btn');
    const clipToast       = document.getElementById('clipboard-toast');
    const mobileInput     = document.getElementById('mobile-input');
    const kbdToggleBtn    = document.getElementById('kbd-toggle-btn');
    const fontDownBtn     = document.getElementById('font-down-btn');
    const fontUpBtn       = document.getElementById('font-up-btn');
    const tabBtn          = document.getElementById('tab-btn');
    const toastContainer  = document.getElementById('toast-container');

    // ─── Toast Notification System ────────────────────────────────────────
    const TOAST_MAX = 4;

    function showToast(message, type = 'info', duration = 4000) {
      // Deduplicate: skip if same message is already visible
      const existing = toastContainer.querySelectorAll('.toast:not(.removing)');
      for (const t of existing) {
        if (t.dataset.msg === message) return;
      }

      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.dataset.msg = message;
      el.innerHTML = `<span class="toast-msg">${message}</span>`;

      // Click to dismiss
      el.addEventListener('click', () => removeToast(el));

      toastContainer.appendChild(el);

      // Enforce max visible
      const all = toastContainer.querySelectorAll('.toast:not(.removing)');
      if (all.length > TOAST_MAX) {
        removeToast(all[0]);
      }

      // Auto-remove after duration
      el._timeout = setTimeout(() => removeToast(el), duration);
    }

    function removeToast(el) {
      if (!el || el.classList.contains('removing')) return;
      clearTimeout(el._timeout);
      el.classList.add('removing');
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 260);
    }

    // ─── State ─────────────────────────────────────────────────────────────
    let ws          = null;
    let terminal    = null;
    let fitAddon    = null;
    let keyPair     = null;
    let sharedKey   = null;
    let sessionCode = '';
    let fingerprintPromptEl = null;

    // Phase 2: Heartbeat & Reconnect state
    let heartbeatInterval = null;
    let missedPings = 0;
    let reconnectInterval = null;
    let isReconnecting = false;
    let sessionEnded = false;
    let hostWaitingForReconnect = false;
    let awaitingHostAuthorization = false;
    let previousIndicatorState = 'relay';
    const HEARTBEAT_MS = 5000;
    const MAX_MISSED = 2;
    const RECONNECT_MS = 5000;

    // Phase 3: Feature state
    let isReadOnly = false;
    let readOnlyHint = false;
    let sessionConfigApplied = false;
    let currentFontSize = 14;
    const isMobile = navigator.maxTouchPoints > 0;

    // Phase 4: WebRTC state
    let peerConnection = null;
    let dataChannel = null;
    let useDataChannel = false;
    let sameLAN = false;
    let peerSameLAN = false;
    let iceTimer = null;
    let dcTimer = null;

    // ─── Relay URLs (Fallback list) ──────────────────────────────────────────
    const DEFAULT_RELAYS = [
      'wss://peer-term-relay-production-9b7a.up.railway.app',
      'wss://peer-term-relay.onrender.com'
    ];

    function getRelayUrls() {
      const params = new URLSearchParams(window.location.search);
      const custom = params.get('relay');
      if (custom) return [custom];
      
      // If we are served directly from a relay server (Render/Railway/localhost), use that first!
      if (location.host.includes('railway') || location.host.includes('render') || location.hostname === 'localhost') {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return [`${proto}//${location.host}`];
      }
      
      // Otherwise (e.g. peerterm.dev or static page), try defaults
      return DEFAULT_RELAYS;
    }
    const RELAY_URLS = getRelayUrls();

    // ═════════════════════════════════════════════════════════════════════════
    // ENCRYPTION (ECDH P-256 + AES-256-GCM) — must match host exactly
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Generate an ephemeral ECDH P-256 key pair.
     */
    async function generateKeyPair() {
      return await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveKey']
      );
    }

    /**
     * Export a public key to base64 (raw format).
     */
    async function exportPublicKey(publicKey) {
      const raw = await crypto.subtle.exportKey('raw', publicKey);
      return btoa(String.fromCharCode(...new Uint8Array(raw)));
    }

    /**
     * Import a peer's public key from base64.
     */
    async function importPublicKey(base64) {
      const binary = atob(base64);
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
      return await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
    }

    /**
     * Derive the shared AES-256-GCM key using ECDH.
     * Both sides derive the identical key independently.
     */
    async function deriveSharedKey(privateKey, peerPublicKey) {
      return await crypto.subtle.deriveKey(
        { name: 'ECDH', public: peerPublicKey },
        privateKey,
        { name: 'AES-GCM', length: 256 },
        false,                       // extractable: false
        ['encrypt', 'decrypt']       // usages
      );
    }

    /**
     * Compute the short authentication string displayed by both peers.
     */
    async function fingerprintPublicKeys(code, hostPublicKeyBase64, clientPublicKeyBase64) {
      const transcript = [
        'PeerTerm SAS v1',
        String(code || ''),
        String(hostPublicKeyBase64 || ''),
        String(clientPublicKeyBase64 || ''),
      ].join('\n');

      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(transcript)
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
        .slice(0, 16);
      return hex.match(/.{1,4}/g).join('-');
    }

    /**
     * Encrypt plaintext with AES-256-GCM.
     * Returns base64( random_12_byte_IV + ciphertext ).
     */
    async function encrypt(key, plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plaintext);
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoded
      );
      // Combine IV + ciphertext
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return btoa(String.fromCharCode(...combined));
    }

    /**
     * Decrypt a base64 AES-GCM message.
     * Splits first 12 bytes as IV, rest as ciphertext.
     */
    async function decrypt(key, base64data) {
      const binary = atob(base64data);
      const combined = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);

      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return new TextDecoder().decode(plaintext);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // UI LOGIC
    // ═════════════════════════════════════════════════════════════════════════

    // Only allow digits in the code input
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
      hideError();
    });

    // Connect on Enter key
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectBtn.click();
    });

    // Connect button click
    connectBtn.addEventListener('click', () => {
      const code = codeInput.value.trim();
      if (code.length !== 6) {
        showError('Please enter a 6-digit code');
        return;
      }
      startConnection(code);
    });

    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.classList.add('visible');
    }

    function hideError() {
      errorMsg.classList.remove('visible');
    }

    function setLoading(loading) {
      connectBtn.disabled = loading;
      codeInput.disabled = loading;
      if (loading) {
        connectBtn.classList.add('loading');
      } else {
        connectBtn.classList.remove('loading');
      }
    }

    function closeFingerprintPrompt() {
      if (fingerprintPromptEl && fingerprintPromptEl.parentNode) {
        fingerprintPromptEl.parentNode.removeChild(fingerprintPromptEl);
      }
      fingerprintPromptEl = null;
    }

    function verifyFingerprint(fingerprint) {
      closeFingerprintPrompt();

      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'fingerprint-overlay';
        overlay.innerHTML = `
          <div class="fingerprint-dialog" role="dialog" aria-modal="true" aria-labelledby="fingerprint-title">
            <h2 id="fingerprint-title">Verify host fingerprint</h2>
            <p>Ask the host to read their fingerprint before terminal access starts.</p>
            <div class="fingerprint-code">${fingerprint}</div>
            <div class="fingerprint-actions">
              <button type="button" class="fingerprint-confirm">I verified it matches</button>
              <button type="button" class="fingerprint-cancel">Disconnect</button>
            </div>
          </div>
        `;

        const finish = (verified) => {
          closeFingerprintPrompt();
          resolve(verified);
        };

        overlay.querySelector('.fingerprint-confirm').addEventListener('click', () => finish(true));
        overlay.querySelector('.fingerprint-cancel').addEventListener('click', () => finish(false));

        fingerprintPromptEl = overlay;
        document.body.appendChild(overlay);
        overlay.querySelector('.fingerprint-confirm').focus();
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CONNECTION FLOW
    // ═════════════════════════════════════════════════════════════════════════

    function startConnection(code) {
      sessionCode = code;
      sessionEnded = false;
      hideError();
      setLoading(true);
      updateConnIndicator('connecting');

      connectToRelay(code, 0);
    }

    /**
     * Core WebSocket connection logic. Extracted so reconnect can call it too.
     */
    function connectToRelay(code, urlIndex = 0) {
      if (urlIndex >= RELAY_URLS.length) {
        setLoading(false);
        showError('All relay servers failed to connect');
        return;
      }

      const url = RELAY_URLS[urlIndex];
      ws = new WebSocket(url);
      
      let isConnected = false;

      ws.onopen = () => {
        isConnected = true;
        ws.send(JSON.stringify({ type: 'client-join', code }));
      };

      ws.onmessage = async (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (msg.type) {
          // ─── Error from relay ─────────────────────────────────────────
          case 'error':
            if (isReconnecting) {
              if (msg.msg === 'Session already in use' || msg.msg === 'Host is reconnecting. Try again shortly.') {
                // Transient reconnect state; retry on the next reconnect tick.
                if (ws && ws.readyState === WebSocket.OPEN) ws.close();
                return;
              }
              // During reconnect, errors mean session is gone
              sessionEnded = true;
              stopReconnecting();
              if (terminal) {
                terminal.write('\r\n\x1b[1;31m Session has ended.\x1b[0m\r\n');
                updateStatusDot('red');
                updateConnIndicator('lost');
              }
              setTimeout(() => resetToConnectScreen(), 3000);
            } else {
              setLoading(false);
              showError(msg.msg || 'Connection failed');
              // Toast for specific error messages
              if (msg.msg === 'Invalid or expired code') {
                showToast('Invalid or expired code', 'error');
              } else if (msg.msg === 'Too many attempts. Try again in 60 seconds.') {
                showToast('Too many attempts. Try again in 60 seconds.', 'error');
              } else if (msg.msg === 'Session already in use') {
                showToast('Session is already in use', 'error');
              } else if (msg.msg) {
                showToast(msg.msg, 'error');
              }
              ws.close();
            }
            break;

          // ─── Host is connected, start key exchange ────────────────────
          case 'host-connected':
            sessionConfigApplied = false;
            readOnlyHint = msg.readonly === true;
            // UNTRUSTED - relay envelope hint only.
            // Real enforcement comes from encrypted session-config.
            if (readOnlyHint) {
              showViewOnlyBadge();
            } else if (!isReconnecting) {
              hideViewOnlyBadge();
            }
            if (!isReconnecting) {
              connectingOvl.classList.add('visible');
            }
            keyPair = await generateKeyPair();
            break;

          // ─── Key exchange — receive host's public key ─────────────────
          case 'key-exchange': {
            if (!keyPair) return;
            const hostPublicKey = msg.publicKey;
            const peerPubKey = await importPublicKey(hostPublicKey);
            sharedKey = await deriveSharedKey(keyPair.privateKey, peerPubKey);
            sessionConfigApplied = false;

            const ourPubKey = await exportPublicKey(keyPair.publicKey);
            ws.send(JSON.stringify({ type: 'key-exchange', publicKey: ourPubKey }));

            const fingerprint = await fingerprintPublicKeys(sessionCode, hostPublicKey, ourPubKey);
            const verified = await verifyFingerprint(fingerprint);
            if (!verified) {
              sessionEnded = true;
              if (ws && ws.readyState === WebSocket.OPEN) ws.close();
              resetToConnectScreen();
              showError('Fingerprint verification cancelled');
              return;
            }

            awaitingHostAuthorization = true;
            showToast('Fingerprint verified. Encrypted tunnel pending host authorization.', 'success', 6000);

            if (isReconnecting) {
              stopReconnecting();
              if (terminal) {
                terminal.write('\r\n\x1b[1;32m Fingerprint verified. Waiting for host authorization...\x1b[0m\r\n');
              }
              showToast('Waiting for host authorization', 'info', 6000);
              updateStatusDot('green');
              updateConnIndicator('relay');
            } else if (hostWaitingForReconnect) {
              hostWaitingForReconnect = false;
              showToast('Fingerprint verified. Waiting for host authorization.', 'info', 6000);
              updateStatusDot('green');
              updateConnIndicator('relay');
            } else {
              showTerminal();
            }
            break;
          }

          // ─── Phase 4: WebRTC signaling messages ───────────────────────────
          case 'signal':
            if (sharedKey) {
              try {
                const plaintext = await decrypt(sharedKey, msg.payload);
                handleSignalMessage(JSON.parse(plaintext));
              } catch (err) {
                console.error('[WebRTC] Signal decryption failed:', err);
              }
            }
            break;

          // ─── Heartbeat from host ──────────────────────────────────────
          case 'heartbeat':
            missedPings = 0;
            if (hostWaitingForReconnect) {
              hostWaitingForReconnect = false;
              if (terminal) {
                terminal.write('\r\n\x1b[1;32m Host connection restored.\x1b[0m\r\n');
                showToast('Host reconnected', 'success');
                updateStatusDot('green');
                updateConnIndicator(previousIndicatorState);
              }
              startHeartbeat();
            }
            break;

          // ─── Encrypted data from host (PTY output) ────────────────────
          case 'data':
            if (!sharedKey) return;
            try {
              // Check for resize message from host
              if (msg.meta === 'resize') {
                if (!terminal) return;
                const resizeData = JSON.parse(await decrypt(sharedKey, msg.payload));
                if (resizeData.type === 'resize' && resizeData.cols && resizeData.rows) {
                  terminal.resize(resizeData.cols, resizeData.rows);
                }
                break;
              }
              const plaintext = await decrypt(sharedKey, msg.payload);
              handleDecryptedHostMessage(plaintext);
            } catch (err) {
              console.error('Decryption error:', err);
            }
            break;

          // ─── Host PTY exited normally ─────────────────────────────────
          case 'session-ended':
            sessionEnded = true;
            stopHeartbeat();
            stopReconnecting();
            if (terminal) {
              terminal.write('\r\n\x1b[1;32m Shell exited. Session ended.\x1b[0m\r\n');
              updateStatusDot('red');
              updateConnIndicator('lost');
            }
            showToast('Host ended the session', 'error', 5000);
            setTimeout(() => resetToConnectScreen(), 3000);
            break;

          // ─── Session expired (rejoin window passed or code expired) ───
          case 'session-expired':
            sessionEnded = true;
            hostWaitingForReconnect = false;
            stopHeartbeat();
            stopReconnecting();
            if (terminal) {
              const expMsg = msg.msg || 'Session has ended.';
              terminal.write(`\r\n\x1b[1;31m ${expMsg}\x1b[0m\r\n`);
              updateStatusDot('red');
              updateConnIndicator('lost');
              showToast('Session has ended', 'error', 5000);
            }
            setTimeout(() => resetToConnectScreen(), 3000);
            break;

          case 'host-reconnecting':
            if (isWebRTCActive()) {
              showToast('Relay connection lost. Direct session is still active.', 'warning', 6000);
              updateStatusDot('green');
              updateConnIndicator('direct');
              break;
            }
            waitForHostReconnect();
            showToast('Host lost connection. Waiting for host to reconnect...', 'warning', 6000);
            break;
          // ─── Host reconnected after IP change/drop ────────────────────
          case 'host-reconnected':
            if (isWebRTCActive()) {
              hostWaitingForReconnect = false;
              missedPings = 0;
              showToast('Relay connection restored', 'success');
              updateStatusDot('green');
              updateConnIndicator('direct');
              startHeartbeat();
              break;
            }

            stopHeartbeat();
            missedPings = 0;
            sharedKey = null;
            keyPair = await generateKeyPair();
            if (terminal) {
              terminal.write('\r\n\x1b[1;32m Host reconnected. Resuming session.\x1b[0m\r\n');
              showToast('Host reconnected', 'success');
              updateStatusDot('yellow');
              updateConnIndicator('reconnecting');
            }
            break;

          // ─── Host disconnected ────────────────────────────────────────
          case 'peer-disconnected':
            stopHeartbeat();
            sharedKey = null;
            keyPair = null;
            // Phase 4: Clean up WebRTC on peer disconnect
            cleanupWebRTC();

            if (msg.reason === 'host-ended') {
              // Host deliberately closed — no reconnect
              sessionEnded = true;
              stopReconnecting();
              if (terminal) {
                terminal.write('\r\n\x1b[1;31m Host ended the session.\x1b[0m\r\n');
                showToast('Host ended the session', 'error', 5000);
                updateStatusDot('red');
                updateConnIndicator('lost');
              }
              setTimeout(() => resetToConnectScreen(), 3000);
            } else {
              if (terminal) {
                terminal.write('\r\n\x1b[1;33m Connection lost. Attempting to reconnect...\x1b[0m\r\n');
                showToast('Connection lost. Attempting to reconnect...', 'warning', 5000);
                updateStatusDot('yellow');
                updateConnIndicator('reconnecting');
              }
              beginReconnecting();
            }
            break;
        }
      };

      ws.onerror = () => {
        if (!isConnected && urlIndex + 1 < RELAY_URLS.length) {
          // Silent fallback to next relay
          connectToRelay(code, urlIndex + 1);
        } else if (isReconnecting) {
          // Silent — reconnect loop will retry
        } else if (!isConnected) {
          setLoading(false);
          showError('Could not connect to relay server');
        }
      };

      ws.onclose = () => {
        if (!isConnected && urlIndex + 1 < RELAY_URLS.length) {
          // Fallback is handled by onerror usually, but we abort here just in case
          return;
        }

        setLoading(false);

        // If we're in a live session and WS drops unexpectedly, start reconnecting
        if (terminal && !isReconnecting && !sessionEnded) {
          stopHeartbeat();

          if (isWebRTCActive()) {
            showToast('Relay connection lost. Direct session is still active.', 'warning', 5000);
            updateStatusDot('green');
            updateConnIndicator('direct');
            beginReconnecting();
            return;
          }

          sharedKey = null;
          keyPair = null;
          // Phase 4: Clean up WebRTC on WS drop
          cleanupWebRTC();
          if (terminal) {
            terminal.write('\r\n\x1b[1;33m Connection lost. Attempting to reconnect...\x1b[0m\r\n');
            showToast('Connection lost. Attempting to reconnect...', 'warning', 5000);
            updateStatusDot('yellow');
            updateConnIndicator('reconnecting');
          }
          beginReconnecting();
        }
      };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // TERMINAL
    // ═════════════════════════════════════════════════════════════════════════

    function showViewOnlyBadge() {
      readonlyBadge.style.display = 'flex';
    }

    function hideViewOnlyBadge() {
      readonlyBadge.style.display = 'none';
    }

    function setReadonly(readonly) {
      isReadOnly = readonly === true;
      readOnlyHint = false;

      if (isReadOnly) {
        showViewOnlyBadge();
        showToast('View only mode', 'info');
        pasteBtn.style.display = 'none';
        if (tabBtn) tabBtn.disabled = true;
        mobileInput.disabled = true;
        mobileInput.blur();
      } else {
        hideViewOnlyBadge();
        pasteBtn.style.display = '';
        if (tabBtn) tabBtn.disabled = false;
        mobileInput.disabled = false;
      }

      if (terminal) {
        terminal.options.disableStdin = isReadOnly;
        terminal.options.cursorBlink = !isReadOnly;
      }
    }

    function applySessionConfig(config) {
      // Trusted: came from the host through the encrypted tunnel.
      sessionConfigApplied = true;
      setReadonly(config.readonly);
      if (awaitingHostAuthorization) {
        awaitingHostAuthorization = false;
        showToast('Host authorized encrypted tunnel', 'success');
        updateStatusDot('green');
        updateConnIndicator('relay');
        startHeartbeat();
        if (terminal && terminal.cols && terminal.rows) {
          (async () => {
            try {
              const resizeJson = JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
              const payload = await encrypt(sharedKey, resizeJson);
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'data', payload, meta: 'resize' }));
              }
            } catch {}
          })();
        }
      }
      console.debug('[PeerTerm] Session config', {
        shell: config.shell,
        startPath: config.startPath,
        version: config.version,
      });
    }

    function handleDecryptedHostMessage(plaintext) {
      if (!sessionConfigApplied) {
        try {
          const parsed = JSON.parse(plaintext);
          if (
            parsed &&
            parsed.type === 'session-config' &&
            typeof parsed.readonly === 'boolean'
          ) {
            applySessionConfig(parsed);
            return;
          }
        } catch {}
      }

      if (awaitingHostAuthorization) return;

      if (terminal) {
        terminal.write(plaintext);
      }
    }

    function showTerminal() {
      // Hide connect screen, show terminal
      connectScreen.style.display = 'none';
      connectingOvl.classList.remove('visible');
      terminalScreen.classList.add('active');
      statusCode.textContent = `Session ${sessionCode}`;
      updateConnIndicator('relay');

      // Read-only mode setup
      if (isReadOnly || readOnlyHint) {
        showViewOnlyBadge();
      } else {
        hideViewOnlyBadge();
      }
      pasteBtn.style.display = isReadOnly ? 'none' : '';

      // Initialize xterm.js
      terminal = new Terminal({
        cursorBlink: !isReadOnly,
        cursorStyle: 'bar',
        fontSize: currentFontSize,
        fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
        disableStdin: isReadOnly,
        theme: {
          background: '#0c1018',
          foreground: '#e2e8f0',
          cursor: '#38bdf8',
          cursorAccent: '#0c1018',
          selectionBackground: 'rgba(56, 189, 248, 0.2)',
          selectionForeground: '#f1f5f9',
          black: '#1e293b',
          red: '#f87171',
          green: '#34d399',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#e2e8f0',
          brightBlack: '#475569',
          brightRed: '#fca5a5',
          brightGreen: '#6ee7b7',
          brightYellow: '#fde68a',
          brightBlue: '#93c5fd',
          brightMagenta: '#d8b4fe',
          brightCyan: '#67e8f9',
          brightWhite: '#f8fafc',
        },
        allowProposedApi: true,
      });

      fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalEl);
      fitAddon.fit();

      // Send initial terminal dimensions to host so PTY matches browser size
      if (sharedKey && !awaitingHostAuthorization && terminal.cols && terminal.rows) {
        (async () => {
          try {
            const resizeJson = JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
            const payload = await encrypt(sharedKey, resizeJson);
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'data', payload, meta: 'resize' }));
            }
          } catch {}
        })();
      }

      // Handle terminal input → encrypt → send to host
      terminal.onData(async (data) => {
        if (!sharedKey || isReadOnly || hostWaitingForReconnect || awaitingHostAuthorization) return;
        try {
          const payload = await encrypt(sharedKey, data);
          // Phase 4: Route through DataChannel if active, else relay
          if (useDataChannel && dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(payload);
          } else if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', payload }));
          }
        } catch (err) {
          console.error('Encryption error:', err);
        }
      });

      // Terminal resize → encrypt → send to host
      terminal.onResize(async ({ cols, rows }) => {
        if (!sharedKey || awaitingHostAuthorization) return;
        try {
          const resizeJson = JSON.stringify({ type: 'resize', cols, rows });
          const payload = await encrypt(sharedKey, resizeJson);
          // Phase 4: Route through DataChannel if active, else relay
          if (useDataChannel && dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify({ _meta: 'resize', payload }));
          } else if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', payload, meta: 'resize' }));
          }
        } catch {}
      });

      // Handle window resize → refit terminal
      window.addEventListener('resize', () => {
        if (fitAddon) fitAddon.fit();
      });

      // ─── Clipboard: Copy on selection ──────────────────────────────────
      let lastMouseUp = { x: 0, y: 0 };
      terminalEl.addEventListener('mouseup', (e) => {
        lastMouseUp = { x: e.clientX, y: e.clientY };
      });

      terminal.onSelectionChange(() => {
        const sel = terminal.getSelection();
        if (sel && sel.length > 0) {
          // Position copy button just above where the selection ended
          const btnWidth = 50;
          const btnHeight = 28;
          let top = lastMouseUp.y - btnHeight - 8;
          let left = lastMouseUp.x - btnWidth / 2;

          // Keep within viewport
          if (top < 4) top = lastMouseUp.y + 8;
          if (left < 4) left = 4;
          if (left + btnWidth > window.innerWidth - 4) left = window.innerWidth - btnWidth - 4;

          copyBtn.style.top = `${top}px`;
          copyBtn.style.left = `${left}px`;
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
          copyBtn.classList.add('visible');
        } else {
          copyBtn.classList.remove('visible');
        }
      });

      // ─── Clipboard: Keyboard shortcuts ─────────────────────────────────
      terminal.attachCustomKeyEventHandler((e) => {
        // Ctrl+Shift+C → copy
        if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
          doCopy();
          return false;
        }
        // Ctrl+Shift+V → paste
        if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
          doPaste();
          return false;
        }
        return true;
      });

      // ─── Mobile: tap terminal to focus hidden input ────────────────────
      if (isMobile) {
        terminalEl.addEventListener('touchstart', () => {
          mobileInput.focus();
        });
        setupMobileInput();
      }

      // Focus terminal
      terminal.focus();

      // Start heartbeat after terminal is ready
      if (!awaitingHostAuthorization) {
        startHeartbeat();
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CLIPBOARD
    // ═════════════════════════════════════════════════════════════════════════

    copyBtn.addEventListener('click', () => doCopy());

    pasteBtn.addEventListener('click', () => doPaste());

    function doCopy() {
      if (!terminal) return;
      const sel = terminal.getSelection();
      if (!sel) return;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(sel).then(() => {
          showCopiedFeedback();
          showToast('Copied to clipboard', 'success', 2000);
        }).catch(() => {
          fallbackCopy(sel);
        });
      } else {
        fallbackCopy(sel);
      }
    }

    function fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showCopiedFeedback();
      } catch {
        showClipToast('Copy failed. Please copy manually.');
        showToast('Clipboard access denied', 'error');
      }
    }

    function showCopiedFeedback() {
      copyBtn.textContent = '\u2713 Copied';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.classList.remove('visible', 'copied');
      }, 1500);
    }

    async function doPaste() {
      if (!terminal || !sharedKey || isReadOnly || awaitingHostAuthorization) return;
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          showClipToast('Clipboard access denied. Please paste manually.');
          showToast('Clipboard access denied', 'error');
          return;
        }
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const payload = await encrypt(sharedKey, text);
        // Phase 4: Route through DataChannel if active, else relay
        if (useDataChannel && dataChannel && dataChannel.readyState === 'open') {
          dataChannel.send(payload);
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', payload }));
        }
      } catch {
        showClipToast('Clipboard access denied. Please paste manually.');
        showToast('Clipboard access denied', 'error');
      }
    }

    function showClipToast(msg) {
      clipToast.textContent = msg;
      clipToast.classList.add('visible');
      setTimeout(() => clipToast.classList.remove('visible'), 3000);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // MOBILE KEYBOARD HANDLING
    // ═════════════════════════════════════════════════════════════════════════

    function setupMobileInput() {
      mobileInput.addEventListener('input', (e) => {
        if (!terminal || isReadOnly) return;
        const data = e.data;
        if (data) {
          terminal.paste(data);
          // Also send to host
          sendKeystroke(data);
        }
        mobileInput.value = '';
      });

      mobileInput.addEventListener('keydown', (e) => {
        if (!terminal || isReadOnly) return;
        let seq = null;
        switch (e.key) {
          case 'Backspace': seq = '\x7f'; break;
          case 'Enter':     seq = '\r';   break;
          case 'ArrowUp':   seq = '\x1b[A'; break;
          case 'ArrowDown': seq = '\x1b[B'; break;
          case 'ArrowRight':seq = '\x1b[C'; break;
          case 'ArrowLeft': seq = '\x1b[D'; break;
          case 'Tab':       seq = '\t'; e.preventDefault(); break;
        }
        if (seq) {
          e.preventDefault();
          terminal.paste(seq);
          sendKeystroke(seq);
        }
      });
    }

    async function sendKeystroke(data) {
      if (!sharedKey || isReadOnly || hostWaitingForReconnect || awaitingHostAuthorization) return;
      try {
        const payload = await encrypt(sharedKey, data);
        // Phase 4: Route through DataChannel if active, else relay
        if (useDataChannel && dataChannel && dataChannel.readyState === 'open') {
          dataChannel.send(payload);
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', payload }));
        }
      } catch {}
    }

    // Keyboard toggle button
    kbdToggleBtn.addEventListener('click', () => {
      mobileInput.focus();
    });

    // Tab button (mobile only)
    if (tabBtn) {
      tabBtn.addEventListener('click', () => {
        if (isReadOnly) return;
        tabBtn.classList.add('active');
        setTimeout(() => tabBtn.classList.remove('active'), 150);
        sendKeystroke('\t');
      });
    }

    // Font size buttons
    fontDownBtn.addEventListener('click', () => {
      if (currentFontSize > 10 && terminal) {
        currentFontSize -= 2;
        terminal.options.fontSize = currentFontSize;
        if (fitAddon) fitAddon.fit();
      }
    });

    fontUpBtn.addEventListener('click', () => {
      if (currentFontSize < 20 && terminal) {
        currentFontSize += 2;
        terminal.options.fontSize = currentFontSize;
        if (fitAddon) fitAddon.fit();
      }
    });

    // ═════════════════════════════════════════════════════════════════════════
    // CONNECTION INDICATOR
    // ═════════════════════════════════════════════════════════════════════════

    function updateConnIndicator(state) {
      const states = {
        connecting:    '\u23F3 Connecting...',
        negotiating:   '\u23F3 Establishing direct connection...',
        direct:        '\uD83D\uDFE2 Direct (Local)',
        relay:         '\uD83D\uDD34 Relay',
        reconnecting:  '\uD83D\uDFE1 Reconnecting...',
        lost:          '\u274C Connection Lost',
      };
      if (connIndicator) {
        connIndicator.textContent = states[state] || '';
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 4: WebRTC LOCAL P2P
    // ═══════════════════════════════════════════════════════════════════════════

    const LOCAL_IP_REGEX = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
    const ICE_TIMEOUT_MS = 3000;
    const DC_OPEN_TIMEOUT_MS = 5000;

    /**
     * Parse an ICE candidate string to check if it's a "host" type
     * with a local/private IP address.
     */
    function isHostCandidate(candidateStr) {
      if (!candidateStr) return false;
      const typMatch = candidateStr.match(/typ\s+(\S+)/);
      if (!typMatch) return false;
      if (typMatch[1] !== 'host') return false;
      // Check for private IP
      const ipMatch = candidateStr.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (ipMatch && LOCAL_IP_REGEX.test(ipMatch[1])) return true;
      // IPv6 link-local
      if (candidateStr.includes('fe80::')) return true;
      // typ host is enough
      return true;
    }

    /**
     * Helper to encrypt and send WebRTC signaling messages.
     */
    async function sendEncryptedSignal(payloadObj) {
      if (ws && ws.readyState === WebSocket.OPEN && sharedKey) {
        try {
          const payloadStr = JSON.stringify(payloadObj);
          const encryptedPayload = await encrypt(sharedKey, payloadStr);
          ws.send(JSON.stringify({ type: 'signal', payload: encryptedPayload }));
        } catch (err) {
          console.error('[WebRTC] Signal encryption failed:', err);
        }
      }
    }

    /**
     * Handle incoming WebRTC signaling messages from the host via relay.
     */
    function handleSignalMessage(payload) {
      if (!payload || !payload.kind) return;

      switch (payload.kind) {
        case 'offer':
          setupWebRTC(payload);
          break;

        case 'ice':
          if (peerConnection && payload.candidate) {
            // Check if remote candidate is host type
            if (!peerSameLAN && isHostCandidate(payload.candidate)) {
              peerSameLAN = true;
              console.log('[WebRTC] Remote host-type ICE candidate found');
            }
            try {
              peerConnection.addIceCandidate(new RTCIceCandidate({
                candidate: payload.candidate,
                sdpMid: payload.mid || '0',
                sdpMLineIndex: 0,
              })).catch(() => {});
            } catch {}
          }
          break;

        case 'webrtc-abort':
          console.log('[WebRTC] Host aborted WebRTC — using relay');
          cleanupWebRTC();
          break;
      }
    }

    /**
     * Set up the browser-side WebRTC PeerConnection in response to an offer.
     */
    async function setupWebRTC(offerPayload) {
      try {
        // Clean up any previous connection
        cleanupWebRTC();

        console.log('[WebRTC] Setting up peer connection...');
        updateConnIndicator('negotiating');

        peerConnection = new RTCPeerConnection({ iceServers: [] });

        // ─── ICE candidate handling ──────────────────────────────────
        peerConnection.onicecandidate = (e) => {
          if (!e.candidate) return;
          const candidateStr = e.candidate.candidate;

          // Check if our own candidate is host type
          if (!sameLAN && isHostCandidate(candidateStr)) {
            sameLAN = true;
            console.log('[WebRTC] Local host-type ICE candidate found');
          }

          // Send candidate to host via relay
          sendEncryptedSignal({ kind: 'ice', candidate: candidateStr, mid: e.candidate.sdpMid });
        };

        peerConnection.onconnectionstatechange = () => {
          const state = peerConnection ? peerConnection.connectionState : 'unknown';
          console.log('[WebRTC] Connection state:', state);
          if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            if (useDataChannel) {
              console.log('[WebRTC] Connection lost — falling back to relay');
              showToast('Switched to relay connection', 'warning');
              useDataChannel = false;
              updateConnIndicator('relay');
            }
            cleanupWebRTC();
          }
        };

        // ─── DataChannel handling (host creates the channel, we receive it) ──
        peerConnection.ondatachannel = (e) => {
          dataChannel = e.channel;
          console.log('[WebRTC] DataChannel received:', dataChannel.label);

          dataChannel.onopen = () => {
            clearWebRTCTimers();
            useDataChannel = true;
            console.log('[WebRTC] DataChannel open — relay bypassed');
            showToast('Direct local connection established', 'success');
            updateConnIndicator('direct');
          };

          dataChannel.onclose = () => {
            console.log('[WebRTC] DataChannel closed');
            if (useDataChannel) {
              useDataChannel = false;
              updateConnIndicator('relay');
            }
          };

          dataChannel.onerror = (err) => {
            console.error('[WebRTC] DataChannel error:', err);
          };

          dataChannel.onmessage = async (event) => {
            if (!sharedKey) return;
            try {
              const rawData = event.data;

              // Check if this is a tagged message (resize)
              let parsed;
              try {
                parsed = JSON.parse(rawData);
              } catch {
                parsed = null;
              }

              if (parsed && parsed._meta === 'resize') {
                if (!terminal) return;
                const resizeData = JSON.parse(await decrypt(sharedKey, parsed.payload));
                if (resizeData.type === 'resize' && resizeData.cols && resizeData.rows) {
                  terminal.resize(resizeData.cols, resizeData.rows);
                }
                return;
              }

              // Normal encrypted terminal data
              const plaintext = await decrypt(sharedKey, rawData);
              handleDecryptedHostMessage(plaintext);
            } catch (err) {
              console.error('[WebRTC] Decryption error:', err);
            }
          };
        };

        // ─── Set remote offer and create answer ─────────────────────
        await peerConnection.setRemoteDescription(new RTCSessionDescription({
          type: offerPayload.sdpType || 'offer',
          sdp: offerPayload.sdp,
        }));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        // Send answer back to host via relay
        sendEncryptedSignal({ kind: 'answer', sdp: answer.sdp, sdpType: answer.type });

        // ─── ICE timeout: 3 seconds ───────────────────────────────
        iceTimer = setTimeout(() => {
          if (useDataChannel) return; // Already connected
          if (!sameLAN || !peerSameLAN) {
            console.log('[WebRTC] Not on same LAN — using relay');
            sendEncryptedSignal({ kind: 'webrtc-abort' });
            cleanupWebRTC();
            showToast('Connected via relay', 'info');
            updateConnIndicator('relay');
          } else {
            // Same LAN confirmed — wait for DataChannel
            console.log('[WebRTC] Same LAN detected — waiting for DataChannel...');
            dcTimer = setTimeout(() => {
              if (useDataChannel) return;
              console.log('[WebRTC] DataChannel open timeout — falling back to relay');
              sendEncryptedSignal({ kind: 'webrtc-abort' });
              cleanupWebRTC();
              showToast('Connected via relay', 'info');
              updateConnIndicator('relay');
            }, DC_OPEN_TIMEOUT_MS);
          }
        }, ICE_TIMEOUT_MS);

      } catch (err) {
        console.error('[WebRTC] Setup failed:', err);
        cleanupWebRTC();
        updateConnIndicator('relay');
      }
    }

    function clearWebRTCTimers() {
      if (iceTimer) { clearTimeout(iceTimer); iceTimer = null; }
      if (dcTimer) { clearTimeout(dcTimer); dcTimer = null; }
    }

    function isWebRTCActive() {
      return useDataChannel && dataChannel && dataChannel.readyState === 'open';
    }

    function cleanupWebRTC() {
      clearWebRTCTimers();
      useDataChannel = false;
      sameLAN = false;
      peerSameLAN = false;

      if (dataChannel) {
        try { dataChannel.close(); } catch {}
        dataChannel = null;
      }
      if (peerConnection) {
        try { peerConnection.close(); } catch {}
        peerConnection = null;
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // HEARTBEAT — 5s ping, 2 missed = connection dead
    // ═════════════════════════════════════════════════════════════════════════

    function waitForHostReconnect(message) {
      if (hostWaitingForReconnect || sessionEnded) return;
      if (isWebRTCActive()) {
        missedPings = 0;
        updateStatusDot('green');
        updateConnIndicator('direct');
        return;
      }

      hostWaitingForReconnect = true;
      stopHeartbeat();
      previousIndicatorState = useDataChannel ? 'direct' : 'relay';
      cleanupWebRTC();

      if (terminal) {
        terminal.write(message || '\r\n\x1b[1;33m Host lost connection. Waiting for host to reconnect...\x1b[0m\r\n');
        updateStatusDot('yellow');
        updateConnIndicator('reconnecting');
      }
    }

    function startHeartbeat() {
      stopHeartbeat();
      missedPings = 0;
      heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }

        if (isWebRTCActive()) {
          missedPings = 0;
          return;
        }

        missedPings++;

        if (missedPings >= MAX_MISSED + 1) {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat-timeout' }));
            waitForHostReconnect('\r\n\x1b[1;33m Host heartbeat lost. Waiting for host to reconnect...\x1b[0m\r\n');
          } else {
            stopHeartbeat();
            sharedKey = null;
            keyPair = null;
            // Phase 4: Clean up WebRTC on heartbeat loss
            cleanupWebRTC();
            if (terminal) {
              terminal.write('\r\n\x1b[1;33m Connection lost. Attempting to reconnect...\x1b[0m\r\n');
              updateStatusDot('yellow');
              updateConnIndicator('reconnecting');
            }
            beginReconnecting();
          }
        }
      }, HEARTBEAT_MS);
    }

    function stopHeartbeat() {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // RECONNECT — retry every 5s with stored code
    // ═════════════════════════════════════════════════════════════════════════

    function beginReconnecting() {
      if (isReconnecting || sessionEnded) return;
      isReconnecting = true;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }

      reconnectInterval = setInterval(() => {
        if (sessionEnded) { stopReconnecting(); return; }
        connectToRelay(sessionCode);
      }, RECONNECT_MS);
    }

    function stopReconnecting() {
      isReconnecting = false;
      if (reconnectInterval) {
        clearInterval(reconnectInterval);
        reconnectInterval = null;
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // STATUS DOT — visual connection state
    // ═════════════════════════════════════════════════════════════════════════

    function updateStatusDot(color) {
      const dot = document.querySelector('.status-brand .dot');
      if (!dot) return;
      const colors = {
        green:  { bg: '#34d399', shadow: 'rgba(52, 211, 153, 0.5)' },
        yellow: { bg: '#fbbf24', shadow: 'rgba(251, 191, 36, 0.5)' },
        red:    { bg: '#f87171', shadow: 'rgba(248, 113, 113, 0.5)' },
      };
      const c = colors[color] || colors.green;
      dot.style.background = c.bg;
      dot.style.boxShadow = `0 0 6px ${c.shadow}`;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // RESET — return to the code entry screen
    // ═════════════════════════════════════════════════════════════════════════

    function resetToConnectScreen() {
      sessionEnded = true;
      stopHeartbeat();
      stopReconnecting();
      // Phase 4: Clean up WebRTC
      cleanupWebRTC();
      closeFingerprintPrompt();

      if (terminal) {
        terminal.dispose();
        terminal = null;
      }
      fitAddon = null;
      terminalEl.innerHTML = '';
      updateConnIndicator('connecting');

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      ws = null;

      keyPair = null;
      sharedKey = null;
      sessionCode = '';
      isReadOnly = false;
      readOnlyHint = false;
      sessionConfigApplied = false;
      hostWaitingForReconnect = false;
      awaitingHostAuthorization = false;
      currentFontSize = 14;

      // Reset UI
      terminalScreen.classList.remove('active');
      connectScreen.style.display = '';
      connectingOvl.classList.remove('visible');
      hideViewOnlyBadge();
      pasteBtn.style.display = '';
      mobileInput.disabled = false;
      copyBtn.classList.remove('visible');

      updateStatusDot('green');

      codeInput.value = '';
      codeInput.disabled = false;
      connectBtn.disabled = false;
      connectBtn.classList.remove('loading');
      hideError();

      codeInput.focus();
    }

/**
 * PeerTerm — Host-side WebRTC Module
 *
 * Manages a WebRTC PeerConnection + DataChannel for direct local P2P
 * terminal data transfer when host and client are on the same LAN.
 *
 * Key design points:
 *   - iceServers: [] — no STUN/TURN, only local candidates
 *   - ICE candidate parsing detects "typ host" for same-LAN detection
 *   - 3-second ICE gathering timeout, 5-second DataChannel open timeout
 *   - Emits 'open', 'close', 'message' events for Session integration
 *   - Encrypted data flows unchanged — just a different transport
 */

import nodeDataChannel from 'node-datachannel';

// Private IP ranges (same LAN indicators)
const LOCAL_IP_REGEX = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

// Timeouts
const ICE_TIMEOUT_MS = 3000;
const DC_OPEN_TIMEOUT_MS = 5000;

export class HostWebRTC {
  constructor(logFn) {
    this._log = logFn || (() => {});
    this._pc = null;
    this._dc = null;
    this._sendSignal = null;
    this._sameLAN = false;
    this._peerSameLAN = false;
    this._dcOpen = false;
    this._closed = false;

    // Event callbacks
    this._onOpenCb = null;
    this._onCloseCb = null;
    this._onMessageCb = null;

    // Timeout handles
    this._iceTimer = null;
    this._dcTimer = null;
  }

  /**
   * Start WebRTC negotiation — create offer and begin ICE gathering.
   * @param {Function} sendSignal — sends { type: 'signal', payload } via relay WS
   */
  initiate(sendSignal) {
    this._sendSignal = sendSignal;

    try {
      this._log('[WebRTC] Initiating peer connection...');

      this._pc = new nodeDataChannel.PeerConnection('host', {
        iceServers: [],
        // Disable mDNS candidates to get raw local IPs
        enableIceUdpMux: true,
      });

      // ─── ICE candidate handling ──────────────────────────────────────
      this._pc.onLocalCandidate((candidate, mid) => {
        if (this._closed) return;

        // Parse candidate type
        const candidateStr = candidate;
        this._checkLocalCandidate(candidateStr);

        this._sendSignal({
          type: 'signal',
          payload: { kind: 'ice', candidate: candidateStr, mid },
        });
      });

      this._pc.onStateChange((state) => {
        this._log(`[WebRTC] Connection state: ${state}`);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this._handleClose();
        }
      });

      this._pc.onGatheringStateChange((state) => {
        this._log(`[WebRTC] ICE gathering state: ${state}`);
      });

      // ─── Create DataChannel ──────────────────────────────────────────
      this._dc = this._pc.createDataChannel('terminal');

      this._dc.onOpen(() => {
        if (this._closed) return;
        this._clearTimers();
        this._dcOpen = true;
        this._log('[WebRTC] DataChannel open — relay bypassed');
        if (this._onOpenCb) this._onOpenCb();
      });

      this._dc.onClosed(() => {
        if (this._closed) return;
        this._log('[WebRTC] DataChannel closed');
        this._handleClose();
      });

      this._dc.onError((err) => {
        this._log(`[WebRTC] DataChannel error: ${err}`);
      });

      this._dc.onMessage((msg) => {
        if (this._closed || !this._onMessageCb) return;
        // msg can be string or Buffer
        const data = typeof msg === 'string' ? msg : msg.toString();
        this._onMessageCb(data);
      });

      // ─── Create SDP offer ────────────────────────────────────────────
      this._pc.setLocalDescription();

      // Wait a tick for the description to be set, then send
      setTimeout(() => {
        if (this._closed) return;
        const desc = this._pc.localDescription();
        if (desc) {
          this._sendSignal({
            type: 'signal',
            payload: { kind: 'offer', sdp: desc.sdp, sdpType: desc.type },
          });
        }
      }, 100);

      // ─── ICE timeout — 3 seconds ────────────────────────────────────
      this._iceTimer = setTimeout(() => {
        if (this._closed || this._dcOpen) return;
        if (!this._sameLAN || !this._peerSameLAN) {
          this._log('[WebRTC] Not on same LAN — using relay');
          this._sendSignal({
            type: 'signal',
            payload: { kind: 'webrtc-abort' },
          });
          this.close();
        } else {
          // Same LAN confirmed — wait for DataChannel to open
          this._log('[WebRTC] Same LAN detected — waiting for DataChannel...');
          this._dcTimer = setTimeout(() => {
            if (this._closed || this._dcOpen) return;
            this._log('[WebRTC] DataChannel open timeout — falling back to relay');
            this._sendSignal({
              type: 'signal',
              payload: { kind: 'webrtc-abort' },
            });
            this.close();
          }, DC_OPEN_TIMEOUT_MS);
        }
      }, ICE_TIMEOUT_MS);

    } catch (err) {
      this._log(`[WebRTC] Init failed: ${err.message}`);
      this.close();
    }
  }

  /**
   * Handle incoming signal messages from the peer (via relay).
   */
  handleSignal(payload) {
    if (this._closed || !this._pc) return;

    try {
      switch (payload.kind) {
        case 'answer':
          this._pc.setRemoteDescription(payload.sdp, payload.sdpType || 'answer');
          break;

        case 'ice':
          if (payload.candidate) {
            this._checkRemoteCandidate(payload.candidate);
            this._pc.addRemoteCandidate(payload.candidate, payload.mid || '0');
          }
          break;

        case 'webrtc-abort':
          this._log('[WebRTC] Peer aborted WebRTC — using relay');
          this.close();
          break;

        default:
          break;
      }
    } catch (err) {
      this._log(`[WebRTC] Signal handling error: ${err.message}`);
    }
  }

  /**
   * Send data over the DataChannel.
   * @param {string} data — encrypted base64 blob
   */
  send(data) {
    if (!this._dcOpen || !this._dc || this._closed) return false;
    try {
      this._dc.sendMessage(data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns true if the DataChannel is open and active.
   */
  isActive() {
    return this._dcOpen && !this._closed;
  }

  // ─── Event registration ──────────────────────────────────────────────────

  onOpen(cb) { this._onOpenCb = cb; }
  onClose(cb) { this._onCloseCb = cb; }
  onMessage(cb) { this._onMessageCb = cb; }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  close() {
    if (this._closed) return;
    this._closed = true;
    this._dcOpen = false;
    this._clearTimers();

    try {
      if (this._dc) {
        this._dc.close();
        this._dc = null;
      }
    } catch {}

    try {
      if (this._pc) {
        this._pc.close();
        this._pc = null;
      }
    } catch {}
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  _clearTimers() {
    if (this._iceTimer) { clearTimeout(this._iceTimer); this._iceTimer = null; }
    if (this._dcTimer) { clearTimeout(this._dcTimer); this._dcTimer = null; }
  }

  _handleClose() {
    if (this._closed) return;
    const wasOpen = this._dcOpen;
    this._dcOpen = false;
    this._closed = true;
    this._clearTimers();

    if (wasOpen && this._onCloseCb) {
      this._onCloseCb();
    }
  }

  /**
   * Check a local ICE candidate for "typ host" (local IP).
   */
  _checkLocalCandidate(candidateStr) {
    if (this._sameLAN) return;
    if (this._isHostCandidate(candidateStr)) {
      this._sameLAN = true;
      this._log('[WebRTC] Local host-type ICE candidate found');
    }
  }

  /**
   * Check a remote ICE candidate for "typ host" (peer's local IP).
   */
  _checkRemoteCandidate(candidateStr) {
    if (this._peerSameLAN) return;
    if (this._isHostCandidate(candidateStr)) {
      this._peerSameLAN = true;
      this._log('[WebRTC] Remote host-type ICE candidate found');
    }
  }

  /**
   * Parse ICE candidate string to check if it's a "host" type
   * with a local/private IP address.
   */
  _isHostCandidate(candidateStr) {
    if (!candidateStr) return false;
    // ICE candidate format: candidate:... typ host ...
    const typMatch = candidateStr.match(/typ\s+(\S+)/);
    if (!typMatch) return false;
    const candidateType = typMatch[1];
    if (candidateType !== 'host') return false;

    // Optionally verify it's a private IP
    const ipMatch = candidateStr.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (ipMatch && LOCAL_IP_REGEX.test(ipMatch[1])) {
      return true;
    }

    // IPv6 link-local (fe80::) also counts as local
    if (candidateStr.includes('fe80::')) {
      return true;
    }

    // If it says "typ host" but we can't parse the IP, still treat as host
    return true;
  }
}

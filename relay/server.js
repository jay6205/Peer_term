/**
 * PeerTerm Relay Server
 * 
 * WebSocket signaling + relay server that:
 * 1. Pairs host and client via 6-digit codes
 * 2. Forwards encrypted data between paired peers
 * 3. Serves the client HTML over HTTP
 * 4. Manages session lifecycle (expiry, rejoin window, rate limiting)
 * 
 * The relay NEVER reads or decrypts terminal data — it only sees base64 blobs.
 */

import * as dotenv from 'dotenv';
dotenv.config();
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;         // 5 minutes
const REJOIN_WINDOW_MS = 2 * 60 * 1000;           // 2 minutes
const CLEANUP_INTERVAL_MS = 30 * 1000;             // 30 seconds
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BLOCK_MS = 60 * 1000;             // 60 seconds

// ─── Session Store ───────────────────────────────────────────────────────────
// Map<code, session>
// session shape: {
//   hostSocket, clientSocket, expiresAt,
//   clientJoined, clientDisconnected, rejoinDeadline,
//   hostDisconnected, hostRejoinDeadline,
//   hostLastSeen, clientLastSeen
// }
const sessions = new Map();

// Reverse lookup: socket → code (for cleanup on disconnect)
const socketToCode = new Map();

// ─── Rate Limiting Store ─────────────────────────────────────────────────────
// Map<ip, { attempts: number, blockedUntil: number | null }>
const rateLimits = new Map();

// ─── Code Generation ─────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 6-digit numeric code.
 * Retries if the code already exists in active sessions.
 */
function generateCode() {
  let code;
  let attempts = 0;
  do {
    code = String(crypto.randomInt(100000, 999999));
    attempts++;
    if (attempts > 100) {
      throw new Error('Could not generate a unique code after 100 attempts');
    }
  } while (sessions.has(code));
  return code;
}

// ─── Rate Limiting Helpers ───────────────────────────────────────────────────

/**
 * Check if an IP is currently rate-limited.
 * Returns true if blocked, false if allowed.
 */
function isRateLimited(ip) {
  const entry = rateLimits.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
  // Block expired — reset
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
    rateLimits.delete(ip);
    return false;
  }
  return false;
}

/**
 * Record a failed join attempt for an IP.
 * Returns true if the IP is now blocked.
 */
function recordFailedAttempt(ip) {
  let entry = rateLimits.get(ip);
  if (!entry) {
    entry = { attempts: 0, blockedUntil: null };
    rateLimits.set(ip, entry);
  }
  entry.attempts++;
  if (entry.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.blockedUntil = Date.now() + RATE_LIMIT_BLOCK_MS;
    console.log(`[rate-limit] IP ${ip} blocked for 60 seconds after ${entry.attempts} failed attempts`);
    return true;
  }
  return false;
}

/**
 * Reset rate limit counter for an IP (on successful join).
 */
function resetRateLimit(ip) {
  rateLimits.delete(ip);
}

// ─── Cleanup Interval ────────────────────────────────────────────────────────

/**
 * Runs every 30 seconds to clean up:
 * 1. Expired codes (no client joined before expiry)
 * 2. Expired rejoin windows (client didn't come back in 2 minutes)
 * 3. Host rejoin window expired (host didn't come back in 2 minutes)
 */
setInterval(() => {
  const now = Date.now();

  for (const [code, session] of sessions) {
    // 1. Code expired and no client has joined yet
    if (!session.clientJoined && now > session.expiresAt) {
      console.log(`[cleanup] Session ${code} expired (no client joined)`);
      if (session.hostSocket && session.hostSocket.readyState === 1) {
        session.hostSocket.send(JSON.stringify({ type: 'session-expired' }));
      }
      socketToCode.delete(session.hostSocket);
      sessions.delete(code);
      continue;
    }

    // 2. Rejoin window expired — client didn't come back
    if (session.clientDisconnected && session.rejoinDeadline && now > session.rejoinDeadline) {
      console.log(`[cleanup] Client rejoin window expired for session ${code}`);
      if (session.hostSocket && session.hostSocket.readyState === 1) {
        session.hostSocket.send(JSON.stringify({ type: 'session-expired' }));
      }
      socketToCode.delete(session.hostSocket);
      if (session.clientSocket) socketToCode.delete(session.clientSocket);
      sessions.delete(code);
      continue;
    }

    // 3. Host rejoin window expired — host didn't come back
    if (session.hostDisconnected && session.hostRejoinDeadline && now > session.hostRejoinDeadline) {
      console.log(`[cleanup] Host rejoin window expired for session ${code}`);
      if (session.clientSocket && session.clientSocket.readyState === 1) {
        session.clientSocket.send(JSON.stringify({ type: 'session-expired', msg: 'Host did not reconnect in time.' }));
      }
      if (session.clientSocket) socketToCode.delete(session.clientSocket);
      socketToCode.delete(session.hostSocket);
      sessions.delete(code);
      continue;
    }
  }
}, CLEANUP_INTERVAL_MS);

// ─── HTTP Server (serves client HTML) ────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Serve the client app at root
  if (req.url === '/' || req.url === '/index.html') {
    const clientPath = path.join(__dirname, '..', 'client', 'index.html');
    fs.readFile(clientPath, (err, data) => {
      if (err) {
        // Client not bundled — serve a minimal landing page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PeerTerm Relay</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0a0a0f; color: #e0e0e0; font-family: 'Segoe UI', system-ui, sans-serif;
    }
    .card {
      text-align: center; padding: 3rem; border-radius: 16px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      max-width: 480px;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem;
      background: #22c55e22; color: #22c55e; border: 1px solid #22c55e44; margin-bottom: 1.5rem;
    }
    p { color: #888; line-height: 1.6; margin-bottom: 1rem; }
    code {
      background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 4px;
      font-size: 0.9rem; color: #a78bfa;
    }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚡ PeerTerm</h1>
    <span class="badge">● Relay Online</span>
    <p>This relay server is running and accepting connections.</p>
    <p>Connect your host agent with:<br><code>--relay ${req.headers.host ? (req.connection.encrypted ? 'wss' : 'ws') + '://' + req.headers.host : 'this server'}</code></p>
    <p style="margin-top:1.5rem; font-size:0.85rem;">
      <a href="/health">Health Check</a>
    </p>
  </div>
</body>
</html>`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

// Pass `req` to get client IP during upgrade handshake
wss.on('connection', (ws, req) => {
  // Extract client IP for rate limiting
  const clientIp = req.socket.remoteAddress || 'unknown';
  ws._peerTermIp = clientIp;
  ws.isAlive = true;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', msg: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      // ─── Host registers a new session ────────────────────────────────
      case 'host-register': {
        const expiryMs = (typeof msg.expiry === 'number' && msg.expiry > 0)
          ? msg.expiry
          : DEFAULT_EXPIRY_MS;

        const readonly = msg.readonly === true;
        const code = generateCode();
        sessions.set(code, {
          hostSocket: ws,
          clientSocket: null,
          expiresAt: Date.now() + expiryMs,
          clientJoined: false,
          clientDisconnected: false,
          rejoinDeadline: null,
          hostDisconnected: false,
          hostRejoinDeadline: null,
          hostLastSeen: Date.now(),
          clientLastSeen: null,
          readonly,
        });
        socketToCode.set(ws, code);

        ws.send(JSON.stringify({ type: 'code', code }));
        console.log(`[session] Host registered with code: ${code} (expires in ${Math.round(expiryMs / 1000)}s)${readonly ? ' (readonly)' : ''}`);
        break;
      }

      // ─── Client joins an existing session ────────────────────────────
      case 'client-join': {
        const { code } = msg;
        const ip = ws._peerTermIp;

        // Rate limit check
        if (isRateLimited(ip)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Too many attempts. Try again in 60 seconds.' }));
          return;
        }

        const session = sessions.get(code);

        // Code doesn't exist or has expired
        if (!session || (!session.clientJoined && Date.now() > session.expiresAt)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Invalid or expired code' }));
          recordFailedAttempt(ip);
          console.log(`[session] Client tried invalid/expired code: ${code}`);
          return;
        }

        // Rejoin case — client reconnecting within the 2-minute window
        if (session.clientDisconnected && session.rejoinDeadline && Date.now() < session.rejoinDeadline) {
          console.log(`[session] Client rejoining session: ${code}`);
          session.clientSocket = ws;
          session.clientDisconnected = false;
          session.rejoinDeadline = null;
          session.clientLastSeen = Date.now();
          socketToCode.set(ws, code);

          // Notify both sides — triggers fresh ECDH handshake
          session.hostSocket.send(JSON.stringify({ type: 'client-connected' }));
          ws.send(JSON.stringify({ type: 'host-connected', readonly: session.readonly }));
          resetRateLimit(ip);
          return;
        }

        // Already has a client and not in rejoin window
        if (session.clientJoined) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Session already in use' }));
          recordFailedAttempt(ip);
          console.log(`[session] Client tried already-in-use session: ${code}`);
          return;
        }

        // First join — pair the sockets
        session.clientSocket = ws;
        session.clientJoined = true;
        session.clientLastSeen = Date.now();
        socketToCode.set(ws, code);

        // Notify both sides
        session.hostSocket.send(JSON.stringify({ type: 'client-connected' }));
        ws.send(JSON.stringify({ type: 'host-connected', readonly: session.readonly }));
        resetRateLimit(ip);
        console.log(`[session] Client joined session: ${code}`);
        break;
      }

      // ─── Key exchange (ECDH public keys) ─────────────────────────────
      case 'key-exchange': {
        const code = socketToCode.get(ws);
        if (!code) return;
        const session = sessions.get(code);
        if (!session) return;

        // Forward key-exchange to the other peer
        const peer = (ws === session.hostSocket) ? session.clientSocket : session.hostSocket;
        if (peer && peer.readyState === 1) {
          peer.send(JSON.stringify(msg));
        }
        break;
      }

      // ─── Heartbeat ───────────────────────────────────────────────────
      case 'heartbeat': {
        const code = socketToCode.get(ws);
        if (!code) return;
        const session = sessions.get(code);
        if (!session) return;

        // Update lastSeen for the sending side
        if (ws === session.hostSocket) {
          session.hostLastSeen = Date.now();
        } else if (ws === session.clientSocket) {
          session.clientLastSeen = Date.now();
        }

        // Forward heartbeat to the paired peer
        const peer = (ws === session.hostSocket) ? session.clientSocket : session.hostSocket;
        if (peer && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'heartbeat' }));
        }
        break;
      }

      // ─── Session ended (host PTY exited or host intentionally quit) ──
      case 'session-ended': {
        const code = socketToCode.get(ws);
        if (!code) return;
        const session = sessions.get(code);
        if (!session) return;

        // Forward to client — this is an intentional end, no rejoin window
        if (session.clientSocket && session.clientSocket.readyState === 1) {
          session.clientSocket.send(JSON.stringify({ type: 'session-ended' }));
        }

        // Clean up the session immediately — host chose to end it
        console.log(`[session] Host PTY exited, session ended: ${code}`);
        if (session.clientSocket) socketToCode.delete(session.clientSocket);
        socketToCode.delete(session.hostSocket);
        sessions.delete(code);
        break;
      }

      // ─── WebRTC signaling (Phase 4) ────────────────────────────────────
      case 'signal': {
        const code = socketToCode.get(ws);
        if (!code) return;
        const session = sessions.get(code);
        if (!session) return;

        // Forward signal messages between peers — relay doesn't inspect
        const peer = (ws === session.hostSocket) ? session.clientSocket : session.hostSocket;
        if (peer && peer.readyState === 1) {
          peer.send(raw.toString());
        }
        break;
      }

      // ─── Data relay (encrypted terminal I/O) ─────────────────────────
      case 'data': {
        const code = socketToCode.get(ws);
        if (!code) return;
        const session = sessions.get(code);
        if (!session) return;

        // Forward data as-is to the paired peer — relay never reads payload
        const peer = (ws === session.hostSocket) ? session.clientSocket : session.hostSocket;
        if (peer && peer.readyState === 1) {
          peer.send(raw.toString());
        }
        break;
      }

      // ─── Host rejoin (host reconnecting after IP change/drop) ────────
      case 'host-rejoin': {
        const { code } = msg;
        const session = sessions.get(code);

        if (!session) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Session no longer exists.' }));
          return;
        }

        if (session.hostRejoinDeadline && Date.now() > session.hostRejoinDeadline) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Rejoin window expired.' }));
          return;
        }

        if (!session.hostDisconnected) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Host is already connected.' }));
          return;
        }

        // Valid rejoin — reassign host socket
        socketToCode.delete(session.hostSocket);
        session.hostSocket = ws;
        session.hostDisconnected = false;
        session.hostRejoinDeadline = null;
        session.hostLastSeen = Date.now();
        socketToCode.set(ws, code);

        // Notify client that host is back
        if (session.clientSocket && session.clientSocket.readyState === 1) {
          session.clientSocket.send(JSON.stringify({ type: 'host-reconnected' }));
        }

        // Confirm to host
        ws.send(JSON.stringify({ type: 'rejoined', code }));
        console.log(`[session] Host rejoined session: ${code}`);
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', msg: `Unknown message type: ${msg.type}` }));
    }
  });

  // ─── Handle disconnections ─────────────────────────────────────────────
  ws.on('close', () => {
    const code = socketToCode.get(ws);
    if (!code) return;

    const session = sessions.get(code);
    if (!session) return;

    // ─── Host disconnected ───────────────────────────────────────────
    if (ws === session.hostSocket) {
      console.log(`[session] Host disconnected from session: ${code}`);

      // Don't delete the session — open a 2-minute host rejoin window
      session.hostDisconnected = true;
      session.hostRejoinDeadline = Date.now() + REJOIN_WINDOW_MS;
      socketToCode.delete(ws);

      // Notify client that host lost connection (but session stays alive)
      if (session.clientSocket && session.clientSocket.readyState === 1) {
        session.clientSocket.send(JSON.stringify({ type: 'host-reconnecting' }));
      }

      console.log(`[session] Host rejoin window open for session ${code} (2 minutes)`);

    // ─── Client disconnected ─────────────────────────────────────────
    } else if (ws === session.clientSocket) {
      console.log(`[session] Client disconnected from session: ${code}`);

      // Don't delete the session — open a 2-minute rejoin window
      session.clientDisconnected = true;
      session.clientSocket = null;
      session.rejoinDeadline = Date.now() + REJOIN_WINDOW_MS;
      socketToCode.delete(ws);

      // Notify host that client disconnected (but session stays alive)
      if (session.hostSocket && session.hostSocket.readyState === 1) {
        session.hostSocket.send(JSON.stringify({ type: 'peer-disconnected' }));
      }

      console.log(`[session] Client rejoin window open for session ${code} (2 minutes)`);
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] Socket error:', err.message);
  });
});

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║                                           ║');
  console.log(`  ║   PeerTerm Relay Server                   ║`);
  console.log(`  ║   Listening on port ${String(PORT).padEnd(24)}║`);
  console.log(`  ║   Client UI: http://localhost:${String(PORT).padEnd(13)}║`);
  console.log('  ║                                           ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);

  // Notify all connected clients and hosts
  for (const [code, session] of sessions) {
    try {
      if (session.hostSocket && session.hostSocket.readyState === 1) {
        session.hostSocket.send(JSON.stringify({ type: 'session-expired' }));
        session.hostSocket.close();
      }
      if (session.clientSocket && session.clientSocket.readyState === 1) {
        session.clientSocket.send(JSON.stringify({ type: 'session-ended' }));
        session.clientSocket.close();
      }
    } catch {}
    sessions.delete(code);
  }

  // Close WebSocket server
  wss.close(() => {
    console.log('[server] WebSocket server closed.');

    // Close HTTP server
    server.close(() => {
      console.log('[server] HTTP server closed.');
      console.log('[server] Goodbye.');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('[server] Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));


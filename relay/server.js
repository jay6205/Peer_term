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
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;          // 5 minutes
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;        // 24 hours
const REJOIN_WINDOW_MS = 2 * 60 * 1000;           // 2 minutes
const MAX_REJOIN_WINDOW_MS = 6 * 60 * 60 * 1000;  // 6 hours
const CLEANUP_INTERVAL_MS = 30 * 1000;             // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 15 * 1000;            // 3 missed 5s heartbeats
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BLOCK_MS = 60 * 1000;             // 60 seconds
const RATE_LIMIT_ENTRY_TTL_MS = 10 * 60 * 1000;   // 10 minutes — evict stale unblocked entries
const CODE_RATE_LIMIT_MAX = 10;                    // max failed attempts per code
const CODE_RATE_LIMIT_BLOCK_MS = 5 * 60 * 1000;   // 5 minutes — block code after too many failures
const HOST_REGISTER_WINDOW_MS = 60 * 1000;         // 60 seconds
const HOST_REGISTER_MAX_PER_WINDOW = 10;
const HOST_REGISTER_BLOCK_MS = 5 * 60 * 1000;      // 5 minutes
const MAX_SESSIONS = parsePositiveInt(process.env.MAX_SESSIONS, 500);
const MAX_SESSIONS_PER_IP = parsePositiveInt(process.env.MAX_SESSIONS_PER_IP, 20);
const BACKPRESSURE_THRESHOLD = 1.25 * 1024 * 1024;  // 1.25 MB — terminate slow peers

// ─── Trusted Proxy Configuration ─────────────────────────────────────────────
// Comma-separated list of trusted proxy IPs/CIDRs.  When the direct socket
// connects from one of these addresses the server reads X-Forwarded-For;
// otherwise it falls back to remoteAddress to prevent IP spoofing.
const TRUSTED_PROXIES = (() => {
  const defaults = [
    '127.0.0.1', '::1', '::ffff:127.0.0.1',      // loopback
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', // RFC 1918
  ];
  const env = process.env.TRUSTED_PROXIES;
  if (typeof env === 'string' && env.trim()) {
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }
  return defaults;
})();

// ─── Session Store ───────────────────────────────────────────────────────────
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function markHostDisconnected(code, session, reason = 'disconnect') {
  if (session.hostDisconnected) return;

  console.log(`[session] Host ${reason} from session: ${code}`);

  session.hostDisconnected = true;
  session.hostRejoinDeadline = Date.now() + (session.rejoinWindowMs || REJOIN_WINDOW_MS);
  socketToCode.delete(session.hostSocket);

  if (session.hostSocket && session.hostSocket.readyState === 1) {
    try { session.hostSocket.terminate(); } catch {}
  }

  if (session.clientSocket && session.clientSocket.readyState === 1) {
    session.clientSocket.send(JSON.stringify({ type: 'host-reconnecting' }));
  }

  console.log(`[session] Host rejoin window open for session ${code} (${Math.round((session.rejoinWindowMs || REJOIN_WINDOW_MS) / 60000)} min)`);
}

function markClientDisconnected(code, session, reason = 'disconnect') {
  if (session.clientDisconnected) return;

  console.log(`[session] Client ${reason} from session: ${code}`);

  session.clientDisconnected = true;
  session.rejoinDeadline = Date.now() + (session.rejoinWindowMs || REJOIN_WINDOW_MS);
  socketToCode.delete(session.clientSocket);

  if (session.clientSocket && session.clientSocket.readyState === 1) {
    try { session.clientSocket.terminate(); } catch {}
  }
  session.clientSocket = null;

  if (session.hostSocket && session.hostSocket.readyState === 1) {
    session.hostSocket.send(JSON.stringify({ type: 'peer-disconnected' }));
  }

  console.log(`[session] Client rejoin window open for session ${code} (${Math.round((session.rejoinWindowMs || REJOIN_WINDOW_MS) / 60000)} min)`);
}

function sendRoleError(ws, messageType) {
  ws.send(JSON.stringify({ type: 'error', msg: `${messageType} not allowed for this socket` }));
}

function requireUnregisteredSocket(ws, messageType) {
  if (!socketToCode.has(ws)) return true;
  sendRoleError(ws, messageType);
  return false;
}

function getSocketState(ws) {
  const code = socketToCode.get(ws);
  if (!code) return null;

  const session = sessions.get(code);
  if (!session) {
    socketToCode.delete(ws);
    return null;
  }

  if (ws === session.hostSocket) return { code, session, role: 'host' };
  if (ws === session.clientSocket) return { code, session, role: 'client' };
  return { code, session, role: null };
}

function requireRole(ws, messageType, allowedRoles) {
  const state = getSocketState(ws);
  if (!state || !allowedRoles.includes(state.role)) {
    sendRoleError(ws, messageType);
    return null;
  }
  return state;
}

function getPeer(session, role) {
  if (role === 'host') return session.clientSocket;
  if (role === 'client') return session.hostSocket;
  return null;
}

// ─── Rate Limiting Store ─────────────────────────────────────────────────────
// Map<ip, { attempts: number, blockedUntil: number | null, firstAttemptAt: number }>
const rateLimits = new Map();
const hostRegisterLimits = new Map();
// Map<code, { attempts: number, blockedUntil: number | null }>
const codeLimits = new Map();

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
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry) {
    entry = { attempts: 0, blockedUntil: null, firstAttemptAt: now };
    rateLimits.set(ip, entry);
  }
  entry.attempts++;
  if (entry.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.blockedUntil = now + RATE_LIMIT_BLOCK_MS;
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

/**
 * Check if a session code is currently rate-limited (per-code brute-force protection).
 * Returns true if blocked, false if allowed.
 */
function isCodeRateLimited(code) {
  const entry = codeLimits.get(code);
  if (!entry) return false;
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
    codeLimits.delete(code);
    return false;
  }
  return false;
}

/**
 * Record a failed attempt against a session code.
 * Returns true if the code is now blocked.
 */
function recordCodeFailedAttempt(code) {
  let entry = codeLimits.get(code);
  if (!entry) {
    entry = { attempts: 0, blockedUntil: null };
    codeLimits.set(code, entry);
  }
  entry.attempts++;
  if (entry.attempts >= CODE_RATE_LIMIT_MAX) {
    entry.blockedUntil = Date.now() + CODE_RATE_LIMIT_BLOCK_MS;
    console.log(`[rate-limit] Code ${code} blocked for ${Math.round(CODE_RATE_LIMIT_BLOCK_MS / 1000)}s after ${entry.attempts} failed attempts`);
    return true;
  }
  return false;
}

/**
 * Reset per-code rate limit (on successful join).
 */
function resetCodeRateLimit(code) {
  codeLimits.delete(code);
}

// ─── Trusted Proxy IP Matching ───────────────────────────────────────────────

/**
 * Parse a CIDR string into a { subnet, prefixLen } for IPv4.
 * Returns null for non-CIDR plain IPs.
 */
function parseCIDR(cidr) {
  const match = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  const prefixLen = Number(match[2]);
  if (parts.some(p => p < 0 || p > 255) || prefixLen < 0 || prefixLen > 32) return null;
  const subnet = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
  return { subnet, prefixLen };
}

/**
 * Convert an IPv4 string to a 32-bit unsigned integer.
 * Handles ::ffff: mapped addresses.
 */
function ipv4ToInt(ip) {
  const mapped = ip.replace(/^::ffff:/, '');
  const parts = mapped.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
}

/**
 * Check whether `ip` matches any entry in the TRUSTED_PROXIES list.
 * Supports exact match and IPv4 CIDR notation.
 */
function isTrustedProxy(ip) {
  if (!ip) return false;
  const normalised = ip.replace(/^::ffff:/, '');
  for (const entry of TRUSTED_PROXIES) {
    // Exact match (handles IPv6 loopback and plain addresses)
    if (entry === ip || entry === normalised) return true;

    // CIDR match (IPv4 only)
    const cidr = parseCIDR(entry);
    if (cidr) {
      const ipInt = ipv4ToInt(ip);
      if (ipInt !== null) {
        const mask = cidr.prefixLen === 0 ? 0 : (~0 << (32 - cidr.prefixLen)) >>> 0;
        if ((ipInt & mask) === (cidr.subnet & mask)) return true;
      }
    }
  }
  return false;
}

/**
 * Extract the real client IP from a request.
 * Only trusts X-Forwarded-For when the direct connection comes from a
 * recognised proxy address; otherwise returns remoteAddress to prevent
 * IP spoofing from untrusted sources.
 */
function getClientIp(req) {
  const directIp = req.socket.remoteAddress || 'unknown';

  if (isTrustedProxy(directIp)) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      // Take the left-most (original client) address
      return forwardedFor.split(',')[0].trim();
    }
  }

  return directIp;
}

function clampDuration(value, defaultMs, maxMs) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultMs;
  return Math.min(value, maxMs);
}

function isHostRegisterLimited(ip) {
  const now = Date.now();
  let entry = hostRegisterLimits.get(ip);

  if (entry?.blockedUntil) {
    if (now < entry.blockedUntil) return true;
    hostRegisterLimits.delete(ip);
    entry = null;
  }

  if (!entry || now - entry.windowStart >= HOST_REGISTER_WINDOW_MS) {
    entry = { count: 0, windowStart: now, blockedUntil: null };
    hostRegisterLimits.set(ip, entry);
  }

  entry.count++;
  if (entry.count > HOST_REGISTER_MAX_PER_WINDOW) {
    entry.blockedUntil = now + HOST_REGISTER_BLOCK_MS;
    console.log(`[rate-limit] Host registration IP ${ip} blocked for ${Math.round(HOST_REGISTER_BLOCK_MS / 1000)} seconds`);
    return true;
  }

  return false;
}

function countSessionsForIp(ip) {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.hostIp === ip) count++;
  }
  return count;
}

function destroySession(code, session, reason) {
  console.log(`[evict] Session ${code} removed: ${reason}`);

  if (session.hostSocket && session.hostSocket.readyState === 1) {
    try { session.hostSocket.send(JSON.stringify({ type: 'session-expired', msg: reason })); } catch {}
    try { session.hostSocket.close(); } catch {}
  }
  if (session.clientSocket && session.clientSocket.readyState === 1) {
    try { session.clientSocket.send(JSON.stringify({ type: 'session-ended', msg: reason })); } catch {}
    try { session.clientSocket.close(); } catch {}
  }

  socketToCode.delete(session.hostSocket);
  if (session.clientSocket) socketToCode.delete(session.clientSocket);
  sessions.delete(code);
}

function findEvictionCandidate() {
  const ranked = [...sessions.entries()].map(([code, session]) => {
    let priority = 2;
    if (!session.clientJoined) priority = 0;
    else if (session.hostDisconnected || session.clientDisconnected) priority = 1;
    return { code, session, priority, createdAt: session.createdAt || 0 };
  });

  ranked.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  return ranked[0] || null;
}

function ensureSessionCapacity(ip) {
  if (countSessionsForIp(ip) >= MAX_SESSIONS_PER_IP) {
    return { ok: false, reason: 'Too many active sessions from this IP' };
  }

  while (sessions.size >= MAX_SESSIONS) {
    const candidate = findEvictionCandidate();
    if (!candidate) return { ok: false, reason: 'Relay is at capacity' };
    destroySession(candidate.code, candidate.session, 'Relay capacity limit reached');
  }

  return { ok: true };
}

// ─── Cleanup Interval ────────────────────────────────────────────────────────

/**
 * Runs every 30 seconds to clean up:
 * 1. Expired codes (no client joined before expiry)
 * 2. Expired rejoin windows (client didn't come back in 2 minutes)
 * 3. Host rejoin window expired (host didn't come back in 2 minutes)
 * 4. Heartbeat last-seen timeouts (half-open/stale sockets → rejoin state)
 */
setInterval(() => {
  const now = Date.now();

  // Sweep stale host-register entries
  for (const [ip, entry] of hostRegisterLimits) {
    const blockExpired = entry.blockedUntil && now >= entry.blockedUntil;
    const windowExpired = now - entry.windowStart >= HOST_REGISTER_WINDOW_MS;
    if (blockExpired || (!entry.blockedUntil && windowExpired)) hostRegisterLimits.delete(ip);
  }

  // Sweep stale per-IP rate limit entries (TTL for unblocked entries)
  for (const [ip, entry] of rateLimits) {
    if (entry.blockedUntil) {
      if (now >= entry.blockedUntil) rateLimits.delete(ip);
    } else if (entry.firstAttemptAt && now - entry.firstAttemptAt >= RATE_LIMIT_ENTRY_TTL_MS) {
      rateLimits.delete(ip);
    }
  }

  // Sweep stale per-code rate limit entries
  for (const [code, entry] of codeLimits) {
    // Remove if blocked and block expired, or if the code no longer has a session
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      codeLimits.delete(code);
    } else if (!entry.blockedUntil && !sessions.has(code)) {
      codeLimits.delete(code);
    }
  }

  for (const [code, session] of sessions) {
    // 1. Code expired and no client has joined yet
    if (!session.clientJoined && now > session.expiresAt) {
      destroySession(code, session, 'Code expired (no client joined)');
      continue;
    }

    // 2. Rejoin window expired — client didn't come back
    if (session.clientDisconnected && session.rejoinDeadline && now > session.rejoinDeadline) {
      destroySession(code, session, 'Client rejoin window expired');
      continue;
    }

    // 3. Host rejoin window expired — host didn't come back
    if (session.hostDisconnected && session.hostRejoinDeadline && now > session.hostRejoinDeadline) {
      destroySession(code, session, 'Host did not reconnect in time');
      continue;
    }

    // 4. Enforce heartbeat last-seen timeouts — detect half-open/stale sockets
    //    that never fired a 'close' event and transition them into rejoin state
    if (session.clientJoined) {
      // Check host liveness (only when host is supposedly connected)
      if (
        !session.hostDisconnected &&
        session.hostLastSeen &&
        now - session.hostLastSeen > HEARTBEAT_TIMEOUT_MS
      ) {
        console.log(`[cleanup] Host heartbeat stale for session ${code} (last seen ${Math.round((now - session.hostLastSeen) / 1000)}s ago)`);
        markHostDisconnected(code, session, 'stale heartbeat (cleanup)');
      }

      // Check client liveness (only when client is supposedly connected)
      if (
        !session.clientDisconnected &&
        session.clientLastSeen &&
        now - session.clientLastSeen > HEARTBEAT_TIMEOUT_MS
      ) {
        console.log(`[cleanup] Client heartbeat stale for session ${code} (last seen ${Math.round((now - session.clientLastSeen) / 1000)}s ago)`);
        markClientDisconnected(code, session, 'stale heartbeat (cleanup)');
      }
    }
  }
}, CLEANUP_INTERVAL_MS);

// ─── Static File MIME Types ──────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const CLIENT_DIR = path.join(__dirname, '..', 'client');

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  // Resolve the file to serve from the client directory
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(CLIENT_DIR, 'index.html');
  } else {
    // Sanitize: resolve and ensure the path stays within CLIENT_DIR
    const safePath = path.normalize(decodeURIComponent(req.url));
    filePath = path.join(CLIENT_DIR, safePath);
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If index.html is missing, serve the minimal landing page
      if (req.url === '/' || req.url === '/index.html') {
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
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── Message Validation ──────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_CODE_LEN    = 6;
const MAX_TOKEN_LEN   = 64;
const MAX_KEY_LEN     = 256;  // base64-encoded ECDH public key

const MESSAGE_SCHEMAS = {
  'host-register': {
    optional: {
      expiry:       (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      rejoinWindow: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
      readonly:     (v) => typeof v === 'boolean',
    },
  },
  'client-join': {
    required: {
      code: (v) => typeof v === 'string' && /^\d{6}$/.test(v),
    },
  },
  'key-exchange': {
    required: {
      publicKey: (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_LEN,
    },
  },
  'heartbeat':         {},
  'heartbeat-timeout':  {},
  'session-ended':      {},
  'data': {
    required: {
      payload: (v) => typeof v === 'string' && v.length > 0,
    },
  },
  'signal': {
    required: {
      payload: (v) => typeof v === 'string' && v.length > 0,
    },
  },
  'host-rejoin': {
    required: {
      code:      (v) => typeof v === 'string' && /^\d{6}$/.test(v),
      hostToken: (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TOKEN_LEN,
    },
  },
};

function validateMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return 'Missing or invalid type';

  const schema = MESSAGE_SCHEMAS[msg.type];
  if (!schema) return null; // unknown type — handled by default case in switch

  if (schema.required) {
    for (const [field, check] of Object.entries(schema.required)) {
      if (!(field in msg)) return `Missing required field: ${field}`;
      if (!check(msg[field])) return `Invalid field: ${field}`;
    }
  }
  if (schema.optional) {
    for (const [field, check] of Object.entries(schema.optional)) {
      if (field in msg && !check(msg[field])) return `Invalid field: ${field}`;
    }
  }
  return null; // valid
}

// ─── Backpressure Helper ─────────────────────────────────────────────────────

/**
 * Send to a peer with backpressure check.
 * If the peer's send buffer exceeds the threshold, the message is dropped
 * and the peer is terminated to prevent unbounded memory growth.
 * The terminated socket will trigger the existing rejoin flow.
 * @returns {boolean} true if sent, false if dropped/terminated
 */
function safeSend(peer, data, code, peerRole) {
  if (!peer || peer.readyState !== 1) return false;

  if (peer.bufferedAmount > BACKPRESSURE_THRESHOLD) {
    console.log(`[backpressure] ${peerRole} buffer exceeded ${Math.round(BACKPRESSURE_THRESHOLD / 1024)} KB for session ${code} — terminating slow peer`);
    peer.terminate();
    return false;
  }

  peer.send(data);
  return true;
}

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

// Pass `req` to get client IP during upgrade handshake
wss.on('connection', (ws, req) => {
  // Extract client IP for rate limiting
  const clientIp = getClientIp(req);
  ws._peerTermIp = clientIp;
  ws.isAlive = true;

  // Native WebSocket protocol pong — reset liveness flag
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', msg: 'Invalid JSON' }));
      return;
    }

    const validationError = validateMessage(msg);
    if (validationError) {
      ws.send(JSON.stringify({ type: 'error', msg: validationError }));
      return;
    }

    switch (msg.type) {
      // ─── Host registers a new session ────────────────────────────────
      case 'host-register': {
        if (!requireUnregisteredSocket(ws, msg.type)) return;

        const ip = ws._peerTermIp;
        if (isHostRegisterLimited(ip)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Too many host registrations. Try again later.' }));
          try { ws.close(); } catch {}
          return;
        }

        const capacity = ensureSessionCapacity(ip);
        if (!capacity.ok) {
          ws.send(JSON.stringify({ type: 'error', msg: capacity.reason }));
          try { ws.close(); } catch {}
          return;
        }

        const expiryMs = clampDuration(msg.expiry, DEFAULT_EXPIRY_MS, MAX_EXPIRY_MS);
        const rejoinWindowMs = clampDuration(msg.rejoinWindow, REJOIN_WINDOW_MS, MAX_REJOIN_WINDOW_MS);

        const readonly = msg.readonly === true;
        const code = generateCode();
        const hostToken = crypto.randomBytes(32).toString('hex');
        const now = Date.now();
        sessions.set(code, {
          hostSocket: ws,
          clientSocket: null,
          expiresAt: now + expiryMs,
          clientJoined: false,
          clientDisconnected: false,
          rejoinDeadline: null,
          hostDisconnected: false,
          hostRejoinDeadline: null,
          hostLastSeen: Date.now(),
          clientLastSeen: null,
          hostToken,
          readonly,
          rejoinWindowMs,
          hostIp: ip,
          createdAt: now,
        });
        socketToCode.set(ws, code);

        ws.send(JSON.stringify({ type: 'code', code, hostToken }));
        console.log(`[session] Host registered with code: ${code} (expires in ${Math.round(expiryMs / 1000)}s)${readonly ? ' (readonly)' : ''}`);
        break;
      }

      // ─── Client joins an existing session ────────────────────────────
      case 'client-join': {
        if (!requireUnregisteredSocket(ws, msg.type)) return;

        const { code } = msg;
        const ip = ws._peerTermIp;

        // Per-IP rate limit check
        if (isRateLimited(ip)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Too many attempts. Try again in 60 seconds.' }));
          return;
        }

        // Per-code rate limit check (brute-force protection)
        if (isCodeRateLimited(code)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Too many attempts for this code. Try again later.' }));
          return;
        }

        const session = sessions.get(code);

        // Code doesn't exist or has expired
        if (!session || (!session.clientJoined && Date.now() > session.expiresAt)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Invalid or expired code' }));
          recordFailedAttempt(ip);
          recordCodeFailedAttempt(code);
          console.log(`[session] Client tried invalid/expired code: ${code}`);
          return;
        }

        // Rejoin case — client reconnecting within the 2-minute window
        if (session.hostDisconnected) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Host is reconnecting. Try again shortly.' }));
          return;
        }

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
          resetCodeRateLimit(code);
          return;
        }

        // Already has a client and not in rejoin window
        if (session.clientJoined) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Session already in use' }));
          recordFailedAttempt(ip);
          recordCodeFailedAttempt(code);
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
        resetCodeRateLimit(code);
        console.log(`[session] Client joined session: ${code}`);
        break;
      }

      // ─── Key exchange (ECDH public keys) ─────────────────────────────
      case 'key-exchange': {
        const state = requireRole(ws, msg.type, ['host', 'client']);
        if (!state) return;
        const { session, role } = state;

        // Forward key-exchange to the other peer
        const peer = getPeer(session, role);
        if (peer && peer.readyState === 1) {
          peer.send(JSON.stringify({
            type: 'key-exchange',
            publicKey: msg.publicKey,
          }));
        }
        break;
      }

      // ─── Heartbeat ───────────────────────────────────────────────────
      case 'heartbeat': {
        const state = requireRole(ws, msg.type, ['host', 'client']);
        if (!state) return;
        const { code, session, role } = state;
        const now = Date.now();

        // Update lastSeen for the sending side
        if (role === 'host') {
          session.hostLastSeen = now;
          if (
            session.clientSocket &&
            !session.clientDisconnected &&
            session.clientLastSeen &&
            now - session.clientLastSeen > HEARTBEAT_TIMEOUT_MS
          ) {
            markClientDisconnected(code, session, 'heartbeat timed out');
            break;
          }
        } else if (role === 'client') {
          session.clientLastSeen = now;
          if (
            !session.hostDisconnected &&
            session.hostLastSeen &&
            now - session.hostLastSeen > HEARTBEAT_TIMEOUT_MS
          ) {
            markHostDisconnected(code, session, 'heartbeat timed out');
            break;
          }
        }

        // Forward heartbeat to the paired peer
        const peer = getPeer(session, role);
        if (peer && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'heartbeat' }));
        }
        break;
      }

      // Peer heartbeat timed out while this socket is still connected.
      case 'heartbeat-timeout': {
        const state = requireRole(ws, msg.type, ['host', 'client']);
        if (!state) return;
        const { code, session, role } = state;

        if (role === 'client') {
          const now = Date.now();
          session.clientLastSeen = now;
          if (
            !session.hostLastSeen ||
            now - session.hostLastSeen > HEARTBEAT_TIMEOUT_MS ||
            !session.hostSocket ||
            session.hostSocket.readyState !== 1
          ) {
            markHostDisconnected(code, session, 'heartbeat timed out');
          }
        } else if (role === 'host') {
          const now = Date.now();
          session.hostLastSeen = now;
          if (
            !session.clientLastSeen ||
            now - session.clientLastSeen > HEARTBEAT_TIMEOUT_MS ||
            !session.clientSocket ||
            session.clientSocket.readyState !== 1
          ) {
            markClientDisconnected(code, session, 'heartbeat timed out');
          }
        }
        break;
      }

      // ─── Session ended (host PTY exited or host intentionally quit) ──
      case 'session-ended': {
        const state = requireRole(ws, msg.type, ['host']);
        if (!state) return;
        const { code, session } = state;

        destroySession(code, session, 'Host ended session');
        break;
      }

      // ─── WebRTC signaling (Phase 4) ────────────────────────────────────
      case 'signal': {
        const state = requireRole(ws, msg.type, ['host', 'client']);
        if (!state) return;
        const { session, role } = state;

        // Forward signal messages between peers — relay doesn't inspect
        const peer = getPeer(session, role);
        safeSend(peer, raw.toString(), state.code, role === 'host' ? 'client' : 'host');
        break;
      }

      // ─── Data relay (encrypted terminal I/O) ─────────────────────────
      case 'data': {
        const state = requireRole(ws, msg.type, ['host', 'client']);
        if (!state) return;
        const { session, role } = state;

        // Forward data as-is to the paired peer — relay never reads payload
        const peer = getPeer(session, role);
        safeSend(peer, raw.toString(), state.code, role === 'host' ? 'client' : 'host');
        break;
      }

      // ─── Host rejoin (host reconnecting after IP change/drop) ────────
      case 'host-rejoin': {
        if (!requireUnregisteredSocket(ws, msg.type)) return;

        const { code } = msg;
        const ip = ws._peerTermIp;

        // Per-IP rate limit check
        if (isRateLimited(ip)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Too many attempts. Try again in 60 seconds.' }));
          return;
        }

        // Per-code rate limit check
        if (isCodeRateLimited(code)) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Too many attempts for this code. Try again later.' }));
          return;
        }

        const session = sessions.get(code);

        if (!session) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Session no longer exists.' }));
          recordFailedAttempt(ip);
          recordCodeFailedAttempt(code);
          return;
        }

        if (!msg.hostToken || msg.hostToken !== session.hostToken) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Invalid host rejoin token.' }));
          recordFailedAttempt(ip);
          recordCodeFailedAttempt(code);
          return;
        }

        if (session.hostRejoinDeadline && Date.now() > session.hostRejoinDeadline) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Rejoin window expired.' }));
          recordFailedAttempt(ip);
          recordCodeFailedAttempt(code);
          return;
        }

        if (!session.hostDisconnected) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Host is already connected.' }));
          recordFailedAttempt(ip);
          recordCodeFailedAttempt(code);
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
        resetRateLimit(ip);
        resetCodeRateLimit(code);
        console.log(`[session] Host rejoined session: ${code}`);
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', msg: `Unknown message type: ${msg.type}` }));
    }
  });

  // ─── Handle disconnections ─────────────────────────────────────────────
  ws.on('close', () => {
    handleSocketDisconnect(ws, 'close');
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
  console.log(`  ║   Sessions: max ${String(MAX_SESSIONS).padEnd(6)} per IP ${String(MAX_SESSIONS_PER_IP).padEnd(10)}║`);
  console.log('  ║                                           ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
});

// ─── Shared Socket Disconnect Handler ────────────────────────────────────────

/**
 * Unified disconnect handler used by both socket.on('close') and
 * the server-side heartbeat when a dead socket is found.
 * @param {WebSocket} ws - The disconnected socket
 * @param {string} source - 'close' or 'heartbeat' for logging
 */
function handleSocketDisconnect(ws, source = 'close') {
  const code = socketToCode.get(ws);
  if (!code) return;

  const session = sessions.get(code);
  if (!session) {
    socketToCode.delete(ws);
    return;
  }

  if (ws === session.hostSocket) {
    markHostDisconnected(code, session, source === 'heartbeat' ? 'dead socket (heartbeat)' : 'disconnect');
  } else if (ws === session.clientSocket) {
    markClientDisconnected(code, session, source === 'heartbeat' ? 'dead socket (heartbeat)' : 'disconnect');
  }
}

// ─── Server-Side WebSocket Heartbeat (Protocol Ping/Pong) ────────────────────

const WS_PING_INTERVAL_MS = 10000; // 10 seconds

const wsPingInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) {
      const code = socketToCode.get(socket);
      const role = code ? (() => {
        const s = sessions.get(code);
        if (!s) return 'unknown';
        if (socket === s.hostSocket) return 'host';
        if (socket === s.clientSocket) return 'client';
        return 'unknown';
      })() : 'unregistered';

      console.log(`[heartbeat] Dead socket terminated — role: ${role}, code: ${code || 'none'}`);
      handleSocketDisconnect(socket, 'heartbeat');
      socket.terminate();
      return;
    }

    socket.isAlive = false;
    socket.ping();
  });
}, WS_PING_INTERVAL_MS);

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`\n[server] Received ${signal}. Shutting down gracefully...`);

  // Stop the server-side heartbeat
  clearInterval(wsPingInterval);

  // Notify all connected clients and hosts
  for (const [code, session] of sessions) {
    destroySession(code, session, 'Relay server shutting down');
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

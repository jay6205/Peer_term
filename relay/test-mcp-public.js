/**
 * Phase 4 Public Exposure Tests — MCP over public HTTPS
 *
 * Six programmatic test cases against the real public URL:
 * 1. No Authorization header → 401
 * 2. Wrong token → 401
 * 3. Correct token + valid session_code → real buffer data
 * 4. Correct token + unknown session_code → "not found" message (not error)
 * 5. TLS handshake succeeds, no certificate warning
 * 6. WebSocket relay still works (host-register + receive code)
 *
 * Usage:
 *   MCP_TOKEN=<token> node test-mcp-public.js
 *
 * Exit 0 + "ALL 6 TESTS PASSED" if all pass, non-zero otherwise.
 */

import https from 'https';
import tls from 'tls';
import crypto from 'crypto';
import WebSocket from 'ws';

const PUBLIC_HOST = 'relay.dhananjaybalekar.in';
const PUBLIC_URL = `https://${PUBLIC_HOST}/mcp`;
const WSS_URL = `wss://${PUBLIC_HOST}`;

const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) {
  console.error('\n  FATAL: MCP_TOKEN environment variable is required.');
  console.error('  Usage: MCP_TOKEN=<token> node test-mcp-public.js\n');
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Make an HTTPS request and return { statusCode, headers, body (parsed) }.
 * Handles both JSON and SSE response formats from the MCP transport.
 */
function request(method, urlString, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: { ...headers },
    };

    if (body !== null) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;

        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('text/event-stream')) {
          const dataLines = raw.split('\n')
            .filter(line => line.startsWith('data: '))
            .map(line => {
              try { return JSON.parse(line.slice(6)); } catch { return null; }
            })
            .filter(Boolean);
          parsed = dataLines.length === 1 ? dataLines[0] : dataLines;
        } else {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }

        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);
    if (body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Make an MCP tools/call request for read_terminal against the public URL.
 */
async function callReadTerminal(sessionCode, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    id: 1,
    params: {
      name: 'read_terminal',
      arguments: { session_code: sessionCode },
    },
  };

  return request('POST', PUBLIC_URL, { headers, body });
}

/**
 * Extract the text content from a successful tools/call response.
 */
function extractToolResult(response) {
  const body = response.body;
  if (body?.result?.content?.[0]?.text) {
    return body.result.content[0].text;
  }
  return null;
}

/**
 * Connect a WebSocket host over WSS, register a session, enable MCP, and send output.
 * Returns { sessionCode, ws } — caller must close ws when done.
 */
function createHostSession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSS_URL);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket host session creation timed out (10s)'));
    }, 10000);

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'host-register' }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'code') {
        const sessionCode = msg.code;
        ws.send(JSON.stringify({ type: 'mcp-enable' }));
        ws.send(JSON.stringify({
          type: 'mcp-output',
          data: 'Hello from terminal!\r\n$ whoami\r\ntest-user\r\n',
        }));
        setTimeout(() => {
          clearTimeout(timeout);
          resolve({ sessionCode, ws });
        }, 500);
      }
    });
  });
}

// ─── Test Runner ────────────────────────────────────────────────────────────

const results = [];

function assert(testNum, name, condition, detail = '') {
  if (condition) {
    results.push({ testNum, name, pass: true });
    console.log(`  ✅ Test ${testNum}: ${name}`);
  } else {
    results.push({ testNum, name, pass: false, detail });
    console.log(`  ❌ Test ${testNum}: ${name}`);
    if (detail) console.log(`     → ${detail}`);
  }
}

async function runTests() {
  console.log('\n  ╔═══════════════════════════════════════════════════════════╗');
  console.log('  ║  Phase 4: Public Exposure Tests                         ║');
  console.log('  ║  Target: https://relay.dhananjaybalekar.in/mcp          ║');
  console.log('  ╚═══════════════════════════════════════════════════════════╝\n');

  // ── Test 1: No Authorization header → 401 ──
  {
    const res = await callReadTerminal('000000', null);
    assert(1, 'No Authorization header → 401',
      res.statusCode === 401,
      `Expected 401, got ${res.statusCode}`);
  }

  // ── Test 2: Wrong token → 401 ──
  {
    const wrongToken = crypto.randomBytes(32).toString('hex');
    const res = await callReadTerminal('000000', wrongToken);
    assert(2, 'Wrong bearer token → 401',
      res.statusCode === 401,
      `Expected 401, got ${res.statusCode}`);
  }

  // ── Test 3: Correct token + valid session → returns buffer data ──
  let hostSession;
  try {
    console.log('\n  [setup] Creating host session via WSS...');
    hostSession = await createHostSession();
    console.log(`  [setup] Host session created: ${hostSession.sessionCode}\n`);
  } catch (err) {
    console.log(`  [setup] Failed to create host session: ${err.message}\n`);
    assert(3, 'Correct token + valid session → buffer data', false,
      `Could not create host session: ${err.message}`);
    assert(4, 'Correct token + unknown session → "not found"', false, 'Skipped (no host session)');
    assert(5, 'TLS handshake succeeds cleanly', false, 'Skipped');
    assert(6, 'WebSocket relay still works', false, 'Skipped');
    return summarize();
  }

  {
    const res = await callReadTerminal(hostSession.sessionCode, TOKEN);
    const text = extractToolResult(res);
    assert(3, 'Correct token + valid session → buffer data',
      res.statusCode === 200 && text && text.includes('Hello from terminal!'),
      `Status: ${res.statusCode}, text: ${text || 'null'}, body: ${JSON.stringify(res.body).slice(0, 300)}`);
  }

  // ── Test 4: Correct token + unknown session_code → "not found" message, not error ──
  {
    const res = await callReadTerminal('999999', TOKEN);
    const text = extractToolResult(res);
    assert(4, 'Correct token + unknown session → "not found" message',
      res.statusCode === 200 && text && text.toLowerCase().includes('no shared session found'),
      `Status: ${res.statusCode}, text: ${text || 'null'}, body: ${JSON.stringify(res.body).slice(0, 300)}`);
  }

  // ── Test 5: TLS handshake succeeds cleanly, no certificate warning ──
  {
    try {
      const certOk = await new Promise((resolve, reject) => {
        const socket = tls.connect({
          host: PUBLIC_HOST,
          port: 443,
          servername: PUBLIC_HOST,
          // Use system CA store — rejectUnauthorized defaults to true
        }, () => {
          const cert = socket.getPeerCertificate();
          const authorized = socket.authorized;
          socket.end();

          if (!authorized) {
            resolve({ ok: false, reason: `Certificate not authorized: ${socket.authorizationError}` });
          } else if (!cert || !cert.subject) {
            resolve({ ok: false, reason: 'No peer certificate returned' });
          } else {
            resolve({ ok: true, subject: cert.subject.CN, issuer: cert.issuer?.O || cert.issuer?.CN });
          }
        });
        socket.on('error', (err) => reject(err));
        setTimeout(() => {
          socket.destroy();
          reject(new Error('TLS handshake timed out'));
        }, 10000);
      });

      assert(5, 'TLS handshake succeeds cleanly',
        certOk.ok,
        certOk.ok ? '' : certOk.reason);
      if (certOk.ok) {
        console.log(`     ↳ CN: ${certOk.subject}, Issuer: ${certOk.issuer}`);
      }
    } catch (err) {
      assert(5, 'TLS handshake succeeds cleanly', false, err.message);
    }
  }

  // ── Test 6: WebSocket relay still works ──
  {
    try {
      const wsOk = await new Promise((resolve, reject) => {
        const ws = new WebSocket(WSS_URL);
        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error('WebSocket test timed out (10s)'));
        }, 10000);

        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'host-register' }));
        });
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'code' && /^\d{6}$/.test(msg.code)) {
            clearTimeout(timeout);
            ws.close();
            resolve({ ok: true, code: msg.code });
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            resolve({ ok: false, reason: `Server error: ${msg.msg}` });
          }
        });
      });

      assert(6, 'WebSocket relay still works (host-register → code)',
        wsOk.ok,
        wsOk.ok ? '' : wsOk.reason);
      if (wsOk.ok) {
        console.log(`     ↳ Received session code: ${wsOk.code}`);
      }
    } catch (err) {
      assert(6, 'WebSocket relay still works', false, err.message);
    }
  }

  // Cleanup
  if (hostSession?.ws) {
    hostSession.ws.close();
  }

  summarize();
}

function summarize() {
  console.log('\n  ─────────────────────────────────────────────────');
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  if (passed === total) {
    console.log(`  ALL ${total} TESTS PASSED ✅`);
    console.log('  ─────────────────────────────────────────────────\n');
    process.exit(0);
  } else {
    const failures = results.filter(r => !r.pass);
    console.log(`  ${passed}/${total} PASSED, ${failures.length} FAILED ❌`);
    for (const f of failures) {
      console.log(`    Test ${f.testNum}: ${f.name} — ${f.detail}`);
    }
    console.log('  ─────────────────────────────────────────────────\n');
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('\n  FATAL ERROR during tests:', err);
  process.exit(1);
});

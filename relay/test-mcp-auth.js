/**
 * Phase 3 Auth Tests — MCP Bearer Token Authentication
 *
 * Five programmatic test cases:
 * 1. No Authorization header → 401
 * 2. Well-formed but wrong token → 401
 * 3. Correct token + valid session_code → real buffer data
 * 4. Regenerate token, call with OLD token → 401
 * 5. Call with NEW token → success
 *
 * Usage:
 *   node test-mcp-auth.js
 *
 * Prerequisites:
 *   - Server is running on PORT (default 8080)
 *   - Script creates its own host session with MCP output
 *
 * Exit 0 + "ALL TESTS PASSED" if all five pass, non-zero otherwise.
 */

import http from 'http';
import crypto from 'crypto';
import WebSocket from 'ws';
import { generateToken } from './token-store.js';

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Make an HTTP request and return { statusCode, headers, body (parsed) }.
 * Handles both JSON and SSE response formats from the MCP transport.
 */
function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
    };

    if (body !== null) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;

        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('text/event-stream')) {
          // Extract all JSON-RPC payloads from SSE "data:" lines
          const dataLines = raw.split('\n')
            .filter(line => line.startsWith('data: '))
            .map(line => {
              try { return JSON.parse(line.slice(6)); } catch { return null; }
            })
            .filter(Boolean);
          // For a batch, we get multiple data: lines; for single requests, just one
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
 * Make an MCP tools/call request for read_terminal.
 * Each request is routed to a fresh transport by the server
 * (no mcp-session-id header → creates new session).
 *
 * Returns the full HTTP response. For auth failures (401), the body
 * is the 401 error JSON. For success, body is the tools/call result.
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

  return request('POST', '/mcp', { headers, body });
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
 * Connect a WebSocket host, register a session, enable MCP, and send output.
 * Returns { sessionCode, ws } — caller must close ws when done.
 */
function createHostSession() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('error', reject);
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
        setTimeout(() => resolve({ sessionCode, ws }), 200);
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
  console.log('  ║  Phase 3: MCP Bearer Token Auth Tests                   ║');
  console.log('  ╚═══════════════════════════════════════════════════════════╝\n');

  // Generate the initial token (writes hash to disk; server reads it on each request)
  const token1 = generateToken();
  console.log(`  [setup] Generated token 1: ${token1.slice(0, 8)}...`);

  // Create a host session with MCP output
  const { sessionCode, ws } = await createHostSession();
  console.log(`  [setup] Created host session: ${sessionCode}`);
  console.log('');

  // ── Test 1: No Authorization header → 401 ──
  {
    const res = await callReadTerminal(sessionCode, null);
    assert(1, 'No Authorization header → 401',
      res.statusCode === 401,
      `Expected 401, got ${res.statusCode}`);
  }

  // ── Test 2: Wrong token → 401 ──
  {
    const wrongToken = crypto.randomBytes(32).toString('hex');
    const res = await callReadTerminal(sessionCode, wrongToken);
    assert(2, 'Wrong bearer token → 401',
      res.statusCode === 401,
      `Expected 401, got ${res.statusCode}`);
  }

  // ── Test 3: Correct token + valid session → returns buffer data ──
  {
    const res = await callReadTerminal(sessionCode, token1);
    const text = extractToolResult(res);
    assert(3, 'Correct token + valid session → 200 with buffer',
      res.statusCode === 200 && text && text.includes('Hello from terminal!'),
      `Status: ${res.statusCode}, text: ${text || 'null'}, body: ${JSON.stringify(res.body).slice(0, 300)}`);
  }

  // ── Test 4: Regenerate token, call with OLD token → 401 ──
  const token2 = generateToken();
  console.log(`\n  [setup] Regenerated token 2: ${token2.slice(0, 8)}...`);
  console.log(`  [setup] Token 1 should now be invalid`);
  console.log('');
  {
    const res = await callReadTerminal(sessionCode, token1);
    assert(4, 'Old token after regeneration → 401',
      res.statusCode === 401,
      `Expected 401, got ${res.statusCode}`);
  }

  // ── Test 5: New token → success ──
  {
    const res = await callReadTerminal(sessionCode, token2);
    const text = extractToolResult(res);
    assert(5, 'New token → 200 with buffer',
      res.statusCode === 200 && text && text.includes('Hello from terminal!'),
      `Status: ${res.statusCode}, text: ${text || 'null'}, body: ${JSON.stringify(res.body).slice(0, 300)}`);
  }

  // ── Summary ──
  ws.close();
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

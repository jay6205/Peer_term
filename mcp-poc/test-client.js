/**
 * PeerTerm MCP Test Client — Phase 1
 *
 * Programmatic test that verifies the MCP server's protocol plumbing:
 *   1. Connects and calls initialize
 *   2. Calls tools/list and asserts read_terminal is present with correct annotations
 *   3. Calls tools/call on read_terminal and asserts the response matches mock data
 *
 * Exits 0 with "PASS" on success, non-zero with failure description otherwise.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SERVER_URL = process.env.MCP_URL || 'http://localhost:3100/mcp';
const EXPECTED_MOCK = 'mock terminal output: $ echo hello\nhello';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${message}`);
    failures++;
  } else {
    console.log(`  ✓ ${message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`  ✗ FAIL: ${label}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
    failures++;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

// ─── Main Test ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  PeerTerm MCP PoC — Test Suite');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // ── Step 1: Initialize ──────────────────────────────────────────────────
  console.log('Step 1: Initialize connection');

  const transport = new StreamableHTTPClientTransport(
    new URL(SERVER_URL)
  );

  const client = new Client(
    { name: 'peerterm-mcp-test', version: '0.1.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log('  ✓ Connected and initialized successfully');
  } catch (err) {
    console.error(`  ✗ FAIL: Could not connect to server at ${SERVER_URL}`);
    console.error(`    Error: ${err.message}`);
    console.error('');
    console.error('  Make sure the server is running: node server.js');
    process.exit(1);
  }

  // ── Step 2: tools/list ──────────────────────────────────────────────────
  console.log('');
  console.log('Step 2: List tools and verify read_terminal');

  const toolsResult = await client.listTools();
  const tools = toolsResult.tools;

  assert(Array.isArray(tools) && tools.length > 0, 'tools/list returned at least one tool');

  const readTerminal = tools.find((t) => t.name === 'read_terminal');
  assert(readTerminal !== undefined, 'read_terminal tool exists');

  if (readTerminal) {
    // Verify input schema has session_code
    const props = readTerminal.inputSchema?.properties;
    assert(
      props && props.session_code,
      'read_terminal has session_code parameter'
    );

    // Verify annotations
    const annotations = readTerminal.annotations;
    assert(annotations !== undefined, 'read_terminal has annotations');

    if (annotations) {
      assertEqual(annotations.readOnlyHint, true, 'readOnlyHint is true');
      assertEqual(annotations.destructiveHint, false, 'destructiveHint is false');
      assertEqual(annotations.idempotentHint, true, 'idempotentHint is true');
    }
  }

  // ── Step 3: tools/call ──────────────────────────────────────────────────
  console.log('');
  console.log('Step 3: Call read_terminal and verify mock output');

  const callResult = await client.callTool({
    name: 'read_terminal',
    arguments: { session_code: '123456' },
  });

  assert(
    Array.isArray(callResult.content) && callResult.content.length > 0,
    'tools/call returned content array'
  );

  if (callResult.content && callResult.content.length > 0) {
    const textContent = callResult.content[0];
    assertEqual(textContent.type, 'text', 'content type is "text"');
    assertEqual(textContent.text, EXPECTED_MOCK, 'mock output matches exactly');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════');

  if (failures === 0) {
    console.log('  ✅ ALL TESTS PASSED');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    await client.close();
    process.exit(0);
  } else {
    console.log(`  ❌ ${failures} TEST(S) FAILED`);
    console.log('═══════════════════════════════════════════════════');
    console.log('');
    await client.close();
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error during tests:', err);
  process.exit(1);
});

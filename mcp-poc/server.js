/**
 * PeerTerm MCP Server — Phase 1 Proof of Concept
 *
 * Standalone MCP server using Streamable HTTP transport.
 * Exposes one tool: read_terminal (returns hardcoded mock data).
 *
 * No dependency on any existing PeerTerm code.
 * No authentication — local use only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3100;
const MOCK_OUTPUT = 'mock terminal output: $ echo hello\nhello';

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/**
 * Create a fresh McpServer instance with the read_terminal tool registered.
 */
function createMcpServer() {
  const server = new McpServer(
    {
      name: 'peerterm-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register the single tool for Phase 1
  server.tool(
    'read_terminal',
    'Read the latest output from a shared PeerTerm terminal session.',
    {
      session_code: z.string().describe('The 6-digit session code to read from'),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    async ({ session_code }) => {
      // Phase 1: ignore session_code, return mock data
      return {
        content: [
          {
            type: 'text',
            text: MOCK_OUTPUT,
          },
        ],
      };
    }
  );

  return server;
}

// ─── Session management (stateful transports, keyed by session ID) ───────────

const transports = new Map();

// ─── POST /mcp — main MCP endpoint ──────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  try {
    // Check for existing session
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport for this session
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Stale / unknown session ID → reject
    if (sessionId && !transports.has(sessionId)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid session ID' },
        id: null,
      });
      return;
    }

    // No session ID → new connection. Create a transport and let the
    // SDK validate internally (it will reject non-initialize requests).
    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionId: newSessionId,
      onsessioninitialized: (_session) => {
        // Session is now active
      },
    });

    transports.set(newSessionId, transport);

    // Clean up on close
    transport.onclose = () => {
      transports.delete(newSessionId);
    };

    // Connect a fresh server to this transport
    const server = createMcpServer();
    await server.connect(transport);

    // Let the transport handle + validate the request
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// ─── GET /mcp — SSE stream for server-initiated messages ─────────────────────

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: null,
    });
    return;
  }

  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
});

// ─── DELETE /mcp — close session ─────────────────────────────────────────────

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session ID' },
      id: null,
    });
    return;
  }

  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'peerterm-mcp', version: '0.1.0' });
});

// ─── Start server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🔧 PeerTerm MCP Server (Phase 1 — mock data)`);
  console.log(`   Listening on http://localhost:${PORT}/mcp`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('   Tool: read_terminal (returns hardcoded mock output)');
  console.log('   Press Ctrl+C to stop.');
});

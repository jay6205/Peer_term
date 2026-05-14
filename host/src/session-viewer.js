#!/usr/bin/env node
/**
 * PeerTerm Session Viewer
 *
 * Opens in a new terminal window and connects to the host's PTY
 * via a local TCP socket. Gives the host a direct terminal view.
 */

import net from 'net';

const port = parseInt(process.argv[2], 10);

if (!port) {
  console.error('Usage: session-viewer.js <port>');
  process.exit(1);
}

const client = net.connect({ port, host: '127.0.0.1' }, () => {
  // Send initial terminal size
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  client.write(`\x00${JSON.stringify({ type: 'resize', cols, rows })}\n`);

  // Enter raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Host keystrokes → PTY
  process.stdin.on('data', (data) => {
    client.write(data);
  });

  // PTY output → host terminal
  client.on('data', (data) => {
    process.stdout.write(data);
  });

  // Forward terminal resize
  if (process.stdout.isTTY) {
    process.stdout.on('resize', () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      client.write(`\x00${JSON.stringify({ type: 'resize', cols, rows })}\n`);
    });
  }
});

client.on('close', () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.log('\n  Session ended.');
  process.exit(0);
});

client.on('error', (err) => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.error(`  Connection failed: ${err.message}`);
  process.exit(1);
});

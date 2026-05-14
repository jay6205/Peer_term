#!/usr/bin/env node
/**
 * PeerTerm Session Viewer
 *
 * Opens in a new terminal window and connects to the host's PTY
 * via a local TCP socket. Gives the host a direct terminal view.
 */

import net from 'net';

const port = parseInt(process.argv[2], 10);

if (!port || isNaN(port) || port < 1 || port > 65535) {
  console.error('Usage: session-viewer.js <port>\nPort must be a number between 1 and 65535.');
  process.exit(1);
}

function cleanup(code, msg) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  if (msg) {
    if (code !== 0) console.error(msg);
    else console.log(msg);
  }
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0, '\n  Session terminated by signal.'));
process.on('SIGTERM', () => cleanup(0, '\n  Session terminated by signal.'));

function formatResizeMessage(cols, rows) {
  return `\x00${JSON.stringify({ type: 'resize', cols, rows })}\n`;
}

const client = net.connect({ port, host: '127.0.0.1' }, () => {
  client.setTimeout(0); // Clear timeout once connected
  // Send initial terminal size
  const cols = process.stdout.isTTY ? (process.stdout.columns || 80) : 80;
  const rows = process.stdout.isTTY ? (process.stdout.rows || 24) : 24;
  client.write(formatResizeMessage(cols, rows));

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
      client.write(formatResizeMessage(cols, rows));
    });
  }
});
client.setTimeout(5000);

client.on('timeout', () => {
  client.destroy();
  cleanup(1, '  Connection timed out.');
});

client.on('close', () => {
  cleanup(0, '\n  Session ended.');
});

client.on('error', (err) => {
  cleanup(1, `  Connection failed: ${err.message}`);
});

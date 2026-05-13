#!/usr/bin/env node

/**
 * PeerTerm — CLI Entry Point
 *
 * This is the shebang entry point for `npx peer-term` and global installs.
 * It imports the main host agent and handles uncaught exceptions gracefully.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Global Error Handling ───────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), '.peerterm', 'logs');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

function logFatalError(label, err) {
  // Write full stack to file
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${label}: ${err.message || err}\n${err.stack || ''}\n\n`;
    fs.appendFileSync(ERROR_LOG, entry);
  } catch {
    // Can't even log — nothing to do
  }

  // Print friendly message to terminal
  console.error('');
  console.error(`  ✖ ${label}: ${err.message || err}`);
  console.error(`    Details logged to: ${ERROR_LOG}`);
  console.error('');
}

process.on('uncaughtException', (err) => {
  logFatalError('Uncaught exception', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logFatalError('Unhandled promise rejection', err);
  process.exit(1);
});

// ─── Launch Main ─────────────────────────────────────────────────────────────

import('../src/index.js').catch((err) => {
  logFatalError('Failed to start PeerTerm', err);
  process.exit(1);
});

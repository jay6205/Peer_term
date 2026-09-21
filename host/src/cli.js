/**
 * PeerTerm CLI — Interactive session manager
 *
 * Top-level orchestration:
 *   1. Detects shell, resolves start path, runs interactive prompts
 *   2. Creates a SessionManager and starts the first session
 *   3. Provides a readline-based menu (n/l/k/a/q) for managing sessions
 *   4. Handles SIGINT and global error handlers
 */

import readline from 'readline';
import logger from './logger.js';
import { printBanner } from './ui.js';
import { argv, RELAY_URLS } from './config.js';
import { formatDuration, detectShell, resolveStartPath } from './utils.js';
import { getExpiryInteractive, getRejoinInteractive } from './prompts.js';
import { SessionManager } from './index.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const shell = detectShell();
  const readOnly = argv.readonly;
  const startPath = resolveStartPath(argv.path);

  // Print startup banner
  printBanner();

  // Interactive prompts — always ask unless flags are passed or non-interactive
  const expiryMs = await getExpiryInteractive();
  const rejoinMs = await getRejoinInteractive();
  console.log('');

  logger.info(`Shell:          ${shell}`);
  logger.info(`Relays:         ${RELAY_URLS.join(', ')}`);
  logger.info(`Path:           ${startPath}`);
  logger.info(`Expiry:         ${formatDuration(expiryMs)}`);
  logger.info(`Rejoin Window:  ${formatDuration(rejoinMs)}`);
  if (readOnly) logger.info('Mode:           READ-ONLY');
  if (argv.verbose) logger.info('Verbose logging enabled');
  console.log('');

  const manager = new SessionManager(shell, expiryMs, rejoinMs, readOnly, startPath);

  // Create first session automatically
  const firstCode = await manager.createSession();
  if (!firstCode) {
    logger.error('Failed to start. Is the relay server running?');
    process.exit(1);
  }

  // ─── Interactive CLI menu ──────────────────────────────────────────
  console.log('  ─────────────────────────────────────────');
  console.log('  Commands:');
  console.log('    [n] New session');
  console.log('    [l] List sessions');
  console.log('    [a <code>] Authorize verified fingerprint');
  console.log('    [k <code>] Kill session');
  console.log('    [q] Quit all');
  console.log('  ─────────────────────────────────────────');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  > ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (input === 'n') {
      logger.info('Creating new session...');
      await manager.createSession();
    } else if (input === 'l') {
      manager.listSessions();
    } else if (input.startsWith('a ')) {
      const code = input.slice(2).trim();
      await manager.authorizeSession(code);
    } else if (input.startsWith('k ')) {
      const code = input.slice(2).trim();
      manager.killSession(code);
    } else if (input === 'q') {
      logger.info('Shutting down all sessions...');
      manager.killAll();
      rl.close();
      process.exit(0);
    } else if (input) {
      console.log('  Unknown command. Use n, l, a <code>, k <code>, or q.');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    manager.killAll();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('');
    logger.info('Shutting down...');
    manager.killAll();
    rl.close();
    process.exit(0);
  });
}

// ─── Global Error Handling ───────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled rejection: ${err.message}`, err);
});

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`, err);
  process.exit(1);
});

/**
 * PeerTerm — Logger Module
 *
 * Structured logger with three levels: INFO, WARN, ERROR.
 * - Timestamps: [HH:MM:SS]
 * - Error logs written to ~/.peerterm/logs/error.log
 * - --verbose flag enables DEBUG level
 * - Stack traces only go to file, never to terminal
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_DIR = path.join(os.homedir(), '.peerterm', 'logs');
const ERROR_LOG_PATH = path.join(LOG_DIR, 'error.log');

let verboseMode = false;

/**
 * Ensure the log directory exists.
 */
function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Silent — if we can't create the log dir, we just skip file logging
  }
}

/**
 * Format current time as HH:MM:SS.
 */
function timestamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Append an error entry to ~/.peerterm/logs/error.log.
 */
function writeToErrorLog(message, stack) {
  try {
    ensureLogDir();
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${message}\n${stack ? stack + '\n' : ''}\n`;
    fs.appendFileSync(ERROR_LOG_PATH, entry);
  } catch {
    // Silent — don't crash because of logging
  }
}

const logger = {
  /**
   * Enable or disable verbose (DEBUG) mode.
   */
  setVerbose(enabled) {
    verboseMode = enabled;
  },

  /**
   * INFO — always shown. Key events the user should see.
   */
  info(msg) {
    console.log(`  [${timestamp()}] INFO  ${msg}`);
  },

  /**
   * WARN — always shown. Non-fatal issues.
   */
  warn(msg) {
    console.log(`  [${timestamp()}] WARN  ${msg}`);
  },

  /**
   * ERROR — always shown in terminal (human-readable message only).
   * Stack trace is written to ~/.peerterm/logs/error.log.
   */
  error(msg, err) {
    console.error(`  [${timestamp()}] ERROR ${msg}`);
    if (err && err.stack) {
      writeToErrorLog(msg, err.stack);
    } else {
      writeToErrorLog(msg);
    }
  },

  /**
   * DEBUG — only shown when --verbose is enabled.
   */
  debug(msg) {
    if (verboseMode) {
      console.log(`  [${timestamp()}] DEBUG ${msg}`);
    }
  },
};

export default logger;
export { writeToErrorLog, ERROR_LOG_PATH };

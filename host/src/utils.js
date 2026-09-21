/**
 * PeerTerm — Utility Functions
 *
 * Generic helpers with no domain dependencies:
 * - Duration parsing and formatting
 * - Path resolution (tilde expansion, start path validation)
 * - Shell detection
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

// ─── Duration Parsing ────────────────────────────────────────────────────────

/**
 * Parse a human-readable duration string into milliseconds.
 * Accepted formats: "30s", "5m", "1h" (case-insensitive).
 *
 * @param {string} str - Duration string
 * @returns {number|null} Duration in milliseconds, or null if invalid
 */
export function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default:  return null;
  }
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted string (e.g. "5 minute(s)")
 */
export function formatDuration(ms) {
  if (ms >= 3600000) return `${Math.round(ms / 3600000)} hour(s)`;
  if (ms >= 60000) return `${Math.round(ms / 60000)} minute(s)`;
  return `${Math.round(ms / 1000)} second(s)`;
}

// ─── Path Resolution ─────────────────────────────────────────────────────────

/**
 * Expand a leading ~ to the user's home directory.
 *
 * @param {string} inputPath
 * @returns {string}
 */
export function expandTilde(inputPath) {
  if (inputPath.startsWith('~/') || inputPath === '~') {
    return inputPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
  }
  return inputPath;
}

/**
 * Resolve and validate a starting directory path.
 * Falls back to the user's home directory if no path is provided.
 * Exits the process if the path doesn't exist or isn't a directory.
 *
 * @param {string|undefined} inputPath
 * @returns {string} Resolved absolute path
 */
export function resolveStartPath(inputPath) {
  if (!inputPath) return process.env.HOME || process.env.USERPROFILE || process.cwd();

  const resolved = path.resolve(expandTilde(inputPath));

  if (!fs.existsSync(resolved)) {
    logger.error(`Path does not exist: ${resolved}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    logger.error(`Path is not a directory: ${resolved}`);
    process.exit(1);
  }

  return resolved;
}

// ─── Shell Detection ─────────────────────────────────────────────────────────

/**
 * Detect the user's default shell.
 * Checks $SHELL, Windows COMSPEC, /etc/passwd, and falls back to bash/powershell.
 *
 * @returns {string} Shell executable path or name
 */
export function detectShell() {
  const platform = os.platform();
  if (process.env.SHELL) return process.env.SHELL;
  if (platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
    const username = os.userInfo().username;
    const line = passwd.split('\n').find((l) => l.startsWith(username + ':'));
    if (line) {
      const shell = line.split(':').pop().trim();
      if (shell) return shell;
    }
  } catch {}
  return platform === 'win32' ? 'powershell.exe' : 'bash';
}

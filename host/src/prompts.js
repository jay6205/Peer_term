/**
 * PeerTerm — Interactive Prompts
 *
 * Terminal prompts for session expiry and rejoin window configuration.
 * Handles three modes: CLI flag, interactive TTY prompt, silent default.
 */

import readline from 'readline';
import { parseDuration } from './utils.js';
import { argv, expiryFlagPassed, rejoinFlagPassed } from './config.js';
import logger from './logger.js';

// ─── Generic Duration Prompt ─────────────────────────────────────────────────

/**
 * Prompt the user for a duration value in the terminal.
 * Re-prompts on invalid input until a valid value is entered or Enter is pressed for default.
 *
 * @param {Object} opts
 * @param {string} opts.label       - Main prompt question
 * @param {string} opts.description - Additional context shown below the question
 * @param {number} opts.defaultMs   - Default value in milliseconds
 * @param {string} opts.defaultLabel - Human-readable default (e.g. "5 minutes")
 * @param {number} opts.minMs       - Minimum allowed value in milliseconds
 * @param {number} opts.maxMs       - Maximum allowed value in milliseconds
 * @param {string} opts.minLabel    - Human-readable minimum (e.g. "2m")
 * @param {string} opts.maxLabel    - Human-readable maximum (e.g. "24h")
 * @returns {Promise<number>} Resolved duration in milliseconds
 */
function promptDuration({ label, description, defaultMs, defaultLabel, minMs, maxMs, minLabel, maxLabel }) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      console.log('');
      console.log(`  ${label}`);
      if (description) console.log(`  ${description}`);
      console.log(`  Enter a value between ${minLabel} and ${maxLabel} (e.g. ${minLabel}, 30m, 2h)`);
      console.log(`  Default is ${defaultLabel}. Press Enter to use default.`);
      rl.question('  > ', (answer) => {
        const input = answer.trim();

        // Empty input — use default
        if (!input) {
          rl.close();
          resolve(defaultMs);
          return;
        }

        const parsed = parseDuration(input);
        if (!parsed || parsed < minMs || parsed > maxMs) {
          console.log(`  Invalid value. Please enter a time between ${minLabel} and ${maxLabel} (e.g. 5m, 1h).`);
          ask();
          return;
        }

        rl.close();
        resolve(parsed);
      });
    };

    ask();
  });
}

// ─── Expiry ──────────────────────────────────────────────────────────────────

/**
 * Get the session code expiry — from flag, interactive prompt, or silent default.
 *
 * @returns {Promise<number>} Expiry in milliseconds
 */
export async function getExpiryInteractive() {
  const DEFAULT_EXPIRY = 5 * 60 * 1000;       // 5 minutes
  const MIN_EXPIRY     = 2 * 60 * 1000;       // 2 minutes
  const MAX_EXPIRY     = 24 * 60 * 60 * 1000; // 24 hours

  // If --expiry flag was explicitly passed, use it (validate and exit on error)
  if (expiryFlagPassed) {
    const parsed = parseDuration(argv.expiry);
    if (!parsed || parsed < MIN_EXPIRY || parsed > MAX_EXPIRY) {
      logger.error(`Invalid expiry: "${argv.expiry}". Must be between 2m and 24h.`);
      process.exit(1);
    }
    return parsed;
  }

  // Non-interactive — use default silently
  if (!process.stdin.isTTY) return DEFAULT_EXPIRY;

  // Interactive prompt
  return promptDuration({
    label: 'How long should the session code be valid?',
    description: null,
    defaultMs: DEFAULT_EXPIRY,
    defaultLabel: '5 minutes',
    minMs: MIN_EXPIRY,
    maxMs: MAX_EXPIRY,
    minLabel: '2m',
    maxLabel: '24h',
  });
}

// ─── Rejoin Window ───────────────────────────────────────────────────────────

/**
 * Get the reconnection window — from flag, interactive prompt, or silent default.
 *
 * @returns {Promise<number>} Rejoin window in milliseconds
 */
export async function getRejoinInteractive() {
  const DEFAULT_REJOIN = 5 * 60 * 1000;       // 5 minutes
  const MIN_REJOIN     = 5 * 60 * 1000;       // 5 minutes
  const MAX_REJOIN     = 6 * 60 * 60 * 1000;  // 6 hours

  // If --rejoin flag was explicitly passed, use it
  if (rejoinFlagPassed) {
    const parsed = parseDuration(argv.rejoin);
    if (!parsed || parsed < MIN_REJOIN || parsed > MAX_REJOIN) {
      logger.error(`Invalid rejoin window: "${argv.rejoin}". Must be between 5m and 6h.`);
      process.exit(1);
    }
    return parsed;
  }

  // Non-interactive — use default silently
  if (!process.stdin.isTTY) return DEFAULT_REJOIN;

  // Interactive prompt
  return promptDuration({
    label: 'How long should the reconnection window be?',
    description: 'This is how long a disconnected client or host has to rejoin before the session ends.',
    defaultMs: DEFAULT_REJOIN,
    defaultLabel: '2 minutes',
    minMs: MIN_REJOIN,
    maxMs: MAX_REJOIN,
    minLabel: '5m',
    maxLabel: '6h',
  });
}

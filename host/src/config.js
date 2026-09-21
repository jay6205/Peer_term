/**
 * PeerTerm — Configuration Module
 *
 * CLI argument parsing, flag detection, and static configuration constants.
 * Single source of truth for user-provided options and app-wide constants.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import minimist from 'minimist';
import logger from './logger.js';
import { printHelp, printVersion } from './ui.js';

// ─── File paths ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from host/ directory (parent of src/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ─── Version ─────────────────────────────────────────────────────────────────

let version = 'unknown';
try {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  version = pkg.version;
} catch {}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  boolean: ['readonly', 'verbose', 'help', 'version', 'secure'],
  string: ['expiry', 'rejoin', 'relay', 'path'],
  alias: { h: 'help', v: 'version', V: 'verbose' },
});

// Detect if --expiry or --rejoin were explicitly passed on the command line
const expiryFlagPassed = process.argv.some(a => a === '--expiry' || a.startsWith('--expiry='));
const rejoinFlagPassed = process.argv.some(a => a === '--rejoin' || a.startsWith('--rejoin='));

// Handle --help
if (argv.help) {
  printHelp();
  process.exit(0);
}

// Handle --version
if (argv.version) {
  printVersion();
  process.exit(0);
}

// Enable verbose logging
if (argv.verbose) {
  logger.setVerbose(true);
}

// ─── Static Configuration ────────────────────────────────────────────────────

const DEFAULT_RELAYS = [
  'wss://relay.dhananjaybalekar.in'
];

const RELAY_URLS = argv.relay 
  ? argv.relay.split(',').map(s => s.trim()) 
  : (process.env.RELAY_URL ? process.env.RELAY_URL.split(',').map(s => s.trim()) : DEFAULT_RELAYS);

const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_PINGS = 2;

const UPLOAD_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB max
const UPLOAD_MAX_CHUNKS_PER_FILE = Math.ceil(UPLOAD_MAX_FILE_SIZE / 16384);
const UPLOAD_MAX_CONCURRENT = 3;

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  argv,
  version,
  expiryFlagPassed,
  rejoinFlagPassed,
  RELAY_URLS,
  HEARTBEAT_INTERVAL_MS,
  MAX_MISSED_PINGS,
  UPLOAD_MAX_FILE_SIZE,
  UPLOAD_MAX_CHUNKS_PER_FILE,
  UPLOAD_MAX_CONCURRENT,
};

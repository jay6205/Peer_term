/**
 * PeerTerm — CLI UI Module
 *
 * Handles all terminal output formatting:
 * - ASCII art banner
 * - Session code display box
 * - Help text
 * - Version display
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── ASCII Banner ────────────────────────────────────────────────────────────

const BANNER = `
  ██████╗ ███████╗███████╗██████╗ ████████╗███████╗██████╗ ███╗   ███╗
  ██╔══██╗██╔════╝██╔════╝██╔══██╗╚══██╔══╝██╔════╝██╔══██╗████╗ ████║
  ██████╔╝█████╗  █████╗  ██████╔╝   ██║   █████╗  ██████╔╝██╔████╔██║
  ██╔═══╝ ██╔══╝  ██╔══╝  ██╔══██╗   ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║
  ██║     ███████╗███████╗██║  ██║   ██║   ███████╗██║  ██║██║ ╚═╝ ██║
  ╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝
                      Terminal sharing. Instant. Encrypted.`;

/**
 * Print the startup ASCII art banner.
 */
export function printBanner() {
  console.log(BANNER);
  console.log('');
}

// ─── Session Code Box ────────────────────────────────────────────────────────

/**
 * Print the bordered session information box.
 *
 * @param {Object} opts
 * @param {string} opts.code     - 6-digit session code
 * @param {string} opts.expiry   - Formatted expiry string (e.g. "5 minute(s)")
 * @param {string} opts.mode     - "Read-Write" or "Read-Only"
 * @param {string} opts.shell    - Shell path (e.g. "/bin/zsh")
 * @param {string} [opts.startPath] - Starting directory for the session
 * @param {string} [opts.shareUrl] - URL to share (e.g. "https://peerterm.dev")
 */
export function printSessionBox({ code, expiry, rejoinWindow, mode, shell, startPath, shareUrl }) {
  const spacedCode = code.split('').join(' ');
  const url = shareUrl || 'https://peerterm.dev';

  // Truncate long shell paths to keep box readable
  const shellDisplay = shell.length > 24 ? '...' + shell.slice(-21) : shell;

  // Truncate long start paths similarly
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  let pathDisplay = startPath || homeDir;
  if (homeDir && pathDisplay.startsWith(homeDir)) {
    pathDisplay = '~' + pathDisplay.slice(homeDir.length);
  }
  if (pathDisplay.length > 30) pathDisplay = '...' + pathDisplay.slice(-27);

  // Calculate dynamic box width based on longest content
  const infoLines = [
    `   Session Code:  ${spacedCode}`,
    `   Expires in:    ${expiry}`,
    `   Rejoin Window: ${rejoinWindow}`,
    `   Mode:          ${mode}`,
    `   Shell:         ${shellDisplay}`,
    `   Path:          ${pathDisplay}`,
  ];
  const shareLine = `   Share at: ${url}`;
  const allLines = [...infoLines, shareLine];
  const maxLen = Math.max(...allLines.map(l => l.length), 35);
  const innerWidth = maxLen + 3; // padding on right

  const hr = '─'.repeat(innerWidth);
  const emptyLine = ' '.repeat(innerWidth);

  console.log('');
  console.log(`  ┌${hr}┐`);
  console.log(`  │${emptyLine}│`);
  for (const line of infoLines) {
    console.log(`  │${line.padEnd(innerWidth)}│`);
  }
  console.log(`  │${emptyLine}│`);
  console.log(`  │${shareLine.padEnd(innerWidth)}│`);
  console.log(`  │${emptyLine}│`);
  console.log(`  └${hr}┘`);
  console.log('');
}

// ─── Help Text ───────────────────────────────────────────────────────────────

const HELP_TEXT = `
Usage: peer-term [options]

Options:
  --expiry <time>     Session expiry time (e.g. 5m, 30s, 1h)  [default: 5m]
  --rejoin <time>     Reconnection window (e.g. 5m, 1h, 6h)   [default: 2m]
  --readonly          Share in view-only mode
  --secure            Enable fingerprint verification for MITM protection
  --path <dir>        Starting directory for the terminal session  [default: home]
  --relay <url>       Custom relay server URL
  --verbose           Enable debug logging
  --help              Show this help message
  --version           Print version number

Examples:
  peer-term                        Start session with defaults
  peer-term --expiry 10m           Custom expiry
  peer-term --rejoin 30m           Custom reconnection window
  peer-term --readonly             View-only session
  peer-term --secure               Require fingerprint verification
  peer-term --path ~/projects      Start in ~/projects
  peer-term --verbose              Debug logs
  peer-term --relay wss://custom   Use custom relay server
`;

/**
 * Print CLI help text.
 */
export function printHelp() {
  console.log(HELP_TEXT);
}

// ─── Version ─────────────────────────────────────────────────────────────────

/**
 * Print the version number from package.json.
 */
export function printVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    console.log(`peer-term v${pkg.version}`);
  } catch {
    console.log('peer-term (version unknown)');
  }
}

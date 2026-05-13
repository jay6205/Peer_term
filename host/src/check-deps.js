/**
 * PeerTerm — Native Dependency Check
 *
 * Postinstall script that verifies native modules (node-pty, node-datachannel)
 * are available. Prints clear errors with platform-specific fix instructions
 * if they're missing. Exits cleanly (warning, not error) so npm install
 * doesn't fail.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let allGood = true;

// ─── Check node-pty ──────────────────────────────────────────────────────────

try {
  require('node-pty');
} catch {
  allGood = false;
  console.warn('');
  console.warn('  ⚠  node-pty failed to load.');
  console.warn('');
  console.warn('  node-pty is a native C++ module that requires build tools.');
  console.warn('');

  if (process.platform === 'win32') {
    console.warn('  Windows fix:');
    console.warn('    npm install -g windows-build-tools');
    console.warn('    — or —');
    console.warn('    Install Visual Studio Build Tools with "Desktop development with C++"');
  } else if (process.platform === 'darwin') {
    console.warn('  macOS fix:');
    console.warn('    xcode-select --install');
  } else {
    console.warn('  Linux fix:');
    console.warn('    sudo apt install build-essential python3   (Debian/Ubuntu)');
    console.warn('    sudo yum groupinstall "Development Tools"  (RHEL/CentOS)');
  }

  console.warn('');
  console.warn('  Then run: npm rebuild node-pty');
  console.warn('');
}

// ─── Check node-datachannel ──────────────────────────────────────────────────

try {
  require('node-datachannel');
} catch {
  allGood = false;
  console.warn('');
  console.warn('  ⚠  node-datachannel failed to load.');
  console.warn('');
  console.warn('  node-datachannel is a native module for WebRTC DataChannels.');
  console.warn('  It requires CMake and C++ build tools.');
  console.warn('');

  if (process.platform === 'win32') {
    console.warn('  Windows fix:');
    console.warn('    Install CMake from https://cmake.org/download/');
    console.warn('    Install Visual Studio Build Tools with "Desktop development with C++"');
  } else if (process.platform === 'darwin') {
    console.warn('  macOS fix:');
    console.warn('    brew install cmake');
    console.warn('    xcode-select --install');
  } else {
    console.warn('  Linux fix:');
    console.warn('    sudo apt install cmake build-essential   (Debian/Ubuntu)');
    console.warn('    sudo yum install cmake gcc-c++           (RHEL/CentOS)');
  }

  console.warn('');
  console.warn('  Then run: npm rebuild node-datachannel');
  console.warn('');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

if (allGood) {
  console.log('  ✓ All native dependencies loaded successfully.');
}

/**
 * MCP Bearer Token Store
 *
 * Manages a single opaque bearer token for authenticating MCP API requests.
 * - Generates cryptographically random 256-bit tokens
 * - Stores ONLY the SHA-256 hash on disk (never the plaintext)
 * - Only one token active at a time; regenerating invalidates the previous one
 * - Constant-time comparison via crypto.timingSafeEqual
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN_HASH_FILE = path.join(__dirname, '.mcp-token-hash');

/**
 * Generate a new MCP bearer token.
 * - Creates 32 bytes (256 bits) of cryptographic randomness
 * - Writes the SHA-256 hash to disk, overwriting any previous hash
 * - Returns the plaintext token (caller prints it once, then discards)
 * @returns {string} The plaintext token (hex-encoded, 64 chars)
 */
export function generateToken() {
  const tokenBytes = crypto.randomBytes(32);
  const plaintextToken = tokenBytes.toString('hex');

  const hash = crypto.createHash('sha256').update(plaintextToken).digest();
  fs.writeFileSync(TOKEN_HASH_FILE, hash.toString('hex'), 'utf-8');

  return plaintextToken;
}

/**
 * Load the stored token hash from disk.
 * @returns {Buffer|null} The stored hash as a Buffer, or null if no token has been generated
 */
export function loadTokenHash() {
  try {
    const hexHash = fs.readFileSync(TOKEN_HASH_FILE, 'utf-8').trim();
    if (!hexHash || hexHash.length !== 64) return null;
    return Buffer.from(hexHash, 'hex');
  } catch {
    return null;
  }
}

/**
 * Verify a plaintext token against the stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 * @param {string} plaintextToken - The token from the Authorization header
 * @returns {boolean} true if the token is valid
 */
export function verifyToken(plaintextToken) {
  const storedHash = loadTokenHash();
  if (!storedHash) return false;

  const incomingHash = crypto.createHash('sha256').update(plaintextToken).digest();

  // Both buffers are SHA-256 digests (32 bytes), so lengths always match
  // but we guard anyway for safety
  if (storedHash.length !== incomingHash.length) return false;

  return crypto.timingSafeEqual(storedHash, incomingHash);
}

/**
 * Check whether a token hash file exists (i.e., a token has been generated).
 * @returns {boolean}
 */
export function hasToken() {
  return loadTokenHash() !== null;
}

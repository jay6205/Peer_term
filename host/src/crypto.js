/**
 * PeerTerm — Encryption Helpers (Host-side)
 * 
 * Implements ECDH P-256 key exchange and AES-256-GCM encryption/decryption
 * using Node.js crypto.webcrypto (SubtleCrypto API).
 * 
 * Encryption spec:
 *   - Key exchange: ECDH with P-256 curve
 *   - Derived key: AES-GCM, 256-bit, extractable: false
 *   - Per message: 12-byte random IV prepended to ciphertext, encoded as base64
 */

import { webcrypto } from 'crypto';
const subtle = webcrypto.subtle;

// ─── Key Pair Generation ─────────────────────────────────────────────────────

/**
 * Generate an ephemeral ECDH P-256 key pair.
 * Returns { publicKey, privateKey } as CryptoKey objects.
 */
export async function generateKeyPair() {
  return await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // not extractable (private key stays in memory)
    ['deriveKey']
  );
}

// ─── Public Key Export / Import ──────────────────────────────────────────────

/**
 * Export a public CryptoKey to a base64 string (raw format).
 * This is what gets sent over the wire to the peer.
 */
export async function exportPublicKey(publicKey) {
  const raw = await subtle.exportKey('raw', publicKey);
  return Buffer.from(raw).toString('base64');
}

/**
 * Import a peer's public key from a base64 string.
 * Returns a CryptoKey suitable for ECDH key derivation.
 */
export async function importPublicKey(base64) {
  const raw = Buffer.from(base64, 'base64');
  return await subtle.importKey(
    'raw',
    raw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

// ─── Shared Key Derivation ──────────────────────────────────────────────────

/**
 * Derive a shared AES-256-GCM key from our private key and the peer's public key.
 * Both sides independently derive the same key (ECDH magic).
 * 
 * The derived key is:
 *   - Algorithm: AES-GCM
 *   - Length: 256 bits
 *   - Extractable: false (cannot be exported, only used for encrypt/decrypt)
 *   - Usages: ['encrypt', 'decrypt']
 */
export async function deriveSharedKey(privateKey, peerPublicKey) {
  return await subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable
    ['encrypt', 'decrypt']
  );
}

/**
 * Compute the short authentication string shown to both users.
 * The relay can forward keys, but it cannot make a MITM split produce the same
 * fingerprint on both sides unless the users skip the out-of-band comparison.
 */
export async function fingerprintPublicKeys(sessionCode, hostPublicKeyBase64, clientPublicKeyBase64) {
  const transcript = [
    'PeerTerm SAS v1',
    String(sessionCode || ''),
    String(hostPublicKeyBase64 || ''),
    String(clientPublicKeyBase64 || ''),
  ].join('\n');

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(transcript));
  const hex = Buffer.from(digest).toString('hex').toUpperCase().slice(0, 16);
  return hex.match(/.{1,4}/g).join('-');
}

// ─── Encryption ─────────────────────────────────────────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM.
 * 
 * Steps:
 *   1. Generate a random 12-byte IV
 *   2. Encrypt the plaintext with AES-GCM using the shared key and IV
 *   3. Concatenate [IV (12 bytes) + ciphertext]
 *   4. Encode the result as a base64 string
 * 
 * @param {CryptoKey} sharedKey - The derived AES-GCM key
 * @param {string} plaintext - The data to encrypt
 * @returns {string} base64-encoded IV + ciphertext
 */
export async function encrypt(sharedKey, plaintext) {
  // 1. Fresh random IV for every message (critical for AES-GCM security)
  const iv = webcrypto.getRandomValues(new Uint8Array(12));

  // 2. Encrypt
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    encoded
  );

  // 3. Concatenate IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // 4. Encode as base64
  return Buffer.from(combined).toString('base64');
}

// ─── Decryption ─────────────────────────────────────────────────────────────

/**
 * Decrypt a base64-encoded AES-GCM message.
 * 
 * Steps:
 *   1. Base64 decode the input
 *   2. Split: first 12 bytes = IV, rest = ciphertext
 *   3. Decrypt with AES-GCM
 *   4. Return plaintext string
 * 
 * @param {CryptoKey} sharedKey - The derived AES-GCM key
 * @param {string} base64data - The encrypted message (IV + ciphertext in base64)
 * @returns {string} Decrypted plaintext
 */
export async function decrypt(sharedKey, base64data) {
  // 1. Base64 decode
  const combined = Buffer.from(base64data, 'base64');

  // 2. Split IV and ciphertext
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // 3. Decrypt
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    ciphertext
  );

  // 4. Return as string
  return new TextDecoder().decode(plaintext);
}

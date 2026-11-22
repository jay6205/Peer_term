/**
 * Tests for host/src/crypto.js
 *
 * Covers: key pair generation, public key export/import round-trip,
 * shared key derivation (both sides match), encrypt ↔ decrypt, IV
 * uniqueness, fingerprint determinism and channel-binding, and
 * tampered-ciphertext rejection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  fingerprintPublicKeys,
  encrypt,
  decrypt,
} from '../src/crypto.js';

// ─── Key Generation ──────────────────────────────────────────────────────────

describe('generateKeyPair', () => {
  it('returns an object with publicKey and privateKey', async () => {
    const kp = await generateKeyPair();
    assert.ok('publicKey' in kp);
    assert.ok('privateKey' in kp);
  });

  it('generates distinct key pairs each time', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const pubA = await exportPublicKey(a.publicKey);
    const pubB = await exportPublicKey(b.publicKey);
    assert.notStrictEqual(pubA, pubB);
  });
});

// ─── Public Key Export / Import ──────────────────────────────────────────────

describe('exportPublicKey / importPublicKey', () => {
  it('round-trips a public key through base64', async () => {
    const kp = await generateKeyPair();
    const exported = await exportPublicKey(kp.publicKey);
    assert.strictEqual(typeof exported, 'string');
    assert.ok(exported.length > 0);

    // Import should not throw
    const imported = await importPublicKey(exported);
    assert.ok(imported);
  });

  it('exported base64 is valid base64 (65-byte uncompressed P-256 key)', async () => {
    const kp = await generateKeyPair();
    const exported = await exportPublicKey(kp.publicKey);
    const buf = Buffer.from(exported, 'base64');
    assert.strictEqual(buf.length, 65);
  });
});

// ─── Shared Key Derivation ──────────────────────────────────────────────────

describe('deriveSharedKey', () => {
  it('both sides derive the same shared key', async () => {
    const host = await generateKeyPair();
    const client = await generateKeyPair();

    const hostPub = await exportPublicKey(host.publicKey);
    const clientPub = await exportPublicKey(client.publicKey);

    const hostShared = await deriveSharedKey(
      host.privateKey,
      await importPublicKey(clientPub)
    );
    const clientShared = await deriveSharedKey(
      client.privateKey,
      await importPublicKey(hostPub)
    );

    // Encrypt with one, decrypt with the other
    const plaintext = 'Hello from host';
    const ct = await encrypt(hostShared, plaintext);
    const pt = await decrypt(clientShared, ct);
    assert.strictEqual(pt, plaintext);
  });
});

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────────

describe('encrypt / decrypt', () => {
  let sharedKey;

  async function getKey() {
    if (sharedKey) return sharedKey;
    const host = await generateKeyPair();
    const client = await generateKeyPair();
    const clientPub = await exportPublicKey(client.publicKey);
    sharedKey = await deriveSharedKey(
      host.privateKey,
      await importPublicKey(clientPub)
    );
    return sharedKey;
  }

  it('round-trips plaintext', async () => {
    const key = await getKey();
    const msg = 'terminal output data';
    const ct = await encrypt(key, msg);
    assert.strictEqual(typeof ct, 'string');
    const pt = await decrypt(key, ct);
    assert.strictEqual(pt, msg);
  });

  it('handles empty string', async () => {
    const key = await getKey();
    const ct = await encrypt(key, '');
    const pt = await decrypt(key, ct);
    assert.strictEqual(pt, '');
  });

  it('handles unicode / multi-byte characters', async () => {
    const key = await getKey();
    const msg = '日本語テスト 🚀 émojis';
    const ct = await encrypt(key, msg);
    const pt = await decrypt(key, ct);
    assert.strictEqual(pt, msg);
  });

  it('produces unique ciphertext per call (unique IV)', async () => {
    const key = await getKey();
    const msg = 'same message';
    const ct1 = await encrypt(key, msg);
    const ct2 = await encrypt(key, msg);
    assert.notStrictEqual(ct1, ct2);
  });

  it('ciphertext is base64-encoded with 12-byte IV prefix', async () => {
    const key = await getKey();
    const ct = await encrypt(key, 'test');
    const raw = Buffer.from(ct, 'base64');
    assert.ok(raw.length >= 32);
  });

  it('rejects tampered ciphertext', async () => {
    const key = await getKey();
    const ct = await encrypt(key, 'secret');
    const raw = Buffer.from(ct, 'base64');
    raw[14] ^= 0xff;
    const tampered = raw.toString('base64');
    await assert.rejects(async () => {
      await decrypt(key, tampered);
    });
  });
});

// ─── Fingerprint ────────────────────────────────────────────────────────────

describe('fingerprintPublicKeys', () => {
  it('returns a formatted 4-group hex string', async () => {
    const fp = await fingerprintPublicKeys('123456', 'hostPub', 'clientPub');
    assert.match(fp, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const fp1 = await fingerprintPublicKeys('123456', 'A', 'B');
    const fp2 = await fingerprintPublicKeys('123456', 'A', 'B');
    assert.strictEqual(fp1, fp2);
  });

  it('changes when session code changes', async () => {
    const fp1 = await fingerprintPublicKeys('111111', 'A', 'B');
    const fp2 = await fingerprintPublicKeys('222222', 'A', 'B');
    assert.notStrictEqual(fp1, fp2);
  });

  it('changes when either public key changes', async () => {
    const base = await fingerprintPublicKeys('123456', 'A', 'B');
    const diffHost = await fingerprintPublicKeys('123456', 'X', 'B');
    const diffClient = await fingerprintPublicKeys('123456', 'A', 'X');
    assert.notStrictEqual(base, diffHost);
    assert.notStrictEqual(base, diffClient);
  });
});

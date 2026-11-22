/**
 * Tests for client-side helper functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── bytesToBase64 / base64ToBytes (client/app.js) ───────────────────────────

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

describe('bytesToBase64 / base64ToBytes', () => {
  it('round-trips small data', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = bytesToBase64(original);
    const result = base64ToBytes(b64);
    assert.deepStrictEqual(result, original);
  });

  it('round-trips empty data', () => {
    const original = new Uint8Array(0);
    const b64 = bytesToBase64(original);
    assert.strictEqual(b64, '');
    const result = base64ToBytes(b64);
    assert.deepStrictEqual(result, original);
  });

  it('handles data larger than chunk size (8192 bytes)', () => {
    const size = 20000;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      original[i] = i % 256;
    }
    const b64 = bytesToBase64(original);
    const result = base64ToBytes(b64);
    assert.deepStrictEqual(result, original);
  });

  it('handles data exactly at chunk boundary', () => {
    const original = new Uint8Array(8192);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const b64 = bytesToBase64(original);
    const result = base64ToBytes(b64);
    assert.deepStrictEqual(result, original);
  });

  it('handles ArrayBuffer input', () => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    const b64 = bytesToBase64(buf);
    const result = base64ToBytes(b64);
    assert.deepStrictEqual(result, new Uint8Array([1, 2, 3, 4]));
  });
});

// ─── isHostCandidate (client/app.js) ─────────────────────────────────────────

const LOCAL_IP_REGEX = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

function isHostCandidate(candidateStr) {
  if (!candidateStr) return false;
  const typMatch = candidateStr.match(/typ\s+(\S+)/);
  if (!typMatch) return false;
  if (typMatch[1] !== 'host') return false;
  const ipMatch = candidateStr.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (ipMatch && LOCAL_IP_REGEX.test(ipMatch[1])) return true;
  if (candidateStr.includes('fe80::')) return true;
  return true;
}

describe('isHostCandidate', () => {
  it('returns true for private IPv4 host candidates', () => {
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 2122260223 192.168.1.100 12345 typ host'), true);
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 2122260223 10.0.0.5 12345 typ host'), true);
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 2122260223 172.16.0.1 12345 typ host'), true);
  });

  it('returns true for IPv6 link-local host candidates', () => {
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 2122260223 fe80::1 12345 typ host'), true);
  });

  it('returns false for srflx candidates', () => {
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 1686052607 203.0.113.1 12345 typ srflx'), false);
  });

  it('returns false for relay candidates', () => {
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 41885439 203.0.113.1 12345 typ relay'), false);
  });

  it('returns false for null/empty', () => {
    assert.strictEqual(isHostCandidate(null), false);
    assert.strictEqual(isHostCandidate(''), false);
    assert.strictEqual(isHostCandidate(undefined), false);
  });

  it('returns false for strings without typ', () => {
    assert.strictEqual(isHostCandidate('candidate:1 1 udp 2122260223 192.168.1.1 12345'), false);
  });
});

// ─── formatElapsed (client/app.js) ───────────────────────────────────────────

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

describe('formatElapsed', () => {
  it('formats zero', () => {
    assert.strictEqual(formatElapsed(0), '00:00');
  });

  it('formats seconds', () => {
    assert.strictEqual(formatElapsed(5000), '00:05');
    assert.strictEqual(formatElapsed(59000), '00:59');
  });

  it('formats minutes', () => {
    assert.strictEqual(formatElapsed(60000), '01:00');
    assert.strictEqual(formatElapsed(90000), '01:30');
  });

  it('formats hours', () => {
    assert.strictEqual(formatElapsed(3600000), '01:00:00');
    assert.strictEqual(formatElapsed(3661000), '01:01:01');
  });
});

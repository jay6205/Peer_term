/**
 * Tests for relay server helper functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── parsePositiveInt (extracted from relay/server.js) ───────────────────────

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

describe('parsePositiveInt', () => {
  it('parses valid positive integers', () => {
    assert.strictEqual(parsePositiveInt('500', 100), 500);
    assert.strictEqual(parsePositiveInt('1', 100), 1);
    assert.strictEqual(parsePositiveInt('9999', 100), 9999);
  });

  it('returns fallback for zero', () => {
    assert.strictEqual(parsePositiveInt('0', 100), 100);
  });

  it('returns fallback for negative numbers', () => {
    assert.strictEqual(parsePositiveInt('-5', 100), 100);
  });

  it('returns fallback for non-numeric strings', () => {
    assert.strictEqual(parsePositiveInt('abc', 100), 100);
    assert.strictEqual(parsePositiveInt('', 100), 100);
  });

  it('returns fallback for undefined/null', () => {
    assert.strictEqual(parsePositiveInt(undefined, 100), 100);
    assert.strictEqual(parsePositiveInt(null, 100), 100);
  });

  it('truncates floats to integer part', () => {
    assert.strictEqual(parsePositiveInt('3.9', 100), 3);
  });
});

// ─── CIDR / IP matching logic (relay trusted proxy) ──────────────────────────

function ipInCIDR(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  const [subnet, bits] = cidr.split('/');
  const mask = (-1 << (32 - parseInt(bits))) >>> 0;
  const ipNum = ipToNumber(subnet);
  const targetNum = ipToNumber(ip);
  if (ipNum === null || targetNum === null) return false;
  return (ipNum & mask) === (targetNum & mask);
}

function ipToNumber(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

describe('ipInCIDR', () => {
  it('matches exact IPs', () => {
    assert.strictEqual(ipInCIDR('127.0.0.1', '127.0.0.1'), true);
    assert.strictEqual(ipInCIDR('127.0.0.2', '127.0.0.1'), false);
  });

  it('matches RFC1918 ranges', () => {
    assert.strictEqual(ipInCIDR('10.0.0.1', '10.0.0.0/8'), true);
    assert.strictEqual(ipInCIDR('10.255.255.255', '10.0.0.0/8'), true);
    assert.strictEqual(ipInCIDR('11.0.0.1', '10.0.0.0/8'), false);

    assert.strictEqual(ipInCIDR('192.168.1.100', '192.168.0.0/16'), true);
    assert.strictEqual(ipInCIDR('192.169.1.100', '192.168.0.0/16'), false);

    assert.strictEqual(ipInCIDR('172.16.0.1', '172.16.0.0/12'), true);
    assert.strictEqual(ipInCIDR('172.31.255.255', '172.16.0.0/12'), true);
    assert.strictEqual(ipInCIDR('172.32.0.1', '172.16.0.0/12'), false);
  });

  it('handles /32 as exact match', () => {
    assert.strictEqual(ipInCIDR('1.2.3.4', '1.2.3.4/32'), true);
    assert.strictEqual(ipInCIDR('1.2.3.5', '1.2.3.4/32'), false);
  });
});

// ─── Session code generation ─────────────────────────────────────────────────

describe('session code format', () => {
  it('6-digit codes are always 6 characters of digits', () => {
    for (let i = 0; i < 50; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      assert.match(code, /^\d{6}$/);
      assert.ok(parseInt(code) >= 100000);
      assert.ok(parseInt(code) <= 999999);
    }
  });
});

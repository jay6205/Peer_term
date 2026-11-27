/**
 * Tests for relay server helper functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePositiveInt,
  clampDuration,
  generateSessionCode,
  resolveTrustedProxies,
  parseCIDR,
  ipv4ToInt,
  isTrustedProxy,
  getClientIp,
} from '../helpers.js';

// ─── parsePositiveInt ────────────────────────────────────────────────────────

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

const ipInCIDR = (ip, cidr) => isTrustedProxy(ip, [cidr]);

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

  it('parseCIDR and ipv4ToInt handle invalid inputs', () => {
    assert.strictEqual(parseCIDR('invalid'), null);
    assert.strictEqual(parseCIDR(123), null);
    assert.strictEqual(parseCIDR('256.0.0.0/8'), null);
    assert.strictEqual(parseCIDR('10.0.0.0/33'), null);
    assert.strictEqual(ipv4ToInt('not-an-ip'), null);
    assert.strictEqual(ipv4ToInt(null), null);
  });
});

// ─── Session code generation ─────────────────────────────────────────────────

describe('session code format', () => {
  it('6-digit codes are always 6 characters of digits', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateSessionCode();
      assert.match(code, /^\d{6}$/);
      assert.ok(parseInt(code) >= 100000);
      assert.ok(parseInt(code) <= 999999);
    }
  });
});

// ─── clampDuration ───────────────────────────────────────────────────────────

describe('clampDuration', () => {
  it('clamps duration to maxMs', () => {
    assert.strictEqual(clampDuration(10000, 5000, 8000), 8000);
  });

  it('preserves valid durations within bounds', () => {
    assert.strictEqual(clampDuration(6000, 5000, 8000), 6000);
  });

  it('falls back to defaultMs for invalid or non-positive durations', () => {
    assert.strictEqual(clampDuration(0, 5000, 8000), 5000);
    assert.strictEqual(clampDuration(-100, 5000, 8000), 5000);
    assert.strictEqual(clampDuration('fast', 5000, 8000), 5000);
    assert.strictEqual(clampDuration(NaN, 5000, 8000), 5000);
  });
});

// ─── Trusted proxy configuration & client IP resolution ─────────────────────

describe('trusted proxy configuration and IP resolution', () => {
  it('defaults to loopback only in non-production environments', () => {
    const proxies = resolveTrustedProxies(undefined, 'development');
    assert.deepStrictEqual(proxies, ['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  });

  it('requires explicit TRUSTED_PROXIES in production (defaults to empty)', () => {
    const proxies = resolveTrustedProxies(undefined, 'production');
    assert.deepStrictEqual(proxies, []);
  });

  it('parses explicit TRUSTED_PROXIES across environments', () => {
    const proxiesProd = resolveTrustedProxies('10.0.0.1, 192.168.1.0/24', 'production');
    assert.deepStrictEqual(proxiesProd, ['10.0.0.1', '192.168.1.0/24']);

    const proxiesDev = resolveTrustedProxies('127.0.0.1, 172.16.0.0/12', 'development');
    assert.deepStrictEqual(proxiesDev, ['127.0.0.1', '172.16.0.0/12']);
  });

  it('handles empty or whitespace-only TRUSTED_PROXIES', () => {
    assert.deepStrictEqual(resolveTrustedProxies('', 'development'), []);
    assert.deepStrictEqual(resolveTrustedProxies('   ', 'production'), []);
  });

  it('does not trust RFC1918 private ranges by default in development', () => {
    const devProxies = resolveTrustedProxies(undefined, 'development');
    assert.strictEqual(isTrustedProxy('127.0.0.1', devProxies), true);
    assert.strictEqual(isTrustedProxy('::1', devProxies), true);
    assert.strictEqual(isTrustedProxy('::ffff:127.0.0.1', devProxies), true);

    // Private RFC1918 ranges must NOT be trusted by default
    assert.strictEqual(isTrustedProxy('10.0.0.1', devProxies), false);
    assert.strictEqual(isTrustedProxy('172.16.0.1', devProxies), false);
    assert.strictEqual(isTrustedProxy('192.168.1.1', devProxies), false);
  });

  it('trusts nothing by default in production', () => {
    const prodProxies = resolveTrustedProxies(undefined, 'production');
    assert.strictEqual(isTrustedProxy('127.0.0.1', prodProxies), false);
    assert.strictEqual(isTrustedProxy('10.0.0.1', prodProxies), false);
    assert.strictEqual(isTrustedProxy('192.168.1.1', prodProxies), false);
  });

  it('getClientIp extracts forwarded IP only from trusted proxies', () => {
    const devProxies = resolveTrustedProxies(undefined, 'development');

    // Trusted loopback connection -> X-Forwarded-For trusted
    const trustedReq = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.195, 127.0.0.1' },
    };
    assert.strictEqual(getClientIp(trustedReq, devProxies), '203.0.113.195');

    // Untrusted connection (e.g. internal network attempting spoof) -> direct remoteAddress used
    const untrustedReq = {
      socket: { remoteAddress: '10.0.0.5' },
      headers: { 'x-forwarded-for': '203.0.113.195' },
    };
    assert.strictEqual(getClientIp(untrustedReq, devProxies), '10.0.0.5');

    // Production without TRUSTED_PROXIES -> loopback is also untrusted
    const prodProxies = resolveTrustedProxies(undefined, 'production');
    assert.strictEqual(getClientIp(trustedReq, prodProxies), '127.0.0.1');
  });
});

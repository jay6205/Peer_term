/**
 * Pure helper functions for PeerTerm Relay Server.
 */

import crypto from 'crypto';

/**
 * Parse a positive integer with fallback.
 */
export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Clamp a numeric duration between default and maximum.
 */
export function clampDuration(value, defaultMs, maxMs) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultMs;
  return Math.min(value, maxMs);
}

/**
 * Generate a random 6-digit session code string.
 */
export function generateSessionCode() {
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Resolve trusted proxies from environment variables.
 * In production (NODE_ENV === 'production'), requires explicit TRUSTED_PROXIES (defaults to none).
 * In development/test, defaults to loopback only.
 * RFC 1918 private ranges are NOT trusted by default to prevent IP spoofing.
 */
export function resolveTrustedProxies(envValue = process.env.TRUSTED_PROXIES, nodeEnv = process.env.NODE_ENV) {
  if (typeof envValue === 'string') {
    const trimmed = envValue.trim();
    if (trimmed) {
      return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  }
  if (nodeEnv === 'production') {
    return [];
  }
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
}

/**
 * Parse a CIDR string into { subnet, prefixLen } for IPv4.
 * Returns null for non-CIDR plain IPs or invalid input.
 */
export function parseCIDR(cidr) {
  if (typeof cidr !== 'string') return null;
  const match = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!match) return null;
  const parts = match[1].split('.').map(Number);
  const prefixLen = Number(match[2]);
  if (parts.some(p => p < 0 || p > 255) || prefixLen < 0 || prefixLen > 32) return null;
  const subnet = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
  return { subnet, prefixLen };
}

/**
 * Convert an IPv4 string to a 32-bit unsigned integer.
 * Handles ::ffff: mapped addresses.
 */
export function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const mapped = ip.replace(/^::ffff:/, '');
  const parts = mapped.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return null;
  return (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
}

/**
 * Check whether `ip` matches any entry in `proxies`.
 * Supports exact match and IPv4 CIDR notation.
 */
export function isTrustedProxy(ip, proxies = []) {
  if (!ip || !Array.isArray(proxies) || proxies.length === 0) return false;
  const normalised = ip.replace(/^::ffff:/, '');
  for (const entry of proxies) {
    // Exact match (handles IPv6 loopback and plain addresses)
    if (entry === ip || entry === normalised) return true;

    // CIDR match (IPv4 only)
    const cidr = parseCIDR(entry);
    if (cidr) {
      const ipInt = ipv4ToInt(ip);
      if (ipInt !== null) {
        const mask = cidr.prefixLen === 0 ? 0 : (~0 << (32 - cidr.prefixLen)) >>> 0;
        if ((ipInt & mask) === (cidr.subnet & mask)) return true;
      }
    }
  }
  return false;
}

/**
 * Extract the real client IP from a request.
 * Only trusts X-Forwarded-For when direct connection comes from a recognized proxy address.
 */
export function getClientIp(req, proxies = []) {
  const directIp = req.socket?.remoteAddress || 'unknown';

  if (isTrustedProxy(directIp, proxies)) {
    const forwardedFor = req.headers?.['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      // Take the left-most (original client) address
      return forwardedFor.split(',')[0].trim();
    }
  }

  return directIp;
}

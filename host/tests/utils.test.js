/**
 * Tests for host/src/utils.js
 *
 * Covers: parseDuration, formatDuration, expandTilde, detectShell.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, expandTilde, detectShell } from '../src/utils.js';

// ─── parseDuration ───────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses seconds', () => {
    assert.strictEqual(parseDuration('30s'), 30_000);
    assert.strictEqual(parseDuration('1s'), 1_000);
    assert.strictEqual(parseDuration('0s'), 0);
  });

  it('parses minutes', () => {
    assert.strictEqual(parseDuration('5m'), 300_000);
    assert.strictEqual(parseDuration('1m'), 60_000);
  });

  it('parses hours', () => {
    assert.strictEqual(parseDuration('1h'), 3_600_000);
    assert.strictEqual(parseDuration('24h'), 86_400_000);
  });

  it('is case-insensitive', () => {
    assert.strictEqual(parseDuration('5M'), 300_000);
    assert.strictEqual(parseDuration('1H'), 3_600_000);
    assert.strictEqual(parseDuration('10S'), 10_000);
  });

  it('returns null for invalid input', () => {
    assert.strictEqual(parseDuration(''), null);
    assert.strictEqual(parseDuration('abc'), null);
    assert.strictEqual(parseDuration('5'), null);
    assert.strictEqual(parseDuration('5x'), null);
    assert.strictEqual(parseDuration('m5'), null);
    assert.strictEqual(parseDuration('-5s'), null);
    assert.strictEqual(parseDuration('5.5s'), null);
  });
});

// ─── formatDuration ──────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats hours', () => {
    assert.strictEqual(formatDuration(3_600_000), '1 hour(s)');
    assert.strictEqual(formatDuration(7_200_000), '2 hour(s)');
  });

  it('formats minutes', () => {
    assert.strictEqual(formatDuration(60_000), '1 minute(s)');
    assert.strictEqual(formatDuration(300_000), '5 minute(s)');
  });

  it('formats seconds for values under a minute', () => {
    assert.strictEqual(formatDuration(5_000), '5 second(s)');
    assert.strictEqual(formatDuration(1_000), '1 second(s)');
    assert.strictEqual(formatDuration(500), '1 second(s)');
  });
});

// ─── expandTilde ─────────────────────────────────────────────────────────────

describe('expandTilde', () => {
  it('expands ~/path using HOME or USERPROFILE', () => {
    const original = process.env.HOME || process.env.USERPROFILE || '.';
    const result = expandTilde('~/projects');
    assert.strictEqual(result, `${original}/projects`);
  });

  it('expands bare ~', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    assert.strictEqual(expandTilde('~'), home);
  });

  it('leaves absolute paths untouched', () => {
    assert.strictEqual(expandTilde('/usr/local/bin'), '/usr/local/bin');
  });

  it('leaves relative paths untouched', () => {
    assert.strictEqual(expandTilde('foo/bar'), 'foo/bar');
  });

  it('leaves paths starting with ~user untouched (not ~/)', () => {
    assert.strictEqual(expandTilde('~other/dir'), '~other/dir');
  });
});

// ─── detectShell ─────────────────────────────────────────────────────────────

describe('detectShell', () => {
  it('returns a non-empty string', () => {
    const shell = detectShell();
    assert.strictEqual(typeof shell, 'string');
    assert.ok(shell.length > 0);
  });
});

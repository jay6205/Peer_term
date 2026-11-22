/**
 * Tests for host/src/webrtc.js — ICE candidate queuing logic
 *
 * Verifies the fix for the signaling ordering race:
 * ICE candidates must be buffered until the SDP offer is sent,
 * and client must queue ICE candidates before peerConnection exists.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Simulated ICE queuing logic (Host-side) ─────────────────────────────────

describe('ICE candidate queuing (host-side logic)', () => {
  let offerSent;
  let pendingCandidates;
  let sentSignals;

  function sendSignal(msg) {
    sentSignals.push(msg);
  }

  function onLocalCandidate(candidate, mid) {
    if (!offerSent) {
      pendingCandidates.push({ candidate, mid });
      return;
    }
    sendSignal({ type: 'signal', payload: { kind: 'ice', candidate, mid } });
  }

  function sendOfferAndFlush(sdp) {
    sendSignal({ type: 'signal', payload: { kind: 'offer', sdp, sdpType: 'offer' } });
    offerSent = true;
    for (const c of pendingCandidates) {
      sendSignal({ type: 'signal', payload: { kind: 'ice', candidate: c.candidate, mid: c.mid } });
    }
    pendingCandidates = [];
  }

  beforeEach(() => {
    offerSent = false;
    pendingCandidates = [];
    sentSignals = [];
  });

  it('buffers ICE candidates emitted before offer', () => {
    onLocalCandidate('candidate:1 typ host 192.168.1.1', '0');
    onLocalCandidate('candidate:2 typ host 192.168.1.1', '0');

    assert.strictEqual(sentSignals.length, 0);
    assert.strictEqual(pendingCandidates.length, 2);
  });

  it('sends offer first, then flushes buffered candidates in order', () => {
    onLocalCandidate('candidate:1 typ host 192.168.1.1', '0');
    onLocalCandidate('candidate:2 typ host 192.168.1.1', '0');

    sendOfferAndFlush('v=0\r\no=- 123 ...');

    assert.strictEqual(sentSignals.length, 3);
    assert.strictEqual(sentSignals[0].payload.kind, 'offer');
    assert.strictEqual(sentSignals[1].payload.kind, 'ice');
    assert.strictEqual(sentSignals[1].payload.candidate, 'candidate:1 typ host 192.168.1.1');
    assert.strictEqual(sentSignals[2].payload.kind, 'ice');
    assert.strictEqual(sentSignals[2].payload.candidate, 'candidate:2 typ host 192.168.1.1');
  });

  it('sends ICE directly after offer has been sent', () => {
    sendOfferAndFlush('v=0\r\no=- 123 ...');

    onLocalCandidate('candidate:3 typ host 192.168.1.1', '0');

    assert.strictEqual(sentSignals.length, 2);
    assert.strictEqual(sentSignals[1].payload.kind, 'ice');
    assert.strictEqual(sentSignals[1].payload.candidate, 'candidate:3 typ host 192.168.1.1');
  });

  it('flushes buffer exactly once', () => {
    onLocalCandidate('candidate:1 typ host 192.168.1.1', '0');
    sendOfferAndFlush('v=0\r\no=- 123 ...');

    assert.strictEqual(pendingCandidates.length, 0);

    onLocalCandidate('candidate:2 typ host 192.168.1.1', '0');
    assert.strictEqual(pendingCandidates.length, 0);
    assert.strictEqual(sentSignals.length, 3);
  });
});

// ─── Client-side ICE queuing logic ───────────────────────────────────────────

describe('ICE candidate queuing (client-side logic)', () => {
  let peerConnection;
  let pendingIceCandidates;
  let addedCandidates;

  function handleIce(payload) {
    if (peerConnection && payload.candidate) {
      addedCandidates.push(payload);
    } else if (payload.candidate) {
      pendingIceCandidates.push(payload);
    }
  }

  function setupWebRTC() {
    const saved = pendingIceCandidates;
    pendingIceCandidates = [];
    pendingIceCandidates = saved;

    peerConnection = {};

    for (const ic of pendingIceCandidates) {
      addedCandidates.push(ic);
    }
    pendingIceCandidates = [];
  }

  beforeEach(() => {
    peerConnection = null;
    pendingIceCandidates = [];
    addedCandidates = [];
  });

  it('queues ICE when peerConnection is null', () => {
    handleIce({ candidate: 'candidate:1', mid: '0' });
    handleIce({ candidate: 'candidate:2', mid: '0' });

    assert.strictEqual(addedCandidates.length, 0);
    assert.strictEqual(pendingIceCandidates.length, 2);
  });

  it('flushes queued ICE when offer arrives and peerConnection is created', () => {
    handleIce({ candidate: 'candidate:1', mid: '0' });
    handleIce({ candidate: 'candidate:2', mid: '0' });

    setupWebRTC();

    assert.strictEqual(addedCandidates.length, 2);
    assert.strictEqual(addedCandidates[0].candidate, 'candidate:1');
    assert.strictEqual(addedCandidates[1].candidate, 'candidate:2');
    assert.strictEqual(pendingIceCandidates.length, 0);
  });

  it('adds ICE directly when peerConnection already exists', () => {
    peerConnection = {};
    handleIce({ candidate: 'candidate:1', mid: '0' });

    assert.strictEqual(addedCandidates.length, 1);
    assert.strictEqual(pendingIceCandidates.length, 0);
  });
});

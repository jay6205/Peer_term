# PeerTerm — Product Requirements Document

## Overview

PeerTerm is an open-source terminal sharing tool that lets you share your terminal with anyone using a 6-digit code. All data is end-to-end encrypted. No configuration required.

---

## Phase 1 — Foundation

**Goal**: Establish the core architecture.

- WebSocket relay server with HTTP serving
- 6-digit session code generation (cryptographically random)
- Host agent spawns PTY and connects to relay
- Browser client connects via code and renders terminal with xterm.js
- Plain WebSocket forwarding (no encryption yet)

## Phase 2 — Security

**Goal**: End-to-end encryption and session lifecycle.

- ECDH P-256 key exchange between host and client
- AES-256-GCM encryption for all terminal data (12-byte random IV per message)
- Session expiry with configurable TTL (`--expiry` flag)
- Client disconnect/rejoin window (2 minutes)
- Heartbeat mechanism for connection liveness
- Rate limiting on code attempts (5 failures → 60s block)
- Relay never sees plaintext — only forwards base64 blobs

## Phase 3 — Features

**Goal**: Production-quality user experience.

- Terminal resize propagation (host ↔ client)
- Read-only mode (`--readonly` flag)
- Browser clipboard support (copy/paste)
- Mobile-optimized keyboard and zoom handling
- Persistent connection indicator in browser UI
- Multi-session host CLI (create, list, kill sessions)

## Phase 4 — Local P2P

**Goal**: Bypass relay for same-LAN connections.

- WebRTC DataChannel for direct P2P terminal data transfer
- ICE candidate analysis for same-LAN detection
- Automatic fallback to relay if P2P fails
- Encrypted signaling (ICE candidates and SDP encrypted with shared key)
- Zero STUN/TURN — only local candidates for privacy

## Phase 5 — Distribution

**Goal**: Make PeerTerm installable and deployable.

- Polished CLI output (ASCII banner, session code box, structured logging)
- npm package (`npx peer-term` works out of the box)
- Single binary builds via `@yao-pkg/pkg` (Linux, macOS, Windows)
- Relay server Dockerized and deployable to Railway/Render/Fly.io
- Client hostable on GitHub Pages or Vercel
- GitHub Actions workflow for automated release builds
- Comprehensive README with setup instructions

---

## Architecture

```
┌──────────┐       WebSocket        ┌──────────────┐       WebSocket       ┌──────────┐
│   Host   │ ◄───────────────────► │  Relay Server │ ◄──────────────────► │  Client  │
│  (CLI)   │   encrypted blobs     │  (Node.js)    │   encrypted blobs    │ (Browser) │
│          │                        │               │                      │           │
│  node-pty│   ┌─ WebRTC P2P ─┐   │  Never reads  │                      │  xterm.js │
│  crypto  │   │  DataChannel  │   │  plaintext    │                      │  WebCrypto│
└──────────┘   └───────────────┘   └──────────────┘                      └──────────┘
                  (same LAN only)
```

## Encryption Spec

| Component | Algorithm |
|---|---|
| Key Exchange | ECDH with P-256 curve |
| Data Encryption | AES-GCM, 256-bit key |
| IV | 12 bytes, random per message |
| Wire Format | Base64(IV + ciphertext) |
| Key Extractable | No (CryptoKey stays in memory) |

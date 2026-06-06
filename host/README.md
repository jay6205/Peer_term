# PeerTerm

Share your terminal instantly over WebRTC using a 6-digit code. Fully end-to-end encrypted. No configuration or accounts required.

## Quick Start

You don't even need to install it. Just run:

```bash
npx peer-term
```

This will start a terminal sharing session and give you a 6-digit code.

Share this code with your peer. They can view your terminal by going to https://peer-term-relay-production-9b7a.up.railway.app or https://peer-term-relay.onrender.com and entering the code.

## Global Installation

If you prefer to install it globally:

```bash
npm install -g peer-term
```

Then you can just run:

```bash
peer-term
```

## Usage

```bash
peer-term                              # starts at home directory
peer-term --path ~/projects            # starts at ~/projects
peer-term --path .                     # starts in current directory
peer-term --readonly                   # view-only session
peer-term --secure                     # require fingerprint verification
peer-term --expiry 10m                 # custom expiry time
peer-term --relay wss://custom         # use a custom relay server
peer-term --verbose                    # enable debug logging
```

## Features

- **No Config**: Works instantly. No port forwarding or firewall configuration needed.
- **End-to-End Encrypted**: Terminal data is encrypted locally using AES-256-GCM with ECDH P-256 key exchange. The relay never sees plaintext. A `--secure` flag enables an out-of-band fingerprint check for strict MITM protection.
- **WebRTC P2P**: Creates a direct Peer-to-Peer connection on the same LAN for zero-latency, relay-free sessions.
- **Read-Only Mode**: Guests can view your terminal but cannot type commands.
- **File Uploads**: Clients can drag-and-drop to securely upload files directly to `~/peerterm-uploads/` on the host machine. Fully encrypted end-to-end.
- **Custom Start Path**: Set the starting directory with `--path`.
- **Resilient Connections**: Both host and client get a 2-minute rejoin window if their IP changes or connection drops. PTY state is fully preserved — no session restart needed.
- **Multi-Session**: Manage multiple simultaneous sessions with the interactive CLI menu.

## How It Works

1. **Host** registers a session on the relay and gets a 6-digit code
2. **Client** opens the web UI and enters the code
3. Both sides perform an **ECDH key exchange** to derive a shared AES-256-GCM secret
4. If `--secure` is used, both sides compare a short fingerprint, then the host authorizes the verified session with `a <code>`
5. All terminal I/O is encrypted end-to-end — the relay only forwards opaque blobs
6. If both peers are on the same LAN, a **WebRTC DataChannel** is established to bypass the relay entirely

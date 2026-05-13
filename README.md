## PeerTerm

Share your terminal with anyone using a 6-digit code. No config. Encrypted.

---

## Features

### Instant Sharing
Run a single command, get a 6-digit code. Share the code — the other person opens a browser and they're in. No port forwarding, no SSH keys, no accounts, no signup.

### End-to-End Encrypted
Every keystroke and every byte of terminal output is encrypted with **AES-256-GCM**. Keys are exchanged using **ECDH P-256** — the relay server only sees ciphertext. Even the WebRTC signaling metadata (ICE candidates, SDP) is encrypted.

### Works Everywhere
The host runs as a Node.js CLI or standalone binary. The client is a single HTML page — works on any device with a modern browser. No installation required for the viewer.

### Local P2P
When host and client are on the same LAN, PeerTerm automatically establishes a direct **WebRTC DataChannel** connection, bypassing the relay entirely. Zero latency, zero external traffic.

### Read-Only Mode
Share your terminal for demos, pair debugging, or interviews with `--readonly`. Viewers can see everything but can't type.

---

## Quick Start

### With npx (requires Node.js 18+)

```bash
npx peer-term
```

That's it. You'll see a 6-digit code. Share it.

### With a standalone binary

Download the latest binary from [Releases](https://github.com/YOUR_USERNAME/peer-term/releases):

| Platform | Binary |
|---|---|
| Linux x64 | `peer-term-linux-x64` |
| Linux ARM64 | `peer-term-linux-arm64` |
| macOS x64 | `peer-term-macos-x64` |
| macOS ARM64 | `peer-term-macos-arm64` |
| Windows x64 | `peer-term-win-x64.exe` |

```bash
chmod +x peer-term-linux-x64
./peer-term-linux-x64
```

> **Note:** The binary requires `node-pty` and `node-datachannel` native modules to be present alongside it. See [Native Dependencies](#native-dependencies) below.

### Connecting as a viewer

Open the client URL in a browser and enter the 6-digit code:

- **Self-hosted relay**: `http://localhost:8080`
- **Deployed relay**: `https://your-relay-url.com`
- **GitHub Pages**: `https://YOUR_USERNAME.github.io/peer-term/`
- **Custom domain**: `https://peerterm.dev`

For a custom relay, pass it as a query parameter:

```
https://YOUR_USERNAME.github.io/peer-term/?relay=wss://your-relay.com
```

---

## CLI Usage

```
Usage: peer-term [options]

Options:
  --expiry <time>     Session expiry time (e.g. 5m, 30s, 1h)  [default: 5m]
  --readonly          Share in view-only mode
  --relay <url>       Custom relay server URL
  --verbose           Enable debug logging
  --help              Show this help message
  --version           Print version number
```

### Examples

```bash
peer-term                        # start session, default settings
peer-term --expiry 10m           # custom expiry
peer-term --readonly             # view-only session
peer-term --verbose              # debug logs
peer-term --relay wss://custom   # use custom relay server
```

---

## Deploy Your Own Relay

The relay server is a lightweight Node.js app. Deploy it anywhere that supports WebSockets.

### Railway

1. Fork this repo
2. Connect your GitHub repo in Railway
3. Set the root directory to `relay/`
4. Railway auto-detects Node.js and deploys
5. Set `PORT` environment variable if needed (Railway usually provides one)

### Render

1. Create a new Web Service on Render
2. Connect your GitHub repo
3. Set root directory to `relay/`
4. Set build command: `npm ci --only=production`
5. Set start command: `node server.js`
6. Add environment variable: `PORT=8080`

### Fly.io

```bash
cd relay
fly launch
fly deploy
```

### Docker

```bash
docker build -f relay/Dockerfile -t peerterm-relay .
docker run -p 8080:8080 peerterm-relay
```

---

## Host the Client

The client is a single `index.html` file. Host it anywhere that serves static files.

### GitHub Pages

1. Enable GitHub Pages in your repo settings (source: `main` branch, `/client` directory)
2. Access at `https://YOUR_USERNAME.github.io/peer-term/`
3. Pass your relay URL: `?relay=wss://your-relay.com`

### Vercel

1. Import the repo on Vercel
2. Set the root directory to `client/`
3. Deploy — it's a static file, zero config

### Custom Domain

Point your domain's DNS to GitHub Pages or Vercel, then update the relay URL query param.

---

## How Encryption Works

When a client joins a session, both sides generate a fresh **ECDH P-256** key pair. They exchange public keys through the relay, then each independently derives the same **AES-256-GCM** shared secret. Every single message — terminal output, keystrokes, resize events — is encrypted with a fresh random 12-byte IV before being sent. The relay server forwards base64 blobs it cannot decrypt. When the client disconnects and reconnects, a completely new key exchange happens.

---

## Native Dependencies

PeerTerm uses two native C++ modules:

- **node-pty** — spawns a real pseudo-terminal
- **node-datachannel** — WebRTC DataChannel for local P2P

These require C++ build tools:

| Platform | Requirement |
|---|---|
| Windows | Visual Studio Build Tools with "Desktop development with C++" |
| macOS | `xcode-select --install` |
| Linux | `build-essential`, `cmake`, `python3` |

If you see build errors during `npm install`, install the required tools above and run `npm rebuild`.

---

## Project Structure

```
peer-term/
├── relay/
│   ├── server.js          WebSocket relay & signaling server
│   ├── Dockerfile         Production Docker image
│   ├── .dockerignore
│   └── package.json
├── host/
│   ├── bin/
│   │   └── peer-term.js   CLI entry point (shebang)
│   ├── src/
│   │   ├── index.js       Main host agent
│   │   ├── crypto.js      ECDH + AES-GCM encryption
│   │   ├── webrtc.js      WebRTC DataChannel (P2P)
│   │   ├── logger.js      Structured logging
│   │   ├── ui.js          CLI output formatting
│   │   └── check-deps.js  Native module checker
│   ├── dist/              Binary builds (gitignored)
│   └── package.json
├── client/
│   └── index.html         Single-file browser client
├── .github/
│   └── workflows/
│       └── release.yml    Auto-build on version tags
├── .gitignore
├── README.md
└── PRD.md
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Relay server port |
| `RELAY_URL` | `ws://localhost:8080` | Relay URL for host agent |

---

## What I Learned

- **WebRTC without STUN/TURN is surprisingly useful.** By only using `typ host` ICE candidates, you get zero-latency local P2P without leaking any data to external servers. The tradeoff is it only works on the same LAN — but for that use case, it's perfect.

- **End-to-end encryption in JavaScript is straightforward.** The WebCrypto API (both Node.js and browser) handles ECDH key exchange and AES-GCM natively. No dependencies needed. The hardest part was making sure both sides derive the exact same key.

- **node-pty is the bottleneck for cross-platform distribution.** It's a native C++ addon that requires build tools on every platform. This makes `npx` installs slower and binary packaging harder. There's no pure-JS alternative that gives you a real PTY.

- **A relay server that never sees plaintext is a good design.** The relay only forwards opaque base64 blobs. Even if compromised, it can't read terminal data. This makes the security model simple to reason about.

- **Session codes beat URLs.** A 6-digit numeric code is easier to communicate verbally, works on any device, and expires automatically. Much better UX than sharing a long URL with tokens.

---

## License

MIT

<div align="center">
  <h1>PeerTerm</h1>
  <p><strong>Share your terminal instantly over WebRTC using a 6-digit code.</strong></p>
  <p>Fully end-to-end encrypted. No configuration. No accounts required.</p>
  
  <br />

  [![Website](https://img.shields.io/badge/Website-peerterm.dhananjaybalekar.in-34d399)](https://peerterm.dhananjaybalekar.in/)
  [![CI Test Suite](https://github.com/jay6205/Peer_term/actions/workflows/ci.yml/badge.svg)](https://github.com/jay6205/Peer_term/actions/workflows/ci.yml)
  [![npm version](https://img.shields.io/npm/v/peer-term?color=cb3837)](https://www.npmjs.com/package/peer-term)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Node.js](https://img.shields.io/badge/Node.js-20+-success)](https://nodejs.org/)

  <p>
    <a href="https://peerterm.dhananjaybalekar.in/"><strong>Explore Website &amp; Interactive Demo</strong></a>
    &nbsp;·&nbsp;
    <a href="https://peerterm.dhananjaybalekar.in/connect/"><strong>Open Web Viewer</strong></a>
  </p>

</div>

<hr />

## Features

* **Instant Sharing** – Run a single command, get a 6-digit code. Share the code, and the viewer connects instantly via their browser. No port forwarding, SSH keys, or signups.
* **End-to-End Encrypted** – Every keystroke and terminal output byte is encrypted locally using **AES-256-GCM**. Keys are exchanged via **ECDH P-256**. For sensitive sessions, use `--secure` to require a fingerprint verification before terminal access starts.
* **Works Everywhere** – The host runs as a Node.js CLI. The client is a lightweight, single-page HTML application that works on any modern browser.
* **Local P2P (Zero Latency)** – When the host and client are on the same local network, PeerTerm establishes a direct **WebRTC DataChannel**, bypassing the relay server entirely for zero-latency, private connections.
* **Live Permission Toggling** – Dynamically switch any active session between **Read-Only** and **Interactive** modes on the fly (`r <code>`) without restarting the PTY or dropping the connection.
* **File Uploads** – Clients can securely drag-and-drop files (up to 100MB) to upload them directly to the host's `~/peerterm-uploads/` directory. All transfers are end-to-end encrypted and work over both WebRTC and relay connections.
* **Resilient Connections** – Both host and client get a 2-minute rejoin window if their IP changes or connection drops mid-session. The PTY state is fully preserved — no session restart needed.
* **Instant QR Code Join** – Generates an ASCII terminal QR code on session creation for frictionless, one-tap scanning from smartphones or tablets without typing the code.

---

## Quick Start

You don't even need to install anything. Just use `npx` (requires Node.js 18+):

```bash
npx peer-term
```

That's it! You will be given a 6-digit session code. 

**Connecting as a Viewer:**
Share the code with your peer. They simply need to visit your client URL and enter the code:
* **Website &amp; Interactive Demo:** [peerterm.dhananjaybalekar.in](https://peerterm.dhananjaybalekar.in/)
* **Default Web Viewer:** [peerterm.dhananjaybalekar.in/connect/](https://peerterm.dhananjaybalekar.in/connect/)
* **Self-hosted Relay:** `http://localhost:8080`

By default, the connection is instant. If you started the session with `--secure`, both sides will show a short security fingerprint. Compare it over a trusted channel, and authorize terminal access in the host CLI with `a <code>`.

---

## Installation & Usage

### Global NPM Installation
```bash
npm install -g peer-term
```

### CLI Highlights

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--expiry <time>` | Session expiry duration (e.g. `5m`, `30s`, `1h`) | `5m` |
| `--rejoin <time>` | Reconnection window if connection drops (e.g. `2m`, `10m`) | `2m` |
| `--readonly` | Disable client keystrokes (view-only terminal mode) | Off |
| `--secure` | Enable fingerprint verification for MITM protection | Off |
| `--path <dir>` | Starting directory for the terminal session | `~` (Home) |
| `--relay <url>` | Custom relay server WebSocket URL(s) | `wss://relay.dhananjaybalekar.in` |
| `-V, --verbose` | Enable verbose debug logging | Off |
| `-h, --help` | Display usage information and exit | — |
| `-v, --version` | Output version number and exit | — |

### Interactive Session Controls

While PeerTerm is active, you can manage sessions in real time from the interactive prompt:

| Command | Description |
| :--- | :--- |
| `n` | Create a new simultaneous terminal session |
| `l` | List all active sessions and connection status (`[READ-ONLY]` vs `[INTERACTIVE]`) |
| `r <code>` | Toggle read-only / interactive mode for an active session (alias: `rt <code>`) |
| `a <code>` | Authorize verified fingerprint (when `--secure` is enabled) |
| `k <code>` | Kill / terminate a specific session by code |
| `q` | Quit all active sessions and shut down |

### Examples

```bash
peer-term                        # Start session with default settings
peer-term --expiry 10m           # Custom expiry window
peer-term --rejoin 5m            # Custom reconnection window
peer-term --path ~/projects      # Open terminal at a specific path
peer-term --readonly             # View-only session
peer-term --secure               # Require fingerprint verification
peer-term --relay wss://custom   # Use a custom relay server
peer-term --verbose              # Enable debug logging
```

---

## Architecture & Security

### How Encryption Works
When a client joins a session, both the host and client generate fresh **ECDH P-256** key pairs. Public keys are exchanged through the relay server. Both sides then independently derive the exact same **AES-256-GCM** shared secret and compute a short fingerprint over the session code and both public keys.

If `--secure` is used, the browser blocks until the viewer confirms the fingerprint matches the host, and the host does not start the terminal until the host authorizes the verified fingerprint with `a <code>`. Every single message (terminal output, keystrokes, resize events) is then encrypted using this shared secret alongside a fresh, random 12-byte Initialization Vector (IV). The relay server acts as a blind forwarder, passing opaque base64 blobs that it cannot decrypt.

Even WebRTC signaling metadata (ICE candidates, SDP offers/answers) is encrypted before being sent over the relay, preventing IP leaks to the relay operator.

---

## Deployment & Self-Hosting

PeerTerm is completely self-hostable with zero external cloud dependencies. You can run the signaling relay and client locally on your machine or deploy them to private infrastructure.

### Local Hosting (Fastest Setup)

The repository is configured as an npm workspace, and the relay server includes a built-in static HTTP server that automatically serves the `client/` web terminal.

#### 1. Start the Relay & Web Client
From the repository root:
```bash
npm install
npm run relay
```
*(Or `cd relay && npm install && npm start`)*

* **Relay WebSocket:** `ws://localhost:8080`
* **Web Terminal UI:** `http://localhost:8080` (served automatically)

#### 2. Run the Host CLI
In a second terminal window, run the host CLI pointing to your local relay:
```bash
# From repository root:
npm run host -- --relay ws://localhost:8080

# Or using npx:
npx peer-term --relay ws://localhost:8080

# Or from the host/ directory:
cd host
node bin/peer-term.js --relay ws://localhost:8080
```

#### 3. Connect
Open `http://localhost:8080` in any web browser and enter the generated 6-digit session code.

#### Relay Configuration (.env)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP & WebSocket server port | `8080` |
| `CLIENT_DIR` | Filesystem path to client static assets | `../client` |
| `MAX_SESSIONS` | Maximum concurrent active sessions | `500` |
| `MAX_SESSIONS_PER_IP` | Maximum concurrent sessions per host IP address | `20` |
| `TRUSTED_PROXIES` | Comma-separated list of proxy IPs/CIDRs for `X-Forwarded-For` | Loopback & RFC1918 |

---

### Cloud Deployment

Want to host the infrastructure in the cloud? The relay server is a lightweight Node.js app that can be deployed anywhere that supports WebSockets.

<details>
<summary><strong>Docker</strong></summary>

```bash
docker build -f relay/Dockerfile -t peerterm-relay .
docker run -p 8080:8080 peerterm-relay
```

</details>

<details>
<summary><strong>Railway / Render</strong></summary>

1. Connect your GitHub repository.
2. Set the root directory to `relay/`.
3. Set the build command: `npm ci --only=production`.
4. Set the start command: `node server.js`.
5. Expose the `PORT` environment variable (e.g., `8080`).

</details>

<details>
<summary><strong>Fly.io</strong></summary>

```bash
cd relay
fly launch
fly deploy
```

</details>

<details>
<summary><strong>AWS EC2 (via included GitHub Actions)</strong></summary>

This repository includes a `deploy.yml` workflow for automated EC2 deployments.
1. Setup an EC2 instance with Nginx and PM2 installed.
2. In your GitHub repository settings, add the following Actions secrets:
   - `EC2_HOST`: The IP address of your EC2 instance.
   - `EC2_USER`: Your SSH username (e.g., `ubuntu`).
   - `EC2_SSH_KEY`: Your private SSH key.
3. Ensure Nginx serves the client from `/var/www/peerterm/` and the relay is located at `~/peerterm-relay`.
4. Pushing to `main` will automatically rsync the files and reload PM2.

</details>

### Standalone Web Client Hosting

While the relay serves the client automatically, you can also host the `client/` directory as a standalone static site on Vercel, Netlify, or GitHub Pages.

Viewers can then connect by specifying your custom relay URL in the query string:
`https://your-client-domain.com/?relay=wss://your-relay.com`

---

## Testing & Quality Assurance

PeerTerm includes an automated test suite executed on every commit and pull request via GitHub Actions:

* **Cryptographic Invariants:** Verifies ephemeral ECDH P-256 key exchange, AES-256-GCM authenticated encryption round-trips, unique IV generation per message, SAS security fingerprinting, and rejection of tampered ciphertext.
* **WebRTC Signaling Queuing:** Tests race-condition prevention by validating that host-side ICE candidates are held until the SDP offer is sent, and client-side candidates arriving before peer connection creation are safely queued and flushed in order.
* **Relay & Client Helpers:** Tests trusted proxy CIDR subnet matching, rate limiter edge cases, 6-digit session code generation, and chunked base64 conversion for large payloads.
* **Zero External Dependencies:** Built with Node's native `node:test` and `node:assert/strict` modules for sub-second execution (~200ms) without heavy test runner overhead.

To run the full test suite locally:

```bash
npm test
```

---

## Native Dependencies

PeerTerm relies on two native C++ modules: `node-pty` (for spawning pseudo-terminals) and `node-datachannel` (for WebRTC local P2P).

These modules require C++ build tools during `npm install`:
* **Windows:** Visual Studio Build Tools with "Desktop development with C++"
* **macOS:** `xcode-select --install`
* **Linux:** `build-essential`, `cmake`, `python3`

---

## Project Structure

This repository contains the three components required to run and self-host PeerTerm:

```text
peer-term/
├── relay/                     # Signaling & blind encrypted packet forwarder
│   ├── server.js              # WebSocket signaling, 6-digit pairing & built-in HTTP server for client UI
│   ├── Dockerfile             # Container configuration for Docker / VPS / Fly.io
│   ├── package.json           # Minimal dependencies (ws, dotenv)
│   └── .env.example           # Configurable PORT, rate limits, trusted proxies
│
├── client/                    # Zero-install browser terminal viewer
│   ├── index.html             # Terminal UI container (xterm.js)
│   ├── app.js                 # Web Crypto (ECDH + AES-256-GCM), WebRTC DataChannel & socket handler
│   └── styles.css             # Dark terminal theme & drag-and-drop file upload overlay
│
├── host/                      # Node.js CLI host agent (shares local terminal)
│   ├── bin/
│   │   └── peer-term.js       # CLI executable entry point (`npx peer-term`)
│   ├── src/
│   │   ├── index.js           # Session coordinator, PTY lifecycle & relay socket client
│   │   ├── cli.js             # Flag parsing & interactive REPL commands (`n`, `l`, `r`, `a`, `k`, `q`)
│   │   ├── crypto.js          # Ephemeral ECDH P-256 key exchange & AES-256-GCM encryption
│   │   ├── webrtc.js          # Direct local P2P WebRTC DataChannel management (node-datachannel)
│   │   ├── file-transfer.js   # Encrypted drag-and-drop file upload receiver (~/peerterm-uploads/)
│   │   └── config.js          # Relay connection defaults & timeout limits
│   └── package.json           # Native bindings (node-pty, node-datachannel)
│
└── .github/workflows/         # CI/CD and release automation
```

> **Note:** The marketing website (`peerterm-landing/`) is intentionally omitted above as it is only for the public landing page and is not needed for running or self-hosting PeerTerm.

---

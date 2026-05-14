<div align="center">
  <h1>PeerTerm</h1>
  <p><strong>Share your terminal instantly over WebRTC using a 6-digit code.</strong></p>
  <p>Fully end-to-end encrypted. No configuration. No accounts required.</p>
  
  <br />

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Node.js](https://img.shields.io/badge/Node.js-18+-success)](https://nodejs.org/)

</div>

<hr />

## Features

* **Instant Sharing** – Run a single command, get a 6-digit code. Share the code, and the viewer connects instantly via their browser. No port forwarding, SSH keys, or signups.
* **End-to-End Encrypted** – Every keystroke and terminal output byte is encrypted locally using **AES-256-GCM**. Keys are exchanged via **ECDH P-256**. The relay server only ever sees opaque ciphertext.
* **Works Everywhere** – The host runs as a Node.js CLI. The client is a lightweight, single-page HTML application that works on any modern browser.
* **Local P2P (Zero Latency)** – When the host and client are on the same local network, PeerTerm establishes a direct **WebRTC DataChannel**, bypassing the relay server entirely for zero-latency, private connections.
* **Read-Only Mode** – Perfect for demos, pair debugging, or interviews. Use `--readonly` so viewers can watch your terminal without the ability to execute commands.

---

## Quick Start

You don't even need to install anything. Just use `npx` (requires Node.js 18+):

```bash
npx peer-term
```

That's it! You will be given a 6-digit session code. 

**Connecting as a Viewer:**
Share the code with your peer. They simply need to visit your client URL and enter the code:
* **Default Client:** [peerterm.dev](https://peerterm.dev)
* **Self-hosted Relay:** `http://localhost:8080`

---

## Installation & Usage

### Global NPM Installation
```bash
npm install -g peer-term
```

### CLI Options

```text
Usage: peer-term [options]

Options:
  --expiry <time>     Session expiry time (e.g. 5m, 30s, 1h)  [default: 5m]
  --readonly          Share in view-only mode
  --path <dir>        Starting directory for the terminal session [default: home]
  --relay <url>       Custom relay server URL
  --verbose           Enable debug logging
  --help              Show this help message
  --version           Print version number
```

**Examples:**
```bash
peer-term                        # Start session with default settings
peer-term --expiry 10m           # Custom expiry window
peer-term --path ~/projects      # Open terminal at a specific path
peer-term --readonly             # View-only session
peer-term --relay wss://custom   # Use a custom relay server
peer-term --verbose              # Enable debug logging
```

---

## Architecture & Security

### How Encryption Works
When a client joins a session, both the host and client generate fresh **ECDH P-256** key pairs. Public keys are exchanged securely via the relay server. Both sides then independently derive the exact same **AES-256-GCM** shared secret. 

Every single message (terminal output, keystrokes, resize events) is encrypted using this shared secret alongside a fresh, random 12-byte Initialization Vector (IV). The relay server acts as a blind forwarder, passing opaque base64 blobs that it cannot decrypt. 

Even WebRTC signaling metadata (ICE candidates, SDP offers/answers) is encrypted before being sent over the relay, preventing IP leaks to the relay operator.

---

## Deployment 

Want to run your own infrastructure? PeerTerm consists of a lightweight WebSocket relay server and a static HTML client.

### 1. Deploy the Relay Server

The relay server is a simple Node.js app that can be deployed anywhere that supports WebSockets.

<details>
<summary><strong>Railway / Render</strong></summary>

1. Connect your GitHub repository.
2. Set the root directory to `relay/`.
3. Set the build command: `npm ci --only=production`.
4. Set the start command: `node server.js`.
5. Expose the `PORT` environment variable (e.g., `8080`).

</details>

<details>
<summary><strong>Docker</strong></summary>

```bash
docker build -f relay/Dockerfile -t peerterm-relay .
docker run -p 8080:8080 peerterm-relay
```

</details>

<details>
<summary><strong>Fly.io</strong></summary>

```bash
cd relay
fly launch
fly deploy
```

</details>

### 2. Host the Client

The client is a single `index.html` file located in the `client/` directory.

* **GitHub Pages:** Enable GitHub Pages pointing to the `/client` directory. 
* **Vercel / Netlify:** Import the repository and set the root directory to `client/`. Zero build configuration is required.

Once deployed, connect to your custom relay using a query parameter:
`https://YOUR_USERNAME.github.io/peer-term/?relay=wss://your-relay.com`

---

## Native Dependencies

PeerTerm relies on two native C++ modules: `node-pty` (for spawning pseudo-terminals) and `node-datachannel` (for WebRTC local P2P).

These modules require C++ build tools during `npm install`:
* **Windows:** Visual Studio Build Tools with "Desktop development with C++"
* **macOS:** `xcode-select --install`
* **Linux:** `build-essential`, `cmake`, `python3`

---

## Project Structure

```text
peer-term/
├── relay/                 # WebSocket relay & signaling server
├── host/                  # Node.js CLI host agent
│   ├── src/               # Encryption, WebRTC, PTY logic
│   └── bin/               # CLI entry point
├── client/                # Single-file browser viewer
└── .github/workflows/     # CI/CD and release actions
```

---
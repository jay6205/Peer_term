# PeerTerm

Share your terminal with anyone, anywhere, using just a 6-digit code.  
No port forwarding. No configuration. Fully end-to-end encrypted.

## How It Works

1. **Host** runs the CLI agent → gets a 6-digit code
2. **Client** opens the browser, enters the code → gets live terminal access
3. Everything is encrypted with ECDH + AES-256-GCM — the relay server only sees ciphertext

## Quick Start

### Prerequisites

- **Node.js** v18+
- **Windows**: Visual Studio Build Tools (for `node-pty` native compilation)
  ```
  npm install -g windows-build-tools
  ```

### Install

```bash
cd peer-term
npm install
```

### Run

**Terminal 1 — Start the relay server:**
```bash
cd relay
npm start
```

**Terminal 2 — Start the host agent:**
```bash
cd host
npm start
```

**Browser — Connect as client:**
Open `http://localhost:8080` and enter the 6-digit code shown by the host agent.

## Project Structure

```
peer-term/
├── relay/           → WebSocket relay & signaling server
│   ├── server.js    → Main server (HTTP + WebSocket)
│   └── package.json
├── host/            → CLI host agent
│   ├── index.js     → Main agent (PTY + WebSocket)
│   ├── crypto.js    → ECDH + AES-GCM helpers
│   └── package.json
├── client/          → Browser client
│   └── index.html   → Single-file app (xterm.js + WebCrypto)
├── package.json     → Root workspace config
└── README.md
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Relay server port |
| `RELAY_URL` | `ws://localhost:8080` | Relay URL for host agent |

## Encryption

All terminal data is end-to-end encrypted:

- **Key exchange**: ECDH with P-256 curve
- **Data encryption**: AES-GCM with 256-bit key
- **Per message**: Fresh random 12-byte IV prepended to ciphertext
- **Wire format**: Base64 encoded

The relay server forwards encrypted blobs without ever reading them.

## License

MIT

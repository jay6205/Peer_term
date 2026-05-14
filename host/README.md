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
peer-term --expiry 10m                 # custom expiry time
peer-term --verbose                    # enable debug logging
```

## Features

- **No Config**: Works instantly. No port forwarding or firewall configuration needed.
- **End-to-End Encrypted**: Terminal data is encrypted locally using AES-GCM before being sent.
- **WebRTC P2P**: Creates a direct Peer-to-Peer connection when possible for minimal latency.
- **Read-Only Mode**: Guests can view your terminal but cannot type commands, ensuring your system remains secure.
- **Custom Start Path**: Set the starting directory with `--path` so guests land right where you want them.

## License

MIT

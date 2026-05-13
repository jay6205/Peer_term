# ─────────────────────────────────────────────────────────────────────────────
# PeerTerm Relay Server — Production Docker Image
#
# Build from the PROJECT ROOT (not relay/):
#   docker build -f relay/Dockerfile -t peerterm-relay .
#
# Run:
#   docker run -p 8080:8080 peerterm-relay
# ─────────────────────────────────────────────────────────────────────────────

# ─── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:18-alpine AS deps

WORKDIR /app

# Copy only package files first for layer caching
# Dependencies won't reinstall unless package files change
COPY relay/package.json relay/package-lock.json* ./
RUN npm ci --only=production && npm cache clean --force

# ─── Stage 2: Production image ──────────────────────────────────────────────
FROM node:18-alpine

# Metadata
LABEL maintainer="PeerTerm"
LABEL description="PeerTerm WebSocket relay & signaling server"
LABEL version="1.0.0"

# Install tini for proper PID 1 signal handling
# (ensures SIGTERM/SIGINT reach the Node process cleanly)
RUN apk add --no-cache tini

# Create non-root user for security
RUN addgroup -S peerterm && adduser -S peerterm -G peerterm

WORKDIR /app

# Copy dependencies from builder stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy relay server code
COPY relay/server.js ./

# Copy client HTML so the relay can serve the UI
# Server looks for: path.join(__dirname, '..', 'client', 'index.html')
# __dirname = /app → looks for /client/index.html
COPY client/index.html /client/index.html

# Switch to non-root user
USER peerterm

# Expose default port (configurable via PORT env var)
EXPOSE 8080

# Health check — platform monitoring integration
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-8080}/health || exit 1

# Use tini as entrypoint for proper signal forwarding
ENTRYPOINT ["/sbin/tini", "--"]

# Start the relay server
CMD ["node", "server.js"]

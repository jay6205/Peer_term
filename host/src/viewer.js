/**
 * PeerTerm — Local Viewer Server
 *
 * Token-authenticated TCP server that opens a new terminal window
 * for the host to view the shared session locally.
 *
 * Cross-platform terminal opener (Windows, macOS, Linux).
 */

import crypto from 'crypto';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ViewerServer {
  /**
   * @param {Object} opts
   * @param {string}   opts.code        - Session code (for window title)
   * @param {function} opts.log         - Info logger
   * @param {function} opts.logDebug    - Debug logger
   * @param {function} opts.onResize    - Called with (cols, rows) when viewer resizes
   * @param {function} opts.onKeystroke - Called with (data) for host keystrokes → PTY
   */
  constructor({ code, log, logDebug, onResize, onKeystroke }) {
    this._code = code;
    this._log = log;
    this._logDebug = logDebug;
    this._onResize = onResize;
    this._onKeystroke = onKeystroke;

    this._server = null;
    this._socket = null;
    this._token = null;
  }

  /**
   * The active viewer socket (if connected and authenticated).
   * Used by Session to mirror PTY output to the local viewer.
   * @type {net.Socket|null}
   */
  get socket() {
    return this._socket;
  }

  /**
   * Start the TCP viewer server on a random port and open a terminal window.
   */
  start() {
    // Generate a random nonce for viewer authentication
    this._token = crypto.randomBytes(16).toString('hex');

    this._server = net.createServer((socket) => {
      // Close any existing viewer connection before accepting a new one
      if (this._socket) {
        this._logDebug('Replacing existing viewer connection.');
        this._socket.removeAllListeners();
        try { this._socket.destroy(); } catch {}
      }

      // ── Token authentication gate ──────────────────────────────────
      // The first data packet must be the viewer token followed by a newline.
      // Reject the connection if no valid token arrives within 2 seconds.
      let authenticated = false;
      let authBuf = '';

      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          this._logDebug('Viewer auth timeout — closing connection.');
          try { socket.destroy(); } catch {}
        }
      }, 2000);

      const onAuthData = (data) => {
        authBuf += data.toString();
        const newlineIdx = authBuf.indexOf('\n');
        if (newlineIdx === -1) {
          // Accumulated too much data without a newline — reject
          if (authBuf.length > 256) {
            clearTimeout(authTimeout);
            this._logDebug('Viewer auth buffer overflow — closing connection.');
            try { socket.destroy(); } catch {}
          }
          return;
        }

        const token = authBuf.slice(0, newlineIdx).trim();
        const remaining = authBuf.slice(newlineIdx + 1);
        clearTimeout(authTimeout);
        socket.removeListener('data', onAuthData);

        if (token !== this._token) {
          this._logDebug('Viewer auth failed — wrong token.');
          try { socket.destroy(); } catch {}
          return;
        }

        // Authenticated — promote to active viewer
        authenticated = true;
        this._socket = socket;
        this._log('Host viewer connected (authenticated).');

        // Install the real data handler
        let recvBuf = '';

        // Process any leftover data that arrived after the token line
        if (remaining.length > 0) {
          handleViewerData(remaining);
        }

        socket.on('data', (chunk) => handleViewerData(chunk.toString()));

        const handleViewerData = (chunk) => {
          // Control messages start with \x00{
          if (recvBuf.length > 0 || chunk.startsWith('\x00{')) {
            recvBuf += chunk;
            let nlIdx;
            while ((nlIdx = recvBuf.indexOf('\n')) !== -1) {
              const line = recvBuf.slice(0, nlIdx).trim();
              recvBuf = recvBuf.slice(nlIdx + 1);

              if (line.startsWith('\x00')) {
                try {
                  const msg = JSON.parse(line.slice(1));
                  if (msg.type === 'resize' &&
                      Number.isInteger(msg.cols) && msg.cols > 0 &&
                      Number.isInteger(msg.rows) && msg.rows > 0) {
                    this._onResize(msg.cols, msg.rows);
                    this._logDebug(`Viewer resized to ${msg.cols}x${msg.rows}`);
                  }
                } catch {}
              } else {
                this._onKeystroke(line + '\n');
              }
            }
            // Flush any non-control data left in the buffer
            if (recvBuf.length > 0 && !recvBuf.startsWith('\x00')) {
              this._onKeystroke(recvBuf);
              recvBuf = '';
            }
            return;
          }

          // Host keystrokes → PTY (host always has access)
          this._onKeystroke(chunk);
        };

        socket.on('close', () => {
          this._socket = null;
          this._logDebug('Host viewer disconnected.');
        });

        socket.on('error', () => {
          this._socket = null;
        });
      };

      socket.on('data', onAuthData);

      socket.on('error', () => {
        clearTimeout(authTimeout);
      });
    });

    this._server.listen(0, '127.0.0.1', () => {
      const port = this._server.address().port;
      this._logDebug(`Viewer server on port ${port}`);
      this._openTerminal(port, this._token);
    });

    this._server.on('error', (err) => {
      this._log(`Viewer server error: ${err.message}`);
      this._server = null;
    });
  }

  /**
   * Write data to the viewer socket (for mirroring PTY output).
   *
   * @param {string|Buffer} data
   */
  write(data) {
    if (this._socket) {
      try { this._socket.write(data); } catch {}
    }
  }

  /**
   * Clean up the viewer server and socket.
   */
  destroy() {
    if (this._socket) {
      try { this._socket.destroy(); } catch {}
      this._socket = null;
    }
    if (this._server) {
      try { this._server.close(); } catch {}
      this._server = null;
    }
  }

  /**
   * Open a new terminal window connected to the viewer server.
   * @private
   */
  _openTerminal(port, token) {
    if (!/^[A-Za-z0-9_-]+$/.test(this._code)) {
      this._log('Invalid session code format. Aborting viewer terminal.');
      return;
    }

    const viewerScript = path.join(__dirname, 'session-viewer.js');
    const platform = os.platform();
    const portStr = String(port);
    const nodeArgs = [viewerScript, portStr, this._code, token];

    if (platform === 'win32') {
      // spawn with 'cmd' to open a new window; arguments are passed as an
      // array so the install path is never interpreted by the shell.
      spawn('cmd', ['/c', 'start', `PeerTerm - ${this._code}`, 'cmd', '/c', 'node', ...nodeArgs], {
        stdio: 'ignore',
        detached: true,
        windowsHide: false,
      }).unref();
    } else if (platform === 'darwin') {
      // osascript receives the AppleScript source as a single -e argument;
      // node args are baked into the script string, but execFile does NOT
      // invoke a shell so the outer path cannot break out.
      const script = `tell app "Terminal" to do script "node '${viewerScript.replace(/'/g, "'\\''")}' ${portStr} ${this._code} ${token}"`;
      execFile('osascript', ['-e', script], { stdio: 'ignore' }, () => {});
    } else {
      // Linux: try common terminal emulators in order, falling through on
      // failure.  Each call uses execFile (no shell), so paths with
      // metacharacters are safe.
      const tryTerminals = [
        ['x-terminal-emulator', ['-e', 'node', ...nodeArgs]],
        ['gnome-terminal', ['--', 'node', ...nodeArgs]],
        ['xterm', ['-e', 'node', ...nodeArgs]],
      ];

      const tryNext = (index) => {
        if (index >= tryTerminals.length) {
          this._log('Could not open any terminal emulator for viewer.');
          return;
        }
        const [cmd, args] = tryTerminals[index];
        execFile(cmd, args, { stdio: 'ignore' }, (err) => {
          if (err) tryNext(index + 1);
        });
      };
      tryNext(0);
    }
    this._log('Opening terminal viewer...');
  }
}

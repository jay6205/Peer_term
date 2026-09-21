/**
 * PeerTerm — File Transfer Handler
 *
 * Encapsulates all file upload protocol logic:
 * - Routing file-start, file-chunk, file-end, file-cancel messages
 * - Chunk validation and size enforcement
 * - File reassembly and disk writes
 * - Ack/error responses back to the client
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { encrypt } from './crypto.js';
import {
  UPLOAD_MAX_FILE_SIZE,
  UPLOAD_MAX_CHUNKS_PER_FILE,
  UPLOAD_MAX_CONCURRENT,
} from './config.js';

/**
 * @typedef {Object} SessionContext
 * @property {CryptoKey|null} sharedKey    - Current E2E shared key
 * @property {boolean}        readOnly     - Whether the session is read-only
 * @property {Object|null}    ptyProcess   - The PTY process instance
 * @property {function}       log          - Session-scoped info logger
 * @property {function}       logDebug     - Session-scoped debug logger
 * @property {function}       sendEncrypted - Send encrypted payload to client
 */

export class FileTransferHandler {
  /**
   * @param {SessionContext} ctx - Session context for callbacks and state access
   */
  constructor(ctx) {
    this._ctx = ctx;

    /** @type {Object.<string, {name: string, size: number, totalChunks: number, receivedSize: number, chunks: Map}>} */
    this._incomingFiles = {};
  }

  /**
   * Update the session context (e.g. after key re-exchange).
   * @param {SessionContext} ctx
   */
  updateContext(ctx) {
    this._ctx = ctx;
  }

  /**
   * Clean up all in-progress transfers.
   */
  cleanup() {
    this._incomingFiles = {};
  }

  /**
   * Route a file transfer message to the appropriate handler.
   *
   * @param {Object} msg - Parsed file message with type, id, and payload fields
   */
  handleMessage(msg) {
    // Defense-in-depth: reject all file operations in read-only sessions
    if (this._ctx.readOnly) {
      this._sendError(msg.id, 'File uploads are disabled in read-only mode');
      return;
    }

    switch (msg.type) {
      case 'file-start': {
        // Validate required fields
        if (!msg.id || !msg.name || msg.size === undefined || msg.totalChunks === undefined) {
          this._sendError(msg.id, 'Invalid file-start message');
          return;
        }

        if (msg.size > UPLOAD_MAX_FILE_SIZE) {
          this._sendError(msg.id, `File exceeds maximum size of ${UPLOAD_MAX_FILE_SIZE / 1024 / 1024}MB`);
          return;
        }

        if (msg.totalChunks > UPLOAD_MAX_CHUNKS_PER_FILE) {
          this._sendError(msg.id, 'File requires too many chunks');
          return;
        }

        if (Object.keys(this._incomingFiles).length >= UPLOAD_MAX_CONCURRENT) {
          this._sendError(msg.id, 'Too many concurrent uploads');
          return;
        }

        this._ctx.log(`File upload started: "${msg.name}" (${msg.size} bytes, ${msg.totalChunks} chunks)`);
        this._incomingFiles[msg.id] = {
          name: msg.name,
          size: msg.size,
          totalChunks: msg.totalChunks,
          receivedSize: 0,
          chunks: new Map(),
        };
        break;
      }
      case 'file-chunk': {
        const transfer = this._incomingFiles[msg.id];
        if (!transfer) {
          this._sendError(msg.id, 'Unknown transfer ID');
          return;
        }

        const chunkData = Buffer.from(msg.data, 'base64');
        
        if (transfer.chunks.size >= transfer.totalChunks) {
          this._sendError(msg.id, 'Too many chunks received');
          delete this._incomingFiles[msg.id];
          return;
        }

        if (transfer.receivedSize + chunkData.length > transfer.size) {
          this._sendError(msg.id, 'Received size exceeds declared size');
          delete this._incomingFiles[msg.id];
          return;
        }

        transfer.chunks.set(msg.index, chunkData);
        transfer.receivedSize += chunkData.length;
        this._ctx.logDebug(`File chunk ${msg.index + 1}/${transfer.totalChunks} received for "${transfer.name}"`);
        break;
      }
      case 'file-end': {
        this._finalizeFile(msg.id);
        break;
      }
      case 'file-cancel': {
        if (this._incomingFiles[msg.id]) {
          delete this._incomingFiles[msg.id];
          this._ctx.log(`File upload cancelled by client: ${msg.id}`);
        }
        break;
      }
    }
  }

  /**
   * Reassemble all chunks in order and write the completed file to disk.
   * Saves to ~/peerterm-uploads/<filename>.
   */
  async _finalizeFile(id) {
    const transfer = this._incomingFiles[id];
    if (!transfer) {
      this._sendError(id, 'Unknown transfer ID');
      return;
    }

    // Check all chunks are present
    for (let i = 0; i < transfer.totalChunks; i++) {
      if (!transfer.chunks.has(i)) {
        this._ctx.log(`File "${transfer.name}" missing chunk ${i}`);
        this._sendError(id, `Missing chunk ${i}`);
        delete this._incomingFiles[id];
        return;
      }
    }

    // Reassemble in order using Buffer.concat
    const ordered = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      ordered.push(transfer.chunks.get(i));
    }
    const fileData = Buffer.concat(ordered);

    // Determine save path: ~/peerterm-uploads/<filename>
    const homeDir = os.homedir();
    const uploadDir = path.join(homeDir, 'peerterm-uploads');
    // Sanitize filename to prevent path traversal (e.g., "../../../etc/passwd")
    const baseName = path.basename(transfer.name);
    if (!baseName || baseName === '.' || baseName === '..') {
      this._sendError(id, 'Invalid filename');
      delete this._incomingFiles[id];
      return;
    }
    const savePath = path.join(uploadDir, baseName);

    try {
      await fs.promises.mkdir(uploadDir, { recursive: true });
      await fs.promises.writeFile(savePath, fileData);

      this._ctx.log(`File saved: ${savePath}`);

      // Write green ANSI message into the PTY to show the save path
      if (this._ctx.ptyProcess) {
        this._ctx.ptyProcess.write(`\r\n\x1b[32m[PeerTerm] File saved: ${savePath}\x1b[0m\r\n`);
      }

      // Send ack to client
      this._sendAck(id, transfer.name);
    } catch (err) {
      this._ctx.log(`Failed to save file "${transfer.name}": ${err.message}`);
      this._sendError(id, `Save failed: ${err.message}`);
    }

    delete this._incomingFiles[id];
  }

  /**
   * Send file-ack to the client confirming successful file save.
   */
  async _sendAck(id, name) {
    if (!this._ctx.sharedKey) return;
    try {
      const ackJson = JSON.stringify({ type: 'file-ack', id, name });
      const payload = await encrypt(this._ctx.sharedKey, ackJson);
      this._ctx.sendEncrypted(payload);
    } catch (err) {
      this._ctx.log(`Failed to send file-ack: ${err.message}`);
    }
  }

  /**
   * Send file-error to the client with an error message.
   */
  async _sendError(id, msg) {
    if (!this._ctx.sharedKey) return;
    try {
      const errJson = JSON.stringify({ type: 'file-error', id, msg });
      const payload = await encrypt(this._ctx.sharedKey, errJson);
      this._ctx.sendEncrypted(payload);
    } catch (err) {
      this._ctx.log(`Failed to send file-error: ${err.message}`);
    }
  }
}

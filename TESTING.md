# PeerTerm — Manual Testing Guide

You need **3 terminals** and **1+ browsers** to test everything. Restart relay and host after code changes.

---

## Setup

```bash
# Terminal 1: Start the relay server
cd peer-term/relay
npm start

# Terminal 2: Start the host agent
cd peer-term/host
node index.js

# Browser: Open http://localhost:8080
```

---

# Phase 2 Tests

## Test 1: Code Expiry (--expiry flag)

1. Start the host with `node index.js --expiry 30s`
2. You should see the code box with **"Expires in: 30 second(s)"**
3. **Wait 30 seconds** without entering the code in the browser
4. Now try to enter the code in the browser → You should see: **"Invalid or expired code"**
5. In the relay terminal, you should see: `[cleanup] Session XXXXXX expired`

Pass if: Code stops working after 30 seconds

---

## Test 2: Code Invalidation After First Join

1. Start a fresh host with `node index.js --expiry 5m`
2. Note the 6-digit code
3. Open the browser and enter the code → You connect successfully
4. Open a **second browser tab** to `http://localhost:8080`
5. Enter the **same code** in the second tab → You should see: **"Session already in use"**

Pass if: Second tab is rejected with the correct error

---

## Test 3: Heartbeat (visual check)

1. Connect normally (host + browser with a valid code)
2. Open **browser DevTools** → Network tab → filter by WS
3. Click on the WebSocket connection → Messages tab
4. You should see `{"type":"heartbeat"}` messages every 5 seconds going both directions

Pass if: Heartbeat messages appear every 5s in the WebSocket inspector

---

## Test 4: Rejoin Window (2-minute reconnect)

1. Connect normally (host + browser)
2. Type a command like `echo hello` to confirm the session works
3. **Close the browser tab** (this disconnects the client)
4. In the host terminal, you should see: **"Client disconnected. Rejoin window: 2 minutes."**
5. **Within 2 minutes**, open a new browser tab to `http://localhost:8080`
6. Enter the **same 6-digit code**
7. You should reconnect → the terminal reappears with your previous session
8. In the host terminal: **"Client reconnected."**
9. In the browser terminal: **"Reconnected"**

Pass if: Reconnect works with fresh encryption, PTY is still alive

---

## Test 5: Rejoin Window Expiry

1. Connect normally, then **close the browser tab**
2. **Wait more than 2 minutes**
3. In the relay terminal: `[cleanup] Rejoin window expired`
4. In the host terminal: **"Rejoin window expired. Session ended."** and the process exits

Pass if: Host exits after 2 minutes, code becomes invalid

---

## Test 6: Rate Limiting

1. Start the relay and host normally
2. In the browser, enter **5 wrong codes** rapidly
3. On the 5th wrong code: **"Too many attempts. Try again in 60 seconds."**
4. **Wait 60 seconds**, then enter the correct code → It should work

Pass if: Blocked after 5 wrong codes, unblocked after 60s

---

## Test 7: Graceful Disconnect Messages

### 7a: Host Ctrl+C
1. Connect normally, press `q` in the host CLI menu
2. Browser shows: **"Host ended the session."** → returns to connect screen

### 7b: PTY Shell Exit
1. Connect normally, type `exit` in the browser terminal
2. Browser shows: **"Shell exited. Session ended."** → returns to connect screen

### 7c: Relay Goes Down
1. Connect normally, **stop the relay** (Ctrl+C)
2. Browser shows: **"Connection lost. Attempting to reconnect..."**
3. Status dot turns **yellow**, connection indicator shows **"Reconnecting..."**
4. After a while: **"Session has ended."** → returns to connect screen

---

# Phase 3 Tests

## Test 8: Terminal Resize

1. Connect normally
2. In the browser terminal, run `stty size` (or `mode con` on Windows CMD)
3. **Resize the browser window** (make it wider/narrower)
4. Run `stty size` again → The dimensions should have changed to match
5. Check the host terminal log for: **"Terminal resized to XXxYY"**

Pass if: Dimensions match the browser window after resize

---

## Test 9: Read-Only Mode

1. Start the host with `node index.js --readonly`
2. You should see **(read-only)** in the session code box
3. Connect from the browser
4. In the status bar, you should see the **"👁 View Only"** badge
5. Try typing in the terminal → **Nothing should happen** (keys are silently dropped)
6. The **Paste button should be hidden**
7. Resize the browser → Resize should still work (run `stty size` from host side to verify)

Pass if: Keystrokes are blocked, badge is visible, paste is hidden, resize works

---

## Test 10: Clipboard — Copy

1. Connect normally (not in read-only mode)
2. Run `echo "Hello PeerTerm"` in the terminal
3. **Select** the text "Hello PeerTerm" in the terminal with your mouse
4. A **"Copy" button** should appear near the top of the terminal
5. Click it → It should change to **"✓ Copied"** briefly
6. Paste into a text editor to verify it copied correctly

### Keyboard shortcut:
7. Select text again, then press **Ctrl+Shift+C** → Same "✓ Copied" feedback

Pass if: Text is copied to clipboard, feedback shown

---

## Test 11: Clipboard — Paste

1. Copy some text to your clipboard (e.g., `echo "pasted!"`)
2. In the PeerTerm browser terminal, click the **"Paste"** button in the toolbar
3. The text should appear in the terminal as if you typed it
4. Press **Ctrl+Shift+V** → Same paste behavior

### Permission denied:
5. If the browser blocks clipboard access, you should see a toast: **"Clipboard access denied. Please paste manually."** (not a browser alert)

### Read-only mode:
6. In read-only mode, the Paste button should be completely hidden

Pass if: Paste works, permission denial shows toast, paste hidden in readonly

---

## Test 12: Mobile Keyboard

1. Open DevTools → toggle **device toolbar** (mobile emulator) → pick a phone
2. Reload the page at `http://localhost:8080`
3. Connect normally
4. **Tap** on the terminal area → Virtual keyboard should appear (in real mobile; in emulator, check that mobile controls are visible)
5. You should see the **⌨️** keyboard toggle button, **A-** and **A+** font size buttons in the toolbar
6. Click **A+** → Font gets larger. Click **A-** → Font gets smaller
7. Font should not go below 10px or above 20px

### Key mapping (on real mobile):
- Type characters → They appear in terminal
- Tap **Backspace** → Deletes character
- Tap **Enter** → Executes command
- Use arrow keys → Cursor moves in terminal

Pass if: Mobile keyboard works, font size adjustable, controls visible on touch devices

---

## Test 13: Connection Indicator

1. Watch the **top-right corner** of the terminal screen during the entire flow:

| Step | Expected Indicator |
|---|---|
| Before connecting | (not visible — you're on connect screen) |
| After entering code, connecting | ⏳ Connecting... |
| Terminal appears | 🔴 Relay |
| Kill the relay server | 🟡 Reconnecting... |
| Rejoin window expires | ❌ Connection Lost |

Pass if: Indicator updates correctly at each stage

---

## Test 14: Multiple Sessions Per Host

1. Start the host: `node index.js`
2. The first session code appears automatically
3. Type `n` → A **second session** is created with a new code
4. Type `l` → Both sessions are listed with their status:
   ```
   Active sessions:
     483920 — waiting for client      (expires in 4m 30s)
     729104 — waiting for client      (expires in 4m 55s)
   ```
5. Open **two browser tabs** and connect to each code separately → Both terminals should work independently
6. Type `l` again → Both show **"client connected"**
7. Type `k <first-code>` → First session is killed, first browser shows disconnect message
8. Second session continues working unaffected
9. Type `q` → All sessions killed, process exits

Pass if: Multiple independent sessions work, kill/list/quit all function correctly

---

# Phase 4 Tests — WebRTC Local P2P

> Phase 4 adds WebRTC DataChannel as a direct transport when host and client are on the same LAN. The relay remains as fallback. All existing features (encryption, resize, clipboard, readonly, reconnect, multi-session) must still work on both paths.

## Test 15: Same-LAN WebRTC Connection

1. Ensure host and client are on the **same network** (same machine or same WiFi)
2. Start the relay: `cd relay && npm start`
3. Start the host: `cd host && node index.js`
4. Note the 6-digit code
5. Open `http://localhost:8080` in the browser and enter the code
6. Watch the connection indicator in the top-right corner:

| Step | Expected Indicator |
|---|---|
| After entering code | ⏳ Connecting... |
| During ICE negotiation | ⏳ Establishing direct connection... |
| DataChannel opens | 🟢 Direct (Local) |

7. In the **host CLI**, you should see these logs (in order):
   ```
   [WebRTC] Initiating peer connection...
   [WebRTC] Local host-type ICE candidate found
   [WebRTC] Remote host-type ICE candidate found
   [WebRTC] Same LAN detected — waiting for DataChannel...
   [WebRTC] DataChannel open — relay bypassed
   ```
8. In the **browser console** (DevTools → Console), you should see:
   ```
   [WebRTC] Setting up peer connection...
   [WebRTC] Local host-type ICE candidate found
   [WebRTC] Remote host-type ICE candidate found
   [WebRTC] DataChannel received: terminal
   [WebRTC] DataChannel open — relay bypassed
   ```
9. Type commands in the terminal → They should work normally

Pass if: Indicator shows 🟢 Direct (Local), host logs confirm DataChannel open, terminal I/O works

---

## Test 16: Terminal I/O Over WebRTC

1. Connect on the same LAN and confirm 🟢 Direct (Local) indicator
2. Run `echo "hello webrtc"` in the terminal → Output appears
3. Run an interactive command (e.g., `dir` on Windows, `ls` on Linux)
4. **Resize the browser window** → Host should log `Terminal resized to XXxYY`
5. If not in readonly mode, **paste** text via toolbar → Text arrives at terminal
6. **Select text** in the terminal → Copy button appears, copy works

Pass if: All terminal I/O, resize, clipboard work identically to relay mode

---

## Test 17: Relay Fallback (Cross-Network Simulation)

> Since testing cross-network requires separate networks, you can verify fallback behavior by watching the ICE timeout logic.

1. Connect normally on the same LAN
2. If WebRTC succeeds (🟢 Direct), this test is about the fallback path
3. To force fallback, you would need host and client on **different networks**
4. When fallback occurs, the indicator shows **🔴 Relay**
5. Host CLI should log: `[WebRTC] Not on same LAN — using relay`
6. The terminal should work normally over relay — **no error shown to the user**
7. All Phase 2 and 3 features continue to work

Pass if: Relay fallback is silent, no user-facing error, terminal works normally

---

## Test 18: WebRTC DataChannel Drop (Mid-Session Fallback)

1. Connect on the same LAN and confirm 🟢 Direct (Local) indicator
2. **Open browser DevTools → Console** to monitor
3. Force a DataChannel close by running this in the Console:
   ```javascript
   peerConnection.close();
   ```
4. The indicator should change from 🟢 Direct (Local) to **🔴 Relay**
5. The terminal should **continue working** with no interruption (data now flows through relay)
6. **No error message should appear** in the terminal
7. Host CLI should log: `[WebRTC] DataChannel closed — falling back to relay`

Pass if: Seamless fallback, no terminal disruption, indicator updates

---

## Test 19: Updated Connection Indicator States

1. Watch the **top-right corner** during the entire connection flow:

| Step | Expected Indicator |
|---|---|
| Before connecting | (not visible — connect screen) |
| After entering code | ⏳ Connecting... |
| During ICE exchange | ⏳ Establishing direct connection... |
| WebRTC succeeds (same LAN) | 🟢 Direct (Local) |
| WebRTC fails (different network) | 🔴 Relay |
| DataChannel drops mid-session | 🔴 Relay |
| Kill the relay server | 🟡 Reconnecting... |
| Rejoin window expires | ❌ Connection Lost |

Pass if: Indicator updates correctly at each stage

---

## Test 20: Reconnect After WebRTC Session

1. Connect on the same LAN → 🟢 Direct (Local)
2. **Close the browser tab** (disconnect the client)
3. Host CLI: `Client disconnected. Rejoin window: 2 minutes.`
4. Reopen `http://localhost:8080` and enter the **same code** within 2 minutes
5. A **new ECDH handshake** occurs, then **new WebRTC negotiation**
6. You should see 🟢 Direct (Local) again
7. Host CLI: `Client reconnected.` followed by new WebRTC logs
8. Type in the terminal → Works normally

Pass if: Reconnect re-establishes WebRTC, indicator returns to 🟢

---

## Test 21: Read-Only Mode with WebRTC

1. Start host with `node index.js --readonly`
2. Connect on the same LAN → Should show 🟢 Direct (Local)
3. The **👁 View Only** badge should be visible
4. Try typing → **Nothing happens** (keystrokes blocked on both WebRTC and relay paths)
5. Resize should still work
6. Paste button should be hidden

Pass if: Read-only enforcement works identically over WebRTC

---

## Test 22: Multiple Sessions with WebRTC

1. Start host: `node index.js`
2. Type `n` → Create a second session
3. Connect **two browser tabs** to each code
4. Both sessions should independently negotiate WebRTC
5. Both should show 🟢 Direct (Local) if on same LAN
6. Each session's WebRTC logs appear prefixed with the session code
7. Kill one session → Other continues working
8. Type `l` → Both sessions listed with correct status

Pass if: Each session has its own independent WebRTC DataChannel

---

## Test 23: WebRTC Signaling Messages in Relay

1. Connect normally and watch the **relay server terminal**
2. You should see the standard session logs (no new WebRTC-specific logs in relay)
3. The relay simply forwards `signal` messages like any other message
4. Verify in **browser DevTools → Network → WS → Messages** that signaling messages are encrypted:
   - `{ "type": "signal", "payload": "A2h8J...<encrypted_base64_blob>" }`
5. The relay server cannot read the `offer`, `answer`, or `ice` candidates (which protects local IP address privacy).

Pass if: Signaling messages flow through relay, relay doesn't inspect them

---

# Quick Reference: All Error Messages

| Scenario | Where | Message |
|---|---|---|
| Code expired | Browser | Invalid or expired code |
| Session full | Browser | Session already in use |
| Rate limited | Browser | Too many attempts. Try again in 60 seconds. |
| Host Ctrl+C / quit | Browser terminal | Host ended the session. |
| Shell exits | Browser terminal | Shell exited. Session ended. |
| Connection lost | Browser terminal | Connection lost. Attempting to reconnect... |
| Rejoin expired | Browser terminal | Session has ended. |
| Reconnected | Browser terminal | Reconnected |
| Client disconnected | Host CLI | Client disconnected. Rejoin window: 2 minutes. |
| Client reconnected | Host CLI | Client reconnected. |
| Rejoin expired | Host CLI | Rejoin window expired. Session ended. |
| WebRTC initiating | Host CLI | [WebRTC] Initiating peer connection... |
| Same LAN detected | Host CLI | [WebRTC] Same LAN detected — waiting for DataChannel... |
| DataChannel open | Host CLI | [WebRTC] DataChannel open — relay bypassed |
| Not same LAN | Host CLI | [WebRTC] Not on same LAN — using relay |
| DataChannel closed | Host CLI | [WebRTC] DataChannel closed — falling back to relay |
| Peer aborted WebRTC | Host CLI | [WebRTC] Peer aborted WebRTC — using relay |

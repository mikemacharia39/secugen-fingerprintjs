# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based fingerprint capture app for the **SecuGen HU20** scanner, using the **WebUSB API** — no SDK, no local server, no extension. Chrome/Edge only. The USB protocol was reverse-engineered from USBPcap/Wireshark captures; nothing comes from official SecuGen documentation.

## Running

Serve from a local HTTP server (WebUSB is blocked on `file://`):

```
npx serve .
# or
python -m http.server 8080
```

Open `http://localhost:8080` in Chrome or Edge.

## Structure

```
index.html      Main UI — connection state, canvas, buttons, debug log
src/
  secugen.js    SecuGenScanner class — all USB protocol logic (ES module)
  archive/      Original experimental HTML files kept for protocol reference
```

## Architecture

`SecuGenScanner` (in `src/secugen.js`) is an `EventTarget` class with three public methods:

- `autoConnect()` — checks `navigator.usb.getDevices()` for an already-paired device; no user gesture needed
- `requestConnect()` — opens the browser device picker; must be called from a click handler
- `capture()` → `ImageData` — runs the full initialization + two-frame capture sequence
- `setLED(on)` — control transfer request 17
- `rawCapture()` → `Uint8Array` — returns the raw 669,184-byte bulk transfer for debugging

`index.html` imports `SecuGenScanner` as an ES module and manages all UI state.

## USB Protocol

**Device:** Vendor ID `0x1162`, interface 0, bulk endpoint 2.

**Key request codes (all vendor-type control transfers):**

| Request | Direction | Purpose |
|---------|-----------|---------|
| 37 | IN | Poll device status (30 bytes, called 3× on init) |
| 34 | OUT then IN | Set register / read-back to confirm |
| 17 | OUT | LED on (`value=0x1`) / off (`value=0x0`) |
| 5  | OUT | Flush / reset |
| 64 / 65 | OUT | Quad-byte commands (timing / window setup) |
| 1 / 2 | OUT | Arm / stop capture |
| 8  | IN | Read 2-byte status after calibration flush |
| 22 | IN | Read 4-byte status during live-capture setup |

**Capture sequence:**
1. `#initialize()` — ~50 `setParam()` calls (registers 0x03–0xb9) followed by calibration flush + `in8()`
2. `#armCapture()` (request 1) → `#bulkRead()` — 669,184 bytes, first frame discarded
3. `#setupLiveCapture()` — sets timing registers, turns LED on, reads `in22()` twice
4. `#armCapture()` → `#bulkRead()` — second frame, decoded as 300×400 greyscale image

**Image decoding:** The bulk transfer is exactly 1,307 × 512-byte USB packets. The first `300 × 400 = 120,000` bytes are taken as greyscale pixels and converted to RGBA. If capture produces a black or noisy image, the pixel data may start at a non-zero offset — use `rawCapture()` and inspect the bytes in the console.

## Key Constraints

- Windows requires rebinding the device to **WinUSB** via Zadig — SecuGen's SDK driver blocks WebUSB access. See README for full steps.
- The initialization parameter table was captured from one specific device session; some register semantics are unknown.
- No fingerprint matching — raw image only.

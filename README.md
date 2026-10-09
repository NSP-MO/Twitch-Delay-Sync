# Twitch Delay Sync

A lightweight, high-performance Chromium browser extension (Manifest V3) designed to continuously monitor broadcaster latency on Twitch live streams and automatically synchronize playback to the live edge whenever delay exceeds a configurable threshold.

## Architectural Overview

Twitch live video streaming operates on low-latency HTTP Live Streaming (HLS). Over extended viewing sessions, network fluctuations, buffer bloat, or background tab throttling can cause the player to accumulate latency drift (falling 5 to 15 seconds behind the live broadcast).

Twitch Delay Sync resolves this latency drift via direct micro pause-and-play on the HTML5 video pipeline without reloading the stream, triggering HLS manifest re-fetches, or inducing loading spinners. Chat messages, interactive panels, and session state remain completely uninterrupted.

### Execution Contexts & IPC Model

Manifest V3 enforces strict execution context isolation between extension APIs and host web pages. The extension employs a decoupled dual-world architecture:

1. **Main World Context (`content/main-world.js`)**:
   - Executes directly within Twitch's execution environment (`world: "MAIN"`).
   - Traverses React Fiber component hierarchies on player elements (`[data-a-target="video-player"]`, `.video-player__container`) to interface with Twitch's internal player instance.
   - Extracts exact broadcaster latency (`player.getStats().latency` or `player.getLatency()`) and buffer metrics.
   - Implements direct micro pause-and-play synchronization: pauses the HTML5 video element for a 20ms frame cycle and immediately resumes at the freshest decoded buffer edge, eliminating presentation lag without loading delays or stream restarts.
   - Relays real-time telemetry to the isolated world via structured `window.postMessage` IPC.

2. **Isolated World Bridge (`content/isolated.js`)**:
   - Operates in standard extension isolation with full access to `chrome.storage.local` and `chrome.runtime`.
   - Bridges communication between the Main World script, background service worker, and popup interface.
   - Handles runtime setting updates dynamically without requiring page refreshes.

3. **Background Service Worker (`background/service-worker.js`)**:
   - Manages default storage schema initialization upon installation.
   - Renders live latency badges on the extension action icon in the browser toolbar.

4. **Popup Controller (`popup/`)**:
   - Compact Dark Modern interface (`#1f1f1f`) providing real-time telemetry readouts, threshold steppers, quick presets, and immediate manual sync triggers.

---

## Key Features

- **Micro Pause-and-Play Synchronization (Primary)**: The primary synchronization engine that instantly aligns playback to the freshest live edge while preserving a 0.5s buffer cushion and constant 1.00x playback speed. Eliminates buffer depletion, loading spinners, and audio pitch artifacts without stream reload.
- **Configurable Max Delay Threshold**: Set maximum permitted delay (e.g., 2.0s, 2.5s, 3.0s) with step increments and one-click presets.
- **Adaptive Speed Catch-up**: Proactively accelerates playback using micro-stepped gradual ramping (1.05x–1.08x) with property-level anti-thrashing interception to eliminate audio popping. Includes a dynamic buffer starvation guard that drops playback to 1.00x whenever forward buffer drops below the safety threshold.
- **Hard Resync Threshold**: User-defined latency limit (default 5.0s) that switches operation from gradual speed catch-up to immediate live edge resync when stream lag is substantial.
- **Cooldown Protection**: Enforces a configurable pause interval (default 10s) following each sync action to prevent cyclic resets during network buffer stabilization.
- **Zero Content Security Policy Violations**: Complies strictly with Chromium Manifest V3 security requirements (zero inline handlers, zero `eval` or dynamic code constructors).

---

## Installation

1. Clone or download this repository to a local directory.
2. Open a Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Vivaldi, Opera).
3. Navigate to the Extensions management page:
   - Chrome / Brave: `chrome://extensions`
   - Edge: `edge://extensions`
4. Toggle **Developer mode** in the top-right corner.
5. Click **Load unpacked** and select the root directory of this extension.
6. The extension icon will appear in your browser toolbar.

---

## Configuration Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `Auto-Sync` | Boolean | `Enabled` | Automatically initiates live edge synchronization via micro Pause-and-Continue when measured latency exceeds the maximum delay threshold. |
| `Max Allowed Delay` | Float (seconds) | `3.0s` | Maximum permitted latency to broadcaster before synchronization triggers (configurable in 0.1s increments down to 0.5s minimum). |
| `Adaptive Catch-up` | Boolean | `Enabled` | Smoothly ramps playback rate in subtle micro-steps (1.05x–1.08x) when latency drifts, returning smoothly to 1.0x. Features dynamic buffer starvation guard. |
| `Hard Resync Threshold` | Float (seconds) | `5.0s` | Latency limit where gentle playback catch-up is bypassed in favor of immediate live resync (configurable in 0.1s increments). |
| `Cooldown Period` | Integer (seconds) | `10s` | Minimum pause duration between automated synchronization events to permit buffer stabilization. |

---

## Technical Specifications

- **Manifest Format**: Manifest V3
- **Supported Hosts**: `https://www.twitch.tv/*`
- **Permissions**: `storage`
- **UI Color System**: Dark Modern (`#1f1f1f` canvas, `#252526` headers, `#2d2d2d` cards, `#007acc` accent)

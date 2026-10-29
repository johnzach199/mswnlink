# mswnlink

A local-network remote desktop application for Windows, macOS, and Linux.

## Run from source

Requires Node.js 22.12 or newer and npm.

```bash
npm install
npm start
```

## Responsive UI

The app selects its initial window size from the current display work area. It responds to compact window widths by moving navigation to a top row, stacking the connection/share panels, wrapping session controls, and allowing the content region to scroll without clipping. Height breakpoints also reduce vertical spacing and viewer preview height. The light/dark theme toggle is retained.

## Build standalone applications

```bash
npm run dist:fedora
npm run dist:win
npm run dist:mac
```

For release builds, run **Build and Publish mswnlink Executables** in GitHub Actions from the `main` branch. The workflow builds a Fedora/Linux x64 AppImage, a portable Windows x64 EXE, a macOS Intel x64 DMG, and a macOS Apple Silicon arm64 DMG. Every `electron-builder` packaging script uses `--publish never`; a separate workflow job handles release uploads with `GITHUB_TOKEN`.

## macOS signing

When all five Apple Developer ID/App Store Connect secrets are configured, macOS builds are signed, notarized, and verified. If credentials are absent or signing/verification fails, the workflow falls back to a clearly labelled `UNSIGNED-TEST-ONLY` DMG with a warning file. That DMG is kept in workflow artifacts and attached to the release instead of being silently skipped; Gatekeeper may still block it. For trusted distribution, configure signing/notarization as described in `MAC-SIGNING-SETUP.md`.

## Native input

The workflow installs the X11/XTest development headers and compiles the RobotJS native backend on each target runner. Fedora Wayland interaction additionally depends on the host desktop's Remote Desktop portal permissions.


## Share page navigation fix (v0.2.2)

Page navigation is now bound synchronously before asynchronous operating-system IPC initialization begins. The renderer explicitly updates each page's active class, `hidden` property, and `aria-hidden` state, so the Share this PC page remains reachable even if display-source permission APIs respond slowly or fail.

The GitHub Actions workflow is included at `.github/workflows/main.yml`. Run it manually on `main` for test artifacts; leave `release_tag` empty until the platform builds pass.


## Reliability fixes in v0.2.6

- Clipboard sharing is enabled by default on a fresh install, persists its local toggle, and syncs plain text while a session is connected when both computers have it enabled. It polls every 180 ms and avoids echo loops; it does not copy an existing clipboard just because a session starts.
- Correct RobotJS key names are used for modifiers and numpad operators. Remote input is released on pointer cancellation, focus loss, page hiding, and host input errors to recover from stuck mouse buttons after Task Manager/window switching.
- Long sessions use a temporary Electron power-save blocker; the fullscreen viewer attempts to resume video and recover a stalled HTML video decoder. Multi-display compositing is frame-rate capped to avoid running at the monitor's unconstrained refresh rate.
- Wrong passcodes no longer lock the address out after five attempts. Incorrect attempts receive only a short, capped response delay; use a strong permanent passphrase and keep the listener restricted to your trusted LAN.
- On Windows and Linux X11, monitor mapping uses Electron display ids and guarded fallbacks. Linux Wayland/PipeWire may expose only a single combined capture source, depending on the desktop portal/Electron version; mswnlink cannot switch between physical monitors separately when the OS exposes only one source.
- macOS DMGs are retained in GitHub release uploads. If signing is unavailable or fails, the workflow falls back to a clearly named `UNSIGNED-TEST-ONLY` DMG and includes a warning file. That permits testing/download, but Gatekeeper may block it; a trusted public release still needs valid Developer ID signing and notarization.


## Reliability fixes in v0.2.4

- Windows/Linux remote input is serialized to preserve key and button order while coalescing high-frequency pointer moves. Stuck input is released on viewer focus loss, pointer cancellation, window/page hiding, and input backend errors. RobotJS key names used for left/right modifiers and numpad keys match its supported key list. Windows privilege boundaries still apply: control of elevated/system desktops cannot be guaranteed from a normal-user app.
- A session power-save blocker and a remote-video watchdog reduce long-session fullscreen stalls; the video element is restarted if it stops rendering frames while the peer remains live.
- Clipboard text sync runs automatically about every 180 ms when both peers enable clipboard sharing; large text is fragmented over the data channel and reconstructed before applying. Manual send/get buttons remain legacy-compatible but are not required for normal copy/paste.
- Incorrect access codes no longer trigger a fixed attempt limit or lockout. A short, capped response delay remains to discourage automated guessing. Use a strong permanent passphrase and keep connections on a trusted LAN.
- Monitor selection uses Electron display ids when available. Fedora/Wayland may expose one combined screen source through PipeWire, in which case separate physical monitor selection is constrained by the OS portal.
- macOS DMGs are no longer silently removed from release assets: if signing or notarization is unavailable, a named unsigned test DMG plus warning text is uploaded. It may still be blocked by Gatekeeper; a trusted public download requires valid Developer ID signing and notarization.

## Clipboard and keyboard troubleshooting

Live plain-text clipboard synchronization is enabled by default on first launch and can be switched off on either computer. The setting is saved per device. Both computers must have clipboard sharing enabled for automatic copy/paste. Clipboard changes are checked frequently while a WebRTC data channel is connected; clipboard text is exchanged only during an active session.

On a Windows host, normal printable ASCII keystrokes are injected as characters so the host keyboard layout does not reinterpret a remote physical key code. Modifier shortcuts (for example Ctrl+C/Ctrl+V), navigation keys, and function keys use native key-down/key-up injection. Windows secure desktop/UAC prompts and elevated apps may still require the local user to interact with them directly.

If keyboard input still does not reach the host, reconnect using **Allow control**, confirm the host shows mouse/keyboard control as enabled, and inspect the host terminal for `[mswnlink] Could not inject input` messages. If clipboard sync appears idle, confirm the clipboard toggle is enabled on both devices.



## v0.2.6 keyboard and clipboard changes

- Remote keyboard capture is installed once at app startup rather than during each peer creation, avoiding lost or duplicate handlers after reconnects.
- On Windows hosts, unmodified printable ASCII input uses RobotJS character injection so typing from Fedora/Windows is less dependent on the source keyboard layout. Modifier shortcuts, navigation, and function keys continue to use native key down/up events.
- Clipboard sync is enabled by default on fresh installs, can be disabled on either device, and remembers each device's setting. Text changes are detected at 180 ms intervals while connected. Both ends must allow clipboard sync; no clipboard data is transferred outside an active session.
- The unsigned macOS workflow now unsets signing variables instead of setting them to empty strings, preventing electron-builder from interpreting an empty certificate path as a workspace directory.

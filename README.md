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


## Reliability fixes in this build

- Clipboard sharing is automatic while a session is connected, only when both computers have enabled it. It polls for text changes and avoids echo loops; it does not copy an existing clipboard on session startup.
- Correct RobotJS key names are used for modifiers and numpad operators. Remote input is released on pointer cancellation, focus loss, page hiding, and host input errors to recover from stuck mouse buttons after Task Manager/window switching.
- Long sessions use a temporary Electron power-save blocker; the fullscreen viewer attempts to resume video and recover a stalled HTML video decoder. Multi-display compositing is frame-rate capped to avoid running at the monitor's unconstrained refresh rate.
- Wrong passcodes no longer lock the address out after five attempts. Incorrect attempts receive only a short, capped response delay; use a strong permanent passphrase and keep the listener restricted to your trusted LAN.
- On Windows and Linux X11, monitor mapping uses Electron display ids and guarded fallbacks. Linux Wayland/PipeWire may expose only a single combined capture source, depending on the desktop portal/Electron version; mswnlink cannot switch between physical monitors separately when the OS exposes only one source.
- macOS DMGs are retained in GitHub release uploads. If signing is unavailable or fails, the workflow falls back to a clearly named `UNSIGNED-TEST-ONLY` DMG and includes a warning file. That permits testing/download, but Gatekeeper may block it; a trusted public release still needs valid Developer ID signing and notarization.


## Reliability fixes in v0.2.4

- Windows/Linux remote input is serialized to preserve key and button order while coalescing high-frequency pointer moves. Stuck input is released on viewer focus loss, pointer cancellation, window/page hiding, and input backend errors. RobotJS key names used for left/right modifiers and numpad keys match its supported key list. Windows privilege boundaries still apply: control of elevated/system desktops cannot be guaranteed from a normal-user app.
- A session power-save blocker and a remote-video watchdog reduce long-session fullscreen stalls; the video element is restarted if it stops rendering frames while the peer remains live.
- Clipboard text sync runs automatically about every 400 ms only when both peers enable clipboard sharing; large text is fragmented over the data channel and reconstructed before applying. Manual send/get buttons remain legacy-compatible but are not required for normal copy/paste.
- Incorrect access codes no longer trigger a fixed attempt limit or lockout. A short, capped response delay remains to discourage automated guessing. Use a strong permanent passphrase and keep connections on a trusted LAN.
- Monitor selection uses Electron display ids when available. Fedora/Wayland may expose one combined screen source through PipeWire, in which case separate physical monitor selection is constrained by the OS portal.
- macOS DMGs are no longer silently removed from release assets: if signing or notarization is unavailable, a named unsigned test DMG plus warning text is uploaded. It may still be blocked by Gatekeeper; a trusted public download requires valid Developer ID signing and notarization.

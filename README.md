# mswnlink

**A small, consent-first remote-desktop starter for trusted local networks.** mswnlink lets one computer share its screen and lets another computer view it directly over the LAN. The host decides whether the session is view-only or includes mouse and keyboard control.

> **Status:** v0.1 prototype/source project. The flow and UI are implemented, but it has not yet been runtime-tested on Windows, macOS, and Linux in this environment. Treat it as a development build, not as a security-audited production remote-access product.

## Browser Edition (no installation)

A no-install, single-file browser version is included in `browser-only/index.html`. Copy that folder to both computers and open `index.html` in a recent desktop browser. It shares the host screen using the browser's permission prompt and WebRTC directly over the LAN; there is no signaling server and no STUN/TURN relay. Pairing is done by manually transferring the generated offer and answer text/files between the two devices.

**Browser Edition is view-only.** A website cannot inject mouse/keyboard events into the operating system, so full remote control still requires the desktop app/native helper. Screen capture also depends on browser support for `getDisplayMedia` and secure-context policy. If a browser does not allow screen capture from a local file, it must be served from a trusted HTTPS origin.

A standalone archive is also available as `mswnlink-browser-only.zip` when downloaded from the project distribution location. The desktop app below remains the full-control edition.

## What is in this first version?

- Dark, lightweight-feeling dashboard with separate **Connect** and **Share this PC** screens.
- Direct WebRTC screen streaming, with no STUN server, cloud account, or public relay configured.
- Temporary six-digit pairing code (valid while sharing is active) and a host-side approval prompt for every connection.
- Host chooses **View only** or **Allow control**, and can revoke input permission or disconnect the viewer at any time.
- LAN-only incoming WebSocket signaling: public/non-private source addresses are rejected.
- Pairing uses a fresh random challenge, PBKDF2-derived HMAC proof, and HMAC-signed signaling messages; the PIN is not sent over the network as plaintext.
- Native input bridge through RobotJS.
- Standalone build targets: Fedora/Linux AppImage, Windows portable EXE, and macOS DMG (Intel and Apple Silicon builds).

## Quick start from source

### Requirements

- Node.js 22.12 or newer and npm (development/building only; **not required to run a packaged app**).
- Internet access during first setup so npm can download dependencies.
- A supported desktop session on each computer.

### Run the app (screen sharing / view-only)

```bash
cd mswnlink
npm install
npm start
```

On Linux Wayland sessions, `npm start` uses `--ozone-platform=x11` (XWayland) to avoid a native Wayland/Vulkan incompatibility reported by some Electron/Chromium graphics stacks. The old command `MSWNLINK_USE_WAYLAND=1 npm start` now also falls back to XWayland for compatibility. To explicitly experiment with native Wayland, use `MSWNLINK_FORCE_NATIVE_WAYLAND=1 npm start`; this is experimental and Chromium may still print the Vulkan warning. That warning alone does not prove the app crashed. If screen sharing fails, check the desktop's PipeWire and `xdg-desktop-portal` services as described below.

If the terminal prints `MESA-LOADER: failed to open dri ... Permission denied`, that line can be a non-fatal graphics-driver warning by itself; first check whether the app window opens and test **Share this PC**. If Electron will not open, shows a blank window, or graphics initialization appears to be the blocker, stop it and try the optional software-rendering fallback:

```bash
MSWNLINK_DISABLE_GPU=1 npm start
```

This disables GPU acceleration and Vulkan-related features before Electron starts, which can help isolate Mesa/GBM driver issues but may reduce rendering performance. The setting is optional and does not fix a broken screen-capture portal.

If screen capture still fails, make sure XWayland is installed and that your desktop's screen-capture portal and PipeWire services are working. On Fedora, the portal backend package depends on your desktop: GNOME commonly uses `xdg-desktop-portal-gnome`, KDE Plasma uses `xdg-desktop-portal-kde`, and GTK-based desktops may use `xdg-desktop-portal-gtk`. Do not install all backends blindly; use the one for your desktop environment. Restarting the portal/PipeWire user services or logging out and back in may be needed after installing missing components.

Run `npm run check` to verify the JavaScript syntax before launching. The native mouse/keyboard backend (RobotJS) is optional: **a missing Linux X11 development header will no longer make `npm install` fail**. If RobotJS cannot be loaded, mswnlink still starts for screen sharing/view-only sessions and the UI disables the remote-control option.

### Enable mouse and keyboard control on Linux (optional)

Install the build tools and X11/XTEST headers that RobotJS needs, using the command for your distribution:

```bash
# Fedora
sudo dnf install gcc-c++ make python3 libXtst-devel libX11-devel libXext-devel

# Debian / Ubuntu
sudo apt-get install build-essential python3 libxtst-dev libx11-dev libxext-dev

# openSUSE
sudo zypper install gcc-c++ make python3 libXtst-devel libX11-devel libXext-devel
```

Then, from the project directory, rebuild the native module for Electron:

```bash
npm run rebuild:native
```

If this rebuild still fails, the app can be used in view-only mode; copy the last 30 lines of the error output to troubleshoot the specific Linux distribution or desktop session. RobotJS input works best under X11; Wayland support depends on the compositor and permissions.

On Windows and macOS, `npm install` also completes without forcing a native rebuild. To enable remote input, run `npm run rebuild:native` with the relevant platform build tools installed. macOS still requires the user to grant Screen Recording and Accessibility permissions.

### Connect two computers

1. Put both computers on the same trusted local network.
2. On the computer you want to access, open **Share this PC**, choose the display, and click **Start sharing**.
3. Copy one of the listed LAN addresses and the temporary pairing code.
4. On the other computer, open **Connect**, enter the address and code, then click **Connect to desktop**.
5. On the host, approve the request as **View only** or **Allow control**. The host can revoke control or disconnect the viewer from the Share screen.
6. Click the remote video before typing. End the session from the viewer or host.

Both computers need to permit connections on TCP port **49382** on their private network. Do not disable the firewall globally. If the host's firewall asks, allow mswnlink on private/trusted networks only.

## Standalone executables (end users do not need Node.js)

The release build creates standalone downloads with Electron's runtime bundled in, so you do not need to install Node.js, npm, or development tools on the computer where you run mswnlink:

- **Fedora/Linux:** `mswnlink-fedora-0.1.0-x64.AppImage` — mark it executable and launch it. On Fedora Wayland sessions, the packaged launcher selects XWayland by default.
- **Windows:** `mswnlink-windows-0.1.0-x64.exe` — a portable executable; run it directly, without an installer.
- **macOS Intel:** `mswnlink-macos-0.1.0-x64.dmg`.
- **macOS Apple Silicon:** `mswnlink-macos-0.1.0-arm64.dmg`.

macOS uses an application bundle inside the DMG rather than one standalone binary. These builds are unsigned because no signing certificate has been configured; macOS may require the user to approve opening it, and Windows SmartScreen may show a warning for the unsigned portable EXE. Do not bypass warnings for builds from a source you do not trust.

### Build artifacts automatically

The GitHub Actions workflow in `.github/workflows/build.yml` builds each platform on a matching runner. If you maintain a copy of this project in a GitHub repository, open **Actions → Build mswnlink standalone apps → Run workflow**. Download the four workflow artifacts: Fedora x64, Windows x64, macOS Intel, and macOS Apple Silicon. Pushing a tag named `v*` (for example `v0.1.0`) builds the same files and publishes them as GitHub Release assets. See [BUILDING-RELEASES.md](BUILDING-RELEASES.md) for the one-time setup steps.

### Build locally from source (developers only)

Use Node.js 22.12+ and npm. The native mouse/keyboard backend must compile for the target platform if you want remote control; a package without RobotJS would have reduced functionality, so the automated release workflow intentionally fails if this native build fails.

```bash
npm install
npm run rebuild:native
npm run check

# Fedora/Linux AppImage
npm run dist:fedora

# Windows portable EXE (run on Windows)
npm run dist:win

# macOS DMG (run on macOS; produces the runner's architecture)
npm run dist:mac
```

Artifacts are written to `release/`. Build on the operating system where you intend to package the app. Native modules are compiled for that operating system and architecture; do not copy a Windows or macOS build from a Linux runner and expect it to work.

## Troubleshooting: stuck at “Connecting devices” / SessionDescription parse error

Use the same latest mswnlink source/build on both computers, then restart sharing and reconnect. The current handshake code explicitly converts WebRTC session descriptions and ICE candidates to plain JSON data before sending them over Electron IPC and the LAN signaling WebSocket. This prevents browser host objects from arriving as empty or incomplete descriptions. If SDP parsing still fails, the app now logs only the offer/answer type and SDP length (not the full SDP) and reports the negotiation failure instead of leaving the viewer stuck on the connecting screen.

If the app gets past SDP negotiation but then times out, confirm both computers are on the same reachable LAN and allow mswnlink's TCP signaling port 49382 through the host firewall. WebRTC media also requires the local ICE candidate ports negotiated between peers; some guest Wi-Fi networks and access points isolate wireless clients. No public STUN/TURN server is configured in this LAN-only prototype.

## OS notes and limitations

- **Windows:** normal desktop use should work after allowing the app through the private-network firewall prompt.
- **macOS:** approve Screen Recording permissions for capture and Accessibility permissions for mouse/keyboard input in System Settings. Those are operating-system security requirements; the app does not bypass them.
- **Linux:** `npm start` uses XWayland when it detects a Wayland session to avoid the native Wayland/Vulkan incompatibility. `MSWNLINK_USE_WAYLAND=1 npm start` also falls back to XWayland; native Wayland is available only as an experimental mode via `MSWNLINK_FORCE_NATIVE_WAYLAND=1 npm start`. If capture still fails, verify XWayland plus the desktop's `xdg-desktop-portal` backend and PipeWire are installed/running. For RobotJS input, install the X11/XTEST development packages listed above and run `npm run rebuild:native`; native input is best suited to X11 and may not work in a Wayland session. Test on the actual desktop environment before relying on remote control.
- The current input mapping is aimed at the primary display. Multi-monitor coordinate mapping may need additional work.
- The first version supports one viewer at a time and does not include audio, file transfer, clipboard sync, unattended startup, remote wake, or automatic device discovery. Enter the LAN IP/hostname manually.
- IPv4 addresses and hostnames are supported in the connect form; IPv6 literals are not yet supported.
- Electron includes its own Chromium/Node runtime, so each standalone build is larger than a native application. The end-user artifacts bundle the runtime so Node.js/npm do not need to be installed separately.

## Security model (please read)

mswnlink is designed for a **trusted private LAN**. The application has no public relay or cloud account. Screen video and the WebRTC data channel use WebRTC's encrypted transport, while the signaling messages are HMAC-authenticated against the pairing-derived session key so a passive observer does not learn the PIN directly and unauthenticated edits to signaling messages are rejected. The PIN is short-lived and the host must still approve the connecting device.

However, this prototype's WebSocket signaling transport is **not TLS-encrypted**, so signaling metadata (including local addresses and WebRTC offer/answer data) can be visible to someone who can capture traffic on the same network. The six-digit code also remains a low-entropy secret; challenge derivation slows offline guessing but does not make a six-digit code equivalent to a certificate. Do not use this prototype across an untrusted network or expose port 49382 to the internet. Before production use, add audited pairing/key-verification and encrypted signaling (for example, pinned TLS certificates) and test against a documented threat model.

The host-side approval and visible sharing controls are intentional: mswnlink has no stealth mode, unattended access, persistence-on-boot, or hidden input channel.

## Useful references

- Electron screen capture API: https://www.electronjs.org/docs/latest/api/desktop-capturer
- RobotJS install and platform permissions: https://robotjs.dev/docs/
- Electron releases: https://releases.electronjs.org/

## License

MIT; see [LICENSE](LICENSE).


## Fullscreen remote viewer

The remote viewer fullscreen layout expands to the full viewport. The video stage uses the remaining height after its toolbar/header, and the remote image uses `object-fit: contain` so the far desktop is not cropped when its aspect ratio differs from the local display. Press `Esc` to leave fullscreen. The same fit-to-viewport fix is included in Browser Edition.

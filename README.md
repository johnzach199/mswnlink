# mswnlink

**A lightweight remote-desktop application for trusted local networks.** mswnlink lets devices discover each other on the LAN, share a screen directly, and use the remote desktop with mouse and keyboard when the host’s access policy and operating-system permissions allow it.

> **Status:** v0.1 prototype/source project. The flow and UI are implemented, but it has not yet been runtime-tested on Windows, macOS, and Linux in this environment. Treat it as a development build, not as a security-audited production remote-access product.

## Browser Edition (no installation)

A no-install, single-file browser version is included in `browser-only/index.html`. Copy that folder to both computers and open `index.html` in a recent desktop browser. It shares the host screen using the browser's permission prompt and WebRTC directly over the LAN; there is no signaling server and no STUN/TURN relay. Pairing is done by manually transferring the generated offer and answer text/files between the two devices.

**Browser Edition is view-only.** A website cannot inject mouse/keyboard events into the operating system, so full remote control still requires the desktop app/native helper. Screen capture also depends on browser support for `getDisplayMedia` and secure-context policy. If a browser does not allow screen capture from a local file, it must be served from a trusted HTTPS origin.

A standalone archive is also available as `mswnlink-browser-only.zip` when downloaded from the project distribution location. The desktop app below remains the full-control edition.

## Features in this build

- Simple dashboard with **Light mode / Dark mode** and separate **Connect** and **Share this PC** screens.
- Direct WebRTC screen streaming, with no STUN server, cloud account, or public relay configured.
- Owner-configured permanent access code (8–64 characters), saved via Electron safeStorage and retained when sharing stops/restarts; host-side approval remains the default; the host can explicitly enable unattended access to allow a correct passcode to connect with full input control while sharing is active.
- The host chooses **View only** or **Allow control** for ordinary connections. Optional **Unattended access** is off by default; the owner can enable it on that computer to auto-connect correct-passcode holders with mouse/keyboard control while sharing is active, then disable it or disconnect at any time.
- LAN-only incoming WebSocket signaling: public/non-private source addresses are rejected.
- Pairing uses a fresh random challenge, PBKDF2-derived HMAC proof, and HMAC-signed signaling messages; the passcode is not sent over the network as plaintext.
- Native input bridge through RobotJS on Windows/macOS/X11, plus the XDG Desktop Portal RemoteDesktop API on Linux Wayland. On Fedora Wayland, the owner must approve the system portal prompt; persistent portal permission is restored where the desktop supports it.
- Automatic LAN discovery over UDP port 49383, plus direct WebRTC screen/video and input data-channel connections.
- Session quality presets: Balanced, Smooth, and Sharper; viewers can use Auto to adapt the host's encoding profile based on packet loss and latency.
- Optional plain-text clipboard sharing and file transfer (up to 100 MiB); both sides must enable each feature, and incoming files use a native save dialog.
- Remote display selection, plus an all-displays side-by-side panorama when Electron exposes multiple screen sources.
- Standalone build targets: Fedora/Linux AppImage, Windows portable EXE, and macOS DMG (Intel and Apple Silicon builds).


## Permanent access code and stream quality

On **Share this PC**, set an owner-chosen passcode between 8 and 64 characters. Click **Save permanent code** before starting sharing. The app stores it through Electron `safeStorage` (using OS-backed encryption where supported) and reuses it when you start sharing again; it does not generate a new code each session. You can change it at any time. If you change the code while hosting, new connections must use the new code; an already active session may continue until disconnected. On Linux, Electron may report the `basic_text` backend if a desktop keyring isn't available; the UI warns that this backend doesn't protect the saved passcode well. Prefer GNOME Keyring/libsecret or KWallet.

Before sharing, choose **Balanced** (1080p/30 FPS), **Smooth** (up to 1080p/60 FPS), or **Sharper** (up to 1440p/30 FPS). Actual resolution and frame rate depend on the source display and host computer. The sender requests a higher LAN bitrate and prioritizes retaining resolution; that may use more CPU/network bandwidth on the higher quality presets.

Remote mouse/keyboard control requires the host's authorization. By default the host selects **Allow control** in the incoming request and can revoke it or disconnect at any time. If the owner explicitly enables **Unattended access** on the Share screen, a valid permanent passcode can skip the in-app approval dialog and connect with control while sharing is active. Native input uses RobotJS on Windows/macOS/X11 and the XDG Desktop Portal RemoteDesktop API on Linux Wayland. Wayland access is always subject to the desktop's OS permission dialog; mswnlink cannot bypass that security gate.

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
3. On first use, set a permanent access code on **Share this PC** and save it. It remains the same across app restarts until you change it. Copy one of the listed LAN addresses and the permanent code.
4. On the other computer, open **Connect**, enter the address and passcode, then click **Connect to desktop**.
5. On the host, approve the request as **View only** or **Allow control**. The host can revoke control or disconnect the viewer from the Share screen.
6. Click the remote video before typing. End the session from the viewer or host.

Both computers need to permit connections on TCP port **49382** on their private network. Do not disable the firewall globally. If the host's firewall asks, allow mswnlink on private/trusted networks only.

## Standalone executables (end users do not need Node.js)

The release build creates standalone downloads with Electron's runtime bundled in, so you do not need to install Node.js, npm, or development tools on the computer where you run mswnlink:

- **Fedora/Linux:** `mswnlink-fedora-0.1.0-x64.AppImage` — mark it executable and launch it. On Fedora Wayland sessions, the packaged launcher selects XWayland by default.
- **Windows:** `mswnlink-windows-0.1.0-x64.exe` — a portable executable; run it directly, without an installer.
- **macOS Intel:** `mswnlink-macos-0.1.0-x64.dmg`.
- **macOS Apple Silicon:** `mswnlink-macos-0.1.0-arm64.dmg`.

macOS uses an application bundle inside the DMG rather than one standalone binary. macOS builds must be signed and notarized using the configured Apple Developer secrets, otherwise Gatekeeper may report them as damaged or from an unidentified developer. Windows SmartScreen can still warn about a portable EXE that is not signed with a trusted Windows code-signing certificate. Do not bypass warnings for builds from a source you do not trust.

### Build artifacts automatically

The GitHub Actions workflow in `.github/workflows/main.yml` builds each platform on a matching runner. If you maintain a copy of this project in a GitHub repository, open **Actions → Build mswnlink standalone apps → Run workflow**. Download the four workflow artifacts: Fedora x64, Windows x64, macOS Intel, and macOS Apple Silicon. Pushing a tag named `v*` (for example `v0.1.0`) builds the same files and publishes them as GitHub Release assets. See [BUILDING-RELEASES.md](BUILDING-RELEASES.md) for the one-time setup steps.

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
- **Linux:** `npm start` uses XWayland when it detects a Wayland session to avoid a native Wayland/Vulkan incompatibility. The actual remote-input backend detects the original desktop session: X11 uses RobotJS/XTEST, while native Wayland uses the XDG RemoteDesktop portal and requires the OS permission prompt. If capture or input fails, check XWayland, the appropriate `xdg-desktop-portal` backend, PipeWire, and the desktop's Remote Desktop permission. Test on the actual desktop environment before relying on remote control.
- One viewer can control a host at a time. Audio streaming, remote wake, and launching sharing automatically at system startup are not implemented.
- Multiple displays are selectable where Electron reports distinct screen sources. Some Linux Wayland/PipeWire portals expose one combined screen source; in that case the app cannot separately switch monitors and only offers the source supplied by the desktop.
- LAN device discovery requires UDP port 49383 broadcasts to be allowed between devices. TCP port 49382 is used for signaling; WebRTC also requires the local ICE media ports negotiated for each session. Guest Wi-Fi/client isolation can prevent peer-to-peer connections.
- IPv4 addresses and hostnames are supported in the manual connect form; IPv6 literals are not yet supported.
- Electron includes its own Chromium/Node runtime, so each standalone build is larger than a native application. The end-user artifacts bundle the runtime so Node.js/npm do not need to be installed separately.

## Security model (please read)

mswnlink is designed for a **trusted private LAN**. The application has no public relay or cloud account. Screen video and the WebRTC data channel use WebRTC's encrypted transport, while signaling messages are HMAC-authenticated against the passcode-derived session key so the passcode itself is not sent over the network and unauthenticated edits to signaling messages are rejected. The permanent passcode remains saved until its owner changes it. By default each connection needs host approval; when the owner deliberately enables unattended access, a correct passcode can authorize control while sharing is active.

However, this prototype's WebSocket signaling transport is **not TLS-encrypted**, so signaling metadata (including local addresses and WebRTC offer/answer data) can be visible to someone who can capture traffic on the same network. Use a long, unique permanent passphrase: although the challenge protocol derives a key with PBKDF2 and sends a proof instead of the passcode itself, a recorded exchange can still be used for offline guessing, so a weak code is not sufficient protection. Do not use this prototype across an untrusted network or expose port 49382 to the internet. Before production use, add audited pairing/key-verification and encrypted signaling (for example, pinned TLS certificates) and test against a documented threat model.

The host-side sharing controls remain visible. Unattended access is an explicit, host-configured option: it is disabled by default, does not start sharing at boot, and works only while the owner has started a sharing session. It is never a hidden input channel.

## Useful references

- Electron screen capture API: https://www.electronjs.org/docs/latest/api/desktop-capturer
- RobotJS install and platform permissions: https://robotjs.dev/docs/
- Electron releases: https://releases.electronjs.org/

## License

MIT; see [LICENSE](LICENSE).


## Fullscreen remote viewer

The remote viewer fullscreen layout expands to the full viewport. The video stage uses the remaining height after its toolbar/header, and the remote image uses `object-fit: contain` so the far desktop is not cropped when its aspect ratio differs from the local display. Press `Esc` to leave fullscreen. The same fit-to-viewport fix is included in Browser Edition.


### Fullscreen remote viewer

The remote viewer fullscreen mode now reserves the entire viewport for the remote video and hides the normal bottom toolbar while fullscreen is active. The video uses `object-fit: contain`, so the full remote display stays visible without cropping; use the floating **Exit full screen** control in the top-right or press `Esc`.

See [UPDATING.md](UPDATING.md) for the permanent-passcode and stream-quality changes and instructions for applying the changed files to an existing GitHub repository. Update both the host and viewer app builds together because this release accepts an 8–64 character owner-set passphrase rather than the old temporary six-digit code.


## Unattended access (optional)

On **Share this PC**, first save a strong permanent access passcode and start sharing. The **Unattended access** switch is off by default. When the host owner explicitly enables it, successful passcode authentication auto-connects the client with mouse and keyboard access and skips the in-app approval dialog for subsequent connections while sharing is active. The host can revoke control, disconnect the active viewer, disable unattended access, or stop sharing at any time. Enabling it is not a bypass of desktop OS permissions: Fedora/Wayland still prompts the host to grant the XDG RemoteDesktop portal permission (and may persist it only if the desktop supports that).

Only enable unattended access on a PC you own or administer, use a strong unique passphrase, and keep the firewall restricted to your LAN. Anyone who knows the passcode can control the host while unattended access and sharing are active.

## Fedora/Wayland input control

RobotJS/XTest cannot inject global input into native Wayland sessions. mswnlink now uses `dbus-next` to access `org.freedesktop.portal.RemoteDesktop` and `org.freedesktop.portal.ScreenCast` in a Wayland session. The desktop's permission dialog must allow keyboard and pointer control. The portal may issue a restore token and the app stores it with Electron `safeStorage`; if the desktop rejects persistent permissions, the owner may need to approve again. Ensure the desktop portal backend and PipeWire are installed and running for the desktop environment. This code path needs a live Fedora/Wayland test before production use.

## macOS distribution requirements

macOS `.dmg` files built without a Developer ID Application signature and Apple notarization are commonly blocked by Gatekeeper as “damaged” or from an unidentified developer. The GitHub workflow now fails early unless these repository Actions secrets are set:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate
- `MAC_CSC_KEY_PASSWORD`: password for the `.p12` certificate
- `APPLE_API_KEY`: base64-encoded App Store Connect `.p8` API key
- `APPLE_API_KEY_ID`: API key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

These credentials require an active Apple Developer Program membership and a Developer ID Application certificate. Never commit them into the repository or paste them into chat. Add them under **Repository Settings → Secrets and variables → Actions**. The Mac build configuration uses Hardened Runtime and required notarization; the workflow will not publish unsigned Mac packages as if they were production ready.

## Appearance

Use the **Dark mode / Light mode** button in the top-right corner to switch themes. Your choice is stored locally in the app and applied again the next time mswnlink opens.


## Linux-to-Linux remote input fixes (0.2.1)

This revision prefers the XDG portal `logical_size` for Wayland pointer coordinates (important on high-DPI/scaled displays), clamps absolute pointer coordinates to the stream bounds, serializes host-side input injection, and coalesces queued pointer moves so clicks and key events stay responsive. The viewer now restores keyboard focus when the remote track/data channel becomes ready and no longer silently drops ordinary key input just because focus shifted inside the active session.

On Fedora/GNOME Wayland, the host operating system still must grant the app Remote Desktop permission through the portal. If pointer/keyboard still do not work, collect the host terminal logs beginning with `[mswnlink] Wayland input session started` and the first `[mswnlink] Remote input` error. The app cannot bypass Wayland's OS-level permission prompt.


## LAN features and permissions

The **Devices on LAN** panel refreshes nearby mswnlink beacons automatically. Select a device to fill its address, then enter its saved passcode. The host must be sharing before the device can be connected. If discovery is blocked by your access point or firewall, enter the host's LAN IPv4 address manually.

For **clipboard sharing**, **file transfers**, and **monitor switching**, enable the same feature on both computers. These permissions reset to off when the app restarts, by design. Clipboard transfers are plain text only. File transfers are limited to 100 MiB, and the receiver chooses where each incoming file is saved.

For **All displays · side-by-side**, the viewer needs monitor switching enabled locally and the host must enable it too. It appears only when Electron returns more than one display source. Linux Wayland/PipeWire may supply only a single combined screen source. Pointer events in panorama mode are mapped to the corresponding display bounds; this path still needs multi-monitor testing on each target OS.

The **Auto** quality profile reads the viewer's WebRTC inbound video packet-loss statistics and selected candidate-pair RTT every few seconds, then asks the host to adjust its profile. Network stats can be unavailable briefly; the host keeps its current profile until usable stats arrive.

The host-side unattended-access switch remains **off by default**. The host owner must explicitly enable it after saving a permanent passcode. Correct passcode authentication can then connect without per-session in-app approval while sharing is active, but OS screen-recording/accessibility/RemoteDesktop permission requirements still apply. Keep unattended access disabled when it is not needed.


## Minimal frameless window

The desktop app uses a frameless Electron window with an integrated title strip and custom minimize/maximize/close controls. Its default Electron File/Edit/View menu is disabled to avoid the extra upper chrome shown by the native window frame. Closing the app quits the process; it does not leave unattended access running invisibly.

## macOS Gatekeeper

A source-code change cannot remove Apple's malware/Gatekeeper warning by itself. Direct macOS distribution requires a valid Developer ID Application certificate and successful Apple notarization. The release workflow requires the Apple signing/notarization secrets and validates the bundle signature, Gatekeeper assessment, and stapled notarization ticket. Unsigned artifacts are not suitable for public distribution.

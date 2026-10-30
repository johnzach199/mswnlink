# mswnlink

A simple remote desktop for computers on your local network. One computer shares its screen, another views and controls it, directly over the LAN. No account, no cloud, no relay.

Features: screen sharing with quality presets (clipboard sharing is on by default and can be switched off on either computer), mouse and keyboard control, optional "connect without asking" (unattended) access, nearby-computer discovery, clipboard sharing, file transfer, display switching, light and dark themes.

> Prototype software that has not been security-audited. Use it on networks you trust.

## Download

Get the newest build from [Releases](../../releases): Fedora/Linux AppImage, Windows portable `.exe`, and macOS DMGs (Apple Silicon `arm64`, Intel `x64`).

## Using it

1. On the computer you want to reach: **Share this PC** → save an access code → **Start sharing**.
2. On the other computer: **Connect**, enter the address and code (or pick the computer under *Nearby computers*).
3. By default the host approves each request as view-only or full control. Under **Permissions**, *Connect without asking* lets the correct code connect with full control and no approval. It needs an access code of **12 or more characters** and is off by default.

Both computers must allow TCP port **49382** (and UDP **49383** for discovery) on the private network.

## macOS: "Apple could not verify mswnlink is free of malware"

This is Apple's standard message for any app that has not been notarized, which needs a paid Apple Developer account. It does not mean the app contains malware. Pick one of these:

**Easiest: install from Terminal.** macOS only blocks files that a browser downloaded, so this installs mswnlink without any warning:

```
curl -fsSL https://raw.githubusercontent.com/johnzach199/mswnlink/main/scripts/install-mac.sh | bash
```

**Or approve the downloaded app once.** Open the app, click *Done*, then go to **System Settings › Privacy & Security**, scroll down, and click **Open Anyway** next to mswnlink. (On macOS 15 the old right-click › Open trick no longer works.) If it still says "damaged", run `xattr -cr /Applications/mswnlink.app`.

Then allow mswnlink under **Privacy & Security** for **Screen & System Audio Recording** (to share this Mac) and **Accessibility** (to let a remote computer move the mouse and type), and restart the app.

Builds are signed ad hoc and checked in CI so the signature is always valid. With your own Apple Developer ID, add `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` as repository secrets and the workflow signs and notarizes automatically, which removes the prompt for everyone.

## Fedora and other Linux desktops

If the AppImage does not start: `sudo dnf install fuse fuse-libs`.

On Wayland (the Fedora default) programs cannot fake input directly, so mswnlink asks the desktop's *RemoteDesktop portal*. Make sure the portal backend for your desktop is installed (`xdg-desktop-portal-gnome` or `xdg-desktop-portal-kde`). When sharing starts, your desktop asks you to allow mouse and keyboard control; choose the same monitor you are sharing. Desktops that support it remember the approval. That prompt is an operating-system rule and cannot be skipped, even with *Connect without asking*.

If capture is black, check that PipeWire and `xdg-desktop-portal` are running. `MSWNLINK_FORCE_NATIVE_WAYLAND=1` tries native Wayland; `MSWNLINK_DISABLE_GPU=1` forces software rendering.

## Run from source

Node.js 22.12 or newer.

```
npm install
npm start
npm run check
```

RobotJS (input on Windows, macOS and X11) is optional; without it sessions are view-only.

## Build the apps

Push a tag like `v0.3.0` (or run the workflow from the **Actions** tab) to build every platform on GitHub and attach the files to a release. Locally: `npm run dist:fedora`, `dist:win`, `dist:mac`.

## Security notes

- Video and the input channel use WebRTC's encrypted transport. The access code is never sent; a PBKDF2-derived key proves knowledge of it and authenticates signaling.
- Only private-network addresses are accepted. The access code is stored with the operating system's secure storage.
- Signaling is not encrypted, so someone who can capture your network traffic could try to guess a weak code offline. Use a long, unique code.
- Anyone with the code controls the PC when *Connect without asking* is on. Don't use it on shared networks and don't expose port 49382 to the internet.

## License

MIT, see [LICENSE](LICENSE).

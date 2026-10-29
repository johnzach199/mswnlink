# Updating mswnlink to the permanent-passcode and improved-sharing build

This update changes the desktop app's connection passcode format. **Update both computers** before connecting them together; old builds still expect a temporary six-digit code and cannot authenticate using the new permanent passphrase.

## What's changed

- The host owner sets their own 8–64 character permanent access code from **Share this PC** and clicks **Save permanent code**.
- The code is stored locally using Electron `safeStorage` and remains in place after stopping/restarting sharing. The owner can change it later.
- Ordinary incoming connections require explicit host approval; the host may choose view-only or allow mouse/keyboard control. When the owner enables unattended access on that PC, a correct permanent passcode can connect with control without per-session in-app approval while sharing is active. The host can disable unattended access, revoke control, or disconnect the viewer.
- Share-quality choices: Balanced (up to 1080p/30 FPS), Smooth (up to 1080p/60 FPS), and Sharper (up to 1440p/30 FPS), depending on source/device capability.
- WebRTC video sender defaults request higher LAN bitrate and preserve resolution where possible; pointer updates are sent more frequently and high-resolution trackpad deltas are accumulated.
- Package scripts use `--publish never` so `electron-builder` won't try to upload artifacts directly using a missing `GH_TOKEN`. GitHub Actions handles artifact/release uploads separately.

## Apply to an existing GitHub repository

Replace these files with the versions from this archive, preserving the repository root paths:

- `main.js`
- `preload.js`
- `renderer.js`
- `index.html`
- `styles.css`
- `package.json`
- `README.md`

Commit and push those changes. Keep your corrected Node/Electron GitHub Actions workflow. Do not keep a workflow that runs `go build main.go`; mswnlink is an Electron/Node.js app.

Then run the workflow from the `main` branch. Start with an empty `release_tag` to verify the platform artifacts are built first. Once the builds succeed, you can run again with a release tag to attach artifacts.

## Passcode storage note

Electron uses the operating system's secure-storage integration when available. On Linux, if Electron reports the `basic_text` backend, the app warns that the passcode isn't well protected at rest. Prefer GNOME Keyring/libsecret or KWallet. Use a long unique passphrase, keep the app on a trusted private LAN, and do not expose TCP port 49382 to the public internet.


## Linux-to-Linux input reliability update

Replace `main.js`, `renderer.js`, and `linux-wayland-input.js` with the matching files from the update ZIP. Rebuild/install the app on both Linux computers. On a Wayland host, grant keyboard and pointer access when the system Remote Desktop portal prompts. The updated source logs the selected stream's logical dimensions and shows the first rejected input in a toast/terminal.


## LAN productivity features in this build

- **LAN device discovery:** UDP beacons list nearby running mswnlink devices; select a device, then enter its permanent passcode. If broadcasts are blocked, connect using the host IP/hostname.
- **Adaptive quality:** Auto observes WebRTC video packet loss and selected candidate-pair latency and asks the host to move between Balanced and Smooth profiles. Manual Balanced/Smooth/Sharper settings remain available.
- **Clipboard:** plain-text copy/send and get-clipboard actions require the option enabled on both devices. Feature permissions reset to off at app launch.
- **File transfer:** sends files up to 100 MiB in chunks over the WebRTC data channel. Both devices must enable file transfers, and the receiver chooses a save location.
- **Display selection:** select a host screen when Electron reports multiple sources; “All displays · side-by-side” composes up to six sources into a panorama. Some Linux Wayland/PipeWire desktop portals expose only one combined source.
- **Input:** fixes include a single client data-channel event handler (previous duplicate `onopen`/`onclose` assignments overwrote feature-negotiation and cleanup handlers), logical Wayland display coordinates, and serialized native input queueing. The Linux Wayland control path still requires user-approved XDG Desktop Portal RemoteDesktop access, and should be verified on the target Fedora/desktop session.

The new build has passed JavaScript syntax checks, HTML duplicate-ID checks, CSS parsing, workflow YAML parsing, and ZIP integrity checks. It has not yet been runtime-tested between physical computers, so multi-monitor, clipboard/file transfer, and cross-platform control must still be tested in actual sessions.

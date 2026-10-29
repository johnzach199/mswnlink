# Applying the mswnlink LAN feature update

This package contains the integrated LAN productivity features and the associated integration fixes. Replace matching files in your existing repository; preserve the paths, including the hidden `.github` directory.

## Files to replace

- `main.js`
- `preload.js`
- `renderer.js`
- `index.html`
- `styles.css`
- `linux-wayland-input.js`
- `package.json`
- `README.md`
- `UPDATING.md`
- `.github/workflows/main.yml`
- `scripts/after-pack.cjs`
- `build/entitlements.mac.plist`
- `build/entitlements.mac.inherit.plist`

Commit these changes to `main`, then start **Build and Publish mswnlink Executables** from the `main` branch. First run with `release_tag` empty; only create/publish a version tag after the four package jobs complete successfully. macOS packaging requires the signing and notarization secrets documented in `BUILDING-RELEASES.md`.

## Feature overview

- LAN device discovery by UDP broadcast; manual IP/hostname remains available.
- Permanent 8–64 character passcode stored with Electron `safeStorage` where supported.
- Explicit host approval by default. Optional unattended access is disabled by default and must be deliberately enabled on the host; a correct code then connects without per-session in-app approval while sharing is active.
- Mouse, keyboard, click, drag, wheel and key-release handling with a serialized host input queue. Fedora/Wayland uses the XDG RemoteDesktop portal and still requires OS permission; X11 uses RobotJS/XTEST.
- Adaptive quality plus Balanced, Smooth, and Sharper profiles.
- Optional plain-text clipboard sharing and file transfer up to 100 MiB. Both endpoints must enable each feature; the receiver chooses the destination.
- Monitor selection and optional side-by-side all-display panorama where Electron reports separate display sources.
- Light/dark theme, fullscreen layout, and explicit stop/revoke controls.

## LAN ports

Allow TCP port `49382` and UDP discovery port `49383` between trusted LAN devices. WebRTC also negotiates local peer media ports. Do not expose the app to the public internet.

## Important limitations

- This source has been statically validated but not live-tested between physical computers.
- Some Wayland/PipeWire combinations provide one combined display source; separate-monitor selection may not be available there.
- Wayland input depends on the host desktop's XDG RemoteDesktop portal permission. The app does not bypass OS permission prompts.
- Audio, remote wake, and autostart sharing are not implemented.

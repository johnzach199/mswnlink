# Apply this mswnlink update

This update includes the simplified application styling, persistent passcode/unattended-access flow, Fedora/Wayland input backend, fuller remote-input diagnostics, and macOS signing/notarization build configuration.

## Replace source files on GitHub

Copy the files from this archive over the same paths in your repository and commit them to `main`. Keep `linux-wayland-input.js`, both files under `build/`, and `.github/workflows/main.yml` at exactly those paths. If an older, duplicate workflow such as `.github/workflows/build.yml` remains in your repository, remove it so it does not run conflicting builds.

## macOS downloads

To prevent macOS from marking the DMG as damaged, build with a Developer ID Application certificate and Apple notarization. Add these values under GitHub **Settings → Secrets and variables → Actions**:

- `MAC_CSC_LINK`: base64-encoded Developer ID Application `.p12` certificate
- `MAC_CSC_KEY_PASSWORD`: certificate password
- `APPLE_API_KEY`: base64-encoded App Store Connect `.p8` API key
- `APPLE_API_KEY_ID`: key ID
- `APPLE_API_ISSUER`: issuer UUID

These require an active Apple Developer Program membership. Never commit signing materials or paste them into chat. Without these secrets, the Mac build intentionally fails its preflight instead of producing an unsigned DMG that Gatekeeper may call damaged.

## Run the workflow

After committing to `main`, open **Actions → Build and Publish mswnlink Executables → Run workflow**, select `main`, and leave `release_tag` empty for a test run. Once all four package jobs succeed, run again with an intended release tag if the artifacts should be attached to a GitHub Release.

## Fedora/Wayland

Native Wayland remote input goes through the XDG Desktop Portal RemoteDesktop API, so the host must approve its OS permission prompt. The app's optional unattended-access toggle avoids the app's per-connection acceptance dialog only after the local owner enables it and saves a permanent passcode; it does not bypass OS permissions or start screen sharing silently.

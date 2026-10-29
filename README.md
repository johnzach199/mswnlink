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

When all five Apple Developer ID/App Store Connect secrets are configured, macOS builds are signed and notarized and the workflow verifies the result. Without those secrets, the workflow creates a clearly labelled unsigned test DMG that remains in the Actions artifacts but is excluded from public GitHub releases. Unsigned builds may be blocked by Gatekeeper; see `MAC-SIGNING-SETUP.md`.

## Native input

The workflow installs the X11/XTest development headers and compiles the RobotJS native backend on each target runner. Fedora Wayland interaction additionally depends on the host desktop's Remote Desktop portal permissions.


## Share page navigation fix (v0.2.2)

Page navigation is now bound synchronously before asynchronous operating-system IPC initialization begins. The renderer explicitly updates each page's active class, `hidden` property, and `aria-hidden` state, so the Share this PC page remains reachable even if display-source permission APIs respond slowly or fail.

The GitHub Actions workflow is included at `.github/workflows/main.yml`. Run it manually on `main` for test artifacts; leave `release_tag` empty until the platform builds pass.

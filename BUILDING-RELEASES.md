# Getting the mswnlink executables

The final end-user apps are built on native platform runners. You do **not** need Node.js or npm on computers that only run the resulting app.

## One-time setup

1. Create a repository on GitHub.
2. Extract this project ZIP on your computer.
3. Upload the **contents** of the extracted `mswnlink` directory to the repository, making sure the hidden `.github/workflows/main.yml` file is included.
4. In the repository, open **Settings → Actions → General** and make sure Actions are allowed. For tagged releases, allow the workflow to create releases if your repository policies have that setting.

## Build the downloads

1. Open the repository's **Actions** tab.
2. Select **Build and Publish mswnlink Executables**.
3. Click **Run workflow** and start the workflow on the default branch.
4. When all four jobs finish successfully, open the workflow run and download the artifacts:
   - `mswnlink-fedora-x64` — single `.AppImage` executable.
   - `mswnlink-windows-x64` — portable `.exe`.
   - `mswnlink-macos-intel-x64` — `.dmg` for Intel Macs.
   - `mswnlink-macos-apple-silicon-arm64` — `.dmg` for Apple Silicon Macs.

The workflow compiles the RobotJS native input module on each platform before packaging. It fails rather than publishing a knowingly view-only package if that native build fails.

## Publish a named release

After the manual workflow succeeds, run it again with `release_tag` set to the intended version tag (or push a new `v*` tag after the corrected source is committed). The publish job attaches the completed platform files to the named GitHub Release. If any package job fails, the release publish job is skipped.

## Run the downloaded file

- **Fedora:** `chmod +x mswnlink-fedora-0.1.0-x64.AppImage` then `./mswnlink-fedora-0.1.0-x64.AppImage`.
- **Windows:** double-click `mswnlink-windows-0.1.0-x64.exe`.
- **macOS:** open the matching `.dmg`, then drag `mswnlink.app` into Applications. To avoid Gatekeeper reporting the app as damaged, the DMG must be signed and notarized. The workflow requires the macOS signing secrets below and fails rather than publishing an unsigned Mac build.

Builds currently target x64 Windows and Linux, plus Intel and Apple Silicon Macs. A universal macOS build and production security audit are not included. macOS builds require signing and notarization secrets as described below.


## Fullscreen viewer layout

The packaged desktop viewer uses a viewport-height flex layout in fullscreen. The remote video stage consumes the available space and keeps the complete remote desktop visible with `object-fit: contain`, instead of retaining the normal preview-height limit. Browser Edition contains the same fullscreen fit and an overlay button to enter/exit fullscreen.


## macOS signing/notarization

The macOS build now requires GitHub Actions secrets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. Set these in Repository Settings → Secrets and variables → Actions. Use a base64-encoded Developer ID Application `.p12` for `MAC_CSC_LINK` and a base64-encoded App Store Connect `.p8` key for `APPLE_API_KEY`. You must have an active Apple Developer Program membership. The workflow deliberately fails if those secrets are missing so it does not publish a “damaged” unsigned DMG.


## Frameless window chrome

The app replaces Electron's native title bar and default File/Edit/View menu with a slim integrated draggable title strip and app-controlled minimize, maximize/restore, and close buttons. This is implemented in `main.js`, `preload.js`, `renderer.js`, `index.html`, and `styles.css`. The custom close control quits the app so it does not leave an invisible network listener running.

## Verify a macOS release

The macOS CI job runs `codesign --verify --deep --strict`, Gatekeeper assessment with `spctl`, and `xcrun stapler validate` against the built `.app`. Do not share a DMG if any of these fail. If a user's Mac still reports a downloaded app as damaged, download a newly notarized release and confirm the app's signature and ticket rather than instructing the user to bypass Gatekeeper.

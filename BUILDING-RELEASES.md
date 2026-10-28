# Getting the mswnlink executables

The final end-user apps are built on native platform runners. You do **not** need Node.js or npm on computers that only run the resulting app.

## One-time setup

1. Create a repository on GitHub.
2. Extract this project ZIP on your computer.
3. Upload the **contents** of the extracted `mswnlink` directory to the repository, making sure the hidden `.github/workflows/build.yml` file is included.
4. In the repository, open **Settings → Actions → General** and make sure Actions are allowed. For tagged releases, allow the workflow to create releases if your repository policies have that setting.

## Build the downloads

1. Open the repository's **Actions** tab.
2. Select **Build mswnlink standalone apps**.
3. Click **Run workflow** and start the workflow on the default branch.
4. When all four jobs finish successfully, open the workflow run and download the artifacts:
   - `mswnlink-fedora-x64` — single `.AppImage` executable.
   - `mswnlink-windows-x64` — portable `.exe`.
   - `mswnlink-macos-intel-x64` — `.dmg` for Intel Macs.
   - `mswnlink-macos-apple-silicon-arm64` — `.dmg` for Apple Silicon Macs.

The workflow compiles the RobotJS native input module on each platform before packaging. It fails rather than publishing a knowingly view-only package if that native build fails.

## Publish a named release

After the manual workflow succeeds, create and push a version tag, for example `v0.1.0`. The workflow runs again and attaches the completed platform files to a GitHub Release. If the native build fails on any platform, the release publish job is skipped.

## Run the downloaded file

- **Fedora:** `chmod +x mswnlink-fedora-0.1.0-x64.AppImage` then `./mswnlink-fedora-0.1.0-x64.AppImage`.
- **Windows:** double-click `mswnlink-windows-0.1.0-x64.exe`.
- **macOS:** open the matching `.dmg`, then drag `mswnlink.app` into Applications. Builds are currently unsigned, so the operating system may show an initial security warning. Only run builds from a repository you trust.

Builds currently target x64 Windows and Linux, plus Intel and Apple Silicon Macs. A universal macOS build, code signing, notarization, and production security audit are not included.


## Fullscreen viewer layout

The packaged desktop viewer uses a viewport-height flex layout in fullscreen. The remote video stage consumes the available space and keeps the complete remote desktop visible with `object-fit: contain`, instead of retaining the normal preview-height limit. Browser Edition contains the same fullscreen fit and an overlay button to enter/exit fullscreen.

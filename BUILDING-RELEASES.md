# Building the mswnlink apps

The apps are built on GitHub's own Windows, Linux and macOS machines. You don't need Node.js on a computer that only runs the finished app.

## One-time setup

1. Upload the contents of this project to your GitHub repository. Make sure the hidden `.github/workflows/main.yml` file is included.
2. In the repository, open **Settings › Actions › General**, allow Actions, and under *Workflow permissions* choose **Read and write permissions** so releases can be created.

## Build and publish a release

1. Update `version` in `package.json` (for example `0.2.0`) and commit it.
2. Create and push a tag that matches: `git tag v0.2.0 && git push origin v0.2.0`.
3. Open the **Actions** tab. When all four jobs are green, the files appear on the **Releases** page:
   - `mswnlink-fedora-<version>-x64.AppImage`
   - `mswnlink-windows-<version>-x64.exe`
   - `mswnlink-macos-<version>-x64.dmg` (Intel)
   - `mswnlink-macos-<version>-arm64.dmg` (Apple Silicon)

To only test a build, run **Actions › Build and Publish mswnlink Executables › Run workflow**. The files are then attached to the workflow run as artifacts for 30 days.

## macOS signing

Every macOS job signs the app ad hoc and then **mounts the DMG and verifies the signature**. If the signature is invalid the job fails, so a build that macOS would call "damaged" is never published.

Ad-hoc signing is free but is not Apple-approved, so users approve the app once (right-click › Open, or `xattr -cr /Applications/mswnlink.app`). To remove that step you need a paid Apple Developer ID and notarization: add the repository secrets `CSC_LINK` (base64 of your .p12) and `CSC_KEY_PASSWORD`; electron-builder then signs with them and the ad-hoc step is skipped.

## Running the downloaded files

- **Fedora:** `chmod +x mswnlink-fedora-*.AppImage && ./mswnlink-fedora-*.AppImage`. See the README for the Wayland remote-control packages.
- **Windows:** double-click the `.exe`. SmartScreen may warn because the file is unsigned.
- **macOS:** open the `.dmg`, drag **mswnlink** to Applications, then follow the steps in the README.

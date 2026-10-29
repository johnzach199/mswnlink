# Apply the frameless window and macOS signing fix

1. Extract the project or patch ZIP.
2. Replace files in your GitHub repository at exactly these paths: `main.js`, `preload.js`, `renderer.js`, `index.html`, `styles.css`, `package.json`, `build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist`, `.github/workflows/main.yml`, `README.md`, and `BUILDING-RELEASES.md`.
3. Commit the changes to `main`.
4. Configure the five GitHub Actions secrets documented in `MAC-SIGNING-SETUP.md`.
5. Run the workflow on `main` with `release_tag` blank. Confirm both macOS jobs pass the signing, Gatekeeper-assessment, and stapling validation step.
6. Once validated, run the workflow again with a new tag such as `v1.3` to publish the signed/notarized artifacts.

The frameless window change is in `main.js`, `preload.js`, `renderer.js`, `index.html`, and `styles.css`. It removes the native titlebar/default menu and adds a slim draggable app title strip with minimize, maximize/restore, and close buttons.

Do not upload signing certificates, private keys, passwords, or API credentials into the repository. Store them only as GitHub Actions secrets.

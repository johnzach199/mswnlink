# Apply the Linux-to-Linux input fix

This update targets the Electron desktop app's Linux input path. It fixes high-DPI pointer coordinates in the XDG Remote Desktop portal, reduces queued pointer-move latency so clicks and key events remain ordered, and restores keyboard focus on the viewer when a session becomes live.

## Replace these files

Copy these files into the root of your existing repository, replacing the old versions:

- `main.js`
- `renderer.js`
- `linux-wayland-input.js`

The complete project ZIP includes the rest of the project too.

## Rebuild

Commit the changed files to `main`, then run your GitHub Actions workflow from `main` to rebuild the Fedora/Linux, Windows, and macOS packages. Install the newly built version on both Linux computers before testing.

## Fedora / Wayland permission

When the host chooses **Allow control**, Fedora's system Remote Desktop permission prompt must grant both pointer and keyboard. This permission is controlled by the desktop portal and cannot be bypassed by mswnlink.

The host terminal now logs the portal stream's logical dimensions when the input session starts, e.g. `[mswnlink] Wayland input session started (stream=..., logical=1920x1080, devices=3).` If control still fails, send that line and the first `[mswnlink] Remote input` error from the host.

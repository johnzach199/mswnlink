# mswnlink

A simple remote desktop for computers on your local network. One computer shares its screen, another views and controls it, directly over the LAN. No account, no cloud, no relay.

> **Status:** v0.2 prototype. It has not been security-audited. Use it on networks you trust (see [Security](#security)).

## Download

Get the latest build from the [Releases](../../releases) page:

| Platform | File |
| --- | --- |
| Fedora / Linux | `mswnlink-fedora-<version>-x64.AppImage` |
| Windows | `mswnlink-windows-<version>-x64.exe` (portable) |
| macOS, Apple Silicon (M1 and newer) | `mswnlink-macos-<version>-arm64.dmg` |
| macOS, Intel | `mswnlink-macos-<version>-x64.dmg` |

## Using it

1. On the computer you want to reach, open **Share this PC**, pick a display, save an access code, and click **Start sharing**.
2. On the other computer, open **Connect**, enter the address and access code shown on the first one, and click **Connect**.
3. Under **Who can connect** the host chooses what happens when the correct code is entered:
   - **Ask me each time**: the host approves every request as view-only or full control (default).
   - **Connect automatically, view only**: the code alone is enough to watch the screen.
   - **Connect automatically, with full control**: the code alone is enough to watch and control the PC, with no one needing to click Accept.

Automatic connection is opt-in and needs an access code of **12 or more characters**. The host window always shows who is connected and has a **Disconnect** button, and a system notification appears when someone joins.

Both computers must allow TCP port **49382** on the private network. Don't turn the firewall off; allow mswnlink on private networks only.

## macOS: "mswnlink is damaged and can't be opened"

Older builds were shipped with a broken code signature, which makes macOS (especially on Apple Silicon) say the app is "damaged". From v0.2 the build is signed ad hoc and checked in CI, so you get the normal "unidentified developer" prompt instead.

Because there is no paid Apple Developer ID, macOS still asks you to approve the app once:

1. Open the DMG and drag **mswnlink** to **Applications**.
2. In Applications, right-click **mswnlink** and choose **Open**, then **Open** again. If macOS only offers *Done*, go to **System Settings › Privacy & Security** and click **Open Anyway**.

If you still see "damaged", remove the download quarantine flag and open it again:

```
xattr -cr /Applications/mswnlink.app
```

Then allow these in **System Settings › Privacy & Security**:

- **Screen & System Audio Recording**: to share this Mac's screen.
- **Accessibility**: to let a remote computer move the mouse and type. Restart mswnlink after enabling it.

Ad-hoc builds get a new identity each release, so macOS may ask for these permissions again after you update.

## Fedora and other Linux desktops

The AppImage runs on Fedora without installing Node.js. If it doesn't start, install FUSE: `sudo dnf install fuse fuse-libs`.

**Remote mouse and keyboard on Wayland.** Fedora uses Wayland by default, where programs are not allowed to fake input directly. mswnlink therefore uses the desktop's own *RemoteDesktop portal* through a small Python helper (`native/wayland-input.py`):

```
sudo dnf install python3 python3-gobject xdg-desktop-portal xdg-desktop-portal-gnome   # GNOME
sudo dnf install python3 python3-gobject xdg-desktop-portal xdg-desktop-portal-kde     # KDE Plasma
```

When you click **Start sharing**, your desktop shows an approval prompt for remote control (separate from the screen-sharing prompt). Approve it and pick the monitor you are sharing. Desktops that support it remember the approval, so the prompt appears only the first time. On the Share page, the line next to **Start sharing** tells you whether control is ready.

Notes:

- The desktop prompt is an operating-system rule and cannot be skipped. The "connect without asking" setting only removes mswnlink's own approval step.
- Choose the **same monitor** in the desktop prompt as in mswnlink, so clicks land where the viewer sees them.
- On an X11 session, mswnlink uses RobotJS directly and no portal prompt is needed.
- If capture shows a black screen, check that PipeWire and `xdg-desktop-portal` are running, and try `MSWNLINK_FORCE_NATIVE_WAYLAND=1`.

## Run from source

Requires Node.js 22.12 or newer.

```
npm install
npm start
npm run check     # syntax check
```

`npm start` uses XWayland on Wayland sessions by default. Optional switches: `MSWNLINK_FORCE_NATIVE_WAYLAND=1` (experimental native Wayland) and `MSWNLINK_DISABLE_GPU=1` (software rendering if the window stays blank).

RobotJS is an optional dependency used for input on Windows, macOS and X11. If it fails to build, the app still runs and sessions are view-only.

## Build the apps

Push a tag such as `v0.2.0`, or run **Actions › Build and Publish mswnlink Executables**, to build every platform on GitHub and attach the files to a release. See [BUILDING-RELEASES.md](BUILDING-RELEASES.md).

Locally, on the target operating system:

```
npm install
npm run dist:fedora   # Linux AppImage
npm run dist:win      # Windows portable exe
npm run dist:mac      # macOS dmg (signed ad hoc, then verified)
```

To ship macOS builds with no approval prompt at all, you need an Apple Developer ID certificate and notarization. Set `CSC_LINK` and `CSC_KEY_PASSWORD` in the repository secrets and electron-builder will sign with it instead of the ad-hoc step.

## Browser edition

`browser-only/index.html` works with no install. It is **view-only** (a web page cannot control your mouse and keyboard) and pairing is done by copying an offer and an answer between the two devices.

## Security

mswnlink is built for a **trusted private LAN**.

- Video and the input channel use WebRTC's encrypted transport.
- The access code is never sent over the network. A PBKDF2-derived key is used to prove knowledge of it and to authenticate signaling messages.
- Connections from non-private addresses are rejected. Wrong codes are rate-limited per address, and after repeated failures the PC stops answering for a few minutes.
- The access code is stored with the operating system's secure storage (Electron `safeStorage`).

Limits you should know about:

- Signaling uses plain WebSocket (no TLS). Someone who can capture traffic on your network can record a login exchange and try to guess the code offline. **Use a long, unique code**, which is why automatic connection requires 12 or more characters.
- With **Connect automatically, with full control**, anyone who knows the code controls the PC. Don't use it on shared or guest networks, and don't reuse the code anywhere else.
- Don't expose port 49382 to the internet.

## Limits

One viewer at a time. No audio, file transfer, clipboard sync, start-on-boot or automatic discovery. IPv4 addresses and hostnames only. Multi-monitor mapping targets the display you share.

## License

MIT. See [LICENSE](LICENSE).

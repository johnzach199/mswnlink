# mswnlink 0.3.1

Local-network remote desktop for Fedora/Linux, Windows, and macOS.

## Build requirements

- Node.js 22.12+ and npm 10+
- Linux build: compiler toolchain and X11/XTest development headers (see workflow)
- Windows/macOS builds: use the provided GitHub Actions workflow

## Run from source

```bash
npm install
npm start
```

## Build installers

```bash
npm run dist:fedora
npm run dist:win
npm run dist:mac
```

## 0.3.1 fixes

- Clipboard monitoring runs in Electron main process to avoid renderer timer throttling during fullscreen/background use.
- macOS Electron `display-capture` permission check/request handlers now allow only the app's own local UI; failed screen capture opens the macOS Screen Recording settings pane.
- `getDisplayMedia()` is invoked immediately from the Start sharing click handler, before asynchronous IPC/source refresh can consume browser user activation.
- Windows Ctrl+Shift+Esc is forwarded; unconditional mouse-button release is sent on host focus loss/gain; pointer-up is also observed at window level to prevent stuck buttons.

See `FIXES-0.3.1.md`, `MAC-SCREEN-CAPTURE-SETUP.md`, `WINDOWS-INPUT-RECOVERY.md`, and `CLIPBOARD-SYNC.md`.

#!/bin/bash
# Installs the latest mswnlink release on macOS without the "Apple could not verify ... malware" prompt.
#
# Why this works: macOS only blocks apps that carry the "quarantine" flag, which browsers add to
# downloads. A file downloaded by curl never gets that flag, so the app opens like any other.
#
#   curl -fsSL https://raw.githubusercontent.com/johnzach199/mswnlink/main/scripts/install-mac.sh | bash
set -euo pipefail

REPO="johnzach199/mswnlink"
APP="mswnlink.app"

if [ "$(uname -s)" != "Darwin" ]; then echo "This installer is for macOS only." >&2; exit 1; fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

echo "Looking up the latest mswnlink release…"
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")"
URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url"[^,}]*' | sed 's/.*: *"//; s/"$//' | grep -i "macos" | grep -i "$ARCH" | grep -i '\.dmg$' | head -n 1 || true)"
if [ -z "$URL" ]; then
  echo "Could not find a macOS $ARCH download in the latest release: https://github.com/$REPO/releases/latest" >&2
  exit 1
fi

WORK="$(mktemp -d)"
MOUNT="$WORK/mount"
mkdir -p "$MOUNT"
cleanup() { hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "Downloading $(basename "$URL")…"
curl -fL --progress-bar -o "$WORK/mswnlink.dmg" "$URL"

echo "Installing to /Applications…"
hdiutil attach "$WORK/mswnlink.dmg" -mountpoint "$MOUNT" -nobrowse -quiet
if [ ! -d "$MOUNT/$APP" ]; then echo "$APP was not found inside the download." >&2; exit 1; fi
pkill -x mswnlink 2>/dev/null || true
HAD_EXISTING=0
if [ -d "/Applications/$APP" ]; then HAD_EXISTING=1; fi
rm -rf "/Applications/$APP"
cp -R "$MOUNT/$APP" "/Applications/$APP"
# Belt and braces: make sure no quarantine flag is present.
xattr -cr "/Applications/$APP" 2>/dev/null || true

# Ad-hoc signed builds change CDHash on each release. Resetting stale TCC entries
# when upgrading prevents macOS from showing the Screen Recording switch as ON
# while silently denying screen capture to the new binary.
if [ "$HAD_EXISTING" = "1" ]; then
  echo "Refreshing macOS Screen Recording & Accessibility permissions for the updated build…"
  tccutil reset ScreenCapture com.mswnlink.lan 2>/dev/null || true
  tccutil reset Accessibility com.mswnlink.lan 2>/dev/null || true
fi

echo "Done. Opening mswnlink…"
open "/Applications/$APP"

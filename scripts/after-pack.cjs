'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Linux packages launch Electron directly, bypassing launch.js. This wrapper
 * applies Ozone/GPU switches before starting the packaged Electron binary and
 * falls back to XWayland on Wayland, matching the source launcher behavior.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const appOutDir = context.appOutDir;
  const executableName = 'mswnlink';
  const original = path.join(appOutDir, executableName);
  const realBinary = path.join(appOutDir, `${executableName}-electron`);

  if (!fs.existsSync(original) || !fs.statSync(original).isFile()) {
    throw new Error(`Expected packaged Linux executable not found: ${original}`);
  }

  if (fs.existsSync(realBinary)) fs.unlinkSync(realBinary);
  fs.renameSync(original, realBinary);

  const wrapper = `#!/bin/sh
set -eu
SELF="$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")"
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
set -- "$APP_DIR/resources/app.asar" "$@"
if [ "\${MSWNLINK_FORCE_NATIVE_WAYLAND:-}" = "1" ]; then
  set -- --ozone-platform=wayland "$@"
elif [ "\${XDG_SESSION_TYPE:-}" = "wayland" ] || [ -n "\${WAYLAND_DISPLAY:-}" ]; then
  set -- --ozone-platform=x11 "$@"
fi
if [ "\${MSWNLINK_DISABLE_GPU:-}" = "1" ]; then
  set -- --disable-gpu --disable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE "$@"
fi
exec "$APP_DIR/${executableName}-electron" "$@"
`;
  fs.writeFileSync(original, wrapper, { mode: 0o755 });
  fs.chmodSync(original, 0o755);
};

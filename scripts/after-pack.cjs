'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Linux: packaged builds launch Electron directly, bypassing launch.js. This wrapper
 * applies Ozone/GPU switches before starting the packaged Electron binary and falls
 * back to XWayland on Wayland, matching the source launcher behaviour.
 *
 * macOS: electron-builder is configured without a signing identity. Repackaging
 * Electron invalidates its original signature, and on Apple Silicon a broken
 * signature makes Gatekeeper report "mswnlink is damaged and can't be opened".
 * We re-sign the whole bundle ad hoc (free, no Apple account needed) so the
 * signature is valid and macOS shows the normal "unidentified developer" flow instead.
 * Real Developer ID signing + notarization still needs a paid Apple account;
 * when CSC_LINK / CSC_NAME is set, electron-builder signs and this step is skipped.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') return signMacAdHoc(context);
  if (context.electronPlatformName === 'linux') return wrapLinux(context);
};

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function findFiles(directory, matcher, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findFiles(full, matcher, found);
    else if (matcher(entry.name)) found.push(full);
  }
  return found;
}

function signMacAdHoc(context) {
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[after-pack] Developer ID credentials found; skipping ad-hoc signing.');
    return;
  }
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`Expected macOS app bundle not found: ${appPath}`);

  console.log(`[after-pack] Ad-hoc signing ${appPath}`);
  // Native modules (RobotJS) live outside the paths that --deep covers; sign them first.
  const natives = findFiles(appPath, (name) => name.endsWith('.node') || name.endsWith('.dylib'));
  for (const file of natives) run('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
  run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log('[after-pack] Ad-hoc signature verified.');
}

function wrapLinux(context) {
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
}

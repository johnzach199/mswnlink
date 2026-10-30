'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Linux packages launch Electron directly, bypassing launch.js. This wrapper
 * applies Ozone/GPU switches before starting the packaged Electron binary and
 * falls back to XWayland on Wayland, matching the source launcher behavior.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') return signMacAdHoc(context);
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

/**
 * macOS without an Apple Developer ID: repackaging Electron breaks its original
 * signature, and an app with a broken signature is reported as "damaged" or as
 * malware by Gatekeeper (worst on Apple Silicon). Re-signing the whole bundle
 * "ad hoc" (free, no Apple account) gives it a valid signature. macOS still asks
 * the user to approve a downloaded, non-notarized app once; installing with
 * scripts/install-mac.sh avoids even that prompt.
 *
 * When real credentials are present (CSC_LINK) electron-builder signs and
 * notarizes the app itself and this step is skipped.
 */
function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function findNativeFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findNativeFiles(full, found);
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib')) found.push(full);
  }
  return found;
}

function signMacAdHoc(context) {
  const realSigning = Boolean(process.env.CSC_LINK) && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
  if (realSigning) {
    console.log('[after-pack] Developer ID credentials found; electron-builder will sign and notarize.');
    return;
  }
  const appName = context.packager.appInfo.productFilename;
  const appId = context.packager.appInfo.id || 'com.mswnlink.lan';
  const projectDir = context.packager.projectDir || path.resolve(__dirname, '..');
  const mainEntitlements = path.join(projectDir, 'build', 'entitlements.mac.plist');
  const inheritEntitlements = path.join(projectDir, 'build', 'entitlements.mac.inherit.plist');
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`Expected macOS app bundle not found: ${appPath}`);

  console.log(`[after-pack] Ad-hoc signing ${appPath} (inside-out with entitlements for ScreenCaptureKit & TCC)`);

  // 1. Sign unpacked native modules (.node / .dylib) first.
  for (const file of findNativeFiles(appPath)) {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
  }

  // 2. Sign nested framework helpers and frameworks inside Contents/Frameworks
  //    before signing helper .app bundles. Using `codesign --deep` without
  //    inside-out signing strips JIT/unsigned-memory entitlements from Electron
  //    Helper (GPU) and Helper (Renderer), breaking macOS ScreenCaptureKit.
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworksDir)) {
    const entries = fs.readdirSync(frameworksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.framework')) continue;
      const fwPath = path.join(frameworksDir, entry.name);
      const helpersDir = path.join(fwPath, 'Versions', 'Current', 'Helpers');
      const fallbackHelpersDir = path.join(fwPath, 'Versions', 'A', 'Helpers');
      const resolvedHelpers = fs.existsSync(fallbackHelpersDir) ? fallbackHelpersDir : helpersDir;
      if (fs.existsSync(resolvedHelpers)) {
        for (const helper of fs.readdirSync(resolvedHelpers, { withFileTypes: true })) {
          if (helper.isSymbolicLink()) continue;
          const helperPath = path.join(resolvedHelpers, helper.name);
          if (helper.isFile()) {
            run('codesign', ['--force', '--sign', '-', '--timestamp=none', helperPath]);
          }
        }
      }
      const resourcesMainBin = path.join(fwPath, 'Versions', 'A', entry.name.replace(/\.framework$/, ''));
      if (fs.existsSync(resourcesMainBin) && fs.statSync(resourcesMainBin).isFile()) {
        run('codesign', ['--force', '--sign', '-', '--timestamp=none', resourcesMainBin]);
      }
      run('codesign', ['--force', '--sign', '-', '--timestamp=none', fwPath]);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.app')) continue;
      const helperAppPath = path.join(frameworksDir, entry.name);
      const helperArgs = ['--force', '--sign', '-', '--timestamp=none'];
      if (fs.existsSync(inheritEntitlements)) {
        helperArgs.push('--entitlements', inheritEntitlements);
      }
      helperArgs.push(helperAppPath);
      run('codesign', helperArgs);
    }
  }

  // 3. Sign the top-level application bundle with stable bundle identifier + main entitlements.
  const mainArgs = ['--force', '--sign', '-', '--timestamp=none', '--identifier', appId];
  if (fs.existsSync(mainEntitlements)) {
    mainArgs.push('--entitlements', mainEntitlements);
  }
  mainArgs.push(appPath);
  run('codesign', mainArgs);

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log('[after-pack] Ad-hoc signature and entitlements verified.');
}

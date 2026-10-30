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

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

const MACHO_SINGLE_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit)
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64 (x86_64 / arm64)
  0xcffaedfe  // MH_CIGAM_64
]);

const MACHO_FAT_MAGICS = new Set([
  0xcafebabe, // FAT_MAGIC (universal binary)
  0xbebafeca, // FAT_CIGAM
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca  // FAT_CIGAM_64
]);

function isMachOBinary(filePath) {
  let fd = null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size < 8) return false;
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, header, 0, 8, 0);
    if (bytesRead < 8) return false;
    const magic = header.readUInt32BE(0);
    if (MACHO_SINGLE_MAGICS.has(magic)) return true;
    if (MACHO_FAT_MAGICS.has(magic)) {
      const nfatArch =
        magic === 0xcafebabe || magic === 0xcafebabf
          ? header.readUInt32BE(4)
          : header.readUInt32LE(4);
      return nfatArch >= 1 && nfatArch <= 8;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function collectMachOFiles(directory, { skipBundles = false } = {}, found = []) {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skipBundles && (entry.name.endsWith('.app') || entry.name.endsWith('.framework'))) {
        continue;
      }
      collectMachOFiles(full, { skipBundles }, found);
    } else if (entry.isFile() && isMachOBinary(full)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * macOS without an Apple Developer ID: repackaging Electron invalidates its
 * original signature. Using bare `codesign --deep` strips JIT/unsigned-memory
 * entitlements from Electron Helper (GPU)/(Renderer) AND misses nested Mach-O
 * tools like Squirrel.framework/Versions/A/Resources/ShipIt on Intel x64.
 *
 * Signing strictly inside-out (all leaf Mach-O files -> frameworks -> helper
 * .app bundles with inherit entitlements -> outer .app with com.mswnlink.lan)
 * passes `codesign --verify --deep --strict` on both Intel x64 and Apple Silicon.
 */
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

  console.log(`[after-pack] Ad-hoc signing ${appPath} inside-out (${context.arch || process.arch})`);

  // 1. Sign unpacked native addons (.node / .dylib) inside Contents/Resources first.
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  for (const file of collectMachOFiles(resourcesDir)) {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
  }

  // 2. Sign frameworks inside-out (including Squirrel's Resources/ShipIt on Intel x64,
  //    Electron Framework's Libraries/*.dylib and Helpers/chrome_crashpad_handler, etc.).
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  if (fs.existsSync(frameworksDir)) {
    const entries = fs.readdirSync(frameworksDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.framework')) continue;
      const fwPath = path.join(frameworksDir, entry.name);
      const fwBaseName = entry.name.replace(/\.framework$/, '');
      const versionADir = path.join(fwPath, 'Versions', 'A');
      const scanRoot = fs.existsSync(versionADir) ? versionADir : fwPath;
      const mainFwBinary = path.join(scanRoot, fwBaseName);

      // Sign all nested leaf Mach-O files (Libraries/*.dylib, Helpers/*, Resources/ShipIt)
      // before signing the framework's primary Mach-O binary and bundle directory.
      for (const leaf of collectMachOFiles(scanRoot, { skipBundles: true })) {
        if (path.resolve(leaf) === path.resolve(mainFwBinary)) continue;
        run('codesign', ['--force', '--sign', '-', '--timestamp=none', leaf]);
      }

      if (fs.existsSync(mainFwBinary) && fs.lstatSync(mainFwBinary).isFile()) {
        run('codesign', ['--force', '--sign', '-', '--timestamp=none', mainFwBinary]);
      }
      run('codesign', ['--force', '--sign', '-', '--timestamp=none', fwPath]);
    }

    // 3. Sign Helper .app bundles (GPU, Renderer, Plugin, Utility) preserving inherit entitlements.
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.app')) continue;
      const helperAppPath = path.join(frameworksDir, entry.name);
      const helperName = entry.name.replace(/\.app$/, '');
      const helperMainExec = path.join(helperAppPath, 'Contents', 'MacOS', helperName);

      for (const leaf of collectMachOFiles(helperAppPath, { skipBundles: true })) {
        if (path.resolve(leaf) === path.resolve(helperMainExec)) continue;
        run('codesign', ['--force', '--sign', '-', '--timestamp=none', leaf]);
      }

      const helperArgs = ['--force', '--sign', '-', '--timestamp=none'];
      if (fs.existsSync(inheritEntitlements)) {
        helperArgs.push('--entitlements', inheritEntitlements);
      }
      helperArgs.push(helperAppPath);
      run('codesign', helperArgs);
    }
  }

  // 4. Sign the top-level application bundle with stable bundle identifier + main entitlements.
  const mainArgs = ['--force', '--sign', '-', '--timestamp=none', '--identifier', appId];
  if (fs.existsSync(mainEntitlements)) {
    mainArgs.push('--entitlements', mainEntitlements);
  }
  mainArgs.push(appPath);
  run('codesign', mainArgs);

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log('[after-pack] Ad-hoc signature and helper entitlements verified.');
}

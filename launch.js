'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

// `require('electron')` resolves to the downloaded Electron executable when this
// file is run by Node.js. Ozone chooses its display backend before main.js runs,
// so the Linux compatibility flag must be passed here, on the command line.
const electronExecutable = require('electron');
const isLinux = process.platform === 'linux';
const sessionType = String(process.env.XDG_SESSION_TYPE || '').trim().toLowerCase();
const isWaylandSession = isLinux && (
  sessionType === 'wayland' ||
  (sessionType !== 'x11' && Boolean(process.env.WAYLAND_DISPLAY))
);
// Electron/Chromium's native Wayland + Vulkan path currently emits a persistent
// incompatibility error on some Linux graphics stacks even when Vulkan feature
// flags are disabled. Prefer XWayland unless a user explicitly opts into the
// experimental native path with the new, unambiguous override.
const legacyNativeRequest = process.env.MSWNLINK_USE_WAYLAND === '1';
const forceNativeWayland = process.env.MSWNLINK_FORCE_NATIVE_WAYLAND === '1';
const args = [];

if (isWaylandSession && forceNativeWayland) {
  args.push(
    '--ozone-platform=wayland',
    '--enable-features=WebRTCPipeWireCapturer',
    '--disable-features=DefaultANGLEVulkan,VulkanFromANGLE',
    '--use-gl=angle',
    '--use-angle=gl'
  );
  console.warn('[mswnlink] Experimental native Wayland enabled. Chromium may still print a Vulkan compatibility error on some drivers.');
} else if (isWaylandSession) {
  args.push('--ozone-platform=x11', '--enable-features=WebRTCPipeWireCapturer');
  if (legacyNativeRequest) {
    console.warn('[mswnlink] MSWNLINK_USE_WAYLAND=1 previously enabled native Wayland, which triggers a Vulkan compatibility error on this setup. Falling back to XWayland.');
    console.warn('[mswnlink] Use MSWNLINK_FORCE_NATIVE_WAYLAND=1 only to experiment with native Wayland.');
  } else {
    console.log('[mswnlink] Wayland detected; using XWayland + WebRTCPipeWireCapturer to avoid the native Wayland/Vulkan incompatibility.');
  }
}

if (process.env.MSWNLINK_DISABLE_GPU === '1') {
  // This optional diagnostic mode applies switches before the Electron process
  // starts, instead of relying only on main-process initialization.
  args.push('--disable-gpu', '--disable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE');
  console.log('[mswnlink] GPU acceleration disabled for this run.');
}

args.push(path.resolve(__dirname));
args.push(...process.argv.slice(2));

const child = spawn(electronExecutable, args, {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false
});

child.once('error', (error) => {
  console.error(`[mswnlink] Could not start Electron: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[mswnlink] Electron exited after signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code === null ? 1 : code;
  }
});

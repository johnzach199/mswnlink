'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, safeStorage, clipboard, dialog, screen, Menu, powerSaveBlocker, nativeTheme, systemPreferences } = require('electron');
const fs = require('node:fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('node:util');
const pbkdf2Async = promisify(crypto.pbkdf2);
const { execFile } = require('node:child_process');
const dgram = require('node:dgram');
const { WebSocketServer, WebSocket } = require('ws');
const LinuxWaylandInput = process.platform === 'linux' ? require('./linux-wayland-input') : null;
const WindowsInputBackend = process.platform === 'win32' ? require('./win32-input') : null;
const {
  mapRobotKey,
  modifierFlagForRobotKey,
  buildRobotModifiers,
  shortcutDescriptorForPlatform,
  parseDarwinMajor,
  evaluateMacScreenPermission,
  normalizeClipboardText,
  isLinuxWaylandEnv
} = require('./lib/input-protocol');
const isLinuxWaylandSession = Boolean(
  (LinuxWaylandInput && LinuxWaylandInput.isSupportedSession()) ||
  isLinuxWaylandEnv(process.env, process.platform)
);

if (isLinuxWaylandSession) {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

// Optional fallback for Linux systems whose Mesa/GBM driver cannot be opened.
// This must run before app.whenReady(); keep acceleration enabled by default.
if (process.env.MSWNLINK_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-features', 'Vulkan');
  console.warn('[mswnlink] Hardware acceleration disabled by MSWNLINK_DISABLE_GPU=1.');
}

const PORT = 49382;
const DISCOVERY_PORT = 49383;
const MAX_SIGNAL_BYTES = 1024 * 1024;
const MAX_FILE_TRANSFER_BYTES = 100 * 1024 * 1024;
const MAX_CLIPBOARD_CHARS = 1_000_000;
// Unattended access lets anyone who knows the code control the PC, so the code must resist guessing.
const UNATTENDED_MIN_CODE_LENGTH = 12;
const ALLOWED_SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate', 'hangup', 'control-mode']);

let mainWindow = null;
let wss = null;
let pairingCode = null; // Active listener's current passcode, updated only by the owner.
let persistentAccessCode = null; // Owner-configured passcode persisted via Electron safeStorage.
let accessCodeStorageError = '';
let chosenSourceId = null;
let pendingSocket = null;
let activeSocket = null;
let activePeer = null;
let inputAllowed = false;
let unattendedAccessEnabled = false;
let waylandInputManager = null;
let waylandRestoreToken = '';
let win32InputManager = null;
let robot = null;
const heldKeys = new Set();
const heldButtons = new Set();
const badAttempts = new Map();
let wheelRemainderX = 0;
let wheelRemainderY = 0;
const localDeviceId = crypto.randomUUID();
let discoverySocket = null;
let discoveryTimer = null;
const discoveredDevices = new Map();
// Clipboard sync is enabled by default as requested; users can disable it in the UI.
// Feature preferences are persisted so the settings survive app restarts.
let localFeaturePreferences = { clipboard: true, fileTransfer: false, monitorSwitching: true };
const incomingFileHandles = new Map();
let viewerSessionActive = false;
let sessionPowerSaveBlockerId = null;
let mainClipboardWatcher = null;
let mainClipboardPollInFlight = false;
let clipboardFallbackBusy = false;
let lastObservedMainClipboard = '';
let displayMediaUsingSystemPicker = null;

function featurePreferencesPath() {
  return path.join(app.getPath('userData'), 'feature-preferences.json');
}

async function loadLocalFeaturePreferences() {
  const defaults = { clipboard: true, fileTransfer: false, monitorSwitching: true };
  try {
    const raw = await fs.readFile(featurePreferencesPath(), 'utf8');
    const stored = JSON.parse(raw);
    for (const key of Object.keys(defaults)) {
      if (typeof stored[key] === 'boolean') defaults[key] = stored[key];
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.warn('[mswnlink] Could not load feature preferences; using defaults:', error && error.message ? error.message : error);
    }
  }
  localFeaturePreferences = defaults;
}

async function saveLocalFeaturePreferences() {
  const filePath = featurePreferencesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, JSON.stringify(localFeaturePreferences, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

try {
  // Use the native input backend when built for this Electron/OS combination.
  robot = require('robotjs');
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
} catch (error) {
  console.warn('[mswnlink] Native input backend is unavailable:', error.message);
}

function createWindow() {
  // Size the initial window to the available work area. The UI has compact
  // layouts down to small windows, so low-resolution displays are not clipped.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const minWindowWidth = Math.min(520, Math.max(360, workArea.width - 24));
  const minWindowHeight = Math.min(440, Math.max(320, workArea.height - 24));
  const initialWidth = Math.min(1240, Math.max(minWindowWidth, workArea.width - 32));
  const initialHeight = Math.min(820, Math.max(minWindowHeight, workArea.height - 32));

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: minWindowWidth,
    minHeight: minWindowHeight,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1110' : '#f2f5f4',
    title: 'mswnlink',
    // Replace the native title bar and default File/Edit/View menu with the
    // app's own draggable top bar in index.html. macOS keeps its native traffic
    // lights (inset into our bar); Windows and Linux use the bar's own buttons.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 19 } }
      : { frame: false }),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep WebRTC data channels, screen capture, and clipboard sync responsive
      // while mswnlink is minimized or behind another window (e.g. Task Manager).
      backgroundThrottling: false
    }
  });
  // Also disable any per-window default menu bar on Linux/Windows.
  mainWindow.setMenuBarVisibility(false);
  if (process.platform !== 'darwin') {
    mainWindow.removeMenu();
  }

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  const sendWindowState = () => sendToUI('window-state', { maximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()) });
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.on('enter-full-screen', sendWindowState);
  mainWindow.on('leave-full-screen', sendWindowState);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Do NOT call clearNativeInput() when the host's mswnlink window loses focus:
  // clicking another desktop window (such as Task Manager) blurs mswnlink on the
  // host and would prematurely cancel remote clicks/drags.
  mainWindow.on('focus', () => {
    if (process.platform === 'darwin') {
      configureDisplayMediaHandler();
      sendToUI('mac-permissions-changed', getMacPermissionSnapshot());
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendToUI(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function normalizeIp(value = '') {
  let ip = String(value).replace(/^::ffff:/i, '');
  if (ip === '::1') return '127.0.0.1';
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  return ip;
}

function isLanAddress(value = '') {
  const ip = normalizeIp(value).toLowerCase();
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254);
}

function getLanIPv4() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && isLanAddress(item.address)) result.push(item.address);
    }
  }
  return [...new Set(result)];
}

function ipv4ToUint(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | (Number(part) & 255)) >>> 0, 0) >>> 0;
}

function getBroadcastAddresses() {
  const result = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal || !item.address || !item.netmask || !isLanAddress(item.address)) continue;
      try {
        const address = ipv4ToUint(item.address);
        const mask = ipv4ToUint(item.netmask);
        const broadcast = ((address & mask) | (~mask >>> 0)) >>> 0;
        result.add([broadcast >>> 24, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.'));
      } catch {}
    }
  }
  return [...result];
}

function getDiscoveredDevices() {
  const now = Date.now();
  for (const [key, device] of discoveredDevices) {
    if (now - device.lastSeen > 15000) discoveredDevices.delete(key);
  }
  return [...discoveredDevices.values()]
    .map(({ lastSeen, ...device }) => ({ ...device, lastSeen }))
    .sort((a, b) => Number(b.sharing) - Number(a.sharing) || a.name.localeCompare(b.name));
}

function sendDiscoveredDevices() {
  sendToUI('discovered-devices', getDiscoveredDevices());
}

function announcePresence() {
  if (!discoverySocket) return;
  const packet = Buffer.from(JSON.stringify({
    magic: 'mswnlink-discovery', version: 1, id: localDeviceId,
    name: safeName(os.hostname()), platform: process.platform, port: PORT,
    sharing: Boolean(wss), inputAvailable: hasInputBackend(), time: Date.now()
  }));
  for (const target of getBroadcastAddresses()) {
    try { discoverySocket.send(packet, DISCOVERY_PORT, target, () => {}); } catch {}
  }
}

function startDeviceDiscovery() {
  if (discoverySocket) return;
  try {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discoverySocket = socket;
    socket.on('error', error => console.warn('[mswnlink] LAN discovery error:', error.message));
    socket.on('message', (message, remote) => {
      if (message.length > 4096) return;
      let packet;
      try { packet = JSON.parse(message.toString('utf8')); } catch { return; }
      if (!packet || packet.magic !== 'mswnlink-discovery' || packet.version !== 1 || packet.id === localDeviceId) return;
      if (typeof packet.id !== 'string' || packet.id.length > 100 || !isLanAddress(remote.address)) return;
      // Freshness is judged by when the packet arrived (lastSeen below), not by the sender's clock:
      // two PCs whose clocks differ by more than a few seconds would otherwise never see each other.
      const key = `${normalizeIp(remote.address)}:${PORT}`;
      discoveredDevices.set(key, {
        id: packet.id,
        name: safeName(packet.name),
        platform: ['linux', 'win32', 'darwin'].includes(packet.platform) ? packet.platform : 'unknown',
        address: normalizeIp(remote.address),
        port: PORT,
        sharing: packet.sharing === true,
        inputAvailable: packet.inputAvailable === true,
        lastSeen: Date.now()
      });
      sendDiscoveredDevices();
    });
    socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      try { socket.setBroadcast(true); } catch {}
      announcePresence();
      discoveryTimer = setInterval(() => {
        announcePresence();
        sendDiscoveredDevices();
      }, 3000);
      if (discoveryTimer.unref) discoveryTimer.unref();
    });
  } catch (error) {
    console.warn('[mswnlink] Could not start LAN discovery:', error.message);
    discoverySocket = null;
  }
}

function stopDeviceDiscovery() {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = null;
  const socket = discoverySocket;
  discoverySocket = null;
  if (socket) { try { socket.close(); } catch {} }
}

function hasActiveSession() {
  return viewerSessionActive || Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN);
}

async function readOsClipboardText() {
  // Electron 45+ changed clipboard.readText() to return Promise<string>.
  // Always await Promise.resolve(...) and normalize so "[object Promise]" is impossible.
  const raw = await Promise.resolve(clipboard.readText());
  return normalizeClipboardText(raw, MAX_CLIPBOARD_CHARS);
}

async function writeOsClipboardText(value) {
  const safe = normalizeClipboardText(value, MAX_CLIPBOARD_CHARS);
  await Promise.resolve(clipboard.writeText(safe));
  return safe;
}

function syncMainClipboardWatcherState() {
  const shouldWatch = hasActiveSession() && Boolean(localFeaturePreferences.clipboard);
  if (shouldWatch && !mainClipboardWatcher) {
    readOsClipboardText()
      .then((initial) => { lastObservedMainClipboard = initial; })
      .catch(() => { lastObservedMainClipboard = ''; });
    mainClipboardWatcher = setInterval(async () => {
      if (mainClipboardPollInFlight || clipboardFallbackBusy || !hasActiveSession() || !localFeaturePreferences.clipboard) return;
      mainClipboardPollInFlight = true;
      try {
        const current = await readOsClipboardText();
        if (current !== lastObservedMainClipboard) {
          lastObservedMainClipboard = current;
          sendToUI('local-clipboard-changed', { text: current });
        }
      } catch {}
      finally {
        mainClipboardPollInFlight = false;
      }
    }, 150);
    if (mainClipboardWatcher.unref) mainClipboardWatcher.unref();
  } else if (!shouldWatch && mainClipboardWatcher) {
    clearInterval(mainClipboardWatcher);
    mainClipboardWatcher = null;
    mainClipboardPollInFlight = false;
  }
}

function getMacPermissionSnapshot() {
  if (process.platform !== 'darwin') {
    return {
      isMac: false,
      status: 'granted',
      screen: 'granted',
      accessibility: true,
      darwinMajor: 0,
      granted: true,
      useSystemPickerFallback: false,
      needsAttention: false,
      canResetStaleTcc: false,
      summary: ''
    };
  }
  let screenStatus = 'not-determined';
  let accessibility = false;
  try { screenStatus = systemPreferences.getMediaAccessStatus('screen'); } catch {}
  try { accessibility = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
  const evaluated = evaluateMacScreenPermission(screenStatus, 'darwin', os.release());
  return {
    ...evaluated,
    screen: evaluated.status,
    accessibility
  };
}

function updateSessionPowerSaveBlocker() {
  // Keep long remote sessions from being suspended or having the display blanked
  // mid-session (a common source of apparent fullscreen freezes). Release it as
  // soon as both the viewer session and host peer are inactive.
  const active = viewerSessionActive || Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN);
  syncMainClipboardWatcherState();
  try {
    if (active && sessionPowerSaveBlockerId === null) {
      sessionPowerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      console.info('[mswnlink] Power-save blocker enabled for active remote session.');
    } else if (!active && sessionPowerSaveBlockerId !== null) {
      if (powerSaveBlocker.isStarted(sessionPowerSaveBlockerId)) powerSaveBlocker.stop(sessionPowerSaveBlockerId);
      sessionPowerSaveBlockerId = null;
    }
  } catch (error) {
    console.warn('[mswnlink] Could not update session power-save blocker:', error.message || error);
  }
}

function safeTransferFileName(value) {
  const name = String(value || 'received-file').replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_').trim().slice(0, 180);
  return name || 'received-file';
}

function validateAccessCode(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  if (code.length < 8 || code.length > 64 || /[\u0000-\u001f\u007f]/u.test(code)) return '';
  return code;
}

function getAccessCodeBackend() {
  try {
    return typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : (safeStorage.isEncryptionAvailable() ? 'system' : 'unavailable');
  } catch {
    return 'unknown';
  }
}

function getAccessCodeStorageWarning() {
  const backend = getAccessCodeBackend();
  if (backend === 'basic_text') {
    return 'Warning: this Linux session is using Electron basic_text storage, which does not protect the passcode well. Configure GNOME Keyring/libsecret or KWallet for stronger OS-backed storage.';
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return 'OS secure storage is unavailable. Set up your desktop keyring and restart mswnlink before saving a permanent passcode.';
  }
  return '';
}

function accessCodeFilePath() {
  return path.join(app.getPath('userData'), 'access-code.enc');
}

function unattendedSettingsPath() {
  return path.join(app.getPath('userData'), 'unattended-access.json');
}

async function loadUnattendedAccessSetting() {
  try {
    const value = JSON.parse(await fs.readFile(unattendedSettingsPath(), 'utf8'));
    unattendedAccessEnabled = value && value.enabled === true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') console.warn('[mswnlink] Could not load unattended-access preference:', error.message);
    unattendedAccessEnabled = false;
  }
  return unattendedAccessEnabled;
}

async function saveUnattendedAccessSetting(enabled) {
  const next = Boolean(enabled);
  if (next && !persistentAccessCode) {
    throw new Error('Save a permanent access passcode before enabling unattended access.');
  }
  if (next && persistentAccessCode.length < UNATTENDED_MIN_CODE_LENGTH) {
    throw new Error(`Connecting without asking needs an access code of at least ${UNATTENDED_MIN_CODE_LENGTH} characters (yours has ${persistentAccessCode.length}). Save a longer code first.`);
  }
  if (next && !hasInputBackend()) {
    throw new Error('Remote input is not available in this build. Unattended access requires a working mouse/keyboard input backend.');
  }
  // When the host is already sharing, prepare the platform input backend now;
  // otherwise the next password-authenticated peer could be accepted but have
  // nowhere to send input events. On Wayland this is also where the desktop
  // portal obtains keyboard/pointer permission from the local user.
  if (next && wss) await ensureInputBackend();
  const filePath = unattendedSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify({ enabled: next }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, filePath);
  unattendedAccessEnabled = next;
  if (!next && activeSocket && activeSocket.unattendedAccess) {
    closePeer('Unattended access was disabled on the host.');
  }
  return { enabled: unattendedAccessEnabled };
}

function waylandRestoreTokenPath() {
  return path.join(app.getPath('userData'), 'wayland-restore-token.enc');
}

async function loadWaylandRestoreToken() {
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    const encoded = (await fs.readFile(waylandRestoreTokenPath(), 'utf8')).trim();
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') console.warn('[mswnlink] Could not load Wayland restore token:', error.message);
    return '';
  }
}

async function saveWaylandRestoreToken(value) {
  waylandRestoreToken = typeof value === 'string' ? value : '';
  const filePath = waylandRestoreTokenPath();
  if (!waylandRestoreToken || !safeStorage.isEncryptionAvailable()) {
    try { await fs.unlink(filePath); } catch {}
    return;
  }
  const encrypted = safeStorage.encryptString(waylandRestoreToken).toString('base64');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, encrypted, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, filePath);
}

function hasInputBackend() {
  if (isLinuxWaylandSession) return Boolean(LinuxWaylandInput);
  if (process.platform === 'win32') return Boolean(WindowsInputBackend || robot);
  return Boolean(robot);
}

async function ensureInputBackend(options = {}) {
  const allowElevationPrompt = options.allowElevationPrompt !== false;
  if (isLinuxWaylandSession) {
    if (!LinuxWaylandInput) throw new Error('This Linux Wayland session needs the XDG desktop portal remote-desktop input backend. Update mswnlink and reinstall dependencies.');
    if (!waylandInputManager) waylandInputManager = new LinuxWaylandInput({ screen });
    if (waylandInputManager.isActive()) return true;
    const previousToken = waylandRestoreToken || await loadWaylandRestoreToken();
    // Portal restore tokens are one-use. Remove the old token before consuming it.
    waylandRestoreToken = '';
    try { await fs.unlink(waylandRestoreTokenPath()); } catch {}
    const result = await waylandInputManager.start(previousToken);
    if (result && result.restoreToken) await saveWaylandRestoreToken(result.restoreToken);
    return true;
  }
  if (process.platform === 'win32' && WindowsInputBackend) {
    if (!win32InputManager) {
      win32InputManager = new WindowsInputBackend({ userDataPath: app.getPath('userData'), screen });
    }
    try {
      await win32InputManager.start({ allowElevationPrompt });
      return true;
    } catch (error) {
      console.warn('[mswnlink] Windows native SendInput helper could not start; checking RobotJS fallback:', error.message);
      if (!robot) throw error;
    }
  }
  if (!robot) throw new Error('Mouse/keyboard control is unavailable. Build the RobotJS input backend for this operating system and architecture.');
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
    // The call above shows the macOS permission prompt. Without it, clicks and keys are silently ignored.
    throw new Error('macOS has not allowed mswnlink to control this Mac yet. Open System Settings › Privacy & Security › Accessibility, turn on mswnlink, then click Allow control again.');
  }
  return true;
}

async function loadSavedAccessCode() {
  const filePath = accessCodeFilePath();
  try {
    const stored = (await fs.readFile(filePath, 'utf8')).trim();
    if (!safeStorage.isEncryptionAvailable()) {
      accessCodeStorageError = 'The saved passcode exists, but OS secure storage is unavailable. Set up your desktop keyring and restart mswnlink.';
      return null;
    }
    const code = validateAccessCode(safeStorage.decryptString(Buffer.from(stored, 'base64')));
    if (!code) throw new Error('The saved passcode is invalid or damaged. Save a new passcode to replace it.');
    accessCodeStorageError = '';
    return code;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    accessCodeStorageError = error && error.message ? error.message : 'Could not read the saved passcode.';
    console.warn('[mswnlink] Could not load saved access code:', accessCodeStorageError);
    return null;
  }
}

async function savePersistentAccessCode(code) {
  if (unattendedAccessEnabled && code.length < UNATTENDED_MIN_CODE_LENGTH) {
    throw new Error(`While “Connect without asking” is on, the access code must be at least ${UNATTENDED_MIN_CODE_LENGTH} characters. Choose a longer code, or turn that setting off first.`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(getAccessCodeStorageWarning() || 'OS secure storage is unavailable. Set up your desktop keyring and restart mswnlink.');
  }
  const encrypted = safeStorage.encryptString(code);
  const filePath = accessCodeFilePath();
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  persistentAccessCode = code;
  accessCodeStorageError = '';
  if (wss) pairingCode = code;
  // Invalidate an already-approved pairing request made with the previous code.
  if (pendingSocket) {
    try { sendSocket(pendingSocket, { type: 'rejected', reason: 'The permanent access code changed. Please reconnect using the new code.' }); } catch {}
    try { pendingSocket.close(1008, 'Access code changed'); } catch {}
    pendingSocket = null;
    activePeer = null;
    sendToUI('incoming-cancelled', { reason: 'The permanent access code changed.' });
  }
  return { code, backend: getAccessCodeBackend(), warning: getAccessCodeStorageWarning() };
}

function parseMessage(raw) {
  if (Buffer.byteLength(raw) > MAX_SIGNAL_BYTES) return null;
  try {
    const message = JSON.parse(raw.toString());
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return null;
    return message;
  } catch {
    return null;
  }
}

function safeName(value) {
  const cleaned = String(value || 'Unknown device').replace(/[<>\u0000-\u001f]/g, '').trim();
  return cleaned.slice(0, 80) || 'Unknown device';
}

function screenCaptureErrorMessage(error) {
  const detail = error && error.message ? error.message : String(error || 'Unknown error');
  const waylandSession = process.platform === 'linux' && (
    String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
    Boolean(process.env.WAYLAND_DISPLAY)
  );
  if (waylandSession) {
    return `Linux screen capture could not access a display. mswnlink's source launcher tries XWayland automatically in Wayland sessions. If you are running a packaged app, try launching it with --ozone-platform=x11. If the problem persists, check that XWayland, PipeWire, and your desktop's xdg-desktop-portal backend are installed and running. Details: ${detail}`;
  }
  if (process.platform === 'linux') {
    return `Linux screen capture could not access a display. Check your desktop session and screen-capture permissions. Details: ${detail}`;
  }
  return `Could not access screen sources. Check screen-recording permissions and restart mswnlink. Details: ${detail}`;
}

// Asynchronous so a wrong-code flood or a slow login never freezes the window.
function derivePairKey(code, nonce) {
  return pbkdf2Async(code, nonce, 200000, 32, 'sha256');
}

function pairingProof(key, nonce) {
  return crypto.createHmac('sha256', key).update(`pair-proof|${nonce}`).digest('hex');
}

function messageMac(secret, nonce, object) {
  return crypto.createHmac('sha256', secret).update(`${nonce}|${JSON.stringify(object)}`).digest('hex');
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendSocket(socket, object) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (socket.authenticated && socket.authKey && socket.authNonce) {
    const envelope = { type: 'signed', payload: object, mac: messageMac(socket.authKey, socket.authNonce, object) };
    socket.send(JSON.stringify(envelope));
  } else {
    socket.send(JSON.stringify(object));
  }
}

function clearNativeInput() {
  if (win32InputManager && win32InputManager.isActive()) {
    try { win32InputManager.releaseAll(); } catch {}
  }
  if (robot) {
    const nonModifiers = [];
    const modifiers = [];
    for (const key of heldKeys) {
      if (modifierFlagForRobotKey(key)) modifiers.push(key);
      else nonModifiers.push(key);
    }
    for (const key of [...nonModifiers, ...modifiers]) {
      try { robot.keyToggle(key, 'up', []); } catch {}
    }
    for (const button of heldButtons) {
      try { robot.mouseToggle('up', button); } catch {}
    }
  }
  heldKeys.clear();
  heldButtons.clear();
  wheelRemainderX = 0;
  wheelRemainderY = 0;
  if (waylandInputManager) waylandInputManager.releaseAll().catch(error => {
    console.warn('[mswnlink] Could not release Wayland input state:', error.message);
  });
}

function closePeer(reason = 'Disconnected') {
  const oldSocket = activeSocket;
  activeSocket = null;
  activePeer = null;
  inputAllowed = false;
  clearNativeInput();
  updateSessionPowerSaveBlocker();
  if (oldSocket && oldSocket.readyState === WebSocket.OPEN) {
    try { sendSocket(oldSocket, { type: 'hangup', reason }); } catch {}
    try { oldSocket.close(); } catch {}
  }
  sendToUI('peer-disconnected', { reason });
}

function bindConnection(socket, req) {
  const remoteIp = normalizeIp(req.socket.remoteAddress || '');
  if (!isLanAddress(remoteIp)) {
    socket.close(1008, 'Local network only');
    return;
  }

  let authenticated = false;
  socket.authNonce = crypto.randomBytes(32).toString('hex');
  sendSocket(socket, { type: 'challenge', nonce: socket.authNonce });
  socket.on('message', async (raw) => {
    const msg = parseMessage(raw);
    if (!msg) {
      try { socket.close(1003, 'Invalid message'); } catch {}
      return;
    }

    if (!authenticated) {
      if (msg.type !== 'join' || typeof msg.proof !== 'string' || !/^[a-f0-9]{64}$/i.test(msg.proof)) {
        sendSocket(socket, { type: 'rejected', reason: 'Invalid pairing request.' });
        socket.close(1008, 'Invalid pairing request');
        return;
      }

      const now = Date.now();
      const previous = badAttempts.get(remoteIp) || { count: 0, time: now };
      if (now - previous.time > 60_000) { previous.count = 0; previous.time = now; }
      const derivedKey = await derivePairKey(pairingCode || '', socket.authNonce);
      const expectedProof = pairingProof(derivedKey, socket.authNonce);
      if (!safeEqualHex(msg.proof, expectedProof)) {
        // Never permanently lock out a LAN user after a fixed number of typos.
        // A small capped delay still makes blind guessing less attractive while
        // allowing the owner to keep correcting an incorrect passphrase.
        previous.count = Math.min(20, previous.count + 1);
        previous.time = now;
        badAttempts.set(remoteIp, previous);
        const responseDelayMs = Math.min(600, previous.count * 35);
        if (responseDelayMs > 0) await new Promise(resolve => setTimeout(resolve, responseDelayMs));
        sendSocket(socket, { type: 'rejected', reason: 'That permanent access code is not correct. You can try again immediately.' });
        socket.close(1008, 'Incorrect access code');
        return;
      }
      authenticated = true;
      socket.authenticated = true;
      socket.authKey = derivedKey;
      if (activeSocket || pendingSocket) {
        sendSocket(socket, { type: 'rejected', reason: 'This device is already in a session or has a request pending.' });
        socket.close(1008, 'Busy');
        return;
      }

      badAttempts.delete(remoteIp);
      activePeer = { name: safeName(msg.name), ip: remoteIp };
      if (unattendedAccessEnabled) {
        if (!hasInputBackend()) {
          sendSocket(socket, { type: 'rejected', reason: 'Unattended access is enabled, but remote input is unavailable on this host.' });
          try { socket.close(1008, 'Input unavailable'); } catch {}
          activePeer = null;
          return;
        }
        let backendReady = true;
        try { await ensureInputBackend({ allowElevationPrompt: false }); }
        catch (error) {
          console.warn('[mswnlink] Unattended input backend warm-up warning:', error.message);
          if (isLinuxWaylandSession) backendReady = Boolean(waylandInputManager && waylandInputManager.isActive());
        }
        activeSocket = socket;
        updateSessionPowerSaveBlocker();
        socket.unattendedAccess = true;
        inputAllowed = backendReady;
        sendSocket(activeSocket, { type: 'accepted', mode: inputAllowed ? 'control' : 'view', hostName: os.hostname(), unattended: true });
        sendToUI('peer-accepted', { peer: activePeer, mode: inputAllowed ? 'control' : 'view', inputAvailable: hasInputBackend(), unattended: true });
      } else {
        pendingSocket = socket;
        sendToUI('incoming-connection', { name: activePeer.name, ip: remoteIp });
      }
      return;
    }

    if (socket !== activeSocket) return;
    if (msg.type !== 'signed' || !msg.payload || typeof msg.mac !== 'string') {
      try { socket.close(1008, 'Signed signaling messages required'); } catch {}
      return;
    }
    const expectedMac = messageMac(socket.authKey, socket.authNonce, msg.payload);
    if (!safeEqualHex(msg.mac, expectedMac)) {
      try { socket.close(1008, 'Signaling authentication failed'); } catch {}
      return;
    }
    if (!ALLOWED_SIGNAL_TYPES.has(msg.payload.type)) return;
    sendToUI('host-signal', msg.payload);
  });

  socket.on('close', () => {
    if (socket === pendingSocket) {
      pendingSocket = null;
      activePeer = null;
      sendToUI('incoming-cancelled', {});
    }
    if (socket === activeSocket) {
      activeSocket = null;
      activePeer = null;
      inputAllowed = false;
      clearNativeInput();
      updateSessionPowerSaveBlocker();
      sendToUI('peer-disconnected', { reason: 'The other device disconnected.' });
    }
  });

  socket.on('error', (error) => console.warn('[mswnlink] WebSocket error:', error.message));
}

async function startHost() {
  if (!persistentAccessCode) throw new Error('Set a permanent access code on the Share this PC screen before starting to share.');
  // Also verify input readiness when Start Sharing is clicked a second time or
  // the setting was enabled while the listener was already running.
  if (unattendedAccessEnabled) {
    await ensureInputBackend();
  } else if (isLinuxWaylandSession) {
    // On Fedora/GNOME Wayland, prompt for the RemoteDesktop portal session right when
    // the owner clicks Start sharing so mouse/keyboard control is ready immediately
    // when a client joins (without blocking view-only sharing if cancelled).
    ensureInputBackend().catch((error) => {
      console.warn('[mswnlink] Wayland remote-input pre-warm deferred until control approval:', error.message);
    });
  }
  if (wss) return { code: pairingCode, port: PORT, ips: getLanIPv4() };
  pairingCode = persistentAccessCode;
  const server = new WebSocketServer({ host: '0.0.0.0', port: PORT, maxPayload: MAX_SIGNAL_BYTES });
  wss = server;
  server.on('connection', bindConnection);
  server.on('error', (error) => {
    console.error('[mswnlink] Host server error:', error.message);
    sendToUI('host-error', { message: error.message });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    try { server.close(); } catch {}
    wss = null;
    pairingCode = null;
    throw new Error(error.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Close the other service and try again.`
      : `Could not start the LAN listener: ${error.message}`);
  }
  announcePresence();
  sendDiscoveredDevices();
  return { code: pairingCode, port: PORT, ips: getLanIPv4() };
}

async function stopHost() {
  if (pendingSocket) {
    try { sendSocket(pendingSocket, { type: 'rejected', reason: 'Sharing was stopped on the host.' }); pendingSocket.close(); } catch {}
  }
  pendingSocket = null;
  if (activeSocket) closePeer('The host stopped sharing.');
  inputAllowed = false;
  const server = wss;
  wss = null;
  pairingCode = null;
  if (server) {
    try { server.close(); } catch {}
  }
  if (waylandInputManager) {
    const manager = waylandInputManager;
    waylandInputManager = null;
    try { await manager.close(); } catch (error) { console.warn('[mswnlink] Could not close Wayland input session:', error.message); }
  }
  if (win32InputManager) {
    const manager = win32InputManager;
    win32InputManager = null;
    try { await manager.close(); } catch (error) { console.warn('[mswnlink] Could not close Windows input helper:', error.message); }
  }
  sendToUI('host-stopped', {});
  announcePresence();
  sendDiscoveredDevices();
  return { ok: true };
}

async function injectTextViaClipboardFallback(text, triggerPasteShortcut) {
  const safeText = normalizeClipboardText(text, 256);
  if (!safeText) return { ok: true };
  clipboardFallbackBusy = true;
  let previousClipboard = '';
  try {
    previousClipboard = await readOsClipboardText();
  } catch {}
  try {
    await writeOsClipboardText(safeText);
    await new Promise(resolve => setTimeout(resolve, 18));
    await triggerPasteShortcut();
    await new Promise(resolve => setTimeout(resolve, 45));
    return { ok: true };
  } finally {
    try {
      await writeOsClipboardText(previousClipboard);
      lastObservedMainClipboard = previousClipboard;
    } catch {}
    clipboardFallbackBusy = false;
  }
}

function tryXdotoolType(text) {
  return new Promise((resolve) => {
    execFile('xdotool', ['type', '--clearmodifiers', '--delay', '0', '--', text], { timeout: 2500 }, (err) => {
      resolve(!err);
    });
  });
}

async function injectUnicodeTextOnDesktop(rawText) {
  const text = String(rawText || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);
  if (!text) return { ok: true };

  if (isLinuxWaylandSession) {
    if (!waylandInputManager || !waylandInputManager.isActive()) {
      throw new Error('Wayland remote input is not active. Approve the Fedora/GNOME remote interaction prompt.');
    }
    const res = await waylandInputManager.inject({ kind: 'text', text });
    if (res && res.fallbackPaste && res.remainingText) {
      return injectTextViaClipboardFallback(
        res.remainingText,
        () => waylandInputManager.inject({ kind: 'shortcut', action: 'paste' })
      );
    }
    return res || { ok: true };
  }

  if (process.platform === 'win32' && WindowsInputBackend) {
    if (!win32InputManager || !win32InputManager.isActive()) {
      await ensureInputBackend({ allowElevationPrompt: false }).catch(() => {});
    }
    if (win32InputManager && win32InputManager.isActive()) {
      return win32InputManager.inject({ kind: 'text', text });
    }
  }

  if (!robot) throw new Error('Native input backend is unavailable.');

  if (process.platform === 'darwin') {
    // On macOS, RobotJS typeString uses CGEventKeyboardSetUnicodeString (full UTF-16,
    // layout-independent — works for "'", '"', and Greek words like "έχω").
    if (typeof robot.typeString === 'function') {
      robot.typeString(text);
      return { ok: true };
    }
    return injectTextViaClipboardFallback(text, () => {
      const desc = shortcutDescriptorForPlatform('paste', 'darwin');
      robot.keyTap(desc.key, desc.modifiers);
    });
  }

  if (process.platform === 'linux') {
    // RobotJS X11 unicodeTap truncates code points > 0x7F to 8-bit `char`.
    // Printable ASCII (including "'" and '"') works cleanly via XSpecialCharacterTable;
    // non-ASCII Unicode (such as Greek "έχω") uses xdotool or lossless clipboard paste.
    if (/^[\x20-\x7e]+$/.test(text) && typeof robot.typeString === 'function') {
      robot.typeString(text);
      return { ok: true };
    }
    if (await tryXdotoolType(text)) {
      return { ok: true };
    }
    return injectTextViaClipboardFallback(text, () => {
      const desc = shortcutDescriptorForPlatform('paste', 'linux');
      robot.keyTap(desc.key, desc.modifiers);
    });
  }

  // Windows RobotJS fallback (when PowerShell worker is unavailable)
  if (typeof robot.typeString === 'function' && /^[\x20-\x7e]+$/.test(text)) {
    robot.typeString(text);
    return { ok: true };
  }
  return injectTextViaClipboardFallback(text, () => {
    const desc = shortcutDescriptorForPlatform('paste', process.platform);
    robot.keyTap(desc.key, desc.modifiers);
  });
}

async function injectInput(event) {
  if (!event || typeof event !== 'object') return { ok: false, reason: 'Invalid input event.' };
  // Release events are always honored, including after a focus loss or control
  // revocation, to prevent a stuck mouse button or modifier key.
  if (event.kind === 'releaseAll') { clearNativeInput(); return { ok: true }; }
  if (!hasInputBackend() || !activeSocket || !inputAllowed) {
    return { ok: false, reason: 'Control is not enabled.' };
  }
  try {
    if (event.kind === 'text') {
      return await injectUnicodeTextOnDesktop(event.text);
    }
    if (isLinuxWaylandSession) {
      if (!waylandInputManager || !waylandInputManager.isActive()) {
        await ensureInputBackend({ allowElevationPrompt: false }).catch(() => {});
      }
      if (!waylandInputManager || !waylandInputManager.isActive()) {
        throw new Error('Wayland remote input is not active. Click Allow control on the host and approve the desktop permission prompt.');
      }
      const res = await waylandInputManager.inject(event);
      if (res && res.fallbackPaste && res.remainingText) {
        return await injectTextViaClipboardFallback(
          res.remainingText,
          () => waylandInputManager.inject({ kind: 'shortcut', action: 'paste' })
        );
      }
      return res;
    }
    if (process.platform === 'win32' && WindowsInputBackend) {
      if (!win32InputManager || !win32InputManager.isActive()) {
        await ensureInputBackend({ allowElevationPrompt: false }).catch(() => {});
      }
      if (win32InputManager && win32InputManager.isActive()) {
        return win32InputManager.inject(event);
      }
    }
    if (!robot) throw new Error('Native input backend is unavailable.');
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      const targetDisplay = typeof event.displayId === 'string' && event.displayId
        ? screen.getAllDisplays().find(item => String(item.id) === event.displayId)
        : null;
      const bounds = targetDisplay ? targetDisplay.bounds : screen.getPrimaryDisplay().bounds;
      robot.moveMouse(
        Math.round(bounds.x + x * Math.max(0, bounds.width - 1)),
        Math.round(bounds.y + y * Math.max(0, bounds.height - 1))
      );
    } else if (event.kind === 'mouse') {
      const button = ({ 0: 'left', 1: 'middle', 2: 'right' })[Number(event.button)];
      if (!button) return { ok: false };
      if (event.action === 'down') { robot.mouseToggle('down', button); heldButtons.add(button); }
      else if (event.action === 'up') { robot.mouseToggle('up', button); heldButtons.delete(button); }
    } else if (event.kind === 'wheel') {
      wheelRemainderX += Math.max(-600, Math.min(600, Number(event.dx) || 0)) / 60;
      wheelRemainderY += Math.max(-600, Math.min(600, Number(event.dy) || 0)) / 60;
      const dx = Math.max(-10, Math.min(10, Math.trunc(wheelRemainderX)));
      const dy = Math.max(-10, Math.min(10, Math.trunc(wheelRemainderY)));
      wheelRemainderX -= dx;
      wheelRemainderY -= dy;
      if (dx || dy) robot.scrollMouse(dx, dy);
    } else if (event.kind === 'shortcut') {
      const desc = shortcutDescriptorForPlatform(String(event.action || ''), process.platform);
      if (!desc) return { ok: false, reason: 'Unsupported shortcut.' };
      robot.keyTap(desc.key, desc.modifiers);
    } else if (event.kind === 'key') {
      if (event.textInput === true) {
        if (event.action === 'down') {
          return await injectUnicodeTextOnDesktop(event.key);
        }
        return { ok: true };
      }
      const key = mapRobotKey(event, process.platform);
      if (!key) return { ok: false, reason: `Unsupported keyboard key (${String(event.code || event.key || 'unknown')}).` };
      const isMod = Boolean(modifierFlagForRobotKey(key));
      if (event.action === 'down') {
        const mods = isMod
          ? buildRobotModifiers([...heldKeys].filter(k => k !== key))
          : buildRobotModifiers(heldKeys, event);
        robot.keyToggle(key, 'down', mods);
        heldKeys.add(key);
      } else if (event.action === 'up') {
        heldKeys.delete(key);
        const mods = buildRobotModifiers(heldKeys);
        robot.keyToggle(key, 'up', mods);
      }
    }
    return { ok: true };
  } catch (error) {
    // Reset held keys/buttons when an OS focus/permission transition interrupts active input.
    if (event.kind !== 'move' || heldButtons.size > 0 || heldKeys.size > 0) {
      clearNativeInput();
    }
    console.warn('[mswnlink] Could not inject input:', error.message);
    return { ok: false, reason: error.message };
  }
}

function configureDisplayMediaHandler() {
  const snapshot = getMacPermissionSnapshot();
  const wantSystemPicker = Boolean(snapshot.isMac && snapshot.useSystemPickerFallback);
  if (displayMediaUsingSystemPicker === wantSystemPicker) return;

  const handler = async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 100 } });
      const source = sources.find(item => item.id === chosenSourceId) || sources[0];
      if (!source) {
        const perm = getMacPermissionSnapshot();
        const message = perm.isMac && !perm.granted
          ? (perm.summary || 'macOS Screen Recording permission is required. Allow mswnlink in System Settings › Privacy & Security › Screen & System Audio Recording.')
          : 'No capturable display was returned by the operating system.';
        sendToUI('host-error', { message });
        if (perm.isMac) sendToUI('mac-permissions-changed', perm);
        // Electron requires an object (`{}`), never `null`, when declining display media.
        callback({});
        return;
      }
      if (process.platform === 'darwin') {
        // Now that TCC access succeeded, switch to programmatic handler if needed.
        setImmediate(() => {
          configureDisplayMediaHandler();
          sendToUI('mac-permissions-changed', getMacPermissionSnapshot());
        });
      }
      callback({ video: source });
    } catch (error) {
      const perm = getMacPermissionSnapshot();
      const message = perm.isMac && !perm.granted && perm.summary
        ? perm.summary
        : screenCaptureErrorMessage(error);
      console.warn('[mswnlink] Screen capture request failed:', message);
      sendToUI('host-error', { message });
      if (perm.isMac) sendToUI('mac-permissions-changed', perm);
      callback({});
    }
  };

  try {
    if (wantSystemPicker) {
      session.defaultSession.setDisplayMediaRequestHandler(handler, { useSystemPicker: true });
      displayMediaUsingSystemPicker = true;
    } else {
      session.defaultSession.setDisplayMediaRequestHandler(handler);
      displayMediaUsingSystemPicker = false;
    }
  } catch {
    session.defaultSession.setDisplayMediaRequestHandler(handler);
    displayMediaUsingSystemPicker = false;
  }
}

app.whenReady().then(async () => {
  // Windows/Linux: no menu bar. macOS: route Cmd+C/V/X/A/Z through our custom
  // Edit menu handler so shortcuts reach the remote desktop when the viewer
  // stage is focused, while still working normally in local text inputs.
  if (process.platform === 'darwin') {
    const dispatchEdit = (action) => () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      sendToUI('menu-edit-action', { action });
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Edit',
        submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: dispatchEdit('undo') },
          { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: dispatchEdit('redo') },
          { type: 'separator' },
          { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: dispatchEdit('cut') },
          { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: dispatchEdit('copy') },
          { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: dispatchEdit('paste') },
          { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: dispatchEdit('selectAll') }
        ]
      },
      { role: 'windowMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  ipcMain.handle('window:minimize', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    mainWindow.minimize();
    return true;
  });
  ipcMain.handle('window:toggle-maximize', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    // The custom close control means close the app, not leave an invisible
    // background listener running after its only window is gone.
    app.quit();
    return true;
  });

  await loadLocalFeaturePreferences();
  persistentAccessCode = await loadSavedAccessCode();
  await loadUnattendedAccessSetting();
  if (unattendedAccessEnabled && (!persistentAccessCode || persistentAccessCode.length < UNATTENDED_MIN_CODE_LENGTH)) {
    // A short code was saved before this rule existed. Fail safe: ask for approval until a longer code is set.
    console.warn('[mswnlink] Turning off unattended access: the saved access code is too short.');
    unattendedAccessEnabled = false;
    try { await fs.writeFile(unattendedSettingsPath(), JSON.stringify({ enabled: false }, null, 2), { encoding: 'utf8', mode: 0o600 }); } catch {}
  }
  waylandRestoreToken = await loadWaylandRestoreToken();
  configureDisplayMediaHandler();

  ipcMain.handle('perform-edit-action', (event, action) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
    const wc = mainWindow.webContents;
    switch (String(action || '')) {
      case 'undo': wc.undo(); return true;
      case 'redo': wc.redo(); return true;
      case 'cut': wc.cut(); return true;
      case 'copy': wc.copy(); return true;
      case 'paste': wc.paste(); return true;
      case 'selectAll': wc.selectAll(); return true;
      default: return false;
    }
  });

  ipcMain.handle('get-mac-permissions', () => {
    configureDisplayMediaHandler();
    return getMacPermissionSnapshot();
  });

  ipcMain.handle('request-mac-screen-permission', async () => {
    if (process.platform !== 'darwin') return getMacPermissionSnapshot();
    try {
      // Enumerating screen sources via ScreenCaptureKit triggers the one-time
      // macOS Screen Recording prompt when status is 'not-determined'.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 64, height: 40 } });
    } catch {}
    configureDisplayMediaHandler();
    const snapshot = getMacPermissionSnapshot();
    sendToUI('mac-permissions-changed', snapshot);
    return snapshot;
  });

  ipcMain.handle('open-mac-privacy-settings', async (_event, pane = 'screen') => {
    if (process.platform !== 'darwin') return { ok: false };
    const url = pane === 'accessibility'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Could not open System Settings.' };
    }
  });

  ipcMain.handle('reset-mac-screen-permission', async () => {
    if (process.platform !== 'darwin') return { ok: false };
    await new Promise((resolve) => {
      execFile('tccutil', ['reset', 'ScreenCapture', 'com.mswnlink.lan'], { timeout: 5000 }, () => resolve());
    });
    configureDisplayMediaHandler();
    const snapshot = getMacPermissionSnapshot();
    sendToUI('mac-permissions-changed', snapshot);
    return { ok: true, ...snapshot };
  });

  ipcMain.handle('get-access-code', () => ({
    configured: Boolean(persistentAccessCode),
    code: persistentAccessCode || '',
    backend: getAccessCodeBackend(),
    warning: getAccessCodeStorageWarning(),
    error: accessCodeStorageError
  }));

  ipcMain.handle('save-access-code', async (_event, value) => {
    const code = validateAccessCode(value);
    if (!code) return { ok: false, error: 'Choose a passcode between 8 and 64 characters. Avoid line breaks and control characters.' };
    try {
      const saved = await savePersistentAccessCode(code);
      return { ok: true, ...saved };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Could not save the passcode securely.' };
    }
  });

  ipcMain.handle('get-unattended-access', () => ({ enabled: unattendedAccessEnabled, inputAvailable: hasInputBackend(), wayland: isLinuxWaylandSession }));
  ipcMain.handle('set-unattended-access', async (_event, enabled) => {
    try {
      const result = await saveUnattendedAccessSetting(Boolean(enabled));
      return { ok: true, ...result, inputAvailable: hasInputBackend() };
    } catch (error) {
      return { ok: false, enabled: unattendedAccessEnabled, error: error.message || 'Could not update unattended access.' };
    }
  });

  ipcMain.handle('device-info', () => {
    const macPerm = getMacPermissionSnapshot();
    return {
      name: os.hostname(),
      platform: process.platform,
      osRelease: os.release(),
      darwinMajor: parseDarwinMajor(os.release()),
      waylandSession: isLinuxWaylandSession,
      ips: getLanIPv4(),
      inputAvailable: hasInputBackend(),
      inputBackend: isLinuxWaylandSession
        ? 'desktop-portal'
        : (process.platform === 'win32' && WindowsInputBackend ? 'win32-sendinput' : (robot ? 'robotjs' : 'unavailable')),
      unattendedAccess: unattendedAccessEnabled,
      unattendedMinCodeLength: UNATTENDED_MIN_CODE_LENGTH,
      macScreenAccess: process.platform === 'darwin' ? macPerm.screen : null,
      macPermissions: process.platform === 'darwin' ? macPerm : null
    };
  });

  ipcMain.handle('get-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 360, height: 220 },
        fetchWindowIcons: false
      });
      const nativeDisplays = screen.getAllDisplays();
      return sources.map((source, index) => {
        let display = source.display_id
          ? nativeDisplays.find(item => String(item.id) === String(source.display_id))
          : null;
        // Some Electron backends (notably older X11/Windows capture paths) omit
        // or mismatch display_id. Use the documented source label when possible,
        // otherwise use array order only if there is a one-to-one source/display list.
        if (!display && nativeDisplays.length === sources.length) {
          const match = String(source.name || '').match(/(?:screen|display|monitor)\s*#?\s*(\d+)/i);
          if (match) {
            const labelIndex = Number(match[1]) - 1;
            if (Number.isInteger(labelIndex) && labelIndex >= 0 && labelIndex < nativeDisplays.length) display = nativeDisplays[labelIndex];
          }
          if (!display) display = nativeDisplays[index] || null;
        }
        return {
          id: source.id,
          name: source.name || `Display ${index + 1}`,
          displayId: display ? String(display.id) : (source.display_id ? String(source.display_id) : ''),
          bounds: display ? { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height } : null,
          scaleFactor: display ? Number(display.scaleFactor) || 1 : 1,
          thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : ''
        };
      });
    } catch (error) {
      const message = screenCaptureErrorMessage(error);
      console.warn('[mswnlink] Could not list screen sources:', message);
      throw new Error(message);
    }
  });

  ipcMain.handle('choose-source', async (_event, id) => {
    if (typeof id !== 'string') return false;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.some(source => source.id === id)) return false;
      chosenSourceId = id;
      return true;
    } catch (error) {
      throw new Error(screenCaptureErrorMessage(error));
    }
  });

  ipcMain.handle('make-pair-proof', async (_event, value, nonce) => {
    const code = validateAccessCode(value);
    if (!code || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/i.test(nonce)) throw new Error('Invalid pairing challenge. Use the saved 8–64 character access code.');
    const key = await derivePairKey(code, nonce);
    return { proof: pairingProof(key, nonce), key: key.toString('hex') };
  });
  ipcMain.handle('sign-pair-message', (_event, keyHex, nonce, message) => {
    if (typeof keyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(keyHex) || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/i.test(nonce) || !message || typeof message !== 'object' || !ALLOWED_SIGNAL_TYPES.has(message.type)) throw new Error('Invalid signaling message.');
    return { type: 'signed', payload: message, mac: messageMac(Buffer.from(keyHex, 'hex'), nonce, message) };
  });
  ipcMain.handle('verify-pair-message', (_event, keyHex, nonce, envelope) => {
    if (typeof keyHex !== 'string' || !/^[a-f0-9]{64}$/i.test(keyHex) || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/i.test(nonce) || !envelope || envelope.type !== 'signed' || !envelope.payload || typeof envelope.payload !== 'object') return false;
    const expected = messageMac(Buffer.from(keyHex, 'hex'), nonce, envelope.payload);
    return safeEqualHex(envelope.mac, expected);
  });

  ipcMain.handle('host-start', async () => startHost());
  ipcMain.handle('host-stop', () => stopHost());
  ipcMain.handle('host-resolve-join', async (_event, mode) => {
    if (!pendingSocket || pendingSocket.readyState !== WebSocket.OPEN) return { ok: false };
    if (!['view', 'control', 'reject'].includes(mode)) return { ok: false };
    const socket = pendingSocket;
    if (mode === 'reject') {
      pendingSocket = null;
      sendSocket(socket, { type: 'rejected', reason: 'The request was declined on the host.' });
      try { socket.close(); } catch {}
      activePeer = null;
      sendToUI('incoming-cancelled', {});
      return { ok: true };
    }
    if (mode === 'control') {
      try { await ensureInputBackend(); }
      catch (error) {
        // Keep the authenticated request pending so the host can retry in
        // view-only mode or resolve the portal/input permission error. Do not
        // orphan the socket with neither pendingSocket nor activeSocket set.
        pendingSocket = socket;
        return { ok: false, error: error.message || 'Could not enable remote input.' };
      }
    }
    pendingSocket = null;
    activeSocket = socket;
    updateSessionPowerSaveBlocker();
    activeSocket.unattendedAccess = false;
    inputAllowed = mode === 'control' && hasInputBackend();
    sendSocket(activeSocket, { type: 'accepted', mode: inputAllowed ? 'control' : 'view', hostName: os.hostname(), unattended: false });
    sendToUI('peer-accepted', { peer: activePeer, mode: inputAllowed ? 'control' : 'view', inputAvailable: hasInputBackend(), unattended: false });
    return { ok: true, mode: inputAllowed ? 'control' : 'view' };
  });
  ipcMain.handle('host-end-peer', (_event, reason) => {
    if (activeSocket) closePeer(typeof reason === 'string' ? reason.slice(0, 160) : 'The host ended the session.');
    return { ok: true };
  });
  ipcMain.handle('host-send-signal', (_event, message) => {
    if (!message || !ALLOWED_SIGNAL_TYPES.has(message.type) || !activeSocket || activeSocket.readyState !== WebSocket.OPEN) return false;
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_SIGNAL_BYTES) return false;
    sendSocket(activeSocket, message);
    return true;
  });
  ipcMain.handle('set-input-allowed', async (_event, allowed) => {
    const hasLivePeer = Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN);
    if (allowed && hasLivePeer) {
      try { await ensureInputBackend(); } catch (error) { return { allowed: false, inputAvailable: hasInputBackend(), error: error.message || 'Could not enable input.' }; }
    }
    inputAllowed = Boolean(allowed && hasInputBackend() && hasLivePeer);
    if (!inputAllowed) clearNativeInput();
    if (hasLivePeer) {
      sendSocket(activeSocket, { type: 'control-mode', allowed: inputAllowed });
      sendToUI('input-mode-changed', { allowed: inputAllowed, inputAvailable: hasInputBackend() });
    }
    return { allowed: inputAllowed, inputAvailable: hasInputBackend() };
  });
  ipcMain.handle('inject-input', (_event, event) => injectInput(event));

  ipcMain.handle('discover-devices', () => {
    announcePresence();
    return getDiscoveredDevices();
  });
  ipcMain.handle('get-local-features', () => ({ ...localFeaturePreferences }));
  ipcMain.handle('set-local-feature', async (_event, feature, enabled) => {
    if (!['clipboard', 'fileTransfer', 'monitorSwitching'].includes(feature)) return { ok: false, error: 'Unknown local sharing feature.' };
    const previous = { ...localFeaturePreferences };
    localFeaturePreferences[feature] = Boolean(enabled);
    try {
      await saveLocalFeaturePreferences();
    } catch (error) {
      localFeaturePreferences = previous;
      return { ok: false, error: error && error.message ? error.message : 'Could not save feature preferences.' };
    }
    sendToUI('local-features-changed', { ...localFeaturePreferences });
    syncMainClipboardWatcherState();
    return { ok: true, features: { ...localFeaturePreferences } };
  });
  ipcMain.handle('set-viewer-session-active', (_event, active) => {
    viewerSessionActive = Boolean(active);
    updateSessionPowerSaveBlocker();
    return { ok: true };
  });
  ipcMain.handle('read-local-clipboard', async () => {
    if (!localFeaturePreferences.clipboard) return { ok: false, error: 'Enable clipboard sharing on this device first.' };
    try {
      const text = await readOsClipboardText();
      lastObservedMainClipboard = text;
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Could not read the local clipboard.' };
    }
  });
  ipcMain.handle('write-local-clipboard', async (_event, value) => {
    if (!localFeaturePreferences.clipboard) return { ok: false, error: 'Clipboard sharing is disabled on this device.' };
    if (typeof value !== 'string' || value.length > MAX_CLIPBOARD_CHARS) return { ok: false, error: 'Clipboard text is invalid or too large.' };
    try {
      lastObservedMainClipboard = value;
      await writeOsClipboardText(value);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : 'Could not update the local clipboard.' };
    }
  });
  ipcMain.handle('pick-file-to-send', async () => {
    if (!hasActiveSession()) return { ok: false, error: 'Connect to a device before sending a file.' };
    const choice = await dialog.showOpenDialog(mainWindow, { title: 'Choose a file to send', properties: ['openFile'] });
    if (choice.canceled || !choice.filePaths.length) return { ok: false, cancelled: true };
    const filePath = choice.filePaths[0];
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: 'Only regular files can be transferred.' };
    if (stat.size > MAX_FILE_TRANSFER_BYTES) return { ok: false, error: 'Files must be 100 MB or smaller in this version.' };
    const bytes = await fs.readFile(filePath);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { ok: true, name: path.basename(filePath), size: stat.size, type: 'application/octet-stream', data };
  });
  ipcMain.handle('begin-file-receive', async (_event, details) => {
    if (!hasActiveSession()) return { ok: false, error: 'No active remote session.' };
    if (!localFeaturePreferences.fileTransfer) return { ok: false, error: 'File transfers are disabled on this device.' };
    const name = safeTransferFileName(details && details.name);
    const size = Number(details && details.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_TRANSFER_BYTES) return { ok: false, error: 'File must be 100 MB or smaller.' };
    const choice = await dialog.showSaveDialog(mainWindow, { title: 'Save incoming file', defaultPath: name, buttonLabel: 'Accept file' });
    if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
    const token = crypto.randomBytes(18).toString('hex');
    const temporaryPath = `${choice.filePath}.mswnlink-${token}.part`;
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    incomingFileHandles.set(token, { handle, temporaryPath, finalPath: choice.filePath, expected: size, written: 0 });
    return { ok: true, token };
  });
  ipcMain.handle('write-file-chunk', async (_event, token, data) => {
    const transfer = incomingFileHandles.get(String(token || ''));
    if (!transfer || !hasActiveSession() || !localFeaturePreferences.fileTransfer) return { ok: false, error: 'The file transfer is no longer active.' };
    let chunk;
    if (data instanceof ArrayBuffer) chunk = Buffer.from(data);
    else if (ArrayBuffer.isView(data)) chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else return { ok: false, error: 'Invalid file chunk.' };
    if (chunk.length > 128 * 1024 || transfer.written + chunk.length > transfer.expected) return { ok: false, error: 'Invalid file chunk size.' };
    await transfer.handle.write(chunk, 0, chunk.length, null);
    transfer.written += chunk.length;
    return { ok: true, written: transfer.written };
  });
  ipcMain.handle('finish-file-receive', async (_event, token) => {
    const transfer = incomingFileHandles.get(String(token || ''));
    if (!transfer) return { ok: false, error: 'The file transfer has expired.' };
    incomingFileHandles.delete(String(token));
    try {
      if (transfer.written !== transfer.expected) throw new Error(`Incomplete file: received ${transfer.written} of ${transfer.expected} bytes.`);
      await transfer.handle.close();
      try { await fs.rename(transfer.temporaryPath, transfer.finalPath); }
      catch (error) {
        if (process.platform === 'win32') { await fs.copyFile(transfer.temporaryPath, transfer.finalPath); await fs.unlink(transfer.temporaryPath); }
        else throw error;
      }
      return { ok: true, path: transfer.finalPath };
    } catch (error) {
      try { await transfer.handle.close(); } catch {}
      try { await fs.unlink(transfer.temporaryPath); } catch {}
      return { ok: false, error: error.message || 'Could not save the received file.' };
    }
  });
  ipcMain.handle('abort-file-receive', async (_event, token) => {
    const transfer = incomingFileHandles.get(String(token || ''));
    if (!transfer) return { ok: true };
    incomingFileHandles.delete(String(token));
    try { await transfer.handle.close(); } catch {}
    try { await fs.unlink(transfer.temporaryPath); } catch {}
    return { ok: true };
  });

  startDeviceDiscovery();
  createWindow();
});

app.on('before-quit', () => {
  stopDeviceDiscovery();
  if (mainClipboardWatcher) {
    clearInterval(mainClipboardWatcher);
    mainClipboardWatcher = null;
  }
  if (sessionPowerSaveBlockerId !== null) {
    try { if (powerSaveBlocker.isStarted(sessionPowerSaveBlockerId)) powerSaveBlocker.stop(sessionPowerSaveBlockerId); } catch {}
    sessionPowerSaveBlockerId = null;
  }
  for (const [token, transfer] of incomingFileHandles) {
    incomingFileHandles.delete(token);
    transfer.handle.close().catch(() => {});
    fs.unlink(transfer.temporaryPath).catch(() => {});
  }
  stopHost().catch(error => console.warn('[mswnlink] Shutdown cleanup failed:', error.message));
});

app.on('window-all-closed', () => {
  // A hidden background listener is surprising for a LAN remote-control app.
  // Closing its only window ends the process on every supported platform.
  app.quit();
});

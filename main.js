'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, safeStorage, clipboard, dialog, screen, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('node:dgram');
const { WebSocketServer, WebSocket } = require('ws');
const LinuxWaylandInput = process.platform === 'linux' ? require('./linux-wayland-input') : null;
const isLinuxWaylandSession = Boolean(LinuxWaylandInput && LinuxWaylandInput.isSupportedSession());

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
const localFeaturePreferences = { clipboard: false, fileTransfer: false, monitorSwitching: false };
const incomingFileHandles = new Map();
let viewerSessionActive = false;

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
    backgroundColor: '#f6f8fb',
    title: 'mswnlink',
    // Replace the native title bar and default File/Edit/View menu with the
    // app's slim, integrated draggable chrome in index.html.
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // Also disable any per-window default menu bar on Linux/Windows.
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

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
      if (Number(packet.time) > Date.now() + 15000 || Date.now() - Number(packet.time) > 15000) return;
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
  return Boolean(robot);
}

async function ensureInputBackend() {
  if (isLinuxWaylandSession) {
    if (!LinuxWaylandInput) throw new Error('This Linux Wayland session needs the XDG desktop portal remote-desktop input backend. Update mswnlink and reinstall dependencies.');
    if (!waylandInputManager) waylandInputManager = new LinuxWaylandInput();
    const previousToken = waylandRestoreToken || await loadWaylandRestoreToken();
    // Portal restore tokens are one-use. Remove the old token before consuming it.
    waylandRestoreToken = '';
    try { await fs.unlink(waylandRestoreTokenPath()); } catch {}
    const result = await waylandInputManager.start(previousToken);
    if (result && result.restoreToken) await saveWaylandRestoreToken(result.restoreToken);
    return true;
  }
  if (!robot) throw new Error('Mouse/keyboard control is unavailable. Build the RobotJS input backend for this operating system and architecture.');
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

function derivePairKey(code, nonce) {
  return crypto.pbkdf2Sync(code, nonce, 200000, 32, 'sha256');
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
  if (robot) {
    for (const key of heldKeys) {
      try { robot.keyToggle(key, 'up'); } catch {}
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
  socket.on('message', (raw) => {
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
      if (previous.count >= 5) {
        sendSocket(socket, { type: 'rejected', reason: 'Too many attempts. Try again in one minute.' });
        socket.close(1008, 'Rate limited');
        return;
      }
      const derivedKey = derivePairKey(pairingCode || '', socket.authNonce);
      const expectedProof = pairingProof(derivedKey, socket.authNonce);
      if (!safeEqualHex(msg.proof, expectedProof)) {
        previous.count += 1;
        previous.time = now;
        badAttempts.set(remoteIp, previous);
        sendSocket(socket, { type: 'rejected', reason: 'That permanent access code is not correct.' });
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
        activeSocket = socket;
        socket.unattendedAccess = true;
        inputAllowed = true;
        sendSocket(activeSocket, { type: 'accepted', mode: 'control', hostName: os.hostname(), unattended: true });
        sendToUI('peer-accepted', { peer: activePeer, mode: 'control', inputAvailable: true, unattended: true });
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
      sendToUI('peer-disconnected', { reason: 'The other device disconnected.' });
    }
  });

  socket.on('error', (error) => console.warn('[mswnlink] WebSocket error:', error.message));
}

async function startHost() {
  if (!persistentAccessCode) throw new Error('Set a permanent access code on the Share this PC screen before starting to share.');
  // Also verify input readiness when Start Sharing is clicked a second time or
  // the setting was enabled while the listener was already running.
  if (unattendedAccessEnabled) await ensureInputBackend();
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
  sendToUI('host-stopped', {});
  announcePresence();
  sendDiscoveredDevices();
  return { ok: true };
}

function mapKey(event) {
  const code = String(event.code || '');
  const named = {
    Enter: 'enter', Escape: 'escape', Backspace: 'backspace', Tab: 'tab', Space: 'space',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'control', ControlRight: 'control',
    AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'command', MetaRight: 'command',
    CapsLock: 'capslock', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup',
    PageDown: 'pagedown', Insert: 'insert', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', NumpadAdd: 'add', NumpadSubtract: 'subtract',
    NumpadMultiply: 'multiply', NumpadDivide: 'divide', NumpadDecimal: 'decimal',
    NumpadEnter: 'enter', PrintScreen: 'printscreen', ScrollLock: 'scrolllock', Pause: 'pause'
  };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `numpad_${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  const key = String(event.key || '').toLowerCase();
  if (/^[a-z0-9]$/.test(key)) return key;
  return null;
}

async function injectInput(event) {
  if (!hasInputBackend() || !activeSocket || !inputAllowed || !event || typeof event !== 'object') {
    return { ok: false, reason: 'Control is not enabled.' };
  }
  try {
    if (isLinuxWaylandSession) {
      if (!waylandInputManager) throw new Error('Wayland remote input is not active. Start sharing again and approve the desktop permission prompt.');
      return await waylandInputManager.inject(event);
    }
    if (!robot) throw new Error('Native input backend is unavailable.');
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      // In all-displays mode the renderer sends a trusted local displayId and
      // coordinates normalized inside that monitor. Use Electron's desktop
      // geometry so clicks land on the selected monitor rather than the primary.
      const targetDisplay = typeof event.displayId === 'string' && event.displayId
        ? screen.getAllDisplays().find(item => String(item.id) === event.displayId)
        : null;
      if (targetDisplay) {
        const bounds = targetDisplay.bounds;
        robot.moveMouse(
          Math.round(bounds.x + x * Math.max(0, bounds.width - 1)),
          Math.round(bounds.y + y * Math.max(0, bounds.height - 1))
        );
      } else {
        const size = robot.getScreenSize();
        robot.moveMouse(Math.round(x * Math.max(0, size.width - 1)), Math.round(y * Math.max(0, size.height - 1)));
      }
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
    } else if (event.kind === 'key') {
      const key = mapKey(event);
      if (!key) return { ok: false, reason: 'Unsupported key.' };
      if (event.action === 'down') { robot.keyToggle(key, 'down'); heldKeys.add(key); }
      else if (event.action === 'up') { robot.keyToggle(key, 'up'); heldKeys.delete(key); }
    } else if (event.kind === 'releaseAll') clearNativeInput();
    return { ok: true };
  } catch (error) {
    console.warn('[mswnlink] Could not inject input:', error.message);
    return { ok: false, reason: error.message };
  }
}

app.whenReady().then(async () => {
  // Hide Electron's native application menu on macOS and the default menu on
  // Windows/Linux; the app uses its own minimal title chrome instead.
  Menu.setApplicationMenu(null);

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

  persistentAccessCode = await loadSavedAccessCode();
  await loadUnattendedAccessSetting();
  waylandRestoreToken = await loadWaylandRestoreToken();
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 100 } });
      const source = sources.find(item => item.id === chosenSourceId) || sources[0];
      callback(source ? { video: source } : null);
    } catch (error) {
      const message = screenCaptureErrorMessage(error);
      console.warn('[mswnlink] Screen capture request failed:', message);
      sendToUI('host-error', { message });
      callback(null);
    }
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

  ipcMain.handle('device-info', () => ({
    name: os.hostname(),
    platform: process.platform,
    waylandSession: process.platform === 'linux' && (
      String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
      Boolean(process.env.WAYLAND_DISPLAY)
    ),
    ips: getLanIPv4(),
    inputAvailable: hasInputBackend(),
    inputBackend: isLinuxWaylandSession ? 'desktop-portal' : (robot ? 'robotjs' : 'unavailable'),
    unattendedAccess: unattendedAccessEnabled
  }));

  ipcMain.handle('get-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 360, height: 220 },
        fetchWindowIcons: false
      });
      const nativeDisplays = screen.getAllDisplays();
      return sources.map((source, index) => {
        const display = source.display_id
          ? nativeDisplays.find(item => String(item.id) === String(source.display_id))
          : null;
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

  ipcMain.handle('make-pair-proof', (_event, value, nonce) => {
    const code = validateAccessCode(value);
    if (!code || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/i.test(nonce)) throw new Error('Invalid pairing challenge. Use the saved 8–64 character access code.');
    const key = derivePairKey(code, nonce);
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
  ipcMain.handle('set-local-feature', (_event, feature, enabled) => {
    if (!['clipboard', 'fileTransfer', 'monitorSwitching'].includes(feature)) return { ok: false, error: 'Unknown local sharing feature.' };
    localFeaturePreferences[feature] = Boolean(enabled);
    sendToUI('local-features-changed', { ...localFeaturePreferences });
    return { ok: true, features: { ...localFeaturePreferences } };
  });
  ipcMain.handle('set-viewer-session-active', (_event, active) => {
    viewerSessionActive = Boolean(active);
    return { ok: true };
  });
  ipcMain.handle('read-local-clipboard', () => {
    if (!localFeaturePreferences.clipboard) return { ok: false, error: 'Enable clipboard sharing on this device first.' };
    return { ok: true, text: String(clipboard.readText() || '').slice(0, MAX_CLIPBOARD_CHARS) };
  });
  ipcMain.handle('write-local-clipboard', (_event, value) => {
    if (!localFeaturePreferences.clipboard) return { ok: false, error: 'Clipboard sharing is disabled on this device.' };
    if (typeof value !== 'string' || value.length > MAX_CLIPBOARD_CHARS) return { ok: false, error: 'Clipboard text is too large.' };
    clipboard.writeText(value);
    return { ok: true };
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

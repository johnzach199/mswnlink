'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, safeStorage, Notification, systemPreferences } = require('electron');
const fs = require('node:fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createInputBackend } = require('./input-backend');

// Optional fallback for Linux systems whose Mesa/GBM driver cannot be opened.
// This must run before app.whenReady(); keep acceleration enabled by default.
if (process.env.MSWNLINK_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-features', 'Vulkan');
  console.warn('[mswnlink] Hardware acceleration disabled by MSWNLINK_DISABLE_GPU=1.');
}

const PORT = 49382;
const MAX_SIGNAL_BYTES = 1024 * 1024;
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
let inputBackend = null;
const badAttempts = new Map();
const globalFailures = [];
let globalLockUntil = 0;
let settings = { autoAccept: 'off' }; // off | view | control
const AUTO_CONTROL_MIN_CODE = 12;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 640,
    backgroundColor: '#f4f5f7',
    title: 'mswnlink',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
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
  if (settings.autoAccept !== 'off' && code.length < AUTO_CONTROL_MIN_CODE) {
    throw new Error(`Connecting without approval needs an access code of at least ${AUTO_CONTROL_MIN_CODE} characters. Choose a longer code, or set “Who can connect” back to “Ask me each time”.`);
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

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsFilePath(), 'utf8'));
    if (parsed && ['off', 'view', 'control'].includes(parsed.autoAccept)) settings.autoAccept = parsed.autoAccept;
  } catch {
    // First run or unreadable file: keep the safe default (ask every time).
  }
}

async function persistSettings() {
  const filePath = settingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function inputAvailable() {
  return Boolean(inputBackend && inputBackend.describe().available);
}

function describeInput() {
  return inputBackend ? inputBackend.describe() : { available: false, ready: false, kind: 'none', state: 'failed', message: 'Input backend not loaded.' };
}

function recordFailedAttempt(now) {
  globalFailures.push(now);
  while (globalFailures.length && now - globalFailures[0] > 10 * 60_000) globalFailures.shift();
  // Many wrong codes from anywhere on the LAN: stop answering for a few minutes.
  if (globalFailures.length >= 12) globalLockUntil = now + 5 * 60_000;
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
  if (inputBackend) inputBackend.releaseAll();
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
      if (now < globalLockUntil) {
        sendSocket(socket, { type: 'rejected', reason: 'Too many wrong codes were tried. This PC is not accepting connections for a few minutes.' });
        socket.close(1008, 'Locked');
        return;
      }
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
        recordFailedAttempt(now);
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

      pendingSocket = socket;
      activePeer = { name: safeName(msg.name), ip: remoteIp };
      if (settings.autoAccept === 'view' || settings.autoAccept === 'control') {
        // The access code is the approval. The host window still shows who connected and can disconnect at any time.
        resolvePending(settings.autoAccept, true);
      } else {
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

function resolvePending(mode, auto = false) {
  if (!pendingSocket || pendingSocket.readyState !== WebSocket.OPEN) return { ok: false };
  if (!['view', 'control', 'reject'].includes(mode)) return { ok: false };
  const socket = pendingSocket;
  pendingSocket = null;
  if (mode === 'reject') {
    sendSocket(socket, { type: 'rejected', reason: 'The request was declined on the host.' });
    try { socket.close(); } catch {}
    activePeer = null;
    sendToUI('incoming-cancelled', {});
    return { ok: true };
  }
  activeSocket = socket;
  inputAllowed = mode === 'control' && inputAvailable();
  const grantedMode = inputAllowed ? 'control' : 'view';
  sendSocket(activeSocket, { type: 'accepted', mode: grantedMode, hostName: os.hostname() });
  sendToUI('peer-accepted', { peer: activePeer, mode: grantedMode, inputAvailable: inputAvailable(), auto });
  if (auto && Notification.isSupported()) {
    try {
      new Notification({
        title: 'mswnlink',
        body: `${activePeer.name} (${activePeer.ip}) connected with the access code · ${grantedMode === 'control' ? 'full control' : 'view only'}`
      }).show();
    } catch {}
  }
  return { ok: true, mode: grantedMode };
}

async function startHost() {
  if (wss) return { code: pairingCode, port: PORT, ips: getLanIPv4(), input: describeInput() };
  if (!persistentAccessCode) throw new Error('Set a permanent access code on the Share this PC screen before starting to share.');
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
  if (process.platform === 'darwin') {
    // Shows the system prompt once; macOS needs it before remote clicks and keys work.
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch {}
  }
  // On Wayland this opens the desktop's one-time "allow remote control" prompt, so don't block on it.
  if (inputBackend) inputBackend.start().catch((error) => console.warn('[mswnlink] Input backend failed to start:', error.message));
  return { code: pairingCode, port: PORT, ips: getLanIPv4(), input: describeInput() };
}

function stopHost() {
  if (pendingSocket) {
    try { sendSocket(pendingSocket, { type: 'rejected', reason: 'Sharing was stopped on the host.' }); pendingSocket.close(); } catch {}
  }
  pendingSocket = null;
  if (activeSocket) closePeer('The host stopped sharing.');
  inputAllowed = false;
  if (inputBackend) inputBackend.stop();
  const server = wss;
  wss = null;
  pairingCode = null;
  if (server) {
    try { server.close(); } catch {}
  }
  sendToUI('host-stopped', {});
  return { ok: true };
}

function inputReady() {
  return Boolean(inputBackend && inputBackend.ready);
}

function injectInput(event) {
  // Input only runs on a live session whose control permission is on, and the host can revoke it at any time.
  if (!inputReady() || !activeSocket || !inputAllowed || !event || typeof event !== 'object') return { ok: false, reason: 'Control is not enabled.' };
  try {
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      inputBackend.move(x, y);
    } else if (event.kind === 'mouse') {
      if (!inputBackend.mouse(Number(event.button), event.action)) return { ok: false };
    } else if (event.kind === 'wheel') {
      inputBackend.wheel(Math.max(-600, Math.min(600, Number(event.dx) || 0)), Math.max(-600, Math.min(600, Number(event.dy) || 0)));
    } else if (event.kind === 'key') {
      if (!inputBackend.key(event, event.action)) return { ok: false, reason: 'Unsupported key.' };
    } else if (event.kind === 'releaseAll') {
      clearNativeInput();
    }
    return { ok: true };
  } catch (error) {
    console.warn('[mswnlink] Could not inject input:', error.message);
    return { ok: false, reason: error.message };
  }
}

app.whenReady().then(async () => {
  persistentAccessCode = await loadSavedAccessCode();
  await loadSettings();
  inputBackend = createInputBackend({
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    devHelperDir: __dirname,
    onStatus: (status) => sendToUI('input-status', status)
  });
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

  ipcMain.handle('device-info', () => ({
    name: os.hostname(),
    platform: process.platform,
    waylandSession: process.platform === 'linux' && (
      String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
      Boolean(process.env.WAYLAND_DISPLAY)
    ),
    ips: getLanIPv4(),
    inputAvailable: inputAvailable(),
    input: describeInput(),
    macScreenAccess: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : null,
    macAccessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : null
  }));

  ipcMain.handle('get-settings', () => ({ autoAccept: settings.autoAccept, minCodeLength: AUTO_CONTROL_MIN_CODE, codeLength: persistentAccessCode ? persistentAccessCode.length : 0 }));

  ipcMain.handle('save-settings', async (_event, value) => {
    const next = value && typeof value === 'object' ? value.autoAccept : null;
    if (!['off', 'view', 'control'].includes(next)) return { ok: false, error: 'Unknown option.' };
    if (next !== 'off') {
      if (!persistentAccessCode) return { ok: false, error: 'Save an access code first.' };
      if (persistentAccessCode.length < AUTO_CONTROL_MIN_CODE) return { ok: false, error: `Connecting without approval needs an access code of at least ${AUTO_CONTROL_MIN_CODE} characters. Yours has ${persistentAccessCode.length}.` };
    }
    if (next === 'control' && !inputAvailable()) return { ok: false, error: describeInput().message || 'Remote control is not available on this PC.' };
    settings.autoAccept = next;
    try { await persistSettings(); } catch (error) { return { ok: false, error: `Could not save the setting: ${error.message}` }; }
    return { ok: true, autoAccept: settings.autoAccept };
  });

  ipcMain.handle('get-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 360, height: 220 },
        fetchWindowIcons: false
      });
      return sources.map((source, index) => ({
        id: source.id,
        name: source.name || `Display ${index + 1}`,
        thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : ''
      }));
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
  ipcMain.handle('host-resolve-join', (_event, mode) => resolvePending(mode, false));
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
  ipcMain.handle('set-input-allowed', (_event, allowed) => {
    const hasLivePeer = Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN);
    inputAllowed = Boolean(allowed && inputAvailable() && hasLivePeer);
    if (!inputAllowed) clearNativeInput();
    if (hasLivePeer) {
      sendSocket(activeSocket, { type: 'control-mode', allowed: inputAllowed });
      sendToUI('input-mode-changed', { allowed: inputAllowed, inputAvailable: inputAvailable() });
    }
    return { allowed: inputAllowed, inputAvailable: inputAvailable() };
  });
  ipcMain.handle('inject-input', (_event, event) => injectInput(event));

  createWindow();
});

app.on('before-quit', () => {
  stopHost();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

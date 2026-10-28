'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

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
let pairingCode = null;
let chosenSourceId = null;
let pendingSocket = null;
let activeSocket = null;
let activePeer = null;
let inputAllowed = false;
let robot = null;
const heldKeys = new Set();
const heldButtons = new Set();
const badAttempts = new Map();

try {
  // Native RobotJS binaries are rebuilt for Electron during npm install.
  robot = require('robotjs');
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
} catch (error) {
  console.warn('[mswnlink] Native input backend is unavailable:', error.message);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0b1020',
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

function newPairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
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
  if (!robot) return;
  for (const key of heldKeys) {
    try { robot.keyToggle(key, 'up'); } catch {}
  }
  heldKeys.clear();
  for (const button of heldButtons) {
    try { robot.mouseToggle('up', button); } catch {}
  }
  heldButtons.clear();
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
        sendSocket(socket, { type: 'rejected', reason: 'That pairing code is not correct.' });
        socket.close(1008, 'Incorrect pairing code');
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
      sendToUI('incoming-connection', { name: activePeer.name, ip: remoteIp });
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
  if (wss) return { code: pairingCode, port: PORT, ips: getLanIPv4() };
  pairingCode = newPairingCode();
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
  return { code: pairingCode, port: PORT, ips: getLanIPv4() };
}

function stopHost() {
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
  sendToUI('host-stopped', {});
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

function injectInput(event) {
  // Input only runs on a live, host-approved session and can be revoked by the host UI.
  if (!robot || !activeSocket || !inputAllowed || !event || typeof event !== 'object') return { ok: false, reason: 'Control is not enabled.' };
  try {
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      const size = robot.getScreenSize();
      robot.moveMouse(Math.round(x * Math.max(0, size.width - 1)), Math.round(y * Math.max(0, size.height - 1)));
    } else if (event.kind === 'mouse') {
      const button = ({ 0: 'left', 1: 'middle', 2: 'right' })[Number(event.button)];
      if (!button) return { ok: false };
      if (event.action === 'down') {
        robot.mouseToggle('down', button);
        heldButtons.add(button);
      } else if (event.action === 'up') {
        robot.mouseToggle('up', button);
        heldButtons.delete(button);
      }
    } else if (event.kind === 'wheel') {
      const dx = Math.max(-5, Math.min(5, Math.round(Number(event.dx) / 100)));
      const dy = Math.max(-5, Math.min(5, Math.round(Number(event.dy) / 100)));
      if (dx || dy) robot.scrollMouse(dx, dy);
    } else if (event.kind === 'key') {
      const key = mapKey(event);
      if (!key) return { ok: false, reason: 'Unsupported key.' };
      if (event.action === 'down') {
        robot.keyToggle(key, 'down');
        heldKeys.add(key);
      } else if (event.action === 'up') {
        robot.keyToggle(key, 'up');
        heldKeys.delete(key);
      }
    } else if (event.kind === 'releaseAll') {
      clearNativeInput();
    }
    return { ok: true };
  } catch (error) {
    console.warn('[mswnlink] Could not inject input:', error.message);
    return { ok: false, reason: error.message };
  }
}

app.whenReady().then(() => {
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

  ipcMain.handle('device-info', () => ({
    name: os.hostname(),
    platform: process.platform,
    waylandSession: process.platform === 'linux' && (
      String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
      Boolean(process.env.WAYLAND_DISPLAY)
    ),
    ips: getLanIPv4(),
    inputAvailable: Boolean(robot)
  }));

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

  ipcMain.handle('make-pair-proof', (_event, code, nonce) => {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/i.test(nonce)) throw new Error('Invalid pairing challenge.');
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
  ipcMain.handle('host-resolve-join', (_event, mode) => {
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
    inputAllowed = mode === 'control' && Boolean(robot);
    sendSocket(activeSocket, { type: 'accepted', mode: inputAllowed ? 'control' : 'view', hostName: os.hostname() });
    sendToUI('peer-accepted', { peer: activePeer, mode: inputAllowed ? 'control' : 'view', inputAvailable: Boolean(robot) });
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
  ipcMain.handle('set-input-allowed', (_event, allowed) => {
    const hasLivePeer = Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN);
    inputAllowed = Boolean(allowed && robot && hasLivePeer);
    if (!inputAllowed) clearNativeInput();
    if (hasLivePeer) {
      sendSocket(activeSocket, { type: 'control-mode', allowed: inputAllowed });
      sendToUI('input-mode-changed', { allowed: inputAllowed, inputAvailable: Boolean(robot) });
    }
    return { allowed: inputAllowed, inputAvailable: Boolean(robot) };
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

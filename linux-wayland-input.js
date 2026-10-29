'use strict';

/*
 * Fedora/GNOME Wayland input backend using XDG Desktop Portal.
 * RobotJS cannot inject global input into a native Wayland session.  This
 * backend requests keyboard/pointer access from the desktop portal instead.
 * The user must approve the OS portal prompt at least once.  If the desktop
 * grants persistence, the single-use restore token is returned to main.js and
 * stored using Electron safeStorage.
 */
const crypto = require('node:crypto');
const dbus = require('dbus-next');
const { Message } = dbus;

const BUS_NAME = 'org.freedesktop.portal.Desktop';
const ROOT = '/org/freedesktop/portal/desktop';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SESSION_IFACE = 'org.freedesktop.portal.Session';
const REMOTE_IFACE = 'org.freedesktop.portal.RemoteDesktop';
const SCREENCAST_IFACE = 'org.freedesktop.portal.ScreenCast';
const REQUEST_TIMEOUT_MS = 180000;

const EVDEV_KEYCODES = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21,
  KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26,
  BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35,
  KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40,
  Backquote: 41, ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45,
  KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65,
  F8: 66, F9: 67, F10: 68, NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
  NumpadDecimal: 83, F11: 87, F12: 88, NumpadEnter: 96,
  ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127
};

function unwrap(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  return value;
}
function unwrapDict(value) {
  const input = unwrap(value) || {};
  const output = {};
  for (const [key, item] of Object.entries(input)) output[key] = unwrap(item);
  return output;
}
function token(prefix) { return `${prefix}${crypto.randomBytes(8).toString('hex')}`; }
function requestPathFor(bus, requestToken) {
  if (!bus.name || !bus.name.startsWith(':')) throw new Error('The desktop session D-Bus is not ready.');
  const sender = bus.name.slice(1).replace(/\./g, '_');
  return `${ROOT}/request/${sender}/${requestToken}`;
}
function addMatch(bus, rule) {
  return bus.call(new Message({
    destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule]
  }));
}
function removeMatch(bus, rule) {
  return bus.call(new Message({
    destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus', member: 'RemoveMatch', signature: 's', body: [rule]
  })).catch(() => {});
}

async function portalRequest(bus, requestToken, invoke) {
  const requestPath = requestPathFor(bus, requestToken);
  const rule = `type='signal',sender='${BUS_NAME}',path='${requestPath}',interface='${REQUEST_IFACE}',member='Response'`;
  await addMatch(bus, rule);
  let timeout;
  let handler;
  const response = new Promise((resolve, reject) => {
    handler = (message) => {
      if (message.path !== requestPath || message.interface !== REQUEST_IFACE || message.member !== 'Response' || !Array.isArray(message.body)) return;
      const status = Number(message.body[0]);
      const results = unwrapDict(message.body[1]);
      if (status === 0) resolve(results);
      else if (status === 1) reject(new Error('The desktop permission dialog was cancelled.'));
      else reject(new Error('The desktop denied the requested remote-control permission.'));
    };
    bus.on('message', handler);
    timeout = setTimeout(() => reject(new Error('Timed out waiting for the Linux desktop permission dialog.')), REQUEST_TIMEOUT_MS);
  });
  try {
    const returnedPath = await invoke(new dbus.Variant('s', requestToken));
    if (returnedPath && returnedPath !== requestPath) {
      // The portal should use handle_token to produce the path we subscribed to.
      throw new Error('The desktop portal returned an unexpected request path. Please update xdg-desktop-portal and try again.');
    }
    return await response;
  } finally {
    clearTimeout(timeout);
    if (handler) bus.removeListener('message', handler);
    await removeMatch(bus, rule);
  }
}

class LinuxWaylandInput {
  constructor() {
    this.bus = null;
    this.remote = null;
    this.sessionHandle = null;
    this.streamId = null;
    this.streamWidth = 1920;
    this.streamHeight = 1080;
    this.restoreToken = '';
    this.heldKeys = new Set();
    this.heldButtons = new Set();
  }

  async start(previousRestoreToken = '') {
    if (this.sessionHandle && this.remote) return { restoreToken: this.restoreToken || previousRestoreToken || '' };
    this.bus = dbus.sessionBus();
    this.bus.on('error', error => console.warn('[mswnlink] Desktop portal D-Bus error:', error.message));
    await new Promise((resolve, reject) => {
      if (this.bus.name) return resolve();
      const onConnect = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => { this.bus.removeListener('connect', onConnect); this.bus.removeListener('error', onError); };
      this.bus.once('connect', onConnect);
      this.bus.once('error', onError);
    });

    try {
      const remoteObject = await this.bus.getProxyObject(BUS_NAME, ROOT);
      this.remote = remoteObject.getInterface(REMOTE_IFACE);
      const screenCast = remoteObject.getInterface(SCREENCAST_IFACE);

      const createToken = token('create');
      const sessionToken = token('session');
      const created = await portalRequest(this.bus, createToken, requestToken => this.remote.CreateSession({
        handle_token: requestToken,
        session_handle_token: new dbus.Variant('s', sessionToken)
      }));
      this.sessionHandle = String(created.session_handle || '');
      if (!this.sessionHandle.startsWith('/')) throw new Error('The desktop portal did not return a valid session handle.');

      const sourceToken = token('sources');
      await portalRequest(this.bus, sourceToken, requestToken => screenCast.SelectSources(this.sessionHandle, {
        handle_token: requestToken,
        types: new dbus.Variant('u', 1),
        multiple: new dbus.Variant('b', false),
        cursor_mode: new dbus.Variant('u', 1)
      }));

      const devicesToken = token('devices');
      await portalRequest(this.bus, devicesToken, requestToken => {
        const options = {
          handle_token: requestToken,
          types: new dbus.Variant('u', 3), // keyboard | pointer
          persist_mode: new dbus.Variant('u', 2) // persist until revoked, if supported
        };
        if (previousRestoreToken) options.restore_token = new dbus.Variant('s', previousRestoreToken);
        return this.remote.SelectDevices(this.sessionHandle, options);
      });

      const startToken = token('start');
      const started = await portalRequest(this.bus, startToken, requestToken => this.remote.Start(
        this.sessionHandle, '', { handle_token: requestToken }
      ));
      const granted = Number(started.devices || 0);
      const streams = Array.isArray(started.streams) ? started.streams : [];
      if (streams.length) {
        this.streamId = Number(streams[0][0]);
        const props = unwrapDict(streams[0][1]);
        // Absolute pointer notifications require logical_size, not physical
        // backing-buffer size. Prefer logical_size on scaled/high-DPI desktops.
        const size = props.logical_size || props.size;
        if (Array.isArray(size) && size.length >= 2) {
          this.streamWidth = Math.max(1, Number(size[0]) || this.streamWidth);
          this.streamHeight = Math.max(1, Number(size[1]) || this.streamHeight);
        }
        console.info(`[mswnlink] Wayland input session started (stream=${this.streamId}, logical=${this.streamWidth}x${this.streamHeight}, devices=${granted}).`);
      }
      if ((granted & 3) !== 3) throw new Error('Linux did not grant both pointer and keyboard control. Allow both devices in the desktop permission dialog.');
      this.restoreToken = typeof started.restore_token === 'string' ? started.restore_token : '';
      this.heldKeys.clear();
      this.heldButtons.clear();
      return { restoreToken: this.restoreToken };
    } catch (error) {
      await this.close();
      throw new Error(`Fedora/Wayland remote input could not be enabled: ${error.message}`);
    }
  }

  async inject(event) {
    if (!this.remote || !this.sessionHandle) throw new Error('The Wayland remote-control permission is not active.');
    const options = {};
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      if (this.streamId !== null && Number.isFinite(this.streamId)) {
        // Portal coordinates are logical desktop pixels and must not reach the
        // exclusive width/height boundary (e.g. 1920, not 1919, is outside).
        const px = Math.min(this.streamWidth - 1, x * this.streamWidth);
        const py = Math.min(this.streamHeight - 1, y * this.streamHeight);
        await this.remote.NotifyPointerMotionAbsolute(this.sessionHandle, options, this.streamId, px, py);
      } else {
        throw new Error('The portal did not provide screen coordinates; reopen the desktop permission dialog and select a monitor.');
      }
    } else if (event.kind === 'mouse') {
      // DOM button values: 0=left, 1=middle, 2=right. Portal expects evdev
      // codes: BTN_LEFT=0x110, BTN_RIGHT=0x111, BTN_MIDDLE=0x112.
      const buttons = { 0: 0x110, 1: 0x112, 2: 0x111 };
      const button = buttons[Number(event.button)];
      if (!button) return { ok: false };
      const state = event.action === 'down' ? 1 : 0;
      await this.remote.NotifyPointerButton(this.sessionHandle, options, button, state);
      if (state) this.heldButtons.add(button); else this.heldButtons.delete(button);
    } else if (event.kind === 'wheel') {
      const dx = Math.max(-600, Math.min(600, Number(event.dx) || 0));
      const dy = Math.max(-600, Math.min(600, Number(event.dy) || 0));
      await this.remote.NotifyPointerAxis(this.sessionHandle, { finish: new dbus.Variant('b', true) }, dx, dy);
    } else if (event.kind === 'key') {
      const code = String(event.code || '');
      const keycode = EVDEV_KEYCODES[code];
      if (!keycode) {
        console.warn(`[mswnlink] Wayland input ignored unsupported keyboard code: ${code || '(empty)'}`);
        return { ok: false, reason: `Unsupported keyboard key (${code || 'unknown'}).` };
      }
      const state = event.action === 'down' ? 1 : 0;
      await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, keycode, state);
      if (state) this.heldKeys.add(keycode); else this.heldKeys.delete(keycode);
    } else if (event.kind === 'releaseAll') {
      await this.releaseAll();
    }
    return { ok: true };
  }

  async releaseAll() {
    if (!this.remote || !this.sessionHandle) return;
    const keys = [...this.heldKeys];
    const buttons = [...this.heldButtons];
    this.heldKeys.clear();
    this.heldButtons.clear();
    await Promise.allSettled([
      ...keys.map(code => this.remote.NotifyKeyboardKeycode(this.sessionHandle, {}, code, 0)),
      ...buttons.map(code => this.remote.NotifyPointerButton(this.sessionHandle, {}, code, 0))
    ]);
  }

  async close() {
    await this.releaseAll().catch(() => {});
    const bus = this.bus;
    const handle = this.sessionHandle;
    this.remote = null;
    this.sessionHandle = null;
    this.streamId = null;
    this.bus = null;
    this.restoreToken = '';
    if (bus && handle) {
      try {
        const sessionObject = await bus.getProxyObject(BUS_NAME, handle);
        const session = sessionObject.getInterface(SESSION_IFACE);
        await session.Close();
      } catch (error) {
        console.warn('[mswnlink] Could not close Wayland portal session:', error.message);
      }
    }
    if (bus) { try { bus.disconnect(); } catch {} }
  }
}

module.exports = LinuxWaylandInput;
module.exports.isSupportedSession = () => {
  if (process.platform !== 'linux') return false;
  const sessionType = String(process.env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  // Trust the explicit desktop session type when present. Some X11 sessions
  // inherit WAYLAND_DISPLAY from nested launchers; that must not select a portal
  // backend instead of RobotJS/XTest.
  if (sessionType) return sessionType === 'wayland';
  return Boolean(process.env.WAYLAND_DISPLAY);
};

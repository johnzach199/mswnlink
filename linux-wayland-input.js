'use strict';

/*
 * Fedora/GNOME & KDE Wayland input backend using XDG Desktop Portal.
 * RobotJS cannot inject global input into a native Wayland session. This
 * backend requests keyboard + pointer access from org.freedesktop.portal.RemoteDesktop,
 * keeps the negotiated PipeWire ScreenCast stream alive so GNOME Mutter enables
 * NotifyPointerMotionAbsolute immediately, falls back seamlessly to relative
 * NotifyPointerMotion if a compositor omits stream coordinates or rejects an
 * unscaled/HiDPI coordinate, and injects Unicode/Greek/quote characters via
 * NotifyKeyboardKeysym so layout differences never drop "'" or "έχω".
 */
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  shortcutDescriptorForPlatform,
  unicodeToXkbKeysym,
  isLinuxWaylandEnv
} = require('./lib/input-protocol');

function loadDbus(override) {
  if (override) return override;
  return require('dbus-next');
}

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

function token(prefix) {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function requestPathFor(bus, requestToken) {
  if (!bus.name || !bus.name.startsWith(':')) throw new Error('The desktop session D-Bus is not ready.');
  const sender = bus.name.slice(1).replace(/\./g, '_');
  return `${ROOT}/request/${sender}/${requestToken}`;
}

function addMatch(bus, rule, dbusMod) {
  const { Message } = loadDbus(dbusMod);
  return bus.call(new Message({
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'AddMatch',
    signature: 's',
    body: [rule]
  }));
}

function removeMatch(bus, rule, dbusMod) {
  const { Message } = loadDbus(dbusMod);
  return bus.call(new Message({
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'RemoveMatch',
    signature: 's',
    body: [rule]
  })).catch(() => {});
}

async function portalRequest(bus, requestToken, invoke, dbusMod) {
  const dbusLib = loadDbus(dbusMod);
  const expectedPath = requestPathFor(bus, requestToken);
  // Do NOT filter by sender='org.freedesktop.portal.Desktop': when xdg-desktop-portal
  // is D-Bus-activated on Fedora, the signal sender is its unique ':1.xx' bus name
  // and strict sender matching can miss the Response signal on dbus-broker.
  const rule = `type='signal',interface='${REQUEST_IFACE}',member='Response'`;
  await addMatch(bus, rule, dbusLib);

  let activePath = expectedPath;
  let timeout = null;
  let handler = null;
  let settled = false;
  const bufferedSignals = [];

  const parseResponseMessage = (message) => {
    if (!message || message.interface !== REQUEST_IFACE || message.member !== 'Response' || !Array.isArray(message.body)) {
      return null;
    }
    if (message.path !== expectedPath && message.path !== activePath) return null;
    return {
      status: Number(message.body[0]),
      results: unwrapDict(message.body[1])
    };
  };

  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const finishWithParsed = (parsed) => {
    if (settled || !parsed) return;
    settled = true;
    if (parsed.status === 0) resolveResponse(parsed.results);
    else if (parsed.status === 1) rejectResponse(new Error('The desktop permission dialog was cancelled.'));
    else rejectResponse(new Error('The desktop denied the requested remote-control permission.'));
  };

  handler = (message) => {
    const parsed = parseResponseMessage(message);
    if (parsed) {
      finishWithParsed(parsed);
    } else if (message && message.interface === REQUEST_IFACE && message.member === 'Response') {
      bufferedSignals.push(message);
    }
  };

  bus.on('message', handler);
  timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResponse(new Error('Timed out waiting for the Linux desktop permission dialog.'));
    }
  }, REQUEST_TIMEOUT_MS);

  try {
    const returnedPath = unwrap(await invoke(new dbusLib.Variant('s', requestToken)));
    if (typeof returnedPath === 'string' && returnedPath.startsWith('/') && returnedPath !== expectedPath) {
      activePath = returnedPath;
      for (const queued of bufferedSignals) {
        const parsed = parseResponseMessage(queued);
        if (parsed) {
          finishWithParsed(parsed);
          break;
        }
      }
    }
    return await responsePromise;
  } finally {
    clearTimeout(timeout);
    if (handler) bus.removeListener('message', handler);
    await removeMatch(bus, rule, dbusLib);
  }
}

class LinuxWaylandInput {
  constructor(options = {}) {
    this.screen = options.screen || null;
    this.dbusModule = options.dbusModule || null;
    this.bus = null;
    this.remote = null;
    this.sessionHandle = null;
    this.sessionClosedRule = '';
    this.sessionClosedHandler = null;
    this.pipewireKeepalive = null;
    this.streamId = null;
    this.streamWidth = 1920;
    this.streamHeight = 1080;
    this.useRelativeFallback = false;
    this.relativeAnchored = false;
    this.cursorX = 0;
    this.cursorY = 0;
    this.restoreToken = '';
    this.startPromise = null;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.wheelX = 0;
    this.wheelY = 0;
  }

  isActive() {
    return Boolean(this.remote && this.sessionHandle && this.bus);
  }

  resolveLogicalDesktopSize(portalProps = {}) {
    let fallbackW = 1920;
    let fallbackH = 1080;
    let scaleFactor = 1;
    if (this.screen && typeof this.screen.getPrimaryDisplay === 'function') {
      try {
        const primary = this.screen.getPrimaryDisplay();
        if (primary && primary.bounds && primary.bounds.width > 0 && primary.bounds.height > 0) {
          fallbackW = Math.round(primary.bounds.width);
          fallbackH = Math.round(primary.bounds.height);
        }
        if (primary && Number(primary.scaleFactor) > 0) {
          scaleFactor = Number(primary.scaleFactor);
        }
      } catch {}
    }

    const logicalSize = portalProps.logical_size;
    if (Array.isArray(logicalSize) && logicalSize.length >= 2 && Number(logicalSize[0]) > 0 && Number(logicalSize[1]) > 0) {
      return {
        width: Math.max(1, Math.round(Number(logicalSize[0]))),
        height: Math.max(1, Math.round(Number(logicalSize[1])))
      };
    }

    const rawSize = portalProps.size;
    if (Array.isArray(rawSize) && rawSize.length >= 2 && Number(rawSize[0]) > 0 && Number(rawSize[1]) > 0) {
      const rw = Number(rawSize[0]);
      const rh = Number(rawSize[1]);
      // On HiDPI Fedora GNOME Wayland, portal `size` is physical buffer pixels while
      // NotifyPointerMotionAbsolute requires logical desktop coordinates. If Electron
      // reports a scaled primary display matching rw/scaleFactor, prefer logical bounds.
      if (scaleFactor > 1 && Math.abs(rw / scaleFactor - fallbackW) <= 4) {
        return { width: fallbackW, height: fallbackH };
      }
      return { width: Math.max(1, Math.round(rw)), height: Math.max(1, Math.round(rh)) };
    }

    return { width: fallbackW, height: fallbackH };
  }

  startPipewireKeepalive(streamId, screenCast) {
    this.stopPipewireKeepalive();
    if (this.dbusModule || streamId === null || !Number.isFinite(streamId)) return;
    // GNOME Mutter drops NotifyPointerMotionAbsolute ("Dropping early absolute pointer motion")
    // until a PipeWire consumer connects to the ScreenCast stream node on this portal session.
    // Spawn a lightweight background gstreamer fakesink consumer when available on Fedora.
    (async () => {
      let pwFd = null;
      try {
        if (screenCast && typeof screenCast.OpenPipeWireRemote === 'function') {
          pwFd = unwrap(await screenCast.OpenPipeWireRemote(this.sessionHandle, {}));
        }
      } catch {}
      if (!this.isActive() || this.streamId !== streamId) return;

      const gstArgs = ['pipewiresrc'];
      if (typeof pwFd === 'number' && Number.isInteger(pwFd) && pwFd >= 0) {
        // dbus-next marshals 'h' file descriptors as integer FDs when supported; if not,
        // pipewiresrc connects directly to the user PipeWire daemon with path=<nodeId>.
      }
      gstArgs.push(`path=${streamId}`, 'do-timestamp=true', '!', 'fakesink', 'sync=false');
      try {
        const child = spawn('gst-launch-1.0', ['-q', ...gstArgs], {
          stdio: 'ignore',
          env: process.env
        });
        if (typeof child.unref === 'function') child.unref();
        this.pipewireKeepalive = child;
        child.on('error', () => {
          if (this.pipewireKeepalive === child) this.pipewireKeepalive = null;
        });
        child.on('exit', () => {
          if (this.pipewireKeepalive === child) this.pipewireKeepalive = null;
        });
      } catch {}
    })().catch(() => {});
  }

  stopPipewireKeepalive() {
    const child = this.pipewireKeepalive;
    this.pipewireKeepalive = null;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  async start(previousRestoreToken = '') {
    if (this.isActive()) {
      return { restoreToken: this.restoreToken || previousRestoreToken || '' };
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      try {
        return await this._openPortalSession(previousRestoreToken);
      } catch (firstError) {
        // If a saved one-use restore token went stale, retry cleanly without it once.
        if (previousRestoreToken) {
          console.warn('[mswnlink] Saved Wayland restore token rejected; retrying with fresh portal prompt:', firstError.message);
          return await this._openPortalSession('');
        }
        throw firstError;
      }
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _openPortalSession(previousRestoreToken = '') {
    const dbus = loadDbus(this.dbusModule);
    await this.close();
    this.bus = dbus.sessionBus();
    this.bus.on('error', error => console.warn('[mswnlink] Desktop portal D-Bus error:', error.message));
    await new Promise((resolve, reject) => {
      if (this.bus.name) return resolve();
      const onConnect = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const cleanup = () => {
        if (!this.bus) return;
        this.bus.removeListener('connect', onConnect);
        this.bus.removeListener('error', onError);
      };
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
      }), dbus);
      this.sessionHandle = String(created.session_handle || '');
      if (!this.sessionHandle.startsWith('/')) {
        throw new Error('The desktop portal did not return a valid session handle.');
      }

      // Watch for compositor-initiated session revocation (e.g. user clicks "Stop Sharing" in GNOME top bar).
      this.sessionClosedRule = `type='signal',path='${this.sessionHandle}',interface='${SESSION_IFACE}',member='Closed'`;
      this.sessionClosedHandler = (message) => {
        if (message && message.path === this.sessionHandle && message.interface === SESSION_IFACE && message.member === 'Closed') {
          console.info('[mswnlink] Wayland RemoteDesktop portal session was closed by the desktop.');
          this.stopPipewireKeepalive();
          this.remote = null;
          this.sessionHandle = null;
          this.streamId = null;
        }
      };
      this.bus.on('message', this.sessionClosedHandler);
      await addMatch(this.bus, this.sessionClosedRule, dbus).catch(() => {});

      const devicesToken = token('devices');
      await portalRequest(this.bus, devicesToken, requestToken => {
        const options = {
          handle_token: requestToken,
          types: new dbus.Variant('u', 3), // keyboard (1) | pointer (2)
          persist_mode: new dbus.Variant('u', 2)
        };
        if (previousRestoreToken) options.restore_token = new dbus.Variant('s', previousRestoreToken);
        return this.remote.SelectDevices(this.sessionHandle, options);
      }, dbus);

      // Request monitor stream metadata so NotifyPointerMotionAbsolute has a valid stream node;
      // if a compositor declines ScreenCast pairing on a RemoteDesktop session, continue with
      // relative NotifyPointerMotion fallback instead of failing remote control!
      try {
        const sourceToken = token('sources');
        await portalRequest(this.bus, sourceToken, requestToken => screenCast.SelectSources(this.sessionHandle, {
          handle_token: requestToken,
          types: new dbus.Variant('u', 1),
          multiple: new dbus.Variant('b', false),
          cursor_mode: new dbus.Variant('u', 1)
        }), dbus);
      } catch (sourceErr) {
        console.warn('[mswnlink] Portal SelectSources unavailable on RemoteDesktop session; will use relative pointer fallback:', sourceErr.message);
      }

      const startToken = token('start');
      const started = await portalRequest(this.bus, startToken, requestToken => this.remote.Start(
        this.sessionHandle, '', { handle_token: requestToken }
      ), dbus);
      const granted = Number(started.devices || 0);
      if ((granted & 3) !== 3) {
        throw new Error('Linux did not grant both pointer and keyboard control. Turn on "Allow remote interaction" in the Fedora/GNOME permission dialog.');
      }

      const streams = Array.isArray(started.streams) ? started.streams : [];
      if (streams.length) {
        this.streamId = Number(streams[0][0]);
        const props = unwrapDict(streams[0][1]);
        const resolved = this.resolveLogicalDesktopSize(props);
        this.streamWidth = resolved.width;
        this.streamHeight = resolved.height;
        this.useRelativeFallback = false;
        this.startPipewireKeepalive(this.streamId, screenCast);
        console.info(`[mswnlink] Wayland input session started (stream=${this.streamId}, logical=${this.streamWidth}x${this.streamHeight}, devices=${granted}).`);
      } else {
        const resolved = this.resolveLogicalDesktopSize({});
        this.streamId = null;
        this.streamWidth = resolved.width;
        this.streamHeight = resolved.height;
        this.useRelativeFallback = true;
        this.relativeAnchored = false;
        console.info(`[mswnlink] Wayland input session started in relative pointer mode (logical=${this.streamWidth}x${this.streamHeight}, devices=${granted}).`);
      }

      this.restoreToken = typeof started.restore_token === 'string' ? started.restore_token : '';
      this.heldKeys.clear();
      this.heldButtons.clear();
      return { restoreToken: this.restoreToken };
    } catch (error) {
      await this.close();
      throw new Error(`Fedora/Wayland remote input could not be enabled: ${error.message}`);
    }
  }

  async movePointerRelative(targetX, targetY) {
    if (!this.relativeAnchored) {
      // Sweep cursor to top-left (0, 0) once so normalized coordinates align with the screen.
      await this.remote.NotifyPointerMotion(
        this.sessionHandle,
        {},
        -this.streamWidth * 1.5,
        -this.streamHeight * 1.5
      );
      this.cursorX = 0;
      this.cursorY = 0;
      this.relativeAnchored = true;
    }
    const dx = targetX - this.cursorX;
    const dy = targetY - this.cursorY;
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
      await this.remote.NotifyPointerMotion(this.sessionHandle, {}, dx, dy);
      this.cursorX = targetX;
      this.cursorY = targetY;
    }
  }

  async injectTextKeysyms(text) {
    const chars = Array.from(String(text || '').slice(0, 64));
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      const cp = ch.codePointAt(0);
      if (!cp || cp < 0x20 || cp === 0x7f) continue;
      const primarySym = unicodeToXkbKeysym(cp);
      const unicodeSym = (0x01000000 | cp) >>> 0;
      if (!primarySym) continue;
      try {
        await this.remote.NotifyKeyboardKeysym(this.sessionHandle, {}, primarySym, 1);
        await this.remote.NotifyKeyboardKeysym(this.sessionHandle, {}, primarySym, 0);
      } catch (err) {
        if (primarySym !== unicodeSym) {
          try {
            await this.remote.NotifyKeyboardKeysym(this.sessionHandle, {}, unicodeSym, 1);
            await this.remote.NotifyKeyboardKeysym(this.sessionHandle, {}, unicodeSym, 0);
            continue;
          } catch {}
        }
        return {
          ok: false,
          fallbackPaste: true,
          remainingText: chars.slice(i).join(''),
          reason: err && err.message ? err.message : 'NotifyKeyboardKeysym failed'
        };
      }
    }
    return { ok: true };
  }

  async inject(event) {
    if (!this.isActive()) throw new Error('The Wayland remote-control permission is not active.');
    const options = {};
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      const px = Math.min(this.streamWidth - 1, Math.max(0, x * this.streamWidth));
      const py = Math.min(this.streamHeight - 1, Math.max(0, y * this.streamHeight));

      if (!this.useRelativeFallback && this.streamId !== null && Number.isFinite(this.streamId)) {
        try {
          await this.remote.NotifyPointerMotionAbsolute(this.sessionHandle, options, this.streamId, px, py);
          this.cursorX = px;
          this.cursorY = py;
          return { ok: true };
        } catch (absErr) {
          // On HiDPI scaling mismatches or unattached streams, switch to relative pointer motion
          // rather than dropping mouse control or resetting held buttons.
          console.warn('[mswnlink] NotifyPointerMotionAbsolute rejected; switching to relative Wayland pointer motion:', absErr.message);
          const refreshed = this.resolveLogicalDesktopSize({});
          this.streamWidth = refreshed.width;
          this.streamHeight = refreshed.height;
          this.useRelativeFallback = true;
          this.relativeAnchored = false;
        }
      }
      await this.movePointerRelative(
        Math.min(this.streamWidth - 1, Math.max(0, x * this.streamWidth)),
        Math.min(this.streamHeight - 1, Math.max(0, y * this.streamHeight))
      );
      return { ok: true };
    }

    if (event.kind === 'mouse') {
      // DOM button values: 0=left, 1=middle, 2=right. Portal expects evdev
      // codes: BTN_LEFT=0x110, BTN_RIGHT=0x111, BTN_MIDDLE=0x112.
      const buttons = { 0: 0x110, 1: 0x112, 2: 0x111 };
      const button = buttons[Number(event.button)];
      if (!button) return { ok: false };
      const state = event.action === 'down' ? 1 : 0;
      await this.remote.NotifyPointerButton(this.sessionHandle, options, button, state);
      if (state) this.heldButtons.add(button); else this.heldButtons.delete(button);
      return { ok: true };
    }

    if (event.kind === 'wheel') {
      this.wheelX += Math.max(-600, Math.min(600, Number(event.dx) || 0)) / 100;
      this.wheelY += Math.max(-600, Math.min(600, Number(event.dy) || 0)) / 100;
      const stepsX = Math.max(-10, Math.min(10, Math.trunc(this.wheelX)));
      const stepsY = Math.max(-10, Math.min(10, Math.trunc(this.wheelY)));
      this.wheelX -= stepsX;
      this.wheelY -= stepsY;
      if (stepsY) await this.remote.NotifyPointerAxisDiscrete(this.sessionHandle, options, 0, stepsY);
      if (stepsX) await this.remote.NotifyPointerAxisDiscrete(this.sessionHandle, options, 1, stepsX);
      return { ok: true };
    }

    if (event.kind === 'text') {
      return this.injectTextKeysyms(event.text);
    }

    if (event.kind === 'key') {
      if (event.textInput === true && typeof event.key === 'string' && event.key.length >= 1) {
        if (event.action === 'down') {
          return this.injectTextKeysyms(event.key);
        }
        return { ok: true };
      }
      const code = String(event.code || '');
      const keycode = EVDEV_KEYCODES[code];
      if (!keycode) {
        if (event.action === 'down' && typeof event.key === 'string' && event.key.length >= 1 && !/^[A-Za-z]{2,}$/.test(event.key)) {
          return this.injectTextKeysyms(event.key);
        }
        console.warn(`[mswnlink] Wayland input ignored unsupported keyboard code: ${code || '(empty)'}`);
        return { ok: false, reason: `Unsupported keyboard key (${code || 'unknown'}).` };
      }
      const state = event.action === 'down' ? 1 : 0;
      await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, keycode, state);
      if (state) this.heldKeys.add(keycode); else this.heldKeys.delete(keycode);
      return { ok: true };
    }

    if (event.kind === 'shortcut') {
      const desc = shortcutDescriptorForPlatform(String(event.action || ''), 'linux');
      if (!desc || !desc.evdev) return { ok: false, reason: 'Unsupported shortcut.' };
      const ctrlHeld = this.heldKeys.has(EVDEV_KEYCODES.ControlLeft) || this.heldKeys.has(EVDEV_KEYCODES.ControlRight);
      const needShift = desc.modifiers.includes('shift');
      const shiftHeld = this.heldKeys.has(EVDEV_KEYCODES.ShiftLeft) || this.heldKeys.has(EVDEV_KEYCODES.ShiftRight);
      if (!ctrlHeld) await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, EVDEV_KEYCODES.ControlLeft, 1);
      if (needShift && !shiftHeld) await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, EVDEV_KEYCODES.ShiftLeft, 1);
      await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, desc.evdev, 1);
      await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, desc.evdev, 0);
      if (needShift && !shiftHeld) await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, EVDEV_KEYCODES.ShiftLeft, 0);
      if (!ctrlHeld) await this.remote.NotifyKeyboardKeycode(this.sessionHandle, options, EVDEV_KEYCODES.ControlLeft, 0);
      return { ok: true };
    }

    if (event.kind === 'releaseAll') {
      await this.releaseAll();
      return { ok: true };
    }

    return { ok: true };
  }

  async releaseAll() {
    if (!this.remote || !this.sessionHandle) return;
    const keys = [...this.heldKeys];
    const buttons = [...this.heldButtons];
    this.heldKeys.clear();
    this.heldButtons.clear();
    this.wheelX = 0;
    this.wheelY = 0;
    await Promise.allSettled([
      ...keys.map(code => this.remote.NotifyKeyboardKeycode(this.sessionHandle, {}, code, 0)),
      ...buttons.map(code => this.remote.NotifyPointerButton(this.sessionHandle, {}, code, 0))
    ]);
  }

  async close() {
    this.stopPipewireKeepalive();
    await this.releaseAll().catch(() => {});
    const bus = this.bus;
    const handle = this.sessionHandle;
    const closedRule = this.sessionClosedRule;
    const closedHandler = this.sessionClosedHandler;
    this.remote = null;
    this.sessionHandle = null;
    this.sessionClosedRule = '';
    this.sessionClosedHandler = null;
    this.streamId = null;
    this.useRelativeFallback = false;
    this.relativeAnchored = false;
    this.bus = null;
    this.restoreToken = '';
    if (bus && closedHandler) {
      bus.removeListener('message', closedHandler);
    }
    if (bus && closedRule) {
      await removeMatch(bus, closedRule, this.dbusModule);
    }
    if (bus && handle) {
      try {
        const sessionObject = await bus.getProxyObject(BUS_NAME, handle);
        const session = sessionObject.getInterface(SESSION_IFACE);
        await session.Close();
      } catch (error) {
        console.warn('[mswnlink] Could not close Wayland portal session:', error.message);
      }
    }
    if (bus) {
      try { bus.disconnect(); } catch {}
    }
  }
}

module.exports = LinuxWaylandInput;
module.exports.isSupportedSession = (env = process.env) => isLinuxWaylandEnv(env, process.platform);

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// KeyboardEvent.code -> Linux evdev keycode (linux/input-event-codes.h).
const EVDEV = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 86, F11: 87, F12: 88, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99,
  AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108,
  PageDown: 109, Insert: 110, Delete: 111, Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127
};
const EVDEV_BUTTONS = { 0: 0x110, 1: 0x112, 2: 0x111 }; // left, middle, right

function isWaylandSession() {
  return process.platform === 'linux' && (
    String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' ||
    Boolean(process.env.WAYLAND_DISPLAY)
  );
}

/* ------------------------------------------------------------------ RobotJS */

class RobotBackend {
  constructor(robot, note = '') {
    this.kind = 'robotjs';
    this.robot = robot;
    this.note = note;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.wheelX = 0;
    this.wheelY = 0;
  }

  async start() { return this.describe(); }
  stop() { this.releaseAll(); }

  describe() {
    return { available: true, ready: true, kind: this.kind, state: 'ready', message: this.note };
  }

  mapKey(event) {
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
    return /^[a-z0-9]$/.test(key) ? key : null;
  }

  move(x, y) {
    const size = this.robot.getScreenSize();
    this.robot.moveMouse(Math.round(x * Math.max(0, size.width - 1)), Math.round(y * Math.max(0, size.height - 1)));
  }

  mouse(button, action) {
    const name = ({ 0: 'left', 1: 'middle', 2: 'right' })[button];
    if (!name) return false;
    if (action === 'down') { this.robot.mouseToggle('down', name); this.heldButtons.add(name); }
    else if (action === 'up') { this.robot.mouseToggle('up', name); this.heldButtons.delete(name); }
    return true;
  }

  wheel(dx, dy) {
    this.wheelX += dx / 60;
    this.wheelY += dy / 60;
    const sx = Math.max(-10, Math.min(10, Math.trunc(this.wheelX)));
    const sy = Math.max(-10, Math.min(10, Math.trunc(this.wheelY)));
    this.wheelX -= sx;
    this.wheelY -= sy;
    if (sx || sy) this.robot.scrollMouse(sx, sy);
  }

  key(event, action) {
    const name = this.mapKey(event);
    if (!name) return false;
    if (action === 'down') { this.robot.keyToggle(name, 'down'); this.heldKeys.add(name); }
    else if (action === 'up') { this.robot.keyToggle(name, 'up'); this.heldKeys.delete(name); }
    return true;
  }

  releaseAll() {
    for (const key of this.heldKeys) { try { this.robot.keyToggle(key, 'up'); } catch {} }
    this.heldKeys.clear();
    for (const button of this.heldButtons) { try { this.robot.mouseToggle('up', button); } catch {} }
    this.heldButtons.clear();
    this.wheelX = 0;
    this.wheelY = 0;
  }
}

/* ---------------------------------------------------------- Wayland portal */

class PortalBackend {
  constructor({ helperPath, tokenPath, onStatus }) {
    this.kind = 'wayland-portal';
    this.helperPath = helperPath;
    this.tokenPath = tokenPath;
    this.onStatus = onStatus || (() => {});
    this.proc = null;
    this.state = 'idle'; // idle | starting | ready | failed
    this.message = 'Remote control on Wayland needs a one-time approval when sharing starts.';
    this.startPromise = null;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.wheelX = 0;
    this.wheelY = 0;
  }

  get ready() { return this.state === 'ready'; }

  describe() {
    return {
      available: this.state !== 'failed',
      ready: this.state === 'ready',
      kind: this.kind,
      state: this.state,
      message: this.message
    };
  }

  setState(state, message) {
    this.state = state;
    if (message) this.message = message;
    this.onStatus(this.describe());
  }

  start() {
    if (this.state === 'ready' && this.proc) return Promise.resolve(this.describe());
    if (this.startPromise) return this.startPromise;
    this.setState('starting', 'Approve the “remote control” prompt from your desktop to allow mouse and keyboard input.');
    this.startPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (state, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startPromise = null;
        this.setState(state, message);
        resolve(this.describe());
      };
      const timer = setTimeout(() => {
        this.stopProcess();
        finish('failed', 'Remote control was not approved in time. Stop and start sharing again to retry; the session is view-only for now.');
      }, 120000);

      let proc;
      try {
        proc = spawn('python3', [this.helperPath, this.tokenPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        finish('failed', `Could not start the Wayland input helper: ${error.message}`);
        return;
      }
      this.proc = proc;
      let buffer = '';
      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.event === 'ready') finish('ready', 'Mouse and keyboard control is ready.');
          else if (message.event === 'error') {
            finish('failed', message.message || 'The desktop portal refused remote control.');
          } else if (message.event === 'closed') {
            this.proc = null;
            this.setState('failed', 'The desktop ended the remote-control session. Stop and start sharing again.');
          }
        }
      });
      proc.stderr.on('data', (chunk) => console.warn('[mswnlink wayland-input]', chunk.toString('utf8').trim()));
      proc.on('error', (error) => {
        this.proc = null;
        finish('failed', error.code === 'ENOENT'
          ? 'python3 was not found. On Fedora run: sudo dnf install python3 python3-gobject'
          : `Wayland input helper failed: ${error.message}`);
      });
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
        if (!settled) finish('failed', 'The Wayland input helper exited early. Make sure python3-gobject is installed and xdg-desktop-portal is running.');
        else if (this.state === 'ready') this.setState('failed', 'The Wayland input helper stopped. Stop and start sharing again.');
      });
    });
    return this.startPromise;
  }

  stopProcess() {
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.stdin.end(); } catch {} try { proc.kill(); } catch {} }
  }

  stop() {
    this.releaseAll();
    this.stopProcess();
    this.state = 'idle';
    this.message = 'Remote control on Wayland needs a one-time approval when sharing starts.';
    this.onStatus(this.describe());
  }

  send(object) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(`${JSON.stringify(object)}\n`);
    return true;
  }

  move(x, y) { this.send({ op: 'move', x, y }); }

  mouse(button, action) {
    const code = EVDEV_BUTTONS[button];
    if (!code) return false;
    const down = action === 'down';
    if (action !== 'down' && action !== 'up') return false;
    this.send({ op: 'button', code, down });
    if (down) this.heldButtons.add(code); else this.heldButtons.delete(code);
    return true;
  }

  wheel(dx, dy) {
    this.wheelX += dx / 100;
    this.wheelY += dy / 100;
    const sx = Math.max(-10, Math.min(10, Math.trunc(this.wheelX)));
    const sy = Math.max(-10, Math.min(10, Math.trunc(this.wheelY)));
    this.wheelX -= sx;
    this.wheelY -= sy;
    if (sy) this.send({ op: 'axis', axis: 0, steps: sy });
    if (sx) this.send({ op: 'axis', axis: 1, steps: sx });
  }

  key(event, action) {
    const code = EVDEV[String(event.code || '')];
    if (!code || (action !== 'down' && action !== 'up')) return false;
    this.send({ op: 'key', code, down: action === 'down' });
    if (action === 'down') this.heldKeys.add(code); else this.heldKeys.delete(code);
    return true;
  }

  releaseAll() {
    for (const code of this.heldKeys) this.send({ op: 'key', code, down: false });
    for (const code of this.heldButtons) this.send({ op: 'button', code, down: false });
    this.heldKeys.clear();
    this.heldButtons.clear();
    this.wheelX = 0;
    this.wheelY = 0;
  }
}

/* ------------------------------------------------------------- Unavailable */

class NoBackend {
  constructor(message) { this.kind = 'none'; this.message = message; }
  get ready() { return false; }
  async start() { return this.describe(); }
  stop() {}
  describe() { return { available: false, ready: false, kind: this.kind, state: 'failed', message: this.message }; }
  releaseAll() {}
}

/* ----------------------------------------------------------------- Factory */

function hasPythonGObject() {
  try {
    const result = spawnSync('python3', ['-c', 'import gi; gi.require_version("Gio","2.0"); from gi.repository import Gio'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function loadRobot() {
  try {
    const robot = require('robotjs');
    robot.setMouseDelay(0);
    robot.setKeyboardDelay(0);
    return { robot, error: '' };
  } catch (error) {
    return { robot: null, error: error.message };
  }
}

function createInputBackend({ resourcesPath, userDataPath, devHelperDir, onStatus }) {
  const helperCandidates = [
    resourcesPath && path.join(resourcesPath, 'wayland-input.py'),
    devHelperDir && path.join(devHelperDir, 'native', 'wayland-input.py')
  ].filter(Boolean);
  const helperPath = helperCandidates.find((candidate) => fs.existsSync(candidate));

  if (isWaylandSession()) {
    if (helperPath && hasPythonGObject()) {
      return new PortalBackend({ helperPath, tokenPath: path.join(userDataPath, 'wayland-restore-token'), onStatus });
    }
    const { robot } = loadRobot();
    if (robot) {
      return new RobotBackend(robot, 'Wayland session without python3-gobject: control only reaches X11 apps. Run: sudo dnf install python3-gobject');
    }
    return new NoBackend('Remote control on Wayland needs python3-gobject. On Fedora run: sudo dnf install python3-gobject');
  }

  const { robot, error } = loadRobot();
  if (robot) return new RobotBackend(robot);
  return new NoBackend(`The native input module could not be loaded${error ? ` (${error})` : ''}. The session stays view-only.`);
}

module.exports = { createInputBackend, isWaylandSession };

'use strict';

/**
 * Pure cross-platform input, shortcut, coordinate, and permission helpers
 * shared by main.js, win32-input.js, and unit tests.
 */

const ROBOT_NAMED_KEYS = {
  Enter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  Tab: 'tab',
  Space: 'space',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  ControlLeft: 'left_control',
  ControlRight: 'right_control',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  MetaLeft: 'command',
  MetaRight: 'command',
  CapsLock: 'capslock',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'numpad_+',
  NumpadSubtract: 'numpad_-',
  NumpadMultiply: 'numpad_*',
  NumpadDivide: 'numpad_/',
  NumpadDecimal: 'numpad_.',
  NumpadEnter: 'enter',
  PrintScreen: 'printscreen',
  ContextMenu: 'menu'
};

// Keys in ROBOT_NAMED_KEYS that RobotJS explicitly marks K_NOT_A_KEY on specific platforms.
const ROBOT_UNSUPPORTED_ON_MAC = new Set(['insert', 'printscreen', 'menu']);
const ROBOT_UNSUPPORTED_ON_X11 = new Set([
  'menu',
  'numpad_0', 'numpad_1', 'numpad_2', 'numpad_3', 'numpad_4',
  'numpad_5', 'numpad_6', 'numpad_7', 'numpad_8', 'numpad_9',
  'numpad_+', 'numpad_-', 'numpad_*', 'numpad_/', 'numpad_.'
]);

const MODIFIER_FLAG_BY_ROBOT_KEY = {
  shift: 'shift',
  right_shift: 'shift',
  control: 'control',
  left_control: 'control',
  right_control: 'control',
  alt: 'alt',
  right_alt: 'alt',
  command: 'command'
};

// Win32 Virtual-Key codes (layout-independent physical keys).
const WIN32_VK_BY_CODE = {
  Backspace: { vk: 0x08, extended: false },
  Tab: { vk: 0x09, extended: false },
  Enter: { vk: 0x0D, extended: false },
  NumpadEnter: { vk: 0x0D, extended: true },
  ShiftLeft: { vk: 0xA0, extended: false },
  ShiftRight: { vk: 0xA1, extended: true },
  ControlLeft: { vk: 0xA2, extended: false },
  ControlRight: { vk: 0xA3, extended: true },
  AltLeft: { vk: 0xA4, extended: false },
  AltRight: { vk: 0xA5, extended: true },
  Pause: { vk: 0x13, extended: true },
  CapsLock: { vk: 0x14, extended: false },
  Escape: { vk: 0x1B, extended: false },
  Space: { vk: 0x20, extended: false },
  PageUp: { vk: 0x21, extended: true },
  PageDown: { vk: 0x22, extended: true },
  End: { vk: 0x23, extended: true },
  Home: { vk: 0x24, extended: true },
  ArrowLeft: { vk: 0x25, extended: true },
  ArrowUp: { vk: 0x26, extended: true },
  ArrowRight: { vk: 0x27, extended: true },
  ArrowDown: { vk: 0x28, extended: true },
  PrintScreen: { vk: 0x2C, extended: true },
  Insert: { vk: 0x2D, extended: true },
  Delete: { vk: 0x2E, extended: true },
  MetaLeft: { vk: 0x5B, extended: true },
  MetaRight: { vk: 0x5C, extended: true },
  ContextMenu: { vk: 0x5D, extended: true },
  NumLock: { vk: 0x90, extended: true },
  ScrollLock: { vk: 0x91, extended: false },
  NumpadMultiply: { vk: 0x6A, extended: false },
  NumpadAdd: { vk: 0x6B, extended: false },
  NumpadSubtract: { vk: 0x6D, extended: false },
  NumpadDecimal: { vk: 0x6E, extended: false },
  NumpadDivide: { vk: 0x6F, extended: true },
  Semicolon: { vk: 0xBA, extended: false },
  Equal: { vk: 0xBB, extended: false },
  Comma: { vk: 0xBC, extended: false },
  Minus: { vk: 0xBD, extended: false },
  Period: { vk: 0xBE, extended: false },
  Slash: { vk: 0xBF, extended: false },
  Backquote: { vk: 0xC0, extended: false },
  BracketLeft: { vk: 0xDB, extended: false },
  Backslash: { vk: 0xDC, extended: false },
  BracketRight: { vk: 0xDD, extended: false },
  Quote: { vk: 0xDE, extended: false },
  IntlBackslash: { vk: 0xE2, extended: false }
};

const VALID_SHORTCUT_ACTIONS = new Set(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo']);

function mapRobotKey(event, hostPlatform = process.platform) {
  if (!event || typeof event !== 'object') return null;
  const code = String(event.code || '');
  let mapped = null;
  if (ROBOT_NAMED_KEYS[code]) {
    mapped = ROBOT_NAMED_KEYS[code];
  } else if (/^Key[A-Z]$/.test(code)) {
    mapped = code.slice(3).toLowerCase();
  } else if (/^Digit[0-9]$/.test(code)) {
    mapped = code.slice(5);
  } else if (/^Numpad[0-9]$/.test(code)) {
    mapped = hostPlatform === 'linux' ? code.slice(6) : `numpad_${code.slice(6)}`;
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    const fnNum = Number(code.slice(1));
    if (hostPlatform === 'darwin' && fnNum > 20) return null;
    mapped = code.toLowerCase();
  } else {
    const key = String(event.key || '').toLowerCase();
    if (/^[a-z0-9]$/.test(key)) mapped = key;
  }

  if (!mapped) return null;
  if (hostPlatform === 'darwin' && ROBOT_UNSUPPORTED_ON_MAC.has(mapped)) return null;
  if (hostPlatform === 'linux' && ROBOT_UNSUPPORTED_ON_X11.has(mapped)) return null;
  return mapped;
}

function modifierFlagForRobotKey(robotKey) {
  return MODIFIER_FLAG_BY_ROBOT_KEY[String(robotKey || '')] || null;
}

function buildRobotModifiers(heldKeysIterable, event = null) {
  const flags = new Set();
  if (heldKeysIterable) {
    for (const key of heldKeysIterable) {
      const mod = modifierFlagForRobotKey(key);
      if (mod) flags.add(mod);
    }
  }
  if (event && typeof event === 'object') {
    if (event.shiftKey) flags.add('shift');
    if (event.ctrlKey) flags.add('control');
    if (event.altKey) flags.add('alt');
    if (event.metaKey) flags.add('command');
  }
  return [...flags];
}

function mapWin32VirtualKey(event) {
  if (!event || typeof event !== 'object') return null;
  const code = String(event.code || '');
  if (WIN32_VK_BY_CODE[code]) return WIN32_VK_BY_CODE[code];
  if (/^Key[A-Z]$/.test(code)) {
    return { vk: code.charCodeAt(3), extended: false };
  }
  if (/^Digit[0-9]$/.test(code)) {
    return { vk: 0x30 + Number(code.slice(5)), extended: false };
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return { vk: 0x60 + Number(code.slice(6)), extended: false };
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return { vk: 0x70 + (Number(code.slice(1)) - 1), extended: false };
  }
  const key = String(event.key || '');
  if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
    return { vk: key.toUpperCase().charCodeAt(0), extended: false };
  }
  if (key.length === 1 && /^[0-9]$/.test(key)) {
    return { vk: 0x30 + Number(key), extended: false };
  }
  return null;
}

/**
 * Detects standard clipboard/editing shortcuts initiated by the viewer so they
 * can be synchronized with the clipboard and mapped to the host OS's primary
 * shortcut modifier (Cmd on macOS, Ctrl on Windows/Linux).
 */
function detectRemoteShortcut(event, viewerPlatform = 'unknown') {
  if (!event || typeof event !== 'object') return null;
  if (event.altKey) return null;

  const isMacViewer = viewerPlatform === 'darwin';
  const primaryPressed = isMacViewer
    ? Boolean(event.metaKey && !event.ctrlKey)
    : Boolean(event.ctrlKey && !event.metaKey);

  if (!primaryPressed) return null;

  const code = String(event.code || '');
  const keyLower = String(event.key || '').toLowerCase();
  const letter = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : keyLower;
  const shift = Boolean(event.shiftKey);

  if (letter === 'c' && !shift) return 'copy';
  if (letter === 'x' && !shift) return 'cut';
  if (letter === 'v' && !shift) return 'paste';
  if (letter === 'a' && !shift) return 'selectAll';
  if (letter === 'z') return shift ? 'redo' : 'undo';
  if (letter === 'y' && !shift && !isMacViewer) return 'redo';
  return null;
}

function shortcutDescriptorForPlatform(action, hostPlatform = process.platform) {
  if (!VALID_SHORTCUT_ACTIONS.has(action)) return null;
  const primaryMod = hostPlatform === 'darwin' ? 'command' : 'control';
  switch (action) {
    case 'copy':
      return { key: 'c', code: 'KeyC', vk: 0x43, evdev: 46, modifiers: [primaryMod] };
    case 'cut':
      return { key: 'x', code: 'KeyX', vk: 0x58, evdev: 45, modifiers: [primaryMod] };
    case 'paste':
      return { key: 'v', code: 'KeyV', vk: 0x56, evdev: 47, modifiers: [primaryMod] };
    case 'selectAll':
      return { key: 'a', code: 'KeyA', vk: 0x41, evdev: 30, modifiers: [primaryMod] };
    case 'undo':
      return { key: 'z', code: 'KeyZ', vk: 0x5A, evdev: 44, modifiers: [primaryMod] };
    case 'redo':
      return hostPlatform === 'darwin'
        ? { key: 'z', code: 'KeyZ', vk: 0x5A, evdev: 44, modifiers: ['command', 'shift'] }
        : { key: 'y', code: 'KeyY', vk: 0x59, evdev: 21, modifiers: ['control'] };
    default:
      return null;
  }
}

/**
 * Letterbox-aware normalized pointer coordinates.
 * When `clampToBounds` is true (e.g. while dragging a window with a mouse button
 * pressed), coordinates outside the active video rect clamp to [0, 1] instead of
 * returning null so drags across window borders never stall or drop mouseup.
 */
function normalizePointerCoordinates(clientX, clientY, rect, videoWidth, videoHeight, clampToBounds = false) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const sourceWidth = videoWidth > 0 ? videoWidth : rect.width;
  const sourceHeight = videoHeight > 0 ? videoHeight : rect.height;
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const displayedWidth = sourceWidth * scale;
  const displayedHeight = sourceHeight * scale;
  if (!(displayedWidth > 0) || !(displayedHeight > 0)) return null;

  const left = rect.left + (rect.width - displayedWidth) / 2;
  const top = rect.top + (rect.height - displayedHeight) / 2;
  const rawX = (clientX - left) / displayedWidth;
  const rawY = (clientY - top) / displayedHeight;

  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
  if (!clampToBounds && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1)) return null;

  return {
    x: Math.max(0, Math.min(1, rawX)),
    y: Math.max(0, Math.min(1, rawY))
  };
}

function parseDarwinMajor(osRelease = '') {
  const first = Number(String(osRelease || '').split('.')[0]);
  return Number.isFinite(first) && first > 0 ? first : 0;
}

function evaluateMacScreenPermission(status, platform = process.platform, osRelease = '') {
  if (platform !== 'darwin') {
    return {
      isMac: false,
      status: 'granted',
      granted: true,
      useSystemPickerFallback: false,
      needsAttention: false,
      canResetStaleTcc: false,
      summary: ''
    };
  }
  const normalized = typeof status === 'string' && status ? status : 'not-determined';
  const darwinMajor = parseDarwinMajor(osRelease);
  const granted = normalized === 'granted';
  // Darwin 24+ corresponds to macOS 15 Sequoia and newer, where Electron's
  // ScreenCaptureKit system picker can capture even before TCC restart.
  const useSystemPickerFallback = !granted && darwinMajor >= 24;
  let summary = '';
  if (normalized === 'denied' || normalized === 'restricted') {
    summary = 'macOS Screen Recording permission is currently off (or stuck from an earlier build). Allow mswnlink in System Settings › Privacy & Security › Screen & System Audio Recording, or reset the permission below if the switch is already on.';
  } else if (normalized === 'not-determined') {
    summary = 'macOS needs one-time Screen Recording approval before sharing this Mac. Click “Allow Screen Recording” below or press Start sharing to open the macOS prompt.';
  }
  return {
    isMac: true,
    status: normalized,
    darwinMajor,
    granted,
    useSystemPickerFallback,
    needsAttention: !granted,
    canResetStaleTcc: !granted,
    summary
  };
}

module.exports = {
  VALID_SHORTCUT_ACTIONS,
  mapRobotKey,
  modifierFlagForRobotKey,
  buildRobotModifiers,
  mapWin32VirtualKey,
  detectRemoteShortcut,
  shortcutDescriptorForPlatform,
  normalizePointerCoordinates,
  parseDarwinMajor,
  evaluateMacScreenPermission
};

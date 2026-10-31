'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inputProtocol = require('../lib/input-protocol');
const win32Backend = require('../win32-input');
const verifyWin32Worker = require('../scripts/verify-win32-worker.cjs');

test('cross-OS copy/paste shortcut detection and host translation', () => {
  assert.equal(
    inputProtocol.detectRemoteShortcut(
      { code: 'KeyV', key: 'v', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      'darwin'
    ),
    'paste'
  );

  // Non-Latin keyboard layout on macOS still detects physical KeyC
  assert.equal(
    inputProtocol.detectRemoteShortcut(
      { code: 'KeyC', key: 'ψ', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
      'darwin'
    ),
    'copy'
  );

  assert.deepEqual(inputProtocol.shortcutDescriptorForPlatform('paste', 'win32'), {
    key: 'v',
    code: 'KeyV',
    vk: 0x56,
    evdev: 47,
    modifiers: ['control']
  });

  assert.deepEqual(inputProtocol.shortcutDescriptorForPlatform('paste', 'darwin'), {
    key: 'v',
    code: 'KeyV',
    vk: 0x56,
    evdev: 47,
    modifiers: ['command']
  });
});

test('RobotJS modifier preservation, Spacebar VK mapping, and non-Latin / ScrollLock safety', () => {
  assert.equal(inputProtocol.mapRobotKey({ code: 'KeyV', key: 'ω' }, 'darwin'), 'v');
  assert.equal(inputProtocol.mapRobotKey({ code: 'ScrollLock', key: 'ScrollLock' }, 'win32'), null);
  assert.deepEqual(inputProtocol.mapWin32VirtualKey({ code: 'ScrollLock', key: 'ScrollLock' }), {
    vk: 0x91,
    extended: false
  });
  assert.deepEqual(inputProtocol.mapWin32VirtualKey({ code: 'Space', key: ' ' }), {
    vk: 0x20,
    extended: false
  });

  const mods = inputProtocol.buildRobotModifiers(new Set(['command', 'shift']), {
    metaKey: true,
    shiftKey: true
  });
  assert.deepEqual(mods.sort(), ['command', 'shift']);
});

test('Windows high-DPI resolveScreenPoint prefers dipToScreenRect across mixed-scale monitors', () => {
  const backend = new win32Backend({
    userDataPath: '/tmp/mswnlink-test',
    screen: {
      getAllDisplays: () => [{ id: 10, scaleFactor: 1.5, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
      dipToScreenRect: (_win, b) => ({ x: b.x, y: b.y, width: Math.round(b.width * 1.5), height: Math.round(b.height * 1.5) })
    }
  });
  assert.deepEqual(backend.resolveScreenPoint(1, 1, '10'), { x: 1920 + 2880 - 1, y: 1620 - 1 });
  assert.deepEqual(backend.resolveScreenPoint(0, 0, '10'), { x: 1920, y: 0 });
});

test('pointer coordinate clamping during active remote window drags', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  assert.equal(inputProtocol.normalizePointerCoordinates(500, 80, rect, 1920, 1080, false), null);
  assert.deepEqual(inputProtocol.normalizePointerCoordinates(950, 80, rect, 1920, 1080, true), {
    x: 1,
    y: 0
  });
});

test('macOS Sequoia ScreenCaptureKit permission evaluation', () => {
  const sequoiaPrompt = inputProtocol.evaluateMacScreenPermission('not-determined', 'darwin', '24.3.0');
  assert.equal(sequoiaPrompt.useSystemPickerFallback, true);
  assert.equal(sequoiaPrompt.needsAttention, true);

  const denied = inputProtocol.evaluateMacScreenPermission('denied', 'darwin', '23.5.0');
  assert.equal(denied.canResetStaleTcc, true);
});

const EventEmitter = require('node:events');
const LinuxWaylandInput = require('../linux-wayland-input');

test('Windows SendInput worker C# source, verification script, and macOS plist files are valid', () => {
  const extracted = verifyWin32Worker.extractWorkerCSharp();
  assert.match(extracted, /public static class MswnlinkWin32Worker/);
  assert.match(extracted, /Shell_TrayWnd/);
  assert.match(extracted, /Progman/);

  // On Windows runners this also compiles C# via powershell.exe
  verifyWin32Worker.main();

  const mainPlist = fs.readFileSync(
    path.join(__dirname, '..', 'build', 'entitlements.mac.plist'),
    'utf8'
  );
  const inheritPlist = fs.readFileSync(
    path.join(__dirname, '..', 'build', 'entitlements.mac.inherit.plist'),
    'utf8'
  );
  assert.match(mainPlist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(inheritPlist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
});

test('normalizeClipboardText blocks Electron 45 Promise / object coercion ("[object]") while preserving Greek & quotes', () => {
  const fakePromise = Promise.resolve('copied');
  assert.equal(inputProtocol.normalizeClipboardText(fakePromise), '');
  assert.equal(inputProtocol.normalizeClipboardText({ then: () => {} }), '');
  assert.equal(inputProtocol.normalizeClipboardText({ arbitrary: true }), '');
  assert.equal(inputProtocol.normalizeClipboardText({ text: "έχω 'mswnlink'" }), "έχω 'mswnlink'");
  assert.equal(inputProtocol.normalizeClipboardText("έχω '3.3'"), "έχω '3.3'");
});

test('unicodeToXkbKeysym maps apostrophe, quotes, and official X.Org Greek keysyms ("έχω")', () => {
  assert.equal(inputProtocol.unicodeToXkbKeysym("'"), 0x0027);
  assert.equal(inputProtocol.unicodeToXkbKeysym('"'), 0x0022);
  assert.equal(inputProtocol.unicodeToXkbKeysym('έ'), 0x07b2);
  assert.equal(inputProtocol.unicodeToXkbKeysym('χ'), 0x07f7);
  assert.equal(inputProtocol.unicodeToXkbKeysym('ω'), 0x07f9);
  assert.equal(inputProtocol.unicodeToXkbKeysym('Σ'), 0x07d2);
  assert.equal(inputProtocol.unicodeToXkbKeysym('ς'), 0x07f3);
  assert.equal(inputProtocol.unicodeToXkbKeysym('σ'), 0x07f2);
  assert.equal(inputProtocol.unicodeToXkbKeysym('€'), 0x20ac);
});

test('isLinuxWaylandEnv detects Fedora Wayland even when AppImage inherits XDG_SESSION_TYPE=tty', () => {
  assert.equal(
    inputProtocol.isLinuxWaylandEnv({ XDG_SESSION_TYPE: 'tty', WAYLAND_DISPLAY: 'wayland-0' }, 'linux'),
    true
  );
  assert.equal(
    inputProtocol.isLinuxWaylandEnv({ XDG_SESSION_TYPE: 'wayland' }, 'linux'),
    true
  );
  assert.equal(
    inputProtocol.isLinuxWaylandEnv({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }, 'linux'),
    false
  );
  assert.equal(
    inputProtocol.isLinuxWaylandEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'win32'),
    false
  );
});

test('LinuxWaylandInput handles dbus-broker unique sender signals, HiDPI scaling, relative pointer fallback, and Greek keysyms', async () => {
  const matchRules = [];
  const keysymCalls = [];
  const relMotionCalls = [];
  let failAbsoluteMotion = true;

  class MockVariant {
    constructor(signature, value) {
      this.signature = signature;
      this.value = value;
    }
  }
  class MockMessage {
    constructor(opts) {
      Object.assign(this, opts);
    }
  }

  const bus = new EventEmitter();
  bus.name = ':1.99';
  bus.call = async (msg) => {
    if (msg.member === 'AddMatch') matchRules.push(msg.body[0]);
    return null;
  };
  bus.disconnect = () => {};

  const emitPortalResponse = (tokenVariant, results) => {
    const reqPath = `/org/freedesktop/portal/desktop/request/1_99/${tokenVariant.value}`;
    setImmediate(() => {
      // Simulate Fedora dbus-broker emitting from unique sender ':1.42'
      bus.emit('message', {
        sender: ':1.42',
        path: reqPath,
        interface: 'org.freedesktop.portal.Request',
        member: 'Response',
        body: [0, results]
      });
    });
    return reqPath;
  };

  const remoteIface = {
    CreateSession: async (opts) =>
      emitPortalResponse(opts.handle_token, {
        session_handle: new MockVariant('s', '/org/freedesktop/portal/desktop/session/1_99/s1')
      }),
    SelectDevices: async (_session, opts) => emitPortalResponse(opts.handle_token, {}),
    Start: async (_session, _parent, opts) =>
      emitPortalResponse(opts.handle_token, {
        devices: new MockVariant('u', 3),
        restore_token: new MockVariant('s', 'tok-fedora-41'),
        // Simulate 4K physical PipeWire size on 200% HiDPI Fedora display (logical 1920x1080)
        streams: new MockVariant('a(ua{sv})', [[77, { size: new MockVariant('(ii)', [3840, 2160]) }]])
      }),
    NotifyPointerMotionAbsolute: async () => {
      if (failAbsoluteMotion) throw new Error('Dropping early absolute pointer motion');
    },
    NotifyPointerMotion: async (_s, _o, dx, dy) => {
      relMotionCalls.push([dx, dy]);
    },
    NotifyKeyboardKeysym: async (_s, _o, sym, state) => {
      keysymCalls.push([sym, state]);
    },
    NotifyKeyboardKeycode: async () => {},
    NotifyPointerButton: async () => {}
  };

  const screenCastIface = {
    SelectSources: async (_s, opts) => emitPortalResponse(opts.handle_token, {}),
    OpenPipeWireRemote: async () => {
      throw new Error('no gstreamer in unit test');
    }
  };

  bus.getProxyObject = async () => ({
    getInterface: (name) => {
      if (name === 'org.freedesktop.portal.RemoteDesktop') return remoteIface;
      if (name === 'org.freedesktop.portal.ScreenCast') return screenCastIface;
      return { Close: async () => {} };
    }
  });

  const wayland = new LinuxWaylandInput({
    dbusModule: {
      Variant: MockVariant,
      Message: MockMessage,
      sessionBus: () => bus
    },
    screen: {
      getPrimaryDisplay: () => ({
        scaleFactor: 2,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 }
      })
    }
  });

  const started = await wayland.start('');
  assert.equal(started.restoreToken, 'tok-fedora-41');
  // Verify no sender='org.freedesktop.portal.Desktop' filter was used
  assert.ok(matchRules.every((r) => !r.includes("sender='org.freedesktop.portal.Desktop'")));
  // Verify HiDPI logical resolution (1920x1080, not 3840x2160)
  assert.equal(wayland.streamWidth, 1920);
  assert.equal(wayland.streamHeight, 1080);

  // Absolute motion throws -> seamlessly anchors to (0,0) and moves relatively to (960, 540)
  const moveRes = await wayland.inject({ kind: 'move', x: 0.5, y: 0.5 });
  assert.equal(moveRes.ok, true);
  assert.equal(relMotionCalls.length, 2);
  assert.deepEqual(relMotionCalls[1], [960, 540]);

  // Inject Greek "έχω" + space + "'" via NotifyKeyboardKeysym
  const textRes = await wayland.inject({ kind: 'text', text: "έχω '" });
  assert.equal(textRes.ok, true);
  const pressedSyms = keysymCalls.filter(([, st]) => st === 1).map(([sym]) => sym);
  assert.deepEqual(pressedSyms, [0x07b2, 0x07f7, 0x07f9, 0x0020, 0x0027]);

  await wayland.close();
});

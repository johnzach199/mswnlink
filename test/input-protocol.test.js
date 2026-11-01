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

  let openPipeWireRemoteCalled = false;
  let sessionBusArg = undefined;

  const screenCastIface = {
    SelectSources: async (_s, opts) => emitPortalResponse(opts.handle_token, {}),
    OpenPipeWireRemote: async () => {
      openPipeWireRemoteCalled = true;
      throw new Error('OpenPipeWireRemote must never be called over pure-JS dbus-next');
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
      sessionBus: (opts) => {
        sessionBusArg = opts;
        return bus;
      }
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
  // Verify non-singleton sessionBus(opts) was used and UNIX_FD OpenPipeWireRemote was never called on dbus-next
  assert.equal(typeof sessionBusArg, 'object');
  assert.notEqual(sessionBusArg, null);
  assert.equal(openPipeWireRemoteCalled, false);
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

  // Simulate dbus-broker closing stream mid-call ("Tried to write a message to a closed stream"):
  // must reject in-flight call immediately without hanging inputQueue or close()!
  remoteIface.NotifyPointerMotion = () =>
    new Promise(() => {
      setImmediate(() => {
        bus.emit('error', new Error('Tried to write a message to a closed stream'));
      });
    });

  await assert.rejects(
    () => wayland.inject({ kind: 'move', x: 0.25, y: 0.25 }),
    /closed stream|Wayland input session closed/i
  );
  assert.equal(wayland.isActive(), false);

  const closeStartedAt = Date.now();
  await wayland.close();
  assert.ok(Date.now() - closeStartedAt < 250, 'close() must return immediately on closed stream');
});

test('Wayland Gio.DBusConnection Python worker compiles cleanly and multi-OS executable icons are valid', () => {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync(
      'python3',
      ['-c', "import sys; compile(sys.stdin.read(), 'wayland_portal.py', 'exec')"],
      { input: LinuxWaylandInput.WAYLAND_PORTAL_PY_SCRIPT, stdio: ['pipe', 'ignore', 'pipe'], timeout: 3000 }
    );
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  const rootDir = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '3.4.0');
  assert.equal(pkg.build.win.artifactName, 'mswnlink-windows-v3.4-${arch}.${ext}');
  assert.equal(pkg.build.mac.artifactName, 'mswnlink-macos-v3.4-${arch}.${ext}');
  assert.equal(pkg.build.linux.artifactName, 'mswnlink-fedora-v3.4-${arch}.${ext}');
  assert.equal(pkg.build.win.icon, 'assets/mswnlink.ico');
  assert.equal(pkg.build.win.signAndEditExecutable, true);
  assert.equal(pkg.build.mac.icon, 'assets/mswnlink.icns');
  assert.equal(pkg.build.dmg.icon, 'assets/mswnlink.icns');
  assert.equal(pkg.build.linux.icon, 'assets/icons');

  const svg = fs.readFileSync(path.join(rootDir, 'assets', 'mswnlink.svg'), 'utf8');
  assert.match(svg, /#0b1020/i);
  assert.match(svg, /#a99aff/i);
  assert.match(svg, /#6de7bd/i);

  const ico = fs.readFileSync(path.join(rootDir, 'assets', 'mswnlink.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 6, 'ICO should include multi-resolution frames');

  const icns = fs.readFileSync(path.join(rootDir, 'assets', 'mswnlink.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);

  for (const rel of ['assets/mswnlink.png', 'assets/icons/256x256.png', 'assets/icons/512x512.png']) {
    const png = fs.readFileSync(path.join(rootDir, rel));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
});

test('Fedora Greek dead-key composition (;+ε -> έ, ¨+ι -> ϊ, ΐ) and XKB gr evdev steps work deterministically', () => {
  const tonos = inputProtocol.detectDeadKeyAccent({ key: 'Dead', code: 'Semicolon', shiftKey: false });
  assert.equal(tonos, 'acute');
  assert.equal(inputProtocol.composeDeadKeyCharacter(tonos, 'ε'), 'έ');
  assert.equal(inputProtocol.composeDeadKeyCharacter(tonos, 'Ω'), 'Ώ');

  const dialytika = inputProtocol.detectDeadKeyAccent({ key: 'Dead', code: 'Semicolon', shiftKey: true });
  assert.equal(dialytika, 'diaeresis');
  assert.equal(inputProtocol.composeDeadKeyCharacter(dialytika, 'ι'), 'ϊ');

  const dialytikaTonos = inputProtocol.detectDeadKeyAccent({ key: 'Dead', code: 'KeyW', shiftKey: true });
  assert.equal(dialytikaTonos, 'dialytika_acute');
  assert.equal(inputProtocol.composeDeadKeyCharacter(dialytikaTonos, 'ι'), 'ΐ');

  const deadQuote = inputProtocol.detectDeadKeyAccent({ key: 'Dead', code: 'Quote', shiftKey: false });
  assert.equal(inputProtocol.composeDeadKeyCharacter(deadQuote, ' '), "'");

  assert.deepEqual(inputProtocol.greekCharToEvdevSteps('έ'), [
    { keycode: 39, shift: false },
    { keycode: 18, shift: false }
  ]);
  assert.deepEqual(inputProtocol.greekCharToEvdevSteps('χ'), [{ keycode: 45, shift: false }]);
  assert.deepEqual(inputProtocol.greekCharToEvdevSteps('ω'), [{ keycode: 47, shift: false }]);
  assert.deepEqual(inputProtocol.greekCharToEvdevSteps('ς'), [{ keycode: 17, shift: false }]);
  assert.deepEqual(inputProtocol.greekCharToEvdevSteps('ΐ'), [
    { keycode: 17, shift: true },
    { keycode: 23, shift: false }
  ]);
});

test('Windows Remote Desktop (mstsc.exe) detection, capture recovery decision, and console source selection', () => {
  assert.equal(inputProtocol.isWindowsRdpEnv({ SESSIONNAME: 'RDP-Tcp#0' }, 'win32', false), true);
  assert.equal(inputProtocol.isWindowsRdpEnv({ SESSIONNAME: 'Console', CLIENTNAME: 'LAPTOP' }, 'win32', false), false);
  assert.equal(inputProtocol.isWindowsRdpEnv({ SESSIONNAME: '', CLIENTNAME: 'LAPTOP-PC' }, 'win32', false), true);
  assert.equal(inputProtocol.isWindowsRdpEnv({ SESSIONNAME: 'Console' }, 'win32', true), true);
  assert.equal(inputProtocol.isWindowsRdpEnv({ SESSIONNAME: 'RDP-Tcp#0' }, 'linux', true), false);

  assert.equal(
    inputProtocol.shouldRecoverCaptureOnTrackEnded({
      platform: 'win32',
      manualStop: false,
      epochMatches: true,
      hostActive: true
    }),
    true
  );
  assert.equal(
    inputProtocol.shouldRecoverCaptureOnTrackEnded({
      platform: 'win32',
      manualStop: true,
      epochMatches: true,
      hostActive: true
    }),
    false
  );
  assert.equal(
    inputProtocol.shouldRecoverCaptureOnTrackEnded({
      platform: 'linux',
      manualStop: false,
      epochMatches: true,
      hostActive: true
    }),
    false
  );

  const consoleSources = [
    { id: 'wayland-display:1', name: 'Wayland Display', displayId: '1' },
    { id: 'screen:console:0', name: 'Display 1', displayId: '10' },
    { id: 'screen:1:0', name: 'Display 2', displayId: '20' }
  ];
  assert.equal(
    inputProtocol.selectReplacementCaptureSource(consoleSources, 'screen:1:0', '10').id,
    'screen:1:0'
  );
  assert.equal(
    inputProtocol.selectReplacementCaptureSource(consoleSources, 'screen:rdp:0', '20').id,
    'screen:1:0'
  );
  assert.equal(
    inputProtocol.selectReplacementCaptureSource(consoleSources, 'screen:rdp:0', '99').id,
    'screen:console:0'
  );

  const csharp = verifyWin32Worker.extractWorkerCSharp();
  assert.match(csharp, /WTSQuerySessionInformation/);
  assert.match(csharp, /RedirectSessionToConsole/);
  assert.match(csharp, /SetKeepConsoleOnRdpDisconnect/);
  assert.match(csharp, /SyncInputDesktop/);
  assert.ok(!csharp.includes('System.IO.Pipes'));
  assert.ok(!csharp.includes('System.Security.Principal'));
  assert.ok(!csharp.includes('System.Diagnostics'));
});

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
  assert.equal(pkg.version, '4.0.0');
  assert.equal(pkg.build.win.artifactName, 'mswnlink-windows-v4-${arch}.${ext}');
  assert.equal(pkg.build.mac.artifactName, 'mswnlink-macos-v4-${arch}.${ext}');
  assert.equal(pkg.build.linux.artifactName, 'mswnlink-fedora-v4-${arch}.${ext}');
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

test('Fedora-to-Fedora keyboard fix (import time, try/finally key release, no ASCII->Greek clobber) & crosshair removal', () => {
  const { execFileSync } = require('node:child_process');
  const pyScript = LinuxWaylandInput.WAYLAND_PORTAL_PY_SCRIPT;
  assert.match(pyScript, /^import time$/m);
  assert.ok(!pyScript.includes('phys_evdev'), 'ASCII keys must never be overwritten by physicalEvdev on gr host');
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'linux-wayland-input.js'), 'utf8').includes('physicalEvdev'));

  const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(!stylesCss.includes('cursor: crosshair'), 'crosshair cursor must be removed from remote screen');
  assert.match(stylesCss, /#remote-video\.control-enabled\s*\{\s*cursor:\s*default;\s*\}/);

  const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(rendererJs, /function focusRemoteViewerInput\(\)\s*\{\s*const video = \$\('#remote-video'\)/);
  assert.match(rendererJs, /imeCaptureAllowedUntil/);

  // Runtime execution test of Python typeBatch loop under simulated GNOME 'gr' layout + held Shift
  const harness = `
import io, json, sys, types
script = sys.stdin.read()
calls = []
fake_conn = types.SimpleNamespace(
    get_unique_name=lambda: ':1.55',
    signal_subscribe=lambda *a: 1,
    signal_unsubscribe=lambda *a: None,
    call_sync=lambda bus, path, iface, method, variant, *rest: (
        calls.append((method, variant.value)) or fake_variant('(o)', ('/org/freedesktop/portal/desktop/request/1_55/r',))
    )
)
class fake_variant:
    def __init__(self, sig, val):
        self.sig = sig
        self.value = val
    def unpack(self):
        return self.value
class fake_settings:
    @staticmethod
    def new(_schema):
        return types.SimpleNamespace(get_value=lambda key: fake_variant('a(ss)', [('xkb', 'gr')]))
fake_gio = types.SimpleNamespace(
    BusType=types.SimpleNamespace(SESSION=0),
    DBusSignalFlags=types.SimpleNamespace(NONE=0),
    DBusCallFlags=types.SimpleNamespace(NONE=0),
    bus_get_sync=lambda *a: fake_conn,
    SettingsSchemaSource=types.SimpleNamespace(get_default=lambda: types.SimpleNamespace(lookup=lambda *a: object())),
    Settings=fake_settings
)
fake_glib = types.SimpleNamespace(
    Variant=fake_variant,
    VariantType=lambda s: s,
    MainLoop=lambda: types.SimpleNamespace(run=lambda: None, quit=lambda: None)
)
gi_mod = types.ModuleType('gi')
gi_repo = types.ModuleType('gi.repository')
gi_repo.Gio = fake_gio
gi_repo.GLib = fake_glib
gi_mod.repository = gi_repo
sys.modules['gi'] = gi_mod
sys.modules['gi.repository'] = gi_repo

# Slice out from 'elif cmd == "typeBatch":' logic or run stdin loop with mocked portal handshake
portal_body_idx = script.index('EMPTY_OPTS =')
prefix = script[:script.index('try:\\n    sess_tok')]
loop_code = script[portal_body_idx:].replace('cleanup_and_exit(0)', '')
ns = {}
exec(prefix, ns)
ns['session_handle'] = '/org/freedesktop/portal/desktop/session/1_55/s1'
ns['gst_proc'] = None
ns['cleanup_and_exit'] = lambda c=0: None
sys.stdout = io.StringIO()
sys.stdin = io.StringIO(json.dumps({
    'id': 1,
    'cmd': 'typeBatch',
    'heldShiftCodes': [42],
    'items': [
        {'cp': ord('h'), 'primarySym': 0x0068, 'unicodeSym': 0x01000068, 'greekSteps': None},
        {'cp': ord("'"), 'primarySym': 0x0027, 'unicodeSym': 0x01000027, 'greekSteps': None},
        {'cp': ord('έ'), 'primarySym': 0x07b2, 'unicodeSym': 0x010007b2, 'greekSteps': [{'keycode': 39, 'shift': False}, {'keycode': 18, 'shift': False}]}
    ]
}) + '\\n')
exec(loop_code, ns)
out = json.loads(sys.stdout.getvalue().strip())
assert out == {'id': 1, 'ok': True}, f'unexpected output: {out}'
# 1) 'h' must press+release XK_h (0x0068), NEVER evdev 35 ('η')!
sym_calls = [(c[1][2], c[1][3]) for c in calls if c[0] == 'NotifyKeyboardKeysym']
assert sym_calls == [(0x0068, 1), (0x0068, 0), (0x0027, 1), (0x0027, 0)], sym_calls
# 2) 'έ' uses greekSteps with heldShift (42) temporarily released, keys 39 & 18 tapped, and 42 restored
kc_calls = [(c[1][2], c[1][3]) for c in calls if c[0] == 'NotifyKeyboardKeycode']
assert (35, 1) not in kc_calls
assert kc_calls[0] == (42, 0) and kc_calls[-1] == (42, 1), kc_calls
assert (39, 1) in kc_calls and (39, 0) in kc_calls and (18, 1) in kc_calls and (18, 0) in kc_calls
`;
  try {
    execFileSync('python3', ['-c', harness], {
      input: pyScript,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    });
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
});

test('cross-OS clipboard file codecs (DropFiles, NSFilenamesPboardType, URI-list) and rich context normalization', () => {
  // 1. Windows CF_HDROP (DROPFILES) UTF-16LE roundtrip & FileNameW
  const winPaths = ['C:\\Users\\demo\\Docs\\έχω note.txt', 'D:\\Share\\report #1.pdf'];
  const dropBuf = inputProtocol.encodeWindowsDropFiles(winPaths);
  assert.equal(dropBuf.readUInt32LE(0), 20);
  assert.equal(dropBuf.readUInt32LE(16), 1);
  assert.deepEqual(inputProtocol.decodeWindowsDropFiles(dropBuf), winPaths);

  const singleBuf = Buffer.from('C:\\Temp\\archive.zip\0\0', 'utf16le');
  assert.deepEqual(inputProtocol.decodeWindowsFileNameW(singleBuf), ['C:\\Temp\\archive.zip']);

  // 2. macOS NSFilenamesPboardType XML plist escaping & roundtrip
  const macPaths = ['/Users/demo/Docs/Notes & Plans.md', "/Users/demo/Pictures/O'Brien <1>.png"];
  const plistXml = inputProtocol.encodeMacFilenamesPlist(macPaths);
  assert.match(plistXml, /<plist version="1\.0">/);
  assert.match(plistXml, /&amp;/);
  assert.match(plistXml, /&apos;/);
  assert.deepEqual(inputProtocol.decodeMacFilenamesPlist(plistXml), macPaths);

  // 3. Linux text/uri-list & x-special/gnome-copied-files roundtrip (with # ? spaces & comments)
  const linuxPaths = ['/home/fedora/Desktop/έχω notes #1?.txt', '/home/fedora/Downloads/file 2.tar.gz'];
  const uriList = inputProtocol.encodeUriList(linuxPaths);
  assert.deepEqual(inputProtocol.parseUriListPaths(`# comment line\n${uriList}`), linuxPaths);
  const gnomeCopied = inputProtocol.encodeUriList(linuxPaths, { gnomeCopiedFiles: true });
  assert.match(gnomeCopied, /^copy\n/);
  assert.deepEqual(inputProtocol.parseUriListPaths(gnomeCopied, { gnomeCopiedFiles: true }), linuxPaths);
  assert.deepEqual(
    inputProtocol.parseUriListPaths('cut\nfile:///home/fedora/move%20me.txt', { gnomeCopiedFiles: true }),
    ['/home/fedora/move me.txt']
  );

  // 4. normalizeClipboardPayload & echo-safe signature (path-independent for staged files)
  assert.equal(inputProtocol.normalizeClipboardPayload(Promise.resolve('bad')).text, '');
  const richContext = inputProtocol.normalizeClipboardPayload({
    text: 'Formatted heading',
    html: '<b>Formatted heading</b>'
  });
  assert.equal(richContext.kind, 'context');
  assert.equal(richContext.html, '<b>Formatted heading</b>');

  const imgPayload = inputProtocol.normalizeClipboardPayload({
    imageBase64: 'data:image/png;base64,iVBORw0KGgo='
  });
  assert.equal(imgPayload.kind, 'image');
  assert.equal(imgPayload.imageBase64, 'iVBORw0KGgo=');

  const srcFilesSig = inputProtocol.clipboardPayloadSignature({
    kind: 'files',
    files: [
      { path: 'C:\\Users\\Alice\\Desktop\\demo.pdf', name: 'demo.pdf', size: 4096 },
      { path: 'C:\\Users\\Alice\\Desktop\\img.png', name: 'img.png', size: 1024 }
    ]
  });
  const stagedFilesSig = inputProtocol.clipboardPayloadSignature({
    kind: 'files',
    files: [
      { path: '/tmp/mswnlink-clipboard/batch-1/demo.pdf', name: 'demo.pdf', size: 4096 },
      { path: '/tmp/mswnlink-clipboard/batch-1/img.png', name: 'img.png', size: 1024 }
    ]
  });
  assert.equal(srcFilesSig, stagedFilesSig);
});

test('manual clipboard/file buttons are removed and buttonless drag-and-drop & clipboard file batching are wired', () => {
  const rootDir = path.join(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const rendererJs = fs.readFileSync(path.join(rootDir, 'renderer.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
  const preloadJs = fs.readFileSync(path.join(rootDir, 'preload.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');

  for (const removedId of [
    'host-send-clipboard-button',
    'host-get-clipboard-button',
    'host-send-file-button',
    'send-clipboard-button',
    'get-clipboard-button',
    'send-file-button'
  ]) {
    assert.ok(!indexHtml.includes(removedId), `Manual button #${removedId} must be removed from index.html`);
    assert.ok(!rendererJs.includes(removedId), `Manual button #${removedId} must be removed from renderer.js`);
  }

  assert.match(indexHtml, /id="viewer-drop-overlay"/);
  assert.match(stylesCss, /\.viewer-stage\.is-drop-target/);
  assert.match(preloadJs, /writeClipboardFiles/);
  assert.match(preloadJs, /readFileFromPath/);
  assert.match(mainJs, /CLIPBOARD_FILES_STAGING_DIR/);
  assert.match(mainJs, /write-clipboard-files/);
  assert.match(mainJs, /read-file-from-path/);
  assert.match(mainJs, /mode === 'clipboard'/);
  assert.match(rendererJs, /enqueueChannelFileTransfer/);
  assert.match(rendererJs, /sendDroppedFilesOverChannel/);
  assert.match(rendererJs, /sendClipboardFilesOverChannel/);
  assert.match(rendererJs, /clipboard-file-batch-start/);
  assert.match(rendererJs, /clipboard-file-batch-end/);
});

test('mswnlink v4 visual fixes: theme-switch flash guard, dark select options, toast non-overlap, mobile bar spacing, and v4 branding', () => {
  const rootDir = path.join(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');
  const rendererJs = fs.readFileSync(path.join(rootDir, 'renderer.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');

  assert.match(indexHtml, /<title>mswnlink v4<\/title>/);
  assert.match(indexHtml, /<span class="wordmark">mswnlink v4<\/span>/);
  assert.match(mainJs, /title:\s*'mswnlink v4'/);
  assert.match(mainJs, /Name=mswnlink v4/);

  assert.match(stylesCss, /:root\[data-theme-switching="true"\]\s+\*/);
  assert.match(stylesCss, /select option\s*\{[^}]*background-color:\s*var\(--surface\)/);
  assert.match(stylesCss, /\.fullscreen-exit-overlay\s*\{[^}]*top:\s*42px;/);
  assert.match(stylesCss, /body\[data-current-page="share"\]\s+\.toast\s*\{\s*bottom:\s*88px;\s*\}/);
  assert.match(stylesCss, /body\[data-current-page="session"\]\s+\.toast\s*\{[^}]*top:\s*calc\(var\(--bar-h\)\s*\+\s*64px\)/);
  assert.match(rendererJs, /dataset\.themeSwitching\s*=\s*'true'/);
});

test('macOS Sequoia/Tahoe DMG packaging fix: APFS+UDZO config, xattr cleanup, stapler target, and strict hdiutil verify', () => {
  const rootDir = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const workflowYml = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'main.yml'), 'utf8');
  const afterPackJs = fs.readFileSync(path.join(rootDir, 'scripts', 'after-pack.cjs'), 'utf8');
  const installMacSh = fs.readFileSync(path.join(rootDir, 'scripts', 'install-mac.sh'), 'utf8');

  assert.equal(pkg.build.mac.gatekeeperAssess, false);
  assert.equal(pkg.build.dmg.filesystem, 'APFS');
  assert.equal(pkg.build.dmg.format, 'UDZO');
  assert.equal(pkg.build.dmg.sign, false);

  assert.match(afterPackJs, /run\('xattr',\s*\['-cr',\s*appPath\]\)/);
  assert.match(afterPackJs, /\.DS_Store/);
  assert.match(afterPackJs, /fs\.chmodSync\(.*0o755\)/s);

  assert.ok(!workflowYml.includes('-noverify'), 'main.yml must never hide broken DMGs via hdiutil attach -noverify');
  assert.ok(!workflowYml.includes('-noautofsck'), 'main.yml must never skip fsck on mounted DMGs');
  assert.ok(!workflowYml.includes('xcrun stapler validate "$DMG_PATH"'), 'stapler validate must target $APP_PATH, not $DMG_PATH');
  assert.match(workflowYml, /xcrun stapler validate "\$APP_PATH"/);
  assert.match(workflowYml, /hdiutil verify "\$dmg_file"/);
  assert.match(workflowYml, /hdiutil verify "\$dmg"/);
  assert.match(workflowYml, /hdiutil create -volname "mswnlink" -srcfolder "\$stage_dir" -fs APFS -format UDZO -ov "\$dmg_file"/);
  assert.match(workflowYml, /filesystem:\s*"APFS"/);
  assert.match(workflowYml, /format:\s*"UDZO"/);
  assert.match(workflowYml, /test -x "\$APP\/Contents\/MacOS\/mswnlink"/);
  assert.match(workflowYml, /plutil -lint "\$PLIST"/);
  assert.match(workflowYml, /com\.apple\.quarantine/);

  assert.match(installMacSh, /LOCAL_DMG="\$\{1:-\}"/);
  assert.match(installMacSh, /xattr -cr "\/Applications\/\$APP"/);
  assert.match(installMacSh, /releases\?per_page=1/);
});

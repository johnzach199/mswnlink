'use strict';

/*
 * Fedora/GNOME & KDE Wayland input backend using XDG Desktop Portal.
 *
 * Why two tiers exist:
 * 1. Native Python3 + Gio.DBusConnection worker (preferred on Fedora Workstation):
 *    `org.freedesktop.portal.ScreenCast.OpenPipeWireRemote` returns D-Bus type `'h'`
 *    (UNIX_FD via SCM_RIGHTS). Pure-JS `dbus-next` does not negotiate `UNIX_FD` on
 *    standard Node sockets, so calling `OpenPipeWireRemote` causes `dbus-broker` to
 *    drop the socket (`Tried to write a message to a closed stream`) and leave in-flight
 *    calls hanging. `Gio.DBusConnection` (from `python3-gobject-base`, preinstalled on
 *    Fedora Workstation) negotiates `UNIX_FD` natively in C (`libgio-2.0`), receives the
 *    authenticated PipeWire FD on the same portal session sender, passes `fd=<fd>` to
 *    `gst-launch-1.0 pipewiresrc`, and unlocks 1:1 `NotifyPointerMotionAbsolute` in Mutter.
 * 2. Hardened `dbus-next` fallback (used when `python3-gobject` is absent or when a mock
 *    `dbusModule` is injected in unit tests):
 *    Always creates a dedicated non-singleton `MessageBus` (`dbus.sessionBus(opts)`),
 *    never invokes `UNIX_FD` methods over `dbus-next`, tracks socket stream closure so
 *    in-flight promises reject immediately instead of hanging `stopHost()`, and falls
 *    back seamlessly to `(0, 0)`-anchored `NotifyPointerMotion`.
 */
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const {
  shortcutDescriptorForPlatform,
  unicodeToXkbKeysym,
  greekCharToEvdevSteps,
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
const REQUEST_TIMEOUT_MS = 120000;
const DBUS_CALL_TIMEOUT_MS = 2000;
const DBUS_CLOSE_TIMEOUT_MS = 600;

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

const WAYLAND_PORTAL_PY_SCRIPT = String.raw`
import json
import os
import secrets
import subprocess
import sys
import threading
import gi
from gi.repository import Gio, GLib

BUS_NAME = 'org.freedesktop.portal.Desktop'
ROOT = '/org/freedesktop/portal/desktop'
REQUEST_IFACE = 'org.freedesktop.portal.Request'
SESSION_IFACE = 'org.freedesktop.portal.Session'
REMOTE_IFACE = 'org.freedesktop.portal.RemoteDesktop'
SCREENCAST_IFACE = 'org.freedesktop.portal.ScreenCast'

write_lock = threading.Lock()
def emit_json(obj):
    line = json.dumps(obj, separators=(',', ':')) + '\n'
    with write_lock:
        sys.stdout.write(line)
        sys.stdout.flush()

conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
unique_name = conn.get_unique_name() or ''
if not unique_name.startswith(':'):
    raise RuntimeError('Session D-Bus connection has no unique name.')
sender_token = unique_name[1:].replace('.', '_')

loop = GLib.MainLoop()
loop_thread = threading.Thread(target=loop.run, daemon=True)
loop_thread.start()

pending_lock = threading.Lock()
pending_Waiters = {}
buffered_signals = []

def on_request_response(_connection, _sender, object_path, _iface, _signal, params):
    status, results = params.unpack()
    with pending_lock:
        waiter = pending_Waiters.get(object_path)
        if waiter is not None:
            waiter['status'] = int(status)
            waiter['results'] = results
            waiter['event'].set()
        else:
            buffered_signals.append((object_path, int(status), results))

req_sub_id = conn.signal_subscribe(
    None,
    REQUEST_IFACE,
    'Response',
    None,
    None,
    Gio.DBusSignalFlags.NONE,
    on_request_response
)

def make_token(prefix):
    return f"{prefix}{secrets.token_hex(8)}"

def portal_request(token_prefix, method_iface, method_name, build_args, timeout_sec=120.0):
    req_token = make_token(token_prefix)
    expected_path = f"{ROOT}/request/{sender_token}/{req_token}"
    waiter = {'event': threading.Event(), 'status': -1, 'results': {}}
    with pending_lock:
        pending_Waiters[expected_path] = waiter

    active_path = expected_path
    try:
        reply = conn.call_sync(
            BUS_NAME,
            ROOT,
            method_iface,
            method_name,
            build_args(req_token),
            GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE,
            15000,
            None
        )
        returned_path = reply.unpack()[0]
        if returned_path and returned_path != expected_path:
            active_path = returned_path
            with pending_lock:
                pending_Waiters[active_path] = waiter
                for b_path, b_status, b_res in list(buffered_signals):
                    if b_path == active_path or b_path == expected_path:
                        waiter['status'] = b_status
                        waiter['results'] = b_res
                        waiter['event'].set()
                        break

        if not waiter['event'].wait(timeout_sec):
            raise RuntimeError('Timed out waiting for the Fedora/Wayland desktop permission dialog.')
        if waiter['status'] == 0:
            return waiter['results']
        if waiter['status'] == 1:
            raise RuntimeError('The desktop permission dialog was cancelled.')
        raise RuntimeError('The desktop denied the requested remote-control permission.')
    finally:
        with pending_lock:
            pending_Waiters.pop(expected_path, None)
            pending_Waiters.pop(active_path, None)

restore_in = sys.argv[1] if len(sys.argv) > 1 else ''
session_handle = ''
gst_proc = None
pw_fd_held = None
closed_sub_id = 0

def cleanup_and_exit(code=0):
    global gst_proc, pw_fd_held, session_handle, closed_sub_id
    if gst_proc is not None:
        try:
            gst_proc.terminate()
        except Exception:
            pass
        gst_proc = None
    if pw_fd_held is not None:
        try:
            os.close(pw_fd_held)
        except Exception:
            pass
        pw_fd_held = None
    if closed_sub_id:
        try:
            conn.signal_unsubscribe(closed_sub_id)
        except Exception:
            pass
        closed_sub_id = 0
    if session_handle:
        handle = session_handle
        session_handle = ''
        try:
            conn.call_sync(
                BUS_NAME,
                handle,
                SESSION_IFACE,
                'Close',
                None,
                None,
                Gio.DBusCallFlags.NONE,
                500,
                None
            )
        except Exception:
            pass
    try:
        conn.signal_unsubscribe(req_sub_id)
    except Exception:
        pass
    try:
        loop.quit()
    except Exception:
        pass
    os._exit(code)

try:
    sess_tok = make_token('session')
    created = portal_request(
        'create',
        REMOTE_IFACE,
        'CreateSession',
        lambda rt: GLib.Variant('(a{sv})', ({
            'handle_token': GLib.Variant('s', rt),
            'session_handle_token': GLib.Variant('s', sess_tok),
        },))
    )
    session_handle = str(created.get('session_handle', ''))
    if not session_handle.startswith('/'):
        raise RuntimeError('The desktop portal did not return a valid session handle.')

    def on_session_closed(_c, _s, path, _i, _sig, _p):
        if path == session_handle:
            emit_json({'event': 'closed'})
            cleanup_and_exit(0)

    closed_sub_id = conn.signal_subscribe(
        None,
        SESSION_IFACE,
        'Closed',
        session_handle,
        None,
        Gio.DBusSignalFlags.NONE,
        on_session_closed
    )

    def build_select_devices(rt):
        opts = {
            'handle_token': GLib.Variant('s', rt),
            'types': GLib.Variant('u', 3),
            'persist_mode': GLib.Variant('u', 2),
        }
        if restore_in:
            opts['restore_token'] = GLib.Variant('s', restore_in)
        return GLib.Variant('(oa{sv})', (session_handle, opts))

    portal_request('devices', REMOTE_IFACE, 'SelectDevices', build_select_devices)

    try:
        portal_request(
            'sources',
            SCREENCAST_IFACE,
            'SelectSources',
            lambda rt: GLib.Variant('(oa{sv})', (session_handle, {
                'handle_token': GLib.Variant('s', rt),
                'types': GLib.Variant('u', 1),
                'multiple': GLib.Variant('b', False),
                'cursor_mode': GLib.Variant('u', 1),
            }))
        )
    except Exception:
        pass

    started = portal_request(
        'start',
        REMOTE_IFACE,
        'Start',
        lambda rt: GLib.Variant('(osa{sv})', (session_handle, '', {
            'handle_token': GLib.Variant('s', rt),
        }))
    )

    granted = int(started.get('devices', 0))
    if (granted & 3) != 3:
        raise RuntimeError(
            'Linux did not grant both pointer and keyboard control. Turn on "Allow remote interaction" in the Fedora/GNOME permission dialog.'
        )

    streams = started.get('streams') or []
    stream_id = None
    stream_props = {}
    pw_consumer_alive = False

    if len(streams) > 0:
        stream_id = int(streams[0][0])
        raw_props = streams[0][1] if len(streams[0]) > 1 else {}
        for k, v in raw_props.items():
            if isinstance(v, (list, tuple)):
                stream_props[str(k)] = [int(x) for x in v]
        try:
            res_var, out_fd_list = conn.call_with_unix_fd_list_sync(
                BUS_NAME,
                ROOT,
                SCREENCAST_IFACE,
                'OpenPipeWireRemote',
                GLib.Variant('(oa{sv})', (session_handle, {})),
                GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                5000,
                None,
                None
            )
            fd_idx = int(res_var.unpack()[0])
            if out_fd_list is not None:
                pw_fd_held = out_fd_list.get(fd_idx)
                os.set_inheritable(pw_fd_held, True)
                gst_proc = subprocess.Popen(
                    [
                        'gst-launch-1.0',
                        '-q',
                        'pipewiresrc',
                        f'fd={pw_fd_held}',
                        f'path={stream_id}',
                        'do-timestamp=true',
                        '!',
                        'fakesink',
                        'sync=false',
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    pass_fds=(pw_fd_held,)
                )
                pw_consumer_alive = True
        except Exception:
            pw_consumer_alive = False

    emit_json({
        'event': 'ready',
        'devices': granted,
        'streamId': stream_id,
        'props': stream_props,
        'pipewireConsumer': pw_consumer_alive,
        'restoreToken': str(started.get('restore_token', '') or '')
    })
except Exception as init_err:
    emit_json({'event': 'init_error', 'error': str(init_err)})
    cleanup_and_exit(1)

EMPTY_OPTS = GLib.Variant('a{sv}', {})

for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    req_id = msg.get('id')
    cmd = msg.get('cmd')
    if cmd == 'close':
        if req_id is not None:
            emit_json({'id': req_id, 'ok': True})
        cleanup_and_exit(0)
    try:
        if cmd == 'moveAbs':
            if gst_proc is not None and gst_proc.poll() is not None:
                gst_proc = None
                raise RuntimeError('PipeWire consumer exited; switching to relative pointer mode')
            conn.call_sync(
                BUS_NAME,
                ROOT,
                REMOTE_IFACE,
                'NotifyPointerMotionAbsolute',
                GLib.Variant('(oa{sv}udd)', (
                    session_handle,
                    {},
                    int(msg['streamId']),
                    float(msg['x']),
                    float(msg['y']),
                )),
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None
            )
        elif cmd == 'moveRel':
            conn.call_sync(
                BUS_NAME,
                ROOT,
                REMOTE_IFACE,
                'NotifyPointerMotion',
                GLib.Variant('(oa{sv}dd)', (
                    session_handle,
                    {},
                    float(msg['dx']),
                    float(msg['dy']),
                )),
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None
            )
        elif cmd == 'button':
            conn.call_sync(
                BUS_NAME,
                ROOT,
                REMOTE_IFACE,
                'NotifyPointerButton',
                GLib.Variant('(oa{sv}iu)', (
                    session_handle,
                    {},
                    int(msg['button']),
                    int(msg['state']),
                )),
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None
            )
        elif cmd == 'axisDiscrete':
            conn.call_sync(
                BUS_NAME,
                ROOT,
                REMOTE_IFACE,
                'NotifyPointerAxisDiscrete',
                GLib.Variant('(oa{sv}ui)', (
                    session_handle,
                    {},
                    int(msg['axis']),
                    int(msg['steps']),
                )),
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None
            )
        elif cmd == 'keycode':
            conn.call_sync(
                BUS_NAME,
                ROOT,
                REMOTE_IFACE,
                'NotifyKeyboardKeycode',
                GLib.Variant('(oa{sv}iu)', (
                    session_handle,
                    {},
                    int(msg['keycode']),
                    int(msg['state']),
                )),
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None
            )
        elif cmd == 'keysym':
            conn.call_sync(
                BUS_NAME,
                ROOT,
                REMOTE_IFACE,
                'NotifyKeyboardKeysym',
                GLib.Variant('(oa{sv}iu)', (
                    session_handle,
                    {},
                    int(msg['keysym']),
                    int(msg['state']),
                )),
                None,
                Gio.DBusCallFlags.NONE,
                1500,
                None
            )
            hold_ms = float(msg.get('holdMs', 0) or 0)
            if hold_ms > 0 and int(msg['state']) == 1:
                time.sleep(min(0.05, hold_ms / 1000.0))
        elif cmd == 'typeBatch':
            active_layout = ''
            try:
                schema_src = Gio.SettingsSchemaSource.get_default()
                if schema_src is not None and schema_src.lookup('org.gnome.desktop.input-sources', True) is not None:
                    gs = Gio.Settings.new('org.gnome.desktop.input-sources')
                    mru = gs.get_value('mru-sources').unpack()
                    srcs = gs.get_value('sources').unpack()
                    chosen = mru[0] if mru else (srcs[0] if srcs else None)
                    if chosen and len(chosen) >= 2:
                        active_layout = str(chosen[1]).split('+')[0].strip().lower()
            except Exception:
                active_layout = ''

            def tap_evdev(kcode, with_shift=False):
                if with_shift:
                    conn.call_sync(BUS_NAME, ROOT, REMOTE_IFACE, 'NotifyKeyboardKeycode',
                                   GLib.Variant('(oa{sv}iu)', (session_handle, {}, 42, 1)),
                                   None, Gio.DBusCallFlags.NONE, 1500, None)
                    time.sleep(0.003)
                conn.call_sync(BUS_NAME, ROOT, REMOTE_IFACE, 'NotifyKeyboardKeycode',
                               GLib.Variant('(oa{sv}iu)', (session_handle, {}, int(kcode), 1)),
                               None, Gio.DBusCallFlags.NONE, 1500, None)
                time.sleep(0.005)
                conn.call_sync(BUS_NAME, ROOT, REMOTE_IFACE, 'NotifyKeyboardKeycode',
                               GLib.Variant('(oa{sv}iu)', (session_handle, {}, int(kcode), 0)),
                               None, Gio.DBusCallFlags.NONE, 1500, None)
                if with_shift:
                    time.sleep(0.002)
                    conn.call_sync(BUS_NAME, ROOT, REMOTE_IFACE, 'NotifyKeyboardKeycode',
                                   GLib.Variant('(oa{sv}iu)', (session_handle, {}, 42, 0)),
                                   None, Gio.DBusCallFlags.NONE, 1500, None)
                time.sleep(0.003)

            def tap_sym(ksym, hold_sec):
                conn.call_sync(BUS_NAME, ROOT, REMOTE_IFACE, 'NotifyKeyboardKeysym',
                               GLib.Variant('(oa{sv}iu)', (session_handle, {}, int(ksym), 1)),
                               None, Gio.DBusCallFlags.NONE, 1500, None)
                if hold_sec > 0:
                    time.sleep(hold_sec)
                conn.call_sync(BUS_NAME, ROOT, REMOTE_IFACE, 'NotifyKeyboardKeysym',
                               GLib.Variant('(oa{sv}iu)', (session_handle, {}, int(ksym), 0)),
                               None, Gio.DBusCallFlags.NONE, 1500, None)
                if hold_sec > 0:
                    time.sleep(0.004)

            phys_evdev = msg.get('physicalEvdev')
            items = msg.get('items') or []
            if active_layout == 'gr' and phys_evdev is not None and len(items) == 1:
                tap_evdev(int(phys_evdev), bool(msg.get('shiftKey')))
            else:
                for item in items:
                    cp = int(item.get('cp', 0))
                    primary_sym = int(item.get('primarySym', 0))
                    unicode_sym = int(item.get('unicodeSym', 0))
                    greek_steps = item.get('greekSteps')
                    if active_layout == 'gr' and greek_steps:
                        for step in greek_steps:
                            tap_evdev(int(step['keycode']), bool(step.get('shift')))
                        continue
                    if cp > 0x7f:
                        # Prefer 0x01000000|cp (Uxxxx) with a 15ms hold so GNOME Mutter never
                        # collides with inactive secondary XKB groups (e.g. group 1 'gr' while
                        # group 0 'us' is active) and clients read the ephemeral keymap before keyup.
                        try:
                            tap_sym(unicode_sym, 0.015)
                        except Exception:
                            tap_sym(primary_sym, 0.015)
                    else:
                        tap_sym(primary_sym, 0.004)
        if req_id is not None:
            emit_json({'id': req_id, 'ok': True})
    except Exception as call_err:
        if req_id is not None:
            emit_json({'id': req_id, 'ok': False, 'error': str(call_err)})

cleanup_and_exit(0)
`;

let cachedPythonGioAvailable = null;
function hasPythonGioPortalSupport() {
  if (cachedPythonGioAvailable !== null) return cachedPythonGioAvailable;
  if (process.platform !== 'linux') {
    cachedPythonGioAvailable = false;
    return false;
  }
  try {
    execFileSync('python3', ['-c', 'import gi; from gi.repository import Gio, GLib'], {
      stdio: 'ignore',
      timeout: 2500
    });
    cachedPythonGioAvailable = true;
  } catch {
    cachedPythonGioAvailable = false;
  }
  return cachedPythonGioAvailable;
}

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
  if (!bus || !bus.name || !bus.name.startsWith(':')) throw new Error('The desktop session D-Bus is not ready.');
  const sender = bus.name.slice(1).replace(/\./g, '_');
  return `${ROOT}/request/${sender}/${requestToken}`;
}

function withPromiseTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createFreshSessionBus(dbus) {
  // Always pass a fresh options object so `dbus-next` creates an independent socket
  // instead of returning its module-global singleton (which stays permanently dead
  // after `.disconnect()`).
  const opts = process.env.DBUS_SESSION_BUS_ADDRESS
    ? { busAddress: process.env.DBUS_SESSION_BUS_ADDRESS }
    : { negotiateUnixFd: false };
  return dbus.sessionBus(opts);
}

function addMatch(bus, rule, dbusMod) {
  const { Message } = loadDbus(dbusMod);
  return withPromiseTimeout(
    bus.call(new Message({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'AddMatch',
      signature: 's',
      body: [rule]
    })),
    DBUS_CALL_TIMEOUT_MS,
    'Timed out adding D-Bus signal match.'
  );
}

function removeMatch(bus, rule, dbusMod, isAlive = true) {
  if (!isAlive || !bus) return Promise.resolve();
  const { Message } = loadDbus(dbusMod);
  return withPromiseTimeout(
    bus.call(new Message({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'RemoveMatch',
      signature: 's',
      body: [rule]
    })),
    DBUS_CLOSE_TIMEOUT_MS,
    'Timed out removing D-Bus signal match.'
  ).catch(() => {});
}

class LinuxWaylandInput {
  constructor(options = {}) {
    this.screen = options.screen || null;
    this.dbusModule = options.dbusModule || null;
    this.forceDbusNext = options.forceDbusNext === true;

    // Python Gio worker state
    this.pyWorker = null;
    this.pyRl = null;
    this.pyReady = false;
    this.pySeq = 0;
    this.pyPending = new Map();

    // dbus-next fallback state
    this.bus = null;
    this.busConnected = false;
    this.remote = null;
    this.sessionHandle = null;
    this.sessionClosedRule = '';
    this.sessionClosedHandler = null;
    this.abortWaiters = new Set();

    // Shared coordinate & held-input state
    this.streamId = null;
    this.streamWidth = 1920;
    this.streamHeight = 1080;
    this.useRelativeFallback = false;
    this.relativeAnchored = false;
    this.cursorX = 0;
    this.cursorY = 0;
    this.restoreToken = '';
    this.startPromise = null;
    this.closing = false;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.wheelX = 0;
    this.wheelY = 0;
  }

  isActive() {
    if (this.closing) return false;
    if (this.pyWorker && this.pyReady && !this.pyWorker.killed && this.pyWorker.exitCode === null) {
      return true;
    }
    return Boolean(this.remote && this.sessionHandle && this.bus && this.busConnected);
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
      if (scaleFactor > 1 && Math.abs(rw / scaleFactor - fallbackW) <= 4) {
        return { width: fallbackW, height: fallbackH };
      }
      return { width: Math.max(1, Math.round(rw)), height: Math.max(1, Math.round(rh)) };
    }

    return { width: fallbackW, height: fallbackH };
  }

  _abortAllWaiters(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || 'Wayland portal session closed.'));
    for (const reject of [...this.abortWaiters]) {
      try { reject(err); } catch {}
    }
    this.abortWaiters.clear();
    for (const [, pending] of this.pyPending) {
      clearTimeout(pending.timer);
      try { pending.reject(err); } catch {}
    }
    this.pyPending.clear();
  }

  _callDbusBounded(fn, timeoutMs = DBUS_CALL_TIMEOUT_MS) {
    if (!this.bus || !this.busConnected || this.closing) {
      return Promise.reject(new Error('The Wayland desktop portal D-Bus connection is closed.'));
    }
    let abortReject = null;
    const abortPromise = new Promise((_, reject) => {
      abortReject = reject;
      this.abortWaiters.add(reject);
    });
    return withPromiseTimeout(
      Promise.race([Promise.resolve().then(fn), abortPromise]),
      timeoutMs,
      'Wayland desktop portal call timed out.'
    ).finally(() => {
      if (abortReject) this.abortWaiters.delete(abortReject);
    });
  }

  async _portalRequestDbusNext(bus, requestToken, invoke, dbusMod) {
    const dbusLib = loadDbus(dbusMod);
    const expectedPath = requestPathFor(bus, requestToken);
    // Do NOT filter by sender='org.freedesktop.portal.Desktop': dbus-broker emits
    // portal signals from unique ':1.xx' names.
    const rule = `type='signal',interface='${REQUEST_IFACE}',member='Response'`;
    await addMatch(bus, rule, dbusLib);

    let activePath = expectedPath;
    let timeout = null;
    let handler = null;
    let abortReject = null;
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

    abortReject = (err) => {
      if (!settled) {
        settled = true;
        rejectResponse(err);
      }
    };
    this.abortWaiters.add(abortReject);

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
    if (timeout && typeof timeout.unref === 'function') timeout.unref();

    try {
      const returnedPath = unwrap(await this._callDbusBounded(
        () => invoke(new dbusLib.Variant('s', requestToken)),
        15000
      ));
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
      if (abortReject) this.abortWaiters.delete(abortReject);
      if (handler) bus.removeListener('message', handler);
      await removeMatch(bus, rule, dbusLib, this.busConnected && !this.closing);
    }
  }

  async start(previousRestoreToken = '') {
    if (this.isActive()) {
      return { restoreToken: this.restoreToken || previousRestoreToken || '' };
    }
    if (this.startPromise) return this.startPromise;

    this.closing = false;
    this.startPromise = (async () => {
      try {
        return await this._openBestSession(previousRestoreToken);
      } catch (firstError) {
        if (this.closing) throw firstError;
        if (previousRestoreToken) {
          console.warn('[mswnlink] Saved Wayland restore token rejected; retrying with fresh portal prompt:', firstError.message);
          return await this._openBestSession('');
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

  async _openBestSession(previousRestoreToken = '') {
    await this._closeInternal();
    this.closing = false;

    if (!this.dbusModule && !this.forceDbusNext && hasPythonGioPortalSupport()) {
      return this._openPythonGioSession(previousRestoreToken);
    }
    return this._openDbusNextSession(previousRestoreToken);
  }

  async _openPythonGioSession(previousRestoreToken = '') {
    return new Promise((resolve, reject) => {
      let initSettled = false;
      const child = spawn('python3', ['-u', '-c', WAYLAND_PORTAL_PY_SCRIPT, previousRestoreToken || ''], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
      });
      this.pyWorker = child;
      this.pyReady = false;

      let stderrBuf = '';
      child.stderr.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-1200);
      });

      const rl = readline.createInterface({ input: child.stdout });
      this.pyRl = rl;

      const initTimer = setTimeout(() => {
        if (!initSettled) {
          initSettled = true;
          this._closeInternal().catch(() => {});
          reject(new Error('Timed out waiting for the Fedora/Wayland desktop permission dialog.'));
        }
      }, REQUEST_TIMEOUT_MS + 5000);
      if (initTimer && typeof initTimer.unref === 'function') initTimer.unref();

      const abortOnClose = (err) => {
        if (!initSettled) {
          initSettled = true;
          clearTimeout(initTimer);
          reject(err);
        }
      };
      this.abortWaiters.add(abortOnClose);

      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.event === 'ready') {
          if (initSettled) return;
          initSettled = true;
          clearTimeout(initTimer);
          this.abortWaiters.delete(abortOnClose);

          this.pyReady = true;
          const resolved = this.resolveLogicalDesktopSize(msg.props || {});
          this.streamWidth = resolved.width;
          this.streamHeight = resolved.height;
          if (typeof msg.streamId === 'number' && Number.isFinite(msg.streamId) && msg.pipewireConsumer) {
            this.streamId = msg.streamId;
            this.useRelativeFallback = false;
            console.info(`[mswnlink] Wayland Gio portal session started (stream=${this.streamId}, logical=${this.streamWidth}x${this.streamHeight}, devices=${msg.devices}).`);
          } else {
            this.streamId = typeof msg.streamId === 'number' ? msg.streamId : null;
            this.useRelativeFallback = true;
            this.relativeAnchored = false;
            console.info(`[mswnlink] Wayland Gio portal session started in relative pointer mode (logical=${this.streamWidth}x${this.streamHeight}, devices=${msg.devices}).`);
          }
          this.restoreToken = typeof msg.restoreToken === 'string' ? msg.restoreToken : '';
          this.heldKeys.clear();
          this.heldButtons.clear();
          resolve({ restoreToken: this.restoreToken });
          return;
        }

        if (msg.event === 'init_error') {
          if (!initSettled) {
            initSettled = true;
            clearTimeout(initTimer);
            this.abortWaiters.delete(abortOnClose);
            this._closeInternal().catch(() => {});
            reject(new Error(`Fedora/Wayland remote input could not be enabled: ${msg.error || 'Portal session rejected.'}`));
          }
          return;
        }

        if (msg.event === 'closed') {
          console.info('[mswnlink] Wayland RemoteDesktop portal session was closed by the desktop.');
          this.pyReady = false;
          this._abortAllWaiters('Wayland RemoteDesktop portal session was closed by the desktop.');
          return;
        }

        if (msg.id !== undefined && this.pyPending.has(msg.id)) {
          const entry = this.pyPending.get(msg.id);
          this.pyPending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.ok) entry.resolve(msg);
          else entry.reject(new Error(msg.error || 'Wayland portal command failed.'));
        }
      });

      const handleWorkerExit = (errOrCode) => {
        this.pyReady = false;
        this._abortAllWaiters('Wayland Gio input worker exited.');
        if (!initSettled) {
          initSettled = true;
          clearTimeout(initTimer);
          this.abortWaiters.delete(abortOnClose);
          const detail = stderrBuf.trim() || (errOrCode instanceof Error ? errOrCode.message : `worker exited (${errOrCode})`);
          reject(new Error(`Fedora/Wayland remote input could not be enabled: ${detail}`));
        }
      };

      child.once('error', handleWorkerExit);
      child.once('exit', (code) => handleWorkerExit(code));
    });
  }

  _sendPyCommand(payload, timeoutMs = DBUS_CALL_TIMEOUT_MS) {
    if (!this.pyWorker || !this.pyReady || this.pyWorker.killed || this.pyWorker.exitCode !== null || !this.pyWorker.stdin.writable) {
      return Promise.reject(new Error('The Wayland remote-control session is no longer active.'));
    }
    const id = ++this.pySeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pyPending.delete(id);
        reject(new Error(`Wayland portal command ${payload.cmd} timed out.`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.pyPending.set(id, { resolve, reject, timer });
      try {
        this.pyWorker.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pyPending.delete(id);
        reject(err);
      }
    });
  }

  async _openDbusNextSession(previousRestoreToken = '') {
    const dbus = loadDbus(this.dbusModule);
    const bus = createFreshSessionBus(dbus);
    this.bus = bus;
    this.busConnected = false;

    const markDisconnected = (reason) => {
      if (this.bus !== bus) return;
      this.busConnected = false;
      this.remote = null;
      this.sessionHandle = null;
      this.streamId = null;
      this._abortAllWaiters(reason || 'Desktop portal D-Bus stream closed.');
    };

    bus.on('error', (error) => {
      const msg = error && error.message ? error.message : String(error);
      if (!this.closing) {
        console.warn('[mswnlink] Desktop portal D-Bus error:', msg);
      }
      if (/closed stream|EPIPE|ECONNRESET|disconnected/i.test(msg)) {
        markDisconnected(error);
      }
    });

    const rawStream = bus._connection && bus._connection.stream;
    if (rawStream && typeof rawStream.on === 'function') {
      rawStream.once('close', () => markDisconnected('Desktop portal D-Bus socket closed.'));
      rawStream.once('end', () => markDisconnected('Desktop portal D-Bus socket ended.'));
    }

    await new Promise((resolve, reject) => {
      if (bus.name) {
        this.busConnected = true;
        return resolve();
      }
      const onConnect = () => {
        cleanup();
        this.busConnected = true;
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        bus.removeListener('connect', onConnect);
        bus.removeListener('error', onError);
      };
      bus.once('connect', onConnect);
      bus.once('error', onError);
    });

    try {
      const remoteObject = await this._callDbusBounded(() => bus.getProxyObject(BUS_NAME, ROOT), 5000);
      this.remote = remoteObject.getInterface(REMOTE_IFACE);
      const screenCast = remoteObject.getInterface(SCREENCAST_IFACE);

      const createToken = token('create');
      const sessionToken = token('session');
      const created = await this._portalRequestDbusNext(bus, createToken, requestToken => this.remote.CreateSession({
        handle_token: requestToken,
        session_handle_token: new dbus.Variant('s', sessionToken)
      }), dbus);
      this.sessionHandle = String(created.session_handle || '');
      if (!this.sessionHandle.startsWith('/')) {
        throw new Error('The desktop portal did not return a valid session handle.');
      }

      this.sessionClosedRule = `type='signal',path='${this.sessionHandle}',interface='${SESSION_IFACE}',member='Closed'`;
      this.sessionClosedHandler = (message) => {
        if (message && message.path === this.sessionHandle && message.interface === SESSION_IFACE && message.member === 'Closed') {
          console.info('[mswnlink] Wayland RemoteDesktop portal session was closed by the desktop.');
          markDisconnected('Wayland RemoteDesktop portal session closed by desktop.');
        }
      };
      bus.on('message', this.sessionClosedHandler);
      await addMatch(bus, this.sessionClosedRule, dbus).catch(() => {});

      const devicesToken = token('devices');
      await this._portalRequestDbusNext(bus, devicesToken, requestToken => {
        const options = {
          handle_token: requestToken,
          types: new dbus.Variant('u', 3),
          persist_mode: new dbus.Variant('u', 2)
        };
        if (previousRestoreToken) options.restore_token = new dbus.Variant('s', previousRestoreToken);
        return this.remote.SelectDevices(this.sessionHandle, options);
      }, dbus);

      // Only pair ScreenCast over dbus-next when a custom dbusModule is injected for
      // tests: without Gio UNIX_FD passing (`OpenPipeWireRemote`), GNOME Mutter drops
      // unconsumed ScreenCast absolute motions silently, whereas pure RemoteDesktop
      // relative pointer motion works immediately without any UNIX_FD call.
      if (this.dbusModule && screenCast && typeof screenCast.SelectSources === 'function') {
        try {
          const sourceToken = token('sources');
          await this._portalRequestDbusNext(bus, sourceToken, requestToken => screenCast.SelectSources(this.sessionHandle, {
            handle_token: requestToken,
            types: new dbus.Variant('u', 1),
            multiple: new dbus.Variant('b', false),
            cursor_mode: new dbus.Variant('u', 1)
          }), dbus);
        } catch (sourceErr) {
          console.warn('[mswnlink] Portal SelectSources unavailable; using relative pointer mode:', sourceErr.message);
        }
      }

      const startToken = token('start');
      const started = await this._portalRequestDbusNext(bus, startToken, requestToken => this.remote.Start(
        this.sessionHandle, '', { handle_token: requestToken }
      ), dbus);
      const granted = Number(started.devices || 0);
      if ((granted & 3) !== 3) {
        throw new Error('Linux did not grant both pointer and keyboard control. Turn on "Allow remote interaction" in the Fedora/GNOME permission dialog.');
      }

      const streams = Array.isArray(started.streams) ? started.streams : [];
      if (streams.length && this.dbusModule) {
        this.streamId = Number(streams[0][0]);
        const props = unwrapDict(streams[0][1]);
        const resolved = this.resolveLogicalDesktopSize(props);
        this.streamWidth = resolved.width;
        this.streamHeight = resolved.height;
        this.useRelativeFallback = false;
        console.info(`[mswnlink] Wayland input session started (stream=${this.streamId}, logical=${this.streamWidth}x${this.streamHeight}, devices=${granted}).`);
      } else {
        const props = streams.length ? unwrapDict(streams[0][1]) : {};
        const resolved = this.resolveLogicalDesktopSize(props);
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
      await this._closeInternal();
      throw new Error(`Fedora/Wayland remote input could not be enabled: ${error.message}`);
    }
  }

  async _notifyPointerMotionAbsolute(px, py) {
    if (this.pyWorker && this.pyReady) {
      await this._sendPyCommand({ cmd: 'moveAbs', streamId: this.streamId, x: px, y: py });
      return;
    }
    await this._callDbusBounded(() => this.remote.NotifyPointerMotionAbsolute(this.sessionHandle, {}, this.streamId, px, py));
  }

  async _notifyPointerMotionRelative(dx, dy) {
    if (this.pyWorker && this.pyReady) {
      await this._sendPyCommand({ cmd: 'moveRel', dx, dy });
      return;
    }
    await this._callDbusBounded(() => this.remote.NotifyPointerMotion(this.sessionHandle, {}, dx, dy));
  }

  async _notifyPointerButton(button, state) {
    if (this.pyWorker && this.pyReady) {
      await this._sendPyCommand({ cmd: 'button', button, state });
      return;
    }
    await this._callDbusBounded(() => this.remote.NotifyPointerButton(this.sessionHandle, {}, button, state));
  }

  async _notifyPointerAxisDiscrete(axis, steps) {
    if (this.pyWorker && this.pyReady) {
      await this._sendPyCommand({ cmd: 'axisDiscrete', axis, steps });
      return;
    }
    await this._callDbusBounded(() => this.remote.NotifyPointerAxisDiscrete(this.sessionHandle, {}, axis, steps));
  }

  async _notifyKeyboardKeycode(keycode, state) {
    if (this.pyWorker && this.pyReady) {
      await this._sendPyCommand({ cmd: 'keycode', keycode, state });
      return;
    }
    await this._callDbusBounded(() => this.remote.NotifyKeyboardKeycode(this.sessionHandle, {}, keycode, state));
  }

  async _notifyKeyboardKeysym(keysym, state) {
    if (this.pyWorker && this.pyReady) {
      await this._sendPyCommand({ cmd: 'keysym', keysym, state });
      return;
    }
    await this._callDbusBounded(() => this.remote.NotifyKeyboardKeysym(this.sessionHandle, {}, keysym, state));
  }

  async movePointerRelative(targetX, targetY) {
    if (!this.relativeAnchored) {
      await this._notifyPointerMotionRelative(-this.streamWidth * 1.5, -this.streamHeight * 1.5);
      this.cursorX = 0;
      this.cursorY = 0;
      this.relativeAnchored = true;
    }
    const dx = targetX - this.cursorX;
    const dy = targetY - this.cursorY;
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
      await this._notifyPointerMotionRelative(dx, dy);
      this.cursorX = targetX;
      this.cursorY = targetY;
    }
  }

  async injectTextKeysyms(text, meta = null) {
    const chars = Array.from(String(text || '').slice(0, 64));
    if (!chars.length) return { ok: true };

    if (this.pyWorker && this.pyReady) {
      const items = [];
      for (const ch of chars) {
        const cp = ch.codePointAt(0);
        if (!cp || cp < 0x20 || cp === 0x7f) continue;
        const primarySym = unicodeToXkbKeysym(cp);
        if (!primarySym) continue;
        items.push({
          cp,
          primarySym,
          unicodeSym: (0x01000000 | cp) >>> 0,
          greekSteps: greekCharToEvdevSteps(ch)
        });
      }
      if (!items.length) return { ok: true };
      const code = meta && typeof meta.code === 'string' ? meta.code : '';
      const physicalEvdev = (
        items.length === 1 &&
        items[0].cp <= 0x7f &&
        (/^Key[A-Z]$/.test(code) || code === 'Semicolon') &&
        EVDEV_KEYCODES[code]
      )
        ? EVDEV_KEYCODES[code]
        : null;
      try {
        await this._sendPyCommand({
          cmd: 'typeBatch',
          items,
          physicalEvdev,
          shiftKey: Boolean(meta && meta.shiftKey)
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          fallbackPaste: true,
          remainingText: chars.join(''),
          reason: err && err.message ? err.message : 'Wayland typeBatch failed'
        };
      }
    }

    const holdKeymapSettle = () => (
      this.dbusModule
        ? Promise.resolve()
        : new Promise(resolve => setTimeout(resolve, 12))
    );

    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      const cp = ch.codePointAt(0);
      if (!cp || cp < 0x20 || cp === 0x7f) continue;
      const primarySym = unicodeToXkbKeysym(cp);
      const unicodeSym = (0x01000000 | cp) >>> 0;
      // On real D-Bus (`!this.dbusModule`), prefer 0x01000000|cp for non-ASCII so GNOME
      // Mutter never collides with inactive secondary XKB layout groups.
      const preferredSym = (!this.dbusModule && cp > 0x7f) ? unicodeSym : primarySym;
      const alternateSym = (!this.dbusModule && cp > 0x7f) ? primarySym : unicodeSym;
      if (!preferredSym) continue;
      try {
        await this._notifyKeyboardKeysym(preferredSym, 1);
        if (cp > 0x7f) await holdKeymapSettle();
        await this._notifyKeyboardKeysym(preferredSym, 0);
      } catch (err) {
        if (preferredSym !== alternateSym && alternateSym) {
          try {
            await this._notifyKeyboardKeysym(alternateSym, 1);
            if (cp > 0x7f) await holdKeymapSettle();
            await this._notifyKeyboardKeysym(alternateSym, 0);
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
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      const px = Math.min(this.streamWidth - 1, Math.max(0, x * this.streamWidth));
      const py = Math.min(this.streamHeight - 1, Math.max(0, y * this.streamHeight));

      if (!this.useRelativeFallback && this.streamId !== null && Number.isFinite(this.streamId)) {
        try {
          await this._notifyPointerMotionAbsolute(px, py);
          this.cursorX = px;
          this.cursorY = py;
          return { ok: true };
        } catch (absErr) {
          if (!this.isActive()) throw absErr;
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
      const buttons = { 0: 0x110, 1: 0x112, 2: 0x111 };
      const button = buttons[Number(event.button)];
      if (!button) return { ok: false };
      const state = event.action === 'down' ? 1 : 0;
      await this._notifyPointerButton(button, state);
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
      if (stepsY) await this._notifyPointerAxisDiscrete(0, stepsY);
      if (stepsX) await this._notifyPointerAxisDiscrete(1, stepsX);
      return { ok: true };
    }

    if (event.kind === 'text') {
      return this.injectTextKeysyms(event.text, {
        code: event.code || '',
        shiftKey: Boolean(event.shiftKey)
      });
    }

    if (event.kind === 'key') {
      if (event.textInput === true && typeof event.key === 'string' && event.key.length >= 1) {
        if (event.action === 'down') {
          return this.injectTextKeysyms(event.key, {
            code: event.code || '',
            shiftKey: Boolean(event.shiftKey)
          });
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
      await this._notifyKeyboardKeycode(keycode, state);
      if (state) this.heldKeys.add(keycode); else this.heldKeys.delete(keycode);
      return { ok: true };
    }

    if (event.kind === 'shortcut') {
      const desc = shortcutDescriptorForPlatform(String(event.action || ''), 'linux');
      if (!desc || !desc.evdev) return { ok: false, reason: 'Unsupported shortcut.' };
      const ctrlHeld = this.heldKeys.has(EVDEV_KEYCODES.ControlLeft) || this.heldKeys.has(EVDEV_KEYCODES.ControlRight);
      const needShift = desc.modifiers.includes('shift');
      const shiftHeld = this.heldKeys.has(EVDEV_KEYCODES.ShiftLeft) || this.heldKeys.has(EVDEV_KEYCODES.ShiftRight);
      if (!ctrlHeld) await this._notifyKeyboardKeycode(EVDEV_KEYCODES.ControlLeft, 1);
      if (needShift && !shiftHeld) await this._notifyKeyboardKeycode(EVDEV_KEYCODES.ShiftLeft, 1);
      await this._notifyKeyboardKeycode(desc.evdev, 1);
      await this._notifyKeyboardKeycode(desc.evdev, 0);
      if (needShift && !shiftHeld) await this._notifyKeyboardKeycode(EVDEV_KEYCODES.ShiftLeft, 0);
      if (!ctrlHeld) await this._notifyKeyboardKeycode(EVDEV_KEYCODES.ControlLeft, 0);
      return { ok: true };
    }

    if (event.kind === 'releaseAll') {
      await this.releaseAll();
      return { ok: true };
    }

    return { ok: true };
  }

  async releaseAll() {
    const keys = [...this.heldKeys];
    const buttons = [...this.heldButtons];
    this.heldKeys.clear();
    this.heldButtons.clear();
    this.wheelX = 0;
    this.wheelY = 0;
    if (!this.isActive() || (!keys.length && !buttons.length)) return;
    await withPromiseTimeout(
      Promise.allSettled([
        ...keys.map(code => this._notifyKeyboardKeycode(code, 0)),
        ...buttons.map(code => this._notifyPointerButton(code, 0))
      ]),
      DBUS_CLOSE_TIMEOUT_MS,
      'Release held Wayland keys timed out.'
    ).catch(() => {});
  }

  async _closeInternal() {
    this.closing = true;
    await this.releaseAll().catch(() => {});
    this._abortAllWaiters('Wayland input session closed.');

    // Tear down Python Gio worker cleanly if present
    const py = this.pyWorker;
    const rl = this.pyRl;
    this.pyWorker = null;
    this.pyRl = null;
    this.pyReady = false;
    if (rl) {
      try { rl.close(); } catch {}
    }
    if (py) {
      try {
        if (py.stdin && py.stdin.writable) {
          py.stdin.write('{"cmd":"close"}\n');
          py.stdin.end();
        }
      } catch {}
      await new Promise((resolve) => {
        if (py.exitCode !== null || py.killed) return resolve();
        const killTimer = setTimeout(() => {
          try { py.kill('SIGTERM'); } catch {}
          resolve();
        }, 250);
        if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
        py.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }

    // Tear down dbus-next bus cleanly if present (never hanging on a closed stream)
    const bus = this.bus;
    const wasConnected = this.busConnected;
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
    this.busConnected = false;
    this.restoreToken = '';

    if (bus && closedHandler) {
      try { bus.removeListener('message', closedHandler); } catch {}
    }
    if (bus && wasConnected && closedRule) {
      await removeMatch(bus, closedRule, this.dbusModule, true);
    }
    if (bus && wasConnected && handle) {
      await withPromiseTimeout(
        (async () => {
          const sessionObject = await bus.getProxyObject(BUS_NAME, handle);
          const session = sessionObject.getInterface(SESSION_IFACE);
          await session.Close();
        })(),
        DBUS_CLOSE_TIMEOUT_MS,
        'Closing Wayland portal session timed out.'
      ).catch(() => {});
    }
    if (bus) {
      try { bus.disconnect(); } catch {}
    }
  }

  async close() {
    await this._closeInternal();
  }
}

module.exports = LinuxWaylandInput;
module.exports.isSupportedSession = (env = process.env) => isLinuxWaylandEnv(env, process.platform);
module.exports.WAYLAND_PORTAL_PY_SCRIPT = WAYLAND_PORTAL_PY_SCRIPT;

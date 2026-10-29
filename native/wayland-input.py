#!/usr/bin/env python3
"""
mswnlink Wayland input helper.

Injects mouse and keyboard events on Wayland desktops (GNOME, KDE Plasma, ...)
through the standard xdg-desktop-portal RemoteDesktop + ScreenCast interfaces.
RobotJS cannot do this: under Wayland it can only talk to XWayland, so clicks
and keys never reach native windows.

Protocol
  stdout (one JSON object per line):
    {"event": "ready", "width": W, "height": H}
    {"event": "error", "code": "...", "message": "..."}
    {"event": "closed"}
  stdin (one JSON object per line):
    {"op": "move",   "x": 0..1, "y": 0..1}
    {"op": "button", "code": <evdev BTN_*>, "down": true|false}
    {"op": "axis",   "axis": 0 (vertical) | 1 (horizontal), "steps": <int>}
    {"op": "key",    "code": <evdev KEY_*>, "down": true|false}

Usage: wayland-input.py <path-to-restore-token-file>
"""
import json
import os
import sys
import threading


def emit(**payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


try:
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except Exception as exc:  # pragma: no cover - depends on the host system
    emit(
        event="error",
        code="no-gi",
        message="Python GObject is missing. On Fedora run: sudo dnf install python3-gobject (%s)" % exc,
    )
    sys.exit(2)

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE_DESKTOP = "org.freedesktop.portal.RemoteDesktop"
SCREEN_CAST = "org.freedesktop.portal.ScreenCast"

TOKEN_FILE = sys.argv[1] if len(sys.argv) > 1 else ""

connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender_part = connection.get_unique_name().lstrip(":").replace(".", "_")
_counter = 0


def new_token(prefix):
    global _counter
    _counter += 1
    return "mswn_%s_%d_%d" % (prefix, os.getpid(), _counter)


def v(signature, value):
    return GLib.Variant(signature, value)


def portal_request(interface, method, build_params, timeout=180):
    """Call a portal method that answers through a Request/Response signal."""
    token = new_token("req")
    request_path = "%s/request/%s/%s" % (PORTAL_PATH, sender_part, token)
    outcome = {}
    loop = GLib.MainLoop()

    def on_response(_conn, _sender, _path, _iface, _signal, params):
        code, results = params.unpack()
        outcome["code"] = code
        outcome["results"] = results
        loop.quit()

    subscription = connection.signal_subscribe(
        PORTAL_BUS,
        "org.freedesktop.portal.Request",
        "Response",
        request_path,
        None,
        Gio.DBusSignalFlags.NONE,
        on_response,
    )
    timer = None
    try:
        params = build_params(token)
        connection.call_sync(
            PORTAL_BUS, PORTAL_PATH, interface, method, params,
            None, Gio.DBusCallFlags.NONE, -1, None,
        )
        timer = GLib.timeout_add_seconds(timeout, loop.quit)
        if "code" not in outcome:
            loop.run()
    finally:
        connection.signal_unsubscribe(subscription)
        if timer is not None:
            try:
                GLib.source_remove(timer)
            except Exception:
                pass
    if "code" not in outcome:
        raise RuntimeError("Timed out waiting for the desktop portal. Was the permission prompt dismissed?")
    return outcome["code"], outcome["results"]


def load_restore_token():
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def save_restore_token(token):
    if not TOKEN_FILE or not token:
        return
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, "w", encoding="utf-8") as handle:
            handle.write(token)
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass


def open_session():
    # 1. Create a RemoteDesktop session.
    code, results = portal_request(
        REMOTE_DESKTOP,
        "CreateSession",
        lambda t: v("(a{sv})", ({
            "handle_token": v("s", t),
            "session_handle_token": v("s", new_token("session")),
        },)),
    )
    if code != 0 or "session_handle" not in results:
        raise RuntimeError("The desktop portal refused to create a remote-control session.")
    session = str(results["session_handle"])

    # 2. Ask for keyboard (1) + pointer (2). persist_mode 2 keeps the approval
    #    so the prompt only appears once, where the desktop supports it.
    options = {"types": v("u", 3), "persist_mode": v("u", 2)}
    restore = load_restore_token()
    if restore:
        options["restore_token"] = v("s", restore)

    def select_devices(t):
        merged = dict(options)
        merged["handle_token"] = v("s", t)
        return v("(oa{sv})", (session, merged))

    code, _ = portal_request(REMOTE_DESKTOP, "SelectDevices", select_devices)
    if code != 0:
        raise RuntimeError("The desktop portal does not allow keyboard and mouse control.")

    # 3. A monitor stream is needed so absolute pointer positions have a target.
    code, _ = portal_request(
        SCREEN_CAST,
        "SelectSources",
        lambda t: v("(oa{sv})", (session, {
            "handle_token": v("s", t),
            "types": v("u", 1),
            "multiple": v("b", False),
        })),
    )
    if code != 0:
        raise RuntimeError("The desktop portal did not offer a monitor to control.")

    # 4. Start. This is where the desktop shows its one-time approval dialog.
    code, results = portal_request(
        REMOTE_DESKTOP,
        "Start",
        lambda t: v("(osa{sv})", (session, "", {"handle_token": v("s", t)})),
    )
    if code != 0:
        raise RuntimeError("Remote control was not approved in the desktop prompt.")
    save_restore_token(results.get("restore_token"))

    streams = results.get("streams") or []
    if not streams:
        raise RuntimeError("The desktop portal returned no monitor stream.")
    node_id, props = streams[0]
    size = props.get("size") or (1, 1)
    return session, int(node_id), int(size[0]), int(size[1])


def main():
    try:
        session, node_id, width, height = open_session()
    except Exception as exc:
        emit(event="error", code="portal", message=str(exc))
        return 3

    loop = GLib.MainLoop()

    def on_closed(*_args):
        emit(event="closed")
        loop.quit()

    connection.signal_subscribe(
        PORTAL_BUS, "org.freedesktop.portal.Session", "Closed",
        session, None, Gio.DBusSignalFlags.NONE, on_closed,
    )

    def notify(method, signature, *args):
        connection.call_sync(
            PORTAL_BUS, PORTAL_PATH, REMOTE_DESKTOP, method,
            v(signature, (session, {}) + args),
            None, Gio.DBusCallFlags.NONE, -1, None,
        )

    def handle(line):
        try:
            command = json.loads(line)
            op = command.get("op")
            if op == "move":
                x = min(1.0, max(0.0, float(command["x"]))) * max(0, width - 1)
                y = min(1.0, max(0.0, float(command["y"]))) * max(0, height - 1)
                notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", node_id, x, y)
            elif op == "button":
                notify("NotifyPointerButton", "(oa{sv}iu)", int(command["code"]), 1 if command.get("down") else 0)
            elif op == "axis":
                notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", 0 if int(command["axis"]) == 0 else 1, int(command["steps"]))
            elif op == "key":
                notify("NotifyKeyboardKeycode", "(oa{sv}iu)", int(command["code"]), 1 if command.get("down") else 0)
        except Exception as exc:
            sys.stderr.write("input error: %s\n" % exc)
            sys.stderr.flush()
        return False

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if line:
                GLib.idle_add(handle, line)
        GLib.idle_add(loop.quit)

    threading.Thread(target=reader, daemon=True).start()
    emit(event="ready", width=width, height=height)
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

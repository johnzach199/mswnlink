'use strict';

/**
 * Windows native Win32 input backend for mswnlink.
 *
 * Why this exists:
 * 1. Windows Task Manager (Taskmgr.exe), Registry Editor, Device Manager, and
 *    elevated terminals run at High Integrity Level. When a Medium-integrity
 *    process uses RobotJS/SendInput and the user clicks Task Manager, Task
 *    Manager becomes the foreground window and Windows UIPI silently drops all
 *    subsequent SendInput + SetCursorPos calls — leaving the mouse button stuck
 *    down and the cursor completely frozen on Task Manager.
 * 2. RobotJS uses VkKeyScan() for ASCII letters, which fails (-1) when the host
 *    keyboard layout is non-Latin (e.g. Greek, Cyrillic, Hebrew).
 *
 * How this solves both:
 * - Launches a persistent hidden PowerShell/C# Win32 SendInput worker connected
 *   over a private authenticated Named Pipe (\\.\pipe\mswnlink-input-<uuid>).
 * - Requests one-time UAC elevation (-Verb RunAs) when remote control starts so
 *   the worker runs at High Integrity Level with Per-Monitor DPI Awareness v2,
 *   allowing full clicking, dragging, scrolling, and typing inside Task Manager.
 * - If the host user declines UAC (or uses a standard non-admin account),
 *   automatically falls back to running the same worker at Medium Integrity WITH
 *   active UIPI SendInput==0 detection: if clicking Task Manager blocks input,
 *   moving the pointer away shifts foreground focus back to Shell_TrayWnd and
 *   releases any held mouse buttons so the cursor NEVER gets stuck.
 */

const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { mapWin32VirtualKey, shortcutDescriptorForPlatform } = require('./lib/input-protocol');

const WORKER_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$PipeName,
  [Parameter(Mandatory=$true)][string]$Secret
)

$ErrorActionPreference = 'Stop'

$code = @"
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Collections.Generic;

public static class MswnlinkWin32Worker {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_SCANCODE = 0x0008;

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    private static HashSet<int> heldButtons = new HashSet<int>();
    private static Dictionary<ushort, bool> heldKeys = new Dictionary<ushort, bool>();
    private static int lastTargetX = 0;
    private static int lastTargetY = 0;

    public static void InitDpi() {
        try { SetProcessDpiAwarenessContext((IntPtr)(-4)); }
        catch {
            try { SetProcessDPIAware(); } catch {}
        }
    }

    public static bool IsElevated() {
        try {
            using (WindowsIdentity id = WindowsIdentity.GetCurrent()) {
                WindowsPrincipal principal = new WindowsPrincipal(id);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        } catch {
            return false;
        }
    }

    private static int ToAbsolute(int coord, int origin, int span) {
        if (span <= 1) return 0;
        long clamped = Math.Max(origin, Math.Min(origin + span - 1, coord));
        return (int)(((clamped - origin) * 65535L) / (span - 1));
    }

    private static void EscapeElevatedForeground() {
        IntPtr tray = FindWindow("Shell_TrayWnd", null);
        if (tray == IntPtr.Zero) return;
        IntPtr fg = GetForegroundWindow();
        uint dummy = 0;
        uint curThread = GetCurrentThreadId();
        uint trayThread = GetWindowThreadProcessId(tray, out dummy);
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out dummy) : 0;
        try {
            if (fgThread != 0 && fgThread != curThread) AttachThreadInput(curThread, fgThread, true);
            if (trayThread != 0 && trayThread != curThread) AttachThreadInput(curThread, trayThread, true);
            SetForegroundWindow(tray);
        } catch {}
        finally {
            try { if (trayThread != 0 && trayThread != curThread) AttachThreadInput(curThread, trayThread, false); } catch {}
            try { if (fgThread != 0 && fgThread != curThread) AttachThreadInput(curThread, fgThread, false); } catch {}
        }
    }

    public static bool MovePointer(int x, int y) {
        lastTargetX = x;
        lastTargetY = y;
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));

        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.dx = ToAbsolute(x, vx, vw);
        inp[0].U.mi.dy = ToAbsolute(y, vy, vh);
        inp[0].U.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

        uint sent = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        if (sent == 0) {
            // Non-elevated fallback hit a High-Integrity foreground window (e.g. Task Manager).
            // Release foreground lock when pointer moves outside the elevated window or was dragging.
            IntPtr fg = GetForegroundWindow();
            bool outsideFg = true;
            if (fg != IntPtr.Zero) {
                RECT r;
                if (GetWindowRect(fg, out r)) {
                    outsideFg = (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom);
                }
            }
            if (outsideFg || heldButtons.Count > 0) {
                EscapeElevatedForeground();
                ReleaseAll();
                SetCursorPos(x, y);
                SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
            }
            return false;
        }
        return true;
    }

    public static bool MouseButton(int button, bool down) {
        uint flag = 0;
        if (button == 0) flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        else if (button == 1) flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else if (button == 2) flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else return false;

        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_MOUSE;
        inp[0].U.mi.dwFlags = flag;
        uint sent = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        if (down && sent > 0) heldButtons.Add(button);
        else heldButtons.Remove(button);

        if (sent == 0 && !down) {
            // Ensure a mouse-up blocked by UIPI never leaves the button logically held.
            EscapeElevatedForeground();
            SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
            SetCursorPos(lastTargetX, lastTargetY);
        }
        return sent > 0;
    }

    public static void MouseWheel(int dx, int dy) {
        List<INPUT> list = new List<INPUT>();
        if (dy != 0) {
            INPUT v = new INPUT();
            v.type = INPUT_MOUSE;
            v.U.mi.dwFlags = MOUSEEVENTF_WHEEL;
            v.U.mi.mouseData = unchecked((uint)dy);
            list.Add(v);
        }
        if (dx != 0) {
            INPUT h = new INPUT();
            h.type = INPUT_MOUSE;
            h.U.mi.dwFlags = MOUSEEVENTF_HWHEEL;
            h.U.mi.mouseData = unchecked((uint)dx);
            list.Add(h);
        }
        if (list.Count > 0) {
            INPUT[] arr = list.ToArray();
            SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static bool KeyToggle(ushort vk, bool extended, bool down) {
        ushort scan = (ushort)MapVirtualKey(vk, 0);
        uint flags = down ? 0u : KEYEVENTF_KEYUP;
        if (extended) flags |= KEYEVENTF_EXTENDEDKEY;
        if (scan != 0) flags |= KEYEVENTF_SCANCODE;

        INPUT[] inp = new INPUT[1];
        inp[0].type = INPUT_KEYBOARD;
        inp[0].U.ki.wVk = vk;
        inp[0].U.ki.wScan = scan;
        inp[0].U.ki.dwFlags = flags;

        uint sent = SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        if (down && sent > 0) heldKeys[vk] = extended;
        else heldKeys.Remove(vk);
        return sent > 0;
    }

    public static bool TypeUnicode(string text) {
        if (string.IsNullOrEmpty(text)) return true;
        INPUT[] inputs = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++) {
            ushort ch = (ushort)text[i];
            inputs[i * 2].type = INPUT_KEYBOARD;
            inputs[i * 2].U.ki.wVk = 0;
            inputs[i * 2].U.ki.wScan = ch;
            inputs[i * 2].U.ki.dwFlags = KEYEVENTF_UNICODE;

            inputs[i * 2 + 1].type = INPUT_KEYBOARD;
            inputs[i * 2 + 1].U.ki.wVk = 0;
            inputs[i * 2 + 1].U.ki.wScan = ch;
            inputs[i * 2 + 1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        }
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) > 0;
    }

    public static bool TapCtrlShortcut(ushort vk, bool withShift) {
        List<INPUT> seq = new List<INPUT>();
        Action<ushort, bool> addKey = (ushort code, bool isDown) => {
            INPUT item = new INPUT();
            item.type = INPUT_KEYBOARD;
            item.U.ki.wVk = code;
            item.U.ki.wScan = (ushort)MapVirtualKey(code, 0);
            item.U.ki.dwFlags = (isDown ? 0u : KEYEVENTF_KEYUP) | (item.U.ki.wScan != 0 ? KEYEVENTF_SCANCODE : 0u);
            seq.Add(item);
        };
        addKey(0xA2, true); // VK_LCONTROL down
        if (withShift) addKey(0xA0, true); // VK_LSHIFT down
        addKey(vk, true);
        addKey(vk, false);
        if (withShift) addKey(0xA0, false);
        addKey(0xA2, false);
        INPUT[] arr = seq.ToArray();
        return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) > 0;
    }

    public static void ReleaseAll() {
        foreach (var kv in new Dictionary<ushort, bool>(heldKeys)) {
            try { KeyToggle(kv.Key, kv.Value, false); } catch {}
        }
        heldKeys.Clear();
        foreach (int b in new List<int>(heldButtons)) {
            try {
                uint flag = b == 0 ? MOUSEEVENTF_LEFTUP : (b == 1 ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_RIGHTUP);
                INPUT[] inp = new INPUT[1];
                inp[0].type = INPUT_MOUSE;
                inp[0].U.mi.dwFlags = flag;
                SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
            } catch {}
        }
        heldButtons.Clear();
    }
}
"@

Add-Type -TypeDefinition $code -Language CSharp
[MswnlinkWin32Worker]::InitDpi()

$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
$pipe.Connect(15000)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader($pipe, $utf8NoBom)
$writer = New-Object System.IO.StreamWriter($pipe, $utf8NoBom)
$writer.AutoFlush = $true

$elevated = [MswnlinkWin32Worker]::IsElevated()
$authMsg = @{ event = 'ready'; secret = $Secret; elevated = $elevated } | ConvertTo-Json -Compress
$writer.WriteLine($authMsg)

try {
  while ($pipe.IsConnected) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.op) {
      'move' { [void][MswnlinkWin32Worker]::MovePointer([int]$cmd.x, [int]$cmd.y) }
      'mouse' { [void][MswnlinkWin32Worker]::MouseButton([int]$cmd.button, [bool]$cmd.down) }
      'wheel' { [MswnlinkWin32Worker]::MouseWheel([int]$cmd.dx, [int]$cmd.dy) }
      'key' { [void][MswnlinkWin32Worker]::KeyToggle([uint16]$cmd.vk, [bool]$cmd.extended, [bool]$cmd.down) }
      'text' { [void][MswnlinkWin32Worker]::TypeUnicode([string]$cmd.text) }
      'shortcut' { [void][MswnlinkWin32Worker]::TapCtrlShortcut([uint16]$cmd.vk, [bool]$cmd.shift) }
      'releaseAll' { [MswnlinkWin32Worker]::ReleaseAll() }
      'stop' { [MswnlinkWin32Worker]::ReleaseAll(); break }
    }
  }
} finally {
  try { [MswnlinkWin32Worker]::ReleaseAll() } catch {}
  try { $pipe.Dispose() } catch {}
}
`;

function isProcessElevatedWindows() {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

class WindowsInputBackend {
  constructor({ userDataPath, screen }) {
    this.userDataPath = userDataPath;
    this.screen = screen;
    this.server = null;
    this.socket = null;
    this.proc = null;
    this.elevated = false;
    this.ready = false;
    this.startPromise = null;
    this.scriptPath = path.join(userDataPath, 'mswnlink-win32-worker.ps1');
  }

  isActive() {
    return Boolean(this.ready && this.socket && !this.socket.destroyed);
  }

  async ensureWorkerScript() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await fs.writeFile(this.scriptPath, WORKER_SCRIPT, { encoding: 'utf8', mode: 0o600 });
  }

  async start({ allowElevationPrompt = true } = {}) {
    if (this.isActive()) return { ok: true, elevated: this.elevated };
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      await this.close();
      await this.ensureWorkerScript();

      const alreadyElevated = isProcessElevatedWindows();
      if (alreadyElevated || !allowElevationPrompt) {
        return this.launchPipeSession(false);
      }

      // Request one-time High-Integrity elevation so Task Manager / UAC / admin
      // tools never trigger UIPI cursor freeze. If declined, fall back cleanly
      // to Medium-Integrity worker with UIPI auto-escape.
      try {
        return await this.launchPipeSession(true);
      } catch (error) {
        console.warn('[mswnlink] Elevated Windows input helper declined or unavailable; falling back to standard helper with UIPI guard:', error.message);
        return this.launchPipeSession(false);
      }
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  launchPipeSession(requestElevation) {
    const pipeId = `mswnlink-input-${crypto.randomUUID()}`;
    const pipePath = `\\\\.\\pipe\\${pipeId}`;
    const secret = crypto.randomBytes(32).toString('hex');

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        this.close().catch(() => {});
        finish(new Error('Timed out starting the Windows input helper.'));
      }, requestElevation ? 45000 : 12000);

      const server = net.createServer((client) => {
        if (this.socket) {
          client.destroy();
          return;
        }
        client.setNoDelay(true);
        let buffer = '';
        const onData = (chunk) => {
          buffer += chunk.toString('utf8');
          const newline = buffer.indexOf('\n');
          if (newline < 0) {
            if (buffer.length > 8192) client.destroy();
            return;
          }
          const firstLine = buffer.slice(0, newline).trim();
          client.removeListener('data', onData);
          let handshake = null;
          try { handshake = JSON.parse(firstLine); } catch {}
          if (!handshake || handshake.event !== 'ready' || handshake.secret !== secret) {
            client.destroy();
            finish(new Error('Windows input helper failed authentication.'));
            return;
          }
          this.socket = client;
          this.elevated = Boolean(handshake.elevated);
          this.ready = true;
          client.on('close', () => {
            if (this.socket === client) {
              this.socket = null;
              this.ready = false;
            }
          });
          client.on('error', () => {});
          // Only accept this single authenticated worker connection.
          try { server.close(); } catch {}
          finish(null, { ok: true, elevated: this.elevated });
        };
        client.on('data', onData);
        client.on('error', (err) => finish(err));
      });

      this.server = server;
      server.on('error', (err) => finish(err));

      server.listen(pipePath, () => {
        try {
          if (requestElevation) {
            const escapedScript = this.scriptPath.replace(/'/g, "''");
            const psCommand = [
              "$ErrorActionPreference = 'Stop'",
              `$argList = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${escapedScript}','-PipeName','${pipeId}','-Secret','${secret}')`,
              "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $argList"
            ].join('; ');
            const launcher = spawn('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', psCommand
            ], { stdio: 'ignore', windowsHide: true });
            launcher.on('error', (err) => finish(err));
            launcher.on('exit', (code) => {
              if (code !== 0 && !this.ready) {
                finish(new Error(`UAC elevation was cancelled or failed (exit ${code}).`));
              }
            });
          } else {
            const worker = spawn('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
              '-File', this.scriptPath, '-PipeName', pipeId, '-Secret', secret
            ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
            this.proc = worker;
            worker.stderr.on('data', (chunk) => {
              const msg = chunk.toString('utf8').trim();
              if (msg) console.warn('[mswnlink win32-input]', msg);
            });
            worker.on('error', (err) => finish(err));
            worker.on('exit', (code) => {
              if (this.proc === worker) this.proc = null;
              if (!settled) finish(new Error(`Windows input worker exited early (${code}).`));
            });
          }
        } catch (err) {
          finish(err);
        }
      });
    });
  }

  send(payload) {
    if (!this.isActive()) return false;
    try {
      this.socket.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  resolveScreenPoint(x, y, displayId) {
    const displays = this.screen.getAllDisplays();
    const target = (typeof displayId === 'string' && displayId)
      ? displays.find(item => String(item.id) === displayId) || this.screen.getPrimaryDisplay()
      : this.screen.getPrimaryDisplay();
    const scale = Number(target && target.scaleFactor) > 0 ? Number(target.scaleFactor) : 1;
    const bounds = target ? target.bounds : { x: 0, y: 0, width: 1920, height: 1080 };
    // Electron's screen.getAllDisplays() reports DIPs; convert to physical pixels
    // matching our Per-Monitor DPI-Aware v2 worker.
    let physBounds = null;
    if (typeof this.screen.dipToScreenPoint === 'function') {
      try {
        const topLeft = this.screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
        const bottomRight = this.screen.dipToScreenPoint({
          x: bounds.x + Math.max(0, bounds.width - 1),
          y: bounds.y + Math.max(0, bounds.height - 1)
        });
        physBounds = {
          x: topLeft.x,
          y: topLeft.y,
          width: Math.max(1, bottomRight.x - topLeft.x + 1),
          height: Math.max(1, bottomRight.y - topLeft.y + 1)
        };
      } catch {}
    }
    if (!physBounds) {
      physBounds = {
        x: Math.round(bounds.x * scale),
        y: Math.round(bounds.y * scale),
        width: Math.max(1, Math.round(bounds.width * scale)),
        height: Math.max(1, Math.round(bounds.height * scale))
      };
    }
    return {
      x: Math.round(physBounds.x + x * Math.max(0, physBounds.width - 1)),
      y: Math.round(physBounds.y + y * Math.max(0, physBounds.height - 1))
    };
  }

  inject(event) {
    if (!this.isActive()) return { ok: false, reason: 'Windows input helper is not connected.' };
    if (event.kind === 'releaseAll') {
      this.send({ op: 'releaseAll' });
      return { ok: true };
    }
    if (event.kind === 'move') {
      const x = Math.max(0, Math.min(1, Number(event.x)));
      const y = Math.max(0, Math.min(1, Number(event.y)));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
      const pt = this.resolveScreenPoint(x, y, event.displayId);
      return { ok: this.send({ op: 'move', x: pt.x, y: pt.y }) };
    }
    if (event.kind === 'mouse') {
      const btn = Number(event.button);
      if (![0, 1, 2].includes(btn)) return { ok: false };
      if (event.action !== 'down' && event.action !== 'up') return { ok: false };
      return { ok: this.send({ op: 'mouse', button: btn, down: event.action === 'down' }) };
    }
    if (event.kind === 'wheel') {
      // Browser wheel ~100px = 1 Win32 notch (120 WHEEL_DELTA). Invert dy to match Win32 scroll up=+120.
      const rawDx = Math.max(-600, Math.min(600, Number(event.dx) || 0));
      const rawDy = Math.max(-600, Math.min(600, Number(event.dy) || 0));
      const winDx = Math.round((rawDx / 100) * 120);
      const winDy = Math.round((-rawDy / 100) * 120);
      if (winDx || winDy) this.send({ op: 'wheel', dx: winDx, dy: winDy });
      return { ok: true };
    }
    if (event.kind === 'shortcut') {
      const desc = shortcutDescriptorForPlatform(String(event.action || ''), 'win32');
      if (!desc) return { ok: false, reason: 'Unsupported shortcut.' };
      return {
        ok: this.send({
          op: 'shortcut',
          vk: desc.vk,
          shift: desc.modifiers.includes('shift')
        })
      };
    }
    if (event.kind === 'key') {
      if (event.textInput === true) {
        if (event.action === 'down') {
          const text = String(event.key || '');
          if (!text || /[\u0000-\u001f\u007f]/.test(text)) return { ok: false };
          return { ok: this.send({ op: 'text', text: text.slice(0, 8) }) };
        }
        return { ok: true };
      }
      const mapped = mapWin32VirtualKey(event);
      if (!mapped) return { ok: false, reason: `Unsupported keyboard key (${String(event.code || event.key || 'unknown')}).` };
      if (event.action !== 'down' && event.action !== 'up') return { ok: false };
      return {
        ok: this.send({
          op: 'key',
          vk: mapped.vk,
          extended: Boolean(mapped.extended),
          down: event.action === 'down'
        })
      };
    }
    return { ok: false, reason: 'Unknown input event.' };
  }

  releaseAll() {
    this.send({ op: 'releaseAll' });
  }

  async close() {
    if (this.isActive()) {
      try { this.socket.write(`${JSON.stringify({ op: 'stop' })}\n`); } catch {}
    }
    const sock = this.socket;
    this.socket = null;
    this.ready = false;
    this.elevated = false;
    if (sock) { try { sock.destroy(); } catch {} }
    const srv = this.server;
    this.server = null;
    if (srv) { try { srv.close(); } catch {} }
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill(); } catch {} }
  }
}

module.exports = WindowsInputBackend;
module.exports.isProcessElevatedWindows = isProcessElevatedWindows;
module.exports.WORKER_SCRIPT = WORKER_SCRIPT;

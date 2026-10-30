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

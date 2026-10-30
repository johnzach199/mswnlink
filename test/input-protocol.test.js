'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inputProtocol = require('../lib/input-protocol');
const win32Backend = require('../win32-input');

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

test('RobotJS modifier preservation and non-Latin / ScrollLock safety', () => {
  assert.equal(inputProtocol.mapRobotKey({ code: 'KeyV', key: 'ω' }, 'darwin'), 'v');
  assert.equal(inputProtocol.mapRobotKey({ code: 'ScrollLock', key: 'ScrollLock' }, 'win32'), null);
  assert.deepEqual(inputProtocol.mapWin32VirtualKey({ code: 'ScrollLock', key: 'ScrollLock' }), {
    vk: 0x91,
    extended: false
  });

  const mods = inputProtocol.buildRobotModifiers(new Set(['command', 'shift']), {
    metaKey: true,
    shiftKey: true
  });
  assert.deepEqual(mods.sort(), ['command', 'shift']);
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

test('Windows SendInput worker C# source and macOS plist files are valid', () => {
  assert.equal(typeof win32Backend.WORKER_SCRIPT, 'string');
  assert.match(win32Backend.WORKER_SCRIPT, /public static class MswnlinkWin32Worker/);
  assert.match(win32Backend.WORKER_SCRIPT, /Shell_TrayWnd/);

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

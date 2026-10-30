'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const pages = {
  connect: $('#page-connect'),
  share: $('#page-share'),
  session: $('#page-session')
};

let deviceInfo = { name: 'This device', platform: 'unknown', ips: [], inputAvailable: false };
let persistentAccessCode = '';
let accessCodeConfigured = false;
let accessCodeStorageWarning = '';
let unattendedAccessEnabled = false;
let inputErrorToastShown = false;
let activeShareQuality = 'balanced';
const SHARE_PROFILES = {
  balanced: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, maxBitrate: 8000000, maxFramerate: 30 },
  smooth: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, maxBitrate: 12000000, maxFramerate: 60 },
  sharp: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 2560, max: 2560 }, height: { ideal: 1440, max: 1440 }, maxBitrate: 16000000, maxFramerate: 30 }
};
let sources = [];
let selectedSourceId = null;
let sourceLoadError = '';
let sharingStream = null;
let hostInfo = null;
let hostPeer = null;
let hostRemoteCandidates = [];
let clientSocket = null;
let clientPeer = null;
let clientChannel = null;
let clientRemoteCandidates = [];
let clientConnecting = false;
let requestAccepted = false;
let clientConnected = false;
let controlGranted = false;
let clientUnattended = false;
let hostPeerDetails = null;
let hostControlAllowed = false;
let clientAddress = '';
let clientPairKey = '';
let clientNonce = null;
let clientName = 'Remote desktop';
let lastPointerSend = 0;
let toastTimeout = null;
let connectTimeout = null;
let hostDataChannel = null;
let localFeaturePreferences = { clipboard: false, fileTransfer: false, monitorSwitching: false };
let remoteFeaturePreferences = { clipboard: false, fileTransfer: false, monitorSwitching: false };
const incomingFileTransfers = new Map();
const incomingFileQueues = new Map();
let activeCompositeCapture = null;
let lastCompositeDisplayId = null;
const ALL_DISPLAY_ID = '__all_displays__';
const pendingFileTransfers = new Map();
const pendingClipboardRequests = new Map();
const clipboardBaselineByChannel = new WeakMap();
const CLIPBOARD_SYNC_INTERVAL_MS = 180;
const CLIPBOARD_SYNC_MAX_CHARS = 1_000_000;
const CLIPBOARD_FRAGMENT_CHARS = 4500;
const incomingClipboardFragments = new Map();
let clipboardSyncTimer = null;
let clipboardSyncInFlight = false;
let videoWatchdogTimer = null;
let videoWatchdogGeneration = 0;
let lastRemoteVideoFrameAt = 0;
let clientDisconnectTimer = null;
const pressedRemoteButtons = new Set();
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
const FILE_CHUNK_BYTES = 64 * 1024;
let remoteDisplays = [];
let adaptiveQualityTimer = null;
let adaptiveQualityInFlight = false;
let previousInboundVideoStats = null;
let lastAutoQualityProfile = '';

const THEME_STORAGE_KEY = 'mswnlink.ui-theme';

function applyTheme(theme, persist = false) {
  const nextTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = nextTheme;
  document.body.dataset.theme = nextTheme;
  const dark = nextTheme === 'dark';
  const button = $('#theme-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  const label = $('#theme-toggle-label');
  if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
  const icon = $('#theme-toggle-icon');
  if (icon) icon.textContent = dark ? '☀' : '☾';
  document.documentElement.style.colorScheme = nextTheme;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme); }
    catch (error) { console.warn('[mswnlink] Could not persist theme preference:', error); }
  }
}

function initializeTheme() {
  // theme-init.js already chose the saved theme (or the system one) before first paint.
  let savedTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') savedTheme = saved;
  } catch (error) {
    console.warn('[mswnlink] Could not read theme preference:', error);
  }
  applyTheme(savedTheme);
  const button = $('#theme-toggle');
  if (button) {
    button.addEventListener('click', () => {
      const current = document.body.dataset.theme === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
    });
  }
}

function setPage(name, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(pages, name)) {
    console.warn(`[mswnlink] Ignoring unknown page: ${String(name)}`);
    return false;
  }

  Object.entries(pages).forEach(([key, page]) => {
    const active = key === name;
    // Update both the class and the native hidden state. The class drives the
    // transition styling; hidden/aria-hidden keep the result deterministic if
    // other responsive CSS or an early init error affects layout.
    page.classList.toggle('page-active', active);
    page.hidden = !active;
    page.setAttribute('aria-hidden', String(!active));
  });
  $$('.tab[data-page]').forEach((button) => {
    const active = button.dataset.page === (name === 'session' ? 'connect' : name);
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.body.dataset.currentPage = name;
  if (name === 'share' && options.refreshSources !== false) {
    // Navigation must not fail merely because screen-source enumeration is
    // unavailable (e.g. before a portal permission prompt on Linux).
    Promise.resolve().then(() => refreshSources()).catch((error) => {
      console.warn('[mswnlink] Could not refresh share sources after navigation:', error);
    });
  }
  return true;
}

function initializePageNavigation() {
  // Bind navigation synchronously before initialize() awaits IPC settings.
  // Otherwise a slow/missing OS permission API can leave the initial Connect
  // page visible but the Share this PC button inert.
  for (const button of $$('[data-page]')) {
    if (button.dataset.navigationBound === 'true') continue;
    button.dataset.navigationBound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const pageName = button.dataset.page;
      if (!Object.prototype.hasOwnProperty.call(pages, pageName)) return;
      if (clientConnected && pages.session.classList.contains('page-active') && pageName !== 'session') {
        showToast('End the active remote session before leaving the viewer.');
        return;
      }
      setPage(pageName);
    });
  }
}

function setSessionState(label, kind = '') {
  const pill = $('#session-state');
  pill.className = `status-pill${kind ? ` ${kind}` : ''}`;
  pill.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  pill.append(dot, document.createTextNode(label));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function showConnectError(message) {
  const element = $('#connect-error');
  element.textContent = message;
  element.hidden = !message;
}

function showShareError(message) {
  const element = $('#share-error');
  element.textContent = message;
  element.hidden = !message;
}

function setAccessCodeStatus(message, kind = '') {
  const element = $('#access-code-status');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('status-error', kind === 'error');
  element.classList.toggle('status-success', kind === 'success');
  element.classList.toggle('status-warning', kind === 'warning');
}

function refreshAccessCodeUI() {
  const placeholderTitle = $('#pairing-placeholder strong');
  const placeholderCopy = $('#pairing-placeholder span');
  if (accessCodeConfigured) {
    placeholderTitle.textContent = 'Access code saved';
    placeholderCopy.textContent = 'Start sharing to see this PC’s address and your code.';
  } else {
    placeholderTitle.textContent = 'Set your access code';
    placeholderCopy.textContent = 'Choose a code below before you start sharing. It stays saved until you change it.';
  }
  $('#save-access-code').textContent = accessCodeConfigured ? 'Update code' : 'Save code';
}

function describeScreenCaptureError(error) {
  const detail = error && error.message ? error.message : String(error || 'Unknown error');
  if (deviceInfo.platform === 'linux' && deviceInfo.waylandSession) {
    return `Linux screen capture failed in this Wayland session. The source launcher now tries XWayland automatically. If you opened a packaged build, try launching it with --ozone-platform=x11; if that still fails, check XWayland, PipeWire, and your desktop's xdg-desktop-portal backend. Details: ${detail}`;
  }
  if (deviceInfo.platform === 'linux') {
    return `Linux could not access a screen source. Check screen-capture permissions and desktop services. Details: ${detail}`;
  }
  return `Could not start screen sharing. Check screen-recording permissions. Details: ${detail}`;
}

function friendlyDeviceName(value) {
  const input = String(value || 'This device').replace(/[<>\u0000-\u001f]/g, '').trim();
  return input.slice(0, 70) || 'This device';
}

function renderDiscoveredDevices(devices = []) {
  const container = $('#discovered-devices');
  if (!container) return;
  container.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'devices-empty';
    empty.textContent = 'No other computers found yet. Open mswnlink on another computer on this network, or type its address above.';
    container.append(empty);
    return;
  }
  for (const device of devices) {
    if (!device || !device.address) continue;
    const card = document.createElement('div');
    card.className = 'discovered-device';
    const icon = document.createElement('div');
    icon.className = 'discovered-device-icon';
    icon.textContent = device.platform === 'darwin' ? 'Mac' : device.platform === 'win32' ? 'Win' : 'PC';
    icon.style.fontSize = '12px';
    icon.style.fontWeight = '700';
    const copy = document.createElement('div');
    copy.className = 'discovered-device-copy';
    const name = document.createElement('strong');
    name.textContent = friendlyDeviceName(device.name);
    const detail = document.createElement('small');
    detail.textContent = `${device.address} · ${device.platform === 'darwin' ? 'macOS' : device.platform === 'win32' ? 'Windows' : device.platform === 'linux' ? 'Linux' : 'Unknown OS'}`;
    const state = document.createElement('small');
    state.className = `discovered-device-state ${device.sharing ? 'sharing' : 'online'}`;
    state.textContent = device.sharing ? 'Sharing now' : 'Online, not sharing';
    copy.append(name, detail, state);
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'button button-primary discovered-device-connect';
    connect.textContent = 'Select';
    connect.disabled = !device.sharing || clientConnected || clientConnecting;
    connect.title = device.sharing ? 'Use this device address' : 'This device is online but has not started sharing';
    connect.addEventListener('click', () => {
      $('#host-address').value = device.address;
      $('#pairing-code').focus();
      showToast(device.sharing ? `Selected ${friendlyDeviceName(device.name)}. Enter its permanent access code.` : `${friendlyDeviceName(device.name)} is online but not sharing yet.`);
    });
    card.append(icon, copy, connect);
    container.append(card);
  }
}

async function refreshDiscoveredDevices() {
  try { renderDiscoveredDevices(await window.lanAPI.discoverDevices()); }
  catch (error) { console.warn('[mswnlink] LAN device discovery failed:', error.message || error); }
}

function activeChannels() {
  return [hostDataChannel, clientChannel].filter(channel => channel && channel.readyState === 'open');
}

function sendChannelMessage(channel, object) {
  if (!channel || channel.readyState !== 'open') return false;
  try { channel.send(JSON.stringify(object)); return true; }
  catch (error) { console.warn('[mswnlink] Could not send session data:', error.message || error); return false; }
}

function sendLocalFeatureHello(channel) {
  return sendChannelMessage(channel, {
    kind: 'mswnlink-hello', version: 1,
    features: { ...localFeaturePreferences },
    displays: true
  });
}

function broadcastLocalFeatureHello() {
  for (const channel of activeChannels()) sendLocalFeatureHello(channel);
  updateSessionFeatureUI();
}

function updateSessionFeatureUI() {
  const connected = clientConnected && clientChannel && clientChannel.readyState === 'open';
  const clipboardEnabled = Boolean(localFeaturePreferences.clipboard);
  const fileEnabled = Boolean(localFeaturePreferences.fileTransfer);
  const monitorEnabled = Boolean(localFeaturePreferences.monitorSwitching);
  if ($('#clipboard-sharing-toggle')) $('#clipboard-sharing-toggle').checked = clipboardEnabled;
  if ($('#file-transfer-toggle')) $('#file-transfer-toggle').checked = fileEnabled;
  if ($('#monitor-switching-toggle')) $('#monitor-switching-toggle').checked = monitorEnabled;
  if ($('#session-clipboard-toggle')) $('#session-clipboard-toggle').checked = clipboardEnabled;
  if ($('#session-file-toggle')) $('#session-file-toggle').checked = fileEnabled;
  if ($('#session-monitor-toggle')) $('#session-monitor-toggle').checked = monitorEnabled;
  if ($('#send-clipboard-button')) $('#send-clipboard-button').disabled = !connected || !clipboardEnabled || !remoteFeaturePreferences.clipboard;
  if ($('#get-clipboard-button')) $('#get-clipboard-button').disabled = !connected || !remoteFeaturePreferences.clipboard || !clipboardEnabled;
  if ($('#send-file-button')) $('#send-file-button').disabled = !connected || !fileEnabled || !remoteFeaturePreferences.fileTransfer;
  if ($('#viewer-monitor-select')) $('#viewer-monitor-select').disabled = !connected || !monitorEnabled || !remoteFeaturePreferences.monitorSwitching || !remoteDisplays.length;
  const hostChannelOpen = Boolean(hostDataChannel && hostDataChannel.readyState === 'open' && hostPeerDetails);
  if ($('#host-send-clipboard-button')) $('#host-send-clipboard-button').disabled = !hostChannelOpen || !clipboardEnabled || !remoteFeaturePreferences.clipboard;
  if ($('#host-get-clipboard-button')) $('#host-get-clipboard-button').disabled = !hostChannelOpen || !remoteFeaturePreferences.clipboard || !clipboardEnabled;
  if ($('#host-send-file-button')) $('#host-send-file-button').disabled = !hostChannelOpen || !fileEnabled || !remoteFeaturePreferences.fileTransfer;
  if ($('#viewer-quality-select')) $('#viewer-quality-select').disabled = !connected;
  const status = $('#transfer-status');
  if (status && !status.dataset.busy) {
    if (clipboardEnabled && remoteFeaturePreferences.clipboard) {
      status.textContent = fileEnabled && remoteFeaturePreferences.fileTransfer
        ? 'Live clipboard sync active · files ready. Copy and paste normally on either PC.'
        : 'Live clipboard sync active · copy and paste normally on either PC.';
    } else if (fileEnabled && remoteFeaturePreferences.fileTransfer) {
      status.textContent = 'File transfer ready. Enable live clipboard sync on both devices for instant copy/paste.';
    } else {
      status.textContent = 'Live clipboard sync is off on one or both devices. Enable it on both to copy/paste normally.';
    }
  }
  updateShareUI();
}

async function setLocalFeaturePreference(feature, enabled) {
  const result = await window.lanAPI.setLocalFeature(feature, enabled);
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Could not update the feature permission.');
  localFeaturePreferences = { ...localFeaturePreferences, ...result.features };
  broadcastLocalFeatureHello();
  if (feature === 'clipboard' && enabled) {
    for (const channel of activeChannels()) await primeClipboardBaseline(channel);
  }
  showToast(`${feature === 'clipboard' ? (enabled ? 'Live clipboard sync' : 'Clipboard sync') : feature === 'fileTransfer' ? 'File transfers' : 'Monitor switching'} ${enabled ? 'enabled' : 'disabled'} on this device.`);
}

async function primeClipboardBaseline(channel) {
  if (!channel || channel.readyState !== 'open' || !localFeaturePreferences.clipboard || !remoteFeaturePreferences.clipboard) return;
  try {
    const result = await window.lanAPI.readLocalClipboard();
    if (result && result.ok) clipboardBaselineByChannel.set(channel, String(result.text || '').slice(0, CLIPBOARD_SYNC_MAX_CHARS));
  } catch (error) { console.debug('[mswnlink] Could not prime clipboard sync:', error.message || error); }
}

function splitClipboardText(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + CLIPBOARD_FRAGMENT_CHARS);
    // Do not split a UTF-16 surrogate pair at a fragment boundary.
    if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    if (end <= offset) end = Math.min(text.length, offset + CLIPBOARD_FRAGMENT_CHARS + 1);
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function sendAutomaticClipboard(channel, text) {
  if (!channel || channel.readyState !== 'open') return false;
  if (text.length <= CLIPBOARD_FRAGMENT_CHARS) return sendChannelMessage(channel, { kind: 'clipboard-auto', text });
  const id = crypto.randomUUID();
  const chunks = splitClipboardText(text);
  if (chunks.length > 256) throw new Error('Clipboard text is too large to sync.');
  if (!sendChannelMessage(channel, { kind: 'clipboard-auto-start', id, total: chunks.length, length: text.length })) return false;
  for (let index = 0; index < chunks.length; index += 1) {
    if (channel.readyState !== 'open') return false;
    if (channel.bufferedAmount > 128 * 1024) await waitForChannelBuffer(channel, 512 * 1024);
    if (!sendChannelMessage(channel, { kind: 'clipboard-auto-chunk', id, index, total: chunks.length, text: chunks[index] })) return false;
  }
  return true;
}

function clearClipboardFragments(channel) {
  const pending = incomingClipboardFragments.get(channel);
  if (pending && pending.timer) clearTimeout(pending.timer);
  incomingClipboardFragments.delete(channel);
}

async function applyAutomaticClipboardText(channel, value) {
  if (!localFeaturePreferences.clipboard || !remoteFeaturePreferences.clipboard) return false;
  const text = String(value || '').slice(0, CLIPBOARD_SYNC_MAX_CHARS);
  clipboardBaselineByChannel.set(channel, text);
  const existing = await window.lanAPI.readLocalClipboard();
  if (existing && existing.ok && String(existing.text || '') === text) return true;
  const result = await window.lanAPI.writeLocalClipboard(text);
  if (!result || !result.ok) {
    showToast(result && result.error ? result.error : 'Could not sync clipboard text.');
    return false;
  }
  clipboardBaselineByChannel.set(channel, text);
  return true;
}

async function clipboardSyncTick() {
  if (clipboardSyncInFlight) return;
  const channels = activeChannels().filter(channel => channel.readyState === 'open' && localFeaturePreferences.clipboard && remoteFeaturePreferences.clipboard);
  if (!channels.length) return;
  clipboardSyncInFlight = true;
  try {
    for (const channel of channels) {
      if (channel.bufferedAmount > 512 * 1024) continue;
      const result = await window.lanAPI.readLocalClipboard();
      if (!result || !result.ok) continue;
      const text = String(result.text || '').slice(0, CLIPBOARD_SYNC_MAX_CHARS);
      if (!clipboardBaselineByChannel.has(channel)) {
        clipboardBaselineByChannel.set(channel, text);
        continue; // Don't copy an existing clipboard merely because a session opened.
      }
      if (clipboardBaselineByChannel.get(channel) !== text) {
        if (await sendAutomaticClipboard(channel, text)) clipboardBaselineByChannel.set(channel, text);
      }
    }
  } catch (error) { console.debug('[mswnlink] Live clipboard polling failed:', error.message || error); }
  finally { clipboardSyncInFlight = false; }
}

function startClipboardSyncMonitor() {
  if (clipboardSyncTimer) return;
  clipboardSyncTimer = setInterval(() => { clipboardSyncTick().catch(error => console.debug('[mswnlink] Clipboard monitor error:', error.message || error)); }, CLIPBOARD_SYNC_INTERVAL_MS);
}

function updateRemoteFeaturePreferences(features = {}) {
  remoteFeaturePreferences = {
    clipboard: features.clipboard === true,
    fileTransfer: features.fileTransfer === true,
    monitorSwitching: features.monitorSwitching === true
  };
  updateSessionFeatureUI();
}

function setTransferStatus(message, busy = false) {
  const status = $('#transfer-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.busy = busy ? 'true' : '';
}

function setPendingClipboard(id, mode, channel) {
  const timer = setTimeout(() => {
    pendingClipboardRequests.delete(id);
    showToast('Clipboard request timed out. Check the clipboard permissions on both devices.');
  }, 15000);
  pendingClipboardRequests.set(id, { mode, timer, channel });
}

async function sendLocalClipboard(channel) {
  if (!channel || channel.readyState !== 'open') throw new Error('The remote session is not connected.');
  if (!localFeaturePreferences.clipboard) throw new Error('Enable clipboard sharing on this device first.');
  if (!remoteFeaturePreferences.clipboard) throw new Error('Enable clipboard sharing on the receiving computer first.');
  const result = await window.lanAPI.readLocalClipboard();
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Could not read the local clipboard.');
  const id = crypto.randomUUID();
  setPendingClipboard(id, 'send', channel);
  if (!sendChannelMessage(channel, { kind: 'clipboard-set', id, text: String(result.text || '').slice(0, 200000) })) {
    const pending = pendingClipboardRequests.get(id); if (pending) clearTimeout(pending.timer);
    pendingClipboardRequests.delete(id);
    throw new Error('Could not send clipboard text.');
  }
  showToast('Sending clipboard text to the remote computer…');
}

async function requestRemoteClipboard(channel) {
  if (!channel || channel.readyState !== 'open') throw new Error('The remote session is not connected.');
  if (!localFeaturePreferences.clipboard) throw new Error('Enable Allow clipboard on this device to receive clipboard text.');
  if (!remoteFeaturePreferences.clipboard) throw new Error('Enable clipboard sharing on the remote computer first.');
  const id = crypto.randomUUID();
  setPendingClipboard(id, 'get', channel);
  if (!sendChannelMessage(channel, { kind: 'clipboard-get', id })) {
    const pending = pendingClipboardRequests.get(id); if (pending) clearTimeout(pending.timer);
    pendingClipboardRequests.delete(id);
    throw new Error('Could not request the remote clipboard.');
  }
  showToast('Requesting text from the remote clipboard…');
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}


function failPendingTransfersForChannel(channel, reason = 'The remote session closed.') {
  for (const pending of pendingFileTransfers.values()) {
    if (pending.channel !== channel) continue;
    pending.acceptWaiter.resolve({ ok: false, reason });
    pending.finishWaiter.resolve({ ok: false, reason });
  }
}

function clearPendingClipboardForChannel(channel) {
  for (const [id, pending] of pendingClipboardRequests) {
    if (pending.channel !== channel) continue;
    clearTimeout(pending.timer);
    pendingClipboardRequests.delete(id);
  }
}

function waitForChannelBuffer(channel, maximum = 1024 * 1024) {
  if (channel.bufferedAmount <= maximum) return Promise.resolve();
  channel.bufferedAmountLowThreshold = 512 * 1024;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The network is too slow to continue this file transfer.')); }, 30000);
    const cleanup = () => { clearTimeout(timeout); channel.removeEventListener('bufferedamountlow', onLow); };
    const onLow = () => { if (channel.bufferedAmount <= maximum) { cleanup(); resolve(); } };
    channel.addEventListener('bufferedamountlow', onLow);
    onLow();
  });
}

async function sendFileOverChannel(channel) {
  if (!channel || channel.readyState !== 'open') throw new Error('The remote session is not connected.');
  if (!localFeaturePreferences.fileTransfer) throw new Error('Enable file transfers on this device first.');
  if (!remoteFeaturePreferences.fileTransfer) throw new Error('Enable file transfers on the receiving computer first.');
  const picked = await window.lanAPI.pickFileToSend();
  if (!picked || picked.cancelled) return;
  if (!picked.ok) throw new Error(picked.error || 'Could not read the selected file.');
  if (picked.size > MAX_TRANSFER_BYTES) throw new Error('Files must be 100 MB or smaller.');
  const id = crypto.randomUUID();
  const acceptWaiter = makeDeferred();
  const finishWaiter = makeDeferred();
  const record = { acceptWaiter, finishWaiter, accepted: false, channel };
  pendingFileTransfers.set(id, record);
  let timer = setTimeout(() => acceptWaiter.resolve({ ok: false, reason: 'The receiver did not respond to the file request.' }), 90000);
  setTransferStatus(`Waiting for ${picked.name} to be accepted…`, true);
  if (!sendChannelMessage(channel, { kind: 'file-start', id, name: picked.name, size: picked.size, type: picked.type || 'application/octet-stream' })) {
    clearTimeout(timer); pendingFileTransfers.delete(id); throw new Error('Could not initiate the file transfer.');
  }
  try {
    const acceptance = await acceptWaiter.promise;
    clearTimeout(timer);
    if (!acceptance || !acceptance.ok) throw new Error(acceptance && acceptance.reason ? acceptance.reason : 'The receiver declined the transfer.');
    record.accepted = true;
    const bytes = new Uint8Array(picked.data);
    const total = bytes.byteLength;
    for (let offset = 0; offset < total; offset += FILE_CHUNK_BYTES) {
      await waitForChannelBuffer(channel);
      if (channel.readyState !== 'open') throw new Error('The connection closed during file transfer.');
      const chunk = bytes.slice(offset, Math.min(total, offset + FILE_CHUNK_BYTES));
      channel.send(chunk.buffer);
      setTransferStatus(`Sending ${picked.name} · ${Math.min(total, offset + chunk.length).toLocaleString()} / ${total.toLocaleString()} bytes`, true);
    }
    timer = setTimeout(() => finishWaiter.resolve({ ok: false, reason: 'Timed out waiting for the receiver to finish saving the file.' }), 90000);
    if (!sendChannelMessage(channel, { kind: 'file-end', id })) throw new Error('Could not finish sending the file.');
    const complete = await finishWaiter.promise;
    clearTimeout(timer);
    if (!complete || !complete.ok) throw new Error(complete && complete.reason ? complete.reason : 'The receiver could not save the file.');
    setTransferStatus(`${picked.name} sent successfully.`, false);
    showToast(`Sent ${picked.name} to the remote computer.`);
  } catch (error) {
    clearTimeout(timer);
    setTransferStatus(`File transfer failed: ${error.message || 'unknown error'}`, false);
    throw error;
  } finally {
    pendingFileTransfers.delete(id);
  }
}

async function handleIncomingBinary(channel, payload) {
  const transfer = incomingFileTransfers.get(channel);
  if (!transfer) return;
  try {
    const data = payload instanceof ArrayBuffer ? payload : (ArrayBuffer.isView(payload) ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : (payload && typeof payload.arrayBuffer === 'function' ? await payload.arrayBuffer() : null));
    if (!data) throw new Error('Unsupported file data chunk.');
    const byteLength = data.byteLength;
    if (byteLength > 128 * 1024 || transfer.received + byteLength > transfer.expected) throw new Error('The received file contains an invalid chunk size.');
    const result = await window.lanAPI.writeFileChunk(transfer.token, data);
    if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Could not write the received file.');
    transfer.received += byteLength;
    setTransferStatus(`Receiving ${transfer.name} · ${transfer.received.toLocaleString()} / ${transfer.expected.toLocaleString()} bytes`, true);
  } catch (error) {
    incomingFileTransfers.delete(channel);
    try { await window.lanAPI.abortFileReceive(transfer.token); } catch {}
    sendChannelMessage(channel, { kind: 'file-result', id: transfer.id, ok: false, reason: error.message || 'Failed to save the incoming file.' });
    setTransferStatus(`File receive failed: ${error.message || 'unknown error'}`, false);
  }
}


function queueIncomingBinary(channel, payload) {
  const previous = incomingFileQueues.get(channel) || Promise.resolve();
  const next = previous.then(() => handleIncomingBinary(channel, payload)).catch(error => {
    console.warn('[mswnlink] Incoming file chunk failed:', error.message || error);
  });
  incomingFileQueues.set(channel, next);
  next.finally(() => {
    if (incomingFileQueues.get(channel) === next) incomingFileQueues.delete(channel);
  });
  return next;
}

async function handleSessionDataMessage(side, channel, data) {
  if (!data || typeof data.kind !== 'string') return false;
  if (data.kind === 'mswnlink-hello') {
    updateRemoteFeaturePreferences(data.features || {});
    if (side === 'client' && data.displays) sendChannelMessage(channel, { kind: 'display-list-request' });
    await primeClipboardBaseline(channel);
    return true;
  }
  if (data.kind === 'clipboard-auto') {
    await applyAutomaticClipboardText(channel, String(data.text || ''));
    return true;
  }
  if (data.kind === 'clipboard-auto-start') {
    if (!localFeaturePreferences.clipboard || !remoteFeaturePreferences.clipboard) return true;
    const id = String(data.id || '');
    const total = Number(data.total);
    const length = Number(data.length);
    if (!id || id.length > 100 || !Number.isInteger(total) || total < 1 || total > 256 || !Number.isInteger(length) || length < 0 || length > CLIPBOARD_SYNC_MAX_CHARS) return true;
    clearClipboardFragments(channel);
    const entry = { id, total, length, chunks: new Array(total), received: 0, receivedParts: 0, timer: null };
    entry.timer = setTimeout(() => { clearClipboardFragments(channel); }, 12000);
    incomingClipboardFragments.set(channel, entry);
    return true;
  }
  if (data.kind === 'clipboard-auto-chunk') {
    const pending = incomingClipboardFragments.get(channel);
    if (!pending || pending.id !== String(data.id || '') || Number(data.total) !== pending.total) return true;
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= pending.total || typeof data.text !== 'string') return true;
    if (pending.chunks[index] === undefined) {
      pending.chunks[index] = data.text;
      pending.receivedParts += 1;
      pending.received += data.text.length;
      if (pending.received > pending.length || pending.received > CLIPBOARD_SYNC_MAX_CHARS) { clearClipboardFragments(channel); return true; }
    }
    if (pending.receivedParts === pending.total) {
      const text = pending.chunks.join('');
      const expectedLength = pending.length;
      clearClipboardFragments(channel);
      if (text.length === expectedLength) await applyAutomaticClipboardText(channel, text);
    }
    return true;
  }
  if (data.kind === 'quality-profile' && side === 'host') {
    await applyHostQualityProfile(data.profile);
    sendChannelMessage(channel, { kind: 'quality-profile-result', profile: data.profile, ok: true });
    return true;
  }
  if (data.kind === 'quality-profile-result') return true;
  if (data.kind === 'display-list-request' && side === 'host') {
    const displays = await window.lanAPI.getSources();
    sendChannelMessage(channel, { kind: 'display-list', displays: displays.map(item => ({ id: item.id, name: item.name, displayId: item.displayId || '', bounds: item.bounds || null, scaleFactor: item.scaleFactor || 1 })) });
    return true;
  }
  if (data.kind === 'display-list' && side === 'client') {
    remoteDisplays = Array.isArray(data.displays) ? data.displays.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string').slice(0, 16) : [];
    const select = $('#viewer-monitor-select');
    const selected = select.value;
    select.replaceChildren();
    const current = document.createElement('option'); current.value = ''; current.textContent = 'Shared display'; select.append(current);
    for (const display of remoteDisplays) {
      const option = document.createElement('option'); option.value = display.id; option.textContent = display.name; select.append(option);
    }
    if (remoteDisplays.length > 1) {
      const all = document.createElement('option'); all.value = ALL_DISPLAY_ID; all.textContent = 'All displays · side-by-side'; select.append(all);
    }
    if (remoteDisplays.some(item => item.id === selected) || (remoteDisplays.length > 1 && selected === ALL_DISPLAY_ID)) select.value = selected;
    updateSessionFeatureUI();
    return true;
  }
  if (data.kind === 'display-select' && side === 'host') {
    if (!localFeaturePreferences.monitorSwitching) {
      sendChannelMessage(channel, { kind: 'display-result', ok: false, reason: 'Monitor switching is disabled on the host.' });
      return true;
    }
    try {
      await switchSharedDisplay(String(data.sourceId || ''), channel);
    } catch (error) {
      sendChannelMessage(channel, { kind: 'display-result', ok: false, reason: error.message || 'Could not switch display.' });
      showToast(`Display switch failed: ${error.message || 'unknown error'}`);
    }
    return true;
  }
  if (data.kind === 'display-result' && side === 'client') {
    if (data.ok) showToast(`Switched to ${data.name || 'the selected display'}.`);
    else showToast(data.reason || 'The host could not switch displays.');
    return true;
  }
  if (data.kind === 'clipboard-set') {
    if (!localFeaturePreferences.clipboard) {
      sendChannelMessage(channel, { kind: 'clipboard-result', id: data.id, ok: false, reason: 'Clipboard sharing is disabled on the receiving device.' });
      return true;
    }
    const result = await window.lanAPI.writeLocalClipboard(String(data.text || '').slice(0, 200000));
    sendChannelMessage(channel, { kind: 'clipboard-result', id: data.id, ok: Boolean(result && result.ok), reason: result && result.error ? result.error : '' });
    return true;
  }
  if (data.kind === 'clipboard-get') {
    if (!localFeaturePreferences.clipboard) {
      sendChannelMessage(channel, { kind: 'clipboard-result', id: data.id, ok: false, reason: 'Clipboard sharing is disabled on the remote device.' });
      return true;
    }
    const result = await window.lanAPI.readLocalClipboard();
    if (!result || !result.ok) sendChannelMessage(channel, { kind: 'clipboard-result', id: data.id, ok: false, reason: result && result.error ? result.error : 'Could not read clipboard.' });
    else sendChannelMessage(channel, { kind: 'clipboard-value', id: data.id, text: String(result.text || '').slice(0, 200000) });
    return true;
  }
  if (data.kind === 'clipboard-value') {
    const pending = pendingClipboardRequests.get(String(data.id || ''));
    if (!pending || pending.mode !== 'get') return true;
    clearTimeout(pending.timer); pendingClipboardRequests.delete(String(data.id));
    if (!localFeaturePreferences.clipboard) { showToast('Enable Allow clipboard to receive clipboard text.'); return true; }
    const result = await window.lanAPI.writeLocalClipboard(String(data.text || '').slice(0, 200000));
    if (!result || !result.ok) showToast(result && result.error ? result.error : 'Could not update the local clipboard.');
    else showToast('Remote clipboard copied to this device.');
    return true;
  }
  if (data.kind === 'clipboard-result') {
    const pending = pendingClipboardRequests.get(String(data.id || ''));
    if (pending) { clearTimeout(pending.timer); pendingClipboardRequests.delete(String(data.id)); }
    if (!data.ok) showToast(data.reason || 'Clipboard operation failed.');
    else showToast(pending && pending.mode === 'send' ? 'Clipboard sent to the remote device.' : 'Clipboard operation completed.');
    return true;
  }
  if (data.kind === 'file-start') {
    const id = String(data.id || '');
    const size = Number(data.size);
    if (!id || !Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_BYTES || typeof data.name !== 'string') {
      sendChannelMessage(channel, { kind: 'file-result', id, ok: false, reason: 'Invalid file transfer request.' });
      return true;
    }
    if (!localFeaturePreferences.fileTransfer) {
      sendChannelMessage(channel, { kind: 'file-result', id, ok: false, reason: 'File transfers are disabled on the receiving device.' });
      return true;
    }
    if (incomingFileTransfers.has(channel)) {
      sendChannelMessage(channel, { kind: 'file-result', id, ok: false, reason: 'Another file transfer is already active.' });
      return true;
    }
    const result = await window.lanAPI.beginFileReceive({ name: data.name, size });
    if (!result || !result.ok) {
      sendChannelMessage(channel, { kind: 'file-result', id, ok: false, reason: result && result.cancelled ? 'File transfer cancelled by the receiver.' : (result && result.error ? result.error : 'The receiver declined the file.') });
      return true;
    }
    incomingFileTransfers.set(channel, { id, token: result.token, name: data.name, expected: size, received: 0 });
    sendChannelMessage(channel, { kind: 'file-accept', id, ok: true });
    setTransferStatus(`Receiving ${data.name} · 0 / ${size.toLocaleString()} bytes`, true);
    return true;
  }
  if (data.kind === 'file-accept') {
    const pending = pendingFileTransfers.get(String(data.id || ''));
    if (pending) pending.acceptWaiter.resolve({ ok: true });
    return true;
  }
  if (data.kind === 'file-result') {
    const pending = pendingFileTransfers.get(String(data.id || ''));
    if (pending) {
      if (!pending.accepted) pending.acceptWaiter.resolve({ ok: false, reason: data.reason || 'The receiver rejected the file.' });
      else pending.finishWaiter.resolve({ ok: Boolean(data.ok), reason: data.reason || '' });
    }
    return true;
  }
  if (data.kind === 'file-end') {
    // Ordered data-channel messages can arrive while earlier chunk writes are still
    // awaiting IPC to the main process. Finish only after those writes have settled.
    const queuedChunks = incomingFileQueues.get(channel);
    if (queuedChunks) await queuedChunks;
    const transfer = incomingFileTransfers.get(channel);
    if (!transfer || transfer.id !== data.id) {
      sendChannelMessage(channel, { kind: 'file-result', id: data.id, ok: false, reason: 'No matching file transfer was open.' });
      return true;
    }
    incomingFileTransfers.delete(channel);
    const result = await window.lanAPI.finishFileReceive(transfer.token);
    sendChannelMessage(channel, { kind: 'file-result', id: transfer.id, ok: Boolean(result && result.ok), reason: result && result.error ? result.error : '' });
    setTransferStatus(result && result.ok ? `Received ${transfer.name} successfully.` : `Could not save ${transfer.name}: ${result && result.error ? result.error : 'unknown error'}`, false);
    if (result && result.ok) showToast(`Received ${transfer.name}.`);
    return true;
  }
  return false;
}

async function captureDesktopSource(sourceId, profile) {
  // Electron exposes screen source IDs specifically for desktop-capture getUserMedia.
  // This path lets an already-authorized host switch source without needing a second
  // user-gesture screen picker while a remote session is in progress.
  const width = Number(profile.width && (profile.width.max || profile.width.ideal)) || 1920;
  const height = Number(profile.height && (profile.height.max || profile.height.ideal)) || 1080;
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: Number(profile.maxFramerate) || 30
      }
    }
  });
}

async function createAllDisplaysComposite(displays, profile) {
  if (!Array.isArray(displays) || displays.length < 2) {
    throw new Error('This system exposes only one capturable desktop source. Select that display instead. On Linux with PipeWire, Electron may expose one combined screen source.');
  }
  if (displays.length > 6) throw new Error('All-displays mode currently supports up to six displays. Choose one display instead.');
  const streams = [];
  const videos = [];
  let animationFrame = 0;
  let stopped = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) throw new Error('Could not create the all-displays compositor.');
  const cleanup = () => {
    stopped = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    for (const stream of streams) stream.getTracks().forEach(track => { try { track.stop(); } catch {} });
    for (const video of videos) { try { video.pause(); video.srcObject = null; video.remove(); } catch {} }
  };
  try {
    for (const source of displays) {
      const stream = await captureDesktopSource(source.id, profile);
      streams.push(stream);
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none';
      video.srcObject = stream;
      document.body.append(video);
      videos.push(video);
      await new Promise((resolve, reject) => {
        if (video.readyState >= 1 && video.videoWidth > 0) {
          video.play().then(resolve).catch(reject);
          return;
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out opening ${source.name}.`)); }, 12000);
        video.onloadedmetadata = () => { clearTimeout(timer); video.play().then(resolve).catch(reject); };
        video.onerror = () => { clearTimeout(timer); reject(new Error(`Could not open ${source.name}.`)); };
      });
    }
    const widths = videos.map(video => Math.max(1, video.videoWidth));
    const heights = videos.map(video => Math.max(1, video.videoHeight));
    const totalWidth = widths.reduce((sum, value) => sum + value, 0);
    const maximumHeight = Math.max(...heights);
    const scale = Math.min(1, 7680 / totalWidth, 4320 / maximumHeight);
    canvas.width = Math.max(1, Math.floor(totalWidth * scale));
    canvas.height = Math.max(1, Math.floor(maximumHeight * scale));
    const positions = [];
    let x = 0;
    videos.forEach((video, index) => {
      const w = Math.floor(widths[index] * scale);
      const h = Math.floor(heights[index] * scale);
      positions.push({ video, source: displays[index], x, y: Math.floor((canvas.height - h) / 2), w, h });
      x += w;
    });
    const targetFps = Math.max(15, Math.min(60, Number(profile.maxFramerate) || 30));
    const frameInterval = 1000 / targetFps;
    let lastDrawAt = 0;
    const draw = (timestamp = performance.now()) => {
      if (stopped) return;
      // A display compositor running at the monitor's full refresh rate can peg
      // a CPU for minutes in fullscreen. Cap it to the selected capture profile.
      if (timestamp - lastDrawAt >= frameInterval) {
        lastDrawAt = timestamp;
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (const item of positions) {
          if (item.video.readyState >= 2) {
            try { ctx.drawImage(item.video, item.x, item.y, item.w, item.h); } catch {}
          }
        }
      }
      animationFrame = requestAnimationFrame(draw);
    };
    draw();
    const composite = canvas.captureStream(Number(profile.maxFramerate) || 30);
    composite.getVideoTracks().forEach(track => { try { track.contentHint = 'detail'; } catch {} });
    const sourceEnded = () => {
      if (!stopped && activeCompositeCapture && activeCompositeCapture.cleanup === cleanup && hostInfo) {
        showToast('A display in the all-displays capture ended. Stop sharing and start again if needed.');
      }
    };
    for (const stream of streams) for (const track of stream.getTracks()) track.addEventListener('ended', sourceEnded, { once: true });
    return {
      stream: composite, cleanup, name: 'All displays (side-by-side)',
      layout: { width: canvas.width, height: canvas.height, panels: positions.map(item => ({
        x: item.x, y: item.y, w: item.w, h: item.h, sourceId: item.source.id,
        displayId: item.source.displayId || '', name: item.source.name
      })) }
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}


function mapCompositePointerInput(data) {
  const layout = activeCompositeCapture && activeCompositeCapture.layout;
  if (!layout || !Array.isArray(layout.panels) || !layout.panels.length || data.kind !== 'move') return { ...data };
  const px = Math.max(0, Math.min(1, Number(data.x))) * layout.width;
  const py = Math.max(0, Math.min(1, Number(data.y))) * layout.height;
  const panel = layout.panels.find(item => px >= item.x && px < item.x + item.w && py >= item.y && py < item.y + item.h);
  if (!panel) return null; // Black letterbox area between unequal-height displays.
  lastCompositeDisplayId = panel.displayId || '';
  return {
    ...data,
    x: Math.max(0, Math.min(1, (px - panel.x) / Math.max(1, panel.w))),
    y: Math.max(0, Math.min(1, (py - panel.y) / Math.max(1, panel.h))),
    displayId: panel.displayId || ''
  };
}

async function switchSharedDisplay(sourceId, channel) {
  if (!hostPeer || !sharingStream) throw new Error('A live host session is required to switch displays.');
  const profile = SHARE_PROFILES[activeShareQuality] || SHARE_PROFILES.balanced;
  let replacement = null;
  let nextComposite = null;
  let displayName = '';
  try {
    if (sourceId === ALL_DISPLAY_ID) {
      const displays = await window.lanAPI.getSources();
      const result = await createAllDisplaysComposite(displays, profile);
      replacement = result.stream;
      nextComposite = { cleanup: result.cleanup, layout: result.layout };
      displayName = result.name;
    } else {
      const display = (await window.lanAPI.getSources()).find(item => item.id === sourceId);
      if (!display) throw new Error('That display is no longer available. Refresh the display list and try again.');
      replacement = await captureDesktopSource(sourceId, profile);
      displayName = display.name;
    }
    const track = replacement.getVideoTracks()[0];
    const sender = hostPeer.getSenders().find(item => item.track && item.track.kind === 'video');
    if (!track || !sender) throw new Error('Could not replace the shared video track.');
    try { track.contentHint = 'detail'; } catch {}
    await sender.replaceTrack(track);
    const oldStream = sharingStream;
    const oldComposite = activeCompositeCapture;
    sharingStream = replacement;
    activeCompositeCapture = nextComposite;
    lastCompositeDisplayId = null;
    selectedSourceId = sourceId;
    track.addEventListener('ended', () => { if (sharingStream === replacement && hostInfo) stopSharing(true); }, { once: true });
    oldStream.getTracks().forEach(oldTrack => { try { oldTrack.stop(); } catch {} });
    if (oldComposite && typeof oldComposite.cleanup === 'function') oldComposite.cleanup();
    sendChannelMessage(channel, { kind: 'display-result', ok: true, name: displayName });
    showToast(`Now sharing ${displayName}.`);
  } catch (error) {
    if (replacement) replacement.getTracks().forEach(track => { try { track.stop(); } catch {} });
    if (nextComposite && typeof nextComposite.cleanup === 'function') nextComposite.cleanup();
    throw new Error(`Could not switch display. ${error.message || 'Check screen-capture permissions.'}`.trim());
  }
}

async function applyHostQualityProfile(key) {
  const profile = SHARE_PROFILES[key];
  if (!profile || !sharingStream) throw new Error('Unknown quality profile or no shared screen.');
  activeShareQuality = key;
  const track = sharingStream.getVideoTracks()[0];
  if (track && typeof track.applyConstraints === 'function') {
    try { await track.applyConstraints({ frameRate: profile.frameRate, width: profile.width, height: profile.height }); }
    catch (error) { console.debug('[mswnlink] Capture device kept its native resolution:', error.message); }
  }
  const sender = hostPeer && hostPeer.getSenders().find(item => item.track && item.track.kind === 'video');
  if (sender && typeof sender.getParameters === 'function') {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || !parameters.encodings.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = profile.maxBitrate;
      parameters.encodings[0].maxFramerate = profile.maxFramerate;
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
    } catch (error) { console.debug('[mswnlink] Could not update sender bitrate:', error.message); }
  }
  return true;
}

function startAdaptiveQualityMonitor() {
  stopAdaptiveQualityMonitor();
  previousInboundVideoStats = null;
  lastAutoQualityProfile = '';
  adaptiveQualityTimer = setInterval(async () => {
    if (adaptiveQualityInFlight || !clientPeer || !clientConnected || $('#viewer-quality-select').value !== 'auto') return;
    adaptiveQualityInFlight = true;
    try {
      const stats = await clientPeer.getStats();
      let video = null;
      let rtt = 0;
      for (const stat of stats.values()) {
        if (stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video')) video = stat;
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.selected || stat.nominated) && Number(stat.currentRoundTripTime) > 0) rtt = Number(stat.currentRoundTripTime);
      }
      if (!video) return;
      if (!previousInboundVideoStats) {
        previousInboundVideoStats = { lost: Number(video.packetsLost || 0), received: Number(video.packetsReceived || 0) };
        return;
      }
      const lostNow = Number(video.packetsLost || 0);
      const receivedNow = Number(video.packetsReceived || 0);
      const lost = Math.max(0, lostNow - previousInboundVideoStats.lost);
      const received = Math.max(0, receivedNow - previousInboundVideoStats.received);
      previousInboundVideoStats = { lost: lostNow, received: receivedNow };
      const lossRate = lost / Math.max(1, lost + received);
      const next = lossRate > 0.04 || rtt > 0.12 ? 'balanced' : (lossRate < 0.01 && rtt < 0.045 ? 'smooth' : 'balanced');
      if (next !== lastAutoQualityProfile) {
        lastAutoQualityProfile = next;
        sendChannelMessage(clientChannel, { kind: 'quality-profile', profile: next });
      }
    } catch (error) { console.debug('[mswnlink] Auto quality stats are temporarily unavailable:', error.message); }
    finally { adaptiveQualityInFlight = false; }
  }, 3000);
  if (adaptiveQualityTimer && adaptiveQualityTimer.unref) adaptiveQualityTimer.unref();
}

function stopAdaptiveQualityMonitor() {
  if (adaptiveQualityTimer) clearInterval(adaptiveQualityTimer);
  adaptiveQualityTimer = null;
  previousInboundVideoStats = null;
}

function setViewerQuality(profile) {
  if (profile === 'auto') { startAdaptiveQualityMonitor(); return; }
  stopAdaptiveQualityMonitor();
  if (SHARE_PROFILES[profile]) sendChannelMessage(clientChannel, { kind: 'quality-profile', profile });
}


async function refreshSources() {
  sourceLoadError = '';
  const grid = $('#source-grid');
  if (!grid) {
    console.warn('[mswnlink] Share source grid is missing from index.html.');
    return;
  }
  grid.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'source-loading';
  loading.innerHTML = '<span class="spinner"></span> Looking for displays…';
  grid.append(loading);
  try {
    sources = await window.lanAPI.getSources();
    grid.replaceChildren();
    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'source-loading';
      empty.textContent = 'No displays found. Check screen-recording permissions and refresh this page.';
      grid.append(empty);
      return;
    }
    if (!selectedSourceId || !sources.some(source => source.id === selectedSourceId)) selectedSourceId = sources[0].id;
    for (const source of sources) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `source-card${source.id === selectedSourceId ? ' selected' : ''}`;
      card.setAttribute('aria-pressed', source.id === selectedSourceId ? 'true' : 'false');
      const image = document.createElement('img');
      image.className = 'source-thumb';
      image.alt = '';
      if (source.thumbnail) image.src = source.thumbnail;
      const meta = document.createElement('div');
      meta.className = 'source-meta';
      const name = document.createElement('strong');
      name.textContent = source.name;
      const radio = document.createElement('span');
      radio.className = 'source-radio';
      meta.append(name, radio);
      card.append(image, meta);
      card.addEventListener('click', async () => {
        if (sharingStream) return;
        selectedSourceId = source.id;
        const ok = await window.lanAPI.chooseSource(source.id);
        if (!ok) showToast('Could not select this display. Refresh the display list and try again.');
        $$('.source-card').forEach(item => {
          const selected = item === card;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
      });
      grid.append(card);
    }
    await window.lanAPI.chooseSource(selectedSourceId);
    if (deviceInfo.platform === 'darwin' && (deviceInfo.macScreenAccess === 'denied' || deviceInfo.macScreenAccess === 'restricted')) {
      showShareError('macOS is blocking screen recording for mswnlink. Open System Settings › Privacy & Security › Screen & System Audio Recording, turn on mswnlink, then restart the app.');
    }
  } catch (error) {
    sources = [];
    selectedSourceId = null;
    sourceLoadError = describeScreenCaptureError(error);
    grid.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'source-loading';
    empty.textContent = sourceLoadError;
    grid.append(empty);
  }
}

function updateShareUI() {
  const active = Boolean(hostInfo && sharingStream);
  $('#share-status-pill').classList.toggle('active', active);
  $('#share-status-pill').replaceChildren(Object.assign(document.createElement('span'), { className: 'status-dot' }), document.createTextNode(active ? 'Sharing' : 'Not sharing'));
  $('#share-toggle-label').textContent = active ? 'Stop sharing' : 'Start sharing';
  $('#share-toggle').classList.toggle('button-primary', !active);
  $('#share-toggle').classList.toggle('button-danger', active);
  $('#pairing-placeholder').hidden = active;
  $('#pairing-active').hidden = !active;
  refreshAccessCodeUI();
  $$('.source-card').forEach(card => { card.disabled = active; });
  $('#share-quality').disabled = active;
  $('#active-peer-bar').hidden = !hostPeerDetails;
  if (hostPeerDetails) {
    $('#active-peer-name').textContent = friendlyDeviceName(hostPeerDetails.name);
    $('#active-peer-detail').textContent = hostControlAllowed ? (hostPeerDetails.unattended ? 'Unattended access · mouse and keyboard enabled' : 'Mouse and keyboard control enabled') : 'View-only session';
    $('#toggle-host-control').textContent = hostControlAllowed ? 'Revoke control' : 'Allow control';
    $('#toggle-host-control').disabled = !deviceInfo.inputAvailable;
  }
  if (active) {
    $('#host-pairing-code').textContent = hostInfo.code;
    $('#host-ip-list').replaceChildren();
    const ips = hostInfo.ips.length ? hostInfo.ips : [];
    if (!ips.length) {
      const row = document.createElement('div');
      row.className = 'ip-row';
      const text = document.createElement('code');
      text.textContent = 'No LAN IPv4 found';
      row.append(text);
      $('#host-ip-list').append(row);
    } else {
      for (const ip of ips) {
        const row = document.createElement('div');
        row.className = 'ip-row';
        const text = document.createElement('code');
        text.textContent = ip;
        const copy = document.createElement('button');
        copy.className = 'copy-small';
        copy.type = 'button';
        copy.title = `Copy ${ip}`;
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(ip); showToast('Device address copied.'); }
          catch { showToast(`Device address: ${ip}`); }
        });
        row.append(text, copy);
        $('#host-ip-list').append(row);
      }
    }
  }
}

async function startSharing() {
  if (sharingStream && hostInfo) {
    await stopSharing();
    return;
  }
  if (!accessCodeConfigured || !persistentAccessCode) {
    const message = 'Set and save your permanent access code before starting screen sharing.';
    showShareError(message);
    setAccessCodeStatus('Choose a code of at least 8 characters, then save it.', 'warning');
    $('#persistent-access-code').focus();
    showToast(message);
    return;
  }
  $('#share-toggle').disabled = true;
  showShareError('');
  try {
    if (!selectedSourceId) {
      await refreshSources();
      if (!selectedSourceId) throw new Error(sourceLoadError || 'No display is available to share.');
    }
    // A LAN-friendly preset controls capture resolution and frame-rate. The video track's
    // content hint prioritizes desktop text/detail; sender parameters below favour sharpness.
    activeShareQuality = $('#share-quality').value || 'balanced';
    const profile = SHARE_PROFILES[activeShareQuality] || SHARE_PROFILES.balanced;
    // Must be called directly from the user's click so the OS can show its screen-sharing permission.
    const capturePromise = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: profile.frameRate, width: profile.width, height: profile.height },
      audio: false
    });
    const stream = await capturePromise;
    sharingStream = stream;
    stream.getVideoTracks().forEach(track => {
      try { track.contentHint = 'detail'; } catch {}
      track.addEventListener('ended', () => {
        if (sharingStream === stream && hostInfo) stopSharing(true);
      }, { once: true });
    });
    hostInfo = await window.lanAPI.startHost();
    updateShareUI();
    showToast('Sharing is active. Share the LAN address and your permanent access code with the person connecting.');
  } catch (error) {
    if (sharingStream) sharingStream.getTracks().forEach(track => track.stop());
    if (activeCompositeCapture && typeof activeCompositeCapture.cleanup === 'function') activeCompositeCapture.cleanup();
    activeCompositeCapture = null;
    lastCompositeDisplayId = null;
    sharingStream = null;
    if (hostInfo) await window.lanAPI.stopHost();
    hostInfo = null;
    updateShareUI();
    showShareError(error.message === sourceLoadError && sourceLoadError ? sourceLoadError : describeScreenCaptureError(error));
  } finally {
    $('#share-toggle').disabled = false;
  }
}

async function stopSharing(fromSystem = false) {
  $('#share-toggle').disabled = true;
  try { await window.lanAPI.stopHost(); } catch {}
  if (sharingStream) sharingStream.getTracks().forEach(track => track.stop());
  if (activeCompositeCapture && typeof activeCompositeCapture.cleanup === 'function') activeCompositeCapture.cleanup();
  activeCompositeCapture = null;
  lastCompositeDisplayId = null;
  sharingStream = null;
  hostInfo = null;
  closeHostPeer();
  $('#incoming-modal').hidden = true;
  hostPeerDetails = null;
  hostControlAllowed = false;
  updateShareUI();
  $('#share-toggle').disabled = false;
  if (!fromSystem) showToast('Screen sharing stopped. Your permanent access code remains saved for next time.');
}

function sendHostSignal(message) {
  return window.lanAPI.sendHostSignal(message).catch((error) => {
    console.warn('[mswnlink] Could not send host signaling message:', error.message);
    return false;
  });
}

// WebRTC description/candidate instances are browser host objects. Convert them to
// plain JSON-compatible data before passing them through Electron IPC/WebSocket.
function normalizeSessionDescription(value, expectedType) {
  let description = value;
  if (typeof description === 'string') {
    try { description = JSON.parse(description); }
    catch { throw new Error(`The remote ${expectedType} description is not a valid JSON object.`); }
  }
  if (!description || typeof description !== 'object') {
    throw new Error(`The remote ${expectedType} description is missing.`);
  }
  const type = typeof description.type === 'string' ? description.type : '';
  const sdp = typeof description.sdp === 'string' ? description.sdp : '';
  if (type !== expectedType) {
    throw new Error(`Expected a WebRTC ${expectedType}, but received ${type || 'a description without a type'}.`);
  }
  const body = sdp.trimStart();
  if (!body || !/^v=0(?:\r?\n)/.test(body) || !/(?:^|\r?\n)m=(?:audio|video|application)\s/m.test(body)) {
    throw new Error(`The WebRTC ${expectedType} description has an empty or malformed SDP body.`);
  }
  return { type, sdp };
}

function serializeSessionDescription(description, expectedType) {
  if (!description) throw new Error(`Could not create a WebRTC ${expectedType} description.`);
  return normalizeSessionDescription({ type: description.type, sdp: description.sdp }, expectedType);
}

function normalizeIceCandidate(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = typeof value.candidate === 'string' ? value.candidate : '';
  if (!candidate.trim()) return null;
  const result = {
    candidate,
    sdpMid: typeof value.sdpMid === 'string' ? value.sdpMid : null,
    sdpMLineIndex: Number.isInteger(value.sdpMLineIndex) ? value.sdpMLineIndex : null
  };
  if (typeof value.usernameFragment === 'string') result.usernameFragment = value.usernameFragment;
  return result;
}

function closeHostPeer() {
  const hadPeer = Boolean(hostPeer);
  hostDataChannel = null;
  remoteFeaturePreferences = { clipboard: false, fileTransfer: false, monitorSwitching: false };
  if (hostPeer) {
    try { hostPeer.ontrack = null; hostPeer.onicecandidate = null; hostPeer.ondatachannel = null; hostPeer.close(); } catch {}
  }
  hostPeer = null;
  hostRemoteCandidates = [];
  hostControlAllowed = false;
  if (hadPeer) window.lanAPI.endHostPeer('The direct desktop session ended.').catch(() => {});
  window.lanAPI.setInputAllowed(false).catch(() => {});
  updateShareUI();
}

async function createHostPeer() {
  if (hostPeer) return hostPeer;
  if (!sharingStream) throw new Error('Screen sharing is not active.');
  const peer = new RTCPeerConnection({ iceServers: [] });
  hostPeer = peer;
  const profile = SHARE_PROFILES[activeShareQuality] || SHARE_PROFILES.balanced;
  for (const track of sharingStream.getTracks()) {
    const sender = peer.addTrack(track, sharingStream);
    if (track.kind === 'video' && sender && typeof sender.getParameters === 'function') {
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings || !parameters.encodings.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = profile.maxBitrate;
        parameters.encodings[0].maxFramerate = profile.maxFramerate;
        parameters.degradationPreference = 'maintain-resolution';
        await sender.setParameters(parameters);
      } catch (error) {
        console.debug('[mswnlink] Could not apply custom video sender parameters; using browser defaults:', error.message);
      }
    }
  }
  peer.onicecandidate = (event) => {
    const candidate = normalizeIceCandidate(event.candidate && event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
    if (candidate) sendHostSignal({ type: 'candidate', candidate });
  };
  peer.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    hostDataChannel = channel;
    // Serialize native injection while coalescing pointer motion. This preserves
    // click/key order but prevents high-frequency mouse motion from building lag.
    let inputQueue = Promise.resolve();
    let latestQueuedMove = null;
    let moveFlushQueued = false;
    const reportInputResult = (result) => {
      if (result && result.ok === false && result.reason && !inputErrorToastShown) {
        inputErrorToastShown = true;
        console.warn('[mswnlink] Remote input was rejected by the host backend:', result.reason);
        showToast(`Remote control error: ${result.reason}`);
      }
    };
    const reportInputError = (error) => {
      if (!inputErrorToastShown) {
        inputErrorToastShown = true;
        console.warn('[mswnlink] Remote input failed:', error.message || error);
        showToast(`Remote control failed: ${error.message || 'input backend error'}`);
      }
    };
    const inject = async (data) => {
      let prepared = data;
      if (activeCompositeCapture && data.kind === 'move') {
        prepared = mapCompositePointerInput(data);
        if (!prepared) { lastCompositeDisplayId = null; return; }
      } else if (activeCompositeCapture && (data.kind === 'mouse' || data.kind === 'wheel')) {
        if (!lastCompositeDisplayId) return;
        prepared = { ...data, displayId: lastCompositeDisplayId };
      } else if (['move', 'mouse', 'wheel'].includes(data.kind) && selectedSourceId) {
        // Preserve the selected monitor through pointer, click and wheel events;
        // on Windows/X11 this prevents every click being sent to the primary screen.
        const activeSource = sources.find(item => item.id === selectedSourceId);
        if (activeSource && activeSource.displayId) prepared = { ...data, displayId: activeSource.displayId };
      }
      reportInputResult(await window.lanAPI.injectInput(prepared));
    };
    const queueMove = (data) => {
      latestQueuedMove = data;
      if (moveFlushQueued) return;
      moveFlushQueued = true;
      inputQueue = inputQueue.then(async () => {
        try {
          const move = latestQueuedMove;
          latestQueuedMove = null;
          if (move) await inject(move);
        } finally {
          moveFlushQueued = false;
          if (latestQueuedMove) queueMove(latestQueuedMove);
        }
      }).catch(reportInputError);
    };
    channel.onopen = () => {
      if (hostDataChannel === channel) hostDataChannel = channel;
      sendLocalFeatureHello(channel);
      primeClipboardBaseline(channel).catch(() => {});
      updateSessionFeatureUI();
    };
    channel.onmessage = (messageEvent) => {
      if (typeof messageEvent.data !== 'string') {
        queueIncomingBinary(channel, messageEvent.data);
        return;
      }
      let data;
      try { data = JSON.parse(messageEvent.data); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const validKinds = new Set(['move', 'mouse', 'wheel', 'key', 'releaseAll']);
      if (!validKinds.has(data.kind)) {
        handleSessionDataMessage('host', channel, data).catch(error => {
          console.warn('[mswnlink] Session feature message failed:', error.message || error);
          showToast(`Session feature failed: ${error.message || 'unknown error'}`);
        });
        return;
      }
      if (data.kind === 'move') { queueMove(data); return; }
      inputQueue = inputQueue.then(async () => {
        if (latestQueuedMove) {
          const move = latestQueuedMove;
          latestQueuedMove = null;
          await inject(move);
        }
        await inject(data);
      }).catch(reportInputError);
    };
    channel.onclose = () => {
      if (hostDataChannel === channel) hostDataChannel = null;
      clearClipboardFragments(channel);
      const transfer = incomingFileTransfers.get(channel);
      if (transfer) {
        incomingFileTransfers.delete(channel);
        window.lanAPI.abortFileReceive(transfer.token).catch(() => {});
      }
      incomingFileQueues.delete(channel);
      failPendingTransfersForChannel(channel, 'The remote session closed during file transfer.');
      clearPendingClipboardForChannel(channel);
      window.lanAPI.injectInput({ kind: 'releaseAll' }).catch(() => {});
      updateSessionFeatureUI();
    };
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'closed' || peer.connectionState === 'disconnected') {
      if (hostPeer === peer) {
        closeHostPeer();
        window.lanAPI.setInputAllowed(false).catch(() => {});
      }
    }
  };
  return peer;
}

async function handleHostSignal(message) {
  if (!message || typeof message.type !== 'string') return;
  try {
    if (message.type === 'offer') {
      const offer = normalizeSessionDescription(message.sdp, 'offer');
      console.debug(`[mswnlink] Received WebRTC offer (${offer.sdp.length} SDP characters).`);
      const peer = await createHostPeer();
      await peer.setRemoteDescription(offer);
      for (const candidate of hostRemoteCandidates.splice(0)) {
        try { await peer.addIceCandidate(candidate); }
        catch (error) { console.warn('[mswnlink] Could not apply queued ICE candidate:', error.message); }
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const answerSdp = serializeSessionDescription(peer.localDescription, 'answer');
      console.debug(`[mswnlink] Sending WebRTC answer (${answerSdp.sdp.length} SDP characters).`);
      const sent = await sendHostSignal({ type: 'answer', sdp: answerSdp });
      if (!sent) throw new Error('The host could not send the WebRTC answer to the connecting device.');
    } else if (message.type === 'candidate') {
      const candidate = normalizeIceCandidate(message.candidate);
      if (!candidate) return;
      if (hostPeer && hostPeer.remoteDescription) {
        try { await hostPeer.addIceCandidate(candidate); }
        catch (error) { console.warn('[mswnlink] Could not apply ICE candidate:', error.message); }
      } else {
        hostRemoteCandidates.push(candidate);
      }
    } else if (message.type === 'hangup') {
      closeHostPeer();
      hostPeerDetails = null;
      updateShareUI();
      showToast('The remote device ended the session. Sharing is still available.');
    } else if (message.type === 'control-mode') {
      // The client should not be able to grant itself control. Control policy is set by the host UI.
      // This branch is deliberately ignored for inbound messages.
    }
  } catch (error) {
    console.error('[mswnlink] Host WebRTC negotiation failed:', error);
    if (message.type === 'offer') closeHostPeer();
    showToast(`Could not establish the direct session: ${error.message || 'Invalid WebRTC session description.'}`);
  }
}

async function resolveIncoming(mode) {
  try {
    const result = await window.lanAPI.resolveJoin(mode);
    if (!result || !result.ok) {
      showToast(result && result.error ? result.error : 'The connection request is no longer active.');
      return;
    }
    $('#incoming-modal').hidden = true;
    if (mode === 'reject') showToast('Connection request declined.');
    else showToast(mode === 'control' && result.mode === 'control' ? 'Connection approved with mouse and keyboard control.' : 'Connection approved in view-only mode.');
  } catch (error) {
    showToast(`Could not process the connection: ${error.message || 'unknown error'}`);
  }
}

function updateUnattendedAccessUI(inputAvailable = deviceInfo.inputAvailable) {
  const toggle = $('#unattended-access-toggle');
  const badge = $('#unattended-state-badge');
  const status = $('#unattended-access-status');
  if (!toggle || !badge || !status) return;
  toggle.checked = unattendedAccessEnabled;
  toggle.disabled = !inputAvailable;
  badge.textContent = unattendedAccessEnabled ? 'Enabled' : 'Disabled';
  badge.classList.toggle('is-enabled', unattendedAccessEnabled);
  status.textContent = !inputAvailable
    ? 'Unavailable: this build does not have a working input backend.'
    : unattendedAccessEnabled
      ? 'Enabled on this PC. A correct passcode will automatically grant full desktop control while sharing is active.'
      : 'Disabled. Each new connection will ask for host approval.';
}

function setConnectBusy(busy, label = 'Connect') {
  clientConnecting = busy;
  $('#connect-button').disabled = busy;
  $('#connect-button').querySelector('span:first-child').textContent = label;
}

function cleanAddress(value) {
  let address = String(value || '').trim();
  address = address.replace(/^wss?:\/\//i, '').replace(/:\d+\/?$/, '').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9.-]+$/.test(address) || address.length > 253 || address.startsWith('.') || address.endsWith('.')) return '';
  return address;
}

async function sendClientSignal(message) {
  const socket = clientSocket;
  const keyHex = clientPairKey;
  const nonce = clientNonce;
  if (!socket || socket.readyState !== WebSocket.OPEN || !keyHex || !nonce) return false;
  try {
    const envelope = await window.lanAPI.signPairMessage(keyHex, nonce, message);
    if (clientSocket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(envelope));
    return true;
  } catch (error) {
    console.warn('[mswnlink] Could not authenticate signaling message:', error.message);
    return false;
  }
}

function updateClientControlUI() {
  $('#control-status-label').textContent = controlGranted ? 'Mouse & keyboard control enabled' : 'View-only session';
  $('#session-permission-title').textContent = controlGranted ? 'Mouse and keyboard enabled' : 'View-only access';
  $('#session-permission-copy').textContent = controlGranted
    ? (clientUnattended ? 'Connected using the host’s unattended-access setting. The host can disable access or disconnect at any time.' : 'The host has approved remote input for this session. The host can revoke it at any time.')
    : 'The host has not enabled remote input. Ask them to approve control on their desktop.';
  $('#remote-video').classList.toggle('control-enabled', controlGranted);
  $('#session-footer-status').textContent = controlGranted ? (clientUnattended ? 'LOCAL NETWORK · UNATTENDED ACCESS' : 'LOCAL NETWORK · INPUT ENABLED BY HOST') : 'LOCAL NETWORK · VIEW ONLY';
}

function showSession(name, address) {
  clientName = friendlyDeviceName(name || 'Remote desktop');
  clientAddress = address || clientAddress;
  $('#session-device-name').textContent = clientName;
  $('#request-avatar').textContent = clientName.slice(0, 2).toUpperCase();
  $('#viewer-placeholder').hidden = false;
  $('#viewer-placeholder').querySelector('strong').textContent = 'Connecting to the desktop';
  $('#viewer-placeholder').querySelector('span').textContent = 'Negotiating a direct connection on your local network…';
  setSessionState('Connecting');
  $('#viewer-resolution').textContent = 'Waiting for video…';
  setConnectBusy(false);
  setPage('session');
}

function stopRemoteVideoWatchdog() {
  videoWatchdogGeneration += 1;
  if (videoWatchdogTimer) clearInterval(videoWatchdogTimer);
  videoWatchdogTimer = null;
}

function startRemoteVideoWatchdog() {
  stopRemoteVideoWatchdog();
  const generation = videoWatchdogGeneration;
  const video = $('#remote-video');
  lastRemoteVideoFrameAt = performance.now();
  if (typeof video.requestVideoFrameCallback === 'function') {
    const onFrame = () => {
      if (generation !== videoWatchdogGeneration) return;
      lastRemoteVideoFrameAt = performance.now();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }
  videoWatchdogTimer = setInterval(async () => {
    if (generation !== videoWatchdogGeneration || !clientConnected || !video.srcObject) return;
    if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try { await video.play(); } catch (error) { console.debug('[mswnlink] Video playback resume deferred:', error.message || error); }
    }
    // Recover the HTML video decoder if frames stop arriving while WebRTC is
    // still connected (e.g. after fullscreen/display power transitions).
    if (typeof video.requestVideoFrameCallback === 'function' && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && performance.now() - lastRemoteVideoFrameAt > 15000) {
      const liveTracks = video.srcObject.getVideoTracks().filter(track => track.readyState === 'live');
      if (liveTracks.length) {
        try {
          video.srcObject = new MediaStream(liveTracks);
          await video.play();
          console.warn('[mswnlink] Restarted the stalled remote video element.');
        } catch (error) { console.warn('[mswnlink] Could not recover stalled remote video:', error.message || error); }
      }
      lastRemoteVideoFrameAt = performance.now();
    }
  }, 4000);
}

async function startClientPeer() {
  if (clientPeer) return;
  const peer = new RTCPeerConnection({ iceServers: [] });
  clientPeer = peer;
  peer.addTransceiver('video', { direction: 'recvonly' });
  const channel = peer.createDataChannel('mswnlink-input', { ordered: true });
  channel.binaryType = 'arraybuffer';
  clientChannel = channel;
  channel.onopen = () => {
    // Keep feature negotiation, display discovery, and focus handling on the
    // same handler. A second onopen assignment here would overwrite these
    // essential messages and leave discovery/clipboard/files disabled.
    sendLocalFeatureHello(channel);
    sendChannelMessage(channel, { kind: 'display-list-request' });
    primeClipboardBaseline(channel).catch(() => {});
    updateSessionFeatureUI();
    if (controlGranted && clientConnected) {
      try { $('#remote-video').focus({ preventScroll: true }); }
      catch { try { $('#remote-video').focus(); } catch {} }
    }
    if (controlGranted) showToast('Remote desktop ready. Click the screen to send input.');
  };
  channel.onmessage = (messageEvent) => {
    if (typeof messageEvent.data !== 'string') {
      queueIncomingBinary(channel, messageEvent.data);
      return;
    }
    let data;
    try { data = JSON.parse(messageEvent.data); } catch { return; }
    handleSessionDataMessage('client', channel, data).catch(error => {
      console.warn('[mswnlink] Session feature message failed:', error.message || error);
      showToast(`Session feature failed: ${error.message || 'unknown error'}`);
    });
  };
  channel.onclose = () => {
    if (clientChannel === channel) clientChannel = null;
    clearClipboardFragments(channel);
    const transfer = incomingFileTransfers.get(channel);
    if (transfer) {
      incomingFileTransfers.delete(channel);
      window.lanAPI.abortFileReceive(transfer.token).catch(() => {});
    }
    incomingFileQueues.delete(channel);
    failPendingTransfersForChannel(channel, 'The remote session closed during file transfer.');
    clearPendingClipboardForChannel(channel);
    updateSessionFeatureUI();
  };
  peer.ontrack = (event) => {
    const video = $('#remote-video');
    if (event.streams && event.streams[0]) video.srcObject = event.streams[0];
    else {
      let stream = video.srcObject;
      if (!(stream instanceof MediaStream)) { stream = new MediaStream(); video.srcObject = stream; }
      stream.addTrack(event.track);
    }
    video.play().catch(() => {});
    // Focus the remote view when the live screen first arrives. Keyboard
    // forwarding intentionally only works while the viewer owns focus.
    try { video.focus({ preventScroll: true }); } catch { try { video.focus(); } catch {} }
    $('#viewer-placeholder').hidden = true;
    setSessionState('Connected', 'active');
    $('#viewer-resolution').textContent = 'Live stream';
    clientConnected = true;
    startRemoteVideoWatchdog();
    clearConnectTimer();
    updateClientControlUI();
    updateSessionFeatureUI();
    if ($('#viewer-quality-select').value === 'auto') startAdaptiveQualityMonitor();
    if (video.videoWidth && video.videoHeight) $('#viewer-resolution').textContent = `${video.videoWidth} × ${video.videoHeight}`;
  };
  peer.onicecandidate = (event) => {
    const candidate = normalizeIceCandidate(event.candidate && event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
    if (candidate) sendClientSignal({ type: 'candidate', candidate });
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') {
      if (clientDisconnectTimer) clearTimeout(clientDisconnectTimer);
      clientDisconnectTimer = null;
      clearConnectTimer();
      setSessionState('Connected', 'active');
      const video = $('#remote-video');
      if (video.paused && video.srcObject) video.play().catch(() => {});
    } else if (peer.connectionState === 'failed') {
      if (clientDisconnectTimer) clearTimeout(clientDisconnectTimer);
      clientDisconnectTimer = null;
      failClientNegotiation('The direct connection failed. Check that both devices are on the same LAN and that the host firewall allows mswnlink on TCP port 49382 and the negotiated WebRTC traffic.');
    } else if (peer.connectionState === 'disconnected') {
      setSessionState('Reconnecting', 'warn');
      if (clientDisconnectTimer) clearTimeout(clientDisconnectTimer);
      clientDisconnectTimer = setTimeout(() => {
        if (clientPeer === peer && peer.connectionState === 'disconnected') {
          failClientNegotiation('The remote connection did not recover within 25 seconds. Reconnect to continue.');
        }
      }, 25000);
    }
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const offerSdp = serializeSessionDescription(peer.localDescription, 'offer');
  console.debug(`[mswnlink] Sending WebRTC offer (${offerSdp.sdp.length} SDP characters).`);
  if (!await sendClientSignal({ type: 'offer', sdp: offerSdp })) throw new Error('The signaling connection was lost before the offer could be sent.');
}

function failClientNegotiation(reason) {
  const detail = String(reason || 'Invalid WebRTC session description.');
  console.error('[mswnlink] Client WebRTC negotiation failed:', detail);
  clearConnectTimer();
  showConnectError(`Could not negotiate the direct connection: ${detail}`);
  showToast('WebRTC setup failed. Check the connection details and try again.');
  cleanupClient(true);
  setPage('connect');
  setConnectBusy(false);
}

async function handleClientMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'rejected') {
    const reason = message.reason || 'The host declined the connection.';
    clearConnectTimer();
    showConnectError(reason);
    showToast(reason);
    cleanupClient(false);
    setPage('connect');
    setConnectBusy(false);
    return;
  }
  if (message.type === 'accepted') {
    clearConnectTimer();
    requestAccepted = true;
    window.lanAPI.setViewerSessionActive(true).catch(() => {});
    controlGranted = message.mode === 'control';
    clientUnattended = Boolean(message.unattended);
    showSession(message.hostName || 'Remote desktop', clientAddress);
    updateClientControlUI();
    try {
      await startClientPeer();
      // The TCP signaling handshake can succeed while WebRTC still cannot
      // complete its media path. Give ICE 25 seconds, then stop the spinner
      // and report an actionable error rather than leaving the UI stuck.
      clearConnectTimer();
      connectTimeout = setTimeout(() => {
        if (clientPeer && !clientConnected) {
          failClientNegotiation('Timed out waiting for the remote screen. Confirm both computers are on the same LAN and check host/client firewalls.');
        }
      }, 25000);
    } catch (error) {
      failClientNegotiation(error.message || 'Could not start the remote session.');
    }
    return;
  }
  if (message.type === 'answer') {
    if (!clientPeer) return;
    try {
      const answer = normalizeSessionDescription(message.sdp, 'answer');
      console.debug(`[mswnlink] Received WebRTC answer (${answer.sdp.length} SDP characters).`);
      await clientPeer.setRemoteDescription(answer);
      for (const candidate of clientRemoteCandidates.splice(0)) {
        try { await clientPeer.addIceCandidate(candidate); }
        catch (error) { console.warn('[mswnlink] Could not apply queued ICE candidate:', error.message); }
      }
    } catch (error) {
      failClientNegotiation(error.message);
    }
    return;
  }
  if (message.type === 'candidate') {
    const candidate = normalizeIceCandidate(message.candidate);
    if (!candidate) return;
    if (clientPeer && clientPeer.remoteDescription) {
      try { await clientPeer.addIceCandidate(candidate); }
      catch (error) { console.warn('[mswnlink] Could not apply ICE candidate:', error.message); }
    } else {
      clientRemoteCandidates.push(candidate);
    }
    return;
  }
  if (message.type === 'control-mode') {
    controlGranted = Boolean(message.allowed);
    if (!controlGranted) sendInput({ kind: 'releaseAll' });
    updateClientControlUI();
    showToast(controlGranted ? 'The host enabled mouse and keyboard control.' : 'The host switched this session to view-only.');
    return;
  }
  if (message.type === 'hangup') {
    cleanupClient(false);
    setPage('connect');
    setConnectBusy(false);
    showConnectError('The host ended the session.');
    showToast('The remote session ended.');
  }
}

function clearConnectTimer() {
  if (connectTimeout) clearTimeout(connectTimeout);
  connectTimeout = null;
}

function cleanupClient(sendHangup = false) {
  inputErrorToastShown = false;
  clearConnectTimer();
  stopAdaptiveQualityMonitor();
  stopRemoteVideoWatchdog();
  if (clientDisconnectTimer) clearTimeout(clientDisconnectTimer);
  clientDisconnectTimer = null;
  pressedRemoteButtons.clear();
  window.lanAPI.setViewerSessionActive(false).catch(() => {});
  const socketToClose = clientSocket;
  if (sendHangup && socketToClose && socketToClose.readyState === WebSocket.OPEN && clientPairKey && clientNonce) {
    const keyForHangup = clientPairKey;
    const nonceForHangup = clientNonce;
    window.lanAPI.signPairMessage(keyForHangup, nonceForHangup, { type: 'hangup' })
      .then(envelope => { if (socketToClose.readyState === WebSocket.OPEN) socketToClose.send(JSON.stringify(envelope)); })
      .catch(() => {})
      .finally(() => { try { socketToClose.close(); } catch {} });
  }
  if (clientChannel) {
    try { clientChannel.close(); } catch {}
  }
  if (clientPeer) {
    try { clientPeer.ontrack = null; clientPeer.onicecandidate = null; clientPeer.close(); } catch {}
  }
  if (clientSocket) {
    try {
      clientSocket.onopen = null; clientSocket.onmessage = null; clientSocket.onclose = null; clientSocket.onerror = null;
      if (!sendHangup) clientSocket.close();
    } catch {}
  }
  clientChannel = null;
  clientPeer = null;
  clientSocket = null;
  clientRemoteCandidates = [];
  clientConnecting = false;
  requestAccepted = false;
  clientConnected = false;
  controlGranted = false;
  clientUnattended = false;
  clientPairKey = '';
  clientNonce = null;
  remoteDisplays = [];
  remoteFeaturePreferences = { clipboard: false, fileTransfer: false, monitorSwitching: false };
  for (const pending of pendingClipboardRequests.values()) clearTimeout(pending.timer);
  pendingClipboardRequests.clear();
  for (const [channel, transfer] of incomingFileTransfers) {
    incomingFileTransfers.delete(channel);
    window.lanAPI.abortFileReceive(transfer.token).catch(() => {});
  }
  incomingFileQueues.clear();
  $('#remote-video').srcObject = null;
  $('#remote-video').classList.remove('control-enabled');
  $('#viewer-placeholder').hidden = false;
  $('#viewer-placeholder').querySelector('strong').textContent = 'Connecting to the desktop';
  $('#viewer-placeholder').querySelector('span').textContent = 'Negotiating a direct connection on your local network…';
  setConnectBusy(false);
  updateSessionFeatureUI();
}

async function connectToDevice(event) {
  event.preventDefault();
  showConnectError('');
  if (clientSocket || clientConnecting) return;
  const address = cleanAddress($('#host-address').value);
  const code = $('#pairing-code').value.trim();
  if (!address) { showConnectError('Enter a valid LAN IPv4 address or device hostname. IPv6 is not supported in this version.'); return; }
  if (code.length < 8 || code.length > 64) { showConnectError('Enter the permanent access code (8–64 characters) configured on the host PC.'); return; }
  clientAddress = address;
  clientPairKey = '';
  clientNonce = null;
  setConnectBusy(true, 'Contacting device…');
  const socket = new WebSocket(`ws://${address}:49382`);
  clientSocket = socket;
  let settled = false;
  requestAccepted = false;
  connectTimeout = setTimeout(() => {
    if (!requestAccepted && clientSocket === socket) {
      showConnectError(settled
        ? 'The host did not respond to the pairing request. Ask them to check mswnlink and try again.'
        : 'No response from that device. Check the address, port, firewall, and that both computers are on the same LAN.');
      cleanupClient(false);
    }
  }, 15000);
  socket.onopen = () => {
    if (clientSocket !== socket) return;
    settled = true;
    setConnectBusy(true, 'Securing pairing…');
  };
  socket.onmessage = async (messageEvent) => {
    if (clientSocket !== socket) return;
    try {
      const received = JSON.parse(messageEvent.data);
      if (received.type === 'challenge') {
        if (clientNonce || typeof received.nonce !== 'string' || !/^[a-f0-9]{64}$/i.test(received.nonce)) return;
        clientNonce = received.nonce;
        const challengeResponse = await window.lanAPI.makePairProof(code, clientNonce);
        clientPairKey = challengeResponse.key;
        if (clientSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: 'join', proof: challengeResponse.proof, name: deviceInfo.name }));
        setConnectBusy(true, 'Authenticating…');
        showToast('Passcode proof sent securely. Waiting for the host policy.');
        return;
      }
      let message = received;
      if (received.type === 'signed') {
        const verified = await window.lanAPI.verifyPairMessage(clientPairKey, clientNonce, received);
        if (!verified) {
          showConnectError('The host signaling message could not be authenticated. Disconnect and try again.');
          cleanupClient(false);
          setPage('connect');
          return;
        }
        message = received.payload;
      } else if (['accepted', 'answer', 'candidate', 'control-mode', 'hangup'].includes(received.type)) {
        showConnectError('The host signaling message was not authenticated.');
        cleanupClient(false);
        setPage('connect');
        return;
      }
      await handleClientMessage(message);
    } catch (error) { console.warn('[mswnlink] Bad signaling message:', error); }
  };
  socket.onerror = () => {
    if (clientSocket !== socket) return;
    if (!settled) {
      clearConnectTimer();
      showConnectError('Could not reach that device. Check the IP address and firewall settings.');
      cleanupClient(false);
    }
  };
  socket.onclose = () => {
    if (clientSocket !== socket) return;
    const wasSession = clientConnected || Boolean(clientPeer);
    cleanupClient(false);
    if (wasSession) {
      setPage('connect');
      showToast('The connection was closed.');
    }
  };
}

function sendInput(message) {
  if (!controlGranted || !clientChannel || clientChannel.readyState !== 'open') return false;
  try { clientChannel.send(JSON.stringify(message)); return true; }
  catch { return false; }
}

function getNormalizedPointer(event) {
  const video = $('#remote-video');
  const rect = video.getBoundingClientRect();
  const sourceWidth = video.videoWidth || rect.width;
  const sourceHeight = video.videoHeight || rect.height;
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const displayedWidth = sourceWidth * scale;
  const displayedHeight = sourceHeight * scale;
  const left = rect.left + (rect.width - displayedWidth) / 2;
  const top = rect.top + (rect.height - displayedHeight) / 2;
  const x = (event.clientX - left) / displayedWidth;
  const y = (event.clientY - top) / displayedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function handlePointerMove(event) {
  if (!clientConnected || !controlGranted) return;
  const now = performance.now();
  if (now - lastPointerSend < 16) return;
  lastPointerSend = now;
  const point = getNormalizedPointer(event);
  if (point) sendInput({ kind: 'move', ...point });
}

function handleRemoteKey(event, action) {
  if (!clientConnected || !controlGranted || !pages.session.classList.contains('page-active')) return;
  const target = event.target;
  if (target && (target.isContentEditable || (target.closest && target.closest('input, textarea, select, [contenteditable="true"]')))) return;
  // Escape must stay local so users can leave fullscreen. Keep Alt+Tab and
  // Ctrl+Alt+Delete local as OS-level shortcuts that remote injection cannot
  // safely override.
  if (event.key === 'Escape' || event.code === 'Escape') return;
  if ((event.altKey && event.code === 'Tab') || (event.ctrlKey && event.altKey && event.code === 'Delete')) return;
  const key = String(event.key || '');
  const printableAscii = key.length === 1 && /^[\x20-\x7e]$/.test(key);
  const textInput = printableAscii && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
  // Native held keys only need one keydown per press; printable text is sent
  // character-wise on Windows, so preserve auto-repeat for held letters.
  if (action === 'down' && event.repeat && !textInput) return;
  event.preventDefault();
  const sent = sendInput({
    kind: 'key', action, code: event.code, key,
    textInput,
    shiftKey: Boolean(event.shiftKey), ctrlKey: Boolean(event.ctrlKey),
    altKey: Boolean(event.altKey), metaKey: Boolean(event.metaKey),
    location: Number(event.location) || 0
  });
  if (!sent) console.debug('[mswnlink] Keyboard event was not sent; the remote data channel is not ready.');
}

function installRemoteKeyboardCapture() {
  // Install once at renderer startup, not during each connection. This avoids
  // lost/duplicated key handlers after reconnecting or recreating a peer.
  window.addEventListener('keydown', event => handleRemoteKey(event, 'down'), true);
  window.addEventListener('keyup', event => handleRemoteKey(event, 'up'), true);
}

function copyRemoteAddress() {
  if (!clientAddress) return;
  navigator.clipboard.writeText(clientAddress).then(() => showToast('Remote address copied.')).catch(() => showToast(`Remote address: ${clientAddress}`));
}

async function initialize() {
  try { deviceInfo = await window.lanAPI.deviceInfo(); }
  catch (error) { console.warn('[mswnlink] Device info error:', error); }
  try { localFeaturePreferences = { ...localFeaturePreferences, ...(await window.lanAPI.getLocalFeatures()) }; }
  catch (error) { console.warn('[mswnlink] Local feature settings could not be read:', error.message || error); }
  try {
    const unattended = await window.lanAPI.getUnattendedAccess();
    unattendedAccessEnabled = Boolean(unattended && unattended.enabled);
  } catch (error) { console.warn('[mswnlink] Unattended-access setting could not be read:', error.message); }
  try {
    const saved = await window.lanAPI.getAccessCode();
    persistentAccessCode = saved && typeof saved.code === 'string' ? saved.code : '';
    accessCodeConfigured = Boolean(saved && saved.configured && persistentAccessCode);
    accessCodeStorageWarning = saved && saved.warning ? saved.warning : '';
    $('#persistent-access-code').value = persistentAccessCode;
    refreshAccessCodeUI();
    if (saved && saved.error) setAccessCodeStatus(`Could not load saved code: ${saved.error}. Enter a new one and save it.`, 'error');
    else if (accessCodeStorageWarning) setAccessCodeStatus(accessCodeStorageWarning, 'warning');
    else if (accessCodeConfigured) setAccessCodeStatus('Saved on this PC. It will stay the same until you change it.', 'success');
    else setAccessCodeStatus('No permanent code saved yet. Create one to enable sharing.', 'warning');
  } catch (error) {
    setAccessCodeStatus(`Could not read passcode settings: ${error.message}`, 'error');
  }
  const name = friendlyDeviceName(deviceInfo.name);
  $('#sidebar-device-name').textContent = name;
  if (!deviceInfo.inputAvailable) {
    $('#accept-control').disabled = true;
    $('#accept-control').title = 'Native mouse/keyboard control backend is unavailable on this build.';
    $('#accept-control').querySelector('small').textContent = 'Control backend unavailable in this build';
  }
  updateUnattendedAccessUI(deviceInfo.inputAvailable);
  // Page navigation is bound synchronously by initializePageNavigation().
  $('#refresh-devices-button').addEventListener('click', refreshDiscoveredDevices);
  window.lanAPI.on('discovered-devices', renderDiscoveredDevices);
  window.lanAPI.on('local-features-changed', (features) => {
    localFeaturePreferences = { ...localFeaturePreferences, ...(features || {}) };
    updateSessionFeatureUI();
  });
  refreshDiscoveredDevices();
  setInterval(refreshDiscoveredDevices, 5000);
  startClipboardSyncMonitor();

  const wireFeatureToggle = (id, feature) => {
    const toggle = $(`#${id}`);
    if (!toggle) return;
    toggle.addEventListener('change', async () => {
      try { await setLocalFeaturePreference(feature, toggle.checked); }
      catch (error) {
        toggle.checked = Boolean(localFeaturePreferences[feature]);
        showToast(error.message || 'Could not update the feature permission.');
      }
    });
  };
  wireFeatureToggle('clipboard-sharing-toggle', 'clipboard');
  wireFeatureToggle('file-transfer-toggle', 'fileTransfer');
  wireFeatureToggle('monitor-switching-toggle', 'monitorSwitching');
  wireFeatureToggle('session-clipboard-toggle', 'clipboard');
  wireFeatureToggle('session-file-toggle', 'fileTransfer');
  wireFeatureToggle('session-monitor-toggle', 'monitorSwitching');

  $('#viewer-quality-select').addEventListener('change', () => {
    const value = $('#viewer-quality-select').value || 'auto';
    setViewerQuality(value);
    if (value === 'auto') showToast('Automatic quality adapts to packet loss and connection latency.');
    else showToast(`Requested ${value} stream quality.`);
  });
  $('#viewer-monitor-select').addEventListener('change', () => {
    const sourceId = $('#viewer-monitor-select').value;
    if (!sourceId) return;
    if (!localFeaturePreferences.monitorSwitching || !remoteFeaturePreferences.monitorSwitching) {
      showToast('Enable display switching on both devices first.');
      return;
    }
    if (!sendChannelMessage(clientChannel, { kind: 'display-select', sourceId })) showToast('Could not send the display-switch request.');
  });

  const wireAction = (id, action) => {
    const button = $(`#${id}`);
    if (!button) return;
    button.addEventListener('click', async () => {
      try { await action(); }
      catch (error) { showToast(error.message || 'That action could not be completed.'); }
    });
  };
  wireAction('send-clipboard-button', () => sendLocalClipboard(clientChannel));
  wireAction('get-clipboard-button', () => requestRemoteClipboard(clientChannel));
  wireAction('send-file-button', () => sendFileOverChannel(clientChannel));
  wireAction('host-send-clipboard-button', () => sendLocalClipboard(hostDataChannel));
  wireAction('host-get-clipboard-button', () => requestRemoteClipboard(hostDataChannel));
  wireAction('host-send-file-button', () => sendFileOverChannel(hostDataChannel));

  updateSessionFeatureUI();

  $('#connect-form').addEventListener('submit', connectToDevice);
  $('#share-toggle').addEventListener('click', startSharing);
  $('#share-quality').addEventListener('change', () => {
    const selected = SHARE_PROFILES[$('#share-quality').value] ? $('#share-quality').value : 'balanced';
    const descriptions = {
      balanced: 'Balanced selected · up to 1080p at 30 FPS.',
      smooth: 'Smooth selected · up to 1080p at 60 FPS, depending on the host PC.',
      sharp: 'Sharper selected · up to 1440p at 30 FPS, depending on the host PC.'
    };
    showToast(descriptions[selected]);
  });
  $('#toggle-connect-code').addEventListener('click', () => {
    const input = $('#pairing-code');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggle-connect-code').textContent = input.type === 'password' ? 'Show' : 'Hide';
    $('#toggle-connect-code').setAttribute('aria-label', input.type === 'password' ? 'Show access code' : 'Hide access code');
  });
  $('#toggle-access-code-visibility').addEventListener('click', () => {
    const input = $('#persistent-access-code');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggle-access-code-visibility').textContent = input.type === 'password' ? 'Show' : 'Hide';
    $('#toggle-access-code-visibility').setAttribute('aria-label', input.type === 'password' ? 'Show passcode' : 'Hide passcode');
  });
  $('#save-access-code').addEventListener('click', async () => {
    const button = $('#save-access-code');
    const code = $('#persistent-access-code').value.trim();
    if (code.length < 8 || code.length > 64) {
      setAccessCodeStatus('Use a passcode between 8 and 64 characters.', 'error');
      $('#persistent-access-code').focus();
      return;
    }
    button.disabled = true;
    setAccessCodeStatus('Saving with system secure storage…');
    try {
      const result = await window.lanAPI.saveAccessCode(code);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Could not save the access code.');
      persistentAccessCode = result.code;
      accessCodeConfigured = true;
      accessCodeStorageWarning = result.warning || '';
      $('#persistent-access-code').value = persistentAccessCode;
      if (hostInfo) hostInfo.code = persistentAccessCode;
      if (accessCodeStorageWarning) setAccessCodeStatus(accessCodeStorageWarning, 'warning');
      else setAccessCodeStatus('Saved on this PC. It will stay the same until you change it.', 'success');
      updateShareUI();
      showToast('Permanent access code saved. It will not change between sessions.');
    } catch (error) {
      setAccessCodeStatus(error.message || 'Could not save the access code.', 'error');
    } finally {
      button.disabled = false;
    }
  });
  $('#unattended-access-toggle').addEventListener('change', async (event) => {
    const toggle = event.currentTarget;
    const requested = Boolean(toggle.checked);
    if (requested && !accessCodeConfigured) {
      toggle.checked = false;
      showToast('Save a permanent access code first.');
      setPage('share');
      $('#persistent-access-code').focus();
      return;
    }
    toggle.disabled = true;
    try {
      const result = await window.lanAPI.setUnattendedAccess(requested);
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Could not change unattended access.');
      unattendedAccessEnabled = Boolean(result.enabled);
      updateUnattendedAccessUI(result.inputAvailable);
      showToast(unattendedAccessEnabled
        ? 'Unattended access enabled. A correct passcode can control this PC while sharing is active.'
        : 'Unattended access disabled. Current unattended session was disconnected if one was active.');
    } catch (error) {
      unattendedAccessEnabled = !requested;
      updateUnattendedAccessUI(deviceInfo.inputAvailable);
      showShareError(error.message || 'Could not change unattended access.');
    } finally {
      toggle.disabled = !deviceInfo.inputAvailable;
    }
  });

  $('#copy-host-code').addEventListener('click', async () => {
    const code = hostInfo && hostInfo.code ? hostInfo.code : persistentAccessCode;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); showToast('Permanent access code copied.'); }
    catch { showToast(`Permanent access code: ${code}`); }
  });
  $('#accept-view').addEventListener('click', () => resolveIncoming('view'));
  $('#accept-control').addEventListener('click', () => resolveIncoming('control'));
  $('#reject-connection').addEventListener('click', () => resolveIncoming('reject'));
  $('#disconnect-button').addEventListener('click', () => {
    cleanupClient(true);
    setPage('connect');
    showToast('Remote session ended.');
  });
  $('#back-from-session').addEventListener('click', () => {
    cleanupClient(true);
    setPage('connect');
  });
  const viewerShell = $('#viewer-shell');
  const fullscreenButton = $('#fullscreen-button');
  function syncFullscreenButton() {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    const isFullscreen = active === viewerShell;
    fullscreenButton.textContent = isFullscreen ? 'Exit full screen' : 'Full screen';
    fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit full screen' : 'Show remote desktop fullscreen');
    fullscreenButton.title = isFullscreen ? 'Exit full screen (Esc)' : 'Fit remote desktop to the whole screen';
  }
  const fullscreenExitOverlay = $('#fullscreen-exit-overlay');
  async function toggleViewerFullscreen(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    try {
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (active === viewerShell) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (viewerShell.requestFullscreen) {
        await viewerShell.requestFullscreen();
      } else if (viewerShell.webkitRequestFullscreen) {
        viewerShell.webkitRequestFullscreen();
      } else {
        showToast('Full screen is not available in this environment.');
      }
    } catch { showToast('Full screen is not available in this environment.'); }
  }
  fullscreenButton.addEventListener('click', toggleViewerFullscreen);
  fullscreenExitOverlay.addEventListener('click', toggleViewerFullscreen);
  const resumeViewerVideo = () => {
    const video = $('#remote-video');
    if (video && video.srcObject && video.paused) video.play().catch(error => console.debug('[mswnlink] Viewer playback resume deferred:', error.message || error));
    syncFullscreenButton();
  };
  document.addEventListener('fullscreenchange', resumeViewerVideo);
  document.addEventListener('webkitfullscreenchange', resumeViewerVideo);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeViewerVideo(); });
  syncFullscreenButton();
  $('#copy-address-button').addEventListener('click', copyRemoteAddress);
  $('#toggle-host-control').addEventListener('click', async () => {
    if (!hostPeerDetails) return;
    try {
      const response = await window.lanAPI.setInputAllowed(!hostControlAllowed);
      if (response && response.error) throw new Error(response.error);
      hostControlAllowed = Boolean(response && response.allowed);
      updateShareUI();
    } catch (error) { showToast(`Could not change remote control: ${error.message || 'unknown error'}`); }
  });
  $('#end-host-peer').addEventListener('click', async () => {
    await window.lanAPI.endHostPeer('The host disconnected this device.');
    closeHostPeer();
    hostPeerDetails = null;
    hostControlAllowed = false;
    updateShareUI();
    showToast('Remote device disconnected. Screen sharing remains active.');
  });
  $('#pairing-code').addEventListener('input', () => { $('#pairing-code').value = $('#pairing-code').value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64); });
  // Keep the resolution label current when the host switches monitor or quality.
  $('#remote-video').addEventListener('resize', () => {
    const video = $('#remote-video');
    if (clientConnected && video.videoWidth && video.videoHeight) $('#viewer-resolution').textContent = `${video.videoWidth} × ${video.videoHeight}`;
  });
  $('#remote-video').addEventListener('pointermove', handlePointerMove);
  $('#remote-video').addEventListener('pointerdown', (event) => {
    if (!clientConnected || !controlGranted) return;
    event.preventDefault();
    $('#remote-video').focus({ preventScroll: true });
    try { $('#remote-video').setPointerCapture(event.pointerId); } catch {}
    const point = getNormalizedPointer(event);
    if (point) sendInput({ kind: 'move', ...point });
    pressedRemoteButtons.add(event.button);
    sendInput({ kind: 'mouse', action: 'down', button: event.button });
  });
  $('#remote-video').addEventListener('pointerup', (event) => {
    if (!clientConnected || !controlGranted) return;
    event.preventDefault();
    pressedRemoteButtons.delete(event.button);
    sendInput({ kind: 'mouse', action: 'up', button: event.button });
  });
  const releaseRemoteInput = () => {
    pressedRemoteButtons.clear();
    sendInput({ kind: 'releaseAll' });
  };
  $('#remote-video').addEventListener('pointercancel', releaseRemoteInput);
  $('#remote-video').addEventListener('lostpointercapture', releaseRemoteInput);
  $('#remote-video').addEventListener('wheel', (event) => {
    if (!clientConnected || !controlGranted) return;
    event.preventDefault();
    sendInput({ kind: 'wheel', dx: event.deltaX, dy: event.deltaY });
  }, { passive: false });
  $('#remote-video').addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('blur', releaseRemoteInput);
  window.addEventListener('pagehide', releaseRemoteInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseRemoteInput(); });
  window.addEventListener('beforeunload', () => {
    cleanupClient(true);
    if (hostInfo) window.lanAPI.stopHost();
  });

  window.lanAPI.on('incoming-connection', (request) => {
    $('#request-device-name').textContent = friendlyDeviceName(request.name);
    $('#request-device-ip').textContent = request.ip;
    $('#request-avatar').textContent = friendlyDeviceName(request.name).slice(0, 2).toUpperCase();
    $('#accept-control').disabled = !deviceInfo.inputAvailable;
    $('#accept-control').querySelector('small').textContent = deviceInfo.inputAvailable ? 'Share screen and allow mouse + keyboard' : 'Native input backend unavailable';
    $('#incoming-modal').hidden = false;
  });
  window.lanAPI.on('incoming-cancelled', () => {
    $('#incoming-modal').hidden = true;
    showToast('The incoming request was cancelled.');
  });
  window.lanAPI.on('host-signal', handleHostSignal);
  window.lanAPI.on('host-stopped', () => {
    closeHostPeer();
    hostPeerDetails = null;
    hostControlAllowed = false;
    if (sharingStream) sharingStream.getTracks().forEach(track => track.stop());
    sharingStream = null;
    hostInfo = null;
    $('#incoming-modal').hidden = true;
    updateShareUI();
  });
  window.lanAPI.on('host-error', (error) => showShareError(error.message || 'The host service encountered an error.'));
  window.lanAPI.on('peer-accepted', ({ peer, mode, unattended = false }) => {
    $('#incoming-modal').hidden = true;
    hostPeerDetails = peer ? { name: peer.name, ip: peer.ip, unattended } : { name: 'Connected device', ip: '', unattended };
    hostControlAllowed = mode === 'control';
    updateShareUI();
    if (peer && peer.name) showToast(`${peer.name} connected · ${unattended ? 'unattended control' : (mode === 'control' ? 'control allowed' : 'view only')}.`);
  });
  window.lanAPI.on('peer-disconnected', ({ reason }) => {
    const hadPeer = Boolean(hostPeerDetails);
    closeHostPeer();
    hostPeerDetails = null;
    hostControlAllowed = false;
    updateShareUI();
    if (reason && hadPeer) showToast(reason);
  });
  window.lanAPI.on('input-mode-changed', ({ allowed, inputAvailable }) => {
    hostControlAllowed = Boolean(allowed);
    updateShareUI();
    showToast(allowed ? 'Remote mouse and keyboard control is enabled.' : (inputAvailable ? 'Remote session is now view-only.' : 'Native input control is unavailable.'));
  });

  updateShareUI();
  updateSessionFeatureUI();
  refreshSources();
}

function initializeWindowChrome() {
  const minimize = $('#window-minimize');
  const maximize = $('#window-maximize');
  const close = $('#window-close');
  minimize?.addEventListener('click', () => { window.lanAPI.minimizeWindow().catch(error => showToast(`Could not minimize: ${error.message}`)); });
  maximize?.addEventListener('click', async () => {
    try {
      const state = await window.lanAPI.toggleMaximizeWindow();
      syncWindowMaximizeButton(Boolean(state && state.maximized));
    } catch (error) { showToast(`Could not resize window: ${error.message}`); }
  });
  close?.addEventListener('click', () => { window.lanAPI.closeWindow().catch(error => showToast(`Could not close application: ${error.message}`)); });
  window.lanAPI.on('window-state', state => syncWindowMaximizeButton(Boolean(state && state.maximized)));
  syncWindowMaximizeButton(false);
}

function syncWindowMaximizeButton(maximized) {
  const button = $('#window-maximize');
  if (!button) return;
  button.dataset.maximized = maximized ? 'true' : 'false';
  button.title = maximized ? 'Restore window' : 'Maximize window';
  button.setAttribute('aria-label', maximized ? 'Restore window' : 'Maximize window');
}

// Install keyboard forwarding once, independent of peer creation/reconnection.
installRemoteKeyboardCapture();

// Bind core navigation before touching IPC-backed integrations. If a window
// control or OS settings IPC call fails during startup, Share this PC still
// remains reachable instead of leaving the renderer stuck on Connect.
initializePageNavigation();
setPage('connect', { refreshSources: false });
initializeTheme();
try {
  initializeWindowChrome();
} catch (error) {
  console.warn('[mswnlink] Native window controls could not initialize:', error);
}
initialize().catch((error) => {
  console.error('[mswnlink] Renderer initialization failed:', error);
  // The primary navigation remains usable even if an OS integration fails.
  showToast(`Some device features could not initialize: ${error.message || error}`);
});

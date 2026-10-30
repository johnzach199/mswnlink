'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const allowedEvents = new Set([
  'incoming-connection',
  'incoming-cancelled',
  'host-signal',
  'peer-accepted',
  'peer-disconnected',
  'host-stopped',
  'host-error',
  'input-mode-changed',
  'discovered-devices',
  'local-features-changed',
  'local-clipboard-changed',
  'menu-edit-action',
  'mac-permissions-changed',
  'window-state'
]);

contextBridge.exposeInMainWorld('lanAPI', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  deviceInfo: () => ipcRenderer.invoke('device-info'),
  getMacPermissions: () => ipcRenderer.invoke('get-mac-permissions'),
  requestMacScreenPermission: () => ipcRenderer.invoke('request-mac-screen-permission'),
  openMacPrivacySettings: (pane) => ipcRenderer.invoke('open-mac-privacy-settings', pane),
  resetMacScreenPermission: () => ipcRenderer.invoke('reset-mac-screen-permission'),
  performEditAction: (action) => ipcRenderer.invoke('perform-edit-action', action),
  getAccessCode: () => ipcRenderer.invoke('get-access-code'),
  saveAccessCode: (code) => ipcRenderer.invoke('save-access-code', code),
  getUnattendedAccess: () => ipcRenderer.invoke('get-unattended-access'),
  setUnattendedAccess: (enabled) => ipcRenderer.invoke('set-unattended-access', enabled),
  getSources: () => ipcRenderer.invoke('get-sources'),
  chooseSource: (id) => ipcRenderer.invoke('choose-source', id),
  startHost: () => ipcRenderer.invoke('host-start'),
  makePairProof: (code, nonce) => ipcRenderer.invoke('make-pair-proof', code, nonce),
  signPairMessage: (code, nonce, message) => ipcRenderer.invoke('sign-pair-message', code, nonce, message),
  verifyPairMessage: (code, nonce, envelope) => ipcRenderer.invoke('verify-pair-message', code, nonce, envelope),
  stopHost: () => ipcRenderer.invoke('host-stop'),
  resolveJoin: (mode) => ipcRenderer.invoke('host-resolve-join', mode),
  sendHostSignal: (message) => ipcRenderer.invoke('host-send-signal', message),
  setInputAllowed: (allowed) => ipcRenderer.invoke('set-input-allowed', allowed),
  endHostPeer: (reason) => ipcRenderer.invoke('host-end-peer', reason),
  injectInput: (event) => ipcRenderer.invoke('inject-input', event),
  discoverDevices: () => ipcRenderer.invoke('discover-devices'),
  getLocalFeatures: () => ipcRenderer.invoke('get-local-features'),
  setLocalFeature: (feature, enabled) => ipcRenderer.invoke('set-local-feature', feature, enabled),
  setViewerSessionActive: (active) => ipcRenderer.invoke('set-viewer-session-active', active),
  readLocalClipboard: () => ipcRenderer.invoke('read-local-clipboard'),
  writeLocalClipboard: (text) => ipcRenderer.invoke('write-local-clipboard', text),
  pickFileToSend: () => ipcRenderer.invoke('pick-file-to-send'),
  beginFileReceive: (details) => ipcRenderer.invoke('begin-file-receive', details),
  writeFileChunk: (token, data) => ipcRenderer.invoke('write-file-chunk', token, data),
  finishFileReceive: (token) => ipcRenderer.invoke('finish-file-receive', token),
  abortFileReceive: (token) => ipcRenderer.invoke('abort-file-receive', token),
  on: (channel, callback) => {
    if (!allowedEvents.has(channel) || typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});

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
  'input-status'
]);

contextBridge.exposeInMainWorld('lanAPI', {
  deviceInfo: () => ipcRenderer.invoke('device-info'),
  getAccessCode: () => ipcRenderer.invoke('get-access-code'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  saveAccessCode: (code) => ipcRenderer.invoke('save-access-code', code),
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
  on: (channel, callback) => {
    if (!allowedEvents.has(channel) || typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});

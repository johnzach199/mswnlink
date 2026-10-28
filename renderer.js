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
let hostPeerDetails = null;
let hostControlAllowed = false;
let clientAddress = '';
let clientPairKey = '';
let clientNonce = null;
let clientName = 'Remote desktop';
let lastPointerSend = 0;
let toastTimeout = null;
let connectTimeout = null;

function setPage(name) {
  Object.entries(pages).forEach(([key, page]) => page.classList.toggle('page-active', key === name));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === (name === 'session' ? 'connect' : name)));
  $('#breadcrumb-current').textContent = name === 'share' ? 'SHARE THIS PC' : name === 'session' ? 'ACTIVE SESSION' : 'CONNECT';
  if (name === 'share') refreshSources();
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
    placeholderTitle.textContent = 'Permanent code saved';
    placeholderCopy.textContent = 'Start sharing to display this PC’s LAN address and the same saved code.';
  } else {
    placeholderTitle.textContent = 'Set your permanent access code';
    placeholderCopy.textContent = 'Choose a code below before starting screen sharing. It will stay saved until you change it.';
  }
  $('#save-access-code').textContent = accessCodeConfigured ? 'Save code changes' : 'Save permanent code';
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

async function refreshSources() {
  sourceLoadError = '';
  const grid = $('#source-grid');
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
  $('#share-status-pill').innerHTML = `<span class="status-pill-dot"></span>${active ? 'SHARING ACTIVE' : 'NOT SHARING'}`;
  $('#share-toggle-label').textContent = active ? 'Stop sharing' : 'Start sharing';
  $('#share-toggle').classList.toggle('button-green', !active);
  $('#share-toggle').classList.toggle('button-danger', active);
  $('#pairing-placeholder').hidden = active;
  $('#pairing-active').hidden = !active;
  refreshAccessCodeUI();
  $$('.source-card').forEach(card => { card.disabled = active; });
  $('#share-quality').disabled = active;
  $('#active-peer-bar').hidden = !hostPeerDetails;
  if (hostPeerDetails) {
    $('#active-peer-name').textContent = friendlyDeviceName(hostPeerDetails.name);
    $('#active-peer-detail').textContent = hostControlAllowed ? 'Mouse and keyboard control enabled' : 'View-only session';
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
        copy.textContent = '⧉';
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
    channel.onmessage = (messageEvent) => {
      let data;
      try { data = JSON.parse(messageEvent.data); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const validKinds = new Set(['move', 'mouse', 'wheel', 'key', 'releaseAll']);
      if (!validKinds.has(data.kind)) return;
      window.lanAPI.injectInput(data).catch(() => {});
    };
    channel.onclose = () => window.lanAPI.injectInput({ kind: 'releaseAll' }).catch(() => {});
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
  const result = await window.lanAPI.resolveJoin(mode);
  $('#incoming-modal').hidden = true;
  if (!result || !result.ok) {
    showToast('The connection request is no longer active.');
    return;
  }
  if (mode === 'reject') {
    showToast('Connection request declined.');
  } else {
    showToast(mode === 'control' && result.mode === 'control' ? 'Connection approved with mouse and keyboard control.' : 'Connection approved in view-only mode.');
  }
}

function setConnectBusy(busy, label = 'Connect to desktop') {
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
    ? 'The host has approved remote input for this session. The host can revoke it at any time.'
    : 'The host has not enabled remote input. Ask them to approve control on their desktop.';
  $('#remote-video').classList.toggle('control-enabled', controlGranted);
  $('#session-footer-status').textContent = controlGranted ? 'LOCAL NETWORK · INPUT ENABLED BY HOST' : 'LOCAL NETWORK · VIEW ONLY';
}

function showSession(name, address) {
  clientName = friendlyDeviceName(name || 'Remote desktop');
  clientAddress = address || clientAddress;
  $('#session-device-name').textContent = clientName;
  $('#request-avatar').textContent = clientName.slice(0, 2).toUpperCase();
  $('#viewer-placeholder').hidden = false;
  $('#viewer-placeholder').querySelector('strong').textContent = 'Connecting to the desktop';
  $('#viewer-placeholder').querySelector('span').textContent = 'Negotiating a direct connection on your local network…';
  $('#session-state').innerHTML = '<span class="pulse-dot"></span> CONNECTING';
  $('#viewer-resolution').textContent = 'Waiting for video…';
  setConnectBusy(false);
  setPage('session');
}

async function startClientPeer() {
  if (clientPeer) return;
  const peer = new RTCPeerConnection({ iceServers: [] });
  clientPeer = peer;
  peer.addTransceiver('video', { direction: 'recvonly' });
  const channel = peer.createDataChannel('mswnlink-input', { ordered: true });
  clientChannel = channel;
  channel.onopen = () => {
    if (controlGranted) showToast('Remote desktop ready. Click the screen to send input.');
  };
  channel.onclose = () => {
    if (clientChannel === channel) clientChannel = null;
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
    $('#viewer-placeholder').hidden = true;
    $('#session-state').innerHTML = '<span class="pulse-dot"></span> CONNECTED';
    $('#viewer-resolution').textContent = 'Live stream';
    clientConnected = true;
    clearConnectTimer();
    updateClientControlUI();
  };
  peer.onicecandidate = (event) => {
    const candidate = normalizeIceCandidate(event.candidate && event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
    if (candidate) sendClientSignal({ type: 'candidate', candidate });
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') {
      clearConnectTimer();
      $('#session-state').innerHTML = '<span class="pulse-dot"></span> CONNECTED';
    } else if (peer.connectionState === 'failed') {
      failClientNegotiation('The direct connection failed. Check that both devices are on the same LAN and that the host firewall allows mswnlink on TCP port 49382 and the negotiated WebRTC traffic.');
    } else if (peer.connectionState === 'disconnected') {
      $('#session-state').innerHTML = '<span class="pulse-dot"></span> RECONNECTING';
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
    controlGranted = message.mode === 'control';
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
  clearConnectTimer();
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
  clientPairKey = '';
  clientNonce = null;
  $('#remote-video').srcObject = null;
  $('#remote-video').classList.remove('control-enabled');
  $('#viewer-placeholder').hidden = false;
  $('#viewer-placeholder').querySelector('strong').textContent = 'Connecting to the desktop';
  $('#viewer-placeholder').querySelector('span').textContent = 'Negotiating a direct connection on your local network…';
  setConnectBusy(false);
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
        setConnectBusy(true, 'Waiting for approval…');
        showToast('Pairing request sent. Approve it on the other computer.');
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
  if (now - lastPointerSend < 10) return;
  lastPointerSend = now;
  const point = getNormalizedPointer(event);
  if (point) sendInput({ kind: 'move', ...point });
}

function handleRemoteKey(event, action) {
  if (!clientConnected || !controlGranted || document.activeElement !== $('#remote-video')) return;
  // Prevent local browser/Electron shortcuts and route the combination to the remote desktop instead.
  event.preventDefault();
  sendInput({ kind: 'key', action, code: event.code, key: event.key });
}

function copyRemoteAddress() {
  if (!clientAddress) return;
  navigator.clipboard.writeText(clientAddress).then(() => showToast('Remote address copied.')).catch(() => showToast(`Remote address: ${clientAddress}`));
}

async function initialize() {
  try { deviceInfo = await window.lanAPI.deviceInfo(); }
  catch (error) { console.warn('[mswnlink] Device info error:', error); }
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
  $('#top-avatar').textContent = name.slice(0, 2).toUpperCase();
  if (!deviceInfo.inputAvailable) {
    $('#accept-control').disabled = true;
    $('#accept-control').title = 'Native mouse/keyboard control backend is unavailable on this build.';
    $('#accept-control').querySelector('small').textContent = 'Control backend unavailable in this build';
  }
  for (const button of $$('[data-page]')) {
    button.addEventListener('click', () => {
      const pageName = button.dataset.page;
      if (clientConnected && pageName !== 'session') {
        showToast('End the active remote session before leaving the viewer.');
        return;
      }
      setPage(pageName);
    });
  }
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
    fullscreenButton.textContent = isFullscreen ? '⤢ Exit full screen' : '⛶ Full screen';
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
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
  syncFullscreenButton();
  $('#copy-address-button').addEventListener('click', copyRemoteAddress);
  $('#toggle-host-control').addEventListener('click', async () => {
    if (!hostPeerDetails) return;
    const response = await window.lanAPI.setInputAllowed(!hostControlAllowed);
    hostControlAllowed = Boolean(response && response.allowed);
    updateShareUI();
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
  $('#remote-video').addEventListener('pointermove', handlePointerMove);
  $('#remote-video').addEventListener('pointerdown', (event) => {
    if (!clientConnected || !controlGranted) return;
    event.preventDefault();
    $('#remote-video').focus();
    try { $('#remote-video').setPointerCapture(event.pointerId); } catch {}
    const point = getNormalizedPointer(event);
    if (point) sendInput({ kind: 'move', ...point });
    sendInput({ kind: 'mouse', action: 'down', button: event.button });
  });
  $('#remote-video').addEventListener('pointerup', (event) => {
    if (!clientConnected || !controlGranted) return;
    event.preventDefault();
    sendInput({ kind: 'mouse', action: 'up', button: event.button });
  });
  $('#remote-video').addEventListener('wheel', (event) => {
    if (!clientConnected || !controlGranted) return;
    event.preventDefault();
    sendInput({ kind: 'wheel', dx: event.deltaX, dy: event.deltaY });
  }, { passive: false });
  $('#remote-video').addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('keydown', event => handleRemoteKey(event, 'down'));
  document.addEventListener('keyup', event => handleRemoteKey(event, 'up'));
  window.addEventListener('blur', () => sendInput({ kind: 'releaseAll' }));
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
  window.lanAPI.on('peer-accepted', ({ peer, mode }) => {
    $('#incoming-modal').hidden = true;
    hostPeerDetails = peer ? { name: peer.name, ip: peer.ip } : { name: 'Connected device', ip: '' };
    hostControlAllowed = mode === 'control';
    updateShareUI();
    if (peer && peer.name) showToast(`${peer.name} connected · ${mode === 'control' ? 'control allowed' : 'view only'}.`);
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
  refreshSources();
}

initialize();

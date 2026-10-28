mswnlink Browser Edition — no-install screen sharing
====================================================

This folder is a self-contained web app. It uses no packages, extensions, cloud accounts, signaling server, STUN server, or TURN relay.

HOW TO USE
----------
1. Copy the browser-only folder (or just index.html) to both computers on your trusted local network.
2. On both computers, open index.html in a recent desktop version of Chrome, Edge, or Firefox.
3. On the computer to be viewed, click “Start sharing” and approve the browser screen-selection prompt.
4. When the offer appears, click “Save offer file” or “Copy offer”. Transfer it privately to the viewer on the same LAN (for example with a trusted LAN file share or copy/paste).
5. On the viewer, load/paste the offer and click “Create answer”. Save/copy the answer and return it to the host.
6. On the host, load/paste the answer and click “Connect viewer”. The live screen should appear on the viewer after the direct connection succeeds.
7. Stop sharing on the host or disconnect on the viewer when finished.

IMPORTANT LIMITS
----------------
- This browser-only edition is VIEW-ONLY. Browsers intentionally do not allow websites to inject mouse or keyboard input into the operating system. Full remote control still requires the mswnlink desktop application or a native helper.
- Screen capture depends on browser support and secure-context policy. Modern browsers generally treat local file URLs as potentially trustworthy, but this varies by browser/version/policy. If getDisplayMedia is unavailable when opening the file, the page must be served from a trusted HTTPS origin; the HTML itself needs no install.
- No STUN/TURN server is configured. This is intended for direct connections on the same LAN. Wi-Fi client isolation, restrictive firewalls, VPN routes, or browser networking policies may block the direct connection.
- Offer and answer blobs contain SDP/ICE connection details, typically local-network addresses. Do not post them publicly or send them to people you do not trust. Pair only with devices you control.
- Nothing is uploaded by this file. The offer/answer exchange is manual. The media connection is WebRTC peer-to-peer.
- For ease of pairing this version uses manual copy/paste or JSON files; it does not have the desktop app's 6-digit pairing UI.

TROUBLESHOOTING
---------------
- If the screen prompt does not appear, click Start sharing again and allow screen capture in the browser prompt/site permissions.
- If the video never connects, ensure both computers are on the same trusted LAN, allow local peer traffic in the firewall, and try again with a new offer and answer.
- Use current desktop browsers; mobile browsers may not support desktop screen capture.

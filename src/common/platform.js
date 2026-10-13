// The browser extension exposes chrome.* while the desktop shell exposes
// proxypilot.*. Keep this boundary here to avoid Chromium's built-in
// window.chrome object inside Electron.
export const platform = globalThis.proxypilot || globalThis.chrome;

if (!platform) throw new Error('ProxyPilot platform bridge is unavailable');

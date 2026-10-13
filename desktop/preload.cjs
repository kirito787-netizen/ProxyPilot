const { contextBridge, ipcRenderer } = require('electron');

// Renderer callbacks cannot cross the contextBridge in this Electron build
// (DataCloneError). Relay storage changes as DOM events instead.
ipcRenderer.on('proxypilot:storage-changed', (_event, changes, area) => {
  try {
    window.dispatchEvent(new CustomEvent('proxypilot:storage-changed', { detail: { changes: changes, area: area } }));
  } catch (_) {}
});

contextBridge.exposeInMainWorld('proxypilot', {
  runtime: {
    getManifest: () => ({ version: '1.0.0', name: 'ProxyPilot' }),
    sendMessage: async (message) => {
      try {
        const value = await ipcRenderer.invoke('proxypilot:message', message);
        return value == null ? null : JSON.parse(JSON.stringify(value));
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    // Opening a window is a one-way command. Do not use invoke here: there is
    // no result to clone back across Electron IPC.
    openOptionsPage: () => ipcRenderer.send('proxypilot:open-options'),
  },
  storage: {
    local: {
      get: async (key) => {
        try {
          const value = await ipcRenderer.invoke('proxypilot:storage-get', key);
          return value == null ? {} : JSON.parse(JSON.stringify(value));
        } catch (_) { return {}; }
      },
      set: async (value) => {
        try { return await ipcRenderer.invoke('proxypilot:storage-set', value); }
        catch (_) { return false; }
      },
    },
  },
  tabs: {
    query: async () => [],
    reload: async () => {},
  },
});

const { contextBridge, ipcRenderer } = require('electron');

// Renderer callbacks cannot cross the context bridge (DataCloneError), so
// storage changes are relayed as DOM events instead.
ipcRenderer.on('proxypilot:storage-changed', (_event, changes, area) => {
  window.dispatchEvent(new CustomEvent('proxypilot:storage-changed', { detail: { changes, area } }));
});

contextBridge.exposeInMainWorld('proxypilot', {
  version: '1.0.0',
  call: async (message) => {
    try {
      const value = await ipcRenderer.invoke('proxypilot:message', message);
      return value == null ? null : JSON.parse(JSON.stringify(value));
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
  openOptions: () => ipcRenderer.send('proxypilot:open-options'),
  openMain: () => ipcRenderer.send('proxypilot:open-main'),
});

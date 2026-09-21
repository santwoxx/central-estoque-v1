const { contextBridge, ipcRenderer } = require('electron');

// Ponte entre a tela e o processo principal. A tela não enxerga o disco nem o
// Node: pede cada coisa por nome, e só estas.
contextBridge.exposeInMainWorld('fechamento', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart:set', enabled),
  runNow: () => ipcRenderer.invoke('closing:run-now'),
  googleStart: () => ipcRenderer.invoke('auth:google-start'),
  quit: () => ipcRenderer.invoke('app:quit'),

  ready: (hasSession) => ipcRenderer.send('renderer:ready', { hasSession: !!hasSession }),

  // O processo principal pede os dados do dia; a tela lê o banco e devolve.
  onCollect: (handler) =>
    ipcRenderer.on('closing:collect', async (_e, req) => {
      let result;
      try {
        result = await handler(req);
      } catch (err) {
        result = { ok: false, error: (err && err.message) || String(err) };
      }
      ipcRenderer.send('closing:collected', { id: req.id, result });
    }),

  onState: (handler) => ipcRenderer.on('state:changed', (_e, state) => handler(state))
});

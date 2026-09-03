const { contextBridge, ipcRenderer } = require('electron');

// Ponte estreita de proposito: a janela nao recebe `fs`, nem caminho de disco,
// nem qualquer coisa que grave fora da pasta de fechamentos. Ela manda nome de
// arquivo e conteudo; o resto e decidido no processo principal.
contextBridge.exposeInMainWorld('fechamento', {
  getFolder: () => ipcRenderer.invoke('daily-backup:get-folder'),
  chooseFolder: () => ipcRenderer.invoke('daily-backup:choose-folder'),
  save: (payload) => ipcRenderer.invoke('daily-backup:save', payload),
  openFolder: () => ipcRenderer.invoke('daily-backup:open-folder'),

  getAutoStart: () => ipcRenderer.invoke('daily-backup:get-autostart'),
  setAutoStart: (enabled) => ipcRenderer.invoke('daily-backup:set-autostart', enabled),

  quit: () => ipcRenderer.invoke('app:quit'),

  // Aviso das 18h vindo do processo principal (o programa aparece sozinho).
  onReminder: (callback) => ipcRenderer.on('daily-backup:reminder', () => callback())
});

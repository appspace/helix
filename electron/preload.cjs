'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  passwords: {
    available: () => ipcRenderer.invoke('passwords:available'),
    save: (name, password) => ipcRenderer.invoke('passwords:save', name, password),
    load: (name) => ipcRenderer.invoke('passwords:load', name),
    delete: (name) => ipcRenderer.invoke('passwords:delete', name),
  },
});

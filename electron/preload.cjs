const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  start: (config) => ipcRenderer.invoke("bridge:start", config),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  getStatus: () => ipcRenderer.invoke("bridge:status"),
  onStatusUpdate: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("bridge:status-update", handler);
    return () => ipcRenderer.removeListener("bridge:status-update", handler);
  },
});

contextBridge.exposeInMainWorld("creds", {
  load: () => ipcRenderer.invoke("creds:load"),
  save: (payload) => ipcRenderer.invoke("creds:save", payload),
  clear: () => ipcRenderer.invoke("creds:clear"),
});

contextBridge.exposeInMainWorld("updater", {
  check: () => ipcRenderer.invoke("updater:check"),
  apply: () => ipcRenderer.invoke("updater:apply"),
  download: () => ipcRenderer.invoke("updater:download"),
  restart: () => ipcRenderer.invoke("updater:restart"),
  getDownloadState: () => ipcRenderer.invoke("updater:downloadState"),
  getVersion: () => ipcRenderer.invoke("updater:version"),
  onProgress: (callback) => {
    const handler = (_event, p) => callback(p);
    ipcRenderer.on("updater:progress", handler);
    return () => ipcRenderer.removeListener("updater:progress", handler);
  },
});

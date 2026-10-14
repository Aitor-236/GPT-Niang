const {contextBridge, ipcRenderer} = require('electron');

// The renderer owns presentation only: every privileged action (window
// movement, quota refresh, settings, autostart) stays in the main process.
contextBridge.exposeInMainWorld('niang', {
  state: () => ipcRenderer.invoke('state:get'),
  onState: callback => ipcRenderer.on('state', (_event, value) => callback(value)),
  onBubble: callback => ipcRenderer.on('show-bubble', (_event, mode) => callback(mode)),
  refresh: () => ipcRenderer.invoke('quota:refresh'),
  pointer: payload => ipcRenderer.send('widget:pointer', payload),
  menu: () => ipcRenderer.send('widget:menu'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: patch => ipcRenderer.invoke('settings:set', patch)
  },
  quotes: {
    list: () => ipcRenderer.invoke('quotes:list'),
    save: list => ipcRenderer.invoke('quotes:save', list),
    reset: () => ipcRenderer.invoke('quotes:reset'),
    next: () => ipcRenderer.invoke('quotes:next')
  },
  quit: () => ipcRenderer.send('app:quit')
});

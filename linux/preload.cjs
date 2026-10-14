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
  // Input pass-through: the main process asks whether a window-local point is
  // over something the user can interact with, and the renderer reports when
  // the pointer has left that area again.
  onHitTest: callback => ipcRenderer.on('hit-test', (_event, payload) => callback(payload)),
  hitResult: payload => ipcRenderer.send('hit-result', payload),
  spriteMask: () => ipcRenderer.invoke('sprite:mask'),
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

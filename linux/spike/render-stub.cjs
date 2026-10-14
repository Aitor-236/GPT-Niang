// Stub preload for spike/render-check.js: feeds one fixed state into the real
// renderer so the bubble layout can be asserted without the main app.
const {contextBridge} = require('electron');

const state = JSON.parse(process.env.GPT_NIANG_SPIKE_STATE ?? '{}');

contextBridge.exposeInMainWorld('niang', {
  state: async () => state,
  onState: () => {},
  onBubble: () => {},
  refresh: async () => state.snapshot,
  pointer: () => {},
  menu: () => {},
  // Input pass-through: the render check has no real pointer, so the mask is
  // absent (the character then counts as a solid rectangle) and the hit test is
  // never driven from the main process.
  spriteMask: async () => null,
  onHitTest: () => {},
  hitResult: () => {},
  hitChanged: () => {},
  openSettings: async () => true,
  settings: {get: async () => state.settings, set: async () => state.settings},
  quotes: {
    list: async () => ({builtin: ['测试语录'], custom: []}),
    save: async () => ({custom: []}),
    reset: async () => ({backup: null}),
    next: async () => ({text: '我在这儿，慢慢来就好。'})
  },
  quit: () => {}
});

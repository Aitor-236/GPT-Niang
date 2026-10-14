// GPT 娘 - Linux desktop widget.
//
// The widget is a small always-available overlay that follows the Codex chat
// window and shows the quota (or provider balance) in a speech bubble. It owns
// no quota logic: the shared Node worker in gpt-niang-usage/runtime does the
// reading, exactly as on Windows and macOS.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen} from 'electron';

import {
  SCALE_MAX,
  SCALE_MIN,
  clampScale,
  dataDir,
  defaultWindowSize,
  dipsToPixels,
  loadSettings,
  pixelsToDips,
  saveSettings
} from './config.js';
import {createBackend} from './backend.js';
import {createHostFollower} from './host-follow.js';
import {isAutostartEnabled, setAutostart} from './autostart.js';
import {assetsDir} from './runtime.js';
import {clearCustomQuotes, pickQuote, readBuiltinQuotes, readCustomQuotes, writeCustomQuotes} from './quotes.js';
import {queryWindow, windowHandleToXid} from './x11.js';
import {snappedAnchor} from './geometry.js';
import {ASSET_SCHEME, assetMimeType, resolveAssetPath} from './asset-url.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The X11 backend is mandatory: a Wayland-native client cannot read another
// window's geometry or position itself. The switch must be passed on the
// command line (see package.json and the autostart entry) - setting it here
// only helps when the flag was already honoured early enough.
app.commandLine.appendSwitch('ozone-platform', 'x11');
// This desktop exposes no DRM nodes, so the GPU process aborts and nothing
// paints. Software rendering is enough for a small overlay; set
// GPT_NIANG_GPU=1 to opt back in on machines with working acceleration.
if (process.env.GPT_NIANG_GPU !== '1') app.disableHardwareAcceleration();
app.setName('gpt-niang-usage');

const WIDGET_ID = 1;
const logLines = [];
function log(event, data = {}) {
  const entry = {at: new Date().toISOString(), event, ...data};
  logLines.push(entry);
  if (logLines.length > 400) logLines.shift();
  if (process.env.GPT_NIANG_DEBUG) console.error('[gpt-niang]', JSON.stringify(entry));
}

const state = {
  dir: null,
  settings: null,
  backend: null,
  follower: null,
  widget: null,
  settingsWindow: null,
  widgetXid: null,
  scaleFactor: 1,
  visible: false,
  snapshot: null,
  snapshotKey: null,
  lastQuote: null,
  builtinQuotes: [],
  drag: null,
  quitting: false,
  x11WarningShown: false
};

function assetRoot() {
  return assetsDir({env: process.env, packaged: app.isPackaged});
}

function quotes() {
  return [...state.builtinQuotes, ...readCustomQuotes(state.dir)];
}

function sourceSummary(snapshot) {
  if (!snapshot) return null;
  return {
    source: snapshot.source ?? 'codex',
    ok: Boolean(snapshot.ok),
    queryOk: Boolean(snapshot.queryOk),
    error: snapshot.error ?? null,
    errorCode: snapshot.errorCode ?? null,
    planLabel: snapshot.planLabel ?? null,
    authType: snapshot.authType ?? null,
    windows: Array.isArray(snapshot.windows) ? snapshot.windows : [],
    balance: snapshot.balance ?? null,
    checkedAt: snapshot.checkedAt ?? null,
    observedAt: snapshot.observedAt ?? null
  };
}

function appState() {
  return {
    settings: state.settings,
    snapshot: sourceSummary(state.snapshot),
    autostart: isAutostartEnabled(),
    dataDir: state.dir,
    version: app.getVersion(),
    platform: 'linux',
    scaleRange: {min: SCALE_MIN, max: SCALE_MAX},
    x11: Boolean(state.widgetXid),
    visible: state.visible
  };
}

function broadcast() {
  const payload = appState();
  for (const window of [state.widget, state.settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('state', payload);
  }
}

function widgetPixelSize() {
  if (!state.widget) return {width: 0, height: 0};
  // Derived from the requested size rather than the measured one: under
  // XWayland the compositor nudges the window a little on every move, and
  // feeding that drift back into the position would move the widget again on
  // the next tick, growing it a bit more each time.
  return {
    width: dipsToPixels(defaultWindowSize(state.settings.scale), state.scaleFactor),
    height: dipsToPixels(defaultWindowSize(state.settings.scale), state.scaleFactor)
  };
}

function applyWidgetSize() {
  if (!state.widget) return;
  const size = defaultWindowSize(state.settings.scale);
  state.widget.setSize(size, size);
}

// Under XWayland this desktop grows the window by a pixel or two on every real
// move, so the widget creeps larger while it follows a chat window that is
// being dragged. Electron's own size report does not always see that growth,
// so the correction compares the real X11 geometry with the wanted size and
// re-applies it once the drift becomes visible.
async function verifyWidgetSize() {
  if (!state.widget || state.widget.isDestroyed() || !state.widgetXid) return;
  const desired = defaultWindowSize(state.settings.scale);
  const desiredPixels = dipsToPixels(desired, state.scaleFactor);
  let actual;
  try {
    actual = await queryWindow(state.widgetXid);
  } catch {
    return;
  }
  if (!actual || Math.abs(actual.width - desiredPixels) <= 4) return;
  log('widget-size-correction', {
    actualPixels: [actual.width, actual.height],
    desiredPixels,
    electronDip: state.widget.getSize()
  });
  state.widget.setSize(desired, desired);
}

async function showWidget() {
  if (!state.widget || state.widget.isDestroyed()) return;
  state.widget.showInactive();
  state.visible = true;
  if (!state.widgetXid) {
    state.widgetXid = windowHandleToXid(state.widget.getNativeWindowHandle());
    log('widget-xid', {id: state.widgetXid});
  }
  await verifyX11();
}

function hideWidget() {
  if (!state.widget || state.widget.isDestroyed()) return;
  state.widget.hide();
  state.visible = false;
}

// If the window is not in the X11 tree the platform is running Wayland-native
// and following cannot work; say so once instead of failing silently.
async function verifyX11() {
  if (state.x11WarningShown || state.widgetXid === null) return;
  try {
    const info = await queryWindow(state.widgetXid);
    if (info && info.width > 0) return;
  } catch {}
  state.x11WarningShown = true;
  log('x11-unavailable', {id: state.widgetXid});
  if (!process.env.GPT_NIANG_DEBUG) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'GPT 娘',
      message: '未检测到 X11 窗口后端',
      detail: '跟随 Codex 窗口需要 X11/XWayland 后端。请用 --ozone-platform=x11 启动，例如 `npm start`。桌面模式仍可正常使用。'
    }).catch(() => {});
  }
  if (state.settings.mode !== 'desktop') {
    await updateSettings({mode: 'desktop'}, {silent: true});
  }
}

function followerPort() {
  return {
    getWidgetId: () => state.widgetXid ?? '0x0',
    getWidgetSize: widgetPixelSize,
    move: (x, y) => {
      if (!state.widget || state.widget.isDestroyed()) return;
      if (process.env.GPT_NIANG_DEBUG) log('move', {x, y, dip: state.widget.getSize()});
      state.widget.setPosition(pixelsToDips(x, state.scaleFactor), pixelsToDips(y, state.scaleFactor));
    },
    moveBeforeShow: (x, y) => {
      if (!state.widget || state.widget.isDestroyed()) return;
      state.widget.setPosition(pixelsToDips(x, state.scaleFactor), pixelsToDips(y, state.scaleFactor));
    },
    setVisible: value => {
      if (value) void showWidget();
      else hideWidget();
    },
    applyAbove: () => {
      if (state.widget && !state.widget.isDestroyed()) {
        if (process.env.GPT_NIANG_DEBUG) log('above-applied', {dip: state.widget.getSize()});
        state.widget.setAlwaysOnTop(true);
      }
    },
    onVisibility: () => {
      writePresence();
      broadcast();
    },
    log
  };
}

function writePresence() {
  if (!state.backend) return;
  state.backend.writePresence({pid: process.pid, visible: state.visible});
}

function startFollowing() {
  if (!state.follower) return;
  state.follower.setAnchor(state.settings.anchor);
  state.follower.setOffsets(state.settings.hostInsets);
  state.follower.start();
}

function applyMode() {
  if (!state.follower || !state.widget) return;
  if (state.settings.mode === 'desktop') {
    state.follower.stop();
    state.widget.setAlwaysOnTop(Boolean(state.settings.desktopTopmost));
    const position = state.settings.desktopPosition;
    if (position) state.widget.setPosition(position.x, position.y);
    else parkOnPrimary();
    void showWidget();
  } else {
    state.widget.setAlwaysOnTop(true);
    startFollowing();
  }
}

function parkOnPrimary() {
  const {workArea} = screen.getPrimaryDisplay();
  const size = defaultWindowSize(state.settings.scale);
  state.widget.setPosition(
    workArea.x + workArea.width - size - 40,
    workArea.y + workArea.height - size - 40
  );
}

async function updateSettings(patch, {silent = false} = {}) {
  const previous = state.settings;
  state.settings = saveSettings(state.dir, {...state.settings, ...patch});
  if (patch.scale !== undefined && state.settings.scale !== previous.scale) {
    applyWidgetSize();
    state.follower?.reposition();
  }
  if (patch.mode !== undefined && state.settings.mode !== previous.mode) applyMode();
  if (patch.desktopTopmost !== undefined && state.settings.mode === 'desktop') {
    state.widget.setAlwaysOnTop(Boolean(state.settings.desktopTopmost));
  }
  if (patch.autostart !== undefined) {
    setAutostart(Boolean(state.settings.autostart), {appPath: app.isPackaged ? process.execPath : null});
    state.settings = saveSettings(state.dir, {...state.settings, autostart: isAutostartEnabled()});
  }
  if (patch.hostInsets || patch.anchor) {
    state.follower?.setOffsets(state.settings.hostInsets);
    state.follower?.setAnchor(state.settings.anchor);
  }
  if (!silent) broadcast();
  return state.settings;
}

function persistDragResult() {
  if (!state.drag) return;
  const [dipX, dipY] = state.widget.getPosition();
  const pixelX = dipsToPixels(dipX, state.scaleFactor);
  const pixelY = dipsToPixels(dipY, state.scaleFactor);
  const size = widgetPixelSize();
  if (state.settings.mode === 'desktop') {
    void updateSettings({desktopPosition: {x: dipX, y: dipY}});
    return;
  }
  const host = state.follower?.host;
  if (!host) return;
  const anchor = snappedAnchor(pixelX, size.width, {x: host.x, y: host.y, width: host.width, height: host.height});
  const insets = {
    left: Math.max(0, pixelX - host.x),
    right: Math.max(0, host.x + host.width - (pixelX + size.width)),
    bottom: Math.max(0, host.y + host.height - (pixelY + size.height))
  };
  void updateSettings({
    anchor,
    hostInsets: insets,
    hostPosition: {x: pixelX, y: pixelY}
  });
}

function showContextMenu() {
  if (!state.widget) return;
  const template = [
    {label: '显示额度', click: () => state.widget.webContents.send('show-bubble', 'quota')},
    {label: '显示语录', click: () => state.widget.webContents.send('show-bubble', 'quote')},
    {type: 'separator'},
    {label: '立即刷新', click: () => void refreshQuota()},
    {
      label: '显示模式',
      submenu: [
        {label: '跟随 Codex 窗口', type: 'radio', checked: state.settings.mode === 'host', click: () => void updateSettings({mode: 'host'})},
        {label: '整个桌面自由拖动', type: 'radio', checked: state.settings.mode === 'desktop', click: () => void updateSettings({mode: 'desktop'})}
      ]
    },
    ...(state.settings.mode === 'desktop'
      ? [{label: '始终置顶', type: 'checkbox', checked: state.settings.desktopTopmost, click: item => void updateSettings({desktopTopmost: item.checked})}]
      : []),
    {type: 'separator'},
    {label: '设置…', click: () => openSettings()},
    {type: 'separator'},
    {label: '退出 GPT 娘', click: () => quit()}
  ];
  Menu.buildFromTemplate(template).popup({window: state.widget});
}

async function refreshQuota({silent = false} = {}) {
  const snapshot = await state.backend.refresh();
  const key = JSON.stringify(snapshot);
  if (key !== state.snapshotKey) {
    state.snapshotKey = key;
    state.snapshot = snapshot;
    broadcast();
  }
  if (!silent) return snapshot;
  return snapshot;
}

function pollStatus() {
  if (!state.widget || state.widget.isDestroyed()) return;
  void verifyWidgetSize();
  // Cheap enough to always read: a small JSON file once per second, and the
  // settings window wants a live view too.
  const snapshot = state.backend.snapshot();
  if (!snapshot) return;
  const key = JSON.stringify(snapshot);
  if (key === state.snapshotKey) return;
  state.snapshotKey = key;
  state.snapshot = snapshot;
  broadcast();
}

function openSettings() {
  if (state.settingsWindow && !state.settingsWindow.isDestroyed()) {
    state.settingsWindow.show();
    state.settingsWindow.focus();
    return;
  }
  state.settingsWindow = new BrowserWindow({
    width: 680,
    height: 640,
    title: 'GPT 娘 设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--gpt-niang-window=settings']
    }
  });
  state.settingsWindow.loadFile(path.join(here, '..', 'renderer', 'settings.html'));
  state.settingsWindow.on('closed', () => {
    state.settingsWindow = null;
  });
}

async function createWidgetWindow() {
  const size = defaultWindowSize(state.settings.scale);
  state.widget = new BrowserWindow({
    width: size,
    height: size,
    x: -20000,
    y: -20000,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    type: 'toolbar',
    show: false,
    title: 'GPT 娘',
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  state.widget.setAlwaysOnTop(true);
  await state.widget.loadFile(path.join(here, '..', 'renderer', 'widget.html'));
  log('widget-size', {
    dip: state.widget.getSize(),
    content: state.widget.getContentSize(),
    scaleFactor: state.scaleFactor,
    requested: size
  });
  // A surprising window size is worth recording: the follow maths reads the
  // real size every tick, so a growing window silently moves the widget.
  state.widget.on('resize', () => {
    log('widget-resize', {dip: state.widget.getSize(), content: state.widget.getContentSize()});
  });
  state.widget.on('closed', () => {
    state.widget = null;
  });
}

function registerIpc() {
  ipcMain.handle('state:get', () => appState());
  ipcMain.handle('quota:refresh', () => refreshQuota());
  ipcMain.handle('settings:get', () => state.settings);
  ipcMain.handle('settings:set', (_event, patch) => updateSettings(patch ?? {}));
  ipcMain.handle('settings:open', () => {
    openSettings();
    return true;
  });
  ipcMain.handle('quotes:next', () => {
    const text = pickQuote(quotes(), {previous: state.lastQuote});
    state.lastQuote = text;
    return {text};
  });
  ipcMain.handle('quotes:list', () => ({
    builtin: state.builtinQuotes.map(quote => quote.text),
    custom: readCustomQuotes(state.dir).map(quote => quote.text)
  }));
  ipcMain.handle('quotes:save', (_event, list) => ({custom: writeCustomQuotes(state.dir, list).map(quote => quote.text)}));
  ipcMain.handle('quotes:reset', () => {
    const backup = clearCustomQuotes(state.dir);
    return {backup};
  });
  ipcMain.handle('log:dump', () => logLines);
  ipcMain.on('widget:menu', () => showContextMenu());
  ipcMain.on('app:quit', () => quit());
  ipcMain.on('widget:pointer', (_event, payload) => handlePointer(payload));
  ipcMain.on('widget:resize', (_event, scale) => void updateSettings({scale: clampScale(scale)}));
}

function handlePointer(payload) {
  if (!payload || !state.widget || state.widget.isDestroyed()) return;
  const {type, x, y} = payload;
  if (type === 'down') {
    const [windowX, windowY] = state.widget.getPosition();
    state.drag = {pointer: {x, y}, window: {x: windowX, y: windowY}};
    state.follower?.suspend();
    return;
  }
  if (type === 'move' && state.drag) {
    state.widget.setPosition(
      state.drag.window.x + Math.round(x - state.drag.pointer.x),
      state.drag.window.y + Math.round(y - state.drag.pointer.y)
    );
    return;
  }
  if (type === 'up' && state.drag) {
    state.drag = null;
    if (state.settings.mode === 'desktop') persistDragResult();
    else {
      persistDragResult();
      state.follower?.resume();
    }
  }
}

function quit() {
  state.quitting = true;
  app.quit();
}

// Scheme privileges must be declared before the app is ready; the handler
// itself can only be installed once it is.
protocol.registerSchemesAsPrivileged([
  {scheme: ASSET_SCHEME, privileges: {standard: true, secure: true, supportFetchAPI: true}}
]);

function handleAssetProtocol() {
  const root = path.resolve(assetRoot());
  protocol.handle(ASSET_SCHEME, request => {
    const file = resolveAssetPath(root, request.url);
    if (!file) {
      log('asset-forbidden', {url: request.url});
      return new Response('forbidden', {status: 403});
    }
    let contents;
    try {
      contents = fs.readFileSync(file);
    } catch {
      // A wrong asset URL leaves the character or the sounds silently missing,
      // so the miss is recorded instead of only returning 404.
      log('asset-missing', {url: request.url, file});
      return new Response('not found', {status: 404});
    }
    return new Response(new Uint8Array(contents), {headers: {'content-type': assetMimeType(file)}});
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.widget) void showWidget();
    if (state.settingsWindow) state.settingsWindow.show();
  });

  app.whenReady().then(async () => {
    state.dir = dataDir();
    state.settings = loadSettings(state.dir);
    state.backend = createBackend({dir: state.dir, packaged: app.isPackaged, log});
    await state.backend.init();
    state.scaleFactor = Number(process.env.GPT_NIANG_PIXEL_SCALE) || screen.getPrimaryDisplay().scaleFactor || 1;
    state.builtinQuotes = readBuiltinQuotes(path.join(assetRoot(), 'quotes.json'));
    state.follower = createHostFollower(followerPort(), {
      followHz: state.settings.followHz,
      discoveryIntervalMs: state.settings.discoveryIntervalMs
    });
    handleAssetProtocol();
    registerIpc();
    await createWidgetWindow();
    applyMode();
    void refreshQuota({silent: true});
    setInterval(pollStatus, 1000);
    setInterval(writePresence, 1000);
    if (state.settings.mode === 'desktop') void showWidget();
    writePresence();
    if (process.env.GPT_NIANG_OPEN_SETTINGS === '1') openSettings();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    state.quitting = true;
    try {
      state.follower?.stop();
      state.backend?.stop();
    } catch {}
  });
}

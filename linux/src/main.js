// GPT 娘 - Linux desktop widget.
//
// The widget is a small always-available overlay that follows the Codex chat
// window and shows the quota (or provider balance) in a speech bubble. It owns
// no quota logic: the shared Node worker in gpt-niang-usage/runtime does the
// reading, exactly as on Windows and macOS.
//
// Two details of the X11 port are load-bearing and are explained where they are
// implemented: the window's size is bounded explicitly (never by
// `resizable: false`, which pins the maximum to whatever the window happens to
// be at that moment), and the transparent part of the window is transparent to
// the *pointer* as well, by toggling the input shape from a cursor poll.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, protocol, screen} from 'electron';

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
import {createEventSource, createX11Connection} from './x11-connection.js';
import {createHostFollower} from './host-follow.js';
import {isAutostartEnabled, setAutostart} from './autostart.js';
import {assetsDir, runtimeDir} from './runtime.js';
import {clearCustomQuotes, pickQuote, readBuiltinQuotes, readCustomQuotes, writeCustomQuotes} from './quotes.js';
import {
  listWindows,
  listMonitors,
  queryWindow,
  readWorkArea,
  readWindowState,
  setTransientFor,
  windowHandleToXid
} from './x11.js';
import {clampToMonitors, sizeDriftExceeds, snappedAnchor, workAreaAt} from './geometry.js';
import {ASSET_SCHEME, assetMimeType, resolveAssetPath} from './asset-url.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The X11 backend is mandatory: a Wayland-native client cannot read another
// window's geometry or position itself. The switch must be passed on the
// command line (see package.json, the desktop entries and the autostart entry) -
// appending it here only helps when it was already honoured early enough.
app.commandLine.appendSwitch('ozone-platform', 'x11');
// This desktop exposes no DRM nodes, so the GPU process aborts and nothing
// paints. Software rendering is enough for a small overlay; set
// GPT_NIANG_GPU=1 to opt back in on machines with working acceleration.
if (process.env.GPT_NIANG_GPU !== '1') app.disableHardwareAcceleration();
app.setName('gpt-niang-usage');

const WIDGET_ID = 1;
// How far the real X11 geometry may sit from the size we asked for before the
// watchdog re-applies it. Chromium rounds the pixel size up to the device grid,
// so a 350 DIP window really is ~440 px wide on a 1.25 display.
const SIZE_DRIFT_TOLERANCE = 6;
// A correction is a real resize; never let the watchdog become a resize loop.
const SIZE_CORRECTION_INTERVAL_MS = 250;
// A hit test that never comes back (busy renderer) must not wedge the input
// shape in the "ignore" state for the rest of the session.
const HIT_REQUEST_TIMEOUT_MS = 200;
// One window move per frame at most, so a mouse that reports faster than the
// display cannot make the compositor work on stale positions.
const DRAG_FRAME_MS = 16;
// Cursor sampling for input pass-through. A local QueryPointer, no process.
const POINTER_POLL_MS = 16;
// While the cursor rests over a transparent part of the widget the answer will
// not change, so the same point is only re-tested this often. It still covers a
// bubble opening under a stationary pointer.
const HIT_RETEST_MS = 250;
// Monitor layout changes only when the user plugs something in; one xrandr
// reading per ten seconds keeps it off the follow loop's critical path.
const MONITOR_CACHE_MS = 10000;
// The sprite is 1254x1254 and is drawn at ~208 px; sampling its alpha every
// second pixel keeps the mask small (about 390 kB) and still far finer than any
// pointer position needs.
const SPRITE_MASK_STEP = 2;

const logLines = [];
function log(event, data = {}) {
  const entry = {at: new Date().toISOString(), event, ...data};
  logLines.push(entry);
  if (logLines.length > 400) logLines.shift();
  if (process.env.GPT_NIANG_DEBUG) console.error('[gpt-niang]', JSON.stringify(entry));
}

function ozonePlatformArgument(argv) {
  for (const argument of argv) {
    if (argument === '--ozone-platform') return 'x11';
    if (argument.startsWith('--ozone-platform=')) return argument.slice('--ozone-platform='.length);
  }
  return null;
}

// In a Wayland session Chromium defaults to the Wayland backend unless
// --ozone-platform=x11 is on the command line. The npm scripts and the desktop
// entries pass it, but a manual launch, an .desktop file installed by an older
// package, or the AppImage wrapper can all miss it - and then the widget can
// neither read the chat window's geometry nor position itself, which looks like
// "it does not follow" rather than an error. Relaunching once with the flag is
// cheaper than explaining that, and the marker stops a relaunch loop.
const relaunchingForX11 = (() => {
  const waylandSession = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
  if (!waylandSession) return false;
  if (ozonePlatformArgument(process.argv) === 'x11') return false;
  if (process.env.GPT_NIANG_X11_RELAUNCH === '1') return false;
  process.env.GPT_NIANG_X11_RELAUNCH = '1';
  const args = [...process.argv.slice(1).filter(argument => !argument.startsWith('--ozone-platform')), '--ozone-platform=x11'];
  app.relaunch({args});
  app.exit(0);
  return true;
})();

const state = {
  dir: null,
  settings: null,
  backend: null,
  connection: null,
  source: null,
  follower: null,
  widget: null,
  settingsWindow: null,
  widgetXid: null,
  scaleFactor: 1,
  monitors: [],
  desktopAreas: [],
  // The size the follow loop reports as fitting the chat window. Null means
  // "use the configured scale": desktop mode never shrinks the widget.
  fitDip: null,
  appliedDip: null,
  // True once the window manager kept the widget's ownership hint, i.e. the
  // widget shares the chat window's z-order instead of floating above everything.
  attached: false,
  visible: false,
  snapshot: null,
  snapshotKey: null,
  presenceKey: null,
  lastQuote: null,
  builtinQuotes: [],
  drag: null,
  // Input pass-through. `ignoring` mirrors what was last told to the window;
  // `misses` is the debounce that keeps the toggle from flapping.
  pointer: {ignoring: true, misses: 0, token: 0, pending: 0, pendingAt: 0, timer: null, inside: null, lastTest: null, lastTestAt: 0, inFlight: false},
  forceInteractive: false,
  sizeGuard: {lastAt: 0, corrections: 0},
  sprite: null,
  peakRule: null,
  peakKey: null,
  unwatchOwn: null,
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

// DeepSeek prices by Beijing wall clock, so the widget says which window is in
// force. The rule itself lives in the shared runtime (peak.mjs) next to the
// quota reader, so the ports cannot drift apart.
async function loadPeakRule() {
  try {
    const file = path.join(runtimeDir({env: process.env, packaged: app.isPackaged}), 'peak.mjs');
    state.peakRule = await import(pathToFileURL(file).href);
    // The holiday table only lists the year it was published for; a new year
    // without dates would quietly mark holidays as peak.
    const year = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear();
    if (!state.peakRule.peakHolidayCoverage().includes(year)) {
      log('peak-holidays-missing', {year, covered: state.peakRule.peakHolidayCoverage()});
    }
  } catch (error) {
    log('peak-rule-unavailable', {message: error?.message ?? String(error)});
    state.peakRule = null;
  }
}

function peakState() {
  if (!state.peakRule) return null;
  return state.peakRule.describePeak(Math.floor(Date.now() / 1000));
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
    eventFollow: Boolean(state.connection?.isConnected()),
    peak: peakState(),
    // The renderer draws the 378px design stage into a window of this many DIP,
    // so the canvas scales with a fitted (smaller) window.
    windowDip: effectiveWidgetDip(),
    visible: state.visible
  };
}

function broadcast() {
  const payload = appState();
  for (const window of [state.widget, state.settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('state', payload);
  }
}

// The size the widget is actually drawn at: the configured scale, unless the
// follow loop reports that the chat window is too small to hold it.
function effectiveWidgetDip() {
  return state.fitDip ?? defaultWindowSize(state.settings.scale);
}

function widgetPixelSize() {
  if (!state.widget) return {width: 0, height: 0};
  // Derived from the requested size rather than the measured one: under
  // XWayland the compositor nudges the window a little on some moves, and
  // feeding that drift back into the position would move the widget again on
  // the next tick, growing it a bit more each time.
  const size = dipsToPixels(effectiveWidgetDip(), state.scaleFactor);
  return {width: size, height: size};
}

// What the user's scale alone asks for; the follow loop fits this to the chat
// window and reports back through setWidgetSize.
function configuredPixelSize() {
  const size = dipsToPixels(defaultWindowSize(state.settings.scale), state.scaleFactor);
  return {width: size, height: size};
}

// `resizable: false` publishes the window's minimum *and* maximum size as
// whatever it is at that moment. XWayland/mutter grows the window on some
// moves (measured 440 -> 515 -> 565 -> 655 px while moving it about), and a
// pinned maximum made that growth permanent: the running widget was found at
// 2842x2635 px, covering the whole lower half of the screen and swallowing
// every click meant for the chat input. Explicit bounds keep the same "the user
// cannot resize this" behaviour without ever pinning a wrong size, so the
// watchdog below can always put it back.
function applyWidgetSize() {
  if (!state.widget || state.widget.isDestroyed()) return;
  const size = effectiveWidgetDip();
  if (state.appliedDip === size && state.widget.getSize()[0] === size) return;
  state.appliedDip = size;
  state.widget.setMinimumSize(size, size);
  state.widget.setMaximumSize(size, size);
  state.widget.setSize(size, size);
}

function monitorRects() {
  return screen.getAllDisplays().map(display => ({
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor),
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor)
  }));
}

// Same monitors, but the panel-free area: desktop mode keeps the pet inside the
// work area, the way the Windows build's Screen::WorkingArea does.
function desktopAreas() {
  return screen.getAllDisplays().map(display => ({
    x: Math.round(display.workArea.x * display.scaleFactor),
    y: Math.round(display.workArea.y * display.scaleFactor),
    width: Math.round(display.workArea.width * display.scaleFactor),
    height: Math.round(display.workArea.height * display.scaleFactor)
  }));
}

function refreshMonitors() {
  state.monitors = monitorRects();
  state.desktopAreas = desktopAreas();
}

// "WxH", for the diagnostic that pretends the chat window is smaller than it is.
function parseSize(value) {
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(String(value ?? '').trim());
  return match ? {width: Number(match[1]), height: Number(match[2])} : null;
}

async function measuredWidgetRect() {
  if (!state.widgetXid) return null;
  if (state.connection?.isConnected()) {
    try {
      return await state.connection.geometryOf(state.widgetXid);
    } catch {
      // fall through to the process-based query
    }
  }
  try {
    return await queryWindow(state.widgetXid);
  } catch {
    return null;
  }
}

// Keeps the real window at the size the layout assumes. Runs once a second and
// whenever our own window reports a ConfigureNotify that does not match.
async function repairWidgetSize({force = false} = {}) {
  if (!state.widget || state.widget.isDestroyed() || !state.widgetXid) return;
  if (state.drag) return;
  const stamp = Date.now();
  if (!force && stamp - state.sizeGuard.lastAt < SIZE_CORRECTION_INTERVAL_MS) return;
  const actual = await measuredWidgetRect();
  if (!actual) return;
  const desiredPixels = dipsToPixels(effectiveWidgetDip(), state.scaleFactor);
  if (!sizeDriftExceeds(actual, desiredPixels, SIZE_DRIFT_TOLERANCE)) return;
  state.sizeGuard.lastAt = stamp;
  state.sizeGuard.corrections += 1;
  log('widget-size-correction', {
    actualPixels: [actual.width, actual.height],
    desiredPixels,
    corrections: state.sizeGuard.corrections,
    electronDip: state.widget.getSize()
  });
  applyWidgetSize();
}

// A ConfigureNotify about our own window is the earliest possible signal that
// the compositor changed the size behind our back.
function watchOwnWindow() {
  if (!state.connection?.isConnected() || !state.widgetXid) return;
  state.unwatchOwn?.();
  state.unwatchOwn = state.connection.watchWindow(state.widgetXid, change => {
    if (change?.kind !== 'configure') return;
    const desiredPixels = dipsToPixels(effectiveWidgetDip(), state.scaleFactor);
    if (!sizeDriftExceeds(change, desiredPixels, SIZE_DRIFT_TOLERANCE)) return;
    log('widget-configure-drift', {width: change.width, height: change.height, desiredPixels});
    void repairWidgetSize();
  });
}

function setIgnoreMouse(ignore) {
  if (!state.widget || state.widget.isDestroyed()) return;
  if (ignore === state.pointer.ignoring) return;
  state.pointer.ignoring = ignore;
  state.widget.setIgnoreMouseEvents(ignore);
  if (process.env.GPT_NIANG_DEBUG) log('ignore-mouse', {ignore});
}

// Grouping the widget with the chat window is the whole point of the X11
// equivalent of a Win32 *owner* window: mutter keeps a transient above its
// parent, raises it with the parent, and - unlike _NET_WM_STATE_ABOVE - lets
// other windows cover the pair together, which is the behaviour the Windows
// build has and this port was missing ("跟随时挂件比主窗口还高，切到别的窗口
// 也不被盖住").
//
// The hint has to be set before the window is mapped, which is why it happens
// in showWidget rather than after the first follow tick. It is read back: if the
// window manager dropped it, always-on-top is the fallback, because a widget
// hidden behind its own chat window is worse than one that is too high.
async function attachToHost(hostId) {
  if (!state.widget || state.widget.isDestroyed() || !state.widgetXid || !hostId) return;
  const connection = state.connection;
  if (!connection?.isConnected()) {
    // Polling fallback: best effort, and keep the window visible.
    void setTransientFor(state.widgetXid, hostId).catch(() => {});
    state.widget.setAlwaysOnTop(true);
    return;
  }
  await connection.setTransientFor(state.widgetXid, hostId);
  const owner = await connection.transientFor(state.widgetXid);
  const attached = owner === hostId;
  // Follow the chat window to another workspace, so the pair is never split
  // across desktops. Best effort: a window manager may keep its own idea.
  const desktop = await connection.desktop(hostId);
  if (desktop !== null) await connection.setDesktop(state.widgetXid, desktop);
  // Never take keyboard focus: pressing the widget must leave the chat input's
  // caret where it was (WS_EX_NOACTIVATE on the Windows build).
  state.widget.setAlwaysOnTop(!attached);
  const previous = state.attached;
  state.attached = attached;
  if (previous !== attached || process.env.GPT_NIANG_DEBUG) {
    log('widget-attach', {host: hostId, owner, attached, above: !attached});
  }
}

// Desktop mode is an ordinary window on the desktop: no owner, and the user's
// own always-on-top preference.
async function detachFromHost() {
  if (!state.widget || state.widget.isDestroyed() || !state.widgetXid) return;
  state.attached = false;
  if (state.connection?.isConnected()) {
    try {
      // 32-bit WINDOW property with no value: WM_TRANSIENT_FOR = None.
      await state.connection.setTransientFor(state.widgetXid, 0);
    } catch {}
  }
  state.widget.setAlwaysOnTop(Boolean(state.settings.desktopTopmost));
}

// Where the pointer is, in root (physical) pixels.
//
// The X server is asked directly. Electron's screen.getCursorScreenPoint() is
// only a fallback, because Chromium refreshes it from input events delivered to
// its own windows: while the widget is passing clicks through its window has an
// empty input shape, receives nothing, and the value stays frozen where it was
// when the app started. Asking it "is the pointer over the character?" could
// then never answer yes, and the input shape would stay shut forever.
//
// GPT_NIANG_POINTER_TEST substitutes a stand-in point instead, which is how the
// input-shape behaviour is checked without moving the user's pointer:
//
//   x,y            screen coordinates in DIP
//   local:x,y      x,y inside the widget window (DIP), so the stand-in point
//                  follows the window instead of pinning the widget to
//                  pass-through once it is repositioned.
//
// Diagnostics only: it is not in DEFAULT_SETTINGS and the settings window's
// click-through switch is the way back if the widget ever stops responding.
async function cursorPixels(rect) {
  const override = process.env.GPT_NIANG_POINTER_TEST;
  if (override) {
    const text = String(override);
    const local = text.startsWith('local:');
    const [dipX, dipY] = text.replace(/^local:/, '').split(',').map(Number);
    if (Number.isFinite(dipX) && Number.isFinite(dipY)) {
      const x = dipsToPixels(dipX, state.scaleFactor);
      const y = dipsToPixels(dipY, state.scaleFactor);
      return local ? {x: rect.x + x, y: rect.y + y} : {x, y};
    }
  }
  if (state.connection?.isConnected()) {
    try {
      return await state.connection.cursor();
    } catch (error) {
      log('cursor-query-failed', {message: error?.message ?? String(error)});
    }
  }
  const fallback = screen.getCursorScreenPoint();
  return {x: dipsToPixels(fallback.x, state.scaleFactor), y: dipsToPixels(fallback.y, state.scaleFactor)};
}

// The Windows build answers WM_NCHITTEST with HTTRANSPARENT when the point
// misses the character (its alpha channel included), the bubble or a button.
// Electron cannot do that per-point: setIgnoreMouseEvents replaces the window's
// whole input shape, and the `forward` option that would report mouse motion
// back to the renderer is macOS/Windows only. So the cursor is sampled here and
// the shape is switched, and only while the pointer is inside our rectangle is
// the renderer asked to hit-test.
async function pollPointer() {
  if (state.pointer.inFlight) return;
  state.pointer.inFlight = true;
  try {
    await samplePointer();
  } catch (error) {
    log('pointer-poll-failed', {message: error?.message ?? String(error)});
  } finally {
    state.pointer.inFlight = false;
  }
}

async function samplePointer() {
  if (!state.widget || state.widget.isDestroyed() || !state.widgetXid) return;
  if (!state.visible) {
    setIgnoreMouse(true);
    return;
  }
  if (state.forceInteractive || state.settings.clickThrough === false) {
    state.pointer.misses = 0;
    setIgnoreMouse(false);
    return;
  }
  // Both sides of the comparison are the X server's own pixels: the window
  // position and size come back as DIP from Electron, so they are converted the
  // same way the placement maths converts them.
  const [dipX, dipY] = state.widget.getPosition();
  const [dipWidth, dipHeight] = state.widget.getSize();
  const rect = {
    x: dipsToPixels(dipX, state.scaleFactor),
    y: dipsToPixels(dipY, state.scaleFactor),
    width: dipsToPixels(dipWidth, state.scaleFactor),
    height: dipsToPixels(dipHeight, state.scaleFactor)
  };
  const cursor = await cursorPixels(rect);
  const inside = cursor.x >= rect.x && cursor.x < rect.x + rect.width && cursor.y >= rect.y && cursor.y < rect.y + rect.height;
  if (inside !== state.pointer.inside) {
    state.pointer.inside = inside;
    if (process.env.GPT_NIANG_DEBUG) log('pointer-inside', {inside, cursorPixels: cursor, windowPixels: rect});
  }
  if (!inside) {
    state.pointer.misses += 1;
    if (state.pointer.misses >= 2) setIgnoreMouse(true);
    return;
  }
  state.pointer.misses = 0;
  if (!state.pointer.ignoring) return;
  // Window-local CSS pixels, which is what document.elementFromPoint takes; the
  // stage's own scale is applied by the hit test.
  const point = {
    x: (cursor.x - rect.x) / state.scaleFactor,
    y: (cursor.y - rect.y) / state.scaleFactor
  };
  const stamp = Date.now();
  const moved = !state.pointer.lastTest
    || Math.abs(state.pointer.lastTest.x - point.x) > 1
    || Math.abs(state.pointer.lastTest.y - point.y) > 1;
  if (!moved && stamp - state.pointer.lastTestAt < HIT_RETEST_MS) return;
  state.pointer.lastTest = point;
  state.pointer.lastTestAt = stamp;
  const webContents = state.widget.webContents;
  if (!webContents || (state.pointer.pending && stamp - state.pointer.pendingAt < HIT_REQUEST_TIMEOUT_MS)) return;
  const token = ++state.pointer.token;
  state.pointer.pending = token;
  state.pointer.pendingAt = stamp;
  if (process.env.GPT_NIANG_DEBUG) log('hit-request', {token, x: point.x, y: point.y});
  webContents.send('hit-test', {token, x: point.x, y: point.y});
}

function notifyHitResult(payload) {
  const {token, hit} = payload ?? {};
  if (process.env.GPT_NIANG_DEBUG) log('hit-result', {token, hit: Boolean(hit)});
  if (!token || token !== state.pointer.pending) return;
  state.pointer.pending = 0;
  if (hit) {
    state.pointer.misses = 0;
    setIgnoreMouse(false);
    return;
  }
  state.pointer.misses += 1;
  if (state.pointer.misses >= 2) setIgnoreMouse(true);
}

function startPointerTracking() {
  if (state.pointer.timer) return;
  if (process.env.GPT_NIANG_DEBUG) log('pointer-tracking', {intervalMs: POINTER_POLL_MS});
  state.pointer.timer = setInterval(() => void pollPointer(), POINTER_POLL_MS);
}

// The character's alpha channel, decoded once and handed to the renderer: its
// hit test needs to ignore the transparent corners of the sprite, and the page
// cannot decode the PNG itself - drawing a gpt-asset image into a canvas and
// calling getImageData would be refused as cross-origin. Electron reads it
// without adding an image dependency.
function spriteMask() {
  if (state.sprite) return state.sprite;
  let image;
  try {
    image = nativeImage.createFromPath(path.join(assetRoot(), 'gpt-dragon-niang-bust.png'));
  } catch (error) {
    log('sprite-mask-unavailable', {message: error?.message ?? String(error)});
    return null;
  }
  const size = image.getSize();
  const bitmap = size.width > 0 && size.height > 0 ? image.toBitmap() : null;
  if (!bitmap || bitmap.length < size.width * size.height * 4) {
    log('sprite-mask-unavailable', {size});
    return null;
  }
  const step = SPRITE_MASK_STEP;
  const width = Math.ceil(size.width / step);
  const height = Math.ceil(size.height / step);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // toBitmap() is BGRA, so the alpha byte is the fourth of each pixel.
      alpha[y * width + x] = bitmap[(y * step * size.width + x * step) * 4 + 3];
    }
  }
  state.sprite = {width, height, step, sourceWidth: size.width, sourceHeight: size.height, alpha};
  log('sprite-mask', {size, step, maskSize: [width, height]});
  return state.sprite;
}

async function showWidget() {
  if (!state.widget || state.widget.isDestroyed()) return;
  if (!state.widgetXid) {
    state.widgetXid = windowHandleToXid(state.widget.getNativeWindowHandle());
    log('widget-xid', {id: state.widgetXid});
    watchOwnWindow();
  }
  // Before the first map: the window manager only honours an ownership hint it
  // sees while the window is still unmapped.
  const host = state.follower?.host;
  if (host && state.settings.mode !== 'desktop') await attachToHost(host.id);
  state.widget.showInactive();
  state.visible = true;
  if (state.settings.mode === 'desktop') void stickToAllWorkspaces();
  // A window that is mapped without focus is flagged as "demands attention" by
  // mutter, which shows up as a needs-attention badge on the app; a desktop pet
  // has nothing to demand. Follow mode is deliberately left alone here.
  if (state.settings.mode === 'desktop') state.widget.flashFrame(false);
  startPointerTracking();
  await verifyX11();
}

function hideWidget() {
  if (!state.widget || state.widget.isDestroyed()) return;
  state.widget.hide();
  state.visible = false;
}

// If the window is not in the X11 tree the platform is running Wayland-native
// and following cannot work. The relaunch above should have prevented that, but
// if the X11 backend is genuinely unavailable, say so once instead of failing
// silently.
async function verifyX11() {
  if (state.x11WarningShown || state.widgetXid === null) return;
  try {
    const info = await measuredWidgetRect();
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
    getWidgetSize: configuredPixelSize,
    // The follow loop keeps the widget inside the chat window, which can mean
    // drawing it smaller than the configured scale. The window and the renderer
    // both follow that size; the size watchdog expects it as well, so a fitted
    // window is not mistaken for drift.
    setWidgetSize: ({width, height}) => {
      const dip = pixelsToDips(Math.min(width, height), state.scaleFactor);
      if (dip === state.fitDip) return;
      state.fitDip = dip;
      log('widget-fit', {pixels: {width, height}, dip});
      applyWidgetSize();
      broadcast();
    },
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

function writePresence({force = false} = {}) {
  if (!state.backend) return;
  const key = `${process.pid}:${state.visible}`;
  if (!force && key === state.presenceKey) return;
  state.presenceKey = key;
  state.backend.writePresence({pid: process.pid, visible: state.visible});
}

function startFollowing() {
  if (!state.follower) return;
  state.follower.setAnchor(state.settings.anchor);
  state.follower.setOffsets(state.settings.hostInsets);
  state.follower.start();
}

function applyMode({initial = false} = {}) {
  if (!state.follower || !state.widget) return;
  if (state.settings.mode === 'desktop') {
    state.follower.stop();
    // The desktop widget is free on the screen, so it goes back to the size the
    // user chose: only follow mode has to fit inside the chat window.
    state.fitDip = null;
    applyWidgetSize();
    void detachFromHost();
    const position = state.settings.desktopPosition;
    if (position) state.widget.setPosition(position.x, position.y);
    // Switching modes keeps the widget where it is (the Windows build keeps its
    // frame too); only a fresh start without a remembered position parks it.
    else if (initial) parkOnDesktop();
    else {
      const [x, y] = state.widget.getPosition();
      void updateSettings({desktopPosition: {x, y}});
    }
    // A desktop pet is not owned by the chat window any more, so it should keep
    // showing when the user switches to another workspace.
    void stickToAllWorkspaces();
    void showWidget();
  } else {
    // The widget belongs to the chat window: ownership decides the z-order, not
    // always-on-top (see attachToHost).
    const host = state.follower.host;
    if (host) void attachToHost(host.id);
    startFollowing();
  }
}

// Upstream seeds a desktop pet near the chat window's bottom-right corner (24px
// in). Without a host to measure - desktop mode never runs the follower - the
// primary display's work area is the honest equivalent.
function parkOnDesktop() {
  const {workArea} = screen.getPrimaryDisplay();
  const size = effectiveWidgetDip();
  state.widget.setPosition(
    workArea.x + workArea.width - size - 24,
    workArea.y + workArea.height - size - 24
  );
}

// _NET_WM_DESKTOP = 0xffffffff makes the window sticky: visible on every
// workspace, which is what "整个桌面自由拖动" means once the widget has no owner.
async function stickToAllWorkspaces() {
  if (!state.widgetXid || !state.connection?.isConnected()) return;
  await state.connection.setDesktop(state.widgetXid, 0xffffffff);
}

async function updateSettings(patch, {silent = false} = {}) {
  const previous = state.settings;
  state.settings = saveSettings(state.dir, {...state.settings, ...patch});
  if (patch.scale !== undefined && state.settings.scale !== previous.scale) {
    // The follow loop re-fits from the new scale on its next tick.
    state.fitDip = null;
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
  if (patch.clickThrough !== undefined) {
    state.pointer.misses = 0;
    void pollPointer();
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
  // Offsets are measured from the area the widget is placed in (the chat window
  // intersected with its monitor), so the drop lands where it was let go.
  const host = state.follower?.usable ?? state.follower?.host;
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
      label: '显示与位置',
      submenu: [
        {label: '仅在 Codex 窗口内', type: 'radio', checked: state.settings.mode === 'host', click: () => void updateSettings({mode: 'host'})},
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
  const menu = Menu.buildFromTemplate(template);
  // The menu takes a pointer grab; without this the input shape could flip back
  // to pass-through while the user is choosing an item.
  state.forceInteractive = true;
  menu.once('menu-will-close', () => {
    state.forceInteractive = false;
    state.pointer.misses = 0;
  });
  menu.popup({window: state.widget});
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
  void repairWidgetSize();
  // The peak/valley label changes a few times a day; tell the window when it
  // does, since the countdown next to it is derived from the same value.
  const peak = peakState();
  const peakKey = peak ? `${peak.isPeak}:${peak.nextChangeAt}` : null;
  if (peakKey !== state.peakKey) {
    state.peakKey = peakKey;
    broadcast();
  }
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
    // Not `resizable: false`: see applyWidgetSize().
    resizable: true,
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
  applyWidgetSize();
  // Follow mode decides this from the ownership hint (attachToHost); desktop
  // mode uses the user's preference.
  state.widget.setAlwaysOnTop(state.settings.mode === 'desktop' && Boolean(state.settings.desktopTopmost));
  // Everything starts transparent to the pointer; the cursor poll opens the
  // input shape again over the character, the bubble and the buttons.
  state.pointer.ignoring = true;
  state.widget.setIgnoreMouseEvents(true);
  await state.widget.loadFile(path.join(here, '..', 'renderer', 'widget.html'));
  log('widget-size', {
    dip: state.widget.getSize(),
    content: state.widget.getContentSize(),
    scaleFactor: state.scaleFactor,
    requested: size
  });
  // A surprising window size is worth recording: the follow maths reads the
  // requested size every tick, so a growing window is invisible to it.
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
  ipcMain.handle('sprite:mask', () => spriteMask());
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
  ipcMain.on('hit-result', (_event, payload) => notifyHitResult(payload));
}

// Positions are clamped on every path that moves the window, drags included.
//
// In follow mode the range is the chat window itself (the area the follow loop
// last placed the widget in), which is what makes dragging feel like moving a
// thing inside the Codex window rather than dragging a window around and having
// it snap back. Desktop mode has no such owner, so it is bounded by the monitors
// instead - which also removes the off-screen move that used to make mutter grow
// the window out of control.
function clampPosition(x, y) {
  if (!state.widget || state.widget.isDestroyed()) return {x, y};
  const [width, height] = state.widget.getSize();
  const rect = {
    x: dipsToPixels(x, state.scaleFactor),
    y: dipsToPixels(y, state.scaleFactor),
    width: dipsToPixels(width, state.scaleFactor),
    height: dipsToPixels(height, state.scaleFactor)
  };
  let area = state.follower?.usable;
  let clamped;
  if (state.settings.mode === 'desktop') {
    // Windows behaviour (Screen::FromPoint(...).WorkingArea): the pet is clamped
    // into the panel-free area of the monitor its top-left corner is being
    // dragged onto, so it can be moved between screens but never rest in a gap
    // or under a panel.
    area = workAreaAt({x: rect.x, y: rect.y}, state.desktopAreas);
    clamped = area ? clampToMonitors(rect, [area]) : rect;
  } else {
    clamped = area ? clampToMonitors(rect, [area]) : clampToMonitors(rect, state.monitors);
  }
  return {x: pixelsToDips(clamped.x, state.scaleFactor), y: pixelsToDips(clamped.y, state.scaleFactor)};
}

function applyDragMove() {
  const drag = state.drag;
  if (!drag || !drag.latest) return;
  if (!state.widget || state.widget.isDestroyed()) return;
  const target = clampPosition(
    drag.window.x + Math.round(drag.latest.x - drag.pointer.x),
    drag.window.y + Math.round(drag.latest.y - drag.pointer.y)
  );
  if (process.env.GPT_NIANG_DEBUG) log('drag-move', {pointer: drag.pointer, latest: drag.latest, origin: drag.window, target});
  state.widget.setPosition(target.x, target.y);
}

function handlePointer(payload) {
  if (!payload || !state.widget || state.widget.isDestroyed()) return;
  const {type, x, y} = payload;
  if (process.env.GPT_NIANG_DEBUG) log('pointer-message', {type, what: payload.what, x, y, dragging: Boolean(state.drag), force: state.forceInteractive});
  if (type === 'down') {
    const [windowX, windowY] = state.widget.getPosition();
    state.drag = {pointer: {x, y}, window: {x: windowX, y: windowY}, latest: null, frame: null};
    // The widget must stay interactive for the whole gesture: the pointer
    // briefly leaving the sprite is normal, and losing the input shape there
    // would drop the drag.
    state.forceInteractive = true;
    setIgnoreMouse(false);
    state.follower?.suspend();
    return;
  }
  if (type === 'move' && state.drag) {
    state.drag.latest = {x, y};
    if (state.drag.frame) return;
    state.drag.frame = setTimeout(() => {
      if (state.drag) state.drag.frame = null;
      applyDragMove();
    }, DRAG_FRAME_MS);
    return;
  }
  if (type === 'up' && state.drag) {
    if (state.drag.frame) clearTimeout(state.drag.frame);
    applyDragMove();
    const wasDesktop = state.settings.mode === 'desktop';
    state.forceInteractive = false;
    persistDragResult();
    state.drag = null;
    state.pointer.misses = 0;
    void pollPointer();
    if (!wasDesktop) state.follower?.resume();
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

// Prefer the open X11 connection and fall back to forking the X11 tools per
// call, so a connection that drops mid-session degrades instead of stalling.
// Monitor layout still comes from xrandr - there is no cheaper source for it -
// but it changes only when the user plugs something in, so one reading per ten
// seconds is plenty and keeps it off the follow loop's critical path.
function followTools(connection) {
  const pick = (method, fallback, label) => async (...args) => {
    if (connection?.isConnected()) {
      try {
        return await connection[method](...args);
      } catch (error) {
        log('x11-fallback', {call: label, message: error?.message ?? String(error)});
      }
    }
    return fallback(...args);
  };
  let monitorsAt = 0;
  let monitors = [];
  return {
    listWindows: pick('listWindows', listWindows, 'listWindows'),
    queryWindow: pick('queryWindow', queryWindow, 'queryWindow'),
    readWorkArea: pick('readWorkArea', readWorkArea, 'readWorkArea'),
    readWindowState: pick('readWindowState', readWindowState, 'readWindowState'),
    setTransientFor: pick('setTransientFor', setTransientFor, 'setTransientFor'),
    listMonitors: async () => {
      const stamp = Date.now();
      if (stamp - monitorsAt < MONITOR_CACHE_MS && monitors.length > 0) return monitors;
      monitors = await listMonitors();
      monitorsAt = stamp;
      return monitors;
    }
  };
}

async function start() {
  state.dir = dataDir();
  state.settings = loadSettings(state.dir);
  state.backend = createBackend({dir: state.dir, packaged: app.isPackaged, log});
  await state.backend.init();
  state.scaleFactor = Number(process.env.GPT_NIANG_PIXEL_SCALE) || screen.getPrimaryDisplay().scaleFactor || 1;
  refreshMonitors();
  screen.on('display-metrics-changed', refreshMonitors);
  screen.on('display-added', refreshMonitors);
  screen.on('display-removed', refreshMonitors);
  state.builtinQuotes = readBuiltinQuotes(path.join(assetRoot(), 'quotes.json'));
  await loadPeakRule();
  // One socket for the whole session: the follow loop, the size watchdog and
  // the input-shape checks all read from it instead of forking xwininfo.
  state.connection = createX11Connection({log});
  try {
    await state.connection.connect();
  } catch (error) {
    log('x11-connection-unavailable', {message: error?.message ?? String(error)});
    state.connection = null;
  }
  state.source = state.connection ? createEventSource(state.connection) : null;
  state.follower = createHostFollower(followerPort(), {
    followHz: state.settings.followHz,
    discoveryIntervalMs: state.settings.discoveryIntervalMs,
    source: state.source,
    tools: followTools(state.connection),
    // The widget shares the chat window's z-order through the ownership hint
    // (attachToHost), the way the Windows build does with an owner window: it
    // stays above its own chat window but is covered together with it.
    above: false,
    // Chromium rounds the window's pixel size up to the device grid; keep the
    // fitted window a couple of pixels clear of the chat window's edge.
    sizeAllowance: Math.max(2, dipsToPixels(2, state.scaleFactor)),
    fitTest: parseSize(process.env.GPT_NIANG_FIT_TEST),
    minSize: dipsToPixels(defaultWindowSize(SCALE_MIN), state.scaleFactor)
  });
  handleAssetProtocol();
  registerIpc();
  await createWidgetWindow();
  applyMode({initial: true});
  void refreshQuota({silent: true});
  setInterval(pollStatus, 1000);
  writePresence({force: true});
  if (process.env.GPT_NIANG_OPEN_SETTINGS === '1') openSettings();
}

if (!relaunchingForX11 && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (!relaunchingForX11) {
  app.on('second-instance', () => {
    if (state.widget) void showWidget();
    if (state.settingsWindow) state.settingsWindow.show();
  });

  app.whenReady().then(start);

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    state.quitting = true;
    try {
      state.follower?.stop();
      state.backend?.stop();
      state.unwatchOwn?.();
      state.connection?.close();
    } catch {}
  });
}

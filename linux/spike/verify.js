// Stage-0 technical spike.
//
// Answers the three questions the Linux port depends on, on this machine:
//   1. does mutter honour an X11 client's requested position under Wayland?
//   2. does the widget reach _NET_WM_STATE_ABOVE so it stays over the chat?
//   3. how expensive is polling the host window at 30 Hz (latency/cost)?
// It also records the WM_TRANSIENT_FOR round trip and the widget's own
// WM_CLASS / window type, then prints one JSON report and exits.
//
// Run with: npm run spike

import {app, BrowserWindow, screen} from 'electron';

import {
  listMonitors,
  listWindows,
  queryWindow,
  readWindowState,
  readWorkArea,
  runTool,
  setTransientFor,
  windowHandleToXid
} from '../src/x11.js';
import {createX11Connection} from '../src/x11-connection.js';
import {codexWindowCandidates, followPosition, pickHost} from '../src/geometry.js';
import {createHostFollower} from '../src/host-follow.js';

// The desktop client is an X11 client; a Wayland-native widget could neither
// read its geometry nor position itself. The switch has to be on the command
// line (see the npm scripts) - setting it from inside main.js is too late and
// ELECTRON_OZONE_PLATFORM_HINT=x11 does not force the X11 backend either.
app.commandLine.appendSwitch('ozone-platform', 'x11');
// This environment exposes no /dev/dri nodes, so the GPU process aborts and
// the window never paints. Software rendering is enough for a small overlay.
app.disableHardwareAcceleration();

const WIDGET_SIZE = {width: 220, height: 120};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function xprop(id, ...properties) {
  return runTool('xprop', ['-id', id, ...properties]);
}

// X11 pixels and Electron's device-independent pixels differ on this desktop
// (GNOME text/UI scaling). Rather than trusting a single source, measure the
// ratio by moving the window to a known DIP position and reading it back.
async function measureScale(win, widgetId) {
  const dipPoint = {x: 200, y: 160};
  win.setPosition(dipPoint.x, dipPoint.y);
  await wait(250);
  const pixelRect = await queryWindow(widgetId);
  const dipSize = win.getSize();
  return {
    dipPoint,
    dipSize,
    pixelRect: {x: pixelRect.x, y: pixelRect.y, width: pixelRect.width, height: pixelRect.height},
    positionRatio: Number((pixelRect.x / dipPoint.x).toFixed(4)),
    sizeRatio: Number((pixelRect.width / dipSize[0]).toFixed(4))
  };
}

async function run() {
  const report = {steps: {}, failures: []};
  report.commandLine = process.argv.filter(value => value.startsWith('--ozone')).join(' ') || '(none)';
  report.displays = screen.getAllDisplays().map(display => ({
    id: display.id,
    size: display.size,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor
  }));
  const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
  report.scaleFactor = scaleFactor;
  const win = new BrowserWindow({
    width: WIDGET_SIZE.width,
    height: WIDGET_SIZE.height,
    x: 40,
    y: 40,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'toolbar',
    show: false,
    webPreferences: {contextIsolation: true, nodeIntegration: false}
  });
  await win.loadURL('data:text/html,<body style="margin:0;background:rgba(155,134,193,0.85);color:#fff;font:13px sans-serif">GPT 娘 spike</body>');
  win.showInactive();
  await wait(400);

  const widgetId = windowHandleToXid(win.getNativeWindowHandle());
  report.widgetId = widgetId;
  report.widgetDipSize = win.getSize();
  report.steps.widgetClass = (await xprop(widgetId, 'WM_CLASS')).trim();
  report.steps.widgetType = (await xprop(widgetId, '_NET_WM_WINDOW_TYPE')).trim();
  report.steps.widgetInX11Tree = (await listWindows()).some(window => window.id === widgetId);
  report.steps.scaleProbe = await measureScale(win, widgetId);
  const widgetRect = await queryWindow(widgetId);
  report.steps.widgetPixelSize = {width: widgetRect.width, height: widgetRect.height};

  const monitors = await listMonitors();
  const workArea = await readWorkArea();
  report.monitors = monitors;
  report.workArea = workArea;

  const candidates = codexWindowCandidates(await listWindows(), {monitors, exclude: [widgetId]});
  report.steps.candidates = candidates.map(candidate => ({id: candidate.id, name: candidate.name, rect: {x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height}, visible: candidate.visible}));
  const chosen = pickHost(candidates);
  if (!chosen) {
    report.failures.push('no Codex host window found');
    return report;
  }
  const host = {...chosen, ...(await queryWindow(chosen.id))};
  report.host = {id: host.id, name: host.name, x: host.x, y: host.y, width: host.width, height: host.height, viewable: host.viewable};

  // 1. positioning: ask for a follow position and read back the real geometry.
  // Geometry from xwininfo is in X11 pixels while Electron window APIs use
  // device-independent pixels, so every position crosses the scale factor.
  const toX11 = (width, height) => ({width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor)});
  const toDips = (x, y) => ({x: Math.round(x / scaleFactor), y: Math.round(y / scaleFactor)});
  const pixelSize = toX11(WIDGET_SIZE.width, WIDGET_SIZE.height);
  const expected = followPosition(host, pixelSize, {anchor: 'left', left: 12, bottom: 12});
  win.setPosition(...Object.values(toDips(expected.x, expected.y)));
  await wait(350);
  const actual = await queryWindow(widgetId);
  report.steps.position = {
    requestedPixel: expected,
    actualPixel: {x: actual.x, y: actual.y},
    honoured: Math.abs(actual.x - expected.x) <= 2 && Math.abs(actual.y - expected.y) <= 2
  };
  if (!report.steps.position.honoured) report.failures.push('mutter did not honour the requested position');

  // 2. stacking band.
  win.setAlwaysOnTop(true);
  await wait(350);
  const above = await readWindowState(widgetId);
  report.steps.aboveState = above;
  if (!above.includes('_NET_WM_STATE_ABOVE')) report.failures.push('_NET_WM_STATE_ABOVE was not applied');

  // 3. host geometry polling cost.
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    const startedAt = performance.now();
    await queryWindow(host.id);
    samples.push(performance.now() - startedAt);
  }
  report.steps.poll = {
    samples: samples.length,
    meanMs: Number((samples.reduce((total, value) => total + value, 0) / samples.length).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2))
  };

  // 4. transient-for round trip (the Windows build's owner-window analogue).
  const transientApplied = await setTransientFor(widgetId, host.id);
  await wait(200);
  const transientRead = (await xprop(widgetId, 'WM_TRANSIENT_FOR')).trim();
  report.steps.transientFor = {applied: transientApplied, read: transientRead};

  // 5. the follower loop against the real desktop, for 700 ms.
  const port = {
    moves: [],
    events: [],
    getWidgetId: () => widgetId,
    getWidgetSize: () => pixelSize,
    move(x, y) {
      this.moves.push({x, y});
      const dips = toDips(x, y);
      win.setPosition(dips.x, dips.y);
    },
    moveBeforeShow(x, y) {
      this.moves.push({x, y});
      const dips = toDips(x, y);
      win.setPosition(dips.x, dips.y);
    },
    setVisible(value) {
      this.events.push({visible: value});
      if (value) win.showInactive();
      else win.hide();
    },
    applyAbove() {
      win.setAlwaysOnTop(true);
    }
  };
  const follower = createHostFollower(port, {followHz: 30});
  follower.start();
  await wait(700);
  const followed = await queryWindow(widgetId);
  follower.stop();
  report.steps.follower = {
    host: follower.host?.id ?? null,
    visible: follower.visible,
    moves: port.moves.length,
    lastMove: port.moves.at(-1) ?? null,
    actualAfterFollow: {x: followed.x, y: followed.y},
    stats: follower.stats
  };
  if (follower.host?.id !== host.id) report.failures.push('follower did not keep the chat window as host');

  // 6. event subscription. This is what lets the widget react to a window move
  // instead of sampling it: does the server deliver ConfigureNotify for a
  // window this client does not own? Our own test window stands in for the
  // chat window, which cannot be moved without disturbing the user.
  const connection = createX11Connection({log: () => {}});
  try {
    await connection.connect();
    let events = 0;
    const unwatch = connection.watchWindow(widgetId, () => {
      events += 1;
    });
    for (let index = 0; index < 10; index += 1) {
      win.setPosition(120 + index * 4, 120 + index * 3);
      await wait(80);
    }
    await wait(300);
    unwatch();
    const geometry = await connection.geometryOf(widgetId);
    report.steps.events = {configureNotify: events, geometryAfterMoves: geometry};
    if (events === 0) report.failures.push('no ConfigureNotify arrived for a watched window');
    // Watching the chat window is the same call; report what it sees while the
    // spike runs, which is only interesting if the window is moved by hand.
    let hostEvents = 0;
    const unwatchHost = connection.watchWindow(host.id, () => {
      hostEvents += 1;
    });
    await wait(1000);
    unwatchHost();
    report.steps.hostEvents = {configureNotify: hostEvents};
  } catch (error) {
    report.failures.push('x11 connection failed: ' + (error?.message ?? String(error)));
  } finally {
    connection.close();
  }

  // 7. input shape. The transparent parts of the widget must be able to hand
  // the pointer to the window underneath.
  try {
    win.setIgnoreMouseEvents(true);
    await wait(200);
    const stateWhenIgnoring = await readWindowState(widgetId);
    win.setIgnoreMouseEvents(false);
    await wait(200);
    const after = await queryWindow(widgetId);
    report.steps.inputShape = {
      toggled: true,
      aboveWhileIgnoring: stateWhenIgnoring.includes('_NET_WM_STATE_ABOVE'),
      stillViewable: after.viewable,
      size: {width: after.width, height: after.height}
    };
    if (!after.viewable) report.failures.push('window stopped being viewable after an input-shape toggle');
  } catch (error) {
    report.failures.push('input shape toggle failed: ' + (error?.message ?? String(error)));
  }
  return report;
}

app.whenReady().then(async () => {
  let report;
  try {
    report = await run();
  } catch (error) {
    report = {failures: ['spike crashed'], error: error?.stack ?? String(error)};
  }
  console.log('SPIKE_REPORT ' + JSON.stringify(report, null, 2));
  app.exit(report.failures?.length ? 1 : 0);
});

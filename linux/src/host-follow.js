// Keeps the widget attached to the Codex chat window.
//
// The Windows build uses WinEvent hooks and the macOS build samples the
// WindowServer. Neither exists here, so the port has two modes:
//
//   * event mode (a `source` is supplied, see ./x11-connection.js): the X
//     server pushes ConfigureNotify for the window being followed and
//     substructure changes on the root, and every question is answered on the
//     open socket. A slow safety tick still runs, so a missed event cannot
//     leave the widget stranded.
//   * polling mode (no `source`): the original single loop - window discovery
//     at a low rate and geometry sampling at a higher one, both by forking
//     xwininfo. This is also the fallback when the X11 connection is
//     unavailable.

import {
  listWindows,
  listMonitors,
  queryWindow,
  readWorkArea,
  readWindowState,
  setTransientFor
} from './x11.js';
import {
  codexWindowCandidates,
  fitSize,
  followPosition,
  hostIsVisible,
  pickHost,
  samePoint,
  usableArea
} from './geometry.js';

export const FOLLOW_DEFAULTS = {
  followHz: 30,
  discoveryIntervalMs: 250,
  graceMs: 750,
  readinessSamples: 2,
  anchor: 'left',
  offsets: {left: 12, right: 12, bottom: 12},
  // Kept inside the chat window rather than hanging out of it: the allowance
  // covers Chromium rounding the window's pixel size up, and the minimum is the
  // smallest the design may be rendered at before the widget gives up.
  sizeAllowance: 4,
  minSize: 0,
  above: true
};

const ABOVE_ATOM = '_NET_WM_STATE_ABOVE';
// One window move produces several ConfigureNotify packets; coalescing them
// keeps a burst from turning into a burst of geometry queries.
const EVENT_COALESCE_MS = 16;
// A window appearing or disappearing can change which chat window is the host;
// that is worth a full walk right away. Anything else waits for the next one.
const EVENT_FULL_DISCOVERY_MS = 1000;

export function createHostFollower(port, options = {}) {
  const settings = {
    ...FOLLOW_DEFAULTS,
    ...options,
    offsets: {...FOLLOW_DEFAULTS.offsets, ...(options.offsets ?? {})}
  };
  const tools = settings.tools ?? {};
  const source = settings.source ?? null;
  const runListWindows = tools.listWindows ?? source?.listWindows ?? listWindows;
  const runListMonitors = tools.listMonitors ?? listMonitors;
  const runQueryWindow = tools.queryWindow ?? source?.queryWindow ?? queryWindow;
  const runReadWorkArea = tools.readWorkArea ?? source?.readWorkArea ?? readWorkArea;
  const runReadWindowState = tools.readWindowState ?? source?.readWindowState ?? readWindowState;
  const runSetTransientFor = tools.setTransientFor ?? source?.setTransientFor ?? setTransientFor;
  const now = settings.now ?? Date.now;

  let timer = null;
  let running = false;
  let host = null;
  let monitors = [];
  let workArea = null;
  let lastDiscovery = 0;
  let missingSince = null;
  let stableSamples = 0;
  let visible = false;
  let aboveApplied = false;
  let lastPosition = null;
  let usable = null;
  let reportedSize = null;
  let immediatePending = false;
  let forceDiscovery = false;
  let watchedId = null;
  let unwatchHost = null;
  let unsubscribe = null;
  const stats = {polls: 0, discoveries: 0, moves: 0, hidden: 0, maxPollMs: 0, maxDiscoveryMs: 0, hostSwitches: 0, events: 0};

  const tickIntervalMs = () => (source
    ? Math.max(50, settings.discoveryIntervalMs)
    : Math.max(10, Math.round(1000 / settings.followHz)));

  // In event mode a full window-tree walk is the expensive part, so it runs on
  // its own slower gate and immediately when a window appears or disappears.
  const discoveryGateMs = () => (source
    ? Math.max(EVENT_FULL_DISCOVERY_MS, settings.discoveryIntervalMs)
    : settings.discoveryIntervalMs);

  // One queued tick at a time. An event that arrives while a tick is running is
  // remembered so the next tick starts as soon as this one finishes.
  function schedule(immediate = false) {
    if (!running) return;
    if (immediate) immediatePending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, immediatePending ? EVENT_COALESCE_MS : tickIntervalMs());
  }

  // Only the chat window is interesting; helper surfaces (the app keeps a
  // handful of 1x1 to 200x200 windows and one taller-than-screen window) are
  // filtered by class, size and visible area.
  async function discover() {
    const startedAt = now();
    const [windows, foundMonitors, foundWorkArea] = await Promise.all([
      runListWindows(),
      runListMonitors(),
      runReadWorkArea().catch(() => null)
    ]);
    monitors = foundMonitors.length > 0 ? foundMonitors : monitors;
    workArea = foundWorkArea ?? workArea;
    const widgetId = port.getWidgetId();
    const candidates = codexWindowCandidates(windows, {
      monitors,
      exclude: [widgetId],
      minVisibleArea: settings.minVisibleArea ?? 1
    });
    const previous = host;
    const chosen = pickHost(candidates, {current: host, switchMargin: settings.switchMargin});
    if (!chosen) {
      host = null;
      stableSamples = 0;
      watchHost();
      return null;
    }
    const info = await runQueryWindow(chosen.id);
    host = {...chosen, ...info, id: chosen.id, name: chosen.name};
    watchHost();
    if (!previous || previous.id !== host.id) {
      stableSamples = 0;
      aboveApplied = false;
      stats.hostSwitches += 1;
      port.log?.('host', {id: host.id, name: host.name, rect: rectOf(host)});
      // The widget has no X id until its window has been shown, which happens
      // after this first discovery; main.js sets the hint again then.
      if (widgetId && widgetId !== '0x0') void runSetTransientFor(widgetId, host.id).catch(() => {});
    }
    const elapsed = now() - startedAt;
    stats.discoveries += 1;
    stats.maxDiscoveryMs = Math.max(stats.maxDiscoveryMs, elapsed);
    return host;
  }

  // Follow the geometry of whichever window is currently the host. The watch
  // only subscribes to StructureNotify, which any client may select on any
  // window, so pointing it at another application's window is allowed.
  function watchHost() {
    if (!source?.watchWindow) return;
    const id = host?.id ?? null;
    if (id === watchedId) return;
    if (unwatchHost) unwatchHost();
    unwatchHost = null;
    watchedId = id;
    if (!id) return;
    unwatchHost = source.watchWindow(id, change => {
      if (change?.kind !== 'configure') return;
      stats.events += 1;
      schedule(true);
    });
  }

  function releaseHost() {
    if (unwatchHost) unwatchHost();
    unwatchHost = null;
    watchedId = null;
  }

  function rectOf(window) {
    return {x: window.x, y: window.y, width: window.width, height: window.height};
  }

  function bounds() {
    if (workArea && workArea.width > 0 && workArea.height > 0 && monitors.length === 0) return [workArea];
    return monitors.length > 0 ? monitors : workArea ? [workArea] : [];
  }

  function hide(reason) {
    missingSince = null;
    stableSamples = 0;
    if (visible) {
      visible = false;
      stats.hidden += 1;
      port.setVisible(false);
      port.onVisibility?.(false);
      port.log?.('hide', {reason});
    }
  }

  async function tick() {
    if (!running) return;
    try {
      const startedAt = now();
      const due = startedAt - lastDiscovery >= discoveryGateMs() || forceDiscovery;
      if (due || !host) {
        lastDiscovery = startedAt;
        forceDiscovery = false;
        await discover();
      } else {
        const info = await runQueryWindow(host.id);
        host = {...host, ...info};
      }
      const elapsed = now() - startedAt;
      stats.polls += 1;
      stats.maxPollMs = Math.max(stats.maxPollMs, elapsed);

      // suspend() stops the loop; a tick that was already in flight must not
      // move the window out from under a drag that started while it waited.
      if (!running) return;

      if (!host || !hostIsVisible(host, bounds())) {
        // A short grace period absorbs transient unmapped samples while the
        // chat window is being resized or moved between monitors.
        const stamp = now();
        if (missingSince === null) missingSince = stamp;
        if (stamp - missingSince >= settings.graceMs) hide('host-unavailable');
        return;
      }
      missingSince = null;
      // Two stable samples keep a loading shell or a tearing-down window from
      // showing the widget, mirroring the Windows readiness check.
      if (stableSamples < settings.readinessSamples) stableSamples += 1;

      if (!settings.above) aboveApplied = true;
      // macOS parity (Placement.usableArea + frame): the widget lives inside
      // host ∩ monitor and shrinks to fit when the chat window is smaller than
      // it is, instead of hanging outside the window.
      usable = usableArea(host, bounds());
      // Diagnostic (GPT_NIANG_FIT_TEST=WxH): pretend the chat window is that
      // small, so the shrink can be checked without resizing a real window.
      if (settings.fitTest) {
        usable = {
          x: usable.x,
          y: usable.y,
          width: Math.min(usable.width, settings.fitTest.width),
          height: Math.min(usable.height, settings.fitTest.height)
        };
      }
      const size = port.getWidgetSize();
      // The canvas is square, so the tighter of the two dimensions is what the
      // window gets; fitting them independently would make the position maths
      // assume a wider window than the one that is really there.
      const fittedArea = fitSize(size, usable, settings.sizeAllowance);
      const side = Math.min(fittedArea.width, fittedArea.height);
      const fitted = size.width === size.height ? {width: side, height: side} : fittedArea;
      if (settings.minSize > 0 && (fitted.width < settings.minSize || fitted.height < settings.minSize)) {
        const tooSmall = now();
        if (missingSince === null) missingSince = tooSmall;
        if (tooSmall - missingSince >= settings.graceMs) hide('host-too-small');
        return;
      }
      // Reported on change, not just when it differs from the configured size:
      // the widget has to grow back once the chat window can hold it again.
      if (!reportedSize || fitted.width !== reportedSize.width || fitted.height !== reportedSize.height) {
        reportedSize = fitted;
        port.setWidgetSize?.({width: fitted.width, height: fitted.height});
      }
      const rect = {...followPosition(usable, fitted, {anchor: settings.anchor, ...settings.offsets}), ...fitted};
      const position = {x: rect.x, y: rect.y};

      // Move before showing so the first frame is already in place.
      if (!samePoint(position, lastPosition)) {
        lastPosition = position;
        stats.moves += 1;
        if (visible) port.move(position.x, position.y);
        else port.moveBeforeShow?.(position.x, position.y);
      }
      if (!visible && stableSamples >= settings.readinessSamples) {
        visible = true;
        port.setVisible(true);
        port.onVisibility?.(true);
      }

      // Cheap verification that the compositor really kept the window above
      // the chat window; a dropped hint is re-applied on the next discovery.
      if (settings.above && !aboveApplied) {
        const atoms = await runReadWindowState(port.getWidgetId()).catch(() => []);
        if (atoms.includes(ABOVE_ATOM)) aboveApplied = true;
        else port.applyAbove?.();
      }
    } catch (error) {
      port.log?.('error', {message: error?.message ?? String(error)});
    } finally {
      const immediate = immediatePending;
      immediatePending = false;
      if (running) schedule(immediate);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastDiscovery = 0;
      if (source?.subscribe) {
        unsubscribe = source.subscribe(change => {
          if (change?.kind === 'windows') forceDiscovery = true;
          schedule(true);
        });
      }
      void tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      releaseHost();
    },
    // Used by the drag handler: while the user is dragging, the widget owns
    // its position and following is suspended.
    suspend() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    resume() {
      if (running) return;
      running = true;
      lastDiscovery = 0;
      void tick();
    },
    get host() {
      return host;
    },
    // The area the widget was last placed in (host ∩ monitor). Drag offsets are
    // measured from this, so the drop position survives the round trip.
    get usable() {
      return usable;
    },
    get visible() {
      return visible;
    },
    // The drag handler moves the widget itself; offsets are persisted instead.
    reposition() {
      lastPosition = null;
    },
    setAnchor(anchor) {
      settings.anchor = anchor;
    },
    get anchor() {
      return settings.anchor;
    },
    setOffsets(offsets) {
      Object.assign(settings.offsets, offsets);
    },
    stats
  };
}

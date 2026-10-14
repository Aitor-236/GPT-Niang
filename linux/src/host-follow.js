// Keeps the widget attached to the Codex chat window.
//
// The Windows build uses WinEvent hooks and the macOS build samples the
// WindowServer. Neither exists here, so this is a single polling loop: window
// discovery at a low rate, geometry sampling at a higher rate, exactly like
// the macOS port (polling, not a zero-lag attachment guarantee).

import {
  listWindows,
  listMonitors,
  queryWindow,
  readWorkArea,
  readWindowState,
  setTransientFor
} from './x11.js';
import {
  clampToMonitors,
  codexWindowCandidates,
  followPosition,
  hostIsVisible,
  pickHost,
  samePoint
} from './geometry.js';

export const FOLLOW_DEFAULTS = {
  followHz: 30,
  discoveryIntervalMs: 250,
  graceMs: 750,
  readinessSamples: 2,
  anchor: 'left',
  offsets: {left: 12, right: 12, bottom: 12},
  above: true
};

const ABOVE_ATOM = '_NET_WM_STATE_ABOVE';

export function createHostFollower(port, options = {}) {
  const settings = {
    ...FOLLOW_DEFAULTS,
    ...options,
    offsets: {...FOLLOW_DEFAULTS.offsets, ...(options.offsets ?? {})}
  };
  const tools = settings.tools ?? {};
  const runListWindows = tools.listWindows ?? listWindows;
  const runListMonitors = tools.listMonitors ?? listMonitors;
  const runQueryWindow = tools.queryWindow ?? queryWindow;
  const runReadWorkArea = tools.readWorkArea ?? readWorkArea;
  const runReadWindowState = tools.readWindowState ?? readWindowState;
  const runSetTransientFor = tools.setTransientFor ?? setTransientFor;
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
  const stats = {polls: 0, discoveries: 0, moves: 0, hidden: 0, maxPollMs: 0, maxDiscoveryMs: 0, hostSwitches: 0};

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
      return null;
    }
    const info = await runQueryWindow(chosen.id);
    host = {...chosen, ...info, id: chosen.id, name: chosen.name};
    if (!previous || previous.id !== host.id) {
      stableSamples = 0;
      aboveApplied = false;
      stats.hostSwitches += 1;
      port.log?.('host', {id: host.id, name: host.name, rect: rectOf(host)});
      void runSetTransientFor(widgetId, host.id).catch(() => {});
    }
    const elapsed = now() - startedAt;
    stats.discoveries += 1;
    stats.maxDiscoveryMs = Math.max(stats.maxDiscoveryMs, elapsed);
    return host;
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
      if (startedAt - lastDiscovery >= settings.discoveryIntervalMs) {
        lastDiscovery = startedAt;
        await discover();
      } else if (host) {
        const info = await runQueryWindow(host.id);
        host = {...host, ...info};
      }
      const elapsed = now() - startedAt;
      stats.polls += 1;
      stats.maxPollMs = Math.max(stats.maxPollMs, elapsed);

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
      const size = port.getWidgetSize();
      const rect = clampToMonitors(
        {...followPosition(host, size, {anchor: settings.anchor, ...settings.offsets}), ...size},
        bounds()
      );
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
      if (running) timer = setTimeout(tick, Math.max(10, Math.round(1000 / settings.followHz)));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastDiscovery = 0;
      void tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
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

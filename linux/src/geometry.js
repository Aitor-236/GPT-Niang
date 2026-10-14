// Pure geometry for host-window discovery, following and clamping.
// No Electron and no process spawning here: every function takes plain data so
// the behaviour stays testable without a display.

export const MIN_HOST_WIDTH = 400;
export const MIN_HOST_HEIGHT = 300;
// A host smaller than this is treated as "not really on screen" (loading
// shells, tearing down windows) and hides the widget.
export const MIN_VISIBLE_HOST_EDGE = 64;

export function intersects(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  return {x: left, y: top, width: right - left, height: bottom - top};
}

export function visibleArea(rect, monitors) {
  if (!rect || monitors.length === 0) return 0;
  return monitors.reduce((total, monitor) => {
    const overlap = intersects(rect, monitor);
    return overlap ? total + overlap.width * overlap.height : total;
  }, 0);
}

// The desktop client keeps more than one X11 window alive: a real chat window
// plus helper surfaces, including one that is deliberately taller than the
// screen. Choosing by visible area picks the chat window without hardcoding
// its size or stacking position.
export function codexWindowCandidates(windows, {monitors = [], exclude = [], minVisibleArea = 0} = {}) {
  const excluded = new Set(exclude.filter(Boolean).map(value => value.toLowerCase()));
  return windows
    .filter(window => !excluded.has(window.id.toLowerCase()))
    .filter(window => /codex|chatgpt/i.test(window.instance) || /codex|chatgpt/i.test(window.className))
    .filter(window => window.width >= MIN_HOST_WIDTH && window.height >= MIN_HOST_HEIGHT)
    .map(window => ({...window, visible: visibleArea(window, monitors)}))
    .filter(window => window.visible >= minVisibleArea)
    .sort((a, b) => b.visible - a.visible || b.width * b.height - a.width * a.height);
}

// Hysteresis: keep the current host unless another candidate is clearly
// larger, so two similar windows cannot make the widget jump between them.
export function pickHost(candidates, {current = null, switchMargin = 1.25} = {}) {
  if (candidates.length === 0) return null;
  if (!current) return candidates[0];
  const kept = candidates.find(candidate => candidate.id === current.id);
  if (!kept) return candidates[0];
  const best = candidates[0];
  return best.visible > kept.visible * switchMargin ? best : kept;
}

export function hostIsVisible(host, monitors) {
  if (!host || !host.viewable) return false;
  if (host.width < MIN_VISIBLE_HOST_EDGE || host.height < MIN_VISIBLE_HOST_EDGE) return false;
  return visibleArea(host, monitors) > 0;
}

// Mirrors the Windows build: `left` / `right` / `bottom` are the user's drag
// offsets from the matching host edge, and the anchor decides which side they
// are measured from.
export function followPosition(host, size, {anchor = 'left', left = 12, right = 12, bottom = 12} = {}) {
  const rawX = anchor === 'right'
    ? host.x + host.width - size.width - right
    : host.x + left;
  const rawY = Math.max(host.y, host.y + host.height - size.height - bottom);
  const maxX = host.x + host.width - size.width;
  const maxY = host.y + host.height - size.height;
  return {
    x: Math.round(Math.min(Math.max(rawX, host.x), Math.max(host.x, maxX))),
    y: Math.round(Math.min(Math.max(rawY, host.y), Math.max(host.y, maxY)))
  };
}

export function clampToMonitors(rect, monitors) {
  if (monitors.length === 0) return rect;
  const containing = monitors.find(monitor =>
    rect.x >= monitor.x && rect.y >= monitor.y &&
    rect.x + rect.width <= monitor.x + monitor.width &&
    rect.y + rect.height <= monitor.y + monitor.height);
  if (containing) return rect;
  const target = monitors
    .map(monitor => ({monitor, overlap: intersects(rect, monitor)}))
    .filter(entry => entry.overlap)
    .sort((a, b) => b.overlap.width * b.overlap.height - a.overlap.width * a.overlap.height)[0]?.monitor ?? monitors[0];
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(rect.x, target.x), target.x + target.width - rect.width)),
    y: Math.round(Math.min(Math.max(rect.y, target.y), target.y + target.height - rect.height))
  };
}

// Snapping keeps the character facing into the window, matching the desktop
// and macOS builds.
export function snappedAnchor(x, width, host) {
  const center = x + width / 2;
  const hostCenter = host.x + host.width / 2;
  return center < hostCenter ? 'left' : 'right';
}

export function samePoint(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y;
}

// The widget watchdog asks this before it re-applies the window size. Chromium
// rounds the pixel size up to the device grid (a 350 DIP window is ~440 px on a
// 1.25 display), so a few pixels of difference is normal and correcting it
// would resize the window on every tick.
export function sizeDriftExceeds(actual, desiredPixels, tolerance) {
  if (!actual || !Number.isFinite(desiredPixels)) return false;
  return Math.abs(actual.width - desiredPixels) > tolerance || Math.abs(actual.height - desiredPixels) > tolerance;
}

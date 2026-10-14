// Minimal X11 access for the widget.
//
// The Codex desktop client runs as an X11 client under XWayland on this
// machine, so its geometry is readable and our own window can be positioned.
// A Wayland-native client could do neither, which is why the app pins the
// X11 backend at startup (see src/main.js).
//
// Everything here shells out to xwininfo/xprop/xrandr instead of linking
// against Xlib: the tools ship with X11, the widget only asks for a few
// fields, and keeping the parsing pure makes it testable without a display.

import {execFile} from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFER = 4 * 1024 * 1024;

// xprop reports a missing property with a non-zero exit status while still
// printing the reason, so stdout presence decides success here.
export function runTool(command, args, {timeout = DEFAULT_TIMEOUT_MS} = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8'}, (error, stdout) => {
      if (error && !stdout) {
        reject(error);
        return;
      }
      resolve(stdout ?? '');
    });
  });
}

// xwininfo writes negative coordinates as the sign run "+-980", so a signed
// field is an optional sign followed by an optional minus and the digits.
const SIGNED = '([+-]?-?\\d+)';
const WINDOW_LINE = new RegExp(
  '^(0x[0-9a-fA-F]+)\\s+"([^"]*)":\\s+\\((?:"([^"]*)"\\s+"([^"]*)")?\\)\\s+(\\d+)x(\\d+)' + SIGNED + SIGNED + '\\s+' + SIGNED + SIGNED
);
const NAMELESS_WINDOW_LINE = new RegExp(
  '^(0x[0-9a-fA-F]+)\\s+\\(has no name\\):\\s+\\(\\)\\s+(\\d+)x(\\d+)' + SIGNED + SIGNED + '\\s+' + SIGNED + SIGNED
);

const toNumber = value => Number.parseInt(value, 10);

// `xwininfo -root -tree` lists the root's children first, then their
// descendants at a deeper indentation. Only the direct children are top-level
// windows, so the shallowest matched indentation wins.
export function parseWindowTree(output) {
  const matched = [];
  for (const rawLine of String(output).split('\n')) {
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    let entry = null;
    const named = WINDOW_LINE.exec(line);
    if (named) {
      entry = {
        id: named[1].toLowerCase(),
        name: named[2],
        instance: named[3] ?? '',
        className: named[4] ?? '',
        width: toNumber(named[5]),
        height: toNumber(named[6]),
        x: toNumber(named[9]),
        y: toNumber(named[10])
      };
    } else {
      const nameless = NAMELESS_WINDOW_LINE.exec(line);
      if (nameless) {
        entry = {
          id: nameless[1].toLowerCase(),
          name: null,
          instance: '',
          className: '',
          width: toNumber(nameless[2]),
          height: toNumber(nameless[3]),
          x: toNumber(nameless[6]),
          y: toNumber(nameless[7])
        };
      }
    }
    if (entry) matched.push({indent, entry});
  }
  if (matched.length === 0) return [];
  const shallowest = Math.min(...matched.map(item => item.indent));
  return matched.filter(item => item.indent === shallowest).map(item => item.entry);
}

export function parseWindowInfo(output) {
  const fields = new Map();
  for (const line of String(output).split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const number = key => {
    const value = fields.get(key);
    if (value === undefined) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const mapState = fields.get('Map State') ?? null;
  return {
    x: number('Absolute upper-left X'),
    y: number('Absolute upper-left Y'),
    width: number('Width'),
    height: number('Height'),
    mapState,
    viewable: mapState === 'IsViewable',
    overrideRedirect: fields.get('Override Redirect State') === 'yes'
  };
}

export function parseMonitors(output) {
  const monitors = [];
  const pattern = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)/;
  for (const line of String(output).split('\n')) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    monitors.push({
      name: match[1],
      primary: Boolean(match[2]),
      x: toNumber(match[5]),
      y: toNumber(match[6]),
      width: toNumber(match[3]),
      height: toNumber(match[4])
    });
  }
  return monitors;
}

// GNOME reports the full screen here rather than a panel-reduced area, so this
// is a refinement of the monitor bounds, never a replacement for them.
export function parseWorkArea(output) {
  const match = /_NET_WORKAREA\(CARDINAL\)\s*=\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+)/.exec(String(output));
  if (!match) return null;
  return {
    x: toNumber(match[1]),
    y: toNumber(match[2]),
    width: toNumber(match[3]),
    height: toNumber(match[4])
  };
}

export function parseStateAtoms(output) {
  const match = /_NET_WM_STATE\(ATOM\)\s*=\s*(.*)$/m.exec(String(output));
  if (!match) return [];
  return match[1]
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0 && value !== 'not found.');
}

export function parseTransientFor(output) {
  // xprop reports window-valued properties as "WM_TRANSIENT_FOR(WINDOW): window id # 0x…".
  const match = /WM_TRANSIENT_FOR(?:\(WINDOW\))?\s*[:=]\s*(?:window id #\s*)?(0x[0-9a-fA-F]+)/.exec(String(output));
  return match ? match[1].toLowerCase() : null;
}

// Electron hands out the X window id as a little-endian buffer.
export function windowHandleToXid(handle) {
  if (!handle || handle.length === 0) return null;
  if (handle.length >= 8) return '0x' + handle.readBigUInt64LE(0).toString(16);
  return '0x' + handle.readUInt32LE(0).toString(16);
}

export async function listWindows(options = {}) {
  const run = options.run ?? runTool;
  return parseWindowTree(await run('xwininfo', ['-root', '-tree']));
}

export async function queryWindow(id, options = {}) {
  const run = options.run ?? runTool;
  return parseWindowInfo(await run('xwininfo', ['-id', id]));
}

export async function listMonitors(options = {}) {
  const run = options.run ?? runTool;
  return parseMonitors(await run('xrandr', ['--query']));
}

export async function readWorkArea(options = {}) {
  const run = options.run ?? runTool;
  try {
    return parseWorkArea(await run('xprop', ['-root', '_NET_WORKAREA']));
  } catch {
    return null;
  }
}

export async function readWindowState(id, options = {}) {
  const run = options.run ?? runTool;
  try {
    return parseStateAtoms(await run('xprop', ['-id', id, '_NET_WM_STATE']));
  } catch {
    return [];
  }
}

// Making the widget a transient of the chat window is the closest X11
// equivalent of the Windows build's owner-window trick. It is best effort:
// mutter may ignore a hint set after the window is mapped.
export async function setTransientFor(id, hostId, options = {}) {
  const run = options.run ?? runTool;
  try {
    await run('xprop', ['-id', id, '-f', 'WM_TRANSIENT_FOR', '32x', '-set', 'WM_TRANSIENT_FOR', hostId]);
    return true;
  } catch {
    return false;
  }
}

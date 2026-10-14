// Long-lived X11 connection for the widget.
//
// ./x11.js shells out to xwininfo/xprop/xrandr. That keeps the parsing pure and
// needs no dependency, but every question forks a process: one `xwininfo -id`
// measures 5-6 ms on this desktop (24 ms under load), and the follower asked
// for a sample 30 times a second plus a window-tree walk four times a second.
// That traffic competes with the widget's own software compositing, which is
// part of why the widget looked like it was trailing the chat window.
//
// This module keeps one socket open and asks the server directly instead. The
// events that matter arrive on their own: ConfigureNotify for the window being
// followed, substructure changes on the root, PropertyNotify for _NET_WORKAREA.
// The `x11` package is pure JavaScript with no runtime dependencies, and
// ./x11.js stays in the tree as the fallback for when this cannot connect.

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

// AnyPropertyType: properties are read without asserting their type, exactly
// as `xprop <atom>` does.
const ANY_PROPERTY_TYPE = 0;
// Long offset/length are counted in 4-byte units; this is the largest value
// libX11 itself passes when it wants the whole property.
const WHOLE_PROPERTY = 0x1fffffff;
// GetWindowAttributes.mapState: 0 IsUnmapped, 1 IsUnviewable, 2 IsViewable.
const MAP_STATE_UNMAPPED = 0;
const MAP_STATE_VIEWABLE = 2;
const WINDOW_TYPE = 33;

const ATOM_NAMES = {
  wmClass: 'WM_CLASS',
  wmName: 'WM_NAME',
  wmTransientFor: 'WM_TRANSIENT_FOR',
  netWmState: '_NET_WM_STATE',
  netWorkArea: '_NET_WORKAREA'
};

export function toXid(value) {
  if (typeof value === 'number') return value >>> 0;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim().replace(/^0x/i, ''), 16);
    return Number.isFinite(parsed) ? parsed >>> 0 : 0;
  }
  return 0;
}

export function fromXid(value) {
  return '0x' + (value >>> 0).toString(16);
}

export function loadX11Module() {
  try {
    return {module: require('x11')};
  } catch (error) {
    return {error};
  }
}

// `x11` delivers every selected event on one client-wide stream. A
// ConfigureNotify about a child is reported with the child in `wid1`; the same
// event delivered to the window itself carries it in `wid`.
export function eventWindow(event) {
  return (event?.wid1 ?? event?.wid ?? 0) >>> 0;
}

export function parseClassProperty(buffer) {
  if (!buffer || buffer.length === 0) return {instance: '', className: ''};
  const parts = buffer.toString('latin1').split('\u0000').filter(part => part.length > 0);
  return {instance: parts[0] ?? '', className: parts[1] ?? parts[0] ?? ''};
}

export function parseWorkAreaProperty(buffer) {
  if (!buffer || buffer.length < 16) return null;
  return {
    x: buffer.readInt32LE(0),
    y: buffer.readInt32LE(4),
    width: buffer.readUInt32LE(8),
    height: buffer.readUInt32LE(12)
  };
}

export function parseAtomListProperty(buffer) {
  if (!buffer) return [];
  const atoms = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) atoms.push(buffer.readUInt32LE(offset) >>> 0);
  return atoms;
}

export function createX11Connection({
  display = process.env.DISPLAY,
  log = () => {},
  load = loadX11Module
} = {}) {
  const atoms = new Map();
  const atomNames = new Map();
  // Class/map-state cache: these do not change while a window lives, and each
  // lookup costs a round trip on the window-tree walk.
  const windows = new Map();
  // Per-window event interest. Selecting events replaces the window's whole
  // mask (per client), so a second subscriber must not drop the first one's.
  const watchers = new Map();
  const changeHandlers = new Set();

  let client = null;
  let moduleRef = null;
  let root = 0;
  let connected = false;
  let closing = false;
  let workArea = null;
  let screens = [];

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!client) {
        reject(new Error('X11 connection is not open'));
        return;
      }
      try {
        client[method](...args, (error, result) => {
          if (error) reject(error);
          else resolve(result);
          // An X error is reported through the reply callback of the request
          // that caused it; returning true marks it as handled so the client
          // does not also emit a connection-level 'error' for it.
          return true;
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function notifyChange(change) {
    for (const handler of [...changeHandlers]) {
      try {
        handler(change);
      } catch (error) {
        log('x11-change-error', {message: error?.message ?? String(error)});
      }
    }
  }

  function notifyWindow(id, change) {
    const entry = watchers.get(id);
    if (!entry) return;
    for (const handler of [...entry.handlers]) {
      try {
        handler(change);
      } catch (error) {
        log('x11-watch-error', {message: error?.message ?? String(error)});
      }
    }
  }

  function handleEvent(event) {
    switch (event?.name) {
      case 'ConfigureNotify': {
        const id = eventWindow(event);
        notifyWindow(id, {kind: 'configure', id: fromXid(id), x: event.x, y: event.y, width: event.width, height: event.height});
        notifyChange({kind: 'configure', id: fromXid(id)});
        return;
      }
      case 'CreateNotify': {
        const id = eventWindow(event);
        // A new window has no cached class/map state yet; the next walk fills
        // them in.
        windows.delete(id);
        notifyChange({kind: 'windows', id: fromXid(id)});
        return;
      }
      case 'DestroyNotify': {
        const id = eventWindow(event);
        windows.delete(id);
        notifyChange({kind: 'windows', id: fromXid(id)});
        return;
      }
      case 'MapNotify': {
        const id = eventWindow(event);
        const entry = windows.get(id);
        if (entry) entry.mapState = MAP_STATE_VIEWABLE;
        notifyChange({kind: 'windows', id: fromXid(id)});
        return;
      }
      case 'UnmapNotify': {
        const id = eventWindow(event);
        const entry = windows.get(id);
        if (entry) entry.mapState = MAP_STATE_UNMAPPED;
        notifyChange({kind: 'windows', id: fromXid(id)});
        return;
      }
      case 'PropertyNotify': {
        const id = eventWindow(event);
        if (id === root) {
          if (event.atom === atoms.get(ATOM_NAMES.netWorkArea)) {
            void readWorkAreaProperty().then(area => {
              workArea = area ?? workArea;
              notifyChange({kind: 'work-area', area: workArea});
            });
          }
          return;
        }
        // WM_CLASS is cached; a change means the cache is stale.
        if (event.atom === atoms.get(ATOM_NAMES.wmClass)) windows.delete(id);
        notifyChange({kind: 'property', id: fromXid(id)});
        return;
      }
      default:
    }
  }

  async function internAtom(name) {
    if (atoms.has(name)) return atoms.get(name);
    const atom = await call('InternAtom', false, name);
    if (typeof atom !== 'number') throw new Error(`could not intern ${name}`);
    atoms.set(name, atom);
    atomNames.set(atom, name);
    return atom;
  }

  async function atomName(atom) {
    if (atomNames.has(atom)) return atomNames.get(atom);
    try {
      const name = await call('GetAtomName', atom);
      if (typeof name !== 'string') return null;
      atomNames.set(atom, name);
      return name;
    } catch {
      return null;
    }
  }

  async function getProperty(id, name) {
    const atom = await internAtom(name);
    const result = await call('GetProperty', 0, id, atom, ANY_PROPERTY_TYPE, 0, WHOLE_PROPERTY);
    return result && result.data.length > 0 ? result : null;
  }

  async function readWorkAreaProperty() {
    try {
      const result = await getProperty(root, ATOM_NAMES.netWorkArea);
      return result ? parseWorkAreaProperty(result.data) : null;
    } catch {
      return null;
    }
  }

  async function geometryOf(idValue) {
    const id = toXid(idValue);
    const [translate, geometry] = await Promise.all([
      call('TranslateCoordinates', id, root, 0, 0),
      call('GetGeometry', id)
    ]);
    return {x: translate.destX, y: translate.destY, width: geometry.width, height: geometry.height};
  }

  // The pointer's position in root (physical) pixels, straight from the server.
  //
  // Electron's screen.getCursorScreenPoint() is not usable for this: Chromium
  // only refreshes its idea of the pointer from input events delivered to *its*
  // windows, and the widget's window deliberately has an empty input shape while
  // it is passing clicks through. The value is then frozen at whatever it was
  // when the app started, so asking it "is the cursor over the character?" can
  // never say yes - a chicken and egg problem the input shape can never leave.
  async function cursor() {
    const pointer = await call('QueryPointer', root);
    return {x: pointer.rootX, y: pointer.rootY};
  }

  // Class and map state for one window, cached for the window's lifetime.
  async function windowInfo(id) {
    let entry = windows.get(id);
    if (entry) return entry;
    const [attributes, classProperty] = await Promise.all([
      call('GetWindowAttributes', id).catch(() => null),
      getProperty(id, ATOM_NAMES.wmClass).catch(() => null)
    ]);
    const parsed = parseClassProperty(classProperty?.data);
    entry = {
      instance: parsed.instance,
      className: parsed.className,
      mapState: attributes ? attributes.mapState : null,
      overrideRedirect: Boolean(attributes?.overrideRedirect),
      name: undefined
    };
    windows.set(id, entry);
    return entry;
  }

  function shape(id, entry, geometry) {
    return {
      id: fromXid(id),
      name: entry.name ?? null,
      instance: entry.instance ?? '',
      className: entry.className ?? '',
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      mapState: entry.mapState === MAP_STATE_VIEWABLE ? 'IsViewable' : entry.mapState === null ? null : 'IsUnmapped',
      viewable: entry.mapState === MAP_STATE_VIEWABLE,
      overrideRedirect: Boolean(entry.overrideRedirect)
    };
  }

  // Same shape as ./x11.js listWindows(): the root's children with the fields
  // the candidate filter and the visible-area comparison read.
  async function listWindows() {
    const tree = await call('QueryTree', root);
    const children = tree?.children ?? [];
    const infos = await Promise.all(children.map(id => windowInfo(id).catch(() => null)));
    const geometries = await Promise.all(children.map(id => geometryOf(id).catch(() => null)));
    const result = [];
    for (let index = 0; index < children.length; index += 1) {
      if (infos[index] && geometries[index]) result.push(shape(children[index], infos[index], geometries[index]));
    }
    return result;
  }

  async function queryWindow(idValue) {
    const id = toXid(idValue);
    const entry = await windowInfo(id);
    const geometry = await geometryOf(id);
    if (entry.name === undefined) {
      const name = await getProperty(id, ATOM_NAMES.wmName).catch(() => null);
      entry.name = name ? name.data.toString('latin1').replace(/\u0000[\s\S]*$/, '') : null;
    }
    return shape(id, entry, geometry);
  }

  async function readWindowState(idValue) {
    try {
      const result = await getProperty(toXid(idValue), ATOM_NAMES.netWmState);
      if (!result) return [];
      const names = await Promise.all(parseAtomListProperty(result.data).map(atom => atomName(atom)));
      return names.filter(Boolean);
    } catch {
      return [];
    }
  }

  async function setTransientFor(idValue, hostValue) {
    try {
      const property = await internAtom(ATOM_NAMES.wmTransientFor);
      await call('ChangeProperty', 0, toXid(idValue), property, WINDOW_TYPE, 32, [toXid(hostValue)]);
      return true;
    } catch (error) {
      log('x11-transient-failed', {message: error?.message ?? String(error)});
      return false;
    }
  }

  // Read back WM_TRANSIENT_FOR: the hint is only useful if the window manager
  // kept it, and the widget's z-order policy depends on that answer.
  async function transientFor(idValue) {
    try {
      const result = await getProperty(toXid(idValue), ATOM_NAMES.wmTransientFor);
      if (!result || result.data.length < 4) return null;
      const owner = result.data.readUInt32LE(0) >>> 0;
      return owner === 0 ? null : fromXid(owner);
    } catch {
      return null;
    }
  }

  async function applyMask(id) {
    const entry = watchers.get(id);
    try {
      await call('ChangeWindowAttributes', id, {eventMask: entry ? entry.mask : 0});
    } catch (error) {
      log('x11-watch-failed', {id: fromXid(id), message: error?.message ?? String(error)});
    }
  }

  function watchWindow(idValue, handler) {
    const id = toXid(idValue);
    let entry = watchers.get(id);
    if (!entry) {
      entry = {mask: moduleRef?.eventMask?.StructureNotify ?? 0, handlers: new Set()};
      watchers.set(id, entry);
      void applyMask(id);
    }
    entry.handlers.add(handler);
    return () => {
      const current = watchers.get(id);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        watchers.delete(id);
        void applyMask(id);
      }
    };
  }

  function subscribe(handler) {
    changeHandlers.add(handler);
    return () => changeHandlers.delete(handler);
  }

  function close() {
    closing = true;
    connected = false;
    changeHandlers.clear();
    watchers.clear();
    windows.clear();
    atoms.clear();
    atomNames.clear();
    try {
      client?.terminate();
    } catch {}
    client = null;
  }

  async function connect() {
    const loaded = load();
    if (loaded.error || typeof loaded.module?.createClient !== 'function') {
      throw loaded.error ?? new Error('the x11 package did not expose createClient');
    }
    moduleRef = loaded.module;
    const display_ = await new Promise((resolve, reject) => {
      moduleRef.createClient({display}, (error, value) => (error ? reject(error) : resolve(value)));
    });
    client = display_.client;
    screens = display_.screen ?? [];
    root = screens[0]?.root ?? 0;
    client.on('error', error => log('x11-error', {message: error?.message ?? String(error)}));
    client.on('end', () => {
      connected = false;
      if (!closing) log('x11-disconnected', {});
    });
    client.on('event', handleEvent);
    connected = true;
    // Root substructure events drive host discovery; PropertyChange delivers
    // _NET_WORKAREA updates. A window's event mask is per client, so selecting
    // on the root cannot disturb the window manager.
    const mask = moduleRef.eventMask;
    await call('ChangeWindowAttributes', root, {eventMask: mask.SubstructureNotify | mask.PropertyChange});
    for (const name of [ATOM_NAMES.netWorkArea, ATOM_NAMES.wmClass, ATOM_NAMES.wmTransientFor, ATOM_NAMES.netWmState]) {
      await internAtom(name);
    }
    workArea = await readWorkAreaProperty();
    log('x11-connected', {root: fromXid(root), workArea});
    return {root: fromXid(root), screens};
  }

  return {
    connect,
    isConnected: () => connected,
    listWindows,
    queryWindow,
    geometryOf,
    cursor,
    readWorkArea: async () => {
      workArea = (await readWorkAreaProperty()) ?? workArea;
      return workArea;
    },
    readWindowState,
    setTransientFor,
    transientFor,
    watchWindow,
    subscribe,
    close
  };
}

// The follower's `source` shape: the same tool functions it takes from
// ./x11.js, plus change notifications and per-window watches.
export function createEventSource(connection) {
  return {
    listWindows: () => connection.listWindows(),
    queryWindow: id => connection.queryWindow(id),
    readWorkArea: () => connection.readWorkArea(),
    readWindowState: id => connection.readWindowState(id),
    setTransientFor: (id, hostId) => connection.setTransientFor(id, hostId),
    watchWindow: (id, handler) => connection.watchWindow(id, handler),
    subscribe: handler => connection.subscribe(handler),
    cursor: () => connection.cursor(),
    ownGeometry: id => connection.geometryOf(id)
  };
}

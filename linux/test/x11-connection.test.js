import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEventSource,
  createX11Connection,
  eventWindow,
  fromXid,
  parseAtomListProperty,
  parseClassProperty,
  parseWorkAreaProperty,
  toXid
} from '../src/x11-connection.js';

const ROOT = 0x379;
const HOST = 0xe00004;
const WIDGET = 0x42;

const EVENT_MASK = {StructureNotify: 0x20000, SubstructureNotify: 0x80000, PropertyChange: 0x400000};

// A fake X client: enough of the request/reply surface for the connection to
// run, and a record of every request so the tests can assert on the masks and
// properties that were actually sent.
function fakeX() {
  const requests = [];
  const listeners = new Map();
  const atomIds = new Map();
  const atomNames = new Map();
  let nextAtom = 0x100;
  const atomFor = name => {
    if (!atomIds.has(name)) {
      const id = nextAtom++;
      atomIds.set(name, id);
      atomNames.set(id, name);
    }
    return atomIds.get(name);
  };
  const client = {
    requests,
    on(event, handler) {
      listeners.set(event, handler);
    },
    emit(event, payload) {
      listeners.get(event)?.(payload);
    },
    InternAtom(onlyIfExists, name, cb) {
      requests.push({method: 'InternAtom', args: [onlyIfExists, name]});
      cb(null, atomFor(name));
    },
    ChangeWindowAttributes(wid, values, cb) {
      requests.push({method: 'ChangeWindowAttributes', args: [wid, values]});
      cb(null, true);
    },
    ChangeProperty(mode, wid, name, type, format, data, cb) {
      requests.push({method: 'ChangeProperty', args: [mode, wid, name, type, format, data]});
      cb(null, true);
    },
    GetProperty(alwaysZero, wid, name, type, offset, length, cb) {
      requests.push({method: 'GetProperty', args: [wid, name]});
      const property = atomNames.get(name);
      if (property === '_NET_WORKAREA') {
        const data = Buffer.alloc(16);
        data.writeInt32LE(0, 0);
        data.writeInt32LE(0, 4);
        data.writeUInt32LE(2560, 8);
        data.writeUInt32LE(1440, 12);
        return cb(null, {type: 6, format: 32, data, bytesAfter: 0});
      }
      if (property === 'WM_CLASS') {
        return cb(null, {type: 31, format: 8, data: Buffer.from('gpt-niang-usage\u0000Gpt-Niang\u0000', 'latin1'), bytesAfter: 0});
      }
      if (property === 'WM_NAME') return cb(null, {type: 39, format: 8, data: Buffer.from('ChatGPT\u0000', 'latin1'), bytesAfter: 0});
      if (property === '_NET_WM_STATE') return cb(null, {type: 4, format: 32, data: Buffer.from([0x11, 0, 0, 0, 0x22, 0, 0, 0]), bytesAfter: 0});
      return cb(null, {type: 0, format: 0, data: Buffer.alloc(0), bytesAfter: 0});
    },
    GetAtomName(atom, cb) {
      requests.push({method: 'GetAtomName', args: [atom]});
      cb(null, atom === 0x11 ? '_NET_WM_STATE_ABOVE' : 'UNKNOWN');
    },
    QueryTree(wid, cb) {
      requests.push({method: 'QueryTree', args: [wid]});
      cb(null, {root: ROOT, parent: 0, children: [HOST, WIDGET]});
    },
    GetWindowAttributes(wid, cb) {
      requests.push({method: 'GetWindowAttributes', args: [wid]});
      cb(null, {mapState: wid === HOST ? 2 : 0, overrideRedirect: false});
    },
    TranslateCoordinates(src, dst, x, y, cb) {
      requests.push({method: 'TranslateCoordinates', args: [src, dst, x, y]});
      cb(null, {sameScreen: true, child: 0, destX: src === HOST ? 55 : 150, destY: 21});
    },
    GetGeometry(drawable, cb) {
      requests.push({method: 'GetGeometry', args: [drawable]});
      cb(null, {depth: 24, windowid: drawable, xPos: 0, yPos: 0, width: drawable === HOST ? 2209 : 440, height: drawable === HOST ? 1369 : 440, borderWidth: 0});
    }
  };
  const module = {
    eventMask: EVENT_MASK,
    createClient(_options, cb) {
      setImmediate(() => cb(null, {client, screen: [{root: ROOT, pixel_width: 2560, pixel_height: 1440}]}));
    }
  };
  return {client, module};
}

function connect(fake) {
  return createX11Connection({log: () => {}, load: () => ({module: fake.module})});
}

test('xid helpers round-trip the hex strings ./x11.js produces', () => {
  assert.equal(toXid('0xe00004'), HOST);
  assert.equal(toXid(HOST), HOST);
  assert.equal(toXid('nonsense'), 0);
  assert.equal(fromXid(HOST), '0xe00004');
});

test('property parsers handle what the server actually returns', () => {
  assert.deepEqual(parseClassProperty(Buffer.from('chatgpt (/home/a/.config/Codex)\u0000Chatgpt\u0000', 'latin1')), {
    instance: 'chatgpt (/home/a/.config/Codex)',
    className: 'Chatgpt'
  });
  assert.deepEqual(parseClassProperty(null), {instance: '', className: ''});

  const area = Buffer.alloc(16);
  area.writeInt32LE(0, 0);
  area.writeInt32LE(0, 4);
  area.writeUInt32LE(2560, 8);
  area.writeUInt32LE(1440, 12);
  assert.deepEqual(parseWorkAreaProperty(area), {x: 0, y: 0, width: 2560, height: 1440});
  assert.equal(parseWorkAreaProperty(Buffer.alloc(4)), null);

  assert.deepEqual(parseAtomListProperty(Buffer.from([0x11, 0, 0, 0, 0x22, 0, 0, 0])), [0x11, 0x22]);
});

test('eventWindow reads the window a ConfigureNotify is about', () => {
  assert.equal(eventWindow({wid: ROOT, wid1: HOST}), HOST);
  assert.equal(eventWindow({wid: HOST}), HOST);
  assert.equal(eventWindow({}), 0);
});

test('connect subscribes to root substructure and property changes', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  const info = await connection.connect();
  assert.equal(info.root, '0x379');
  assert.equal(connection.isConnected(), true);
  const rootMask = fake.client.requests.find(request => request.method === 'ChangeWindowAttributes' && request.args[0] === ROOT);
  assert.equal(rootMask.args[1].eventMask, EVENT_MASK.SubstructureNotify | EVENT_MASK.PropertyChange);
});

test('listWindows mirrors the xwininfo shape and caches per-window attributes', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  const windows = await connection.listWindows();
  assert.equal(windows.length, 2);
  const host = windows.find(window => window.id === '0xe00004');
  assert.deepEqual(
    {instance: host.instance, className: host.className, x: host.x, y: host.y, width: host.width, height: host.height, viewable: host.viewable},
    {instance: 'gpt-niang-usage', className: 'Gpt-Niang', x: 55, y: 21, width: 2209, height: 1369, viewable: true}
  );
  const widget = windows.find(window => window.id === '0x42');
  assert.equal(widget.viewable, false);

  const before = fake.client.requests.filter(request => request.method === 'GetWindowAttributes').length;
  await connection.listWindows();
  const after = fake.client.requests.filter(request => request.method === 'GetWindowAttributes').length;
  assert.equal(after, before, 'attributes are read once per window, not on every walk');
});

test('watchWindow keeps the union of subscribers and clears the mask again', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  const first = connection.watchWindow(HOST, () => {});
  const masksFor = () => fake.client.requests
    .filter(request => request.method === 'ChangeWindowAttributes' && request.args[0] === HOST)
    .map(request => request.args[1].eventMask);
  assert.deepEqual(masksFor(), [EVENT_MASK.StructureNotify]);
  const second = connection.watchWindow(HOST, () => {});
  assert.deepEqual(masksFor(), [EVENT_MASK.StructureNotify], 'a second watcher does not re-select');
  first();
  assert.deepEqual(masksFor(), [EVENT_MASK.StructureNotify], 'the remaining watcher keeps its mask');
  second();
  assert.deepEqual(masksFor().at(-1), 0, 'the last watcher clears the mask');
});

test('a ConfigureNotify for a watched window reaches its handler', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  const seen = [];
  const unwatch = connection.watchWindow(HOST, change => seen.push(change));
  fake.client.emit('event', {name: 'ConfigureNotify', wid: HOST, wid1: HOST, x: 70, y: 30, width: 2209, height: 1369});
  fake.client.emit('event', {name: 'ConfigureNotify', wid: ROOT, wid1: WIDGET, x: 1, y: 2, width: 440, height: 440});
  assert.deepEqual(seen, [{kind: 'configure', id: '0xe00004', x: 70, y: 30, width: 2209, height: 1369}]);
  unwatch();
});

test('window lifecycle events and work-area changes reach subscribers', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  const changes = [];
  connection.subscribe(change => changes.push(change.kind));
  fake.client.emit('event', {name: 'CreateNotify', wid: HOST, parent: ROOT, x: 0, y: 0, width: 10, height: 10});
  fake.client.emit('event', {name: 'UnmapNotify', wid: HOST, event: ROOT});
  fake.client.emit('event', {name: 'DestroyNotify', wid: HOST, event: ROOT});
  assert.deepEqual(changes, ['windows', 'windows', 'windows']);
  // A destroyed window is no longer described from the cache.
  const windows = await connection.listWindows();
  assert.equal(windows.length, 2);
});

test('readWindowState names the atoms in _NET_WM_STATE', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  assert.deepEqual(await connection.readWindowState(HOST), ['_NET_WM_STATE_ABOVE', 'UNKNOWN']);
});

test('setTransientFor writes a 32-bit WINDOW property on our own window', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  assert.equal(await connection.setTransientFor(WIDGET, HOST), true);
  const write = fake.client.requests.find(request => request.method === 'ChangeProperty');
  assert.deepEqual(write.args.slice(0, 2), [0, WIDGET]);
  assert.equal(write.args[3], 33, 'WM_TRANSIENT_FOR is a WINDOW property');
  assert.equal(write.args[4], 32);
  assert.deepEqual(write.args[5], [HOST]);
});

test('a disconnected connection reports itself and rejects queries', async () => {
  const fake = fakeX();
  const connection = connect(fake);
  await connection.connect();
  connection.close();
  assert.equal(connection.isConnected(), false);
  await assert.rejects(() => connection.listWindows());
});

test('createEventSource exposes the follower tool surface', () => {
  const keys = Object.keys(createEventSource({}));
  assert.deepEqual(keys, ['listWindows', 'queryWindow', 'readWorkArea', 'readWindowState', 'setTransientFor', 'watchWindow', 'subscribe', 'ownGeometry']);
});

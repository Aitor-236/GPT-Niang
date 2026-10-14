import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  parseMonitors,
  parseStateAtoms,
  parseTransientFor,
  parseWindowInfo,
  parseWindowTree,
  parseWorkArea,
  windowHandleToXid
} from '../src/x11.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = name => fs.readFileSync(path.join(fixtures, name), 'utf8');

// Captured from a real GNOME 50 Wayland session running the Codex desktop
// client under XWayland, with user paths sanitised.
test('parseWindowTree reads the root children only', () => {
  const windows = parseWindowTree(fixture('xwininfo-root-tree.txt'));
  const ids = windows.map(window => window.id);
  assert.equal(windows.length, 21);
  assert.equal(windows.filter(window => window.id === '0x1600012').length, 0, 'nested child must be skipped');
  assert.ok(ids.includes('0xe00004'));
  assert.ok(ids.includes('0xe00017'));
  const main = windows.find(window => window.id === '0xe00004');
  assert.deepEqual(
    {name: main.name, instance: main.instance, className: main.className, x: main.x, y: main.y, width: main.width, height: main.height},
    {name: 'ChatGPT', instance: 'chatgpt (/home/USER/.config/Codex)', className: 'Chatgpt', x: 293, y: 113, width: 2209, height: 1297}
  );
  const nameless = windows.find(window => window.id === '0xe00011');
  assert.equal(nameless.name, null);
  assert.equal(nameless.width, 1);
});

test('parseWindowInfo reads geometry, map state and override-redirect', () => {
  assert.deepEqual(parseWindowInfo(fixture('xwininfo-window.txt')), {
    x: 293,
    y: 113,
    width: 2209,
    height: 1297,
    mapState: 'IsViewable',
    viewable: true,
    overrideRedirect: false
  });
  const offscreen = parseWindowInfo(fixture('xwininfo-offscreen-window.txt'));
  assert.equal(offscreen.x, 1550);
  assert.equal(offscreen.y, -980);
  assert.equal(offscreen.height, 2842);
  assert.equal(offscreen.viewable, true);
});

test('parseMonitors reads connected outputs', () => {
  assert.deepEqual(parseMonitors(fixture('xrandr.txt')), [
    {name: 'DP-1', primary: true, x: 0, y: 0, width: 2560, height: 1440}
  ]);
});

test('parseWorkArea reads the root property', () => {
  assert.deepEqual(parseWorkArea('_NET_WORKAREA(CARDINAL) = 0, 0, 2560, 1440, 0, 0, 2560, 1440'), {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440
  });
  assert.equal(parseWorkArea('_NET_WORKAREA:  not found.'), null);
});

test('parseStateAtoms splits the atom list and tolerates absence', () => {
  assert.deepEqual(parseStateAtoms('_NET_WM_STATE(ATOM) = _NET_WM_STATE_FOCUSED'), ['_NET_WM_STATE_FOCUSED']);
  assert.deepEqual(parseStateAtoms('_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE, _NET_WM_STATE_FOCUSED'), [
    '_NET_WM_STATE_ABOVE',
    '_NET_WM_STATE_FOCUSED'
  ]);
  assert.deepEqual(parseStateAtoms('_NET_WM_STATE(ATOM) = '), []);
  assert.deepEqual(parseStateAtoms('_NET_WM_STATE:  not found.'), []);
});

test('parseTransientFor returns the window id or null', () => {
  assert.equal(parseTransientFor('WM_TRANSIENT_FOR(WINDOW): window id # 0xe00004'), '0xe00004');
  assert.equal(parseTransientFor('WM_TRANSIENT_FOR:  not found.'), null);
});

test('windowHandleToXid handles 4 and 8 byte handles', () => {
  const four = Buffer.alloc(4);
  four.writeUInt32LE(0xe00004, 0);
  assert.equal(windowHandleToXid(four), '0xe00004');
  const eight = Buffer.alloc(8);
  eight.writeBigUInt64LE(0xe00004n, 0);
  assert.equal(windowHandleToXid(eight), '0xe00004');
  assert.equal(windowHandleToXid(Buffer.alloc(0)), null);
});

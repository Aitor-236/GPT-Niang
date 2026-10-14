import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampToMonitors,
  codexWindowCandidates,
  followPosition,
  hostIsVisible,
  intersects,
  pickHost,
  samePoint,
  sizeDriftExceeds,
  snappedAnchor,
  visibleArea
} from '../src/geometry.js';

const monitor = {x: 0, y: 0, width: 2560, height: 1440};

test('intersects returns the overlap or null', () => {
  assert.deepEqual(intersects({x: 0, y: 0, width: 10, height: 10}, {x: 5, y: 5, width: 10, height: 10}), {x: 5, y: 5, width: 5, height: 5});
  assert.equal(intersects({x: 0, y: 0, width: 4, height: 4}, {x: 10, y: 10, width: 4, height: 4}), null);
});

test('visibleArea counts only the part inside the monitors', () => {
  assert.equal(visibleArea({x: 0, y: 0, width: 100, height: 100}, [monitor]), 10000);
  // The tall helper window of the desktop client: 1415x2842 at +1550-980.
  assert.equal(visibleArea({x: 1550, y: -980, width: 1415, height: 2842}, [monitor]), 1010 * 1440);
});

test('codexWindowCandidates keeps only real chat windows, largest visible first', () => {
  const windows = [
    {id: '0xe00017', name: 'ChatGPT', instance: 'chatgpt (/home/USER/.config/Codex)', className: 'Chatgpt', x: 1550, y: -980, width: 1415, height: 2842},
    {id: '0xe00004', name: 'ChatGPT', instance: 'chatgpt (/home/USER/.config/Codex)', className: 'Chatgpt', x: 293, y: 113, width: 2209, height: 1297},
    {id: '0x1000003', name: 'ChatGPT', instance: 'ChatGPT', className: 'ChatGPT', x: 0, y: 0, width: 200, height: 200},
    {id: '0x1000001', name: 'ChatGPT', instance: 'ChatGPT', className: 'ChatGPT', x: 10, y: 10, width: 10, height: 10},
    {id: '0xa00002', name: 'mutter-x11-frames', instance: 'mutter-x11-frames', className: 'mutter-x11-frames', x: 0, y: 0, width: 3000, height: 2000}
  ];
  const candidates = codexWindowCandidates(windows, {monitors: [monitor]});
  assert.deepEqual(candidates.map(candidate => candidate.id), ['0xe00004', '0xe00017']);
});

test('codexWindowCandidates ignores the widget itself and non-Codex windows', () => {
  const windows = [
    {id: '0x999', name: 'ChatGPT', instance: 'chatgpt', className: 'Chatgpt', x: 0, y: 0, width: 1000, height: 800},
    {id: '0x111', name: 'GPT 娘', instance: 'gpt-niang', className: 'Gpt-niang', x: 0, y: 0, width: 1000, height: 800}
  ];
  const candidates = codexWindowCandidates(windows, {monitors: [monitor], exclude: ['0x999']});
  assert.deepEqual(candidates, []);
});

test('pickHost keeps the current host unless a candidate is clearly larger', () => {
  const current = {id: '0xa', visible: 1000};
  const slightlyLarger = {id: '0xb', visible: 1100};
  const muchLarger = {id: '0xc', visible: 5000};
  assert.equal(pickHost([slightlyLarger, current], {current}).id, '0xa');
  assert.equal(pickHost([muchLarger, current], {current}).id, '0xc');
  assert.equal(pickHost([muchLarger], {current}).id, '0xc');
  assert.equal(pickHost([], {current}), null);
});

test('hostIsVisible rejects unmapped, tiny and offscreen hosts', () => {
  const host = {viewable: true, width: 2209, height: 1297, x: 293, y: 113};
  assert.equal(hostIsVisible(host, [monitor]), true);
  assert.equal(hostIsVisible({...host, viewable: false}, [monitor]), false);
  assert.equal(hostIsVisible({...host, width: 32, height: 32}, [monitor]), false);
  assert.equal(hostIsVisible({...host, x: 5000, y: 5000}, [monitor]), false);
});

test('followPosition mirrors the Windows drag offsets and anchors', () => {
  const host = {x: 293, y: 113, width: 2209, height: 1297};
  const size = {width: 350, height: 350};
  assert.deepEqual(followPosition(host, size, {anchor: 'left', left: 12, bottom: 12}), {x: 305, y: 1048});
  assert.deepEqual(followPosition(host, size, {anchor: 'right', right: 20, bottom: 12}), {x: 2132, y: 1048});
});

test('followPosition clamps inside the host and never above its top edge', () => {
  const host = {x: 100, y: 100, width: 400, height: 300};
  const size = {width: 350, height: 350};
  const position = followPosition(host, size, {anchor: 'left', left: 999, bottom: 999});
  assert.equal(position.x, 150);
  assert.equal(position.y, 100);
});

test('clampToMonitors pulls a widget back onto a display', () => {
  const rect = {x: 2500, y: 1000, width: 350, height: 350};
  // Only the overflowing axis moves: y + height still fits inside the display.
  assert.deepEqual(clampToMonitors(rect, [monitor]), {x: 2210, y: 1000, width: 350, height: 350});
  const inside = {x: 10, y: 10, width: 350, height: 350};
  assert.equal(clampToMonitors(inside, [monitor]), inside);
});

test('snappedAnchor faces the character into the window', () => {
  const host = {x: 0, y: 0, width: 1000, height: 800};
  assert.equal(snappedAnchor(10, 350, host), 'left');
  assert.equal(snappedAnchor(640, 350, host), 'right');
});

test('samePoint compares positions only', () => {
  assert.equal(samePoint({x: 1, y: 2}, {x: 1, y: 2}), true);
  assert.equal(samePoint({x: 1, y: 2}, {x: 1, y: 3}), false);
  assert.equal(samePoint(null, {x: 1, y: 2}), false);
});

// The watchdog must not treat Chromium's rounding up to the device grid as
// drift - but it must catch the runaway growth that pinned the widget at
// 2842x2635 px, which is also what makes the window swallow clicks.
test('sizeDriftExceeds tolerates rounding and catches real growth', () => {
  assert.equal(sizeDriftExceeds({width: 440, height: 438}, 438, 6), false);
  assert.equal(sizeDriftExceeds({width: 450, height: 438}, 438, 6), true);
  assert.equal(sizeDriftExceeds({width: 438, height: 500}, 438, 6), true);
  assert.equal(sizeDriftExceeds({width: 2842, height: 2635}, 438, 6), true);
  assert.equal(sizeDriftExceeds(null, 438, 6), false);
  assert.equal(sizeDriftExceeds({width: 10, height: 10}, Number.NaN, 6), false);
});

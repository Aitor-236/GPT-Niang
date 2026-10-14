import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseMonitors, parseWindowInfo, parseWindowTree} from '../src/x11.js';
import {createHostFollower} from '../src/host-follow.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = name => fs.readFileSync(path.join(fixtures, name), 'utf8');

const WIDGET_ID = '0x42';
const HOST_RECT = {x: 293, y: 113, width: 2209, height: 1297};

function harness({host = HOST_RECT, viewable = true, hostId = '0xe00004'} = {}) {
  const port = {
    id: WIDGET_ID,
    moves: [],
    sizes: [],
    visibility: [],
    events: [],
    getWidgetId: () => WIDGET_ID,
    getWidgetSize: () => ({width: 350, height: 350}),
    setWidgetSize(size) {
      this.sizes.push(size);
    },
    move(x, y) {
      this.moves.push({x, y});
    },
    moveBeforeShow(x, y) {
      this.moves.push({x, y});
    },
    setVisible(value) {
      this.visibility.push(value);
    },
    applyAbove() {
      this.events.push('above');
    },
    log(event, data) {
      this.events.push({event, data});
    }
  };
  // The follower captures the tool functions when it is created, so tests
  // mutate these delegates instead of replacing the entries.
  const state = {
    hosts: [host],
    viewable,
    listWindows: async () => parseWindowTree(fixture('xwininfo-root-tree.txt')),
    queryWindow: async id => (id === hostId
      ? {x: state.hosts.at(-1).x, y: state.hosts.at(-1).y, width: state.hosts.at(-1).width, height: state.hosts.at(-1).height, mapState: state.viewable ? 'IsViewable' : 'IsUnMapped', viewable: state.viewable, overrideRedirect: false}
      : parseWindowInfo(fixture('xwininfo-offscreen-window.txt')))
  };
  const tools = {
    listWindows: () => state.listWindows(),
    listMonitors: async () => parseMonitors(fixture('xrandr.txt')),
    readWorkArea: async () => ({x: 0, y: 0, width: 2560, height: 1440}),
    readWindowState: async () => ['_NET_WM_STATE_ABOVE'],
    setTransientFor: async () => true,
    queryWindow: id => state.queryWindow(id)
  };
  return {port, tools, state};
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('follower picks the chat window, not the taller helper window', async () => {
  const {port, tools} = harness();
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools});
  follower.start();
  await wait(120);
  follower.stop();
  assert.equal(follower.host.id, '0xe00004');
  assert.deepEqual(port.events.filter(event => event.event === 'host').map(event => event.data.id), ['0xe00004']);
});

test('follower positions inside the host, shows after two stable samples and stops moving', async () => {
  const {port, tools} = harness();
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools, offsets: {left: 12, bottom: 12}});
  follower.start();
  await wait(150);
  follower.stop();
  assert.ok(port.moves.length >= 1);
  assert.deepEqual(port.moves[0], {x: HOST_RECT.x + 12, y: HOST_RECT.y + HOST_RECT.height - 350 - 12});
  assert.deepEqual(port.visibility, [true]);
  // One move before showing, and no repeated moves while the host is still.
  assert.equal(new Set(port.moves.map(move => `${move.x},${move.y}`)).size, 1);
  assert.ok(port.events.filter(event => event?.event === 'above').length <= 1);
});

test('follower hides after the grace period when the host disappears', async () => {
  const {port, tools, state} = harness();
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, graceMs: 60, tools});
  follower.start();
  await wait(80);
  assert.equal(follower.visible, true);
  state.viewable = false;
  state.hosts.push({x: 0, y: 0, width: 0, height: 0});
  state.listWindows = async () => [];
  await wait(160);
  follower.stop();
  assert.equal(follower.visible, false);
  assert.deepEqual(port.visibility, [true, false]);
});

test('follower tracks host movement', async () => {
  const {port, tools, state} = harness();
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools});
  follower.start();
  await wait(80);
  const before = follower.host.x;
  state.hosts.push({x: before + 100, y: HOST_RECT.y, width: HOST_RECT.width, height: HOST_RECT.height});
  await wait(120);
  follower.stop();
  assert.equal(port.moves.at(-1).x, before + 100 + 12);
});

// Follow mode never leaves the chat window: the widget is placed inside
// host ∩ monitor, and shrinks when the window cannot hold it (the macOS build
// does the same in Placement.frame via `min(size, area)`).
test('the widget keeps its configured size while the chat window can hold it', async () => {
  const {port, tools} = harness();
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools});
  follower.start();
  await wait(150);
  follower.stop();
  assert.deepEqual(port.sizes.at(-1), {width: 350, height: 350}, 'the configured size is kept');
  assert.equal(port.sizes.length, 1, 'the size is reported when it changes, not on every tick');
  const last = port.moves.at(-1);
  assert.ok(last.x >= HOST_RECT.x && last.x + 350 <= HOST_RECT.x + HOST_RECT.width);
  assert.ok(last.y >= HOST_RECT.y && last.y + 350 <= HOST_RECT.y + HOST_RECT.height);
});

test('the widget shrinks to stay inside a chat window that is smaller than it is', async () => {
  // The harness draws the widget on a 350px canvas, so 300x280 cannot hold it.
  const small = {x: 120, y: 140, width: 300, height: 280};
  const {port, tools} = harness({host: small});
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools, sizeAllowance: 0});
  follower.start();
  await wait(150);
  follower.stop();
  // Square canvas: the shorter side (280) decides.
  assert.deepEqual(port.sizes.at(-1), {width: 280, height: 280});
  const last = port.moves.at(-1);
  assert.ok(last.x >= small.x, 'left edge stays inside the window');
  assert.ok(last.y >= small.y, 'top edge stays inside the window');
  assert.ok(last.x + 280 <= small.x + small.width, 'right edge stays inside the window');
  assert.ok(last.y + 280 <= small.y + small.height, 'bottom edge stays inside the window');
});

test('the widget grows back once the chat window can hold it again', async () => {
  const small = {x: 120, y: 140, width: 300, height: 280};
  const {port, tools, state} = harness({host: small});
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools, sizeAllowance: 0});
  follower.start();
  await wait(120);
  assert.deepEqual(port.sizes.at(-1), {width: 280, height: 280});

  state.hosts.push({x: 120, y: 140, width: 1200, height: 900});
  await wait(180);
  follower.stop();
  assert.deepEqual(port.sizes.at(-1), {width: 350, height: 350}, 'the configured size comes back');
});

test('a chat window that hangs off the monitor only uses its visible part', async () => {
  // The harness reports one monitor at (0,0,2560,1440).
  const host = {x: -120, y: -60, width: 1400, height: 900};
  const {port, tools} = harness({host});
  const follower = createHostFollower(port, {followHz: 60, discoveryIntervalMs: 0, tools, sizeAllowance: 0});
  follower.start();
  await wait(150);
  follower.stop();
  const visible = {x: 0, y: 0, width: 1280, height: 840};
  assert.deepEqual(follower.usable, visible);
  const last = port.moves.at(-1);
  assert.ok(last.x >= visible.x && last.x + 350 <= visible.x + visible.width);
  assert.ok(last.y >= visible.y && last.y + 350 <= visible.y + visible.height);
});

// Event mode: the X server pushes ConfigureNotify for the followed window, so
// the widget reacts to a move instead of waiting for the next sample.
function eventHarness() {
  const {port, tools, state} = harness();
  const listeners = new Set();
  const watchers = new Map();
  const counts = {list: 0, query: 0};
  const source = {
    listWindows: async () => {
      counts.list += 1;
      return parseWindowTree(fixture('xwininfo-root-tree.txt'));
    },
    queryWindow: async id => {
      counts.query += 1;
      return tools.queryWindow(id);
    },
    readWorkArea: async () => ({x: 0, y: 0, width: 2560, height: 1440}),
    readWindowState: async () => ['_NET_WM_STATE_ABOVE'],
    setTransientFor: async () => true,
    subscribe: handler => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    watchWindow: (id, handler) => {
      watchers.set(id, handler);
      return () => watchers.delete(id);
    }
  };
  return {
    port,
    state,
    counts,
    source,
    // Monitor layout keeps coming from xrandr even in event mode; the follower
    // reads it through the tool set, so the tests inject it here.
    tools: {listMonitors: async () => parseMonitors(fixture('xrandr.txt'))},
    emit: change => {
      for (const handler of listeners) handler(change);
    },
    configure: (id, geometry) => watchers.get(id)?.({kind: 'configure', id, ...geometry}),
    watching: id => watchers.has(id)
  };
}

test('event mode watches the host window and reacts to its ConfigureNotify', async () => {
  const {port, source, tools, state, configure, watching} = eventHarness();
  const follower = createHostFollower(port, {source, tools, discoveryIntervalMs: 40});
  follower.start();
  await wait(120);
  assert.equal(follower.host.id, '0xe00004');
  assert.equal(watching('0xe00004'), true, 'the host window is watched for structure changes');
  const before = port.moves.at(-1);

  // What a real move looks like: the window jumps, then reports its geometry.
  state.hosts.push({x: HOST_RECT.x + 300, y: HOST_RECT.y, width: HOST_RECT.width, height: HOST_RECT.height});
  configure('0xe00004', {x: 300, y: 300, width: 2209, height: 1369});
  await wait(60);
  follower.stop();
  assert.ok(port.moves.length > 0);
  assert.notDeepEqual(port.moves.at(-1), before, 'the widget moved on the event, not on the next sample');
  assert.equal(port.moves.at(-1).x, HOST_RECT.x + 300 + 12);
});

test('event mode walks the window tree when a window appears or is destroyed', async () => {
  const {port, source, tools, emit, counts} = eventHarness();
  const follower = createHostFollower(port, {source, tools, discoveryIntervalMs: 40});
  follower.start();
  await wait(120);
  follower.stop();
  const before = counts.list;

  follower.start();
  await wait(40);
  emit({kind: 'windows', id: '0xe00017'});
  await wait(60);
  follower.stop();
  assert.ok(counts.list > before, 'a window appearing forces a discovery right away');
});

test('a suspended follower ignores events until it is resumed', async () => {
  const {port, source, tools, state, configure} = eventHarness();
  const follower = createHostFollower(port, {source, tools, discoveryIntervalMs: 40});
  follower.start();
  await wait(120);
  follower.suspend();
  const moves = port.moves.length;
  state.hosts.push({x: HOST_RECT.x + 500, y: HOST_RECT.y, width: HOST_RECT.width, height: HOST_RECT.height});
  configure('0xe00004', {x: 500, y: 500, width: 2209, height: 1369});
  await wait(80);
  assert.equal(port.moves.length, moves, 'a drag owns the position while it is in progress');

  follower.resume();
  await wait(80);
  follower.stop();
  assert.equal(port.moves.at(-1).x, HOST_RECT.x + 500 + 12);
});

test('stopping the follower releases the window watch', async () => {
  const {port, source, tools, watching} = eventHarness();
  const follower = createHostFollower(port, {source, tools, discoveryIntervalMs: 40});
  follower.start();
  await wait(120);
  assert.equal(watching('0xe00004'), true);
  follower.stop();
  assert.equal(watching('0xe00004'), false);
});

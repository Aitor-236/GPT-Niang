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
    visibility: [],
    events: [],
    getWidgetId: () => WIDGET_ID,
    getWidgetSize: () => ({width: 350, height: 350}),
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

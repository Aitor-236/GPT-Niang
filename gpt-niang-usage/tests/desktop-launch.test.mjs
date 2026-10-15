import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {launchDesktopWidget} from '../runtime/desktop-launch.mjs';

test('MCP sessions start one detached widget and leave quota service independent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-niang-desktop-launch-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = {dataDir: dir, widgetLaunch: {command: '/tmp/fake-widget', args: ['--ozone-platform=x11']}};
  const launched = [];
  const spawnProcess = (command, args, options) => {
    launched.push({command, args, options});
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  };
  const options = {platform: 'linux', env: {DISPLAY: ':0'}, spawnProcess, alive: () => false};

  assert.equal(launchDesktopWidget(config, {...options, env: {}}), 'headless');
  assert.equal(launchDesktopWidget(config, {...options, platform: 'darwin'}), 'disabled');
  assert.equal(launchDesktopWidget(config, options), 'launched');
  assert.equal(launchDesktopWidget(config, options), 'starting');
  assert.equal(launched.length, 1);
  assert.equal(launched[0].command, '/tmp/fake-widget');
  assert.deepEqual(launched[0].args, ['--ozone-platform=x11']);
  assert.equal(launched[0].options.detached, true);
  assert.equal(launched[0].options.stdio, 'ignore');

  fs.writeFileSync(path.join(dir, 'presence.json'), JSON.stringify({pid: 1234, visible: false}));
  assert.equal(launchDesktopWidget(config, {...options, alive: pid => pid === 1234}), 'running');
  assert.equal(launched.length, 1);
});

test('a failed or expired launch can be retried', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-niang-desktop-retry-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = {dataDir: dir, widgetLaunch: {command: '/tmp/fake-widget', args: []}};
  const claim = path.join(dir, 'desktop-launch.claim');
  const options = {platform: 'linux', env: {DISPLAY: ':0'}};

  assert.throws(() => launchDesktopWidget(config, {
    ...options,
    spawnProcess: () => { throw new Error('launch failed'); }
  }), /launch failed/);
  assert.equal(fs.existsSync(claim), false);

  fs.writeFileSync(claim, '');
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(claim, old, old);
  const child = new EventEmitter();
  child.unref = () => {};
  assert.equal(launchDesktopWidget(config, {...options, spawnProcess: () => child}), 'launched');
  child.emit('error', new Error('exec failed'));
  assert.equal(fs.existsSync(claim), false);
});

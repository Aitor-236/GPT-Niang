// Bridge to the shared quota backend (gpt-niang-usage/runtime).
//
// The worker model is unchanged: one single-writer process refreshes the
// account snapshot, headless callers ask through its socket with a file-queue
// fallback, and the widget only reads status.json.

import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

import {installationFile, writeInstallation, loadSettings} from './config.js';
import {findNode, runtimeDir} from './runtime.js';
import {resolveCodexExecutable} from '../../gpt-niang-usage/runtime/usage.mjs';

export const STATUS_FILE = 'status.json';
export const PRESENCE_FILE = 'presence.json';

export function createBackend({dir, env = process.env, packaged = false, log = () => {}}) {
  const runtime = runtimeDir({env, packaged});
  const nodePath = findNode({env});
  const codexPath = resolveCodexExecutable(null, {env, platform: 'linux'});
  const configPath = writeInstallation(dir, {codexPath, nodePath});
  log('backend', {runtime, nodePath, codexPath, configPath});

  let refreshClient = null;
  async function client() {
    if (!refreshClient) {
      const module = await import(pathToFileURL(path.join(runtime, 'refresh-client.mjs')).href);
      refreshClient = module;
    }
    return refreshClient;
  }

  function config() {
    const settings = loadSettings(dir);
    return {dataDir: dir, nodePath, codexPath, quotaSource: settings.quotaSource};
  }

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }

  function snapshot() {
    return readJson(path.join(dir, STATUS_FILE));
  }

  function writePresence({pid, visible}) {
    const file = path.join(dir, PRESENCE_FILE);
    const temporary = file + '.' + process.pid + '.tmp';
    try {
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(temporary, JSON.stringify({pid, visible, at: Date.now()}));
      fs.renameSync(temporary, file);
    } catch (error) {
      log('presence-error', {message: error?.message ?? String(error)});
    }
  }

  return {
    dir,
    runtime,
    nodePath,
    codexPath,
    configPath,
    snapshot,
    readJson: file => readJson(path.join(dir, file)),
    writePresence,
    async refresh({timeoutMs = 45000} = {}) {
      if (!nodePath) {
        return {ok: false, queryOk: false, errorCode: 'NO_NODE', error: '未找到 Node.js 20 或更新版本，无法读取额度', windows: []};
      }
      // The settings file is re-read so a source switch applies immediately.
      fs.writeFileSync(configPath, JSON.stringify(config(), null, 2) + '\n');
      try {
        const {requestRefresh} = await client();
        // The shared default looks for runtime/watch.mjs next to
        // installation.json, which only holds when that file lives in the
        // program root. Ours lives in the data directory, so the worker is
        // started explicitly from the resolved runtime path.
        const startWorker = () => {
          const child = spawn(nodePath, [path.join(runtime, 'watch.mjs'), configPath, '0'], {
            detached: true,
            stdio: 'ignore'
          });
          child.on('error', error => log('worker-spawn-error', {message: error?.message ?? String(error)}));
          child.unref();
        };
        return await requestRefresh(config(), configPath, {timeoutMs, startWorker});
      } catch (error) {
        log('refresh-error', {message: error?.message ?? String(error)});
        return {ok: false, queryOk: false, errorCode: 'REFRESH_FAILED', error: '额度刷新失败，稍后重试', windows: []};
      }
    },
    stop() {
      // A worker with no live GUI parent exits on its own; an explicit stop
      // flag is authoritative and also wakes a worker started by the CLI.
      try {
        fs.writeFileSync(path.join(dir, 'stop.flag'), 'stop-' + Date.now());
      } catch {}
    }
  };
}

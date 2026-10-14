// Locates the shared Node runtime and a Node executable to run it with.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function runtimeDir({env = process.env, packaged = false} = {}) {
  if (env.GPT_NIANG_RUNTIME_DIR) return env.GPT_NIANG_RUNTIME_DIR;
  if (packaged && process.resourcesPath) return path.join(process.resourcesPath, 'runtime');
  return path.resolve(here, '..', '..', 'gpt-niang-usage', 'runtime');
}

export function assetsDir({env = process.env, packaged = false} = {}) {
  if (env.GPT_NIANG_ASSETS_DIR) return env.GPT_NIANG_ASSETS_DIR;
  if (packaged && process.resourcesPath) return path.join(process.resourcesPath, 'assets');
  return path.resolve(here, '..', '..', 'gpt-niang-usage', 'assets');
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The quota worker is plain Node (no Electron APIs), so it runs under the
// system Node rather than the Electron binary - the same requirement the
// Windows and macOS builds document (Node.js 20 or newer).
export function findNode({env = process.env, configured = null} = {}) {
  if (configured && isExecutable(configured)) return configured;
  const candidates = [];
  for (const directory of (env.PATH ?? '').split(':')) {
    if (directory.trim().length === 0) continue;
    candidates.push(path.join(directory.trim(), 'node'));
  }
  candidates.push('/usr/bin/node', '/usr/local/bin/node');
  if (env.HOME) candidates.push(path.join(env.HOME, '.local', 'bin', 'node'));
  for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
  return null;
}

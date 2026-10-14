// Preferences and data locations for the Linux widget.
//
// Layout mirrors the other platforms: the state directory holds the quota
// snapshot written by the shared worker plus this app's own settings, so an
// uninstall keeps user data unless it is removed deliberately.

import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const SCALE_MIN = 0.6;
export const SCALE_MAX = 2.5;
export const SCALE_PRESETS = [0.8, 1, 1.4];
// The WPF window is 350x350 while its canvas is 378x378; keeping the same
// design stage means the port renders the original proportions.
export const DESIGN_STAGE = 378;
export const DESIGN_WINDOW = 350;

export const DEFAULT_SETTINGS = {
  quotaSource: 'auto',
  mode: 'host',
  anchor: 'left',
  hostInsets: {left: 12, right: 12, bottom: 12},
  hostPosition: null,
  desktopPosition: null,
  desktopTopmost: false,
  scale: 1,
  sound: {enabled: true, volume: 0.8},
  clickToAdvance: true,
  followHz: 30,
  discoveryIntervalMs: 250,
  autostart: false
};

export function dataDir(env = process.env) {
  if (env.GPT_NIANG_DATA_DIR) return env.GPT_NIANG_DATA_DIR;
  const base = env.XDG_DATA_HOME || (env.HOME ? path.join(env.HOME, '.local', 'share') : null);
  if (!base) throw new Error('无法确定用户数据目录（HOME 未设置）');
  return path.join(base, 'GPTNiangUsage', 'state');
}

export function clampScale(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.scale;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(parsed.toFixed(2))));
}

export function normalizeSettings(raw) {
  const merged = {...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {})};
  return {
    ...merged,
    scale: clampScale(merged.scale),
    mode: merged.mode === 'desktop' ? 'desktop' : 'host',
    anchor: merged.anchor === 'right' ? 'right' : 'left',
    quotaSource: ['auto', 'codex', 'deepseek'].includes(merged.quotaSource) ? merged.quotaSource : 'auto',
    hostInsets: {...DEFAULT_SETTINGS.hostInsets, ...(merged.hostInsets ?? {})},
    sound: {...DEFAULT_SETTINGS.sound, ...(merged.sound ?? {})},
    followHz: Math.min(60, Math.max(5, Number.parseInt(merged.followHz, 10) || DEFAULT_SETTINGS.followHz)),
    discoveryIntervalMs: Math.min(2000, Math.max(100, Number.parseInt(merged.discoveryIntervalMs, 10) || DEFAULT_SETTINGS.discoveryIntervalMs))
  };
}

export function settingsFile(dir) {
  return path.join(dir, 'settings.json');
}

export function loadSettings(dir) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8').replace(/^\uFEFF/, '')));
  } catch {
    return normalizeSettings(null);
  }
}

export function saveSettings(dir, settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(dir, {recursive: true});
  const file = settingsFile(dir);
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
  return normalized;
}

// The shared worker needs an installation.json it can re-read on every refresh.
export function installationFile(dir) {
  return path.join(dir, 'installation.json');
}

export function writeInstallation(dir, {codexPath = null, nodePath = null}) {
  fs.mkdirSync(dir, {recursive: true});
  const file = installationFile(dir);
  fs.writeFileSync(file, JSON.stringify({dataDir: dir, codexPath, nodePath}, null, 2) + '\n');
  return file;
}

export function defaultWindowSize(scale) {
  return Math.round(DESIGN_WINDOW * clampScale(scale));
}

// DIP (Electron window coordinates) and X11 pixels differ on scaled desktops.
export function pixelsToDips(pixels, scaleFactor) {
  return Math.round(pixels / scaleFactor);
}

export function dipsToPixels(dips, scaleFactor) {
  return Math.round(dips * scaleFactor);
}

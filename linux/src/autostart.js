// XDG autostart entry, the Linux equivalent of the Windows startup shortcut
// and the macOS SMAppService registration.

import fs from 'node:fs';
import path from 'node:path';

export const AUTOSTART_NAME = 'gpt-niang-usage.desktop';

export function autostartPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : null);
  if (!base) return null;
  return path.join(base, 'autostart', AUTOSTART_NAME);
}

export function isAutostartEnabled(env = process.env) {
  const file = autostartPath(env);
  return Boolean(file && fs.existsSync(file));
}

// The X11 backend is not optional: without it the widget cannot read the chat
// window's geometry or position itself. A packaged AppImage must be launched
// through its own path.
export function launchCommand({env = process.env, execPath = process.execPath, appPath = null} = {}) {
  const target = env.APPIMAGE || appPath || execPath;
  return `"${target}" --ozone-platform=x11`;
}

export function setAutostart(enabled, {env = process.env, execPath, appPath} = {}) {
  const file = autostartPath(env);
  if (!file) return false;
  if (!enabled) {
    try {
      fs.unlinkSync(file);
    } catch {}
    return false;
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const contents = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=GPT 娘',
    'Comment=跟随 Codex 窗口显示额度与语录',
    `Exec=${launchCommand({env, execPath, appPath})}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupNotify=false',
    ''
  ].join('\n');
  fs.writeFileSync(file, contents);
  return true;
}

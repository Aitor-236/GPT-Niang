import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const LAUNCH_GRACE_MS = 15000;

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function runningWidget(dataDir, alive) {
  try {
    const presence = JSON.parse(fs.readFileSync(path.join(dataDir, 'presence.json'), 'utf8'));
    return alive(presence.pid);
  } catch {
    return false;
  }
}

function claimLaunch(file, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let age;
      try { age = now - fs.statSync(file).mtimeMs; }
      catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (age >= 0 && age < LAUNCH_GRACE_MS) return false;
      try { fs.unlinkSync(file); }
      catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  return false;
}

// A Codex session starts its own MCP server. Presence plus a short launch claim
// prevents those servers from opening duplicate windows during login.
export function launchDesktopWidget(config, {
  platform = process.platform,
  env = process.env,
  spawnProcess = spawn,
  alive = processAlive,
  now = Date.now()
} = {}) {
  if (platform !== 'linux' || !config?.widgetLaunch) return 'disabled';
  if (!env.DISPLAY) return 'headless';
  const {command, args} = config.widgetLaunch;
  if (!path.isAbsolute(command) || !Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    throw new Error('Invalid widget launch configuration');
  }
  const dataDir = config.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Invalid widget data directory');
  if (runningWidget(dataDir, alive)) return 'running';
  fs.mkdirSync(dataDir, {recursive: true});
  const claim = path.join(dataDir, 'desktop-launch.claim');
  if (!claimLaunch(claim, now)) return 'starting';
  try {
    const child = spawnProcess(command, args, {detached: true, stdio: 'ignore', env});
    const failed = error => {
      try { fs.unlinkSync(claim); } catch {}
      console.error('GPT 娘桌面挂件启动失败：' + error);
    };
    child.on('error', failed);
    child.on('exit', code => { if (code !== 0) failed(`退出码 ${code}`); });
    child.unref();
    return 'launched';
  } catch (error) {
    try { fs.unlinkSync(claim); } catch {}
    throw error;
  }
}

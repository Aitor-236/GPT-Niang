// Resolution for the app's custom asset scheme.
//
// URLs written as `gpt-asset://character.png` put the file name in the URL's
// host component (leaving the path empty), while `gpt-asset:///character.png`
// puts it in the path. Both spellings are accepted, and anything that escapes
// the asset root is refused.

import path from 'node:path';

export const ASSET_SCHEME = 'gpt-asset';

export function assetRelativePath(url) {
  const parsed = new URL(url);
  const relative = decodeURIComponent(parsed.host + parsed.pathname).replace(/^\/+/, '');
  return relative.length > 0 ? relative : null;
}

export function resolveAssetPath(root, url) {
  const relative = assetRelativePath(url);
  if (!relative) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}

export function assetMimeType(file) {
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.wav': 'audio/wav',
      '.json': 'application/json',
      '.css': 'text/css'
    }[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  );
}

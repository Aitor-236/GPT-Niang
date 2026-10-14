import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {assetMimeType, assetRelativePath, resolveAssetPath} from '../src/asset-url.js';

const root = '/home/USER/share/GPTNiangUsage/assets';

test('assetRelativePath accepts the host form used by the renderer', () => {
  // This is the spelling the widget uses; the file name lands in the URL host.
  assert.equal(assetRelativePath('gpt-asset://gpt-dragon-niang-bust.png'), 'gpt-dragon-niang-bust.png');
  assert.equal(assetRelativePath('gpt-asset://press.wav'), 'press.wav');
  // The three-slash spelling puts the same name in the path.
  assert.equal(assetRelativePath('gpt-asset:///quotes.json'), 'quotes.json');
  assert.equal(assetRelativePath('gpt-asset://sub/dir/art.png'), 'sub/dir/art.png');
  assert.equal(assetRelativePath('gpt-asset://'), null);
});

test('resolveAssetPath maps URLs inside the asset root and refuses escapes', () => {
  assert.equal(resolveAssetPath(root, 'gpt-asset://gpt-dragon-niang-bust.png'), path.join(root, 'gpt-dragon-niang-bust.png'));
  assert.equal(resolveAssetPath(root, 'gpt-asset://press.wav'), path.join(root, 'press.wav'));
  assert.equal(resolveAssetPath(root, 'gpt-asset:///quotes.json'), path.join(root, 'quotes.json'));
  assert.equal(resolveAssetPath(root, 'gpt-asset://../../.codex/config.toml'), null);
  assert.equal(resolveAssetPath(root, 'gpt-asset://..%2f..%2fetc%2fpasswd'), null);
  assert.equal(resolveAssetPath(root, 'gpt-asset://'), null);
});

test('assetMimeType covers the assets the widget loads', () => {
  assert.equal(assetMimeType('/x/gpt-dragon-niang-bust.png'), 'image/png');
  assert.equal(assetMimeType('/x/press.wav'), 'audio/wav');
  assert.equal(assetMimeType('/x/quotes.json'), 'application/json');
  assert.equal(assetMimeType('/x/unknown.bin'), 'application/octet-stream');
});

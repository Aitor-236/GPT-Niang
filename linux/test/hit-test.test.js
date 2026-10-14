import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

// The renderer module is a classic script so the page can load it without a
// module system; Node reads the same file as CommonJS.
const require = createRequire(import.meta.url);
const hitTest = require('../renderer/hit-test.cjs');

// Minimal stand-ins for the two nodes the classifier cares about.
function node(id, children = []) {
  const created = {id, children};
  created.contains = candidate => candidate === created || children.includes(candidate);
  return created;
}

test('classifyHit accepts the character, the button and the bubble contents only', () => {
  const girl = node('girl');
  const scene = node('scene');
  const refresh = node('refresh');
  const bubble = node('bubble', [scene, refresh]);
  const button = node('menu-button');

  assert.equal(hitTest.classifyHit(girl, {girl, bubble}), 'girl');
  assert.equal(hitTest.classifyHit(button, {girl, bubble}), 'button');
  assert.equal(hitTest.classifyHit(scene, {girl, bubble}), 'bubble');
  assert.equal(hitTest.classifyHit(refresh, {girl, bubble}), 'bubble');
  // The bubble's own rectangle must not count: its corners sit outside the
  // cloud outline and have to stay click-through.
  assert.equal(hitTest.classifyHit(bubble, {girl, bubble}), null);
  assert.equal(hitTest.classifyHit(node('body'), {girl, bubble}), null);
  assert.equal(hitTest.classifyHit(null, {girl, bubble}), null);
});

test('spritePixel maps a rendered point back to the image with object-fit: cover', () => {
  const image = {width: 1000, height: 1000};
  const rect = {left: 10, top: 20, width: 200, height: 200};
  assert.deepEqual(hitTest.spritePixel({point: {x: 10, y: 20}, rect, image}), {x: 0, y: 0});
  assert.deepEqual(hitTest.spritePixel({point: {x: 110, y: 120}, rect, image}), {x: 500, y: 500});
  // A non-square element keeps the aspect ratio and centres the image.
  const wide = {left: 0, top: 0, width: 400, height: 200};
  assert.deepEqual(hitTest.spritePixel({point: {x: 200, y: 100}, rect: wide, image}), {x: 500, y: 500});
  assert.equal(hitTest.spritePixel({point: {x: -50, y: 10}, rect, image}), null);
  assert.equal(hitTest.spritePixel({point: {x: 5, y: 5}, rect: {left: 0, top: 0, width: 0, height: 0}, image}), null);
  assert.equal(hitTest.spritePixel({point: {x: 5, y: 5}, rect, image: null}), null);
});

test('spritePixel mirrors the sprite while the character faces the other way', () => {
  const image = {width: 100, height: 100};
  const rect = {left: 0, top: 0, width: 100, height: 100};
  assert.deepEqual(hitTest.spritePixel({point: {x: 10, y: 10}, rect, image, flip: true}), {x: 89, y: 10});
});

test('alphaAt samples the mask at the configured step', () => {
  const mask = {width: 2, height: 2, step: 2, alpha: new Uint8Array([0, 255, 128, 200])};
  assert.equal(hitTest.alphaAt({x: 0, y: 0}, mask), 0);
  assert.equal(hitTest.alphaAt({x: 2, y: 0}, mask), 255);
  assert.equal(hitTest.alphaAt({x: 2, y: 2}, mask), 200);
  assert.equal(hitTest.alphaAt({x: 3, y: 3}, mask), 200);
  assert.equal(hitTest.alphaAt({x: 100, y: 0}, mask), null);
  assert.equal(hitTest.alphaAt(null, mask), null);
  assert.equal(hitTest.alphaAt({x: 0, y: 0}, null), null);
});

test('decideHit treats the character corners as transparent and the rest as solid', () => {
  const girl = node('girl');
  const image = {width: 100, height: 100};
  const rect = {left: 0, top: 0, width: 100, height: 100};
  const mask = {width: 100, height: 100, step: 1, alpha: new Uint8Array(100 * 100)};
  mask.alpha[50 * 100 + 50] = 200;
  const kind = hitTest.classifyHit(girl, {girl, bubble: null});

  assert.equal(hitTest.decideHit({kind, point: {x: 50, y: 50}, rect, image, mask}), true);
  // 99,99 is inside the element but outside the painted character.
  assert.equal(hitTest.decideHit({kind, point: {x: 99, y: 99}, rect, image, mask}), false);
  // Anything that was classified as interactive and is not the character is
  // accepted as is.
  assert.equal(hitTest.decideHit({kind: 'bubble', point: {x: 99, y: 99}, rect, image, mask}), true);
  assert.equal(hitTest.decideHit({kind: null, point: {x: 50, y: 50}, rect, image, mask}), false);
  // Without a mask the character counts as a solid rectangle, which errs
  // towards being clickable rather than swallowing the whole widget.
  assert.equal(hitTest.decideHit({kind, point: {x: 99, y: 99}, rect, image, mask: null}), true);
  assert.equal(hitTest.decideHit({kind, point: {x: 500, y: 500}, rect, image, mask: null}), false);
});

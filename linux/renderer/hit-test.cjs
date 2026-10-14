// Pointer hit testing for the widget window.
//
// The window is 350x350: a speech bubble in the upper left, the character in
// the lower right, and transparency everywhere else. Electron can only make a
// whole window ignore the mouse (setIgnoreMouseEvents replaces the input shape;
// the `forward` option that would report motion back is macOS/Windows only), so
// the main process samples the cursor and asks this module whether that point
// is over something interactive.
//
// This mirrors what the Windows build does by answering WM_NCHITTEST from
// Test-WidgetHit, alpha test included: the corners of the character's bounding
// box are transparent, so they must not eat clicks either.
//
// Loaded as a classic script (defines window.NiangHitTest) in the renderer and
// as a CommonJS module by the tests.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NiangHitTest = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_ALPHA_THRESHOLD = 10;

  // Which element under the cursor counts as interactive:
  //   * the character (subject to the alpha test),
  //   * the settings button, which is pointer-events:none until it is shown,
  //   * anything inside the bubble - the cloud outline is an SVG path and is
  //     hit-tested by its own geometry, so the transparent corners of the
  //     bubble's bounding box fall through.
  // The bubble element itself is deliberately excluded: it is a plain 350x239
  // rectangle, and accepting it would make those corners swallow clicks.
  function classifyHit(element, {girl = null, bubble = null} = {}) {
    if (!element) return null;
    if (girl && (element === girl || girl.contains?.(element))) return 'girl';
    if (element.id === 'menu-button') return 'button';
    if (!bubble) return null;
    if (element === bubble) return null;
    if (bubble.contains?.(element)) return 'bubble';
    return null;
  }

  // The sprite is drawn with object-fit: cover and may be mirrored while the
  // character faces the other way. `rect` is the element's rendered rectangle
  // (transforms included), so this works during the press animation too.
  function spritePixel({point, rect, image, flip = false}) {
    if (!point || !rect || !image || rect.width <= 0 || rect.height <= 0) return null;
    const fit = Math.max(rect.width / image.width, rect.height / image.height);
    if (!Number.isFinite(fit) || fit <= 0) return null;
    const offsetX = rect.left + (rect.width - image.width * fit) / 2;
    const offsetY = rect.top + (rect.height - image.height * fit) / 2;
    let x = Math.floor((point.x - offsetX) / fit);
    const y = Math.floor((point.y - offsetY) / fit);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    if (flip) x = image.width - 1 - x;
    return {x, y};
  }

  // The mask is the sprite's alpha channel, sampled every `step` pixels.
  function alphaAt(pixel, mask) {
    if (!pixel || !mask || !mask.alpha) return null;
    const step = mask.step ?? 1;
    const x = Math.floor(pixel.x / step);
    const y = Math.floor(pixel.y / step);
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return null;
    const alpha = mask.alpha[y * mask.width + x];
    return typeof alpha === 'number' ? alpha : null;
  }

  function spriteAlpha({point, rect, image, mask, flip = false, alphaThreshold = DEFAULT_ALPHA_THRESHOLD}) {
    const pixel = spritePixel({point, rect, image, flip});
    if (!pixel) return false;
    // No alpha data (the mask could not be decoded): fall back to the sprite's
    // rectangle. Erring towards clickable keeps the character usable.
    if (!mask?.alpha) return true;
    const alpha = alphaAt(pixel, mask);
    if (alpha === null) return false;
    return alpha > alphaThreshold;
  }

  function decideHit({kind, point, rect, image, mask, flip = false, alphaThreshold = DEFAULT_ALPHA_THRESHOLD}) {
    if (!kind) return false;
    if (kind !== 'girl') return true;
    return spriteAlpha({point, rect, image, mask, flip, alphaThreshold});
  }

  return {DEFAULT_ALPHA_THRESHOLD, classifyHit, spritePixel, alphaAt, spriteAlpha, decideHit};
});

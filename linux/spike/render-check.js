// Renders the widget with fixed quota, balance and error snapshots and prints
// what the bubble shows. Headless: the window is never displayed.
//
// Run with: npm run check:render

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {app, BrowserWindow, protocol} from 'electron';

import {ASSET_SCHEME, assetMimeType, resolveAssetPath} from '../src/asset-url.js';

const here = path.dirname(fileURLToPath(import.meta.url));

app.commandLine.appendSwitch('ozone-platform', 'x11');
app.disableHardwareAcceleration();
// The renderer pulls the character art and sounds through the app's custom
// scheme, so the check has to provide it as well.
protocol.registerSchemesAsPrivileged([
  {scheme: ASSET_SCHEME, privileges: {standard: true, secure: true, supportFetchAPI: true}}
]);
const assets = path.resolve(here, '..', '..', 'gpt-niang-usage', 'assets');

const settings = {
  quotaSource: 'auto',
  mode: 'host',
  anchor: 'left',
  scale: 1,
  sound: {enabled: false, volume: 0},
  clickToAdvance: true
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowSeconds = () => Math.floor(Date.now() / 1000);

const cases = [
  {
    name: 'codex-two-windows',
    snapshot: {
      source: 'codex',
      ok: true,
      queryOk: true,
      planLabel: 'Plus',
      observedAt: Date.now(),
      windows: [
        {label: '5 小时', minutes: 300, remaining: 88, used: 12, resetsAt: nowSeconds() + 3600},
        {label: '每周', minutes: 10080, remaining: 45.5, used: 54.5, resetsAt: null}
      ]
    }
  },
  {
    name: 'codex-single-window',
    snapshot: {
      source: 'codex',
      ok: true,
      queryOk: true,
      planLabel: 'Go',
      observedAt: Date.now(),
      windows: [{label: '30 天', minutes: 43200, remaining: 70, used: 30, resetsAt: nowSeconds() + 86400}]
    }
  },
  {
    name: 'deepseek-balance',
    snapshot: {
      source: 'deepseek',
      ok: true,
      queryOk: true,
      planLabel: 'DeepSeek 余额',
      observedAt: Date.now(),
      windows: [],
      balance: {currency: 'CNY', total: 3.07, granted: 0, toppedUp: 3.07, available: true}
    }
  },
  {
    name: 'api-key-error',
    snapshot: {
      source: 'codex',
      ok: false,
      queryOk: false,
      errorCode: 'AUTH_MODE_UNSUPPORTED',
      error: '请在 Codex 中使用 ChatGPT 账号登录（API Key 不提供订阅额度）',
      windows: []
    }
  }
];

const READ_QUOTA = [
  "(() => {",
  "  const rows = [...document.querySelectorAll('.row')].map(row => ({",
  "    label: row.querySelector('.row-label').textContent,",
  "    value: row.querySelector('.row-value').textContent,",
  "    bar: row.querySelector('.bar-fill').style.width,",
  "    barHidden: row.querySelector('.bar').classList.contains('hidden-bar'),",
  "    reset: row.querySelector('.row-reset').textContent,",
  "    hidden: row.classList.contains('hidden')",
  "  }));",
  "  return {",
  "    header: document.getElementById('header').textContent,",
  "    tailOpacity: getComputedStyle(document.getElementById('tail')).opacity,",
  "    nearTailOpacity: getComputedStyle(document.getElementById('tail-near')).opacity,",
  "    quotaVisible: !document.getElementById('quota-view').classList.contains('hidden'),",
  "    quoteVisible: !document.getElementById('quote-view').classList.contains('hidden'),",
  "    rows",
  "  };",
  "})()"
].join('\n');

// Layout audit: the widget is checked against the WPF canvas by numbers,
// because a wrong box or an ellipsised label is invisible in a text report.
const READ_LAYOUT = [
  "(() => {",
  "  const box = el => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };",
  "  const scene = document.getElementById('scene');",
  "  const sceneRect = scene.getBoundingClientRect();",
  "  const rows = [...document.querySelectorAll('.row')].filter(row => !row.classList.contains('hidden')).map(row => {",
  "    const reset = row.querySelector('.row-reset');",
  "    const value = row.querySelector('.row-value');",
  "    const label = row.querySelector('.row-label');",
  "    return {",
  "      label: label.textContent,",
  "      value: value.textContent,",
  "      row: box(row),",
  "      labelBox: box(label),",
  "      valueBox: box(value),",
  "      resetBox: box(reset),",
  "      resetText: reset.textContent,",
  "      resetEllipsised: reset.scrollWidth > reset.clientWidth + 1,",
  "      belowScene: box(row).y + box(row).h > sceneRect.y + sceneRect.h + 0.5",
  "    };",
  "  });",
  "  const overlapping = rows.some((row, index) => index > 0 && row.row.y < rows[index - 1].row.y + rows[index - 1].row.h);",
  "  const balance = document.getElementById('balance-view');",
  "  const balanceVisible = !balance.classList.contains('hidden');",
  "  const box2 = id => { const el = document.getElementById(id); const r = el.getBoundingClientRect(); return {text: el.textContent, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), insideScene: r.left >= sceneRect.left - 0.5 && r.right <= sceneRect.right + 0.5 && r.bottom <= sceneRect.bottom + 0.5}; };",
  "  return {",
  "    scene: box(scene),",
  "    bubble: box(document.getElementById('bubble')),",
  "    header: box(document.getElementById('header')),",
  "    headerText: document.getElementById('header').textContent,",
  "    rows,",
  "    overlapping,",
    "    balanceVisible,",
    "    balance: balanceVisible ? {amount: box2('balance-amount'), detail: box2('balance-detail'), badge: box2('balance-badge'), countdown: box2('balance-countdown'), detailEllipsised: (() => { const el = document.getElementById('balance-detail'); return el.scrollWidth > el.clientWidth + 1; })()} : null,",
  "    documentWidth: document.documentElement.scrollWidth,",
  "    clientWidth: document.documentElement.clientWidth,",
  "    font: getComputedStyle(document.getElementById('header')).fontFamily",
  "  };",
  "})()"
].join('\n');

app.whenReady().then(async () => {
  protocol.handle(ASSET_SCHEME, request => {
    const file = resolveAssetPath(assets, request.url);
    if (!file) return new Response('forbidden', {status: 403});
    try {
      return new Response(new Uint8Array(fs.readFileSync(file)), {headers: {'content-type': assetMimeType(file)}});
    } catch {
      return new Response('not found', {status: 404});
    }
  });
  // One window for every case: the renderer re-applies state on demand, and
  // churning windows in a loop upsets Chromium.
  const window = new BrowserWindow({
    width: 350,
    height: 350,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'toolbar',
    show: false,
    webPreferences: {
      preload: path.join(here, 'render-stub.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await window.loadFile(path.join(here, '..', 'renderer', 'widget.html'));
  // capturePage needs a visible surface, so the check shows the widget briefly.
  window.showInactive();
  await wait(300);
  const windowSize = {dip: window.getSize(), content: window.getContentSize()};
  if (process.env.GPT_NIANG_CAPTURE_COLLAPSED) {
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.GPT_NIANG_CAPTURE_COLLAPSED, image.toPNG());
    console.log('CAPTURED_COLLAPSED ' + JSON.stringify(image.getSize()));
  }
  // The sprite and the sounds load through the custom scheme, so a broken URL
  // shows up here instead of silently leaving the character invisible.
  const assetsLoaded = await window.webContents.executeJavaScript(
    '({sprite: document.getElementById("girl").naturalWidth, spriteHeight: document.getElementById("girl").naturalHeight})'
  );

  const results = [];
  for (const testCase of cases) {
    try {
      // applyState is the renderer's own entry point for a pushed snapshot.
      const payload = JSON.stringify({
        settings,
        snapshot: testCase.snapshot,
        // DeepSeek's row shows the pricing window and a countdown, so the check
        // needs that state pushed in too (a peak window ending in 1h35m).
        peak: {
          isPeak: true,
          nextChangeAt: Math.floor(Date.now() / 1000) + 95 * 60,
          peakHours: '周一至周五 9:00–12:00、14:00–18:00（北京时间）',
          valleyNote: '其余时段（含周末与法定节假日）为优惠时段'
        },
        version: '1.3.4',
        autostart: false
      });
      const collapsed = await window.webContents.executeJavaScript(
        'applyState(' + payload + '); ({header: document.getElementById("header").textContent, bubbleHidden: document.getElementById("bubble").classList.contains("hidden"), tailOpacity: getComputedStyle(document.getElementById("tail")).opacity})'
      );
      await window.webContents.executeJavaScript('document.getElementById("girl").click()');
      await wait(320);
      const quota = await window.webContents.executeJavaScript(READ_QUOTA);
      const layout = await window.webContents.executeJavaScript(READ_LAYOUT);
      if (process.env.GPT_NIANG_CAPTURE) {
        const image = await window.webContents.capturePage();
        // One file per case, so the balance layout can be looked at directly.
        const file = process.env.GPT_NIANG_CAPTURE.replace(/\.png$/, '') + '-' + testCase.name + '.png';
        fs.writeFileSync(file, image.toPNG());
        console.log('CAPTURED ' + file + ' ' + JSON.stringify(image.getSize()));
      }
      await window.webContents.executeJavaScript('document.getElementById("girl").click()');
      await wait(320);
      const quote = await window.webContents.executeJavaScript(
        '({text: document.getElementById("quote-text").textContent, visible: !document.getElementById("quote-view").classList.contains("hidden")})'
      );
      await window.webContents.executeJavaScript('document.getElementById("girl").click()');
      await wait(260);
      results.push({name: testCase.name, collapsed, quota, layout, quote});
    } catch (error) {
      results.push({name: testCase.name, error: error?.message ?? String(error)});
    }
  }
  window.destroy();
  console.log('RENDER_REPORT ' + JSON.stringify({assetsLoaded, windowSize, results}, null, 2));
  app.exit(0);
});

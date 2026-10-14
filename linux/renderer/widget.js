// Presentation only: the main process owns quota data, window movement and
// settings. This script renders the bubble and reports pointer intent.

const stage = document.getElementById('stage');
const bubble = document.getElementById('bubble');
const header = document.getElementById('header');
const refreshButton = document.getElementById('refresh');
const rowsContainer = document.getElementById('rows');
const quoteView = document.getElementById('quote-view');
const quoteText = document.getElementById('quote-text');
const quotaView = document.getElementById('quota-view');
const liveDot = document.getElementById('live-dot');
const girl = document.getElementById('girl');
const menuButton = document.getElementById('menu-button');

const DESIGN_WINDOW = 350;
const DESIGN_STAGE = 378;
const AUTO_HIDE_MS = 5000;
const PRESS_SOUND = 'gpt-asset://press.wav';
const RELEASE_SOUND = 'gpt-asset://release.wav';

let settings = null;
let snapshot = null;
let view = 'collapsed';
let hideTimer = null;
let lastQuote = '';
let dragging = false;
let moved = false;
const dragOrigin = {x: 0, y: 0};
const pressAudio = new Audio(PRESS_SOUND);
const releaseAudio = new Audio(RELEASE_SOUND);

const rows = [
  {root: document.getElementById('row-0'), label: null, value: null, bar: null, fill: null, reset: null},
  {root: document.getElementById('row-1'), label: null, value: null, bar: null, fill: null, reset: null}
];
for (const row of rows) {
  row.label = row.root.querySelector('.row-label');
  row.value = row.root.querySelector('.row-value');
  row.bar = row.root.querySelector('.bar');
  row.fill = row.root.querySelector('.bar-fill');
  row.reset = row.root.querySelector('.row-reset');
}

function money(value, currency) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
  const amount = Number(value);
  return symbol + (Number.isFinite(amount) ? amount.toFixed(2) : '—');
}

// Reset line text follows the desktop build: a relative "N 分钟后重置"
// phrase, or the remaining-hours form for longer windows.
function relativeReset(seconds) {
  if (seconds <= 0) return '重置已到 · 等待刷新';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟后重置';
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? hours + ' 小时后重置' : hours + ' 小时 ' + rest + ' 分后重置';
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return hours === 0 ? days + ' 天后重置' : days + ' 天 ' + hours + ' 小时后重置';
}

function absoluteReset(timestamp) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === date.toDateString();
  const day = sameDay ? '今日' : tomorrow ? '明日' : String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  return day + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ' 重置';
}

function headerText() {
  if (!snapshot) return '正在读取';
  if (snapshot.source === 'deepseek') return 'DeepSeek 余额';
  if (!snapshot.ok) return '暂无法读取';
  const age = Date.now() - (snapshot.observedAt ?? 0);
  if (snapshot.error || age > 180000) return '上次剩余额度';
  return '剩余额度';
}

function rowFallbackText() {
  if (!snapshot) return '正在读取订阅额度…';
  if (snapshot.source === 'deepseek') return snapshot.error ?? '余额读取异常';
  if (!snapshot.queryOk) return '额度读取异常';
  return '暂无额度数据';
}

function renderRow(row, window_) {
  if (!window_) {
    row.label.textContent = '—';
    row.value.textContent = '—';
    row.bar.classList.remove('hidden-bar');
    row.fill.style.width = '0%';
    row.reset.textContent = rowFallbackText();
    row.root.title = '';
    return;
  }
  const remaining = Number(window_.remaining);
  row.label.textContent = window_.label ?? '—';
  row.value.textContent = Number.isFinite(remaining) ? String(Math.round(remaining)) : '—';
  row.bar.classList.remove('hidden-bar');
  row.fill.style.width = Math.max(0, Math.min(100, Number.isFinite(remaining) ? remaining : 0)) + '%';
  const reset = Number(window_.resetsAt);
  if (Number.isFinite(reset) && reset > 0) {
    const seconds = reset - Math.floor(Date.now() / 1000);
    row.reset.textContent = relativeReset(seconds);
    row.reset.title = '本机时间 ' + absoluteReset(reset);
  } else {
    row.reset.textContent = '未提供重置时间';
    row.reset.title = '';
  }
  // Hover keeps the extra windows the compact layout cannot show.
  const detail = Array.isArray(window_.detail) ? '\n' + window_.detail.join('\n') : '';
  row.root.title = (window_.label ?? '') + '：已用 ' + (Number.isFinite(Number(window_.used)) ? Number(window_.used).toFixed(1) : '—') + '%' + detail;
}

function renderBalanceRow(row, balance) {
  row.label.textContent = 'DeepSeek 余额';
  row.value.textContent = money(balance.total, balance.currency);
  row.bar.classList.add('hidden-bar');
  row.reset.textContent = '充值 ' + money(balance.toppedUp ?? 0, balance.currency) + ' · 赠送 ' + money(balance.granted ?? 0, balance.currency);
  row.reset.title = '';
  row.root.title = balance.available === false ? 'DeepSeek 余额不可用（账户欠费或受限）' : '';
}

function render() {
  header.textContent = headerText();
  header.title = headerTitle();
  liveDot.classList.toggle('hidden', !snapshot || snapshot.queryOk === false);
  if (snapshot?.source === 'deepseek') {
    rowsContainer.classList.remove('single');
    renderBalanceRow(rows[0], snapshot.balance ?? {});
    rows[1].root.classList.add('hidden');
    return;
  }
  rows[1].root.classList.remove('hidden');
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  rowsContainer.classList.toggle('single', windows.length === 1);
  renderRow(rows[0], windows[0] ?? null);
  renderRow(rows[1], windows[1] ?? null);
  const extra = windows.slice(2);
  if (extra.length > 0) {
    const detail = extra.map(window => window.label + '：剩余 ' + Math.round(window.remaining) + '%');
    rows[0].root.title = (rows[0].root.title ? rows[0].root.title + '\n' : '') + detail.join('\n');
  }
}

function headerTitle() {
  if (!snapshot) return '正在读取额度信息';
  const parts = [];
  if (snapshot.planLabel) parts.push('当前套餐：' + snapshot.planLabel);
  if (snapshot.source === 'deepseek') parts.push('数据源：DeepSeek 余额（API Key 登录不提供订阅额度）');
  parts.push('重置时间按本机时间显示');
  return parts.join(' · ');
}

function applyScale() {
  const scale = Number(settings?.scale) || 1;
  stage.style.setProperty('--ui-scale', String(scale * (DESIGN_WINDOW / DESIGN_STAGE)));
}

function play(audio) {
  if (!settings?.sound?.enabled) return;
  audio.volume = Math.max(0, Math.min(1, Number(settings.sound.volume ?? 0.8)));
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function show(next) {
  view = next;
  // The bubble tails are part of the bubble, not of the character.
  stage.classList.toggle('collapsed', view === 'collapsed');
  if (view === 'collapsed') {
    bubble.classList.remove('opening');
    bubble.classList.add('closing');
    setTimeout(() => {
      if (view === 'collapsed') bubble.classList.add('hidden');
    }, 190);
    clearTimeout(hideTimer);
    return;
  }
  bubble.classList.remove('hidden', 'closing');
  bubble.classList.remove('opening');
  void bubble.offsetWidth;
  bubble.classList.add('opening');
  quotaView.classList.toggle('hidden', view !== 'quota');
  quoteView.classList.toggle('hidden', view !== 'quote');
  play(releaseAudio);
  if (view === 'quote') void loadQuote();
  clearTimeout(hideTimer);
  if (settings?.clickToAdvance !== false) {
    hideTimer = setTimeout(() => show('collapsed'), 260 + AUTO_HIDE_MS);
  }
}

async function loadQuote() {
  try {
    const result = await window.niang.quotes.next();
    if (result?.text) {
      lastQuote = result.text;
      quoteText.textContent = result.text;
    }
  } catch {}
}

function advance() {
  if (view === 'collapsed') show('quota');
  else if (view === 'quota') show('quote');
  else show('collapsed');
}

function applyState(payload) {
  settings = payload.settings;
  snapshot = payload.snapshot;
  stage.classList.toggle('facing-left', settings?.anchor === 'right');
  applyScale();
  render();
}

window.niang.onState(applyState);
window.niang.state().then(applyState);

// Clicking the character or the bubble walks quota -> quote -> collapsed.
girl.addEventListener('click', event => {
  if (girl.dataset.dragged === '1') {
    delete girl.dataset.dragged;
    return;
  }
  event.stopPropagation();
  advance();
});
bubble.addEventListener('click', event => {
  if (event.target === refreshButton) return;
  advance();
});
refreshButton.addEventListener('click', event => {
  event.stopPropagation();
  void window.niang.refresh();
});
quoteView.addEventListener('click', () => show('collapsed'));
menuButton.addEventListener('click', event => {
  event.stopPropagation();
  void window.niang.openSettings();
});
document.addEventListener('contextmenu', event => {
  event.preventDefault();
  window.niang.menu();
});
window.niang.onBubble(mode => show(mode === 'quota' ? 'quota' : 'quote'));

// Drag: the press sound plays immediately, a real movement promotes the
// gesture to a drag and the drop position is handed back to the main process.
girl.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragging = true;
  moved = false;
  dragOrigin.x = event.screenX;
  dragOrigin.y = event.screenY;
  girl.setPointerCapture(event.pointerId);
  girl.classList.add('pressed');
  play(pressAudio);
  window.niang.pointer({type: 'down', x: event.screenX, y: event.screenY});
});
girl.addEventListener('pointermove', event => {
  if (!dragging) return;
  if (!moved && Math.abs(event.screenX - dragOrigin.x) + Math.abs(event.screenY - dragOrigin.y) < 4) return;
  moved = true;
  girl.dataset.dragged = '1';
  window.niang.pointer({type: 'move', x: event.screenX, y: event.screenY});
});
function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  girl.classList.remove('pressed');
  window.niang.pointer({type: 'up', x: event.screenX, y: event.screenY});
}
girl.addEventListener('pointerup', endDrag);
girl.addEventListener('pointercancel', endDrag);

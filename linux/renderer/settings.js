const elements = {
  version: document.getElementById('version'),
  scale: document.getElementById('scale'),
  scaleValue: document.getElementById('scale-value'),
  modeDesktop: document.getElementById('mode-desktop'),
  topmost: document.getElementById('topmost'),
  soundEnabled: document.getElementById('sound-enabled'),
  volume: document.getElementById('volume'),
  volumeValue: document.getElementById('volume-value'),
  clickAdvance: document.getElementById('click-advance'),
  clickThrough: document.getElementById('click-through'),
  quotaSource: document.getElementById('quota-source'),
  quotaStatus: document.getElementById('quota-status'),
  refresh: document.getElementById('refresh'),
  quotes: document.getElementById('quotes'),
  quotesSave: document.getElementById('quotes-save'),
  quotesReset: document.getElementById('quotes-reset'),
  quotesStatus: document.getElementById('quotes-status'),
  autostart: document.getElementById('autostart'),
  quit: document.getElementById('quit'),
  environment: document.getElementById('environment')
};

const percent = value => Math.round(Number(value) * 100) + '%';
let loading = false;

function describeStatus(snapshot) {
  if (!snapshot) return '尚未读取额度。';
  const lines = [];
  if (snapshot.source === 'deepseek') {
    const balance = snapshot.balance ?? {};
    lines.push('数据源：DeepSeek 余额');
    if (snapshot.ok) lines.push('余额：' + (balance.total ?? '—') + ' ' + (balance.currency ?? ''));
  } else {
    lines.push('数据源：Codex 官方额度');
    if (snapshot.planLabel) lines.push('套餐：' + snapshot.planLabel);
    for (const window of snapshot.windows ?? []) lines.push(window.label + ' 剩余 ' + Math.round(window.remaining) + '%');
  }
  if (snapshot.error) lines.push('提示：' + snapshot.error);
  if (snapshot.checkedAt) lines.push('更新时间：' + new Date(snapshot.checkedAt).toLocaleString());
  return lines.join('\n');
}

function render(state) {
  loading = true;
  const settings = state.settings;
  elements.version.textContent = '版本 ' + state.version + ' · Linux';
  elements.scale.value = String(settings.scale);
  elements.scaleValue.textContent = percent(settings.scale);
  elements.modeDesktop.checked = settings.mode === 'desktop';
  elements.topmost.checked = Boolean(settings.desktopTopmost);
  elements.topmost.disabled = settings.mode !== 'desktop';
  elements.soundEnabled.checked = Boolean(settings.sound.enabled);
  elements.volume.value = String(settings.sound.volume);
  elements.volumeValue.textContent = percent(settings.sound.volume);
  elements.clickAdvance.checked = settings.clickToAdvance !== false;
  elements.clickThrough.checked = settings.clickThrough !== false;
  elements.quotaSource.value = settings.quotaSource;
  elements.autostart.checked = Boolean(state.autostart);
  elements.quotaStatus.textContent = describeStatus(state.snapshot);
  elements.environment.textContent = [
    '会话：X11 ' + (state.x11 ? '可用' : '不可用（跟随模式需要 --ozone-platform=x11）'),
    '跟随方式：' + (state.eventFollow ? 'X11 事件推送' : 'xwininfo 轮询'),
    '挂件可见：' + (state.visible ? '是' : '否'),
    '数据目录：' + (state.dataDir ?? '（见日志）')
  ].join('\n');
  loading = false;
}

async function patch(values) {
  await window.niang.settings.set(values);
}

window.niang.onState(render);
window.niang.state().then(async state => {
  render(state);
  const quotes = await window.niang.quotes.list();
  elements.quotes.value = quotes.custom.join('\n');
  elements.quotesStatus.textContent = quotes.custom.length
    ? '当前使用 ' + quotes.custom.length + ' 句自定义语录（内置 ' + quotes.builtin.length + ' 句）'
    : '当前使用内置 ' + quotes.builtin.length + ' 句语录';
});

elements.scale.addEventListener('input', () => {
  elements.scaleValue.textContent = percent(elements.scale.value);
  if (!loading) void patch({scale: Number(elements.scale.value)});
});
for (const button of document.querySelectorAll('[data-scale]')) {
  button.addEventListener('click', () => void patch({scale: Number(button.dataset.scale)}));
}
elements.modeDesktop.addEventListener('change', () => {
  void patch({mode: elements.modeDesktop.checked ? 'desktop' : 'host'});
});
elements.topmost.addEventListener('change', () => void patch({desktopTopmost: elements.topmost.checked}));
elements.soundEnabled.addEventListener('change', () => void patch({sound: {enabled: elements.soundEnabled.checked}}));
elements.volume.addEventListener('input', () => {
  elements.volumeValue.textContent = percent(elements.volume.value);
  if (!loading) void patch({sound: {volume: Number(elements.volume.value)}});
});
elements.clickAdvance.addEventListener('change', () => void patch({clickToAdvance: elements.clickAdvance.checked}));
elements.clickThrough.addEventListener('change', () => void patch({clickThrough: elements.clickThrough.checked}));
elements.quotaSource.addEventListener('change', () => {
  void patch({quotaSource: elements.quotaSource.value}).then(() => window.niang.refresh());
});
elements.refresh.addEventListener('click', async () => {
  elements.quotaStatus.textContent = '正在刷新…';
  await window.niang.refresh();
});
elements.quotesSave.addEventListener('click', async () => {
  const list = elements.quotes.value.split('\n').map(line => line.trim()).filter(Boolean);
  const result = await window.niang.quotes.save(list.map(text => ({text, weight: 1})));
  const builtin = await window.niang.quotes.list();
  elements.quotesStatus.textContent = result.custom.length
    ? '已保存 ' + result.custom.length + ' 句自定义语录'
    : '已清空自定义语录，使用内置 ' + builtin.builtin.length + ' 句';
});
elements.quotesReset.addEventListener('click', async () => {
  const result = await window.niang.quotes.reset();
  elements.quotes.value = '';
  elements.quotesStatus.textContent = result.backup ? '已恢复内置语录，原文件备份为 ' + result.backup : '当前没有自定义语录';
});
elements.autostart.addEventListener('change', () => void patch({autostart: elements.autostart.checked}));
elements.quit.addEventListener('click', () => window.niang.quit());

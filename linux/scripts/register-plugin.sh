#!/usr/bin/env bash
#
# Register this widget as a Codex plugin, the way Install.ps1 does on Windows:
# build a one-plugin marketplace (a `.agents/plugins/marketplace.json` manifest
# plus the plugin under `plugins/`), then let the Codex CLI install and enable it
# (`codex plugin marketplace add` + `codex plugin add`).
#
#   scripts/register-plugin.sh                 # install / refresh
#   scripts/register-plugin.sh --remove        # uninstall and forget it
#   scripts/register-plugin.sh --source <dir>  # plugin source (default: ../gpt-niang-usage)
#   scripts/register-plugin.sh --root <dir>    # marketplace root (default: under the widget's data dir)
#   scripts/register-plugin.sh --widget <file>  # installed widget executable or AppImage
#
# The plugin is copied rather than linked: the copy is what Codex materialises,
# and the script rewrites its .mcp.json with the absolute node path it found, so
# the tool keeps working wherever this checkout lives.

set -euo pipefail

plugin_id='gpt-niang-usage'
marketplace_id='gpt-niang-local'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$here/../.." && pwd)/gpt-niang-usage"
data_dir="${GPT_NIANG_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/GPTNiangUsage/state}"
marketplace_root="$(dirname "$data_dir")/plugin-marketplace/$marketplace_id"
codex_bin="${CODEX_BIN:-$(command -v codex || true)}"
action='install'
widget_bin=''

while [ $# -gt 0 ]; do
  case "$1" in
    --remove) action='remove'; shift ;;
    --source) source_dir="$2"; shift 2 ;;
    --root) marketplace_root="$2"; shift 2 ;;
    --widget) widget_bin="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$codex_bin" ] || [ ! -x "$codex_bin" ]; then
  echo "找不到 codex 命令；请确认 Codex 已安装（可用 CODEX_BIN 指定路径）。" >&2
  exit 1
fi

plugin_dir="$marketplace_root/plugins/$plugin_id"

plugin_list() {
  "$codex_bin" plugin list --json
}

if [ "$action" = 'remove' ]; then
  "$codex_bin" plugin remove "$plugin_id@$marketplace_id" --json >/dev/null 2>&1 || true
  "$codex_bin" plugin marketplace remove "$marketplace_id" >/dev/null 2>&1 || true
  rm -rf "$marketplace_root"
  echo "已从 Codex 注销 $plugin_id@$marketplace_id，并删除市场目录 $marketplace_root。"
  exit 0
fi

if [ ! -f "$source_dir/.codex-plugin/plugin.json" ]; then
  echo "插件源目录不完整（缺 .codex-plugin/plugin.json）：$source_dir" >&2
  exit 1
fi

node_bin="${GPT_NIANG_NODE:-$(command -v node || true)}"
if [ -z "$node_bin" ]; then
  echo "找不到 node；额度工具需要 Node.js 20+（可用 GPT_NIANG_NODE 指定路径）。" >&2
  exit 1
fi

version="$(node -e "process.stdout.write(require('$source_dir/.codex-plugin/plugin.json').version)")"

# Prefer the current checkout for source installs. Packaged installs can pass
# --widget, or use an executable installed on PATH by the deb package.
widget_app_dir="$(dirname "$source_dir")/linux"
widget_args=()
if [ -n "$widget_bin" ]; then
  widget_bin="$(realpath "$widget_bin")"
  widget_args=(--ozone-platform=x11)
elif [ -x "$widget_app_dir/node_modules/electron/dist/electron" ]; then
  widget_bin="$(realpath "$widget_app_dir/node_modules/electron/dist/electron")"
  widget_args=(--ozone-platform=x11 "$widget_app_dir")
elif command -v gpt-niang-usage-linux >/dev/null 2>&1; then
  widget_bin="$(realpath "$(command -v gpt-niang-usage-linux)")"
  widget_args=(--ozone-platform=x11)
fi
if [ -n "$widget_bin" ] && [ ! -x "$widget_bin" ]; then
  echo "桌面挂件不可执行：$widget_bin" >&2
  exit 1
fi

# The plugin only needs the manifest, its MCP declaration, the runtime the tool
# runs from and the assets the manifest points at.
rm -rf "$plugin_dir"
mkdir -p "$plugin_dir" "$marketplace_root/.agents/plugins"
cp -r "$source_dir/.codex-plugin" "$plugin_dir/.codex-plugin"
cp -r "$source_dir/runtime" "$plugin_dir/runtime"
cp -r "$source_dir/assets" "$plugin_dir/assets"
# Absolute paths, so the tool does not depend on how Codex resolves the plugin
# root (the shipped .mcp.json uses ${CLAUDE_PLUGIN_ROOT}, which Codex does
# substitute; this is the same belt-and-braces step Install.ps1 takes).
node -e "
  const fs = require('node:fs');
  const [nodePath, runtimeFile] = process.argv.slice(1);
  const mcp = {mcpServers: {'$plugin_id': {command: nodePath, args: [runtimeFile]}}};
  fs.writeFileSync('$plugin_dir/.mcp.json', JSON.stringify(mcp, null, 2) + '\n');
" "$node_bin" "$plugin_dir/runtime/mcp.mjs"

# The MCP server reads installation.json from the plugin root and re-reads it on
# every call (the Windows installer writes the same file next to its copy), so
# the tool knows where the widget's state lives and which source to use.
quota_source="auto"
if [ -f "$data_dir/settings.json" ]; then
  quota_source="$(node -e "
    const fs = require('node:fs');
    try {
      process.stdout.write(String(JSON.parse(fs.readFileSync('$data_dir/settings.json', 'utf8')).quotaSource ?? 'auto'));
    } catch { process.stdout.write('auto'); }
  ")"
fi
node -e "
  const fs = require('node:fs');
  const [dataDir, nodePath, codexPath, quotaSource, widgetBin, ...widgetArgs] = process.argv.slice(1);
  const config = {dataDir, nodePath, codexPath, quotaSource};
  if (widgetBin) config.widgetLaunch = {command: widgetBin, args: widgetArgs};
  fs.writeFileSync('$plugin_dir/installation.json', JSON.stringify(config, null, 2) + '\n');
" "$data_dir" "$node_bin" "$codex_bin" "$quota_source" "$widget_bin" "${widget_args[@]}"

# The marketplace manifest is what the CLI reads: its `name` becomes the
# marketplace id, and each entry points at a plugin directory.
node -e "
  const fs = require('node:fs');
  const manifest = {
    name: '$marketplace_id',
    plugins: [{
      name: '$plugin_id',
      source: {source: 'local', path: './plugins/$plugin_id'},
      policy: {installation: 'AVAILABLE', authentication: 'ON_USE'},
      category: 'Productivity'
    }]
  };
  fs.writeFileSync('$marketplace_root/.agents/plugins/marketplace.json', JSON.stringify(manifest, null, 2) + '\n');
"

echo "插件副本：$plugin_dir（版本 $version，node $node_bin）"
"$codex_bin" plugin marketplace add "$marketplace_root" --json >/dev/null
"$codex_bin" plugin add "$plugin_id@$marketplace_id" --json >/dev/null || {
  echo "Codex 拒绝了 $plugin_id@$marketplace_id。" >&2
  exit 1
}

# Same check the Windows installer makes: exactly one installed, enabled plugin
# with the version that was just copied.
plugin_list | node -e "
  let text = '';
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => {
    const catalog = JSON.parse(text);
    const match = (catalog.installed ?? []).filter(entry =>
      entry.pluginId === '$plugin_id@$marketplace_id' && entry.version === '$version' && entry.installed && entry.enabled);
    if (match.length !== 1) {
      console.error('Codex 没有报告一个已启用且版本匹配的插件。');
      process.exit(1);
    }
    console.log('已注册并启用：' + match[0].pluginId + ' ' + match[0].version);
    console.log('重新打开 Codex（或新建会话）后即可使用工具 get_codex_usage。');
  });
"
if [ -n "$widget_bin" ]; then
  echo "插件启动时会一并启动桌面挂件：$widget_bin"
else
  echo '未找到桌面挂件可执行文件；额度工具可用，桌面挂件不会自动启动。可用 --widget 指定路径。' >&2
fi

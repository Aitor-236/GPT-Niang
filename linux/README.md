# GPT 娘（Linux）

跟随 Codex 桌面窗口的 Linux 挂件：角色旁边显示额度窗口或 provider 余额、重置时间与语录。
界面用 Electron 实现，额度查询复用仓库里 Windows / macOS 共用的 Node 后端
（`gpt-niang-usage/runtime`），角色、音效与语录沿用同一份素材。

## 环境要求

- Node.js 20 或更新版本（额度 worker 需要，Electron 内置的 Node 不用于此）。
- 已安装并登录的 Codex 桌面端。
- **X11/XWayland 会话**。跟随功能依赖读取其他窗口的几何信息并给自己的窗口定位，
  Wayland 原生客户端两者都做不到，因此应用必须以 `--ozone-platform=x11` 启动；
  `npm start`、deb 桌面入口与 AppImage 入口都已经带上这个参数；如果在 Wayland 会话里
  发现启动时没带上它，应用会自己带参数重启一次（只重启一次，不会循环），
  仍拿不到 X11 后端才退回桌面模式并给出提示。

## 运行

```sh
npm install          # 安装 Electron 与 electron-builder
npm run fix-sandbox  # 首次需要：给 chrome-sandbox 加 setuid（要 sudo）
npm start            # 启动挂件
```

`npm start` 已经带上 `--ozone-platform=x11`。手动启动时不要漏掉这个参数；
万一漏了，应用会在 Wayland 会话里自己重启一次补上。

## 自检

```sh
npm run spike        # 技术验证：定位、置顶层级、轮询开销、X11 会话、事件订阅与点击穿透（会短暂显示一个测试窗口）
npm run check:render # 渲染自检：用固定的额度/余额/异常快照渲染气泡并打印结果（无界面）
npm test             # 本目录的几何与 X11 解析测试
cd ../gpt-niang-usage && node --test tests/*.test.mjs   # 共享后端测试
```

额度数据源也可以单独验证：

```sh
cd ../gpt-niang-usage
node runtime/detect-plan.mjs                      # 官方额度（需要 ChatGPT 登录）
node runtime/detect-plan.mjs --source deepseek    # provider 余额
node runtime/detect-plan.mjs --source auto        # 与挂件实际显示一致
```

## 打包

```sh
npm run pack         # 只解包到 dist/linux-unpacked，便于快速验证
npm run dist         # 产出 dist/*.AppImage 与 dist/*.deb
```

deb 的安装脚本会把 `chrome-sandbox` 设为 root 所有并加 setuid，沙箱完整生效；
AppImage 用 FUSE 挂载，无法保留 setuid，electron-builder 默认以 `--no-sandbox` 启动。
两种包都会把共享后端与素材放进 `resources/runtime`、`resources/assets`，不需要额外安装。

AppImage 需要 `libfuse.so.2`：Ubuntu 24.04 起默认只装 fuse3，缺库时请安装 `libfuse2t64`
（或 `libfuse2`），也可以改用 deb 包——deb 是长期安装的推荐形式。

## 数据与配置

- 状态目录：`~/.local/share/GPTNiangUsage/state`（`GPT_NIANG_DATA_DIR` 可覆盖）。
  内含 `settings.json`（偏好）、`installation.json`、worker 写出的 `status.json`、
  `presence.json` 与 `quotes.json`（自定义语录）。
- 自启：`~/.config/autostart/gpt-niang-usage.desktop`，可在设置里开关。
- 读取范围：只读 `~/.codex/config.toml` 的 provider 段与 `~/.codex/auth.json` 取凭据，
  不写 Codex 自己的登录与会话数据；凭据只在内存中，状态文件里只保存一个不可逆的账号指纹。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `GPT_NIANG_DATA_DIR` | 覆盖状态目录 |
| `GPT_NIANG_PIXEL_SCALE` | 覆盖 X11 像素与 Electron DIP 的换算比例（默认取显示器缩放） |
| `GPT_NIANG_GPU=1` | 重新启用硬件加速（默认关闭，见下） |
| `GPT_NIANG_CODEX_APP` | 指定 Codex 安装根目录，替代自动探测（与 macOS 端同名开关） |
| `GPT_NIANG_RUNTIME_DIR` / `GPT_NIANG_ASSETS_DIR` | 覆盖共享后端与素材位置 |
| `GPT_NIANG_DEBUG=1` | 把运行日志打到 stderr |
| `GPT_NIANG_POINTER_TEST=x,y` | 用固定的 DIP 坐标代替真实指针，便于验证点击穿透（配合 `GPT_NIANG_DEBUG=1` 看命中日志） |
| `GPT_NIANG_OPEN_SETTINGS=1` | 启动时打开设置窗口 |

## 已实现与暂缓

已实现：跟随 Codex 窗口显示额度/余额（X11 事件推送，连接不可用时自动回落到 xwininfo 轮询）、
透明区域点击穿透、语录切换、拖动与边缘吸附、60%–250% 缩放、
桌面模式与置顶、右键菜单、设置窗口、开机自启、双数据源（官方额度与 provider 余额）、
单实例、宿主最小化/隐藏时自动收起。

暂缓（接口已留出，尚未实现）：内置自动更新与回滚、Codex 插件市场注册
（`get_codex_usage` MCP 工具）、聊天速度面板。

## 已知限制

- **层级语义**：跟随模式下挂件是独立的 X11 工具窗口（`_NET_WM_STATE_ABOVE`），
  并尽力设置 `WM_TRANSIENT_FOR`。这与 Windows 端「被别的窗口盖住时一起被盖住」的行为不同，
  与 macOS 端早期版本的取舍一致。
- **窗口识别**：按 `WM_CLASS`（chatgpt/codex）+ 已映射 + 屏幕内可见面积挑选宿主窗口。
  Codex 桌面端会同时存在多个辅助窗口（含一个比屏幕更高的窗口），因此不使用固定尺寸或堆叠顺序判断。
- **硬件加速**：本机没有可用的 DRM 设备，GPU 进程会崩溃导致窗口不绘制，所以默认关闭硬件加速。
  在有可用显卡的机器上可用 `GPT_NIANG_GPU=1` 打开。
- **无托盘图标**：GNOME 默认不显示托盘图标，入口放在右键菜单与设置窗口。
- **缩放换算**：X11 坐标是像素、Electron 窗口 API 是 DIP，两者按显示器缩放换算（本机 1.25）。
  窗口实际像素尺寸会由 Chromium 取整（350 DIP 在本机是 438px），跟随位置仍按请求尺寸计算。
- **窗口尺寸看守**：窗口尺寸不用 `resizable: false` 固定，而是显式设置 min/max —— 那个开关
  会把最大值钉在当时的大小上，而 XWayland 在窗口部分出屏时会被合成器改大，于是一旦变大就
  再也缩不回来（实测过一个 2842×2635 的挂件窗口压住整个屏幕下半部）。现在所有移动路径都会
  把整窗限制在显示器内，另有看守按需要把尺寸拉回请求值，`npm run spike` 可验证。
- **点击穿透**：Electron 只能整窗开关鼠标输入（`setIgnoreMouseEvents`，Linux 不支持
  `forward`），因此主进程以 60Hz 采样指针位置，指针进入挂件矩形后才请渲染进程做命中测试
  （角色按贴图 alpha 逐像素判定，气泡只在其轮廓/文字/按钮上命中），其余透明区域一律穿透。
  拖动与右键菜单打开时强制保持可交互。设置里可整体关闭穿透。

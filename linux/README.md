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
| `GPT_NIANG_FIT_TEST=宽x高` | 让跟随逻辑把 Codex 窗口当成这个像素尺寸，便于验证"窗口太小就缩小"的行为 |
| `GPT_NIANG_OPEN_SETTINGS=1` | 启动时打开设置窗口 |

## 已实现与暂缓

已实现：跟随 Codex 窗口显示额度/余额（X11 事件推送，连接不可用时自动回落到 xwininfo 轮询）、
透明区域点击穿透、语录切换、拖动与边缘吸附、60%–250% 缩放、
桌面模式与置顶、右键菜单、设置窗口、开机自启、双数据源（官方额度与 provider 余额）、
单实例、宿主最小化/隐藏时自动收起。

跟随位置始终待在 Codex 窗口内：可用区取"Codex 窗口 ∩ 所在显示器"（与 macOS 端
`Placement.usableArea` 一致），窗口比挂件还小时挂件按较小的那一维等比缩小
（`min(尺寸, 可用区)`，设计下限 60%），窗口变大后再恢复。桌面模式不受此限制。
拖动的范围同样是这个可用区：跟随模式下拖到窗口边缘就停住，不会拖出去再弹回来；
桌面模式仍在整个桌面范围内拖动。

暂缓（接口已留出，尚未实现）：内置自动更新与回滚、Codex 插件市场注册
（`get_codex_usage` MCP 工具）、聊天速度面板。

## 已知限制

- **层级语义（与 Windows 端一致）**：跟随模式下挂件是 Codex 窗口的**附属窗口**
  （`WM_TRANSIENT_FOR`，映射前设置，对应 Windows 端的 owner window）：它始终在 Codex
  窗口之上，但不做全局置顶，所以切到别的窗口时挂件和 Codex 窗口一起被盖住，切回 Codex
  时两者一起回到最前。只有当窗口管理器没有保留附属关系时，才回退到 `_NET_WM_STATE_ABOVE`
  以保证挂件不被自己的宿主压住；桌面模式按用户偏好决定是否置顶。
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
- **DeepSeek 气泡排版**（与参考挂件一致）：标题「DeepSeek 余额」→ 大号余额 → 一行明细
  （充值／赠送；API 报 `is_available=false` 时金额位置显示"不可用"，不把不可花的数字当余额）
  → **时段徽标 + 倒计时**（`谷` 绿色 / `峰` 红色，倒计时每秒跳动，并带同色下划线）。悬停显示
  余额明细与时段规则。规则与参考实现同源：**高峰 = 北京时间周一至周五（不含中国法定节假日）
  9:00–12:00、14:00–18:00**，其余时段（含周末、调休上班的周末与法定节假日全天）为优惠时段；
  规则数据在共享后端 `runtime/peak.mjs`，节假日表按年维护，当年缺表时启动日志会给出
  `peak-holidays-missing` 提醒。
  参考挂件那一行显示的是「今日已用」，官方 DeepSeek 接口不提供当日用量（参考实现是按自己的
  调用记账算出来的），所以这里用同样位置的充值／赠送明细代替，不编造用量数字。
- **焦点**：点击挂件会让它取得键盘焦点（会把 Codex 输入框的光标焦点带走）。Windows 端用
  `WS_EX_NOACTIVATE` 避免这一点，X11 上安全的等价物不存在：Electron 的 `focusable: false`
  在 Linux 上会停止与窗口管理器交互并让窗口永远置顶，`WM_HINTS.input=False` 实测也会让
  mutter 把挂件一直压在最上面 —— 两者都会破坏"随 Codex 窗口一起被遮挡"。这里选择保留遮挡
  行为。
- **指针位置的来源**：穿透判断不能用 Electron 的 `screen.getCursorScreenPoint()` ——
  它只在 Chromium 自己的窗口收到指针事件时才更新，而挂件在穿透状态下输入形状是空的、
  永远收不到事件，于是这个值会冻结在启动时的位置，"指针是否在角色上"就永远答不出"是"。
  所以挂件改为通过自己的 X11 连接直接向服务器查询指针位置（`QueryPointer`），
  `screen.getCursorScreenPoint()` 只作为连接不可用时的兜底。
- **跟随缩放的取整**：Chromium 会把窗口的像素尺寸向上取整到设备栅格（350 DIP 在本机是
  438px，实际窗口 440px），因此可用区会比挂件多留几像素余量，保证缩小时不会溢出。

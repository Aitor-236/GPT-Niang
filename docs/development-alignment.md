# GPT-Niang 开发任务统一基准

核对日期：2026-10-12。本记录用于衔接代码修复与版本、兼容性、Release 跟进任务；不表示其他会话或本机安装已完成同步。

## 已确认的共同基准

- 仓库为 `T7moris/GPT-Niang`，原名称 `GPT-Niang-Usage-Widget`。
- 本次核对的 main 为 `30abad6bd0a0aa2892722874912cfe153cf78c93`，代码版本为 1.3.3；后续工作应先获取最新 main。
- PR #20 已合并，合并提交为 `a29c6d2d1647bf0c8e5bf20f22ccb23faf19a082`。其精确 PR head 的 Windows、macOS CI 均通过，README 已登记贡献者 Admilkk。
- 本机运行目录沿用用户指定的 `outputs\gpt-niang-usage`。本任务未访问该目录、修改本机安装或发布新的 Release，不能据此判断本机版本。

## DPI 修复的统一方向

| 来源 | 已有处理 | 后续整合要求 |
| --- | --- | --- |
| [PR #20](https://github.com/T7moris/GPT-Niang/pull/20) | 拖动与跟随调用 SetWindowPos 时使用 0x15（包含 SWP_NOSIZE），只移动窗口，尺寸交给 WPF | 保留这两处修复，不恢复原生尺寸写回 |
| [PR #12](https://github.com/T7moris/GPT-Niang/pull/12) | 从设计尺寸计算目标物理像素，再按 WPF TransformToDevice 换算 DIP；原生调用也只移动 | 在最新 main 上适配，验证桌面/窗口模式与跨屏变化；不可整文件覆盖当前实现 |
| [PR #13](https://github.com/T7moris/GPT-Niang/pull/13) | 固定设计宽高，避免以变化后的 Window.Width/Height 反复计算 | 可适配固定设计尺寸及回归用例；原分支的原生 resize 调用不能直接带回 |

共同问题是 WPF DIP、宿主物理像素和可变窗口尺寸之间的反馈。#20 已切断原生 resize 反馈，#12/#13 仍需按主线适配，不能把三份旧代码直接叠加。

PR #12 同时修改 Business individualLimit 输出。其 `minutes: null` 与 macOS `QuotaWindow.minutes: Int` 存在解码兼容问题，须处理 Swift 模型/显示逻辑并补充兼容验证，再决定合并；不能作为纯 DPI 修复直接整体采用。

Issue #2、#11 保持待验证：#20 的回归验证覆盖 host/desktop 模式、1/1.5/2 倍 DPI 连续拖动与位置更新，但不是完整的真实混合 DPI 跨屏、重启或临时 2×2 宿主窗口验证。

## 必须保留的现有改动

- 菜单风格一致；“仅在 Codex 窗口内”和“整个桌面自由拖动”两种模式。
- “始终置顶”仅桌面模式显示，窗口模式隐藏并禁用；两种模式分别保存位置。
- 启动时等待 Codex 主界面就绪后显示挂件。
- Windows/macOS 自动更新、回滚及清理保护。
- 标准 MIT 代码许可、独立角色素材说明及完整贡献者 PR/Issue 记录，不按贡献量排名。
- 根 README 的“致谢与许可”和“交互参考”标记被发布脚本用于提取致谢，修改时须同步脚本。

## 下一步与状态口径

1. 另一代码任务先比对最新 main 与本机目录，保留未提交修改；再适配设计尺寸与 WPF DPI 换算，不覆盖上述功能。
2. Windows 实测跨屏、连续拖动、宿主重启、窗口最小化/加载阶段、两种显示模式及置顶开关；另行验证 Business 快照在 macOS 的解码与显示。
3. 发布前核对 README、插件清单、包版本、Windows/macOS 构建产物与 Release 一致性。本记录不提升版本号，不发布新包。
4. 跟进任务区分“代码已合并”“测试已通过”“已发布”“本机已安装”；无实质变化的条目标记“未变化”。

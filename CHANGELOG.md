# Changelog

## v0.2.1 — 2026-10-28（整理公开发布资料）

本版本的功能说明依据随包提供的 `ACCEPTANCE.zh.md`；历史实机测试没有在本次 Linux 环境中重做。

- 默认使用共享浏览器 profile，以便复用已登录的浏览器会话。
- 提供 Edge / Chrome / Brave / Vivaldi 浏览器选择和自定义 Chromium 路径。
- 按 DPI 处理嵌入窗口标题栏尺寸，并增加 `probeTitlebar()`。
- 改进降级时的提示信息及切换浏览器的界面。
- 修复安装/卸载脚本处理 UTF-8 BOM 与换行符的行为。
- 将 Windows 原生 helper (`native/win.ps1`) 纳入包。
- 清理公开分发包中的开发期探针与截图敏感信息。

查看 [验收报告](ACCEPTANCE.zh.md) 了解既有测试与尚未验证的场景。
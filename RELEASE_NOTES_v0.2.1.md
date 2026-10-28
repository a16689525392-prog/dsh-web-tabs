# dsh-web-tabs v0.2.1

面向 Windows DSH NEXT 的多页签网页浏览插件，支持将本机 Chromium 浏览器窗口嵌入 DSH 界面，并通过浏览器现有 profile 使用登录会话。

## 本版要点
- 可在单个面板中打开 ChatGPT、Claude、Gemini、Grok、muse.ai 等网页或自定义网址。
- 支持 Edge / Chrome / Brave / Vivaldi 选择器；Windows 上优先尝试真实浏览器窗口，失败时提示或回退。
- 修复插件安装/卸载时 BOM、换行符处理问题，补全 `native/win.ps1` 分发文件。
- 改善浏览器切换、窗口清理、DPI 标题栏处理和异常提示。

## 安装

**Windows** 下载 `dsh-web-tabs-0.2.1.zip`，解压后在目录中执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

完全退出并重启 DSH NEXT，然后在会话栏中选择「网页」。卸载方式和高级配置详见 README。

## 分发产物与校验

| 文件 | SHA-256 |
| --- | --- |
| `dsh-web-tabs-0.2.1.zip` | `947912b96fd65fb2fa5ba0ab14fd4e39bc5fce4b105252d3a8c297a5e430b893` |
| `dsh-web-tabs-0.2.1.tgz` | `6fc297d958edf9623bc34888a0e0d250ac50d595e641575408bbf74ab82f89a0` |

两个压缩包内的 **13 个原始文件已逐项比对一致**。

## 验证范围及限制
- 本次发布准备在 Node.js 22.16.0 下对 `lib/*.js` 完成语法检查，并核对两个上传包内的文件一致性。
- 随包 `ACCEPTANCE.zh.md` 记录开发机的 17 项客户端冒烟测试、11 项宿主路由断言及 Edge 实机测试；**本次未重做这些功能性测试**，测试脚本没有包含在分发包中。
- Chrome、Brave、Vivaldi、多屏幕和非 100% 缩放等场景仍应复测。
- 原验收报告记载的压缩文件字节数与本次上传文件不同，请以此 Release 的 SHA-256 为准。

> 插件默认访问浏览器原有登录 profile。安装前请阅读 SECURITY.md。
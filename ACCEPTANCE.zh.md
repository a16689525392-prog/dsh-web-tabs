# dsh-web-tabs 验收报告

版本 **v0.2.1** ｜ 打包产物（两个包，内容完全相同，各 13 个文件，解压 642 KB）：

- `dist/dsh-web-tabs-0.2.1.zip` — 472,472 B，解压成 `dsh-web-tabs\`
- `dist/dsh-web-tabs-0.2.1.tgz` — 467,813 B，解压成 `package\`

这份报告是给你在**另一台电脑**上验收用的：左边是「我这台机器上验证过什么」，右边是
「你到那边照着做应该看到什么」。凡是我没验证过的，都明确写了「未实测」。

---

## 一、验收清单（照着打勾就行）

| # | 检查项 | 怎么验 | 应该看到 | 我的结论 |
| --- | --- | --- | --- | --- |
| 1 | 包能装 | `install.ps1` | 三行 `[OK]`，最后提示重启 | ✅ 通过 |
| 2 | 装上能启动 | 完全退出 DSH NEXT 再打开 | 会话页签栏多出「网页」 | ✅ 通过 |
| 3 | 能开真浏览器窗口 | 点「＋」→ ChatGPT | 面板里出现真的网页，不是灰块 | ✅ 通过 |
| 4 | 登录态跟着走 | 打开 ChatGPT | 显示你浏览器里已登录的账号 | ✅ 通过 |
| 5 | 多页签 | 再开 Claude / Gemini / 自定义网址 | 页签条多个页签，切换不重载 | ✅ 通过 |
| 6 | 换浏览器 | 点页签条右端齿轮 | 列出 4 个浏览器 + 可填任意 exe 路径 | ✅ 通过 |
| 7 | 卸载干净 | `uninstall.ps1` | 目录和 `cordis.patch.yml` 那行都没了 | ✅ 通过 |
| 8 | 安装/卸载往返 | 装→卸→比对 `cordis.patch.yml` | 字节完全一致 | ✅ 通过 |

---

## 二、这台机器上跑过的实测（原始输出摘录）

### 2.1 静态检查

```
node --check lib/browsers.js   OK
node --check lib/client.js     OK
node --check lib/embed.js      OK
node --check lib/index.js      OK
node --check lib/settings.js   OK
```

### 2.2 客户端冒烟测试 —— 17 / 17 通过

```
✓ 模块外壳：id / apply / inject
✓ 槽位注册：conversation.view（网页）+ 单例 shell.overlay 宿主
✓ 无可用引擎：降级提示（不建 webview、不建原生窗口）
✓ guest 生命周期：acquire → 挂载（属性/UA/display:flex）→ loadURL
✓ 尺寸同步：宿主贴住 placeholder 矩形
✓ window.open → 新页签（共享 workspace、激活切换、可见性正确）
✓ 关页签：release lease → 容器移除 → 相邻页签激活
✓ 地址栏：自动补协议 + 回车导航 + Esc 还原
✓ 页签切换：菜单建站 + 点击切换 + 可见性
✓ 持久化：写入默认页签 + 重启恢复上次页签
✓ 版本不匹配：降级而不是崩
✓ edge 引擎：探测 → 开原生窗口 → 上报矩形（不建 webview）
✓ edge 引擎：URL / 标题 / 加载态从 host 轮询回填
✓ edge 引擎：菜单打开时把原生窗口收起来（否则会被盖住）
✓ edge 引擎：关页签 → /embed/close
✓ 浏览器选择器：齿轮 → 浮层 → 选 profile → 重新嵌入
✓ 无可用引擎：降级页兜底（不画页签条）
全部通过
```

这套测试不是「假装跑」：它用 `node:vm` 把 `lib/client.js` 当真实模块加载，自带一个能真执行
`useState/useRef/useEffect/useLayoutEffect` 的极简 React 和一个 DOM shim，所以组件挂载、
effect 顺序、rect 上报、localStorage 都走的是真代码路径。

### 2.3 宿主路由测试 —— 11 / 11 断言通过

```
✓ 模块导出 apply / inject / name
✓ inject 声明 webServer
✓ register 用 kind=prefix 且路径正确
✓ ctx.effect 里注册了路由
✓ GET /status 返回 200 + ok
✓ GET /status 报告浏览器可用
✓ POST /open 拒绝非 http(s)
✓ POST /open 拒绝带凭据的 URL
✓ POST /open 缺 url 时 400
✓ 未知路由 404
✓ 超大 body 被拒
全部通过
```

（这套测试用假 `ctx` 接住 `webServer.register`，把 handler 挂到真 `http.Server` 上跑，
所以路由分发、body 解析、错误码都是真跑的。）

### 2.4 真机嵌入测试（真 DSH 窗口 + 真 Edge + 真 SetParent）

```
capability: {"ok":true,"browserId":"edge","browserName":"Microsoft Edge（用户配置 1）",
             "browserTested":true,"browserSource":"last-used","mode":"shared",
             "profileDirectory":"Default","titlebar":30}
openTab: {"ok":true,"hwnd":787248,"mode":"shared"}
✓ 标题已回填: "ChatGPT"
✓ 导航后换了新窗口: 787248 → 1050450
已清理
```

这个用例在这台机器上跑过 **3 次**（每次都是真起窗口、真嵌入、真清理），三次都通过。

验证到的四件事：

1. `capability()` 报 `mode:"shared"`、`profileDirectory:"Default"`（= 挂你系统浏览器的真实 profile）；
2. 真起了一个 Edge app 窗口并把 hwnd `SetParent` 进 DSH 主窗口；
3. 标题从 `GetWindowText` 正确回填成 `ChatGPT`（中文标题也不会乱码）；
4. 跑完自动 detach + close，**DSH 子窗口零残留**（`EnumChildWindows` 只剩 D3D 合成器）。

### 2.5 安装 / 卸载往返

```
初始 cordis.patch.yml:          83 字节（LF）
install.ps1 之后:               已插入 insert 块
uninstall.ps1 之后:             83 字节，equal=True（字节完全一致）
```

补充验证过的五种场景：

- **幂等**：连跑两次 install，第二次输出 `already registered, leaving cordis.patch.yml untouched`，
  `id: dsh-web-tabs` 计数仍是 1。
- **没有 patch 文件**：新建空 profile → 正确 `created cordis.patch.yml`。
- **CRLF 文件**：预置 CRLF 格式 → 安装后仍是纯 CRLF，没混入 LF。
- **从 tgz 装**：解压 `dsh-web-tabs-0.2.1.tgz` 后跑 `install.ps1` → 装完 `import('./lib/index.js')`
  能正常导出 `['apply','inject','name']`（说明 `native/win.ps1` 也进包了，不会出现 `no-helper`）。
- **从 zip 装**：解压 `dsh-web-tabs-0.2.1.zip` → `install.ps1` 装 → `uninstall.ps1` 卸 →
  `cordis.patch.yml` 与原始字节完全一致（`cmp` 无差异），装出来的目录能正常 `import`。

### 2.6 打包内容核对

`.zip` 与 `.tgz` 各 13 个文件，内容一一对应（解压后对工作区源码逐个 sha256 比对，无差异）：

```
ACCEPTANCE.zh.md
README.md
cordis.patch.yml
install.ps1
lib/browsers.js
lib/client.js
lib/embed.js
lib/index.js
lib/settings.js
native/win.ps1        ← 关键：曾经漏过，漏了 capability() 会返回 no-helper
package.json
screenshot.png
uninstall.ps1
```

（`.tgz` 里前缀是 `package/`，`.zip` 里前缀是 `dsh-web-tabs/` —— 就这一个区别。
`dev/probes/`、`test/`、`dist/` 不进包。）

### 2.7 隐私自查

```
grep -rn "用户名\|真实账号名\|C:\Users\<某用户>" README.md ACCEPTANCE.zh.md install.ps1 \
        uninstall.ps1 package.json lib/*.js native/win.ps1 cordis.patch.yml
→ 0 命中（除了本节这段说明文字本身）
```

- `native/` 下原来 20 个调研期探针（有几个硬编码了开发机用户名路径）已全部移到 `dev/probes/`，
  `package.json` 的 `files` 白名单不含 `dev/`，所以**不会进包**。
- `screenshot.png` 里的账号区域和对话标题已打码（放大确认是灰色模糊块，无可读文字）。

### 2.8 实机复验 —— 完整退出 DSH NEXT 重新打开之后

上面 2.4 是「测试脚本自己起 host」跑通的；这一节是**装进真实 profile、真正重启桌面端**之后的复验，
也就是你要在另一台机器上看到的效果。

```
装到 profile 的版本:  node_modules/dsh-web-tabs/package.json → "version": "0.2.1"
                        client.js 96884 B（含 dshwt-gear / BrowserSheet）
                        embed.js   含 probeTitlebar
新进程（重启后）:      DSH NEXT pid 14536 / host.js pid 17380      ← 都晚于文件安装时间
helper 进程:          powershell ... win.ps1  ppid = 17380（= host）  ← host 半侧确实加载了
```

打开「网页」页签后的实际观测：

1. **内容区是真的网页，不是灰块**：`EnumChildWindows(656208)` 里出现
   `hwnd=1704200 pid=28240 Chrome_WidgetWin_1 vis=True rect=600,262 993x678 title='ChatGPT'`
   —— 真实 Edge app 窗口已被 `SetParent` 成 DSH 的子窗口，尺寸/位置贴着面板。
2. **登录态直接可用**：ChatGPT 里显示的是系统 Edge 里那个已登录账号，左侧项目列表、模型选择器都在。
3. **多页签成立且切换不重载**：再加一个 Claude 页签后，子窗口变成 **2 个**：
   ```
   hwnd=3080274 pid=28240 vis=False rect=600,262 993x678 title='新建会话 - Claude'
   hwnd=1704200 pid=28240 vis=True  rect=600,262 993x678 title='ChatGPT'
   ```
   两个页签的窗口**同一个 pid、同一套 geometry**，靠 `vis` 切换 —— 说明切走的页签只是被
   `SW_HIDE`，没有重载；切回来内容和滚动位置都还在。
4. **没有游离窗口**：顶层 `msedge --app=` 进程数 = **0**，所有 app 窗口都被嵌进 DSH，任务栏不残留。
5. **齿轮换浏览器面板可用**：点页签条右端的齿轮弹出「内嵌浏览器」，列出
   `Microsoft Edge（当前/用户配置 1 (Default)）`、`Google Chrome（未安装）`、`Brave（未安装）`、
   `Vivaldi（未安装）`，下面是「填一个 Chromium 浏览器的 .exe 完整路径」+「使用」+「刷新」。
6. **关页签清得干净**：中键点掉 Claude 页签后，子窗口从 2 个变回 1 个（只剩 ChatGPT 那个），
   顶层 `msedge --app=` 仍是 **0** —— 说明 `hide → detach → close` 三连把窗口真正收掉了，
   不会在任务栏留残影。

> 这台机器只装了 Edge，所以 Chrome / Brave / Vivaldi 显示「未安装 / 没在这个位置找到可执行文件」，
> 这正是 `discoverBrowsers()` 的预期行为（全列出来但不让选）。

> 上面这张 `screenshot.png` 已经换成这一版（v0.2.1）重启后的真实截图，ChatGPT 左侧的项目/会话
> 列表和主区里的会话预览都做了马赛克。

---

## 三、你在这台机器上应该怎么验（三步）

`dist/` 里有两个包，内容完全一样（各 13 个文件、逐个 sha256 比对过源码）：

| 文件 | 大小 | 解压出来 |
| --- | --- | --- |
| `dsh-web-tabs-0.2.1.zip` | 472,472 B | `dsh-web-tabs\`（Windows 上右键「全部解压」即可） |
| `dsh-web-tabs-0.2.1.tgz` | 467,813 B | `package\` |

```powershell
# 1. 把 zip 拷到目标机器，右键「全部解压」（或用 tar -xzf dsh-web-tabs-0.2.1.tgz）

# 2. 进解压出来的目录（zip 是 dsh-web-tabs\，tgz 是 package\），跑安装
cd dsh-web-tabs
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 3. 完全退出 DSH NEXT（不是 Ctrl+R），再重新打开
```

打开后：会话页签栏出现「网页」→ 点「＋」→ 选 ChatGPT。

**前置条件**（不满足会看到降级提示，而不是崩溃）：

1. Windows（`SetParent` 是 Win32 API，别的系统自动退回 webview 引擎）；
2. 装了 Edge / Chrome / Brave / Vivaldi 其中之一（至少 Edge，Windows 自带）；
3. 你平时在那个浏览器里登录过目标网站 —— 插件用的是**你自己的 profile**，不是它自己
   新建的账号体系。

---

## 四、还没验证的部分（请重点帮我验这几项）

| 项目 | 状态 | 期望 |
| --- | --- | --- |
| Chrome | **未实测** | 代码路径和 Edge 完全一样，只差 exe 路径和进程名 |
| Brave | **未实测** | 同上 |
| Vivaldi | **未实测** | 同上，且它的安装目录结构和别家不同，我手写了三条候选路径 |
| 非 100% 缩放的屏幕 | **未实测** | 标题条按 DPI 换算（100%→30px、125%→38px、150%→45px），理论上不切页面 |
| 多显示器 / 负坐标 | **未实测** | 只在本机单屏 1920×1080 验证过 |
| macOS / Linux | **不支持 edge 引擎** | 自动退回 webview；webview 只在 DSH NEXT 桌面端可用 |

**真机遇到问题时请把这三样一起发给我**：

1. `~/.dsh/web-tabs/settings.json`（很小，就是 `{browserId, profile, titlebar, browserPath}`）；
2. 面板上的报错文案（v0.2.0 起空白区域会显示诊断浮层，不再是一片壁纸）；
3. `%TEMP%` 下如果有 `dsh-web-tabs` 相关日志也一起。

---

## 五、这一版改了什么（相对你上次看到的版本）

| # | 改动 | 为什么 |
| --- | --- | --- |
| 1 | 默认走 **shared 模式**（不传 `--user-data-dir`，只传 `--profile-directory`） | 之前的隔离 profile 是空的，所以嵌入式 ChatGPT 永远是未登录；现在直接挂你系统浏览器的 profile，登录态开箱即用 |
| 2 | 新增 **齿轮 →「内嵌浏览器」浮层** | 不用改代码就能换浏览器、换 profile；还能手填任意 Chromium 内核 exe 的路径 |
| 3 | 新增 **`lib/browsers.js` / `lib/settings.js`** | 浏览器配置从硬编码搬进配置表；用户选择持久化到 `~/.dsh/web-tabs/settings.json` |
| 4 | 标题条高度**按 DPI 缩放** | 旧代码写死 30px，125%/150% 缩放的机器上会把页面顶部切掉 |
| 5 | 新增 **`probeTitlebar()`** | 能实测出真实标题条高度时优先用实测值（Chrome / Brave 有时候能测出来） |
| 6 | 错误提示**全部人话化** | 以前失败了只在空白区域显示壁纸，现在会说明「没找到浏览器」「宿主半侧没加载」等具体原因，并给「重新检测」「立即重启」按钮 |
| 7 | **修了** data: 起手页把 base64 当标题显示的 bug | 窗口还没跳转完时，标题会变成 `text/html;base64,PCFkb2N0eXBl...` 一大串，现在当成「加载中」处理 |
| 8 | `install.ps1` / `uninstall.ps1` 修了 **BOM + 换行符** 两个 bug | 原来会把 LF 的 YAML 改成 CRLF 并加 BOM，卸载后文件字节对不上；现在往返完全一致 |
| 9 | 隐私清理 | 探针文件移出包、README 里的真实路径和账号抹掉、截图打码 |
| 10 | `package.json` 的 `files` 补上 `native/win.ps1` | 曾经漏过，漏了打包版会直接不可用（`capability()` 报 `no-helper`） |

---

## 六、出问题时的回滚

```powershell
# 卸载插件（保留 ~/.dsh/web-tabs 下的 settings 和缓存）
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepData

# 完全卸载（连 settings 一起删）
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

`install.ps1` 每次改 `cordis.patch.yml` 前都会留一份 `.bak-<时间戳>` 备份，改坏了可以手动还原。
卸载后同样需要**完全重启** DSH NEXT。

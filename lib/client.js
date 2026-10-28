/**
 * dsh-web-tabs —— client half.
 *
 * 多页签内置浏览器：挂到 conversation.view 槽位做一个「网页」页签，
 * 页签本体只负责画 UI + 量尺寸；真正的 <webview> 常驻在 shell.overlay 里，
 * 因为 webview 一旦从 DOM 摘除再插回就会重新加载（登录态和页面状态全丢）。
 *
 * 每个页签一个 lease（主进程一个 workspace 对应一个 partition），
 * 所以同一 partition 下所有页签共享 Cookie —— ChatGPT 登录一次，开几个页签都是已登录。
 *
 * 两套引擎（`store.engine`）：
 *   edge    —— host 半侧 spawn 真实 Edge 的 app 模式窗口，再用 SetParent 嵌进主窗口。
 *              它是原生子窗口，与系统 Edge 共享登录态，Google 系站点也能正常登录。
 *   webview —— Electron <webview>，纯渲染进程内，不需要宿主配合，但没有共享登录态。
 * edge 可用时优先用它；不可用才退回 webview。
 */
window.__ModuleLoader__.load({
  id: "dsh-web-tabs",
  factory: (require) => {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    const WORKSPACE_KEY = "dsh-web-tabs";
    const STORAGE_KEY = "dsh-web-tabs:v1";
    const HOST_ID = "dsh-web-tabs-host";
    const STACK_ID = "dsh-web-tabs-stack";
    const STYLE_ID = "dsh-web-tabs-style";
    /** host 半侧（lib/index.js）注册的 webServer 前缀，客户端用相对路径 fetch。 */
    const API = "/dsh-web-tabs/api";

    /** 常用站点预设。`color`/`letter` 只用来画页签左侧的小色块。 */
    const PRESETS = [
      { preset: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", color: "#10a37f", letter: "G" },
      { preset: "claude", label: "Claude", url: "https://claude.ai/new", color: "#d97757", letter: "C" },
      { preset: "gemini", label: "Gemini", url: "https://gemini.google.com/app", color: "#4285f4", letter: "◆" },
      { preset: "grok", label: "Grok", url: "https://grok.com/", color: "#1d9bf0", letter: "✕" },
      { preset: "muse", label: "muse.ai", url: "https://muse.ai/", color: "#8b5cf6", letter: "m" },
      { preset: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", color: "#4d6bfe", letter: "D" },
    ];

    //#region 桌面桥
    /**
     * 主窗口 preload 注入的通道。只有 DSH NEXT 桌面端、且当前 frame 是主窗口时才存在。
     * 浏览器版（http://127.0.0.1:xxxx）里没有 ⇒ 插件降级成提示。
     */
    function bridge() {
      const carrier = globalThis.dshDesktop;
      if (!carrier || carrier.protocolVersion !== 1) return void 0;
      const found = carrier.browser;
      return found && typeof found.acquire === "function" ? found : void 0;
    }
    //#endregion

    //#region UA
    /** webview 的 UA 默认带 Electron/xx —— 不少站点会据此降级或直接拦。 */
    function buildGuestUserAgent(ua) {
      const source = String(ua || "");
      if (!/Electron\//i.test(source)) return source;
      const major = (/Chrome\/(\d+)/.exec(source) || [])[1] || "128";
      return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
        major +
        ".0.0.0 Safari/537.36"
      );
    }

    /**
     * dom-ready 后跑一次：抹掉 navigator.webdriver 与 UA-CH 里的 Electron 痕迹。
     * 注意整段字符串里不能出现反引号（会被 executeJavaScript 当成模板字面量入口）。
     */
    function guestFingerprintFix(userAgent) {
      return (
        "(function(){try{var ua=" + JSON.stringify(String(userAgent || "")) + ";" +
        "var m=/Chrome\\/(\\d+)/.exec(ua);var major=m?m[1]:'128';" +
        "var brands=[{brand:'Chromium',version:major},{brand:'Google Chrome',version:major},{brand:'Not_A Brand',version:'24'}];" +
        "try{Object.defineProperty(Navigator.prototype,'userAgentData',{configurable:true,get:function(){return {" +
        "brands:brands,mobile:false,platform:'Windows'," +
        "getHighEntropyValues:function(){return Promise.resolve({brands:brands,mobile:false,platform:'Windows'," +
        "platformVersion:'15.0.0',architecture:'x86',bitness:'64',model:'',uaFullVersion:major+'.0.0.0',wow64:false});}," +
        "toJSON:function(){return {brands:brands,mobile:false,platform:'Windows'};}};}});}catch(e){}" +
        "try{Object.defineProperty(Navigator.prototype,'webdriver',{configurable:true,get:function(){return false;}});}catch(e){}" +
        "}catch(e){}})();"
      );
    }
    //#endregion

    //#region 小工具
    function uid(prefix) {
      try {
        if (globalThis.crypto && typeof crypto.randomUUID === "function") return prefix + "-" + crypto.randomUUID().slice(0, 8);
      } catch {
        /* ignore */
      }
      return prefix + "-" + Math.random().toString(36).slice(2, 10);
    }

    function normalizeUrl(raw) {
      const text = String(raw == null ? "" : raw).trim();
      if (text === "") return "";
      if (/^https?:\/\//i.test(text)) return text;
      if (/^about:blank$/i.test(text)) return "about:blank";
      if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(text)) return "https://" + text;
      return "";
    }

    function hostOf(raw) {
      try {
        return new URL(raw).host;
      } catch {
        return "";
      }
    }

    function waitEvent(element, event, timeoutMs) {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => finish(false), timeoutMs);
        function finish(value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            element.removeEventListener(event, onEvent);
          } catch {
            /* ignore */
          }
          resolve(value);
        }
        function onEvent() {
          finish(true);
        }
        element.addEventListener(event, onEvent);
      });
    }

    function errorText(error) {
      if (error == null) return "未知错误";
      if (typeof error === "string") return error;
      const message = String(error.message || error);
      return message === "[object Object]" ? String(error) : message;
    }
    //#endregion

    //#region 状态仓库
    /**
     * 模块级单例：conversation.view 的页签 UI 与 shell.overlay 的常驻宿主是两个
     * 互不相邻的 React 树，只能通过这里共享状态。
     */
    const store = {
      tabs: [], // { id, url, title, presetLabel, color, letter, loading, status, error }
      activeId: null,
      rect: null,
      hostNode: null,
      bridgeMissing: false,
      menu: null, // { left, top, right }：新建页签菜单的视口坐标（null = 关闭）
      notice: null, // { id, text, tone }：地址栏下方的一行提示
      // null = 还在检测；"edge" = 内嵌真实浏览器窗口；"webview" = Electron webview；"none" = 都不可用
      engine: null,
      embedError: "",
      // 宿主半侧（lib/index.js）没被加载：装完插件 / 更新 host 代码后必须完整重启一次 DSH NEXT。
      engineUnloaded: false,
      // 宿主报回来的引擎信息：{ browserName, browserTested, mode, profileName, titlebar }。
      // 界面文案全靠它说「你现在用的是哪个浏览器」，不再硬写 Edge。
      capability: null,
      // 「内置浏览器」设置浮层：null = 关闭；打开时是一个对象（loading/error/busy）。
      sheet: null,
      // GET /embed/browsers 的原始回包：{ current, source, chosen, browsers:[...] }。
      browserChoices: null,
      // 正在提交切换请求（防连点）。
      settingsBusy: false,
    };

    const listeners = new Set();

    function notify() {
      for (const fn of Array.from(listeners)) {
        try {
          fn();
        } catch (error) {
          console.warn("[dsh-web-tabs] listener failed", error);
        }
      }
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }

    function tabView(tab) {
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title || PRESET_LABEL(tab) || hostOf(tab.url) || "新标签页",
        color: tab.color || "#5b6270",
        letter: tab.letter || "·",
        loading: Boolean(tab.loading),
        status: tab.status || "idle",
        error: tab.error || "",
        // 原生浏览器窗口是不是已经嵌进来了 —— 面板空白时要靠它区分「还没开」和「开失败」。
        embedded: Boolean(tab.embedded),
      };
    }

    /** 当前引擎对应的浏览器显示名（edge 引擎才有），比如「Microsoft Edge（用户配置 1）」。 */
    function engineLabel() {
      const cap = store.capability;
      if (!cap || !cap.ok) return "内置浏览器";
      const name = cap.browserName || cap.browserId || "内置浏览器";
      return name;
    }

    function PRESET_LABEL(tab) {
      if (tab.preset) {
        const found = PRESETS.find((item) => item.preset === tab.preset);
        if (found) return found.label;
      }
      return "";
    }

    function snapshot() {
      return {
        tabs: store.tabs.map(tabView),
        activeId: store.activeId,
        bridgeMissing: store.bridgeMissing,
        menu: store.menu,
        notice: store.notice,
        rect: store.rect,
        engine: store.engine,
        embedError: store.embedError,
        engineUnloaded: store.engineUnloaded,
        capability: store.capability,
        engineLabel: engineLabel(),
        sheet: store.sheet,
        browserChoices: store.browserChoices,
        settingsBusy: store.settingsBusy,
      };
    }

    /** 打开「新建页签」菜单：把锚点按钮的视口矩形换算成浮层左上角。 */
    function openMenu(anchor) {
      const width = 240;
      let left = 8;
      let top = 48;
      if (anchor && typeof anchor.getBoundingClientRect === "function") {
        const rect = anchor.getBoundingClientRect();
        if (rect && rect.width >= 0) {
          left = Math.max(8, Math.min(rect.left, globalThis.innerWidth - width - 8));
          top = rect.bottom + 4;
        }
      }
      store.menu = { left, top, width };
      notify();
      pushLayout();
    }

    function closeMenu() {
      if (!store.menu) return;
      store.menu = null;
      notify();
      pushLayout();
    }

    function findTab(id) {
      return store.tabs.find((tab) => tab.id === id) || null;
    }

    function activeTab() {
      return findTab(store.activeId);
    }

    //#region 系统浏览器
    /**
     * Google 从 2021 年起禁止在内嵌浏览器里登录账号（OAuth `disallowed_useragent`，
     * 页面原文「此浏览器或应用可能不安全」）。Electron 的 <webview> 改 UA、伪造
     * navigator.userAgentData 都绕不过去，所以这些站点一律提示走系统浏览器。
     */
    const GOOGLE_FAMILY = ["google.com", "googleusercontent.com", "youtube.com", "gstatic.com"];

    function googleFamily(url) {
      const host = hostOf(url).toLowerCase();
      if (!host) return false;
      return GOOGLE_FAMILY.some((base) => host === base || host.endsWith("." + base));
    }

    let systemBrowserBusy = false;
    let googleHintShown = false;

    /** 提示条：一句话 + 自动消失，不打断操作。 */
    function notice(text, tone) {
      if (!text) {
        store.notice = null;
        notify();
        return;
      }
      const id = uid("notice");
      store.notice = { id, text, tone: tone || "info" };
      notify();
      setTimeout(() => {
        if (store.notice && store.notice.id === id) {
          store.notice = null;
          notify();
        }
      }, 9000);
    }

    /**
     * 让 host 半侧用真实 Edge / Chrome 的 app 模式窗口打开（固定 user-data-dir，登录态长期保留）。
     *
     * 两级退路：
     *   1. `POST /dsh-web-tabs/api/open` → host 半侧 spawn 真实浏览器（app 模式，无地址栏）。
     *   2. host 半侧还没加载（404/403）时，退回 `window.open` —— 主窗口的
     *      `setWindowOpenHandler` 一律 `deny` 并转成 `shell.openExternal`，同样能拉起系统浏览器，
     *      只是没有 app 模式和固定 profile。
     */
    async function openInSystemBrowser(url) {
      const target = normalizeUrl(url);
      if (!target || target === "about:blank") {
        notice("这个地址没法用系统浏览器打开。", "warn");
        return;
      }
      if (systemBrowserBusy) return;
      systemBrowserBusy = true;
      try {
        const outcome = await requestHostOpen(target);
        if (outcome.ok) {
          notice("已用系统浏览器打开（app 模式窗口，登录态长期保留）。", "info");
          return;
        }
        if (outcome.reason === "no-browser") {
          notice("没找到 Edge 或 Chrome，已交给系统默认浏览器。", "info");
          handOffToSystemBrowser(target);
          return;
        }
        // host 半侧没就绪（它随主应用启动，客户端 Ctrl+R 不会重载它）→ 走 window.open。
        if (handOffToSystemBrowser(target)) {
          notice("已用系统浏览器打开。重启一次 DSH NEXT 后可用 app 模式窗口（无地址栏、登录态长期保留）。", "info");
          return;
        }
        notice("打开失败：" + (outcome.detail || "系统浏览器不可用"), "warn");
      } catch (error) {
        if (handOffToSystemBrowser(target)) {
          notice("已用系统浏览器打开。重启一次 DSH NEXT 后可用 app 模式窗口（无地址栏、登录态长期保留）。", "info");
          return;
        }
        notice("打开失败：" + errorText(error), "warn");
      } finally {
        systemBrowserBusy = false;
      }
    }

    /** 调 host 半侧接口。返回 { ok, reason, detail }；reason=unloaded 表示路由不存在。 */
    async function requestHostOpen(target) {
      let response;
      try {
        response = await fetch(API + "/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: target }),
        });
      } catch (error) {
        return { ok: false, reason: "unreachable", detail: errorText(error) };
      }
      const payload = await response.json().catch(() => ({}));
      if (payload && payload.ok) return { ok: true, detail: payload.browser || "" };
      const reason = (payload && payload.reason) || "";
      if (response.status === 404 || response.status === 403 || reason === "not-found") {
        return { ok: false, reason: "unloaded", detail: reason };
      }
      return { ok: false, reason, detail: (payload && payload.detail) || "" };
    }

    /**
     * 退路：主窗口 `setWindowOpenHandler` 会把任何 http(s) 弹窗交给 `shell.openExternal`
     * 然后 `deny` 掉窗口本身 —— 所以 `window.open` 返回 null 是正常的，不代表失败。
     */
    function handOffToSystemBrowser(target) {
      try {
        window.open(target, "_blank", "noopener,noreferrer");
        return true;
      } catch {
        return false;
      }
    }
    //#endregion

    //#region 内置 Edge 窗口（host 半侧 spawn + SetParent 嵌入）
    /**
     * host 半侧（lib/index.js + lib/embed.js）会 spawn 一个真实 Edge 的 app 模式窗口，
     * 再用 Windows 的 SetParent 把它变成主窗口的子窗口，按这里上报的矩形摆放。
     *
     * 三条必须记住的事实：
     *   1. rect 的单位是 CSS px，原点就是渲染进程视口左上角，等于 body.getBoundingClientRect()
     *      的坐标系，**不要**再加 window.screenX / 窗口边框。
     *   2. 原生子窗口永远盖在 DOM 之上，所以页签菜单一打开就得让 host 把窗口藏起来
     *      （layout 里 visible:false），否则菜单被它挡住。
     *   3. Edge app 窗口自带 30px 自绘标题条，host 侧会把它裁掉（y 上移、h 加高 + SetWindowRgn）。
     */

    let enginePromise = null;
    let embedTimer = 0;
    let layoutTimer = 0;
    let layoutLast = "";
    let embedHintShown = false;

    async function getApi(route) {
      const response = await fetch(API + route, { headers: { accept: "application/json" } });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== "object") {
        // 宿主半侧没注册路由时 webServer 会回落到 SPA 的 200 + HTML（不是 404），
        // 所以「解析不出 JSON」本身就等价于「路由不存在」。
        return { ok: false, reason: "unloaded", status: response.status };
      }
      payload.status = response.status;
      return payload;
    }

    async function postApi(route, body) {
      const response = await fetch(API + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== "object") return { ok: false, reason: "unloaded", status: response.status };
      return payload;
    }

    /** 选引擎：edge 优先（有真实登录态），不可用再看桌面桥（webview），都没有就降级提示。 */
    async function detectEngine() {
      let capability = null;
      try {
        capability = await getApi("/embed/capability");
      } catch {
        capability = null;
      }
      if (capability && capability.ok === true) {
        store.engine = "edge";
        store.capability = capability;
        store.embedError = "";
        store.engineUnloaded = false;
        startEmbedSync();
      } else {
        store.capability = capability;
        store.embedError = (capability && (capability.detail || capability.reason)) || "内置浏览器窗口不可用";
        store.engine = bridge() ? "webview" : "none";
        // 宿主半侧（lib/index.js）是随 DSH NEXT 主进程启动的：刚装完 / 刚更新过插件时
        // 路由还不存在（404 / not-found），此时只剩「重启一次」这一条路，UI 上要给出按钮。
        const reason = (capability && capability.reason) || "";
        const status = capability && capability.status;
        store.engineUnloaded = Boolean(
          capability && (status === 404 || status === 403 || reason === "not-found" || reason === "unloaded"),
        );
        if (store.engineUnloaded) {
          notice("内置浏览器窗口还没加载（插件是刚装的），重启一次 DSH NEXT 就能启用；现在先用内置 webview 顶着。", "warn");
        } else if (reason === "no-helper") {
          notice("缺少 native/win.ps1，内置浏览器窗口不可用；现在用内置 webview 顶着。", "warn");
        } else if (reason === "no-browser") {
          notice(
            "没找到可用的浏览器（支持 Edge / Chrome / Brave / Vivaldi）。装上其中一个，或在「＋」右边的齿轮里手动指定路径；现在用内置 webview 顶着（Google 系站点登不上）。",
            "warn",
          );
        } else if (reason === "platform") {
          notice("内置浏览器窗口只支持 Windows；这台机器上用内置 webview 顶着（Google 系站点登不上）。", "warn");
        } else if (reason && reason !== "no-browser") {
          notice("内置浏览器窗口不可用：" + (capability.detail || reason) + "；现在用内置 webview 顶着。", "warn");
        }
      }
      notify();
      pushLayout();
      if (store.rect) void ensureTab(activeTab());
      return store.engine;
    }

    function startEngine() {
      if (!enginePromise) enginePromise = detectEngine();
      return enginePromise;
    }

    /** 「重新检测」：不重启也能验证宿主半侧是否已加载（比如从别处重启过 DSH）。 */
    function retryEngine() {
      enginePromise = null;
      store.engine = null;
      notify();
      void startEngine().then((engine) => {
        if (engine === "edge") notice("内置浏览器窗口已就绪：" + engineLabel() + "，和系统浏览器共用登录态。", "info");
        else notice("还是没检测到内置浏览器窗口，需要完整重启一次 DSH NEXT。", "warn");
      });
    }

    /**
     * 一键重启 DSH NEXT。`desktopNext.command({type:"restart"})` 会重启宿主进程并重载渲染进程，
     * 正是让后来安装的宿主插件（lib/index.js 的 webServer 路由）生效的唯一可靠手段。
     */
    function restartDesktop() {
      const api = globalThis.desktopNext;
      if (!api || typeof api.command !== "function") {
        notice("这个宿主没有重启接口，请手动退出并重新打开 DSH NEXT。", "warn");
        return;
      }
      notice("正在重启 DSH NEXT，几秒后自动回来…", "info");
      Promise.resolve(api.command({ type: "restart" })).catch((error) => {
        notice("重启失败：" + errorText(error) + "。可以手动退出并重开 DSH NEXT。", "warn");
      });
    }

    function startEmbedSync() {
      if (embedTimer) return;
      embedTimer = setInterval(() => void syncEmbedState(), 1200);
    }

    function stopEmbedSync() {
      if (!embedTimer) return;
      clearInterval(embedTimer);
      embedTimer = 0;
    }

    /** 把 host 侧的 url / title / loading 拉回来 —— Edge 窗口不在渲染进程里，只能这样同步。 */
    async function syncEmbedState() {
      if (store.engine !== "edge") return;
      let state = null;
      try {
        state = await getApi("/embed/state");
      } catch {
        return;
      }
      if (!state || state.ok !== true) return;
      let changed = false;
      for (const item of state.tabs || []) {
        const tab = findTab(item.id);
        if (!tab) continue;
        if (item.url && /^https?:/i.test(item.url) && item.url !== tab.url) {
          tab.url = item.url;
          changed = true;
          saveTabs();
        }
        if (item.title && item.title !== tab.title) {
          tab.title = item.title;
          changed = true;
        }
        if (Boolean(item.loading) !== Boolean(tab.loading)) {
          tab.loading = Boolean(item.loading);
          changed = true;
        }
        if (item.placed && !tab.embedded) {
          tab.embedded = true;
          changed = true;
        }
        if (tab.status !== "ready" && tab.status !== "error") {
          tab.status = "ready";
          changed = true;
        }
      }
      if (state.error && state.error !== store.embedError) {
        store.embedError = state.error;
        changed = true;
      }
      if (changed) notify();
    }

    /**
     * 把面板矩形 + 活动页签推给 host。host 侧 90ms 一次 follow/clip，
     * 这里只负责在矩形 / 活动页签 / 可见性变化时送一次，并做 60ms 去抖。
     */
    function pushLayout() {
      if (store.engine !== "edge") return;
      if (layoutTimer) return;
      layoutTimer = setTimeout(() => {
        layoutTimer = 0;
        const rect = store.rect;
        // 菜单 / 设置浮层是 DOM 浮层，会被原生子窗口盖住，所以它们开着的时候必须把窗口收起来。
        const visible = Boolean(rect) && !store.menu && !store.sheet;
        const key = [
          store.activeId || "",
          visible ? "1" : "0",
          rect ? Math.round(rect.left) : "-1",
          rect ? Math.round(rect.top) : "-1",
          rect ? Math.round(rect.width) : "-1",
          rect ? Math.round(rect.height) : "-1",
        ].join("|");
        if (key === layoutLast) return;
        layoutLast = key;
        const payload = {
          activeId: store.activeId || null,
          visible,
          dpr: Number(globalThis.devicePixelRatio) || 1,
        };
        if (rect) payload.rect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        void postApi("/embed/layout", payload).catch(() => {});
      }, 60);
    }

    async function ensureEmbed(tab) {
      if (!tab || tab.embedded) return;
      if (tab.pending) return tab.pending;
      tab.pending = (async () => {
        try {
          const result = await postApi("/embed/tab", { id: tab.id, url: tab.url });
          if (!result || result.ok !== true) {
            throw new Error((result && (result.detail || result.reason)) || "内置窗口打开失败");
          }
          // 等 host 起窗口的这段时间里页签可能已经被关了。
          if (findTab(tab.id) !== tab) {
            void postApi("/embed/close", { id: tab.id }).catch(() => {});
            return;
          }
          tab.embedded = true;
          patchTab(tab, { status: "ready", error: "", loading: false });
          pushLayout();
          if (!embedHintShown) {
            embedHintShown = true;
            notice("已启用内置浏览器窗口：" + engineLabel() + "，和系统浏览器共用登录态，Google 账号也能正常登录。");
          }
        } catch (error) {
          const message = errorText(error);
          // 「宿主半侧没加载」要从这里回填，否则降级横幅永远不会出现。
          if (/unloaded|not-found|unreachable|\b40[34]\b/i.test(message)) {
            store.engineUnloaded = true;
            store.embedError = message;
            notify();
          }
          patchTab(tab, { status: "error", error: message, loading: false });
        } finally {
          tab.pending = null;
        }
      })();
      return tab.pending;
    }

    /** 「重试」：把失败状态清掉，重新走一遍 ensureTab（宿主已就绪时就能直接开出来）。 */
    function retryActiveTab() {
      const tab = activeTab();
      if (!tab) return;
      tab.pending = null;
      tab.embedded = false;
      tab.status = "idle";
      tab.error = "";
      tab.loading = false;
      notify();
      void ensureTab(tab);
    }

    function navigateEmbed(tab, target) {
      void postApi("/embed/navigate", { id: tab.id, url: target })
        .then((result) => {
          if (result && result.ok === false) {
            patchTab(tab, { status: "error", error: result.detail || result.reason || "导航失败" });
          }
        })
        .catch((error) => patchTab(tab, { status: "error", error: errorText(error) }));
    }
    //#endregion

    //#region 内置浏览器设置（选浏览器 / 选 profile）
    /**
     * 用户为什么要能自己选：
     *   - 机器上同时装了 Edge 和 Chrome，登录态（ChatGPT / Claude / Google）只在一个里；
     *   - 一个浏览器有多个 profile（工作 / 个人），登录态在哪个 profile 里只有用户知道。
     * 所以这两件事都不能靠「自动挑」，必须给一个能看见当前状态、能改的界面。
     */
    function openSheet() {
      store.sheet = { loading: true, error: "" };
      notify();
      pushLayout(); // 菜单类浮层打开时要把原生窗口收起来，否则被盖住
      void loadBrowserChoices();
    }

    function closeSheet() {
      if (!store.sheet) return;
      store.sheet = null;
      notify();
      pushLayout();
    }

    function toggleSheet() {
      if (store.sheet) closeSheet();
      else openSheet();
    }

    async function loadBrowserChoices() {
      let payload = null;
      let error = "";
      try {
        payload = await getApi("/embed/browsers");
      } catch (problem) {
        error = errorText(problem);
      }
      if (payload && payload.ok === true) {
        store.browserChoices = {
          current: payload.current || "",
          source: payload.source || "",
          chosen: payload.chosen || "",
          browsers: Array.isArray(payload.browsers) ? payload.browsers : [],
        };
      } else if (!error) {
        error = (payload && (payload.detail || payload.reason)) || "宿主半侧没加载，读不到浏览器列表";
      }
      store.sheet = { loading: false, error };
      notify();
    }

    /**
     * 提交切换。host 侧会写 settings.json、丢掉当前 embedder 并重建，
     * 所以这里必须把所有页签的 embedded 状态清掉，让它们按新浏览器重开。
     */
    async function applyBrowserChoice(browserId, profile, titlebar, browserPath) {
      if (store.settingsBusy) return;
      store.settingsBusy = true;
      store.sheet = { ...(store.sheet || {}), loading: false, error: "", applying: true };
      notify();
      try {
        const body = {};
        if (browserId !== undefined && browserId !== null) body.browserId = browserId;
        if (profile !== undefined && profile !== null) body.profile = profile;
        if (titlebar !== undefined && titlebar !== null) body.titlebar = titlebar;
        if (browserPath !== undefined && browserPath !== null) body.browserPath = browserPath;
        const result = await postApi("/embed/settings", body);
        if (!result || result.ok !== true) {
          throw new Error((result && (result.detail || result.reason)) || "切换失败");
        }
        // 换了浏览器 = 旧的窗口全部作废，页签要重新嵌入。
        rearmTabs();
        store.engine = "edge";
        store.capability = result.capability || store.capability;
        store.settingsBusy = false;
        store.sheet = null;
        notify();
        notice("已切换到 " + engineLabel() + "，页签会按新浏览器重新打开。", "info");
        await loadBrowserChoices().catch(() => {});
        void ensureTab(activeTab());
      } catch (error) {
        store.settingsBusy = false;
        store.sheet = { loading: false, error: errorText(error) };
        notify();
      }
    }

    /** 「自动选择」：把用户偏好清空，回到「最近用过的那个浏览器」。 */
    async function resetBrowserChoice() {
      if (store.settingsBusy) return;
      store.settingsBusy = true;
      store.sheet = { ...(store.sheet || {}), loading: false, error: "", applying: true };
      notify();
      try {
        const result = await postApi("/embed/settings", { browserId: "", profile: "" });
        if (!result || result.ok !== true) {
          throw new Error((result && (result.detail || result.reason)) || "清除失败");
        }
        rearmTabs();
        store.engine = "edge";
        store.capability = result.capability || store.capability;
        store.settingsBusy = false;
        store.sheet = null;
        notify();
        notice("已恢复自动选择：现在用 " + engineLabel() + "。", "info");
        await loadBrowserChoices().catch(() => {});
        void ensureTab(activeTab());
      } catch (error) {
        store.settingsBusy = false;
        store.sheet = { loading: false, error: errorText(error) };
        notify();
      }
    }

    /** 把全部页签打回「未嵌入」，host 侧窗口已经随 embedder 一起销毁了。 */
    function rearmTabs() {
      for (const tab of store.tabs) {
        tab.embedded = false;
        tab.pending = null;
        tab.status = "idle";
        tab.error = "";
        tab.loading = false;
      }
      layoutLast = "";
    }
    //#endregion

    //#region 持久化
    function saveTabs() {
      try {
        const payload = {
          activeId: store.activeId,
          tabs: store.tabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title || "",
            preset: tab.preset || "",
            color: tab.color || "",
            letter: tab.letter || "",
          })),
        };
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        /* 隐私模式或配额问题：忽略 */
      }
    }

    function loadTabs() {
      let payload = null;
      try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        if (raw) payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      const list = payload && Array.isArray(payload.tabs) ? payload.tabs : [];
      const restored = [];
      for (const item of list) {
        if (!item || typeof item.url !== "string") continue;
        const url = normalizeUrl(item.url);
        if (!url) continue;
        const preset = item.preset ? PRESETS.find((p) => p.preset === item.preset) : null;
        restored.push({
          id: typeof item.id === "string" && item.id ? item.id : uid("tab"),
          url,
          title: typeof item.title === "string" ? item.title : "",
          preset: preset ? preset.preset : "",
          color: preset ? preset.color : typeof item.color === "string" ? item.color : "",
          letter: preset ? preset.letter : typeof item.letter === "string" ? item.letter : "",
          loading: false,
          status: "idle",
          error: "",
          container: null,
          el: null,
          lease: null,
          pending: null,
          created: false,
          embedded: false,
        });
      }
      if (restored.length === 0) {
        const first = PRESETS[0];
        restored.push({
          id: uid("tab"),
          url: first.url,
          title: first.label,
          preset: first.preset,
          color: first.color,
          letter: first.letter,
          loading: false,
          status: "idle",
          error: "",
          container: null,
          el: null,
          lease: null,
          pending: null,
          created: false,
          embedded: false,
        });
      }
      store.tabs = restored;
      const wanted = payload && typeof payload.activeId === "string" ? payload.activeId : "";
      store.activeId = findTab(wanted) ? wanted : restored[0].id;
    }
    //#endregion

    //#region 尺寸同步
    /**
     * 宿主的视口尺寸在 <webview> 挂载那一刻定格，之后改 CSS 不会自动重排，
     * 所以每次拿到新矩形都往 guest 里补一个 resize 事件。
     */
    function syncGuestViewport() {
      for (const tab of store.tabs) {
        if (!tab.el) continue;
        try {
          tab.el.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
        } catch {
          /* guest 已经销毁 */
        }
      }
    }

    function publishRect(rect) {
      const next =
        rect && rect.width > 0 && rect.height > 0
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null;
      const previous = store.rect;
      store.rect = next;
      if (
        next &&
        previous &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.width - next.width) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
      ) {
        return; // 没变就别惊动 React
      }
      syncGuestViewport();
      notify();
      pushLayout();

      // 面板第一次被真正画出来（或从隐藏变可见）时，补建当前页签的引擎。
      // 首帧之前 webview 会以 0 尺寸初始化，所以必须在有矩形之后才建。
      if (next && !previous) void ensureTab(activeTab());
    }

    function registerHostNode(node) {
      store.hostNode = node || null;
      if (!node) return;
      syncContainers();
      if (store.rect) void ensureTab(activeTab());
    }

    /** 等页面被真正画出来（首帧尺寸 > 0）再建 guest，否则 webview 会以 0 尺寸初始化。 */
    function waitForUsableBox() {
      const deadline = Date.now() + 3000;
      return new Promise((resolve) => {
        function poll() {
          const rect = store.rect;
          if (rect && rect.width >= 200 && rect.height >= 120) return resolve(true);
          if (Date.now() > deadline) return resolve(Boolean(store.rect));
          setTimeout(poll, 100);
        }
        poll();
      });
    }
    //#endregion

    //#region guest 生命周期
    function ensureContainer(tab) {
      const host = store.hostNode;
      if (!host) return null;
      if (tab.container && tab.container.isConnected && tab.container.parentNode === host) return tab.container;

      const box = document.createElement("div");
      box.dataset.dshwtTab = tab.id;
      box.style.position = "absolute";
      box.style.left = "0";
      box.style.top = "0";
      box.style.width = "100%";
      box.style.height = "100%";
      box.style.display = "flex";
      box.style.minHeight = "0";
      box.style.visibility = "hidden";
      box.style.zIndex = "0";
      host.appendChild(box);
      tab.container = box;
      return box;
    }

    /** 把 store.tabs 与宿主里的容器 DOM 对齐：缺的补上，多余的删掉。 */
    function syncContainers() {
      // edge 模式下页签是原生窗口，没有 webview 容器要维护。
      if (store.engine === "edge") return;
      const host = store.hostNode;
      if (!host) return;
      const alive = new Set();
      for (const tab of store.tabs) {
        const box = ensureContainer(tab);
        if (box) alive.add(box);
      }
      for (const child of Array.from(host.children)) {
        if (!alive.has(child)) child.remove();
      }
      applyVisibility();
    }

    function applyVisibility() {
      for (const tab of store.tabs) {
        if (!tab.container) continue;
        const isActive = tab.id === store.activeId;
        tab.container.style.visibility = isActive ? "visible" : "hidden";
        tab.container.style.zIndex = isActive ? "2" : "0";
      }
    }

    function releaseTab(tab) {
      if (tab.embedded) {
        tab.embedded = false;
        void postApi("/embed/close", { id: tab.id }).catch(() => {});
      }
      const carrier = bridge();
      const lease = tab.lease;
      tab.lease = null;
      if (lease && carrier) {
        try {
          Promise.resolve(carrier.release(lease)).catch(() => {});
        } catch {
          /* ignore */
        }
      }
      if (tab.unsubscribe) {
        try {
          tab.unsubscribe();
        } catch {
          /* ignore */
        }
        tab.unsubscribe = null;
      }
      if (tab.el) {
        try {
          tab.el.remove();
        } catch {
          /* ignore */
        }
      }
      tab.el = null;
      tab.created = false;
      tab.pending = null;
      if (tab.container) {
        for (const stale of Array.from(tab.container.querySelectorAll("webview"))) stale.remove();
      }
    }

    function patchTab(tab, patch) {
      Object.assign(tab, patch);
      notify();
    }

    /**
     * 建一个页签的 webview。挂载顺序不能动：
     * name / partition / useragent / allowpopups / src 必须在 appendChild 之前设好，
     * 否则主进程的 will-attach-webview 门禁会直接 preventDefault。
     */
    function ensureGuest(tab) {
      if (!tab) return Promise.resolve();
      if (tab.created) return Promise.resolve();
      if (tab.pending) return tab.pending;

      tab.pending = (async () => {
        const carrier = bridge();
        if (!carrier) {
          store.bridgeMissing = true;
          patchTab(tab, { status: "unavailable", error: "内置浏览器只在 DSH NEXT 桌面端可用。" });
          return;
        }

        try {
          await waitForUsableBox();
          // 等待期间页签可能已经被关掉了：别再往里塞 webview。
          if (store.tabs.indexOf(tab) < 0) return;
          const box = ensureContainer(tab);
          if (!box) throw new Error("宿主节点还没就绪（shell.overlay 不可用）");

          const reservation = await carrier.acquire(WORKSPACE_KEY);
          if (store.tabs.indexOf(tab) < 0) {
            // 同上：acquire 回来时页签没了，把 lease 立刻还掉，否则主进程会攒一堆。
            const orphan = reservation && reservation.lease;
            if (orphan) {
              try {
                Promise.resolve(carrier.release(orphan)).catch(() => {});
              } catch {
                /* ignore */
              }
            }
            return;
          }
          const lease = reservation && reservation.lease;
          const partition = reservation && reservation.partition;
          if (!lease || !partition) throw new Error("主进程没有返回可用的 lease");
          tab.lease = lease;

          const pageUa = buildGuestUserAgent(globalThis.navigator?.userAgent || "");
          const element = document.createElement("webview");
          element.setAttribute("name", lease);
          element.setAttribute("partition", partition);
          if (pageUa) element.setAttribute("useragent", pageUa);
          element.setAttribute("allowpopups", "");
          element.setAttribute("src", "about:blank#" + lease);
          element.style.width = "100%";
          element.style.height = "100%";
          // 必须 flex：写成 block 时内部 iframe 会退化成 150px 高。
          element.style.display = "flex";
          element.style.border = "0";
          element.style.background = "transparent";

          element.addEventListener("dom-ready", () => {
            try {
              element.executeJavaScript(guestFingerprintFix(pageUa)).catch(() => {});
            } catch {
              /* ignore */
            }
          });
          element.addEventListener("did-navigate", (event) => {
            const url = event && event.url ? event.url : "";
            // about:blank#<lease> 是挂载用的占位导航，不能当成用户地址回写
            if (!url || /^about:/i.test(url)) {
              if (tab.status === "error") patchTab(tab, { status: "ready", error: "" });
              return;
            }
            patchTab(tab, { url, ...(tab.status === "error" ? { status: "ready", error: "" } : {}) });
            // 撞到 Google 的登录页就提示一次：这里的登录一定会被拒，别让用户白试。
            if (!googleHintShown && /(^|\.)accounts\.google\.com$/i.test(hostOf(url))) {
              googleHintShown = true;
              notice("Google 不接受在内嵌浏览器里登录账号：点地址栏右侧的 ↗ 用系统浏览器打开。", "warn");
            }
          });
          element.addEventListener("did-navigate-in-page", (event) => {
            const url = event && event.url ? event.url : "";
            if (!url || /^about:/i.test(url)) return;
            patchTab(tab, { url });
          });
          element.addEventListener("page-title-updated", (event) => {
            const title = event && event.title ? String(event.title) : "";
            if (title) patchTab(tab, { title });
          });
          element.addEventListener("did-start-loading", () => {
            if (tab.loading) return;
            patchTab(tab, { loading: true });
          });
          element.addEventListener("did-stop-loading", () => {
            if (!tab.loading) return;
            patchTab(tab, { loading: false });
          });
          element.addEventListener("did-fail-load", (event) => {
            if (event && event.isMainFrame === false) return;
            const code = event && event.errorCode;
            if (code === -3) return; // ABORTED：自己取消的导航，不算错
            patchTab(tab, { status: "error", error: (event && event.errorDescription) || "加载失败", loading: false });
          });
          element.addEventListener("crashed", () => {
            tab.created = false;
            patchTab(tab, { status: "error", error: "渲染进程崩溃，点重载可重建这个页签。", loading: false });
          });
          element.addEventListener("destroyed", () => {
            tab.created = false;
          });
          element.addEventListener("render-process-gone", (event) => {
            const reason = (event && event.details && event.details.reason) || "unknown";
            tab.created = false;
            patchTab(tab, { status: "error", error: "渲染进程退出：" + reason, loading: false });
          });

          box.appendChild(element);
          tab.el = element;
          tab.created = true;

          // 新窗口 / target=_blank：主进程会 deny 并把这个 URL 送回来，我们自己开成新页签。
          if (typeof carrier.onOpenRequested === "function") {
            try {
              tab.unsubscribe = carrier.onOpenRequested(lease, (url) => {
                const target = normalizeUrl(url);
                if (target) openTab({ url: target });
              });
            } catch {
              tab.unsubscribe = null;
            }
          }

          const ready = await waitEvent(element, "dom-ready", 20000);
          if (!ready) console.warn("[dsh-web-tabs] dom-ready 超时", tab.id);

          await Promise.resolve(element.loadURL(tab.url)).catch((error) => {
            console.warn("[dsh-web-tabs] loadURL failed", error);
          });
          await waitEvent(element, "did-finish-load", 25000);
          syncGuestViewport();
          patchTab(tab, { status: "ready" });
        } catch (error) {
          console.warn("[dsh-web-tabs] 创建内置浏览器失败", error);
          const message = errorText(error);
          patchTab(tab, { status: "error", error: message, loading: false });
        } finally {
          tab.pending = null;
        }
      })();

      return tab.pending;
    }
    //#endregion

    /**
     * 引擎分发：edge 走 host 侧的原生窗口，webview 走 Electron <webview>。
     * 引擎检测是异步的，所以先等它落定再决定，避免两种引擎各建一遍页签。
     */
    async function ensureTab(tab) {
      if (!tab) return;
      if (enginePromise) await enginePromise.catch(() => {});
      if (store.engine === "edge") return ensureEmbed(tab);
      return ensureGuest(tab);
    }

    //#region 页签操作
    function openTab(options) {
      const url = normalizeUrl(options && options.url);
      if (!url) return null;
      const preset = options && options.preset ? PRESETS.find((item) => item.preset === options.preset) : null;
      const tab = {
        id: uid("tab"),
        url,
        title: (options && options.title) || (preset ? preset.label : ""),
        preset: preset ? preset.preset : "",
        color: preset ? preset.color : (options && options.color) || "#5b6270",
        letter: preset ? preset.letter : "",
        loading: false,
        status: "idle",
        error: "",
        container: null,
        el: null,
        lease: null,
        pending: null,
        created: false,
        embedded: false,
      };
      store.tabs.push(tab);
      store.activeId = tab.id;
      syncContainers();
      notify();
      saveTabs();
      pushLayout();
      void ensureTab(tab);
      return tab;
    }

    function closeTab(id) {
      const index = store.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const tab = store.tabs[index];
      releaseTab(tab);
      if (tab.container) tab.container.remove();
      store.tabs.splice(index, 1);
      if (store.activeId === id) {
        const fallback = store.tabs[Math.max(0, index - 1)] || store.tabs[0];
        store.activeId = fallback ? fallback.id : null;
      }
      syncContainers();
      notify();
      saveTabs();
      pushLayout();
      if (store.activeId) void ensureTab(findTab(store.activeId));
    }

    function setActive(id) {
      if (!findTab(id)) return;
      store.activeId = id;
      syncContainers();
      notify();
      saveTabs();
      pushLayout();
      void ensureTab(findTab(id));
    }

    function navigate(url, tabId) {
      const tab = tabId ? findTab(tabId) : activeTab();
      if (!tab) return;
      const target = normalizeUrl(url);
      if (!target) return;
      patchTab(tab, { url: target, status: tab.status === "error" ? "idle" : tab.status, error: "" });
      if (store.engine === "edge") {
        if (tab.embedded) navigateEmbed(tab, target);
        else void ensureTab(tab);
        return;
      }
      if (!tab.el) {
        void ensureTab(tab);
        return;
      }
      try {
        Promise.resolve(tab.el.loadURL(target)).catch((error) => {
          patchTab(tab, { status: "error", error: errorText(error) });
        });
      } catch (error) {
        patchTab(tab, { status: "error", error: errorText(error) });
      }
    }

    function reload(tabId) {
      const tab = tabId ? findTab(tabId) : activeTab();
      if (!tab) return;
      if (store.engine === "edge") {
        if (!tab.embedded) {
          patchTab(tab, { status: "idle", error: "" });
          void ensureTab(tab);
          return;
        }
        void postApi("/embed/reload", { id: tab.id })
          .then((result) => {
            if (result && result.ok === false) {
              patchTab(tab, { status: "error", error: result.detail || result.reason || "重载失败" });
            }
          })
          .catch((error) => patchTab(tab, { status: "error", error: errorText(error) }));
        return;
      }
      if (!tab.el || !tab.created) {
        releaseTab(tab);
        patchTab(tab, { status: "idle", error: "" });
        void ensureGuest(tab);
        return;
      }
      try {
        tab.el.reload();
      } catch (error) {
        patchTab(tab, { status: "error", error: errorText(error) });
      }
    }

    function goBack(tabId) {
      const tab = tabId ? findTab(tabId) : activeTab();
      if (!tab) return;
      if (store.engine === "edge") {
        if (tab.embedded) void postApi("/embed/history", { id: tab.id, delta: -1 }).catch(() => {});
        return;
      }
      if (!tab.el) return;
      try {
        if (tab.el.canGoBack()) tab.el.goBack();
      } catch {
        /* ignore */
      }
    }

    function goForward(tabId) {
      const tab = tabId ? findTab(tabId) : activeTab();
      if (!tab) return;
      if (store.engine === "edge") {
        if (tab.embedded) void postApi("/embed/history", { id: tab.id, delta: 1 }).catch(() => {});
        return;
      }
      if (!tab.el) return;
      try {
        if (tab.el.canGoForward()) tab.el.goForward();
      } catch {
        /* ignore */
      }
    }

    function disposeAll() {
      stopEmbedSync();
      for (const tab of store.tabs) releaseTab(tab);
      if (store.engine === "edge") void postApi("/embed/shutdown", {}).catch(() => {});
    }
    //#endregion

    //#region 样式
    const CSS = `
.dshwt-root{position:relative;width:100%;height:100%;display:flex;flex-direction:column;min-height:0;
  background:var(--dsw-alias-bg-layer-1,#12121a);color:var(--dsw-alias-label-primary,#eaeaef);}
.dshwt-root[data-empty="1"]{background:transparent;}
.dshwt-strip{display:flex;align-items:center;gap:4px;padding:6px 8px 5px;flex:0 0 auto;overflow-x:auto;
  overflow-y:hidden;border-bottom:1px solid var(--dsw-alias-border-l1,#26262f);scrollbar-width:thin;}
.dshwt-tab{display:flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 7px;border-radius:8px;
  cursor:pointer;color:var(--dsw-alias-label-secondary,#9a9aa8);font-size:12px;line-height:1;white-space:nowrap;
  border:1px solid transparent;background:transparent;max-width:190px;flex:0 0 auto;transition:background .12s;}
.dshwt-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#1e1e28);}
.dshwt-tab[data-active="1"]{background:var(--dsw-alias-bg-layer-3,#232330);
  color:var(--dsw-alias-label-primary,#f0f0f5);border-color:var(--dsw-alias-border-l2,#33333f);}
.dshwt-dot{width:14px;height:14px;border-radius:4px;display:flex;align-items:center;justify-content:center;
  font-size:8px;font-weight:600;color:#fff;flex:0 0 auto;letter-spacing:0;}
.dshwt-name{overflow:hidden;text-overflow:ellipsis;max-width:130px;}
.dshwt-tab[data-loading="1"] .dshwt-dot{animation:dshwt-pulse 1.1s ease-in-out infinite;}
@keyframes dshwt-pulse{0%,100%{opacity:1}50%{opacity:.42}}
.dshwt-x{width:16px;height:16px;border:0;background:transparent;color:inherit;opacity:.5;cursor:pointer;
  font-size:13px;line-height:1;padding:0;border-radius:4px;display:flex;align-items:center;justify-content:center;}
.dshwt-x:hover{opacity:1;background:rgba(255,255,255,.1);}
.dshwt-add,.dshwt-ib{width:26px;height:26px;flex:0 0 auto;border:1px solid transparent;border-radius:7px;
  background:transparent;color:var(--dsw-alias-label-secondary,#9a9aa8);cursor:pointer;font-size:14px;
  line-height:1;display:flex;align-items:center;justify-content:center;padding:0;}
.dshwt-add:hover,.dshwt-ib:hover{background:var(--dsw-alias-interactive-bg-hover,#1e1e28);
  color:var(--dsw-alias-label-primary,#f0f0f5);}
.dshwt-ib:disabled{opacity:.32;cursor:default;background:transparent;}
.dshwt-bar{display:flex;align-items:center;gap:4px;padding:0 8px 6px;flex:0 0 auto;}
.dshwt-url{flex:1 1 auto;min-width:0;height:26px;padding:0 10px;border-radius:7px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1,#26262f);background:var(--dsw-alias-bg-layer-2,#191922);
  color:var(--dsw-alias-label-primary,#eaeaef);outline:none;font-family:inherit;}
.dshwt-url:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshwt-body{position:relative;flex:1 1 auto;min-height:0;display:flex;}
/* 没有桌面桥时的降级页：居中提示，不量矩形 */
.dshwt-fallback{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;padding:24px;text-align:center;}
.dshwt-fallback-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#eaeaef);}
.dshwt-fallback-text{font-size:12px;line-height:1.7;max-width:420px;
  color:var(--dsw-alias-label-tertiary,#7c7c8c);}
.dshwt-fallback a{color:var(--dsw-alias-brand-primary,#4d6bfe);word-break:break-all;}
.dshwt-menu{position:fixed;z-index:40;min-width:0;padding:6px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-3,#232330);border:1px solid var(--dsw-alias-border-l2,#33333f);
  box-shadow:0 12px 32px rgba(0,0,0,.42);display:flex;flex-direction:column;gap:2px;
  box-sizing:border-box;}
.dshwt-menu-item{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border:0;border-radius:7px;
  background:transparent;color:var(--dsw-alias-label-primary,#eaeaef);font-size:12px;cursor:pointer;
  text-align:left;font-family:inherit;}
.dshwt-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,#2c2c3a);}
.dshwt-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#33333f);}
.dshwt-menu-form{display:flex;gap:6px;padding:2px 4px 4px;}
.dshwt-menu-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:6px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1,#33333f);background:var(--dsw-alias-bg-layer-2,#191922);
  color:var(--dsw-alias-label-primary,#eaeaef);outline:none;font-family:inherit;}
.dshwt-menu-go{height:26px;padding:0 10px;border-radius:6px;border:0;cursor:pointer;font-size:12px;
  background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font-family:inherit;}
/* 常驻宿主：贴住 placeholder 量出来的矩形 */
#${HOST_ID}{position:fixed;z-index:30;overflow:hidden;background:transparent;box-sizing:border-box;
  display:flex;flex-direction:column;}
#${STACK_ID}{position:relative;flex:auto;min-height:0;display:flex;width:100%;height:100%;}
.dshwt-status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:8px;padding:24px;text-align:center;background:var(--dsw-alias-bg-layer-1,#12121a);
  color:var(--dsw-alias-label-secondary,#9a9aa8);font-size:12px;line-height:1.7;z-index:3;}
.dshwt-status strong{color:var(--dsw-alias-label-primary,#eaeaef);font-size:13px;font-weight:600;}
.dshwt-status button{height:28px;padding:0 14px;border-radius:7px;cursor:pointer;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,#33333f);background:var(--dsw-alias-bg-layer-3,#232330);
  color:var(--dsw-alias-label-primary,#eaeaef);font-family:inherit;}
.dshwt-status button:hover{background:var(--dsw-alias-interactive-bg-hover,#2c2c3a);}
.dshwt-status-text{max-width:520px;}
.dshwt-status-meta{font-size:11px;opacity:.66;}
.dshwt-status-text:empty{display:none;}
/* 「在系统浏览器打开」：Google 系站点时高亮，因为那里只有这条路走得通 */
.dshwt-ext[data-accent="1"]{color:var(--dsw-alias-brand-primary,#4d6bfe);
  border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
/* 提示区：始终存在但空着不占高（子节点位置稳定，body 不会被重建） */
.dshwt-notices{display:flex;flex-direction:column;flex:0 0 auto;}
.dshwt-notice{display:flex;align-items:center;gap:8px;margin:0 8px 6px;padding:6px 8px;flex:0 0 auto;
  border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-2,#191922);
  border:1px solid var(--dsw-alias-border-l1,#26262f);color:var(--dsw-alias-label-secondary,#9a9aa8);}
.dshwt-notice[data-tone="warn"]{border-color:var(--dsw-alias-state-warn-label,#c99a3a);
  color:var(--dsw-alias-state-warn-label,#c99a3a);}
.dshwt-notice-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.dshwt-notice-x{width:18px;height:18px;flex:0 0 auto;border:0;background:transparent;color:inherit;
  opacity:.62;cursor:pointer;font-size:13px;line-height:1;padding:0;border-radius:4px;}
.dshwt-notice-x:hover{opacity:1;}
/* 「宿主半侧没加载」横幅：唯一一个必须重启才能消掉的提示，所以给按钮 */
.dshwt-reload{display:flex;align-items:center;gap:8px;margin:0 8px 6px;padding:7px 9px;flex:0 0 auto;
  border-radius:8px;font-size:12px;line-height:1.5;background:var(--dsw-alias-bg-layer-2,#191922);
  border:1px solid var(--dsw-alias-state-warn-label,#c99a3a);color:var(--dsw-alias-label-secondary,#9a9aa8);}
.dshwt-reload-text{flex:1 1 auto;min-width:0;}
.dshwt-reload-btn{flex:0 0 auto;height:24px;padding:0 10px;border-radius:6px;cursor:pointer;font-size:12px;
  font-family:inherit;border:1px solid var(--dsw-alias-border-l2,#33333f);
  background:var(--dsw-alias-bg-layer-3,#232330);color:var(--dsw-alias-label-primary,#eaeaef);}
.dshwt-reload-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#2c2c3a);}
.dshwt-reload-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);
  background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;}
.dshwt-reload-primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshwt-fallback-actions{display:flex;gap:8px;margin-top:4px;}
/* ---- 内置浏览器设置浮层（选浏览器 / 选 profile） ---- */
.dshwt-sheet{position:fixed;z-index:41;max-width:420px;padding:12px;border-radius:12px;box-sizing:border-box;
  background:var(--dsw-alias-bg-layer-3,#232330);border:1px solid var(--dsw-alias-border-l2,#33333f);
  box-shadow:0 18px 44px rgba(0,0,0,.48);display:flex;flex-direction:column;gap:9px;
  color:var(--dsw-alias-label-primary,#eaeaef);font-size:12px;}
.dshwt-sheet-head{display:flex;align-items:center;gap:8px;}
.dshwt-sheet-title{flex:1 1 auto;font-size:13px;font-weight:600;}
.dshwt-sheet-close{width:20px;height:20px;flex:0 0 auto;border:0;background:transparent;padding:0;cursor:pointer;
  color:inherit;opacity:.62;font-size:14px;line-height:1;border-radius:4px;}
.dshwt-sheet-close:hover{opacity:1;}
.dshwt-sheet-hint{color:var(--dsw-alias-label-tertiary,#7c7c8c);line-height:1.6;}
.dshwt-opt{display:flex;align-items:center;gap:8px;padding:8px 9px;border-radius:9px;cursor:pointer;text-align:left;
  border:1px solid var(--dsw-alias-border-l1,#26262f);background:var(--dsw-alias-bg-layer-2,#191922);
  color:inherit;font-family:inherit;font-size:12px;line-height:1.4;}
.dshwt-opt:hover:not([data-disabled="1"]){background:var(--dsw-alias-interactive-bg-hover,#2c2c3a);}
.dshwt-opt[data-disabled="1"]{opacity:.42;cursor:default;}
.dshwt-opt[data-active="1"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshwt-opt-body{flex:1 1 auto;min-width:0;}
.dshwt-opt-name{display:flex;align-items:center;gap:6px;}
.dshwt-opt-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#7c7c8c);margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshwt-badge{font-size:10px;padding:1px 5px;border-radius:5px;line-height:1.5;flex:0 0 auto;
  background:var(--dsw-alias-bg-layer-1,#12121a);color:var(--dsw-alias-label-tertiary,#7c7c8c);
  border:1px solid var(--dsw-alias-border-l1,#26262f);}
.dshwt-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-label,#c99a3a);
  border-color:var(--dsw-alias-state-warn-label,#c99a3a);}
.dshwt-badge[data-tone="ok"]{color:var(--dsw-alias-brand-primary,#4d6bfe);
  border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshwt-sheet-err{padding:7px 9px;border-radius:8px;line-height:1.6;
  color:var(--dsw-alias-state-warn-label,#c99a3a);border:1px solid var(--dsw-alias-state-warn-label,#c99a3a);}
.dshwt-sheet-foot{display:flex;gap:8px;align-items:center;}
.dshwt-sheet-foot .dshwt-reload-btn{height:26px;}
/* 「其它浏览器」：手填 exe 路径 */
.dshwt-sheet-section{border-top:1px solid var(--dsw-alias-border-l1,#26262f);padding-top:9px;
  display:flex;flex-direction:column;gap:7px;}
.dshwt-sheet-row{display:flex;gap:7px;align-items:center;}
.dshwt-sheet-input{flex:1 1 auto;min-width:0;height:26px;box-sizing:border-box;padding:0 8px;border-radius:7px;
  font-family:inherit;font-size:11px;color:inherit;background:var(--dsw-alias-bg-layer-1,#12121a);
  border:1px solid var(--dsw-alias-border-l1,#26262f);outline:none;}
.dshwt-sheet-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshwt-sheet-input:disabled{opacity:.5;}
.dshwt-sheet-row .dshwt-reload-btn{height:26px;flex:0 0 auto;}
/* 页签条右侧的齿轮：当前浏览器名 + 一键换 */
.dshwt-gear{height:26px;flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:0 8px;cursor:pointer;
  border-radius:7px;border:1px solid transparent;background:transparent;font-size:11px;font-family:inherit;
  color:var(--dsw-alias-label-tertiary,#7c7c8c);white-space:nowrap;max-width:170px;margin-left:auto;}
.dshwt-gear:hover{background:var(--dsw-alias-interactive-bg-hover,#1e1e28);
  color:var(--dsw-alias-label-primary,#f0f0f5);}
.dshwt-gear-name{overflow:hidden;text-overflow:ellipsis;max-width:130px;}
.dshwt-gear[data-tone="warn"]{color:var(--dsw-alias-state-warn-label,#c99a3a);}
`;

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    //#endregion

    //#region React 组件
    function useSnapshot() {
      const [snap, setSnap] = react.useState(snapshot);
      react.useEffect(() => {
        setSnap(snapshot());
        return subscribe(() => setSnap(snapshot()));
      }, []);
      return snap;
    }

    /** 从 body 元素的实测矩形更新宿主位置；宿主自己会做最多 4 次位置自校正。 */
    function useRectPublisher(ref, enabled) {
      react.useEffect(() => {
        const element = ref.current;
        if (!element || !enabled) return undefined;

        let frame = 0;
        let alive = true;
        function measure() {
          if (!alive) return;
          const node = ref.current;
          if (node && node.isConnected) {
            const rect = node.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              publishRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
              return;
            }
          }
          publishRect(null);
        }
        function schedule() {
          if (frame) cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            frame = 0;
            measure();
          });
        }

        schedule();
        const observer = new ResizeObserver(schedule);
        observer.observe(element);
        window.addEventListener("resize", schedule);
        const poll = setInterval(schedule, 800);

        return () => {
          alive = false;
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
          window.removeEventListener("resize", schedule);
          clearInterval(poll);
          publishRect(null);
        };
      }, [ref, enabled]);
    }
    //#endregion

    //#region 地址栏
    function AddressBar(props) {
      const tab = props.tab;
      const [draft, setDraft] = react.useState(tab ? tab.url : "");
      const [focused, setFocused] = react.useState(false);

      react.useEffect(() => {
        if (!focused && tab) setDraft(tab.url);
      }, [tab && tab.url, focused, tab]);

      if (!tab) return null;

      function commit() {
        const target = normalizeUrl(draft);
        if (target) navigate(target, tab.id);
        else setDraft(tab.url);
      }

      return h(
        "div",
        { className: "dshwt-bar" },
        h("button", {
          className: "dshwt-ib",
          type: "button",
          title: "后退",
          onClick: () => goBack(tab.id),
          children: "‹",
        }),
        h("button", {
          className: "dshwt-ib",
          type: "button",
          title: "前进",
          onClick: () => goForward(tab.id),
          children: "›",
        }),
        h("button", {
          className: "dshwt-ib",
          type: "button",
          title: tab.loading ? "停止" : "刷新",
          onClick: () => reload(tab.id),
          children: tab.loading ? "×" : "⟳",
        }),
        h("input", {
          className: "dshwt-url",
          value: draft,
          spellCheck: false,
          placeholder: "输入网址后回车（例如 chat.openai.com）",
          onChange: (event) => setDraft(event.target.value),
          onMouseDown: (event) => {
            // 地址栏语义：从别处点进来 = 全选（直接打字就是新网址，不会接在旧网址尾巴上）；
            // 已经聚焦时再点 = 正常放光标，方便局部改。
            const field = event.currentTarget;
            if (document.activeElement === field) return;
            event.preventDefault();
            field.focus();
            try {
              field.select();
            } catch {
              /* ignore */
            }
          },
          onFocus: () => setFocused(true),
          onBlur: () => {
            setFocused(false);
            setDraft(tab.url);
          },
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setDraft(tab.url);
              event.currentTarget.blur();
            }
          },
        }),
        h("button", {
          className: "dshwt-ib dshwt-ext",
          type: "button",
          "data-accent": googleFamily(tab.url) ? "1" : "0",
          title: googleFamily(tab.url)
            ? "在系统浏览器打开（Google 不允许在内嵌浏览器里登录账号）"
            : "在系统浏览器打开",
          onClick: () => {
            void openInSystemBrowser(tab.url);
          },
          children: "↗",
        }),
      );
    }
    //#endregion

    //#region 页签栏
    // 菜单不在页签栏里画：页签栏 overflow-x:auto 会裁掉它，而且它必须盖在 webview
    // （z-index 30 的 guest 宿主）之上，所以单独注册成 shell.overlay。
    function TabStrip(props) {
      const tabs = props.tabs;
      const activeId = props.activeId;
      const menuOpen = Boolean(props.menuOpen);
      const snap = useSnapshot();

      // 齿轮上的字：有 capability 就用浏览器短名（「Microsoft Edge（用户配置 1）」→「Microsoft Edge」），
      // 没有就说明引擎还没起来，显示「选择浏览器」当入口。
      const gearFull = (() => {
        const cap = snap.capability;
        if (cap && cap.ok) return cap.browserName || cap.browserId || "浏览器";
        return "";
      })();
      const gearLabel = gearFull ? shortBrowserName(gearFull) : "选择浏览器";
      const gearTone = snap.capability && snap.capability.ok === false ? "warn" : "ok";

      return h(
        "div",
        { style: { position: "relative", flex: "0 0 auto", display: "flex", flexDirection: "column", zIndex: 4 } },
        h(
          "div",
          { className: "dshwt-strip", key: "strip" },
          ...tabs.map((tab) =>
            h(
              "div",
              {
                key: tab.id,
                className: "dshwt-tab",
                "data-active": tab.id === activeId ? "1" : "0",
                "data-loading": tab.loading ? "1" : "0",
                title: tab.url,
                onMouseDown: (event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    closeTab(tab.id);
                  }
                },
                onClick: () => setActive(tab.id),
              },
              h("span", { className: "dshwt-dot", style: { background: tab.color } }, tab.letter || ""),
              h("span", { className: "dshwt-name" }, tab.title),
              h(
                "button",
                {
                  className: "dshwt-x",
                  type: "button",
                  title: "关闭页签",
                  onClick: (event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  },
                },
                "×",
              ),
            ),
          ),
          h(
            "button",
            {
              className: "dshwt-add",
              type: "button",
              title: "新建页签",
              "data-open": menuOpen ? "1" : "0",
              onClick: (event) => {
                event.stopPropagation();
                if (store.menu) closeMenu();
                else openMenu(event.currentTarget);
              },
            },
            "＋",
          ),
          h(
            "button",
            {
              className: "dshwt-gear",
              type: "button",
              title: "当前内嵌浏览器：" + gearFull + "（点这里换浏览器 / 换 profile）",
              "data-tone": gearTone,
              onClick: (event) => {
                event.stopPropagation();
                toggleSheet();
              },
            },
            h("span", { className: "dshwt-gear-name" }, gearLabel),
            h("span", { "aria-hidden": "true" }, "⚙"),
          ),
        ),
      );
    }

    /** 新建页签菜单：固定定位的视口浮层，z-index 高于 guest 宿主。 */
    function NewTabMenu() {
      ensureStyles();
      const snap = useSnapshot();
      const menu = snap.menu;
      const [custom, setCustom] = react.useState("");
      const boxRef = react.useRef(null);

      react.useEffect(() => {
        if (!menu) return undefined;
        function onPointerDown(event) {
          const box = boxRef.current;
          if (box && box.contains(event.target)) return;
          // 点「＋」自己交给按钮的 onClick 处理，避免同一次点击先关后开
          const add = event.target && event.target.closest ? event.target.closest(".dshwt-add") : null;
          if (add) return;
          closeMenu();
        }
        function onKey(event) {
          if (event.key === "Escape") closeMenu();
        }
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [menu]);

      if (!menu) return null;

      function commit(url) {
        closeMenu();
        setCustom("");
        void openTab({ url });
      }

      const bounds = {
        position: "fixed",
        left: menu.left + "px",
        top: menu.top + "px",
        width: (menu.width || 240) + "px",
        zIndex: 40,
      };

      return h(
        "div",
        { ref: boxRef, className: "dshwt-menu", key: "menu", style: bounds },
        ...PRESETS.map((preset) =>
          h(
            "button",
            {
              key: preset.preset,
              type: "button",
              className: "dshwt-menu-item",
              onClick: () => {
                closeMenu();
                void openTab({ url: preset.url, preset: preset.preset });
              },
            },
            h("span", { className: "dshwt-dot", style: { background: preset.color } }, preset.letter),
            preset.label,
          ),
        ),
        h("div", { className: "dshwt-menu-sep", key: "sep" }),
        h(
          "div",
          { className: "dshwt-menu-form", key: "form" },
          h("input", {
            className: "dshwt-menu-input",
            value: custom,
            spellCheck: false,
            placeholder: "自定义网址",
            autoFocus: true,
            onChange: (event) => setCustom(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              const target = normalizeUrl(custom);
              if (target) commit(target);
            },
          }),
          h(
            "button",
            {
              className: "dshwt-menu-go",
              type: "button",
              onClick: () => {
                const target = normalizeUrl(custom);
                if (target) commit(target);
              },
            },
            "打开",
          ),
        ),
      );
    }
    //#endregion

    //#region 内置浏览器设置浮层
    /**
     * 一个浮层管两件事：换浏览器、换 profile。
     *
     * 为什么要给 profile 选择：shared 模式直接把窗口挂到用户自己的浏览器上，登录态在哪个
     * profile 里只有用户知道（很多人主 profile 是「个人」而不是 Default）。写死 Default
     * 等于打开一个空壳配置 —— ChatGPT 永远显示未登录，且用户完全不知道为什么。
     */
    function BrowserSheet() {
      ensureStyles();
      const snap = useSnapshot();
      const sheet = snap.sheet;
      const boxRef = react.useRef(null);
      const choices = snap.browserChoices;
      // 手填路径是本地输入框状态，不进 store（每敲一个字全局 notify 太重）。
      const [customPath, setCustomPath] = react.useState("");
      const inputRef = react.useRef(null);

      react.useEffect(() => {
        if (!sheet) return undefined;
        function onPointerDown(event) {
          const box = boxRef.current;
          if (box && box.contains(event.target)) return;
          const gear = event.target && event.target.closest ? event.target.closest(".dshwt-gear") : null;
          if (gear) return;
          closeSheet();
        }
        function onKey(event) {
          if (event.key === "Escape") closeSheet();
        }
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [sheet]);

      if (!sheet) return null;

      // 锚点：贴在齿轮下面（齿轮在页签条最右）。拿不到就贴右上角。
      const bounds = (() => {
        const width = 380;
        let left = Math.max(12, (globalThis.innerWidth || 1200) - width - 24);
        let top = 96;
        try {
          const gear = document.querySelector(".dshwt-gear");
          if (gear && gear.getBoundingClientRect) {
            const rect = gear.getBoundingClientRect();
            if (rect && rect.width >= 0) {
              left = Math.max(12, Math.min(rect.right - width, (globalThis.innerWidth || 1200) - width - 12));
              top = rect.bottom + 6;
            }
          }
        } catch {
          /* ignore */
        }
        return { position: "fixed", left: left + "px", top: top + "px", width: width + "px", zIndex: 42 };
      })();

      const current = choices ? choices.current : "";
      const list = choices && Array.isArray(choices.browsers) ? choices.browsers : [];
      const activeBrowser = list.find((item) => item.id === current) || null;

      const rows = [];
      for (const item of list) {
        const isCurrent = item.id === current;
        rows.push(
          h(
            "button",
            {
              key: "b-" + item.id,
              type: "button",
              className: "dshwt-opt",
              "data-active": isCurrent ? "1" : "0",
              "data-disabled": sheet.applying || !item.installed ? "1" : "0",
              disabled: Boolean(sheet.applying) || !item.installed,
              onClick: () => {
                if (isCurrent || !item.installed) return;
                void applyBrowserChoice(item.id, "");
              },
            },
            h(
              "span",
              { className: "dshwt-opt-body" },
              h(
                "span",
                { className: "dshwt-opt-name" },
                item.name,
                item.installed
                  ? null
                  : h("span", { className: "dshwt-badge", "data-tone": "warn" }, "未安装"),
                item.installed && !item.tested
                  ? h("span", { className: "dshwt-badge", "data-tone": "warn" }, "未实测")
                  : null,
                isCurrent ? h("span", { className: "dshwt-badge", "data-tone": "ok" }, "当前") : null,
              ),
              h(
                "span",
                { className: "dshwt-opt-meta" },
                item.installed
                  ? item.profileName
                    ? item.profileName + "（" + item.profileDirectory + "）"
                    : "已安装"
                  : "没在这个位置找到可执行文件",
              ),
            ),
          ),
        );
      }

      // 当前浏览器有多个 profile 时，把所有 profile 列出来让用户选。
      const profileRows = [];
      if (activeBrowser && Array.isArray(activeBrowser.profiles) && activeBrowser.profiles.length > 1) {
        const currentDir = (snap.capability && snap.capability.profileDirectory) || activeBrowser.profileDirectory;
        profileRows.push(
          h("div", { className: "dshwt-sheet-hint", key: "p-hint" }, "登录态在哪个 profile 里，就选哪个："),
        );
        for (const profile of activeBrowser.profiles) {
          const isCurrent = profile.dir === currentDir;
          profileRows.push(
            h(
              "button",
              {
                key: "p-" + profile.dir,
                type: "button",
                className: "dshwt-opt",
                "data-active": isCurrent ? "1" : "0",
                "data-disabled": sheet.applying ? "1" : "0",
                disabled: Boolean(sheet.applying),
                onClick: () => {
                  if (isCurrent) return;
                  void applyBrowserChoice(current, profile.dir);
                },
              },
              h(
                "span",
                { className: "dshwt-opt-body" },
                h(
                  "span",
                  { className: "dshwt-opt-name" },
                  profile.name,
                  profile.hasGoogleAccount
                    ? h("span", { className: "dshwt-badge", "data-tone": "ok" }, "登过 Google")
                    : null,
                  isCurrent ? h("span", { className: "dshwt-badge", "data-tone": "ok" }, "当前" ) : null,
                ),
                h("span", { className: "dshwt-opt-meta" }, profile.dir),
              ),
            ),
          );
        }
      }

      return h(
        "div",
        { ref: boxRef, className: "dshwt-sheet", key: "sheet", style: bounds },
        h(
          "div",
          { className: "dshwt-sheet-head" },
          h("span", { className: "dshwt-sheet-title", children: "内嵌浏览器" }),
          h("button", {
            className: "dshwt-sheet-close",
            type: "button",
            title: "关闭",
            onClick: () => closeSheet(),
            children: "×",
          }),
        ),
        h("div", {
          className: "dshwt-sheet-hint",
          children:
            "内嵌窗口直接挂在你自己的浏览器上，所以浏览器里登录过的网站（ChatGPT、Claude、Google 账号）都能直接用。",
        }),
        sheet.loading ? h("div", { className: "dshwt-sheet-hint", children: "正在读取浏览器列表…" }) : null,
        sheet.error ? h("div", { className: "dshwt-sheet-err", children: sheet.error }) : null,
        ...rows,
        ...profileRows,
        choices && choices.source === "user-choice" && !current
          ? h("div", {
              className: "dshwt-sheet-hint",
              children: "之前选过的浏览器已经不在了，已自动改用这台机器上最近用过的那个。",
            })
          : null,
        // 「其它浏览器」：配置表里没有的 Chromium 变体（Chromium / Arc / 便携版）走这里手填 exe 路径。
        h(
          "div",
          { className: "dshwt-sheet-section", key: "custom" },
          h("div", {
            className: "dshwt-sheet-hint",
            children: "上面都没有？填一个 Chromium 浏览器的 .exe 完整路径（必须是 Chromium 内核，Firefox 不行）。",
          }),
          h(
            "div",
            { className: "dshwt-sheet-row" },
            h("input", {
              className: "dshwt-sheet-input",
              type: "text",
              spellcheck: false,
              placeholder: "C:\\Program Files\\Chromium\\Application\\chrome.exe",
              value: customPath,
              disabled: Boolean(sheet.applying),
              onInput: (event) => {
                setCustomPath(event.target.value || "");
              },
            }),
            h("button", {
              className: "dshwt-reload-btn",
              type: "button",
              disabled: Boolean(sheet.applying) || !customPath.trim(),
              onClick: () => void applyBrowserChoice("", "", undefined, customPath.trim()),
              children: "使用",
            }),
          ),
          choices && choices.currentPath
            ? h("div", {
                className: "dshwt-sheet-hint",
                children: "当前用的是手填路径：" + choices.currentPath,
              })
            : null,
        ),
        h(
          "div",
          { className: "dshwt-sheet-foot" },
          h("button", {
            className: "dshwt-reload-btn",
            type: "button",
            onClick: () => void loadBrowserChoices(),
            children: "刷新",
          }),
          // 只有真的存过偏好（选了浏览器或手填过路径）才给「自动选择」。
          choices && (choices.source === "user-choice" || choices.source === "user-path")
            ? h("button", {
                className: "dshwt-reload-btn",
                type: "button",
                disabled: Boolean(sheet.applying),
                onClick: () => void resetBrowserChoice(),
                children: "自动选择",
              })
            : null,
          // 引擎彻底不可用时（没装浏览器 / 宿主半侧没加载），这里给重启出口 —— 用户不必知道命令行。
          snap.capability && snap.capability.ok === false
            ? h("button", {
                className: "dshwt-reload-btn dshwt-reload-primary",
                type: "button",
                onClick: () => restartDesktop(),
                children: "重启 DSH NEXT",
              })
            : null,
        ),
      );
    }

    /** 齿轮上的短名：「Microsoft Edge（用户配置 1）」→「Microsoft Edge」。 */
    function shortBrowserName(label) {
      const text = String(label || "");
      const cut = text.indexOf("（");
      return cut > 0 ? text.slice(0, cut) : text;
    }
    //#endregion

    //#region 页签本体（conversation.view 槽位）
    function WebTabsPanel() {
      ensureStyles();
      const snap = useSnapshot();
      const bodyRef = react.useRef(null);
      const usable = snap.engine === "edge" || snap.engine === "webview";

      react.useEffect(() => {
        if (!usable) return;
        return () => {
          publishRect(null);
        };
      }, [usable]);

      // 只在真正能嵌外部页面时量矩形；隐藏时把宿主 / 原生窗口一起收回。
      useRectPublisher(bodyRef, usable);

      const activeTabView = snap.tabs.find((tab) => tab.id === snap.activeId) || null;
      // 原生 Edge 窗口不在渲染进程里：开不出来时 body 就是一个空 div，用户只看到一片壁纸。
      // 所以失败原因 / 等待态必须画在这里，顺带给出「重试」和「重启」两个出口。
      const bodyOverlay = (() => {
        if (!activeTabView) return null;
        if (activeTabView.error) {
          return h(
            "div",
            { className: "dshwt-status", key: "status" },
            h("strong", { children: "内置窗口打不开" }),
            h("div", { className: "dshwt-status-text", children: activeTabView.error }),
            h("div", {
              className: "dshwt-status-meta",
              children:
                "引擎 " +
                snap.engine +
                " · 状态 " +
                activeTabView.status +
                " · 已嵌入 " +
                (activeTabView.embedded ? "是" : "否"),
            }),
            h(
              "div",
              { className: "dshwt-fallback-actions" },
              h("button", { type: "button", onClick: () => retryActiveTab(), children: "重试" }),
              h("button", { type: "button", onClick: () => restartDesktop(), children: "重启 DSH NEXT" }),
            ),
          );
        }
        if (snap.engine === "edge" && !activeTabView.embedded) {
          return h(
            "div",
            { className: "dshwt-status", key: "status" },
            h("strong", { children: "正在打开内置浏览器窗口…" }),
            h("div", {
              className: "dshwt-status-text",
              children:
                "第一次打开要先起一个 " +
                snap.engineLabel +
                " 的 app 窗口再嵌进来，通常 2–5 秒。一直停在这里就点重试。",
            }),
            h(
              "div",
              { className: "dshwt-fallback-actions" },
              h("button", { type: "button", onClick: () => retryActiveTab(), children: "重试" }),
            ),
          );
        }
        return null;
      })();

      if (snap.engine === null) {
        return h(
          "div",
          { className: "dshwt-root", "data-empty": "1" },
          h(
            "div",
            { className: "dshwt-fallback" },
            h("div", { className: "dshwt-fallback-title", children: "正在连接内置浏览器…" }),
          ),
        );
      }

      if (!usable) {
        return h(
          "div",
          { className: "dshwt-root", "data-empty": "1" },
          h(
            "div",
            { className: "dshwt-fallback" },
            h("div", { className: "dshwt-fallback-title", children: "内置浏览器不可用" }),
            h("div", {
              className: "dshwt-fallback-text",
              children:
                "没见过可用的宿主通道：既没有内置浏览器窗口（需要 Windows + 已安装 Edge 或 Chrome），也没有 Electron webview（需要 DSH NEXT 桌面端）。",
            }),
            snap.embedError
              ? h("div", { className: "dshwt-fallback-text", children: "原因：" + snap.embedError })
              : null,
            // 没任何可用引擎时，降级页是用户唯一能看到的界面 —— 重启按钮必须放在这里。
            snap.engineUnloaded
              ? h(
                  "div",
                  { className: "dshwt-fallback-actions" },
                  h("button", {
                    className: "dshwt-reload-btn",
                    type: "button",
                    onClick: () => retryEngine(),
                    children: "重新检测",
                  }),
                  h("button", {
                    className: "dshwt-reload-btn dshwt-reload-primary",
                    type: "button",
                    onClick: () => restartDesktop(),
                    children: "立即重启 DSH NEXT",
                  }),
                )
              : null,
            h(
              "div",
              { className: "dshwt-fallback-text" },
              "常用站点：",
              ...PRESETS.map((preset, index) =>
                h(
                  "span",
                  { key: preset.preset },
                  index > 0 ? " · " : "",
                  h("a", { href: preset.url, target: "_blank", rel: "noreferrer noopener", children: preset.label }),
                ),
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        { className: "dshwt-root" },
        h(TabStrip, { key: "strip", tabs: snap.tabs, activeId: snap.activeId, menuOpen: Boolean(snap.menu) }),
        h(AddressBar, { key: "bar", tab: snap.tabs.find((tab) => tab.id === snap.activeId) || null }),
        // 提示区始终占位（空时不占高）：位置固定的子节点才能让 body 的 key 稳定，
        // 否则提示条一出现一消失，React 会把 body 当新节点重建，量矩形也跟着抖一下。
        h(
          "div",
          { className: "dshwt-notices", key: "notices" },
          // 放在固定存在的容器里（而不是作为 root 的兄弟节点），body 的位置才不会变、量矩形不抖。
          snap.engine !== "edge" || snap.engineUnloaded
            ? h(
                "div",
                { className: "dshwt-reload", key: "reload" },
                h("span", {
                  className: "dshwt-reload-text",
                  children:
                    "内置浏览器窗口没启用（" +
                    (snap.engineUnloaded ? "插件是刚装的，宿主半侧还没加载" : snap.embedError || "原因未知") +
                    "）。重启一次 DSH NEXT 就能用上：和系统浏览器共用登录态，Google 账号也能正常登录。",
                }),
                h("button", {
                  className: "dshwt-reload-btn",
                  type: "button",
                  onClick: () => retryEngine(),
                  children: "重新检测",
                }),
                h("button", {
                  className: "dshwt-reload-btn dshwt-reload-primary",
                  type: "button",
                  onClick: () => restartDesktop(),
                  children: "重启 DSH NEXT",
                }),
              )
            : null,
          snap.notice
            ? h(
                "div",
                { className: "dshwt-notice", key: snap.notice.id, "data-tone": snap.notice.tone || "info" },
                h("span", { className: "dshwt-notice-text", children: snap.notice.text }),
                h("button", {
                  className: "dshwt-notice-x",
                  type: "button",
                  title: "关闭",
                  onClick: () => notice(null),
                  children: "×",
                }),
              )
            : null,
        ),
        h("div", { className: "dshwt-body", key: "body", ref: bodyRef }, bodyOverlay),
      );
    }
    //#endregion

    //#region 常驻宿主（shell.overlay 槽位）
    function GuestHost() {
      ensureStyles();
      const wrapRef = react.useRef(null);
      const [rect, setRect] = react.useState(store.rect);
      const fixAttempts = react.useRef(0);

      react.useEffect(() => {
        setRect(store.rect);
        return subscribe(() => setRect(store.rect));
      }, []);

      // 位置自校正：外面量的是 placeholder 的矩形，宿主一旦被别的东西挤动，
      // 这里用最多 4 次微调把它拽回去（DSH 的布局有过渡动画）。
      react.useLayoutEffect(() => {
        const element = wrapRef.current;
        if (!element || !rect) return;
        if (fixAttempts.current >= 4) return;
        const current = element.getBoundingClientRect();
        const dx = rect.left - current.left;
        const dy = rect.top - current.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        fixAttempts.current += 1;
        element.style.left = (parseFloat(element.style.left || "0") + dx) + "px";
        element.style.top = (parseFloat(element.style.top || "0") + dy) + "px";
      }, [rect]);

      react.useEffect(() => {
        if (rect) fixAttempts.current = 0;
      }, [rect && rect.left, rect && rect.top]);

      const style = rect
        ? { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px", visibility: "visible" }
        : { left: "-99999px", top: "-99999px", width: "420px", height: "620px", visibility: "hidden" };

      return h(
        "div",
        { id: HOST_ID, ref: wrapRef, style },
        h("div", { id: STACK_ID, key: "stack", ref: (node) => registerHostNode(node) }),
        // shell.overlay 是单例槽位（先注册的条目会遮蔽后来的），所以「新建页签」菜单
        // 不能单独占一个 shell.overlay 注册，必须挂在同一个宿主里，否则永远是 null 不渲染。
        // position:fixed 相对视口定位，不会被宿主的 overflow:hidden 裁掉。
        h(NewTabMenu, { key: "menu" }),
        // 设置浮层同理：也必须挂在这个常驻宿主里，不能自己占 shell.overlay。
        h(BrowserSheet, { key: "sheet" }),
      );
    }
    //#endregion

    //#region 插件入口
    const inject = ["slots"];

    function apply(ctx) {
      ensureStyles();
      loadTabs();
      saveTabs(); // 首次启动把默认页签落盘，之后重启才能恢复
      syncContainers();

      if (!bridge()) {
        console.warn("[dsh-web-tabs] dshDesktop.browser 不可用：webview 引擎不可用，改试内置 Edge 窗口。");
      }

      void startEngine();

      // conversation.view：一个多页签浏览器页签。
      ctx.effect(
        () => {
          try {
            return ctx.slots.inject("conversation.view", () =>
              ctx.slots.register(
                {
                  name: "conversation.view",
                  id: "dsh-web-tabs-panel",
                  order: 31,
                  label: () => "网页",
                },
                WebTabsPanel,
              ),
            );
          } catch (error) {
            console.warn("[dsh-web-tabs] 注册网页页签失败（这个 DSH 版本可能没有 conversation.view 槽位）", error);
            return;
          }
        },
        "dsh-web-tabs: web tabs view",
      );

      // shell.overlay：webview 的常驻宿主，永不卸载。
      // 注意 shell.overlay 是单例槽位：只能注册一次（新建页签菜单挂在宿主内部渲染）。
      ctx.effect(
        () => {
          try {
            return ctx.slots.inject("shell.overlay", () =>
              ctx.slots.register(
                { name: "shell.overlay", id: "dsh-web-tabs-guest" },
                () => h(GuestHost),
              ),
            );
          } catch (error) {
            console.warn("[dsh-web-tabs] 注册常驻宿主失败（没有 shell.overlay 槽位就没法保活 webview）", error);
            return;
          }
        },
        "dsh-web-tabs: guest browser host",
      );

      ctx.effect(
        () => () => {
          disposeAll();
        },
        "dsh-web-tabs: dispose guests",
      );

      // 主窗口尺寸/位置变化时边缘也可能变，让 host 重新对齐（rect 自己会跟 ResizeObserver 走）。
      ctx.effect(
        () => () => {
          stopEmbedSync();
        },
        "dsh-web-tabs: stop embed sync",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

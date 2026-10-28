/**
 * dsh-web-tabs —— host (server) half.
 *
 * 页签、webview、地址栏全部在浏览器侧（`./client`）。这一半只做一件客户端做不到的事：
 * **把网址交给系统里真实的 Edge / Chrome，用 app 模式（无标签栏、无地址栏）打开**。
 *
 * 为什么需要它：Google 从 2021 年起禁止在内嵌浏览器里登录账号（OAuth 错误码
 * `disallowed_useragent`，页面原文「此浏览器或应用可能不安全」）。Electron 的
 * `<webview>` 无论怎么改 UA / 伪造 `navigator.userAgentData` 都会被 Gemini、
 * Gmail、「用 Google 账号登录」拦下来。真实浏览器内核没有这个问题，而只有
 * Node 侧能 spawn 进程 —— 客户端页面拿不到 `node:child_process`。
 *
 * 顺带解决另一件事：app 模式窗口用固定的 `--user-data-dir`，登录态跨重启保留；
 * 页签里的 webview 做不到（partition 名 `dsh-sidebar-browser-<uuid>` 没有
 * `persist:` 前缀，进程一退 cookie 就没了）。
 *
 * 路由（客户端用相对路径 fetch，`dsh-app://app/...` 会被主进程转发到这里）：
 *   GET  /dsh-web-tabs/api/status          → { ok, available, browser, profile }
 *   POST /dsh-web-tabs/api/open  { url }   → { ok, browser } | { ok:false, reason }
 *
 * 内置窗口（真实 Edge 窗口嵌进 DSH 面板，见 embed.js）：
 *   GET  /dsh-web-tabs/api/embed/capability → { ok, browser, mode, profile, titlebar }
 *   GET  /dsh-web-tabs/api/embed/browsers   → { current, browsers:[{id,name,tested,installed,…}] }
 *   GET  /dsh-web-tabs/api/embed/settings   → { settings:{ browserId, profile, titlebar } }
 *   POST /dsh-web-tabs/api/embed/settings   { browserId?, profile?, titlebar? }  切浏览器
 *   GET  /dsh-web-tabs/api/embed/state      → 页签表（url/title/loading/hwnd）
 *   POST /dsh-web-tabs/api/embed/tab        { id, url }
 *   POST /dsh-web-tabs/api/embed/close      { id }
 *   POST /dsh-web-tabs/api/embed/activate   { id }
 *   POST /dsh-web-tabs/api/embed/navigate   { id, url }
 *   POST /dsh-web-tabs/api/embed/reload     { id }
 *   POST /dsh-web-tabs/api/embed/history    { id, delta }
 *   POST /dsh-web-tabs/api/embed/layout     { rect, dpr, visible, activeId }
 *   POST /dsh-web-tabs/api/embed/overlay    { open }
 *   POST /dsh-web-tabs/api/embed/shutdown
 *
 * embed 的两种 profile 模式（由 DSH_WEB_TABS_PROFILE_MODE 选，默认 shared）：
 *   shared   —— 挂到用户自己的 Edge profile，**登录态直接可用**（用户要的就是这个）；
 *               代价：Edge 已在跑 ⇒ 没有 CDP ⇒ 导航靠关窗重开。
 *   isolated —— 插件自己的空 profile，有 CDP，能精确导航/读 URL，但站点里未登录。
 */
import { EdgeEmbedder } from "./embed.js";
import { BASE_ARGS, pickBrowser, describeBrowser, discoverBrowsers } from "./browsers.js";
import { readSettings, writeSettings } from "./settings.js";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

/** 本插件在 webServer 上占的路径前缀。客户端必须用同一个（见 client.js 的 API 常量）。 */
const API_PREFIX = "/dsh-web-tabs/api";
const API_BODY_LIMIT = 8192;

const name = "dsh-web-tabs";
const inject = ["webServer"];

/**
 * app 模式窗口用的 profile 目录。
 *
 * 默认**不指定** `--user-data-dir`：直接用浏览器自己的默认 profile，
 * 已有的 Google 登录态照旧可用，不需要重新登录。
 * 需要隔离环境时设 `DSH_WEB_TABS_APP_PROFILE` 指向一个目录。
 */
function appProfileDir() {
  const explicit = process.env.DSH_WEB_TABS_APP_PROFILE;
  if (explicit && explicit.trim()) return explicit.trim();
  return undefined;
}

/** 只接受 http(s)、无用户名密码的绝对网址 —— 这是唯一能把任意参数送进 argv 的入口。 */
function readTargetUrl(raw) {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text || text.length > 4096) return undefined;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  return parsed.href;
}

/** 页签 id：客户端生成的短串，只用它当 Map 的键，不进 argv。 */
function readId(raw) {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text || text.length > 64) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  return text;
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        fail(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    }
    function onError(error) {
      fail(error);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/**
 * 用 app 模式拉起一个独立窗口。
 *
 * 不等待它退出：detached + stdio:ignore，DSH 关掉也不影响已经开着的窗口。
 * Edge 用同一个 user-data-dir 已经在跑时，新的一次调用会在同一个进程里再开一个
 * app 窗口（共享登录态），正是想要的行为。
 */
function openInAppWindow(url) {
  const picked = pickBrowser();
  const browser = picked.browser ? picked.browser.exe : "";
  if (!browser) return { ok: false, reason: "no-browser" };
  const profile = appProfileDir();
  if (profile) {
    try {
      mkdirSync(profile, { recursive: true });
    } catch (error) {
      return { ok: false, reason: "profile-dir", detail: String((error && error.message) || error) };
    }
  }
  const args = [`--app=${url}`, ...(profile ? [`--user-data-dir=${profile}`] : []), ...BASE_ARGS, "--window-size=1280,900"];
  try {
    const child = spawn(browser, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch (error) {
    return { ok: false, reason: "spawn", detail: String((error && error.message) || error) };
  }
  return { ok: true, browser, profile: profile || null };
}

function apply(ctx) {
  /**
   * 默认 shared：挂到用户自己的 Edge profile 上，登录态直接可用。
   * 想用 CDP 精确导航 / 独立登录态就设 DSH_WEB_TABS_PROFILE_MODE=isolated。
   */
  const mode = process.env.DSH_WEB_TABS_PROFILE_MODE === "isolated" ? "isolated" : "shared";
  /** 懒建：没人用内置窗口就不起 powershell / 不碰浏览器。 */
  let embedder = null;
  function embed() {
    if (!embedder) embedder = new EdgeEmbedder({ mode });
    return embedder;
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: API_PREFIX,
        handler: async (req, res) => {
          const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
          const route = url.pathname.slice(API_PREFIX.length) || "/";
          const method = req.method || "GET";
          try {
            if (method === "GET" && (route === "/status" || route === "/")) {
              const picked = pickBrowser();
              sendJson(res, 200, {
                ok: true,
                available: Boolean(picked.browser),
                browser: picked.browser ? picked.browser.exe : null,
                browserName: picked.browser ? describeBrowser(picked.browser) : null,
                source: picked.source,
                profile: appProfileDir() || null,
              });
              return;
            }
            if (method === "POST" && route === "/open") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const target = readTargetUrl(body && body.url);
              if (!target) {
                sendJson(res, 400, { ok: false, reason: "bad-url" });
                return;
              }
              sendJson(res, 200, openInAppWindow(target));
              return;
            }

            /* ---- 内置窗口 ---- */
            if (method === "GET" && route === "/embed/capability") {
              sendJson(res, 200, embed().capability());
              return;
            }
            /** 选择器要的数据：认识的浏览器全列出来（装没装都列），标出当前正在用的那个。 */
            if (method === "GET" && route === "/embed/browsers") {
              const picked = pickBrowser();
              const saved = readSettings();
              sendJson(res, 200, {
                ok: true,
                current: picked.browser ? picked.browser.id : "",
                currentPath: saved.browserPath || "",
                source: picked.source,
                chosen: saved.browserId || "",
                browsers: discoverBrowsers(),
              });
              return;
            }
            if (method === "GET" && route === "/embed/settings") {
              sendJson(res, 200, { ok: true, settings: readSettings() });
              return;
            }
            /**
             * 切换浏览器 / profile。写盘 + 丢掉当前 embedder（下次用到再按新设置重建），
             * 并等它把现有窗口都关干净 —— 否则旧浏览器的窗口会残留在面板上。
             */
            if (method === "POST" && route === "/embed/settings") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const patch = {};
              if (body && typeof body.browserId === "string") patch.browserId = body.browserId;
              if (body && typeof body.profile === "string") patch.profile = body.profile;
              if (body && typeof body.browserPath === "string") patch.browserPath = body.browserPath;
              if (body && body.titlebar !== undefined) patch.titlebar = body.titlebar;
              // 手填路径要和 browserId 互斥，否则 pickBrowser 不知道该听哪个。
              if (typeof patch.browserPath === "string" && patch.browserPath) patch.browserId = "";
              if (typeof patch.browserId === "string" && patch.browserId) patch.browserPath = "";
              const saved = writeSettings(patch);
              if (embedder) {
                await embedder.dispose().catch(() => undefined);
                embedder = null;
              }
              sendJson(res, 200, { ok: true, settings: saved, capability: embed().capability() });
              return;
            }
            if (method === "GET" && route === "/embed/state") {
              sendJson(res, 200, embed().state());
              return;
            }
            if (method === "POST" && route === "/embed/tab") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const id = readId(body && body.id);
              const target = readTargetUrl(body && body.url);
              if (!id || !target) {
                sendJson(res, 400, { ok: false, reason: "bad-request" });
                return;
              }
              sendJson(res, 200, await embed().openTab(id, target));
              return;
            }
            if (method === "POST" && route === "/embed/close") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const id = readId(body && body.id);
              if (!id) {
                sendJson(res, 400, { ok: false, reason: "bad-request" });
                return;
              }
              sendJson(res, 200, await embed().closeTab(id));
              return;
            }
            if (method === "POST" && route === "/embed/activate") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const id = readId(body && body.id);
              if (!id) {
                sendJson(res, 400, { ok: false, reason: "bad-request" });
                return;
              }
              sendJson(res, 200, await embed().activate(id));
              return;
            }
            if (method === "POST" && route === "/embed/navigate") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const id = readId(body && body.id);
              const target = readTargetUrl(body && body.url);
              if (!id || !target) {
                sendJson(res, 400, { ok: false, reason: "bad-request" });
                return;
              }
              sendJson(res, 200, await embed().navigate(id, target));
              return;
            }
            if (method === "POST" && route === "/embed/reload") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const id = readId(body && body.id);
              if (!id) {
                sendJson(res, 400, { ok: false, reason: "bad-request" });
                return;
              }
              sendJson(res, 200, await embed().reload(id));
              return;
            }
            if (method === "POST" && route === "/embed/history") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              const id = readId(body && body.id);
              const delta = Number(body && body.delta) < 0 ? -1 : 1;
              if (!id) {
                sendJson(res, 400, { ok: false, reason: "bad-request" });
                return;
              }
              sendJson(res, 200, await embed().goHistory(id, delta));
              return;
            }
            if (method === "POST" && route === "/embed/layout") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              embed().setLayout(body || {});
              sendJson(res, 200, { ok: true });
              return;
            }
            if (method === "POST" && route === "/embed/overlay") {
              const body = await readJsonBody(req, API_BODY_LIMIT);
              embed().setOverlay(Boolean(body && body.open));
              sendJson(res, 200, { ok: true });
              return;
            }
            if (method === "POST" && route === "/embed/shutdown") {
              if (embedder) {
                await embedder.dispose().catch(() => undefined);
                embedder = null;
              }
              sendJson(res, 200, { ok: true });
              return;
            }

            sendJson(res, 404, { ok: false, reason: "not-found" });
          } catch (error) {
            sendJson(res, 400, {
              ok: false,
              reason: "bad-request",
              detail: String((error && error.message) || error),
            });
          }
        },
      }),
    "dsh-web-tabs: system browser bridge",
  );

  // 插件被卸载（卸载 profile / 关应用）时，别把浏览器窗口和 powershell 留在世上。
  // 注意返回 promise：SetParent 过的子窗口不会随父窗口一起死，必须等逐个 detach + close 跑完，
  // 否则应用退得快时 DSH 窗口位置会残留一块浏览器画面。
  ctx.effect(
    () => () => {
      if (!embedder) return undefined;
      const dying = embedder;
      embedder = null;
      return dying.dispose().catch(() => undefined);
    },
    "dsh-web-tabs: dispose embedded browser",
  );
}

export { apply, inject, name };

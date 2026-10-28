/**
 * 内置浏览器（真实 Edge 窗口嵌入）——宿主侧实现。
 *
 * 为什么不用 <webview>：
 *   Google 从 2021 年起禁止内嵌浏览器登录（OAuth2 error 400: disallowed_useragent），
 *   而且 DSH 主进程给 guest 分配的 partition 是 `dsh-sidebar-browser-${uuid}`（无 persist:
 *   前缀），进程退出即灰飞烟灭 —— 任何登录态都留不住。
 *
 * 现在这条路：起一个真实的 Edge app 窗口，用 Win32 SetParent 变成 DSH 主窗口的子窗口，
 * 再按面板矩形 MoveWindow 跟随。窗口里跑的是货真价实的 Edge 浏览器上下文：Google 认。
 *
 * 两种 profile 模式（决定登录态从哪来）：
 *   shared（默认）—— 不传 --user-data-dir，用 `--profile-directory=Default` 挂到用户
 *     自己的 Edge profile 上。好处：用户已有的登录态（ChatGPT / Claude / X …）直接可用。
 *     代价：Edge 已在运行时 Chromium 会忽略 --remote-debugging-port，所以这个模式没有
 *     CDP ⇒ 导航靠「关掉窗口 + 用新网址重开」（登录态在 profile 里，不丢），也读不到
 *     页面真实 URL，只能靠窗口标题回填。
 *   isolated —— 传 --user-data-dir 用插件自己的 profile，有 CDP，能精确导航/读 URL/
 *     前进后退，但那个 profile 是空的 ⇒ 站点里全是未登录状态。
 *
 * 分三层：
 *   1. WinHelper —— 常驻 powershell 跑 native/win.ps1（JSON-lines），做 adopt/follow/clip/hide
 *   2. Cdp       —— 浏览器级 WebSocket 客户端（仅 isolated 模式）
 *   3. EdgeEmbedder —— 把「页签」映射成「Edge app 窗口 + hwnd」；isolated 模式再加 CDP target
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import {
  BASE_ARGS,
  BROWSERS,
  DEFAULT_TITLEBAR,
  pickBrowser,
  browserById,
  browserExeCandidates,
  describeBrowser,
  missingBrowserDetail,
} from "./browsers.js";
import { dataDir as settingsDataDir, readSettings } from "./settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN_PS1 = join(HERE, "..", "native", "win.ps1");

/**
 * Chromium app 窗口自绘的标题条高度（像素）。
 * 优先级：环境变量 > settings.json > 默认 30（按 Edge/Chromium 量的）。
 */
function resolveTitlebar() {
  const env = Number(process.env.DSH_WEB_TABS_TITLEBAR);
  if (env > 0) return env;
  const saved = Number(readSettings().titlebar);
  if (saved > 0) return saved;
  return DEFAULT_TITLEBAR;
}
const TITLEBAR = resolveTitlebar();

const PORT_FIRST = Number(process.env.DSH_WEB_TABS_CDP_PORT || 9300) || 9300;
const PORT_LAST = PORT_FIRST + 99;

const STARTUP_TIMEOUT = 25000;
const NAV_TIMEOUT = 40000;

/* ------------------------------------------------------------------ util */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error) {
  if (!error) return "unknown";
  if (typeof error === "string") return error;
  return String(error.message || error);
}

/** 所有候选可执行文件路径（只为报错/测试保留）。 */
function browserCandidates() {
  const out = [];
  for (const entry of BROWSERS) {
    for (const path of browserExeCandidates(entry)) out.push(path);
  }
  return out;
}

/**
 * 选浏览器 —— 逻辑全在 browsers.js（配置表 + `DSH_WEB_TABS_BROWSER` + 最近使用时间）。
 * 这里只保留一个薄封装，让老调用方（test/live-embed-shared.mjs 等）继续能用。
 */
export function findBrowser() {
  const picked = pickBrowser();
  return picked.browser ? picked.browser.exe : "";
}

/** 完整的挑选结果：`{ browser, source, checked }`。capability() 用它报出原因。 */
export function resolveBrowser() {
  return pickBrowser();
}

export function dataDir() {
  return settingsDataDir();
}

export function profileDir() {
  return process.env.DSH_WEB_TABS_APP_PROFILE || join(dataDir(), "web-tabs", "app-browser");
}

function stateFile() {
  return join(dataDir(), "web-tabs", "embed-state.json");
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeState(value) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(value, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function clearState() {
  try {
    rmSync(stateFile(), { force: true });
  } catch {
    /* ignore */
  }
}

function probeUrl(marker) {
  const html =
    `<!doctype html><meta charset="utf-8"><title>${marker}</title>` +
    `<style>html,body{margin:0;height:100%;background:#101014;color:#6b6b7a;` +
    `font:13px system-ui,"Segoe UI",sans-serif;display:flex;align-items:center;` +
    `justify-content:center}</style><body>${marker}</body>`;
  return "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
}

/**
 * 共享 profile 模式的起手页：标题写唯一 marker（用来精确配对 hwnd），页面里的脚本
 * 过一小会儿把顶层文档替换成真正的目标网址 —— 「配对」和「导航」都不需要调试协议。
 */
function handoffUrl(marker, target, delayMs) {
  const html =
    `<!doctype html><meta charset="utf-8"><title>${marker}</title>` +
    `<style>html,body{margin:0;height:100%;background:#101014;color:#6b6b7a;` +
    `font:13px system-ui,"Segoe UI",sans-serif;display:flex;align-items:center;` +
    `justify-content:center}</style><body>正在打开…</body>` +
    `<script>setTimeout(function(){try{location.replace(${JSON.stringify(target)})}catch(e){}},` +
    `${Math.max(200, Number(delayMs) || 1800)})</script>`;
  return "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
}

function normalizeUrl(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : "https://" + text);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password) return "";
  return parsed.href;
}

async function freePort() {
  for (let port = PORT_FIRST; port <= PORT_LAST; port += 1) {
    const ok = await new Promise((resolve) => {
      const server = createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  return 0;
}

/**
 * 找出正占用本插件 profile 目录的浏览器主进程。
 *
 * 为什么必须清：Chromium 用 `--user-data-dir` 独占 profile。第二次带不同参数
 * （比如我们这次要的 --remote-debugging-port）启动时，它会把命令行转发给已有实例
 * 然后自己立刻退出 —— 于是调试端口永远不会出现，表现为「浏览器调试端口未就绪」。
 * 早先探测留下的实例就是这么把路堵死的。
 */
function profileOwners(profile, processNames) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    const names = (processNames && processNames.length ? processNames : ["msedge.exe"]).map((name) =>
      String(name).replace(/'/g, "''"),
    );
    const filter = names.map((name) => `Name='${name}'`).join(" OR ");
    const escaped = String(profile).replace(/'/g, "''");
    const script =
      `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      "Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and " +
      `$_.CommandLine -like '*${escaped}*' } | ` +
      "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) return resolve([]);
        const rows = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const index = line.indexOf("|");
          if (index <= 0) continue;
          const pid = Number(line.slice(0, index).trim());
          if (!pid) continue;
          rows.push({ pid, commandLine: line.slice(index + 1) });
        }
        resolve(rows);
      },
    );
  });
}

async function closeStaleProfileBrowsers(profile, keepPort, processNames) {
  const owners = await profileOwners(profile, processNames);
  const victims = owners.filter((row) => {
    if (!keepPort) return true;
    return row.commandLine.indexOf("--remote-debugging-port=" + keepPort) < 0;
  });
  if (!victims.length) return [];
  const pids = victims.map((row) => row.pid);
  await new Promise((resolve) => {
    const script = pids.map((pid) => `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`).join("; ");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 12000 },
      () => resolve(),
    );
  });
  // 等进程真的退掉，否则紧接着的启动仍会撞 profile 锁
  const deadline = Date.now() + 6000;
  let alive = victims.map((row) => row.pid);
  while (Date.now() < deadline && alive.length) {
    const still = await profileOwners(profile, processNames);
    const stillIds = new Set(still.map((row) => row.pid));
    alive = alive.filter((pid) => stillIds.has(pid));
    if (alive.length) await sleep(250);
  }
  return pids;
}

/* ------------------------------------------------------------- WinHelper */

/**
 * 常驻 powershell，跑 native/win.ps1。协议是一行 JSON 请求 / 一行 JSON 应答。
 * 命令串行发送（管道只能一问一答），进程死了下次 send 自动重启。
 */
export class WinHelper {
  constructor(scriptPath) {
    this.scriptPath = scriptPath || WIN_PS1;
    this.child = null;
    this.queue = Promise.resolve();
    this.pending = null;
    this.buffer = "";
  }

  async start() {
    if (this.child) return;
    if (!existsSync(this.scriptPath)) throw new Error("找不到 native/win.ps1：" + this.scriptPath);
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      /* win.ps1 只在崩溃时写 stderr，忽略噪音 */
    });
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.on("exit", () => {
      this.child = null;
      this.failPending("win.ps1 进程退出");
    });
    // 首行是 {"ok":true,"ready":true}
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("win.ps1 启动超时")), 20000);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (this.readyResolve) {
        const resolve = this.readyResolve;
        this.readyResolve = null;
        this.readyReject = null;
        resolve();
        continue;
      }
      const pending = this.pending;
      this.pending = null;
      if (!pending) continue;
      clearTimeout(pending.timer);
      try {
        pending.resolve(JSON.parse(line));
      } catch (error) {
        pending.resolve({ ok: false, reason: "parse", detail: describeError(error) });
      }
    }
  }

  failPending(reason) {
    if (this.readyReject) {
      const reject = this.readyReject;
      this.readyResolve = null;
      this.readyReject = null;
      reject(new Error(reason));
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  /** 发一条命令，返回应答对象。 */
  send(command, timeoutMs) {
    const run = async () => {
      await this.start();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.timer === timer) this.pending = null;
          reject(new Error("win.ps1 命令超时：" + String(command && command.op)));
        }, timeoutMs || 8000);
        this.pending = { resolve, reject, timer };
        try {
          this.child.stdin.write(JSON.stringify(command) + "\n");
        } catch (error) {
          clearTimeout(timer);
          this.pending = null;
          reject(error);
        }
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 200);
  }
}

/* ------------------------------------------------------------------- Cdp */

export class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      const Impl = globalThis.WebSocket;
      if (typeof Impl !== "function") {
        reject(new Error("当前 Node 不支持 WebSocket（需要 Node 22+）"));
        return;
      }
      let socket;
      try {
        socket = new Impl(this.url);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = socket;
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), timeoutMs || 15000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(this);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP 连接失败"));
      });
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("close", () => {
        this.closed = true;
        this.rejectAll("CDP 连接已关闭");
      });
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "CDP 错误"));
      else entry.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const key = (message.sessionId || "") + "|" + message.method;
    const set = this.listeners.get(key);
    if (!set) return;
    for (const handler of Array.from(set)) {
      try {
        handler(message.params);
      } catch {
        /* ignore */
      }
    }
  }

  rejectAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  on(sessionId, method, handler) {
    const key = (sessionId || "") + "|" + method;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(handler);
    return () => {
      const set = this.listeners.get(key);
      if (set) set.delete(handler);
    };
  }

  send(method, params, sessionId, timeoutMs) {
    if (this.closed) return Promise.reject(new Error("CDP 已断开"));
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP 超时：" + method));
      }, timeoutMs || 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------- EdgeEmbedder */

export class EdgeEmbedder {
  constructor(options) {
    const settings = options || {};
    /** "shared" = 用用户自己的浏览器 profile（有登录态，无 CDP）；"isolated" = 插件自己的 profile（无登录态，有 CDP）。 */
    this.mode = settings.mode === "isolated" ? "isolated" : "shared";
    this.profile = this.mode === "isolated" ? settings.profile || profileDir() : "";
    /**
     * 浏览器：优先用调用方给的（测试用假对象），否则按 browsers.js 的规则挑一个。
     * 挑不到时 `this.browser` 是 null，`this.browserMiss` 里记着「找了哪些路径」。
     */
    const resolved = settings.browserInfo
      ? { browser: settings.browserInfo, source: "given", checked: [] }
      : resolveBrowser();
    this.browserInfo = resolved.browser || null;
    this.browserSource = resolved.source || "";
    this.browserMiss = resolved.checked || [];
    this.browser = (resolved.browser && resolved.browser.exe) || "";
    /**
     * profile 目录名（`Default` / `Profile 1` …）。
     * 以前写死 `Default` —— 主 profile 不是 Default 的机器会打开一个空 profile、没有登录态。
     * 现在默认取浏览器 `Local State` 里的 `last_used`，那才是用户自己那个。
     */
    this.profileDirectory =
      typeof settings.profileDirectory === "string" && settings.profileDirectory
        ? settings.profileDirectory
        : process.env.DSH_WEB_TABS_PROFILE_DIRECTORY ||
          (resolved.browser && resolved.browser.profileDirectory) ||
          "Default";
    this.profileLabel =
      (resolved.browser &&
        resolved.browser.profiles &&
        resolved.browser.profiles.find((item) => item.dir === this.profileDirectory)?.name) ||
      "";
    this.titlebar = settings.titlebar || TITLEBAR;
    this.helper = new WinHelper(settings.winScript);
    this.ownerPid = Number(settings.ownerPid) || 0;
    this.cdp = null;
    this.port = 0;
    this.owner = 0;
    this.ownerCheckedAt = 0;
    this.tabs = new Map();
    this.activeId = null;
    this.rect = null;
    this.visible = false;
    this.overlayOpen = false;
    this.ticking = false;
    this.timer = null;
    this.lastError = "";
    this.lastSync = 0;
  }

  /* ---- capability ---------------------------------------------------- */

  /** 这个浏览器的主进程名（`msedge.exe` / `chrome.exe`）—— 清残留进程时按它筛。 */
  processNames() {
    if (this.browserInfo && this.browserInfo.processNames && this.browserInfo.processNames.length) {
      return this.browserInfo.processNames.slice();
    }
    return [];
  }

  capability() {
    if (process.platform !== "win32") {
      return { ok: false, reason: "platform", detail: "内置窗口目前只支持 Windows" };
    }
    if (!this.browser) {
      return {
        ok: false,
        reason: "no-browser",
        detail: missingBrowserDetail(this.browserMiss),
        checked: this.browserMiss.map((item) => item.path),
        envHint: "装了别的 Chromium 浏览器就设 DSH_WEB_TABS_BROWSER=<可执行文件绝对路径>",
      };
    }
    if (!existsSync(this.helper.scriptPath)) {
      return {
        ok: false,
        reason: "no-helper",
        detail: "缺少 native/win.ps1（插件安装不完整，重新安装插件即可）",
        expected: this.helper.scriptPath,
      };
    }
    return {
      ok: true,
      browser: this.browser,
      browserId: this.browserInfo ? this.browserInfo.id : "",
      browserName: this.browserInfo ? describeBrowser(this.browserInfo) : "",
      browserTested: this.browserInfo ? this.browserInfo.tested !== false : false,
      browserSource: this.browserSource,
      mode: this.mode,
      profile: this.mode === "isolated" ? this.profile : "system",
      profileDirectory: this.profileDirectory,
      profileName: this.profileLabel,
      titlebar: this.titlebar,
    };
  }

  /* ---- owner (DSH 主窗口) -------------------------------------------- */

  async ensureOwner(force) {
    const now = Date.now();
    if (!force && this.owner && now - this.ownerCheckedAt < 8000) return this.owner;
    const candidates = [];
    if (this.ownerPid) candidates.push(this.ownerPid);
    try {
      candidates.push(process.ppid);
    } catch {
      /* ignore */
    }
    if (process.env.DSH_WEB_TABS_OWNER_PID) {
      candidates.push(Number(process.env.DSH_WEB_TABS_OWNER_PID));
    }
    for (const pid of candidates) {
      if (!pid) continue;
      try {
        const answer = await this.helper.send({ op: "findhost", pid: Number(pid) });
        const hwnd = Number(answer && answer.hwnd);
        if (hwnd > 0) {
          this.owner = hwnd;
          this.ownerCheckedAt = now;
          return hwnd;
        }
      } catch {
        /* try next */
      }
    }
    return 0;
  }

  /* ---- browser ------------------------------------------------------- */

  async endpointAlive(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body && body.webSocketDebuggerUrl ? body : null;
    } catch {
      return null;
    }
  }

  async ensureCdp() {
    if (this.cdp && !this.cdp.closed) return this.cdp;
    this.cdp = null;

    // 先看是否有残留的浏览器实例（上次 DSH 崩溃/重启留下的）
    const saved = readState();
    if (saved && saved.port) {
      const alive = await this.endpointAlive(saved.port);
      if (alive) {
        try {
          const cdp = await new Cdp(alive.webSocketDebuggerUrl).connect();
          const version = await cdp.send("Browser.getVersion", {}, undefined, 5000);
          if (version && /Chrom|Edg/i.test(String(version.product || ""))) {
            this.cdp = cdp;
            this.port = saved.port;
            return cdp;
          }
          cdp.close();
        } catch {
          /* fall through */
        }
      }
    }

    // 起一个新的
    const port = await freePort();
    if (!port) throw new Error("没有可用的调试端口");
    const profile = this.profile;
    try {
      mkdirSync(profile, { recursive: true });
    } catch (error) {
      throw new Error("无法创建 profile 目录：" + describeError(error));
    }
    // 清掉独占这个 profile、又没有调试端口的残留实例，否则新启动会转发给它后退出
    const killed = await closeStaleProfileBrowsers(profile, 0, this.processNames());
    if (killed.length) {
      this.lastError = "清理了占用 profile 的残留浏览器进程：" + killed.join(",");
    }
    const args = [
      `--app=${probeUrl("dshwt-boot-" + Date.now().toString(36))}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--window-size=800,600",
      "--window-position=-24000,-24000",
      ...BASE_ARGS,
    ];
    const child = spawn(this.browser, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();

    const deadline = Date.now() + STARTUP_TIMEOUT;
    let lastDetail = "";
    while (Date.now() < deadline) {
      const alive = await this.endpointAlive(port);
      if (alive) {
        try {
          const cdp = await new Cdp(alive.webSocketDebuggerUrl).connect();
          this.cdp = cdp;
          this.port = port;
          writeState({ port, profile, at: new Date().toISOString() });
          return cdp;
        } catch (error) {
          lastDetail = describeError(error);
        }
      }
      await sleep(300);
    }
    throw new Error("浏览器调试端口未就绪" + (lastDetail ? "：" + lastDetail : ""));
  }

  /** 起一个 app 窗口（isolated 模式：带 CDP；shared 模式：挂用户 profile）。 */
  async spawnWindow(marker, url) {
    const start = url || probeUrl(marker);
    const args = [`--app=${start}`];
    if (this.mode === "isolated") {
      args.push(`--user-data-dir=${this.profile}`, `--remote-debugging-port=${this.port}`);
    } else if (this.profileDirectory) {
      // 关键：不传 --user-data-dir 才能复用用户已在跑的浏览器及其登录态。
      // 此时 Chromium 会把命令行转发给已存在的实例，所以 --remote-debugging-port 无效（不走 CDP）。
      // `--profile-directory` 必须给：多 profile 的机器不给会弹 profile 选择器。
      args.push(`--profile-directory=${this.profileDirectory}`);
    }
    args.push("--window-size=900,650", "--window-position=-24000,-24000", ...BASE_ARGS);
    const child = spawn(this.browser, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return start;
  }

  async findTarget(marker, timeoutMs) {
    const cdp = await this.ensureCdp();
    const deadline = Date.now() + (timeoutMs || STARTUP_TIMEOUT);
    while (Date.now() < deadline) {
      let targets = [];
      try {
        const result = await cdp.send("Target.getTargets");
        targets = (result && result.targetInfos) || [];
      } catch {
        await sleep(250);
        continue;
      }
      const hit = targets.find(
        (item) =>
          item.type === "page" &&
          (String(item.url || "").indexOf(marker) >= 0 || String(item.title || "") === marker),
      );
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  }

  async findHwnd(marker, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || STARTUP_TIMEOUT);
    while (Date.now() < deadline) {
      try {
        const answer = await this.helper.send({ op: "list" });
        const hit = (answer.windows || []).find((item) =>
          String(item.title || "").includes(marker),
        );
        if (hit) return Number(hit.hwnd);
      } catch {
        /* retry */
      }
      await sleep(250);
    }
    return 0;
  }

  async attach(targetId) {
    const cdp = await this.ensureCdp();
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached && attached.sessionId;
    if (!sessionId) throw new Error("attach 失败");
    await cdp.send("Page.enable", {}, sessionId).catch(() => undefined);
    return sessionId;
  }

  /* ---- tab lifecycle ------------------------------------------------- */

  /** 当前屏幕上已存在的窗口句柄集合（用来做差集找新窗口）。 */
  async snapshotHandles() {
    try {
      const answer = await this.helper.send({ op: "snap" });
      return new Set((answer.windows || []).map(Number));
    } catch {
      return new Set();
    }
  }

  /**
   * shared 模式的窗口配对：新启动的 app 窗口不会出现在 CDP 里。
   * 先用 snap 差集圈出新窗口，再用标题里的 marker 二次确认。
   */
  async pairSharedWindow(before, marker, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || STARTUP_TIMEOUT);
    while (Date.now() < deadline) {
      let windows = [];
      try {
        const answer = await this.helper.send({ op: "list" });
        windows = answer.windows || [];
      } catch {
        await sleep(250);
        continue;
      }
      const fresh = windows.filter((item) => !before.has(Number(item.hwnd)));
      if (!fresh.length) {
        await sleep(250);
        continue;
      }
      const byMarker = fresh.find((item) => String(item.title || "").includes(marker));
      if (byMarker) return Number(byMarker.hwnd);
      // marker 已经跳转掉了（1800ms 内页面就换掉了标题），退一步取新出现的 Chromium 窗口
      const byClass = fresh.find((item) => String(item.cls || "") === "Chrome_WidgetWin_1");
      if (byClass) return Number(byClass.hwnd);
      await sleep(250);
    }
    return 0;
  }

  /** 把 hwnd 嵌进 DSH 主窗口（先藏屏幕外，tick 再按矩形摆位）。 */
  async adoptWindow(tab) {
    await this.helper.send({ op: "hide", hwnd: tab.hwnd }).catch(() => undefined);
    const owner = await this.ensureOwner(true);
    if (!owner) throw new Error("找不到 DSH 主窗口");
    await this.helper.send({
      op: "adopt",
      hwnd: tab.hwnd,
      owner,
      x: -24000,
      y: -24000,
      w: 900,
      h: 650,
    });
    tab.adopted = true;
    await this.probeTitlebar(tab.hwnd).catch(() => undefined);
  }

  /**
   * 量一下这个浏览器 app 窗口到底自绘了多高的标题条。
   *
   * Edge 的 app 窗口 UIA 树里没有 Document 后代（量不出来），所以这里只当「有就更好」：
   * Chrome / Brave 之类如果给了 Document，就能拿到真实高度，省得用户手动调。
   * 量不到就保留配置里的默认值（按逻辑 px 记，tick 里乘 dpr）。
   *
   * 注意单位：UIA 的 BoundingRectangle 是**物理像素**，所以量到的值单独存进
   * `titlebarPhysical`，tick 里优先用它；`this.titlebar` 始终是逻辑 px。
   */
  async probeTitlebar(hwnd) {
    if (!hwnd || this.titlebarProbed) return;
    this.titlebarProbed = true;
    let answer = null;
    try {
      answer = await this.helper.send({ op: "content", hwnd }, 4000);
    } catch {
      return;
    }
    const caption = Number(answer && answer.caption);
    if (!Number.isFinite(caption) || caption <= 0 || caption > 120) return;
    // 只在用户没手工设过的时候覆盖（环境变量 / settings.json 优先级更高）。
    const env = Number(process.env.DSH_WEB_TABS_TITLEBAR);
    const saved = Number(readSettings().titlebar);
    if (env > 0 || saved > 0) return;
    this.titlebarPhysical = Math.round(caption);
    this.titlebarAuto = true;
  }

  /** shared 模式：关掉旧窗口、用 startedUrl 重开一个，再把新窗口嵌回去（登录态在 profile 里，不会丢）。 */
  async reopenShared(tab, task) {
    const before = await this.snapshotHandles();
    await this.destroyTabWindow(tab);
    const marker = "dshwt-" + String(tab.id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) + "-" + Date.now().toString(36);
    const startedUrl = task(marker);
    await this.spawnWindow(marker, startedUrl);
    const hwnd = await this.pairSharedWindow(before, marker, STARTUP_TIMEOUT);
    if (!hwnd) throw new Error("找不到新开的浏览器窗口");
    tab.hwnd = hwnd;
    tab.marker = marker;
    tab.startedUrl = startedUrl;
    tab.noHistory = task === this.toUrlStart;
    await this.adoptWindow(tab);
    return hwnd;
  }

  /** 构造启动页：先展示 marker、再自跳转到目标网址。 */
  toUrlStart = (marker, url) => handoffUrl(marker, url, 1600);

  async openTab(id, rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return { ok: false, reason: "bad-url" };
    const capability = this.capability();
    if (!capability.ok) return { ok: false, ...capability };
    if (this.tabs.has(id)) return { ok: true, reused: true };

    const marker = "dshwt-" + String(id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) + "-" + Date.now().toString(36);
    const tab = {
      id,
      marker,
      url,
      startedUrl: "",
      origin: url,
      title: "",
      hwnd: 0,
      targetId: "",
      sessionId: "",
      loading: true,
      shown: false,
      adopted: false,
      clipW: 0,
      clipH: 0,
      createdAt: Date.now(),
    };
    this.tabs.set(id, tab);
    // 循环必须现在就起：shared 模式没有 CDP，标题/加载态完全靠 tick 里的 syncMeta 回填。
    this.ensureTimer();

    try {
      if (this.mode === "shared") {
        const before = await this.snapshotHandles();
        const start = handoffUrl(marker, url, 1600);
        tab.startedUrl = start;
        await this.spawnWindow(marker, start);
        const hwnd = await this.pairSharedWindow(before, marker, STARTUP_TIMEOUT);
        if (!hwnd) throw new Error("找不到新开的浏览器窗口");
        tab.hwnd = hwnd;
        await this.adoptWindow(tab);
        return { ok: true, hwnd: tab.hwnd, mode: this.mode };
      }

      await this.ensureCdp();
      await this.spawnWindow(marker);
      const target = await this.findTarget(marker, STARTUP_TIMEOUT);
      if (!target) throw new Error("窗口没有出现在 CDP 目标里");
      tab.targetId = target.targetId;
      tab.sessionId = await this.attach(target.targetId);
      this.watchSession(tab);

      tab.hwnd = await this.findHwnd(marker, STARTUP_TIMEOUT);
      if (!tab.hwnd) throw new Error("找不到窗口句柄");

      await this.adoptWindow(tab);
      await this.navigateTab(tab, url);
      return { ok: true, hwnd: tab.hwnd, mode: this.mode };
    } catch (error) {
      const detail = describeError(error);
      this.tabs.delete(id);
      await this.destroyTabWindow(tab).catch(() => undefined);
      return { ok: false, reason: "open-failed", detail };
    }
  }

  watchSession(tab) {
    const cdp = this.cdp;
    if (!cdp || !tab.sessionId) return;
    cdp.on(tab.sessionId, "Page.loadEventFired", () => {
      tab.loading = false;
      this.lastSync = 0;
    });
    cdp.on(tab.sessionId, "Page.frameNavigated", (params) => {
      const frame = params && params.frame;
      if (!frame || frame.parentId) return;
      if (frame.url && /^https?:/i.test(frame.url)) {
        tab.url = frame.url;
        this.lastSync = 0;
      }
    });
    cdp.on(tab.sessionId, "Page.frameStartedLoading", () => {
      tab.loading = true;
    });
    cdp.on(tab.sessionId, "Inspector.detached", () => {
      tab.sessionId = "";
    });
  }

  async navigateTab(tab, url) {
    const cdp = await this.ensureCdp();
    if (!tab.sessionId) tab.sessionId = await this.attach(tab.targetId);
    tab.loading = true;
    tab.url = url;
    const result = await cdp.send("Page.navigate", { url }, tab.sessionId, NAV_TIMEOUT);
    if (result && result.errorText) {
      tab.loading = false;
      return { ok: false, reason: "navigate", detail: result.errorText };
    }
    this.lastSync = 0;
    return { ok: true };
  }

  async navigate(id, rawUrl) {
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false, reason: "no-tab" };
    const url = normalizeUrl(rawUrl);
    if (!url) return { ok: false, reason: "bad-url" };
    if (this.mode === "shared") {
      // 没有 CDP，只能「关窗 + 用新网址重开」。登录态在用户的 Edge profile 里，不会丢。
      try {
        tab.loading = true;
        tab.url = url;
        tab.origin = url;
        tab.title = "";
        await this.reopenShared(tab, (marker) => handoffUrl(marker, url, 1600));
        this.lastSync = 0;
        return { ok: true };
      } catch (error) {
        tab.loading = false;
        return { ok: false, reason: "navigate", detail: describeError(error) };
      }
    }
    try {
      return await this.navigateTab(tab, url);
    } catch (error) {
      return { ok: false, reason: "navigate", detail: describeError(error) };
    }
  }

  async reload(id) {
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false, reason: "no-tab" };
    if (this.mode === "shared") {
      try {
        tab.loading = true;
        await this.reopenShared(tab, (marker) => (tab.startedUrl ? tab.startedUrl : handoffUrl(marker, tab.url, 1600)));
        return { ok: true };
      } catch (error) {
        tab.loading = false;
        return { ok: false, reason: "reload", detail: describeError(error) };
      }
    }
    try {
      const cdp = await this.ensureCdp();
      if (!tab.sessionId) tab.sessionId = await this.attach(tab.targetId);
      tab.loading = true;
      await cdp.send("Page.reload", { ignoreCache: false }, tab.sessionId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "reload", detail: describeError(error) };
    }
  }

  async goHistory(id, delta) {
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false, reason: "no-tab" };
    if (this.mode === "shared") {
      // 没有 CDP 就读不到真实历史栈。只能退一步：后退=回到本页签初始网址。
      if (delta >= 0) return { ok: false, reason: "no-history" };
      try {
        tab.loading = true;
        tab.url = tab.origin || tab.url;
        await this.reopenShared(tab, (marker) => handoffUrl(marker, tab.origin || tab.url, 1600));
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "history", detail: describeError(error) };
      }
    }
    try {
      const cdp = await this.ensureCdp();
      if (!tab.sessionId) tab.sessionId = await this.attach(tab.targetId);
      const history = await cdp.send("Page.getNavigationHistory", {}, tab.sessionId);
      const entries = (history && history.entries) || [];
      const target = history.currentIndex + delta;
      if (target < 0 || target >= entries.length) return { ok: false, reason: "no-history" };
      tab.loading = true;
      await cdp.send(
        "Page.navigateToHistoryEntry",
        { entryId: entries[target].id },
        tab.sessionId,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "history", detail: describeError(error) };
    }
  }

  async activate(id) {
    if (!this.tabs.has(id)) return { ok: false, reason: "no-tab" };
    this.activeId = id;
    return { ok: true };
  }

  async destroyTabWindow(tab) {
    if (!tab) return;
    if (tab.hwnd) {
      // 顺序很重要：窗口一旦被 SetParent 成 DSH 的子窗口，PostMessage(WM_CLOSE) 就不再生效
      // （实测：子状态下 close 返回 ok 但 IsWindow 仍为真）。必须先 detach 恢复成顶层窗口再关，
      // 否则关页签/退出后 DSH 窗口里会残留一片浏览器截图。
      await this.helper.send({ op: "hide", hwnd: tab.hwnd }).catch(() => undefined);
      await this.helper.send({ op: "detach", hwnd: tab.hwnd }).catch(() => undefined);
      await this.helper.send({ op: "close", hwnd: tab.hwnd }).catch(() => undefined);
      tab.adopted = false;
      tab.hwnd = 0;
    }
    if (tab.targetId) {
      try {
        const cdp = this.cdp;
        if (cdp && !cdp.closed) {
          await cdp.send("Target.closeTarget", { targetId: tab.targetId }, undefined, 5000);
        }
      } catch {
        /* ignore */
      }
    }
  }

  async closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return { ok: true };
    this.tabs.delete(id);
    if (this.activeId === id) {
      const next = this.tabs.keys().next();
      this.activeId = next.done ? null : next.value;
    }
    await this.destroyTabWindow(tab);
    this.lastSync = 0;
    return { ok: true };
  }

  /* ---- layout -------------------------------------------------------- */

  /**
   * 原生子窗口永远盖在 DOM 之上（它不属于浏览器合成层），所以菜单/弹窗这种要浮在
   * 面板内容之上的东西一打开，就得把嵌入窗口藏起来，否则会被盖住。
   */
  setOverlay(open) {
    const next = Boolean(open);
    if (this.overlayOpen === next) return;
    this.overlayOpen = next;
    this.lastSync = 0;
  }

  /** 启动布局/元信息循环（幂等）。shared 模式没有 CDP，标题回填也靠这个循环里的 syncMeta。 */
  ensureTimer() {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 90);
    return this.timer;
  }

  setLayout(input) {
    const payload = input || {};
    if (payload.activeId !== undefined) this.activeId = payload.activeId;
    this.visible = payload.visible !== false;
    const rect = payload.rect;
    if (!rect) {
      this.rect = null;
    } else {
      const dpr = Number(payload.dpr) > 0 ? Number(payload.dpr) : 1;
      const width = Number(rect.width);
      const height = Number(rect.height);
      if (width > 0 && height > 0) {
        this.rect = {
          x: Number(rect.x) || 0,
          y: Number(rect.y) || 0,
          width,
          height,
          dpr,
        };
      } else {
        this.rect = null;
      }
    }
    this.ensureTimer();
    return { ok: true };
  }

  async tick() {
    if (this.ticking) return;
    if (!this.tabs.size) return;
    this.ticking = true;
    try {
      const owner = await this.ensureOwner(false);
      if (!owner) return;
      const active = this.activeId ? this.tabs.get(this.activeId) : null;
      for (const tab of this.tabs.values()) {
        if (!tab.hwnd || !tab.adopted) continue;
        const isActive = tab === active && this.visible && this.rect && !this.overlayOpen;
        if (isActive) {
          const dpr = this.rect.dpr || 1;
          /**
           * 标题条高度也要按 DPI 缩放：Chromium 的非客户区是物理像素画的，
           * 100% 缩放时 30px，125% 就是 ~38px，150% 就是 45px。
           * 以前这里用固定的 this.titlebar（逻辑 px），在非 100% 缩放的机器上
           * 会少留 10~15px，导致页面顶部被切掉一截 —— 这是换机器最容易踩的坑。
           * 如果 UIA 量到了真实值（物理像素），直接用那个，比推算更准。
           */
          const bar =
            this.titlebarPhysical > 0
              ? Math.round(this.titlebarPhysical)
              : Math.max(0, Math.round(this.titlebar * dpr));
          const x = Math.round(this.rect.x * dpr);
          const y = Math.round(this.rect.y * dpr) - bar;
          const w = Math.max(160, Math.round(this.rect.width * dpr));
          const h = Math.max(120, Math.round(this.rect.height * dpr)) + bar;
          await this.helper.send(
            { op: "follow", hwnd: tab.hwnd, owner, x, y, w, h, visible: true },
            6000,
          );
          tab.shown = true;
          if (tab.clipW !== w || tab.clipH !== h || tab.clipBar !== bar) {
            await this.helper.send({
              op: "clip",
              hwnd: tab.hwnd,
              left: 0,
              top: bar,
              right: w,
              bottom: h,
            });
            tab.clipW = w;
            tab.clipH = h;
            tab.clipBar = bar;
          }
        } else if (tab.shown !== false) {
          await this.helper.send({ op: "hide", hwnd: tab.hwnd });
          tab.shown = false;
        }
      }
      await this.syncMeta();
    } catch (error) {
      this.lastError = describeError(error);
    } finally {
      this.ticking = false;
    }
  }

  /** 从 CDP target 列表刷新 url / title。 */
  async syncMeta() {
    const now = Date.now();
    if (now - this.lastSync < 700) return;
    this.lastSync = now;

    // shared 模式没有 CDP，只能用窗口标题回填（Chromium app 窗口标题就是页面 title）。
    if (this.mode === "shared") {
      /**
       * 必须先注意：窗口被 SetParent 之后就不再是顶层窗口，win.ps1 的 `list` / `snap`
       * （EnumWindows）完全看不到它们。所以这里只能按 hwnd 用 `info`（GetWindowText）逐个查。
       */
      for (const tab of this.tabs.values()) {
        if (!tab.hwnd) continue;
        let info = null;
        try {
          const answer = await this.helper.send({ op: "info", hwnd: tab.hwnd }, 4000);
          info = answer && answer.info;
        } catch {
          continue;
        }
        if (!info) continue;
        const title = String(info.title || "");
        if (!title) continue;
        // marker 还在 ⇒ 页面还没跳转完
        if (title.indexOf(tab.marker) >= 0) {
          tab.loading = true;
          continue;
        }
        // data: 起手页没有真正的 <title>，Chromium 会把 URL 本身当窗口标题
        // （形如 `_text/html;base64,PCFkb2N0eXBl...`）。这种要当成「还在加载」，
        // 绝不能回填成页签标题，否则界面会显示一大串 base64。
        const stripped = title.replace(/^_/, "");
        if (/^(text\/html|data:)/i.test(stripped) || stripped.indexOf("base64,") >= 0) {
          tab.loading = true;
          continue;
        }
        // Chromium app 窗口的标题格式是 `页面标题_/路径`，尾巴上会拼路径
        const clean = title.replace(/_\/.*$/, "").replace(/_\/$/, "").trim();
        if (clean) tab.title = clean;
        tab.loading = false;
      }
      return;
    }

    const cdp = this.cdp;
    if (!cdp || cdp.closed) return;
    let targets = [];
    try {
      const result = await cdp.send("Target.getTargets");
      targets = (result && result.targetInfos) || [];
    } catch {
      return;
    }
    const byId = new Map(targets.map((item) => [item.targetId, item]));
    for (const tab of this.tabs.values()) {
      const info = byId.get(tab.targetId);
      if (!info) continue;
      if (info.url && /^https?:/i.test(info.url)) tab.url = info.url;
      if (info.title) tab.title = info.title;
      if (info.url && info.url.indexOf(tab.marker) >= 0) tab.loading = true;
    }
  }

  /* ---- state --------------------------------------------------------- */

  state() {
    const tabs = [];
    for (const tab of this.tabs.values()) {
      tabs.push({
        id: tab.id,
        url: tab.url,
        title: tab.title || tab.url,
        loading: Boolean(tab.loading),
        hwnd: tab.hwnd,
        placed: Boolean(tab.adopted),
      });
    }
    return {
      ok: true,
      engine: "edge",
      mode: this.mode,
      owner: this.owner,
      port: this.port,
      profile: this.mode === "isolated" ? this.profile : "system:" + this.profileDirectory,
      activeId: this.activeId,
      visible: this.visible,
      tabs,
      error: this.lastError,
    };
  }

  async dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 先摘掉所有窗口：被 SetParent 过的子窗口不会随 Browser.close 一起消失
    // （父窗口还活着），所以必须逐个 detach + close。
    for (const tab of Array.from(this.tabs.values())) {
      await this.destroyTabWindow(tab).catch(() => undefined);
    }
    this.tabs.clear();
    this.activeId = null;

    // shared 模式跑在用户自己的 Edge 实例里，绝不能 Browser.close / 杀进程 ——
    // 那会把用户所有标签页一起关了。只关掉我们自己的窗口就走了。
    if (this.mode === "isolated") {
      if (this.cdp) {
        await this.cdp.send("Browser.close", {}, undefined, 4000).catch(() => undefined);
        this.cdp.close();
        this.cdp = null;
      }
      // 兜底：还有没关掉的（比如 helper 已经死了）就直接按进程命令行清掉本 profile 的浏览器。
      await closeStaleProfileBrowsers(this.profile, 0, this.processNames()).catch(() => undefined);
      clearState();
    } else if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    this.helper.stop();
  }
}

export const internals = {
  TITLEBAR,
  probeUrl,
  handoffUrl,
  normalizeUrl,
  freePort,
  profileOwners,
  closeStaleProfileBrowsers,
  browserCandidates,
  stateFile,
  readState,
  clearState,
};

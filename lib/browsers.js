/**
 * 浏览器配置表 —— 所有「是哪个浏览器」的知识都集中在这里。
 *
 * 为什么单独一个模块：内嵌窗口需要知道的浏览器细节有四样 ——
 *   1. 可执行文件在哪（决定能不能用）
 *   2. 进程名是什么（isolated 模式清理残留进程时按进程名筛）
 *   3. 用户数据目录在哪（读 Local State，找出用户上次用的是哪个 profile）
 *   4. 自绘标题条多高（app 窗口没有系统边框，标题条是浏览器自己画的）
 * 这些以前散在 embed.js / index.js 里各写一份、且写死了 Edge + `Default`。现在只有一份。
 *
 * 加一个新浏览器：往 BROWSERS 里加一项，然后**在真机上实测**（README「加一个浏览器」）。
 * 没实测过的条目把 `tested` 写成 false —— 它会一路报到界面上，用户能看见。
 *
 * 全部函数都是纯读：不启动进程、不写文件、不联网。所以测试可以直接用假目录跑。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readSettings } from "./settings.js";

/** Chromium 系 app 窗口自绘标题条高度（CSS px / 物理 px，96 DPI 下相同）。 */
export const DEFAULT_TITLEBAR = 30;

/** app 模式窗口的统一启动参数：别弹首次运行向导，别做遮挡节流。 */
export const BASE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

function env(key) {
  return process.env[key] || "";
}

function winPaths(company, product, fileName) {
  const pf = env("ProgramFiles") || "C:\\Program Files";
  const pf86 = env("ProgramFiles(x86)") || "C:\\Program Files (x86)";
  const local = env("LOCALAPPDATA") || join(homedir(), "AppData", "Local");
  return [
    join(pf86, company, product, "Application", fileName),
    join(pf, company, product, "Application", fileName),
    join(local, company, product, "Application", fileName),
  ];
}

function macApp(name) {
  return [`/Applications/${name}.app/Contents/MacOS/${name}`];
}

/**
 * 顺序 = 优先级（在「都没用过」时按这个顺序挑）。Edge 在前：Windows 自带，
 * 国内用户登录态大多在 Edge 里；Chrome 在后。要改优先级就改这个数组的顺序，
 * 不要改调用方。
 *
 * `tested: false` = 「代码支持，但没在真机上验证过」。这个标记会一路传到界面上，
 * 用户能看见自己用的是「已实测」还是「未实测」的浏览器 —— 不夸大。
 */
export const BROWSERS = [
  {
    id: "edge",
    name: "Microsoft Edge",
    /** 真机验证过：能嵌入、能登录 Google、标题条 30px、中文标题正常。 */
    tested: true,
    processNames: ["msedge.exe"],
    exe: {
      win32: winPaths("Microsoft", "Edge", "msedge.exe"),
      darwin: macApp("Microsoft Edge"),
      linux: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    },
    userDataDir: {
      win32: () => join(env("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "Microsoft", "Edge", "User Data"),
      darwin: () => join(homedir(), "Library", "Application Support", "Microsoft Edge"),
      linux: () => join(homedir(), ".config", "microsoft-edge"),
    },
  },
  {
    id: "chrome",
    name: "Google Chrome",
    /** 与 Edge 同为 Chromium，参数完全相同，但**没在真机上跑过** —— 如实标注。 */
    tested: false,
    processNames: ["chrome.exe"],
    exe: {
      win32: winPaths("Google", "Chrome", "chrome.exe"),
      darwin: macApp("Google Chrome"),
      linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
    },
    userDataDir: {
      win32: () => join(env("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data"),
      darwin: () => join(homedir(), "Library", "Application Support", "Google", "Chrome"),
      linux: () => join(homedir(), ".config", "google-chrome"),
    },
  },
  {
    id: "brave",
    name: "Brave",
    tested: false,
    processNames: ["brave.exe"],
    exe: {
      win32: [
        ...winPaths("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(env("ProgramFiles") || "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ],
      darwin: macApp("Brave Browser"),
      linux: ["/usr/bin/brave-browser", "/usr/bin/brave"],
    },
    userDataDir: {
      win32: () =>
        join(env("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "BraveSoftware", "Brave-Browser", "User Data"),
      darwin: () => join(homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
      linux: () => join(homedir(), ".config", "BraveSoftware", "Brave-Browser"),
    },
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    tested: false,
    processNames: ["vivaldi.exe"],
    exe: {
      // Vivaldi 的安装布局是 <base>\Vivaldi\Application\vivaldi.exe（只有一层产品目录）
      win32: [
        join(env("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "Vivaldi", "Application", "vivaldi.exe"),
        join(env("ProgramFiles") || "C:\\Program Files", "Vivaldi", "Application", "vivaldi.exe"),
        join(env("ProgramFiles(x86)") || "C:\\Program Files (x86)", "Vivaldi", "Application", "vivaldi.exe"),
      ],
      darwin: macApp("Vivaldi"),
      linux: ["/usr/bin/vivaldi", "/usr/bin/vivaldi-stable"],
    },
    userDataDir: {
      win32: () => join(env("LOCALAPPDATA") || join(homedir(), "AppData", "Local"), "Vivaldi", "User Data"),
      darwin: () => join(homedir(), "Library", "Application Support", "Vivaldi"),
      linux: () => join(homedir(), ".config", "vivaldi"),
    },
  },
];

/* ------------------------------------------------------------ 基础查询 */

function exeList(entry) {
  const table = entry.exe || {};
  const list = table[process.platform] || [];
  return list.filter(Boolean);
}

/** 该浏览器的用户数据目录（读 Local State 用，不是启动参数）。 */
export function browserUserDataDir(entry) {
  if (!entry) return "";
  const table = entry.userDataDir || {};
  const getter = table[process.platform];
  if (!getter) return "";
  try {
    return typeof getter === "function" ? getter() : String(getter);
  } catch {
    return "";
  }
}

/** 该浏览器所有候选可执行文件路径（含不存在的），用于报错时说清楚找了哪。 */
export function browserExeCandidates(entry) {
  return entry ? exeList(entry) : [];
}

function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 无权限访问的路径跳过 */
    }
  }
  return "";
}

/**
 * 读浏览器的 `Local State`，拿到「用户上次用的是哪个 profile」。
 *
 * 为什么要读：shared 模式必须传 `--profile-directory`（否则多 profile 的机器会弹
 * profile 选择器，体验很怪）。以前写死 `Default` —— 但很多人的主 profile 是
 * `Profile 1` / `Profile 2`，写死 Default 等于打开一个空壳配置，登录态全没有。
 * 读 `profile.last_used` 才是「用户自己那个」。
 *
 * 全字段都可能是脏的（文件在浏览器运行时正在被写），所以每一步都 try。
 */
export function readLocalState(entry) {
  const empty = { lastUsed: "", profiles: [], order: [] };
  const dir = browserUserDataDir(entry);
  if (!dir) return empty;
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, "Local State"), "utf8"));
  } catch {
    return empty;
  }
  const profile = (raw && raw.profile) || {};
  const infoCache = profile.info_cache || {};
  const profiles = [];
  for (const key of Object.keys(infoCache)) {
    const item = infoCache[key] || {};
    profiles.push({
      dir: key,
      name: String(item.name || key),
      /** 有 gaia 说明这个 profile 登过 Google 账号（只记「有没有」，不记是谁）。 */
      hasGoogleAccount: Boolean(item.gaia),
    });
  }
  return {
    lastUsed: typeof profile.last_used === "string" ? profile.last_used : "",
    profiles,
    order: Array.isArray(profile.profiles_order) ? profile.profiles_order.slice() : [],
  };
}

/** `Local State` 的修改时间 —— 用来判断「哪个浏览器最可能是用户正在用的」。 */
export function readLastUsedAt(entry) {
  const dir = browserUserDataDir(entry);
  if (!dir) return 0;
  try {
    return statSync(join(dir, "Local State")).mtimeMs || 0;
  } catch {
    return 0;
  }
}

/** 把一条配置变成可直接用的浏览器对象（补上真实 exe、profile 信息）。 */
export function materialize(entry) {
  if (!entry) return null;
  const exe = firstExisting(exeList(entry));
  const localState = readLocalState(entry);
  const profileDirectory =
    localState.lastUsed || localState.order[0] || localState.profiles[0]?.dir || "Default";
  const profileName =
    localState.profiles.find((item) => item.dir === profileDirectory)?.name || profileDirectory;
  return {
    id: entry.id,
    name: entry.name,
    tested: entry.tested !== false,
    exe,
    processNames: (entry.processNames || []).slice(),
    userDataDir: browserUserDataDir(entry),
    profileDirectory,
    profileName,
    profiles: localState.profiles,
    lastUsedAt: readLastUsedAt(entry),
    titlebar: DEFAULT_TITLEBAR,
  };
}

/** 所有「这台机器上真的装了」的浏览器，按配置表顺序。 */
export function installedBrowsers() {
  const out = [];
  for (const entry of BROWSERS) {
    const browser = materialize(entry);
    if (browser && browser.exe) out.push(browser);
  }
  return out;
}

/**
 * 全部浏览器（**不管装没装**）—— 给界面上的选择器用。
 *
 * 没装的那些也要列出来：用户才知道「这个插件认识哪些浏览器、我缺哪个」，
 * 而不是只看到一个孤零零的当前项。`installed` 字段说明这一条能不能选。
 */
export function discoverBrowsers() {
  return BROWSERS.map((entry) => {
    const browser = materialize(entry);
    return {
      id: entry.id,
      name: entry.name,
      tested: entry.tested !== false,
      installed: Boolean(browser && browser.exe),
      exe: (browser && browser.exe) || "",
      profileDirectory: (browser && browser.profileDirectory) || "",
      profileName: (browser && browser.profileName) || "",
      profiles: (browser && browser.profiles) || [],
      candidates: exeList(entry),
    };
  });
}

export function browserById(id) {
  const entry = BROWSERS.find((item) => item.id === id);
  return entry ? materialize(entry) : null;
}

/**
 * 挑一个浏览器。
 *
 * 优先级：
 *   0. `options.settings` 或 `~/.dsh/web-tabs/settings.json` 里用户自己选的
 *      `browserId`（插件界面上的选择器写进去的）—— 用户明确说了算。
 *   1. `DSH_WEB_TABS_BROWSER` —— 环境变量显式指定（id 如 `edge`，或可执行文件绝对路径）。
 *   2. 已装的里面「Local State 最近被改过」的那个 —— 那就是用户日常在用的浏览器，
 *      登录态最可能在那儿。这是唯一一处不按配置表顺序走的地方。
 *   3. 已装的里面按配置表顺序第一个。
 *
 * 返回 `{ browser, source }`；一个都没有时 `browser` 是 null，`source` 说明原因。
 */
export function pickBrowser(options) {
  const settings = options || {};
  const explicit = String(
    settings.explicit || process.env.DSH_WEB_TABS_BROWSER || "",
  ).trim();

  if (explicit) {
    // 允许直接给路径：按进程名反查配置，查不到就当成自定义浏览器（只用来起窗口）。
    if (/[\\/]/.test(explicit) || /\.exe$/i.test(explicit)) {
      try {
        if (existsSync(explicit)) {
          const file = basename(explicit);
          const known = BROWSERS.find((item) =>
            (item.processNames || []).some((name) => name.toLowerCase() === file.toLowerCase()),
          );
          if (known) {
            const browser = materialize(known);
            return { browser: { ...browser, exe: explicit }, source: "explicit-path" };
          }
          return {
            browser: {
              id: "custom",
              name: file,
              tested: false,
              exe: explicit,
              processNames: [file],
              userDataDir: "",
              profileDirectory: "",
              profileName: "",
              profiles: [],
              lastUsedAt: 0,
              titlebar: DEFAULT_TITLEBAR,
            },
            source: "explicit-path",
          };
        }
      } catch {
        /* 落到下面的按 id 查 */
      }
    }
    const known = browserById(explicit);
    if (known && known.exe) return { browser: known, source: "explicit-id" };
  }

  // 用户在插件界面里选过（settings.json）。选过但那个浏览器已经不在了，就静默回落，
  // 并在 `source` 里说明 —— 界面会提示「你选的浏览器找不到了」。
  const saved = settings.settings || readSettings();
  const savedPath = String((saved && saved.browserPath) || "").trim();
  if (savedPath) {
    // 用户手填的可执行文件路径（配置表里没有的 Chromium 变体）。文件没了就落到下面按 id 挑。
    try {
      if (existsSync(savedPath)) {
        const file = basename(savedPath);
        const known = BROWSERS.find((item) =>
          (item.processNames || []).some((name) => name.toLowerCase() === file.toLowerCase()),
        );
        const base = known ? materialize(known) : null;
        return {
          browser: base
            ? { ...base, exe: savedPath }
            : {
                id: "custom",
                name: file.replace(/\.exe$/i, ""),
                tested: false,
                exe: savedPath,
                processNames: [file],
                userDataDir: "",
                profileDirectory: "",
                profileName: "",
                profiles: [],
                lastUsedAt: 0,
                titlebar: DEFAULT_TITLEBAR,
              },
          source: "user-path",
        };
      }
    } catch {
      /* 路径不可读就当没设置 */
    }
  }
  const savedId = String((saved && saved.browserId) || "").trim();
  if (savedId) {
    const chosen = browserById(savedId);
    if (chosen && chosen.exe) {
      const profile = String((saved && saved.profile) || "").trim();
      return {
        browser: profile ? { ...chosen, profileDirectory: profile } : chosen,
        source: "user-choice",
      };
    }
  }

  const installed = installedBrowsers();
  if (!installed.length) {
    return {
      browser: null,
      source: "none",
      checked: BROWSERS.flatMap((entry) =>
        exeList(entry).map((path) => ({ browser: entry.id, path })),
      ),
    };
  }
  const byRecency = installed
    .slice()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  if (byRecency[0].lastUsedAt > 0) {
    return { browser: byRecency[0], source: "last-used" };
  }
  return { browser: installed[0], source: "order" };
}

/** 给用户看的一句话：「Microsoft Edge（用户配置 1）」。 */
export function describeBrowser(browser) {
  if (!browser) return "";
  if (browser.profileName && browser.profileName !== browser.profileDirectory) {
    return `${browser.name}（${browser.profileName}）`;
  }
  return browser.name;
}

/** 没找到浏览器时给用户看的完整原因：找了哪些路径。 */
export function missingBrowserDetail(checked) {
  const list = Array.isArray(checked) ? checked : [];
  const head = "没找到受支持的 Chromium 浏览器（Microsoft Edge / Google Chrome / Brave / Vivaldi）";
  if (!list.length) return head + "。";
  return (
    head +
    "。找过这些位置：" +
    list.map((item) => item.path).join("；") +
    "。装了别的 Chromium 浏览器（Chromium / Arc / 便携版等），可以在「＋」右边的齿轮里填它的可执行文件路径，或设环境变量 DSH_WEB_TABS_BROWSER。"
  );
}

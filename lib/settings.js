/**
 * 用户偏好设置 —— 只存三样东西：用哪个浏览器、用它的哪个 profile、标题条多高。
 *
 * 为什么不放 localStorage：host 半侧（起浏览器窗口的那一半）也要读这几个值，
 * 而 localStorage 只在渲染进程里。落在 `~/.dsh/web-tabs/settings.json`，
 * 两边都能读，重启 DSH NEXT 也还在。
 *
 * 读取永远不抛：文件不存在 / JSON 坏了 / 磁盘没权限，都当成「没设置过」，
 * 回落到自动挑选。设置是锦上添花，绝不该让插件起不来。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function dataDir() {
  return process.env.DSH_DATA_DIR || join(homedir(), ".dsh");
}

export function settingsFile() {
  return join(dataDir(), "web-tabs", "settings.json");
}

const EMPTY = { browserId: "", profile: "", titlebar: 0, browserPath: "" };

/** 读设置。返回的对象永远有全部字段（缺的就是空串 / 0）。 */
export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (!raw || typeof raw !== "object") return { ...EMPTY };
    return {
      browserId: typeof raw.browserId === "string" ? raw.browserId : "",
      profile: typeof raw.profile === "string" ? raw.profile : "",
      titlebar: Number(raw.titlebar) > 0 ? Number(raw.titlebar) : 0,
      // 手动指定的浏览器可执行文件（配置表里没有的 Chromium 变体走这里）。
      browserPath: typeof raw.browserPath === "string" ? raw.browserPath : "",
    };
  } catch {
    return { ...EMPTY };
  }
}

/** 合并写入（只覆盖传进来的字段）。写完回读一遍，返回真实落盘的内容。 */
export function writeSettings(patch) {
  const current = readSettings();
  const next = { ...current };
  if (patch && typeof patch === "object") {
    if (typeof patch.browserId === "string") next.browserId = patch.browserId.trim();
    if (typeof patch.profile === "string") next.profile = patch.profile.trim();
    if (typeof patch.browserPath === "string") next.browserPath = patch.browserPath.trim();
    if (patch.titlebar !== undefined) {
      const value = Number(patch.titlebar);
      next.titlebar = value > 0 ? value : 0;
    }
  }
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* 写不进去就当没设过；不要因为偏好写失败影响功能 */
  }
  return next;
}

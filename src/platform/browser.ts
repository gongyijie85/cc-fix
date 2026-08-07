// 浏览器策略（Chrome/Edge HKCU）— 读 / 写 / 快照 / 还原（ADR-0003）

import { execSync } from "node:child_process";

export type BrowserId = "chrome" | "edge";

export const BROWSER_LABELS: Record<BrowserId, string> = {
  chrome: "Chrome",
  edge: "Edge",
};

export const BROWSER_POLICY_PATHS: Record<BrowserId, string> = {
  chrome: "HKCU\\Software\\Policies\\Google\\Chrome",
  edge: "HKCU\\Software\\Policies\\Microsoft\\Edge",
};

export const ACCEPT_LANGUAGE_NAME = "AcceptLanguage";
export const WEBRTC_POLICY_NAME = "DefaultWebRtcIPHandlingPolicy";
/** 强制 Chrome/Edge UI 与 navigator 语言相关的应用区域（对标 check-cc 的 navigator.languages 根因） */
export const APPLICATION_LOCALE_NAME = "ApplicationLocaleValue";
/** WebRTC 防泄漏规范值（Chromium 官方策略枚举） */
export const WEBRTC_POLICY_VALUE = "disable_non_proxied_udp";

/** 策略槽位 = 浏览器 × 策略名 */
export interface PolicySlot {
  browser: BrowserId;
  name: string;
}

export const POLICY_SLOTS: PolicySlot[] = [
  { browser: "chrome", name: ACCEPT_LANGUAGE_NAME },
  { browser: "chrome", name: WEBRTC_POLICY_NAME },
  { browser: "chrome", name: APPLICATION_LOCALE_NAME },
  { browser: "edge", name: ACCEPT_LANGUAGE_NAME },
  { browser: "edge", name: WEBRTC_POLICY_NAME },
  { browser: "edge", name: APPLICATION_LOCALE_NAME },
];

/** 策略快照：槽位 → 原值，null 表示"不存在"（还原时删除） */
export type BrowserPolicySnapshot = Record<string, string | null>;

export function slotKey(slot: PolicySlot): string {
  return `${slot.browser}/${slot.name}`;
}

// en_US.UTF-8 → en-US（浏览器 Accept-Language / ApplicationLocale 标签）
export function acceptLanguageFromLang(lang: string): string {
  const base = lang.split(".")[0]!;
  return base.replace("_", "-");
}

/** HTTP Accept-Language 值：en-US → en-US,en（贴近真实浏览器列表形态） */
export function acceptLanguageHeaderFromLang(lang: string): string {
  const tag = acceptLanguageFromLang(lang);
  const primary = tag.split("-")[0]!;
  return primary === tag ? tag : `${tag},${primary}`;
}

/** persist on 写入的规范值，键为槽位键 */
export function targetPolicies(targetLang: string): Record<string, string> {
  const accept = acceptLanguageHeaderFromLang(targetLang);
  const appLocale = acceptLanguageFromLang(targetLang);
  const result: Record<string, string> = {};
  for (const slot of POLICY_SLOTS) {
    if (slot.name === ACCEPT_LANGUAGE_NAME) {
      result[slotKey(slot)] = accept;
    } else if (slot.name === APPLICATION_LOCALE_NAME) {
      result[slotKey(slot)] = appLocale;
    } else {
      result[slotKey(slot)] = WEBRTC_POLICY_VALUE;
    }
  }
  return result;
}

export function getPolicy(browser: BrowserId, name: string): string | null {
  try {
    const result = execSync(
      `reg query "${BROWSER_POLICY_PATHS[browser]}" /v ${name}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const match = result.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    // 策略区或值不存在
    return null;
  }
}

export function setPolicy(browser: BrowserId, name: string, value: string): void {
  execSync(
    `reg add "${BROWSER_POLICY_PATHS[browser]}" /v ${name} /t REG_SZ /d "${value}" /f`,
    { stdio: "pipe" },
  );
}

export function deletePolicy(browser: BrowserId, name: string): void {
  try {
    execSync(
      `reg delete "${BROWSER_POLICY_PATHS[browser]}" /v ${name} /f`,
      { stdio: "pipe" },
    );
  } catch {
    // 值可能不存在，忽略
  }
}

export function snapshotPolicies(): BrowserPolicySnapshot {
  const snapshot: BrowserPolicySnapshot = {};
  for (const slot of POLICY_SLOTS) {
    snapshot[slotKey(slot)] = getPolicy(slot.browser, slot.name);
  }
  return snapshot;
}

/** 按快照还原：null → 删除；失败时抛出，携带槽位信息 */
export function restorePolicies(snapshot: BrowserPolicySnapshot): void {
  for (const slot of POLICY_SLOTS) {
    const key = slotKey(slot);
    if (!(key in snapshot)) continue;
    const original = snapshot[key];
    if (original === null) {
      deletePolicy(slot.browser, slot.name);
    } else {
      setPolicy(slot.browser, slot.name, original);
    }
  }
}

// 进程名 → 浏览器（tasklist 的 IMAGENAME）
const PROCESS_IMAGES: Record<string, BrowserId> = {
  "chrome.exe": "chrome",
  "msedge.exe": "edge",
};

/** 探测正在运行的浏览器；单个浏览器探测失败降级跳过（不阻断调用方） */
// 注意：tasklist 的多个 /FI 过滤器按 AND 连接，IMAGENAME 不可能同时等于两个值（恒假），
// 必须按进程名逐个查询后合并结果（E2E-17 实测：组合查询即使 chrome.exe 运行中也返回空）
export function detectRunningBrowsers(): BrowserId[] {
  const running = new Set<BrowserId>();
  for (const [image, browser] of Object.entries(PROCESS_IMAGES)) {
    try {
      const output = execSync(
        `tasklist /NH /FI "IMAGENAME eq ${image}"`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
      );
      const hit = output
        .split("\n")
        .some(line => line.trim().split(/\s+/)[0]?.toLowerCase() === image);
      if (hit) running.add(browser);
    } catch {
      // 单个浏览器探测失败不影响其它结果
    }
  }
  return [...running];
}

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
  { browser: "edge", name: ACCEPT_LANGUAGE_NAME },
  { browser: "edge", name: WEBRTC_POLICY_NAME },
];

/** 策略快照：槽位 → 原值，null 表示"不存在"（还原时删除） */
export type BrowserPolicySnapshot = Record<string, string | null>;

export function slotKey(slot: PolicySlot): string {
  return `${slot.browser}/${slot.name}`;
}

// en_US.UTF-8 → en-US（浏览器 Accept-Language 格式）
export function acceptLanguageFromLang(lang: string): string {
  const base = lang.split(".")[0];
  return base.replace("_", "-");
}

/** persist on 写入的规范值，键为槽位键 */
export function targetPolicies(targetLang: string): Record<string, string> {
  const accept = acceptLanguageFromLang(targetLang);
  const result: Record<string, string> = {};
  for (const slot of POLICY_SLOTS) {
    result[slotKey(slot)] =
      slot.name === ACCEPT_LANGUAGE_NAME ? accept : WEBRTC_POLICY_VALUE;
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

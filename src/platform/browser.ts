// 浏览器策略（Chrome/Edge HKCU）检测侧 I/O — 槽事实全部派生自 state/schema.ts 槽目录（ADR-0011）
// 规范词汇：槽 id（chrome.accept_language …）；slotKey 词汇已随旧修复流退役。

import { execSync } from "node:child_process";
import { BROWSER_POLICY_SLOTS, type BrowserId, type BrowserPolicySlotId } from "../state/schema.js";

export type { BrowserId } from "../state/schema.js";

export const BROWSER_LABELS: Record<BrowserId, string> = {
  chrome: "Chrome",
  edge: "Edge",
};

// 进程名 → 浏览器（tasklist 的 IMAGENAME）
const PROCESS_IMAGES: Record<string, BrowserId> = {
  "chrome.exe": "chrome",
  "msedge.exe": "edge",
};

/** 探测正在运行的浏览器；单个浏览器探测失败降级跳过（不阻断调用方）。
 * 注意：tasklist 的多个 /FI 过滤器按 AND 连接，IMAGENAME 不可能同时等于两个值（恒假），
 * 必须按进程名逐个查询后合并结果（E2E-17 实测：组合查询即使 chrome.exe 运行中也返回空）。 */
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

/** 按槽 id 读 HKCU 策略值；键或值不存在返回 null。槽 id 必须来自目录。 */
export function getPolicy(slot: BrowserPolicySlotId): string | null {
  const entry = BROWSER_POLICY_SLOTS.find((candidate) => candidate.id === slot);
  if (entry === undefined) throw new Error(`Unmanaged browser policy slot: ${slot}`);
  try {
    const result = execSync(
      `reg query "${entry.keyPath}" /v ${entry.valueName}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const match = result.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    // 策略区或值不存在
    return null;
  }
}
